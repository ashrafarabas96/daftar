-- 0082_phase4_customer_settlement_structural_pin.sql
-- Phase 4 / P4-S4 CORRECTIVE — THE STRUCTURAL `(business_id, invoice_id,
-- customer_id)` PIN: the candidate key `0081`'s R-84 declined to add, and the
-- widening of the two reducer edges onto it, so that attaching one customer's
-- money to another customer's invoice stops being REFUSED and becomes
-- UNREPRESENTABLE.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080` and `0081` are
-- CANDIDATE and are BYTE-FOR-BYTE UNTOUCHED: this file is append-only and
-- corrects the schema FORWARD, which is the only manner a defect in an
-- already-applied migration is ever repaired here (`0072` is the accepted
-- precedent: a Phase 3 corrective that re-created an 0067/0068 object from a
-- new file rather than editing either).
--
-- ── WHAT THIS FILE CLOSES, AND ON WHOSE AUTHORITY ────────────────────────
--
-- `0081`'s R-84 ("DEPARTURE A") reads, in its own words:
--
--     "Both reducer relations reference `invoices (business_id, id)`, the
--      primary key, and NOT `(business_id, id, customer_id)`. `invoices` is an
--      earlier slice's applied table and adding a candidate key to it is an
--      ownership question the Tech Lead has not answered."
--
-- The departure was DISCLOSED, not forgotten: `0081:344-356` names
-- `0067:274` as the accepted precedent for adding exactly such a key to an
-- earlier slice's table, and says the widening waits on "A TECH LEAD RULING ON
-- SLICE OWNERSHIP". The Tech Lead's §23 list is that ruling, and it asks for
-- the pin in the form the departure named: a composite key/FK shape, not
-- another trigger check. This file is that widening and nothing else.
--
-- ── R-94 THE OBSTACLE THAT IS NOT ONE: NULL `customer_id` ────────────────
--
-- The obstacle recorded against this pin was that PostgreSQL requires a
-- NON-PARTIAL unique index or constraint as a foreign-key target, while a
-- WALK-IN invoice carries a NULL `customer_id` (`0075:248`). It was read as:
-- "the key would have to be partial, therefore no key, therefore no pin."
--
-- It does not bind, and the reason is worth stating exactly, because the
-- mistake is easy to repeat. A UNIQUE CONSTRAINT IS NOT A `NOT NULL`
-- CONSTRAINT. A plain, non-partial `UNIQUE (business_id, id, customer_id)` is
-- accepted on data that already contains NULL `customer_id` rows, for the same
-- reason `0067:274` gives about its own key — "It contains the primary key, so
-- it validates on any data": `(business_id, id)` is already the primary key of
-- `invoices`, so the triple is unique whatever the third column holds, and the
-- rows whose third column is NULL simply never collide (a unique index treats
-- NULLs as distinct). The key this file adds is therefore NON-PARTIAL, is a
-- lawful foreign-key target, and needed no backfill, no default and no rewrite
-- of a single invoice row.
--
-- The NULL then does the OPPOSITE of obstructing: it is what makes the walk-in
-- law structural. Both reducer relations declare `customer_id UUID NOT NULL`
-- (`0081:303`, `0081:442`), so all three columns of the referencing tuple are
-- non-null on every row, so the foreign key is CHECKED on every row (under the
-- default MATCH SIMPLE a NULL anywhere in the referencing tuple would skip the
-- check — there is none here, and §3(3) asserts that). A non-null triple can
-- never match a parent tuple whose `customer_id` IS NULL. So:
--
--   (a) THE CUSTOMER IDENTITY PIN — a reducer naming customer C against an
--       invoice of customer D has NO FK TARGET AT ALL;
--   (b) THE WALK-IN LAW — a walk-in invoice has no
--       `(business, id, non-null customer)` tuple for any reducer to match, so
--       it can carry no allocation and no credit application.
--
-- Both were `invoice_settlement_verify` arms under R-84. They are now shapes.
--
-- ── R-95 THE PARENT SIDE: A SECOND LINE, NOT A HOLE CLOSED ───────────────
--
-- `invoice_settlement_verify` fires from constraint triggers on the two
-- REDUCER relations (`0081:1282`, `0081:1291`), so it is reached when a reducer
-- row is written. It is NOT reached when `invoices` itself is written. Two
-- mismatches are therefore outside its reach altogether:
--
--   — RE-PARENTING: `UPDATE invoices SET customer_id = <another customer>` on
--     an invoice that already carries a settlement row — handing one
--     customer's settled money to another's receivable with no reducer row
--     changed;
--   — ORPHANING: `UPDATE invoices SET customer_id = NULL` on a settled
--     invoice — retroactively making a settled invoice a walk-in.
--
-- THIS WAS DRAFTED AS A HOLE THIS FILE CLOSES, AND MEASUREMENT SAID
-- OTHERWISE. The statement is kept in its corrected form rather than deleted,
-- because the corrected version is the one a later reader needs.
-- `invoices_lifecycle_guard()` (`0075:546-556`) already freezes `customer_id`
-- on every UPDATE and refuses both with `invoice.state_invalid: the identity of
-- an invoice is final`. It is a BEFORE trigger, so IT ANSWERS FIRST and the row
-- never reaches this file's edge: the permanent test asserts that refusal by
-- name and NOT a `foreign_key_violation`, because asserting the SQLSTATE would
-- be asserting a mechanism that does not run.
--
-- What the widened edge adds on the parent side is therefore a SECOND,
-- INDEPENDENT line behind a guard in the frozen prefix, and the difference is
-- the usual one: a guard is a BODY, which a later migration can replace, while
-- an edge is a SHAPE, which cannot be satisfied. `customer_id` is now part of
-- the tuple a settlement row depends on, so the parent cannot be dissolved
-- under it whatever happens to the guard. Nothing here is a live hole being
-- plugged, and claiming otherwise would have overstated this file.
--
-- ── R-96 THE VERIFIER'S TWO ARMS ARE KEPT, AND BECOME UNREACHABLE ────────
--
-- `invoice_settlement_verify` is NOT touched by this file — not its body, not
-- its digest, not its wiring, and neither of its two refusal codes
-- (`invoice_settlement.customer_mismatch`,
-- `invoice_settlement.walkin_not_settleable`) is removed. They are now
-- UNREACHABLE THROUGH THE RELATIONS, because the row that would raise them
-- can no longer be inserted; they remain the answer for any future caller that
-- reaches the routine by another road, and for the R-83 chain arithmetic the
-- same routine carries, which this file does not address and must not disturb.
--
-- A reader who expects to see the arms deleted should not: removing a check
-- because a stronger one subsumes it trades defence in depth for tidiness, and
-- would also mean replacing a candidate body with extensive green CI evidence
-- behind it. Nothing here replaces a routine.
--
-- ── R-97 WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────
--
--   — It adds no trigger, no routine and no relation. The pin is two
--     catalogue shapes and an assertion that they hold.
--   — It does not touch `payment_method_guard()` or its `posting_account_locked`
--     arm (`0067:839-841`). R-85 of `0081` discloses that arm as naming
--     `supplier_payments` and `supplier_refunds` only, and concludes a method
--     that has taken a CUSTOMER payment "may still move its posting account".
--     THAT CONCLUSION IS FALSE, and no change is needed to make it false:
--     `payments_method_fk` (`0081:281-284`) is the SAME three-column edge into
--     `payment_methods (business_id, id, posting_account_id)` that
--     `supplier_payments_method_fk` (`0067:351-352`) is, and an `UPDATE` of
--     `payment_methods.posting_account_id` under a live `payments` row is
--     refused by that edge's parent-side action, exactly as it is under a live
--     `supplier_payments` row. The posting account is not client-selected (it
--     is part of the key into the method row) and it cannot drift (the edge
--     refuses the parent update). What `payment_method_guard()`'s arm adds on
--     the supplier side is a NAMED refusal in place of a raw
--     `foreign_key_violation`, which is a diagnostics difference and not an
--     integrity one; closing it would mean replacing a Phase 3 body and
--     re-recording its SHA-256 inside `supplier_settlement_guard_gaps()`
--     (`0072:700-720`), which is cross-phase surface this file has no ruling
--     for. The lock is proved, as a lock, by a permanent test rather than
--     asserted here.
--   — It infers, researches and writes NO tax rule. Sales tax stays
--     structurally zero and nothing here carries a tax element (`0081` R-92,
--     OD-03 stays open).
--   — It does not touch `MIGRATION_MANIFEST.json`. `frozenThrough` is a floor
--     and sealing is the Tech Lead's.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The candidate key on the P4-S1 invoice table, in the shape and with the
--    standing of `0067:274`. NON-PARTIAL (R-94): it contains the primary key,
--    so it validates on any data, including the walk-in rows whose
--    `customer_id` IS NULL.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE invoices ADD CONSTRAINT invoices_customer_uq UNIQUE (business_id, id, customer_id);

COMMENT ON CONSTRAINT invoices_customer_uq ON invoices IS
  'P4-S4 corrective (0082, R-94). The non-partial candidate key the two settlement reducers pin their customer against, in the shape and with the standing of 0067:274: it contains the primary key (business_id, id), so it is unique whatever customer_id holds and validates on any data, walk-in rows included. It exists to be a FOREIGN KEY TARGET and for no other reason; a walk-in invoice''s NULL customer_id does not collide with another''s, because a unique index treats NULLs as distinct.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The two reducer edges, widened onto that key.
--
--    Each narrow edge is dropped and re-added under THE SAME CONSTRAINT NAME,
--    so every catalogue reader that names `payment_allocations_invoice_fk` or
--    `customer_credit_applications_invoice_fk` — `0081`'s own end-state
--    assertion, the suites, the gate — keeps finding one invoice edge per
--    reducer, now the three-column one. Adding a second, wider edge beside the
--    narrow one would leave two overlapping constraints and two per-row checks
--    saying the same thing, with the weaker one still the name a reader finds
--    first.
--
--    `ON DELETE RESTRICT` is carried over from `0081:357` and `0081:493`
--    unchanged. The parent-side action is left at the default NO ACTION, which
--    is what carries R-95's SECOND LINE — behind `invoices_lifecycle_guard()`,
--    which answers first and is where the refusal a caller actually reads
--    comes from.
--
--    The edge is NOT DEFERRABLE, on purpose. A deferred edge would make the
--    mismatch refusable at COMMIT, which is what `invoice_settlement_verify`
--    already did; an immediate edge makes it unrepresentable at the statement,
--    which is what was asked for. Nothing lawful needs the deferral: the
--    invoice a reducer names exists and is locked before either command writes
--    the reducer row (`customer_collect_payment`, `customer_apply_credit`).
--
--    The ADD validates the existing rows. Every allocation and application on
--    disk was admitted by `invoice_settlement_verify`'s customer arm, so a
--    lawful estate validates silently — and an estate that does NOT is one
--    holding a cross-customer settlement, in which case this statement fails
--    loudly at deployment, which is the correct outcome and the reason the
--    constraint is not added `NOT VALID`.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_invoice_fk;
ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_invoice_fk
  FOREIGN KEY (business_id, invoice_id, customer_id)
  REFERENCES invoices (business_id, id, customer_id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT payment_allocations_invoice_fk ON payment_allocations IS
  'P4-S4 corrective (0082, R-94/R-95), widening 0081:357 from (business_id, invoice_id) onto invoices_customer_uq. The customer identity pin and the walk-in law are now SHAPES, not invoice_settlement_verify arms: this row''s customer_id is NOT NULL, so all three referencing columns are non-null, so the edge is checked on every row, so an allocation of customer C against an invoice of customer D has no target and an allocation against a walk-in invoice (customer_id IS NULL) has no target either. On the parent side it is a SECOND line under invoices_lifecycle_guard() (0075:546-556), which already freezes customer_id and, being a BEFORE trigger, answers first: re-parenting and orphaning a settled invoice are refused by that guard today, and by this shape if the guard is ever replaced. See 0082 R-95.';

ALTER TABLE customer_credit_applications DROP CONSTRAINT customer_credit_applications_invoice_fk;
ALTER TABLE customer_credit_applications
  ADD CONSTRAINT customer_credit_applications_invoice_fk
  FOREIGN KEY (business_id, invoice_id, customer_id)
  REFERENCES invoices (business_id, id, customer_id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT customer_credit_applications_invoice_fk ON customer_credit_applications IS
  'P4-S4 corrective (0082, R-94/R-95), widening 0081:493 onto invoices_customer_uq, with the same standing as the allocation edge. A law enforced on one of the two settling relations and not the other is half a law, so both widen in this one file and the assertion below quantifies over both.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The END-STATE ASSERTION, in the shape of `0081`'s §(3) and inverted.
--
--    `0081:2606-2639` asserted that the departure was TAKEN — the narrow edge
--    present, the key absent — "so the day the Tech Lead rules the other way
--    the assertion changes with the edge and nobody has to rediscover why it
--    was narrow." This is that day and this is that assertion, read from the
--    catalogue rather than from this file's own text, so it describes the
--    database and not a wish.
--
--    It asserts FOUR things, because three of them are the ones a plausible
--    "simplification" would quietly drop:
--      (1) each reducer's invoice edge is a VALIDATED, non-deferrable,
--          RESTRICT-on-delete, three-column edge onto `invoices`
--          (business_id, id, customer_id) — `convalidated` matters, because a
--          `NOT VALID` edge pins new rows only;
--      (2) the key it targets exists and its index is NON-PARTIAL — a partial
--          index here would be the obstacle R-94 dissolves, reintroduced;
--      (3) each reducer's `customer_id` is NOT NULL — this is what makes the
--          edge fire on every row under MATCH SIMPLE, and it is the whole of
--          the walk-in law. A nullable `customer_id` would turn the pin into a
--          suggestion while leaving every constraint definition looking right;
--      (4) `invoices.customer_id` is still NULLABLE — the walk-in invoice must
--          remain representable. A pin accidentally bought by forbidding
--          walk-in sales would be a product change, not an invariant.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name  TEXT;
  v_index OID;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = v_name || '_invoice_fk' AND c.conrelid = ('public.' || v_name)::regclass
                      AND c.contype = 'f' AND c.convalidated AND NOT c.condeferrable
                      AND c.confrelid = 'public.invoices'::regclass
                      AND c.confdeltype = 'r'
                      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                             FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                          = ARRAY['business_id', 'invoice_id', 'customer_id']
                      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                             FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                          = ARRAY['business_id', 'id', 'customer_id']) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %''s invoice edge is not the validated, immediate, three-column RESTRICT edge onto invoices (business_id, id, customer_id) the structural pin is', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- (3) The NOT NULL that makes the edge fire on every row. Without it the
    --     edge above still reads correctly and pins nothing, because MATCH
    --     SIMPLE skips a referencing tuple holding any NULL.
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attname = 'customer_id'
                      AND NOT a.attisdropped AND a.attnotnull) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %.customer_id is nullable, so MATCH SIMPLE would skip the invoice edge on a NULL row and the pin would hold on nothing', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (2) The key, and its index's non-partiality.
  SELECT c.conindid INTO v_index
    FROM pg_constraint c
   WHERE c.conrelid = 'public.invoices'::regclass AND c.contype = 'u' AND c.conname = 'invoices_customer_uq'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         = ARRAY['business_id', 'id', 'customer_id'];
  IF v_index IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices does not carry the UNIQUE (business_id, id, customer_id) key the two reducer edges target'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = v_index AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices_customer_uq is backed by a PARTIAL index, which PostgreSQL does not accept as a foreign-key target — the key is non-partial precisely because it contains the primary key (0082 R-94)'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) The walk-in invoice is still representable.
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = 'public.invoices'::regclass AND a.attname = 'customer_id'
                AND NOT a.attisdropped AND a.attnotnull) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices.customer_id became NOT NULL — the walk-in invoice (0075:248) must stay representable, and a pin bought by forbidding walk-in sales is a product change and not an invariant'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;
