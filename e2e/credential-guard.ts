import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/**
 * Bezpiecznik odcisku pliku poświadczeń dla przebiegów **Playwright** — brat
 * `tests/setup-credential-guard.ts` z regresji vitest.
 *
 * ## Dlaczego osobny plik, a nie reuse tamtego
 *
 * Tamten jest wpięty w `setupFiles` vitesta i działa w procesie workera —
 * odcisk „przed" i „po" bierze w tej samej pamięci. Playwright to trzy różne
 * procesy: `globalSetup`, workery, `globalTeardown`. Odcisk trzeba więc
 * **przenieść między procesami** — i tu rozstrzygnięcie, zamrożone testem w
 * `tests/credential-guard.test.ts` (część czysta) oraz próbą na prawdziwym
 * przebiegu (część procesowa): przenosimy go **plikiem** w `test-results/`
 * (gitignorowanym), a nie `process.env` — bo środowisko workera bywa
 * modyfikowane per-projekt, a plik przetrwa też nietypowe tryby uruchomienia.
 *
 * ## Lekcja z vitestowej wersji (obowiązuje tu bez zmian)
 *
 * To jest **WYKRYWANIE, nie zapobieganie**. Pierwsza wersja vitestowego
 * bezpiecznika podmieniała funkcje `node:fs` i nie działała (import nazwany
 * wiąże się przy linkowaniu modułu); wykrywanie odciskiem wyłapuje **każde**
 * źródło zapisu — też proces potomny i CLI. Reguła G21 jest bezwzględna:
 * nic w tym repozytorium nie zapisuje pliku poświadczenia użytkownika, w
 * żadnym celu, także identyczną treścią.
 *
 * Ścieżka poświadczenia jest ustalana **z chwili wywołania** i honoruje
 * `CLAUDE_CONFIG_DIR` — próba zdolności wykrycia korzysta z tego, kierując
 * cały przebieg (setup, workery, teardown) na atrapę w katalogu tymczasowym.
 */

/** Prawdziwy (dla tego przebiegu) plik poświadczenia. */
export function credentialFile(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'), '.credentials.json');
}

/** Rozmiar i czas modyfikacji; `brak`, gdy pliku nie ma. Ani jedno nie jest sekretem. */
export function fingerprintCredential(): string {
  try {
    const st = statSync(credentialFile());
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'brak';
  }
}

/** Plik przenoszący odcisk z `globalSetup` do `globalTeardown` (gitignorowany). */
export function transferPath(): string {
  return resolve(process.cwd(), 'test-results', 'credential-fingerprint.json');
}

export function saveCredentialFingerprint(transferDir?: string): void {
  const odcisk = fingerprintCredential();
  const file = resolve(transferDir ?? transferPath(), 'credential-fingerprint.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ plik: credentialFile(), odcisk }));
}

/** Porównuje i **głośno** wskazuje naruszenie, nazywając przebieg e2e sprawcą. */
export function checkCredentialFingerprint(transferDir?: string): void {
  let before: { plik: string; odcisk: string };
  try {
    before = JSON.parse(readFileSync(resolve(transferDir ?? transferPath(), 'credential-fingerprint.json'), 'utf8'));
  } catch {
    throw new Error(
      '[bezpiecznik e2e] brak zapisanego odcisku poswiadczenia — globalSetup nie przeszedl ' +
        'przez ten punkt? Nie mozna potwierdzic, ze przebieg e2e nie naruszyl logowania.',
    );
  }
  const after = fingerprintCredential();
  if (after !== before.odcisk) {
    throw new Error(
      `[bezpiecznik e2e] plik poswiadczen uzytkownika (${before.plik}) ZMIENIL SIE w trakcie ` +
        `tego przebiegu e2e (odcisk przed: ${before.odcisk}, po: ${after}). Testy e2e nie zapisuja ` +
        'tego pliku w zadnym celu — takze identyczna trescia, bo zapis i tak obcina i przepisuje ' +
        'plik. Jesli proba ma pokazac, ze zapis jest wykrywany, wskaz ja na katalog tymczasowy ' +
        '(CLAUDE_CONFIG_DIR = mkdtempSync(...)).',
    );
  }
}
