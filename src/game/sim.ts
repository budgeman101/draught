/* sim.ts — puffs of scent wandering around a house.
   NO DOM, NO PIXI, NO DRAWING — so tests/sim.test.ts runs it in node.

   ── WHY PARTICLES, AND NOT A FLUID SOLVER ─────────────────────────────────
   This started as a real incompressible airflow solve, and that was the wrong
   call badly enough to be worth recording where it can be read. Incompressible
   flow has a property that sounds harmless and is fatal here: in a shut house
   the NET flow through any single doorway is exactly zero. So a bedroom off one
   open door could never fill. Not slowly — never. The most faithful model of air
   forbade the one thing the game is about, and every fix piled on top of it (an
   extract vent, a leak map, a decay term) was a patch for a hole the engine
   choice had dug.

   A puff that wanders satisfies it for free: given a source and time, puffs go
   everywhere a door lets them, which is what a smell does. The naive tool is the
   better tool here, and the last test in tests/sim.test.ts is the one that says
   so — endless source, shut house, enough time, does it fill?

   ── HOW A PUFF MOVES ──────────────────────────────────────────────────────
   Two parts, kept apart so each has one honest number behind it:
     DRIFT    the speed it was thrown with, plus whatever fans push into it,
              bleeding off at CFG.drag. Ends at nothing.
     WANDER   a random walk of CFG.diffusivity m²/s, which never ends. This is
              what carries a smell across a still room.
   Walls are a bitmap. A blocked step is taken on the other axis only, so puffs
   slide along a wall instead of piling into it. */

import { CFG } from './cfg.js';
import {
  apertureRect, emitterRect, gapRect, house, wallRect,
  type Aperture, type Layout, type Rect,
} from './layout.js';
import { makeRng, type Rng } from '../kit/rng.js';

/** 0 = east, 1 = south, 2 = west, 3 = north. */
export type Dir = 0 | 1 | 2 | 3;
export const DIR_VECTORS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export interface Fan {
  x: number;
  y: number;
  dir: Dir;
}

export interface Sim {
  layout: Layout;
  seed: string;
  rng: Rng;

  /** The wall bitmap and how to index it. */
  W: number;
  H: number;
  cell: number;
  ox: number;
  oy: number;
  /** The house with every door and window SHUT — what tells inside from out. */
  baseSolid: Uint8Array;
  /** The house as it is right now. */
  solid: Uint8Array;
  /** 1 where the cell is outdoors. */
  outside: Uint8Array;
  /** Which room a cell belongs to, or -1. */
  zoneOf: Int8Array;
  /** Floor area of each room, m². */
  zoneArea: number[];

  fans: Fan[];
  unitOn: boolean;

  /* The pool. Flat arrays, and a ring cursor rather than a free list: puffs are
     spawned in order, so the slot the ring lands on is always the oldest one.
     That IS the lifetime — pool size over emission rate — and it is the only
     place in this file anything disappears. There is no decay term. */
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  alive: Uint8Array;
  next: number;
  live: number;
  emitAcc: number;

