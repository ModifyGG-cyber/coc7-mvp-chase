/**
 * The small slice of Foundry and the Call of Cthulhu 7e system (CoC7 8.x) the chase uses:
 * finding actors, making checks through the system so the normal check card is posted,
 * and reading the result back from that card. Read from globalThis so tests can supply fakes.
 */

import type { Coc7ActorParams, Coc7CheckKind, Coc7Difficulty } from './types';
import { DIFFICULTY_CODE, DIFFICULTY_FROM_LEVEL, meetsDifficulty, resolveD100, successLevel, type RolledD100 } from './d100';

export interface Coc7Item {
  id: string;
  name: string;
  type: string;
  system: Record<string, unknown> & { value?: unknown };
}

export interface Coc7Actor {
  id: string;
  uuid: string;
  name: string;
  type: string;
  img?: string;
  statuses?: Set<string>;
  system: {
    characteristics?: Record<string, { value?: number | null }>;
    attribs?: Record<string, { value?: number | null; max?: number | null }>;
  };
  items: { filter(fn: (item: Coc7Item) => boolean): Coc7Item[] };
  skillCheck(skill: string, fastForward: boolean, options?: Record<string, unknown>): Promise<unknown>;
  characteristicCheck(name: string, fastForward: boolean, options?: Record<string, unknown>): Promise<unknown>;
  attributeCheck(name: string, fastForward: boolean, options?: Record<string, unknown>): Promise<unknown>;
  spendLuck(amount: number): Promise<unknown>;
}

export interface Coc7ChatMessage {
  id: string;
  flags?: { CoC7?: { load?: Record<string, unknown> } };
}

interface SceneLike {
  id: string;
  tokens: { get(id: string): { id: string; actor: Coc7Actor | null } | undefined };
}

export interface Coc7Globals {
  game: {
    actors: { get(id: string): Coc7Actor | undefined };
    scenes: { get(id: string): SceneLike | undefined; active: SceneLike | null };
  };
  Hooks: { on(hook: string, fn: (...args: unknown[]) => void): number; off(hook: string, id: number): void };
  ChatMessage: {
    create(data: Record<string, unknown>): Promise<{ id: string }>;
    getWhisperRecipients?(name: string): { id: string }[];
  };
  Roll: new (formula: string) => { evaluate(): Promise<{ total: number }> };
}

export function getCoc7Globals(): Coc7Globals {
  return globalThis as unknown as Coc7Globals;
}

/** The actor a reference points at: a world actor by id, or a token's own actor. */
export function resolveActor(params: Coc7ActorParams): { actor: Coc7Actor; tokenId?: string } {
  const { game } = getCoc7Globals();
  if (params.tokenId !== undefined) {
    const scene = params.sceneId !== undefined ? game.scenes.get(params.sceneId) : game.scenes.active;
    if (!scene) throw new Error(params.sceneId !== undefined ? `Scene not found: ${params.sceneId}` : 'No active scene');
    const token = scene.tokens.get(params.tokenId);
    if (!token) throw new Error(`Token not found: ${params.tokenId}`);
    if (!token.actor) throw new Error(`Token has no actor: ${params.tokenId}`);
    return { actor: token.actor, tokenId: token.id };
  }
  if (params.actorId !== undefined) {
    const actor = game.actors.get(params.actorId);
    if (!actor) throw new Error(`Actor not found: ${params.actorId}`);
    return { actor };
  }
  throw new Error('Either actorId or tokenId is required');
}

const CHECK_CARD_TIMEOUT_MS = 15_000;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

export function findSkill(actor: Coc7Actor, name: string): Coc7Item | undefined {
  const skills = actor.items.filter(i => i.type === 'skill');
  const wanted = name.toLocaleLowerCase();
  const exact = skills.find(s => s.name.toLocaleLowerCase() === wanted);
  if (exact) return exact;
  const partial = skills.filter(s => s.name.toLocaleLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : undefined;
}

/** Waits for the chat card the CoC7 system posts for a check by this actor. */
function waitForCheckCard(actorUuid: string): { promise: Promise<Coc7ChatMessage>; cancel: () => void } {
  const { Hooks } = getCoc7Globals();
  let hookId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    Hooks.off('createChatMessage', hookId);
    if (timer) clearTimeout(timer);
  };
  const promise = new Promise<Coc7ChatMessage>((resolve, reject) => {
    hookId = Hooks.on('createChatMessage', (...args: unknown[]) => {
      const message = args[0] as Coc7ChatMessage;
      const load = message.flags?.CoC7?.load;
      if (load?.['as'] === 'CoC7Check' && load['actorUuid'] === actorUuid) {
        cancel();
        resolve(message);
      }
    });
    timer = setTimeout(() => {
      cancel();
      reject(new Error('The CoC7 system did not post a check card. A dialog may be open, or the check could not be made.'));
    }, CHECK_CARD_TIMEOUT_MS);
  });
  return { promise, cancel };
}

export interface CheckCardSummary {
  total: number;
  threshold: number;
  difficulty: Coc7Difficulty;
  passed: boolean;
  bonusDice: number;
}

/** The result on a CoC7 check card, or undefined if it isn't a rolled check. */
export function checkCardSummary(message: Coc7ChatMessage): CheckCardSummary | undefined {
  const load = message.flags?.CoC7?.load;
  if (load?.['as'] !== 'CoC7Check') return undefined;
  const pool = load['dicePool'] as
    | { threshold?: number; flatThresholdModifier?: number; currentPoolModifier?: number; difficulty?: number; rolledDice?: (RolledD100 & { rolled: boolean })[] }
    | undefined;
  const roll = pool?.rolledDice?.filter(r => r.rolled).pop();
  const threshold = num(pool?.threshold);
  if (!roll || threshold === null) return undefined;
  const effective = threshold + (num(pool?.flatThresholdModifier) ?? 0);
  const poolModifier = num(pool?.currentPoolModifier) ?? 0;
  const { total } = resolveD100(roll, poolModifier);
  const difficulty = DIFFICULTY_FROM_LEVEL[num(pool?.difficulty) ?? 1] ?? 'regular';
  return { total, threshold: effective, difficulty, passed: meetsDifficulty(successLevel(total, effective), difficulty), bonusDice: poolModifier };
}

/** Rolls a check as the actor through the CoC7 system and reads the result from its card. */
export async function rollSystemCheck(
  actor: Coc7Actor,
  check: { kind: Coc7CheckKind; name: string },
  difficulty: Coc7Difficulty,
  bonusDice: number,
  blind: boolean
): Promise<CheckCardSummary & { messageId: string }> {
  const options = { difficulty: DIFFICULTY_CODE[difficulty], poolModifier: bonusDice, ...(blind ? { blind } : {}) };
  let start: () => Promise<unknown>;
  if (check.kind === 'skill') {
    const skill = findSkill(actor, check.name);
    if (!skill) throw new Error(`${actor.name} has no skill named "${check.name}".`);
    start = (): Promise<unknown> => actor.skillCheck(skill.name, true, options);
  } else if (check.kind === 'characteristic') {
    start = (): Promise<unknown> => actor.characteristicCheck(check.name, true, options);
  } else {
    start = (): Promise<unknown> => actor.attributeCheck(check.name, true, options);
  }
  const card = waitForCheckCard(actor.uuid);
  try {
    await start();
  } catch (error) {
    card.cancel();
    throw error;
  }
  const message = await card.promise;
  const summary = checkCardSummary(message);
  if (!summary) throw new Error('The CoC7 check card had no result. Record it by hand with Passed or Failed.');
  return { ...summary, messageId: message.id };
}
