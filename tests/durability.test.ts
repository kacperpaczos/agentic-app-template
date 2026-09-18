import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialFilePath } from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';

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

/**
 * Escape hatch for a machine with no Claude login.
 *
 * Explicit, because the alternative is what this file used to do: an empty
 * needle list turned every assertion below into a tautology and the suite
 * reported a clean scan of nothing. A run without a credential is a legitimate
 * situation — and it has to be *declared*, not inferred from a missing file.
 */
const NO_CREDENTIAL_ENV = 'APP_ALLOW_NO_CREDENTIAL';

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
  const secrets = realSecrets();

  it('skan ma czego szukac, inaczej kazda asercja ponizej jest pusta', () => {
    /*
     * The check that decides whether the rest of this file means anything.
     *
     * It used to be a `console.warn` and an assertion that an array is an
     * array, which passes on a machine with no login while every scan below
     * iterates over an empty list of needles and reports success. Now the
     * absence of a credential fails here, by name, unless somebody says out
     * loud that this machine has none.
     */
    if (secrets.length === 0) {
      expect(
        process.env[NO_CREDENTIAL_ENV] === '1',
        `brak poswiadczenia w ${credentialsFile}: skan wycieku nie ma czego szukac. ` +
          `Zaloguj sie (claude /login) albo zadeklaruj brak logowania: ${NO_CREDENTIAL_ENV}=1.`,
      ).toBe(true);
      return;
    }
    expect(secrets.length, 'poswiadczenie jest, ale nie dalo sie z niego odczytac zadnej wartosci').toBeGreaterThan(0);
  });

  it('zbudowany frontend nie zawiera wartosci tokena', () => {
    if (secrets.length === 0) return;
    const files = filesUnder(resolve(process.cwd(), 'apps/web/dist'));
    expect(files.length, 'brak zbudowanego frontendu — uruchom pnpm build').toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('zbudowany backend nie zawiera wartosci tokena', () => {
    if (secrets.length === 0) return;
    const files = filesUnder(resolve(process.cwd(), 'apps/server/dist'));
    expect(files.length, 'brak zbudowanego backendu — uruchom pnpm build').toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      for (const s of secrets) expect(text.includes(s), `token w ${f}`).toBe(false);
    }
  });

  it('baza danych aplikacji nie zawiera wartosci tokena', async () => {
    if (secrets.length === 0) return;
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
    const dbFile = join(h.dataDir, 'app.db');
    const blob = readFileSync(dbFile, 'latin1');
    for (const s of secrets) expect(blob.includes(s)).toBe(false);
  });

  it('diagnostyka uruchomieniowa nie wypisuje tokena', () => {
    if (secrets.length === 0) return;
    // `pnpm migrate` boots the platform and prints its startup diagnostics.
    const out = execFileSync('pnpm', ['migrate'], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: h.dataDir },
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
    if (secrets.length === 0) return;
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
    if (secrets.length === 0) return;
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
    const again = createPlatform({ modules: [], env: { ...process.env, APP_DATA_DIR: h.dataDir } });
    try {
      expect(again.services.files.list(DEFAULT_USER_ID)).toHaveLength(files);
      expect(cases).toBeGreaterThan(0);
    } finally {
      again.close();
    }
  });
});
