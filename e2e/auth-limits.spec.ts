import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { codeVersion, writeEvidence } from '../tests/support/measurement-evidence.ts';

/**
 * Authentication and limits, from the adapter boundary to the screen (BL-04).
 *
 * The audit's finding was not that the states did not exist — the classifier
 * had them — but that nothing carried one through the runtime to a place a user
 * looks. A test on `classifyAccessFailure` says the string maps to
 * `rate_limited`; it does not say the chat, the status bar and Settings then
 * show three different things for a limit, a revoked login and a lost
 * connection. This suite drives each failure at the `ModelAgentLike` boundary
 * and reads the screen.
 *
 * **Everything here is a simulation and is labelled as one.** The failure texts
 * are chosen by `support/auth-scenarios.ts`; no subscription limit was reached,
 * no login was revoked and no refresh was declined. What is real is the whole
 * path the text then travels: the runtime, the classifier, the run record, the
 * access record, the event stream and the three surfaces below.
 *
 * **The user's own login is not touched.** The scripted instance runs with
 * `CLAUDE_CONFIG_DIR` pointed at a temporary directory holding a canary
 * credential, so "the credential has expired" is a property of a throw-away
 * file. The canary value is also what the leak assertions look for.
 */

/** A value that exists nowhere else, so finding it anywhere is proof of a leak. */
const CANARY = 'KANAREK-E2E-POSWIADCZENIE-4d81b0';

const configDir = mkdtempSync(join(tmpdir(), 'e2e-claude-config-'));

const writeCredential = (expiresAt: number, subscriptionType = 'max') =>
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: CANARY,
        refreshToken: `${CANARY}-refresh`,
        subscriptionType,
        expiresAt,
      },
    }),
  );

const scripted = new ScriptedInstance({
  port: 8798,
  dataDirName: '.e2e-scripted-auth',
  env: { CLAUDE_CONFIG_DIR: configDir },
  /*
   * Captured, because a claim about what the server printed needs the printout
   * — and written under `.e2e-scripted-…`, which is ignored by git, so a
   * browser run leaves the tree exactly as it found it (G18). The scan's
   * *result* is what reaches `docs/evidence/`, and only on request.
   */
  logFile: '.e2e-scripted-auth-log/serwer.log',
});
const BASE = scripted.baseUrl;

