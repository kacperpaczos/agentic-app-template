import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_KINDS,
  codeVersion,
  environment,
  evidenceWritingRequested,
  resolvedPackages,
  sdkCliVersion,
  writeEvidence,
  writeMeasurementRecord,
  type ExecutionKind,
} from './support/measurement-evidence.ts';

/**
 * L1.12 and L12.10 — a result that cannot say what produced it is not evidence.
 *
 * Test kontraktu lub logiki, in two parts.
 *
 * **The envelope.** Every proof this repository writes now carries the commit,
 * whether the tree was clean, the environment and the kind of execution. The
 * kind is required by the *type*, so it cannot be omitted; the rest is added by
 * the writer, so it cannot be forgotten. Two versions matter and used to be one:
 * the SDK package (`0.3.x`) and the CLI **inside** it (`2.1.x`) — a run
 * executes the second, and the `claude` on PATH can be a third, different one.
 *
 * **The register.** 44 proofs were committed before the envelope existed. Their
 * environments were never recorded and inventing them would be worse than
 * admitting it, so each is listed in `docs/evidence/POCHODZENIE.json` with the
 * commit that introduced it, its producer and its kind — and with what is not
 * known about it. The list is closed by this test: a new file without an
 * envelope fails unless somebody adds an entry, which is a reviewable act.
 */

const REPO = resolve(import.meta.dirname, '..');
const EVIDENCE_ROOT = resolve(REPO, 'docs/evidence');
const REGISTER = resolve(EVIDENCE_ROOT, 'POCHODZENIE.json');

/** Keys under which a file may carry its code version; all spellings in use. */
const VERSION_KEYS = ['wersjaKodu', '_wersjaKodu', 'kodCommit', 'commit', 'wersje'];
const KIND_KEYS = ['rodzajWykonania', 'rodzajDowodu'];

interface RegisterEntry {
  plik: string;
  commitDodania: string;
  rodzajWykonania: ExecutionKind | null;
  wytworca: string;
  pochodzenie: string;
  czegoBrakujeWPliku: string[];
  uwaga?: string;
}

function evidenceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) out.push(...evidenceFiles(path));
    else if (name.endsWith('.json') && path !== REGISTER) out.push(path);
  }
  return out;
}

const has = (o: Record<string, unknown>, keys: string[]): boolean => keys.some((k) => k in o);

