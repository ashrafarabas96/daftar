/**
 * P3-S3 — THE MOVEMENT-COMMAND HARNESS (docs/PHASE_3_S3_CONTRACT.md §5, H-1,
 * H-3, H-4, H-5, H-7).
 *
 * Every helper here drives the REAL S3 entry routines through their real
 * boundary: a real `invctl/1` assertion, minted with the test key over the
 * `invpl/1` payload the `@daftar/inventory` builders produce, carried in
 * `app.inventory_assertion`, and the routine executed as `daftar_app` — the
 * one runtime role that may. Nothing re-implements a routine, and no stock row
 * is ever written as the owner: stock is seeded only through real S3 commands
 * (H-4).
 *
 * The negative tests need to depart from the honest command in exactly one
 * way at a time, so `runCommand` takes explicit overrides: mint over another
 * command (`mintFor`, a tampered field), under another operation code
 * (`op`), present another assertion (`assertion`, a replay), run under
 * another scope (`scope`), or carry another trace.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { expect } from 'vitest';
import {
  EMPTY_STOCK_STATE,
  adjustPayload,
  damagePayload,
  formatQuantity,
  formatUnitCost,
  inventoryPayloadSha256,
  openingPayload,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  simulateMovement,
  stocktakeCountPayload,
  stocktakeFinalizePayload,
  stocktakeOpenPayload,
  toC10,
  toQ4,
  transferPayload,
  yyyymmdd,
  type InventoryOperationCode,
  type InventoryPayloadField,
  type MovementPayload,
  type StockState,
} from '../../packages/inventory/src';
import { grantFeature, mintTestInventoryAssertion, ownerPool, raiseLimit, uniqueEmail, type TestApp } from './test-app';
import {
  addTrackedProduct,
  addVariantProduct,
  addWarehouse,
  attempt,
  createProduct,
  addMerchantVariant,
  must,
  ownerClient,
  recordBusinessOwner,
  type Outcome,
  type ProductRef,
  type Queryable,
} from './stock-ledger';

export { attempt, must, ownerClient };
export {
  atCommit,
  expectAccepted,
  expectConstraint,
  expectRefused,
  isBlocked,
  pidOf,
  roleClient,
  RUNTIME_ROLES,
  scratch,
  settle,
  waitUntilBlocked,
  withoutRefusal,
} from './stock-ledger';
export type { Outcome, Queryable };

// ── the world (H-3) ────────────────────────────────────────────────────────

/** One business of the S3 world: two warehouses on two different home branches, and every product shape S3 needs. */
export interface S3Business {
  readonly tenantId: string;
  readonly businessId: string;
  /** The recorded owner (and the actor of every direct routine call). */
  readonly userId: string;
  readonly branchX: string;
  readonly branchY: string;
  /** Home of branch X (the business default warehouse). */
  readonly w1: string;
  /** Home of branch Y. */
  readonly w2: string;
  /** Tracked `piece`/0 with its hidden base variant. */
  readonly piece: ProductRef;
  /** A second tracked `piece`/0 product with its base variant. */
  readonly piece2: ProductRef;
  /** Tracked `metre`/2 with its base variant. */
  readonly dec2: ProductRef;
  /** A tracked variant product: two merchant variants, no base variant. */
  readonly variantProduct: { readonly productId: string; readonly variantIds: readonly [string, string] };
  /** An untracked product and a merchant variant of it. */
  readonly untracked: ProductRef;
}

/** A (warehouse, variant) stock key. */
export interface StockKey {
  readonly warehouseId: string;
  readonly variantId: string;
}

async function one(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  return must((await pool.query<{ id: string }>(sql, params)).rows[0], `id from: ${sql}`).id;
}

async function newUser(pool: Pool, label: string): Promise<string> {
  return one(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`, [
    `s3-${label}-${randomUUID().slice(0, 8)}@test.daftar.local`,
    `S3 ${label}`,
  ]);
}

/** A business inside `tenantId`, owned (tenant link, system owner role, membership) by `userId`, with the full S3 shape. */
export async function seedS3Business(pool: Pool, tenantId: string, userId: string, label: string): Promise<S3Business> {
  const businessId = await one(
    pool,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantId, `S3 ${label}`, `s3-${label}-${randomUUID().slice(0, 8)}`],
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

/**
 * H-3: business A; A2 — the SAME tenant and the SAME owner as A (the
 * same-owner isolation case of `stock-ledger-same-owner.test.ts`); and B, a
 * business of another tenant with its own owner.
 */
export interface S3World {
  readonly A: S3Business;
  readonly A2: S3Business;
  readonly B: S3Business;
}

export async function seedS3World(pool: Pool, label: string): Promise<S3World> {
  const tenantA = await one(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const ownerA = await newUser(pool, `${label}-owner-a`);
  const A = await seedS3Business(pool, tenantA, ownerA, `${label}-a`);
  const A2 = await seedS3Business(pool, tenantA, ownerA, `${label}-a2`);
  const tenantB = await one(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const ownerB = await newUser(pool, `${label}-owner-b`);
  const B = await seedS3Business(pool, tenantB, ownerB, `${label}-b`);
  return { A, A2, B };
}

/** The civil date today in the business timezone (Asia/Hebron): an entry may not be dated after it. */
export async function today(q: Queryable = ownerPool()): Promise<string> {
  return must((await q.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'Asia/Hebron')::date, 'YYYY-MM-DD') AS d`)).rows[0]).d;
}

