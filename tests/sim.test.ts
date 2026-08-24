/* sim.test.ts — the air, checked with no browser at all.

   These are not "does it run" tests. Each one is a claim the design rests on,
   and the reason they can be written at all is that sim.ts and fluid.ts have no
   DOM in them:

     - a shut house does not leak;
     - opening a ROUTE (not just a door) carries scent across the house;
     - a narrow gap accelerates the air and a wide one does not — the whole
       reason a door is a span of cells rather than a permeability number;
     - openness is geometry, and the gap is at the latch end, not the hinge.

   Run: npm test */

import { beforeAll, describe, expect, it } from 'vitest';
import { CFG } from '../src/game/cfg.js';
import { totalDivergence } from '../src/game/fluid.js';
import { apertureRect } from '../src/game/layout.js';
import {
  apertureFlux, apertureSpeed, applyApertures, createSim, cycleFan, setApertureOpen, tick,
  toCellX, toCellY, zoneScent, type Sim,
} from '../src/game/sim.js';

/* A coarser grid than the game runs at, so the suite stays quick. Everything
   under test is geometry and flow, both of which survive the resolution change;
   what would NOT survive is a claim about a gap finer than a cell, and no test
   here makes one. */
beforeAll(() => { CFG.cell = 0.14; });

/* the same dt the game runs at, so a threshold measured here means the same
   thing on screen */
const run = (s: Sim, ticks: number, dt = 1 / CFG.simHz) => { for (let i = 0; i < ticks; i++) tick(s, dt); return s; };

const shutEverything = (s: Sim) => {
  for (const a of s.layout.apertures) a.open = 0;
  applyApertures(s);
};

/** Non-solid cells across an aperture's span, on its centre line. */
function openCellsAcross(s: Sim, id: string): number[] {
  const a = s.layout.apertures.find((q) => q.id === id)!;
  const r = apertureRect(a);
  const out: number[] = [];
  if (a.axis === 'h') {
    const j = Math.floor(toCellY(s, a.at));
    for (let i = Math.floor(toCellX(s, r.x0)); i < Math.ceil(toCellX(s, r.x1)); i++) {
      if (!s.f.solid[i + j * s.W]) out.push(i);
    }
  } else {
    const i = Math.floor(toCellX(s, a.at));
    for (let j = Math.floor(toCellY(s, r.y0)); j < Math.ceil(toCellY(s, r.y1)); j++) {
      if (!s.f.solid[i + j * s.W]) out.push(j);
    }
  }
  return out;
}

describe('the house', () => {
  it('rasterises into indoors, outdoors and walls', () => {
    const s = createSim();
    let inside = 0, outside = 0, wall = 0;
    for (let c = 0; c < s.W * s.H; c++) {
      if (s.baseSolid[c]) wall++;
      else if (s.outside[c]) outside++;
      else inside++;
    }
    expect(wall).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
    expect(inside).toBeGreaterThan(0);
    // the six rooms are the bulk of the plan, the margin is a border
    expect(inside).toBeGreaterThan(outside * 0.5);
  });

  it('gives the supply a prescribed inflow and the air somewhere to go', () => {
    const s = createSim();
    // one prescribed face per supply cell, all of them on the west side
    expect(s.fixedFaces.length).toBeGreaterThan(0);
    expect(s.fixedFaces.every((f) => f.value > 0 && f.i < s.W / 2)).toBe(true);
    expect(s.supplyCells.length).toBe(s.fixedFaces.length);

    // and open boundaries exist: the far outdoors, and the extract in the hall
    let rim = 0, extract = 0;
    for (let j = 0; j < s.H; j++) {
      for (let i = 0; i < s.W; i++) {
        if (!s.f.open[i + j * s.W]) continue;
        if (i < 3 || j < 3 || i >= s.W - 3 || j >= s.H - 3) rim++;
        else extract++;
      }
    }
    expect(rim).toBeGreaterThan(0);
    expect(extract).toBeGreaterThan(0);
  });
});

describe('the solve', () => {
  it('leaves the air very nearly divergence-free', () => {
    const s = createSim();
    setApertureOpen(s, 'd-living', 1);
    setApertureOpen(s, 'd-bed', 1);
    cycleFan(s, 2.2, 4.0);
    run(s, 120);

    let fluid = 0;
    for (let c = 0; c < s.W * s.H; c++) if (!s.f.solid[c]) fluid++;
    const perCell = totalDivergence(s.f) / fluid;
    // m/s per metre. Air moves at ~1-3 m/s over 0.14m cells, so anything this
    // small is the solver having genuinely closed the books.
    expect(perCell).toBeLessThan(0.02);
  });
});

