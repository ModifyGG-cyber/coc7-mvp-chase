/**
 * Runs an MvP chase in the world: keeps the state in a world setting, rolls through the CoC7 system,
 * spends Luck, rolls 1D6 losses and posts what happened to chat. The tracker window and the
 * coc7/chase-* commands both go through here, so they always agree.
 */

import type {
  Coc7ChaseActorRef,
  Coc7ChaseCheckRef,
  Coc7ChaseTurnResult,
  Coc7ChaseView,
  Coc7Difficulty
} from './types';
import { DIFFICULTY_CODE, resolveD100, successLevel, meetsDifficulty } from './d100';
import { checkCardSummary, getCoc7Globals, resolveActor as resolveActorTarget, rollSystemCheck, type Coc7Actor, type Coc7ChatMessage } from './coc7';
import {
  addParticipant,
  beginPush,
  challengeFor,
  checkLabel,
  createChase,
  currentParticipant,
  findParticipant,
  getParticipant,
  locationLabel,
  luckSuccess,
  recordRoll,
  requireCurrent,
  resetChase,
  startingMvp,
  setLocation,
  startChase,
  takeLoss,
  targetFor,
  tierValue,
  type ChaseCheck,
  type ChaseParticipant,
  type ChaseSide,
  type ChaseState
} from './chaseState';

export const CHASE_MODULE_ID = 'coc7-mvp-chase';
export const CHASE_SETTING = 'chase';

const CHARACTERISTICS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'];
const DIFFICULTIES: Coc7Difficulty[] = ['regular', 'hard', 'extreme', 'critical'];

interface ChaseGlobals {
  game: {
    settings: { get(module: string, key: string): unknown; set(module: string, key: string, value: unknown): Promise<unknown> };
    user?: { isGM?: boolean } | null;
    system?: { id?: string };
  };
  foundry?: { utils?: { randomID?(): string } };
}

function globals(): ChaseGlobals {
  return globalThis as unknown as ChaseGlobals;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function loadChase(): ChaseState | null {
  try {
    const raw = globals().game.settings.get(CHASE_MODULE_ID, CHASE_SETTING) as { version?: unknown } | null | undefined;
    return raw && typeof raw === 'object' && raw.version === 1 ? clone(raw as ChaseState) : null;
  } catch {
    return null;
  }
}

async function saveChase(state: ChaseState | null): Promise<void> {
  await globals().game.settings.set(CHASE_MODULE_ID, CHASE_SETTING, state);
}

function requireCoc7(): void {
  const id = globals().game.system?.id;
  if (id !== 'CoC7') throw new Error(`MvP chases need the Call of Cthulhu 7e system (this world runs ${id ?? 'unknown'}).`);
}

function requireGM(): void {
  if (!globals().game.user?.isGM) throw new Error('Only the Keeper can run the chase.');
}

function requireChase(): ChaseState {
  const state = loadChase();
  if (!state) throw new Error('No chase is running. Start one first.');
  return state;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
};

function newId(): string {
  return globals().foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
}

// ---------- reading actors ----------

interface ActorLike extends Coc7Actor {
  img?: string;
  hasPlayerOwner?: boolean;
  testUserPermission?(user: unknown, level: string): boolean;
  weaponCheck?(weapon: { id: string }, fastForward?: boolean): Promise<unknown>;
  system: Coc7Actor['system'] & { attribs?: Record<string, { value?: number | null; max?: number | null }> };
}

function resolveActor(ref: Coc7ChaseActorRef): { actor: ActorLike; tokenId?: string; sceneId?: string } {
  const { game } = getCoc7Globals();
  const resolved = resolveActorTarget(ref);
  const sceneId = ref.tokenId ? (ref.sceneId ?? game.scenes.active?.id) : undefined;
  return {
    actor: resolved.actor,
    ...(resolved.tokenId ? { tokenId: resolved.tokenId } : {}),
    ...(sceneId ? { sceneId } : {})
  };
}

function participantInput(ref: Coc7ChaseActorRef, side: ChaseSide): Parameters<typeof addParticipant>[1] {
  const { actor, tokenId, sceneId } = resolveActor(ref);
  const mov = ref.mov ?? num(actor.system.attribs?.['mov']?.value);
  const majorWound = actor.statuses?.has('criticalWounds') ?? false;
  return {
    id: tokenId ?? actor.id,
    name: actor.name,
    actorId: actor.id,
    actorUuid: actor.uuid,
    ...(tokenId ? { tokenId } : {}),
    ...(sceneId ? { sceneId } : {}),
    ...(actor.img ? { img: actor.img } : {}),
    side,
    dex: num(actor.system.characteristics?.['dex']?.value),
    mov,
    majorWound,
    ...(ref.skillTier ? { skillTier: ref.skillTier } : {})
  };
}

function actorOf(p: ChaseParticipant): ActorLike {
  return resolveActor(p.tokenId ? { tokenId: p.tokenId, ...(p.sceneId ? { sceneId: p.sceneId } : {}) } : { actorId: p.actorId }).actor;
}


export function checkFromRef(ref: Coc7ChaseCheckRef): ChaseCheck {
  const kind = ref.kind as string;
  const name = (ref.name as string | undefined)?.trim() ?? '';
  if (!name) throw new Error('A challenge needs a name, e.g. Athletics or dex');
  if (kind === 'characteristic') {
    if (!CHARACTERISTICS.includes(name.toLowerCase())) throw new Error(`characteristic must be one of ${CHARACTERISTICS.join(', ')}`);
    return { kind: 'characteristic', name: name.toLowerCase() };
  }
  if (kind === 'attribute') {
    if (name.toLowerCase() !== 'lck') throw new Error('The only attribute a chase challenge can use is lck (Luck).');
    return { kind: 'attribute', name: 'lck' };
  }
  if (kind !== 'skill') throw new Error('check kind must be skill, characteristic or attribute');
  return { kind: 'skill', name };
}

function checkDifficulty(value: unknown): Coc7Difficulty | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!DIFFICULTIES.includes(value as Coc7Difficulty)) throw new Error(`difficulty must be one of ${DIFFICULTIES.join(', ')}`);
  return value as Coc7Difficulty;
}

