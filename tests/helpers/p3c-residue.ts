/**
 * PHASE 3 CORRECTIVE — TD-16 fixtures (migration 0072).
 *
 * - `historicalReturn`: the FROZEN S5 behaviour, reproduced. One supplier
 *   return exactly as 0066 alone commits it — the service's steps 3–5
 *   (`prepareReturn`: the package planner's `least(C, O)` split), the
 *   routine and its one entry — with 0072's prevention trigger
 *   `supplier_returns_residue_bound` disabled inside that one owner
 *   transaction, so no event is queued for the row; every other deferred
 *   guard is then fired (`SET CONSTRAINTS ALL IMMEDIATE`, as COMMIT would),
 *   and the trigger re-enabled before COMMIT (DDL is transactional: no other
 *   session ever sees it disabled).
 *   On a pre-0072 build there is no trigger and the return is simply the
 *   frozen one. This is how a sub-unit residue that already exists in a
 *   deployed database is rebuilt for the closure tests (directive §3).
 * - `sqlWriteOff`: the write-off routine called the way the service calls
 *   it — the scope GUCs, a harness-signed `purchase.write_off_residue`
 *   assertion over its raw arguments, `SET LOCAL ROLE daftar_app` — for the
 *   adversarial cases the API cannot express (a scope minted for another
 *   business, a stated chain point that is not the purchase's).
 * - small reads: the write-off row and entry, the ledger AP with that entry,
 *   the payable read, the business's row counts and base balance.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { buildInventoryPayload, yyyymmdd, type InventoryPayloadField } from '@daftar/inventory';
import { asMember, must, type HttpActor, type Queryable, type S3Business } from './inventory-commands';
import { prepareReturn, runReturn } from './purchase-returns';
import { ownerClient } from './stock-ledger';
import { settlementLedgerAp, type HttpPurchase } from './supplier-settlement';
import { mintTestInventoryAssertion, ownerPool, type TestApp } from './test-app';

/** 0072's prevention trigger on supplier_returns. */
export const RESIDUE_BOUND_TRIGGER = 'supplier_returns_residue_bound';

/** Whether 0072's prevention trigger exists (false on a pre-0072 build). */
export async function residueBoundInstalled(q: Queryable = ownerPool()): Promise<boolean> {
  const r = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.supplier_returns'::regclass AND tgname = $1 AND NOT tgisinternal`,
    [RESIDUE_BOUND_TRIGGER],
  );
  return must(r.rows[0]).n === 1;
}

/**
 * One return of `lines`, run with the frozen S5 behaviour (0066 without
 * 0072's prevention) in the CALLER's transaction, which must be an owner
 * transaction: the trigger is disabled for the return alone, every other
 * deferred check pending in the transaction is run as COMMIT would run it
 * (so the queue is empty and the table may be altered again), the trigger is
 * re-enabled and later statements are deferred again. Returns the return id.
 */
export async function historicalReturnInTx(
  c: Queryable,
  biz: S3Business,
  purchaseId: string,
  lines: readonly { readonly purchaseLineId: string; readonly qty: string }[],
  o: { readonly warehouseId?: string; readonly documentDate?: string } = {},
): Promise<string> {
  const installed = await residueBoundInstalled(c);
  if (installed) await c.query(`ALTER TABLE supplier_returns DISABLE TRIGGER ${RESIDUE_BOUND_TRIGGER}`);
  const prepared = await prepareReturn(c, biz, purchaseId, {
    ...(o.warehouseId === undefined ? {} : { warehouseId: o.warehouseId }),
    ...(o.documentDate === undefined ? {} : { documentDate: o.documentDate }),
    lines: [...lines],
  });
  await runReturn(c, biz, prepared);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  if (installed) await c.query(`ALTER TABLE supplier_returns ENABLE TRIGGER ${RESIDUE_BOUND_TRIGGER}`);
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  return prepared.cmd.returnId;
}

/**
 * One return of `qty` of the purchase's line `lineIndex`, committed with the
 * frozen S5 behaviour (0066 without 0072's prevention). Returns the return id.
 */
export async function historicalReturn(biz: S3Business, p: HttpPurchase, lineIndex: number, qty: string, documentDate?: string): Promise<string> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const returnId = await historicalReturnInTx(c, biz, p.purchaseId, [{ purchaseLineId: must(p.lineIds[lineIndex], `line ${lineIndex}`), qty }], {
      warehouseId: p.warehouseId,
      ...(documentDate === undefined ? {} : { documentDate }),
    });
    await c.query('COMMIT');
    return returnId;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** One line of the purchase's `purchase_residue_write_off` entry, as stored. */
