/**
 * P3-S6 — THE SUPPLIER SETTLEMENT HARNESS
 * (docs/PHASE_3_S6_CONTRACT.md §5, §6; the S4/S5 harnesses
 * `purchase-commands.ts` and `purchase-returns.ts` extended to the seven S6
 * entry routines).
 *
 * Two ways in, both through the REAL boundary:
 *
 * - SQL: every helper drives a real entry routine with a real `invctl/1`
 *   assertion minted with the test key over the `invpl/1` stream of its own
 *   arguments, carried in `app.inventory_assertion`, the routine executed as
 *   `daftar_app`. A settlement is BOUND exactly as the service binds it: the
 *   purchase, `purchase_ap_outstanding`, the note and the method read as the
 *   owner, then the APP's own binder (`bindSupplierPayment`) or the
 *   package's plan (`planCreditAllocation`, `planRefund`) and the APP's
 *   posting builder (`settlementPostingCommand`); each entry is minted by the
 *   real `mintDomainPostingAssertion` and written by `accounting_post_entry`
 *   as `daftar_app` in the SAME transaction (A-05). Negative tests depart
 *   from the honest call in exactly one way at a time (`S6RunOptions`).
 * - HTTP: the real Nest application; a world onboarded through the real API
 *   with methods, suppliers and purchases made by the owner.
 *
 * `seedSettlementAccounts` states the chart §5 names: the five settlement
 * system accounts, a custom asset account, an expense, a custom liability and
 * an inactive custom asset account (custom accounts have no merchant write
 * path yet, so the fixture inserts them as the owner, as S4/S5 fixtures seed
 * master data).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, Pool } from 'pg';
import { expect } from 'vitest';
import type { Response } from 'supertest';
import { mintDomainPostingAssertion, type PostingCommand } from '@daftar/accounting';
import {
  inventoryPayloadSha256,
  parseMinor,
  parseUnitCost,
  paymentMethodActivatePayload,
  paymentMethodCreatePayload,
  paymentMethodDeactivatePayload,
  paymentMethodUpdatePayload,
  planCreditAllocation,
  planRefund,
  supplierAllocateCreditPayload,
  supplierReceiveRefundPayload,
  yyyymmdd,
  type InventoryOperationCode,
  type InventoryPayloadField,
  type PaymentMethodSystemType,
} from '../../packages/inventory/src';
import {
  bindSupplierPayment,
  SETTLED_PURCHASES_SQL,
  SETTLEMENT_METHOD_SQL,
  settledPurchase,
  type PurchaseStateRow,
  type SettlementMethodRow,
} from '../../apps/api/src/modules/purchasing/supplier-payment.service';
import {
  CREDIT_NOTE_STATE_SQL,
  creditNoteState,
  noteSnapshot,
  type CreditNoteStateRow,
} from '../../apps/api/src/modules/purchasing/supplier-credit-allocation.service';
import {
  settlementPostingCommand,
  SUPPLIER_CREDIT_ALLOCATION_SOURCE,
  SUPPLIER_REFUND_SOURCE,
} from '../../apps/api/src/modules/purchasing/supplier-settlement-posting';
import type { SettlementFx } from '../../apps/api/src/modules/purchasing/purchasing-reads';
import { grantFeature, mintTestInventoryAssertion, ownerPool, raiseLimit, type TestApp } from './test-app';
import { attempt, asMember, must, ownerClient, today, type HttpActor, type Outcome, type Queryable, type S3Business } from './inventory-commands';
import { testMinter } from './inventory-posting';
import { postInTx, s4Counts, type Counts } from './purchase-commands';
import { receivedPurchase, returnGoods, S5_BRIDGES, S5_TABLES, type ReceivedPurchase, type ReceiveOptions } from './purchase-returns';
import { enterRate, rateIdFor } from './accounting-fx';
import { addMerchantVariant, addTrackedProduct, addVariantProduct, addWarehouse, createProduct, recordBusinessOwner, settle } from './stock-ledger';

// ── the S6 catalogue ───────────────────────────────────────────────────────

/** The six S6 tables (§2.2). */
export const S6_TABLES = [
  'payment_methods',
  'payment_method_names',
  'supplier_payments',
  'supplier_payment_allocations',
  'supplier_credit_allocations',
  'supplier_refunds',
] as const;

/** The four settlement tables: the accounting principal reads them (A-14(d)). */
export const S6_SETTLEMENT_TABLES = ['supplier_payments', 'supplier_payment_allocations', 'supplier_credit_allocations', 'supplier_refunds'] as const;

/** The three accounting source types S6 registers (A-05), in `sort_order`. */
export const S6_SOURCE_TYPES = ['supplier_payment', 'supplier_credit_allocation', 'supplier_refund'] as const;

/** The seven operation kinds (A-03), in `op_code` order. */
export const S6_OPERATION_KINDS = [
  'payment.activate_method',
  'payment.create_method',
  'payment.deactivate_method',
  'payment.update_method',
  'supplier.allocate_credit',
  'supplier.pay',
  'supplier.receive_refund',
] as const;

export type S6Kind = 'method_create' | 'method_update' | 'method_deactivate' | 'method_activate' | 'pay' | 'allocate_credit' | 'receive_refund';

export const S6_KINDS: readonly S6Kind[] = [
  'method_create',
  'method_update',
  'method_deactivate',
  'method_activate',
  'pay',
  'allocate_credit',
  'receive_refund',
];

export const S6_OP_OF: Readonly<Record<S6Kind, InventoryOperationCode>> = {
  method_create: 'payment.create_method',
  method_update: 'payment.update_method',
  method_deactivate: 'payment.deactivate_method',
  method_activate: 'payment.activate_method',
  pay: 'supplier.pay',
  allocate_credit: 'supplier.allocate_credit',
  receive_refund: 'supplier.receive_refund',
};

/** The seven entry routines with their exact signatures (§2.6). */
export const S6_ROUTINE_OF: Readonly<Record<S6Kind, string>> = {
  method_create: 'payment_method_create(uuid,text,uuid,boolean,integer,text,text,text)',
  method_update: 'payment_method_update(uuid,integer,uuid,boolean,integer,text,text,text)',
  method_deactivate: 'payment_method_deactivate(uuid,integer)',
  method_activate: 'payment_method_activate(uuid,integer)',
  pay: 'supplier_pay(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid[],uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])',
  allocate_credit: 'supplier_allocate_credit(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)',
  receive_refund:
    'supplier_receive_refund(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,bigint,text)',
};

/** The one S6 writer of `supplier_credit_notes` (0068 R-73). */
export const S6_WRITER = 'supplier_credit_note_consume(uuid,bigint,bigint)';

/** The three pure arithmetic functions (§2.3). */
export const S6_ARITHMETIC = [
  'supplier_convert_base(bigint,numeric,integer,integer)',
  'supplier_ap_release(bigint,bigint,bigint,bigint)',
  'supplier_credit_remaining_carrying(bigint,bigint,bigint)',
] as const;

/** The two verification helpers (§2.3). */
export const S6_VERIFY = ['purchase_settlement_verify(uuid,uuid)', 'supplier_credit_note_verify(uuid,uuid)'] as const;

/** The thirteen §2.3 guard rows: table, trigger, tgtype, deferred, function. */
export const S6_TRIGGERS: readonly (readonly [table: string, trigger: string, tgtype: number, deferred: boolean, fn: string])[] = [
  ['payment_methods', 'payment_methods_guard', 31, false, 'payment_method_guard()'],
  ['payment_methods', 'payment_methods_named', 21, true, 'payment_method_named()'],
  ['payment_method_names', 'payment_method_names_guard', 31, false, 'payment_method_name_guard()'],
  ['supplier_payments', 'supplier_payments_guard', 31, false, 'supplier_payment_guard()'],
  ['supplier_payments', 'supplier_payments_complete', 5, true, 'supplier_payment_complete()'],
  ['supplier_payment_allocations', 'supplier_payment_allocations_guard', 31, false, 'supplier_payment_allocation_guard()'],
  ['supplier_payment_allocations', 'supplier_payment_allocations_value_complete', 5, true, 'supplier_payment_allocation_value_complete()'],
  ['supplier_credit_allocations', 'supplier_credit_allocations_guard', 31, false, 'supplier_credit_allocation_guard()'],
  ['supplier_credit_allocations', 'supplier_credit_allocations_value_complete', 5, true, 'supplier_credit_allocation_value_complete()'],
  ['supplier_refunds', 'supplier_refunds_guard', 31, false, 'supplier_refund_guard()'],
  ['supplier_refunds', 'supplier_refunds_value_complete', 5, true, 'supplier_refund_value_complete()'],
  ['supplier_credit_notes', 'supplier_credit_notes_immutable', 27, false, 'supplier_credit_note_guard()'],
  ['purchase_reversals', 'purchase_reversals_unsettled', 5, true, 'purchase_reversal_unsettled()'],
];

/** The accounting-owned S6 functions (A-14): the eligibility and the three completeness functions. */
export const S6_ACCOUNTING_FUNCTIONS = [
  'accounting_settlement_account_eligibility(uuid,uuid)',
  'accounting_supplier_payment_entry_complete()',
  'accounting_supplier_credit_allocation_entry_complete()',
  'accounting_supplier_refund_entry_complete()',
] as const;

