import { renderStrip } from '../ChaseStrip';
import { addParticipant, createChase, startChase } from '../chaseState';

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
