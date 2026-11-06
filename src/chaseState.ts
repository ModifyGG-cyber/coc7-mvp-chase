/**
 * MvP chase rules (Call of Cthulhu 7e, Keeper Companion "New Chase Rules"), as pure state changes.
 *
 * Everyone has Movement Points (MvP) equal to MOV. Each location has one challenge. A success moves the
 * character on for free; a failure costs 1D6 MvP but still moves them on while they have MvP left.
 * At 0 MvP the quarry is caught and a pursuer drops out; with no pursuers left the quarry escapes.
 *
 * Nothing here touches Foundry, so the rules can be unit tested. ChaseService does the rolling,
 * saving and chat posting.
 */

import type { Coc7CheckKind, Coc7Difficulty } from './types';

export type ChaseSide = 'quarry' | 'pursuer';
export type ChaseStatus = 'active' | 'caught' | 'out' | 'escaped';
/** How well a monster or NPC without the skill copes: Skilled = DEX, Average = half DEX, Poor = one fifth. */
export type ChaseSkillTier = 'skilled' | 'average' | 'poor';

export interface ChaseCheck {
  kind: Coc7CheckKind;
  /** Skill name as on the sheet ("Athletics"), or a characteristic key (dex, con, str, siz). */
  name: string;
}

export interface ChaseLocation {
  /** 1-based. Everyone starts in Location 1. */
  index: number;
  name: string;
  /** The one challenge for this location; null until the Keeper picks it. */
  check: ChaseCheck | null;
  /** Optional second way through ("Athletics or Stealth"): the character picks which to roll. */
  alt?: ChaseCheck | null;
  difficulty: Coc7Difficulty;
}

export interface ChaseParticipant {
  id: string;
  name: string;
  actorId: string;
  actorUuid: string;
  tokenId?: string;
  sceneId?: string;
  img?: string;
  side: ChaseSide;
  dex: number;
  mov: number;
  mvp: number;
  location: number;
  status: ChaseStatus;
  /** One-shot penalty dice for this character's next challenge (head start, helping an ally). */
  nextPenaltyDice: number;
  /** Used when the character lacks the location's skill. Default: average. */
  skillTier: ChaseSkillTier;
}

/** A failed challenge waiting for the Keeper or player to choose: take 1D6, spend Luck, or push. */
export interface ChasePending {
  participantId: string;
  check: ChaseCheck;
  difficulty: Coc7Difficulty;
  bonusDice: number;
  total: number;
  /** Highest roll that would have passed. */
  target: number;
  /** Luck needed to turn it into a success; null when Luck can't be spent (pushed roll, Luck check). */
  luckNeeded: number | null;
  /** A skill roll that hasn't been pushed yet. */
  canPush: boolean;
  pushed: boolean;
}

export interface ChaseAwaiting {
  participantId: string;
  check: ChaseCheck;
  /** The location's other challenge, when the player may pick. */
  alt?: ChaseCheck | null;
  difficulty: Coc7Difficulty;
  bonusDice: number;
  pushed: boolean;
}

export interface ChaseState {
  version: 1;
  id: string;
  name: string;
  round: number;
  /** Participant ids in acting order for this round: quarry by DEX, then pursuers by DEX. */
  order: string[];
  /** Index into order of whoever acts now. */
  turn: number;
  participants: ChaseParticipant[];
  locations: ChaseLocation[];
  /** Optional: from this location on, new locations start at Hard. null (the default) = every location starts Regular; the Keeper raises difficulty by hand. */
  hardFrom: number | null;
  pending: ChasePending | null;
  /** A roll asked of a player: the next CoC7 check card from that actor resolves the turn. */
  awaiting: ChaseAwaiting | null;
  /** Players roll their own checks and choose their own failure options. Missing = on. */
  promptPlayers?: boolean;
  /** Earlier states for Undo, oldest first (each without its own history). */
  history?: ChaseState[];
  /** Set when the chase is over. */
  outcome: string | null;
  /** Most recent last; trimmed to LOG_LIMIT. */
  log: string[];
}

