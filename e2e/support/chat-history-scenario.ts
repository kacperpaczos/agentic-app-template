import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * One conversation covering what the chat surface has to put on screen.
 *
 * Chosen by the user's own words, so a single scripted instance serves the whole
 * browser suite: a restart between cases would end the run the "work in another
 * conversation" case is built around, and that is precisely the defect the
 * previous attempt at this criterion ran into.
 *
 * Two things here are deliberate and neither is cosmetic:
 *
 *  - **prose before a tool call** (`zanim`) is expressed with a `call` step, not
 *    a `tool` step. A `tool` step fires its hooks before the stream opens, so
 *    every announced tool call in this harness precedes every token — that
 *    harness cannot produce "the agent said something, then reached for a tool",
 *    which is the ordering a real turn takes most often;
 *  - **markdown and an OpenUI composition** are in the answer text itself, not
 *    asserted from a fixture. What the chat does with them is the criterion.
 *
 * Results obtained with it are simulations and are reported as such.
 */
export const chatHistoryScript = (rawPrompt: string): Step[] => {
  /*
   * Matched without case, because the words the test types are the words a
   * person types — a sentence starting with "Zanim" silently fell through to
   * the default branch and the run answered something else entirely.
   */
  const prompt = rawPrompt.toLowerCase();
  /*
   * Formatting the chat has to render as formatting: emphasis and a list. The
   * markdown is split across deltas at a point that is *not* a token boundary,
   * so a renderer that parsed each delta on its own would produce visible
   * rubbish rather than a bold word.
   */
  if (prompt.includes('proza')) {
    return [
      { kind: 'text', text: 'Krotkie **podsu', delayMs: 200 },
      { kind: 'text', text: 'mowanie** sprawy:\n\n', delayMs: 200 },
      { kind: 'text', text: '- pierwszy wniosek\n', delayMs: 200 },
      { kind: 'text', text: '- drugi wniosek\n', delayMs: 200 },
    ];
  }

  /*
   * Words and a composition in one answer. The fence is what the chat's own
   * rule recognises as OpenUI Lang, and the sentence before it is the part that
   * used to disappear the moment a composition appeared under it.
   */
  if (prompt.includes('opis interfejsu')) {
    return [
      { kind: 'text', text: 'Ponizej zestawienie dostawcow, ktore przygotowalem. ', delayMs: 200 },
      {
        kind: 'text',
        text:
          '\n\n```openui-lang\n' +
          'root = DataTable({operation: "procurement.suppliers"}, ["name", "country"])\n' +
          '```\n',
        delayMs: 200,
      },
      { kind: 'text', text: '\nTyle po stronie zestawienia.', delayMs: 200 },
    ];
  }

  /*
   * Prose, then a real tool call through the real handler, then the answer.
   *
   * `ui_catalog` with an explicit `limit`, because the criterion is about
   * *arguments within the allowed range* being visible: an empty argument
   * object is on screen whether or not anything was passed, so it cannot fail.
   * A limit of three is inside the schema's range, is readable in the request
   * panel, and has a consequence in the answer — three targets and a window
   * marked truncated — so the number shown is demonstrably the number used.
   */
  if (prompt.includes('zanim')) {
    return [
      { kind: 'text', text: 'Zanim odpowiem, sprawdzam katalog komponentow. ', delayMs: 200 },
      { kind: 'call', name: 'ui_catalog', input: { limit: 3 }, maxChars: 200 },
      { kind: 'text', text: 'Katalog odczytany — to jest koncowa odpowiedz.', delayMs: 200 },
    ];
  }

  /*
   * A real artifact, made by the platform's own tool, so the chat has something
   * to render under the call that produced it and something to open in the
   * artifact browser. `live` on purpose: its renderer has to re-read the
   * artifact rather than draw whatever the tool returned.
   */
  if (prompt.includes('artefakt')) {
    return [
      { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
      {
        kind: 'call',
        name: 'artifact_create',
        input: (calls: CallRecord[]) => {
          const listed = calls.find((c) => c.name === 'procurement_list_cases');
          const found = listed?.result?.cases?.find((c: { code: string }) => c.code === 'PC-2026-01');
          if (!found) throw new Error('scenariusz: brak sprawy PC-2026-01');
          return {
            title: 'Zestawienie z rozmowy',
            kind: 'table',
            mode: 'live',
            rendererType: 'procurement.comparison',
            content: { operation: 'procurement.comparison', input: { caseId: found.id } },
          };
        },
        maxChars: 200,
      },
      { kind: 'text', text: 'Zapisalem zestawienie jako artefakt.', delayMs: 200 },
    ];
  }

  /* A tool that fails, and an answer that says so. Kept visible after a reload. */
  if (prompt.includes('blad narzedzia')) {
    return [
      {
        kind: 'tool',
        name: 'mcp__app__canvas_add_card',
        input: { component: 'nie.istnieje' },
        error: 'Nieznany komponent "nie.istnieje".',
      },
      { kind: 'text', text: 'Nie udalo sie dodac karty.', delayMs: 200 },
    ];
  }

  /*
   * Long enough that the user can leave the conversation, work in another one
   * and come back while it is still going. It reads its own context first, so
   * what this command was told is recoverable afterwards.
   */
  if (prompt.includes('dlugo')) {
    return [
      { kind: 'call', name: 'get_context', maxChars: 3000 },
      { kind: 'text', text: 'Zaczynam dluga prace. ', delayMs: 200 },
      ...Array.from({ length: 30 }, (_, i) => ({
        kind: 'text' as const,
        text: `fragment ${i + 1} `,
        delayMs: 500,
      })),
      { kind: 'text', text: 'Koniec dlugiej pracy.' },
    ];
  }

  /* A short command that reports what it was given — the context check. */
  return [
    { kind: 'call', name: 'get_context', maxChars: 3000 },
    { kind: 'text', text: 'Krotka odpowiedz.', delayMs: 120 },
  ];
};