/** The three completeness triggers on `journal_entries` (A-14(a)), by source type. */
export const S6_COMPLETENESS_TRIGGERS: readonly (readonly [sourceType: string, trigger: string, fn: string])[] = [
  ['supplier_payment', 'journal_entries_supplier_payment_complete', 'accounting_supplier_payment_entry_complete()'],
  ['supplier_credit_allocation', 'journal_entries_supplier_credit_allocation_complete', 'accounting_supplier_credit_allocation_entry_complete()'],
  ['supplier_refund', 'journal_entries_supplier_refund_complete', 'accounting_supplier_refund_entry_complete()'],
];

/** The five settlement system keys a method may post through (A-06). */
export const SETTLEMENT_KEYS = ['cash', 'bank', 'card_clearing', 'wallet_clearing', 'cheque_clearing'] as const;

// ── the chart (§5 seedSettlementAccounts) ─────────────────────────────────

export interface SettlementAccounts {
  /** The five settlement system accounts, by key. */
  readonly settlement: Readonly<Record<(typeof SETTLEMENT_KEYS)[number], string>>;
  /** Engine asset identities a method may NOT post through (A-06). */
  readonly accountsReceivable: string;
  readonly supplierReceivable: string;
  readonly inventory: string;
  /** A system liability and a system expense. */
  readonly accountsPayable: string;
  readonly fxLoss: string;
  /** A merchant asset account (a second bank): eligible. */
  readonly customAsset: string;
  /** Custom accounts of other types, and an inactive custom asset account. */
  readonly customExpense: string;
  readonly customLiability: string;
  readonly inactiveAsset: string;
}

async function systemAccount(q: Queryable, businessId: string, key: string): Promise<string> {
  return must(
    (await q.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = $2`, [businessId, key])).rows[0],
    `system account ${key}`,
  ).id;
}

/** A custom account of the business, inserted as the owner (no merchant chart-write path exists yet). */
export async function customAccount(
  q: Queryable,
  biz: { readonly tenantId: string; readonly businessId: string },
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense',
  active = true,
): Promise<string> {
  const code = `${type === 'asset' ? '1' : type === 'liability' ? '2' : type === 'expense' ? '6' : '3'}0${randomUUID().slice(0, 6).toUpperCase()}`;
  return must(
    (
      await q.query<{ id: string }>(
        `INSERT INTO accounts (tenant_id, business_id, code, name, type, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
        [biz.tenantId, biz.businessId, code, `Custom ${type} ${code}`, type, active],
      )
    ).rows[0],
  ).id;
}

/** §5: the chart a settlement suite states, per business. */
export async function seedSettlementAccounts(q: Queryable, biz: { readonly tenantId: string; readonly businessId: string }): Promise<SettlementAccounts> {
  const settlement = {
    cash: await systemAccount(q, biz.businessId, 'cash'),
    bank: await systemAccount(q, biz.businessId, 'bank'),
    card_clearing: await systemAccount(q, biz.businessId, 'card_clearing'),
    wallet_clearing: await systemAccount(q, biz.businessId, 'wallet_clearing'),
    cheque_clearing: await systemAccount(q, biz.businessId, 'cheque_clearing'),
  };
  return {
    settlement,
    accountsReceivable: await systemAccount(q, biz.businessId, 'accounts_receivable'),
    supplierReceivable: await systemAccount(q, biz.businessId, 'supplier_receivable'),
    inventory: await systemAccount(q, biz.businessId, 'inventory'),
    accountsPayable: await systemAccount(q, biz.businessId, 'accounts_payable'),
    fxLoss: await systemAccount(q, biz.businessId, 'fx_loss'),
    customAsset: await customAccount(q, biz, 'asset'),
    customExpense: await customAccount(q, biz, 'expense'),
    customLiability: await customAccount(q, biz, 'liability'),
    inactiveAsset: await customAccount(q, biz, 'asset', false),
  };
}

// ── a business with another base currency (the strong-base fixtures) ─────

async function one(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  return must((await pool.query<{ id: string }>(sql, params)).rows[0], `id from: ${sql}`).id;
}

/**
 * A business of the S3 shape (`seedS3Business`) with `baseCurrency` as its
 * base: the strong-base fixtures of §5 (a JOD base, 3 decimals, with LBP
 * purchases at 0.0000024900 — the vectors' `STRONG-BASE-MIN1` and
 * `BELOW-BASE-UNIT`).
 */
export async function seedBusinessWithBase(pool: Pool, baseCurrency: string, label: string): Promise<S3Business> {
  const tenantId = await one(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const userId = await one(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`, [
    `s6-${label}-${randomUUID().slice(0, 8)}@test.daftar.local`,
    `S6 ${label}`,
  ]);
  const businessId = await one(
    pool,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', $4, 'Asia/Hebron') RETURNING id`,
    [tenantId, `S6 ${label}`, `s6-${label}-${randomUUID().slice(0, 8)}`, baseCurrency],
  );
  const branchX = await one(pool, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'X', true) RETURNING id`, [businessId]);
  const branchY = await one(pool, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Y', false) RETURNING id`, [businessId]);
  const w1 = await one(pool, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'W1', true) RETURNING id`, [
    businessId,
    branchX,
  ]);
  const w2 = await addWarehouse(pool, businessId, branchY, 'W2');
  const s = { tenantId, businessId };
  await recordBusinessOwner(pool, s, userId);
  const piece = await addTrackedProduct(pool, s, 'piece', 0);
  const piece2 = await addTrackedProduct(pool, s, 'piece', 0);
  const dec2 = await addTrackedProduct(pool, s, 'metre', 2);
  const vp = await addVariantProduct(pool, s, 2);
  const untrackedId = await createProduct(pool, businessId);
  const untrackedVariant = await addMerchantVariant(pool, businessId, untrackedId);
  return {
    tenantId,
    businessId,
    userId,
    branchX,
    branchY,
    w1,
    w2,
    piece,
    piece2,
    dec2,
    variantProduct: { productId: vp.productId, variantIds: [must(vp.variantIds[0]), must(vp.variantIds[1])] },
    untracked: { productId: untrackedId, variantId: untrackedVariant },
  };
}

/** Enter a committed `from → to` rate through the real FX control boundary, effective from `effectiveAt` (an ISO instant). */
export async function stateRate(biz: S3Business, from: string, to: string, rate: string, effectiveAt: string): Promise<string> {
  const r = await enterRate(
    {
      tenantId: biz.tenantId,
      businessId: biz.businessId,
      rateId: rateIdFor(biz.businessId, randomUUID()),
      fromCurrency: from,
      toCurrency: to,
      rate,
      effectiveAt,
    },
    biz.userId,
  );
  expect(r.created, `${from}→${to} ${rate} from ${effectiveAt}`).toBe(true);
  return r.rateId;
}

// ── the seven SQL calls ───────────────────────────────────────────────────

/** One entry-routine call: its arguments in the routine's order and the entries the service posts after it. */
export interface S6Call {
  readonly kind: S6Kind;
  readonly params: readonly unknown[];
  /** The `supplier_*` entries, in `line_no` order; none for a method command. */
  readonly postings: readonly PostingCommand[];
  /** The trace the postings were built under (the command's business transaction id). */
  readonly trace: string;
  /** The builder's `invpl/1` digest (the service's `built.payload.sha256`), when the call was bound by a builder. */
  readonly builtSha256: string | null;
  /** The builder's intent digest, when it has one. */
  readonly intentSha256: string | null;
}

const RETURNING: Readonly<Record<S6Kind, string>> = {
  method_create: 'payment_method_id, replayed, revision, is_active',
  method_update: 'payment_method_id, replayed, revision, is_active',
  method_deactivate: 'payment_method_id, replayed, revision, is_active',
  method_activate: 'payment_method_id, replayed, revision, is_active',
  pay: 'payment_id, allocation_id, line_no, purchase_id, replayed',
  allocate_credit: 'allocation_id, replayed',
  receive_refund: 'refund_id, replayed',
};

const CASTS: Readonly<Record<S6Kind, readonly string[]>> = {
  method_create: ['uuid', 'text', 'uuid', 'boolean', 'integer', 'text', 'text', 'text'],
  method_update: ['uuid', 'integer', 'uuid', 'boolean', 'integer', 'text', 'text', 'text'],
  method_deactivate: ['uuid', 'integer'],
  method_activate: ['uuid', 'integer'],
  pay: [
    'uuid',
    'uuid',
    'uuid',
    'uuid',
    'date',
    'char(3)',
    'bigint',
    'uuid',
    'numeric',
    'text',
    'timestamptz',
    'bigint',
    'text',
    'uuid[]',
    'uuid[]',
    'uuid[]',
    'text[]',
    'bigint[]',
    'bigint[]',
    'bigint[]',
    'bigint[]',
    'bigint[]',
    'bigint[]',
    'bigint[]',
  ],
  allocate_credit: [
    'uuid',
    'uuid',
    'uuid',
    'uuid',
    'date',
    'char(3)',
    'bigint',
    'bigint',
    'bigint',
    'bigint',
    'char(3)',
    'bigint',
    'bigint',
    'bigint',
    'bigint',
    'bigint',
  ],
  receive_refund: [
    'uuid',
    'uuid',
    'uuid',
    'uuid',
    'date',
    'char(3)',
    'bigint',
    'bigint',
    'bigint',
    'bigint',
    'char(3)',
    'bigint',
    'uuid',
    'numeric',
    'text',
    'timestamptz',
    'bigint',
    'bigint',
    'text',
  ],
};

/** The routine name of a kind. */
export function routineName(kind: S6Kind): string {
  return must(S6_ROUTINE_OF[kind].split('(')[0]);
}

/** The SQL of a call. */
export function sqlOf(kind: S6Kind): string {
  const args = CASTS[kind].map((t, i) => `$${i + 1}::${t}`).join(', ');
  return `SELECT ${RETURNING[kind]} FROM ${routineName(kind)}(${args})`;
}

/** The SQL type of each argument of a kind, in the routine's order. */
export function castsOf(kind: S6Kind): readonly string[] {
  return CASTS[kind];
}

/** The eight words `inventory_reason_words` derives from a text (eight NULLs for NULL). */
export function reasonWords(text: string | null): InventoryPayloadField[] {
  if (text === null) return Array.from({ length: 8 }, (): InventoryPayloadField => ({ kind: 'null' }));
  const d = createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
  return Array.from({ length: 8 }, (_, k): InventoryPayloadField => ({ kind: 'integer', value: BigInt(d.readUInt32BE(k * 4)) }));
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`${what} is not a text argument`);
  return v;
};
const optText = (v: unknown, what: string): string | null => (v === null ? null : text(v, what));
const list = (v: unknown, what: string): readonly string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${what} is not a text[] argument`);
  return v.map((x) => String(x));
};
const u = (v: unknown, what: string): InventoryPayloadField => (v === null ? { kind: 'null' } : { kind: 'uuid', value: text(v, what) });
const n = (v: unknown, what: string): InventoryPayloadField => {
  if (typeof v === 'number') return { kind: 'integer', value: v };
  return { kind: 'integer', value: BigInt(text(v, what)) };
};
const c = (v: unknown, what: string): InventoryPayloadField => ({ kind: 'code', value: text(v, what).toLowerCase() });
const d = (v: unknown, what: string): InventoryPayloadField => ({ kind: 'integer', value: yyyymmdd(text(v, what)) });
const r10 = (v: unknown, what: string): InventoryPayloadField => ({ kind: 'integer', value: parseUnitCost(text(v, what)) });
const epoch = (v: unknown, what: string): InventoryPayloadField => ({ kind: 'integer', value: BigInt(Date.parse(text(v, what)) / 1000) });
const b = (v: unknown, what: string): InventoryPayloadField => {
  if (typeof v !== 'boolean') throw new Error(`${what} is not a boolean argument`);
  return { kind: 'boolean', value: v };
};

