/**
 * PHASE 3 CORRECTIVE — S8 I-1: AN ALLOWED REVERSAL MUST NOT TURN R-INV-01 RED
 * (the Tech Lead's corrective directive §4; migration 0071, R-B1b).
 *
 * Before 0071 R-B1a (0069) admitted every reversal. Two offsetting manual
 * Inventory lines posted before the first stock movement, then a stock
 * movement, then the reversal of ONE of them: accepted, and R-INV-01 red.
 *
 * After 0071, once the business has a stock movement, a generic reversal of a
 * manual adjustment or an opening balance that would turn a RECONCILED
 * business red (R-INV-01's own equality, asked of the inventory domain as
 * booleans) is refused at COMMIT with `accounting.inventory_account_domain_owned`;
 * the correction path for stock is `inventory.adjust`, and 0069's correction
 * path for pre-foundation residue (reversing it) stays open. Proved here through the real
 * primitives as `daftar_app` with real assertions, and over HTTP:
 *
 *   - the exact reproduction: refused, nothing written, R-INV-01..05 stay ok;
 *   - a pre-stock reversal stays lawful (and brings R-INV-01 back to ok);
 *   - reversing pre-foundation residue after the movement stays lawful and
 *     makes R-INV-01 ok; a business R-INV-01 already reports is not refused;
 *   - domain-owned entries still cannot use the generic reversal, and
 *     purchase.reverse (the domain route) is still accepted;
 *   - no false refusal on unrelated accounts, before or after the movement;
 *   - SET CONSTRAINTS <trigger> | ALL IMMEDIATE, before and after the
 *     posting: still refused, and still no false refusal;
 *   - same-transaction edge cases;
 *   - tenant and same-owner second-business isolation: the rule is judged
 *     per business (A2 and B, which have no movement, keep Phase 2);
 *   - reconciliation stays zero after every permitted path;
 *   - NEGATIVE CONTROL: with the 0071 trigger dropped (scratch database), the
 *     same reversal commits and R-INV-01 reports the business.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appClient,
  assertionFor as accountingAssertionFor,
  type PostCommand,
  type PostOutcome,
  postAs,
  postReversalAs,
  reversalFingerprintOf,
  sourceAssertion,
} from '../helpers/accounting-posting';
import {
  asMember,
  glInventory,
  must,
  onboardS3Business,
  registerActor,
  seedS3World,
  today,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { domainReversalFingerprint, reverseInTx, stockUp } from '../helpers/inventory-posting';
import { resultOf, runChecks, statuses } from '../helpers/inventory-reconciliation';
import { prepareReversal, receivedPurchase, runReversal } from '../helpers/purchase-returns';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { attempt, expectAccepted, expectRefused, settle, type Outcome } from '../helpers/stock-ledger';
import { changedTables, tableDigest } from '../helpers/table-digest';
import { appDbUrl, createTestApp, dbUrl, ensurePostgres, ownerPool, reconcilerDbUrl, resetData, type TestApp } from '../helpers/test-app';

const CODE = 'accounting.inventory_account_domain_owned';
const TRIGGER = 'journal_entries_inventory_reversal_domain';
const ALL_OK = { 'R-INV-01': 'ok', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' };

const TABLES = [
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'accounting_reversals',
  'accounting_assertion_uses',
  'audit_events',
  'outbox_events',
  'stock_movements',
  'stock_levels',
  'stock_source_bindings',
  'inventory_adjustments',
  'inventory_adjustment_lines',
];

let day: string;
let seq = 0;
let reconciler: Pool;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  reconciler = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
}, 300_000);

afterAll(async () => {
  await reconciler.end();
  await resetData();
});

async function world(pool: Pool = ownerPool()): Promise<S3World> {
  seq += 1;
  return seedS3World(pool, `i1-${seq}-${randomUUID().slice(0, 6)}`);
}

const AT = new Date('2026-03-14T09:15:00Z');

/** A balanced manual adjustment `debit` Dr / `credit` Cr, ILS. */
function manual(biz: S3Business, debit: string, credit: string, amount = 500n): PostCommand {
  const line = (systemKey: string, side: 'D' | 'C'): PostCommand['lines'][number] => ({
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: AT,
    branchId: null,
    warehouseId: null,
  });
  return {
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate: day,
    description: 'I-1 manual adjustment',
    requestId: randomUUID(),
    lines: [line(debit, 'D'), line(credit, 'C')],
  };
}

/** A posted manual adjustment: the command and its entry. */
interface Posted {
  readonly cmd: PostCommand;
  readonly entryId: string;
}

