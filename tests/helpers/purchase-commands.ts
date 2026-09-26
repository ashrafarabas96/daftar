/**
 * P3-S4 — THE SUPPLIER AND PURCHASE COMMAND HARNESS (docs/PHASE_3_S4_CONTRACT.md
 * §5, §6; the S3 harness `inventory-commands.ts` / `inventory-posting.ts`
 * extended to the seven S4 entry routines).
 *
 * Every helper drives the REAL entry routines through their real boundary: a
 * real `invctl/1` assertion minted with the test key over the `invpl/1`
 * payload the `@daftar/inventory` builders produce, carried in
 * `app.inventory_assertion`, the routine executed as `daftar_app`. A receipt
 * is prepared exactly as `PurchaseReceiptService` prepares it — A-13 from the
 * stored draft (`lineTotals`), the one conversion (`convertToBaseMinor`), the
 * base shares (`baseShares`), the coverage plan over the open layers and the
 * stock levels (`planCoverage`) — and its entries are built by the APP's
 * builders (`purchasePostingCommand`, `catchUpPostingCommand`), minted by the
 * real `mintDomainPostingAssertion` and written by the one generic primitive
 * `accounting_post_entry`, as `daftar_app`, in the SAME transaction: the
 * seam-2 composition the service uses (A-06).
 *
 * Negative tests depart from the honest command in exactly one way at a time
 * (`RunOptions`): mint over another command (`mintFor`), under another
 * operation code (`op`), present another assertion (`assertion`), run under
 * another scope (`scope`), carry another trace, or digest the claimed
 * arguments field by field (`raw`) to reach the routine's own refusal of an
 * input the builders would never sign.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { convertToBaseMinor, mintDomainPostingAssertion, type PostingCommand } from '@daftar/accounting';
import {
  DOMESTIC_RATE_R10,
  baseShares,
  formatQuantity,
  formatUnitCost,
  inventoryPayloadSha256,
  lineTotals,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  planCoverage,
  purchaseCancelPayload,
  purchaseDraftPayload,
  purchaseReceivePayload,
  supplierArchivePayload,
  supplierCreatePayload,
  supplierReactivatePayload,
  supplierUpdatePayload,
  toC10,
  toQ4,
  yyyymmdd,
  type CoveragePlan,
  type DeficitLayer,
  type InventoryOperationCode,
  type InventoryPayloadField,
  type LandedCostMode,
  type MovementPayload,
  type PurchaseTotals,
  type StockState,
} from '../../packages/inventory/src';
import { serializePostingLines } from '../../apps/api/src/modules/accounting/accounting-payload';
import { catchUpPostingCommand, purchasePostingCommand } from '../../apps/api/src/modules/purchasing/purchase-posting';
import { attempt, must, stockState, today, type Outcome, type Queryable, type S3Business } from './inventory-commands';
import { homeBranch, testMinter } from './inventory-posting';
import { mintTestInventoryAssertion, ownerPool } from './test-app';

// ── the seven commands ─────────────────────────────────────────────────────

/** A supplier's five texts, already normalized (trimmed, NULL when empty). */
export interface SupplierFields {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxIdentifier: string | null;
  readonly notes: string | null;
}

export interface SupplierCreateCommand {
  readonly kind: 'supplier_create';
  readonly supplierId: string;
  readonly fields: SupplierFields;
}

export interface SupplierUpdateCommand {
  readonly kind: 'supplier_update';
  readonly supplierId: string;
  readonly expectedRevision: number;
  readonly fields: SupplierFields;
}

export interface SupplierLifecycleCommand {
  readonly kind: 'supplier_archive' | 'supplier_reactivate';
  readonly supplierId: string;
  readonly expectedRevision: number;
}

export interface DraftLine {
  readonly lineId: string;
  readonly variantId: string;
  /** Decimal text, as the request states it. */
  readonly qty: string;
  /** A unit price in txn MINOR units, up to ten fraction digits (the routine's `unit_price_txn_minor`). */
  readonly unitPriceMinor: string;
  readonly discountMinor: bigint;
}

export interface DraftLandedCost {
  readonly landedCostId: string;
  readonly mode: LandedCostMode;
  readonly amountMinor: bigint;
  readonly description: string | null;
  /** `manual`: one amount per line in line order; `by_value`: null. */
  readonly allocations: readonly bigint[] | null;
}

export interface DraftCommand {
  readonly kind: 'purchase_draft';
  readonly purchaseId: string;
  readonly expectedRevision: number;
  readonly supplierId: string;
  readonly warehouseId: string;
  readonly previousWarehouseId: string | null;
  readonly currency: string;
  readonly documentDate: string;
  readonly supplierReference: string | null;
  readonly notes: string | null;
  readonly taxMinor: bigint;
  readonly lines: readonly DraftLine[];
  readonly landedCosts: readonly DraftLandedCost[];
}

export interface CancelCommand {
  readonly kind: 'purchase_cancel';
  readonly purchaseId: string;
  readonly warehouseId: string;
  readonly draftRevision: number;
}

export interface ReceiveRate {
  readonly rateId: string | null;
  /** `NUMERIC(20,10)` text. */
  readonly rate: string;
  readonly source: 'base' | 'manual';
  /** Second precision. */
  readonly at: Date;
}

export interface ReceiveLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  readonly baseShareMinor: bigint;
  readonly coveredQ4: bigint;
  readonly catchUpMinor: bigint;
}

export interface ReceiveCommand {
  readonly kind: 'purchase_receive';
  readonly purchaseId: string;
  readonly warehouseId: string;
  readonly draftRevision: number;
  readonly supplierId: string;
  readonly supplierRevision: number;
  readonly documentDate: string;
  readonly currency: string;
  readonly rate: ReceiveRate;
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  readonly coverageAdjustmentId: string | null;
  readonly lines: readonly ReceiveLine[];
}

export type S4Command = SupplierCreateCommand | SupplierUpdateCommand | SupplierLifecycleCommand | DraftCommand | CancelCommand | ReceiveCommand;
export type S4Kind = S4Command['kind'];

export const S4_KINDS: readonly S4Kind[] = [
  'supplier_create',
  'supplier_update',
  'supplier_archive',
  'supplier_reactivate',
  'purchase_draft',
  'purchase_cancel',
  'purchase_receive',
];

export const OP_OF: Readonly<Record<S4Kind, InventoryOperationCode>> = {
  supplier_create: 'supplier.create',
  supplier_update: 'supplier.update',
  supplier_archive: 'supplier.archive',
  supplier_reactivate: 'supplier.reactivate',
  purchase_draft: 'purchase.draft',
  purchase_cancel: 'purchase.cancel',
  purchase_receive: 'purchase.receive',
};

/** The seven entry routines with their exact signatures (§2.4). */
export const ROUTINE_OF: Readonly<Record<S4Kind, string>> = {
  supplier_create: 'supplier_create(uuid,text,text,text,text,text)',
  supplier_update: 'supplier_update(uuid,integer,text,text,text,text,text)',
  supplier_archive: 'supplier_archive(uuid,integer)',
  supplier_reactivate: 'supplier_reactivate(uuid,integer)',
  purchase_draft:
    'purchase_save_draft(uuid,integer,uuid,uuid,uuid,character,date,text,text,bigint,uuid[],uuid[],numeric[],numeric[],bigint[],uuid[],text[],bigint[],text[],bigint[])',
  purchase_cancel: 'purchase_cancel(uuid,uuid,integer)',
  purchase_receive:
    'purchase_receive(uuid,uuid,integer,uuid,integer,date,character,uuid,numeric,text,timestamp with time zone,bigint,bigint,uuid,uuid[],uuid[],numeric[],bigint[],numeric[],bigint[])',
};

