import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import type { Page } from '@playwright/test';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  conversationIdOf,
  openApp,
  settled,
  toolNames,
  typeCommand,
  type CanvasCard,
  type RunEvent,
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
 * T07 i T23 na **prawdziwym modelu** — jedna rozmowa, szesc tur.
 *
 * Rodzaj dowodu: **rzeczywisty model**, na buildzie produkcyjnym
 * (`ScriptedInstance`, `entry: 'production'`), wzorzec: `bramka-przekrojowa`.
 *
 * ## Co ten spec dowodzi
 *
 * **T07 (pelna zmiana UI):** model dodaje karte z zestawieniem ofert sprawy
 * PC-2026-01, zmienia jej tytul, przesuwa ja i usuwa — kazda operacja przez
 * wlasne narzedzie (`canvas_add_card`, `canvas_update_card`, `canvas_move_card`,
 * `canvas_remove_card`) i kazda skorelowana z wykonaniem: `cardId` czytany z
 * `TOOL_CALL_RESULT` tego runu, karta szukana w przestrzeni rozmowy
 * (`/api/conversations/:id/agent-views`), a zastana karta nie zalicza nowego
 * wyniku (odwrotnosc z kanonu). Mutacja tresci (`update`) nie rusza geometrii,
 * przesuniecie (`move`) nie rusza tresci — dwie wersje, dwa liczniki
 * (`specVersion` / `geometryVersion`), jak kazze rozdzial ownership w
 * `@platform/contracts` (`canvas.ts`).
 *
 * **T23 (pokazanie ustawienia):** dwa polecenia pokazania ustawienia „Stan
 * logowania Claude" (`platform.settings.auth` z katalogu celow):
 * wlasciwy widok (`settings-auth` widoczny), widoczne podswietlenie
 * (`data-ui-highlight="true"`, ktore potem gaśnie — konwencja
 * `platform-ui/src/shell/uiReveal.ts`), **potwierdzenie klienta** — POST
 * `/api/runs/:id/ui-ack` zaobserwowany od strony przegladarki, z `executed=true`
 * w tresci i `accepted=true` w odpowiedzi (to ono czyni `ui_navigate`
 * uczciwym: narzedzie nie rozwiazuje sie, dopoki klient nie sprawdzi, co
 * naprawde zrobil) — oraz **wartosc ustawienia bez zmiany**: `auth.method` i
 * `auth.credential.state` z `/api/status` przed pierwszym pokazaniem, po nim i
 * po ponowieniu sa rowne. Druga tura to ponowione zdarzenie nawigacji i
 * kontrola wartosci (odwrotnosc z kanonu: „brak samowolnej zmiany wartosci").
 *
 * ## Koszt i opt-in
 *
 * Koszt: **6 tur** (4 mutacje T07 + 2 T23), deklarowane przed pierwszym
 * poleceniem. Preflight (`budgetPreflight`) odpuszcza CALY spec pominieciem,
 * gdy zostatek grantu nie pokrywa szostki — nic nie idzie do modelu. Opt-in
 * bez zmian: bez `APP_E2E_MODEL=1` zadny projekt nie pasuje do tego pliku
 * (`playwright.config.ts`), wiec domyslny przebieg go w ogole nie laduje.
 *
 * Rejestr tur jest wspolny z pozostalymi specami projektu „model"
 * (`.e2e-model-turns/`; w trybie GLM rejestr `glm.json`, sufit 45). To jest
 * wzorzec bramki (`budgetPreflight` + `ACTIVE_BUDGET`), nie
 * `paidSpecPreflight` z `bl03-model.ts` — ten jest typowany nazwami pakietu
 * Z11 i czytalby w trybie subskrypcyjnym rejestr BL-03, do ktorego ten plik
 * nie nalezy; w trybie GLM oba czytaja ten sam licznik.
 *
 * ## Port 8792
 *
 * `SCENARIO_PORTS` (e2e/support/isolation.ts) rezerwuje 8793-8798; 8792 i 8799
 * sa jedynymi portami niescenariuszowymi (pin: tests/isolation.test.ts), wiec
 * 8792 jest jedynym mozliwym wyborem dla instancji wlasnej — korzysta z niego
 * tez `bramka-przekrojowa` ('.e2e-real-gate') i skryptowany `view-filter`
 * ('.e2e-scripted-filter'). Kolizji nie ma: projekty Playwright wzajemnie sie
 * wykluczaja (chromium albo model, nigdy oba), a w projekcie „model" workers=1
 * i `fullyParallel: false`, wiec bramka (`bramka-...` < `card-...`
 * alfabetycznie) zdazy zwolnic port w swoim `afterAll` zanim ten spec wystartuje.
 * Wlasny katalog danych ('.e2e-real-t07') budowany od zera w `beforeAll`.
 *
 * Uruchomienie wymaga builda produkcyjnego (apps/server/dist), jak kazdy spec
 * z `entry: 'production'` — kolejnosc: `pnpm build`, potem `pnpm test:e2e:model`.
 */

const FILE = 'card-mutations-highlight.spec.ts';
const AGENT_TIMEOUT = 420_000;

const instance = new ScriptedInstance({
  port: 8792,
  dataDirName: '.e2e-real-t07',
  entry: 'production',
  logFile: 'docs/evidence/t07-t23/serwer.log',
});
const BASE = instance.baseUrl;

/* -------------------------------------------------------------------------- */
/*  Budget: the same ledger the „model” project books against (wzorzec bramki) */
/* -------------------------------------------------------------------------- */

/** Turns one clean run of this spec may spend — see the header. */
const SPEC_TURNS = 6;

/**
 * The subscription grant that paid for BL-01/BL-02 is **closed** (22 turns);
 * a run in subscription mode will skip honestly at the preflight rather than
 * spend from a closed grant. GLM is the active provider and books against its
 * own 45-turn grant — the same register every „model" project spec uses.
 */
const CLOSED_SUBSCRIPTION_BUDGET = 22;

const ACTIVE_BUDGET = glmMode() ? GLM_TURN_BUDGET : CLOSED_SUBSCRIPTION_BUDGET;

const preflight = budgetPreflight({
  budget: ACTIVE_BUDGET,
  spent: readLedger(ACTIVE_BUDGET).wydane,
  needed: SPEC_TURNS,
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
  ledger.tury.push({ nr, o: new Date().toISOString(), proba: 't07-t23', polecenie: text, etap });
  ledger.budzet = ACTIVE_BUDGET;
  /* Odmowa pierwsza, zapis drugi — tury, ktora nie opuscila przegladarki,
     nie wolno ksiegowac (wzorzec bramki). */
  writeLedger(ledger);
  const sent = await typeCommand(page, text);
  const updated = readLedger(ACTIVE_BUDGET);
  const entry = updated.tury.find((t) => t.nr === nr);
  if (entry) entry.runId = sent.runId;
  writeLedger(updated);
  return sent;
}

/* -------------------------------------------------------------------------- */
/*  The shared envelope — one manifest for every identifier of the chain       */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const EVIDENCE_DIR = resolve(REPO_ROOT, 'docs/evidence/t07-t23');
const MANIFEST_PATH = resolve(EVIDENCE_DIR, 'manifest.json');

/**
 * Every identifier the chain produced: the conversation, all six runs, the
 * card with its title/spec/geometry at every step, both navigations with the
 * client's acknowledgements and the setting's value at three moments. Written
 * by `saveManifest`, which every test's `finally` calls — a failure at any
 * turn leaves what was gathered **so far** on disk.
 */
const gate: { identyfikatory: Record<string, unknown>; wynik: string } = {
  identyfikatory: {},
  wynik: 'niezakonczona',
};

function saveManifest(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        zapisano: new Date().toISOString(),
        rodzajWykonania: 'rzeczywisty model',
        /* Koperta pochodzenia — ten sam ksztalt co dowody z11/bramki. */
        wersjaKodu: codeVersion(undefined, [relative(REPO_ROOT, EVIDENCE_DIR)]),
        srodowisko: environment(),
        zrodlo: providerZrodlo(),
        model: configuredModel(),
        spec: `e2e/${FILE}`,
        przebieg: RUN_STAMP,
        instancja: {
          entry: 'production',
          port: 8792,
          dataDirName: '.e2e-real-t07',
          origin: BASE,
          log: 'docs/evidence/t07-t23/serwer.log',
        },
        koszt: (() => {
          const l = readLedger(ACTIVE_BUDGET);
          return { deklarowaneTury: SPEC_TURNS, budzet: l.budzet, wydane: l.wydane };
        })(),
        ...gate,
      },
      null,
      2,
    )}\n`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Local helpers (wzorce z bramki przekrojowej)                               */
/* -------------------------------------------------------------------------- */

/** The run's tool-name sequence, `mcp__app__` stripped. */
const callSequence = (events: RunEvent[]): string[] =>
  events
    .filter((e) => e.name === 'TOOL_CALL_START')
    .map((e) => String(e.payload?.toolCallName ?? '').replace(/^mcp__app__/, ''));

/**
 * Did the run read the screen back after storing a composition? (wzorzec T27,
 * lokalnie — jak w bramce).
 */
const readBackAfterViewTool = (events: RunEvent[]): boolean => {
  const seq = callSequence(events);
  const stored = seq.findIndex((n) => n === 'agent_view_create' || n === 'canvas_add_card');
  return stored >= 0 && seq.slice(stored + 1).some((n) => n === 'ui_state');
};

/** This conversation's agent-view cards, from the backend. */
const agentViewsOf = (backend: Backend, conversationId: string) =>
  backend.json<{ space: { id: string } | null; cards: AgentViewCard[] }>(
    `/api/conversations/${conversationId}/agent-views`,
  );

/** The endpoint returns full canvas cards — both version counters included. */
type AgentViewCard = CanvasCard & { spaceId: string; geometryVersion: number };

/** POST body of the browser's ui-ack, read without trusting it to parse. */
const ackBodyOf = (r: { request: () => { postData: () => string | null } }) => {
  const raw = r.request().postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { executed?: boolean; reason?: string };
  } catch {
    return null;
  }
};

/** The setting's value, read the way ui-navigation reads it: from the API. */
const statusOf = (backend: Backend) =>
  backend.json<{ auth: { method: string; credential: { state: string } } }>('/api/status');

/** Tytul karty po zmianie — dokladnie ten, o ktory prosza polecenie. */
const NOWY_TYTUL = 'Zmieniona — T07';

test.describe('T07 + T23: mutacje karty i pokazanie ustawienia na prawdziwym modelu', () => {
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
  /*  Tura 1 (T07) — dodanie karty z zestawieniem ofert                     */
  /* ---------------------------------------------------------------------- */

  test('tura 1 — model dodaje karte z zestawieniem ofert w przestrzeni rozmowy', async ({ page }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      await openApp(page, BASE);

      /* Zastany stan: zadna istniejaca przestrzen ownera nie ma karty, ktora
         tura dopiero stworzy — odwrotnosc z kanonu T07 („zastana karta nie
         zalicza nowego wyniku”). Rozmowa powstaje dopiero przy wysylce, wiec
         „przed” jest zbiorem kart wszystkich zastanych przestrzeni. */
      const przestrzeniePrzed = await backend.spaces();
      const kartyPrzed = (
        await Promise.all(przestrzeniePrzed.map((s) => backend.cards(s.id)))
      ).flat();

      const polecenie =
        'Dodaj w widokach agenta karte z zestawieniem ofert sprawy PC-2026-01: dostawca, nazwa pozycji ' +
        'i cena jednostkowa.';
      const run = await sendForRun(page, polecenie, 'tura-1-dodanie');
      const cid = conversationIdOf(page);
      expect(cid, 'rozmowa nie ma identyfikatora w adresie').toBeTruthy();
      gate.identyfikatory['rozmowa'] = cid;
      gate.identyfikatory['runTury1'] = run.runId;

      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');

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
      gate.identyfikatory['narzedzieZapisu'] = zapis.name;

      /* Zapis kompozycji NIE jest narysowaniem jej — run odczytuje ekran
         ui_state zanim odpowie (wzorzec T27). */
      expect(readBackAfterViewTool(events), 'run nie odczytal ui_state po zapisie kompozycji').toBe(true);

      /* Karta istnieje w przestrzeni TEJ rozmowy — i to jest NOWY obiekt. */
      const views = await agentViewsOf(backend, cid!);
      const karta = views.cards.find((c) => c.id === cardId);
      expect(karta, 'karty o tym identyfikatorze nie ma w przestrzeni rozmowy').toBeTruthy();
      expect(
        kartyPrzed.some((c) => c.id === cardId),
        'karta istniala juz przed poleceniem — zastany element nie zalicza proby',
      ).toBe(false);
      gate.identyfikatory['przestrzenRozmowy'] = views.space?.id ?? null;
      gate.identyfikatory['karta'] = {
        cardId,
        narzedzie: zapis.name,
        tytul: karta!.title,
        komponent: karta!.spec.component ?? null,
        spec: karta!.spec,
        specVersion: karta!.specVersion,
        geometryVersion: karta!.geometryVersion,
        geometry: karta!.geometry,
      };
      gate.identyfikatory['kompozycjaTury1'] = views.cards.map((c) => ({ id: c.id, title: c.title }));

      gate.wynik = 'tura-1-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 2 (T07) — zmiana tytulu przez model                              */
  /* ---------------------------------------------------------------------- */

  test('tura 2 — model zmienia tytul karty, cardId i tresc zostaja', async ({ page }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const cid = gate.identyfikatory['rozmowa'] as string | undefined;
      const karta = gate.identyfikatory['karta'] as
        | { cardId: string; tytul: string; spec: unknown; specVersion: number }
        | undefined;
      expect(cid && karta, 'tura 2 wymaga rozmowy i karty z tury 1 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${cid}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      const polecenie =
        'Zmien tytul karty dodanej w poprzednim poleceniu tej rozmowy na doslownie „Zmieniona — T07”. ' +
        'Tresci karty nie zmieniaj — ma dalej pokazywac to samo zestawienie ofert.';
      const run = await sendForRun(page, polecenie, 'tura-2-tytul');
      gate.identyfikatory['runTury2'] = run.runId;
      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');

      const events = await backend.runEvents(run.runId);
      const updates = callsOf(events, 'canvas_update_card');
      expect(
        updates.length,
        `run nie wolal canvas_update_card; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeGreaterThan(0);
      const update = updates[updates.length - 1]!;
      expect(update.isError, `canvas_update_card zakonczyl sie bledem: ${update.rawResult}`).toBe(false);
      /* Ten sam obiekt, nie nowa karta. */
      expect((update.result as { cardId?: string } | null)?.cardId, 'update dotknal innej karty').toBe(
        karta!.cardId,
      );

      const views = await agentViewsOf(backend, cid!);
      const poZmianie = views.cards.find((c) => c.id === karta!.cardId);
      expect(poZmianie, 'karta zniknela po zmianie tytulu').toBeTruthy();
      expect(poZmianie!.title, 'tytul w kompozycji nie rowna sie zadany').toBe(NOWY_TYTUL);
      expect(
        poZmianie!.specVersion,
        'specVersion nie wzrosl po zmianie tresci',
      ).toBeGreaterThan(karta!.specVersion);
      /* Tresc poza tytulem nietknieta — karta, ktora stracila komponent,
         tez mialaby nowy tytul (obserwacja z przebiegu A pakietu BL-03). */
      expect(poZmianie!.spec, 'tresc karty zmienila sie razem z tytulem').toEqual(karta!.spec);
      gate.identyfikatory['zmianaTytulu'] = {
        przed: { tytul: karta!.tytul, specVersion: karta!.specVersion },
        po: { tytul: poZmianie!.title, specVersion: poZmianie!.specVersion },
      };

      gate.wynik = 'tura-2-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 3 (T07) — przesuniecie przez model                               */
  /* ---------------------------------------------------------------------- */

  test('tura 3 — model przesuwa karte o dwie komorki w prawo i jedna w dol', async ({ page }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const cid = gate.identyfikatory['rozmowa'] as string | undefined;
      const karta = gate.identyfikatory['karta'] as
        | { cardId: string; spec: unknown; specVersion: number }
        | undefined;
      const zmiana = gate.identyfikatory['zmianaTytulu'] as
        | { po: { specVersion: number } }
        | undefined;
      expect(cid && karta, 'tura 3 wymaga rozmowy i karty z tury 1 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${cid}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      const viewsPrzed = await agentViewsOf(backend, cid!);
      const przed = viewsPrzed.cards.find((c) => c.id === karta!.cardId);
      expect(przed, 'karty nie ma w przestrzeni przed przesunieciem').toBeTruthy();

      /* „Komorka" nie istnieje w kontrakcie kanwy (geometria jest w pikselach,
         bez siatki), wiec polecenie ja definiuje — tura nie moze zalezec od
         mojego zalozenia, ile model znaczy przez komorke. */
      const polecenie =
        'Przesun karte z poprzednich polecen o dwie komorki w prawo i jedna w dol ' +
        '(komorka siatki tej kanwy ma 80 pikseli). Tresci karty i jej tytulu nie zmieniaj.';
      const run = await sendForRun(page, polecenie, 'tura-3-przesuniecie');
      gate.identyfikatory['runTury3'] = run.runId;
      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');

      const events = await backend.runEvents(run.runId);
      const moves = callsOf(events, 'canvas_move_card');
      expect(
        moves.length,
        `run nie wolal canvas_move_card; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeGreaterThan(0);
      const move = moves[moves.length - 1]!;
      expect(move.isError, `canvas_move_card zakonczyl sie bledem: ${move.rawResult}`).toBe(false);
      expect((move.result as { cardId?: string } | null)?.cardId, 'przesuniecie dotknelo innej karty').toBe(
        karta!.cardId,
      );

      /* Geometria zgodna z poleceniem: dokladnie +160 w x, +80 w y. */
      const geo = (move.result as { geometry?: { x: number; y: number } } | null)?.geometry;
      expect(geo, 'wynik przesuniecia nie niesie geometrii').toBeTruthy();
      const dx = geo!.x - przed!.geometry.x;
      const dy = geo!.y - przed!.geometry.y;
      expect(dx, `przesuniecie w prawo nie rowna sie 2 komorkom (dx=${dx})`).toBe(160);
      expect(dy, `przesuniecie w dol nie rowna sie 1 komorce (dy=${dy})`).toBe(80);

      /* Kompozycja w przestrzeni rozmowy mowi to samo. */
      const views = await agentViewsOf(backend, cid!);
      const poPrzesunieciu = views.cards.find((c) => c.id === karta!.cardId);
      expect(poPrzesunieciu, 'karta zniknela po przesunieciu').toBeTruthy();
      expect(poPrzesunieciu!.geometry.x).toBe(geo!.x);
      expect(poPrzesunieciu!.geometry.y).toBe(geo!.y);
      /* Tresc i jej wersja nietkniete; przesuniecie ma wlasny licznik. */
      expect(poPrzesunieciu!.title).toBe(NOWY_TYTUL);
      expect(poPrzesunieciu!.spec).toEqual(karta!.spec);
      expect(poPrzesunieciu!.specVersion, 'przesuniecie zmienilo specVersion').toBe(zmiana!.po.specVersion);
      expect(
        poPrzesunieciu!.geometryVersion,
        'przesuniecie nie podnioslo geometryVersion',
      ).toBeGreaterThan(przed!.geometryVersion);
      gate.identyfikatory['przesuniecie'] = {
        przed: { x: przed!.geometry.x, y: przed!.geometry.y, geometryVersion: przed!.geometryVersion },
        po: {
          x: poPrzesunieciu!.geometry.x,
          y: poPrzesunieciu!.geometry.y,
          geometryVersion: poPrzesunieciu!.geometryVersion,
        },
        dx,
        dy,
      };

      gate.wynik = 'tura-3-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 4 (T07) — usuniecie przez model                                  */
  /* ---------------------------------------------------------------------- */

  test('tura 4 — model usuwa karte, reszta kompozycji zostaje', async ({ page }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const cid = gate.identyfikatory['rozmowa'] as string | undefined;
      const karta = gate.identyfikatory['karta'] as { cardId: string } | undefined;
      expect(cid && karta, 'tura 4 wymaga rozmowy i karty z tury 1 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${cid}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      const kartyPrzed = (await agentViewsOf(backend, cid!)).cards.map((c) => c.id);

      const polecenie = 'Usun z widokow agenta te karte, ktora dodales w tej rozmowie.';
      const run = await sendForRun(page, polecenie, 'tura-4-usuniecie');
      gate.identyfikatory['runTury4'] = run.runId;
      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');

      const events = await backend.runEvents(run.runId);
      const removals = callsOf(events, 'canvas_remove_card');
      expect(
        removals.length,
        `run nie wolal canvas_remove_card; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeGreaterThan(0);
      const removal = removals[removals.length - 1]!;
      expect(removal.isError, `canvas_remove_card zakonczyl sie bledem: ${removal.rawResult}`).toBe(false);
      expect((removal.result as { removed?: string } | null)?.removed, 'usunieto inna karte').toBe(
        karta!.cardId,
      );

      /* Karty brak w przestrzeni rozmowy; inne karty nietknięte. */
      const kartyPo = (await agentViewsOf(backend, cid!)).cards.map((c) => c.id);
      expect(kartyPo, 'usunieta karta dalej jest w przestrzeni rozmowy').not.toContain(karta!.cardId);
      expect(
        kartyPo.filter((id) => !kartyPrzed.includes(id)),
        'po usunieciu przybyly nowe karty',
      ).toEqual([]);
      expect(
        kartyPrzed.filter((id) => !kartyPo.includes(id)),
        'usunieto wiecej niz jedna karte',
      ).toEqual([karta!.cardId]);
      gate.identyfikatory['usuniecie'] = {
        cardId: karta!.cardId,
        kartyPrzed,
        kartyPo,
      };

      gate.wynik = 'tura-4-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 5 (T23) — pokazanie ustawienia: widok, podswietlenie, ui-ack     */
  /* ---------------------------------------------------------------------- */

  test('tura 5 — model pokazuje ustawienie: widok, podswietlenie, potwierdzenie klienta', async ({
    page,
  }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const cid = gate.identyfikatory['rozmowa'] as string | undefined;
      expect(cid, 'tura 5 wymaga rozmowy z tury 1 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${cid}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      /* WARTOSC USTAWIENIA PRZED — ta sama droga odczytu co skryptowany
         wzorzec (e2e/ui-navigation.spec.ts): /api/status. */
      const przed = await statusOf(backend);

      /* Potwierdzenie klienta lapiane od strony przegladarki: POST, ktorym
         klient sprawuje ui_navigate (app.ts: „the tool does not resolve until
         this arrives”). */
      const ackPromise = page.waitForResponse(
        (r) => r.url().includes('/api/runs/') && r.url().endsWith('/ui-ack'),
        { timeout: AGENT_TIMEOUT },
      );

      const polecenie =
        'Pokaz mi ustawienie „Stan logowania Claude” — otworz wlasciwy widok Ustawien i podswietl ' +
        'ta sekcje. Niczego nie zmieniaj.';
      const run = await sendForRun(page, polecenie, 'tura-5-pokazanie-ustawienia');
      gate.identyfikatory['runTury5'] = run.runId;

      /* Podswietlenie jest widoczne i to jest realny markup, nie deklaracja —
         asercja ZANIM settled: highlight trwa 2,6 s od nawigacji
         (HIGHLIGHT_MS w uiReveal.ts). */
      const target = page.getByTestId('settings-auth');
      await expect(target).toBeVisible({ timeout: AGENT_TIMEOUT });
      await expect(target).toHaveAttribute('data-ui-highlight', 'true', { timeout: 10_000 });

      const ack = await ackPromise;
      const ackBody = ackBodyOf(ack);
      const ackAnswer = (await ack.json().catch(() => null)) as { accepted?: boolean } | null;
      gate.identyfikatory['nawigacjaTury5'] = {
        potwierdzenieKlienta: {
          status: ack.status(),
          executed: ackBody?.executed ?? null,
          reason: ackBody?.reason ?? null,
          accepted: ackAnswer?.accepted ?? null,
        },
      };
      expect(ackBody?.executed, 'klient potwierdzil ui_navigate jako niewykonane').toBe(true);
      expect(ackAnswer?.accepted, 'serwer nie przyjal potwierdzenia klienta').toBe(true);

      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');

      const events = await backend.runEvents(run.runId);
      const navigations = callsOf(events, 'ui_navigate');
      const shown = navigations.find(
        (c) => (c.args as { targetId?: string } | null)?.targetId === 'platform.settings.auth',
      );
      expect(
        shown,
        `ui_navigate nie pokazal ustawienia; wolane narzedzia: ${toolNames(events).join(', ') || '(zadne)'}`,
      ).toBeTruthy();
      expect((shown!.result as { executed?: boolean } | null)?.executed).toBe(true);
      expect((shown!.result as { highlighted?: boolean } | null)?.highlighted).toBe(true);

      /* WARTOSC USTAWIENIA PO — pokazanie niczego nie zmienia. */
      const po = await statusOf(backend);
      expect(po.auth.method, 'pokazanie ustawienia zmienilo sposob logowania').toBe(przed.auth.method);
      expect(
        po.auth.credential.state,
        'pokazanie ustawienia zmienilo stan poswiadczenia',
      ).toBe(przed.auth.credential.state);
      gate.identyfikatory['ustawienie'] = {
        cel: 'platform.settings.auth',
        api: '/api/status: auth.method, auth.credential.state',
        przedTury5: { method: przed.auth.method, stanPoswiadczenia: przed.auth.credential.state },
        poTury5: { method: po.auth.method, stanPoswiadczenia: po.auth.credential.state },
      };

      /* Podswietlenie jest tymczasowe, nie trwaly slad na kontrolce. */
      await expect(target).not.toHaveAttribute('data-ui-highlight', 'true', { timeout: 15_000 });

      gate.wynik = 'tura-5-zaliczona';
    } finally {
      saveManifest();
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Tura 6 (T23) — ponowiona nawigacja i kontrola wartosci                */
  /* ---------------------------------------------------------------------- */

  test('tura 6 — ponowione pokazanie ustawienia, wartosc nadal bez zmian', async ({ page }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      const cid = gate.identyfikatory['rozmowa'] as string | undefined;
      const ustawienie = gate.identyfikatory['ustawienie'] as
        | { przedTury5: { method: string; stanPoswiadczenia: string }; poTury5: { method: string } }
        | undefined;
      expect(cid && ustawienie, 'tura 6 wymaga rozmowy i pomiaru z tury 5 (serial)').toBeTruthy();
      await page.goto(`${BASE}/?c=${cid}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      const kompozycjaPrzed = (await agentViewsOf(backend, cid!)).cards.map((c) => c.id);

      const ackPromise = page.waitForResponse(
        (r) => r.url().includes('/api/runs/') && r.url().endsWith('/ui-ack'),
        { timeout: AGENT_TIMEOUT },
      );

      const polecenie =
        'Pokaz jeszcze raz ustawienie „Stan logowania Claude” i sprawdz, czy sposob logowania ma ' +
        'nadal te sama wartosc co przed chwila. Nie opisuj drogi — po prostu otworz to ustawienie. ' +
        'Niczego nie zmieniaj.';
      const run = await sendForRun(page, polecenie, 'tura-6-kontrola-wartosci');
      gate.identyfikatory['runTury6'] = run.runId;

      /* Ponowione zdarzenie: nawigacja i podswietlenie znow realne. */
      const target = page.getByTestId('settings-auth');
      await expect(target).toBeVisible({ timeout: AGENT_TIMEOUT });
      await expect(target).toHaveAttribute('data-ui-highlight', 'true', { timeout: 10_000 });

      const ack = await ackPromise;
      const ackBody = ackBodyOf(ack);
      const ackAnswer = (await ack.json().catch(() => null)) as { accepted?: boolean } | null;
      expect(ackBody?.executed, 'klient potwierdzil ponowna nawigacje jako niewykonana').toBe(true);
      expect(ackAnswer?.accepted, 'serwer nie przyjal potwierdzenia').toBe(true);

      const phase = await settled(page, run.runId);
      expect(phase).toBe('succeeded');

      const events = await backend.runEvents(run.runId);
      const shown = callsOf(events, 'ui_navigate').find(
        (c) => (c.args as { targetId?: string } | null)?.targetId === 'platform.settings.auth',
      );
      expect(shown, 'ponowna nawigacja nie nazwala celu platform.settings.auth').toBeTruthy();
      expect((shown!.result as { executed?: boolean } | null)?.executed).toBe(true);
      /* Kontrola: zadne narzedzie o efekcie write w turze kontrolnej — pelna
         lista z deklaracji narzedzi platformy (canvas, agent-views, artefakty,
         pliki). */
      const zapisy = toolNames(events).filter((n) =>
        [
          'canvas_add_card',
          'canvas_update_card',
          'canvas_move_card',
          'canvas_remove_card',
          'agent_view_create',
          'agent_view_update',
          'agent_view_remove',
          'artifact_create',
          'artifact_publish_file',
          'files_publish_version',
        ].includes(n),
      );
      expect(zapisy, `tura kontrolna cos zapisala: ${zapisy.join(', ')}`).toEqual([]);

      /* Wartosc po ponowieniu — rowna sie obu wczesniejszym pomiaram. */
      const po = await statusOf(backend);
      expect(po.auth.method, 'sposob logowania zmienil sie po ponownym pokazaniu').toBe(
        ustawienie!.przedTury5.method,
      );
      expect(
        po.auth.credential.state,
        'stan poswiadczenia zmienil sie po ponownym pokazaniu',
      ).toBe(ustawienie!.przedTury5.stanPoswiadczenia);

      /* Kompozycja rozmowy nietknieta przez obie tury T23. */
      const kompozycjaPo = (await agentViewsOf(backend, cid!)).cards.map((c) => c.id);
      expect(kompozycjaPo, 'tury T23 zmienily kompozycje rozmowy').toEqual(kompozycjaPrzed);

      gate.identyfikatory['ustawienie'] = {
        ...ustawienie,
        poTury6: { method: po.auth.method, stanPoswiadczenia: po.auth.credential.state },
        ponownePotwierdzenie: {
          status: ack.status(),
          executed: ackBody?.executed ?? null,
          accepted: ackAnswer?.accepted ?? null,
        },
      };

      gate.wynik = 'zaliczona';
    } finally {
      saveManifest();
    }
  });
});
