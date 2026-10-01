/**
 * GOLDEN REGRESSION — THE ATOMIC SALE LAW AND G-18's SALE-SIDE HALF.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md §15, P4-AL-16, P4-AL-25, P4-AL-65 G-18
 *  (GOLD-33), P4-AL-49 `R-SAL-03`/`R-SAL-07`; V-P4-05;
 *  docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §4, §5.)
 *
 * Three claims, over the state a real sale leaves behind:
 *
 *   1. THE SEVEN FORBIDDEN COMMITTED STATES of §15 are unreachable. The laws
 *      live in `atomic-sale-law.ts` as a pure function of the committed state,
 *      so each of them is PROVED ABLE TO SAY NO in
 *      `tests/guards/sale-s2-red-proofs.test.ts` — a golden whose laws cannot
 *      be made red proves nothing (P4-AL-67).
 *
 *   2. THE INVENTORY IDENTITY, in the only form this estate accepts:
 *
 *          GL Inventory (1200) == Σ stock_movements.value_delta_base_minor
 *
 *      Never `quantity × average_cost`. The canonical suite document's
 *      GOLD-33 line still reads `GL(1200) = Σ(qty×avg_cost)`; P4-AL-25 and
 *      `TL-P4-S0-01` supersede it, because the average is a rounded quotient
 *      and re-multiplying it reintroduces the drift the stored integer delta
 *      has already resolved — `[[daftar-a-rounded-quotient-is-never-an-input]]`.
 *
 *   3. THE ACCOUNT IDENTITIES AND THEIR CODES, WRITTEN OUT. V-P4-05 records
 *      that the §17.4 codes were read from the golden-suite document rather
 *      than cross-checked against `0040_accounting_chart.sql`. So the three
 *      codes a sale touches are literals here, and each is asserted against
 *      the account the business actually holds under that engine identity. A
 *      balanced entry made of the wrong accounts balances perfectly, which is
 *      the whole reason P4-AL-65 refuses "it balances" as an assertion.
 *
 * RED UNTIL THE P4-S2 PRIMITIVE LANDS. Every `it` requires its subject first;
 * nothing is skipped and nothing is conditional. See
 * `06-sale-last-item-race.golden.test.ts` for why that is the correct state.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../../helpers/inventory-commands';
import { REPO, existingRelations, expectInventoryReconciled, must, requireSubject, saleSubject, type SaleSubject } from './harness';
import { confirmSale, requireColumns, seedSaleFixtures } from './sale-path';
import { COGS_KEY, INVENTORY_KEY, LAWS, REVENUE_KEY, atomicSaleLawViolations, readSaleWorld, type SaleWorld } from './atomic-sale-law';

/**
 * The account codes a sale touches, WRITTEN OUT from `0040_accounting_chart.sql`
 * (`0040:53,59,63`) rather than read back from the seed. The identity is the
 * `system_key`; the code is the thing a merchant and an auditor see, and the
 * pairing is what this golden pins.
 */
const CHART: readonly (readonly [systemKey: string, code: string, type: string])[] = [
  [INVENTORY_KEY, '1200', 'asset'],
  [REVENUE_KEY, '4000', 'revenue'],
  [COGS_KEY, '5000', 'expense'],
];

