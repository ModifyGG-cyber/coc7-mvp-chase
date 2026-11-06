import { parseChallenge, renderTracker } from '../ChaseTracker';
import { addParticipant, createChase, setLocation, startChase } from '../chaseState';

describe('chase tracker', () => {
  test('reads what the Keeper types as a check', () => {
    expect(parseChallenge('Climb')).toEqual({ kind: 'skill', name: 'Climb' });
    expect(parseChallenge('dex')).toEqual({ kind: 'characteristic', name: 'dex' });
    expect(parseChallenge('Luck')).toEqual({ kind: 'attribute', name: 'lck' });
    expect(parseChallenge('  ')).toBeNull();
  });

  test('renders the current turn and escapes names', () => {
    const s = createChase({ id: 'c', name: 'Bazaar <b>' });
    addParticipant(s, { id: 'q', name: 'Julian & co', actorId: 'q', actorUuid: 'Actor.q', side: 'quarry', dex: 60, mov: 8 });
    addParticipant(s, { id: 'p', name: 'Thug', actorId: 'p', actorUuid: 'Actor.p', side: 'pursuer', dex: 55, mov: 8 });
    startChase(s);
    setLocation(s, 1, { check: { kind: 'skill', name: 'Dodge' } });
    const gm = renderTracker(s, true);
    expect(gm).toContain('Julian &amp; co');
    expect(gm).toContain('Bazaar &lt;b&gt;');
    expect(gm).toContain('data-chase="roll"');
    const player = renderTracker(s, false);
    expect(player).not.toContain('data-chase="roll"');
    expect(player).toContain('Dodge');
  });
});

test('the Keeper gets an Add location button and sees every planned location', () => {
  const s = createChase({ id: 'c' });
  setLocation(s, 4, { name: 'the docks', check: { kind: 'skill', name: 'Swim' } });
  const html = renderTracker(s, true);
  expect(html).toContain('data-chase="add-location"');
  expect(html).toContain('the docks');
  expect(renderTracker(s, false)).not.toContain('data-chase="add-location"');
});
