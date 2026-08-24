/* main.ts — boot. One screen, two verbs, no goal.

   Deliberately a sandbox: no score, no progression, no win. The question this
   prototype exists to answer is whether spreading the scent around with doors
   and fans is something worth doing, and a goal bolted on top would only make it
   harder to tell whether the spreading itself is interesting. */

import '../kit/theme.css';
import { Application } from 'pixi.js';

import { button, meter, overlay, panel, readout, stage, toast } from '../kit/chrome.js';
import { installDbg } from '../kit/dbg.js';
import { installErrorBanner } from '../kit/errors.js';
import { hubRemote } from '../kit/hubsave.js';
import { createInspector } from '../kit/inspector.js';
import { createLoop } from '../kit/loop.js';
import { createLog } from '../kit/log.js';
import { createStore } from '../kit/save.js';
import { createScenes, type SceneContext } from '../kit/scenes.js';

import { CFG } from './cfg.js';
import { distanceToAperture, opennessAt } from './layout.js';
import {
  applyApertures, clearFans, clearScent, createSim, cycleFan, read, removeFanAt, resetSim,
  setApertureOpen, tick, type Dir, type Sim,
} from './sim.js';
import { createView, type View } from './view.js';

installErrorBanner();

const store = createStore({
  key: 'draught',
  version: 2,
  remote: hubRemote(),
  defaults: {
    apertures: {} as Record<string, number>,
    fans: [] as { x: number; y: number; dir: Dir }[],
  },
  migrate: {
    // v1 kept fans in GRID CELLS, from back when the sim was a fluid solve on a
    // grid. Cells no longer mean anything to a fan, and there is no honest way
    // to convert one without the old cell size, so they go.
    2: (d) => { d.fans = []; return d; },
  },
});

let currentView: View | null = null;

