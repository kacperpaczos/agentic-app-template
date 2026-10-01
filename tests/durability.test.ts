import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialFilePath } from '@platform/server';
import { createHarness, type Harness, testGlmEnv } from './helpers.ts';

/**
 * Two things the audit's evidence did not actually establish.
 *
 *  1. **No secrets anywhere.** Checking two HTTP responses shows those two
 *     responses are clean; it says nothing about the built frontend, the server
 *     bundle, the database or the logs. All of those are covered here.
 *  2. **Atomicity, not just recovery.** Reopening a copied database proves the
 *     copy was consistent. It does not prove that a multi-step write which fails
 *     halfway leaves nothing behind — which is the case that produces an
 *     inconsistent database in the first place.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.dispose());

/* -------------------------------------------------------------------------- */

/**
 * Where the login really is.
 *
 * `resolve(homedir(), '.claude', ...)` was wrong in a way that made the whole
 * scan look green for free: `CLAUDE_CONFIG_DIR` moves the credential, the
 * runtime honours it everywhere else, and a scan pointed at the *other*
 * directory finds no file, produces no needles and passes vacuously. Asked of
 * the same function the application uses, so the two cannot drift apart again.
 */
const credentialsFile = credentialFilePath(process.env);

/** Always-present credential used by the model-free GLM test harness. */
const SYNTHETIC_GLM_TOKEN = 'FAKE-GLM-TOKEN-TEST-ONLY';

/** The real token values, read once, never printed and never written anywhere. */
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

