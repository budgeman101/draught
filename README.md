# game-template

The starting point for a Game Ideas browser prototype. **Instantiate it, don't fork it.**

```bash
npx degit budgeman101/game-ideas-meta/template my-game
cd my-game
npm install
echo 8440 > .devport        # claim a port from the registry in CLAUDE.md
npm run dev
```

You get a game that already runs: a mote orbiting a star, a HUD reading off it, a
live tuning panel, persisted settings, a passing test suite and a screenshot
script. Delete the example as you replace it — the point is that no wire in the
stack is unproven when you start.

---

## Why this exists

Every prototype used to begin on a bare 2D canvas with a hand-rolled save system
and buttons drawn by hand into the pixels. That is the worst possible starting
surface, and it was a *choice we never actually made* — there was no build step,
so there was no npm, so everything had to be written from scratch.

Vite is the piece that unlocked the rest. Roughly a sixth of what's here is code
we own; the remainder is maintained libraries that update themselves.

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Vite dev server with HMR, on the port in `.devport` |
| `npm run build` | static bundle into `dist/` |
| `npm run preview` | serve the built bundle (port + 1) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest — the sim, in node, no browser |
| `npm run e2e` | Playwright — the real browser, desktop and phone |
| `npm run shot` | drive to a known state and screenshot to `shots/` |
| `npm run share` | put it on the tailnet for someone else to play |
| `npm run refresh` | pull toolchain fixes from the canonical template |

## Layout

```
project.mjs     WHERE this project lives: dev port, hub slug, /p/<slug>/ base,
                the hub's two ports. vite.config.ts, playwright.config.ts,
                shot.mjs and share.mjs all import it instead of each working it
                out again — four copies of a fact is four chances to disagree.
src/
  kit/          ours — only what no library covers
    save.ts       versioned store + migration chain over idb-keyval
    hubsave.ts    the same save, synced through the hub, keyed to a person
    settings.ts   schema → persisted options + a panel
    chrome.ts     DOM chrome; mostly platform primitives, four real widgets
    theme.css     the look — MEANT TO DIVERGE, never overwritten by refresh
    scenes.ts     menu / play / pause — owns BOTH the DOM layer and the Pixi layer
    camera.ts     glue over pixi-viewport: loop integration + save/restore
    loop.ts       fixed timestep, pause, speed, step(n)
    rng.ts        seeded deterministic random with forkable streams
    audio.ts      bus mixer over Howler
    inspector.ts  Tweakpane bound to your CFG block
    log.ts        playtest event log
    errors.ts     dev error banner
    dbg.ts        the window.DBG surface
  game/         yours — replace all of this
    cfg.ts        every tunable number
    sim.ts        rules and state. No DOM, no Pixi. Testable in node.
    view.ts       Pixi rendering. Reads the sim, never writes it.
    main.ts       boot and wiring
```

## The conventions that matter

**Canvas board + DOM chrome.** The canvas draws the world. Everything with text on
it, or that you click, is DOM layered above via `stage()` and `overlay()`. The
browser already solves hit-testing, focus, hover, text layout and keyboard access.

