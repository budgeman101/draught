/* chrome.ts — DOM chrome over the canvas board.

   Almost everything here is a PLATFORM PRIMITIVE with a thin wrapper: <dialog>
   gives modal + backdrop + focus trap + Escape, <details> gives the collapsible
   panel, <input type=range> gives the slider. We hand-build exactly four things
   the platform has no answer for — stage overlays, dial, readout, meter.

   Everything returns a real HTMLElement with a method or two attached, so it
   appends and styles like any other element. No components, no render cycle.

   Imperative on purpose: the sim mutates arrays in a fixed-timestep tick, which
   a reactive layer can't observe anyway — you'd write a publish-to-signals bridge
   the same size as the .set() calls it replaced. Numbers that tick want set(). */

type Tone = 'good' | 'warn' | 'danger' | null | undefined;

/* Widget types are declared explicitly rather than inferred from Object.assign,
   for two reasons: chained calls keep their type, and live `value` accessors have
   to be installed with defineProperty. Object.assign would INVOKE a getter in the
   source literal and copy the resulting number as a static property — the value
   would be frozen at creation and silently never update. */
export type KitButton = HTMLButtonElement & {
  setLabel(s: string): KitButton;
  setActive(v?: boolean): KitButton;
};
export type KitReadout = HTMLDivElement & { set(v: string | number, tone?: Tone): KitReadout };
export type KitMeter = HTMLDivElement & { set(v: number, tone?: Tone): KitMeter };
export type KitSlider = HTMLDivElement & { set(v: number): KitSlider; input: HTMLInputElement; readonly value: number };
export type KitToggle = HTMLLabelElement & { set(v: boolean): KitToggle; readonly value: boolean };
export type KitSelect = HTMLDivElement & { set(v: string): KitSelect; readonly value: string };
export type KitDial = HTMLDivElement & { set(v: number): KitDial; readonly value: number };
export type KitPanel = HTMLDetailsElement & { body: HTMLDivElement; add(...c: any[]): KitPanel; clear(): KitPanel };
/* `show`, not `open`: HTMLDialogElement already owns `.open` as a boolean. */
export type KitModal = HTMLDialogElement & { show(parent?: HTMLElement): Promise<string | null>; body: HTMLDivElement };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: any[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c as any);
  return node;
}

// wraps by default: an un-wrapping row nested in an overlay will happily
// overflow the overlay's width cap and collide with the chrome opposite it
export const row = (...c: any[]) => el('div', { style: { display: 'flex', gap: 'var(--kit-gap)', alignItems: 'center', flexWrap: 'wrap' } }, ...c);
export const col = (...c: any[]) => el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--kit-gap)' } }, ...c);
export const spacer = () => el('div', { style: { flex: '1 1 auto' } });

/* ── stage: the board, and layers above it ────────────────────────────────── */
export type Anchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

/**
 * A positioned chrome layer. Unattached — append it wherever it belongs, which
 * for a scene is its own `ctx.el` so it's removed together with the scene.
 */
export function overlay(at: Anchor = 'top-left', o: { row?: boolean } = {}) {
  const layer = el('div', { class: 'kit-overlay', dataset: { at } });
  if (o.row) layer.dataset.row = '';
  return layer;
}

/** Wrap a canvas so chrome can sit over it. Returns the host and an overlay maker. */
export function stage(canvas: HTMLCanvasElement) {
  let host = canvas.parentElement;
  if (!host?.classList.contains('kit-stage')) {
    host = el('div', { class: 'kit-stage' });
    canvas.parentElement?.insertBefore(host, canvas);
    host.appendChild(canvas);
  }
  return {
    el: host,
    canvas,
    overlay(at: Anchor = 'top-left', o: { row?: boolean } = {}) {
      const layer = overlay(at, o);
      host!.appendChild(layer);
      return layer;
    },
  };
}

/* ── button ───────────────────────────────────────────────────────────────── */
export interface ButtonOpts {
  label: string;
  onClick?: (e: MouseEvent) => void;
  variant?: 'primary' | 'ghost' | 'danger';
  hotkey?: string;
  title?: string;
  disabled?: boolean;
}