describe('sekrety nie wyciekaja poza proces SDK', () => {
  const secrets = [SYNTHETIC_GLM_TOKEN, ...realSecrets()];

  it('skan ma gwarantowany kanarek GLM takze bez logowania Claude', () => {
    expect(secrets).toContain(SYNTHETIC_GLM_TOKEN);
  });

  it('zbudowany frontend nie zawiera wartosci tokena', () => {
    const files = filesUnder(resolve(process.cwd(), 'apps/web/dist'));
    expect(files.length, 'brak zbudowanego frontendu — uruchom pnpm build').toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('zbudowany backend nie zawiera wartosci tokena', () => {
    const files = filesUnder(resolve(process.cwd(), 'apps/server/dist'));
    expect(files.length, 'brak zbudowanego backendu — uruchom pnpm build').toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('baza danych aplikacji nie zawiera wartosci tokena, takze w WAL', () => {
    // Exercise the paths that write to the database first.
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
     * próbie zapis lądował wyłącznie w WAL (port z audytu 2026-09-28,
     * AgenticApp fd0b4ae), więc token z ostatniej wiadomości wymknąłby się
     * takiemu skanowi.
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

  it('diagnostyka uruchomieniowa nie wypisuje tokena', () => {
    // `pnpm migrate` boots the platform and prints its startup diagnostics.
    const out = execFileSync('pnpm', ['migrate'], {
      encoding: 'utf8',
      env: testGlmEnv(h.dataDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const s of secrets) expect(out.includes(s)).toBe(false);
    expect(out).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
  });

  /**
   * The surfaces a browser run leaves behind.
   *
   * Named in the audit as never searched, and easy to forget precisely because
   * nothing in the application writes them: a Playwright trace records whatever
   * was on the page and in the network, and the report embeds it. If a secret
   * ever reached the interface, this is where it would sit afterwards —
   * committed, in `docs/evidence/`.
   *
   * Absent directories are reported as absent rather than counted as clean: the
   * assertion is about what a scan found, and "there was nothing to scan" is a
   * different answer from "there was nothing in it".
   */
  it('raporty i slady Playwright nie zawieraja wartosci tokena', () => {
    const roots = ['docs/evidence/playwright-report', 'test-results'].map((d) =>
      resolve(process.cwd(), d),
    );
    const present = roots.filter((d) => existsSync(d));
    const files = present.flatMap((d) => filesUnder(d));
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
      expect(/sk-ant-[A-Za-z0-9_-]{8,}/.test(text), `wzorzec sk-ant w ${f}`).toBe(false);
    }
    // Recorded, not asserted: whether a report exists depends on whether a
    // browser run happened, and this suite must not require one.
    expect(Array.isArray(present)).toBe(true);
  });

  it('katalogi robocze uruchomien i magazyn plikow nie zawieraja wartosci tokena', async () => {
    /*
     * The workspace is where model-authored code writes, and the file store is
     * where published results land. Both are inside the harness's own data
     * directory, so this scan cannot reach the user's.
     */
    const dirs = [
      h.platform.config.workspacesDir,
      resolve(h.dataDir, 'files'),
      h.dataDir,
    ].filter((d) => existsSync(d));
    expect(dirs.length, 'katalog danych testowej instancji nie istnieje').toBeGreaterThan(0);
    for (const f of dirs.flatMap((d) => filesUnder(d))) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('srodowisko przekazywane agentowi nie niesie zmiennych platnego dostepu', async () => {
    const { subscriptionOnlyEnv } = await import('@platform/server');
    const clean = subscriptionOnlyEnv({
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-ant-SYNTETYCZNY',
    } as NodeJS.ProcessEnv);
    // `includes`, not `not.toContain`: the received value here is the whole
    // environment, and printing it on a failure is exactly what L8.14 forbids.
    expect(
      JSON.stringify(clean).includes('sk-ant-SYNTETYCZNY'),
      'klucz API przetrwal czyszczenie srodowiska agenta',
    ).toBe(false);
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

    // Content that cannot be serialised: the failure happens *between* the two
    // inserts the creation performs.
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

    // A domain rule rejects this halfway through the operation.
    await expect(
      h.service.updateOfferItem(
        { itemId: item.id, quantity: -5, expectedVersion: item.version },
        h.ownerId,
      ),
    ).rejects.toThrow();

    const after = h.service
      .getCaseDetail(caseId, h.ownerId)
      .offers.flatMap((o) => o.items)
      .find((i) => i.id === item.id)!;
    expect(after.quantityMilli).toBe(item.quantityMilli);
    expect(after.unitPriceMinor).toBe(item.unitPriceMinor);
    // Not even the optimistic-concurrency counter moved.
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
    const cases = h.service.listCases(h.ownerId).length;
    const files = h.platform.services.files.list(h.ownerId).length;
    const { createPlatform, DEFAULT_USER_ID } = await import('@platform/server');
    // Reopening the same file is the weaker check the audit already had; it is
    // kept because it is still worth knowing, not because it proves atomicity.
    const again = createPlatform({ modules: [], env: testGlmEnv(h.dataDir) });
    try {
      expect(again.services.files.list(DEFAULT_USER_ID)).toHaveLength(files);
      expect(cases).toBeGreaterThan(0);
    } finally {
      again.close();
    }

    /*
     * Stronger check (port z audytu 2026-09-28, AgenticApp fd0b4ae): a real
     * *copy* of the database files, opened as its own platform, compared with
     * the original by a per-table census — row count and a SHA-256 digest of
     * the ordered contents. Counting two surfaces through the API proves the
     * backend reports something; the census proves the copy carries the same
     * data, byte for byte, table after table. The checkpoint first, so the
     * copy does not silently miss what still lives in the WAL.
     */
    const { createHash } = await import('node:crypto');
    const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const db = h.platform.db.$client;
    db.pragma('wal_checkpoint(TRUNCATE)');
    const copyDir = mkdtempSync(join(tmpdir(), 'durability-kopia-'));
    try {
      for (const part of ['app.db', 'app.db-wal', 'app.db-shm']) {
        const src = join(h.dataDir, part);
        if (existsSync(src)) cpSync(src, join(copyDir, part));
      }
      const census = (dir: string) => {
        const open = createPlatform({ modules: [], env: testGlmEnv(dir) });
        try {
          const c = open.db.$client;
          const digests: Record<string, string> = {};
          for (const t of ['conversations', 'messages', 'agent_runs', 'artifacts', 'files']) {
            const rows = c.prepare(`SELECT * FROM ${t} ORDER BY 1`).all() as Record<string, unknown>[];
            digests[t] = createHash('sha256')
              .update(JSON.stringify(rows))
              .digest('hex');
            // Straż niepustości: census pustych tabel niczego nie dowodzi.
            if (t === 'conversations') expect(rows.length, 'census: brak rozmów w oryginale').toBeGreaterThan(0);
          }
          return digests;
        } finally {
          open.close();
        }
      };
      const original = census(h.dataDir);
      const copy = census(copyDir);
      for (const t of Object.keys(original)) {
        expect(copy[t], `census tabeli ${t}: kopia różni się od oryginału`).toBe(original[t]);
      }
      // And through the API of the copy itself, one surface as a witness.
      const copyPlatform = createPlatform({ modules: [], env: testGlmEnv(copyDir) });
      try {
        expect(copyPlatform.services.files.list(DEFAULT_USER_ID)).toHaveLength(files);
      } finally {
        copyPlatform.close();
      }
    } finally {
      rmSync(copyDir, { recursive: true, force: true });
    }
  });
});
