/**
 * The chase service against a fake Foundry: settings store, CoC7 actors whose checks post cards, chat and dice.
 */
import { getChaseView, handleCheckCard, resolveFailure, startNewChase, takeTurn, updateLocation } from '../ChaseService';

type Hook = (...args: unknown[]) => void;

interface FakeActor {
  id: string;
  uuid: string;
  name: string;
  type: string;
  statuses: Set<string>;
  system: Record<string, unknown>;
  items: { filter(fn: (i: { type: string; name: string; system: { value: number } }) => boolean): unknown[] };
  spendLuck: jest.Mock;
  skillCheck: jest.Mock;
  characteristicCheck: jest.Mock;
  attributeCheck: jest.Mock;
}

let store: Record<string, unknown>;
let hooks: Record<string, Map<number, Hook>>;
let nextRolls: number[];
let chat: { content?: string; flavor?: string }[];
let actors: Map<string, FakeActor>;

function rollQueue(n: number): number {
  const v = nextRolls.shift();
  if (v === undefined) throw new Error(`no fake roll left for d${String(n)}`);
  return v;
}

function makeActor(id: string, opts: { dex: number; mov: number; luck?: number; skills?: Record<string, number>; wounded?: boolean }): FakeActor {
  const skills = Object.entries(opts.skills ?? {}).map(([name, value]) => ({ type: 'skill', name, system: { value } }));
  const actor: FakeActor = {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: 'character',
    statuses: new Set(opts.wounded ? ['criticalWounds'] : []),
    system: {
      characteristics: { dex: { value: opts.dex }, con: { value: 50 } },
      attribs: { mov: { value: opts.mov }, lck: { value: opts.luck ?? 50 } }
    },
    items: { filter: fn => skills.filter(fn) },
    spendLuck: jest.fn((n: number) => {
      const lck = (actor.system['attribs'] as Record<string, { value: number }>)['lck'];
      if (!lck || lck.value < n) return Promise.resolve(false);
      lck.value -= n;
      return Promise.resolve(actor);
    }),
    skillCheck: jest.fn(),
    characteristicCheck: jest.fn(),
    attributeCheck: jest.fn()
  };
  const check = (threshold: () => number) => (_name: string, _ff: boolean, options: { difficulty?: string; poolModifier?: number }) => {
    const total = rollQueue(100);
    const difficulty = { '0': 1, '+': 2, '++': 3 }[options.difficulty ?? '0'] ?? 1;
    const message = {
      id: `msg${String(chat.length)}`,
      flags: {
        CoC7: {
          load: {
            as: 'CoC7Check',
            actorUuid: actor.uuid,
            dicePool: {
              threshold: threshold(),
              difficulty,
              currentPoolModifier: options.poolModifier ?? 0,
              rolledDice: [{ rolled: true, baseDie: Math.floor(total / 10) === 0 ? 10 : Math.floor(total / 10), unitDie: total % 10 === 0 ? 10 : total % 10, bonusDice: [], penaltyDice: [] }]
            }
          }
        }
      }
    };
    for (const fn of hooks['createChatMessage']?.values() ?? []) fn(message);
    return Promise.resolve();
  };
  actor.skillCheck.mockImplementation((name: string, ff: boolean, o: object) => check(() => skills.find(s => s.name === name)?.system.value ?? 0)(name, ff, o));
  actor.characteristicCheck.mockImplementation((name: string, ff: boolean, o: object) =>
    check(() => (actor.system['characteristics'] as Record<string, { value: number }>)[name]?.value ?? 0)(name, ff, o)
  );
  return actor;
}

beforeEach(() => {
  store = {};
  hooks = {};
  nextRolls = [];
  chat = [];
  actors = new Map();
  let hookId = 0;
  Object.assign(globalThis, {
    game: {
      system: { id: 'CoC7' },
      user: { isGM: true },
      settings: {
        get: (_m: string, k: string) => store[k] ?? null,
        set: (_m: string, k: string, v: unknown) => {
          store[k] = v === null ? null : JSON.parse(JSON.stringify(v));
          return Promise.resolve(v);
        }
      },
      actors: { get: (id: string) => actors.get(id) },
      scenes: { get: () => undefined, active: null }
    },
    Hooks: {
      on: (name: string, fn: Hook) => {
        (hooks[name] ??= new Map()).set(++hookId, fn);
        return hookId;
      },
      off: (name: string, id: number) => hooks[name]?.delete(id)
    },
    ChatMessage: {
      create: (data: { content?: string }) => {
        chat.push(data);
        return Promise.resolve({ id: `chat${String(chat.length)}` });
      },
      getWhisperRecipients: () => [{ id: 'gm' }]
    },
    Roll: class {
      constructor(private formula: string) {}
      evaluate() {
        const total = rollQueue(this.formula === '1d6' ? 6 : 10);
        return Promise.resolve({ total, toMessage: (d: { flavor?: string }) => Promise.resolve(chat.push({ flavor: `${d.flavor ?? ''}: ${String(total)}` })) });
      }
    }
  });
});

