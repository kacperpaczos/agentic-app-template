import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, claudeConfigDir, collectToolEntries, platformTools } from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';
import {
  atakujacyAgent,
  newAtakUchwyt,
  type AtakKrok,
  type AtakPlan,
  type AtakUchwyt,
} from './support/attack-standin.ts';

/**
 * PRÓBY ATAKU RECENZENTA — runda 6 (gałąź `przeglad/z12-r6`).
 *
 * Atakuje NOWE decyzje rundy 6: fail-closed walkera (`UnresolvablePathError`),
 * budżetowany pre-walk Glob/Grep, `readlink` dla zerwanych dowiązań, filtr
 * `declaresPathArguments`. Zastrzeżenie jak w rundzie 4: rozwinięcie wzorców
 * robi `fs.globSync`, nie prawdziwe narzędzie SDK; to, co mierzę, to **odmowa
 * albo jej brak po stronie strażnika** i skutek na systemie plików.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, AtakPlan>;
let configDir: string;
let realConfigDir: string | undefined;
const realConfigDirAtImport = process.env.CLAUDE_CONFIG_DIR;
const pending: Array<Promise<unknown>> = [];
let seq = 0;

const KANAREK = 'KANAREK-RECENZENTA-z12r6-4d7a';

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
  opts: {
    honorUpdatedInput?: boolean;
    /** Wywołane po `runtime.start`, gdy workspace już istnieje (runId znany). */
    onStart?: (runId: string) => void;
  } = {},
): Promise<{ proby: AtakUchwyt['proby']; ws: string; text: string }> {
  seq += 1;
  const prompt = `proba ataku r6 ${seq}`;
  const handle: AtakUchwyt = newAtakUchwyt();
  plans.set(prompt, { script, handle, honorUpdatedInput: opts.honorUpdatedInput });
  const conversationId = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    title: 'Proby ataku r6',
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
  return { proby: handle.proby, ws: handle.workspaceDir ?? '', text };
}

/** Jak `atak`, ale łapie odrzucenie przebiegu (rzut z hooka) zamiast padać. */
async function atakLapiacRzut(
  script: AtakKrok[],
  opts: { honorUpdatedInput?: boolean } = {},
): Promise<{ rzut: Error | null; wynik: Awaited<ReturnType<typeof atak>> | null }> {
  try {
    return { rzut: null, wynik: await atak(script, opts) };
  } catch (err) {
    return { rzut: err as Error, wynik: null };
  }
}

const poza: string[] = [];
function katalogPoza(nazwa: string, pliki: Array<[string, string]> = [['sekret.txt', `POZA-WS-${KANAREK}`]]) {
  const dir = mkdtempSync(join(tmpdir(), `atak6-${nazwa}-`));
  poza.push(dir);
  for (const [nazwa2, tresc] of pliki) writeFileSync(join(dir, nazwa2), tresc);
  return dir;
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'atak6-claude-'));
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

