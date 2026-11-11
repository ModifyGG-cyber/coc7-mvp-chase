export type Coc7Difficulty = 'regular' | 'hard' | 'extreme' | 'critical';
export type Coc7CheckKind = 'skill' | 'characteristic' | 'attribute';
export type Coc7SuccessLevel = 'fumble' | 'failure' | 'regular' | 'hard' | 'extreme' | 'critical';

export interface Coc7ActorParams {
  actorId?: string;
  /** A token on the scene instead of actorId: uses that token's own actor. */
  tokenId?: string;
  sceneId?: string;
}

export interface Coc7ChaseActorRef extends Coc7ActorParams {
  /** For a monster or NPC that lacks a location's skill: skilled = DEX, average = half DEX (default), poor = one fifth DEX. */
  skillTier?: 'skilled' | 'average' | 'poor';
  /** Override the actor's MOV. */
  mov?: number;
}

export interface Coc7ChaseCheckRef {
  /** skill uses the sheet name ("Athletics"); characteristic uses str, con, siz, dex, app, int, pow or edu; attribute lck. */
  kind: Coc7CheckKind;
  name: string;
}

export interface Coc7ChaseView {
  active: boolean;
  name?: string;
  round?: number;
  current?: string | null;
  currentChallenge?: string | null;
  outcome?: string | null;
  pending?: { participant: string; total: number; target: number; luckNeeded: number | null; canPush: boolean } | null;
  awaiting?: { participant: string; challenge: string } | null;
  participants?: { id: string; name: string; side: string; mvp: number; mov: number; location: number; status: string; dex: number; nextPenaltyDice: number }[];
  locations?: { index: number; name: string; obstacle?: string; challenge: string | null }[];
  order?: string[];
  log?: string[];
}

export interface Coc7ChaseTurnResult extends Coc7ChaseView {
  result: string;
  roll?: { total: number; target: number; passed: boolean; check: string; bonusDice: number; messageId?: string };
  loss?: number;
}
