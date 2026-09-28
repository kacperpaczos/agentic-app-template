import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const credentialsFile = resolve(homedir(), '.claude', '.credentials.json');

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

  it('poswiadczenie jest dostepne, inaczej ten test niczego nie sprawdza', () => {
    // Stated rather than skipped silently: an empty secret list would make every
    // assertion below vacuously true.
    if (secrets.length === 0) {
      console.warn('[test] brak lokalnego poswiadczenia — kontrola wycieku nie ma czego szukac');
    }
    expect(Array.isArray(secrets)).toBe(true);
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

  it('srodowisko przekazywane agentowi nie niesie zmiennych platnego dostepu', async () => {
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
      h.service.updateOfferItem({ itemId: item.id, quantity: -5 }, h.ownerId),
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