export interface NewParticipant {
  id: string;
  name: string;
  actorId: string;
  actorUuid: string;
  tokenId?: string;
  sceneId?: string;
  img?: string;
  side: ChaseSide;
  dex: number;
  mov: number;
  /** Has a major wound: MvP are halved, rounded down. */
  majorWound?: boolean;
  skillTier?: ChaseSkillTier;
}

const LOG_LIMIT = 60;
export const MAX_POOL = 2;

export function createChase(input: {
  id: string;
  name?: string;
  firstLocation?: string;
  hardFrom?: number | null;
}): ChaseState {
  return {
    version: 1,
    id: input.id,
    name: input.name?.trim() || 'Chase',
    round: 0,
    order: [],
    turn: 0,
    participants: [],
    locations: [{ index: 1, name: input.firstLocation?.trim() || 'Location 1', check: null, difficulty: 'regular' }],
    hardFrom: input.hardFrom ?? null,
    pending: null,
    awaiting: null,
    outcome: null,
    log: []
  };
}

function log(state: ChaseState, line: string): void {
  state.log.push(line);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

export function getParticipant(state: ChaseState, id: string): ChaseParticipant {
  const p = state.participants.find(x => x.id === id);
  if (!p) throw new Error(`No chase participant with id "${id}"`);
  return p;
}

export function findParticipant(state: ChaseState, key: string): ChaseParticipant {
  const lower = key.toLocaleLowerCase();
  const p =
    state.participants.find(x => x.id === key || x.actorId === key || x.tokenId === key) ??
    state.participants.find(x => x.name.toLocaleLowerCase() === lower);
  if (!p) throw new Error(`"${key}" is not in the chase. Participants: ${state.participants.map(x => x.name).join(', ') || 'none'}`);
  return p;
}

export function startingMvp(mov: number, majorWound: boolean): number {
  const base = Math.max(0, Math.floor(mov));
  return majorWound ? Math.floor(base / 2) : base;
}

export function addParticipant(state: ChaseState, input: NewParticipant): ChaseParticipant {
  if (state.outcome) throw new Error('The chase is over.');
  if (state.participants.some(p => p.id === input.id)) throw new Error(`${input.name} is already in the chase.`);
  const mvp = startingMvp(input.mov, input.majorWound ?? false);
  const p: ChaseParticipant = {
    id: input.id,
    name: input.name,
    actorId: input.actorId,
    actorUuid: input.actorUuid,
    ...(input.tokenId ? { tokenId: input.tokenId } : {}),
    ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    ...(input.img ? { img: input.img } : {}),
    side: input.side,
    dex: input.dex,
    mov: input.mov,
    mvp,
    location: 1,
    status: mvp > 0 ? 'active' : input.side === 'quarry' ? 'caught' : 'out',
    nextPenaltyDice: 0,
    skillTier: input.skillTier ?? 'average'
  };
  state.participants.push(p);
  log(state, `${p.name} joins as ${p.side === 'quarry' ? 'quarry' : 'a pursuer'} with ${String(mvp)} MvP${input.majorWound ? ' (halved: major wound)' : ''}.`);
  if (state.round > 0 && p.status === 'active') state.order.push(p.id);
  return p;
}

export function removeParticipant(state: ChaseState, id: string): void {
  const p = getParticipant(state, id);
  const current = currentParticipant(state);
  state.participants = state.participants.filter(x => x.id !== id);
  const at = state.order.indexOf(id);
  if (at >= 0) {
    state.order.splice(at, 1);
    if (at < state.turn) state.turn--;
  }
  if (state.pending?.participantId === id) state.pending = null;
  if (state.awaiting?.participantId === id) state.awaiting = null;
  log(state, `${p.name} is removed from the chase.`);
  if (state.round > 0) {
    if (current?.id === id) settleTurn(state);
    checkEnd(state);
  }
}

/** Quarry first, then pursuers; highest DEX first inside each group. Ties keep the order they joined in. */
export function actingOrder(participants: ChaseParticipant[]): string[] {
  const rank = (side: ChaseSide): number => (side === 'quarry' ? 0 : 1);
  return participants
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.status === 'active')
    .sort((a, b) => rank(a.p.side) - rank(b.p.side) || b.p.dex - a.p.dex || a.i - b.i)
    .map(({ p }) => p.id);
}

