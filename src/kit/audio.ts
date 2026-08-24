/* audio.ts — thin glue over Howler.

   Howler already solves the hard parts: decoding, pooling, the autoplay unlock,
   mobile quirks, fades. What it doesn't have is a BUS mixer, which is the one
   thing every game wants — a master, an sfx and a music level that settings.ts
   can bind three sliders to. That's all this adds.

     await Audio.load({ ping: pingUrl, bed: bedUrl });
     Audio.sfx('ping', { volume: 0.6, rate: 1.1 });
     Audio.music('bed', { fade: 1.5 });
     Audio.volume('music', 0.4);
*/

import { Howl, Howler } from 'howler';

type Bus = 'master' | 'sfx' | 'music';

const sounds = new Map<string, Howl>();
const vols: Record<Bus, number> = { master: 0.8, sfx: 1, music: 0.7 };
let muted = false;
// `vol` is tracked here rather than read back from Howler: howl.volume(id) is
// overloaded as both getter and setter, so the read is ambiguous.
let current: { key: string; howl: Howl; id: number; vol: number } | null = null;

Howler.volume(vols.master);

/** Load a map of key → url. Failures warn and are skipped, never thrown. */
export function load(map: Record<string, string>): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  const jobs = Object.entries(map).map(([key, src]) =>
    new Promise<void>((resolve) => {
      if (sounds.has(key)) return resolve();
      const howl = new Howl({ src: [src], preload: true });
      howl.once('load', () => { sounds.set(key, howl); resolve(); });
      howl.once('loaderror', (_id, err) => {
        failed.push(key);
        console.warn(`[audio] could not load "${key}" (${src}) —`, err);
        resolve();
      });
    }));
  return Promise.all(jobs).then(() => ({ ok: failed.length === 0, failed }));
}

export const has = (key: string) => sounds.has(key);

/** Fire a one-shot. @param o.rate also shifts pitch. @param o.pan -1..1 */
export function sfx(key: string, o: { volume?: number; rate?: number; pan?: number } = {}): number | null {
  const howl = sounds.get(key);
  if (!howl) { console.warn(`[audio] no sound "${key}"`); return null; }
  const id = howl.play();
  howl.volume((o.volume ?? 1) * vols.sfx, id);
  if (o.rate != null) howl.rate(o.rate, id);
  if (o.pan != null) howl.stereo(Math.max(-1, Math.min(1, o.pan)), id);
  return id;
}

/** Same sound, slightly different each time — kills machine-gun repetition. */
export function sfxVaried(key: string, o: { volume?: number; spread?: number } = {}) {
  const spread = o.spread ?? 0.08;
  return sfx(key, { ...o, rate: 1 + (Math.random() * 2 - 1) * spread });
}

/** Play a looping bed, crossfading from whatever is playing. */
export function music(key: string | null, o: { fade?: number; volume?: number } = {}) {
  const fade = (o.fade ?? 1) * 1000;
  if (current?.key === key) return;          // already playing: don't restart mid-phrase

  if (current) {
    const old = current;
    old.howl.fade(old.vol, 0, fade, old.id);
    setTimeout(() => old.howl.stop(old.id), fade + 50);
    current = null;
  }
  if (key == null) return;

  const howl = sounds.get(key);
  if (!howl) { console.warn(`[audio] no music "${key}"`); return; }
  howl.loop(true);
  const id = howl.play();
  const target = (o.volume ?? 1) * vols.music;
  howl.volume(0, id);
  howl.fade(0, target, fade, id);
  current = { key, howl, id, vol: target };
}

export function stopMusic(fade = 1) { music(null, { fade }); }
export const currentMusic = () => current?.key ?? null;

/** Get or set a bus level. volume('music') reads; volume('music', 0.4) writes. */
export function volume(bus: Bus, v?: number): number {
  if (v == null) return vols[bus];
  vols[bus] = Math.max(0, Math.min(1, v));
  if (bus === 'master') Howler.volume(muted ? 0 : vols.master);
  if (bus === 'music' && current) { current.vol = vols.music; current.howl.volume(vols.music, current.id); }
  return vols[bus];
}

export function mute(on?: boolean): boolean {
  muted = on ?? !muted;
  Howler.volume(muted ? 0 : vols.master);
  return muted;
}
export const isMuted = () => muted;

export const state = () => ({ loaded: sounds.size, muted, volumes: { ...vols }, music: current?.key ?? null });

/* ── the live watch's way in ──────────────────────────────────────────────────

   The hub can show a running game to somebody else over the tailnet: it captures
   the canvas out of a same-origin iframe and needs the SOUND to ride along, or a
   game whose subject is its audio arrives as a silent picture.

   Howler is reachable from here and from nowhere else — under Vite it is a module
   import, so it never lands on `window` the way its script build does. One line
   publishes it, and the broadcaster taps `masterGain`, which everything this
   module plays already passes through.

   PUBLISHED, NOT PIPED. Nothing is routed anywhere until somebody actually starts
   showing the game; this only makes the graph findable. A static prototype with
   no kit gets the same capability a different way — the hub injects a shim that
   patches AudioNode.connect (see hub/src/static.ts). */
if (typeof window !== 'undefined') {
  (window as unknown as { Howler?: unknown }).Howler ??= Howler;
}
