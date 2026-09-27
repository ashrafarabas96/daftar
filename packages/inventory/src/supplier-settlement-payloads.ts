/**
 * `invpl/1` builders and intent digests of the three settlement kinds
 * (PHASE_3_S6_CONTRACT A-15, A-16; §2.6).
 *
 * Each builder takes the exact arguments the service passes to the entry
 * routine, in A-16 order: amounts as integer minor units of the currency
 * their row names (`*_dust` and `realized` in base, signed), currencies as
 * upper-case ISO codes bound as their lowercase `code`, a rate as its R10
 * with its source, registry id and epoch-second instant, dates as
 * `YYYYMMDD`, and the optional reference as the eight words of its SHA-256
 * (eight NULLs for none). A payment's allocations are in `line_no` order.
 *
 * The builders refuse a payload the routine could never accept — the shape
 * of §2.6 step 5 and the row CHECKs of §2.2 that the bound values alone decide
 * (`realized = base − released`, the same-currency equality, the header
 * totals) — so no assertion is minted for a command that cannot succeed; the
 * routine and its guards refuse all of it again.
 *
 * The intent (A-16) is the client-stated fields only; every FX snapshot,
 * base, release, dust and realized amount, a payment's posting account and
 * its allocations' warehouses are derived. So each `…IntentSha256` is
 * computable before any state is read (A-16 application order).
 */
import { InventoryError, type InventoryErrorCode } from './errors';
import { VALUE_LIMIT_MINOR } from './fixed-point';
import { yyyymmdd, type MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField } from './payload';
import { currencyCode, DOMESTIC_RATE_R10, type ReceiptRate } from './purchase-payloads';
import { documentTextWords } from './supplier-payloads';

/** Allocations per supplier payment (A-07). */
export const SUPPLIER_PAYMENT_MAX_ALLOCATIONS = 50;
/** A payment's or refund's reference, in characters after trimming (§2.2). */
export const SETTLEMENT_REFERENCE_MAX = 100;

function refuse(message: string, code: InventoryErrorCode = 'inventory.payload_invalid'): never {
  throw new InventoryError(code, message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const int = (value: bigint): InventoryPayloadField => ({ kind: 'integer', value });
const code = (currency: string): InventoryPayloadField => ({ kind: 'code', value: currencyCode(currency) });

function positive(v: unknown, what: string, onRefusal: InventoryErrorCode = 'inventory.payload_invalid'): bigint {
  if (typeof v !== 'bigint' || v <= 0n || v > VALUE_LIMIT_MINOR) refuse(`${what} must be a positive amount within range`, onRefusal);
  return v as bigint;
}

function nonNegative(v: unknown, what: string): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > VALUE_LIMIT_MINOR) refuse(`${what} must be a non-negative amount within range`);
  return v as bigint;
}

function signed(v: unknown, what: string): bigint {
  if (typeof v !== 'bigint' || v < -VALUE_LIMIT_MINOR || v > VALUE_LIMIT_MINOR) refuse(`${what} must be a signed amount within range`);
  return v as bigint;
}

/** A reference: already `normalizeDocumentText`-ed, 1..100 characters, or NULL (§2.6 step 5). */
function referenceWords(reference: string | null, onRefusal: InventoryErrorCode): InventoryPayloadField[] {
  let words: readonly (bigint | null)[];
  try {
    words = documentTextWords(reference, 'reference', { min: 1, max: SETTLEMENT_REFERENCE_MAX });
  } catch (e) {
    if (e instanceof InventoryError) refuse('a reference must be trimmed, 1..100 characters, or absent', onRefusal);
    throw e;
  }
  return words.map((w): InventoryPayloadField => (w === null ? { kind: 'null' } : int(w)));
}

/** The bound FX snapshot of a payment or a receipt (A-15): rate_id, rate, rate_source, rate_at. */
function rateFields(rate: ReceiptRate): InventoryPayloadField[] {
  if (typeof rate.rateR10 !== 'bigint' || typeof rate.rateAtEpochSeconds !== 'bigint') refuse('a rate and its instant must be integers');
  if (rate.source !== 'base' && rate.source !== 'manual') refuse('a rate source is base or manual');
  if (rate.source === 'base' ? rate.rateR10 !== DOMESTIC_RATE_R10 || rate.rateId !== null : rate.rateR10 <= 0n || rate.rateId === null) {
    refuse('a domestic rate is exactly 1 with no registry row; a foreign rate is positive with one');
  }
  return [
    rate.rateId === null ? { kind: 'null' } : uuid(rate.rateId, 'rate_id'),
    int(rate.rateR10),
    { kind: 'code', value: rate.source },
    int(rate.rateAtEpochSeconds),
  ];
}

