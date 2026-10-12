/**
 * P4-S7 — THE `installment.*` RENDERING CONTRACT, DRIVEN THROUGH THE REAL
 * `GlobalExceptionFilter` (`TL-P4-COORD-R50` ordered item 7).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Round 11 found and fixed a LIVE PRODUCT DEFECT: before it, no
 * `installment.*` refusal name was registered in the API at all, so every one
 * of them — including the ones
 * `GET /v1/customers/:customerId/receivable/aging` raises through
 * `customer_ar_aging`, a read with no authorization question in it — fell
 * through to `403 FORBIDDEN / Access denied`. A merchant hitting a
 * data-integrity refusal was told they lacked permission.
 *
 * The fix is real: `INSTALLMENT_INTERNAL_INVARIANTS` as a `Set` in
 * `apps/api/src/modules/selling/selling-errors.ts`, consulted by
 * `GlobalExceptionFilter` before the historical `P0001` fallback. AND NO TEST
 * IN THE TREE DROVE AN `installment.*` CODE THROUGH THAT FILTER — the
 * round-11 challenger established that by grep and supplied the measurement
 * from its own worktree, which is not the tree. So the only live-product fix
 * of twelve rounds was UNTESTED. This file is that test.
 *
 * ── THE CONTRACT, WRITTEN OUT AND NOT IMPORTED ────────────────────────────
 *
 * The declared contract is `500 INTERNAL_ERROR` with the generic body and the
 * code in the log: «an internal invariant failure is not an authorization
 * denial». The expected set is WRITTEN OUT below rather than read from
 * `INSTALLMENT_INTERNAL_INVARIANT_CODES`, because a test that imports the
 * table it is checking agrees with any edit to that table, including a wrong
 * one — the idiom `tests/integration/sale-s2-error-contract.test.ts` states
 * for the `selling.*` set. The exported list is then compared against this
 * one, in both directions, so an addition that nobody classified reds here.
 *
 * ── AND THE REGRESSION, WHICH IS HALF THE VALUE ───────────────────────────
 *
 * The branch was added BEFORE the historical `P0001` fallback and deliberately
 * changed nothing about it. So this file also pins what must NOT have moved:
 * an UNKNOWN `P0001` is still `403`, an UNREGISTERED `installment.*` (the
 * migration-time end-state names of the same prefix) is still `403`, and
 * `42501` is still `403`. A registry that silently became a prefix test would
 * pass the positive half of this file and fail the negative half.
 *
 * Nothing here touches a database. The subject is a pure rendering.
 */
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';
import type { Logger } from '../../apps/api/src/infra/logger';
import { INSTALLMENT_INTERNAL_INVARIANT_CODES, isInstallmentInternalInvariant } from '../../apps/api/src/modules/selling/selling-errors';

interface Rendered {
  readonly status: number;
  readonly payload: { error: { code: string; message: string; requestId: string; details?: Record<string, unknown> } };
  readonly logged: readonly { readonly fields: Record<string, unknown>; readonly message: string }[];
}

/**
 * `exception` through the PRODUCTION filter with a real `ArgumentsHost`, as
 * the status, the body and the log it produced. The response double
 * implements the three methods the filter calls and nothing else, so a filter
 * that started calling a fourth one reds here rather than silently taking a
 * different path.
 */
function render(exception: unknown): Rendered {
  let status = 0;
  let payload: Rendered['payload'] | undefined;
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value as Rendered['payload'];
      return this;
    },
    setHeader(): void {},
  };
  const host = { switchToHttp: () => ({ getResponse: <T>(): T => res as unknown as T }) } as unknown as ArgumentsHost;
  const logger = {
    error: (fields: unknown, message?: unknown): void => {
      logged.push({ fields: (fields ?? {}) as Record<string, unknown>, message: String(message ?? '') });
    },
    warn: (): void => {},
    info: (): void => {},
    debug: (): void => {},
  } as unknown as Logger;
  new GlobalExceptionFilter(logger).catch(exception, host);
  if (payload === undefined) throw new Error('the filter rendered no body');
  return { status, payload, logged };
}

/** A PostgreSQL error as `pg` delivers one: the SQLSTATE on `code`, the routine's text on `message`. */
function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error & { code: string } {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...extra }) as Error & { code: string };
}

/**
 * A refusal message shaped like the real ones: the code, a long sentence that
 * names a plan, an invoice, a business and a count, and the context frames
 * `pg` attaches. Nothing of it may reach the response body.
 */
const POISON = {
  business: '9f2b1c44-0000-4000-8000-aaaabbbbcccc',
  invoice: '262678ef-1111-4000-8000-ddddeeeeffff',
  frame: 'PL/pgSQL function installment_plan_fact_sync() line 118 at RAISE',
  sql: 'INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status) VALUES ($1,$2,$3,$4,$5,$6)',
} as const;

const refusal = (code: string): Error & { code: string } =>
  pgError(
    'P0001',
    `${code}: invoice ${POISON.business}/${POISON.invoice} carries 2 plans with status = 'active' at once\n` +
      `CONTEXT: ${POISON.frame}\nSTATEMENT: ${POISON.sql}`,
    { where: POISON.frame, internalQuery: POISON.sql, detail: `business ${POISON.business}` },
  );

