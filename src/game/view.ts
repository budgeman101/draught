/* view.ts — draws the sim with Pixi. Reads sim state; never writes it.

   Everything here is in HOUSE METRES. One container is scaled to fit the
   viewport and every child is placed in real units, so nothing else has to know
   the zoom and no coordinate is converted twice.

   The scent is drawn as what it is — thousands of little soft dots in a
   ParticleContainer, one per puff. Seeing the individual specks is the point:
   you can watch a stream of them squeeze through a cracked door, which a smooth
   density field would have averaged into a blur.

   The walls are vectors, because a 6cm crack has to stay visible at any zoom,
   and their gaps are SNAPPED to the same cells the wall bitmap uses. What is
   drawn is exactly the geometry the puffs are colliding with; a door drawn a
   little more open than it really is would be a lie in the one place the whole
   game is read from. */

import {
  Container, Graphics, Particle, ParticleContainer, Text, Texture,
} from 'pixi.js';
import { CFG } from './cfg.js';
import { apertureRect, emitterRect, gapRect } from './layout.js';
import { DIR_VECTORS, fanRect, type Sim } from './sim.js';

const WALL = 0x333d4a;
const WALL_EDGE = 0x4a586a;
const FLOOR = 0x141920;
const OUTDOOR = 0x080b10;
const DOOR_LEAF = 0xc08a4a;
const WINDOW_LEAF = 0x6f8fa8;
const UNIT = 0x63d8ff;
const FAN = 0xe3e8ef;
const PUFF = 0x8ff0e4;

/** Somewhere nothing is ever looking. Dead puffs are parked here. */
const OFFSCREEN = -1e4;

/** A soft round dot, built at runtime so there is no asset to lose. */
function dotTexture(): Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return Texture.from(c);
}

/** Snap a metre coordinate to the cell edge the wall bitmap uses. */
const snapLo = (s: Sim, m: number, o: number) => o + Math.floor((m - o) / s.cell) * s.cell;
const snapHi = (s: Sim, m: number, o: number) => o + Math.ceil((m - o) / s.cell) * s.cell;

