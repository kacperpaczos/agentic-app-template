import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import type { Page } from '@playwright/test';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  conversationIdOf,
  expectCardPointsAtRecord,
  openApp,
  settled,
  settledDeciding,
  toolNames,
  typeCommand,
  type RunEvent,
  type RunRecord,
} from './support/bl03-checks.ts';
import {
  GLM_TURN_BUDGET,
  RUN_STAMP,
  budgetPreflight,
  configuredModel,
  glmMode,
  providerZrodlo,
  readLedger,
  turnUnit,
  writeLedger,
} from './support/model-turns.ts';
import { codeVersion, environment } from '../tests/support/measurement-evidence.ts';

/**
 * BRAMKA PRZEKRZOJOWA — jeden POWIAZANY dowod dzialania polaczen, na
 * **prawdziwym modelu** (ARCHITECTURE, „Odbior calego systemu”:
 * docs/versions/v0.4.1/ARCHITECTURE.md, sekcja o l.626).
 *
 * Rodzaj dowodu: **rzeczywisty model**, przez `@mastra/claude` i proces Claude
 * Agent SDK na buildzie produkcyjnym.
 *
 * ## Co ten spec dowodzi
 *
 * Jedna rozmowa, serialnie: odczyt i mutacja danych przez narzedzia MCP
 * (procurement_*) → zdarzenie `platform.data_changed` i odswiezenie UI →
 * zmiana kompozycji (karta widoku agenta, odczytana przez `ui_state`) →
 * przetworzenie pliku dolaczonego kompozytorem → zapis trwalego artefaktu →
 * kontynuacja TEJ SAMEJ sesji Claude po restarcie backendu (SIGTERM + start).
 * Ogonek deterministyczny na tych samych identyfikatorach rozmowy/danych:
 * odmowa dostepu (druga tozsamosc), konflikt wersji, anulowanie wykonania i
 * blad narzedzia. „Przebiegi moga byc podzielone na scenariusze, ale ich
 * identyfikatory i dane pozwalaja dowiec dzialania polaczen, nie tylko
 * niezaleznych endpointow” — identyfikatory wszystkich ogniw trafiaja do jednej
 * koperty: docs/evidence/bramka-przekrojowa/manifest.json.
 *
 * ## Dlaczego wlasna instancja
 *
 * Restart backendu jest jednym z ogniw, a Playwright nie odda swojego serwera.
 * Jak `bl03-model-lifecycle.spec.ts`: `ScriptedInstance`, `entry:
 * 'production'`, wlasny zarezerwowany port i wlasny katalog danych; sygnalizowany
 * jest wylacznie proces, ktory ten obiekt uruchomil.
 *
 * ## Koszt i opt-in
 *
 * Koszt: **do 5 tur** (4 zaplanowane tury modelowe bramki + najwyzej 1 zapas na
 * sonde anulowania, ktora **zwykle** anuluje run zanim model odpowie — run
 * anulowany w kolejce „nigdy nie osiagnal modelu”; gdyby jednak zdazyl dotknac
 * modelu, pierwsza tura rejestruje `first_token_ms` i sonda ksieguje ture).
 * Deklaracja „do 4 tur” z projektu bramki omawiala cztery tury numerowane;
 * sufit 5 jest szczery wobec trybu awaryjnego sondy i pokrywa cale jej
 * przestrzeganie budzetu (preflight rezerwuje 5).
 *
 * Opt-in: bez `APP_E2E_MODEL=1` zadny projekt nie pasuje do tego pliku
 * (`playwright.config.ts`) — domyslny przebieg go w ogole nie laduje, a wiec
 * nie uruchamia. Drugi pas bezpieczenstwa jest w srodku: preflight budzetu
 * (`budgetPreflight`) odpuszcza CALY spec pominieciem, gdy zostatek grantu
 * nie pokrywa jego kosztu — nic nie idzie do modelu, a pominiecie jest
 * uczciwa odpowiedzia na brak budzetu. Rejestr tur jest wspolny z
 * pozostalymi specami projektu „model” (`.e2e-model-turns/`, w trybie GLM
 * rejestr `glm.json`, sufit 45): ten spec dolacza swoje tury do tego samego
 * licznika i przed pierwszym poleceniem pyta, czy budzet pokrywa CALY koszt.
 *
 * ## Odchylenia od projektu (udokumentowane, nie ukryte)
 *
 *  - „Obniz o 1”: narzedzie `update_offer_item` przyjmuje cene w jednostkach
 *    glownych (`parseAmountToMinor` w serwisie), wiec „o 1” to jeden glowny
 *    walutowy = **dokladnie -100** w `unitPriceMinor` backendu. Asercja jest
 *    calkowitoliczbowa na delcie minor.
 *  - Ogonek (d) blad: dowod na poziomie HTTP (drzwi modulu, ta sama usluga co
 *    narzedzie MCP — komentarz trasy: „one implementation, two doors”):
 *    PATCH nieistniejacej pozycji → 404 `not_found` jako BLAD, nie wynik.
 *    Polowe „blad w rozmowie” dowodzi juz oplacony dowod
 *    `e2e/bl03-model-t15.spec.ts` (blad narzedzia przechodzacy przez adapter
 *    do rozmowy) — koperta odsyla do niego, zamiast wydawac za to szosta ture.
 *  - Ogonek (c) anulowanie: wysylka kompozytorem (jak w projekcie), ale Stop
 *    klikany natychmiast po znanym `X-Run-Id` — okno czasowe pospiechu jest
 *    czescia konstrukcji (status `cancelled` jest deterministyczny w kazdym
 *    warunku czasowym; zmienna jest tylko koszt modelu, pokrywany wyzej).
 */

