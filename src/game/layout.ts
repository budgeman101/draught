/* layout.ts — the house, in METRES.

   Authored as geometry rather than as a grid on purpose: the grid is derived
   from CFG.cell, so changing the resolution changes how fine a crack a door can
   make without touching a single coordinate here.

   Origin is the top-left OUTSIDE corner of the house; +x is east, +y is south.
   Everything is axis-aligned, which is what lets an aperture be a plain span. */

/** 'h' — the wall runs along x. 'v' — it runs along y. */
export type Axis = 'h' | 'v';

export interface Wall {
  /** The wall's centre-line: `at` is y for an 'h' wall, x for a 'v' one. */
  axis: Axis;
  at: number;
  from: number;
  to: number;
  thickness: number;
}

export interface Aperture {
  id: string;
  label: string;
  kind: 'door' | 'window';
  axis: Axis;
  at: number;
  from: number;
  to: number;
  thickness: number;
  /** Which end the leaf is fixed at. The gap grows from the OTHER end: a door
      swings away from its latch, so a crack appears at the latch side. */
  hinge: 'lo' | 'hi';
  /** 0 = shut, 1 = wide. */
  open: number;
}

/** The unit: a grille on a wall that throws puffs into the room.

    Nothing more. An earlier build modelled its intake as well, and then a duct,
    and then a coil — none of which the question needs. It emits. */
export interface Emitter {
  id: string;
  label: string;
  axis: Axis;
  at: number;
  from: number;
  to: number;
  /** Which way it faces: +1 towards +x (or +y), -1 back. */
  dir: 1 | -1;
}

/** A room, as a rectangle — so "how much scent got into the bedroom" is a
    number the HUD and the tests can both read. */
export interface Zone { name: string; x0: number; y0: number; x1: number; y1: number }

export interface Layout {
  width: number;
  height: number;
  walls: Wall[];
  apertures: Aperture[];
  emitters: Emitter[];
  zones: Zone[];
}

const EXT = 0.24;
const INT = 0.12;