/**
 * Starts round 1. A clear head start for the quarry gives each pursuer one penalty die on their first challenge.
 */
export function startChase(state: ChaseState, options: { headStart?: boolean } = {}): void {
  if (state.round > 0) throw new Error('The chase has already started.');
  if (!state.participants.some(p => p.side === 'quarry' && p.status === 'active')) throw new Error('Add at least one quarry first.');
  if (!state.participants.some(p => p.side === 'pursuer' && p.status === 'active')) throw new Error('Add at least one pursuer first.');
  if (options.headStart) {
    for (const p of state.participants) if (p.side === 'pursuer') p.nextPenaltyDice += 1;
  }
  state.round = 1;
  state.order = actingOrder(state.participants);
  state.turn = 0;
  log(state, `Round 1 begins in ${locationLabel(state, 1)}${options.headStart ? '. The quarry has a head start: pursuers take a penalty die on their first challenge' : ''}.`);
}

export function locationLabel(state: ChaseState, index: number): string {
  const loc = state.locations.find(l => l.index === index);
  return loc && loc.name !== `Location ${String(index)}` ? `Location ${String(index)} (${loc.name})` : `Location ${String(index)}`;
}

/** Makes sure a location exists; new ones from hardFrom on start at Hard. */
export function ensureLocation(state: ChaseState, index: number): ChaseLocation {
  let loc = state.locations.find(l => l.index === index);
  if (!loc) {
    loc = {
      index,
      name: `Location ${String(index)}`,
      check: null,
      difficulty: state.hardFrom !== null && index >= state.hardFrom ? 'hard' : 'regular'
    };
    state.locations.push(loc);
    state.locations.sort((a, b) => a.index - b.index);
  }
  return loc;
}

export function setLocation(
  state: ChaseState,
  index: number,
  update: { name?: string; check?: ChaseCheck | null; alt?: ChaseCheck | null; difficulty?: Coc7Difficulty }
): ChaseLocation {
  if (!Number.isInteger(index) || index < 1) throw new Error('Location index must be 1 or more');
  const loc = ensureLocation(state, index);
  if (update.name !== undefined) loc.name = update.name.trim() || `Location ${String(index)}`;
  if (update.check !== undefined) loc.check = update.check;
  if (update.alt !== undefined) loc.alt = update.alt;
  if (update.difficulty !== undefined) loc.difficulty = update.difficulty;
  return loc;
}

/**
 * Takes a location out of the chase. The ones after it move down a number, and so does anyone
 * standing in them, so the line stays unbroken. A location where someone still in the chase is
 * standing can't be removed, and neither can the only one left.
 */
export function removeLocation(state: ChaseState, index: number): void {
  const loc = state.locations.find(l => l.index === index);
  if (!loc) throw new Error(`There is no Location ${String(index)}`);
  if (state.locations.length <= 1) throw new Error('A chase needs at least one location');
  const here = state.participants.filter(p => p.location === index && p.status === 'active');
  if (here.length) throw new Error(`${here.map(p => p.name).join(', ')} ${here.length > 1 ? 'are' : 'is'} still in ${locationLabel(state, index)}; move them first`);
  state.locations = state.locations.filter(l => l !== loc);
  for (const l of state.locations) {
    if (l.index < index) continue;
    const plain = l.name === `Location ${String(l.index)}`;
    l.index -= 1;
    if (plain) l.name = `Location ${String(l.index)}`;
  }
  for (const p of state.participants) if (p.location > index) p.location -= 1;
  if (state.hardFrom !== null && state.hardFrom > index) state.hardFrom -= 1;
}

export function currentParticipant(state: ChaseState): ChaseParticipant | null {
  if (state.round === 0 || state.outcome) return null;
  const id = state.order[state.turn];
  return id ? (state.participants.find(p => p.id === id) ?? null) : null;
}

/** Moves to the next active participant, starting a new round when everyone has gone. */
function settleTurn(state: ChaseState): void {
  if (state.outcome) return;
  for (;;) {
    while (state.turn < state.order.length) {
      const id = state.order[state.turn];
      const p = state.participants.find(x => x.id === id);
      if (p?.status === 'active') return;
      state.turn++;
    }
    const order = actingOrder(state.participants);
    if (order.length === 0) return;
    state.round++;
    state.order = order;
    state.turn = 0;
    log(state, `Round ${String(state.round)} begins.`);
  }
}