// ── supplier.pay ─────────────────────────────────────────────────────────

export interface SupplierPayIntentAllocation {
  /** Client-supplied: the accounting `source_id` of its entry. */
  readonly allocationId: string;
  readonly purchaseId: string;
  /** `p` > 0, in the payment currency. */
  readonly paymentAmountMinor: bigint;
  /** `a` > 0, in the purchase currency. */
  readonly appliedMinor: bigint;
}

export interface SupplierPayIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the idempotency key (TL-10). */
  readonly paymentId: string;
  readonly supplierId: string;
  readonly paymentMethodId: string;
  /** `YYYY-MM-DD`, bound by the client (§0: no clock). */
  readonly paymentDate: string;
  /** The payment currency `P`, upper-case ISO. */
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly reference: string | null;
  /** In `line_no` order, 1..50. */
  readonly allocations: readonly SupplierPayIntentAllocation[];
}

function assertAllocations(allocations: readonly SupplierPayIntentAllocation[], amountMinor: bigint): void {
  const invalid = (message: string): never => refuse(message, 'supplier_payment.allocations_invalid');
  if (!Array.isArray(allocations) || allocations.length === 0 || allocations.length > SUPPLIER_PAYMENT_MAX_ALLOCATIONS) {
    invalid(`a payment has 1..${SUPPLIER_PAYMENT_MAX_ALLOCATIONS} allocations`);
  }
  if (
    new Set(allocations.map((a) => a.allocationId)).size !== allocations.length ||
    new Set(allocations.map((a) => a.purchaseId)).size !== allocations.length
  ) {
    invalid('a payment allocates once to each purchase, each allocation with its own id');
  }
  let total = 0n;
  for (const a of allocations) {
    total += positive(a.paymentAmountMinor, 'a payment amount', 'supplier_payment.allocations_invalid');
    positive(a.appliedMinor, 'an applied amount', 'supplier_payment.allocations_invalid');
  }
  if (total !== positive(amountMinor, 'the payment amount', 'supplier_payment.allocations_invalid')) invalid('a payment is fully allocated (TL-3)');
}

function payIntentFields(input: SupplierPayIntentInput): InventoryPayloadField[] {
  assertAllocations(input.allocations, input.amountMinor);
  const fields: InventoryPayloadField[] = [
    uuid(input.paymentId, 'payment_id'),
    uuid(input.supplierId, 'supplier_id'),
    uuid(input.paymentMethodId, 'payment_method_id'),
    int(yyyymmdd(input.paymentDate)),
    code(input.currency),
    int(input.amountMinor),
    ...referenceWords(input.reference, 'supplier_payment.allocations_invalid'),
    int(BigInt(input.allocations.length)),
  ];
  for (const a of input.allocations)
    fields.push(uuid(a.allocationId, 'allocation_id'), uuid(a.purchaseId, 'purchase_id'), int(a.paymentAmountMinor), int(a.appliedMinor));
  return fields;
}

/** The payment's intent digest (A-16): the value `supplier_payments.intent_sha256` stores, computable before any state is read. */
export function supplierPayIntentSha256(input: SupplierPayIntentInput): string {
  return inventoryIntentSha256('supplier.pay', input.tenantId, input.businessId, payIntentFields(input));
}

export interface SupplierPayPayloadAllocation extends SupplierPayIntentAllocation {
  /** The purchase's warehouse: a scope target (AL-39). */
  readonly warehouseId: string;
  /** The purchase currency `C`, upper-case ISO. */
  readonly purchaseCurrency: string;
  /** `pb = conv_Rp(p)`. */
  readonly paymentBaseMinor: bigint;
  /** `X = T − O`. */
  readonly releasedBeforeMinor: bigint;
  /** `rel`. */
  readonly carryingReleasedMinor: bigint;
  /** `rel − conv_R(a)`, signed. */
  readonly apDustBaseMinor: bigint;
  /** `pb − rel`, signed. */
  readonly realizedMinor: bigint;
}