export function button(o: ButtonOpts): KitButton {
  const text = el('span', {}, o.label);
  const node = el('button', {
    class: 'kit-btn', type: 'button', title: o.title, disabled: !!o.disabled,
    dataset: o.variant ? { variant: o.variant } : {},
  }, text, o.hotkey ? el('kbd', { class: 'kit-value', style: { fontSize: '9px', opacity: '.6' } }, keyLabel(o.hotkey)) : null);

  if (o.onClick) node.addEventListener('click', o.onClick as EventListener);

  if (o.hotkey) {
    const want = o.hotkey.toLowerCase();
    const handler = (e: KeyboardEvent) => {
      if (!node.isConnected) { document.removeEventListener('keydown', handler); return; }  // self-cleaning
      const t = e.target as HTMLElement | null;
      if (node.disabled || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === want || (want === 'space' && k === ' ') || (want === 'esc' && k === 'escape')) {
        e.preventDefault();
        node.click();
      }
    };
    document.addEventListener('keydown', handler);
  }

  const api = node as KitButton;
  api.setLabel = (s) => { text.textContent = s; return api; };
  api.setActive = (v = true) => { node.classList.toggle('is-active', v); return api; };
  return api;
}

// 'SPC' rather than the ␣ glyph: it renders as a stray dash in plenty of UI fonts
const keyLabel = (k: string) => (k === 'space' ? 'SPC' : k.toUpperCase());

/* ── readout: the HUD atom ────────────────────────────────────────────────── */
export function readout(o: { label?: string; value?: string | number; tone?: Tone } = {}): KitReadout {
  const valueEl = el('span', { class: 'kit-value' }, String(o.value ?? '—'));
  const node = el('div', { class: 'kit-readout' },
    o.label ? el('span', { class: 'kit-label' }, o.label) : null, valueEl);
  if (o.tone) node.dataset.tone = o.tone;

  const api = node as KitReadout;
  /** Cheap enough for every frame — it skips the DOM write when unchanged. */
  api.set = (v, tone) => {
    const s = String(v);
    if (valueEl.textContent !== s) valueEl.textContent = s;
    if (tone !== undefined) { if (tone) node.dataset.tone = tone; else delete node.dataset.tone; }
    return api;
  };
  return api;
}

/* ── meter: a 0..1 bar ────────────────────────────────────────────────────── */
export function meter(o: { label?: string; value?: number; tone?: Tone; format?: (v: number) => string } = {}): KitMeter {
  const fill = el('div', { class: 'kit-meter-fill' });
  const valueEl = el('span', { class: 'kit-value' });
  const node = el('div', { class: 'kit-field kit-meter' },
    o.label ? el('div', { class: 'kit-field-head' }, el('span', { class: 'kit-label' }, o.label), valueEl) : null,
    el('div', { class: 'kit-meter-track' }, fill));

  const api = node as KitMeter;
  api.set = (v, tone) => {
    const t = Math.max(0, Math.min(1, v));
    fill.style.width = (t * 100).toFixed(1) + '%';
    valueEl.textContent = o.format ? o.format(v) : Math.round(t * 100) + '%';
    if (tone !== undefined) { if (tone) node.dataset.tone = tone; else delete node.dataset.tone; }
    return api;
  };
  api.set(o.value ?? 0, o.tone);
  return api;
}

/* ── slider (platform <input type=range>) ─────────────────────────────────── */
export interface SliderOpts {
  label?: string; min?: number; max?: number; step?: number; value?: number;
  unit?: string; format?: (v: number) => string;
  onInput?: (v: number) => void;
}

export function slider(o: SliderOpts): KitSlider {
  const { label = '', min = 0, max = 1, step = 0.01, value = 0, unit = '' } = o;
  const fmt = o.format ?? ((v: number) => `${+v.toFixed(4)}${unit}`);
  const valueEl = el('span', { class: 'kit-value' }, fmt(value));
  const input = el('input', { class: 'kit-slider', type: 'range', min, max, step, value });

  const node = el('div', { class: 'kit-field' },
    label ? el('div', { class: 'kit-field-head' }, el('span', { class: 'kit-label' }, label), valueEl) : null,
    input);

  const paint = () => {
    const t = (input.valueAsNumber - min) / (max - min || 1);
    input.style.setProperty('--kit-fill', `${(t * 100).toFixed(1)}%`);
    valueEl.textContent = fmt(input.valueAsNumber);
  };
  input.addEventListener('input', () => { paint(); o.onInput?.(input.valueAsNumber); });
  paint();

  const api = node as KitSlider;
  /** Set WITHOUT firing onInput — for syncing from game state. */
  api.set = (v) => { input.value = String(v); paint(); return api; };
  api.input = input;
  Object.defineProperty(api, 'value', { get: () => input.valueAsNumber });
  return api;
}

