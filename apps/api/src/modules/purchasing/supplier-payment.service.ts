import { Inject, Injectable } from '@nestjs/common';
import { mintDomainPostingAssertion, type PostingCommand } from '@daftar/accounting';
import {
  normalizeDocumentText,
  parseMinor,
  parseUnitCost,
  planPaymentAllocation,
  SETTLEMENT_REFERENCE_MAX,
  supplierPayIntentSha256,
  supplierPayPayload,
  type MovementPayload,
  type PaymentAllocationPlan,
} from '@daftar/inventory';
import type { SupplierPaymentResultDto } from '@daftar/shared-contracts';
import { Database, type AccountingAssertions, type BusinessInventoryAccountingTransaction } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import { paymentMethodRefusal } from '../payment-methods/payment-method-errors';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { classifiedRefusal, purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findSupplierPayment, readSettlementFx, readSupplierPaymentResult, scopedRows, type SettlementFx } from './purchasing-reads';
import type { SupplierPaymentRequest } from './purchasing.schemas';
import { settlementPostingCommand, SUPPLIER_PAYMENT_SOURCE } from './supplier-settlement-posting';

/**
 * The state of one purchase a payment allocation settles, as the service
 * binds it (A-08, A-15): the receipt's stored snapshot and totals, and the
 * outstanding AP `O` from `purchase_ap_outstanding`, the one definition.
 */
export interface SettledPurchase {
  readonly purchaseId: string;
  readonly supplierId: string;
  readonly warehouseId: string;
  /** The warehouse's branch: the dimension of every line of its entry (A-05). */
  readonly branchId: string | null;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  readonly outstandingTxnMinor: bigint;
  /** `NUMERIC(20,10)` text of the stored `source_to_base_rate` (`R`). */
  readonly rate: string;
  readonly rateSource: 'base' | 'manual';
  readonly rateAt: Date;
}

/** The method a payment or refund names, as read (its account by id and by chart code). */
export interface SettlementMethod {
  readonly paymentMethodId: string;
  readonly isActive: boolean;
  readonly requiresReference: boolean;
  readonly postingAccountId: string;
  readonly postingAccountCode: string;
}

/** One allocation of a payment to bind: the client's two amounts and the purchase they settle. */
export interface PaymentAllocationToBind {
  readonly allocationId: string;
  readonly purchase: SettledPurchase;
  readonly paymentAmountMinor: bigint;
  readonly appliedMinor: bigint;
}

export interface PaymentToBind {
  readonly tenantId: string;
  readonly businessId: string;
  readonly businessTransactionId: string;
  readonly paymentId: string;
  readonly supplierId: string;
  readonly method: SettlementMethod;
  readonly paymentDate: string;
  /** The payment currency `P`, ISO upper case. */
  readonly currency: string;
  readonly currencyExponent: number;
  readonly baseCurrency: string;
  readonly baseExponent: number;
  readonly amountMinor: bigint;
  /** Already `normalizeDocumentText`-ed. */
  readonly reference: string | null;
  readonly fx: SettlementFx;
  /** In `line_no` order. */
  readonly allocations: readonly PaymentAllocationToBind[];
}

/** A payment with every value the database will store computed and bound, before anything is minted. */
export interface BoundPayment {
  readonly built: MovementPayload;
  /** One `supplier_payment` entry per allocation, in `line_no` order (A-05). */
  readonly commands: readonly PostingCommand[];
  /** The `supplier_pay` arguments, in its signature's order (§2.6). */
  readonly params: readonly unknown[];
}

/** `supplier_pay` (§2.6), returning one row per allocation. */
export const SUPPLIER_PAY_SQL = `SELECT payment_id, allocation_id, line_no, purchase_id, replayed FROM supplier_pay(
   $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::char(3), $7::bigint, $8::uuid, $9::numeric, $10::text, $11::timestamptz,
   $12::bigint, $13::text, $14::uuid[], $15::uuid[], $16::uuid[], $17::text[], $18::bigint[], $19::bigint[], $20::bigint[],
   $21::bigint[], $22::bigint[], $23::bigint[], $24::bigint[])`;

/**
 * Bind a supplier payment (A-07 – A-09, A-15, A-16): each allocation's AP
 * release, dust, payment base and realized FX through `planPaymentAllocation`
 * — the package's exact half-even arithmetic, the twin of the routine's — the
 * header base `Σ pb` (never `conv(Σ p)`), the `supplier.pay` payload and one
 * `supplier_payment` posting command per allocation. The standalone payment
 * and the payment half of receive-and-pay (A-19) share it.
 */