function hasSkill(actor: ActorLike, name: string): boolean {
  const wanted = name.toLocaleLowerCase();
  const skills = actor.items.filter(i => i.type === 'skill');
  return skills.some(s => s.name.toLocaleLowerCase() === wanted) || skills.filter(s => s.name.toLocaleLowerCase().includes(wanted)).length === 1;
}

/** The number a check is rolled against, before difficulty. */
function rawValue(actor: ActorLike, check: ChaseCheck, p: ChaseParticipant): number {
  if (check.kind === 'characteristic') return num(actor.system.characteristics?.[check.name]?.value);
  if (check.kind === 'attribute') return num(actor.system.attribs?.[check.name]?.value);
  const wanted = check.name.toLocaleLowerCase();
  const skills = actor.items.filter(i => i.type === 'skill');
  const skill = skills.find(s => s.name.toLocaleLowerCase() === wanted) ?? skills.filter(s => s.name.toLocaleLowerCase().includes(wanted))[0];
  return skill ? num(skill.system.value) : tierValue(num(actor.system.characteristics?.['dex']?.value), p.skillTier);
}

/** "Athletics 60% · Hard 30% · 1 penalty die", for the roll request card. */
function valueText(actor: ActorLike, challenge: { check: ChaseCheck; difficulty: Coc7Difficulty; bonusDice: number }, p: ChaseParticipant): string {
  const { check, difficulty, bonusDice } = challenge;
  const raw = rawValue(actor, check, p);
  const name = check.kind === 'attribute' ? 'Luck' : check.kind === 'characteristic' ? check.name.toUpperCase() : check.name;
  const missing = check.kind === 'skill' && !hasSkill(actor, check.name) ? ` (no ${check.name} skill: ${p.skillTier} DEX)` : '';
  const parts = [`${name} ${String(raw)}%${missing}`];
  if (difficulty !== 'regular') parts.push(`${difficulty[0]?.toUpperCase() ?? ''}${difficulty.slice(1)} ${String(targetFor(raw, difficulty))}%`);
  if (bonusDice) parts.push(`${String(Math.abs(bonusDice))} ${bonusDice > 0 ? 'bonus' : 'penalty'} ${Math.abs(bonusDice) === 1 ? 'die' : 'dice'}`);
  return parts.join(' · ');
}

// ---------- chat ----------

async function post(state: ChaseState, html: string, options: { whisperGM?: boolean; flags?: Record<string, unknown> } = {}): Promise<void> {
  const { ChatMessage } = getCoc7Globals();
  const whisper = options.whisperGM ? ChatMessage.getWhisperRecipients?.('GM').map(u => u.id) : undefined;
  await ChatMessage.create({
    content: `<div class="mvpc-chase-card"><h4>🏃 ${escapeHtml(state.name)}</h4>${html}</div>`,
    speaker: { alias: 'Chase' },
    ...(whisper?.length ? { whisper } : {}),
    ...(options.flags ? { flags: { [CHASE_MODULE_ID]: options.flags } } : {})
  });
}

/**
 * Rolls the 1D6 MvP loss and posts it as a plain chase card. The roll is not attached to the message,
 * so nothing offers to apply it as damage or healing. Dice So Nice still shows the die when it's on.
 */
