import { AGENT_VIEWS_TARGET_ID, RESERVED_SEARCH_KEYS, type UiTarget } from '@platform/contracts';

/**
 * Places in the interface the agent can be asked to open, contributed by the
 * platform itself.
 *
 * Deliberately domain-free: these are the platform's own screens, named in the
 * platform's own vocabulary. A module adds its screens through `uiTargets` on
 * its UI contribution, so that the business nouns stay in the business module —
 * the same rule `scripts/check-boundaries.mjs` enforces everywhere else.
 *
 * Every entry is something a user can actually be looking at. That matters:
 * this list is what the agent is told exists, so an entry that does not resolve
 * turns into a confident wrong answer, which is the failure this whole
 * mechanism was built to remove.
 */
export const PLATFORM_UI_TARGETS: UiTarget[] = [
  {
    id: 'platform.canvas',
    kind: 'view',
    label: 'Canvas',
    description:
      'Nieskonczona kanwa z kartami biezacej przestrzeni pracy. Domyslny ekran aplikacji.',
    to: '/',
  },
  {
    id: 'platform.spaces',
    kind: 'view',
    label: 'Zapisane kompozycje',
    description: 'Lista przestrzeni pracy; stad wybiera sie, ktora otworzyc na canvasie.',
    to: '/spaces',
  },
  {
    id: AGENT_VIEWS_TARGET_ID,
    kind: 'view',
    label: 'Widoki agenta',
    description:
      'Przestrzen biezacej rozmowy z widokami utworzonymi przez agenta (tabele, wykresy, podsumowania ' +
      'z zarejestrowanych odczytow). Kazda rozmowa ma wlasne widoki.',
    to: '/agent-views',
  },
  {
    id: 'platform.files',
    kind: 'view',
    label: 'Pliki i raporty',
    description:
      'Pliki zrodlowe i artefakty wytworzone przez agenta, z pobieraniem. Ekran platformy — ' +
      'dostepny zawsze, niezaleznie od tego, czy istnieja jakiekolwiek rekordy biznesowe.',
    to: '/files',
  },
  {
    id: 'platform.files.upload',
    kind: 'element',
    label: 'Wgrywanie pliku',
    description: 'Kontrolka wyboru pliku na ekranie Pliki i raporty.',
    to: '/files',
    selector: '[data-testid="files-page"] #file-upload',
  },
  {
    id: 'platform.settings',
    kind: 'view',
    label: 'Ustawienia',
    description: 'Stan logowania, wersje zaleznosci, mozliwosci czatu, lista narzedzi.',
    to: '/settings',
  },
  {
    id: 'platform.settings.auth',
    kind: 'setting',
    label: 'Stan logowania Claude',
    description:
      'Sekcja Ustawien pokazujaca sposob logowania, waznosc poswiadczenia i ostatni dostep. ' +
      'Pokazanie jej niczego nie zmienia.',
    to: '/settings',
    selector: '[data-testid="settings-auth"]',
  },
  {
    id: 'platform.settings.chat',
    kind: 'setting',
    label: 'Mozliwosci czatu',
    description: 'Sekcja Ustawien z lista funkcji czatu dostepnych i jawnie niedostepnych.',
    to: '/settings',
    selector: '[data-testid="settings-chat-capabilities"]',
  },
  {
    id: 'platform.chat',
    kind: 'section',
    label: 'Panel rozmowy',
    description: 'Prawy panel z rozmowa, kompozytorem i zalacznikami.',
    selector: '.pf-chat',
  },
  {
    id: 'platform.chat.attachments',
    kind: 'element',
    label: 'Zalaczanie pliku do polecenia',
    description:
      'Przycisk spinacza w polu pisania wiadomosci. Otwiera wybor: wgranie pliku z dysku ' +
      'albo wskazanie pliku juz wgranego. Dolaczone pliki widac nad wpisywanym tekstem.',
    selector: '[data-testid="chat-attach-open"]',
  },
  {
    id: 'platform.chat.artifacts',
    kind: 'element',
    label: 'Zakladka Artefakty',
    description:
      'Druga zakladka panelu rozmowy, z lista artefaktow wytworzonych w rozmowach. ' +
      'Pokazanie jej nie przelacza widoku — przelacza go uzytkownik, klikajac zakladke.',
    selector: '[data-testid="chat-tab-artifacts"]',
  },
  {
    id: 'platform.tasks',
    kind: 'element',
    label: 'Zadania w tle',
    description: 'Wskaznik w pasku stanu z lista trwajacych i zakonczonych zadan.',
    selector: '[data-testid="background-tasks"]',
  },
];

/**
 * The catalog the agent is shown and the client resolves against.
 *
 * One list, assembled once from the platform and the installed modules, so that
 * what the agent is told exists and what the client can actually perform cannot
 * drift apart. A duplicate id is dropped rather than allowed to shadow: two
 * targets answering to one name would make "which one did it open?"
 * unanswerable.
 */
export function buildUiTargetCatalog(moduleTargets: UiTarget[][]): UiTarget[] {
  const byId = new Map<string, UiTarget>();
  for (const target of [...PLATFORM_UI_TARGETS, ...moduleTargets.flat()]) {
    /*
     * A narrowing becomes one search parameter per field, so a field named `c`
     * or `s` would collide with the session's own keys — which are retained
     * across every navigation and would drag the filter onto screens it means
     * nothing on. Refused when the catalog is built, i.e. at startup, because
     * the alternative is a filter that silently does the wrong thing to the
     * address bar in production.
     */
    for (const field of target.filter?.fields ?? []) {
      if ((RESERVED_SEARCH_KEYS as readonly string[]).includes(field.field)) {
        throw new Error(
          `Cel interfejsu "${target.id}" deklaruje pole filtra "${field.field}", ` +
            `ktore jest zarezerwowane dla sesji (${RESERVED_SEARCH_KEYS.join(', ')}). ` +
            'Zmien nazwe pola.',
        );
      }
    }
    if (!byId.has(target.id)) byId.set(target.id, target);
  }
  return [...byId.values()];
}
