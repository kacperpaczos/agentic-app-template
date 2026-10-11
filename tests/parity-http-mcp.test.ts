import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallContext } from '@platform/contracts';
import { createHarness, caseCode, login, type Harness } from './helpers.ts';

/**
 * L9.2 — parzystosc drzwi: endpointy HTTP i narzedzia MCP wobec TYCH SAMYCH
 * regul walidacji i mutacji.
 *
 * Macierz jest deklaratywna: (operacja, przypadek) -> {mcp, http, expected}.
 * Sterownik wywoluje obie drogi produkcyjnie — MCP przez `registry.callTool`
 * (to samo wykonanie `executeTool`, ktore robi serwer MCP), HTTP przez
 * `app.request('/api/m/procurement/...')` — i wymaga:
 *
 *  - dla `expected: kod` — IDENTYCZNEGO kodu bledu oboma drzwiami (transport
 *    rozni sie tylko odpowiedzia: HTTP status 400/403/409/422 vs MCP odrzucenie
 *    z kodem),
 *  - dla `expected: 'ok'` — zgodnosci kluczowych pol wyniku,
 *  - dla przypadkow, ktorych jedna z drzwi nie moze wyrazic — JAWNEGO
 *    `httpDoorMissing` / `noHttpPair` (asymetria udokumentowana, nie porazka).
 *
 * Tokeny `{caseId}`, `{itemIdA}`, `{versionA}` itd. rozwiazywane sa z fabuły
 * w chwili wywolania (domyslnie raz na wiersz; `resolvePerDoor` — osobno dla
 * kazdego drzwi, gdy kazde drzwi maja zapisac swieza wersje).
 */

