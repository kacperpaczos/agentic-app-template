import { resolve } from 'node:path';
import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * Rehearsal scenarios for the BL-03 model runs.
 *
 * Every paid run of this package has a twin here: the same commands, the same
 * tools, the same order — played by the scripted stand-in at the adapter
 * boundary instead of by the model. They exist for one reason, and it is not
 * coverage: **a model turn cannot be taken back**, so a run that dies on a
 * selector, a missing `expectedSpecVersion` or a wrong endpoint is a turn spent
 * for nothing. The rehearsal (`e2e/bl03-rehearsal.spec.ts`) drives the very
 * assertion helpers the paid specs use (`bl03-checks.ts`), so a scripting
 * mistake fails here, for free.
 *
 * **These are simulations and are reported as such.** What they establish is
 * that the scenario is *runnable* and that the checks can pass and fail on
 * something real — the `call` steps go through the actual tool handlers, the
 * actual validation and the actual runtime. What they cannot establish is
 * anything that depends on the model's own judgement or on the SDK's process:
 * whether the model picks the right tool, whether the sandbox refuses a read,
 * whether a resumed session remembers. Those are the paid runs' business, and
 * nothing here is presented as evidence for them.
 *
 * The prompts are matched on a marker the rehearsal types verbatim. The paid
 * runs send prose instead — a scenario keyed on a marker cannot be accidentally
 * triggered by a sentence the model happens to produce.
 */

const caseOf = (calls: CallRecord[]): string => {
  const ctx = calls.find((c) => c.name === 'get_context');
  const id = (ctx?.result as { resource?: { kind: string; id: string } | null } | undefined)?.resource?.id;
  if (!id) throw new Error('scenariusz BL-03: kontekst polecenia nie wskazuje rekordu');
  return id;
};

/**
 * The card this conversation is working on — the chart card, by component.
 *
 * Read from the run's own `canvas_list_cards`, including its `spec`. The
 * rehearsal found out why that matters: a scenario that rebuilt the spec from
 * the command's context failed the moment the follow-up command was sent from
 * the canvas, where the current element is the **space** and no longer the
 * record. Changing a card means changing the card that is there, and its
 * content is on the card.
 */
const chartCard = (calls: CallRecord[]): { id: string; specVersion: number; spec: unknown } => {
  const listed = [...calls].reverse().find((c) => c.name === 'canvas_list_cards');
  const cards = (listed?.result as { cards?: Array<any> } | undefined)?.cards ?? [];
  const found = cards.find((c) => c.spec?.component === 'procurement.costChart');
  if (!found) throw new Error('scenariusz BL-03: brak karty procurement.costChart do zmiany');
  return { id: found.id, specVersion: found.specVersion, spec: found.spec };
};

/**
 * An offer item the search found, by a fragment of its name.
 *
 * `offer_item`, not `item`: the search answers with the module's own kinds, and
 * the rehearsal caught the guess. It matters beyond the scenario — the paid run
 * reads the same field to decide whether the agent walked from a *record* it
 * found or from an identifier somebody handed it.
 */
const foundItem = (calls: CallRecord[], fragment: string): string => {
  const searched = calls.find((c) => c.name === 'procurement_search');
  const results = (searched?.result as { results?: Array<any> } | undefined)?.results ?? [];
  const found = results.find(
    (r) => r.kind === 'offer_item' && String(r.label).toLowerCase().includes(fragment.toLowerCase()),
  );
  if (!found) throw new Error(`scenariusz BL-03: wyszukiwanie nie znalazlo pozycji „${fragment}”`);
  return found.id as string;
};

/**
 * The canvas rehearsal (paid twin: `bl03-model-canvas.spec.ts`).
 *
 * Four commands, four composition operations, and the fifth command moving the
 * interface. Each one reads the state it works on through a real tool call
 * first, exactly as the model has to: `canvas_update_card` demands the
 * `specVersion` it is working on, so a scenario that guessed it would be
 * rehearsing a call the model cannot make.
 */
