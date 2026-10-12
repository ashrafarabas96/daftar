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
  -- THE TENANT EDGE (`TL-P4-COORD-R43`, F2). `0016:10` makes
  -- `businesses (tenant_id, id)` unique and the estate names that key from
  -- SIXTY-TWO foreign keys, `invoices_tenant_fk` (`0075:318`) among them. With
  -- `business_id` already pinned to the invoice's by the key above, this edge
  -- makes `installment_plans.tenant_id` EQUAL to the invoice's tenant by
  -- construction -- which is what the retired deferred obligation (e) of
  -- section 3 was checking late, and what the policies on this relation are
  -- keyed on.
  CONSTRAINT installment_plans_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
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
  -- THE SAME EDGE, for the same reason: `installments_plan_fk` pins this row's
  -- `business_id` to its plan's, so this makes its `tenant_id` the plan's --
  -- and therefore the invoice's -- tenant by construction.
  CONSTRAINT installments_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
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
  'P4-S7 (TL-P4-COORD-R38 direction (d); challenger C1.a, THIRD round). Whether an installment plan with status = ''active'' exists for this invoice. It is LIFECYCLE and not money: no balance, no outstanding, no paid figure and no count of rows (P4-AL-06, challenger M-10) — one bit, carrying exactly the predicate customer_ar_aging''s active_plan CTE applies. It exists because the aging''s no-plan arm must not be keyed on a NOT EXISTS over installment_plans read through the CALLER''s row security: under row security ABSENT and INVISIBLE are one answer, and three rounds of guards that tried to certify the reader''s own visibility all failed, the third by checking policy properties that are not the properties deciding whether a role can see a row. Carried HERE, the fact is read through the very policy evaluation that let the caller see the invoice, so an invisible plan cannot exist for a visible invoice and no guard is needed. Maintained ONLY by installment_plan_fact_sync() on installment_plans, and the value it writes is DERIVED FROM THE HANDED ROW''S STATUS TRANSITION rather than recomputed: installment_plans_one_active_per_invoice_uq admits at most one active plan per invoice, so becoming active determines true, losing active determines false, and a write that does neither determines NOTHING and leaves this column alone. The recomputation over the rows is kept only as a cross-check that may REFUSE (installment.plan_fact_blind) and never decide — TL-P4-COORD-R43 F1-c measured round 9''s construction, where the floor was scoped to the handed row''s assertion while the write it guarded was scoped to the invoice, committing {flag: false, truth: true, plans: 2} from an ordinary re-planned receivable. Any transaction ending with this column and installment_plans in disagreement is REFUSED AT COMMIT by installment_plan_fact_verify(). TWO ROUTES ESCAPE BOTH AND ARE DECLARED RATHER THAN CLAIMED SHUT: TRUNCATE installment_plans fires neither trigger, and a DISABLED trigger is a state and not a hypothesis — each can leave this column disagreeing with the plan relation, which customer_ar_aging refuses at read time as installment.plan_fact_unreadable or installment.plan_fact_unflagged instead of serving a figure. Both are owner-only reachable and assigned to a later round. The only UPDATE privilege on it is the column-level grant to daftar_accounting_internal; daftar_app reads it and cannot write it.';

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
-- `CHECK` cannot express it. THREE CONSTRAINT TRIGGERS — one per relation the
-- equality reads, `invoices` included (`TL-P4-COORD-R43`, F1-d, and item (f)
-- below) — all DEFERRABLE INITIALLY DEFERRED, so a 24-row schedule may be
-- inserted row by row inside one transaction and is judged once at COMMIT:
-- the shape the prep document specified, and the reason an immediate verifier
-- was refused.
--
-- IT CARRIES THE OBLIGATIONS BELOW, AND EACH ONE CLOSES A MEASURED HOLE:
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
--   (f) THE THIRD DIRECTION — `invoices.total_txn_minor` ITSELF — IS NOW AN
--       EVENT OF THIS VERIFIER, BECAUSE RESTING IT ON A PREDECESSOR WAS
--       MEASURED FALSE (`TL-P4-COORD-R43`, F1-d).
--
--       Obligation (a) is an equality between a sum over `installments` and a
--       COLUMN ON `invoices`. Until this round both constraint triggers were
--       on the plan side, and rounds 8 and 9 argued the `invoices` side closed
--       by a predecessor. THE ARGUMENT WAS WRONG IN ITS CONCLUSION, and the
--       counterexample needs no DDL fault, no dropped trigger and no row
--       security blinding:
--
--         build a plan and a LAWFUL schedule against a DRAFT invoice; bump
--         the invoice's `total_txn_minor`; promote it `draft -> open`.
--
--       `0075:561` gates `invoice.posted_amount_immutable` on
--       `OLD.status <> 'draft'`, so a draft invoice's money IS mutable; the
--       two plan-side triggers do not fire on a write to `invoices`; and
--       obligation (a) is never re-judged. The reader's
--       `visible_total <> declared_total` test then refuses
--       `installment.plan_schedule_unreadable` PERMANENTLY, because nothing
--       ever looks at that invoice again. Round 9 introduced that permanence
--       by making `total_txn_minor` load-bearing for the READ (F1-a) while
--       leaving it ungoverned by the WRITE side.
--
--       SO THE SIDES ARE GOVERNED BY ONE SET OF EVENTS NOW. A THIRD deferred
--       constraint trigger, `invoices_installment_schedule_complete`, fires
--       `AFTER UPDATE OF total_txn_minor ON invoices` and judges obligation
--       (a) again for the active plan the invoice's own row says it has. The
--       left-hand side moves only on `installment_plans` / `installments`;
--       the right-hand side moves only on that column; every one of the three
--       is an event of `installment_schedule_verify()`.
--
--       THE THREE PREDECESSOR MECHANISMS ARE KEPT, DEMOTED TO WHAT THEY
--       ACTUALLY BOUND: the RUNTIME roles. None of them bounds the relation's
--       OWNER or the deployment principal, both of which can write the column
--       and insert a draft, which is why they were never a closure:
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
--       SO: CAN AN INSTALLMENT PLAN REFERENCE A DRAFT INVOICE? YES — nothing
--       in this specification or in the frozen estate forbids it, and
--       `installment_plans_invoice_fk` names the invoice without naming its
--       status. The three clauses above say only that no RUNTIME role can
--       create one or amend one. The OWNER of `invoices` and the deployment
--       principal can do both, and a migration-level backfill is exactly such
--       a principal — so «no path produces a draft invoice» was a statement
--       about the application and was read as a statement about the database.
--
--       THE AMENDMENT IS THEREFORE REFUSED BY A TRIGGER OF THIS SLICE'S and
--       not by a privilege of somebody else's. `invoices_installment_schedule_complete`
--       re-judges obligation (a) at COMMIT whenever `total_txn_minor` is
--       written on an invoice whose own row carries
--       `has_active_installment_plan`, so the bump is refused as
--       `installment.schedule_incomplete: (a)` while the schedule is still
--       the old one, and commits when the schedule is corrected in the SAME
--       transaction.
--
--       PATCH REQUEST PR-8 IS STILL OWED AND IS NOT WHAT CLOSED THIS. A
--       status precondition on plan creation — the creating command must
--       refuse an invoice whose status is not `'open'` — is still the right
--       shape and is still not this specification's to write (`P4-AL-38`: this
--       slice ships no writer). It cannot be a FOREIGN KEY, because `status`
--       is mutable (`draft -> open -> void`) and an FK onto a filtered view
--       would be a second truth; and it cannot be a column `CHECK`, because
--       the status lives on the other relation. It remains routed with PR-6.
--       What changed is that the hole no longer DEPENDS on it: a plan against
--       a draft invoice is now a plan whose obligation (a) is re-judged every
--       time that invoice's total moves.
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
  v_flag_now        BOOLEAN;
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
  --
  -- AND `invoices` IS A THIRD SUBJECT NOW (`TL-P4-COORD-R43`, F1-d). Obligation
  -- (a) is an equality between a quantity this slice governs — the schedule —
  -- and a quantity it DID NOT: `invoices.total_txn_minor`. `0075:561` gates the
  -- money immutability of an invoice on `OLD.status <> 'draft'`, so a DRAFT
  -- invoice's `subtotal_txn_minor`, `total_txn_minor` and `total_base_minor`
  -- ARE MUTABLE; and until this round the two constraint triggers below were
  -- `ON installment_plans` and `ON installments`, neither of which fires on a
  -- write to `invoices`. So a plan and a lawful schedule could be built against
  -- a draft invoice, the invoice's money bumped, and the invoice promoted
  -- `draft -> open` with obligation (a) NEVER RE-JUDGED. The reader's
  -- `visible_total <> declared_total` test then refuses
  -- `plan_schedule_unreadable` PERMANENTLY, with no DDL fault and no row
  -- security blinding anywhere — a receivable that can never be aged again.
  --
  -- THE COORDINATOR'S ORDERED DIRECTION 3: the two sides of an equality must be
  -- governed by the SAME SET OF EVENTS. The left-hand side moves only on a
  -- write to `installment_plans` or `installments`; the right-hand side moves
  -- only on a write to `invoices.total_txn_minor`. All three are now events of
  -- this verifier, and the third one is the branch below.
  IF TG_TABLE_NAME = 'installment_plans' THEN
    IF TG_OP = 'DELETE' THEN
      v_business := OLD.business_id;
      v_plan     := OLD.id;
    ELSE
      v_business := NEW.business_id;
      v_plan     := NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'invoices' THEN
    -- `0075`'s `invoices_no_delete` refuses every DELETE on this relation, so
    -- `NEW` is always assigned here.
    v_business := NEW.business_id;
    -- THE FLAG IS RE-READ AND NOT TAKEN FROM `NEW`, and that is the round-5
    -- lesson paid for once already: this is a DEFERRED trigger, so `NEW` is a
    -- snapshot of an event and by COMMIT it may legitimately be stale — bump a
    -- flagged invoice's total and then cancel its plan in the same transaction
    -- and `NEW` still says `true`. The invoice row at COMMIT is the end state,
    -- and `installment_plan_fact_verify()` independently refuses any
    -- transaction whose end state has this column disagreeing with
    -- `installment_plans`. Reading `invoices` is what this routine already
    -- does for `total_txn_minor`, as the unconditional `accounting_validator`
    -- grantee of `0075:457-458`.
    SELECT i.has_active_installment_plan INTO v_flag_now
      FROM public.invoices i
     WHERE i.business_id = NEW.business_id AND i.id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- An invoice with no active plan has no obligation (a) to satisfy. The
    -- FLAG is what says so, read off the governing row, and NOT a count over
    -- `installment_plans` — which is the read this slice has now been told
    -- four times may not decide anything.
    IF NOT v_flag_now THEN RETURN NULL; END IF;
    SELECT p.id INTO v_plan
      FROM public.installment_plans p
     WHERE p.business_id = NEW.business_id AND p.invoice_id = NEW.id AND p.status = 'active';
    -- AND HERE «NOT FOUND» IS A REFUSAL AND NOT AN EMPTY SUBJECT. The invoice's
    -- own row says an active plan exists; if this routine cannot read one, the
    -- fact and the read disagree or this read is blinded. Returning would be
    -- the vacuous pass `0075:439-441` names in the estate's own words.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'installment.schedule_incomplete: (a) invoice %/% carries has_active_installment_plan while this verifier can read no active plan for it, so the total its schedule must equal cannot be judged'
        , v_business, NEW.id USING ERRCODE = 'P0001';
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

  SELECT p.status, p.down_payment_minor, p.invoice_id
    INTO v_status, v_down, v_invoice
    FROM public.installment_plans p
   WHERE p.business_id = v_business AND p.id = v_plan;

  -- A plan deleted inside this transaction implicates nothing: there is no
  -- schedule left to be incomplete. Not a silent pass — an empty subject.
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- ONLY AN ACTIVE PLAN IS BOUND. A completed or cancelled plan is history and
  -- the projection does not read it (`active_plan` filters on status), so
  -- binding it would refuse a legitimate cancellation.
  IF v_status <> 'active' THEN RETURN NULL; END IF;

  SELECT i.total_txn_minor INTO v_total
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

  -- THERE IS NO OBLIGATION (e) ANY MORE, AND ITS STATED REASON WAS FALSE
  -- (`TL-P4-COORD-R43`, F2).
  --
  -- (e) was a DEFERRED comparison of the plan's `tenant_id` against its
  -- invoice's, and against its instalments'. Its justification said that no
  -- composite key existed for a foreign key to name. THAT WAS NOT TRUE, and it
  -- is measurable in the frozen estate: `0016:10` is
  -- `ALTER TABLE businesses ADD CONSTRAINT businesses_tenant_id_uq UNIQUE
  -- (tenant_id, id)`, and `FOREIGN KEY (tenant_id, business_id) REFERENCES
  -- businesses (tenant_id, id)` appears SIXTY-TWO times in the frozen
  -- migrations -- `invoices_tenant_fk` at `0075:318` among them. The edge was
  -- available the whole time; these two relations simply did not carry it.
  --
  -- SO THE EDGE IS CARRIED NOW, by both relations, in section 1 and section 2
  -- (`installment_plans_tenant_fk`, `installments_tenant_fk`), and the
  -- divergence (e) tested for is UNREACHABLE rather than refused late:
  --
  --   * `installment_plans_invoice_fk` pins the plan's `business_id` to its
  --     invoice's, and `installments_plan_fk` pins each instalment's to its
  --     plan's. All three therefore name ONE `business_id`.
  --   * `businesses_tenant_id_uq` makes `(tenant_id, id)` unique and
  --     `businesses` is keyed on `id`, so ONE `business_id` has exactly ONE
  --     `tenant_id`.
  --   * each of the new edges then forces that relation's own `tenant_id` to
  --     be THAT one, and `invoices_tenant_fk` (`0075:318`) already forced the
  --     invoice's.
  --
  -- A deferred check is deleted rather than kept beside the constraint that
  -- subsumes it, for the reason this file states about the retired visibility
  -- guard: a check that can no longer fire is a second answer to a question
  -- that now has one.

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