const CLAIM = 'a committed sale leaves none of the seven states §15 forbids';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let subject: SaleSubject;
let world: SaleWorld = { sales: [], saleItems: [], invoices: [], invoiceItems: [], movements: [], bindings: [], entries: [] };
let saleResponse: Response | null = null;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'atomic sale law owner');
  A = await onboardS3Business(t, owner, 'g18sale');
  const fixtures = await seedSaleFixtures(ownerPool(), A, day);
  subject = await saleSubject(ownerPool());

  // Two inbound lots at DIFFERENT costs, so the average the writer carries is
  // a real quotient and the identity is not satisfied by tidy numbers
  // (G-18: "purchase-at-two-costs → sale"). 7 at 300, 3 at 433: the average is
  // 3.399 recurring, so any recomputation from a rounded average cannot match
  // Σ value_delta and the identity has teeth.
  for (const [quantity, unitCost] of [
    ['7', '3.00'],
    ['3', '4.33'],
  ] as const) {
    const res = await t.request
      .post('/v1/inventory/adjustments')
      .set(asMember(owner, A.businessId))
      .send({
        adjustmentId: randomUUID(),
        warehouseId: A.w1,
        occurredOn: day,
        reason: 'two costs',
        lines: [{ productId: A.piece.productId, quantity, unitCost }],
      });
    expect(res.status, `the inbound lot of ${quantity} at ${unitCost} is accepted`).toBe(201);
  }

  if (subject.missing.length === 0) {
    saleResponse = await confirmSale(t, asMember(owner, A.businessId), {
      saleId: randomUUID(),
      customerId: fixtures.customerId,
      warehouseId: A.w1,
      branchId: A.branchX,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity: '4' }],
    });
    const present = new Set(
      await existingRelations(ownerPool(), [
        'sales',
        'sale_items',
        'invoices',
        'invoice_items',
        'stock_movements',
        'accounting_source_bindings',
        'journal_entries',
      ]),
    );
    world = await readSaleWorld(ownerPool(), A.businessId, (r) => present.has(r));
  }
}, 180_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe('the atomic sale law (§15) over the state a committed sale leaves', () => {
  it('the subject exists: the sale commit primitive and its registrations are in the tree', () => {
    requireSubject(subject.missing, CLAIM);
    expect(must(saleResponse, 'the sale response').status, 'the sale was accepted, so there is a committed sale to be lawful about').toBeLessThan(300);
  });

  it('the columns the laws are written over exist', async () => {
    requireSubject(subject.missing, CLAIM);
    await requireColumns(ownerPool(), 'sales', ['tenant_id', 'business_id', 'id']);
    await requireColumns(ownerPool(), 'sale_items', ['business_id', 'sale_id', 'id']);
    await requireColumns(ownerPool(), 'invoices', ['business_id', 'id', 'sale_id', 'status', 'binding_source_id']);
    await requireColumns(ownerPool(), 'stock_movements', ['business_id', 'source_type', 'source_id', 'value_delta_base_minor']);
  });

  // One `it` per law. A single `it` over all seven would stop at the first
  // violation and hide the rest, which is exactly how a breakage count grows
  // round after round instead of being known once (P4-S1: 27 → 30 → 32).
  for (const law of LAWS) {
    it(`${law.id} — no committed state with ${law.forbids}`, () => {
      requireSubject(subject.missing, CLAIM);
      expect(law.check(world), `${law.id} forbids: ${law.forbids}`).toEqual([]);
    });
  }

  it('the whole law set holds at once, and over a non-empty world', () => {
    requireSubject(subject.missing, CLAIM);
    expect(atomicSaleLawViolations(world), 'every law of §15, together').toEqual([]);
    expect(world.sales.length, 'NO SUBJECT — the law set was evaluated over a world with no sale').toBeGreaterThan(0);
    expect(world.movements.length, 'NO SUBJECT — the law set was evaluated over a world with no stock movement').toBeGreaterThan(0);
  });

  it('GL Inventory (1200) == Σ stock_movements.value_delta_base_minor after the sale, at two costs', async () => {
    requireSubject(subject.missing, CLAIM);
    const gl = await expectInventoryReconciled(ownerPool(), A.businessId, 'G-18 after a sale drawn from two cost lots');
    expect(gl === 0n, 'non-vacuity: 6 units remain, so the identity is asserted over a NON-ZERO position').toBe(false);
  });

  /**
   * THE FORBIDDEN RECONSTRUCTION, PROVED STRUCTURALLY — AND WHY NOT NUMERICALLY.
   *
   * This case used to assert that the two formulas DISAGREE over the fixture,
   * on the reasoning that a reconciler silently rewritten as
   * `Σ(on_hand × avg_unit_cost_base_minor)` would then be caught. Measured on
   * the `0078` head it reported `official=20 forbidden=20`, and the premise
   * turns out to be unachievable rather than merely unlucky:
   *
   *   `valuation = T − round(q·avg)` is what the writer stores (`0060:388-393`
   *   values an outbound at `half_even(|q|·avg)`), and the reconstruction is
   *   `round(on_hand·avg) = round(T − q·avg)`. For a single stock key, with
   *   `T` an integer, `round(T − x) = T − round(x)` under HALF_EVEN for every
   *   `x` — including the exact halves, where the two ties break in opposite
   *   directions because the integer parts differ by an integer. So the two
   *   formulas are ALGEBRAICALLY EQUAL at one key, whatever the lots are, and
   *   summing over keys cannot separate them either because each key is
   *   individually equal. The remaining gap — `avg_unit_cost_base_minor` being
   *   a rounded quotient at `NUMERIC(28,10)` (`0059:106`) — needs an
   *   `on_hand` above 5e9 before it moves a single minor unit.
   *
   * Asserting a numeric disagreement that cannot exist is the kind of premise
   * that gets "fixed" by nudging the fixture until it passes. The law is
   * therefore stated where it actually lives — in the SQL, as
   * `[[daftar-a-rounded-quotient-is-never-an-input]]`: the reconciliation reads
   * `Σ stock_movements.value_delta_base_minor` and NAMES NEITHER the stored
   * average nor `on_hand`. That is checkable, it is red the moment the
   * forbidden column appears in it, and it does not depend on arithmetic luck.
   */
  it('the identity is never reconstructed from quantity × average cost', async () => {
    requireSubject(subject.missing, CLAIM);
    // The numeric half that IS true: the official identity holds, over a
    // non-zero position, and it is read from the ledger.
    const gl = await expectInventoryReconciled(ownerPool(), A.businessId, 'G-18 the official identity, before the structural claim below');
    expect(gl === 0n, 'non-vacuity: the identity is asserted over a NON-ZERO position').toBe(false);

    // And the structural half, over the ONE reconciliation this estate reads
    // the verdict out of. Read from disk, so a rewrite of the helper is what
    // this case is about and not a copy of it kept here.
    const source = readFileSync(join(REPO, 'tests/golden-regression/phase4-s2/harness.ts'), 'utf8');
    // The two SIDES of the identity, as CODE. Comments are stripped and string
    // literals are NOT: the prose above each function names the forbidden
    // formula in order to forbid it, so a check that read the prose would be
    // red for the warning rather than for the SQL — while the SQL itself lives
    // in a template literal, so stripping strings would read nothing at all.
    // The same trap as the harness's own `deadlock_timeout` check, which first
    // failed on its own message.
    const stripComments = (text: string): string => text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/^[ \t]*\/\/.*$/gm, ' ');
    const sides = ['glInventoryBaseMinor', 'ledgerValueBaseMinor'].map((name) => {
      const at = source.indexOf(`export async function ${name}`);
      const end = source.indexOf('\n}\n', at);
      return { name, code: at < 0 || end < 0 ? '' : stripComments(source.slice(at, end)) };
    });
    for (const side of sides) {
      expect(side.code.length, `NO SUBJECT — ${side.name} was not found in the harness, so the claim below reads nothing`).toBeGreaterThan(0);
    }
    expect(
      must(sides.find((x) => x.name === 'ledgerValueBaseMinor')).code.includes('value_delta_base_minor'),
      'the ledger side is Σ stock_movements.value_delta_base_minor, read from the movements',
    ).toBe(true);
    for (const side of sides) {
      for (const forbidden of ['avg_unit_cost_base_minor', 'average_cost', 'on_hand', 'stock_levels']) {
        expect(
          side.code.includes(forbidden),
          `${side.name} names ${forbidden}: the inventory value is NEVER reconstructed from a quantity times a rounded average ` +
            `(P4-AL-25, TL-P4-S0-01, [[daftar-a-rounded-quotient-is-never-an-input]])`,
        ).toBe(false);
      }
    }
  });

  it('the three account identities carry the codes written out from the chart migration', async () => {
    // This one has a subject TODAY: the chart is seeded at onboarding, long
    // before the sale exists, so it is asserted unconditionally.
    for (const [systemKey, code, type] of CHART) {
      const row = (
        await ownerPool().query<{ code: string; type: string }>(`SELECT code, type FROM accounts WHERE business_id = $1 AND system_key = $2`, [
          A.businessId,
          systemKey,
        ])
      ).rows[0];
      expect(row, `NO SUBJECT — the business holds no account under the engine identity ${systemKey}`).toBeDefined();
      expect(must(row).code, `${systemKey} must be account ${code} (0040:53,59,63) — a balanced entry made of the wrong accounts balances perfectly`).toBe(
        code,
      );
      expect(must(row).type, `${systemKey} is an ${type} account`).toBe(type);
    }
  });
});
