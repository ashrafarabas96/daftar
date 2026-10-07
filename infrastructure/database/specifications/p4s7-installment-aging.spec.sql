-- ═══════════════════════════════════════════════════════════════════════════
-- P4-S7 — INSTALLMENT AGING GRANULARITY: THE DDL SPECIFICATION.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ THIS SLICE CANNOT SHIP AS IT STANDS, AND THE BLOCK IS DELIBERATE.       │
-- │                                                                          │
-- │ The projection below is TRANSACTION-CURRENCY ONLY. `customer_ar_aging`   │
-- │ returns five columns and the fourth is `base_minor` (live definition     │
-- │ `0084:701`), and this design CANNOT COMPUTE IT: see section 5. The       │
-- │ function body therefore carries the literal token                        │
-- │ `__OWED_BASE_ALLOCATION__` where that expression belongs. That token is  │
-- │ not valid SQL, so PostgreSQL REFUSES this definition at CREATE time —    │
-- │ `LANGUAGE sql` bodies are parsed when the function is created — and the  │
-- │ file cannot be transcribed into a migration by accident. Replacing the   │
-- │ token is the owner's ruling (section 5), not the author's choice.        │
-- │                                                                          │
-- │ Three live consumers read `base_minor`, and `totalBaseMinor` in          │
-- │ `CustomerAgingDto` is built from it alone, so dropping the column is not │
-- │ available either. The first round's sketch emitted four columns and      │
-- │ claimed "same signature"; `CREATE OR REPLACE FUNCTION` may not change a  │
-- │ `RETURNS TABLE` list at all — that is a 42P13 — so the claim was false.  │
-- │ All five columns are carried here and the signature really is unchanged. │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- THE SETTLEMENT ORDER IS A DECLARED POLICY, NOT A DERIVATION.
-- `payment_allocations` carries `invoice_id` and no instalment reference, so
-- nothing stored records which instalment a payment settled. The order is
-- RULED oldest-scheduled-date-first (coordinator, ruling 1) for three recorded
-- reasons: it is the ordinary AR convention a merchant expects;
-- `installments_seq_uq` already makes `(due_date, seq_no)` a total order, so it
-- is the only order the schema can reproduce deterministically without new
-- state; and it minimises reported delinquency, so if it is wrong it errs
-- toward understating what a customer owes rather than toward accusing them.
--
-- THAT THIRD REASON IS ONLY A VIRTUE WHILE THE UNDERSTATEMENT IS BOUNDED, and
-- the bound is the sum law. With `Σ instalments + down > invoice total` the
-- understatement is UNBOUNDED: the aging can report a fully overdue receivable
-- as entirely not yet due (challenger M-11, reproduced as a permanent
-- fixture). The deferred verifier in section 3 is what bounds it, and it is
-- therefore load-bearing for the policy and not hygiene.
--
-- THIS FILE IS A SPECIFICATION AND NOT A MIGRATION. It carries NO migration
-- number, it is not in `infrastructure/database/migrations/`, and it is not in
-- the migration manifest. `0000`-`0079` are byte-immutable and `0080`-`0086`
-- are S4 candidates; the single migration owner allocates this slice's number
-- at promotion and this text is what they transcribe. Nothing here is applied
-- by `npm run migrate`.
--
-- It is asserted over, not merely written: proofs 6, 7, 8 and 9 in
-- `packages/domain-core/test/phase4-s7-installment-aging.test.ts` read THIS
-- FILE and run the estate's own guard predicates
-- (`scripts/guards/no-authoritative-balance.ts`) over it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. THE PLAN: a schedule over a receivable that already exists ─────────
--
-- `P4-AL-13` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:349-355`): «An installment
-- plan is a schedule over a receivable that already exists. It is never a
-- second ledger of debt. … Collecting an instalment is an ordinary payment
-- allocated to the invoice — the same command, the same journal, the same
-- reversal path.»
--
-- So this relation carries DATES, AMOUNTS and a LIFECYCLE, and not one number
-- that any payment, reversal, credit application or refund would have to keep
-- right. There is no `outstanding_minor`, no `settled_minor`, no
-- `collected_minor`, no `paid_minor`, no `remaining_minor` and no plan-level
-- total: the plan's total is the invoice's `total_txn_minor`, read there.

CREATE TABLE installment_plans (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  invoice_id              UUID NOT NULL,
  customer_id             UUID NOT NULL,
  -- Lifecycle only, on the `invoices.status` precedent: never settlement.
  status                  TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  down_payment_minor      BIGINT NOT NULL CHECK (down_payment_minor >= 0),
  -- THE DOWN PAYMENT'S OWN SCHEDULE DATE. Required, and new in this design:
  -- the projection orders the schedule by date, so a schedule row with no date
  -- of its own would have to borrow one, and borrowing `invoices.due_date` can
  -- place the down payment AFTER instalment 1 and invert the settlement order.
  -- A civil DATE, never a timestamp (`G-13`).
  down_payment_due_date   DATE NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_transaction_id UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT installment_plans_invoice_fk FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id),
  CONSTRAINT installment_plans_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
);

-- NO `installment_count`. The first round carried
-- `installment_count INTEGER NOT NULL CHECK (BETWEEN 1 AND 60)`, which is a
-- STORED COUNT OF ROWS IN ANOTHER RELATION: nothing keeps it right, nothing
-- reads it, and the deferred verifier below asserts schedule completeness from
-- the rows themselves. It is deleted rather than blessed (challenger M-10). A
-- ceiling on the schedule length, if the owner wants one, belongs in the
-- verifier where it can be checked against the rows.

-- AT MOST ONE ACTIVE PLAN PER INVOICE. Two active plans would make the
-- projection read one invoice's authoritative outstanding twice and report it
-- twice, which is the double count proof 3 is about. The exclusion is
-- structural: a partial unique index cannot be satisfied by two active rows.
CREATE UNIQUE INDEX installment_plans_one_active_per_invoice_uq
  ON installment_plans (business_id, invoice_id) WHERE status = 'active';

-- ── 2. THE SCHEDULE ROWS: a date and an amount, and nothing derived ───────

CREATE TABLE installments (
  tenant_id        UUID NOT NULL,
  business_id      UUID NOT NULL,
  id               UUID NOT NULL,
  plan_id          UUID NOT NULL,
  seq_no           INTEGER NOT NULL CHECK (seq_no >= 1),
  -- A civil DATE, never a timestamp (`G-13`): the aging boundary is a day and
  -- a host offset may not move it.
  due_date         DATE NOT NULL,
  amount_txn_minor BIGINT NOT NULL CHECK (amount_txn_minor >= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT installments_plan_fk FOREIGN KEY (business_id, plan_id) REFERENCES installment_plans (business_id, id),
  -- `seq_no` unique within the plan, which is what makes `(due_date, seq_no)` a
  -- TOTAL order and therefore makes the allocation deterministic even when two
  -- instalments fall on one date.
  CONSTRAINT installments_seq_uq UNIQUE (business_id, plan_id, seq_no)
);

-- The one index the schedule read needs (budget `P4-H`, p95 <= 50 ms): the
-- projection's window order is exactly this index's order, descending.
CREATE INDEX installments_plan_schedule_idx ON installments (business_id, plan_id, due_date, seq_no);

ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE installments FORCE ROW LEVEL SECURITY;

-- ── 3. THE DEFERRED SCHEDULE VERIFIER — `R-SAL-06`, AND THE POLICY'S BOUND ─
--
-- `Σ instalments + down = invoice total` spans three relations, so a column
-- `CHECK` cannot express it. Two CONSTRAINT TRIGGERS, DEFERRABLE INITIALLY
-- DEFERRED, so a 24-row schedule may be inserted row by row inside one
-- transaction and is judged once at COMMIT — the shape the prep document
-- specified, and the reason an immediate verifier was refused.
--
-- IT CARRIES THREE OBLIGATIONS, AND EACH ONE CLOSES A MEASURED HOLE:
--
--   (a) `Σ amount_txn_minor + down_payment_minor = invoices.total_txn_minor`
--       for every ACTIVE plan — `R-SAL-06`, and the BOUND on ruling 1's
--       third reason. Without it the over-scheduled direction makes the
--       understatement unbounded (challenger M-11).
--   (b) AT LEAST ONE `installments` row per active plan. Without it an active
--       plan with zero rows is reachable, and the reference model and this
--       projection took OPPOSITE arms on it and gave opposite buckets
--       (challenger M-9). The model no longer consults the row count, so the
--       two agree either way; this makes the state unreachable as well, so the
--       disagreement is closed from both ends.
--   (c) `seq_no` CONTIGUOUS from 1, which crosses rows and so cannot be a
--       column `CHECK`.
--
-- The projection does NOT depend on any of the three: it totals the
-- authoritative outstanding whatever the data says (proofs 1 and 4), and
-- `scheduleCoherenceFindings` SIGNALS a violation in both directions if the
-- verifier is ever absent, deferred past a read, or bypassed.

CREATE CONSTRAINT TRIGGER installment_plans_schedule_complete
  AFTER INSERT OR UPDATE ON installment_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installment_schedule_verify();

CREATE CONSTRAINT TRIGGER installments_schedule_complete
  AFTER INSERT OR UPDATE OR DELETE ON installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installment_schedule_verify();

-- `installment_schedule_verify()` is owned by `daftar_accounting_internal` on
-- the `invoices_walkin_no_ar` precedent (`0075`), SECURITY DEFINER with a
-- pinned `search_path`, and raises `installment.schedule_incomplete` naming
-- which of (a), (b), (c) failed. Its body is transcribed at promotion; it
-- performs no allocation and reads no aging.

-- ── 4. WHAT THIS SPECIFICATION DELIBERATELY DOES NOT CREATE ──────────────
--
--   * NO accounting source type. Neither relation carries an
--     `accounting_source_type` column, neither is registered in
--     `accounting_source_bindings`, and no trigger posts a journal entry from
--     either. Collecting an instalment is an ordinary payment allocated to the
--     invoice (`P4-AL-13`), so the journal it moves is the payment's. Proof 6
--     asserts this over this file's schema, with its comments stripped.
--   * NO reducer relation, and therefore NO new `UNION ALL` branch in
--     `invoice_outstanding(UUID, UUID[])`. An invoice reducer declares
--     `invoice_amount_applied_minor`; neither relation here does, and proof 6
--     discovers the reducer set from the schema BY THAT SHAPE rather than from
--     a name list. The live definition is `0084:593` — `0084:488` DROPs
--     `0083`'s and `0084:649` carries the «appends one UNION ALL branch»
--     licence — and proof 6 finds the LAST definition in the tree rather than
--     trusting a cited file.
--   * NO stored outstanding, settled, collected, paid or remaining figure, and
--     no plan-level or instalment-level balance of any kind. Proof 7 asserts
--     this with the estate's own predicate.
--   * NO stored count of another relation's rows (see `installment_count`).
--   * NO materialised aging, no aging table, no aging column, no cache and no
--     snapshot. The aging is a function of its arguments.
--   * NO second AR ledger. The projection's only money input from outside the
--     schedule is `invoice_outstanding`'s authoritative figure.

-- ── 5. THE `base_minor` COLUMN: WHY IT IS A BLOCKING OWED ────────────────
--
-- The transaction-currency allocation is EXACT and performs zero roundings.
-- The base column cannot be split exactly from the inputs this design is
-- permitted, and the reason is MEASURED in the live body rather than assumed:
-- `0084:614` computes `pg_catalog.sum(d.rel) AS paid_base` where `d.rel` is
-- `invoice_carrying_base_released_minor` — THE CARRYING RELEASED, and never a
-- conversion of the paid transaction amount. So
-- `outstanding_base_minor / outstanding_txn_minor` is NOT the invoice's
-- `source_to_base_rate` under realized FX, and any per-row base figure needs
-- either that rate (an input outside the permitted set) or that quotient (a
-- rounded quotient fed back as an authoritative input, forbidden by name).
--
-- RULED (coordinator, ruling 2): no base allocation is written here. The
-- recommended widening — permit `invoices.source_to_base_rate` and define the
-- base schedule as DIFFERENCES OF THE ROUNDED CUMULATIVE CONVERSION
-- `C_i = round(s_i * rate)`, so the row amounts telescope and exactly ONE
-- rounding is performed, at one grain, with `outstanding_base_minor` left as
-- the authoritative input and never recomputed — is with the OWNER, because
-- widening the permitted input set is his. Until he rules, the body below
-- carries `__OWED_BASE_ALLOCATION__` and will not create.

-- ── 6. THE PROJECTION ────────────────────────────────────────────────────
--
-- `CREATE OR REPLACE`, so the owner, STABLE standing, SECURITY INVOKER
-- standing, pinned `search_path` and whole ACL are KEPT rather than restored,
-- and all five result columns are unchanged — which is what makes
-- `CREATE OR REPLACE` legal here at all.
--
-- `p_as_of` STAYS A PARAMETER AND THE BODY READS NO CLOCK: no `CURRENT_DATE`,
-- `now()`, `LOCALTIMESTAMP`, `transaction_timestamp()`, `statement_timestamp()`
-- or `clock_timestamp()`. The routine is NOT declared `IMMUTABLE` and this
-- design does not ask for it to be: PostgreSQL trusts the volatility label and
-- never reads the body, so `IMMUTABLE` is not a clock guard. The protections
-- are the explicit parameter, the body-reading guard of patch request PR-3,
-- and proof 8's red proof over THIS text.
--
-- Catalogue functions are `pg_catalog.`-qualified throughout, as every shipped
-- AR routine qualifies them (challenger L-16), and the call's own
-- `currency_code` and `due_date` are read straight off it — `0084:593-596`
-- appended those columns precisely «so the AR readers stop joining invoices
-- back onto this call», and the first round's sketch joined `invoices` back on
-- and undid a measured optimisation on the `P4-D` path (challenger M-12).
--
-- The algorithm is the one in
-- `packages/domain-core/test/phase4-s7-aging-reference-model.ts`
-- (`projectInvoice`), and that file's header states why the TypeScript is a
-- reference model and not a second implementation (`P4-AL-07`).

-- >>> P4S7 PROJECTION SKETCH BEGIN
CREATE OR REPLACE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])
RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  WITH open_invoice AS (
    SELECT o.invoice_id, o.currency_code, o.due_date, o.outstanding_txn_minor
      FROM public.invoice_outstanding(
             p_business_id,
             (SELECT pg_catalog.array_agg(x.id)
                FROM public.invoices x
               WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o
     WHERE o.outstanding_txn_minor <> 0
  ),
  active_plan AS (
    SELECT p.id, p.invoice_id, p.down_payment_minor, p.down_payment_due_date
      FROM public.installment_plans p
     WHERE p.business_id = p_business_id AND p.status = 'active'
       AND p.invoice_id IN (SELECT oi.invoice_id FROM open_invoice oi)
  ),
  sched AS (
    SELECT ap.invoice_id, 0 AS seq_no, ap.down_payment_due_date AS due_date, ap.down_payment_minor AS amount
      FROM active_plan ap
     UNION ALL
    SELECT ap.invoice_id, n.seq_no, n.due_date, n.amount_txn_minor
      FROM active_plan ap
      JOIN public.installments n ON n.business_id = p_business_id AND n.plan_id = ap.id
  ),
  suffixed AS (
    -- `suffix_after` = the amounts scheduled STRICTLY LATER than this row.
    -- DESC because the DECLARED POLICY is oldest-scheduled-first, so the
    -- outstanding occupies the LATEST rows. The other convention is this
    -- ORDER BY ascending, and nothing else changes.
    SELECT s.invoice_id, s.seq_no, s.due_date, s.amount,
           pg_catalog.coalesce(pg_catalog.sum(s.amount) OVER (
             PARTITION BY s.invoice_id ORDER BY s.due_date DESC, s.seq_no DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS suffix_after,
           pg_catalog.sum(s.amount) OVER (PARTITION BY s.invoice_id) AS schedule_total
      FROM sched s
  ),
  contribution AS (
    -- (a) the schedule rows: the closed-form clamp.
    SELECT x.invoice_id, oi.currency_code, x.due_date AS bucket_date,
           least(greatest(oi.outstanding_txn_minor - x.suffix_after, 0), x.amount)::BIGINT AS txn_minor
      FROM suffixed x
      JOIN open_invoice oi ON oi.invoice_id = x.invoice_id
     UNION ALL
    -- (b) the residual, by its OWN closed form, bucketed at the invoice's due
    --     date. NEVER `outstanding - sum(alloc)`: that would make the sum law
    --     a comparison of an expression with itself.
    SELECT oi.invoice_id, oi.currency_code, oi.due_date,
           (oi.outstanding_txn_minor
              - least(greatest(oi.outstanding_txn_minor, 0), t.schedule_total))::BIGINT
      FROM open_invoice oi
      JOIN (SELECT y.invoice_id, pg_catalog.max(y.schedule_total) AS schedule_total
              FROM suffixed y GROUP BY y.invoice_id) t ON t.invoice_id = oi.invoice_id
     UNION ALL
    -- (c) the invoices with NO active plan: the whole figure, as today. The
    --     three arms PARTITION the open invoices — (a) and (b) read only
    --     invoices in `active_plan`, (c) only those not in it — and an active
    --     plan with no `installments` rows is served by (a) and (b), which the
    --     reference model now agrees with and section 3(b) makes unreachable.
    SELECT oi.invoice_id, oi.currency_code, oi.due_date, oi.outstanding_txn_minor
      FROM open_invoice oi
     WHERE NOT EXISTS (SELECT 1 FROM active_plan ap WHERE ap.invoice_id = oi.invoice_id)
  )
  SELECT (1 + (SELECT pg_catalog.count(*)
                 FROM pg_catalog.unnest(p_bucket_days) AS t(threshold)
                WHERE c.bucket_date IS NOT NULL AND (p_as_of - c.bucket_date) > t.threshold))::INTEGER AS bucket_no,
         c.currency_code,
         pg_catalog.sum(c.txn_minor)::BIGINT AS txn_minor,
         __OWED_BASE_ALLOCATION__ AS base_minor,
         pg_catalog.count(DISTINCT c.invoice_id)::INTEGER AS invoice_count
    FROM contribution c
   WHERE c.txn_minor <> 0
   GROUP BY 1, c.currency_code;
$fn$;
-- <<< P4S7 PROJECTION SKETCH END

REVOKE ALL ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) IS
  'P4-S1, replaced by P4-S4 (0083, 0084) and by P4-S7 (P4-AL-05, P4-AL-13): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. Since P4-S7 an invoice under an ACTIVE installment plan is aged ACROSS ITS SCHEDULE instead of at its single invoice due date: the authoritative outstanding is allocated by a closed-form clamp over the schedule ordered oldest-scheduled-date-first, which telescopes so the buckets total that outstanding exactly, in integers, with no rounding and no residue to distribute. The settlement order is a DECLARED POLICY and not a derivation, because no allocation references an instalment. There is no materialised aging table (P4-AL-06), no stored installment balance, no installment journal and no new reducer: an instalment collection is an ordinary payment allocated to the invoice. The routine does not read the clock (P4-AL-30) and is not IMMUTABLE, because the label is not a guard. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

-- `count(DISTINCT c.invoice_id)` and not `count(*)`: an invoice now makes
-- several contributions, so `count(*)` would report a number of instalments
-- under a column named `invoice_count`. Note for the consumer review: an
-- invoice may now appear in SEVERAL buckets, so the sum of `invoice_count`
-- over the buckets exceeds the number of open invoices, which it never did
-- before. That is section 11 item 2 of the design document.
