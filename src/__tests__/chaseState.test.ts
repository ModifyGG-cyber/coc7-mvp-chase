import {
  actingOrder,
  addParticipant,
  adjustParticipant,
  beginPush,
  challengeFor,
  createChase,
  currentParticipant,
  helpAlly,
  luckSuccess,
  majorWound,
  recordRoll,
  removeParticipant,
  resetChase,
  setLocation,
  skipTurn,
  startChase,
  stepLocation,
  takeLoss,
  targetFor,
  tierValue,
  type ChaseCheck,
  type ChaseState
} from '../chaseState';

const DEX: ChaseCheck = { kind: 'characteristic', name: 'dex' };
const DODGE: ChaseCheck = { kind: 'skill', name: 'Dodge' };
const CLIMB: ChaseCheck = { kind: 'skill', name: 'Climb' };

function person(id: string, side: 'quarry' | 'pursuer', dex: number, mov = 8, majorWound = false) {
  return { id, name: id, actorId: id, actorUuid: `Actor.${id}`, side, dex, mov, majorWound };
}

/** Rolls for whoever acts now against the location challenge. */
function roll(state: ChaseState, total: number, value: number, extra: { pushed?: boolean } = {}) {
  const p = currentParticipant(state);
  if (!p) throw new Error('nobody to act');
  const c = challengeFor(state, p);
  const target = targetFor(value, c.difficulty);
  return recordRoll(state, p, { check: c.check, difficulty: c.difficulty, bonusDice: c.bonusDice, total, target, passed: total <= target, ...extra });
}

describe('MvP chase rules', () => {
  test('MvP equal MOV, halved for a major wound', () => {
    const s = createChase({ id: 'c' });
    expect(addParticipant(s, person('a', 'quarry', 50, 9)).mvp).toBe(9);
    expect(addParticipant(s, person('b', 'pursuer', 50, 9, true)).mvp).toBe(4);
  });

  test('quarry act first, then pursuers, highest DEX first', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('p-slow', 'pursuer', 40));
    addParticipant(s, person('q-slow', 'quarry', 30));
    addParticipant(s, person('p-fast', 'pursuer', 80));
    addParticipant(s, person('q-fast', 'quarry', 70));
    expect(actingOrder(s.participants)).toEqual(['q-fast', 'q-slow', 'p-fast', 'p-slow']);
  });

  test('locations start Regular unless hardFrom is set, and can be changed', () => {
    const s = createChase({ id: 'c' });
    expect(setLocation(s, 5, {}).difficulty).toBe('regular');
    expect(setLocation(s, 5, { difficulty: 'hard' }).difficulty).toBe('hard');
    const tiring = createChase({ id: 'c', hardFrom: 3 });
    expect(setLocation(tiring, 2, {}).difficulty).toBe('regular');
    expect(setLocation(tiring, 3, {}).difficulty).toBe('hard');
  });

  test('the Cairo bazaar example plays out: the thug drops out and Julian escapes', () => {
    const s = createChase({ id: 'c', firstLocation: 'the spice alley' });
    addParticipant(s, person('Julian', 'quarry', 60));
    addParticipant(s, person('Thug', 'pursuer', 55));
    startChase(s);
    setLocation(s, 1, { check: DEX });

    // Round 1: Julian passes DEX; the thug faces Hard DEX (spilled fruit) and fails, losing 3.
    expect(roll(s, 34, 60)).toBe('moved');
    setLocation(s, 1, { difficulty: 'hard' });
    expect(roll(s, 71, 55)).toBe('pending');
    expect(s.pending?.target).toBe(27);
    expect(takeLoss(s, 3)).toEqual({ before: 8, after: 5, outcome: 'moved' });
    expect(s.round).toBe(2);

    // Round 2: Dodge through the crowd. Julian fails and loses 4; the thug passes.
    setLocation(s, 2, { name: 'the crowded square', check: DODGE });
    expect(roll(s, 62, 45)).toBe('pending');
    takeLoss(s, 4);
    expect(roll(s, 22, 40)).toBe('moved');

    // Round 3: Hard Climb (third location). Julian passes; the thug fails and loses 5: 0 MvP, out.
    setLocation(s, 3, { name: 'a high courtyard wall', check: CLIMB, difficulty: 'hard' });
    expect(s.locations.find(l => l.index === 3)?.difficulty).toBe('hard');
    expect(roll(s, 15, 40)).toBe('moved');
    expect(roll(s, 48, 50)).toBe('pending');
    expect(takeLoss(s, 5).outcome).toBe('out');

    const julian = s.participants.find(p => p.id === 'Julian');
    const thug = s.participants.find(p => p.id === 'Thug');
    expect(julian).toMatchObject({ mvp: 4, location: 4, status: 'escaped' });
    expect(thug).toMatchObject({ mvp: 0, location: 3, status: 'out' });
    expect(s.outcome).toMatch(/Julian escaped/);
  });

  test('quarry at 0 MvP is caught at once and the pursuer does not roll', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60, 3));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s);
    setLocation(s, 1, { check: DEX });
    roll(s, 90, 60);
    expect(takeLoss(s, 4).outcome).toBe('caught');
    expect(s.outcome).toMatch(/Q caught/);
    expect(currentParticipant(s)).toBeNull();
  });

  test('chase goes on while another pursuer has MvP', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60));
    addParticipant(s, person('P1', 'pursuer', 50, 2));
    addParticipant(s, person('P2', 'pursuer', 40));
    startChase(s);
    setLocation(s, 1, { check: DEX });
    roll(s, 10, 60);
    roll(s, 99, 50);
    takeLoss(s, 6);
    expect(s.outcome).toBeNull();
    expect(currentParticipant(s)?.id).toBe('P2');
  });

  test('Luck turns a failure into a success for the difference', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s);
    setLocation(s, 1, { check: DODGE });
    roll(s, 62, 45);
    expect(s.pending?.luckNeeded).toBe(17);
    expect(luckSuccess(s)).toBe(17);
    expect(s.participants[0]).toMatchObject({ mvp: 8, location: 2 });
  });

  test('a failed push puts the character out without losing MvP', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s);
    setLocation(s, 1, { check: CLIMB });
    roll(s, 70, 40);
    const was = beginPush(s);
    expect(was.canPush).toBe(true);
    expect(roll(s, 80, 40, { pushed: true })).toBe('out');
    expect(s.participants[0]?.status).toBe('caught');
    expect(s.participants[0]?.mvp).toBe(8);
  });

  test('characteristic rolls cannot be pushed', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s);
    setLocation(s, 1, { check: DEX });
    roll(s, 90, 60);
    expect(() => beginPush(s)).toThrow(/Only a skill roll/);
  });

  test('head start gives each pursuer one penalty die on the first challenge only', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s, { headStart: true });
    setLocation(s, 1, { check: DEX });
    roll(s, 10, 60);
    const p = currentParticipant(s);
    expect(p && challengeFor(s, p).bonusDice).toBe(-1);
    expect(p && challengeFor(s, p, { shooting: true, bonusDice: -1 }).bonusDice).toBe(-2);
    roll(s, 10, 50);
    setLocation(s, 2, { check: DEX });
    roll(s, 10, 60);
    const again = currentParticipant(s);
    expect(again && challengeFor(s, again).bonusDice).toBe(0);
  });

  test('helping an ally at 0 MvP: helper pays 1 MvP and takes a penalty die', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q1', 'quarry', 70, 2));
    addParticipant(s, person('Q2', 'quarry', 60));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s);
    setLocation(s, 1, { check: DEX });
    roll(s, 99, 70);
    takeLoss(s, 5);
    expect(s.participants[0]?.status).toBe('caught');
    helpAlly(s, 'Q2', 'Q1');
    expect(s.participants[0]).toMatchObject({ status: 'active', mvp: 1 });
    expect(s.participants[1]).toMatchObject({ mvp: 7, nextPenaltyDice: 1 });
    expect(currentParticipant(s)?.id).toBe('Q2');
  });

  test('major wound mid-chase halves current MvP', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60, 7));
    addParticipant(s, person('P', 'pursuer', 50));
    startChase(s);
    expect(majorWound(s, 'Q')).toEqual({ before: 7, after: 3 });
  });

  test('skipping and removing keep the turn order right', () => {
    const s = createChase({ id: 'c' });
    addParticipant(s, person('Q', 'quarry', 60));
    addParticipant(s, person('P1', 'pursuer', 50));
    addParticipant(s, person('P2', 'pursuer', 40));
    startChase(s);
    skipTurn(s);
    expect(currentParticipant(s)?.id).toBe('P1');
    removeParticipant(s, 'P1');
    expect(currentParticipant(s)?.id).toBe('P2');
    adjustParticipant(s, 'P2', { status: 'out' });
    expect(s.outcome).toMatch(/Q escaped/);
  });

  test('monsters without the skill use DEX by tier', () => {
    expect(tierValue(65, 'skilled')).toBe(65);
    expect(tierValue(65, 'average')).toBe(32);
    expect(tierValue(65, 'poor')).toBe(13);
  });
});

