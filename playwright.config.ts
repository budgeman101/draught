import { defineConfig, devices } from '@playwright/test';
import { devBase, devOrigin, hubPort, hubUrl, slug } from './project.mjs';

/* Through the HUB, not the dev server directly. The hub is how the game is
   really served, and the game talks to it for saves — pointed at the bare dev
   server those calls 404 and the suite is testing a configuration that never
   ships. The URL includes the /p/<slug>/ prefix, and getting that wrong breaks
   two things:

     1. relative page.goto('/') lands on the redirect rather than the app;
     2. more painfully, webServer.url never looks ready, so Playwright decides
        nothing is running and spawns its OWN `npm run dev` — which then dies on
        strictPort against the dev server the hub already has on this port, and
        takes the run down with it. The failures look like game bugs and are not.

   Which is why the URL is not rebuilt here: project.mjs owns it, along with the
   port, the slug and the hub's own ports. */
/* THROUGH THE HUB IF THE HUB KNOWS THIS PROJECT, otherwise straight at the dev
   server. A registered game should be tested the way it is really served — the
   hub's /p/<slug>/, where the save API exists. But the TEMPLATE ITSELF has no
   registry card (it is the base every game is cut from, not a game), so pointing
   its own suite at the hub gave a 404 and fourteen timeouts reading "DBG never
   became ready" — a dead test suite in the thing every new project is copied
   from. Ask, rather than assume either way. */
const baseURL = await hubKnows(slug) ? hubUrl : `${devOrigin}${devBase}`;

async function hubKnows(s: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${hubPort}/api/projects`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return false;
    const { projects } = await r.json() as { projects: { slug: string }[] };
    return projects.some((p) => p.slug === s);
  } catch {
    return false;               // no hub reachable: the dev server is the answer
  }
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,          // one game, one dev server — parallel gains nothing
  reporter: [['list']],
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // A phone project in the base means the layout is checked on a phone from
    // day one instead of week three. Drop it in a game that is keyboard-only.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  /* No webServer block on purpose. The HUB owns dev servers — if Playwright
     spawns its own it fights the hub's for the port, dies on strictPort, and the
     failures read as game bugs. If the suite cannot connect, the server simply is
     not running: start it from the hub (node ../hub/scripts/ctl.mjs start <slug>). */
});
