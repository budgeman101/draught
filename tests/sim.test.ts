/* sim.test.ts — the sim, tested with no browser at all.

   This is only possible because sim.ts has no DOM and no Pixi in it. Keeping that
   line clean is what turns "I think the rules are right" into something checked.
   Dawnward's 47 hand-rolled rule checks were exactly this shape; here they're
   just tests.

   Run: npm test */

import { describe, expect, it } from 'vitest';
import { createSim, lapProgress, resetSim, tick } from '../src/game/sim.js';
import { CFG } from '../src/game/cfg.js';
import { makeRng } from '../src/kit/rng.js';
import { createStore } from '../src/kit/save.js';

const run = (sim: ReturnType<typeof createSim>, ticks: number, dt = 1 / 60) => {
  for (let i = 0; i < ticks; i++) tick(sim, dt);
  return sim;
};

describe('sim determinism', () => {
  it('replays identically from the same seed', () => {
    const a = run(createSim('brimtoveharn'), 600);
    const b = run(createSim('brimtoveharn'), 600);
    expect(b.mote.x).toBe(a.mote.x);
    expect(b.mote.y).toBe(a.mote.y);
    expect(b.laps).toBe(a.laps);
    expect(b.mote.hue).toBe(a.mote.hue);
  });

  it('differs on a different seed', () => {
    const a = run(createSim('seed-one'), 60);
    const b = run(createSim('seed-two'), 60);
    expect(b.mote.hue).not.toBe(a.mote.hue);   // look is seeded...
    expect(b.mote.x).toBe(a.mote.x);           // ...but the orbit is not random
  });

  it('reaches the exact same state after reset and replay', () => {
    const sim = createSim('replay');
    run(sim, 300);
    const mid = { x: sim.mote.x, laps: sim.laps };
    run(sim, 300);
    resetSim(sim);
    run(sim, 300);
    expect(sim.mote.x).toBe(mid.x);
    expect(sim.laps).toBe(mid.laps);
  });
});

describe('lap counting', () => {
  it('counts one lap per full turn at the configured speed', () => {
    // 600 ticks at 1/60 = 10s; at CFG.orbitSpeed rad/s that is 9 rad ≈ 1.43 turns
    const sim = run(createSim('laps'), 600);
    const expected = Math.floor((CFG.orbitSpeed * 10) / (Math.PI * 2));
    expect(sim.laps).toBe(expected);
  });

  it('reports lap progress in 0..1', () => {
    const sim = run(createSim('progress'), 137);
    const p = lapProgress(sim);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
  });

  it('flags lapJustCompleted for exactly one tick', () => {
    const sim = createSim('flag');
    let flagged = 0;
    for (let i = 0; i < 600; i++) { tick(sim, 1 / 60); if (sim.lapJustCompleted) flagged++; }
    expect(flagged).toBe(sim.laps);
  });

  it('keeps the trail within the configured length', () => {
    const sim = run(createSim('trail'), 500);
    expect(sim.mote.trail.length).toBeLessThanOrEqual(CFG.trailLength * 2);
  });
});

describe('rng streams', () => {
  it('forks independently — draining one does not shift another', () => {
    const base = makeRng('world');
    const weatherA = base.fork('weather');
    const first = [weatherA(), weatherA(), weatherA()];

    const base2 = makeRng('world');
    const loot = base2.fork('loot');
    for (let i = 0; i < 50; i++) loot();          // drain a different stream hard
    const weatherB = base2.fork('weather');
    expect([weatherB(), weatherB(), weatherB()]).toEqual(first);
  });

  it('restores mid-stream from saved state', () => {
    const rng = makeRng('resume');
    rng(); rng();
    const state = rng.state();
    const next = rng();
    rng.setState(state);
    expect(rng()).toBe(next);
  });
});

describe('save migration', () => {
  const makeStore = () => createStore({
    key: 'test',
    version: 2,
    defaults: { totalLaps: 0, bestSession: 0, lastSeed: '' },
    migrate: {
      2: (d: any) => {
        if (d.laps !== undefined) { d.totalLaps = d.laps; delete d.laps; }
        if (d.bestSession === undefined) d.bestSession = 0;
        return d;
      },
    },
  });

  it('migrates a v1 save into the v2 shape', () => {
    const store = makeStore();
    const v1 = JSON.stringify({ e: 'kitsave1', v: 1, d: { laps: 42, lastSeed: 'old' } });
    const result = store.import(v1, { save: false });
    expect(result.ok).toBe(true);
    expect(store.data.totalLaps).toBe(42);
    expect(store.data.bestSession).toBe(0);      // filled from defaults
    expect((store.data as any).laps).toBeUndefined();
    expect(store.data.lastSeed).toBe('old');
  });

  it('refuses a save from a FUTURE version rather than misreading it', () => {
    const store = makeStore();
    const v9 = JSON.stringify({ e: 'kitsave1', v: 9, d: { totalLaps: 1 } });
    const result = store.import(v9, { save: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/newer version/);
    expect(store.data.totalLaps).toBe(0);        // live data untouched
  });

  it('rejects junk without throwing', () => {
    const store = makeStore();
    expect(store.import('not json at all', { save: false }).ok).toBe(false);
    expect(store.data.totalLaps).toBe(0);
  });

  it('accepts a bare pre-kit object and merges it over defaults', () => {
    const store = makeStore();
    const result = store.import(JSON.stringify({ laps: 7 }), { save: false });
    expect(result.ok).toBe(true);
    expect(store.data.totalLaps).toBe(7);
  });
});
