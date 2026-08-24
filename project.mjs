/* project.mjs — the single source of truth for WHERE THIS PROJECT LIVES.

   Five facts say that: the dev PORT, the hub SLUG, the BASE path the hub serves
   this project under, and the hub's own two ports. Four files need them —
   vite.config.ts, playwright.config.ts, scripts/shot.mjs, scripts/share.mjs —
   and each one used to work them out again from .devport and .hubslug. Three of
   them carried a comment saying "keep this identical to vite.config.ts", which
   is the honest admission that nothing was keeping them identical. When the hub
   started fronting every prototype at /p/<slug>/, two of the four copies were
   updated and two were not; a wrong base path fails as a 404, and a 404 in a
   test run reads like a game bug, which is the expensive kind of wrong. Four
   copies of a fact is four chances to disagree about it, so there is now one.

   Plain .mjs and not .ts on purpose. vite.config.ts and playwright.config.ts
   each go through their own TypeScript transform, but shot.mjs and share.mjs are
   run by bare `node` with no build step — .mjs is the one form all three loaders
   read as-is. tsconfig has allowJs, so the two configs still typecheck against
   it and still get inferred types out of it.

   Everything resolves against THIS FILE rather than the cwd, so the answer does
   not depend on which directory the command was typed in. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root — the directory this file sits in, by definition. */
export const root = path.dirname(fileURLToPath(import.meta.url));

const dotfile = (name) => {
  const p = path.join(root, name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};

/* PORT: from .devport, so every project keeps its own fixed port exactly as the
   old serve.py did. It is not a preference — hub/projects.json is the registry
   that hands ports out, .devport is generated from it, and the tailnet URL you
   just shared depends on the number not moving. 5173 (Vite's own default) is
   only ever reached by a project that has no .devport yet. */
export const port = Number(dotfile('.devport') ?? 5173);

/* SLUG: the name this project answers to on the hub's shelf. Almost always the
   folder name; .hubslug exists for the cases where the folder is called one
   thing and the project is called another. */
export const slug = dotfile('.hubslug') || path.basename(root);

/* DEV BASE: the hub fronts every prototype at /p/<slug>/ so one tailnet URL can
   reach all of them. A Vite dev server emits ROOT-ABSOLUTE urls — /@vite/client,
   /src/main.ts, /node_modules/.vite/deps/* — which 404 behind a path prefix, so
   the dev server has to be told the prefix it is living under. Direct access on
   http://127.0.0.1:<port>/ keeps working: Vite redirects / to the base. */
export const devBase = `/p/${slug}/`;

/* BUILD BASE: emphatically NOT the dev base. A frozen prototype commits dist/
   and has to open from a file:// path or any folder someone drops it in, and a
   /p/<slug>/ base breaks that. This one is a constant; it lives here so nobody
   "fixes the inconsistency" by making the build match the dev server. */
export const buildBase = './';

/* THE HUB's two listeners, kept apart on purpose (see hub/README.md): 8300 is
   the read-only shelf that tailscale serve points at, 8301 is the control API
   that spawns processes and is therefore loopback-only and never exposed. The
   env overrides are for pointing a run at a hub somewhere else; the defaults are
   what everything actually uses. */
export const hubPort = Number(process.env.HUB_PORT || 8300);
export const hubControlPort = Number(process.env.HUB_CONTROL_PORT || 8301);
export const hubControl = process.env.HUB_CONTROL || `http://127.0.0.1:${hubControlPort}`;

/** The dev server's own origin — no base path, join devBase onto it yourself. */
export const devOrigin = `http://127.0.0.1:${port}`;

/** This project as the hub serves it: how the game is really reached. */
export const hubUrl = `http://127.0.0.1:${hubPort}${devBase}`;

/* The one command that starts this project's dev server. The hub owns dev
   servers — anything else spawning one leaves a stray it cannot manage — so
   every "nothing is running" message ends by printing this. */
export const ctlStart = `node ../hub/scripts/ctl.mjs start ${slug}`;