export function bindSupplierPayment(i: PaymentToBind): BoundPayment {
  const conversion = { rateR10: i.fx.rateR10, txnExponent: i.currencyExponent, baseExponent: i.baseExponent };
  const planned: { readonly a: PaymentAllocationToBind; readonly plan: PaymentAllocationPlan }[] = i.allocations.map((a) => ({
    a,
    plan: planPaymentAllocation({
      purchase: {
        totalTxnMinor: a.purchase.totalTxnMinor,
        totalBaseMinor: a.purchase.totalBaseMinor,
        outstandingTxnMinor: a.purchase.outstandingTxnMinor,
        conversion: { rateR10: parseUnitCost(a.purchase.rate), txnExponent: a.purchase.currencyExponent, baseExponent: i.baseExponent },
      },
      sameCurrency: a.purchase.currency === i.currency,
      paymentAmountMinor: a.paymentAmountMinor,
      payment: conversion,
      appliedMinor: a.appliedMinor,
    }),
  }));
  const baseAmountMinor = planned.reduce((sum, { plan }) => sum + plan.paymentBaseMinor, 0n);
  const rateAtEpochSeconds = BigInt(i.fx.at.getTime() / 1000);
  const built = supplierPayPayload({
    tenantId: i.tenantId,
    businessId: i.businessId,
    paymentId: i.paymentId,
    supplierId: i.supplierId,
    paymentMethodId: i.method.paymentMethodId,
    postingAccountId: i.method.postingAccountId,
    paymentDate: i.paymentDate,
    currency: i.currency,
    amountMinor: i.amountMinor,
    rate: { rateId: i.fx.rateId, rateR10: i.fx.rateR10, source: i.fx.source, rateAtEpochSeconds },
    baseAmountMinor,
    reference: i.reference,
    allocations: planned.map(({ a, plan }) => ({
      allocationId: a.allocationId,
      purchaseId: a.purchase.purchaseId,
      warehouseId: a.purchase.warehouseId,
      purchaseCurrency: a.purchase.currency,
      paymentAmountMinor: plan.paymentAmountMinor,
      paymentBaseMinor: plan.paymentBaseMinor,
      appliedMinor: plan.appliedMinor,
      releasedBeforeMinor: plan.releasedBeforeMinor,
      carryingReleasedMinor: plan.carryingReleasedMinor,
      apDustBaseMinor: plan.apDustBaseMinor,
      realizedMinor: plan.realizedMinor,
    })),
  });
  const payment = { currency: i.currency, rate: i.fx.rate, source: i.fx.source, at: i.fx.at };
  const commands = planned.map(({ a, plan }) =>
    settlementPostingCommand({
      tenantId: i.tenantId,
      businessId: i.businessId,
      sourceType: SUPPLIER_PAYMENT_SOURCE,
      sourceId: a.allocationId,
      entryDate: i.paymentDate,
      baseCurrency: i.baseCurrency,
      snapshots: { purchase: { currency: a.purchase.currency, rate: a.purchase.rate, source: a.purchase.rateSource, at: a.purchase.rateAt }, payment },
      postingAccountCode: i.method.postingAccountCode,
      branches: { purchase: a.purchase.branchId, origin: null },
      lines: plan.entryLines,
      businessTransactionId: i.businessTransactionId,
    }),
  );
  const col = <T>(f: (x: { readonly a: PaymentAllocationToBind; readonly plan: PaymentAllocationPlan }) => T): T[] => planned.map(f);
  const params: unknown[] = [
    i.paymentId,
    i.supplierId,
    i.method.paymentMethodId,
    i.method.postingAccountId,
    i.paymentDate,
    i.currency,
    i.amountMinor.toString(10),
    i.fx.rateId,
    i.fx.rate,
    i.fx.source,
    `${i.fx.at.toISOString().slice(0, 19)}Z`,
    baseAmountMinor.toString(10),
    i.reference,
    col(({ a }) => a.allocationId),
    col(({ a }) => a.purchase.purchaseId),
    col(({ a }) => a.purchase.warehouseId),
    col(({ a }) => a.purchase.currency),
    col(({ plan }) => plan.paymentAmountMinor.toString(10)),
    col(({ plan }) => plan.paymentBaseMinor.toString(10)),
    col(({ plan }) => plan.appliedMinor.toString(10)),
    col(({ plan }) => plan.releasedBeforeMinor.toString(10)),
    col(({ plan }) => plan.carryingReleasedMinor.toString(10)),
    col(({ plan }) => plan.apDustBaseMinor.toString(10)),
    col(({ plan }) => plan.realizedMinor.toString(10)),
  ];
  return { built, commands, params };
}

