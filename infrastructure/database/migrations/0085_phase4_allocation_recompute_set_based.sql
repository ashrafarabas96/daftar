-- 0085_phase4_allocation_recompute_set_based.sql
-- Phase 4 / P4-S4 CORRECTIVE — THE ALLOCATION RECOMPUTE, SET-BASED. ONE
-- ROUTINE, THREE HUNKS, NO NEW ANSWER.
--
-- `public.customer_collect_payment` (`0081:1775-2191`) recomputes each
-- allocated invoice's outstanding amount under the locks step 6 already
-- holds, and it did so by calling the SCALAR
-- `invoice_outstanding(v_business, p_invoice_ids[v_i])` ONCE PER INVOICE
-- inside step 11's ordered loop (`0081:2086`). Since `0083` that scalar form
-- is a THIN WRAPPER with no arithmetic of its own over
-- `invoice_outstanding(UUID, UUID[])`, THE ONE DEFINITION — so that loop was
-- already calling the array form N times with a ONE-element array. This file
-- calls it ONCE with the N-element array, before the loop, under the same
-- locks, and the loop reads position `v_i` out of the result.
--
-- `0083`'s own sentence, applied to the one caller `0083` left scalar: it is
-- A CHANGE OF WORK AND NOT OF ANSWER. The same function, the same snapshot,
-- the same locks, the same figures, the same refusals in the same order.
--
-- THE THREE HUNKS, and there are exactly three — diffed against
-- `0081:1775-2191` byte for byte:
--
--   1. a new DECLARE, `v_outs BIGINT[]`;
--   2. ONE set-based call to `invoice_outstanding(v_business, p_invoice_ids)`
--      immediately before the ordered loop, filling `v_outs` in array order;
--   3. `SELECT o.outstanding_txn_minor INTO v_o
--        FROM invoice_outstanding(v_business, p_invoice_ids[v_i]) o;`
--      becomes `v_o := v_outs[v_i];`.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080`-`0084` are CANDIDATE
-- and are BYTE-FOR-BYTE UNTOUCHED: this file is append-only and corrects
-- FORWARD, which is how a defect in an already-applied migration is repaired
-- here (`0072` is the Phase 3 precedent; `0082`, `0083` and `0084` are this
-- slice's own). `MIGRATION_MANIFEST.json` is untouched and `frozenThrough`
-- stays `0079`.
--
-- ── WHY THE POSITIONAL READ IS SAFE, AND WHAT IT DEPENDS ON ──────────────
--
-- `v_outs[v_i]` is only correct if `v_outs` is DENSE and EXACTLY `v_n` long,
-- with position `k` holding the outstanding amount of `p_invoice_ids[k]`. It
-- is, and the reason is THREE REFUSALS THAT ALREADY FIRE UPSTREAM OF STEP 6.
-- Line numbers are RELATIVE to this routine's `CREATE OR REPLACE`, which is
-- `0081:1775`, so relative line 163 is `0081:1937`. `v_n` is
-- `coalesce(cardinality(p_allocation_ids), 0)`, set at relative line 152:
--
--   — relative 163, `p_invoice_ids IS NULL OR
--     coalesce(cardinality(p_invoice_ids), 0) <> v_n` — refuses a LENGTH
--     MISMATCH, so `p_invoice_ids` and `p_allocation_ids` are asserted
--     PARALLEL and `cardinality(p_invoice_ids) = v_n`;
--   — relative 172, `array_position(p_invoice_ids, NULL) IS NOT NULL` —
--     refuses a NULL ELEMENT;
--   — relative 178, `(SELECT count(DISTINCT x.id)
--     FROM unnest(p_invoice_ids) AS x(id)) <> v_n` — refuses a DUPLICATE.
--
-- Together those make every ordinal of `unnest(p_invoice_ids) WITH
-- ORDINALITY` match EXACTLY ONE row of the one definition's output: no NULL
-- to fail the equijoin, no duplicate to match twice, and `v_n` ordinals in
-- all. So `array_agg(... ORDER BY k.i)` yields a dense array of length `v_n`
-- and `v_outs[v_i]` cannot misalign.
--
-- A FUTURE EDITOR WHO WEAKENS ANY ONE OF THOSE THREE BREAKS THIS READ, and
-- that is why they are named here with their line numbers and re-asserted
-- from the live catalogue by 0085-E(5). Drop the distinctness refusal and a
-- repeated id collapses to one output row, so the aggregate comes back SHORT
-- and every later position SHIFTS — silently, against the wrong invoice.
--
-- NO FOURTH DEFENSIVE REFUSAL IS ADDED, and that is a decision and not an
-- omission. A `cardinality(v_outs) <> v_n` guard inside step 11 would be
-- UNREACHABLE behind those three, and `0083`'s R-104 made exactly this
-- argument against paying for an unreachable check.
--
-- THE ARRAY FORM'S OWN `invoice.not_found` IS LIKEWISE UNREACHABLE, so no
-- refusal changes and none changes ORDER. Step 6 (relative lines 212-215)
-- already counts `public.invoices` over `id = ANY (p_invoice_ids)`
-- `FOR UPDATE` and raises THE SAME `invoice.not_found` when that count
-- differs from `v_n`. The array call is made AFTER step 6, so by the time it
-- runs every id is known to name a row this body can see.
--
-- Every per-allocation refusal of step 11 — `amount_exceeds_outstanding`,
-- `amount_mismatch`, `amount_below_base_unit`, `residue_below_base_unit`,
-- `settlement_changed` — still fires in ARRAY ORDER against the same figures,
-- because the loop still walks `1 .. v_n` and still compares position by
-- position.
--
-- WHY THE VALUES ARE IDENTICAL. `invoice_outstanding` is STABLE, and nothing
-- between step 6 (the invoice locks) and step 12 (the INSERTs) writes a
-- `payment_allocations` or `customer_credit_applications` row. Step 11 only
-- reads, compares and accumulates `v_sum_pb`. So the N scalar reads and the
-- one set-based read see the same rows, under the same snapshot and the same
-- `FOR UPDATE` locks.
--
-- NO SECOND TRUTH. It calls the SAME function. No stored
-- `invoices.outstanding_minor` or `paid_minor`, no cached settlement state,
-- no mutable `is_paid`, no application-side settlement arithmetic, no second
-- formula, no second customer-balance or invoice-outstanding truth, no second
-- journal writer, no journal read as an alternate authority, no change to
-- RLS, no threshold, ceiling, budget or sample count moved. After this file
-- `v_o` — the outstanding figure every step 11 refusal is measured against —
-- has EXACTLY ONE source in the whole routine, and that source is the one
-- definition. 0085-E(3) proves that from the catalogue.
--
-- WHAT IS DELIBERATELY NOT CHANGED. Step 6's per-invoice loop (status,
-- customer, currency, issue_date, sale_id, settlement_mode) and step 11's
-- other per-invoice reads (the invoice totals and `currencies.minor_units`)
-- STAY SCALAR. The fragment's author measured four scalar reads x 5 invoices
-- at 0.1726 ms per command against 0.0580 ms for one set-based pass — a
-- difference of 0.1146 ms, 0.0229 ms per invoice. The Tech Lead's §7: do not
-- force a shape the PostgreSQL evidence does not support.
--
-- ── THE MEASURED FIGURES. THEY ARE THE FRAGMENT AUTHOR'S, ON ITS BOX ─────
--
-- Every number below was measured by the author of
-- `P4-F-ALLOCATION-RECOMPUTE-FRAGMENT.sql` (agent `p4s4c/perf-p4f`) on THAT
-- AGENT'S box, and is CREDITED TO THEM AND NOT RE-DERIVED HERE. PostgreSQL
-- 16.13 — the deployment target, not an embedded 18.4 cluster.
--
-- WHAT THE CHANGE ITSELF IS WORTH. As `daftar_app` with ROW SECURITY
-- APPLIED, inside a transaction holding the five invoice locks, 200
-- iterations:
--
--     5 x scalar  invoice_outstanding(b, id)   2.9054 ms per command
--     1 x array   invoice_outstanding(b, ids)  0.6073 ms per command
--     ------------------------------------------------------------
--     saving                                   2.2981 ms per command
--                                              0.4596 ms per invoice
--
-- WHERE THE REST OF THE COST ACTUALLY LIVES. Decomposition of the ~4.78 ms
-- MARGINAL cost per allocated invoice, 40 commands per arm,
-- `pg_stat_statements` with `track=all`:
--
--     accounting_post_entry                    1.949 ms/invoice   41 %
--     COMMIT's deferred triggers and WAL       1.334 ms/invoice   28 %
--     the routine itself                       1.143 ms/invoice   24 %
--     the per-posting `set_config` round trip  0.340 ms/invoice    7 %
--
-- Taken as a whole the PER-ALLOCATION JOURNAL ENTRY IS ~63 % OF THE MARGINAL
-- COST, rising to ~76 % if the whole COMMIT marginal is attributed to it. The
-- recompute under lock at `0081:2086` — the thing THIS file removes — is
-- 0.587 ms/invoice, 12 % OF THE MARGINAL, though 51 % of the routine's own
-- share.
--
-- AND A CORRECTION TO THE BRIEF THE FRAGMENT'S AUTHOR WAS GIVEN: THE ROW
-- LOCKS AND THE FX SNAPSHOTS ARE NOT MATERIAL. They were on the list of
-- suspected costs handed to that agent; the decomposition above does not
-- support it, and the list is wrong on those two. Said here rather than left
-- to be re-suspected by the next reader.
--
-- WHAT IT IS WORTH END TO END. `npm run perf:phase4:s4` on the author's
-- cluster, the same acceptance dataset (4 435 invoices, 4 180 allocations,
-- 2 000-invoice fat-tail customer), 200 samples per arm, once before and once
-- after:
--
--   P4-F in-transaction, 5 invoices   p95  43.747 -> 39.395 ms   (ceiling 40)
--                                     p50  32.910 -> 31.646 ms
--                                     p99  51.473 -> 46.579 ms
--                                     over the ceiling: 12/200 -> 8/200
--   P4-F in-transaction, 1 invoice    p95  15.885 -> 14.932 ms
--   P4-F over HTTP, 5 invoices        p95  60.418 -> 56.083 ms  (ceiling 100)
--   scaling p95(5)/p95(1)            2.754 -> 2.638             (max 3)
--   P4-D, unmoved                    fat tail 44.414 -> 43.098 ms
--                                    ratio 2.033
--
-- THE MARGIN IS 1.5 PER CENT, AND THIS FILE DOES NOT CLAIM A PASS. 39.395 ms
-- against a 40 ms ceiling is 1.5 % of headroom, with 8 OF 200 SAMPLES STILL
-- OVER THE CEILING, measured ON A DIFFERENT BOX FROM THE ACCEPTANCE BOX. It
-- is therefore NOT A PASS ON THE ACCEPTANCE BOX UNTIL RE-MEASURED THERE.
-- THAT RE-MEASUREMENT IS OWED AND HAS NOT BEEN DONE: the coordinator holds
-- it, on a quiet box, and this file was deliberately verified WITHOUT running
-- `receivables-s4-budgets` so that a second heavy run could not corrupt it.
-- Nothing in this header should be read as budget evidence for this tree.
--
-- ── WHAT WAS IDENTIFIED, SIZED AND REFUSED. EACH WITH ITS FIGURE ─────────
--
-- The next person will ask where the remaining milliseconds are. They were
-- found, sized and left alone, on purpose:
--
--   1. MAKING `accounting_assert_entry_valid` RUN ONCE PER ENTRY instead of
--      once per entry PLUS once per line. It is a WHOLE-ENTRY validator, and
--      `journal_line_validate` (`0043:296`) is `FOR EACH ROW`, so a two-line
--      allocation entry validates it TWICE MORE than it needs to. Worth
--      0.357 ms/entry, about 1.8 ms PER 5-INVOICE COMMAND — the largest
--      single item left, and larger than what this file buys. REFUSED HERE:
--      it lives in `0043`, is owned by `daftar_accounting_internal`, is a
--      DEFERRED CONSTRAINT TRIGGER on the accounting authority, and would
--      change the cost of EVERY JOURNAL WRITE IN THE ESTATE. That is an
--      accounting-core decision and not a P4-S4 one.
--   2. FOLDING THE PER-POSTING `set_config` INTO THE POSTING ROUND TRIP.
--      Worth 1.358 ms/command. REFUSED: the evaluation order of `set_config`
--      relative to a function call WITHIN ONE STATEMENT is not defined by
--      PostgreSQL, and buying 1.4 ms by making the assertion seam's ordering
--      implementation-defined is not an acceptable trade.
--   3. BATCHING THE N POSTING CALLS SERVER-SIDE. Worth at most ~1.2 ms of
--      protocol overhead. REFUSED: it is a SECOND POSTING PATH, and R-B1
--      requires one assertion presented per posting.
--   4. FEWER ENTRIES PER PAYMENT. NOT EXPRESSIBLE AT ALL:
--      `accounting_source_bindings`' primary key and its
--      `UNIQUE (business_id, journal_entry_id)` fix the count at ONE PER
--      ALLOCATION.
--
-- ── OWNER, SECURITY AND ACL ──────────────────────────────────────────────
--
-- `CREATE OR REPLACE` PRESERVES `proowner`, `prosecdef`, `proconfig` and
-- `proacl`. The live state, read from a real PostgreSQL 16 cluster, is owner
-- `daftar_inventory_internal`, `prosecdef = true`,
-- `proconfig = {search_path=pg_catalog, public, pg_temp}`, `proacl =
-- {daftar_inventory_internal=X/daftar_inventory_internal,
-- daftar_app=X/daftar_inventory_internal}`. The replacement still happens
-- inside this file's own
-- `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal` /
-- `SET LOCAL ROLE daftar_inventory_internal` / `RESET ROLE` /
-- `REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal` bracket —
-- `0081:1388-1437` and `0081:1770`/`0081:2447` are the two in-repo
-- precedents — and the grant does NOT linger: 0085-E(6) reads back that
-- `daftar_inventory_internal` holds no CREATE on `public`.
--
-- `COMMENT ON FUNCTION` is unchanged by this edit and is NOT repeated: the
-- routine's stated contract — its refusals, their order, and the
-- recompute-and-compare law — is exactly what it was.
--
-- TAGGED DOLLAR QUOTES ONLY in this file's own blocks (`$pre$`, `$post$`): an
-- untagged `$$` has bitten this repo. The `CREATE OR REPLACE` statement below
-- is copied from the reviewed fragment VERBATIM and the routine's own body
-- keeps its original `$$`, which is `0081`'s text and is not this file's to
-- retag.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- 1. PRECONDITIONS. The expected head must be LIVE, and the subject must be
--    PROVED PRESENT BEFORE IT IS CHANGED: a green gate must be able to go
--    red. Re-applying this file over an already-corrected body REFUSES
--    rather than silently no-opping.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_cmd  CONSTANT TEXT := 'public.customer_collect_payment(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID, BIGINT, BIGINT, UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[])';
  v_def  TEXT;
  v_name TEXT;
  v_seen INTEGER;
BEGIN
  -- (1) THE HEAD IS `0084`'s. The ONE definition is in the catalogue with
  --     `0084`'s SEVEN-column shape, which is what makes this file a
  --     correction on top of `0084` and not of anything earlier. The array
  --     form is the function this file's single call goes to; if its shape is
  --     not the one `0084` fixed, the column this file reads by name
  --     (`outstanding_txn_minor`) is not where it is thought to be.
  IF to_regprocedure('public.invoice_outstanding(UUID, UUID[])') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding is not in the catalogue, so 0085 has nothing to call once'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'))
     IS DISTINCT FROM 'TABLE(invoice_id uuid, paid_txn_minor bigint, paid_base_minor bigint, outstanding_txn_minor bigint, outstanding_base_minor bigint, currency_code text, due_date date)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live set-based invoice_outstanding is not 0084''s seven-column form (found %), so 0085 is not applying on the 0084 head',
      pg_get_function_result(to_regprocedure('public.invoice_outstanding(UUID, UUID[])')) USING ERRCODE = 'P0001';
  END IF;
  -- And it is still the reader of record, not something that merely answers
  -- to the name and the shape.
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based invoice_outstanding is in the catalogue but its definition cannot be read'
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications', 'settlement_mode', 'invoice.not_found'] LOOP
    IF pg_catalog.strpos(v_def, v_name) = 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the live set-based invoice_outstanding does not carry %, so it is not the reader of record 0085 delegates to', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (2) THE SUBJECT EXISTS, AND THE DEFECT IS STILL THERE TO REMOVE. The
  --     live body must still contain the PER-INVOICE SCALAR CALL this file
  --     deletes. A tree where it is already gone is a tree this file would
  --     be a silent no-op on — or, worse, would re-apply a body whose other
  --     hunks someone has since moved — and it is REFUSED.
  IF to_regprocedure(v_cmd) IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment is not in the catalogue, so 0085 has no subject'
      USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure(v_cmd));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment exists but its definition cannot be read, which is a FINDING and not a routine to skip'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.strpos(v_def, 'SELECT o.outstanding_txn_minor INTO v_o FROM invoice_outstanding(v_business, p_invoice_ids[v_i]) o;') = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment does not make the per-invoice scalar invoice_outstanding call that 0085 removes, so either 0085 is already applied or step 11 has been moved by something else; refusing rather than silently no-opping'
      USING ERRCODE = 'P0001';
  END IF;
  -- And the SET-BASED call is NOT already there. The two halves together are
  -- what make this precondition red-capable in both directions.
  IF pg_catalog.strpos(v_def, 'JOIN invoice_outstanding(v_business, p_invoice_ids) o ON o.invoice_id = k.id') <> 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment already makes the set-based call 0085 adds, so 0085 has nothing to do'
      USING ERRCODE = 'P0001';
  END IF;

  -- (3) THE THREE UPSTREAM REFUSALS THE POSITIONAL READ DEPENDS ON are in
  --     the live body BEFORE this file relies on them. This is not
  --     decoration: hunk 3 replaces a per-invoice lookup with
  --     `v_outs[v_i]`, and that index is only meaningful because the length
  --     refusal (relative 163), the NULL-element refusal (relative 172) and
  --     the distinctness refusal (relative 178) have already fired. If the
  --     body this file is replacing does not have all three, the premise of
  --     the change is false and the change must not be made.
  v_seen := 0;
  FOREACH v_name IN ARRAY ARRAY[
      'OR p_invoice_ids IS NULL OR coalesce(cardinality(p_invoice_ids), 0) <> v_n',
      'OR array_position(p_allocation_ids, NULL) IS NOT NULL OR array_position(p_invoice_ids, NULL) IS NOT NULL',
      'OR (SELECT count(DISTINCT x.id) FROM unnest(p_invoice_ids) AS x(id)) <> v_n'] LOOP
    IF pg_catalog.strpos(v_def, v_name) = 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment is missing the upstream refusal <%>, which is what makes 0085''s positional read of v_outs safe; refusing to make the change on a body that does not guarantee a dense, parallel p_invoice_ids', v_name
        USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen + 1;
  END LOOP;
  IF v_seen <> 3 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0085-P(3) examined % upstream refusals and not 3', v_seen USING ERRCODE = 'P0001';
  END IF;
  -- Step 6's own `invoice.not_found` over the LOCKED set, which is what makes
  -- the array form's identically-named refusal unreachable and therefore
  -- makes this file change no refusal and no refusal ORDER.
  IF pg_catalog.strpos(v_def, 'FROM (SELECT i.id FROM invoices i WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) ORDER BY i.id FOR UPDATE) AS k;') = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment does not count the allocated invoices FOR UPDATE at step 6, so the array form''s invoice.not_found would no longer be unreachable and 0085 would move a refusal'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) PRE-STATE CAPTURE (the `0061:104-116` shape, as `0080`, `0081`,
  --     `0083:210` and `0084` took it). Owner, security standing, pinned
  --     path and the WHOLE ACL of the routine this file is about to REPLACE,
  --     transaction-local and compared in this same transaction's end state
  --     by 0085-E(4). A replacement is supposed to change the BODY and
  --     nothing else, and `CREATE OR REPLACE` keeping all four is a claim
  --     that gets READ BACK here rather than trusted.
  PERFORM set_config('daftar.p4s4c_0085_pre_cmd',
    (SELECT format('%s=%s|%s|%s|%s', p.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                   coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
       FROM pg_proc p WHERE p.oid = to_regprocedure(v_cmd)), true);
  -- The two forms of the reader of record, captured as TEXT. This file calls
  -- them and must not touch them: a `CREATE OR REPLACE` of the caller that
  -- somehow also moved the callee would be exactly the second-truth drift
  -- P4-AL-07 refuses.
  PERFORM set_config('daftar.p4s4c_0085_pre_readers',
    pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'))
      || E'\n--8<--\n' || pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID[])')), true);
  -- And `customer_apply_credit`, the OTHER caller of the same recompute
  -- (`0081:2366`), which this file deliberately leaves scalar and therefore
  -- must leave byte-identical.
  PERFORM set_config('daftar.p4s4c_0085_pre_apply_credit',
    pg_get_functiondef(to_regprocedure('public.customer_apply_credit(UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT)')), true);
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. THE REPLACEMENT, INSIDE THE DEFINER BRACKET.
--
--    `customer_collect_payment` is `SECURITY DEFINER` owned by
--    `daftar_inventory_internal`, so it is replaced BY ITS OWNER, and the
--    owner needs CREATE on `public` to do it. The bracket is
--    `0081:1388-1437`'s shape (the accounting one) and `0081:1770`/
--    `0081:2447`'s pairing for this very role; the grant is REVOKED again
--    below so no lingering CREATE is left behind, which 0085-E(6) reads back.
--
--    The statement between the two role changes is the reviewed fragment
--    `P4-F-ALLOCATION-RECOMPUTE-FRAGMENT.sql` VERBATIM, which is
--    `0081:1775-2191` with exactly the three hunks named at the top of this
--    file. Its body keeps `0081`'s own `$$` quoting.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
SET LOCAL ROLE daftar_inventory_internal;

CREATE OR REPLACE FUNCTION customer_collect_payment(
  p_payment_id                 UUID,
  p_customer_id                UUID,
  p_payment_method_id          UUID,
  p_posting_account_id         UUID,
  p_payment_date               DATE,
  p_currency_code              CHAR(3),
  p_amount_minor               BIGINT,
  p_rate_id                    UUID,
  p_rate                       NUMERIC,
  p_rate_source                TEXT,
  p_rate_at                    TIMESTAMPTZ,
  p_base_amount_minor          BIGINT,
  p_reference                  TEXT,
  p_credit_id                  UUID,
  p_credit_amount_minor        BIGINT,
  p_credit_carrying_base_minor BIGINT,
  p_allocation_ids             UUID[],
  p_invoice_ids                UUID[],
  p_invoice_currencies         TEXT[],
  p_payment_amounts            BIGINT[],
  p_payment_bases              BIGINT[],
  p_applied                    BIGINT[],
  p_released_before            BIGINT[],
  p_carrying_released          BIGINT[],
  p_ar_dusts                   BIGINT[],
  p_realized                   BIGINT[]
) RETURNS TABLE (
  payment_id    UUID,
  allocation_id UUID,
  line_no       INTEGER,
  invoice_id    UUID,
  credit_id     UUID,
  replayed      BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_stored   TEXT;
  v_replay   BOOLEAN;
  v_n        INTEGER;
  v_i        INTEGER;
  v_found    INTEGER;
  v_q        RECORD;
  v_m        RECORD;
  v_cstatus  TEXT;
  v_tz       TEXT;
  v_base_ccy TEXT;
  v_ep       INTEGER;
  v_et       INTEGER;
  v_eb       INTEGER;
  v_fx       accounting_fx_rate_snapshot;
  v_rate_id  UUID;
  v_rate     NUMERIC;
  v_source   TEXT;
  v_at       TIMESTAMPTZ;
  v_settle   TEXT;
  v_o        BIGINT;
  v_outs     BIGINT[];
  v_x        BIGINT;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_pb       BIGINT;
  v_sum_pa   NUMERIC;
  v_sum_pb   NUMERIC;
  v_cb       BIGINT;
BEGIN
  -- 1. The consume, over the routine's OWN ARGUMENTS in declaration order.
  v_actor := inventory_assertion_consume('customer.collect_payment', inventory_claimed_payload_digest('customer.collect_payment',
    ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'integer', 'code', 'integer', 'uuid', 'integer', 'code', 'integer', 'integer']
      || array_fill('integer'::text, ARRAY[8])
      || ARRAY['uuid', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_allocation_ids, p_invoice_ids, p_invoice_currencies, p_payment_amounts, p_payment_bases,
                                      p_applied, p_released_before, p_carrying_released, p_ar_dusts, p_realized)
                                 WITH ORDINALITY AS l(al, iv, cu, pa, pb, ap, rb, cr, ad, re, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'code', 'integer', 'integer', 'integer', 'integer', 'integer',
                                               'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_payment_id::text, p_customer_id::text, p_payment_method_id::text, p_posting_account_id::text,
          to_char(p_payment_date, 'YYYYMMDD'), lower(p_currency_code::text), p_amount_minor::text, p_rate_id::text,
          inventory_fixed_text(p_rate, 10), p_rate_source,
          CASE WHEN extract(epoch FROM p_rate_at) = trunc(extract(epoch FROM p_rate_at))
               THEN trunc(extract(epoch FROM p_rate_at))::text ELSE extract(epoch FROM p_rate_at)::text END,
          p_base_amount_minor::text]
      || inventory_reason_words(p_reference)
      || ARRAY[p_credit_id::text, p_credit_amount_minor::text, p_credit_carrying_base_minor::text,
               coalesce(cardinality(p_allocation_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_allocation_ids, p_invoice_ids, p_invoice_currencies, p_payment_amounts, p_payment_bases,
                                      p_applied, p_released_before, p_carrying_released, p_ar_dusts, p_realized)
                                 WITH ORDINALITY AS l(al, iv, cu, pa, pb, ap, rb, cr, ad, re, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.al::text, l.iv::text, lower(l.cu), l.pa::text, l.pb::text, l.ap::text,
                                               l.rb::text, l.cr::text, l.ad::text, l.re::text]) WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j)));
  -- 2. Isolation and trace.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a customer payment records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a customer payment names its id' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent. THE INTENT IS REQUEST-ONLY: ids,
  --    the date, the currency, the amount, the reference, the credit id and
  --    amount, and per allocation its id, invoice, paid and applied amounts.
  --    It carries no derived release, dust, base or FX figure, so the
  --    comparison happens before any catalogue is read and a rate change is
  --    not a false conflict ([[daftar-registry-before-state]]).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_id'), hashtext(p_payment_id::text));
  v_intent := inventory_payload_digest('customer.collect_payment', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'code', 'integer'] || array_fill('integer'::text, ARRAY[8])
      || ARRAY['uuid', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_allocation_ids, p_invoice_ids, p_payment_amounts, p_applied)
                                 WITH ORDINALITY AS l(al, iv, pa, ap, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_payment_id::text, p_customer_id::text, p_payment_method_id::text, to_char(p_payment_date, 'YYYYMMDD'),
          lower(p_currency_code::text), p_amount_minor::text]
      || inventory_reason_words(p_reference)
      || ARRAY[p_credit_id::text, p_credit_amount_minor::text, coalesce(cardinality(p_allocation_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_allocation_ids, p_invoice_ids, p_payment_amounts, p_applied)
                                 WITH ORDINALITY AS l(al, iv, pa, ap, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.al::text, l.iv::text, l.pa::text, l.ap::text]) WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j));

  -- 4. The replay read, BEFORE any other read: an equal intent replays and
  --    writes nothing, another is a stable conflict.
  SELECT h.intent_sha256 INTO v_stored FROM payments h WHERE h.business_id = v_business AND h.id = p_payment_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'customer_payment.idempotency_conflict: this payment id was already used for another payment' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    IF p_customer_id IS NULL OR p_payment_method_id IS NULL OR p_posting_account_id IS NULL OR p_payment_date IS NULL
       OR p_currency_code IS NULL OR p_amount_minor IS NULL OR p_rate IS NULL OR p_rate_source IS NULL OR p_rate_at IS NULL
       OR p_base_amount_minor IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a customer payment binds its customer, method, account, date, currency, amount and rate snapshot'
        USING ERRCODE = 'P0001';
    END IF;
    v_n := coalesce(cardinality(p_allocation_ids), 0);
    -- R-87: ZERO allocations is legal — pure on-account money — so the lower
    -- bound is 0 where `0068:617` has 1. Everything else about the arrays is
    -- the accepted shape, including the all-or-none NULL and distinctness
    -- rules, read over an empty array as vacuously true.
    -- A plpgsql `IF` reads its condition up to the FIRST `THEN` token, so a
    -- `CASE ... THEN ... END` may not appear in one: the dimension and lower
    -- bound are therefore asserted under `v_n > 0`, which also states the
    -- intent plainly — an EMPTY array has no dimension to check.
    IF v_n > 50 OR p_allocation_ids IS NULL
       OR (v_n > 0 AND (array_ndims(p_allocation_ids) <> 1 OR array_lower(p_allocation_ids, 1) <> 1))
       OR p_invoice_ids IS NULL OR coalesce(cardinality(p_invoice_ids), 0) <> v_n
       OR p_invoice_currencies IS NULL OR coalesce(cardinality(p_invoice_currencies), 0) <> v_n
       OR p_payment_amounts IS NULL OR coalesce(cardinality(p_payment_amounts), 0) <> v_n
       OR p_payment_bases IS NULL OR coalesce(cardinality(p_payment_bases), 0) <> v_n
       OR p_applied IS NULL OR coalesce(cardinality(p_applied), 0) <> v_n
       OR p_released_before IS NULL OR coalesce(cardinality(p_released_before), 0) <> v_n
       OR p_carrying_released IS NULL OR coalesce(cardinality(p_carrying_released), 0) <> v_n
       OR p_ar_dusts IS NULL OR coalesce(cardinality(p_ar_dusts), 0) <> v_n
       OR p_realized IS NULL OR coalesce(cardinality(p_realized), 0) <> v_n
       OR array_position(p_allocation_ids, NULL) IS NOT NULL OR array_position(p_invoice_ids, NULL) IS NOT NULL
       OR array_position(p_invoice_currencies, NULL) IS NOT NULL OR array_position(p_payment_amounts, NULL) IS NOT NULL
       OR array_position(p_payment_bases, NULL) IS NOT NULL OR array_position(p_applied, NULL) IS NOT NULL
       OR array_position(p_released_before, NULL) IS NOT NULL OR array_position(p_carrying_released, NULL) IS NOT NULL
       OR array_position(p_ar_dusts, NULL) IS NOT NULL OR array_position(p_realized, NULL) IS NOT NULL
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_allocation_ids) AS x(id)) <> v_n
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_invoice_ids) AS x(id)) <> v_n
       OR p_amount_minor <= 0
       OR EXISTS (SELECT 1 FROM unnest(p_payment_amounts) AS x(a) WHERE x.a <= 0)
       OR EXISTS (SELECT 1 FROM unnest(p_applied) AS x(a) WHERE x.a <= 0)
       OR (p_reference IS NOT NULL AND (p_reference <> btrim(p_reference) OR char_length(p_reference) NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'customer_payment.allocations_invalid: a payment is allocated to 0..50 distinct open invoices in positive amounts, with an optional trimmed reference'
        USING ERRCODE = 'P0001';
    END IF;
    -- R-87's closure, as a SHAPE rule first: the paid amounts and the surplus
    -- credit account for the whole payment, and the credit's three arguments
    -- are all-or-none.
    v_sum_pa := coalesce((SELECT sum(x.a) FROM unnest(p_payment_amounts) AS x(a)), 0);
    IF (p_credit_id IS NULL) <> (p_credit_amount_minor IS NULL)
       OR (p_credit_id IS NULL) <> (p_credit_carrying_base_minor IS NULL)
       OR (p_credit_amount_minor IS NOT NULL AND p_credit_amount_minor <= 0)
       OR (p_credit_carrying_base_minor IS NOT NULL AND p_credit_carrying_base_minor <= 0)
       OR v_sum_pa + coalesce(p_credit_amount_minor, 0) <> p_amount_minor THEN
      RAISE EXCEPTION 'customer_payment.closure_invalid: the allocated amounts and the surplus credit are exactly the payment amount'
        USING ERRCODE = 'P0001';
    END IF;
    -- R-74: an allocation id, and the credit id, are idempotency keys and
    -- accounting source ids. A stable domain refusal, never a raw key
    -- violation.
    IF (v_n > 0 AND EXISTS (SELECT 1 FROM payment_allocations a WHERE a.business_id = v_business AND a.id = ANY (p_allocation_ids)))
       OR (p_credit_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM customer_credits k WHERE k.business_id = v_business AND k.id = p_credit_id)) THEN
      RAISE EXCEPTION 'customer_payment.allocations_invalid: an allocation id or the credit id is already used by another document'
        USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a: every allocated invoice FOR UPDATE, IN ID ORDER. This
    --    is the cap lock: two racing allocations serialise on the invoice row
    --    and the loser is refused by its own recomputation at step 10.
    IF v_n > 0 THEN
      SELECT count(*) INTO v_found
      FROM (SELECT i.id FROM invoices i WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) ORDER BY i.id FOR UPDATE) AS k;
      IF v_found <> v_n THEN
        RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
      END IF;
      FOR v_i IN 1 .. v_n LOOP
        SELECT i.status, i.customer_id, i.currency_code, i.issue_date, i.sale_id INTO v_q
        FROM invoices i WHERE i.business_id = v_business AND i.id = p_invoice_ids[v_i];
        IF v_q.customer_id IS NULL THEN
          RAISE EXCEPTION 'invoice_settlement.walkin_not_settleable: a walk-in invoice carries no customer and is settled by nothing' USING ERRCODE = 'P0001';
        END IF;
        IF v_q.customer_id <> p_customer_id THEN
          RAISE EXCEPTION 'invoice_settlement.customer_mismatch: a payment settles invoices of its own customer only' USING ERRCODE = 'P0001';
        END IF;
        IF v_q.status <> 'open' THEN
          RAISE EXCEPTION 'customer_payment.invoice_state_invalid: only an open invoice is settled' USING ERRCODE = 'P0001';
        END IF;
        SELECT s.settlement_mode INTO v_settle FROM sales s WHERE s.business_id = v_business AND s.id = v_q.sale_id;
        IF v_settle = 'cash' THEN
          RAISE EXCEPTION 'invoice_settlement.cash_not_settleable: a cash-settled invoice carries no receivable and is settled by nothing' USING ERRCODE = 'P0001';
        END IF;
        IF v_q.currency_code::text <> p_invoice_currencies[v_i] THEN
          RAISE EXCEPTION 'customer_payment.settlement_changed: an invoice changed since the payment was prepared' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;

    -- 7. Lock step 2b: the customer FOR SHARE.
    SELECT c.status INTO v_cstatus FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer.not_found: the customer does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_cstatus <> 'active' THEN
      RAISE EXCEPTION 'customer_payment.customer_inactive: a customer payment is collected from an active customer' USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 2c: the method FOR SHARE.
    SELECT m.is_active, m.posting_account_id, m.requires_reference INTO v_m
    FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_m.is_active THEN
      RAISE EXCEPTION 'payment_method.inactive: a customer payment is collected through an active payment method' USING ERRCODE = 'P0001';
    END IF;
    IF v_m.posting_account_id <> p_posting_account_id THEN
      RAISE EXCEPTION 'customer_payment.settlement_changed: the payment method''s posting account changed since the payment was prepared'
        USING ERRCODE = 'P0001';
    END IF;
    IF accounting_settlement_account_eligibility(v_business, v_m.posting_account_id) IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_m.requires_reference AND p_reference IS NULL THEN
      RAISE EXCEPTION 'customer_payment.reference_required: this payment method requires a reference' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The dates: not before any settled invoice, not after today. The
    --    clock is read for TODAY only and never to fill a document date
    --    (P4-AL-30).
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF v_n > 0 AND EXISTS (SELECT 1 FROM invoices i
                            WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) AND i.issue_date > p_payment_date) THEN
      RAISE EXCEPTION 'customer_payment.date_before_invoice: a payment is dated on or after every invoice it settles' USING ERRCODE = 'P0001';
    END IF;
    IF p_payment_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'customer_payment.date_in_future: a payment is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 10. The payment FX snapshot: no clock, the instant is derived.
    IF p_currency_code::text !~ '^[A-Z]{3}$' OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = p_currency_code::text) THEN
      RAISE EXCEPTION 'purchase.currency_unknown: the payment currency is not a registered currency' USING ERRCODE = 'P0001';
    END IF;
    IF p_currency_code::text = v_base_ccy THEN
      v_rate_id := NULL;
      v_rate    := 1;
      v_source  := 'base';
      v_at      := p_payment_date::timestamp AT TIME ZONE 'UTC';
    ELSE
      v_fx := accounting_purchase_fx_rate(v_business, p_currency_code, ((p_payment_date + 1)::timestamp AT TIME ZONE v_tz) - interval '1 second');
      v_rate_id := v_fx.rate_id;
      v_rate    := v_fx.rate;
      v_source  := v_fx.source;
      v_at      := v_fx.effective_at;
    END IF;
    IF p_rate_id IS DISTINCT FROM v_rate_id OR p_rate <> v_rate OR p_rate_source <> v_source OR p_rate_at <> v_at THEN
      RAISE EXCEPTION 'customer_payment.fx_rate_changed: the exchange rate changed since the payment was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 11. Per allocation, in array order, UNDER THE INVOICE LOCKS: O is
    --     re-read from the reader-of-record, X, the release, the dust, the
    --     payment base and the FX are recomputed, and EVERY ONE of the
    --     caller's figures must agree (R-86).
    SELECT c.minor_units INTO v_ep FROM currencies c WHERE c.code = p_currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_sum_pb := 0;
    -- O for EVERY allocated invoice in ONE call to the ONE definition, under
    -- the locks taken at step 6 and before the ordered loop below. The loop
    -- then reads position v_i out of it, so each allocation is still compared
    -- in array order against the SAME figure the per-invoice call returned --
    -- this is a change of WORK and not of ANSWER (0083's own words). Nothing
    -- between step 6 and step 12 writes a reducer row, so the N scalar reads
    -- and this one set-based read see the same data; invoice_outstanding is
    -- STABLE and both forms are the SAME function, the array form being the
    -- one definition and the scalar form its thin wrapper (0083).
    IF v_n > 0 THEN
      SELECT array_agg(o.outstanding_txn_minor ORDER BY k.i) INTO v_outs
        FROM unnest(p_invoice_ids) WITH ORDINALITY AS k(id, i)
        JOIN invoice_outstanding(v_business, p_invoice_ids) o ON o.invoice_id = k.id;
    END IF;
    FOR v_i IN 1 .. v_n LOOP
      SELECT i.currency_code, i.total_txn_minor, i.total_base_minor, i.source_to_base_rate INTO v_q
      FROM invoices i WHERE i.business_id = v_business AND i.id = p_invoice_ids[v_i];
      SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_q.currency_code::text;
      v_o := v_outs[v_i];
      IF p_applied[v_i] > v_o THEN
        RAISE EXCEPTION 'customer_payment.amount_exceeds_outstanding: an allocation applies more than the invoice''s outstanding amount'
          USING ERRCODE = 'P0001';
      END IF;
      IF p_currency_code::text = v_q.currency_code::text AND p_payment_amounts[v_i] <> p_applied[v_i] THEN
        RAISE EXCEPTION 'customer_payment.amount_mismatch: in the invoice''s own currency the paid and applied amounts are equal' USING ERRCODE = 'P0001';
      END IF;
      v_x    := v_q.total_txn_minor - v_o;
      v_rel  := supplier_ap_release(v_q.total_base_minor, v_q.total_txn_minor, v_x, p_applied[v_i]);
      v_conv := supplier_convert_base(p_applied[v_i], v_q.source_to_base_rate, v_et, v_eb);
      v_pb   := supplier_convert_base(p_payment_amounts[v_i], v_rate, v_ep, v_eb);
      IF v_conv = 0 OR v_pb = 0 THEN
        RAISE EXCEPTION 'customer_payment.amount_below_base_unit: an allocated amount converts to less than one base minor unit' USING ERRCODE = 'P0001';
      END IF;
      IF p_applied[v_i] < v_o AND supplier_convert_base(v_o - p_applied[v_i], v_q.source_to_base_rate, v_et, v_eb) = 0 THEN
        RAISE EXCEPTION 'customer_payment.residue_below_base_unit: an allocation would leave the invoice an outstanding amount converting to less than one base minor unit'
          USING ERRCODE = 'P0001';
      END IF;
      IF p_released_before[v_i] <> v_x OR p_carrying_released[v_i] <> v_rel OR p_ar_dusts[v_i] <> v_rel - v_conv
         OR p_payment_bases[v_i] <> v_pb OR p_realized[v_i] <> v_pb - v_rel THEN
        RAISE EXCEPTION 'customer_payment.settlement_changed: an invoice''s outstanding amount changed since the payment was prepared'
          USING ERRCODE = 'P0001';
      END IF;
      v_sum_pb := v_sum_pb + v_pb;
    END LOOP;
    -- The surplus credit's carrying base is its OWN single HALF_EVEN of its own
    -- stored original at the payment's rate — never the payment base minus the
    -- allocation bases, which would make a rounded quotient an input
    -- (P4-AL-25). The base closure is then a SUM OF ROUNDINGS.
    IF p_credit_id IS NOT NULL THEN
      v_cb := supplier_convert_base(p_credit_amount_minor, v_rate, v_ep, v_eb);
      IF v_cb = 0 THEN
        RAISE EXCEPTION 'customer_payment.amount_below_base_unit: a surplus credit converts to less than one base minor unit' USING ERRCODE = 'P0001';
      END IF;
      IF p_credit_carrying_base_minor <> v_cb THEN
        RAISE EXCEPTION 'customer_payment.settlement_changed: the surplus credit''s carrying base changed since the payment was prepared'
          USING ERRCODE = 'P0001';
      END IF;
      v_sum_pb := v_sum_pb + v_cb;
    END IF;
    IF v_sum_pb <> p_base_amount_minor THEN
      RAISE EXCEPTION 'customer_payment.settlement_changed: the payment base is not the sum of its allocations'' bases and its surplus credit''s carrying base'
        USING ERRCODE = 'P0001';
    END IF;

    -- 12. The header, then the allocations (line_no = ordinal,
    --     binding_source_id = id), then the surplus credit.
    INSERT INTO payments (tenant_id, business_id, id, customer_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                          payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                          allocation_count, intent_sha256, business_transaction_id, created_by)
    VALUES (v_tenant, v_business, p_payment_id, p_customer_id, p_payment_method_id, p_posting_account_id, p_currency_code, p_amount_minor,
            v_rate, v_source, v_at, v_rate_id, p_base_amount_minor, p_payment_date, p_reference,
            v_n, v_intent, v_trace, v_actor.actor_user_id);
    IF v_n > 0 THEN
      INSERT INTO payment_allocations (tenant_id, business_id, id, payment_id, customer_id, invoice_id, line_no, payment_currency,
                                       payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, invoice_currency,
                                       invoice_amount_applied_minor, invoice_historical_to_base_rate, ar_released_before_txn_minor,
                                       invoice_carrying_base_released_minor, ar_dust_base_minor, realized_fx_gain_loss_minor,
                                       binding_source_id)
      SELECT v_tenant, v_business, x.al, p_payment_id, p_customer_id, x.iv, x.i::integer, p_currency_code,
             x.pa, v_rate, x.pb, i.currency_code,
             x.ap, i.source_to_base_rate, x.rb,
             x.cr, x.ad, x.re,
             x.al
      FROM unnest(p_allocation_ids, p_invoice_ids, p_payment_amounts, p_payment_bases, p_applied, p_released_before,
                  p_carrying_released, p_ar_dusts, p_realized) WITH ORDINALITY AS x(al, iv, pa, pb, ap, rb, cr, ad, re, i)
      JOIN invoices i ON i.business_id = v_business AND i.id = x.iv
      ORDER BY x.i;
    END IF;
    IF p_credit_id IS NOT NULL THEN
      INSERT INTO customer_credits (tenant_id, business_id, id, customer_id, origin_payment_id, currency_code,
                                    original_amount_minor, original_carrying_base_amount_minor, credit_to_base_rate,
                                    rate_source, rate_timestamp, fx_rate_id, remaining_amount_minor,
                                    remaining_carrying_base_amount_minor, credit_date, intent_sha256, business_transaction_id, created_by,
                                    binding_source_id)
      VALUES (v_tenant, v_business, p_credit_id, p_customer_id, p_payment_id, p_currency_code,
              p_credit_amount_minor, v_cb, v_rate,
              v_source, v_at, v_rate_id, p_credit_amount_minor,
              v_cb, p_payment_date, v_intent, v_trace, v_actor.actor_user_id,
              p_credit_id);
    END IF;

    -- 13. Audit and outbox: ids, NEVER an amount.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'customer.payment_collected', 'payment', p_payment_id::text,
            jsonb_build_object('customerId', p_customer_id, 'allocationIds', to_jsonb(p_allocation_ids), 'creditId', p_credit_id,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'customer.payment_collected.v1',
            jsonb_build_object('businessId', v_business, 'paymentId', p_payment_id, 'customerId', p_customer_id,
                               'allocationIds', to_jsonb(p_allocation_ids), 'creditId', p_credit_id,
                               'businessTransactionId', v_trace));
  END IF;

  -- 14. The stored rows, in line order. A LEFT JOIN, because a payment with
  --     ZERO allocations (R-87) still has a row to return.
  RETURN QUERY
  SELECT h.id, a.id, a.line_no, a.invoice_id,
         (SELECT k.id FROM customer_credits k WHERE k.business_id = v_business AND k.origin_payment_id = h.id), v_replay
  FROM payments h
  LEFT JOIN payment_allocations a ON a.business_id = h.business_id AND a.payment_id = h.id
  WHERE h.business_id = v_business AND h.id = p_payment_id
  ORDER BY a.line_no NULLS FIRST;
END;
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. END-STATE PROOF, read back from the CATALOGUE and not from this file's
--    own text. Every loop asserts its SUBJECT COUNT, and a subject that is
--    discovered but whose definition cannot be read RAISES — it is never
--    `continue`d past. A false green of exactly that kind was found in this
--    slice, and the shape of the bug was a loop that skipped the routine it
--    could not read and then reported that it had checked everything.
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_cmd  CONSTANT TEXT := 'public.customer_collect_payment(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID, BIGINT, BIGINT, UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[])';
  v_def  TEXT;
  v_name TEXT;
  v_seen INTEGER;
BEGIN
  -- 0085-E(1). THE SUBJECT IS STILL THERE, with the SAME SIGNATURE, and its
  -- definition is READABLE. `CREATE OR REPLACE` cannot change a return type,
  -- so this is also the proof that the fragment's `RETURNS TABLE` is
  -- `0081`'s and the statement replaced rather than silently created a
  -- sibling overload.
  IF to_regprocedure(v_cmd) IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment is not in the catalogue after 0085 replaced it'
      USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure(v_cmd));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment exists but its definition cannot be read, which is a FINDING and not a routine to skip'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_get_function_result(to_regprocedure(v_cmd))
     IS DISTINCT FROM 'TABLE(payment_id uuid, allocation_id uuid, line_no integer, invoice_id uuid, credit_id uuid, replayed boolean)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment''s return type is not 0081''s six-column form (found %)',
      pg_get_function_result(to_regprocedure(v_cmd)) USING ERRCODE = 'P0001';
  END IF;
  -- Exactly ONE routine answers to that name, so no overload was created
  -- alongside the one that was meant to be replaced.
  IF (SELECT pg_catalog.count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'customer_collect_payment') <> 1 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: public holds more than one customer_collect_payment, so 0085 added an overload instead of replacing the subject'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0085-E(2). THE PER-INVOICE SCALAR CALL IS GONE AND THE ONE SET-BASED
  -- CALL IS THERE. This is the whole change, asserted in both directions
  -- from the live body: the hunk that was removed is absent, the hunk that
  -- was added is present, and the `v_outs` declaration that makes it legal
  -- is present too. Asserting only the absence would pass on a body that
  -- deleted the recompute altogether, which would be a correctness defect
  -- and not an optimisation.
  IF pg_catalog.strpos(v_def, 'invoice_outstanding(v_business, p_invoice_ids[v_i])') <> 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment still calls invoice_outstanding once per invoice, so 0085''s only change did not take'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.strpos(v_def, 'JOIN invoice_outstanding(v_business, p_invoice_ids) o ON o.invoice_id = k.id') = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment does not make the ONE set-based call to the reader of record'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.strpos(v_def, 'SELECT array_agg(o.outstanding_txn_minor ORDER BY k.i) INTO v_outs') = 0
     OR pg_catalog.strpos(v_def, 'FROM unnest(p_invoice_ids) WITH ORDINALITY AS k(id, i)') = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment does not fill v_outs from unnest(p_invoice_ids) WITH ORDINALITY in array order, so the positional read has no ordering to stand on'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.strpos(v_def, 'v_outs     BIGINT[];') = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment does not declare v_outs BIGINT[]'
      USING ERRCODE = 'P0001';
  END IF;
  -- The loop reads POSITION v_i, and it still walks 1 .. v_n, so each
  -- allocation is compared in ARRAY ORDER against the same figure the
  -- per-invoice call returned. That is the refusal-order claim, read back.
  IF pg_catalog.strpos(v_def, 'v_o := v_outs[v_i];') = 0
     OR pg_catalog.strpos(v_def, 'FOR v_i IN 1 .. v_n LOOP') = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment does not read v_outs at position v_i inside the ordered 1 .. v_n loop, so refusal order is no longer array order'
      USING ERRCODE = 'P0001';
  END IF;
  -- And the call is made exactly ONCE. Two set-based calls would be two
  -- reads of the same figure under the same locks, which is the per-invoice
  -- cost coming back in a different shape.
  IF pg_catalog.array_length(pg_catalog.string_to_array(v_def, 'invoice_outstanding('), 1) <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment names invoice_outstanding % times and not exactly once',
      pg_catalog.array_length(pg_catalog.string_to_array(v_def, 'invoice_outstanding('), 1) - 1 USING ERRCODE = 'P0001';
  END IF;

  -- 0085-E(3). NO SETTLEMENT ARITHMETIC OF ITS OWN, AND NO REDUCER RELATION
  -- READ DIRECTLY (P4-AL-07). This routine is the WRITER of
  -- `payment_allocations`, so the claim cannot be that the name is absent —
  -- it is that the routine derives NO SETTLEMENT FIGURE from a reducer
  -- itself. Proved three ways:
  --
  --   (a) `customer_credit_applications`, the reducer's OTHER arm, is not
  --       named at all, so the reducer UNION cannot be reconstructed here;
  --   (b) no aggregate is taken over either reducer column anywhere in the
  --       body, so no paid or outstanding total is summed here; and
  --   (c) `v_o` — the outstanding figure EVERY step 11 refusal is measured
  --       against — has exactly ONE assignment in the whole body, and it is
  --       `v_outs[v_i]`. There is no `INTO v_o` and no second `v_o :=`, so
  --       the figure has a single source and that source is the one
  --       definition.
  IF pg_catalog.strpos(v_def, 'customer_credit_applications') <> 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment names customer_credit_applications, so it can reconstruct the reducer union itself and hold a second settlement sum'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def ~ '(sum|avg|max|min|count|array_agg)[[:space:]]*\([^)]*invoice_(amount_applied|carrying_base_released)_minor' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment aggregates a reducer column, which is a second copy of the settlement sum'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.strpos(v_def, 'INTO v_o ') <> 0 OR pg_catalog.strpos(v_def, 'INTO v_o' || E'\n') <> 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment still selects INTO v_o, so the outstanding figure has a source other than the one definition'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.array_length(pg_catalog.string_to_array(v_def, 'v_o := '), 1) <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: v_o is assigned % times in customer_collect_payment and not exactly once, so the outstanding figure no longer has a single source',
      pg_catalog.array_length(pg_catalog.string_to_array(v_def, 'v_o := '), 1) - 1 USING ERRCODE = 'P0001';
  END IF;
  -- No stored settlement figure was invented to lean on, either.
  FOREACH v_name IN ARRAY ARRAY['outstanding_minor', 'paid_minor', 'is_paid', 'settlement_cache'] LOOP
    IF pg_catalog.strpos(v_def, v_name) <> 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment names %, which is a stored settlement figure refused by P4-AL-06', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 0085-E(4). ONLY THE BODY MOVED. Owner, `prosecdef`, `proconfig` and the
  -- WHOLE `proacl` compare EQUAL to the 0085-P capture, in this same
  -- transaction. `CREATE OR REPLACE` preserving all four is the claim the
  -- header makes; this is where it is read back rather than trusted.
  IF (SELECT format('%s=%s|%s|%s|%s', p.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                    coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
        FROM pg_proc p WHERE p.oid = to_regprocedure(v_cmd))
     IS DISTINCT FROM current_setting('daftar.p4s4c_0085_pre_cmd', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the replacement changed the owner, security standing, pinned path or ACL of customer_collect_payment (now %, was %)',
      (SELECT format('%s=%s|%s|%s|%s', p.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                     coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
         FROM pg_proc p WHERE p.oid = to_regprocedure(v_cmd)),
      current_setting('daftar.p4s4c_0085_pre_cmd', true) USING ERRCODE = 'P0001';
  END IF;
  -- And the accepted configuration stated ABSOLUTELY, not only relative to a
  -- capture that could itself have been wrong before this file ran: DEFINER,
  -- owned by `daftar_inventory_internal`, the pinned `search_path`, VOLATILE
  -- (it writes), nothing for PUBLIC.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure(v_cmd)
                    AND p.prosecdef AND p.provolatile = 'v'
                    AND p.proowner = 'daftar_inventory_internal'::regrole
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_collect_payment is not a VOLATILE SECURITY DEFINER routine owned by daftar_inventory_internal with its pinned search_path'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
              WHERE p.oid = to_regprocedure(v_cmd) AND x.grantee = 0) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: PUBLIC holds a privilege on customer_collect_payment' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text)
        FROM pg_proc p, aclexplode(p.proacl) x
       WHERE p.oid = to_regprocedure(v_cmd) AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner)
     IS DISTINCT FROM ARRAY['daftar_app'] THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: EXECUTE on customer_collect_payment is not exactly daftar_app besides its owner'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0085-E(5). THE THREE UPSTREAM REFUSALS THE POSITIONAL READ DEPENDS ON
  -- ARE STILL IN THE LIVE BODY. They were asserted before the change
  -- (0085-P(3)) because they were its premise; they are asserted again here
  -- because the body that now holds the positional read is a DIFFERENT
  -- STRING, and the thing that makes `v_outs[v_i]` safe must be true of the
  -- body that actually contains it. Relative lines 163, 172 and 178 of
  -- `0081:1775`.
  v_seen := 0;
  FOREACH v_name IN ARRAY ARRAY[
      'OR p_invoice_ids IS NULL OR coalesce(cardinality(p_invoice_ids), 0) <> v_n',
      'OR array_position(p_allocation_ids, NULL) IS NOT NULL OR array_position(p_invoice_ids, NULL) IS NOT NULL',
      'OR (SELECT count(DISTINCT x.id) FROM unnest(p_invoice_ids) AS x(id)) <> v_n'] LOOP
    IF pg_catalog.strpos(v_def, v_name) = 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment lost the upstream refusal <%>; without it p_invoice_ids is not guaranteed dense, parallel and distinct, and v_outs[v_i] can read the wrong invoice''s outstanding amount', v_name
        USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen + 1;
  END LOOP;
  IF v_seen <> 3 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0085-E(5) examined % upstream refusals and not 3', v_seen USING ERRCODE = 'P0001';
  END IF;
  -- The set-based call is made AFTER step 6's locked count, which is what
  -- keeps the array form's own `invoice.not_found` unreachable and therefore
  -- keeps every refusal of this routine where it was.
  IF pg_catalog.strpos(v_def, 'FROM (SELECT i.id FROM invoices i WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) ORDER BY i.id FOR UPDATE) AS k;') = 0
     OR pg_catalog.strpos(v_def, 'FROM (SELECT i.id FROM invoices i WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) ORDER BY i.id FOR UPDATE) AS k;')
        > pg_catalog.strpos(v_def, 'JOIN invoice_outstanding(v_business, p_invoice_ids) o ON o.invoice_id = k.id') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the set-based call is not made after step 6''s locked invoice count, so the array form''s invoice.not_found is reachable and 0085 has moved a refusal'
      USING ERRCODE = 'P0001';
  END IF;
  -- And no fourth refusal was smuggled in. The step 11 refusal set is
  -- exactly `0081`'s, by name.
  v_seen := 0;
  FOREACH v_name IN ARRAY ARRAY['customer_payment.amount_exceeds_outstanding', 'customer_payment.amount_mismatch',
                                'customer_payment.amount_below_base_unit', 'customer_payment.residue_below_base_unit',
                                'customer_payment.settlement_changed'] LOOP
    IF pg_catalog.strpos(v_def, v_name) = 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the live customer_collect_payment lost the step 11 refusal %', v_name USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen + 1;
  END LOOP;
  IF v_seen <> 5 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0085-E(5) examined % step 11 refusals and not 5', v_seen USING ERRCODE = 'P0001';
  END IF;

  -- 0085-E(6). THE CALLEES ARE BYTE-IDENTICAL, and so is the OTHER caller.
  -- `pg_get_functiondef` of BOTH forms of `invoice_outstanding` comes out
  -- character for character as 0085-P captured it: this file changes a
  -- CALLER and must not have touched the reader of record in either form.
  -- `customer_apply_credit` is the other caller of the same recompute
  -- (`0081:2366`) and is deliberately left scalar, so it too must be
  -- unchanged — a file that quietly reshaped it would be making a second,
  -- unmeasured change under this serial.
  IF pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'))
       || E'\n--8<--\n' || pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID[])'))
     IS DISTINCT FROM current_setting('daftar.p4s4c_0085_pre_readers', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0085 changed the text of invoice_outstanding in one of its two forms; this file replaces a CALLER and the reader of record is not its to move'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.customer_apply_credit(UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT)'))
     IS DISTINCT FROM current_setting('daftar.p4s4c_0085_pre_apply_credit', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0085 changed the text of customer_apply_credit, which it deliberately leaves scalar and unmeasured'
      USING ERRCODE = 'P0001';
  END IF;
  -- THE CREATE GRANT DOES NOT LINGER. The bracket opened CREATE on `public`
  -- for `daftar_inventory_internal` and closed it again; a migration that
  -- left it open would have widened the schema for a DEFINER role.
  -- Read from `nspacl` DIRECTLY and not through `has_schema_privilege`: the
  -- question is whether THIS FILE'S grant was given back, and an effective
  -- privilege the role holds by inheritance from somewhere else is neither
  -- this file's doing nor this file's to revoke.
  IF EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) x
              WHERE n.nspname = 'public' AND x.privilege_type = 'CREATE'
                AND x.grantee = 'daftar_inventory_internal'::regrole) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: daftar_inventory_internal still holds a direct CREATE grant on schema public after 0085''s bracket closed'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0085-E(7). NO SECOND TRUTH WAS CREATED. This file adds no relation, no
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