const FILE = 'bramka-przekrojowa.spec.ts';
const AGENT_TIMEOUT = 420_000;

const instance = new ScriptedInstance({
  port: 8792,
  dataDirName: '.e2e-real-gate',
  entry: 'production',
  logFile: 'docs/evidence/bramka-przekrojowa/serwer.log',
});
const BASE = instance.baseUrl;

/* -------------------------------------------------------------------------- */
/*  Budget: the same ledger the „model” project books against                 */
/* -------------------------------------------------------------------------- */

/** Turns one clean run of this spec may spend — see the header. */
const BRAMKA_TURNS = 5;

/**
 * The subscription grant that paid for BL-01/BL-02 is **closed** (22 turns, 21
 * spent); it cannot pay this spec, and a run in subscription mode will skip
 * honestly at the preflight rather than spend from a closed grant. GLM is the
 * active provider of v0.4 and books against its own 45-turn grant.
 */
const CLOSED_SUBSCRIPTION_BUDGET = 22;

const ACTIVE_BUDGET = glmMode() ? GLM_TURN_BUDGET : CLOSED_SUBSCRIPTION_BUDGET;

const preflight = budgetPreflight({
  budget: ACTIVE_BUDGET,
  spent: readLedger(ACTIVE_BUDGET).wydane,
  needed: BRAMKA_TURNS,
});
let preflightAnnounced = false;

/** Books one turn, refuses over the ceiling, then sends — in that order. */
async function sendForRun(page: Page, text: string, etap: string) {
  const ledger = readLedger(ACTIVE_BUDGET);
  const nr = ledger.wydane + 1;
  expect(nr, `budzet to ${ACTIVE_BUDGET} ${turnUnit()} — proba wyslania tury ${nr}`).toBeLessThanOrEqual(
    ACTIVE_BUDGET,
  );
  ledger.wydane = nr;
  ledger.tury.push({ nr, o: new Date().toISOString(), proba: 'bramka', polecenie: text, etap });
  ledger.budzet = ACTIVE_BUDGET;
  /* Odmowa pierwsza, zapis drugi — tury, ktora nie opuscila przegladarki,
     nie wolno ksiegowac (lekcja tury 19 w bl01-bl02-model.spec.ts). */
  writeLedger(ledger);
  const sent = await typeCommand(page, text);
  const updated = readLedger(ACTIVE_BUDGET);
  const entry = updated.tury.find((t) => t.nr === nr);
  if (entry) entry.runId = sent.runId;
  writeLedger(updated);
  return sent;
}

/* -------------------------------------------------------------------------- */
/*  The shared envelope — one manifest for every identifier of the chain      */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const EVIDENCE_DIR = resolve(REPO_ROOT, 'docs/evidence/bramka-przekrojowa');
const MANIFEST_PATH = resolve(EVIDENCE_DIR, 'manifest.json');

/**
 * Every identifier the chain produced. Written into the manifest by
 * `saveManifest`, which every test's `finally` calls — a failure at any link
 * leaves the identifiers gathered **so far** on disk, which is what makes the
 * links provably connected rather than independently green.
 */
const gate: {
  identyfikatory: Record<string, unknown>;
  ogon: Record<string, unknown>;
  wynik: string;
} = { identyfikatory: {}, ogon: {}, wynik: 'niezakonczona' };

