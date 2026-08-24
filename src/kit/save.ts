/* save.ts — versioned persistence over idb-keyval.

   The library does storage. This does the part no library does well: schema
   VERSIONING and migration, so a save written by build 3 still opens in build 11.

     const store = createStore({
       key: 'harbor',
       version: 3,
       defaults: { runs: 0, hold: [] },
       migrate: { 2: (d) => {...; return d}, 3: (d) => {...; return d} },
     });
     await store.load();
     store.data.runs++;
     store.save();

   Three things it refuses to do, each one a way hand-rolled saves lose data:
     1. Never throws. Storage disabled, disk full, private mode — save() returns
        false and the game carries on.
     2. Never reads a FUTURE version. Open an old build against a newer save and
        it runs on defaults and refuses to write, rather than misreading the save
        and then overwriting it with the misreading.
     3. Never half-applies an import. A candidate is validated and migrated
        completely before it replaces anything.

   Migrations are keyed by the version they PRODUCE, so v1 → v3 runs 2 then 3. */

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { Remote } from './hubsave.ts';

const ENVELOPE = 'kitsave1';

export type Migration<T = any> = (data: any, toVersion: number) => T;

export interface StoreOptions<T> {
  key: string;
  version?: number;
  defaults: T;
  migrate?: Record<number, Migration<T>>;
  /** Key suffix — settings.ts uses 'settings' so it lives beside the save. */
  space?: string;
  slot?: string | null;
  /**
   * Optional hub sync — see hubsave.ts. Given one, the store keeps IndexedDB as
   * its local copy but treats the hub as the shared truth, so a save follows the
   * PERSON across devices instead of living in one browser. Omitted, everything
   * below behaves exactly as it always did.
   */
  remote?: Remote | null;
}

type DecodeResult =
  | { status: 'empty' }
  | { status: 'corrupt' }
  | { status: 'future'; version: number }
  | { status: 'ok'; data: any; version: number; migrated: boolean };

const isPlain = (v: unknown): v is Record<string, any> =>
  v != null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function clone<T>(v: T): T {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (!isPlain(v)) return v;
  const o: Record<string, any> = {};
  for (const k of Object.keys(v)) o[k] = clone((v as any)[k]);
  return o as T;
}

/** Objects recurse; arrays and primitives replace. Merging a saved 5-slot
    inventory with a 3-slot default by index is never what anyone means. */
function deepMerge<T>(base: T, over: any): T {
  if (!isPlain(base)) return clone(over);
  const out: Record<string, any> = clone(base) as any;
  if (!isPlain(over)) return out as T;
  for (const k of Object.keys(over)) {
    out[k] = isPlain(out[k]) && isPlain(over[k]) ? deepMerge(out[k], over[k]) : clone(over[k]);
  }
  return out as T;
}

