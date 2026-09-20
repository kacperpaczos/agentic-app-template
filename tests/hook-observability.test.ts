import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, collectToolEntries, platformTools } from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';
import { realResolve } from '../packages/platform-server/src/util/real-path.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type StandInHandle, type Step } from './support/model-standin.ts';

/**
 * Czy most hookow w `runtime.ts` zapisuje do strumienia zdarzen **kazde**
 * wywolanie narzedzia plikowego.
 *
 * ## Po co to istnieje — i dlaczego nie kosztuje tury
 *
 * W turze 17 model napisal o pliku bazy: *„1: ODCZYTANE (narzedzie dotarlo do
 * pliku; odmowa dotyczyla tylko formatu binarnego, nie dostepu)"*, a w
 * strumieniu zdarzen tamtego przebiegu **nie ma zadnego `Read` na bazie** — ani
 * udanego, ani odrzuconego (`docs/evidence/z11-bl03/runs/2026-09-19T11-09-53-315Z/`).
 * Hipotezy sa dwie:
 *
 *  (a) model zmyslil te linie — wtedy obserwowalnosc jest czysta;
 *  (b) wywolanie bylo, a nie trafilo do strumienia — wtedy jest to **wada
 *      obserwowalnosci**, i powazniejsza, bo znaczy, ze odmowy tez nikt by nie
 *      zobaczyl, czyli ze caly dowod tego pakietu jest wart mniej, niz sie
 *      wydaje.
 *
 * Rozdziela je proba, nie lektura. W turze 17 narzedzia plikowe byly
 * auto-zatwierdzone (luka L11.4), wiec wywolanie nie moglo zniknac „na zgodzie":
 * albo zostaloby wykonane i zapisane, albo odrzucone przez straznika i zapisane
 * jako odmowa. Wystarczy wiec pokazac na stand-inie, ze most zapisuje wszystkie
 * trzy zakonczenia — auto-zatwierdzone, odrzucone i bledne — oraz **gdzie
 * dokladnie przestaje zapisywac**, jesli gdziekolwiek przestaje.
 *
 * **Rodzaj dowodu: symulacja**, i nic tu nie domyka kryterium BL-03. Model jest
 * zastapiony na granicy `ModelAgentLike`; cala reszta — most hookow, strumien
 * zdarzen, rejestr uruchomien — jest prawdziwa. To, ze prawdziwe SDK naprawde
 * wola `PreToolUse` i `PostToolUse` dla wbudowanego `Read`, jest widoczne w
 * dowodzie tury 17: tamten `Read` kanarka ma w strumieniu i nazwe, i argumenty,
 * i wynik, a jedynym kodem w platformie, ktory zapisuje wynik narzedzia, jest
 * galaz `PostToolUse` tego mostu.
 *
 * ## Co ta proba potrafi obalic
 *
 * Kazdy przypadek ma kontrole przeciwna w tym samym pliku: wywolanie, ktorego
 * nie bylo, **nie moze** sie w strumieniu pojawic (inaczej asercje ponizej sa
 * puste), a jedna z galezi mostu naprawde gubi wywolania — i test to nazywa,
 * zamiast zaliczyc sie na pozostalych.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
let workDir: string;
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

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

interface Recorded {
  events: Array<Record<string, any>>;
  stand: StandInHandle;
  runId: string;
}

async function startRun(script: Step[]): Promise<Recorded> {
  promptSeq += 1;
  const prompt = `polecenie obserwowalnosci ${promptSeq}`;
  const handle: StandInHandle = newStandInHandle();
  plans.set(prompt, { script, handle });
  const conversationId = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    title: 'Obserwowalnosc',
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
  return { events, stand: handle, runId: started.runId };
}

/**
 * Wywolania narzedzi zlozone ze strumienia **tak samo, jak sklada je dowod**.
 *
 * Celowo ta sama konstrukcja, co `toolCalls` w `e2e/support/bl03-checks.ts`:
 * pytanie brzmi „czy czytelnik dowodu to zobaczy", a nie „czy zdarzenie
 * gdziekolwiek jest". Czytelnik dowodu widzi wylacznie to, co da sie zlozyc po
 * `toolCallId`.
 */
