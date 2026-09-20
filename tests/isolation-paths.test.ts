import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestInstanceIsIsolated, loadConfig } from '@platform/server';
import { assertInsideManagedRoot } from '../packages/platform-server/src/util/managed-fs.ts';
import { isWithin, realResolve, realResolveFrom } from '../packages/platform-server/src/util/real-path.ts';
import { assertTestDataDir, TEST_INSTANCE_LABEL, TestIsolationError } from '../e2e/support/isolation.ts';

/**
 * L1.11 — a path guard has to answer a question about the filesystem.
 *
 * Test kontraktu lub logiki, on real symbolic links in a real temporary
 * directory. Nothing here is mocked: `symlinkSync` makes the link, the guard is
 * given the same string the harness would give it, and the assertion is that it
 * refuses.
 *
 * **What was wrong.** Every isolation check compared paths as text. A directory
 * named `.e2e-data` that was a link to the user's `data/` satisfied all three
 * conditions — inside the repository, named `.e2e*`, not literally `data` — and
 * the labelled test instance then opened the user's database and the harness
 * deleted the link on its way out. `path.resolve` cannot see a link; only the
 * filesystem can be asked.
 *
 * **Why three layers are tested and not one.** The same comparison decides three
 * different things in three places, and the programme has already learned that
 * fixing the two sites in front of you leaves the third: the harness
 * (`assertTestDataDir`), the server refusing to boot (`assertTestInstanceIsIsolated`)
 * and the server's own destructive operations (`assertInsideManagedRoot`). Each
 * gets its own link here, and each control case is next to it — a guard that
 * refuses a legitimate directory is not a stricter guard, it is a broken one.
 */

