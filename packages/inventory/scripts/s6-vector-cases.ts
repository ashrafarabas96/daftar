/**
 * The shared P3-S6 vectors, as pure functions (PHASE_3_S6_CONTRACT §4.1).
 *
 * `scripts/generate-s6-vectors.ts` writes:
 *
 * - `vectors/invpl-s6-vectors.json` — the `invpl/1` payload AND intent
 *   streams of the seven P3-S6 kinds, built by `src/payment-method-payloads.ts`
 *   and `src/supplier-settlement-payloads.ts`, with the exact entry-routine
 *   arguments that rebuild each stream in SQL (a NULL `rate_id`, a NULL
 *   reference and a negative `realized` included);
 * - `vectors/supplier-settlement-vectors.json` — A-05, A-08 – A-10 end to end
 *   by `src/supplier-settlement.ts`: purchases and credit notes, then a
 *   sequence of settlements, each starting from what the previous accepted
 *   one stored, with every primitive call (`supplier_convert_base`,
 *   `supplier_ap_release`, `supplier_credit_remaining_carrying`) the steps
 *   made, so T-07 can hold the SQL functions to the same numbers.
 *
 * Every number in the files is COMPUTED by the package; nothing is copied by
 * hand. Where the contract or GOLD states a number (GOLD-84's 216 / 144 /
 * 144, GOLD-73's 369 = 360 + 9) or a case exists to show a property (exact
 * clearing, a dust line of each sign, the MIN1 floor, a stable refusal), the
 * generator holds the computation to that LITERAL and refuses to write a file
 * in which they disagree.
 *
 * Every integer is decimal TEXT, because a value may exceed 2^53.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { InventoryError } from '../src/errors';
import { formatMinor } from '../src/fixed-point';
import type { MovementPayload } from '../src/movement-payloads';
import { INVENTORY_PAYLOAD_SCHEMAS, inventoryIntentSchema, type InventoryPayloadFieldSpec, type InventoryS6OperationCode } from '../src/payload';
import {
  paymentMethodActivatePayload,
  paymentMethodCreatePayload,
  paymentMethodDeactivatePayload,
  paymentMethodUpdatePayload,
  type PaymentMethodCreatePayloadInput,
  type PaymentMethodLifecyclePayloadInput,
  type PaymentMethodUpdatePayloadInput,
} from '../src/payment-method-payloads';
import {
  apRelease,
  convertToBase,
  creditRemainingCarrying,
  planCreditAllocation,
  planPaymentAllocation,
  planRefund,
  type CreditNoteState,
  type PurchaseApState,
  type SettlementConversion,
  type SettlementEntryLine,
} from '../src/supplier-settlement';
import {
  supplierAllocateCreditPayload,
  supplierPayPayload,
  supplierReceiveRefundPayload,
  type SupplierAllocateCreditPayloadInput,
  type SupplierPayPayloadInput,
  type SupplierReceiveRefundPayloadInput,
} from '../src/supplier-settlement-payloads';

// ── Common helpers ───────────────────────────────────────────────────────

function jsonable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonable(v)]));
  return value;
}

async function renderJson(value: unknown, file: string): Promise<string> {
  const options = (await resolveConfig(join(__dirname, '..', 'vectors', file))) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, parser: 'json' });
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`vector spec disagreement: ${message}`);
}

/** The code a refusal carries, or 'accepted'. */
function attempt<R>(fn: () => R): { readonly outcome: string; readonly value: R | null } {
  try {
    return { outcome: 'accepted', value: fn() };
  } catch (e) {
    if (e instanceof InventoryError) return { outcome: e.code, value: null };
    throw e;
  }
}

/** R10 of a ten-decimal rate text, exactly. */
function r10(rate: string): bigint {
  const m = /^(\d+)\.(\d{10})$/.exec(rate);
  if (m === null) throw new Error(`a vector rate must have ten fraction digits: ${rate}`);
  return BigInt(`${m[1] ?? ''}${m[2] ?? ''}`);
}

// ── Identifiers (fixed test material) ────────────────────────────────────

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const tb = { tenantId: T, businessId: B };
const PM = 'a1b2c3d4-0006-4a00-8a00-000000000061';
const ACC = 'a1b2c3d4-0006-4a00-8a00-000000000062';
const SUP = 'a1b2c3d4-0006-4a00-8a00-000000000063';
const PAY = 'a1b2c3d4-0006-4a00-8a00-000000000064';
const CN = 'a1b2c3d4-0006-4a00-8a00-000000000065';
const CAL = 'a1b2c3d4-0006-4a00-8a00-000000000066';
const REF = 'a1b2c3d4-0006-4a00-8a00-000000000067';
const RATE = 'a1b2c3d4-0006-4a00-8a00-000000000068';
const P1 = 'a1b2c3d4-0006-4a00-8a00-000000000071';
const P2 = 'a1b2c3d4-0006-4a00-8a00-000000000072';
const A1 = 'a1b2c3d4-0006-4a00-8a00-000000000081';
const A2 = 'a1b2c3d4-0006-4a00-8a00-000000000082';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';

// ── invpl/1 P3-S6 ────────────────────────────────────────────────────────

export interface S6VectorField {
  readonly name: string;
  readonly type: InventoryPayloadFieldSpec['type'];
  readonly value: string | null;
}

export interface S6StreamVector {
  readonly fields: readonly S6VectorField[];
  readonly canonicalHex: string;
  readonly sha256: string;
}

export interface S6PayloadVector {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS6OperationCode;
  readonly tenantId: string;
  readonly businessId: string;
  /** The entry routine and the exact arguments (as SQL literals' text; arrays as JSON arrays; NULL as null) from which it rebuilds `payload`. */
  readonly routine: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
  readonly payload: S6StreamVector;
  readonly intent: S6StreamVector;
}

export interface InvplS6Vectors {
  readonly spec: string;
  readonly note: string;
  readonly cases: readonly S6PayloadVector[];
}

/** The field values of a canonical stream: every line after the fourth, LF-split, `00` as NULL. */
function streamValues(bytes: Buffer): (string | null)[] {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('a stream must end with LF');
  return text
    .slice(0, -1)
    .split('\n')
    .slice(4)
    .map((l) => (l === '\u0000' ? null : l));
}

/** Names and types of every field of a stream, walking header and group by the count actually encoded. */
function expand(opCode: InventoryS6OperationCode, values: readonly (string | null)[]): S6VectorField[] {
  const schema = INVENTORY_PAYLOAD_SCHEMAS[opCode];
  const specs: InventoryPayloadFieldSpec[] = [...schema];
  const repeat = schema.repeat;
  if (schema.trailer !== undefined) throw new Error(`${opCode}: a P3-S6 schema has no trailer`);
  if (repeat !== undefined) {
    const count = Number(values[schema.findIndex((s) => s.name === repeat.countField)]);
    for (let i = 0; i < count; i += 1) specs.push(...repeat.fields);
  }
  if (specs.length !== values.length) throw new Error(`${opCode}: the stream does not have the schema's length`);
  return values.map((value, i) => {
    const s = specs[i];
    if (s === undefined) throw new Error('unreachable');
    return { name: s.name, type: s.type, value };
  });
}

