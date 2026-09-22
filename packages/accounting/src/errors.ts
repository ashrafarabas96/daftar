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
  | 'accounting.reversal_detail_missing'
  | 'accounting.entry_not_found'
  | 'accounting.entry_base_currency_mismatch'
  | 'accounting.opening_balance_exists'
  | 'accounting.opening_balance_state_invalid'
  | 'accounting.opening_balance_detail_missing'
  | 'accounting.supersede_without_reversal'
  | 'accounting.source_immutable';

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
