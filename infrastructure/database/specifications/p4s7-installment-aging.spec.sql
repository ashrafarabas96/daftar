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
-- │ WHAT STILL BLOCKS THIS FILE, AND S7-1 IS THE BIGGEST OF IT:             │
-- │                                                                          │
-- │  * EVERY STATEMENT BELOW IS `SPEC ONLY`. This file has never been        │
-- │    applied to a cluster, never parsed by PostgreSQL and never executed.  │
-- │    The suite that judges it reads it with `readFileSync` and analyses it │
-- │    as TEXT. So the two constraint triggers have never fired,             │
-- │    `installment_schedule_verify()` has never been compiled by the        │
-- │    parser, and «at the DATABASE level, not in TypeScript only» is NOT    │
-- │    MET. The 265-day golden is proved against the reference model, not    │
-- │    against this routine. A SPECIFICATION IS DESIGN UNTIL A PARSER HAS    │
-- │    HAD AN OPINION (challenger S7-1, CRITICAL). The author has been       │
-- │    careful about the one trap this estate records — `pg_catalog.coalesce`│
-- │    is impossible, because `COALESCE` is syntax and cannot be             │
-- │    schema-qualified — and care is not a substitute for the parser.       │
-- │  * no migration number, not in `migrations/`, not in the manifest, and   │
-- │    S7 is CHALLENGER REJECTED with `READY_TO_PROMOTE = NO`.               │
-- │  * TWO authority/command changes that are NOT the author's to make:      │
-- │    PR-6, the `GRANT EXECUTE` on `supplier_ap_release` (section 5), and   │
-- │    PR-8, the plan-creation status precondition (section 3(f)).           │
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
-- ceiling on the schedule length belongs in the verifier where it can be
-- checked against the rows, and section 3(e) now DECLARES it there, at 60.
-- Until round 4 it was undeclared, which is how a convention becomes a
-- belief.

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

-- ── 2a. THE POLICIES AND THE PRIVILEGES ──────────────────────────────────
--
-- FOUND BY THE EXECUTOR, NOT BY A READER (S7-1, second finding). The two
-- relations above were created with RLS ENABLED and FORCED and with NO policy
-- and NO grant to anybody. The first `INSERT INTO installment_plans` attempted
-- through a real transaction did not reach the verifier at all: it failed with
--
--     42501  permission denied for table installment_plans
--
-- raised INSIDE `installment_schedule_verify()`, because that routine is a
-- SECURITY DEFINER owned by `daftar_accounting_internal` and that role held no
-- SELECT on the relations it was written to judge. A schedule verifier that
-- cannot read the schedule does not refuse incomplete schedules — IT REFUSES
-- EVERY SCHEDULE, which is a law that discriminates nothing while looking
-- strict. The sibling hazard is recorded in the estate's own words at
-- `0075:439-441`: granting too little «would make the deferred completeness
-- validator read zero rows and pass vacuously: a green gate over an unchecked
-- invariant». This is the same mistake in its louder direction.
--
-- No privilege here is a widening: `installment_plans` and `installments` are
-- created by THIS specification, so their policies and grants are its own to
-- declare.
--
-- THE POLICY-NAME SET IS `c_source`, SEVEN NAMES PER RELATION — and the first
-- version of this block shipped SIX, which was `c_source` minus
-- `inventory_internal_read` and therefore a set matching NEITHER of the two
-- shapes `0075` declares for itself (challenger C1.b). `0075` does not merely
-- contain policies; its own end-state block asserts the NAME SET from the live
-- catalogue — `c_ordinary` six names, `c_source` seven, compared at
-- `0075:912`. The omitted name is at `0075:455-456`, INSIDE the range this
-- comment cites and immediately above the `accounting_validator` at `:457-458`
-- that the first version did copy. Section 20 of the design records what that
-- omission cost; section 2b's `DO $end$` block is what makes it unrepeatable.
--
-- TWO CITATION HONESTIES, because the first version claimed more than it did
-- (challenger L11):
--   * `0075:443-458` is `0075`'s HEADER-relation block (`invoices`). `0075`
--     gives a DETAIL relation (`invoice_items`, `0075:459+`) a NARROWER
--     restrictive read — `current_user = 'daftar_inventory_internal'` alone —
--     and NO `accounting_validator`. Giving `installments` the header shape is
--     therefore a deliberate WIDENING relative to the cited range, and the
--     reason is specific: unlike `invoice_items`, `installments` is read
--     DIRECTLY by `installment_schedule_verify()` as
--     `daftar_accounting_internal`, so the validator policy is load-bearing on
--     the detail relation here and is not on `invoice_items`.
--   * So this is not «relation for relation»; it is the header shape, applied
--     to both relations, for a stated reason.
CREATE POLICY tenant_membership ON installment_plans
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON installment_plans AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON installment_plans AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON installment_plans AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
-- `0075:455-456`'s EXACT SHAPE. Without it, the only permissive policy
-- reaching `daftar_inventory_internal` is `tenant_membership`, which needs
-- `app_bypass()` or a matching `app.tenant_id`; `app_tenant()` is
-- `current_setting('app.tenant_id', true)` (`0006_rls.sql:5-7`), NULL when
-- unset, so the comparison is NULL and not true. That principal holds an
-- unconditional read on `invoices` (`0075:455-456`) and would have held NO
-- read here — the exact visibility ASYMMETRY section 6a refuses.
CREATE POLICY inventory_internal_read ON installment_plans
  FOR SELECT TO daftar_inventory_internal USING (true);
-- The verifier's own way in, named for what it is, on the `accounting_validator`
-- precedent of `0075:457-458`.
CREATE POLICY accounting_validator ON installment_plans
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON installments
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON installments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON installments AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON installments AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON installments
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON installments
  FOR SELECT TO daftar_accounting_internal USING (true);

-- READ ONLY, to every principal. P4-AL-38: `daftar_app` holds no DML on any
-- Phase 4 relation, and this specification ships no writer — the command that
-- creates a plan is a later slice's, and until it exists nothing but a
-- migration-level principal can write these rows at all.
GRANT SELECT ON installment_plans, installments TO daftar_app;
GRANT SELECT ON installment_plans, installments TO daftar_inventory_internal;
GRANT SELECT ON installment_plans, installments TO daftar_accounting_internal;

-- ── 2c. THE INVOICE-BORNE FACT — `TL-P4-COORD-R38`, DIRECTION (d) ────────
--
-- THIS SECTION EXISTS BECAUSE THE SAME DEFECT WAS SHIPPED THREE TIMES, AND
-- THE THIRD TIME IT WAS INSIDE THE THING WRITTEN TO PREVENT IT.
--
-- The no-plan arm of `customer_ar_aging` used to be keyed on
-- `NOT EXISTS (SELECT 1 FROM installment_plans …)` read through the CALLER's
-- row security, and under row security ABSENT and INVISIBLE ARE ONE ANSWER.
-- Three rounds of repair all tried to answer «can I see the plans?» from
-- inside the reader:
--
--   1. `NOT EXISTS` alone — absent and invisible are one answer.
--   2. A `SECURITY DEFINER` count of hidden plans — the definer reads as its
--      OWNER through ONE policy, so `v_hidden = 0` meant both «no hidden
--      plan» and «I can see no plans»; dropping `accounting_validator` alone
--      made it answer `true`.
--   3. A catalogue-property assertion over `pg_policy` — and the properties
--      it checked were not the properties that decide whether a role can see
--      a row. It compared `polpermissive`, `polcmd` and six `strpos` tests,
--      never `polroles`; `strpos(x, t) > 0` is satisfied by any expression
--      that merely CONTAINS `t`, so `tenant_membership` re-created with every
--      token the check looks for plus one extra conjunct `AND created_at >
--      now()` passed the guard, excluded every row, and left `NOT EXISTS`
--      true. Measured, in three independent constructions, by the round-7
--      challenger.
--
-- `TL-P4-COORD-R38` retires that whole family with a generalisation that is
-- now a standing rule of this project: **A READER CANNOT CERTIFY ITS OWN
-- VISIBILITY.** Every form of the question is answered by the same blinded
-- principal that is asking it, and each repair moves the blindness one level
-- further from the answer. No fourth construction of it is permitted, and in
-- particular adding `polroles` to the catalogue check would close the three
-- measured attacks and not close the family, because the third attack's extra
-- conjunct is a VALUE INSIDE AN EXPRESSION and no finite set of substring
-- tests bounds an expression.
--
-- SO THERE IS NOTHING LEFT TO ASSERT. The evidence for this direction is the
-- challenger's own MEASURED NEGATIVE: with the session context unset, the
-- caller is blind to `installment_plans` AND blind to `public.invoices` BY
-- THE SAME POLICIES, so `open_invoice` is empty and the no-plan arm has
-- nothing to serve. That is the symmetry argument WORKING, and it is why all
-- three attacks had to break the symmetry between two relations rather than
-- break the context. The repair therefore carries the fact ON THE ROW WHOSE
-- VISIBILITY ALREADY GOVERNS THE ANSWER:
--
--     THE EXISTENCE OF AN ACTIVE INSTALLMENT PLAN IS A COLUMN ON THE INVOICE.
--
-- An invisible plan cannot then exist for a visible invoice, because the fact
-- about the plan is read through the very policy evaluation that let the
-- caller see the invoice — the same row, the same `pg_policy` entries, the
-- same `tenant_id` and `business_id` comparisons. There is no second relation
-- to desynchronise, so NO SINGLE-RELATION DDL CHANGE CAN DESYNCHRONISE
-- ANYTHING, and no guard over the policy catalogue is needed or shipped.
--
-- WHAT A DENORMALISED FACT COSTS, AND WHAT MAKES IT RIGHT. A stored fact that
-- can be wrong is worse than no fact at all — `P4-AL-06` is the whole reason
-- this slice stores no balance, no outstanding and no paid figure, and
-- challenger M-10 deleted an `installment_count` for being a stored count of
-- another relation's rows. THIS COLUMN IS NOT OF THAT KIND, AND THE
-- DIFFERENCE IS STATED RATHER THAN ASSUMED:
--
--   * it is not MONEY and not a derivation of money — it is one bit of
--     LIFECYCLE, exactly the predicate `status = 'active'` that the
--     projection's own `active_plan` CTE already applies;
--   * it is maintained by THIS SLICE's triggers on the relation that owns the
--     truth (section 3a), never by an application, never by a command layer
--     and never by hand ([[daftar-wrapper-is-not-an-invariant]]);
--   * it is RECOMPUTED FROM THE ROWS on every event rather than incremented,
--     so it is idempotent, order-independent and immune to a trigger firing
--     twice;
--   * a transaction that ends with the column and the plan relation in
--     disagreement IS REFUSED AT COMMIT by a deferred constraint trigger, the
--     same device that already enforces obligation (a) of section 3;
--   * and NO PRINCIPAL CAN WRITE IT except through that trigger, because the
--     only `UPDATE` privilege on it anywhere is the column-level grant below.
--
-- THE INDUCTION, STATED IN FULL, BECAUSE «it is maintained» IS NOT A PROOF:
--
--   BASE CASE. The column is added here with `DEFAULT false`, in the SAME
--   IMPLICIT TRANSACTION that `CREATE TABLE installment_plans` runs in, so
--   the relation that could make it `true` is EMPTY at this instant and
--   `false` is correct for every invoice that exists. THERE IS NO BACKFILL
--   SCAN, and that is a property rather than an omission: a backfill scan
--   here would read `invoices` as the applying principal, which is the OWNER
--   and is therefore subject to `FORCE ROW LEVEL SECURITY` with no context
--   set — it would read ZERO ROWS AND PASS VACUOUSLY, which is the exact trap
--   `0075:439-441` names in the estate's own words («a green gate over an
--   unchecked invariant»). A guard that reads nothing is worse than no guard,
--   so none is written.
--
--   INDUCTIVE STEP. `installment_plan_fact_sync()` recomputes the column for
--   every invoice implicated by every `INSERT`, `UPDATE` or `DELETE` on
--   `installment_plans` — both sides of an `UPDATE` that moves a plan between
--   invoices — and refuses the write if it cannot land the recomputation.
--
--   ENFORCEMENT. `installment_plan_fact_verify()` re-derives the fact at
--   COMMIT, on both relations, and refuses any transaction that ends in
--   disagreement — including one that writes the column DIRECTLY, and
--   including an `INSERT INTO invoices` that is born with the column `true`,
--   which is reachable because `0078:264`'s `GRANT INSERT ON invoices` is
--   TABLE-LEVEL and a table-level grant covers a column added later.
--
--   PRIVILEGE. The grant below is the ONLY `UPDATE` privilege on this column
--   in the tree, it is COLUMN-LEVEL on the `0081:660` precedent, and it goes
--   to a NOLOGIN internal principal whose membership is `SET`-only — measured
--   by the round-7 challenger as `pg_has_role('daftar_migrator',
--   'daftar_accounting_internal','USAGE') = false`. `daftar_app` holds
--   `SELECT` only (`0075:494`) and reads the new column through that
--   table-level grant.
--
-- WHY IT IS A BOOLEAN AND NOT A PLAN ID. `installment_plans_one_active_per_invoice_uq`
-- already makes at most one plan active per invoice, so an id would carry no
-- information a boolean does not — and a `UUID` here would need a foreign key
-- back onto `installment_plans`, which would close a reference cycle between
-- two relations that already reference each other and would make the
-- lifecycle `active -> completed` a two-relation write instead of one.
ALTER TABLE invoices ADD COLUMN has_active_installment_plan BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN invoices.has_active_installment_plan IS
  'P4-S7 (TL-P4-COORD-R38 direction (d); challenger C1.a, THIRD round). Whether an installment plan with status = ''active'' exists for this invoice. It is LIFECYCLE and not money: no balance, no outstanding, no paid figure and no count of rows (P4-AL-06, challenger M-10) — one bit, carrying exactly the predicate customer_ar_aging''s active_plan CTE applies. It exists because the aging''s no-plan arm must not be keyed on a NOT EXISTS over installment_plans read through the CALLER''s row security: under row security ABSENT and INVISIBLE are one answer, and three rounds of guards that tried to certify the reader''s own visibility all failed, the third by checking policy properties that are not the properties deciding whether a role can see a row. Carried HERE, the fact is read through the very policy evaluation that let the caller see the invoice, so an invisible plan cannot exist for a visible invoice and no guard is needed. Maintained ONLY by installment_plan_fact_sync() on installment_plans, recomputed from the rows and never incremented; any transaction ending with this column and installment_plans in disagreement is REFUSED AT COMMIT by installment_plan_fact_verify(). The only UPDATE privilege on it is the column-level grant to daftar_accounting_internal; daftar_app reads it and cannot write it.';

