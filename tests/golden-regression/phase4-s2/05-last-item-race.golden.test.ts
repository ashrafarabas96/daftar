/**
 * GOLDEN REGRESSION — G-01 / GOLD-19, THE STOCK-WRITER HALF.
 * THE LAST-ITEM RACE, FORCED.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-16, P4-AL-29, P4-AL-32, P4-AL-41,
 *  P4-AL-42, P4-AL-43 scenario 1, P4-AL-65 G-01; OD-P4-05 = NO OVERSELL;
 *  docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §2.)
 *
 * G-01 is one law — "two concurrent attempts on the final unit: exactly one
 * commits, the loser gets a stable refusal, `on_hand` never goes negative, no
 * phantom movement" — asserted at the one place that can enforce it: the stock
 * writer. P4-AL-29 fixes that a sale writes stock ONLY through
 * `inventory_apply_stock_movements`, and OD-P4-05 fixes that the writer is NOT
 * weakened to let a sale through. So the no-oversell half of G-01 is a property
 * of a routine that EXISTS TODAY, reachable today through an outbound product
 * command, and this file proves it today — against the exact routine the sale
 * is required to call, through a real HTTP command, with the interleaving
 * injected.
 *
 * `06-sale-last-item-race.golden.test.ts` is the other half: the same law
 * through the sale path, red until the P4-S2 primitive lands. Splitting them is
 * deliberate. A single file would have had to be red in its entirety until the
 * sale existed, and the mechanism — which is the part this estate has got wrong
 * before — would have gone unexercised for the whole of the slice.
 *
 * ── HOW THE INTERLEAVING IS FORCED, AND WHY IT CANNOT DEPEND ON TIMING ─────
 *
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`. FI-11 passed on a
 * slow host and failed on a fast one and proved nothing either way, because it
 * asked two requests to collide and hoped. Nothing here hopes:
 *
 *   1. A third connection takes `SELECT … FROM stock_levels … FOR UPDATE` on
 *      the one stock key the command must lock (`0060:296-306`: every distinct
 *      key, in ascending `(warehouse_id, variant_id)` order whatever the
 *      payload order, created if absent and then locked FOR UPDATE) and HOLDS
 *      it in an open transaction.
 *   2. Attempt 1 is launched. The suite then waits until a backend is OBSERVED
 *      parked behind that lock, through `pg_blocking_pids` — not until a clock
 *      says so.
 *   3. Only then is attempt 2 launched, and the suite waits until it too is
 *      observed parked. The queue now holds attempt 1 ahead of attempt 2
 *      because the suite put them there one at a time.
 *   4. The park is released. PostgreSQL grants the row lock in queue order, so
 *      the service order is the order this file chose.
 *
 * There is no `sleep` in this file and none in the harness. The two bounded
 * polls are observations, and the expiry of either bound is a FAILURE: an
 * attempt that never parked did not contend, so its result is not a race
 * result and the harness throws rather than reporting a pass. A faster or
 * slower host changes how many times the poll runs and changes no verdict.
 *
 * A deadlock is not a possible outcome of this shape — one holder, two
 * waiters, one lock, no cycle. If one appears anyway, `expectNoDeadlock` fails
 * the case with the lock-order sentence: 40P01 is a defect in the declared
 * order of P4-AL-41, never a business outcome and never something to retry
 * (`[[daftar-lock-order-not-retry]]`).
 *
 * ── WHY THE ASSERTIONS ARE IN SEPARATE `it`s ──────────────────────────────
 *
 * A failing assertion aborts its test body and hides every assertion after it,
 * which is how P4-S1 measured 27 → 30 → 32 across three rounds. The race is
 * performed ONCE, in `beforeAll`, and each law of G-01 is asserted in its own
 * `it`, so one broken law hides none of the others.
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
  forcedRace,
  must,
  negativeLevels,
  expectOnHand,
  parkStockKey,
  routineExists,
  settle,
  waitUntilQueued,
  type Census,
  type Outcome,
} from './harness';

/** The routine G-01's no-oversell half is a property of (P4-AL-29). */
const PRIMITIVE = 'inventory_apply_stock_movements';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;

