# Draught

A minimum viable prototype: **spread a scent through a house** using doors and
windows you can open by any amount, and fans you drop on the floor.

The unit sits on the living room wall throwing puffs into the room. They drift,
they wander, they go through whatever gap a door leaves. Nothing else happens.

No goal, no score, no progression. This exists to answer one question: **is
spreading it around something worth doing?**

```bash
node ../hub/scripts/ctl.mjs start draught
```

Then <http://dusky-desktop.tail2719a1.ts.net/p/draught/>.

## The two verbs

| | |
|---|---|
| **Drag** a door or window along its length | sets how far it is open, 0–100% |
| **Click** the floor | drops a fan; click again to turn it a quarter; the fifth click removes it |
| **Right-click** a fan | removes it |

Each gauge is a room's share of the scent measured against the share its floor
area is worth, so **100% is exactly fair**. The house starts shut, which puts
242% in the living room and nothing anywhere else. Flattening that is the game.

## How it works, and why it is particles

Each puff has a position and a velocity. It gets thrown out of the unit, the
throw bleeds off at `CFG.drag`, and after that it does a random walk of
`CFG.diffusivity` m²/s — the one number that decides how fast a smell crosses a
still room. Fans add a push inside the box in front of them. Walls are a bitmap;
a blocked step is taken on the other axis, so puffs slide instead of piling up.
A puff that drifts outdoors is gone for good. The pool is a ring of 9000, so a
puff lives `9000 / 40 = 225` seconds before its slot is reused. There is no decay
term anywhere.

**A door is a SPAN OF CELLS, not a permeability number.** Openness is how much of
the opening is actually hole, and the hole grows from the *latch* end because
that is the side a leaf swings away from. Puffs simply go through the hole, so
how far a door is open decides how many get past — no rule needed. The drawn gap
is snapped to the same cells the bitmap uses, so what you see is what the puffs
are hitting.

### The fluid solver this replaced, and why it was wrong

The first build was a real incompressible airflow solve: staggered MAC grid,
semi-Lagrangian advection, Gauss-Seidel pressure projection. It was the most
faithful model of air available and it **forbade the thing the game is about**.
Incompressible flow puts *exactly zero* net air through a dead-end doorway, so a
bedroom off one open door could never fill. Not slowly — never.

What followed is the part worth remembering. Rather than change the model, it
grew an extract vent so the air had somewhere to go, then an envelope leak map,
then a coil model, then a decay term — each one a patch for a hole the engine
choice had dug, and none of them anything an MVP had asked for. The decay term in
particular existed only to hide that permeation was not happening.

The test that settles it is one line: *an endless source in a shut house, given
enough time, must reach every room a door lets it into.* Particles pass it by
wandering. The naive tool is the better tool here. A real fluid sim would be
lovely later, once there is a question that needs one.

## What is measured

`npm test` — 9 checks, 11s:

- **the invariant**: doors open, every room gets puffs, none is structurally zero;
- doors shut, those rooms stay at nothing while the living room passes 200%;
- **fans even the house out** — worst room more than 2.5× better, and the living
  room's surplus visibly drops, so it is redistribution rather than addition;
- a cracked door passes less than a wide one;
- an open window is a way *out*: fewer puffs in the house, and less in that room;
- openness is proportional and the gap sits at the latch end;
- same seed, same run, identical counts.

`npm run e2e` — 12 checks on desktop and phone, covering the same claims through
a real browser plus the fan click-cycle, pause, and save-and-reload.

Measured at the shipping numbers, three minutes in, all doors open:

| | living | bedroom | study | hall | kitchen | bathroom | worst |
|---|---|---|---|---|---|---|---|
| no fans | 224% | 39% | 6% | 45% | 42% | 6% | **6%** |
| two fans in the hall | 125% | 47% | 102% | 115% | 49% | 116% | **47%** |

Note that two fans *overshoot* the far end and leave the near rooms behind — so
there is a real arrangement to find, not just "add fans".

**Never human-playtested.** And frame rate on real hardware is unverified: the
sim holds its 60Hz tick exactly (59.5 ticks/s, 3–6ms per frame of update, 0.4ms
of render), but the only end-to-end number available here came from a
software-rendered headless browser, which says nothing about a machine with a
GPU.

## Shape

- `src/game/layout.ts` — the house, in **metres**.
- `src/game/sim.ts` — the puffs. No DOM, so `npm test` runs it in node.
- `src/game/view.ts` — a ParticleContainer for the puffs, vectors for everything
  else so a 6cm crack stays visible.
- `src/game/cfg.ts` — every tunable. Press `` ` `` in the game to drag them live.

## Known rough edges

- Portrait phone leaves a lot of empty space above and below a landscape house.
- A fan is a rectangle with an arrow; it reads, but it is not designed.
- No door *leaf* swinging into the room as a solid deflector.