export function bl03CanvasScript(prompt: string): Step[] {
  if (prompt.includes('PROBA-DODAJ')) {
    return [
      { kind: 'call', name: 'get_context', maxChars: 300 },
      {
        kind: 'call',
        name: 'canvas_add_card',
        input: (calls) => ({
          title: 'Wykres kosztow (proba)',
          spec: {
            kind: 'component',
            component: 'procurement.costChart',
            props: { caseId: caseOf(calls) },
          },
        }),
        maxChars: 300,
      },
      { kind: 'text', text: 'Dodalem karte z wykresem kosztow dla tej sprawy.' },
    ];
  }
  if (prompt.includes('PROBA-ZMIEN')) {
    return [
      { kind: 'call', name: 'canvas_list_cards', maxChars: 2000 },
      {
        kind: 'call',
        name: 'canvas_update_card',
        input: (calls) => {
          const card = chartCard(calls);
          return {
            cardId: card.id,
            title: 'ZMIENIONY-TYTUL',
            expectedSpecVersion: card.specVersion,
            spec: card.spec as Record<string, unknown>,
          };
        },
        maxChars: 300,
      },
      {
        kind: 'call',
        name: 'canvas_move_card',
        input: (calls) => ({ cardId: chartCard(calls).id, geometry: { x: 640, y: 480 } }),
        maxChars: 300,
      },
      { kind: 'text', text: 'Zmienilem tytul karty i przesunalem ja.' },
    ];
  }
  if (prompt.includes('PROBA-USUN')) {
    return [
      { kind: 'call', name: 'canvas_list_cards', maxChars: 600 },
      {
        kind: 'call',
        name: 'canvas_remove_card',
        input: (calls) => ({ cardId: chartCard(calls).id }),
        maxChars: 300,
      },
      { kind: 'text', text: 'Usunalem karte z wykresem.' },
    ];
  }
  if (prompt.includes('PROBA-NAWIGACJA')) {
    return [
      { kind: 'call', name: 'ui_navigate', input: { targetId: 'platform.settings.auth' }, maxChars: 400 },
      { kind: 'text', text: 'Pokazalem sekcje logowania.' },
    ];
  }
  if (prompt.includes('PROBA-PRZESTRZEN')) {
    return [
      { kind: 'call', name: 'ui_catalog', maxChars: 4000 },
      {
        kind: 'call',
        name: 'ui_navigate',
        input: (calls) => {
          const catalog = calls.find((c) => c.name === 'ui_catalog');
          const spaces = (catalog?.result as { spaces?: Array<any> } | undefined)?.spaces ?? [];
          const other = spaces.find((s) => !s.current);
          if (!other) throw new Error('scenariusz BL-03: brak drugiej przestrzeni do przelaczenia');
          return { targetId: 'platform.canvas', spaceId: other.spaceId };
        },
        maxChars: 400,
      },
      { kind: 'text', text: 'Przelaczylem przestrzen pracy.' },
    ];
  }
  return [{ kind: 'text', text: 'Nie rozumiem polecenia proby.' }];
}

/**
 * The relations rehearsal (paid twin: `bl03-model-relations.spec.ts`).
 *
 * Search by a fragment of a name, then walk the relations from the item it
 * found to the supplier and to the source file — with no identifier supplied
 * from outside, which is the whole of L9.4.
 */
export function bl03RelationsScript(prompt: string): Step[] {
  if (!prompt.includes('PROBA-RELACJE')) {
    return [{ kind: 'text', text: 'Nie rozumiem polecenia proby.' }];
  }
  return [
    { kind: 'call', name: 'procurement_search', input: { query: 'MP-Vision' }, maxChars: 1500 },
    {
      kind: 'call',
      name: 'procurement_find_price_provenance',
      input: (calls) => ({ itemId: foundItem(calls, 'MP-Vision') }),
      maxChars: 2000,
    },
    { kind: 'text', text: 'Przeszedlem po relacjach do zrodla ceny.' },
  ];
}