-- AND THE THIRD SUBJECT: `invoices.total_txn_minor`, the RIGHT-HAND SIDE of
-- obligation (a) (`TL-P4-COORD-R43`, F1-d). `UPDATE OF total_txn_minor` and
-- not a bare `UPDATE`, because that one column is the whole of what this
-- relation contributes to the equality — the status, the due date and the
-- payment history are not operands of it — and a bare `UPDATE` would put a
-- plan lookup on every invoice write in the estate. There is NO `INSERT` arm:
-- `installment_plans_invoice_fk` means no plan can exist for an invoice that
-- is being inserted, so an inserted invoice has no obligation (a) to judge,
-- and an inserted invoice BORN carrying the fact is refused by
-- `invoices_installment_fact_agrees` in section 3a instead.
CREATE CONSTRAINT TRIGGER invoices_installment_schedule_complete
  AFTER UPDATE OF total_txn_minor ON invoices
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
  'P4-S7 (P4-AL-13, R-SAL-06; TL-P4-COORD-R43 F1-d and F2). At COMMIT, for every ACTIVE installment plan touched: down_payment_minor plus the sum of its installments equals the invoice total EXACTLY — one <> comparison, so below and above are refused together and neither direction can be lost by relaxing one inequality; at least one installment row; seq_no contiguous from 1; and at most the declared ceiling of 60 installments. Otherwise installment.schedule_incomplete, naming which of (a) to (d) failed. THREE constraint triggers carry it, one per relation the equality reads: on installment_plans and on installments for INSERT, UPDATE and DELETE — the DELETE arm because a schedule can be pushed below the total by deleting a row — and on invoices for UPDATE OF total_txn_minor, which is the equality''s RIGHT-HAND SIDE and was ungoverned until TL-P4-COORD-R43 F1-d: 0075:561 gates the money immutability of an invoice on OLD.status <> ''draft'', so a draft invoice''s total IS mutable and a plan built against it could be left summing to a total that no longer existed, which the reader then refuses permanently. On the invoices arm the subject is the active plan the invoice''s OWN ROW says it has — has_active_installment_plan is re-read at COMMIT rather than taken from NEW, because a deferred trigger''s handed row can be legitimately stale — and a flagged invoice for which this routine can read no active plan is a REFUSAL, not an empty subject. There is NO obligation (e): the tenant divergence it checked late is now unreachable by construction, through installment_plans_tenant_fk and installments_tenant_fk onto businesses (tenant_id, id) (0016:10), the edge 0075:318 already carries for invoices. It performs NO allocation, reads NO aging, stores nothing, and reads no clock. DEFERRABLE INITIALLY DEFERRED, so a long schedule may be written row by row inside one transaction and is judged once. Internal-owned DEFINER, pinned search_path, no grant; reads only.';

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
-- The `tenant_id` half IS ALSO PINNED, and NOT by this section
-- (`TL-P4-COORD-R46`, F-6, correcting what this paragraph used to claim).
-- `installment_plans_tenant_fk` (`:130`) carries `(tenant_id, business_id)`
-- onto `businesses (tenant_id, id)`, so a plan whose tenant differs from its
-- invoice's names a `(tenant, business)` pair that does not exist. MEASURED,
-- as `daftar_migrator`, both constructions:
--
--   * with `app.tenant_id` set to the divergent tenant, the INSERT is refused
--     `23503` — «violates foreign key constraint
--     "installment_plans_tenant_fk"» — at the statement;
--   * with `app.tenant_id` left at the invoice's own tenant, the INSERT is
--     refused `42501` — «new row violates row-level security policy for table
--     "installment_plans"» — by this relation's own `WITH CHECK`, also at the
--     statement.
--
-- SO THE `ROW_COUNT` CHECK BELOW IS NOT THE REFUSAL OF THE CROSS-TENANT PLAN.
-- This paragraph used to say it was, and said so in terms («IT IS THE
-- REFUSAL»); the tenant edge landed in a later round and the claim was never
-- corrected. The `ROW_COUNT` check is kept for the reason stated at its own
-- site — `ROW_COUNT = 0` must not be allowed to mean «already correct» — and
-- not because it catches this.
--
-- THE OBLIGATION THIS PLACES ON THE FUTURE PLAN WRITER, since this
-- specification ships none (`P4-AL-38`, section 2a): the command that creates,
-- completes or cancels a plan must run with `app.tenant_id` and
-- `app.business_id` set to the invoice's own values. Every application path
-- already does — `0006`'s header states the contract («Context is set
-- per-transaction via set_config(..., true)») — and a migration-level
-- backfill must set them per business. It is not a convention — but the
-- refusal it earns is NOT this section's (`TL-P4-COORD-R46`, F-6). MEASURED:
-- a plan write with no session context at all is refused `42501` by
-- `installment_plans`' own `business_isolation_insert` / `tenant_membership`
-- `WITH CHECK`, UPSTREAM of every trigger here, so it never reaches the fact.
-- `installment.plan_fact_unwritable` is what a writer earns if it somehow
-- reaches this routine and cannot write the invoice row; it is not what the
-- context-less writer sees, and see section 6a entry 7 for what is known about
-- that refusal's reachability at all.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION installment_plan_fact_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business UUID;
  -- THE WRITE SET, AND IT IS DERIVED AND NOT RECOMPUTED (`TL-P4-COORD-R43`,
  -- F1-c). Two parallel arrays: the invoices whose fact THIS ROW'S STATUS
  -- TRANSITION DETERMINES, and the value it determines for each. An invoice
  -- the transition does not determine is NOT IN THE SET and is NOT WRITTEN.
  v_invoices UUID[]    := ARRAY[]::UUID[];
  v_values   BOOLEAN[] := ARRAY[]::BOOLEAN[];
  v_was      BOOLEAN;   -- the handed row WAS active, read from `OLD` alone
  v_is       BOOLEAN;   -- the handed row IS active, read from `NEW` alone
  v_i        INTEGER;
  v_invoice  UUID;
  v_value    BOOLEAN;
  v_state    BOOLEAN;
  v_seen     BOOLEAN;
  v_rows     INTEGER;