export function createStore<T extends object>(opts: StoreOptions<T>) {
  const { key, version = 1, defaults, migrate = {}, space = 'save', slot = null, remote = null } = opts;
  const storageKey = slot ? `${key}.${slot}.${space}` : `${key}.${space}`;

  const listeners: Record<string, ((p: any) => void)[]> = {};
  let loaded = false, dirty = false, readonly = false;
  let writing: Promise<boolean> = Promise.resolve(true);
  let autosaveTimer: ReturnType<typeof setInterval> | null = null;
  let hooksBound = false;

  function emit(evt: string, payload?: any) {
    for (const fn of listeners[evt] ?? []) {
      try { fn(payload); } catch (e) { console.error('[save]', e); }
    }
  }

  /** Parse and run the migration chain. Pure — never writes. */
  function decode(raw: unknown): DecodeResult {
    if (raw == null) return { status: 'empty' };
    let parsed: any = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { return { status: 'corrupt' }; }
    }
    if (!parsed || typeof parsed !== 'object') return { status: 'corrupt' };

    // accept a bare object too, so a pre-kit save can be imported without ceremony
    const enveloped = parsed.e === ENVELOPE;
    let v: number = enveloped ? (parsed.v | 0) || 1 : 1;
    let data: any = enveloped ? parsed.d : parsed;
    if (data == null || typeof data !== 'object') return { status: 'corrupt' };
    if (v > version) return { status: 'future', version: v };

    const from = v;
    let migrated = false;
    while (v < version) {
      const step = migrate[v + 1];
      v++;
      if (typeof step !== 'function') continue;   // undeclared step: fields just merge over defaults
      try {
        const out = step(data, v);
        if (out !== undefined) data = out;
        migrated = true;
      } catch (err) {
        console.error(`[save] migration to v${v} threw — keeping the pre-migration shape.`, err);
        return { status: 'ok', data, version: from, migrated };
      }
    }
    return { status: 'ok', data, version: from, migrated };
  }

  const api = {
    key: storageKey,
    version,
    data: clone(defaults),
    get loaded() { return loaded; },
    get readonly() { return readonly; },

    on(evt: 'load' | 'save' | 'error' | 'migrated' | 'import', fn: (p: any) => void) {
      (listeners[evt] ??= []).push(fn);
      return api;
    },

    async load(): Promise<T> {
      let raw: unknown = null;
      try { raw = await idbGet(storageKey); } catch { raw = null; }

      /* HUB FIRST, when there is one. Claim the profile, then take whichever
         copy is newer — the local one is normally right, but "newer on another
         device" is exactly the case this exists to fix. A failed claim means
         someone else is playing this profile: we still LOAD (so you can watch)
         but never write, which is the lock doing its job. */
      if (remote) {
        const claim = await remote.claim();
        /* Read-only ONLY when the hub actively refused, i.e. another device is
           playing this profile. An unreachable hub is not a refusal — treating
           it as one silently stops the game saving anywhere, including locally,
           which is far worse than the problem the lock solves. */
        if (!claim.ok && claim.heldBy) {
          readonly = true;
          emit('error', { reason: 'held-elsewhere', heldBy: claim.heldBy });
        }
        remote.onLost = (heldBy) => {
          readonly = true;
          console.warn('[save] another device took this profile; no longer writing.');
          emit('error', { reason: 'taken-over', heldBy });
        };
        const there = await remote.get();
        const hereAt = (raw as { at?: number } | null)?.at ?? 0;
        if (there && there.at > hereAt) raw = there.body;
      }

      const result = decode(raw);

      if (result.status === 'future') {
        readonly = true;
        api.data = clone(defaults);
        console.warn(`[save] "${storageKey}" was written by a newer build (v${result.version} > v${version}). ` +
                     'Running on defaults; this store will not overwrite it.');
        emit('error', { reason: 'future-version', found: result.version });
      } else if (result.status === 'ok') {
        api.data = deepMerge(defaults, result.data);
        if (result.migrated) { dirty = true; emit('migrated', { from: result.version, to: version }); }
      } else {
        api.data = clone(defaults);
        if (result.status === 'corrupt') emit('error', { reason: 'corrupt' });
      }
      loaded = true;
      emit('load', api.data);
      return api.data;
    },

    /** Fire-and-forget write. Returns false only if the store is read-only. */
    save(): boolean {
      if (readonly) return false;
      dirty = false;
      const body = { e: ENVELOPE, v: version, at: Date.now(), d: api.data };
      // The hub copy is fire-and-forget: a network blip must never make a local
      // save fail, and the local copy is what the next load falls back to.
      if (remote) void remote.put(body);
      writing = idbSet(storageKey, body)
        .then(() => { emit('save', { key: storageKey }); return true; })
        .catch((err) => {
          console.warn(`[save] could not write "${storageKey}" —`, err?.name ?? err);
          emit('error', { reason: 'write-failed', error: err });
          return false;
        });
      return true;
    },

    patch(obj: Partial<T>): boolean { Object.assign(api.data as object, obj); return api.save(); },
    touch() { dirty = true; return api; },
    async flush(): Promise<boolean> { if (dirty) api.save(); return writing; },

    /**
     * Debounced background writes plus a flush when the page goes away. The
     * pagehide flush is the part hand-rolled saves miss — it's what stops
     * "I closed the tab and lost ten minutes".
     */
    autosave(ms = 5000) {
      api.stopAutosave();
      autosaveTimer = setInterval(() => { if (dirty) api.save(); }, ms);
      if (!hooksBound) {
        hooksBound = true;
        const bail = () => { if (dirty) api.save(); };
        document.addEventListener('visibilitychange', () => { if (document.hidden) bail(); });
        window.addEventListener('pagehide', bail);
      }
      return api;
    },
    stopAutosave() { if (autosaveTimer) clearInterval(autosaveTimer); autosaveTimer = null; return api; },

    reset(): boolean { api.data = clone(defaults); readonly = false; return api.save(); },
    async erase(): Promise<void> { await idbDel(storageKey).catch(() => {}); },

    /** Portable, pretty-printed so it diffs and reads. */
    export(): string {
      return JSON.stringify({ e: ENVELOPE, key: storageKey, v: version, at: Date.now(), d: api.data }, null, 2);
    },

    exportFile(filename?: string): string {
      const name = filename ?? `${storageKey}-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([api.export()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return name;
    },

    /** Validates and migrates a candidate BEFORE it replaces live data. */
    import(text: string, { save = true } = {}): { ok: boolean; error?: string; from?: number } {
      const result = decode(text);
      if (result.status === 'future') return { ok: false, error: `save is from a newer version (v${result.version} > v${version})` };
      if (result.status === 'corrupt') return { ok: false, error: 'not a readable save file' };
      if (result.status === 'empty') return { ok: false, error: 'empty file' };
      api.data = deepMerge(defaults, result.data);
      readonly = false;
      if (save) api.save();
      emit('import', api.data);
      return { ok: true, from: result.version };
    },

    async importFile(file: File) {
      try { return api.import(await file.text()); }
      catch (e) { return { ok: false, error: String(e) }; }
    },

    /** Approximate stored size, for a debug readout. */
    size(): number { try { return JSON.stringify(api.data).length; } catch { return 0; } },
  };

  return api;
}

export type Store<T extends object> = ReturnType<typeof createStore<T>>;
