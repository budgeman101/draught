/* scenes.ts — swap between views (menu / play / pause / map).

   No library covers this for a Pixi-without-a-framework setup, because a scene
   here is TWO things at once: a DOM layer for the chrome and a Pixi Container
   for the board. This creates and tears down both together, so a scene can't
   leak either into the next one.

     const scenes = createScenes({ root: appEl, stage: app.stage });

     scenes.add('play', {
       enter(ctx) { this.view = createView(app, ctx.layer, sim);
                    ctx.el.append(hud); },
       update(dt) { sim.tick(dt); },
       render()   { this.view.render(); },
       exit()     { this.view.destroy(); },
     });
     scenes.go('play');

   GO vs PUSH — the distinction hand-rolled switchers always get wrong:
     go()   replaces the stack (menu → play). The old scene is torn down.
     push() overlays (play → pause). The scene below STAYS MOUNTED and keeps
            rendering, but stops updating, so the board is still visible behind
            the pause menu and is exactly where you left it.
     back() pops the overlay and resumes the one underneath.

   IT DOES NOT OWN THE LOOP. You call scenes.update(dt) and scenes.render(alpha)
   from your own frame, so there's still exactly one driver and DBG.step() stays
   deterministic. */

import { Container } from 'pixi.js';

export interface SceneContext {
  /** This scene's DOM layer — put chrome here. Removed on exit. */
  el: HTMLElement;
  /** This scene's Pixi container — put board content here. Destroyed on exit. */
  layer: Container;
  scenes: Scenes;
  payload?: any;
}

export interface Scene {
  enter?(ctx: SceneContext, payload?: any): void | Promise<void>;
  exit?(): void | Promise<void>;
  update?(dt: number): void;
  render?(alpha: number): void;
  resize?(w: number, h: number): void;
  /** Called when something is pushed on top of this scene. */
  pause?(): void;
  resume?(): void;
  /** Keep updating even while covered by a pushed scene (default false). */
  updateBelow?: boolean;
  [key: string]: any;
}

type SceneDef = Scene | (() => Scene);
type Transition = 'none' | 'fade' | 'slide-left' | 'slide-up';

interface Entry { name: string; def: Scene; el: HTMLElement; layer: Container }

export function createScenes(opts: {
  root: HTMLElement;
  /** Pixi stage. Omit for a DOM-only game; scenes then get a detached layer. */
  stage?: Container;
  transition?: Transition;
  ms?: number;
}) {
  const { root, stage, transition = 'fade', ms = 200 } = opts;

  const defs = new Map<string, SceneDef>();
  const stack: Entry[] = [];
  const listeners: Record<string, ((p: any) => void)[]> = {};
  let busy: Promise<void> = Promise.resolve();

  const wait = (t: number) => new Promise((r) => setTimeout(r, t));
  const emit = (evt: string, p?: any) => {
    for (const fn of listeners[evt] ?? []) { try { fn(p); } catch (e) { console.error('[scenes]', e); } }
  };

  async function mount(name: string, payload: any, kind: Transition): Promise<Entry> {
    const raw = defs.get(name);
    if (!raw) throw new Error(`[scenes] no scene "${name}" — add() it first`);
    // a factory is re-invoked per entry, so scene state starts clean each time
    const def = typeof raw === 'function' ? raw() : raw;

    const el = document.createElement('div');
    el.className = 'kit-scene';
    el.dataset.scene = name;
    el.style.setProperty('--kit-scene-ms', ms + 'ms');
    root.appendChild(el);

    const layer = new Container();
    layer.label = name;
    stage?.addChild(layer);

    const entry: Entry = { name, def, el, layer };
    stack.push(entry);

    await def.enter?.call(def, { el, layer, scenes: api, payload }, payload);
    emit('change', api.current);

    if (kind !== 'none' && ms > 0) {
      el.classList.add('kit-scene-in', 'kit-t-' + kind);
      void el.offsetWidth;                         // force the "before" state to land
      el.classList.remove('kit-scene-in');
      await wait(ms);
      el.classList.remove('kit-t-' + kind);
    }
    return entry;
  }

  async function unmount(entry: Entry, kind: Transition) {
    if (kind !== 'none' && ms > 0) {
      entry.el.classList.add('kit-t-' + kind, 'kit-scene-out');
      await wait(ms);
    }
    try { await entry.def.exit?.call(entry.def); }
    catch (e) { console.error('[scenes] exit', e); }
    entry.el.remove();
    entry.layer.destroy({ children: true });
  }

  const api = {
    /* Generic so an object literal keeps its OWN shape: `this.sim` inside a
       scene method resolves against the literal you passed, not the Scene
       union (where the factory branch has no index signature). */
    add<T extends Scene>(name: string, def: T | (() => T)) { defs.set(name, def as SceneDef); return api; },
    has: (name: string) => defs.has(name),
    names: () => [...defs.keys()],

    get current() { return stack.length ? stack[stack.length - 1]!.name : null; },
    get stack() { return stack.map((s) => s.name); },
    /** The live scene object — reach through for its state. */
    get active(): Scene | null { return stack.length ? stack[stack.length - 1]!.def : null; },
    get el() { return stack.length ? stack[stack.length - 1]!.el : null; },

    /** Replace the whole stack. The normal way to move between screens. */
    go(name: string, payload?: any, o: { transition?: Transition } = {}) {
      busy = busy.then(async () => {
        const kind = o.transition ?? transition;
        const leaving = stack.splice(0, stack.length);
        const entering = mount(name, payload, kind);
        await Promise.all([...leaving.reverse().map((e) => unmount(e, kind)), entering]);
      });
      return busy;
    },

    /** Overlay on top; the scene below stays mounted and visible. */
    push(name: string, payload?: any, o: { transition?: Transition } = {}) {
      busy = busy.then(async () => {
        stack[stack.length - 1]?.def.pause?.();
        await mount(name, payload, o.transition ?? transition);
      });
      return busy;
    },

    /** Pop the overlay and resume what's underneath. */
    back(o: { transition?: Transition } = {}) {
      busy = busy.then(async () => {
        if (stack.length <= 1) return;
        const top = stack.pop()!;
        await unmount(top, o.transition ?? transition);
        stack[stack.length - 1]?.def.resume?.();
        emit('change', api.current);
      });
      return busy;
    },

    /** Resolves when any in-flight transition has finished — tests want this. */
    settled() { return busy; },

    /* ── per-frame: called from YOUR loop ─────────────────────────────────── */
    update(dt: number) {
      for (let i = 0; i < stack.length; i++) {
        const s = stack[i]!;
        if (i === stack.length - 1 || s.def.updateBelow) s.def.update?.call(s.def, dt);
      }
    },
    /** Bottom-up, so a pause overlay draws over a still-live board. */
    render(alpha = 0) { for (const s of stack) s.def.render?.call(s.def, alpha); },
    resize(w: number, h: number) { for (const s of stack) s.def.resize?.call(s.def, w, h); },

    on(evt: 'change', fn: (p: any) => void) { (listeners[evt] ??= []).push(fn); return api; },

    async destroy() {
      await busy;
      for (const e of stack.splice(0, stack.length).reverse()) await unmount(e, 'none');
    },
  };

  return api;
}

export type Scenes = ReturnType<typeof createScenes>;
