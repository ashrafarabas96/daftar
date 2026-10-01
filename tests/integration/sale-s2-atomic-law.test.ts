/**
 * P4-S2 — THE ATOMIC SALE LAW BY FAILURE INJECTION AT EVERY SEAM.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md §15, P4-AL-16 ("one transaction, or no
 *  sale"), §17 G-06; docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §4.)
 *
 * P4-AL-16 lists what a confirmed sale performs in ONE transaction: the `sales`
 * row and its items; the stock movements through
 * `inventory_apply_stock_movements`; the `stock_levels` update that routine
 * performs; the COGS journal entry; the `invoices` row and its items; the
 * invoice number allocation; the revenue/AR/tax entry; and, for a cash sale,
 * the payment, its allocation and the settlement entry. "There is no
 * intermediate state in which stock left the shelf and no invoice exists, or
 * an invoice exists and no movement was written."
 *
 * This suite is the only thing that can make that sentence a fact rather than
 * an intention: it extends the `expectNothingSurvives` idiom of
 * `tests/integration/inventory-s3-atomicity.test.ts:93-103` to a failure at
 * EVERY seam of the commit path, and requires that nothing at all survives
 * each one.
 *
 * ── HOW A SEAM IS INJECTED, AND WHY THE SEAM SET IS DISCOVERED ────────────
 *
 * Two injectors, because the commit path has two kinds of seam:
 *
 *   (a) INSIDE the transaction, at each RELATION the path writes. A `BEFORE
 *       INSERT OR UPDATE` trigger that raises is installed on one relation,
 *       the sale is confirmed, and the census must show that NOTHING survived
 *       — not the `sales` row, not the movements, not the bridge, not the
 *       entries, not the bindings, not the invoice, not the audit row. The
 *       trigger is dropped in a `finally`. This injector needs no cooperation
 *       from the service: it reaches seams no spy outside the transaction can
 *       reach, including the ones inside the SQL routine, and it is exactly as
 *       surgical as "the write at this point failed".
 *
 *   (b) AT THE POSTING PORT, which is where `inventory-s3-atomicity` injects.
 *       The sale posts TWICE (the COGS entry, then the revenue entry), so the
 *       port is failed on the FIRST call and, separately, on the SECOND — two
 *       distinct seams that bracket the invoice.
 *
 * The seam SET for (a) is DISCOVERED: an uninjected sale is run first, and
 * every relation whose row count moved is a seam. A relation the commit path
 * writes that nobody listed is therefore injected the day it is written, which
 * is the opposite of the hand-maintained-list failure mode
 * (`[[daftar-a-closure-rule-is-not-an-invariant]]`). The relations P4-AL-16
 * names by hand are asserted as a FLOOR of that discovered set, never as an
 * equality — a later slice adding a relation to the sale path must not turn
 * this red for being a later slice.
 *
 * ── RED UNTIL THE P4-S2 PRIMITIVE LANDS ───────────────────────────────────
 *
 * By the canary, with the missing names in the message. Not skipped and not
 * conditional. The seam loop is generated from the discovered set, so while
 * the subject is absent there is one canary test and no silent zero-case loop:
 * a `for` over an empty discovered set would be the vacuity defect wearing the
 * costume of a passing suite.
 *
 * Not named `phase4-*` or `p4-*`: the SEALED `scripts/phase4-s1-gate.ts`
 * (`suiteProblems`, :750-753) fails any such suite in `tests/integration`,
 * `tests/security` or `tests/performance` that no `S1_SUITES` entry lists.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  census,
  censusDelta,
  existingRelations,
  must,
  requireSubject,
  saleSubject,
  type Census,
  type SaleSubject,
} from '../golden-regression/phase4-s2/harness';
import { confirmSale, seedSaleFixtures } from '../golden-regression/phase4-s2/sale-path';

/** The relations P4-AL-16 names by hand. A FLOOR of the discovered seam set, never an equality. */
const P4_AL_16_FLOOR: readonly string[] = [
  'sales',
  'sale_items',
  'stock_movements',
  'stock_source_bridge_sale',
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'invoices',
  'invoice_items',
];

/** Relations the path UPDATES rather than inserts into, so a count delta cannot discover them. */
const UPDATE_SEAMS: readonly string[] = ['stock_levels', 'invoice_sequences'];

const CLAIM = 'a failure at any seam of the sale commit path leaves nothing behind';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let subject: SaleSubject;
let customerId: string;
let posting: DatabaseAccountingPostingAdapter | null = null;
/** The seams discovered from an uninjected sale, plus the update seams that exist. */
let seams: readonly string[] = [];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'atomic law owner');
  A = await onboardS3Business(t, owner, 's2atom');
  ({ customerId } = await seedSaleFixtures(ownerPool(), A, day));
  subject = await saleSubject(ownerPool());
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
  await stockUp('200');

  if (subject.missing.length === 0) {
    const before = await census(ownerPool(), A.businessId);
    const res = await sale();
    expect(res.status, 'the uninjected sale the seam set is discovered from is accepted').toBeLessThan(300);
    const moved = Object.entries(censusDelta(before, await census(ownerPool(), A.businessId)))
      .filter(([, n]) => n > 0)
      .map(([table]) => table);
    seams = [...new Set([...moved, ...(await existingRelations(ownerPool(), UPDATE_SEAMS))])].sort();
  }
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await t?.close();
  await resetData();
});

async function stockUp(quantity: string): Promise<void> {
  const res = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(owner, A.businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'atomicity fixture',
      lines: [{ productId: A.piece.productId, quantity, unitCost: '5' }],
    });
  expect(res.status, 'the fixture inbound adjustment is accepted').toBe(201);
}

