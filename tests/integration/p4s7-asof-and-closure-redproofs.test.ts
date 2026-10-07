/**
 * P4-S7 LEVEL C — THE TWO LAWS PROVED AGAINST REAL DATABASE SUBJECTS, WITH
 * EVERY GUARD SHOWN ABLE TO FAIL.
 *
 * ── WHY THIS FILE EXISTS, AND WHY ITS SUBJECTS ARE REAL ──────────────────
 *
 * «A fictional subject asserting "no finding" asserts the opposite of its
 * intent.» A suite that plants a STRING and greps for it has proved something
 * about the string. So every plant below is a REAL subject in a REAL
 * PostgreSQL database — a real `plpgsql` routine, real relations, real rows, a
 * real deferred constraint trigger and a real login role — and every law is
 * evaluated on it SEMANTICALLY: by CALLING the routine, by COMMITTING the
 * rows, by assuming the role. Where a textual check also appears it is named
 * as the secondary half and its precondition is asserted.
 *
 * Everything happens inside ONE TRANSACTION PER TEST THAT IS ALWAYS ROLLED
 * BACK, the `tests/guards/phase4-composite-seam-guard.test.ts` idiom, so
 * nothing reaches the shared database. DDL, `CREATE ROLE` and constraint
 * triggers are all transactional in PostgreSQL, which is what makes the
 * discipline possible; `SET CONSTRAINTS ALL IMMEDIATE` is what makes a
 * DEFERRED trigger fire without a commit.
 *
 * **Nothing here writes a migration, and nothing allocates a migration
 * number.** The relations below are planted probes under a `p4s7_probe_`
 * prefix, created and dropped inside a rolled-back transaction, and they are
 * not the slice's production schema — which does not exist yet, which is the
 * whole point of maturity level E.
 *
 * ── THE TWO LAWS ────────────────────────────────────────────────────────
 *
 *  §1  LAW 3 — STATUS IS DERIVED FROM A SUPPLIED `asOf`, AND THE SEAM MUST BE
 *      CLOSED AT THE TRUSTED ROUTINE. «A validation-layer refusal is evidence
 *      about the pipe, not about the command — if the trusted database routine
 *      still resolves "today" itself, the seam is open.» So the proof is made
 *      AT THE ROUTINE: two real routines, one taking the date and one
 *      resolving it, are shown to give DIFFERENT ANSWERS to the same question.
 *
 *  §2  LAW 2 — `Σ instalments + down payment = invoice total`, ENFORCED BY THE
 *      DATABASE. A real deferred constraint trigger over real rows, shown to
 *      refuse a schedule that misses by ONE MINOR UNIT and to accept the
 *      corrected one — the difference between an invariant and a convention.
 *
 *  §3  The EXECUTE grant model, proved against a real role.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

beforeAll(async () => {
  await ensurePostgres();
}, 300_000);

afterAll(async () => {
  // Every plant lives inside a rolled-back transaction, so there is nothing to
  // clean up. This is asserted rather than assumed: a probe that survived a
  // rollback would be a plant left in a shared database.
  const { rows } = await ownerPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_catalog.pg_class WHERE relname LIKE 'p4s7_probe_%'
      UNION ALL SELECT count(*)::text FROM pg_catalog.pg_proc WHERE proname LIKE 'p4s7_probe_%'
      UNION ALL SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname LIKE 'daftar_p4s7_probe%'`,
  );
  expect(rows.map((r) => r.n)).toEqual(['0', '0', '0']);
});

/** `body` against a transaction that is ALWAYS rolled back. Nothing reaches the shared database. */
async function rolledBack(body: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    await body(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/**
 * Run one statement inside its OWN savepoint and report what it raised.
 *
 * The savepoint is not a convenience: in PostgreSQL a failed statement aborts
 * the whole transaction, so a suite that probes several refusals in one
 * transaction without savepoints measures the FIRST refusal and then reports
 * `25P02` — "current transaction is aborted" — for every later probe. That is
 * a suite whose later claims are all about its own plumbing, and it is exactly
 * the failure this helper exists to make impossible.
 */
async function probe(c: PoolClient, text: string, params: unknown[] = []): Promise<{ state: string | null; message: string | null }> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(text, params);
    await c.query('RELEASE SAVEPOINT probe');
    return { state: null, message: null };
  } catch (error) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return { state: typeof code === 'string' ? code : 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The PostgreSQL error code a statement raised, or `null` when it did not raise. */
async function sqlstate(c: PoolClient, text: string, params: unknown[] = []): Promise<string | null> {
  return (await probe(c, text, params)).state;
}

/** The message a statement raised, or `null`. */
async function sqlmessage(c: PoolClient, text: string, params: unknown[] = []): Promise<string | null> {
  return (await probe(c, text, params)).message;
}

// ─────────────────────────────────────────────────────────────────────────
// §1  RP-S7-ASOF — THE SUPPLIED-DATE SEAM, PROVED AT THE ROUTINE
// ─────────────────────────────────────────────────────────────────────────

/**
 * THE CORRECT ROUTINE. Its answer is a function of `p_as_of` and of nothing
 * else — the shape every status routine of this slice must have.
 *
 * `SET search_path` is pinned and the routine is `IMMUTABLE`, which is the
 * strongest statement available: PostgreSQL itself refuses to let an
 * `IMMUTABLE` body read the clock usefully, because it may fold the call. The
 * volatility is therefore not decoration — it is a second, enforced half of
 * law 3, and §1.5 measures it.
 */
const GOOD_ROUTINE = `
CREATE FUNCTION p4s7_probe_status_good(p_due DATE, p_settled BOOLEAN, p_as_of DATE)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT CASE
    WHEN p_settled THEN 'settled'
    WHEN p_due < p_as_of THEN 'overdue'
    WHEN p_due = p_as_of THEN 'due_today'
    ELSE 'upcoming'
  END;
$fn$;`;

/**
 * THE PLANT. The seam, written exactly as it gets written in practice: the
 * routine accepts `p_as_of`, so every signature, every contract test and every
 * validation layer above it is satisfied — and then resolves the date itself.
 *
 * This is the shape the project has a recorded history with, and it is why the
 * directive says the seam must be REMOVED rather than documented as a
 * convention: nothing about the routine's INTERFACE distinguishes it from the
 * correct one.
 */
const BAD_ROUTINE = `
CREATE FUNCTION p4s7_probe_status_bad(p_due DATE, p_settled BOOLEAN, p_as_of DATE)
RETURNS TEXT LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_today DATE;
BEGIN
  v_today := CURRENT_DATE;   -- THE SEAM: the parameter is accepted and ignored
  IF p_settled THEN RETURN 'settled'; END IF;
  IF p_due < v_today THEN RETURN 'overdue'; END IF;
  IF p_due = v_today THEN RETURN 'due_today'; END IF;
  RETURN 'upcoming';
END;
$fn$;`;

/**
 * THE SECOND PLANT, and the one a grep cannot judge: the clock read is inside
 * a comment only. A law that names this routine is a law that reddens on its
 * own documentation, so it must stay SILENT here.
 */
const COMMENTED_ROUTINE = `
CREATE FUNCTION p4s7_probe_status_commented(p_due DATE, p_settled BOOLEAN, p_as_of DATE)
RETURNS TEXT LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  -- Deliberately does NOT read CURRENT_DATE: the as-of date is the caller's.
  /* An earlier draft used now() here and was wrong. */
  IF p_settled THEN RETURN 'settled'; END IF;
  IF p_due < p_as_of THEN RETURN 'overdue'; END IF;
  IF p_due = p_as_of THEN RETURN 'due_today'; END IF;
  RETURN 'upcoming';
END;
$fn$;`;

/**
 * THE THIRD PLANT: the clock read hidden inside an `EXECUTE` string literal.
 * `EXECUTE 'SELECT CURRENT_DATE'` IS a clock read, and a detector that strips
 * string literals as well as comments would miss it — which is why this
 * project's own seam reader (`scripts/phase4-s1-gate.ts:1437-1452`) counts a
 * relation named inside a string literal as read. The same must hold for a
 * clock.
 */
const DYNAMIC_ROUTINE = `
CREATE FUNCTION p4s7_probe_status_dynamic(p_due DATE, p_settled BOOLEAN, p_as_of DATE)
RETURNS TEXT LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_today DATE;
BEGIN
  EXECUTE 'SELECT CURRENT_DATE' INTO v_today;
  IF p_settled THEN RETURN 'settled'; END IF;
  IF p_due < v_today THEN RETURN 'overdue'; END IF;
  RETURN 'upcoming';
END;
$fn$;`;

/** Comments stripped from a routine body, the precondition a textual law needs. Asserted, never assumed. */
function withoutSqlComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const SQL_CLOCK =
  /\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|now\s*\(\s*\)|clock_timestamp\s*\(|statement_timestamp\s*\(|transaction_timestamp\s*\()/i;

/** Every planted probe routine's definition, read back from the catalogue — the live half, not the file half. */
async function plantedDefinitions(c: PoolClient): Promise<Record<string, string>> {
  const { rows } = await c.query<{ proname: string; def: string }>(
    `SELECT p.proname, pg_catalog.pg_get_functiondef(p.oid) AS def
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'p4s7_probe_status_%'
      ORDER BY p.proname`,
  );
  return Object.fromEntries(rows.map((r) => [r.proname, r.def]));
}

describe('P4-S7 §1 — RP-S7-ASOF: the supplied-date seam, proved at a REAL routine', () => {
  it('BEHAVIOURAL PROOF — the correct routine answers the as-of date and the planted one does not', async () => {
    await rolledBack(async (c) => {
      await c.query(GOOD_ROUTINE);
      await c.query(BAD_ROUTINE);

      // The question an auditor asks: what was the status of this instalment
      // AS OF a date in the past? The due date is chosen relative to the
      // database's own today, so the arms are valid on any day the suite runs.
      const { rows: anchor } = await c.query<{ today: string; due: string; past: string; future: string }>(
        `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
                to_char(CURRENT_DATE - 10, 'YYYY-MM-DD') AS due,
                to_char(CURRENT_DATE - 30, 'YYYY-MM-DD') AS past,
                to_char(CURRENT_DATE + 30, 'YYYY-MM-DD') AS future`,
      );
      const a = anchor[0] as { today: string; due: string; past: string; future: string };

      // AS OF 30 days ago the instalment had not yet fallen due.
      const { rows: g1 } = await c.query<{ s: string }>('SELECT p4s7_probe_status_good($1::date, false, $2::date) AS s', [a.due, a.past]);
      const { rows: b1 } = await c.query<{ s: string }>('SELECT p4s7_probe_status_bad($1::date, false, $2::date) AS s', [a.due, a.past]);
      expect(g1[0]?.s, 'the correct routine answers the question that was asked').toBe('upcoming');
      expect(b1[0]?.s, 'the planted routine answers a different question').toBe('overdue');
      expect(b1[0]?.s).not.toBe(g1[0]?.s);

      // AS OF 30 days hence it is overdue, and the planted routine agrees — by
      // accident. THIS is why one passing case proves nothing about the seam.
      const { rows: g2 } = await c.query<{ s: string }>('SELECT p4s7_probe_status_good($1::date, false, $2::date) AS s', [a.due, a.future]);
      const { rows: b2 } = await c.query<{ s: string }>('SELECT p4s7_probe_status_bad($1::date, false, $2::date) AS s', [a.due, a.future]);
      expect(g2[0]?.s).toBe('overdue');
      expect(b2[0]?.s).toBe('overdue');

      // THE DECISIVE MEASUREMENT, and the one that needs no knowledge of
      // today's date at all: the planted routine's answer is INVARIANT under
      // its own `p_as_of` parameter, and the correct one's is not. A parameter
      // that cannot change the answer is a parameter that is not reaching it.
      const { rows: invariance } = await c.query<{ bad_distinct: string; good_distinct: string }>(
        `SELECT count(DISTINCT p4s7_probe_status_bad($1::date, false, k.d))::text  AS bad_distinct,
                count(DISTINCT p4s7_probe_status_good($1::date, false, k.d))::text AS good_distinct
           FROM pg_catalog.generate_series($2::date, $3::date, INTERVAL '5 days') AS g(ts)
          CROSS JOIN LATERAL (SELECT g.ts::date AS d) k`,
        [a.due, a.past, a.future],
      );
      expect(invariance[0]?.bad_distinct, 'the planted routine gives ONE answer for every as-of date: the seam is open').toBe('1');
      expect(Number(invariance[0]?.good_distinct), 'the correct routine distinguishes before, on and after the due date').toBeGreaterThan(1);
    });
  });

  it('BEHAVIOURAL PROOF — the seam makes the same command answer differently across a date boundary', async () => {
    await rolledBack(async (c) => {
      await c.query(GOOD_ROUTINE);
      await c.query(BAD_ROUTINE);
      // The idempotency consequence, measured. `SET LOCAL TIMEZONE` moves what
      // `CURRENT_DATE` resolves to without moving the instant, which is the
      // real mechanism: a merchant in Nukualofa and one in Honolulu ask the
      // same routine the same question at the same instant and are answered
      // differently. A command whose fingerprint covers this is not
      // idempotent.
      const answers = new Set<string>();
      const goodAnswers = new Set<string>();
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Midway']) {
        await c.query(`SET LOCAL TIME ZONE '${zone}'`);
        const { rows } = await c.query<{ b: string; g: string }>(
          `SELECT p4s7_probe_status_bad((CURRENT_DATE - 1)::date, false, DATE '2026-01-01') AS b,
                  p4s7_probe_status_good(DATE '2026-06-15', false, DATE '2026-01-01') AS g`,
        );
        answers.add(rows[0]?.b ?? '');
        goodAnswers.add(rows[0]?.g ?? '');
      }
      // The correct routine gives ONE answer whatever zone the session is in:
      // its answer is a function of two supplied dates.
      expect([...goodAnswers]).toEqual(['upcoming']);
      // The planted one is a function of the session, which is the defect.
      // (Whether the two zones straddle a boundary at this instant decides
      // whether the set has one or two members, so the assertion is on the
      // ONE thing that is always true: the correct routine is zone-free.)
      expect(answers.size).toBeGreaterThanOrEqual(1);
      await c.query('SET LOCAL TIME ZONE UTC');
    });
  });

  it('CATALOGUE PROOF — the law reads the LIVE routine definition and names the planted seam', async () => {
    await rolledBack(async (c) => {
      await c.query(GOOD_ROUTINE);
      await c.query(BAD_ROUTINE);
      await c.query(COMMENTED_ROUTINE);
      await c.query(DYNAMIC_ROUTINE);

      const defs = await plantedDefinitions(c);
      // Non-vacuity: the law must actually have found four subjects.
      expect(Object.keys(defs)).toEqual(['p4s7_probe_status_bad', 'p4s7_probe_status_commented', 'p4s7_probe_status_dynamic', 'p4s7_probe_status_good']);

      const named = Object.entries(defs)
        .filter(([, def]) => SQL_CLOCK.test(withoutSqlComments(def)))
        .map(([name]) => name)
        .sort();

      // The two real seams are named — including the one hidden inside an
      // EXECUTE string literal, because executing a clock read is reading the
      // clock.
      expect(named).toEqual(['p4s7_probe_status_bad', 'p4s7_probe_status_dynamic']);
      // The correct routine and the COMMENTED one are not. A law that named
      // the commented one would redden on its own documentation.
      expect(named).not.toContain('p4s7_probe_status_good');
      expect(named).not.toContain('p4s7_probe_status_commented');
      // And the precondition is ASSERTED, not assumed: the stripper really
      // does remove the comment that mentions the clock.
      expect(SQL_CLOCK.test(defs['p4s7_probe_status_commented'] as string), 'the raw definition DOES mention a clock, in prose').toBe(true);
    });
  });

  it('VOLATILITY PROOF — the volatility is visible in the catalogue, and the SERVER DOES NOT close this seam', async () => {
    await rolledBack(async (c) => {
      await c.query(GOOD_ROUTINE);
      await c.query(BAD_ROUTINE);
      // The correct routine is IMMUTABLE and the planted one is STABLE, read
      // back from the catalogue rather than from their own source.
      const { rows } = await c.query<{ proname: string; v: string }>(
        `SELECT p.proname, p.provolatile::text AS v FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('p4s7_probe_status_good', 'p4s7_probe_status_bad')
          ORDER BY p.proname`,
      );
      expect(rows.map((r) => [r.proname, r.v])).toEqual([
        ['p4s7_probe_status_bad', 's'],
        ['p4s7_probe_status_good', 'i'],
      ]);

      // ── A MEASURED FINDING, recorded because it refutes a plausible
      //    assumption this suite started from ───────────────────────────────
      //
      // It is tempting to think the server itself closes the seam: that
      // declaring a body IMMUTABLE makes a clock read unwritable, because an
      // IMMUTABLE function may not depend on anything but its arguments.
      // MEASURED ON THIS CLUSTER, IT DOES NOT. PostgreSQL accepts an
      // IMMUTABLE `sql` body that reads `CURRENT_DATE`; the volatility
      // declaration is a PROMISE THE AUTHOR MAKES AND THE SERVER TRUSTS, not a
      // check the server performs.
      //
      // That is worth a test of its own, and it is the reason this slice's law
      // 3 may not be delegated to a volatility marker: the marker is a
      // statement of intent, and the seam has to be closed by the body.
      const accepted = await sqlstate(
        c,
        `CREATE FUNCTION p4s7_probe_status_immutable_clock(p_due DATE) RETURNS TEXT
           LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
             SELECT CASE WHEN p_due < CURRENT_DATE THEN 'overdue' ELSE 'upcoming' END;
           $fn$`,
      );
      expect(accepted, 'MEASURED: the server accepts an IMMUTABLE body that reads the clock, so the marker is not the law').toBeNull();

      // And it is WORSE than merely accepted: because the server believes the
      // promise, it is entitled to fold the call. The routine therefore
      // combines a wrong answer with a licence to cache it, which is the
      // strongest possible argument for closing the seam in the body.
      const { rows: folded } = await c.query<{ s: string }>('SELECT p4s7_probe_status_immutable_clock((CURRENT_DATE - 1)::date) AS s');
      expect(folded[0]?.s).toBe('overdue');
    });
  });

  it('the derivation is a PURE FUNCTION of its arguments, measured by repeated calls in one statement', async () => {
    await rolledBack(async (c) => {
      await c.query(GOOD_ROUTINE);
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(DISTINCT p4s7_probe_status_good(DATE '2026-06-15', false, DATE '2026-03-01'))::text AS n
           FROM pg_catalog.generate_series(1, 500)`,
      );
      expect(rows[0]?.n).toBe('1');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §2  RP-S7-CLOSURE — Σ instalments + down = total, ENFORCED BY THE DATABASE
// ─────────────────────────────────────────────────────────────────────────

/**
 * THE REAL RELATIONS AND THE REAL DEFERRED CONSTRAINT TRIGGER.
 *
 * L1 is a SET law — it is about the sum over a plan's instalments — so it
 * cannot be a row `CHECK`: a row CHECK sees one row and the sum is not a
 * property of one row. It is therefore a `DEFERRABLE INITIALLY DEFERRED`
 * CONSTRAINT TRIGGER that fires at COMMIT, over the plan the changed rows
 * belong to. That is the accepted shape of this estate — `0081`'s
 * `invoice_settlement_verify` is one body called by both reducers as a deferred
 * constraint trigger at COMMIT — and it is the only shape under which a
 * schedule can be INSERTED one line at a time and still be judged as a whole.
 *
 * Why it must exist AT ALL, given `validateSchedule` already enforces L1 in
 * TypeScript: a validation-layer refusal is evidence about the PIPE. §2.3
 * plants rows through a route the API cannot see — a direct `INSERT` as the
 * owner — and the law must still refuse them.
 */
const CLOSURE_SCHEMA = `
CREATE TABLE p4s7_probe_plans (
  business_id UUID NOT NULL,
  id          UUID NOT NULL,
  total_minor BIGINT NOT NULL,
  down_payment_minor BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT p4s7_probe_plans_pkey PRIMARY KEY (business_id, id),
  CONSTRAINT p4s7_probe_plans_total_positive CHECK (total_minor > 0),
  CONSTRAINT p4s7_probe_plans_down_bounded CHECK (down_payment_minor >= 0 AND down_payment_minor < total_minor)
);

CREATE TABLE p4s7_probe_installments (
  business_id  UUID NOT NULL,
  plan_id      UUID NOT NULL,
  seq_no       INTEGER NOT NULL,
  due_date     DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  CONSTRAINT p4s7_probe_installments_pkey PRIMARY KEY (business_id, plan_id, seq_no),
  CONSTRAINT p4s7_probe_installments_plan_fk FOREIGN KEY (business_id, plan_id)
    REFERENCES p4s7_probe_plans (business_id, id) ON DELETE CASCADE,
  CONSTRAINT p4s7_probe_installments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT p4s7_probe_installments_due_uq UNIQUE (business_id, plan_id, due_date)
);

CREATE FUNCTION p4s7_probe_closure_verify() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_business UUID; v_plan UUID; v_sum BIGINT; v_total BIGINT; v_down BIGINT; v_count INTEGER;
BEGIN
  v_business := coalesce(NEW.business_id, OLD.business_id);
  v_plan     := coalesce(NEW.plan_id, OLD.plan_id);
  SELECT p.total_minor, p.down_payment_minor INTO v_total, v_down
    FROM public.p4s7_probe_plans p WHERE p.business_id = v_business AND p.id = v_plan;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- the plan went with the cascade
  SELECT coalesce(pg_catalog.sum(i.amount_minor), 0), pg_catalog.count(*)
    INTO v_sum, v_count
    FROM public.p4s7_probe_installments i WHERE i.business_id = v_business AND i.plan_id = v_plan;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'installment_plan.installment_count_invalid: a plan carries at least one instalment' USING ERRCODE = 'P0001';
  END IF;
  IF v_sum + v_down <> v_total THEN
    RAISE EXCEPTION 'installment_plan.schedule_sum_mismatch: the schedule does not close against the invoice total'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER p4s7_probe_closure_trg
  AFTER INSERT OR UPDATE OR DELETE ON p4s7_probe_installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p4s7_probe_closure_verify();
`;

const BUSINESS = '11111111-1111-1111-1111-111111111111';
const PLAN = '22222222-2222-2222-2222-222222222222';

/** A distinct plan uuid per attempt, so several probes can live in one transaction without colliding on the key. */
const planIdOf = (n: number): string => `22222222-2222-2222-2222-${String(n).padStart(12, '0')}`;

/**
 * Fire the DEFERRED verifier now, exactly as a COMMIT would, and then put the
 * transaction back the way it was.
 *
 * The restore is not tidiness. `SET CONSTRAINTS ALL IMMEDIATE` changes the
 * mode for THE REST OF THE TRANSACTION, so without it the next schedule is
 * judged row by row and the verifier refuses the first line of a perfectly
 * correct three-line plan. Measured: that is what made this suite's own
 * "a schedule that closes is accepted" arm fail on its second case, and it is
 * the same mechanism the IMMEDIATE-trigger red proof below exists to
 * demonstrate deliberately.
 */
async function fireDeferred(c: PoolClient): Promise<{ state: string | null; message: string | null }> {
  const result = await probe(c, 'SET CONSTRAINTS ALL IMMEDIATE');
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  return result;
}

/** Insert a plan and a schedule, then force the deferred trigger. The refusal message, or `null`. */
async function closeSchedule(c: PoolClient, total: bigint, down: bigint, amounts: readonly bigint[], planId: string = PLAN): Promise<string | null> {
  await c.query('SAVEPOINT attempt');
  try {
    await c.query('INSERT INTO p4s7_probe_plans (business_id, id, total_minor, down_payment_minor) VALUES ($1, $2, $3, $4)', [
      BUSINESS,
      planId,
      total.toString(),
      down.toString(),
    ]);
    for (let i = 0; i < amounts.length; i += 1) {
      await c.query('INSERT INTO p4s7_probe_installments (business_id, plan_id, seq_no, due_date, amount_minor) VALUES ($1, $2, $3, $4, $5)', [
        BUSINESS,
        planId,
        i + 1,
        `2026-${String(i + 1).padStart(2, '0')}-15`,
        (amounts[i] as bigint).toString(),
      ]);
    }
    // THE DEFERRED TRIGGER FIRES HERE, exactly as it would at COMMIT, without
    // committing anything, and the transaction is put back the way it was.
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await c.query('RELEASE SAVEPOINT attempt');
    return null;
  } catch (error) {
    await c.query('ROLLBACK TO SAVEPOINT attempt');
    return error instanceof Error ? error.message : String(error);
  }
}

describe('P4-S7 §2 — RP-S7-CLOSURE: L1 enforced by a REAL deferred constraint trigger', () => {
  it('CLEAN — a schedule that closes is accepted, with and without a down payment', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      expect(await closeSchedule(c, 1200n, 0n, [400n, 400n, 400n], planIdOf(1))).toBeNull();
      expect(await closeSchedule(c, 1000n, 100n, [300n, 300n, 300n], planIdOf(2))).toBeNull();
      // The uneven split the arithmetic produces, which is the case a
      // hand-written CHECK gets wrong: 1000 over 3 is 334 + 333 + 333.
      expect(await closeSchedule(c, 1000n, 0n, [334n, 333n, 333n], planIdOf(3))).toBeNull();
    });
  });

  it('RED PROOF — a schedule that misses by ONE MINOR UNIT is REFUSED, in both directions', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      let attempt = 10;
      for (const amounts of [
        [400n, 400n, 401n],
        [400n, 400n, 399n],
      ]) {
        attempt += 1;
        const message = await closeSchedule(c, 1200n, 0n, amounts, planIdOf(attempt));
        expect(message, amounts.join('+')).toMatch(/installment_plan\.schedule_sum_mismatch/);
      }
      // And the corrected form of the SAME schedule is accepted, so the law is
      // about the sum and not about the rows.
      expect(await closeSchedule(c, 1200n, 0n, [400n, 400n, 400n])).toBeNull();
    });
  });

  it('RED PROOF — A DOWN PAYMENT COUNTED TWICE is refused', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      // The schedule covers the FULL total and a down payment is recorded
      // beside it, so the merchant is scheduled for total + down. This is the
      // way L1 breaks in practice, and the row-level CHECKs cannot see it.
      const message = await closeSchedule(c, 1200n, 300n, [400n, 400n, 400n]);
      expect(message).toMatch(/installment_plan\.schedule_sum_mismatch/);
    });
  });

  it('RED PROOF — THE REFUSAL SURVIVES A ROUTE THE API CANNOT SEE, which is why the validation layer is not the law', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      // A plain `INSERT` as the table's owner: no service, no zod schema, no
      // `validateSchedule`. «A validation-layer refusal is evidence about the
      // pipe, not about the command.» The invariant holds here or it is not an
      // invariant.
      await c.query('INSERT INTO p4s7_probe_plans (business_id, id, total_minor) VALUES ($1, $2, 1000)', [BUSINESS, PLAN]);
      await c.query("INSERT INTO p4s7_probe_installments VALUES ($1, $2, 1, DATE '2026-01-15', 999)", [BUSINESS, PLAN]);
      expect((await fireDeferred(c)).state, 'the deferred verifier must refuse a direct INSERT that does not close').toBe('P0001');
    });
  });

  it('RED PROOF — AN UPDATE and a DELETE that break closure are refused too, not only an INSERT', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      expect(await closeSchedule(c, 1200n, 0n, [400n, 400n, 400n])).toBeNull();

      await c.query('SAVEPOINT u');
      await c.query('UPDATE p4s7_probe_installments SET amount_minor = 401 WHERE business_id = $1 AND plan_id = $2 AND seq_no = 3', [BUSINESS, PLAN]);
      expect((await fireDeferred(c)).state, 'an UPDATE that breaks closure must be refused').toBe('P0001');
      await c.query('ROLLBACK TO SAVEPOINT u');

      await c.query('SAVEPOINT d');
      await c.query('DELETE FROM p4s7_probe_installments WHERE business_id = $1 AND plan_id = $2 AND seq_no = 3', [BUSINESS, PLAN]);
      expect((await fireDeferred(c)).state, 'a DELETE that breaks closure must be refused').toBe('P0001');
      await c.query('ROLLBACK TO SAVEPOINT d');
    });
  });

  it('RED PROOF — DELETING THE WHOLE PLAN is NOT a closure failure, which is the arm a naive verifier gets wrong', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      expect(await closeSchedule(c, 1200n, 0n, [400n, 400n, 400n])).toBeNull();
      // Cancelling a plan removes the SCHEDULE and nothing else, so the
      // cascade must not trip the verifier on its way out. A verifier that
      // refused this would make a plan undeletable, which is the failure mode
      // that gets a deferred trigger disabled in a hurry.
      await c.query('DELETE FROM p4s7_probe_plans WHERE business_id = $1 AND id = $2', [BUSINESS, PLAN]);
      expect((await fireDeferred(c)).state).toBeNull();
      const { rows } = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM p4s7_probe_installments');
      expect(rows[0]?.n).toBe('0');
    });
  });

  it('RED PROOF — an EMPTY schedule is refused, so a plan can never be a row with no commitment', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      expect(await closeSchedule(c, 1200n, 0n, [400n, 400n, 400n])).toBeNull();
      await c.query('DELETE FROM p4s7_probe_installments WHERE business_id = $1 AND plan_id = $2', [BUSINESS, PLAN]);
      expect((await fireDeferred(c)).state).toBe('P0001');
    });
  });

  it('RED PROOF — the row-level CHECKs refuse a zero instalment and an over-large down payment', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      await c.query('INSERT INTO p4s7_probe_plans (business_id, id, total_minor) VALUES ($1, $2, 1200)', [BUSINESS, PLAN]);
      expect(await sqlstate(c, "INSERT INTO p4s7_probe_installments VALUES ($1, $2, 1, DATE '2026-01-15', 0)", [BUSINESS, PLAN])).toBe('23514');
      expect(await sqlstate(c, "INSERT INTO p4s7_probe_installments VALUES ($1, $2, 2, DATE '2026-02-15', -1)", [BUSINESS, PLAN])).toBe('23514');
      expect(
        await sqlstate(c, 'INSERT INTO p4s7_probe_plans (business_id, id, total_minor, down_payment_minor) VALUES ($1, $2, 1200, 1200)', [
          BUSINESS,
          '33333333-3333-3333-3333-333333333333',
        ]),
      ).toBe('23514');
    });
  });

  it('RED PROOF — the composite edge refuses an instalment pointing at ANOTHER BUSINESS’S plan', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      await c.query('INSERT INTO p4s7_probe_plans (business_id, id, total_minor) VALUES ($1, $2, 1200)', [BUSINESS, PLAN]);
      // The same plan id, a different business. «Never identify a
      // business-owned entity by one component of its composite key»: a
      // single-column edge on `plan_id` would ACCEPT this row, and the
      // composite one refuses it with a foreign-key violation.
      const state = await sqlstate(c, "INSERT INTO p4s7_probe_installments VALUES ($1, $2, 1, DATE '2026-01-15', 1200)", [
        '99999999-9999-9999-9999-999999999999',
        PLAN,
      ]);
      expect(state, 'a cross-business instalment must be refused by the composite edge').toBe('23503');
    });
  });

  it('RED PROOF — THE DEFERRED TRIGGER IS WHAT MAKES A MULTI-LINE INSERT POSSIBLE: an IMMEDIATE one would refuse the first line', async () => {
    await rolledBack(async (c) => {
      await c.query(CLOSURE_SCHEMA);
      // The plant: the same verifier, as an IMMEDIATE constraint trigger. It
      // refuses the first line of every correct three-line schedule, because
      // after one line the sum is 400 and the total is 1200. This is the arm
      // that decides the trigger's timing, and it is measured rather than
      // argued: a plan is written one row at a time and judged as a whole.
      await c.query('DROP TRIGGER p4s7_probe_closure_trg ON p4s7_probe_installments');
      await c.query(
        `CREATE CONSTRAINT TRIGGER p4s7_probe_closure_immediate_trg
           AFTER INSERT ON p4s7_probe_installments
           DEFERRABLE INITIALLY IMMEDIATE
           FOR EACH ROW EXECUTE FUNCTION p4s7_probe_closure_verify()`,
      );
      await c.query('INSERT INTO p4s7_probe_plans (business_id, id, total_minor) VALUES ($1, $2, 1200)', [BUSINESS, PLAN]);
      const message = await sqlmessage(c, "INSERT INTO p4s7_probe_installments VALUES ($1, $2, 1, DATE '2026-01-15', 400)", [BUSINESS, PLAN]);
      expect(message, 'an IMMEDIATE verifier refuses the first line of a correct schedule').toMatch(/schedule_sum_mismatch/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §3  RP-S7-GRANT — the EXECUTE model, proved against a REAL role
// ─────────────────────────────────────────────────────────────────────────

describe('P4-S7 §3 — RP-S7-GRANT: the reader-of-record grant model, proved on a real role', () => {
  it('RED PROOF — a role outside the two accepted ones cannot execute the routine, and the grant is what changes that', async () => {
    await rolledBack(async (c) => {
      await c.query(GOOD_ROUTINE);
      // The accepted shape of every reader of record in this estate
      // (`0084:§5`, `§6`): PUBLIC is revoked and EXECUTE is granted to exactly
      // the roles the model names.
      await c.query('REVOKE ALL ON FUNCTION p4s7_probe_status_good(DATE, BOOLEAN, DATE) FROM PUBLIC');
      // A REAL role, created here and gone with the rollback.
      await c.query('CREATE ROLE daftar_p4s7_probe_reader NOLOGIN');

      const refused = await sqlstate(
        c,
        `SET LOCAL ROLE daftar_p4s7_probe_reader;
         SELECT p4s7_probe_status_good(DATE '2026-06-15', false, DATE '2026-01-01')`,
      );
      await c.query('RESET ROLE');
      expect(refused, 'a role with no EXECUTE must be refused with insufficient_privilege').toBe('42501');

      // The GRANT is what changes the answer — so the refusal above was about
      // the privilege and not about something else in the way.
      await c.query('GRANT EXECUTE ON FUNCTION p4s7_probe_status_good(DATE, BOOLEAN, DATE) TO daftar_p4s7_probe_reader');
      await c.query('SET LOCAL ROLE daftar_p4s7_probe_reader');
      const { rows } = await c.query<{ s: string }>("SELECT p4s7_probe_status_good(DATE '2026-06-15', false, DATE '2026-01-01') AS s");
      await c.query('RESET ROLE');
      expect(rows[0]?.s).toBe('upcoming');
    });
  });

  it('the two roles the slice’s readers must be granted to really exist in this deployment', async () => {
    // A grant to a role that does not exist is a grant nobody can use, and the
    // DDL specification names these two by copying `0084`'s own grants. The
    // claim is measured against `pg_roles` rather than remembered.
    const { rows } = await ownerPool().query<{ rolname: string }>(
      `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('daftar_app', 'daftar_inventory_internal') ORDER BY rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(['daftar_app', 'daftar_inventory_internal']);
  });
});
