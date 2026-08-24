/* cfg.ts — EVERY tunable number, in one place.

   THE RULE: logic reads from CFG and never hardcodes a number. That's what makes
   the inspector work (drag a slider, the game changes now) and what keeps
   balancing surgical. If you find yourself typing a magic number into sim.ts,
   it belongs here instead.

   Values here are the STARTING point, not the truth — tune them live with the
   inspector (` to open), then Copy CFG and paste the block back over this one. */

export const CFG = {
  /** Radians per second the mote travels around the star. */
  orbitSpeed: 0.9,
  /** Orbit radius in world units. */
  orbitRadius: 170,
  /** How much the radius breathes in and out, 0 = a perfect circle. */
  wobble: 0.18,
  /** Cycles of breathing per lap. */
  wobbleRate: 3,
  moteScale: 0.85,
  starSize: 34,
  /** Trail sample count. More is prettier and slower. */
  trailLength: 42,
  trailAlpha: 0.5,
};

export type Cfg = typeof CFG;