/** The intent fields of a payload: the header fields the intent schema keeps, then its group fields per row (by position). */
function intentOf(opCode: InventoryS6OperationCode, fields: readonly S6VectorField[]): S6VectorField[] {
  const schema = INVENTORY_PAYLOAD_SCHEMAS[opCode];
  const intent = inventoryIntentSchema(opCode);
  const header = new Set(intent.map((s) => s.name));
  const groupKeep = new Set((intent.repeat?.fields ?? []).map((s) => s.name));
  return fields.filter((f, i) => (i < schema.length ? header.has(f.name) : groupKeep.has(f.name)));
}

type RoutineArgs = Readonly<Record<string, unknown>>;

interface RawPayloadCase {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS6OperationCode;
  readonly routine: string;
  readonly args: RoutineArgs;
  readonly build: () => MovementPayload;
}

const rateText = (rateR10: bigint): string => `${rateR10 / 10n ** 10n}.${(rateR10 % 10n ** 10n).toString().padStart(10, '0')}`;
const instantText = (epoch: bigint): string => `${new Date(Number(epoch) * 1000).toISOString().slice(0, 19)}Z`;

function createArgs(i: PaymentMethodCreatePayloadInput): RoutineArgs {
  return {
    p_payment_method_id: i.paymentMethodId,
    p_system_type: i.systemType,
    p_posting_account_id: i.postingAccountId,
    p_requires_reference: i.requiresReference,
    p_sort_order: String(i.sortOrder),
    p_name_ar: i.names.ar,
    p_name_en: i.names.en,
    p_name_tr: i.names.tr,
  };
}

function updateArgs(i: PaymentMethodUpdatePayloadInput): RoutineArgs {
  return {
    p_payment_method_id: i.paymentMethodId,
    p_expected_revision: String(i.expectedRevision),
    p_posting_account_id: i.postingAccountId,
    p_requires_reference: i.requiresReference,
    p_sort_order: String(i.sortOrder),
    p_name_ar: i.names.ar,
    p_name_en: i.names.en,
    p_name_tr: i.names.tr,
  };
}

function lifecycleArgs(i: PaymentMethodLifecyclePayloadInput): RoutineArgs {
  return { p_payment_method_id: i.paymentMethodId, p_expected_revision: String(i.expectedRevision) };
}

function payArgs(i: SupplierPayPayloadInput): RoutineArgs {
  return {
    p_payment_id: i.paymentId,
    p_supplier_id: i.supplierId,
    p_payment_method_id: i.paymentMethodId,
    p_posting_account_id: i.postingAccountId,
    p_payment_date: i.paymentDate,
    p_currency_code: i.currency,
    p_amount_minor: formatMinor(i.amountMinor),
    p_rate_id: i.rate.rateId,
    p_rate: rateText(i.rate.rateR10),
    p_rate_source: i.rate.source,
    p_rate_at: instantText(i.rate.rateAtEpochSeconds),
    p_base_amount_minor: formatMinor(i.baseAmountMinor),
    p_reference: i.reference,
    p_allocation_ids: i.allocations.map((a) => a.allocationId),
    p_purchase_ids: i.allocations.map((a) => a.purchaseId),
    p_warehouse_ids: i.allocations.map((a) => a.warehouseId),
    p_purchase_currencies: i.allocations.map((a) => a.purchaseCurrency),
    p_payment_amounts: i.allocations.map((a) => formatMinor(a.paymentAmountMinor)),
    p_payment_bases: i.allocations.map((a) => formatMinor(a.paymentBaseMinor)),
    p_applied: i.allocations.map((a) => formatMinor(a.appliedMinor)),
    p_released_before: i.allocations.map((a) => formatMinor(a.releasedBeforeMinor)),
    p_carrying_released: i.allocations.map((a) => formatMinor(a.carryingReleasedMinor)),
    p_ap_dusts: i.allocations.map((a) => formatMinor(a.apDustBaseMinor)),
    p_realized: i.allocations.map((a) => formatMinor(a.realizedMinor)),
  };
}

function allocateArgs(i: SupplierAllocateCreditPayloadInput): RoutineArgs {
  return {
    p_allocation_id: i.allocationId,
    p_credit_note_id: i.creditNoteId,
    p_purchase_id: i.purchaseId,
    p_warehouse_id: i.warehouseId,
    p_allocation_date: i.allocationDate,
    p_credit_currency: i.creditCurrency,
    p_consumed_minor: formatMinor(i.consumedMinor),
    p_remaining_before_minor: formatMinor(i.remainingBeforeMinor),
    p_credit_released_minor: formatMinor(i.creditReleasedMinor),
    p_credit_dust_minor: formatMinor(i.creditDustBaseMinor),
    p_purchase_currency: i.purchaseCurrency,
    p_applied_minor: formatMinor(i.appliedMinor),
    p_ap_released_before_minor: formatMinor(i.apReleasedBeforeMinor),
    p_ap_released_minor: formatMinor(i.apReleasedMinor),
    p_ap_dust_minor: formatMinor(i.apDustBaseMinor),
    p_realized_minor: formatMinor(i.realizedMinor),
  };
}

function refundArgs(i: SupplierReceiveRefundPayloadInput): RoutineArgs {
  return {
    p_refund_id: i.refundId,
    p_credit_note_id: i.creditNoteId,
    p_payment_method_id: i.paymentMethodId,
    p_posting_account_id: i.postingAccountId,
    p_refund_date: i.refundDate,
    p_source_currency: i.sourceCurrency,
    p_consumed_minor: formatMinor(i.consumedMinor),
    p_remaining_before_minor: formatMinor(i.remainingBeforeMinor),
    p_source_released_minor: formatMinor(i.sourceReleasedMinor),
    p_source_dust_minor: formatMinor(i.sourceDustBaseMinor),
    p_receipt_currency: i.receiptCurrency,
    p_receipt_amount_minor: formatMinor(i.receiptAmountMinor),
    p_rate_id: i.rate.rateId,
    p_rate: rateText(i.rate.rateR10),
    p_rate_source: i.rate.source,
    p_rate_at: instantText(i.rate.rateAtEpochSeconds),
    p_receipt_base_minor: formatMinor(i.receiptBaseMinor),
    p_realized_minor: formatMinor(i.realizedMinor),
    p_reference: i.reference,
  };
}

const METHOD_CREATE: PaymentMethodCreatePayloadInput = {
  ...tb,
  paymentMethodId: PM,
  systemType: 'bank_transfer',
  postingAccountId: ACC,
  requiresReference: true,
  sortOrder: 10,
  names: { ar: 'تحويل بنكي', en: 'Bank transfer', tr: null },
};

const METHOD_UPDATE: PaymentMethodUpdatePayloadInput = {
  ...tb,
  paymentMethodId: PM,
  expectedRevision: 1,
  postingAccountId: ACC,
  requiresReference: false,
  sortOrder: 0,
  names: { ar: 'تحويل بنكي — الحساب الثاني', en: 'Bank transfer (second account)', tr: 'Banka havalesi' },
};

const METHOD_LIFECYCLE: PaymentMethodLifecyclePayloadInput = { ...tb, paymentMethodId: PM, expectedRevision: 2 };

