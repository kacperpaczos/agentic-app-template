import { AppError } from '@platform/contracts';

/**
 * How a failed read is put on screen.
 *
 * Losing access is not the same kind of event as a broken request, and the user
 * has to be able to tell: one means "this is not yours to see", the other means
 * "something went wrong, try again". Rendering both as a bare message — which is
 * what the shell used to do — leaves a forbidden resource looking like a glitch,
 * and leaves "the browser shows no-access" impossible to assert on.
 */
const TITLES: Record<string, string> = {
  forbidden: 'Brak dostepu do tego zasobu',
  not_found: 'Zasob nie istnieje lub nie nalezy do biezacego kontekstu',
  unauthenticated: 'Sesja aplikacji wygasla',
  rate_limited: 'Limit uzycia wyczerpany',
};

const HINTS: Record<string, string> = {
  forbidden: 'Zasob nalezy do innego kontekstu dostepu. Zaden jego fragment nie zostal wczytany.',
  not_found: 'Sprawdz, czy pracujesz we wlasciwym kontekscie dostepu.',
  unauthenticated: 'Odswiez strone, zeby zalogowac sie ponownie.',
  rate_limited: 'Logowanie jest sprawne. Poczekaj na odnowienie okna limitu.',
};

export function QueryErrorState({ error, what }: { error: unknown; what?: string }) {
  const code = error instanceof AppError ? error.code : 'internal';
  const denied = code === 'forbidden' || code === 'not_found' || code === 'unauthenticated';
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div
      className={`pf-state ${denied ? 'pf-state--denied' : 'pf-state--error'}`}
      role="alert"
      data-testid={denied ? 'access-denied' : 'query-error'}
      data-error-code={code}
    >
      <strong>{TITLES[code] ?? `Nie udalo sie wczytac${what ? ` ${what}` : ''}`}</strong>
      <div>{HINTS[code] ?? message}</div>
      {!denied && <div className="pf-muted">{message}</div>}
    </div>
  );
}