describe('koperta dowodowa', () => {
  it('rodzaj wykonania jest wymagany i nazwany slownikiem repozytorium', () => {
    const record = writeEvidence(
      'niepisany.json',
      { rodzajWykonania: 'test kontraktu lub logiki', co: 'przyklad' },
      'docs/evidence/z13-bl12',
    );
    const body = JSON.parse(record.body) as Record<string, unknown>;
    expect(EXECUTION_KINDS).toContain(body.rodzajWykonania);
    // G18: the assertions run on every regression, the write does not.
    expect(record.written).toBe(evidenceWritingRequested());
    expect(record.written).toBe(false);
  });

  it('kazdy zapis niesie commit, stan drzewa, srodowisko i wersje pakietow', () => {
    const record = writeMeasurementRecord(
      'niepisany-pomiar.json',
      {
        opis: 'przyklad',
        zrodlo: 'tests/evidence-provenance.test.ts',
        rodzajWykonania: 'symulacja',
        pomiary: { x: { co: 'a', od: 'b', do: 'c', warunki: 'd', probkiMs: [1, null] } },
      },
      'docs/evidence/z13-bl12',
    );
    const body = JSON.parse(record.body) as {
      wersjaKodu: { commit: string; brudneDrzewo: boolean | null; node: string };
      srodowisko: ReturnType<typeof environment>;
      rodzajWykonania: string;
    };
    expect(body.wersjaKodu.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(typeof body.wersjaKodu.brudneDrzewo).toBe('boolean');
    expect(body.srodowisko.system).toMatch(/linux|darwin|win32/);
    expect(body.srodowisko.node).toBe(process.versions.node);
    expect(body.rodzajWykonania).toBe('symulacja');
    // A measurement whose metric is missing stays missing (never a zero).
    expect(record.body).toContain('"brakMetryki": 1');
  });

  it('wersje sa rozwiazane, a nie przepisane z zakresu w package.json', () => {
    const packages = resolvedPackages();
    for (const name of ['react', 'typescript', '@anthropic-ai/claude-agent-sdk', '@openuidev/react-ui']) {
      expect(packages[name], `${name} nierozwiazany`).toMatch(/^\d+\.\d+\.\d+/);
    }
    // Pinned exactly in the manifests, so resolution must agree with them.
    const web = JSON.parse(readFileSync(resolve(REPO, 'apps/web/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(packages.react).toBe(web.dependencies.react);
    expect(packages['@openuidev/react-ui']).toBe(web.dependencies['@openuidev/react-ui']);
  });

  it('CLI wbudowane w SDK jest zapisane osobno od wersji pakietu SDK', () => {
    /*
     * The point of L1.12's second half. The SDK package is `0.3.x`; the CLI it
     * ships and executes is `2.1.x`, with its own commit and build date; and
     * the `claude` on PATH is yet another version. A record naming only one of
     * them does not say which agent produced the result.
     */
    const cli = sdkCliVersion();
    expect(cli, 'nie odczytano manifestu CLI z SDK').not.toBeNull();
    expect(cli!.wersja).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli!.commit).toMatch(/^[0-9a-f]{7,40}$/);
    const env = environment();
    expect(env.cliWSdk?.wersja).toBe(cli!.wersja);
    expect(env.pakiety['@anthropic-ai/claude-agent-sdk']).not.toBe(cli!.wersja);
  });

  it('koperta nie zawiera sciezek lokalnych ani nazwy uzytkownika', () => {
    // Evidence is published with the repository; local paths and secrets are
    // an acceptance condition, not a matter of taste.
    const serialised = JSON.stringify(environment());
    expect(serialised).not.toContain(REPO);
    expect(serialised).not.toContain(process.env.HOME ?? '/home');
  });
});

describe('rejestr pochodzenia dowodow', () => {
  const register = JSON.parse(readFileSync(REGISTER, 'utf8')) as { wpisy: RegisterEntry[] };
  const listed = new Map(register.wpisy.map((e) => [e.plik, e]));
  const files = evidenceFiles(EVIDENCE_ROOT).sort();

  it('kazdy dowod niesie wersje i rodzaj albo ma wpis w rejestrze', () => {
    const missing: string[] = [];
    for (const path of files) {
      const rel = relative(REPO, path);
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        missing.push(`${rel} — nieparsowalny JSON`);
        continue;
      }
      const object = (body ?? {}) as Record<string, unknown>;
      const complete =
        typeof body === 'object' && !Array.isArray(body) && has(object, VERSION_KEYS) && has(object, KIND_KEYS);
      if (!complete && !listed.has(rel)) {
        missing.push(`${rel} — brak wersji lub rodzaju wykonania i brak wpisu w POCHODZENIE.json`);
      }
    }
    expect(missing, `dowody bez pochodzenia:\n${missing.join('\n')}`).toEqual([]);
  });

  it('rejestr nie zostaje po pliku, ktory juz niesie koperte, ani po skasowanym', () => {
    const stale: string[] = [];
    for (const entry of register.wpisy) {
      const path = resolve(REPO, entry.plik);
      if (!existsSync(path)) {
        stale.push(`${entry.plik} — wpis wskazuje nieistniejacy plik`);
        continue;
      }
      const object = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (has(object, VERSION_KEYS) && has(object, KIND_KEYS)) {
        stale.push(`${entry.plik} — plik niesie juz koperte, wpis jest zbedny`);
      }
    }
    expect(stale, `rejestr do posprzatania:\n${stale.join('\n')}`).toEqual([]);
  });

  it('kazdy wpis mowi, skad pochodzi i czego o nim nie wiadomo', () => {
    for (const entry of register.wpisy) {
      expect(entry.commitDodania, entry.plik).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.wytworca, entry.plik).not.toBe('');
      expect(entry.pochodzenie, entry.plik).not.toBe('');
      expect(entry.czegoBrakujeWPliku.length, entry.plik).toBeGreaterThan(0);
      if (entry.rodzajWykonania === null) {
        // Only a file that is not a record of a run may leave it open, and it
        // has to say why in as many words.
        expect(entry.uwaga, `${entry.plik}: rodzaj null bez wyjasnienia`).toBeTruthy();
      } else {
        expect(EXECUTION_KINDS, entry.plik).toContain(entry.rodzajWykonania);
      }
    }
  });

  it('kontrola: plik dowodowy bez pochodzenia i bez wpisu bylby wykryty', () => {
    /*
     * The register's own detection trial. Without it, the first test above
     * would also pass on a scan that never looked at anything — an empty list
     * of problems is equally true of a check that found none and of a check
     * that ran on no files.
     */
    expect(files.length).toBeGreaterThan(40);
    const pretend = { opis: 'wynik bez pochodzenia' } as Record<string, unknown>;
    expect(has(pretend, VERSION_KEYS) && has(pretend, KIND_KEYS)).toBe(false);
    expect(listed.has('docs/evidence/zmyslony/bez-pochodzenia.json')).toBe(false);
  });

  it('nic nie zostalo zapisane przez ten plik testowy', () => {
    // The two writers above are called for their bytes, not for their files.
    expect(existsSync(resolve(REPO, 'docs/evidence/z13-bl12/niepisany.json'))).toBe(false);
    expect(existsSync(resolve(REPO, 'docs/evidence/z13-bl12/niepisany-pomiar.json'))).toBe(false);
    expect(codeVersion().commit).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
