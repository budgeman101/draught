/* sim.test.ts — the puffs, checked with no browser at all.

   The first test is the one that matters most, and it is the one the previous
   build FAILED: an endless source in a shut house, given time, has to reach
   every room a door lets it into. A model that cannot do that is wrong, not
   under-tuned — and the fluid solver this replaced could not do it at all,
   because incompressible flow puts exactly zero net air through a dead-end
   doorway.

   A SMALLER POOL than the game runs, so the suite finishes: the pool doubles as
   the puff lifetime (pool / emitRate seconds), so every threshold below is for
   THIS configuration. They are written as comparisons between runs wherever
   possible, so the shape of the claim survives the resizing even where an
   absolute number would not.

   Run: npm test */

import { beforeAll, describe, expect, it } from 'vitest';
import { CFG } from '../src/game/cfg.js';
import { apertureRect } from '../src/game/layout.js';
import {
  applyApertures, createSim, cycleFan, read, setApertureOpen, tick, toCellX, toCellY,
  worstShare, type Dir, type Sim,
} from '../src/game/sim.js';

beforeAll(() => { CFG.particles = 3000; CFG.emitRate = 40; });

const DOORS = ['d-living', 'd-bed', 'd-study', 'd-kitchen', 'd-bath'];

const run = (s: Sim, secs: number) => {
  const n = Math.round(secs * CFG.simHz);
  for (let i = 0; i < n; i++) tick(s, 1 / CFG.simHz);
  return s;
};

/** A house with everything shut, then whatever the caller opens. */
function build(f: (s: Sim) => void, secs = 90, seed = 'test'): Sim {
  const s = createSim(seed);
  for (const a of s.layout.apertures) a.open = 0;
  applyApertures(s);
  f(s);
  return run(s, secs);
}

const openAllDoors = (s: Sim) => { for (const d of DOORS) setApertureOpen(s, d, 1); };
const fan = (s: Sim, x: number, y: number, dir: Dir) => {
  cycleFan(s, x, y);
  const f = s.fans[s.fans.length - 1];
  if (f) f.dir = dir;
};
const share = (s: Sim, name: string) =>
  read(s).fairness[s.layout.zones.findIndex((z) => z.name === name)]!;

/** Non-solid cells across an aperture's span, along its centre line. */
function openCellsAcross(s: Sim, id: string): number[] {
  const a = s.layout.apertures.find((q) => q.id === id)!;
  const r = apertureRect(a);
  const out: number[] = [];
  if (a.axis === 'h') {
    const j = Math.floor(toCellY(s, a.at));
    for (let i = Math.floor(toCellX(s, r.x0)); i < Math.ceil(toCellX(s, r.x1)); i++) {
      if (!s.solid[i + j * s.W]) out.push(i);
    }
  } else {
    const i = Math.floor(toCellX(s, a.at));
    for (let j = Math.floor(toCellY(s, r.y0)); j < Math.ceil(toCellY(s, r.y1)); j++) {
      if (!s.solid[i + j * s.W]) out.push(j);
    }
  }
  return out;
}

/* The three runs everything else reads. Built once — each is a minute and a half
   of simulated house and there is no reason to pay for it six times. */
let shutHouse: Sim, openHouse: Sim, fannedHouse: Sim;

beforeAll(() => {
  shutHouse = build(() => {});
  openHouse = build(openAllDoors);
  fannedHouse = build((s) => {
    openAllDoors(s);
    fan(s, 3.60, 4.00, 0);
    fan(s, 7.20, 4.00, 0);
  });
}, 300_000);

