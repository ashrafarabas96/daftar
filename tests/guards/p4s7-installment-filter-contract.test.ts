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
import {
  CONTENTION_SQLSTATE_CODES,
  INSTALLMENT_INTERNAL_INVARIANT_CODES,
  isInstallmentInternalInvariant,
  parseDatabaseContention,
} from '../../apps/api/src/modules/selling/selling-errors';

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

  /**
   * ── THE REFUSAL'S OWN SENTENCE REACHES AN OPERATOR, AND STILL NOT A CALLER
   *    (`TL-P4-COORD-R63` ordered item 4, F15-5) ─────────────────────────────
   *
   * Round 15 added an eleven-hundred-character two-cause remedy to
   * `installment.schedule_incomplete` — the two states that reach it, the
   * remedy of each, the data-modifying-CTE spelling — and the round-15
   * challenger measured that it reached NOBODY: the body is generic by
   * contract (correctly), and the log line carried `{ invariant }` alone, so
   * the text was visible only to someone holding a psql session. «A
   * declaration whose reader can do nothing is worse than no declaration.»
   *
   * The repair is one field on the log line, and this case pins BOTH halves of
   * it, because the half that is easy to lose is the second: the sentence is
   * an INTERNAL one, and an internal sentence in a response body is the leak
   * class the `40P01` rendering one file away was careful about.
   */
  it('the refusal SENTENCE is logged beside the invariant name, and still reaches no response body', () => {
    // THE REAL SHAPE: the two-cause remedy as the specification writes it,
    // read OUT OF THE SPECIFICATION rather than retyped, so this case cannot
    // pass against a sentence that no longer ships. The remedy is one SQL
    // string literal; `''` is SQL's escape for an apostrophe inside it.
    const spec = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');
    const open = spec.indexOf(
      "RAISE EXCEPTION 'installment.schedule_incomplete: (a) the schedule sums to % and the invoice total is %, and this plan carries NO",
    );
    expect(open, 'the two-cause remedy is no longer in the specification').toBeGreaterThan(-1);
    // The literal ends at the FIRST `',` that closes it — `''` is an escaped
    // apostrophe inside it and never a terminator, so the terminator is looked
    // for as the quote-comma-newline the statement actually ends its message
    // argument with.
    const close = spec.indexOf("',\n", open);
    expect(close, 'the two-cause remedy literal is unterminated').toBeGreaterThan(open);
    const sentence = spec.slice(spec.indexOf("'", open) + 1, close).replace(/''/g, "'");
    expect(sentence.length, 'the sliced remedy is too short to be the two-cause message').toBeGreaterThan(800);
    for (const phrase of ['TWO STATES REACH THIS', 'SET CONSTRAINTS ALL IMMEDIATE', 'data-modifying CTE', 'NO instalment row at all']) {
      expect(sentence, `the sliced remedy does not contain ${phrase}`).toContain(phrase);
    }

    // AS `pg` DELIVERS IT: the SQLSTATE on `code`, the routine's primary
    // message on `message`, and the frames on their own fields.
    const r = render(pgError('P0001', sentence, { where: POISON.frame, internalQuery: POISON.sql }));

    // (1) THE LOG CARRIES THE NAME **AND** THE SENTENCE. Before this round the
    //     second assertion failed: the field did not exist.
    const lines = r.logged.filter((l) => l.message === 'phase 4 installment invariant violated');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields['invariant']).toBe('installment.schedule_incomplete');
    expect(String(lines[0]?.fields['refusal'])).toBe(sentence);
    for (const phrase of ['TWO STATES REACH THIS', 'data-modifying CTE', 'SET CONSTRAINTS ALL IMMEDIATE']) {
      expect(String(lines[0]?.fields['refusal']), `the remedy's «${phrase}» did not reach the log`).toContain(phrase);
    }

    // (2) AND THE BODY IS UNTOUCHED — 500, generic, no `details`, and not one
    //     word of the sentence, the frames or the SQL.
    expect(r.status).toBe(500);
    expect(r.payload.error.code).toBe('INTERNAL_ERROR');
    expect(r.payload.error.message).toBe('Internal error');
    expect(r.payload.error.details).toBeUndefined();
    const body = JSON.stringify(r.payload);
    for (const leak of ['TWO STATES REACH THIS', 'data-modifying CTE', 'SET CONSTRAINTS', 'installment.schedule_incomplete', POISON.frame, POISON.sql]) {
      expect(body, `the body leaked ${leak}`).not.toContain(leak);
    }

    // (3) THE FRAMES DO NOT JOIN THE LOG LINE EITHER. `pg` puts `CONTEXT:` and
    //     `STATEMENT:` on `where`/`internalQuery`, but a caller that
    //     concatenated them into `message` must not push SQL into the log, so
    //     only the FIRST LINE is taken — asserted against a message shaped
    //     exactly that way.
    const framed = render(refusal('installment.schedule_incomplete'));
    const framedLine = framed.logged.filter((l) => l.message === 'phase 4 installment invariant violated')[0];
    expect(String(framedLine?.fields['refusal'])).not.toContain(POISON.sql);
    expect(String(framedLine?.fields['refusal'])).not.toContain('CONTEXT:');
    expect(String(framedLine?.fields['refusal'])).toContain('installment.schedule_incomplete:');
    // NON-VACUITY: the fixture really does carry the frames that had to be cut.
    expect(refusal('installment.schedule_incomplete').message).toContain(POISON.sql);
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

  /**
   * ── THE TRANSACTION-MANAGER OUTCOMES STOP BEING AN UNNAMED 500
   *    (`TL-P4-COORD-R59` ordered item 2, F14-2) ──────────────────────────
   *
   * A `40P01` on ONE invoice from two ORDINARY operations was measured by the
   * round-14 challenger, and until this commit both `40001` and `40P01`
   * reached `GlobalExceptionFilter`'s last `unhandled error` branch: `500
   * INTERNAL_ERROR` with no code, no retry contract, and the whole `pg` error
   * object in the log. They are not invariant violations and are not in
   * either registry — section 3a-ter of the specification says so — so what
   * was owed was a RENDERING, not a registry entry.
   */
  it('a 40P01 and a 40001 render 409 CONFLICT with retryable:true, the SQLSTATE in the LOG and the server sentence nowhere', () => {
    // THE SERVER'S OWN SENTENCE, which names tuples, relations and the other
    // backend's process id. None of it may reach the body.
    const deadlock = pgError('40P01', 'deadlock detected', {
      detail:
        'Process 15141 waits for ShareLock on transaction 1234; blocked by process 15137. ' +
        'Process 15137 waits for ShareLock on transaction 1235; blocked by process 15141.',
      where: 'while deleting tuple (0,3) in relation "installment_plans"',
    });
    for (const [e, word] of [
      [deadlock, 'deadlock_detected'],
      [pgError('40001', 'could not serialize access due to concurrent update'), 'serialization_failure'],
    ] as const) {
      const r = render(e);
      expect(r.status, word).toBe(409);
      expect(r.payload.error.code, word).toBe('CONFLICT');
      expect(r.payload.error.details?.['contention'], word).toBe(word);
      expect(r.payload.error.details?.['retryable'], word).toBe(true);
      // THE SQLSTATE IS IN THE LOG AND NOT IN THE BODY, and the line says
      // contention rather than «unhandled error».
      const lines = r.logged.filter((l) => l.message === 'transaction contention');
      expect(lines, word).toHaveLength(1);
      expect(lines[0]?.fields['sqlstate'], word).toBe(e.code);
      expect(
        r.logged.some((l) => l.message === 'unhandled error'),
        word,
      ).toBe(false);
      const body = JSON.stringify(r.payload);
      for (const leak of ['40P01', '40001', '15141', 'installment_plans', 'ShareLock', 'serialize']) {
        expect(body, `${word} leaked ${leak}`).not.toContain(leak);
      }
    }
    // AND THE CLASSIFIER READS THE SQLSTATE AND NEVER THE MESSAGE, so a
    // refusal that merely MENTIONS a deadlock is not one.
    expect(parseDatabaseContention(pgError('P0001', 'installment.plan_active_conflict: see 40P01 for the related case'))).toBeNull();
    expect(parseDatabaseContention(new Error('deadlock detected'))).toBeNull();
    expect(parseDatabaseContention(pgError('23505', 'duplicate key value'))).toBeNull();
    expect([...CONTENTION_SQLSTATE_CODES].sort()).toStrictEqual(['40001', '40P01']);
    // NON-VACUITY, AND IT IS THE DEFECT ITSELF: on the branch that was there
    // before, a 40P01 was answered 500 with NO details at all. The two
    // assertions below are the ones that would fail if the branch were
    // removed again.
    const r = render(deadlock);
    expect(r.status, 'a contention outcome is rendered as an outage again').not.toBe(500);
    expect(r.payload.error.details, 'a contention outcome carries no retry contract again').toBeDefined();
    // ...and an UNCLASSIFIED SQLSTATE still falls to the unnamed 500, which is
    // the rendering this branch deliberately does NOT widen.
    const other = render(pgError('XX000', 'internal error'));
    expect(other.status).toBe(500);
    expect(other.payload.error.code).toBe('INTERNAL_ERROR');
    expect(other.logged.some((l) => l.message === 'unhandled error')).toBe(true);
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