/** A six-room bungalow with a spine hallway — one plan, no editor. */
export function house(): Layout {
  const W = 12.0, H = 8.0;
  const e = EXT / 2;

  const walls: Wall[] = [
    // shell
    { axis: 'h', at: e,     from: e, to: W - e, thickness: EXT },
    { axis: 'h', at: H - e, from: e, to: W - e, thickness: EXT },
    { axis: 'v', at: e,     from: e, to: H - e, thickness: EXT },
    { axis: 'v', at: W - e, from: e, to: H - e, thickness: EXT },
    // living room takes the whole west end
    { axis: 'v', at: 4.40, from: e, to: H - e, thickness: INT },
    // the hallway spine: bedrooms north of it, kitchen and bath south
    { axis: 'h', at: 3.40, from: 4.40, to: W - e, thickness: INT },
    { axis: 'h', at: 4.60, from: 4.40, to: W - e, thickness: INT },
    { axis: 'v', at: 8.00, from: e,    to: 3.40, thickness: INT },
    { axis: 'v', at: 8.00, from: 4.60, to: H - e, thickness: INT },
  ];

  const apertures: Aperture[] = [
    { id: 'd-living', label: 'Living room door', kind: 'door', axis: 'v', at: 4.40,
      from: 3.60, to: 4.40, thickness: INT, hinge: 'lo', open: 0 },
    { id: 'd-bed', label: 'Bedroom door', kind: 'door', axis: 'h', at: 3.40,
      from: 5.60, to: 6.40, thickness: INT, hinge: 'lo', open: 0 },
    { id: 'd-study', label: 'Study door', kind: 'door', axis: 'h', at: 3.40,
      from: 9.30, to: 10.10, thickness: INT, hinge: 'hi', open: 0 },
    { id: 'd-kitchen', label: 'Kitchen door', kind: 'door', axis: 'h', at: 4.60,
      from: 5.60, to: 6.40, thickness: INT, hinge: 'lo', open: 0 },
    { id: 'd-bath', label: 'Bathroom door', kind: 'door', axis: 'h', at: 4.60,
      from: 9.60, to: 10.40, thickness: INT, hinge: 'hi', open: 0 },

    { id: 'w-living', label: 'Living room window', kind: 'window', axis: 'v', at: e,
      from: 4.60, to: 5.80, thickness: EXT, hinge: 'lo', open: 0 },
    { id: 'w-bed', label: 'Bedroom window', kind: 'window', axis: 'h', at: e,
      from: 5.60, to: 6.80, thickness: EXT, hinge: 'lo', open: 0 },
    { id: 'w-study', label: 'Study window', kind: 'window', axis: 'h', at: e,
      from: 9.40, to: 10.60, thickness: EXT, hinge: 'hi', open: 0 },
    { id: 'w-kitchen', label: 'Kitchen window', kind: 'window', axis: 'h', at: H - e,
      from: 5.60, to: 6.80, thickness: EXT, hinge: 'lo', open: 0 },
    { id: 'w-bath', label: 'Bathroom window', kind: 'window', axis: 'h', at: H - e,
      from: 10.00, to: 11.20, thickness: EXT, hinge: 'hi', open: 0 },
  ];

  /* One unit, high on the living room's west wall, blowing east across it. */
  const emitters: Emitter[] = [
    { id: 'unit', label: 'The unit', axis: 'v', at: e, from: 1.05, to: 1.95, dir: 1 },
  ];

  const zones: Zone[] = [
    { name: 'Living room', x0: 0.24, y0: 0.24, x1: 4.34, y1: 7.76 },
    { name: 'Bedroom',     x0: 4.46, y0: 0.24, x1: 7.94, y1: 3.34 },
    { name: 'Study',       x0: 8.06, y0: 0.24, x1: 11.76, y1: 3.34 },
    { name: 'Hall',        x0: 4.46, y0: 3.46, x1: 11.76, y1: 4.54 },
    { name: 'Kitchen',     x0: 4.46, y0: 4.66, x1: 7.94, y1: 7.76 },
    { name: 'Bathroom',    x0: 8.06, y0: 4.66, x1: 11.76, y1: 7.76 },
  ];

  return { width: W, height: H, walls, apertures, emitters, zones };
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** The rectangle a wall occupies, corners extended so joints close. */
export function wallRect(w: Wall): Rect {
  const t = w.thickness / 2;
  return w.axis === 'h'
    ? { x0: w.from - t, y0: w.at - t, x1: w.to + t, y1: w.at + t }
    : { x0: w.at - t, y0: w.from - t, x1: w.at + t, y1: w.to + t };
}

/** The full opening an aperture would be if flung wide. */
export function apertureRect(a: Aperture): Rect {
  // a hair proud of the wall on both sides, so the carve reaches all the way
  // through however the rasteriser rounds
  const t = a.thickness / 2 + 0.02;
  return a.axis === 'h'
    ? { x0: a.from, y0: a.at - t, x1: a.to, y1: a.at + t }
    : { x0: a.at - t, y0: a.from, x1: a.at + t, y1: a.to };
}

/** The part of the opening that is actually GAP at the current openness. */
export function gapRect(a: Aperture): Rect | null {
  const span = a.to - a.from;
  const g = Math.max(0, Math.min(1, a.open)) * span;
  if (g <= 0) return null;
  // hinge at the low end -> the leaf stays low and the gap opens at the high end
  const lo = a.hinge === 'lo' ? a.to - g : a.from;
  const hi = a.hinge === 'lo' ? a.to : a.from + g;
  const r = apertureRect(a);
  return a.axis === 'h' ? { ...r, x0: lo, x1: hi } : { ...r, y0: lo, y1: hi };
}

/** Where along the opening a point sits, as an openness 0..1 from the hinge. */
export function opennessAt(a: Aperture, x: number, y: number): number {
  const p = a.axis === 'h' ? x : y;
  const span = a.to - a.from;
  if (span <= 0) return 0;
  const fromHinge = a.hinge === 'lo' ? (a.to - p) : (p - a.from);
  return Math.max(0, Math.min(1, fromHinge / span));
}

/** Distance in metres from a point to an aperture's opening, 0 if inside it. */
export function distanceToAperture(a: Aperture, x: number, y: number): number {
  const r = apertureRect(a);
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

/** The rectangle the unit's grille occupies, for drawing and for spawning. */
export function emitterRect(v: Emitter): Rect {
  const t = 0.13;
  return v.axis === 'h'
    ? { x0: v.from, y0: v.at - t, x1: v.to, y1: v.at + t }
    : { x0: v.at - t, y0: v.from, x1: v.at + t, y1: v.to };
}
