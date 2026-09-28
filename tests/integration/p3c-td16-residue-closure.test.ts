/**
 * PHASE 3 CORRECTIVE — TD-16: NO RETURN LEAVES A SUB-UNIT AP RESIDUE, AND ONE
 * ALREADY LEFT CAN BE CLOSED (migration 0072, R-95 / R-96; directive §3,
 * BLOCKER A).
 *
 * TRY at 0.11 into an ILS business: one kurus converts to 0 agora. A frozen
 * S5 partial return released ap = least(C, O) and could leave 0 < O with
 * conv(O) = 0 — lines 49.99 + 0.01, the 49.99 returned → O = 0.01 — which no
 * merchant path can clear (settlement-s6-residue R-69(b)).
 *
 * R-95 PREVENTION: a return may not create one. The API refuses it before
 * minting (422 `supplier_return.residue_below_base_unit`, nothing written),
 * and a return committed past the service is refused at COMMIT by the new
 * deferred guard `supplier_returns_residue_bound`. The lawful paths stay open.
 *
 * R-96 CLOSURE: `POST /v1/purchases/:purchaseId/residue-write-off`
 * (`suppliers.pay`, business-wide; signed `purchase.write_off_residue`)
 * writes off exactly O when 0 < O and conv(O) = 0 and a return released AP.
 * The ledger's remaining AP base rb is then 0 or 1: rb = 0 posts nothing
 * (no journal line may carry base 0), rb = 1 posts one base-only entry, Dr
 * Accounts Payable 1 / Cr FX gain 1. Afterwards O = 0, the payable reads
 * 0 / 0, the ledger balances and every reconciliation check is ok.
 *
 * Historical residues are rebuilt with `historicalReturn` — the frozen S5
 * return (0066 alone), committed with the prevention guard disabled inside
 * that one owner transaction — exactly the state a deployed database holds.
 *
 * Every refusal writes nothing. ALLOW and DENY for the same owner's second
 * business and for another tenant; replay and concurrency; failpoints on
 * both seams; the database guards alone.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Pool, type Client } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ALL_RECONCILIATION_CHECK_IDS,
  type AccountingPostingTransaction,
  type PostEntryInTransactionRequest,
  type PostingCommand,
  type PostingResult,
} from '@daftar/accounting';
import type { SettlementEntryLine } from '@daftar/inventory';
import { Database } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { settlementPostingCommand } from '../../apps/api/src/modules/purchasing/supplier-settlement-posting';
import {
  asMember,
  attempt,
  expectAccepted,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  rolledBack,
  scratch,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { domainReversalFingerprint, reverseInTx } from '../helpers/inventory-posting';
import { runChecks, statuses } from '../helpers/inventory-reconciliation';
import {
  historicalReturn,
  httpPayable,
  httpWriteOff,
  ledgerApWithWriteOff,
  ledgerImbalance,
  residueCounts,
  sqlWriteOff,
  writeOffBody,
  writeOffEntry,
  writeOffRow,
} from '../helpers/p3c-residue';
import { postInTx } from '../helpers/purchase-commands';
import { prepareReturn, runReturn } from '../helpers/purchase-returns';
import { ownerClient } from '../helpers/stock-ledger';
import {
  expectRefusal,
  httpDraft,
  httpMethod,
  httpPay,
  httpReceived,
  outstandingOf,
  payBody,
  refusalCode,
  seedSettlementAccounts,
  settlementLedgerAp,
  stateRate,
  type HttpPurchase,
} from '../helpers/supplier-settlement';
import { createTestApp, ensurePostgres, ownerPool, reconcilerDbUrl, resetData, type TestApp } from '../helpers/test-app';

let t: TestApp;
let owner: HttpActor;
let ownerB: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;
let method: string;
let day: string;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;
let reconciler: Pool;

const REASON = 'Sub-unit residue left by a return';
const WRITE_OFF_SOURCE = 'purchase_residue_write_off';

function shift(n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  // The concurrency cases send several requests at once: the server listens
  // for the whole suite, so no request's end closes it under another.
  const server: Server = t.app.getHttpServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  owner = await registerActor(t, 'TD-16 owner');
  ownerB = await registerActor(t, 'TD-16 owner B');
  A = await onboardS3Business(t, owner, 'td16a');
  A2 = await onboardS3Business(t, owner, 'td16a2', A.tenantId);
  B = await onboardS3Business(t, ownerB, 'td16b');
  for (const biz of [A, A2, B]) await stateRate(biz, 'TRY', 'ILS', '0.1100000000', `${shift(-10)}T00:00:00Z`);
  const acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
  reconciler = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
}, 300_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await reconciler?.end();
  await t?.close();
  await resetData();
});

/** A received TRY purchase of one piece per price (major units), in `biz`. */
function tryPurchase(biz: S3Business, prices: readonly string[], o: { documentDate?: string; by?: HttpActor } = {}): Promise<HttpPurchase> {
  const products = [biz.piece.productId, biz.piece2.productId];
  return httpReceived(t, o.by ?? owner, biz, {
    currency: 'TRY',
    ...(o.documentDate === undefined ? {} : { documentDate: o.documentDate }),
    lines: prices.map((unitPrice, i) => ({ productId: must(products[i], `product ${i}`), quantity: '1', unitPrice })),
  });
}