export async function rollMvpLoss(name: string, chaseName: string): Promise<number> {
  const { Roll, ChatMessage } = getCoc7Globals();
  const roll = await new Roll('1d6').evaluate();
  const dice3d = (globalThis as { game?: { dice3d?: { showForRoll(roll: unknown, user?: unknown, sync?: boolean): Promise<unknown> } }; }).game?.dice3d;
  try {
    await dice3d?.showForRoll(roll, (globalThis as { game?: { user?: unknown } }).game?.user, true);
  } catch {
    // the animation is optional
  }
  await ChatMessage.create({
    content: `<div class="mvpc-chase-card"><h4>🏃 ${escapeHtml(chaseName)}</h4><p><b>${escapeHtml(name)}</b> rolls 1D6 MvP loss: <b>${String(roll.total)}</b></p></div>`,
    speaker: { alias: 'Chase' }
  });
  return roll.total;
}

// ---------- players roll their own ----------

export function promptsPlayers(state: ChaseState): boolean {
  return state.promptPlayers !== false;
}

/** True when a player owns this character, so the player rolls and chooses for it. */
export function isPlayerControlled(p: ChaseParticipant): boolean {
  try {
    return actorOf(p).hasPlayerOwner === true;
  } catch {
    return false;
  }
}

function playerRolls(state: ChaseState, p: ChaseParticipant): boolean {
  return promptsPlayers(state) && isPlayerControlled(p);
}

/** Posts a roll button for the character's player; their CoC7 check card resolves the turn. */
async function requestRoll(
  state: ChaseState,
  p: ChaseParticipant,
  challenge: { check: ChaseCheck; difficulty: Coc7Difficulty; bonusDice: number },
  pushed: boolean
): Promise<void> {
  state.awaiting = { participantId: p.id, check: challenge.check, difficulty: challenge.difficulty, bonusDice: challenge.bonusDice, pushed };
  await saveChase(state);
  const label = checkLabel(challenge.check, challenge.difficulty);
  const what = pushed ? `Pushed ${escapeHtml(label)} roll` : `${escapeHtml(label)} check`;
  const where = `Location ${String(p.location)}${locationLabel(state, p.location) !== `Location ${String(p.location)}` ? ` (${escapeHtml(locationLabel(state, p.location))})` : ''}`;
  let value = '';
  try {
    value = `<p>${escapeHtml(valueText(actorOf(p), challenge, p))}</p>`;
  } catch {
    // the value is a courtesy; the roll still works without it
  }
  await post(
    state,
    `<p>${what} for <b>${escapeHtml(p.name)}</b> at ${where}${pushed ? '. Failing a pushed roll means out of the chase' : ''}:</p>${value}<p>${rollLink(p, challenge.check, challenge.difficulty, challenge.bonusDice)}</p>`
  );
}

