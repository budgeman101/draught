/* rng.ts — seeded, deterministic random.

   CONVENTION: every run takes a seed, and each system draws from its OWN forked
   stream. Two reasons. A run you can't reproduce is a bug you can't fix. And if
   systems share one stream, drawing one extra value anywhere shifts every
   downstream system — so a change to loot silently rewrites the weather. */

/** FNV-1a. Any string → a stable 32-bit seed, forever. */
export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface Rng {
  (): number;
  range(min: number, max: number): number;
  /** Inclusive at BOTH ends — dice, not array indices. */
  int(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T | undefined;
  chance(p: number): boolean;
  shuffle<T>(arr: readonly T[]): T[];
  gauss(mu?: number, sigma?: number): number;
  /** An independent stream from the same seed lineage. */
  fork(label: string): Rng;
  state(): number;
  setState(s: number): void;
  readonly seed: string;
}

/** mulberry32: small, fast, and one uint32 of state — so a save can resume mid-stream. */
export function makeRng(seed: string | number): Rng {
  let state = (typeof seed === 'number' ? seed >>> 0 : hashStr(seed)) || 1;
  const label = String(seed);

  const rng = function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  } as Rng;

  rng.range = (min, max) => min + rng() * (max - min);
  rng.int = (min, max) => Math.floor(min + rng() * (max - min + 1));
  rng.pick = (arr) => (arr.length ? arr[Math.floor(rng() * arr.length)] : undefined);
  rng.chance = (p) => rng() < p;
  rng.shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  rng.gauss = (mu = 0, sigma = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
  };
  rng.fork = (sub) => makeRng(hashStr(label + '::' + sub));
  rng.state = () => state;
  rng.setState = (s) => { state = s >>> 0; };
  Object.defineProperty(rng, 'seed', { value: label });

  return rng;
}

/** A pronounceable seed to show the player: "brimtoveharn". */
export function seedWord(): string {
  const c = 'bdfghklmnprstvw', v = 'aeiou';
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += c.charAt(Math.floor(Math.random() * c.length)) + v.charAt(Math.floor(Math.random() * v.length));
  }
  return s;
}
