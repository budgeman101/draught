/* smoke.spec.ts — proves the whole stack is wired, in a real browser.

   THE STANDING RULE this encodes: never verify a canvas with a naive screenshot.
   A crashed game and a healthy paused one look identical. So every check here
   drives to a KNOWN state — right scene, reset, exact tick count — and only then
   asserts or captures.

   Run: npm run e2e     (Vite is started automatically) */

import { expect, test } from '@playwright/test';

/* './' NOT '/'. baseURL is the hub's /p/<slug>/, and a leading slash resolves
   against the ORIGIN — a bare goto('/') lands on the hub's shelf, gets a
   cheerful 200 with no game in it, and then fails twenty seconds later as
   "DBG never became ready". That reads as a game bug and is not one.

   ?nosync=1: local save only, no hub. The game syncs its save through the hub by
   default, keyed to a person rather than a browser — which is exactly right for
   a player and exactly wrong for a suite: every test in the run would share one
   save, and one test's state becomes the next one's failure. Tests opt out and
   keep their own IndexedDB per context. */
const HOME = './?nosync=1';

/** Boot, then get to `play` with the sim reset and the clock stopped. */
async function toPlay(page: import('@playwright/test').Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(async () => {
    await (window.DBG as any).scenes.go('play');
    await (window.DBG as any).scenes.settled();
    window.DBG!.pause(true);
    (window.DBG as any).reset();
  });
}

test('boots, runs deterministically, and renders', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await toPlay(page);

  // advance EXACTLY ten seconds of sim time, with no clock involved
  const state = await page.evaluate(() => { window.DBG!.step(600); return window.DBG!.state(); });

  // 10s at CFG.orbitSpeed (0.9 rad/s) = 9 rad = 1 complete turn
  expect(state.laps).toBe(1);
  expect(state.t).toBeCloseTo(10, 5);
  expect(state.scene).toBe('play');
  expect(state.seed).toBeTruthy();

  // same reset, same steps, same position — the reproducibility contract
  const again = await page.evaluate(() => {
    (window.DBG as any).reset();
    window.DBG!.step(600);
    return window.DBG!.state();
  });
  expect(again.x).toBe(state.x);
  expect(again.y).toBe(state.y);

  // the HUD is DOM, so it can be READ rather than squinted at in pixels
  await expect(page.locator('.kit-readout').first()).toContainText('1');

  const painted = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(painted.w).toBeGreaterThan(0);
  expect(painted.h).toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('board.png') });
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('pause freezes the sim immediately, with no backlog', async ({ page }) => {
  // Regression: the accumulator used to keep DRAINING while paused, so a long
  // frame (a scene transition, a GC pause) left a debt that fired a burst of
  // ticks after the player had already hit pause.
  await toPlay(page);
  const r = await page.evaluate(async () => {
    const before = { t: window.DBG!.state().t, ticks: window.DBG!.loop.stats().ticks };
    await new Promise((res) => requestAnimationFrame(res));
    await new Promise((res) => requestAnimationFrame(res));
    await new Promise((res) => setTimeout(res, 120));
    return { before, after: { t: window.DBG!.state().t, ticks: window.DBG!.loop.stats().ticks } };
  });
  expect(r.after.ticks).toBe(r.before.ticks);
  expect(r.after.t).toBe(r.before.t);
});

test('scenes: push keeps the board alive, go tears it down', async ({ page }) => {
  await toPlay(page);
  await page.evaluate(() => window.DBG!.step(300));

  // push(pause): the play scene stays mounted underneath
  const pushed = await page.evaluate(async () => {
    await (window.DBG as any).scenes.push('pause');
    await (window.DBG as any).scenes.settled();
    return { stack: (window.DBG as any).scenes.stack, laps: window.DBG!.state().laps };
  });
  expect(pushed.stack).toEqual(['play', 'pause']);
  expect(pushed.stack.length).toBe(2);

  // both scene DOM layers exist at once
  expect(await page.locator('.kit-scene').count()).toBe(2);

  // back(): the overlay pops and play is live again, at the same lap
  const popped = await page.evaluate(async () => {
    await (window.DBG as any).scenes.back();
    await (window.DBG as any).scenes.settled();
    return { stack: (window.DBG as any).scenes.stack, laps: window.DBG!.state().laps };
  });
  expect(popped.stack).toEqual(['play']);
  expect(popped.laps).toBe(pushed.laps);          // the board was never rebuilt

  // go(menu): the play scene is gone, not stacked
  const replaced = await page.evaluate(async () => {
    await (window.DBG as any).scenes.go('menu');
    await (window.DBG as any).scenes.settled();
    return { stack: (window.DBG as any).scenes.stack, scene: window.DBG!.state().scene };
  });
  expect(replaced.stack).toEqual(['menu']);
  expect(replaced.scene).toBe('menu');
  expect(await page.locator('.kit-scene').count()).toBe(1);
});

test('camera: pans and zooms, and the view survives a reload', async ({ page }) => {
  await toPlay(page);

  const moved = await page.evaluate(() => {
    const cam = (window.DBG as any).cam;
    cam.setZoom(2.5).moveTo(120, -60);
    return { zoom: cam.zoom, x: cam.center.x, y: cam.center.y };
  });
  expect(moved.zoom).toBeCloseTo(2.5, 3);
  expect(moved.x).toBeCloseTo(120, 3);

  // clampZoom must refuse to go past the configured ceiling
  const clamped = await page.evaluate(() => {
    const cam = (window.DBG as any).cam;
    cam.setZoom(99);
    return cam.zoom;
  });
  expect(clamped).toBeLessThanOrEqual(5);

  // leaving play persists the camera; coming back restores it
  await page.evaluate(async () => {
    const cam = (window.DBG as any).cam;
    cam.setZoom(2).moveTo(80, 40);
    await (window.DBG as any).scenes.go('menu');
    await (window.DBG as any).scenes.settled();
  });
  await page.reload();
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });
  const restored = await page.evaluate(async () => {
    await (window.DBG as any).scenes.go('play');
    await (window.DBG as any).scenes.settled();
    const cam = (window.DBG as any).cam;
    return { zoom: cam.zoom, x: cam.center.x, y: cam.center.y };
  });
  expect(restored.zoom).toBeCloseTo(2, 1);
  expect(restored.x).toBeCloseTo(80, 0);
});

test('settings persist across a reload', async ({ page }) => {
  await page.goto(HOME);
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });

  await page.evaluate(() => (window.DBG as any).settings.set('trails', false));
  await page.waitForTimeout(150);                     // let the idb write land

  await page.reload();
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });

  const trails = await page.evaluate(() => (window.DBG as any).settings.get('trails'));
  expect(trails).toBe(false);

  await page.evaluate(() => (window.DBG as any).settings.set('trails', true));
});
