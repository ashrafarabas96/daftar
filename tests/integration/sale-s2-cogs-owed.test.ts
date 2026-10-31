/**
 * P4-S2 — `sales_cogs_owed`, THE LAW THAT MAKES THE CONDITIONAL ACCOUNTING ARM
 * SAFE RATHER THAN A HOLE (contract C-07; `0077`'s deferred constraint
 * trigger).
 *
 * The law has two arms and they are a MATCHED PAIR:
 *
 *   NON-ZERO — a committed sale whose bridged stock movements carry a non-zero
 *              total value and NO `sale` accounting binding must fail at
 *              COMMIT. Without this, "the sale posted no COGS entry" and "the
 *              sale's goods were free" are the same committed state, and the
 *              inventory decrement sits in the ledger with no cost against it
 *              (§15: no inventory decrement without COGS).
 *   ZERO     — a committed sale whose bridged movements carry a total value of
 *              ZERO must commit, with ONE entry and no `sale` binding.
 *              `journal_lines_money_cap_ck` (`0042:225`) refuses a zero-amount
 *              line, so a sale of stock whose stored valuation is 0 can only
 *              post its revenue entry, and `GL Inventory (1200) =
 *              Σ value_delta_base_minor` still holds — at 0.
 *
 * The pair is the proof. The NON-ZERO arm alone would be satisfied by a
 * trigger that refused every sale; the ZERO arm alone by one that refused
 * nothing. And the ZERO arm is not decoration: THREE deliberate weakenings in
 * this slice exist for it and are justified by nothing else —
 *
 *   1. `sales_binding_owed_ck` (`0077`) is deliberately WEAKER than C-01's
 *      strict `(status <> 'draft') = (binding_source_id IS NOT NULL)`, on the
 *      stated reasoning that a zero-cost sale legitimately owes no binding;
 *   2. the seam's `conditional` authority arm
 *      (`tests/integration/sale-s2-seam-authority.test.ts`) exists so a
 *      transaction may declare an assertion whose entry legitimately does not
 *      exist;
 *   3. `sales_cogs_owed()` itself carries a `v_cost = 0` branch.
 *
 * ── WHY THIS SUITE IS NOT A FIXTURE, AND WHAT IT CAN PROVE TODAY ──────────
 *
 * The only sanctioned producer of a COMMITTED sale is the commit routine
 * (`sale_commit`, `0078`). `stock_movements` is append-only and reachable only
 * through `inventory_apply_stock_movements`, itself reachable only from a
 * registered entry routine, and a confirmed sale additionally owes
 * `stock_source_complete_sale`, `stock_source_complete_sale_header`,
 * `sales_binding_fk`, `sales_walkin_no_ar` and `stock_binding_requires_sale`.
 * Hand-building the state would mean reimplementing `sale_commit` in a test —
 * and a law proved against a reimplementation is a law about the
 * reimplementation. So the BEHAVIOURAL pair below is canary-gated on
 * `sale_commit` and goes green the day `0078` lands.
 *
 * What does NOT need the routine is whether the ZERO arm has a REACHABLE
 * SUBJECT at all, and that is the first half of this suite. It is a law over
 * the LIVE CATALOGUE (`[[daftar-the-live-catalogue-is-the-policy]]`), stated as
 * a pure function of the three function bodies so it can be planted against
 * without a database, and it is RED on this head. See `zeroCostArmProblems`.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  expectInventoryReconciled,
  must,
  requireSubject,
  routineExists,
  saleSubject,
  type Queryable,
  type SaleSubject,
} from '../golden-regression/phase4-s2/harness';
import { confirmSale, seedSaleFixtures } from '../golden-regression/phase4-s2/sale-path';

const CLAIM = 'a committed sale owes a COGS entry exactly when its goods carry value';

/**
 * The three routines the matched pair is spread across. Read from the
 * catalogue by name, never from a migration file: a function REPLACED by a
 * later migration is the one that runs, and the file that first created it is
 * not the policy.
 */
