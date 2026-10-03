import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { AccountingError } from '@daftar/accounting';
import { AppError, CountryPackError, CurrencyError, type ApiErrorBody, type ApiErrorCode } from '@daftar/domain-core';
import { RateLimitError, RateLimiterUnavailableError } from '../infra/redis';
import { getContext } from '../infra/request-context';
import type { Logger } from '../infra/logger';
import { inventoryRefusal, parseDatabaseInventoryCode } from '../modules/inventory/inventory-errors';
import {
  isSellingCode,
  isSellingInternalInvariant,
  parseDatabaseSellingCode,
  parseDatabaseSellingInternalCode,
  sellingRefusal,
} from '../modules/selling/selling-errors';

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
    // P3-S3 (PHASE_3_S3_CONTRACT §3). The movement services translate every
    // refusal themselves; this catches the ones a database trigger raises on
    // a path that does not — an archive that races a stock movement
    // (`*_has_stock`, A-19) — so the typed code and its status still reach
    // the client. Only the codes P3-S3 introduced are matched: every refusal
    // that existed before keeps its accepted rendering below.
    if (pg.code === 'P0001') {
      const code = parseDatabaseInventoryCode(exception);
      if (code !== null && P3_S3_INVENTORY_CODES.has(code)) {
        const e = inventoryRefusal(code);
        body(e.code, e.message, e.httpStatus, e.details);
        return;
      }
    }
    // P4-S2 (TL-P4-S2-R5). The KNOWN Phase 4 selling surface, in two halves,
    // and NEITHER of them is an authorization denial.
    //
    // (A) A PUBLIC selling code — `sale.*`, `invoice.*`, `customer.*` — gets
    //     the status the stable registry already assigns it, through
    //     `sellingRefusal`, the one selling mapping. There is no second
    //     status table here on purpose: the registry classifies idempotency
    //     conflicts as 409, current-state conflicts by their own entry,
    //     payload problems as 400/422, permission problems as 403 and a
    //     missing target as 404, so those come out right by construction. A
    //     code whose registered status is wrong is fixed in the registry.
    //
    //     The services translate these themselves; this catches the ones a
    //     trigger raises on a path that does not — the `sale.immutable` and
    //     `invoice.immutable` guards, `customer.not_deletable` — so the typed
    //     code and its status still reach the client.
    //
    // (B) An INTERNAL Phase 4 invariant — `selling.*` — is a violated
    //     structural law, NOT a merchant refusal and not an authorization
    //     denial: «An internal invariant failure is not an authorization
    //     denial.» It becomes 500 with the generic body, and the invariant's
    //     name goes to the LOG beside the request id, where the engineer who
    //     has to fix it is reading. The registry is explicit (there is no
    //     `selling.*` wildcard) because most `selling.*` raises are
    //     migration-time end-state assertions no request can reach.
    //
    //     The body carries the generic envelope alone — `INTERNAL_ERROR`, the
    //     safe sentence and the request id, with NO `details`. SQL, the
    //     routine's message after the colon, an amount, a journal entry id,
    //     an assertion body and a stack never leave the process, and the
    //     invariant vocabulary is not part of the merchant contract either:
    //     no `error.selling.*` entry exists in any of the three catalogues,
    //     so a client that received one could render nothing from it.
    //
    // Both sit BEFORE the historical `P0001` fallback and change nothing
    // about it: an UNKNOWN `P0001` is not redesigned here (it keeps the
    // accepted Phase 1-3 rendering until it is separately audited), and
    // `42501` is still 403.
    if (pg.code === 'P0001') {
      const selling = parseDatabaseSellingCode(exception);
      if (selling !== null && isSellingCode(selling)) {
        const e = sellingRefusal(selling);
        body(e.code, e.message, e.httpStatus, e.details);
        return;
      }
      const invariant = parseDatabaseSellingInternalCode(exception);
      if (invariant !== null && isSellingInternalInvariant(invariant)) {
        this.logger.error({ requestId, invariant }, 'phase 4 selling invariant violated');
        body('INTERNAL_ERROR', 'Internal error', HttpStatus.INTERNAL_SERVER_ERROR);
        return;
      }
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
  if (code === 'accounting.entry_not_found' || code === 'accounting.period_not_found') return HttpStatus.NOT_FOUND;
  if (
    code === 'accounting.idempotency_conflict' ||
    code === 'accounting.reversal_exists' ||
    code === 'accounting.reversal_of_reversal' ||
    code === 'accounting.opening_balance_exists' ||
    code === 'accounting.opening_balance_state_invalid' ||
    code === 'accounting.supersede_without_reversal' ||
    code === 'accounting.source_immutable' ||
    // Two merchants stated different rates for one pair at one instant, or a
    // rate row was asked to change. Both are conflicts over existing truth,
    // not malformed requests.
    code === 'accounting.fx_rate_conflict' ||
    code === 'accounting.fx_rate_immutable' ||
    // P2-S6. Every one of these is a refusal about the SHAPE OF THE BOOKS the
    // merchant already has — a month that overlaps an existing one, a gap the
    // topology will not take, a period already in the state asked for, or a
    // posting whose date the existing periods refuse. The request itself is
    // well formed, so 400 would tell the caller to fix a payload that is not
    // wrong. A malformed period payload (`period_range_invalid`, a missing or
    // oversized reopen reason) still falls through to 400 below, which is the
    // distinction this list exists to keep.
    code === 'accounting.period_overlap' ||
    code === 'accounting.period_not_contiguous' ||
    code === 'accounting.period_not_open' ||
    code === 'accounting.period_not_closed' ||
    code === 'accounting.period_closed' ||
    code === 'accounting.period_missing_for_date' ||
    // The closed-books topology refusals. Each one says the merchant's books
    // are in a state that forbids the request, not that the request was
    // malformed: close an earlier period first, reopen a later one first, or
    // reopen the closed periods before writing behind them.
    code === 'accounting.period_close_order' ||
    code === 'accounting.period_reopen_order' ||
    code === 'accounting.period_prepend_closed_history' ||
    code === 'accounting.period_closed_history' ||
    code === 'accounting.period_topology_invalid' ||
    code === 'accounting.period_immutable' ||
    // P2-S7. An unbalanced business-wide trial balance is not a malformed
    // request and not an outage: the request was well formed and the server
    // is working. It is the STATE OF THE BOOKS that forbids the answer, which
    // is what 409 says. 500 would read as "try again"; 400 would tell the
    // caller to fix a payload that is not wrong. The body carries the code, a
    // request id and no amounts at all (§56) — the totals that disagree are
    // exactly what must not reach a log line.
    code === 'accounting.report_unbalanced' ||
    // P3-S3 (PHASE_3_S3_CONTRACT §3, A-14). The books already hold an
    // inventory-sourced entry or an opening balance an inventory opening is
    // bound to, and that state forbids the command: a posting whose
    // inventory detail does not match its entry (at COMMIT), reversing an
    // entry only its inventory document may own, or superseding / posting
    // over an opening balance the stock decomposes. Conflicts, not payloads.
    code === 'accounting.inventory_detail_missing' ||
    code === 'accounting.inventory_entry_mismatch' ||
    code === 'accounting.reversal_source_domain_owned' ||
    code === 'accounting.opening_balance_inventory_conflict' ||
    code === 'accounting.opening_balance_inventory_bound' ||
    // P3-S8 R-B1a (Annex R §2.1, §2.9; 0069). After a business's first stock
    // movement the Inventory system account changes only through an
    // inventory or purchasing operation: a manual adjustment or an opening
    // balance with an Inventory line is refused at COMMIT. The books' state
    // forbids it, the payload is well formed — a conflict, like its S3
    // siblings, and deliberately not an `AccountingErrorCode`.
    code === 'accounting.inventory_account_domain_owned'
  ) {
    return HttpStatus.CONFLICT;
  }
  return HttpStatus.BAD_REQUEST;
}

