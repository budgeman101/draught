/* sim.ts — the house as a grid, and everything the player does to it.
   NO DOM, NO PIXI, NO DRAWING — so tests/sim.test.ts can run it in node.

   The layout is authored in metres; this is where it becomes cells. Two solid
   masks are kept rather than one: `baseSolid` is the house with every door and
   window SHUT, and `solid` is the house as it is right now. The first is what
   tells indoors from outdoors (flood-fill from a corner with everything closed),
   and it means opening a door never has to re-derive which side is which. */

import { CFG } from './cfg.js';
import {
  apertureRect, gapRect, house, wallRect, ventRect,
  type Aperture, type Layout, type Rect, type Vent,
} from './layout.js';
import {
  addForce, makeFluid, rebuildFaces, speedAt, step, velocityAt,
  type FixedFace, type Fluid,
} from './fluid.js';

/** 0 = east, 1 = south, 2 = west, 3 = north. */
export type Dir = 0 | 1 | 2 | 3;
export const DIR_VECTORS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export interface Fan {
  /** Cell the fan sits on. */
  i: number;
  j: number;
  dir: Dir;
}

export interface Sim {
  layout: Layout;
  f: Fluid;
  W: number;
  H: number;
  cell: number;
  /** House-metre coordinate of grid cell (0,0)'s top-left corner. Negative — the
      grid is bigger than the house, because air leaving a window has to go
      somewhere and come back from somewhere. */
  ox: number;
  oy: number;

  /** The house with everything shut. */
  baseSolid: Uint8Array;
  /** 1 where the cell is outdoors. */
  outside: Uint8Array;

  fans: Fan[];
  /** Faces the vent prescribes — supply first, then return. */
  fixedFaces: FixedFace[];
  /** Cells the supply blows into: where scent enters the house. */
  supplyCells: number[];
  unitOn: boolean;

  t: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/* ── metres <-> cells ─────────────────────────────────────────────────────── */

export const toCellX = (s: Sim, x: number) => (x - s.ox) / s.cell;
export const toCellY = (s: Sim, y: number) => (y - s.oy) / s.cell;
export const toMetreX = (s: Sim, i: number) => s.ox + (i + 0.5) * s.cell;
export const toMetreY = (s: Sim, j: number) => s.oy + (j + 0.5) * s.cell;

/** The half-open cell range a rectangle in metres covers. */
function cellRange(s: Sim, r: Rect) {
  return {
    i0: clamp(Math.floor(toCellX(s, r.x0)), 0, s.W - 1),
    i1: clamp(Math.ceil(toCellX(s, r.x1)) - 1, 0, s.W - 1),
    j0: clamp(Math.floor(toCellY(s, r.y0)), 0, s.H - 1),
    j1: clamp(Math.ceil(toCellY(s, r.y1)) - 1, 0, s.H - 1),
  };
}

function fillRect(s: Sim, mask: Uint8Array, r: Rect, value: number): void {
  const { i0, i1, j0, j1 } = cellRange(s, r);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mask[i + j * s.W] = value;
}

/* ── build ────────────────────────────────────────────────────────────────── */

export function createSim(layout: Layout = house()): Sim {
  const cell = CFG.cell;
  const W = Math.ceil((layout.width + CFG.margin * 2) / cell);
  const H = Math.ceil((layout.height + CFG.margin * 2) / cell);

  const s: Sim = {
    layout,
    f: makeFluid(W, H, cell),
    W, H, cell,
    ox: -CFG.margin,
    oy: -CFG.margin,
    baseSolid: new Uint8Array(W * H),
    outside: new Uint8Array(W * H),
    fans: [],
    fixedFaces: [],
    supplyCells: [],
    unitOn: true,
    t: 0,
  };

  for (const w of layout.walls) fillRect(s, s.baseSolid, wallRect(w), 1);
  floodOutside(s);
  applyApertures(s);

  const rate = CFG.scentDecay, out = CFG.outdoorDecay;
  for (let c = 0; c < s.f.decay.length; c++) s.f.decay[c] = s.outside[c] ? out : rate;

  return s;
}

/** Everything reachable from the top-left corner with the house sealed. */
function floodOutside(s: Sim): void {
  const { W, H, baseSolid, outside } = s;
  outside.fill(0);
  const stack: number[] = [0];
  if (baseSolid[0]) return;
  outside[0] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const i = c % W, j = (c - i) / W;
    if (i > 0 && !baseSolid[c - 1] && !outside[c - 1]) { outside[c - 1] = 1; stack.push(c - 1); }
    if (i < W - 1 && !baseSolid[c + 1] && !outside[c + 1]) { outside[c + 1] = 1; stack.push(c + 1); }
    if (j > 0 && !baseSolid[c - W] && !outside[c - W]) { outside[c - W] = 1; stack.push(c - W); }
    if (j < H - 1 && !baseSolid[c + W] && !outside[c + W]) { outside[c + W] = 1; stack.push(c + W); }
  }
}