interface SeenCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  ended: boolean;
  result: string | null;
  isError: boolean;
}

function seenCalls(events: Array<Record<string, any>>): SeenCall[] {
  const byId = new Map<string, SeenCall>();
  for (const e of events) {
    const id = e.toolCallId as string | undefined;
    if (!id) continue;
    const entry = byId.get(id) ?? { id, name: '', args: null, ended: false, result: null, isError: false };
    if (e.type === 'TOOL_CALL_START') entry.name = String(e.toolCallName ?? '');
    if (e.type === 'TOOL_CALL_ARGS') {
      try {
        entry.args = JSON.parse(String(e.delta ?? '{}'));
      } catch {
        entry.args = null;
      }
    }
    if (e.type === 'TOOL_CALL_END') entry.ended = true;
    if (e.type === 'TOOL_CALL_RESULT') {
      entry.result = String(e.content ?? '');
      entry.isError = e.isError === true;
    }
    byId.set(id, entry);
  }
  return [...byId.values()];
}

const pathOf = (call: SeenCall): string =>
  String((call.args as { file_path?: string; path?: string } | null)?.file_path ?? (call.args as { path?: string } | null)?.path ?? '');

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'most-hookow-'));
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
  rmSync(workDir, { recursive: true, force: true });
});

describe('most hookow a strumien zdarzen — narzedzia plikowe', () => {
  it('auto-zatwierdzone wywolanie jest w strumieniu z nazwa, argumentami i wynikiem', async () => {
    /*
     * Runda 6: reguła pozytywna ogranicza narzędzia plikowe do katalogu
     * roboczego uruchomienia, więc czytany plik jest tworzony WEWNĄTRZ
     * workspace krokiem `writeOutput`. Intencja testu — obserwowalność
     * auto-zatwierdzonego wywołania — bez zmian.
     */
    const { events, stand, runId: recorded } = await startRun([
      { kind: 'writeOutput', path: 'zwykly.txt', content: 'zwykla tresc robocza' },
      { kind: 'fileTool', name: 'Read', input: { file_path: '$workspace/output/zwykly.txt' } },
      { kind: 'text', text: 'Koniec.' },
    ]);

    // Wywolanie naprawde bylo i naprawde nie zostalo odrzucone — inaczej ten
    // test mowilby o odmowie, a nie o auto-zatwierdzeniu.
    expect(stand.fileTools).toEqual([expect.objectContaining({ name: 'Read', denied: false })]);

    const calls = seenCalls(events);
    expect(calls, 'auto-zatwierdzone wywolanie nie trafilo do strumienia zdarzen').toHaveLength(1);
    expect(calls[0]!.name).toBe('Read');
    /*
     * Runda 6: ścieżka po rozwinięciu `$workspace/` przez zastępnik. Oczekiwana
     * wartość liczona `realResolve`-em od katalogu roboczego uruchomienia —
     * pełne porównanie, nie sufiks (recenzja rundy 6: suffiks przepuszcza
     * rozjazd „sprawdzono A, otwarto B").
     */
    const wsDir = join(h.platform.config.workspacesDir, recorded);
    expect(pathOf(calls[0]!), 'strumien nie niesie sciezki, ktorej dotyczylo wywolanie').toBe(
      realResolve(join(wsDir, 'output/zwykly.txt')),
    );
    expect(calls[0]!.ended).toBe(true);
    expect(calls[0]!.result, 'wynik auto-zatwierdzonego wywolania nie trafil do strumienia').toContain(
      'zwykla tresc robocza',
    );
    expect(calls[0]!.isError).toBe(false);
  });

  it('wywolanie odrzucone przez straznika jest w strumieniu, z widoczna odmowa', async () => {
    const chroniony = join(h.platform.config.dataDir, 'app.db');

    const { events, stand } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: chroniony } },
      { kind: 'text', text: 'Koniec.' },
    ]);

    expect(stand.fileTools).toEqual([expect.objectContaining({ name: 'Read', denied: true })]);

    const calls = seenCalls(events);
    expect(calls, 'odrzucone wywolanie nie trafilo do strumienia zdarzen').toHaveLength(1);
    expect(calls[0]!.name).toBe('Read');
    expect(pathOf(calls[0]!)).toBe(chroniony);
    /*
     * Sedno L11.5: odmowa **widoczna**, a nie wywnioskowana z braku skutku.
     * Dowod czyta `isError` i tresc wyniku; oba musza byc w strumieniu.
     */
    expect(calls[0]!.isError, 'odmowa nie jest oznaczona jako blad kroku').toBe(true);
    /* Runda 6: pierwszą regułą jest pozytywna (poza katalogiem roboczym). */
    expect(calls[0]!.result).toContain('katalogu roboczego');
  });

  it('wywolanie zakonczone bledem jest w strumieniu, oznaczone jako blad', async () => {
    /* Runda 6: nieistniejący plik WEWNĄTRZ workspace — dozwolony kształt. */
    const { events, stand, runId: runIdBlad } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: '$workspace/output/nie-ma-takiego.txt' } },
      { kind: 'text', text: 'Koniec.' },
    ]);

    // Niczego nie odrzucil straznik — to jest blad wykonania, nie odmowa.
    expect(stand.fileTools).toEqual([expect.objectContaining({ name: 'Read', denied: false })]);

    const calls = seenCalls(events);
    expect(calls, 'wywolanie zakonczone bledem nie trafilo do strumienia zdarzen').toHaveLength(1);
    expect(calls[0]!.name).toBe('Read');
    /*
     * W-3 (runda 8): pełna równość — oczekiwana ścieżka liczona `realResolve`-em
     * od katalogu roboczego uruchomienia, nie sufiks. Krok `writeOutput`
     * tworzy katalog `output/`, plik celowo nie — decyzja o dozwolonym
     * kształcie należy do strażnika, nie do asercji.
     */
    expect(pathOf(calls[0]!)).toBe(
      realResolve(join(h.platform.config.workspacesDir, runIdBlad, 'output/nie-ma-takiego.txt')),
    );
    expect(calls[0]!.isError, 'blad narzedzia nie zostal oznaczony w strumieniu').toBe(true);
    expect(calls[0]!.result).toContain('ENOENT');
  });

  it('kontrola: wywolanie, ktorego nie bylo, NIE pojawia sie w strumieniu', async () => {
    /*
     * Bez tego trzy asercje powyzej moglyby byc puste — zdaniem o moscie, ktory
     * zapisuje cokolwiek zawsze. Ten sam przebieg, ten sam czytelnik, zero
     * wywolan plikowych: strumien ma o nich milczec.
     *
     * To jest rowniez **dokladny ksztalt** pytania z tury 17: „czego dowodzi
     * brak wpisu". Dowodzi tego, ze wywolania nie bylo — o ile most zapisuje
     * kazde, ktore bylo.
     */
    const { events, stand } = await startRun([{ kind: 'text', text: 'Nie dotykam plikow.' }]);

    expect(stand.fileTools).toEqual([]);
    expect(seenCalls(events), 'strumien pokazuje wywolanie, ktorego nie bylo').toEqual([]);
  });

  it('kazde z piatki narzedzi plikowych jest zapisywane, nie tylko Read', async () => {
    /*
     * `AUTO_APPROVED_FILE_TOOLS` ma pieciu czlonkow, a most nie rozroznia ich po
     * nazwie — ale to jest zdanie o kodzie, ktore ma potwierdzic proba. Scenariusz
     * tury T14 uzywa `Read`, `Write`, `Glob` i `Grep`, wiec kazde z nich musi byc
     * widoczne, zeby dowod z tamtej tury dalo sie przeczytac.
     */
    const chronionyKatalog = h.platform.config.dataDir;
    const { events } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: join(chronionyKatalog, 'app.db') } },
      { kind: 'fileTool', name: 'Write', input: { file_path: join(chronionyKatalog, 'podrzucone.txt') } },
      { kind: 'fileTool', name: 'Edit', input: { file_path: join(chronionyKatalog, 'app.db') } },
      { kind: 'fileTool', name: 'Glob', input: { path: chronionyKatalog, pattern: '*' } },
      { kind: 'fileTool', name: 'Grep', input: { path: chronionyKatalog, pattern: 'token' } },
      { kind: 'text', text: 'Koniec.' },
    ]);

    const calls = seenCalls(events);
    expect(calls.map((c) => c.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    // I kazde z widoczna odmowa, bo kazde celowalo w katalog danych.
    expect(calls.every((c) => c.isError), JSON.stringify(calls)).toBe(true);
  });
});