// ── the seven commands (H-1) ───────────────────────────────────────────────

export interface TransferCommand {
  readonly kind: 'transfer';
  readonly transferId: string;
  readonly source: string;
  readonly destination: string;
  readonly lines: readonly { readonly variantId: string; readonly qty: string }[];
}

export interface AdjustCommand {
  readonly kind: 'adjust';
  readonly adjustmentId: string;
  readonly warehouseId: string;
  readonly occurredOn: string;
  readonly reason: string;
  /** `qty` signed; `unitCost` present iff a gain; `expected` the bound movement value. */
  readonly lines: readonly { readonly variantId: string; readonly qty: string; readonly unitCost: string | null; readonly expected: bigint }[];
}

export interface DamageCommand {
  readonly kind: 'damage';
  readonly adjustmentId: string;
  readonly warehouseId: string;
  readonly occurredOn: string;
  readonly reason: string;
  /** `qty` is the positive magnitude written off; `expected` <= 0. */
  readonly lines: readonly { readonly variantId: string; readonly qty: string; readonly expected: bigint }[];
}

export interface StocktakeOpenCommand {
  readonly kind: 'stocktake_open';
  readonly stocktakeId: string;
  readonly warehouseId: string;
}

export interface StocktakeCountCommand {
  readonly kind: 'stocktake_count';
  readonly stocktakeId: string;
  readonly warehouseId: string;
  /** In ascending variant order. */
  readonly lines: readonly { readonly variantId: string; readonly counted: string }[];
}

export interface StocktakeFinalizeCommand {
  readonly kind: 'stocktake_finalize';
  readonly stocktakeId: string;
  readonly warehouseId: string;
  readonly outcome: 'finalized' | 'cancelled';
  readonly occurredOn: string | null;
  /** Every line of the stocktake, in ascending variant order (none when cancelled). */
  readonly lines: readonly { readonly variantId: string; readonly variance: string; readonly unitCost: string | null; readonly expected: bigint }[];
}

export interface OpeningCommand {
  readonly kind: 'opening';
  readonly openingId: string;
  readonly occurredOn: string;
  readonly openingBalanceId: string | null;
  readonly positionMinor: bigint | null;
  readonly lines: readonly { readonly warehouseId: string; readonly variantId: string; readonly qty: string; readonly unitCost: string }[];
}

export type S3Command =
  | TransferCommand
  | AdjustCommand
  | DamageCommand
  | StocktakeOpenCommand
  | StocktakeCountCommand
  | StocktakeFinalizeCommand
  | OpeningCommand;

export type S3Kind = S3Command['kind'];

export const OP_OF: Readonly<Record<S3Kind, InventoryOperationCode>> = {
  transfer: 'inventory.transfer',
  adjust: 'inventory.adjust',
  damage: 'inventory.damage',
  stocktake_open: 'inventory.stocktake_open',
  stocktake_count: 'inventory.stocktake_count',
  stocktake_finalize: 'inventory.stocktake_finalize',
  opening: 'inventory.opening',
};

/** The seven entry routines by kind, with their exact signatures. */
export const ROUTINE_OF: Readonly<Record<S3Kind, string>> = {
  transfer: 'inventory_transfer_stock(uuid,uuid,uuid,uuid[],numeric[])',
  adjust: 'inventory_adjust_stock(uuid,uuid,date,text,uuid[],numeric[],numeric[],bigint[])',
  damage: 'inventory_record_damage(uuid,uuid,date,text,uuid[],numeric[],bigint[])',
  stocktake_open: 'inventory_stocktake_open(uuid,uuid)',
  stocktake_count: 'inventory_stocktake_count(uuid,uuid,uuid[],numeric[])',
  stocktake_finalize: 'inventory_stocktake_finalize(uuid,uuid,text,date,uuid[],numeric[],numeric[],bigint[])',
  opening: 'inventory_record_opening(uuid,date,uuid,bigint,uuid[],uuid[],numeric[],numeric[])',
};

export const S3_KINDS: readonly S3Kind[] = ['transfer', 'adjust', 'damage', 'stocktake_open', 'stocktake_count', 'stocktake_finalize', 'opening'];

const q4 = (text: string): bigint => toQ4(text.startsWith('-') ? text.slice(1) : text) * (text.startsWith('-') ? -1n : 1n);

