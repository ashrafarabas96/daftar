import {
  buildInventoryPayload,
  CANONICAL_UUID_RE,
  documentTextWords,
  INVENTORY_OPERATION_CODES,
  inventoryIntentSha256,
  yyyymmdd,
  type InventoryOperationCode,
  type InventoryPayload,
  type InventoryPayloadField,
} from '@daftar/inventory';
import { receivablesRefusal } from './receivables-errors';

/**
 * The `invctl/1` payload and intent digest of the two P4-S4 commands.
 *
 * ## The idempotency precedent, unchanged (map §7)
 *
 * There is NO second mechanism and no generic idempotency-key subsystem in
 * this repository. Each command's FIRST ACT inside the database is to consume
 * an `invctl/1` assertion over its own arguments (`0068:7-10`, `0078:1024`),
 * and the document's `intent_sha256` is what a replay is proved against:
 *
 * - same id + same intent → the stored rows are returned and nothing is
 *   written;
 * - same id + different intent → `customer_payment.idempotency_conflict` /
 *   `customer_credit_application.idempotency_conflict`.
 *
 * **The intent is REQUEST-ONLY.** Every FX snapshot, base amount, release,
 * dust and realized figure, the posting account and the created credit's
 * carrying base are DERIVED and are deliberately excluded, so the comparison
 * can happen before any state is read and a moved rate is not a false
 * conflict (`0068:585-600`, `0078:558-567`,
 * `[[daftar-registry-before-state]]`). Child ids are part of the intent, and
 * are idempotency keys in their own right: an allocation id already stored
 * under another payment is `customer_payment.allocation_id_reused`, a stable
 * domain refusal and never a raw primary-key violation (R-74,
 * `0068:649-651`).
 *
 * ## The temporary seam this module carried, and its removal
 *
 * `InventoryOperationCode` and `INVENTORY_PAYLOAD_SCHEMAS`
 * (`packages/inventory/src/payload.ts`) are CLOSED: an op code that is not in
 * the union has no field schema, and `canonicalInventoryPayload` refuses to
 * hash a payload it cannot type. While the package lacked the two codes they
 * were resolved here through one named, runtime-checked lookup against
 * `INVENTORY_OPERATION_CODES` rather than through a cast, every call refused
 * `customer_payment.registry_incomplete` (500) naming the exact file to edit,
 * and a `P4S4PayloadRegistryTripwire` declaration made the seam impossible to
 * leave behind: the day the package registered the codes it stopped compiling.
 *
 * IT FIRED. `packages/inventory/src/payload.ts` now carries
 * `InventoryP4S4OperationCode`, both `INVENTORY_PAYLOAD_SCHEMAS` entries and
 * both `INVENTORY_OPERATION_INTENT_FIELDS` entries, so the tripwire is gone and
 * the two constants below are `satisfies InventoryOperationCode` — each checked
 * against the registry by the compiler, the same device
 * `selling-permissions.ts` ended on with its `Extract` from `Permission`.
 *
 * The module STAYS, exactly as `selling-permissions.ts` stayed when its own
 * tripwire fired. Its builders are not duplicates of anything: the package
 * registers the two SCHEMAS and `customer-settlement-payloads.ts` carries the
 * two PLANS, but neither file carries a `customerCollectPaymentPayload` or
 * `customerApplyCreditPayload`, and the package module says so in as many words
 * ("NOT HERE, deliberately: the `invpl/1` field streams and intent digests").
 * Lifting these two builders into the package is a later edit and belongs with
 * the `customer-settlement.ts` lift of `P4_S4_REQUIRED_WIRING`; it is not what
 * registering the schemas asked for.
 *
 * `receivablesOperationCode` is kept for the same reason the lookup was named
 * in the first place — the services call it to re-establish the code at the
 * point of use, and it now always succeeds.
 *
 * ## ONE KNOWN DIVERGENCE FROM `0081`, NOT FIXED HERE
 *
 * `collectIntentFields` below does NOT reproduce the intent
 * `customer_collect_payment` computes, in two ways, and both are visible in
 * `0081:1851-1865`:
 *
 *   - the routine signs `lower(p_currency_code::text)` — the SERVER-RESOLVED
 *     currency, non-NULL by its own shape check — where this file signs the
 *     client's raw nullable `currency`;
 *   - the routine's intent carries `p_credit_amount_minor` (recorded in the
 *     routine's own COMMENT at `0081:2151` as part of the request-only intent)
 *     where this file omits it, so the two streams differ in length.
 *
 * `customer-payment.service.ts:517` compares this file's digest against the
 * value the ROUTINE stored, so while they disagree every replay of a stored
 * payment is a false `customer_payment.idempotency_conflict`. The package's
 * `INVENTORY_OPERATION_INTENT_FIELDS` entry follows `0081`, because
 * `payments.intent_sha256` is a stored database fact and the registry is
 * permanent. Closing the gap on this side is a change to WHICH currency the
 * service may know before it reads state, which is the service's own documented
 * constraint (`customer-payment.service.ts:502-504`) and the `0081` argument
 * boundary of `P4_S4_REQUIRED_WIRING`' fourth row — not a package edit.
 */

