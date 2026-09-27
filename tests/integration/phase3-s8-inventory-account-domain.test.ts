/**
 * P3-S8 T-19 — THE INVENTORY ACCOUNT BELONGS TO THE INVENTORY DOMAIN ONCE THE
 * BUSINESS HAS A STOCK LEDGER (docs/PHASE_3_S8_CONTRACT.md Annex R §2, R-B1a,
 * B-1 as the Tech Lead ruled it on 2026-09-27; 0069 R-91 … R-93).
 *
 * After a business's first stock movement, a journal entry of source type
 * `manual_adjustment` or `opening_balance` that carries a line on the
 * business's Inventory system account (`system_key = 'inventory'`) is refused
 * at COMMIT with `accounting.inventory_account_domain_owned` (P0001). Proved
 * here through the real commands, as `daftar_app`, with real assertions:
 *
 *   - a business with no movement keeps Phase 2 behaviour: both accepted;
 *   - a committed movement, then a manual Inventory line: refused AT COMMIT
 *     (the statement is accepted), nothing written;
 *   - a movement earlier in the SAME transaction: refused;
 *   - manual lines on other accounts: accepted;
 *   - an opening balance after movements: with Inventory refused, without it
 *     posted;
 *   - a reversal of a pre-foundation manual Inventory entry, and
 *     `purchase.reverse`: accepted (reversals are the correction path);
 *   - session GUCs unset or foreign at COMMIT: still refused (fail-closed:
 *     the question is asked of the inventory principal, R-92);
 *   - over HTTP: 409 ACCOUNTING_REFUSED with `details.code` (Annex R §2.9);
 *   - the catalogue shape of the helper, the guard and the trigger, with the
 *     two bodies' digests recorded here (the stock-source gaps discovery does
 *     not list an accounting-side guard, so this suite is where its body is
 *     pinned);
 *   - the race "manual entry ∥ first receipt" ends in one of the two serial
 *     outcomes (§2.6);
 *   - `SET CONSTRAINTS <trigger> | ALL IMMEDIATE` cannot switch the guard off:
 *     forced early, before any line is visible, it refuses (0069 R-94);
 *   - NEGATIVE CONTROL: in a scratch database built from the real migrations,
 *     with the trigger dropped, the same manual Inventory line commits and
 *     R-INV-01 reports the business as a discrepancy.
 */
import { randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appClient,
  assertionFor as accountingAssertionFor,
  type PostOutcome,
  postAs,
  postReversalAs,
  reversalFingerprintOf,
  sourceAssertion,
  type PostCommand,
} from '../helpers/accounting-posting';
import { asMember, glInventory, must, onboardS3Business, ownerClient, registerActor, seedS3World, today, type S3Business } from '../helpers/inventory-commands';
import { position, postOpeningBalanceInTx, stockUp } from '../helpers/inventory-posting';
import { prepareReversal, receivedPurchase, runReversal } from '../helpers/purchase-returns';
import { expectAccepted, expectRefused, settle, type Outcome } from '../helpers/stock-ledger';
import { appDbUrl, createTestApp, dbUrl, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { changedTables, tableDigest } from '../helpers/table-digest';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { resultOf, runChecks, statuses } from '../helpers/inventory-reconciliation';
import { R_B1A_GUARD_BODY_MD5, R_B1A_HELPER_BODY_MD5 } from '../../scripts/phase3-s8-gate';

const CODE = 'accounting.inventory_account_domain_owned';
const TRIGGER = 'journal_entries_inventory_account_domain';
const GUARD = 'accounting_inventory_account_domain_guard()';
const HELPER = 'inventory_business_has_stock_movements(uuid)';
const PINNED = ['search_path=pg_catalog, public, pg_temp'];

/**
 * The md5 of each R-B1a body as 0069 ships it. A change to either body is a
 * change to the rule and must be reviewed here (the gaps discoveries of
 * 0061/0067 enumerate stock-source and settlement guards, not this one).
 */
const GUARD_BODY_MD5 = 'c6254815e09d55cf6072c3a465519183';
const HELPER_BODY_MD5 = '4f3b6dd09d6ac5084051891072e1c9f7';

/** Every business-scoped table a refused posting must leave byte-identical. */
const ACCOUNTING_TABLES = [
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'accounting_manual_adjustments',
  'accounting_opening_balances',
  'accounting_opening_balance_lines',
  'accounting_reversals',
  'accounting_assertion_uses',
  'audit_events',
  'outbox_events',
];
const STOCK_TABLES = ['stock_movements', 'stock_levels', 'stock_source_bindings', 'inventory_adjustments', 'inventory_adjustment_lines'];

let day: string;
let seq = 0;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
});