/** The `invpl/1` payload the service would build for this exact command in `biz`. */
export function payloadOf(biz: { tenantId: string; businessId: string }, cmd: S3Command): MovementPayload {
  const base = { tenantId: biz.tenantId, businessId: biz.businessId };
  switch (cmd.kind) {
    case 'transfer':
      return transferPayload({
        ...base,
        transferId: cmd.transferId,
        sourceWarehouseId: cmd.source,
        destinationWarehouseId: cmd.destination,
        lines: cmd.lines.map((l) => ({ variantId: l.variantId, qtyQ4: toQ4(l.qty) })),
      });
    case 'adjust':
      return adjustPayload({
        ...base,
        adjustmentId: cmd.adjustmentId,
        warehouseId: cmd.warehouseId,
        occurredOn: cmd.occurredOn,
        reason: cmd.reason,
        lines: cmd.lines.map((l) => ({
          variantId: l.variantId,
          qtyDeltaQ4: q4(l.qty),
          unitCostC10: l.unitCost === null ? null : toC10(l.unitCost),
          expectedValue: l.expected,
        })),
      });
    case 'damage':
      return damagePayload({
        ...base,
        adjustmentId: cmd.adjustmentId,
        warehouseId: cmd.warehouseId,
        occurredOn: cmd.occurredOn,
        reason: cmd.reason,
        lines: cmd.lines.map((l) => ({ variantId: l.variantId, qtyQ4: toQ4(l.qty), expectedValue: l.expected })),
      });
    case 'stocktake_open':
      return stocktakeOpenPayload({ ...base, stocktakeId: cmd.stocktakeId, warehouseId: cmd.warehouseId });
    case 'stocktake_count':
      return stocktakeCountPayload({
        ...base,
        stocktakeId: cmd.stocktakeId,
        warehouseId: cmd.warehouseId,
        lines: cmd.lines.map((l) => ({ variantId: l.variantId, countedQ4: toQ4(l.counted) })),
      });
    case 'stocktake_finalize':
      return stocktakeFinalizePayload({
        ...base,
        stocktakeId: cmd.stocktakeId,
        warehouseId: cmd.warehouseId,
        outcome: cmd.outcome,
        occurredOn: cmd.occurredOn,
        lines: cmd.lines.map((l) => ({
          variantId: l.variantId,
          varianceQ4: q4(l.variance),
          unitCostC10: l.unitCost === null ? null : toC10(l.unitCost),
          expectedValue: l.expected,
        })),
      });
    case 'opening':
      return openingPayload({
        ...base,
        openingId: cmd.openingId,
        occurredOn: cmd.occurredOn,
        openingBalanceId: cmd.openingBalanceId,
        positionMinor: cmd.positionMinor,
        lines: cmd.lines.map((l) => ({ warehouseId: l.warehouseId, variantId: l.variantId, qtyQ4: toQ4(l.qty), unitCostC10: toC10(l.unitCost) })),
      });
  }
}

/** The routine call — SQL and parameters — for a command, exactly as the service issues it. */
export function callOf(cmd: S3Command): { readonly sql: string; readonly params: unknown[] } {
  switch (cmd.kind) {
    case 'transfer':
      return {
        sql: `SELECT document_id, replayed, line_id, variant_id, value_moved_base_minor::text AS value
                FROM inventory_transfer_stock($1::uuid, $2::uuid, $3::uuid, $4::uuid[], $5::numeric[])`,
        params: [cmd.transferId, cmd.source, cmd.destination, cmd.lines.map((l) => l.variantId), cmd.lines.map((l) => l.qty)],
      };
    case 'adjust':
      return {
        sql: `SELECT document_id, replayed, total_value_base_minor::text AS total, line_id, variant_id, value_delta_base_minor::text AS value
                FROM inventory_adjust_stock($1::uuid, $2::uuid, $3::date, $4::text, $5::uuid[], $6::numeric[], $7::numeric[], $8::bigint[])`,
        params: [
          cmd.adjustmentId,
          cmd.warehouseId,
          cmd.occurredOn,
          cmd.reason,
          cmd.lines.map((l) => l.variantId),
          cmd.lines.map((l) => l.qty),
          cmd.lines.map((l) => l.unitCost),
          cmd.lines.map((l) => l.expected.toString(10)),
        ],
      };
    case 'damage':
      return {
        sql: `SELECT document_id, replayed, total_value_base_minor::text AS total, line_id, variant_id, value_delta_base_minor::text AS value
                FROM inventory_record_damage($1::uuid, $2::uuid, $3::date, $4::text, $5::uuid[], $6::numeric[], $7::bigint[])`,
        params: [
          cmd.adjustmentId,
          cmd.warehouseId,
          cmd.occurredOn,
          cmd.reason,
          cmd.lines.map((l) => l.variantId),
          cmd.lines.map((l) => l.qty),
          cmd.lines.map((l) => l.expected.toString(10)),
        ],
      };
    case 'stocktake_open':
      return { sql: `SELECT stocktake_id, replayed FROM inventory_stocktake_open($1::uuid, $2::uuid)`, params: [cmd.stocktakeId, cmd.warehouseId] };
    case 'stocktake_count':
      return {
        sql: `SELECT line_id, variant_id, expected_qty_at_capture::text AS expected_qty_at_capture, captured_at_stock_seq::text AS captured_at_stock_seq,
                     counted_qty::text AS counted_qty, variance_qty::text AS variance_qty, changed
                FROM inventory_stocktake_count($1::uuid, $2::uuid, $3::uuid[], $4::numeric[])`,
        params: [cmd.stocktakeId, cmd.warehouseId, cmd.lines.map((l) => l.variantId), cmd.lines.map((l) => l.counted)],
      };
    case 'stocktake_finalize':
      return {
        sql: `SELECT stocktake_id, replayed, status, total_value_base_minor::text AS total, line_id, variant_id, value_delta_base_minor::text AS value
                FROM inventory_stocktake_finalize($1::uuid, $2::uuid, $3::text, $4::date, $5::uuid[], $6::numeric[], $7::numeric[], $8::bigint[])`,
        params: [
          cmd.stocktakeId,
          cmd.warehouseId,
          cmd.outcome,
          cmd.occurredOn,
          cmd.lines.map((l) => l.variantId),
          cmd.lines.map((l) => l.variance),
          cmd.lines.map((l) => l.unitCost),
          cmd.lines.map((l) => l.expected.toString(10)),
        ],
      };
    case 'opening':
      return {
        sql: `SELECT document_id, replayed, case_kind, total_value_base_minor::text AS total, line_id, warehouse_id, variant_id,
                     value_delta_base_minor::text AS value
                FROM inventory_record_opening($1::uuid, $2::date, $3::uuid, $4::bigint, $5::uuid[], $6::uuid[], $7::numeric[], $8::numeric[])`,
        params: [
          cmd.openingId,
          cmd.occurredOn,
          cmd.openingBalanceId,
          cmd.positionMinor === null ? null : cmd.positionMinor.toString(10),
          cmd.lines.map((l) => l.warehouseId),
          cmd.lines.map((l) => l.variantId),
          cmd.lines.map((l) => l.qty),
          cmd.lines.map((l) => l.unitCost),
        ],
      };
  }
}

