/* shot.mjs — drive the game to a known state and screenshot it.

   The replacement for the old serve.py /snap endpoint, and the tool an agent uses
   to actually LOOK at the game. It always pauses, resets and steps an exact
   number of ticks before capturing, because the standing rule is: never verify a
   canvas with a naive screenshot — a crashed game and a healthy paused one look
   identical.

     npm run shot                                  # 600 ticks, desktop
     npm run shot -- --scene play                  # switch scene first
     npm run shot -- --steps 1200 --out late.png
     npm run shot -- --phone
     npm run shot -- --eval "DBG.sim.laps = 9"     # arrange a state first
     npm run shot -- --live                        # no pause/reset: capture as-is

   Asks the HUB to start the dev server if one is not already up; never spawns
   its own. */

import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { port as PORT, slug as SLUG, devBase, devOrigin, hubControl, ctlStart } from '../project.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : args[i + 1]) : fallback;
};
const has = (name) => args.includes(`--${name}`);

/* Port, slug and base come from project.mjs — see the header there. A bare '/'
   would still work on the dev server (Vite redirects it to the base), but
   `--url /haul.html` would land OUTSIDE the base and 404, so join the two here
   rather than leave a trap for the first multi-page project. */
/* ?nosync=1 — same opt-out the e2e suite uses. A shot talks to the dev server
   directly, where the hub's save API does not exist, so without this every run
   logs two 404s and reports console errors for a thing that is working exactly
   as designed. A capture also WANTS local-only state: it is driving to a known
   state, not resuming somebody's game. */
const QUERY = String(flag('url', '/')).includes('?') ? '&nosync=1' : '?nosync=1';
const URL_PATH = devBase + String(flag('url', '/')).replace(/^\/+/, '') + QUERY;
const STEPS = Number(flag('steps', 600));
const OUT = String(flag('out', 'shot.png'));
const EVAL = flag('eval', null);
const SCENE = flag('scene', null);
const LIVE = has('live');
const PHONE = has('phone');
const SIZE = flag('size', null);

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.end(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(400, () => { s.destroy(); resolve(false); });
});

/* ASK THE HUB. The hub owns dev servers; a vite this script spawned behind its
   back shows on the shelf as "broken — not from a process the hub started",
   which is a confusing way to learn your screenshot tool left a stray running. */
async function askHub() {
  try {
    const r = await fetch(`${hubControl}/api/start/${SLUG}`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    for (let i = 0; i < 60; i++) {
      if (await portOpen(PORT)) return true;
      await new Promise((r2) => setTimeout(r2, 500));
    }
  } catch { /* no hub, or it does not manage this project */ }
  return false;
}

/** What the hub thinks the state of this project is, or null if it cannot say.
    An open port is NOT proof the hub owns what is behind it. */
async function hubState() {
  try {
    const r = await fetch(`${hubControl}/api/projects`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const body = await r.json();
    return body.projects?.find((p) => p.slug === SLUG) ?? null;
  } catch { return null; }
}

/* NEVER SPAWNS. A vite this script started is an orphan the hub cannot manage,
   and killing it afterwards can take down a server someone else is using. If the
   hub cannot start it, say so and stop — a loud failure beats a stray process.

   ⚠ AND IT MUST NOT SILENTLY RIDE AN ORPHAN EITHER, which is the hole this
   used to have: `if (portOpen) return` accepted ANY listener, so a stray
   `npm run dev` from days ago served every screenshot while the shelf showed
   the project as broken — "port 8391 is already serving, but not from a
   process the hub started, so its health cannot be reported." The shots were
   fine and the workspace was quietly wrong, which is the worst combination.
   Now an open port the hub does not own is said out loud. */
async function requireServer() {
  if (await portOpen(PORT)) {
    const st = await hubState();
    if (st && st.state !== 'running') {
      console.warn(`[shot] ⚠ ${PORT} is serving, but the hub does not own it (hub says "${st.state}").`);
      console.warn('[shot]   That is an orphan — probably a hand-run `npm run dev`. On the shelf');
      console.warn('[shot]   this project reads as BROKEN. Stop that process, then:');
      console.warn(`[shot]     ${ctlStart}`);
    }
    return;
  }
  if (await askHub()) { console.log(`[shot] hub started ${SLUG} on ${PORT}`); return; }
  console.error(`[shot] nothing serving on ${PORT}, and the hub could not start it.`);
  console.error('[shot] the hub owns the dev servers — start it there:');
  console.error(`[shot]     ${ctlStart}`);
  process.exit(1);
}

await requireServer();
const browser = await chromium.launch();
const context = await browser.newContext(
  PHONE ? devices['Pixel 7']
        : { viewport: SIZE ? { width: +String(SIZE).split('x')[0], height: +String(SIZE).split('x')[1] } : { width: 1280, height: 800 } },
);
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(devOrigin + URL_PATH, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DBG?.ready === true, null, { timeout: 20_000 });

  if (SCENE && typeof SCENE === 'string') {
    await page.evaluate(async (name) => {
      await window.DBG.scenes.go(name);
      await window.DBG.scenes.settled();
    }, SCENE);
  }

  /* ORDER MATTERS, and it was wrong here: --eval used to run BEFORE reset(),
     so the reset wiped whatever it had arranged and the flag's own documented
     purpose — "arrange a state first" — could not work. A capture that
     silently ignores half its instructions is the same failure as a screenshot
     that silently rides an orphan server. Reset establishes the known
     baseline; the eval arranges the state ON it; then we step. */
  if (!LIVE) {
    await page.evaluate(() => { window.DBG.pause(true); window.DBG.reset?.(); });
  }

  if (EVAL && typeof EVAL === 'string') await page.evaluate(EVAL);

  if (!LIVE) await page.evaluate((n) => { window.DBG.step(n); }, STEPS);
  else await page.waitForTimeout(400);

  // let the inspector's sampler tick at least once, so its readouts in the
  // captured image match the state we just stepped to instead of lagging it
  await page.waitForTimeout(300);

  mkdirSync('shots', { recursive: true });
  const out = path.join('shots', OUT);
  await page.screenshot({ path: out });

  const state = await page.evaluate(() => window.DBG.state());
  console.log(`[shot] ${out}`);
  console.log('[shot] state:', JSON.stringify(state));
  if (errors.length) {
    console.error(`[shot] ${errors.length} console error(s):`);
    for (const e of errors) console.error('  ' + e);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  // nothing to kill: this script never starts a server, the hub does
}