/**
 * The claimed `invpl/1` stream of a call, built field by field from its
 * ARGUMENTS in A-16 order — exactly what the routine's
 * `inventory_claimed_payload_digest` computes — WITHOUT the builders'
 * semantic refusals, so a tampered argument can be signed as such.
 */
export function claimedFields(call: Pick<S6Call, 'kind' | 'params'>): InventoryPayloadField[] {
  const p = call.params;
  const at = (i: number): unknown => p[i];
  switch (call.kind) {
    case 'method_create':
      return [
        u(at(0), 'id'),
        c(at(1), 'system_type'),
        u(at(2), 'account'),
        b(at(3), 'requires_reference'),
        n(at(4), 'sort_order'),
        ...reasonWords(optText(at(5), 'ar')),
        ...reasonWords(optText(at(6), 'en')),
        ...reasonWords(optText(at(7), 'tr')),
      ];
    case 'method_update':
      return [
        u(at(0), 'id'),
        n(at(1), 'revision'),
        u(at(2), 'account'),
        b(at(3), 'requires_reference'),
        n(at(4), 'sort_order'),
        ...reasonWords(optText(at(5), 'ar')),
        ...reasonWords(optText(at(6), 'en')),
        ...reasonWords(optText(at(7), 'tr')),
      ];
    case 'method_deactivate':
    case 'method_activate':
      return [u(at(0), 'id'), n(at(1), 'revision')];
    case 'pay': {
      const ids = list(at(13), 'allocation ids');
      const fields: InventoryPayloadField[] = [
        u(at(0), 'payment'),
        u(at(1), 'supplier'),
        u(at(2), 'method'),
        u(at(3), 'account'),
        d(at(4), 'date'),
        c(at(5), 'currency'),
        n(at(6), 'amount'),
        u(at(7), 'rate id'),
        r10(at(8), 'rate'),
        c(at(9), 'rate source'),
        epoch(at(10), 'rate at'),
        n(at(11), 'base'),
        ...reasonWords(optText(at(12), 'reference')),
        { kind: 'integer', value: BigInt(ids.length) },
      ];
      const col = (i: number, k: number): string => must(list(at(i), `column ${i}`)[k], `column ${i}[${k}]`);
      for (let k = 0; k < ids.length; k += 1) {
        fields.push(
          u(col(13, k), 'allocation'),
          u(col(14, k), 'purchase'),
          u(col(15, k), 'warehouse'),
          c(col(16, k), 'purchase currency'),
          n(col(17, k), 'payment amount'),
          n(col(18, k), 'payment base'),
          n(col(19, k), 'applied'),
          n(col(20, k), 'released before'),
          n(col(21, k), 'carrying released'),
          n(col(22, k), 'ap dust'),
          n(col(23, k), 'realized'),
        );
      }
      return fields;
    }
    case 'allocate_credit':
      return [
        u(at(0), 'allocation'),
        u(at(1), 'note'),
        u(at(2), 'purchase'),
        u(at(3), 'warehouse'),
        d(at(4), 'date'),
        c(at(5), 'credit currency'),
        n(at(6), 'consumed'),
        n(at(7), 'remaining before'),
        n(at(8), 'credit released'),
        n(at(9), 'credit dust'),
        c(at(10), 'purchase currency'),
        n(at(11), 'applied'),
        n(at(12), 'ap released before'),
        n(at(13), 'ap released'),
        n(at(14), 'ap dust'),
        n(at(15), 'realized'),
      ];
    case 'receive_refund':
      return [
        u(at(0), 'refund'),
        u(at(1), 'note'),
        u(at(2), 'method'),
        u(at(3), 'account'),
        d(at(4), 'date'),
        c(at(5), 'source currency'),
        n(at(6), 'consumed'),
        n(at(7), 'remaining before'),
        n(at(8), 'source released'),
        n(at(9), 'source dust'),
        c(at(10), 'receipt currency'),
        n(at(11), 'receipt amount'),
        u(at(12), 'rate id'),
        r10(at(13), 'rate'),
        c(at(14), 'rate source'),
        epoch(at(15), 'rate at'),
        n(at(16), 'receipt base'),
        n(at(17), 'realized'),
        ...reasonWords(optText(at(18), 'reference')),
      ];
  }
}

type Biz = { readonly tenantId: string; readonly businessId: string };

/** The `invpl/1` digest of a call's arguments in `biz`. */
export function claimedSha256(biz: Biz, call: Pick<S6Call, 'kind' | 'params'>): string {
  return inventoryPayloadSha256(S6_OP_OF[call.kind], biz.tenantId, biz.businessId, claimedFields(call));
}

/**
 * The digest the routine computes over a call's arguments when one of them
 * is NULL where the minter's canonicalizer refuses it: the raw `invpl/1`
 * stream (a NULL field is the single byte 0x00), as
 * `inventory_payload_digest` builds it. The service can never mint this; a
 * test signs it to reach the routine's own shape checks (R-75).
 */
export function rawClaimedSha256(biz: Biz, call: Pick<S6Call, 'kind' | 'params'>): string {
  const line = (f: InventoryPayloadField): Buffer => {
    if (f.kind === 'null') return Buffer.from([0x00, 0x0a]);
    const v = f.kind === 'uuid' ? f.value.toLowerCase() : f.kind === 'boolean' ? (f.value ? 'true' : 'false') : String(f.value);
    return Buffer.from(`${v}\n`, 'utf8');
  };
  const head = Buffer.from(`invpl/1\n${S6_OP_OF[call.kind]}\n${biz.tenantId.toLowerCase()}\n${biz.businessId.toLowerCase()}\n`, 'utf8');
  return createHash('sha256')
    .update(Buffer.concat([head, ...claimedFields(call).map(line)]))
    .digest('hex');
}

/** An honest assertion over the raw stream of `call` (see `rawClaimedSha256`). */
export function s6RawAssertionFor(biz: Biz & { readonly userId: string }, call: S6Call): string {
  return mintTestInventoryAssertion({
    actorUserId: biz.userId,
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    opCode: S6_OP_OF[call.kind],
    payloadSha256: rawClaimedSha256(biz, call),
  });
}

export interface S6RunOptions {
  /** Present exactly this assertion (a replay, a forgery); nothing is minted. `null` presents none. */
  readonly assertion?: string | null;
  /** Mint over this call's arguments instead (a tampered field). */
  readonly mintFor?: Pick<S6Call, 'kind' | 'params'>;
  /** Mint under this operation code instead (a wrong-kind case). */
  readonly op?: InventoryOperationCode;
  /** Mint for this business instead of the calling one. */
  readonly mintBusiness?: Biz;
  /** Run under these scope GUCs instead of the business's own. */
  readonly scope?: Biz;
  /** The business transaction id GUC; the call's own trace by default, `''` for none. */
  readonly trace?: string;
  readonly jti?: string;
  /** Receives the assertion that was presented. */
  readonly onAssertion?: (assertion: string) => void;
  /** Post the call's entries after the routine (default true; a replay posts nothing). */
  readonly post?: boolean;
}

