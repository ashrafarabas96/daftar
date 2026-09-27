/**
 * P3-S5 — THE SUPPLIER RETURN AND PURCHASE REVERSAL HARNESS
 * (docs/PHASE_3_S5_CONTRACT.md §5, §6; the S4 harness `purchase-commands.ts`
 * extended to the two S5 entry routines).
 *
 * Every helper drives the REAL entry routines through their real boundary: a
 * real `invctl/1` assertion minted with the test key over the `invpl/1`
 * payload the `@daftar/inventory` builders produce, carried in
 * `app.inventory_assertion`, the routine executed as `daftar_app`.
 *
 * - A return is prepared exactly as `PurchaseReturnService` prepares it: the
 *   purchase, its lines with the quantity earlier returns took,
 *   `purchase_ap_outstanding` (A-16), the return key's stock state, then
 *   `planSupplierReturn` with the one conversion (`convertToBaseMinor`) at the
 *   purchase's stored snapshot; its entry is built by the APP's builder
 *   (`supplierReturnPostingCommand`), minted by the real
 *   `mintDomainPostingAssertion` and written by `accounting_post_entry` as
 *   `daftar_app`, in the SAME transaction (A-06).
 * - A reversal is prepared as `PurchaseReversalService` prepares it: the
 *   purchase lines with their stored `purchase` movements, the original
 *   entry read back as persisted, the Phase 2 reversal assertion minted by the
 *   real `mintDomainReversalAssertion`, and posted through
 *   `accounting_post_reversal` as `daftar_app` after the routine (R-B2a).
 *
 * Negative tests depart from the honest command in exactly one way at a time
 * (`S5RunOptions`), the S4 convention.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { convertToBaseMinor, mintDomainReversalAssertion, type PostedEntrySnapshot, type PostedLineSnapshot, type PostingCommand } from '@daftar/accounting';
import {
  InventoryError,
  formatQuantity,
  inventoryPayloadSha256,
  lineGross,
  lineTotals,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  planSupplierReturn,
  purchaseReversePayload,
  supplierReturnPayload,
  toC10,
  toQ4,
  yyyymmdd,
  type InventoryOperationCode,
  type InventoryPayloadField,
  type MovementPayload,
  type SupplierReturnAmounts,
  type SupplierReturnPlan,
} from '../../packages/inventory/src';
import { supplierReturnPostingCommand } from '../../apps/api/src/modules/purchasing/purchase-return-posting';
import { attempt, must, openingCommand, stockState, today, type Outcome, type Queryable, type S3Business } from './inventory-commands';
import { homeBranch, runOpening, testMinter } from './inventory-posting';
import {
  createSupplier,
  draftAndReceive,
  draftCommand,
  postInTx,
  s4Counts,
  type Counts,
  type DraftCommand,
  type DraftLineInput,
  type ReceiptRun,
} from './purchase-commands';
import { enterRate, rateIdFor } from './accounting-fx';
import { mintTestInventoryAssertion } from './test-app';

// ── the S5 catalogue ───────────────────────────────────────────────────────

/** The five S5 document tables (§2.2). */
export const S5_TABLES = ['supplier_returns', 'supplier_return_lines', 'supplier_credit_notes', 'purchase_reversals', 'purchase_reversal_lines'] as const;

/** The two S5 bridges. */
export const S5_BRIDGES = ['stock_source_bridge_supplier_return', 'stock_source_bridge_purchase_reversal'] as const;

/** The two S5 stock source types (0065) and the two operation kinds with their mappings (0066). */
export const S5_SOURCE_TYPES = ['purchase_reversal', 'supplier_return'] as const;
export const S5_OPERATION_KINDS = ['purchase.return', 'purchase.reverse'] as const;
export const S5_OPERATION_MOVEMENT_KINDS: readonly (readonly [op: string, kind: string])[] = [
  ['purchase.return', 'supplier_return'],
  ['purchase.reverse', 'purchase_reversal'],
];

export type S5Kind = 'purchase_return' | 'purchase_reverse';
export const S5_KINDS: readonly S5Kind[] = ['purchase_return', 'purchase_reverse'];

export const S5_OP_OF: Readonly<Record<S5Kind, InventoryOperationCode>> = {
  purchase_return: 'purchase.return',
  purchase_reverse: 'purchase.reverse',
};

/** The two entry routines with their exact signatures (§2.5). */
export const S5_ROUTINE_OF: Readonly<Record<S5Kind, string>> = {
  purchase_return:
    'purchase_return(uuid,uuid,uuid,date,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,bigint,uuid[],uuid[],uuid[],numeric[],bigint[],bigint[])',
  purchase_reverse: 'purchase_reverse(uuid,uuid,date,text,uuid,bigint,uuid[],uuid[],numeric[],bigint[])',
};

/** The three internal helpers (no grant). */
export const S5_HELPERS = ['purchase_lock_stock_keys(uuid,uuid[])', 'purchase_bridge_return(uuid)', 'purchase_bridge_reversal(uuid)'] as const;

/** The two INVOKER read functions: the S6 extension points (A-16). */
export const S5_READ_FUNCTIONS = ['purchase_ap_outstanding(uuid,uuid)', 'purchase_settlement_state(uuid,uuid)'] as const;

// ── the two commands ───────────────────────────────────────────────────────

export interface ReturnLine {
  readonly returnLineId: string;
  readonly purchaseLineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  readonly carryingTxnMinor: bigint;
  readonly valueOutMinor: bigint;
}

export interface ReturnCommand extends SupplierReturnAmounts {
  readonly kind: 'purchase_return';
  readonly returnId: string;
  readonly purchaseId: string;
  readonly warehouseId: string;
  readonly documentDate: string;
  readonly reason: string | null;
  readonly creditNoteId: string | null;
  readonly lines: readonly ReturnLine[];
}

export interface ReverseLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  readonly valueMinor: bigint;
}

export interface ReverseCommand {
  readonly kind: 'purchase_reverse';
  readonly purchaseId: string;
  readonly warehouseId: string;
  readonly reversalDate: string;
  readonly reason: string | null;
  readonly originalEntryId: string | null;
  readonly totalValueMinor: bigint;
  readonly lines: readonly ReverseLine[];
}

export type S5Command = ReturnCommand | ReverseCommand;

type Biz = { readonly tenantId: string; readonly businessId: string };

/** The `invpl/1` payload (and intent) the service would build for this exact command in `biz`. */
export function payloadOf(biz: Biz, cmd: S5Command): MovementPayload {
  const base = { tenantId: biz.tenantId, businessId: biz.businessId };
  if (cmd.kind === 'purchase_return') {
    return supplierReturnPayload({
      ...base,
      returnId: cmd.returnId,
      purchaseId: cmd.purchaseId,
      warehouseId: cmd.warehouseId,
      documentDate: cmd.documentDate,
      reason: cmd.reason,
      creditNoteId: cmd.creditNoteId,
      carryingTxnMinor: cmd.carryingTxnMinor,
      apTxnMinor: cmd.apTxnMinor,
      apBaseMinor: cmd.apBaseMinor,
      creditTxnMinor: cmd.creditTxnMinor,
      creditBaseMinor: cmd.creditBaseMinor,
      inventoryValueMinor: cmd.inventoryValueMinor,
      ppvMinor: cmd.ppvMinor,
      lines: cmd.lines,
    });
  }
  return purchaseReversePayload({
    ...base,
    purchaseId: cmd.purchaseId,
    warehouseId: cmd.warehouseId,
    reversalDate: cmd.reversalDate,
    reason: must(cmd.reason, 'a reversal reason'),
    originalEntryId: must(cmd.originalEntryId, 'the original entry'),
    totalValueMinor: cmd.totalValueMinor,
    lines: cmd.lines,
  });
}

/** The eight reason words of a text, as `inventory_reason_words` derives them (eight NULLs for NULL). */
function words(text: string | null): InventoryPayloadField[] {
  if (text === null) return Array.from({ length: 8 }, (): InventoryPayloadField => ({ kind: 'null' }));
  const d = createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
  return Array.from({ length: 8 }, (_, k): InventoryPayloadField => ({ kind: 'integer', value: BigInt(d.readUInt32BE(k * 4)) }));
}

/**
 * The claimed `invpl/1` stream of a command built field by field, WITHOUT the
 * builders' semantic refusals: the exact digest the routine computes over its
 * own arguments (the S4 `rawPayloadSha256` convention).
 */
