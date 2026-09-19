import { expect, test } from './support/fixtures.ts';
import { Backend, callsOf, openApp, settled, toolNames } from './support/bl03-checks.ts';
import { paidRun, paidSpecPreflight } from './support/bl03-model.ts';

/**
 * Przebieg E — agent sam chodzi po relacjach, na **prawdziwym modelu**.
 *
 * Rodzaj dowodu: **rzeczywisty model**. One command, no identifiers: the agent
 * is given a fragment of a name and has to find the record, walk from it to the
 * offer, the supplier and the source attachment, and come back with the place
 * in the file the price came from.
 *
 * Kryterium: **L9.4**. Its gap is exactly this — the ability was shown by
 * calling the handlers directly (`tests/contracts.test.ts`), which proves the
 * handlers work and nothing about the agent. So the assertions are about
 * *order*: the search has to happen before the traversal, otherwise the
 * identifier came from somewhere other than the agent's own search. The values
 * are compared against the backend, never against the model's wording.
 *
 * Koszt: 1 tura z grantu BL-03.
 */

const FILE = 'bl03-model-relations.spec.ts';
const preflight = paidSpecPreflight(FILE);
const AGENT_TIMEOUT = 420_000;

test.describe('BL-03 przebieg E: wyszukanie, relacje i szczegol na prawdziwym modelu', () => {
  test.describe.configure({ timeout: AGENT_TIMEOUT });
  test.skip(!preflight.ok, preflight.skipReason ?? '');

  test('agent znajduje rekord po fragmencie nazwy i dochodzi do wiersza w pliku', async ({ page }) => {
    const run = paidRun({ file: FILE, przebieg: 'E' });
    const backend = new Backend(page);
    const record: Record<string, unknown> = { kryteria: ['L9.4'] };

    try {
      await openApp(page, '');

      const asked = await run.command(
        page,
        'W danych jest pozycja oferty, ktorej nazwa zawiera „MP-Vision”. ' +
          'Nie podaje zadnych identyfikatorow — znajdz ja sam. ' +
          'Potem ustal, od ktorego dostawcy pochodzi ta oferta, jaka ma referencje, ' +
          'z ktorego pliku zrodlowego wzieto cene jednostkowa tej pozycji i z ktorego miejsca w tym pliku. ' +
          'Podaj dostawce, referencje oferty, nazwe pliku i lokalizacje w pliku.',
      );
      const phase = await settled(page, asked.runId);
      const events = await backend.runEvents(asked.runId);
      const names = toolNames(events);
      run.log.push({ tura: 1, cel: 'wyszukanie i relacje', runId: asked.runId, faza: phase, narzedzia: names });
      expect(phase).toBe('succeeded');

      /*
       * Found, then walked. A traversal whose identifier did not come from a
       * search the agent itself ran would satisfy "the right answer appeared"
       * and nothing else — and that is the case L9.4 is about.
       */
      const searchAt = names.indexOf('procurement_search');
      const walkAt = names.indexOf('procurement_find_price_provenance');
      expect(searchAt, `agent nie wyszukal rekordu; wywolal: ${names.join(', ')}`).toBeGreaterThanOrEqual(0);
      expect(walkAt, `agent nie przeszedl po relacjach; wywolal: ${names.join(', ')}`).toBeGreaterThan(searchAt);

      const provenance = callsOf(events, 'procurement_find_price_provenance').at(-1)!;
      expect(provenance.isError, String(provenance.rawResult)).toBe(false);
      const result = provenance.result as {
        supplier: { name: string };
        offer: { reference: string };
        item: { name: string };
        provenance: Array<{ locator: string; file: { id: string; filename: string } }>;
      };
      record.wynikNarzedzia = {
        dostawca: result.supplier.name,
        referencja: result.offer.reference,
        pozycja: result.item?.name,
        zrodlo: result.provenance?.[0],
      };

      // The backend's own answer, not the model's: the item the agent reached
      // really is the MP-Vision one, and its price really is in that file.
      expect(result.offer.reference).toBe('MP-2026-0442');
      expect(result.supplier.name).toContain('MediaPro');
      expect(result.provenance[0]!.locator).toMatch(/wiersz \d+/);
      expect(result.provenance[0]!.file.filename).toMatch(/\.csv$/);

      /*
       * Pobrane **przegladarka uzytkownika**, a nie klientem HTTP testu.
       *
       * Nie z wygody: `GET /api/files/:id/content` odpowiada z **dwoma**
       * naglowkami Content-Length (uchwyt ustawia swoj, a `c.body()` dokłada
       * drugi), co scisly klient HTTP — undici Node'a i klient Playwrighta —
       * odrzuca w calosci (`Parse Error: Duplicate Content-Length`).
       * Przegladarka to toleruje, wiec uzytkownik tego nie widzi. Defekt jest
       * poza kryteriami tego pakietu i zostal zglaszony w raporcie razem z
       * odtworzeniem bez modelu; tu bierzemy sciezke, ktora ma uzytkownik.
       */
      const csv = await page.evaluate(async (id: string) => {
        const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
        return { status: res.status, text: await res.text() };
      }, result.provenance[0]!.file.id);
      expect(csv.status).toBe(200);
      expect(csv.text).toContain('13100.00');

      /*
       * And the user was told. Deliberately the loosest assertion in the file:
       * the supplier's name and the offer's reference are facts the backend
       * produced, so requiring them in the answer cannot be satisfied by
       * fluent prose — but nothing is asserted about how it is phrased.
       */
      const conversationId = new URL(page.url()).searchParams.get('c')!;
      const said = await backend.assistantText(conversationId);
      record.odpowiedz = said.slice(0, 1500);
      expect(said).toContain('MP-2026-0442');
      expect(said.toLowerCase()).toContain('mediapro');
      record.wynik = 'zaliczona';
    } finally {
      run.save('e-relacje.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });
});