-- THE ONLY WRITE AUTHORITY, column-level, on the `0081:660` precedent
-- («GRANT UPDATE (status) ON invoices TO daftar_inventory_internal» — a
-- column-level grant and one column, because PostgreSQL honours a locking
-- clause on the strength of UPDATE on ANY single column, so a table-level
-- grant would be a widening nobody asked for). The grantee is the NOLOGIN
-- internal principal that owns the two trigger functions of section 3a; it
-- cannot log in, and no runtime role is a `USAGE` member of it.
GRANT UPDATE (has_active_installment_plan) ON invoices TO daftar_accounting_internal;

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
--   (d) WHY (a) IS LOAD-BEARING AND NOT TIDINESS — THE TELESCOPING ARGUMENT.
--
--       The projection totals the authoritative outstanding whatever the data
--       says (proofs 1 and 4), so for a long time this verifier looked like
--       hygiene. IT IS NOT. The OVERDUE reading is what depends on it.
--
--       Under oldest-scheduled-first with the levels of section 6, the amount
--       the projection reports as overdue at `p_as_of` is the sum of the
--       level steps across the rows already due. Write `D` for the DECLARED
--       amount that has fallen due — `down + Σ a_i` over the rows dated on or
--       before `p_as_of` — and `P` for the authoritative paid figure. Because
--       the levels are `L(x) = min(max(x, P), T)` and they telescope, the
--       steps over the due prefix sum to
--
--           L(D) − L(0) = min(max(D, P), T) − P
--
--       and WHEN (a) HOLDS, so that the declared schedule sums to `T`, that
--       is exactly `max(0, D − P)`: THE DECLARED AMOUNT THAT HAS FALLEN DUE
--       AND IS NOT YET PAID. That identity is the whole meaning of the
--       overdue column, and it is an identity only while `Σ = T`.
--
--       Break (a) upward and the identity breaks with it: `D` may exceed `T`,
--       the clamp absorbs the excess, and the reported overdue figure is no
--       longer the unpaid due portion of anything. So the aging is exact
--       BECAUSE the invariant holds, and the invariant is owed in BOTH
--       directions for that reason — not for symmetry's sake. The 265-day
--       counterexample of the design document §2.0 is this failure made
--       concrete: schedule `900 000 @ 2026-01-15` plus `900 000 @
--       2027-01-15` against a total of `900 000`. The EXACT invariant refuses
--       it (`above, +900 000`); a `Σ <= total` variant ACCEPTS it. That is
--       why the comparison above is `<>` and not `>`.
--
--   (e) THE SCHEDULE LENGTH CEILING IS DECLARED HERE, AT 60, AND IT WAS
--       UNDECLARED UNTIL ROUND 4.
--
--       `installment_count INTEGER NOT NULL CHECK (BETWEEN 1 AND 60)` was
--       deleted as a stored count of another relation's rows (M-10),
--       correctly — and the ceiling went with it, leaving 60 as a figure the
--       prep document named and nothing enforced. The proof engineer
--       exercised 60 and FLAGGED IT AS UNDECLARED rather than treating it as
--       a contract, which was the right call: an undeclared ceiling exercised
--       as though it were one is how a convention becomes a belief.
--
--       SO IT IS DECLARED. Sixty instalments, five years monthly, checked
--       against the ROWS rather than stored beside them, in one constant in
--       one routine. It is a policy and not a derivation: raising it is a
--       one-constant change. The alternative — stating that there is no
--       ceiling — is refused here because an unbounded schedule is an
--       unbounded read on the `P4-H` budget path and the index that serves it.
--
--   (f) THE THIRD DIRECTION — `invoices.total_txn_minor` ITSELF — IS GUARDED
--       BY A PREDECESSOR, AND THE CONDITIONAL IS STATED AND NOT HIDDEN.
--
--       Both triggers above are on the PLAN side. The invariant is an
--       equality between a sum over `installments` and a column on
--       `invoices`, and the `invoices` side has no trigger of this slice's.
--       The challenger raised that as S7-2 and declined to reason it into a
--       verdict, which was right. IT IS CLOSED BY A PREDECESSOR MIGRATION,
--       not by this slice, and by THREE independent mechanisms. Cited so a
--       later reader does not have to re-derive them:
--
--       1. NO ROLE HOLDS THE PRIVILEGE TO WRITE THE COLUMN AT ALL, AND THIS
--          IS THE STRONGEST OF THE THREE. The only UPDATE grant on `invoices`
--          anywhere in the tree is `GRANT UPDATE (status) ON invoices TO
--          daftar_inventory_internal` (`0081:660`) — a COLUMN-LEVEL grant on
--          `status` alone. `daftar_app` holds `SELECT` only (`0075:494`).
--          Nobody holds UPDATE on `total_txn_minor`, `total_base_minor`,
--          `subtotal_txn_minor`, `discount_txn_minor`, `tax_minor`, the
--          currency or any rate column, IN ANY STATUS. A privilege check
--          happens BEFORE a BEFORE-UPDATE trigger runs, so this closes the
--          direction even where the trigger below declines to look.
--
--       2. THE LIFECYCLE GUARD, as a second bound if a grant is ever widened.
--          `invoices_lifecycle_guard()` (`0075:546`), attached as
--          `CREATE TRIGGER invoices_lifecycle_guard BEFORE UPDATE ON invoices
--          FOR EACH ROW` (`0075:637`), raises
--          `invoice.posted_amount_immutable` — «the amounts of a posted
--          invoice are final», `P4-AL-46` — when any of those columns changes
--          AND `OLD.status <> 'draft'` (`0075:561`).
--
--       3. NO PATH PRODUCES A DRAFT INVOICE, which is what makes clause 2's
--          conditional harmless. `status` admits `'draft'`
--          (`0075:257`), and `invoices_binding_owed_ck` (`0075:300`) permits
--          it because `binding_source_id` is nullable (`0075:280`) — so a
--          draft is not structurally impossible. But the ONLY `INSERT INTO
--          invoices` in the entire migration tree is `0078:974`, which writes
--          the literal `'open'`, and `0078:969-973` states the reason in its
--          own words: the guard «is BEFORE UPDATE only (`0075:553`), so an
--          INSERT in the posted state is permitted and a draft nobody asked
--          for is not created». `GRANT INSERT ON invoices` goes to
--          `daftar_inventory_internal` alone (`0078:264`), so no application
--          path can insert one either.
--
--       SO: CAN AN INSTALLMENT PLAN REFERENCE A DRAFT INVOICE? Not today —
--       no path creates one. And were one to exist, its total still could not
--       be amended, because of clause 1. The answer the challenger asked for
--       is therefore YES, CLOSED, and the mechanism is a column-level
--       PRIVILEGE rather than the CHECK or the FK he suggested looking for.
--
--       WHAT IS NOT CLOSED, STATED AS AN EXPOSURE RATHER THAN LEFT TO BE
--       FOUND. The chain above rests on clause 1, and clause 1 is a GRANT —
--       one line in a future migration widens it. If `GRANT UPDATE ON
--       invoices` is ever written without a column list, then clause 2's
--       `OLD.status <> 'draft'` conditional becomes reachable the moment
--       clause 3 also changes, and a draft invoice whose plan was built
--       against an old total could be amended and then promoted
--       `draft -> open` (a transition `0075:584` permits) with the plan-side
--       triggers never re-firing. THIS SLICE THEREFORE OWES A STATUS
--       PRECONDITION ON PLAN CREATION: the creating routine must refuse an
--       invoice whose status is not `'open'`. It cannot be a FOREIGN KEY —
--       `status` is mutable (`draft -> open -> void`), so an FK onto a
--       filtered view would be a second truth that the view's own definition
--       would have to keep — and it cannot be a column `CHECK`, because the
--       status lives on the other relation. It is an obligation on the
--       command, and it is PATCH REQUEST PR-8, routed with PR-6.
--
--       `open -> void` needs no guard: voiding does not change the total, and
--       the projection reads only `status = 'open'` invoices, so a voided
--       invoice leaves the aging entirely.
--
-- The projection does NOT depend on (a), (b), (c) or (d) FOR ITS TOTALS: it
-- totals the authoritative outstanding whatever the data says (proofs 1 and
-- 4). It depends on (a) for its OVERDUE SPLIT, per (d) above.
--
-- PR-5, RESOLVED BY DELETION. Round 2 also carried a pure TypeScript
-- `scheduleCoherenceFindings` that signalled the same violation and that
-- NOTHING READ. The coordinator refused to leave it: «either wire it into a
-- read path or a gate, or delete it and say the verifier is the whole bound.
-- Do not leave it as a third state.» It is DELETED. THIS VERIFIER IS THE
-- WHOLE BOUND, and a bound with one home cannot be believed in the wrong one.

