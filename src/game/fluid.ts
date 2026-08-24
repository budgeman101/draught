/* fluid.ts — an incompressible air solver on a staggered (MAC) grid.

   THE REASON THIS IS NOT A BLUR. The whole idea of the game is that closing a
   door reroutes the air. A cheap "diffuse the scent and nudge it near the fans"
   model cannot do that: with no pressure to satisfy, air leaks through walls,
   never turns a corner properly, and never speeds up through a narrow gap. So
   the velocity field is made genuinely divergence-free every tick, with the
   walls as real no-flow boundaries. That single step is what buys the corner,
   the jet, and the fact that shutting one door makes another route busier.

   STAGGERED, not collocated, because the geometry is arbitrary. Velocity lives
   on cell FACES — u on the vertical ones, v on the horizontal ones — so "this
   wall passes no air" is exactly one flag on exactly one face, with no
   interpolation smearing it across the wall.

   Each face is one of three things, and the third is what makes a vent work:
     FREE   the pressure solve owns it
     SOLID  velocity pinned at 0, and it is not a neighbour for pressure
     FIXED  velocity pinned at a PRESCRIBED value — an inflow or an outflow.
            Like SOLID it is not a pressure neighbour, but unlike SOLID its
            velocity still counts towards the cell's divergence, which is what
            forces the rest of the field to carry that air away.

   No DOM, no Pixi, no drawing — it runs in node, so tests/sim.test.ts can prove
   the claims above rather than describe them. */

export const FREE = 0;
export const SOLID = 1;
export const FIXED = 2;

export interface Fluid {
  /** Cells across and down. */
  W: number;
  H: number;
  /** Cell size in metres. */
  h: number;

  /** 1 where the cell is wall. W*H. */
  solid: Uint8Array;
  /** 1 where the cell is an OPEN BOUNDARY: pressure pinned at zero and
      continuity not enforced, so air may leave the model entirely or arrive
      from it. The far outdoors is one, and so is the extract grille. Without
      one of these the house is a sealed box, and in a sealed incompressible box
      the net flow through any single doorway is exactly zero — which is the
      real reason the first build could not push air into a bedroom. */
  open: Uint8Array;
  /** FREE | SOLID | FIXED per vertical face. (W+1)*H. */
  uFlag: Uint8Array;
  /** FREE | SOLID | FIXED per horizontal face. W*(H+1). */
  vFlag: Uint8Array;
  /** Prescribed values, read back onto FIXED faces after every stage. */
  uFix: Float32Array;
  vFix: Float32Array;

  /** Air velocity in m/s, on the faces. */
  u: Float32Array;
  v: Float32Array;
  uTmp: Float32Array;
  vTmp: Float32Array;

  /** Pressure-like potential, warm-started across ticks. W*H. */
  p: Float32Array;
  div: Float32Array;

  /** The tracer: scent concentration 0..1 at cell centres. W*H. */
  d: Float32Array;
  dTmp: Float32Array;
  /** Per-cell loss rate, 1/s — bigger outdoors, where it blows away. */
  decay: Float32Array;

  /* ── derived, rebuilt with the faces ──────────────────────────────────────
     The pressure sweep is the hot loop by an order of magnitude — thirty passes
     over every cell, every tick — and it used to read four face-flag arrays per
     cell to ask the same question each time: which of my neighbours may I share
     pressure with? The geometry only changes when a door moves, so the answer is
     cached instead. That alone took the tick from ~14ms to something a 60Hz loop
     can hold. */
  /** Bit 0 left, 1 right, 2 up, 3 down: this neighbour's face is FREE. */
  nbr: Uint8Array;
  /** How many bits are set. 0 means "not part of the solve" — wall, or open. */
  nbrN: Uint8Array;
}

/** 1/n for n in 0..4, so the sweep multiplies instead of dividing. */
const INV_N = [0, 1, 0.5, 1 / 3, 0.25];