function endTurn(state: ChaseState): void {
  state.pending = null;
  state.awaiting = null;
  state.turn++;
  checkEnd(state);
  settleTurn(state);
}

export function requireCurrent(state: ChaseState, participantId?: string): ChaseParticipant {
  if (state.outcome) throw new Error(`The chase is over: ${state.outcome}`);
  if (state.round === 0) throw new Error('The chase has not started yet.');
  const p = currentParticipant(state);
  if (!p) throw new Error('Nobody is left to act.');
  if (participantId && p.id !== participantId) {
    const other = state.participants.find(x => x.id === participantId);
    throw new Error(`It is ${p.name}'s turn, not ${other?.name ?? participantId}'s.`);
  }
  return p;
}

/** The challenge, difficulty and dice the current participant rolls this turn. */
export function challengeFor(
  state: ChaseState,
  p: ChaseParticipant,
  options: { bonusDice?: number; shooting?: boolean; check?: ChaseCheck; useAlt?: boolean; difficulty?: Coc7Difficulty } = {}
): { location: ChaseLocation; check: ChaseCheck; alt: ChaseCheck | null; difficulty: Coc7Difficulty; bonusDice: number } {
  const location = ensureLocation(state, p.location);
  const check = options.check ?? (options.useAlt && location.alt ? location.alt : location.check);
  // The other way through, offered to the player when the Keeper didn't pick a check for this turn.
  const alt = options.check || options.useAlt ? null : (location.alt ?? null);
  if (!check) {
    throw new Error(`${locationLabel(state, p.location)} has no challenge yet. Pick one (for example Climb, Dodge, or plain DEX) first.`);
  }
  let pool = options.bonusDice ?? 0;
  pool -= p.nextPenaltyDice;
  if (options.shooting) pool -= 1;
  return {
    location,
    check,
    alt,
    difficulty: options.difficulty ?? location.difficulty,
    bonusDice: Math.max(-MAX_POOL, Math.min(MAX_POOL, pool))
  };
}

/** Highest d100 that passes, for a raw value and difficulty. */
export function targetFor(value: number, difficulty: Coc7Difficulty): number {
  switch (difficulty) {
    case 'regular':
      return value;
    case 'hard':
      return Math.floor(value / 2);
    case 'extreme':
      return Math.floor(value / 5);
    case 'critical':
      return 1;
  }
}

export function tierValue(dex: number, tier: ChaseSkillTier): number {
  return tier === 'skilled' ? dex : tier === 'average' ? Math.floor(dex / 2) : Math.floor(dex / 5);
}

/** A roll was made. A success moves the character on; a failure waits for take-loss, Luck or push. */
export function recordRoll(
  state: ChaseState,
  p: ChaseParticipant,
  roll: { check: ChaseCheck; difficulty: Coc7Difficulty; bonusDice: number; total: number; target: number; passed: boolean; pushed?: boolean }
): 'moved' | 'pending' | 'out' {
  p.nextPenaltyDice = 0;
  const label = checkLabel(roll.check, roll.difficulty);
  if (roll.passed) {
    log(state, `${p.name} passes ${label} (${String(roll.total)} vs ${String(roll.target)}).`);
    moveOn(state, p);
    endTurn(state);
    return 'moved';
  }
  if (roll.pushed) {
    log(state, `${p.name} fails a pushed ${label} (${String(roll.total)} vs ${String(roll.target)}) and is out of the chase.`);
    drop(state, p);
    endTurn(state);
    return 'out';
  }
  const isLuckRoll = roll.check.kind === 'attribute' && roll.check.name === 'lck';
  state.pending = {
    participantId: p.id,
    check: roll.check,
    difficulty: roll.difficulty,
    bonusDice: roll.bonusDice,
    total: roll.total,
    target: roll.target,
    luckNeeded: isLuckRoll || roll.target < 1 ? null : roll.total - roll.target,
    canPush: roll.check.kind === 'skill',
    pushed: false
  };
  log(state, `${p.name} fails ${label} (${String(roll.total)} vs ${String(roll.target)}).`);
  return 'pending';
}