async function boot() {
  await store.load();

  const root = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  root.appendChild(canvas);
  const board = stage(canvas);
  const host = board.el;

  const app = new Application();
  await app.init({
    canvas,
    autoStart: false,
    antialias: true,
    background: 0x05070a,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    width: host.clientWidth || 900,
    height: host.clientHeight || 640,
  });

  const log = createLog({ build: import.meta.env.MODE });
  const scenes = createScenes({ root: host, stage: app.stage, transition: 'none' });

  const ro = new ResizeObserver(() => {
    const w = host.clientWidth || 900, h = host.clientHeight || 640;
    app.renderer.resize(w, h);
    scenes.resize(w, h);
  });
  ro.observe(host);

  scenes.add('play', () => {
    let sim: Sim;
    let view: View;
    let defaults: Record<string, number> = {};
    let gauges: ReturnType<typeof meter>[] = [];
    let rWorst: ReturnType<typeof readout>;
    let rTotal: ReturnType<typeof readout>;
    let detach: (() => void) | null = null;

    /* The HUD is a COLUMN wherever there is room for one: at this plan's aspect
       ratio a floating panel always lands on top of a room. Below that width the
       column would eat the board, so it floats and the board gives up height. */
    const SIDEBAR = 232;
    const fitBoard = (w: number, h: number) => {
      const wide = w >= 820;
      view.fit(w, h, { left: wide ? SIDEBAR + 20 : 12, right: 12, top: 56, bottom: wide ? 12 : 20 });
    };

    const commitAperture = (id: string) => {
      const a = sim.layout.apertures.find((q) => q.id === id);
      if (!a) return;
      store.data.apertures[id] = a.open;
      store.touch();
      view.rebuild();
      log.event('aperture', { id, open: +a.open.toFixed(2) });
    };
    const commitFans = () => {
      store.data.fans = sim.fans.map((f) => ({ ...f }));
      store.touch();
      view.rebuild();
    };

    /* One gesture does everything a door needs: press near it and drag along it
       to set how far it is open, or press and release without moving to flick it
       fully open or shut. Away from a door, a press is a fan. */
    function wireInput(el: HTMLElement) {
      let dragging: string | null = null;
      let moved = false;
      let downAt = { x: 0, y: 0 };

      const world = (e: PointerEvent | MouseEvent) => {
        const r = el.getBoundingClientRect();
        return view.toWorld(e.clientX - r.left, e.clientY - r.top);
      };
      const nearest = (x: number, y: number, radius: number) => {
        let best: string | null = null, bestD = radius;
        for (const a of sim.layout.apertures) {
          const d = distanceToAperture(a, x, y);
          if (d < bestD) { bestD = d; best = a.id; }
        }
        return best;
      };

      const onDown = (e: PointerEvent) => {
        if (e.button === 2) return;
        const p = world(e);
        const hit = nearest(p.x, p.y, 0.3);
        downAt = { x: e.clientX, y: e.clientY };
        moved = false;
        if (hit) {
          dragging = hit;
          el.setPointerCapture(e.pointerId);
          view.setHovered(hit);
        } else {
          const what = cycleFan(sim, p.x, p.y);
          if (what === 'blocked') toast('A fan needs floor to stand on.', { ms: 1400 });
          else commitFans();
        }
      };

      const onMove = (e: PointerEvent) => {
        const p = world(e);
        if (!dragging) { view.setHovered(nearest(p.x, p.y, 0.3)); return; }
        if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) moved = true;
        const a = sim.layout.apertures.find((q) => q.id === dragging);
        if (!a) return;
        setApertureOpen(sim, a.id, opennessAt(a, p.x, p.y));
        view.rebuild();
      };

      const onUp = (e: PointerEvent) => {
        if (dragging) {
          const a = sim.layout.apertures.find((q) => q.id === dragging);
          if (a && !moved) setApertureOpen(sim, a.id, a.open > 0 ? 0 : 1);
          if (a) commitAperture(a.id);
          try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
        }
        dragging = null;
      };

      const onLeave = () => { if (!dragging) view.setHovered(null); };
      const onContext = (e: MouseEvent) => {
        e.preventDefault();
        const p = world(e);
        if (removeFanAt(sim, p.x, p.y)) commitFans();
      };

      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('contextmenu', onContext);
      return () => {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.removeEventListener('pointerleave', onLeave);
        el.removeEventListener('contextmenu', onContext);
      };
    }

    return {
      get sim() { return sim; },
      setOpen(id: string, v: number) { setApertureOpen(sim, id, v); commitAperture(id); },
      dropFan(x: number, y: number) { const r = cycleFan(sim, x, y); commitFans(); return r; },

      enter(ctx: SceneContext) {
        sim = createSim();
        defaults = Object.fromEntries(sim.layout.apertures.map((a) => [a.id, a.open]));

        for (const [id, open] of Object.entries(store.data.apertures)) {
          const a = sim.layout.apertures.find((q) => q.id === id);
          if (a) a.open = Math.max(0, Math.min(1, Number(open) || 0));
        }
        for (const f of store.data.fans) sim.fans.push({ ...f });
        applyApertures(sim);

        view = createView(ctx.layer, sim);
        currentView = view;
        fitBoard(host.clientWidth || 900, host.clientHeight || 640);

        const topRight = overlay('top-right', { row: true });
        topRight.append(
          button({
            label: 'Unit', hotkey: 'u',
            onClick: () => {
              sim.unitOn = !sim.unitOn;
              view.rebuild();
              toast(sim.unitOn ? 'Unit on.' : 'Unit off.', { ms: 1400 });
            },
          }),
          button({ label: 'Clear fans', onClick: () => { clearFans(sim); commitFans(); } }),
          button({ label: 'Clear scent', variant: 'ghost', onClick: () => clearScent(sim) }),
        );

        gauges = sim.layout.zones.map((z) => meter({
          label: z.name, value: 0,
          // 1.0 = exactly this room's share by floor area, so the bar is EVENNESS
          format: (v) => `${Math.round(v * 100)}%`,
        }));
        rWorst = readout({ label: 'Worst room', value: '0%' });
        rTotal = readout({ label: 'Puffs in the house', value: '0' });

        const gaugePanel = panel({
          title: 'Share of the scent',
          open: (host.clientWidth || 900) >= 820,
          children: [...gauges, rWorst, rTotal],
        });

        const help = document.createElement('div');
        help.style.cssText = 'font:400 12px/1.55 var(--kit-font);color:var(--kit-dim)';
        help.innerHTML =
          'Each bar is a room&rsquo;s share of the scent against the share its floor area is worth. ' +
          '<b style="color:var(--kit-ink)">100% is its fair share</b>, so the game is to flatten them.<br><br>' +
          '<b style="color:var(--kit-ink)">Drag a door or window</b> along its length to set how far it is ' +
          'open.<br><br>' +
          '<b style="color:var(--kit-ink)">Click the floor</b> to drop a fan; click it again to turn it, and ' +
          'once more from north to take it away.<br><br>' +
          'An open window is a way OUT — puffs that drift outside are gone for good.';
        const helpPanel = panel({ title: 'How this works', open: false, children: [help] });

        const sidebar = overlay('top-left');
        sidebar.style.width = `${SIDEBAR}px`;
        gaugePanel.style.width = '100%';
        helpPanel.style.width = '100%';
        sidebar.append(gaugePanel, helpPanel);

        ctx.el.append(topRight, sidebar);
        detach = wireInput(host);
      },

      update(dt: number) { tick(sim, dt); },

      render() {
        view.render();
        const r = read(sim);
        /* The raw share, not a clamped one: the meter's BAR clamps itself at
           full, but the label must be free to say 242% — "the living room has
           two and a half times its share" is the single most useful sentence on
           the panel, and a bar pinned at 100% was hiding it. */
        for (let k = 0; k < gauges.length; k++) gauges[k]!.set(r.fairness[k]!);
        rWorst.set(`${Math.round(Math.min(...r.fairness) * 100)}%`);
        rTotal.set(String(r.total));
      },

      resize(w: number, h: number) { fitBoard(w, h); },

      /** DBG.reset() — the house as authored, no fans, no scent. */
      reset(seed?: string) {
        resetSim(sim, seed);
        for (const a of sim.layout.apertures) a.open = defaults[a.id] ?? 0;
        applyApertures(sim);
        view.rebuild();
      },

      exit() { detach?.(); detach = null; currentView = null; },
    };
  });

  const loop = createLoop({
    fixed: 1 / CFG.simHz,
    update: (dt) => scenes.update(dt),
    render: () => { scenes.render(1); app.render(); },
  });

  const inspector = createInspector({
    cfg: CFG,
    schema: {
      emitRate: { min: 0, max: 200, step: 1 },
      emitSpeed: { min: 0, max: 6, step: 0.1 },
      emitSpread: { min: 0, max: 3.14, step: 0.02 },
      drag: { min: 0, max: 6, step: 0.05 },
      diffusivity: { min: 0, max: 1.5, step: 0.01 },
      bounce: { min: 0, max: 1, step: 0.05 },
      fanPush: { min: 0, max: 40, step: 0.5 },
      fanWidth: { min: 0.1, max: 2, step: 0.05 },
      fanReach: { min: 0.2, max: 4, step: 0.1 },
      dotAlpha: { min: 0.05, max: 1, step: 0.05 },
    },
    stats: {
      fps: () => loop.stats().fps,
      puffs: () => ((scenes.active as any)?.sim?.live ?? 0),
      fans: () => ((scenes.active as any)?.sim?.fans.length ?? 0),
    },
  });

  installDbg({
    loop,
    expose: {
      app, scenes, cfg: CFG, store, log, inspector,
      get sim() { return (scenes.active as any)?.sim ?? null; },
      get view() { return currentView; },
      /** DBG.open('d-bed', 0.15) */
      open: (id: string, v: number) => (scenes.active as any)?.setOpen?.(id, v),
      /** Drop, turn or take away a fan at a point in house metres. */
      fan: (x: number, y: number) => (scenes.active as any)?.dropFan?.(x, y),
      reset: (seed?: string) => (scenes.active as any)?.reset?.(seed),
    },
    state: () => {
      const s: Sim | null = (scenes.active as any)?.sim ?? null;
      if (!s) return { scene: scenes.current };
      const r = read(s);
      const share: Record<string, number> = {};
      s.layout.zones.forEach((z, k) => { share[z.name] = +r.fairness[k]!.toFixed(3); });
      const open: Record<string, number> = {};
      for (const a of s.layout.apertures) open[a.id] = +a.open.toFixed(2);
      return {
        scene: scenes.current,
        t: +s.t.toFixed(2),
        puffs: r.total,
        live: s.live,
        fans: s.fans.length,
        unitOn: s.unitOn,
        worst: +Math.min(...r.fairness).toFixed(3),
        share, open,
      };
    },
  });

  store.autosave(4000);
  await scenes.go('play', undefined, { transition: 'none' });
  loop.start();
}

boot();
