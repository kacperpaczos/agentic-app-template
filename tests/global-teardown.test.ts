import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { usunKatalogiInstancjiTestowych, default as globalTeardown } from '../e2e/global-teardown.ts';
import { credentialFile, fingerprintCredential } from '../e2e/credential-guard.ts';

/**
 * Porządki po katalogach instancji testowych (ETAP 2, dziura 5) —
 * `e2e/global-teardown.ts`.
 *
 * **Dziura.** `globalTeardown` porównywał odcisk poświadczenia i kończył się
 * na tym: katalogi `.e2e*` kumulowały się w repozytorium (~30 sztuk), a
 * warunek odbioru mówi wprost „repozytorium bez śmieci".
 *
 * Reguła: usuwanie dopiero PO pomyślnym `checkCredentialFingerprint` — przy
 * niezgodności katalogi zostają jako dowód naruszenia. Samo usuwanie jest
 * wąskie jak straż, która je poprzedza: tylko katalogi o nazwie `.e2e*` w
 * korzeniu repozytorium, nigdy pliki i nigdy dowiązania, i tylko gdy żaden
 * proces ich nie trzyma (ta sama odpowiedź co w `port-probe.ts`; `null` —
 * nie da się zapytać — też zostawia katalog, bo porządki nie są okazją do
 * kasowania na ślepo).
 *
 * **Prefiks nie wystarcza (fix final review I-1).** Warunkiem jest KSZTAŁT
 * danych instancji — `app.db` albo `session.secret` bezpośrednio w katalogu,
 * bo obie rzeczy zawsze zostawia boot instancji. Bez tego porządki skasowałyby
 * `.e2e-model-turns/`, jedyny rejestr wydanego budżetu tur, i kolejny przebieg
 * modelowy zaczął liczyć od zera — ciche obejście sufitu subskrypcji. Katalog
 * bez cech instancji zostaje z powodem; lista wyjątków nie jest potrzebna,
 * bo nowy nieinstancyjny katalog jest z natury bezpieczny.
 *
 * Zawsze na atrapach w katalogach tymczasowych — prawdziwe logowanie nie
 * bierze udziału (G21).
 */

const katalogi: string[] = [];
const tmpKatalog = (prefiks = 'agentic-teardown-'): string => {
  const d = mkdtempSync(resolve(tmpdir(), prefiks));
  katalogi.push(d);
  return d;
};

