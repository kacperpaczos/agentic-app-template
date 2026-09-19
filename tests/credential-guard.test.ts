import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  claudeConfigDir,
  collectToolEntries,
  platformTools,
  createRunWorkspace,
  invokeTool,
  AUTO_APPROVED_FILE_TOOLS,
  TOOL_PERMISSION_MATRIX,
  declaresPathArguments,
  decideTool,
  protectedDirsFor,
  protectedPathRefusal,
  realResolve,
  sandboxSettings,
} from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type StandInHandle, type Step } from './support/model-standin.ts';

/**
 * The login stays out of the agent's reach.
 *
 * L8.7 says credentials do not appear in the frontend, in artifacts or in logs.
 * Everything the application writes was already checked for that. What was not
 * checked is the other direction — whether the **agent** can simply open the
 * credential file and put the token into an answer. It could: `Read` is
 * pre-approved, so the consent gate is never consulted for it, and the sandbox
 * denied only the application's data directory.
 *
 * **Simulation, and marked as such.** The model is replaced at the adapter
 * boundary by a stand-in that plays the SDK's built-in file tool the way the
 * SDK does: it fires `PreToolUse`, honours a `deny` decision, and otherwise
 * really reads the file. That last part is what makes these assertions worth
 * anything — without the refusal the bytes reach the answer, which is the
 * negative control built into the step.
 *
 * **The credential here is a canary, in a temporary directory.** `CLAUDE_CONFIG_DIR`
 * is redirected for the duration of each test, so nothing reads, writes or
 * invalidates the real login.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
let configDir: string;
let realConfigDir: string | undefined;
/** Where the login really lives, captured before any test redirects anything. */
const realConfigDirAtImport = process.env.CLAUDE_CONFIG_DIR;
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

/** A value that exists nowhere else, so finding it anywhere is proof of a leak. */
const CANARY = 'KANAREK-POSWIADCZENIA-7f3a91c4';

const EMPTY_CONTEXT = {
  conversationId: null as string | null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

async function startRun(script: Step[], opts: { honorUpdatedInput?: boolean } = {}) {
  promptSeq += 1;
  const prompt = `polecenie poswiadczenia ${promptSeq}`;
  const handle: StandInHandle = newStandInHandle();
  handle.honorUpdatedInput = opts.honorUpdatedInput ?? true;
  plans.set(prompt, { script, handle });
  const conversationId = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    title: 'Poswiadczenia',
  }).id;
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  pending.push(started.done.catch(() => undefined), reader);
  await started.done;
  await reader;
  return { stand: handle, events, conversationId, runId: started.runId };
}

/** Minimalny kontekst wywolania narzedzia — tyle, ile potrzebuje publikacja. */
const toolContext = (runId: string, workspaceDir: string) =>
  ({
    ownerId: h.ownerId,
    conversationId: null,
    runId,
    workspaceDir,
    emit: () => {},
    requestUi: async () => ({ executed: false, reason: 'brak klienta' }),
  }) as any;

const answerText = (events: Array<Record<string, any>>) =>
  events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => String(e.delta ?? ''))
    .join('');

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'kanarek-claude-'));
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: CANARY, refreshToken: `${CANARY}-refresh`, subscriptionType: 'max' },
    }),
  );
  realConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  plans = new Map();
  h = await createHarness({
    withModule: false,
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
  runtime = h.platform.runtime;
});

afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

/* ---------------------- the user's own login is untouched ------------------ */

/**
 * The clause of L8.14 that is easy to state and was never checked: *negative
 * tests must not destroy the user's login*.
 *
 * It was true here by construction — every test in this file redirects
 * `CLAUDE_CONFIG_DIR` — and "true by construction" is exactly the kind of
 * property that stops being true when somebody adds a test that forgets to.
 * So it is measured: the real credential file's size and modification time are
 * taken before the suite and compared after it. A test that wrote to the real
 * login, or deleted it, changes both.
 */
/** Prawdziwy katalog logowania — ustalony raz, zanim cokolwiek go przekieruje. */
const realUserConfigDir = claudeConfigDir({
  ...process.env,
  CLAUDE_CONFIG_DIR: realConfigDirAtImport,
} as NodeJS.ProcessEnv);

const userCredentialFingerprint = (): string => {
  const file = join(realUserConfigDir, '.credentials.json');
  if (!existsSync(file)) return 'brak';
  const st = statSync(file);
  return `${st.size}:${st.mtimeMs}`;
};
const userCredentialBefore = userCredentialFingerprint();

describe('testy negatywne nie dotykaja logowania uzytkownika', () => {
  it('katalog poswiadczen uzyty przez testy nie jest katalogiem uzytkownika', () => {
    expect(configDir).not.toBe(realUserConfigDir);
    expect(configDir.startsWith(tmpdir())).toBe(true);
  });

});

