/**
 * Typed accounting errors — stable machine codes, never financial values.
 *
 * Directive §78: an accounting error may carry an entry id, a business id, a
 * source id and a stable code. It may never carry an amount, a rate, a
 * balance, a key, an assertion, the canonical byte stream, a secret or a raw
 * payload. Every message built here is assembled from identifiers only, so a
 * log line or an HTTP response cannot leak financial truth by accident.
 *
 * The codes are the same strings the database raises, so one vocabulary spans
 * both implementations and a caller never has to know which layer refused.
 */

/** Every refusal this slice can produce. One string, one meaning, forever. */
export type AccountingErrorCode =
  // Authority (§17, §18, §55-§57)
  | 'accounting.assertion_missing'
  | 'accounting.assertion_malformed'
  | 'accounting.assertion_key_unknown'
  | 'accounting.assertion_invalid_signature'
  | 'accounting.assertion_expired'
  | 'accounting.assertion_replayed'
  | 'accounting.assertion_wrong_operation'
  | 'accounting.assertion_payload_mismatch'
  | 'accounting.assertion_key_conflict'
  // Authorization (§52, §54)
  | 'accounting.forbidden'
  | 'accounting.branch_scope_violation'
  // Payload (§26)
  | 'accounting.payload_invalid'
  | 'accounting.payload_unknown_field'
  | 'accounting.payload_missing_field'
  // Accounts (§29, §31)
  | 'accounting.account_not_found'
  | 'accounting.account_inactive'
  | 'accounting.account_foreign_business'
  | 'accounting.system_account_missing'
  | 'accounting.account_identity_locked'
  // Dates (§44)
  | 'accounting.entry_date_required'
  | 'accounting.entry_date_in_future'
  | 'accounting.entry_date_before_original'
  // Idempotency (§45-§49)
  | 'accounting.idempotency_conflict'
  // Sources — P2-S4 (§10-§34, §49)
  | 'accounting.assertion_wrong_source'
  | 'accounting.adjustment_reason_required'
  | 'accounting.reversal_reason_required'
  | 'accounting.reversal_exists'
  | 'accounting.reversal_of_reversal'
  | 'accounting.adjustment_detail_missing'
  | 'accounting.reversal_detail_missing'
  | 'accounting.entry_not_found'
  | 'accounting.entry_base_currency_mismatch'
  | 'accounting.opening_balance_exists'
  | 'accounting.opening_balance_state_invalid'
  | 'accounting.opening_balance_detail_missing'
  | 'accounting.supersede_without_reversal'
  | 'accounting.source_immutable'
  // FX rate registry — P2-S5 (§11-§46)
  | 'accounting.fx_rate_invalid'
  | 'accounting.fx_rate_missing'
  | 'accounting.fx_rate_conflict'
  | 'accounting.fx_rate_immutable'
  | 'accounting.fx_same_currency'
  | 'accounting.fx_currency_unknown'
  | 'accounting.fx_effective_at_required'
  | 'accounting.fx_effective_at_precision'
  // Allocation residuals — P2-S5 (§55)
  | 'accounting.rounding_residual_unbounded'
  // Accounting periods — P2-S6 (§9-§40)
  | 'accounting.period_not_found'
  | 'accounting.period_range_invalid'
  | 'accounting.period_overlap'
  | 'accounting.period_not_contiguous'
  | 'accounting.period_not_open'
  | 'accounting.period_not_closed'
  | 'accounting.period_closed'
  | 'accounting.period_missing_for_date'
  | 'accounting.period_reopen_reason_required'
  | 'accounting.period_immutable'
  | 'accounting.period_extension_missing';

/**
 * Safe identifiers that may accompany a refusal. Deliberately a closed shape:
 * anything not named here cannot reach an error message.
 */
export interface AccountingErrorContext {
  readonly businessId?: string;
  readonly entryId?: string;
  /** The entry a reversal is about. An identifier, like every field here. */
  readonly originalEntryId?: string;
  readonly openingBalanceId?: string;
  readonly sourceType?: string;
  readonly sourceId?: string;
  readonly accountRef?: string;
  readonly lineNo?: number;
  /** An FX rate row's id. An identifier, like every field here — never the rate. */
  readonly rateId?: string;
  /** The ordered pair a refusal is about, e.g. `USD->ILS`. Currency codes only. */
  readonly currencyPair?: string;
  /** An accounting period's id. An identifier, like every field here. */
  readonly periodId?: string;
  /** A civil date a refusal is about, `YYYY-MM-DD`. A date is not a value. */
  readonly entryDate?: string;
}

export class AccountingError extends Error {
  readonly code: AccountingErrorCode;
  readonly context: AccountingErrorContext;

  constructor(code: AccountingErrorCode, message: string, context: AccountingErrorContext = {}) {
    super(message);
    this.name = 'AccountingError';
    this.code = code;
    this.context = context;
  }

  /**
   * The only representation that should ever be logged or returned. It carries
   * the code and the safe identifiers, and nothing else — in particular not
   * `message`, which a future edit could accidentally widen.
   */
  toSafeJSON(): { code: AccountingErrorCode } & AccountingErrorContext {
    return { code: this.code, ...this.context };
  }
}

export const accountingError = (code: AccountingErrorCode, message: string, context: AccountingErrorContext = {}): AccountingError =>
  new AccountingError(code, message, context);

/**
 * Map a PostgreSQL error raised by the posting primitive back to a typed
 * error. The database raises `accounting.<code>: <safe text>`; anything that
 * does not match that shape is not translated, because inventing a code for an
 * unrecognized failure would hide it.
 */
export function parseDatabaseAccountingError(message: string): AccountingErrorCode | null {
  const m = /^(accounting\.[a-z_]+)\b/.exec(message);
  if (!m) return null;
  return m[1] as AccountingErrorCode;
}
