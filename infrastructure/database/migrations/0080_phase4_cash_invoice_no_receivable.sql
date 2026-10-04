-- 0080_phase4_cash_invoice_no_receivable.sql
-- Phase 4 / P4-S4 — THE DERIVED RECEIVABLE MUST AGREE WITH THE LEDGER
-- (the Tech Lead's performance-evidence directive of 2026-10-04 §20, which
-- rules that P4-S4 owns this defect first and corrects it with a new
-- migration or read-contract correction, and that nothing merges before it
-- closes; docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-05, P4-AL-06, P4-AL-24,
-- R-SAL-01, R-SAL-02; OQ-2 of the P4-S4 implementation map).
--
-- Migrations 0000-0079 are FROZEN and untouched. This file is a CANDIDATE:
-- no MIGRATION_MANIFEST.json entry and no `frozenThrough` movement, because
-- only an acceptance commit freezes a digest (TL-P4-S1-C8).
--
-- ── THE DEFECT, AS IT IS ON THE 0079 HEAD ───────────────────────────────
--
-- A CASH-settled sale to a NAMED customer is legal and intended: the row
-- check `sales_credit_customer_ck` (`0077:294`) is
-- `settlement_mode = 'cash' OR customer_id IS NOT NULL`, so naming the
-- customer of a cash sale is permitted — a receipt for a known buyer.
--
-- For such a sale the general ledger carries NO receivable. The invoice
-- entry's debit account is chosen by the sale's settlement mode
-- (`0077:1457`): `CASE v_settle WHEN 'cash' THEN 'cash' ELSE
-- 'accounts_receivable' END`. A cash sale debits `cash` and the AR account
-- is never touched.
--
-- But `invoice_outstanding` (`0075:722`) keys on ONE column —
-- `invoices.status` — and reports the full total as outstanding for every
-- `open` invoice. `customer_ar_outstanding` (`0075:780`) then sums those
-- totals, and `customer_ar_aging` (`0075:798`) ages them. So a cash sale to
-- a named customer reports a receivable that the ledger does not have.
--
-- The consequences are not cosmetic. `R-SAL-01` — "AR from the journal =
-- Σ(invoice totals) − Σ(allocations) − …" — and `R-SAL-02` cannot both hold
-- while this is true, so the reconciliation P4-S4 must satisfy is
-- unsatisfiable before this is fixed. Worse, a merchant could be shown an
-- amount "owed" on an invoice that was paid at the till and collect it: the
-- resulting entry would debit cash a second time and credit a receivable
-- that was never debited.
--
-- ── WHAT THIS FILE CHANGES, AND WHY IT IS ONE FUNCTION ──────────────────
--
-- Exactly one routine is replaced: `invoice_outstanding`. Every other
-- derived reader sits on top of it and needs no edit, which is the whole
-- argument for correcting it here rather than in four places:
--
--   * `invoice_settlement_state` (`0075:751`) derives from `paid_txn_minor`,
--     so a cash invoice now reports `paid` — which is what the ledger says:
--     the money was taken at the till.
--   * `customer_ar_outstanding` (`0075:780`) already ends in
--     `HAVING sum(outstanding_txn_minor) <> 0`, so a customer whose only
--     invoices are cash-settled now returns NO ROW rather than a zero one.
--   * `customer_ar_aging` (`0075:798`) already filters
--     `o.outstanding_txn_minor <> 0`, so a cash invoice drops out of every
--     bucket by the filter it already had.
--
-- The settlement mode is read from `sales`, a DOCUMENT table, never from the
-- journal: `0075`'s design note is explicit that these readers compute from
-- the document tables, which is also why `journal_lines` needs no customer
-- dimension. The join is total and cannot lose a row — `invoices.sale_id` is
-- `NOT NULL` and `invoices_sale_fk` (`0077:353`) is a VALIDATED composite
-- edge to `sales (business_id, id)` — so `NOT FOUND` still means exactly
-- what it meant before: this business has no such invoice.
--
-- The routine stays SECURITY INVOKER (R-P4-07), and that is safe for both
-- grantees rather than assumed to be: `daftar_app` and
-- `daftar_inventory_internal` each hold `SELECT ON sales` (`0077:481-482`),
-- and `sales`'s row security scopes a business exactly as `invoices`'s does,
-- so a caller that can see the invoice can see its sale and a caller that
-- cannot see the invoice never reaches the join.
--
-- WHAT THIS FILE DOES NOT DO. It creates no relation, adds no column, moves
-- no money, registers no source type, grants no new privilege, and changes
-- no accounting routine. `paid + outstanding = total` holds for a cash
-- invoice (total + 0) exactly as it does for a credit one (0 + total).
-- Seam S-P4-03 is NOT closed by this file: no relation that settles an
-- invoice exists yet, so the body still subtracts nothing, and the day
-- `payment_allocations` lands the seam guard is red until the body reads it.