/** The three internal receipt helpers (no grant). */
export const S4_HELPERS = ['purchase_lock_receipt_targets(uuid,uuid[])', 'purchase_cover_deficits(uuid,uuid)', 'purchase_bridge_receipt(uuid,uuid)'] as const;

/** The six S4 document tables. */
export const S4_TABLES = [
  'suppliers',
  'purchases',
  'purchase_lines',
  'purchase_landed_costs',
  'purchase_landed_cost_allocations',
  'negative_inventory_cost_adjustments',
] as const;

/** The two S4 bridges. */
export const S4_BRIDGES = ['stock_source_bridge_purchase', 'stock_source_bridge_negative_inventory_cost_adjustment'] as const;

// ── payloads ───────────────────────────────────────────────────────────────

type Biz = { readonly tenantId: string; readonly businessId: string };

function draftLinesOf(cmd: DraftCommand): { lineId: string; variantId: string; qtyQ4: bigint; unitPriceC10: bigint; discountMinor: bigint }[] {
  return cmd.lines.map((l) => ({
    lineId: l.lineId,
    variantId: l.variantId,
    qtyQ4: toQ4(l.qty),
    unitPriceC10: toC10(l.unitPriceMinor),
    discountMinor: l.discountMinor,
  }));
}

/** The `invpl/1` payload (and intent) the service would build for this exact command in `biz`. */
export function payloadOf(biz: Biz, cmd: S4Command): MovementPayload {
  const base = { tenantId: biz.tenantId, businessId: biz.businessId };
  switch (cmd.kind) {
    case 'supplier_create':
      return supplierCreatePayload({ ...base, supplierId: cmd.supplierId, ...cmd.fields });
    case 'supplier_update':
      return supplierUpdatePayload({ ...base, supplierId: cmd.supplierId, expectedRevision: cmd.expectedRevision, ...cmd.fields });
    case 'supplier_archive':
      return supplierArchivePayload({ ...base, supplierId: cmd.supplierId, expectedRevision: cmd.expectedRevision });
    case 'supplier_reactivate':
      return supplierReactivatePayload({ ...base, supplierId: cmd.supplierId, expectedRevision: cmd.expectedRevision });
    case 'purchase_draft':
      return purchaseDraftPayload({
        ...base,
        purchaseId: cmd.purchaseId,
        expectedRevision: cmd.expectedRevision,
        supplierId: cmd.supplierId,
        warehouseId: cmd.warehouseId,
        previousWarehouseId: cmd.previousWarehouseId,
        currency: cmd.currency,
        documentDate: cmd.documentDate,
        supplierReference: cmd.supplierReference,
        notes: cmd.notes,
        taxMinor: cmd.taxMinor,
        lines: draftLinesOf(cmd),
        landedCosts: cmd.landedCosts,
      });
    case 'purchase_cancel':
      return purchaseCancelPayload({ ...base, purchaseId: cmd.purchaseId, warehouseId: cmd.warehouseId, draftRevision: cmd.draftRevision });
    case 'purchase_receive':
      return purchaseReceivePayload({
        ...base,
        purchaseId: cmd.purchaseId,
        warehouseId: cmd.warehouseId,
        draftRevision: cmd.draftRevision,
        supplierId: cmd.supplierId,
        supplierRevision: cmd.supplierRevision,
        documentDate: cmd.documentDate,
        currency: cmd.currency,
        rate: {
          rateId: cmd.rate.rateId,
          rateR10: parseUnitCost(cmd.rate.rate),
          source: cmd.rate.source,
          rateAtEpochSeconds: BigInt(Math.floor(cmd.rate.at.getTime() / 1000)),
        },
        totalTxnMinor: cmd.totalTxnMinor,
        totalBaseMinor: cmd.totalBaseMinor,
        coverageAdjustmentId: cmd.coverageAdjustmentId,
        lines: cmd.lines,
      });
  }
}

/**
 * The claimed `invpl/1` stream of a command built field by field, WITHOUT the
 * builders' semantic refusals (a non-zero tax, a duplicate variant, shares that
 * do not add up): the exact digest the routine computes over its own
 * arguments. The encoder and its type checks are the package's.
 */
export function rawPayloadSha256(biz: Biz, cmd: S4Command): string {
  const u = (value: string | null): InventoryPayloadField => (value === null ? { kind: 'null' } : { kind: 'uuid', value });
  const i = (value: bigint | number | null): InventoryPayloadField => (value === null ? { kind: 'null' } : { kind: 'integer', value });
  const code = (value: string): InventoryPayloadField => ({ kind: 'code', value });
  const words = (text: string | null): InventoryPayloadField[] => {
    if (text === null) return Array.from({ length: 8 }, (): InventoryPayloadField => ({ kind: 'null' }));
    const d = createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
    return Array.from({ length: 8 }, (_, k) => i(BigInt(d.readUInt32BE(k * 4))));
  };
  const texts = (f: SupplierFields): InventoryPayloadField[] => [
    ...words(f.name),
    ...words(f.phone),
    ...words(f.email),
    ...words(f.taxIdentifier),
    ...words(f.notes),
  ];
  let fields: InventoryPayloadField[];
  switch (cmd.kind) {
    case 'supplier_create':
      fields = [u(cmd.supplierId), ...texts(cmd.fields)];
      break;
    case 'supplier_update':
      fields = [u(cmd.supplierId), i(cmd.expectedRevision), ...texts(cmd.fields)];
      break;
    case 'supplier_archive':
    case 'supplier_reactivate':
      fields = [u(cmd.supplierId), i(cmd.expectedRevision)];
      break;
    case 'purchase_draft': {
      const lines = draftLinesOf(cmd);
      fields = [
        u(cmd.purchaseId),
        i(cmd.expectedRevision),
        u(cmd.supplierId),
        u(cmd.warehouseId),
        u(cmd.previousWarehouseId),
        code(cmd.currency.toLowerCase()),
        i(yyyymmdd(cmd.documentDate)),
        ...words(cmd.supplierReference),
        ...words(cmd.notes),
        i(cmd.taxMinor),
        i(lines.length),
        ...lines.flatMap((l) => [u(l.lineId), u(l.variantId), i(l.qtyQ4), i(l.unitPriceC10), i(l.discountMinor)]),
        i(cmd.landedCosts.length),
        ...cmd.landedCosts.flatMap((c) => [
          u(c.landedCostId),
          code(c.mode),
          i(c.amountMinor),
          ...words(c.description),
          ...lines.map((_, k) => (c.allocations === null ? i(null) : i(c.allocations[k] ?? null))),
        ]),
      ];
      break;
    }
    case 'purchase_cancel':
      fields = [u(cmd.purchaseId), u(cmd.warehouseId), i(cmd.draftRevision)];
      break;
    case 'purchase_receive':
      fields = [
        u(cmd.purchaseId),
        u(cmd.warehouseId),
        i(cmd.draftRevision),
        u(cmd.supplierId),
        i(cmd.supplierRevision),
        i(yyyymmdd(cmd.documentDate)),
        code(cmd.currency.toLowerCase()),
        u(cmd.rate.rateId),
        i(parseUnitCost(cmd.rate.rate)),
        code(cmd.rate.source),
        i(BigInt(Math.floor(cmd.rate.at.getTime() / 1000))),
        i(cmd.totalTxnMinor),
        i(cmd.totalBaseMinor),
        u(cmd.coverageAdjustmentId),
        i(cmd.lines.length),
        ...cmd.lines.flatMap((l) => [u(l.lineId), u(l.variantId), i(l.qtyQ4), i(l.baseShareMinor), i(l.coveredQ4), i(l.catchUpMinor)]),
      ];
      break;
  }
  return inventoryPayloadSha256(OP_OF[cmd.kind], biz.tenantId, biz.businessId, fields);
}