describe('W. nowe kształty rundy 6', () => {
  it('W1 tylda WE WZORCU Glob nie jest odmawiana (zasada "odmawiam czego nie umiem rozwinac" nie obejmuje wzorca)', async () => {
    // path = $ws/output: czyste poddrzewo, żeby odmowa (jeśli jest) wynikała
    // z samego wzorca, a nie z pre-walka node_modules. Bez `path` Glob/Grep
    // jest i tak odrzucany w całości — pre-walk trafia na dowiązania
    // bibliotek (zaobserwowane; patrz raport).
    const { proby } = await atak([
      { kind: 'tool', name: 'Glob', input: { path: '$ws/output', pattern: '~/.claude/*' } },
    ]);
    // Obserwacja: strażnik nie odmawia wzorca z tyldą.
    expect(proby[0]?.denied, 'wzorzec z tylda zostal odmowiony (niespodziewanie)').toBe(false);
    // Narzędzie zastępnika rozwija wzorzec względem cwd=workspace; tylda jest
    // literałem — brak wycieku W ZASTĘPCZYKU. Semantyka prawdziwego Glob SDK
    // (czy rozwija ~) nie jest tu mierzona — wymaga tury modelu.
    expect(proby[0]?.outcome).not.toContain('.credentials.json');
  });

  it('W2 budzet glebokosci: drzewo 17 poziomow pod start = odmowa, 16 poziomow = przepuszczone', async () => {
    const kroki: AtakKrok[] = [];
    const skladaj = (prefiks: string, n: number) => {
      let p = prefiks;
      for (let i = 1; i <= n; i += 1) {
        p = `${p}/p${i}`;
        kroki.push({ kind: 'mkdir', path: p });
      }
      return p;
    };
    skladaj('glebokie', 17);
    skladaj('plytkie', 16);
    // Oba Globy w JEDNYM przebiegu (ten sam workspace).
    const { proby } = await atak([
      ...kroki,
      { kind: 'tool', name: 'Glob', input: { path: '$ws/glebokie', pattern: '**/*' } },
      { kind: 'tool', name: 'Glob', input: { path: '$ws/plytkie', pattern: '**/*' } },
    ]);
    expect(proby[0]?.denied, 'strażnik NIE odmówił drzewa głębszego niż 16').toBe(true);
    expect(proby[0]?.reason ?? '').toContain('glebsze');
    expect(proby[1]?.denied, 'budżet głębokości oblewa zwykłe drzewo 16 poziomów').toBe(false);
  });

  it('W3 budzet wpisow: 20001 wpisow = odmowa (fail-closed), dokladnie 20000 = przepuszczone', async () => {
    const przygotuj = (runId: string, ileBudzet: number, ileGranica: number) => {
      // Workspace powstaje w runtime.start, zanim start() wróci — runId znany.
      const ws = join(h.platform.services.config.workspacesDir, runId);
      const budzet = join(ws, 'budzet');
      const granica = join(ws, 'granica');
      mkdirSync(budzet, { recursive: true });
      mkdirSync(granica, { recursive: true });
      for (let i = 0; i < ileBudzet; i += 1) writeFileSync(join(budzet, `f${i}.txt`), 'x');
      for (let i = 0; i < ileGranica; i += 1) writeFileSync(join(granica, `f${i}.txt`), 'x');
    };
    const pierwszy = await atak([{ kind: 'text', text: 'sonda' }], {
      onStart: (runId) => przygotuj(runId, 20001, 0),
    });
    expect(pierwszy.ws).not.toBe('');

    const { proby } = await atak(
      [{ kind: 'tool', name: 'Grep', input: { path: '$ws/budzet', glob: '**/*', pattern: 'NIGDZIE' } }],
      { onStart: (runId) => przygotuj(runId, 20001, 20000) },
    );
    expect(proby[0]?.denied, 'strażnik NIE odmówił po przekroczeniu budżetu').toBe(true);
    expect(proby[0]?.reason ?? '').toContain('20000');
    expect(proby[0]?.outcome, 'wynik nie może być częściowym przeszukaniem').toBe('');

    const { proby: proby2 } = await atak(
      [{ kind: 'tool', name: 'Grep', input: { path: '$ws/granica', glob: '**/*', pattern: 'NIGDZIE' } }],
      { onStart: (runId) => przygotuj(runId, 0, 20000) },
    );
    expect(proby2[0]?.denied, 'budżet oblewa drzewo dokładnie na granicy').toBe(false);
  });

  it('W4 WYSCIG na PRE-WALKU: dowiązanie KATALOGOWE podmienione po przejściu drzewa, przed rozwinięciem wzorca — treść spoza workspace', async () => {
    const dir = katalogPoza('w4');
    // deep/sub jest dowiązaniem WEWNĄTRZ workspace w chwili walka.
    const { proby, text } = await atak([
      { kind: 'mkdir', path: 'deep/niewinny' },
      { kind: 'symlink', from: '$ws/deep/niewinny', to: 'deep/sub' },
      {
        kind: 'tool',
        name: 'Grep',
        input: { path: '$ws/deep', glob: '**/*', pattern: 'KANAREK' },
        swapBeforeOpen: { link: 'deep/sub', to: dir },
      },
    ]);
    // Walk widzi dowiązanie wewnątrz → przepuszczone; podmiana PO walku,
    // PRZED rozwinięciem → grep czyta spoza workspace (updatedInput honorowane —
    // przepisanie obejmuje argument path, nie zawartość drzewa).
    expect(proby[0]?.denied, 'strażnik odmówił mimo że w chwili walka było wewnątrz').toBe(false);
    expect(text.includes(KANAREK), 'WYSCIG NA PRE-WALKU ODDAL TREŚĆ SPOZA WORKSPACE').toBe(true);
  });

  it('W4b kontrola W4: ta sama scena BEZ podmiany nie daje treści spoza workspace', async () => {
    const dir = katalogPoza('w4b');
    expect(existsSync(join(dir, 'sekret.txt'))).toBe(true);
    const { proby, text } = await atak([
      { kind: 'mkdir', path: 'deep/niewinny' },
      { kind: 'symlink', from: '$ws/deep/niewinny', to: 'deep/sub' },
      { kind: 'tool', name: 'Grep', input: { path: '$ws/deep', glob: '**/*', pattern: 'KANAREK' } },
    ]);
    expect(proby[0]?.denied).toBe(false);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('W5 przepisanie wejscia zamyka wyścig na ARGUNCIE path (link podmieniony po sprawdzeniu)', async () => {
    const dir = katalogPoza('w5');
    const { proby, text } = await atak(
      [
        { kind: 'mkdir', path: 'niewinny' },
        { kind: 'symlink', from: '$ws/niewinny', to: 'link' },
        {
          kind: 'tool',
          name: 'Glob',
          input: { path: '$ws/link', pattern: '**/*' },
          swapBeforeOpen: { link: 'link', to: dir },
        },
      ],
      { honorUpdatedInput: true },
    );
    expect(proby[0]?.denied).toBe(false);
    // Przepisana ścieżka wskazuje na wewnętrzny `niewinny` — wycieku nie ma.
    expect(text.includes(KANAREK), 'przepisanie argumentu nie zamknęło wyścigu na argumencie').toBe(false);
    expect(String(proby[0]?.updatedInput?.path ?? ''), 'przepisana ścieżka ma być wewnętrzna').toContain(
      '/niewinny',
    );
  });

  it('W6 lancuch zerwane->dowiazanie->istnieje, z dowiazaniem wzglednym w srodku: odmowa', async () => {
    const dir = katalogPoza('w6');
    // b1 -> b2 (względne, w środku łańcucha), b2 -> katalog poza workspace.
    // `sekret.txt` istnieje, więc bez `readlink`-owej ekspansji łańcucha
    // kształt wyglądałby na "istniejący cel" i mógłby pójść na ALLOW.
    const { proby, text } = await atak([
      { kind: 'symlink', from: 'b2', to: 'b1' },
      { kind: 'symlink', from: dir, to: 'b2' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/b1/sekret.txt' } },
    ]);
    expect(proby[0]?.denied, 'strażnik NIE odmówił łańcucha z dowiązaniem względnym').toBe(true);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('W7 komunikaty odmowy rozróżniają istnienie pliku POZA workspace — wyrocznia istnienia przez UnresolvablePathError', async () => {
    // etclink -> /etc (przygotowanie jak w próbach A3/A4: dowiązanie w workspace).
    const { proby } = await atak([
      { kind: 'symlink', from: '/etc', to: 'etclink' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/etclink/passwd/x' } },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/etclink/nie-ma-takiego-pliku-4d7a/x' } },
    ]);
    const istniejacy = proby[0]!;
    const nieistniejacy = proby[1]!;
    expect(istniejacy.denied).toBe(true);
    expect(nieistniejacy.denied).toBe(true);
    // Oba odrzucone, ale komunikaty POZWALAJĄ rozróżnić, czy /etc/passwd
    // istnieje i jest plikiem — informacja o systemie plików poza workspace.
    expect(istniejacy.reason ?? '').toContain('nie jest katalogiem');
    expect(istniejacy.reason ?? '').toContain('passwd');
    expect(nieistniejacy.reason ?? '').not.toContain('nie jest katalogiem');
    expect(nieistniejacy.reason ?? '').toContain('katalogu roboczego');
  });

  it('W8 odmowa UnresolvablePathError jest widoczna w strumieniu zdarzeń (dowód nie znika)', async () => {
    const dir = katalogPoza('w8');
    const { text } = await atak([
      { kind: 'symlink', from: dir, to: 'link' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/nie-ma/../link/sekret.txt' } },
    ]);
    expect(text, 'brak śladu odmowy w strumieniu').toContain('odmowa');
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('W9 komponent dluzszy niz NAME_MAX: rzut z hooka pada jako błąd strumienia — odmowy brak w dowodzie, otwarcia też', async () => {
    const dlugi = 'a'.repeat(300);
    const { rzut, wynik } = await atakLapiacRzut([
      { kind: 'tool', name: 'Read', input: { file_path: `$ws/${dlugi}/x.txt` } },
    ]);
    expect(rzut ?? wynik).toBeTruthy();
    if (rzut) {
      // Gałąź awaryjna: przebieg odrzucony w całości.
      expect(String(rzut.message ?? '')).toMatch(/ENAMETOOLONG|too long/i);
    } else {
      // ZAOBSERWOWANA gałąź: runtime zamienił rzut hooka na błąd strumienia —
      // żadna próba nie jest zapisana, ale i żadne otwarcie nie nastąpiło
      // (jądro odmówiłoby ENAMETOOLONG).
      const proba = wynik!.proby[0];
      expect(
        proba === undefined || proba.denied || /blad/.test(proba.outcome),
        'rzut zamienił się na udane otwarcie',
      ).toBe(true);
      expect(wynik!.proby, 'rzut został zapisany jako próba (niespodziewanie)').toHaveLength(0);
    }
  });

  it('W10 NotebookEdit ma deklarację ścieżki: hook odmawia poza workspace mimo braku auto-zatwierdzenia', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'NotebookEdit', input: { notebook_path: '$ws/../atak-notebook.ipynb' } },
    ]);
    expect(proby[0]?.denied, 'hook nie sprawdził notebook_path').toBe(true);
    // Kontrola: wewnątrz workspace przepuszczone.
    const { proby: proby2 } = await atak([
      { kind: 'tool', name: 'NotebookEdit', input: { notebook_path: '$ws/nb.ipynb' } },
    ]);
    expect(proby2[0]?.denied).toBe(false);
  });

  it('W11 bramka: NotebookEdit poza workspace jest ODMAWIANA bez pytania (nie tylko w hooku)', async () => {
    const { proby, ws } = await atak([
      { kind: 'gate', name: 'NotebookEdit', input: { notebook_path: '$ws/../atak-notebook2.ipynb' } },
    ]);
    const proba = proby[0]!;
    expect(proba.denied, 'bramka przepuściła NotebookEdit poza workspace').toBe(true);
    expect(ws).not.toBe('');
    expect(existsSync(join(ws, '..', 'atak-notebook2.ipynb')), 'plik powstał poza workspace').toBe(false);
  });

  it('W12 pusty wzorzec Glob i pusty glob Grep są odmawiane (twierdzenie rundy 6)', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Glob', input: { path: '$ws', pattern: '' } },
      { kind: 'tool', name: 'Grep', input: { path: '$ws', glob: '', pattern: 'x' } },
    ]);
    expect(proby[0]?.denied, 'pusty pattern nie odmówiony').toBe(true);
    expect(proby[1]?.denied, 'pusty glob nie odmówiony').toBe(true);
  });

  it('W13 pole sciezki w INNEJ pisowni (camelCase) omija obie reguly — narzędzie zastępnika nie otwiera nic', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Read', input: { filePath: '$ws/../poza-camel.txt' } },
    ]);
    expect(proby[0]?.denied, 'camelCase został odmówiony (niespodziewanie)').toBe(false);
    expect(String(proby[0]?.opened ?? ''), 'camelCase dotarł do otwarcia').toBe('');
    expect(proby[0]?.outcome).toMatch(/blad/);
  });

  it('W14 path jako null omija reguły (skip), zastępnik domyśla się workspace — brak wycieku', async () => {
    const dir = katalogPoza('w14');
    const { proby } = await atak([
      {
        kind: 'tool',
        name: 'Glob',
        input: { path: null, pattern: '**/*' } as unknown as Record<string, unknown>,
      },
    ]);
    expect(proby[0]?.denied, 'null-path odmówiony (niespodziewanie)').toBe(false);
    expect(proby[0]?.outcome).not.toContain('sekret.txt');
    expect(dir).toBeTruthy();
  });

  it('W15 lancuch 41 dowiazan: walker odmawia limitem zanim jadro zglosi ELOOP — fail-closed', async () => {
    const dir = katalogPoza('w15');
    const kroki: AtakKrok[] = [];
    for (let i = 1; i < 41; i += 1) kroki.push({ kind: 'symlink', from: `c${i + 1}`, to: `c${i}` });
    kroki.push({ kind: 'symlink', from: dir, to: 'c41' });
    kroki.push({ kind: 'tool', name: 'Read', input: { file_path: '$ws/c1/sekret.txt' } });
    const { proby, text } = await atak(kroki);
    expect(proby[0]?.denied, 'łańcuch 41 dowiązań nie odmówiony').toBe(true);
    expect(text.includes(KANAREK)).toBe(false);
  });

  it('W16 istniejacy plik, za nim czlony (kształt ENOTDIR): odmowa bez probowania', async () => {
    const { proby } = await atak([
      { kind: 'tool', name: 'Write', input: { file_path: '$ws/plik.txt' }, content: 'istnieje' },
      { kind: 'tool', name: 'Read', input: { file_path: '$ws/plik.txt/daleko.txt' } },
    ]);
    expect(proby[0]?.denied).toBe(false);
    expect(proby[1]?.denied, 'człony za istniejącym plikiem nie odmówione').toBe(true);
    expect(proby[1]?.reason ?? '').toContain('nie jest katalogiem');
  });
});
