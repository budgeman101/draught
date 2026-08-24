/* hubsave.ts — make a save follow the PERSON instead of the browser.

   IndexedDB is per-origin per browser, so without this the same person playing
   on two machines has two saves, and two people sharing one machine have one.
   The hub keys saves by tailnet login (which tailscaled sets, so it cannot be
   forged) plus a PROFILE — and the profile is chosen on the shelf before the
   game loads, arriving here as ?as=<name>. Sam never meets a menu.

   IndexedDB stays as the local copy: it makes the game work the instant it
   loads, before any network round trip, and it is what survives if the hub is
   briefly unreachable mid-session.

   THE LOCK. Two devices on one profile would otherwise overwrite each other for
   as long as both are open. Instead this claims the profile, holds it with a
   heartbeat, and if someone takes over, `onLost` fires and writes stop — the
   loser is told rather than silently clobbering the winner.

   There is no offline story to write: the hub serves the game, so you cannot be
   playing without having reached it. */

const BEAT_MS = 10_000;

export interface RemoteRecord { at: number; body: unknown; }

export interface Remote {
  readonly profile: string;
  /** null when the hub has nothing, or is unreachable. Never throws. */
  get(): Promise<RemoteRecord | null>;
  put(body: unknown): Promise<boolean>;
  /**
   * `heldBy` means REFUSED — another device is playing this profile, so do not
   * write. `offline` means the hub could not be reached, which is a completely
   * different thing: play on and save locally. Collapsing the two makes an
   * unreachable hub silently stop the game saving at all.
   */
  claim(takeover?: boolean): Promise<{ ok: boolean; heldBy?: { device: string; since: number }; offline?: boolean }>;
  release(): void;
  /** Called if another device takes the profile. Set it before claiming. */
  onLost: ((heldBy: { device: string } | null) => void) | null;
}

/** Which profile the shelf sent us to. */
export function profileFromUrl(fallback = 'default'): string {
  const p = new URLSearchParams(location.search).get('as');
  return p && /^[a-z0-9][a-z0-9._-]*$/i.test(p) ? p : fallback;
}

/** A readable, stable-per-browser name so "held by" means something to a human. */
function deviceName(): string {
  const KEY = 'hub.device';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch { /* storage disabled; fall through to an unsaved guess */ }
  const ua = navigator.userAgent;
  const guess = /Android|iPhone|iPad|Mobile/i.test(ua) ? 'a phone'
    : /Macintosh/i.test(ua) ? 'a Mac'
    : /Windows/i.test(ua) ? 'a Windows machine'
    : 'a device';
  try { localStorage.setItem(KEY, guess); } catch { /* ignore */ }
  return guess;
}

/* ?nosync=1 — no hub, local save only.

   For automated tests. Without it the hub makes a save survive across browser
   contexts, which is exactly right for a person and exactly wrong for a test
   suite: one test's `hatched: true` leaks into the next and the run becomes
   order-dependent. A test wants to be hermetic, so it opts out and keeps its
   own IndexedDB per context, as it did before any of this existed. */
function inertRemote(profile: string): Remote {
  return {
    profile,
    onLost: null,
    async get() { return null; },
    async put() { return false; },
    async claim() { return { ok: false, offline: true }; },
    release() {},
  };
}

/* THE SLUG IS NOT A LITERAL. It names the project on the hub's shelf, and it is
   already owned by project.mjs — which vite.config.ts hands to the browser as
   __HUB_SLUG__. Typing it into game code again is the same fact in two places,
   and the two only ever disagree in one direction: rename the project and the
   card, the port and the URL all move while the save keeps writing to the old
   key. Nothing errors, nothing is lost yet, and the loss is discovered later by
   a person wondering where their game went.

   Missing, this THROWS. The alternative is a save keyed to the string
   "undefined" — shared by every game whose wiring broke the same way, and
   perfectly silent. A game that refuses to boot gets fixed in a minute; a game
   that boots into the wrong save gets fixed after somebody loses a session. */
function hubSlug(): string {
  // `typeof` and not a bare read: an absent define is an undeclared identifier,
  // which is a ReferenceError rather than undefined.
  const s = typeof __HUB_SLUG__ === 'string' ? __HUB_SLUG__ : '';
  if (!s) {
    throw new Error(
      '[hubsave] __HUB_SLUG__ is not defined, so this game does not know its own name ' +
      'on the hub. vite.config.ts injects it from project.mjs — if that `define` block ' +
      'has gone, run `npm run refresh` to bring the config back.',
    );
  }
  return s;
}

/**
 * Talks to the hub for one project+profile. The slug is the project's, and comes
 * from project.mjs; the profile is a real per-game decision — pass
 * `profileFromUrl('sam')` for a game that has a default player, or leave it and
 * take whatever the shelf sent.
 */
export function hubRemote(profile = profileFromUrl()): Remote {
  /* Checked BEFORE the nosync branch on purpose. Broken wiring is broken in a
     test run too, and a suite that stays green through it is how the bug gets to
     the person instead. */
  const slug = hubSlug();
  if (new URLSearchParams(location.search).has('nosync')) return inertRemote(profile);

  const base = `/api/save/${encodeURIComponent(slug)}/${encodeURIComponent(profile)}`;
  const session = (crypto.randomUUID?.() ?? String(Math.random()).slice(2));
  const device = deviceName();
  let beating: ReturnType<typeof setInterval> | null = null;
  let held = false;

  const api: Remote = {
    profile,
    onLost: null,

    async get() {
      try {
        const r = await fetch(base, { headers: { 'x-hub-session': session } });
        if (!r.ok) return null;
        const j = await r.json() as { found: boolean; at: number | null; body: unknown };
        return j.found && j.at ? { at: j.at, body: j.body } : null;
      } catch { return null; }
    },

    async put(body) {
      if (!held) return false;
      try {
        const r = await fetch(base, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-hub-session': session, 'x-hub-device': device },
          body: JSON.stringify({ body }),
        });
        if (r.status === 409) { held = false; stopBeat(); api.onLost?.(null); return false; }
        return r.ok;
      } catch { return false; }
    },

    async claim(takeover = false) {
      try {
        const r = await fetch(`${base}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, device, takeover }),
        });
        // Only a 200 or a 409 came from the hub. Anything else — a 404 from a
        // bare dev server, a proxy error — is "no hub here", not "refused".
        if (r.status !== 200 && r.status !== 409) { held = false; return { ok: false, offline: true }; }
        const j = await r.json() as { ok: boolean; heldBy?: { device: string; since: number } };
        held = !!j.ok;
        if (held) startBeat();
        return j;
      } catch {
        // No hub reachable: play on with the local copy rather than blocking.
        held = false;
        return { ok: false, offline: true };
      }
    },

    release() {
      stopBeat();
      if (!held) return;
      held = false;
      const payload = JSON.stringify({ session, release: true });
      // sendBeacon so the release survives the page going away
      try {
        navigator.sendBeacon?.(`${base}/beat`, new Blob([payload], { type: 'application/json' }));
      } catch { /* best effort */ }
    },
  };

  function startBeat() {
    stopBeat();
    beating = setInterval(async () => {
      try {
        const r = await fetch(`${base}/beat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session }),
        });
        const j = await r.json() as { ok: boolean; heldBy?: { device: string } | null };
        if (!j.ok) { held = false; stopBeat(); api.onLost?.(j.heldBy ?? null); }
      } catch { /* a blip is not a takeover; keep going */ }
    }, BEAT_MS);
    window.addEventListener('pagehide', api.release, { once: true });
  }

  function stopBeat() { if (beating) clearInterval(beating); beating = null; }

  return api;
}