export function rawPayloadSha256(biz: Biz, cmd: S5Command): string {
  const u = (value: string | null): InventoryPayloadField => (value === null ? { kind: 'null' } : { kind: 'uuid', value });
  const i = (value: bigint | number | null): InventoryPayloadField => (value === null ? { kind: 'null' } : { kind: 'integer', value });
  let fields: InventoryPayloadField[];
  if (cmd.kind === 'purchase_return') {
    fields = [
      u(cmd.returnId),
      u(cmd.purchaseId),
      u(cmd.warehouseId),
      i(yyyymmdd(cmd.documentDate)),
      ...words(cmd.reason),
      u(cmd.creditNoteId),
      i(cmd.carryingTxnMinor),
      i(cmd.apTxnMinor),
      i(cmd.apBaseMinor),
      i(cmd.creditTxnMinor),
      i(cmd.creditBaseMinor),
      i(cmd.inventoryValueMinor),
      i(cmd.ppvMinor),
      i(cmd.lines.length),
      ...cmd.lines.flatMap((l) => [u(l.returnLineId), u(l.purchaseLineId), u(l.variantId), i(l.qtyQ4), i(l.carryingTxnMinor), i(l.valueOutMinor)]),
    ];
  } else {
    fields = [
      u(cmd.purchaseId),
      u(cmd.warehouseId),
      i(yyyymmdd(cmd.reversalDate)),
      ...words(cmd.reason),
      u(cmd.originalEntryId),
      i(cmd.totalValueMinor),
      i(cmd.lines.length),
      ...cmd.lines.flatMap((l) => [u(l.lineId), u(l.variantId), i(l.qtyQ4), i(l.valueMinor)]),
    ];
  }
  return claimedStreamSha256(S5_OP_OF[cmd.kind], biz.tenantId, biz.businessId, fields);
}

/**
 * The `invpl/1` digest exactly as the SQL canonicalizer (`inventory_payload_digest`,
 * 0054) builds it from the claimed arguments: the header lines, then each
 * field's canonical text — or a single NUL for NULL, whatever the schema's
 * nullability, which only the TS builders enforce — each ending in LF.
 */
function claimedStreamSha256(op: InventoryOperationCode, tenantId: string, businessId: string, fields: readonly InventoryPayloadField[]): string {
  const parts: Buffer[] = [Buffer.from(`invpl/1\n${op}\n${tenantId.toLowerCase()}\n${businessId.toLowerCase()}\n`, 'utf8')];
  for (const f of fields) {
    if (f.kind === 'null') parts.push(Buffer.from([0x00, 0x0a]));
    else if (f.kind === 'integer') parts.push(Buffer.from(`${BigInt(f.value).toString(10)}\n`, 'utf8'));
    else if (f.kind === 'uuid') parts.push(Buffer.from(`${f.value}\n`, 'utf8'));
    else throw new Error(`claimed stream: no ${f.kind} field in an S5 payload`);
  }
  const sha = createHash('sha256').update(Buffer.concat(parts)).digest('hex');
  // Wherever the package encoder accepts the fields, both encoders agree.
  if (fields.every((f) => f.kind !== 'null'))
    expect(sha, 'the claimed stream and the package encoder').toBe(inventoryPayloadSha256(op, tenantId, businessId, fields));
  return sha;
}

/** The routine call — SQL and parameters — for a command, exactly as the services issue it. */
export function callOf(cmd: S5Command): { readonly sql: string; readonly params: unknown[] } {
  if (cmd.kind === 'purchase_return') {
    return {
      sql: `SELECT * FROM purchase_return(
              $1::uuid, $2::uuid, $3::uuid, $4::date, $5::text, $6::uuid, $7::bigint, $8::bigint, $9::bigint, $10::bigint,
              $11::bigint, $12::bigint, $13::bigint, $14::uuid[], $15::uuid[], $16::uuid[], $17::numeric[], $18::bigint[], $19::bigint[])`,
      params: [
        cmd.returnId,
        cmd.purchaseId,
        cmd.warehouseId,
        cmd.documentDate,
        cmd.reason,
        cmd.creditNoteId,
        cmd.carryingTxnMinor.toString(10),
        cmd.apTxnMinor.toString(10),
        cmd.apBaseMinor.toString(10),
        cmd.creditTxnMinor.toString(10),
        cmd.creditBaseMinor.toString(10),
        cmd.inventoryValueMinor.toString(10),
        cmd.ppvMinor.toString(10),
        cmd.lines.map((l) => l.returnLineId),
        cmd.lines.map((l) => l.purchaseLineId),
        cmd.lines.map((l) => l.variantId),
        cmd.lines.map((l) => formatQuantity(l.qtyQ4)),
        cmd.lines.map((l) => l.carryingTxnMinor.toString(10)),
        cmd.lines.map((l) => l.valueOutMinor.toString(10)),
      ],
    };
  }
  return {
    sql: `SELECT * FROM purchase_reverse(
            $1::uuid, $2::uuid, $3::date, $4::text, $5::uuid, $6::bigint, $7::uuid[], $8::uuid[], $9::numeric[], $10::bigint[])`,
    params: [
      cmd.purchaseId,
      cmd.warehouseId,
      cmd.reversalDate,
      cmd.reason,
      cmd.originalEntryId,
      cmd.totalValueMinor.toString(10),
      cmd.lines.map((l) => l.lineId),
      cmd.lines.map((l) => l.variantId),
      cmd.lines.map((l) => formatQuantity(l.qtyQ4)),
      cmd.lines.map((l) => l.valueMinor.toString(10)),
    ],
  };
}

/** One row of `purchase_return(…)` (pg's text for BIGINT/NUMERIC). */
export interface ReturnRow {
  readonly return_id: string;
  readonly replayed: boolean;
  readonly purchase_id: string;
  readonly supplier_id: string;
  readonly warehouse_id: string;
  readonly document_date: Date;
  readonly reason: string | null;
  readonly currency_code: string;
  readonly source_to_base_rate: string;
  readonly carrying_txn_minor: string;
  readonly ap_txn_minor: string;
  readonly ap_base_minor: string;
  readonly ap_dust_base_minor: string;
  readonly ap_released_before_txn_minor: string;
  readonly credit_txn_minor: string;
  readonly credit_base_minor: string;
  readonly inventory_value_base_minor: string;
  readonly ppv_base_minor: string;
  readonly business_transaction_id: string;
  readonly credit_note_id: string | null;
  readonly credit_note_issued_on: Date | null;
  readonly line_id: string;
  readonly line_no: number;
  readonly purchase_line_id: string;
  readonly variant_id: string;
  readonly qty: string;
  readonly line_carrying_txn_minor: string;
  readonly unit_cost_base_minor: string;
  readonly value_out_base_minor: string;
  readonly movement_id: string | null;
  readonly value_delta_base_minor: string | null;
}

/** One row of `purchase_reverse(…)`. */
export interface ReverseRow {
  readonly purchase_id: string;
  readonly replayed: boolean;
  readonly warehouse_id: string;
  readonly original_entry_id: string;
  readonly reversal_date: Date;
  readonly reason: string;
  readonly total_value_base_minor: string;
  readonly business_transaction_id: string;
  readonly line_id: string;
  readonly line_no: number;
  readonly variant_id: string;
  readonly qty: string;
  readonly unit_cost_base_minor: string;
  readonly value_base_minor: string;
  readonly movement_id: string | null;
  readonly value_delta_base_minor: string | null;
}

export type S5Row = ReturnRow | ReverseRow;

export interface S5RunOptions {
  /** Present exactly this assertion (a replay, a forgery); nothing is minted. `null` presents none. */
  readonly assertion?: string | null;
  /** Mint over this command's payload instead (a tampered field). */
  readonly mintFor?: S5Command;
  /** Mint under this operation code instead (a wrong-kind case). */
  readonly op?: InventoryOperationCode;
  /** Mint for this business instead of the calling one. */
  readonly mintBusiness?: Biz;
  /** Run under these scope GUCs instead of the business's own. */
  readonly scope?: Biz;
  /** The business transaction id GUC; a fresh one by default. */
  readonly trace?: string;
  readonly jti?: string;
  /** Digest the claimed arguments field by field (`rawPayloadSha256`), bypassing the builders' refusals. */
  readonly raw?: boolean;
  /** Receives the assertion that was presented. */
  readonly onAssertion?: (assertion: string) => void;
}

