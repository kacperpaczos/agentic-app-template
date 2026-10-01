import { testGlmEnv } from './helpers.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatform, DEFAULT_USER_ID, type PlatformInstance } from '@platform/server';
import { buildRegistry, NEUTRAL_MENU_SECTION_LABELS, platformCardRenderers, type UiModule } from '@platform/ui';
import { createProbeModule } from '@module/devkit-probe/server';
import { CODE_COMMIT_ENV, CODE_TREE_DIRTY_ENV, codeVersion } from './support/measurement-evidence.ts';

/**
 * Rejestracja modułu przez jawne kontrakty (L9.11) i niezależność platformy od
 * konkretnego modułu (L9.12).
 *
 * Test kontraktu lub logiki. Wszystko tu dzieje się na **module kontrolnym**,
 * nie na module przykładowym, i to jest sedno: moduł przykładowy powstawał
 * razem z platformą, więc może spełniać założenie, którego platforma nigdy nie
 * zapisała. Kontrakt, który sprawdza tylko on, jest kontraktem niesprawdzonym.
 *
 * Połówka przeglądarkowa modułu kontrolnego jest tu importowana dynamicznie,
 * po nazwie policzonej w czasie wykonania — tak samo jak w
 * `tests/openui-catalog-parity.test.ts` i z tego samego powodu: kopia robocza
 * `pnpm check:module-swap` typecheckuje repozytorium bez połówki UI, gdyby
 * kiedyś trzeba ją było usunąć.
 */

const repoRoot = resolve(import.meta.dirname, '..');

