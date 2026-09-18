#!/usr/bin/env node
/**
 * Próba wymiany domeny: aplikacja bez modułu przykładowego, z modułem kontrolnym.
 *
 * Wymaganie (L9.12, T20): inny minimalny moduł działa bez zmian w platformie.
 * Test jednostkowy `tests/platform-boundary.test.ts` sprawdza to na poziomie
 * `createPlatform`. Ta próba robi to, co zrobiłby autor nowej aplikacji — na
 * kopii repozytorium, nie na nim samym:
 *
 *   1. kopiuje śledzone i nieignorowane pliki do katalogu tymczasowego,
 *   2. zmienia WYŁĄCZNIE dwa pliki warstwy składania — `apps/server/src/compose.ts`
 *      i `apps/web/src/compose.tsx`: obie połówki rejestrują `@module/devkit-probe`
 *      zamiast `@module/procurement`. Router aplikacji zostaje bajt w bajt taki
 *      sam (ekrany modułu montuje kontraktem `UiModule.screens`), a połówka
 *      przeglądarkowa modułu przykładowego zostaje w kopii nietknięta — to jest
 *      dowód, że moduł z ekranami przechodzi typecheck niezależnie od tego, czy
 *      aplikacja go składa,
 *   3. dowodzi sumami SHA-256, że `packages/platform-*` i każdy moduł, którego kopia
 *      nie składa, są identyczne jak przed zmianą,
 *   4. instaluje zależności z lockfile, uruchamia kontrolę granicy, typecheck, build
 *      i regresję jednostkową (test dymny — patrz przy kroku),
 *   5. startuje zbudowany serwer na wolnym porcie z własnym katalogiem danych i sprawdza:
 *      rejestr modułów, narzędzia, trasy modułu, operację odczytu, walidację kompozycji
 *      komponentem modułu, brak tabel nieobecnego modułu, a w przeglądarce —
 *      kartę modułu kontrolnego wyrenderowaną z katalogu danymi z jego własnej
 *      trasy, jego ekran z menu i ekran z parametrem trasy.
 *
 * Co ta próba nazywa po imieniu, a czego nie: podmiana w warstwie składania musi
 * wskazać fragment, który zastępuje (`replaceOnce` przerywa próbę, gdy fragmentu
 * nie ma dokładnie raz — więc nie może zwietrzeć po cichu). Natomiast wszystkie
 * kontrole negatywne — czego po wymianie nie wolno zobaczyć w narzędziach,
 * katalogu, bazie i nawigacji — biorą słownik i nazwy tabel z manifestów oraz
 * migracji modułów, których kopia NIE składa. Wymiana modułu przykładowego w
 * szablonie nie czyni ich więc bezgłośnymi.
 *
 *   node scripts/check-module-swap.mjs [--keep] [--json <plik>]
 *
 * Nie dotyka katalogu repozytorium ani żadnej działającej instancji.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Moduł, którym ta próba podmienia domenę, i jego przestrzeń nazw.
 *
 * To jedyne dwie nazwy, które próba z natury musi znać — to jest moduł, który
 * ona wstawia. Wszystko, czego po wymianie NIE wolno zobaczyć, jest wyprowadzone
 * z manifestów modułów, których kopia nie składa (patrz krok 2).
 */