DO $pre$
BEGIN
  -- The head this file applies on: P4-S3's two POS relations, and nothing
  -- after them.
  IF to_regclass('public.pos_till_sessions') IS NULL OR to_regclass('public.pos_cart_lines') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0080 applies on the 0079 head (the POS till session and cart) only'
      USING ERRCODE = 'P0001';
  END IF;

  -- The routine being replaced, by its exact identity argument types.
  IF to_regprocedure('public.invoice_outstanding(UUID, UUID)') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_outstanding(UUID, UUID) does not exist, so there is nothing to correct'
      USING ERRCODE = 'P0001';
  END IF;

  -- THE DEFECT IS PROVED PRESENT BEFORE IT IS CORRECTED. A migration whose
  -- subject is already absent is a migration nobody can tell from a no-op,
  -- and this one would be exactly that if the body in the live catalogue had
  -- already learned the settlement mode ([[daftar-a-green-gate-must-prove-it-can-be-red]]).
  IF (SELECT pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'))) LIKE '%settlement_mode%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_outstanding already reads the settlement mode, so 0080 has no defect to close'
      USING ERRCODE = 'P0001';
  END IF;

  -- The source of truth this file starts reading, and the edge that makes
  -- the read total.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'public.sales'::regclass AND a.attname = 'settlement_mode' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sales.settlement_mode is missing, so the correction has no source'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'invoices_sale_fk' AND c.conrelid = 'public.invoices'::regclass
                    AND c.contype = 'f' AND c.convalidated) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices_sale_fk is not a validated edge, so the join below could lose a row'
      USING ERRCODE = 'P0001';
  END IF;

  -- Seam S-P4-03 is still open, and this file does not close it.
  IF to_regclass('public.payment_allocations') IS NOT NULL
     OR to_regclass('public.customer_credit_applications') IS NOT NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a settlement relation exists, so invoice_outstanding owes a subtraction 0080 does not write'
      USING ERRCODE = 'P0001';
  END IF;

  -- PRE-STATE CAPTURE (the accepted shape is `0061:104-116`). Owner,
  -- security, pinned path and ACL, as one string, transaction-local and
  -- compared in this same transaction's end state. A replacement is supposed
  -- to change the BODY and nothing else, and this is what proves it did.
  PERFORM set_config('daftar.p4s4_pre_invoice_outstanding',
    (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
       FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)')), true);
  -- And the three readers above it, which must come out byte-identical.
  PERFORM set_config('daftar.p4s4_pre_readers_above',
    (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_get_functiondef(f.oid), '|' ORDER BY f.oid))
       FROM (SELECT to_regprocedure('public.invoice_settlement_state(UUID, UUID)') AS oid
             UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
             UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f), true);
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- The corrected reader-of-record.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status     TEXT;
  v_settle     TEXT;
  v_total_txn  BIGINT;
  v_total_base BIGINT;