/** A historical residue: the purchase of `prices`, line `lineIndex` returned with the frozen S5 behaviour. */
async function residuePurchase(
  biz: S3Business,
  prices: readonly string[],
  lineIndex: number,
  o: { documentDate?: string; by?: HttpActor } = {},
): Promise<HttpPurchase> {
  const p = await tryPurchase(biz, prices, o);
  await historicalReturn(biz, p, lineIndex, '1');
  return p;
}

/** A return of one piece of each of `lineIndexes` through the API. */
function httpReturnLines(biz: S3Business, p: HttpPurchase, lineIndexes: readonly number[], by: HttpActor = owner): Promise<Response> {
  return t.request
    .post(`/v1/purchases/${p.purchaseId}/returns`)
    .set(asMember(by, biz.businessId))
    .send({
      returnId: randomUUID(),
      warehouseId: p.warehouseId,
      documentDate: day,
      lines: lineIndexes.map((i) => ({ lineId: randomUUID(), purchaseLineId: must(p.lineIds[i]), quantity: '1' })),
    });
}

const writeOff = (p: HttpPurchase, body: Record<string, unknown>, biz: S3Business = A, by: HttpActor = owner): Promise<Response> =>
  httpWriteOff(t, by, biz.businessId, p.purchaseId, body);

/** A refused request writes nothing in `biz` (and nothing in `alsoIn`). */
async function refusedNothingWritten(
  send: () => Promise<Response>,
  status: number,
  code: string,
  why: string,
  biz: S3Business = A,
  alsoIn: readonly S3Business[] = [],
): Promise<void> {
  const before = await Promise.all([biz, ...alsoIn].map((b) => residueCounts(ownerPool(), b.businessId)));
  expectRefusal(await send(), status, code, why);
  expect(await Promise.all([biz, ...alsoIn].map((b) => residueCounts(ownerPool(), b.businessId))), `${why}: nothing written`).toEqual(before);
}

/** A 400 from the request grammar, writing nothing. */
async function malformed(send: () => Promise<Response>, why: string): Promise<void> {
  const before = await residueCounts(ownerPool(), A.businessId);
  const r = await send();
  expect({ status: r.status, code: (r.body as { error?: { code?: string } }).error?.code }, `${why}: ${JSON.stringify(r.body)}`).toEqual({
    status: 400,
    code: 'VALIDATION_FAILED',
  });
  expect(await residueCounts(ownerPool(), A.businessId), `${why}: nothing written`).toEqual(before);
}

const ALL_OK = Object.fromEntries(ALL_RECONCILIATION_CHECK_IDS.map((id) => [id, 'ok']));

async function reconciled(biz: S3Business): Promise<Record<string, string>> {
  return statuses(await runChecks(reconciler, { tenantId: biz.tenantId, businessId: biz.businessId }, [...ALL_RECONCILIATION_CHECK_IDS]));
}

async function warehouseBranch(biz: S3Business, warehouseId: string): Promise<string> {
  return must(
    (await ownerPool().query<{ b: string }>(`SELECT branch_id::text AS b FROM warehouses WHERE business_id = $1 AND id = $2`, [biz.businessId, warehouseId]))
      .rows[0],
  ).b;
}

/** The write-off entry a residue of base `rb` posts (Dr AP / Cr FX gain, base lines on the purchase's branch). */
function writeOffCommand(biz: S3Business, purchaseId: string, date: string, rb: bigint, branchId: string, fxGainSide: 'C' | 'D' = 'C'): PostingCommand {
  const lines: SettlementEntryLine[] = [
    { account: 'accounts_payable', side: fxGainSide === 'C' ? 'D' : 'C', currency: 'base', txnAmountMinor: rb, baseAmountMinor: rb, dimension: 'purchase' },
    { account: 'fx_gain', side: fxGainSide, currency: 'base', txnAmountMinor: rb, baseAmountMinor: rb, dimension: 'purchase' },
  ];
  return settlementPostingCommand({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceType: WRITE_OFF_SOURCE,
    sourceId: purchaseId,
    entryDate: date,
    baseCurrency: 'ILS',
    snapshots: {},
    postingAccountCode: null,
    branches: { purchase: branchId, origin: null },
    lines,
    businessTransactionId: randomUUID(),
  });
}

async function eventCounts(biz: S3Business, purchaseId: string): Promise<{ audit: number; outbox: number; outboxKeys: string[] }> {
  const a = must(
    (
      await ownerPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'purchase.residue_written_off' AND entity_id = $2`,
        [biz.businessId, purchaseId],
      )
    ).rows[0],
  ).n;
  const o = (
    await ownerPool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE business_id = $1 AND type = 'purchase.residue_written_off.v1' AND payload ->> 'purchaseId' = $2`,
      [biz.businessId, purchaseId],
    )
  ).rows;
  return { audit: a, outbox: o.length, outboxKeys: o.length === 0 ? [] : Object.keys(must(o[0]).payload).sort() };
}

// ── R-95: prevention ──────────────────────────────────────────────────────

