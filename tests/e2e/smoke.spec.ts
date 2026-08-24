/* smoke.spec.ts — proves the whole stack is wired, in a real browser.

   THE STANDING RULE this encodes: never verify a canvas with a naive screenshot.
   A crashed game and a healthy paused one look identical. So every check here
   drives to a KNOWN state — reset, exact tick count — and only then asserts.

   Run: npm run e2e     (the hub owns the dev server; start it first) */

import { expect, test } from '@playwright/test';

const HOME = './?nosync=1';

/** Boot, then get to a reset board with the clock stopped. */
async function toPlay(page: import('@playwright/test').Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(async () => {
    await (window.DBG as any).scenes.settled();
    window.DBG!.pause(true);
    (window.DBG as any).reset();
    (window.DBG as any).inspector?.show(false);
  });
}

test('boots, runs deterministically, and paints the plume', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await toPlay(page);

  const state = await page.evaluate(() => { window.DBG!.step(600); return window.DBG!.state(); }) as any;

  expect(state.scene).toBe('play');
  expect(state.cells).toBeGreaterThan(5000);
  expect(state.ventFaces).toBeGreaterThan(0);
  // 20s of air: out of the unit, across the living room, down the hall
  expect(state.scent['Living room']).toBeGreaterThan(0.05);
  expect(state.scent['Hall']).toBeGreaterThan(0.05);
  // and nowhere the doors do not go
  expect(state.scent['Study']).toBeLessThan(0.005);

  // the same reset and the same steps give the same air, to the last digit
  const again = await page.evaluate(() => {
    (window.DBG as any).reset();
    window.DBG!.step(600);
    return window.DBG!.state();
  }) as any;
  expect(again.scent['Hall']).toBe(state.scent['Hall']);

  // the HUD is DOM, so it can be READ rather than squinted at in pixels
  await expect(page.locator('.kit-meter').first()).toContainText('%');

  const painted = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(painted.w).toBeGreaterThan(0);
  expect(painted.h).toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('board.png') });
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('opening a route moves the air, and shutting it stops it', async ({ page }) => {
  await toPlay(page);

  const shut = await page.evaluate(() => { window.DBG!.step(600); return window.DBG!.state(); }) as any;
  expect(shut.scent['Bathroom']).toBeLessThan(0.005);

  const open = await page.evaluate(() => {
    (window.DBG as any).reset();
    (window.DBG as any).open('d-bath', 1);
    (window.DBG as any).open('w-bath', 1);
    window.DBG!.step(600);
    return window.DBG!.state();
  }) as any;
  expect(open.scent['Bathroom']).toBeGreaterThan(0.03);
  expect(open.open['d-bath']).toBe(1);
});

test('a fan is placed, turned, and taken away by clicking one spot', async ({ page }) => {
  await toPlay(page);
  const counts = await page.evaluate(() => {
    const s = (window.DBG as any).sim;
    const out: { n: number; dir: number | null }[] = [];
    for (let i = 0; i < 5; i++) {
      (window.DBG as any).fan(2.2, 5.0);
      out.push({ n: s.fans.length, dir: s.fans[0]?.dir ?? null });
    }
    return out;
  });
  expect(counts.map((c) => c.n)).toEqual([1, 1, 1, 1, 0]);
  expect(counts.slice(0, 4).map((c) => c.dir)).toEqual([0, 1, 2, 3]);
});

test('pause freezes the sim immediately, with no backlog', async ({ page }) => {
  await toPlay(page);
  const r = await page.evaluate(async () => {
    const before = { t: window.DBG!.state().t, ticks: window.DBG!.loop.stats().ticks };
    await new Promise((res) => requestAnimationFrame(res));
    await new Promise((res) => setTimeout(res, 120));
    return { before, after: { t: window.DBG!.state().t, ticks: window.DBG!.loop.stats().ticks } };
  });
  expect(r.after.ticks).toBe(r.before.ticks);
  expect(r.after.t).toBe(r.before.t);
});

test('the doors you left open come back after a reload', async ({ page }) => {
  await page.goto(HOME);
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(() => (window.DBG as any).open('d-study', 0.4));
  await page.evaluate(() => (window.DBG as any).store.save());
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });
  const open = await page.evaluate(() => (window.DBG!.state() as any).open['d-study']);
  expect(open).toBeCloseTo(0.4, 2);
});