const COST_ARM_ROUTINES = ['sales_cogs_owed', 'stock_source_complete_sale', 'stock_source_complete_sale_header'] as const;

export interface CostArmBodies {
  /** `sales_cogs_owed()` — the accounting-side obligation. */
  readonly salesCogsOwed: string;
  /** `stock_source_complete_sale()` — the per-line stock-side completeness guard. */
  readonly stockLineGuard: string;
  /** `stock_source_complete_sale_header()` — the same guard at the header grain. */
  readonly stockHeaderGuard: string;
}

/** Every comparison a body makes between `value_delta_base_minor` and zero, as its operator. */
export function valueDeltaComparisons(body: string): readonly string[] {
  return [...body.matchAll(/value_delta_base_minor\s*(<=|>=|<>|!=|<|>|=)\s*0\b/g)].map((m) => m[1] ?? '');
}

/**
 * THE TWO ARMS MUST AGREE ABOUT ZERO.
 *
 * `sales_cogs_owed()` branches on a cost of exactly zero, so the slice CLAIMS
 * a zero-valued committed sale is a legitimate state. The stock-side
 * completeness guards decide whether one can exist: each requires every line
 * of a non-draft sale to carry exactly one bridged `sale` movement matching a
 * predicate on `value_delta_base_minor`. If that predicate is STRICTLY
 * negative, a zero-valued movement does not match, the guard's `v_ok` count
 * falls short, and the sale is refused `inventory.
 * source_movement_set_incomplete` — so the zero-cost sale is UNSELLABLE and
 * `sales_cogs_owed()`'s zero branch, the seam's `conditional` arm and the
 * weakening of `sales_binding_owed_ck` are all justified by a state nothing
 * can reach.
 *
 * `<= 0` admits it; `< 0` does not. The two readings cannot both be right, and
 * which one is wrong is the migration owner's call:
 *
 *   (a) the zero-cost sale is real — then the stock-side predicates are
 *       `<= 0` and this function goes quiet; or
 *   (b) the zero-cost sale is refused on purpose — then `sales_cogs_owed()`'s
 *       zero branch is dead, the seam's `conditional` arm has no case, and
 *       `sales_binding_owed_ck` should go back to C-01's STRICT iff, which is
 *       a stronger law than the one in the tree.
 *
 * Pure, so every verdict below is planted against without a database.
 */
export function zeroCostArmProblems(b: CostArmBodies): string[] {
  const problems: string[] = [];
  const claimsZeroIsLegitimate = /v_cost\s*=\s*0/.test(b.salesCogsOwed);
  if (!claimsZeroIsLegitimate) return problems;
  for (const [name, body] of [
    ['stock_source_complete_sale', b.stockLineGuard],
    ['stock_source_complete_sale_header', b.stockHeaderGuard],
  ] as const) {
    const ops = valueDeltaComparisons(body);
    if (ops.length === 0) {
      problems.push(
        `${name} makes no comparison between value_delta_base_minor and zero, so it cannot be read either way — ` +
          `the agreement between the two arms is unprovable rather than true`,
      );
      continue;
    }
    for (const op of ops.filter((o) => o === '<')) {
      problems.push(
        `${name} requires value_delta_base_minor ${op} 0 for every line of a non-draft sale, while sales_cogs_owed() carries a ` +
          `v_cost = 0 branch: a zero-valued sale movement fails that guard, so the zero-cost sale sales_cogs_owed() admits is ` +
          `unreachable and the three weakenings that rest on it (sales_binding_owed_ck, the seam's conditional arm, the zero ` +
          `branch itself) are justified by a state nothing can produce. Either the predicate is <= 0, or the zero branch and ` +
          `the weakened CHECK should go and C-07 should return to C-01's strict iff.`,
      );
    }
  }
  return problems.sort();
}