/** The state of the world before the race, and the race's two outcomes. */
let before: Census;
let after: Census;
let outcomes: readonly Outcome<Response>[];
/** The two keys of the lock-order probe, and what it observed. */
let probe: { firstKeyBlocked: number; secondKeyBlocked: number; outcomes: readonly Outcome<Response>[] };

const send = (path: string, body: object): Promise<Response> => t.request.post(`/v1/inventory/${path}`).set(asMember(owner, A.businessId)).send(body);

/**
 * One unit into w1, through the product's own inbound command.
 *
 * A positive ADJUSTMENT, not an opening: an opening may be posted once per
 * business (`inventory.opening_already_posted`), and this file needs to restock
 * between the race and the lock-order probe. The command used to arrive at the
 * fixture state is not the subject of G-01; the writer both of them call is.
 */
async function stockUnits(productId: string, quantity: string, unitCost: string): Promise<void> {
  const res = await send('adjustments', {
    adjustmentId: randomUUID(),
    warehouseId: A.w1,
    occurredOn: day,
    reason: 'the last-item fixture',
    lines: [{ productId, quantity, unitCost }],
  });
  expect(res.status, 'the fixture inbound adjustment is accepted').toBe(201);
}

async function stockOneUnit(productId: string, variantId: string, unitCost: string): Promise<void> {
  await stockUnits(productId, '1', unitCost);
  await expectOnHand(ownerPool(), A.businessId, A.w1, variantId, '1', 'the fixture leaves exactly one unit');
}