/** Mint the assertion the service would mint for `call` in `biz`, with `o`'s departures. */
export function s6AssertionFor(biz: Biz & { readonly userId: string }, call: S6Call, o: S6RunOptions = {}): string {
  const mintBiz = o.mintBusiness ?? biz;
  return mintTestInventoryAssertion({
    actorUserId: biz.userId,
    tenantId: mintBiz.tenantId,
    businessId: mintBiz.businessId,
    opCode: o.op ?? S6_OP_OF[call.kind],
    payloadSha256: claimedSha256(mintBiz, o.mintFor ?? call),
    ...(o.jti === undefined ? {} : { jti: o.jti }),
  });
}

/** One row of any S6 routine's answer; each routine fills the columns it has. */
export interface S6Row {
  readonly payment_method_id?: string;
  readonly payment_id?: string;
  readonly allocation_id?: string;
  readonly refund_id?: string;
  readonly line_no?: number;
  readonly purchase_id?: string;
  readonly revision?: number;
  readonly is_active?: boolean;
  readonly replayed: boolean;
}

/**
 * The H-1 calling convention in the CALLER's transaction: the scope GUCs,
 * the trace and the carrier, `SET LOCAL ROLE daftar_app`, the routine,
 * `RESET ROLE` — then, unless it answered a replay, the call's entries as
 * `daftar_app` (A-05). On a refusal the role is still daftar_app; callers wrap
 * this in `attempt`, whose ROLLBACK TO SAVEPOINT undoes the role switch.
 */
