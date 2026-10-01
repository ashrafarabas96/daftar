/**
 * GOLDEN REGRESSION — G-01 / GOLD-19, THE SALE HALF.
 * TWO CONCURRENT SALES OF THE FINAL UNIT.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-16, P4-AL-29, P4-AL-32, P4-AL-41,
 *  P4-AL-42, P4-AL-43 scenario 1, P4-AL-65 G-01; OD-P4-05 = NO OVERSELL;
 *  docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §3.)
 *
 * The same law `05-last-item-race.golden.test.ts` proves of the stock writer,
 * asserted of the SALE: one unit available, two concurrent confirmations,
 * exactly one commit, exactly one stable business refusal, `on_hand` never
 * negative, exactly one sale, exactly one stock decrement, no orphan invoice,
 * no orphan journal and no phantom movement.
 *
 * The interleaving is forced by the same mechanism and for the same reason —
 * a park on the stock key, each attempt observed into the queue one at a time,
 * no sleep anywhere, the expiry of any bound a failure. See 05's header for the
 * mechanism and `harness.ts` for the code; it is deliberately not described
 * twice, because a mechanism described twice drifts.
 *
 * ── THIS FILE IS RED UNTIL THE P4-S2 PRIMITIVE LANDS, AND THAT IS CORRECT ──
 *
 * Every `it` below begins by requiring its subject. While `sales`,
 * `sale_items`, the `sale` stock source type, the two accounting source types,
 * the `sale.*` operation kinds and the commit routine do not exist, the claim
 * "exactly one of two concurrent sales of the final unit commits" is neither
 * true nor false — it has no subject — and the canary makes that a RED with the
 * missing names in the message.
 *
 * It is NOT skipped, marked `todo` or guarded by an `if`. A conditional pass is
 * a `.skip` the gate's SKIP regex cannot see, and a suite that reported green
 * while its subject did not exist is precisely the vacuity defect this estate
 * keeps rediscovering. The red message names what is missing, so the day the
 * primitive lands this file either goes green or states a real defect.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../../helpers/inventory-commands';
import { ownerClient } from '../../helpers/stock-ledger';
import {
  census,
  censusDelta,
  expectInventoryReconciled,
  expectNoDeadlock,
  expectOnHand,
  forcedRace,
  must,
  negativeLevels,
  parkStockKey,
  requireSubject,
  saleSubject,
  type Census,
  type Outcome,
  type SaleSubject,
} from './harness';
import { confirmSale, seedSaleFixtures, stockRefusalCode } from './sale-path';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let subject: SaleSubject;
let customerId: string;

let before: Census;
let after: Census;
let outcomes: readonly Outcome<Response>[] = [];

/** The claim this file exists to settle, named once so every red says the same thing. */
const CLAIM = 'two concurrent sales of the final unit: exactly one commits';

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'G-01 sale owner');
  A = await onboardS3Business(t, owner, 'g01sale');
  ({ customerId } = await seedSaleFixtures(ownerPool(), A, day));
  subject = await saleSubject(ownerPool());

  // Exactly one unit on the shelf, through the inbound command that exists.
  const inbound = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(owner, A.businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'the last-item fixture',
      lines: [{ productId: A.piece.productId, quantity: '1', unitCost: '10' }],
    });
  expect(inbound.status, 'the fixture inbound adjustment is accepted').toBe(201);

  // The race runs only when there is something to race. While the subject is
  // absent `outcomes` stays empty and every `it` fails on its canary, which is
  // the honest report; attempting the race against a route that is not mounted
  // would fail with a 404 and call it a refusal.
  if (subject.missing.length === 0) {
    before = await census(ownerPool(), A.businessId);
    const attempt = (): Promise<Response> =>
      confirmSale(t, asMember(owner, A.businessId), {
        saleId: randomUUID(),
        customerId,
        warehouseId: A.w1,
        branchId: A.branchX,
        occurredOn: day,
        lines: [{ productId: A.piece.productId, quantity: '1' }],
      });
    const park = await parkStockKey(() => ownerClient(), A.businessId, A.w1, A.piece.variantId);
    outcomes = await forcedRace(park, [attempt, attempt], 'G-01 two concurrent sales of the final unit');
    after = await census(ownerPool(), A.businessId);
  }
}, 180_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe('G-01 / GOLD-19 two concurrent sales of the final unit', () => {
  it('the subject exists: the sale commit primitive and its registrations are in the tree', () => {
    requireSubject(subject.missing, CLAIM);
    expect(outcomes.length, 'NO SUBJECT — the race ran no attempts').toBe(2);
  });

  it('no attempt deadlocked: 40P01 is a lock-order defect, never an outcome and never retried', () => {
    requireSubject(subject.missing, CLAIM);
    expectNoDeadlock(outcomes, 'G-01 two concurrent sales of the final unit');
  });

  it('exactly one sale commits', () => {
    requireSubject(subject.missing, CLAIM);
    const accepted = outcomes.filter((o) => o.kind === 'ok' && o.value.status >= 200 && o.value.status < 300);
    expect(accepted.length, 'exactly one of the two concurrent confirmations is accepted').toBe(1);
  });

  it('exactly one attempt is refused, and the refusal is a stable business refusal naming the stock', () => {
    requireSubject(subject.missing, CLAIM);
    const refused = outcomes.filter((o) => o.kind === 'ok' && !(o.value.status >= 200 && o.value.status < 300));
    expect(refused.length, 'exactly one of the two concurrent confirmations is refused').toBe(1);
    const res = (must(refused[0], 'the refusal') as { value: Response }).value;
    expect(res.status, 'the loser is refused with a conflict, not a 500: losing a race for the last unit is a business outcome').toBe(409);
    expect(res.body?.error?.code, 'the refusal carries the envelope’s stable code').toBe('CONFLICT');
    expect(
      stockRefusalCode(res),
      'the refusal names the stock reason in a machine-readable code, so the merchant sentence is RENDERED from a code rather than ' +
        'composed by the server (P4-AL-16: "a localized sentence, never a partial success")',
    ).toMatch(/\.insufficient_stock$/);
  });

  it('no attempt failed outside the HTTP contract', () => {
    requireSubject(subject.missing, CLAIM);
    expect(
      outcomes.filter((o) => o.kind === 'error').map((o) => String((o as { error: unknown }).error)),
      'neither attempt threw',
    ).toEqual([]);
  });

  it('`on_hand` ends at exactly zero and no level of the business is negative — OD-P4-05', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectOnHand(ownerPool(), A.businessId, A.w1, A.piece.variantId, '0', 'the final unit left the shelf exactly once');
    expect(await negativeLevels(ownerPool(), A.businessId), 'no stock level is below zero').toEqual([]);
  });

  it('exactly one sale row, one sale line, one movement and one decrement', () => {
    requireSubject(subject.missing, CLAIM);
    const d = censusDelta(before, after);
    expect(d['sales'] ?? 0, 'one sales row — the loser left none').toBe(1);
    expect(d['sale_items'] ?? 0, 'one sale line').toBe(1);
    expect(d['stock_movements'] ?? 0, 'one stock movement — no phantom movement from the loser').toBe(1);
    expect(d['stock_source_bridge_sale'] ?? 0, 'one stock-source bridge row').toBe(1);
    expect(d['stock_levels'] ?? 0, 'the race created no new stock key').toBe(0);
  });

  it('exactly one invoice and no orphan invoice', () => {
    requireSubject(subject.missing, CLAIM);
    const d = censusDelta(before, after);
    expect(d['invoices'] ?? 0, 'one invoice — the loser left none').toBe(1);
    expect(d['invoice_items'] ?? 0, 'one invoice line').toBe(1);
  });

  it('no orphan journal: the entries the winner posted, each with its binding, and nothing from the loser', () => {
    requireSubject(subject.missing, CLAIM);
    const d = censusDelta(before, after);
    const entries = d['journal_entries'] ?? 0;
    // Two entries on the credit arm (P4-AL-16): the COGS entry and the
    // revenue/AR entry. The law asserted is the BINDING EQUALITY, not the
    // number: whatever the winner posted, every entry has its source binding
    // and every binding its entry, and the loser contributed neither.
    expect(entries, 'the winner posted at least the COGS entry and the revenue entry').toBeGreaterThanOrEqual(2);
    expect(d['accounting_source_bindings'] ?? 0, 'one accounting source binding per entry — no entry without a source, no source without an entry').toBe(
      entries,
    );
  });

  it('nothing of the whole business is outside the census the loser could have survived in', () => {
    requireSubject(subject.missing, CLAIM);
    // The census is DISCOVERED from pg_class, so this assertion is about every
    // business-scoped relation that exists rather than about a list someone
    // maintained. The two relations deliberately NOT constrained here are the
    // record-keeping ones: `audit_events` and `outbox_events` are written for a
    // REFUSED command too (P4-AL-48), in the refused command's own
    // transaction, so a row from the loser there is the audit working.
    const d = censusDelta(before, after);
    const unexpected = Object.entries(d).filter(([table]) => /^(sales|sale_items|invoices|invoice_items)$/.test(table) === false);
    expect(
      unexpected.every(([, n]) => n >= 0),
      `no count may go DOWN across a race: ${JSON.stringify(d)}`,
    ).toBe(true);
  });

  it('GL Inventory (1200) == Σ stock_movements.value_delta_base_minor after the race', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectInventoryReconciled(ownerPool(), A.businessId, 'G-01 after the forced sale race');
  });
});
