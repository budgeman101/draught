/* share.mjs — put this prototype on the tailnet so someone else can play it.

     npm run share            # make sure it is up, print its tailnet URL
     npm run share -- --stop  # stop THIS project. Nothing else is touched.

   This used to run `tailscale serve --bg <my port>` directly, and that was two
   bugs wearing a coat:

     1. `tailscale serve` maps ONE local port to `/`. Sharing a second prototype
        silently un-shared the first, and the URL was the same either way, so
        whoever you sent it to got whatever you shared LAST.
     2. `--stop` ran `tailscale serve reset`, which is global. Taking your own
        thing down took down everything anybody else had up too.

   Both are gone. The tailnet root now belongs to the hub (../hub), permanently,
   and every prototype lives under it at /p/<slug>/. This script just asks the hub
   to make sure this project is running and tells you the URL.

   Private tailnet only. `funnel` is deliberately not wired up here — if you want
   a public link, run it yourself, on purpose. */

import { slug, hubControl as CONTROL, hubPort, hubUrl } from '../project.mjs';

/* Slug and the hub's control address come from project.mjs — the one module
   that works out where this project lives. */
const args = process.argv.slice(2);

class Bail extends Error {}
const bail = (msg) => { throw new Bail(msg); };

async function hub(path, init) {
  let res;
  try {
    res = await fetch(CONTROL + path, { ...init, headers: { ...init?.headers, connection: 'close' } });
  } catch {
    bail(
      `the hub is not running (${CONTROL} refused).\n` +
      '        Start it:  cd ../hub && npm start\n' +
      '        It also starts itself at login — see hub/README.md if it did not.',
    );
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  return { status: res.status, body };
}

async function main() {
  if (args.includes('--built')) {
    console.warn('[share] --built is not wired to the hub: it fronts the dev server, not `vite preview`.');
    console.warn('        Ignoring the flag and sharing the dev server.');
  }

  const first = await hub(`/api/status/${slug}`);
  if (first.status === 404) {
    bail(
      `"${slug}" is not in the hub registry.\n` +
      '        Add it to hub/projects.json (slug, folder, port, title, blurb, stack, status,\n' +
      '        needsKeyboard) and restart the hub. Put the slug in a .hubslug file if it\n' +
      '        should differ from the folder name.',
    );
  }
  const project = first.body;

  if (args.includes('--stop')) {
    if (project.stack !== 'vite') {
      console.log(`[share] ${slug} is served straight off disk by the hub — there is nothing to stop.`);
      console.log('[share] (and nothing here can take the tailnet down for anyone else any more.)');
      return;
    }
    const { body } = await hub(`/api/stop/${slug}`, { method: 'POST' });
    console.log(`[share] ${slug} stopped (state: ${body.state ?? '?'}).`);
    console.log('[share] the hub and every other prototype are untouched.');
    return;
  }

  let state = project.state;
  if (project.stack === 'vite' && state !== 'running') {
    console.log(`[share] starting ${slug}…`);
    const { body } = await hub(`/api/start/${slug}`, { method: 'POST' });
    state = body.state;
    if (state !== 'running') {
      console.error(`[share] ${slug} is ${state}:`);
      console.error((body.error || '(no detail)').split('\n').map((l) => '        ' + l).join('\n'));
      console.error('[share] it will still load, but it is broken — fix it before you send the link.');
    }
  }

  const { body: net } = await hub('/api/tailnet');
  if (!net?.base) {
    console.warn('[share] the hub is up but the tailnet root is not held. On the desktop, run:');
    console.warn(`        & 'C:\\Program Files\\Tailscale\\tailscale.exe' serve --bg --yes ${hubPort}`);
    console.warn(`[share] locally: ${hubUrl}`);
    return;
  }

  console.log(`\n[share] ${net.base}/p/${slug}/`);
  console.log(`[share] shelf: ${net.base}/`);
  console.log(`[share] state: ${project.stack === 'vite' ? state : 'static (always up)'}`);
  console.log('[share] stop just this one with:  npm run share -- --stop');
}

/* No process.exit() anywhere below: undici keeps a keep-alive socket for a beat
   after the last fetch, and tearing the loop down under it trips a libuv
   assertion on Windows — which reads exactly like the script crashed. Set the
   code and let the process end on its own. */
try {
  await main();
} catch (e) {
  console.error('[share]', e instanceof Bail ? e.message : e);
  process.exitCode = 1;
}
