/**
 * P7-03 — TEN SENDS UNDER ONE KEY, WITH REAL CONCURRENCY, LEAVE ONE ROW.
 *
 * THE CONTRACT THIS ASSERTS IS THE ONE THAT EXISTS.
 * `apps/api/src/modules/inventory/inventory-movements.controller.ts` answers
 * `res.status(result.replayed ? 200 : 201)` and carries `replayed` in the body.
 * So ten identical sends are ONE 201 AND NINE 200s — not "ten identical
 * responses", which that controller makes impossible. The nine match the one
 * field for field EXCEPT `replayed`, and that is what is checked here. An
 * acceptance criterion that forces an implementer to break a standing contract
 * is worse than a weak one.
 *
 * THE CONCURRENCY IS REAL, AND `Promise.all` IS NOT USED.
 * `tests/integration/accounting-concurrency.test.ts` states this project's
 * convention and the reason for it: "A test that fires two promises with
 * `Promise.all` and trusts the scheduler proves whichever order it happened to
 * get." So the interleaving is FORCED. A second real connection opens its own
 * transaction and takes `FOR UPDATE` on the row the writing path must lock;
 * the ten sends are issued while that lock is held, so every one of them is
 * genuinely in flight at the same time and genuinely blocked on the same row;
 * only then does the holder commit and release them. The order under test is
 * the order that actually ran, on every machine.
 *
 * One connection cannot do this. PostgreSQL's row locks exist only between
 * sessions, and a session never blocks on itself — which is why the holder is a
 * separate `Client` from the pool and not a nested query on the app's.
 *
 * NOT RUN, and the reason is structural rather than a matter of effort. This
 * suite needs a live PostgreSQL: `vitest.config.ts` runs
 * `tests/helpers/global-setup.ts`, which calls `ensurePostgres()`
 * unconditionally, and the embedded cluster does not work on Windows at all
 * (`tests/helpers/embedded-cluster.ts` passes no explicit encoding or locale to
 * `initdb`). The host this card was executed on is Windows, and repository-wide
 * CI was halted on billing while it ran, so there was no Linux runner to read
 * either. Its exit code is therefore NOT_RUN — not passing, not failing.
 * `tests-unit/p7-03-sync-envelope.test.ts` is the part that COULD be measured
 * here, and it pins the controller's status mapping and this file's shape so
 * that a weakened version of this suite is caught even while it cannot run.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let day: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  day = await today();
  owner = await registerActor(t, 'p7-03 owner');
  A = await onboardS3Business(t, owner, 'p7-03');
}, 240_000);

afterAll(async () => {
  await t?.close();
});

const sendAdjustment = (body: object): Promise<Response> => t.request.post('/v1/inventory/adjustments').set(asMember(owner, A.businessId)).send(body);

/** How many adjustment headers exist under one client-minted id. */
async function adjustmentRows(adjustmentId: string): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM inventory_adjustments WHERE business_id = $1 AND id = $2`, [
    A.businessId,
    adjustmentId,
  ]);
  return Number(must(r.rows[0]).n);
}

describe('P7-03: replay suppression under real concurrency', () => {
  it('ten sends blocked on one held lock produce one row, one 201 and nine 200s', async () => {
    const adjustmentId = randomUUID();
    const body = {
      adjustmentId,
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'ten sends under one key',
      lines: [{ productId: A.piece.productId, quantity: '2', unitCost: '13' }],
    };

    // A SECOND REAL CONNECTION, which is the whole point. It opens its own
    // transaction and locks the business row every posting path must take
    // before it can write, so the ten sends below are all genuinely waiting on
    // the same row at the same time rather than being serialised by the
    // scheduler.
    const holder: PoolClient = await ownerPool().connect();
    let responses: Response[] = [];
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [A.businessId]);

      // Fire all ten WITHOUT awaiting them: they must be in flight together.
      // This is not `Promise.all` over work that has not started — the requests
      // are already issued and already blocked on `holder`'s lock before
      // anything is awaited, which is the property the convention asks for and
      // `Promise.all` alone does not give.
      const inFlight = Array.from({ length: 10 }, () => sendAdjustment(body));

      // Prove they really are blocked before releasing: with the lock held,
      // nothing may have finished. A send that completed here would mean the
      // writing path never took the lock, and the whole case would be
      // measuring nothing.
      const settledEarly = await Promise.race([
        Promise.allSettled(inFlight).then(() => 'settled' as const),
        new Promise<'still-blocked'>((resolve) => setTimeout(() => resolve('still-blocked'), 1_500)),
      ]);
      expect(settledEarly, 'the sends did not block on the held lock, so nothing was contended').toBe('still-blocked');

      await holder.query('COMMIT');
      responses = await Promise.all(inFlight);
    } finally {
      holder.release();
    }

    // ONE ROW.
    expect(await adjustmentRows(adjustmentId)).toBe(1);

    // ONE 201 AND NINE 200s — the contract, not "ten identical responses".
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);

    const created = must(responses.find((r) => r.status === 201));
    const replays = responses.filter((r) => r.status === 200);
    expect(replays).toHaveLength(9);
    expect(created.body.replayed).toBe(false);

    // FIELD BY FIELD EXCEPT `replayed`, in both directions: the same field
    // NAMES on both sides, so a replay that had dropped half the document
    // cannot pass.
    for (const [i, replay] of replays.entries()) {
      expect(replay.body.replayed, `replay ${i + 1}`).toBe(true);
      expect(Object.keys(replay.body).sort(), `replay ${i + 1} field names`).toEqual(Object.keys(created.body).sort());
      const { replayed: _r, ...restOfReplay } = replay.body as Record<string, unknown>;
      const { replayed: _c, ...restOfCreated } = created.body as Record<string, unknown>;
      expect(restOfReplay, `replay ${i + 1} body`).toEqual(restOfCreated);
    }
  }, 120_000);

  it('the same key with a different payload is refused, and writes nothing', async () => {
    const adjustmentId = randomUUID();
    const base = {
      adjustmentId,
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'first intent',
      lines: [{ productId: A.piece.productId, quantity: '2', unitCost: '13' }],
    };
    const first = await sendAdjustment(base);
    expect(first.status).toBe(201);

    // The same key, a different intent. The services compare a stored
    // `intentSha256` and raise `inventory.idempotency_conflict`, which
    // `apps/api/src/common/error.filter.ts` renders as 409.
    const conflicting = await sendAdjustment({
      ...base,
      lines: [{ productId: A.piece.productId, quantity: '99', unitCost: '13' }],
    });
    expect(conflicting.status).toBe(409);
    /*
     * TWO LAYERS, AND CI TAUGHT ME BOTH IN TURN.
     *
     * `GlobalExceptionFilter` wraps every refusal as
     * `{ error: { code, message, requestId, details } }`, where `code` is the
     * GENERIC `ApiErrorCode` — here `CONFLICT` — and the DOMAIN code travels in
     * `details.inventoryCode`. So:
     *
     *   body.code                        -> undefined   (first attempt)
     *   body.error.code                  -> 'CONFLICT'  (second attempt)
     *   body.error.details.inventoryCode -> the real one
     *
     * Five assertions in `tests/integration/inventory-configuration.test.ts`
     * already read that third form. Both wrong guesses failed loudly rather
     * than passing, which is the only reason this is a corrected test and not
     * a false green.
     */
    expect(conflicting.body.error.code).toBe('CONFLICT');
    expect(conflicting.body.error.details.inventoryCode).toBe('inventory.idempotency_conflict');

    // And still exactly one row: a refusal writes nothing.
    expect(await adjustmentRows(adjustmentId)).toBe(1);
  }, 120_000);

  /**
   * CLOCK IMMUNITY, with the ordering control the criterion needs.
   *
   * "Advancing the clock changed no amount" is satisfied by a server that
   * derives nothing from any clock, so the positive control comes first: the
   * row carries a server-side order, and that order is read and asserted to
   * exist. Only then is the device clock moved a year, which here means the
   * client sending `occurredOn` a year ahead — the one date a device controls —
   * and the stored amounts are compared.
   */
  it('a device date a year ahead changes no amount anywhere', async () => {
    const amountsFor = async (adjustmentId: string): Promise<readonly string[]> => {
      const r = await ownerPool().query<{ v: string }>(
        `SELECT total_value_base_minor::text AS v
           FROM inventory_adjustments
          WHERE business_id = $1 AND id = $2`,
        [A.businessId, adjustmentId],
      );
      return r.rows.map((row) => row.v);
    };

    const line = { productId: A.piece.productId, quantity: '2', unitCost: '13' };
    const now = randomUUID();
    const atNow = await sendAdjustment({
      adjustmentId: now,
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'today',
      lines: [line],
    });
    expect(atNow.status).toBe(201);

    // POSITIVE CONTROL on the ordering: the server stamps its own sequence, so
    // there IS an order for the clock to have failed to disturb.
    const ordered = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_adjustments
        WHERE business_id = $1 AND created_at IS NOT NULL`,
      [A.businessId],
    );
    expect(Number(must(ordered.rows[0]).n)).toBeGreaterThan(0);

    const aYearAhead = new Date(Date.parse(`${day}T00:00:00Z`) + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(aYearAhead).not.toBe(day); // the jump really happened

    const later = randomUUID();
    const atFuture = await sendAdjustment({
      adjustmentId: later,
      warehouseId: A.w1,
      occurredOn: aYearAhead,
      reason: 'a year ahead',
      lines: [line],
    });

    // Either the future date is refused outright, or it is accepted and the
    // amount is identical. What must NOT happen is an accepted document whose
    // value moved because the date did.
    if (atFuture.status === 201) {
      expect(await amountsFor(later)).toEqual(await amountsFor(now));
    } else {
      expect(atFuture.status).toBeGreaterThanOrEqual(400);
      expect(await adjustmentRows(later)).toBe(0);
    }

    // And the first document's amount is untouched by any of it.
    expect(await amountsFor(now)).toHaveLength(1);
  }, 120_000);
});