/** The instant a receipt binds, as the routine's TIMESTAMPTZ text. */
export function rateAtText(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The routine call — SQL and parameters — for a command, exactly as the services issue it. */
export function callOf(cmd: S4Command): { readonly sql: string; readonly params: unknown[] } {
  switch (cmd.kind) {
    case 'supplier_create':
      return {
        sql: `SELECT * FROM supplier_create($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)`,
        params: [cmd.supplierId, cmd.fields.name, cmd.fields.phone, cmd.fields.email, cmd.fields.taxIdentifier, cmd.fields.notes],
      };
    case 'supplier_update':
      return {
        sql: `SELECT * FROM supplier_update($1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text)`,
        params: [cmd.supplierId, cmd.expectedRevision, cmd.fields.name, cmd.fields.phone, cmd.fields.email, cmd.fields.taxIdentifier, cmd.fields.notes],
      };
    case 'supplier_archive':
      return { sql: `SELECT * FROM supplier_archive($1::uuid, $2::integer)`, params: [cmd.supplierId, cmd.expectedRevision] };
    case 'supplier_reactivate':
      return { sql: `SELECT * FROM supplier_reactivate($1::uuid, $2::integer)`, params: [cmd.supplierId, cmd.expectedRevision] };
    case 'purchase_draft': {
      const lines = draftLinesOf(cmd);
      return {
        sql: `SELECT * FROM purchase_save_draft(
                $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::uuid, $6::char(3), $7::date, $8::text, $9::text, $10::bigint,
                $11::uuid[], $12::uuid[], $13::numeric[], $14::numeric[], $15::bigint[],
                $16::uuid[], $17::text[], $18::bigint[], $19::text[], $20::bigint[])`,
        params: [
          cmd.purchaseId,
          cmd.expectedRevision,
          cmd.supplierId,
          cmd.warehouseId,
          cmd.previousWarehouseId,
          cmd.currency,
          cmd.documentDate,
          cmd.supplierReference,
          cmd.notes,
          cmd.taxMinor.toString(10),
          lines.map((l) => l.lineId),
          lines.map((l) => l.variantId),
          lines.map((l) => formatQuantity(l.qtyQ4)),
          lines.map((l) => formatUnitCost(l.unitPriceC10)),
          lines.map((l) => l.discountMinor.toString(10)),
          cmd.landedCosts.map((c) => c.landedCostId),
          cmd.landedCosts.map((c) => c.mode),
          cmd.landedCosts.map((c) => c.amountMinor.toString(10)),
          cmd.landedCosts.map((c) => c.description),
          cmd.landedCosts.flatMap((c) => (c.allocations === null ? lines.map(() => null) : c.allocations.map((a) => a.toString(10)))),
        ],
      };
    }
    case 'purchase_cancel':
      return { sql: `SELECT * FROM purchase_cancel($1::uuid, $2::uuid, $3::integer)`, params: [cmd.purchaseId, cmd.warehouseId, cmd.draftRevision] };
    case 'purchase_receive':
      return {
        sql: `SELECT * FROM purchase_receive(
                $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::integer, $6::date, $7::char(3), $8::uuid, $9::numeric, $10::text,
                $11::timestamptz, $12::bigint, $13::bigint, $14::uuid, $15::uuid[], $16::uuid[], $17::numeric[], $18::bigint[],
                $19::numeric[], $20::bigint[])`,
        params: [
          cmd.purchaseId,
          cmd.warehouseId,
          cmd.draftRevision,
          cmd.supplierId,
          cmd.supplierRevision,
          cmd.documentDate,
          cmd.currency,
          cmd.rate.rateId,
          cmd.rate.rate,
          cmd.rate.source,
          rateAtText(cmd.rate.at),
          cmd.totalTxnMinor.toString(10),
          cmd.totalBaseMinor.toString(10),
          cmd.coverageAdjustmentId,
          cmd.lines.map((l) => l.lineId),
          cmd.lines.map((l) => l.variantId),
          cmd.lines.map((l) => formatQuantity(l.qtyQ4)),
          cmd.lines.map((l) => l.baseShareMinor.toString(10)),
          cmd.lines.map((l) => formatQuantity(l.coveredQ4)),
          cmd.lines.map((l) => l.catchUpMinor.toString(10)),
        ],
      };
  }
}

/** One row of any S4 entry routine's answer (pg's text for BIGINT/NUMERIC); each routine fills the columns it has. */
export interface S4Row {
  readonly supplier_id?: string;
  readonly purchase_id?: string;
  readonly replayed: boolean;
  readonly revision?: number;
  readonly status?: string;
  readonly subtotal_txn_minor?: string;
  readonly landed_cost_txn_minor?: string;
  readonly total_txn_minor?: string;
  readonly total_base_minor?: string;
  readonly line_id?: string | null;
  readonly line_no?: number | null;
  readonly variant_id?: string | null;
  readonly net_txn_minor?: string | null;
  readonly line_landed_cost_txn_minor?: string | null;
  readonly business_transaction_id?: string;
  readonly fx_rate_id?: string | null;
  readonly source_to_base_rate?: string;
  readonly rate_source?: string;
  readonly rate_timestamp?: Date;
  readonly coverage_adjustment_id?: string | null;
  readonly coverage_total_value_base_minor?: string | null;
  readonly row_kind?: 'line' | 'coverage';
  readonly qty?: string | null;
  readonly base_share_minor?: string | null;
  readonly unit_cost_base_minor?: string | null;
  readonly movement_id?: string | null;
  readonly coverage_id?: string | null;
  readonly deficit_id?: string | null;
  readonly qty_covered?: string | null;
  readonly provisional_unit_cost_base_minor?: string | null;
  readonly actual_unit_cost_base_minor?: string | null;
  readonly value_delta_base_minor?: string | null;
}

export interface RunOptions {
  /** Present exactly this assertion (a replay, a forgery); nothing is minted. `null` presents none. */
  readonly assertion?: string | null;
  /** Mint over this command's payload instead (a tampered field). */
  readonly mintFor?: S4Command;
  /** Mint under this operation code instead (a wrong-kind case). */
  readonly op?: InventoryOperationCode;
  /** Mint for this business instead of the calling one. */
  readonly mintBusiness?: Biz;
  /** Run under these scope GUCs instead of the business's own. */
  readonly scope?: Biz;
  /** The business transaction id GUC; a fresh one by default, `''` for none. */
  readonly trace?: string;
  readonly jti?: string;
  /** Digest the claimed arguments field by field (`rawPayloadSha256`), bypassing the builders' semantic refusals. */
  readonly raw?: boolean;
  /** Receives the assertion that was presented. */
  readonly onAssertion?: (assertion: string) => void;
}

/** Mint the assertion the service would mint for `cmd` in `biz`, with `o`'s departures. */
export function assertionFor(biz: Biz & { readonly userId: string }, cmd: S4Command, o: RunOptions = {}): string {
  const mintBiz = o.mintBusiness ?? biz;
  const signed = o.mintFor ?? cmd;
  const payloadSha256 = o.raw === true ? rawPayloadSha256(mintBiz, signed) : payloadOf(mintBiz, signed).payload.sha256;
  return mintTestInventoryAssertion({
    actorUserId: biz.userId,
    tenantId: mintBiz.tenantId,
    businessId: mintBiz.businessId,
    opCode: o.op ?? OP_OF[cmd.kind],
    payloadSha256,
    ...(o.jti === undefined ? {} : { jti: o.jti }),
  });
}

/**
 * The H-1 calling convention in the CALLER's transaction (a superuser
 * client): scope GUCs, trace and carrier, `SET LOCAL ROLE daftar_app`, the
 * entry routine, `RESET ROLE`. Wrap in `attempt` (`tryCommand`) when a refusal
 * is expected.
 */
export async function runCommand(c: Queryable, biz: S3Business, cmd: S4Command, o: RunOptions = {}): Promise<S4Row[]> {
  const assertion = o.assertion === undefined ? assertionFor(biz, cmd, o) : o.assertion;
  if (assertion !== null) o.onAssertion?.(assertion);
  const scope = o.scope ?? biz;
  await c.query(
    `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
            set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
    [scope.tenantId, scope.businessId, assertion ?? '', o.trace ?? randomUUID()],
  );
  await c.query('SET LOCAL ROLE daftar_app');
  const { sql, params } = callOf(cmd);
  const r = await c.query<S4Row>(sql, params);
  await c.query('RESET ROLE');
  return r.rows;
}

/** `runCommand` inside a savepoint: a refusal leaves the transaction usable. */
export function tryCommand(c: Queryable, biz: S3Business, cmd: S4Command, o: RunOptions = {}): Promise<Outcome<S4Row[]>> {
  return attempt(c, () => runCommand(c, biz, cmd, o));
}

// ── builders ───────────────────────────────────────────────────────────────

export const NO_CONTACTS = { phone: null, email: null, taxIdentifier: null, notes: null } as const;

export function supplierCreate(fields: Partial<SupplierFields> = {}, supplierId: string = randomUUID()): SupplierCreateCommand {
  return { kind: 'supplier_create', supplierId, fields: { name: 'Hebron Wholesale', ...NO_CONTACTS, ...fields } };
}

export function supplierUpdate(supplierId: string, expectedRevision: number, fields: Partial<SupplierFields> = {}): SupplierUpdateCommand {
  return { kind: 'supplier_update', supplierId, expectedRevision, fields: { name: 'Hebron Wholesale', ...NO_CONTACTS, ...fields } };
}

export function supplierArchive(supplierId: string, expectedRevision: number): SupplierLifecycleCommand {
  return { kind: 'supplier_archive', supplierId, expectedRevision };
}

export function supplierReactivate(supplierId: string, expectedRevision: number): SupplierLifecycleCommand {
  return { kind: 'supplier_reactivate', supplierId, expectedRevision };
}

/** Create an active supplier through the real routine, in the caller's transaction. */
export async function createSupplier(c: Queryable, biz: S3Business, fields: Partial<SupplierFields> = {}): Promise<string> {
  const cmd = supplierCreate(fields);
  await runCommand(c, biz, cmd);
  return cmd.supplierId;
}

export interface DraftLineInput {
  readonly variantId: string;
  readonly qty: string;
  readonly unitPriceMinor: string;
  readonly discountMinor?: bigint;
  readonly lineId?: string;
}

/** A draft create (revision 0) or replace, domestic (ILS) and dated today by default. */
export async function draftCommand(
  q: Queryable,
  supplierId: string,
  warehouseId: string,
  lines: readonly DraftLineInput[],
  o: Partial<Omit<DraftCommand, 'kind' | 'lines' | 'supplierId' | 'warehouseId'>> = {},
): Promise<DraftCommand> {
  return {
    kind: 'purchase_draft',
    purchaseId: o.purchaseId ?? randomUUID(),
    expectedRevision: o.expectedRevision ?? 0,
    supplierId,
    warehouseId,
    previousWarehouseId: o.previousWarehouseId ?? null,
    currency: o.currency ?? 'ILS',
    documentDate: o.documentDate ?? (await today(q)),
    supplierReference: o.supplierReference ?? null,
    notes: o.notes ?? null,
    taxMinor: o.taxMinor ?? 0n,
    lines: lines.map((l) => ({
      lineId: l.lineId ?? randomUUID(),
      variantId: l.variantId,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: l.discountMinor ?? 0n,
    })),
    landedCosts: o.landedCosts ?? [],
  };
}

export function cancelCommand(purchaseId: string, warehouseId: string, draftRevision: number): CancelCommand {
  return { kind: 'purchase_cancel', purchaseId, warehouseId, draftRevision };
}

/** The A-13 totals the builder computed for a draft (what the routine will store). */
export function draftTotals(biz: Biz, cmd: DraftCommand): PurchaseTotals {
  return purchaseDraftPayload({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    purchaseId: cmd.purchaseId,
    expectedRevision: cmd.expectedRevision,
    supplierId: cmd.supplierId,
    warehouseId: cmd.warehouseId,
    previousWarehouseId: cmd.previousWarehouseId,
    currency: cmd.currency,
    documentDate: cmd.documentDate,
    supplierReference: cmd.supplierReference,
    notes: cmd.notes,
    taxMinor: cmd.taxMinor,
    lines: draftLinesOf(cmd),
    landedCosts: cmd.landedCosts,
  }).totals;
}

// ── the receipt, prepared as PurchaseReceiptService prepares it ────────────

interface HeaderRow {
  warehouse_id: string;
  supplier_id: string;
  currency_code: string;
  document_date: string;
  tax_minor: string;
  total_txn_minor: string;
  revision: number;
  status: string;
}

interface LineRow {
  id: string;
  variant_id: string;
  qty: string;
  unit_price_txn_minor: string;
  discount_txn_minor: string;
}

/** A receipt command, the plan it binds, and what its postings need. */
export interface PreparedReceipt {
  readonly cmd: ReceiveCommand;
  readonly plan: CoveragePlan;
  readonly totals: PurchaseTotals;
  readonly baseCurrency: string;
  readonly branchId: string;
}

/** The FX snapshot A-17 binds, read as the owner exactly as the service reads it. */
export async function receiptRate(q: Queryable, businessId: string, currency: string, documentDate: string): Promise<ReceiveRate> {
  const b = must((await q.query<{ base_currency: string }>(`SELECT base_currency FROM businesses WHERE id = $1`, [businessId])).rows[0], 'business');
  if (currency.toUpperCase() === b.base_currency.toUpperCase()) {
    return { rateId: null, rate: '1.0000000000', source: 'base', at: new Date(`${documentDate}T00:00:00Z`) };
  }
  const r = must(
    (
      await q.query<{ rate_id: string; rate: string; source: string; effective_at: Date }>(
        `SELECT r.rate_id, r.rate::text AS rate, r.source, r.effective_at
           FROM businesses b
          CROSS JOIN LATERAL accounting_fx_rate_lookup(b.id, $2, b.base_currency, ((($3::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) r
          WHERE b.id = $1`,
        [businessId, currency, documentDate],
      )
    ).rows[0],
    'rate',
  );
  if (r.source !== 'manual' && r.source !== 'base') throw new Error(`unexpected rate source ${r.source}`);
  return { rateId: r.rate_id, rate: r.rate, source: r.source, at: r.effective_at };
}

/** The open layers of the receipt's keys (A-16(b)), as the owner reads them. */
export async function openLayers(q: Queryable, businessId: string, warehouseId: string, variantIds: readonly string[]): Promise<DeficitLayer[]> {
  const r = await q.query<{ id: string; variant_id: string; deficit_seq: string; uncovered_qty: string; provisional: string }>(
    `SELECT id::text, variant_id::text, deficit_seq::text AS deficit_seq, uncovered_qty::text AS uncovered_qty,
            provisional_unit_cost_base_minor::text AS provisional
       FROM negative_inventory_deficits
      WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = ANY($3::uuid[]) AND status <> 'closed'`,
    [businessId, warehouseId, variantIds],
  );
  return r.rows.map((x) => ({
    deficitId: x.id,
    variantId: x.variant_id,
    deficitSeq: BigInt(x.deficit_seq),
    uncoveredQ4: parseQuantity(x.uncovered_qty),
    provisionalC10: parseUnitCost(x.provisional),
  }));
}

/**
 * Prepare the receipt of `purchaseId` from the stored draft and the current
 * state, exactly as `PurchaseReceiptService.run` steps 4–5 do: A-13 over the
 * stored lines and landed costs, `B = convertToBaseMinor(T)`, the shares, the
 * FX snapshot, and the coverage plan with a fresh header id iff anything is
 * covered.
 */
export async function prepareReceipt(
  q: Queryable,
  biz: Biz,
  purchaseId: string,
  o: { draftRevision?: number; coverageAdjustmentId?: string } = {},
): Promise<PreparedReceipt> {
  const h = must(
    (
      await q.query<HeaderRow>(
        `SELECT warehouse_id::text, supplier_id::text, currency_code::text AS currency_code, to_char(document_date, 'YYYY-MM-DD') AS document_date,
                tax_minor::text AS tax_minor, total_txn_minor::text AS total_txn_minor, revision, status
           FROM purchases WHERE business_id = $1 AND id = $2`,
        [biz.businessId, purchaseId],
      )
    ).rows[0],
    `purchase ${purchaseId}`,
  );
  const lines = (
    await q.query<LineRow>(
      `SELECT id::text, variant_id::text, qty::text AS qty, unit_price_txn_minor::text AS unit_price_txn_minor, discount_txn_minor::text AS discount_txn_minor
         FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 ORDER BY line_no`,
      [biz.businessId, purchaseId],
    )
  ).rows;
  const costs = (
    await q.query<{ mode: LandedCostMode; amount: string; allocations: string[] }>(
      `SELECT c.mode, c.amount_txn_minor::text AS amount,
              coalesce((SELECT array_agg(a.amount_txn_minor::text ORDER BY l.line_no)
                          FROM purchase_landed_cost_allocations a
                          JOIN purchase_lines l ON l.business_id = a.business_id AND l.purchase_id = a.purchase_id AND l.id = a.purchase_line_id
                         WHERE a.business_id = c.business_id AND a.landed_cost_id = c.id), '{}') AS allocations
         FROM purchase_landed_costs c WHERE c.business_id = $1 AND c.purchase_id = $2 ORDER BY c.cost_no`,
      [biz.businessId, purchaseId],
    )
  ).rows;
  const supplier = must(
    (await q.query<{ revision: number }>(`SELECT revision FROM suppliers WHERE business_id = $1 AND id = $2`, [biz.businessId, h.supplier_id])).rows[0],
    'supplier',
  );
  const baseCurrency = must(
    (await q.query<{ base_currency: string }>(`SELECT base_currency FROM businesses WHERE id = $1`, [biz.businessId])).rows[0],
    'business',
  ).base_currency;

  const qtys = lines.map((l) => parseQuantity(l.qty));
  const totals = lineTotals(
    lines.map((l, i) => ({ qtyQ4: qtys[i] ?? 0n, unitPriceC10: parseUnitCost(l.unit_price_txn_minor), discountMinor: parseMinor(l.discount_txn_minor) })),
    costs.map((c) => ({ mode: c.mode, amountMinor: parseMinor(c.amount), allocations: c.mode === 'manual' ? c.allocations.map(parseMinor) : null })),
    parseMinor(h.tax_minor),
  );
  const rate = await receiptRate(q, biz.businessId, h.currency_code, h.document_date);
  const totalBaseMinor =
    rate.source === 'base'
      ? totals.totalMinor
      : convertToBaseMinor({ txnAmountMinor: totals.totalMinor, txnCurrency: h.currency_code, baseCurrency, fxRate: rate.rate });
  const shares = baseShares(
    totalBaseMinor,
    totals.lines.map((t) => t.totalMinor),
  );

  const keyStates = new Map<string, StockState>();
  for (const l of lines) keyStates.set(l.variant_id, await stockState(q, biz.businessId, { warehouseId: h.warehouse_id, variantId: l.variant_id }));
  const plan = planCoverage(
    await openLayers(
      q,
      biz.businessId,
      h.warehouse_id,
      lines.map((l) => l.variant_id),
    ),
    keyStates,
    lines.map((l, i) => ({ lineId: l.id, variantId: l.variant_id, qtyQ4: qtys[i] ?? 0n, baseShareMinor: shares[i] ?? 0n })),
  );
  const coverageAdjustmentId = plan.coveredQ4 > 0n ? (o.coverageAdjustmentId ?? randomUUID()) : null;
  const cmd: ReceiveCommand = {
    kind: 'purchase_receive',
    purchaseId,
    warehouseId: h.warehouse_id,
    draftRevision: o.draftRevision ?? h.revision,
    supplierId: h.supplier_id,
    supplierRevision: supplier.revision,
    documentDate: h.document_date,
    currency: h.currency_code,
    rate,
    totalTxnMinor: totals.totalMinor,
    totalBaseMinor,
    coverageAdjustmentId,
    lines: plan.lines.map((l) => ({
      lineId: l.lineId,
      variantId: l.variantId,
      qtyQ4: l.qtyQ4,
      baseShareMinor: l.baseShareMinor,
      coveredQ4: l.coveredQ4,
      catchUpMinor: l.catchUpMinor,
    })),
  };
  return { cmd, plan, totals, baseCurrency, branchId: await homeBranch(q, biz.businessId, h.warehouse_id) };
}

/** The two postings a receipt owes, built by the APP's builders from the bound values (the catch-up null iff N = 0). */
export function receiptPostings(biz: Biz, p: PreparedReceipt, trace: string): { purchase: PostingCommand; catchUp: PostingCommand | null } {
  const base = { tenantId: biz.tenantId, businessId: biz.businessId, documentDate: p.cmd.documentDate, businessTransactionId: trace };
  const purchase = purchasePostingCommand({
    ...base,
    purchaseId: p.cmd.purchaseId,
    currency: p.cmd.currency,
    baseCurrency: p.baseCurrency,
    totalTxnMinor: p.cmd.totalTxnMinor,
    totalBaseMinor: p.cmd.totalBaseMinor,
    fx: { rate: p.cmd.rate.rate, source: p.cmd.rate.source, at: p.cmd.rate.at },
    warehouseId: p.cmd.warehouseId,
    branchId: p.branchId,
  });
  const catchUp =
    p.cmd.coverageAdjustmentId === null
      ? null
      : catchUpPostingCommand({
          ...base,
          adjustmentId: p.cmd.coverageAdjustmentId,
          baseCurrency: p.baseCurrency,
          warehouseId: p.cmd.warehouseId,
          branchId: p.branchId,
          netValueMinor: p.plan.totalValueMinor,
        });
  return { purchase, catchUp };
}

/** The accounting assertion a domain command mints for exactly this posting (the real minting function). */
export function mintPosting(command: PostingCommand, actorUserId: string): string {
  return mintDomainPostingAssertion(testMinter, command, actorUserId);
}

/**
 * Post `command` in the CALLER's transaction as `daftar_app`, carrying
 * `assertion` (by default the one `mintDomainPostingAssertion` mints for it),
 * with the lines serialized exactly as the posting adapter serializes them.
 */
export async function postInTx(c: Queryable, command: PostingCommand, actorUserId: string, assertion?: string): Promise<{ entryId: string; created: boolean }> {
  await c.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion ?? mintPosting(command, actorUserId)]);
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
    command.entryDate,
    command.description ?? null,
    command.requestId ?? null,
    JSON.stringify(serializePostingLines(command.lines)),
  ]);
  await c.query('RESET ROLE');
  const row = must(r.rows[0], 'accounting_post_entry row');
  return { entryId: row.entry_id, created: row.created };
}

export interface ReceiptRun {
  readonly rows: S4Row[];
  readonly prepared: PreparedReceipt;
  readonly purchaseEntry: { entryId: string; created: boolean } | null;
  readonly catchUpEntry: { entryId: string; created: boolean } | null;
  readonly postings: { purchase: PostingCommand; catchUp: PostingCommand | null };
}

/**
 * One receipt the way the service runs it (A-06, A-08): the routine, then —
 * unless it answered a replay — the purchase entry and, iff N ≠ 0, the
 * catch-up entry, in the caller's transaction.
 */
export async function runReceipt(
  c: Queryable,
  biz: S3Business,
  prepared: PreparedReceipt,
  o: RunOptions & { readonly postings?: boolean } = {},
): Promise<ReceiptRun> {
  const trace = o.trace ?? randomUUID();
  const rows = await runCommand(c, biz, prepared.cmd, { ...o, trace });
  const postings = receiptPostings(biz, prepared, trace);
  if (o.postings === false || rows[0]?.replayed === true) return { rows, prepared, purchaseEntry: null, catchUpEntry: null, postings };
  const purchaseEntry = await postInTx(c, postings.purchase, biz.userId);
  const catchUpEntry = postings.catchUp === null ? null : await postInTx(c, postings.catchUp, biz.userId);
  return { rows, prepared, purchaseEntry, catchUpEntry, postings };
}

/** Save a draft, then prepare and run its receipt, all in the caller's transaction. */
export async function draftAndReceive(c: Queryable, biz: S3Business, draft: DraftCommand, o: RunOptions = {}): Promise<ReceiptRun> {
  const saved = await runCommand(c, biz, draft);
  const revision = must(saved[0]?.revision, 'draft revision');
  return runReceipt(c, biz, await prepareReceipt(c, biz, draft.purchaseId, { draftRevision: revision }), o);
}

// ── counters and ledger reads (as the owner) ───────────────────────────────

export type Counts = Readonly<Record<string, number | string>>;

/**
 * Every row count a purchasing command may change for one business, plus a
 * digest of the rows a command UPDATEs (purchase headers and lines, supplier
 * revisions, deficit layers, the stock cache), so a rolled-back UPDATE is
 * caught as surely as an INSERT.
 */
export async function s4Counts(q: Queryable, businessId: string): Promise<Counts> {
  const tables = [
    ...S4_TABLES,
    'negative_deficit_coverages',
    'negative_inventory_deficits',
    ...S4_BRIDGES,
    'stock_movements',
    'stock_source_bindings',
    'stock_levels',
    'journal_entries',
    'journal_lines',
    'accounting_source_bindings',
    'audit_events',
    'outbox_events',
    'inventory_assertion_uses',
  ];
  const r = await q.query<Record<string, number | string>>(
    `SELECT ${tables.map((t) => `(SELECT count(*)::int FROM ${t} WHERE business_id = $1) AS ${t}`).join(', ')},
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, status, revision, total_base_minor, receive_intent_sha256, cancel_intent_sha256, supplier_name_snapshot), ',' ORDER BY id)), '')
               FROM purchases WHERE business_id = $1) AS purchases_state,
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, base_share_minor, unit_cost_base_minor), ',' ORDER BY id)), '')
               FROM purchase_lines WHERE business_id = $1) AS purchase_lines_state,
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, status, revision, name), ',' ORDER BY id)), '')
               FROM suppliers WHERE business_id = $1) AS suppliers_state,
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, uncovered_qty, status), ',' ORDER BY id)), '')
               FROM negative_inventory_deficits WHERE business_id = $1) AS deficits_state,
            (SELECT coalesce(md5(string_agg(concat_ws('|', warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq), ',' ORDER BY warehouse_id, variant_id)), '')
               FROM stock_levels WHERE business_id = $1) AS stock_levels_state`,
    [businessId],
  );
  return must(r.rows[0], 's4 counts');
}

/** `after − before` over the counts (numbers) and the digests that moved (strings as `'changed'`). */
export function s4Delta(before: Counts, after: Counts): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before[k];
    if (typeof v === 'number') {
      const d = v - (typeof b === 'number' ? b : 0);
      if (d !== 0) out[k] = d;
    } else if (v !== b) {
      out[k] = 'changed';
    }
  }
  return out;
}

export interface EntryLineText {
  readonly system_key: string | null;
  readonly code: string;
  readonly debit: string;
  readonly credit: string;
  readonly txn_amount: string;
  readonly txn_currency: string;
  readonly fx_rate: string;
  readonly fx_rate_source: string;
  readonly fx_rate_at: Date;
  readonly warehouse_id: string | null;
  readonly branch_id: string | null;
}

/** The entry posted under `(sourceType, sourceId)`, or null; with its lines by line number. */
export async function entryOf(
  q: Queryable,
  businessId: string,
  sourceType: 'purchase' | 'negative_inventory_cost_adjustment',
  sourceId: string,
): Promise<{ id: string; entry_date: string; lines: EntryLineText[] } | null> {
  const e = (
    await q.query<{ id: string; entry_date: string }>(
      `SELECT id::text, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM journal_entries WHERE business_id = $1 AND source_type = $2 AND source_id = $3`,
      [businessId, sourceType, sourceId],
    )
  ).rows[0];
  if (e === undefined) return null;
  const lines = (
    await q.query<EntryLineText>(
      `SELECT a.system_key, a.code, l.debit_minor::text AS debit, l.credit_minor::text AS credit, l.txn_amount_minor::text AS txn_amount,
              l.txn_currency::text AS txn_currency, l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
              l.warehouse_id::text, l.branch_id::text
         FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
      [businessId, e.id],
    )
  ).rows;
  return { ...e, lines };
}

