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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * THE THIRTEEN REGISTERED NAMES, WRITTEN OUT. Seven were registered in round
 * 11; `plan_active_unbounded` and `plan_fact_untrusted` joined them in the
 * commit that made them reachable (`TL-P4-COORD-R50` ordered items 1, 2 and
 * 3); `plan_index_disagrees` and `plan_fact_unordered` in round 13
 * (`TL-P4-COORD-R52` ordered items 1 and 2); and `plan_index_unenforcing` and
 * `plan_fact_unwritable` in this one (`TL-P4-COORD-R55` ordered items 2, 3
 * and 6).
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
  // `TL-P4-COORD-R55` ordered items 2, 3 and 6.
  //
  // `plan_index_unenforcing` is NEW CONSTRUCTION, registered in the same
  // commit as the three raises that produce it: an index of
  // `installment_plans` with `indisvalid`, `indisready` or `indislive` false,
  // READ OUT OF `pg_index` inside the failing event. It exists because one
  // catalogue flag on `installment_plans_pkey` made every lawful plan write
  // fail under `plan_fact_blind`, whose message had just been rewritten to
  // say the cause was row security and to look in `pg_policy` and NOT in
  // `pg_index`.
  //
  // `plan_fact_unwritable` IS A CORRECTION AND NOT AN ADDITION. It was pinned
  // in the list below, as UNREGISTERED, under the rationale «these are the
  // migration-time end-state assertions of the same prefix: they cannot reach
  // a response at all» — AND THAT RATIONALE IS FALSE OF IT. It is raised
  // TWICE from `installment_plan_fact_sync()`'s body, on the LIVE PLAN WRITE
  // PATH, inside a trigger a request fires, and the specification's own §7
  // declares its reachability OPEN rather than closed; round 12 reached one
  // of the two raises with a superuser `UPDATE installment_plans`. So this
  // file was pinning, as a contract, that a refusal from DATABASE MACHINERY
  // on the write path renders `403 FORBIDDEN / "Access denied"` to a
  // merchant — the exact inversion of the rule applied to its ten siblings,
  // and the same product-surface class as the live 403 bug `TL-P4-COORD-R49`
  // found and fixed. A contract test that encodes a false premise and passes
  // green is what these rounds exist to find.
  'installment.plan_index_unenforcing',
  'installment.plan_fact_unwritable',
];

/**
 * THE `installment.*` NAMES THAT ARE NOT REGISTERED AND MUST NOT BE, AND THE
 * RATIONALE IS NOW TRUE OF EVERY MEMBER (`TL-P4-COORD-R55` ordered item 6,
 * F13-6).
 *
 * EVERY RAISE OF EACH OF THESE THREE IS INSIDE THE SPECIFICATION'S OWN
 * `DO $end$` BLOCK, outside every `CREATE FUNCTION`, so each fires while the
 * migration runs, in a transaction no request is attached to: they cannot
 * reach a response at all. That is a property of WHERE THE RAISE IS, which is
 * checkable, and it is the only test this list applies.
 *
 * `installment.plan_fact_unwritable` WAS IN THIS LIST AND DID NOT SATISFY
 * THAT TEST: it is raised twice from a trigger function's body on the live
 * plan write path. It has moved to `REGISTERED` above, with the reasoning
 * there. The rule, stated once so a later author cannot re-derive the error:
 * a name belongs here when every RAISE of it is in the migration's `DO`
 * block, and «nobody has yet located a principal who reaches it» is a reason
 * to record the reachability as OPEN — which the specification's §7 does —
 * and never a reason to contract for the wrong rendering in the meantime.
 */
const UNREGISTERED: readonly string[] = ['installment.migration_end_state_invalid', 'installment.authority_leak', 'installment.derived_truth_stored'];

describe('P4-S7 the installment.* rendering contract', () => {
  it('the registry is exactly the thirteen names this file pins, in both directions', () => {
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
    // AND THE LIST'S OWN PREMISE IS CHECKED AGAINST THE SPECIFICATION RATHER
    // THAN ASSERTED IN THE COMMENT ABOVE IT (`TL-P4-COORD-R55` ordered item
    // 6, F13-6). A name belongs in `UNREGISTERED` only when EVERY raise of it
    // is inside the end-state `DO` block, and the previous list's fourth
    // member failed that test while the comment claimed it for all four. The
    // test is now executable: for each unregistered name, no `RAISE` of it
    // appears before the block begins.
    const spec = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');
    const beforeBlock = spec.slice(0, spec.indexOf('\nDO $end$'));
    expect(beforeBlock.length, 'the specification no longer carries an end-state block').toBeGreaterThan(1000);
    for (const code of UNREGISTERED) {
      expect(beforeBlock, `${code} is raised OUTSIDE the end-state block, so it can reach a response and must be registered`).not.toContain(
        `RAISE EXCEPTION '${code}:`,
      );
    }
    // ...and the converse, for the one this round moved: it really is raised
    // from a routine body on the write path, twice.
    expect((beforeBlock.match(/RAISE EXCEPTION 'installment\.plan_fact_unwritable:/g) ?? []).length).toBe(2);

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