/** Failure: lose the rolled 1D6. Still through with 1+ MvP; at 0 the quarry is caught and a pursuer is out. */
export function takeLoss(state: ChaseState, loss: number): { before: number; after: number; outcome: 'moved' | 'caught' | 'out' } {
  const pending = state.pending;
  if (!pending) throw new Error('There is no failed challenge waiting.');
  const p = getParticipant(state, pending.participantId);
  const before = p.mvp;
  p.mvp = Math.max(0, p.mvp - Math.max(0, Math.floor(loss)));
  if (p.mvp > 0) {
    log(state, `${p.name} loses ${String(loss)} MvP (${String(before)} → ${String(p.mvp)}) but stumbles through.`);
    moveOn(state, p);
    endTurn(state);
    return { before, after: p.mvp, outcome: 'moved' };
  }
  log(state, `${p.name} loses ${String(loss)} MvP (${String(before)} → 0).`);
  drop(state, p);
  endTurn(state);
  return { before, after: 0, outcome: p.status === 'caught' ? 'caught' : 'out' };
}

/** Luck turns the failed challenge into a success. The Luck itself is spent by the caller. */
export function luckSuccess(state: ChaseState): number {
  const pending = state.pending;
  if (!pending) throw new Error('There is no failed challenge waiting.');
  if (pending.luckNeeded === null) throw new Error('Luck cannot be spent on this roll.');
  const p = getParticipant(state, pending.participantId);
  const spent = pending.luckNeeded;
  log(state, `${p.name} spends ${String(spent)} Luck to pass.`);
  moveOn(state, p);
  endTurn(state);
  return spent;
}

/** Clears the failure so the roll can be pushed; the pushed roll is recorded with pushed: true. */
export function beginPush(state: ChaseState): ChasePending {
  const pending = state.pending;
  if (!pending) throw new Error('There is no failed challenge waiting.');
  if (!pending.canPush) throw new Error('Only a skill roll can be pushed, and only once.');
  state.pending = null;
  return pending;
}

/** The Keeper skips the current character's turn (they hide, fight, or do something else). */
export function skipTurn(state: ChaseState, reason?: string): void {
  const p = requireCurrent(state);
  log(state, `${p.name} does not move${reason ? `: ${reason}` : ''}.`);
  endTurn(state);
}

/**
 * Help an ally who has just dropped to 0 MvP: the helper pays 1 MvP (passed to the ally, who stays in)
 * and takes a penalty die on their own next challenge.
 */
export function helpAlly(state: ChaseState, helperId: string, allyId: string): void {
  const helper = getParticipant(state, helperId);
  const ally = getParticipant(state, allyId);
  if (helper.status !== 'active') throw new Error(`${helper.name} is no longer in the chase.`);
  if (helper.side !== ally.side) throw new Error(`${helper.name} and ${ally.name} are on different sides.`);
  if (ally.status === 'active' && ally.mvp > 0) throw new Error(`${ally.name} still has MvP and needs no help.`);
  if (ally.status === 'escaped') throw new Error(`${ally.name} has already escaped.`);
  if (helper.mvp < 2) throw new Error(`${helper.name} has too few MvP to help (needs 2: 1 to pay and 1 to stay in).`);
  helper.mvp -= 1;
  helper.nextPenaltyDice += 1;
  ally.mvp = 1;
  const wasOut = ally.status !== 'active';
  ally.status = 'active';
  if (wasOut) {
    state.outcome = null;
    if (!state.order.slice(state.turn).includes(ally.id)) state.order.push(ally.id);
  }
  log(state, `${helper.name} helps ${ally.name}, who stays in with 1 MvP. ${helper.name} pays 1 MvP and takes a penalty die next challenge.`);
}

