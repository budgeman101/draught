# Draught

A minimum viable prototype: **route a scent through a house** using doors and
windows you can open by any amount, and fans you can drop on the floor.

Scent rather than cool air on purpose — a scent is a passive tracer, so it just
gets carried and spread, while cool air needs temperature, buoyancy and thermal
mass on top. Everything about *routing* is learnable with the cheap one.

No goal, no score, no progression. This exists to answer one question: **does
shaping a route with doors, windows and fans read as something worth doing?**

```bash
node ../hub/scripts/ctl.mjs start draught
```

Then <http://dusky-desktop.tail2719a1.ts.net/p/draught/>.

## The three verbs

| | |
|---|---|
| **Drag** a door or window along its length | sets how far it is open, 0–100% |
| **Click** the floor | drops a fan; click again to turn it a quarter; the fifth click removes it |
| **Right-click** a fan | removes it |

## What the air actually is

Not a blur. A real incompressible solve on a staggered (MAC) grid at 8cm cells —
semi-Lagrangian advection, then a Gauss-Seidel pressure projection with the walls
as no-flow boundaries. That is what buys the corner-turning, the way shutting one
door makes another route busier, and the fact that a narrow gap speeds the air
up. A permeability multiplier on a diffusion field can do none of those.

**A door is a SPAN OF CELLS, not a dimmer switch.** Openness is how many of the
opening's ~10 cells are gap, and the gap grows from the *latch* end because that
is where the leaf swings away from. The drawn gap is snapped to the same cell
boundaries the solver uses, so what you see is what is being solved.

**The air has somewhere to go.** The unit is a prescribed inflow in the living
room; the extract at the end of the hall and the far outdoors are open
boundaries. This matters more than it sounds: the first build sealed the whole
model, and in a sealed incompressible box the net flow through any single doorway
is exactly *zero* — a bedroom off one open door got eddies and nothing else,
however wide you flung it. Hence the rule the game turns on: **a room only gets
air if that air has somewhere to leave**. Open its window and the door beside it
becomes a route.

## What is measured, and what is not

`npm test` (13s — it solves real air) checks the claims, not just that it runs:

- a shut house does not leak;
- a door alone moves almost nothing (flux < 0.05); door **plus window** moves a
  lot (flux > 0.4, bedroom > 8% scent);
- two open routes compete — opening the second measurably starves the first;
- openness is proportional and the gap is at the latch end;
- narrowing a gap **raises the air speed through it** while **passing less air**
  (0.15 open: faster than wide by >15%, at roughly half the flow).

**A claim that did NOT survive measurement.** I told you a cracked door would
"throw a jet right across the next room". It does not. Penetration — far-side
scent over near-side scent — is 1.07 at every opening from 0.15 to fully open,
and the off-axis corner of the room does *three times better* with the door wide.
Narrowing a door buys speed and costs flow; it does not buy reach. The UI says
only what was measured.

**Never human-playtested.** And frame rate on real hardware is unverified: the
sim holds its 30Hz tick exactly, but the only render measurement available here
came from a software-rendered headless browser (18fps), which says nothing about
a machine with a GPU.

## Shape

- `src/game/layout.ts` — the house, in **metres**. Change `CFG.cell` and the
  resolution changes without touching a coordinate.
- `src/game/fluid.ts` — the solver. No DOM, so `npm test` runs it in node.
- `src/game/sim.ts` — metres to cells, the three verbs, the readings.
- `src/game/view.ts` — the scent as an uploaded texture, everything else as
  vectors so a 6cm crack stays visible.
- `src/game/cfg.ts` — every tunable. Press `` ` `` in the game to drag them live.

## Known rough edges

- Portrait phone leaves a lot of empty space above and below a landscape house.
- A fan is a rectangle with an arrow; it reads, but it is not designed.
- No door *leaf* swinging into the room as a solid deflector — the obvious next
  thing, deliberately not in the MVP.
