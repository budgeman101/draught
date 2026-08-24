/* cfg.ts — EVERY tunable number, in one place.

   Lengths are metres, speeds m/s, because the house is authored in metres
   (layout.ts). Change `cell` and the collision grid gets finer without a single
   coordinate moving. */

export const CFG = {
  /** Sim ticks per second. */
  simHz: 60,

  /* ── the world ──────────────────────────────────────────────────────────── */
  /** Cell size of the WALL MASK, metres. Nothing is simulated on this grid — it
      is only "is there a wall here", so it can afford to be fine. */
  cell: 0.04,
  /** Outdoor air kept around the house, metres. Somewhere for a draught to go. */
  margin: 1.0,

  /* ── the scent ──────────────────────────────────────────────────────────── */
  /** Size of the particle pool. Also sets how long a puff lives: the pool is a
      ring, so a particle survives `particles / emitRate` seconds before its slot
      is reused. Bigger pool = longer memory = further travel. */
  particles: 9000,
  /** Puffs released per second. */
  emitRate: 40,
  /** How fast the unit throws them, m/s. */
  emitSpeed: 2.3,
  /** Half-angle of the discharge, radians. 0 would be a laser. */
  emitSpread: 0.42,

  /** How quickly a puff's thrown speed bleeds off, per second. Once it is gone
      the puff only wanders. */
  drag: 1.3,
  /** How much a puff wanders, m²/s — the one number that decides how fast a
      smell spreads through STILL air. This is the whole reason a shut room
      still fills eventually, and why the model cannot be a flow field alone. */
  diffusivity: 0.30,
  /** How much of its speed a puff keeps when it hits a wall. */
  bounce: 0.25,

  /* ── the fans ───────────────────────────────────────────────────────────── */
  /** Acceleration a fan puts into the air in front of it, m/s². */
  fanPush: 11,
  /** How wide the fan's throw is, metres. */
  fanWidth: 0.55,
  /** How far in front of itself it reaches, metres. */
  fanReach: 1.4,

  /* ── the picture ────────────────────────────────────────────────────────── */
  /** Drawn size of one puff, metres. */
  dotSize: 0.13,
  dotAlpha: 0.34,
};

export type Cfg = typeof CFG;