  t: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/* ── metres <-> cells ─────────────────────────────────────────────────────── */

export const toCellX = (s: Sim, x: number) => (x - s.ox) / s.cell;
export const toCellY = (s: Sim, y: number) => (y - s.oy) / s.cell;

function cellRange(s: Sim, r: Rect) {
  return {
    i0: clamp(Math.floor(toCellX(s, r.x0)), 0, s.W - 1),
    i1: clamp(Math.ceil(toCellX(s, r.x1)) - 1, 0, s.W - 1),
    j0: clamp(Math.floor(toCellY(s, r.y0)), 0, s.H - 1),
    j1: clamp(Math.ceil(toCellY(s, r.y1)) - 1, 0, s.H - 1),
  };
}

function fillRect(s: Sim, mask: Uint8Array | Int8Array, r: Rect, value: number): void {
  const { i0, i1, j0, j1 } = cellRange(s, r);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mask[i + j * s.W] = value;
}

/** Is there wall at this point, in house metres? Off the grid counts as wall. */
export function solidAt(s: Sim, x: number, y: number): boolean {
  const i = Math.floor(toCellX(s, x)), j = Math.floor(toCellY(s, y));
  if (i < 0 || j < 0 || i >= s.W || j >= s.H) return true;
  return s.solid[i + j * s.W] === 1;
}

/* ── build ────────────────────────────────────────────────────────────────── */

export function createSim(seed = 'draught', layout: Layout = house()): Sim {
  const cell = CFG.cell;
  const W = Math.ceil((layout.width + CFG.margin * 2) / cell);
  const H = Math.ceil((layout.height + CFG.margin * 2) / cell);
  const n = CFG.particles;

  const s: Sim = {
    layout,
    seed,
    rng: makeRng(seed),
    W, H, cell,
    ox: -CFG.margin,
    oy: -CFG.margin,
    baseSolid: new Uint8Array(W * H),
    solid: new Uint8Array(W * H),
    outside: new Uint8Array(W * H),
    zoneOf: new Int8Array(W * H).fill(-1),
    zoneArea: [],
    fans: [],
    unitOn: true,
    px: new Float32Array(n),
    py: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    alive: new Uint8Array(n),
    next: 0,
    live: 0,
    emitAcc: 0,
    t: 0,
  };

  for (const w of layout.walls) fillRect(s, s.baseSolid, wallRect(w), 1);
  floodOutside(s);
  applyApertures(s);

  layout.zones.forEach((z, k) => fillRect(s, s.zoneOf, z, k));
  s.zoneArea = layout.zones.map(() => 0);
  for (let c = 0; c < W * H; c++) {
    const k = s.zoneOf[c]!;
    if (k >= 0 && !s.baseSolid[c]) s.zoneArea[k]! += cell * cell;
  }

  return s;
}

/** Everything reachable from the grid corner with the house sealed. */
function floodOutside(s: Sim): void {
  const { W, H, baseSolid, outside } = s;
  outside.fill(0);
  if (baseSolid[0]) return;
  const stack: number[] = [0];
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
 * Rebuild the wall bitmap: the sealed house, minus whatever gap each door and
 * window is currently leaving.
 *
 * A DOOR IS A SPAN OF CELLS, not a "permeability" number. Openness is how much
 * of the opening is actually hole, and the hole grows from the LATCH end,
 * because that is the side a leaf swings away from. Puffs just go through the
 * hole, so how far a door is open decides how many get past per second without
 * anyone writing a rule for it.
 */
export function applyApertures(s: Sim): void {
  s.solid.set(s.baseSolid);
  for (const a of s.layout.apertures) {
    const g = gapRect(a);
    if (g) fillRect(s, s.solid, g, 0);
  }
}

export function setApertureOpen(s: Sim, id: string, open: number): void {
  const a = s.layout.apertures.find((x) => x.id === id);
  if (!a) return;
  const next = clamp(open, 0, 1);
  if (next === a.open) return;
  a.open = next;
  applyApertures(s);
}

export const apertureById = (s: Sim, id: string) => s.layout.apertures.find((a) => a.id === id);

/* ── the player's verbs ───────────────────────────────────────────────────── */

/** The box a fan throws into: out in front of it, not all around it. */
export function fanRect(fan: Fan): Rect {
  const [dx, dy] = DIR_VECTORS[fan.dir]!;
  const halfW = CFG.fanWidth / 2;
  const ax = fan.x + dx * CFG.fanReach, ay = fan.y + dy * CFG.fanReach;
  return {
    x0: Math.min(fan.x, ax) - (dx !== 0 ? 0 : halfW),
    y0: Math.min(fan.y, ay) - (dy !== 0 ? 0 : halfW),
    x1: Math.max(fan.x, ax) + (dx !== 0 ? 0 : halfW),
    y1: Math.max(fan.y, ay) + (dy !== 0 ? 0 : halfW),
  };
}

export function canPlaceFan(s: Sim, x: number, y: number): boolean {
  const i = Math.floor(toCellX(s, x)), j = Math.floor(toCellY(s, y));
  if (i < 0 || j < 0 || i >= s.W || j >= s.H) return false;
  const c = i + j * s.W;
  return !s.solid[c] && !s.outside[c];
}

/** Nearest fan within `radius` metres, or -1. */
export function fanAt(s: Sim, x: number, y: number, radius = 0.35): number {
  let best = -1, bestD = radius;
  for (let k = 0; k < s.fans.length; k++) {
    const f = s.fans[k]!;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/**
 * One click on the floor: drop a fan, or turn the one already there a quarter,
 * and on the turn that would bring it back to where it started, take it away.
 * One verb, no tool palette, nothing to explain.
 */
export function cycleFan(s: Sim, x: number, y: number): 'placed' | 'turned' | 'removed' | 'blocked' {
  const k = fanAt(s, x, y);
  if (k >= 0) {
    const f = s.fans[k]!;
    if (f.dir === 3) { s.fans.splice(k, 1); return 'removed'; }
    f.dir = (f.dir + 1) as Dir;
    return 'turned';
  }
  if (!canPlaceFan(s, x, y)) return 'blocked';
  s.fans.push({ x, y, dir: 0 });
  return 'placed';
}

export function removeFanAt(s: Sim, x: number, y: number): boolean {
  const k = fanAt(s, x, y);
  if (k < 0) return false;
  s.fans.splice(k, 1);
  return true;
}

export const clearFans = (s: Sim) => { s.fans.length = 0; };

export function clearScent(s: Sim): void {
  s.alive.fill(0);
  s.live = 0;
  s.next = 0;
  s.emitAcc = 0;
}

export function resetSim(s: Sim, seed = s.seed): void {
  clearScent(s);
  clearFans(s);
  s.seed = seed;
  s.rng = makeRng(seed);
  s.unitOn = true;
  s.t = 0;
}

/* ── the tick ─────────────────────────────────────────────────────────────── */

function spawn(s: Sim): void {
  const e = s.layout.emitters[0];
  if (!e) return;
  const k = s.next;
  s.next = (s.next + 1) % s.px.length;          // the ring lands on the oldest slot
  if (!s.alive[k]) s.live++;

  const along = e.from + s.rng() * (e.to - e.from);
  const off = e.dir * 0.16;                     // just proud of the grille
  const facing = (e.axis === 'v' ? 0 : Math.PI / 2) + (e.dir > 0 ? 0 : Math.PI);
  const angle = facing + (s.rng() * 2 - 1) * CFG.emitSpread;

  s.px[k] = e.axis === 'v' ? e.at + off : along;
  s.py[k] = e.axis === 'v' ? along : e.at + off;
  s.vx[k] = Math.cos(angle) * CFG.emitSpeed;
  s.vy[k] = Math.sin(angle) * CFG.emitSpeed;
  s.alive[k] = 1;
}

export function tick(s: Sim, dt: number): void {
  s.t += dt;

  if (s.unitOn) {
    s.emitAcc += CFG.emitRate * dt;
    while (s.emitAcc >= 1) { spawn(s); s.emitAcc -= 1; }
  }

  const keep = 1 / (1 + CFG.drag * dt);
  /* One random-walk step of the right size for a diffusivity of D m²/s. This is
     the number that decides how fast a smell crosses a still room, and it is why
     a shut room fills eventually rather than never. */
  const jump = Math.sqrt(2 * CFG.diffusivity * dt);
  const maxStep = s.cell * 0.6;                 // so nothing tunnels a 12cm wall
  const fans = s.fans;

  for (let k = 0; k < s.px.length; k++) {
    if (!s.alive[k]) continue;
    let x = s.px[k]!, y = s.py[k]!, vx = s.vx[k]!, vy = s.vy[k]!;

    for (let n = 0; n < fans.length; n++) {
      const f = fans[n]!;
      const r = fanRect(f);
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      const [dx, dy] = DIR_VECTORS[f.dir]!;
      vx += dx * CFG.fanPush * dt;
      vy += dy * CFG.fanPush * dt;
    }

    vx *= keep;
    vy *= keep;

    const a = s.rng() * Math.PI * 2;
    let mx = vx * dt + Math.cos(a) * jump;
    let my = vy * dt + Math.sin(a) * jump;

    const steps = Math.max(1, Math.ceil(Math.hypot(mx, my) / maxStep));
    mx /= steps; my /= steps;
    for (let n = 0; n < steps; n++) {
      if (solidAt(s, x + mx, y)) { vx = -vx * CFG.bounce; mx = -mx * CFG.bounce; } else x += mx;
      if (solidAt(s, x, y + my)) { vy = -vy * CFG.bounce; my = -my * CFG.bounce; } else y += my;
    }

    /* Gone outdoors is gone. The garden is not a room to fill, and a puff that
       drifted out of an open window should not come wandering back in. */
    const i = Math.floor(toCellX(s, x)), j = Math.floor(toCellY(s, y));
    if (i < 0 || j < 0 || i >= s.W || j >= s.H || s.outside[i + j * s.W]) {
      s.alive[k] = 0; s.live--;
      continue;
    }

    s.px[k] = x; s.py[k] = y; s.vx[k] = vx; s.vy[k] = vy;
  }
}

/* ── reading the result ───────────────────────────────────────────────────── */

export interface Reading {
  /** Puffs in each room. */
  counts: number[];
  /** Puffs indoors, all told. */
  total: number;
  /**
   * Each room's share of what is in the house, against the share its floor area
   * entitles it to. 1 means "exactly its fair share", so this is EVENNESS — and
   * evenness is what is being played for. Raw counts would only ever report that
   * the biggest room has the most in it.
   */
  fairness: number[];
}

export function read(s: Sim): Reading {
  const zones = s.layout.zones.length;
  const counts = new Array<number>(zones).fill(0);
  const fairness = new Array<number>(zones).fill(0);

  let total = 0;
  for (let k = 0; k < s.px.length; k++) {
    if (!s.alive[k]) continue;
    const i = Math.floor(toCellX(s, s.px[k]!)), j = Math.floor(toCellY(s, s.py[k]!));
    if (i < 0 || j < 0 || i >= s.W || j >= s.H) continue;
    const z = s.zoneOf[i + j * s.W]!;
    if (z < 0) continue;
    counts[z]!++;
    total++;
  }

  const area = s.zoneArea.reduce((n, a) => n + a, 0);
  for (let z = 0; z < zones; z++) {
    const entitled = total * (s.zoneArea[z]! / area);
    fairness[z] = entitled > 0 ? counts[z]! / entitled : 0;
  }

  return { counts, total, fairness };
}

export function zoneCount(s: Sim, name: string): number {
  const k = s.layout.zones.findIndex((z) => z.name === name);
  return k < 0 ? 0 : read(s).counts[k]!;
}

/** The room doing worst, as a fraction of its fair share. The headline number. */
export function worstShare(s: Sim): number {
  const r = read(s);
  return r.total === 0 ? 0 : Math.min(...r.fairness);
}

/** Puffs sitting in an opening right now — how busy a door is. */
export function apertureTraffic(s: Sim, id: string): number {
  const a = apertureById(s, id);
  if (!a) return 0;
  const r = apertureRect(a);
  let n = 0;
  for (let k = 0; k < s.px.length; k++) {
    if (!s.alive[k]) continue;
    const x = s.px[k]!, y = s.py[k]!;
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) n++;
  }
  return n;
}

export { apertureRect, emitterRect };
export type { Aperture };
