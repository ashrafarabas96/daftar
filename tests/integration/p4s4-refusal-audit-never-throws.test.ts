/**
 * P4-AL-48(a) — **A LOST REFUSAL AUDIT NEVER BECOMES A 500**, AND IT LEAVES A
 * TRACE.
 *
 * The Architecture Lock's clause reads: the refusal row is written on a
 * BEST-EFFORT basis; if its own transaction also fails, the merchant is still
 * answered with the refusal they earned, and the audit loss is reported to the
 * process log. «A refusal-audit failure may never be turned into a 500,
 * because a merchant told "internal error" for a `date_in_future` has been
 * given a worse answer than an un-audited refusal. Durability of a refusal
 * record is therefore HIGH, not ABSOLUTE.»
 *
 * **That clause had no test.** `tests/integration/p4s4-refusal-audit.test.ts`
 * proves the row is written when the write SUCCEEDS; nothing anywhere proved
 * what happens when it fails, which is precisely the half the lock makes a
 * promise about. A swallow nobody exercises is a swallow nobody knows is
 * there, and «HIGH, NOT ABSOLUTE» is only honest if the loss leaves a trace an
 * operator can find.
 *
 * ## The three things this suite asserts, in both arms
 *
 *   1. the caller still receives the ORIGINAL business refusal, with its
 *      original code and its original HTTP status;
 *   2. nothing throws out of `recordRefusal`;
 *   3. the loss is LOGGED, with the operation and the refusal code in the
 *      message — the trace without which the durability statement would be a
 *      claim about an invisible event.
 *
 * ## Why there are two arms, and what each one is for
 *
 * - **§A drives the failure into the audit transaction DIRECTLY**, with a
 *   `Database` whose `withTransaction` rejects. It is deterministic, it needs
 *   no cluster, and it is the arm that can assert `recordRefusal` itself
 *   returns normally — which no test that only looks at an HTTP response can
 *   do, because a response says what the route answered and not what the
 *   method returned.
 * - **§B drives a REAL database failure into a REAL refusal over real HTTP.**
 *   `INSERT ON audit_events` is revoked from `daftar_app` for the duration of
 *   one request, so `recordRefusal`'s own transaction is refused by PostgreSQL
 *   itself — `42501`, from the grant the audit row depends on (`0006:79`) —
 *   while the command's refusal is a genuine `pos.session_already_open` raised
 *   by `pos_till_session_open` (`0079:941`). A stub could not produce that:
 *   the point is that the SECOND transaction fails for a reason the first one
 *   knows nothing about.
 *
 * ## It is RED-CAPABLE, and that was measured rather than argued
 *
 * With the `catch` deleted from `AuditService.recordRefusal`, this suite goes
 * red in both arms: §A's `recordRefusal` rejects instead of returning, §A's
 * composer rejects with the pg error instead of the merchant's refusal, §B
 * answers 500 `INTERNAL_ERROR` instead of 409 `pos.session_already_open`, and
 * both log assertions fail because nothing is logged at all. The removal was
 * performed and the red observed before this file was committed.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '@daftar/domain-core';
import type { Database } from '../../apps/api/src/infra/database';
import { AuditService } from '../../apps/api/src/modules/audit/audit.service';
import { auditThenRethrowReceivablesRefusal } from '../../apps/api/src/modules/receivables/receivables-refusal-audit';
import { receivablesRefusal } from '../../apps/api/src/modules/receivables/receivables-errors';
import { auditThenRethrowSellingRefusal } from '../../apps/api/src/modules/selling/selling-refusal-audit';
import { sellingRefusal } from '../../apps/api/src/modules/selling/selling-errors';
import { asMember } from '../helpers/inventory-commands';
import { terminalCode } from '../helpers/pos-till-sessions';
import { seedCheckoutShop, type CheckoutShop } from '../helpers/till-checkout';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';

const CLAIM = 'a refusal audit that CANNOT be written still answers the merchant the refusal they earned, never throws, and leaves the loss in the log';

/** The membership a refused command ran under. Real ids are not needed by §A: the write never reaches the database. */
const SCOPE = { tenantId: randomUUID(), businessId: randomUUID(), userId: randomUUID() };

/** The message the failing audit transaction rejects with, so §A can tell its own failure from any other. */
const DRIVEN = 'the audit transaction was refused by this test';

/**
 * A `Database` whose every `withTransaction` rejects.
 *
 * It is the whole seam `recordRefusal` depends on, failed at the one point the
 * lock's clause is about — not a stubbed `AuditService`, which would have
 * tested the stub, and not a mocked logger-only path, which would have tested
 * nothing.
 */
const failingDatabase = {
  withTransaction: async (): Promise<never> => {
    throw new Error(DRIVEN);
  },
} as unknown as Database;

/** Every `Logger.error` message this process emitted while the spy was installed. */
let logged: string[] = [];

