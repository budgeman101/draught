/* cfg.ts — EVERY tunable number, in one place.

   Lengths are in METRES and speeds in m/s, because the house is authored in
   metres (layout.ts) and rasterised to the grid at `cell` size. That is what
   makes "push the resolution up if the jet doesn't read" a one-number change
   instead of a rewrite. */

export const CFG = {
  /* ── the grid ───────────────────────────────────────────────────────────── */
  /** Cell size in metres. THE resolution knob: the finest crack a door can make
      is one cell wide, so this decides whether a jet reads at all. */
  cell: 0.08,
  /** Outdoor air kept around the house, in metres. Air leaving one window has
      to arrive somewhere, and that somewhere is here. */
  margin: 1.2,

  /** Sim ticks per second. Not 60: a full pressure solve over 23,400 cells is
      ~9ms, which at 60Hz would eat more than half the frame and leave nothing
      for anything else. Air is a slow, smooth field and 30 is invisible — this
      is the honest place to spend the budget, rather than quietly coarsening the
      grid and losing the fine cracks a door is supposed to be able to make. */
  simHz: 30,

  /* ── the solve ──────────────────────────────────────────────────────────── */
  /** Gauss-Seidel sweeps per tick. Warm-started from last tick's pressure, so
      this is far fewer than a cold solve would need. */
  projectIters: 30,
  /** Velocity lost per second to wall friction and general air drag. Without it
      a fan's force accumulates forever and there is no terminal speed. */
  drag: 0.45,
  /** Ceiling on air speed, m/s. A guard rail, not a mechanic. */
  maxSpeed: 6,

  /* ── the sources ────────────────────────────────────────────────────────── */
  /** Face velocity at the vent, m/s. The return grille matches it by area. */
  ventSpeed: 2.4,
  /** Acceleration a fan adds to the air in front of it, m/s². */
  fanForce: 14,
  /** How wide a fan is across its face, metres. */
  fanWidth: 0.45,
  /** How far in front of itself a fan pushes, metres. */
  fanDepth: 0.25,

  /* ── the scent ──────────────────────────────────────────────────────────── */
  /** Indoors: what fraction of the scent is lost per second (soaked into
      furniture, noses, walls). Without a sink the house just saturates and
      every route looks the same. */
  scentDecay: 0.10,
  /** Outdoors: it blows away much faster. */
  outdoorDecay: 1.4,
  /** Extra smoothing per tick, 0..0.25. Semi-Lagrangian advection already
      spreads plenty; this is purely for legibility. */
  scentDiffuse: 0.04,

  /* ── the picture ────────────────────────────────────────────────────────── */
  /** <1 lifts faint traces into view; 1 is linear. */
  scentGamma: 0.62,
  /** Spacing between velocity arrows, metres. */
  arrowSpacing: 0.4,
  /** Metres of arrow per m/s of air. */
  arrowScale: 0.14,
};

export type Cfg = typeof CFG;