/**
 * A USD payment @ 3.70 of two USD purchases @ 3.60 and 3.65: each
 * allocation's realized FX a loss (positive); the reference absent.
 */
function payForeign(): SupplierPayPayloadInput {
  const payment: SettlementConversion = { rateR10: r10('3.7000000000'), txnExponent: 2, baseExponent: 2 };
  const a1 = planPaymentAllocation({
    purchase: {
      totalTxnMinor: 10000n,
      totalBaseMinor: 36000n,
      outstandingTxnMinor: 10000n,
      conversion: { rateR10: r10('3.6000000000'), txnExponent: 2, baseExponent: 2 },
    },
    sameCurrency: true,
    paymentAmountMinor: 4000n,
    payment,
    appliedMinor: 4000n,
  });
  const a2 = planPaymentAllocation({
    purchase: {
      totalTxnMinor: 100n,
      totalBaseMinor: 365n,
      outstandingTxnMinor: 67n,
      conversion: { rateR10: r10('3.6500000000'), txnExponent: 2, baseExponent: 2 },
    },
    sameCurrency: true,
    paymentAmountMinor: 33n,
    payment,
    appliedMinor: 33n,
  });
  return {
    ...tb,
    paymentId: PAY,
    supplierId: SUP,
    paymentMethodId: PM,
    postingAccountId: ACC,
    paymentDate: '2026-09-27',
    currency: 'USD',
    amountMinor: 4033n,
    reference: null,
    rate: { rateId: RATE, rateR10: payment.rateR10, source: 'manual', rateAtEpochSeconds: 1790000000n },
    baseAmountMinor: a1.paymentBaseMinor + a2.paymentBaseMinor,
    allocations: [
      { allocationId: A1, purchaseId: P1, warehouseId: W1, purchaseCurrency: 'USD', ...alloc(a1) },
      { allocationId: A2, purchaseId: P2, warehouseId: W2, purchaseCurrency: 'USD', ...alloc(a2) },
    ],
  };
}

function alloc(a: ReturnType<typeof planPaymentAllocation>) {
  return {
    paymentAmountMinor: a.paymentAmountMinor,
    paymentBaseMinor: a.paymentBaseMinor,
    appliedMinor: a.appliedMinor,
    releasedBeforeMinor: a.releasedBeforeMinor,
    carryingReleasedMinor: a.carryingReleasedMinor,
    apDustBaseMinor: a.apDustBaseMinor,
    realizedMinor: a.realizedMinor,
  };
}

/** A domestic ILS payment of a USD purchase @ 3.65: a NULL `rate_id`, a cross-currency pair of amounts, a negative realized (a gain). */
function payDomestic(): SupplierPayPayloadInput {
  const a = planPaymentAllocation({
    purchase: {
      totalTxnMinor: 10000n,
      totalBaseMinor: 36500n,
      outstandingTxnMinor: 10000n,
      conversion: { rateR10: r10('3.6500000000'), txnExponent: 2, baseExponent: 2 },
    },
    sameCurrency: false,
    paymentAmountMinor: 18000n,
    payment: { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 },
    appliedMinor: 5000n,
  });
  check(a.realizedMinor === -250n, 'S6-PAY-02 pays 180.00 ILS for 50.00 USD carried at 182.50: a gain of 2.50');
  return {
    ...tb,
    paymentId: PAY,
    supplierId: SUP,
    paymentMethodId: PM,
    postingAccountId: ACC,
    paymentDate: '2026-09-27',
    currency: 'ILS',
    amountMinor: 18000n,
    reference: 'TRX-2026/0927 · حوالة',
    rate: { rateId: null, rateR10: 10n ** 10n, source: 'base', rateAtEpochSeconds: 1790467200n },
    baseAmountMinor: a.paymentBaseMinor,
    allocations: [{ allocationId: A1, purchaseId: P1, warehouseId: W1, purchaseCurrency: 'USD', ...alloc(a) }],
  };
}

const NOTE_USD: CreditNoteState = {
  originalMinor: 10000n,
  originalCarryingMinor: 36000n,
  remainingMinor: 10000n,
  conversion: { rateR10: r10('3.6000000000'), txnExponent: 2, baseExponent: 2 },
};

/** GOLD-61's shape in foreign money: a USD credit @ 3.60 applied to a USD purchase @ 3.70 — realized negative (a gain). */
function allocateForeign(): SupplierAllocateCreditPayloadInput {
  const plan = planCreditAllocation({
    purchase: {
      totalTxnMinor: 8000n,
      totalBaseMinor: 29600n,
      outstandingTxnMinor: 8000n,
      conversion: { rateR10: r10('3.7000000000'), txnExponent: 2, baseExponent: 2 },
    },
    note: NOTE_USD,
    sameCurrency: true,
    consumedMinor: 5000n,
    appliedMinor: 5000n,
  });
  check(plan.realizedMinor === -500n, 'S6-ALC-01: 50.00 USD carried at 180.00 extinguishes AP carried at 185.00: a gain of 5.00');
  return {
    ...tb,
    allocationId: CAL,
    creditNoteId: CN,
    purchaseId: P2,
    warehouseId: W2,
    allocationDate: '2026-09-28',
    creditCurrency: 'USD',
    consumedMinor: plan.consumedMinor,
    remainingBeforeMinor: plan.remainingBeforeMinor,
    creditReleasedMinor: plan.creditReleasedMinor,
    creditDustBaseMinor: plan.creditDustBaseMinor,
    purchaseCurrency: 'USD',
    appliedMinor: plan.appliedMinor,
    apReleasedBeforeMinor: plan.releasedBeforeMinor,
    apReleasedMinor: plan.carryingReleasedMinor,
    apDustBaseMinor: plan.apDustBaseMinor,
    realizedMinor: plan.realizedMinor,
  };
}

/** GOLD-73: CN 100 USD carried at 360, received as 90 EUR @ 4.10 into a domestic bank method: a gain of 9. */
function refundEur(): SupplierReceiveRefundPayloadInput {
  const plan = planRefund({
    note: NOTE_USD,
    sameCurrency: false,
    consumedMinor: 10000n,
    receiptAmountMinor: 9000n,
    receipt: { rateR10: r10('4.1000000000'), txnExponent: 2, baseExponent: 2 },
  });
  return {
    ...tb,
    refundId: REF,
    creditNoteId: CN,
    paymentMethodId: PM,
    postingAccountId: ACC,
    refundDate: '2026-09-29',
    sourceCurrency: 'USD',
    consumedMinor: plan.consumedMinor,
    remainingBeforeMinor: plan.remainingBeforeMinor,
    sourceReleasedMinor: plan.creditReleasedMinor,
    sourceDustBaseMinor: plan.creditDustBaseMinor,
    receiptCurrency: 'EUR',
    receiptAmountMinor: plan.receiptAmountMinor,
    rate: { rateId: RATE, rateR10: r10('4.1000000000'), source: 'manual', rateAtEpochSeconds: 1790640000n },
    receiptBaseMinor: plan.receiptBaseMinor,
    realizedMinor: plan.realizedMinor,
    reference: 'Refund 0929',
  };
}

