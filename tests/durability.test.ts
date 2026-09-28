import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { createHarness, type Harness } from './helpers.ts';

/**
 * Dwie rzeczy, których pierwotny materiał dowodowy audytu w istocie nie
 * ustalał.
 *
 *  1. **Żadnych sekretów nigdzie.** Sprawdzenie dwóch odpowiedzi HTTP mówi tylko
 *     tyle, że te dwie odpowiedzi są czyste — nic o zbudowanym frontendzie,
 *     bundlu serwera, bazie danych ani diagnostyce. Wszystko to są skany tutaj.
 *  2. **Atomowość, nie tylko odtwarzalność.** Otwarcie skopiowanej bazy dowodzi,
 *     że kopia była spójna. Nie dowodzi, że zapis wieloetapowy przerwany w
 *     połowie nie zostawia po sobie niczego — a to właśnie ten przypadek
 *     produkuje niespójną bazę.
 *
 * Straż poświadczenia: skany sekretów mają sens tylko wtedy, gdy na tej maszynie
 * w ogóle istnieje token, którego można szukać. Bez niego test nie przechodzi
 * "cicho na zielono" — jest jawnie pomijany z powodem, żeby w raporcie widać
 * było różnicę między "nie badano" a "zbadano, czysto".
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.dispose());

/* -------------------------------------------------------------------------- */

const credentialsFile = resolve(homedir(), '.claude', '.credentials.json');

/** Prawdziwe wartości tokenów: czytane raz, nigdzie nie wypisywane ani nie zapisywane. */
function realSecrets(): string[] {
  if (!existsSync(credentialsFile)) return [];
  try {
    const oauth = (JSON.parse(readFileSync(credentialsFile, 'utf8')) as any)?.claudeAiOauth ?? {};
    return [oauth.accessToken, oauth.refreshToken].filter(
      (v): v is string => typeof v === 'string' && v.length > 12,
    );
  } catch {
    return [];
  }
}

function filesUnder(dir: string, limitBytes = 12 * 1024 * 1024): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (statSync(p).size <= limitBytes) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/*
 * `better-sqlite3` należy do `@platform/server`, więc jest rozwiązywany z
 * pakietu, który go posiada — i typowany strukturalnie, tak jak w
 * migration.test.ts. Wystarczy garstka członków używanych tutaj; `never[]`
 * w parametrach, by związek przeciążonych `Statement`-ów był przypisywalny.
 */
interface SqliteReadHandle {
  prepare: (sql: string) => {
    all: (...params: never[]) => unknown[];
    get: (...params: never[]) => unknown;
  };
  close: () => void;
}
type SqliteConstructor = new (file: string, options?: { readonly?: boolean }) => SqliteReadHandle;

/** Liczność wierszy i skrót SHA-256 treści per tabela — kształt *i* zawartość. */
function census(db: Pick<SqliteReadHandle, 'prepare'>) {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const counts: Record<string, number> = {};
  const digests: Record<string, string> = {};
  for (const t of tables) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>;
    digests[t] = createHash('sha256')
      .update(
        rows
          .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
          .sort()
          .join('\n'),
      )
      .digest('hex');
  }
  return { tables, counts, digests };
}

