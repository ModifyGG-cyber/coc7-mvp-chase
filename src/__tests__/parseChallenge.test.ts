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