export interface StepOpts {
  /** Gauss-Seidel sweeps. */
  iters: number;
  /** Velocity lost per second to friction. */
  drag: number;
  /** Speed ceiling, m/s. */
  maxSpeed: number;
  /** Extra scent smoothing per tick, 0..0.25. */
  diffuse: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export function makeFluid(W: number, H: number, h: number): Fluid {
  return {
    W, H, h,
    solid: new Uint8Array(W * H),
    open: new Uint8Array(W * H),
    uFlag: new Uint8Array((W + 1) * H),
    vFlag: new Uint8Array(W * (H + 1)),
    uFix: new Float32Array((W + 1) * H),
    vFix: new Float32Array(W * (H + 1)),
    u: new Float32Array((W + 1) * H),
    v: new Float32Array(W * (H + 1)),
    uTmp: new Float32Array((W + 1) * H),
    vTmp: new Float32Array(W * (H + 1)),
    p: new Float32Array(W * H),
    div: new Float32Array(W * H),
    d: new Float32Array(W * H),
    dTmp: new Float32Array(W * H),
    decay: new Float32Array(W * H),
    nbr: new Uint8Array(W * H),
    nbrN: new Uint8Array(W * H),
  };
}

/** A prescribed face: which grid, where, and how fast the air crosses it. */
export interface FixedFace { grid: 'u' | 'v'; i: number; j: number; value: number }

/**
 * Recompute every face flag from `solid`, then pin the prescribed ones.
 * Call after any change to the walls — which for this game means after any door
 * or window moves.
 */
export function rebuildFaces(f: Fluid, fixed: readonly FixedFace[] = []): void {
  const { W, H, solid, uFlag, vFlag, uFix, vFix, u, v } = f;

  for (let j = 0; j < H; j++) {
    for (let i = 0; i <= W; i++) {
      const left = i > 0 ? solid[(i - 1) + j * W]! : 1;
      const right = i < W ? solid[i + j * W]! : 1;
      uFlag[i + j * (W + 1)] = (left || right) ? SOLID : FREE;
    }
  }
  for (let j = 0; j <= H; j++) {
    for (let i = 0; i < W; i++) {
      const up = j > 0 ? solid[i + (j - 1) * W]! : 1;
      const down = j < H ? solid[i + j * W]! : 1;
      vFlag[i + j * W] = (up || down) ? SOLID : FREE;
    }
  }

  uFix.fill(0);
  vFix.fill(0);
  for (const ff of fixed) {
    if (ff.grid === 'u') {
      const k = ff.i + ff.j * (W + 1);
      uFlag[k] = FIXED; uFix[k] = ff.value;
    } else {
      const k = ff.i + ff.j * W;
      vFlag[k] = FIXED; vFix[k] = ff.value;
    }
  }

  // a face that just became wall must not keep yesterday's momentum
  for (let k = 0; k < uFlag.length; k++) {
    if (uFlag[k] === SOLID) u[k] = 0;
    else if (uFlag[k] === FIXED) u[k] = uFix[k]!;
  }
  for (let k = 0; k < vFlag.length; k++) {
    if (vFlag[k] === SOLID) v[k] = 0;
    else if (vFlag[k] === FIXED) v[k] = vFix[k]!;
  }
  for (let c = 0; c < solid.length; c++) if (solid[c] || f.open[c]) { f.d[c] = 0; f.p[c] = 0; }

  const { nbr, nbrN } = f;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = i + j * W;
      if (solid[c] || f.open[c]) { nbr[c] = 0; nbrN[c] = 0; continue; }
      let m = 0, n = 0;
      if (uFlag[i + j * (W + 1)] === FREE) { m |= 1; n++; }
      if (uFlag[i + 1 + j * (W + 1)] === FREE) { m |= 2; n++; }
      if (vFlag[i + j * W] === FREE) { m |= 4; n++; }
      if (vFlag[i + (j + 1) * W] === FREE) { m |= 8; n++; }
      nbr[c] = m;
      nbrN[c] = n;
    }
  }
}