/*
 * Na poziomie PLIKU, nie wewnątrz `describe`.
 *
 * `afterAll` w bloku obejmuje tylko ten blok, więc odpalał się po pierwszym
 * teście — zanim dwa kolejne w ogóle wystartowały — i sprawdzał okno, które
 * prawie nic nie obejmowało. Commit, który to „naprawiał", nie osiągnął tego,
 * co głosił jego opis; wyłapała to recenzja, sprawdzając semantykę
 * doświadczalnie. Tutaj hook biegnie po **wszystkich** testach tego pliku,
 * czyli w chwili, o której mówi asercja. `brak` na maszynie bez logowania jest
 * poprawną odpowiedzią i porównuje się sam ze sobą.
 */
afterAll(() => {
  expect(userCredentialFingerprint(), 'plik logowania uzytkownika zmienil sie w trakcie testow').toBe(
    userCredentialBefore,
  );
});

/* ---------------------------------- rule ---------------------------------- */

describe('regula chronionych katalogow', () => {
  const guards = [
    { dir: '/tmp/dane-aplikacji', what: 'danych aplikacji' },
    { dir: '/home/ktos/.claude', what: 'poswiadczen Claude' },
  ];

  it('odczyt pliku poswiadczen jest odrzucony z podaniem powodu', () => {
    const reason = protectedPathRefusal(
      'Read',
      { file_path: '/home/ktos/.claude/.credentials.json' },
      guards,
    );
    expect(reason).toBeTruthy();
    expect(reason).toContain('poswiadczen Claude');
  });

  it('kazde narzedzie plikowe jest objete regula, nie tylko Read', () => {
    for (const [tool, input] of [
      ['Write', { file_path: '/home/ktos/.claude/x' }],
      ['Edit', { file_path: '/home/ktos/.claude/.credentials.json' }],
      ['Glob', { path: '/home/ktos/.claude' }],
      ['Grep', { path: '/home/ktos/.claude' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(protectedPathRefusal(tool, input, guards), `${tool} nieobjete regula`).toBeTruthy();
    }
  });

  it('baza aplikacji jest chroniona tak samo jak logowanie', () => {
    expect(protectedPathRefusal('Read', { file_path: '/tmp/dane-aplikacji/app.db' }, guards)).toBeTruthy();
  });

  it('zwykly plik roboczy przechodzi bez zmian', () => {
    expect(protectedPathRefusal('Read', { file_path: '/tmp/ws/output/wynik.txt' }, guards)).toBeNull();
    // A path that merely resembles the guarded one is not inside it.
    expect(protectedPathRefusal('Read', { file_path: '/home/ktos/.claude-notatki/plan.md' }, guards)).toBeNull();
  });

  it('sciezka wzgledna jest oceniana po rozwiazaniu, nie po zapisie', () => {
    const fromWorkspace = (p: string) => resolve('/tmp/ws/run_1', p);
    expect(
      protectedPathRefusal('Read', { file_path: '../../../home/ktos/.claude/.credentials.json' }, guards, fromWorkspace),
    ).toBeTruthy();
    expect(protectedPathRefusal('Read', { file_path: 'output/wynik.txt' }, guards, fromWorkspace)).toBeNull();
  });

  it('narzedzie bez argumentu sciezki nie jest zgadywane', () => {
    // `Bash` is confined by the sandbox, not by a path argument it does not have.
    expect(protectedPathRefusal('Bash', { command: 'cat /home/ktos/.claude/.credentials.json' }, guards)).toBeNull();
  });
});

describe('sandbox zna katalog poswiadczen', () => {
  it('katalog logowania jest zablokowany do odczytu i zapisu', () => {
    const s = sandboxSettings({
      workspaceDir: '/tmp/ws',
      dataDir: '/tmp/dane',
      credentialDirs: ['/home/ktos/.claude'],
    }) as any;
    expect(s.filesystem.denyRead).toContain('/home/ktos/.claude');
    expect(s.filesystem.denyWrite).toContain('/home/ktos/.claude');
    // And the data directory it already protected is still protected.
    expect(s.filesystem.denyRead).toContain('/tmp/dane');
  });

  it('katalog poswiadczen czyta zmienna CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/gdzies/indziej' } as NodeJS.ProcessEnv)).toBe('/gdzies/indziej');
    expect(claudeConfigDir({} as NodeJS.ProcessEnv)).toMatch(/\.claude$/);
  });
});

/* ------------------------------ through a run ------------------------------ */

