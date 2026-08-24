/* errors.ts — make a crash impossible to miss.

   THE PROBLEM, which is the same one the retired raf-harness was built around:
   a canvas game that has thrown inside its update loop looks EXACTLY like a
   healthy paused one. Same last frame, same pixels, no visible difference. The
   error goes to a console nobody has open, and you spend ten minutes wondering
   why clicking does nothing.

   Vite's overlay catches build errors. This catches runtime ones — a red bar
   over the board the instant anything throws, including inside rAF and inside a
   promise. Dev only; install() is a no-op in a production build. */

let host: HTMLElement | null = null;
let count = 0;

function show(kind: string, message: string, stack?: string) {
  count++;
  if (!host) {
    host = document.createElement('div');
    host.className = 'kit-error';
    const dismiss = document.createElement('button');
    dismiss.textContent = 'dismiss';
    dismiss.addEventListener('click', () => { host?.remove(); host = null; });
    host.appendChild(dismiss);
    document.body.appendChild(host);
  }
  const entry = document.createElement('div');
  const head = document.createElement('b');
  head.textContent = `${kind}: ${message}`;
  entry.append(head);
  if (stack) {
    const pre = document.createElement('div');
    // first few frames only — the whole stack buries the useful line
    pre.textContent = stack.split('\n').slice(1, 5).join('\n');
    pre.style.opacity = '.75';
    entry.append(pre);
  }
  host.appendChild(entry);
  if (count > 8) {   // a throw inside the loop fires every frame; don't grow forever
    host.querySelectorAll('div')[1]?.remove();
  }
}

/** Call once at boot. Returns a teardown function. */
export function installErrorBanner(): () => void {
  if (!import.meta.env.DEV) return () => {};

  const onError = (e: ErrorEvent) => {
    show('Error', e.message || String(e.error), e.error?.stack);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const r: any = e.reason;
    show('Unhandled rejection', r?.message ?? String(r), r?.stack);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    host?.remove();
    host = null;
  };
}

/** Report a caught error deliberately — for a try/catch you don't want silent. */
export function reportError(where: string, err: unknown) {
  const e = err as any;
  console.error(`[${where}]`, err);
  if (import.meta.env.DEV) show(where, e?.message ?? String(err), e?.stack);
}
