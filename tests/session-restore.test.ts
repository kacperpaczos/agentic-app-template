import { describe, expect, it } from 'vitest';
import { AppError } from '@platform/contracts';
import {
  classifyThreadFailure,
  decideRestore,
  type RestoreInput,
} from '../packages/platform-ui/src/chat/sessionRestore.ts';

/**
 * Which side moved, and what follows from it.
 *
 * The whole difficulty of restoring a conversation is here rather than in the
 * effect: both the URL and the ready-made chat change on their own, and a rule
 * that always prefers one of them breaks the other in a way that reads as a
 * glitch. These cases are written as the user's actions, because that is what
 * distinguishes them — the same pair of values means different things depending
 * on which one just changed.
 */

const input = (over: Partial<RestoreInput>): RestoreInput => ({
  urlThreadId: null,
  selectedThreadId: null,
  lastSynced: null,
  ...over,
});

describe('decideRestore', () => {
  it('po przeladowaniu wybiera rozmowe z adresu', () => {
    expect(
      decideRestore(input({ urlThreadId: 'cnv_1', selectedThreadId: null, lastSynced: null })),
    ).toEqual({ action: 'select', threadId: 'cnv_1' });
  });

  it('wybiera rozmowe nieobecna w wczytanej liscie', () => {
    /*
     * The case a list-membership check got wrong twice: right after a reload
     * the list is empty, and it is paged, so "not in the list" is not evidence
     * that a conversation is gone. Selection goes ahead and the server decides.
     */
    expect(
      decideRestore(input({ urlThreadId: 'cnv_stara', selectedThreadId: null })),
    ).toEqual({ action: 'select', threadId: 'cnv_stara' });
  });

  it('gdy obie strony sa zgodne, nic nie robi', () => {
    expect(
      decideRestore(input({ urlThreadId: 'cnv_1', selectedThreadId: 'cnv_1', lastSynced: 'cnv_1' })),
    ).toEqual({ action: 'idle' });
  });

  it('nadanie identyfikatora przez backend podmienia wpis historii', () => {
    /*
     * Pierwsza synchronizacja rozmowy, która już jest na ekranie. Ta sama trójka
     * (null, id, null) powstaje z dwóch różnych działań użytkownika: backend
     * nadaje id w trakcie pierwszego uruchomienia nowej rozmowy, a czat sam
     * wybiera rozmowę z listy (albo przez "nowa rozmowa"), zanim cokolwiek
     * trafiło do adresu. Oba przypadki dają to samo rozstrzygnięcie: zapis do
     * adresu przez PODMIANĘ wpisu, bo to nie jest nawigacja — push postawiłby
     * pusty czat za Wsteczem, a brak zapisu zgubiłby wybór przy przeładowaniu.
     */
    expect(
      decideRestore(input({ urlThreadId: null, selectedThreadId: 'cnv_nowy', lastSynced: null })),
    ).toEqual({ action: 'publish', threadId: 'cnv_nowy', replace: true });
  });

  it('wybor innej rozmowy w szufladzie dodaje wpis historii', () => {
    // The user moved between conversations; Back must return to the previous one.
    expect(
      decideRestore(input({ urlThreadId: 'cnv_1', selectedThreadId: 'cnv_2', lastSynced: 'cnv_1' })),
    ).toEqual({ action: 'publish', threadId: 'cnv_2', replace: false });
  });

  it('nowa rozmowa w czacie czysci parametr w adresie', () => {
    expect(
      decideRestore(input({ urlThreadId: 'cnv_1', selectedThreadId: null, lastSynced: 'cnv_1' })),
    ).toEqual({ action: 'publish', threadId: null, replace: false });
  });

  it('Wstecz na wpis bez rozmowy wraca do stanu nowej rozmowy', () => {
    expect(
      decideRestore(input({ urlThreadId: null, selectedThreadId: 'cnv_2', lastSynced: 'cnv_2' })),
    ).toEqual({ action: 'new' });
  });

  it('Wstecz na poprzednia rozmowe wraca do niej, nie publikuje biezacej', () => {
    // The regression a one-directional rule produces: the chat is on cnv_2, the
    // URL has just gone back to cnv_1. The URL must win.
    expect(
      decideRestore(input({ urlThreadId: 'cnv_1', selectedThreadId: 'cnv_2', lastSynced: 'cnv_2' })),
    ).toEqual({ action: 'select', threadId: 'cnv_1' });
  });

  it('utrata parametru w adresie po synchronizacji oznacza nowa rozmowe, a nie bezczynnosc', () => {
    /*
     * Gałąź, którą pomyłka "null to po prostu stan początkowy" zamienia w
     * bezczynność: oba identyfikatory są puste, ale PO synchronizacji — adres
     * już żył z parametrem i go stracił (Wstecz na wpis sprzed rozmowy,
     * usunięcie parametru). To jest wtedy realne polecenie "pokaż stan nowej
     * rozmowy", a nie domyślne nic-nie-rób.
     */
    expect(
      decideRestore(input({ urlThreadId: null, selectedThreadId: null, lastSynced: 'cnv_1' })),
    ).toEqual({ action: 'new' });
    /*
     * Kontrast, który odróżnia to od stanu początkowego: przed jakąkolwiek
     * synchronizacją ta sama para (null, null) znaczy tylko "nic się jeszcze
     * nie stało" — brak parametru jest wtedy stanem wyjściowym, a nie zmianą,
     * i nie wolno z niego robić przejścia do nowej rozmowy.
     */
    expect(decideRestore(input({}))).toEqual({ action: 'idle' });
  });
});

describe('classifyThreadFailure', () => {
  it('nieistniejaca i cudza rozmowa to ten sam stan koncowy', () => {
    expect(classifyThreadFailure(new AppError('not_found', 'nie ma'))).toBe('gone');
    expect(classifyThreadFailure(new AppError('forbidden', 'nie twoja'))).toBe('gone');
  });

  it('awaria zadania jest odroznialna od usuniecia', () => {
    // Different words and a different recovery on screen: telling the user to
    // start over would abandon work that is still there.
    expect(classifyThreadFailure(new AppError('internal', 'padlo'))).toBe('failed');
    expect(classifyThreadFailure(new TypeError('Failed to fetch'))).toBe('failed');
    expect(classifyThreadFailure(undefined)).toBe('failed');
  });
});