afterAll(async () => {
  await resetData();
});

/** A business of its own for one case: committed state never leaks between cases. */
async function fresh(pool: Pool = ownerPool()): Promise<S3Business> {
  seq += 1;
  return (await seedS3World(pool, `t19-${seq}-${randomUUID().slice(0, 6)}`)).A;
}

const AT = new Date('2026-03-14T09:15:00Z');

/** A balanced manual adjustment: `debit` Dr / `credit` Cr, ILS. */
function manual(biz: S3Business, debit: string, credit: string, amount = 500n, entryDate = day): PostCommand {
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
    entryDate,
    description: 'T-19 manual adjustment',
    requestId: randomUUID(),
    lines: [line(debit, 'D'), line(credit, 'C')],
  };
}

/**
 * The manual adjustment in its own transaction, on a fresh `daftar_app`
 * connection to `url` (the shared database by default), through a real
 * COMMIT — where the deferred guard is judged.
 */
async function postManual(cmd: PostCommand, biz: S3Business, extraGucs: Record<string, string> = {}, url: string = appDbUrl): Promise<Outcome<PostOutcome>> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await settle(async () => {
      await c.query('BEGIN');
      const r = await postAs(accountingAssertionFor(cmd, biz.userId), cmd, extraGucs, c);
      await c.query('COMMIT');
      return r;
    });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

/** Run `fn` in an owner transaction and COMMIT it (the setup a case builds on). */
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

/** One committed stock gain (a real inventory.adjust with its entry): the business's first movement. */
async function firstMovement(biz: S3Business, url: string = dbUrl): Promise<void> {
  await committed(async (c) => {
    const r = await stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '2', unitCost: '5' }]);
    expect(r.entry?.created, 'the gain posts its inventory_adjustment entry').toBe(true);
  }, url);
}

async function hasMovements(q: Pool | Client, businessId: string): Promise<boolean> {
  return must((await q.query<{ h: boolean }>(`SELECT inventory_business_has_stock_movements($1) AS h`, [businessId])).rows[0]).h;
}

async function digest(businessId: string, q: Pool | Client = ownerPool()): Promise<Readonly<Record<string, string>>> {
  return tableDigest(q, [...ACCOUNTING_TABLES, ...STOCK_TABLES], { businessId });
}

describe('T-19 (a) — a business with no stock movement keeps Phase 2 behaviour (Annex R §2.4)', () => {
  it('a manual adjustment and an opening balance with Inventory lines are both accepted and committed', async () => {
    const A = await fresh();
    expect(await hasMovements(ownerPool(), A.businessId)).toBe(false);
    const m = expectAccepted(await postManual(manual(A, 'inventory', 'opening_equity', 700n), A), 'manual Inventory line, no movement');
    expect(m.entryId).toMatch(/^[0-9a-f-]{36}$/);
    await committed((c) => postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 300n), position('cash', 'D', 100n)]));
    expect(await glInventory(ownerPool(), A.businessId)).toBe(1000n);
  });
});