/**
 * The `invctl/1` operation code of collecting a customer payment.
 *
 * `satisfies` rather than a bare literal: the code must BE a registered
 * `InventoryOperationCode`, so the registry is the authority and this constant
 * is checked against it by the compiler. A code renamed or dropped there is a
 * type error here rather than a command that silently mints nothing.
 */
export const CUSTOMER_COLLECT_PAYMENT_OP = 'customer.collect_payment' satisfies InventoryOperationCode;
/** The `invctl/1` operation code of applying an existing customer credit to an invoice. */
export const CUSTOMER_APPLY_CREDIT_OP = 'customer.apply_credit' satisfies InventoryOperationCode;

/** A payment's allocations, 0..50 (OQ-4 relaxes the supplier precedent's lower bound to zero). */
export const CUSTOMER_PAYMENT_MAX_ALLOCATIONS = 50;
/** A payment's reference, in characters after trimming. */
export const RECEIVABLES_REFERENCE_MAX = 100;

/**
 * The op code as the package types it, or a loud 500 naming what is missing.
 * One lookup, no cast: the value that comes back IS a member of
 * `INVENTORY_OPERATION_CODES`, so nothing downstream has to trust this file.
 */
export function receivablesOperationCode(code: string): InventoryOperationCode {
  const registered = INVENTORY_OPERATION_CODES.find((c) => c === code);
  if (registered === undefined) {
    throw receivablesRefusal('customer_payment.registry_incomplete', {
      operationCode: code,
      missingIn: ['packages/inventory/src/payload.ts', 'apps/api/src/modules/inventory/inventory-authorization.ts'],
    });
  }
  return registered;
}

const operationCode = receivablesOperationCode;

function invalid(message: string): never {
  throw receivablesRefusal('customer_payment.allocations_invalid', { reason: message });
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) invalid(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const int = (value: bigint): InventoryPayloadField => ({ kind: 'integer', value });
const code = (currency: string): InventoryPayloadField => ({ kind: 'code', value: currency.toLowerCase() });
const nullable = (value: string | null, what: string): InventoryPayloadField => (value === null ? { kind: 'null' } : uuid(value, what));

/** A reference: already trimmed, 1..100 characters, or NULL — as its eight SHA-256 words. */
function referenceWords(reference: string | null): InventoryPayloadField[] {
  return documentTextWords(reference, 'reference', { min: 1, max: RECEIVABLES_REFERENCE_MAX }).map(
    (w): InventoryPayloadField => (w === null ? { kind: 'null' } : int(w)),
  );
}

/** A bound FX snapshot as four fields: rate_id, rate R10, source, epoch-second instant. */
export interface ReceivableRateFields {
  readonly rateId: string | null;
  readonly rateR10: bigint;
  readonly source: 'base' | 'manual' | 'provider';
  readonly rateAtEpochSeconds: bigint;
}

const DOMESTIC_RATE_R10 = 10_000_000_000n;

function rateFields(rate: ReceivableRateFields): InventoryPayloadField[] {
  if (rate.source === 'base' ? rate.rateR10 !== DOMESTIC_RATE_R10 || rate.rateId !== null : rate.rateR10 <= 0n || rate.rateId === null) {
    invalid('a domestic rate is exactly 1 with no registry row; a foreign rate is positive with one');
  }
  return [nullable(rate.rateId, 'rate_id'), int(rate.rateR10), { kind: 'code', value: rate.source }, int(rate.rateAtEpochSeconds)];
}

// ── customer.collect_payment ─────────────────────────────────────────────

/** One allocation as the CLIENT states it: the two amounts and the invoice it settles. */
export interface CollectPaymentIntentAllocation {
  /** Client-supplied: the idempotency key of this leg, and the accounting `source_id` of its entry. */
  readonly allocationId: string;
  readonly invoiceId: string;
  /** `p` > 0, in the payment currency. */
  readonly paymentAmountMinor: bigint;
  /** `a` > 0, in the invoice's currency. */
  readonly appliedMinor: bigint;
}

export interface CollectPaymentIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the idempotency key (P4-AL-30 — the document uuid, never an `idempotency_key` column). */
  readonly paymentId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  /** `YYYY-MM-DD`, bound by the client: a command reads no clock. */
  readonly paymentDate: string;
  /**
   * The payment currency `P`, upper-case ISO, **exactly as the client stated
   * it** — NULL included, which means "the business's base currency".
   *
   * The intent digest binds the client's own value and never the resolved one,
   * which is what keeps it request-only and computable before any state is
   * read. The RESOLVED code is a payload field (`resolvedCurrency`), on the
   * post-state side of the same split that keeps every rate, base and release
   * out of the intent.
   */
  readonly currency: string | null;
  readonly amountMinor: bigint;
  readonly reference: string | null;
  /**
   * Client-supplied when the payment may create a surplus credit, so the
   * credit's id is part of the intent and a replay cannot mint a second
   * credit. NULL asserts "this payment is fully allocated".
   */
  readonly creditId: string | null;
  /** In `line_no` order, 0..50. */
  readonly allocations: readonly CollectPaymentIntentAllocation[];
}

