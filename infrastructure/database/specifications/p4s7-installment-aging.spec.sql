-- ═══════════════════════════════════════════════════════════════════════════
-- P4-S7 — INSTALLMENT AGING GRANULARITY: THE DDL SPECIFICATION.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ THE `base_minor` OWED IS CLOSED, AND BY A RULING, NOT BY AN INVENTION.  │
-- │                                                                          │
-- │ Round 2 shipped this file with the literal token                        │
-- │ `__OWED_BASE_ALLOCATION__` in the function body, deliberately chosen     │
-- │ because it is not valid SQL: `LANGUAGE sql` bodies are parsed at CREATE  │
-- │ time, so PostgreSQL REFUSED the definition and the file could not be     │
-- │ transcribed into a migration by accident. The token held the hole open   │
-- │ for a ruling instead of guessing.                                        │
-- │                                                                          │
-- │ THE RULING CAME (TL Ashraf, §21/§25). `invoices.source_to_base_rate` is  │
-- │ NOT the authoritative carrying-allocation primitive and must not become  │
-- │ a second arithmetic authority. The base portion of a schedule boundary   │
-- │ comes from THE CANONICAL CUMULATIVE CARRYING-VALUE LAW over the stored   │
-- │ authoritative pair `(total_txn_minor, total_base_minor)`, differenced    │
-- │ between the schedule's cumulative levels. That law is already shipped,   │
-- │ ONCE, as `supplier_ap_release(B, T, X, a)` (`0067:683`, R-61, R-81), so  │
-- │ the body below CALLS IT and does not re-implement it: a third copy of    │
-- │ the arithmetic would be a third truth.                                   │
-- │                                                                          │
-- │ §21 asked for a counterexample if the raw rate were mathematically       │
-- │ REQUIRED. THERE IS NONE, and section 5 gives the argument rather than    │
-- │ the assertion. The token is gone; the body is now valid SQL and the      │
-- │ block it enforced is lifted.                                             │
-- │                                                                          │
-- │ ALL FIVE COLUMNS ARE CARRIED, and the signature really is unchanged.     │
-- │ Three live consumers read `base_minor` and `totalBaseMinor` in           │
-- │ `CustomerAgingDto` is built from it alone, so dropping the column was    │
-- │ never available. The first round's sketch emitted four and claimed "same │
-- │ signature"; `CREATE OR REPLACE FUNCTION` may not change a `RETURNS       │
-- │ TABLE` list at all — that is a 42P13 — so the claim was false. §25       │
-- │ requires the shape be KEPT, and it is.                                   │
-- │                                                                          │
-- │ WHAT STILL BLOCKS THIS FILE: it has no migration number, it is not in    │
-- │ `migrations/`, it is not in the manifest, and S7 is CHALLENGER REJECTED  │
-- │ with `READY_TO_PROMOTE = NO`. It also needs one authority change that is │
-- │ NOT the author's to make — patch request PR-6, the `GRANT EXECUTE` on    │
-- │ `supplier_ap_release` — stated in section 5.                             │
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
-- projection's window order is exactly this index's order, ASCENDING — the
-- levels are PREFIX sums anchored at the paid figure (section 6), so the read
-- walks the index forward and needs no sort.
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
--       for every ACTIVE plan — `R-SAL-06`. OWED TO THE BOX, and owed in ALL
--       THREE DIRECTIONS at DB level (owner §26), not in TypeScript and not
--       in the UI:
--         * a schedule summing below total REFUSED at COMMIT;
--         * a schedule summing equal to total ACCEPTED;
--         * a schedule summing above total REFUSED at COMMIT.
--       Both refusals are reachable by a DELETE as well as by an INSERT,
--       which is why BOTH triggers fire on DELETE too and proof 9 asserts
--       that over the DDL rather than over this sentence.
--       The projection no longer DEPENDS on this for a sane answer — see the
--       paid-anchored levels in section 6 — so the verifier bounds the DATA
--       rather than propping up the arithmetic.
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
-- authoritative outstanding whatever the data says (proofs 1 and 4).
--
-- PR-5, RESOLVED BY DELETION. Round 2 also carried a pure TypeScript
-- `scheduleCoherenceFindings` that signalled the same violation and that
-- NOTHING READ. The coordinator refused to leave it: «either wire it into a
-- read path or a gate, or delete it and say the verifier is the whole bound.
-- Do not leave it as a third state.» It is DELETED. THIS VERIFIER IS THE
-- WHOLE BOUND, and a bound with one home cannot be believed in the wrong one.

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

-- ── 5. THE `base_minor` COLUMN: THE RULING, AND WHY NO RATE IS NEEDED ────
--
-- The transaction-currency allocation is EXACT and performs ZERO roundings.
-- The base side performs EXACTLY ONE, and it is not this file's rounding: it
-- is consumed from the canonical law.
--
-- WHAT WAS MEASURED, AND IS STILL TRUE. `0084:614` computes
-- `pg_catalog.sum(d.rel) AS paid_base` where `d.rel` is
-- `invoice_carrying_base_released_minor` — THE CARRYING RELEASED, never a
-- conversion of the paid transaction amount. So the quotient
-- `outstanding_base_minor / outstanding_txn_minor` is NOT the invoice's
-- `source_to_base_rate`, and round 2 was right to refuse to improvise from it.
-- A rounded quotient fed back as an authoritative input is forbidden by name.
--
-- THE RULING (TL Ashraf, §21). Do NOT add `source_to_base_rate` as a new
-- authoritative financial input to S7 aging or schedule arithmetic. The
-- invoice already carries an immutable authoritative monetary PAIR,
-- `total_txn_minor` and `total_base_minor`, and settlement already carries the
-- exact `invoice_carrying_base_released_minor`. Those are the carrying-value
-- truth. The rate remains valid immutable invoice metadata for display, audit
-- explanation, traceability and source-rate evidence, and is NOT the
-- carrying-allocation primitive.
--
-- WHAT THE BODY DOES INSTEAD. For a cumulative settlement level `X` and an
-- allocation `a` above it:
--
--     base(X, a) = supplier_ap_release(B, T, X, a)
--                = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)          (R-61)
--
-- with `T = paid_txn_minor + outstanding_txn_minor` and
-- `B = paid_base_minor + outstanding_base_minor`, BOTH read off the one
-- authoritative call. The schedule's consecutive levels `L_0 … L_n` and the
-- residual's `L_n … T` partition `[paid, T]`, so the base portions are
-- consecutive differences of ONE cumulative function and
--
--     Σ base portions = HALF_EVEN(B·T, T) − HALF_EVEN(B·paid, T)
--                     = B − paid_base_minor = outstanding_base_minor
--
-- EXACTLY, because `HALF_EVEN(B·T, T) = B` with no residue. The §29
-- conservation law is therefore a CONSEQUENCE of telescoping and not a
-- coincidence anything has to police, which is how the owner asked for it to
-- be proved. Proof 10 proves it that way; proof 10's mutant replaces the
-- cumulative difference with a per-row conversion and the equality breaks.
--
-- §21 ASKED FOR A COUNTEREXAMPLE IF THE RAW RATE WERE MATHEMATICALLY
-- REQUIRED. THERE IS NONE, and the argument is this rather than an assertion:
-- the only quantity the allocation ever needs from the FX side is the RATIO
-- `B/T` of two stored authoritative integers, applied ONCE per cumulative
-- level inside ONE `HALF_EVEN`. No per-installment conversion is performed,
-- so no per-installment rate is referenced; and because the law is applied to
-- cumulative levels and then differenced, the endpoint identity `R(T) = B`
-- holds exactly, which no independent per-row conversion by a rate can
-- guarantee. A read creates no realized FX. If a later slice believes a
-- counterexample exists, it goes to the owner as an architecture issue before
-- any contract changes; it does not get a second truth quietly.
--
-- R-81 — THE ARITHMETIC IS REUSED, NEVER RE-IMPLEMENTED. The law is shipped
-- ONCE, at `0067:683`, with a TypeScript twin at
-- `packages/inventory/src/supplier-settlement.ts:89` (`apRelease`) that the
-- reference model IMPORTS rather than copies. This body CALLS
-- `public.supplier_ap_release` and holds no HALF_EVEN of its own. Proof 10
-- asserts that over this file's SQL, with comments stripped, because the
-- estate's recorded failure is a law whose subject is a textual coincidence.
--
-- PATCH REQUEST PR-6, AND IT IS NOT THE AUTHOR'S TO MAKE. `0067:1250` is
-- `REVOKE ALL ON FUNCTION supplier_ap_release(BIGINT,BIGINT,BIGINT,BIGINT)
-- FROM PUBLIC` and `0067:1311` sets `OWNER TO daftar_inventory_internal`, and
-- NO `GRANT EXECUTE` to `daftar_app` exists anywhere in the tree — every
-- shipped call site is inside a DEFINER routine owned by an internal role.
-- `customer_ar_aging` is SECURITY INVOKER by standing (`R-P4-07`), so as it
-- stands this body raises `42501 permission denied for function
-- supplier_ap_release` when `daftar_app` calls it. THE FIX IS ONE LINE AND
-- BELONGS TO THE MIGRATION OWNER:
--
--     GRANT EXECUTE ON FUNCTION supplier_ap_release(BIGINT, BIGINT, BIGINT, BIGINT) TO daftar_app;
--
-- It grants no new data authority: the function is pure arithmetic over four
-- BIGINTs, reads no relation, and is already hash-pinned in the registry
-- (`0067:1818`). Making `customer_ar_aging` DEFINER instead would be the wrong
-- repair — it would bypass the caller's row security on `invoices` to buy a
-- multiplication. This is OWED and the file does not pretend otherwise.
--
-- THE LAW'S OWN PRECONDITION, stated rather than discovered: it refuses
-- `p_total_base <= 0`. Every invoice that can be settled at all already
-- satisfies it, because `0081:1035` calls the same function with the same
-- `total_base_minor` on EVERY customer payment allocation, so an invoice with
-- a non-positive base total cannot be paid today. The precondition is
-- estate-wide and not new here.

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
    -- THE ONE AUTHORITATIVE MONEY INPUT, and one call for the whole customer.
    -- `T` and `B` are the stored authoritative PAIR recomposed from the figures
    -- this call already returns, which is why no `JOIN public.invoices` is
    -- needed for them and why `0084:593-596`'s appended `currency_code` and
    -- `due_date` are read straight off it.
    SELECT o.invoice_id, o.currency_code, o.due_date,
           o.paid_txn_minor, o.outstanding_txn_minor, o.outstanding_base_minor,
           (o.paid_txn_minor + o.outstanding_txn_minor)::BIGINT   AS total_txn_minor,
           (o.paid_base_minor + o.outstanding_base_minor)::BIGINT AS total_base_minor
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
    -- The down payment is schedule row 0, dated by its OWN column. It is not
    -- an instalment and it is not the invoice due date.
    SELECT ap.invoice_id, 0 AS seq_no, ap.down_payment_due_date AS due_date, ap.down_payment_minor AS amount
      FROM active_plan ap
     UNION ALL
    SELECT ap.invoice_id, n.seq_no, n.due_date, n.amount_txn_minor
      FROM active_plan ap
      JOIN public.installments n ON n.business_id = p_business_id AND n.plan_id = ap.id
  ),
  prefixed AS (
    -- PREFIX sums of the schedule in SETTLEMENT ORDER. `(due_date, seq_no)` is
    -- a total order because `installments_seq_uq` makes `seq_no` unique in the
    -- plan, so two instalments on one date still have one answer.
    --
    -- ASCENDING, because the DECLARED POLICY is oldest-scheduled-first and the
    -- levels below are anchored at the PAID figure: money already collected
    -- settles the EARLIEST rows and the outstanding occupies the latest. The
    -- other convention is this ORDER BY descending, in both windows, and
    -- nothing else in this body changes — which proof 3's convention law
    -- asserts rather than states.
    SELECT s.invoice_id, s.seq_no, s.due_date,
           coalesce(pg_catalog.sum(s.amount) OVER w_before, 0)::BIGINT AS c_before,
           (pg_catalog.sum(s.amount) OVER w_at)::BIGINT                           AS c_at,
           (pg_catalog.sum(s.amount) OVER (PARTITION BY s.invoice_id))::BIGINT     AS schedule_total
      FROM sched s
    WINDOW w_before AS (PARTITION BY s.invoice_id ORDER BY s.due_date, s.seq_no
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
           w_at     AS (PARTITION BY s.invoice_id ORDER BY s.due_date, s.seq_no
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  ),
  levelled AS (
    -- THE SETTLEMENT LEVEL the schedule has reached at this row:
    --
    --     L(c) = least(greatest(c, paid), T)
    --
    -- The `greatest` anchors at the authoritative PAID figure, so no scheduled
    -- amount the customer has already covered is allocated again; the `least`
    -- refuses to allocate more than the invoice is worth, which is what makes
    -- an OVER-SCHEDULED plan harmless instead of an overstatement.
    SELECT x.invoice_id, x.seq_no, x.due_date, x.schedule_total,
           least(greatest(x.c_before, oi.paid_txn_minor), oi.total_txn_minor)::BIGINT AS lvl_before,
           least(greatest(x.c_at,     oi.paid_txn_minor), oi.total_txn_minor)::BIGINT AS lvl_at,
           oi.currency_code, oi.total_txn_minor, oi.total_base_minor
      FROM prefixed x
      JOIN open_invoice oi ON oi.invoice_id = x.invoice_id
  ),
  residual AS (
    -- The residual's OWN closed form, anchored on the DECLARED schedule sum.
    -- NEVER `outstanding − Σ allocations`: that would make the sum law a
    -- comparison of an expression with itself, and round 3 caught exactly
    -- that in its own first draft, where the residual was anchored on the
    -- REALIZED last level and proof 1 held identically whatever the
    -- allocation did. `declared_end` equals `L(schedule_total)`, so the
    -- schedule's levels and this one partition `[paid, T]` with no gap and no
    -- overlap — proofs 3 and 4.
    SELECT oi.invoice_id, oi.currency_code, oi.due_date,
           oi.total_txn_minor, oi.total_base_minor,
           least(greatest(t.schedule_total, oi.paid_txn_minor), oi.total_txn_minor)::BIGINT AS declared_end
      FROM open_invoice oi
      JOIN (SELECT y.invoice_id, pg_catalog.max(y.schedule_total) AS schedule_total
              FROM prefixed y GROUP BY y.invoice_id) t ON t.invoice_id = oi.invoice_id
  ),
  contribution AS (
    -- (a) THE SCHEDULE ROWS. The transaction allocation is a difference of two
    --     consecutive levels — exact integers, zero roundings — and the base
    --     portion is the CANONICAL CUMULATIVE CARRYING-VALUE LAW across the
    --     same two levels (R-61, R-81, owner §21). One rounding, consumed from
    --     `supplier_ap_release` and not re-implemented here. Both telescope,
    --     which is the whole of proofs 1 and 10.
    SELECT v.invoice_id, v.currency_code, v.due_date AS bucket_date,
           (v.lvl_at - v.lvl_before)::BIGINT AS txn_minor,
           public.supplier_ap_release(v.total_base_minor, v.total_txn_minor,
                                      v.lvl_before, v.lvl_at - v.lvl_before) AS base_minor
      FROM levelled v
     UNION ALL
    -- (b) THE RESIDUAL, bucketed at the invoice's own due date: an amount the
    --     schedule does not declare has no scheduled date to be aged at, and
    --     inventing one would be the design choosing a date.
    SELECT r.invoice_id, r.currency_code, r.due_date,
           (r.total_txn_minor - r.declared_end)::BIGINT,
           public.supplier_ap_release(r.total_base_minor, r.total_txn_minor,
                                      r.declared_end, r.total_txn_minor - r.declared_end)
      FROM residual r
     UNION ALL
    -- (c) THE INVOICES WITH NO ACTIVE PLAN: the whole figure at the invoice due
    --     date, exactly as today, and the base is the AUTHORITATIVE
    --     `outstanding_base_minor` rather than a recomputation of it. The three
    --     arms PARTITION the open invoices — (a) and (b) read only invoices in
    --     `active_plan`, (c) only those not in it — and an active plan with no
    --     `installments` rows is served by (a) and (b), which the reference
    --     model agrees with and section 3(b) makes unreachable.
    SELECT oi.invoice_id, oi.currency_code, oi.due_date,
           oi.outstanding_txn_minor, oi.outstanding_base_minor
      FROM open_invoice oi
     WHERE NOT EXISTS (SELECT 1 FROM active_plan ap WHERE ap.invoice_id = oi.invoice_id)
  )
  SELECT (1 + (SELECT pg_catalog.count(*)
                 FROM pg_catalog.unnest(p_bucket_days) AS t(threshold)
                WHERE c.bucket_date IS NOT NULL AND (p_as_of - c.bucket_date) > t.threshold))::INTEGER AS bucket_no,
         c.currency_code,
         pg_catalog.sum(c.txn_minor)::BIGINT  AS txn_minor,
         pg_catalog.sum(c.base_minor)::BIGINT AS base_minor,
         pg_catalog.count(DISTINCT c.invoice_id)::INTEGER AS invoice_count
    FROM contribution c
   WHERE c.txn_minor <> 0
   GROUP BY 1, c.currency_code;
$fn$;
-- <<< P4S7 PROJECTION SKETCH END

REVOKE ALL ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) IS
  'P4-S1, replaced by P4-S4 (0083, 0084) and by P4-S7 (P4-AL-05, P4-AL-13): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. Since P4-S7 an invoice under an ACTIVE installment plan is aged ACROSS ITS SCHEDULE instead of at its single invoice due date. The schedule is ordered oldest-scheduled-date-first — a DECLARED POLICY and not a derivation, because nothing stored records which instalment a payment settled — and its PREFIX sums are turned into cumulative settlement levels anchored at the authoritative paid figure and clamped at the invoice total: L(c) = least(greatest(c, paid), total). Each row''s transaction share is the difference of two consecutive levels, so the shares are exact integers, no rounding is performed on the transaction side, there is no residue to distribute, and the shares total the authoritative outstanding by telescoping rather than by reconciliation. Each row''s base carrying share is the SAME difference taken through supplier_ap_release(total_base, total_txn, level, share), the canonical cumulative carrying-value law (R-61, R-81, 0067:683) consumed and never re-implemented, so the base shares likewise total outstanding_base_minor EXACTLY and no per-instalment FX conversion and no source_to_base_rate is read: a read creates no realized FX (TL S7 §21). An amount the schedule does not declare is a residual aged at the invoice''s own due date, by its own closed form and never as outstanding minus the allocations. An invoice may now appear in SEVERAL buckets, so invoice_count is count(DISTINCT invoice_id) and the sum of invoice_count over the buckets may exceed the number of open invoices. There is no materialised aging table (P4-AL-06), no stored installment balance, no installment journal and no new reducer: an instalment collection is an ordinary payment allocated to the invoice. The routine does not read the clock (P4-AL-30) and is not IMMUTABLE, because the label is not a guard. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal; this body also requires EXECUTE on supplier_ap_release, which patch request PR-6 owes.';

-- `count(DISTINCT c.invoice_id)` and not `count(*)`: an invoice now makes
-- several contributions, so `count(*)` would report a number of instalments
-- under a column named `invoice_count`. Note for the consumer review: an
-- invoice may now appear in SEVERAL buckets, so the sum of `invoice_count`
-- over the buckets exceeds the number of open invoices, which it never did
-- before. That is section 11 item 2 of the design document.