afterAll(() => {
  for (const d of katalogi.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('usunKatalogiInstancjiTestowych — co odchodzi (kształt danych instancji)', () => {
  it('usuwa katalogi .e2e* z app.db lub session.secret, zostawia wszystko inne', () => {
    const repo = tmpKatalog();
    const zBaza = resolve(repo, '.e2e-z-baza');
    const zSekretem = resolve(repo, '.e2e-z-sekretem');
    mkdirSync(zBaza, { recursive: true });
    mkdirSync(zSekretem, { recursive: true });
    writeFileSync(resolve(zBaza, 'app.db'), 'atrapa-bazy-testowej');
    writeFileSync(resolve(zSekretem, 'session.secret'), 'atrapa-sekret-instancji');

    const inne = resolve(repo, 'data-inna');
    mkdirSync(inne, { recursive: true });
    writeFileSync(resolve(repo, '.e2e.lock'), 'to jest PLIK, nie katalog');
    // Dowiązanie wskazuje na katalog, który przeżyje sprzątanie, żeby test
    // mówił o samym dowiązaniu, a nie o wiszącym celu.
    const link = resolve(repo, '.e2e-dowiazanie');
    symlinkSync(inne, link);

    const wynik = usunKatalogiInstancjiTestowych(repo);

    expect([...wynik.usuniete].sort()).toEqual([zBaza, zSekretem].sort());
    expect(existsSync(zBaza)).toBe(false);
    expect(existsSync(zSekretem)).toBe(false);
    // Nic poza zakresem: katalog bez prefiksu, PLIK .e2e*, dowiązanie .e2e*.
    expect(existsSync(inne)).toBe(true);
    expect(existsSync(resolve(repo, '.e2e.lock'))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it('PROBA ZDOLNOSCI WYKRYCIA: regula, ktora kasuje wszystko, tez by tu przeszla', () => {
    // Bez tej próby powyższy test przechodziłby też na funkcji, która usuwa
    // wszystko albo nic — dlatego kontrola „co NIE odchodzi" jest osobnym
    // asercją wyżej, a ta próba dokumentuje, na czym pole działanie.
    const repo = tmpKatalog();
    const obcy = resolve(repo, 'nie-e2e-wazne-dane');
    mkdirSync(obcy, { recursive: true });
    writeFileSync(resolve(obcy, 'plik.txt'), 'nie jest katalogiem testowym');
    expect(usunKatalogiInstancjiTestowych(repo).usuniete).toEqual([]);
    expect(existsSync(obcy)).toBe(true);
  });
});

describe('usunKatalogiInstancjiTestowych — prefiks to za malo (fix final review I-1)', () => {
  it('.e2e-model-turns z rejestrem budzetu tur PRZEZYWA porzadki, z powodem', () => {
    const repo = tmpKatalog();
    const rejestr = resolve(repo, '.e2e-model-turns');
    mkdirSync(rejestr, { recursive: true });
    // Atrapy rejestru tur: sam JSON, żadnych cech danych instancji.
    writeFileSync(resolve(rejestr, 'bl01-bl02.json'), JSON.stringify({ wydane: 3, sufit: 11 }));
    writeFileSync(resolve(rejestr, 'z11-bl03.json'), JSON.stringify({ wydane: 21, sufit: 25 }));

    const wynik = usunKatalogiInstancjiTestowych(repo);

    expect(wynik.usuniete).toEqual([]);
    expect(wynik.zostawione).toHaveLength(1);
    expect(wynik.zostawione[0]!.katalog).toBe(rejestr);
    // POWÓD: nie kształt danych instancji, więc porządki go nie dotykają.
    expect(wynik.zostawione[0]!.powod).toMatch(/nie nosi cech danych instancji/);
    // Rejestr nietknięty — sufit subskrypcji zachowany.
    expect(existsSync(resolve(rejestr, 'z11-bl03.json'))).toBe(true);
    expect(readFileSync(resolve(rejestr, 'z11-bl03.json'), 'utf8')).toContain('21');
  });

  it('katalog .e2e-* tylko z JSON-em (bez app.db i session.secret) NIE jest kasowany', () => {
    const repo = tmpKatalog();
    const notatki = resolve(repo, '.e2e-notatki');
    mkdirSync(notatki, { recursive: true });
    writeFileSync(resolve(notatki, 'wykres.json'), '{}');

    const wynik = usunKatalogiInstancjiTestowych(repo);

    expect(wynik.usuniete).toEqual([]);
    expect(wynik.zostawione[0]!.powod).toMatch(/nie nosi cech danych instancji/);
    expect(existsSync(notatki)).toBe(true);
  });

  it('kontrola przeciwna: dokladnie te same dane z app.db odchodza', () => {
    // Bez tej kontroli warunek kształtu mógłby być stałą „nic nie kasuj".
    const repo = tmpKatalog();
    const rejestr = resolve(repo, '.e2e-model-turns-instancja');
    mkdirSync(rejestr, { recursive: true });
    writeFileSync(resolve(rejestr, 'bl01-bl02.json'), '{}');
    writeFileSync(resolve(rejestr, 'app.db'), 'atrapa-bazy');

    const wynik = usunKatalogiInstancjiTestowych(repo);

    expect(wynik.usuniete).toEqual([rejestr]);
    expect(existsSync(rejestr)).toBe(false);
  });

  it('PROBA ZDOLNOSCI WYKRYCIA: regula liczonalo z samego prefiksu kasowalaby rejestr tur', () => {
    // Rekonstrukcja defektu z recenzji: funkcja, która kasuje każdy katalog
    // .e2e* bez pytania o kształt, usuwa .e2e-model-turns — i o to chodzi, że
    // warunek kształtu MUSI różnić się od reguły prefiksowej w tym właśnie
    // przypadku.
    const repo = tmpKatalog();
    const rejestr = resolve(repo, '.e2e-model-turns');
    mkdirSync(rejestr, { recursive: true });
    writeFileSync(resolve(rejestr, 'z11-bl03.json'), '{}');

    const regulaPrefiksowa = existsSync(rejestr) && rejestr.includes('.e2e');
    expect(regulaPrefiksowa, 'próba traci sens, gdyby rejestr nie nosił prefiksu').toBe(true);
    expect(usunKatalogiInstancjiTestowych(repo).usuniete).toEqual([]);
    expect(existsSync(rejestr)).toBe(true);
  });
});

describe('usunKatalogiInstancjiTestowych — co zostaje', () => {
  it.skipIf(!existsSync('/proc'))(
    'katalog otwarty przez zywy proces zostaje z powodem, plik w srodku takze',
    () => {
      const repo = tmpKatalog();
      const trzymany = resolve(repo, '.e2e-trzymany');
      mkdirSync(trzymany, { recursive: true });
      const plik = resolve(trzymany, 'app.db');
      writeFileSync(plik, 'otwarty-deskryptor');

      const fd = openSync(plik, 'r');
      try {
        const wynik = usunKatalogiInstancjiTestowych(repo);
        expect(wynik.usuniete).toEqual([]);
        expect(wynik.zostawione).toHaveLength(1);
        expect(wynik.zostawione[0]!.katalog).toBe(trzymany);
        expect(wynik.zostawione[0]!.powod).toMatch(/otwarty przez dzialajacy proces/);
        expect(existsSync(plik)).toBe(true);
      } finally {
        closeSync(fd);
      }

      // Kontrola przeciwna: po zamknięciu deskryptora ten sam katalog odchodzi.
      const wynik2 = usunKatalogiInstancjiTestowych(repo);
      expect(wynik2.usuniete).toEqual([trzymany]);
      expect(existsSync(trzymany)).toBe(false);
    },
  );
});

describe('kolejnosc w globalTeardown: najpierw odcisk, potem porzadki (dziura 5)', () => {
  const atrapaZPoswiadczeniem = (): string => {
    const dir = tmpKatalog('atrapa-config-teardown-');
    writeFileSync(resolve(dir, '.credentials.json'), 'ATRAPA-zadne-poswiadczenie');
    return dir;
  };

  const zapiszOdcisk = (transferDir: string): void => {
    writeFileSync(
      resolve(transferDir, 'credential-fingerprint.json'),
      JSON.stringify({ plik: credentialFile(), odcisk: fingerprintCredential() }),
    );
  };

  it('zgodny odcisk: porzadki ida i katalog testowy znika', async () => {
    const configDir = atrapaZPoswiadczeniem();
    const repo = tmpKatalog();
    const transferDir = tmpKatalog();
    mkdirSync(resolve(repo, '.e2e-porzadki'), { recursive: true });
    // Katalog musi nosić cechy danych instancji — porządki kasują instancje, nie prefiksy.
    writeFileSync(resolve(repo, '.e2e-porzadki', 'app.db'), 'atrapa-bazy');

    // Odcisk zapisywany JUŻ na atrapie: prawdziwe poświadczenie w ogóle nie
    // bierze udziału w próbie.
    const realDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      zapiszOdcisk(transferDir);
      await expect(globalTeardown({ transferDir, repoRoot: repo })).resolves.toBeUndefined();
    } finally {
      if (realDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = realDir;
    }

    expect(existsSync(resolve(repo, '.e2e-porzadki'))).toBe(false);
  });

  it('PROBA ZDOLNOSCI WYKRYCIA: niezgodny odcisk konczy bledem i porzadki NIE ida', async () => {
    const configDir = atrapaZPoswiadczeniem();
    const repo = tmpKatalog();
    const transferDir = tmpKatalog();
    const katalogTestowy = resolve(repo, '.e2e-dowod-naruszenia');
    mkdirSync(katalogTestowy, { recursive: true });
    writeFileSync(resolve(katalogTestowy, 'app.db'), 'dowod');

    // Dotknięcie pliku poświadczenia po zapisaniu odcisku: ta sama treść,
    // nowy mtime — to już naruszenie (G21 bez wyjątku). Cała próba na atrapie.
    const realDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      zapiszOdcisk(transferDir);
      const st = JSON.parse(readFileSync(resolve(transferDir, 'credential-fingerprint.json'), 'utf8')) as {
        odcisk: string;
      };
      expect(st.odcisk).not.toBe('brak');
      const { utimesSync, statSync } = await import('node:fs');
      const atrybuty = statSync(resolve(configDir, '.credentials.json'));
      utimesSync(resolve(configDir, '.credentials.json'), atrybuty.atime, new Date(atrybuty.mtimeMs + 5000));

      await expect(globalTeardown({ transferDir, repoRoot: repo })).rejects.toThrow(/ZMIENIL SIE/);
      // Dowód naruszenia zostaje — nikt go nie sprzątnął.
      expect(existsSync(katalogTestowy)).toBe(true);
      expect(existsSync(resolve(katalogTestowy, 'app.db'))).toBe(true);
    } finally {
      if (realDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = realDir;
    }
  });
});