/** `pg_get_functiondef` for each named routine, by name, from the live catalogue. */
async function bodiesOf(q: Queryable, names: readonly string[]): Promise<Readonly<Record<string, string>>> {
  const r = await q.query<{ name: string; def: string }>(
    `SELECT p.proname::text AS name, pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [[...names]],
  );
  return Object.fromEntries(r.rows.map((row) => [row.name, row.def]));
}

// ── THE LIVE-CATALOGUE HALF: provable today, no fixture, no commit routine ──

describe('C-07 the two arms of sales_cogs_owed agree about a cost of zero', () => {
  let bodies: Readonly<Record<string, string>> = {};
  let missing: readonly string[] = [];

  beforeAll(async () => {
    await ensurePostgres();
    bodies = await bodiesOf(ownerPool(), COST_ARM_ROUTINES);
    missing = COST_ARM_ROUTINES.filter((name) => (bodies[name] ?? '') === '').map((name) => `the routine ${name}`);
  }, 120_000);

  it('the subject exists: all three routines of the matched pair are in the catalogue', () => {
    requireSubject(missing, CLAIM);
  });

  it('each body was really read, and each makes a claim the law below can be wrong about', () => {
    requireSubject(missing, CLAIM);
    for (const name of COST_ARM_ROUTINES) {
      expect((bodies[name] ?? '').length, `NO SUBJECT — ${name}'s definition came back empty, so every reading of it below is vacuous`).toBeGreaterThan(0);
    }
    // The law only fires when the slice CLAIMS a zero cost is legitimate. That
    // claim must actually be in the tree, or the law has no premise and its
    // silence would mean nothing.
    expect(
      /v_cost\s*=\s*0/.test(must(bodies['sales_cogs_owed'], 'sales_cogs_owed')),
      'NO SUBJECT — sales_cogs_owed() carries no zero-cost branch, so the agreement below has no premise and could not be violated',
    ).toBe(true);
    // And the stock-side guards must really police the movement's value, or
    // there is nothing for the accounting arm to disagree with.
    for (const name of ['stock_source_complete_sale', 'stock_source_complete_sale_header'] as const) {
      expect(
        valueDeltaComparisons(must(bodies[name], name)).length,
        `NO SUBJECT — ${name} compares value_delta_base_minor with nothing, so it constrains no value and the law has no subject`,
      ).toBeGreaterThan(0);
    }
  });

  it('a zero-valued sale movement is admitted by the stock-side guards, so the zero-cost arm has a reachable subject', () => {
    requireSubject(missing, CLAIM);
    expect(
      zeroCostArmProblems({
        salesCogsOwed: must(bodies['sales_cogs_owed'], 'sales_cogs_owed'),
        stockLineGuard: must(bodies['stock_source_complete_sale'], 'stock_source_complete_sale'),
        stockHeaderGuard: must(bodies['stock_source_complete_sale_header'], 'stock_source_complete_sale_header'),
      }),
    ).toEqual([]);
  });

  // ── the red proofs of the law itself, planted, no database ──

  const LAWFUL: CostArmBodies = {
    salesCogsOwed:
      'IF (v_cost <> 0) AND NEW.binding_source_id IS NULL THEN RAISE; END IF; IF (v_cost = 0) AND NEW.binding_source_id IS NOT NULL THEN RAISE; END IF;',
    stockLineGuard: "count(*) FILTER (WHERE m.movement_kind = 'sale' AND m.value_delta_base_minor <= 0)",
    stockHeaderGuard: 'AND m.qty_delta = -l.quantity AND m.value_delta_base_minor <= 0',
  };

  it('the law is quiet when the two arms agree: `<= 0` on both stock-side guards', () => {
    expect(zeroCostArmProblems(LAWFUL)).toEqual([]);
  });

  it('PLANTED: a strictly-negative predicate on the LINE guard is reported, and names the guard', () => {
    const problems = zeroCostArmProblems({ ...LAWFUL, stockLineGuard: LAWFUL.stockLineGuard.replace('<= 0', '< 0') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^stock_source_complete_sale requires value_delta_base_minor < 0/);
  });

  it('PLANTED: a strictly-negative predicate on the HEADER guard is reported too — one arm is not enough', () => {
    const problems = zeroCostArmProblems({ ...LAWFUL, stockHeaderGuard: LAWFUL.stockHeaderGuard.replace('<= 0', '< 0') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^stock_source_complete_sale_header requires/);
  });

  it('PLANTED: a stock-side guard that constrains the value with nothing is reported, not passed', () => {
    const problems = zeroCostArmProblems({ ...LAWFUL, stockLineGuard: "count(*) FILTER (WHERE m.movement_kind = 'sale')" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/makes no comparison between value_delta_base_minor and zero/);
  });

  it('PLANTED: with NO zero-cost branch the law has no premise and stays quiet, whatever the predicates are', () => {
    // Resolution (b). The law is about an AGREEMENT, so it must not fire
    // against a slice that never claimed a zero cost was legitimate —
    // otherwise it would force resolution (a) by construction.
    expect(
      zeroCostArmProblems({
        salesCogsOwed: 'IF NEW.binding_source_id IS NULL THEN RAISE; END IF;',
        stockLineGuard: LAWFUL.stockLineGuard.replace('<= 0', '< 0'),
        stockHeaderGuard: LAWFUL.stockHeaderGuard.replace('<= 0', '< 0'),
      }),
    ).toEqual([]);
  });
});

// ── THE BEHAVIOURAL HALF: the matched pair, through the real command ────────

describe('C-07 the matched pair, driven through the sale commit command', () => {
  let t: TestApp;
  let day: string;
  let owner: HttpActor;
  let A: S3Business;
  let subject: SaleSubject;
  let customerId: string;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    day = await today();
    t = await createTestApp();
    owner = await registerActor(t, 'cogs owed owner');
    A = await onboardS3Business(t, owner, 's2cogs');
    ({ customerId } = await seedSaleFixtures(ownerPool(), A, day));
    subject = await saleSubject(ownerPool());
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await resetData();
  });

  /** Bring stock in at `unitCost`. `'0'` is the zero-valuation case the ZERO arm is about. */
  async function stockUp(quantity: string, unitCost: string): Promise<Response> {
    return t.request
      .post('/v1/inventory/adjustments')
      .set(asMember(owner, A.businessId))
      .send({
        adjustmentId: randomUUID(),
        warehouseId: A.w1,
        occurredOn: day,
        reason: 'cogs-owed fixture',
        lines: [{ productId: A.piece.productId, quantity, unitCost }],
      });
  }

  const sale = (quantity: string): Promise<Response> =>
    confirmSale(t, asMember(owner, A.businessId), {
      saleId: randomUUID(),
      customerId,
      warehouseId: A.w1,
      branchId: A.branchX,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity }],
    });

  it('the subject exists: the sale commit routine is in the tree', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('the trigger that carries the law is installed, DEFERRED, and on `sales`', async () => {
    requireSubject(subject.missing, CLAIM);
    // Deferred is not decoration: the sale and its entry are written in one
    // transaction, so a NOT DEFERRED trigger would judge the sale before the
    // binding it is owed could possibly exist, and the law would refuse every
    // sale. Read from the catalogue, so a trigger recreated without
    // `DEFERRABLE INITIALLY DEFERRED` is caught.
    const r = await ownerPool().query<{ tgname: string; deferrable: boolean; deferred: boolean }>(
      `SELECT t.tgname::text AS tgname, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'sales' AND NOT t.tgisinternal AND t.tgname = 'sales_cogs_owed'`,
    );
    expect(
      r.rows.map((x) => x.tgname),
      'sales_cogs_owed is a trigger on sales',
    ).toEqual(['sales_cogs_owed']);
    expect(r.rows[0]?.deferrable, 'it is DEFERRABLE, or it would judge the sale before its entry could exist').toBe(true);
    expect(r.rows[0]?.deferred, 'and INITIALLY DEFERRED, so the verdict is taken at COMMIT').toBe(true);
    expect(await routineExists(ownerPool(), 'inventory_sale_cost_base_minor'), 'and the cost it reads is published by the inventory domain').toBe(true);
  });

  it('ZERO ARM: a sale of stock whose stored valuation is zero COMMITS, owes no COGS entry, and reconciles at zero', async () => {
    requireSubject(subject.missing, CLAIM);
    // The inbound at a unit cost of 0 is the whole premise: `0060:388-390`
    // values an emptying outbound at exactly the stored valuation, so the
    // sale's movement carries 0 and `journal_lines_money_cap_ck` could not
    // express a COGS line for it.
    const inbound = await stockUp('4', '0');
    expect(inbound.status, 'an inbound adjustment at a unit cost of zero is accepted — the ZERO arm has no premise otherwise').toBe(201);

    const res = await sale('4');
    expect(res.status, `the zero-valuation sale commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);

    const saleId = res.body.saleId as string;
    const cost = await ownerPool().query<{ cost: string | null }>(`SELECT inventory_sale_cost_base_minor($1, $2)::text AS cost`, [A.businessId, saleId]);
    expect(cost.rows[0]?.cost, 'the sale carries a bridged movement, and its cost is exactly zero').toBe('0');

    const binding = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sales WHERE business_id = $1 AND id = $2 AND binding_source_id IS NOT NULL`,
      [A.businessId, saleId],
    );
    expect(binding.rows[0]?.n, 'a zero-cost sale carries NO `sale` accounting binding — there is no COGS entry to bind to').toBe('0');

    // No entry is sourced on the SALE: the COGS entry is the only one that
    // would be, and there is none. The revenue entry is the INVOICE's and is
    // still posted — which is the "one entry" of the conditional arm, and the
    // reason the sale is sound with no COGS at all.
    const onSale = await ownerPool().query<{ source_type: string }>(
      `SELECT source_type FROM journal_entries WHERE business_id = $1 AND source_id = $2 ORDER BY source_type`,
      [A.businessId, saleId],
    );
    expect(
      onSale.rows.map((x) => x.source_type),
      'no journal entry is sourced on the sale, because the COGS entry is the one that would be',
    ).toEqual([]);
    const onInvoice = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries je
         JOIN invoices i ON i.business_id = je.business_id AND i.id = je.source_id
        WHERE je.business_id = $1 AND je.source_type = 'invoice' AND i.sale_id = $2`,
      [A.businessId, saleId],
    );
    expect(onInvoice.rows[0]?.n, 'and the revenue entry IS posted — exactly one entry, which is what the conditional arm claims').toBe('1');

    // The official identity, which holds at zero as well as anywhere else, and
    // is never reconstructed from quantity × a rounded average.
    await expectInventoryReconciled(ownerPool(), A.businessId, 'after the zero-valuation sale');
  });

  it('NON-ZERO ARM: a sale whose goods carry value commits only WITH its COGS entry, and the binding is the sale itself', async () => {
    requireSubject(subject.missing, CLAIM);
    const inbound = await stockUp('4', '5');
    expect(inbound.status, 'the priced inbound adjustment is accepted').toBe(201);

    const res = await sale('1');
    expect(res.status, `the priced sale commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    const saleId = res.body.saleId as string;

    const row = await ownerPool().query<{ cost: string | null; binding: string | null }>(
      `SELECT inventory_sale_cost_base_minor($1, $2)::text AS cost,
              (SELECT s.binding_source_id::text FROM sales s WHERE s.business_id = $1 AND s.id = $2) AS binding`,
      [A.businessId, saleId],
    );
    expect(row.rows[0]?.cost, 'the sale’s goods carry value, so its cost is non-zero').not.toBe('0');
    expect(row.rows[0]?.cost, 'and it is a real number, not the NULL that means "no bridged movement"').not.toBeNull();
    expect(row.rows[0]?.binding, 'so it owes a COGS entry, and `sales_binding_identity_ck` makes the binding the sale itself').toBe(saleId);

    const bound = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_source_bindings WHERE business_id = $1 AND source_type = 'sale' AND source_id = $2`,
      [A.businessId, saleId],
    );
    expect(bound.rows[0]?.n, 'and that binding is a real row of accounting_source_bindings, not a dangling id').toBe('1');

    await expectInventoryReconciled(ownerPool(), A.businessId, 'after the priced sale');
  });
});