describe('sekrety nie wyciekaja poza proces SDK', () => {
  const secrets = realSecrets();

  /**
   * Wspólna straż wszystkich skanów: bez lokalnego poświadczenia kontrola nie ma
   * czego szukać, a ciche wyjście (`return`) wyglądałoby w raporcie identycznie
   * jak wynik "zbadano — czysto". To przeoczenie było sednem uwagi audytu:
   * test "przechodził", choć niczego nie sprawdzał.
   */
  const wymagajPoswiadczenia = (t: TestContext): void => {
    if (secrets.length === 0) {
      t.skip(`brak ${credentialsFile} — kontrola wycieku nie ma czego szukac`);
    }
  };

  it('poswiadczenie jest czytelne, inaczej ponizsze skany niczego nie sprawdzaja', (t) => {
    wymagajPoswiadczenia(t);
    /*
     * Realna asercja zamiast zawsze prawdziwej: plik poswiadczeń dał się
     * sparsować i dostarczył konkretne wartości, których szukamy we
     * frontendzie, backendzie, bazie i diagnostyce.
     */
    expect(secrets.length, 'poswiadczenie nie dostarczylo zadnego tokena do szukania').toBeGreaterThan(0);
    for (const s of secrets) {
      expect(s.length, 'token zbyt krotki, by skan mial sens').toBeGreaterThan(12);
    }
  });

  it('zbudowany frontend nie zawiera wartosci tokena', (t) => {
    wymagajPoswiadczenia(t);
    const files = filesUnder(resolve(process.cwd(), 'apps/web/dist'));
    expect(files.length, 'brak zbudowanego frontendu — uruchom pnpm build').toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('zbudowany backend nie zawiera wartosci tokena', (t) => {
    wymagajPoswiadczenia(t);
    const files = filesUnder(resolve(process.cwd(), 'apps/server/dist'));
    expect(files.length, 'brak zbudowanego backendu — uruchom pnpm build').toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('baza danych aplikacji nie zawiera wartosci tokena, takze w WAL', (t) => {
    wymagajPoswiadczenia(t);
    // Świadome zapisy przez platformę: skan ma patrzeć na to, co baza właśnie
    // zapisała, a nie na stan sprzed startu aplikacji.
    const conv = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      firstMessage: { content: 'polecenie' },
    });
    h.platform.services.conversations.upsertMessage(conv.id, h.ownerId, {
      id: 'am_x_1',
      role: 'assistant',
      content: 'odpowiedz',
      meta: { toolCalls: [] },
    });
    /*
     * journal_mode = WAL: ostatnie wpisy leżą w app.db-wal poza głównym plikiem
     * i trafiają do niego dopiero przy checkpoincie. Skan samego app.db jest
     * więc ślepy na to, co aplikacja zapisała przed chwilą — wstrzyknięty w
     * próbie zapis lądował wyłącznie w WAL (w głównym pliku go nie było), więc
     * token z ostatniej wiadomości wymknąłby się takiemu skanowi.
     */
    const mainFile = join(h.dataDir, 'app.db');
    const walFile = `${mainFile}-wal`;
    // Brak WAL-a oznaczałby, że skan obejmuje wyłącznie stary stan pliku.
    expect(existsSync(walFile), 'app.db-wal nie istnieje — baza nie działa w trybie WAL').toBe(true);
    for (const part of [mainFile, walFile]) {
      const blob = readFileSync(part, 'latin1');
      for (const s of secrets) expect(blob.includes(s), `token w ${part}`).toBe(false);
    }
  });

  it('diagnostyka uruchomieniowa nie wypisuje tokena', (t) => {
    wymagajPoswiadczenia(t);
    // `pnpm migrate` uruchamia platformę i wypisuje jej diagnostykę startową.
    const out = execFileSync('pnpm', ['migrate'], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: h.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const s of secrets) expect(out.includes(s)).toBe(false);
    expect(out).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
  });

  it('srodowisko przekazywane agentowi nie niesie zmiennych platnego dostepu', async () => {
    // Niezależne od lokalnego poświadczenia: bada czyste funkcje, nie pliki.
    const { subscriptionOnlyEnv } = await import('@platform/server');
    const clean = subscriptionOnlyEnv({
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-ant-SYNTETYCZNY',
    } as NodeJS.ProcessEnv);
    expect(JSON.stringify(clean)).not.toContain('sk-ant-SYNTETYCZNY');
  });
});

/* -------------------------------------------------------------------------- */

describe('przerwana operacja wieloetapowa nie zostawia polowicznego stanu', () => {
  it('nieudany zapis artefaktu nie tworzy ani wiersza artefaktu, ani jego wersji', () => {
    const before = h.platform.services.artifacts.list(h.ownerId).length;
    const countVersions = () =>
      (
        h.platform.db.$client
          .prepare('SELECT COUNT(*) AS n FROM artifact_versions')
          .get() as { n: number }
      ).n;
    const versionsBefore = countVersions();

    // Treść, której nie da się zserializować: błąd powstaje *między* dwoma
    // insertami, które tworzenie wykonuje.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      h.platform.services.artifacts.create({
        ownerId: h.ownerId,
        kind: 'report',
        mode: 'snapshot',
        title: 'Nie powinien powstac',
        rendererType: 'platform.file',
        content: circular,
      }),
    ).toThrow();

    expect(h.platform.services.artifacts.list(h.ownerId)).toHaveLength(before);
    expect(countVersions(), 'wersja zostala zapisana mimo przerwanej operacji').toBe(versionsBefore);
  });

  it('nieudana zmiana pozycji oferty nie zmienia ani wartosci, ani wersji', async () => {
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const detail = h.service.getCaseDetail(caseId, h.ownerId);
    const item = detail.offers
      .flatMap((o) => o.items)
      .find((i) => i.unitPriceMinor !== null && i.quantityMilli !== null)!;

    // Reguła domenowa odrzuca to w połowie operacji.
    await expect(
      h.service.updateOfferItem({ itemId: item.id, quantity: -5 }, h.ownerId),
    ).rejects.toThrow();

    const after = h.service
      .getCaseDetail(caseId, h.ownerId)
      .offers.flatMap((o) => o.items)
      .find((i) => i.id === item.id)!;
    expect(after.quantityMilli).toBe(item.quantityMilli);
    expect(after.unitPriceMinor).toBe(item.unitPriceMinor);
    // Nawet licznik optymistycznej współbieżności nie drgnął.
    expect(after.version).toBe(item.version);
  });

  it('konflikt wersji zostawia zapisany stan nietkniety', async () => {
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const item = h.service
      .getCaseDetail(caseId, h.ownerId)
      .offers.flatMap((o) => o.items)
      .find((i) => i.quantityMilli !== null)!;

    await expect(
      h.service.updateOfferItem(
        { itemId: item.id, quantity: 9, expectedVersion: item.version + 5 },
        h.ownerId,
      ),
    ).rejects.toThrow();

    const after = h.service
      .getCaseDetail(caseId, h.ownerId)
      .offers.flatMap((o) => o.items)
      .find((i) => i.id === item.id)!;
    expect(after.quantityMilli).toBe(item.quantityMilli);
    expect(after.version).toBe(item.version);
  });

  it('kopia bazy otwiera sie z tym samym stanem, ktory zglosil backend', async () => {
    const { createPlatform, DEFAULT_USER_ID } = await import('@platform/server');
    const { createProcurementModule, ProcurementService } = await import(
      '@module/procurement/server'
    );

    /*
     * Świeży, wielotabelowy stan: rozmowa z wiadomościami, artefakt; pliki i
     * sprawy pochodzą z zasianego modułu. Kopia powstaje z tego, a nie z pustej
     * bazy — inaczej porównanie byłoby pustką.
     */
    const conv = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Do odtworzenia',
      firstMessage: { content: 'przed kopia' },
    });
    h.platform.services.conversations.upsertMessage(conv.id, h.ownerId, {
      id: 'am_kopia_1',
      role: 'assistant',
      content: 'odpowiedz przed kopia',
      meta: { toolCalls: [] },
    });
    const artifact = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'report',
      mode: 'snapshot',
      title: 'Artefakt do odtworzenia',
      rendererType: 'platform.file',
      content: { wartosc: 41 },
    });

    /*
     * Checkpoint przed kopiowaniem (wzór: tests/runtime.test.ts) — w trybie WAL
     * ostatnie wpisy leżą w app.db-wal, więc kopia samego pliku głównego byłaby
     * niekompletna. Po TRUNCATE cały stan jest w app.db i katalog daje się
     * skopiować w spójnym punkcie.
     */
    h.platform.db.$client.pragma('wal_checkpoint(TRUNCATE)');

    // Stan źródła mierzony w tym samym momencie, w którym powstaje kopia.
    const przed = census(h.platform.db.$client);
    const rozmowyZrodla = h.platform.services.conversations.list(h.ownerId);
    const plikiZrodla = h.platform.services.files.list(h.ownerId);
    const sprawyZrodla = h.service.listCases(h.ownerId);

    const kopia = mkdtempSync(join(tmpdir(), 'agentic-kopia-'));
    try {
      cpSync(h.dataDir, kopia, { recursive: true });

      /* Census pliku kopii wobec pliku źródła: każda tabela, liczność i treść. */
      const otworzBaze = createRequire(
        resolve(import.meta.dirname, '../packages/platform-server/package.json'),
      )('better-sqlite3') as SqliteConstructor;
      const kopiaDb = new otworzBaze(join(kopia, 'app.db'), { readonly: true });
      let po: ReturnType<typeof census>;
      try {
        po = census(kopiaDb);
      } finally {
        kopiaDb.close();
      }
      expect(po.tables, 'kopia ma inny zestaw tabel niz zrodlo').toEqual(przed.tables);
      for (const tabela of przed.tables) {
        expect(po.counts[tabela], `licznosc tabeli ${tabela} w kopii`).toBe(przed.counts[tabela]);
        expect(po.digests[tabela], `tresc tabeli ${tabela} w kopii`).toBe(przed.digests[tabela]);
      }

      /* Otwarcie kopii świeżą instancją platformy, z modułem domenowym. */
      const odtworzona = createPlatform({
        modules: (services) => [createProcurementModule(services)],
        env: { ...process.env, APP_DATA_DIR: kopia },
      });
      try {
        // Straż niepustości: gdyby harness był pusty, porównania niczego by nie
        // dowodziły — dokładnie ta wada została wykryta w pierwotnej wersji.
        expect(rozmowyZrodla.length, 'harness bez rozmow — test niczego by nie sprawdzil').toBeGreaterThan(0);
        expect(plikiZrodla.length, 'harness bez plikow — test niczego by nie sprawdzil').toBeGreaterThan(0);
        expect(sprawyZrodla.length, 'harness bez spraw — test niczego by nie sprawdzil').toBeGreaterThan(0);

        const serwisKopii = new ProcurementService(odtworzona.services);
        expect(serwisKopii.listCases(DEFAULT_USER_ID).length).toBe(sprawyZrodla.length);
        expect(odtworzona.services.conversations.list(DEFAULT_USER_ID).length).toBe(
          rozmowyZrodla.length,
        );
        // Wiadomości porównane rozmowa po rozmowie: identyfikatory, role, treść.
        for (const c of rozmowyZrodla) {
          const uZrodla = h.platform.services.conversations
            .messages(c.id, h.ownerId)
            .map((m) => [m.id, m.role, m.content]);
          const uKopii = odtworzona.services.conversations
            .messages(c.id, DEFAULT_USER_ID)
            .map((m) => [m.id, m.role, m.content]);
          expect(uKopii, `wiadomosci rozmowy ${c.id} w kopii`).toEqual(uZrodla);
        }
        expect(odtworzona.services.artifacts.list(DEFAULT_USER_ID).length).toBe(
          h.platform.services.artifacts.list(h.ownerId).length,
        );
        // Treść artefaktu wraca w tej samej wersji, nie jako puste otarcie.
        expect(odtworzona.services.artifacts.version(artifact.meta.id, DEFAULT_USER_ID).content).toEqual({
          wartosc: 41,
        });
        // Pliki: te same identyfikatory i te same skróty treści.
        expect(odtworzona.services.files.list(DEFAULT_USER_ID).map((f) => [f.id, f.sha256])).toEqual(
          plikiZrodla.map((f) => [f.id, f.sha256]),
        );
      } finally {
        odtworzona.close();
      }
    } finally {
      rmSync(kopia, { recursive: true, force: true });
    }
  });
});