/** A fresh credit sale of one unit. A fresh document id every time: a replay would be answered, not re-attempted. */
const sale = (): Promise<Response> =>
  confirmSale(t, asMember(owner, A.businessId), {
    saleId: randomUUID(),
    customerId,
    warehouseId: A.w1,
    branchId: A.branchX,
    occurredOn: day,
    lines: [{ productId: A.piece.productId, quantity: '1' }],
  });

/** (a) Raise inside the transaction at the first write to `relation`; drop the injector whatever happens. */
async function withRaisingTrigger<T>(relation: string, fn: () => Promise<T>): Promise<T> {
  const fname = `p4s2_inject_${relation}`;
  // `zz_` so it is the LAST BEFORE trigger alphabetically: the row's own
  // constraints and triggers have already run, so the failure lands as late in
  // the write as a trigger can.
  await ownerPool().query(
    `CREATE OR REPLACE FUNCTION ${fname}() RETURNS trigger LANGUAGE plpgsql AS
     $fx$ BEGIN RAISE EXCEPTION 'p4s2.injected_failure: a failure at the % seam of the sale commit path', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $fx$`,
  );
  await ownerPool().query(`CREATE TRIGGER zz_p4s2_inject BEFORE INSERT OR UPDATE ON ${relation} FOR EACH ROW EXECUTE FUNCTION ${fname}()`);
  try {
    return await fn();
  } finally {
    await ownerPool().query(`DROP TRIGGER IF EXISTS zz_p4s2_inject ON ${relation}`);
    await ownerPool().query(`DROP FUNCTION IF EXISTS ${fname}()`);
  }
}

/** Inject, confirm a sale, and prove the WHOLE business unchanged. */
async function expectNothingSurvives(inject: <T>(fn: () => Promise<T>) => Promise<T>, what: string): Promise<void> {
  const before: Census = await census(ownerPool(), A.businessId);
  const res = await inject(() => sale());
  expect(res.status >= 400, `${what}: the injected failure surfaces as a refusal rather than a success`).toBe(true);
  expect(censusDelta(before, await census(ownerPool(), A.businessId)), `${what}: NOTHING survives — not a row of any business-scoped relation`).toEqual({});
}

describe('P4-AL-16 one transaction, or no sale: a failure at every seam leaves nothing', () => {
  it('the subject exists: the sale commit primitive and its registrations are in the tree', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('the seam set was discovered, is non-empty, and covers every relation P4-AL-16 names', () => {
    requireSubject(subject.missing, CLAIM);
    expect(seams.length, 'NO SUBJECT — no seam was discovered, so the loop below would assert nothing').toBeGreaterThan(0);
    const missing = P4_AL_16_FLOOR.filter((r) => !seams.includes(r));
    expect(
      missing,
      `the sale wrote none of ${missing.join(', ')}, which P4-AL-16 says one transaction performs. A seam that is not written is not a seam ` +
        `this suite can inject at, and the law about it would be vacuous.`,
    ).toEqual([]);
  });

  // One `it` per seam, generated from the DISCOVERED set. A single `it` over
  // all of them would stop at the first surviving row and hide every seam
  // after it — the measurement defect that made P4-S1's breakage count grow
  // round after round instead of being known once.
  for (const relation of [...P4_AL_16_FLOOR, ...UPDATE_SEAMS]) {
    it(`a failure at the ${relation} seam leaves nothing`, async () => {
      requireSubject(subject.missing, CLAIM);
      expect(seams, `${relation} is not among the discovered seams, so this case has no subject`).toContain(relation);
      await expectNothingSurvives((fn) => withRaisingTrigger(relation, fn), `the ${relation} seam`);
    });
  }

  it('every discovered seam was covered by a case above, or is named here', () => {
    requireSubject(subject.missing, CLAIM);
    // The FLOOR is hand-written; the SET is discovered. This is the assertion
    // that stops the two from drifting apart silently: a relation the sale
    // writes that no case injects at is reported, rather than being quietly
    // outside the proof.
    const covered = new Set([...P4_AL_16_FLOOR, ...UPDATE_SEAMS, 'audit_events', 'outbox_events', 'inventory_assertion_uses', 'accounting_assertion_uses']);
    const uncovered = seams.filter((r) => !covered.has(r));
    expect(
      uncovered,
      `the sale writes ${uncovered.join(', ')}, and no case above injects a failure there. Add a case — a seam outside the injection set is a seam ` +
        `at which a partial sale could survive unobserved.`,
    ).toEqual([]);
  });

  it('a failure at the FIRST posting — after the stock movements, before the invoice — leaves nothing', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectNothingSurvives(async (fn) => {
      vi.spyOn(must(posting), 'postEntryInTransaction').mockRejectedValueOnce(new Error('injected: after the routine, before the first posting'));
      try {
        return await fn();
      } finally {
        vi.restoreAllMocks();
      }
    }, 'the first posting seam');
  });

  it('a failure at the SECOND posting — after the invoice, before the revenue entry commits — leaves nothing', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectNothingSurvives(async (fn) => {
      const port = must(posting);
      const original = port.postEntryInTransaction.bind(port);
      let calls = 0;
      vi.spyOn(port, 'postEntryInTransaction').mockImplementation(async (...args: Parameters<typeof original>) => {
        calls += 1;
        if (calls >= 2) throw new Error('injected: after the invoice, before the second posting');
        return original(...args);
      });
      try {
        const res = await fn();
        expect(calls, 'the sale posts twice (the COGS entry and the revenue entry), so there IS a second seam to inject at').toBeGreaterThanOrEqual(2);
        return res;
      } finally {
        vi.restoreAllMocks();
      }
    }, 'the second posting seam');
  });
});