/** Post and COMMIT `cmd` as daftar_app on `url`. */
async function post(cmd: PostCommand, biz: S3Business, url: string = appDbUrl): Promise<Posted> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const r = await postAs(accountingAssertionFor(cmd, biz.userId), cmd, {}, c);
    await c.query('COMMIT');
    return { cmd, entryId: r.entryId };
  } finally {
    await c.end();
  }
}

/** The `reverse` assertion over the mirrored lines of `p`. */
function reverseAssertion(biz: S3Business, p: Posted): string {
  return sourceAssertion({
    actorUserId: biz.userId,
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: p.entryId,
    postingFingerprint: reversalFingerprintOf(p.cmd, p.entryId, day),
  });
}

/** The generic reversal of `p` in its own daftar_app transaction, through a real COMMIT. */
function reverse(biz: S3Business, p: Posted, url: string = appDbUrl): Promise<Outcome<PostOutcome>> {
  return settle(async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      const r = await postReversalAs(reverseAssertion(biz, p), p.entryId, day, 'I-1 reversal', randomUUID(), c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  });
}

/** The generic reversal of `p` as daftar_app inside the caller's open transaction. */
function reverseHere(c: Client, biz: S3Business, p: Posted): Promise<string> {
  return reverseInTx(c, biz, p.entryId, day, reversalFingerprintOf(p.cmd, p.entryId, day));
}

async function committed<T>(fn: (c: Client) => Promise<T>, url: string = dbUrl): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const v = await fn(c);
    await c.query('COMMIT');
    return v;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

/** The business's first stock movement: a committed inventory.adjust gain (2 × 5) with its entry. */
async function firstMovement(biz: S3Business, url: string = dbUrl): Promise<void> {
  await committed(async (c) => {
    const r = await stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '2', unitCost: '5' }]);
    expect(r.entry?.created).toBe(true);
  }, url);
}

/** Two offsetting pre-stock manual Inventory entries: +500 and −500 (GL Inventory nets to zero). */
async function offsettingPair(biz: S3Business, url: string = appDbUrl): Promise<readonly [Posted, Posted]> {
  const plus = await post(manual(biz, 'inventory', 'opening_equity'), biz, url);
  const minus = await post(manual(biz, 'opening_equity', 'inventory'), biz, url);
  return [plus, minus];
}

async function recon(biz: S3Business, pool: Pool = reconciler): Promise<Record<string, string>> {
  return statuses(await runChecks(pool, { tenantId: biz.tenantId, businessId: biz.businessId }));
}

const digest = (businessId: string): Promise<Readonly<Record<string, string>>> => tableDigest(ownerPool(), TABLES, { businessId });