/** When the next character belongs to a player, asks that player to roll. */
async function autoPrompt(state: ChaseState): Promise<void> {
  if (!promptsPlayers(state) || state.outcome || state.pending || state.awaiting || state.round === 0) return;
  const p = currentParticipant(state);
  if (!p || !isPlayerControlled(p)) return;
  const loc = state.locations.find(l => l.index === p.location);
  if (!loc?.check) return;
  try {
    await requestRoll(state, p, challengeFor(state, p), false);
  } catch (error) {
    console.warn('MvP Chase | Could not ask the player to roll:', error);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function standings(state: ChaseState): string {
  const rows = state.participants
    .map(p => {
      const status = p.status === 'active' ? `${String(p.mvp)} MvP` : p.status;
      return `<li><b>${escapeHtml(p.name)}</b> (${p.side}) · ${escapeHtml(locationLabel(state, p.location))} · ${status}</li>`;
    })
    .join('');
  return `<ul class="mvpc-chase-standings">${rows}</ul>`;
}

function nextUp(state: ChaseState): string {
  if (state.outcome) return `<p class="mvpc-chase-outcome"><b>${escapeHtml(state.outcome)}</b></p>`;
  const p = currentParticipant(state);
  if (!p) return '';
  const loc = state.locations.find(l => l.index === p.location);
  const challenge = loc?.check ? checkLabel(loc.check, loc.difficulty) : 'challenge not set yet';
  return `<p>Next: <b>${escapeHtml(p.name)}</b> in ${escapeHtml(locationLabel(state, p.location))}: ${escapeHtml(challenge)}.</p>`;
}

// ---------- views ----------

export function viewOf(state: ChaseState | null): Coc7ChaseView {
  if (!state) return { active: false };
  const current = currentParticipant(state);
  const name = (id: string): string => state.participants.find(p => p.id === id)?.name ?? id;
  let currentChallenge: string | null = null;
  if (current) {
    const loc = state.locations.find(l => l.index === current.location);
    currentChallenge = loc?.check ? `${checkLabel(loc.check, loc.difficulty)} at ${locationLabel(state, current.location)}` : `${locationLabel(state, current.location)} has no challenge yet`;
    if (current.nextPenaltyDice) currentChallenge += ` (${String(current.nextPenaltyDice)} penalty die)`;
  }
  return {
    active: !state.outcome,
    name: state.name,
    round: state.round,
    current: current?.name ?? null,
    currentChallenge,
    outcome: state.outcome,
    pending: state.pending
      ? {
          participant: name(state.pending.participantId),
          total: state.pending.total,
          target: state.pending.target,
          luckNeeded: state.pending.luckNeeded,
          canPush: state.pending.canPush
        }
      : null,
    awaiting: state.awaiting
      ? { participant: name(state.awaiting.participantId), challenge: checkLabel(state.awaiting.check, state.awaiting.difficulty) }
      : null,
    participants: state.participants.map(p => ({
      id: p.id,
      name: p.name,
      side: p.side,
      mvp: p.mvp,
      mov: p.mov,
      location: p.location,
      status: p.status,
      dex: p.dex,
      nextPenaltyDice: p.nextPenaltyDice
    })),
    locations: state.locations.map(l => ({ index: l.index, name: l.name, challenge: l.check ? checkLabel(l.check, l.difficulty) : null })),
    order: state.order.slice(state.turn).map(name),
    log: state.log.slice(-12)
  };
}

export function getChaseView(): Coc7ChaseView {
  return viewOf(loadChase());
}

// ---------- setup ----------

export async function startNewChase(input: {
  name?: string;
  firstLocation?: string;
  firstCheck?: Coc7ChaseCheckRef;
  quarry: Coc7ChaseActorRef[];
  pursuers: Coc7ChaseActorRef[];
  headStart?: boolean;
  hardFrom?: number;
  replace?: boolean;
  /** Set up only; the Keeper adds people and presses Start. */
  setupOnly?: boolean;
}): Promise<Coc7ChaseView> {
  requireCoc7();
  requireGM();
  const existing = loadChase();
  if (existing && !existing.outcome && !input.replace) {
    throw new Error(`"${existing.name}" is still running. End it first, or pass replace: true.`);
  }
  const hardFrom = input.hardFrom !== undefined && input.hardFrom > 0 ? Math.floor(input.hardFrom) : null;
  const state = createChase({
    id: newId(),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.firstLocation !== undefined ? { firstLocation: input.firstLocation } : {}),
    hardFrom
  });
  if (input.firstCheck) setLocation(state, 1, { check: checkFromRef(input.firstCheck) });
  for (const ref of input.quarry) addParticipant(state, participantInput(ref, 'quarry'));
  for (const ref of input.pursuers) addParticipant(state, participantInput(ref, 'pursuer'));
  if (!input.setupOnly) startChase(state, { headStart: input.headStart ?? false });
  await saveChase(state);
  if (!input.setupOnly) {
    await post(state, `<p>The chase begins in <b>${escapeHtml(locationLabel(state, 1))}</b>.${input.headStart ? ' The quarry has a head start: pursuers take a penalty die on their first challenge.' : ''}</p>${standings(state)}${nextUp(state)}`);
    await autoPrompt(state);
  }
  return viewOf(state);
}

export async function beginChase(headStart: boolean): Promise<Coc7ChaseView> {
  requireGM();
  const state = requireChase();
  startChase(state, { headStart });
  await saveChase(state);
  await post(state, `<p>The chase begins in <b>${escapeHtml(locationLabel(state, 1))}</b>.${headStart ? ' The quarry has a head start: pursuers take a penalty die on their first challenge.' : ''}</p>${standings(state)}${nextUp(state)}`);
  await autoPrompt(state);
  return viewOf(state);
}

export async function addToChase(ref: Coc7ChaseActorRef, side: ChaseSide): Promise<Coc7ChaseView> {
  requireCoc7();
  requireGM();
  const state = requireChase();
  const p = addParticipant(state, participantInput(ref, side));
  await saveChase(state);
  if (state.round > 0) await post(state, `<p><b>${escapeHtml(p.name)}</b> joins as ${side === 'quarry' ? 'quarry' : 'a pursuer'} with ${String(p.mvp)} MvP.</p>`);
  return viewOf(state);
}

export async function updateLocation(index: number, update: { name?: string; check?: Coc7ChaseCheckRef | null; difficulty?: Coc7Difficulty }): Promise<Coc7ChaseView> {
  requireGM();
  const state = requireChase();
  const difficulty = checkDifficulty(update.difficulty);
  setLocation(state, index, {
    ...(update.name !== undefined ? { name: update.name } : {}),
    ...(update.check !== undefined ? { check: update.check ? checkFromRef(update.check) : null } : {}),
    ...(difficulty ? { difficulty } : {})
  });
  // The challenge changed under a roll already asked for: ask again with the new one.
  const asked = state.awaiting;
  const changed = update.check !== undefined || difficulty !== undefined;
  if (changed && asked && !asked.pushed && state.participants.find(p => p.id === asked.participantId)?.location === index) state.awaiting = null;
  await saveChase(state);
  await autoPrompt(state);
  return viewOf(state);
}

/** Runs any state change and saves it, for the simple Keeper actions. */
export async function mutateChase(change: (state: ChaseState) => string | undefined): Promise<Coc7ChaseView> {
  requireGM();
  const state = requireChase();
  const before = state.outcome;
  const note = change(state);
  await saveChase(state);
  if (note) {
    const ended = state.outcome && !before ? standings(state) : '';
    await post(state, `<p>${escapeHtml(note)}</p>${ended}${nextUp(state)}`);
  }
  await autoPrompt(state);
  return viewOf(state);
}

/** Starts the same chase over: same people and locations, everyone back in Location 1 with full MvP. */
export async function restartChase(): Promise<Coc7ChaseView> {
  requireGM();
  const state = requireChase();
  resetChase(state, p => {
    try {
      const actor = actorOf(p);
      const mov = num(actor.system.attribs?.['mov']?.value) || p.mov;
      p.mov = mov;
      return startingMvp(mov, actor.statuses?.has('criticalWounds') ?? false);
    } catch {
      return p.mov;
    }
  });
  await saveChase(state);
  await post(state, `<p>The chase is reset. Everyone is back in <b>${escapeHtml(locationLabel(state, 1))}</b> with full MvP.</p>`);
  return viewOf(state);
}

export async function clearChase(): Promise<void> {
  requireGM();
  await saveChase(null);
}

// ---------- turns ----------

interface RollOutcome {
  total: number;
  target: number;
  passed: boolean;
  messageId?: string;
}

/** d100 against a number the system doesn't know (a monster without the skill), posted as a plain roll. */
async function rollAgainst(state: ChaseState, p: ChaseParticipant, value: number, difficulty: Coc7Difficulty, bonusDice: number, label: string): Promise<RollOutcome> {
  const { Roll } = getCoc7Globals();
  const d10 = async (): Promise<number> => (await new Roll('1d10').evaluate()).total;
  const unitDie = await d10();
  const baseDie = await d10();
  const extra: number[] = [];
  for (let i = 0; i < Math.abs(bonusDice); i++) extra.push(await d10());
  const { total } = resolveD100({ baseDie, unitDie, bonusDice: bonusDice > 0 ? extra : [], penaltyDice: bonusDice < 0 ? extra : [] }, bonusDice);
  const level = successLevel(total, value);
  const passed = meetsDifficulty(level, difficulty);
  const dice = bonusDice === 0 ? '' : ` with ${String(Math.abs(bonusDice))} ${bonusDice > 0 ? 'bonus' : 'penalty'} ${Math.abs(bonusDice) === 1 ? 'die' : 'dice'}`;
  await post(state, `<p><b>${escapeHtml(p.name)}</b> lacks the skill and rolls ${escapeHtml(label)} at ${String(value)}% (${p.skillTier} DEX)${dice}: <b>${String(total)}</b> — ${passed ? 'success' : 'failure'}.</p>`);
  return { total, target: targetFor(value, difficulty), passed };
}

async function rollCheck(state: ChaseState, p: ChaseParticipant, check: ChaseCheck, difficulty: Coc7Difficulty, bonusDice: number, blind: boolean): Promise<RollOutcome> {
  const actor = actorOf(p);
  if (check.kind === 'skill' && !hasSkill(actor, check.name)) {
    const dex = num(actor.system.characteristics?.['dex']?.value);
    return rollAgainst(state, p, tierValue(dex, p.skillTier), difficulty, bonusDice, checkLabel(check, difficulty));
  }
  const result = await rollSystemCheck(actor, check, difficulty, bonusDice, blind);
  return { total: result.total, target: targetFor(result.threshold, difficulty), passed: result.passed, messageId: result.messageId };
}

function rollLink(p: ChaseParticipant, check: ChaseCheck, difficulty: Coc7Difficulty, bonusDice: number): string {
  const options = [`subtype:${check.kind}`, `name:${check.name}`];
  if (difficulty !== 'regular') options.push(`difficulty:${DIFFICULTY_CODE[difficulty]}`);
  if (bonusDice !== 0) options.push(`poolModifier:${bonusDice > 0 ? '+' : ''}${String(bonusDice)}`);
  const label = `${checkLabel(check, difficulty)} (${p.name})`.replace(/[{}[\],]/g, '');
  return `@coc7.check[${options.join(',')}]{${label}}`;
}

async function announceRoll(state: ChaseState, p: ChaseParticipant, outcome: 'moved' | 'pending' | 'out', roll: RollOutcome, check: string): Promise<void> {
  if (outcome === 'moved') {
    await post(state, `<p><b>${escapeHtml(p.name)}</b> passes ${escapeHtml(check)} and moves on to ${escapeHtml(locationLabel(state, p.location))}. MvP stay at ${String(p.mvp)}.</p>${nextUp(state)}`);
  } else if (outcome === 'out') {
    await post(state, `<p><b>${escapeHtml(p.name)}</b> fails the pushed roll and is ${p.status === 'caught' ? '<b>caught</b>' : '<b>out of the chase</b>'}.</p>${standings(state)}${nextUp(state)}`);
  } else {
    const pending = state.pending;
    const luck = pending?.luckNeeded !== null && pending?.luckNeeded !== undefined ? ` Spend ${String(pending.luckNeeded)} Luck to pass,` : '';
    const push = pending?.canPush ? ' push the roll (failing it means out of the chase),' : '';
    if (pending && playerRolls(state, p)) {
      const buttons = [
        `<button type="button" data-mvpc-choice="take-loss"><i class="fa-solid fa-dice-six"></i> Roll 1D6 MvP loss</button>`,
        pending.luckNeeded !== null ? `<button type="button" data-mvpc-choice="luck"><i class="fa-solid fa-clover"></i> Spend ${String(pending.luckNeeded)} Luck</button>` : '',
        pending.canPush ? `<button type="button" data-mvpc-choice="push" title="Failing a pushed roll means out of the chase"><i class="fa-solid fa-hand-fist"></i> Push the roll</button>` : ''
      ].join('');
      await post(
        state,
        `<p><b>${escapeHtml(p.name)}</b> fails ${escapeHtml(check)} (${String(roll.total)} vs ${String(roll.target)}). Choose:</p><div class="mvpc-choices">${buttons}</div>`,
        { flags: { choice: { chaseId: state.id, participantId: p.id, actorUuid: p.actorUuid, total: pending.total } } }
      );
      return;
    }
    await post(state, `<p><b>${escapeHtml(p.name)}</b> fails ${escapeHtml(check)} (${String(roll.total)} vs ${String(roll.target)}).${luck}${push} or lose 1D6 MvP.</p>`);
  }
}

export interface TakeTurnInput {
  participant?: string;
  mode?: 'roll' | 'request' | 'pass' | 'fail';
  check?: Coc7ChaseCheckRef;
  difficulty?: Coc7Difficulty;
  bonusDice?: number;
  shooting?: boolean;
  /** With shooting: the ranged weapon (item id) to fire. Its attack card gets the penalty die too. */
  weaponId?: string;
  blind?: boolean;
  total?: number;
}

// ---------- the sheet: skills and weapons ----------

/** Every skill name on the chase's characters, for the challenge suggestions. */
export function participantSkillNames(state: ChaseState | null): string[] {
  const names = new Set<string>();
  for (const p of state?.participants ?? []) {
    try {
      for (const item of actorOf(p).items.filter(i => i.type === 'skill')) if (item.name.trim()) names.add(item.name.trim());
    } catch {
      // a character whose actor is gone just adds nothing
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

interface WeaponItem {
  id: string;
  name: string;
  type: string;
  system: { properties?: { rngd?: boolean } };
}

/** The character's ranged weapons, for the Shooting option. */
export function rangedWeapons(p: ChaseParticipant): { id: string; name: string }[] {
  try {
    const items = actorOf(p).items.filter(i => i.type === 'weapon') as unknown as WeaponItem[];
    return items.filter(i => i.system.properties?.rngd === true).map(i => ({ id: i.id, name: i.name }));
  } catch {
    return [];
  }
}

/**
 * Makes the CoC7 ranged attack with the weapon. Shooting while running gives the attack a penalty die
 * too, so the attack card is adjusted as it is created (each target's dice slider moves down one).
 */
async function fireWeapon(state: ChaseState, p: ChaseParticipant, weaponId: string): Promise<void> {
  const actor = actorOf(p);
  if (!actor.weaponCheck) throw new Error('This CoC7 version cannot make weapon attacks from a module.');
  const weapon = rangedWeapons(p).find(w => w.id === weaponId);
  if (!weapon) throw new Error(`${p.name} has no ranged weapon with that id.`);
  const { Hooks } = getCoc7Globals();
  let hookId = 0;
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  const done = (): void => {
    Hooks.off('preCreateChatMessage', hookId);
    if (timer.id) clearTimeout(timer.id);
  };
  hookId = Hooks.on('preCreateChatMessage', (...args: unknown[]) => {
    const message = args[0] as {
      flags?: { CoC7?: { load?: { as?: string; actorUuid?: string; targets?: { poolModifier?: number | string }[] } } };
      content?: string;
      updateSource?(data: Record<string, unknown>): void;
    };
    const load = message.flags?.CoC7?.load;
    if (load?.as !== 'CoC7ChatCombatRanged' || load.actorUuid !== p.actorUuid) return;
    done();
    const targets = (load.targets ?? []).map(t => ({ ...t, poolModifier: Math.max(-2, num(t.poolModifier) - 1) }));
    let i = 0;
    const content = (message.content ?? '').replace(/(data-set="poolModifier"[^>]*?value=")(-?\d+)(")/g, (_m, a: string, _v: string, c: string) => {
      const value = targets[i]?.poolModifier ?? 0;
      i++;
      return `${a}${String(value)}${c}`;
    });
    message.updateSource?.({ 'flags.CoC7.load.targets': targets, content });
  });
  timer.id = setTimeout(done, 60_000);
  try {
    await actor.weaponCheck({ id: weapon.id }, false);
  } catch (error) {
    done();
    throw error;
  }
  await post(state, `<p><b>${escapeHtml(p.name)}</b> shoots ${escapeHtml(weapon.name)} while running: a penalty die on the attack and on the chase check.</p>`);
}

export async function takeTurn(input: TakeTurnInput): Promise<Coc7ChaseTurnResult> {
  requireCoc7();
  requireGM();
  const state = requireChase();
  if (state.pending) throw new Error(`${getParticipant(state, state.pending.participantId).name} failed and must take the 1D6 loss, spend Luck or push first.`);
  const named = input.participant ? findParticipant(state, input.participant).id : undefined;
  const p = requireCurrent(state, named);
  const bonus = input.bonusDice === undefined ? 0 : input.bonusDice;
  if (!Number.isInteger(bonus) || bonus < -2 || bonus > 2) throw new Error('bonusDice must be an integer from -2 to 2');
  const difficulty = checkDifficulty(input.difficulty);
  const pushedAsk = state.awaiting?.participantId === p.id && state.awaiting.pushed ? state.awaiting : null;
  const challenge = pushedAsk ?? challengeFor(state, p, {
    bonusDice: bonus,
    shooting: input.shooting ?? false,
    ...(input.check ? { check: checkFromRef(input.check) } : {}),
    ...(difficulty ? { difficulty } : {})
  });
  const label = checkLabel(challenge.check, challenge.difficulty);
  const mode = input.mode ?? 'roll';
  if (input.shooting && input.weaponId && !pushedAsk) await fireWeapon(state, p, input.weaponId);

  if (mode === 'request') {
    await requestRoll(state, p, challenge, pushedAsk !== null);
    return { ...viewOf(state), result: `Asked ${p.name} to roll ${label}. The turn resolves when their check card appears.` };
  }

  let roll: RollOutcome;
  const wasPushed = pushedAsk !== null;
  state.awaiting = null;
  if (mode === 'pass' || mode === 'fail') {
    const total = input.total !== undefined ? Math.floor(input.total) : null;
    const actor = actorOf(p);
    const target = targetFor(rawValue(actor, challenge.check, p), challenge.difficulty);
    roll = { total: total ?? (mode === 'pass' ? 1 : 100), target, passed: mode === 'pass' };
  } else {
    roll = await rollCheck(state, p, challenge.check, challenge.difficulty, challenge.bonusDice, input.blind ?? false);
  }
  return finishRoll(state, p, roll, challenge, wasPushed, mode === 'fail' && input.total === undefined);
}

async function finishRoll(
  state: ChaseState,
  p: ChaseParticipant,
  roll: RollOutcome,
  challenge: { check: ChaseCheck; difficulty: Coc7Difficulty; bonusDice: number },
  pushed: boolean,
  noLuck: boolean
): Promise<Coc7ChaseTurnResult> {
  const label = checkLabel(challenge.check, challenge.difficulty);
  const outcome = recordRoll(state, p, { ...challenge, total: roll.total, target: roll.target, passed: roll.passed, pushed });
  if (noLuck && state.pending) state.pending.luckNeeded = null;
  await saveChase(state);
  await announceRoll(state, p, outcome, roll, label);
  await autoPrompt(state);
  const result =
    outcome === 'moved'
      ? `${p.name} passed ${label} and moved to ${locationLabel(state, p.location)}.`
      : outcome === 'out'
        ? `${p.name} failed a pushed roll and is ${p.status}.`
        : `${p.name} failed ${label}. Resolve with take-loss, luck${state.pending?.canPush ? ' or push' : ''}.`;
  return {
    ...viewOf(state),
    result,
    roll: { total: roll.total, target: roll.target, passed: roll.passed, check: label, bonusDice: challenge.bonusDice, ...(roll.messageId ? { messageId: roll.messageId } : {}) }
  };
}

export async function resolveFailure(action: 'take-loss' | 'luck' | 'push', fixedLoss?: number): Promise<Coc7ChaseTurnResult> {
  requireCoc7();
  requireGM();
  const state = requireChase();
  const pending = state.pending;
  if (!pending) throw new Error('There is no failed challenge waiting.');
  const p = getParticipant(state, pending.participantId);

  if (action === 'take-loss') {
    let loss: number;
    if (fixedLoss !== undefined) {
      loss = Math.floor(fixedLoss);
      if (!Number.isFinite(loss) || loss < 0) throw new Error('loss must be zero or more');
    } else {
      loss = await rollMvpLoss(p.name, state.name);
    }
    const change = takeLoss(state, loss);
    await saveChase(state);
    const text =
      change.outcome === 'moved'
        ? `<p><b>${escapeHtml(p.name)}</b> loses ${String(loss)} MvP (${String(change.before)} → ${String(change.after)}) but stumbles through to ${escapeHtml(locationLabel(state, p.location))}.</p>`
        : `<p><b>${escapeHtml(p.name)}</b> loses ${String(loss)} MvP (${String(change.before)} → 0) and is ${change.outcome === 'caught' ? '<b>caught</b>' : '<b>out of the chase</b>'}.</p>${standings(state)}`;
    await post(state, `${text}${nextUp(state)}`);
    await autoPrompt(state);
    return { ...viewOf(state), result: `${p.name} lost ${String(loss)} MvP (${String(change.before)} → ${String(change.after)}): ${change.outcome}.`, loss };
  }

  if (action === 'luck') {
    if (pending.luckNeeded === null) throw new Error('Luck cannot be spent on this roll.');
    const actor = actorOf(p);
    const have = num(actor.system.attribs?.['lck']?.value);
    if (have < pending.luckNeeded) throw new Error(`${p.name} needs ${String(pending.luckNeeded)} Luck but has ${String(have)}.`);
    const ok = await actor.spendLuck(pending.luckNeeded);
    if (ok === false) throw new Error(`${p.name} could not spend ${String(pending.luckNeeded)} Luck.`);
    const spent = luckSuccess(state);
    await saveChase(state);
    await post(state, `<p><b>${escapeHtml(p.name)}</b> spends ${String(spent)} Luck (${String(have)} → ${String(have - spent)}) to pass and moves on to ${escapeHtml(locationLabel(state, p.location))}.</p>${nextUp(state)}`);
    await autoPrompt(state);
    return { ...viewOf(state), result: `${p.name} spent ${String(spent)} Luck and passed.` };
  }

  // push
  const was = beginPush(state);
  if (playerRolls(state, p)) {
    await requestRoll(state, p, { check: was.check, difficulty: was.difficulty, bonusDice: was.bonusDice }, true);
    return { ...viewOf(state), result: `Asked ${p.name} to push ${checkLabel(was.check, was.difficulty)}.` };
  }
  const roll = await rollCheck(state, p, was.check, was.difficulty, was.bonusDice, false);
  return finishRoll(state, p, roll, { check: was.check, difficulty: was.difficulty, bonusDice: was.bonusDice }, true, false);
}

/** A player picked an option on their failure card (sent to the Keeper's client over the module socket). */
export interface PlayerChoice {
  chaseId: string;
  participantId: string;
  userId: string;
  action: 'take-loss' | 'luck' | 'push';
  loss?: number;
}

export async function handlePlayerChoice(choice: PlayerChoice, user: unknown): Promise<Coc7ChaseTurnResult | null> {
  const state = loadChase();
  const pending = state?.pending;
  if (!state || state.id !== choice.chaseId || !pending || pending.participantId !== choice.participantId) return null;
  const p = getParticipant(state, pending.participantId);
  const actor = actorOf(p);
  if (!actor.testUserPermission?.(user, 'OWNER')) throw new Error(`That player does not own ${p.name}.`);
  if (!['take-loss', 'luck', 'push'].includes(choice.action)) return null;
  if (choice.action === 'take-loss') {
    const loss = Math.floor(Number(choice.loss));
    if (!Number.isFinite(loss) || loss < 1 || loss > 6) throw new Error('The 1D6 loss must be 1 to 6.');
    return resolveFailure('take-loss', loss);
  }
  return resolveFailure(choice.action);
}

/**
 * A player rolled from the chase's roll button: the GM's client sees the CoC7 card and resolves the turn.
 * Returns true when the card was used.
 */
let handlingCard = false;

export async function handleCheckCard(message: Coc7ChatMessage): Promise<boolean> {
  if (!globals().game.user?.isGM || handlingCard) return false;
  handlingCard = true;
  try {
    return await useCheckCard(message);
  } finally {
    handlingCard = false;
  }
}

async function useCheckCard(message: Coc7ChatMessage): Promise<boolean> {
  const state = loadChase();
  const awaiting = state?.awaiting;
  if (!state || !awaiting) return false;
  const load = message.flags?.CoC7?.load;
  if (load?.['as'] !== 'CoC7Check') return false;
  const p = state.participants.find(x => x.id === awaiting.participantId);
  if (!p) return false;
  const uuid = typeof load['actorUuid'] === 'string' ? load['actorUuid'] : '';
  if (uuid !== p.actorUuid) return false;
  const summary = checkCardSummary(message);
  if (!summary) return false;
  state.awaiting = null;
  const difficulty = summary.difficulty;
  await finishRoll(
    state,
    p,
    { total: summary.total, target: targetFor(summary.threshold, difficulty), passed: summary.passed, messageId: message.id },
    { check: awaiting.check, difficulty, bonusDice: summary.bonusDice },
    awaiting.pushed,
    false
  );
  return true;
}

export { requireCurrent };