/** A domestic refund in the note's own currency (ILS): a NULL `rate_id`, `m = c`, no FX, no reference. */
function refundDomestic(): SupplierReceiveRefundPayloadInput {
  const plan = planRefund({
    note: {
      originalMinor: 50000n,
      originalCarryingMinor: 50000n,
      remainingMinor: 20000n,
      conversion: { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 },
    },
    sameCurrency: true,
    consumedMinor: 20000n,
    receiptAmountMinor: 20000n,
    receipt: { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 },
  });
  return {
    ...tb,
    refundId: REF,
    creditNoteId: CN,
    paymentMethodId: PM,
    postingAccountId: ACC,
    refundDate: '2026-09-29',
    sourceCurrency: 'ILS',
    consumedMinor: plan.consumedMinor,
    remainingBeforeMinor: plan.remainingBeforeMinor,
    sourceReleasedMinor: plan.creditReleasedMinor,
    sourceDustBaseMinor: plan.creditDustBaseMinor,
    receiptCurrency: 'ILS',
    receiptAmountMinor: plan.receiptAmountMinor,
    rate: { rateId: null, rateR10: 10n ** 10n, source: 'base', rateAtEpochSeconds: 1790640000n },
    receiptBaseMinor: plan.receiptBaseMinor,
    realizedMinor: plan.realizedMinor,
    reference: null,
  };
}

const rawPayloadCases: readonly RawPayloadCase[] = [
  {
    id: 'S6-PMC-01',
    why: 'a bank-transfer method requiring a reference: Arabic and English names, the Turkish name NULL (eight NULL words)',
    opCode: 'payment.create_method',
    routine: 'payment_method_create',
    args: createArgs(METHOD_CREATE),
    build: () => paymentMethodCreatePayload(METHOD_CREATE),
  },
  {
    id: 'S6-PMU-01',
    why: 'the update of revision 1: every name stated, the reference no longer required, sort order 0',
    opCode: 'payment.update_method',
    routine: 'payment_method_update',
    args: updateArgs(METHOD_UPDATE),
    build: () => paymentMethodUpdatePayload(METHOD_UPDATE),
  },
  {
    id: 'S6-PMD-01',
    why: 'deactivate at revision 2',
    opCode: 'payment.deactivate_method',
    routine: 'payment_method_deactivate',
    args: lifecycleArgs(METHOD_LIFECYCLE),
    build: () => paymentMethodDeactivatePayload(METHOD_LIFECYCLE),
  },
  {
    id: 'S6-PMA-01',
    why: 'activate at revision 2: the same fields as deactivate; only the op code line differs',
    opCode: 'payment.activate_method',
    routine: 'payment_method_activate',
    args: lifecycleArgs(METHOD_LIFECYCLE),
    build: () => paymentMethodActivatePayload(METHOD_LIFECYCLE),
  },
  {
    id: 'S6-PAY-01',
    why: 'a USD payment @ 3.70 of two USD purchases: a registry rate id, no reference, two allocations, a positive realized (loss) on each and a +1 AP dust on the second',
    opCode: 'supplier.pay',
    routine: 'supplier_pay',
    args: payArgs(payForeign()),
    build: () => supplierPayPayload(payForeign()),
  },
  {
    id: 'S6-PAY-02',
    why: 'a domestic ILS payment of a USD purchase: a NULL rate_id, a stated reference, cross-currency amounts, a negative realized (gain)',
    opCode: 'supplier.pay',
    routine: 'supplier_pay',
    args: payArgs(payDomestic()),
    build: () => supplierPayPayload(payDomestic()),
  },
  {
    id: 'S6-ALC-01',
    why: 'a USD credit carried @ 3.60 applied to a USD purchase @ 3.70: a partial consumption, a negative realized (gain)',
    opCode: 'supplier.allocate_credit',
    routine: 'supplier_allocate_credit',
    args: allocateArgs(allocateForeign()),
    build: () => supplierAllocateCreditPayload(allocateForeign()),
  },
  {
    id: 'S6-REF-01',
    why: 'GOLD-73: the whole USD note received as 90 EUR @ 4.10: a registry rate id, a reference, a positive realized (gain 9.00)',
    opCode: 'supplier.receive_refund',
    routine: 'supplier_receive_refund',
    args: refundArgs(refundEur()),
    build: () => supplierReceiveRefundPayload(refundEur()),
  },
  {
    id: 'S6-REF-02',
    why: 'a domestic refund of the last 200.00 ILS of a note: a NULL rate_id, no reference (eight NULL words), realized 0',
    opCode: 'supplier.receive_refund',
    routine: 'supplier_receive_refund',
    args: refundArgs(refundDomestic()),
    build: () => supplierReceiveRefundPayload(refundDomestic()),
  },
];

function buildPayloadCase(c: RawPayloadCase): S6PayloadVector {
  const built = c.build();
  check(built.payload.opCode === c.opCode, `${c.id} built the wrong operation`);
  const payloadFields = expand(c.opCode, streamValues(built.payload.bytes));
  const intentFields = intentOf(c.opCode, payloadFields);
  const intentBytes = Buffer.from(['invpl/1', c.opCode, T, B, ...intentFields.map((f) => f.value ?? '\u0000')].map((l) => `${l}\n`).join(''), 'utf8');
  const intentSha = createHash('sha256').update(intentBytes).digest('hex');
  check(intentSha === built.intentSha256, `${c.id}: the builder's intent digest disagrees with the spec`);
  if (c.opCode.startsWith('payment.')) check(intentSha === built.payload.sha256, `${c.id}: a payment-method intent is its payload`);
  return {
    id: c.id,
    why: c.why,
    opCode: c.opCode,
    tenantId: T,
    businessId: B,
    routine: { name: c.routine, args: jsonable(c.args) as RoutineArgs },
    payload: { fields: payloadFields, canonicalHex: built.payload.bytes.toString('hex'), sha256: built.payload.sha256 },
    intent: { fields: intentFields, canonicalHex: intentBytes.toString('hex'), sha256: intentSha },
  };
}

export function buildInvplS6Vectors(): InvplS6Vectors {
  const cases = rawPayloadCases.map(buildPayloadCase);
  const ops = new Set(cases.map((c) => c.opCode));
  check(ops.size === 7, 'every P3-S6 kind has a vector');
  check(
    cases.some((c) => c.payload.fields.some((f) => f.name === 'rate_id' && f.value === null)),
    'a NULL rate_id is covered',
  );
  check(
    cases.some((c) => c.payload.fields.some((f) => f.name === 'reference_w1' && f.value === null)),
    'a NULL reference is covered',
  );
  check(
    cases.some((c) => c.payload.fields.some((f) => f.name === 'realized' && (f.value ?? '').startsWith('-'))),
    'a negative realized is covered',
  );
  return {
    spec: 'invpl/1 for the seven P3-S6 operation kinds (PHASE_3_S6_CONTRACT A-16)',
    note: 'Generated by packages/inventory/scripts/generate-s6-vectors.ts and verified by packages/inventory/test/payment-method-payloads.test.ts and test/supplier-settlement-payloads.test.ts. payload is the stream the invctl/1 assertion signs; intent is the stream whose digest the document stores (a payment-method kind: the payload itself; supplier.pay: payment_id, supplier_id, payment_method_id, payment_date, currency, amount, reference_w1..w8, allocation_count and per allocation allocation_id, purchase_id, payment_amount, applied; supplier.allocate_credit: allocation_id, credit_note_id, purchase_id, allocation_date, consumed, applied; supplier.receive_refund: refund_id, credit_note_id, payment_method_id, refund_date, consumed, receipt_currency, receipt_amount, reference_w1..w8). Field values are canonical invpl/1 text or JSON null for SQL NULL: amounts in minor units of the currency their row names, *_dust and realized in base minor units and signed; currencies lowercase ISO; rate = rate x 10^10; rate_at epoch seconds; dates YYYYMMDD; *_w1..w8 the SHA-256 of the trimmed text as eight uint32 big-endian words (eight NULLs for NULL). routine.args are the entry routine arguments that rebuild the same payload.',
    cases,
  };
}