/** An outbound command for exactly one unit of `piece` out of w1 — the final unit. */
const takeTheLastUnit = (): Promise<Response> =>
  send('damages', {
    adjustmentId: randomUUID(),
    warehouseId: A.w1,
    occurredOn: day,
    reason: 'the last-item race',
    lines: [{ productId: A.piece.productId, quantity: '1' }],
  });

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'G-01 owner');
  A = await onboardS3Business(t, owner, 'g01');

  // ── the race itself, performed once ──
  //
  // A standing position in a THIRD product, which neither the race nor the
  // probe touches. Without it the business ends the file at GL Inventory = 0
  // and Σ value_delta = 0, and `0 == 0` is an identity that holds for a
  // business that never traded: the reconciliation assertion would be true and
  // would prove nothing.
  await stockUnits(A.dec2.productId, '5', '2.5');
  await stockOneUnit(A.piece.productId, A.piece.variantId, '10');
  before = await census(ownerPool(), A.businessId);
  const park = await parkStockKey(() => ownerClient(), A.businessId, A.w1, A.piece.variantId);
  outcomes = await forcedRace(park, [takeTheLastUnit, takeTheLastUnit], 'G-01 the last-item race');
  after = await census(ownerPool(), A.businessId);

  // ── the lock-order probe, performed once ──
  //
  // Two keys of the same warehouse, both parked, and two commands whose
  // PAYLOAD orders are the reverse of one another. `0060:291-296` claims the
  // keys are locked in ascending key order "whatever the payload order", which
  // is what makes two concurrent multi-key commands incapable of deadlocking.
  // That claim is OBSERVED here rather than trusted: if acquisition followed
  // the payload, the two commands would park on DIFFERENT keys, and that
  // difference — not a deadlock, which needs luck to reproduce — is the
  // finding. No retry, no N rounds, no timing.
  await stockOneUnit(A.piece.productId, A.piece.variantId, '10');
  await stockOneUnit(A.piece2.productId, A.piece2.variantId, '4');
  const order = must(
    (
      await ownerPool().query<{ lo: string; hi: string }>(`SELECT least($1::uuid, $2::uuid)::text AS lo, greatest($1::uuid, $2::uuid)::text AS hi`, [
        A.piece.variantId,
        A.piece2.variantId,
      ])
    ).rows[0],
  );
  const lo = order.lo;
  const hi = order.hi;
  const parkLo = await parkStockKey(() => ownerClient(), A.businessId, A.w1, lo);
  const parkHi = await parkStockKey(() => ownerClient(), A.businessId, A.w1, hi);
  const variantProduct = (variantId: string): string => (variantId === A.piece.variantId ? A.piece.productId : A.piece2.productId);
  const twoLines = (first: string, last: string) => (): Promise<Response> =>
    send('damages', {
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'the lock-order probe',
      lines: [
        { productId: variantProduct(first), quantity: '1' },
        { productId: variantProduct(last), quantity: '1' },
      ],
    });
  const pendingA = settle(twoLines(lo, hi));
  const flagA = { done: false };
  void pendingA.then(() => (flagA.done = true));
  await waitUntilQueued([parkLo.pid, parkHi.pid], 1, flagA, 'the lock-order probe: the ascending-payload command');
  const pendingB = settle(twoLines(hi, lo));
  const flagB = { done: false };
  void pendingB.then(() => (flagB.done = true));
  await waitUntilQueued([parkLo.pid, parkHi.pid], 2, flagB, 'the lock-order probe: the descending-payload command');
  // Direct blockers only: a command queued behind another command on the SAME
  // key reports that command among its blockers too, so the discriminator is
  // which PARKER a backend names, not how many backends are waiting.
  const direct = async (pid: number): Promise<number> =>
    must(
      (
        await ownerPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND $1 = ANY (pg_blocking_pids(pid))`,
          [pid],
        )
      ).rows[0],
    ).n;
  probe = { firstKeyBlocked: await direct(parkLo.pid), secondKeyBlocked: await direct(parkHi.pid), outcomes: [] };
  await parkLo.release();
  await parkHi.release();
  probe = { ...probe, outcomes: await Promise.all([pendingA, pendingB]) };
}, 180_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe('G-01 / GOLD-19 the last-item race, forced: the stock writer the sale is required to use', () => {
  it('the subject exists: the primitive is in the catalogue, so this law has something to be true of', async () => {
    expect(await routineExists(ownerPool(), PRIMITIVE), `NO SUBJECT — ${PRIMITIVE} is absent, so G-01 has no writer to be a law about`).toBe(true);
    expect(outcomes.length, 'NO SUBJECT — the race ran no attempts').toBe(2);
  });

  it('no attempt deadlocked: 40P01 is a lock-order defect, never an outcome', () => {
    expectNoDeadlock(outcomes, 'G-01 the last-item race');
  });

  it('exactly one attempt commits', () => {
    const accepted = outcomes.filter((o) => o.kind === 'ok' && o.value.status === 201);
    expect(accepted.length, 'exactly one of the two attempts on the final unit is accepted').toBe(1);
  });

  it('exactly one attempt is refused, and the refusal is a stable business refusal — not a crash', () => {
    const refused = outcomes.filter((o) => o.kind === 'ok' && o.value.status !== 201);
    expect(refused.length, 'exactly one of the two attempts is refused').toBe(1);
    const res = (must(refused[0], 'the refusal') as { value: Response }).value;
    expect(res.status, 'the loser is refused with a conflict, not a 500: an oversell attempt is a business outcome').toBe(409);
    expect(res.body?.error?.code, 'the refusal carries its stable API code').toBe('CONFLICT');
    expect(res.body?.error?.details?.inventoryCode, 'the refusal carries the one stable code the merchant sentence is rendered from').toBe(
      'inventory.insufficient_stock',
    );
  });

  it('no attempt failed in any other way: the loser lost for the stock reason and nothing else', () => {
    const other = outcomes.filter((o) => o.kind === 'error');
    expect(
      other.map((o) => String((o as { error: unknown }).error)),
      'neither attempt threw outside the HTTP contract',
    ).toEqual([]);
    const unexpected = outcomes.filter((o) => o.kind === 'ok' && o.value.status !== 201 && o.value.status !== 409);
    expect(
      unexpected.map((o) => (o as { value: Response }).value.status),
      'no attempt was refused for a reason other than the stock',
    ).toEqual([]);
  });

  it('`on_hand` ends at exactly zero and was never negative — OD-P4-05, no oversell', async () => {
    await expectOnHand(ownerPool(), A.businessId, A.w1, A.piece.variantId, '0', 'the final unit left the shelf exactly once');
    expect(await negativeLevels(ownerPool(), A.businessId), 'no stock level of this business is below zero').toEqual([]);
  });

  it('exactly one outbound movement and one decrement survive — no phantom movement from the loser', () => {
    const d = censusDelta(before, after);
    expect(d['stock_movements'] ?? 0, 'one movement, from the winner only').toBe(1);
    expect(d['stock_levels'] ?? 0, 'the race created no new stock key').toBe(0);
  });

  it('the loser left nothing behind: one document, one bridge row, one entry, one consumed assertion', () => {
    const d = censusDelta(before, after);
    expect(d['inventory_adjustments'] ?? 0, 'one adjustment document, from the winner only').toBe(1);
    expect(d['inventory_adjustment_lines'] ?? 0, 'one adjustment line').toBe(1);
    expect(d['stock_source_bridge_inventory_adjustment'] ?? 0, 'one stock-source bridge row — no orphan bridge from the loser').toBe(1);
    expect(d['journal_entries'] ?? 0, 'one journal entry — no orphan journal from the loser').toBe(1);
    expect(d['accounting_source_bindings'] ?? 0, 'one accounting source binding — no entry without a source and no source without an entry').toBe(1);
    expect(d['inventory_assertion_uses'] ?? 0, 'exactly one command assertion was consumed').toBe(1);
  });

  it('GL Inventory (1200) == Σ stock_movements.value_delta_base_minor after the race', async () => {
    const gl = await expectInventoryReconciled(ownerPool(), A.businessId, 'G-01 after the forced race');
    // Non-vacuity: the business holds the standing `dec2` position, so both
    // sides of the identity are non-zero and `0 == 0` is not what passed.
    expect(gl === 0n, 'the identity is asserted over a NON-ZERO inventory position, not over a business that never traded').toBe(false);
  });

  it('the lock order is the KEY order and not the payload order — the deterministic lock-order probe', () => {
    // Both keys are held. Two commands are in flight whose PAYLOAD orders are
    // the reverse of one another, and both were observed parked (the harness
    // would have thrown otherwise). The discriminator is WHICH held key they
    // are waiting for:
    //
    //   key-sorted acquisition  → both wait for the LOWER key; nothing is
    //                             waiting for the higher one;
    //   payload-order acquisition → the descending command goes for the HIGHER
    //                             key first, and something is waiting for it.
    //
    // So a payload-ordered writer is caught HERE, deterministically, with no
    // deadlock, no N rounds and no reliance on two commands colliding. A
    // deadlock is the SYMPTOM of this defect and needs luck to reproduce; the
    // acquisition order is the defect itself and is observable every time.
    expect(
      probe.secondKeyBlocked,
      'nothing may be waiting on the HIGHER stock key while the lower one is held: the keys are locked in ascending ' +
        '(warehouse_id, variant_id) order whatever the payload order (0060:291-296). A non-zero count here means acquisition ' +
        'follows the payload, which is a LOCK-ORDER DEFECT against the declared order of P4-AL-41 — fixed by changing the order, ' +
        'never by a retry, never by raising deadlock_timeout and never by treating 40P01 as a business outcome.',
    ).toBe(0);
    expect(probe.firstKeyBlocked, 'at least one command is waiting on the lower key, so the probe had a subject').toBeGreaterThan(0);
  });

  it('the two multi-key commands serialize without a deadlock', () => {
    expectNoDeadlock(probe.outcomes, 'the lock-order probe');
    const statuses = probe.outcomes.map((o) => (o.kind === 'ok' ? o.value.status : -1)).sort((a, b) => a - b);
    expect(statuses.filter((s) => s === 201).length, 'exactly one of the two two-line commands commits (one unit of each key existed)').toBe(1);
    expect(statuses.filter((s) => s === 409).length, 'the other is refused by the stock, not by a deadlock').toBe(1);
  });
});
