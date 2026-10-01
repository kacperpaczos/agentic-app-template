import { expect, test, type APIRequestContext } from '@playwright/test';

async function seedThread(request: APIRequestContext, title: string) {
  await request.post('/api/auth/session', { data: {} });
  const created = await (
    await request.post('/api/threads/create', {
      data: { messages: [{ id: crypto.randomUUID(), role: 'user', content: title }] },
    })
  ).json();
  return created as { id: string; title: string };
}

/*
 * SPEC MODELOWY (odplatne tury GLM). Nie wlaczac do biegow skryptowanych —
 * uruchamiany swiadomie: APP_MODEL_PROVIDER=glm + CLAUDE_CONFIG_DIR izolowany
 * z .credentials.json = {} + ANTHROPIC_BASE_URL/AUTH_TOKEN z hosta.
 * Uwaga: SDK-CLI 2.1.270 w tym trybie odmawia auth przy turze („Not logged
 * in") — otwarta pozycja; host-CLI 2.1.283 przechodzi.
 */

test.skip(process.env.APP_E2E_MODEL !== '1', 'Wymaga jawnej zgody na płatną turę GLM.');

test('usuniecie rozmowy odlacza artefakty zamiast je kasowac', async ({ request }) => {
    test.setTimeout(300_000);

    /*
     * Realny incydent: klucz obcy artifacts.conversation_id zachowywal sie jak
     * ON DELETE CASCADE — usuniecie rozmowy niszczylo artefakty, trwale wyniki
     * pracy agenta, zamiast je odpiac. Poprzednia wersja tego testu tego nie
     * widziala: w seedowanej bazie nie bylo zadnego artefaktu, wiec
     * porownywala 0 z 0 i przeszla z aktywnym bledem kasujacym dane.
     *
     * Artefakt powstaje wylacznie przez narzedzie agenta `artifact_create` w
     * trakcie runu (HTTP potrafi artefakt wypisac, odczytac i zmienic, ale nie
     * utworzyc), wiec ten test wydaje jedna realna ture modelu przez wejscie
     * `/api/agui/run` — ten sam, ktorego uzywa gotowy czat.
     */
    await request.post('/api/auth/session', { data: {} });
    const t = await seedThread(request, `Do usuniecia ${Date.now()}`);

    const polecenie =
      'Utworz teraz dokladnie jeden artefakt narzedziem artifact_create, z tymi parametrami: ' +
      'title="Artefakt kontrolny", kind="report", mode="snapshot", ' +
      'rendererType="platform.markdown", ' +
      'content={"markdown":"## Artefakt kontrolny\\n\\nTresc kontrolna testu E2E."}. ' +
      'Nie uzywaj zadnych innych narzedzi. Na koniec potwierdz jednym zdaniem, co utworzyles.';
    const uruchom = await request.post('/api/agui/run', {
      data: {
        threadId: t.id,
        messages: [{ id: crypto.randomUUID(), role: 'user', content: polecenie }],
      },
      timeout: 240_000,
    });
    expect(uruchom.ok(), `run nie wystartowal: HTTP ${uruchom.status()}`).toBe(true);
    // Odpowiedzia jest strumien SSE, ktory serwer zamyka w momencie zakonczenia
    // runu — przeczytanie ciala jest wiec oczekiwaniem na koniec pracy agenta.
    await uruchom.text();

    const { runs } = await (await request.get(`/api/conversations/${t.id}/runs`)).json();
    expect(runs.length, 'run nie zostal zarejestrowany dla tej rozmowy').toBeGreaterThan(0);
    expect(
      runs[0].status,
      `run zakonczyl sie bledem: ${runs[0].errorMessage ?? '(bez komunikatu)'}`,
    ).toBe('succeeded');

    const przed = await (await request.get('/api/artifacts')).json();
    const moje = przed.artifacts.filter((a: { threadId: string }) => a.threadId === t.id);
    expect(
      moje.length,
      'rozmowa nie ma powiazanego artefaktu — test nie sprawdzalby nic',
    ).toBeGreaterThanOrEqual(1);

    const del = await (await request.delete(`/api/threads/delete/${t.id}`)).json();
    expect(del.deleted).toBe(t.id);

    // Artefakt przezywa usuniecie rozmowy: odpiety (threadId puste), nie skasowany.
    const po = await (await request.get('/api/artifacts')).json();
    expect(po.artifacts.length, 'usuniecie rozmowy skasowalo artefakty').toBe(
      przed.artifacts.length,
    );
    const odlaczony = po.artifacts.find((a: { id: string }) => a.id === moje[0].id);
    expect(odlaczony, 'artefakt zniknal razem z rozmowa, a mial zostac odpiety').toBeTruthy();
    expect(odlaczony.threadId, 'artefakt mial zostac odpiety od rozmowy (threadId puste)').toBe('');
  });