describe('R-95: a return never leaves its purchase a sub-unit residue', () => {
  it('the exact 0.11 reproduction through the API: returning 49.99 of 49.99 + 0.01 is 422 and writes nothing; 0.04 is refused too; 0.05 and the whole purchase are accepted', async () => {
    const p = await tryPurchase(A, ['49.99', '0.01']);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toEqual({ o: 5000n, t: 5000n, b: 550n });
    const residue = 'supplier_return.residue_below_base_unit';
    await refusedNothingWritten(() => httpReturnLines(A, p, [0]), 422, residue, 'the 49.99 line leaves 0.01 (conv 0)');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'the purchase is untouched').toMatchObject({ o: 5000n });
    const r = await httpReturnLines(A, p, [0, 1]);
    expect(r.status, `the whole purchase returned leaves 0: ${JSON.stringify(r.body)}`).toBe(201);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'AP clears exactly').toEqual({ base: 0n, txn: 0n });

    const four = await tryPurchase(A, ['49.96', '0.04']);
    await refusedNothingWritten(() => httpReturnLines(A, four, [0]), 422, residue, 'the 49.96 line leaves 0.04 (conv 0.44 → 0)');
    const five = await tryPurchase(A, ['49.95', '0.05']);
    const ok = await httpReturnLines(A, five, [0]);
    expect(ok.status, `the 49.95 line leaves 0.05 (conv 0.55 → 1): ${JSON.stringify(ok.body)}`).toBe(201);
    expect(await outstandingOf(ownerPool(), A.businessId, five.purchaseId)).toMatchObject({ o: 5n });
  });

  it('the routine path: the same return committed past the service is refused at COMMIT by supplier_returns_residue_bound', async () => {
    const p = await tryPurchase(A, ['49.99', '0.01']);
    const before = await residueCounts(ownerPool(), A.businessId);
    const c = await ownerClient();
    let outcome: string;
    try {
      await c.query('BEGIN');
      const prepared = await prepareReturn(c, A, p.purchaseId, { warehouseId: p.warehouseId, lines: [{ purchaseLineId: must(p.lineIds[0]), qty: '1' }] });
      expect(prepared.plan.apTxnMinor, 'the frozen split: least(C, O) = 49.99').toBe(4999n);
      await runReturn(c, A, prepared);
      try {
        await c.query('COMMIT');
        outcome = 'committed';
      } catch (e) {
        outcome = e instanceof Error ? e.message : String(e);
      }
    } finally {
      await c.end();
    }
    expect(outcome).toMatch(/^supplier_return\.residue_below_base_unit:/);
    expect(await residueCounts(ownerPool(), A.businessId), 'nothing committed').toEqual(before);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 5000n });
  });
});

// ── R-96: closure ─────────────────────────────────────────────────────────