/**
 * Run `supplier_pay` on an open seam-2 transaction and, unless the routine
 * answered a replay, post its entries in `line_no` order — each through the
 * posting adapter, which presents that entry's own assertion. The caller has
 * already presented the `supplier.pay` inventory assertion when the seam
 * carries several.
 */
export async function executeSupplierPay(
  tx: BusinessInventoryAccountingTransaction,
  posting: DatabaseAccountingPostingAdapter,
  bound: BoundPayment,
): Promise<boolean> {
  const r = await tx.query<{ allocation_id: string; line_no: number; replayed: boolean }>(SUPPLIER_PAY_SQL, [...bound.params]);
  const [first] = r.rows;
  if (first === undefined) throw new Error('supplier_pay returned no row');
  // A replay inside the routine (a concurrent identical payment won the key)
  // commits no entry; its minted accounting assertions expire unused (A-08).
  if (first.replayed) return true;
  for (const command of bound.commands) await posting.postEntryInTransaction(tx.accounting, { command });
  return false;
}

/** The purchase rows of a settlement's state read, numerics as text (A-15). */
export interface PurchaseStateRow {
  id: string;
  supplier_id: string;
  warehouse_id: string;
  branch_id: string | null;
  status: string;
  reversed: boolean;
  currency_code: string;
  currency_exponent: number;
  document_date: string;
  total_txn_minor: string;
  total_base_minor: string | null;
  rate: string | null;
  rate_source: 'base' | 'manual' | null;
  rate_timestamp: string | null;
  outstanding: string;
}

/** The method column of a state read (`SETTLEMENT_METHOD_SQL`). */
export interface SettlementMethodRow {
  id: string;
  is_active: boolean;
  requires_reference: boolean;
  posting_account_id: string;
  account_code: string;
}

/** Everything a payment binds, read in ONE statement (one snapshot, the S4 receipt's review L3). */
interface PaymentState {
  base_currency: string;
  base_exponent: number;
  future: boolean;
  currency_exponent: number | null;
  supplier_status: string | null;
  method: SettlementMethodRow | null;
  purchases: PurchaseStateRow[];
}

/** The purchases of a state read, in the business's scope, with `O` (A-13) and the warehouse's branch. */
export const SETTLED_PURCHASES_SQL = `(SELECT coalesce(json_agg(json_build_object(
            'id', p.id, 'supplier_id', p.supplier_id, 'warehouse_id', p.warehouse_id, 'branch_id', w.branch_id, 'status', p.status,
            'reversed', EXISTS (SELECT 1 FROM purchase_reversals x WHERE x.business_id = p.business_id AND x.id = p.id),
            'currency_code', p.currency_code::text, 'currency_exponent', pc.minor_units, 'document_date', p.document_date::text,
            'total_txn_minor', p.total_txn_minor::text, 'total_base_minor', p.total_base_minor::text,
            'rate', p.source_to_base_rate::text, 'rate_source', p.rate_source,
            'rate_timestamp', to_char(p.rate_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'outstanding', purchase_ap_outstanding(p.business_id, p.id)::text)), '[]'::json)
       FROM purchases p
       JOIN warehouses w ON w.business_id = p.business_id AND w.id = p.warehouse_id
       JOIN currencies pc ON pc.code = p.currency_code
      WHERE p.business_id = b.id AND p.id = ANY(%IDS%::uuid[]))`;

/** A received purchase's row as the binder's state; its stored snapshot must be whole. */
export function settledPurchase(row: PurchaseStateRow): SettledPurchase {
  if (row.total_base_minor === null || row.rate === null || row.rate_source === null || row.rate_timestamp === null) {
    throw new Error('a received purchase has no stored base total or FX snapshot');
  }
  return {
    purchaseId: row.id,
    supplierId: row.supplier_id,
    warehouseId: row.warehouse_id,
    branchId: row.branch_id,
    currency: row.currency_code,
    currencyExponent: row.currency_exponent,
    totalTxnMinor: parseMinor(row.total_txn_minor),
    totalBaseMinor: parseMinor(row.total_base_minor),
    outstandingTxnMinor: parseMinor(row.outstanding),
    rate: row.rate,
    rateSource: row.rate_source,
    rateAt: new Date(row.rate_timestamp),
  };
}

/** The method a settlement names, with its account's chart code, as a state-read column. */
export const SETTLEMENT_METHOD_SQL = `(SELECT json_build_object('id', m.id, 'is_active', m.is_active, 'requires_reference', m.requires_reference,
            'posting_account_id', m.posting_account_id, 'account_code', a.code)
       FROM payment_methods m
       JOIN accounts a ON a.business_id = m.business_id AND a.id = m.posting_account_id
      WHERE m.business_id = b.id AND m.id = %METHOD%::uuid)`;

