/* main.ts — boot. One screen, three verbs, no goal.

   Deliberately a sandbox: no menu, no score, no progression. The question this
   prototype exists to answer is whether shaping a route with doors, windows and
   fans reads at all — and a goal on top would only make it harder to tell
   whether the air itself is interesting. */

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
import { createSettings } from '../kit/settings.js';

import { CFG } from './cfg.js';
import { distanceToAperture, opennessAt } from './layout.js';
import {
  applyApertures, clearFans, clearScent, createSim, cycleFan, removeFanAt, resetSim,
  setApertureOpen, stillAir, tick, zoneScent, type Dir, type Sim,
} from './sim.js';
import { createView, type View } from './view.js';

installErrorBanner();

const remote = hubRemote();

const store = createStore({
  key: 'draught',
  version: 1,
  remote,
  defaults: {
    apertures: {} as Record<string, number>,
    fans: [] as { i: number; j: number; dir: Dir }[],
  },
});

let currentView: View | null = null;

const settings = createSettings({
  key: 'draught',
  schema: {
    arrows: {
      type: 'toggle', label: 'Show airflow arrows', default: true,
      onChange: (v) => currentView?.setArrowsVisible(v),
    },
  },
});

async function boot() {
  await store.load();
  await settings.load();

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
    let gauges: { name: string; el: ReturnType<typeof meter> }[] = [];
    let rSpeed: ReturnType<typeof readout>;
    let detach: (() => void) | null = null;

    /* The HUD is a COLUMN, not an overlay, wherever there is room for one: at
       this plan's aspect ratio a floating panel always lands on top of a room.
       Below that width the column would eat the board, so it goes back to
       floating and the board gives up height instead. */
    const SIDEBAR = 232;
    const fitBoard = (w: number, h: number) => {
      const wide = w >= 820;
      view.fit(w, h, {
        left: wide ? SIDEBAR + 20 : 12,
        right: 12,
        top: 56,
        bottom: wide ? 12 : 20,
      });
    };

    /* ── input ──────────────────────────────────────────────────────────────
       One gesture does everything a door needs: press near it and drag along it
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

    /* ONE path for each change, so a test drives exactly what a finger drives.
       These were separate at first and the reload test caught it: DBG.open()
       moved the door and never wrote the save, which is a difference between
       the tested game and the played one. */
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

    return {
      get sim() { return sim; },

      setOpen(id: string, v: number) { setApertureOpen(sim, id, v); commitAperture(id); },
      dropFan(x: number, y: number) { const r = cycleFan(sim, x, y); commitFans(); return r; },

      enter(ctx: SceneContext) {
        sim = createSim();
        defaults = Object.fromEntries(sim.layout.apertures.map((a) => [a.id, a.open]));

        for (const [id, open] of Object.entries(store.data.apertures)) {
          const a = sim.layout.apertures.find((q) => q.id === id);
          if (a) a.open = Math.max(0, Math.min(1, open));
        }
        for (const f of store.data.fans) if (!sim.f.solid[f.i + f.j * sim.W]) sim.fans.push({ ...f });
        applyApertures(sim);

        view = createView(ctx.layer, sim);
        view.setArrowsVisible(settings.get('arrows'));
        currentView = view;
        fitBoard(host.clientWidth || 900, host.clientHeight || 640);

        /* ── chrome ─────────────────────────────────────────────────────── */
        const topRight = overlay('top-right', { row: true });
        topRight.append(
          button({
            label: 'Arrows', hotkey: 'a',
            onClick: () => { const v = !settings.get('arrows'); settings.set('arrows', v); },
          }),
          button({
            label: 'Unit', hotkey: 'u',
            onClick: () => {
              sim.unitOn = !sim.unitOn;
              applyApertures(sim);
              toast(sim.unitOn ? 'Unit on.' : 'Unit off — the air will coast to a stop.', { ms: 1500 });
            },
          }),
          button({ label: 'Clear fans', onClick: () => { clearFans(sim); view.rebuild(); store.data.fans = []; store.touch(); } }),
          button({ label: 'Clear scent', onClick: () => clearScent(sim) }),
          button({ label: 'Still air', variant: 'ghost', onClick: () => { stillAir(sim); clearScent(sim); } }),
        );

        gauges = sim.layout.zones.map((z) => ({
          name: z.name,
          el: meter({ label: z.name, value: 0, format: (v) => `${Math.round(v * 100)}%` }),
        }));
        rSpeed = readout({ label: 'Fastest air', value: '0.00 m/s' });
        const gaugePanel = panel({
          title: 'Scent in the room',
          open: (host.clientWidth || 900) >= 820,   // on a phone it starts as a strip, not a wall
          children: [...gauges.map((g) => g.el), rSpeed],
        });

        const help = document.createElement('div');
        help.style.cssText = 'font:400 12px/1.55 var(--kit-font);color:var(--kit-dim)';
        help.innerHTML =
          '<b style="color:var(--kit-ink)">Drag a door or window</b> along its length to set how far it is ' +
          'open. Narrowing it makes the air move faster through the gap and passes less of it.<br><br>' +
          '<b style="color:var(--kit-ink)">Click the floor</b> to drop a fan; click it again to turn it, and ' +
          'once more from north to take it away.<br><br>' +
          'The unit blows into the living room and the air leaves by the extract at the end of the hall. ' +
          '<b style="color:var(--kit-ink)">A room only gets air if that air has somewhere to go</b> — open ' +
          'its window, and the door beside it becomes a route.';
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
        let fastest = 0;
        for (const g of gauges) g.el.set(zoneScent(sim, g.name));
        const { u, v } = sim.f;
        for (let k = 0; k < u.length; k++) { const a = Math.abs(u[k]!); if (a > fastest) fastest = a; }
        for (let k = 0; k < v.length; k++) { const a = Math.abs(v[k]!); if (a > fastest) fastest = a; }
        rSpeed.set(`${fastest.toFixed(2)} m/s`);
      },

      resize(w: number, h: number) { fitBoard(w, h); },

      /** DBG.reset() — back to the house as authored, with still air. */
      reset() {
        resetSim(sim);
        for (const a of sim.layout.apertures) a.open = defaults[a.id] ?? 0;
        sim.unitOn = true;
        applyApertures(sim);
        view.rebuild();
      },

      exit() { detach?.(); detach = null; currentView = null; },
    };
  });

  const loop = createLoop({
    fixed: 1 / CFG.simHz,
    update: (dt) => scenes.update(dt),
    render: (alpha) => { scenes.render(alpha); app.render(); },
  });

  const inspector = createInspector({
    cfg: CFG,
    schema: {
      ventSpeed: { min: 0, max: 6, step: 0.1 },
      fanForce: { min: 0, max: 40, step: 0.5 },
      drag: { min: 0, max: 3, step: 0.05 },
      projectIters: { min: 4, max: 80, step: 1 },
      scentDecay: { min: 0, max: 1, step: 0.01 },
      outdoorDecay: { min: 0, max: 4, step: 0.05 },
      scentDiffuse: { min: 0, max: 0.25, step: 0.005 },
      scentGamma: { min: 0.2, max: 2, step: 0.02 },
      arrowScale: { min: 0.02, max: 0.5, step: 0.01 },
    },
    stats: {
      fps: () => loop.stats().fps,
      cells: () => { const s: Sim | null = (scenes.active as any)?.sim ?? null; return s ? s.W * s.H : 0; },
      fans: () => ((scenes.active as any)?.sim?.fans.length ?? 0),
    },
  });

  installDbg({
    loop,
    expose: {
      app, scenes, cfg: CFG, store, settings, log, inspector,
      get sim() { return (scenes.active as any)?.sim ?? null; },
      get view() { return currentView; },
      /** Set a door or window from a test: DBG.open('d-bed', 0.15) */
      open: (id: string, v: number) => (scenes.active as any)?.setOpen?.(id, v),
      /** Drop, turn or take away a fan at a point in house metres. */
      fan: (x: number, y: number) => (scenes.active as any)?.dropFan?.(x, y),
      reset: () => (scenes.active as any)?.reset?.(),
    },
    state: () => {
      const s: Sim | null = (scenes.active as any)?.sim ?? null;
      if (!s) return { scene: scenes.current };
      const scent: Record<string, number> = {};
      for (const z of s.layout.zones) scent[z.name] = +zoneScent(s, z.name).toFixed(4);
      const open: Record<string, number> = {};
      for (const a of s.layout.apertures) open[a.id] = +a.open.toFixed(2);
      return {
        scene: scenes.current,
        t: +s.t.toFixed(2),
        cells: s.W * s.H,
        fans: s.fans.length,
        unitOn: s.unitOn,
        ventFaces: s.fixedFaces.length,
        scent, open,
      };
    },
  });

  store.autosave(4000);
  await scenes.go('play', undefined, { transition: 'none' });
  loop.start();
}

boot();
