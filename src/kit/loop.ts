/* loop.ts — fixed-timestep game loop with pause, speed, and deterministic stepping.

   WHY FIXED TIMESTEP: a variable dt makes the sim behave differently at 144Hz than
   at 60Hz, and a stutter can tunnel a moving thing through a wall. Real time is
   accumulated and update() runs in equal slices — framerate-independent, and
   reproducible, which is what makes a seeded run verifiable.

   step(n) is the verification hook: it advances the sim n exact ticks with no
   clock involved at all. Playwright drives it through window.DBG. This is why we
   no longer need a harness patching requestAnimationFrame from outside — the loop
   owns the accumulator, so it can just expose stepping itself.

   THE STANDING RULE it serves: never verify a canvas with a naive screenshot. A
   crashed game and a healthy paused one look identical. Step deliberately, then
   capture. */

export interface LoopOptions {
  update?: (dt: number) => void;
  /** alpha = 0..1 progress toward the next tick, for interpolated rendering. */
  render?: (alpha: number) => void;
  fixed?: number;
  maxFrame?: number;
  maxTicks?: number;
  speed?: number;
}

export interface LoopStats {
  fps: number; frames: number; ticks: number;
  running: boolean; paused: boolean; rate: number;
  msUpdate: number; msRender: number;
}

export function createLoop(opts: LoopOptions = {}) {
  const {
    update, render,
    fixed = 1 / 60,
    maxFrame = 0.25,   // clamp a long stall so we don't spiral catching up
    maxTicks = 8,      // hard cap on catch-up ticks per frame
    speed = 1,
  } = opts;

  let running = false, paused = false, rate = speed;
  let rafId = 0, last = 0, acc = 0;
  let frames = 0, ticks = 0, fps = 0, fpsAcc = 0, fpsFrames = 0;
  let msUpdate = 0, msRender = 0;

  const now = () => performance.now();

  function frame(t: number) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    let dt = (t - last) / 1000;
    last = t;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > maxFrame) dt = maxFrame;

    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

    const t0 = now();
    // `!paused` guards the DRAIN too, not just the fill. Leaving the drain
    // outside it means a backlog built up before the pause still fires ticks
    // afterwards — hit pause after a hitch and the sim jumps a tenth of a
    // second while "paused", which also makes step() non-reproducible.
    if (update && !paused) {
      acc += dt * rate;
      let n = 0;
      while (acc >= fixed && n < maxTicks) { update(fixed); acc -= fixed; ticks++; n++; }
      // hit the cap and still behind: we've given up catching up, so drop the
      // debt rather than carry a backlog that never clears
      if (n === maxTicks && acc >= fixed) acc = 0;
    }
    const t1 = now();
    if (render) render(acc / fixed);
    const t2 = now();

    msUpdate = t1 - t0; msRender = t2 - t1;
    frames++;
  }

  const api = {
    start() {
      if (running) return api;
      running = true; last = now(); acc = 0;
      rafId = requestAnimationFrame(frame);
      return api;
    },
    stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = 0; return api; },
    pause(on = true) {
      // drop any accumulated debt on the way in, so resuming can't fast-forward
      if (on && !paused) acc = 0;
      paused = on;
      return api;
    },
    resume() { paused = false; return api; },
    toggle() { api.pause(!paused); return paused; },
    /** Sim-time multiplier. Render still runs every frame. */
    speed(v?: number) { if (v != null) rate = Math.max(0, v); return rate; },

    /**
     * Advance the sim by exactly n ticks, with no clock. Deterministic, instant,
     * and works whether or not the loop is running — the verification hook.
     */
    step(n = 1) {
      for (let i = 0; i < n; i++) { update?.(fixed); ticks++; }
      render?.(0);
      return api;
    },

    stats: (): LoopStats => ({
      fps, frames, ticks, running, paused, rate,
      msUpdate: +msUpdate.toFixed(2), msRender: +msRender.toFixed(2),
    }),
    get running() { return running; },
    get paused() { return paused; },
    get fixed() { return fixed; },
  };

  return api;
}

export type Loop = ReturnType<typeof createLoop>;
