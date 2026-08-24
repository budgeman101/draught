/* inspector.ts — Tweakpane bound to your CFG block.

   THE POINT: drag a slider and the game changes as you watch. No reload, no
   edit-refresh round trip. When it feels right, hit COPY CFG and paste the tuned
   block back into source. That's what the data-first rule is FOR — numbers live
   apart from logic so tuning can be a conversation with the running game instead
   of with the code.

     createInspector({
       cfg: CFG,
       stats: { fps: () => loop.stats().fps, motes: () => sim.motes.length },
     });

   Ranges are guessed (0 → 2× the starting value) unless you say otherwise:
     createInspector({ cfg: CFG, schema: { gravity: { min: 0, max: 3e6, step: 5e4 } } })

   Nested CFG objects become folders. Arrays and functions are skipped: there's no
   honest single control for them, and inventing one would be a lie on screen. */

import { Pane } from 'tweakpane';

export interface InspectorSchema {
  [path: string]: { min?: number; max?: number; step?: number; label?: string; options?: Record<string, string | number>; hidden?: boolean };
}

export function createInspector(opts: {
  cfg?: Record<string, any>;
  schema?: InspectorSchema;
  stats?: Record<string, () => string | number>;
  title?: string;
  hotkey?: string;
  expanded?: boolean;
  sampleMs?: number;
  /** Defaults to hidden on narrow screens. */
  hidden?: boolean;
}) {
  const {
    cfg, schema = {}, stats = {}, title = 'CFG', hotkey = '`',
    expanded = true, sampleMs = 250,
    // On a phone the panel would cover the game entirely, so it starts closed
    // there. Press ` (or call .show()) to bring it up.
    hidden = window.innerWidth < 700,
  } = opts;

  /* Its own container, rather than Tweakpane's default fixed corner — that
     corner is where a game's own top-right chrome lives, and the pane sat right
     on top of it. */
  const container = document.createElement('div');
  container.className = 'kit-inspector';
  document.body.appendChild(container);

  const pane = new Pane({ container, title });
  pane.expanded = expanded;
  if (hidden) container.classList.add('is-hidden');

  const original = cfg ? structuredClone(cfg) : null;

  /* ── live stats, refreshed on a timer (never its own rAF, so it can't be
        mistaken for the game's frame loop) ─────────────────────────────────── */
  let timer: ReturnType<typeof setInterval> | null = null;
  const statKeys = Object.keys(stats);
  if (statKeys.length) {
    // Seed from a REAL first sample: Tweakpane picks the monitor type from the
    // initial value, so seeding everything to 0 gives a string stat a number
    // monitor and it renders as "0.00" forever.
    const mirror: Record<string, string | number> = {};
    for (const k of statKeys) {
      try { mirror[k] = stats[k]!(); } catch { mirror[k] = 0; }
    }
    const folder = pane.addFolder({ title: 'stats', expanded: true });
    for (const k of statKeys) folder.addBinding(mirror, k, { readonly: true });
    timer = setInterval(() => {
      if (!pane.expanded || container.classList.contains('is-hidden')) return;   // don't sample what nobody is looking at
      for (const k of statKeys) {
        // keep the last good value on error — swapping a number for 'err' would
        // fight the monitor's type
        try { mirror[k] = stats[k]!(); } catch { /* keep previous */ }
      }
      pane.refresh();
    }, sampleMs);
  }

  /* ── tunables ───────────────────────────────────────────────────────────── */
  const pickStep = (min: number, max: number, v: number) =>
    Number.isInteger(v) && max - min >= 10 ? 1 : +((max - min) / 100).toPrecision(1);

  function guessRange(v: number, over: InspectorSchema[string] = {}) {
    if (over.min != null && over.max != null) {
      return { min: over.min, max: over.max, step: over.step ?? pickStep(over.min, over.max, v) };
    }
    const mag = Math.abs(v);
    const min = over.min ?? (v < 0 ? -mag * 2 : 0);
    const max = over.max ?? (mag === 0 ? 1 : mag * 2);
    return { min, max, step: over.step ?? pickStep(min, max, v) };
  }

  function build(target: Record<string, any>, container: any, path = '') {
    for (const [k, value] of Object.entries(target)) {
      const full = path ? `${path}.${k}` : k;
      const over = schema[full] ?? schema[k] ?? {};
      if (over.hidden) continue;
      // camelCase → spaced words, so a long key wraps at a space instead of
      // mid-word ("orbitRadius" was rendering as "orbitRa-dius")
      const label = over.label ?? k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

      if (typeof value === 'number') {
        container.addBinding(target, k, { label, ...guessRange(value, over) });
      } else if (typeof value === 'boolean') {
        container.addBinding(target, k, { label });
      } else if (typeof value === 'string' && over.options) {
        container.addBinding(target, k, { label, options: over.options });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        build(value, container.addFolder({ title: k, expanded: false }), full);
      }
    }
  }

  if (cfg) {
    const folder = pane.addFolder({ title: 'tunables', expanded: true });
    build(cfg, folder);

    folder.addButton({ title: 'Copy CFG' }).on('click', async () => {
      const text = JSON.stringify(cfg, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        console.info('[inspector] CFG copied to clipboard');
      } catch {
        console.log(text);   // clipboard blocked (insecure origin) — log it instead
      }
    });
    folder.addButton({ title: 'Revert' }).on('click', () => {
      if (!original) return;
      Object.assign(cfg, structuredClone(original));
      pane.refresh();
    });
  }

  /* ── visibility ─────────────────────────────────────────────────────────── */
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
    if (e.key === hotkey) { e.preventDefault(); api.toggle(); }
  };
  if (hotkey) document.addEventListener('keydown', onKey);

  const api = {
    pane,
    element: container,
    show(on = true) { container.classList.toggle('is-hidden', !on); return api; },
    toggle() { container.classList.toggle('is-hidden'); return api; },
    get visible() { return !container.classList.contains('is-hidden'); },
    refresh() { pane.refresh(); return api; },
    dispose() {
      if (timer) clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      pane.dispose();
      container.remove();
    },
  };
  return api;
}

export type Inspector = ReturnType<typeof createInspector>;