describe('most hookow a podwykonawca — jedyne miejsce, w ktorym wywolanie znika', () => {
  it('odmowa u podwykonawcy JEST w strumieniu', async () => {
    /*
     * To jest polowa, ktora domyka rozumowanie o turze 17. Most wychodzi
     * wczesniej dla ruchu podwykonawcy, ale **dopiero po decyzji straznika** —
     * wiec proba odczytu chronionej sciezki zostaje zapisana niezaleznie od
     * tego, kto ja wykonal.
     */
    const chroniony = join(h.platform.config.dataDir, 'app.db');
    const { events, stand } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: chroniony }, subagent: true },
      { kind: 'text', text: 'Koniec.' },
    ]);

    expect(stand.fileTools).toEqual([expect.objectContaining({ name: 'Read', denied: true })]);
    const calls = seenCalls(events);
    expect(calls, 'odmowa u podwykonawcy zniknela ze strumienia').toHaveLength(1);
    expect(calls[0]!.isError).toBe(true);
    expect(pathOf(calls[0]!)).toBe(chroniony);
  });

  it('NIEODRZUCONE wywolanie podwykonawcy NIE trafia do strumienia — wada nazwana, nie ukryta', async () => {
    /*
     * **Znaleziona luka obserwowalnosci, zapisana jako fakt o dzisiejszym
     * kodzie.** Most wycisza zwykla aktywnosc podwykonawcy, zeby nie dublowac
     * pracy watku glownego w czacie (`fromSubagent` w `runtime.ts`). Skutek
     * uboczny: wywolanie narzedzia plikowego, ktorego straznik NIE odrzucil, a
     * ktore wykonal podwykonawca, nie ma w strumieniu zadnego sladu.
     *
     * Dlaczego to NIE podwaza dowodu z pakietu BL-03: proby tego pakietu celuja
     * w sciezki **chronione**, a te sa odrzucane i zapisywane takze u
     * podwykonawcy (test powyzej). Niewidoczne jest wylacznie wywolanie
     * dozwolone — czyli takie, ktore niczego o izolacji nie mowi.
     *
     * Ten test istnieje po to, zeby ta granica byla zapisana i zeby jej
     * przypadkowa zmiana — w ktoraskolwiek strone — zostala zauwazona.
     */
    const { events, stand } = await startRun([
      { kind: 'writeOutput', path: 'dozwolony.txt', content: 'tresc dozwolona' },
      { kind: 'fileTool', name: 'Read', input: { file_path: '$workspace/output/dozwolony.txt' }, subagent: true },
      { kind: 'text', text: 'Koniec.' },
    ]);

    // Wywolanie naprawde sie odbylo i naprawde nie zostalo odrzucone…
    expect(stand.fileTools).toEqual([expect.objectContaining({ name: 'Read', denied: false })]);
    // …a mimo to strumien o nim milczy.
    expect(seenCalls(events)).toEqual([]);
  });
});
