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
  censusKinds,
  discoveredRegistryPrunes,
  entitledToPrune,
  expectInventoryReconciled,
  expectNoDeadlock,
  expectOnHand,
  forcedRace,
  lostBeyondExpiry,
  must,
  negativeLevels,
  parkStockKey,
  registryExpiry,
  requireSubject,
  saleSubject,
  type Census,
  type RegistryExpiry,
  type RegistryPrune,
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

/**
 * The registries the census counts GLOBALLY, and the wall-clock prunes that
 * are entitled to delete from them — both DISCOVERED, so neither is a list
 * anyone maintains. See the two claims at the end of this file.
 */
let registries: readonly string[] = [];
let prunes: readonly RegistryPrune[] = [];
let registryBefore: Readonly<Record<string, RegistryExpiry>> = {};
let registryAfter: Readonly<Record<string, RegistryExpiry>> = {};
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
  registries = (await censusKinds(ownerPool())).registries;
  prunes = await discoveredRegistryPrunes(ownerPool());

  if (subject.missing.length === 0) {
    before = await census(ownerPool(), A.businessId);
    registryBefore = await registryExpiry(ownerPool(), prunes);
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
    registryAfter = await registryExpiry(ownerPool(), prunes);
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
    //
    // THE JTI REGISTRIES ARE NOT UNDER THIS LAW EITHER, for two reasons that
    // are both about the census and neither about the race. `census()` counts
    // them with NO business predicate, so their number is a count over the
    // whole cluster and belongs to nobody's race; and the posting path prunes
    // expired jtis on a WALL CLOCK inside the very transaction the race
    // drives, so once a job has been running longer than the prune's interval
    // the count legitimately goes down. Measured 2026-10-04 (run 37175753520,
    // step 31): this file ran seven times in one job on an identical tree, the
    // six runs inside the hour passed, and the seventh — against a cluster up
    // for 68 minutes — reported `accounting_assertion_uses: -1`. A law that
    // calls a garbage collection a defect is a law that will be overridden the
    // first time it fires, which is worse than not having it.
    //
    // What they owe instead is the claim below, which is the one the race is
    // actually about: a registry may lose an EXPIRED row and never any other.
    const d = censusDelta(before, after);
    const exempt = new RegExp(`^(sales|sale_items|invoices|invoice_items|${registries.join('|')})$`);
    const unexpected = Object.entries(d).filter(([table]) => exempt.test(table) === false);
    // Non-vacuity: the exemption must not have swallowed the law.
    expect(unexpected.length, `every counted relation is exempt, so this law asserts nothing: ${JSON.stringify(d)}`).toBeGreaterThan(0);
    expect(
      unexpected.every(([, n]) => n >= 0),
      `no count may go DOWN across a race: ${JSON.stringify(d)}`,
    ).toBe(true);
  });

  it('a jti registry may only ever lose rows that had already expired', () => {
    requireSubject(subject.missing, CLAIM);
    // The compensating claim for the exemption above, and it is STRONGER than
    // monotonicity where monotonicity was false: the prune may take expired
    // rows and nothing else, so an unexpired jti can never vanish across the
    // race — which is what "no row of the loser survived, and no row of the
    // winner was lost" actually means for these relations.
    expect(
      prunes.map((pr) => pr.table),
      'NO SUBJECT — no wall-clock prune was discovered in the live catalogue, so this claim has nothing to be about',
    ).not.toEqual([]);
    for (const pr of prunes) {
      const was = must(registryBefore[pr.table], `${pr.table} before the race`);
      const now = must(registryAfter[pr.table], `${pr.table} after the race`);
      expect(
        lostBeyondExpiry(was, now),
        `${pr.table}: ${was.total} rows before the race of which ${entitledToPrune(was, now)} were past ` +
          `${pr.interval} by the time the prune ran (${was.expired} already were when the census read them), ` +
          `and ${now.total} after — a decrease beyond the entitled ones is an unexpired jti vanishing, ` +
          `which no prune may do`,
      ).toBe(0);
    }
  });

  it('that law can say no: a vanished UNEXPIRED jti is refused', () => {
    // The red proof for the claim above, on synthetic captures, because an
    // inequality that has only ever been handed a real measurement is an
    // inequality nobody has watched refuse anything. Four rows of which one
    // was expired: losing that one is lawful, losing two is not.
    expect(lostBeyondExpiry({ total: 4, expired: 1 }, { total: 3 }), 'the expired row may go').toBe(0);
    expect(lostBeyondExpiry({ total: 4, expired: 1 }, { total: 2 }), 'an unexpired row may not').toBe(1);
    expect(lostBeyondExpiry({ total: 4, expired: 0 }, { total: 3 }), 'with nothing expired, any loss is a defect').toBe(1);
    expect(lostBeyondExpiry({ total: 4, expired: 4 }, { total: 0 }), 'an all-expired registry may be emptied').toBe(0);
    expect(lostBeyondExpiry({ total: 2, expired: 0 }, { total: 9 }), 'growth is not a loss').toBe(0);
    // And the same claims over the KEYED captures the real census now takes,
    // because the entitlement the law actually reads is the one recomputed
    // against the prune's own later horizon, not the `expired` above.
    //
    // A row is expired when its key is below the horizon, and the horizon is
    // already `now - interval`, so these keys are stated against it: with the
    // census horizon at 0 and an hour-long interval, a row aged 61 minutes
    // sits one minute BELOW it and the rest above. Four rows aged 1, 30, 59
    // and 61 minutes, read first at the census's own horizon and then two
    // minutes later, by which time the 59-minute row has crossed it.
    const keyed = { total: 4, expired: 1, horizonEpochMs: 0, keysEpochMs: [3_540_000, 1_800_000, 60_000, -60_000] };
    expect(entitledToPrune(keyed, { horizonEpochMs: 0 }), 'at the census horizon only the 61-minute row is expired').toBe(1);
    expect(entitledToPrune(keyed, { horizonEpochMs: 120_000 }), 'two minutes later the 59-minute row is expired too').toBe(2);
    expect(lostBeyondExpiry(keyed, { total: 2, horizonEpochMs: 120_000 }), 'both entitled rows may go').toBe(0);
    expect(lostBeyondExpiry(keyed, { total: 1, horizonEpochMs: 120_000 }), 'a third row may not').toBe(1);
    expect(lostBeyondExpiry(keyed, { total: 3, horizonEpochMs: 0 }), 'at the earlier horizon one row may go').toBe(0);
    expect(lostBeyondExpiry(keyed, { total: 2, horizonEpochMs: 0 }), 'at the earlier horizon a second may not').toBe(1);
  });

  it('GL Inventory (1200) == Σ stock_movements.value_delta_base_minor after the race', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectInventoryReconciled(ownerPool(), A.businessId, 'G-01 after the forced sale race');
  });
});
