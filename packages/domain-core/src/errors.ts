/**
 * DAFTAR API error model (shared with apps via shared-contracts re-export).
 * Never leak SQL / stack traces / internal class names to clients (Directive §26).
 */

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'SLUG_TAKEN'
  | 'SLUG_INVALID'
  | 'SLUG_RESERVED'
  | 'BASE_CURRENCY_LOCKED'
  | 'LAST_OWNER_REMOVAL'
  | 'UNSUPPORTED_CURRENCY'
  | 'UNSUPPORTED_COUNTRY'
  | 'UNSUPPORTED_LOCALE'
  | 'SESSION_REVOKED'
  | 'TOKEN_REUSE_DETECTED'
  | 'MEDIA_INVALID'
  | 'MEDIA_TOO_LARGE'
  | 'EMAIL_TAKEN'
  | 'ALREADY_MEMBER'
  | 'MEMBER_SUSPENDED'
  | 'INVITATION_EXISTS'
  | 'INVITATION_EXPIRED'
  | 'PLAN_LIMIT_EXCEEDED'
  | 'FEATURE_NOT_ENTITLED'
  | 'ROLE_IN_USE'
  // The accounting authority refused a command. The stable `accounting.*`
  // code travels in `details.accountingCode`: one HTTP contract, and a
  // machine-readable reason underneath it that the ledger and the client
  // share word for word.
  | 'ACCOUNTING_REFUSED'
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string; // localized, user-safe
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static validation(details: Record<string, unknown>): AppError {
    return new AppError('VALIDATION_FAILED', 'Validation failed', 400, details);
  }
  static unauthenticated(msg = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', msg, 401);
  }
  static forbidden(msg = 'Access denied'): AppError {
    return new AppError('FORBIDDEN', msg, 403);
  }
  static notFound(msg = 'Resource not found'): AppError {
    return new AppError('NOT_FOUND', msg, 404);
  }
  static conflict(code: ApiErrorCode, msg: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, msg, 409, details);
  }
}

/** Result type for domain operations. */
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
