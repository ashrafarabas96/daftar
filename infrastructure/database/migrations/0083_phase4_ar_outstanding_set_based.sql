-- 0083_phase4_ar_outstanding_set_based.sql
-- Phase 4 / P4-S4 CORRECTIVE — THE AR SUM BECOMES ONE PASS OVER THE
-- SETTLEMENT REDUCERS, GROUPED BY INVOICE, instead of one scalar function
-- invocation per open invoice. The arithmetic is NOT re-implemented: the
-- set-based form becomes THE ONE DEFINITION and the single-invoice
-- `invoice_outstanding(business, invoice)` is reduced to a thin wrapper over
-- it, so P4-AL-07 still has exactly one copy of the settlement arithmetic to
-- keep right.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080`, `0081` and `0082`
-- are CANDIDATE and are BYTE-FOR-BYTE UNTOUCHED: a defect in one of THOSE is
-- repaired by correcting FORWARD, which is the only manner open to them
-- (`0072` is the Phase 3 precedent; `0082` is this slice's own).
--
-- ── THIS FILE WAS LATER CORRECTED IN PLACE, UNDER A RULING ───────────────
--
-- Sections R-103 and R-104 below, and the three bodies they describe, are a
-- CORRECTION OF THIS FILE'S OWN TEXT rather than a further migration. The
-- P4-S4 corrective coordinator is the single migration owner of this slice
-- and ruled it so on two facts: `0083` is a CANDIDATE of this same slice,
-- written hours earlier, with NO CI EVIDENCE BOUND TO IT; and an `0084` that
-- replaced the three routines `0083` had just created would leave a history
-- in which the live definition of the AR sum can only be found by reading two
-- files that disagree. `0080`, `0081` and `0082` carry extensive green
-- evidence and are NOT eligible for the same treatment; `0000`-`0079` are
-- frozen byte-for-byte. `MIGRATION_MANIFEST.json` is untouched and
-- `frozenThrough` stays `0079`.
--
-- A DATABASE THAT ALREADY APPLIED THE EARLIER TEXT WILL REPORT «Migration
-- tampered after apply», AND THAT IS THE CORRECT REPORT. Such a database is
-- REBUILT. No `schema_migrations` row is edited to make a digest agree: that
-- row is the only record of what a database actually ran.
--
-- ── THE MEASURED DEFECT, AND THE THREE BUDGETS IT FAILS ──────────────────
--
-- Measured on PostgreSQL 16.13 — the deployment target — on a quiet box, 200
-- samples per arm, over the `D-SALES` fat-tail arm of
-- `tests/performance/receivables-s4-budgets.test.ts`:
--
--   P4-D  receivable read, fat-tail customer (2 000 open invoices)
--         ceiling 100 ms, measured p95 125.469 ms  FAIL
--         (107 of 200 samples above; min 92.667, p50 100.913, p99 151.784,
--          max 157.527)
--   P4-D  p95(fat-tail) <= 3 x p95(median)
--         measured 9.63x (125.469 / 13.027)        FAIL
--   P4-F  allocation over 5 invoices, in-transaction
--         ceiling 40 ms, measured p95 41.724 ms    FAIL
--
-- ONE root cause, and it was isolated rather than guessed: 56.3 microseconds
-- PER OPEN INVOICE over a 12.858 ms fixed cost — a linear model that
-- reproduces both percentiles to three decimals across a 667-fold row-count
-- range. The instrument counted `invoiceOutstandingCallsPerRead: 2000`, and
-- the plan of the failing read is `Sort -> Function Scan on
-- customer_ar_outstanding` with NO `invoices` node in it at all, because the
-- whole per-invoice cost is hidden inside a scalar call made once per invoice
-- by `customer_ar_outstanding`'s `JOIN LATERAL` (`0075:783`).
--
-- Three candidate causes were RULED OUT BY MEASUREMENT and are not addressed
-- here, because addressing them would be addressing nothing:
--
--   — NOT the statistics. The same read taken BEFORE the seed's `ANALYZE` was
--     116.147 ms, marginally FASTER than after it.
--   — NOT the row-security policy. The RLS cost between like and like is
--     1.691x, and with row security bypassed ENTIRELY the statement alone is
--     still 60.235 ms at 2 000 invoices — so no policy change can reach a
--     100 ms ceiling, and none is attempted.
--   — NOT the HTTP envelope. 23.626 ms, and it does not grow with the invoice
--     count.
--
-- To reach the 3x ratio the per-invoice cost would have to fall from 56.3 to
-- 12.9 microseconds (4.36x), or STOP BEING PER-INVOICE. This file does the
-- second thing.
--
-- ── R-98 WHY A PER-INVOICE CALL COSTS WHAT IT COSTS ──────────────────────
--
-- `invoice_outstanding` (`0081:1334`) is a `plpgsql` routine with a pinned
-- `search_path`. Per invoice it pays: one function invocation and plan cache
-- lookup, one index probe on `invoices` joined to `sales`, two index probes
-- on the two reducer relations, and the tuplestore round trip of a
-- set-returning function in a `LATERAL`. A function carrying a `SET` clause
-- cannot be inlined by PostgreSQL, so none of that is amortised across rows
-- — and the `SET` clause is a SECURITY CONTROL that is NOT being removed to
-- buy inlining. (It is also not removed quietly: an unpinned `search_path` on
-- a routine this file touches would be refused by
-- `scripts/guards/definer-search-path.ts` and by T-05, and it would be the
-- wrong trade in any case.)
--
-- The fix is therefore not to make the per-invoice call cheaper. It is to
-- make the READ ask its question ONCE: one aggregate over
-- `payment_allocations UNION ALL customer_credit_applications` restricted to
-- the invoices asked about, GROUPED BY invoice, joined ONCE to `invoices` and
-- its `sales` row. Work that was n function calls becomes one statement whose
-- cost is two index range scans and a hash aggregate.
--
-- ── R-99 ONE COPY OF THE ARITHMETIC, WHICH IS THE HARD CONSTRAINT ────────
--
-- P4-AL-07 is not satisfied by two implementations that agree today. So:
--
--   — `invoice_outstanding(UUID, UUID[])` — NEW, and the ONE definition. It
--     carries every rule the old body carried: the `invoice.not_found`
--     refusal, the draft/void zeros, `0080`'s cash-settled branch, the
--     `UNION ALL` over the reducer SET, and `paid_base` as the sum of the
--     CARRYING RELEASED rather than a conversion of the paid transaction
--     amount (so `outstanding_base` is exactly 0 when the last reducer closes
--     the invoice, per `0081`'s own note on the cumulative identity). Since
--     R-104 it also returns the `currency_code` and the `due_date` OF THE
--     INVOICE ROW IT ALREADY READ — passthrough, not arithmetic, and the
--     only reason either AR reader used to visit `invoices` a second time.
--   — `invoice_outstanding(UUID, UUID)` — REPLACED, and now a THIN WRAPPER:
--     one `RETURN QUERY` over the definition above with a one-element array.
--     It contains no arithmetic, no branch and no refusal of its own.
--   — `customer_ar_outstanding` and `customer_ar_aging` — REPLACED, and the
--     only change in either is that the `JOIN LATERAL ... ON TRUE` over one
--     invoice becomes ONE call over the customer's open invoices, from which
--     (R-104) they take the currency and the due date as well, so neither
--     joins `invoices` back onto that call and each names `invoices` exactly
--     ONCE. Their output columns, their `GROUP BY`, their
--     `HAVING sum(...) <> 0`, their bucket arithmetic and their refusal to
--     read the clock (P4-AL-30) are unchanged.
--   — `invoice_settlement_state` is NOT TOUCHED. It composes over the
--     single-invoice reader (`0075:760`) and inherits this change for free,
--     which is the whole value of the seam `0081` described.
--
-- The single-invoice path therefore gets no faster per call — it pays one
-- extra plpgsql frame and a one-element array. That is stated rather than
-- hidden, and it is measured: the P4-F arms are allocation commands whose
-- recompute-under-lock reads one invoice at a time (`0081:2086`), and the
-- evidence beside this file reports what happened to them.
--
-- ── R-100 THE ORDER OF THE TWO DEFINITIONS IS LOAD-BEARING ───────────────
--
-- Seam S-P4-03 (`scripts/phase4-s1-gate.ts`, `DEFERRED_SEAMS`) reads the LAST
-- Phase 4 definition of `invoice_outstanding` and requires it to name every
-- relation the Phase 4 DDL calls a settling one. The reducers are read by the
-- SET-BASED definition, so that definition is written LAST in this file and
-- the wrapper before it. A reader who reorders them closes nothing and turns
-- the seam red, which is the correct outcome: the seam asks which body
-- actually reads the reducers, and after this file that body is the array
-- one.
--
-- ── R-102 THE ONE COST OF AN OVERLOAD, STATED ────────────────────────────
--
-- `invoice_outstanding` now has TWO signatures of the same arity, so a call
-- whose BOTH arguments are of unknown type — `invoice_outstanding($1, $2)`
-- with no cast, or two bare string literals — is AMBIGUOUS and PostgreSQL
-- refuses it with `function invoice_outstanding(unknown, unknown) is not
-- unique`. A call with typed columns, typed plpgsql variables or an explicit
-- `::uuid` resolves exactly as before, which is every call site in the
-- application (`receivables-reads.ts`, `customer-reads.ts`,
-- `invoice-reads.ts`, `sale-reads.ts`) and every call inside `0081`'s own
-- routines.
--
-- Two TEST call sites passed bare parameters and are cast in the same diff.
-- The alternative — a differently NAMED set-based routine — was rejected: seam
-- S-P4-03 asks which body of `invoice_outstanding` reads the relations that
-- settle an invoice, and a rename would have meant answering that question by
-- editing the seam rather than by reading the reducers.

-- ── R-103 THE SECOND MEASURED DEFECT: THE FIXED COST OF ONE CALL ─────────
--
-- The reshaping above removed the per-invoice cost and brought the fat-tail
-- arm inside its ceiling. It ALSO MADE THE MEDIAN ARM SLOWER, and that is not
-- cosmetic. Measured on PostgreSQL 16.13 — the deployment target — 200
-- samples per arm, before and after this file on the same box in one session:
--
--   P4-D  receivable, fat-tail (2 000 open invoices)   126.092 -> 58.277 ms
--         ceiling 100 ms                                         now PASS
--   P4-D  receivable, MEDIAN customer (3 invoices)      14.179 -> 24.161 ms
--         no ceiling of its own
--   P4-D  p95(fat-tail) <= 3 x p95(median)               8.893x -> 2.412x
--         ceiling 3x                                              now PASS
--
-- SO THE RATIO PASSES PARTLY BECAUSE ITS DENOMINATOR INFLATED.
-- Counterfactually, 58.277 / 14.179 = 4.110x would STILL FAIL. The median
-- regression is therefore holding up an invariant rather than merely costing
-- ten milliseconds, and the Tech Lead chose to have it corrected before the
-- slice is sealed rather than after.
--
-- WHERE IT IS, which corrects the natural first guess. It is NOT the
-- single-invoice wrapper. The median arm is a CUSTOMER read: it reaches
-- `customer_ar_outstanding`, and after the reshaping that routine makes
-- exactly ONE call to the array form, with THREE ids. One array call over
-- three invoices cost more than the three `LATERAL` calls it replaced. The
-- subject is the array form's own FIXED cost, and the work the two AR readers
-- do AROUND it.
--
-- Read against each other, the post-reshaping median path pays three things
-- the pre-reshaping path did not:
--
--   (a) A SECOND VISIT TO `invoices`. The pre-reshaping reader drove FROM
--       `invoices` restricted by (business, customer, status) and took
--       `currency_code` and `due_date` off THAT VERY SCAN. The reshaped
--       reader collected the open invoice ids, handed them to the array form,
--       and then JOINED `public.invoices` BACK ONTO the function's output to
--       recover those same two columns — from the very rows the function had
--       just read. A set-returning function carrying a `SET` clause cannot be
--       inlined and this one declares no `ROWS`, so the planner estimates its
--       output at the default 1 000 rows and plans that join against an
--       estimate some three hundred times the median truth.
--   (b) AN EXTRA SCAN OF THE ARRAY ON EVERY CALL. The non-vacuity check ran
--       `SELECT count(*) FROM (SELECT DISTINCT unnest(p_invoice_ids))`
--       UNCONDITIONALLY, for a comparison that can only come out unequal when
--       an id is missing or repeated.
--   (c) ONE MORE PLANNED AND EXECUTED STATEMENT per call, which is what (b)
--       costs as seen from the plan cache rather than from the array.
--
-- (a) is the only one of the three that can plausibly cost MILLISECONDS; (b)
-- and (c) are microseconds each. That was the expectation, and it was then
-- MEASURED.
--
-- ── R-103-M WHAT THE MEASUREMENT FOUND ───────────────────────────────────
--
-- PostgreSQL 16.13 on 127.0.0.1:5432 — the deployment target, not an
-- embedded 18.4 cluster — over a population of one business, 2 003 invoices,
-- a 2 000-open-invoice fat-tail customer with 4 000 allocations and a
-- 3-open-invoice median customer, ANALYZEd. 200 samples per arm, one
-- session, as `daftar_app` with the request scope GUCs set and ROW SECURITY
-- APPLIED, which is the principal the product reads as.
--
-- THESE ARE STATEMENT FIGURES, NOT THE P4-D BUDGET. The budget is 200 HTTP
-- samples in `receivables-s4-budgets.test.ts` and is not restated here.
--
--   MEDIAN arm, the AR sum over 3 open invoices
--     with the re-join      (this file's first text)  p50 4.079  p95 4.517
--     without it            (this file's text)        p50 1.412  p95 1.796
--     ------------------------------------------------------------------
--     REMOVING THE RE-JOIN IS WORTH                   p50 2.667  p95 2.721
--
--   FAT-TAIL arm, the same sum over 2 000 open invoices
--     with the re-join                                p50 26.756 p95 31.814
--     without it                                      p50 23.443 p95 27.206
--     — so the fat tail gets FASTER too, and nothing regresses.
--
--   The non-vacuity check, isolated (the array form called directly with 3
--   ids, the corrected body against one identical but for running the
--   distinct count unconditionally):
--     unconditional                                   p50 1.098  p95 1.352
--     short-circuited                                 p50 1.026  p95 1.280
--     ------------------------------------------------------------------
--     THE SHORT CIRCUIT IS WORTH                      p50 0.072  p95 0.072
--
-- So (a) is ~97% of what this correction recovers and (b)+(c) are ~3%, which
-- is what was expected and is now measured rather than assumed. The ratio of
-- (a) to (b) is not a constant of nature: the re-join's cost is the cost of
-- scanning the BUSINESS'S WHOLE INVOICE SET, so it grows with that set while
-- the check does not.
--
-- THE PLAN, WHICH IS WHY (a) COSTS WHAT IT DOES. `EXPLAIN (ANALYZE, BUFFERS)`
-- of the median read with the re-join:
--
--   HashAggregate
--     InitPlan 1  -> Index Scan using invoices_customer_idx  (actual rows=3)
--     ->  Hash Join  (cost rows=1000)  (actual rows=3)
--           ->  Function Scan on invoice_outstanding  (est 1000, actual 3)
--           ->  Hash  ->  Seq Scan on invoices i  (actual rows=2003,
--                           Buffers: shared hit=294)
--
-- A FULL SEQUENTIAL SCAN OF EVERY INVOICE IN THE BUSINESS, hashed, on every
-- read of a three-invoice customer — to recover a currency code the function
-- had already read. Under row security the policy predicate is evaluated on
-- each of those rows, which is why the saving is 2.667 ms as `daftar_app`
-- and 0.574 ms as the owner with row security bypassed.
--
-- THE 1 000-ROW ESTIMATE IS STILL THERE AND NO `ROWS` CLAUSE IS ADDED. With
-- the join gone the same plan reads:
--
--   HashAggregate  (est 199 groups, actual 1)
--     ->  Function Scan on invoice_outstanding  (est 1000, actual 3)
--
-- The estimate is still 333x high at the median and 2x low at the fat tail,
-- and it no longer matters: there is nothing left for it to mis-JOIN. It
-- buys a 40 kB hash table instead of a smaller one, and the aggregate itself
-- measured ~0.02 ms above its input. A `ROWS` clause is NOT added — one
-- constant cannot be right for both arms, and the mis-estimate is now
-- costing nothing worth a declaration that would be wrong on one side.
--
-- ── R-104 THE SHAPE THAT REMOVES IT, STILL WITH ONE COPY ─────────────────
--
--   — The ONE DEFINITION now returns the invoice's own `currency_code` and
--     `due_date` BESIDE its four settlement figures. It already reads that
--     `invoices` row — it must, to know the total and the status — so the two
--     columns cost it NOTHING, and they are the only reason either AR reader
--     ever went back. THIS IS PASSTHROUGH, NOT ARITHMETIC: no settlement
--     figure is computed anywhere a second time, and P4-AL-07 still has
--     exactly ONE body that computes one, reached two ways.
--   — Both AR readers therefore LOSE THEIR `JOIN public.invoices` entirely.
--     Each now names `invoices` exactly ONCE, in the subquery that collects
--     the customer's open invoice ids — the same single index scan on
--     `invoices_customer_idx` (`0075:332`) the pre-reshaping reader made. The
--     output columns, the `GROUP BY`, the `HAVING sum(...) <> 0`, the bucket
--     arithmetic and the refusal to read the clock (P4-AL-30) are unchanged,
--     and `0083-E(3)` reads the absence of the join back from the catalogue
--     rather than from this file's own statements.
--   — The non-vacuity check KEEPS ITS MEANING and loses its cost in the
--     passing case. `ROW_COUNT` is one row per invoice FOUND, so it can never
--     exceed the number of DISTINCT ids asked about, which can never exceed
--     `cardinality(p_invoice_ids)`. Hence `ROW_COUNT = cardinality` forces all
--     three equal and NO refusal is possible — the distinct count is only
--     paid for when they differ, and then the comparison is the same
--     comparison against the same distinct count raising the same
--     `invoice.not_found`. An unknown id, another business's id, a dangling
--     sale, a repeated id, a NULL element, an empty array and a NULL array
--     all answer exactly what they answered before. That is proved case by
--     case against THE RULE rather than against the previous text, in
--     `tests/performance/receivables-ar-setbased-equivalence.test.ts`, because
--     the array form does not exist at `0082` and so has no before to compare
--     against.
--
-- WHAT R-103 DOES NOT DO EITHER. The wrapper is NOT made `LANGUAGE sql`,
-- which would have saved it one plpgsql frame and one tuplestore per
-- single-invoice call. R-100 is why: the array form must be the LAST
-- definition of `invoice_outstanding` in the Phase 4 DDL for seam S-P4-03 to
-- read it, an `sql` body resolves its callees at CREATE time, and a
-- `LANGUAGE sql` wrapper would therefore have to be written AFTER the
-- definition it calls — which is to say, last. A faster wrapper is not worth
-- answering the seam's question by editing the seam. Nor is the `SET` clause
-- unpinned to buy inlining (R-98 already refused that trade), nor is an index
-- added, nor is `plan_cache_mode` forced: a plan-cache knob is a measured
-- claim about replanning, and no such claim is made here.

-- ── R-101 WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────
--
--   — NO stored, cached, denormalised or materialised balance. Nothing here
--     writes a number anybody could later read instead of deriving it: there
--     is no second truth for a customer balance or an invoice outstanding,
--     and `tests/guards/phase4-derived-truth-guard.test.ts` and guard G-3 are
--     as red-capable over this tree as over the last one.
--   — NO index is added. The cost being removed is per-invoice FUNCTION
--     INVOCATION, not a lookup, and `payment_allocations_invoice_idx` /
--     `customer_credit_applications_invoice_idx` (`0081`) already serve the
--     one scan this file makes.
--   — NO `search_path` is unpinned, no routine changes its owner, its
--     volatility, its SECURITY INVOKER standing or its ACL. 0083-E compares
--     all five against a capture taken before the replacements.
--   — NO ceiling, budget or ratio is moved. Not one number.
--   — NO relation, column, trigger, policy, grant, source type or operation
--     kind is created, dropped or altered.
--   — It does not touch `invoice_settlement_verify`, the two commands, or any
--     accounting routine. The R-83 chain arithmetic is unaffected: this file
--     changes how the reducer rows are SUMMED FOR A READ, not what any writer
--     may write.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 0083-P: the head, the subject, and the pre-state capture.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_def TEXT;
BEGIN
  -- (1) THE HEAD IS 0082. The two reducer relations are there and so is the
  --     structural customer pin, which is what makes the join in the
  --     definition below total.
  IF to_regclass('public.payment_allocations') IS NULL OR to_regclass('public.customer_credit_applications') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0083 applies on the 0081 head or later, which creates the two settlement reducers'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'invoices_customer_uq' AND c.conrelid = 'public.invoices'::regclass AND c.contype = 'u') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0082''s invoices (business_id, id, customer_id) key is missing, so 0082 is not the head'
      USING ERRCODE = 'P0001';
  END IF;

  -- (2) THE SUBJECT IS PROVED PRESENT BEFORE IT IS CHANGED
  --     ([[daftar-a-green-gate-must-prove-it-can-be-red]]). The live
  --     single-invoice reader is `0081`'s — it reads both reducers and the
  --     settlement mode — and the live AR sum really does call it ONCE PER
  --     INVOICE through a `LATERAL`, which is the cost this file removes. A
  --     tree where either is already otherwise is a tree this file would be
  --     a no-op on.
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'));
  IF v_def NOT LIKE '%payment_allocations%' OR v_def NOT LIKE '%customer_credit_applications%' OR v_def NOT LIKE '%settlement_mode%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live invoice_outstanding is not the 0081 reader-of-record, so 0083 has no subject'
      USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.invoice_outstanding(UUID, UUID[])') IS NOT NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a set-based invoice_outstanding already exists, so 0083 has nothing to add'
      USING ERRCODE = 'P0001';
  END IF;
  FOR v_def IN
    SELECT pg_get_functiondef(f.oid)
      FROM (SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)') AS oid
            UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
  LOOP
    IF v_def NOT LIKE '%JOIN LATERAL public.invoice_outstanding(i.business_id, i.id)%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: an AR reader does not call invoice_outstanding once per invoice, so the per-invoice cost 0083 removes is not there to remove'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (3) PRE-STATE CAPTURE (the `0061:104-116` shape, as `0080` and `0081`
  --     took it). Owner, security, pinned path and ACL of each routine this
  --     file replaces, as one string per routine, transaction-local and
  --     compared in this same transaction's end state. A replacement is
  --     supposed to change the BODY and nothing else.
  PERFORM set_config('daftar.p4s4c_pre_readers',
    (SELECT pg_catalog.string_agg(
              format('%s=%s|%s|%s|%s', f.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                     coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-')),
              E'\n' ORDER BY f.oid::regprocedure::text)
       FROM (SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID)') AS oid
             UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
             UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
       JOIN pg_proc p ON p.oid = f.oid), true);
  -- And `invoice_settlement_state`, which must come out BYTE-IDENTICAL: it
  -- inherits this change by composition and a copy of anything here inside it
  -- would be a second place to keep right.
  PERFORM set_config('daftar.p4s4c_pre_state_reader',
    pg_get_functiondef(to_regprocedure('public.invoice_settlement_state(UUID, UUID)')), true);
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The single-invoice reader-of-record, reduced to a wrapper.
--
--    Same signature, same output columns, same owner, STABLE, SECURITY
--    INVOKER, same pinned path and same ACL, which `CREATE OR REPLACE`
--    keeps and 0083-E reads back. Every caller in the estate — the API's
--    `invoice_outstanding(i.business_id, i.id)` reads,
--    `invoice_settlement_state` (`0075:760`), the allocation command's
--    recompute under the locks (`0081:2086`, `0081:2366`) — keeps calling
--    exactly what it called before and gets exactly the same four numbers.
--
--    THE REDUCER RELATIONS ARE NOT NAMED HERE, and that is the point: this
--    body holds no arithmetic, so there is nothing in it to disagree with
--    the definition in §4. It reads the reducers THROUGH that definition.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT o.paid_txn_minor, o.paid_base_minor, o.outstanding_txn_minor, o.outstanding_base_minor
      FROM public.invoice_outstanding(p_business_id, ARRAY[p_invoice_id]) o;
END;
$$;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID) IS
  'P4-S1, replaced by P4-S4 (0080, 0081, then 0083; P4-AL-05, P4-AL-07, seam S-P4-03). The reader-of-record of ONE invoice paid and outstanding amount, which is refused as a stored column by P4-AL-06. Since 0083 it is a THIN WRAPPER and holds no arithmetic of its own: it asks invoice_outstanding(business, invoice_id[]) — the one definition of the settlement sum — about a one-element array. Every rule (the invoice.not_found refusal, the draft/void zeros, 0080''s cash-settled branch, the UNION ALL over the reducer set, paid_base as the sum of the carrying released) lives there and is kept in exactly one place. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. THE ONE DEFINITION OF THE SETTLEMENT SUM.
--
--    It is the LAST definition of `invoice_outstanding` in this file on
--    purpose (R-100): seam S-P4-03 reads the last Phase 4 definition of that
--    name and asks whether it names every relation that settles an invoice.
--    This is that body. The two AR readers follow it because they are
--    `LANGUAGE sql` and PostgreSQL resolves an sql body's function calls when
--    the body is created, so they cannot be written above the definition they
--    call; they carry a different name, so they do not disturb the seam.
--
--    ONE STATEMENT. The reducer SET is a `UNION ALL` — not two hard-coded
--    sums — so a later slice appends one branch here and nothing else in the
--    estate moves. It is restricted to the invoices asked about on BOTH
--    branches, so the scan is an index range per branch and never the
--    business's whole settlement history, and it is aggregated ONCE, grouped
--    by invoice, and LEFT JOINed to `invoices`: an invoice with NO reducer
--    keeps its row and reports the whole total outstanding, which is the
--    case a plain join would silently drop.
--
--    `paid_base` is the sum of the CARRYING RELEASED and never a conversion
--    of the paid transaction amount, because the cumulative identity
--    `Sigma rel = HALF_EVEN(B . Sigma a, T)` is what makes `outstanding_base`
--    EXACTLY zero when the last reducer closes the invoice (`0081`'s own
--    note). No arithmetic primitive is redefined and none is needed here:
--    this routine SUMS figures the writers already computed through
--    `supplier_ap_release` under their locks.
--
--    IT ALSO RETURNS THE INVOICE'S OWN `currency_code` AND `due_date`
--    (R-104). Those two columns come off the `invoices` row this body already
--    has to read, they cost it nothing, and they are what lets the two AR
--    readers in §4 stop joining `invoices` back onto this call. They are
--    PASSTHROUGH: no settlement figure is computed twice anywhere, which is
--    the whole of P4-AL-07.
--
--    The `invoice.not_found` refusal is kept, in the one form that serves
--    both shapes: the result carries one row per invoice FOUND, and if that
--    is fewer than the distinct ids asked about, an id named an invoice this
--    caller cannot see — under row security that is also how a cross-business
--    id answers "not found" rather than "forbidden" (G-02). The rows a failed
--    call had already queued are discarded with the exception.
--
--    THE CHECK IS FREE WHEN IT PASSES (R-104). `ROW_COUNT` is one row per
--    invoice FOUND, so ROW_COUNT <= distinct(ids) <= cardinality(ids) always;
--    `ROW_COUNT = cardinality` therefore forces all three equal and leaves no
--    refusal possible. The distinct count — a whole second statement over the
--    array, which the first version of this body ran on EVERY call — is paid
--    for only when the fast comparison already differs, which happens only
--    when an id is missing or repeated. `cardinality(NULL)` is NULL, so a NULL
--    array is read as the empty one, exactly as `unnest(NULL)` was.
--
--    STABLE and SECURITY INVOKER like every reader of record (R-P4-07):
--    `daftar_app` holds SELECT on `invoices`, `sales` and both reducers, so a
--    definer read would bypass their row security and grant new authority for
--    nothing.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])
RETURNS TABLE (invoice_id UUID, currency_code TEXT, due_date DATE,
               paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_found BIGINT;
  v_asked BIGINT;
BEGIN
  RETURN QUERY
    SELECT i.id,
           i.currency_code::TEXT,
           i.due_date,
           CASE WHEN i.status <> 'open' THEN 0::BIGINT
                WHEN s.settlement_mode = 'cash' THEN i.total_txn_minor
                ELSE coalesce(r.paid_txn, 0)::BIGINT END,
           CASE WHEN i.status <> 'open' THEN 0::BIGINT
                WHEN s.settlement_mode = 'cash' THEN i.total_base_minor
                ELSE coalesce(r.paid_base, 0)::BIGINT END,
           CASE WHEN i.status <> 'open' OR s.settlement_mode = 'cash' THEN 0::BIGINT
                ELSE (i.total_txn_minor - coalesce(r.paid_txn, 0))::BIGINT END,
           CASE WHEN i.status <> 'open' OR s.settlement_mode = 'cash' THEN 0::BIGINT
                ELSE (i.total_base_minor - coalesce(r.paid_base, 0))::BIGINT END
      FROM public.invoices i
      JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
      LEFT JOIN (
        SELECT d.invoice_id AS invoice_id,
               pg_catalog.sum(d.amount) AS paid_txn,
               pg_catalog.sum(d.rel) AS paid_base
          FROM (
            SELECT a.invoice_id AS invoice_id,
                   a.invoice_amount_applied_minor AS amount,
                   a.invoice_carrying_base_released_minor AS rel
              FROM public.payment_allocations a
             WHERE a.business_id = p_business_id AND a.invoice_id = ANY(p_invoice_ids)
            UNION ALL
            SELECT c.invoice_id AS invoice_id,
                   c.invoice_amount_applied_minor AS amount,
                   c.invoice_carrying_base_released_minor AS rel
              FROM public.customer_credit_applications c
             WHERE c.business_id = p_business_id AND c.invoice_id = ANY(p_invoice_ids)
          ) d
         GROUP BY d.invoice_id
      ) r ON r.invoice_id = i.id
     WHERE i.business_id = p_business_id AND i.id = ANY(p_invoice_ids);
  GET DIAGNOSTICS v_found = ROW_COUNT;
  -- The fast comparison first: one row per invoice FOUND can never exceed the
  -- DISTINCT ids asked about, which can never exceed the array's cardinality,
  -- so equality here forces all three equal and no refusal is reachable. The
  -- distinct count below is the SAME count the first version of this body ran
  -- unconditionally, and it decides the SAME comparison — it is simply not
  -- paid for on the calls that cannot refuse.
  IF v_found <> coalesce(pg_catalog.cardinality(p_invoice_ids), 0) THEN
    SELECT pg_catalog.count(*) INTO v_asked FROM (SELECT DISTINCT x.id FROM pg_catalog.unnest(p_invoice_ids) AS x(id)) k;
    IF v_found <> v_asked THEN
      RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION invoice_outstanding(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_outstanding(UUID, UUID[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID[]) IS
  'P4-S4 (0083; P4-AL-05, P4-AL-07, seam S-P4-03): THE ONE DEFINITION of the settlement sum, set-based. For each invoice asked about: the total minus the sum of invoice_amount_applied_minor over its payment allocations and its customer credit applications, with the paid base the sum of invoice_carrying_base_released_minor so the base closes to zero exactly when the last reducer closes the invoice. A cash-settled invoice reports paid = total and outstanding = 0 (0080). A draft or void document reports zeros. An id that names no invoice this caller can see raises invoice.not_found, and the non-vacuity check that decides that costs a second statement only on the calls where a refusal is reachable at all. It returns the invoice''s own currency_code and due_date beside the four figures — passthrough off the invoices row it already reads, which is what lets the AR readers stop joining invoices back onto this call. ONE pass over the reducer set grouped by invoice, which is why an AR sum over n invoices is one statement and not n function calls; invoice_outstanding(business, invoice) is a thin wrapper over this and holds no arithmetic. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal. Replaced by the slice that adds a reducer relation, which appends one UNION ALL branch.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The two AR readers, each asking its question ONCE.
--
--    The ONLY change in either body is the subject of the FROM: the
--    per-invoice `JOIN LATERAL public.invoice_outstanding(i.business_id,
--    i.id)` becomes one call over the array of the customer's open invoice
--    ids. The `status = 'open'` restriction moves INTO the array subquery and
--    is equivalent there, because the definition reports zeros for a draft or
--    a void document and `HAVING ... <> 0` / `WHERE ... <> 0` already drop
--    those rows.
--
--    NEITHER BODY JOINS `invoices` BACK ONTO THAT CALL (R-104). The currency
--    and the due date come out of the call itself, off the `invoices` row the
--    one definition had already read, so each body names `invoices` exactly
--    ONCE — in the subquery that collects the open invoice ids, which is the
--    same single index scan the pre-reshaping reader made. The join that used
--    to recover those two columns went back to rows the function had just
--    read, against a 1 000-row default estimate for a function that cannot
--    declare better, and it is gone.
--
--    `customer_ar_outstanding` now groups by the TEXT the definition returns
--    rather than by `invoices.currency_code` itself. The partition is the
--    same one: the column is `CHAR(3)` and every value in it is exactly three
--    characters, so `bpchar` equality — which ignores trailing blanks — and
--    `text` equality agree on every row that can be there. `customer_ar_aging`
--    already grouped by the same `::TEXT` projection and its `GROUP BY` does
--    not move at all.
--
--    `array_agg` over no rows is NULL, `unnest(NULL)` is no rows, so a
--    customer with no open invoice still gets the empty answer it got before
--    — which is what a cross-business read sees once row security has hidden
--    every invoice, and what `01-cross-tenant.golden.test.ts:565` asserts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION customer_ar_outstanding(p_business_id UUID, p_customer_id UUID)
RETURNS TABLE (currency_code TEXT, txn_minor BIGINT, base_minor BIGINT)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT o.currency_code,
         pg_catalog.sum(o.outstanding_txn_minor)::BIGINT,
         pg_catalog.sum(o.outstanding_base_minor)::BIGINT
    FROM public.invoice_outstanding(
           p_business_id,
           (SELECT pg_catalog.array_agg(x.id)
              FROM public.invoices x
             WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o
   GROUP BY o.currency_code
  HAVING pg_catalog.sum(o.outstanding_txn_minor) <> 0;
$$;
COMMENT ON FUNCTION customer_ar_outstanding(UUID, UUID) IS
  'P4-S1, replaced by P4-S4 (0083; P4-AL-05, P4-AL-06): the reader-of-record of a customer receivable, per transaction currency, which is refused as a stored balance column. Computed from the open invoices, never from a cached total. Since 0083 it makes ONE call to the set-based invoice_outstanding over the customer''s open invoices instead of one call per invoice, and takes the currency off that call rather than joining invoices back onto it, so it visits invoices exactly once. A change of WORK and not of ANSWER.';

CREATE OR REPLACE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])
RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT b.bucket_no,
         b.currency_code,
         pg_catalog.sum(b.txn_minor)::BIGINT,
         pg_catalog.sum(b.base_minor)::BIGINT,
         pg_catalog.count(*)::INTEGER
    FROM (
      SELECT (1 + (SELECT pg_catalog.count(*)
                     FROM pg_catalog.unnest(p_bucket_days) AS t(threshold)
                    WHERE o.due_date IS NOT NULL AND (p_as_of - o.due_date) > t.threshold))::INTEGER AS bucket_no,
             o.currency_code AS currency_code,
             o.outstanding_txn_minor AS txn_minor,
             o.outstanding_base_minor AS base_minor
        FROM public.invoice_outstanding(
               p_business_id,
               (SELECT pg_catalog.array_agg(x.id)
                  FROM public.invoices x
                 WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o
       WHERE o.outstanding_txn_minor <> 0
    ) b
   GROUP BY b.bucket_no, b.currency_code;
$$;
COMMENT ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) IS
  'P4-S1, replaced by P4-S4 (0083; P4-AL-05): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. There is no materialised aging table (P4-AL-06) and the routine does not read the clock (P4-AL-30). Since 0083 it makes ONE call to the set-based invoice_outstanding over the customer''s open invoices instead of one call per invoice, and takes the currency and the due date off that call rather than joining invoices back onto it, so it visits invoices exactly once; the buckets, the thresholds and the answer are unchanged.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. 0083-E: the end state, read from the live catalogues and never from
--    this file's own statements (R-P4-08).
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def  TEXT;
  v_name TEXT;
BEGIN
  -- 0083-E(1). THE ONE DEFINITION IS IN THE LIVE CATALOGUE and it reads both
  -- reducers, the invoice, its sale's settlement mode and nothing cached.
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding is not in the catalogue' USING ERRCODE = 'P0001';
  END IF;
  -- `currency_code` and `due_date` are in this list because the two AR
  -- readers below STOPPED JOINING `invoices` on the strength of them (R-104):
  -- a definition that quietly dropped them would leave those readers reading
  -- columns that are not there.
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications', 'settlement_mode', 'invoice.not_found',
                                'currency_code', 'due_date'] LOOP
    IF v_def NOT LIKE '%' || v_name || '%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding does not carry %', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 0083-E(2). AND THERE IS EXACTLY ONE COPY OF IT (P4-AL-07). The
  -- single-invoice reader names NEITHER reducer, because it does no
  -- arithmetic: it delegates to the array form. A body that named a reducer
  -- here would be a second settlement sum, which is the one thing this
  -- reshaping must not buy its speed with.
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'));
  IF v_def LIKE '%payment_allocations%' OR v_def LIKE '%customer_credit_applications%' OR v_def LIKE '%total_txn_minor%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the single-invoice invoice_outstanding carries settlement arithmetic of its own, so there are two copies'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def NOT LIKE '%invoice_outstanding(p_business_id, ARRAY[p_invoice_id])%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the single-invoice invoice_outstanding does not delegate to the set-based definition'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0083-E(3). NEITHER AR READER CALLS THE READER PER INVOICE ANY MORE, and
  -- neither of them grew arithmetic of its own either. This is the defect
  -- closed, read back from the catalogue.
  FOR v_def IN
    SELECT pg_get_functiondef(f.oid)
      FROM (SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)') AS oid
            UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
  LOOP
    IF v_def LIKE '%JOIN LATERAL public.invoice_outstanding(i.business_id, i.id)%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: an AR reader still calls invoice_outstanding once per invoice'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_def NOT LIKE '%public.invoice_outstanding(%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: an AR reader no longer reads the reader-of-record at all'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_def LIKE '%payment_allocations%' OR v_def LIKE '%customer_credit_applications%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: an AR reader reads a reducer relation directly, which is a second copy of the settlement sum'
        USING ERRCODE = 'P0001';
    END IF;
    -- R-104, read back from the catalogue: an AR reader names `invoices`
    -- EXACTLY ONCE — the subquery that collects the customer's open invoice
    -- ids — and never a second time to recover the currency or the due date,
    -- which the one definition now returns. Two occurrences means the join
    -- that the median arm's fixed cost was made of is back.
    IF pg_catalog.array_length(pg_catalog.string_to_array(v_def, 'public.invoices'), 1) <> 2 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: an AR reader does not read public.invoices exactly once — the second visit R-104 removed is back, or the open-invoice subquery is gone'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 0083-E(4). ONLY THE BODIES MOVED. Owner, SECURITY INVOKER standing, the
  -- pinned path and the whole ACL of all three replaced routines compare
  -- EQUAL to the capture taken before they were replaced, so nobody gained
  -- EXECUTE and no authority was re-granted by accident.
  IF (SELECT pg_catalog.string_agg(
               format('%s=%s|%s|%s|%s', f.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                      coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-')),
               E'\n' ORDER BY f.oid::regprocedure::text)
        FROM (SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID)') AS oid
              UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
              UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
        JOIN pg_proc p ON p.oid = f.oid)
     IS DISTINCT FROM current_setting('daftar.p4s4c_pre_readers', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a replacement changed the owner, security, path or ACL of a reader of record'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0083-E(5). And the accepted configuration stated ABSOLUTELY, over all
  -- FOUR routines including the new one — a capture compared against itself
  -- proves nothing if the configuration was already wrong before this file
  -- ran. STABLE, invoker's rights, the pinned `search_path`, EXECUTE for
  -- exactly the two accepted roles, and NOTHING for PUBLIC.
  FOR v_name IN
    SELECT f.oid::regprocedure::text
      FROM (SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID)') AS oid
            UNION ALL SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID[])')
            UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
            UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = v_name::regprocedure
                      AND p.provolatile = 's' AND NOT p.prosecdef
                      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not a STABLE, SECURITY INVOKER routine with its pinned search_path', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text)
          FROM pg_proc p, aclexplode(p.proacl) x
         WHERE p.oid = v_name::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner)
       IS DISTINCT FROM ARRAY['daftar_app', 'daftar_inventory_internal'] THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: EXECUTE on % is not exactly the two accepted roles', v_name USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = v_name::regprocedure AND x.grantee = 0) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: PUBLIC holds a privilege on %', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 0083-E(6). `invoice_settlement_state` is BYTE-IDENTICAL. It inherits
  -- this change by composition, which is the whole value of the seam, and a
  -- copy of anything from §4 inside it would be a second place to keep right.
  IF pg_get_functiondef(to_regprocedure('public.invoice_settlement_state(UUID, UUID)'))
     IS DISTINCT FROM current_setting('daftar.p4s4c_pre_state_reader', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0083 changed invoice_settlement_state' USING ERRCODE = 'P0001';
  END IF;

  -- 0083-E(7). NO SECOND TRUTH WAS CREATED. This file adds no relation, no
  -- materialised view, no column and no trigger: there is nowhere a balance
  -- could have been stored, and the four reducer-era relations are exactly
  -- the ones `0081` created.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'm') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a materialised view exists, which is a stored balance by another name'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid IN ('public.invoices'::regclass, 'public.customers'::regclass)
                AND NOT a.attisdropped AND a.attnum > 0
                AND a.attname ~ '(^|_)(outstanding|paid|balance|settled)($|_)') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices or customers carries a stored settlement column (P4-AL-06)'
      USING ERRCODE = 'P0001';
  END IF;
END
$post$;