export async function runS6(c: Queryable, biz: S3Business, call: S6Call, o: S6RunOptions = {}): Promise<S6Row[]> {
  const assertion = o.assertion === undefined ? s6AssertionFor(biz, call, o) : o.assertion;
  if (assertion !== null) o.onAssertion?.(assertion);
  const scope = o.scope ?? biz;
  await c.query(
    `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
            set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
    [scope.tenantId, scope.businessId, assertion ?? '', o.trace ?? call.trace],
  );
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<S6Row>(sqlOf(call.kind), [...call.params]);
  await c.query('RESET ROLE');
  if (o.post !== false && r.rows[0]?.replayed === false) {
    for (const command of call.postings) await postInTx(c, command, biz.userId);
  }
  return r.rows;
}

/** `runS6` inside a savepoint: a refusal leaves the transaction usable. */
export function tryS6(c: Queryable, biz: S3Business, call: S6Call, o: S6RunOptions = {}): Promise<Outcome<S6Row[]>> {
  return attempt(c, () => runS6(c, biz, call, o));
}

// ── the method commands, bound as PaymentMethodService binds them ─────────

export interface MethodNames {
  readonly ar: string | null;
  readonly en: string | null;
  readonly tr: string | null;
}

export interface MethodInput {
  readonly paymentMethodId?: string;
  readonly systemType?: PaymentMethodSystemType;
  readonly postingAccountId: string;
  readonly requiresReference?: boolean;
  readonly sortOrder?: number;
  readonly names?: MethodNames;
}

const DEFAULT_NAMES: MethodNames = { ar: 'نقد', en: 'Cash', tr: null };

/** `payment.create_method`. */
export function methodCreateCall(biz: Biz, input: MethodInput): S6Call {
  const id = input.paymentMethodId ?? randomUUID();
  const names = input.names ?? DEFAULT_NAMES;
  const systemType = input.systemType ?? 'cash';
  const requiresReference = input.requiresReference ?? false;
  const sortOrder = input.sortOrder ?? 10;
  const built = paymentMethodCreatePayload({
    ...biz,
    paymentMethodId: id,
    systemType,
    postingAccountId: input.postingAccountId,
    requiresReference,
    sortOrder,
    names,
  });
  return {
    kind: 'method_create',
    params: [id, systemType, input.postingAccountId, requiresReference, sortOrder, names.ar, names.en, names.tr],
    postings: [],
    trace: randomUUID(),
    builtSha256: built.payload.sha256,
    intentSha256: built.intentSha256,
  };
}

/** `payment.update_method`. */
export function methodUpdateCall(
  biz: Biz,
  paymentMethodId: string,
  expectedRevision: number,
  input: Omit<MethodInput, 'paymentMethodId' | 'systemType'>,
): S6Call {
  const names = input.names ?? DEFAULT_NAMES;
  const requiresReference = input.requiresReference ?? false;
  const sortOrder = input.sortOrder ?? 10;
  const built = paymentMethodUpdatePayload({
    ...biz,
    paymentMethodId,
    expectedRevision,
    postingAccountId: input.postingAccountId,
    requiresReference,
    sortOrder,
    names,
  });
  return {
    kind: 'method_update',
    params: [paymentMethodId, expectedRevision, input.postingAccountId, requiresReference, sortOrder, names.ar, names.en, names.tr],
    postings: [],
    trace: randomUUID(),
    builtSha256: built.payload.sha256,
    intentSha256: built.intentSha256,
  };
}

/** `payment.deactivate_method` / `payment.activate_method`. */
export function methodLifecycleCall(biz: Biz, kind: 'method_deactivate' | 'method_activate', paymentMethodId: string, expectedRevision: number): S6Call {
  const build = kind === 'method_deactivate' ? paymentMethodDeactivatePayload : paymentMethodActivatePayload;
  const built = build({ ...biz, paymentMethodId, expectedRevision });
  return {
    kind,
    params: [paymentMethodId, expectedRevision],
    postings: [],
    trace: randomUUID(),
    builtSha256: built.payload.sha256,
    intentSha256: built.intentSha256,
  };
}

/** Create a method in the caller's transaction and return its id. */
export async function createMethod(c: Queryable, biz: S3Business, input: MethodInput): Promise<string> {
  const call = methodCreateCall(biz, input);
  await runS6(c, biz, call);
  return text(call.params[0], 'method id');
}

/** The stored revision of a method (as the owner). */
export async function methodRevision(q: Queryable, businessId: string, paymentMethodId: string): Promise<number> {
  return must(
    (await q.query<{ revision: number }>(`SELECT revision FROM payment_methods WHERE business_id = $1 AND id = $2`, [businessId, paymentMethodId])).rows[0],
    'method',
  ).revision;
}

// ── the settlement commands, bound as the services bind them ──────────────

interface BusinessState {
  readonly base_currency: string;
  readonly base_exponent: number;
}

async function businessState(q: Queryable, businessId: string): Promise<BusinessState> {
  return must(
    (
      await q.query<BusinessState>(
        `SELECT b.base_currency::text AS base_currency, c.minor_units AS base_exponent FROM businesses b JOIN currencies c ON c.code = b.base_currency WHERE b.id = $1`,
        [businessId],
      )
    ).rows[0],
    'business',
  );
}

async function exponentOf(q: Queryable, currency: string): Promise<number> {
  return must((await q.query<{ e: number }>(`SELECT minor_units AS e FROM currencies WHERE code = $1`, [currency])).rows[0], `currency ${currency}`).e;
}

/** The purchases of a settlement as the service's one-statement read states them (with `O`), as the owner. */
export async function settledPurchaseRows(q: Queryable, businessId: string, purchaseIds: readonly string[]): Promise<PurchaseStateRow[]> {
  const r = await q.query<{ purchases: PurchaseStateRow[] }>(
    `SELECT ${SETTLED_PURCHASES_SQL.replace('%IDS%', '$2')} AS purchases FROM businesses b WHERE b.id = $1`,
    [businessId, purchaseIds],
  );
  return must(r.rows[0]).purchases;
}

/** A method as the service's state read states it, as the owner. */
export async function settlementMethodRow(q: Queryable, businessId: string, paymentMethodId: string): Promise<SettlementMethodRow> {
  const r = await q.query<{ method: SettlementMethodRow | null }>(
    `SELECT ${SETTLEMENT_METHOD_SQL.replace('%METHOD%', '$2')} AS method FROM businesses b WHERE b.id = $1`,
    [businessId, paymentMethodId],
  );
  return must(must(r.rows[0]).method, 'method');
}

/** A note as the service's state read states it, as the owner. */
export async function creditNoteRow(q: Queryable, businessId: string, creditNoteId: string): Promise<CreditNoteStateRow> {
  const r = await q.query<{ note: CreditNoteStateRow | null }>(
    `SELECT ${CREDIT_NOTE_STATE_SQL.replace('%NOTE%', '$2')} AS note FROM businesses b WHERE b.id = $1`,
    [businessId, creditNoteId],
  );
  return must(must(r.rows[0]).note, 'credit note');
}

/** The FX snapshot `readSettlementFx` binds, read as the owner through the same lookup. */
export async function settlementFx(q: Queryable, businessId: string, currency: string, date: string): Promise<SettlementFx> {
  const biz = await businessState(q, businessId);
  if (currency.toUpperCase() === biz.base_currency.toUpperCase()) {
    return { rateId: null, rate: '1.0000000000', rateR10: parseUnitCost('1'), source: 'base', at: new Date(`${date}T00:00:00Z`) };
  }
  const r = must(
    (
      await q.query<{ rate_id: string; rate: string; source: string; effective_at: Date }>(
        `SELECT r.rate_id, r.rate::text AS rate, r.source, r.effective_at
           FROM businesses b
          CROSS JOIN LATERAL accounting_fx_rate_lookup(b.id, $2, b.base_currency, ((($3::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) r
          WHERE b.id = $1`,
        [businessId, currency, date],
      )
    ).rows[0],
    'rate',
  );
  if (r.source !== 'manual' && r.source !== 'base') throw new Error(`unexpected rate source ${r.source}`);
  return { rateId: r.rate_id, rate: r.rate, rateR10: parseUnitCost(r.rate), source: r.source, at: r.effective_at };
}

export interface PayAllocationInput {
  readonly purchaseId: string;
  /** In the payment currency. */
  readonly paymentAmountMinor: bigint;
  /** In the purchase currency; defaults to the payment amount. */
  readonly appliedMinor?: bigint;
  readonly allocationId?: string;
}

export interface PayInput {
  readonly supplierId: string;
  readonly paymentMethodId: string;
  readonly allocations: readonly PayAllocationInput[];
  readonly currency?: string;
  readonly paymentDate?: string;
  readonly reference?: string | null;
  readonly paymentId?: string;
  readonly trace?: string;
}

/**
 * Bind a payment exactly as `SupplierPaymentService` binds it: the
 * purchases with `O`, the method and its account code, the FX snapshot, then
 * the APP's `bindSupplierPayment` (the plan, the payload, one posting per
 * allocation and the routine's arguments).
 */
export async function preparePay(q: Queryable, biz: S3Business, input: PayInput): Promise<S6Call> {
  const state = await businessState(q, biz.businessId);
  const currency = input.currency ?? state.base_currency;
  const paymentDate = input.paymentDate ?? (await today(q));
  const rows = await settledPurchaseRows(
    q,
    biz.businessId,
    input.allocations.map((a) => a.purchaseId),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const methodRow = await settlementMethodRow(q, biz.businessId, input.paymentMethodId);
  const trace = input.trace ?? randomUUID();
  const bound = bindSupplierPayment({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    businessTransactionId: trace,
    paymentId: input.paymentId ?? randomUUID(),
    supplierId: input.supplierId,
    method: {
      paymentMethodId: methodRow.id,
      isActive: methodRow.is_active,
      requiresReference: methodRow.requires_reference,
      postingAccountId: methodRow.posting_account_id,
      postingAccountCode: methodRow.account_code,
    },
    paymentDate,
    currency,
    currencyExponent: await exponentOf(q, currency),
    baseCurrency: state.base_currency,
    baseExponent: state.base_exponent,
    amountMinor: input.allocations.reduce((s, a) => s + a.paymentAmountMinor, 0n),
    reference: input.reference ?? null,
    fx: await settlementFx(q, biz.businessId, currency, paymentDate),
    allocations: input.allocations.map((a) => ({
      allocationId: a.allocationId ?? randomUUID(),
      purchase: settledPurchase(must(byId.get(a.purchaseId), `purchase ${a.purchaseId}`)),
      paymentAmountMinor: a.paymentAmountMinor,
      appliedMinor: a.appliedMinor ?? a.paymentAmountMinor,
    })),
  });
  return {
    kind: 'pay',
    params: bound.params,
    postings: bound.commands,
    trace,
    builtSha256: bound.built.payload.sha256,
    intentSha256: bound.built.intentSha256,
  };
}

export interface AllocateInput {
  readonly creditNoteId: string;
  readonly purchaseId: string;
  readonly consumedMinor: bigint;
  /** Defaults to the consumed amount. */
  readonly appliedMinor?: bigint;
  readonly allocationDate?: string;
  readonly allocationId?: string;
  readonly trace?: string;
}

/** Bind a credit allocation exactly as `SupplierCreditAllocationService` binds it. */
export async function prepareAllocate(q: Queryable, biz: S3Business, input: AllocateInput): Promise<S6Call> {
  const state = await businessState(q, biz.businessId);
  const row = must((await settledPurchaseRows(q, biz.businessId, [input.purchaseId]))[0], 'purchase');
  const purchase = settledPurchase(row);
  const note = await creditNoteRow(q, biz.businessId, input.creditNoteId);
  const allocationId = input.allocationId ?? randomUUID();
  const allocationDate = input.allocationDate ?? (await today(q));
  const trace = input.trace ?? randomUUID();
  const plan = planCreditAllocation({
    purchase: {
      totalTxnMinor: purchase.totalTxnMinor,
      totalBaseMinor: purchase.totalBaseMinor,
      outstandingTxnMinor: purchase.outstandingTxnMinor,
      conversion: { rateR10: parseUnitCost(purchase.rate), txnExponent: purchase.currencyExponent, baseExponent: state.base_exponent },
    },
    note: creditNoteState(note, state.base_exponent),
    sameCurrency: note.currency_code === purchase.currency,
    consumedMinor: input.consumedMinor,
    appliedMinor: input.appliedMinor ?? input.consumedMinor,
  });
  const built = supplierAllocateCreditPayload({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    allocationId,
    creditNoteId: input.creditNoteId,
    purchaseId: input.purchaseId,
    warehouseId: purchase.warehouseId,
    allocationDate,
    creditCurrency: note.currency_code,
    consumedMinor: plan.consumedMinor,
    remainingBeforeMinor: plan.remainingBeforeMinor,
    creditReleasedMinor: plan.creditReleasedMinor,
    creditDustBaseMinor: plan.creditDustBaseMinor,
    purchaseCurrency: purchase.currency,
    appliedMinor: plan.appliedMinor,
    apReleasedBeforeMinor: plan.releasedBeforeMinor,
    apReleasedMinor: plan.carryingReleasedMinor,
    apDustBaseMinor: plan.apDustBaseMinor,
    realizedMinor: plan.realizedMinor,
  });
  const posting = settlementPostingCommand({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceType: SUPPLIER_CREDIT_ALLOCATION_SOURCE,
    sourceId: allocationId,
    entryDate: allocationDate,
    baseCurrency: state.base_currency,
    snapshots: {
      purchase: { currency: purchase.currency, rate: purchase.rate, source: purchase.rateSource, at: purchase.rateAt },
      note: noteSnapshot(note),
    },
    postingAccountCode: null,
    branches: { purchase: purchase.branchId, origin: note.origin_branch_id },
    lines: plan.entryLines,
    businessTransactionId: trace,
  });
  const s = (x: bigint): string => x.toString(10);
  return {
    kind: 'allocate_credit',
    params: [
      allocationId,
      input.creditNoteId,
      input.purchaseId,
      purchase.warehouseId,
      allocationDate,
      note.currency_code,
      s(plan.consumedMinor),
      s(plan.remainingBeforeMinor),
      s(plan.creditReleasedMinor),
      s(plan.creditDustBaseMinor),
      purchase.currency,
      s(plan.appliedMinor),
      s(plan.releasedBeforeMinor),
      s(plan.carryingReleasedMinor),
      s(plan.apDustBaseMinor),
      s(plan.realizedMinor),
    ],
    postings: [posting],
    trace,
    builtSha256: built.payload.sha256,
    intentSha256: built.intentSha256,
  };
}

export interface RefundInput {
  readonly creditNoteId: string;
  readonly paymentMethodId: string;
  readonly consumedMinor: bigint;
  /** Defaults to the note currency. */
  readonly receiptCurrency?: string;
  /** Defaults to the consumed amount. */
  readonly receiptAmountMinor?: bigint;
  readonly refundDate?: string;
  readonly reference?: string | null;
  readonly refundId?: string;
  readonly trace?: string;
}

/** Bind a refund exactly as `SupplierRefundService` binds it. */
export async function prepareRefund(q: Queryable, biz: S3Business, input: RefundInput): Promise<S6Call> {
  const state = await businessState(q, biz.businessId);
  const note = await creditNoteRow(q, biz.businessId, input.creditNoteId);
  const methodRow = await settlementMethodRow(q, biz.businessId, input.paymentMethodId);
  const refundId = input.refundId ?? randomUUID();
  const refundDate = input.refundDate ?? (await today(q));
  const receiptCurrency = input.receiptCurrency ?? note.currency_code;
  const reference = input.reference ?? null;
  const trace = input.trace ?? randomUUID();
  const fx = await settlementFx(q, biz.businessId, receiptCurrency, refundDate);
  const plan = planRefund({
    note: creditNoteState(note, state.base_exponent),
    sameCurrency: receiptCurrency === note.currency_code,
    consumedMinor: input.consumedMinor,
    receiptAmountMinor: input.receiptAmountMinor ?? input.consumedMinor,
    receipt: { rateR10: fx.rateR10, txnExponent: await exponentOf(q, receiptCurrency), baseExponent: state.base_exponent },
  });
  const rateAt = `${fx.at.toISOString().slice(0, 19)}Z`;
  const built = supplierReceiveRefundPayload({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    refundId,
    creditNoteId: input.creditNoteId,
    paymentMethodId: methodRow.id,
    postingAccountId: methodRow.posting_account_id,
    refundDate,
    sourceCurrency: note.currency_code,
    consumedMinor: plan.consumedMinor,
    remainingBeforeMinor: plan.remainingBeforeMinor,
    sourceReleasedMinor: plan.creditReleasedMinor,
    sourceDustBaseMinor: plan.creditDustBaseMinor,
    receiptCurrency,
    receiptAmountMinor: plan.receiptAmountMinor,
    rate: { rateId: fx.rateId, rateR10: fx.rateR10, source: fx.source, rateAtEpochSeconds: BigInt(fx.at.getTime() / 1000) },
    receiptBaseMinor: plan.receiptBaseMinor,
    realizedMinor: plan.realizedMinor,
    reference,
  });
  const posting = settlementPostingCommand({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceType: SUPPLIER_REFUND_SOURCE,
    sourceId: refundId,
    entryDate: refundDate,
    baseCurrency: state.base_currency,
    snapshots: { note: noteSnapshot(note), receipt: { currency: receiptCurrency, rate: fx.rate, source: fx.source, at: fx.at } },
    postingAccountCode: methodRow.account_code,
    branches: { purchase: null, origin: note.origin_branch_id },
    lines: plan.entryLines,
    businessTransactionId: trace,
  });
  const s = (x: bigint): string => x.toString(10);
  return {
    kind: 'receive_refund',
    params: [
      refundId,
      input.creditNoteId,
      methodRow.id,
      methodRow.posting_account_id,
      refundDate,
      note.currency_code,
      s(plan.consumedMinor),
      s(plan.remainingBeforeMinor),
      s(plan.creditReleasedMinor),
      s(plan.creditDustBaseMinor),
      receiptCurrency,
      s(plan.receiptAmountMinor),
      fx.rateId,
      fx.rate,
      fx.source,
      rateAt,
      s(plan.receiptBaseMinor),
      s(plan.realizedMinor),
      reference,
    ],
    postings: [posting],
    trace,
    builtSha256: built.payload.sha256,
    intentSha256: built.intentSha256,
  };
}

/** The accounting assertion the service mints for one posting (the real minting function). */
export function mintSettlementPosting(command: PostingCommand, actorUserId: string): string {
  return mintDomainPostingAssertion(testMinter, command, actorUserId);
}

/** A copy of `call` with argument `i` replaced (a tamper, a forged bound value). */
export function withParam(call: S6Call, i: number, value: unknown): S6Call {
  const params = [...call.params];
  params[i] = value;
  return { ...call, params };
}

/** A copy of `call` with element `k` of the array argument `i` replaced. */
export function withElement(call: S6Call, i: number, k: number, value: string): S6Call {
  const col = [...list(call.params[i], `argument ${i}`)];
  col[k] = value;
  return withParam(call, i, col);
}

// ── reads and counters (as the owner) ─────────────────────────────────────

/** `s4Counts` plus every S5 and S6 table and a digest of every row S6 may UPDATE (methods, names, credit notes). */
export async function s6Counts(q: Queryable, businessId: string): Promise<Counts> {
  const s4 = await s4Counts(q, businessId);
  const tables = [...S5_TABLES, ...S5_BRIDGES, 'accounting_reversals', ...S6_TABLES];
  const r = await q.query<Record<string, number | string>>(
    `SELECT ${tables.map((t) => `(SELECT count(*)::int FROM ${t} WHERE business_id = $1) AS ${t}`).join(', ')},
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, remaining_amount_minor, remaining_carrying_base_amount_minor), ',' ORDER BY id)), '')
               FROM supplier_credit_notes WHERE business_id = $1) AS credit_notes_state,
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, posting_account_id, is_active, requires_reference, sort_order, revision, last_intent_sha256), ',' ORDER BY id)), '')
               FROM payment_methods WHERE business_id = $1) AS payment_methods_state,
            (SELECT coalesce(md5(string_agg(concat_ws('|', payment_method_id, locale, display_name), ',' ORDER BY payment_method_id, locale)), '')
               FROM payment_method_names WHERE business_id = $1) AS payment_method_names_state`,
    [businessId],
  );
  return { ...s4, ...must(r.rows[0], 's6 counts') };
}

/** A digest of every journal line of the business: posted lines never change (T-04). */
export async function journalLinesDigest(q: Queryable, businessId: string): Promise<string> {
  return must(
    (
      await q.query<{ d: string }>(
        `SELECT coalesce(md5(string_agg(row_to_json(l)::text, ',' ORDER BY l.journal_entry_id, l.line_no)), '') AS d FROM journal_lines l WHERE l.business_id = $1`,
        [businessId],
      )
    ).rows[0],
  ).d;
}

export interface SettlementLine {
  readonly systemKey: string | null;
  readonly accountId: string;
  readonly side: 'D' | 'C';
  readonly currency: string;
  readonly txnAmountMinor: string;
  readonly baseAmountMinor: string;
  readonly rate: string;
  readonly rateSource: string;
  readonly rateAt: string;
  readonly warehouseId: string | null;
  readonly branchId: string | null;
}

/** The entry posted under `(sourceType, sourceId)` with its lines, or null. */
export async function settlementEntry(
  q: Queryable,
  businessId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ readonly id: string; readonly entryDate: string; readonly lines: SettlementLine[] } | null> {
  const e = (
    await q.query<{ id: string; entry_date: string }>(
      `SELECT id::text, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM journal_entries WHERE business_id = $1 AND source_type = $2 AND source_id = $3`,
      [businessId, sourceType, sourceId],
    )
  ).rows[0];
  if (e === undefined) return null;
  const lines = (
    await q.query<{
      system_key: string | null;
      account_id: string;
      debit: string;
      credit: string;
      txn_currency: string;
      txn_amount: string;
      fx_rate: string;
      fx_rate_source: string;
      fx_rate_at: Date;
      warehouse_id: string | null;
      branch_id: string | null;
    }>(
      `SELECT a.system_key, l.account_id::text, l.debit_minor::text AS debit, l.credit_minor::text AS credit, l.txn_currency::text AS txn_currency,
              l.txn_amount_minor::text AS txn_amount, l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
              l.warehouse_id::text, l.branch_id::text
         FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
      [businessId, e.id],
    )
  ).rows;
  return {
    id: e.id,
    entryDate: e.entry_date,
    lines: lines.map((l) => ({
      systemKey: l.system_key,
      accountId: l.account_id,
      side: BigInt(l.debit) > 0n ? 'D' : 'C',
      currency: l.txn_currency,
      txnAmountMinor: l.txn_amount,
      baseAmountMinor: BigInt(l.debit) > 0n ? l.debit : l.credit,
      rate: l.fx_rate,
      rateSource: l.fx_rate_source,
      rateAt: l.fx_rate_at.toISOString(),
      warehouseId: l.warehouse_id,
      branchId: l.branch_id,
    })),
  };
}