-- ═════════════════════════════════════════════════════════════════════════
-- ORDER_NOTE (challenger H6: this block is DOCUMENTATION, and the law it
-- documents is asserted executably — by the ordering assertion in
-- `packages/domain-core/test/phase4-s7-installment-aging.test.ts`, and by the
-- `pg_trigger` arm of section 2b, which can only be satisfied if these three
-- blocks really were applied in this order. The design claimed for one round
-- that this comment ITSELF prevented a reordering. A comment prevents nothing.)
--
-- THE ORDER OF THESE THREE BLOCKS IS LOAD-BEARING, AND THE PARSER TAUGHT ME
-- THAT RATHER THAN A REVIEW.
--
-- Round 4 shipped this file with the two CONSTRAINT TRIGGERS ABOVE the
-- function they execute. PostgreSQL resolves the function AT
-- `CREATE TRIGGER` time, so the first trigger raised
--
--     42883: function installment_schedule_verify() does not exist
--
-- and, the whole file being one implicit transaction, NOTHING of this slice
-- was applied. THE SPECIFICATION COULD NEVER HAVE BEEN CREATED AS WRITTEN.
-- That is this estate's own recorded failure mode, named in the brief, and
-- three rounds of text-reading laws did not find it — including an
-- independent challenger who checked for the one instance of it the estate
-- had recorded (`pg_catalog.coalesce`) and correctly found it absent. ONLY
-- THE PARSER FOUND IT. It is the whole argument for challenger S7-1 and it is
-- kept here, like the five prose lessons, because the next author will write
-- the blocks in the order that reads well rather than the order that applies.
--
-- The order below is `0075`'s own, and `0075:632-634` states the second half
-- of the reason: «The triggers are created while the migrator still owns the
-- functions (a non-superuser must hold EXECUTE on a function to create a
-- trigger on it).» So:
--
--   1. the function, owned by whoever is applying the migration;
--   2. the triggers, created while that owner still holds EXECUTE;
--   3. the authority transfer, last.
--
-- Applying as a superuser hides step 2's constraint, which is why the order
-- follows the predecessor's precedent rather than only what the parser
-- happened to refuse today.
-- ═════════════════════════════════════════════════════════════════════════

-- ROUND 4: THE BODY IS WRITTEN HERE, BECAUSE «TRANSCRIBED AT PROMOTION» IS
-- NOT A BOUND.
--
-- The previous text said the body would be transcribed at promotion. The S7
-- proof engineer measured the consequence: NO migration in the tree contains
-- `installment_schedule_verify`, so the invariant existed in PROSE ONLY and
-- nothing executable said no in either direction. That is this estate's
-- recorded failure shape — a name that exists and no evidence behind it — and
-- it was worse here than usual, because the AGING'S OWN CORRECTNESS IS
-- CONDITIONAL ON THIS EXACT INVARIANT (section 3(d) below).
--
-- Owner, standing and search_path follow the `invoices_walkin_no_ar`
-- precedent (`0075`). IT READS NO CLOCK: every comparison below is against a
-- supplied or stored civil DATE or a stored integer, and the routine never
-- names a time function — section 6's clock law reads this text too.

-- THE CREATE BRACKET, AND IT IS NOT DECORATION (found by the executor, third
-- finding). `ALTER FUNCTION ... OWNER TO r` requires `r` to hold CREATE on the
-- containing schema. `daftar_accounting_internal` holds only USAGE
-- (`bootstrap.sql:198`), so applied by the DEPLOYMENT PRINCIPAL this file
-- failed with `42501 permission denied for schema public` — and NOTHING of the
-- slice applied, because the file is one implicit transaction. A SUPERUSER
-- never sees it, which is exactly why three rounds of applying it as
-- `postgres` could not. `bootstrap.sql:210-216` states the mechanism in the
-- estate's own words — «migration 0040 and the eight files after it lend
-- `CREATE ON SCHEMA public` to the role they are about to make owner and take
-- it back in the same transaction» — and `0075:657` / `0075:695` is the worked
-- bracket this one copies. Lend, create, transfer, take back.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION installment_schedule_verify() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business   UUID;
  v_plan       UUID;
  v_invoice    UUID;
  v_status     TEXT;
  v_down       BIGINT;
  v_total      BIGINT;
  v_sched      BIGINT;
  v_rows       INTEGER;
  v_max_seq    INTEGER;
  v_distinct   INTEGER;
  v_plan_tenant     UUID;
  v_invoice_tenant  UUID;
  v_tenant_mismatch INTEGER;