export function createView(parent: Container, sim: Sim) {
  const root = new Container();
  parent.addChild(root);

  const { ox, oy, W, H, cell } = sim;
  const gw = W * cell, gh = H * cell;

  /* ── ground ───────────────────────────────────────────────────────────── */
  const ground = new Graphics();
  ground.rect(ox, oy, gw, gh).fill({ color: OUTDOOR });
  ground.rect(0, 0, sim.layout.width, sim.layout.height).fill({ color: FLOOR });
  root.addChild(ground);

  /* ── the puffs ────────────────────────────────────────────────────────── */
  const texture = dotTexture();
  const puffs = new ParticleContainer({
    dynamicProperties: { position: true, vertex: false, color: false, rotation: false, uvs: false },
  });
  const dots: Particle[] = [];
  for (let k = 0; k < sim.px.length; k++) {
    const p = new Particle({
      texture,
      x: OFFSCREEN, y: OFFSCREEN,
      anchorX: 0.5, anchorY: 0.5,
      // world size = texture size * scale, so this is dotSize METRES across
      scaleX: CFG.dotSize / texture.width,
      scaleY: CFG.dotSize / texture.height,
      tint: PUFF,
      alpha: CFG.dotAlpha,
    });
    puffs.addParticle(p);
    dots.push(p);
  }
  root.addChild(puffs);

  const structure = new Graphics();
  const props = new Graphics();
  const highlight = new Graphics();
  root.addChild(structure, props, highlight);

  /* ── labels ───────────────────────────────────────────────────────────── */
  const labels = new Container();
  root.addChild(labels);
  for (const z of sim.layout.zones) {
    const t = new Text({
      text: z.name,
      style: {
        fill: 0xd7e3f2, fontSize: 26, fontFamily: 'system-ui, sans-serif', fontWeight: '500',
        stroke: { color: 0x05080c, width: 5, join: 'round' },
      },
    });
    t.anchor.set(0.5);
    t.scale.set(0.008);
    t.alpha = 0.66;
    t.position.set((z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2);
    labels.addChild(t);
  }

  const pctText = new Map<string, Text>();
  for (const a of sim.layout.apertures) {
    const t = new Text({
      text: '',
      style: {
        fill: 0xffffff, fontSize: 24, fontFamily: 'system-ui, sans-serif', fontWeight: '600',
        stroke: { color: 0x05080c, width: 5, join: 'round' },
      },
    });
    t.anchor.set(0.5);
    t.scale.set(0.0075);
    const r = apertureRect(a);
    const off = 0.34;
    t.position.set(
      (r.x0 + r.x1) / 2 + (a.axis === 'v' ? off : 0),
      (r.y0 + r.y1) / 2 + (a.axis === 'h' ? -off : 0),
    );
    labels.addChild(t);
    pctText.set(a.id, t);
  }

  let hovered: string | null = null;

  /** One rectangle, filled and finished, so no later fill can reach back into it. */
  function box(x: number, y: number, w: number, h: number, colour: number, alpha = 1, edge?: number) {
    structure.rect(x, y, w, h).fill({ color: colour, alpha });
    if (edge !== undefined) structure.rect(x, y, w, h).stroke({ width: 0.015, color: edge, alignment: 0.5 });
  }

  /** Walls, minus whatever the doors and windows have opened. */
  function drawStructure() {
    structure.clear();

    for (const w of sim.layout.walls) {
      const cuts: [number, number][] = [];
      for (const a of sim.layout.apertures) {
        if (a.axis !== w.axis || Math.abs(a.at - w.at) > 0.01) continue;
        const g = gapRect(a);
        if (!g) continue;
        const o = a.axis === 'h' ? ox : oy;
        cuts.push([
          snapLo(sim, a.axis === 'h' ? g.x0 : g.y0, o),
          snapHi(sim, a.axis === 'h' ? g.x1 : g.y1, o),
        ]);
      }
      cuts.sort((p, q) => p[0] - q[0]);

      const t = w.thickness / 2;
      let at = w.from - t;
      const seg = (a: number, b: number) => {
        if (b - a <= 1e-6) return;
        if (w.axis === 'h') box(a, w.at - t, b - a, w.thickness, WALL, 1, WALL_EDGE);
        else box(w.at - t, a, w.thickness, b - a, WALL, 1, WALL_EDGE);
      };
      for (const [lo, hi] of cuts) { seg(at, Math.max(at, lo)); at = Math.max(at, hi); }
      seg(at, w.to + t);
    }

    // the leaf: the part of the opening still shut, sitting at the hinge end
    for (const a of sim.layout.apertures) {
      const r = apertureRect(a);
      const g = gapRect(a);
      const o = a.axis === 'h' ? ox : oy;
      const lo = a.axis === 'h' ? r.x0 : r.y0;
      const hi = a.axis === 'h' ? r.x1 : r.y1;
      const gLo = g ? snapLo(sim, a.axis === 'h' ? g.x0 : g.y0, o) : hi;
      const gHi = g ? snapHi(sim, a.axis === 'h' ? g.x1 : g.y1, o) : hi;
      const th = a.thickness * 0.55;
      const colour = a.kind === 'door' ? DOOR_LEAF : WINDOW_LEAF;
      for (const [p, q] of [[lo, Math.max(lo, gLo)], [Math.min(hi, gHi), hi]] as const) {
        if (q - p <= 1e-6) continue;
        if (a.axis === 'h') box(p, a.at - th / 2, q - p, th, colour, 0.95);
        else box(a.at - th / 2, p, th, q - p, colour, 0.95);
      }
    }
  }

  /* Every shape is filled or stroked on the spot, chained off its own command.
     Pixi keeps the path open across a fill, so a shape drawn and filled, then
     followed by ANOTHER fill, gets repainted in the second colour — which is how
     a fan's faint throw box came out as an opaque slab over the room. */
  function drawProps() {
    props.clear();

    for (const e of sim.layout.emitters) {
      const r = emitterRect(e);
      props.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
        .fill({ color: UNIT, alpha: sim.unitOn ? 0.9 : 0.3 });

      const along = e.axis === 'h' ? r.x1 - r.x0 : r.y1 - r.y0;
      const dx = e.axis === 'h' ? 0 : e.dir;
      const dy = e.axis === 'h' ? e.dir : 0;
      for (let n = 1; n <= 3; n++) {
        const f = n / 4;
        const px = e.axis === 'h' ? r.x0 + along * f : (r.x0 + r.x1) / 2;
        const py = e.axis === 'h' ? (r.y0 + r.y1) / 2 : r.y0 + along * f;
        props.moveTo(px + dx * 0.12, py + dy * 0.12)
          .lineTo(px + dx * 0.36, py + dy * 0.36)
          .stroke({ width: 0.035, color: UNIT, alpha: sim.unitOn ? 0.85 : 0.25 });
      }
    }

    for (const fan of sim.fans) {
      const [dx, dy] = DIR_VECTORS[fan.dir]!;

      // where it is aimed, as an outline — a fill here would hide the puffs it
      // is meant to be moving, which is the one thing you need to watch
      const r = fanRect(fan);
      props.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
        .stroke({ width: 0.02, color: FAN, alpha: 0.22 });

      const halfW = CFG.fanWidth / 2;
      const bw = dx !== 0 ? 0.09 : halfW;
      const bh = dx !== 0 ? halfW : 0.09;
      props.roundRect(fan.x - bw, fan.y - bh, bw * 2, bh * 2, 0.05)
        .fill({ color: FAN, alpha: 0.92 });

      const tipX = fan.x + dx * 0.36, tipY = fan.y + dy * 0.36;
      props.moveTo(fan.x + dx * 0.13, fan.y + dy * 0.13).lineTo(tipX, tipY)
        .stroke({ width: 0.05, color: FAN, alpha: 0.9 });
      props.moveTo(tipX, tipY)
        .lineTo(tipX - dx * 0.13 + dy * 0.09, tipY - dy * 0.13 + dx * 0.09)
        .lineTo(tipX - dx * 0.13 - dy * 0.09, tipY - dy * 0.13 - dx * 0.09)
        .closePath()
        .fill({ color: FAN, alpha: 0.9 });
    }
  }

  function drawHighlight() {
    highlight.clear();
    if (!hovered) return;
    const a = sim.layout.apertures.find((q) => q.id === hovered);
    if (!a) return;
    const r = apertureRect(a);
    const pad = 0.07;
    highlight.rect(r.x0 - pad, r.y0 - pad, r.x1 - r.x0 + pad * 2, r.y1 - r.y0 + pad * 2)
      .stroke({ width: 0.035, color: 0xffffff, alpha: 0.55 });
  }

  drawStructure();
  drawProps();

  return {
    root,

    /**
     * Fit the grid — house plus the outdoor margin — inside the given insets.
     * The HUD is a real column down the left rather than a panel floating over
     * the plan: at this aspect ratio anything overlaying the board covers a
     * room, and a room you cannot see is a room you cannot read.
     */
    fit(w: number, h: number, inset: { left?: number; right?: number; top?: number; bottom?: number } = {}) {
      const l = inset.left ?? 12, r = inset.right ?? 12;
      const t = inset.top ?? 12, b = inset.bottom ?? 12;
      const aw = Math.max(50, w - l - r), ah = Math.max(50, h - t - b);
      const s = Math.min(aw / gw, ah / gh);
      root.scale.set(s);
      root.position.set(l + (aw - gw * s) / 2 - ox * s, t + (ah - gh * s) / 2 - oy * s);
    },

    /** Screen pixels (relative to the canvas) to house metres. */
    toWorld(px: number, py: number) {
      return { x: (px - root.position.x) / root.scale.x, y: (py - root.position.y) / root.scale.y };
    },

    setHovered(id: string | null) { hovered = id; },

    /** Call after anything structural moves — a door, a window, a fan. */
    rebuild() { drawStructure(); drawProps(); },

    render() {
      for (let k = 0; k < dots.length; k++) {
        const p = dots[k]!;
        if (sim.alive[k]) { p.x = sim.px[k]!; p.y = sim.py[k]!; }
        else if (p.x !== OFFSCREEN) { p.x = OFFSCREEN; p.y = OFFSCREEN; }
      }
      drawHighlight();
      for (const a of sim.layout.apertures) {
        const t = pctText.get(a.id);
        if (!t) continue;
        const show = hovered === a.id || (a.open > 0 && a.open < 1);
        t.text = show ? `${Math.round(a.open * 100)}%` : '';
        t.alpha = hovered === a.id ? 1 : 0.75;
      }
    },

    destroy() { root.destroy({ children: true }); },
  };
}

export type View = ReturnType<typeof createView>;