describe('R-96: a historical sub-unit residue is written off', () => {
  it('rb = 0 (the 0.11 reproduction): 201 → O 0, payable 0 / 0, the row, audit and outbox, no entry; replay 200; another intent 409; balanced and reconciled', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0, { documentDate: shift(-5) });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'the historical state: O = 0.01').toMatchObject({ o: 1n, t: 5000n, b: 550n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'a txn-only residue in the ledger').toEqual({ base: 0n, txn: 1n });
    expect(await httpPayable(t, owner, A.businessId, p.purchaseId), 'the payable read shows it').toEqual({ base: '0', txn: '1' });

    const body = writeOffBody({ date: day, amount: '1', reason: REASON });
    const r = await writeOff(p, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      purchaseId: p.purchaseId,
      supplierId: p.supplierId,
      currency: 'TRY',
      writeOffDate: day,
      reason: REASON,
      residueTxnMinor: '1',
      releasedBeforeTxnMinor: '4999',
      residueBaseMinor: '0',
      journalEntryId: null,
      replayed: false,
    });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'closed').toMatchObject({ o: 0n });
    expect(await httpPayable(t, owner, A.businessId, p.purchaseId), 'the payable read is closed').toEqual({ base: '0', txn: '0' });
    expect(await writeOffRow(ownerPool(), A.businessId, p.purchaseId)).toEqual({
      residue: 1n,
      before: 4999n,
      base: 0n,
      binding: null,
      reason: REASON,
      date: day,
    });
    expect(await writeOffEntry(ownerPool(), A.businessId, p.purchaseId), 'rb = 0 posts nothing').toBeNull();
    expect(await eventCounts(A, p.purchaseId)).toEqual({
      audit: 1,
      outbox: 1,
      outboxKeys: ['businessId', 'businessTransactionId', 'purchaseId', 'supplierId'],
    });
    const open = await t.request.get(`/v1/suppliers/${p.supplierId}/open-purchases`).set(asMember(owner, A.businessId));
    expect(open.status).toBe(200);
    expect(
      (open.body as { items: { purchaseId: string }[] }).items.map((i) => i.purchaseId),
      'no longer open',
    ).not.toContain(p.purchaseId);
    expect(await ledgerImbalance(ownerPool(), A.businessId), 'the ledger balances').toBe(0n);
    expect(await reconciled(A)).toEqual(ALL_OK);

    const counts = await residueCounts(ownerPool(), A.businessId);
    const again = await writeOff(p, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ purchaseId: p.purchaseId, residueTxnMinor: '1', replayed: true });
    expect(await residueCounts(ownerPool(), A.businessId), 'a replay writes nothing').toEqual(counts);
    await refusedNothingWritten(() => writeOff(p, { ...body, reason: 'Another reason' }), 409, 'purchase_residue.already_written_off', 'another intent');
    await refusedNothingWritten(() => writeOff(p, { ...body, writeOffDate: shift(-1) }), 409, 'purchase_residue.already_written_off', 'another date');
  });

  it('rb = 1 (0.10 + 0.04, the 0.10 returned: T 14, B 2, O 4): Dr AP 1 / Cr FX gain 1 on the purchase branch; the ledger AP ends 0 / 0; balanced, reconciled, not reversible', async () => {
    const p = await residuePurchase(A, ['0.10', '0.04'], 0);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toEqual({ o: 4n, t: 14n, b: 2n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'the ledger still carries one base unit').toEqual({ base: 1n, txn: 4n });
    expect(await httpPayable(t, owner, A.businessId, p.purchaseId)).toEqual({ base: '1', txn: '4' });

    const r = await writeOff(p, writeOffBody({ date: day, amount: '4' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ residueTxnMinor: '4', releasedBeforeTxnMinor: '10', residueBaseMinor: '1', replayed: false });
    const entry = must(await writeOffEntry(ownerPool(), A.businessId, p.purchaseId), 'the write-off entry');
    expect((r.body as { journalEntryId: string }).journalEntryId).toBe(entry.entryId);
    const branch = await warehouseBranch(A, p.warehouseId);
    const baseLine = { base: 1n, txnCurrency: 'ILS', txn: 1n, rateSource: 'base', rateAt: `${day}T00:00:00Z`, branchId: branch, warehouseId: null };
    expect(entry).toEqual({
      entryId: entry.entryId,
      entryDate: day,
      lines: [
        { key: 'accounts_payable', side: 'D', ...baseLine },
        { key: 'fx_gain', side: 'C', ...baseLine },
      ],
    });
    expect(await writeOffRow(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ residue: 4n, before: 10n, base: 1n, binding: p.purchaseId });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await ledgerApWithWriteOff(ownerPool(), A.businessId, p.purchaseId), 'the ledger AP ends exactly 0 in base').toEqual({ base: 0n, txn: 4n });
    expect(await httpPayable(t, owner, A.businessId, p.purchaseId), 'and the payable read 0 / 0').toEqual({ base: '0', txn: '0' });
    expect(await ledgerImbalance(ownerPool(), A.businessId)).toBe(0n);
    expect(await reconciled(A)).toEqual(ALL_OK);

    await rolledBack(async (c) => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      const command = writeOffCommand(A, p.purchaseId, day, 1n, branch);
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, entry.entryId, day, domainReversalFingerprint(command, entry.entryId, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'the generic reversal of a write-off entry',
      );
    });
  });

  it('a chain with a payment: X counts the payment and the return alike (T 99.99, 49.99 paid, the 49.99 line returned, O 0.01)', async () => {
    const p = await tryPurchase(A, ['50.00', '49.99']);
    const paid = await httpPay(
      t,
      owner,
      A,
      payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '4999' }], { currencyCode: 'TRY' }),
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await historicalReturn(A, p, 1, '1');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'X = 49.99 paid + 49.99 returned').toMatchObject({ o: 1n, t: 9999n });
    const r = await writeOff(p, writeOffBody({ date: day, amount: '1' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ residueTxnMinor: '1', releasedBeforeTxnMinor: '9998', residueBaseMinor: '0' });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await httpPayable(t, owner, A.businessId, p.purchaseId)).toEqual({ base: '0', txn: '0' });
    expect(await ledgerImbalance(ownerPool(), A.businessId)).toBe(0n);
    expect(await reconciled(A)).toEqual(ALL_OK);
  });

  it('an outstanding converting to one base unit or more is no residue: 422 not_below_base_unit (untouched 50.00; 0.05 left by a lawful return); 0.04 is written off', async () => {
    const untouched = await tryPurchase(A, ['50.00']);
    const code = 'purchase_residue.not_below_base_unit';
    await refusedNothingWritten(() => writeOff(untouched, writeOffBody({ date: day, amount: '5000' })), 422, code, 'O = 50.00');
    await refusedNothingWritten(() => writeOff(untouched, writeOffBody({ date: day, amount: '1' })), 422, code, 'O = 50.00, a stated 0.01');
    const five = await tryPurchase(A, ['49.95', '0.05']);
    expect((await httpReturnLines(A, five, [0])).status).toBe(201);
    await refusedNothingWritten(() => writeOff(five, writeOffBody({ date: day, amount: '5' })), 422, code, 'O = 0.05 converts to 1');
    const four = await residuePurchase(A, ['49.96', '0.04'], 0);
    const r = await writeOff(four, writeOffBody({ date: day, amount: '4' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ residueTxnMinor: '4', residueBaseMinor: '0', journalEntryId: null });
  });

  it('invalid requests: 400 malformed, 422 reason and dates, 409 amount / state, 404 unknown — each writes nothing', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0, { documentDate: shift(-5) });
    for (const [why, body] of [
      ['a zero amount', writeOffBody({ date: day, amount: '0' })],
      ['a negative amount', writeOffBody({ date: day, amount: '-1' })],
      ['a decimal amount', writeOffBody({ date: day, amount: '0.01' })],
      ['a leading zero', writeOffBody({ date: day, amount: '01' })],
      ['an amount as a number', { writeOffDate: day, residueAmountMinor: 1, reason: REASON }],
      ['an amount beyond 10^18', writeOffBody({ date: day, amount: '1000000000000000001' })],
      ['no amount', { writeOffDate: day, reason: REASON }],
      ['no date', { residueAmountMinor: '1', reason: REASON }],
      ['an impossible date', writeOffBody({ date: '2026-02-30', amount: '1' })],
      ['a reason over 500 characters', writeOffBody({ date: day, amount: '1', reason: 'x'.repeat(501) })],
      ['an unknown key (a stated base)', { ...writeOffBody({ date: day, amount: '1' }), residueBaseMinor: '0' }],
    ] as const) {
      await malformed(() => writeOff(p, body), why);
    }
    // The amount grammar is shared with the S6 settlement bodies: a decimal amount is 400 there too, never 500.
    await malformed(
      () =>
        httpPay(t, owner, A, {
          ...payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '1' }], { currencyCode: 'TRY' }),
          amountMinor: '0.01',
        }),
      'a decimal payment amount',
    );
    await malformed(
      () =>
        t.request
          .post('/v1/purchases/not-a-uuid/residue-write-off')
          .set(asMember(owner, A.businessId))
          .send(writeOffBody({ date: day, amount: '1' })),
      'a malformed purchase id',
    );
    await refusedNothingWritten(
      () => writeOff(p, writeOffBody({ date: day, amount: '1', reason: null })),
      422,
      'purchase_residue.reason_required',
      'no reason',
    );
    await refusedNothingWritten(
      () => writeOff(p, writeOffBody({ date: day, amount: '1', reason: '   ' })),
      422,
      'purchase_residue.reason_required',
      'a blank reason',
    );
    await refusedNothingWritten(
      () => writeOff(p, writeOffBody({ date: shift(-6), amount: '1' })),
      422,
      'purchase_residue.date_before_purchase',
      'before the purchase',
    );
    await refusedNothingWritten(() => writeOff(p, writeOffBody({ date: shift(2), amount: '1' })), 422, 'purchase_residue.date_in_future', 'in the future');
    await refusedNothingWritten(
      () => writeOff(p, writeOffBody({ date: day, amount: '2' })),
      409,
      'purchase_residue.amount_mismatch',
      'a stated 0.02 against O = 0.01',
    );
    const whole = await tryPurchase(A, ['49.99', '0.01']);
    expect((await httpReturnLines(A, whole, [0, 1])).status).toBe(201);
    await refusedNothingWritten(() => writeOff(whole, writeOffBody({ date: day, amount: '1' })), 409, 'purchase_residue.nothing_outstanding', 'fully returned');
    const draft = await httpDraft(t, owner, A, { currency: 'TRY', lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '0.01' }] });
    await refusedNothingWritten(() => writeOff(draft, writeOffBody({ date: day, amount: '1' })), 409, 'purchase.state_invalid', 'a draft');
    await refusedNothingWritten(
      () => httpWriteOff(t, owner, A.businessId, randomUUID(), writeOffBody({ date: day, amount: '1' })),
      404,
      'purchase.not_found',
      'an unknown purchase',
    );
    // The residue is still there, and still closes.
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 1n });
    expect((await writeOff(p, writeOffBody({ date: shift(-5), amount: '1' }))).status).toBe(201);
  });

  it('the permission: without suppliers.pay 403 and nothing written; a member holding only suppliers.pay writes off (201)', async () => {
    const limiter = t.app.get<{ take: (...args: unknown[]) => Promise<unknown> }>('RATE_LIMITER');
    const stub = vi.spyOn(limiter, 'take').mockResolvedValue(undefined);
    const member = async (key: string, permissions: readonly string[]): Promise<HttpActor> => {
      const role = await t.request.post('/v1/businesses/current/roles').set(asMember(owner, A.businessId)).send({ key, name: key, permissions });
      expect(role.status, JSON.stringify(role.body)).toBe(201);
      const actor = await registerActor(t, `TD-16 ${key}`);
      const m = await t.request.post('/v1/businesses/current/members').set(asMember(owner, A.businessId)).send({ email: actor.email, roleKey: key });
      expect(m.status, JSON.stringify(m.body)).toBe(201);
      return actor;
    };
    const returner = await member('td16-returner', ['purchases.view', 'purchases.return', 'suppliers.view']);
    const payer = await member('td16-payer', ['suppliers.pay']);
    stub.mockRestore();
    const p = await residuePurchase(A, ['49.99', '0.01'], 0);
    const before = await residueCounts(ownerPool(), A.businessId);
    const denied = await writeOff(p, writeOffBody({ date: day, amount: '1' }), A, returner);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await residueCounts(ownerPool(), A.businessId)).toEqual(before);
    const allowed = await writeOff(p, writeOffBody({ date: day, amount: '1' }), A, payer);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });
});