/**
 * The claimed `invpl/1` stream of a command built field by field, WITHOUT the
 * builders' semantic refusals (duplicates, signs, empty reasons, order): the
 * exact digest the routine computes over its own arguments. It is how a test
 * reaches the routine's own refusal of an input the service would never
 * send. The encoder (and its type and nullability checks) is the package's.
 */
export function rawPayloadSha256(biz: { tenantId: string; businessId: string }, cmd: S3Command): string {
  const u = (value: string | null): InventoryPayloadField => (value === null ? { kind: 'null' } : { kind: 'uuid', value });
  const i = (value: bigint | null): InventoryPayloadField => (value === null ? { kind: 'null' } : { kind: 'integer', value });
  const n = (count: number): InventoryPayloadField => ({ kind: 'integer', value: BigInt(count) });
  const reason = (text: string): InventoryPayloadField[] => {
    const d = createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
    return Array.from({ length: 8 }, (_, k) => i(BigInt(d.readUInt32BE(k * 4))));
  };
  const cost = (c: string | null): bigint | null => (c === null ? null : toC10(c));
  let fields: InventoryPayloadField[];
  switch (cmd.kind) {
    case 'transfer':
      fields = [u(cmd.transferId), u(cmd.source), u(cmd.destination), n(cmd.lines.length), ...cmd.lines.flatMap((l) => [u(l.variantId), i(q4(l.qty))])];
      break;
    case 'adjust':
      fields = [
        u(cmd.adjustmentId),
        u(cmd.warehouseId),
        i(yyyymmdd(cmd.occurredOn)),
        ...reason(cmd.reason),
        n(cmd.lines.length),
        ...cmd.lines.flatMap((l) => [u(l.variantId), i(q4(l.qty)), i(cost(l.unitCost)), i(l.expected)]),
      ];
      break;
    case 'damage':
      fields = [
        u(cmd.adjustmentId),
        u(cmd.warehouseId),
        i(yyyymmdd(cmd.occurredOn)),
        ...reason(cmd.reason),
        n(cmd.lines.length),
        ...cmd.lines.flatMap((l) => [u(l.variantId), i(q4(l.qty)), i(l.expected)]),
      ];
      break;
    case 'stocktake_open':
      fields = [u(cmd.stocktakeId), u(cmd.warehouseId)];
      break;
    case 'stocktake_count':
      fields = [u(cmd.stocktakeId), u(cmd.warehouseId), n(cmd.lines.length), ...cmd.lines.flatMap((l) => [u(l.variantId), i(q4(l.counted))])];
      break;
    case 'stocktake_finalize':
      fields = [
        u(cmd.stocktakeId),
        u(cmd.warehouseId),
        { kind: 'code', value: cmd.outcome },
        i(cmd.occurredOn === null ? null : yyyymmdd(cmd.occurredOn)),
        n(cmd.lines.length),
        ...cmd.lines.flatMap((l) => [u(l.variantId), i(q4(l.variance)), i(cost(l.unitCost)), i(l.expected)]),
      ];
      break;
    case 'opening':
      fields = [
        u(cmd.openingId),
        i(yyyymmdd(cmd.occurredOn)),
        u(cmd.openingBalanceId),
        i(cmd.positionMinor),
        n(cmd.lines.length),
        ...cmd.lines.flatMap((l) => [u(l.warehouseId), u(l.variantId), i(q4(l.qty)), i(toC10(l.unitCost))]),
      ];
      break;
  }
  return inventoryPayloadSha256(OP_OF[cmd.kind], biz.tenantId, biz.businessId, fields);
}