test('a full chase: roll, fail, 1D6 loss, Luck, and the quarry escapes', async () => {
  actors.set('julian', makeActor('julian', { dex: 60, mov: 8, luck: 40, skills: { Dodge: 45, Climb: 40 } }));
  actors.set('thug', makeActor('thug', { dex: 55, mov: 7, wounded: true, skills: { Dodge: 40 } }));

  const view = await startNewChase({
    name: 'Bazaar',
    firstLocation: 'spice alley',
    firstCheck: { kind: 'characteristic', name: 'dex' },
    quarry: [{ actorId: 'julian' }],
    pursuers: [{ actorId: 'thug' }]
  });
  expect(view.participants?.map(p => [p.name, p.mvp])).toEqual([
    ['julian', 8],
    ['thug', 3]
  ]);
  expect(view.current).toBe('julian');

  nextRolls = [34];
  const t1 = await takeTurn({});
  expect(t1.roll).toMatchObject({ total: 34, target: 60, passed: true });

  nextRolls = [71];
  const t2 = await takeTurn({});
  expect(t2.pending).toMatchObject({ participant: 'thug', luckNeeded: 16 });
  nextRolls = [2];
  const loss = await resolveFailure('take-loss');
  expect(loss.loss).toBe(2);
  expect(loss.participants?.find(p => p.name === 'thug')).toMatchObject({ mvp: 1, location: 2 });
  expect(loss.round).toBe(2);

  await updateLocation(2, { name: 'crowded square', check: { kind: 'skill', name: 'Dodge' } });
  nextRolls = [62];
  await takeTurn({});
  const lucky = await resolveFailure('luck');
  expect(lucky.result).toMatch(/spent 17 Luck/);
  expect(actors.get('julian')?.spendLuck).toHaveBeenCalledWith(17);

  nextRolls = [90];
  await takeTurn({});
  nextRolls = [4];
  const end = await resolveFailure('take-loss');
  expect(end.outcome).toMatch(/julian escaped/);
  expect(end.active).toBe(false);
  expect(chat.some(c => c.content?.includes('escaped'))).toBe(true);
});

test('a missing skill falls back to DEX by tier, and a player roll card resolves the turn', async () => {
  actors.set('q', makeActor('q', { dex: 60, mov: 8, skills: { Swim: 50 } }));
  actors.set('ghoul', makeActor('ghoul', { dex: 65, mov: 9 }));
  await startNewChase({
    quarry: [{ actorId: 'q' }],
    pursuers: [{ actorId: 'ghoul', skillTier: 'poor' }],
    firstCheck: { kind: 'skill', name: 'Swim' }
  });

  // The player rolls from the posted button; the CoC7 card resolves the turn.
  const asked = await takeTurn({ mode: 'request' });
  expect(asked.awaiting).toMatchObject({ participant: 'q' });
  expect(chat.at(-1)?.content).toContain('@coc7.check[subtype:skill,name:Swim]');
  const card = {
    id: 'm1',
    flags: { CoC7: { load: { as: 'CoC7Check', actorUuid: 'Actor.q', dicePool: { threshold: 50, difficulty: 1, currentPoolModifier: 0, rolledDice: [{ rolled: true, baseDie: 2, unitDie: 5, bonusDice: [], penaltyDice: [] }] } } } }
  };
  expect(await handleCheckCard(card)).toBe(true);
  expect(getChaseView().participants?.find(p => p.name === 'q')?.location).toBe(2);

  // Ghoul has no Swim: poor = DEX/5 = 13. Unit 3, tens 1 → 13: success.
  nextRolls = [3, 1];
  const g = await takeTurn({});
  expect(g.roll).toMatchObject({ total: 13, target: 13, passed: true });
  expect(chat.at(-2)?.content ?? chat.at(-1)?.content).toMatch(/lacks the skill/);
});
