/* refresh.mjs — pull toolchain fixes from the canonical template into this game.

   This is what makes "each game owns its copy" survivable: a fix to the save
   wrapper or the Vite config reaches an existing game with one command, without
   coupling nine repos to a shared version number.

     npm run refresh              # update toolchain + src/kit from the template
     npm run refresh -- --dry     # show what would change, touch nothing
     npm run refresh -- --from ../elsewhere/template

   WHAT IT DELIBERATELY WILL NOT TOUCH:
     src/kit/theme.css   the look is meant to diverge per game
     anything in .refreshkeep  paths this project has taken ownership of
     src/game/**         your game
     src/assets/**       your art
     index.html          your title and page shell
     package.json        your dependency set (drift is REPORTED, not fixed)
     .devport            your port

   The rule of thumb: it refreshes things that are the same in every game, and
   never things that are the point of this game. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const fromArg = args[args.indexOf('--from') + 1];

/** Walk up looking for game-ideas-meta/template, so this works from anywhere. */
function findTemplate() {
  if (fromArg && !fromArg.startsWith('--')) return path.resolve(fromArg);
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const guess = path.join(dir, 'game-ideas-meta', 'template');
    if (existsSync(path.join(guess, 'package.json'))) return guess;
    const sibling = path.join(dir, '..', 'game-ideas-meta', 'template');
    if (existsSync(path.join(sibling, 'package.json'))) return path.resolve(sibling);
    dir = path.dirname(dir);
  }
  return null;
}

const SRC = findTemplate();
if (!SRC) {
  console.error('[refresh] could not find game-ideas-meta/template above this directory.');
  console.error('          pass it explicitly:  npm run refresh -- --from <path>');
  process.exit(1);
}
const DEST = process.cwd();
if (path.resolve(SRC) === path.resolve(DEST)) {
  console.error('[refresh] this IS the template — nothing to pull from.');
  process.exit(1);
}

const FILES = [
  // project.mjs first: the four files under it all import it, and a refresh that
  // updated them without it would leave a game importing a module it has not got.
  'project.mjs',
  'vite.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'tsconfig.json',
  '.gitignore',
  '.gitattributes',
  '.nvmrc',
  'scripts/shot.mjs',
  'scripts/share.mjs',
  'scripts/refresh.mjs',
  'src/vite-env.d.ts',
];

/** Every kit module EXCEPT the theme. */
for (const f of readdirSync(path.join(SRC, 'src', 'kit'))) {
  if (f === 'theme.css') continue;
  FILES.push(path.join('src', 'kit', f).replaceAll('\\', '/'));
}

/* PER-PROJECT DIVERGENCE. `.refreshkeep` lists paths this project has taken
   ownership of, one per line, and refresh will never overwrite them.

   It exists because the kit is only "the same in every game" until a game
   changes something fundamental. harbor-game ported scenes.ts from Pixi to
   Three; without this the next refresh quietly hands it back the Pixi version
   and breaks the build — and it reads as a mystery, because nobody expects an
   update command to edit their code.

   Use it sparingly: every entry is a module that stops receiving fixes. */
function keepList() {
  const p = path.join(DEST, '.refreshkeep');
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.split('#')[0].trim())
      .filter(Boolean),
  );
}
const KEEP = keepList();

let changed = 0, added = 0, same = 0, kept = 0;
for (const rel of FILES) {
  if (KEEP.has(rel)) { kept++; continue; }
  const from = path.join(SRC, rel);
  const to = path.join(DEST, rel);
  if (!existsSync(from) || statSync(from).isDirectory()) continue;

  const exists = existsSync(to);
  if (exists && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) { same++; continue; }

  console.log(`  ${exists ? 'update' : 'add   '}  ${rel}`);
  if (!DRY) {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  exists ? changed++ : added++;
}

/* dependency drift: reported, never silently applied — a game may be pinned on
   an old Pixi for a reason, and this script is not going to guess. */
const readPkg = (dir) => {
  try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return null; }
};
const tpl = readPkg(SRC), mine = readPkg(DEST);
if (tpl && mine) {
  const drift = [];
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, want] of Object.entries(tpl[field] ?? {})) {
      const got = mine[field]?.[name] ?? mine.dependencies?.[name] ?? mine.devDependencies?.[name];
      if (!got) drift.push(`  MISSING  ${name}@${want}   (npm i ${field === 'devDependencies' ? '-D ' : ''}${name})`);
      else if (got !== want) drift.push(`  differs  ${name}: ${got}  → template has ${want}`);
    }
  }
  if (drift.length) {
    console.log('\n[refresh] dependency drift (not changed for you):');
    for (const d of drift) console.log(d);
  }
}

console.log(`\n[refresh] ${DRY ? 'would update' : 'updated'} ${changed}, added ${added}, unchanged ${same}`);
console.log(`[refresh] source: ${SRC}`);
if (!DRY && (changed || added)) console.log('[refresh] theme.css, src/game, src/assets and package.json were left alone.');
