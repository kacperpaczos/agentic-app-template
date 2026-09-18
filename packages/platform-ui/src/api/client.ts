import { AppError, type AppErrorCode } from '@platform/contracts';
import { AccessContextChanged, accessEpoch, accessSignal } from './accessContext.ts';

/** Same-origin in production; the Vite dev server proxies /api to the backend. */
export const API_BASE = '';

async function parseError(res: Response): Promise<AppError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error?.code) {
      return new AppError(body.error.code as AppErrorCode, body.error.message ?? 'Blad', body.error.details);
    }
  } catch {
    /* fall through to a status-based error */
  }
  const byStatus: Record<number, AppErrorCode> = {
    400: 'validation_failed',
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    412: 'precondition_failed',
    422: 'domain_rule_violated',
  };
  return new AppError(byStatus[res.status] ?? 'internal', `HTTP ${res.status}`);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  /*
   * Bound to the access context in two independent ways: the shared signal
   * aborts the request the moment the context changes, and the epoch check
   * discards a response that raced past the abort. Either alone leaves a window
   * in which the previous identity's data can land in the new identity's cache.
   */
  const issuedAt = accessEpoch();
  const signal = init.signal
    ? AbortSignal.any([init.signal, accessSignal()])
    : accessSignal();

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (accessEpoch() !== issuedAt) throw new AccessContextChanged();
  if (!res.ok) {
    const error = await parseError(res);
    // Reading the error body is another await: a refusal addressed to the previous context is not this one's.
    if (accessEpoch() !== issuedAt) throw new AccessContextChanged();
    throw error;
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as T;
  if (accessEpoch() !== issuedAt) throw new AccessContextChanged();
  return body;
}

/**
 * `fetch`, bound to the access context, for the requests that cannot go through
 * {@link api}.
 *
 * Three of them exist and all three are real holes when they are left
 * unbound: the ready-made chat's own thread storage (`restStorage`, which takes
 * a `fetch` and parses the body itself), a file upload (whose body is
 * `FormData` and whose response the caller reads directly), and the run stream
 * (whose body is consumed for minutes after the request resolved). Each one of
 * them used a bare `fetch`, so switching identity left them running and
 * delivering the previous owner's data into a cache that had just been emptied.
 *
 * Same two defences as {@link api}, and for the same reason — either alone
 * leaves a window: the shared signal aborts the request, and the epoch check
 * refuses a response that raced past the abort. Deliberately returns the
 * `Response` rather than a parsed body: these callers need the response itself.
 * A streamed body stops on the signal alone, which is why the signal is not
 * optional here.
 */
export async function accessFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const issuedAt = accessEpoch();
  const signal = init.signal ? AbortSignal.any([init.signal, accessSignal()]) : accessSignal();
  const res = await fetch(input, { ...init, signal, credentials: init.credentials ?? 'include' });
  if (accessEpoch() !== issuedAt) throw new AccessContextChanged();
  return res;
}

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPut = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/**
 * Signs in to the application. Unrelated to the Claude subscription credential.
 *
 * `userId` selects which local identity to act as; the backend accepts only the
 * identities it knows and never takes an owner from a request body elsewhere.
 */
export const ensureSession = (userId?: string) =>
  apiPost<{ userId: string }>('/api/auth/session', userId ? { userId } : {});
