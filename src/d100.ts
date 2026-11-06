import type { Coc7Difficulty, Coc7SuccessLevel } from './types';

/** One rolled d100 as the CoC7 system stores it: tens dice give 1-10 (10 = "00"), the unit die 1-10 (10 = 0). */
export interface RolledD100 {
  baseDie: number;
  unitDie: number;
  bonusDice: number[];
  penaltyDice: number[];
}

const LEVEL: Record<Coc7SuccessLevel, number> = { fumble: -1, failure: 0, regular: 1, hard: 2, extreme: 3, critical: 4 };
const REQUIRED: Record<Coc7Difficulty, number> = { regular: 1, hard: 2, extreme: 3, critical: 4 };

export function d100Total(tensDie: number, unitDie: number): number {
  const total = (tensDie % 10) * 10 + (unitDie % 10);
  return total === 0 ? 100 : total;
}

/** Total after bonus (keep lowest) or penalty (keep highest) dice, per the Keeper rules. */
export function resolveD100(roll: RolledD100, poolModifier: number): { total: number; tensDice: number[] } {
  const extra = poolModifier > 0 ? roll.bonusDice.slice(0, poolModifier) : poolModifier < 0 ? roll.penaltyDice.slice(0, -poolModifier) : [];
  const tensDice = [roll.baseDie, ...extra];
  const totals = tensDice.map(t => d100Total(t, roll.unitDie));
  return { total: poolModifier >= 0 ? Math.min(...totals) : Math.max(...totals), tensDice };
}

export function successLevel(total: number, threshold: number): Coc7SuccessLevel {
  if (total === 1) return 'critical';
  if (threshold < 50 ? total >= 96 : total === 100) return 'fumble';
  if (total <= Math.floor(threshold / 5)) return 'extreme';
  if (total <= Math.floor(threshold / 2)) return 'hard';
  if (total <= threshold) return 'regular';
  return 'failure';
}

export function meetsDifficulty(level: Coc7SuccessLevel, difficulty: Coc7Difficulty): boolean {
  return LEVEL[level] >= REQUIRED[difficulty];
}

/** The system's own difficulty notation, as used by actor checks and @coc7 links. */
export const DIFFICULTY_CODE: Record<Coc7Difficulty, string> = { regular: '0', hard: '+', extreme: '++', critical: '+++' };

export const DIFFICULTY_FROM_LEVEL: Record<number, Coc7Difficulty> = { 1: 'regular', 2: 'hard', 3: 'extreme', 4: 'critical' };
