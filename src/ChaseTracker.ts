/**
 * The Keeper's chase tracker window (players get a read-only view). Built on Foundry's ApplicationV2
 * at runtime, so this file only touches Foundry globals when the window is opened.
 */

import type { Coc7ChaseCheckRef, Coc7Difficulty } from './types';
import {
  addToChase,
  beginChase,
  clearChase,
  escapeHtml,
  loadChase,
  mutateChase,
  resolveFailure,
  startNewChase,
  takeTurn,
  updateLocation
} from './ChaseService';
import {
  adjustParticipant,
  checkLabel,
  currentParticipant,
  endChase,
  helpAlly,
  locationLabel,
  majorWound,
  removeParticipant,
  skipTurn,
  type ChaseCheck,
  type ChaseState
} from './chaseState';

const CHARACTERISTIC_NAMES = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];
const SUGGESTIONS = ['Climb', 'Jump', 'Dodge', 'Swim', 'Stealth', 'Spot Hidden', 'Drive Auto', 'Ride', 'Pilot', 'Persuade', 'Throw', ...CHARACTERISTIC_NAMES, 'Luck'];
const DIFFICULTIES: Coc7Difficulty[] = ['regular', 'hard', 'extreme'];

interface AppV2Instance {
  element: HTMLElement;
  rendered: boolean;
  render(options?: { force?: boolean }): Promise<unknown>;
  bringToFront?(): void;
  close(): Promise<unknown>;
}

type AppV2Class = new (options?: Record<string, unknown>) => AppV2Instance;

interface TrackerGlobals {
  foundry: { applications: { api: { ApplicationV2: AppV2Class } } };
  game: { user?: { isGM?: boolean } | null; i18n?: unknown };
  canvas?: { scene?: { id: string } | null; tokens?: { controlled: { id: string; document?: { id: string } }[] } };
  ui: { notifications?: { error(msg: string): void; warn(msg: string): void; info(msg: string): void } };
}

const g = (): TrackerGlobals => globalThis as unknown as TrackerGlobals;

/** Turns what the Keeper typed ("Climb", "DEX", "Luck") into a check. */
export function parseChallenge(text: string): Coc7ChaseCheckRef | null {
  const value = text.trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (CHARACTERISTIC_NAMES.includes(upper)) return { kind: 'characteristic', name: value.toLowerCase() };
  if (upper === 'LUCK' || upper === 'LCK') return { kind: 'attribute', name: 'lck' };
  return { kind: 'skill', name: value };
}

function challengeText(check: ChaseCheck | null): string {
  if (!check) return '';
  if (check.kind === 'attribute') return 'Luck';
  return check.kind === 'characteristic' ? check.name.toUpperCase() : check.name;
}

let TrackerClass: AppV2Class | null = null;
let instance: AppV2Instance | null = null;