/**
 * The ledger AP of one purchase (credit − debit), over its entry, its
 * returns' entries, its Phase 2 reversal and its payment and credit
 * allocations' entries (A-18). The txn figure reads only lines in the
 * purchase currency; base-currency dust lines move base only.
 */
export async function settlementLedgerAp(q: Queryable, businessId: string, purchaseId: string): Promise<{ base: bigint; txn: bigint }> {
  const r = must(
    (
      await q.query<{ base: string; txn: string }>(
        `WITH e AS (
           SELECT pb.journal_entry_id AS id FROM accounting_source_bindings pb
            WHERE pb.business_id = $1 AND pb.source_type = 'purchase' AND pb.source_id = $2
           UNION ALL
           SELECT rb.journal_entry_id FROM supplier_returns r
             JOIN accounting_source_bindings rb ON rb.business_id = r.business_id AND rb.source_type = 'supplier_return' AND rb.source_id = r.id
            WHERE r.business_id = $1 AND r.purchase_id = $2
           UNION ALL
           SELECT ar.journal_entry_id FROM accounting_reversals ar
             JOIN accounting_source_bindings pb ON pb.business_id = ar.business_id AND pb.journal_entry_id = ar.original_entry_id
            WHERE ar.business_id = $1 AND pb.source_type = 'purchase' AND pb.source_id = $2
           UNION ALL
           SELECT ab.journal_entry_id FROM supplier_payment_allocations a
             JOIN accounting_source_bindings ab ON ab.business_id = a.business_id AND ab.source_type = 'supplier_payment' AND ab.source_id = a.id
            WHERE a.business_id = $1 AND a.purchase_id = $2
           UNION ALL
           SELECT cb.journal_entry_id FROM supplier_credit_allocations ca
             JOIN accounting_source_bindings cb ON cb.business_id = ca.business_id AND cb.source_type = 'supplier_credit_allocation' AND cb.source_id = ca.id
            WHERE ca.business_id = $1 AND ca.purchase_id = $2)
         SELECT coalesce(sum(l.credit_minor - l.debit_minor), 0)::text AS base,
                coalesce(sum(CASE WHEN l.txn_currency = p.currency_code
                                  THEN CASE WHEN l.credit_minor > 0 THEN l.txn_amount_minor ELSE -l.txn_amount_minor END END), 0)::text AS txn
           FROM e JOIN journal_lines l ON l.business_id = $1 AND l.journal_entry_id = e.id
           JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id AND a.system_key = 'accounts_payable'
           JOIN purchases p ON p.business_id = $1 AND p.id = $2`,
        [businessId, purchaseId],
      )
    ).rows[0],
  );
  return { base: BigInt(r.base), txn: BigInt(r.txn) };
}

/** `purchase_ap_outstanding` and the purchase's `T`, `B`, as the owner reads them. */
export async function outstandingOf(q: Queryable, businessId: string, purchaseId: string): Promise<{ o: bigint; t: bigint; b: bigint }> {
  const r = must(
    (
      await q.query<{ o: string; t: string; b: string }>(
        `SELECT purchase_ap_outstanding(business_id, id)::text AS o, total_txn_minor::text AS t, total_base_minor::text AS b FROM purchases WHERE business_id = $1 AND id = $2`,
        [businessId, purchaseId],
      )
    ).rows[0],
    'purchase',
  );
  return { o: BigInt(r.o), t: BigInt(r.t), b: BigInt(r.b) };
}