/** Net `Σ Dr − Σ Cr` on one system account of the business. */
export async function glOf(q: Queryable, businessId: string, systemKey: string): Promise<bigint> {
  const r = await q.query<{ n: string }>(
    `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS n
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = $2`,
    [businessId, systemKey],
  );
  return BigInt(must(r.rows[0]).n);
}

/** The stored level of a key as text (or null). */
export async function levelText(
  q: Queryable,
  businessId: string,
  warehouseId: string,
  variantId: string,
): Promise<{ onHand: string; valuation: string; avg: string | null } | null> {
  const r = await q.query<{ on_hand: string; valuation: string; avg: string | null }>(
    `SELECT on_hand::text AS on_hand, valuation_base_minor::text AS valuation, avg_unit_cost_base_minor::text AS avg
       FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
    [businessId, warehouseId, variantId],
  );
  const row = r.rows[0];
  return row === undefined ? null : { onHand: row.on_hand, valuation: row.valuation, avg: row.avg };
}

/** A purchase's header as the owner reads it. */
export async function purchaseRow(q: Queryable, businessId: string, purchaseId: string): Promise<Record<string, unknown> | null> {
  const r = await q.query<Record<string, unknown>>(`SELECT * FROM purchases WHERE business_id = $1 AND id = $2`, [businessId, purchaseId]);
  return r.rows[0] ?? null;
}

// ── the landed-cost vectors (packages/inventory/vectors/landed-cost-vectors.json) ─

export interface PurchaseVectorLine {
  readonly qty: string;
  readonly unitPriceTxnMinor: string;
  readonly discountMinor: string;
}

export interface PurchaseVector {
  readonly id: string;
  readonly txnCurrency: string;
  readonly baseCurrency: string;
  readonly rate: string;
  readonly lines: readonly PurchaseVectorLine[];
  readonly landedCosts: readonly { readonly mode: LandedCostMode; readonly amountMinor: string; readonly allocations: readonly string[] | null }[];
  readonly expect: {
    readonly lines: readonly {
      readonly grossMinor: string;
      readonly netMinor: string;
      readonly landedMinor: string;
      readonly totalMinor: string;
      readonly baseShareMinor: string;
      readonly unitCostBaseMinor: string;
    }[];
    readonly allocations: readonly (readonly string[])[];
    readonly subtotalMinor: string;
    readonly landedMinor: string;
    readonly totalTxnMinor: string;
    readonly totalBaseMinor: string;
  };
}

export interface SplitVector {
  readonly id: string;
  readonly kind: LandedCostMode;
  readonly amountMinor: string;
  readonly inputs: readonly string[];
  readonly allocations: readonly string[] | null;
  readonly outcome: string;
}

export interface RefusalVector {
  readonly id: string;
  readonly lines: readonly PurchaseVectorLine[];
  readonly landedCosts: readonly { readonly mode: LandedCostMode; readonly amountMinor: string; readonly allocations: readonly string[] | null }[];
  readonly outcome: string;
}

export interface LandedCostVectors {
  readonly splits: readonly SplitVector[];
  readonly purchases: readonly PurchaseVector[];
  readonly refusals: readonly RefusalVector[];
}

/** The landed-cost vectors, read from the package (never restated here). */
export function landedCostVectors(): LandedCostVectors {
  return JSON.parse(readFileSync(join(__dirname, '../../packages/inventory/vectors/landed-cost-vectors.json'), 'utf8')) as LandedCostVectors;
}

/**
 * A draft stating a landed-cost vector's lines and landed costs exactly. A
 * fractional quantity goes to the two-decimal product (`dec2`); whole
 * quantities to `piece`, `piece2` and the variant product's two variants, in
 * line order. Each line and cost gets a fresh id.
 */
export async function vectorDraft(
  q: Queryable,
  biz: S3Business,
  supplierId: string,
  lines: readonly PurchaseVectorLine[],
  landedCosts: RefusalVector['landedCosts'],
  o: Partial<Omit<DraftCommand, 'kind' | 'lines' | 'supplierId' | 'landedCosts'>> = {},
): Promise<DraftCommand> {
  const whole = [biz.piece.variantId, biz.piece2.variantId, ...biz.variantProduct.variantIds];
  let decimalUsed = false;
  const variants = lines.map((l) => {
    if (!/\.0+$/.test(l.qty) && l.qty.includes('.')) {
      if (decimalUsed) throw new Error('vectorDraft: one fractional line per draft');
      decimalUsed = true;
      return biz.dec2.variantId;
    }
    return must(whole.shift(), 'vectorDraft: at most four whole-quantity lines');
  });
  return draftCommand(
    q,
    supplierId,
    o.warehouseId ?? biz.w1,
    lines.map((l, i) => ({ variantId: must(variants[i]), qty: l.qty, unitPriceMinor: l.unitPriceTxnMinor, discountMinor: BigInt(l.discountMinor) })),
    {
      ...o,
      landedCosts: landedCosts.map((c) => ({
        landedCostId: randomUUID(),
        mode: c.mode,
        amountMinor: BigInt(c.amountMinor),
        description: null,
        allocations: c.allocations === null ? null : c.allocations.map((a) => BigInt(a)),
      })),
    },
  );
}

/** The domestic rate R10 (re-exported for suites asserting the snapshot). */
export { DOMESTIC_RATE_R10 };

/** Seed the S3 world with a supplier per business, committed through the real routine. */
export async function supplierIn(pool: Pool, biz: S3Business, fields: Partial<SupplierFields> = {}): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = await createSupplier(c, biz, fields);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** The pool the suites read with. */
export const owner = ownerPool;

// ── one honest command per entry routine (the authority, isolation and
//    idempotency suites each start from these and depart in exactly one way) ─

/** Full contacts for a supplier, so every text field is bound and can be tampered. */
export const FULL_CONTACTS: SupplierFields = {
  name: 'Nablus Paper Co.',
  phone: '+970 9 234 5678',
  email: 'orders@nablus-paper.ps',
  taxIdentifier: 'PS-562-118',
  notes: 'Delivers on Tuesdays',
};

/**
 * The honest two-line draft of `biz` for `supplierId`: piece × 3 at 12.50
 * with a 1.00 discount, piece2 × 2 at 7.00, a `by_value` landed cost of 2.00
 * and a `manual` one of 1.00 split 0.60 / 0.40, a reference and notes.
 */
export async function honestDraft(
  q: Queryable,
  biz: S3Business,
  supplierId: string,
  o: Partial<Omit<DraftCommand, 'kind' | 'lines' | 'supplierId'>> = {},
): Promise<DraftCommand> {
  return draftCommand(
    q,
    supplierId,
    o.warehouseId ?? biz.w1,
    [
      { lineId: randomUUID(), variantId: biz.piece.variantId, qty: '3', unitPriceMinor: '1250', discountMinor: 100n },
      { lineId: randomUUID(), variantId: biz.piece2.variantId, qty: '2', unitPriceMinor: '700' },
    ],
    {
      supplierReference: 'INV-2291',
      notes: 'first delivery',
      landedCosts: [
        { landedCostId: randomUUID(), mode: 'by_value', amountMinor: 200n, description: 'freight', allocations: null },
        { landedCostId: randomUUID(), mode: 'manual', amountMinor: 100n, description: 'customs', allocations: [60n, 40n] },
      ],
      ...o,
    },
  );
}

/**
 * Prepare `kind` in `biz` and return the honest command for it; the command
 * succeeds when run next. Suppliers are created (and archived) through the
 * real routines; a cancel and a receipt get their draft first.
 */
export async function honestS4(c: Queryable, biz: S3Business, kind: S4Kind): Promise<S4Command> {
  switch (kind) {
    case 'supplier_create':
      return supplierCreate(FULL_CONTACTS);
    case 'supplier_update':
      return supplierUpdate(await createSupplier(c, biz, FULL_CONTACTS), 1, { ...FULL_CONTACTS, name: 'Nablus Paper Company', notes: null });
    case 'supplier_archive':
      return supplierArchive(await createSupplier(c, biz, FULL_CONTACTS), 1);
    case 'supplier_reactivate': {
      const id = await createSupplier(c, biz, FULL_CONTACTS);
      await runCommand(c, biz, supplierArchive(id, 1));
      return supplierReactivate(id, 2);
    }
    case 'purchase_draft':
      return honestDraft(c, biz, await createSupplier(c, biz, FULL_CONTACTS));
    case 'purchase_cancel': {
      const d = await honestDraft(c, biz, await createSupplier(c, biz, FULL_CONTACTS));
      await runCommand(c, biz, d);
      return cancelCommand(d.purchaseId, d.warehouseId, 1);
    }
    case 'purchase_receive': {
      const d = await honestDraft(c, biz, await createSupplier(c, biz, FULL_CONTACTS));
      await runCommand(c, biz, d);
      return (await prepareReceipt(c, biz, d.purchaseId)).cmd;
    }
  }
}

/** Every single-field tamper of a command (the field name and the tampered command), for the T-02 matrix. */
export function s4Tampers(cmd: S4Command, other: S3Business): readonly { field: string; cmd: S4Command }[] {
  const out: { field: string; cmd: S4Command }[] = [];
  const texts = (f: SupplierFields): { field: string; fields: SupplierFields }[] => [
    { field: 'name', fields: { ...f, name: `${f.name}.` } },
    { field: 'phone', fields: { ...f, phone: f.phone === null ? '+970 1' : null } },
    { field: 'email', fields: { ...f, email: 'other@example.ps' } },
    { field: 'tax identifier', fields: { ...f, taxIdentifier: 'PS-000' } },
    { field: 'notes', fields: { ...f, notes: f.notes === null ? 'a note' : `${f.notes}!` } },
  ];
  switch (cmd.kind) {
    case 'supplier_create':
      out.push({ field: 'supplier id', cmd: { ...cmd, supplierId: randomUUID() } });
      for (const t of texts(cmd.fields)) out.push({ field: t.field, cmd: { ...cmd, fields: t.fields } });
      break;
    case 'supplier_update':
      out.push({ field: 'supplier id', cmd: { ...cmd, supplierId: randomUUID() } });
      out.push({ field: 'expected revision', cmd: { ...cmd, expectedRevision: cmd.expectedRevision + 1 } });
      for (const t of texts(cmd.fields)) out.push({ field: t.field, cmd: { ...cmd, fields: t.fields } });
      break;
    case 'supplier_archive':
    case 'supplier_reactivate':
      out.push({ field: 'supplier id', cmd: { ...cmd, supplierId: randomUUID() } });
      out.push({ field: 'expected revision', cmd: { ...cmd, expectedRevision: cmd.expectedRevision + 1 } });
      break;
    case 'purchase_draft': {
      const [l1, l2] = cmd.lines;
      const [c1, c2] = cmd.landedCosts;
      if (l1 === undefined || l2 === undefined || c1 === undefined || c2 === undefined) break;
      out.push({ field: 'purchase id', cmd: { ...cmd, purchaseId: randomUUID() } });
      out.push({ field: 'expected revision', cmd: { ...cmd, expectedRevision: cmd.expectedRevision + 1 } });
      out.push({ field: 'supplier', cmd: { ...cmd, supplierId: randomUUID() } });
      out.push({ field: 'warehouse', cmd: { ...cmd, warehouseId: other.w1 } });
      out.push({ field: 'previous warehouse', cmd: { ...cmd, previousWarehouseId: other.w2 } });
      out.push({ field: 'currency', cmd: { ...cmd, currency: 'USD' } });
      out.push({ field: 'document date', cmd: { ...cmd, documentDate: '2020-01-01' } });
      out.push({ field: 'supplier reference', cmd: { ...cmd, supplierReference: 'INV-2292' } });
      out.push({ field: 'notes', cmd: { ...cmd, notes: null } });
      out.push({ field: 'tax', cmd: { ...cmd, taxMinor: 1n } });
      out.push({ field: 'line id', cmd: { ...cmd, lines: [{ ...l1, lineId: randomUUID() }, l2] } });
      out.push({ field: 'variant', cmd: { ...cmd, lines: [{ ...l1, variantId: other.piece.variantId }, l2] } });
      out.push({ field: 'qty', cmd: { ...cmd, lines: [{ ...l1, qty: '4' }, l2] } });
      out.push({ field: 'unit price', cmd: { ...cmd, lines: [{ ...l1, unitPriceMinor: '1250.0000000001' }, l2] } });
      out.push({ field: 'discount', cmd: { ...cmd, lines: [{ ...l1, discountMinor: l1.discountMinor + 1n }, l2] } });
      out.push({ field: 'line order', cmd: { ...cmd, lines: [l2, l1] } });
      out.push({ field: 'a line dropped', cmd: { ...cmd, lines: [l1] } });
      out.push({ field: 'landed cost id', cmd: { ...cmd, landedCosts: [{ ...c1, landedCostId: randomUUID() }, c2] } });
      out.push({ field: 'landed amount', cmd: { ...cmd, landedCosts: [{ ...c1, amountMinor: c1.amountMinor + 1n }, c2] } });
      out.push({ field: 'landed description', cmd: { ...cmd, landedCosts: [{ ...c1, description: 'freight in' }, c2] } });
      out.push({ field: 'landed mode', cmd: { ...cmd, landedCosts: [c1, { ...c2, mode: 'by_value', allocations: null }] } });
      out.push({ field: 'manual allocation', cmd: { ...cmd, landedCosts: [c1, { ...c2, allocations: [59n, 41n] }] } });
      out.push({ field: 'a landed cost dropped', cmd: { ...cmd, landedCosts: [c1] } });
      break;
    }
    case 'purchase_cancel':
      out.push({ field: 'purchase id', cmd: { ...cmd, purchaseId: randomUUID() } });
      out.push({ field: 'warehouse', cmd: { ...cmd, warehouseId: other.w1 } });
      out.push({ field: 'draft revision', cmd: { ...cmd, draftRevision: cmd.draftRevision + 1 } });
      break;
    case 'purchase_receive': {
      const [l1, l2] = cmd.lines;
      if (l1 === undefined || l2 === undefined) break;
      out.push({ field: 'purchase id', cmd: { ...cmd, purchaseId: randomUUID() } });
      out.push({ field: 'warehouse', cmd: { ...cmd, warehouseId: other.w1 } });
      out.push({ field: 'draft revision', cmd: { ...cmd, draftRevision: cmd.draftRevision + 1 } });
      out.push({ field: 'supplier', cmd: { ...cmd, supplierId: randomUUID() } });
      out.push({ field: 'supplier revision', cmd: { ...cmd, supplierRevision: cmd.supplierRevision + 1 } });
      out.push({ field: 'document date', cmd: { ...cmd, documentDate: '2020-01-01' } });
      out.push({ field: 'currency', cmd: { ...cmd, currency: 'USD' } });
      out.push({ field: 'rate id', cmd: { ...cmd, rate: { ...cmd.rate, rateId: randomUUID(), source: 'manual' } } });
      out.push({ field: 'rate', cmd: { ...cmd, rate: { ...cmd.rate, rate: '1.0000000001' } } });
      out.push({ field: 'rate instant', cmd: { ...cmd, rate: { ...cmd.rate, at: new Date(cmd.rate.at.getTime() + 1000) } } });
      out.push({ field: 'total txn', cmd: { ...cmd, totalTxnMinor: cmd.totalTxnMinor + 1n } });
      out.push({ field: 'total base', cmd: { ...cmd, totalBaseMinor: cmd.totalBaseMinor + 1n } });
      out.push({ field: 'coverage header id', cmd: { ...cmd, coverageAdjustmentId: randomUUID() } });
      out.push({ field: 'line id', cmd: { ...cmd, lines: [{ ...l1, lineId: randomUUID() }, l2] } });
      out.push({ field: 'variant', cmd: { ...cmd, lines: [{ ...l1, variantId: other.piece.variantId }, l2] } });
      out.push({ field: 'qty', cmd: { ...cmd, lines: [{ ...l1, qtyQ4: l1.qtyQ4 + 1n }, l2] } });
      out.push({
        field: 'base share',
        cmd: {
          ...cmd,
          lines: [
            { ...l1, baseShareMinor: l1.baseShareMinor - 1n },
            { ...l2, baseShareMinor: l2.baseShareMinor + 1n },
          ],
        },
      });
      out.push({ field: 'covered', cmd: { ...cmd, lines: [{ ...l1, coveredQ4: 10000n }, l2] } });
      out.push({ field: 'catch-up', cmd: { ...cmd, lines: [{ ...l1, catchUpMinor: -1n }, l2] } });
      out.push({ field: 'line order', cmd: { ...cmd, lines: [l2, l1] } });
      break;
    }
  }
  return out;
}