/** Put SOLID faces back to zero and FIXED faces back to their prescribed value. */
function enforceFaces(f: Fluid): void {
  const { uFlag, vFlag, u, v, uFix, vFix } = f;
  for (let k = 0; k < uFlag.length; k++) {
    const fl = uFlag[k];
    if (fl === SOLID) u[k] = 0;
    else if (fl === FIXED) u[k] = uFix[k]!;
  }
  for (let k = 0; k < vFlag.length; k++) {
    const fl = vFlag[k];
    if (fl === SOLID) v[k] = 0;
    else if (fl === FIXED) v[k] = vFix[k]!;
  }
}

/* ── sampling ─────────────────────────────────────────────────────────────────
   Each field sits somewhere different: u on vertical faces, v on horizontal
   ones, scalars at cell centres. Three samplers rather than one is the price of
   a staggered grid, and it is the whole reason walls are exact. */

function sampleU(f: Fluid, x: number, y: number): number {
  const { W, H, h, u } = f;
  const gx = clamp(x / h, 0, W);
  const gy = clamp(y / h - 0.5, 0, H - 1);
  const i0 = clamp(Math.floor(gx), 0, W - 1), j0 = clamp(Math.floor(gy), 0, Math.max(0, H - 2));
  const tx = gx - i0, ty = gy - j0;
  const r0 = j0 * (W + 1), r1 = (j0 + 1) * (W + 1);
  const a = u[i0 + r0]!, b = u[i0 + 1 + r0]!, c = u[i0 + r1]!, d = u[i0 + 1 + r1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function sampleV(f: Fluid, x: number, y: number): number {
  const { W, H, h, v } = f;
  const gx = clamp(x / h - 0.5, 0, W - 1);
  const gy = clamp(y / h, 0, H);
  const i0 = clamp(Math.floor(gx), 0, Math.max(0, W - 2)), j0 = clamp(Math.floor(gy), 0, H - 1);
  const tx = gx - i0, ty = gy - j0;
  const r0 = j0 * W, r1 = (j0 + 1) * W;
  const a = v[i0 + r0]!, b = v[i0 + 1 + r0]!, c = v[i0 + r1]!, d = v[i0 + 1 + r1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function sampleScalar(f: Fluid, s: Float32Array, x: number, y: number): number {
  const { W, H, h } = f;
  const gx = clamp(x / h - 0.5, 0, W - 1);
  const gy = clamp(y / h - 0.5, 0, H - 1);
  const i0 = clamp(Math.floor(gx), 0, Math.max(0, W - 2)), j0 = clamp(Math.floor(gy), 0, Math.max(0, H - 2));
  const tx = gx - i0, ty = gy - j0;
  const r0 = j0 * W, r1 = (j0 + 1) * W;
  const a = s[i0 + r0]!, b = s[i0 + 1 + r0]!, c = s[i0 + r1]!, d = s[i0 + 1 + r1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Air speed in m/s at a cell centre — for arrows, tests and readouts. */
export function speedAt(f: Fluid, i: number, j: number): number {
  const { W } = f;
  const ux = (f.u[i + j * (W + 1)]! + f.u[i + 1 + j * (W + 1)]!) * 0.5;
  const vy = (f.v[i + j * W]! + f.v[i + (j + 1) * W]!) * 0.5;
  return Math.hypot(ux, vy);
}

/** Air velocity at a cell centre, written into `out`. */
export function velocityAt(f: Fluid, i: number, j: number, out: { x: number; y: number }): void {
  const { W } = f;
  out.x = (f.u[i + j * (W + 1)]! + f.u[i + 1 + j * (W + 1)]!) * 0.5;
  out.y = (f.v[i + j * W]! + f.v[i + (j + 1) * W]!) * 0.5;
}

/** Push on the air inside a rectangle of cells. Fans call this before step(). */
export function addForce(
  f: Fluid, i0: number, j0: number, i1: number, j1: number, ax: number, ay: number, dt: number,
): void {
  const { W, H, u, v, uFlag, vFlag } = f;
  const a = clamp(i0, 0, W - 1), b = clamp(i1, 0, W - 1);
  const c = clamp(j0, 0, H - 1), d = clamp(j1, 0, H - 1);
  for (let j = c; j <= d; j++) {
    for (let i = a; i <= b; i++) {
      if (f.solid[i + j * W]) continue;
      if (ax !== 0) {
        const kl = i + j * (W + 1), kr = i + 1 + j * (W + 1);
        if (uFlag[kl] === FREE) u[kl]! += ax * dt;
        if (uFlag[kr] === FREE) u[kr]! += ax * dt;
      }
      if (ay !== 0) {
        const kt = i + j * W, kb = i + (j + 1) * W;
        if (vFlag[kt] === FREE) v[kt]! += ay * dt;
        if (vFlag[kb] === FREE) v[kb]! += ay * dt;
      }
    }
  }
}

/**
 * Make the velocity field divergence-free.
 *
 * Solves for a potential p with  p_c = (sum of open neighbours - h^2 * div_c) / n
 * by Gauss-Seidel, then subtracts its gradient. SOLID and FIXED faces are not
 * neighbours (nothing may flow through a wall, and a vent's rate is not the
 * solver's to change), but a FIXED face's velocity is in `div`, so its air has
 * to be accounted for somewhere.
 *
 * `p` is deliberately NOT cleared between ticks: the flow settles down, so last
 * tick's answer is a good first guess and 30 sweeps do what a cold solve would
 * need hundreds for.
 */
export function project(f: Fluid, iters: number): void {
  const { W, H, h, u, v, uFlag, vFlag, p, div, nbr, nbrN } = f;

  /* div is stored PRE-MULTIPLIED by h^2, because that is the only form the
     sweep below ever wants it in. */
  const hh = h * h;
  for (let j = 0; j < H; j++) {
    const row = j * W, urow = j * (W + 1);
    for (let i = 0; i < W; i++) {
      const c = row + i;
      if (nbrN[c] === 0) { div[c] = 0; p[c] = 0; continue; }
      const ul = u[i + urow]!, ur = u[i + 1 + urow]!;
      const vt = v[c]!, vb = v[c + W]!;
      div[c] = hh * (ur - ul + vb - vt) / h;
    }
  }

  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const c = row + i;
        const n = nbrN[c]!;
        if (n === 0) continue;
        const m = nbr[c]!;
        let sum = 0;
        if (m & 1) sum += p[c - 1]!;
        if (m & 2) sum += p[c + 1]!;
        if (m & 4) sum += p[c - W]!;
        if (m & 8) sum += p[c + W]!;
        p[c] = (sum - div[c]!) * INV_N[n]!;
      }
    }
  }

  for (let j = 0; j < H; j++) {
    for (let i = 1; i < W; i++) {
      const k = i + j * (W + 1);
      if (uFlag[k] !== FREE) continue;
      u[k]! -= (p[i + j * W]! - p[i - 1 + j * W]!) / h;
    }
  }
  for (let j = 1; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = i + j * W;
      if (vFlag[k] !== FREE) continue;
      v[k]! -= (p[i + j * W]! - p[i + (j - 1) * W]!) / h;
    }
  }
}

/** Total |divergence| left in the fluid cells — the honesty check for project(). */
export function totalDivergence(f: Fluid): number {
  const { W, H, h, solid, u, v } = f;
  let sum = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (solid[i + j * W] || f.open[i + j * W]) continue;
      const ul = u[i + j * (W + 1)]!, ur = u[i + 1 + j * (W + 1)]!;
      const vt = v[i + j * W]!, vb = v[i + (j + 1) * W]!;
      sum += Math.abs((ur - ul + vb - vt) / h);
    }
  }
  return sum;
}

