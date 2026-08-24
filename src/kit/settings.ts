/* settings.ts — declare the options once, get a persisted store AND a panel.

     const settings = createSettings({
       key: 'harbor',
       schema: {
         master: { type: 'range', label: 'Master', default: 0.8, onChange: (v) => Audio.volume('master', v) },
         muted:  { type: 'toggle', label: 'Mute', default: false, onChange: (v) => Audio.mute(v) },
       },
     });
     await settings.load();          // reads AND applies
     dialogBody.append(settings.panel());

   THE BIT THAT MATTERS: load() APPLIES every value through its onChange, it
   doesn't just read them. The classic bug is a saved volume of 0.2 sitting in
   storage while the game boots at 1.0, because nothing ever pushed it into the
   mixer. */

import { createStore } from './save.js';
import { panel, slider, toggle, select, button, row, spacer } from './chrome.js';

export type SettingDef =
  | { type: 'range'; label?: string; default: number; min?: number; max?: number; step?: number; unit?: string; format?: (v: number) => string; onChange?: (v: number) => void; hidden?: boolean }
  | { type: 'toggle'; label?: string; default: boolean; onChange?: (v: boolean) => void; hidden?: boolean }
  | { type: 'select'; label?: string; default: string; options: (string | { value: string; label: string })[]; onChange?: (v: string) => void; hidden?: boolean };

export function createSettings<S extends Record<string, SettingDef>>(opts: {
  key: string;
  schema: S;
  version?: number;
  title?: string;
}) {
  const { key, schema, version = 1, title = 'Settings' } = opts;

  const defaults: Record<string, any> = {};
  for (const [k, def] of Object.entries(schema)) defaults[k] = def.default;

  const store = createStore({ key, version, space: 'settings', defaults });
  const listeners: Record<string, ((v: any) => void)[]> = {};
  const controls: Record<string, { set: (v: any) => unknown }> = {};

  function fire(k: string, v: any) {
    for (const fn of listeners[k] ?? []) { try { fn(v); } catch (e) { console.error('[settings]', e); } }
    for (const fn of listeners['*'] ?? []) { try { fn(v); } catch (e) { console.error('[settings]', e); } }
    const def = schema[k];
    if (def?.onChange) { try { (def.onChange as (v: any) => void)(v); } catch (e) { console.error('[settings] onChange', e); } }
  }

  const api = {
    store,

    async load() {
      await store.load();
      // pick up any key the schema gained since this save was written
      for (const k of Object.keys(schema)) if ((store.data as any)[k] === undefined) (store.data as any)[k] = schema[k]!.default;
      for (const k of Object.keys(schema)) fire(k, (store.data as any)[k]);
      return api;
    },

    get<K extends keyof S & string>(k: K): any { return (store.data as any)[k]; },
    all() { return { ...(store.data as object) }; },

    set(k: string, v: any) {
      if ((store.data as any)[k] === v) return api;
      (store.data as any)[k] = v;
      store.save();
      controls[k]?.set(v);
      fire(k, v);
      return api;
    },

    /** Subscribe to one key, or '*' for all. Returns an unsubscribe. */
    on(k: string, fn: (v: any) => void) {
      (listeners[k] ??= []).push(fn);
      return () => { listeners[k] = (listeners[k] ?? []).filter((f) => f !== fn); };
    },

    reset() { for (const [k, def] of Object.entries(schema)) api.set(k, def.default); return api; },

    /** A ready-made options panel built from the schema. */
    panel(o: { title?: string | null; reset?: boolean } = {}) {
      const p = panel({ title: o.title === undefined ? title : o.title });

      for (const [k, def] of Object.entries(schema)) {
        if (def.hidden) continue;
        const label = def.label ?? k;
        const value = (store.data as any)[k];
        let control: any;

        if (def.type === 'toggle') {
          control = toggle({ label, value: !!value, onChange: (v) => api.set(k, v) });
        } else if (def.type === 'select') {
          control = select({ label, options: def.options, value, onChange: (v) => api.set(k, v) });
        } else {
          control = slider({
            label, min: def.min ?? 0, max: def.max ?? 1, step: def.step ?? 0.05,
            value: value ?? 0, unit: def.unit, format: def.format,
            onInput: (v) => api.set(k, v),
          });
        }
        controls[k] = control;
        p.add(control);
      }

      if (o.reset !== false) {
        p.add(row(spacer(), button({ label: 'Restore defaults', variant: 'ghost', onClick: () => api.reset() })));
      }
      return p;
    },
  };

  return api;
}

export type Settings = ReturnType<typeof createSettings>;
