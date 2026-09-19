import fs from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

/**
 * Bezpiecznik regresji: **nic** nie zmienia pliku poświadczeń użytkownika.
 *
 * Reguła jest bezwzględna i nie ma wyjątku „to tylko ta sama treść". Zapis
 * identycznej treści i tak obcina plik i przepisuje go od nowa, a między
 * obcięciem a zapisem mieści się awaria zasilania, brak miejsca i odświeżenie
 * tokenu przez działającą sesję. Że kilka razy się udało, było wynikiem losu,
 * nie konstrukcji.
 *
 * ## Dlaczego to jest WYKRYWANIE, a nie zapobieganie
 *
 * Pierwsza wersja tego pliku podmieniała funkcje zapisu w przestrzeni nazw
 * `node:fs` i **nie działała** — co wyszło dopiero na próbie, bo test, który
 * miała zatrzymać, przeszedł, a plik użytkownika i tak został przepisany.
 * Przyczyna jest w module ESM, nie w regule: testy importują
 * `import { writeFileSync } from 'node:fs'`, czyli **import nazwany**. Wiązanie
 * takiego importu powstaje przy linkowaniu modułu i wskazuje na oryginalną
 * funkcję; podmiana własności na obiekcie przestrzeni nazw nie ma jak go
 * przestawić. Bezpiecznik, który wygląda na ochronę i nią nie jest, jest gorszy
 * od żadnego — usypia.
 *
 * Co zostaje i co naprawdę działa:
 *
 *  1. **Odcisk przed i po każdym pliku testowym** (`beforeAll`/`afterAll`
 *     rejestrowane tutaj obowiązują dla każdej suity). Łapie **każdy** sposób
 *     zapisu: import nazwany, `fs.writeFileSync`, proces potomny, CLI. Nie
 *     zapobiega — mówi głośno, który plik testowy to zrobił.
 *  2. **Podmiana w przestrzeni nazw** jako obrona dodatkowa dla formy
 *     `fs.writeFileSync(...)`. Zatrzymuje ją *przed* zapisem, ale obejmuje
 *     tylko tę formę i nic więcej się o niej nie twierdzi.
 *
 * Jeśli kontrola wymaga pokazania, że zapis zostaje wykryty — **wskaż ją na
 * ścieżkę tymczasową**. Własność „odcisk zauważa zapis" nie zależy od tego,
 * który plik się zapisuje.
 */

/**
 * Prawdziwa ścieżka poświadczenia, ustalona **zanim** jakikolwiek test
 * przekieruje `CLAUDE_CONFIG_DIR`.
 */
export const REAL_CREDENTIAL_FILE = resolve(
  process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
  '.credentials.json',
);

/** Rozmiar i czas modyfikacji; ani jedno, ani drugie nie jest sekretem. */
const fingerprint = (): string => {
  try {
    const st = fs.statSync(REAL_CREDENTIAL_FILE);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'brak';
  }
};

let before = 'brak';

beforeAll(() => {
  before = fingerprint();
});

afterAll(() => {
  const after = fingerprint();
  expect(
    after,
    `plik poswiadczen uzytkownika (${REAL_CREDENTIAL_FILE}) zmienil sie w trakcie tego pliku ` +
      'testowego. Testy nie zapisuja go w zadnym celu — takze identyczna trescia. Jesli kontrola ' +
      'ma pokazac, ze zapis jest wykrywany, wskaz ja na katalog tymczasowy ' +
      '(CLAUDE_CONFIG_DIR = mkdtempSync(...)).',
  ).toBe(before);
});

/* ------------------ obrona dodatkowa: forma `fs.writeFileSync` ------------- */

const describeTarget = (target: unknown): string => {
  if (typeof target === 'string') return target;
  if (target instanceof URL) return target.pathname;
  if (Buffer.isBuffer(target)) return target.toString('utf8');
  return '';
};

const isUserCredential = (target: unknown): boolean => {
  const asPath = describeTarget(target);
  if (!asPath) return false;
  try {
    return resolve(asPath) === REAL_CREDENTIAL_FILE;
  } catch {
    return false;
  }
};

const refuse = (fn: string): never => {
  throw new Error(
    `[bezpiecznik] ${fn}() wycelowane w plik poswiadczen uzytkownika (${REAL_CREDENTIAL_FILE}). ` +
      'Wskaz probe na katalog tymczasowy.',
  );
};

type Writer = 'writeFileSync' | 'appendFileSync' | 'unlinkSync' | 'truncateSync' | 'copyFileSync';
for (const name of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'truncateSync', 'copyFileSync'] as Writer[]) {
  const original = fs[name] as (...args: unknown[]) => unknown;
  if (typeof original !== 'function') continue;
  (fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    // `copyFileSync(src, dest)` — chroniony jest CEL; kopiowanie poświadczenia
    // do katalogu tymczasowego jest dozwolone i używane.
    const target = name === 'copyFileSync' ? args[1] : args[0];
    if (isUserCredential(target)) refuse(name);
    return original(...args);
  };
}