describe('T-19 (b) — after the first movement, a manual Inventory line is refused at COMMIT (Annex R §2.1, §2.5)', () => {
  it('committed movement, then a manual Inventory line: the statement is accepted, COMMIT refuses, nothing is written', async () => {
    const A = await fresh();
    await firstMovement(A);
    expect(await hasMovements(ownerPool(), A.businessId)).toBe(true);
    const before = await digest(A.businessId);
    const cmd = manual(A, 'inventory', 'opening_equity');
    const c = await appClient();
    try {
      await c.query('BEGIN');
      // Deferred (R-93): the posting itself is accepted ...
      const posted = expectAccepted(await settle(() => postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c)), 'the statement');
      expect(posted.created).toBe(true);
      // ... and COMMIT is refused with the stable code.
      expectRefused(await settle(() => c.query('COMMIT')), 'P0001', CODE, 'COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(changedTables(before, await digest(A.businessId)), 'nothing survives the refused COMMIT').toEqual([]);
    // Both sides of the entry and the credit side alone: an Inventory CREDIT is refused the same way.
    expectRefused(await postManual(manual(A, 'opening_equity', 'inventory'), A), 'P0001', CODE, 'Inventory on the credit side');
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
  });

  it('a movement written earlier in the SAME transaction counts: the manual Inventory line is refused at COMMIT and neither survives', async () => {
    const A = await fresh();
    const before = await digest(A.businessId);
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '3' }]);
      const cmd = manual(A, 'inventory', 'opening_equity');
      await c.query('SET LOCAL ROLE daftar_app');
      expectAccepted(await settle(() => postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c)), 'the statement');
      await c.query('RESET ROLE');
      expectRefused(await settle(() => c.query('COMMIT')), 'P0001', CODE, 'COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
    expect(await hasMovements(ownerPool(), A.businessId)).toBe(false);
  });

  it('manual adjustments that do not touch Inventory are accepted after movements', async () => {
    const A = await fresh();
    await firstMovement(A);
    for (const [d, cr] of [
      ['cash', 'opening_equity'],
      ['opening_equity', 'cash'],
      ['cash', 'accounts_payable'],
    ] as const) {
      expectAccepted(await postManual(manual(A, d, cr, 250n), A), `${d} / ${cr}`);
    }
  });
});

describe('T-19 (c) — opening balances after the first movement (Annex R §2.7)', () => {
  it('with an Inventory position: refused at COMMIT; without one: posted', async () => {
    const A = await fresh();
    await firstMovement(A);
    const before = await digest(A.businessId);
    const refused = await settle(() => committed((c) => postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 500n), position('cash', 'D', 100n)])));
    expectRefused(refused, 'P0001', CODE, 'opening balance with Inventory after movements');
    expect(changedTables(before, await digest(A.businessId)), 'no opening balance, entry or line survives').toEqual([]);
    const ok = await committed((c) => postOpeningBalanceInTx(c, A, day, [position('cash', 'D', 100n)]));
    expect(ok.entryId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('T-19 (d) — reversals are the correction path and are never judged (Annex R §2.2)', () => {
  it('the reversal of a pre-foundation manual Inventory entry is accepted after movements, and removes exactly its contribution', async () => {
    const A = await fresh();
    const cmd = manual(A, 'inventory', 'opening_equity', 900n);
    const original = expectAccepted(await postManual(cmd, A), 'pre-foundation manual Inventory line');
    await firstMovement(A);
    const glBefore = await glInventory(ownerPool(), A.businessId);
    const assertion = sourceAssertion({
      actorUserId: A.userId,
      tenantId: A.tenantId,
      businessId: A.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: original.entryId,
      postingFingerprint: reversalFingerprintOf(cmd, original.entryId, day),
    });
    const rev = expectAccepted(await settle(() => postReversalAs(assertion, original.entryId, day, 'pre-foundation residue', randomUUID())), 'the reversal');
    expect(rev.created).toBe(true);
    expect(await glInventory(ownerPool(), A.businessId)).toBe(glBefore - 900n);
  });

  it('purchase.reverse (a reversal entry with Inventory lines) is accepted after movements', async () => {
    const A = await fresh();
    const p = await committed((c) => receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '3', unitPriceMinor: '40' }]));
    const run = await committed(async (c) => runReversal(c, A, await prepareReversal(c, A, p.purchaseId)));
    expect(must(run.entry, 'the Phase 2 reversal').created).toBe(true);
  });
});