BEGIN
  -- `OLD` IS NOT ASSIGNED ON AN INSERT AND `NEW` IS NOT ASSIGNED ON A DELETE,
  -- and plpgsql raises «record "old" is not assigned yet» on the attribute
  -- rather than yielding NULL — so the three cases are branched explicitly
  -- instead of being folded into a `coalesce` or a `CASE`, both of which would
  -- evaluate the unassigned side.
  --
  -- ── THE FACT IS A FUNCTION OF THE HANDED ROW'S TRANSITION, AND OF NOTHING
  --    ELSE (`TL-P4-COORD-R43`, F1-c; the coordinator's ordered direction 1)
  --
  -- Round 9 set a floor from `NEW` and then let a RECOMPUTATION decide the
  -- value, unconditionally, for the handed row's invoice. The floor was scoped
  -- to «the handed row asserts an ACTIVE plan on this invoice» and the write it
  -- guarded was scoped to «this invoice», so a write of a NON-ACTIVE plan row
  -- carried no floor at all and still overwrote the invoice's fact from a
  -- blindable read. That state is ORDINARY, not exotic: a re-planned receivable
  -- carries one `active` plan and one `cancelled` plan on the same invoice,
  -- which `installment_plans_one_active_per_invoice_uq` (`:139-140`) permits
  -- because it is a PARTIAL index. The challenger committed
  -- `{flag: false, truth: true, plans: 2}` by inserting the cancelled row while
  -- the plan relation was hidden, and the read then served the pre-S7 figure.
  --
  -- THE REPAIR IS THAT THE RECOMPUTATION NO LONGER DECIDES ANYTHING. What the
  -- transition determines is DERIVED here, from `NEW.status` and `OLD.status`
  -- and the two `invoice_id`s — fields of records this trigger was HANDED,
  -- which no policy on any relation can hide — and the derivation is TOTAL
  -- because of the partial unique index:
  --
  --     AT MOST ONE ACTIVE PLAN EXISTS PER INVOICE AT ANY TIME.
  --
  -- So «this row became active» DETERMINES `true`, and «this row STOPPED being
  -- active» determines `false` — because the row that stopped was necessarily
  -- the only active one there was. And «this row was not active and is not
  -- active» determines NOTHING: it cannot change whether an active plan exists,
  -- so the correct write set for it is EMPTY. That empty set is the whole of
  -- F1-c's repair, and it holds whether anything is visible or not.
  --
  -- THE INDEX IS THEREFORE LOAD-BEARING FOR THIS DERIVATION and section 2b
  -- part 9 refuses to finish the migration unless it is present, partial and
  -- on exactly `(business_id, invoice_id) WHERE status = 'active'`. A
  -- derivation that rests on a constraint must not rest on a belief that the
  -- constraint is there.
  IF TG_OP = 'INSERT' THEN
    v_business := NEW.business_id;
    v_is := (NEW.status = 'active');
    IF v_is THEN
      v_invoices := ARRAY[NEW.invoice_id];
      v_values   := ARRAY[true];
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_was := (OLD.status = 'active');
    -- A DELETE of the ACTIVE plan determines `false`: by the partial unique
    -- index the row deleted was the only active one, so after this statement
    -- there is none. A DELETE of a non-active plan determines NOTHING.
    IF v_was THEN
      v_invoices := ARRAY[OLD.invoice_id];
      v_values   := ARRAY[false];
    END IF;
  ELSE
    -- A plan may not change business: the old invoice's flag would then live
    -- in a business this statement is not writing, and one write cannot reach
    -- both.
    --
    -- THIS RAISE IS NOT KNOWN TO BE REACHABLE BY ANY PRINCIPAL
    -- (`TL-P4-COORD-R46`, F-6), and that is recorded here rather than implied
    -- by its presence. MEASURED, three principals, one database:
    -- `daftar_migrator` is refused `42501` «new row violates row-level
    -- security policy "business_isolation_update"» before the row is written;
    -- the superuser, which row security does not apply to, is refused `23503`
    -- on `installment_plans_invoice_fk` (no invoice of that id in the target
    -- business) or on `installments_plan_fk` when the plan carries a schedule.
    -- It is KEPT, because a routine that would write a fact into a business
    -- this statement is not writing must say so rather than compute something,
    -- and because the constraints that currently refuse first are not this
    -- routine's to rely on. It is NOT advertised as the refusal of anything.
    IF OLD.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'installment.plan_fact_unwritable: a plan may not move between businesses, because the invoice that carries its fact is keyed on the business'
        USING ERRCODE = 'P0001';
    END IF;
    v_business := NEW.business_id;
    v_was := (OLD.status = 'active');
    v_is  := (NEW.status = 'active');
    IF v_is THEN
      v_invoices := ARRAY[NEW.invoice_id];
      v_values   := ARRAY[true];
    END IF;
    -- BOTH SIDES. `invoice_id` is not immutable today, and an UPDATE that
    -- moves a plan from one invoice to another leaves the OLD invoice flagged
    -- for a plan it no longer has. The old invoice is determined only when
    -- this row STOPPED being that invoice's active plan — by losing `active`,
    -- or by moving away while active.
    IF v_was AND (NOT v_is OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id) THEN
      v_invoices := v_invoices || OLD.invoice_id;
      v_values   := v_values || false;
    END IF;
  END IF;

  -- ---- THE WRITER ASKS ONE QUESTION WHOSE ANSWER IT ALREADY KNOWS
  --      (`TL-P4-COORD-R43`, F1-c prime; the coordinator's ordered direction 2)
  --
  -- F1-c prime: the shipped restrictive read policy plus
  -- `AND current_user <> 'daftar_accounting_internal'` blinds EXACTLY this
  -- routine and nobody else — the one principal whose blindness round 9's floor
  -- could not detect, because the floor compared a blinded read against `NEW`
  -- only on the one transition that carries a positive assertion.
  --
  -- It is detected here WITHOUT asking a visibility question about anybody,
  -- because this question has a KNOWN CORRECT ANSWER. This is an `AFTER ... FOR
  -- EACH ROW` trigger on an INSERT or an UPDATE, so the row in `NEW` EXISTS in
  -- this snapshot: this statement just wrote it. A read of
  -- `installment_plans` by primary key that cannot find it is therefore NOT
  -- evidence about the row — it is proof that THIS ROUTINE'S OWN READS ARE
  -- BLINDED. Nothing is inferred about what a caller can see, and nothing
  -- depends on a policy's text.
  --
  -- IT IS NOT GATED ON THE WRITE SET BEING NON-EMPTY, deliberately. The whole
  -- of F1-c prime is that the transitions carrying no write and no floor are
  -- the ones a blinded writer passed through silently.
  --
  -- AND ITS SCOPE IS STATED EXACTLY, BECAUSE IT WAS ONCE OVERSTATED
  -- (`TL-P4-COORD-R46`, F-3). This probe detects A BLINDING THAT HIDES THE
  -- ROW IT WAS HANDED. It does NOT detect every blinding: a restrictive read
  -- policy predicated on `status <> 'active'` hides exactly the ACTIVE rows,
  -- so the handed row of a NON-ACTIVE transition is still visible here and
  -- the probe PASSES while the recomputation below is blind. MEASURED, as
  -- `daftar_migrator` against `daftar_accounting_internal`'s own read:
  --
  --   * an INSERT of a cancelled plan beside an active one PASSES this probe,
  --     derives an EMPTY write set, never reaches the cross-check, and is then
  --     refused at COMMIT by `installment_plan_fact_verify()` as
  --     `installment.plan_fact_desynchronised`. The transaction is refused;
  --     the harm is the NAME of the refusal and nothing else;
  --   * an INSERT or an UPDATE that would write `true` is refused HERE, under
  --     this name, because such a row IS active and such a row IS hidden;
  --   * and the direction where the flag is ALREADY `false` commits — with the
  --     CORRECT fact, because the EMPTY write set writes nothing. That is the
  --     derivation above doing the work, not this probe, and section 6a entry
  --     7 states which of the two closes which direction.
  --
  -- The earlier claim here — «a blinded writer is refused on every INSERT and
  -- every UPDATE, whatever the transition» — was FALSE, and it is corrected
  -- rather than reworded: a guard whose stated scope exceeds its real scope is
  -- how a correct refusal comes to be removed as redundant.
  --
  -- THE DELETE DIRECTION CANNOT BE PROBED THIS WAY and is not pretended to be:
  -- `OLD`'s row is legitimately gone from this snapshot, so «I cannot see it»
  -- has no known answer. It needs none. The DELETE direction's write set is
  -- derived from `OLD.status` alone and no read enters its value at all, which
  -- is why F1-c's DELETE arm is closed by construction rather than by a probe.
  -- Section 6a entry 7 states this per transition.
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = NEW.business_id AND p.id = NEW.id)
      INTO v_seen;
    IF NOT v_seen THEN
      RAISE EXCEPTION 'installment.plan_fact_blind: this transaction just wrote plan %/% and this writer''s own read of installment_plans by primary key cannot find it, so every read this routine could take is blinded and no fact may be written from one',
        NEW.business_id, NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;

  FOR v_i IN 1 .. coalesce(pg_catalog.array_length(v_invoices, 1), 0) LOOP
    v_invoice := v_invoices[v_i];
    v_value   := v_values[v_i];

    -- ---- THE RECOMPUTATION IS A CROSS-CHECK AND MAY ONLY REFUSE, NEVER
    --      DECIDE (`TL-P4-COORD-R43`, the coordinator's ordered direction 1).
    --
    -- This is the projection's own `active_plan` predicate, and it is a READ of
    -- `installment_plans` taken as this DEFINER's owner — a relation carrying
    -- `FORCE ROW LEVEL SECURITY` (`:170`), so the read is blindable even for
    -- the owner. For four rounds that read DECIDED the fact, and blinded it
    -- decided `false`; the row COMMITTED, nothing revisits a row once its
    -- triggers have fired, and restoring the policy did not restore the flag.
    --
    -- It is kept, and it is kept in the one position where its blindness
    -- cannot become an answer: it is compared against a value this routine
    -- ALREADY HOLDS, derived above from the handed row. A disagreement is
    -- EVIDENCE OF BLINDNESS (or of a dropped unique index), never evidence of
    -- absence, and the only thing this routine does with it is REFUSE.
    --
    -- AND IT IS LOAD-BEARING ON THE INSERT BRANCH TOO, in a case that is NOT
    -- the probe above (`TL-P4-COORD-R46`, F-5). Under a read policy predicated
    -- on `status <> 'active'` the probe PASSES for a non-active row while this
    -- recomputation is blind. Round 9's INSERT branch gave that transition a
    -- write set of «this invoice» with the value taken from the recomputation,
    -- so it wrote `false` beside a live active plan, and the deferred verifier
    -- — blinded the same way — AGREED with it and the transaction COMMITTED
    -- `{flag: false, active plans: 1}`. MEASURED, both bodies, one database:
    -- round 9's commits it, and the body above refuses the same construction
    -- because the derivation gives that transition an EMPTY write set and
    -- writes nothing at all. The empty write set is the mechanism; the probe is
    -- not.
    --
    -- THE SINGLE-STATEMENT MOVE IS NO LONGER JUDGED HERE
    -- (`TL-P4-COORD-R46`, F-4). This cross-check used to DECLARE the
    -- over-strictness «a single statement that moves `active` from one plan to
    -- another plan of the same invoice is refused here», and that declaration
    -- was row-order dependent and misnamed — section 3a-bis records both
    -- measurements. The state is now refused BEFORE the row is written, by
    -- `installment_plan_active_exclusive()`, under
    -- `installment.plan_active_conflict`, in every row order. So the
    -- disagreement this cross-check can still see has exactly the two causes
    -- its message names, and the message is now true of every state that can
    -- reach it.
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = v_business AND p.invoice_id = v_invoice
                      AND p.status = 'active')
      INTO v_state;
    -- AND THE TWO DIRECTIONS OF THE DISAGREEMENT HAVE DIFFERENT CAUSES AND
    -- THEREFORE DIFFERENT NAMES (`TL-P4-COORD-R46`, F-4). This used to be one
    -- refusal under one name with one message, and that message was a FALSE
    -- DIAGNOSIS in one of the two directions. The asymmetry is forced and is
    -- the whole of the repair:
    --
    --   A BLINDED `EXISTS` CAN ONLY READ `false`. So
    --   «derived `false`, recomputed `true`» is NEVER caused by blindness. The
    --   only states that produce it are that ANOTHER plan of this invoice is
    --   genuinely active -- a single statement that moved `active` between two
    --   plans of one invoice, or two active plans coexisting because
    --   `installment_plans_one_active_per_invoice_uq` is gone -- and in both of
    --   them the sentence «another plan of this invoice is active» is TRUE.
    --   That is `installment.plan_active_conflict`, the same name
    --   `installment_plan_active_exclusive()` raises before the row is
    --   written, and naming it the same thing here is what makes the behaviour
    --   DETERMINISTIC IN KIND: MEASURED, with the cancelled row first in the
    --   heap the BEFORE trigger answers, with the ACTIVE row first this does,
    --   and the writer sees ONE name in both orders instead of
    --   `installment.plan_fact_blind` in one and `23505` in the other.
    --
    --   «derived `true`, recomputed `false`» is the other direction and it IS
    --   the blind one: this routine was handed a row that asserts an active
    --   plan and its own read cannot find one. A dropped index cannot produce
    --   it. That keeps `installment.plan_fact_blind`, and its message is now
    --   true of every state that reaches it.
    IF v_state AND NOT v_value THEN
      RAISE EXCEPTION 'installment.plan_active_conflict: the status transition this transaction wrote on invoice %/% determines has_active_installment_plan = false, and a recomputation over installment_plans then found an ACTIVE plan there. A blinded read can only report FALSE, so this is not blindness: another plan of this invoice is active. Either one statement moved active from one plan to another -- cancel the outgoing plan in one statement and activate the incoming plan in a later one -- or installment_plans_one_active_per_invoice_uq is gone and two plans are active at once',
        v_business, v_invoice USING ERRCODE = 'P0001';
    END IF;
    IF v_value AND NOT v_state THEN
      RAISE EXCEPTION 'installment.plan_fact_blind: the status transition this transaction wrote on invoice %/% determines has_active_installment_plan = true, and a recomputation over installment_plans then found no active plan there. This statement just wrote that plan, so the recomputation is blinded rather than the plan absent, and writing from it would commit a fact that can never heal',
        v_business, v_invoice USING ERRCODE = 'P0001';
    END IF;

    -- NO `WHERE has_active_installment_plan IS DISTINCT FROM v_value` GUARD.
    -- It would make `ROW_COUNT = 0` mean either «already correct» or «I could
    -- not reach the row», which are the two answers this routine exists to
    -- tell apart. The cost is one row version per determined invoice, and plan
    -- writes are rare.
    UPDATE public.invoices i SET has_active_installment_plan = v_value
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
    -- ---- THE FIRST TEST READS NO SECOND RELATION AT ALL.
    --
    -- `TL-P4-COORD-R41`, F1-b: the previous version of this routine computed
    -- `v_state` with the SAME blind `EXISTS` the sync used, so the COMMIT-time
    -- check compared a blinded reading against a column written from the same
    -- blinded reading. THEY COULD NOT DISAGREE, which is why thirty-six green
    -- cases could not see it. A verifier whose only test is «does my read
    -- agree with the write that came from my read» verifies nothing.
    --
    -- THE DECISION THEREFORE MOVED TO THE WRITER, and this routine is no
    -- longer where it is taken. `installment_plan_fact_sync()` above now
    -- refuses `installment.plan_fact_blind` when its recomputation contradicts
    -- the row it was handed, so a flag written from a blinded read CANNOT
    -- REACH this verifier: the write is refused before COMMIT. What remains
    -- here is a comparison of two readings, which is a STRENGTHENING of that
    -- floor and not a substitute for it.
    --
    -- A HANDED-ROW FLOOR WAS TRIED HERE AND DOES NOT HOLD, a
    -- limit found by working the repair rather than by asserting it. This
    -- trigger is DEFERRED: the row it was handed is a snapshot of an event,
    -- and by COMMIT that row may legitimately be GONE. INSERT an active plan
    -- and DELETE it again in one transaction and this event still fires, with
    -- `NEW.status = 'active'` and a flag the DELETE's sync correctly set
    -- `false`. A floor applied there would refuse a consistent transaction.
    -- The stale case and the blinded case are INDISTINGUISHABLE without asking
    -- whether the handed row is still visible -- and `installment_plans`
    -- carries `FORCE ROW LEVEL SECURITY` (section 2's `:170`), so NO principal
    -- short of `rolbypassrls` has an unblindable read of it, the owner
    -- included. Asking would be the fifth construction of the retired family.
    --
    -- SO THE FLOOR LIVES ON THE IMMEDIATE SYNC, WHERE IT HAS NO STALENESS
    -- WINDOW -- «this statement just wrote it» is a fact at the moment the
    -- sync runs and a guess at COMMIT -- and this deferred routine carries no
    -- handed-row test at all. It carries the two-reading comparison below,
    -- which degrades to a REFUSAL under blindness in every direction except
    -- `v_flag = false` with a hidden plan, and that one direction is the one
    -- the sync's floor makes unreachable.
    --
    -- This is stated rather than papered over because the enumeration in
    -- section 6a has to be honest about which relations' invisibility is
    -- observable and which is not, and the deferred side of this routine is
    -- one of the places where it is not.

    -- ---- THE SECOND TEST IS THE TWO-READING COMPARISON, AND IT IS KEPT.
    --
    -- It catches what no handed row can: a flag `true` with no plan behind it
    -- (the INSERT route onto `invoices`), and a SECOND plan the handed row
    -- knows nothing about. Blinded, it degrades to `v_state = false`, and
    -- every state it then reports is a REFUSAL rather than a pass -- except
    -- `v_flag = false`, which the test above already covers whenever a handed
    -- row asserts otherwise. It is a strengthening of the first test, never
    -- the only one.
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

-- ── 3a-bis. THE ONE-ACTIVE EXCLUSION, REFUSED AT THE STATEMENT AND UNDER ONE
--           NAME (`TL-P4-COORD-R46`, F-4)
--
-- WHAT WAS WRONG. The cross-check in `installment_plan_fact_sync()` above
-- declared an over-strictness — «a SINGLE STATEMENT that moves `active` from
-- one plan to another plan of the SAME invoice is REFUSED here» — and the
-- declaration was wrong in two measured ways.
--
--   * IT WAS ROW-ORDER DEPENDENT. Fixtures differing only in HEAP ORDER give
--     two different refusals, three repeats each, byte-identical:
--     with the ACTIVE row first in the heap the statement is refused
--     `P0001 installment.plan_fact_blind`; with the CANCELLED row first it is
--     refused `23505` on `installment_plans_one_active_per_invoice_uq`. The
--     reason is mechanical: `AFTER ... FOR EACH ROW` triggers are queued and
--     fired after every row of the statement has been written, while the
--     partial unique index is checked as each row is written. So the index
--     fires first exactly when the incoming row is activated before the
--     outgoing row is cancelled, and the trigger fires first in the other
--     order.
--   * AND `plan_fact_blind` IS A FALSE DIAGNOSIS THERE. Its message says the
--     recomputation «is blinded or `installment_plans_one_active_per_invoice_uq`
--     is gone». In this state no policy was altered and the index is present
--     and partial: the disagreement is caused by the statement itself.
--   * HALF TWO OF THE DECLARATION WAS ALSO WRONG. «The same change in TWO
--     statements commits» holds in ONE of the two orders: `cancel, then
--     activate` commits; `activate, then cancel` was refused `23505` at the
--     FIRST statement, and the declaration did not say which.
--
-- THE REPAIR. The exclusion is judged BEFORE the row is written, by this
-- BEFORE ROW trigger, so one name answers every order:
--
--     a row may not BECOME the active plan of an invoice while another plan
--     is that invoice's active plan IN THIS STATEMENT'S OWN SNAPSHOT.
--
-- AND ONE NAME COMES FROM TWO SITES, WHICH WAS MEASURED RATHER THAN ASSUMED.
-- The first attempt at this repair was this trigger ALONE, on the belief that a
-- query inside a BEFORE trigger cannot see the changes the current command is
-- making. THAT BELIEF IS FALSE and the measurement said so: with the CANCELLED
-- row first in the heap this trigger answers, because the outgoing row is still
-- `active` when the incoming row is judged — but with the ACTIVE row first the
-- outgoing row's `cancelled` IS already visible here, this trigger passes, and
-- the statement went on to be refused `installment.plan_fact_blind` by the
-- sync's AFTER-time cross-check, which is the very false diagnosis F-4 is
-- about.
--
-- SO THE OTHER HALF OF THE REPAIR IS IN THE CROSS-CHECK, where that direction
-- of the disagreement now raises THIS NAME: a blinded `EXISTS` can only read
-- `false`, so «derived false, recomputed true» cannot be blindness and is
-- always another active plan. Between the two sites every row order is refused
-- `installment.plan_active_conflict` — measured, three repeats per order —
-- and `activate, then cancel` in two statements meets the same name here, at
-- the first statement, where it used to meet `23505`.
--
-- `cancel, then activate` in two statements still COMMITS, because by the
-- second statement the outgoing row's `cancelled` is a committed change of an
-- EARLIER command. That is the documented route, it is now the ONLY route, and
-- the refusal says so in its own message rather than leaving the writer to
-- find it here.
--
-- WHAT THIS IS NOT. It is NOT a second answer to the one-active question and
-- it does not replace anything: the read is of `installment_plans`, which
-- carries `FORCE ROW LEVEL SECURITY`, so BLINDED IT READS NOTHING AND PASSES.
-- Behind it stand the two mechanisms that do not depend on a read at all —
-- `installment_plans_one_active_per_invoice_uq` itself, which is physical, and
-- the sync's cross-check, whose message section 3a now states truthfully. This
-- trigger's whole contribution is that the writer who meets the limit is told
-- what the limit IS, under one name, in every row order. A guard that names
-- its cause is the difference between a writer who cancels and re-activates in
-- two statements and a writer who files a bug about a blinded policy that was
-- never touched.
CREATE OR REPLACE FUNCTION installment_plan_active_exclusive() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_other UUID;
BEGIN
  -- Only a row that is BECOMING an invoice's active plan is in scope. A row
  -- that stays active on the same invoice has not become anything, and a row
  -- that is not active cannot conflict with one.
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.invoice_id IS NOT DISTINCT FROM NEW.invoice_id THEN
    RETURN NEW;
  END IF;
  SELECT p.id INTO v_other
    FROM public.installment_plans p
   WHERE p.business_id = NEW.business_id AND p.invoice_id = NEW.invoice_id
     AND p.status = 'active' AND p.id <> NEW.id
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'installment.plan_active_conflict: plan %/% is being made the active installment plan of invoice % while plan % is already that invoice''s active plan in this statement''s own snapshot. At most one plan per invoice may be active, and one statement may not move active from one plan to another: cancel the outgoing plan in one statement and activate the incoming plan in a later one',
      NEW.business_id, NEW.id, NEW.invoice_id, v_other USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
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

-- THE EXCLUSION IS BEFORE, AND THAT IS THE WHOLE POINT: it must have answered
-- before the row is written, which is before the partial unique index is
-- checked and before any AFTER trigger of this statement is fired.
CREATE TRIGGER installment_plans_active_exclusive
  BEFORE INSERT OR UPDATE ON installment_plans
  FOR EACH ROW EXECUTE FUNCTION installment_plan_active_exclusive();

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
REVOKE ALL ON FUNCTION installment_plan_active_exclusive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_plan_fact_sync() TO daftar_accounting_internal;
GRANT EXECUTE ON FUNCTION installment_plan_fact_verify() TO daftar_accounting_internal;
GRANT EXECUTE ON FUNCTION installment_plan_active_exclusive() TO daftar_accounting_internal;
COMMENT ON FUNCTION installment_plan_fact_sync() IS
  'P4-S7 (TL-P4-COORD-R38 direction (d); TL-P4-COORD-R43 F1-c and F1-c-prime). The ONLY writer of invoices.has_active_installment_plan. An ordinary AFTER ROW trigger on installment_plans — not deferred, so the column is right as soon as the statement completes and the deferred verifier has something to check at COMMIT. THE WRITE SET IS DERIVED FROM THE HANDED ROW''S STATUS TRANSITION AND FROM NOTHING ELSE: NEW.status, OLD.status and the two invoice_ids are fields of records this trigger was given, which no policy can hide, and installment_plans_one_active_per_invoice_uq makes the derivation TOTAL — at most one active plan exists per invoice, so a row that BECAME active determines true, a row that LOST active determines false because it was the only active one there was, and a row that was not and is not active determines NOTHING and is NOT WRITTEN. That empty write set is F1-c''s repair: round 9 derived a floor from NEW but let a blindable recomputation decide the value for every transition, so a NON-ACTIVE plan write — the ordinary re-planned receivable, which the PARTIAL unique index permits — carried no floor and still overwrote the fact. THE RECOMPUTATION IS KEPT AND MAY ONLY REFUSE: EXISTS over status = ''active'' is compared against the derived value and a disagreement is never evidence of absence. THE TWO DIRECTIONS CARRY DIFFERENT NAMES BECAUSE THEY HAVE DIFFERENT CAUSES (TL-P4-COORD-R46, F-4): a blinded EXISTS can only read false, so derived-false-recomputed-true cannot be blindness and raises installment.plan_active_conflict -- another plan of this invoice is active, from a single statement that moved active between two plans or from a dropped unique index -- while derived-true-recomputed-false is the blind direction and keeps installment.plan_fact_blind. THE SINGLE-STATEMENT MOVE IS NOT JUDGED HERE ANY MORE (TL-P4-COORD-R46, F-4): installment_plan_active_exclusive() refuses it BEFORE the row is written, as installment.plan_active_conflict, in every row order, because judging it here was row-order dependent and named a blinded policy that had not been touched. AND THE WRITER DETECTS A BLINDING THAT HIDES THE ROW IT WAS HANDED: on every INSERT and UPDATE it reads that row by primary key — a row that exists in this snapshot because this statement just wrote it — and raises installment.plan_fact_blind when it cannot find it, which is F1-c-prime, the one principal round 9''s floor could not watch. ITS SCOPE IS THAT AND NOT MORE (TL-P4-COORD-R46, F-3, correcting a claim that said every INSERT and every UPDATE whatever the transition): a policy predicated on status <> ''active'' leaves a non-active handed row VISIBLE, so the probe passes while the recomputation is blind, and what closes that direction is the EMPTY write set rather than the probe — measured, with round 9''s INSERT branch committing {flag: false, active plans: 1} on exactly that construction and this body refusing it. The DELETE direction carries no such probe and needs none, because no read enters its derived value. It refuses a plan that changes business. It carries NO ''WHERE value IS DISTINCT FROM'' guard, deliberately: ROW_COUNT <> 1 must mean "I could not reach the invoice row" and not "it was already correct", and it RAISES installment.plan_fact_unwritable on it. SECURITY DEFINER owned by daftar_accounting_internal, which holds the unconditional accounting_validator read on both relations and the column-level UPDATE on invoices; the UPDATE still passes through invoices'' own tenant_membership and business_isolation_update policies, so a writer must carry the invoice''s app.tenant_id and app.business_id. Pinned search_path. No EXECUTE grantee but its owner.';
COMMENT ON FUNCTION installment_plan_fact_verify() IS
  'P4-S7 (TL-P4-COORD-R38 direction (d)). The COMMIT-time refusal that makes invoices.has_active_installment_plan true rather than merely maintained. A DEFERRABLE INITIALLY DEFERRED constraint trigger on BOTH sides of the fact: on installment_plans for INSERT, UPDATE and DELETE, and on invoices for INSERT and for UPDATE OF that column — the INSERT arm because 0078:264''s GRANT INSERT ON invoices is table-level and therefore covers a column added later, so an invoice could be born carrying the fact with no plan behind it. It re-derives EXISTS(active plan) and refuses installment.plan_fact_desynchronised on any disagreement, and refuses rather than returning when no invoice carries the fact at all, because returning there is the vacuous pass 0075:439-441 names. Blinded, its EXISTS reads false and every state it then reports is a refusal EXCEPT a flag of false beside a hidden active plan; that one direction is quiet here and is NOT claimed unreachable (TL-P4-COORD-R43 F1-c found round 9 claiming exactly that, falsely). What is true is narrower: after F1-c''s repair a false flag can only be WRITTEN by a transition that DETERMINES false from the handed row, with no read in the value, so the writer cannot produce the state from a blinded read — while TRUNCATE and a disabled trigger still can, and in those states the READ refuses as plan_fact_unflagged. It only READS and RAISES: it writes nothing. SECURITY DEFINER owned by daftar_accounting_internal so that its reading cannot be blinded by an absent session context — the asymmetry that makes this construction sound where round 6''s DEFINER count was not: this routine is never asked what a CALLER can see, and the reader is never asked either, because the fact is on the row. Pinned search_path. No EXECUTE grantee but its owner.';

COMMENT ON FUNCTION installment_plan_active_exclusive() IS
  'P4-S7 (TL-P4-COORD-R46, F-4). The one-active exclusion, refused AT THE STATEMENT and under ONE NAME. A BEFORE INSERT OR UPDATE row trigger on installment_plans: a row may not BECOME an invoice''s active plan while another plan is that invoice''s active plan in this statement''s own snapshot, and it raises installment.plan_active_conflict when one is. It exists because the sync''s AFTER-time cross-check declared this over-strictness and the declaration was ROW-ORDER DEPENDENT and misnamed: AFTER ROW triggers fire after every row of the statement is written while the partial unique index is checked per row, so the active-row-first heap order was refused P0001 installment.plan_fact_blind -- a FALSE diagnosis, no policy altered and the index present -- and the cancelled-row-first order was refused 23505 on installment_plans_one_active_per_invoice_uq. Judging it BEFORE the write makes both orders, and the two-statement activate-then-cancel order, one name; cancel-then-activate in two statements still COMMITS, because the outgoing row''s cancelled status is then a visible change of an earlier command, and that is the documented route. IT IS NOT THE MECHANISM AND DOES NOT REPLACE ONE: its read of installment_plans is blindable by FORCE ROW LEVEL SECURITY and blinded it reads nothing and PASSES, behind which stand the partial unique index, which is physical, and the sync''s cross-check. Its contribution is that the writer who meets the limit is told what the limit is. SECURITY DEFINER owned by daftar_accounting_internal, pinned search_path, no EXECUTE grantee but its owner.';
ALTER FUNCTION installment_plan_fact_sync() OWNER TO daftar_accounting_internal;
ALTER FUNCTION installment_plan_fact_verify() OWNER TO daftar_accounting_internal;
ALTER FUNCTION installment_plan_active_exclusive() OWNER TO daftar_accounting_internal;

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
--   than the defect being repaired. Section 3a's sync refuses to WRITE this
--   state and its deferred verifier refuses to COMMIT it, but a disabled or
--   dropped trigger is a state, not a hypothesis, and a read that serves a
--   double count while in that state is not fail-closed. So the read refuses
--   it too. THIS SENTENCE IS NOT A CLAIM THAT THE STATE IS UNREACHABLE: an
--   earlier draft said «cannot reach COMMIT» and a challenger MEASURED it
--   reaching COMMIT, by blinding the writer's own read (F1-b, now closed in
--   section 3a) and by `TRUNCATE`, which fires neither trigger and is
--   recorded as OPEN at the end of this section.
--
--   plan VISIBLE, schedule PARTLY OR WHOLLY INVISIBLE. `installments` is a
--   second relation with its own policies, and this is the case that was got
--   WRONG by asking it as an existence question. A caller who sees the plan
--   and only SOME of its rows ages a short schedule, and the missing amount
--   lands in the residual at the invoice due date: the totals still telescope
--   (proofs 1 and 4) and the BUCKETS are silently coarsened. The test is
--   therefore ARITHMETIC, not existential -- section 3 obligation (a) makes
--   `down + Σ a_i = invoices.total_txn_minor` EXACT for every active plan, so
--   a visible sum that differs from the invoice's own stored total is proof
--   of rows this caller cannot read, and `amount_txn_minor >= 1` makes every
--   hidden row move that sum. The `visible_schedule` CTE and the second
--   disjunct of `unreadable_schedule` are where this lands.
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
--
-- ======================================================================
-- THE COMPLETENESS ENUMERATION (`TL-P4-COORD-R41`)
-- ======================================================================
--
-- The rule this section is built to, stated by the coordinator after the
-- repair was applied to ONE of the TWO second relations and to NEITHER
-- writer:
--
--     "Carry the fact on the row whose visibility governs the answer" must be
--     applied to EVERY relation whose invisibility can change the answer --
--     and the fact's WRITER must not decide it by a read that can be blinded.
--
-- This is the enumeration that rule asks for, and it is EXHAUSTIVE over the
-- relations `customer_ar_aging` reads, directly or through the one money call.
-- It is written as a completeness check, not as an argument: for each relation
-- it names WHAT MAKES ITS INVISIBILITY OBSERVABLE FROM INSIDE THE CALLER'S OWN
-- VISIBLE SET, and WHERE NOTHING DOES, IT SAYS SO. Four earlier rounds were
-- lost to a check invented in place of that admission.
--
--   1. `invoices` -- READ BY THIS FUNCTION, in `invoice_fact`.
--      Observable: NOT APPLICABLE, AND THIS IS THE FOUNDATION RATHER THAN A
--      GAP. The question this function answers is "age THIS CUSTOMER's open
--      receivables", and the receivables ARE these rows. An invoice the caller
--      cannot see is not a wrong answer about that invoice; it is an answer
--      about a smaller set, which is what row security is for. Every other
--      entry below is observable BECAUSE it is reduced to a disagreement with
--      something read off this relation.
--
--   2. `installment_plans` -- READ BY THIS FUNCTION, in `visible_plan`.
--      Observable: YES, ON THE INVOICE ROW. `invoices.has_active_installment_plan`
--      (section 2c) carries the existence of an active plan, and
--      `unreadable_plan` counts the invoices whose own row says `true` where
--      `visible_plan` has nothing. PARTIAL invisibility of this relation does
--      not exist as a separate case: `installment_plans_one_active_per_invoice_uq`
--      admits at most one active plan per invoice, so per invoice it is
--      all-or-nothing. The converse direction -- a plan visible with the flag
--      `false` -- is `unflagged_plan`.
--
--   3. `installments` -- READ BY THIS FUNCTION, in `visible_schedule` and in
--      `sched`.
--      Observable: YES, BY ARITHMETIC, and this is F1-a's repair. Section 3
--      obligation (a) forces `down + Σ amount_txn_minor = invoices.total_txn_minor`
--      EXACTLY for every active plan, and the right-hand side is a column on
--      the governing invoice row, read in `invoice_fact`. So
--      `unreadable_schedule` compares the caller's own visible sum against the
--      caller's own invoice total. `amount_txn_minor >= 1` (`:153`) makes
--      every hidden row move the sum, so no non-empty hidden subset escapes --
--      the existence test it replaces caught only the all-hidden case.
--
--   4. `invoice_payments` and whatever else `invoice_outstanding()` reads for
--      `paid`, `outstanding` and the base figures.
--      Observable: NOT BY THIS FUNCTION, AND NOT BY ANY CHECK IT COULD CARRY.
--      These figures arrive as the AUTHORITATIVE PAIR from one call
--      (`0084`), and nothing on the invoice row restates them -- that is
--      `P4-AL-06`/M-10 and it is deliberate: a stored balance beside a
--      computed one is two answers to one question. So a caller blinded to
--      part of the payment history gets a LARGER outstanding, aged correctly
--      against the schedule it can see, with the sum and telescoping laws
--      intact. SAID PLAINLY: THIS SLICE DOES NOT DETECT IT. The direction is
--      conservative (over-stated receivable, never under-stated), it is the
--      same exposure every other reader of `invoice_outstanding` has, and it
--      belongs to that function's owner and not here. An arithmetic signature
--      is NOT available, because no second relation is obliged to agree with
--      the pair.
--
--   5. `customers` -- not read. The customer is a PARAMETER, matched against
--      `invoices.customer_id` on the invoice row itself. A caller blind to the
--      customer row still ages the invoices, so this relation cannot change
--      the answer and needs no entry beyond saying so.
--
--   6. `businesses` / `tenant_membership` and the context functions the
--      policies call. Not read by this function; they are the MACHINERY of
--      entry 1 rather than a relation whose invisibility is a separate case.
--      Asking about them is precisely the retired construction
--      (`TL-P4-COORD-R38`), and section 2b asserts their shape AT APPLY TIME
--      from the live catalogue, which is a different question asked by a
--      different principal at a different time.
--
-- AND THE WRITER SIDE OF THE SAME RULE, which `R41` found had been left out
-- entirely:
--
--   7. The WRITER of entry 2's fact -- `installment_plan_fact_sync()`,
--      section 3a.
--      It decided the fact with a `SECURITY DEFINER` `EXISTS` over
--      `installment_plans`, and `installment_plans` is `FORCE ROW LEVEL
--      SECURITY` (`:170`), so that read is blindable even for the owner.
--      Blinded, it wrote `false`, the row COMMITTED, and nothing revisited it
--      -- a silent wrong answer that turned into a permanent refusal.
--
--      ROUND 9'S REPAIR WAS A FLOOR, AND THE FLOOR WAS SCOPED TO THE HANDED
--      ROW'S ASSERTION WHILE THE WRITE IT GUARDED WAS SCOPED TO THE INVOICE
--      (`TL-P4-COORD-R43`, F1-c). A write of a NON-ACTIVE plan row asserted
--      nothing, therefore carried no floor, and still overwrote the invoice's
--      fact from the blindable recomputation. That is the ordinary re-planned
--      receivable -- one `active` plan and one `cancelled` plan on one invoice,
--      which the PARTIAL unique index permits -- and the challenger committed
--      `{flag: false, truth: true, plans: 2}` with it and read back the
--      byte-identical pre-S7 figure.
--
--      CLOSED BY DERIVING THE WRITE SET FROM THE HANDED ROW'S TRANSITION, so
--      the recomputation DECIDES NOTHING and may only REFUSE. Observable per
--      transition, and this table is the honest form of it:
--
--        INSERT, `NEW.status = 'active'`         -> determines `true`.
--        INSERT, otherwise                       -> determines NOTHING; the
--                                                   write set is EMPTY.
--        UPDATE, became or stayed active         -> determines `true`.
--        UPDATE, lost `active`                   -> determines `false`, because
--                                                   the partial unique index
--                                                   makes the row that lost it
--                                                   the only active one there
--                                                   was.
--        UPDATE, moved invoice while active      -> determines `true` for the
--                                                   new invoice and `false` for
--                                                   the old.
--        UPDATE, never active                    -> determines NOTHING.
--        DELETE of the active plan               -> determines `false`.
--        DELETE of a non-active plan             -> determines NOTHING.
--
--      AND THE EARLIER PROSE HERE WAS FALSE AND IS CORRECTED RATHER THAN
--      DEFENDED. Round 9 justified keeping the recomputation as the DECIDER by
--      «a second active plan on the same invoice makes `NEW` alone
--      insufficient». `installment_plans_one_active_per_invoice_uq` (`:139-140`)
--      makes a second ACTIVE plan on one invoice UNREACHABLE, so that reason
--      named a state that cannot exist. The index is what makes the derivation
--      above TOTAL, and section 2b part 9 refuses the migration unless the
--      index is present, unique and partial on exactly
--      `(business_id, invoice_id) WHERE status = 'active'`.
--
--      THE WRITER'S OWN BLINDNESS IS NOW OBSERVABLE TO THE WRITER, which is
--      F1-c prime (`TL-P4-COORD-R43`). The shipped policy text plus
--      `AND current_user <> 'daftar_accounting_internal'` blinds EXACTLY this
--      principal and nobody else, and round 9's floor could not see it on any
--      transition that asserted nothing. The sync now reads the row it was
--      HANDED, by primary key, on every INSERT and every UPDATE: that row
--      exists in this snapshot because this statement just wrote it, so «I
--      cannot find it» has a KNOWN WRONG answer and is proof that this
--      routine's reads are blinded. It REFUSES. No visibility question is
--      asked about any caller and no policy text is inspected.
--
--      THE DELETE DIRECTION CARRIES NO PROBE AND NEEDS NONE: `OLD`'s row is
--      legitimately gone, so «I cannot see it» has no known answer -- and the
--      DELETE write set is derived from `OLD.status` alone, with no read in it.
--
--      AND THE PROBE'S SCOPE IS NARROWER THAN IT WAS CLAIMED TO BE
--      (`TL-P4-COORD-R46`, F-3, and the round-11 step-zero measurement). The
--      probe sees a blinding THAT HIDES THE ROW IT WAS HANDED. A restrictive
--      read policy predicated on `status <> 'active'` hides the ACTIVE rows
--      only, so a NON-ACTIVE handed row stays visible, the probe PASSES, and
--      the recomputation below is blind. MEASURED, as `daftar_migrator`, with
--      `installment_plans` blinded that way for `daftar_accounting_internal`:
--
--        * every transition that would write `true` carries an ACTIVE `NEW`
--          row, so it is HIDDEN and the probe REFUSES it -- measured for the
--          INSERT of an active plan and for the re-activation of a cancelled
--          one, under both a whole-relation and a definer-only version of the
--          policy. `has_active_installment_plan = false` beside a live active
--          plan is therefore NOT REACHABLE through this writer by that route;
--        * the transitions that determine NOTHING pass the probe and commit,
--          and the state they commit is CORRECT, because the EMPTY write set
--          writes nothing;
--        * the INSERT of a cancelled plan beside an ACTIVE one passes the
--          probe, writes nothing, and is refused at COMMIT by entry 8 as
--          `installment.plan_fact_desynchronised` -- a mis-NAMED refusal of a
--          healthy transaction, and no wrong fact.
--
--      SO ON THIS ROUTE IT IS THE DERIVATION AND NOT THE PROBE THAT IS
--      LOAD-BEARING, and that is measured in both directions
--      (`TL-P4-COORD-R46`, F-5): round 9's INSERT branch, planted into this
--      database with the same policy in place, COMMITTED
--      `{flag: false, active plans: 1}` -- the probe passed, the blinded
--      recomputation decided `false`, and entry 8, blinded the same way,
--      AGREED with it. The body of section 3a refuses the identical
--      construction because the transition determines nothing and no `UPDATE`
--      is issued at all. An INSERT-branch reversion is therefore no longer a
--      mutation the suite cannot see.
--
--      WHAT `installment.plan_fact_unwritable` ACTUALLY REFUSES IS NOT KNOWN
--      TO BE REACHABLE (`TL-P4-COORD-R46`, F-6). Both of its raises were
--      advertised elsewhere in this file as the refusal of a state that
--      something else refuses first: the business-change arm is pre-empted by
--      `business_isolation_update` (`42501`) for the writing principal and by
--      `installment_plans_invoice_fk` / `installments_plan_fk` (`23503`) for
--      the superuser, and the `ROW_COUNT` arm's advertised case -- the
--      cross-tenant plan -- is pre-empted by `installment_plans_tenant_fk` or
--      by the plan relation's own `WITH CHECK`. Both raises are KEPT and
--      neither is advertised. Whether any principal can reach either is OPEN.
--
--   8. The DEFERRED VERIFIER of the same fact -- `installment_plan_fact_verify()`.
--      Its blind `EXISTS` was IDENTICAL to the sync's, so the two agreed
--      instead of catching each other. The decision is the WRITER's (entry 7);
--      what is left here is a comparison of two readings, and this entry
--      states what that does and does not cover.
--
--      IT DEGRADES TO A REFUSAL IN EVERY DIRECTION BUT ONE. Blinded, its
--      `EXISTS` reads `false`; a flag of `true` then disagrees and it refuses.
--      The one quiet direction is `v_flag = false` with a hidden active plan.
--
--      AND THAT DIRECTION IS NOT CLAIMED UNREACHABLE HERE. Round 9's text said
--      it was «the direction the sync's floor makes unreachable», and F1-c
--      measured the floor failing to cover the transitions that assert
--      nothing, so that sentence was FALSE. What is true after F1-c's repair is
--      narrower and is all this entry claims: a flag of `false` can now only be
--      WRITTEN by a transition that DETERMINES `false` from the handed row, and
--      no read enters that value -- so the writer can no longer produce this
--      state from a blinded read. It can still be produced by a route that
--      fires neither trigger (`TRUNCATE`, below) or by a disabled trigger, and
--      in those states this verifier is quiet and the READ refuses instead
--      (`plan_fact_unflagged`).
--
--      THE QUIET DIRECTION HAS NOW BEEN EXECUTED, AND IT NEEDS BOTH FAULTS
--      (the round-11 step-zero measurement). With the `status <> 'active'`
--      policy in place and NOTHING ELSE wrong, no wrong fact commits: entry
--      7's probe refuses every transition that would write `true`, so a `false`
--      flag beside an active plan cannot be written in the first place. With
--      the policy in place AND the sync trigger DISABLED, the same write
--      COMMITS `{flag: false, active plans: 1}` -- and the control, the
--      disabled trigger alone, is refused here as
--      `installment.plan_fact_desynchronised`. So the status-predicated policy
--      is what turns this verifier from the backstop of a disabled trigger into
--      a PASS. It is still FAIL-CLOSED one layer out: with both faults removed
--      the READ refuses that receivable by name,
--      `installment.plan_fact_unflagged`, rather than serving a number. The
--      disabled-trigger escape is the one named below and is unchanged in
--      status; what round 11 adds is that this verifier may not be counted on
--      to catch it while a policy of that shape is installed.
--
--      A HANDED-ROW FLOOR WAS TRIED HERE AND DOES NOT HOLD, and that limit is
--      unchanged: this trigger is DEFERRED, so the row it was handed may
--      legitimately be GONE by COMMIT -- insert an active plan and delete it
--      again in one transaction and this event still fires with
--      `NEW.status = 'active'` against a correctly `false` flag. Telling the
--      stale case from the blinded one needs the visibility question itself.
--
--   9. The WRITER of entry 1's own column by the `invoices` route -- a direct
--      `INSERT` or `UPDATE OF has_active_installment_plan`.
--      That writer READS NOTHING: it is handed a value. The route is bounded
--      by AUTHORITY rather than by a check -- the only `UPDATE` privilege on
--      the column is section 2c's column-level grant to a NOLOGIN internal
--      principal, no runtime role holds it at either grain (section 2b part
--      7), and the `INSERT` route is covered by the deferred verifier on this
--      side.
--
--  10. `invoices.total_txn_minor` -- READ BY THIS FUNCTION, in `invoice_fact`
--      as `declared_total`, and MISSING FROM THIS ENUMERATION UNTIL NOW
--      (`TL-P4-COORD-R43`, F4). F1-a made it load-bearing: it is the
--      RIGHT-HAND SIDE of the arithmetic test that detects partial
--      invisibility of entry 3.
--      Observable: NOT APPLICABLE AS A SEPARATE CASE, and for entry 1's
--      reason rather than by assertion -- it is a COLUMN ON THE INVOICE ROW,
--      so it is read through the very policy evaluation that admitted the
--      invoice. There is no state in which the invoice is visible and this
--      column is not. That is why obligation (a) is written against the
--      column and not against `paid + outstanding` from the money call: two
--      correctly derived totals disagreeing would look like a hidden row.
--
--  11. The WRITER of entry 10 -- `invoices_lifecycle_guard()` (`0075:546`)
--      and whatever holds `UPDATE` on that column.
--      Observable: NOT BY VISIBILITY AT ALL, and that is the point -- this is
--      the one entry whose hazard is MUTATION rather than invisibility, and
--      leaving it out of this enumeration is what let F1-d through.
--      `0075:561` gates `invoice.posted_amount_immutable` on
--      `OLD.status <> 'draft'`, so a DRAFT invoice's `total_txn_minor` is
--      MUTABLE, and no runtime role but the relation's owner and the
--      deployment principal can reach it. Until this round nothing re-judged
--      obligation (a) when it moved, so the reader's equality could be
--      falsified from the right-hand side and the invoice refused for ever.
--      CLOSED BY MAKING IT AN EVENT: section 3's third constraint trigger,
--      `invoices_installment_schedule_complete`, re-judges obligation (a)
--      `AFTER UPDATE OF total_txn_minor ON invoices`. Both sides of the
--      equality the read rests on are now governed by one set of events,
--      which is the rule this enumeration exists to check.
--
-- WHAT THIS ENUMERATION LEAVES OPEN, named here so the next reader does not
-- have to find it:
--
--   * `TRUNCATE installment_plans` fires NEITHER trigger of section 3a
--     (measured: `tgtype` 29/29/21), so the flag survives as `true` with zero
--     plans. It FAILS CLOSED at read time -- `unreadable_plan` counts it and
--     the read refuses -- but it misdiagnoses the fault, and it falsifies
--     section 2c's COMMENT a second time. Owner-only reachability. OPEN, and
--     assigned to a later round rather than repaired here.
--   * A DISABLED `installment_plans_fact_sync` TRIGGER beside a read policy
--     predicated on `status <> 'active'`. Either fault alone is refused --
--     the trigger alone by entry 8, the policy alone by entry 7's probe -- and
--     TOGETHER THEY COMMIT a `false` flag beside a live active plan (measured,
--     round 11). It FAILS CLOSED at read time, by name
--     (`plan_fact_unflagged`), and both faults are owner-only DDL. OPEN, with
--     the `TRUNCATE` escape above, rather than repaired here.
--   * Entry 4 is undetectable by construction, as stated there.
--   * CONCURRENCY. Nothing measured to date exercises TWO CONCURRENT plan
--     writers against one invoice. The partial unique index serialises the
--     two `active` inserters, and each writer's cross-check reads its own
--     snapshot; what the loser sees, and whether a serialisation failure can
--     be mistaken for a blinded read, is UNMEASURED. OPEN.
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
  -- THE MESSAGE NAMES WHAT THE STATES ACTUALLY ARE (`TL-P4-COORD-R43`, F3).
  -- Until this round it claimed «no installments row it can read», which is
  -- false in TWO of the THREE states that reach it: the count is one `FILTER`
  -- over a DISJUNCTION, and the arithmetic disjunct fires on a schedule whose
  -- visible sum is BELOW the invoice's declared total (rows hidden) and on one
  -- whose visible sum is ABOVE it (the total moved under a schedule that was
  -- lawful when it was judged -- F1-d's state). A refusal that misnames its
  -- own cause sends the next reader to the wrong relation.
  IF p_unreadable_schedule <> 0 THEN
    RAISE EXCEPTION 'installment.plan_schedule_unreadable: % active installment plan(s) this caller can read do not satisfy section 3 obligation (a) over the rows it can read: either no installments row is readable at all, or the readable down payment plus instalments does not equal this invoice''s own total_txn_minor. Obligation (a) makes that equality EXACT for every active plan, so a difference is proof of instalment rows this caller cannot read, or of an invoice total that moved after the schedule was last judged; the schedule would otherwise be silently coarsened',
      p_unreadable_schedule USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) IS
  'P4-S7 (TL-P4-COORD-R38 direction (d); challenger C1.a, third round). The three refusals customer_ar_aging owes once the no-plan arm is keyed on invoices.has_active_installment_plan instead of on a NOT EXISTS through the caller''s row security. It is NOT a visibility guard and the difference is structural: it READS NOTHING — no relation, no catalogue, no pg_policy, no has_table_privilege, no current_user — and it is TOLD three counts the CALLER computed over the CALLER''s own visible rows rather than asked whether the caller can see anything. Its argument list is exactly three bigints, pinned by proargtypes in section 2b, so it cannot be asked about a row: three numbers name none. SECURITY INVOKER, so it could see nothing the caller cannot see even if it looked. What it refuses: plan_fact_unreadable, an invoice whose own row says it has an active plan while the caller can read none (the silent OMISSION that the column alone would leave); plan_fact_unflagged, a readable active plan whose invoice is not flagged (the DOUBLE COUNT, which section 3a''s deferred verifier already makes unreachable at COMMIT and which this refuses at read time anyway); plan_schedule_unreadable, a readable active plan whose readable down payment plus instalments does not equal the invoice''s own total_txn_minor (or which has no readable installments row at all); section 3 obligation (a) makes that equality exact, so a difference is proof of hidden instalment rows or of a total that moved after the schedule was last judged, and the three states that reach this count are named in the message rather than reduced to the one of them that is about existence. Called at the ROOT of the projection, on invoice_checked, so it is a dependency of every row the reader can return rather than a property of one arm''s plan shape. STABLE; reads nothing; grants nobody anything.';

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
    -- `total_txn_minor` IS READ HERE TOO, AND OFF THE SAME ROW. It is the
    -- RIGHT-HAND SIDE of section 3 obligation (a), so carrying it on the
    -- governing row is the same move as carrying the flag there: the operand
    -- the schedule must add up to cannot be visible when the invoice is not,
    -- and cannot be hidden when the invoice is (`TL-P4-COORD-R41`, F1-a).
    -- It is `invoices.total_txn_minor` (`0075:262`, NOT NULL, >= 1) and NOT
    -- `paid + outstanding` from the money call, because obligation (a) is
    -- written against the COLUMN and the verifier judges it against the
    -- column (`installment_schedule_verify`, section 3). Comparing against a
    -- differently derived total would make a disagreement between two correct
    -- figures look like a hidden row.
    SELECT x.id AS invoice_id, x.has_active_installment_plan AS flagged,
           x.total_txn_minor AS declared_total
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
  visible_schedule AS (
    -- THE VISIBLE SCHEDULE SUM, PER VISIBLE PLAN: the plan's own down payment
    -- plus the `installments` rows THIS CALLER CAN READ. At most one row per
    -- invoice, because `installment_plans_one_active_per_invoice_uq` makes at
    -- most one plan active per invoice, so joining it below multiplies
    -- nothing.
    --
    -- This is a READING, not a question about visibility. It is the left-hand
    -- side of obligation (a) evaluated over the caller's own visible set, and
    -- the comparison in `fact` is between it and a figure read off the
    -- invoice row -- two readings of DATA, which is the one shape this family
    -- permits.
    SELECT v.invoice_id,
           (v.down_payment_minor
              + coalesce((SELECT pg_catalog.sum(n.amount_txn_minor)
                            FROM public.installments n
                           WHERE n.business_id = p_business_id AND n.plan_id = v.id), 0))::BIGINT
             AS visible_total,
           (SELECT pg_catalog.count(*)
              FROM public.installments n2
             WHERE n2.business_id = p_business_id AND n2.plan_id = v.id)::BIGINT
             AS visible_rows
      FROM visible_plan v
  ),
  fact AS (
    -- THE TWO READINGS, COMPARED. One row, always -- an aggregate with no
    -- GROUP BY -- so the assertion below is reached even when every count is
    -- zero and even when there is no invoice at all.
    SELECT pg_catalog.count(*) FILTER (WHERE i.flagged AND v.id IS NULL)::BIGINT          AS unreadable_plan,
           pg_catalog.count(*) FILTER (WHERE NOT i.flagged AND v.id IS NOT NULL)::BIGINT  AS unflagged_plan,
           -- THE SCHEDULE RELATION, JUDGED BY ARITHMETIC AND NOT BY EXISTENCE.
           --
           -- `TL-P4-COORD-R41`, F1-a. This count used to be a bare
           -- existence test over the `installments` relation -- and the
           -- retired shape is DESCRIBED here rather than QUOTED, because
           -- section 2b's ratchet forbids that shape by searching `prosrc`,
           -- and `prosrc` holds this comment too. Quoting it would have made
           -- the ratchet refuse the very body that satisfies it, which is the
           -- SIXTH time in this file that explaining a removal has tripped the
           -- test for the removal. It asked whether ANY instalment row was
           -- visible and never whether
           -- the visible ones ADD UP. One DDL statement hiding SOME of a
           -- schedule -- `AND seq_no < 2` on `installments` -- passed it
           -- 0/0/0 with the plan visible and the flag `true`, and the reader
           -- then served the pre-S7 figure in one coarse band. Existence was
           -- all-or-nothing where the harm is partial, and because it is
           -- value-dependent it was silent.
           --
           -- SECTION 3 OBLIGATION (a) MAKES THE TEST EXACT:
           --
           --     down_payment_minor + Σ amount_txn_minor = invoices.total_txn_minor
           --
           -- for EVERY active plan, refused at COMMIT in BOTH directions by
           -- `installment_schedule_verify()` on `<>` and not `>`. So the
           -- declared schedule of a visible active plan sums to the invoice's
           -- own stored total, EXACTLY -- and a visible sum that differs from
           -- it is arithmetic proof that rows exist which this caller cannot
           -- read. No policy is inspected, no privilege is tested, no
           -- `current_user` is named: two numbers that must be equal are not.
           --
           -- AND IT IS COMPLETE RATHER THAN VALUE-DEPENDENT, which the
           -- existence test was not. `installments.amount_txn_minor` carries
           -- `CHECK (amount_txn_minor >= 1)` (section 2, `:153`), so EVERY
           -- hidden instalment row removes at least one minor unit from
           -- `visible_total`. Hiding any non-empty subset of a schedule
           -- therefore makes the comparison fail -- there is no subset whose
           -- concealment this misses, and no total for which it is quiet.
           --
           -- THE EXISTENCE TEST IS KEPT AS THE FIRST DISJUNCT ANYWAY, and not
           -- as belt and braces: it is what holds if someone ever relaxes
           -- `amount_txn_minor >= 1` to `>= 0`. Under that relaxation a
           -- schedule of zero-amount rows could sum to the total with every
           -- row hidden, and obligation (b)'s «at least one instalment row»
           -- is then the only thing left to notice. Both disjuncts are one
           -- count, so the assertion still takes exactly three arguments and
           -- section 2b still pins it by `proargtypes`.
           pg_catalog.count(*) FILTER (WHERE v.id IS NOT NULL
                                         AND (s.visible_rows = 0
                                              OR s.visible_total <> i.declared_total))::BIGINT
             AS unreadable_schedule
      FROM invoice_fact i
      LEFT JOIN visible_plan v ON v.invoice_id = i.invoice_id
      LEFT JOIN visible_schedule s ON s.invoice_id = i.invoice_id
  ),
  invoice_checked AS (
    -- THE ROOT. Every CTE below reads the invoice set from HERE, so the three
    -- refusals are a dependency of every row this function can return rather
    -- than a property of one arm's plan shape. The assertion is TOLD the three
    -- counts; it reads nothing and can be asked nothing (section 6a).
    --
    -- AN UNCORRELATED SCALAR SUBQUERY AND NOT A `CROSS JOIN`, and that is a
    -- MEASUREMENT and not a preference. The `CROSS JOIN (SELECT assert(...)
    -- FROM fact f) g / WHERE g.ok` spelling was measured by this round's own
    -- run of the live suite's section H to call the routine ONCE PER OPEN
    -- INVOICE -- 3 calls for a customer with three of them -- because the
    -- planner flattens that subquery and the call, taking its arguments from
    -- `f`, becomes a per-output-row expression of the join. Round 6's
    -- zero-argument shape was row-independent and folded to a one-time filter;
    -- the three-argument shape is not, and section 6a's claim that it runs
    -- once was therefore FALSE of this spelling. A SubLink with no outer
    -- reference is planned as an InitPlan and evaluated ONCE per execution of
    -- the query, which is what the claim requires.
    SELECT i.invoice_id, i.flagged
      FROM invoice_fact i
     WHERE (SELECT public.installment_plan_fact_assert(f.unreadable_plan,
                                                       f.unflagged_plan,
                                                       f.unreadable_schedule)
              FROM fact f)
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
  FOREACH v_name IN ARRAY ARRAY['installment_plan_fact_sync', 'installment_plan_fact_verify', 'installment_plan_active_exclusive'] LOOP
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

  -- 6b. THE WRITE-SIDE TEXT RATCHETS, AND WHAT THEY ARE AND ARE NOT
  --      (`TL-P4-COORD-R46`, F-1; the coordinator's structural ruling)
  --
  --      A `prosrc LIKE` TEST CANNOT ESTABLISH A PROPERTY OF CODE. IT
  --      ESTABLISHES THE PRESENCE OF A STRING, AND A COMMENT IS A STRING.
  --
  --      That is the ruling, and it was earned: the previous version of the
  --      first law below was four bare `prosrc LIKE` / `NOT LIKE` tests, and
  --      the round-10 challenger satisfied all four with `NEW.status`,
  --      `OLD.status` and `plan_fact_blind` appearing ONLY INSIDE COMMENTS of
  --      an otherwise round-9 body. The law returned OK and a blinded writer
  --      then COMMITTED `{flag: false, active plans: 1}`. The same four tests
  --      also FALSE-REJECTED a correct body that merely mentioned `v_asserted`
  --      in a comment.
  --
  --      SO THE LOAD-BEARING PROOF OF THIS PROPERTY IS NOT HERE AND CANNOT BE.
  --      The property is BEHAVIOURAL -- «the value written is derived from the
  --      handed row and not decided by a blindable read» -- and the honest
  --      instrument for a behavioural property is EXECUTION: plant the
  --      defective body, blind the relation, and require the specific refusal.
  --      That needs a plan, an invoice and the invoice's whole foreign-key
  --      closure, so it belongs in a suite with a fixture and NOT in a
  --      migration's end-state block, which has neither. It is
  --      `tests/integration/phase4-s7-installment-fact-db.test.ts`, which
  --      reads the body THIS FILE INSTALLS out of `pg_proc`, plants round 8's
  --      and round 9's bodies beside it, and requires
  --      `installment.plan_fact_blind` from the shipped one and a COMMITTED
  --      wrong fact from each predecessor -- under whole-relation blinding,
  --      under definer-only blinding, and under the `status <> 'active'`
  --      blinding that leaves the writer's probe passing. A body whose tokens
  --      live in comments is round 9's body to that suite, because the suite
  --      runs it.
  --
  --      WHAT REMAINS HERE IS A TEXT RATCHET, STATED AS ONE. It asserts THE
  --      PRESENCE OF A STRING IN THE CODE OF THE INSTALLED BODY -- the
  --      comments are STRIPPED first, so the exact defeat measured above no
  --      longer works and the false rejection no longer fires -- and it is not
  --      the thing standing between round 9's construction and a commit. A
  --      body that places the tokens in dead code still satisfies it, and
  --      that is not a hole to patch with a cleverer pattern: it is the limit
  --      of the instrument, which is why the execution proof exists.
  --
  --      Comment stripping also removes a `--` sequence inside a string
  --      literal, which is why neither token tested below is one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL (SELECT pg_catalog.regexp_replace(
                        pg_catalog.regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gns'),
                        '--[^' || chr(10) || ']*', ' ', 'g') AS code) c
     WHERE p.oid = 'public.installment_plan_fact_sync()'::regprocedure
       AND c.code LIKE '%plan_fact_blind%'
       AND c.code LIKE '%NEW.status%'
       AND c.code LIKE '%OLD.status%'
       AND c.code NOT LIKE '%v_asserted%') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the CODE of installment_plan_fact_sync, with its comments stripped, does not name NEW.status and OLD.status and the installment.plan_fact_blind refusal, or still names round 9''s v_asserted floor. This is a PRESENCE-OF-STRING test and nothing more: the behavioural proof that the write set is DERIVED rather than recomputed is the execution proof in tests/integration/phase4-s7-installment-fact-db.test.ts, which plants the pre-repair bodies and requires the refusal'
      USING ERRCODE = 'P0001';
  END IF;
  --     F1-a, AND IT IS THE SAME KIND OF TEST AS THE ONE ABOVE. The schedule
  --     relation is judged by ARITHMETIC and not by existence, and this
  --     asserts THE PRESENCE OF THREE STRINGS in the installed reader --
  --     comments stripped, for the reason just given. The behavioural proof
  --     is again execution: §F1-a of the same suite hides each half of one
  --     schedule, measures the ROUND-8 reader serving a silently coarsened
  --     figure, and requires `installment.plan_schedule_unreadable` from the
  --     shipped one. `customer_ar_aging` is a `LANGUAGE sql` body, so a
  --     stripped `--` inside a literal is the only hazard and none of the
  --     three tokens is one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL (SELECT pg_catalog.regexp_replace(
                        pg_catalog.regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gns'),
                        '--[^' || chr(10) || ']*', ' ', 'g') AS code) c
     WHERE p.oid = 'public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure
       AND c.code LIKE '%visible_schedule%'
       AND c.code LIKE '%declared_total%'
       AND c.code NOT LIKE '%NOT EXISTS (SELECT 1 FROM public.installments%') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: customer_ar_aging does not compare the caller''s visible schedule sum against invoices.total_txn_minor, or still asks the retired existence question about installments, which section 3 obligation (a) makes exact and which partial schedule invisibility defeats'
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
  -- THE `invoices` SIDE MUST COVER `INSERT` AND NOT ONLY THE COLUMN'S UPDATE,
  -- AND THE COLUMN IS PINNED (`TL-P4-COORD-R46`, F-2, applied to every law in
  -- this block that names a column in prose): an `UPDATE OF` pointed at some
  -- OTHER column would leave this column's own writes unjudged and would look
  -- identical to a bitmask test.
  -- `tgtype` bit 2 (value 4) is INSERT. `0078:264`'s GRANT INSERT is
  -- table-level, so an invoice can be born carrying the fact, and `UPDATE OF`
  -- alone would leave that route open.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.invoices'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint <> 0
                    AND t.tgfoid = 'public.installment_plan_fact_verify()'::regprocedure
                    AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16
                    AND (SELECT pg_catalog.array_agg(a.attname::TEXT ORDER BY a.attname)
                           FROM pg_catalog.unnest(t.tgattr::SMALLINT[]) k
                           JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k)
                         = ARRAY['has_active_installment_plan']) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the invoices-side fact trigger does not fire on INSERT as well as on UPDATE, or its tgattr column set is not exactly {has_active_installment_plan}'
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

  -- 9. THE CONSTRAINT THE WRITE-SET DERIVATION RESTS ON (`TL-P4-COORD-R43`,
  --    F1-c). `installment_plan_fact_sync()` derives the fact from the handed
  --    row's status transition, and that derivation is TOTAL only because at
  --    most one ACTIVE plan can exist per invoice: it is what makes «this row
  --    lost `active`» determine `false`. A derivation that rests on a
  --    constraint must not rest on a belief that the constraint is there, so
  --    the index is read from the catalogue -- UNIQUE, and PARTIAL on exactly
  --    `status = 'active'`, because a non-partial one would forbid a cancelled
  --    plan beside an active one and a differently predicated one would not
  --    bound the active count at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x
      JOIN pg_class c ON c.oid = x.indexrelid
     WHERE x.indrelid = 'public.installment_plans'::regclass
       AND c.relname = 'installment_plans_one_active_per_invoice_uq'
       AND x.indisunique AND x.indpred IS NOT NULL
       AND pg_get_expr(x.indpred, x.indrelid) = '(status = ''active''::text)'
       AND pg_get_indexdef(x.indexrelid) LIKE '%(business_id, invoice_id)%'
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plans_one_active_per_invoice_uq is not a UNIQUE index on (business_id, invoice_id) partial on status = ''active'', and installment_plan_fact_sync derives the invoice-borne fact from the handed row on the strength of exactly that bound'
      USING ERRCODE = 'P0001';
  END IF;

  -- 10. THE THIRD SCHEDULE-COMPLETENESS TRIGGER, ON `invoices`
  --     (`TL-P4-COORD-R43`, F1-d). Obligation (a) is an equality, and its
  --     right-hand side is `invoices.total_txn_minor`. `0075:561` gates the
  --     money immutability of an invoice on `OLD.status <> 'draft'`, so that
  --     column IS mutable on a draft; with only the two plan-side triggers the
  --     equality could be falsified from the right and the invoice refused by
  --     the reader for ever.