function advectVelocity(f: Fluid, dt: number): void {
  const { W, H, h, u, v, uTmp, vTmp, uFlag, vFlag } = f;

  for (let j = 0; j < H; j++) {
    for (let i = 0; i <= W; i++) {
      const k = i + j * (W + 1);
      if (uFlag[k] !== FREE) { uTmp[k] = u[k]!; continue; }
      const x = i * h, y = (j + 0.5) * h;
      const px = x - u[k]! * dt, py = y - sampleV(f, x, y) * dt;
      uTmp[k] = sampleU(f, px, py);
    }
  }
  for (let j = 0; j <= H; j++) {
    for (let i = 0; i < W; i++) {
      const k = i + j * W;
      if (vFlag[k] !== FREE) { vTmp[k] = v[k]!; continue; }
      const x = (i + 0.5) * h, y = j * h;
      const px = x - sampleU(f, x, y) * dt, py = y - v[k]! * dt;
      vTmp[k] = sampleV(f, px, py);
    }
  }
  u.set(uTmp);
  v.set(vTmp);
}

function advectScent(f: Fluid, dt: number): void {
  const { W, H, h, solid, d, dTmp } = f;
  const vel = { x: 0, y: 0 };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = i + j * W;
      if (solid[c]) { dTmp[c] = 0; continue; }
      velocityAt(f, i, j, vel);
      const px = (i + 0.5) * h - vel.x * dt;
      const py = (j + 0.5) * h - vel.y * dt;
      /* If the backtrace lands inside a wall there is nothing there to have
         come from, and sampling it would quietly eat scent along every surface.
         Hold the cell's own value instead. */
      const si = clamp(Math.floor(px / h), 0, W - 1);
      const sj = clamp(Math.floor(py / h), 0, H - 1);
      dTmp[c] = solid[si + sj * W] ? d[c]! : sampleScalar(f, d, px, py);
    }
  }
  d.set(dTmp);
}