function trackerClass(): AppV2Class {
  if (TrackerClass) return TrackerClass;
  const Base = g().foundry.applications.api.ApplicationV2;

  class ChaseTracker extends Base {
    static DEFAULT_OPTIONS = {
      id: 'mvp-chase-tracker',
      classes: ['mvpc-chase'],
      tag: 'div',
      window: { title: 'Chase (MvP rules)', icon: 'fa-solid fa-person-running', resizable: true },
      position: { width: 620, height: 'auto' }
    };

    private busy = false;
    private listening = false;

    _renderHTML(): Promise<string> {
      return Promise.resolve(renderTracker(loadChase(), Boolean(g().game.user?.isGM)));
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
      if (!this.listening) {
        this.listening = true;
        content.addEventListener('click', event => void this.onClick(event));
        content.addEventListener('change', event => void this.onChange(event));
      }
    }

    private async run(work: () => Promise<unknown>): Promise<void> {
      if (this.busy) return;
      this.busy = true;
      this.element.classList.add('mvpc-busy');
      try {
        await work();
      } catch (error) {
        g().ui.notifications?.error(error instanceof Error ? error.message : String(error));
      } finally {
        this.busy = false;
        this.element.classList.remove('mvpc-busy');
        void this.render();
      }
    }

    private field(name: string): HTMLInputElement | HTMLSelectElement | null {
      return this.element.querySelector(`[name="${name}"]`);
    }

    private async onClick(event: Event): Promise<void> {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-chase]');
      if (!target || !g().game.user?.isGM) return;
      event.preventDefault();
      const action = target.dataset['chase'];
      const pid = target.closest<HTMLElement>('[data-pid]')?.dataset['pid'];
      const value = (name: string): string => this.field(name)?.value ?? '';
      const checked = (name: string): boolean => (this.field(name) as HTMLInputElement | null)?.checked ?? false;

      switch (action) {
        case 'new':
          return this.run(() =>
            startNewChase({ name: value('chaseName') || 'Chase', firstLocation: value('firstLocation'), quarry: [], pursuers: [], setupOnly: true, replace: true })
          );
        case 'add-quarry':
        case 'add-pursuer':
          return this.run(async () => {
            const tokens = g().canvas?.tokens?.controlled ?? [];
            const sceneId = g().canvas?.scene?.id;
            if (tokens.length === 0) throw new Error('Select one or more tokens on the canvas first.');
            for (const token of tokens) {
              await addToChase({ tokenId: token.document?.id ?? token.id, ...(sceneId ? { sceneId } : {}) }, action === 'add-quarry' ? 'quarry' : 'pursuer');
            }
          });
        case 'add-location':
          return this.run(() => {
            const state = loadChase();
            const next = Math.max(0, ...(state?.locations.map(l => l.index) ?? [])) + 1;
            return updateLocation(next, {});
          });
        case 'start':
          return this.run(() => beginChase(checked('headStart')));
        case 'roll':
        case 'request':
        case 'pass':
        case 'fail': {
          const use = parseChallenge(value('useInstead'));
          const bonus = parseInt(value('bonusDice') || '0', 10);
          return this.run(() =>
            takeTurn({
              mode: action,
              bonusDice: bonus,
              shooting: checked('shooting'),
              ...(use ? { check: use } : {})
            })
          );
        }
        case 'take-loss':
        case 'luck':
        case 'push':
          return this.run(() => resolveFailure(action));
        case 'skip':
          return this.run(() =>
            mutateChase(state => {
              const p = currentParticipant(state);
              skipTurn(state);
              return `${p?.name ?? 'Someone'} does not move this turn.`;
            })
          );
        case 'wound':
          if (!pid) return;
          return this.run(() =>
            mutateChase(state => {
              const { before, after } = majorWound(state, pid);
              return `${state.participants.find(p => p.id === pid)?.name ?? ''} takes a major wound: MvP ${String(before)} → ${String(after)}.`;
            })
          );
        case 'remove':
          if (!pid) return;
          return this.run(() =>
            mutateChase(state => {
              const name = state.participants.find(p => p.id === pid)?.name ?? '';
              removeParticipant(state, pid);
              return state.round > 0 ? `${name} leaves the chase.` : undefined;
            })
          );
        case 'help': {
          if (!pid) return;
          const helper = value(`helper-${pid}`);
          if (!helper) {
            g().ui.notifications?.warn('Pick who helps first.');
            return;
          }
          return this.run(() =>
            mutateChase(state => {
              helpAlly(state, helper, pid);
              const name = (id: string): string => state.participants.find(p => p.id === id)?.name ?? '';
              return `${name(helper)} helps ${name(pid)}, who stays in the chase with 1 MvP. ${name(helper)} pays 1 MvP and takes a penalty die on their next challenge.`;
            })
          );
        }
        case 'end':
          return this.run(() =>
            mutateChase(state => {
              endChase(state, value('endText') || 'The Keeper ended the chase.');
              return state.outcome ?? undefined;
            })
          );
        case 'clear':
          return this.run(() => clearChase());
        default:
          return;
      }
    }

    private async onChange(event: Event): Promise<void> {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (!g().game.user?.isGM) return;
      const loc = input.dataset['loc'];
      if (loc) {
        const index = parseInt(loc, 10);
        const kind = input.dataset['field'];
        if (kind === 'name') return this.run(() => updateLocation(index, { name: input.value }));
        if (kind === 'check') return this.run(() => updateLocation(index, { check: parseChallenge(input.value) }));
        if (kind === 'difficulty') return this.run(() => updateLocation(index, { difficulty: input.value as Coc7Difficulty }));
      }
      const pid = input.closest<HTMLElement>('[data-pid]')?.dataset['pid'];
      if (pid && input.dataset['field'] === 'mvp') {
        const mvp = parseInt(input.value, 10);
        if (Number.isFinite(mvp)) return this.run(() => mutateChase(state => {
          adjustParticipant(state, pid, { mvp });
          return undefined;
        }));
      }
      if (pid && input.dataset['field'] === 'location') {
        const location = parseInt(input.value, 10);
        if (Number.isFinite(location)) return this.run(() => mutateChase(state => {
          adjustParticipant(state, pid, { location });
          return undefined;
        }));
      }
      if (pid && input.dataset['field'] === 'side') {
        return this.run(() => mutateChase(state => {
          adjustParticipant(state, pid, { side: input.value as 'quarry' | 'pursuer' });
          return undefined;
        }));
      }
      return;
    }
  }

  TrackerClass = ChaseTracker;
  return TrackerClass;
}

