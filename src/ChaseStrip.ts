/**
 * The chase strip: a slim bar every player sees while a chase runs, with the locations in a row and
 * each character's portrait in the location they've reached. It folds down to a small tab.
 */

import { escapeHtml as esc } from './ChaseService';
import { challengeLabel, currentParticipant, type ChaseState } from './chaseState';

const STRIP_ID = 'mvpc-strip';
const FOLD_KEY = 'mvpc-strip-folded';

const STYLE = `<style>
#${STRIP_ID}{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:60;max-width:min(92vw,1100px);
  background:rgba(20,18,16,.88);color:#eee;border:1px solid #7a7971;border-radius:8px;padding:4px 8px 6px;font-size:12px;
  box-shadow:0 2px 10px rgba(0,0,0,.5);pointer-events:auto}
#${STRIP_ID} .mvpc-s-head{display:flex;gap:8px;align-items:center;justify-content:space-between;font-weight:bold}
#${STRIP_ID} .mvpc-s-head button{background:none;border:none;color:#ccc;cursor:pointer;width:auto;line-height:18px;padding:0 4px}
#${STRIP_ID} .mvpc-s-row{display:flex;gap:4px;overflow-x:auto;margin-top:4px}
#${STRIP_ID} .mvpc-s-loc{min-width:92px;max-width:150px;flex:0 0 auto;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:3px 4px;background:rgba(255,255,255,.04)}
#${STRIP_ID} .mvpc-s-loc.mvpc-s-out{border-style:dashed;opacity:.8}
#${STRIP_ID} .mvpc-s-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${STRIP_ID} .mvpc-s-check{font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${STRIP_ID} .mvpc-s-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;min-height:34px}
#${STRIP_ID} .mvpc-s-chip{position:relative;width:32px;height:32px}
#${STRIP_ID} .mvpc-s-chip img{width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid #c9a227;background:#333}
#${STRIP_ID} .mvpc-s-chip.mvpc-s-pursuer img{border-color:#c0392b}
#${STRIP_ID} .mvpc-s-chip.mvpc-s-now img{box-shadow:0 0 0 2px #fff,0 0 8px 3px #ffd54a}
#${STRIP_ID} .mvpc-s-chip.mvpc-s-gone img{filter:grayscale(1);opacity:.6}
#${STRIP_ID} .mvpc-s-mvp{position:absolute;right:-3px;bottom:-3px;background:#111;border:1px solid #999;border-radius:7px;font-size:10px;line-height:12px;padding:0 3px}
#${STRIP_ID} .mvpc-s-outcome{margin-top:4px;font-weight:bold;color:#ffd54a}
#${STRIP_ID}.mvpc-s-folded .mvpc-s-row,#${STRIP_ID}.mvpc-s-folded .mvpc-s-outcome{display:none}
</style>`;

const FALLBACK_IMG = 'icons/svg/mystery-man.svg';

/** The strip's HTML, or '' when no chase is under way. */
export function renderStrip(state: ChaseState | null, folded = false): string {
  if (!state || state.round === 0) return '';
  const current = currentParticipant(state);
  const last = Math.max(1, ...state.locations.map(l => l.index), ...state.participants.map(p => p.location));
  const chip = (id: string): string => {
    const p = state.participants.find(x => x.id === id);
    if (!p) return '';
    const cls = ['mvpc-s-chip', p.side === 'pursuer' ? 'mvpc-s-pursuer' : '', p.id === current?.id ? 'mvpc-s-now' : '', p.status !== 'active' ? 'mvpc-s-gone' : '']
      .filter(Boolean)
      .join(' ');
    const status = p.status === 'active' ? `${String(p.mvp)} MvP` : p.status;
    return `<div class="${cls}" title="${esc(`${p.name} (${p.side}): ${status}`)}"><img src="${esc(p.img ?? FALLBACK_IMG)}" alt=""><span class="mvpc-s-mvp">${p.status === 'active' ? String(p.mvp) : '✕'}</span></div>`;
  };
  const columns: string[] = [];
  for (let i = 1; i <= last; i++) {
    const loc = state.locations.find(l => l.index === i);
    const here = state.participants.filter(p => p.location === i && p.status === 'active');
    const name = loc && loc.name !== `Location ${String(i)}` ? `${String(i)}. ${loc.name}` : `Location ${String(i)}`;
    const check = loc ? (challengeLabel(loc) ?? '') : '';
    columns.push(
      `<div class="mvpc-s-loc"><div class="mvpc-s-name" title="${esc(name)}">${esc(name)}</div><div class="mvpc-s-check" title="${esc(check)}">${esc(check)}</div><div class="mvpc-s-chips">${here.map(p => chip(p.id)).join('')}</div></div>`
    );
  }
  const gone = state.participants.filter(p => p.status !== 'active');
  if (gone.length) {
    columns.push(
      `<div class="mvpc-s-loc mvpc-s-out"><div class="mvpc-s-name">Out of the chase</div><div class="mvpc-s-check">caught, out or escaped</div><div class="mvpc-s-chips">${gone.map(p => chip(p.id)).join('')}</div></div>`
    );
  }
  const head = `<div class="mvpc-s-head"><span>🏃 ${esc(state.name)} · Round ${String(state.round)}${current ? ` · ${esc(current.name)}'s turn` : ''}</span><button type="button" data-mvpc-fold title="${folded ? 'Show the chase' : 'Fold away'}">${folded ? '▲' : '▼'}</button></div>`;
  const outcome = state.outcome ? `<div class="mvpc-s-outcome">${esc(state.outcome)}</div>` : '';
  return `${STYLE}${head}<div class="mvpc-s-row">${columns.join('')}</div>${outcome}`;
}

function folded(): boolean {
  try {
    return globalThis.localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

function setFolded(value: boolean): void {
  try {
    globalThis.localStorage.setItem(FOLD_KEY, value ? '1' : '0');
  } catch {
    // only a convenience
  }
}

/** Draws, updates or removes the strip for the chase now in play. */
export function refreshStrip(state: ChaseState | null): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return;
  let el = doc.getElementById(STRIP_ID);
  const html = renderStrip(state, folded());
  if (!html) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement('div');
    el.id = STRIP_ID;
    el.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('[data-mvpc-fold]')) return;
      setFolded(!folded());
      refreshStrip(currentState());
    });
    doc.body.appendChild(el);
  }
  el.classList.toggle('mvpc-s-folded', folded());
  el.innerHTML = html;
}

let stateSource: () => ChaseState | null = () => null;
const currentState = (): ChaseState | null => stateSource();

/** Where the strip reads the chase from when it redraws itself (the fold button). */
export function setStripSource(source: () => ChaseState | null): void {
  stateSource = source;
}
