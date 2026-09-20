import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Straż żywego katalogu dla skryptów powłokowych (ETAP 2, dziura 1) —
 * `scripts/lib/server-guard.mjs`, spięty w `scripts/dev-server.sh`,
 * `scripts/audit-server.sh` i `scripts/closure-server.sh`.
 *
 * **Dziura.** Straż w `packages/platform-server/src/config.ts` ogranicza tylko
 * instancje Z etykietą: bez etykiety wraca natychmiast, bo proces bez etykiety
 * to aplikacja użytkownika i ma prawo startować na swoich danych. Trzy skrypty
 * powyżej uruchamiają dokładnie taki proces bez etykiety i brały
 * `APP_DATA_DIR` na wiarę — wskazany na katalog z żywymi danymi, startowały na
 * nich. Ruling: naprawa w warstwie skryptowej, nie w `loadConfig`.
 *
 * Reguła: odmowa, gdy katalog zawiera wskaźnik żywych danych
 * (`session.secret` — istnienie pliku, nigdy jego treść), chyba że instancja
 * ma etykietę testową i katalog z prefiksem `.e2e`, albo że znacznik wskazuje
 * jej własny wcześniejszy start (poza domyślnym katalogiem `data/`
 * repozytorium, gdzie wyjątek nie obowiązuje). Fixture'y żywego katalogu są
 * WYŁĄCZNIE w katalogach tymczasowych i z FAŁSZYWYM sekretem.
 *
 * Oprócz zachowania pomocnika testowana jest także spinka: każdy z trzech
 * skryptów musi wywołać straż PRZED uruchomieniem serwera — straż, która
 * odpala po `setsid`, niczego nie chroni.
 */

const REPO = resolve(import.meta.dirname, '..');
const GUARD = resolve(REPO, 'scripts/lib/server-guard.mjs');

const katalogi: string[] = [];
const tmpKatalog = (prefix = 'agentic-guard-'): string => {
  const d = mkdtempSync(resolve(tmpdir(), prefix));
  katalogi.push(d);
  return d;
};

