import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@platform/contracts';
import { accessOwner, accessScope } from '../api/accessContext.ts';
import { switchAccessContext, useStatus } from '../api/queries.ts';

/* Labels for the three authentication dimensions. Kept next to the view because
   they are presentation, not policy. */
const CREDENTIAL_LABEL: Record<AuthStatus['credential']['state'], string> = {
  absent: 'brak',
  valid: 'obecne, termin wazny',
  stale: 'obecne, termin minal',
  unreadable: 'obecne, nieczytelne',
};
const CREDENTIAL_BADGE: Record<AuthStatus['credential']['state'], string> = {
  absent: 'pf-badge--warn',
  valid: 'pf-badge--ok',
  stale: 'pf-badge--warn',
  unreadable: 'pf-badge--warn',
};
const ACCESS_LABEL: Record<AuthStatus['access']['state'], string> = {
  unverified: 'niesprawdzony w tej sesji',
  verified: 'potwierdzony',
  rate_limited: 'limit uzycia wyczerpany',
  refresh_refused: 'odnowienie odrzucone',
  revoked: 'logowanie odwolane',
  failed: 'blad wywolania',
};
const ACCESS_BADGE: Record<AuthStatus['access']['state'], string> = {
  unverified: 'pf-badge',
  verified: 'pf-badge--ok',
  rate_limited: 'pf-badge--warn',
  refresh_refused: 'pf-badge--err',
  revoked: 'pf-badge--err',
  failed: 'pf-badge--warn',
};
const ACCESS_REMEDY: Record<AuthStatus['access']['state'], string> = {
  unverified: 'Wyslij dowolne polecenie do agenta, zeby sprawdzic dostep.',
  verified: 'Nic nie trzeba robic.',
  rate_limited: 'Limit subskrypcji wyczerpany. Poczekaj do odnowienia okna; logowanie jest sprawne.',
  refresh_refused: 'Zaloguj sie ponownie: uruchom `claude` i wykonaj /login.',
  revoked: 'Logowanie odwolane. Uruchom `claude` i wykonaj /login.',
  failed: 'Sprawdz komunikat bledu powyzej i sprobuj ponownie.',
};

/**
 * Settings.
 *
 * Shows the integration state and the agent's configuration. Everything here is
 * derived from `/api/status`, which is built to expose no secret: the Claude
 * credential is *described* (plan, expiry, whether the file is readable) and its
 * values are never displayed.
 */
/** The two identities the backend recognises for local use. */
const FIRST_LOCAL_USER = 'local-user';
const SECOND_LOCAL_USER = 'other-user';