describe('T-19 (e) — fail-closed: the session GUCs do not decide (0069 R-92)', () => {
  for (const [label, gucs] of [
    ['unset', { 'app.tenant_id': '', 'app.business_id': '' }],
    ['foreign', { 'app.tenant_id': 'FOREIGN_TENANT', 'app.business_id': 'FOREIGN_BUSINESS' }],
  ] as const) {
    it(`GUCs ${label} at COMMIT: the manual Inventory line is still refused`, async () => {
      const A = await fresh();
      const B = await fresh();
      await firstMovement(A);
      const resolved: Record<string, string> = {};
      for (const [k, v] of Object.entries(gucs)) resolved[k] = v === 'FOREIGN_TENANT' ? B.tenantId : v === 'FOREIGN_BUSINESS' ? B.businessId : v;
      const before = await digest(A.businessId);
      expectRefused(await postManual(manual(A, 'inventory', 'opening_equity'), A, resolved), 'P0001', CODE, `GUCs ${label}`);
      expect(changedTables(before, await digest(A.businessId))).toEqual([]);
    });
  }
});

describe('T-19 (f) — the HTTP surface: 409 ACCOUNTING_REFUSED with details.code (Annex R §2.9)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('POST /accounting/adjustments with an Inventory line after the first movement → 409; the same request without Inventory → 201', async () => {
    const owner = await registerActor(t, 'T-19 owner');
    const A = await onboardS3Business(t, owner, `t19-http-${randomUUID().slice(0, 6)}`);
    await firstMovement(A);
    const money = {
      baseAmountMinor: '500',
      baseCurrency: 'ILS',
      txnAmountMinor: '500',
      txnCurrency: 'ILS',
      fxRate: '1',
      fxRateSource: 'base',
      fxRateAt: '2026-03-14T09:15:00Z',
    } as const;
    const body = (debit: string): Record<string, unknown> => ({
      entryDate: day,
      description: 'T-19 over HTTP',
      reason: 'T-19 over HTTP',
      lines: [
        { account: { kind: 'system', systemKey: debit }, side: 'D', ...money },
        { account: { kind: 'system', systemKey: 'opening_equity' }, side: 'C', ...money },
      ],
    });
    const before = await digest(A.businessId);
    const refused = await t.request
      .post(`/v1/businesses/${A.businessId}/accounting/adjustments`)
      .set(asMember(owner, A.businessId))
      .set('Idempotency-Key', randomUUID())
      .send(body('inventory'));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'ACCOUNTING_REFUSED', details: { code: CODE } });
    // No amount in the refusal (§22 / §78): the body names the code, never the 500.
    expect(JSON.stringify(refused.body)).not.toMatch(/\b500\b/);
    expect(changedTables(before, await digest(A.businessId)), 'nothing written').toEqual([]);
    const ok = await t.request
      .post(`/v1/businesses/${A.businessId}/accounting/adjustments`)
      .set(asMember(owner, A.businessId))
      .set('Idempotency-Key', randomUUID())
      .send(body('cash'));
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
  });
});