export interface SupplierPayPayloadInput extends SupplierPayIntentInput {
  /** The method's posting account, as read (A-06). */
  readonly postingAccountId: string;
  /** The payment's FX snapshot at `payment_date` (A-15). */
  readonly rate: ReceiptRate;
  /** `Σ pb_i` (A-07), never `conv(Σ p_i)`. */
  readonly baseAmountMinor: bigint;
  readonly allocations: readonly SupplierPayPayloadAllocation[];
}

/**
 * `supplier.pay`: payment_id, supplier_id, payment_method_id,
 * posting_account_id, payment_date, currency, amount, rate_id, rate,
 * rate_source, rate_at, base_amount, reference_w1..w8, allocation_count, per
 * allocation (allocation_id, purchase_id, warehouse_id, purchase_currency,
 * payment_amount, payment_base, applied, released_before, carrying_released,
 * ap_dust, realized).
 */
export function supplierPayPayload(input: SupplierPayPayloadInput): MovementPayload {
  const intentSha256 = supplierPayIntentSha256(input);
  let baseTotal = 0n;
  for (const a of input.allocations) {
    const pb = positive(a.paymentBaseMinor, 'a payment base');
    const rel = nonNegative(a.carryingReleasedMinor, 'a carrying release');
    nonNegative(a.releasedBeforeMinor, 'an AP released before');
    signed(a.apDustBaseMinor, 'an AP dust');
    if (signed(a.realizedMinor, 'a realized amount') !== pb - rel) refuse('realized must be payment_base - carrying_released');
    if (currencyCode(a.purchaseCurrency) === currencyCode(input.currency) && a.paymentAmountMinor !== a.appliedMinor) {
      refuse('a payment in the purchase currency pays exactly what it applies', 'supplier_payment.amount_mismatch');
    }
    baseTotal += pb;
  }
  if (positive(input.baseAmountMinor, 'the payment base') !== baseTotal) refuse('the payment base must be the sum of the allocation bases');
  const fields: InventoryPayloadField[] = [
    uuid(input.paymentId, 'payment_id'),
    uuid(input.supplierId, 'supplier_id'),
    uuid(input.paymentMethodId, 'payment_method_id'),
    uuid(input.postingAccountId, 'posting_account_id'),
    int(yyyymmdd(input.paymentDate)),
    code(input.currency),
    int(input.amountMinor),
    ...rateFields(input.rate),
    int(input.baseAmountMinor),
    ...referenceWords(input.reference, 'supplier_payment.allocations_invalid'),
    int(BigInt(input.allocations.length)),
  ];
  for (const a of input.allocations) {
    fields.push(
      uuid(a.allocationId, 'allocation_id'),
      uuid(a.purchaseId, 'purchase_id'),
      uuid(a.warehouseId, 'warehouse_id'),
      code(a.purchaseCurrency),
      int(a.paymentAmountMinor),
      int(a.paymentBaseMinor),
      int(a.appliedMinor),
      int(a.releasedBeforeMinor),
      int(a.carryingReleasedMinor),
      int(a.apDustBaseMinor),
      int(a.realizedMinor),
    );
  }
  return { payload: buildInventoryPayload('supplier.pay', input.tenantId, input.businessId, fields), intentSha256 };
}

// ── supplier.allocate_credit ─────────────────────────────────────────────

export interface SupplierAllocateCreditIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the idempotency key and the accounting `source_id`. */
  readonly allocationId: string;
  readonly creditNoteId: string;
  /** The target purchase. */
  readonly purchaseId: string;
  /** `YYYY-MM-DD`, bound by the client. */
  readonly allocationDate: string;
  /** `c` > 0, in the note currency. */
  readonly consumedMinor: bigint;
  /** `a` > 0, in the purchase currency. */
  readonly appliedMinor: bigint;
}