/**
 * The method checks of §2.6 step 8 the service can see (missing, inactive,
 * the reference rule). Eligibility of the account (MP-1) is the database's,
 * in one place (`accounting_settlement_account_eligibility`), and the routine
 * judges it under its lock.
 */
export function settlementMethod(
  row: SettlementMethodRow | null,
  reference: string | null,
  referenceRequired: 'supplier_payment.reference_required' | 'supplier_refund.reference_required',
): SettlementMethod {
  if (row === null) throw paymentMethodRefusal('payment_method.not_found');
  if (!row.is_active) throw paymentMethodRefusal('payment_method.inactive');
  if (row.requires_reference && reference === null) throw purchasingRefusal(referenceRequired);
  return {
    paymentMethodId: row.id,
    isActive: row.is_active,
    requiresReference: row.requires_reference,
    postingAccountId: row.posting_account_id,
    postingAccountCode: row.account_code,
  };
}

/**
 * A settlement reference: trimmed, NULL when empty. Longer than 100
 * characters is the command's shape refusal (§2.6 step 5); the DTO bounds it
 * already, so this only keeps the builder's input the routine's.
 */
export function settlementReference(
  raw: string | null | undefined,
  shapeCode: 'supplier_payment.allocations_invalid' | 'inventory.payload_invalid',
): string | null {
  const reference = normalizeDocumentText(raw);
  if (reference !== null && [...reference].length > SETTLEMENT_REFERENCE_MAX) throw classifiedRefusal(shapeCode);
  return reference;
}

/**
 * `POST /v1/supplier-payments` (PHASE_3_S6_CONTRACT A-07 – A-09, A-11, A-15,
 * A-16, A-18; §2.6 `supplier_pay`).
 *
 * The flow is A-16's application order with the A-15 binding:
 *
 * 1. the client intent (`payment_id`, the supplier, the method, the date, the
 *    currency, the amount, the reference and each allocation's id, purchase
 *    and two amounts) and the idempotency proof against the stored payment —
 *    a replay answers its stored rows, a different intent is
 *    `supplier_payment.idempotency_conflict` — BEFORE any state read;
 * 2. authority: `suppliers.pay` over EVERY allocated purchase's warehouse
 *    (AL-39), read from the purchases themselves; a purchase that is not
 *    visible is `purchase.not_found`;
 * 3. current state in ONE statement: every purchase with `O`, the supplier,
 *    the method and its account's code, the currency, the business's base
 *    currency and "today"; then the payment's FX snapshot (A-15);
 * 4. the routine's refusals in its order (§2.6 steps 6–11), and every stored
 *    amount bound (`bindSupplierPayment`);
 * 5. the `invctl/1` assertion over the `supplier.pay` payload and ONE
 *    accounting assertion per allocation, all minted BEFORE seam 2 opens;
 * 6. seam 2: the routine, then — unless it answered a replay — the `k`
 *    entries in `line_no` order, then COMMIT with the deferred guards (the
 *    R-62 chain, the completeness triggers).
 *
 * The payment is optimistic: if `O` or a rate moved between the read and the
 * routine's locks, the routine refuses `supplier_payment.settlement_changed`
 * / `.fx_rate_changed` (409, retry the same body) and nothing commits.
 */
@Injectable()
export class SupplierPaymentService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async pay(m: MembershipContext, input: SupplierPaymentRequest, btx: BusinessTransactionId): Promise<SupplierPaymentResultDto> {
    try {
      return await this.run(m, input, btx);
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async run(m: MembershipContext, input: SupplierPaymentRequest, btx: BusinessTransactionId): Promise<SupplierPaymentResultDto> {
    // 1. The client intent, then the idempotency proof — before any state read.
    const reference = settlementReference(input.reference, 'supplier_payment.allocations_invalid');
    const amountMinor = BigInt(input.amountMinor);
    const intentAllocations = input.allocations.map((a) => ({
      allocationId: a.allocationId,
      purchaseId: a.purchaseId,
      paymentAmountMinor: BigInt(a.paymentAmountMinor),
      appliedMinor: BigInt(a.purchaseAmountAppliedMinor),
    }));
    const intentSha256 = supplierPayIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      paymentId: input.paymentId,
      supplierId: input.supplierId,
      paymentMethodId: input.paymentMethodId,
      paymentDate: input.paymentDate,
      currency: input.currencyCode,
      amountMinor,
      reference,
      allocations: intentAllocations,
    });
    const existing = await findSupplierPayment(this.db, m, input.paymentId);
    if (existing !== null) {
      if (existing.intentSha256 !== intentSha256) throw purchasingRefusal('supplier_payment.idempotency_conflict');
      // The stored answer is shown only to an actor with authority over every warehouse it touches.
      await this.authorization.authorize(m, 'supplier.pay', btx, existing.warehouseIds);
      return readSupplierPaymentResult(this.db, m, input.paymentId, true);
    }