describe('I-1 the exact reproduction: offsetting pre-stock lines, first movement, reverse one', () => {
  it('each of the two reversals is refused at COMMIT with the stable code; nothing is written; R-INV-01..05 stay ok', async () => {
    const { A } = await world();
    const [plus, minus] = await offsettingPair(A);
    expect(await glInventory(ownerPool(), A.businessId)).toBe(0n);
    await firstMovement(A);
    expect(await recon(A)).toEqual(ALL_OK);
    const before = await digest(A.businessId);
    // The statement is accepted (the guard is deferred) and COMMIT refuses it.
    const c = await appClient();
    try {
      await c.query('BEGIN');
      expectAccepted(await settle(() => postReversalAs(reverseAssertion(A, plus), plus.entryId, day, 'I-1', randomUUID(), c)), 'the statement');
      expectRefused(await settle(() => c.query('COMMIT')), 'P0001', CODE, 'COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expectRefused(await reverse(A, minus), 'P0001', CODE, 'the credit-side entry');
    expect(changedTables(before, await digest(A.businessId)), 'nothing survives').toEqual([]);
    expect(await recon(A)).toEqual(ALL_OK);
  });

  it('the refusal carries guidance to the inventory adjustment workflow and no amount', async () => {
    const { A } = await world();
    const [plus] = await offsettingPair(A);
    await firstMovement(A);
    const o = await reverse(A, plus);
    expectRefused(o, 'P0001', CODE);
    expect(o.ok ? '' : o.message).toMatch(
      /a reversal may not move the Inventory account away from the stock ledger; correct the stock and its value with an inventory adjustment/,
    );
    expect(o.ok ? '' : o.message).not.toMatch(/\b500\b/);
  });
});

describe('I-1 permitted paths stay permitted, and reconciliation stays zero after each', () => {
  it('a pre-stock reversal is lawful: the single pre-stock Inventory entry reversed brings R-INV-01 back to ok', async () => {
    const { A } = await world();
    const plus = await post(manual(A, 'inventory', 'opening_equity', 700n), A);
    expect((await recon(A))['R-INV-01']).toBe('discrepancy');
    expectAccepted(await reverse(A, plus), 'pre-stock reversal');
    expect(await glInventory(ownerPool(), A.businessId)).toBe(0n);
    expect(await recon(A)).toEqual(ALL_OK);
    // ... and the stock ledger may begin afterwards, reconciled.
    await firstMovement(A);
    expect(await recon(A)).toEqual(ALL_OK);
  });

  it('the 0069 correction path stays open: pre-foundation residue reversed after the movement is admitted and R-INV-01 becomes ok', async () => {
    const { A } = await world();
    const residue = await post(manual(A, 'inventory', 'opening_equity', 900n), A);
    await firstMovement(A);
    expect((await recon(A))['R-INV-01']).toBe('discrepancy');
    expectAccepted(await reverse(A, residue), 'the reversal of the residue');
    expect(await recon(A)).toEqual(ALL_OK);
  });

  it('a business R-INV-01 already reports is not turned red by the reversal (it was red): admitted as before, still reported', async () => {
    const { A } = await world();
    await post(manual(A, 'inventory', 'opening_equity', 700n), A);
    const [plus] = await offsettingPair(A);
    await firstMovement(A);
    expect((await recon(A))['R-INV-01']).toBe('discrepancy');
    expectAccepted(await reverse(A, plus), 'reversal on an already-reported business');
    expect((await recon(A))['R-INV-01']).toBe('discrepancy');
  });

  it('no false refusal on unrelated accounts: a manual cash/equity entry is reversed after the movement', async () => {
    const { A } = await world();
    const before = await post(manual(A, 'cash', 'opening_equity', 300n), A);
    await firstMovement(A);
    const after = await post(manual(A, 'accounts_payable', 'cash', 200n), A);
    expectAccepted(await reverse(A, before), 'pre-stock cash entry reversed after stock');
    expectAccepted(await reverse(A, after), 'post-stock cash entry reversed');
    expect(await recon(A)).toEqual(ALL_OK);
  });

  it('purchase.reverse — a domain reversal with Inventory lines — is still accepted after movements, reconciled', async () => {
    const { A } = await world();
    const p = await committed((c) => receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '3', unitPriceMinor: '40' }]));
    const run = await committed(async (c) => runReversal(c, A, await prepareReversal(c, A, p.purchaseId)));
    expect(must(run.entry).created).toBe(true);
    expect(await recon(A)).toEqual(ALL_OK);
  });
});