/* ── toggle ───────────────────────────────────────────────────────────────── */
export function toggle(o: { label?: string; value?: boolean; onChange?: (v: boolean) => void }): KitToggle {
  const input = el('input', { type: 'checkbox', checked: !!o.value });
  const node = el('label', { class: 'kit-toggle' },
    el('span', { class: 'kit-label' }, o.label ?? ''), input, el('span', { class: 'kit-switch' }));
  input.addEventListener('change', () => o.onChange?.(input.checked));

  const api = node as KitToggle;
  api.set = (v) => { input.checked = v; return api; };
  Object.defineProperty(api, 'value', { get: () => input.checked });
  return api;
}

/* ── select ───────────────────────────────────────────────────────────────── */
export function select(o: {
  label?: string;
  options: (string | { value: string; label: string })[];
  value?: string;
  onChange?: (v: string) => void;
}): KitSelect {
  const sel = el('select', { class: 'kit-select' });
  for (const opt of o.options) {
    const value = typeof opt === 'string' ? opt : opt.value;
    const label = typeof opt === 'string' ? opt : opt.label;
    sel.append(el('option', { value, selected: value === o.value }, label));
  }
  const node = el('div', { class: 'kit-field' },
    o.label ? el('div', { class: 'kit-field-head' }, el('span', { class: 'kit-label' }, o.label)) : null, sel);
  sel.addEventListener('change', () => o.onChange?.(sel.value));

  const api = node as KitSelect;
  api.set = (v) => { sel.value = v; return api; };
  Object.defineProperty(api, 'value', { get: () => sel.value });
  return api;
}

/* ── panel (platform <details>) ───────────────────────────────────────────── */
export function panel(o: { title?: string | null; open?: boolean; children?: any[] } = {}): KitPanel {
  const body = el('div', { class: 'kit-panel-body' }, ...(o.children ?? []));
  const node = el('details', { class: 'kit-panel', open: o.open ?? true },
    el('summary', {}, el('span', {}, o.title ?? '')), body);
  if (o.title == null) node.dataset.plain = '';

  const api = node as KitPanel;
  api.body = body;
  api.add = (...c) => { body.append(...c); return api; };
  api.clear = () => { body.replaceChildren(); return api; };
  return api;
}

/* ── modal (platform <dialog>) ────────────────────────────────────────────────
   showModal() gives the backdrop, the focus trap and Escape-to-close for free —
   about sixty lines of hand-rolled focus management we simply don't write.     */
export function modal(o: {
  title?: string;
  body?: any;
  actions?: { id: string; label: string; variant?: 'primary' | 'ghost' | 'danger' }[];
}): KitModal {
  const dlg = el('dialog', {});
  const bodyEl = el('div', { class: 'kit-modal-body' }, o.body ?? '');
  dlg.append(o.title ? el('div', { class: 'kit-modal-head' }, o.title) : null as any, bodyEl);

  if (o.actions?.length) {
    const foot = el('div', { class: 'kit-modal-foot' });
    for (const a of o.actions) {
      foot.append(button({ label: a.label, variant: a.variant, onClick: () => { dlg.returnValue = a.id; dlg.close(); } }));
    }
    dlg.append(foot);
  }

  // click on the backdrop (i.e. on the dialog box itself, outside its content)
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  const api = dlg as KitModal;
  /** Resolves with the action id, or null if dismissed. */
  api.show = (parent: HTMLElement = document.body) => {
    dlg.returnValue = '';
    parent.appendChild(dlg);
    dlg.showModal();
    return new Promise<string | null>((res) => {
      dlg.addEventListener('close', () => { const v = dlg.returnValue; dlg.remove(); res(v || null); }, { once: true });
    });
  };
  api.body = bodyEl;
  return api;
}

/* ── toast ────────────────────────────────────────────────────────────────── */
let toastHost: HTMLElement | null = null;
export function toast(message: string, o: { tone?: Tone; ms?: number } = {}) {
  if (!toastHost?.isConnected) {
    toastHost = el('div', { class: 'kit-toast-host' });
    document.body.appendChild(toastHost);
  }
  const node = el('div', { class: 'kit-toast' }, message);
  if (o.tone) node.dataset.tone = o.tone;
  toastHost.appendChild(node);
  setTimeout(() => { node.classList.add('is-out'); setTimeout(() => node.remove(), 200); }, o.ms ?? 2400);
  return node;
}