// ── concurrency ───────────────────────────────────────────────────────────

describe('R-96 concurrency: the purchase key serializes every write-off', () => {
  it('four identical write-offs at once: one 201, three replay 200; one row, one audit, one outbox', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0);
    const body = writeOffBody({ date: day, amount: '1' });
    const rs = await Promise.all(Array.from({ length: 4 }, () => writeOff(p, body)));
    expect(rs.map((r) => r.status).sort(), JSON.stringify(rs.map((r): unknown => r.body))).toEqual([200, 200, 200, 201]);
    expect(rs.map((r) => (r.body as { replayed: boolean }).replayed).filter((x) => !x)).toHaveLength(1);
    expect(await writeOffRow(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ residue: 1n });
    expect(await eventCounts(A, p.purchaseId)).toMatchObject({ audit: 1, outbox: 1 });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
  });

  it('the race forced: a write-off that commits between the idempotency proof and the state read is answered as a replay (equal intent) or already_written_off, never nothing_outstanding', async () => {
    for (const [reason, status, code] of [
      [REASON, 200, null],
      ['Another reason', 409, 'purchase_residue.already_written_off'],
    ] as const) {
      const p = await residuePurchase(A, ['49.99', '0.01'], 0);
      const winner = writeOffBody({ date: day, amount: '1' });
      const scoped = db.scoped.bind(db);
      let raced = false;
      vi.spyOn(db, 'scoped').mockImplementation(async (scope, text, params) => {
        if (!raced && text.includes('purchase_ap_outstanding($1, $3)')) {
          raced = true;
          const w = await writeOff(p, winner);
          expect(w.status, `the winner: ${JSON.stringify(w.body)}`).toBe(201);
        }
        return scoped(scope, text, params);
      });
      const r = await writeOff(p, writeOffBody({ date: day, amount: '1', reason }));
      vi.restoreAllMocks();
      expect(raced, 'the winner committed inside the state read').toBe(true);
      expect(r.status, `${reason}: ${JSON.stringify(r.body)}`).toBe(status);
      if (code === null) expect((r.body as { replayed: boolean }).replayed).toBe(true);
      else expect(refusalCode(r)).toBe(code);
      expect(await eventCounts(A, p.purchaseId)).toMatchObject({ audit: 1, outbox: 1 });
      expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    }
  });

  it('three write-offs with different reasons at once, rb = 1: one 201, two 409 already_written_off; one entry', async () => {
    const p = await residuePurchase(A, ['0.10', '0.04'], 0);
    const rs = await Promise.all(['First', 'Second', 'Third'].map((reason) => writeOff(p, writeOffBody({ date: day, amount: '4', reason }))));
    expect(rs.map((r) => r.status).sort(), JSON.stringify(rs.map((r): unknown => r.body))).toEqual([201, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) expect(refusalCode(r)).toBe('purchase_residue.already_written_off');
    expect(must(await writeOffEntry(ownerPool(), A.businessId, p.purchaseId)).lines).toHaveLength(2);
    expect(await eventCounts(A, p.purchaseId)).toMatchObject({ audit: 1, outbox: 1 });
    expect(await ledgerApWithWriteOff(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ base: 0n });
    expect(await ledgerImbalance(ownerPool(), A.businessId)).toBe(0n);
  });
});

