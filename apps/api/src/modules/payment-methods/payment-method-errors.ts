import { AppError } from '@daftar/domain-core';

/**
 * The stable refusal vocabulary of payment methods (PHASE_3_S6_CONTRACT §3),
 * as the merchant API reports it. This module OWNS the `payment_method.*`
 * table; the purchasing error model delegates every `payment_method.*` code
 * here, so the code has one HTTP contract wherever it is met — the method
 * commands, a supplier payment or a refund naming an inactive method.
 *
 * Classified by an explicit table, never by the shape of a name. A code that
 * is not in it is not a payment-method refusal (`isPaymentMethodCode` is
 * false), and the caller's own model decides what it is — an unclassified
 * code there is a defect, never a guessed status. A message never carries an
 * account, a name or an amount, and the database's text after the colon is
 * never forwarded.
 */
const PAYMENT_METHOD_STATUS = {
  'payment_method.not_found': 404,
  'payment_method.posting_account_not_found': 422,
  // MP-1: not active, not an asset, or not a settlement account (A-06).
  'payment_method.posting_account_ineligible': 422,
  // MP-2: the account of a method a payment or refund names is fixed.
  'payment_method.posting_account_locked': 409,
  'payment_method.inactive': 409,
  'payment_method.state_invalid': 409,
  'payment_method.revision_changed': 409,
  'payment_method.idempotency_conflict': 409,
  'payment_method.name_required': 400,
  'payment_method.name_invalid': 400,
  // A guard refusal no route can reach (`system_type` and the rest are never
  // edited): a defect, reported with its typed code.
  'payment_method.field_immutable': 500,
  // MP-2: no route deletes a method; the guard refuses every role.
  'payment_method.not_deletable': 409,
} as const satisfies Readonly<Record<`payment_method.${string}`, 400 | 404 | 409 | 422 | 500>>;

/** A classified `payment_method.*` refusal code. */
export type PaymentMethodCode = keyof typeof PAYMENT_METHOD_STATUS;

/** True iff `code` is a classified `payment_method.*` code. */
export function isPaymentMethodCode(code: string): code is PaymentMethodCode {
  return Object.hasOwn(PAYMENT_METHOD_STATUS, code);
}

/**
 * Every classified `payment_method.*` code, in table order — the list the
 * web's error-key test enumerates (PHASE_3_S7_CONTRACT T-10, Annex R #10).
 * Additive: the table itself is unchanged.
 */
export const PAYMENT_METHOD_CODES: readonly PaymentMethodCode[] = Object.keys(PAYMENT_METHOD_STATUS).filter(isPaymentMethodCode);

const DATABASE_CODE_RE = /^(payment_method\.[a-z_]+)\b/;

/** The `payment_method.*` code a database refusal carries, or null. */
export function parseDatabasePaymentMethodCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/**
 * A classified payment-method code → its §3 HTTP contract; the code travels
 * in `details.paymentMethodCode`. A 500-class code is a defect reported with
 * its typed code.
 */
export function paymentMethodRefusal(code: PaymentMethodCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, paymentMethodCode: code };
  const status = PAYMENT_METHOD_STATUS[code];
  switch (status) {
    case 404:
      return new AppError('NOT_FOUND', 'Resource not found', 404, details);
    case 409:
      return new AppError('CONFLICT', 'The current state does not allow this change', 409, details);
    case 422:
      return new AppError('VALIDATION_FAILED', 'The command cannot be processed', 422, details);
    case 400:
      return new AppError('VALIDATION_FAILED', 'Validation failed', 400, details);
    case 500:
      return new AppError('INTERNAL_ERROR', 'Internal error', 500, details);
  }
}
