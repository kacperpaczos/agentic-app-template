import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  claudeConfigDir,
  collectToolEntries,
  createRunWorkspace,
  invokeTool,
  platformTools,
} from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';
import {
  atakujacyAgent,
  newAtakUchwyt,
  realnie,
  type AtakKrok,
  type AtakPlan,
  type AtakUchwyt,
} from './support/attack-standin.ts';

/**
 * PRÓBY ATAKU RECENZENTA — pakiet BL-04, runda 4 (gałąź `przeglad/z12-r4`).
 *
 * Każdy test jest **próbą ataku**, nie asercją poprawności. Nazwa mówi, czego
 * próbowano; asercja zapisuje **wynik zaobserwowany**, a nie wynik pożądany.
 * Tam, gdzie atak przeszedł, asercja to utrwala — bo raport ma pokazywać, co
 * się stało, a nie co powinno.
 *
 * Wszystko przez granicę adaptera: zastępnik dostaje prawdziwe `sdkOptions`
 * z prawdziwego `AgentRuntime`, odpala jego hook `PreToolUse` i dopiero potem
 * wykonuje operację na systemie plików.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, AtakPlan>;
let configDir: string;
let realConfigDir: string | undefined;
const realConfigDirAtImport = process.env.CLAUDE_CONFIG_DIR;
const pending: Array<Promise<unknown>> = [];
let seq = 0;

const KANAREK = 'KANAREK-RECENZENTA-z12r4-9b1e';

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

async function atak(
  script: AtakKrok[],
  opts: { honorUpdatedInput?: boolean; onStart?: (runId: string) => void } = {},
) {
  seq += 1;
  const prompt = `proba ataku ${seq}`;
  const handle: AtakUchwyt = newAtakUchwyt();
  plans.set(prompt, { script, handle, honorUpdatedInput: opts.honorUpdatedInput });
  const conversationId = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    title: 'Proby ataku',
  }).id;
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  opts.onStart?.(started.runId);
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  pending.push(started.done.catch(() => undefined), reader);
  await started.done;
  await reader;
  const text = events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => String(e.delta ?? ''))
    .join('');
  if (process.env.ATAK_DUMP) {
    for (const pr of handle.proby) {
      console.log(
        `[DUMP] ${pr.name} denied=${pr.denied} reason=${JSON.stringify(pr.reason)} ` +
          `updatedInput=${JSON.stringify(pr.updatedInput)} opened=${JSON.stringify(pr.opened)} ` +
          `outcome=${JSON.stringify(pr.outcome).slice(0, 400)}`,
      );
    }
  }
  return { proby: handle.proby, ws: handle.workspaceDir ?? '', text };
}

/** Katalog poza workspace z kanarkiem w środku. Sprzątany po teście. */
const poza: string[] = [];
function katalogPoza(nazwa: string): { dir: string; plik: string } {
  const dir = mkdtempSync(join(tmpdir(), `atak-${nazwa}-`));
  poza.push(dir);
  const plik = join(dir, 'sekret.txt');
  writeFileSync(plik, `POZA-WS-${KANAREK}`);
  return { dir, plik };
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'atak-claude-'));
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: KANAREK, subscriptionType: 'max' } }),
  );
  realConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  plans = new Map();
  h = await createHarness({
    withModule: false,
    modelAgent: atakujacyAgent(plans),
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
  for (const d of poza.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* G21: plik logowania użytkownika ma być nietknięty przez te próby. */
const realUserConfigDir = claudeConfigDir({
  ...process.env,
  CLAUDE_CONFIG_DIR: realConfigDirAtImport,
} as NodeJS.ProcessEnv);
const odcisk = (): string => {
  const f = join(realUserConfigDir, '.credentials.json');
  if (!existsSync(f)) return 'brak';
  const st = statSync(f);
  return `${st.size}:${st.mtimeMs}`;
};
const odciskPrzed = odcisk();
afterAll(() => {
  expect(odcisk(), 'plik logowania uzytkownika zmienil sie w trakcie prob ataku').toBe(odciskPrzed);
});

/* ============================ A. ścieżki plikowe ============================ */

describe('A. sciezki plikowe', () => {
  it('A1 kontrola: sciezka bezwzgledna do pliku poswiadczen jest odmowiona', async () => {
    const { proby, text } = await atak([
      { kind: 'tool', name: 'Read', input: { file_path: join(configDir, '.credentials.json') } },
    ]);
    expect(proby[0]?.denied).toBe(true);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('A2 regresja rundy 4: dowiazanie + ".." w srodku nadal odmowione', async () => {
    const { dir } = katalogPoza('a2');
    mkdirSync(join(dir, 'exceljs'), { recursive: true });
    const { proby, text } = await atak([
      { kind: 'symlink', from: join(dir, 'exceljs'), to: 'node_modules/exceljs' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/node_modules/exceljs/../sekret.txt' } },
    ]);
    expect(proby[0]?.denied).toBe(true);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('A3 lancuch trzech dowiazan wyprowadzajacy poza workspace jest odmowiony', async () => {
    const { dir } = katalogPoza('a3');
    const { proby, text } = await atak([
      { kind: 'symlink', from: dir, to: 'ogniwo3' },
      { kind: 'symlink', from: '$ws/ogniwo3', to: 'ogniwo2' },
      { kind: 'symlink', from: '$ws/ogniwo2', to: 'ogniwo1' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/ogniwo1/sekret.txt' } },
    ]);
    expect(proby[0]?.denied).toBe(true);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('A4 ZERWANE dowiazanie na OSTATNIM komponencie: Write TWORZY plik poza workspace', async () => {
    /*
     * `realpathSync` rzuca na dowiazaniu wskazujacym plik, ktorego jeszcze nie
     * ma. `resolvePhysically` traktuje to jak "komponentu nie ma" i doklada
     * reszte LEKSYKALNIE — wiec sciezka wyglada na wewnetrzna, a `open(O_CREAT)`
     * podaza za dowiazaniem i tworzy plik po drugiej stronie.
     */
    const { dir } = katalogPoza('a4');
    const cel = join(dir, 'podrzucony.txt');
    const { proby } = await atak([
      { kind: 'symlink', from: cel, to: 'output/skrot.txt' },
      { kind: 'tool', name: 'Write', input: { file_path: '$ws/output/skrot.txt' }, content: 'PODRZUCONE' },
    ]);
    expect(proby[0]?.denied, 'straznik odmowil (atak nie przeszedl)').toBe(false);
    expect(existsSync(cel), 'POWSTAL PLIK poza workspace przez zerwane dowiazanie na koncu').toBe(true);
  });

  it('A4b kontrola: dowiazanie na koncu do ISTNIEJACEGO pliku poza workspace jest odmowione', async () => {
    const { plik } = katalogPoza('a4b');
    const { proby, text } = await atak([
      { kind: 'symlink', from: plik, to: 'output/skrot.txt' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/output/skrot.txt' } },
    ]);
    expect(proby[0]?.denied).toBe(true);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('A9 ZERWANE dowiazanie w SRODKU sciezki wylacza rozwiazywanie fizyczne dla reszty', async () => {
    const { dir } = katalogPoza('a9');
    const { proby, text } = await atak(
      [
        /* `zerwane` wskazuje katalog, ktorego nie ma — realpath rzuca. */
        { kind: 'symlink', from: join(dir, 'nie-ma-mnie'), to: 'zerwane' },
        { kind: 'symlink', from: dir, to: 'link' },
        { kind: 'tool', name: 'Read', input: { file_path: '$ws/zerwane/../link/sekret.txt' } },
      ],
      { honorUpdatedInput: true },
    );
    expect(proby[0]?.denied, 'straznik odmowil').toBe(false);
    expect(text.includes(KANAREK), 'ODCZYTANO TRESC SPOZA WORKSPACE').toBe(true);
  });

  it('A5 ".." na koncu: poza workspace odmowione, wewnatrz przepuszczone', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/..' } },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/output/..' } },
    ]);
    expect(proby.map((p) => p.denied)).toEqual([true, false]);
  });

  /* ----------------------------- A6: znalezisko ---------------------------- */

  it('A6 NIEISTNIEJACY KOMPONENT + ".." + dowiazanie — straznik przepuszcza i przepisuje wejscie NA SCIEZKE POZA WORKSPACE', async () => {
    /*
     * `resolvePhysically` przełącza się na tryb **leksykalny** w chwili, gdy
     * natrafi na komponent, którego nie ma (`existsSoFar = false`), i już nigdy
     * nie wraca. Dalsze człony są wtedy doklejane BEZ `realpathSync` — więc
     * dowiązanie, które pada za nieistniejącym członem, nie jest rozwijane.
     *
     * `<ws>/nie-ma/../link/sekret.txt`
     *   straznik: nie-ma (brak) -> ".." -> <ws> -> link (bez realpath) ->
     *             <ws>/link/sekret.txt  == WEWNATRZ -> PRZEPUSZCZA
     *   i `resolvedPathInput` PRZEPISUJE wejscie na `<ws>/link/sekret.txt`,
     *   czyli na sciezke, ktora istnieje i wychodzi poza workspace.
     */
    const { dir } = katalogPoza('a6');
    const { proby, text, ws } = await atak(
      [
        { kind: 'symlink', from: dir, to: 'link' },
        { kind: 'tool', name: 'Read', input: { file_path: '$ws/nie-ma/../link/sekret.txt' } },
      ],
      { honorUpdatedInput: true },
    );
    const p = proby[0]!;
    // Zapis wyniku ZAOBSERWOWANEGO.
    expect(p.denied, 'straznik odmowil (atak nie przeszedl)').toBe(false);
    expect(p.updatedInput?.file_path, 'hook przepisal wejscie na sciezke przez dowiazanie').toBe(
      `${ws}/link/sekret.txt`,
    );
    expect(text.includes(KANAREK), 'ODCZYTANO TRESC SPOZA WORKSPACE').toBe(true);
  });

  it('A6b ten sam ksztalt, gdy narzedzie normalizuje leksykalnie (bez updatedInput) — tez przechodzi', async () => {
    const { dir } = katalogPoza('a6b');
    const { proby, text } = await atak(
      [
        { kind: 'symlink', from: dir, to: 'link' },
        {
          kind: 'tool',
          name: 'Read',
          input: { file_path: '$ws/nie-ma/../link/sekret.txt' },
          normalizeBeforeOpen: true,
        },
      ],
      { honorUpdatedInput: false },
    );
    expect(proby[0]?.denied).toBe(false);
    expect(text.includes(KANAREK), 'ODCZYTANO TRESC SPOZA WORKSPACE').toBe(true);
  });

  it('A6c ten sam ksztalt, gdy narzedzie otwiera surowy napis — konczy sie ENOENT (atak NIE przechodzi)', async () => {
    const { dir } = katalogPoza('a6c');
    const { proby, text } = await atak(
      [
        { kind: 'symlink', from: dir, to: 'link' },
        { kind: 'tool', name: 'Read', input: { file_path: '$ws/nie-ma/../link/sekret.txt' } },
      ],
      { honorUpdatedInput: false },
    );
    expect(proby[0]?.denied, 'straznik i tak przepuscil').toBe(false);
    expect(text.includes(KANAREK)).toBe(false);
    expect(proby[0]?.outcome).toMatch(/ENOENT|blad/);
  });

  it('A6d ZAPIS tym samym ksztaltem TWORZY plik poza workspace', async () => {
    const { dir } = katalogPoza('a6d');
    const cel = join(dir, 'podrzucony.txt');
    const { proby } = await atak(
      [
        { kind: 'symlink', from: dir, to: 'link' },
        {
          kind: 'tool',
          name: 'Write',
          input: { file_path: '$ws/nie-ma/../link/podrzucony.txt' },
          content: 'PODRZUCONA-TRESC-RECENZENTA',
        },
      ],
      { honorUpdatedInput: true },
    );
    expect(proby[0]?.denied).toBe(false);
    expect(existsSync(cel), 'POWSTAL PLIK poza katalogiem roboczym').toBe(true);
    expect(readFileSync(cel, 'utf8')).toContain('PODRZUCONA-TRESC-RECENZENTA');
  });

  it('A6e ten sam ksztalt wycelowany w katalog poswiadczen oddaje kanarka', async () => {
    const { proby, text } = await atak(
      [
        { kind: 'symlink', from: configDir, to: 'link' },
        { kind: 'tool', name: 'Read', input: { file_path: '$ws/nie-ma/../link/.credentials.json' } },
      ],
      { honorUpdatedInput: true },
    );
    expect(proby[0]?.denied).toBe(false);
    expect(text.includes(KANAREK), 'KANAREK POSWIADCZENIA W ODPOWIEDZI').toBe(true);
  });

  it('A6f podwykonawca (agent_id) dostaje dokladnie ten sam wynik', async () => {
    const { dir } = katalogPoza('a6f');
    const { proby, text } = await atak(
      [
        { kind: 'symlink', from: dir, to: 'link' },
        {
          kind: 'tool',
          name: 'Read',
          input: { file_path: '$ws/nie-ma/../link/sekret.txt' },
          subagent: true,
        },
      ],
      { honorUpdatedInput: true },
    );
    expect(proby[0]?.denied).toBe(false);
    expect(text.includes(KANAREK)).toBe(true);
  });

  it('A11 BEZ ZADNEGO PRZYGOTOWANIA: odczyt zrodla biblioteki poza workspace przez "nie-ma/.."', async () => {
    /*
     * Zadnego kroku przygotowawczego. Dowiazanie `node_modules/exceljs` tworzy
     * sam `createRunWorkspace`, a jego cel lezy poza katalogiem roboczym.
     * Wystarczy poprzedzic je czlonem, ktorego nie ma — straznik przechodzi
     * wtedy na skladanie leksykalne i juz nie rozwija niczego dalej.
     */
    const { proby, text } = await atak(
      [
        {
          kind: 'tool',
          name: 'Read',
          input: { file_path: '$ws/nie-ma/../node_modules/exceljs/package.json' },
        },
      ],
      { honorUpdatedInput: true },
    );
    expect(proby[0]?.denied, 'straznik odmowil').toBe(false);
    expect(text, 'NIE odczytano zrodla biblioteki spoza workspace').toContain('"name"');
    expect(text).toContain('exceljs');
  });

  it('A11b kontrola: ta sama biblioteka BEZ "nie-ma/.." jest odmowiona', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/node_modules/exceljs/package.json' } },
    ]);
    expect(proby[0]?.denied, 'bez sztuczki straznik odmawia — roznica jest w straznika, nie w celu').toBe(true);
  });

  it('A12 BEZ ZADNEGO PRZYGOTOWANIA: ZAPIS do katalogu biblioteki poza workspace', async () => {
    const nazwa = `podrzucone-recenzenta-${Date.now()}.txt`;
    const { proby, ws } = await atak(
      [
        {
          kind: 'tool',
          name: 'Write',
          input: { file_path: `$ws/nie-ma/../node_modules/exceljs/${nazwa}` },
          content: 'PODRZUCONE-PRZEZ-RECENZENTA',
        },
      ],
      { honorUpdatedInput: true },
    );
    /* Katalog biblioteki ustalony niezaleznie od workspace (ten juz nie istnieje). */
    const prawdziwyKatalog = dirname(createRequire(import.meta.url).resolve('exceljs/package.json'));
    const cel = join(prawdziwyKatalog, nazwa);
    try {
      expect(proby[0]?.denied, 'straznik odmowil').toBe(false);
      expect(
        prawdziwyKatalog.startsWith(`${realnie(ws)}/`),
        `katalog biblioteki lezy w workspace (proba bez sensu): ${prawdziwyKatalog}`,
      ).toBe(false);
      expect(existsSync(cel), `POWSTAL PLIK w katalogu biblioteki POZA workspace: ${cel}`).toBe(true);
    } finally {
      rmSync(cel, { force: true });
    }
  });

  it('A7 tylda na poczatku sciezki', async () => {
    const { proby, text } = await atak([
      { kind: 'tool', name: 'Read', input: { file_path: '~/.claude/.credentials.json' } },
    ]);
    // Zapis obserwacji: czy odmowiono i czy cokolwiek wyciekło.
    expect(text.includes(KANAREK)).toBe(false);
    expect(typeof proby[0]?.denied).toBe('boolean');
  });

  it('A7b tylda, gdy narzedzie ja rozwija samo (HOME podstawiony na atrape)', async () => {
    /*
     * `$HOME` jest na czas tej proby podmieniony na katalog tymczasowy — nigdzie
     * nie dotykamy prawdziwego logowania uzytkownika (G21). Sprawdzany jest
     * ksztalt: straznik nie odmawia sciezce z tylda, tylko przepisuje ja do
     * wnetrza workspace. Jesli SDK nie honoruje `updatedInput`, narzedzie
     * dostaje surowe `~/...` i rozwija je po swojemu.
     */
    const dom = mkdtempSync(join(tmpdir(), 'atak-dom-'));
    poza.push(dom);
    mkdirSync(join(dom, '.claude'), { recursive: true });
    writeFileSync(join(dom, '.claude', '.credentials.json'), `DOM-${KANAREK}`);
    const realHome = process.env.HOME;
    process.env.HOME = dom;
    try {
      const { proby, text } = await atak(
        [
          {
            kind: 'tool',
            name: 'Read',
            input: { file_path: '~/.claude/.credentials.json' },
            tildeBeforeOpen: true,
          },
        ],
        { honorUpdatedInput: false },
      );
      expect(proby[0]?.denied, 'straznik odmowil sciezce z tylda').toBe(false);
      expect(text.includes(KANAREK), 'ODCZYTANO PLIK SPOD $HOME').toBe(true);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it('A8 pusta sciezka omija straznika w calosci (brak sprawdzenia)', async () => {
    const { proby } = await atak([{ kind: 'tool', name: 'Read', input: { file_path: '' } }]);
    expect(proby[0]?.denied, 'straznik pominal pusty napis bez sprawdzenia').toBe(false);
    expect(proby[0]?.updatedInput, 'nic nie przepisano').toBe(null);
  });

  it('A10 WYSCIG: dowiazanie podmienione po sprawdzeniu, przed otwarciem', async () => {
    const { dir } = katalogPoza('a10');
    const { proby, text } = await atak(
      [
        { kind: 'mkdir', path: 'niewinny' },
        { kind: 'symlink', from: '$ws/niewinny', to: 'link' },
        {
          kind: 'tool',
          name: 'Read',
          input: { file_path: '$ws/link/sekret.txt' },
          swapBeforeOpen: { link: 'link', to: dir },
        },
      ],
      { honorUpdatedInput: true },
    );
    // Wynik obserwowany: czy przepisanie wejścia zamyka okno wyścigu.
    expect(proby[0]?.denied).toBe(false);
    expect(text.includes(KANAREK), 'wyscig oddal tresc spoza workspace mimo przepisania wejscia').toBe(false);
  });

  it('A10b WYSCIG bez przepisania wejscia (zastepnik autora) — okno jest otwarte', async () => {
    const { dir } = katalogPoza('a10b');
    const { proby, text } = await atak(
      [
        { kind: 'mkdir', path: 'niewinny' },
        { kind: 'symlink', from: '$ws/niewinny', to: 'link' },
        {
          kind: 'tool',
          name: 'Read',
          input: { file_path: '$ws/link/sekret.txt' },
          swapBeforeOpen: { link: 'link', to: dir },
        },
      ],
      { honorUpdatedInput: false },
    );
    expect(proby[0]?.denied).toBe(false);
    expect(text.includes(KANAREK), 'WYSCIG ODDAL TRESC SPOZA WORKSPACE').toBe(true);
  });
});

/* ============================== B. wzorce ================================== */

describe('B. wzorce Glob/Grep', () => {
  it('B1 Glob: klamra "{..,.}" omija regule o czlonie ".." i wychodzi w gore', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Glob', input: { path: '$ws/output', pattern: '{..,.}/**' } },
    ]);
    expect(proby[0]?.denied, 'wzorzec z klamra zostal odmowiony').toBe(false);
    expect(proby[0]?.outcome, 'rozwiniecie wzorca NIE wyszlo poza katalog').toContain('..');
  });

  it('B2 Glob: wzorzec BEZWZGLEDNY nie jest sprawdzany w ogole', async () => {
    const { dir } = katalogPoza('b2');
    const { proby } = await atak([
      { kind: 'tool', name: 'Glob', input: { path: '$ws/output', pattern: `${dir}/*.txt` } },
    ]);
    expect(proby[0]?.denied, 'wzorzec bezwzgledny zostal odmowiony').toBe(false);
    expect(proby[0]?.outcome, 'glob NIE wylistowal pliku spoza workspace').toContain('sekret.txt');
  });

  it('B3 kontrola: Glob z czlonem ".." jest odmowiony', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Glob', input: { path: '$ws/output', pattern: '../../**' } },
    ]);
    expect(proby[0]?.denied).toBe(true);
  });

  it('B4 Grep: klamra w "glob" oddaje TRESC pliku spoza workspace', async () => {
    const { dir } = katalogPoza('b4');
    const { proby } = await atak([
      { kind: 'mkdir', path: 'output' },
      { kind: 'symlink', from: dir, to: 'biblioteka' },
      {
        kind: 'tool',
        name: 'Grep',
        input: { path: '$ws/.', glob: '{..,.}/biblioteka/*.txt', pattern: 'KANAREK' },
      },
    ]);
    expect(proby[0]?.denied, 'wzorzec z klamra zostal odmowiony').toBe(false);
    expect(proby[0]?.outcome, 'Grep NIE oddal tresci spoza workspace').toContain(KANAREK);
  });

  it('B5 ZWYKLY wzorzec Grep w katalogu roboczym czyta przez dowiazania, ktore tworzy sam createRunWorkspace', async () => {
    /*
     * Bez `..`, bez klamry, bez sciezki bezwzglednej. `path` jest wewnatrz
     * workspace, `glob` nie ma czlonu `..` — obie reguly milcza. Rozwiniecie
     * wzorca podaza za dowiazaniem katalogowym i czyta tresc spoza workspace.
     */
    const { dir } = katalogPoza('b5');
    const { proby } = await atak([
      { kind: 'symlink', from: dir, to: 'node_modules/biblioteka' },
      { kind: 'tool', name: 'Grep', input: { path: '$ws/.', glob: '**/*', pattern: 'KANAREK' } },
    ]);
    expect(proby[0]?.denied, 'zwykly wzorzec zostal odmowiony').toBe(false);
    expect(proby[0]?.outcome, 'Grep NIE oddal tresci spoza workspace').toContain(KANAREK);
  });

  it('B6 Glob ze zwyklym wzorcem wypisuje sciezki spoza workspace', async () => {
    const { dir } = katalogPoza('b6');
    const { proby } = await atak([
      { kind: 'symlink', from: dir, to: 'node_modules/biblioteka' },
      { kind: 'tool', name: 'Glob', input: { path: '$ws/.', pattern: '**/*' } },
    ]);
    expect(proby[0]?.denied).toBe(false);
    expect(proby[0]?.outcome).toContain('biblioteka/sekret.txt');
  });

  it('B8 BEZ ZADNEGO PRZYGOTOWANIA: Grep czyta zrodla biblioteki toolkitu spoza workspace', async () => {
    /*
     * Zero krokow przygotowawczych. `createRunWorkspace` sam linkuje biblioteki
     * toolkitu do `node_modules/`, a ich prawdziwe sciezki leza poza katalogiem
     * roboczym. `path` jest wewnatrz, `glob` nie ma czlonu `..` — obie reguly
     * milcza, a tresc plikow spoza workspace trafia do odpowiedzi.
     *
     * To jest dokladnie ta droga, o ktorej `permissions.ts` pisze, ze jest
     * zamknieta: „reading a library's source through `Read` is refused by this
     * rule". Przez `Grep` nie jest.
     */
    const { proby } = await atak([
      { kind: 'tool', name: 'Grep', input: { path: '$ws/.', glob: '**/*', pattern: 'Copyright|MIT|exceljs' } },
    ]);
    expect(proby[0]?.denied, 'zwykly Grep zostal odmowiony').toBe(false);
    expect(proby[0]?.outcome, 'Grep NIE siegnal zrodel biblioteki').toContain('node_modules/exceljs');
  });

  it('B7 Glob bez "path" — sam wzorzec bezwzgledny do katalogu poswiadczen', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Glob', input: { pattern: `${configDir}/.*` } },
    ]);
    expect(proby[0]?.denied, 'odmowiono wzorca bezwzglednego bez "path"').toBe(false);
    expect(proby[0]?.outcome).toContain('.credentials.json');
  });
});

/* ====================== C. narzędzia platformy (MCP) ======================= */

describe('C. narzedzia platformy', () => {
  it('C1 publikacja artefaktu tym samym ksztaltem co A6', async () => {
    const entries = collectToolEntries({
      registry: h.platform.registry,
      platformTools: platformTools(h.platform.services),
    });
    const publish = entries.find((t) => t.localName === 'artifact_publish_file');
    expect(publish, 'brak narzedzia artifact_publish_file').toBeTruthy();
    const { dir } = katalogPoza('c1');
    const ws = createRunWorkspace(join(h.dataDir, 'workspaces'), 'run_atak_c1');
    try {
      symlinkSync(dir, join(ws.outputDir, 'link'));
      const ctx = {
        ownerId: h.ownerId,
        conversationId: null,
        runId: 'run_atak_c1',
        workspaceDir: ws.dir,
        emit: () => {},
        requestUi: async () => ({ executed: false, reason: 'brak klienta' }),
      } as any;
      const outcome = await invokeTool(
        publish!,
        { path: 'nie-ma/../link/sekret.txt', title: 'Podrzucone', operationId: `atak-c1-${Date.now()}` },
        ctx,
      );
      const tekst = outcome.content.map((c: any) => c.text).join('');
      if (process.env.ATAK_DUMP) console.log(`[DUMP] publish isError=${outcome.isError} tekst=${tekst}`);
      // Wynik obserwowany — tresc bledu jest czescia dowodu.
      /*
       * Wynik ZAOBSERWOWANY: publikacja NIE zostala odrzucona i artefakt
       * powstal z pliku lezacego poza workspace — ta sama droga co w A6,
       * tyle ze przez narzedzie MCP i `resolveInWorkspace`.
       */
      expect(outcome.isError === true, `publikacja odrzucona: ${tekst}`).toBe(false);
      const fileId = String(JSON.parse(tekst).fileId);
      const bytes = h.platform.services.files.read(fileId, h.ownerId).bytes.toString('utf8');
      expect(bytes.includes(KANAREK), 'ARTEFAKT DO POBRANIA zawiera tresc spoza workspace').toBe(true);
    } finally {
      ws.dispose();
    }
  });
});

/* ============ D. bramka zgody i narzędzia bez zadeklarowanej ścieżki ======== */

const czekaj = async (warunek: () => boolean, ms = 3000) => {
  const koniec = Date.now() + ms;
  while (Date.now() < koniec) {
    if (warunek()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return warunek();
};

describe('D. bramka zgody', () => {
  it('D1 narzedzie z ODMIENNIE nazwanym polem sciezki: obie reguly milcza, decyduje wylacznie zgoda', async () => {
    /*
     * `MultiEdit` nie ma wpisu w `PATH_ARGUMENTS`, wiec ani hook, ani bramka nie
     * patrza na jego `file_path`. Jedyne, co stoi miedzy modelem a plikiem poza
     * katalogiem roboczym, to odpowiedz uzytkownika — i gdy pada „tak", zapis
     * dochodzi do skutku. To jest „pytanie, nie ochrona" w postaci wykonanej.
     */
    const { dir } = katalogPoza('d1');
    const cel = join(dir, 'przez-bramke.txt');
    let runId = '';
    const zadanie = atak([{ kind: 'gate', name: 'MultiEdit', input: { file_path: cel } }], {
      onStart: (id) => {
        runId = id;
      },
    });
    await czekaj(() => runId !== '' && runtime.pendingPermissionIds().length > 0);
    const ids = runtime.pendingPermissionIds();
    expect(ids.length, 'bramka NIE zapytala — decyzja zapadla bez zgody').toBe(1);
    for (const requestId of ids) {
      runtime.answerPermission({ runId, ownerId: h.ownerId, requestId, allow: true });
    }
    const { proby } = await zadanie;
    expect(proby[0]?.gate?.behavior, 'bramka nie przepuscila po zgodzie').toBe('allow');
    expect(existsSync(cel), 'POWSTAL PLIK poza workspace po zgodzie uzytkownika').toBe(true);
  });

  it('D2 kontrola: znane narzedzie celujace poza workspace jest przez bramke ODMOWIONE bez pytania', async () => {
    const { dir } = katalogPoza('d2');
    const { proby } = await atak([
      { kind: 'gate', name: 'Write', input: { file_path: join(dir, 'nie-powstanie.txt') } },
    ]);
    expect(proby[0]?.gate?.behavior).toBe('deny');
    expect(existsSync(join(dir, 'nie-powstanie.txt'))).toBe(false);
  });
});