function assertAllocations(input: CollectPaymentIntentInput): void {
  const a: readonly CollectPaymentIntentAllocation[] = input.allocations;
  if (!Array.isArray(input.allocations)) invalid('allocations must be a list');
  if (a.length > CUSTOMER_PAYMENT_MAX_ALLOCATIONS) invalid(`a payment has 0..${CUSTOMER_PAYMENT_MAX_ALLOCATIONS} allocations`);
  if (new Set(a.map((x) => x.allocationId)).size !== a.length || new Set(a.map((x) => x.invoiceId)).size !== a.length) {
    invalid('a payment allocates once to each invoice, each allocation with its own id');
  }
  if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) invalid('the payment amount must be positive');
  let total = 0n;
  for (const x of a) {
    if (typeof x.paymentAmountMinor !== 'bigint' || x.paymentAmountMinor <= 0n) invalid('a payment amount must be positive');
    if (typeof x.appliedMinor !== 'bigint' || x.appliedMinor <= 0n) invalid('an applied amount must be positive');
    total += x.paymentAmountMinor;
  }
  // OQ-4's closure, stated at the intent layer so no assertion is minted for a
  // command the routine could never accept: a surplus needs a credit id and a
  // fully-allocated payment must not carry one.
  if (total > input.amountMinor) invalid('a payment cannot allocate more than it received');
  if (total < input.amountMinor !== (input.creditId !== null)) {
    invalid('a payment names a credit id exactly when it carries a surplus');
  }
}

function collectIntentFields(input: CollectPaymentIntentInput): InventoryPayloadField[] {
  assertAllocations(input);
  const fields: InventoryPayloadField[] = [
    uuid(input.paymentId, 'payment_id'),
    uuid(input.customerId, 'customer_id'),
    uuid(input.paymentMethodId, 'payment_method_id'),
    int(yyyymmdd(input.paymentDate)),
    input.currency === null ? { kind: 'null' } : code(input.currency),
    int(input.amountMinor),
    ...referenceWords(input.reference),
    nullable(input.creditId, 'credit_id'),
    int(BigInt(input.allocations.length)),
  ];
  for (const a of input.allocations) {
    fields.push(uuid(a.allocationId, 'allocation_id'), uuid(a.invoiceId, 'invoice_id'), int(a.paymentAmountMinor), int(a.appliedMinor));
  }
  return fields;
}

/** The payment's intent digest: the value `payments.intent_sha256` stores, computable before any state is read. */
export function customerCollectPaymentIntentSha256(input: CollectPaymentIntentInput): string {
  return inventoryIntentSha256(operationCode(CUSTOMER_COLLECT_PAYMENT_OP), input.tenantId, input.businessId, collectIntentFields(input));
}

/** One allocation as the SERVER bound it: the client's fields plus every derived figure. */
export interface CollectPaymentPayloadAllocation extends CollectPaymentIntentAllocation {
  /** The invoice's own currency `C`, upper-case ISO. */
  readonly invoiceCurrency: string;
  /** `pb = conv_Rp(p)`. */
  readonly paymentBaseMinor: bigint;
  /** `X = T − O`. */
  readonly arReleasedBeforeMinor: bigint;
  /** `rel = R(X + a) − R(X)`. */
  readonly carryingReleasedMinor: bigint;
  /** `rel − conv_R(a)`, signed. */
  readonly arDustBaseMinor: bigint;
  /** `pb − rel`, signed. */
  readonly realizedFxMinor: bigint;
}

