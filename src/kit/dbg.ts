/* dbg.ts — the window.DBG surface.

   This is how the game is driven WITHOUT a mouse: by Playwright in `npm run e2e`
   and `npm run shot`, and by you in the console. It replaces the old raf-harness
   entirely, because the loop already owns the accumulator and can just expose
   step() — no patching of requestAnimationFrame from outside required.

   THE STANDING RULE it exists to serve: never verify a canvas with a naive
   screenshot. A crashed game and a healthy paused one look identical. Drive to a
   known state with DBG.step(n), THEN capture.

     await page.waitForFunction(() => window.DBG?.ready);
     await page.evaluate(() => window.DBG.step(600));   // 10 exact seconds
     await page.screenshot({ path: 'shots/board.png' });

   Keep it exposed in production builds too — it costs nothing and it's how you
   diagnose a build someone else is playing. */

import type { Loop } from './loop.js';

export interface DbgSurface {
  ready: boolean;
  loop: Loop;
  /** Advance the sim by exactly n ticks. Deterministic — no clock involved. */
  step: (n?: number) => void;
  pause: (on?: boolean) => void;
  speed: (v?: number) => number;
  /** A JSON-safe snapshot for assertions. */
  state: () => Record<string, unknown>;
  [key: string]: unknown;
}

declare global {
  interface Window { DBG?: DbgSurface }
}

export function installDbg(parts: {
  loop: Loop;
  /** Anything you want reachable — sim, cfg, store, settings, log, view. */
  expose?: Record<string, unknown>;
  /** What a test should be able to assert on. Keep it JSON-safe. */
  state?: () => Record<string, unknown>;
}): DbgSurface {
  const { loop, expose = {}, state } = parts;

  const dbg: DbgSurface = {
    ready: true,
    loop,
    step: (n = 1) => { loop.step(n); },
    pause: (on = true) => { loop.pause(on); },
    speed: (v?: number) => loop.speed(v),
    state: () => ({ ...loop.stats(), ...(state?.() ?? {}) }),
  };

  // defineProperties, not spread: spreading INVOKES a getter and copies the
  // result, so `{ get sim() { return scenes.active.sim } }` would freeze on
  // whatever scene happened to be active at boot. This keeps it live.
  Object.defineProperties(dbg, Object.getOwnPropertyDescriptors(expose));

  window.DBG = dbg;
  return dbg;
}
