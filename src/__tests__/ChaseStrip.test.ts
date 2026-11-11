import { renderStrip } from '../ChaseStrip';
import { addParticipant, createChase, setLocation, startChase } from '../chaseState';

test('the strip shows only while a chase is running', () => {
  const state = createChase({ id: 'c', name: 'Bazaar' });
  addParticipant(state, { id: 'q', name: 'Q', actorId: 'q', actorUuid: 'A.q', side: 'quarry', dex: 60, mov: 8 });
  addParticipant(state, { id: 'p', name: 'P', actorId: 'p', actorUuid: 'A.p', side: 'pursuer', dex: 50, mov: 7 });
  expect(renderStrip(state)).toBe('');
  startChase(state);
  expect(renderStrip(state)).toContain('Bazaar');
  state.outcome = 'The chase is over.';
  expect(renderStrip(state)).toBe('');
});

test('players see only the locations their characters have reached; the Keeper sees all', () => {
  const state = createChase({ id: 'c', name: 'Bazaar' });
  addParticipant(state, { id: 'q', name: 'Q', actorId: 'q', actorUuid: 'A.q', side: 'quarry', dex: 60, mov: 8 });
  addParticipant(state, { id: 'p', name: 'P', actorId: 'p', actorUuid: 'A.p', side: 'pursuer', dex: 50, mov: 7 });
  setLocation(state, 2, { name: 'the rooftops', obstacle: 'a gap between roofs', check: { kind: 'skill', name: 'Jump' } });
  startChase(state);
  const player = renderStrip(state);
  expect(player).not.toContain('rooftops');
  expect(player).not.toContain('gap between');
  expect(player).not.toContain('Jump');
  const keeper = renderStrip(state, false, true);
  expect(keeper).toContain('rooftops');
  expect(keeper).toContain('a gap between roofs');
  state.reached = 2;
  expect(renderStrip(state)).toContain('a gap between roofs');
});