BEGIN
  -- WHICH PLAN THIS ROW IMPLICATES. Both relations are judged by this one
  -- routine, so the plan key is taken from whichever relation fired, and from
  -- OLD on a DELETE because NEW is null there — the DELETE direction is the
  -- one a prose-only law would have left open.
  -- `TG_OP` AND NOT `coalesce(NEW.x, OLD.x)` (challenger L12). On a DELETE the
  -- `NEW` record is not assigned, and a field access on an unassigned trigger
  -- record can raise `55000 record "new" is not assigned yet` rather than
  -- yielding NULL. The estate-standard idiom removes the question for free,
  -- and a `55000` here would have surfaced as "the DELETE arm does not refuse"
  -- rather than as a defect in this line.
  -- AND A `CASE` OVER A RECORD'S FIELDS IS NOT A GUARD (found by the executor,
  -- fifth finding). The first attempt at this repair wrote
  -- `CASE WHEN TG_TABLE_NAME = 'installment_plans' THEN NEW.id ELSE NEW.plan_id END`
  -- and every write failed with `record "new" has no field "plan_id"`: plpgsql
  -- resolves a record field reference when the expression is evaluated, and a
  -- `CASE` evaluates its type-level references regardless of which branch
  -- wins. The relation must therefore be the OUTER branch, as it was before,
  -- with `TG_OP` inside it.
  IF TG_TABLE_NAME = 'installment_plans' THEN
    IF TG_OP = 'DELETE' THEN
      v_business := OLD.business_id;
      v_plan     := OLD.id;
    ELSE
      v_business := NEW.business_id;
      v_plan     := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_business := OLD.business_id;
      v_plan     := OLD.plan_id;
    ELSE
      v_business := NEW.business_id;
      v_plan     := NEW.plan_id;
    END IF;
  END IF;

  SELECT p.status, p.down_payment_minor, p.invoice_id, p.tenant_id
    INTO v_status, v_down, v_invoice, v_plan_tenant
    FROM public.installment_plans p
   WHERE p.business_id = v_business AND p.id = v_plan;

  -- A plan deleted inside this transaction implicates nothing: there is no
  -- schedule left to be incomplete. Not a silent pass — an empty subject.
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- ONLY AN ACTIVE PLAN IS BOUND. A completed or cancelled plan is history and
  -- the projection does not read it (`active_plan` filters on status), so
  -- binding it would refuse a legitimate cancellation.
  IF v_status <> 'active' THEN RETURN NULL; END IF;

  SELECT i.total_txn_minor, i.tenant_id INTO v_total, v_invoice_tenant
    FROM public.invoices i
   WHERE i.business_id = v_business AND i.id = v_invoice;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (a) the plan names no invoice of this business'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(pg_catalog.sum(n.amount_txn_minor), 0), pg_catalog.count(*),
         coalesce(pg_catalog.max(n.seq_no), 0), pg_catalog.count(DISTINCT n.seq_no)
    INTO v_sched, v_rows, v_max_seq, v_distinct
    FROM public.installments n
   WHERE n.business_id = v_business AND n.plan_id = v_plan;

  -- (a) THE EXACT SUM LAW, IN BOTH DIRECTIONS AT ONCE — `R-SAL-06`.
  --     `<>` and not `>`: a schedule summing BELOW the total is refused and a
  --     schedule summing ABOVE it is refused, by the same comparison, so
  --     neither direction can be lost by someone relaxing one inequality. A
  --     `<=` variant would accept the 265-day counterexample of section 3(d).
  IF v_down + v_sched <> v_total THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (a) the schedule sums to % and the invoice total is %',
      v_down + v_sched, v_total USING ERRCODE = 'P0001';
  END IF;

  -- (b) AT LEAST ONE INSTALMENT ROW. Without it an active plan with zero rows
  --     is reachable, and the reference model and the projection took OPPOSITE
  --     arms on it (challenger M-9). The model no longer consults the row
  --     count, so the two agree either way; this makes the state unreachable
  --     as well, closing the disagreement from both ends.
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (b) an active plan has no instalments'
      USING ERRCODE = 'P0001';
  END IF;

  -- (c) `seq_no` CONTIGUOUS FROM 1. It crosses rows, so it cannot be a column
  --     CHECK. `installments_seq_uq` already makes `seq_no` unique in the
  --     plan, so distinct = count; the maximum equalling the count is then
  --     exactly contiguity from 1, given the column's own `>= 1` CHECK.
  IF v_max_seq <> v_rows OR v_distinct <> v_rows THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (c) seq_no is not contiguous from 1 (% rows, max %)',
      v_rows, v_max_seq USING ERRCODE = 'P0001';
  END IF;

  -- (e) THE TENANT OF THE PLAN IS THE TENANT OF ITS INVOICE, AND THE TENANT OF
  --     EVERY INSTALMENT IS THE TENANT OF ITS PLAN. Added for challenger C1:
  --     this is not tidiness, it is the SOURCE of the only visibility
  --     asymmetry `daftar_app` can suffer.
  --
  --     `installment_plans_invoice_fk` ties `business_id` to the invoice's, so
  --     the business can never diverge. `tenant_id` is tied to NOTHING: it is
  --     a supplied column, and `invoices` carries no unique key on
  --     `(tenant_id, business_id, id)` for a composite foreign key to name
  --     (and this specification may not add one to a predecessor's relation).
  --     So a plan written with the WRONG tenant is expressible — and every
  --     policy on these relations is keyed on `tenant_id`. The consequence is
  --     the one section 6a exists to make unreachable: a caller who CAN see
  --     the invoice (its tenant matches) CANNOT see the plan (its tenant does
  --     not), so the no-plan arm of the projection serves the whole
  --     outstanding at the single invoice due date — the pre-S7 defect, with
  --     no error. A deferred cross-row obligation is the only place this can
  --     be enforced without a key on somebody else's table, and the verifier
  --     is already here, already DEFINER and already reading the invoice.
  IF v_plan_tenant IS DISTINCT FROM v_invoice_tenant THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (e) the plan tenant % is not the invoice tenant %',
      v_plan_tenant, v_invoice_tenant USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.count(*) INTO v_tenant_mismatch
    FROM public.installments n
   WHERE n.business_id = v_business AND n.plan_id = v_plan AND n.tenant_id IS DISTINCT FROM v_plan_tenant;
  IF v_tenant_mismatch > 0 THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (e) % instalments do not carry the plan tenant %',
      v_tenant_mismatch, v_plan_tenant USING ERRCODE = 'P0001';
  END IF;

  -- (d) THE SCHEDULE LENGTH CEILING. See section 3(e): this is a DECLARED
  --     policy with one constant, not a convention anybody inferred.
  IF v_rows > 60 THEN
    RAISE EXCEPTION 'installment.schedule_incomplete: (d) a schedule of % instalments exceeds the declared ceiling of 60',
      v_rows USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER installment_plans_schedule_complete
  AFTER INSERT OR UPDATE ON installment_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installment_schedule_verify();

CREATE CONSTRAINT TRIGGER installments_schedule_complete
  AFTER INSERT OR UPDATE OR DELETE ON installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installment_schedule_verify();

-- THE PRIVILEGE WORK HAPPENS WHILE THE APPLIER STILL OWNS THE FUNCTION, and
-- the OWNER TRANSFER IS LAST (found by the executor, fourth finding). With
-- the transfer first, the deployment principal met
-- `42501 must be owner of function installment_schedule_verify` on its own
-- `REVOKE` and `COMMENT`: once ownership moves, the applier may no longer
-- change the function's grants or its comment. `0075:686-695` is the order
-- that works — REVOKE, GRANT EXECUTE to the role about to own it, COMMENT,
-- CREATE TRIGGER, and only then `ALTER FUNCTION ... OWNER TO`. A superuser
-- never meets this either.
REVOKE ALL ON FUNCTION installment_schedule_verify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_schedule_verify() TO daftar_accounting_internal;
COMMENT ON FUNCTION installment_schedule_verify() IS
  'P4-S7 (P4-AL-13, R-SAL-06). At COMMIT, for every ACTIVE installment plan touched: down_payment_minor plus the sum of its installments equals the invoice total EXACTLY — one <> comparison, so below and above are refused together and neither direction can be lost by relaxing one inequality; at least one installment row; seq_no contiguous from 1; and at most the declared ceiling of 60 installments. Otherwise installment.schedule_incomplete, naming which of (a) to (d) failed. It fires on DELETE as well as INSERT and UPDATE, because a schedule can be pushed below the total by deleting a row. It performs NO allocation, reads NO aging, stores nothing, and reads no clock. DEFERRABLE INITIALLY DEFERRED, so a long schedule may be written row by row inside one transaction and is judged once. Internal-owned DEFINER, pinned search_path, no grant; reads only.';

ALTER FUNCTION installment_schedule_verify() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;


-- ── 3a. THE FACT'S MAINTAINER AND ITS COMMIT-TIME VERIFIER ───────────────
--
-- Section 2c declares the column and the induction that keeps it right. This
-- section is the inductive step and the enforcement, and it is placed HERE —
-- below section 3's whole bracket — for the reason the `ORDER_NOTE` above
-- records: `CREATE CONSTRAINT TRIGGER` resolves `EXECUTE FUNCTION` AT CREATE
-- TIME, the file is one implicit transaction, and a trigger written above its
-- function applies NOTHING. Function, then triggers, then the authority
-- transfer, then take the lent `CREATE` back. `0075:632-634`'s order, a third
-- time in this file.
--
-- ── WHY THERE ARE TWO ROUTINES AND NOT ONE ──────────────────────────────
--
-- They do different jobs for different principals and a single routine would
-- have to be both, which is how round 6's `SECURITY DEFINER` count came to
-- carry the defect it was written to close.
--
--   `installment_plan_fact_sync()` WRITES. It is the only thing in the tree
--   that writes the column. It runs IMMEDIATELY (an ordinary `AFTER … FOR
--   EACH ROW` trigger, not deferred), so the column is right as soon as the
--   statement that changed a plan has completed, and so the verifier below
--   has something to check at COMMIT.
--
--   `installment_plan_fact_verify()` only READS and RAISES. It is a DEFERRED
--   CONSTRAINT TRIGGER on BOTH relations, so it judges the END STATE of the
--   transaction once rather than every intermediate step — a plan may be
--   inserted, its schedule written and its status moved inside one
--   transaction and the fact is judged once, at COMMIT, exactly as obligation
--   (a) of section 3 is judged.
--
-- ── THE ASYMMETRY THAT MAKES THIS WORK WHERE THREE GUARDS FAILED ────────
--
-- Both routines are `SECURITY DEFINER` owned by `daftar_accounting_internal`,
-- and that is load-bearing in a way the retired guard's DEFINER was not.
--
--   THE MAINTAINER AND THE VERIFIER MUST SEE EVERYTHING, and they do: that
--   principal holds the UNCONDITIONAL `accounting_validator` SELECT policy on
--   `installment_plans` and `installments` (section 2a) and on `public.invoices`
--   (`0075:457-458`), and the restrictive read policies admit it by
--   `current_user`. So neither routine can be blinded by a missing session
--   context, and neither is asked to decide anything about what a CALLER can
--   see.
--
--   THE READER MUST SEE WHAT ITS CALLER SEES, and it does: `customer_ar_aging`
--   stays `SECURITY INVOKER` and reads the column off the invoice row through
--   the caller's own policies.
--
--   ROUND 6's DEFINER FAILED BECAUSE IT WAS ASKED THE READER'S QUESTION —
--   «are there plans the caller cannot see?» — AS THE OWNER, so its own
--   blindness read as «none». These two are never asked that question at all.
--   The reader is not asked it either, because the fact is simply ON THE ROW.
--
-- ── WHAT THE WRITE DEPENDS ON, STATED BECAUSE IT IS A REAL CONDITION ────
--
-- `app_bypass()` IS NOT A SESSION SETTING ANY MORE. `0006:11` defined it as
-- `current_setting('app.bypass_rls', true) = 'true'`; `0052:244` REPLACED it
-- with `CURRENT_USER = 'daftar_platform'`. So on `public.invoices` the
-- permissive `tenant_membership` and the restrictive `business_isolation_update`
-- admit an `UPDATE` by `daftar_accounting_internal` only when
-- `app.tenant_id` and `app.business_id` match the INVOICE's own values.
-- `accounting_validator` does not help: it is `FOR SELECT`.
--
-- THAT IS NOT A WEAKNESS, IT IS THE SYMMETRY ENFORCED ON THE WRITE SIDE. A
-- transaction may flag an invoice only if it could have updated that invoice
-- in its own right — the same `tenant_id` and `business_id` predicates it
-- already had to satisfy to INSERT the plan at all
-- (`business_isolation_insert`, `tenant_membership`'s `WITH CHECK`). And the
-- composite foreign key `installment_plans_invoice_fk` pins the plan's
-- `business_id` to the invoice's, so the business half cannot disagree.
--
-- The `tenant_id` half CAN disagree, because that foreign key does not carry
-- `tenant_id`: a plan inserted with a `tenant_id` of its own that differs from
-- its invoice's would satisfy the plan's policies and NOT the invoice's. The
-- recomputation would then land on ZERO ROWS — and the `ROW_COUNT` check
-- below RAISES on exactly that rather than silently writing nothing, so the
-- cross-tenant plan is REFUSED. That is a strengthening this section gets for
-- free and it is stated so that nobody removes the `ROW_COUNT` check thinking
-- it is defensive noise. IT IS THE REFUSAL.
--
-- THE OBLIGATION THIS PLACES ON THE FUTURE PLAN WRITER, since this
-- specification ships none (`P4-AL-38`, section 2a): the command that creates,
-- completes or cancels a plan must run with `app.tenant_id` and
-- `app.business_id` set to the invoice's own values. Every application path
-- already does — `0006`'s header states the contract («Context is set
-- per-transaction via set_config(..., true)») — and a migration-level
-- backfill must set them per business. It is not a convention: a writer that
-- does not gets `installment.plan_fact_unwritable` and no row.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION installment_plan_fact_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business UUID;
  v_invoices UUID[];
  v_invoice  UUID;
  v_state    BOOLEAN;
  v_rows     INTEGER;
BEGIN
  -- `OLD` IS NOT ASSIGNED ON AN INSERT AND `NEW` IS NOT ASSIGNED ON A DELETE,
  -- and plpgsql raises «record "old" is not assigned yet» on the attribute
  -- rather than yielding NULL — so the three cases are branched explicitly
  -- instead of being folded into a `coalesce` or a `CASE`, both of which would
  -- evaluate the unassigned side.
  IF TG_OP = 'INSERT' THEN
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_invoices := ARRAY[OLD.invoice_id];
  ELSE
    -- A plan may not change business: the old invoice's flag would then live
    -- in a business this statement is not writing, and one recomputation
    -- cannot reach both.
    IF OLD.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'installment.plan_fact_unwritable: a plan may not move between businesses, because the invoice that carries its fact is keyed on the business'
        USING ERRCODE = 'P0001';
    END IF;
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    -- BOTH SIDES. `invoice_id` is not immutable today, and an UPDATE that
    -- moves a plan from one invoice to another leaves the OLD invoice flagged
    -- for a plan it no longer has.
    IF OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      v_invoices := v_invoices || OLD.invoice_id;
    END IF;
  END IF;

  FOREACH v_invoice IN ARRAY v_invoices LOOP
    -- RECOMPUTED FROM THE ROWS, never incremented and never derived from
    -- `NEW.status` alone: an increment is wrong if the trigger fires twice and
    -- a read of `NEW` alone is wrong when a SECOND plan on the same invoice is
    -- still active. This is the projection's own `active_plan` predicate.
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = v_business AND p.invoice_id = v_invoice
                      AND p.status = 'active')
      INTO v_state;
    -- NO `WHERE has_active_installment_plan IS DISTINCT FROM v_state` GUARD.
    -- It would make `ROW_COUNT = 0` mean either «already correct» or «I could
    -- not reach the row», which are the two answers this routine exists to
    -- tell apart. The cost is one row version per plan write, and plan writes
    -- are rare.
    UPDATE public.invoices i SET has_active_installment_plan = v_state
     WHERE i.business_id = v_business AND i.id = v_invoice;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'installment.plan_fact_unwritable: this transaction changed a plan on invoice %/% but could not write the invoice''s own has_active_installment_plan (% rows), so the aging would read a fact nobody maintained',
        v_business, v_invoice, v_rows USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION installment_plan_fact_verify() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business UUID;
  v_invoices UUID[];
  v_invoice  UUID;
  v_flag     BOOLEAN;
  v_state    BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    -- The invoice side. `0075`'s `invoices_no_delete` refuses every DELETE on
    -- this relation, so `NEW` is always assigned here.
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_invoices := ARRAY[OLD.invoice_id];
  ELSE
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    IF OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      v_invoices := v_invoices || OLD.invoice_id;
    END IF;
  END IF;

  FOREACH v_invoice IN ARRAY v_invoices LOOP
    SELECT i.has_active_installment_plan INTO v_flag
      FROM public.invoices i
     WHERE i.business_id = v_business AND i.id = v_invoice;
    IF NOT FOUND THEN
      -- A plan whose invoice this principal cannot find. It holds the
      -- unconditional read on `invoices`, so «not found» is «not there» —
      -- and a fact nobody carries is not a fact this read may draw a
      -- conclusion from. It REFUSES rather than returning, because returning
      -- here is precisely the vacuous pass that `0075:439-441` names.
      RAISE EXCEPTION 'installment.plan_fact_desynchronised: no invoice %/% exists to carry the fact an installment plan asserts about it',
        v_business, v_invoice USING ERRCODE = 'P0001';
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = v_business AND p.invoice_id = v_invoice
                      AND p.status = 'active')
      INTO v_state;
    IF v_flag IS DISTINCT FROM v_state THEN
      RAISE EXCEPTION 'installment.plan_fact_desynchronised: invoices.has_active_installment_plan is % for %/% while an active installment plan %, and customer_ar_aging ages that invoice from this column',
        v_flag, v_business, v_invoice,
        CASE WHEN v_state THEN 'does exist' ELSE 'does not exist' END
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;