**A scene owns both halves.** `ctx.el` is its DOM layer, `ctx.layer` its Pixi
container; both are destroyed on exit, so nothing leaks into the next screen.
`go()` replaces the stack, `push()` overlays and keeps the scene below mounted
and rendering (that's a pause menu over a live board), `back()` pops. Register a
**factory** rather than an object — it's re-invoked per entry, so scene state
lives in a closure and starts clean every time.

**Sim/view split.** `sim.ts` has no DOM and no Pixi, which is the only reason
`npm test` can check the rules in node in under a second.

**Everything tunable lives in `cfg.ts`.** Logic reads `CFG` and never hardcodes a
number. Press `` ` `` for the inspector, drag until it feels right, hit **Copy
CFG**, paste the block back over `cfg.ts`.

**Every run takes a seed**, and each system draws from `rng.fork('name')`. Same
seed, same run — which is what makes a stepped test meaningful.

**Never verify a canvas with a naive screenshot.** A crashed game and a healthy
paused one look identical. `npm run shot` always pauses, resets and steps an exact
number of ticks before capturing. This rule is why `raf-harness.js` was retired
rather than ported: the loop owns the accumulator, so it just exposes `step()`.

**The save follows the person, not the browser** — already, in the example, with
no wiring to do. Details below; it is something to deliberately remove, not
something to discover.

## Saves follow the person

IndexedDB is per-origin **per browser**. Left at that, the same person playing on
the desktop and on a phone has two saves of the same game, and two people sharing
one machine have one between them. Device-keyed, when what anybody means is
person-keyed.

So the hub holds the save, keyed by **tailnet login** (tailscaled sets that header
and overwrites it, so it cannot be forged) plus a **profile**. IndexedDB stays
underneath as the local copy — it is what makes the game work the instant it
loads, before any round trip, and what carries you through a blip.

One line in `main.ts`, and the example already has it:

```ts
const remote = hubRemote();
const store  = createStore({ key: 'mygame', version: 1, remote, defaults: {…} });
```

**No slug argument.** The project's name on the hub comes from `project.mjs`,
through a `define` in `vite.config.ts`, and arrives as `__HUB_SLUG__`. It was a
literal in game code once; that is the same fact in two places, and renaming a
project moved the card, the port and the URL while the save quietly kept writing
to the old key. If that define ever goes missing the game **throws on boot**
rather than syncing to a key called `undefined`.

**Profiles are picked on the shelf, never in-game.** A profile splits saves
*within one login*, and it exists for one case: Fledgling declares
`"profiles": ["sam", "testing"]` in `hub/projects.json` because it is Sam's game
and testing a change must not spend his coins. The shelf shows the picker and
loads the game as `?as=<name>`; `profileFromUrl()` reads it. Most games declare
none, get one save, and never see a picker. The argument that *is* worth passing
is a game-level default — `hubRemote(profileFromUrl('sam'))` — for a game that
has an obvious owner.

**A second device is refused, not merged.** Two tabs on one profile would
otherwise overwrite each other for as long as both were open, and you would find
out afterwards. Instead a session claims the profile and holds it with a
heartbeat; the second device loads (so you can watch) but the store goes
read-only and emits `error` with `reason: 'held-elsewhere'`. If someone takes it
over mid-session, `'taken-over'` fires and writes stop. The example toasts on
both — say something, or the right behaviour reads as a bug. An **unreachable**
hub is a different thing entirely and is not a refusal: play on, save locally.

**`?nosync=1` opts out**, and the test suite uses it. Sync is right for a person
and wrong for a suite — every test in a run would share one save and one test's
state would become the next one's failure. `tests/e2e/` and `npm run shot` both
append it, so they stay hermetic and local, exactly as they were before any of
this existed.

**The save API only exists when the hub is serving the game.** `/api/save/…` is
the hub's route, so a bare `npm run dev` on the project's own port has no sync at
all — the claim 404s, the store notices it is not a refusal, and the game runs on
its local save. That is expected, not broken. Playwright and `shot.mjs` therefore
go through `hubUrl`, not the dev origin; see `project.mjs`.

## Adding capability

Opt-in, one command each, when a game actually needs it:

| need | package |
|---|---|
| physics | `npm i @dimforge/rapier2d` — or `rapier2d-deterministic` for cross-platform determinism |
| music synthesis / sequencing | `npm i tone` |
| procedural terrain | `npm i simplex-noise delaunator` |
| authored levels | LDtk or Tiled, exported to JSON |
| rigged animation | Rive or Spine |
| sprite atlases | `npm i -D @assetpack/core` |

Deliberately absent: ECS, state management, networking, i18n, analytics.

## Keeping an old prototype alive

`package-lock.json` is committed and Node is pinned in `engines`, so a game from a
year ago still installs and runs. When a prototype is **retired**, commit its
`dist/` too — then it opens forever with no install at all.

## Refreshing an existing game

`npm run refresh` copies the toolchain and `src/kit/` from the canonical template
into the current project. It will not touch `theme.css`, `src/game/`,
`src/assets/`, `index.html`, `package.json` or `.devport` — dependency drift is
reported for you to act on, never silently applied. Use `--dry` to preview.
