/* camera.ts — pan and zoom, using pixi-viewport.

   pixi-viewport already does drag, pinch, wheel, momentum, clamping and
   zoom-at-cursor properly, so we don't write any of it. This is only the glue
   the library doesn't cover: sane defaults, loop integration, and a save/restore
   pair so the player's view survives a reload.

     const cam = createCamera(app, { minZoom: 0.25, maxZoom: 4 });
     cam.viewport.addChild(worldContainer);   // world (0,0) is the centre
     // in the loop:
     cam.update(dt);
     cam.resize(w, h);

   noTicker is ON: Pixi's ticker is stopped (our loop drives rendering), so
   momentum and animation would silently never advance unless we tick the
   viewport ourselves from update(). */

import { Viewport } from 'pixi-viewport';
import type { Application } from 'pixi.js';

export interface CameraOptions {
  minZoom?: number;
  maxZoom?: number;
  /** Start centred here, in world units. Defaults to the origin. */
  x?: number;
  y?: number;
  zoom?: number;
  /** Pass false to make the board read-only (a cutscene, a fixed board). */
  drag?: boolean;
  wheel?: boolean;
  pinch?: boolean;
  /** Momentum after a flick. */
  decelerate?: boolean;
}

export interface CameraState { x: number; y: number; zoom: number }

export function createCamera(app: Application, o: CameraOptions = {}) {
  const {
    minZoom = 0.2, maxZoom = 8,
    x = 0, y = 0, zoom = 1,
    drag = true, wheel = true, pinch = true, decelerate = true,
  } = o;

  // app.screen is in logical (CSS) units; renderer.width is buffer pixels and
  // would double every coordinate on a HiDPI screen.
  const viewport = new Viewport({
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    events: app.renderer.events,
    noTicker: true,          // our loop calls update(); Pixi's ticker is stopped
    passiveWheel: false,     // so wheel-zoom can preventDefault and not scroll the page
  });

  if (drag) viewport.drag();
  if (pinch) viewport.pinch();
  if (wheel) viewport.wheel();
  if (decelerate) viewport.decelerate();
  viewport.clampZoom({ minScale: minZoom, maxScale: maxZoom });

  viewport.setZoom(zoom, true);
  viewport.moveCenter(x, y);

  const api = {
    viewport,

    /** Call each frame with the loop's dt (seconds). */
    update(dt: number) { viewport.update(dt * 1000); },

    resize(w: number, h: number) {
      const c = viewport.center;
      viewport.resize(w, h);
      viewport.moveCenter(c);     // resizing shifts the centre otherwise
    },

    moveTo(wx: number, wy: number) { viewport.moveCenter(wx, wy); return api; },
    setZoom(z: number) { viewport.setZoom(z, true); return api; },
    /** Glide to a spot — for "focus on this" rather than teleporting. */
    focus(wx: number, wy: number, ms = 400) {
      viewport.animate({ position: { x: wx, y: wy }, time: ms, ease: 'easeInOutSine' });
      return api;
    },
    /** Screen point → world coordinates, e.g. for a click on the board. */
    toWorld(sx: number, sy: number) { return viewport.toWorld(sx, sy); },

    get zoom() { return viewport.scale.x; },
    get center() { return viewport.center; },

    toJSON(): CameraState {
      const c = viewport.center;
      return { x: c.x, y: c.y, zoom: viewport.scale.x };
    },
    fromJSON(s?: Partial<CameraState> | null) {
      if (!s) return api;
      if (s.zoom) viewport.setZoom(s.zoom, true);
      viewport.moveCenter(s.x ?? 0, s.y ?? 0);
      return api;
    },

    /**
     * Only needed if the viewport ISN'T parented to a scene layer — a scene's
     * layer.destroy({children:true}) already tears the viewport down, and
     * destroying it twice is a double-free.
     */
    destroy() { viewport.destroy({ children: false }); },
  };

  return api;
}

export type Camera = ReturnType<typeof createCamera>;