-- The triggers, created while the migrator still owns the functions (a
-- non-superuser must hold EXECUTE on a function to create a trigger on it) —
-- `0075:632-634`.
--
-- THE SYNC IS NOT DEFERRED. It must have run before the verifier looks, and a
-- deferred writer and a deferred verifier on the same event would be ordered
-- by name rather than by meaning.
CREATE TRIGGER installment_plans_fact_sync
  AFTER INSERT OR UPDATE OR DELETE ON installment_plans
  FOR EACH ROW EXECUTE FUNCTION installment_plan_fact_sync();

-- THE VERIFIER IS DEFERRED, ON BOTH SIDES OF THE FACT.
CREATE CONSTRAINT TRIGGER installment_plans_fact_agrees
  AFTER INSERT OR UPDATE OR DELETE ON installment_plans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION installment_plan_fact_verify();

-- AND ON `invoices`, FOR `INSERT` AS WELL AS FOR THE COLUMN'S OWN `UPDATE`.
-- `UPDATE OF` alone would leave the INSERT route open, and that route is
-- REACHABLE: `0078:264`'s `GRANT INSERT ON invoices TO daftar_inventory_internal`
-- is TABLE-LEVEL, and a table-level INSERT privilege covers a column added
-- later — so an invoice can be born carrying `true` with no plan behind it.
-- The cost is one `EXISTS` per inserted invoice at COMMIT, on a path that
-- inserts one invoice per sale.
CREATE CONSTRAINT TRIGGER invoices_installment_fact_agrees
  AFTER INSERT OR UPDATE OF has_active_installment_plan ON invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION installment_plan_fact_verify();

REVOKE ALL ON FUNCTION installment_plan_fact_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION installment_plan_fact_verify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_plan_fact_sync() TO daftar_accounting_internal;
GRANT EXECUTE ON FUNCTION installment_plan_fact_verify() TO daftar_accounting_internal;
COMMENT ON FUNCTION installment_plan_fact_sync() IS
  'P4-S7 (TL-P4-COORD-R38 direction (d)). The ONLY writer of invoices.has_active_installment_plan. An ordinary AFTER ROW trigger on installment_plans — not deferred, so the column is right as soon as the statement completes and the deferred verifier has something to check at COMMIT. It RECOMPUTES the fact from the rows (EXISTS over status = ''active'', the projection''s own active_plan predicate) rather than incrementing or reading NEW.status, so it is idempotent, order-independent and correct when a second plan on the same invoice is still active. It recomputes BOTH invoices of an UPDATE that moves a plan, and refuses a plan that changes business. It carries NO ''WHERE value IS DISTINCT FROM'' guard, deliberately: ROW_COUNT <> 1 must mean "I could not reach the invoice row" and not "it was already correct", and it RAISES installment.plan_fact_unwritable on it — which is what refuses a plan whose tenant_id disagrees with its invoice''s, since installment_plans_invoice_fk pins business_id and not tenant_id. SECURITY DEFINER owned by daftar_accounting_internal, which holds the unconditional accounting_validator read on both relations and the column-level UPDATE on invoices; the UPDATE still passes through invoices'' own tenant_membership and business_isolation_update policies, so a writer must carry the invoice''s app.tenant_id and app.business_id. Pinned search_path. No EXECUTE grantee but its owner.';
COMMENT ON FUNCTION installment_plan_fact_verify() IS
  'P4-S7 (TL-P4-COORD-R38 direction (d)). The COMMIT-time refusal that makes invoices.has_active_installment_plan true rather than merely maintained. A DEFERRABLE INITIALLY DEFERRED constraint trigger on BOTH sides of the fact: on installment_plans for INSERT, UPDATE and DELETE, and on invoices for INSERT and for UPDATE OF that column — the INSERT arm because 0078:264''s GRANT INSERT ON invoices is table-level and therefore covers a column added later, so an invoice could be born carrying the fact with no plan behind it. It re-derives EXISTS(active plan) and refuses installment.plan_fact_desynchronised on any disagreement, and refuses rather than returning when no invoice carries the fact at all, because returning there is the vacuous pass 0075:439-441 names. It only READS and RAISES: it writes nothing. SECURITY DEFINER owned by daftar_accounting_internal so that its reading cannot be blinded by an absent session context — the asymmetry that makes this construction sound where round 6''s DEFINER count was not: this routine is never asked what a CALLER can see, and the reader is never asked either, because the fact is on the row. Pinned search_path. No EXECUTE grantee but its owner.';

ALTER FUNCTION installment_plan_fact_sync() OWNER TO daftar_accounting_internal;
ALTER FUNCTION installment_plan_fact_verify() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;


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

