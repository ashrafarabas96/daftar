-- 0084_phase4_ar_fixed_cost_and_open_invoice_page.sql
-- Phase 4 / P4-S4 CORRECTIVE — TWO DEFECTS, ONE ROUTINE SURFACE. `0083` made
-- the AR sum set-based and left TWO things wrong, and both of them want the
-- same four routines recreated, so they are corrected in ONE appended file
-- rather than two:
--
--   1. THE FIXED COST OF ONE ARRAY CALL (agent F's R-103/R-104, PORTED here).
--      Both AR readers recover `currency_code` and `due_date` by joining
--      `public.invoices` BACK ONTO the function's output. The ONE definition
--      already reads that invoices row, so it returns those two columns as
--      PASSTHROUGH and both readers lose the re-join.
--   2. THE OPEN-INVOICE PAGE. `CustomerReads.openInvoices` filters on the
--      FUNCTION'S OUTPUT, so `LIMIT` cannot short-circuit and the LATERAL runs
--      once per historical invoice. A new reader —
--      `customer_open_invoices_page` — answers that page with a BOUNDED
--      CHUNKED KEYSET walk and ONE set-based call per chunk.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080`, `0081`, `0082` and
-- `0083` are CANDIDATE and are BYTE-FOR-BYTE UNTOUCHED: this file is
-- append-only and corrects FORWARD, which is how a defect in an
-- already-applied migration is repaired here (`0072` is the Phase 3
-- precedent; `0082` and `0083` are this slice's own).
-- `MIGRATION_MANIFEST.json` is untouched and `frozenThrough` stays `0079`.
--
-- ── WHOSE CONTENT THIS IS, AND THE ARGUMENT THAT WAS DECIDED AGAINST ─────
--
-- Correction 1 is NOT re-derived here. It is agent F's work, measured by F on
-- PostgreSQL 16.13 and ported from `p4s4c/f-fixed-cost` (`040c428`,
-- `71d84bb`), where F had corrected `0083` IN PLACE. F argued for that in
-- place edit, and the argument deserves to survive in the history rather than
-- only in a superseded branch. F's own words, in substance:
--
--   «`0083` is a CANDIDATE of this same slice, written hours earlier, with NO
--   CI EVIDENCE BOUND TO IT; and an `0084` that replaced the three routines
--   `0083` had just created would leave a history in which the live
--   definition of the AR sum can only be found by reading two files that
--   disagree.»
--
-- That is a real cost and this file pays it: a reader who wants the live AR
-- sum must now read `0083` and then `0084`, and `0083`'s text no longer
-- describes the live catalogue. THE TECH LEAD'S §15 DECIDES IT THE OTHER WAY:
-- appending is preferred over rewriting a measured candidate, so F's in-place
-- edit is superseded AS A DELIVERY MECHANISM and its content is ported here
-- unchanged in substance. Both halves are recorded on purpose. The one place
-- this file departs from F's text is the COLUMN POSITION of the two new
-- passthrough columns — see R-104-A.
--
-- F's measured figures, credited to F and NOT re-measured here. PostgreSQL
-- 16.13 — the deployment target, not an embedded 18.4 cluster — 200 samples
-- per arm, one session, as `daftar_app` with the request-scope GUCs set and
-- ROW SECURITY APPLIED, over one business of 2 003 invoices with a
-- 2 000-open-invoice fat-tail customer (4 000 allocations) and a
-- 3-open-invoice median customer, ANALYZEd. STATEMENT figures, not the P4-D
-- HTTP budget:
--
--   MEDIAN arm, the AR sum over 3 open invoices
--     with the re-join    (`0083` as applied)      p50 4.079  p95 4.517
--     without it          (this file)              p50 1.412  p95 1.796
--     ----------------------------------------------------------------
--     REMOVING THE RE-JOIN IS WORTH (F)            p50 2.667  p95 2.721
--
--   FAT-TAIL arm, the same sum over 2 000 open invoices
--     with the re-join                             p50 26.756 p95 31.814
--     without it                                   p50 23.443 p95 27.206
--     — so the fat tail gets FASTER too, and nothing regresses.
--
--   The non-vacuity check, isolated over 3 ids
--     unconditional                                p50 1.098  p95 1.352
--     short-circuited                              p50 1.026  p95 1.280
--     ----------------------------------------------------------------
--     THE SHORT CIRCUIT IS WORTH (F)               p50 0.072  p95 0.072
--
-- So the re-join is ~97% of what Correction 1 recovers and the short circuit
-- ~3%. F's `EXPLAIN (ANALYZE, BUFFERS)` of the median read WITH the re-join
-- says why, and it is the whole of the diagnosis:
--
--   HashAggregate
--     InitPlan 1  -> Index Scan using invoices_customer_idx  (actual rows=3)
--     ->  Hash Join  (cost rows=1000)  (actual rows=3)
--           ->  Function Scan on invoice_outstanding  (est 1000, actual 3)
--           ->  Hash  ->  Seq Scan on invoices i  (actual rows=2003,
--                           Buffers: shared hit=294)
--
-- A FULL SEQUENTIAL SCAN OF EVERY INVOICE IN THE BUSINESS, hashed, on every
-- read of a three-invoice customer, to recover a currency code the function
-- had already read — and under row security the policy predicate is evaluated
-- on each of those 2 003 rows, which is why F measured the saving at 2.667 ms
-- as `daftar_app` and 0.574 ms as the owner with row security bypassed.
--
-- The figures in this header for Correction 1 are F's. The plan evidence for
-- Correction 2 — and for this file's own text as applied — is this agent's
-- own, taken on PostgreSQL 16.13 as `daftar_app` with row security applied,
-- and reported beside this file rather than restated here. NO FIGURE IS
-- CLAIMED AS MEASURED BY ANYONE WHO DID NOT MEASURE IT.
--
-- ── R-103 THE FIRST DEFECT, RESTATED FROM F ──────────────────────────────
--
-- `0083`'s reshaping removed the per-invoice call and brought the P4-D
-- fat-tail arm from 126.092 ms to 58.277 ms, inside its 100 ms ceiling. It
-- ALSO MOVED THE MEDIAN ARM from 14.179 ms to 24.161 ms, and that is not
-- cosmetic: the 3x fat-tail/median ratio then read 2.412x partly because its
-- DENOMINATOR had inflated. On the pre-`0083` denominator the same numerator
-- is 58.277 / 14.179 = 4.110x, which would STILL FAIL. The median regression
-- was holding up an invariant, which is why it is corrected before the slice
-- is sealed and not after. (These four figures are the earlier measurement of
-- `0083` itself, carried over from F's commit message; they are not a claim
-- about this file's text.)
--
-- WHERE THE COST IS, which corrects the natural first guess. It is NOT the
-- single-invoice wrapper. The median arm is a CUSTOMER read: it reaches
-- `customer_ar_outstanding`, which after `0083` makes exactly ONE call to the
-- array form with THREE ids. One array call over three invoices cost more
-- than the three `LATERAL` calls it replaced. The subject is the array form's
-- own FIXED cost and the work the two AR readers do AROUND it. Read against
-- each other, the post-`0083` median path pays three things the pre-`0083`
-- path did not:
--
--   (a) A SECOND VISIT TO `invoices`. The pre-`0083` reader drove FROM
--       `invoices` restricted by (business, customer, status) and took
--       `currency_code` and `due_date` off THAT VERY SCAN. `0083`'s reader
--       collects the open invoice ids, hands them to the array form, and then
--       JOINS `public.invoices` BACK ONTO the function's output to recover
--       those same two columns — from the very rows the function had just
--       read. A set-returning function carrying a `SET` clause cannot be
--       inlined and this one declares no `ROWS`, so the planner estimates its
--       output at the default 1 000 rows and plans that join against an
--       estimate some three hundred times the median truth.
--   (b) AN EXTRA SCAN OF THE ARRAY ON EVERY CALL. The non-vacuity check runs
--       `SELECT count(*) FROM (SELECT DISTINCT unnest(p_invoice_ids))`
--       UNCONDITIONALLY, for a comparison that can only come out unequal when
--       an id is missing or repeated.
--   (c) ONE MORE PLANNED AND EXECUTED STATEMENT per call, which is what (b)
--       costs as seen from the plan cache rather than from the array.
--
-- (a) is the only one of the three that can cost MILLISECONDS; (b) and (c)
-- are microseconds each. F measured exactly that, and the figures are above.
--
-- ── R-104 THE SHAPE THAT REMOVES IT, STILL WITH ONE COPY ─────────────────
--
--   — The ONE DEFINITION now returns the invoice's own `currency_code` and
--     `due_date` BESIDE its four settlement figures. It already reads that
--     `invoices` row — it must, to know the total and the status — so the two
--     columns cost it NOTHING, and they are the only reason either AR reader
--     ever went back. THIS IS PASSTHROUGH, NOT ARITHMETIC: no settlement
--     figure is computed anywhere a second time, and P4-AL-07 still has
--     exactly ONE body that computes one, reached three ways.
--   — Both AR readers therefore LOSE THEIR `JOIN public.invoices` entirely.
--     Each now names `invoices` exactly ONCE, in the subquery that collects
--     the customer's open invoice ids — the same single index scan on
--     `invoices_customer_idx` (`0075:332`) the pre-`0083` reader made. The
--     output columns, the `GROUP BY`, the `HAVING sum(...) <> 0`, the bucket
--     arithmetic and the refusal to read the clock (P4-AL-30) are unchanged,
--     and 0084-E(3) reads the absence of the join back FROM THE CATALOGUE
--     rather than from this file's own statements.
--   — `customer_ar_outstanding` now groups by the TEXT the definition returns
--     rather than by `invoices.currency_code` itself. The partition is the
--     same one: the column is `CHAR(3)` and every value in it is exactly
--     three characters, so `bpchar` equality — which ignores trailing blanks
--     — and `text` equality agree on every row that can be there.
--     `customer_ar_aging` already grouped by the same `::TEXT` projection and
--     its `GROUP BY` does not move at all.
--   — The non-vacuity check KEEPS ITS MEANING and loses its cost in the
--     passing case. `ROW_COUNT` is one row per invoice FOUND, so
--     ROW_COUNT <= distinct(ids) <= cardinality(ids) always; `ROW_COUNT =
--     cardinality` therefore forces all three equal and leaves NO refusal
--     reachable. The distinct count is the SAME count deciding the SAME
--     comparison and raising the SAME `invoice.not_found`; it is simply paid
--     for only on the calls where a refusal is possible at all. An unknown
--     id, another business's id, a dangling sale, a repeated id, a NULL
--     element, an empty array and a NULL array all answer exactly what they
--     answered before (`cardinality(NULL)` is NULL and is read as 0, exactly
--     as `unnest(NULL)` was no rows).
--
-- ── R-104-A WHERE THE TWO NEW COLUMNS GO, AND WHY NOT WHERE F PUT THEM ───
--
-- F inserted `currency_code` and `due_date` at positions 2 and 3, directly
-- after `invoice_id`. THIS FILE APPENDS THEM AT POSITIONS 6 AND 7 INSTEAD,
-- after the four settlement figures. The reason is that F was rewriting the
-- file that CREATED the array form, so no caller of it existed yet outside
-- that same diff; this file changes a routine that is ALREADY APPLIED and
-- already called. A positional reader — `SELECT * FROM
-- invoice_outstanding(...)` consumed by ordinal, a `RETURNS TABLE` whose
-- column list is matched left to right — stays valid under an APPEND and
-- silently reads the wrong column under an INSERT. The arithmetic, the
-- passthrough and the measurement are F's and unchanged; only the ordinal is
-- this file's, and the signature is the coordinator-fixed one.
--
-- ── R-105 THE SECOND DEFECT: THE OPEN-INVOICE PAGE ───────────────────────
--
-- `CustomerReads.openInvoices` asks for the first N of the customer's
-- documents that still have something outstanding, oldest first. It asks for
-- it like this:
--
--     FROM invoices i
--     JOIN LATERAL invoice_outstanding(i.business_id, i.id) o ON TRUE
--    WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status = 'open'
--      AND o.outstanding_txn_minor <> 0          <-- THE DEFECT
--    ORDER BY i.issue_date, i.id
--    LIMIT $5
--
-- The filter is on the FUNCTION'S OUTPUT, so the `LIMIT` cannot short-circuit
-- the walk: PostgreSQL must evaluate the LATERAL for every candidate invoice
-- in `(issue_date, id)` order until 51 of them survive the filter. Measured
-- 991.792 ms and 1 551 LATERAL loops to return 51 rows, against a 100 ms
-- ceiling.
--
-- `0080` is what makes it bite rather than merely cost. A cash-settled
-- invoice keeps `status = 'open'` — the status is the DOCUMENT's lifecycle,
-- not its settlement — and reports outstanding 0, because `0080`'s law is
-- that a cash sale raises no receivable. So a shop that sells mostly for cash
-- accumulates permanently FAILING candidates: rows the predicate reaches,
-- pays the full settlement computation for, and then discards. The page is a
-- permanent fat tail that grows with the shop's whole history and never with
-- what it is owed.
--
-- `invoice-reads.ts:249` DOES NOT SHARE THIS DEFECT and is not touched. It is
-- the single-invoice settlement read, predicated on the primary key, so its
-- LATERAL runs exactly once. (An earlier note in this slice said otherwise;
-- it was wrong.)
--
-- ── R-106 THE PAGE READER, AND WHY IT IS NOT A FAKE `LIMIT` FIX ──────────
--
-- `customer_open_invoices_page` is a BOUNDED CHUNKED KEYSET loop. Per
-- iteration it collects the next chunk of ELIGIBLE candidates in
-- `(issue_date, id)` order with a `LIMIT`, makes ONE set-based call to the
-- array form over that chunk, filters on the result, emits at most
-- `p_limit - emitted` rows, advances the cursor to the chunk's last candidate
-- and exits when the page is full or the candidates run out.
--
--   — SEMANTICS ARE EXACTLY PRESERVED (§13). The page is still the first N
--     invoices satisfying the BUSINESS predicate, in `(issue_date, id)`
--     order. Chunks are taken in keyset order and each chunk is ordered and
--     limited internally, so the global order holds; emitted rows are counted
--     with `GET DIAGNOSTICS ... ROW_COUNT` and the inner `LIMIT` shrinks
--     accordingly. It NEVER takes the first 51 rows and then drops the
--     zero-outstanding ones — that would be a different page.
--   — THE CASH PRE-FILTER IS AN ELIGIBILITY OPTIMIZATION, NOT A SECOND
--     BALANCE (§8). `JOIN public.sales s ... AND s.settlement_mode <> 'cash'`
--     sits in the CANDIDATE query and computes no balance at all. Its proof is
--     `0080`'s own law and the array form's own body two sections below
--     (`WHEN s.settlement_mode = 'cash' THEN 0`): a cash-settled invoice's
--     outstanding is 0 FOR ALL DATA, so it can never satisfy `<> 0`, so
--     excluding it removes only rows the filter would have removed anyway.
--     `invoices_customer_idx` is `(business_id, customer_id, issue_date, id)`,
--     so the candidate scan is index work in exactly the page's order, and
--     the `sales` predicate resolves through `sales_pkey` over a BOUNDED
--     chunk. It still owes — and is given — the identical-result-set test.
--   — THE SETTLED-CREDIT FAT TAIL (§9) HAS NO TABLE PREDICATE. A credit
--     invoice that is fully paid is `status = 'open'` with outstanding 0, and
--     nothing short of the settlement sum can tell it from an unpaid one. The
--     chunking is what handles it: 1 500 settled-credit candidates become a
--     bounded handful of SET-BASED calls, not 1 551 scalar ones. §12 wants
--     that proved as bounded, set-oriented behaviour and not as a scan merely
--     moved elsewhere, and the plan evidence beside this file reports it.
--   — THE CHUNK SIZE IS A DOCUMENTED CONSTANT derived from `p_limit`:
--     `greatest(p_limit * 4, 64)`. Four pages' worth per round trip, floored
--     so that a tiny `p_limit` still amortises. At the app's `limit + 1 = 51`
--     that is 204 candidates per chunk.
--   — NO SECOND TRUTH. The page reader performs NO settlement arithmetic:
--     every figure in its output comes from the ONE definition. No
--     `invoices.outstanding_minor`, no `paid_minor`, no cached settlement
--     state, no mutable `is_paid`, no application-side copy, no second
--     formula, no materialised view, no journal read as an alternate
--     authority. RLS is neither bypassed nor weakened — the routine is
--     `SECURITY INVOKER` like every reader of record, so a candidate the
--     caller cannot see is not a candidate. And no row is excluded because a
--     test dataset makes it convenient.
--   — `settlement_state` IS NOT RETURNED. Deriving it here would be a second
--     copy of the state law. The app keeps calling
--     `invoice_settlement_state(i.business_id, i.id)` in its select list,
--     where it runs only for the rows actually returned — at most `p_limit`
--     of them. If that ever turns out to be material, the answer is a SET
--     form of `invoice_settlement_state` with the scalar as a wrapper, the
--     same pattern `0083` used, and NOT a derivation in the page reader (§7).
--
-- ── R-106-A WHAT AMENDMENT 1 SETTLED ────────────────────────────────────
--
-- The coordinator's AMENDMENT 1 closed four gaps against the contract. Three
-- of them bear on how this file is to be READ:
--
--   — CREDIT-NOTE DOCUMENTS CANNOT EXIST ON THIS HEAD. `0075:250` pins
--     `CONSTRAINT invoices_document_kind_ck CHECK (document_kind = 'invoice')`
--     and `0075:374` pins `invoice_sequences` the same way, so `0084` adds
--     none and the settled fat tail is settled by the two instruments that DO
--     exist — `payment_allocations` and `customer_credit_applications`, which
--     are exactly the two arms of the ONE definition's reducer `UNION ALL`,
--     including a two-step chain of both. A negative document belongs to the
--     slice that creates one.
--   — EVERY PAGE FIGURE HERE IS THE MAXIMUM PAGE, NOT THE DEFAULT ONE.
--     `customer-reads.ts` has `DEFAULT_LIMIT = 20`, and
--     `CustomerOpenInvoicesQuerySchema` caps `limit` at 50. So the 51 rows,
--     the 1 551 LATERAL loops and the 991.792 ms of the defect report are
--     `limit = 50` plus the `+1` probe for `nextCursor` — the LARGEST page the
--     endpoint serves, which is the right page on which to measure a
--     pathological scan. Nobody should later reconcile "51" against a default
--     of 20 and conclude the evidence is about the wrong page.
--   — ALL PLAN EVIDENCE FOR THIS FILE COMES FROM POSTGRESQL 16. The system
--     cluster at `/var/lib/postgresql/16/main` is 16.13, the deployment
--     target; `node_modules/embedded-postgres` is 18.4 and is not. A unique
--     `PG_DIR`/`PG_PORT` isolates a cluster an agent must create and is never
--     a reason to measure on 18.4.
--
-- The fourth — the cursor's mixed-NULL case — changed this file's CODE and is
-- recorded at §7's cursor-resolution block.
--
-- ── R-107 WHY ONE FILE AND WHY THIS DDL ORDER ────────────────────────────
--
-- The two corrections want the same routine surface: Correction 1 changes the
-- array form's RETURN TYPE, and a `RETURNS TABLE` change is a DROP and a
-- CREATE, not a `CREATE OR REPLACE`. The two AR readers are `LANGUAGE sql`
-- and so carry CATALOGUE DEPENDENCIES on the array form, so they must come
-- down first. Every `DROP` here is WITHOUT `CASCADE` on purpose: a dependency
-- nobody expected then becomes an ERROR and not a silent removal.
--
--   1. DROP customer_ar_outstanding(UUID, UUID)
--   2. DROP customer_ar_aging(UUID, UUID, DATE, INTEGER[])
--   3. DROP invoice_outstanding(UUID, UUID[])
--   4. CREATE OR REPLACE invoice_outstanding(UUID, UUID)  -- the wrapper
--   5. CREATE invoice_outstanding(UUID, UUID[])        -- the ONE definition
--   6. CREATE customer_ar_outstanding / customer_ar_aging
--   7. CREATE customer_open_invoices_page
--
-- R-100 IS WHY 4 AND 5 ARE IN THAT ORDER, AND IT IS THE ONE PLACE THIS FILE
-- DEPARTS FROM THE CONTRACT'S OWN NUMBERING. Seam S-P4-03
-- (`scripts/phase4-s1-gate.ts`, `DEFERRED_SEAMS`) reads the LAST Phase 4
-- definition of `invoice_outstanding` — `phase4RoutineBody` literally takes
-- the last match across the whole Phase 4 DDL — and requires it to name every
-- relation the Phase 4 DDL calls a settling one. The reducers are read by the
-- ARRAY form, so the array form must be the last definition OF THAT NAME and
-- the wrapper must precede it, which is how `0083` is arranged too.
--
-- The contract's numbered list says 4 = the array form and 5 = the wrapper,
-- while the contract's PROSE at that same step says «R-100 requires the array
-- form to be the last definition of `invoice_outstanding` for seam S-P4-03».
-- Those two cannot both hold, and the gate settles which is operative: built
-- the other way round, the seam reported «S-P4-03: invoice_outstanding does
-- not read customer_credit_applications, payment_allocations» — a measured red
-- against this very file, recorded here rather than argued away. No signature
-- changes, no DROP moves; two CREATEs trade places.
--
-- The two AR readers and the page reader follow both, because an `sql` body
-- resolves its callees at CREATE time and the page reader's `RETURN QUERY` is
-- planned against the array form's new column list; they carry different
-- names, so they do not disturb the seam.
--
-- The wrapper is NOT made `LANGUAGE sql`, which would have saved it one
-- plpgsql frame per single-invoice call: R-100 would then force it to be
-- written after the array form, which is to say last, and a faster wrapper is
-- not worth answering the seam's question by editing the seam.
--
-- ── R-108 WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────
--
--   — NO stored, cached, denormalised or materialised balance, and NO second
--     copy of the settlement arithmetic. There is exactly ONE body that
--     computes an outstanding figure after this file, reached three ways;
--     0084-E(2), 0084-E(3) and 0084-E(4) read that back from the catalogue.
--   — NO `search_path` is unpinned, no routine changes its owner, its
--     volatility, its SECURITY INVOKER standing or its ACL. A DROP AND CREATE
--     LOSES THE ACL, so §5, §6 and §7 restore it explicitly and 0084-E(5)
--     compares owner, `prosecdef`, `proconfig` and `proacl` against a capture
--     taken in 0084-P before anything was dropped.
--   — NO index is added. The candidate scan uses `invoices_customer_idx` and
--     `sales_pkey`, both already there; the reducer scans use
--     `payment_allocations_invoice_idx` and
--     `customer_credit_applications_invoice_idx` (`0081`).
--   — NO `ROWS` clause is added to the array form. One constant cannot be
--     right for a three-invoice median and a two-thousand-invoice tail, and
--     with the re-join gone the mis-estimate has nothing left to mis-JOIN.
--   — NO `plan_cache_mode` is forced: that would be a measured claim about
--     replanning and no such claim is made here.
--   — NO ceiling, budget, ratio, threshold or sample count is moved. Not one.
--   — NO relation, column, trigger, policy, grant, source type or operation
--     kind is created, dropped or altered, and `invoice_settlement_state`,
--     `invoice_settlement_verify`, the two commands and every accounting
--     routine are untouched. 0084-E(7) proves the settlement state reader
--     byte-identical.
--   — NO tax rule is read, inferred or introduced. OD-03 stays open.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 0084-P: the head, the subject, and the pre-state capture.
--
--    The expected head is `0083` AS APPLIED — the array form of five columns
--    with the re-join still live in both AR readers. This block REFUSES TO
--    APPLY on anything else, so the file cannot half-land on a tree that
--    somebody has already corrected another way (for instance by F's in-place
--    edit of `0083`, which produces a seven-column array form and no re-join:
--    on such a tree this file raises rather than drops a routine it did not
--    recognise).
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_def TEXT;
BEGIN
  -- (1) THE HEAD. `0081`'s reducers and `0082`'s structural customer pin are
  --     there, and `0083`'s array form is there, which is what makes this
  --     file a correction of `0083` rather than of anything earlier.
  IF to_regclass('public.payment_allocations') IS NULL OR to_regclass('public.customer_credit_applications') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0084 applies on the 0083 head, which needs 0081''s two settlement reducers'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'invoices_customer_uq' AND c.conrelid = 'public.invoices'::regclass AND c.contype = 'u') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0082''s invoices (business_id, id, customer_id) key is missing, so 0083 is not the head'
      USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.invoice_outstanding(UUID, UUID[])') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0083''s set-based invoice_outstanding is not in the catalogue, so 0084 has no subject'
      USING ERRCODE = 'P0001';
  END IF;

  -- (2) THE SUBJECT IS PROVED PRESENT BEFORE IT IS CHANGED
  --     ([[daftar-a-green-gate-must-prove-it-can-be-red]]). The live array
  --     form is `0083`'s — five output columns, no `currency_code`, no
  --     `due_date` — and both AR readers really do join `public.invoices`
  --     back onto it, which is the fixed cost R-104 removes. A tree where
  --     either is already otherwise is a tree this file would be a no-op or a
  --     surprise on, and it is refused.
  IF pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'))
     IS DISTINCT FROM 'TABLE(invoice_id uuid, paid_txn_minor bigint, paid_base_minor bigint, outstanding_txn_minor bigint, outstanding_base_minor bigint)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live set-based invoice_outstanding is not 0083''s five-column form (found %), so 0084''s subject is not there',
      pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID[])')) USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'));
  IF v_def NOT LIKE '%payment_allocations%' OR v_def NOT LIKE '%customer_credit_applications%' OR v_def NOT LIKE '%settlement_mode%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live set-based invoice_outstanding is not the 0083 reader-of-record, so 0084 has no subject'
      USING ERRCODE = 'P0001';
  END IF;
  FOR v_def IN
    SELECT pg_get_functiondef(f.oid)
      FROM (SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)') AS oid
            UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
  LOOP
    IF v_def NOT LIKE '%JOIN public.invoices i ON i.business_id = p_business_id AND i.id = o.invoice_id%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: an AR reader does not join public.invoices back onto the array call, so the fixed cost 0084 removes is not there to remove'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF to_regprocedure('public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)') IS NOT NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a customer_open_invoices_page already exists, so 0084 has nothing to add'
      USING ERRCODE = 'P0001';
  END IF;

  -- (3) PRE-STATE CAPTURE (the `0061:104-116` shape, as `0080`, `0081` and
  --     `0083:210` took it). Owner, security, pinned path and ACL of each
  --     routine this file is about to DROP or REPLACE, as one string per
  --     routine, transaction-local and compared in this same transaction's
  --     end state by 0084-E(5). THIS CAPTURE MATTERS MORE HERE THAN IT DID IN
  --     `0083`: three of the four routines are DROPPED, and a drop takes the
  --     whole ACL with it, so the post block is proving that §5, §6 and §7 put
  --     back exactly what came down and not something close to it.
  PERFORM set_config('daftar.p4s4c_0084_pre_readers',
    (SELECT pg_catalog.string_agg(
              format('%s=%s|%s|%s|%s', f.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                     coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-')),
              E'\n' ORDER BY f.oid::regprocedure::text)
       FROM (SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID)') AS oid
             UNION ALL SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID[])')
             UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
             UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
       JOIN pg_proc p ON p.oid = f.oid), true);
  -- And `invoice_settlement_state`, which must come out BYTE-IDENTICAL: it
  -- inherits every change here by composition over the single-invoice
  -- wrapper, and a copy of anything from §5 inside it would be a second place
  -- to keep right.
  PERFORM set_config('daftar.p4s4c_0084_pre_state_reader',
    pg_get_functiondef(to_regprocedure('public.invoice_settlement_state(UUID, UUID)')), true);
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The two AR readers come down FIRST, because they are `LANGUAGE sql` and
--    therefore hold catalogue dependencies on the array form. WITHOUT
--    `CASCADE`: a dependency nobody expected is an error here, not a silent
--    removal. They are recreated in §6, which is the only place their ACL
--    comes back.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION public.customer_ar_outstanding(UUID, UUID);
DROP FUNCTION public.customer_ar_aging(UUID, UUID, DATE, INTEGER[]);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. And then the array form itself. A `RETURNS TABLE` change is a DROP and a
--    CREATE; `CREATE OR REPLACE FUNCTION` refuses to change the return type.
--    The single-invoice wrapper is `LANGUAGE plpgsql` and resolves its callee
--    at RUN time, so it holds no catalogue dependency here and survives this
--    statement without `CASCADE` — which is exactly why R-100's ordering
--    (wrapper in plpgsql, array form last) is load-bearing twice over.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION public.invoice_outstanding(UUID, UUID[]);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The single-invoice reader-of-record, still a THIN WRAPPER.
--
--    `CREATE OR REPLACE`, so its owner, STABLE standing, SECURITY INVOKER
--    standing, pinned path and whole ACL are kept rather than restored, and
--    0084-E(5) reads that back. Its RETURN TYPE DOES NOT MOVE: the four
--    figures and only those, which is why every caller in the estate — the
--    API's `invoice_outstanding(i.business_id, i.id)` reads,
--    `invoice_settlement_state` (`0075:760`), the allocation command's
--    recompute under the locks (`0081:2086`, `0081:2366`) — keeps calling
--    exactly what it called before and gets exactly the same four numbers.
--    The two new passthrough columns are selected and discarded here BY NAME,
--    which is also why appending them rather than inserting them (R-104-A)
--    keeps this wrapper's own projection honest.
--
--    THE REDUCER RELATIONS ARE NOT NAMED HERE, and that is the point: this
--    body holds no arithmetic, so there is nothing in it to disagree with §5.
--    It reads the reducers THROUGH that definition.
--
--    AND IT IS WRITTEN BEFORE §5 ON PURPOSE (R-100, R-107). It is the ONLY
--    place in this file where the statement order departs from the numbered
--    list in the contract, which puts the array form at step 4 and this
--    wrapper at step 5 — and the contract's own prose at that step says why it
--    cannot be read that way: «R-100 requires the array form to be the last
--    definition of `invoice_outstanding` for seam S-P4-03». Both cannot hold.
--    `scripts/phase4-s1-gate.ts` decides it: `phase4RoutineBody` takes the
--    LAST `CREATE … FUNCTION invoice_outstanding` in the whole Phase 4 DDL and
--    requires it to name every relation that settles an invoice, so with this
--    wrapper written last the seam reports «invoice_outstanding does not read
--    customer_credit_applications, payment_allocations» — MEASURED, not
--    reasoned about. `0083` is arranged the same way for the same reason. The
--    DROP order of §2 and §3 is the contract's exactly; no signature moves;
--    only these two CREATEs trade places. Being `LANGUAGE plpgsql`, this
--    wrapper resolves its callee at RUN time, so it replaces cleanly here even
--    though §3 has just dropped the body it delegates to.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RETURN QUERY
    SELECT o.paid_txn_minor, o.paid_base_minor, o.outstanding_txn_minor, o.outstanding_base_minor
      FROM public.invoice_outstanding(p_business_id, ARRAY[p_invoice_id]) o;
END;
$fn$;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID) IS
  'P4-S1, replaced by P4-S4 (0080, 0081, 0083, then 0084; P4-AL-05, P4-AL-07, seam S-P4-03). The reader-of-record of ONE invoice paid and outstanding amount, which is refused as a stored column by P4-AL-06. Since 0083 it is a THIN WRAPPER and holds no arithmetic of its own: it asks invoice_outstanding(business, invoice_id[]) — the one definition of the settlement sum — about a one-element array and projects the four figures by name. Every rule (the invoice.not_found refusal, the draft/void zeros, 0080''s cash-settled branch, the UNION ALL over the reducer set, paid_base as the sum of the carrying released) lives there and is kept in exactly one place. Its return type has never moved. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. THE ONE DEFINITION OF THE SETTLEMENT SUM, with the two passthrough
--    columns APPENDED (R-104, R-104-A).
--
--    It is the LAST definition of `invoice_outstanding` in this file on
--    purpose (R-100, R-107): seam S-P4-03 reads the last Phase 4 definition
--    of that name and asks whether it names every relation that settles an
--    invoice. This is that body.
--
--    ONE STATEMENT. The reducer SET is a `UNION ALL` — not two hard-coded
--    sums — so a later slice appends one branch here and nothing else in the
--    estate moves. It is restricted to the invoices asked about on BOTH
--    branches, so the scan is an index range per branch and never the
--    business's whole settlement history, and it is aggregated ONCE, grouped
--    by invoice, and LEFT JOINed to `invoices`: an invoice with NO reducer
--    keeps its row and reports the whole total outstanding, which is the case
--    a plain join would silently drop.
--
--    `paid_base` is the sum of the CARRYING RELEASED and never a conversion
--    of the paid transaction amount, because the cumulative identity
--    `Sigma rel = HALF_EVEN(B . Sigma a, T)` is what makes `outstanding_base`
--    EXACTLY zero when the last reducer closes the invoice (`0081`'s own
--    note). No arithmetic primitive is redefined and none is needed here:
--    this routine SUMS figures the writers already computed under their locks.
--
--    IT ALSO RETURNS THE INVOICE'S OWN `currency_code` AND `due_date`, as the
--    LAST TWO columns. Those come off the `invoices` row this body already
--    has to read, they cost it nothing, and they are what lets the two AR
--    readers in §6 stop joining `invoices` back onto this call and the page
--    reader in §7 never join it at all. THEY ARE PASSTHROUGH, NOT ARITHMETIC:
--    no settlement figure is computed twice anywhere, which is the whole of
--    P4-AL-07.
--
--    The `invoice.not_found` refusal is kept, in the one form that serves
--    every shape: the result carries one row per invoice FOUND, and if that is
--    fewer than the distinct ids asked about, an id named an invoice this
--    caller cannot see — under row security that is also how a cross-business
--    id answers "not found" rather than "forbidden" (G-02). The rows a failed
--    call had already queued are discarded with the exception.
--
--    THE CHECK IS FREE WHEN IT PASSES (R-104). `ROW_COUNT` is one row per
--    invoice FOUND, so ROW_COUNT <= distinct(ids) <= cardinality(ids) always;
--    `ROW_COUNT = cardinality` therefore forces all three equal and leaves no
--    refusal possible. The distinct count — a whole second statement over the
--    array, which `0083` ran on EVERY call — is paid for only when the fast
--    comparison already differs, which happens only when an id is missing or
--    repeated. `cardinality(NULL)` is NULL and is read as 0, exactly as
--    `unnest(NULL)` was no rows.
--
--    STABLE and SECURITY INVOKER like every reader of record (R-P4-07):
--    `daftar_app` holds SELECT on `invoices`, `sales` and both reducers, so a
--    definer read would bypass their row security and grant new authority for
--    nothing. TAGGED dollar quotes throughout this file: an untagged `$$`
--    body nested inside a `DO` block has bitten this repository before.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])
RETURNS TABLE (invoice_id UUID, paid_txn_minor BIGINT, paid_base_minor BIGINT,
               outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT,
               currency_code TEXT, due_date DATE)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
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
                ELSE (i.total_base_minor - coalesce(r.paid_base, 0))::BIGINT END,
           i.currency_code::TEXT,
           i.due_date
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
  -- distinct count below is the SAME count `0083` ran unconditionally, and it
  -- decides the SAME comparison — it is simply not paid for on the calls that
  -- cannot refuse.
  IF v_found <> coalesce(pg_catalog.cardinality(p_invoice_ids), 0) THEN
    SELECT pg_catalog.count(*) INTO v_asked FROM (SELECT DISTINCT x.id FROM pg_catalog.unnest(p_invoice_ids) AS x(id)) k;
    IF v_found <> v_asked THEN
      RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION invoice_outstanding(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_outstanding(UUID, UUID[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID[]) IS
  'P4-S4 (0083, replaced by 0084; P4-AL-05, P4-AL-07, seam S-P4-03): THE ONE DEFINITION of the settlement sum, set-based. For each invoice asked about: the total minus the sum of invoice_amount_applied_minor over its payment allocations and its customer credit applications, with the paid base the sum of invoice_carrying_base_released_minor so the base closes to zero exactly when the last reducer closes the invoice. A cash-settled invoice reports paid = total and outstanding = 0 (0080). A draft or void document reports zeros. An id that names no invoice this caller can see raises invoice.not_found, and the non-vacuity check that decides that costs a second statement only on the calls where a refusal is reachable at all. Since 0084 it also returns the invoice''s own currency_code and due_date, APPENDED after the four figures so a positional reader stays valid — passthrough off the invoices row it already reads, which is what lets the AR readers stop joining invoices back onto this call and the page reader never join it. ONE pass over the reducer set grouped by invoice, which is why an AR sum over n invoices is one statement and not n function calls; invoice_outstanding(business, invoice) is a thin wrapper over this and holds no arithmetic, and customer_open_invoices_page reads it one bounded chunk at a time. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal. Replaced by the slice that adds a reducer relation, which appends one UNION ALL branch.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The two AR readers, recreated, each naming `invoices` EXACTLY ONCE.
--
--    The only change against `0083` is that the `JOIN public.invoices` that
--    recovered `currency_code` and `due_date` IS GONE: both columns come out
--    of the array call itself, off the `invoices` row the one definition had
--    already read (R-104). Each body now names `invoices` once, in the
--    subquery that collects the customer's open invoice ids — the same single
--    index scan on `invoices_customer_idx` the pre-`0083` reader made. The
--    output columns, the `GROUP BY`, the `HAVING sum(...) <> 0`, the bucket
--    arithmetic and the refusal to read the clock (P4-AL-30) are unchanged.
--
--    These are CREATEs and not REPLACEs because §2 dropped them, so the
--    `REVOKE`/`GRANT` pair below each one is what restores the ACL a drop took
--    away. 0084-E(5) compares the result against 0084-P's capture.
--
--    `array_agg` over no rows is NULL, `= ANY(NULL)` is no rows, and §5 reads
--    a NULL array as the empty one, so a customer with no open invoice still
--    gets the empty answer it got before — which is what a cross-business
--    read sees once row security has hidden every invoice, and what
--    `01-cross-tenant.golden.test.ts:565` asserts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION customer_ar_outstanding(p_business_id UUID, p_customer_id UUID)
RETURNS TABLE (currency_code TEXT, txn_minor BIGINT, base_minor BIGINT)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
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
$fn$;
REVOKE ALL ON FUNCTION customer_ar_outstanding(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_ar_outstanding(UUID, UUID) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION customer_ar_outstanding(UUID, UUID) IS
  'P4-S1, replaced by P4-S4 (0083, then 0084; P4-AL-05, P4-AL-06): the reader-of-record of a customer receivable, per transaction currency, which is refused as a stored balance column. Computed from the open invoices, never from a cached total. Since 0083 it makes ONE call to the set-based invoice_outstanding over the customer''s open invoices instead of one call per invoice; since 0084 it takes the currency off that call rather than joining invoices back onto it, so it visits invoices exactly once. A change of WORK and not of ANSWER.';

CREATE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])
RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
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
$fn$;
REVOKE ALL ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) IS
  'P4-S1, replaced by P4-S4 (0083, then 0084; P4-AL-05): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. There is no materialised aging table (P4-AL-06) and the routine does not read the clock (P4-AL-30). Since 0083 it makes ONE call to the set-based invoice_outstanding over the customer''s open invoices instead of one call per invoice; since 0084 it takes the currency and the due date off that call rather than joining invoices back onto it, so it visits invoices exactly once. The buckets, the thresholds and the answer are unchanged.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7. THE OPEN-INVOICE PAGE READER (R-105, R-106).
--
--    The first `p_limit` invoices of this customer that still have something
--    outstanding, in `(issue_date, id)` order, after the keyset
--    `(p_after_issue_date, p_after_id)` — where the CURSOR IS PRESENT exactly
--    when `p_after_id IS NOT NULL` and a NULL date beside it is resolved HERE
--    through the primary key (A1-2). A BOUNDED CHUNKED KEYSET walk, with
--    ONE set-based call to §5 per chunk and NO settlement arithmetic of its
--    own — every figure it returns came out of the one definition.
--
--    WHY A LOOP AT ALL. The predicate `outstanding <> 0` is not a predicate on
--    any table: it is the answer of the settlement sum. So it cannot be pushed
--    into the candidate scan, and a `LIMIT` placed outside a per-row LATERAL
--    cannot stop the walk. The loop is what makes the walk pay for the
--    settlement sum ONE CHUNK AT A TIME instead of one invoice at a time,
--    while still stopping as soon as the page is full.
--
--    SEMANTICS (§13). Chunks are taken in `(issue_date, id)` order and each
--    chunk is ordered and limited internally, so the concatenation is in
--    global order; `GET DIAGNOSTICS ... ROW_COUNT` counts what was emitted and
--    the inner `LIMIT` shrinks by it. This NEVER takes the first `p_limit`
--    candidates and drops the zero-outstanding ones afterwards.
--
--    THE CASH PRE-FILTER IS AN ELIGIBILITY TEST, NOT A SECOND BALANCE (§8).
--    `s.settlement_mode <> 'cash'` computes nothing. `0080`'s law and §5's own
--    `WHEN s.settlement_mode = 'cash' THEN 0` together say that a cash-settled
--    invoice's outstanding is 0 for ALL data, so it can never satisfy `<> 0`;
--    excluding it removes only rows the filter would have removed. The
--    identical-result-set test is owed and is given beside this file.
--
--    THE SETTLED-CREDIT TAIL has no such test and does not get one: a fully
--    paid credit invoice is indistinguishable from an unpaid one without the
--    settlement sum. The CHUNKING is its answer, and the plan evidence proves
--    it bounded and set-oriented rather than moved.
--
--    `v_ids` and `v_dates` are built as PARALLEL SORTED ARRAYS in one
--    statement, so the chunk's `issue_date` values — which the page returns and
--    which drive the keyset — come off the CANDIDATE SCAN and not from a
--    second visit to `invoices`. The array form is asked once per chunk and
--    joined to those arrays by id.
--
--    `ROWS 51`, AND WHY THIS IS THE ONE PLACE A `ROWS` CLAUSE IS RIGHT. A
--    function carrying a `SET` clause cannot be inlined and, with no `ROWS`,
--    the planner estimates its output at the DEFAULT 1 000 rows. Measured, on
--    the app's own statement, that estimate made PostgreSQL prefer a HASH JOIN
--    whose inner side was a SEQ SCAN OF EVERY INVOICE IN THE BUSINESS — the
--    very shape R-104 had just removed from the AR readers, reappearing in the
--    app's join to recover `document_kind`, `document_number` and
--    `total_txn_minor`. R-108 refuses a `ROWS` clause on the ARRAY FORM
--    because one constant cannot be right for a three-invoice median and a
--    two-thousand-invoice tail. THIS ROUTINE IS THE OPPOSITE CASE: its output
--    is bounded BY CONSTRUCTION at `p_limit`, and the product's own
--    `CustomerOpenInvoicesQuerySchema` caps `limit` at 50, so the `limit + 1`
--    probe makes 51 the EXACT UPPER BOUND of every call the API can make. 51
--    is therefore a true ceiling and not a guess at a typical case, and with
--    it the app's join becomes a nested loop of at most 51 `invoices_pkey`
--    probes — bounded by the PAGE and not by the business, which is the whole
--    difference. 0084-E(4) reads `prorows` back from the catalogue so the
--    shape cannot regress silently.
--
--    STABLE, SECURITY INVOKER, pinned path, EXECUTE for exactly the two
--    accepted roles: a reader of record like the other three (R-P4-07). RLS is
--    neither bypassed nor weakened — a candidate the caller cannot see never
--    enters `v_ids`, which is also why §5's `invoice.not_found` is unreachable
--    from here.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION customer_open_invoices_page(p_business_id UUID, p_customer_id UUID,
                                            p_after_issue_date DATE, p_after_id UUID,
                                            p_limit INTEGER)
RETURNS TABLE (invoice_id UUID, issue_date DATE,
               paid_txn_minor BIGINT, paid_base_minor BIGINT,
               outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT,
               currency_code TEXT, due_date DATE)
LANGUAGE plpgsql STABLE ROWS 51 SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  -- THE CHUNK SIZE, the one documented constant here: four pages' worth per
  -- round trip, floored at 64 so a tiny `p_limit` still amortises the call.
  -- At the app's `limit + 1 = 51` that is 204 candidates per chunk. It trades
  -- round trips against work spent on candidates the page will not reach, and
  -- the plan evidence beside this file is what settled it.
  -- `GREATEST` is a SQL CONSTRUCT and not a function, so it is NOT schema
  -- qualified: `pg_catalog.greatest(...)` does not resolve, and the pinned
  -- `search_path` is what makes the bare form safe here anyway.
  c_chunk     CONSTANT INTEGER := greatest(p_limit * 4, 64);
  v_emitted   INTEGER := 0;
  v_added     INTEGER;
  v_got       INTEGER;
  v_ids       UUID[];
  v_dates     DATE[];
  v_cur_date  DATE := p_after_issue_date;
  v_cur_id    UUID := p_after_id;
BEGIN
  -- A page of nothing is nothing, and a NULL limit is not a request for every
  -- invoice the customer ever had. ZERO ROWS, and NO REFUSAL: an empty page is
  -- well defined and owes none (A1-2).
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN;
  END IF;

  -- THE CURSOR IS PRESENT EXACTLY WHEN `p_after_id IS NOT NULL` (A1-2). When
  -- the date is NULL beside a non-null id, THIS READER resolves it, through the
  -- primary key `(business_id, id)` — one bounded index probe, inside the one
  -- statement sequence the reader already runs. That keeps §14's requirement
  -- that the continuation key carry EVERY ordering component true INSIDE the
  -- reader rather than by trusting the caller, and it lets the app drop a
  -- per-request read of `invoices` under row security, which is a read this
  -- correction is otherwise busy removing (A1-3).
  --
  -- A cursor id that resolves to nothing — no such invoice, or one this caller
  -- cannot see — leaves `v_cur_date` NULL, the row comparison below evaluates
  -- to NULL for every candidate, and the page comes back EMPTY. THAT IS
  -- DELIBERATE AND IT IS NOT A REFUSAL: this reader adds no `P0001` of its own,
  -- because a read path that raises one is how `0078` came to misread an
  -- internal invariant as an authorization denial. The only refusal reachable
  -- through this reader stays `invoice.not_found` from the ONE definition.
  IF p_after_id IS NOT NULL AND v_cur_date IS NULL THEN
    SELECT i.issue_date INTO v_cur_date
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.id = p_after_id;
  END IF;

  LOOP
    -- ONE STATEMENT for the chunk: the next `c_chunk` ELIGIBLE candidates in
    -- `(issue_date, id)` order after the cursor, as two parallel arrays
    -- sorted the same way, plus how many there were. The scan is
    -- `invoices_customer_idx` in exactly the page's order; the `sales`
    -- predicate resolves through `sales_pkey` over this bounded chunk.
    -- `p_after_id IS NULL` is the first page: the keyset is then unrestricted
    -- rather than compared against NULL, which would match nothing.
    SELECT pg_catalog.array_agg(c.id ORDER BY c.issue_date, c.id),
           pg_catalog.array_agg(c.issue_date ORDER BY c.issue_date, c.id),
           pg_catalog.count(*)::INTEGER
      INTO v_ids, v_dates, v_got
      FROM (
        SELECT i.id, i.issue_date
          FROM public.invoices i
          JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
         WHERE i.business_id = p_business_id
           AND i.customer_id = p_customer_id
           AND i.status = 'open'
           AND s.settlement_mode <> 'cash'
           AND (v_cur_id IS NULL OR (i.issue_date, i.id) > (v_cur_date, v_cur_id))
         ORDER BY i.issue_date, i.id
         LIMIT c_chunk
      ) c;

    -- The candidates ran out.
    EXIT WHEN v_got = 0;

    -- ONE set-based call over the whole chunk, and the filter applied to its
    -- ANSWER. `issue_date` comes from the candidate arrays, so `invoices` is
    -- not visited a second time. At most the page's remaining room is emitted.
    RETURN QUERY
      SELECT o.invoice_id, k.issue_date,
             o.paid_txn_minor, o.paid_base_minor,
             o.outstanding_txn_minor, o.outstanding_base_minor,
             o.currency_code, o.due_date
        -- `ROWS FROM (unnest(a), unnest(b))` and not `unnest(a, b)`: the
        -- multi-argument spelling is PARSER GRAMMAR that expands to exactly
        -- this, and being grammar it cannot be schema qualified
        -- (`pg_catalog.unnest(uuid[], date[])` does not resolve). This form is
        -- the same expansion written out, and it keeps every call qualified.
        FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_dates)) AS k(id, issue_date)
        JOIN public.invoice_outstanding(p_business_id, v_ids) o ON o.invoice_id = k.id
       WHERE o.outstanding_txn_minor <> 0
       ORDER BY k.issue_date, k.id
       LIMIT (p_limit - v_emitted);
    GET DIAGNOSTICS v_added = ROW_COUNT;
    v_emitted := v_emitted + v_added;

    -- The page is full, or this chunk was short and so there is no next one.
    EXIT WHEN v_emitted >= p_limit;
    EXIT WHEN v_got < c_chunk;

    -- Advance the cursor to the chunk's LAST CANDIDATE — not to its last
    -- EMITTED row, which would re-walk every candidate the filter rejected.
    v_cur_date := v_dates[v_got];
    v_cur_id   := v_ids[v_got];
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER) IS
  'P4-S4 (0084; P4-AL-05, P4-AL-07, OD-P4-03): the first p_limit invoices of this customer that still have something outstanding, in (issue_date, id) order after the keyset (p_after_issue_date, p_after_id). The cursor is PRESENT exactly when p_after_id IS NOT NULL; a NULL p_after_issue_date beside a non-null id is resolved by this routine through the primary key, so the continuation key always carries every ordering component and the caller needs no probe of its own. p_limit <= 0 returns zero rows, and a cursor id that resolves to nothing returns an empty page — neither is a refusal, because this reader adds none of its own. A BOUNDED CHUNKED KEYSET walk: per iteration the next chunk of eligible candidates in page order, ONE set-based call to invoice_outstanding(business, invoice_id[]) over that chunk, the outstanding <> 0 filter applied to its ANSWER, at most the page''s remaining room emitted, and the cursor advanced to the chunk''s last candidate. It performs NO settlement arithmetic of its own — every figure it returns came out of the one definition — and it does not derive settlement_state, which would be a second copy of the state law; the caller asks invoice_settlement_state for the rows it actually got. The cash pre-filter (sales.settlement_mode <> cash) is an ELIGIBILITY test and not a balance: 0080 makes a cash-settled invoice''s outstanding 0 for all data, so it can never satisfy <> 0. STABLE, INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. 0084-E: the end state, read from the live catalogues and never from this
--    file's own statements (R-P4-08).
--
--    A DISCOVERED SUBJECT WHOSE DEFINITION CANNOT BE READ IS A FINDING AND
--    RAISES. It is never skipped: a loop that `continue`s past an unreadable
--    routine reports green for a routine it never looked at, and a false
--    green of exactly that shape was found in this slice already.
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def  TEXT;
  v_name TEXT;
  v_seen INTEGER;
BEGIN
  -- 0084-E(1). THE ONE DEFINITION IS IN THE LIVE CATALOGUE, with the two
  -- columns APPENDED, and it still reads both reducers, the invoice, its
  -- sale's settlement mode and nothing cached. The signature is checked
  -- against the coordinator-fixed one EXACTLY: a definition that dropped
  -- `currency_code`, or inserted it before the figures instead of after them,
  -- would leave §6 and §7 reading a column that is not where they think.
  IF to_regprocedure('public.invoice_outstanding(UUID, UUID[])') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding is not in the catalogue' USING ERRCODE = 'P0001';
  END IF;
  IF pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'))
     IS DISTINCT FROM 'TABLE(invoice_id uuid, paid_txn_minor bigint, paid_base_minor bigint, outstanding_txn_minor bigint, outstanding_base_minor bigint, currency_code text, due_date date)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding does not carry the two appended columns in the fixed order (found %)',
      pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID[])')) USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding is in the catalogue but its definition cannot be read'
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications', 'settlement_mode', 'invoice.not_found',
                                'currency_code', 'due_date'] LOOP
    IF v_def NOT LIKE '%' || v_name || '%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding does not carry %', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 0084-E(2). AND THERE IS EXACTLY ONE COPY OF IT (P4-AL-07). The
  -- single-invoice reader names NEITHER reducer and holds no total, because it
  -- does no arithmetic: it delegates to the array form. A body that named a
  -- reducer here would be a second settlement sum, which is the one thing
  -- this reshaping must not buy its speed with.
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the single-invoice invoice_outstanding is missing or its definition cannot be read'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def LIKE '%payment_allocations%' OR v_def LIKE '%customer_credit_applications%' OR v_def LIKE '%total_txn_minor%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the single-invoice invoice_outstanding carries settlement arithmetic of its own, so there are two copies'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def NOT LIKE '%invoice_outstanding(p_business_id, ARRAY[p_invoice_id])%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the single-invoice invoice_outstanding does not delegate to the set-based definition'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID)'))
     IS DISTINCT FROM 'TABLE(paid_txn_minor bigint, paid_base_minor bigint, outstanding_txn_minor bigint, outstanding_base_minor bigint)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the single-invoice invoice_outstanding return type moved, so a caller of 0081''s shape no longer gets what it asked for'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0084-E(3). NEITHER AR READER CALLS THE READER PER INVOICE, NEITHER JOINS
  -- `public.invoices` AT ALL ANY MORE, and NEITHER READS A REDUCER RELATION
  -- DIRECTLY. This is both defects' structural half, read back from the
  -- catalogue. The subject count is asserted too: two routines were looked
  -- for and two must have been examined, so a `to_regprocedure` that came
  -- back NULL cannot pass for a clean loop.
  v_seen := 0;
  FOR v_name IN
    SELECT f.sig
      FROM (SELECT 'public.customer_ar_outstanding(UUID, UUID)' AS sig
            UNION ALL SELECT 'public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])') f
  LOOP
    IF to_regprocedure(v_name) IS NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % is not in the catalogue after 0084 recreated it', v_name
        USING ERRCODE = 'P0001';
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(v_name));
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % exists but its definition cannot be read, which is a FINDING and not a routine to skip', v_name
        USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen + 1;
    IF v_def LIKE '%JOIN LATERAL public.invoice_outstanding(i.business_id, i.id)%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % still calls invoice_outstanding once per invoice', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF v_def NOT LIKE '%public.invoice_outstanding(%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % no longer reads the reader-of-record at all', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF v_def LIKE '%payment_allocations%' OR v_def LIKE '%customer_credit_applications%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % reads a reducer relation directly, which is a second copy of the settlement sum', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- R-104, from the catalogue: `public.invoices` appears EXACTLY ONCE — the
    -- subquery that collects the open invoice ids — and never a second time to
    -- recover the currency or the due date, which §5 now returns. `JOIN
    -- public.invoices` must not appear at all. Two occurrences of the relation
    -- name means the re-join is back; none means the open-invoice subquery is
    -- gone.
    IF v_def LIKE '%JOIN public.invoices%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % joins public.invoices, which is the fixed cost R-104 removed', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.array_length(pg_catalog.string_to_array(v_def, 'public.invoices'), 1) <> 2 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the AR reader % does not name public.invoices exactly once', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0084-E(3) examined % AR readers and not 2', v_seen USING ERRCODE = 'P0001';
  END IF;

  -- 0084-E(4). THE PAGE READER EXISTS, carries the fixed signature, DOES READ
  -- the one definition, and holds NO settlement arithmetic of its own: it
  -- names neither reducer, computes no total, and does not derive
  -- `settlement_state`. The `sales` reference it DOES carry is the cash
  -- eligibility test, which computes no balance (R-106).
  IF to_regprocedure('public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page is not in the catalogue' USING ERRCODE = 'P0001';
  END IF;
  IF pg_get_function_result(to_regprocedure('public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)'))
     IS DISTINCT FROM 'TABLE(invoice_id uuid, issue_date date, paid_txn_minor bigint, paid_base_minor bigint, outstanding_txn_minor bigint, outstanding_base_minor bigint, currency_code text, due_date date)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page does not carry the fixed signature (found %)',
      pg_get_function_result(to_regprocedure('public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)')) USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)'));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page exists but its definition cannot be read, which is a FINDING and not a routine to skip'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def NOT LIKE '%public.invoice_outstanding(p_business_id, v_ids)%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page does not make a set-based call to the one definition'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def LIKE '%payment_allocations%' OR v_def LIKE '%customer_credit_applications%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page reads a reducer relation directly, which is a second copy of the settlement sum'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def LIKE '%total_txn_minor%' OR v_def LIKE '%total_base_minor%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page names an invoice total, so it is computing a settlement figure of its own'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def LIKE '%invoice_settlement_state%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page derives settlement_state, which is a second copy of the state law'
      USING ERRCODE = 'P0001';
  END IF;
  -- And the `ROWS 51` estimate, read back from the catalogue: without it the
  -- planner's default 1 000 makes the app's bounded join to `invoices` plan as
  -- a hash join over the business's whole invoice set, which is the scan
  -- R-104 removed reappearing one level up.
  IF (SELECT p.prorows FROM pg_proc p WHERE p.oid = to_regprocedure('public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)'))
     IS DISTINCT FROM 51::FLOAT4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_open_invoices_page does not declare ROWS 51, so its caller''s join is planned against the default 1 000-row estimate'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0084-E(5). ONLY THE BODIES AND THE TWO APPENDED COLUMNS MOVED. Owner,
  -- SECURITY INVOKER standing, the pinned path and the WHOLE ACL of all four
  -- routines 0084-P captured compare EQUAL to that capture — and three of
  -- them were DROPPED, so this is the proof that the `REVOKE`/`GRANT` pairs in
  -- §5, §6 and §7 put back exactly what the drops took away and nobody gained
  -- EXECUTE on the way through.
  IF (SELECT pg_catalog.string_agg(
               format('%s=%s|%s|%s|%s', f.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                      coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-')),
               E'\n' ORDER BY f.oid::regprocedure::text)
        FROM (SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID)') AS oid
              UNION ALL SELECT to_regprocedure('public.invoice_outstanding(UUID, UUID[])')
              UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
              UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f
        JOIN pg_proc p ON p.oid = f.oid)
     IS DISTINCT FROM current_setting('daftar.p4s4c_0084_pre_readers', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a drop-and-recreate changed the owner, security, path or ACL of a reader of record'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0084-E(6). And the accepted configuration stated ABSOLUTELY, over all
  -- FOUR routines including the new page reader — a capture compared against
  -- itself proves nothing if the configuration was already wrong before this
  -- file ran, and the page reader has no capture at all because it did not
  -- exist. STABLE, invoker's rights, the pinned `search_path`, EXECUTE for
  -- exactly the two accepted roles, and NOTHING for PUBLIC. The subject count
  -- is asserted: four were looked for and four must have been examined.
  v_seen := 0;
  FOR v_name IN
    SELECT f.sig
      FROM (SELECT 'public.invoice_outstanding(UUID, UUID)' AS sig
            UNION ALL SELECT 'public.invoice_outstanding(UUID, UUID[])'
            UNION ALL SELECT 'public.customer_ar_outstanding(UUID, UUID)'
            UNION ALL SELECT 'public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])'
            UNION ALL SELECT 'public.customer_open_invoices_page(UUID, UUID, DATE, UUID, INTEGER)') f
  LOOP
    IF to_regprocedure(v_name) IS NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not in the catalogue, so its configuration cannot be proved', v_name
        USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen + 1;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure(v_name)
                      AND p.provolatile = 's' AND NOT p.prosecdef
                      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not a STABLE, SECURITY INVOKER routine with its pinned search_path', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text)
          FROM pg_proc p, aclexplode(p.proacl) x
         WHERE p.oid = to_regprocedure(v_name) AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner)
       IS DISTINCT FROM ARRAY['daftar_app', 'daftar_inventory_internal'] THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: EXECUTE on % is not exactly the two accepted roles', v_name USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = to_regprocedure(v_name) AND x.grantee = 0) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: PUBLIC holds a privilege on %', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF v_seen <> 5 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0084-E(6) examined % routines and not 5', v_seen USING ERRCODE = 'P0001';
  END IF;

  -- 0084-E(7). `invoice_settlement_state`'S OWN TEXT IS BYTE-IDENTICAL — and
  -- that is the claim, precisely (A1-4). `pg_get_functiondef` of that routine
  -- comes out character for character as 0084-P captured it; what DOES change
  -- is the scalar `invoice_outstanding` its body RESOLVES TO at run time, and
  -- that is seam S-P4-03 working exactly as designed rather than a drift. So
  -- this assertion is about the TEXT and deliberately NOT about the resolved
  -- callee: it inherits everything here by composition over the single-invoice
  -- wrapper, which is the whole value of the seam, and a copy of anything from
  -- §5 inside it would be a second place to keep right.
  IF pg_get_functiondef(to_regprocedure('public.invoice_settlement_state(UUID, UUID)'))
     IS DISTINCT FROM current_setting('daftar.p4s4c_0084_pre_state_reader', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0084 changed the TEXT of invoice_settlement_state (pg_get_functiondef differs from the 0084-P capture); this is about that routine''s own body and not about which invoice_outstanding it resolves to, which 0084 does change by design'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0084-E(8). NO SECOND TRUTH WAS CREATED. This file adds no relation, no
  -- materialised view, no column and no trigger: there is nowhere a balance
  -- could have been stored.
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