test('restart keeps people and locations, and the Keeper can step a character back or forward', () => {
  const state = createChase({ id: 'c' });
  setLocation(state, 1, { check: DEX });
  setLocation(state, 2, { name: 'the wall', check: CLIMB, difficulty: 'hard' });
  addParticipant(state, person('q', 'quarry', 60, 8));
  addParticipant(state, person('p', 'pursuer', 50, 7));
  startChase(state, { headStart: true });
  roll(state, 10, 60); // q passes → Location 2
  roll(state, 99, 50); // p fails
  takeLoss(state, 7); // p drops out, q escapes
  expect(state.outcome).toMatch(/escaped/);

  // Mistake: step q back, then forward again.
  stepLocation(state, 'q', -1);
  expect(state.participants[0]?.location).toBe(1);
  expect(() => stepLocation(state, 'q', -1)).toThrow(/already in Location 1/);
  stepLocation(state, 'q', 1);
  expect(state.participants[0]?.location).toBe(2);

  resetChase(state, p => p.mov);
  expect(state.round).toBe(0);
  expect(state.outcome).toBeNull();
  expect(state.participants.map(p => [p.id, p.location, p.mvp, p.status, p.nextPenaltyDice])).toEqual([
    ['q', 1, 8, 'active', 0],
    ['p', 1, 7, 'active', 0]
  ]);
  expect(state.locations.find(l => l.index === 2)).toMatchObject({ name: 'the wall', difficulty: 'hard' });
  startChase(state);
  expect(currentParticipant(state)?.id).toBe('q');
});