export function openChaseTracker(): void {
  try {
    if (!instance) instance = new (trackerClass())();
    void instance.render({ force: true });
    instance.bringToFront?.();
  } catch (error) {
    console.warn('MvP Chase | Could not open the chase tracker:', error);
  }
}

/** Called when the chase setting changes on any client. */
export function refreshChaseTracker(): void {
  if (instance?.rendered) void instance.render();
}

// ---------- HTML ----------

const STYLE = `<style>
.mvpc-chase .window-content{padding:8px}
.mvpc-chase.mvpc-busy .window-content{opacity:.6;pointer-events:none}
.mvpc-chase h3{margin:6px 0 4px;font-size:1.05em;border-bottom:1px solid var(--color-border-light-2,#7a7971);}
.mvpc-chase table{width:100%;border-collapse:collapse;margin:0 0 6px}
.mvpc-chase th,.mvpc-chase td{padding:2px 4px;text-align:left;vertical-align:middle}
.mvpc-chase tr.mvpc-now{background:rgba(255,200,0,.18);font-weight:bold}
.mvpc-chase tr.mvpc-gone{opacity:.55}
.mvpc-chase input[type=number]{width:3.6em}
.mvpc-chase .mvpc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0}
.mvpc-chase .mvpc-row label{display:flex;gap:4px;align-items:center}
.mvpc-chase button{flex:0 0 auto;width:auto;padding:0 8px;line-height:24px}
.mvpc-chase .mvpc-turn{border:1px solid var(--color-border-light-2,#7a7971);border-radius:4px;padding:6px;margin:6px 0}
.mvpc-chase .mvpc-outcome{font-weight:bold;font-size:1.1em;margin:6px 0}
.mvpc-chase .mvpc-log{max-height:9em;overflow:auto;font-size:.9em;margin:0;padding-left:1.2em}
.mvpc-chase .mvpc-hint{font-size:.85em;opacity:.8}
.mvpc-chase .mvpc-pill{font-size:.8em;padding:0 5px;border-radius:8px;border:1px solid currentColor;opacity:.85}
</style>`;

const esc = escapeHtml;