BEGIN
  SELECT i.status, s.settlement_mode, i.total_txn_minor, i.total_base_minor
    INTO v_status, v_settle, v_total_txn, v_total_base
    FROM public.invoices i
    JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
   WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  -- A draft was never posted and a void document was reversed, so neither
  -- owes anything.
  IF v_status <> 'open' THEN
    RETURN QUERY SELECT 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::BIGINT;
    RETURN;
  END IF;
  -- A CASH-settled invoice was paid where it was issued: the ledger debited
  -- `cash` for its whole total and never touched the receivable account
  -- (`0077:1457`), so the customer owes nothing on it. Reporting it as paid
  -- rather than as four zeros is what keeps `paid + outstanding = total`
  -- true and what makes `invoice_settlement_state` say `paid` instead of
  -- `unpaid` about a document whose money is in the till.
  IF v_settle = 'cash' THEN
    RETURN QUERY SELECT v_total_txn, v_total_base, 0::BIGINT, 0::BIGINT;
    RETURN;
  END IF;
  -- Seam S-P4-03, still open: nothing that settles a CREDIT invoice exists
  -- yet, so nothing is subtracted and this says so.
  RETURN QUERY SELECT 0::BIGINT, 0::BIGINT, v_total_txn, v_total_base;
END;
$$;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID) IS
  'P4-S4 (§20 of the Tech Lead directive of 2026-10-04; P4-AL-05, P4-AL-07): the reader-of-record of an invoice paid and outstanding amount, which is refused as a stored column by P4-AL-06. A cash-settled invoice reports paid = total and outstanding = 0, because the invoice entry debited `cash` and never the receivable account, and a derived read that disagrees with the ledger is the defect this replaced. A draft or void document reports zeros. Seam S-P4-03 stays open: replaced again by the slice that creates the relations that settle a credit invoice.';

DO $post$
DECLARE
  v_def TEXT;
BEGIN
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'));

  -- 0080-E(1). The correction is in the LIVE CATALOGUE, not only in this
  -- file: the body that runs reads the settlement mode and the sale it
  -- belongs to.
  IF v_def NOT LIKE '%settlement_mode%' OR v_def NOT LIKE '%public.sales%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live invoice_outstanding does not read its sale''s settlement mode'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0080-E(2). ONLY THE BODY MOVED. Owner, SECURITY INVOKER, the pinned
  -- path and the whole ACL compare EQUAL to the capture taken before the
  -- replacement, so nobody gained EXECUTE and no authority was re-granted
  -- by accident.
  IF (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)'))
     IS DISTINCT FROM current_setting('daftar.p4s4_pre_invoice_outstanding', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the replacement changed the owner, security, path or ACL of invoice_outstanding'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0080-E(3). And the accepted configuration stated absolutely, not only
  -- as "unchanged": a capture compared against itself proves nothing if the
  -- function was already wrong before this file ran. STABLE, invoker's
  -- rights, the pinned path, EXECUTE for exactly the two accepted roles and
  -- NOTHING for PUBLIC.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)')
                    AND p.provolatile = 's' AND NOT p.prosecdef
                    AND p.proconfig IS DISTINCT FROM NULL
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_outstanding is no longer a STABLE, SECURITY INVOKER routine with its pinned search_path'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text)
        FROM pg_proc p, aclexplode(p.proacl) x
       WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)')
         AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner)
     IS DISTINCT FROM ARRAY['daftar_app', 'daftar_inventory_internal'] THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: EXECUTE on invoice_outstanding is not exactly the two accepted roles'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
              WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)') AND x.grantee = 0) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: PUBLIC holds a privilege on invoice_outstanding'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0080-E(4). The three readers above it are BYTE-IDENTICAL. The correction
  -- is meant to reach them through composition; a copy of the cash branch in
  -- any of them would be a second place to keep it right.
  IF (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_get_functiondef(f.oid), '|' ORDER BY f.oid))
        FROM (SELECT to_regprocedure('public.invoice_settlement_state(UUID, UUID)') AS oid
              UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
              UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f)
     IS DISTINCT FROM current_setting('daftar.p4s4_pre_readers_above', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a reader above invoice_outstanding was changed by 0080'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0080-E(5). Nothing else moved: this file creates no relation, so the
  -- settlement relations are still absent and the seam is still open.
  IF to_regclass('public.payments') IS NOT NULL OR to_regclass('public.payment_allocations') IS NOT NULL
     OR to_regclass('public.customer_credits') IS NOT NULL OR to_regclass('public.customer_credit_applications') IS NOT NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0080 created a relation it has no business creating'
      USING ERRCODE = 'P0001';
  END IF;
END
$post$;