--
--     AND IT PINS THE COLUMN, WHICH IS WHAT IT DID NOT DO
--     (`TL-P4-COORD-R46`, F-2). This law used to test `tgtype & 16` alone,
--     i.e. «this is an UPDATE trigger», while its own comment claimed the
--     right-hand side of obligation (a). `tgattr` appeared NOWHERE in this
--     file. The round-10 challenger re-pointed the trigger at
--     `AFTER UPDATE OF due_date ON invoices`, this law still reported OK, and
--     F1-d's hole re-opened with the end state certifying itself sound: a
--     flagged invoice's money moved 900000 -> 1000000 and the promotion
--     `draft -> open` COMMITTED with the schedule still at 900000, after
--     which the reader refuses `plan_schedule_unreadable` for ever.
--
--     `tgattr` IS THE COLUMN LIST OF AN `UPDATE OF`, held as attribute
--     numbers, so it is resolved against `pg_attribute` and compared as a SET
--     OF NAMES -- not as a bitmask, not as a count, and not against a number
--     a later column drop would renumber. Part 9 already reads `indpred` and
--     part 11 `pg_get_constraintdef`; this was the one law of the three that
--     did not read what its comment claimed. `tgtype` bit 4 (value 16) is
--     UPDATE, and the trigger must be UPDATE-ONLY, so bits 2 and 3 are
--     refused too.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.invoices'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
                    AND t.tgfoid = 'public.installment_schedule_verify()'::regprocedure
                    AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0 AND (t.tgtype & 8) = 0
                    AND (SELECT pg_catalog.array_agg(a.attname::TEXT ORDER BY a.attname)
                           FROM pg_catalog.unnest(t.tgattr::SMALLINT[]) k
                           JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k)
                         = ARRAY['total_txn_minor']) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: invoices carries no deferred UPDATE-only constraint trigger on installment_schedule_verify() whose tgattr column set is exactly {total_txn_minor}, so obligation (a)''s right-hand side is either ungoverned or governed by the wrong column''s events'
      USING ERRCODE = 'P0001';
  END IF;

  -- 12. THE ONE-ACTIVE EXCLUSION IS JUDGED **BEFORE** THE ROW IS WRITTEN
  --     (`TL-P4-COORD-R46`, F-4). Section 3a-bis's whole claim is that ONE
  --     NAME answers EVERY row order, and that claim rests on WHEN the trigger
  --     fires: an `AFTER` row trigger fires once every row of the statement
  --     has been written, by which time the partial unique index has already
  --     refused one of the two orders under its own name. So the TIMING is
  --     read from the catalogue rather than believed from the statement that
  --     created it. `tgtype` bit 0 (value 1) is ROW, bit 1 (value 2) is
  --     BEFORE, bit 2 (value 4) is INSERT, bit 3 (value 8) is DELETE, bit 4
  --     (value 16) is UPDATE: INSERT and UPDATE are required, DELETE is
  --     refused because a deleted row cannot become anything, and it must be
  --     an ORDINARY row trigger rather than a deferrable constraint one --
  --     a deferred answer is exactly the answer this repair replaces.
  --
  --     THE WHOLE `UPDATE` IS COVERED AND NO `UPDATE OF` NARROWS IT, which is
  --     the one place in this block where an EMPTY `tgattr` is the assertion:
  --     a row becomes an invoice's active plan by changing `status` OR by
  --     changing `invoice_id`, so a column list would have to name both and
  --     would be one more thing to get wrong.
  --
  --     MEASURED, because the obvious spelling is wrong: for an unqualified
  --     `UPDATE` the `tgattr` vector is EMPTY and
  --     `array_length(tgattr::SMALLINT[], 1)` is **0**, not NULL -- PostgreSQL
  --     18.4, `tgtype` 23 for `BEFORE INSERT OR UPDATE ... FOR EACH ROW` and
  --     `tgattr` `''`. An `IS NULL` test here reds a correct trigger.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
                    AND t.tgconstraint = 0 AND NOT t.tgdeferrable
                    AND t.tgfoid = 'public.installment_plan_active_exclusive()'::regprocedure
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2
                    AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16 AND (t.tgtype & 8) = 0
                    AND pg_catalog.array_length(t.tgattr::SMALLINT[], 1) = 0) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plans carries no BEFORE INSERT OR UPDATE row trigger on installment_plan_active_exclusive() over the whole row, so the one-active exclusion is not judged before the row is written and its refusal is row-order dependent again'
      USING ERRCODE = 'P0001';
  END IF;

  -- 11. AND OBLIGATION (e) IS GONE, REPLACED BY THE STRUCTURAL EDGE
  --     (`TL-P4-COORD-R43`, F2). Its stated reason -- that no composite key
  --     existed for a foreign key to name -- was false: `0016:10` is
  --     `businesses (tenant_id, id) UNIQUE` and `0075:318` already names it.
  --     Both relations now carry the edge, so the tenant divergence (e)
  --     checked LATE is unreachable, and the late check is deleted rather than
  --     kept beside the constraint that subsumes it.
  FOREACH v_name IN ARRAY c_relations LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k
       WHERE k.conrelid = ('public.' || v_name)::regclass
         AND k.contype = 'f'
         AND k.confrelid = 'public.businesses'::regclass
         AND pg_get_constraintdef(k.oid) = 'FOREIGN KEY (tenant_id, business_id) REFERENCES businesses(tenant_id, id)'
    ) THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: % carries no tenant edge onto businesses (tenant_id, id), so its tenant_id can diverge from its invoice''s while every policy on it is keyed on tenant_id', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = 'public.installment_schedule_verify()'::regprocedure
                AND p.prosrc LIKE '%(e) the plan tenant%') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_schedule_verify still carries the retired deferred obligation (e), which the tenant edges make unreachable and which is therefore a second answer to a question with one'
      USING ERRCODE = 'P0001';
  END IF;
END
$end$;