    // 2–3. Current state in one snapshot; authority over every allocated purchase's warehouse.
    const state = await this.readState(m, input);
    const byId = new Map(state.purchases.map((p) => [p.id, p]));
    const rows = input.allocations.map((a) => {
      const row = byId.get(a.purchaseId);
      if (row === undefined) throw purchasingRefusal('purchase.not_found');
      return row;
    });
    const authority = await this.authorization.authorize(
      m,
      'supplier.pay',
      btx,
      rows.map((r) => r.warehouse_id),
    );

    // 4. The routine's refusals in its order (§2.6 steps 6–10).
    for (const row of rows) {
      if (row.supplier_id !== input.supplierId) throw purchasingRefusal('supplier_payment.purchase_supplier_mismatch');
      if (row.status !== 'received') throw purchasingRefusal('supplier_payment.purchase_state_invalid');
      if (row.reversed) throw purchasingRefusal('supplier_payment.purchase_reversed');
    }
    if (state.supplier_status === null) throw purchasingRefusal('supplier.not_found');
    if (state.supplier_status !== 'active') throw purchasingRefusal('supplier_payment.supplier_inactive');
    const method = settlementMethod(state.method, reference, 'supplier_payment.reference_required');
    if (rows.some((r) => input.paymentDate < r.document_date)) throw purchasingRefusal('supplier_payment.date_before_purchase');
    if (state.future) throw purchasingRefusal('supplier_payment.date_in_future');
    if (state.currency_exponent === null) throw purchasingRefusal('purchase.currency_unknown');
    const fx = await readSettlementFx(this.db, m, input.currencyCode, state.base_currency, input.paymentDate);

    const bound = bindSupplierPayment({
      tenantId: m.tenantId,
      businessId: m.businessId,
      businessTransactionId: btx,
      paymentId: input.paymentId,
      supplierId: input.supplierId,
      method,
      paymentDate: input.paymentDate,
      currency: input.currencyCode,
      currencyExponent: state.currency_exponent,
      baseCurrency: state.base_currency,
      baseExponent: state.base_exponent,
      amountMinor,
      reference,
      fx,
      allocations: intentAllocations.map((a, i) => {
        const row = rows[i];
        if (row === undefined) throw new Error('an allocation lost its purchase');
        return { allocationId: a.allocationId, purchase: settledPurchase(row), paymentAmountMinor: a.paymentAmountMinor, appliedMinor: a.appliedMinor };
      }),
    });
    if (bound.built.intentSha256 !== intentSha256) throw new Error('the bound payment payload does not carry the proven intent');

    // 5. Mint everything before the seam opens: one inventory assertion, one accounting assertion per allocation.
    const inventoryAssertion = this.authorization.mint(authority, bound.built.payload);
    const [first, ...rest] = bound.commands.map((c) => mintDomainPostingAssertion(this.accountingMinter, c, m.userId));
    if (first === undefined) throw new Error('a payment binds at least one allocation');
    const accountingAssertions: AccountingAssertions = [first, ...rest];

    // 6. One transaction: the routine, the k entries, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, accountingAssertions, (tx) =>
      executeSupplierPay(tx, this.posting, bound),
    );
    return readSupplierPaymentResult(this.db, m, input.paymentId, replayed);
  }

  /** The payment's state in ONE statement, read by `daftar_app` under RLS. */
  private async readState(scope: ReadScope, input: SupplierPaymentRequest): Promise<PaymentState> {
    const [row] = await scopedRows<PaymentState>(
      this.db,
      scope,
      `SELECT b.base_currency::text AS base_currency, bc.minor_units AS base_exponent,
              ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              (SELECT c.minor_units FROM currencies c WHERE c.code = $3) AS currency_exponent,
              (SELECT s.status FROM suppliers s WHERE s.business_id = b.id AND s.id = $4) AS supplier_status,
              ${SETTLEMENT_METHOD_SQL.replace('%METHOD%', '$5')} AS method,
              ${SETTLED_PURCHASES_SQL.replace('%IDS%', '$6')} AS purchases
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
        WHERE b.id = $1`,
      [scope.businessId, input.paymentDate, input.currencyCode, input.supplierId, input.paymentMethodId, input.allocations.map((a) => a.purchaseId)],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }
}