function smoothScent(f: Fluid, amount: number): void {
  if (amount <= 0) return;
  const { W, H, solid, d, dTmp } = f;
  dTmp.set(d);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = i + j * W;
      if (solid[c]) continue;
      let sum = 0, n = 0;
      if (i > 0 && !solid[c - 1]) { sum += dTmp[c - 1]!; n++; }
      if (i < W - 1 && !solid[c + 1]) { sum += dTmp[c + 1]!; n++; }
      if (j > 0 && !solid[c - W]) { sum += dTmp[c - W]!; n++; }
      if (j < H - 1 && !solid[c + W]) { sum += dTmp[c + W]!; n++; }
      if (n > 0) d[c] = dTmp[c]! + (sum / n - dTmp[c]!) * amount;
    }
  }
}

/**
 * One tick. Forces (fans) go in BEFORE this via addForce; sources (the vent)
 * go in after, because the vent sets its scent rather than adding to it.
 */
export function step(f: Fluid, dt: number, o: StepOpts): void {
  const { u, v, uFlag, vFlag } = f;

  // friction: what gives a fan a terminal speed instead of an ever-rising one
  const keep = 1 / (1 + o.drag * dt);
  for (let k = 0; k < u.length; k++) if (uFlag[k] === FREE) u[k]! *= keep;
  for (let k = 0; k < v.length; k++) if (vFlag[k] === FREE) v[k]! *= keep;

  advectVelocity(f, dt);
  enforceFaces(f);
  project(f, o.iters);
  enforceFaces(f);

  const lim = o.maxSpeed;
  for (let k = 0; k < u.length; k++) if (uFlag[k] === FREE) u[k] = clamp(u[k]!, -lim, lim);
  for (let k = 0; k < v.length; k++) if (vFlag[k] === FREE) v[k] = clamp(v[k]!, -lim, lim);

  advectScent(f, dt);
  smoothScent(f, o.diffuse);

  const { d, decay, solid } = f;
  for (let c = 0; c < d.length; c++) {
    if (solid[c] || f.open[c]) { d[c] = 0; continue; }   // what arrives from outside is fresh
    d[c] = clamp(d[c]! * Math.exp(-decay[c]! * dt), 0, 1);
  }
}