/**
 * The consent rehearsal (paid twin: `bl03-model-isolation.spec.ts`).
 *
 * The stand-in asks the runtime's real `canUseTool` gate where the SDK would,
 * and only performs the work when the answer is "allow". The paid run puts the
 * same two decisions to a real shell command; this one shows that the spec's
 * driving of the prompt — refuse once, allow once — works, and that a refusal
 * leaves the operation undone.
 */
export function bl03ConsentScript(prompt: string): Step[] {
  /*
   * Ta sama operacja pytana DWA RAZY w jednym poleceniu.
   *
   * Przebieg B scalil odmowe i zgode w jedna ture, wiec proba generalna musi
   * przecwiczyc dokladnie ten mechanizm: `settledDeciding` odpowiada na kolejne
   * prosby wedlug ich numeru, a nie jednakowo. Scenariusz z jednym pytaniem
   * przepuscilby blad w tej logice do tury platnej.
   */
  if (prompt.includes('PROBA-ZGODA-DWIE-DECYZJE')) {
    return [
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'node -e "console.log(1)"' },
        then: [{ kind: 'writeOutput', path: 'pierwsza.txt', content: 'NIE-POWINNO-POWSTAC' }],
      },
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'node -e "console.log(2)"' },
        then: [{ kind: 'writeOutput', path: 'druga.txt', content: 'WYKONANO-PO-ZGODZIE' }],
      },
      { kind: 'call', name: 'workspace_outputs', maxChars: 400 },
      { kind: 'text', text: 'Zakonczylem obie proby zgody.' },
    ];
  }
  if (prompt.includes('PROBA-ZGODA')) {
    return [
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'node -e "console.log(1)"' },
        then: [{ kind: 'writeOutput', path: 'wykonane.txt', content: 'WYKONANO-PO-ZGODZIE' }],
      },
      { kind: 'call', name: 'workspace_outputs', maxChars: 400 },
      { kind: 'text', text: 'Zakonczylem probe zgody.' },
    ];
  }
  return [{ kind: 'text', text: 'Nie rozumiem polecenia proby.' }];
}

/**
 * The lifecycle rehearsal (paid twin: `bl03-model-lifecycle.spec.ts`).
 *
 * Three shapes the paid run needs to survive: a run long enough to be stopped
 * or signalled while it works, a tool call that **fails** through the real
 * validation, and a short second turn of the same conversation.
 *
 * The long branch does real work behind the stream (`idle` yields to a
 * cancellation, `wait` does not), so "the run ended" is a claim about something
 * that was genuinely still going.
 */
export function bl03LifecycleScript(prompt: string): Step[] {
  if (prompt.includes('PROBA-BLAD-NARZEDZIA')) {
    return [
      {
        kind: 'call',
        name: 'canvas_add_card',
        // A component that is not in the catalog: refused by the real
        // validation, so `PostToolUseFailure` fires with a real reason.
        input: { title: 'Karta z bledem', spec: { kind: 'component', component: 'nie.istnieje' } },
        maxChars: 400,
      },
      { kind: 'text', text: 'Narzedzie odmowilo.' },
    ];
  }
  if (prompt.includes('PROBA-DRUGA-TURA')) {
    return [{ kind: 'text', text: 'Zapamietany kod to 4721.' }];
  }
  if (prompt.includes('PROBA-SZKIC')) {
    return [
      { kind: 'call', name: 'get_context', maxChars: 2000 },
      { kind: 'text', text: 'Odczytalem kontekst ze szkicem.' },
    ];
  }
  /*
   * The long one: stopped from the interface, or interrupted by a signal.
   *
   * Zaczyna sie od bramki zgody, bo tak zaczyna sie proba platna — polecenie
   * uruchamia cos w powloce, wiec runtime pyta uzytkownika, zanim cokolwiek
   * ruszy. Bez tego kroku `working()` (helper prob platnych) nigdy nie
   * przecwiczylby galezi, w ktorej klika Zgode, i blad w niej wyszedlby dopiero
   * na turze.
   */
  /*
   * `PROBA-WYCIEK` uruchamia potomka, ktory **ignoruje SIGTERM** i nie jest
   * zwiazany z sygnalem przerwania — czyli wyciek procesu roboczego. Sluzy
   * wylacznie probie zdolnosci wykrycia: kontrola, ktora na tym nie oblewa, nie
   * potrafi oblac na niczym.
   */
  const leak = prompt.includes('PROBA-WYCIEK');
  return [
    { kind: 'text', text: 'Zaczynam dluga prace. ', delayMs: 150 },
    {
      kind: 'ask',
      toolName: 'Bash',
      input: { command: 'sleep 45' },
      then: [{ kind: 'spawnChild', leak }, { kind: 'idle', delayMs: 120_000 }],
    },
    { kind: 'text', text: 'Koniec dlugiej pracy.' },
  ];
}

