/* view.ts — draws the sim with Pixi. Reads sim state; never writes it.

   Everything in here is in HOUSE METRES. One container is scaled to fit the
   viewport and every child is placed in real units, so nothing has to know the
   zoom and no coordinate is converted twice.

   The scent is a texture, not geometry: one RGBA byte buffer the size of the
   grid, uploaded each frame. Twenty-odd thousand cells as Graphics rectangles
   would be hopeless, and the buffer gets bilinear filtering for free, which is
   what makes a plume look like a plume instead of like a spreadsheet.

   The walls are the opposite — drawn as vectors, because a 6cm crack has to stay
   visible at any zoom. Their gaps are SNAPPED to cell boundaries on purpose, so
   what is drawn is exactly the geometry the solver has. A door drawn a little
   more open than it really is would be a lie in the one place the whole game is
   being read from. */

import { BufferImageSource, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { CFG } from './cfg.js';
import { apertureRect, gapRect, ventRect, type Aperture } from './layout.js';
import { velocityAt } from './fluid.js';
import { DIR_VECTORS, toMetreX, toMetreY, type Sim } from './sim.js';

const OUTDOOR = [0x0a, 0x0e, 0x13] as const;
const FLOOR = [0x18, 0x1d, 0x25] as const;
const WALL = 0x333d4a;
const WALL_EDGE = 0x4a586a;
const DOOR_LEAF = 0xc08a4a;
const WINDOW_LEAF = 0x6f8fa8;
const SUPPLY = 0x63d8ff;
const EXTRACT = 0x7b8794;
const FAN = 0xe3e8ef;

/* three stops from "a trace of it" to "you are standing in it" */
const RAMP: readonly (readonly [number, number, number, number])[] = [
  [0.00, 0x1b, 0x55, 0x63],
  [0.38, 0x3f, 0xb8, 0xb4],
  [1.00, 0xea, 0xff, 0xfb],
];

function fieldColour(t: number, base: readonly [number, number, number] | number[]): [number, number, number] {
  if (t <= 0) return [base[0]!, base[1]!, base[2]!];
  // base -> first stop over the bottom slice, so a faint trace still tints
  const first = RAMP[0]!;
  if (t < 0.16) {
    const u = t / 0.16;
    return [
      base[0]! + (first[1] - base[0]!) * u,
      base[1]! + (first[2] - base[1]!) * u,
      base[2]! + (first[3] - base[2]!) * u,
    ];
  }
  const k = (t - 0.16) / 0.84;
  for (let n = 0; n < RAMP.length - 1; n++) {
    const a = RAMP[n]!, b = RAMP[n + 1]!;
    if (k <= b[0] || n === RAMP.length - 2) {
      const u = Math.min(1, Math.max(0, (k - a[0]) / (b[0] - a[0] || 1)));
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [first[1], first[2], first[3]];
}

/** Snap a metre coordinate to the cell edge the rasteriser would use. */
const snapLo = (s: Sim, m: number, o: number) => o + Math.floor((m - o) / s.cell) * s.cell;
const snapHi = (s: Sim, m: number, o: number) => o + Math.ceil((m - o) / s.cell) * s.cell;

export function createView(parent: Container, sim: Sim) {
  const root = new Container();
  parent.addChild(root);

  const { W, H, cell, ox, oy } = sim;

  /* ── the scent field ──────────────────────────────────────────────────── */
  const buf = new Uint8Array(W * H * 4);
  const source = new BufferImageSource({
    resource: buf,
    width: W,
    height: H,
    alphaMode: 'premultiplied-alpha',
    scaleMode: 'linear',
  });
  const field = new Sprite(new Texture({ source }));
  field.position.set(ox, oy);
  field.width = W * cell;
  field.height = H * cell;
  root.addChild(field);

  const arrows = new Graphics();
  const structure = new Graphics();
  const props = new Graphics();
  const highlight = new Graphics();
  root.addChild(arrows, structure, props, highlight);

  const labels = new Container();
  root.addChild(labels);
  for (const z of sim.layout.zones) {
    const t = new Text({
      text: z.name,
      /* a dark outline, because these sit over BOTH the empty floor and the
         brightest part of the plume, and one flat colour cannot do both */
      style: {
        fill: 0xd7e3f2, fontSize: 26, fontFamily: 'system-ui, sans-serif', fontWeight: '500',
        stroke: { color: 0x05080c, width: 5, join: 'round' },
      },
    });
    t.alpha = 0.72;
    t.anchor.set(0.5);
    t.scale.set(0.008);
    t.position.set((z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2);
    labels.addChild(t);
  }

  const pct = new Container();
  root.addChild(pct);
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
    pct.addChild(t);
    pctText.set(a.id, t);
  }

  let showArrows = true;
  let hovered: string | null = null;

  /** Walls, minus whatever the doors and windows have opened. */
  function drawStructure() {
    structure.clear();

    for (const w of sim.layout.walls) {
      const cuts: [number, number][] = [];
      const cut = (axis: 'h' | 'v', r: { x0: number; y0: number; x1: number; y1: number }) => {
        const o = axis === 'h' ? ox : oy;
        cuts.push([
          snapLo(sim, axis === 'h' ? r.x0 : r.y0, o),
          snapHi(sim, axis === 'h' ? r.x1 : r.y1, o),
        ]);
      };
      for (const a of sim.layout.apertures) {
        if (a.axis !== w.axis || Math.abs(a.at - w.at) > 0.01) continue;
        const g = gapRect(a);
        if (g) cut(a.axis, g);
      }
      for (const v of sim.layout.vents) {
        if (v.role !== 'extract' || v.axis !== w.axis || Math.abs(v.at - w.at) > 0.01) continue;
        cut(v.axis, ventRect(v));
      }
      cuts.sort((p, q) => p[0] - q[0]);

      const t = w.thickness / 2;
      let at = w.from - t;
      const end = w.to + t;
      const seg = (a: number, b: number) => {
        if (b - a <= 1e-6) return;
        if (w.axis === 'h') structure.rect(a, w.at - t, b - a, w.thickness);
        else structure.rect(w.at - t, a, w.thickness, b - a);
      };
      for (const [lo, hi] of cuts) { seg(at, Math.max(at, lo)); at = Math.max(at, hi); }
      seg(at, end);
      structure.fill({ color: WALL });
      structure.stroke({ width: 0.015, color: WALL_EDGE, alignment: 0.5 });
    }

    // the leaf: the part of the opening that is still shut, at the hinge end
    for (const a of sim.layout.apertures) {
      const r = apertureRect(a);
      const g = gapRect(a);
      const o = a.axis === 'h' ? ox : oy;
      const lo = a.axis === 'h' ? r.x0 : r.y0;
      const hi = a.axis === 'h' ? r.x1 : r.y1;
      const gLo = g ? snapLo(sim, a.axis === 'h' ? g.x0 : g.y0, o) : hi;
      const gHi = g ? snapHi(sim, a.axis === 'h' ? g.x1 : g.y1, o) : hi;
      const shut: [number, number][] = [[lo, Math.max(lo, gLo)], [Math.min(hi, gHi), hi]];
      const th = a.thickness * 0.55;
      for (const [p, q] of shut) {
        if (q - p <= 1e-6) continue;
        if (a.axis === 'h') structure.rect(p, a.at - th / 2, q - p, th);
        else structure.rect(a.at - th / 2, p, th, q - p);
      }
      structure.fill({ color: a.kind === 'door' ? DOOR_LEAF : WINDOW_LEAF, alpha: 0.95 });
    }
  }

  function drawProps() {
    props.clear();

    for (const v of sim.layout.vents) {
      const r = ventRect(v);
      const supply = v.role === 'supply';
      const colour = supply ? SUPPLY : EXTRACT;
      if (supply) {
        props.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        props.fill({ color: colour, alpha: 0.9 });
      } else {
        // a grille, not a slab: it is a hole, and the air really does leave here
        const bars = 5;
        const span = v.axis === 'h' ? r.x1 - r.x0 : r.y1 - r.y0;
        for (let n = 0; n < bars; n++) {
          const t0 = r.x0 + (v.axis === 'h' ? (span * n) / bars : 0);
          const u0 = r.y0 + (v.axis === 'h' ? 0 : (span * n) / bars);
          if (v.axis === 'h') props.rect(t0, r.y0, span / bars / 2, r.y1 - r.y0);
          else props.rect(r.x0, u0, r.x1 - r.x0, span / bars / 2);
        }
        props.fill({ color: colour, alpha: 0.8 });
      }

      // three stubby arrows showing which way this grille moves air
      const along = v.axis === 'h' ? r.x1 - r.x0 : r.y1 - r.y0;
      for (let n = 1; n <= 3; n++) {
        const f = n / 4;
        const px = v.axis === 'h' ? r.x0 + along * f : (r.x0 + r.x1) / 2;
        const py = v.axis === 'h' ? (r.y0 + r.y1) / 2 : r.y0 + along * f;
        const dx = v.axis === 'h' ? 0 : v.dir;
        const dy = v.axis === 'h' ? v.dir : 0;
        const len = 0.26;
        const sx = px + dx * 0.12, sy = py + dy * 0.12;
        props.moveTo(sx, sy).lineTo(sx + dx * len, sy + dy * len);
        props.stroke({ width: 0.035, color: colour, alpha: 0.85 });
      }
    }

    for (const fan of sim.fans) {
      const x = toMetreX(sim, fan.i), y = toMetreY(sim, fan.j);
      const [dx, dy] = DIR_VECTORS[fan.dir]!;
      const halfW = CFG.fanWidth / 2;
      const bw = dx !== 0 ? 0.1 : halfW;
      const bh = dx !== 0 ? halfW : 0.1;
      props.roundRect(x - bw, y - bh, bw * 2, bh * 2, 0.05);
      props.fill({ color: FAN, alpha: 0.92 });

      const len = 0.34;
      const tipX = x + dx * len, tipY = y + dy * len;
      props.moveTo(x + dx * 0.12, y + dy * 0.12).lineTo(tipX, tipY);
      props.stroke({ width: 0.05, color: FAN, alpha: 0.9 });
      props.moveTo(tipX, tipY)
        .lineTo(tipX - dx * 0.13 + dy * 0.09, tipY - dy * 0.13 + dx * 0.09)
        .lineTo(tipX - dx * 0.13 - dy * 0.09, tipY - dy * 0.13 - dx * 0.09)
        .closePath();
      props.fill({ color: FAN, alpha: 0.9 });
    }
  }

  function drawArrows() {
    arrows.clear();
    if (!showArrows) return;
    const stride = Math.max(2, Math.round(CFG.arrowSpacing / cell));
    const vel = { x: 0, y: 0 };
    const cap = stride * cell * 0.85;
    for (let j = stride >> 1; j < H; j += stride) {
      for (let i = stride >> 1; i < W; i += stride) {
        const c = i + j * W;
        if (sim.f.solid[c]) continue;
        velocityAt(sim.f, i, j, vel);
        const sp = Math.hypot(vel.x, vel.y);
        if (sp < 0.05) continue;
        const len = Math.min(cap, sp * CFG.arrowScale);
        const x = toMetreX(sim, i), y = toMetreY(sim, j);
        const nx = vel.x / sp, ny = vel.y / sp;
        const a = Math.min(0.75, 0.18 + sp * 0.35);
        arrows.moveTo(x - nx * len * 0.5, y - ny * len * 0.5).lineTo(x + nx * len * 0.5, y + ny * len * 0.5);
        arrows.stroke({ width: 0.018, color: 0xa8e8ff, alpha: a });
        arrows.circle(x + nx * len * 0.5, y + ny * len * 0.5, 0.028);
        arrows.fill({ color: 0xa8e8ff, alpha: a });
      }
    }
  }

  function drawHighlight() {
    highlight.clear();
    if (!hovered) return;
    const a = sim.layout.apertures.find((q) => q.id === hovered);
    if (!a) return;
    const r = apertureRect(a);
    const pad = 0.07;
    highlight.rect(r.x0 - pad, r.y0 - pad, r.x1 - r.x0 + pad * 2, r.y1 - r.y0 + pad * 2);
    highlight.stroke({ width: 0.035, color: 0xffffff, alpha: 0.55 });
  }

  function drawField() {
    const d = sim.f.d, solid = sim.f.solid, outside = sim.outside;
    const g = CFG.scentGamma;
    for (let c = 0, k = 0; c < d.length; c++, k += 4) {
      let r: number, gg: number, b: number;
      if (solid[c]) {
        r = 0x2a; gg = 0x32; b = 0x3d;
      } else {
        const base = outside[c] ? OUTDOOR : FLOOR;
        const t = d[c]! <= 0 ? 0 : Math.pow(Math.min(1, d[c]!), g);
        const rgb = fieldColour(t, base);
        r = rgb[0]; gg = rgb[1]; b = rgb[2];
      }
      buf[k] = r; buf[k + 1] = gg; buf[k + 2] = b; buf[k + 3] = 255;
    }
    source.update();
  }

  drawStructure();
  drawProps();

  return {
    root,

    /**
     * Fit the whole grid — house plus the outdoor margin — into the viewport,
     * INSIDE the given insets. The HUD is a real column down the left rather
     * than a panel floating over the plan: at this aspect ratio anything that
     * overlays the board covers a room, and a room you cannot see is a room you
     * cannot read.
     */
    fit(w: number, h: number, inset: { left?: number; right?: number; top?: number; bottom?: number } = {}) {
      const l = inset.left ?? 12, r = inset.right ?? 12;
      const t = inset.top ?? 12, b = inset.bottom ?? 12;
      const aw = Math.max(50, w - l - r), ah = Math.max(50, h - t - b);
      const gw = W * cell, gh = H * cell;
      const s = Math.min(aw / gw, ah / gh);
      root.scale.set(s);
      root.position.set(l + (aw - gw * s) / 2 - ox * s, t + (ah - gh * s) / 2 - oy * s);
    },

    /** Screen pixels (relative to the canvas) to house metres. */
    toWorld(px: number, py: number): { x: number; y: number } {
      return { x: (px - root.position.x) / root.scale.x, y: (py - root.position.y) / root.scale.y };
    },

    setArrowsVisible(on: boolean) { showArrows = on; if (!on) arrows.clear(); },
    setHovered(id: string | null) { hovered = id; },

    /** Call after anything structural moves — a door, a window, a fan. */
    rebuild() { drawStructure(); drawProps(); },

    render() {
      drawField();
      drawArrows();
      drawHighlight();
      drawProps();
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
export type { Aperture };
