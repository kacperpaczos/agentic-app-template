/**
 * Recognisable error taxonomy. Every layer (HTTP, MCP, AG-UI, sandbox) maps its
 * failures onto exactly one of these codes so the UI and the acceptance tests
 * can tell an integration failure from a domain rejection.
 */
export const APP_ERROR_CODES = [
  'validation_failed',
  'not_found',
  'forbidden',
  'unauthenticated',
  /** Subscription usage limit reached. Distinct from a broken login. */
  'rate_limited',
  'conflict',
  'precondition_failed',
  'domain_rule_violated',
  'unsupported_operation',
  'integration_failed',
  'model_failed',
  /**
   * The conversation is kept here, but the Claude Agent SDK transcript it
   * resumes is gone. Distinct from `integration_failed` on purpose: it is not a
   * broken integration but a recoverable loss of the model's memory, and the
   * user has to be told that the memory was *not* restored rather than shown a
   * generic failure.
   */
  'session_transcript_lost',
  'sandbox_denied',
  'cancelled',
  'internal',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<AppErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  rate_limited: 429,
  conflict: 409,
  precondition_failed: 412,
  domain_rule_violated: 422,
  unsupported_operation: 501,
  integration_failed: 502,
  model_failed: 502,
  // The two sides of the conversation disagree about what still exists: the
  // application kept it, the SDK did not.
  session_transcript_lost: 409,
  sandbox_denied: 403,
  cancelled: 499,
  internal: 500,
};

export interface AppErrorShape {
  code: AppErrorCode;
  message: string;
  /** Machine-readable detail; never contains secrets. */
  details?: unknown;
}

export class AppError extends Error implements AppErrorShape {
  readonly code: AppErrorCode;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toJSON(): AppErrorShape {
    return { code: this.code, message: this.message, details: this.details };
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    const zod = zodIssues(err);
    /*
     * A schema rejection is a validation failure wherever it happens.
     *
     * Every `schema.parse(...)` that was not wrapped by hand used to arrive
     * here as a bare `Error` and leave as `internal` — a 500 whose message was
     * the whole serialised issue list, which says "the server broke" about a
     * request the server understood perfectly well and correctly refused. The
     * code and the issue list are recovered here so that one unguarded parse
     * cannot turn a recognisable cause into an unrecognisable one.
     */
    if (zod) {
      return new AppError('validation_failed', 'Nieprawidlowe dane wejsciowe.', { issues: zod });
    }
    if (err instanceof Error) return new AppError('internal', err.message);
    return new AppError('internal', String(err));
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/**
 * Reads a Zod rejection without importing Zod's class.
 *
 * Structural on purpose: the issue list is part of Zod's public error shape,
 * while `instanceof ZodError` breaks the moment two copies of the library end
 * up in one process — which is exactly the situation a monorepo with a module
 * boundary creates. Only a `name` of `ZodError` with an array of issues counts,
 * so an ordinary error carrying an `issues` field is not mistaken for one.
 */
function zodIssues(err: unknown): Array<{ path: string; message: string }> | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: unknown; issues?: unknown };
  if (e.name !== 'ZodError' || !Array.isArray(e.issues)) return null;
  return e.issues.map((i) => {
    const issue = i as { path?: unknown; message?: unknown };
    return {
      path: Array.isArray(issue.path) ? issue.path.join('.') : '',
      message: typeof issue.message === 'string' ? issue.message : 'nieprawidlowa wartosc',
    };
  });
}