export function renderInvplS6Vectors(): Promise<string> {
  return renderJson(buildInvplS6Vectors(), 'invpl-s6-vectors.json');
}

// ── Supplier-settlement arithmetic ───────────────────────────────────────

interface CurrencySpec {
  readonly code: string;
  readonly exponent: number;
}

interface PurchaseSpec {
  readonly currency: CurrencySpec;
  /** Ten-decimal text. */
  readonly rate: string;
  readonly totalTxnMinor: bigint;
}

interface NoteSpec {
  readonly currency: CurrencySpec;
  readonly rate: string;
  readonly originalMinor: bigint;
}

type StepSpec =
  | {
      readonly kind: 'payment';
      readonly purchase: string;
      readonly currency: CurrencySpec;
      readonly rate: string;
      readonly paymentAmountMinor: bigint;
      readonly appliedMinor: bigint;
    }
  | { readonly kind: 'credit_allocation'; readonly purchase: string; readonly note: string; readonly consumedMinor: bigint; readonly appliedMinor: bigint }
  | {
      readonly kind: 'refund';
      readonly note: string;
      readonly currency: CurrencySpec;
      readonly rate: string;
      readonly consumedMinor: bigint;
      readonly receiptAmountMinor: bigint;
    };

interface CaseSpec {
  readonly id: string;
  readonly why: string;
  readonly base: CurrencySpec;
  readonly purchases: Readonly<Record<string, PurchaseSpec>>;
  readonly notes: Readonly<Record<string, NoteSpec>>;
  readonly steps: readonly StepSpec[];
  /** Literals the computation must reproduce, checked after the case runs. */
  readonly expect: (r: CaseResult) => void;
}

/** One primitive call a step made, as the SQL function takes it (T-07 runs each one). */
export interface PrimitiveCall {
  readonly fn: 'supplier_convert_base' | 'supplier_ap_release' | 'supplier_credit_remaining_carrying';
  readonly args: readonly (string | number)[];
  readonly result: string;
}

export interface StepResult {
  readonly step: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly plan: Readonly<Record<string, unknown>> | null;
  readonly entry: readonly SettlementEntryLine[] | null;
  readonly primitives: readonly PrimitiveCall[];
  readonly after: Readonly<Record<string, unknown>>;
}

interface CaseResult {
  readonly steps: readonly StepResult[];
  readonly purchases: ReadonlyMap<string, { outstanding: bigint; releasedBase: bigint; totalBase: bigint }>;
  readonly notes: ReadonlyMap<string, { remaining: bigint; remainingCarrying: bigint; original: bigint; originalCarrying: bigint }>;
}

export interface SettlementVectorCase {
  readonly id: string;
  readonly why: string;
  readonly base: CurrencySpec;
  readonly purchases: Readonly<Record<string, unknown>>;
  readonly notes: Readonly<Record<string, unknown>>;
  readonly steps: readonly StepResult[];
}

export interface SupplierSettlementVectors {
  readonly version: string;
  readonly note: string;
  readonly cases: readonly SettlementVectorCase[];
}

const ILS: CurrencySpec = { code: 'ILS', exponent: 2 };
const USD: CurrencySpec = { code: 'USD', exponent: 2 };
const EUR: CurrencySpec = { code: 'EUR', exponent: 2 };
const JOD: CurrencySpec = { code: 'JOD', exponent: 3 };
const LBP: CurrencySpec = { code: 'LBP', exponent: 2 };

function conversionOf(currency: CurrencySpec, rate: string, base: CurrencySpec): SettlementConversion {
  return { rateR10: r10(rate), txnExponent: currency.exponent, baseExponent: base.exponent };
}