/** A note's stored remaining pair and originals, as the owner reads them. */
export async function noteOf(
  q: Queryable,
  businessId: string,
  creditNoteId: string,
): Promise<{ original: bigint; originalCarrying: bigint; remaining: bigint; remainingCarrying: bigint }> {
  const r = must(
    (
      await q.query<{ oa: string; ob: string; r: string; rb: string }>(
        `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob, remaining_amount_minor::text AS r,
                remaining_carrying_base_amount_minor::text AS rb
           FROM supplier_credit_notes WHERE business_id = $1 AND id = $2`,
        [businessId, creditNoteId],
      )
    ).rows[0],
    'credit note',
  );
  return { original: BigInt(r.oa), originalCarrying: BigInt(r.ob), remaining: BigInt(r.r), remainingCarrying: BigInt(r.rb) };
}

/** The note a return created, if any. */
export async function creditNoteIdOf(q: Queryable, businessId: string, returnId: string): Promise<string | null> {
  const r = await q.query<{ id: string }>(`SELECT id::text FROM supplier_credit_notes WHERE business_id = $1 AND supplier_return_id = $2`, [
    businessId,
    returnId,
  ]);
  return r.rows[0]?.id ?? null;
}

/** Every line of every S6 entry of the business, by the account's system key (T-06: never 6100/6200). */
export async function s6SystemKeys(q: Queryable, businessId: string): Promise<string[]> {
  const r = await q.query<{ k: string | null }>(
    `SELECT DISTINCT a.system_key AS k FROM journal_entries e
       JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE e.business_id = $1 AND e.source_type = ANY($2::text[])`,
    [businessId, [...S6_SOURCE_TYPES]],
  );
  return r.rows.map((x) => x.k ?? '(custom)').sort();
}

// ── the shared vectors (§4.1, T-07) ───────────────────────────────────────

/** One primitive of a vector step: the SQL arithmetic function, its arguments and the package's answer. */
export interface VectorPrimitive {
  readonly fn: 'supplier_convert_base' | 'supplier_ap_release' | 'supplier_credit_remaining_carrying';
  readonly args: readonly (string | number)[];
  readonly result: string;
}

/** One A-05 line of a vector step, amounts as decimal text. */
export interface VectorEntryLine {
  readonly account: string;
  readonly side: 'D' | 'C';
  readonly currency: 'purchase' | 'note' | 'payment' | 'receipt' | 'base';
  readonly txnAmountMinor: string;
  readonly baseAmountMinor: string;
  readonly dimension: 'purchase' | 'origin';
}

export interface VectorStep {
  readonly step: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly plan: Readonly<Record<string, string>> | null;
  readonly entry: readonly VectorEntryLine[] | null;
  readonly primitives: readonly VectorPrimitive[];
  readonly after: Readonly<Record<string, string>>;
}

export interface SettlementVectorCase {
  readonly id: string;
  readonly why: string;
  readonly base: { readonly code: string; readonly exponent: number };
  readonly steps: readonly VectorStep[];
}

