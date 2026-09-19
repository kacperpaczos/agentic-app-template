import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * L12.7 and L12.15 — the register of this template's own adapters, kept honest
 * by execution rather than by discipline.
 *
 * Test kontraktu lub logiki.
 *
 * Two things were wrong and both are the same shape. The complete register of
 * adapters existed only in an archived document describing a *different*
 * repository, so four adapters written since then appeared nowhere; and a
 * description, once written, had nothing keeping it in step with the code — the
 * Settings screen stated that the sandbox cuts off the network, which is a
 * claim about behaviour nothing in this repository has tried.
 *
 * So the register is parsed here, and:
 *
 *  - every file it names must exist, and every compatibility trial it cites
 *    must be a test file that exists;
 *  - **every file in `packages/platform-ui/src/chat/` must appear in it** — that
 *    directory exists precisely because the ready-made chat had to be adapted,
 *    so a new file there is a new adapter, and it cannot enter unregistered;
 *  - the version table must equal what the manifests pin, to the character;
 *  - every user-facing claim in the table must carry a proof or be marked as
 *    not proved — in the register's own words, not in a reviewer's memory.
 */

const REPO = resolve(import.meta.dirname, '..');
const REGISTER = resolve(REPO, 'docs/ADAPTERY.md');
const CHAT_DIR = resolve(REPO, 'packages/platform-ui/src/chat');

const text = readFileSync(REGISTER, 'utf8');

interface Entry {
  id: string;
  tytul: string;
  rodzaj: string;
  czegoBrakowalo: string;
  coDopisano: string;
  pliki: string[];
  proby: string[];
  ograniczenie: string;
  ponowneUzycie: string;
}