describe('I-1 domain-owned entries still cannot use the generic reversal', () => {
  it('the inventory adjustment entry and a purchase entry → reversal_source_domain_owned (unchanged by 0071)', async () => {
    const { A } = await world();
    await committed(async (c) => {
      const gain = await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '4' }]);
      const p = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '50' }]);
      const g = must(gain.entry);
      const gc = must(gain.command);
      expectRefused(
        await attempt(c, () => reverseInTx(c, A, g.entryId, day, domainReversalFingerprint(gc, g.entryId, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'inventory adjustment entry',
      );
      expectRefused(
        await attempt(c, () => reverseInTx(c, A, p.entryId, day, domainReversalFingerprint(p.run.postings.purchase, p.entryId, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'purchase entry',
      );
    });
    const generic = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_reversals WHERE business_id = $1`, [A.businessId]);
    expect(generic.rows[0]?.n, 'no generic reversal was written').toBe(0);
    expect(await recon(A)).toEqual(ALL_OK);
  });
});

describe('I-1 SET CONSTRAINTS … IMMEDIATE cannot switch the rule off, and causes no false refusal', () => {
  {
    const mode = TRIGGER;
    it(`${mode} IMMEDIATE before the posting: the Inventory reversal is refused at the statement; an unrelated reversal commits`, async () => {
      const { A } = await world();
      const [plus] = await offsettingPair(A);
      const cash = await post(manual(A, 'cash', 'opening_equity', 100n), A);
      await firstMovement(A);
      const c = await appClient();
      try {
        await c.query('BEGIN');
        await c.query(`SET CONSTRAINTS ${mode} IMMEDIATE`);
        expectRefused(await attempt(c, () => postReversalAs(reverseAssertion(A, plus), plus.entryId, day, 'I-1', randomUUID(), c)), 'P0001', CODE, mode);
        expectAccepted(await attempt(c, () => postReversalAs(reverseAssertion(A, cash), cash.entryId, day, 'I-1', randomUUID(), c)), 'unrelated');
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      const reversed = await ownerPool().query<{ o: string }>(
        `SELECT original_entry_id::text AS o FROM accounting_reversals WHERE business_id = $1 ORDER BY 1`,
        [A.businessId],
      );
      expect(
        reversed.rows.map((r) => r.o),
        'only the unrelated reversal committed',
      ).toEqual([cash.entryId]);
      expect(await recon(A)).toEqual(ALL_OK);
    });
  }

  it('ALL IMMEDIATE before the posting: the Inventory reversal is refused (the generic reversal writes its binding after its header, so ALL IMMEDIATE admits no reversal at all — Phase 2 behaviour); nothing is written', async () => {
    const { A } = await world();
    const [plus] = await offsettingPair(A);
    await firstMovement(A);
    const before = await digest(A.businessId);
    const c = await appClient();
    try {
      await c.query('BEGIN');
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const o = await attempt(c, () => postReversalAs(reverseAssertion(A, plus), plus.entryId, day, 'I-1', randomUUID(), c));
      expect(o.ok, 'refused under ALL IMMEDIATE').toBe(false);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
    expect(await recon(A)).toEqual(ALL_OK);
  });

  it('SET CONSTRAINTS ALL IMMEDIATE issued AFTER the posting fires the guard with every line visible: refused', async () => {
    const { A } = await world();
    const [plus] = await offsettingPair(A);
    await firstMovement(A);
    const c = await appClient();
    try {
      await c.query('BEGIN');
      expectAccepted(await settle(() => postReversalAs(reverseAssertion(A, plus), plus.entryId, day, 'I-1', randomUUID(), c)));
      expectRefused(await settle(() => c.query('SET CONSTRAINTS ALL IMMEDIATE')), 'P0001', CODE, 'after the posting');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await recon(A)).toEqual(ALL_OK);
  });
});

describe('I-1 same-transaction edge cases', () => {
  it('first movement, then the reversal, in ONE transaction: refused at COMMIT, neither survives', async () => {
    const { A } = await world();
    const [plus] = await offsettingPair(A);
    const before = await digest(A.businessId);
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '3' }]);
      await reverseHere(c, A, plus);
      expectRefused(await settle(() => c.query('COMMIT')), 'P0001', CODE, 'COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
  });

  it('the reversal, then the first movement, in ONE transaction: judged at COMMIT, refused', async () => {
    const { A } = await world();
    const [plus] = await offsettingPair(A);
    const before = await digest(A.businessId);
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await reverseHere(c, A, plus);
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '3' }]);
      expectRefused(await settle(() => c.query('COMMIT')), 'P0001', CODE, 'COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
  });

  it('after the movement, reversing BOTH offsetting entries in ONE transaction is judged on the state both leave: admitted, reconciled', async () => {
    const { A } = await world();
    const [plus, minus] = await offsettingPair(A);
    await firstMovement(A);
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await reverseHere(c, A, plus);
      await reverseHere(c, A, minus);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(await recon(A)).toEqual(ALL_OK);
  });

  it('no movement at all: a manual Inventory entry posted and reversed in ONE transaction commits (Phase 2), reconciled', async () => {
    const { A } = await world();
    const cmd = manual(A, 'inventory', 'opening_equity', 400n);
    const c = await appClient();
    try {
      await c.query('BEGIN');
      const r = await postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c);
      await postReversalAs(reverseAssertion(A, { cmd, entryId: r.entryId }), r.entryId, day, 'I-1', randomUUID(), c);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(await glInventory(ownerPool(), A.businessId)).toBe(0n);
    expect(await recon(A)).toEqual(ALL_OK);
  });
});

describe('I-1 isolation: the rule is judged per business', () => {
  it('A has stock and is refused; its same-owner sibling A2 and another tenant’s B have none and keep Phase 2 (ALLOW); A’s movement never decides for them', async () => {
    const { A, A2, B } = await world();
    const [plusA] = await offsettingPair(A);
    const plusA2 = await post(manual(A2, 'inventory', 'opening_equity', 600n), A2);
    const plusB = await post(manual(B, 'inventory', 'opening_equity', 800n), B);
    await firstMovement(A);
    expectRefused(await reverse(A, plusA), 'P0001', CODE, 'A');
    expectAccepted(await reverse(A2, plusA2), 'A2, same owner, no movement');
    expectAccepted(await reverse(B, plusB), 'B, another tenant, no movement');
    for (const biz of [A, A2, B]) expect(await recon(biz)).toEqual(ALL_OK);
  });

  it('DENY: the same owner, acting in A2, cannot reverse A’s entry; nothing is written in either business', async () => {
    const { A, A2 } = await world();
    const [plusA] = await offsettingPair(A);
    const beforeA = await digest(A.businessId);
    const beforeA2 = await digest(A2.businessId);
    const inA2 = sourceAssertion({
      actorUserId: A2.userId,
      tenantId: A2.tenantId,
      businessId: A2.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: plusA.entryId,
      postingFingerprint: reversalFingerprintOf({ ...plusA.cmd, tenantId: A2.tenantId, businessId: A2.businessId }, plusA.entryId, day),
    });
    const o = await settle(() => postReversalAs(inA2, plusA.entryId, day, 'I-1 cross-business', randomUUID()));
    expect(o.ok, 'refused').toBe(false);
    expect(changedTables(beforeA, await digest(A.businessId))).toEqual([]);
    expect(changedTables(beforeA2, await digest(A2.businessId))).toEqual([]);
  });
});

describe('I-1 over HTTP: 409 ACCOUNTING_REFUSED with details.code', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('POST …/entries/:id/reversals of a pre-stock Inventory entry after the first movement → 409; of a cash entry → 201', async () => {
    const owner = await registerActor(t, 'I-1 owner');
    const A = await onboardS3Business(t, owner, `i1-http-${randomUUID().slice(0, 6)}`);
    const money = {
      baseAmountMinor: '500',
      baseCurrency: 'ILS',
      txnAmountMinor: '500',
      txnCurrency: 'ILS',
      fxRate: '1',
      fxRateSource: 'base',
      fxRateAt: '2026-03-14T09:15:00Z',
    } as const;
    const adjust = async (debit: string, credit: string): Promise<string> => {
      const r = await t.request
        .post(`/v1/businesses/${A.businessId}/accounting/adjustments`)
        .set(asMember(owner, A.businessId))
        .set('Idempotency-Key', randomUUID())
        .send({
          entryDate: day,
          description: 'I-1 over HTTP',
          reason: 'I-1 over HTTP',
          lines: [
            { account: { kind: 'system', systemKey: debit }, side: 'D', ...money },
            { account: { kind: 'system', systemKey: credit }, side: 'C', ...money },
          ],
        });
      expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
      return String(r.body.entryId ?? r.body.id);
    };
    const inv = await adjust('inventory', 'opening_equity');
    await adjust('opening_equity', 'inventory');
    const cash = await adjust('cash', 'opening_equity');
    await firstMovement(A);
    const before = await digest(A.businessId);
    const reverseHttp = (entryId: string): Promise<{ status: number; body: { error?: unknown } }> =>
      t.request
        .post(`/v1/businesses/${A.businessId}/accounting/entries/${entryId}/reversals`)
        .set(asMember(owner, A.businessId))
        .set('Idempotency-Key', randomUUID())
        .send({ entryDate: day, reason: 'I-1 over HTTP' })
        .then((r) => ({ status: r.status, body: r.body as { error?: unknown } }));
    const refused = await reverseHttp(inv);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'ACCOUNTING_REFUSED', details: { code: CODE } });
    expect(JSON.stringify(refused.body)).not.toMatch(/\b500\b/);
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
    const ok = await reverseHttp(cash);
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
    expect(await recon(A)).toEqual(ALL_OK);
  });
});

describe('I-1 NEGATIVE CONTROL — with the 0071 trigger dropped, the reversal commits and R-INV-01 reports the business', () => {
  let scratch: ScratchDb;
  let A: S3Business;
  let plus: Posted;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3c_i1_nc');
    A = (await seedS3World(scratch.pool, 'i1-nc')).A;
    [plus] = await offsettingPair(A, scratch.url('daftar_app'));
    await firstMovement(A, scratch.url());
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('as shipped: refused, R-INV-01..05 ok', async () => {
    expectRefused(await reverse(A, plus, scratch.url('daftar_app')), 'P0001', CODE, 'scratch, as shipped');
    expect(await recon(A, scratch.poolAs('daftar_reconciler'))).toEqual(ALL_OK);
  });

  it('trigger dropped: the same reversal commits and R-INV-01 — only R-INV-01 — names exactly the business', async () => {
    await scratch.pool.query(`DROP TRIGGER ${TRIGGER} ON journal_entries`);
    expectAccepted(await reverse(A, plus, scratch.url('daftar_app')), 'scratch, trigger dropped');
    const run = await runChecks(scratch.poolAs('daftar_reconciler'), { tenantId: A.tenantId, businessId: A.businessId });
    expect(statuses(run)).toEqual({ ...ALL_OK, 'R-INV-01': 'discrepancy' });
    expect(resultOf(run, 'R-INV-01').offendingIds).toEqual([A.businessId]);
  });
});