/** Mint the assertion the service would mint for `cmd` in `biz`, with `o`'s departures. */
export function assertionFor(biz: Biz & { readonly userId: string }, cmd: S5Command, o: S5RunOptions = {}): string {
  const mintBiz = o.mintBusiness ?? biz;
  const signed = o.mintFor ?? cmd;
  const payloadSha256 = o.raw === true ? rawPayloadSha256(mintBiz, signed) : payloadOf(mintBiz, signed).payload.sha256;
  return mintTestInventoryAssertion({
    actorUserId: biz.userId,
    tenantId: mintBiz.tenantId,
    businessId: mintBiz.businessId,
    opCode: o.op ?? S5_OP_OF[cmd.kind],
    payloadSha256,
    ...(o.jti === undefined ? {} : { jti: o.jti }),
  });
}

/**
 * The trace a command prepared on `q` runs under. One API request is one
 * database transaction under one `app.business_transaction_id` (AL-35), and
 * the S5 guards identify "this transaction" as (`created_at = now()`, trace)
 * (0063 R-36, 0065 R-54). A harness transaction that runs several commands
 * therefore keeps the trace its first command set; outside a transaction
 * (or before any command set one) a fresh trace is minted.
 */
export async function transactionTrace(q: Queryable): Promise<string> {
  const r = await q.query<{ t: string | null }>(`SELECT nullif(current_setting('app.business_transaction_id', true), '') AS t`);
  return r.rows[0]?.t ?? randomUUID();
}

/**
 * The H-1 calling convention in the CALLER's transaction: scope GUCs, trace
 * and carrier, `SET LOCAL ROLE daftar_app`, the entry routine, `RESET ROLE`.
 */
export async function runS5<C extends S5Command>(
  c: Queryable,
  biz: S3Business,
  cmd: C,
  o: S5RunOptions = {},
): Promise<C extends ReturnCommand ? ReturnRow[] : ReverseRow[]> {
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
  const r = await c.query(sql, params);
  await c.query('RESET ROLE');
  return r.rows as C extends ReturnCommand ? ReturnRow[] : ReverseRow[];
}

/** `runS5` inside a savepoint: a refusal leaves the transaction usable. */
export function tryS5<C extends S5Command>(
  c: Queryable,
  biz: S3Business,
  cmd: C,
  o: S5RunOptions = {},
): Promise<Outcome<C extends ReturnCommand ? ReturnRow[] : ReverseRow[]>> {
  return attempt(c, () => runS5(c, biz, cmd, o));
}

// ── received purchases (the S4 harness) ────────────────────────────────────

export interface ReceivedLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly qty: string;
}

export interface ReceivedPurchase {
  readonly purchaseId: string;
  readonly supplierId: string;
  readonly warehouseId: string;
  readonly documentDate: string;
  readonly currency: string;
  readonly lines: readonly ReceivedLine[];
  readonly run: ReceiptRun;
  /** The purchase's journal entry. */
  readonly entryId: string;
}

export interface ReceiveOptions {
  readonly supplierId?: string;
  readonly warehouseId?: string;
  readonly currency?: string;
  readonly documentDate?: string;
  readonly landedCosts?: DraftCommand['landedCosts'];
}

/** Save a draft of `lines` and receive it, in the caller's transaction, through the real S4 routines and entry. */
export async function receivedPurchase(c: Queryable, biz: S3Business, lines: readonly DraftLineInput[], o: ReceiveOptions = {}): Promise<ReceivedPurchase> {
  const supplierId = o.supplierId ?? (await createSupplier(c, biz, { name: 'S5 supplier' }));
  const warehouseId = o.warehouseId ?? biz.w1;
  const draft = await draftCommand(
    c,
    supplierId,
    warehouseId,
    lines.map((l) => ({ ...l, lineId: l.lineId ?? randomUUID() })),
    {
      ...(o.currency === undefined ? {} : { currency: o.currency }),
      ...(o.documentDate === undefined ? {} : { documentDate: o.documentDate }),
      ...(o.landedCosts === undefined ? {} : { landedCosts: o.landedCosts }),
    },
  );
  const run = await draftAndReceive(c, biz, draft);
  return {
    purchaseId: draft.purchaseId,
    supplierId,
    warehouseId,
    documentDate: draft.documentDate,
    currency: draft.currency,
    lines: draft.lines.map((l) => ({ lineId: l.lineId, variantId: l.variantId, qty: l.qty })),
    run,
    entryId: must(run.purchaseEntry, 'the purchase entry').entryId,
  };
}

// ── the return, prepared as PurchaseReturnService prepares it ─────────────

interface PurchaseStateRow {
  status: string;
  warehouse_id: string;
  currency_code: string;
  document_date: string;
  total_txn_minor: string;
  total_base_minor: string;
  rate: string;
  rate_source: 'base' | 'manual';
  rate_timestamp: Date;
  base_currency: string;
  outstanding: string;
}

interface PurchaseLineStateRow {
  id: string;
  variant_id: string;
  qty: string;
  net: string;
  landed: string;
  returned: string;
}

export interface ReturnLineInput {
  readonly purchaseLineId: string;
  /** Decimal text. */
  readonly qty: string;
  readonly returnLineId?: string;
}

export interface ReturnInput {
  readonly warehouseId?: string;
  readonly lines: readonly ReturnLineInput[];
  readonly documentDate?: string;
  readonly reason?: string | null;
  readonly returnId?: string;
  readonly creditNoteId?: string;
  readonly trace?: string;
}

export interface PreparedReturn {
  readonly cmd: ReturnCommand;
  readonly plan: SupplierReturnPlan;
  readonly posting: PostingCommand;
  readonly trace: string;
  /** The purchase warehouse's and the return warehouse's home branches. */
  readonly purchaseBranchId: string;
  readonly returnBranchId: string;
  readonly currency: string;
  readonly baseCurrency: string;
  readonly rate: string;
}

/** The purchase's stored FX snapshot, totals and outstanding AP (as the owner reads them; the INVOKER read function under it). */
export async function purchaseState(q: Queryable, businessId: string, purchaseId: string): Promise<PurchaseStateRow> {
  return must(
    (
      await q.query<PurchaseStateRow>(
        `SELECT p.status, p.warehouse_id::text, p.currency_code::text AS currency_code, to_char(p.document_date, 'YYYY-MM-DD') AS document_date,
                p.total_txn_minor::text AS total_txn_minor, p.total_base_minor::text AS total_base_minor,
                p.source_to_base_rate::text AS rate, p.rate_source, p.rate_timestamp, b.base_currency,
                purchase_ap_outstanding(p.business_id, p.id)::text AS outstanding
           FROM purchases p JOIN businesses b ON b.id = p.business_id
          WHERE p.business_id = $1 AND p.id = $2`,
        [businessId, purchaseId],
      )
    ).rows[0],
    `purchase ${purchaseId}`,
  );
}

/**
 * Prepare a return of `purchaseId` from the stored purchase and the current
 * state, exactly as `PurchaseReturnService.run` steps 3–5 do. Throws the
 * package's `InventoryError` where the service would refuse before minting.
 */
