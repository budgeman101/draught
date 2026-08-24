/* view.ts — draws the sim with Pixi. Reads sim state; never writes it.

   Given a parent Container rather than owning the Application: the app is
   created once at boot, and each scene hands its own layer down. That's what
   lets a scene tear its board content down without touching anyone else's.

   Nothing here calls app.render() — the loop does that once per frame, after
   every mounted scene has drawn. */

import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { CFG } from './cfg.js';
import type { Sim } from './sim.js';

/** hsl → 0xRRGGBB, so we don't depend on how Pixi parses colour strings. */
function hslHex(h: number, s: number, l: number): number {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

export function createView(parent: Container, sim: Sim, texture: Texture) {
  const root = new Container();
  parent.addChild(root);

  const glow = new Graphics();
  const trail = new Graphics();
  const star = new Graphics();
  root.addChild(glow, trail, star);

  const mote = new Sprite(texture);
  mote.anchor.set(0.5);
  mote.tint = hslHex(sim.mote.hue, 80, 68);
  root.addChild(mote);

  let showTrail = true;

  function drawStar() {
    star.clear();
    glow.clear();
    // stacked translucent discs instead of a gradient. Enough of them, at a low
    // enough alpha, that the falloff reads as smooth rather than as rings.
    const RINGS = 14;
    for (let i = RINGS; i >= 1; i--) {
      glow.circle(0, 0, CFG.starSize * (0.8 + (i / RINGS) * 2.8));
      glow.fill({ color: 0xe88c3c, alpha: 0.028 });
    }
    star.circle(0, 0, CFG.starSize * 0.62);
    star.fill({ color: 0xffcf82 });
    star.circle(0, 0, CFG.starSize * 0.34);
    star.fill({ color: 0xfff6d6 });
  }

  return {
    root,
    setTrailVisible(on: boolean) { showTrail = on; if (!on) trail.clear(); },

    render() {
      drawStar();

      const pts = sim.mote.trail;
      trail.clear();
      if (showTrail && pts.length >= 4) {
        trail.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) trail.lineTo(pts[i]!, pts[i + 1]!);
        trail.stroke({ width: 2, color: hslHex(sim.mote.hue, 80, 68), alpha: CFG.trailAlpha });
      }

      mote.position.set(sim.mote.x, sim.mote.y);
      mote.scale.set(CFG.moteScale);
    },

    destroy() { root.destroy({ children: true }); },
  };
}

export type View = ReturnType<typeof createView>;