describe('modul rejestruje sie wylacznie przez zadeklarowane kontrakty', () => {
  const disposers: Array<() => void> = [];
  const boot = (modules: 'none' | 'probe') => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentic-module-contract-'));
    const platform = createPlatform({
      modules: modules === 'none' ? [] : (services) => [createProbeModule(services)],
      env: testGlmEnv(dataDir),
    });
    disposers.push(() => {
      platform.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return platform;
  };
  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  const loadUi = async (): Promise<UiModule> => {
    const spec = '@module/devkit-probe/ui';
    const { probeUiModule } = (await import(spec)) as { probeUiModule: UiModule };
    return probeUiModule;
  };

  it('polowka serwerowa: migracja, narzedzia, odczyt live, komponenty, nawigacja, trasy', async () => {
    const p: PlatformInstance = boot('probe');

    // schemat — migracja modułu zbudowała jego tabelę
    const tables = p.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='probe_notes'")
      .all();
    expect(tables).toHaveLength(1);

    // narzędzia — zarejestrowane pod przestrzenią nazw modułu
    expect(p.registry.tools.map((t) => t.qualifiedName)).toEqual(
      expect.arrayContaining(['probe_add_note', 'probe_list_notes']),
    );

    // odczyty live — nazwa, schemat wejścia i deskryptor wyniku
    const reads = p.registry.readOperations.map((r) => r.qualifiedName);
    expect(reads).toContain('probe.notes');
    const notesRead = p.registry.readOperations.find((r) => r.qualifiedName === 'probe.notes')!;
    expect(notesRead.definition.result?.collection).toBe('notes');
    expect(notesRead.definition.result?.fields.map((f) => f.field)).toEqual(['text', 'createdAt']);

    // komponenty — karta w katalogu serwera i komponent OpenUI modułu
    expect(p.services.catalog.has('probe.noteList')).toBe(true);
    expect(p.services.catalog.openui.names()).toContain('ProbeNoteList');

    // nawigacja — cel UI i ekran modułu jako kompozycja
    expect(p.services.modules.uiTargets().map((t) => t.id)).toContain('probe.notes');
    const views = p.services.modules.views();
    expect(views.map((v) => v.id)).toContain('probe.notes');
    expect(views.find((v) => v.id === 'probe.notes')!.composition).toContain('ProbeNoteList');

    // trasy — zamontowane pod prefiksem modułu, nie w platformie
    const cookie = await login(p);
    const res = await p.app.request('/api/m/probe/notes', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('odczyt live modulu przechodzi przez platforme z jego wlasnym deskryptorem', async () => {
    const p = boot('probe');
    const cookie = await login(p);

    const created = await p.app.request('/api/m/probe/notes', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'notatka kontraktowa' }),
    });
    expect(created.status).toBe(201);

    const read = await p.app.request('/api/read', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'probe.notes', input: {} }),
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      result: { notes: Array<{ text: string }> };
      descriptor: { collection: string; record: { route: string } };
    };
    expect(body.result.notes.map((n) => n.text)).toEqual(['notatka kontraktowa']);
    // Trasa rekordu też jest kontraktem modułu: platforma jej nie zna.
    expect(body.descriptor.collection).toBe('notes');
    expect(body.descriptor.record.route).toBe('/probe-notes/{id}');
  });

  it('polowka przegladarkowa: renderer karty, komponent OpenUI, menu i ekrany', async () => {
    const probeUiModule = await loadUi();
    const registry = buildRegistry({
      modules: [probeUiModule],
      platformCardRenderers,
      platformMenu: [{ id: 'platform.files', section: 'files', label: 'Pliki', to: '/files' }],
      platformScreenPaths: ['/', '/files'],
    });

    // renderer karty pod tym samym identyfikatorem, który deklaruje serwer
    expect(Object.keys(registry.cardRenderers)).toContain('probe.noteList');
    // komponent OpenUI w katalogu przeglądarki
    expect(Object.keys(registry.library.components)).toContain('ProbeNoteList');
    // nawigacja: pozycja menu i ekrany z trasami modułu
    expect(registry.menu.map((m) => m.to)).toContain('/probe-notes');
    expect(registry.screens.map((s) => s.path)).toEqual(['/probe-notes', '/probe-notes/$noteId']);
    for (const screen of registry.screens) expect(typeof screen.component).toBe('function');
  });

  it('katalog przegladarki i katalog serwera znaja ten sam komponent modulu', async () => {
    const p = boot('probe');
    const probeUiModule = await loadUi();
    const registry = buildRegistry({
      modules: [probeUiModule],
      platformCardRenderers,
      platformMenu: [],
    });
    const browserDefs = registry.library.toJSONSchema().$defs ?? {};
    expect(Object.keys(browserDefs)).toContain('ProbeNoteList');
    expect(p.services.catalog.openui.names()).toContain('ProbeNoteList');
    // Ta sama kolejność pozycyjna argumentów po obu stronach.
    expect(Object.keys(browserDefs['ProbeNoteList']!.properties ?? {})).toEqual(
      Object.keys(p.services.catalog.openui.schema.$defs!['ProbeNoteList']!.properties ?? {}),
    );
  });

  it('naglowki sekcji nawigacji pochodza od modulu, a nieponazwane sa neutralne', async () => {
    const probeUiModule = await loadUi();

    // Bez żadnego modułu powłoka nie ma własnego słowa na cudzy rekord.
    const empty = buildRegistry({ modules: [], platformCardRenderers, platformMenu: [] });
    expect(empty.menuSections).toEqual(NEUTRAL_MENU_SECTION_LABELS);
    expect(Object.values(empty.menuSections).join(' ')).not.toMatch(/sprawy|notatki/i);

    // Z modułem — jego słowo, nie słowo innego modułu.
    const withProbe = buildRegistry({ modules: [probeUiModule], platformCardRenderers, platformMenu: [] });
    expect(withProbe.menuSections.records).toBe('Notatki');
    // Sekcja, której moduł nie nazwał, zostaje neutralna.
    expect(withProbe.menuSections.files).toBe(NEUTRAL_MENU_SECTION_LABELS.files);

    // Dwa moduły nazywające tę samą sekcję inaczej: decyzja należy do warstwy
    // składania, nie do kolejności tablicy `modules`.
    const other: UiModule = {
      ...probeUiModule,
      meta: { ...probeUiModule.meta, id: 'other' },
      cardRenderers: {},
      openuiComponents: [],
      screens: [],
      menuSections: { records: 'Zgloszenia' },
    };
    expect(() =>
      buildRegistry({ modules: [probeUiModule, other], platformCardRenderers, platformMenu: [] }),
    ).toThrowError(/Konflikt nazw sekcji: "records"/);
  });

  it('ekran modulu nie moze przejac sciezki platformy ani sciezki innego modulu', async () => {
    const probeUiModule = await loadUi();
    expect(() =>
      buildRegistry({
        modules: [probeUiModule],
        platformCardRenderers,
        platformMenu: [],
        platformScreenPaths: ['/probe-notes'],
      }),
    ).toThrowError(/Konflikt ekranow: sciezka "\/probe-notes"/);

    const twin: UiModule = {
      ...probeUiModule,
      meta: { ...probeUiModule.meta, id: 'twin' },
      cardRenderers: {},
      openuiComponents: [],
    };
    expect(() =>
      buildRegistry({ modules: [probeUiModule, twin], platformCardRenderers, platformMenu: [] }),
    ).toThrowError(/Konflikt ekranow: ekran "probe\.notes"/);
  });

  it('kompozycja domyslna modulu jest walidowana katalogiem platformy', async () => {
    const p = boot('probe');
    const cookie = await login(p);
    /*
     * Zakres brany z manifestu, nie wpisany: `agenticApp.scopeKinds` jest tym,
     * z czego `pnpm check:module-swap` bierze i zakres modułu składanego, i
     * zakresy modułów nieobecnych, których nic nie ma wytworzyć. Deklaracja,
     * która rozjechałaby się z `defaultComposition`, oblewa tutaj — w regresji,
     * a nie dopiero w próbie wymiany.
     */
    const scopeKinds = (
      JSON.parse(readFileSync(join(repoRoot, 'packages/module-devkit-probe/package.json'), 'utf8')) as {
        agenticApp: { scopeKinds: string[] };
      }
    ).agenticApp.scopeKinds;
    expect(scopeKinds).toHaveLength(1);
    const res = await p.app.request('/api/canvas/spaces/for-scope', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: scopeKinds[0], id: 'k1', title: 'Kontrakt' }),
    });
    const state = (await res.json()) as { cards: Array<{ spec: { component: string; props: { limit: number } } }> };
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]!.spec.component).toBe('probe.noteList');
    expect(state.cards[0]!.spec.props.limit).toBe(20);
  });
});