export async function prepareReturn(q: Queryable, biz: S3Business, purchaseId: string, input: ReturnInput): Promise<PreparedReturn> {
  const p = await purchaseState(q, biz.businessId, purchaseId);
  const warehouseId = input.warehouseId ?? p.warehouse_id;
  const stored = (
    await q.query<PurchaseLineStateRow>(
      `SELECT l.id::text, l.variant_id::text, l.qty::text AS qty, l.net_txn_minor::text AS net, l.landed_cost_txn_minor::text AS landed,
              (SELECT coalesce(sum(r.qty), 0)::text FROM supplier_return_lines r
                WHERE r.business_id = l.business_id AND r.purchase_id = l.purchase_id AND r.purchase_line_id = l.id) AS returned
         FROM purchase_lines l WHERE l.business_id = $1 AND l.purchase_id = $2 ORDER BY l.line_no`,
      [biz.businessId, purchaseId],
    )
  ).rows;
  const byId = new Map(stored.map((l) => [l.id, l]));
  const lines = input.lines.map((l) => ({ input: l, line: must(byId.get(l.purchaseLineId), `purchase line ${l.purchaseLineId}`) }));
  const stocks: Awaited<ReturnType<typeof stockState>>[] = [];
  for (const { line } of lines) stocks.push(await stockState(q, biz.businessId, { warehouseId, variantId: line.variant_id }));
  const currency = p.currency_code;
  const baseCurrency = p.base_currency;
  const plan = planSupplierReturn({
    totalTxnMinor: parseMinor(p.total_txn_minor),
    totalBaseMinor: parseMinor(p.total_base_minor),
    outstandingTxnMinor: parseMinor(p.outstanding),
    convert: (txnAmountMinor) => convertToBaseMinor({ txnAmountMinor, txnCurrency: currency, baseCurrency, fxRate: p.rate }),
    lines: lines.map(({ input: l, line }, i) => ({
      lineTotalTxnMinor: parseMinor(line.net) + parseMinor(line.landed),
      purchasedQ4: parseQuantity(line.qty),
      returnedBeforeQ4: parseQuantity(line.returned),
      returnQ4: toQ4(l.qty),
      stock: must(stocks[i]),
    })),
  });
  const trace = input.trace ?? (await transactionTrace(q));
  const returnId = input.returnId ?? randomUUID();
  const documentDate = input.documentDate ?? (await today(q));
  const cmd: ReturnCommand = {
    kind: 'purchase_return',
    returnId,
    purchaseId,
    warehouseId,
    documentDate,
    reason: input.reason === undefined ? null : input.reason,
    creditNoteId: plan.creditNote ? (input.creditNoteId ?? randomUUID()) : null,
    carryingTxnMinor: plan.carryingTxnMinor,
    apTxnMinor: plan.apTxnMinor,
    apBaseMinor: plan.apBaseMinor,
    creditTxnMinor: plan.creditTxnMinor,
    creditBaseMinor: plan.creditBaseMinor,
    inventoryValueMinor: plan.inventoryValueMinor,
    ppvMinor: plan.ppvMinor,
    lines: lines.map(({ input: l, line }, i) => ({
      returnLineId: l.returnLineId ?? randomUUID(),
      purchaseLineId: line.id,
      variantId: line.variant_id,
      qtyQ4: toQ4(l.qty),
      carryingTxnMinor: must(plan.lines[i]).carryingTxnMinor,
      valueOutMinor: must(plan.lines[i]).valueOutMinor,
    })),
  };
  const purchaseBranchId = await homeBranch(q, biz.businessId, p.warehouse_id);
  const returnBranchId = await homeBranch(q, biz.businessId, warehouseId);
  const posting = supplierReturnPostingCommand({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    returnId,
    documentDate,
    currency,
    baseCurrency,
    fx: { rate: p.rate, source: p.rate_source, at: p.rate_timestamp },
    purchaseBranchId,
    returnWarehouseId: warehouseId,
    returnBranchId,
    lines: plan.entryLines,
    businessTransactionId: trace,
  });
  return { cmd, plan, posting, trace, purchaseBranchId, returnBranchId, currency, baseCurrency, rate: p.rate };
}

export interface ReturnRun {
  readonly rows: ReturnRow[];
  readonly entry: { entryId: string; created: boolean } | null;
}

/** One return the way the service runs it (A-06, A-08): the routine, then — unless it answered a replay — the one entry. */
export async function runReturn(c: Queryable, biz: S3Business, p: PreparedReturn, o: S5RunOptions & { readonly posting?: boolean } = {}): Promise<ReturnRun> {
  const rows = await runS5(c, biz, p.cmd, { ...o, trace: o.trace ?? p.trace });
  if (o.posting === false || rows[0]?.replayed === true) return { rows, entry: null };
  return { rows, entry: await postInTx(c, p.posting, biz.userId) };
}

/** `runReturn` inside a savepoint. */
export function tryReturn(
  c: Queryable,
  biz: S3Business,
  p: PreparedReturn,
  o: S5RunOptions & { readonly posting?: boolean } = {},
): Promise<Outcome<ReturnRun>> {
  return attempt(c, () => runReturn(c, biz, p, o));
}

/** Prepare and run a return in one step. */
export async function returnGoods(
  c: Queryable,
  biz: S3Business,
  purchaseId: string,
  input: ReturnInput,
): Promise<{ prepared: PreparedReturn; run: ReturnRun }> {
  const prepared = await prepareReturn(c, biz, purchaseId, input);
  return { prepared, run: await runReturn(c, biz, prepared) };
}

// ── the reversal, prepared as PurchaseReversalService prepares it ─────────

export interface PreparedReversal {
  readonly cmd: ReverseCommand;
  /** The original entry as persisted (the `AccountingLedgerReader.readEntry` read). */
  readonly original: PostedEntrySnapshot;
  readonly trace: string;
}