/** `packages/inventory/vectors/supplier-settlement-vectors.json`, the package's own vectors. */
export function settlementVectors(): readonly SettlementVectorCase[] {
  const file = join(__dirname, '../../packages/inventory/vectors/supplier-settlement-vectors.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { cases: SettlementVectorCase[] }).cases;
}

export function settlementVector(id: string): SettlementVectorCase {
  return must(
    settlementVectors().find((v) => v.id === id),
    `vector ${id}`,
  );
}

/** A line in concrete terms: the account (a system key, or `posting_account`), side, currency code, amounts and branch. */
export interface ConcreteLine {
  readonly account: string;
  readonly side: 'D' | 'C';
  readonly currency: string;
  readonly txn: string;
  readonly base: string;
  readonly branchId: string | null;
}

export interface LineContext {
  /** Currency codes of the vector's currency roles. */
  readonly currencies: Readonly<Partial<Record<VectorEntryLine['currency'], string>>>;
  /** Branch of the (target) purchase and of the note's origin purchase. */
  readonly branches: { readonly purchase: string | null; readonly origin: string | null };
}

/** A vector's entry lines in concrete terms. */
export function vectorLines(lines: readonly VectorEntryLine[], ctx: LineContext): ConcreteLine[] {
  return lines.map((l) => ({
    account: l.account,
    side: l.side,
    currency: must(ctx.currencies[l.currency], `the ${l.currency} currency`),
    txn: l.txnAmountMinor,
    base: l.baseAmountMinor,
    branchId: ctx.branches[l.dimension],
  }));
}

/** A posted entry's lines in the same terms: the method's account is `posting_account`. */
export function concreteLines(lines: readonly SettlementLine[], postingAccountId: string | null): ConcreteLine[] {
  return lines.map((l) => ({
    account: l.accountId === postingAccountId ? 'posting_account' : must(l.systemKey, `the system key of ${l.accountId}`),
    side: l.side,
    currency: l.currency,
    txn: l.txnAmountMinor,
    base: l.baseAmountMinor,
    branchId: l.branchId,
  }));
}

const PRIMITIVE_CASTS: Readonly<Record<VectorPrimitive['fn'], readonly string[]>> = {
  supplier_convert_base: ['bigint', 'numeric', 'integer', 'integer'],
  supplier_ap_release: ['bigint', 'bigint', 'bigint', 'bigint'],
  supplier_credit_remaining_carrying: ['bigint', 'bigint', 'bigint'],
};

/** Every primitive of `v`, evaluated by the SQL arithmetic functions (as the owner). */
export async function sqlPrimitives(q: Queryable, v: SettlementVectorCase): Promise<{ call: string; expected: string; actual: string }[]> {
  const out: { call: string; expected: string; actual: string }[] = [];
  for (const step of v.steps) {
    for (const p of step.primitives) {
      const sql = `SELECT ${p.fn}(${PRIMITIVE_CASTS[p.fn].map((cast, i) => `$${i + 1}::${cast}`).join(', ')})::text AS r`;
      const r = must(
        (
          await q.query<{ r: string }>(
            sql,
            p.args.map((a) => String(a)),
          )
        ).rows[0],
      );
      out.push({ call: `${p.fn}(${p.args.join(', ')})`, expected: p.result, actual: r.r });
    }
  }
  return out;
}

// ── the SQL world: committed setups ───────────────────────────────────────

/** BEGIN on a fresh owner connection, run, COMMIT (ROLLBACK and rethrow on a refusal). */
export async function committed<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const value = await fn(c);
    await c.query('COMMIT');
    return value;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/**
 * Run every pending deferred check NOW, as a COMMIT would, and keep the
 * transaction open (later statements are deferred again). A refusal throws.
 */
export async function flushDeferred(c: Queryable): Promise<void> {
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  await c.query('SET CONSTRAINTS ALL DEFERRED');
}

/** Pay every open purchase amount of `purchaseId` with `paymentMethodId`, in the purchase currency, in the caller's transaction. */
export async function payInFull(c: Queryable, biz: S3Business, purchaseId: string, supplierId: string, paymentMethodId: string): Promise<S6Call> {
  const o = await outstandingOf(c, biz.businessId, purchaseId);
  const currency = must(
    (await c.query<{ c: string }>(`SELECT currency_code::text AS c FROM purchases WHERE business_id = $1 AND id = $2`, [biz.businessId, purchaseId])).rows[0],
  ).c;
  const call = await preparePay(c, biz, { supplierId, paymentMethodId, currency, allocations: [{ purchaseId, paymentAmountMinor: o.o }] });
  await runS6(c, biz, call);
  return call;
}

/**
 * §5 `returnToCredit`, in SQL: a received purchase of `qty` pieces at
 * `unitPriceMinor`, paid in full through `supplier_pay`, then `returnQty`
 * returned through `purchase_return` — which, AP being settled, issues a real
 * supplier credit note. In the caller's transaction.
 */
export async function sqlReturnToCredit(
  c: Queryable,
  biz: S3Business,
  paymentMethodId: string,
  o: ReceiveOptions & { readonly qty?: string; readonly unitPriceMinor?: string; readonly returnQty?: string } = {},
): Promise<{ readonly purchase: ReceivedPurchase; readonly creditNoteId: string; readonly returnId: string }> {
  const purchase = await receivedPurchase(c, biz, [{ variantId: biz.piece.variantId, qty: o.qty ?? '2', unitPriceMinor: o.unitPriceMinor ?? '1000' }], o);
  await payInFull(c, biz, purchase.purchaseId, purchase.supplierId, paymentMethodId);
  const ret = await returnGoods(c, biz, purchase.purchaseId, { lines: [{ purchaseLineId: must(purchase.lines[0]).lineId, qty: o.returnQty ?? '1' }] });
  const returnId = ret.prepared.cmd.returnId;
  // The return is its own command: its deferred guards judge the note as issued, so they
  // run now, as its COMMIT would, before anything in this transaction consumes the note.
  await flushDeferred(c);
  return { purchase, creditNoteId: must(await creditNoteIdOf(c, biz.businessId, returnId), 'the return after a full payment issues a credit note'), returnId };
}

// ── concurrency (§5 settleConcurrently) ───────────────────────────────────

/**
 * Start `n` runs together behind one barrier and settle each: every run
 * begins only once all have been created, so their database work overlaps.
 */
export async function settleConcurrently<T>(n: number, fn: (i: number) => Promise<T>): Promise<Outcome<T>[]> {
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs = Array.from({ length: n }, (_, i) => settle(async () => (await barrier.then(() => fn(i))) as T));
  release();
  return Promise.all(runs);
}

// ── the HTTP world ─────────────────────────────────────────────────────────

/** A business onboarded through the real API by `owner`, of the S3 shape, with the features the S6 suites need. */
export async function grantS6Features(biz: S3Business, owner: HttpActor): Promise<void> {
  await grantFeature(biz.businessId, owner.userId, 'CUSTOM_ROLES');
  await raiseLimit(biz.businessId, owner.userId, 'MAX_USERS', 20);
}

export interface HttpPurchase {
  readonly purchaseId: string;
  readonly supplierId: string;
  readonly lineIds: readonly string[];
  readonly warehouseId: string;
  readonly documentDate: string;
  readonly currency: string;
}

/** A supplier made by `by` through the API. */
export async function httpSupplier(t: TestApp, by: HttpActor, biz: S3Business): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .post('/v1/suppliers')
    .set(asMember(by, biz.businessId))
    .send({ supplierId: id, name: `Supplier ${id.slice(0, 6)}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

export interface HttpPurchaseInput {
  readonly supplierId?: string;
  readonly warehouseId?: string;
  readonly currency?: string;
  readonly documentDate?: string;
  /** Major-unit prices, S4 draft shape. Default: 4 pieces at 12.50. */
  readonly lines?: readonly { readonly productId: string; readonly quantity: string; readonly unitPrice: string }[];
}

/** A drafted purchase through the API (revision 1). */
export async function httpDraft(t: TestApp, by: HttpActor, biz: S3Business, input: HttpPurchaseInput = {}): Promise<HttpPurchase> {
  const purchaseId = randomUUID();
  const supplierId = input.supplierId ?? (await httpSupplier(t, by, biz));
  const warehouseId = input.warehouseId ?? biz.w1;
  const currency = input.currency ?? 'ILS';
  const documentDate = input.documentDate ?? (await today());
  const lines = (input.lines ?? [{ productId: biz.piece.productId, quantity: '4', unitPrice: '12.50' }]).map((l) => ({ lineId: randomUUID(), ...l }));
  const d = await t.request
    .put(`/v1/purchases/${purchaseId}`)
    .set(asMember(by, biz.businessId))
    .send({ expectedRevision: 0, supplierId, warehouseId, currency, documentDate, lines, landedCosts: [] });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  return { purchaseId, supplierId, lineIds: lines.map((l) => l.lineId), warehouseId, documentDate, currency };
}

/** A received purchase through the API. */
export async function httpReceived(t: TestApp, by: HttpActor, biz: S3Business, input: HttpPurchaseInput = {}): Promise<HttpPurchase> {
  const p = await httpDraft(t, by, biz, input);
  const r = await t.request.post(`/v1/purchases/${p.purchaseId}/receive`).set(asMember(by, biz.businessId)).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return p;
}

export interface HttpMethodInput {
  readonly systemType?: PaymentMethodSystemType;
  readonly requiresReference?: boolean;
  readonly sortOrder?: number;
  readonly names?: { readonly ar?: string | null; readonly en?: string | null; readonly tr?: string | null };
}

/** The create body of a method posting to `postingAccountId`. */
export function methodBody(postingAccountId: string, input: HttpMethodInput = {}): Record<string, unknown> {
  return {
    paymentMethodId: randomUUID(),
    systemType: input.systemType ?? 'cash',
    postingAccountId,
    requiresReference: input.requiresReference ?? false,
    sortOrder: input.sortOrder ?? 10,
    names: input.names ?? { en: 'Cash drawer', ar: 'الصندوق' },
  };
}

/** A method created by `by` through the API. */
export async function httpMethod(t: TestApp, by: HttpActor, biz: S3Business, postingAccountId: string, input: HttpMethodInput = {}): Promise<string> {
  const body = methodBody(postingAccountId, input);
  const r = await t.request.post('/v1/payment-methods').set(asMember(by, biz.businessId)).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(body.paymentMethodId);
}

export interface HttpPayAllocation {
  readonly purchaseId: string;
  readonly paymentAmountMinor: string;
  readonly purchaseAmountAppliedMinor?: string;
}

/** A payment body. */
export function payBody(
  supplierId: string,
  paymentMethodId: string,
  paymentDate: string,
  allocations: readonly HttpPayAllocation[],
  o: { readonly currencyCode?: string; readonly reference?: string | null } = {},
): Record<string, unknown> {
  return {
    paymentId: randomUUID(),
    supplierId,
    paymentMethodId,
    currencyCode: o.currencyCode ?? 'ILS',
    amountMinor: allocations.reduce((s, a) => s + BigInt(a.paymentAmountMinor), 0n).toString(10),
    paymentDate,
    ...(o.reference === undefined ? {} : { reference: o.reference }),
    allocations: allocations.map((a) => ({
      allocationId: randomUUID(),
      purchaseId: a.purchaseId,
      paymentAmountMinor: a.paymentAmountMinor,
      purchaseAmountAppliedMinor: a.purchaseAmountAppliedMinor ?? a.paymentAmountMinor,
    })),
  };
}

/** POST a payment; asserts nothing. */
export function httpPay(t: TestApp, by: HttpActor, biz: S3Business, body: Record<string, unknown>): Promise<Response> {
  return t.request.post('/v1/supplier-payments').set(asMember(by, biz.businessId)).send(body);
}

/** A credit allocation body. */
export function allocateBody(
  creditNoteId: string,
  purchaseId: string,
  allocationDate: string,
  creditAmountMinor: string,
  applied?: string,
): Record<string, unknown> {
  return { allocationId: randomUUID(), creditNoteId, purchaseId, allocationDate, creditAmountMinor, purchaseAmountAppliedMinor: applied ?? creditAmountMinor };
}

/** A refund body. */
export function refundBody(
  creditNoteId: string,
  paymentMethodId: string,
  refundDate: string,
  creditAmountMinor: string,
  o: { readonly receiptCurrencyCode?: string; readonly receiptAmountMinor?: string; readonly reference?: string | null } = {},
): Record<string, unknown> {
  return {
    refundId: randomUUID(),
    creditNoteId,
    paymentMethodId,
    refundDate,
    creditAmountMinor,
    receiptCurrencyCode: o.receiptCurrencyCode ?? 'ILS',
    receiptAmountMinor: o.receiptAmountMinor ?? creditAmountMinor,
    ...(o.reference === undefined ? {} : { reference: o.reference }),
  };
}

/** Return `quantity` of purchase line 0 through the API; the stored answer. */
export async function httpReturn(
  t: TestApp,
  by: HttpActor,
  biz: S3Business,
  p: HttpPurchase,
  quantity: string,
  lineIndex = 0,
): Promise<Record<string, unknown>> {
  const r = await t.request
    .post(`/v1/purchases/${p.purchaseId}/returns`)
    .set(asMember(by, biz.businessId))
    .send({
      returnId: randomUUID(),
      warehouseId: p.warehouseId,
      documentDate: await today(),
      lines: [{ lineId: randomUUID(), purchaseLineId: must(p.lineIds[lineIndex]), quantity }],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Record<string, unknown>;
}

/**
 * §5 `returnToCredit`: a received purchase paid IN FULL through the API, then
 * a return of `quantity` — which, AP being settled, produces a real supplier
 * credit note (no fixture). Returns the purchase, the note id and the method.
 */
export async function returnToCredit(
  t: TestApp,
  by: HttpActor,
  biz: S3Business,
  paymentMethodId: string,
  input: HttpPurchaseInput & { readonly quantity?: string } = {},
): Promise<{ readonly purchase: HttpPurchase; readonly creditNoteId: string; readonly returnId: string }> {
  const purchase = await httpReceived(t, by, biz, input);
  const o = await outstandingOf(ownerPool(), biz.businessId, purchase.purchaseId);
  const paid = await httpPay(
    t,
    by,
    biz,
    payBody(purchase.supplierId, paymentMethodId, purchase.documentDate, [{ purchaseId: purchase.purchaseId, paymentAmountMinor: o.o.toString(10) }], {
      currencyCode: purchase.currency,
    }),
  );
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const ret = await httpReturn(t, by, biz, purchase, input.quantity ?? '1');
  const returnId = String(ret.returnId);
  const creditNoteId = must(await creditNoteIdOf(ownerPool(), biz.businessId, returnId), 'the return after a full payment issues a credit note');
  return { purchase, creditNoteId, returnId };
}

/**
 * The stable code of a package refusal (`InventoryError`), read structurally:
 * the application and the suites may load the package through two module paths.
 */
export async function bindingRefusal(bind: () => Promise<unknown>): Promise<string> {
  try {
    await bind();
  } catch (e) {
    if (e instanceof Error && 'code' in e && typeof e.code === 'string') return e.code;
    throw e;
  }
  return 'accepted';
}

/** The error code a refused response carries, whichever table classified it. */
export function refusalCode(res: Response): string | undefined {
  const details = (res.body as { error?: { details?: Record<string, unknown>; code?: string } }).error?.details;
  const code = details?.purchasingCode ?? details?.paymentMethodCode ?? details?.inventoryCode ?? details?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Assert a refused response: its status and its stable code. */
export function expectRefusal(res: Response, status: number, code: string, why = ''): void {
  expect({ status: res.status, code: refusalCode(res) }, `${why} ${JSON.stringify(res.body)}`).toEqual({ status, code });
}

/** `parseMinor` re-exported for the suites' bigint reads. */
export { parseMinor };