/* ── dial (no platform equivalent) ────────────────────────────────────────────
   Reads as an INSTRUMENT — right when a value is tuned by feel rather than set
   exactly. Drag up/down, wheel, or arrow keys when focused.                    */
export function dial(o: {
  label?: string; min?: number; max?: number; step?: number; value?: number;
  size?: number; format?: (v: number) => string; onInput?: (v: number) => void;
}): KitDial {
  const { label = '', min = 0, max = 1, step = 0, value = 0, size = 54 } = o;
  const fmt = o.format ?? ((v: number) => String(+v.toFixed(2)));
  const SWEEP = 270, START = 135;                 // a 270° arc, gap at the bottom
  const r = size / 2 - 5, c = size / 2;
  const arcLen = (SWEEP / 360) * 2 * Math.PI * r;

  let val = Math.max(min, Math.min(max, value));
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  const ring = (cls: string) => {
    const p = document.createElementNS(NS, 'circle');
    p.setAttribute('class', cls);
    p.setAttribute('cx', String(c)); p.setAttribute('cy', String(c)); p.setAttribute('r', String(r));
    p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '4'); p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-dasharray', `${arcLen} ${2 * Math.PI * r}`);
    p.setAttribute('transform', `rotate(${START} ${c} ${c})`);
    return p;
  };
  const track = ring('kit-dial-track');
  const fill = ring('kit-dial-fill');
  const hub = document.createElementNS(NS, 'circle');
  hub.setAttribute('class', 'kit-dial-hub');
  hub.setAttribute('cx', String(c)); hub.setAttribute('cy', String(c)); hub.setAttribute('r', String(r - 6));
  hub.setAttribute('stroke-width', '1');
  const needle = document.createElementNS(NS, 'line');
  needle.setAttribute('class', 'kit-dial-needle');
  needle.setAttribute('stroke-width', '2'); needle.setAttribute('stroke-linecap', 'round');
  svg.append(track, hub, fill, needle);

  const valueEl = el('span', { class: 'kit-value' }, fmt(val));
  const node = el('div', { class: 'kit-dial', tabIndex: 0, role: 'slider' },
    svg, valueEl, label ? el('span', { class: 'kit-label' }, label) : null);

  function paint() {
    const t = (val - min) / (max - min || 1);
    fill.setAttribute('stroke-dashoffset', String(arcLen * (1 - t)));
    const a = ((START + t * SWEEP) * Math.PI) / 180;
    needle.setAttribute('x1', String(c + Math.cos(a) * (r - 9)));
    needle.setAttribute('y1', String(c + Math.sin(a) * (r - 9)));
    needle.setAttribute('x2', String(c + Math.cos(a) * (r - 2)));
    needle.setAttribute('y2', String(c + Math.sin(a) * (r - 2)));
    valueEl.textContent = fmt(val);
    node.setAttribute('aria-valuenow', String(val));
  }

  function setVal(v: number, fire = true) {
    v = Math.max(min, Math.min(max, v));
    if (step) v = Math.round((v - min) / step) * step + min;
    if (v === val) return;
    val = v; paint();
    if (fire) o.onInput?.(val);
  }

  let dragging = false, lastY = 0;
  svg.addEventListener('pointerdown', (e) => { dragging = true; lastY = e.clientY; svg.setPointerCapture(e.pointerId); e.preventDefault(); });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = lastY - e.clientY;
    lastY = e.clientY;
    setVal(val + (dy / 150) * (max - min) * (e.shiftKey ? 0.2 : 1));   // ~150px of travel, finer with shift
  });
  const end = (e: PointerEvent) => { dragging = false; try { svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => { e.preventDefault(); setVal(val - Math.sign(e.deltaY) * (step || (max - min) / 50)); }, { passive: false });
  node.addEventListener('keydown', (e) => {
    const d = step || (max - min) / 50;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setVal(val + d); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setVal(val - d); e.preventDefault(); }
  });

  paint();
  const api = node as KitDial;
  api.set = (v) => { setVal(v, false); return api; };
  Object.defineProperty(api, 'value', { get: () => val });
  return api;
}