/** The persisted entry `entryId` as `DatabaseAccountingLedgerReader.readEntry` reads it (as the owner here). */
export async function entrySnapshot(q: Queryable, businessId: string, entryId: string): Promise<PostedEntrySnapshot> {
  const head = must(
    (
      await q.query<{ id: string; tenant_id: string; business_id: string; source_type: string; entry_date: string }>(
        `SELECT id::text, tenant_id::text, business_id::text, source_type, to_char(entry_date, 'YYYY-MM-DD') AS entry_date
           FROM journal_entries WHERE business_id = $1 AND id = $2`,
        [businessId, entryId],
      )
    ).rows[0],
    `entry ${entryId}`,
  );
  const lines = (
    await q.query<{
      line_no: number;
      system_key: string | null;
      code: string;
      debit_minor: string;
      base_amount_minor: string;
      base_currency: string;
      txn_amount_minor: string;
      txn_currency: string;
      fx_rate: string;
      fx_rate_source: string;
      fx_rate_at: Date;
      branch_id: string | null;
      warehouse_id: string | null;
      memo: string | null;
    }>(
      `SELECT l.line_no, a.system_key, a.code, l.debit_minor::text AS debit_minor, l.base_amount_minor::text AS base_amount_minor, l.base_currency,
              l.txn_amount_minor::text AS txn_amount_minor, l.txn_currency, l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
              l.branch_id::text, l.warehouse_id::text, l.memo
         FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
      [businessId, entryId],
    )
  ).rows;
  return {
    entryId: head.id,
    tenantId: head.tenant_id,
    businessId: head.business_id,
    sourceType: head.source_type,
    entryDate: head.entry_date,
    lines: lines.map(
      (r): PostedLineSnapshot => ({
        lineNo: r.line_no,
        account: r.system_key !== null ? { kind: 'system', systemKey: r.system_key } : { kind: 'code', code: r.code },
        side: BigInt(r.debit_minor) > 0n ? 'D' : 'C',
        baseAmountMinor: BigInt(r.base_amount_minor),
        baseCurrency: r.base_currency,
        txnAmountMinor: BigInt(r.txn_amount_minor),
        txnCurrency: r.txn_currency,
        fxRate: r.fx_rate,
        fxRateSource: r.fx_rate_source,
        fxRateAt: r.fx_rate_at,
        branchId: r.branch_id,
        warehouseId: r.warehouse_id,
        memo: r.memo,
      }),
    ),
  };
}

/** The stored purchase lines with their `purchase` movement values `s_i`, in `line_no` order (the A-07 reversal binding). */
export async function purchaseMovementLines(q: Queryable, businessId: string, purchaseId: string): Promise<ReverseLine[]> {
  const r = await q.query<{ id: string; variant_id: string; qty: string; value: string }>(
    `SELECT l.id::text, l.variant_id::text, l.qty::text AS qty, m.value_delta_base_minor::text AS value
       FROM purchase_lines l
       JOIN stock_movements m ON m.business_id = l.business_id AND m.source_type = 'purchase' AND m.source_id = l.purchase_id
                             AND m.source_line_id = l.id AND m.movement_kind = 'purchase'
      WHERE l.business_id = $1 AND l.purchase_id = $2 ORDER BY l.line_no`,
    [businessId, purchaseId],
  );
  return r.rows.map((x) => ({ lineId: x.id, variantId: x.variant_id, qtyQ4: parseQuantity(x.qty), valueMinor: parseMinor(x.value) }));
}

/** The purchase's journal entry id through its accounting binding, or null. */
export async function purchaseEntryId(q: Queryable, businessId: string, purchaseId: string): Promise<string | null> {
  const r = await q.query<{ id: string }>(
    `SELECT journal_entry_id::text AS id FROM accounting_source_bindings WHERE business_id = $1 AND source_type = 'purchase' AND source_id = $2`,
    [businessId, purchaseId],
  );
  return r.rows[0]?.id ?? null;
}

/** Prepare the reversal of `purchaseId` as `PurchaseReversalService.run` steps 1–5 do. */
export async function prepareReversal(
  q: Queryable,
  biz: S3Business,
  purchaseId: string,
  o: { readonly reversalDate?: string; readonly reason?: string | null; readonly trace?: string } = {},
): Promise<PreparedReversal> {
  const p = await purchaseState(q, biz.businessId, purchaseId);
  const originalEntryId = must(await purchaseEntryId(q, biz.businessId, purchaseId), 'the purchase entry');
  const lines = await purchaseMovementLines(q, biz.businessId, purchaseId);
  const cmd: ReverseCommand = {
    kind: 'purchase_reverse',
    purchaseId,
    warehouseId: p.warehouse_id,
    reversalDate: o.reversalDate ?? (await today(q)),
    reason: o.reason === undefined ? 'Received against the wrong supplier' : o.reason,
    originalEntryId,
    totalValueMinor: parseMinor(p.total_base_minor),
    lines,
  };
  return { cmd, original: await entrySnapshot(q, biz.businessId, originalEntryId), trace: o.trace ?? (await transactionTrace(q)) };
}

/** The Phase 2 reversal assertion `purchase.reverse` mints (the real `mintDomainReversalAssertion`, R-B2a). */
export function reversalAssertion(biz: S3Business, p: PreparedReversal): string {
  return mintDomainReversalAssertion(testMinter, p.original, p.cmd.reversalDate, biz.userId);
}

/**
 * `postReversalInTransaction`: `accounting_post_reversal` as `daftar_app` in
 * the caller's transaction, under the reversal assertion (by default the one
 * `mintDomainReversalAssertion` mints).
 */
export async function postReversalInTx(c: Queryable, biz: S3Business, p: PreparedReversal, assertion?: string): Promise<{ entryId: string; created: boolean }> {
  await c.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion ?? reversalAssertion(biz, p)]);
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_reversal($1::uuid, $2::date, $3, $4)`, [
    p.cmd.originalEntryId,
    p.cmd.reversalDate,
    p.cmd.reason,
    p.trace,
  ]);
  await c.query('RESET ROLE');
  const row = must(r.rows[0], 'accounting_post_reversal row');
  return { entryId: row.entry_id, created: row.created };
}

export interface ReversalRun {
  readonly rows: ReverseRow[];
  readonly entry: { entryId: string; created: boolean } | null;
}

/** One reversal the way the service runs it: the routine, then — unless it answered a replay — the Phase 2 reversal. */
export async function runReversal(
  c: Queryable,
  biz: S3Business,
  p: PreparedReversal,
  o: S5RunOptions & { readonly posting?: boolean } = {},
): Promise<ReversalRun> {
  const rows = await runS5(c, biz, p.cmd, { ...o, trace: o.trace ?? p.trace });
  if (o.posting === false || rows[0]?.replayed === true) return { rows, entry: null };
  return { rows, entry: await postReversalInTx(c, biz, p) };
}

/** `runReversal` inside a savepoint. */
export function tryReversal(
  c: Queryable,
  biz: S3Business,
  p: PreparedReversal,
  o: S5RunOptions & { readonly posting?: boolean } = {},
): Promise<Outcome<ReversalRun>> {
  return attempt(c, () => runReversal(c, biz, p, o));
}

// ── counters and reads (as the owner) ──────────────────────────────────────

/** `s4Counts` plus every S5 table and bridge and a digest of the credit notes' remaining values. */
export async function s5Counts(q: Queryable, businessId: string): Promise<Counts> {
  const s4 = await s4Counts(q, businessId);
  const tables = [...S5_TABLES, ...S5_BRIDGES, 'accounting_reversals'];
  const r = await q.query<Record<string, number | string>>(
    `SELECT ${tables.map((t) => `(SELECT count(*)::int FROM ${t} WHERE business_id = $1) AS ${t}`).join(', ')},
            (SELECT coalesce(md5(string_agg(concat_ws('|', id, remaining_amount_minor, remaining_carrying_base_amount_minor), ',' ORDER BY id)), '')
               FROM supplier_credit_notes WHERE business_id = $1) AS credit_notes_state`,
    [businessId],
  );
  return { ...s4, ...must(r.rows[0], 's5 counts') };
}

export interface EntryLine {
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
export async function entryBySource(
  q: Queryable,
  businessId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ id: string; entry_date: string; lines: EntryLine[] } | null> {
  const e = (
    await q.query<{ id: string; entry_date: string }>(
      `SELECT id::text, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM journal_entries WHERE business_id = $1 AND source_type = $2 AND source_id = $3`,
      [businessId, sourceType, sourceId],
    )
  ).rows[0];
  if (e === undefined) return null;
  return { ...e, lines: await entryLinesOf(q, businessId, e.id) };
}

export async function entryLinesOf(q: Queryable, businessId: string, entryId: string): Promise<EntryLine[]> {
  return (
    await q.query<EntryLine>(
      `SELECT a.system_key, a.code, l.debit_minor::text AS debit, l.credit_minor::text AS credit, l.txn_amount_minor::text AS txn_amount,
              l.txn_currency::text AS txn_currency, l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
              l.warehouse_id::text, l.branch_id::text
         FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
      [businessId, entryId],
    )
  ).rows;
}

/** The Phase 2 reversal of `originalEntryId`: its `accounting_reversals` row and its entry, or null. */
export async function reversalOf(
  q: Queryable,
  businessId: string,
  originalEntryId: string,
): Promise<{ entryId: string; entryDate: string; sourceType: string; sourceId: string; lines: EntryLine[] } | null> {
  const r = (
    await q.query<{ id: string; entry_date: string; source_type: string; source_id: string }>(
      `SELECT je.id::text, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date, je.source_type, je.source_id::text
         FROM accounting_reversals ar JOIN journal_entries je ON je.business_id = ar.business_id AND je.id = ar.journal_entry_id
        WHERE ar.business_id = $1 AND ar.original_entry_id = $2`,
      [businessId, originalEntryId],
    )
  ).rows[0];
  if (r === undefined) return null;
  return { entryId: r.id, entryDate: r.entry_date, sourceType: r.source_type, sourceId: r.source_id, lines: await entryLinesOf(q, businessId, r.id) };
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

/** The ledger AP of one purchase (credit − debit), over its entry, its returns' entries and its Phase 2 reversal (A-19). */
export async function purchaseLedgerAp(q: Queryable, businessId: string, purchaseId: string): Promise<{ base: bigint; txn: bigint }> {
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
            WHERE ar.business_id = $1 AND pb.source_type = 'purchase' AND pb.source_id = $2)
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

/** The stored header of a return (as the owner). */
export async function returnHeader(q: Queryable, businessId: string, returnId: string): Promise<Record<string, string | null> | null> {
  const r = await q.query<Record<string, string | null>>(
    `SELECT id::text, purchase_id::text, supplier_id::text, warehouse_id::text, currency_code::text AS currency_code,
            source_to_base_rate::text AS rate, to_char(document_date, 'YYYY-MM-DD') AS document_date, reason, credit_note_id::text,
            carrying_txn_minor::text AS carrying, ap_txn_minor::text AS ap_txn, ap_base_minor::text AS ap_base,
            ap_dust_base_minor::text AS ap_dust, credit_txn_minor::text AS credit_txn, credit_base_minor::text AS credit_base,
            inventory_value_base_minor::text AS inventory, ppv_base_minor::text AS ppv
       FROM supplier_returns WHERE business_id = $1 AND id = $2`,
    [businessId, returnId],
  );
  return r.rows[0] ?? null;
}

/** The stored credit note of a return (as the owner), or null. */
export async function creditNoteOf(q: Queryable, businessId: string, returnId: string): Promise<Record<string, string | null> | null> {
  const r = await q.query<Record<string, string | null>>(
    `SELECT id::text, supplier_id::text, currency_code::text AS currency_code,
            original_amount_minor::text AS original_txn, remaining_amount_minor::text AS remaining_txn,
            original_carrying_base_amount_minor::text AS original_base, remaining_carrying_base_amount_minor::text AS remaining_base,
            source_to_base_rate::text AS rate, rate_source, to_char(issued_on, 'YYYY-MM-DD') AS issued_on
       FROM supplier_credit_notes WHERE business_id = $1 AND supplier_return_id = $2`,
    [businessId, returnId],
  );
  return r.rows[0] ?? null;
}

/** The stored movements of a document by source type and id, in source-line order of their document. */
export async function movementsOfSource(
  q: Queryable,
  businessId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ source_line_id: string; kind: string; qty: string; unit_cost: string | null; value: string; warehouse_id: string; variant_id: string }[]> {
  return (
    await q.query<{ source_line_id: string; kind: string; qty: string; unit_cost: string | null; value: string; warehouse_id: string; variant_id: string }>(
      `SELECT source_line_id::text, movement_kind AS kind, qty_delta::text AS qty, unit_cost_base_minor::text AS unit_cost,
              value_delta_base_minor::text AS value, warehouse_id::text, variant_id::text
         FROM stock_movements WHERE business_id = $1 AND source_type = $2 AND source_id = $3 ORDER BY stock_seq`,
      [businessId, sourceType, sourceId],
    )
  ).rows;
}

/** Σ stored movement values, the stock cache and GL Inventory for the whole business: the three must agree (PM-16). */
export async function threeWay(q: Queryable, businessId: string): Promise<{ gl: bigint; movements: bigint; cache: bigint }> {
  const r = must(
    (
      await q.query<{ gl: string; movements: string; cache: string }>(
        `SELECT (SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0) FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
                  WHERE l.business_id = $1 AND a.system_key = 'inventory')::text AS gl,
                (SELECT coalesce(sum(value_delta_base_minor), 0) FROM stock_movements WHERE business_id = $1)::text AS movements,
                (SELECT coalesce(sum(valuation_base_minor), 0) FROM stock_levels WHERE business_id = $1)::text AS cache`,
        [businessId],
      )
    ).rows[0],
  );
  return { gl: BigInt(r.gl), movements: BigInt(r.movements), cache: BigInt(r.cache) };
}

/** The entry of a return as `(system_key, side, txn currency, txn, base, rate, dimension)` rows — the vectors' shape. */
export function entryShape(
  lines: readonly EntryLine[],
  purchaseBranchId: string,
  returnWarehouseId: string,
  returnBranchId: string,
): { systemKey: string | null; side: 'D' | 'C'; currency: string; txnAmountMinor: string; baseAmountMinor: string; rate: string; dimension: string }[] {
  return lines.map((l) => {
    const debit = BigInt(l.debit) > 0n;
    let dimension = 'unexpected';
    if (l.warehouse_id === null && l.branch_id === purchaseBranchId) dimension = 'purchase';
    if (l.warehouse_id === returnWarehouseId && l.branch_id === returnBranchId) dimension = 'return';
    return {
      systemKey: l.system_key,
      side: debit ? 'D' : 'C',
      currency: l.txn_currency,
      txnAmountMinor: l.txn_amount,
      baseAmountMinor: debit ? l.debit : l.credit,
      rate: l.fx_rate,
      dimension,
    };
  });
}

// ── the S5 vectors (packages/inventory/vectors/*-s5, supplier-return) ──────

export interface VectorStock {
  readonly onHand: string;
  readonly valuation: string;
  readonly avg: string | null;
}

export interface SupplierReturnVectorLine {
  readonly lineNo: number;
  readonly qty: string;
  readonly netTxnMinor: string;
  readonly landedTxnMinor: string;
  readonly lineTotalTxnMinor: string;
  readonly baseShareMinor: string;
  readonly unitCostBaseMinor: string;
  readonly openingBefore: { readonly qty: string; readonly unitCost: string } | null;
  readonly stockAfterReceipt: VectorStock;
}

export interface SupplierReturnVectorEntryLine {
  readonly systemKey: string;
  readonly side: 'D' | 'C';
  readonly currency: string;
  readonly txnAmountMinor: string;
  readonly baseAmountMinor: string;
  readonly rate: string;
  readonly dimension: 'purchase' | 'return';
}

export interface SupplierReturnVectorExpect {
  readonly lines: readonly {
    readonly lineNo: number;
    readonly returnedBefore: string;
    readonly carryingTxnMinor: string;
    readonly valueOutMinor: string;
    readonly unitCostBaseMinor: string;
    readonly stockAfter: VectorStock;
  }[];
  readonly carryingTxnMinor: string;
  readonly apTxnMinor: string;
  readonly apBaseMinor: string;
  readonly apConvertedMinor: string;
  readonly apDustBaseMinor: string;
  readonly creditTxnMinor: string;
  readonly creditBaseMinor: string;
  readonly inventoryValueMinor: string;
  readonly ppvMinor: string;
  readonly creditNote: boolean;
  readonly entry: readonly SupplierReturnVectorEntryLine[];
}

export interface SupplierReturnVectorReturn {
  readonly outstanding: { readonly source: 'derived' | 'fixture'; readonly txnMinor: string };
  readonly lines: readonly { readonly lineNo: number; readonly qty: string }[];
  readonly outcome: string;
  readonly expect: SupplierReturnVectorExpect | null;
}

export interface SupplierReturnVector {
  readonly id: string;
  readonly why: string;
  readonly purchase: {
    readonly txnCurrency: string;
    readonly txnMinorUnits: number;
    readonly baseCurrency: string;
    readonly baseMinorUnits: number;
    readonly rate: string;
    readonly totalTxnMinor: string;
    readonly totalBaseMinor: string;
    readonly lines: readonly SupplierReturnVectorLine[];
  };
  readonly returns: readonly SupplierReturnVectorReturn[];
  readonly totals: { readonly apTxnMinor: string; readonly apBaseMinor: string; readonly creditTxnMinor: string; readonly creditBaseMinor: string };
  readonly naiveProportionalPlusFlush?: readonly string[];
}

/** The supplier-return vectors, read from the package (never restated here). */
export function supplierReturnVectors(): readonly SupplierReturnVector[] {
  return (
    JSON.parse(readFileSync(join(__dirname, '../../packages/inventory/vectors/supplier-return-vectors.json'), 'utf8')) as { cases: SupplierReturnVector[] }
  ).cases;
}

export function supplierReturnVector(id: string): SupplierReturnVector {
  return must(
    supplierReturnVectors().find((v) => v.id === id),
    `supplier-return vector ${id}`,
  );
}

export interface InvplS5Field {
  readonly name: string;
  readonly type: 'uuid' | 'integer' | 'code';
  readonly value: string | null;
}

export interface InvplS5Vector {
  readonly id: string;
  readonly why: string;
  readonly opCode: 'purchase.return' | 'purchase.reverse';
  readonly tenantId: string;
  readonly businessId: string;
  readonly routine: { readonly name: string; readonly args: Readonly<Record<string, string | null | readonly string[]>> };
  readonly payload: { readonly fields: readonly InvplS5Field[]; readonly canonicalHex: string; readonly sha256: string };
  readonly intent: { readonly fields: readonly InvplS5Field[]; readonly canonicalHex: string; readonly sha256: string };
}

/** The `invpl/1` S5 vectors, read from the package. */
export function invplS5Vectors(): readonly InvplS5Vector[] {
  return (JSON.parse(readFileSync(join(__dirname, '../../packages/inventory/vectors/invpl-s5-vectors.json'), 'utf8')) as { cases: InvplS5Vector[] }).cases;
}

/**
 * The whole-quantity and fractional variants of `biz`, in the order a vector's
 * lines take them: a fractional quantity goes to the two-decimal product, a
 * whole one to `piece`, `piece2` and the variant product's two variants.
 */
function vectorVariants(biz: S3Business, lines: readonly { readonly qty: string }[]): string[] {
  const whole = [biz.piece.variantId, biz.piece2.variantId, ...biz.variantProduct.variantIds];
  let decimalUsed = false;
  return lines.map((l) => {
    if (!/\.0+$/.test(l.qty) && l.qty.includes('.')) {
      if (decimalUsed) throw new Error('vector purchase: one fractional line per purchase');
      decimalUsed = true;
      return biz.dec2.variantId;
    }
    return must(whole.shift(), 'vector purchase: at most four whole-quantity lines');
  });
}

/**
 * A draft line whose stored net is exactly `netMinor`: a whole unit price
 * large enough that the gross covers the net, the rest as the discount — the
 * package's own `lineGross` decides the gross.
 */
function netLine(variantId: string, qty: string, netMinor: bigint): DraftLineInput {
  const q4 = toQ4(qty);
  const price = (netMinor * 10_000n + q4 - 1n) / q4 + 1n;
  const gross = lineGross(q4, toC10(price.toString(10)));
  if (gross < netMinor) throw new Error('vector purchase: the gross does not cover the net');
  return { variantId, qty, unitPriceMinor: price.toString(10), discountMinor: gross - netMinor };
}

export interface VectorPurchase extends ReceivedPurchase {
  /** The purchase line id of each vector `lineNo`. */
  readonly lineIdOf: (lineNo: number) => string;
  readonly variantOf: (lineNo: number) => string;
}

/**
 * Receive a supplier-return vector's purchase on `warehouseId` of `biz`, in the
 * caller's transaction: each line's key first holds the vector's
 * `openingBefore` (a Case A S3 opening at that unit cost), then the receipt.
 * The draft states the vector's net and landed amounts exactly; the received
 * totals, shares and keys are checked against the vector before returning.
 * A foreign purchase needs its rate in force at `documentDate`.
 */
export async function vectorPurchase(
  c: Queryable,
  biz: S3Business,
  v: SupplierReturnVector,
  o: { readonly warehouseId?: string; readonly documentDate?: string; readonly supplierId?: string } = {},
): Promise<VectorPurchase> {
  const warehouseId = o.warehouseId ?? biz.w1;
  const documentDate = o.documentDate ?? (await today(c));
  const variants = vectorVariants(biz, v.purchase.lines);
  for (const [i, l] of v.purchase.lines.entries()) {
    if (l.openingBefore === null) continue;
    await runOpening(
      c,
      biz,
      openingCommand(documentDate, [{ warehouseId, variantId: must(variants[i]), qty: l.openingBefore.qty, unitCost: l.openingBefore.unitCost }]),
    );
  }
  const landed = v.purchase.lines.map((l) => BigInt(l.landedTxnMinor));
  const landedTotal = landed.reduce((a, b) => a + b, 0n);
  const lines = v.purchase.lines.map((l, i) => netLine(must(variants[i]), l.qty, BigInt(l.netTxnMinor)));
  const totals = lineTotals(
    lines.map((l) => ({ qtyQ4: toQ4(l.qty), unitPriceC10: toC10(l.unitPriceMinor), discountMinor: l.discountMinor ?? 0n })),
    landedTotal === 0n ? [] : [{ mode: 'manual', amountMinor: landedTotal, allocations: landed }],
  );
  expect(
    totals.lines.map((t) => t.netMinor.toString(10)),
    `${v.id}: the drafted nets`,
  ).toEqual(v.purchase.lines.map((l) => l.netTxnMinor));
  const received = await receivedPurchase(c, biz, lines, {
    warehouseId,
    documentDate,
    currency: v.purchase.txnCurrency,
    ...(o.supplierId === undefined ? {} : { supplierId: o.supplierId }),
    landedCosts:
      landedTotal === 0n ? [] : [{ landedCostId: randomUUID(), mode: 'manual', amountMinor: landedTotal, description: 'freight', allocations: landed }],
  });
  const stored = await c.query<{ t: string; b: string; rate: string }>(
    `SELECT total_txn_minor::text AS t, total_base_minor::text AS b, source_to_base_rate::text AS rate FROM purchases WHERE business_id = $1 AND id = $2`,
    [biz.businessId, received.purchaseId],
  );
  expect(must(stored.rows[0]), `${v.id}: the received totals`).toEqual({ t: v.purchase.totalTxnMinor, b: v.purchase.totalBaseMinor, rate: v.purchase.rate });
  const shares = await c.query<{ s: string; t: string }>(
    `SELECT base_share_minor::text AS s, (net_txn_minor + landed_cost_txn_minor)::text AS t FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 ORDER BY line_no`,
    [biz.businessId, received.purchaseId],
  );
  expect(shares.rows, `${v.id}: the line totals and shares`).toEqual(v.purchase.lines.map((l) => ({ s: l.baseShareMinor, t: l.lineTotalTxnMinor })));
  for (const [i, l] of v.purchase.lines.entries()) {
    const s = await stockState(c, biz.businessId, { warehouseId, variantId: must(variants[i]) });
    expect(
      { onHand: formatQuantity(s.onHand), valuation: s.valuation.toString(10), avg: s.avg === null ? null : parseUnitCostText(s.avg) },
      `${v.id}: line ${l.lineNo} stock after the receipt`,
    ).toEqual(l.stockAfterReceipt);
  }
  const ids = received.lines.map((l) => l.lineId);
  return {
    ...received,
    lineIdOf: (lineNo) => must(ids[lineNo - 1], `vector line ${lineNo}`),
    variantOf: (lineNo) => must(variants[lineNo - 1], `vector line ${lineNo}`),
  };
}

/** A C10 unit cost as `NUMERIC(28,10)` text. */
export function parseUnitCostText(c10: bigint): string {
  const neg = c10 < 0n;
  const abs = neg ? -c10 : c10;
  const s = abs.toString(10).padStart(11, '0');
  return `${neg ? '-' : ''}${s.slice(0, -10)}.${s.slice(-10)}`;
}

/** The vector's expected stock state of a key, from a stored level. */
export async function vectorStockOf(q: Queryable, businessId: string, warehouseId: string, variantId: string): Promise<VectorStock> {
  const s = await stockState(q, businessId, { warehouseId, variantId });
  return { onHand: formatQuantity(s.onHand), valuation: s.valuation.toString(10), avg: s.avg === null ? null : parseUnitCostText(s.avg) };
}

/** Re-export for suites that parse stored unit costs. */
export { parseUnitCost };

// ── vector parity (TS plan ↔ vector ↔ stored rows) ─────────────────────────

/** The amounts of a return in the vectors' decimal-text shape. */
export interface ReturnAmountsText {
  readonly carryingTxnMinor: string;
  readonly apTxnMinor: string;
  readonly apBaseMinor: string;
  readonly apDustBaseMinor: string;
  readonly creditTxnMinor: string;
  readonly creditBaseMinor: string;
  readonly inventoryValueMinor: string;
  readonly ppvMinor: string;
  readonly creditNote: boolean;
  readonly lines: readonly { readonly carryingTxnMinor: string; readonly valueOutMinor: string; readonly unitCostBaseMinor: string }[];
}

/** A vector's expected return, in `ReturnAmountsText` shape. */
export function vectorAmounts(e: SupplierReturnVectorExpect): ReturnAmountsText {
  return {
    carryingTxnMinor: e.carryingTxnMinor,
    apTxnMinor: e.apTxnMinor,
    apBaseMinor: e.apBaseMinor,
    apDustBaseMinor: e.apDustBaseMinor,
    creditTxnMinor: e.creditTxnMinor,
    creditBaseMinor: e.creditBaseMinor,
    inventoryValueMinor: e.inventoryValueMinor,
    ppvMinor: e.ppvMinor,
    creditNote: e.creditNote,
    lines: e.lines.map((l) => ({ carryingTxnMinor: l.carryingTxnMinor, valueOutMinor: l.valueOutMinor, unitCostBaseMinor: l.unitCostBaseMinor })),
  };
}

/** The package plan, in `ReturnAmountsText` shape (the TS side of parity). */
export function planAmounts(p: SupplierReturnPlan): ReturnAmountsText {
  return {
    carryingTxnMinor: p.carryingTxnMinor.toString(10),
    apTxnMinor: p.apTxnMinor.toString(10),
    apBaseMinor: p.apBaseMinor.toString(10),
    apDustBaseMinor: p.apDustBaseMinor.toString(10),
    creditTxnMinor: p.creditTxnMinor.toString(10),
    creditBaseMinor: p.creditBaseMinor.toString(10),
    inventoryValueMinor: p.inventoryValueMinor.toString(10),
    ppvMinor: p.ppvMinor.toString(10),
    creditNote: p.creditNote,
    lines: p.lines.map((l) => ({
      carryingTxnMinor: l.carryingTxnMinor.toString(10),
      valueOutMinor: l.valueOutMinor.toString(10),
      unitCostBaseMinor: parseUnitCostText(l.unitCostSnapshotC10),
    })),
  };
}

/** The stored return, header and lines, in `ReturnAmountsText` shape (the SQL side of parity). */
export async function storedAmounts(q: Queryable, businessId: string, returnId: string): Promise<ReturnAmountsText> {
  const h = must(
    (
      await q.query<{
        carrying: string;
        ap_txn: string;
        ap_base: string;
        ap_dust: string;
        credit_txn: string;
        credit_base: string;
        inventory: string;
        ppv: string;
        note: boolean;
      }>(
        `SELECT carrying_txn_minor::text AS carrying, ap_txn_minor::text AS ap_txn, ap_base_minor::text AS ap_base, ap_dust_base_minor::text AS ap_dust,
                credit_txn_minor::text AS credit_txn, credit_base_minor::text AS credit_base, inventory_value_base_minor::text AS inventory,
                ppv_base_minor::text AS ppv, credit_note_id IS NOT NULL AS note
           FROM supplier_returns WHERE business_id = $1 AND id = $2`,
        [businessId, returnId],
      )
    ).rows[0],
    `return ${returnId}`,
  );
  const lines = await q.query<{ c: string; o: string; u: string }>(
    `SELECT carrying_txn_minor::text AS c, value_out_base_minor::text AS o, unit_cost_base_minor::text AS u
       FROM supplier_return_lines WHERE business_id = $1 AND return_id = $2 ORDER BY line_no`,
    [businessId, returnId],
  );
  return {
    carryingTxnMinor: h.carrying,
    apTxnMinor: h.ap_txn,
    apBaseMinor: h.ap_base,
    apDustBaseMinor: h.ap_dust,
    creditTxnMinor: h.credit_txn,
    creditBaseMinor: h.credit_base,
    inventoryValueMinor: h.inventory,
    ppvMinor: h.ppv,
    creditNote: h.note,
    lines: lines.rows.map((l) => ({ carryingTxnMinor: l.c, valueOutMinor: l.o, unitCostBaseMinor: l.u })),
  };
}

/**
 * A return command with every amount zero and no credit note: the claimed
 * arguments reach the routine's own line and A-10 checks (signed with
 * `raw: true`), which refuse before any amount is compared.
 */
export function zeroReturn(
  purchaseId: string,
  warehouseId: string,
  documentDate: string,
  lines: readonly { readonly purchaseLineId: string; readonly variantId: string; readonly qty: string }[],
  o: { readonly returnId?: string; readonly creditNoteId?: string | null } = {},
): ReturnCommand {
  return {
    kind: 'purchase_return',
    returnId: o.returnId ?? randomUUID(),
    purchaseId,
    warehouseId,
    documentDate,
    reason: null,
    creditNoteId: o.creditNoteId ?? null,
    carryingTxnMinor: 0n,
    apTxnMinor: 0n,
    apBaseMinor: 0n,
    creditTxnMinor: 0n,
    creditBaseMinor: 0n,
    inventoryValueMinor: 0n,
    ppvMinor: 0n,
    lines: lines.map((l) => ({
      returnLineId: randomUUID(),
      purchaseLineId: l.purchaseLineId,
      variantId: l.variantId,
      qtyQ4: toQ4(l.qty),
      carryingTxnMinor: 0n,
      valueOutMinor: 0n,
    })),
  };
}

/** The system accounts a return entry may touch (A-05, A-14): never 6100, revenue or tax. */
export const RETURN_ACCOUNTS = ['accounts_payable', 'supplier_receivable', 'inventory', 'purchase_price_variance'] as const;

/** The package refusal code a preparation throws (`InventoryError`); anything else is rethrown, and success fails. */
export async function preparationRefusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  throw new Error('expected the preparation to refuse, but it succeeded');
}

/**
 * Enter a committed `from → ILS` rate for `biz` through the real FX control
 * boundary, effective from `effectiveAt` (an ISO instant).
 */
export async function foreignRate(biz: S3Business, from: string, rate: string, effectiveAt: string): Promise<string> {
  const r = await enterRate(
    {
      tenantId: biz.tenantId,
      businessId: biz.businessId,
      rateId: rateIdFor(biz.businessId, randomUUID()),
      fromCurrency: from,
      toCurrency: 'ILS',
      rate,
      effectiveAt,
    },
    biz.userId,
  );
  expect(r.created, `${from} ${rate} from ${effectiveAt}`).toBe(true);
  return r.rateId;
}

/**
 * The rates the S5 vectors assume, entered once per business: USD 3.6725 and
 * JOD 5.1 from 2026-01-01, JOD 4.9 from 2026-03-01. A vector purchase is dated
 * by `vectorDocumentDate` so that exactly its rate is in force.
 */
export async function vectorRates(biz: S3Business): Promise<void> {
  await foreignRate(biz, 'USD', '3.6725', '2026-01-01T00:00:00Z');
  await foreignRate(biz, 'JOD', '5.1', '2026-01-01T00:00:00Z');
  await foreignRate(biz, 'JOD', '4.9', '2026-03-01T00:00:00Z');
}

/** The document date of a vector's purchase under `vectorRates`. */
export function vectorDocumentDate(v: SupplierReturnVector): string {
  if (v.purchase.txnCurrency === 'ILS') return '2026-04-01';
  if (v.purchase.txnCurrency === 'USD' && v.purchase.rate === '3.6725000000') return '2026-01-15';
  if (v.purchase.txnCurrency === 'JOD' && v.purchase.rate === '5.1000000000') return '2026-01-15';
  if (v.purchase.txnCurrency === 'JOD' && v.purchase.rate === '4.9000000000') return '2026-03-15';
  throw new Error(`no rate is entered for ${v.id} (${v.purchase.txnCurrency} at ${v.purchase.rate})`);
}

/** The command an `invpl-s5` vector's routine arguments describe. */
export function commandOfVector(v: InvplS5Vector): S5Command {
  const a = v.routine.args;
  const text = (k: string): string | null => {
    const x = a[k];
    if (x !== null && typeof x !== 'string') throw new Error(`${v.id}: ${k} is not a scalar`);
    return x ?? null;
  };
  const req = (k: string): string => must(text(k), `${v.id}: ${k}`);
  const list = (k: string): readonly string[] => {
    const x = a[k];
    if (x === undefined || x === null || typeof x === 'string') throw new Error(`${v.id}: ${k} is not a list`);
    return x;
  };
  if (v.opCode === 'purchase.return') {
    const ids = list('p_line_ids');
    return {
      kind: 'purchase_return',
      returnId: req('p_return_id'),
      purchaseId: req('p_purchase_id'),
      warehouseId: req('p_warehouse_id'),
      documentDate: req('p_document_date'),
      reason: text('p_reason'),
      creditNoteId: text('p_credit_note_id'),
      carryingTxnMinor: BigInt(req('p_carrying_txn_minor')),
      apTxnMinor: BigInt(req('p_ap_txn_minor')),
      apBaseMinor: BigInt(req('p_ap_base_minor')),
      creditTxnMinor: BigInt(req('p_credit_txn_minor')),
      creditBaseMinor: BigInt(req('p_credit_base_minor')),
      inventoryValueMinor: BigInt(req('p_inventory_value_base_minor')),
      ppvMinor: BigInt(req('p_ppv_base_minor')),
      lines: ids.map((id, i) => ({
        returnLineId: id,
        purchaseLineId: must(list('p_purchase_line_ids')[i]),
        variantId: must(list('p_variant_ids')[i]),
        qtyQ4: toQ4(must(list('p_qtys')[i])),
        carryingTxnMinor: BigInt(must(list('p_carrying_txns')[i])),
        valueOutMinor: BigInt(must(list('p_values_out')[i])),
      })),
    };
  }
  const ids = list('p_line_ids');
  return {
    kind: 'purchase_reverse',
    purchaseId: req('p_purchase_id'),
    warehouseId: req('p_warehouse_id'),
    reversalDate: req('p_reversal_date'),
    reason: text('p_reason'),
    originalEntryId: text('p_original_entry_id'),
    totalValueMinor: BigInt(req('p_total_value_base_minor')),
    lines: ids.map((id, i) => ({
      lineId: id,
      variantId: must(list('p_variant_ids')[i]),
      qtyQ4: toQ4(must(list('p_qtys')[i])),
      valueMinor: BigInt(must(list('p_values')[i])),
    })),
  };
}