/** A major wound mid-chase halves current MvP, rounded down. */
export function majorWound(state: ChaseState, id: string): { before: number; after: number } {
  const p = getParticipant(state, id);
  const before = p.mvp;
  p.mvp = Math.floor(p.mvp / 2);
  log(state, `${p.name} takes a major wound: MvP ${String(before)} → ${String(p.mvp)}.`);
  if (p.mvp === 0 && p.status === 'active') {
    const current = currentParticipant(state);
    drop(state, p);
    if (state.pending?.participantId === p.id) state.pending = null;
    if (current?.id === p.id) state.turn++;
    checkEnd(state);
    settleTurn(state);
  }
  return { before, after: p.mvp };
}

/** The Keeper's manual edit: set MvP, location, side or status directly. */
export function adjustParticipant(
  state: ChaseState,
  id: string,
  update: { mvp?: number; location?: number; status?: ChaseStatus; side?: ChaseSide; nextPenaltyDice?: number; skillTier?: ChaseSkillTier }
): ChaseParticipant {
  const p = getParticipant(state, id);
  if (update.mvp !== undefined) p.mvp = Math.max(0, Math.floor(update.mvp));
  if (update.location !== undefined) {
    if (!Number.isInteger(update.location) || update.location < 1) throw new Error('location must be 1 or more');
    p.location = update.location;
    ensureLocation(state, p.location);
  }
  if (update.side !== undefined) p.side = update.side;
  if (update.nextPenaltyDice !== undefined) p.nextPenaltyDice = Math.max(0, Math.min(MAX_POOL, Math.floor(update.nextPenaltyDice)));
  if (update.skillTier !== undefined) p.skillTier = update.skillTier;
  if (update.status !== undefined && update.status !== p.status) {
    p.status = update.status;
    if (p.status === 'active') {
      state.outcome = null;
      if (state.round > 0 && !state.order.slice(state.turn).includes(p.id)) state.order.push(p.id);
    }
  }
  log(state, `Keeper adjusts ${p.name}: ${String(p.mvp)} MvP, ${locationLabel(state, p.location)}, ${p.status}.`);
  if (state.round > 0) {
    checkEnd(state);
    settleTurn(state);
  }
  return p;
}

/**
 * Puts the chase back to its start: everyone in Location 1 with fresh MvP, nobody caught or out,
 * back in setup so the Keeper can press Start again. Participants and locations are kept.
 */
export function resetChase(state: ChaseState, startMvp: (p: ChaseParticipant) => number): void {
  for (const p of state.participants) {
    p.mvp = Math.max(0, Math.floor(startMvp(p)));
    p.location = 1;
    p.status = p.mvp > 0 ? 'active' : p.side === 'quarry' ? 'caught' : 'out';
    p.nextPenaltyDice = 0;
  }
  state.round = 0;
  state.order = [];
  state.turn = 0;
  state.pending = null;
  state.awaiting = null;
  state.outcome = null;
  state.log = [];
  log(state, 'The Keeper reset the chase: everyone is back in Location 1 with full MvP.');
}

/** Moves a character one location back or forward to fix a mistake. Their turn and MvP don't change. */
export function stepLocation(state: ChaseState, id: string, delta: 1 | -1): ChaseParticipant {
  const p = getParticipant(state, id);
  const to = p.location + delta;
  if (to < 1) throw new Error(`${p.name} is already in Location 1.`);
  // A roll already asked for was for the old location.
  if (state.awaiting?.participantId === p.id) state.awaiting = null;
  p.location = to;
  ensureLocation(state, to);
  log(state, `Keeper moves ${p.name} ${delta > 0 ? 'forward' : 'back'} to ${locationLabel(state, to)}.`);
  return p;
}

const HISTORY_LIMIT = 10;

/** Remembers the chase as it is now, so the next change can be undone. */
export function pushHistory(state: ChaseState): void {
  const { history = [], ...rest } = state;
  const snapshot = JSON.parse(JSON.stringify(rest)) as ChaseState;
  state.history = [...history, snapshot].slice(-HISTORY_LIMIT);
}

/** What the last undoable change did, from the log lines it added. */
export function lastStep(state: ChaseState): string {
  const previous = state.history?.at(-1);
  if (!previous) return '';
  const added = state.log.length >= previous.log.length ? state.log.slice(previous.log.length) : [];
  const lines = added.filter(l => !/^Round \d+ begins/.test(l));
  return (lines.length ? lines : added).join(' ') || (state.log.at(-1) ?? '');
}

