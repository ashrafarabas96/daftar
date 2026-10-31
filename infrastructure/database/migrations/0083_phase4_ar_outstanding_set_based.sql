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
-- are CANDIDATE and are BYTE-FOR-BYTE UNTOUCHED: this file is append-only and
-- corrects FORWARD, which is the only manner a defect in an already-applied
-- migration is repaired here (`0072` is the Phase 3 precedent; `0082` is this
-- slice's own).
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
--     the invoice, per `0081`'s own note on the cumulative identity).
--   — `invoice_outstanding(UUID, UUID)` — REPLACED, and now a THIN WRAPPER:
--     one `RETURN QUERY` over the definition above with a one-element array.
--     It contains no arithmetic, no branch and no refusal of its own.
--   — `customer_ar_outstanding` and `customer_ar_aging` — REPLACED, and the
--     only change in either is that the `JOIN LATERAL ... ON TRUE` over one
--     invoice becomes ONE call over the customer's open invoices. Their
--     output columns, their `GROUP BY`, their `HAVING sum(...) <> 0`, their
--     bucket arithmetic and their refusal to read the clock (P4-AL-30) are
--     unchanged.
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
--    The `invoice.not_found` refusal is kept, in the one form that serves
--    both shapes: the result carries one row per invoice FOUND, and if that
--    is fewer than the distinct ids asked about, an id named an invoice this
--    caller cannot see — under row security that is also how a cross-business
--    id answers "not found" rather than "forbidden" (G-02). `ROW_COUNT` after
--    `RETURN QUERY` is what makes this cost no extra scan, and the rows a
--    failed call had already queued are discarded with the exception.
--
--    STABLE and SECURITY INVOKER like every reader of record (R-P4-07):
--    `daftar_app` holds SELECT on `invoices`, `sales` and both reducers, so a
--    definer read would bypass their row security and grant new authority for
--    nothing.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])
RETURNS TABLE (invoice_id UUID, paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_found BIGINT;
  v_asked BIGINT;
BEGIN
  RETURN QUERY
    SELECT i.id,
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
  SELECT pg_catalog.count(*) INTO v_asked FROM (SELECT DISTINCT x.id FROM pg_catalog.unnest(p_invoice_ids) AS x(id)) k;
  IF v_found <> v_asked THEN
    RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION invoice_outstanding(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_outstanding(UUID, UUID[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID[]) IS
  'P4-S4 (0083; P4-AL-05, P4-AL-07, seam S-P4-03): THE ONE DEFINITION of the settlement sum, set-based. For each invoice asked about: the total minus the sum of invoice_amount_applied_minor over its payment allocations and its customer credit applications, with the paid base the sum of invoice_carrying_base_released_minor so the base closes to zero exactly when the last reducer closes the invoice. A cash-settled invoice reports paid = total and outstanding = 0 (0080). A draft or void document reports zeros. An id that names no invoice this caller can see raises invoice.not_found. ONE pass over the reducer set grouped by invoice, which is why an AR sum over n invoices is one statement and not n function calls; invoice_outstanding(business, invoice) is a thin wrapper over this and holds no arithmetic. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal. Replaced by the slice that adds a reducer relation, which appends one UNION ALL branch.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The two AR readers, each asking its question ONCE.
--
--    The ONLY change in either body is the subject of the FROM: the
--    per-invoice `JOIN LATERAL public.invoice_outstanding(i.business_id,
--    i.id)` becomes one call over the array of the customer's open invoice
--    ids, joined back to `invoices` for the currency and the due date. The
--    `status = 'open'` restriction moves INTO the array subquery and is
--    equivalent there, because the definition reports zeros for a draft or a
--    void document and `HAVING ... <> 0` / `WHERE ... <> 0` already drop
--    those rows.
--
--    `array_agg` over no rows is NULL, `unnest(NULL)` is no rows, so a
--    customer with no open invoice still gets the empty answer it got before
--    — which is what a cross-business read sees once row security has hidden
--    every invoice, and what `01-cross-tenant.golden.test.ts:565` asserts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION customer_ar_outstanding(p_business_id UUID, p_customer_id UUID)
RETURNS TABLE (currency_code TEXT, txn_minor BIGINT, base_minor BIGINT)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.currency_code::TEXT,
         pg_catalog.sum(o.outstanding_txn_minor)::BIGINT,
         pg_catalog.sum(o.outstanding_base_minor)::BIGINT
    FROM public.invoice_outstanding(
           p_business_id,
           (SELECT pg_catalog.array_agg(x.id)
              FROM public.invoices x
             WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o
    JOIN public.invoices i ON i.business_id = p_business_id AND i.id = o.invoice_id
   GROUP BY i.currency_code
  HAVING pg_catalog.sum(o.outstanding_txn_minor) <> 0;
$$;
COMMENT ON FUNCTION customer_ar_outstanding(UUID, UUID) IS
  'P4-S1, replaced by P4-S4 (0083; P4-AL-05, P4-AL-06): the reader-of-record of a customer receivable, per transaction currency, which is refused as a stored balance column. Computed from the open invoices, never from a cached total. Since 0083 it makes ONE call to the set-based invoice_outstanding over the customer''s open invoices instead of one call per invoice, which is a change of WORK and not of ANSWER.';

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
                    WHERE i.due_date IS NOT NULL AND (p_as_of - i.due_date) > t.threshold))::INTEGER AS bucket_no,
             i.currency_code::TEXT AS currency_code,
             o.outstanding_txn_minor AS txn_minor,
             o.outstanding_base_minor AS base_minor
        FROM public.invoice_outstanding(
               p_business_id,
               (SELECT pg_catalog.array_agg(x.id)
                  FROM public.invoices x
                 WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o
        JOIN public.invoices i ON i.business_id = p_business_id AND i.id = o.invoice_id
       WHERE o.outstanding_txn_minor <> 0
    ) b
   GROUP BY b.bucket_no, b.currency_code;
$$;
COMMENT ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) IS
  'P4-S1, replaced by P4-S4 (0083; P4-AL-05): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. There is no materialised aging table (P4-AL-06) and the routine does not read the clock (P4-AL-30). Since 0083 it makes ONE call to the set-based invoice_outstanding over the customer''s open invoices instead of one call per invoice; the buckets, the thresholds and the answer are unchanged.';

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
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications', 'settlement_mode', 'invoice.not_found'] LOOP
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