function allocateIntentFields(input: SupplierAllocateCreditIntentInput): InventoryPayloadField[] {
  return [
    uuid(input.allocationId, 'allocation_id'),
    uuid(input.creditNoteId, 'credit_note_id'),
    uuid(input.purchaseId, 'purchase_id'),
    int(yyyymmdd(input.allocationDate)),
    int(positive(input.consumedMinor, 'the consumed amount')),
    int(positive(input.appliedMinor, 'the applied amount')),
  ];
}

/** The credit allocation's intent digest (A-16): `supplier_credit_allocations.intent_sha256`. */
export function supplierAllocateCreditIntentSha256(input: SupplierAllocateCreditIntentInput): string {
  return inventoryIntentSha256('supplier.allocate_credit', input.tenantId, input.businessId, allocateIntentFields(input));
}

export interface SupplierAllocateCreditPayloadInput extends SupplierAllocateCreditIntentInput {
  /** The target purchase's warehouse (the stated scope target; the command itself is business-wide, TL-5). */
  readonly warehouseId: string;
  /** The note currency, upper-case ISO. */
  readonly creditCurrency: string;
  /** `rb`. */
  readonly remainingBeforeMinor: bigint;
  /** `cr_rel`. */
  readonly creditReleasedMinor: bigint;
  /** `cr_rel − conv_Rn(c)`, signed. */
  readonly creditDustBaseMinor: bigint;
  /** The purchase currency, upper-case ISO. */
  readonly purchaseCurrency: string;
  /** `X`. */
  readonly apReleasedBeforeMinor: bigint;
  /** `rel`. */
  readonly apReleasedMinor: bigint;
  /** `rel − conv_R(a)`, signed. */
  readonly apDustBaseMinor: bigint;
  /** `cr_rel − rel`, signed. */
  readonly realizedMinor: bigint;
}

/**
 * `supplier.allocate_credit`: allocation_id, credit_note_id, purchase_id,
 * warehouse_id, allocation_date, credit_currency, consumed, remaining_before,
 * credit_released, credit_dust, purchase_currency, applied,
 * ap_released_before, ap_released, ap_dust, realized.
 */
export function supplierAllocateCreditPayload(input: SupplierAllocateCreditPayloadInput): MovementPayload {
  const intentSha256 = supplierAllocateCreditIntentSha256(input);
  if (positive(input.remainingBeforeMinor, 'the remaining credit') < input.consumedMinor) {
    refuse('the consumed amount exceeds the remaining credit', 'supplier_credit_allocation.amount_exceeds_credit');
  }
  const crRel = nonNegative(input.creditReleasedMinor, 'the credit release');
  const rel = nonNegative(input.apReleasedMinor, 'the AP release');
  nonNegative(input.apReleasedBeforeMinor, 'the AP released before');
  if (signed(input.realizedMinor, 'the realized amount') !== crRel - rel) refuse('realized must be credit_released - ap_released');
  if (currencyCode(input.creditCurrency) === currencyCode(input.purchaseCurrency) && input.consumedMinor !== input.appliedMinor) {
    refuse('a credit in the purchase currency applies exactly what it consumes', 'supplier_credit_allocation.amount_mismatch');
  }
  const fields: InventoryPayloadField[] = [
    uuid(input.allocationId, 'allocation_id'),
    uuid(input.creditNoteId, 'credit_note_id'),
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    int(yyyymmdd(input.allocationDate)),
    code(input.creditCurrency),
    int(input.consumedMinor),
    int(input.remainingBeforeMinor),
    int(crRel),
    int(signed(input.creditDustBaseMinor, 'the credit dust')),
    code(input.purchaseCurrency),
    int(input.appliedMinor),
    int(input.apReleasedBeforeMinor),
    int(rel),
    int(signed(input.apDustBaseMinor, 'the AP dust')),
    int(input.realizedMinor),
  ];
  return { payload: buildInventoryPayload('supplier.allocate_credit', input.tenantId, input.businessId, fields), intentSha256 };
}

// ── supplier.receive_refund ──────────────────────────────────────────────

export interface SupplierReceiveRefundIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the idempotency key and the accounting `source_id`. */
  readonly refundId: string;
  readonly creditNoteId: string;
  readonly paymentMethodId: string;
  /** `YYYY-MM-DD`, bound by the client. */
  readonly refundDate: string;
  /** `c` > 0, in the note currency. */
  readonly consumedMinor: bigint;
  /** The receipt currency, upper-case ISO. */
  readonly receiptCurrency: string;
  /** `m` > 0, in the receipt currency. */
  readonly receiptAmountMinor: bigint;
  readonly reference: string | null;
}

