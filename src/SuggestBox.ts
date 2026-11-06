/**
 * A scrolling suggestion list for the tracker's check boxes. The browser's own datalist popup can't be
 * given a scrollbar or a height, so this draws a small list under the box instead. Typing filters it,
 * the arrow keys and Enter pick from it, and the box still takes anything typed by hand.
 */

const BOX_ID = 'mvpc-suggest';

const STYLE = `#${BOX_ID}{position:fixed;z-index:1000;max-height:220px;overflow-y:auto;min-width:140px;background:#1e1c1a;color:#eee;
  border:1px solid #7a7971;border-radius:4px;box-shadow:0 3px 10px rgba(0,0,0,.6);font-size:13px;padding:2px 0}
#${BOX_ID} div{padding:2px 8px;cursor:pointer;white-space:nowrap}
#${BOX_ID} div.mvpc-on,#${BOX_ID} div:hover{background:#4b4a44}`;

/** The suggestions that match what's typed: those starting with it first, then those containing it. */
export function filterSuggestions(all: string[], typed: string): string[] {
  const q = typed.trim().toLowerCase();
  if (!q) return all;
  const starts = all.filter(s => s.toLowerCase().startsWith(q));
  const inside = all.filter(s => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q));
  return [...starts, ...inside];
}

/** Turns on the suggestion list for every input marked data-suggest inside root. */
export function attachSuggestions(root: HTMLElement, options: () => string[]): void {
  const doc = root.ownerDocument;
  let input: HTMLInputElement | null = null;
  let shown: string[] = [];
  let active = -1;

  const box = (): HTMLElement => {
    let el = doc.getElementById(BOX_ID);
    if (!el) {
      if (!doc.getElementById(`${BOX_ID}-style`)) {
        const style = doc.createElement('style');
        style.id = `${BOX_ID}-style`;
        style.textContent = STYLE;
        doc.head.appendChild(style);
      }
      el = doc.createElement('div');
      el.id = BOX_ID;
      el.style.display = 'none';
      doc.body.appendChild(el);
    }
    return el;
  };
  const hide = (): void => {
    const el = doc.getElementById(BOX_ID);
    if (el) el.style.display = 'none';
    active = -1;
  };
  const pick = (value: string): void => {
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    hide();
  };
  const draw = (): void => {
    if (!input) return;
    shown = filterSuggestions(options(), input.value);
    const el = box();
    if (!shown.length) {
      hide();
      return;
    }
    el.replaceChildren(
      ...shown.map((s, i) => {
        const row = doc.createElement('div');
        row.textContent = s;
        if (i === active) row.className = 'mvpc-on';
        // mousedown, not click: it fires before the input loses focus and the list closes
        row.addEventListener('mousedown', event => {
          event.preventDefault();
          pick(s);
        });
        return row;
      })
    );
    const r = input.getBoundingClientRect();
    const below = (doc.defaultView?.innerHeight ?? 800) - r.bottom;
    el.style.left = `${String(r.left)}px`;
    el.style.minWidth = `${String(r.width)}px`;
    if (below < 230 && r.top > below) {
      el.style.top = '';
      el.style.bottom = `${String((doc.defaultView?.innerHeight ?? 800) - r.top + 2)}px`;
    } else {
      el.style.bottom = '';
      el.style.top = `${String(r.bottom + 2)}px`;
    }
    el.style.display = 'block';
    el.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const target = (event: Event): HTMLInputElement | null => {
    const el = event.target as HTMLElement | null;
    return el instanceof HTMLInputElement && el.dataset['suggest'] ? el : null;
  };

  root.addEventListener('focusin', event => {
    input = target(event);
    active = -1;
    if (input) draw();
  });
  root.addEventListener('input', event => {
    if (!target(event)) return;
    active = -1;
    draw();
  });
  root.addEventListener('focusout', event => {
    if (target(event)) hide();
  });
  root.addEventListener('scroll', hide, true);
  root.addEventListener('keydown', event => {
    if (!target(event) || box().style.display === 'none') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + shown.length) % shown.length;
      draw();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      pick(shown[active] ?? '');
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      hide();
    }
  });
}