// ── isolation ─────────────────────────────────────────────────────────────

describe('R-96 isolation: the same owner’s second business and another tenant', () => {
  it('DENY: A2 naming A’s purchase is 404 and writes nothing in either; an assertion minted for A2 cannot write off A’s purchase', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0);
    await refusedNothingWritten(() => writeOff(p, writeOffBody({ date: day, amount: '1' }), A2), 404, 'purchase.not_found', 'A2 names A’s purchase', A2, [A]);
    const w = { purchaseId: p.purchaseId, date: day, reason: REASON, residue: 1n, releasedBefore: 4999n, residueBase: 0n };
    await rolledBack(async (c) => {
      refusedWith(await attempt(c, () => sqlWriteOff(c, A, w, { mintBusiness: A2 })), 'P0001', 'inventory.assertion_scope_mismatch', 'minted for A2, run in A');
      refusedWith(await attempt(c, () => sqlWriteOff(c, A2, w)), 'P0001', 'purchase.not_found', 'A2’s own scope cannot see A’s purchase');
      // ALLOW: the same call in A's own scope.
      expect(expectAccepted(await attempt(c, () => sqlWriteOff(c, A, w)), 'A writes off its own residue')).toEqual({
        purchase_id: p.purchaseId,
        replayed: false,
      });
    });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'rolled back: still open').toMatchObject({ o: 1n });
  });

  it('ALLOW: A2 writes off its own residue; A is untouched', async () => {
    const aBefore = await residueCounts(ownerPool(), A.businessId);
    const p = await residuePurchase(A2, ['49.99', '0.01'], 0);
    const r = await writeOff(p, writeOffBody({ date: day, amount: '1' }), A2);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await outstandingOf(ownerPool(), A2.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await residueCounts(ownerPool(), A.businessId)).toEqual(aBefore);
    expect(await reconciled(A2)).toEqual(ALL_OK);
  });

  it('another tenant: B’s owner cannot act in A (403), B naming A’s purchase is 404; B writes off its own', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0);
    await refusedNothingWritten(
      async () => {
        const r = await writeOff(p, writeOffBody({ date: day, amount: '1' }), A, ownerB);
        expect(r.status).toBe(403);
        return writeOff(p, writeOffBody({ date: day, amount: '1' }), B, ownerB);
      },
      404,
      'purchase.not_found',
      'B names A’s purchase',
      A,
      [B],
    );
    const own = await residuePurchase(B, ['49.99', '0.01'], 0, { by: ownerB });
    const r = await writeOff(own, writeOffBody({ date: day, amount: '1' }), B, ownerB);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'A’s residue is untouched').toMatchObject({ o: 1n });
  });
});

