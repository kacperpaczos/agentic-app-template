import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  qk,
  registerAccessContextReset,
  resetAccessContext,
  scopedAppState,
  setAccessContext,
  useAppState,
} from '@platform/ui';
import { createHarness, login, type Harness } from './helpers.ts';
import { codeVersion, writeEvidence } from './support/measurement-evidence.ts';

/**
 * The record of what package BL-11c actually shows, produced by running it.
 *
 * Two facts are worth writing down because a reader cannot reconstruct them
 * from a test name. The first is what distinguishes a live artifact's *version*
 * from its *freshness*: a definition version that stands still while the state
 * of the source moves. The second is what an identity switch discards outside
 * the query cache — a list that is easy to leave incomplete, and whose gaps are
 * invisible until someone reads the wrong owner's context in a prompt.
 *
 * **Written on request only** (G18). An ordinary `pnpm verify` performs every
 * assertion below, including the ones on the exact bytes that would be written,
 * and writes nothing; `pnpm evidence` (`APP_WRITE_EVIDENCE=1`) writes the file.
 * A regression that rewrites files in the tree it is judged on cannot be both
 * green and clean.
 */

const EVIDENCE_DIR = 'docs/evidence/z7-bl11c';

let h: Harness;
let cookie: string;
let caseId: string;

const api = async (path: string) => {
  const res = await h.platform.app.request(path, { headers: { cookie } });
  return (await res.json()) as any;
};

beforeAll(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  caseId = h.service.listCases(h.ownerId)[0]!.id;
});
afterAll(() => h.dispose());

describe('dowod pakietu BL-11c', () => {
  it('rozroznienie wersji definicji i stanu zrodla, oraz zakres czyszczenia przy zmianie wlasciciela', async () => {
    /* ------------------- live artifact: version vs freshness --------------- */

    const { meta } = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'live',
      title: 'Dowod: wersja kontra swiezosc',
      rendererType: 'procurement.comparison',
      content: { operation: 'procurement.comparison', input: { caseId } },
    });

    const first = await api(`/api/artifacts/${meta.id}`);
    // Separated in time on purpose: every timestamp in the answer must differ,
    // so that an equal fingerprint can only mean an equal source state.
    await new Promise((r) => setTimeout(r, 25));
    const repeated = await api(`/api/artifacts/${meta.id}`);

    // Change the source through the domain service, exactly as a user edit does.
    const detail = h.service.getCaseDetail(caseId, h.ownerId);
    const offer = detail.offers.find((o) =>
      o.items.some((i) => i.unitPriceMinor !== null && i.quantityMilli !== null),
    )!;
    const item = offer.items.find((i) => i.unitPriceMinor !== null && i.quantityMilli !== null)!;
    await h.service.updateOfferItem(
      { itemId: item.id, quantity: (item.quantityMilli ?? 1000) / 1000 + 7 },
      h.ownerId,
    );
    const afterChange = await api(`/api/artifacts/${meta.id}`);

    const live = (r: any) => ({
      definitionVersion: r.live.definitionVersion as number,
      state: r.live.state as string,
      sourceFingerprint: r.live.sourceFingerprint as string,
    });

    // Read twice with nothing changed: another moment, the same source state.
    expect(repeated.live.resolvedAt).not.toBe(first.live.resolvedAt);
    expect(live(repeated).sourceFingerprint).toBe(live(first).sourceFingerprint);
    // Source changed: the same saved question, a different state behind it.
    expect(live(afterChange).definitionVersion).toBe(live(first).definitionVersion);
    expect(live(afterChange).sourceFingerprint).not.toBe(live(first).sourceFingerprint);

    /* ------------- identity switch: what goes beyond the cache ------------- */

    const qc = new QueryClient();
    resetAccessContext();
    const stop = registerAccessContextReset();
    setAccessContext(qc, 'local-user');
    qc.setQueryData(qk.artifact(meta.id), { id: meta.id });
    useAppState.setState({
      conversationId: 'cnv_x',
      spaceId: 'spc_x',
      resource: { kind: 'case', id: caseId },
      selection: [{ kind: 'offer', id: offer.offer.id }],
      attachments: ['file_x'],
      drafts: {
        f1: { formId: 'f1', entity: 'offer_item', entityId: item.id, dirtyFields: ['quantity'], values: {} },
      },
    });
    setAccessContext(qc, 'other-user');
    const cleared = Object.keys(scopedAppState()).filter((key) => {
      const now = (useAppState.getState() as unknown as Record<string, unknown>)[key];
      return JSON.stringify(now) === JSON.stringify((scopedAppState() as Record<string, unknown>)[key]);
    });
    const cacheEntries = qc.getQueryCache().getAll().length;
    stop();
    useAppState.setState({ ...scopedAppState(), navOpen: true });
    resetAccessContext();

    expect(cacheEntries).toBe(0);
    expect(cleared.sort()).toEqual(Object.keys(scopedAppState()).sort());

    /* ------------------------------- the record ---------------------------- */

    const record = {
      opis:
        'Pakiet BL-11c (cache i artefakty): rozroznienie wersji definicji artefaktu live od stanu ' +
        'zrodla, oraz zakres stanu klienta czyszczonego przy zmianie wlasciciela.',
      zrodlo: 'tests/cache-evidence.test.ts w regresji szablonu (pnpm evidence)',
      wersjaKodu: codeVersion(),
      artefaktLive: {
        artefakt: meta.id,
        pierwszyOdczyt: live(first),
        drugiOdczytBezZmianyZrodla: live(repeated),
        odczytPoZmianieZrodla: live(afterChange),
        wniosek:
          'definitionVersion stoi, resolvedAt rosnie przy kazdym odczycie, sourceFingerprint zmienia ' +
          'sie wylacznie wtedy, gdy zmienily sie rekordy zwrocone przez zarejestrowany odczyt.',
      },
      zmianaWlasciciela: {
        wpisyCachePoPrzelaczeniu: cacheEntries,
        wyczyszczonePolaStanuKlienta: cleared.sort(),
        niewyczyszczone: ['navOpen — wlasciwosc okna, nie tozsamosci'],
      },
    };

    const written = writeEvidence('bl11c-cache-i-artefakty.json', record, EVIDENCE_DIR);
    // The assertions run whether or not the file is written.
    expect(written.path.endsWith(`${EVIDENCE_DIR}/bl11c-cache-i-artefakty.json`)).toBe(true);
    const parsed = JSON.parse(written.body) as typeof record;
    expect(parsed.artefaktLive.pierwszyOdczyt.sourceFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.artefaktLive.odczytPoZmianieZrodla.sourceFingerprint).not.toBe(
      parsed.artefaktLive.pierwszyOdczyt.sourceFingerprint,
    );
    expect(parsed.zmianaWlasciciela.wpisyCachePoPrzelaczeniu).toBe(0);
    expect(written.written).toBe(process.env.APP_WRITE_EVIDENCE === '1');
  });
});
