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
    if (err instanceof Error) return new AppError('internal', err.message);
    return new AppError('internal', String(err));
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
