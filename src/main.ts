/**
 * MvP Chase for Call of Cthulhu 7e: the Keeper Companion's "New Chase Rules" in Foundry.
 *
 * Adds a Chase button to the token controls, keeps the chase in a world setting so every client
 * sees it, resolves player rolls made from the chase's roll buttons, and exposes a macro API:
 *   const chase = game.modules.get('coc7-mvp-chase').api;
 *   chase.open();                       // tracker window
 *   await chase.start({ quarry: [{ tokenId }], pursuers: [{ tokenId }] });
 *   await chase.takeTurn({ mode: 'roll' });
 */

import type { Coc7ChaseActorRef, Coc7ChaseCheckRef, Coc7ChaseTurnResult, Coc7ChaseView, Coc7Difficulty } from './types';
import type { Coc7ChatMessage } from './coc7';
import {
  CHASE_MODULE_ID,
  CHASE_SETTING,
  addToChase,
  getChaseView,
  handleCheckCard,
  mutateChase,
  resolveFailure,
  startNewChase,
  takeTurn,
  updateLocation,
  type TakeTurnInput
} from './ChaseService';
import { openChaseTracker, refreshChaseTracker } from './ChaseTracker';
import {
  adjustParticipant,
  endChase,
  findParticipant,
  helpAlly,
  majorWound,
  removeParticipant,
  skipTurn,
  type ChaseSide,
  type ChaseStatus
} from './chaseState';

interface Globals {
  game: {
    settings: { register(module: string, key: string, data: Record<string, unknown>): void };
    system?: { id?: string };
    user?: { isGM?: boolean } | null;
    modules: { get(id: string): { api?: Record<string, unknown> } | undefined };
  };
  Hooks: { on(hook: string, fn: (...args: unknown[]) => unknown): number; once(hook: string, fn: (...args: unknown[]) => unknown): number };
}

const g = (): Globals => globalThis as unknown as Globals;
const isCoc7 = (): boolean => g().game.system?.id === 'CoC7';

export interface ChaseActInput {
  action: 'skip' | 'help' | 'major-wound' | 'adjust' | 'remove' | 'end';
  participant?: string;
  ally?: string;
  mvp?: number;
  location?: number;
  status?: ChaseStatus;
  side?: ChaseSide;
  reason?: string;
}

/** Keeper actions outside a normal turn. */
export function act(input: ChaseActInput): ReturnType<typeof mutateChase> {
  const need = (key: 'participant' | 'ally'): string => {
    const value = input[key];
    if (!value) throw new Error(`${input.action} needs ${key}`);
    return value;
  };
  return mutateChase(state => {
    switch (input.action) {
      case 'skip': {
        const id = state.order[state.turn];
        const name = id ? findParticipant(state, id).name : '';
        skipTurn(state, input.reason);
        return `${name} does not move${input.reason ? `: ${input.reason}` : ''}.`;
      }
      case 'help': {
        const helper = findParticipant(state, need('participant'));
        const ally = findParticipant(state, need('ally'));
        helpAlly(state, helper.id, ally.id);
        return `${helper.name} helps ${ally.name}, who stays in the chase with 1 MvP. ${helper.name} pays 1 MvP and takes a penalty die on their next challenge.`;
      }
      case 'major-wound': {
        const p = findParticipant(state, need('participant'));
        const { before, after } = majorWound(state, p.id);
        return `${p.name} takes a major wound: MvP ${String(before)} → ${String(after)}.`;
      }
      case 'adjust': {
        const p = findParticipant(state, need('participant'));
        adjustParticipant(state, p.id, {
          ...(input.mvp !== undefined ? { mvp: input.mvp } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.side !== undefined ? { side: input.side } : {})
        });
        return `Keeper adjusts ${p.name}.`;
      }
      case 'remove': {
        const p = findParticipant(state, need('participant'));
        removeParticipant(state, p.id);
        return `${p.name} leaves the chase.`;
      }
      case 'end':
        endChase(state, input.reason);
        return state.outcome ?? 'The chase is over.';
      default:
        throw new Error('action must be skip, help, major-wound, adjust, remove or end');
    }
  });
}

g().Hooks.once('init', () => {
  g().game.settings.register(CHASE_MODULE_ID, CHASE_SETTING, {
    name: 'MvP chase',
    scope: 'world',
    config: false,
    type: Object,
    default: null,
    onChange: (): void => {
      refreshChaseTracker();
    }
  });

  g().Hooks.on('getSceneControlButtons', (controls: unknown) => {
    if (!isCoc7()) return;
    const tool = {
      name: 'mvp-chase',
      title: 'Chase (MvP rules)',
      icon: 'fa-solid fa-person-running',
      button: true,
      visible: true,
      order: 50,
      onClick: (): void => {
        openChaseTracker();
      },
      onChange: (): void => {
        openChaseTracker();
      }
    };
    try {
      if (Array.isArray(controls)) {
        const tokens = controls.find((c: { name?: string }) => c.name === 'token') as { tools?: unknown[] } | undefined;
        tokens?.tools?.push(tool);
      } else if (controls && typeof controls === 'object') {
        const tokens = (controls as Record<string, { tools?: Record<string, unknown> }>)['tokens'];
        if (tokens?.tools) tokens.tools['mvp-chase'] = tool;
      }
    } catch (error) {
      console.warn('MvP Chase | Could not add the chase button:', error);
    }
  });

  const onCard = (...args: unknown[]): void => {
    if (!isCoc7() || !g().game.user?.isGM) return;
    void handleCheckCard(args[0] as Coc7ChatMessage).catch((error: unknown) => {
      console.warn('MvP Chase | Could not use the chase roll:', error);
    });
  };
  g().Hooks.on('createChatMessage', onCard);
  g().Hooks.on('updateChatMessage', onCard);
});

g().Hooks.once('ready', () => {
  const mod = g().game.modules.get(CHASE_MODULE_ID);
  if (!mod) return;
  mod.api = {
    open: openChaseTracker,
    get: getChaseView,
    start: startNewChase,
    add: (ref: Coc7ChaseActorRef & { side: ChaseSide }): Promise<Coc7ChaseView> => addToChase(ref, ref.side),
    setLocation: (input: { index: number; name?: string; check?: Coc7ChaseCheckRef | null; difficulty?: Coc7Difficulty }): Promise<Coc7ChaseView> =>
      updateLocation(input.index, input),
    takeTurn: (input: TakeTurnInput = {}): Promise<Coc7ChaseTurnResult> => takeTurn(input),
    resolve: (action: 'take-loss' | 'luck' | 'push', loss?: number): Promise<Coc7ChaseTurnResult> => resolveFailure(action, loss),
    act
  };
});