/**
 * The refusals P3-S3 added to the inventory vocabulary (PHASE_3_S3_CONTRACT
 * §3), rendered through `inventoryRefusal` — the one inventory mapping — when
 * a database trigger raises one on a path that did not translate it. The set
 * is closed on purpose: a code that existed before P3-S3 is not in it, so no
 * accepted status changes.
 */
const P3_S3_INVENTORY_CODES: ReadonlySet<string> = new Set([
  // 409: a conflict with a document or with stock that already exists.
  'inventory.idempotency_conflict',
  'inventory.document_id_conflict',
  'inventory.valuation_changed',
  'inventory.stocktake_changed',
  'inventory.opening_case_changed',
  'inventory.opening_valuation_mismatch',
  'inventory.opening_already_posted',
  'inventory.opening_state_invalid',
  'inventory.stocktake_already_open',
  'inventory.stocktake_state_invalid',
  'inventory.warehouse_has_stock',
  'inventory.variant_has_stock',
  'inventory.product_has_stock',
  // 404 / 400: the request names nothing, or cannot be applied as stated.
  'inventory.stocktake_not_found',
  'inventory.stocktake_empty',
  'inventory.unit_cost_required',
  'inventory.unit_cost_not_applicable',
  'inventory.transfer_same_warehouse',
  'inventory.duplicate_line',
  'inventory.lines_required',
]);