/**
 * THE ELEVEN REGISTERED NAMES, WRITTEN OUT. Seven were registered in round 11;
 * `plan_active_unbounded` and `plan_fact_untrusted` joined them in the commit
 * that made them reachable (`TL-P4-COORD-R50` ordered items 1, 2 and 3), and
 * `plan_index_disagrees` and `plan_fact_unordered` in this one
 * (`TL-P4-COORD-R52` ordered items 1 and 2).
 */
const REGISTERED: readonly string[] = [
  'installment.plan_fact_unreadable',
  'installment.plan_fact_unflagged',
  'installment.plan_schedule_unreadable',
  'installment.schedule_incomplete',
  'installment.plan_fact_blind',
  'installment.plan_fact_desynchronised',
  'installment.plan_active_conflict',
  'installment.plan_active_unbounded',
  'installment.plan_fact_untrusted',
  // `TL-P4-COORD-R52` ordered items 1 and 2, registered in the same commit as
  // the constructions that raise them: an index present and not enforcing,
  // measured at runtime as a disagreement between two access paths over the
  // same rows; and a deferred fact verifier fired BEFORE the immediate writer,
  // which `SET CONSTRAINTS ALL IMMEDIATE` -- unprivileged SQL permitted to
  // both app roles -- produces. The second replaces a FALSE
  // `plan_fact_desynchronised` on a LAWFUL write.
  'installment.plan_index_disagrees',
  'installment.plan_fact_unordered',
];

/**
 * THE `installment.*` NAMES THAT ARE NOT REGISTERED AND MUST NOT BE. These
 * are the migration-time end-state assertions of the same prefix: they cannot
 * reach a response at all, and an entry for them would be a contract for a
 * refusal nobody has located. They are the subject of the prefix-test
 * regression.
 */
const UNREGISTERED: readonly string[] = [
  'installment.migration_end_state_invalid',
  'installment.authority_leak',
  'installment.derived_truth_stored',
  'installment.plan_fact_unwritable',
];

describe('P4-S7 the installment.* rendering contract', () => {
  it('the registry is exactly the nine names this file pins, in both directions', () => {
    expect([...INSTALLMENT_INTERNAL_INVARIANT_CODES].sort()).toStrictEqual([...REGISTERED].sort());
    for (const code of REGISTERED) expect(isInstallmentInternalInvariant(code), code).toBe(true);
    for (const code of UNREGISTERED) expect(isInstallmentInternalInvariant(code), code).toBe(false);
  });

  it('every registered installment.* code renders 500 INTERNAL_ERROR with the code in the log and nothing in the body', () => {
    for (const code of REGISTERED) {
      const r = render(refusal(code));
      expect(r.status, code).toBe(500);
      expect(r.payload.error.code, code).toBe('INTERNAL_ERROR');
      expect(r.payload.error.message, code).toBe('Internal error');
      expect(r.payload.error.details, code).toBeUndefined();
      // THE CODE IS IN THE LOG, exactly once, under the invariant field.
      const lines = r.logged.filter((l) => l.message === 'phase 4 installment invariant violated');
      expect(lines, code).toHaveLength(1);
      expect(lines[0]?.fields['invariant'], code).toBe(code);
      // AND NOTHING OF THE ROUTINE'S TEXT LEAVES THE PROCESS.
      const body = JSON.stringify(r.payload);
      for (const leak of [POISON.business, POISON.invoice, POISON.frame, POISON.sql, 'active', code]) {
        expect(body, `${code} leaked ${leak}`).not.toContain(leak);
      }
    }
  });

  it('REGRESSION: an unknown P0001, an unregistered installment.* and a 42501 are all still 403', () => {
    // The three things the round-11 branch was added BEFORE the historical
    // fallback in order NOT to change. A registry that became a prefix test
    // would pass the positive case above and fail this one.
    const unknown = render(pgError('P0001', 'some_other.invariant: a refusal nobody has classified'));
    expect(unknown.status).toBe(403);
    expect(unknown.payload.error.code).toBe('FORBIDDEN');
    expect(unknown.payload.error.message).toBe('Access denied');
    expect(unknown.logged).toHaveLength(0);

    for (const code of UNREGISTERED) {
      const r = render(refusal(code));
      expect(r.status, code).toBe(403);
      expect(r.payload.error.code, code).toBe('FORBIDDEN');
      expect(r.payload.error.message, code).toBe('Access denied');
      expect(r.logged, code).toHaveLength(0);
    }

    const denied = render(pgError('42501', 'new row violates row-level security policy "business_isolation_update" for table "invoices"'));
    expect(denied.status).toBe(403);
    expect(denied.payload.error.code).toBe('FORBIDDEN');
  });

  it('the code is taken from the START of the message and a mention elsewhere does not promote a 403 to a 500', () => {
    // `INSTALLMENT_INTERNAL_CODE_RE` is anchored at `^`. A message that merely
    // MENTIONS a registered name — which this slice's own refusals do, since
    // several of them name each other — must keep the rendering of whatever
    // code it actually carries. Otherwise the registry would be satisfied by
    // prose, which is the `prosrc LIKE` defect in a different module.
    const mentions = render(pgError('P0001', 'some_other.invariant: see installment.plan_active_conflict for the related case'));
    expect(mentions.status).toBe(403);
    expect(mentions.logged).toHaveLength(0);
  });
});