/**
 * Rebuild `solid` from the sealed house plus each aperture's current gap, then
 * re-derive the face flags and the vent faces.
 *
 * A DOOR IS A SPAN OF CELLS, not a permeability multiplier. That is the whole
 * point of the continuous control: a 10cm crack and a 90cm opening are different
 * GEOMETRY, so the crack accelerates the air into a jet and the wide opening
 * lets it drift. A single "40% open" number multiplying the flow would give the
 * same shape at a lower volume, and the jet would never appear.
 */
export function applyApertures(s: Sim): void {
  s.f.solid.set(s.baseSolid);
  for (const a of s.layout.apertures) {
    const g = gapRect(a);
    if (g) fillRect(s, s.f.solid, g, 0);
  }
  for (const v of s.layout.vents) if (v.role === 'extract') fillRect(s, s.f.solid, ventRect(v), 0);
  buildOpenCells(s);
  buildVentFaces(s);
  rebuildFaces(s.f, s.fixedFaces);
}

/**
 * The two places air may leave the model: the far edge of the outdoor margin,
 * and the extract grille.
 *
 * THIS IS THE FIX THAT MADE THE GAME WORK. The first build sealed the whole
 * grid, and in a sealed incompressible box the net flow through any single
 * doorway is exactly zero — so a bedroom off one door got eddies and nothing
 * else, no matter how wide you flung the door. Give the air somewhere to go and
 * every opening becomes a route with a real flow rate down it.
 */
function buildOpenCells(s: Sim): void {
  const { W, H } = s;
  s.f.open.fill(0);
  const rim = 2;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (i < rim || j < rim || i >= W - rim || j >= H - rim) {
        const c = i + j * W;
        if (!s.f.solid[c]) s.f.open[c] = 1;
      }
    }
  }
  for (const v of s.layout.vents) {
    if (v.role !== 'extract') continue;
    const { i0, i1, j0, j1 } = cellRange(s, ventRect(v));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) s.f.open[i + j * s.W] = 1;
  }
}

/**
 * Find the faces the SUPPLY prescribes.
 *
 * It needs the face with WALL upstream and ROOM downstream — the air appears out
 * of the wall into the room. Being explicit about that matters: the same wall
 * has a face on the outdoor side too, and prescribing that one would have the
 * unit blowing into the garden.
 *
 * The extract needs no faces at all: it is an open boundary, so it takes
 * whatever the house sends it. That is the point — how much leaves there rather
 * than through a window you opened is decided by the flow, not by us.
 */
