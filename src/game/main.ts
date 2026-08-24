/* main.ts — boot. Wires every piece of the kit to a game that actually runs.

   DELETE-AS-YOU-GO: this example exists so a fresh project shows something alive
   in seconds and so every wire in the stack is proven before you write a line.
   Replace sim.ts / view.ts / cfg.ts with your game and keep the scaffolding.

   The shape to keep:
     loop.update  -> scenes.update -> sim only     (no drawing, no DOM)
     loop.render  -> scenes.render -> app.render() (no rules, no mutation)
     everything tunable                            -> cfg.ts
     everything the player chose                   -> settings
     everything worth reading later                -> log

   Scenes own BOTH halves of a screen: ctx.el for chrome, ctx.layer for board
   content. Both are destroyed on exit, so nothing leaks into the next screen.
*/

import '../kit/theme.css';
import { Application, Assets, type Texture } from 'pixi.js';

import * as Audio from '../kit/audio.js';
import { createCamera } from '../kit/camera.js';
import { button, meter, modal, overlay, panel, readout, stage, toast } from '../kit/chrome.js';
import { installDbg } from '../kit/dbg.js';
import { installErrorBanner } from '../kit/errors.js';
import { hubRemote } from '../kit/hubsave.js';
import { createInspector } from '../kit/inspector.js';
import { createLoop } from '../kit/loop.js';
import { createLog } from '../kit/log.js';
import { seedWord } from '../kit/rng.js';
import { createStore } from '../kit/save.js';
import { createScenes, type SceneContext } from '../kit/scenes.js';
import { createSettings } from '../kit/settings.js';

import { CFG } from './cfg.js';
import { createSim, lapProgress, resetSim, tick, type Sim } from './sim.js';
import { createView, type View } from './view.js';

import moteUrl from '../assets/mote.png';
import pingUrl from '../assets/ping.wav';

installErrorBanner();

/* ── persistence ────────────────────────────────────────────────────────────
   version 2 with a real migration, so the mechanism is proven, not described.

   AND IT SYNCS. `remote` is what makes the save follow the PERSON rather than
   live in one browser: the hub keys it by tailnet login and profile, so this
   game picked up on a phone is the same game you left on the desktop. It is here
   from the first minute deliberately — a save that syncs is what a game IS, not
   a capability to discover and retrofit once two devices have already disagreed.
   IndexedDB stays underneath as the local copy.

   No slug argument: the project's name on the hub comes from project.mjs. A
   PROFILE argument is the real per-game decision — `hubRemote(profileFromUrl('sam'))`
   for a game with a default player. See src/kit/hubsave.ts, and the README. */
const remote = hubRemote();

const store = createStore({
  key: 'template',
  version: 2,
  remote,
  defaults: { totalLaps: 0, bestSession: 0, lastSeed: '', camera: { x: 0, y: 0, zoom: 1 } },
  migrate: {
    2: (d) => {
      if (d.laps !== undefined) { d.totalLaps = d.laps; delete d.laps; }   // v1 called it `laps`
      if (d.bestSession === undefined) d.bestSession = 0;
      return d;
    },
  },
});

let currentView: View | null = null;

const settings = createSettings({
  key: 'template',
  schema: {
    master: { type: 'range', label: 'Master volume', default: 0.7, min: 0, max: 1, step: 0.05,
              format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => Audio.volume('master', v) },
    sfx:    { type: 'range', label: 'Effects', default: 0.9, min: 0, max: 1, step: 0.05,
              format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => Audio.volume('sfx', v) },
    muted:  { type: 'toggle', label: 'Mute', default: false, onChange: (v) => Audio.mute(v) },
    trails: { type: 'toggle', label: 'Show trail', default: true, onChange: (v) => currentView?.setTrailVisible(v) },
  },
});

const openSettings = () =>
  modal({
    title: 'Settings',
    body: settings.panel({ title: null }),
    actions: [{ id: 'close', label: 'Close', variant: 'primary' }],
  }).show();