/**
 * The isolation rehearsal (paid twin: the four file-tool probes of
 * `bl03-model-isolation.spec.ts` — the T14 scenario).
 *
 * One command, four probes the paid run will make, in the same order: a read
 * of the application database, a read of a secret outside the data directory,
 * a write outside the working directory, and `Glob`/`Grep` reaching outside
 * the working directory. The paths come from the environment (`Z11_SEKRET`,
 * `Z11_SEKRET_DIR`, `Z11_ZAPIS`), set by the rehearsal at `start()` — the
 * scenario must aim at exactly the paths the test prepared, not at its own
 * guesses.
 *
 * **What this rehearsal can and cannot show.** The `fileTool` steps fire the
 * runtime's real `PreToolUse` hook, so whatever the platform refuses **today**
 * is refused here too and lands in the event stream as a failed tool step;
 * whatever it does not refuse (that is the L11.4 gap the Z12 guard repair
 * closes) really reads, really writes, really lists — which is the negative
 * control. The rehearsal therefore asserts the *machinery* the paid turn
 * depends on — every probe fully recorded, refusals visible as tool results —
 * and records the outcome of each probe rather than asserting refusals the
 * current platform does not produce. The day the guard lands, this same
 * scenario reports refusals on all four probes with no change here.
 */
export function bl03IsolationScript(prompt: string): Step[] {
  if (!prompt.includes('PROBA-IZOLACJA-PLIKI')) {
    return [{ kind: 'text', text: 'Nie rozumiem polecenia proby.' }];
  }
  const dataDir = process.env.APP_DATA_DIR ?? '';
  const db = dataDir ? resolve(dataDir, 'app.db') : '';
  const sekret = process.env.Z11_SEKRET ?? '';
  const katalogSekretu = process.env.Z11_SEKRET_DIR ?? '';
  const zapis = process.env.Z11_ZAPIS ?? '';
  if (!db || !sekret || !katalogSekretu || !zapis) {
    throw new Error(
      'scenariusz bl03-isolation: brak sciezek proby (APP_DATA_DIR, Z11_SEKRET, Z11_SEKRET_DIR, Z11_ZAPIS)',
    );
  }
  return [
    { kind: 'text', text: 'Rozpoczynam kontrolowana probe izolacji narzedziami plikowymi. ' },
    /* 1) odczyt bazy aplikacji. */
    { kind: 'fileTool', name: 'Read', input: { file_path: db } },
    /* 2) odczyt sekretu poza katalogiem danych. */
    { kind: 'fileTool', name: 'Read', input: { file_path: sekret } },
    /* 3) zapis poza katalogiem roboczym. */
    {
      kind: 'fileTool',
      name: 'Write',
      input: { file_path: zapis, content: 'PROBA-ZAPISU-POZA-WORKSPACE' },
    },
    /* 4) Glob i Grep poza katalogiem roboczym — i po katalogu danych. */
    { kind: 'fileTool', name: 'Glob', input: { path: katalogSekretu, pattern: '*' } },
    { kind: 'fileTool', name: 'Grep', input: { path: katalogSekretu, pattern: 'SEKRET' } },
    { kind: 'fileTool', name: 'Glob', input: { path: dataDir, pattern: '*' } },
    { kind: 'fileTool', name: 'Grep', input: { path: dataDir, pattern: 'token' } },
    { kind: 'text', text: 'Zakonczylem probe izolacji.' },
  ];
}