/** One row of any entry routine's answer; each routine fills the columns it has. */
export interface CommandRow {
  readonly document_id?: string;
  readonly stocktake_id?: string;
  readonly replayed?: boolean;
  readonly status?: string;
  readonly case_kind?: string;
  readonly total?: string | null;
  readonly line_id?: string | null;
  readonly warehouse_id?: string;
  readonly variant_id?: string | null;
  readonly value?: string | null;
  readonly expected_qty_at_capture?: string;
  readonly captured_at_stock_seq?: string;
  readonly counted_qty?: string;
  readonly variance_qty?: string;
  readonly changed?: boolean;
}

export interface RunOptions {
  /** Present exactly this assertion (a replay, a forgery); nothing is minted. `null` presents none. */
  readonly assertion?: string | null;
  /** Mint over this command's payload instead (a tampered field). */
  readonly mintFor?: S3Command;
  /** Mint under this operation code instead (a wrong-operation case). */
  readonly op?: InventoryOperationCode;
  /** Mint for this business instead of the calling one. */
  readonly mintBusiness?: { tenantId: string; businessId: string };
  /** Run under these scope GUCs instead of the business's own. */
  readonly scope?: { tenantId: string; businessId: string };
  /** The business transaction id GUC; a fresh one by default, `''` for none. */
  readonly trace?: string;
  readonly jti?: string;
  /** Digest the claimed arguments field by field (`rawPayloadSha256`), bypassing the builders' semantic refusals. */
  readonly raw?: boolean;
  /** Receives the assertion that was presented. */
  readonly onAssertion?: (assertion: string) => void;
}