describe('brak modulu nie powoduje odwolan do jego tabel', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  /** Tabele, które w ogóle tworzy jakikolwiek moduł — czytane z ich migracji. */
  const moduleTables = (): string[] => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentic-module-tables-'));
    const p = createPlatform({
      modules: (services) => [createProbeModule(services)],
      env: testGlmEnv(dataDir),
    });
    try {
      return p.registry.modules
        .flatMap((m) => m.migrations)
        .flatMap((mig) => [...mig.sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)])
        .map((m) => m[1]!);
    } finally {
      p.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  it('pusty rejestr: zadna tabela zadnego modulu nie powstaje', async () => {
    const declared = moduleTables();
    expect(declared).toContain('probe_notes');

    const dataDir = mkdtempSync(join(tmpdir(), 'agentic-module-none-'));
    const p = createPlatform({ modules: [], env: testGlmEnv(dataDir) });
    disposers.push(() => {
      p.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const tables = (
      p.db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const table of declared) expect(tables).not.toContain(table);
    // Platforma nadal ma swoje własne tabele — to nie jest pusta baza.
    expect(tables).toContain('canvas_cards');

    // …i nie serwuje niczego, co do nieobecnego modułu należy.
    const cookie = await login(p);
    const status = (await (await p.app.request('/api/status', { headers: { cookie } })).json()) as {
      modules: unknown[];
      tools: unknown[];
      components: Array<{ id: string }>;
    };
    expect(status.modules).toEqual([]);
    expect(status.tools).toEqual([]);
    expect(status.components.some((c) => !c.id.startsWith('platform.'))).toBe(false);

    const views = (await (await p.app.request('/api/ui/views', { headers: { cookie } })).json()) as { views: unknown[] };
    expect(views.views).toEqual([]);

    const spaces = await p.app.request('/api/canvas/spaces/for-scope', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'probe', id: 'x', title: 'x' }),
    });
    expect(((await spaces.json()) as { cards: unknown[] }).cards).toEqual([]);
  });

  it('kontrola granicy obejmuje kod i konfiguracje platformy', () => {
    /*
     * Uruchomiona jako proces, a nie powtórzona tu w innej postaci: to ta sama
     * kontrola, którą wykonuje `pnpm verify` i kopia robocza próby wymiany, więc
     * nie da się jej spełnić w teście, a oblać w regresji (albo odwrotnie).
     */
    const r = spawnSync('node', ['scripts/check-boundaries.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, out).toContain('nie nazywa tabeli modulu');
    expect(out, out).toContain('konfiguracja platformy tez czysta');
    expect(r.status, out).toBe(0);
  });

  it('kazdy modul przechodzi typecheck bez warstwy skladania', () => {
    const r = spawnSync('node', ['scripts/typecheck-modules.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, out).toContain('module-devkit-probe');
    expect(out, out).toContain('module-procurement');
    expect(r.status, out).toBe(0);
  });
});

describe('kopia repozytorium bez .git zna commit, z ktorego powstala', () => {
  /*
   * Własność kroku podmiany, nie pomiarów: to `pnpm check:module-swap` tworzy
   * kopię bez `.git`, więc to tutaj należy pilnować, że regresja uruchomiona w
   * takiej kopii dostaje prawdę o wersji kodu zamiast zapisywać „nieznany”.
   * Bez tego dowód pomiarowy z kopii nie mowilby, z czego powstal — i tak
   * wlasnie oblala integracja BL-05 z BL-06.
   */
  const cwd = process.cwd();
  const env = { commit: process.env[CODE_COMMIT_ENV], dirty: process.env[CODE_TREE_DIRTY_ENV] };
  const outside = mkdtempSync(join(tmpdir(), 'agentic-bez-gita-'));
  afterEach(() => {
    process.chdir(cwd);
    if (env.commit === undefined) delete process.env[CODE_COMMIT_ENV];
    else process.env[CODE_COMMIT_ENV] = env.commit;
    if (env.dirty === undefined) delete process.env[CODE_TREE_DIRTY_ENV];
    else process.env[CODE_TREE_DIRTY_ENV] = env.dirty;
  });

  it('podany commit trafia do rekordu, razem z informacja o roznicy wobec niego', () => {
    process.chdir(outside);
    process.env[CODE_COMMIT_ENV] = 'd5ba1865867229cb31dd96d4e776ba5d17ea26dd';
    process.env[CODE_TREE_DIRTY_ENV] = '1';
    const v = codeVersion();
    expect(v.commit).toBe('d5ba1865867229cb31dd96d4e776ba5d17ea26dd');
    expect(v.brudneDrzewo).toBe(true);
  });

  it('bez podanego commita zostaje wartownik, a podrobka innego ksztaltu nie przechodzi', () => {
    process.chdir(outside);
    delete process.env[CODE_COMMIT_ENV];
    expect(codeVersion().commit).toBe('nieznany');
    // Wartość, która nie wygląda na commit, nie może wejść do rekordu zamiast niego.
    process.env[CODE_COMMIT_ENV] = 'HEAD';
    expect(codeVersion().commit).toBe('nieznany');
  });

  it('git wygrywa ze zmienna wszedzie tam, gdzie git moze odpowiedziec', () => {
    /*
     * Ten test biegnie w dwoch swiatach: w repozytorium (pnpm verify) i w kopii
     * bez `.git` (regresja uruchamiana przez pnpm check:module-swap). Regula
     * jest jedna i tu zapisana w calosci, wiec kazdy z tych swiatow cos
     * sprawdza — zamiast pomijac test tam, gdzie zalozenie nie zachodzi.
     */
    const podrobka = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    process.env[CODE_COMMIT_ENV] = podrobka;
    let gitHead: string | null = null;
    try {
      gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      gitHead = null;
    }
    const v = codeVersion();
    if (gitHead) {
      expect(v.commit).toBe(gitHead);
      expect(v.commit).not.toBe(podrobka);
    } else {
      // Bez gita zostaje to, co podal ten, kto zrobil kopie.
      expect(v.commit).toBe(podrobka);
    }
  });
});

/** Signs in over HTTP and returns the cookie header. */
async function login(p: PlatformInstance): Promise<string> {
  const res = await p.app.request('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: DEFAULT_USER_ID }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
