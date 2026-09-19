import fs from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Bezpiecznik regresji: **nic** nie zapisuje pliku poświadczeń użytkownika.
 *
 * Reguła jest bezwzględna i nie ma wyjątku „to tylko ta sama treść". Zapis
 * identycznej treści i tak obcina plik i przepisuje go od nowa, a między
 * obcięciem a zapisem mieści się awaria zasilania, brak miejsca i odświeżenie
 * tokenu przez działającą sesję. Że dwa razy się udało, było wynikiem losu, nie
 * konstrukcji — stąd ten plik.
 *
 * Powód, dla którego to jest **hak w regresji**, a nie akapit w CONTRIBUTING:
 * własność „żaden test nie pisze pod tę ścieżkę" była prawdziwa *z konstrukcji*
 * przez cały ten pakiet, i mimo to została złamana dwa razy — raz świadomie w
 * próbie zdolności wykrycia, raz przez powtórzenie tego samego wzorca. Reguła,
 * której przestrzeganie zależy od pamięci piszącego, jest regułą do złamania.
 *
 * Co robi: podmienia funkcje zapisu `node:fs` na warianty, które **rzucają**,
 * gdy cel rozwiązuje się do prawdziwego `.credentials.json` — i tylko wtedy.
 * Katalogi tymczasowe, kopie i atrapy przechodzą bez zmian, bo cała praca z
 * poświadczeniem w testach ma iść przez `CLAUDE_CONFIG_DIR` wskazujący
 * `mkdtemp`. Jeśli kontrola wymaga pokazania, że zapis zostaje wykryty,
 * **wskaż ją na ścieżkę tymczasową**: własność „odcisk zauważa zapis" nie
 * zależy od tego, który plik się zapisuje.
 */

/**
 * Prawdziwa ścieżka poświadczenia, ustalona **zanim** jakikolwiek test
 * przekieruje `CLAUDE_CONFIG_DIR`.
 *
 * Liczy się katalog domowy i wartość zmiennej z chwili startu procesu: to jest
 * plik, który naprawdę należy do użytkownika. Późniejsze przekierowania to
 * właśnie te przypadki, które mają być dozwolone.
 */
const REAL_CREDENTIAL_FILE = resolve(
  process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
  '.credentials.json',
);

const describeTarget = (target: unknown): string => {
  if (typeof target === 'string') return target;
  if (target instanceof URL) return target.pathname;
  if (Buffer.isBuffer(target)) return target.toString('utf8');
  return '';
};

/** Czy ten argument wskazuje na prawdziwe poświadczenie użytkownika. */
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
      'Testy nie zapisuja tego pliku w zadnym celu — takze identyczna trescia. ' +
      'Jesli kontrola ma pokazac, ze zapis jest wykrywany, wskaz ja na katalog tymczasowy ' +
      '(CLAUDE_CONFIG_DIR = mkdtempSync(...)).',
  );
};

/*
 * Tylko zapisujące. `readFileSync`, `statSync` i `existsSync` zostają nietknięte —
 * odczyt prawdziwego poświadczenia jest właśnie tym, czego wymagają skany wycieku
 * i kontrola odcisku.
 */
type Writer = 'writeFileSync' | 'appendFileSync' | 'unlinkSync' | 'truncateSync' | 'rmSync' | 'copyFileSync';
const WRITERS: Writer[] = [
  'writeFileSync',
  'appendFileSync',
  'unlinkSync',
  'truncateSync',
  'rmSync',
  'copyFileSync',
];

for (const name of WRITERS) {
  const original = fs[name] as (...args: unknown[]) => unknown;
  if (typeof original !== 'function') continue;
  (fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    // `copyFileSync(src, dest)` — chroniony jest CEL, nie źródło: kopiowanie
    // poświadczenia do katalogu tymczasowego jest dozwolone i używane.
    const target = name === 'copyFileSync' ? args[1] : args[0];
    if (isUserCredential(target)) refuse(name);
    return original(...args);
  };
}

/* `open` z flagą zapisu to ta sama droga, tylko dłuższa. */
const originalOpenSync = fs.openSync;
fs.openSync = ((path: unknown, flags: unknown, ...rest: unknown[]) => {
  const writing = typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number';
  if (writing && isUserCredential(path)) refuse('openSync');
  return (originalOpenSync as unknown as (...a: unknown[]) => unknown)(path, flags, ...rest);
}) as typeof fs.openSync;

export { REAL_CREDENTIAL_FILE };