/** Mint the assertion the service would mint for `cmd` in `biz`, with `o`'s departures. */
export function assertionFor(biz: { tenantId: string; businessId: string; userId: string }, cmd: S3Command, o: RunOptions = {}): string {
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
 * H-1 calling convention, in the CALLER's transaction (a superuser client):
 * the scope GUCs, the trace and the carrier, `SET LOCAL ROLE daftar_app`, the
 * entry routine, `RESET ROLE`. On a refusal the role is still daftar_app;
 * callers wrap this in `attempt`, whose ROLLBACK TO SAVEPOINT undoes the
 * role switch together with the refused call.
 */
export async function runCommand(c: Queryable, biz: S3Business, cmd: S3Command, o: RunOptions = {}): Promise<CommandRow[]> {
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
  const r = await c.query<CommandRow>(sql, params);
  await c.query('RESET ROLE');
  return r.rows;
}

/** `runCommand` inside a savepoint: a refusal leaves the transaction usable. */
export function tryCommand(c: Queryable, biz: S3Business, cmd: S3Command, o: RunOptions = {}): Promise<Outcome<CommandRow[]>> {
  return attempt(c, () => runCommand(c, biz, cmd, o));
}

// ── current state and expected values (A-07, as the service computes them) ─

/** The stock state of one key as the owner reads it, or the empty state. */
export async function stockState(q: Queryable, businessId: string, key: StockKey): Promise<StockState> {
  const r = await q.query<{ on_hand: string; valuation: string; avg: string | null; seq: string }>(
    `SELECT on_hand::text AS on_hand, valuation_base_minor::text AS valuation, avg_unit_cost_base_minor::text AS avg, last_stock_seq::text AS seq
       FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
    [businessId, key.warehouseId, key.variantId],
  );
  const row = r.rows[0];
  if (row === undefined) return EMPTY_STOCK_STATE;
  return {
    onHand: parseQuantity(row.on_hand),
    valuation: parseMinor(row.valuation),
    avg: row.avg === null ? null : parseUnitCost(row.avg),
    lastStockSeq: BigInt(row.seq),
  };
}

/** The value the primitive will store for an adjustment/damage/stocktake line on `key` now (the service's A-07 computation). */
export async function expectedValue(
  q: Queryable,
  businessId: string,
  key: StockKey,
  kind: 'adjustment' | 'damage' | 'stocktake',
  qtyDelta: string,
  unitCost: string | null,
): Promise<bigint> {
  const state = await stockState(q, businessId, key);
  const qty = q4(qtyDelta);
  const cost = qty > 0n ? (unitCost === null ? state.avg : toC10(unitCost)) : null;
  return simulateMovement(state, { kind, qtyQ4: qty, costC10: cost, value: null }).value;
}

// ── command builders with the expected values filled in ───────────────────

export interface AdjustLineInput {
  readonly variantId: string;
  readonly qty: string;
  readonly unitCost?: string | null;
}

/** An adjustment of `key.warehouseId` whose expected values are computed from the current stock (A-07). */
export async function adjustCommand(
  q: Queryable,
  biz: S3Business,
  warehouseId: string,
  lines: readonly AdjustLineInput[],
  o: { adjustmentId?: string; occurredOn?: string; reason?: string } = {},
): Promise<AdjustCommand> {
  const occurredOn = o.occurredOn ?? (await today(q));
  const full = [];
  for (const l of lines) {
    const unitCost = l.unitCost ?? null;
    full.push({
      variantId: l.variantId,
      qty: l.qty,
      unitCost,
      expected: await expectedValue(q, biz.businessId, { warehouseId, variantId: l.variantId }, 'adjustment', l.qty, unitCost),
    });
  }
  return { kind: 'adjust', adjustmentId: o.adjustmentId ?? randomUUID(), warehouseId, occurredOn, reason: o.reason ?? 'a counted correction', lines: full };
}

export async function damageCommand(
  q: Queryable,
  biz: S3Business,
  warehouseId: string,
  lines: readonly { variantId: string; qty: string }[],
  o: { adjustmentId?: string; occurredOn?: string; reason?: string } = {},
): Promise<DamageCommand> {
  const occurredOn = o.occurredOn ?? (await today(q));
  const full = [];
  for (const l of lines) {
    full.push({
      variantId: l.variantId,
      qty: l.qty,
      expected: await expectedValue(q, biz.businessId, { warehouseId, variantId: l.variantId }, 'damage', `-${l.qty}`, null),
    });
  }
  return { kind: 'damage', adjustmentId: o.adjustmentId ?? randomUUID(), warehouseId, occurredOn, reason: o.reason ?? 'water damage', lines: full };
}

export interface StoredStocktakeLine {
  readonly variant_id: string;
  readonly variance_qty: string;
}

/** The stored lines of a stocktake in canonical (ascending variant) order. */
export async function stocktakeLines(q: Queryable, businessId: string, stocktakeId: string): Promise<StoredStocktakeLine[]> {
  return (
    await q.query<StoredStocktakeLine>(
      `SELECT variant_id::text, variance_qty::text FROM stocktake_lines WHERE business_id = $1 AND stocktake_id = $2 ORDER BY variant_id`,
      [businessId, stocktakeId],
    )
  ).rows;
}

/** A finalize over EVERY stored line, valued from the current stock as the service values it (A-11). */
export async function finalizeCommand(
  q: Queryable,
  biz: S3Business,
  stocktakeId: string,
  warehouseId: string,
  o: { occurredOn?: string; costs?: Readonly<Record<string, string>> } = {},
): Promise<StocktakeFinalizeCommand> {
  const occurredOn = o.occurredOn ?? (await today(q));
  const lines = [];
  for (const l of await stocktakeLines(q, biz.businessId, stocktakeId)) {
    const variance = l.variance_qty;
    const unitCost = o.costs?.[l.variant_id] ?? null;
    const expected =
      q4(variance) === 0n ? 0n : await expectedValue(q, biz.businessId, { warehouseId, variantId: l.variant_id }, 'stocktake', variance, unitCost);
    lines.push({ variantId: l.variant_id, variance, unitCost, expected });
  }
  return { kind: 'stocktake_finalize', stocktakeId, warehouseId, outcome: 'finalized', occurredOn, lines };
}

export function cancelCommand(stocktakeId: string, warehouseId: string): StocktakeFinalizeCommand {
  return { kind: 'stocktake_finalize', stocktakeId, warehouseId, outcome: 'cancelled', occurredOn: null, lines: [] };
}

/** Count lines sorted into the canonical variant order the routine requires (R-12). */
export function countCommand(stocktakeId: string, warehouseId: string, lines: readonly { variantId: string; counted: string }[]): StocktakeCountCommand {
  return {
    kind: 'stocktake_count',
    stocktakeId,
    warehouseId,
    lines: [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0)),
  };
}

/** The opening's HALF_EVEN total and largest-remainder shares, computed with the package allocator the service uses. */
export { allocateOpening } from '../../packages/inventory/src';

export { formatQuantity, formatUnitCost, toQ4, toC10 };

// ── counters (H-7) ─────────────────────────────────────────────────────────

/** Every S3 document table and bridge. */
export const S3_TABLES = [
  'inventory_transfers',
  'inventory_transfer_lines',
  'inventory_adjustments',
  'inventory_adjustment_lines',
  'stocktakes',
  'stocktake_lines',
  'inventory_openings',
  'inventory_opening_lines',
] as const;

export const S3_BRIDGES = [
  'stock_source_bridge_inventory_transfer',
  'stock_source_bridge_inventory_adjustment',
  'stock_source_bridge_stocktake',
  'stock_source_bridge_inventory_opening',
] as const;

export type Counts = Readonly<Record<string, number>>;

/**
 * H-7: the row counts a command may change, for one business. Used before and
 * after every atomicity and "no entry" assertion. `inventory_assertion_uses`
 * is counted by business too (the business its assertion named).
 */
export async function counts(q: Queryable, businessId: string): Promise<Counts> {
  const tables = [
    'stock_movements',
    'stock_source_bindings',
    'stock_levels',
    ...S3_BRIDGES,
    ...S3_TABLES,
    'journal_entries',
    'journal_lines',
    'accounting_source_bindings',
    'audit_events',
    'outbox_events',
    'inventory_assertion_uses',
  ];
  const r = await q.query<Record<string, number>>(`SELECT ${tables.map((t) => `(SELECT count(*)::int FROM ${t} WHERE business_id = $1) AS ${t}`).join(', ')}`, [
    businessId,
  ]);
  return must(r.rows[0], 'counts');
}

/** The difference `after − before`, keeping only the tables that changed. */
export function delta(before: Counts, after: Counts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

// ── ledger reads (as the owner, so RLS never hides what a test asserts) ────

export interface JournalLineText {
  readonly system_key: string | null;
  readonly code: string;
  readonly debit: string;
  readonly credit: string;
  readonly warehouse_id: string | null;
  readonly branch_id: string | null;
}

/** The entry an S3 document posted under `sourceType`, or null; with its lines by line number. */
export async function entryOf(
  q: Queryable,
  businessId: string,
  sourceType: 'inventory_adjustment' | 'inventory_opening',
  sourceId: string,
): Promise<{ id: string; entry_date: string; lines: JournalLineText[] } | null> {
  const e = (
    await q.query<{ id: string; entry_date: string }>(
      `SELECT id::text, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM journal_entries WHERE business_id = $1 AND source_type = $2 AND source_id = $3`,
      [businessId, sourceType, sourceId],
    )
  ).rows[0];
  if (e === undefined) return null;
  const lines = (
    await q.query<JournalLineText>(
      `SELECT a.system_key, a.code, l.debit_minor::text AS debit, l.credit_minor::text AS credit, l.warehouse_id::text, l.branch_id::text
         FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
      [businessId, e.id],
    )
  ).rows;
  return { ...e, lines };
}