function options(values: string[], selected: string, labels?: Record<string, string>): string {
  return values.map(v => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(labels?.[v] ?? v)}</option>`).join('');
}

export function renderTracker(state: ChaseState | null, isGM: boolean): string {
  const datalist = `<datalist id="mvpc-chase-checks">${SUGGESTIONS.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>`;
  if (!state) {
    if (!isGM) return `${STYLE}<p>No chase is running.</p>`;
    return `${STYLE}
      <p>Run a chase with the Keeper Companion's MvP rules. Everyone starts in Location 1 with MvP equal to MOV.</p>
      <div class="mvpc-row"><label>Chase <input name="chaseName" type="text" placeholder="Cairo bazaar"></label>
      <label>Location 1 <input name="firstLocation" type="text" placeholder="the spice alley"></label></div>
      <div class="mvpc-row"><button type="button" data-chase="new"><i class="fa-solid fa-plus"></i> New chase</button></div>`;
  }

  const current = currentParticipant(state);
  const name = (id: string): string => state.participants.find(p => p.id === id)?.name ?? id;
  const parts: string[] = [STYLE, datalist];
  parts.push(`<div class="mvpc-row"><b>${esc(state.name)}</b>${state.round > 0 ? `<span class="mvpc-pill">Round ${String(state.round)}</span>` : '<span class="mvpc-pill">Setting up</span>'}</div>`);
  if (state.outcome) parts.push(`<p class="mvpc-outcome">${esc(state.outcome)}</p>`);

  // Participants
  const rows = state.participants
    .map(p => {
      const cls = p.id === current?.id ? 'mvpc-now' : p.status !== 'active' ? 'mvpc-gone' : '';
      const mvp = isGM ? `<input type="number" min="0" value="${String(p.mvp)}" data-field="mvp">` : String(p.mvp);
      const loc = isGM ? `<input type="number" min="1" value="${String(p.location)}" data-field="location">` : String(p.location);
      const side = isGM && state.round === 0 ? `<select data-field="side">${options(['quarry', 'pursuer'], p.side)}</select>` : p.side;
      let actions = '';
      if (isGM) {
        const helpers = state.participants.filter(h => h.side === p.side && h.status === 'active' && h.id !== p.id && h.mvp >= 2);
        const help =
          (p.status === 'caught' || p.status === 'out') && helpers.length && !state.outcome
            ? `<select name="helper-${esc(p.id)}"><option value="">helped by…</option>${helpers.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('')}</select><button type="button" data-chase="help" title="Helper pays 1 MvP and takes a penalty die">Help</button>`
            : '';
        actions = `${help}<button type="button" data-chase="wound" title="Major wound: halve MvP"><i class="fa-solid fa-droplet"></i></button><button type="button" data-chase="remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
      }
      const penalty = p.nextPenaltyDice ? ` <span class="mvpc-pill" title="Penalty dice on next challenge">-${String(p.nextPenaltyDice)}</span>` : '';
      return `<tr class="${cls}" data-pid="${esc(p.id)}"><td>${esc(p.name)}${penalty}</td><td>${side}</td><td>${String(p.dex)}</td><td>${loc}</td><td>${mvp} / ${String(p.mov)}</td><td>${esc(p.status)}</td><td>${actions}</td></tr>`;
    })
    .join('');
  parts.push(`<h3>Participants</h3><table><thead><tr><th>Name</th><th>Side</th><th>DEX</th><th>Loc</th><th>MvP</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">Nobody yet.</td></tr>'}</tbody></table>`);

  if (isGM && state.round === 0) {
    parts.push(`<div class="mvpc-row"><button type="button" data-chase="add-quarry"><i class="fa-solid fa-person-running"></i> Add selected as quarry</button>
      <button type="button" data-chase="add-pursuer"><i class="fa-solid fa-person-walking-arrow-right"></i> Add selected as pursuers</button></div>
      <div class="mvpc-row"><label><input type="checkbox" name="headStart"> Quarry has a clear head start (pursuers take a penalty die on their first challenge)</label></div>
      <div class="mvpc-row"><button type="button" data-chase="start"><i class="fa-solid fa-flag-checkered"></i> Start chase</button></div>
      <p class="mvpc-hint">Order each round: quarry first, then pursuers, highest DEX first. MvP = MOV, halved for a major wound.</p>`);
  }

  // Locations
  const locs = state.locations;
  const occupants = (index: number): string =>
    state.participants
      .filter(p => p.location === index && p.status === 'active')
      .map(p => esc(p.name))
      .join(', ');
  const locRows = locs
    .map(l =>
      isGM
        ? `<tr><td>${String(l.index)}</td><td><input type="text" value="${esc(l.name)}" data-loc="${String(l.index)}" data-field="name"></td>
          <td><input type="text" list="mvpc-chase-checks" placeholder="e.g. Climb or DEX" value="${esc(challengeText(l.check))}" data-loc="${String(l.index)}" data-field="check"></td>
          <td><select data-loc="${String(l.index)}" data-field="difficulty">${options(DIFFICULTIES, l.difficulty)}</select></td><td>${occupants(l.index)}</td></tr>`
        : `<tr><td>${String(l.index)}</td><td>${esc(l.name)}</td><td>${l.check ? esc(checkLabel(l.check, l.difficulty)) : '—'}</td><td></td><td>${occupants(l.index)}</td></tr>`
    )
    .join('');
  parts.push(`<h3>Locations</h3><table><thead><tr><th>#</th><th>Name</th><th>Challenge</th><th>Difficulty</th><th>Here now</th></tr></thead><tbody>${locRows}</tbody></table>`);
  if (isGM && !state.outcome) {
    parts.push(`<div class="mvpc-row"><button type="button" data-chase="add-location"><i class="fa-solid fa-plus"></i> Add location</button><span class="mvpc-hint">New locations also appear by themselves when someone reaches them.</span></div>`);
  }

  // Turn
  if (state.round > 0 && !state.outcome && current) {
    const loc = state.locations.find(l => l.index === current.location);
    const challenge = loc?.check ? checkLabel(loc.check, loc.difficulty) : 'no challenge set';
    let turn = `<div class="mvpc-turn"><div><b>${esc(current.name)}</b>'s turn in ${esc(locationLabel(state, current.location))}: <b>${esc(challenge)}</b>${current.nextPenaltyDice ? ` with ${String(current.nextPenaltyDice)} penalty die` : ''}.</div>`;
    if (state.pending) {
      const pend = state.pending;
      turn += `<div class="mvpc-row">Failed: ${String(pend.total)} vs ${String(pend.target)}.</div>`;
      if (isGM) {
        turn += `<div class="mvpc-row"><button type="button" data-chase="take-loss"><i class="fa-solid fa-dice-six"></i> Lose 1D6 MvP</button>
          ${pend.luckNeeded !== null ? `<button type="button" data-chase="luck"><i class="fa-solid fa-clover"></i> Spend ${String(pend.luckNeeded)} Luck</button>` : ''}
          ${pend.canPush ? `<button type="button" data-chase="push" title="Failing a pushed roll means out of the chase"><i class="fa-solid fa-hand-fist"></i> Push</button>` : ''}</div>`;
      }
    } else if (state.awaiting) {
      turn += `<div class="mvpc-row">Waiting for ${esc(name(state.awaiting.participantId))} to roll ${esc(checkLabel(state.awaiting.check, state.awaiting.difficulty))}…</div>`;
      if (isGM) turn += `<div class="mvpc-row"><button type="button" data-chase="roll">Roll it for them</button><button type="button" data-chase="pass">Passed</button><button type="button" data-chase="fail">Failed</button></div>`;
    } else if (isGM) {
      turn += `<div class="mvpc-row"><label>Dice <select name="bonusDice">${options(['2', '1', '0', '-1', '-2'], '0', { '2': '+2 bonus', '1': '+1 bonus', '0': 'none', '-1': '1 penalty', '-2': '2 penalty' })}</select></label>
        <label title="Also making a ranged attack: penalty die on both rolls"><input type="checkbox" name="shooting"> Shooting</label>
        <label>Use instead <input type="text" name="useInstead" list="mvpc-chase-checks" placeholder="e.g. DEX" style="width:8em"></label></div>
        <div class="mvpc-row"><button type="button" data-chase="roll"><i class="fa-solid fa-dice-d20"></i> Roll</button>
        <button type="button" data-chase="request" title="Post a roll button for the player"><i class="fa-solid fa-comment-dots"></i> Ask player</button>
        <button type="button" data-chase="pass">Passed</button><button type="button" data-chase="fail">Failed</button>
        <button type="button" data-chase="skip" title="Does something else this turn">Skip</button></div>`;
    }
    turn += '</div>';
    parts.push(turn);
  }

  if (state.log.length) {
    parts.push(`<h3>Log</h3><ol class="mvpc-log">${state.log.slice(-12).map(l => `<li>${esc(l)}</li>`).join('')}</ol>`);
  }

  if (isGM) {
    parts.push(
      state.outcome
        ? `<div class="mvpc-row"><button type="button" data-chase="clear"><i class="fa-solid fa-broom"></i> Clear</button></div>`
        : `<div class="mvpc-row"><input type="text" name="endText" placeholder="Outcome (optional)" style="flex:1"><button type="button" data-chase="end"><i class="fa-solid fa-flag"></i> End chase</button><button type="button" data-chase="clear" title="Throw the chase away"><i class="fa-solid fa-trash"></i></button></div>`
    );
  }
  return parts.join('');
}