-- -- 6a. THE NO-PLAN ARM FAILS CLOSED BY CONSTRUCTION -- challenger C1.a,
--     THIRD ROUND, AND THE MECHANISM IS NO LONGER A GUARD ----------------
--
-- THE DEFECT, AND WHY IT SURVIVED TWO REPAIRS. Arm (c) of the projection was
-- keyed on `WHERE NOT EXISTS (SELECT 1 FROM active_plan ...)`.
-- `customer_ar_aging` is `SECURITY INVOKER` (`R-P4-07`, and it must stay so),
-- so `active_plan` is read THROUGH THE CALLER'S ROW SECURITY. Under row
-- security, "absent" and "invisible" are the same answer, and `NOT EXISTS`
-- asks the one question that cannot tell them apart. A caller who could see
-- the invoice and not its plan was served THE WHOLE OUTSTANDING AT THE SINGLE
-- INVOICE DUE DATE -- the exact pre-S7 defect this slice exists to repair,
-- with no error, no empty result and no `42501`. A plausible wrong number a
-- merchant would believe.
--
-- Two repairs were shipped and both carried the defect inside themselves,
-- and the third shape is recorded in section 2c because it is the one that
-- settles the direction: a `SECURITY DEFINER` count whose own blindness read
-- as "no hidden plan", and then a `pg_policy` assertion whose checked
-- properties were not the properties that decide whether a role can see a
-- row. `TL-P4-COORD-R38` retires that whole family:
--
--     A READER CANNOT CERTIFY ITS OWN VISIBILITY.
--
-- SO NOTHING CERTIFIES IT ANY MORE. Section 2c carries the fact on the
-- invoice row, and the arm reads it from there:
--
--     no_plan = the open invoices whose OWN ROW says has_active_installment_plan
--               IS FALSE
--
-- and NOT "the open invoices for which I can see no plan". The difference is
-- the whole repair. The fact that decides arm (c) is now read through the
-- very `pg_policy` entries, the very `tenant_id` and `business_id`
-- comparisons and the very row that let the caller see the invoice at all, so
-- plan-invisibility implies invoice-invisibility BY CONSTRUCTION and the
-- question the three guards kept getting wrong is no longer asked.
--
-- `installment_plan_visibility_assert()` IS DELETED. It is not weakened, not
-- extended with `polroles`, and not kept beside the column: a retired guard
-- left in place is a second answer to a question with one answer, and the
-- next author would believe the wrong one. Nothing in this file reads
-- `pg_policy` at read time any more.
--
-- ---- WHAT IS STILL ASSERTED, AND WHY IT IS NOT A FOURTH GUARD ----------
--
-- The column removes the SILENT WRONG NUMBER. It does not by itself remove
-- the SILENT OMISSION, and that case must be named rather than discovered:
--
--   flag TRUE, plan INVISIBLE. Arms (a) and (b) read `active_plan` and get
--   nothing; arm (c) excludes the invoice because its own row says it has a
--   plan. The invoice would contribute ZERO -- a receivable silently absent
--   from its own aging. Quieter than the old defect and still wrong.
--
--   flag FALSE, plan VISIBLE. Arms (a) and (b) would age the schedule AND arm
--   (c) would age the whole figure at the due date: a DOUBLE COUNT, worse
--   than the defect being repaired. This one cannot reach COMMIT -- section
--   3a's deferred verifier refuses it and no principal can write the column
--   outside that path -- but a disabled trigger is a state, and a read that
--   serves a double count when it is in that state is not fail-closed.
--
--   plan VISIBLE, schedule INVISIBLE. `installments` is a second relation
--   with its own policies. A caller who sees the plan and not its rows gets a
--   schedule of one row -- the down payment -- and the rest of the figure
--   lands in the residual at the invoice due date. The totals still
--   telescope (proofs 1 and 4); the BUCKETS are silently coarsened. Section
--   3's obligation (b) guarantees at least one `installments` row exists for
--   every active plan, so seeing none means not being able to see them.
--
-- `installment_plan_fact_assert` refuses all three. IT IS NOT A GUARD OVER
-- VISIBILITY AND THE DIFFERENCE IS STRUCTURAL, NOT RHETORICAL:
--
--   * IT READS NOTHING. No relation, no catalogue, no `pg_policy`, no
--     `has_table_privilege`, no `current_user`. Its whole body is three
--     comparisons against zero.
--   * IT IS TOLD AN ANSWER RATHER THAN ASKED A QUESTION. The three counts are
--     computed BY THE CALLER, in the caller's own query, over the caller's own
--     visible rows. Round 6's `pronargs = 0` was demanded because a guard that
--     can be ASKED about a tenant's rows is an oracle over them. This routine
--     cannot be asked anything: its argument list is exactly three `bigint`s,
--     which section 2b pins by `proargtypes` -- a structural bound, not a
--     substring test. Three numbers name no row.
--   * IT IS `SECURITY INVOKER`, so it could not see anything the caller
--     cannot see even if it tried to look.
--   * AND IT COMPARES TWO READINGS OF DATA, not a property of a policy. No
--     DDL statement on one relation can satisfy it while hiding rows: hiding
--     the plans makes the two readings DISAGREE, which is what it refuses on.
--     That is the property every previous version lacked.
--
-- THE SCOPE OF THE COUNTS IS ALL OPEN INVOICES OF THIS CUSTOMER, NOT ONLY
-- THOSE WITH A NON-ZERO OUTSTANDING, and that is deliberate: narrowing them
-- would need the outstanding figures, which would mean a SECOND call to
-- `invoice_outstanding` and would break "one authoritative money input, one
-- call for the whole customer". The cost is that a caller blind to plans is
-- refused even when the only flagged invoice is already fully paid and would
-- have contributed nothing. That is over-strict in the safe direction, and a
-- plan still `active` on a fully-paid invoice is a lifecycle anomaly anyway.
--
-- WHERE IT IS CALLED, AND WHY THERE. At the ROOT of the query, on
-- `invoice_checked`, which every other CTE reads from -- not inside arm (c).
-- Round 7 measured that the old `CROSS JOIN (SELECT f() AS ok) g` inside arm
-- (c) was evaluated exactly once even when the arm returned nothing, which is
-- true and is not something to rely on: the dangerous state is
-- "open invoices present, every one of them flagged, plans invisible", where
-- the correct answer is a REFUSAL and the arm is empty. Rooting the call makes
-- the assertion a dependency of every row the function can return instead of
-- a property of one arm's plan shape.
--
-- WHAT IS NO LONGER NEEDED AND IS THEREFORE GONE. The retired guard checked
-- that row security was enabled and forced on both relations, that the caller
-- held `SELECT`, and that the declared policy name set was present. None of
-- those facts is load-bearing for this arm any more -- the arm does not read
-- `installment_plans` to decide anything -- and section 2b asserts all three
-- AT APPLY TIME, from the live catalogue, where they belong.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION installment_plan_fact_assert(p_unreadable_plan BIGINT,
                                                        p_unflagged_plan BIGINT,
                                                        p_unreadable_schedule BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  -- Three counts, three refusals, three DISTINCT messages. One message over a
  -- summed count would tell a reader that something disagreed and not WHICH
  -- reading disagreed, and a law that asserts "it refused" rather than "it
  -- refused THIS" is satisfied by a routine that refuses everything.
  IF p_unreadable_plan <> 0 THEN
    RAISE EXCEPTION 'installment.plan_fact_unreadable: % of this customer''s open invoices carry has_active_installment_plan while this caller can read no active plan for them, so their schedules cannot be aged and must not be aged at the invoice due date instead',
      p_unreadable_plan USING ERRCODE = 'P0001';
  END IF;
  IF p_unflagged_plan <> 0 THEN
    RAISE EXCEPTION 'installment.plan_fact_unflagged: % of this customer''s open invoices have an active installment plan this caller can read while their own has_active_installment_plan is false, so the schedule and the whole figure would both be aged',
      p_unflagged_plan USING ERRCODE = 'P0001';
  END IF;
  IF p_unreadable_schedule <> 0 THEN
    RAISE EXCEPTION 'installment.plan_schedule_unreadable: % active installment plan(s) this caller can read have no installments row it can read, which section 3 obligation (b) makes impossible unless the schedule rows are invisible, so the schedule would be silently coarsened to its down payment',
      p_unreadable_schedule USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) IS
  'P4-S7 (TL-P4-COORD-R38 direction (d); challenger C1.a, third round). The three refusals customer_ar_aging owes once the no-plan arm is keyed on invoices.has_active_installment_plan instead of on a NOT EXISTS through the caller''s row security. It is NOT a visibility guard and the difference is structural: it READS NOTHING — no relation, no catalogue, no pg_policy, no has_table_privilege, no current_user — and it is TOLD three counts the CALLER computed over the CALLER''s own visible rows rather than asked whether the caller can see anything. Its argument list is exactly three bigints, pinned by proargtypes in section 2b, so it cannot be asked about a row: three numbers name none. SECURITY INVOKER, so it could see nothing the caller cannot see even if it looked. What it refuses: plan_fact_unreadable, an invoice whose own row says it has an active plan while the caller can read none (the silent OMISSION that the column alone would leave); plan_fact_unflagged, a readable active plan whose invoice is not flagged (the DOUBLE COUNT, which section 3a''s deferred verifier already makes unreachable at COMMIT and which this refuses at read time anyway); plan_schedule_unreadable, a readable active plan with no readable installments row, which section 3 obligation (b) makes impossible unless the schedule rows are invisible and which would otherwise coarsen the schedule to its down payment. Called at the ROOT of the projection, on invoice_checked, so it is a dependency of every row the reader can return rather than a property of one arm''s plan shape. STABLE; reads nothing; grants nobody anything.';