describe('T-19 (g) — the catalogue shape of R-B1a (Annex R §2.4, §2.5; 0069 3a–3c)', () => {
  it('the helper: inventory-owned SQL STABLE DEFINER boolean, pinned path, EXECUTE exactly {daftar_accounting_internal}, body digest recorded', async () => {
    const r = must(
      (
        await ownerPool().query<{
          owner: string;
          lang: string;
          secdef: boolean;
          vol: string;
          ret: string;
          config: string[] | null;
          grantees: string[];
          pub: boolean;
          md5: string;
        }>(
          `SELECT pg_get_userbyid(p.proowner)::text AS owner, l.lanname::text AS lang, p.prosecdef AS secdef, p.provolatile::text AS vol,
                  p.prorettype::regtype::text AS ret, p.proconfig AS config,
                  coalesce((SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type ORDER BY 1) FROM aclexplode(p.proacl) x
                             WHERE x.grantee <> p.proowner), ARRAY[]::text[]) AS grantees,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS pub, md5(p.prosrc) AS md5
             FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = $1::regprocedure`,
          [HELPER],
        )
      ).rows[0],
    );
    expect({ ...r, md5: undefined }).toEqual({
      owner: 'daftar_inventory_internal',
      lang: 'sql',
      secdef: true,
      vol: 's',
      ret: 'boolean',
      config: PINNED,
      grantees: ['daftar_accounting_internal:EXECUTE'],
      pub: false,
      md5: undefined,
    });
    expect(r.md5, 'the helper body digest (a changed body is a changed rule)').toBe(HELPER_BODY_MD5);
    expect(HELPER_BODY_MD5, 'the S8 gate pins the same helper body (review L-2)').toBe(R_B1A_HELPER_BODY_MD5);
  });

  it('the guard: accounting-owned plpgsql DEFINER trigger function, pinned path, no EXECUTE grantee at all, body digest recorded', async () => {
    const r = must(
      (
        await ownerPool().query<{ owner: string; lang: string; secdef: boolean; ret: string; config: string[] | null; grantees: number; md5: string }>(
          `SELECT pg_get_userbyid(p.proowner)::text AS owner, l.lanname::text AS lang, p.prosecdef AS secdef,
                  p.prorettype::regtype::text AS ret, p.proconfig AS config,
                  (SELECT count(*)::int FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees, md5(p.prosrc) AS md5
             FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = $1::regprocedure`,
          [GUARD],
        )
      ).rows[0],
    );
    expect({ ...r, md5: undefined }).toEqual({
      owner: 'daftar_accounting_internal',
      lang: 'plpgsql',
      secdef: true,
      ret: 'trigger',
      config: PINNED,
      grantees: 0,
      md5: undefined,
    });
    expect(r.md5, 'the guard body digest (a changed body is a changed rule)').toBe(GUARD_BODY_MD5);
    expect(GUARD_BODY_MD5, 'the S8 gate pins the same guard body (review L-2)').toBe(R_B1A_GUARD_BODY_MD5);
    const exec = await ownerPool().query<{ r: string }>(
      `SELECT r.rolname::text AS r FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE')`,
      [GUARD],
    );
    expect(exec.rows, 'no login role may execute the guard').toEqual([]);
  });

  it('the trigger: exactly one, on journal_entries, a deferred constraint trigger AFTER INSERT FOR EACH ROW, filtered on the two merchant-stated types', async () => {
    const r = await ownerPool().query<{
      rel: string;
      name: string;
      tgtype: number;
      enabled: string;
      deferrable: boolean;
      deferred: boolean;
      constraint: boolean;
      def: string;
    }>(
      `SELECT g.tgrelid::regclass::text AS rel, g.tgname::text AS name, g.tgtype::int AS tgtype, g.tgenabled::text AS enabled,
              g.tgdeferrable AS deferrable, g.tginitdeferred AS deferred, g.tgconstraint <> 0 AS constraint, pg_get_triggerdef(g.oid) AS def
         FROM pg_trigger g WHERE g.tgfoid = $1::regprocedure AND NOT g.tgisinternal`,
      [GUARD],
    );
    expect(r.rows.map((x) => ({ ...x, def: undefined }))).toEqual([
      { rel: 'journal_entries', name: TRIGGER, tgtype: 5, enabled: 'O', deferrable: true, deferred: true, constraint: true, def: undefined },
    ]);
    expect(must(r.rows[0]).def).toContain(`WHEN ((new.source_type = ANY (ARRAY['manual_adjustment'::text, 'opening_balance'::text])))`);
  });

  it('the accounting principal holds no read of stock_movements: the helper is its only way to the ledger (Annex R §1 #17)', async () => {
    const r = must(
      (
        await ownerPool().query<{ t: boolean; c: boolean; h: boolean }>(
          `SELECT has_table_privilege('daftar_accounting_internal', 'stock_movements', 'SELECT') AS t,
                  has_any_column_privilege('daftar_accounting_internal', 'stock_movements', 'SELECT') AS c,
                  has_function_privilege('daftar_accounting_internal', $1::regprocedure, 'EXECUTE') AS h`,
          [HELPER],
        )
      ).rows[0],
    );
    expect(r).toEqual({ t: false, c: false, h: true });
  });

  it('the helper answers from the inventory principal whatever the session scope (fail-closed): true for a business with movements under a foreign scope, false for an unknown id', async () => {
    const A = await fresh();
    const B = await fresh();
    await firstMovement(A);
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [B.tenantId, B.businessId]);
      await c.query('SET LOCAL ROLE daftar_accounting_internal');
      expect(await hasMovements(c, A.businessId), 'foreign scope').toBe(true);
      expect(await hasMovements(c, randomUUID()), 'unknown business').toBe(false);
      await c.query(`SELECT set_config('app.tenant_id', '', true), set_config('app.business_id', '', true)`);
      expect(await hasMovements(c, A.businessId), 'no scope').toBe(true);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
});

describe('T-19 (h) — the race "manual Inventory line ∥ first receipt" ends in one of the two serial outcomes (Annex R §2.6)', () => {
  /**
   * X posts the manual Inventory line, Y writes the business's first
   * movement (a real inventory.adjust with its entry). The guard is judged at
   * X's COMMIT, reading what is committed then; it takes no lock of its own
   * (R-93). The two postings may still serialize on the accounting side's
   * existing locks, so each side's work runs as a promise that is allowed to
   * wait, and the COMMIT order is what the case fixes:
   *   - X commits first: the serial order is "manual entry first" — both
   *     commit (pre-foundation residue, which R-INV-01 reports);
   *   - Y commits first: X's COMMIT sees the movement and is refused.
   * No other outcome (both refused, an unclassified error, a deadlock) is
   * admitted.
   */
  async function race(order: 'manual-first' | 'receipt-first' | 'together'): Promise<{ manual: Outcome<unknown>; receipt: Outcome<unknown> }> {
    const A = await fresh();
    const x = await appClient();
    const y = await ownerClient();
    const cmd = manual(A, 'inventory', 'opening_equity');
    const xWork = async (): Promise<unknown> => postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, x);
    const yWork = async (): Promise<unknown> => stockUp(y, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '4' }]);
    const flow = async (c: Client, work: () => Promise<unknown>): Promise<Outcome<unknown>> =>
      settle(async () => {
        await work();
        return c.query('COMMIT');
      });
    try {
      await x.query('BEGIN');
      await y.query('BEGIN');
      if (order === 'manual-first') {
        expectAccepted(await settle(xWork), 'X prepares');
        const yPrepared = settle(yWork);
        const manualOutcome = await settle(() => x.query('COMMIT'));
        expectAccepted(await yPrepared, 'Y prepares');
        return { manual: manualOutcome, receipt: await settle(() => y.query('COMMIT')) };
      }
      if (order === 'receipt-first') {
        expectAccepted(await settle(yWork), 'Y prepares');
        const xPrepared = settle(xWork);
        const receiptOutcome = await settle(() => y.query('COMMIT'));
        const prepared = await xPrepared;
        if (!prepared.ok) return { manual: prepared, receipt: receiptOutcome };
        return { manual: await settle(() => x.query('COMMIT')), receipt: receiptOutcome };
      }
      const [manualOutcome, receiptOutcome] = await Promise.all([flow(x, xWork), flow(y, yWork)]);
      return { manual: manualOutcome, receipt: receiptOutcome };
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await y.query('ROLLBACK').catch(() => undefined);
      await x.end();
      await y.end();
    }
  }

  it('manual COMMIT first: both commit (the manual entry is pre-foundation)', async () => {
    const o = await race('manual-first');
    expectAccepted(o.manual, 'manual');
    expectAccepted(o.receipt, 'receipt');
  });

  it('receipt COMMIT first: the receipt commits, the manual line is refused', async () => {
    const o = await race('receipt-first');
    expectAccepted(o.receipt, 'receipt');
    expectRefused(o.manual, 'P0001', CODE, 'manual after the first movement');
  });

  it('COMMITs issued together: the receipt always commits, and the manual line either commits (ordered first) or is refused with the code', async () => {
    for (let i = 0; i < 5; i += 1) {
      const o = await race('together');
      expectAccepted(o.receipt, `receipt, round ${i}`);
      if (!o.manual.ok) expectRefused(o.manual, 'P0001', CODE, `manual, round ${i}`);
    }
  });
});