// ── atomicity ─────────────────────────────────────────────────────────────

describe('R-96 atomicity: the write-off and its entry are one transaction', () => {
  type Failpoint = 'after-routine' | 'after-last-post' | 'deferred-triggers';

  function arm(fp: Failpoint): void {
    const original = posting.postEntryInTransaction.bind(posting);
    if (fp === 'after-routine') {
      vi.spyOn(posting, 'postEntryInTransaction').mockImplementation(async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest) => {
        if (request.command.sourceType === WRITE_OFF_SOURCE) throw new Error('failpoint after-routine');
        return original(tx, request);
      });
    } else if (fp === 'deferred-triggers') {
      vi.spyOn(posting, 'postEntryInTransaction').mockImplementation(
        async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest): Promise<PostingResult> => {
          if (request.command.sourceType !== WRITE_OFF_SOURCE) return original(tx, request);
          await db.presentAccountingAssertion(tx, { sourceType: request.command.sourceType, sourceId: request.command.sourceId });
          return { entryId: randomUUID(), created: true };
        },
      );
    } else {
      const seam = db.withBusinessInventoryAccountingTransaction.bind(db);
      vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementationOnce((scope, inventoryAssertions, accountingAssertions, fn) =>
        seam(scope, inventoryAssertions, accountingAssertions, async (tx) => {
          await fn(tx);
          throw new Error('failpoint after-last-post');
        }),
      );
    }
  }

  it('rb = 1 (seam 2): after-routine, after-last-post and deferred-triggers leave nothing; the same request then commits', async () => {
    const p = await residuePurchase(A, ['0.10', '0.04'], 0);
    const body = writeOffBody({ date: day, amount: '4' });
    for (const fp of ['after-routine', 'after-last-post', 'deferred-triggers'] as const) {
      const before = await residueCounts(ownerPool(), A.businessId);
      arm(fp);
      const r = await writeOff(p, body);
      vi.restoreAllMocks();
      if (fp === 'deferred-triggers') {
        expect(r.status, `${fp}: ${JSON.stringify(r.body)}`).toBe(409);
        expect((r.body as { error: unknown }).error, `${fp}: the COMMIT-time binding refusal`).toMatchObject({
          code: 'ACCOUNTING_REFUSED',
          details: { code: 'accounting.inventory_detail_missing', sourceType: WRITE_OFF_SOURCE },
        });
      } else {
        expect(r.status, `${fp}: ${JSON.stringify(r.body)}`).toBe(500);
      }
      expect(await residueCounts(ownerPool(), A.businessId), `${fp}: nothing survives`).toEqual(before);
      expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), `${fp}: still open`).toMatchObject({ o: 4n });
    }
    const r = await writeOff(p, body);
    expect(r.status, `the same request, uninjected: ${JSON.stringify(r.body)}`).toBe(201);
    expect(await ledgerApWithWriteOff(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ base: 0n });
  });

  it('rb = 0 (seam 1): a failure after the routine leaves nothing; the same request then commits', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0);
    const body = writeOffBody({ date: day, amount: '1' });
    const before = await residueCounts(ownerPool(), A.businessId);
    const seam = db.withBusinessInventoryTransaction.bind(db);
    const spy = vi.spyOn(db, 'withBusinessInventoryTransaction').mockImplementationOnce((scope, assertion, fn) =>
      seam(scope, assertion, async (tx) => {
        await fn(tx);
        throw new Error('failpoint after-routine (seam 1)');
      }),
    );
    const r = await writeOff(p, body);
    const calls = spy.mock.calls.length;
    vi.restoreAllMocks();
    expect(calls, 'the rb = 0 write-off runs on seam 1').toBe(1);
    expect(r.status, JSON.stringify(r.body)).toBe(500);
    expect(await residueCounts(ownerPool(), A.businessId)).toEqual(before);
    const ok = await writeOff(p, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

// ── the database alone ────────────────────────────────────────────────────

describe('R-96 in the database: the routine and the guards refuse what the API never sends', () => {
  /** Fire one deferred trigger now (and only it), inside a savepoint. */
  const fire = (c: Client, trigger: string) =>
    attempt(c, async () => {
      await c.query(`SET CONSTRAINTS ${trigger} IMMEDIATE`);
      await c.query(`SET CONSTRAINTS ${trigger} DEFERRED`);
    });

  it('the routine re-derives O, X and rb under its lock: every other statement is amount_mismatch; O converting to a unit is not_below_base_unit', async () => {
    const p = await residuePurchase(A, ['49.99', '0.01'], 0);
    const lawful = { purchaseId: p.purchaseId, date: day, reason: REASON, residue: 1n, releasedBefore: 4999n, residueBase: 0n };
    const untouched = await tryPurchase(A, ['50.00']);
    await rolledBack(async (c) => {
      for (const [why, w] of [
        ['a stated residue of 2', { ...lawful, residue: 2n }],
        ['a chain point of 4998', { ...lawful, releasedBefore: 4998n }],
        ['a base of 1', { ...lawful, residueBase: 1n }],
      ] as const) {
        refusedWith(await attempt(c, () => sqlWriteOff(c, A, w)), 'P0001', 'purchase_residue.amount_mismatch', why);
      }
      refusedWith(
        await attempt(c, () => sqlWriteOff(c, A, { ...lawful, purchaseId: untouched.purchaseId, residue: 5000n, releasedBefore: 1n })),
        'P0001',
        'purchase_residue.not_below_base_unit',
        'O = 50.00',
      );
      refusedWith(
        await attempt(c, () => sqlWriteOff(c, A, { ...lawful, reason: ' padded ' })),
        'P0001',
        'purchase_residue.reason_required',
        'an untrimmed reason',
      );
      expectAccepted(await attempt(c, () => sqlWriteOff(c, A, lawful)), 'the lawful statement');
      expectAccepted(await fire(c, 'purchase_residue_write_offs_value_complete'), 'its COMMIT guard');
      refusedWith(
        await attempt(c, () => sqlWriteOff(c, A, { ...lawful, reason: 'Other' })),
        'P0001',
        'purchase_residue.already_written_off',
        'a second write-off',
      );
    });
  });

  it('the row is immutable: UPDATE and DELETE refused; an INSERT outside the command refused; a forged row with the trace refused at COMMIT', async () => {
    const done = await residuePurchase(A, ['49.99', '0.01'], 0);
    expect((await writeOff(done, writeOffBody({ date: day, amount: '1' }))).status).toBe(201);
    const open = await residuePurchase(A, ['49.99', '0.01'], 0);
    await rolledBack(async (c) => {
      refusedWith(
        await attempt(c, () =>
          c.query(`UPDATE purchase_residue_write_offs SET reason = 'Edited' WHERE business_id = $1 AND id = $2`, [A.businessId, done.purchaseId]),
        ),
        'P0001',
        'purchase_residue.immutable',
        'UPDATE',
      );
      refusedWith(
        await attempt(c, () => c.query(`DELETE FROM purchase_residue_write_offs WHERE business_id = $1 AND id = $2`, [A.businessId, done.purchaseId])),
        'P0001',
        'purchase_residue.immutable',
        'DELETE',
      );
      const forge = (residue: string, before: string) =>
        c.query(
          `INSERT INTO purchase_residue_write_offs (tenant_id, business_id, id, purchase_id, supplier_id, currency_code, source_to_base_rate, write_off_date,
                                                    reason, residue_txn_minor, released_before_txn_minor, residue_base_minor, intent_sha256,
                                                    business_transaction_id, created_by)
           SELECT p.tenant_id, p.business_id, p.id, p.id, p.supplier_id, p.currency_code, p.source_to_base_rate, $3::date,
                  'Forged', $4::bigint, $5::bigint, 0, repeat('a', 64), coalesce(nullif(current_setting('app.business_transaction_id', true), '')::uuid, gen_random_uuid()), $6
             FROM purchases p WHERE p.business_id = $1 AND p.id = $2`,
          [A.businessId, open.purchaseId, day, residue, before, A.userId],
        );
      refusedWith(await attempt(c, () => forge('1', '4999')), 'P0001', 'purchase_residue.immutable', 'an INSERT without the command’s trace');
      // The command's scope and trace, as a command's transaction carries them: the value guard then judges the row alone.
      await c.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.business_transaction_id', $3, true)`,
        [A.tenantId, A.businessId, randomUUID()],
      );
      refusedWith(
        await scratch(c, async () => {
          await forge('2', '4998');
          return fire(c, 'purchase_residue_write_offs_value_complete');
        }),
        'P0001',
        'purchase_residue.settlement_inconsistent',
        'a forged amount, fired at COMMIT',
      );
      const honestShape = await scratch(c, async () => {
        await forge('1', '4999');
        return fire(c, 'purchase_residue_write_offs_value_complete');
      });
      expectAccepted(honestShape, 'the terminal residue passes the value guard (the forged row is proven by value, not by its author)');
    });
  });

  it('the rb = 1 entry is proven at COMMIT: a mismatched entry is inventory_entry_mismatch; the honest one passes', async () => {
    const p = await residuePurchase(A, ['0.10', '0.04'], 0);
    const branch = await warehouseBranch(A, p.warehouseId);
    const w = { purchaseId: p.purchaseId, date: day, reason: REASON, residue: 4n, releasedBefore: 10n, residueBase: 1n };
    await rolledBack(async (c) => {
      expectAccepted(await attempt(c, () => sqlWriteOff(c, A, w)), 'the routine');
      refusedWith(
        await scratch(c, async () => {
          await postInTx(c, writeOffCommand(A, p.purchaseId, day, 1n, branch, 'D'), A.userId);
          return fire(c, 'journal_entries_purchase_residue_write_off_complete');
        }),
        'P0001',
        'accounting.inventory_entry_mismatch',
        'Cr AP / Dr FX gain',
      );
      const honest = await scratch(c, async () => {
        await postInTx(c, writeOffCommand(A, p.purchaseId, day, 1n, branch), A.userId);
        const entry = await fire(c, 'journal_entries_purchase_residue_write_off_complete');
        const row = await fire(c, 'purchase_residue_write_offs_value_complete');
        return entry.ok ? row : entry;
      });
      expectAccepted(honest, 'Dr AP 1 / Cr FX gain 1');
    });
  });
});