/** Net `Σ Dr − Σ Cr` of every posted line on the business's `inventory` system account (GL Inventory). */
export async function glInventory(q: Queryable, businessId: string): Promise<bigint> {
  const r = await q.query<{ n: string }>(
    `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS n
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = 'inventory'`,
    [businessId],
  );
  return BigInt(must(r.rows[0]).n);
}

/** Σ `value_delta_base_minor` over every movement of the business. */
export async function movementValue(q: Queryable, businessId: string): Promise<bigint> {
  return BigInt(
    must(
      (await q.query<{ n: string }>(`SELECT coalesce(sum(value_delta_base_minor), 0)::text AS n FROM stock_movements WHERE business_id = $1`, [businessId]))
        .rows[0],
    ).n,
  );
}

/** Σ `valuation_base_minor` over the business's stock cache. */
export async function cacheValue(q: Queryable, businessId: string): Promise<bigint> {
  return BigInt(
    must(
      (await q.query<{ n: string }>(`SELECT coalesce(sum(valuation_base_minor), 0)::text AS n FROM stock_levels WHERE business_id = $1`, [businessId])).rows[0],
    ).n,
  );
}

/** Lines posted to 6100 (rounding) or 6200 (purchase price variance) by this business. */
export async function roundingLines(q: Queryable, businessId: string): Promise<number> {
  return must(
    (
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
          WHERE l.business_id = $1 AND (a.system_key IN ('rounding', 'purchase_price_variance') OR a.code IN ('6100', '6200'))`,
        [businessId],
      )
    ).rows[0],
  ).n;
}

/** The on-hand of a key as text, or `'0'` when the key has no row. */
export async function onHand(q: Queryable, businessId: string, key: StockKey): Promise<string> {
  const r = await q.query<{ on_hand: string }>(
    `SELECT on_hand::text AS on_hand FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
    [businessId, key.warehouseId, key.variantId],
  );
  return r.rows[0]?.on_hand ?? '0';
}

// ── PostgreSQL-version-dependent SQLSTATEs ─────────────────────────────────

/**
 * The SQLSTATE a RESTRICT foreign key raises when a referenced row is deleted
 * or its key updated. PostgreSQL 18 reports `23001` (restrict_violation) for
 * `ON DELETE/UPDATE RESTRICT`; 16 and 17 report `23503`. Derived from the
 * server, never assumed (CI runs 16, the local embedded cluster 18).
 */
export async function restrictSqlstate(q: Queryable = ownerPool()): Promise<string> {
  const v = Number(must((await q.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0]).v);
  return v >= 180000 ? '23001' : '23503';
}

/** Assert that the given outcome is a refusal carrying exactly this SQLSTATE and stable code. */
export function refusedWith(o: Outcome, sqlstate: string, code: string | null, why = ''): void {
  if (o.ok) throw new Error(`${why ? `${why}: ` : ''}expected ${sqlstate} ${code ?? ''}, but it was accepted`);
  expect({ sqlstate: o.sqlstate, code: code === null ? null : o.code }, `${why} — ${o.message}`).toEqual({ sqlstate, code });
}

// ── the owner's transaction (H-6's always-rolled-back shape) ───────────────

/** BEGIN on a fresh superuser connection, run, ROLLBACK — always. */
export async function rolledBack<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** A transfer command (lines in request order). */
export function transferCommand(
  source: string,
  destination: string,
  lines: readonly { variantId: string; qty: string }[],
  transferId: string = randomUUID(),
): TransferCommand {
  return { kind: 'transfer', transferId, source, destination, lines };
}

/** An opening command; with no position it is Case A, with one it is Case B against that opening balance. */
export function openingCommand(
  occurredOn: string,
  lines: readonly { warehouseId: string; variantId: string; qty: string; unitCost: string }[],
  o: { openingId?: string; openingBalanceId?: string; positionMinor?: bigint } = {},
): OpeningCommand {
  return {
    kind: 'opening',
    openingId: o.openingId ?? randomUUID(),
    occurredOn,
    openingBalanceId: o.openingBalanceId ?? null,
    positionMinor: o.positionMinor ?? null,
    lines,
  };
}

/** A stocktake-open command. */
export function stocktakeOpenCommand(warehouseId: string, stocktakeId: string = randomUUID()): StocktakeOpenCommand {
  return { kind: 'stocktake_open', stocktakeId, warehouseId };
}

// ── the HTTP world (§6 T-09, T-17): the same S3 shape behind the real API ──

/** A registered user and the bearer token the API issued them. */
export interface HttpActor {
  readonly token: string;
  readonly userId: string;
  readonly email: string;
}

export async function registerActor(t: TestApp, name: string): Promise<HttpActor> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'en' });
  expect(reg.status, `register ${name}`).toBe(201);
  const token = String(reg.body.accessToken);
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  expect(me.status).toBe(200);
  return { token, userId: String(me.body.userId), email: String(me.body.email) };
}