export interface WriteOffEntryLine {
  readonly key: string;
  readonly side: 'D' | 'C';
  readonly base: bigint;
  readonly txnCurrency: string;
  readonly txn: bigint;
  readonly rateSource: string;
  readonly rateAt: string;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
}

/** The purchase's write-off entry (null when none): its id, date and lines in (side, key) order. */
export async function writeOffEntry(
  q: Queryable,
  businessId: string,
  purchaseId: string,
): Promise<{ entryId: string; entryDate: string; lines: WriteOffEntryLine[] } | null> {
  const e = (
    await q.query<{ id: string; d: string }>(
      `SELECT e.id::text, to_char(e.entry_date, 'YYYY-MM-DD') AS d FROM journal_entries e
        WHERE e.business_id = $1 AND e.source_type = 'purchase_residue_write_off' AND e.source_id = $2`,
      [businessId, purchaseId],
    )
  ).rows;
  const [only] = e;
  if (only === undefined) return null;
  if (e.length > 1) throw new Error('more than one write-off entry for a purchase');
  const lines = await q.query<{
    key: string;
    side: 'D' | 'C';
    base: string;
    ccy: string;
    txn: string;
    src: string;
    at: string;
    branch: string | null;
    wh: string | null;
  }>(
    `SELECT a.system_key AS key, CASE WHEN l.debit_minor > 0 THEN 'D' ELSE 'C' END AS side, greatest(l.debit_minor, l.credit_minor)::text AS base,
            l.txn_currency::text AS ccy, l.txn_amount_minor::text AS txn, l.fx_rate_source AS src,
            to_char(l.fx_rate_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, l.branch_id::text AS branch, l.warehouse_id::text AS wh
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY 2 DESC, 1`,
    [businessId, only.id],
  );
  return {
    entryId: only.id,
    entryDate: only.d,
    lines: lines.rows.map((r) => ({
      key: r.key,
      side: r.side,
      base: BigInt(r.base),
      txnCurrency: r.ccy,
      txn: BigInt(r.txn),
      rateSource: r.src,
      rateAt: r.at,
      branchId: r.branch,
      warehouseId: r.wh,
    })),
  };
}

/** The purchase's AP in the ledger, its write-off entry included: `settlementLedgerAp` plus that entry's Accounts Payable lines. */
export async function ledgerApWithWriteOff(q: Queryable, businessId: string, purchaseId: string): Promise<{ base: bigint; txn: bigint }> {
  const ap = await settlementLedgerAp(q, businessId, purchaseId);
  const entry = await writeOffEntry(q, businessId, purchaseId);
  const debit = (entry?.lines ?? []).filter((l) => l.key === 'accounts_payable').reduce((sum, l) => sum + (l.side === 'D' ? l.base : -l.base), 0n);
  return { base: ap.base - debit, txn: ap.txn };
}

/** The write-off row of a purchase, or null (also null on a build without the table). */
export async function writeOffRow(
  q: Queryable,
  businessId: string,
  purchaseId: string,
): Promise<{ residue: bigint; before: bigint; base: bigint; binding: string | null; reason: string; date: string } | null> {
  const exists = must((await q.query<{ t: string | null }>(`SELECT to_regclass('public.purchase_residue_write_offs')::text AS t`)).rows[0]).t;
  if (exists === null) return null;
  const r = (
    await q.query<{ residue: string; before: string; base: string; binding: string | null; reason: string; date: string }>(
      `SELECT residue_txn_minor::text AS residue, released_before_txn_minor::text AS before, residue_base_minor::text AS base,
              binding_source_id::text AS binding, reason, to_char(write_off_date, 'YYYY-MM-DD') AS date
         FROM purchase_residue_write_offs WHERE business_id = $1 AND purchase_id = $2`,
      [businessId, purchaseId],
    )
  ).rows[0];
  return r === undefined
    ? null
    : { residue: BigInt(r.residue), before: BigInt(r.before), base: BigInt(r.base), binding: r.binding, reason: r.reason, date: r.date };
}

/** Rows of the business in the tables a write-off may touch (the write-off table only where it exists). */
export async function residueCounts(q: Queryable, businessId: string): Promise<Record<string, number>> {
  const tables = [
    'supplier_returns',
    'supplier_credit_notes',
    'stock_movements',
    'supplier_payment_allocations',
    'supplier_credit_allocations',
    'journal_entries',
    'journal_lines',
    'accounting_source_bindings',
    'audit_events',
    'outbox_events',
    'inventory_assertion_uses',
  ];
  const withWriteOffs = must((await q.query<{ t: string | null }>(`SELECT to_regclass('public.purchase_residue_write_offs')::text AS t`)).rows[0]).t !== null;
  const all = withWriteOffs ? [...tables, 'purchase_residue_write_offs'] : tables;
  const r = await q.query<Record<string, number>>(`SELECT ${all.map((t) => `(SELECT count(*)::int FROM ${t} WHERE business_id = $1) AS ${t}`).join(', ')}`, [
    businessId,
  ]);
  return { ...(withWriteOffs ? {} : { purchase_residue_write_offs: 0 }), ...must(r.rows[0]) };
}