/** Fields of one entry, read from the fixed bullet shape. */
function field(body: string, name: string): string {
  const m = body.match(new RegExp(`^- \\*\\*${name}:?\\*\\*\\s*(.+)$`, 'm'));
  return m ? m[1]!.trim() : '';
}
const paths = (value: string): string[] => [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

const entries: Entry[] = [];
const sections = text.split(/^## (A-\d+) — (.+)$/m);
for (let i = 1; i < sections.length; i += 3) {
  const body = sections[i + 2]!.split(/^## /m)[0]!;
  entries.push({
    id: sections[i]!,
    tytul: sections[i + 1]!.trim(),
    rodzaj: field(body, 'Rodzaj'),
    czegoBrakowalo: field(body, 'Czego brakowało'),
    coDopisano: field(body, 'Co dopisano'),
    pliki: paths(field(body, 'Pliki')),
    proby: paths(field(body, 'Próba zgodności')),
    ograniczenie: field(body, 'Ograniczenie'),
    ponowneUzycie: field(body, 'Ponowne użycie'),
  });
}

describe('rejestr adapterow', () => {
  it('ma wpisy i kazdy z nich mowi wszystko, co rejestr obiecuje', () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
    for (const e of entries) {
      expect(e.rodzaj, e.id).toMatch(/^(adapter|konfiguracja|biblioteka)/);
      expect(e.czegoBrakowalo.length, `${e.id}: brak opisu, czego brakowalo`).toBeGreaterThan(40);
      expect(e.coDopisano.length, `${e.id}: brak opisu, co dopisano`).toBeGreaterThan(20);
      expect(e.pliki.length, `${e.id}: bez plikow`).toBeGreaterThan(0);
      expect(e.proby.length, `${e.id}: bez proby zgodnosci`).toBeGreaterThan(0);
      expect(e.ograniczenie.length, `${e.id}: bez ograniczenia`).toBeGreaterThan(10);
      expect(e.ponowneUzycie, e.id).toMatch(/tak|nie/);
    }
  });

  it('kazdy wymieniony plik i kazda proba zgodnosci istnieje', () => {
    const missing: string[] = [];
    for (const e of entries) {
      for (const p of [...e.pliki, ...e.proby]) {
        if (!existsSync(resolve(REPO, p))) missing.push(`${e.id}: brak ${p}`);
      }
      for (const p of e.proby) {
        if (!/^(tests|e2e)\//.test(p)) missing.push(`${e.id}: proba ${p} nie jest testem`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('kazdy plik adaptera czatu jest w rejestrze', () => {
    /*
     * The rule that keeps the register from going stale the way its predecessor
     * did. `packages/platform-ui/src/chat/` is the directory of adaptations to
     * the ready-made chat — a new file there is a new adapter by construction.
     */
    const registered = new Set(entries.flatMap((e) => e.pliki));
    const onDisk = readdirSync(CHAT_DIR)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => `packages/platform-ui/src/chat/${f}`);
    expect(onDisk.length).toBeGreaterThan(10);
    const unregistered = onDisk.filter((f) => !registered.has(f));
    expect(unregistered, `adaptery spoza rejestru:\n${unregistered.join('\n')}`).toEqual([]);
  });
});

describe('tabela wersji', () => {
  const rows = [...text.matchAll(/^\| (@?[a-z0-9@/-]+) \| (\d+\.\d+\.\d+) \| .+ \|$/gim)].map((m) => ({
    pakiet: m[1]!,
    wersja: m[2]!,
  }));

  it('zgadza sie co do znaku z tym, co przypinaja manifesty', () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
    const manifests = [
      'package.json',
      'apps/web/package.json',
      'apps/server/package.json',
      'packages/platform-ui/package.json',
      'packages/platform-server/package.json',
    ].map((f) => JSON.parse(readFileSync(resolve(REPO, f), 'utf8')) as Record<string, Record<string, string>>);

    const problems: string[] = [];
    for (const row of rows) {
      const pinned = new Set<string>();
      for (const m of manifests) {
        for (const field of ['dependencies', 'devDependencies']) {
          const v = m[field]?.[row.pakiet];
          if (v) pinned.add(v);
        }
      }
      if (pinned.size === 0) problems.push(`${row.pakiet}: w tabeli, ale zaden manifest go nie przypina`);
      else if (pinned.size > 1) problems.push(`${row.pakiet}: rozne wersje w manifestach (${[...pinned].join(', ')})`);
      else if (![...pinned][0]!.includes(row.wersja)) {
        problems.push(`${row.pakiet}: tabela mowi ${row.wersja}, manifest ${[...pinned][0]}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('deklaracje widoczne dla uzytkownika', () => {
  const rows = [...text.matchAll(/^\| ([^|]+) \| (README|Ustawienia)[^|]*\| ([^|]+) \| ([^|]+) \|$/gm)].map(
    (m) => ({ deklaracja: m[1]!.trim(), gdzie: m[2]!, dowod: m[3]!.trim(), stan: m[4]!.trim() }),
  );

  it('kazda deklaracja wskazuje istniejacy dowod i nazywa swoj stan', () => {
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      const proof = paths(row.dowod)[0];
      expect(proof, `${row.deklaracja}: bez dowodu`).toBeTruthy();
      expect(existsSync(resolve(REPO, proof!)), `${row.deklaracja}: brak pliku ${proof}`).toBe(true);
      expect(row.stan.length).toBeGreaterThan(5);
    }
  });

  it('deklaracja o odcieciu sieci jest zapisana jako niepotwierdzona proba', () => {
    /*
     * The specific claim L12.15 names. It is allowed to stay on screen — the
     * sandbox really is configured that way and a test asserts the
     * configuration — but the register has to say, in as many words, that no
     * attempt has been made from inside a run. If somebody later softens this
     * row without doing the trial, this fails.
     */
    const row = rows.find((r) => /sie[cć] i katalog danych odci/i.test(r.deklaracja));
    expect(row, 'brak wiersza o odcieciu sieci').toBeTruthy();
    expect(row!.stan).toMatch(/tylko konfiguracja/i);
    expect(row!.stan).toMatch(/L11\.3/);
  });

  it('ekran Ustawien mowi o konfiguracji, a nie o skutku', () => {
    // The screen a reader trusts first must not promise more than was proved.
    const settings = readFileSync(resolve(REPO, 'packages/platform-ui/src/shell/SettingsPage.tsx'), 'utf8');
    const sandboxText = settings.slice(settings.indexOf('<dt>Sandbox</dt>'), settings.indexOf("<dt>Sandbox</dt>") + 900);
    expect(sandboxText).toContain('konfiguracji sandboxa');
    expect(sandboxText).toMatch(/nie ma jeszcze proby|brak proby/);
  });
});