/** The headers of a request by `a` in business `businessId`. */
export function asMember(a: HttpActor, businessId: string): Record<string, string> {
  return { Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId };
}

/**
 * A business onboarded through the real API by `owner` (so through
 * `provision_create_business`), given a second branch through the real API
 * (its home warehouse is W2), and then the S3 product shapes, seeded the way
 * the other S3 suites seed them.
 */
export async function onboardS3Business(t: TestApp, owner: HttpActor, label: string): Promise<S3Business> {
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `s3-${randomUUID()}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ businessName: `S3 ${label}`, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `s3-${label}-${randomUUID().slice(0, 8)}`, preferredLocale: 'en' });
  expect(on.status, 'onboarding').toBe(201);
  const tenantId = String(on.body.tenantId);
  const businessId = String(on.body.businessId);
  const pool = ownerPool();
  await grantFeature(businessId, owner.userId, 'MULTI_BRANCH');
  await grantFeature(businessId, owner.userId, 'CUSTOM_ROLES');
  await raiseLimit(businessId, owner.userId, 'MAX_BRANCHES', 10);
  await raiseLimit(businessId, owner.userId, 'MAX_USERS', 20);
  const home = must(
    (await pool.query<{ branch_id: string; id: string }>(`SELECT branch_id::text, id::text FROM warehouses WHERE business_id = $1`, [businessId])).rows[0],
  );
  const br = await t.request.post('/v1/businesses/current/branches').set(asMember(owner, businessId)).send({ name: 'Y' });
  expect(br.status, 'second branch').toBe(201);
  const branchY = String(br.body.id);
  const w2 = must(
    (await pool.query<{ id: string }>(`SELECT id::text FROM warehouses WHERE business_id = $1 AND branch_id = $2`, [businessId, branchY])).rows[0],
  ).id;
  const s = { tenantId, businessId };
  const piece = await addTrackedProduct(pool, s, 'piece', 0);
  const piece2 = await addTrackedProduct(pool, s, 'piece', 0);
  const dec2 = await addTrackedProduct(pool, s, 'metre', 2);
  const vp = await addVariantProduct(pool, s, 2);
  const untrackedId = await createProduct(pool, businessId);
  const untrackedVariant = await addMerchantVariant(pool, businessId, untrackedId);
  return {
    tenantId,
    businessId,
    userId: owner.userId,
    branchX: home.branch_id,
    branchY,
    w1: home.id,
    w2,
    piece,
    piece2,
    dec2,
    variantProduct: { productId: vp.productId, variantIds: [must(vp.variantIds[0]), must(vp.variantIds[1])] },
    untracked: { productId: untrackedId, variantId: untrackedVariant },
  };
}
