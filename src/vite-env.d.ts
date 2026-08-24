/// <reference types="vite/client" />

/* The hub slug — the name this project answers to on the shelf, and the middle
   segment of every save key. vite.config.ts injects it with `define`, from
   project.mjs, so the game never carries a second copy of its own name.

   Declared here rather than next to hubsave.ts because a `define` is a global
   the whole bundle can see, and because this file is one of the ones
   `npm run refresh` carries into an existing game — so the type arrives with the
   config that supplies the value. */
declare const __HUB_SLUG__: string;
