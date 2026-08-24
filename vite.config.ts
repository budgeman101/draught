import { defineConfig } from 'vite';
import { port, slug, devBase, buildBase } from './project.mjs';

/* Port, slug and base all come from project.mjs — the one place that works out
   where this project lives. See the header there for why they are not derived
   here any more. */

export default defineConfig(({ command }) => ({
  server: {
    port,
    // strictPort matters — without it Vite silently increments to the next free
    // port, which breaks the one-port-per-project registry AND changes the URL
    // you just shared over Tailscale. Fail loudly instead.
    strictPort: true,
    host: '127.0.0.1',
    // tailscale serve proxies to localhost, but Vite 8 enforces a Host allowlist,
    // so the tailnet domain must be permitted for `npm run share` to work.
    allowedHosts: ['.ts.net'],
  },
  preview: {
    port: port + 1,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['.ts.net'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // a frozen prototype commits dist/ and runs forever with no npm install,
    // so keep the output relative rather than root-absolute
    assetsDir: 'assets',
  },
  // dev is served behind the hub's /p/<slug>/ prefix; the build stays relative
  // so a committed dist/ opens from anywhere. Both come from project.mjs.
  base: command === 'serve' ? devBase : buildBase,
  define: {
    /* THE SLUG, handed down to the browser. The hub keys every save by
       <login>/<slug>/<profile>, so the game has to know its own slug — and it
       used to know it by having the string typed into src/game/main.ts a second
       time. That is the same fact in two places: rename the project and the
       registry, the base path and the port all move together while the save
       quietly keeps writing to the old key, with nothing anywhere complaining.
       So it comes from project.mjs like everything else about where this project
       lives, and hubRemote() takes no slug argument at all.

       Typed in src/vite-env.d.ts. If this define ever goes missing, hubsave.ts
       throws rather than syncing to a key called "undefined" — see the note
       there for why a loud boot failure is the lesser evil. */
    __HUB_SLUG__: JSON.stringify(slug),
  },
}));
