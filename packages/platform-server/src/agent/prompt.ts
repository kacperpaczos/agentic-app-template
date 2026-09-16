import { FILE_ANALYSIS, type AppContext } from '@platform/contracts';
import type { ComponentCatalog } from '../registry/catalog.ts';
import type { ServerModuleRegistry } from '../registry/modules.ts';
import { mcpToolName } from './mcp.ts';

export interface PromptInput {
  registry: ServerModuleRegistry;
  catalog: ComponentCatalog;
  appContext: AppContext;
  resourceSummary: string | null;
  workspaceDir: string | null;
  stagedFiles: Array<{ fileId: string; path: string; filename: string; mediaType: string }>;
  /** Analysis libraries linked into this run's workspace. */
  toolkit: Array<{ name: string; purpose: string }>;
}

/**
 * Assembles the run's system prompt.
 *
 * Deliberately contains *no* business rules. Prices, validation and permissions
 * are enforced by the domain services; the prompt only describes vocabulary,
 * available tools and how to behave with the canvas. A rule that exists only
 * here would be a rule that does not exist.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const ctx = input.appContext;
  const briefings = input.registry.briefings();

  const parts: string[] = [
    `Jestes agentem wbudowanym w lokalna aplikacje webowa. Pracujesz na danych aplikacji wylacznie przez narzedzia MCP z serwera "app".`,
    '',
    '# Zasady',
    '- Nigdy nie zgaduj wartosci biznesowych. Jesli dane sa niekompletne, zwroc je jako brakujace.',
    '- Wszystkie obliczenia kwot wykonuje backend. Nie licz sum w glowie i nie podawaj wyliczen, ktorych nie zwrocilo narzedzie.',
    '- Zapisu danych i zmian interfejsu dokonuj wylacznie narzedziami. Nie edytuj bazy ani plikow aplikacji.',
    '- Nie zmieniaj polozenia istniejacych kart, chyba ze uzytkownik o to prosi. Pozycja karty nalezy do uzytkownika.',
    `- Jesli nie wiesz, na czym pracuje uzytkownik, wywolaj ${mcpToolName('get_context')}.`,
    '- Niezapisane szkice formularzy (unsavedDrafts) to NIE sa dane zapisane. Nie traktuj ich jak faktow.',
    '- Odpowiadaj po polsku, zwiezle.',
    '',
    '# Katalog komponentow canvasu',
    input.catalog.prompt(),
    '',
    '# Aktualny kontekst aplikacji',
    `- rozmowa: ${ctx.conversationId ?? '(brak)'}`,
    `- przestrzen canvas: ${ctx.spaceId ?? '(brak)'}`,
    `- zasob: ${ctx.resource ? `${ctx.resource.kind}:${ctx.resource.id}` : '(brak)'}`,
    input.resourceSummary ? `- opis zasobu: ${input.resourceSummary}` : '',
    `- zaznaczenie: ${ctx.selection.length ? ctx.selection.map((s) => `${s.kind}:${s.id}`).join(', ') : '(brak)'}`,
    `- filtry: ${Object.keys(ctx.filters).length ? JSON.stringify(ctx.filters) : '(brak)'}`,
    ctx.drafts.length
      ? `- niezapisane szkice: ${ctx.drafts.map((d) => `${d.entity}/${d.entityId ?? 'nowy'} (${d.dirtyFields.join(',')})`).join('; ')}`
      : '',
  ];

  if (input.workspaceDir) {
    parts.push(
      '',
      '# Workspace i sandbox',
      `Katalog roboczy tego uruchomienia to ${input.workspaceDir}.`,
      '- Pliki wejsciowe znajduja sie w input/, wyniki zapisuj w output/.',
      '- Masz Bash, Read i Write ograniczone do tego katalogu; siec jest odcieta.',
      `- Zeby pobrac plik z aplikacji do workspace, uzyj ${mcpToolName('files_stage')}.`,
      `- Zeby wynik byl trwaly i do pobrania, opublikuj go przez ${mcpToolName('artifact_publish_file')}. Pliki w workspace sa kasowane po uruchomieniu.`,
    );
    if (input.stagedFiles.length) {
      parts.push(
        '- Pliki juz przygotowane w workspace:',
        ...input.stagedFiles.map(
          (f) => `  - ${f.path} (fileId=${f.fileId}, typ=${f.mediaType})`,
        ),
      );
    }

    if (input.toolkit.length) {
      parts.push(
        '',
        '# Biblioteki dostepne w sandboxie',
        'Sa podlinkowane do node_modules workspace. Siec jest odcieta, wiec innych nie zainstalujesz.',
        ...input.toolkit.map((t) => `- ${t.name}: ${t.purpose}`),
      );
    }

    /*
     * The honest scope of file analysis, stated to the model in the same words
     * the interface shows the user.
     *
     * The failure this prevents is specific and silent: reporting a stored
     * formula result as if it had been recalculated. The workbook keeps the
     * value Excel last wrote next to the formula; nothing in the run
     * recalculates it, so presenting it as "the result" would be a fabricated
     * number wearing a spreadsheet's authority.
     */
    parts.push(
      '',
      '# Analiza plikow — co wolno powiedziec',
      '## Obraz (PNG, JPEG)',
      '- Czytaj obraz narzedziem Read; model widzi jego tresc bezposrednio.',
      '- Opisuj to, co widac. Nie zgaduj tekstu, ktorego nie da sie odczytac.',
      '## Skoroszyt (XLSX)',
      ...FILE_ANALYSIS.spreadsheet.reads.map((r) => `- czytane: ${r}`),
      ...FILE_ANALYSIS.spreadsheet.limits.map((l) => `- OGRANICZENIE: ${l}`),
      '- Formule opisuj jako "formula X, ostatnia zapisana wartosc Y". NIGDY nie podawaj',
      '  zapisanej wartosci jako wyniku przeliczenia — plik moze byc nieaktualny.',
      `- Zmodyfikowany plik uzytkownika publikuj przez ${mcpToolName('files_publish_version')},`,
      '  podajac fileId oryginalu. Oryginal zostaje nienaruszony.',
      '- Jesli plik jest uszkodzony albo ma nieobslugiwany format, powiedz to wprost',
      '  i nie zmyslaj zawartosci.',
    );
  }

  /*
   * Live artifacts can only name a query that is registered. Listing them is
   * what makes `mode="live"` usable at all: without it the model would have to
   * guess an operation name, and every guess would be rejected at creation.
   */
  const readOperations = input.registry.readOperations;
  if (readOperations.length) {
    parts.push(
      '',
      '# Operacje odczytu dla artefaktow live',
      `Artefakt utworzony przez ${mcpToolName('artifact_create')} z mode="live" nie przechowuje danych.`,
      'Jako content podaj deskryptor {"operation":"<nazwa>","input":{...}} z ponizszej listy;',
      'przy kazdym otwarciu artefaktu aplikacja uruchomi te operacje ponownie i pokaze aktualny wynik.',
      'Uzywaj mode="live" dla zestawien, ktore maja pozostac aktualne, a mode="snapshot" dla raportu z konkretnej chwili.',
      ...readOperations.map(
        (op) => `- ${op.qualifiedName}: ${op.definition.description} (input: ${describeShape(op.definition.inputSchema)})`,
      ),
    );
  }

  /*
   * Where the interface can be moved to.
   *
   * Listed because the alternative is what actually happened without it: asked
   * to "switch to files", the agent had no navigation tool, called two unrelated
   * read tools, and then told the user they had to create a purchase case first
   * to reach a screen that is in the navigation unconditionally. Describing a
   * route the user must walk is not navigation, and a confident wrong route is
   * worse than saying nothing.
   */
  const uiTargets = input.registry.uiTargets();
  if (uiTargets.length) {
    parts.push(
      '',
      '# Sterowanie interfejsem',
      `Gdy uzytkownik prosi o pokazanie, otwarcie albo przelaczenie czegos w aplikacji, uzyj ${mcpToolName('ui_navigate')}.`,
      'NIE opisuj drogi slowami, jesli cel jest na ponizszej liscie — po prostu go otworz.',
      `Pelna liste wraz z przestrzeniami pracy zwraca ${mcpToolName('ui_catalog')}.`,
      'Wynik ui_navigate zawiera executed=true/false. Jesli false, powiedz uzytkownikowi,',
      'czego nie udalo sie zrobic i dlaczego — nie twierdz, ze cos otworzyles.',
      'Pokazanie ustawienia niczego w nim nie zmienia.',
      ...uiTargets.map((t) => `- ${t.id} [${t.kind}] ${t.label}: ${t.description}`),
    );
  }

  if (briefings) parts.push('', '# Moduly biznesowe', briefings);

  return parts.filter((p) => p !== '').join('\n');
}

/** One-line description of a Zod object's keys, for the prompt listing. */
function describeShape(schema: { shape?: Record<string, unknown> }): string {
  const keys = Object.keys(schema.shape ?? {});
  return keys.length ? keys.join(', ') : 'brak';
}