/** The ledger's base balance of the whole business (Σ debit − Σ credit): 0 when every entry balances. */
export async function ledgerImbalance(q: Queryable, businessId: string): Promise<bigint> {
  return BigInt(
    must(
      (
        await q.query<{ d: string }>(`SELECT coalesce(sum(debit_minor) - sum(credit_minor), 0)::text AS d FROM journal_lines WHERE business_id = $1`, [
          businessId,
        ])
      ).rows[0],
    ).d,
  );
}

/** The write-off request body. */
export function writeOffBody(o: { readonly date: string; readonly amount: string; readonly reason?: string | null }): Record<string, unknown> {
  return { writeOffDate: o.date, residueAmountMinor: o.amount, ...(o.reason === null ? {} : { reason: o.reason ?? 'Sub-unit residue left by a return' }) };
}

/** POST a write-off; asserts nothing. */
export function httpWriteOff(t: TestApp, by: HttpActor, businessId: string, purchaseId: string, body: Record<string, unknown>): Promise<Response> {
  return t.request.post(`/v1/purchases/${purchaseId}/residue-write-off`).set(asMember(by, businessId)).send(body);
}

/** GET the purchase's payable read. */
export async function httpPayable(t: TestApp, by: HttpActor, businessId: string, purchaseId: string): Promise<{ base: string; txn: string }> {
  const r = await t.request.get(`/v1/purchases/${purchaseId}/payable`).set(asMember(by, businessId));
  if (r.status !== 200) throw new Error(`payable read ${r.status}: ${JSON.stringify(r.body)}`);
  const body = r.body as { outstandingBaseMinor: string; outstandingTxnMinor: string };
  return { base: body.outstandingBaseMinor, txn: body.outstandingTxnMinor };
}

export interface SqlWriteOff {
  readonly purchaseId: string;
  readonly date: string;
  readonly reason: string;
  readonly residue: bigint;
  readonly releasedBefore: bigint;
  readonly residueBase: bigint;
}

/**
 * The write-off routine in the CALLER's transaction, the way the service
 * calls it: the scope GUCs and trace, a harness-signed assertion over the
 * bound payload (minted for `mintBusiness`, default `biz`), `SET LOCAL ROLE
 * daftar_app`. Posts nothing: for a residue whose base is 0.
 */
export async function sqlWriteOff(
  c: Queryable,
  biz: S3Business,
  w: SqlWriteOff,
  o: { readonly mintBusiness?: { readonly tenantId: string; readonly businessId: string }; readonly scope?: S3Business } = {},
): Promise<{ purchase_id: string; replayed: boolean }> {
  const mint = o.mintBusiness ?? biz;
  const scope = o.scope ?? biz;
  // The routine's own arguments, raw: the reason's words are the SHA-256 of
  // the text exactly as passed (untrimmed text included), as the routine
  // digests it — so the routine's own refusals are reached.
  const digest = createHash('sha256').update(Buffer.from(w.reason, 'utf8')).digest();
  const fields: InventoryPayloadField[] = [
    { kind: 'uuid', value: w.purchaseId },
    { kind: 'integer', value: yyyymmdd(w.date) },
    ...Array.from({ length: 8 }, (_, i): InventoryPayloadField => ({ kind: 'integer', value: BigInt(digest.readUInt32BE(i * 4)) })),
    { kind: 'integer', value: w.residue },
    { kind: 'integer', value: w.releasedBefore },
    { kind: 'integer', value: w.residueBase },
  ];
  const payload = buildInventoryPayload('purchase.write_off_residue', mint.tenantId, mint.businessId, fields);
  const assertion = mintTestInventoryAssertion({
    actorUserId: biz.userId,
    tenantId: mint.tenantId,
    businessId: mint.businessId,
    opCode: 'purchase.write_off_residue',
    payloadSha256: payload.sha256,
  });
  await c.query(
    `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
            set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
    [scope.tenantId, scope.businessId, assertion, randomUUID()],
  );
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<{ purchase_id: string; replayed: boolean }>(
    `SELECT purchase_id::text, replayed FROM purchase_write_off_residue($1::uuid, $2::date, $3::text, $4::bigint, $5::bigint, $6::bigint)`,
    [w.purchaseId, w.date, w.reason, w.residue.toString(10), w.releasedBefore.toString(10), w.residueBase.toString(10)],
  );
  await c.query('RESET ROLE');
  return must(r.rows[0], 'write-off row');
}