export function SettingsPage() {
  const { data, isLoading, error } = useStatus();
  const qc = useQueryClient();
  const [owner, setOwner] = useState<string | null>(accessOwner());
  const [switching, setSwitching] = useState(false);
  const scope = accessScope();

  if (isLoading) return <div className="pf-state">Wczytywanie ustawien…</div>;
  if (error) {
    return (
      <div className="pf-state pf-state--error" role="alert">
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  const a = data.auth;

  return (
    <div className="pf-page" data-testid="settings-page">
      <h1>Ustawienia</h1>
      <p className="pf-page__lead">
        Stan integracji i konfiguracja agenta. Zadna wartosc sekretna nie jest tu pokazywana ani
        przesylana do przegladarki.
      </p>

      {/* Anchor for `platform.settings.auth` in the UI target catalog. */}
      <h2 data-testid="settings-auth">Uwierzytelnienie Claude</h2>
      {/*
        Three separate rows on purpose. "A credential file exists" is not "signing
        in works", and an expired local expiry is not a failure — the SDK renews
        on its own. Showing one merged verdict is how an expired login used to
        read as healthy.
      */}
      <dl className="pf-kv" data-testid="auth-status">
        <dt>Sposob logowania</dt>
        <dd>
          <span className="pf-badge pf-badge--ok" data-testid="auth-method">
            {a.method === 'subscription' ? 'subskrypcja' : 'brak'}
          </span>
        </dd>
        <dt>Plan</dt>
        <dd>{a.credential.subscriptionType ?? '—'}</dd>
        <dt>Poswiadczenie lokalne</dt>
        <dd data-testid="auth-credential-state">
          <span className={`pf-badge ${CREDENTIAL_BADGE[a.credential.state]}`}>
            {CREDENTIAL_LABEL[a.credential.state]}
          </span>
        </dd>
        <dt>Wazne do</dt>
        <dd>
          {a.credential.expiresAt ? new Date(a.credential.expiresAt).toLocaleString('pl-PL') : '—'}
          {a.credential.state === 'stale' && (
            <span className="pf-hint"> — termin minal; SDK moze odnowic token przy nastepnym wywolaniu</span>
          )}
        </dd>
        <dt>Ostatni potwierdzony dostep</dt>
        <dd data-testid="auth-access-state">
          <span className={`pf-badge ${ACCESS_BADGE[a.access.state]}`}>
            {ACCESS_LABEL[a.access.state]}
          </span>
        </dd>
        <dt>Ostatnie udane wywolanie</dt>
        <dd>
          {a.access.lastVerifiedAt
            ? new Date(a.access.lastVerifiedAt).toLocaleString('pl-PL')
            : 'jeszcze nie bylo'}
        </dd>
        <dt>Ostatni blad dostepu</dt>
        <dd data-testid="auth-last-error">
          {a.access.lastError ? (
            <>
              {a.access.lastError}
              {a.access.lastErrorAt && ` (${new Date(a.access.lastErrorAt).toLocaleString('pl-PL')})`}
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt>Co teraz zrobic</dt>
        <dd data-testid="auth-remedy">{ACCESS_REMEDY[a.access.state]}</dd>
        <dt>Klucz API Anthropic</dt>
        <dd>
          {a.apiKeyDetected
            ? 'wykryty w srodowisku — odrzucany przez polityke, usuwany z procesu agenta'
            : 'nieobecny'}
        </dd>
        <dt>Polityka</dt>
        <dd>
          {a.apiKeyPolicy === 'refused'
            ? 'wylacznie subskrypcja; platne API i gateway zablokowane'
            : a.apiKeyPolicy}
        </dd>
        <dt>Claude CLI</dt>
        <dd>{a.cliVersion ?? 'nie wykryto'}</dd>
      </dl>

      <h2>Kontekst dostepu</h2>
      {/*
        Not a user-management feature, and not meant to be one: two local
        identities are enough to exercise the rule that matters — that changing
        who the application acts as discards everything cached, requested or
        streamed for the previous one. Without a control like this the isolation
        could only be argued, not shown.
      */}
      <dl className="pf-kv">
        <dt>Dziala jako</dt>
        <dd data-testid="access-owner">{owner ?? '—'}</dd>
        <dt>Zakres cache</dt>
        <dd data-testid="access-scope">{scope}</dd>
      </dl>
      <p>
        <button
          type="button"
          className="pf-btn"
          data-testid="switch-access-context"
          disabled={switching}
          onClick={() => {
            setSwitching(true);
            void switchAccessContext(qc, owner === SECOND_LOCAL_USER ? FIRST_LOCAL_USER : SECOND_LOCAL_USER)
              .then((next) => setOwner(next))
              .finally(() => setSwitching(false));
          }}
        >
          Przelacz na {owner === SECOND_LOCAL_USER ? FIRST_LOCAL_USER : SECOND_LOCAL_USER}
        </button>
      </p>

      <h2>Agent</h2>
      <dl className="pf-kv">
        <dt>Model</dt>
        <dd>{data.model}</dd>
        <dt>Aktywne uruchomienia</dt>
        <dd>{data.activeRuns}</dd>
        <dt>Izolacja konfiguracji</dt>
        <dd>settingSources: [] — prywatne ustawienia i serwery MCP uzytkownika nie sa dziedziczone</dd>
        <dt>Sandbox</dt>
        <dd>wlaczony; zapis tylko w workspace uruchomienia, siec odcieta, katalog danych aplikacji niedostepny</dd>
      </dl>

      <h2>Moduly biznesowe</h2>
      {data.modules.length === 0 ? (
        <p className="pf-state pf-state--empty">
          Brak zainstalowanych modulow. Platforma dziala z pustym stanem.
        </p>
      ) : (
        <table className="pf-table">
          <thead>
            <tr>
              <th scope="col">Modul</th>
              <th scope="col">Wersja</th>
              <th scope="col">Opis</th>
            </tr>
          </thead>
          <tbody>
            {data.modules.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.title}</strong> <span className="pf-muted">({m.id})</span>
                </td>
                <td>{m.version}</td>
                <td className="pf-muted">{m.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Narzedzia agenta ({data.platformTools.length + data.tools.length})</h2>
      <table className="pf-table">
        <thead>
          <tr>
            <th scope="col">Narzedzie</th>
            <th scope="col">Zrodlo</th>
            <th scope="col">Efekt</th>
          </tr>
        </thead>
        <tbody>
          {data.platformTools.map((t) => (
            <tr key={t}>
              <td><code>{t}</code></td>
              <td className="pf-muted">platforma</td>
              <td className="pf-muted">—</td>
            </tr>
          ))}
          {data.tools.map((t) => (
            <tr key={t.name}>
              <td><code>mcp__app__{t.name}</code></td>
              <td className="pf-muted">{t.module}</td>
              <td>
                <span className={`pf-badge ${t.effect === 'write' ? 'pf-badge--warn' : ''}`}>{t.effect}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Katalog komponentow ({data.components.length})</h2>
      <table className="pf-table">
        <thead>
          <tr>
            <th scope="col">Komponent</th>
            <th scope="col">Opis</th>
            <th scope="col">Wlasciwosci</th>
          </tr>
        </thead>
        <tbody>
          {data.components.map((c) => (
            <tr key={c.id}>
              <td><code>{c.id}</code></td>
              <td className="pf-muted">{c.description}</td>
              <td className="pf-muted"><code>{c.usage}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Anchor for `platform.settings.chat` in the UI target catalog. */}
      <h2 data-testid="settings-chat-capabilities">Zakres gotowej obslugi rozmow</h2>
      <ul>
        {Object.entries(data.chatCapabilities).map(([key, value]) => (
          <li key={key}>
            {key}: <strong>{value ? 'dostepne' : 'niedostepne'}</strong>
          </li>
        ))}
      </ul>

      <h2>Wersje</h2>
      <dl className="pf-kv">
        {Object.entries(data.versions).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
