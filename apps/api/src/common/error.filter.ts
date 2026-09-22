import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { AccountingError } from '@daftar/accounting';
import { AppError, CountryPackError, CurrencyError, type ApiErrorBody, type ApiErrorCode } from '@daftar/domain-core';
import { RateLimitError, RateLimiterUnavailableError } from '../infra/redis';
import { getContext } from '../infra/request-context';
import type { Logger } from '../infra/logger';

/**
 * Error architecture (§29): the backend returns a STABLE ERROR CODE + requestId
 * + safe structured details. Messages are generic safe fallbacks; the UI
 * translates codes in the web/android localization layer. SQL text, stack
 * traces and internal class names never leak.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject('LOGGER') private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = getContext()?.requestId ?? 'unknown';

    const body = (code: ApiErrorCode, message: string, status: number, details?: Record<string, unknown>): void => {
      const payload: ApiErrorBody = { error: { code, message, requestId, ...(details ? { details } : {}) } };
      res.status(status).json(payload);
    };

    if (exception instanceof AppError) {
      body(exception.code, exception.message, exception.httpStatus, exception.details);
      return;
    }
    // A refusal from the accounting authority (§49). The stable code is the
    // contract; `toSafeJSON()` is the ONLY representation allowed out, and it
    // carries identifiers alone — never an amount, a rate, a balance, an
    // assertion, a SQLSTATE or the name of a unique index.
    if (exception instanceof AccountingError) {
      body('ACCOUNTING_REFUSED', 'The accounting authority refused this command', accountingStatus(exception.code), { ...exception.toSafeJSON() });
      return;
    }
    if (exception instanceof ZodError) {
      body('VALIDATION_FAILED', 'Validation failed', HttpStatus.BAD_REQUEST, {
        issues: exception.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
      });
      return;
    }
    if (exception instanceof RateLimitError) {
      res.setHeader('Retry-After', String(exception.retryAfterSeconds));
      body('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS);
      return;
    }
    if (exception instanceof RateLimiterUnavailableError) {
      // §67: fail closed with a safe, retryable contract — no internals leak.
      this.logger.error({ requestId, err: 'rate limiter backend unavailable' }, 'rate limiter outage');
      res.setHeader('Retry-After', '5');
      body('RATE_LIMITED', 'Service temporarily unavailable — retry shortly', HttpStatus.SERVICE_UNAVAILABLE);
      return;
    }
    if (exception instanceof CountryPackError) {
      body('UNSUPPORTED_COUNTRY', 'Unsupported country', HttpStatus.BAD_REQUEST);
      return;
    }
    if (exception instanceof CurrencyError) {
      body('UNSUPPORTED_CURRENCY', 'Unsupported currency', HttpStatus.CONFLICT);
      return;
    }
    if (exception instanceof HttpException) {
      const s = exception.getStatus();
      const map: Record<number, [ApiErrorCode, string]> = {
        400: ['VALIDATION_FAILED', 'Bad request'],
        401: ['UNAUTHENTICATED', 'Authentication required'],
        403: ['FORBIDDEN', 'Access denied'],
        404: ['NOT_FOUND', 'Resource not found'],
        413: ['MEDIA_TOO_LARGE', 'Payload too large'],
        415: ['MEDIA_INVALID', 'Unsupported media type'],
        429: ['RATE_LIMITED', 'Too many requests'],
      };
      const [code, msg] = map[s] ?? ['INTERNAL_ERROR', 'Internal error'];
      body(code, msg, s);
      return;
    }
    // PostgreSQL error codes → safe contracts
    const pg = exception as { code?: string; constraint?: string };
    if (pg.code === '23503') {
      body('VALIDATION_FAILED', 'Related record violates scope or does not exist', HttpStatus.BAD_REQUEST);
      return;
    }
    if (pg.code === '23505') {
      const c = pg.constraint ?? '';
      if (c.includes('store_slug')) {
        body('SLUG_TAKEN', 'Store slug is taken', HttpStatus.CONFLICT);
        return;
      }
      body('CONFLICT', 'Duplicate value', HttpStatus.CONFLICT, { constraint: c.replace(/_?\d*$/, '') });
      return;
    }
    if (pg.code === '42501' || pg.code === 'P0001') {
      body('FORBIDDEN', 'Access denied', HttpStatus.FORBIDDEN);
      return;
    }
    this.logger.error({ err: exception, requestId }, 'unhandled error');
    body('INTERNAL_ERROR', 'Internal error', HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Stable code → HTTP status. The mapping is exhaustive by construction: a new
 * accounting code that nobody classified lands on 400 rather than on 500, so
 * an unclassified refusal is still a refusal and never reads as an outage.
 */
function accountingStatus(code: string): number {
  if (code === 'accounting.forbidden' || code === 'accounting.branch_scope_violation' || code.startsWith('accounting.assertion_')) {
    return HttpStatus.FORBIDDEN;
  }
  if (code === 'accounting.entry_not_found') return HttpStatus.NOT_FOUND;
  if (
    code === 'accounting.idempotency_conflict' ||
    code === 'accounting.reversal_exists' ||
    code === 'accounting.reversal_of_reversal' ||
    code === 'accounting.opening_balance_exists' ||
    code === 'accounting.opening_balance_state_invalid' ||
    code === 'accounting.supersede_without_reversal' ||
    code === 'accounting.source_immutable'
  ) {
    return HttpStatus.CONFLICT;
  }
  return HttpStatus.BAD_REQUEST;
}