function buildVentFaces(s: Sim): void {
  s.fixedFaces = [];
  s.supplyCells = [];
  if (!s.unitOn) return;

  for (const vent of s.layout.vents) {
    if (vent.role !== 'supply') continue;
    const { i0, i1, j0, j1 } = cellRange(s, ventRect(vent));

    if (vent.axis === 'v') {
      const lo = Math.max(0, i0 - 3), hi = Math.min(s.W - 1, i1 + 3);
      for (let j = j0; j <= j1; j++) {
        for (let i = lo; i <= hi + 1; i++) {
          const left = i > 0 ? s.f.solid[i - 1 + j * s.W]! : 1;
          const right = i <= s.W - 1 ? s.f.solid[i + j * s.W]! : 1;
          const up = vent.dir > 0 ? left : right;
          const down = vent.dir > 0 ? right : left;
          if (up === 1 && down === 0) {
            s.fixedFaces.push({ grid: 'u', i, j, value: vent.dir * CFG.ventSpeed });
            s.supplyCells.push((vent.dir > 0 ? i : i - 1) + j * s.W);
            break;
          }
        }
      }
    } else {
      const lo = Math.max(0, j0 - 3), hi = Math.min(s.H - 1, j1 + 3);
      for (let i = i0; i <= i1; i++) {
        for (let j = lo; j <= hi + 1; j++) {
          const above = j > 0 ? s.f.solid[i + (j - 1) * s.W]! : 1;
          const below = j <= s.H - 1 ? s.f.solid[i + j * s.W]! : 1;
          const up = vent.dir > 0 ? above : below;
          const down = vent.dir > 0 ? below : above;
          if (up === 1 && down === 0) {
            s.fixedFaces.push({ grid: 'v', i, j, value: vent.dir * CFG.ventSpeed });
            s.supplyCells.push(i + (vent.dir > 0 ? j : j - 1) * s.W);
            break;
          }
        }
      }
    }
  }
}

/* ── the player's three verbs ─────────────────────────────────────────────── */

export function setApertureOpen(s: Sim, id: string, open: number): void {
  const a = s.layout.apertures.find((x) => x.id === id);
  if (!a) return;
  const next = clamp(open, 0, 1);
  if (next === a.open) return;
  a.open = next;
  applyApertures(s);
}

export function apertureById(s: Sim, id: string): Aperture | undefined {
  return s.layout.apertures.find((a) => a.id === id);
}

/** True if a fan may stand here: indoor floor, not a wall, not already taken. */
export function canPlaceFan(s: Sim, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= s.W || j >= s.H) return false;
  const c = i + j * s.W;
  return !s.f.solid[c] && !s.outside[c] && !s.f.open[c];
}