/** Puts the chase back to how it was before the last change. Returns what was undone. */
export function undoLast(state: ChaseState): { restored: ChaseState; undone: string } {
  const history = state.history ?? [];
  const previous = history.at(-1);
  if (!previous) throw new Error('There is nothing to undo.');
  const undone = lastStep(state) || 'the last change';
  const restored: ChaseState = { ...previous, history: history.slice(0, -1) };
  log(restored, `Keeper undoes: ${undone}`);
  return { restored, undone };
}

/** "Athletics or Stealth", with difficulty. */
export function challengeLabel(loc: { check: ChaseCheck | null; alt?: ChaseCheck | null; difficulty: Coc7Difficulty }): string | null {
  if (!loc.check) return null;
  const main = checkLabel(loc.check, loc.difficulty);
  if (!loc.alt) return main;
  return `${main} or ${loc.alt.kind === 'skill' ? loc.alt.name : loc.alt.name.toUpperCase()}`;
}

/** Ends the chase now with the Keeper's own outcome. */
export function endChase(state: ChaseState, outcome?: string): void {
  state.pending = null;
  state.awaiting = null;
  state.outcome = outcome?.trim() || 'The Keeper ended the chase.';
  log(state, state.outcome);
}

function moveOn(state: ChaseState, p: ChaseParticipant): void {
  p.location += 1;
  ensureLocation(state, p.location);
}

function drop(state: ChaseState, p: ChaseParticipant): void {
  if (p.side === 'quarry') {
    p.status = 'caught';
    log(state, `${p.name} is caught!`);
  } else {
    p.status = 'out';
    log(state, `${p.name} drops out of the chase.`);
  }
}

/** Quarry all caught → over. No pursuers left → every quarry still running escapes. */
export function checkEnd(state: ChaseState): void {
  if (state.outcome || state.round === 0) return;
  const quarry = state.participants.filter(p => p.side === 'quarry');
  const runningQuarry = quarry.filter(p => p.status === 'active');
  const pursuers = state.participants.filter(p => p.side === 'pursuer' && p.status === 'active');
  if (runningQuarry.length > 0 && pursuers.length === 0) {
    for (const q of runningQuarry) q.status = 'escaped';
    state.outcome = `No pursuers are left: ${runningQuarry.map(q => q.name).join(', ')} escaped.`;
  } else if (runningQuarry.length === 0) {
    const caught = quarry.filter(p => p.status === 'caught').map(p => p.name);
    const escaped = quarry.filter(p => p.status === 'escaped').map(p => p.name);
    const parts = [caught.length ? `${caught.join(', ')} caught` : '', escaped.length ? `${escaped.join(', ')} escaped` : ''].filter(Boolean);
    state.outcome = `The chase is over: ${parts.join('; ') || 'no quarry left'}.`;
  }
  if (state.outcome) {
    state.pending = null;
    state.awaiting = null;
    log(state, state.outcome);
  }
}

export function checkLabel(check: ChaseCheck, difficulty: Coc7Difficulty): string {
  const name = check.kind === 'skill' ? check.name : check.name.toUpperCase();
  return difficulty === 'regular' ? name : `${difficulty[0]?.toUpperCase() ?? ''}${difficulty.slice(1)} ${name}`;
}

/** A compact view for tools and chat. */
export function summarize(state: ChaseState): {
  name: string;
  round: number;
  current: string | null;
  outcome: string | null;
  pending: ChasePending | null;
  participants: { id: string; name: string; side: ChaseSide; mvp: number; mov: number; location: number; status: ChaseStatus; dex: number; nextPenaltyDice: number }[];
  locations: ChaseLocation[];
  order: string[];
  log: string[];
} {
  const current = currentParticipant(state);
  return {
    name: state.name,
    round: state.round,
    current: current ? current.name : null,
    outcome: state.outcome,
    pending: state.pending,
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
    locations: state.locations,
    order: state.order.slice(state.turn).map(id => state.participants.find(p => p.id === id)?.name ?? id),
    log: state.log.slice(-10)
  };
}
