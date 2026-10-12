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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';
import type { Logger } from '../../apps/api/src/infra/logger';
import {
  CONTENTION_SQLSTATE_CODES,
  INSTALLMENT_INTERNAL_INVARIANT_CODES,
  INSTALLMENT_REMEDY_ANCHOR_IDS,
  INSTALLMENT_REMEDY_SPEC,
  installmentRemedyReference,
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
   * ── THE LOG CARRIES A NAME AND A STATIC REFERENCE, AND THE MESSAGE LEAVES
   *    THE PROCESS NOWHERE (`TL-P4-COORD-R69` §1 and ordered item 1, which
   *    NARROWS `TL-P4-COORD-R63` item 4, F15-5) ─────────────────────────────
   *
   * THE HISTORY, BECAUSE IT IS THE WHOLE POINT OF THE SHAPE OF THIS CASE.
   * `R63` item 4 found that round 15's two-cause remedy reached nobody: the
   * body is generic by contract and the log line carried `{ invariant }`
   * alone. Round 16 logged the refusal's FIRST LINE — and the first line IS
   * «the routine's message after the colon», which `error.filter.ts:151-153`
   * says never leaves the process, alongside SQL and AN AMOUNT. A log line
   * leaves the process. `R69` §1 refused the amendment and ordered the
   * narrowing: the log carries the invariant NAME and a STATIC remedy
   * REFERENCE, the dynamic message leaves in neither the body nor the log, and
   * the prose lives where the reference points.
   *
   * AND ROUND 16'S CASE WAS PINNED ON THE HALF THAT CANNOT FAIL. It chose
   * `installment.schedule_incomplete`'s two-cause sentence — the one
   * registered first line that carries NO identifier — and asserted the
   * sentence was PRESENT in the log. So the class that was actually leaking
   * (`business_id` plus an invoice or plan UUID) could not appear in its
   * fixture at all. This case therefore DERIVES, out of the specification,
   * which registered invariants substitute an identifier into their primary
   * message, and pins itself on one of THOSE — the subject is read, not
   * chosen.
   */
  it('the log carries the invariant NAME and a STATIC remedy reference, and the message and its identifiers leave the process in neither the log nor the body', () => {
    const spec = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');

    // ── (0) THE SUBJECT, DERIVED. Each `RAISE EXCEPTION` of this file is
    //    paired with ITS OWN ARGUMENT LIST — the text between the end of the
    //    message literal and `USING ERRCODE` — and a registered invariant is
    //    counted when one of its raises substitutes a business, invoice or
    //    plan key into the message. `''` is SQL's escaped apostrophe and never
    //    a terminator.
    const HEAD = "RAISE EXCEPTION '";
    const IDENT = /v_business|v_invoice|v_plan\b|NEW\.id|OLD\.id|NEW\.business_id/;
    const substituting = new Set<string>();
    for (let i = 0; ; ) {
      const a = spec.indexOf(HEAD, i);
      if (a < 0) break;
      const from = a + HEAD.length;
      let j = from;
      for (;;) {
        j = spec.indexOf("'", j);
        if (j < 0) break;
        if (spec.startsWith("''", j)) {
          j += 2;
          continue;
        }
        break;
      }
      if (j < 0) break;
      const message = spec.slice(from, j);
      const u = spec.indexOf('USING ERRCODE', j);
      const args = u > j && u - j < 3000 ? spec.slice(j, u) : '';
      const code = /^(installment\.[a-z_]+):/.exec(message)?.[1];
      if (code !== undefined && REGISTERED.includes(code) && IDENT.test(args)) substituting.add(code);
      i = j + 1;
    }
    const identifierBearing = [...substituting].sort();
    expect(identifierBearing.length, 'no registered invariant substitutes an identifier, so this case has no subject').toBeGreaterThan(0);

    // ── AND THE FILTER'S OWN COMMENT STATES THAT COUNT, so the sentence that
    //    justifies removing round 16's field is READ rather than believed.
    const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN'] as const;
    const word = (n: number): string => WORDS[n] ?? String(n);
    const filterSrc = readFileSync(join(__dirname, '..', '..', 'apps', 'api', 'src', 'common', 'error.filter.ts'), 'utf8')
      .replace(/^\s*\/\/ ?/gm, '')
      .replace(/\s+/g, ' ');
    expect(
      new RegExp(`${word(identifierBearing.length)} of the ${word(REGISTERED.length)} registered`, 'i').test(filterSrc),
      `the filter's comment does not state the derived count: ${word(identifierBearing.length)} of ${word(REGISTERED.length)}`,
    ).toBe(true);

    // ── (1) THE PINNED INVARIANT IS ONE THAT CAN EXHIBIT THE CLASS.
    const PINNED = 'installment.plan_index_unenforcing';
    expect(identifierBearing, `${PINNED} does not substitute an identifier, so it is the wrong subject for this case`).toContain(PINNED);

    // ── (2) RENDERED AS `pg` DELIVERS IT, with real keys and real amounts in
    //    the message and the frames on their own fields.
    const AMOUNT = '910000';
    const message =
      `${PINNED}: the schedule of plan ${POISON.business}/${POISON.invoice} does not satisfy obligation (a) to (c) AS THIS ROUTINE READ IT` +
      ` -- down payment plus schedule ${AMOUNT} against an invoice total of 100000 -- AND pg_index says these indexes are not enforcing:` +
      ' installment_plans_pkey on installment_plans (indisvalid=false, indisready=true, indislive=true). REINDEX the named indexes and retry';
    const r = render(pgError('P0001', message, { where: POISON.frame, internalQuery: POISON.sql }));
    const lines = r.logged.filter((l) => l.message === 'phase 4 installment invariant violated');
    expect(lines).toHaveLength(1);
    const fields = lines[0]?.fields ?? {};

    // ── (3) WHAT THE LOG CARRIES IS EXACTLY THREE FIELDS: the request id, the
    //    invariant NAME and the STATIC reference. The field set is pinned, so
    //    a fourth field carrying anything dynamic reds here.
    expect(Object.keys(fields).sort()).toStrictEqual(['invariant', 'remedy', 'requestId']);
    expect(fields['invariant']).toBe(PINNED);
    expect(fields['remedy']).toBe(installmentRemedyReference(PINNED));
    expect(String(fields['remedy'])).toContain(INSTALLMENT_REMEDY_SPEC);
    // ROUND 16'S FIELD IS GONE.
    expect(fields).not.toHaveProperty('refusal');

    // ── (4) THE HALF THAT CAN FAIL, SWEPT OVER **THE WHOLE LOG** AND NOT
    //    OVER ONE LINE OF IT (`TL-P4-COORD-R72` ordered item 1, F17-1).
    //
    //    ROUND 17 SCOPED THIS SWEEP TO `lines[0]`. The claim the filter and
    //    the specification both make is «THE DYNAMIC MESSAGE NOW LEAVES THE
    //    PROCESS IN NEITHER THE BODY NOR THE LOG» — a claim about the LOG —
    //    and the round-17 challenger planted round 16's own `refusal` value
    //    back under a SECOND log message and this case passed 6/6, exit 0.
    //    The shipped code was and is true of the claim; the instrument did
    //    not hold it, which is this phase's signature defect inside the
    //    repair ordered for that very shape. And it was held to a weaker
    //    standard than its own neighbour in this file: the `40P01` case reads
    //    `r.logged.some(…)` across the whole log for a second line.
    //
    //    So the subject is now `r.logged` ENTIRE — every line, under every
    //    message string, fields and message text alike.
    const LEAKS: readonly string[] = [
      POISON.business,
      POISON.invoice,
      POISON.frame,
      POISON.sql,
      AMOUNT,
      'the schedule of plan',
      'REINDEX the named indexes',
      'indisvalid=false',
      'CONTEXT:',
    ];
    /** Every artefact of `LEAKS` that appears anywhere in a rendered log. */
    const leaksIn = (logged: Rendered['logged']): readonly string[] => {
      const text = JSON.stringify(logged);
      return LEAKS.filter((leak) => text.includes(leak));
    };
    const body = JSON.stringify(r.payload);
    expect(leaksIn(r.logged), 'the LOG leaked one or more of the artefacts the rule forbids').toStrictEqual([]);
    for (const leak of LEAKS) {
      expect(body, `the BODY leaked ${leak}`).not.toContain(leak);
    }
    expect(body, 'the body leaked the invariant name').not.toContain(PINNED);
    // NON-VACUITY (a): the fixture really does carry every one of those.
    for (const present of [POISON.business, POISON.invoice, AMOUNT, 'the schedule of plan', 'indisvalid=false']) {
      expect(message, `the fixture does not contain ${present}, so the absence above proves nothing`).toContain(present);
    }
    // NON-VACUITY (b): THE WIDENED SWEEP REDS ON THE CHALLENGER'S OWN PLANT,
    //    executed here on every run rather than described. The plant is a
    //    SECOND `logger.error`, under a DIFFERENT message, carrying exactly
    //    what round 16 logged — `pg.message.split('\n')[0]`, which is the
    //    routine's message after the colon. The round-17 instrument could not
    //    see it because it serialised `lines[0]`; this one must name it.
    const plantedSecondLine: Rendered['logged'] = [
      ...r.logged,
      { fields: { requestId: 'req-1', detail: message.split('\n')[0] ?? '' }, message: 'installment invariant detail' },
    ];
    const found = leaksIn(plantedSecondLine);
    expect(found.length, 'the widened sweep does not see a second log line carrying the dynamic message').toBeGreaterThan(0);
    for (const named of [POISON.business, POISON.invoice, AMOUNT, 'the schedule of plan']) {
      expect(found, `the widened sweep missed ${named} on the planted second line`).toContain(named);
    }
    //
    //    AND THE ARM THAT DOES THE WORK IS `found.length > 0` IMMEDIATELY
    //    ABOVE, TOGETHER WITH THE FOUR NAMED ARTEFACTS. Round 18 wrote a
    //    further `expect` here, asserting that `LEAKS` filtered over
    //    `plantedSecondLine[0]` was empty, under a comment claiming that it
    //    was what made this arm a demonstration rather than a decoration.
    //    BOTH THE ASSERTION AND THAT SENTENCE ARE DELETED
    //    (`TL-P4-COORD-R74` §3 and ordered item 1, F18-1), because it could
    //    not fail: `plantedSecondLine[0]` is the SHIPPED line, and
    //    `leaksIn(r.logged)` at the top of this block has already asserted
    //    that line is clean — for an array of plain objects
    //    `JSON.stringify(arr)` contains `JSON.stringify(arr[0])`, so the
    //    passing sweep IMPLIES the deleted assertion. An assertion the
    //    fixture's own construction guarantees, under a comment claiming it
    //    demonstrates something, is this phase's tracked shape sitting inside
    //    the arm that was ordered to be a demonstration.
    //
    //    THE PROPERTY IT MEANT TO RECORD IS TRUE, AND IT IS A THEOREM OF THE
    //    OLD STRUCTURE RATHER THAN A MEASUREMENT, SO IT IS STATED AND NOT
    //    ASSERTED. Round 17's scope was `lines[0]` where `lines` is
    //    `r.logged` FILTERED on one message string. A plant placed under
    //    ANOTHER message can therefore never be the line that scope reads,
    //    and a plant placed under the SAME message still leaves the shipped
    //    line first — so NO index and NO re-filtering makes such an arm able
    //    to fail. `R74` §3 is where that reasoning is ruled on, and it is
    //    also why the round-18 challenger's proposed `[0]` → `[1]` was
    //    refused: `[1]` would assert that round 17 read a line its own filter
    //    excluded, which is false.
    //
    //    THAT ROUND 17'S SCOPE REALLY DID PASS THIS PLANT IS MEASURED, BUT
    //    NOT HERE AND NOT BY THIS SLICE'S AUTHOR: the round-17 challenger ran
    //    the round-17 guard against a filter carrying this exact second line
    //    and got **6 tests passed, exit 0** (`P4-S7-R17-CHALLENGE-7ee4668.md`,
    //    F17-1), and round 18 reproduced that plant at the same md5 and
    //    required this sweep to red on it. Those are the measurements; this
    //    paragraph is not one and does not claim to be.
    // ── AND THE BRANCH EMITS THAT ONE LINE AND NO OTHER. This is the BELT
    //    and it is deliberately asserted AFTER the sweep: the sweep is what
    //    `R72` ordered and the sweep is what must red first on a second line
    //    carrying the message, so a plant demonstrates the repair and not
    //    merely this pin. A second line that carried NOTHING dynamic would
    //    still be a finding, because the claim is about the log and not about
    //    one line of it.
    expect(r.logged, 'the branch emitted a log line besides the invariant line').toHaveLength(1);
    expect(r.status).toBe(500);
    expect(r.payload.error.code).toBe('INTERNAL_ERROR');
    expect(r.payload.error.message).toBe('Internal error');
    expect(r.payload.error.details).toBeUndefined();

    // ── (5) THE REFERENCE IS STATIC: the same invariant raised with DIFFERENT
    //    keys and different figures logs the IDENTICAL reference. A reference
    //    that varied with the row would be the leak in another costume.
    const second = render(
      pgError('P0001', `${PINNED}: the schedule of plan 11111111-2222-4000-8000-333333333333/44444444-5555-4000-8000-666666666666 reads 7 rows`),
    );
    const secondFields = second.logged.filter((l) => l.message === 'phase 4 installment invariant violated')[0]?.fields ?? {};
    expect(secondFields['remedy']).toBe(fields['remedy']);
    expect(JSON.stringify(secondFields)).not.toContain('11111111-2222-4000-8000-333333333333');

    // ── (6) AND THE REFERENCE RESOLVES. For EVERY registered invariant: a
    //    reference exists; its anchor occurs EXACTLY ONCE in the
    //    specification, in its bracketed defining form; that occurrence is
    //    inside section 3b; and the line it is on also names the invariant.
    //    A reference into prose nobody checked is the defect this estate
    //    rejects for, so the destination is read and not assumed.
    const s3b = spec.indexOf("-- ── 3b. THE OPERATOR'S REMEDY INDEX");
    expect(s3b, 'the specification carries no section 3b for the references to point at').toBeGreaterThan(-1);
    const s3bEnd = spec.indexOf('\n-- ── 4. WHAT THIS SPECIFICATION DELIBERATELY DOES NOT CREATE', s3b);
    expect(s3bEnd, 'section 3b is unterminated').toBeGreaterThan(s3b);
    const index3b = spec.slice(s3b, s3bEnd);
    const seen = new Set<string>();
    for (const code of REGISTERED) {
      const ref = installmentRemedyReference(code);
      expect(ref, `${code} has no remedy reference`).not.toBeNull();
      const anchor = String(ref).split('#')[1] ?? '';
      expect(anchor, `${code}'s reference carries no anchor`).toMatch(/^p4s7-remedy-\d\d$/);
      expect(seen.has(anchor), `${anchor} is the anchor of two invariants`).toBe(false);
      seen.add(anchor);
      const defining = `[${anchor}]`;
      expect(spec.split(defining).length - 1, `${defining} does not occur exactly once in the specification`).toBe(1);
      expect(index3b, `${defining} is not inside section 3b`).toContain(defining);
      const at = index3b.indexOf(defining);
      const line = index3b.slice(index3b.lastIndexOf('\n', at) + 1, index3b.indexOf('\n', at));
      expect(line, `${defining} is not on a line that names ${code}`).toContain(code);
    }
    expect(seen.size).toBe(REGISTERED.length);
    expect([...INSTALLMENT_REMEDY_ANCHOR_IDS].sort()).toStrictEqual([...seen].sort());

    // ── (7) AND THE PROSE IS ACTUALLY THERE — the thing `R63` item 4 wanted a
    //    reader to be able to DO. The entry the schedule_incomplete reference
    //    points at carries both causes and the CTE spelling, and it is the
    //    place the two-cause text now lives, since the message no longer
    //    reaches anybody outside the process.
    const scheduleAnchor = String(installmentRemedyReference('installment.schedule_incomplete')).split('#')[1] ?? '';
    const entryAt = index3b.indexOf(`[${scheduleAnchor}]`);
    const nextAt = index3b.indexOf('-- [p4s7-remedy-', entryAt + 1);
    // The comment frame is removed and the lines joined before anything is
    // matched, so no phrase of this law depends on where a sentence wraps in a
    // SQL comment.
    const entry = index3b
      .slice(entryAt, nextAt < 0 ? index3b.length : nextAt)
      .replace(/^-- ?/gm, '')
      .replace(/\s+/g, ' ');
    for (const phrase of ['TWO STATES REACH IT', 'DATA-MODIFYING CTE', 'SET CONSTRAINTS ALL IMMEDIATE', 'summing with `down_payment_minor`']) {
      expect(entry, `the remedy index entry for schedule_incomplete does not carry ${phrase}`).toContain(phrase);
    }
    // ...and it does NOT reach the caller, which the generic body above already
    // establishes for this refusal and which every registered code is held to
    // by the case before this one.
  });

  /**
   * ── THE CITATION OF THE LEAK RULE IS DERIVED, NOT TYPED
   *    (`TL-P4-COORD-R72` ordered item 2, F17-3) ────────────────────────────
   *
   * WHAT WENT WRONG. The estate's leak boundary lives in a comment of
   * `apps/api/src/common/error.filter.ts`, and `R63`, `R69` and `R71` all
   * cited it as `:148-152`. Round 17's own added `import` shifted the
   * paragraph down one line, so at that SHA `:148-152` ran from
   * «migration-time end-state assertions…» to «…a journal entry id,» — it
   * STOPPED ONE LINE SHORT OF «never leave the process», which is the
   * predicate: the citation clipped the only part of the sentence that
   * forbids anything. Round 17 wrote that stale range in five places.
   * `R72` §2 measures the correct range at `:151-153` and states the
   * principle: a citation that can drift is the same defect at one remove.
   *
   * SO THE RANGE IS DERIVED HERE AND COMPARED AGAINST WHAT THE FIVE SITES
   * SPELL. An edit anywhere above the rule reds this case rather than
   * silently making five comments point at the wrong lines. And because
   * offsets are a weaker handle than words, each site is also required to
   * cite the rule BY ITS TEXT — the artefact and the predicate — so a reader
   * who meets the citation after the line numbers have moved again still has
   * the sentence.
   *
   * THE PREMISE THIS LAW DEPENDS ON, NAMED: that the rule still SAYS what the
   * citations say it says. That is read, not assumed — the derived range must
   * itself contain the artefact and the predicate, so a rule quietly reworded
   * to drop «never leave the process» reds here too. The rule's own bytes are
   * not this round's to touch and are not touched.
   */
  it('the leak rule is cited by a DERIVED line range and by its text, in every place this slice cites it', () => {
    const REPO = join(__dirname, '..', '..');
    const FILTER = join(REPO, 'apps', 'api', 'src', 'common', 'error.filter.ts');
    const filterLines = readFileSync(FILTER, 'utf8').split('\n');

    // ── (1) THE RANGE, DERIVED. The rule is ONE SENTENCE spanning comment
    //    lines: it opens at «NO `details`. SQL, the» and closes at «never
    //    leave the process». Both ends are located by their own text.
    const opens = filterLines.findIndex((l) => /with NO `details`\. SQL, the\s*$/.test(l));
    expect(opens, 'the leak rule no longer opens with «with NO `details`. SQL, the»').toBeGreaterThan(-1);
    const closesAt = filterLines.findIndex((l, i) => i > opens && /never leave the process/.test(l));
    expect(closesAt, 'the leak rule no longer closes with «never leave the process»').toBeGreaterThan(opens);
    // Every line of the sentence is a comment line of one block — a sentence
    // that had code in the middle of it would not be one sentence.
    for (let i = opens; i <= closesAt; i += 1) {
      expect(filterLines[i]?.trimStart().startsWith('//'), `line ${String(i + 1)} of the leak rule is not a comment line`).toBe(true);
    }
    const derived = `${String(opens + 1)}-${String(closesAt + 1)}`;

    // ── (2) AND THE RULE STILL SAYS WHAT THE CITATIONS SAY IT SAYS. The
    //    premise is READ: the artefact the rule names, and the predicate that
    //    forbids it, must both be inside the derived range.
    const ruleText = filterLines
      .slice(opens, closesAt + 1)
      .join(' ')
      .replace(/\/\//g, ' ')
      .replace(/\s+/g, ' ');
    for (const phrase of ["routine's message after the colon", 'an amount', 'never leave the process']) {
      expect(ruleText.toLowerCase(), `the derived rule range does not contain «${phrase}»`).toContain(phrase.toLowerCase());
    }

    // ── (3) THE SUBJECT IS DISCOVERED, NOT ONLY PINNED
    //    (`TL-P4-COORD-R74` ordered item 2, F18-3) ─────────────────────────
    //
    //    ROUND 18 SCANNED FOUR PINNED FILES, and the round-18 challenger
    //    planted a full-spelling, WRONG-RANGE citation of the leak rule —
    //    quoting its words — in a FIFTH file outside that list, and this law
    //    stayed GREEN, exit 0. A pinned list cannot see a citation born
    //    outside it.
    //
    //    SO THE SET IS DISCOVERED BY THE RULE'S OWN WORDS: every text file
    //    under the repository roots below that carries «routine's message
    //    after the colon» is a site, because that is what citing this rule
    //    looks like. Measured at this SHA, the discovered set is exactly the
    //    four pinned files, so this costs nothing today and grows with the
    //    tree tomorrow.
    //
    //    AND THE PINNED LIST STAYS ALONGSIDE IT, for the reason round 18
    //    gave and `R74` §4 upholds: a purely discovered set shrinks to zero
    //    and passes. Every pinned site must still be discovered, so a pinned
    //    file that stops carrying the rule's words is a finding rather than a
    //    silent exit from the scan.
    //
    //    WHAT IS DELIBERATELY **NOT** SCANNED, because reddening it would be
    //    a worse defect than the one being closed: files that cite OTHER
    //    parts of `error.filter.ts`. The tree carries TEN such citations —
    //    `:68-80`, `:171-173`, `:112-115`, `:176-187`, `:37-39`, `:25-28`,
    //    `:38-40`, in `tests/security/**` and `docs/**` — and they are
    //    correct about their own subjects. A scan that required every
    //    `error.filter.ts:<range>` in the whole tree to equal the leak rule's
    //    range would red all ten (`R74` §4 refuses that framing, and so does
    //    this law). Those ten are a real and unguarded instance of the same
    //    class, raised by `R74` §5 to the owners of `tests/security/**` and
    //    the Phase 3 contracts. They are not this slice's and are not touched
    //    here.
    const PINNED_SITES: readonly string[] = [
      join(REPO, 'apps', 'api', 'src', 'common', 'error.filter.ts'),
      join(REPO, 'apps', 'api', 'src', 'modules', 'selling', 'selling-errors.ts'),
      join(REPO, 'tests', 'guards', 'p4s7-installment-filter-contract.test.ts'),
      join(REPO, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'),
    ];
    const ROOTS = ['apps', 'packages', 'tests', 'scripts', 'infrastructure', 'docs'] as const;
    const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', '.next']);
    const TEXT = /\.(ts|tsx|js|mjs|cjs|sql|md|json|ya?ml)$/;
    const walk = (dir: string, out: string[]): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile() && TEXT.test(e.name)) out.push(full);
      }
      return out;
    };
    const ARTEFACT = "routine's message after the colon";
    const PREDICATE = 'never leave the process';
    const candidates: string[] = [];
    for (const root of ROOTS) {
      const at = join(REPO, root);
      if (existsSync(at)) walk(at, candidates);
    }
    expect(candidates.length, 'the file walk found nothing, so this law has no subject').toBeGreaterThan(100);
    const discovered = candidates.filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(ARTEFACT)).sort();
    expect(discovered.length, 'no file in the tree carries the leak rule words, so this law has no subject').toBeGreaterThan(0);
    // EVERY PINNED SITE IS STILL DISCOVERED. A pinned file that stopped
    // quoting the rule would otherwise leave the scan silently.
    for (const site of PINNED_SITES) {
      expect(discovered, `${site} no longer carries the leak rule's own words`).toContain(site);
    }

    // ── AND EVERY CITATION IN THE DISCOVERED SET SPELLS THE DERIVED RANGE.
    let cited = 0;
    for (const site of discovered) {
      const text = readFileSync(site, 'utf8');
      const ranges = [...text.matchAll(/error\.filter\.ts:(\d+-\d+)/g)].map((m) => m[1] as string);
      for (const range of ranges) {
        expect(range, `${site} cites error.filter.ts:${range} where the rule is at :${derived}`).toBe(derived);
      }
      cited += ranges.length;
      // ...and the citation carries the rule's own words, not only its
      // offsets, for the reader who meets it after the next shift. The
      // ARTEFACT is what discovered the file; the PREDICATE is the half that
      // `:148-152` used to clip, so it is required of every site too.
      const flat = text.replace(/\s+/g, ' ').toLowerCase();
      expect(flat, `${site} quotes the rule's artefact but not its predicate`).toContain(PREDICATE);
    }
    for (const site of PINNED_SITES) {
      const ranges = [...readFileSync(site, 'utf8').matchAll(/error\.filter\.ts:(\d+-\d+)/g)];
      expect(ranges.length, `${site} no longer cites the leak rule at all`).toBeGreaterThan(0);
    }
    // THE FIVE CITATIONS `R72` §2 COUNTED, STILL FIVE: the specification
    // carries two of them. A citation deleted to make this law pass is a
    // finding, because the count is pinned — measured by the round-18
    // challenger's plant D, which converted one citation to the bare spelling
    // and reded here with «expected 4 to be 5», exit 1. So the bare-spelling
    // residue round 18 disclosed is CLOSED by this count, and the residue that
    // was open is the one item 2 closes above.
    expect(cited, 'the number of citations of the leak rule moved').toBe(5);

    // ── (4) WHAT THIS STILL DOES NOT CATCH, SO IT IS NOT TAKEN FOR MORE.
    //    The range scan matches the FULL spelling `error.filter.ts:<range>`;
    //    a bare `:<range>` with no file name is not a range this law checks,
    //    though converting an existing citation to that form reds on the
    //    pinned count. The discovery is by the ARTEFACT phrase, so a file
    //    that cited the rule by its PREDICATE alone, or by paraphrase, with a
    //    wrong range, would still be invisible — a smaller gap than round
    //    18's and a real one. And the walk covers the six repository roots
    //    named above: a citation written outside them is not seen.
    //    (The stale string `148-152` appears in this law's own narrative
    //    above, deliberately: the law may describe the defect it closes, and
    //    a `not.toContain` over the whole file would have been a test about
    //    this comment.)
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