/** Nearest fan within `radius` metres, or -1. */
export function fanAt(s: Sim, x: number, y: number, radius = 0.35): number {
  let best = -1, bestD = radius;
  for (let k = 0; k < s.fans.length; k++) {
    const fan = s.fans[k]!;
    const d = Math.hypot(toMetreX(s, fan.i) - x, toMetreY(s, fan.j) - y);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/**
 * One click on the floor: drop a fan, or turn the one already there a quarter
 * turn, and on the turn that would bring it back to where it started, take it
 * away. One verb, no tool palette, and nothing to explain.
 */
export function cycleFan(s: Sim, x: number, y: number): 'placed' | 'turned' | 'removed' | 'blocked' {
  const k = fanAt(s, x, y);
  if (k >= 0) {
    const fan = s.fans[k]!;
    if (fan.dir === 3) { s.fans.splice(k, 1); return 'removed'; }
    fan.dir = (fan.dir + 1) as Dir;
    return 'turned';
  }
  const i = Math.floor(toCellX(s, x)), j = Math.floor(toCellY(s, y));
  if (!canPlaceFan(s, i, j)) return 'blocked';
  s.fans.push({ i, j, dir: 0 });
  return 'placed';
}

export function removeFanAt(s: Sim, x: number, y: number): boolean {
  const k = fanAt(s, x, y);
  if (k < 0) return false;
  s.fans.splice(k, 1);
  return true;
}

export function clearFans(s: Sim): void { s.fans.length = 0; }

export function clearScent(s: Sim): void { s.f.d.fill(0); }

/** Stop the air dead without touching the house — for a clean before/after. */
export function stillAir(s: Sim): void {
  s.f.u.fill(0);
  s.f.v.fill(0);
  s.f.p.fill(0);
  rebuildFaces(s.f, s.fixedFaces);
}

export function resetSim(s: Sim): void {
  clearScent(s);
  clearFans(s);
  stillAir(s);
  s.t = 0;
}

/* ── the tick ─────────────────────────────────────────────────────────────── */

/** The cells a fan pushes on, in grid coordinates. */
export function fanRect(s: Sim, fan: Fan): { i0: number; j0: number; i1: number; j1: number } {
  const [dx] = DIR_VECTORS[fan.dir]!;
  const halfW = Math.max(1, Math.round(CFG.fanWidth / s.cell / 2));
  const halfD = Math.max(1, Math.round(CFG.fanDepth / s.cell / 2));
  const aw = dx !== 0 ? halfD : halfW;
  const ah = dx !== 0 ? halfW : halfD;
  return { i0: fan.i - aw, j0: fan.j - ah, i1: fan.i + aw, j1: fan.j + ah };
}

export function tick(s: Sim, dt: number): void {
  s.t += dt;

  for (const fan of s.fans) {
    const [dx, dy] = DIR_VECTORS[fan.dir]!;
    const r = fanRect(s, fan);
    addForce(s.f, r.i0, r.j0, r.i1, r.j1, dx * CFG.fanForce, dy * CFG.fanForce, dt);
  }

  step(s.f, dt, {
    iters: CFG.projectIters,
    drag: CFG.drag,
    maxSpeed: CFG.maxSpeed,
    diffuse: CFG.scentDiffuse,
  });

  // the source is SET, not added: it gives the picture a fixed top of scale
  if (s.unitOn) for (const c of s.supplyCells) if (!s.f.solid[c]) s.f.d[c] = 1;
}

/* ── reading the result ───────────────────────────────────────────────────── */

/** Mean scent in a room, 0..1. What "did any of it get there" means. */
export function zoneScent(s: Sim, name: string): number {
  const z = s.layout.zones.find((q) => q.name === name);
  if (!z) return 0;
  const { i0, i1, j0, j1 } = cellRange(s, z);
  let sum = 0, n = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = i + j * s.W;
      if (s.f.solid[c] || s.f.open[c]) continue;
      sum += s.f.d[c]!; n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Fastest air anywhere inside an aperture's opening, m/s — the jet, measured. */
export function apertureSpeed(s: Sim, id: string): number {
  const a = apertureById(s, id);
  if (!a) return 0;
  const { i0, i1, j0, j1 } = cellRange(s, apertureRect(a));
  let best = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (s.f.solid[i + j * s.W]) continue;
      best = Math.max(best, speedAt(s.f, i, j));
    }
  }
  return best;
}

/**
 * Air crossing an aperture, in m2/s (a flow rate per metre of ceiling height).
 * Signed along the aperture's own normal, so a sign flip means the draught
 * reversed. Averaged through the wall thickness, then summed across the gap.
 */
export function apertureFlux(s: Sim, id: string): number {
  const a = apertureById(s, id);
  if (!a) return 0;
  const { i0, i1, j0, j1 } = cellRange(s, apertureRect(a));
  const vel = { x: 0, y: 0 };
  let flux = 0;
  const across = a.axis === 'h' ? [i0, i1] as const : [j0, j1] as const;
  for (let k = across[0]; k <= across[1]; k++) {
    let sum = 0, n = 0;
    const through = a.axis === 'h' ? [j0, j1] as const : [i0, i1] as const;
    for (let m = through[0]; m <= through[1]; m++) {
      const i = a.axis === 'h' ? k : m;
      const j = a.axis === 'h' ? m : k;
      if (s.f.solid[i + j * s.W]) continue;
      velocityAt(s.f, i, j, vel);
      sum += a.axis === 'h' ? vel.y : vel.x;
      n++;
    }
    if (n > 0) flux += (sum / n) * s.cell;
  }
  return flux;
}

/** How many faces the vent actually found — 0 means the unit is doing nothing. */
export const ventFaceCount = (s: Sim): number => s.fixedFaces.filter((f) => f.value !== 0).length;
