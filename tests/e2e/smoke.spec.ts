/* smoke.spec.ts — proves the whole stack is wired, in a real browser.

   THE STANDING RULE this encodes: never verify a canvas with a naive screenshot.
   A crashed game and a healthy paused one look identical. So every check here
   drives to a KNOWN state — reset, exact tick count — and only then asserts.

   Run: npm run e2e     (the hub owns the dev server; start it first) */

import { expect, test } from '@playwright/test';

const HOME = './?nosync=1';
const DOORS = ['d-living', 'd-bed', 'd-study', 'd-kitchen', 'd-bath'];

async function toPlay(page: import('@playwright/test').Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(async () => {
    await (window.DBG as any).scenes.settled();
    window.DBG!.pause(true);
    (window.DBG as any).reset('e2e');
    (window.DBG as any).inspector?.show(false);
  });
}

/** Open every interior door, run for `secs`, hand back the state. */
async function settle(page: import('@playwright/test').Page, secs: number, doors = DOORS) {
  return page.evaluate(({ list, n }) => {
    for (const d of list) (window.DBG as any).open(d, 1);
    window.DBG!.step(n);
    return window.DBG!.state();
  }, { list: doors, n: secs * 60 }) as Promise<any>;
}

test('boots, runs deterministically, and paints the puffs', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await toPlay(page);
  const state = await settle(page, 60);

  expect(state.scene).toBe('play');
  expect(state.puffs).toBeGreaterThan(1000);
  expect(state.share['Living room']).toBeGreaterThan(1);   // more than its share
  expect(state.share['Hall']).toBeGreaterThan(0.02);

  // same reset, same steps, same houseful of puffs — down to the count
  const again = await page.evaluate(async () => {
    (window.DBG as any).reset('e2e');
    for (const d of ['d-living', 'd-bed', 'd-study', 'd-kitchen', 'd-bath']) (window.DBG as any).open(d, 1);
    window.DBG!.step(3600);
    return window.DBG!.state();
  }) as any;
  expect(again.puffs).toBe(state.puffs);
  expect(again.share['Hall']).toBe(state.share['Hall']);

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

test('a shut house keeps it all in one room; open doors let it out', async ({ page }) => {
  await toPlay(page);

  const shut = await page.evaluate(() => {
    for (const d of ['d-living', 'd-bed', 'd-study', 'd-kitchen', 'd-bath']) (window.DBG as any).open(d, 0);
    window.DBG!.step(3600);
    return window.DBG!.state();
  }) as any;
  expect(shut.share['Living room']).toBeGreaterThan(2);
  expect(shut.share['Bathroom']).toBeLessThan(0.01);

  await page.evaluate(() => (window.DBG as any).reset('e2e'));
  const open = await settle(page, 60);
  expect(open.share['Living room']).toBeLessThan(shut.share['Living room']);
  expect(open.share['Hall']).toBeGreaterThan(shut.share['Hall']);
});

test('fans even the house out', async ({ page }) => {
  await toPlay(page);
  const bare = await settle(page, 90);

  await page.evaluate(() => (window.DBG as any).reset('e2e'));
  const fanned = await page.evaluate(() => {
    for (const d of ['d-living', 'd-bed', 'd-study', 'd-kitchen', 'd-bath']) (window.DBG as any).open(d, 1);
    (window.DBG as any).fan(3.6, 4.0);
    (window.DBG as any).fan(7.2, 4.0);
    window.DBG!.step(5400);
    return window.DBG!.state();
  }) as any;

  expect(fanned.fans).toBe(2);
  expect(fanned.worst).toBeGreaterThan(bare.worst * 2);
  expect(fanned.share['Living room']).toBeLessThan(bare.share['Living room']);
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