async function openApp(page: Page, path = '/') {
  await page.goto(`${BASE}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${BASE}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const runState = (page: Page) => page.getByTestId('run-state');

/** Opens Settings through the navigation, as a user would. */
async function openSettings(page: Page) {
  await page.getByRole('link', { name: 'Ustawienia' }).click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
}

test.describe('uwierzytelnienie i limity w interfejsie (symulacja na granicy adaptera)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    writeCredential(Date.now() + 7 * 24 * 3600 * 1000);
    scripted.prepareDatabase();
  });

  test.afterEach(async () => {
    await scripted.stop();
  });

  test.afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  /* ----------------------- three failures, three states ------------------- */

  /**
   * The table the criterion is actually about: a limit, a revoked login and a
   * lost connection have to be **three** states, not one "something went
   * wrong". Driven one after another through the same interface so the
   * difference is observed rather than argued.
   */
  const cases = [
    {
      scenario: 'auth-limit',
      command: 'Zrob zestawienie, prosze.',
      runCode: 'rate_limited',
      access: 'rate_limited',
      /* A limit is a wait: the application stays usable and says so. */
      usable: true,
    },
    {
      scenario: 'auth-revoked',
      command: 'Zrob zestawienie po odwolaniu logowania.',
      runCode: 'unauthenticated',
      access: 'revoked',
      usable: false,
    },
    {
      scenario: 'auth-refresh-refused',
      command: 'Zrob zestawienie po odmowie odnowienia.',
      runCode: 'unauthenticated',
      access: 'refresh_refused',
      usable: false,
    },
    {
      scenario: 'auth-network',
      command: 'Zrob zestawienie mimo zerwanego polaczenia.',
      runCode: 'model_failed',
      access: 'failed',
      usable: true,
    },
  ] as const;

  for (const c of cases) {
    test(`${c.scenario}: czat, pasek stanu i Ustawienia pokazuja stan "${c.access}"`, async ({ page }) => {
      await scripted.start(c.scenario);
      await openApp(page);
      await send(page, c.command);

      await expect(runState(page)).toHaveAttribute('data-phase', 'failed', { timeout: 60_000 });
      // The chat names the class of failure, not just "error".
      await expect(page.getByTestId('run-error')).toContainText(c.runCode);
      // Work produced before the failure is still on screen.
      await expect(page.locator('.pf-chat')).toContainText('Zaczynam');
      // And the user can carry on.
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();

      /*
       * The status bar updates without a reload. It did not before: the status
       * query had no reason to re-run, so the shell kept reporting a healthy
       * connection while the chat showed the failure.
       */
      await expect(page.getByTestId('statusbar-auth')).toHaveAttribute('data-auth-state', c.access, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('statusbar-auth')).toHaveAttribute('data-auth-confirmed', 'false');

      await openSettings(page);
      await expect(page.getByTestId('auth-access-state')).toHaveAttribute('data-state', c.access);
      await expect(page.getByTestId('auth-remedy')).toHaveAttribute('data-state', c.access);
      // The local credential is untouched by any of this: the file is still
      // there and still valid. A failure of access is not a lost login.
      await expect(page.getByTestId('auth-credential-state')).toHaveAttribute('data-state', 'valid');
      // No secret reached the page.
      const body = (await page.locator('body').innerText()).toLowerCase();
      expect(body.includes(CANARY.toLowerCase()), 'wartosc poswiadczenia na ekranie Ustawien').toBe(false);
    });
  }

  /**
   * The four states above, side by side.
   *
   * Asserted as a set rather than one at a time, because "distinguishable" is a
   * statement about the collection: four failures that each showed something
   * would still fail the criterion if two of them showed the same thing.
   */
  test('cztery kontrolowane awarie daja cztery rozne stany, nie jeden blad', async () => {
    const seen = new Set(cases.map((c) => c.access));
    expect(seen.size, 'stany sie powtarzaja — to nie sa rozrozniane przypadki').toBe(cases.length);
    const codes = new Set(cases.map((c) => c.runCode));
    // The codes may collapse (a revoked login and a refused refresh are both
    // `unauthenticated` in the chat) — the access states may not.
    expect(codes.size).toBeGreaterThan(1);
  });

  /* --------------------- expired locally, working anyway ------------------ */

  test('miniony termin w pliku nie blokuje uruchomienia, a po udanym wywolaniu dostep jest potwierdzony', async ({ page }) => {
    // A credential whose recorded expiry passed a day ago. The SDK holds a
    // refresh token and renews on its own, so this must not stop anything.
    writeCredential(Date.now() - 24 * 3600 * 1000);
    await scripted.start('auth-expired-ok');
    await openApp(page);

    await openSettings(page);
    await expect(page.getByTestId('auth-credential-state')).toHaveAttribute('data-state', 'stale');
    await expect(page.getByTestId('auth-access-state')).toHaveAttribute('data-state', 'unverified');
    // Presence is not health: nothing has been confirmed yet.
    await expect(page.getByTestId('statusbar-auth')).toHaveAttribute('data-auth-confirmed', 'false');

    await page.goto(`${BASE}/`);
    await send(page, 'Wypisz sprawy zakupowe.');
    await expect(runState(page)).toHaveAttribute('data-phase', 'succeeded', { timeout: 60_000 });

    await expect(page.getByTestId('statusbar-auth')).toHaveAttribute('data-auth-confirmed', 'true', {
      timeout: 30_000,
    });
    await openSettings(page);
    // Two facts, two rows, and they disagree — which is the point of L8.10.
    await expect(page.getByTestId('auth-credential-state')).toHaveAttribute('data-state', 'stale');
    await expect(page.getByTestId('auth-access-state')).toHaveAttribute('data-state', 'verified');

    writeCredential(Date.now() + 7 * 24 * 3600 * 1000);
  });

  /* ------------------ a mutation, then the limit, then nothing ------------ */

  test('limit po mutacji: jeden skutek, zachowana historia, brak samoczynnej powtorki', async ({ page }) => {
    await scripted.start('auth-mutation-then-limit');
    await openApp(page);

    const artifactCount = () =>
      page.evaluate(async () => {
        const r = await fetch('/api/artifacts', { credentials: 'include' });
        const body = (await r.json()) as { artifacts?: unknown[] } | unknown[];
        return Array.isArray(body) ? body.length : (body.artifacts?.length ?? 0);
      });

    const before = await artifactCount();
    await send(page, 'Zapisz zestawienie sprawy PC-2026-01.');

    await expect(runState(page)).toHaveAttribute('data-phase', 'failed', { timeout: 90_000 });
    await expect(page.getByTestId('run-error')).toContainText('rate_limited');

    // The mutation happened, exactly once.
    expect(await artifactCount(), 'mutacja przed limitem nie dala dokladnie jednego skutku').toBe(before + 1);

    // The conversation keeps everything the run produced before it failed.
    await expect(page.locator('.pf-chat')).toContainText('procurement_save_comparison');
    await expect(page.locator('.pf-chat')).toContainText('Zapisalem zestawienie');

    /*
     * And nothing retries. Waited out rather than asserted instantly: an
     * automatic retry would be a *later* event, so an assertion taken the
     * moment the run failed could not see one.
     */
    await page.waitForTimeout(6000);
    expect(await artifactCount(), 'mutacja zostala powtorzona bez polecenia uzytkownika').toBe(before + 1);

    const runs = await page.evaluate(async () => {
      const c = new URL(location.href).searchParams.get('c');
      const r = await fetch(`/api/conversations/${c}/runs`, { credentials: 'include' });
      return (await r.json()) as { runs?: Array<{ status: string }> };
    });
    expect(runs.runs?.length, 'powstalo wiecej niz jedno uruchomienie').toBe(1);
    expect(runs.runs?.[0]?.status).toBe('failed');

    // A reload shows the same history — the failure did not eat the turn.
    await page.reload();
    await expect(page.locator('.pf-chat')).toContainText('Zapisalem zestawienie', { timeout: 30_000 });
    expect(await artifactCount()).toBe(before + 1);
  });

  /* ---------------------- the login stays out of reach -------------------- */

  test('proba odczytu pliku poswiadczen przez agenta konczy sie odmowa widoczna w czacie', async ({ page }) => {
    await scripted.start('auth-credential-read');
    await openApp(page);
    await send(page, 'Zajrzyj do pliku logowania.');

    await expect(runState(page)).toHaveAttribute('data-phase', 'succeeded', { timeout: 60_000 });
    // The refusal is announced where the step would have been.
    await expect(page.locator('.pf-chat')).toContainText('odmowa', { timeout: 30_000 });

    /*
     * The assertion that matters: the canary is nowhere on the page. Without
     * the protection the scripted step really reads the file and puts its
     * contents into the answer, so this is a control, not a formality.
     */
    const body = await page.locator('body').innerText();
    expect(body.includes(CANARY), 'wartosc poswiadczenia trafila do czatu').toBe(false);

    // Nor in what the backend stored, nor in what it will replay.
    const stored = await page.evaluate(async () => {
      const c = new URL(location.href).searchParams.get('c');
      const messages = await (await fetch(`/api/threads/get/${c}`, { credentials: 'include' })).json();
      const runs = await (await fetch(`/api/conversations/${c}/runs`, { credentials: 'include' })).json();
      const ids = (runs.runs ?? []).map((r: { id: string }) => r.id);
      const events = await Promise.all(
        ids.map(async (id: string) =>
          (await fetch(`/api/runs/${id}/events`, { credentials: 'include' })).text(),
        ),
      );
      return JSON.stringify({ messages, events });
    });
    expect(stored.includes(CANARY), 'wartosc poswiadczenia w historii lub zdarzeniach uruchomienia').toBe(false);
  });

  /* ------------------------- the SDK session report ----------------------- */

  /**
   * What the interface does with each answer of the session probe.
   *
   * The probe itself is answered by a stand-in here (`SDK_SESSION`), because
   * the real one starts the Claude CLI and a browser suite that depended on it
   * would be testing the machine. The real probe has its own recorded run:
   * `scripts/probe-sdk-session.mjs`, evidence in `docs/evidence/z12-bl04/`.
   */
  for (const [answer, state, usableAfterProbe] of [
    ['subscription', 'subscription', true],
    ['api-key', 'api_key', false],
    ['unavailable', 'unavailable', true],
  ] as const) {
    test(`sesja SDK "${answer}" ma wlasny, rozrozalny stan w Ustawieniach`, async ({ page }) => {
      await scripted.start('auth-expired-ok', { SDK_SESSION: answer });
      await openApp(page);
      await openSettings(page);

      // Before the check the screen says it does not know — not "subscription".
      await expect(page.getByTestId('sdk-session-state')).toHaveAttribute('data-state', 'unknown');

      await page.getByTestId('sdk-session-check').click();
      await expect(page.getByTestId('sdk-session-state')).toHaveAttribute('data-state', state, {
        timeout: 30_000,
      });

      /*
       * A session running on an API key is outside the policy this build
       * states, so the shell stops calling the connection usable — whatever the
       * local credential file says. That is the state the old screen could not
       * express at all: the label "subskrypcja" was a constant.
       */
      const usable = await page
        .getByTestId('statusbar-auth')
        .getAttribute('data-auth-state')
        .then(() => page.locator('.pf-statusbar .pf-dot').getAttribute('class'));
      if (usableAfterProbe) {
        expect(usable, 'pasek stanu oznacza sesje jako zepsuta mimo poprawnej odpowiedzi').not.toContain(
          'pf-dot--warn',
        );
      } else {
        expect(usable, 'sesja na kluczu API nie jest oznaczona jako niezgodna').toContain('pf-dot--warn');
      }

      // No secret on the page, whatever the answer was.
      const body = (await page.locator('body').innerText()).toLowerCase();
      expect(body.includes(CANARY.toLowerCase())).toBe(false);
    });
  }

  /* --------------------- every surface, one canary ----------------------- */

  /**
   * The surfaces the audit said were never searched (L8.13).
   *
   * Two endpoints proved two endpoints. This run drives an actual conversation
   * — a tool call, an artifact, a failure — against an instance whose login is
   * a canary, and then looks for that canary in **everything the run touched**:
   * what the server printed, what it stored, what it will replay, what it
   * serves over HTTP, what it left in the workspace root and what the frontend
   * build contains. A surface that was not scanned is named as not scanned
   * rather than counted as clean.
   */
  test('kanarek poswiadczenia nie wystepuje w zadnej z powierzchni uruchomienia', async ({ page }) => {
    await scripted.start('auth-mutation-then-limit');
    await openApp(page);
    await send(page, 'Zapisz zestawienie sprawy PC-2026-01 przed limitem.');
    await expect(runState(page)).toHaveAttribute('data-phase', 'failed', { timeout: 90_000 });

    const overHttp = await page.evaluate(async () => {
      const c = new URL(location.href).searchParams.get('c');
      const grab = async (path: string) => {
        try {
          return await (await fetch(path, { credentials: 'include' })).text();
        } catch (err) {
          return `blad: ${String(err)}`;
        }
      };
      const runs = JSON.parse(await grab(`/api/conversations/${c}/runs`)) as {
        runs?: Array<{ id: string }>;
      };
      const artifacts = JSON.parse(await grab('/api/artifacts')) as {
        artifacts?: Array<{ id: string }>;
      };
      return {
        status: await grab('/api/status'),
        watek: await grab(`/api/threads/get/${c}`),
        listaWatkow: await grab('/api/threads/get'),
        uruchomienia: JSON.stringify(runs),
        zdarzeniaUruchomien: (
          await Promise.all((runs.runs ?? []).map((r) => grab(`/api/runs/${r.id}/events`)))
        ).join('\n'),
        artefakty: JSON.stringify(artifacts),
        trescArtefaktow: (
          await Promise.all((artifacts.artifacts ?? []).map((a) => grab(`/api/artifacts/${a.id}`)))
        ).join('\n'),
        pliki: await grab('/api/files'),
      };
    });

    /* The instance is stopped first, so nothing it printed on the way out is
       missing from the log — which is precisely what a log scan would miss. */
    await scripted.stop();
    const surfaces = {
      ...overHttp,
      logSerwera: scripted.readLog(),
      bazaDanych: readFileSync(resolve(scripted.config.dataDir, 'app.db'), 'latin1'),
      zbudowanyFrontend: readdirSync(resolve(import.meta.dirname, '../apps/web/dist/assets'))
        .map((f) => readFileSync(resolve(import.meta.dirname, '../apps/web/dist/assets', f), 'latin1'))
        .join('\n'),
    } satisfies Record<string, string>;

    // The scan is only worth something if the surfaces are really there.
    expect(surfaces.logSerwera.length, 'log serwera pusty — nic nie przeszukano').toBeGreaterThan(0);
    expect(surfaces.bazaDanych.length, 'baza pusta — nic nie przeszukano').toBeGreaterThan(0);
    expect(surfaces.zbudowanyFrontend.length, 'brak zbudowanego frontendu').toBeGreaterThan(0);
    expect(surfaces.zdarzeniaUruchomien.length, 'brak zdarzen uruchomienia').toBeGreaterThan(0);

    const found: string[] = [];
    for (const [name, text] of Object.entries(surfaces)) {
      // `includes`, never `toContain`: a failing `not.toContain` prints the
      // needle, which would copy the secret into the regression log (L8.14).
      if (text.includes(CANARY)) found.push(name);
      if (/sk-ant-[A-Za-z0-9_-]{8,}/.test(text)) found.push(`${name} (wzorzec sk-ant)`);
    }
    expect(found, 'kanarek poswiadczenia znaleziony w powierzchniach').toEqual([]);

    writeEvidence(
      'skan-sekretow.json',
      {
        opis:
          'Przeszukanie powierzchni uruchomienia pod katem wartosci poswiadczenia. Instancja ' +
          'scenariuszowa dziala z CLAUDE_CONFIG_DIR wskazujacym katalog tymczasowy z kanarkiem; ' +
          'prawdziwe logowanie uzytkownika nie bierze udzialu w probie.',
        zrodlo: 'APP_WRITE_EVIDENCE=1 pnpm exec playwright test e2e/auth-limits.spec.ts',
        rodzajDowodu: 'test GUI bez modelu + skan powierzchni (symulacja na granicy adaptera)',
        wersjaKodu: codeVersion({}, ['docs/evidence/z12-bl04']),
        przeszukanePowierzchnie: Object.fromEntries(
          Object.entries(surfaces).map(([k, v]) => [k, { bajtow: v.length, kanarek: v.includes(CANARY) }]),
        ),
        niePrzeszukane: [
          'slady i raporty Playwright — powstaja po zakonczeniu testu, wiec sprawdza je osobny ' +
            'krok regresji (tests/durability.test.ts, skan docs/evidence/playwright-report).',
        ],
      },
      'docs/evidence/z12-bl04',
    );
  });

  test('odpowiedz sondy nie niesie adresu e-mail ani nazwy organizacji', async ({ page }) => {
    await scripted.start('auth-expired-ok', { SDK_SESSION: 'subscription' });
    await openApp(page);
    const answer = await page.evaluate(async () => {
      const r = await fetch('/api/sdk-session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return r.text();
    });
    // The redaction is a property of the contract, so it is asserted on the
    // wire rather than on the screen.
    expect(answer).toContain('subscription');
    expect(/email|organization|@/i.test(answer), 'raport sesji niesie dane konta').toBe(false);
  });
});