function saveManifest(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        zapisano: new Date().toISOString(),
        rodzajWykonania: 'rzeczywisty model',
        /* Koperta pochodzenia — ten sam ksztalt co dowody z11 (wersjaKodu). */
        wersjaKodu: codeVersion(undefined, [relative(REPO_ROOT, EVIDENCE_DIR)]),
        srodowisko: environment(),
        zrodlo: providerZrodlo(),
        model: configuredModel(),
        spec: `e2e/${FILE}`,
        przebieg: RUN_STAMP,
        instancja: {
          entry: 'production',
          port: 8792,
          dataDirName: '.e2e-real-gate',
          origin: BASE,
          log: 'docs/evidence/bramka-przekrojowa/serwer.log',
        },
        koszt: (() => {
          const l = readLedger(ACTIVE_BUDGET);
          return { deklarowaneTury: BRAMKA_TURNS, budzet: l.budzet, wydane: l.wydane };
        })(),
        ...gate,
      },
      null,
      2,
    )}\n`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Whitespace-insensitive text, so money formatting cannot flake an assertion. */
const zlep = (s: string): string => s.replace(/[\s\u00a0\u202f]/g, '');

/** \u201e6 wierszy\u201d w dowolnym zgrabnym ujeciu: liczba przed lub po slowu. */
const wierszowSzesc = /6\s*wiersz|wiersz\w*[^.\n]{0,24}\b6\b/i;

/** The case the conversation works on — resolved live, asserted hard. */
async function seedCase(backend: Backend): Promise<{
  caseId: string;
  itemId: string;
  itemVersion: number;
  oldMinor: number;
}> {
  const { cases } = await backend.json<{ cases: Array<{ id: string; code: string }> }>(
    '/api/m/procurement/cases',
  );
  const sprawa = cases.find((c) => c.code === 'PC-2026-01');
  expect(sprawa, 'zasiew nie ma sprawy PC-2026-01').toBeTruthy();
  const detail = await backend.json<{
    offers: Array<{
      offer: { id: string; currency: string };
      supplierName: string;
      items: Array<{ id: string; name: string; unitPriceMinor: number | null; version: number }>;
    }>;
  }>(`/api/m/procurement/cases/${sprawa!.id}`);
  const pozycja =
    detail.offers
      .find((o) => o.supplierName === 'AV Technika Sp. z o.o.')
      ?.items.find((i) => i.name === 'Projektor laserowy 4K EX-5200') ??
    detail.offers[0]?.items.find((i) => typeof i.unitPriceMinor === 'number');
  expect(pozycja, 'sprawa nie ma pozycji z cena jednostkowa').toBeTruthy();
  expect(
    typeof pozycja!.unitPriceMinor,
    `pozycja ${pozycja!.name} nie ma ceny liczbowej`,
  ).toBe('number');
  return {
    caseId: sprawa!.id,
    itemId: pozycja!.id,
    itemVersion: pozycja!.version,
    oldMinor: pozycja!.unitPriceMinor as number,
  };
}

/** The run's tool-name sequence, `mcp__app__` stripped. */
const callSequence = (events: RunEvent[]): string[] =>
  events
    .filter((e) => e.name === 'TOOL_CALL_START')
    .map((e) => String(e.payload?.toolCallName ?? '').replace(/^mcp__app__/, ''));

/**
 * Did the run read the screen back after storing a composition?
 * T27's `readBackAfterViewTool`, local so the view-tool set is this spec's own.
 */
const readBackAfterViewTool = (events: RunEvent[]): boolean => {
  const seq = callSequence(events);
  const stored = seq.findIndex((n) => n === 'agent_view_create' || n === 'canvas_add_card');
  return stored >= 0 && seq.slice(stored + 1).some((n) => n === 'ui_state');
};

/** The platform.data_changed announcement, with the resources it named. */
const dataChangedEvents = (events: RunEvent[]): Array<{ resources: string[] }> =>
  events
    .filter((e) => e.name === 'CUSTOM' && e.payload?.name === 'platform.data_changed')
    .map((e) => {
      const value = (e.payload?.value ?? {}) as { resources?: string[] };
      return { resources: value.resources ?? [] };
    });

/** This conversation's agent-view cards, from the backend. */
const agentViewsOf = (backend: Backend, conversationId: string) =>
  backend.json<{ space: { id: string } | null; cards: Array<Record<string, any>> }>(
    `/api/conversations/${conversationId}/agent-views`,
  );

/* -------------------------------------------------------------------------- */
/*  The gate                                                                  */
/* -------------------------------------------------------------------------- */

test.describe('bramka przekrojowa: jeden powiazany dowod dzialania polaczen', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });

  test.beforeEach(() => {
    if (!preflight.ok && !preflightAnnounced) {
      preflightAnnounced = true;
      console.log(`[e2e] ${preflight.message}`);
    }
    test.skip(!preflight.ok, preflight.ok ? '' : preflight.message);
  });

  test.beforeAll(async () => {
    instance.prepareDatabase();
    await instance.start('-');
  });

  test.afterAll(async () => {
    await instance.stop();
    saveManifest();
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 1 — odczyt i mutacja przez MCP, data_changed, UI, backend        */
  /* ---------------------------------------------------------------------- */

  test('tura 1 — model obniza cene pozycji narzedziem MCP, backend i UI potwierdzaja dokladnie o 1', async ({
    page,
  }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      await openApp(page, BASE);
      const sprawa = await seedCase(backend);
      gate.identyfikatory['sprawa'] = sprawa;

      const polecenie =
        'Znajdz w przykladowych danych sprawe zakupowa o kodzie PC-2026-01. Odczytaj narzedziami MCP ' +
        `(list_cases / get_case / list_offers) cene jednostkowa pozycji „Projektor laserowy 4K EX-5200” ` +
        'od dostawcy AV Technika Sp. z o.o., a nastepnie OBNIZ ta cene o dokladnie 1 (jedna glowna ' +
        'jednostka waluty) narzedziem update_offer_item — podaj expectedVersion odczytany z pozycji. ' +
        'Na koniec napisz jedno zdanie podajac STARA i NOWA cene jednostkowa. Nie zmieniaj niczego innego.';
      const run = await sendForRun(page, polecenie, 'tura-1-mutacja');
      const conversationId = conversationIdOf(page);
      expect(conversationId, 'rozmowa nie ma identyfikatora w adresie').toBeTruthy();
      gate.identyfikatory['rozmowa'] = conversationId;

      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');
      gate.identyfikatory['runTury1'] = run.runId;

      /* (i) narzedzie MCP, nie inne drzwi: run wlasnie je wolal. */
      const events = await backend.runEvents(run.runId);
      /* Narzedzia modulu naleza do nazwy z prefiksem modulu (mcp__app__ zdjete,
       * prefiks domenowy zostaje) — dopasowanie po pelnej nazwie. */
      const updates = callsOf(events, 'procurement_update_offer_item');
      expect(
        updates.length,
        `run nie wolal update_offer_item; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeGreaterThan(0);
      const okUpdate = updates.find((c) => !c.isError);
      expect(okUpdate, 'kazde update_offer_item zakonczylo sie bledem').toBeTruthy();

      /* (ii) zdarzenie data_changed nazwalo zmieniony zasob. */
      const changed = dataChangedEvents(events);
      expect(changed.length, 'run nie oglosil platform.data_changed').toBeGreaterThan(0);
      expect(
        changed.some((c) => c.resources.includes(`case:${sprawa.caseId}`)),
        `data_changed nie nazwalo sprawy: ${JSON.stringify(changed)}`,
      ).toBe(true);

      /* (iii) backend: dokladnie -100 w unitPriceMinor (1 glowna jednostka). */
      const after = await backend.json<{
        offers: Array<{ items: Array<{ id: string; unitPriceMinor: number | null; version: number }> }>;
      }>(`/api/m/procurement/cases/${sprawa.caseId}`);
      const poZmianie = after.offers.flatMap((o) => o.items).find((i) => i.id === sprawa.itemId)!;
      expect(poZmianie.unitPriceMinor, 'cena w backendzie nie obnila sie dokladnie o 1 glowna jednostke').toBe(
        sprawa.oldMinor - 100,
      );
      expect(poZmianie.version, 'wersja pozycji nie wzrosla po mutacji').toBeGreaterThan(sprawa.itemVersion);
      gate.identyfikatory['ceny'] = { staraMinor: sprawa.oldMinor, nowaMinor: poZmianie.unitPriceMinor };

      /* (iv) odpowiedz modelu podaje stara i nowa wartosc zgodna z backendem. */
      const said = zlep(await backend.assistantText(conversationId!));
      expect(said, 'odpowiedz nie podala starej ceny').toContain(String(sprawa.oldMinor / 100));
      expect(said, 'odpowiedz nie podala nowej ceny').toContain(String((sprawa.oldMinor - 100) / 100));

      /* (v) odswiezenie UI: ekran sprawy pokazuje nowa cene. Oczekiwany tekst
         liczony ta sama formuła co formatMinor (grupowanie pl-PL, przecinek,
         dwie cyfry minor, waluta), wiec porownanie jest dokladne. */
      await page.goto(`${BASE}/cases/${sprawa.caseId}`);
      const tabela = page
        .getByTestId('case-detail-page')
        .locator('[data-operation="procurement.case_offer_items"][data-component="DataTable"]');
      await expect(tabela).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
      const nowaWyswietlana = `${((sprawa.oldMinor - 100) / 100).toLocaleString('pl-PL')},00 PLN`;
      await expect(
        tabela.locator(`td[data-record-id="${sprawa.itemId}"][data-field="unitPriceMinor"]`),
      ).toHaveText(nowaWyswietlana);

      gate.wynik = 'tura-1-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 2 — kompozycja: karta widoku agenta, odczytana przez ui_state     */
  /* ---------------------------------------------------------------------- */

  test('tura 2 — model dodaje karte z zestawieniem ofert, zapis kompozycji jest odczytany ui_state', async ({
    page,
  }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const conversationId = gate.identyfikatory['rozmowa'] as string | undefined;
      expect(conversationId, 'tura 2 wymaga rozmowy z tury 1 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${conversationId}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      const polecenie =
        'Dodaj w widokach agenta karte z zestawieniem ofert sprawy PC-2026-01: dostawca, nazwa pozycji ' +
        'i cena jednostkowa.';
      const run = await sendForRun(page, polecenie, 'tura-2-kompozycja');
      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');
      gate.identyfikatory['runTury2'] = run.runId;

      const events = await backend.runEvents(run.runId);
      const zapisy = [...callsOf(events, 'agent_view_create'), ...callsOf(events, 'canvas_add_card')];
      expect(
        zapisy.length,
        `run nie zapisal kompozycji; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeGreaterThan(0);
      const zapis = zapisy[zapisy.length - 1]!;
      expect(zapis.isError, `zapis kompozycji zakonczyl sie bledem: ${zapis.rawResult}`).toBe(false);
      const cardId = (zapis.result as { cardId?: string } | null)?.cardId;
      expect(cardId, 'wynik narzedzia nie niesie cardId').toBeTruthy();
      gate.identyfikatory['karta'] = cardId;

      /* Zapis kompozycji NIE jest narysowaniem jej — agent_view_create mowi to
         wprost polem rendered, a run odczytuje ekran ui_state zanim odpowie
         (wzorzec T27). canvas_add_card nie niesie rendered — warunkowo. */
      if (zapis.name === 'agent_view_create') {
        expect((zapis.result as any).rendered, 'wynik twierdzi, ze karta narysowala kompozycje').toBe(false);
      }
      expect(readBackAfterViewTool(events), 'run nie odczytal ui_state po zapisie kompozycji').toBe(true);

      /* Karta istnieje w przestrzeni TEJ rozmowy i wskazuje te sprawe
         (powiazanie z wykonaniem, jak T27/L3.13). */
      const views = await agentViewsOf(backend, conversationId!);
      const karta = views.cards.find((c) => c.id === cardId);
      expect(karta, 'karty o tym identyfikatorze nie ma w przestrzeni rozmowy').toBeTruthy();
      expectCardPointsAtRecord(
        (karta ?? null) as Parameters<typeof expectCardPointsAtRecord>[0],
        (gate.identyfikatory['sprawa'] as any).caseId,
        'caseId',
      );
      gate.identyfikatory['kompozycja'] = views.cards.map((c) => ({
        id: c.id,
        title: c.title,
        specVersion: c.specVersion,
      }));
      gate.identyfikatory['przestrzenRozmowy'] = views.space?.id ?? null;

      gate.wynik = 'tura-2-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 3 — plik → przetworzenie → trwaly artefakt                        */
  /* ---------------------------------------------------------------------- */

  test('tura 3 — plik CSV dolaczony kompozytorem jest przetworzony i zapisany jako artefakt', async ({
    page,
  }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const conversationId = gate.identyfikatory['rozmowa'] as string | undefined;
      expect(conversationId, 'tura 3 wymaga rozmowy z tury 1 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${conversationId}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      /* Deterministyczny CSV: 6 wierszy danych + naglowek; nic w nazwie pliku
         nie produkuje odpowiedzi. */
      const rows = ['produkt,ilosc,cena'];
      for (const [i, p] of ['A', 'B', 'C', 'D', 'E', 'F'].entries()) {
        rows.push(`${p},${i + 1},${(i + 1) * 10}`);
      }
      const csv = `${rows.join('\n')}\n`;
      await page
        .getByTestId('chat-attach-input')
        .setInputFiles({ name: 'oferty-bramka.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await expect(page.getByTestId('chat-attachment-list')).toContainText('oferty-bramka.csv', {
        timeout: 30_000,
      });

      const polecenie =
        'Przetworz dolaczony plik oferty-bramka.csv: policz liczbe WIERSZY DANYCH (pomijaj wiersz ' +
        'naglowka) i zapisz wynik jako trwaly artefakt narzedziem artifact_create: kind="report", ' +
        'mode="snapshot", rendererType="platform.markdown", a w tresci markdown podaj liczbe wierszy danych. ' +
        'Nie zmieniaj zadnych danych sprawy ani kompozycji.';
      const run = await sendForRun(page, polecenie, 'tura-3-plik-artefakt');
      const { phase, decisions } = await settledDeciding(page, run.runId, () => 'Zgoda');
      expect(phase).toBe('succeeded');
      gate.identyfikatory['runTury3'] = run.runId;
      gate.identyfikatory['zgodyTury3'] = decisions;

      /* Plik przeszedl przez kompozytor do magazynu plikow. */
      const files = await backend.json<{
        files: Array<{ id: string; filename: string; version: number }>;
      }>('/api/files');
      const plik = files.files.find((f) => f.filename === 'oferty-bramka.csv');
      expect(plik, 'pliku CSV nie ma w magazynie plikow').toBeTruthy();
      gate.identyfikatory['plik'] = plik;

      /* Run powiazany z artefaktem z OBU stron: wynik narzedzia runu niesie
         artifactId, a artefakt wskazuje te rozmowe. */
      const events = await backend.runEvents(run.runId);
      const creates = callsOf(events, 'artifact_create');
      expect(
        creates.length,
        `run nie wolal artifact_create; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeGreaterThan(0);
      const created = creates.find((c) => !c.isError);
      expect(created, 'kazde artifact_create zakonczylo sie bledem').toBeTruthy();
      const artifactId = (created!.result as { artifactId?: string } | null)?.artifactId;
      expect(artifactId, 'artifact_create nie zwrocilo artifactId').toBeTruthy();
      gate.identyfikatory['artefakt'] = { id: artifactId };

      const listed = await backend.json<{
        artifacts: Array<{ id: string; threadId: string; kind: string; mode: string }>;
      }>(`/api/artifacts?conversationId=${conversationId}`);
      const artefakt = listed.artifacts.find((a) => a.id === artifactId);
      expect(artefakt, 'artefaktu nie ma na liscie artefaktow tej rozmowy').toBeTruthy();
      expect(artefakt!.threadId, 'artefakt nie jest powiazany z ta rozmowa').toBe(conversationId);

      /* Podglad dostepny i niosacy wynik przeliczenia: liczba 6 w kontekscie
         wierszy — plik ma dokladnie 6 wierszy danych, a polecenie nie zdradzilo
         liczby, wiec trafienie znaczy, ze plik naprawde przeczytal. */
      const podglad = await backend.json<{ content: unknown }>(`/api/artifacts/${artifactId}`);
      const tresc = JSON.stringify(podglad.content ?? {});
      expect(tresc, 'artefakt nie niesie liczby wierszy').toMatch(wierszowSzesc);
      gate.identyfikatory['artefakt'] = { id: artifactId, kind: artefakt!.kind, mode: artefakt!.mode };

      const said = await backend.assistantText(conversationId!);
      expect(said, 'odpowiedz nie podala liczby wierszy').toMatch(wierszowSzesc);

      gate.wynik = 'tura-3-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Restart + tura 4 — kontynuacja TEJ SAMEJ sesji Claude                  */
  /* ---------------------------------------------------------------------- */

  test('tura 4 — po SIGTERM i restarcie rozmowa wznawia te sama sesje i pamta zmiane ceny', async ({
    page,
  }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const conversationId = gate.identyfikatory['rozmowa'] as string | undefined;
      const tura1 = gate.identyfikatory['runTury1'] as string | undefined;
      const ceny = gate.identyfikatory['ceny'] as { staraMinor: number; nowaMinor: number } | undefined;
      expect(conversationId, 'tura 4 wymaga rozmowy z tury 1 (serial)').toBeTruthy();

      /* --------------------------- restart backendu ----------------------- */
      const stopped = await instance.stopWith('SIGTERM');
      expect(stopped.exited, `backend nie zakonczyl sie po SIGTERM (${stopped.ms} ms)`).toBe(true);
      await instance.start('-');
      await page.goto(`${BASE}/?c=${conversationId}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      const runsBefore = await backend.runs(conversationId!);
      const messagesBefore = await backend.messages(conversationId!);
      const sessionBefore = runsBefore.find((r) => r.id === tura1)!.claudeSessionId;
      expect(sessionBefore, 'tura 1 nie zostala powiazana z sesja Claude').toBeTruthy();

      /* ------------------------------ tura 4 ------------------------------ */
      const polecenie =
        'Jaka byla zmiana ceny z pierwszego polecenia tej rozmowy (stara i nowa wartosc) ' +
        'i co pokazuje karta dodana w tej rozmowie? Odpowiedz krotko.';
      const run = await sendForRun(page, polecenie, 'tura-4-kontynuacja');
      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');
      gate.identyfikatory['runTury4'] = run.runId;

      /* Wznowienie, nie nowa sesja. */
      const runsAfter = await backend.runs(conversationId!);
      const czwarta = runsAfter.find((r) => r.id === run.runId)!;
      expect(czwarta.claudeSessionId, 'tura 4 nie ma sesji Claude').toBeTruthy();
      expect(czwarta.claudeSessionId, 'tura 4 odpowiedziala z INNEJ sesji niz tura 1').toBe(sessionBefore);
      gate.identyfikatory['claudeSessionId'] = czwarta.claudeSessionId;

      /* Pamiec pierwszej tury: stara i nowa cena zgodne z backendem tury 1. */
      const said = zlep(await backend.assistantText(conversationId!));
      expect(said, 'odpowiedz nie podala starej ceny z tury 1').toContain(String(ceny!.staraMinor / 100));
      expect(said, 'odpowiedz nie podala nowej ceny z tury 1').toContain(String(ceny!.nowaMinor / 100));

      /* Kontynuacja, nie powielenie: kazda wczesniejsza wiadomosc jest nadal
         tam, dokladnie raz; nowa tura to dokladnie jeden nowy run. */
      const messagesAfter = await backend.messages(conversationId!);
      expect(messagesAfter.length).toBeGreaterThan(messagesBefore.length);
      expect(messagesAfter.filter((m) => messagesBefore.some((b) => b.id === m.id))).toHaveLength(
        messagesBefore.length,
      );
      expect(new Set(messagesAfter.map((m) => m.id)).size).toBe(messagesAfter.length);
      expect(runsAfter.length).toBe(runsBefore.length + 1);

      gate.wynik = 'tura-4-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Ogonek deterministyczny — bez tury modelu, te same identyfikatory      */
  /* ---------------------------------------------------------------------- */

  test('ogonek — odmowa dostepu, konflikt, anulowanie i blad na identyfikatorach bramki', async ({
    page,
  }) => {
    const backend = new Backend(page, BASE);
    try {
      const conversationId = gate.identyfikatory['rozmowa'] as string | undefined;
      const sprawa = gate.identyfikatory['sprawa'] as { caseId: string; itemId: string } | undefined;
      const ceny = gate.identyfikatory['ceny'] as { nowaMinor: number } | undefined;
      expect(conversationId && sprawa, 'ogonek wymaga identyfikatorow z tur 1-4 (serial)').toBeTruthy();
      await openApp(page, BASE, `/?c=${conversationId}`);

      /* ---------------- (a) odmowa dostepu — druga tozsamosc ------------- */
      /* Wzorzec access-context: POST nowej sesji dla 'other-user', potem
         proba odczytu sprawy pierwszej tozsamosci. Osobny kontekst
         przegladarki, wiec sesja glowna tego speca zostaje nietknieta. */
      const alt = await page.context().browser()!.newContext();
      try {
        const sesja = await alt.request.post(`${BASE}/api/auth/session`, {
          data: { userId: 'other-user' },
        });
        expect(sesja.status(), 'nie udalo sie utworzyc sesji drugiej tozsamosci').toBe(200);
        const cudza = await alt.request.get(`${BASE}/api/m/procurement/cases/${sprawa!.caseId}`);
        const cudzaBody = await cudza.text();
        gate.ogon['odmowa'] = {
          status: cudza.status(),
          tresc: cudzaBody.slice(0, 300),
          tozsamosc: 'other-user',
        };
        expect(
          cudza.status(),
          `druga tozsamosc odczytala cudza sprawe: ${cudzaBody.slice(0, 200)}`,
        ).toBe(403);
        expect(cudzaBody, 'odmowa nie nazwala forbidden').toContain('forbidden');
      } finally {
        await alt.close();
      }

      /* ---------------- (b) konflikt — nieaktualny expectedVersion ------- */
      /* Wzorzec domain-guarantees: pisarz, ktoral czytal wczesniej, dostaje
         konflikt, a stan z tury 1 zostaje. */
      const przed = await backend.json<{
        offers: Array<{ items: Array<{ id: string; unitPriceMinor: number | null; version: number }> }>;
      }>(`/api/m/procurement/cases/${sprawa!.caseId}`);
      const pozycja = przed.offers.flatMap((o) => o.items).find((i) => i.id === sprawa!.itemId)!;
      const konflikt = await page.request.patch(`${BASE}/api/m/procurement/items/${sprawa!.itemId}`, {
        data: {
          quantity: 4,
          expectedVersion: pozycja.version + 5,
          operationId: `bramka-konflikt-${Date.now()}`,
        },
      });
      const konfliktBody = await konflikt.text();
      gate.ogon['konflikt'] = { status: konflikt.status(), tresc: konfliktBody.slice(0, 300) };
      expect(konflikt.status(), `oczekiwano 409: ${konfliktBody.slice(0, 200)}`).toBe(409);
      expect(konfliktBody, 'odmowa konfliktu nie nazwala conflict').toContain('conflict');
      /* Odrzucony zapis nic nie zmienil: cena i wersja z tury 1 zostaja. */
      const po = await backend.json<{
        offers: Array<{ items: Array<{ id: string; unitPriceMinor: number | null; version: number }> }>;
      }>(`/api/m/procurement/cases/${sprawa!.caseId}`);
      const poKonflikcie = po.offers.flatMap((o) => o.items).find((i) => i.id === sprawa!.itemId)!;
      expect(poKonflikcie.unitPriceMinor, 'odrzucony zapis zmienil cene').toBe(ceny!.nowaMinor);
      expect(poKonflikcie.version, 'odrzucony zapis zmienil wersje').toBe(pozycja.version);

      /* ---------------- (c) anulowanie — wyslij i kliknij Stop ----------- */
      /* Wysylka kompozytorem (pelna droga uzytkownika), Stop klikany
         natychmiast po znanym runId — run anulowany w kolejce „nigdy nie
         osiagnal modelu”, a status cancelled jest deterministyczny niezaleznie
         od tego, czy zdazyl wystartowac. */
      const request = page.waitForRequest(
        (r) => r.url().endsWith('/api/agui/run') && r.method() === 'POST',
      );
      const composer = page.locator('.openui-agent-thread-composer__input');
      await composer.fill('Odpowiedz tylko: OK.');
      await page.locator('.pf-chat [aria-label="Send message"]').first().click();
      const sent = await request;
      const probeRunId = (await sent.response())?.headers()['x-run-id'];
      expect(probeRunId, 'sonda anulowania: naglowek X-Run-Id').toBeTruthy();
      await page.getByTestId('run-stop').click();
      let sonda: RunRecord | null = null;
      await expect
        .poll(async () => {
          const runs = await backend.runs(conversationId!);
          sonda = runs.find((r) => r.id === probeRunId) ?? null;
          return sonda ? ['succeeded', 'failed', 'cancelled'].includes(sonda.status) : false;
        }, { timeout: 120_000, message: 'sonda anulowania nie osiagnela stanu koncowego' })
        .toBe(true);
      const zakonczone = sonda as unknown as RunRecord;
      gate.ogon['anulowanie'] = {
        runId: probeRunId,
        status: zakonczone.status,
        errorCode: zakonczone.errorCode,
        firstTokenMs: zakonczone.firstTokenMs ?? null,
      };
      expect(zakonczone.status, 'sonda nie zostala anulowana').toBe('cancelled');
      expect(zakonczone.errorCode, 'anulowanie nie zostalo odnotowane jako cancelled').toBe('cancelled');
      /* Strip na ekranie mowi to samo co backend. */
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'cancelled', {
        timeout: 30_000,
      });
      /* Sonda dotknela modelu? Wtedy ksieguje ture (sufit 5 ja pokrywa). */
      if (zakonczone.firstTokenMs != null) {
        const ledger = readLedger(ACTIVE_BUDGET);
        const nr = ledger.wydane + 1;
        expect(nr, `budzet to ${ACTIVE_BUDGET} ${turnUnit()} — sonda anulowania tury ${nr}`).toBeLessThanOrEqual(
          ACTIVE_BUDGET,
        );
        ledger.wydane = nr;
        ledger.tury.push({
          nr,
          o: new Date().toISOString(),
          proba: 'ogon-anulowanie-dotknelo-modelu',
          polecenie: 'Odpowiedz tylko: OK.',
          runId: probeRunId!,
          etap: FILE,
        });
        ledger.budzet = ACTIVE_BUDGET;
        writeLedger(ledger);
      }

      /* ---------------- (d) blad — narzedzie/usluga odpowiada bledem ----- */
      /* Nieistniejaca pozycja przez drzwi modulu (ta sama usluga co
         narzedzie MCP update_offer_item): BLAD, nie wynik. Polowe „blad w
         rozmowie” dowodzi e2e/bl03-model-t15.spec.ts na prawdziwym adapterze. */
      const blad = await page.request.patch(
        `${BASE}/api/m/procurement/items/bramka-pozycja-nie-istnieje`,
        { data: { quantity: 1, expectedVersion: 0 } },
      );
      const bladBody = await blad.text();
      gate.ogon['blad'] = {
        status: blad.status(),
        tresc: bladBody.slice(0, 300),
        polowaWRozmowie: 'e2e/bl03-model-t15.spec.ts (blad narzedzia przez adapter do rozmowy)',
      };
      expect(blad.status(), `oczekiwano 404: ${bladBody.slice(0, 200)}`).toBe(404);
      expect(bladBody, 'blad nie zostal nazwany not_found').toContain('not_found');

      gate.wynik = 'zaliczona';
    } finally {
      saveManifest();
    }
  });
});