const EMPTY_APP_CONTEXT = {
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

/** Kody bledu -> statusy HTTP (zrodlo prawdy: ERROR_HTTP_STATUS w contracts). */
const HTTP_STATUS = {
  validation_failed: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  domain_rule_violated: 422,
} as const;

type Expected = 'ok' | keyof typeof HTTP_STATUS;

interface HttpCall {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

interface MatrixRow {
  /** Nazwa narzedzia MCP bez prefiksu `procurement_`. */
  op: string;
  scenario: string;
  expected: Expected;
  /** `null` = drzwi MCP nie biora udzialu (jawna asymetria). */
  mcp?: { input: unknown } | null;
  /** `null` = drzwi HTTP nie biora udzialu (jawna asymetria). */
  http?: HttpCall | null;
  mcpAsOther?: boolean;
  httpAsOther?: boolean;
  /**
   * Przypadku nie da sie przez te drzwi wyrazic wogole (np. pusty segment
   * sciezki nie pasuje do trasy): oczekujemy braku trasy (404 bez JSON-u
   * AppError), a nie porownania kodow.
   */
  httpDoorMissing?: boolean;
  /**
   * Drzwi istnieja i odpowiadaja 200, ale przypadku nie da sie porownac
   * (asymetria udokumentowana, np. GET /cases nie przyjmuje okna odczytu).
   */
  noHttpPair?: boolean;
  /** Tokeny wersji rozwiazywane osobno dla kazdego drzwi (swiezy odczyt). */
  resolvePerDoor?: boolean;
  setup?: () => void | Promise<void>;
  /** Dla `expected: 'ok'`: zgodnosc kluczowych pol wyniku. */
  compare?: (mcp: unknown, http: unknown) => void;
  /** Dla powtorzen: dokladnie jeden skutek. */
  effectCheck?: (mcp: unknown, http: unknown) => void;
}

describe('L9.2 parzystosc HTTP/MCP: te same reguly walidacji i mutacji', () => {
  let h: Harness;
  let cookie: string;
  let otherCookie: string;
  let caseId: string;
  let itemA: { id: string };
  let itemB: { id: string };
  const scratch: { staleVersion?: number } = {};

  const itemVersion = (id: string) => h.service.repo.getItem(id, h.ownerId).item.version;

  const tokens: Record<string, () => string | number | undefined> = {
    '{caseId}': () => caseId,
    '{itemIdA}': () => itemA.id,
    '{itemIdB}': () => itemB.id,
    '{versionA}': () => itemVersion(itemA.id),
    '{versionB}': () => itemVersion(itemB.id),
    '{staleVersionA}': () => scratch.staleVersion,
  };

  /** Podmienia tokeny w calej strukturze; calosc-token zwraca surowa wartosc (tez liczbe). */
  const subst = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const exact = Object.entries(tokens).find(([k]) => v === k);
      if (exact) return exact[1]();
      let out: string = v;
      for (const [k, get] of Object.entries(tokens)) {
        if (out.includes(k)) out = out.replaceAll(k, String(get()));
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(subst);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, subst(val)]));
    }
    return v;
  };

  const toolCtx = (ownerId: string): ToolCallContext => ({
    ownerId,
    appContext: EMPTY_APP_CONTEXT,
    conversationId: null,
    runId: null,
    workspaceDir: null,
    emit: () => {},
  });

  /** Drzwi MCP: to samo wykonanie, ktore robi serwer MCP dla modelu. */
  const callMcp = async (tool: string, input: unknown, asOther = false) => {
    try {
      const out = await h.platform.registry.callTool(
        `procurement_${tool}`,
        input as Record<string, unknown>,
        toolCtx(asOther ? h.otherOwnerId : h.ownerId),
      );
      return { ok: true as const, out };
    } catch (err) {
      return { ok: false as const, code: (err as { code?: string })?.code ?? 'internal', err };
    }
  };

  /** Drzwi HTTP: brak trasy (404 tekstowy, bez JSON AppError) = brak drzwi. */
  const callHttp = async (call: HttpCall, asOther = false) => {
    const res = await h.platform.app.request(call.path, {
      method: call.method,
      headers: {
        cookie: asOther ? otherCookie : cookie,
        ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Domyslna odpowiedz Hono dla brakujacej trasy to tekst, nie JSON.
    }
    const code = (parsed as { error?: { code?: string } } | null)?.error?.code;
    return {
      status: res.status,
      code,
      body: parsed,
      doorMissing: res.status === 404 && !code,
    };
  };

  beforeAll(async () => {
    h = await createHarness();
    cookie = await login(h.platform.app, h.ownerId);
    otherCookie = await login(h.platform.app, h.otherOwnerId);
    caseId = h.service.repo.findCaseByCode(caseCode, h.ownerId)!.id;
    const detail = h.service.getCaseDetail(caseId, h.ownerId);
    itemA = { id: detail.offers.find((o) => o.supplierName.startsWith('AV Technika'))!.items[0]!.id };
    itemB = { id: detail.offers.find((o) => o.supplierName.startsWith('MediaPro'))!.items[0]!.id };
  });
  afterAll(() => h.dispose());

  /* ------------------------- MACIERZ PARZYSTOSCI ------------------------- */
  /* Kazdy wiersz: (operacja, przypadek) -> oczekiwany wspolny wynik obu drzwi. */

  const ROWS: MatrixRow[] = [
    /* ------------------------------ list_cases ---------------------------- */
    {
      op: 'list_cases',
      scenario: 'ok — ta sama lista spraw',
      expected: 'ok',
      mcp: { input: {} },
      http: { method: 'GET', path: '/api/m/procurement/cases' },
      compare: (mcp, http) => {
        expect((mcp as { cases: Array<{ code: string }> }).cases.map((c) => c.code)).toEqual(
          (http as { cases: Array<{ code: string }> }).cases.map((c) => c.code),
        );
      },
    },
    {
      op: 'list_cases',
      scenario: 'okno odczytu (limit=1) — HTTP /cases nie przyjmuje okna',
      expected: 'ok',
      mcp: { input: { limit: 1 } },
      http: { method: 'GET', path: '/api/m/procurement/cases' },
      noHttpPair: true,
      compare: (mcp) => {
        // Drzwi MCP stronicuja i mowia, co zostawily; HTTP zwraca calosc.
        expect((mcp as { window: { total: number; truncated: boolean } }).window.total).toBeGreaterThan(0);
      },
    },

    /* ------------------------------- get_case ----------------------------- */
    {
      op: 'get_case',
      scenario: 'ok — te same szczegoly sprawy',
      expected: 'ok',
      mcp: { input: { caseId: '{caseId}' } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}' },
      compare: (mcp, http) => {
        const m = mcp as { case: { id: string; code: string }; criteria: unknown[] };
        const d = http as { procurementCase: { id: string; code: string }; criteria: unknown[] };
        expect(m.case.id).toBe(d.procurementCase.id);
        expect(m.case.code).toBe(d.procurementCase.code);
        expect(m.criteria).toHaveLength(d.criteria.length);
      },
    },
    {
      op: 'get_case',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { caseId: '{caseId}' }, },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}' },
      mcpAsOther: true,
      httpAsOther: true,
    },
    {
      op: 'get_case',
      scenario: 'caseId pusty ciag — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '' } },
      /*
       * Pustego segmentu sciezki nie da sie wyrazic w trasie HTTP — realna trasa
       * /cases/:caseId z pustym id nie pasuje (brak pary drzwi dla tego
       * przypadku), wiec po stronie HTTP oczekujemy braku trasy, nie kodu.
       */
      http: { method: 'GET', path: '/api/m/procurement/cases/' },
      httpDoorMissing: true,
    },

    /* ------------------------------ list_offers --------------------------- */
    {
      op: 'list_offers',
      scenario: 'ok — ta sama lista ofert z ta sama uscisloscia wyniku',
      expected: 'ok',
      mcp: { input: { caseId: '{caseId}' } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/offers' },
      compare: (mcp, http) => expect(mcp).toEqual(http),
    },
    {
      op: 'list_offers',
      scenario: 'limit=0 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', limit: 0 } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/offers?limit=0' },
    },
    {
      op: 'list_offers',
      scenario: 'limit=101 ponad sufit okna 100 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', limit: 101 } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/offers?limit=101' },
    },
    {
      op: 'list_offers',
      scenario: "limit='-1' — naruszenie schematu",
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', limit: -1 } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/offers?limit=-1' },
    },
    {
      op: 'list_offers',
      scenario: "limit='abc' — naruszenie schematu",
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', limit: 'abc' } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/offers?limit=abc' },
    },
    {
      op: 'list_offers',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { caseId: '{caseId}' } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/offers' },
      mcpAsOther: true,
      httpAsOther: true,
    },

    /* ----------------------------- compare_offers ------------------------- */
    {
      op: 'compare_offers',
      scenario: 'ok — identyczne sumy',
      expected: 'ok',
      mcp: { input: { caseId: '{caseId}' } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/comparison' },
      compare: (mcp, http) => {
        const totals = (r: unknown) =>
          (r as { rows: Array<{ supplierName: string; totalMinor: number | null }> }).rows
            .map((x) => [x.supplierName, x.totalMinor])
            .sort();
        expect(totals(mcp)).toEqual(totals(http));
      },
    },
    {
      op: 'compare_offers',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { caseId: '{caseId}' } },
      http: { method: 'GET', path: '/api/m/procurement/cases/{caseId}/comparison' },
      mcpAsOther: true,
      httpAsOther: true,
    },
    {
      op: 'compare_offers',
      scenario: 'caseId pusty ciag — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '' } },
      httpDoorMissing: true,
      http: { method: 'GET', path: '/api/m/procurement/cases//comparison' },
    },

    /* ------------------------ find_price_provenance ----------------------- */
    {
      op: 'find_price_provenance',
      scenario: 'ok — to samo pochodzenie ceny',
      expected: 'ok',
      mcp: { input: { itemId: '{itemIdA}' } },
      http: { method: 'GET', path: '/api/m/procurement/items/{itemIdA}/provenance' },
      compare: (mcp, http) => {
        const m = mcp as { supplier: { name: string }; provenance: unknown[] };
        const d = http as { supplier: { name: string }; provenance: unknown[] };
        expect(m.supplier.name).toBe(d.supplier.name);
        expect(m.provenance).toHaveLength(d.provenance.length);
      },
    },
    {
      op: 'find_price_provenance',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { itemId: '{itemIdA}' } },
      http: { method: 'GET', path: '/api/m/procurement/items/{itemIdA}/provenance' },
      mcpAsOther: true,
      httpAsOther: true,
    },
    {
      op: 'find_price_provenance',
      scenario: 'itemId pusty ciag — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { itemId: '' } },
      httpDoorMissing: true,
      http: { method: 'GET', path: '/api/m/procurement/items//provenance' },
    },

    /* -------------------------------- search ------------------------------ */
    {
      op: 'search',
      scenario: 'ok — identyczny wynik wyszukiwania',
      expected: 'ok',
      mcp: { input: { query: 'projektor', limit: 10 } },
      http: { method: 'GET', path: '/api/m/procurement/search?q=projektor&limit=10' },
      compare: (mcp, http) => expect(mcp).toEqual(http),
    },
    {
      op: 'search',
      scenario: 'limit=0 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { query: 'a', limit: 0 } },
      http: { method: 'GET', path: '/api/m/procurement/search?q=a&limit=0' },
    },
    {
      op: 'search',
      scenario: 'limit=51 ponad sufit 50 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { query: 'a', limit: 51 } },
      http: { method: 'GET', path: '/api/m/procurement/search?q=a&limit=51' },
    },
    {
      op: 'search',
      scenario: 'limit=-1 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { query: 'a', limit: -1 } },
      http: { method: 'GET', path: '/api/m/procurement/search?q=a&limit=-1' },
    },
    {
      op: 'search',
      scenario: "limit='abc' — naruszenie schematu",
      expected: 'validation_failed',
      mcp: { input: { query: 'a', limit: 'abc' } },
      http: { method: 'GET', path: '/api/m/procurement/search?q=a&limit=abc' },
    },
    {
      op: 'search',
      scenario: 'q puste — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { query: '' } },
      http: { method: 'GET', path: '/api/m/procurement/search?q=' },
    },
    {
      op: 'search',
      scenario: 'q ponad 120 znakow — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { query: 'x'.repeat(121) } },
      http: { method: 'GET', path: `/api/m/procurement/search?q=${'x'.repeat(121)}` },
    },

    /* ------------------------- set_criteria_weights ----------------------- */
    {
      op: 'set_criteria_weights',
      scenario: 'ok — te same wagi po obu drzwiach',
      expected: 'ok',
      mcp: {
        input: {
          caseId: '{caseId}',
          weights: [
            { key: 'total_cost', weight: 60 },
            { key: 'delivery_days', weight: 40 },
          ],
        },
      },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: {
          weights: [
            { key: 'total_cost', weight: 60 },
            { key: 'delivery_days', weight: 40 },
          ],
        },
      },
      compare: (mcp, http) => {
        const weights = (r: unknown) =>
          (r as { criteria: Array<{ key: string; weight: number }> }).criteria
            .map((c) => [c.key, c.weight])
            .sort();
        expect(weights(mcp)).toEqual(weights(http));
      },
    },
    {
      op: 'set_criteria_weights',
      scenario: 'waga -50 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', weights: [{ key: 'total_cost', weight: -50 }] } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: { weights: [{ key: 'total_cost', weight: -50 }] },
      },
    },
    {
      op: 'set_criteria_weights',
      scenario: 'waga 999 — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', weights: [{ key: 'total_cost', weight: 999 }] } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: { weights: [{ key: 'total_cost', weight: 999 }] },
      },
    },
    {
      op: 'set_criteria_weights',
      scenario: 'waga 1.5 (nie calkowita) — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', weights: [{ key: 'total_cost', weight: 1.5 }] } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: { weights: [{ key: 'total_cost', weight: 1.5 }] },
      },
    },
    {
      op: 'set_criteria_weights',
      scenario: 'nieznany klucz kryterium — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', weights: [{ key: 'koszt', weight: 10 }] } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: { weights: [{ key: 'koszt', weight: 10 }] },
      },
    },
    {
      op: 'set_criteria_weights',
      scenario: 'pusta tablica wag — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}', weights: [] } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: { weights: [] },
      },
    },
    {
      op: 'set_criteria_weights',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { caseId: '{caseId}', weights: [{ key: 'total_cost', weight: 10 }] } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/criteria',
        body: { weights: [{ key: 'total_cost', weight: 10 }] },
      },
      mcpAsOther: true,
      httpAsOther: true,
    },

    /* ---------------------------- save_comparison ------------------------- */
    {
      op: 'save_comparison',
      scenario: 'ok — zapis artefaktu oboma drzwiami',
      expected: 'ok',
      mcp: { input: { caseId: '{caseId}', title: 'L92-ok-mcp', operationId: 'op-l92-ok-mcp-01' } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/comparison',
        body: { title: 'L92-ok-http', operationId: 'op-l92-ok-http-01' },
      },
      compare: (mcp, http) => {
        const m = mcp as { artifactId: string; version: number; bestOfferId: string | null; replayed: boolean };
        const d = http as { artifactId: string; version: number; bestOfferId: string | null; replayed: boolean };
        expect(m.artifactId).toMatch(/^art/);
        expect(d.artifactId).toMatch(/^art/);
        expect(m.version).toBe(d.version);
        expect(m.bestOfferId).toBe(d.bestOfferId);
        expect(m.replayed).toBe(false);
        expect(d.replayed).toBe(false);
      },
    },
    {
      op: 'save_comparison',
      scenario: 'brak operationId — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { caseId: '{caseId}' } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/comparison',
        body: {},
      },
    },
    {
      op: 'save_comparison',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { caseId: '{caseId}', operationId: 'op-l92-forbidden-01' } },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/comparison',
        body: { operationId: 'op-l92-forbidden-01' },
      },
      mcpAsOther: true,
      httpAsOther: true,
    },

    /* --------------------------- update_offer_item ------------------------ */
    {
      op: 'update_offer_item',
      scenario: 'ok — kazde drzwi zapisuja swieza wersje',
      expected: 'ok',
      resolvePerDoor: true,
      mcp: {
        input: { itemId: '{itemIdA}', quantity: 3, expectedVersion: '{versionA}' },
      },
      http: {
        method: 'PATCH',
        path: '/api/m/procurement/items/{itemIdB}',
        body: { quantity: 4, expectedVersion: '{versionB}' },
      },
      compare: (mcp, http) => {
        const m = mcp as { item: { id: string; version: number }; replayed: boolean };
        const d = http as { item: { id: string; version: number; quantityMilli: number }; replayed: boolean };
        expect(m.item.id).toBe(itemA.id);
        expect(d.item.id).toBe(itemB.id);
        // Kazde drzwi podniosly wersje swojej pozycji dokladnie o jeden.
        expect(m.item.version).toBe(itemVersion(itemA.id));
        expect(d.item.version).toBe(itemVersion(itemB.id));
        expect(d.item.quantityMilli).toBe(4000);
        expect(m.replayed).toBe(false);
        expect(d.replayed).toBe(false);
      },
    },
    {
      op: 'update_offer_item',
      scenario: 'brak expectedVersion — naruszenie schematu',
      expected: 'validation_failed',
      mcp: { input: { itemId: '{itemIdA}', quantity: 1 } },
      http: {
        method: 'PATCH',
        path: '/api/m/procurement/items/{itemIdA}',
        body: { quantity: 1 },
      },
    },
    {
      op: 'update_offer_item',
      scenario: 'cena ujemna — regula domenowa, nie schemat',
      expected: 'domain_rule_violated',
      mcp: { input: { itemId: '{itemIdA}', unitPrice: -5, expectedVersion: '{versionA}' } },
      http: {
        method: 'PATCH',
        path: '/api/m/procurement/items/{itemIdA}',
        body: { unitPrice: -5, expectedVersion: '{versionA}' },
      },
    },
    {
      op: 'update_offer_item',
      scenario: 'cudzy zasob — forbidden druga tozsamoscia',
      expected: 'forbidden',
      mcp: { input: { itemId: '{itemIdA}', quantity: 1, expectedVersion: '{versionA}' } },
      http: {
        method: 'PATCH',
        path: '/api/m/procurement/items/{itemIdA}',
        body: { quantity: 1, expectedVersion: '{versionA}' },
      },
      mcpAsOther: true,
      httpAsOther: true,
    },
    {
      op: 'update_offer_item',
      scenario: 'stara wersja — conflict oboma drzwiami',
      expected: 'conflict',
      setup: async () => {
        // Umaczamy wersje "na ktorej ktos inny pracoval", potem ja przesuwamy.
        scratch.staleVersion = itemVersion(itemA.id);
        await h.service.updateOfferItem(
          { itemId: itemA.id, quantity: 2, expectedVersion: scratch.staleVersion },
          h.ownerId,
        );
      },
      mcp: { input: { itemId: '{itemIdA}', quantity: 9, expectedVersion: '{staleVersionA}' } },
      http: {
        method: 'PATCH',
        path: '/api/m/procurement/items/{itemIdA}',
        body: { quantity: 9, expectedVersion: '{staleVersionA}' },
      },
    },
    {
      op: 'update_offer_item',
      scenario: 'replay z operationId przez oba drzwi — dokladnie jeden skutek',
      expected: 'ok',
      mcp: {
        input: {
          itemId: '{itemIdB}',
          quantity: 6,
          expectedVersion: '{versionB}',
          operationId: 'op-l92-update-replay-01',
        },
      },
      http: {
        method: 'PATCH',
        path: '/api/m/procurement/items/{itemIdB}',
        body: { quantity: 6, expectedVersion: '{versionB}', operationId: 'op-l92-update-replay-01' },
      },
      effectCheck: (mcp, http) => {
        const m = mcp as { item: { version: number }; replayed: boolean };
        const d = http as { item: { version: number }; replayed: boolean };
        expect(m.replayed).toBe(false);
        expect(d.replayed).toBe(true);
        expect(d.item.version).toBe(m.item.version);
        expect(itemVersion(itemB.id)).toBe(m.item.version);
        expect(h.service.repo.getItem(itemB.id, h.ownerId).item.quantityMilli).toBe(6000);
      },
    },
    {
      op: 'save_comparison',
      scenario: 'replay z operationId przez oba drzwi — dokladnie jeden artefakt',
      expected: 'ok',
      mcp: {
        input: {
          caseId: '{caseId}',
          title: 'L92-replay-zapis',
          operationId: 'op-l92-save-replay-01',
        },
      },
      http: {
        method: 'POST',
        path: '/api/m/procurement/cases/{caseId}/comparison',
        body: { title: 'L92-replay-zapis', operationId: 'op-l92-save-replay-01' },
      },
      effectCheck: (mcp, http) => {
        const m = mcp as { artifactId: string; replayed: boolean };
        const d = http as { artifactId: string; replayed: boolean };
        expect(m.replayed).toBe(false);
        expect(d.replayed).toBe(true);
        expect(d.artifactId).toBe(m.artifactId);
        expect(
          h.platform.services.artifacts
            .list(h.ownerId)
            .filter((a) => a.title === 'L92-replay-zapis'),
        ).toHaveLength(1);
      },
    },
  ];

  for (const row of ROWS) {
    it(`${row.op} / ${row.scenario}`, async () => {
      await row.setup?.();

      const resolve = row.resolvePerDoor ? subst : (() => {
        // Rozwiazanie raz na wiersz: oba drzwi widza te same wartosci
        // (wymagane przez replay, ktory musi trafic w ten sam odcisk operacji).
        const cache = new Map<string, unknown>();
        return (v: unknown): unknown => {
          const walk = (x: unknown): unknown => {
            if (typeof x === 'string') {
              const exact = Object.entries(tokens).find(([k]) => x === k);
              if (exact) {
                if (!cache.has(exact[0])) cache.set(exact[0], exact[1]());
                return cache.get(exact[0]);
              }
              let out: string = x;
              for (const [k, get] of Object.entries(tokens)) {
                if (out.includes(k)) {
                  if (!cache.has(k)) cache.set(k, String(get()));
                  out = out.replaceAll(k, String(cache.get(k)));
                }
              }
              return out;
            }
            if (Array.isArray(x)) return x.map(walk);
            if (x && typeof x === 'object') {
              return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
            }
            return x;
          };
          return walk(v);
        };
      })();

      if (row.expected === 'ok') {
        let mcpOut: unknown;
        let httpOut: unknown;
        if (row.mcp) {
          const m = await callMcp(row.op, resolve(row.mcp.input), row.mcpAsOther);
          expect(m.ok, `MCP mial sie powiesc: ${JSON.stringify(m.err ?? null)}`).toBe(true);
          mcpOut = m.out;
        }
        if (row.http) {
          const r = await callHttp(
            {
              method: row.http.method,
              path: resolve(row.http.path) as string,
              body: row.http.body !== undefined ? resolve(row.http.body) : undefined,
            },
            row.httpAsOther,
          );
          if (row.noHttpPair) {
            // Asymetria udokumentowana: drzwi istnieja, ale przypadku nie porownamy.
            expect(r.status).toBe(200);
          } else {
            expect(r.doorMissing, `HTTP: brak drzwi dla ${row.http.path}`).toBe(false);
            expect(r.status, `HTTP mial odpowiedziec 200: ${JSON.stringify(r.body)}`).toBe(200);
            httpOut = r.body;
          }
        }
        if (row.compare && mcpOut !== undefined && httpOut !== undefined) {
          row.compare(mcpOut, httpOut);
        }
        if (row.effectCheck) row.effectCheck(mcpOut, httpOut);
        return;
      }

      // Wiersz bledu: TEN SAM kod oboma drzwiami.
      if (row.mcp) {
        const m = await callMcp(row.op, resolve(row.mcp.input), row.mcpAsOther);
        expect(m.ok, `MCP mial odrzucic ${row.expected}`).toBe(false);
        expect(m.code, `MCP: niezgodny kod bledu`).toBe(row.expected);
      }
      if (row.http) {
        const r = await callHttp(
          {
            method: row.http.method,
            path: resolve(row.http.path) as string,
            body: row.http.body !== undefined ? resolve(row.http.body) : undefined,
          },
          row.httpAsOther,
        );
        if (row.httpDoorMissing) {
          expect(
            r.doorMissing,
            `HTTP: tego przypadku nie da sie wyrazic tymi drzwiami — oczekiwany brak trasy`,
          ).toBe(true);
        } else {
          expect(r.doorMissing, `HTTP: oczekiwano dzialajacej trasy, jest brak drzwi`).toBe(false);
          expect(r.status, `HTTP: niezgodny status`).toBe(HTTP_STATUS[row.expected]);
          expect(r.code, `HTTP: niezgodny kod bledu`).toBe(row.expected);
        }
      }
    });
  }

  /* --------------------------- obrona w usludze --------------------------- */
  /**
   * Sufit i podloga limitu w `ProcurementService.search` — ostatnia linia
   * obrony niezalezna od drzwi. SQLite traktuje ujemny LIMIT jako "bez limitu",
   * a NaN rozbija wiazanie parametrow; oba musza byc niemozliwe niezaleznie
   * od tego, kto usluge wywola z pomija walidacje schematow.
   */
  it('usluga search wymusza podloge 1 i sufit 50 na limicie (takze NaN)', () => {
    const baseline = h.service.search(h.ownerId, '*', 50);
    expect(baseline.matched).toBeGreaterThan(1);

    const floored = h.service.search(h.ownerId, '*', -5);
    expect(floored.matched, 'ujemny limit nie moze znaczyć "bez limitu"').toBe(1);

    const naN = h.service.search(h.ownerId, '*', Number('abc'));
    expect(naN.matched, 'NaN nie moze dotrzec do wiazania SQL').toBeLessThanOrEqual(20);

    const ceiled = h.service.search(h.ownerId, '*', 10_000);
    expect(ceiled.matched).toBeLessThanOrEqual(50);
  });
});
