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
  LIBRARY_SETTING,
  addToChase,
  getChaseView,
  handleCheckCard,
  handlePlayerChoice,
  loadChase,
  rollButtonLive,
  rollFromButton,
  rollMvpLoss,
  type RollFlag,
  mutateChase,
  resolveFailure,
  startNewChase,
  takeTurn,
  updateLocation,
  type PlayerChoice,
  type TakeTurnInput
} from './ChaseService';
import { openChaseTracker, refreshChaseTracker } from './ChaseTracker';
import { refreshStrip, setStripSource } from './ChaseStrip';
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

interface UserLike {
  id: string;
  isGM?: boolean;
  isSelf?: boolean;
}

interface Globals {
  game: {
    settings: { register(module: string, key: string, data: Record<string, unknown>): void };
    system?: { id?: string };
    user?: UserLike | null;
    users?: { get(id: string): UserLike | undefined; activeGM?: UserLike | null };
    modules: { get(id: string): { api?: Record<string, unknown> } | undefined };
    socket?: { on(name: string, fn: (data: unknown) => void): void; emit(name: string, data: unknown): void };
  };
  Hooks: { on(hook: string, fn: (...args: unknown[]) => unknown): number; once(hook: string, fn: (...args: unknown[]) => unknown): number };
  ui: { notifications?: { error(msg: string): void; warn(msg: string): void; info(msg: string): void } };
  fromUuidSync?(uuid: string): { isOwner?: boolean; name?: string } | null;
}

const g = (): Globals => globalThis as unknown as Globals;
const isCoc7 = (): boolean => g().game.system?.id === 'CoC7';
const SOCKET = `module.coc7-mvp-chase`;

/** Only one Keeper's client acts on player rolls and choices, even with two GMs logged in. */
function isActingGM(): boolean {
  const { game } = g();
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM;
  return active ? active.isSelf === true || active.id === game.user.id : true;
}

interface ChoiceFlag {
  chaseId: string;
  participantId: string;
  actorUuid: string;
  total: number;
}

/** The roll button on a chase roll request: only the character's owners and the Keeper see it. */
function wireRollCard(message: { flags?: Record<string, Record<string, unknown> | undefined> }, html: HTMLElement): void {
  const flag = message.flags?.[CHASE_MODULE_ID]?.['roll'] as RollFlag | undefined;
  const buttons = Array.from(html.querySelectorAll<HTMLButtonElement>('[data-mvpc-roll]'));
  if (!flag || !buttons.length) return;
  const actor = g().fromUuidSync?.(flag.actorUuid) ?? null;
  const mine = Boolean(g().game.user?.isGM) || actor?.isOwner === true;
  for (const button of buttons) {
    const index = parseInt(button.dataset['mvpcRoll'] ?? '0', 10) || 0;
    if (!mine) {
      button.style.display = 'none';
      continue;
    }
    if (!rollButtonLive(flag, index)) {
      button.disabled = true;
      button.title = 'This roll is no longer waiting';
      continue;
    }
    button.addEventListener('click', event => {
      event.preventDefault();
      buttons.forEach(b => (b.disabled = true));
      void rollFromButton(flag, index).catch((error: unknown) => {
        g().ui.notifications?.warn(error instanceof Error ? error.message : String(error));
        buttons.forEach(b => (b.disabled = false));
      });
    });
  }
}

/** The buttons on a player's failure card: roll their own 1D6, spend Luck or push. */
function wireChoiceCard(message: { flags?: Record<string, Record<string, unknown> | undefined> }, html: HTMLElement): void {
  const flag = message.flags?.[CHASE_MODULE_ID]?.['choice'] as ChoiceFlag | undefined;
  if (!flag) return;
  const buttons = Array.from(html.querySelectorAll<HTMLButtonElement>('[data-mvpc-choice]'));
  if (!buttons.length) return;
  const { game } = g();
  const actor = g().fromUuidSync?.(flag.actorUuid) ?? null;
  const mine = Boolean(game.user?.isGM) || actor?.isOwner === true;
  const state = loadChase();
  const live = state?.id === flag.chaseId && state.pending?.participantId === flag.participantId && state.pending.total === flag.total;
  for (const button of buttons) {
    if (!mine) {
      button.style.display = 'none';
      continue;
    }
    button.disabled = !live;
    button.addEventListener('click', event => {
      event.preventDefault();
      buttons.forEach(b => (b.disabled = true));
      void choose(flag, button.dataset['mvpcChoice'] as PlayerChoice['action']).catch((error: unknown) => {
        g().ui.notifications?.error(error instanceof Error ? error.message : String(error));
        buttons.forEach(b => (b.disabled = false));
      });
    });
  }
}

async function choose(flag: ChoiceFlag, action: PlayerChoice['action']): Promise<void> {
  const { game } = g();
  const user = game.user;
  if (!user) return;
  const choice: PlayerChoice = { chaseId: flag.chaseId, participantId: flag.participantId, userId: user.id, action };
  if (action === 'take-loss') {
    const actor = g().fromUuidSync?.(flag.actorUuid) ?? null;
    choice.loss = await rollMvpLoss(actor?.name ?? 'Chase', loadChase()?.name ?? 'Chase');
  }
  if (user.isGM) {
    await handlePlayerChoice(choice, user);
    return;
  }
  if (!game.socket) throw new Error('Cannot reach the Keeper.');
  game.socket.emit(SOCKET, { type: 'choice', choice });
  g().ui.notifications?.info('Sent to the Keeper.');
}

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
      if (isCoc7()) refreshStrip(loadChase());
    }
  });

  g().game.settings.register(CHASE_MODULE_ID, LIBRARY_SETTING, {
    name: 'Saved MvP chases',
    scope: 'world',
    config: false,
    type: Object,
    default: {},
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
    if (!isCoc7() || !isActingGM()) return;
    void handleCheckCard(args[0] as Coc7ChatMessage).catch((error: unknown) => {
      console.warn('MvP Chase | Could not use the chase roll:', error);
    });
  };
  g().Hooks.on('createChatMessage', onCard);
  g().Hooks.on('updateChatMessage', onCard);

  g().Hooks.on('renderChatMessageHTML', (...args: unknown[]) => {
    if (!isCoc7() || !(args[1] instanceof HTMLElement)) return;
    try {
      wireChoiceCard(args[0] as Parameters<typeof wireChoiceCard>[0], args[1]);
      wireRollCard(args[0] as Parameters<typeof wireRollCard>[0], args[1]);
    } catch (error) {
      console.warn('MvP Chase | Could not set up the chase card:', error);
    }
  });
});

g().Hooks.once('ready', () => {
  if (isCoc7()) {
    setStripSource(loadChase);
    refreshStrip(loadChase());
  }

  g().game.socket?.on(SOCKET, (data: unknown) => {
    const message = data as { type?: string; choice?: PlayerChoice } | null;
    if (message?.type !== 'choice' || !message.choice || !isActingGM()) return;
    const user = g().game.users?.get(message.choice.userId);
    if (!user) return;
    void handlePlayerChoice(message.choice, user).catch((error: unknown) => {
      g().ui.notifications?.warn(`MvP Chase: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

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