describe('T-19 (i) — SET CONSTRAINTS … IMMEDIATE cannot switch the guard off (0069 R-94, review H-1)', () => {
  /**
   * `SET CONSTRAINTS` needs no privilege. Forced IMMEDIATE, the header
   * trigger fires at the end of the header INSERT inside
   * accounting_post_entry, BEFORE the one set-wise lines INSERT (0045:776-793),
   * so the guard sees no line at all. It must refuse then (fail closed), not
   * pass: a committed entry always has lines, so "no line visible" can only
   * mean the trigger was fired early.
   */
  const MODES = [
    ['named', `SET CONSTRAINTS ${TRIGGER} IMMEDIATE`],
    ['ALL', 'SET CONSTRAINTS ALL IMMEDIATE'],
  ] as const;

  for (const [mode, stmt] of MODES) {
    it(`${mode}: a manual Inventory line after the first movement is refused, nothing written`, async () => {
      const A = await fresh();
      await firstMovement(A);
      const glBefore = await glInventory(ownerPool(), A.businessId);
      const before = await digest(A.businessId);
      const cmd = manual(A, 'inventory', 'opening_equity', 777n);
      const c = await appClient();
      let outcome: Outcome<unknown>;
      try {
        outcome = await settle(async () => {
          await c.query('BEGIN');
          await c.query(stmt);
          await postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c);
          return c.query('COMMIT');
        });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      if (mode === 'named') expectRefused(outcome, 'P0001', CODE, stmt);
      else expect(outcome.ok, `${stmt} must not commit`).toBe(false);
      expect(changedTables(before, await digest(A.businessId)), 'nothing survives').toEqual([]);
      expect(await glInventory(ownerPool(), A.businessId)).toBe(glBefore);
    });

    it(`${mode}: an opening balance with an Inventory position after the first movement is refused, nothing written`, async () => {
      const A = await fresh();
      await firstMovement(A);
      const glBefore = await glInventory(ownerPool(), A.businessId);
      const before = await digest(A.businessId);
      const outcome = await settle(() =>
        committed(async (c) => {
          await c.query(stmt);
          return postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 4321n), position('cash', 'D', 100n)]);
        }),
      );
      if (mode === 'named') expectRefused(outcome, 'P0001', CODE, stmt);
      else expect(outcome.ok, `${stmt} must not commit`).toBe(false);
      expect(changedTables(before, await digest(A.businessId)), 'nothing survives').toEqual([]);
      expect(await glInventory(ownerPool(), A.businessId)).toBe(glBefore);
    });
  }

  it('named, a business with no movement: Phase 2 behaviour is unchanged (the Inventory line is accepted)', async () => {
    const A = await fresh();
    const cmd = manual(A, 'inventory', 'opening_equity', 600n);
    const c = await appClient();
    try {
      await c.query('BEGIN');
      await c.query(`SET CONSTRAINTS ${TRIGGER} IMMEDIATE`);
      expectAccepted(await settle(() => postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c)), 'the statement');
      expectAccepted(await settle(() => c.query('COMMIT')), 'COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await glInventory(ownerPool(), A.businessId)).toBe(600n);
  });

  it('named, after movements, a manual line that does not touch Inventory: refused too (fail closed: the lines are not visible yet)', async () => {
    const A = await fresh();
    await firstMovement(A);
    const before = await digest(A.businessId);
    const cmd = manual(A, 'cash', 'opening_equity', 250n);
    const c = await appClient();
    let outcome: Outcome<unknown>;
    try {
      outcome = await settle(async () => {
        await c.query('BEGIN');
        await c.query(`SET CONSTRAINTS ${TRIGGER} IMMEDIATE`);
        await postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c);
        return c.query('COMMIT');
      });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expectRefused(outcome, 'P0001', CODE, 'early firing');
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
    // The same line on the default (deferred) path is accepted.
    expectAccepted(await postManual(cmd, A), 'deferred path');
  });

  it('SET CONSTRAINTS … IMMEDIATE issued AFTER the posting fires the guard with every line visible: refused', async () => {
    const A = await fresh();
    await firstMovement(A);
    const before = await digest(A.businessId);
    const cmd = manual(A, 'inventory', 'opening_equity');
    const c = await appClient();
    let outcome: Outcome<unknown>;
    try {
      outcome = await settle(async () => {
        await c.query('BEGIN');
        await postAs(accountingAssertionFor(cmd, A.userId), cmd, {}, c);
        await c.query(`SET CONSTRAINTS ${TRIGGER} IMMEDIATE`);
        return c.query('COMMIT');
      });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expectRefused(outcome, 'P0001', CODE, 'late SET CONSTRAINTS');
    expect(changedTables(before, await digest(A.businessId))).toEqual([]);
  });
});

