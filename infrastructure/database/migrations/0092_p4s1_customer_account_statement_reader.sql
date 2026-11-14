-- 0092_p4s1_customer_account_statement_reader.sql
-- L3 / P4-S1 — THE CUSTOMER ACCOUNT STATEMENT READER: ONE reader,
-- `customer_account_statement(UUID, UUID)`, which returns the statement
-- rows TOGETHER WITH the running balance, and NOTHING else. No table, no
-- column, no trigger, no registry row, no grant on any relation, and zero
-- DML of any kind.
--
-- ── The authority this file rests on ───────────────────────────────────
--
-- Owner permit DR-146 (2026-11-12), quoted:
--
--   «نعم، أذنت بـ 0092»
--
-- answering the design card, and its scope is exactly: ONE migration
-- creating ONE reader that returns the statement rows together with the
-- running balance, computed BY A CUMULATIVE WINDOW INSIDE THE READER —
-- so the summation lives in the database and not in the read's own SQL
-- and not in TypeScript (`P4-AL-07`) — with EXECUTE to `daftar_app`
-- alone, zero DML, and the statement CLOSING ON the registered
-- reader-of-record per currency.
--
-- Therefore this file does NOT touch `0091` (the customer WRITE path, a
-- signed file with its own scope), does NOT alter any existing reader,
-- does NOT change any grant, and does NOT write the runtime grant-model
-- entry: the owner signs that entry himself, as he did for `0091`.
--
-- ── The number, measured (DR-103/«رقم الهجرة يُقاس لحظة الكتابة») ──────
--
-- Measured on this base (`origin/main` at `8b1a6780`) and across EVERY
-- local and remote ref, by `git ls-tree -r <ref> infrastructure/database/
-- migrations`:
--
--     highest on this base ............ 0086
--     0087 ............................ free
--     0088 ............................ CLAIMED — p5/release-gates-dr100-dr97
--                                       (0088_p5_billing_platform_credit_ledger.sql)
--     0089 ............................ CLAIMED — p4s7/installment-aging-build
--     0090 ............................ CLAIMED — mvp03/ar-source-document-guard
--     0091 ............................ CLAIMED — l3/customer-write-endpoints
--     0092 ............................ free
--
-- The probe is SIGHTED, not blind: it returned a file name for four of
-- the six numbers it was asked about, which is the positive control the
-- two zeros need (RULE-11). Taking the free `0087` would insert this
-- migration BEFORE four unmerged ones and change their order, which the
-- sequential-migration rule forbids. So `0092`, and `0092` merges AFTER
-- `0091`.
--
-- `frozenThrough` is `0079_phase4_pos_till_sessions_cart.sql` and no file
-- at or below it is touched here: this migration adds one file and edits
-- none.
--
-- ── Why this is a reader and not arithmetic in the read ────────────────
--
-- `P4-AL-07` refuses a money sum computed in TypeScript over a page of
-- rows: a per-row running balance assembled in the application is a
-- second definition of the balance, and the page boundary would decide
-- its value. The precedent for a reader that legitimately sums is
-- `customer_ar_outstanding` (`0083:365-378`), which sums INSIDE its own
-- body over the whole set. The cumulative window here is the same move
-- one dimension further: the sum is taken over the whole ordered set,
-- per currency, so the value on a row does not depend on which page the
-- caller asked for.
--
-- ── INVOKER, and the direction of that substitution ───────────────────
--
-- This reader is SECURITY INVOKER, `LANGUAGE sql STABLE`, exactly like
-- every reader-of-record that `daftar_app` may execute:
-- `customer_ar_outstanding` and `customer_ar_aging` (`0083`),
-- and the two readers `0084` added (the open-document counts, and the
-- open-invoice page). Those last two are named here in prose and not by
-- identifier on purpose: the ownership law in
-- tests/performance/receivables-open-page-equivalence.test.ts §11 counts
-- EVERY migration whose text contains the page reader's name, comments
-- included, to keep `0084` the single place that defines it -- and this
-- migration defines no reader of `0084`'s, it only stands beside them.
-- It is NOT SECURITY DEFINER, and that is a deliberate
-- substitution for the DEFINER shape `0091`'s WRITE routines carry,
-- stated here with its direction of error:
--
--   * INVOKER leaves ROW SECURITY ON. `p_business_id` is therefore a
--     FILTER applied on top of the caller's own policies, never a claim
--     the caller asserts about itself. A caller who passes another
--     merchant's id gets ZERO ROWS — the empty answer
--     `01-cross-tenant.golden.test.ts:565` already pins for
--     `customer_ar_outstanding`.
--   * A DEFINER reader granted to `daftar_app` would BYPASS those
--     policies, and `p_business_id` would become self-asserted: the only
--     thing standing between two merchants would be a hand-written
--     check inside the body. The error direction there is ANOTHER
--     MERCHANT'S ROWS RETURNED.
--   * So the two directions are: INVOKER can only ever return FEWER rows
--     than asked for; DEFINER can return rows that belong to someone
--     else. Fewer is the safe direction for a statement, and a statement
--     that is short is visibly short, while a statement that is wide is
--     a leak nobody sees. DEFINER's one advantage — reaching a relation
--     the caller holds no SELECT on — buys nothing here: `daftar_app`
--     already holds SELECT on all five relations this reader reads
--     (`customers`/`invoices` `0075:494`, `payments` /
--     `payment_allocations` / `customer_credits` /
--     `customer_credit_applications` `0081:615`, `sales` `0077:481`).
--
-- The internal merchant check this file carries is therefore the
-- STRUCTURAL one, asserted from the live catalogue at the end: every one
-- of the five leaf branches restricts on `business_id = p_business_id`,
-- and row security restricts it again.
--
-- ── What the rows are, and why the statement closes ───────────────────
--
-- The debit side holds ONLY what `customer_ar_outstanding` counts — an
-- OPEN invoice document of a CREDIT sale, the predicate of
-- `invoice_outstanding` (`0080`/`0084`). A cash-settled, draft or void
-- invoice is not a debt and is not a debit row. The credit side holds
-- ONLY what is APPLIED to such a document, in that document's own
-- currency: one row per payment allocation and per credit application,
-- the stored `invoice_amount_applied_minor`, which is the very column
-- the reader of record sums. So, per currency,
--
--     the LAST running balance  ==  customer_ar_outstanding.txn_minor
--
-- EXACTLY, as an absolute integer value and not as an identity between
-- two sums computed the same way. The payment as received and the
-- retained credit are STATED rows with NEITHER side, so no unapplied
-- money is posted a second time and the credit balance is never netted
-- against the receivable (DR-114/(ب)).
--
-- Every amount is BIGINT in MINOR UNITS. No float, no rounded
-- intermediate, no division. The window's `sum()` over BIGINT is
-- `numeric` in PostgreSQL and is cast back to BIGINT once, at the end,
-- with no intermediate rounding possible: every addend is an integer.
--
-- The order is `(entry_date, kind_rank, entry_id)` — a total order, so a
-- page boundary can neither repeat nor skip a row — and the window
-- partitions by `currency_code`, so a column is never summed across
-- currencies. A row whose currency holds no debit carries a running
-- balance of 0, which is a fact and not an error. A customer in credit
-- carries a NEGATIVE running balance, which is also a fact.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The reader.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION customer_account_statement(p_business_id UUID, p_customer_id UUID)
RETURNS TABLE (
  entry_kind                  TEXT,
  entry_id                    UUID,
  entry_date                  DATE,
  kind_rank                   INTEGER,
  document_number             TEXT,
  related_id                  UUID,
  currency_code               TEXT,
  debit_txn_minor             BIGINT,
  credit_txn_minor            BIGINT,
  amount_txn_minor            BIGINT,
  amount_base_minor           BIGINT,
  credit_original_txn_minor   BIGINT,
  credit_remaining_txn_minor  BIGINT,
  credit_remaining_base_minor BIGINT,
  reference                   TEXT,
  running_balance_txn_minor   BIGINT
)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.entry_kind,
         s.entry_id,
         s.entry_date,
         s.kind_rank,
         s.document_number,
         s.related_id,
         s.currency_code,
         s.debit_txn_minor,
         s.credit_txn_minor,
         s.amount_txn_minor,
         s.amount_base_minor,
         s.credit_original_txn_minor,
         s.credit_remaining_txn_minor,
         s.credit_remaining_base_minor,
         s.reference,
         (pg_catalog.sum(coalesce(s.debit_txn_minor, 0) - coalesce(s.credit_txn_minor, 0))
            OVER (PARTITION BY s.currency_code
                      ORDER BY s.entry_date, s.kind_rank, s.entry_id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::BIGINT
    FROM (
      -- (1) The debit: an OPEN invoice document of a CREDIT sale. The same
      --     predicate `invoice_outstanding` counts, and nothing else.
      SELECT 'invoice'::TEXT AS entry_kind, i.id AS entry_id, i.issue_date AS entry_date, 1 AS kind_rank,
             i.document_number::TEXT AS document_number, NULL::UUID AS related_id, i.currency_code::TEXT AS currency_code,
             i.total_txn_minor::BIGINT AS debit_txn_minor, NULL::BIGINT AS credit_txn_minor,
             i.total_txn_minor::BIGINT AS amount_txn_minor, i.total_base_minor::BIGINT AS amount_base_minor,
             NULL::BIGINT AS credit_original_txn_minor, NULL::BIGINT AS credit_remaining_txn_minor,
             NULL::BIGINT AS credit_remaining_base_minor, NULL::TEXT AS reference
        FROM public.invoices i
        JOIN public.sales sl ON sl.business_id = i.business_id AND sl.id = i.sale_id
       WHERE i.business_id = p_business_id AND i.customer_id = p_customer_id
         AND i.document_kind = 'invoice' AND i.status = 'open' AND sl.settlement_mode = 'credit'
      UNION ALL
      -- (2) The payment as RECEIVED: a stated row with neither side, so the
      --     money is visible once it is applied and not twice.
      SELECT 'payment'::TEXT, p.id, p.payment_date, 2,
             NULL::TEXT, NULL::UUID, p.currency_code::TEXT,
             NULL::BIGINT, NULL::BIGINT,
             p.amount_minor::BIGINT, p.base_amount_minor::BIGINT,
             NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, p.reference::TEXT
        FROM public.payments p
       WHERE p.business_id = p_business_id AND p.customer_id = p_customer_id
      UNION ALL
      -- (3) The credit side: one row per payment allocation, the stored
      --     applied amount, in the DOCUMENT's currency.
      SELECT 'payment_allocation'::TEXT, pa.id, p.payment_date, 3,
             ai.document_number::TEXT, pa.invoice_id, pa.invoice_currency::TEXT,
             NULL::BIGINT, pa.invoice_amount_applied_minor::BIGINT,
             pa.invoice_amount_applied_minor::BIGINT, pa.invoice_carrying_base_released_minor::BIGINT,
             NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, p.reference::TEXT
        FROM public.payment_allocations pa
        JOIN public.payments p ON p.business_id = pa.business_id AND p.id = pa.payment_id
        JOIN public.invoices ai ON ai.business_id = pa.business_id AND ai.id = pa.invoice_id
        JOIN public.sales asl ON asl.business_id = ai.business_id AND asl.id = ai.sale_id
       WHERE pa.business_id = p_business_id AND pa.customer_id = p_customer_id
         AND ai.document_kind = 'invoice' AND ai.status = 'open' AND asl.settlement_mode = 'credit'
      UNION ALL
      -- (4) The held credit: the STORED `remaining_amount_minor` (`0081:390`)
      --     read as it is, never computed here, with no side of its own so it
      --     is never netted against the receivable.
      SELECT 'credit'::TEXT, c.id, c.credit_date, 4,
             NULL::TEXT, c.origin_payment_id, c.currency_code::TEXT,
             NULL::BIGINT, NULL::BIGINT,
             NULL::BIGINT, NULL::BIGINT,
             c.original_amount_minor::BIGINT, c.remaining_amount_minor::BIGINT,
             c.remaining_carrying_base_amount_minor::BIGINT, NULL::TEXT
        FROM public.customer_credits c
       WHERE c.business_id = p_business_id AND c.customer_id = p_customer_id
      UNION ALL
      -- (5) The credit side: one row per credit application.
      SELECT 'credit_application'::TEXT, a.id, a.application_date, 5,
             ai.document_number::TEXT, a.invoice_id, a.invoice_currency::TEXT,
             NULL::BIGINT, a.invoice_amount_applied_minor::BIGINT,
             a.invoice_amount_applied_minor::BIGINT, a.invoice_carrying_base_released_minor::BIGINT,
             NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::TEXT
        FROM public.customer_credit_applications a
        JOIN public.invoices ai ON ai.business_id = a.business_id AND ai.id = a.invoice_id
        JOIN public.sales asl ON asl.business_id = ai.business_id AND asl.id = ai.sale_id
       WHERE a.business_id = p_business_id AND a.customer_id = p_customer_id
         AND ai.document_kind = 'invoice' AND ai.status = 'open' AND asl.settlement_mode = 'credit'
    ) s
   ORDER BY s.entry_date, s.kind_rank, s.entry_id;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The privilege, at its narrowest: PUBLIC loses everything, and
--    `daftar_app` ALONE is granted EXECUTE. Not `daftar_inventory_internal`,
--    not `daftar_accounting_internal`: no internal routine consumes this
--    reader, and EXECUTE is reachability, so a grant with no consumer is an
--    authority nothing exercises
--    ([[daftar-execute-is-reachability-not-authority]]).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION customer_account_statement(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_account_statement(UUID, UUID) TO daftar_app;

COMMENT ON FUNCTION customer_account_statement(UUID, UUID) IS
  'L3 / P4-S1 (0092; DR-146, P4-AL-07): THE ONE DEFINITION of the customer account statement and of its RUNNING BALANCE. One row per credit sales document, payment, payment allocation, held credit and credit application of the customer, ordered by (entry_date, kind_rank, entry_id), each carrying running_balance_txn_minor — the cumulative sum of debit minus credit over the whole ordered set, PARTITIONED BY currency_code, computed by a window INSIDE this reader so the value on a row never depends on which page the caller asked for. The statement CLOSES ON the reader of record: per currency, the LAST running balance equals customer_ar_outstanding.txn_minor exactly, because the debit side holds only what invoice_outstanding counts (an open invoice document of a credit sale) and the credit side only what is applied to such a document. The payment as received and the held credit are stated rows with NEITHER side, so unapplied money is never posted twice and the credit balance is never netted against the receivable (DR-114). All amounts are BIGINT minor units; the held credit''s remaining_amount_minor is the stored column read as it is. A customer in credit carries a negative running balance, and a currency with no debit carries zero: both are facts, not errors. INVOKER and STABLE — row security stays ON, so p_business_id is a filter on top of the caller''s own policies and never a claim the caller asserts about itself; a foreign business id returns zero rows. Writes nothing. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 0092-E — the end state, read from the LIVE CATALOGUES and never from
--    this file's own statements. A migration that asserts what it just
--    wrote asserts nothing. Every claim is numbered so a failure names
--    itself, and every claim that asserts an ABSENCE carries a positive
--    control in the SAME query so a zero cannot come from a blind probe.
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  c_stmt CONSTANT OID := to_regprocedure('public.customer_account_statement(uuid,uuid)');
  v_src  TEXT;
BEGIN
  -- (1) The reader exists.
  IF c_stmt IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_account_statement is missing' USING ERRCODE = 'P0001';
  END IF;

  -- (2) It is STABLE, it is NOT SECURITY DEFINER, and it carries the PINNED
  --     search_path as a literal in `proconfig` — not inherited, and not
  --     read from `current_setting`. The three arms are read from one row,
  --     and the row itself is the positive control for the `prosecdef`
  --     negative: the same probe that proves the path proves the shape.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_stmt;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = c_stmt
       AND p.provolatile = 's'
       AND NOT p.prosecdef
       AND array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp%') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_account_statement is not INVOKER STABLE with the pinned search_path'
      USING ERRCODE = 'P0001';
  END IF;

  -- (3) EXECUTE reaches `daftar_app` and NOT PUBLIC. The reachability arm is
  --     the control for the PUBLIC arm: the same probe on the same oid. The
  --     PUBLIC arm reads the ACL through `acldefault('f', …)` and NOT
  --     `coalesce(…, '{}')`, because a NULL `proacl` IS the default acl —
  --     which GRANTS PUBLIC execute — and an empty-array substitution would
  --     report the most permissive state as the safest one (`0042:516-521`).
  IF NOT has_function_privilege('daftar_app', c_stmt, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p
                 CROSS JOIN LATERAL unnest(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE p.oid = c_stmt AND acl::text LIKE '=%') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_account_statement is not reachable by daftar_app alone'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) The ACL itself names exactly ONE grantee other than the owner, and
  --     that grantee is `daftar_app`. This is read from `proacl` and not
  --     through `has_function_privilege` per role, because that function
  --     answers for role MEMBERSHIP as well as for a direct grant, and the
  --     claim here is about the GRANT. The owner's own implicit entry is
  --     excluded by name, which is also this probe's positive control: the
  --     count it compares against 1 is a count it really produced.
  IF (SELECT pg_catalog.count(*)
        FROM pg_proc p
        CROSS JOIN LATERAL unnest(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.oid = c_stmt
         AND pg_catalog.split_part(acl::text, '=', 1) NOT IN ('', p.proowner::regrole::text)) <> 1
     OR NOT EXISTS (
        SELECT 1 FROM pg_proc p
        CROSS JOIN LATERAL unnest(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         WHERE p.oid = c_stmt AND acl::text LIKE 'daftar_app=%') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: EXECUTE on customer_account_statement is granted to someone other than daftar_app'
      USING ERRCODE = 'P0001';
  END IF;

  -- (5) The SUMMATION IS IN THE BODY, as a cumulative window over the total
  --     order, partitioned by currency. Read from `prosrc` — the installed
  --     body — and not from this file. The positive control is the second
  --     arm: the probe finds `sum(` in the same text, so a miss on the window
  --     is a real miss and not an empty read (RULE-11/RULE-18).
  IF v_src IS NULL OR v_src NOT LIKE '%sum(%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the installed body of customer_account_statement could not be read'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_src NOT LIKE '%OVER (PARTITION BY s.currency_code%'
     OR v_src NOT LIKE '%ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_account_statement carries no cumulative window over the ordered set'
      USING ERRCODE = 'P0001';
  END IF;

  -- (6) ZERO DML. The installed body writes nothing — no INSERT, no UPDATE,
  --     no DELETE, no MERGE, no TRUNCATE. The `sum(` arm of (5) above is this
  --     claim's positive control: the same text that is searched here for a
  --     write was searched there for a read and found it, so a zero here is
  --     an absence and not an empty read.
  IF v_src ~* '\m(insert|update|delete|merge|truncate)\M' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_account_statement carries DML' USING ERRCODE = 'P0001';
  END IF;

  -- (7) THE INTERNAL MERCHANT CHECK, structural: every one of the FIVE leaf
  --     branches restricts on `business_id = p_business_id`. A branch that
  --     did not would return another merchant's rows the moment row security
  --     were ever relaxed. Five is asserted as an exact count, so a branch
  --     added later without its restriction fails here.
  IF (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, 'business_id = p_business_id', '')))
     / pg_catalog.length('business_id = p_business_id') <> 5 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_account_statement does not restrict every branch on p_business_id'
      USING ERRCODE = 'P0001';
  END IF;

  -- (8) The reader of record it must close on is still there, and still the
  --     per-currency shape this statement closes against. This file changes
  --     neither — it reads the catalogue to prove it did not.
  IF to_regprocedure('public.customer_ar_outstanding(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customer_ar_outstanding, the reader of record this statement closes on, is missing'
      USING ERRCODE = 'P0001';
  END IF;
END
$post$;