afterAll(() => {
  for (const d of katalogi.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** FAŁSZYWY sekret: żadne prawdziwe poświadczenie nie bierze udziału. */
const FAKE_SECRET = 'atrapa-session-secret-nie-jest-sekretem';

const żywyKatalog = (): string => {
  const d = tmpKatalog();
  writeFileSync(join(d, 'session.secret'), FAKE_SECRET);
  return d;
};

interface Wynik {
  status: number | null;
  stdout: string;
  stderr: string;
}

const przed = (
  katalog: string,
  opcje: { port?: string; etykieta?: string; repo?: string } = {},
): Wynik => {
  const args = [GUARD, 'przed', '--katalog', katalog];
  if (opcje.port) args.push('--port', opcje.port);
  if (opcje.etykieta) args.push('--etykieta', opcje.etykieta);
  if (opcje.repo) args.push('--repo', opcje.repo);
  const out = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
};

interface GuardModule {
  ZNACZNIK: string;
  czyNasz: (dir: string) => boolean;
  sekretPowyzej: (dir: string) => string | null;
  sekretWKataloguLubPonizej: (dir: string, depth?: number) => string | null;
  problemKatalogu: (
    dir: string,
    opcje?: { etykieta?: string | null; repo?: string },
  ) => string | null;
  zapiszZnacznik: (dir: string) => void;
}

const GUARD_LIB = resolve(REPO, 'scripts/lib/server-guard.mjs');
const lib = (await import(GUARD_LIB)) as unknown as GuardModule;

describe('straż żywego katalogu — odmowa', () => {
  it('żywy katalog z fałszywym session.secret jest odrzucony, a treść plików nie jest drukowana', () => {
    const d = żywyKatalog();
    const out = przed(d);

    expect(out.status, `stderr: ${out.stderr}`).toBe(2);
    expect(out.stderr).toContain('session.secret');
    expect(out.stderr).toContain('ODMAWIAM');
    // Komunikat podaje, CO wykryto (ścieżkę katalogu z sekretem)…
    expect(out.stderr).toContain(d);
    // …i nigdy treści plików.
    expect(out.stderr).not.toContain(FAKE_SECRET);
    expect(out.stdout).not.toContain(FAKE_SECRET);
  });

  it('katalog zawierający żywy katalog danych (sekrety niżej) jest odrzucony', () => {
    const rodzic = tmpKatalog();
    const wewnątrz = join(rodzic, 'czyjas-instancja', 'data');
    mkdirSync(wewnątrz, { recursive: true });
    writeFileSync(join(wewnątrz, 'session.secret'), FAKE_SECRET);

    const out = przed(rodzic);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(wewnątrz);
    expect(out.stderr).not.toContain(FAKE_SECRET);
  });

  it('katalog WEWNĄTRZ żywych danych jest odrzucony nawet z etykietą testową', () => {
    // Drugi kierunek tej samej reguły: instancja testowa bootująca w środku
    // cudzych danych, a potem kasująca swój katalog, zabiera cudze pliki.
    const żywe = żywyKatalog();
    const wewnątrz = join(żywe, '.e2e-wnętrze');
    mkdirSync(wewnątrz, { recursive: true });

    const out = przed(wewnątrz, { etykieta: 'agenticapp-test' });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('wnatrz katalogu danych aplikacji');
  });

  it('prefiks .e2e bez etykiety testowej nie przepuszcza', () => {
    const d = tmpKatalog('.e2e-prefiks-bez-etykiety-');
    writeFileSync(join(d, 'session.secret'), FAKE_SECRET);

    expect(przed(d).status).toBe(2);
  });

  it('etykieta testowa bez prefiksu .e2e nie przepuszcza', () => {
    const d = żywyKatalog();
    expect(przed(d, { etykieta: 'agenticapp-test' }).status).toBe(2);
  });

  it('kopiowany znacznik nic nie znaczy: cudza ścieżka w znaczniku nie przepuszcza', () => {
    // Lekcja state-tools: znacznik liczy się tylko dla zapisanej w nim ścieżki.
    const zrodlowy = tmpKatalog();
    lib.zapiszZnacznik(zrodlowy);

    const kopia = żywyKatalog();
    writeFileSync(join(kopia, lib.ZNACZNIK), readFileSync(join(zrodlowy, lib.ZNACZNIK), 'utf8'));

    expect(przed(kopia).status).toBe(2);
  });

  it('własny znacznik nie otwiera domyślnego katalogu data repozytorium', () => {
    // dev-server.sh celuje w <repo>/data; znacznik po dawnym starcie
    // weryfikacyjnym nie może utrzymać straż otwartą, gdy to stały się
    // prawdziwe dane użytkownika.
    const atrapaRepo = tmpKatalog();
    const data = join(atrapaRepo, 'data');
    mkdirSync(data, { recursive: true });
    lib.zapiszZnacznik(data);
    writeFileSync(join(data, 'session.secret'), FAKE_SECRET);

    const out = przed(data, { repo: atrapaRepo });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('domyslny katalog aplikacji');
    expect(out.stderr).toContain('pnpm start');
  });

  it('dowiązanie symboliczne jest odrzucone zanim cokolwiek zostanie uruchomione', () => {
    const cel = tmpKatalog();
    const link = join(tmpKatalog(), 'wskaznik');
    symlinkSync(cel, link);

    const out = przed(link);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('dowiazaniem symbolicznym');
  });

  it('użycie bez --katalog jest odmową, nie awarią', () => {
    const out = spawnSync(process.execPath, [GUARD, 'przed'], { encoding: 'utf8' });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('usage');
  });
});

describe('straż żywego katalogu — przepust', () => {
  it('nieistniejący katalog jest przepuszczony i dostaje znacznik', () => {
    const swiezy = join(tmpKatalog(), 'nowy-katalog');

    const out = przed(swiezy);
    expect(out.status, `stderr: ${out.stderr}`).toBe(0);
    expect(existsSync(join(swiezy, lib.ZNACZNIK))).toBe(true);
  });

  it('kontrola przeciwna: ten sam katalog bez strażnej zawartości przechodzi', () => {
    // Bez tej kontroli poprzednie testy przechodziłyby też na regule
    // odrzucającej wszystko.
    const pusty = tmpKatalog();
    writeFileSync(join(pusty, 'notatka.txt'), 'nie jest katalogiem danych');
    expect(przed(pusty).status).toBe(0);
  });

  it('etykieta testowa i prefiks .e2e przepuszczają własny sekret instancji testowej', () => {
    const d = tmpKatalog('.e2e-testowa-');
    writeFileSync(join(d, 'session.secret'), FAKE_SECRET);

    const out = przed(d, { etykieta: 'agenticapp-test' });
    expect(out.status, `stderr: ${out.stderr}`).toBe(0);
  });

  it('własny znacznik przepuszcza ponowny start na katalogu po własnym starcie', () => {
    // Pierwszy start: świeży katalog. Boot serwera pisze session.secret —
    // bez znacznika drugi start byłby odrzucony i udokumentowane polecenie
    // działałoby dokładnie raz.
    const d = join(tmpKatalog(), 'audyt');
    expect(przed(d).status).toBe(0);
    writeFileSync(join(d, 'session.secret'), FAKE_SECRET);
    expect(existsSync(join(d, 'session.secret'))).toBe(true);

    const out = przed(d);
    expect(out.status, `stderr: ${out.stderr}`).toBe(0);
    expect(lib.czyNasz(d)).toBe(true);
  });

  it('ten sam znacznik w katalogu poza domyślnym data repozytorium działa', () => {
    const atrapaRepo = tmpKatalog();
    const data = join(atrapaRepo, 'inne-dane');
    mkdirSync(data, { recursive: true });
    lib.zapiszZnacznik(data);
    writeFileSync(join(data, 'session.secret'), FAKE_SECRET);

    expect(przed(data, { repo: atrapaRepo }).status).toBe(0);
  });
});

describe('jednostkowo: kierunki wykrywania', () => {
  it('sekretPowyzej znajduje żywy katalog nad celem i pomija własne', () => {
    const żywe = żywyKatalog();
    const wewnątrz = join(żywe, 'files');
    mkdirSync(wewnątrz, { recursive: true });
    expect(lib.sekretPowyzej(wewnątrz)).toBe(żywe);

    // Własny katalog nad celem nie jest „żywym cudzym danym"…
    const nasz = join(tmpKatalog(), 'nasz');
    mkdirSync(nasz, { recursive: true });
    lib.zapiszZnacznik(nasz);
    writeFileSync(join(nasz, 'session.secret'), FAKE_SECRET);
    const podNaszym = join(nasz, 'files');
    mkdirSync(podNaszym, { recursive: true });
    expect(lib.sekretPowyzej(podNaszym)).toBeNull();
  });

  it('sekretWKataloguLubPonizej wykrywa sekret na wierzchu i w głąb, do limitu', () => {
    const d = tmpKatalog();
    expect(lib.sekretWKataloguLubPonizej(d)).toBeNull();

    // Dwa poziomy niżej — najdalszy kierunek, jaki ta straż uznaje
    // (ta sama granica głębokości co w state-tools).
    const gleboko = join(d, 'a', 'b');
    mkdirSync(gleboko, { recursive: true });
    writeFileSync(join(gleboko, 'session.secret'), FAKE_SECRET);
    expect(lib.sekretWKataloguLubPonizej(d)).toBe(gleboko);

    // Granica głębokości: sekret trzy poziomy niżej to nie jest już pytanie
    // tej straży — null, nie awaria.
    const pozaLimitem = tmpKatalog();
    const zaGlebokie = join(pozaLimitem, 'x1', 'x2', 'x3');
    mkdirSync(zaGlebokie, { recursive: true });
    writeFileSync(join(zaGlebokie, 'session.secret'), FAKE_SECRET);
    expect(lib.sekretWKataloguLubPonizej(pozaLimitem)).toBeNull();
  });

  it('problemKatalogu zwraca null albo komunikat — nigdy nie rzuca', () => {
    expect(lib.problemKatalogu(join(tmpKatalog(), 'nie-ma'))).toBeNull();
    expect(lib.problemKatalogu(żywyKatalog())).toMatch(/session.secret/);
  });
});

/* ------------------------- spinka: skrypty powłokowe ---------------------- */

describe('skrypty powłokowe są spięte ze strażą przed uruchomieniem serwera', () => {
  const SKRYPTY = ['dev-server.sh', 'audit-server.sh', 'closure-server.sh'];

  for (const skrypt of SKRYPTY) {
    it(`${skrypt}: straż odpala PRZED setsid, więc odmowa realnie niczego nie startuje`, () => {
      const tresc = readFileSync(resolve(REPO, 'scripts', skrypt), 'utf8');
      const straz = tresc.indexOf('server-guard.mjs przed');
      const start = tresc.indexOf('setsid node apps/server/dist/server.js');

      expect(straz, `${skrypt}: brak wywołania straży`).toBeGreaterThan(-1);
      expect(start, `${skrypt}: brak startu serwera`).toBeGreaterThan(-1);
      expect(straz, 'straż musi odpalać przed uruchomieniem serwera').toBeLessThan(start);
    });
  }

  it('PROBA ZDOLNOSCI WYKRYCIA: skrypt bez strażnej spinki jest wychwycony', () => {
    // Bez tej próby powyższy test przechodziłby też wtedy, gdy odmowa trafia
    // w plik, który nikt nie wykonuje.
    const atrapaSkrypt = join(tmpKatalog(), 'dev-server.sh');
    writeFileSync(
      atrapaSkrypt,
      '#!/usr/bin/env bash\nsetsid node apps/server/dist/server.js &\n',
    );
    const tresc = readFileSync(atrapaSkrypt, 'utf8');
    expect(tresc.indexOf('server-guard.mjs przed')).toBe(-1);
    expect(tresc.indexOf('setsid node apps/server/dist/server.js')).toBeGreaterThan(-1);
  });

  for (const skrypt of SKRYPTY) {
    it(`${skrypt}: sonda portu przed startem, a "started" dopiero po potwierdzeniu pid`, () => {
      const tresc = readFileSync(resolve(REPO, 'scripts', skrypt), 'utf8');
      const straz = tresc.indexOf('server-guard.mjs przed --katalog "$DATA" --port "$PORT"');
      const po = tresc.indexOf('server-guard.mjs po --pid');
      const zaczelo = tresc.indexOf('echo "started');

      expect(straz, `${skrypt}: sonda portu nie jest spięta ze strażą`).toBeGreaterThan(-1);
      expect(po, `${skrypt}: brak potwierdzenia własnego procesu`).toBeGreaterThan(-1);
      expect(zaczelo, `${skrypt}: brak komunikatu started`).toBeGreaterThan(-1);
      expect(po, 'potwierdzenie pid musi iść przed komunikatem "started"').toBeLessThan(zaczelo);
    });
  }

  it('dev-server.sh nie czeka na zdrowie pod stałym adresem 8791', () => {
    // Dziura 3: przy zajętych 8791 curl trafiał w cudzą instancję, a skrypt
    // zgłaszał "started" i zostawiał pidfile martwego procesu.
    const tresc = readFileSync(resolve(REPO, 'scripts', 'dev-server.sh'), 'utf8');
    expect(tresc).not.toContain('http://127.0.0.1:8791/api/health');
    expect(tresc).toContain('PORT="${DEV_PORT:-8791}"');
  });
});

/* ----------------------- sonda portu i potwierdzenie pid ------------------ */

const zajetePorty: { server: Server; port: number }[] = [];
const dzieci: ChildProcess[] = [];

const zajmijPort = (): Promise<number> =>
  new Promise((gotowe) => {
    const server = createServer(() => {});
    server.listen(0, '127.0.0.1', () => {
      const adres = server.address();
      if (typeof adres === 'string' || adres === null) throw new Error('brak portu');
      zajetePorty.push({ server, port: adres.port });
      gotowe(adres.port);
    });
  });

/** Wolny port: zajmowany i od razu zwalniany (mała, zwykła szara strefa). */
const wolnyPort = async (): Promise<number> => {
  const port = await zajmijPort();
  const wpis = zajetePorty.pop();
  if (wpis) await new Promise<void>((done) => wpis.server.close(() => done()));
  return port;
};

describe('sonda portu przed startem (dziura 3)', () => {
  afterAll(async () => {
    for (const { server } of zajetePorty.splice(0)) {
      await new Promise<void>((done) => server.close(() => done()));
    }
    for (const dziecko of dzieci.splice(0)) dziecko.kill('SIGKILL');
  });

  it('zajęty port jest odmową z pid właściciela, zanim cokolwiek wystartuje', async () => {
    const port = await zajmijPort();
    const out = przed(join(tmpKatalog(), 'swiezy'), { port: String(port) });

    expect(out.status, `stderr: ${out.stderr}`).toBe(2);
    expect(out.stderr).toContain(`port ${port}`);
    // Właścicielem nasłuchu jest ten proces testowy — straży udaje się go wskazać.
    expect(out.stderr).toContain(`pid ${process.pid}`);
    expect(out.stderr).toContain('Zatrzymaj TEN proces');
  });

  it('wolny port przepuszcza', async () => {
    const port = await wolnyPort();
    const out = przed(join(tmpKatalog(), 'swiezy'), { port: String(port) });
    expect(out.status, `stderr: ${out.stderr}`).toBe(0);
  });

  it('port niebędący numerem 1-65535 jest odmową', () => {
    const out = przed(join(tmpKatalog(), 'swiezy'), { port: 'zero' });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('nie jest numerem portu');
  });

  it('kontrola przeciwna: bez --port sonda portu nie działa (i nic nie psuje)', () => {
    // Bez tej kontroli test "zajęty port jest odmową" przechodziłby też na
    // straży, która odmawia zawsze.
    const out = przed(join(tmpKatalog(), 'swiezy'));
    expect(out.status).toBe(0);
  });
});

describe('potwierdzenie własnego procesu po starcie (dziura 3)', () => {
  const TOKEN = 'unikalny-token-serwera-proby';

  /**
   * „Serwer" proby: proces potomny tego testu, nasłuchujący na zadanym porcie.
   * Zatrzymywany wyłącznie po pid, wyłącznie proces, który ten test uruchomił.
   */
  const nasluchujaceDziecko = (port: number): Promise<number> =>
    new Promise((gotowe) => {
      const dziecko = spawn(
        process.execPath,
        [
          '-e',
          `const net=require('node:net');` +
            `net.createServer(()=>{}).listen(${port},'127.0.0.1',()=>console.log('GOTOWE'));` +
            `setInterval(()=>{},1000); // ${TOKEN}`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      dzieci.push(dziecko);
      dziecko.stdout.on('data', (b: Buffer) => {
        if (b.toString().includes('GOTOWE')) gotowe(dziecko.pid!);
      });
    });

  const po = (pid: number, port: number, cmd = TOKEN): Wynik => {
    const out = spawnSync(process.execPath, [GUARD, 'po', '--pid', String(pid), '--port', String(port), '--cmd', cmd], {
      encoding: 'utf8',
    });
    return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };

  it('odpowiada własny proces: potwierdzenie przechodzi', async () => {
    const port = await wolnyPort();
    const pid = await nasluchujaceDziecko(port);

    const out = po(pid, port);
    expect(out.status, `stderr: ${out.stderr}`).toBe(0);
    expect(out.stdout).toContain(`proces ${pid}`);
  }, 20_000);

  it('port trzyma ktoś inny niż pid z pidfile: odmowa zamiast fałszywego "started"', async () => {
    const port = await wolnyPort();
    await nasluchujaceDziecko(port);
    // „Pidfile" wskazuje ten proces testowy — on portu nie trzyma.
    // Fragment 'node' przechodzi przez kontrolę programu, żeby doszło do pytania
    // o właściciela portu — o to jest ten przypadek.
    const out = po(process.pid, port, 'node');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('trzyma proces');
    expect(out.stderr).toContain('cudza instancja');
  }, 20_000);

  it('pid z pidfile nie żyje: odmowa', async () => {
    const port = await wolnyPort();
    const out = po(2_147_000_000, port);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('nie zyje');
  }, 20_000);

  it('właściwy pid, ale inny program: odmowa', async () => {
    const port = await wolnyPort();
    const pid = await nasluchujaceDziecko(port);
    const out = po(pid, port, 'calkiem-inny-program.js');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('nie uruchamia');
  }, 20_000);

  it('brak właściciela portu w /proc jest odmową, nie ciszą', async () => {
    const port = await wolnyPort();
    const out = po(process.pid, port);
    expect(out.status).toBe(2);
  }, 20_000);
});