describe('uruchomienie nie moze odczytac poswiadczenia (symulacja na granicy adaptera)', () => {
  it('proba odczytu pliku poswiadczen konczy sie odmowa, a kanarek nie trafia do odpowiedzi', async () => {
    const { stand, events } = await startRun([
      { kind: 'text', text: 'Sprawdzam plik logowania. ' },
      { kind: 'fileTool', name: 'Read', input: { file_path: join(configDir, '.credentials.json') } },
      { kind: 'text', text: 'Koniec.' },
    ]);

    /*
     * The leak assertion comes first, deliberately. It is the property the
     * criterion is about, and a detection trial has to fail *here* — on the
     * canary reaching the answer — rather than on a bookkeeping record that
     * happens to be checked earlier.
     */
    const text = answerText(events);
    expect(text.includes(CANARY), 'wartosc poswiadczenia trafila do odpowiedzi').toBe(false);
    // The refusal is announced, not swallowed: the step is in the conversation.
    expect(text).toContain('odmowa');

    expect(stand.fileTools).toEqual([
      expect.objectContaining({ name: 'Read', denied: true }),
    ]);
    /*
     * Powód odmowy jest teraz regułą POZYTYWNĄ („poza katalogiem roboczym"), bo
     * ona sprawdzana jest pierwsza i obejmuje ten przypadek. To, że lista
     * chronionych katalogów też by go złapała, sprawdza osobno test jednostkowy
     * `protectedPathRefusal` — warstwa nie zniknęła, zmieniła się kolejność.
     */
    expect(stand.fileTools[0]?.reason).toMatch(/katalogu roboczego|poswiadczen Claude/);
  });

  it('odmowa jest widoczna w historii jako nieudany krok narzedzia', async () => {
    const { conversationId } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: join(configDir, '.credentials.json') } },
      { kind: 'text', text: 'Nie moge tego odczytac.' },
    ]);
    const messages = h.platform.services.conversations.messages(conversationId, h.ownerId);
    const stored = JSON.stringify(messages);
    // Again the leak first, then the bookkeeping.
    expect(stored.includes(CANARY), 'wartosc poswiadczenia trafila do historii rozmowy').toBe(false);
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length, 'krok narzedzia nie trafil do historii').toBeGreaterThan(0);
    // Marked as a failure, so the chat shows it as one.
    expect(toolMessages.some((m) => (m.meta as any)?.isError === true || String(m.content).includes('odmowa') || String(m.content).includes('nie ma dostepu'))).toBe(true);
  });

  it('caly katalog logowania jest poza zasiegiem, nie tylko jeden plik', async () => {
    const { stand } = await startRun([
      { kind: 'fileTool', name: 'Glob', input: { path: configDir, pattern: '*' } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    expect(stand.fileTools[0]).toMatchObject({ denied: true });
  });

  it('podwykonawca NIE omija odmowy — ta sama sciezka, to samo rozstrzygniecie', async () => {
    /*
     * Regresja na dziurę znalezioną w recenzji. Most hookowy wychodził wcześniej
     * dla ruchu podwykonawcy (`agent_id`), żeby nie dublować aktywności w
     * czacie — i wychodził **przed** odmową. Efekt: dla podwykonawcy warstwa 2
     * wychodziła bez decyzji, warstwa 3 jest przesłonięta przez `allowedTools`,
     * a warstwa 1 nie obejmuje wewnętrznych narzędzi plikowych SDK. Wszystkie
     * trzy naraz. Narzędzie uruchamiające podwykonawcę trafia do bramki zgód,
     * więc wystarczyło jedno „tak" użytkownika.
     */
    const { stand, events } = await startRun([
      { kind: 'text', text: 'Zlecam podwykonawcy. ' },
      {
        kind: 'fileTool',
        name: 'Read',
        input: { file_path: join(configDir, '.credentials.json') },
        subagent: true,
      },
      { kind: 'text', text: 'Koniec.' },
    ]);

    const text = answerText(events);
    expect(text.includes(CANARY), 'podwykonawca odczytal poswiadczenie').toBe(false);
    expect(stand.fileTools[0]).toMatchObject({ denied: true });
    expect(stand.fileTools[0]?.reason).toMatch(/katalogu roboczego|poswiadczen Claude/);
    // Odmowa jest widoczna, mimo że zwykła aktywność podwykonawcy jest wyciszona.
    expect(text).toContain('odmowa');
  });

  it('dowiazanie w workspace wskazujace na katalog poswiadczen nie omija odmowy', async () => {
    /*
     * `path.resolve` odpowiada na pytanie o tekst, nie o system plików: link
     * leżący w workspace i wskazujący na katalog logowania rozwiązuje się na
     * ścieżkę **wewnątrz** workspace i przechodzi przez porównanie prefiksu.
     */
    const linkDir = mkdtempSync(join(tmpdir(), 'kanarek-ws-'));
    const link = join(linkDir, 'skrot');
    symlinkSync(configDir, link, 'dir');
    try {
      const { stand, events } = await startRun([
        { kind: 'fileTool', name: 'Read', input: { file_path: join(link, '.credentials.json') } },
        { kind: 'text', text: 'Koniec.' },
      ]);
      expect(answerText(events).includes(CANARY), 'dowiazanie ominelo odmowe').toBe(false);
      expect(stand.fileTools[0]).toMatchObject({ denied: true });
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it('realResolve podaza za dowiazaniem, a nieistniejacy plik ocenia po rodzicu', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanarek-real-'));
    const link = join(dir, 'skrot');
    symlinkSync(configDir, link, 'dir');
    try {
      // Istniejące dowiązanie jest rozwinięte…
      expect(realResolve(dir, 'skrot/.credentials.json')).toBe(join(configDir, '.credentials.json'));
      // …a plik, którego jeszcze nie ma, jest oceniany po najbliższym istniejącym rodzicu.
      expect(realResolve(dir, 'skrot/jeszcze-nie-ma.txt')).toBe(join(configDir, 'jeszcze-nie-ma.txt'));
      // Ścieżka bez żadnego istniejącego przodka nie wywraca funkcji.
      expect(realResolve(dir, 'a/b/c.txt')).toBe(join(dir, 'a/b/c.txt'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plik konfiguracji obok katalogu logowania tez jest chroniony', () => {
    // `~/.claude.json` leży OBOK `~/.claude`, więc reguła o katalogu go omija.
    const guards = protectedDirsFor('/tmp/dane', '/home/ktos/.claude');
    expect(protectedPathRefusal('Read', { file_path: '/home/ktos/.claude.json' }, guards)).toBeTruthy();
    expect(protectedPathRefusal('Read', { file_path: '/home/ktos/.claude/.credentials.json' }, guards)).toBeTruthy();
    expect(protectedPathRefusal('Read', { file_path: '/home/ktos/.claude-notatki/plan.md' }, guards)).toBeNull();
  });

  it('publikacja przez dowiazanie w output/ jest odrzucona, a artefakt nie powstaje', async () => {
    /*
     * Piąta droga, znaleziona w rerecenzji, i jedyna kończąca się **plikiem do
     * pobrania**. `artifact_publish_file` i `files_publish_version` to narzędzia
     * MCP: `decideTool` odpowiada dla nich `'auto'`, nie ma ich w
     * `PATH_ARGUMENTS`, więc `protectedPathRefusal` zwraca `null`. Całą obroną
     * jest `resolveInWorkspace`, a ono porównywało ścieżkę **tekstowo**.
     *
     * Dowiązanie w `output/` przechodziło więc kontrolę przedrostka (jego własna
     * ścieżka leży w workspace), `statSync` mówiło „plik", `readFileSync`
     * podążało za dowiązaniem — i zawartość lądowała w artefakcie. Utworzenia
     * dowiązania nic nie blokuje i blokować nie powinno: robienie linku **niczego
     * nie czyta**, więc zakaz odczytu go nie widzi.
     *
     * Cel dowiązania jest ATRAPĄ o wymyślonej treści w katalogu tymczasowym —
     * nie prawdziwym poświadczeniem i nie jego kopią. Sprawdzane jest to, że
     * narzędzie **odmawia**, a nie to, co by przeczytało.
     */
    const outsideDir = mkdtempSync(join(tmpdir(), 'atrapa-poza-ws-'));
    const decoy = join(outsideDir, '.credentials.json');
    writeFileSync(decoy, JSON.stringify({ claudeAiOauth: { accessToken: CANARY, refreshToken: CANARY } }));

    const before = h.platform.services.artifacts.list(h.ownerId, {}).length;
    const entries = collectToolEntries({
      registry: h.platform.registry,
      platformTools: platformTools(h.platform.services),
    });
    const publish = entries.find((e) => e.localName === 'artifact_publish_file');
    expect(publish, 'brak narzedzia artifact_publish_file').toBeTruthy();

    const ws = createRunWorkspace(h.platform.config.workspacesDir, 'run_dowiazanie');
    try {
      // Dowiązanie, które mogłaby zrobić zaakceptowana komenda w sandboxie.
      symlinkSync(decoy, join(ws.outputDir, 'raport.json'));

      const outcome = await invokeTool(
        publish!,
        {
          path: 'raport.json',
          title: 'Raport',
          operationId: `proba-dowiazanie-${Date.now()}`,
        },
        toolContext('run_dowiazanie', ws.dir),
      );

      /*
       * Najpierw szkoda, potem mechanizm. Własnością, której broni ten test, jest
       * „nie powstał plik do pobrania" — i to ona ma nazywać oblanie, a nie
       * bookkeeping o kodzie błędu. Ta sama lekcja, co przy próbie A.
       */
      expect(
        h.platform.services.artifacts.list(h.ownerId, {}).length,
        'POWSTAL ARTEFAKT DO POBRANIA mimo dowiazania poza workspace',
      ).toBe(before);
      const text = outcome.content.map((c) => c.text).join('');
      expect(text.includes(CANARY), 'tresc atrapy trafila do wyniku narzedzia').toBe(false);
      expect(outcome.isError, 'publikacja przez dowiazanie NIE zostala odrzucona').toBe(true);
      expect(text).toContain('sandbox_denied');
    } finally {
      ws.dispose();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('zwykly plik w output/ publikuje sie normalnie', async () => {
    /*
     * Kontrola w drugą stronę: rozwiązywanie rzeczywistych ścieżek nie może
     * zepsuć publikacji, dla której te narzędzia istnieją.
     */
    const entries = collectToolEntries({
      registry: h.platform.registry,
      platformTools: platformTools(h.platform.services),
    });
    const publish = entries.find((e) => e.localName === 'artifact_publish_file')!;
    const ws = createRunWorkspace(h.platform.config.workspacesDir, 'run_zwykly');
    try {
      writeFileSync(join(ws.outputDir, 'wynik.txt'), 'zwykla tresc wyniku');
      const outcome = await invokeTool(
        publish,
        { path: 'wynik.txt', title: 'Wynik', operationId: `proba-zwykly-${Date.now()}` },
        toolContext('run_zwykly', ws.dir),
      );
      expect(outcome.isError, outcome.content.map((c) => c.text).join('')).toBeFalsy();
    } finally {
      ws.dispose();
    }
  });

  /* ---------- kolejność rozwiązywania: dowiązanie przed `..` ---------- */

  /**
   * Trzy kształty z rerecenzji, każdy odtworzony dokładnie tak, jak je odtworzył
   * recenzent. Wspólny mechanizm: `path.resolve` zwijał `..` **leksykalnie**,
   * zanim ktokolwiek dotknął dowiązań, a jądro robi to odwrotnie. Materiału nie
   * trzeba nawet przygotowywać — `node_modules/<biblioteka>` jest dowiązaniem
   * wyprowadzającym poza workspace i tworzy je `createRunWorkspace`.
   */
  it('dowiazanie + ".." NIE omija reguly: zapis nie tworzy pliku poza workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'biblioteka-poza-ws-'));
    mkdirSync(join(outside, 'exceljs'), { recursive: true });
    const podrzucony = join(outside, 'podrzucony.txt');
    try {
      const { stand } = await startRun([
        { kind: 'linkIntoWorkspace', from: join(outside, 'exceljs'), to: 'node_modules/exceljs' },
        {
          kind: 'fileTool',
          name: 'Write',
          input: { file_path: '$workspace/node_modules/exceljs/../podrzucony.txt' },
          content: 'PODRZUCONA-TRESC',
        },
        { kind: 'text', text: 'Koniec.' },
      ]);
      expect(existsSync(podrzucony), 'POWSTAL PLIK poza workspace przez dowiazanie i ".."').toBe(false);
      expect(stand.fileTools[0]).toMatchObject({ denied: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('dowiazanie + ".." NIE omija reguly: odczyt nie oddaje tresci spoza workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'biblioteka-poza-ws-'));
    mkdirSync(join(outside, 'exceljs'), { recursive: true });
    writeFileSync(join(outside, 'sekret.txt'), `POZA-WS-${CANARY}`);
    try {
      const { stand, events } = await startRun([
        { kind: 'linkIntoWorkspace', from: join(outside, 'exceljs'), to: 'node_modules/exceljs' },
        {
          kind: 'fileTool',
          name: 'Read',
          input: { file_path: '$workspace/node_modules/exceljs/../sekret.txt' },
        },
        { kind: 'text', text: 'Koniec.' },
      ]);
      expect(answerText(events).includes(CANARY), 'odczytano tresc spoza workspace').toBe(false);
      expect(stand.fileTools[0]).toMatchObject({ denied: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('dowiazanie do katalogu poswiadczen + ".." NIE omija obu straznikow', async () => {
    /* Kształt, w którym oba strażniki zwracały `null`, a kanarek był odczytany. */
    const { stand, events } = await startRun([
      { kind: 'linkIntoWorkspace', from: configDir, to: 'link' },
      { kind: 'fileTool', name: 'Read', input: { file_path: '$workspace/link/../.credentials.json' } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    expect(answerText(events).includes(CANARY), 'kanarek odczytany przez dowiazanie i ".."').toBe(false);
    expect(stand.fileTools[0]).toMatchObject({ denied: true });
  });

  it('wzorzec Glob wychodzacy w gore jest odrzucony, zwykly przechodzi', async () => {
    const { stand } = await startRun([
      { kind: 'fileTool', name: 'Glob', input: { path: '$workspace/output', pattern: '../../**' } },
      { kind: 'fileTool', name: 'Glob', input: { path: '$workspace/output', pattern: '**/*.txt' } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    expect(stand.fileTools.map((f) => f.denied)).toEqual([true, false]);
  });

  it('kazde wstepnie zatwierdzone narzedzie plikowe zadeklarowalo, jak podaje sciezke', () => {
    /*
     * Odwrócenie komplementarności: lista narzędzi też jest zbiorem do
     * wyliczenia, więc nie opieramy się na tym, że ktoś pamiętał o obu listach
     * naraz.
     *
     * **Pierwsza wersja tej asercji nie mogła oblać.** Sprawdzała, że każde
     * narzędzie z listy `auto` daje `decideTool → 'auto'` — co pod zepsutą
     * wersją (`return 'auto'` bezwarunkowo) jest tym bardziej prawdziwe. Próba
     * R wyszła zielona i to było znalezisko, nie zaliczenie. Niezmiennik brzmi
     * inaczej: narzędzie wstępnie zatwierdzone **musi mieć zadeklarowany
     * argument ścieżki** — i to oblewa w chwili dopisania takiego narzędzia.
     */
    for (const tool of TOOL_PERMISSION_MATRIX.auto) {
      expect(
        declaresPathArguments(tool),
        `${tool} jest wstepnie zatwierdzone, ale nie zadeklarowalo argumentu sciezki`,
      ).toBe(true);
    }
    // A narzędzie nieznane nadal trafia do zgody, nie do auto.
    expect(decideTool('NarzedzieBezDeklaracji', [])).toBe('consent');
  });

  /* ------------- Z7: dowod, ze narzedzie otwiera PRZEPISANA sciezke -------- */

  /**
   * Centralna teza rundy 4 — „narzędzie otwiera dokładnie ten plik, który
   * sprawdzono" — ma mieć pokrycie dowodowe. Ustawiamy wyścig TOCTOU dokładnie
   * jak recenzent (A10 kontra A10b):
   *
   *   `<ws>/link` → `<ws>/prawy` (wewnątrz workspace), plik po prawej stronie
   *   NIE istnieje. Hook przepisuje `<ws>/link/sekret.txt` na
   *   `<ws>/prawy/sekret.txt` — i to musi otworzyć narzędzie. Po powrocie z
   *   hooka test podmienia `<ws>/link` na katalog POZA workspace z kanarkiem.
   *
   * Przy honorowaniu przepisania narzędzie otwiera `<ws>/prawy/…` (ENOENT —
   * kanarek nie wycieka). Przy wyłączonym — otwiera `<ws>/link/…` po podmianie
   * i kanarek wycieka, więc test oblewa. Zweryfikowane próbą (Z7-neg).
   */
  it('Z7 narzedzie otwiera PRZEPISANA sciezke — wyścig TOCTOU zostaje zamkniety', async () => {
    /*
     * Scenariusz (A10 recenzji): w chwili sprawdzenia `<ws>/link` wskazuje
     * WEWNĄTRZ workspace — więc odmowa nie zapada, a hook przepisuje wejście na
     * `<ws>/prawy/sekret.txt`. Między powrotem z hooka a otwarciem test podmienia
     * `<ws>/link` na katalog POZA workspace z kanarkiem.
     *
     * Przy honorowaniu przepisania narzędzie otwiera `<ws>/prawy/sekret.txt`
     * (ścieżkę sprawdzoną) — kanarek nie wycieka.
     */
    const outside = mkdtempSync(join(tmpdir(), 'wyscig-poza-'));
    const podmieniony = join(outside, 'podmieniony');
    mkdirSync(podmieniony, { recursive: true });
    writeFileSync(join(podmieniony, 'sekret.txt'), `WYSCIG-${CANARY}`);

    const { stand, events } = await startRun(
      [
        { kind: 'mkdir', path: 'prawy' },
        { kind: 'linkIntoWorkspace', from: '$workspace/prawy', to: 'link' },
        {
          kind: 'fileTool',
          name: 'Read',
          input: { file_path: '$workspace/link/sekret.txt' },
          swapBeforeOpen: { link: 'link', to: podmieniony },
        },
        { kind: 'text', text: 'Koniec.' },
      ],
      { honorUpdatedInput: true },
    );
    try {
      const text = answerText(events);
      expect(text.includes(CANARY), 'wyścig oddał treść spoza workspace mimo przepisania').toBe(false);
      // Narzędzie otworzyło DOKŁADNIE ścieżkę, którą sprawdził strażnik.
      expect(stand.opened[0]).toContain('/prawy/sekret.txt');
      expect(stand.opened[0]).not.toContain('/link/');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('Z7-neg ta sama próba z wylaczonym przepisywaniem OBLEWA sie (wiazanie dziala)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wyscig-poza-'));
    const podmieniony = join(outside, 'podmieniony');
    mkdirSync(podmieniony, { recursive: true });
    writeFileSync(join(podmieniony, 'sekret.txt'), `WYSCIG-${CANARY}`);

    try {
      const { stand, events } = await startRun(
        [
          { kind: 'mkdir', path: 'prawy' },
          { kind: 'linkIntoWorkspace', from: '$workspace/prawy', to: 'link' },
          {
            kind: 'fileTool',
            name: 'Read',
            input: { file_path: '$workspace/link/sekret.txt' },
            swapBeforeOpen: { link: 'link', to: podmieniony },
          },
          { kind: 'text', text: 'Koniec.' },
        ],
        { honorUpdatedInput: false },
      );
      const text = answerText(events);
      // Dowód wiązania: narzędzie otworzyło surową ścieżkę (już podmienioną) i
      // kanarek wycieka. Ten test MUSI oblewać przy wyłączonym przepisywaniu.
      expect(text.includes(CANARY), 'bez przepisywania wyścig powinien wyciec').toBe(true);
      // Narzędzie otworzyło SUROWĄ ścieżkę (przez link, już podmieniony) — dowód,
      // że różnica między Z7 a Z7-neg leży dokładnie w honorowaniu przepisania.
      expect(stand.opened[0]).toContain('/link/sekret.txt');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /* ------------- Z8 / Z9: wiazania na poziomie sdkOptions ---------------- */

  /**
   * Z8 — `allowedTools` wyprowadzone z tej samej reguły, która decyduje o
   * auto/zgoda. Próba M4 recenzji: dopisanie narzędzia do listy wstępnie
   * zatwierdzonych bez deklaracji ścieżki stawiało je w `allowedTools`, gdzie
   * bramka nigdy go nie widzi (auto-zatwierdzenie na starszeństwie listy).
   * Filtr w runtime czyni rozjazd niemożliwym; ten test oblewa, gdy ktoś filtr
   * usunie (próba T).
   */
  it('Z8 allowedTools nie zawiera narzedzi plikowych bez zadeklarowanej sciezki', async () => {
    let captured: Record<string, any> | null = null;
    const capturing = new AgentRuntime(h.platform.services, {
      stream: async (_p: unknown, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
      resumeStream: async (_i: unknown, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
    });
    const conversationId = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Z8',
    }).id;
    const started = await capturing.start({
      ownerId: h.ownerId,
      conversationId,
      prompt: 'sprawdz z8',
      appContext: { ...EMPTY_CONTEXT, conversationId },
    });
    await started.done;

    const options = captured as unknown as { allowedTools: string[] };
    expect(options.allowedTools, 'stand-in nie dostal allowedTools').toBeTruthy();
    for (const tool of options.allowedTools) {
      expect(
        declaresPathArguments(tool) || !AUTO_APPROVED_FILE_TOOLS.includes(tool as never),
        `${tool} jest w allowedTools, ale nie zadeklarowalo argumentu sciezki`,
      ).toBe(true);
    }
  });

  /**
   * Z9 — opcja `settings.permissions.blockReadsOutsideWorkingDirectories`
   * (odczyty po stronie SDK) musi mieć wiązanie w regresji. Próba M3 recenzji:
   * usunięcie całego bloku `settings` → 64/64 zielonych. Ten test oblewa.
   */
  it('Z9 uruchomienie przekazuje SDK blokade odczytow poza katalogiem roboczym', async () => {
    let captured: Record<string, any> | null = null;
    const capturing = new AgentRuntime(h.platform.services, {
      stream: async (_p: unknown, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
      resumeStream: async (_i: unknown, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
    });
    const conversationId = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Z9',
    }).id;
    const started = await capturing.start({
      ownerId: h.ownerId,
      conversationId,
      prompt: 'sprawdz z9',
      appContext: { ...EMPTY_CONTEXT, conversationId },
    });
    await started.done;

    expect(
      (captured as any)?.settings?.permissions?.blockReadsOutsideWorkingDirectories,
      'brak blockReadsOutsideWorkingDirectories w sdkOptions.settings',
    ).toBe(true);
  });

  it('uruchomienie NAPRAWDE przekazuje SDK liste chronionych katalogow', async () => {
    /*
     * Wiązanie, nie sama reguła. `protectedDirsFor` jest sprawdzone wyżej na
     * czystej funkcji, a `sandboxSettings` na wywołaniu wprost — ale między
     * nimi jest filtr w `runtime.ts`, który odsiewa katalog danych, i to jest
     * miejsce, gdzie da się po cichu zgubić pozycję. Tu czytane jest to, co
     * runtime faktycznie podał SDK.
     */
    let captured: Record<string, any> | null = null;
    const capturing = new AgentRuntime(h.platform.services, {
      stream: async (_p: unknown, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
      resumeStream: async (_i: unknown, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
    });
    const conversationId = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Sandbox',
    }).id;
    const started = await capturing.start({
      ownerId: h.ownerId,
      conversationId,
      prompt: 'sprawdz sandbox',
      appContext: { ...EMPTY_CONTEXT, conversationId },
    });
    await started.done;

    const fs = (captured as any)?.sandbox?.filesystem;
    expect(fs, 'stand-in nie dostal sdkOptions.sandbox').toBeTruthy();
    expect(fs.denyRead, 'katalog poswiadczen nie trafil do sandboxa').toContain(configDir);
    expect(fs.denyWrite).toContain(configDir);
    // Plik obok katalogu — ten, który wcześniej nie miał ochrony w ogóle.
    expect(fs.denyRead, 'plik konfiguracji obok katalogu nie trafil do sandboxa').toContain(`${configDir}.json`);
    // I katalog danych aplikacji, którego filtr nie ma prawa zgubić.
    expect(fs.denyRead).toContain(h.platform.config.dataDir);
  });

  it('KONTROLA ODWROTNA: zwykly odczyt i zapis W katalogu roboczym dzialaja', async () => {
    /*
     * Obowiązkowa druga strona reguły pozytywnej. Ochrona, która psuje produkt,
     * nie jest ochroną — a reguła „wszystko poza katalogiem roboczym odmawiane"
     * ma ten dokładnie kształt, w którym łatwo odmówić też tego, co wolno.
     */
    const { stand, events } = await startRun([
      { kind: 'fileTool', name: 'Write', input: { file_path: '$workspace/output/notatka.txt' }, content: 'TRESC-ROBOCZA' },
      { kind: 'fileTool', name: 'Read', input: { file_path: '$workspace/output/notatka.txt' } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    expect(stand.fileTools.map((f) => f.denied), 'praca we wlasnym katalogu zostala zablokowana').toEqual([
      false,
      false,
    ]);
    // I odczyt naprawdę zwrócił to, co zapis naprawdę zapisał.
    expect(answerText(events)).toContain('TRESC-ROBOCZA');
  });

  it('plik poza workspace jest nieczytelny, nawet gdy nie jest poswiadczeniem', async () => {
    /*
     * Piąta droga w swojej właściwej postaci. Prawdziwy model dostał kanarka z
     * katalogu, którego nikt nie wymienił na liście zakazów — bo lista zakazów
     * nie może być kompletna. Kanarek jest WYMYŚLONY i leży w katalogu
     * tymczasowym; nie jest ani poświadczeniem użytkownika, ani jego kopią.
     */
    const outside = mkdtempSync(join(tmpdir(), 'kanarek-poza-ws-'));
    const file = join(outside, 'zwykly-sekret.txt');
    writeFileSync(file, `NIEZWIAZANY-KANAREK-${CANARY}`);
    try {
      const { stand, events } = await startRun([
        { kind: 'fileTool', name: 'Read', input: { file_path: file } },
        { kind: 'text', text: 'Koniec.' },
      ]);
      expect(answerText(events).includes(CANARY), 'odczytano plik spoza katalogu roboczego').toBe(false);
      expect(stand.fileTools[0]).toMatchObject({ denied: true });
      expect(stand.fileTools[0]?.reason).toContain('katalogu roboczego');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('zapis poza workspace jest odrzucony, a plik NIE powstaje', async () => {
    /*
     * Druga operacja z raportu prób modelowych: `Write` utworzył plik na
     * ścieżce, której powłoce odmówiono sekundę wcześniej. Asercja jest o
     * SYSTEMIE PLIKÓW, nie o zwróconym obiekcie — stand-in naprawdę zapisuje,
     * gdy hook nie odmówi.
     */
    const outside = mkdtempSync(join(tmpdir(), 'zapis-poza-ws-'));
    const target = join(outside, 'podrzucony.txt');
    try {
      const { stand } = await startRun([
        { kind: 'fileTool', name: 'Write', input: { file_path: target }, content: 'PODRZUCONA-TRESC' },
        { kind: 'text', text: 'Koniec.' },
      ]);
      expect(existsSync(target), 'POWSTAL PLIK poza katalogiem roboczym').toBe(false);
      expect(stand.fileTools[0]).toMatchObject({ denied: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

});