-- ...and the transfer last, for the reason section 3 records. Ownership is
-- about who may later ALTER it, not about authority: this routine is INVOKER
-- and grants its callers nothing.
ALTER FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- >>> P4S7 PROJECTION SKETCH BEGIN
CREATE OR REPLACE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])
RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  WITH invoice_fact AS (
    -- THE INVOICE ROWS THIS READ IS ABOUT, AND THE FACT THEY CARRY.
    --
    -- `has_active_installment_plan` is read HERE, off the invoice row, and it
    -- is the only thing that decides which arm ages an invoice (section 2c,
    -- section 6a). Read on this row, through this row's own policies, the fact
    -- about the plan cannot be visible when the invoice is not and cannot be
    -- invisible when the invoice is: there is no second relation between the
    -- question and the answer.
    --
    -- This also replaces the inline `SELECT array_agg(x.id) FROM public.invoices
    -- x WHERE ...` the money call used to carry, so `public.invoices` is read
    -- ONCE for the whole projection and the id set and the fact set are by
    -- construction the same set.
    SELECT x.id AS invoice_id, x.has_active_installment_plan AS flagged
      FROM public.invoices x
     WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open'
  ),
  visible_plan AS (
    -- The active plans THIS CALLER CAN READ for those invoices. It is one of
    -- the two readings `fact` compares; it is not an answer to "are there
    -- plans I cannot see?", which is the question no reader can answer about
    -- itself.
    SELECT p.id, p.invoice_id, p.down_payment_minor, p.down_payment_due_date
      FROM public.installment_plans p
     WHERE p.business_id = p_business_id AND p.status = 'active'
       AND p.invoice_id IN (SELECT i.invoice_id FROM invoice_fact i)
  ),
  fact AS (
    -- THE TWO READINGS, COMPARED. One row, always -- an aggregate with no
    -- GROUP BY -- so the assertion below is reached even when every count is
    -- zero and even when there is no invoice at all.
    SELECT pg_catalog.count(*) FILTER (WHERE i.flagged AND v.id IS NULL)::BIGINT          AS unreadable_plan,
           pg_catalog.count(*) FILTER (WHERE NOT i.flagged AND v.id IS NOT NULL)::BIGINT  AS unflagged_plan,
           pg_catalog.count(*) FILTER (WHERE v.id IS NOT NULL
                                         AND NOT EXISTS (SELECT 1 FROM public.installments n
                                                          WHERE n.business_id = p_business_id
                                                            AND n.plan_id = v.id))::BIGINT AS unreadable_schedule
      FROM invoice_fact i
      LEFT JOIN visible_plan v ON v.invoice_id = i.invoice_id
  ),
  invoice_checked AS (
    -- THE ROOT. Every CTE below reads the invoice set from HERE, so the three
    -- refusals are a dependency of every row this function can return rather
    -- than a property of one arm's plan shape. The assertion is TOLD the three
    -- counts; it reads nothing and can be asked nothing (section 6a).
    SELECT i.invoice_id, i.flagged
      FROM invoice_fact i
     CROSS JOIN (SELECT public.installment_plan_fact_assert(f.unreadable_plan,
                                                            f.unflagged_plan,
                                                            f.unreadable_schedule) AS ok
                   FROM fact f) g
     WHERE g.ok
  ),
  open_invoice AS (
    -- THE ONE AUTHORITATIVE MONEY INPUT, and one call for the whole customer.
    -- `T` and `B` are the stored authoritative PAIR recomposed from the figures
    -- this call already returns, which is why no second `JOIN public.invoices`
    -- is needed for them and why `0084:593-596`'s appended `currency_code` and
    -- `due_date` are read straight off it. The id set comes from
    -- `invoice_checked`, so the money read is downstream of the refusals.
    SELECT o.invoice_id, o.currency_code, o.due_date, ic.flagged,
           o.paid_txn_minor, o.outstanding_txn_minor, o.outstanding_base_minor,
           (o.paid_txn_minor + o.outstanding_txn_minor)::BIGINT   AS total_txn_minor,
           (o.paid_base_minor + o.outstanding_base_minor)::BIGINT AS total_base_minor
      FROM public.invoice_outstanding(
             p_business_id,
             (SELECT pg_catalog.array_agg(ic2.invoice_id) FROM invoice_checked ic2)) o
      JOIN invoice_checked ic ON ic.invoice_id = o.invoice_id
     WHERE o.outstanding_txn_minor <> 0
  ),
  active_plan AS (
    SELECT v.id, v.invoice_id, v.down_payment_minor, v.down_payment_due_date
      FROM visible_plan v
     WHERE v.invoice_id IN (SELECT oi.invoice_id FROM open_invoice oi)
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
  no_plan AS (
    -- THE OPEN INVOICES WHOSE OWN ROW SAYS THEY HAVE NO ACTIVE PLAN.
    --
    -- THIS IS THE REPAIR, AND IT IS ONE WORD WIDE. It used to read
    -- `WHERE NOT EXISTS (SELECT 1 FROM active_plan ap WHERE ...)` -- a question
    -- about what THIS CALLER CAN SEE in `installment_plans`, which under row
    -- security answers "absent" and "invisible" identically and served the
    -- whole outstanding at the single invoice due date for an invisible plan.
    -- It now reads the fact OFF THE INVOICE ROW, which the caller can see
    -- exactly when it can see the invoice this arm would age.
    --
    -- The `NOT EXISTS` is NOT kept as a second condition. It would read as
    -- belt and braces and would be the opposite: it would reintroduce the
    -- relation whose invisibility is the defect, and `unflagged_plan` in
    -- `fact` already refuses the only state in which the two could differ
    -- in that direction.
    SELECT oi.invoice_id, oi.currency_code, oi.due_date,
           oi.outstanding_txn_minor, oi.outstanding_base_minor
      FROM open_invoice oi
     WHERE NOT oi.flagged
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
    --
    --     AND ITS PREMISE IS NO LONGER ASSERTED, BECAUSE IT IS NO LONGER A
    --     PREMISE (section 2c, section 6a; `TL-P4-COORD-R38`). `no_plan` is
    --     keyed on the INVOICE's own `has_active_installment_plan`, read
    --     through the policies that let this caller see the invoice, so an
    --     invisible plan cannot present itself here as an absent one. There is
    --     no guard over `pg_policy` in this file and no function that asks
    --     whether this reader can see what it is reading. The three refusals
    --     that remain are rooted at `invoice_checked` above and are
    --     comparisons of two readings of DATA, not of a policy's properties.
    SELECT n.invoice_id, n.currency_code, n.due_date,
           n.outstanding_txn_minor, n.outstanding_base_minor
      FROM no_plan n
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


-- ── 2b. P4S7-E: THE END STATE, READ FROM THE LIVE CATALOGUES ─────────────
--       (`R-P4-08`; the worked example is `0075:838-945`, and eleven
--       predecessors ship one: `0061`-`0069`, `0072`, `0075`.)
--
-- CHALLENGER H4. The first version of this specification shipped NO end-state
-- self-check: `grep 'DO \$'` over it returned nothing. Everything it claimed
-- about its own policies, grants and DML-emptiness was asserted by a TypeScript
-- suite that no gate, no npm script and no CI workflow names — and challenger
-- C1.b was a policy MISSING from a set that two rounds of readers compared
-- against prose instead of against `0075`'s own declared constant.
--
-- WHY THIS BLOCK AND NOT ANOTHER TEST. A `DO $end$` block travels INSIDE the
-- migration. It needs no gate row, no CI step, no roster entry and no runner
-- window; it refuses AT APPLY TIME, on every cluster, forever, and it reads the
-- LIVE CATALOGUE rather than this file's own statements. It is therefore the
-- one device that converts C1.b, H4, H5 and the structural half of H3 from
-- «asserted by a suite somebody must remember to run» into «cannot be
-- deployed». It is not a substitute for the gates; it is what holds when they
-- are absent.
--
-- THE CLOSED LISTS BELOW ARE COPIED VERBATIM FROM `0075:841-851`, and that is
-- the point of challenger H5: the first version hand-wrote 3 roles x 3
-- privileges where the predecessor declares 8 x 6, omitting `public`, five
-- runtime principals, and `TRUNCATE`, `REFERENCES` and `TRIGGER` — the last
-- being the exact privilege the design's own "the verifier cannot be bypassed"
-- argument depends on, since disabling a trigger requires it. A derived or
-- copied list; never a fresh enumeration.
DO $end$
DECLARE
  c_relations CONSTANT TEXT[] := ARRAY['installment_plans', 'installments'];
  -- `0075:843-846` verbatim. SEVEN names: both relations take the shape of an
  -- accounting-source relation because both are read by a DEFINER validator
  -- (section 2a states why the detail relation takes the header shape here).
  c_source    CONSTANT TEXT[] := ARRAY['accounting_validator', 'business_isolation_delete', 'business_isolation_insert',
                                       'business_isolation_read', 'business_isolation_update', 'inventory_internal_read',
                                       'tenant_membership'];
  -- `0075:848-850` verbatim.
  c_runtime   CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                       'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_dml       CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_column_dml CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'REFERENCES'];
  -- `0075:862-864` verbatim: `P4-AL-06`'s vocabulary. On these two relations it
  -- is proof 7 — NO STORED INSTALMENT OUTSTANDING — refused at apply time
  -- rather than asserted by a reading of the file.
  c_forbidden CONSTANT TEXT := '(^|_)(balance|outstanding|paid|unpaid|due|owed|payable|receivable|settled|refunded|collected|allocated)($|_)';
  c_instant   CONSTANT TEXT := '_(id|ids|at|date|by|status|kind|type|code|name|currency|seq)$';
  c_derived   CONSTANT TEXT := '(^|_)(settled|paid|collected|allocated|refunded)_(at|date)($|_)';
  v_name      TEXT;
  v_role      TEXT;
  v_priv      TEXT;
  v_n         INTEGER;
  v_actual    TEXT[];
BEGIN
  -- 1. BOTH RELATIONS EXIST, row security ENABLED AND FORCED on both, and each
  --    carries tenant_id and business_id as NOT NULL columns (P4-AL-08).
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.oid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: row security is not enabled and forced on both P4-S7 relations (found %)', v_n
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY c_relations LOOP
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull) <> 2 THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: % does not carry tenant_id and business_id as NOT NULL columns', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- PROOF 7, AT APPLY TIME. No stored instalment balance, outstanding, paid
    -- or settled figure, on either relation, ever.
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND (a.attname ~ c_derived
                       OR (a.attname ~ c_forbidden AND a.attname !~ c_instant))) THEN
      RAISE EXCEPTION 'installment.derived_truth_stored: % carries a column of the vocabulary P4-AL-06 refuses', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No floating point anywhere in Phase 4 (P4-AL-15b): money is minor units.
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.atttypid IN ('real'::regtype, 'double precision'::regtype)) THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: % carries a floating-point column', v_name USING ERRCODE = 'P0001';
    END IF;
    -- No counter and no sequence (R-P4-03).
    IF EXISTS (SELECT 1 FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
                WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = ('public.' || v_name)::regclass) THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: % is backed by a sequence', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 2. THE POLICY INVENTORY, read from pg_policy and compared to the WHOLE
  --    declared name set. This is challenger C1.b: a set that is `c_source`
  --    minus one name is not «nearly right», it is a different set, and the
  --    missing name was the one that made a principal's visibility asymmetric.
  FOREACH v_name IN ARRAY c_relations LOOP
    SELECT array_agg(p.polname::TEXT ORDER BY p.polname) INTO v_actual
      FROM pg_policy p WHERE p.polrelid = ('public.' || v_name)::regclass;
    IF v_actual IS DISTINCT FROM c_source THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: the policies on % are %, not the accepted set %', v_name, v_actual, c_source
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- The tenant policy takes the DIRECT form of `0052` on both, not a
  -- correlated subselect into `businesses` (`0075:921-928`'s law).
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
         AND p.polname = 'tenant_membership'
         AND pg_get_expr(p.polqual, p.polrelid) LIKE '%tenant_id%'
         AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%businesses%') <> 2 THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: a tenant_membership policy is not the direct tenant_id form of 0052'
      USING ERRCODE = 'P0001';
  END IF;
  -- AND THE TWO UNCONDITIONAL READS REACH THE PRINCIPALS THEY ARE FOR — the
  -- half challenger C1.c is about. A policy of the right NAME granted to the
  -- wrong role would satisfy the inventory above and leave the asymmetry.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
         AND ((p.polname = 'inventory_internal_read'
               -- `pg_policy.polroles` is `oid[]`, not `regrole[]`: the first
               -- version of this block compared the two and PostgreSQL refused
               -- it with `42883 operator does not exist: oid[] = regrole[]`.
               -- The parser's opinion again, on the very block written to make
               -- the parser the authority.
               AND p.polroles = ARRAY['daftar_inventory_internal'::regrole::oid])
           OR (p.polname = 'accounting_validator'
               AND p.polroles = ARRAY['daftar_accounting_internal'::regrole::oid]))
         AND p.polcmd = 'r' AND pg_get_expr(p.polqual, p.polrelid) = 'true') <> 4 THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the two unconditional SELECT policies are not both present, on both relations, for their own roles'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3. PRIVILEGES. `daftar_app` and both internal principals READ; no runtime
  --    principal and not `public` holds any DML, at either grain (P4-AL-38).
  FOREACH v_name IN ARRAY c_relations LOOP
    FOREACH v_role IN ARRAY ARRAY['daftar_app', 'daftar_inventory_internal', 'daftar_accounting_internal'] LOOP
      IF NOT has_table_privilege(v_role, 'public.' || v_name, 'SELECT') THEN
        RAISE EXCEPTION 'installment.migration_end_state_invalid: % cannot read %', v_role, v_name USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    FOREACH v_role IN ARRAY c_runtime LOOP
      FOREACH v_priv IN ARRAY c_dml LOOP
        IF has_table_privilege(v_role, 'public.' || v_name, v_priv)
           OR (v_priv = ANY (c_column_dml) AND has_any_column_privilege(v_role, 'public.' || v_name, v_priv)) THEN
          RAISE EXCEPTION 'installment.authority_leak: % holds % on %, and this slice ships no writer',
            v_role, v_priv, v_name USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 4. THE TWO CONSTRAINT TRIGGERS, from pg_trigger — which is also the only
  --    thing that can be true if section 3's statements were ordered correctly
  --    (challenger H6's consequence; the TEXT order is asserted by the suite).
  --    DEFERRED, both on the one verifier, and `installments` ON DELETE.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
         AND NOT t.tgisinternal
         AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND t.tgfoid = 'public.installment_schedule_verify()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the two deferred constraint triggers on installment_schedule_verify() are not both present'
      USING ERRCODE = 'P0001';
  END IF;
  -- `tgtype` bit 3 (value 8) is DELETE. The DELETE direction is the one a
  -- prose-only law leaves open, and a schedule can be pushed below the total
  -- by deleting a row.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.installments'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint <> 0 AND (t.tgtype & 8) = 8) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the installments constraint trigger does not fire on DELETE'
      USING ERRCODE = 'P0001';
  END IF;

  -- 5. THE TWO DEFINERS: internal NOLOGIN owner, DEFINER, pinned path. The
  --    verifier has NO EXECUTE grantee beyond its owner; the absence guard is
  --    granted to the two principals that execute the projection and to
  --    nobody else (the P3-S8 definer law, T-05).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = 'public.installment_schedule_verify()'::regprocedure
       AND r.rolname = 'daftar_accounting_internal' AND NOT r.rolcanlogin
       AND p.prosecdef AND p.prorettype = 'trigger'::regtype
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_schedule_verify() is not an internal-owned definer trigger function with the pinned path'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT array_agg(x.grantee::regrole::TEXT ORDER BY 1) INTO v_actual
    FROM pg_proc p, aclexplode(p.proacl) x
   WHERE p.oid = 'public.installment_schedule_verify()'::regprocedure AND x.grantee <> p.proowner;
  IF v_actual IS NOT NULL THEN
    RAISE EXCEPTION 'installment.authority_leak: installment_schedule_verify() has EXECUTE grantees % beyond its owner', v_actual
      USING ERRCODE = 'P0001';
  END IF;
  -- THE TWO FACT ROUTINES OF SECTION 3a, which must be DEFINERS owned by the
  -- internal principal: their soundness depends on their reading NOT being
  -- blinded by an absent session context, which is the asymmetry that makes
  -- direction (d) work (section 3a). Trigger return type, pinned path, and no
  -- EXECUTE grantee beyond the owner.
  FOREACH v_name IN ARRAY ARRAY['installment_plan_fact_sync', 'installment_plan_fact_verify'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = ('public.' || v_name || '()')::regprocedure
         AND r.rolname = 'daftar_accounting_internal' AND NOT r.rolcanlogin
         AND p.prosecdef AND p.prorettype = 'trigger'::regtype
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
    ) THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: % is not an internal-owned definer trigger function with the pinned path', v_name
        USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x.grantee::regrole::TEXT ORDER BY 1) INTO v_actual
      FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid = ('public.' || v_name || '()')::regprocedure AND x.grantee <> p.proowner;
    IF v_actual IS NOT NULL THEN
      RAISE EXCEPTION 'installment.authority_leak: % has EXECUTE grantees % beyond its owner', v_name, v_actual
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- AND THE READ-TIME REFUSAL IS A STABLE INVOKER THAT CAN BE TOLD THREE
  -- NUMBERS AND NOTHING ELSE.
  --
  -- `proargtypes` AND NOT `pronargs`. Round 6 pinned `pronargs = 0` on the
  -- retired guard, on the correct ground that a routine which can be ASKED
  -- about a tenant's rows is an oracle over them whatever its call site does.
  -- That ground is met here by the ARGUMENT TYPES rather than by their
  -- absence: three `bigint`s cannot name a row, a business or a tenant, so the
  -- routine cannot be asked a question about any of them -- while a widening
  -- to `(uuid, uuid, bigint)` would red this block. It is a structural bound
  -- on what the routine can receive, not a substring test on what it contains,
  -- and that distinction is the whole of `TL-P4-COORD-R38`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = 'public.installment_plan_fact_assert(bigint,bigint,bigint)'::regprocedure
       AND r.rolname = 'daftar_accounting_internal' AND NOT r.rolcanlogin
       AND NOT p.prosecdef AND p.provolatile = 's'
       AND p.prorettype = 'boolean'::regtype
       AND p.proargtypes = ARRAY['bigint'::regtype, 'bigint'::regtype, 'bigint'::regtype]::oidvector
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plan_fact_assert is not a STABLE internal-owned INVOKER of exactly three bigints with the pinned path'
      USING ERRCODE = 'P0001';
  END IF;
  -- AND THE RETIRED GUARD IS GONE, not weakened and not kept beside the
  -- column. A retired guard left in place is a second answer to a question
  -- with one answer.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'installment_plan_visibility_assert') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plan_visibility_assert still exists, and a reader that certifies its own visibility is the defect TL-P4-COORD-R38 retired'
      USING ERRCODE = 'P0001';
  END IF;

  -- 6. THE READER OF RECORD IS STILL A READER. `customer_ar_aging` keeps its
  --    exact identity and its exact return shape (section 5.6: `CREATE OR
  --    REPLACE` cannot change a `RETURNS TABLE` at all, so this is belt and
  --    braces against a future DROP-and-CREATE), and it stays INVOKER and
  --    STABLE — never DEFINER, because `R-P4-07` says a reader runs as its
  --    caller, and never IMMUTABLE, because the label is not a clock guard.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure
       AND NOT p.prosecdef AND p.provolatile = 's'
       AND pg_get_function_result(p.oid) = 'TABLE(bucket_no integer, currency_code text, txn_minor bigint, base_minor bigint, invoice_count integer)'
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: customer_ar_aging is not a STABLE INVOKER with the five-column return shape'
      USING ERRCODE = 'P0001';
  END IF;
  -- AND IT HOLDS NO ROUNDING OF ITS OWN: one rounding, consumed from the
  -- canonical law and never re-implemented (R-61, R-81, owner section 21).
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = 'public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure
                AND (p.prosrc NOT LIKE '%supplier_ap_release(%' OR p.prosrc LIKE '%half_even%')) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: customer_ar_aging does not consume the canonical release law, or holds a rounding of its own'
      USING ERRCODE = 'P0001';
  END IF;
  -- AND THE NO-PLAN ARM IS KEYED ON THE INVOICE'S OWN COLUMN, not on a
  -- `NOT EXISTS` over `installment_plans` (challenger C1.a, THIRD round;
  -- `TL-P4-COORD-R38` direction (d)). The installed body must NAME the column
  -- and must NOT carry the retired guard's call.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure
                    AND p.prosrc LIKE '%has_active_installment_plan%'
                    AND p.prosrc LIKE '%installment_plan_fact_assert(%'
                    AND p.prosrc NOT LIKE '%installment_plan_visibility_assert%') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: customer_ar_aging does not age its no-plan arm from the invoice''s own has_active_installment_plan, or still calls the retired visibility guard'
      USING ERRCODE = 'P0001';
  END IF;

  -- 7. THE INVOICE-BORNE FACT ITSELF (section 2c). The column, its type and
  --    its default; the ONE write authority; and that no runtime principal
  --    holds UPDATE on it at either grain.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.invoices'::regclass
                    AND a.attname = 'has_active_installment_plan'
                    AND NOT a.attisdropped AND a.attnotnull
                    AND a.atttypid = 'boolean'::regtype
                    AND pg_get_expr(d.adbin, d.adrelid) = 'false') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: invoices does not carry has_active_installment_plan as a NOT NULL BOOLEAN defaulting to false, which is the base case of section 2c''s induction'
      USING ERRCODE = 'P0001';
  END IF;
  -- THE ONLY UPDATE GRANTEE, and the grant is COLUMN-LEVEL. A table-level
  -- UPDATE on `invoices` would be a widening of everything `0081:649-660`
  -- argues for, so the column grant is asserted and the table grant refused.
  IF NOT has_column_privilege('daftar_accounting_internal', 'public.invoices',
                              'has_active_installment_plan', 'UPDATE') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: daftar_accounting_internal cannot write has_active_installment_plan, so section 3a''s sync can never land and every plan write would be refused'
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF has_column_privilege(v_role, 'public.invoices', 'has_active_installment_plan', 'UPDATE') THEN
      RAISE EXCEPTION 'installment.authority_leak: % holds UPDATE on invoices.has_active_installment_plan, and only the section 3a trigger may write it',
        v_role USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF has_table_privilege('daftar_accounting_internal', 'public.invoices', 'UPDATE') THEN
    RAISE EXCEPTION 'installment.authority_leak: daftar_accounting_internal holds TABLE-level UPDATE on invoices, and section 2c grants one column'
      USING ERRCODE = 'P0001';
  END IF;

  -- 8. THE THREE TRIGGERS THAT MAKE THE FACT TRUE (section 3a). The sync is
  --    an ORDINARY after-row trigger -- not deferred, because it must have run
  --    before the verifier looks -- and the verifier is a DEFERRED CONSTRAINT
  --    trigger on BOTH sides of the fact. Read from `pg_trigger`, which is
  --    also the only thing that can be true if section 3a's statements were
  --    ordered correctly.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint = 0 AND NOT t.tgdeferrable
                    AND t.tgfoid = 'public.installment_plan_fact_sync()'::regprocedure
                    AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the immediate installment_plan_fact_sync trigger is not present on installment_plans for INSERT, DELETE and UPDATE'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = ANY (ARRAY['public.installment_plans'::regclass, 'public.invoices'::regclass])
         AND NOT t.tgisinternal
         AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND t.tgfoid = 'public.installment_plan_fact_verify()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the two deferred constraint triggers on installment_plan_fact_verify() are not both present, one per side of the fact'
      USING ERRCODE = 'P0001';
  END IF;
  -- THE `invoices` SIDE MUST COVER `INSERT` AND NOT ONLY THE COLUMN'S UPDATE.
  -- `tgtype` bit 2 (value 4) is INSERT. `0078:264`'s GRANT INSERT is
  -- table-level, so an invoice can be born carrying the fact, and `UPDATE OF`
  -- alone would leave that route open.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.invoices'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint <> 0
                    AND t.tgfoid = 'public.installment_plan_fact_verify()'::regprocedure
                    AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the invoices-side fact trigger does not fire on INSERT as well as on UPDATE'
      USING ERRCODE = 'P0001';
  END IF;
  -- AND THE PLAN SIDE FIRES ON DELETE. Completing or cancelling a plan is an
  -- UPDATE and removing one is a DELETE, and a DELETE that left the invoice
  -- flagged would silently drop the invoice out of EVERY arm.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint <> 0
                    AND t.tgfoid = 'public.installment_plan_fact_verify()'::regprocedure
                    AND (t.tgtype & 8) = 8) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the plan-side fact trigger does not fire on DELETE'
      USING ERRCODE = 'P0001';
  END IF;
END
$end$;
