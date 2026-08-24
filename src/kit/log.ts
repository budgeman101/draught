/* log.ts — an append-only record of what happened during a session.

   AIMED AT THE SOLO-PLAYTEST BLIND SPOT. You can't fresh-eyes your own game, and
   when someone else plays it over Tailscale you get "it was fun I guess" rather
   than where they stalled. This records the run so you can READ it afterwards:
   what they did, in what order, how long they sat on each thing.

   Log DECISIONS and STATE CHANGES, not frames. A hundred entries you can read
   beats a hundred thousand you can't.

     const log = createLog({ seed: 'brimtoveharn' });
     log.event('launch', { power: 1.02 });
     log.event('captured', { total: 4 });
     log.download();     // or log.dump() for the JSON
*/

export interface LogEntry {
  /** Seconds since session start, to 2dp. */
  t: number;
  type: string;
  data?: Record<string, unknown>;
}

export function createLog(meta: Record<string, unknown> = {}) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const entries: LogEntry[] = [];
  let cap = 5000;
  let enabled = true;

  const api = {
    entries,

    event(type: string, data?: Record<string, unknown>) {
      if (!enabled) return api;
      entries.push({ t: +((performance.now() - started) / 1000).toFixed(2), type, ...(data ? { data } : {}) });
      if (entries.length > cap) entries.splice(0, Math.floor(cap * 0.2));   // drop the oldest fifth
      return api;
    },

    /** How long since the last event of this type — for "they sat here for 40s". */
    sinceLast(type: string): number | null {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.type === type) return +((performance.now() - started) / 1000 - entries[i]!.t).toFixed(2);
      }
      return null;
    },

    count(type: string) { return entries.reduce((n, e) => n + (e.type === type ? 1 : 0), 0); },

    /** A quick tally of every event type — the first thing you want to look at. */
    summary(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const e of entries) out[e.type] = (out[e.type] ?? 0) + 1;
      return out;
    },

    dump(): string {
      return JSON.stringify({
        startedAt,
        durationSec: +((performance.now() - started) / 1000).toFixed(1),
        meta,
        summary: api.summary(),
        entries,
      }, null, 2);
    },

    download(filename?: string) {
      const name = filename ?? `playtest-${startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
      const blob = new Blob([api.dump()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return name;
    },

    enable(on = true) { enabled = on; return api; },
    setCap(n: number) { cap = n; return api; },
    clear() { entries.length = 0; return api; },
  };

  api.event('session-start', { ...meta });
  return api;
}

export type Log = ReturnType<typeof createLog>;