describe('routing', () => {
  it('keeps the scent where it is put when every door is shut', () => {
    const s = createSim();
    shutEverything(s);
    run(s, 450);
    expect(zoneScent(s, 'Living room')).toBeGreaterThan(0.02);
    expect(zoneScent(s, 'Bedroom')).toBeLessThan(0.002);
    expect(zoneScent(s, 'Bathroom')).toBeLessThan(0.002);
  });

  it('needs a DESTINATION, not just an open door', () => {
    /* The lesson the whole model turns on. A door into a dead-end room moves
       almost nothing however wide it is, because the air has nowhere to go once
       it is in there. Open that room's window and the same door becomes a route. */
    const doorOnly = createSim();
    shutEverything(doorOnly);
    setApertureOpen(doorOnly, 'd-living', 1);
    setApertureOpen(doorOnly, 'd-bed', 1);
    run(doorOnly, 600);

    const route = createSim();
    shutEverything(route);
    setApertureOpen(route, 'd-living', 1);
    setApertureOpen(route, 'd-bed', 1);
    setApertureOpen(route, 'w-bed', 1);
    run(route, 600);

    expect(zoneScent(doorOnly, 'Bedroom')).toBeLessThan(0.03);
    expect(zoneScent(route, 'Bedroom')).toBeGreaterThan(0.08);
    expect(Math.abs(apertureFlux(doorOnly, 'd-bed'))).toBeLessThan(0.05);
    expect(Math.abs(apertureFlux(route, 'd-bed'))).toBeGreaterThan(0.4);
  });

  it('makes routes compete: a second one open leaves less for the first', () => {
    const alone = createSim();
    shutEverything(alone);
    setApertureOpen(alone, 'd-living', 1);
    setApertureOpen(alone, 'd-bath', 1);
    setApertureOpen(alone, 'w-bath', 1);
    run(alone, 600);

    const shared = createSim();
    shutEverything(shared);
    setApertureOpen(shared, 'd-living', 1);
    setApertureOpen(shared, 'd-bath', 1);
    setApertureOpen(shared, 'w-bath', 1);
    setApertureOpen(shared, 'd-bed', 1);
    setApertureOpen(shared, 'w-bed', 1);
    run(shared, 600);

    expect(Math.abs(apertureFlux(shared, 'd-bath')))
      .toBeLessThan(Math.abs(apertureFlux(alone, 'd-bath')));
  });
});

describe('a door is a span of cells, not a dimmer switch', () => {
  it('opens proportionally, from the latch end', () => {
    const s = createSim();
    shutEverything(s);

    setApertureOpen(s, 'd-bed', 0);
    expect(openCellsAcross(s, 'd-bed').length).toBe(0);

    setApertureOpen(s, 'd-bed', 0.5);
    const half = openCellsAcross(s, 'd-bed');
    setApertureOpen(s, 'd-bed', 1);
    const full = openCellsAcross(s, 'd-bed');

    expect(half.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(half.length);
    expect(half.length / full.length).toBeGreaterThan(0.3);
    expect(half.length / full.length).toBeLessThan(0.75);

    // d-bed hinges 'lo', so the gap must sit at the HIGH end of the span
    expect(Math.max(...half)).toBe(Math.max(...full));
    expect(Math.min(...half)).toBeGreaterThan(Math.min(...full));
  });

  it('speeds the air up as the gap narrows, while passing less of it', () => {
    const route = (bedDoor: number) => {
      const s = createSim();
      shutEverything(s);
      setApertureOpen(s, 'd-living', 1);
      setApertureOpen(s, 'w-bed', 1);
      setApertureOpen(s, 'd-bed', bedDoor);
      run(s, 600);
      return { speed: apertureSpeed(s, 'd-bed'), flux: Math.abs(apertureFlux(s, 'd-bed')) };
    };

    const crack = route(0.15);
    const half = route(0.5);
    const wide = route(1);

    /* THE THING A PERMEABILITY MULTIPLIER CANNOT DO. Shrinking the hole makes
       the air move FASTER through it even as it passes LESS of it — because the
       gap is real geometry, not a dimmer on the flow. A multiplier would drop
       both together and the two openings would differ only in brightness.

       Note what is NOT claimed: that the faster air therefore reaches further
       into the room. It measurably does not — see the README. */
    expect(crack.speed).toBeGreaterThan(wide.speed * 1.15);
    expect(half.speed).toBeGreaterThan(wide.speed);
    expect(crack.flux).toBeLessThan(half.flux);
    expect(half.flux).toBeLessThan(wide.flux);
  });
});