function refundIntentFields(input: SupplierReceiveRefundIntentInput): InventoryPayloadField[] {
  return [
    uuid(input.refundId, 'refund_id'),
    uuid(input.creditNoteId, 'credit_note_id'),
    uuid(input.paymentMethodId, 'payment_method_id'),
    int(yyyymmdd(input.refundDate)),
    int(positive(input.consumedMinor, 'the consumed amount')),
    code(input.receiptCurrency),
    int(positive(input.receiptAmountMinor, 'the receipt amount')),
    ...referenceWords(input.reference, 'inventory.payload_invalid'),
  ];
}

/** The refund's intent digest (A-16): `supplier_refunds.intent_sha256`. */
export function supplierReceiveRefundIntentSha256(input: SupplierReceiveRefundIntentInput): string {
  return inventoryIntentSha256('supplier.receive_refund', input.tenantId, input.businessId, refundIntentFields(input));
}

export interface SupplierReceiveRefundPayloadInput extends SupplierReceiveRefundIntentInput {
  /** The method's posting account, as read (A-06). */
  readonly postingAccountId: string;
  /** The note currency, upper-case ISO. */
  readonly sourceCurrency: string;
  /** `rb`. */
  readonly remainingBeforeMinor: bigint;
  /** `cr_rel`. */
  readonly sourceReleasedMinor: bigint;
  /** `cr_rel − conv_Rn(c)`, signed. */
  readonly sourceDustBaseMinor: bigint;
  /** The receipt's FX snapshot at `refund_date` (A-15). */
  readonly rate: ReceiptRate;
  /** `mb = conv_Rr(m)`. */
  readonly receiptBaseMinor: bigint;
  /** `mb − cr_rel`, signed. */
  readonly realizedMinor: bigint;
}

/**
 * `supplier.receive_refund`: refund_id, credit_note_id, payment_method_id,
 * posting_account_id, refund_date, source_currency, consumed,
 * remaining_before, source_released, source_dust, receipt_currency,
 * receipt_amount, rate_id, rate, rate_source, rate_at, receipt_base,
 * realized, reference_w1..w8.
 */
export function supplierReceiveRefundPayload(input: SupplierReceiveRefundPayloadInput): MovementPayload {
  const intentSha256 = supplierReceiveRefundIntentSha256(input);
  if (positive(input.remainingBeforeMinor, 'the remaining credit') < input.consumedMinor) {
    refuse('the consumed amount exceeds the remaining credit', 'supplier_refund.amount_exceeds_credit');
  }
  const crRel = nonNegative(input.sourceReleasedMinor, 'the credit release');
  const mb = positive(input.receiptBaseMinor, 'the receipt base');
  if (signed(input.realizedMinor, 'the realized amount') !== mb - crRel) refuse('realized must be receipt_base - source_released');
  if (currencyCode(input.sourceCurrency) === currencyCode(input.receiptCurrency) && input.consumedMinor !== input.receiptAmountMinor) {
    refuse('a refund in the note currency receives exactly what it consumes', 'supplier_refund.amount_mismatch');
  }
  const fields: InventoryPayloadField[] = [
    uuid(input.refundId, 'refund_id'),
    uuid(input.creditNoteId, 'credit_note_id'),
    uuid(input.paymentMethodId, 'payment_method_id'),
    uuid(input.postingAccountId, 'posting_account_id'),
    int(yyyymmdd(input.refundDate)),
    code(input.sourceCurrency),
    int(input.consumedMinor),
    int(input.remainingBeforeMinor),
    int(crRel),
    int(signed(input.sourceDustBaseMinor, 'the credit dust')),
    code(input.receiptCurrency),
    int(input.receiptAmountMinor),
    ...rateFields(input.rate),
    int(mb),
    int(input.realizedMinor),
    ...referenceWords(input.reference, 'inventory.payload_invalid'),
  ];
  return { payload: buildInventoryPayload('supplier.receive_refund', input.tenantId, input.businessId, fields), intentSha256 };
}