function spyOnErrorLog(): void {
  logged = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]): void => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe(`P4-AL-48(a) — ${CLAIM}`, () => {
  describe('§A — the audit transaction fails: `recordRefusal` swallows, logs, and returns', () => {
    const entry = {
      operation: 'customer.collect_payment',
      refusalCode: 'customer_payment.date_in_future',
      entity: 'payment',
      entityId: randomUUID(),
      actorUserId: SCOPE.userId,
      figures: { amountMinor: '1500' },
    };

    it('`recordRefusal` returns normally although its transaction threw', async () => {
      spyOnErrorLog();
      const audit = new AuditService(failingDatabase);
      // `.resolves` is the assertion and not a convenience: a rejected promise
      // here IS the clause being broken, and `await` alone would have thrown
      // the suite's own failure with a confusing message.
      await expect(audit.recordRefusal(SCOPE, entry)).resolves.toBeUndefined();
    });

    it('and the loss is logged with the operation AND the refusal code in the message', async () => {
      spyOnErrorLog();
      await new AuditService(failingDatabase).recordRefusal(SCOPE, entry);
      const loss = logged.filter((m) => m.includes('refusal audit lost'));
      expect(loss, `nothing was logged; the messages seen were: ${JSON.stringify(logged)}`).toHaveLength(1);
      // All three, because a trace that names the failure but not the command
      // it lost cannot be acted on: an operator needs to know WHICH refusal
      // went unrecorded, not merely that one did.
      expect(loss[0]).toContain(entry.operation);
      expect(loss[0]).toContain(entry.refusalCode);
      expect(loss[0]).toContain(DRIVEN);
    });

    it('the SELLING composer answers the original refusal, not the audit failure', async () => {
      spyOnErrorLog();
      const audit = new AuditService(failingDatabase);
      const refusal = sellingRefusal('pos.session_already_open');
      const thrown = await auditThenRethrowSellingRefusal(
        audit,
        SCOPE,
        { operation: 'pos.session_open', entity: 'pos_till_session', entityId: randomUUID(), figures: {} },
        refusal,
      ).catch((e: unknown) => e);
      // The SAME object, which is stronger than an equal one: it is what makes
      // "the audited code is the answered code" true by construction.
      expect(thrown).toBe(refusal);
      expect((thrown as AppError).httpStatus).toBe(409);
      expect((thrown as AppError).details?.['sellingCode']).toBe('pos.session_already_open');
      expect((thrown as AppError).message).not.toContain(DRIVEN);
      expect(logged.some((m) => m.includes('refusal audit lost') && m.includes('pos.session_already_open'))).toBe(true);
    });

    it('the RECEIVABLES composer answers the original refusal, not the audit failure', async () => {
      spyOnErrorLog();
      const audit = new AuditService(failingDatabase);
      const refusal = receivablesRefusal('customer_payment.date_in_future');
      const thrown = await auditThenRethrowReceivablesRefusal(
        audit,
        SCOPE,
        { operation: 'customer.collect_payment', entity: 'payment', entityId: randomUUID(), figures: {} },
        refusal,
      ).catch((e: unknown) => e);
      expect(thrown).toBe(refusal);
      expect((thrown as AppError).httpStatus).toBe(422);
      expect((thrown as AppError).details?.['receivablesCode']).toBe('customer_payment.date_in_future');
      expect((thrown as AppError).message).not.toContain(DRIVEN);
    });
  });

  describe('§B — PostgreSQL itself refuses the audit row, on a real refusal over real HTTP', () => {
    let t: TestApp;
    let shop: CheckoutShop;
    /** The second open, made while `daftar_app` could not insert an audit row. */
    let res: { status: number; body: unknown };
    let rowsAfter: number;
    let lostLog: string[] = [];

    beforeAll(async () => {
      await ensurePostgres();
      await resetData();
      t = await createTestApp();
      shop = await seedCheckoutShop(t, 'nothrow');

      // The audit row's only grant (`0006:79`). Revoked, `recordRefusal`'s own
      // transaction is refused by the database with `42501` — a real failure,
      // in the real second transaction, for a reason the first one cannot see.
      spyOnErrorLog();
      await ownerPool().query('REVOKE INSERT ON audit_events FROM daftar_app');
      try {
        // A second open till for the SAME user is `pos.session_already_open`,
        // raised by `pos_till_session_open` under its own advisory key
        // (`0079:941`) — a genuine routine-side refusal whose transaction has
        // already aborted by the time the audit is attempted.
        const r = await t.request
          .post('/v1/pos/till-sessions')
          .set(asMember(shop.cashier, shop.business.businessId))
          .send({
            sessionId: randomUUID(),
            branchId: shop.business.branchX,
            warehouseId: shop.business.w1,
            terminalCode: terminalCode('nothrow'),
            openingFloatMinor: '0',
          });
        res = { status: r.status, body: r.body };
      } finally {
        await ownerPool().query('GRANT INSERT ON audit_events TO daftar_app');
      }
      lostLog = logged.filter((m) => m.includes('refusal audit lost'));
      vi.restoreAllMocks();
      const counted = await ownerPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'pos.session_open.refused'`,
        [shop.business.businessId],
      );
      rowsAfter = counted.rows[0]?.n ?? 0;
    }, 300_000);

    afterAll(async () => {
      // Restored in the `finally` above as well; repeated here because a grant
      // left revoked would redden every later suite in the same cluster, and
      // `GRANT` is idempotent.
      await ownerPool()
        .query('GRANT INSERT ON audit_events TO daftar_app')
        .catch(() => undefined);
      await t?.close();
      await resetData();
    });

    it('the merchant got the refusal they earned, with its own code and status — never a 500', () => {
      const body = res.body as { error?: { code?: string; details?: { sellingCode?: string } } };
      expect(res.status, `the response was ${res.status} with ${JSON.stringify(res.body)}`).toBe(409);
      expect(body.error?.details?.sellingCode).toBe('pos.session_already_open');
      expect(body.error?.code).not.toBe('INTERNAL_ERROR');
    });

    it('no refusal row was written — so the response above was NOT the audit succeeding quietly', () => {
      // The control for the case above. Without it, a run in which the revoke
      // silently failed would look identical to a run in which the swallow
      // worked, and this suite would be green about nothing.
      expect(rowsAfter).toBe(0);
    });

    it('and the loss is in the log, naming the operation and the refusal code', () => {
      expect(lostLog, `the error log held: ${JSON.stringify(logged)}`).not.toEqual([]);
      expect(lostLog.some((m) => m.includes('pos.session_open') && m.includes('pos.session_already_open'))).toBe(true);
    });
  });
});