describe('the thing the last model could not do', () => {
  it('reaches every room a door lets it into', () => {
    /* THE INVARIANT, and it is a STRUCTURAL claim: with the doors open there is
       no room the scent cannot get to. The magnitudes here are small because the
       suite runs a third of the game's pool, and the pool is also the puff
       lifetime — at the shipping numbers the far rooms settle around 6% of fair
       share with no fans and 45-60% with two. What is being checked is that the
       floor is not ZERO, which is exactly what the fluid solver could not manage
       however long it ran. */
    const open = read(openHouse), sealed = read(shutHouse);
    openHouse.layout.zones.forEach((z, k) => {
      expect(open.counts[k]!, `${z.name} got nothing`).toBeGreaterThan(0);
      expect(open.fairness[k]!, `${z.name} barely registered`).toBeGreaterThan(0.003);
    });
    // and every one of them beats the same room with the doors shut
    ['Bedroom', 'Study', 'Kitchen', 'Bathroom', 'Hall'].forEach((name) => {
      const k = openHouse.layout.zones.findIndex((z) => z.name === name);
      expect(open.counts[k]!, name).toBeGreaterThan(sealed.counts[k]!);
    });
    expect(open.total).toBeGreaterThan(CFG.particles * 0.9);
  });

  it('and does not, through a shut door', () => {
    for (const name of ['Bedroom', 'Study', 'Kitchen', 'Bathroom', 'Hall']) {
      expect(share(shutHouse, name), `${name} leaked`).toBeLessThan(0.01);
    }
    // it all piles up where it is made
    expect(share(shutHouse, 'Living room')).toBeGreaterThan(2);
  });
});

describe('the verbs do something', () => {
  it('fans even the house out — that is the whole game', () => {
    expect(worstShare(fannedHouse)).toBeGreaterThan(worstShare(openHouse) * 2.5);
    // and they take it FROM the room that had too much
    expect(share(fannedHouse, 'Living room')).toBeLessThan(share(openHouse, 'Living room'));
  });

  it('a cracked door passes less than a wide one', () => {
    const crack = build((s) => { openAllDoors(s); setApertureOpen(s, 'd-bed', 0.15); });
    expect(share(crack, 'Bedroom')).toBeLessThan(share(openHouse, 'Bedroom') * 0.7);
  });

  it('an open window is a way out, not a way through', () => {
    const leaky = build((s) => { openAllDoors(s); setApertureOpen(s, 'w-bed', 1); });
    expect(read(leaky).total).toBeLessThan(read(openHouse).total);
    expect(share(leaky, 'Bedroom')).toBeLessThan(share(openHouse, 'Bedroom'));
  });
});

describe('a door is a span of cells, not a dimmer switch', () => {
  it('opens proportionally, from the latch end', () => {
    const s = createSim();
    for (const a of s.layout.apertures) a.open = 0;
    applyApertures(s);

    expect(openCellsAcross(s, 'd-bed').length).toBe(0);

    setApertureOpen(s, 'd-bed', 0.5);
    const half = openCellsAcross(s, 'd-bed');
    setApertureOpen(s, 'd-bed', 1);
    const full = openCellsAcross(s, 'd-bed');

    expect(half.length).toBeGreaterThan(0);
    expect(half.length / full.length).toBeGreaterThan(0.35);
    expect(half.length / full.length).toBeLessThan(0.7);

    // d-bed hinges 'lo', so the gap sits at the HIGH end of the span
    expect(Math.max(...half)).toBe(Math.max(...full));
    expect(Math.min(...half)).toBeGreaterThan(Math.min(...full));
  });

  it('blocks a puff with a shut door and passes it through an open one', () => {
    const s = createSim();
    for (const a of s.layout.apertures) a.open = 0;
    applyApertures(s);
    const inDoorway = { x: 4.40, y: 4.00 };          // the living room doorway
    expect(s.solid[Math.floor(toCellX(s, inDoorway.x)) + Math.floor(toCellY(s, inDoorway.y)) * s.W]).toBe(1);
    setApertureOpen(s, 'd-living', 1);
    expect(s.solid[Math.floor(toCellX(s, inDoorway.x)) + Math.floor(toCellY(s, inDoorway.y)) * s.W]).toBe(0);
  });
});

describe('runs are reproducible', () => {
  it('same seed, same house, same answer', () => {
    const a = build(openAllDoors, 20, 'repeat');
    const b = build(openAllDoors, 20, 'repeat');
    expect(read(a).counts).toEqual(read(b).counts);
  });

  it('a different seed gives a different arrangement of the same picture', () => {
    const a = build(openAllDoors, 20, 'seed-a');
    const b = build(openAllDoors, 20, 'seed-b');
    expect(read(a).counts).not.toEqual(read(b).counts);
    expect(read(a).total).toBeCloseTo(read(b).total, -2);   // same ballpark
  });
});