export interface CollectPaymentPayloadInput extends CollectPaymentIntentInput {
  /** The method's posting account, as read. A client never states it. */
  readonly postingAccountId: string;
  /** The payment's FX snapshot at `payment_date`. */
  readonly rate: ReceivableRateFields;
  /** `Σ pb_i` plus the surplus credit's carrying base — never `conv(Σ p_i)`. */
  readonly baseAmountMinor: bigint;
  /** The surplus credit's `(OA, OB)`, or NULL when the payment is fully allocated. */
  readonly credit: { readonly originalAmountMinor: bigint; readonly originalCarryingBaseMinor: bigint } | null;
  /**
   * The payment currency the SERVER resolved: the client's `currency` when it
   * stated one, the business's `base_currency` when it stated NULL. This is
   * the code the routine stores, every line carries and the FX snapshot was
   * taken for — so it is a payload field and never an intent field.
   */
  readonly resolvedCurrency: string;
  readonly allocations: readonly CollectPaymentPayloadAllocation[];
}

/**
 * `customer.collect_payment`: payment_id, customer_id, payment_method_id,
 * posting_account_id, payment_date, currency, amount, rate_id, rate,
 * rate_source, rate_at, base_amount, reference_w1..w8, credit_id,
 * credit_amount, credit_carrying_base, allocation_count, then per allocation
 * (allocation_id, invoice_id, invoice_currency, payment_amount, payment_base,
 * applied, ar_released_before, carrying_released, ar_dust, realized).
 *
 * This is the routine's argument order, which is the whole point of the
 * digest: the assertion the routine consumes was signed over exactly the
 * arguments it was called with.
 */
export function customerCollectPaymentPayload(input: CollectPaymentPayloadInput): { readonly payload: InventoryPayload; readonly intentSha256: string } {
  const intentSha256 = customerCollectPaymentIntentSha256(input);
  let baseTotal = 0n;
  for (const a of input.allocations) {
    if (a.realizedFxMinor !== a.paymentBaseMinor - a.carryingReleasedMinor) invalid('realized must be payment_base - carrying_released');
    if (a.invoiceCurrency.toUpperCase() === input.resolvedCurrency.toUpperCase() && a.paymentAmountMinor !== a.appliedMinor) {
      invalid('a payment in the invoice currency pays exactly what it applies');
    }
    baseTotal += a.paymentBaseMinor;
  }
  if (input.credit !== null) baseTotal += input.credit.originalCarryingBaseMinor;
  if (input.baseAmountMinor !== baseTotal) invalid('the payment base must be the sum of the allocation bases and the surplus credit base');
  if ((input.credit === null) !== (input.creditId === null)) invalid('a surplus credit and its id are stated together');
  const fields: InventoryPayloadField[] = [
    uuid(input.paymentId, 'payment_id'),
    uuid(input.customerId, 'customer_id'),
    uuid(input.paymentMethodId, 'payment_method_id'),
    uuid(input.postingAccountId, 'posting_account_id'),
    int(yyyymmdd(input.paymentDate)),
    code(input.resolvedCurrency),
    int(input.amountMinor),
    ...rateFields(input.rate),
    int(input.baseAmountMinor),
    ...referenceWords(input.reference),
    nullable(input.creditId, 'credit_id'),
    input.credit === null ? { kind: 'null' } : int(input.credit.originalAmountMinor),
    input.credit === null ? { kind: 'null' } : int(input.credit.originalCarryingBaseMinor),
    int(BigInt(input.allocations.length)),
  ];
  for (const a of input.allocations) {
    fields.push(
      uuid(a.allocationId, 'allocation_id'),
      uuid(a.invoiceId, 'invoice_id'),
      code(a.invoiceCurrency),
      int(a.paymentAmountMinor),
      int(a.paymentBaseMinor),
      int(a.appliedMinor),
      int(a.arReleasedBeforeMinor),
      int(a.carryingReleasedMinor),
      int(a.arDustBaseMinor),
      int(a.realizedFxMinor),
    );
  }
  return { payload: buildInventoryPayload(operationCode(CUSTOMER_COLLECT_PAYMENT_OP), input.tenantId, input.businessId, fields), intentSha256 };
}

// ── customer.apply_credit ────────────────────────────────────────────────