function runCase(c: CaseSpec): { vector: SettlementVectorCase; result: CaseResult } {
  const purchases = new Map<string, { spec: PurchaseSpec; totalBase: bigint; outstanding: bigint; releasedBase: bigint }>();
  const purchaseOut: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(c.purchases)) {
    const totalBase = convertToBase(p.totalTxnMinor, r10(p.rate), p.currency.exponent, c.base.exponent);
    purchases.set(name, { spec: p, totalBase, outstanding: p.totalTxnMinor, releasedBase: 0n });
    purchaseOut[name] = { currency: p.currency, rate: p.rate, totalTxnMinor: p.totalTxnMinor, totalBaseMinor: totalBase };
  }
  const notes = new Map<string, { spec: NoteSpec; originalCarrying: bigint; remaining: bigint; remainingCarrying: bigint }>();
  const noteOut: Record<string, unknown> = {};
  for (const [name, n] of Object.entries(c.notes)) {
    const originalCarrying = convertToBase(n.originalMinor, r10(n.rate), n.currency.exponent, c.base.exponent);
    notes.set(name, { spec: n, originalCarrying, remaining: n.originalMinor, remainingCarrying: originalCarrying });
    noteOut[name] = { currency: n.currency, rate: n.rate, originalMinor: n.originalMinor, originalCarryingMinor: originalCarrying };
  }
  const get = <V>(m: Map<string, V>, k: string): V => {
    const v = m.get(k);
    if (v === undefined) throw new Error(`${c.id}: unknown ${k}`);
    return v;
  };
  const apState = (name: string): PurchaseApState => {
    const p = get(purchases, name);
    return {
      totalTxnMinor: p.spec.totalTxnMinor,
      totalBaseMinor: p.totalBase,
      outstandingTxnMinor: p.outstanding,
      conversion: conversionOf(p.spec.currency, p.spec.rate, c.base),
    };
  };
  const noteState = (name: string): CreditNoteState => {
    const n = get(notes, name);
    return {
      originalMinor: n.spec.originalMinor,
      originalCarryingMinor: n.originalCarrying,
      remainingMinor: n.remaining,
      conversion: conversionOf(n.spec.currency, n.spec.rate, c.base),
    };
  };
  const conv = (x: bigint, cur: CurrencySpec, rate: string): PrimitiveCall => ({
    fn: 'supplier_convert_base',
    args: [formatMinor(x), rate, cur.exponent, c.base.exponent],
    result: formatMinor(convertToBase(x, r10(rate), cur.exponent, c.base.exponent)),
  });
  const rel = (name: string, applied: bigint): PrimitiveCall => {
    const p = get(purchases, name);
    const x = p.spec.totalTxnMinor - p.outstanding;
    return {
      fn: 'supplier_ap_release',
      args: [formatMinor(p.totalBase), formatMinor(p.spec.totalTxnMinor), formatMinor(x), formatMinor(applied)],
      result: formatMinor(apRelease(p.totalBase, p.spec.totalTxnMinor, x, applied)),
    };
  };
  const g = (name: string, r: bigint): PrimitiveCall => {
    const n = get(notes, name);
    return {
      fn: 'supplier_credit_remaining_carrying',
      args: [formatMinor(n.spec.originalMinor), formatMinor(n.originalCarrying), formatMinor(r)],
      result: formatMinor(creditRemainingCarrying(n.spec.originalMinor, n.originalCarrying, r)),
    };
  };

  const steps: StepResult[] = [];
  for (const s of c.steps) {
    if (s.kind === 'payment') {
      const p = get(purchases, s.purchase);
      const primitives: PrimitiveCall[] = [conv(s.appliedMinor, p.spec.currency, p.spec.rate), conv(s.paymentAmountMinor, s.currency, s.rate)];
      if (s.appliedMinor <= p.outstanding) primitives.unshift(rel(s.purchase, s.appliedMinor));
      const r = attempt(() =>
        planPaymentAllocation({
          purchase: apState(s.purchase),
          sameCurrency: s.currency.code === p.spec.currency.code,
          paymentAmountMinor: s.paymentAmountMinor,
          payment: conversionOf(s.currency, s.rate, c.base),
          appliedMinor: s.appliedMinor,
        }),
      );
      const v = r.value;
      if (v !== null) {
        p.outstanding -= v.appliedMinor;
        p.releasedBase += v.carryingReleasedMinor;
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan:
          v === null
            ? null
            : {
                paymentAmountMinor: v.paymentAmountMinor,
                paymentBaseMinor: v.paymentBaseMinor,
                appliedMinor: v.appliedMinor,
                releasedBeforeMinor: v.releasedBeforeMinor,
                carryingReleasedMinor: v.carryingReleasedMinor,
                apConvertedMinor: v.apConvertedMinor,
                apDustBaseMinor: v.apDustBaseMinor,
                realizedMinor: v.realizedMinor,
              },
        entry: v?.entryLines ?? null,
        primitives,
        after: { purchase: s.purchase, outstandingTxnMinor: p.outstanding, remainingBaseMinor: p.totalBase - p.releasedBase },
      });
    } else if (s.kind === 'credit_allocation') {
      const p = get(purchases, s.purchase);
      const n = get(notes, s.note);
      const primitives: PrimitiveCall[] = [conv(s.appliedMinor, p.spec.currency, p.spec.rate), conv(s.consumedMinor, n.spec.currency, n.spec.rate)];
      if (s.appliedMinor <= p.outstanding) primitives.unshift(rel(s.purchase, s.appliedMinor));
      if (s.consumedMinor <= n.remaining) primitives.push(g(s.note, n.remaining), g(s.note, n.remaining - s.consumedMinor));
      const r = attempt(() =>
        planCreditAllocation({
          purchase: apState(s.purchase),
          note: noteState(s.note),
          sameCurrency: n.spec.currency.code === p.spec.currency.code,
          consumedMinor: s.consumedMinor,
          appliedMinor: s.appliedMinor,
        }),
      );
      const v = r.value;
      if (v !== null) {
        p.outstanding -= v.appliedMinor;
        p.releasedBase += v.carryingReleasedMinor;
        n.remaining = v.remainingAfterMinor;
        n.remainingCarrying = v.remainingCarryingAfterMinor;
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan:
          v === null
            ? null
            : {
                consumedMinor: v.consumedMinor,
                remainingBeforeMinor: v.remainingBeforeMinor,
                creditReleasedMinor: v.creditReleasedMinor,
                creditConvertedMinor: v.creditConvertedMinor,
                creditDustBaseMinor: v.creditDustBaseMinor,
                appliedMinor: v.appliedMinor,
                releasedBeforeMinor: v.releasedBeforeMinor,
                carryingReleasedMinor: v.carryingReleasedMinor,
                apConvertedMinor: v.apConvertedMinor,
                apDustBaseMinor: v.apDustBaseMinor,
                realizedMinor: v.realizedMinor,
              },
        entry: v?.entryLines ?? null,
        primitives,
        after: {
          purchase: s.purchase,
          outstandingTxnMinor: p.outstanding,
          remainingBaseMinor: p.totalBase - p.releasedBase,
          note: s.note,
          remainingMinor: n.remaining,
          remainingCarryingMinor: n.remainingCarrying,
        },
      });
    } else {
      const n = get(notes, s.note);
      const primitives: PrimitiveCall[] = [conv(s.consumedMinor, n.spec.currency, n.spec.rate), conv(s.receiptAmountMinor, s.currency, s.rate)];
      if (s.consumedMinor <= n.remaining) primitives.push(g(s.note, n.remaining), g(s.note, n.remaining - s.consumedMinor));
      const r = attempt(() =>
        planRefund({
          note: noteState(s.note),
          sameCurrency: n.spec.currency.code === s.currency.code,
          consumedMinor: s.consumedMinor,
          receiptAmountMinor: s.receiptAmountMinor,
          receipt: conversionOf(s.currency, s.rate, c.base),
        }),
      );
      const v = r.value;
      if (v !== null) {
        n.remaining = v.remainingAfterMinor;
        n.remainingCarrying = v.remainingCarryingAfterMinor;
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan:
          v === null
            ? null
            : {
                consumedMinor: v.consumedMinor,
                remainingBeforeMinor: v.remainingBeforeMinor,
                creditReleasedMinor: v.creditReleasedMinor,
                creditConvertedMinor: v.creditConvertedMinor,
                creditDustBaseMinor: v.creditDustBaseMinor,
                receiptAmountMinor: v.receiptAmountMinor,
                receiptBaseMinor: v.receiptBaseMinor,
                realizedMinor: v.realizedMinor,
              },
        entry: v?.entryLines ?? null,
        primitives,
        after: { note: s.note, remainingMinor: n.remaining, remainingCarryingMinor: n.remainingCarrying },
      });
    }
  }
  const result: CaseResult = {
    steps,
    purchases: new Map([...purchases].map(([k, p]) => [k, { outstanding: p.outstanding, releasedBase: p.releasedBase, totalBase: p.totalBase }])),
    notes: new Map(
      [...notes].map(([k, n]) => [
        k,
        { remaining: n.remaining, remainingCarrying: n.remainingCarrying, original: n.spec.originalMinor, originalCarrying: n.originalCarrying },
      ]),
    ),
  };
  c.expect(result);
  return {
    vector: jsonable({ id: c.id, why: c.why, base: c.base, purchases: purchaseOut, notes: noteOut, steps }) as SettlementVectorCase,
    result,
  };
}