const SWAPPED_IN = 'module-devkit-probe';
const COMPOSED_ID = 'probe';
const keep = process.argv.includes('--keep');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const steps = [];
const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}: ${detail}`);
};

const run = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const hashTree = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      if (e === 'node_modules' || e === 'dist') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
};

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const replaceOnce = (file, from, to) => {
  const src = readFileSync(file, 'utf8');
  if (src.split(from).length !== 2) throw new Error(`${relative(work, file)}: oczekiwano dokładnie jednego wystąpienia fragmentu`);
  writeFileSync(file, src.replace(from, to));
};

const work = mkdtempSync(join(tmpdir(), 'agentic-module-swap-'));
let server = null;
const started = Date.now();

try {
  /* 1. kopia repozytorium ------------------------------------------------- */
  const listed = run('git', ['ls-files', '-co', '--exclude-standard', '-z'], repo);
  record('lista plików repozytorium', listed.code === 0, listed.code === 0 ? '' : listed.out);
  const files = listed.out.split('\0').filter(Boolean);
  for (const f of files) {
    const src = join(repo, f);
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue; // usunięty w drzewie roboczym
    }
    mkdirSync(dirname(join(work, f)), { recursive: true });
    cpSync(src, join(work, f));
  }
  record('kopia robocza', true, `${files.length} plików → ${work}`);

  /*
   * Hashed before and after: the platform packages, and the example module too.
   * The example module has to survive the swap untouched — an application that
   * composes a different module must still be able to typecheck and build the
   * one it is not composing, or "a module works without changes in the
   * platform" would only mean "after deleting the other module".
   */
  const moduleDirs = readdirSync(join(work, 'packages')).filter((d) => d.startsWith('module-')).sort();
  const absentModules = moduleDirs.filter((d) => d !== SWAPPED_IN);
  const untouchedDirs = readdirSync(join(work, 'packages'))
    .filter((d) => d.startsWith('platform-') || absentModules.includes(d))
    .sort();
  const platformDirs = untouchedDirs.filter((d) => d.startsWith('platform-'));
  const before = Object.fromEntries(untouchedDirs.map((d) => [d, hashTree(join(work, 'packages', d))]));

  /*
   * Czego po wymianie nie wolno zobaczyć — wyprowadzone, nie wpisane.
   *
   * Te asercje negatywne wcześniej wymieniały z nazwy słownik modułu
   * przykładowego („Sprawy zakupowe”, `pc_`, `procurement_`). W szablonie ktoś
   * ten moduł wymieni — i wtedy każda z nich staje się na zawsze bezgłośna,
   * a krok raportuje OK, nie sprawdzając niczego. Ta sama wada, którą kontrola
   * granicy naprawiła przy nazwach tabel. Źródłem jest więc manifest modułu,
   * którego kopia NIE składa, i jego własne migracje.
   */
  const manifestOf = (d) => JSON.parse(readFileSync(join(work, 'packages', d, 'package.json'), 'utf8'));
  const absentPrefixes = absentModules.flatMap((d) => manifestOf(d).agenticApp?.domainVocabulary ?? []);
  const absentLabels = absentModules.flatMap((d) => manifestOf(d).agenticApp?.domainLabels ?? []);
  /*
   * Zakresy canvasu, na które odpowiada moduł: te, które kopia składa, i te,
   * których nie. Deklarowane w manifeście (`agenticApp.scopeKinds`), bo wpisana
   * na sztywno wartość zmyślona sprawdza mniej niż prawdziwy identyfikator
   * cudzego modułu — zmyślony ciąg mógłby zostać odrzucony z zupełnie innego
   * powodu. Deklaracja nie może zgnić po cichu: zakres modułu składanego musi
   * w tej samej próbie WYTWORZYĆ jego kompozycję domyślną (krok niżej).
   */
  const composedScopeKinds = manifestOf(SWAPPED_IN).agenticApp?.scopeKinds ?? [];
  const absentScopeKinds = absentModules.flatMap((d) => manifestOf(d).agenticApp?.scopeKinds ?? []);
  const absentTables = [];
  for (const d of absentModules) {
    const walk = (dir) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
            absentTables.push(m[1]);
          }
        }
      }
    };
    walk(join(work, 'packages', d, 'src'));
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Co ze słownika nieobecnego modułu przecieka do podanego tekstu. */
  const leaks = (text) => [
    ...absentPrefixes.filter((w) => new RegExp(`\\b${escapeRe(w)}`, 'i').test(text)),
    ...absentLabels.filter((w) => new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(text)),
  ];
  record(
    'moduł niescalany dostarcza słownik do kontroli negatywnych',
    absentModules.length > 0 &&
      absentPrefixes.length > 0 &&
      absentLabels.length > 0 &&
      absentTables.length > 0 &&
      absentScopeKinds.length > 0 &&
      composedScopeKinds.length > 0,
    `${absentModules.join(', ')}: ${absentPrefixes.length} przedrostkow, ${absentLabels.length} etykiet, ${absentTables.length} tabel, zakresy [${absentScopeKinds.join(', ')}]; modul skladany: zakresy [${composedScopeKinds.join(', ')}]`,
  );

  /* 2. zmiana warstwy składania ------------------------------------------- */
  const serverCompose = join(work, 'apps/server/src/compose.ts');
  replaceOnce(serverCompose, "import { createProcurementModule } from '@module/procurement/server';", "import { createProbeModule } from '@module/devkit-probe/server';");
  replaceOnce(serverCompose, 'modules: (services) => [createProcurementModule(services)],', 'modules: (services) => [createProbeModule(services)],');

  const webCompose = join(work, 'apps/web/src/compose.tsx');
  replaceOnce(webCompose, "import { procurementUiModule } from '@module/procurement/ui';", "import { probeUiModule } from '@module/devkit-probe/ui';");
  replaceOnce(webCompose, 'modules: [procurementUiModule],', 'modules: [probeUiModule],');
  record('warstwa składania przełączona na moduł kontrolny', true, 'apps/server/src/compose.ts, apps/web/src/compose.tsx');

  /*
   * The router is not edited at all — the whole point of `UiModule.screens`.
   * Asserted rather than assumed: if this file ever went back to importing a
   * module page by name, the swap would silently need an edit here again.
   */
  const router = join(work, 'apps/web/src/router.tsx');
  const routerSrc = readFileSync(router, 'utf8');
  record(
    'router aplikacji bez zmian i bez nazwy jakiegokolwiek modułu',
    readFileSync(join(repo, 'apps/web/src/router.tsx'), 'utf8') === routerSrc && !routerSrc.includes('@module/'),
    'ekrany modułu montowane z registry.screens',
  );

  const after = Object.fromEntries(untouchedDirs.map((d) => [d, hashTree(join(work, 'packages', d))]));
  const changedPackages = untouchedDirs.filter((d) => before[d] !== after[d]);
  record('pakiety platformy i moduł przykładowy bez zmian', changedPackages.length === 0, changedPackages.length ? changedPackages.join(', ') : untouchedDirs.map((d) => `${d}:${after[d].slice(0, 12)}`).join(' '));

  const changedFiles = files.filter((f) => {
    try {
      return !readFileSync(join(repo, f)).equals(readFileSync(join(work, f)));
    } catch {
      return true; // usunięty w kopii
    }
  });
  const allowedChange = (f) => f === 'apps/server/src/compose.ts' || f === 'apps/web/src/compose.tsx';
  record(
    'zmienione pliki ograniczone do dwóch plików warstwy składania',
    changedFiles.length === 2 && changedFiles.every(allowedChange),
    changedFiles.join(', '),
  );

  /* 3. instalacja, granica, typy, build ------------------------------------ */
  let inst = run('pnpm', ['install', '--frozen-lockfile', '--offline', '--reporter=silent'], work);
  if (inst.code !== 0) inst = run('pnpm', ['install', '--frozen-lockfile', '--reporter=silent'], work);
  record('pnpm install --frozen-lockfile', inst.code === 0, inst.code === 0 ? '' : inst.out.slice(-800));

  const boundaries = run('node', ['scripts/check-boundaries.mjs'], work);
  record('kontrola granicy platforma–domena', boundaries.code === 0, boundaries.code === 0 ? '' : boundaries.out.slice(-800));

  const types = run('pnpm', ['-s', 'typecheck'], work);
  record('typecheck', types.code === 0, types.code === 0 ? '' : types.out.slice(-1500));

  const build = run('pnpm', ['-s', 'build'], work, { DO_NOT_TRACK: '1' });
  record('build frontendu i backendu', build.code === 0, build.code === 0 ? '' : build.out.slice(-1500));

  /*
   * Regresja jednostkowa na kopii — **test dymny**, i tylko tak wolno go czytać.
   *
   * Testy w `tests/` budują platformę same (`createPlatform` / `createHarness`)
   * i rejestrują moduł wprost, więc nie przechodzą przez warstwę składania w `apps/`
   * i biegłyby tak samo, gdyby kopia składała cokolwiek innego. Ten krok mówi
   * zatem: podmiana warstwy składania niczego w repozytorium nie zepsuła — a
   * NIE: „regresja platformy jest zielona na module kontrolnym”. To drugie
   * zdanie jest prawdziwe o `tests/module-contract.test.ts`, bo tamte testy
   * naprawdę biegną na module kontrolnym.
   */
  const unit = run('pnpm', ['-s', 'test'], work);
  const summary = (unit.out.match(/Tests\s+.*$/m) ?? [''])[0].trim();
  record('regresja jednostkowa na kopii przechodzi (test dymny podmiany)', unit.code === 0, unit.code === 0 ? summary : unit.out.slice(-1500));

  /* 4. start i sprawdzenie ------------------------------------------------- */
  const port = await freePort();
  const dataDir = join(work, '.swap-data');
  const base = `http://127.0.0.1:${port}`;
  const serverLog = [];
  server = spawn('node', ['dist/server.js'], {
    cwd: join(work, 'apps/server'),
    env: {
      ...process.env,
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      APP_WEB_DIST: join(work, 'apps/web/dist'),
      APP_ALLOWED_ORIGINS: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      healthy = (await fetch(`${base}/api/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  record('serwer wystartował', healthy, `${base}; ${serverLog.join('').split('\n').filter((l) => l.includes('modules:')).join('').trim()}`);

  const session = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0];
  const api = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { cookie, origin: base, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const status = await api('/api/status');
  const moduleIds = (status.body?.modules ?? []).map((m) => m.id);
  const toolNames = (status.body?.tools ?? []).map((t) => t.name);
  record('rejestr: wyłącznie moduł kontrolny', JSON.stringify(moduleIds) === '["probe"]', `moduły=${JSON.stringify(moduleIds)}`);
  record(
    'narzędzia: wyłącznie przestrzeń nazw modułu kontrolnego',
    toolNames.includes(`${COMPOSED_ID}_add_note`) &&
      toolNames.includes(`${COMPOSED_ID}_list_notes`) &&
      toolNames.every((n) => n.startsWith(`${COMPOSED_ID}_`)) &&
      leaks(toolNames.join(' ')).length === 0,
    toolNames.join(', '),
  );
  const componentIds = (status.body?.components ?? []).map((c) => c.id);
  record(
    'katalog: komponenty tylko platformy i modułu kontrolnego',
    componentIds.includes(`${COMPOSED_ID}.noteList`) &&
      componentIds.every((id) => id.startsWith('platform.') || id.startsWith(`${COMPOSED_ID}.`)) &&
      leaks(componentIds.join(' ')).length === 0,
    componentIds.join(', '),
  );

  const notes = await api('/api/m/probe/notes');
  record('trasa modułu /api/m/probe/notes', notes.status === 200 && Array.isArray(notes.body?.notes), `HTTP ${notes.status}`);

  const reads = await api('/api/read/operations');
  const readNames = (reads.body?.operations ?? []).map((o) => o.name);
  record(
    'operacja odczytu modułu zarejestrowana z deskryptorem',
    readNames.includes(`${COMPOSED_ID}.notes`) &&
      readNames.every((n) => n.startsWith(`${COMPOSED_ID}.`)) &&
      leaks(readNames.join(' ')).length === 0,
    readNames.join(', '),
  );

  const targets = await api('/api/ui/targets');
  const targetIds = (targets.body?.targets ?? []).map((t) => t.id);
  record('cel nawigacji modułu zarejestrowany', targetIds.includes('probe.notes'), targetIds.join(', '));

  const moduleViews = await api('/api/ui/views');
  const viewIds = (moduleViews.body?.views ?? []).map((v) => v.id);
  record('ekran modułu jako kompozycja OpenUI', viewIds.includes('probe.notes'), viewIds.join(', '));

  // Dane dla przeglądarki wchodzą tą samą trasą modułu, którą czyta jego karta.
  const NOTE_TEXT = `notatka wymiany ${Date.now()}`;
  const created = await api('/api/m/probe/notes', { method: 'POST', body: JSON.stringify({ text: NOTE_TEXT }) });
  record('zapis przez trasę modułu', created.status === 201 && typeof created.body?.id === 'string', `HTTP ${created.status}`);

  const space = await api('/api/canvas/spaces/for-scope', { method: 'POST', body: JSON.stringify({ kind: composedScopeKinds[0], id: 'swap-1', title: 'Próba wymiany' }) });
  const card = space.body?.cards?.[0]?.spec;
  const spaceId = space.body?.space?.id;
  record(
    'zadeklarowany zakres modułu składanego daje jego kompozycję domyślną',
    space.status === 200 && card?.component === `${COMPOSED_ID}.noteList` && card?.props?.limit === 20 && typeof spaceId === 'string',
    `zakres=${composedScopeKinds[0]}, HTTP ${space.status}, karta=${card?.component}`,
  );

  /* Prawdziwe zakresy modułów, których kopia nie składa — to one mają nic nie dać. */
  const scopeAnswers = [];
  for (const kind of absentScopeKinds) {
    const res = await api('/api/canvas/spaces/for-scope', { method: 'POST', body: JSON.stringify({ kind, id: `x-${kind}`, title: 'x' }) });
    scopeAnswers.push({ kind, status: res.status, cards: (res.body?.cards ?? []).length });
  }
  record(
    'zadeklarowane zakresy nieobecnych modułów nie dają kart',
    scopeAnswers.length > 0 && scopeAnswers.every((a) => a.status === 200 && a.cards === 0),
    scopeAnswers.map((a) => `${a.kind}: HTTP ${a.status}, karty=${a.cards}`).join('; '),
  );

  const req = createRequire(join(work, 'packages/platform-server/package.json'));
  const Database = req('better-sqlite3');
  const db = new Database(join(dataDir, 'app.db'), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  db.close();
  const presentAbsentTables = tables.filter((t) => absentTables.includes(t));
  record(
    'baza: tabela modułu kontrolnego, żadnej tabeli nieobecnego modułu',
    tables.includes(`${COMPOSED_ID}_notes`) && presentAbsentTables.length === 0,
    `tabele=${tables.length}; sprawdzono ${absentTables.length} tabel nieobecnego modułu${presentAbsentTables.length ? `; znalezione: ${presentAbsentTables.join(', ')}` : ''}`,
  );

  // require (nie import po ścieżce pliku): rozwiązany plik CJS w imporcie ESM udostępnia tylko `default`.
  const { chromium } = createRequire(join(work, 'package.json'))('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/`);
    await page.getByRole('navigation').first().waitFor({ timeout: 20_000 });
    /*
     * Nagłówki sekcji czytane jako osobne elementy, nie z tekstu całej
     * nawigacji: „Notatki” jest podciągiem pozycji „Notatki testowe”, więc
     * asercja na sklejonym tekście przechodziłaby nawet wtedy, gdyby nagłówek
     * w ogóle nie pochodził od modułu.
     */
    const headings = (await page.locator('.pf-nav__heading').allTextContents()).map((h) => h.trim());
    const links = (await page.locator('.pf-nav__link').allTextContents()).map((t) => t.trim());
    /*
     * Słownika szukamy w rozdzielonych napisach, nie w `textContent` całej
     * nawigacji: tam „Wszystkie sprawy” i „Pliki i raporty” sklejają się w
     * „sprawyPliki”, więc dopasowanie całego słowa (`\bsprawy\b`) nie widzi
     * granicy i przecieka przez kontrolę. Znalezione właśnie próbą F1.
     */
    const navParts = [...headings, ...links];
    const navLeaks = leaks(navParts.join(' | '));
    const shellOk =
      links.includes('Canvas') &&
      links.some((l) => l.startsWith('Pliki')) &&
      links.includes('Notatki testowe') &&
      headings.includes('Notatki') &&
      navLeaks.length === 0;
    record(
      'powłoka w przeglądarce: menu i nagłówki sekcji od modułu kontrolnego, bez słownika nieobecnego modułu',
      shellOk,
      navLeaks.length
        ? `slownik nieobecnego modulu w nawigacji: ${navLeaks.join(', ')} — ${navParts.join(' | ')}`
        : `naglowki=[${headings.join(' | ')}]; pozycje=[${links.join(' | ')}]; sprawdzono ${absentPrefixes.length + absentLabels.length} pojec`,
    );

    /*
     * Karta modułu kontrolnego na canvasie.
     *
     * To jest krok, którego wcześniej nie było: kompozycja domyślna modułu
     * trafia na ekran przez katalog przeglądarki, a treść notatki pochodzi z
     * trasy backendu tego modułu — nie z props karty. Brak renderera nie daje
     * pustej karty, tylko widoczny komunikat „Brak renderera dla komponentu”,
     * więc obie możliwe porażki (brak renderera, brak danych) są tu widoczne.
     */
    await page.goto(`${base}/?s=${spaceId}`);
    const cardList = page.locator('[data-testid="probe-note-list"]').first();
    // Bez renderera karta pokazuje komunikat katalogu, a nie pustkę — więc brak
    // listy jest odnotowany razem z tym, co naprawdę stanęło na jej miejscu.
    const rendered = await cardList
      .waitFor({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    const cardText = rendered ? ((await cardList.textContent()) ?? '') : '';
    const bodyText = (await page.locator('body').textContent()) ?? '';
    record(
      'karta modułu kontrolnego wyrenderowana z katalogu, danymi z trasy modułu',
      rendered && cardText.includes(NOTE_TEXT) && !bodyText.includes('Brak renderera dla komponentu'),
      rendered ? cardText.replace(/\s+/g, ' ').slice(0, 120) : `brak listy na canvasie; strona: ${bodyText.replace(/\s+/g, ' ').slice(0, 200)}`,
    );

    /* Ekran modułu: trasa zamontowana z kontraktu UiModule.screens. */
    await page.goto(`${base}/probe-notes`);
    await page.locator('[data-testid="probe-notes-page"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-testid="composed-view"][data-view-id="probe.notes"][data-state="ready"]').waitFor({ timeout: 20_000 });
    // Kompozycja ma dwa źródła: komponent modułu i tabelę platformy na jego operacji odczytu.
    await page.getByRole('table').first().waitFor({ timeout: 20_000 });
    const screenText = (await page.locator('[data-testid="probe-notes-page"]').textContent()) ?? '';
    const tableText = (await page.getByRole('table').first().textContent()) ?? '';
    record(
      'ekran modułu zamontowany kontraktem i wypełniony kompozycją OpenUI',
      screenText.includes(NOTE_TEXT) && tableText.includes(NOTE_TEXT),
      screenText.replace(/\s+/g, ' ').slice(0, 140),
    );

    /* Ekran z parametrem trasy: moduł czyta $noteId bez nazywania trasy aplikacji. */
    await page.goto(`${base}/probe-notes/${created.body.id}`);
    await page.locator('[data-testid="probe-note-page"]').waitFor({ timeout: 20_000 });
    const detailText = (await page.locator('[data-testid="probe-note-text"]').textContent()) ?? '';
    record('ekran modułu z parametrem trasy czyta swój $noteId', detailText.trim() === NOTE_TEXT, detailText.trim().slice(0, 120));

    await page.goto(`${base}/files`);
    await page.waitForLoadState('networkidle');
    await page.goto(`${base}/settings`);
    await page.waitForLoadState('networkidle');
    record('ekrany platformy /files i /settings bez błędów strony', errors.length === 0, errors.join(' | ').slice(0, 400));
  } finally {
    await browser.close();
  }

  record('próba zakończona', true, `${Math.round((Date.now() - started) / 1000)} s`);
} catch (err) {
  if (!steps.some((s) => !s.ok)) steps.push({ name: 'wyjątek', ok: false, detail: String(err?.stack ?? err) });
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  if (server) server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ ok: process.exitCode !== 1, steps, keptWorkDir: keep ? work : null }, null, 2) + '\n');
  if (!keep) rmSync(work, { recursive: true, force: true });
  else console.log(`katalog próby pozostawiony: ${work}`);
}