const made: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(resolve(tmpdir(), 'agentic-link-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in repository: a real `data/` and a `.e2e-*` link pointing into it. */
function repoWithLink(linkName = '.e2e-podszywacz'): { repo: string; data: string; link: string } {
  const repo = tmp();
  const data = resolve(repo, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(resolve(data, 'app.db'), 'nie-baza');
  const link = resolve(repo, linkName);
  symlinkSync(data, link, 'dir');
  return { repo, data, link };
}

describe('katalog testowy, ktory jest dowiazaniem', () => {
  it('assertTestDataDir odrzuca .e2e-* wskazujace katalog danych aplikacji', () => {
    const { repo, link, data } = repoWithLink();
    expect(() => assertTestDataDir(link, repo, 'katalog danych testow')).toThrow(TestIsolationError);
    expect(() => assertTestDataDir(link, repo, 'katalog danych testow')).toThrow(/dowiazaniem symbolicznym/);
    // The file the user's directory holds is still there: nothing was deleted.
    expect(existsSync(resolve(data, 'app.db'))).toBe(true);
  });

  it('assertTestDataDir odrzuca dowiazanie wychodzace poza repozytorium', () => {
    const repo = tmp();
    const outside = tmp();
    mkdirSync(resolve(outside, 'cudze'), { recursive: true });
    const link = resolve(repo, '.e2e-na-zewnatrz');
    symlinkSync(resolve(outside, 'cudze'), link, 'dir');
    expect(() => assertTestDataDir(link, repo, 'katalog danych testow')).toThrow(/dowiazaniem symbolicznym/);
  });

  it('assertTestDataDir odrzuca katalog pod dowiazanym rodzicem', () => {
    /*
     * The leaf is an ordinary directory here and `lstat` on it says nothing —
     * the link is one level up. Only resolving the ancestors catches it, which
     * is the half a check on the final component alone would miss.
     */
    const repo = tmp();
    const outside = tmp();
    mkdirSync(resolve(outside, '.e2e-cudze'), { recursive: true });
    symlinkSync(outside, resolve(repo, 'podkatalog'), 'dir');
    expect(() => assertTestDataDir(resolve(repo, 'podkatalog/.e2e-cudze'), repo, 'katalog')).toThrow(
      /lezy poza katalogiem repozytorium/,
    );
  });

  it('dowiazanie do innego katalogu testowego tez jest odrzucone', () => {
    /*
     * Przypadek, w ktorym decyduje WYLACZNIE kontrola dowiazania: cel jest
     * prawdziwym katalogiem testowym w repozytorium, wiec wszystkie kontrole
     * sciezki — zawieranie, prefiks nazwy, roznica od katalogu danych — przepusza
     * go w obie strony. Zostaje jedno pytanie: czy to jest dowiazanie. Harness
     * kasuje ten katalog, a to, czy `rm` pojdzie za linkiem czy zdejmie sam link,
     * nie jest wlasnoscia, na ktorej wolno opierac bezpieczenstwo.
     */
    const repo = tmp();
    const real = resolve(repo, '.e2e-prawdziwy-cel');
    mkdirSync(real, { recursive: true });
    const link = resolve(repo, '.e2e-dowiazanie');
    symlinkSync(real, link, 'dir');
    expect(() => assertTestDataDir(link, repo, 'katalog danych testow')).toThrow(/dowiazaniem symbolicznym/);
    // Serwer odmawia startu z tego samego powodu i tylko z tego.
    expect(() =>
      assertTestInstanceIsIsolated(
        {
          dataDir: link,
          dbFile: '',
          filesDir: '',
          workspacesDir: '',
          port: 8799,
          allowedOrigins: [],
          webDistDir: null,
          model: 'm',
          runTimeoutMs: 1,
          consentTimeoutMs: 1,
          maxUploadBytes: 1,
          instanceLabel: TEST_INSTANCE_LABEL,
          instanceRunId: null,
        } as Parameters<typeof assertTestInstanceIsIsolated>[0],
        resolve(repo, 'data'),
      ),
    ).toThrow(/dowiazaniem symbolicznym/);
  });

  it('kontrola: prawdziwy katalog .e2e-* w repozytorium przechodzi', () => {
    // Without this the tests above would also pass on a guard that refuses
    // everything, which is not a guard but a broken harness.
    const repo = tmp();
    const dir = resolve(repo, '.e2e-prawdziwy');
    mkdirSync(dir, { recursive: true });
    expect(assertTestDataDir(dir, repo, 'katalog danych testow')).toBe(dir);
    // A directory that does not exist yet is the normal case and stays legal.
    expect(assertTestDataDir(resolve(repo, '.e2e-jeszcze-nie'), repo, 'katalog')).toBe(
      resolve(repo, '.e2e-jeszcze-nie'),
    );
  });
});

describe('serwer wobec dowiazanego katalogu danych', () => {
  const cfg = (dataDir: string) =>
    ({
      dataDir,
      dbFile: '',
      filesDir: '',
      workspacesDir: '',
      port: 8799,
      allowedOrigins: [],
      webDistDir: null,
      model: 'm',
      runTimeoutMs: 1,
      consentTimeoutMs: 1,
      maxUploadBytes: 1,
      instanceLabel: TEST_INSTANCE_LABEL,
      instanceRunId: null,
    }) as Parameters<typeof assertTestInstanceIsIsolated>[0];

  it('oznaczona instancja nie wstanie na .e2e-* bedacym dowiazaniem do danych', () => {
    const { repo, link } = repoWithLink();
    expect(() => assertTestInstanceIsIsolated(cfg(link), resolve(repo, 'data'))).toThrow(
      /dowiazaniem symbolicznym/,
    );
    expect(() => assertTestInstanceIsIsolated(cfg(link), resolve(repo, 'data'))).toThrow(
      /domyslny katalog aplikacji/,
    );
  });

  it('loadConfig odrzuca dowiazanie zanim cokolwiek utworzy albo otworzy', () => {
    const { repo, link, data } = repoWithLink();
    expect(() =>
      loadConfig({
        APP_INSTANCE_LABEL: TEST_INSTANCE_LABEL,
        APP_DATA_DIR: link,
        PORT: '8799',
      } as NodeJS.ProcessEnv),
    ).toThrow(/izolacja testow/);
    /*
     * `loadConfig` creates `files/` and `workspaces/` right after the guard, so
     * their absence in the link's target is the proof that it stopped first.
     */
    expect(existsSync(resolve(data, 'files'))).toBe(false);
    expect(existsSync(resolve(data, 'workspaces'))).toBe(false);
    expect(existsSync(resolve(repo, 'data/app.db'))).toBe(true);
  });

  it('kontrola: oznaczona instancja na prawdziwym .e2e-* startuje', () => {
    const repo = tmp();
    const dir = resolve(repo, '.e2e-ok');
    expect(() => assertTestInstanceIsIsolated(cfg(dir), resolve(repo, 'data'))).not.toThrow();
  });
});

describe('operacje kasujace serwera wobec dowiazania', () => {
  it('rename pod dowiazanym podkatalogiem magazynu jest odrzucony', () => {
    const root = tmp();
    const store = resolve(root, 'files');
    const elsewhere = resolve(root, 'gdzie-indziej');
    mkdirSync(store, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, resolve(store, 'wyjscie'), 'dir');

    // Textually inside the store; really outside it.
    const target = resolve(store, 'wyjscie/plik.bin');
    expect(() => assertInsideManagedRoot(target, { root: store, what: 'plikow' })).toThrow(
      /Rzeczywisty cel/,
    );
    // Control: an ordinary path inside the store is still allowed.
    expect(assertInsideManagedRoot(resolve(store, 'plik.bin'), { root: store, what: 'plikow' })).toBe(
      resolve(store, 'plik.bin'),
    );
  });

  it('magazyn pod dowiazanym rodzicem nie staje sie przez to zabroniony', () => {
    /*
     * The opposite failure: resolving only one side of the comparison turns a
     * perfectly ordinary installation — a data directory reached through a
     * linked parent, which is what a home directory on a separate volume looks
     * like — into a server that refuses its own files.
     */
    const real = tmp();
    const store = resolve(real, 'files');
    mkdirSync(store, { recursive: true });
    const linkedRoot = resolve(tmp(), 'dane');
    symlinkSync(real, linkedRoot, 'dir');
    const rootThroughLink = resolve(linkedRoot, 'files');
    expect(
      assertInsideManagedRoot(resolve(rootThroughLink, 'a.bin'), {
        root: rootThroughLink,
        what: 'plikow',
      }),
    ).toBe(resolve(rootThroughLink, 'a.bin'));
  });
});

/**
 * Kontrakt rzutu `UnresolvablePathError` (runda 7, punkt 5).
 *
 * Kto rzuca i kto co łapie — sprawdzone, nie opisane. Błędne przypisanie
 * którejś z czterech odpowiedzi sprawia, że odmowa staje się błędem
 * wewnętrznym (500), cichym przepuszczeniem albo zgubionym przepisaniem.
 */
describe('kontrakt UnresolvablePathError', () => {
  const nierozwiazywalna = (base: string): string => `${base}/nie-ma/../x`;

  it('walker rzuca wlasna klase z powodem i sciezka', async () => {
    const { UnresolvablePathError, realResolveFrom } = await import(
      '../packages/platform-server/src/util/real-path.ts'
    );
    const base = mkdtempSync(join(tmpdir(), 'kontrakt-'));
    try {
      try {
        realResolveFrom(base, 'nie-ma/../x');
        expect.unreachable('walker mial rzucic');
      } catch (err) {
        expect((err as Error).name).toBe('UnresolvablePathError');
        expect((err as Error).message).toContain('nie-ma');
        expect((err as Error).message).toContain('..');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('strażnik zwraca odmowę, nie rzuca — i napis jest jednolity', async () => {
    const { workspaceConfinementRefusal } = await import(
      '../packages/platform-server/src/agent/permissions.ts'
    );
    const base = mkdtempSync(join(tmpdir(), 'kontrakt-strażnik-'));
    try {
      const refusal = workspaceConfinementRefusal('Read', { file_path: 'nie-ma/../x' }, base);
      expect(refusal).toBeTruthy();
      expect(refusal).toBe(
        workspaceConfinementRefusal('Read', { file_path: 'inny-nie-ma/../y' }, base),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolveInWorkspace zamienia rzut na sandbox_denied', async () => {
    const { resolveInWorkspace } = await import('../packages/platform-server/src/agent/sandbox.ts');
    const base = mkdtempSync(join(tmpdir(), 'kontrakt-resolve-'));
    try {
      expect(() => resolveInWorkspace(base, 'nie-ma/../x')).toThrow(/sandbox_denied|Sciezka wychodzi/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolvedPathInput przy rzucie zwraca null (odmowa zapadnie u straznika)', async () => {
    const { resolvedPathInput } = await import(
      '../packages/platform-server/src/agent/permissions.ts'
    );
    const base = mkdtempSync(join(tmpdir(), 'kontrakt-input-'));
    try {
      const { UnresolvablePathError } = await import(
        '../packages/platform-server/src/util/real-path.ts'
      );
      expect(
        resolvedPathInput('Read', { file_path: 'nie-ma/../x' }, () => {
          throw new UnresolvablePathError('nie-ma/../x', '".." po komponencie, ktory nie istnieje');
        }),
      ).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('realResolve — jedna implementacja, dwa jezyki', () => {
  it('rozwiazuje istniejace i nieistniejace sciezki przez dowiazanie', () => {
    const { repo, link, data } = repoWithLink();
    expect(realResolve(link)).toBe(realResolve(data));
    expect(realResolve(resolve(link, 'jeszcze/nie/ma'))).toBe(resolve(realResolve(data), 'jeszcze/nie/ma'));
    expect(isWithin(realResolve(link), realResolve(repo))).toBe(true);
    expect(isWithin(realResolve(repo), realResolve(link))).toBe(false);
  });

  it('zgadza sie z kopia w scripts/lib/state-tools.mjs', async () => {
    /*
     * The scripts are plain `.mjs` run by node and cannot import the TypeScript
     * module, so they keep their own copy of the walk. Asserted equal here, on
     * the same inputs, so "one behaviour in two languages" is a checked claim
     * rather than a comment.
     */
    const scripts = (await import(resolve(import.meta.dirname, '../scripts/lib/state-tools.mjs'))) as {
      realResolve: (p: string) => string;
      isWithin: (a: string, b: string) => boolean;
    };
    const { repo, link, data } = repoWithLink();
    for (const path of [link, data, repo, resolve(link, 'a/b'), resolve(repo, 'nie-ma/tego')]) {
      expect(scripts.realResolve(path), path).toBe(realResolve(path));
    }
    expect(scripts.isWithin(realResolve(link), realResolve(repo))).toBe(
      isWithin(realResolve(link), realResolve(repo)),
    );
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Kolejność rozwiązywania: dowiązanie przed `..`.
 *
 * Wada, którą te testy atakują, przeżyła trzy recenzje przez czytanie i dwie
 * poprawki w sąsiednim module — bo każdy czytał **algorytm**, a nie jego wynik
 * na ścieżce z `..` za dowiązaniem. Stąd ten blok pyta o wynik i nic więcej.
 *
 * `path.resolve()` zwija `..` leksykalnie; jądro rozwiązuje w odwrotnej
 * kolejności. Dla `/a/link/../b`, gdzie `link` wskazuje poza drzewo, odpowiedź
 * leksykalna brzmi `/a/b`, a `open()` trafia gdzie indziej. Każdy strażnik w
 * tym repozytorium kończy się porównaniem ścieżek, więc zła odpowiedź jest
 * zgodą na operację w niewłaściwym miejscu.
 */
describe('realResolve: dowiazanie rozwiazywane przed ".."', () => {
  const shapes = () => {
    const base = mkdtempSync(join(tmpdir(), 'kolejnosc-'));
    const outside = mkdtempSync(join(tmpdir(), 'poza-'));
    mkdirSync(join(base, 'wnetrze'), { recursive: true });
    mkdirSync(join(outside, 'cel'), { recursive: true });
    symlinkSync(join(outside, 'cel'), join(base, 'wnetrze', 'link'));
    return { base, outside };
  };

  it('sciezka bezwzgledna z ".." za dowiazaniem wypada TAM, gdzie trafi jadro', () => {
    const { base, outside } = shapes();
    try {
      const surowa = `${base}/wnetrze/link/../ofiara`;
      // Leksykalnie: <base>/wnetrze/ofiara. Fizycznie: <outside>/ofiara.
      expect(realResolve(surowa)).toBe(join(outside, 'ofiara'));
      expect(realResolve(surowa)).not.toBe(join(base, 'wnetrze', 'ofiara'));
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('to samo dla sciezki wzglednej podanej przez realResolveFrom', () => {
    const { base, outside } = shapes();
    try {
      expect(realResolveFrom(base, 'wnetrze/link/../ofiara')).toBe(join(outside, 'ofiara'));
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('straznik widzi, ze cel lezy w katalogu danych, choc tekst mowi inaczej', () => {
    /*
     * Kształt istotny dla skryptów utrzymaniowych: ich flagi (`--out`, `--data`)
     * to napisy od użytkownika i mogą nieść `..`. Guard pyta „czy cel leży w
     * katalogu danych" — i pod starą odpowiedzią mówił „nie", gdy fizycznie
     * leżał.
     */
    const root = mkdtempSync(join(tmpdir(), 'straznik-'));
    try {
      mkdirSync(join(root, 'data', 'sub'), { recursive: true });
      mkdirSync(join(root, 'backups'), { recursive: true });
      symlinkSync(join(root, 'data', 'sub'), join(root, 'backups', 'link'));

      const zywe = realResolve(join(root, 'data'));
      const cel = realResolve(`${root}/backups/link/../x`);

      expect(cel).toBe(join(realResolve(join(root, 'data')), 'x'));
      expect(isWithin(cel, zywe), 'straznik nie widzi, ze cel jest w katalogu danych').toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kopia w scripts/lib/state-tools.mjs odpowiada tak samo na ten ksztalt', async () => {
    const scripts = (await import(resolve(import.meta.dirname, '../scripts/lib/state-tools.mjs'))) as {
      realResolve: (p: string) => string;
    };
    const { base, outside } = shapes();
    try {
      const surowa = `${base}/wnetrze/link/../ofiara`;
      expect(scripts.realResolve(surowa)).toBe(realResolve(surowa));
      expect(scripts.realResolve(surowa)).toBe(join(outside, 'ofiara'));
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /*
   * Z-DRIFT (runda 7): kształty rozbieżne — te, na których stary algorytm
   * składający leksykalnie dawał inną odpowiedź niż jądro. Przegląd rundy 6
   * wytknął, że test równoważności porównywał obie kopie wyłącznie na
   * ścieżkach, na których obie miały rację — drift między nimi był
   * niewidoczny. Oba mają teraz rzucać (kontrakt skryptowy: skrypt przerwany,
   * operacja niewykonana).
   */
  describe('ksztalty rozbiezne: oba jezyki odmawiaja, nie składaja leksykalnie', () => {
    const scriptsMod = async () =>
      (await import(resolve(import.meta.dirname, '../scripts/lib/state-tools.mjs'))) as {
        realResolve: (p: string) => string;
      };
    const pozaDirs: string[] = [];
    const poza = (name: string): string => {
      const dir = mkdtempSync(join(tmpdir(), name));
      pozaDirs.push(dir);
      return dir;
    };
    afterAll(() => {
      for (const d of pozaDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it('"nie-ma/../x" — leksykalnie wewnątrz, fizycznie poza: oba rzucają', async () => {
      const scripts = await scriptsMod();
      const base = poza('rozjazd-');
      symlinkSync(poza('rozjazd-cel-'), join(base, 'link'));
      const surowa = `${base}/nie-ma/../link/ofiara`;
      expect(() => realResolve(surowa)).toThrow();
      expect(() => scripts.realResolve(surowa)).toThrow();
    });

    it('zerwane dowiązanie + ".." — oba rzucają', async () => {
      const scripts = await scriptsMod();
      const base = poza('rozjazd-zrw-');
      /* `zerwane` wskazuje katalog, którego nie ma. */
      symlinkSync(join(base, 'nie-ma-mnie'), join(base, 'zerwane'));
      const surowa = `${base}/zerwane/../link/ofiara`;
      expect(() => realResolve(surowa)).toThrow();
      expect(() => scripts.realResolve(surowa)).toThrow();
    });

    it('łańcuch readlink: obie wersje wskazują ten sam cel poza drzewem', async () => {
      const scripts = await scriptsMod();
      const base = poza('rozjazd-lan-');
      const cel = poza('rozjazd-lan-cel-');
      symlinkSync(cel, join(base, 'l2'));
      symlinkSync(join(base, 'l2'), join(base, 'l1'));
      const surowa = `${base}/l1/../x.txt`;
      /*
       * Jądro: `l1` rozwiązuje się do `<cel>`, `..` wychodzi na jego rodzica,
       * więc `x.txt` ląduje obok — POZA katalogiem roboczym. Właściwość, o
       * którą chodzi, jest podwójna: obie implementacje zgodnie wskazują ten
       * sam plik i ten plik leży poza katalogiem bazowym.
       */
      const wynikTs = realResolve(surowa);
      const wynikMjs = scripts.realResolve(surowa);
      expect(wynikMjs).toBe(wynikTs);
      expect(isWithin(wynikTs, realResolve(base))).toBe(false);
    });
  });

  it('kontrakt zachowany: sciezka, ktorej jeszcze nie ma, i zwykla sciezka', () => {
    const { base, outside } = shapes();
    try {
      // Nieistniejący liść przez najbliższego istniejącego przodka — po to ta funkcja powstała.
      expect(realResolve(join(base, 'wnetrze', 'jeszcze', 'nie', 'ma'))).toBe(
        join(realResolve(join(base, 'wnetrze')), 'jeszcze/nie/ma'),
      );
      // Zwykła ścieżka bez dowiązań i bez `..` odpowiada jak dotąd.
      expect(realResolve(join(base, 'wnetrze'))).toBe(join(realResolve(base), 'wnetrze'));
      void outside;
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * Dlaczego zła odpowiedź walkera NIE była (i nie jest) przepustką dla strażników
 * izolacji — sprawdzone, nie założone.
 *
 * Pytanie z rundy 5 brzmiało: czy błędna odpowiedź `realResolve` mogła
 * przepuścić zapis poza katalog testowy albo pod instancję użytkownika. Dla
 * `assertTestDataDir` i `assertInsideManagedRoot` odpowiedź brzmi **nie**, i to
 * nie przez przypadek, tylko dzięki jednej własności: **ścieżka sprawdzana jest
 * tą samą ścieżką, która jest zwracana i używana**. `..` znika w `resolve()`
 * *przed* sprawdzeniem, więc jądro, kasując zwrócony napis, idzie tam, gdzie
 * patrzył strażnik.
 *
 * Ta własność jest tu zamrożona testem, bo jest cicha: gdyby któryś strażnik
 * zaczął zwracać napis surowy zamiast znormalizowanego, obie ścieżki znów by się
 * rozjechały — i to jest dokładnie ten kształt, który w narzędziach plikowych
 * agenta kosztował rundę 4.
 */
describe('straznicy izolacji: sprawdzana sciezka jest sciezka uzywana', () => {
  it('assertTestDataDir zwraca dokladnie to, co sprawdzil', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-norm-'));
    const outside = mkdtempSync(join(tmpdir(), 'poza-norm-'));
    try {
      mkdirSync(join(repo, '.e2e-data'), { recursive: true });
      symlinkSync(outside, join(repo, '.e2e-data', 'link'));

      /*
       * Nazwa katalogu musi zaczynać się od `.e2e` — strażnik sprawdza to
       * niezależnie, i dobrze. Tutaj chodzi o inną własność, więc nazwa jest
       * dobrana tak, żeby tamta reguła nie przesłoniła tej mierzonej.
       */
      const surowa = `${repo}/.e2e-data/link/../.e2e-ofiara`;
      const zwrocona = assertTestDataDir(surowa, repo, 'proba');

      // Zwrócony napis nie niesie już `..`, więc „gdzie sprawdzono" i „co zostanie
      // skasowane" to jedno miejsce — wewnątrz katalogu testowego.
      expect(zwrocona).toBe(join(repo, '.e2e-data', '.e2e-ofiara'));
      expect(zwrocona.includes('..'), 'zwrocona sciezka niesie ".." — check i use moga sie rozjechac').toBe(false);
      expect(isWithin(realResolve(zwrocona), realResolve(repo))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('assertInsideManagedRoot zwraca dokladnie to, co sprawdzil', () => {
    const root = mkdtempSync(join(tmpdir(), 'magazyn-'));
    const outside = mkdtempSync(join(tmpdir(), 'poza-magazyn-'));
    try {
      mkdirSync(join(root, 'wnetrze'), { recursive: true });
      symlinkSync(outside, join(root, 'wnetrze', 'link'));

      const zwrocona = assertInsideManagedRoot(`${root}/wnetrze/plik.bin`, { root, what: 'magazyn' });
      expect(zwrocona).toBe(join(root, 'wnetrze', 'plik.bin'));
      expect(zwrocona.includes('..')).toBe(false);

      // A ścieżka, która fizycznie wychodzi poza magazyn, jest odrzucona.
      expect(() =>
        assertInsideManagedRoot(join(root, 'wnetrze', 'link', 'plik.bin'), { root, what: 'magazyn' }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
