/* sim.ts — the game state and its rules. NO DOM, NO PIXI, NO DRAWING.

   THE SIM/VIEW SPLIT: this file is plain data and plain functions, so it can be
   imported and tested in node with no browser at all (see tests/sim.test.ts).
   The view reads it and draws; it never reads the view. Keeping that line clean
   is what makes a run verifiable — and it's the difference between a sim you can
   prove correct and one you can only squint at.

   Everything random comes from an injected seeded Rng, never Math.random, so the
   same seed always replays the same run. */

import { CFG } from './cfg.js';
import { makeRng, type Rng } from '../kit/rng.js';

export interface Mote {
  angle: number;
  x: number;
  y: number;
  /** Recent positions as flat [x, y, x, y, ...] — the trail. */
  trail: number[];
  hue: number;
}

export interface Sim {
  t: number;
  laps: number;
  mote: Mote;
  rng: Rng;
  seed: string;
  /** Set for exactly one tick when a lap completes — the view and audio read it. */
  lapJustCompleted: boolean;
}

export function createSim(seed: string): Sim {
  const rng = makeRng(seed);
  // each system gets its own stream, so changing one never shifts another
  const look = rng.fork('look');
  return {
    t: 0,
    laps: 0,
    seed,
    lapJustCompleted: false,
    rng,
    mote: {
      angle: 0,
      x: CFG.orbitRadius,
      y: 0,
      trail: [],
      hue: look.range(185, 255),
    },
  };
}

/** One fixed-timestep tick. Pure with respect to everything except `sim`. */
export function tick(sim: Sim, dt: number): void {
  sim.t += dt;
  sim.lapJustCompleted = false;

  const m = sim.mote;
  const before = m.angle;
  m.angle += CFG.orbitSpeed * dt;

  const TAU = Math.PI * 2;
  if (Math.floor(m.angle / TAU) > Math.floor(before / TAU)) {
    sim.laps++;
    sim.lapJustCompleted = true;
  }

  const r = CFG.orbitRadius * (1 + Math.sin(m.angle * CFG.wobbleRate) * CFG.wobble);
  m.x = Math.cos(m.angle) * r;
  m.y = Math.sin(m.angle) * r;

  m.trail.push(m.x, m.y);
  const max = Math.max(0, Math.floor(CFG.trailLength)) * 2;
  while (m.trail.length > max) m.trail.splice(0, 2);
}

/**
 * Reset in place, optionally with a new seed.
 * Exposed on window.DBG so a test can drive from a KNOWN state — without it,
 * however carefully you step, the real time between page load and the first
 * assertion has already moved the sim, and the run isn't reproducible.
 */
export function resetSim(sim: Sim, seed = sim.seed): void {
  const fresh = createSim(seed);
  sim.t = fresh.t;
  sim.laps = fresh.laps;
  sim.seed = fresh.seed;
  sim.rng = fresh.rng;
  sim.lapJustCompleted = false;
  sim.mote.angle = fresh.mote.angle;
  sim.mote.x = fresh.mote.x;
  sim.mote.y = fresh.mote.y;
  sim.mote.hue = fresh.mote.hue;
  sim.mote.trail.length = 0;
}

/** Progress through the current lap, 0..1 — for the meter. */
export const lapProgress = (sim: Sim): number => (sim.mote.angle % (Math.PI * 2)) / (Math.PI * 2);