const planOf = (r: CaseResult, i: number): Readonly<Record<string, unknown>> => {
  const p = r.steps[i]?.plan;
  if (p === null || p === undefined) throw new Error(`step ${i + 1} was refused`);
  return p;
};
const outcomes = (r: CaseResult): string[] => r.steps.map((s) => s.outcome);
const accountsOf = (r: CaseResult, i: number): string[] => (r.steps[i]?.entry ?? []).map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`);

const CASES: readonly CaseSpec[] = [
  {
    id: 'GOLD-84-PARTIAL-FINAL',
    why: 'a 100 USD credit carried at 360.00 ILS: a partial refund of 60 USD releases the cumulative proportional 216.00, 40 USD remain carried at 144.00, and the final 40 USD releases the entire 144.00 residue (received @ 3.70: a gain of 4.00)',
    base: ILS,
    purchases: {},
    notes: { N1: { currency: USD, rate: '3.6000000000', originalMinor: 10000n } },
    steps: [
      { kind: 'refund', note: 'N1', currency: USD, rate: '3.6000000000', consumedMinor: 6000n, receiptAmountMinor: 6000n },
      { kind: 'refund', note: 'N1', currency: USD, rate: '3.7000000000', consumedMinor: 4000n, receiptAmountMinor: 4000n },
      { kind: 'refund', note: 'N1', currency: USD, rate: '3.7000000000', consumedMinor: 1n, receiptAmountMinor: 1n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['creditReleasedMinor'] === 21600n, 'GOLD-84: 60 USD release 216.00');
      check(r.steps[0]?.after['remainingCarryingMinor'] === 14400n, 'GOLD-84: 144.00 remains');
      check(planOf(r, 1)['creditReleasedMinor'] === 14400n, 'GOLD-84: the final 40 USD release 144.00');
      check(planOf(r, 1)['realizedMinor'] === 400n, 'GOLD-84: received @ 3.70, a gain of 4.00');
      check(r.steps[2]?.outcome === 'supplier_refund.credit_exhausted', 'an exhausted note refuses');
      const n = r.notes.get('N1');
      check(n?.remaining === 0n && n.remainingCarrying === 0n, 'the pair reaches 0/0 together');
    },
  },
  {
    id: 'GOLD-73-REFUND-EUR',
    why: 'CN 100 USD carried at 360.00 refunded as 90 EUR @ 4.10: Dr the posting account 369.00 / Cr 1150 360.00 / Cr 4900 9.00',
    base: ILS,
    purchases: {},
    notes: { N1: { currency: USD, rate: '3.6000000000', originalMinor: 10000n } },
    steps: [{ kind: 'refund', note: 'N1', currency: EUR, rate: '4.1000000000', consumedMinor: 10000n, receiptAmountMinor: 9000n }],
    expect: (r) => {
      check(
        JSON.stringify(accountsOf(r, 0)) === JSON.stringify(['D posting_account 36900', 'C supplier_receivable 36000', 'C fx_gain 900']),
        'GOLD-73: Dr 369 / Cr 1150 360 / Cr 4900 9',
      );
    },
  },
  {
    id: 'GOLD-61-CREDIT-ALLOC',
    why: 'a 500.00 ILS supplier credit applied to a new 800.00 purchase (Dr AP 500 / Cr 1150 500), then 300.00 paid in cash clears it; a further 0.01 exceeds the outstanding',
    base: ILS,
    purchases: { P1: { currency: ILS, rate: '1.0000000000', totalTxnMinor: 80000n } },
    notes: { N1: { currency: ILS, rate: '1.0000000000', originalMinor: 50000n } },
    steps: [
      { kind: 'credit_allocation', purchase: 'P1', note: 'N1', consumedMinor: 50000n, appliedMinor: 50000n },
      { kind: 'payment', purchase: 'P1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 30000n, appliedMinor: 30000n },
      { kind: 'payment', purchase: 'P1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 1n, appliedMinor: 1n },
    ],
    expect: (r) => {
      check(
        JSON.stringify(accountsOf(r, 0)) === JSON.stringify(['D accounts_payable 50000', 'C supplier_receivable 50000']),
        'GOLD-61: Dr AP 500 / Cr 1150 500',
      );
      check(JSON.stringify(accountsOf(r, 1)) === JSON.stringify(['D accounts_payable 30000', 'C posting_account 30000']), 'GOLD-61: the cash 300');
      check(r.steps[2]?.outcome === 'supplier_payment.amount_exceeds_outstanding', 'MP-3: nothing is left to pay');
    },
  },
  {
    id: 'AP-THIRDS-EXACT-CLEARING',
    why: 'a 1.00 USD purchase @ 3.65 (B = 3.65 ILS) paid in USD thirds @ 3.70: cumulative releases 120, 121, 124 sum to B exactly, so AP base is 0 when AP txn is 0; each difference is a realized loss',
    base: ILS,
    purchases: { P1: { currency: USD, rate: '3.6500000000', totalTxnMinor: 100n } },
    notes: {},
    steps: [
      { kind: 'payment', purchase: 'P1', currency: USD, rate: '3.7000000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment', purchase: 'P1', currency: USD, rate: '3.7000000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment', purchase: 'P1', currency: USD, rate: '3.7000000000', paymentAmountMinor: 34n, appliedMinor: 34n },
    ],
    expect: (r) => {
      check(r.steps.map((s) => s.plan?.['carryingReleasedMinor']).join(',') === '120,121,124', 'the cumulative releases are 120, 121, 124');
      const p = r.purchases.get('P1');
      check(p?.outstanding === 0n && p.releasedBase === p.totalBase, 'exact clearing: base 0 at txn 0');
      check(
        r.steps.every((s) => typeof s.plan?.['realizedMinor'] === 'bigint' && (s.plan['realizedMinor'] as bigint) > 0n),
        'each allocation is a loss',
      );
    },
  },
  {
    id: 'FOREIGN-AP-DUST',
    why: 'a 0.03 USD purchase @ 3.65 (B = 0.11) paid cent by cent in ILS: the second cent releases 3 while it converts to 4, a Cr AP dust of 1 on a base line; the ILS payment of 0.04 realizes a loss of 1',
    base: ILS,
    purchases: { P1: { currency: USD, rate: '3.6500000000', totalTxnMinor: 3n } },
    notes: {},
    steps: [
      { kind: 'payment', purchase: 'P1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 4n, appliedMinor: 1n },
      { kind: 'payment', purchase: 'P1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 4n, appliedMinor: 1n },
      { kind: 'payment', purchase: 'P1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 4n, appliedMinor: 1n },
    ],
    expect: (r) => {
      check(planOf(r, 1)['apDustBaseMinor'] === -1n, 'a negative AP dust');
      check(accountsOf(r, 1).includes('C accounts_payable 1'), 'the dust is a Cr AP base line');
      const p = r.purchases.get('P1');
      check(p?.outstanding === 0n && p.releasedBase === p.totalBase, 'exact clearing');
    },
  },
  {
    id: 'SAME-RATE-SUBUNIT-FX',
    why: 'a 1.00 USD purchase @ 3.65 paid 0.33 USD twice at the same rate: the second release (121) differs from the conversion (120) by 1, which is AP dust (Dr 1) and a realized gain of 1 on 4900, never 6100 (TL-8)',
    base: ILS,
    purchases: { P1: { currency: USD, rate: '3.6500000000', totalTxnMinor: 100n } },
    notes: {},
    steps: [
      { kind: 'payment', purchase: 'P1', currency: USD, rate: '3.6500000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment', purchase: 'P1', currency: USD, rate: '3.6500000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment', purchase: 'P1', currency: USD, rate: '3.6500000000', paymentAmountMinor: 34n, appliedMinor: 33n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['realizedMinor'] === 0n, 'the first third realizes nothing');
      check(planOf(r, 1)['apDustBaseMinor'] === 1n && planOf(r, 1)['realizedMinor'] === -1n, 'fx = -ap_dust, a gain of 1');
      check(
        JSON.stringify(accountsOf(r, 1)) === JSON.stringify(['D accounts_payable 120', 'D accounts_payable 1', 'C posting_account 120', 'C fx_gain 1']),
        'the four lines',
      );
      check(r.steps[2]?.outcome === 'supplier_payment.amount_mismatch', 'the same currency pays exactly what it applies');
    },
  },
  {
    id: 'STRONG-BASE-MIN1',
    why: 'a JOD-base business (3 minor units) with a 1000.00 LBP credit carried at 0.002 JOD: consuming 790.00 leaves g = max(1, 2 - 2) = 1 so (remaining = 0) = (remaining_carrying = 0) stays true; the final 210.00 releases that 1',
    base: JOD,
    purchases: { P1: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n } },
    notes: { N1: { currency: LBP, rate: '0.0000024900', originalMinor: 100000n } },
    steps: [
      { kind: 'credit_allocation', purchase: 'P1', note: 'N1', consumedMinor: 79000n, appliedMinor: 79000n },
      { kind: 'credit_allocation', purchase: 'P1', note: 'N1', consumedMinor: 21000n, appliedMinor: 21000n },
    ],
    expect: (r) => {
      check(r.steps[0]?.after['remainingCarryingMinor'] === 1n && r.steps[0]?.after['remainingMinor'] === 21000n, 'MIN1: 210.00 LBP keep 0.001 JOD');
      check(planOf(r, 0)['creditDustBaseMinor'] === -1n, 'the first consumption carries a Dr 1150 dust of 1');
      check(planOf(r, 1)['creditReleasedMinor'] === 1n, 'the final consumption releases the MIN1 residue');
      const n = r.notes.get('N1');
      check(n?.remaining === 0n && n.remainingCarrying === 0n, 'the pair reaches 0/0 together');
    },
  },
  {
    id: 'BELOW-BASE-UNIT',
    why: 'the same JOD base and LBP purchase: 999.90 LBP paid in JOD leave a txn-only AP residue of 0.10 LBP whose base is 0 (S5 L2); paying it converts to 0 and is a stable amount_below_base_unit refusal, as is a JOD payment converting to 0, and a credit whose consumption converts to 0 (TL-9)',
    base: JOD,
    purchases: { P1: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n } },
    notes: { N1: { currency: LBP, rate: '0.0000024900', originalMinor: 100000n } },
    steps: [
      { kind: 'payment', purchase: 'P1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 2n, appliedMinor: 99990n },
      { kind: 'payment', purchase: 'P1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 1n, appliedMinor: 10n },
      { kind: 'payment', purchase: 'P1', currency: LBP, rate: '0.0000024900', paymentAmountMinor: 10n, appliedMinor: 10n },
      { kind: 'credit_allocation', purchase: 'P1', note: 'N1', consumedMinor: 10n, appliedMinor: 10n },
      { kind: 'refund', note: 'N1', currency: JOD, rate: '1.0000000000', consumedMinor: 100n, receiptAmountMinor: 1n },
    ],
    expect: (r) => {
      check(r.steps[0]?.outcome === 'accepted' && r.steps[0]?.after['remainingBaseMinor'] === 0n, 'the residue carries base 0');
      check(
        JSON.stringify(outcomes(r).slice(1)) ===
          JSON.stringify([
            'supplier_payment.amount_below_base_unit',
            'supplier_payment.amount_below_base_unit',
            'supplier_credit_allocation.amount_below_base_unit',
            'supplier_refund.amount_below_base_unit',
          ]),
        'each sub-unit settlement is a stable refusal',
      );
      check(r.purchases.get('P1')?.outstanding === 10n, 'the residue stays outstanding');
    },
  },
  {
    id: 'CREDIT-ALLOC-FX-SIGN',
    why: 'the realized sign of a credit allocation: a USD credit carried @ 3.60 extinguishing USD AP carried @ 3.70 is a gain (Cr 4900); carried @ 3.60 against AP @ 3.50 a loss (Dr 6900); an allocation above the remaining credit refuses',
    base: ILS,
    purchases: {
      P1: { currency: USD, rate: '3.7000000000', totalTxnMinor: 5000n },
      P2: { currency: USD, rate: '3.5000000000', totalTxnMinor: 5000n },
    },
    notes: { N1: { currency: USD, rate: '3.6000000000', originalMinor: 10000n } },
    steps: [
      { kind: 'credit_allocation', purchase: 'P1', note: 'N1', consumedMinor: 5000n, appliedMinor: 5000n },
      { kind: 'credit_allocation', purchase: 'P2', note: 'N1', consumedMinor: 6000n, appliedMinor: 6000n },
      { kind: 'credit_allocation', purchase: 'P2', note: 'N1', consumedMinor: 5000n, appliedMinor: 5000n },
    ],
    expect: (r) => {
      check(accountsOf(r, 0).includes('C fx_gain 500'), 'a gain of 5.00');
      check(r.steps[1]?.outcome === 'supplier_credit_allocation.amount_exceeds_credit', 'MP-6');
      check(accountsOf(r, 2).includes('D fx_loss 500'), 'a loss of 5.00');
    },
  },
];

export function buildSupplierSettlementVectors(): SupplierSettlementVectors {
  return {
    version: 'invsupset/1',
    note: 'Generated by packages/inventory/scripts/generate-s6-vectors.ts and verified by packages/inventory/test/supplier-settlement.test.ts (PHASE_3_S6_CONTRACT A-05, A-08 - A-10). conv(x, rate, e_t, e_b) = HALF_EVEN(x x rate x 10^max(0, e_b - e_t) / 10^max(0, e_t - e_b)); a purchase: B = conv(T); a note: OB = conv(OA). Per step, in order, each starting from what the previous accepted one stored: X = T - O; rel = HALF_EVEN(B x (X + a), T) - HALF_EVEN(B x X, T); ap_dust = rel - conv(a); g(r) = 0 if r = 0 else max(1, OB - HALF_EVEN(OB x (OA - r), OA)); cr_rel = g(rb) - g(rb - c); cr_dust = cr_rel - conv(c); a payment realizes pb - rel (> 0 Dr fx_loss), a credit allocation cr_rel - rel (> 0 Dr fx_loss), a refund mb - cr_rel (> 0 Cr fx_gain). Refusals: credit_exhausted, amount_exceeds_credit, amount_exceeds_outstanding, amount_mismatch (same currency, different amounts), amount_below_base_unit (a positive amount converting to 0). entry: the A-05 lines in order, each only when non-zero (currency purchase | note | payment | receipt | base; dimension purchase = the target purchase branch, origin = the note origin purchase branch). primitives: every SQL primitive call the step made, with its result.',
    cases: CASES.map((c) => runCase(c).vector),
  };
}

export function renderSupplierSettlementVectors(): Promise<string> {
  return renderJson(buildSupplierSettlementVectors(), 'supplier-settlement-vectors.json');
}
