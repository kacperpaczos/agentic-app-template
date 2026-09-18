#!/usr/bin/env node
/**
 * Typecheck every business module on its own.
 *
 * Wymaganie (L9.11, L9.12): moduł z ekranami przechodzi typecheck niezależnie
 * od tego, czy aplikacja go składa.
 *
 * `pnpm typecheck:src` kompiluje jeden program: platformę, moduły i aplikację
 * razem. W takim programie moduł widzi globalną rejestrację routera aplikacji
 * (`declare module '@tanstack/react-router' { interface Register … }`) i może
 * — niezauważenie — zacząć od niej zależeć. Tak było: strona modułu czytała
 * parametry trasy przez identyfikator trasy zarejestrowanej przez aplikację,
 * więc aplikacja, która tej trasy nie montuje, nie umiała skompilować modułu,
 * a próba wymiany musiała usunąć połówkę UI modułu przykładowego.
 *
 * Ten skrypt kompiluje każdy `packages/module-*` we własnym programie: bez
 * `apps/`, bez innych modułów, bez testów. Moduł, który potrzebuje aplikacji,
 * żeby się skompilować, oblewa tutaj — i to jest jedyne miejsce, gdzie da się
 * to zobaczyć.
 *
 *   node scripts/typecheck-modules.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Kompilator zainstalowany w repozytorium, bez polegania na PATH. */
const tsc = join(root, 'node_modules/.bin/tsc');
const modules = readdirSync(join(root, 'packages'))
  .filter((d) => d.startsWith('module-') && statSync(join(root, 'packages', d)).isDirectory())
  .sort();

if (!existsSync(tsc)) {
  console.error('Brak node_modules/.bin/tsc — uruchom pnpm install.');
  process.exit(1);
}

if (modules.length === 0) {
  console.error('Nie znaleziono zadnego packages/module-* — nie ma czego sprawdzic.');
  process.exit(1);
}

let failed = 0;
for (const mod of modules) {
  const project = join('packages', mod, 'tsconfig.json');
  if (!existsSync(join(root, project))) {
    // Bez własnego tsconfig moduł byłby sprawdzany wyłącznie razem z aplikacją,
    // czyli dokładnie tak, jak przed wprowadzeniem tego wymagania.
    console.error(`BLAD ${mod}: brak ${project} — modul musi dac sie sprawdzic osobno.`);
    failed += 1;
    continue;
  }
  const r = spawnSync(tsc, ['-p', project, '--noEmit'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status === 0) {
    console.log(`OK   ${mod} — typecheck bez aplikacji`);
  } else {
    failed += 1;
    console.error(`BLAD ${mod} — typecheck bez aplikacji nie przeszedl:\n${out}`);
  }
}

if (failed) {
  console.error(`\n${failed} modul(y) nie przechodza typecheck samodzielnie.`);
  process.exit(1);
}
console.log(`Kazdy modul (${modules.length}) przechodzi typecheck we wlasnym programie, bez apps/.`);