export interface ApplyCreditIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the idempotency key and the accounting `source_id`. */
  readonly applicationId: string;
  readonly creditId: string;
  readonly invoiceId: string;
  /** `YYYY-MM-DD`, bound by the client. */
  readonly applicationDate: string;
  /** `c` > 0, in the credit's currency. */
  readonly consumedMinor: bigint;
  /** `a` > 0, in the invoice's currency. */
  readonly appliedMinor: bigint;
}

function applyIntentFields(input: ApplyCreditIntentInput): InventoryPayloadField[] {
  if (typeof input.consumedMinor !== 'bigint' || input.consumedMinor <= 0n) invalid('a consumed amount must be positive');
  if (typeof input.appliedMinor !== 'bigint' || input.appliedMinor <= 0n) invalid('an applied amount must be positive');
  return [
    uuid(input.applicationId, 'application_id'),
    uuid(input.creditId, 'credit_id'),
    uuid(input.invoiceId, 'invoice_id'),
    int(yyyymmdd(input.applicationDate)),
    int(input.consumedMinor),
    int(input.appliedMinor),
  ];
}

/** The application's intent digest: the value `customer_credit_applications.intent_sha256` stores. */
export function customerApplyCreditIntentSha256(input: ApplyCreditIntentInput): string {
  return inventoryIntentSha256(operationCode(CUSTOMER_APPLY_CREDIT_OP), input.tenantId, input.businessId, applyIntentFields(input));
}

export interface ApplyCreditPayloadInput extends ApplyCreditIntentInput {
  readonly creditCurrency: string;
  /** `rb`: the level, and the level-uniqueness key. */
  readonly creditRemainingBeforeMinor: bigint;
  /** `cr_rel = g(rb) − g(rb − c)`. */
  readonly creditCarryingReleasedMinor: bigint;
  /** `cr_rel − conv_Rn(c)`, signed. */
  readonly creditDustBaseMinor: bigint;
  readonly invoiceCurrency: string;
  /** `X = T − O`. */
  readonly arReleasedBeforeMinor: bigint;
  /** `rel`. */
  readonly carryingReleasedMinor: bigint;
  /** `rel − conv_R(a)`, signed. */
  readonly arDustBaseMinor: bigint;
  /** `cr_rel − rel`, signed. */
  readonly realizedFxMinor: bigint;
}

/**
 * `customer.apply_credit`: application_id, credit_id, invoice_id,
 * application_date, credit_currency, consumed, remaining_before,
 * credit_carrying_released, credit_dust, invoice_currency, applied,
 * ar_released_before, carrying_released, ar_dust, realized.
 *
 * Neither the credit's rate nor the invoice's is an argument, exactly as
 * `supplier_allocate_credit` takes neither (`supplier-credit-allocation.service
 * .ts`' 16 parameters): a stored snapshot is the routine's to read under its
 * own lock, and passing it would make it a figure the caller could state.
 */
export function customerApplyCreditPayload(input: ApplyCreditPayloadInput): { readonly payload: InventoryPayload; readonly intentSha256: string } {
  const intentSha256 = customerApplyCreditIntentSha256(input);
  if (input.realizedFxMinor !== input.creditCarryingReleasedMinor - input.carryingReleasedMinor) {
    invalid('realized must be credit_carrying_released - carrying_released');
  }
  if (input.creditCurrency.toUpperCase() === input.invoiceCurrency.toUpperCase() && input.consumedMinor !== input.appliedMinor) {
    invalid('a credit in the invoice currency applies exactly what it consumes');
  }
  if (input.consumedMinor > input.creditRemainingBeforeMinor) invalid('the consumed amount exceeds the remaining credit');
  const fields: InventoryPayloadField[] = [
    uuid(input.applicationId, 'application_id'),
    uuid(input.creditId, 'credit_id'),
    uuid(input.invoiceId, 'invoice_id'),
    int(yyyymmdd(input.applicationDate)),
    code(input.creditCurrency),
    int(input.consumedMinor),
    int(input.creditRemainingBeforeMinor),
    int(input.creditCarryingReleasedMinor),
    int(input.creditDustBaseMinor),
    code(input.invoiceCurrency),
    int(input.appliedMinor),
    int(input.arReleasedBeforeMinor),
    int(input.carryingReleasedMinor),
    int(input.arDustBaseMinor),
    int(input.realizedFxMinor),
  ];
  return { payload: buildInventoryPayload(operationCode(CUSTOMER_APPLY_CREDIT_OP), input.tenantId, input.businessId, fields), intentSha256 };
}