describe('T-19 NEGATIVE CONTROL — with the trigger dropped, the manual Inventory line commits and R-INV-01 reports the business (Annex R §2.10)', () => {
  let scratch: ScratchDb;
  let A: S3Business;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t19_nc');
    A = (await seedS3World(scratch.pool, 't19-nc')).A;
    await firstMovement(A, scratch.url());
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  const target = (): { tenantId: string; businessId: string } => ({ tenantId: A.tenantId, businessId: A.businessId });

  it('as shipped: the line is refused at COMMIT and R-INV-01 … R-INV-05 are ok', async () => {
    expectRefused(await postManual(manual(A, 'inventory', 'opening_equity'), A, {}, scratch.url('daftar_app')), 'P0001', CODE, 'scratch, as shipped');
    const run = await runChecks(scratch.poolAs('daftar_reconciler'), target());
    expect(statuses(run)).toEqual({ 'R-INV-01': 'ok', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' });
  });

  it('trigger dropped: the same line commits, and R-INV-01 — and only R-INV-01 — reports exactly the business, with no amount', async () => {
    await scratch.pool.query(`DROP TRIGGER ${TRIGGER} ON journal_entries`);
    expectAccepted(await postManual(manual(A, 'inventory', 'opening_equity'), A, {}, scratch.url('daftar_app')), 'scratch, trigger dropped');
    const run = await runChecks(scratch.poolAs('daftar_reconciler'), target());
    expect(statuses(run)).toEqual({ 'R-INV-01': 'discrepancy', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' });
    const r = resultOf(run, 'R-INV-01');
    expect({ count: r.offendingCount, ids: r.offendingIds }).toEqual({ count: 1, ids: [A.businessId] });
    expect(JSON.stringify(r)).not.toMatch(/\b500\b/);
  });
});