async function boot() {
  /* THE LOCK, made visible. Registered before load(), because load() is where
     the claim happens. Two devices on one profile do not last-write-wins: the
     second is refused and the store goes read-only, which is the right answer
     and a baffling one if the game says nothing. Say something. */
  store.on('error', (e: { reason: string; heldBy?: { device: string } }) => {
    if (e.reason === 'held-elsewhere') {
      toast(`Already open on ${e.heldBy?.device ?? 'another device'} — not saving here.`, { tone: 'warn' });
    } else if (e.reason === 'taken-over') {
      toast('Another device took over this save — not saving here any more.', { tone: 'warn' });
    }
  });

  await store.load();
  await settings.load();          // reads AND applies — volumes reach the mixer

  /* ── the board: one Pixi app for the whole game ───────────────────────── */
  const root = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  root.appendChild(canvas);
  const board = stage(canvas);
  const host = board.el;

  const app = new Application();
  await app.init({
    canvas,
    autoStart: false,            // our loop drives rendering, not Pixi's ticker
    antialias: true,
    background: 0x080b11,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    width: host.clientWidth || 800,
    height: host.clientHeight || 600,
  });

  const texture: Texture = await Assets.load(moteUrl);
  const log = createLog({ build: import.meta.env.MODE });

  const scenes = createScenes({ root: host, stage: app.stage, transition: 'fade', ms: 180 });

  const ro = new ResizeObserver(() => {
    const w = host.clientWidth || 800, h = host.clientHeight || 600;
    app.renderer.resize(w, h);
    scenes.resize(w, h);
  });
  ro.observe(host);

  Audio.load({ ping: pingUrl }).then((r) => {
    if (!r.ok) console.warn('[game] audio missing:', r.failed);
  });

  /* ── menu ───────────────────────────────────────────────────────────────── */
  scenes.add('menu', {
    enter(ctx: SceneContext) {
      const centre = overlay('center');
      centre.append(
        Object.assign(document.createElement('h1'), {
          textContent: 'MOTES',
          style: 'font:600 34px/1.1 var(--kit-font);letter-spacing:.18em;margin:0;text-align:center',
        }),
        panel({
          title: null,
          children: [
            button({ label: 'Play', variant: 'primary', hotkey: 'enter', onClick: () => scenes.go('play') }),
            button({ label: 'Settings', hotkey: 's', onClick: openSettings }),
            readout({ label: 'All time', value: String(store.data.totalLaps) }),
          ],
        }),
      );
      ctx.el.append(centre);
    },
  });

  /* ── play ───────────────────────────────────────────────────────────────── */
  /* A FACTORY, not an object: it's re-invoked on every entry, so scene state
     lives in a closure and starts clean each time. No `this`, nothing to reset
     by hand, and no stale reference surviving into the next run. */
  scenes.add('play', () => {
    let sim: Sim;
    let view: View;
    let cam: ReturnType<typeof createCamera>;
    let hud: { rLaps: any; rTotal: any; mLap: any };

    return {
      // getters, so DBG.sim reaches the CURRENT scene's state
      get sim() { return sim; },
      get cam() { return cam; },

      enter(ctx: SceneContext) {
        const seed = store.data.lastSeed || seedWord();
        store.data.lastSeed = seed;
        store.save();

        sim = createSim(seed);
        log.event('run-start', { seed });

        // the camera goes INSIDE the scene layer, so layer.destroy() tears the
        // viewport down with everything else — no manual cam.destroy() needed
        cam = createCamera(app, { minZoom: 0.3, maxZoom: 5 });
        cam.fromJSON(store.data.camera);
        ctx.layer.addChild(cam.viewport);

        view = createView(cam.viewport, sim, texture);
        view.setTrailVisible(settings.get('trails'));
        currentView = view;

        /* chrome — inside ctx.el, so it leaves when the scene does */
        const rLaps = readout({ label: 'Laps', value: '0' });
        const rTotal = readout({ label: 'All time', value: String(store.data.totalLaps) });
        const rSeed = readout({ label: 'Seed', value: seed });
        const topLeft = overlay('top-left', { row: true });
        topLeft.append(rLaps, rTotal, rSeed);

        const mLap = meter({ label: 'This lap', value: 0 });
        const side = panel({ title: null, children: [mLap] });
        side.style.width = '190px';
        const bottomLeft = overlay('bottom-left');
        bottomLeft.append(side);

        const topRight = overlay('top-right', { row: true });
        topRight.append(
          button({ label: 'Pause', hotkey: 'space', onClick: () => scenes.push('pause') }),
          button({ label: 'Recentre', hotkey: 'c', onClick: () => { cam.setZoom(1).moveTo(0, 0); } }),
          button({ label: 'Playtest log', variant: 'ghost', onClick: () => toast(`Saved ${log.download()}`, { tone: 'good' }) }),
        );

        ctx.el.append(topLeft, bottomLeft, topRight);
        hud = { rLaps, rTotal, mLap };
      },

      update(dt: number) {
        tick(sim, dt);
        cam.update(dt);

        if (sim.lapJustCompleted) {
          store.data.totalLaps++;
          store.data.bestSession = Math.max(store.data.bestSession, sim.laps);
          store.touch();
          log.event('lap', { lap: sim.laps, t: +sim.t.toFixed(2) });
          Audio.sfx('ping', { volume: 0.45, rate: 1 + (sim.laps % 5) * 0.05 });
        }
      },

      render() {
        view.render();
        hud.rLaps.set(sim.laps);
        hud.rTotal.set(store.data.totalLaps);
        hud.mLap.set(lapProgress(sim));
      },

      /** Reachable as DBG.reset() — a known state is what makes stepping reproducible. */
      reset(seed?: string) { resetSim(sim, seed); },

      exit() {
        store.data.camera = cam.toJSON();
        store.save();
        currentView = null;
        // view and camera live in ctx.layer; the scene destroys it for us
      },
    };
  });

  /* ── pause: PUSHED over play, so the board stays mounted behind it ──────── */
  scenes.add('pause', {
    enter(ctx: SceneContext) {
      loop.pause(true);
      const centre = overlay('center');
      centre.append(panel({
        title: 'Paused',
        children: [
          button({ label: 'Resume', variant: 'primary', hotkey: 'space', onClick: () => scenes.back() }),
          button({ label: 'Settings', onClick: openSettings }),
          button({ label: 'Quit to menu', variant: 'ghost', onClick: () => scenes.go('menu') }),
        ],
      }));
      ctx.el.append(centre);
    },
    exit() { loop.pause(false); },
  });

  /* ── the loop: one driver for sim and render ────────────────────────────── */
  const loop = createLoop({
    fixed: 1 / 60,
    update: (dt) => scenes.update(dt),
    render: (alpha) => { scenes.render(alpha); app.render(); },
  });

  /* ── dev surfaces ───────────────────────────────────────────────────────── */
  createInspector({
    cfg: CFG,
    schema: {
      orbitSpeed:  { min: 0, max: 4, step: 0.01 },
      orbitRadius: { min: 20, max: 400, step: 1 },
      trailLength: { min: 0, max: 200, step: 1 },
      wobbleRate:  { min: 0, max: 12, step: 1 },
    },
    stats: {
      fps: () => loop.stats().fps,
      ticks: () => loop.stats().ticks,
      scene: () => scenes.current ?? '—',
      laps: () => (scenes.active as any)?.sim?.laps ?? 0,
      events: () => log.entries.length,
    },
  });

  installDbg({
    loop,
    expose: {
      app, scenes, cfg: CFG, store, settings, log,
      // live getters: installDbg uses defineProperties, so these re-evaluate
      get sim() { return (scenes.active as any)?.sim ?? null; },
      get cam() { return (scenes.active as any)?.cam ?? null; },
      reset: (seed?: string) => (scenes.active as any)?.reset?.(seed),
    },
    state: () => {
      const sim: Sim | null = (scenes.active as any)?.sim ?? null;
      return {
        scene: scenes.current,
        laps: sim?.laps ?? 0,
        t: sim ? +sim.t.toFixed(3) : 0,
        x: sim ? +sim.mote.x.toFixed(3) : 0,
        y: sim ? +sim.mote.y.toFixed(3) : 0,
        seed: sim?.seed ?? '',
        totalLaps: store.data.totalLaps,
      };
    },
  });

  store.autosave(4000);
  await scenes.go('menu', undefined, { transition: 'none' });
  loop.start();
}

boot();
