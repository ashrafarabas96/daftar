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
-- │ WHAT THIS FILE IS, MEASURED (round 16; `TL-P4-COORD-R63` items 2, 3):    │
-- │                                                                          │
-- │  * IT IS APPLIED, PARSED AND EXECUTED. FOUR integration suites execute   │
-- │    the whole of this file against a real PostgreSQL cluster, each with   │
-- │    its own principal: `phase4-s7-installment-aging-db.test.ts` (as       │
-- │    `daftar_migrator`, which is not a superuser and does not bypass row   │
-- │    security), `phase4-s7-installment-fact-db.test.ts`,                   │
-- │    `phase4-s7-installment-concurrency-db.test.ts`, and                   │
-- │    `phase4-s7-installment-aging-live.test.ts` (as the routines' owner,   │
-- │    against a real invoice committed through `POST /v1/sales`). So the    │
-- │    parser has had its opinion: `installment_schedule_verify()` is        │
-- │    COMPILED and not merely written, and the aging-db suite reads its     │
-- │    `prosecdef` and its owner out of `pg_proc` to say so.                 │
-- │  * THE CONSTRAINT TRIGGERS FIRE, AND THERE ARE NOT TWO OF THEM. FIVE     │
-- │    `CREATE CONSTRAINT TRIGGER` statements are below: THREE run           │
-- │    `installment_schedule_verify()`, one per relation the equality reads  │
-- │    (`installment_plans`, `installments`, `invoices`), and two run the    │
-- │    fact verifier. The live suite fires the schedule three in every       │
-- │    direction the sum can be broken -- below the total, above it, a row   │
-- │    DELETED out of a complete schedule, a non-contiguous `seq_no` -- AT   │
-- │    COMMIT and not at the statement, and the concurrency suite fires      │
-- │    them with the deferral removed by `SET CONSTRAINTS ALL IMMEDIATE`.    │
-- │    «At the DATABASE level, not in TypeScript only» is therefore MET for  │
-- │    those obligations, and the 265-day counterexample runs THROUGH this   │
-- │    routine in PostgreSQL (live suite section E) and not only against     │
-- │    the reference model.                                                  │
-- │  * WHAT IS STILL `SPEC ONLY`, AND IT IS NOT NOTHING. Those suites are    │
-- │    the only thing that applies this file. It carries no migration        │
-- │    number, it is not in `migrations/`, it is not in the manifest, and    │
-- │    nothing here is applied by `npm run migrate` -- NO DEPLOYED CLUSTER   │
-- │    CARRIES ANY OF IT. S7 is CHALLENGER REJECTED with                     │
-- │    `READY_TO_PROMOTE = NO`.                                              │
-- │  * TWO authority/command changes that are NOT the author's to make --    │
-- │    and the first is PRE-APPLIED in every fixture and disclosed, which    │
-- │    makes every aging figure measured here CONDITIONAL on it: PR-6, the   │
-- │    `GRANT EXECUTE` on `supplier_ap_release` (section 5), and PR-8, the   │
-- │    plan-creation status precondition (section 3(f)).                     │
-- │  * STILL UNMEASURED, named rather than left to be found: the PHYSICAL    │
-- │    half of the index gap, whose decider is `REINDEX` at apply time and   │
-- │    in CI (section 3); `TRUNCATE installment_plans`, declared and with    │
-- │    no instrument; and the reachability of an unenforcing index state by  │
-- │    any route that is not a superuser writing `pg_index`.                 │
-- │  * A SPECIFICATION IS DESIGN UNTIL A PARSER HAS HAD AN OPINION           │
-- │    (challenger S7-1, CRITICAL). It has had one. AND THIS PARAGRAPH IS    │
-- │    ITSELF UNDER A TEST NOW: `phase4-s7-installment-aging.test.ts` in     │
-- │    `packages/domain-core/test`, law H16, reads these readiness claims,   │
-- │    refuses the ones that contradict what the suites measure, and         │
-- │    refuses a paragraph that retreats into vagueness instead. It is       │
-- │    under one because what stood here was false for fifteen rounds and    │
-- │    five challengers, while every other text law of this file looked      │
-- │    outward and none looked at its own header. H16 will not accept the    │
-- │    old sentences even as a quotation of themselves, so what they said    │
-- │    is in `P4-S7-R16-AUTHOR-*.md` and not here.                           │
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
  'P4-S7 (TL-P4-COORD-R38 direction (d); challenger C1.a, THIRD round). Whether an installment plan with status = ''active'' exists for this invoice. It is LIFECYCLE and not money: no balance, no outstanding, no paid figure and no count of rows (P4-AL-06, challenger M-10) — one bit, carrying exactly the predicate customer_ar_aging''s active_plan CTE applies. It exists because the aging''s no-plan arm must not be keyed on a NOT EXISTS over installment_plans read through the CALLER''s row security: under row security ABSENT and INVISIBLE are one answer, and three rounds of guards that tried to certify the reader''s own visibility all failed, the third by checking policy properties that are not the properties deciding whether a role can see a row. Carried HERE, the fact is read through the very policy evaluation that let the caller see the invoice, so an invisible plan cannot exist for a visible invoice and no guard is needed. Maintained ONLY by installment_plan_fact_sync() on installment_plans, and the value it writes is DERIVED FROM THE HANDED ROW''S STATUS TRANSITION rather than recomputed: installment_plans_one_active_per_invoice_uq admits at most one active plan per invoice, so becoming active determines true, losing active determines false, and a write that does neither determines NOTHING and leaves this column alone. The recomputation over the rows is kept only as a cross-check that may REFUSE (installment.plan_fact_blind) and never decide — TL-P4-COORD-R43 F1-c measured round 9''s construction, where the floor was scoped to the handed row''s assertion while the write it guarded was scoped to the invoice, committing {flag: false, truth: true, plans: 2} from an ordinary re-planned receivable. Any transaction ending with this column and installment_plans in disagreement is REFUSED AT COMMIT by installment_plan_fact_verify(). TWO ROUTES ESCAPE BOTH AND ARE DECLARED RATHER THAN CLAIMED SHUT: TRUNCATE installment_plans fires neither trigger, and a DISABLED trigger is a state and not a hypothesis — each can leave this column disagreeing with the plan relation, which customer_ar_aging refuses at read time as installment.plan_fact_unreadable or installment.plan_fact_unflagged instead of serving a figure. Both are owner-only reachable, and «owner-only» is now a MEASUREMENT and not a belief: session_replication_role — which would silence every trigger in a session with no DDL at all — is a superuser-context GUC, and daftar_app and daftar_migrator are each refused 42501 permission denied to set parameter on SET, SET LOCAL and set_config, both directly and after SET ROLE daftar_accounting_internal. THE DISABLED-TRIGGER ROUTE WAS ALSO BEING CERTIFIED ABSENT WHILE IT WAS DECLARED OPEN, WHICH IS THE PART THAT WAS WRONG (TL-P4-COORD-R50 ordered item 3, F-2): tgenabled occurred ZERO times in this specification, so all seven triggers could be disabled and the 29-raise apply-time ratchet still reported OK, and one statement — ALTER TABLE installment_plans DISABLE TRIGGER USER — committed {flag: false, active plan: 1} with no policy fault at all. tgenabled is now read as catalogue DATA in TWO places: section 2b part 9b refuses to finish the migration unless all seven carry tgenabled = ''O'', and customer_ar_aging''s fifth count refuses installment.plan_fact_untrusted at read time when one of the seven is missing or not enabled. A slice may declare an escape it does not close; it may not also certify that the escape is not taken. TRUNCATE remains declared and unmeasured. The only UPDATE privilege on it is the column-level grant to daftar_accounting_internal; daftar_app reads it and cannot write it.';

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
  v_unenforcing     TEXT;
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

  -- ---- BEFORE (a), (b) OR (c) REFUSES ON A FIGURE, THE INDEXES OF BOTH
  --      RELATIONS ARE READ (`TL-P4-COORD-R59` ordered item 8, F14-9).
  --
  -- THE SCOPE IS (a), (b) AND (c), AND NOT (d), AND NOT EVERY EXIT ABOVE --
  -- NARROWED BY MEASUREMENT IN ROUND 16 (`TL-P4-COORD-R63` item 5, F15-4).
  -- The earlier heading said «any of (a) to (d)» and the refusal below said
  -- «no obligation of this slice», and both claimed more than this gate
  -- reads. Measured as byte offsets into this routine's own body -- which is
  -- byte-identical to its stored `prosrc`, as the `c_bodies` digests of part
  -- 9 certify -- the gate's `IF` is at 14235 and it is reached by NONE of:
  --   * the `invoices`-arm refusal of (a) at 5100, which fires when the
  --     invoice row says a plan is active and this routine can read none. It
  --     states «the fact and the read disagree or this read is blinded» and
  --     reads no flag, so it does not name the cause this gate exists for;
  --   * the FOUR `RETURN NULL` exits above it -- the invoice row not read
  --     (4241), the flag read false (4557), the plan row not read (5919) and
  --     the plan not active (6172) -- each of which is an EMPTY SUBJECT
  --     rather than a judgement, but the THIRD of which is also a vacuous
  --     pass of all four obligations, taken on a primary-key read of the plan
  --     row that this gate's own message names as a premise and that this
  --     gate sits BELOW. ROUND 16 ENUMERATED THREE AND THERE ARE FOUR
  --     (`TL-P4-COORD-R69` item 3, R16-3): the `IF v_status <> 'active'`
  --     exit at 6172 was unlisted, and that count had already moved three
  --     times, every time because it was taken from a SENTENCE rather than
  --     from this body. IT IS TAKEN FROM THE BODY NOW, AND SO ARE THE
  --     NUMBERS (`TL-P4-COORD-R69` item 5, R16-6): law H17 of
  --     `packages/domain-core/test/phase4-s7-installment-aging.test.ts`
  --     derives every offset in this paragraph and the exit COUNT out of
  --     this routine's own dollar-quoted body and reds when any of them
  --     disagrees with it, so an edit
  --     that moves these numbers reds there instead of leaving them silently
  --     stale -- which is the hole round 16 named in its own report and
  --     could only name;
  --   * obligation (d) at 25769, whose ceiling is not one of the four
  --     conditions of the `IF` -- the string `60` does not occur in it.
  -- The `RAISE` the gate takes was already honest about this («(a) to (c)»);
  -- the comment and the heading were not, and they are the ones that moved.
  -- THE THREE RUNTIME `pg_index` READINGS OF THIS SLICE ALL COVERED
  -- `installment_plans` AND NONE COVERED `installments`, which was read at
  -- APPLY TIME ONLY (part 9a). And the sum immediately above is
  -- `WHERE n.business_id = ... AND n.plan_id = ...` -- the leading pair of
  -- `installments_plan_schedule_idx` -- which is MEASURED to be served by
  -- that index with the planner FREE on a statistics-free database. So
  -- `installment.schedule_incomplete: (a) the schedule sums to X` could state
  -- an `X` that is an artifact of an `installments` index that is present and
  -- not maintained, with no reading anywhere to exclude it. That is exactly
  -- the F13-2 shape round 14 repaired on `installment_plans` and left open on
  -- `installments`, and it is the defect class of this whole estate: A
  -- REFUSAL THAT NAMES A PREMISE IT DOES NOT READ.
  --
  -- IT IS READ RATHER THAN DETECTED-LATER, AND IT REFUSES BY NAME. An index
  -- that is not (`indisvalid` AND `indisready` AND `indislive`) on EITHER
  -- relation makes every figure this routine could state unsafe -- the sum
  -- over `installments` and the plan row it took `v_status`, `v_invoice` and
  -- `v_down` from, which is read by primary key and therefore served by
  -- `installments`'/`installment_plans`' own indexes -- so the refusal is
  -- `installment.plan_index_unenforcing` and NOT a sentence about a schedule.
  -- The round-14 challenger built `indisvalid=true, indisready=false` on
  -- `installments_plan_schedule_idx` and the lawful write COMMITTED TWICE
  -- (sum read `800000`, two rows in the heap), so the consequence was not
  -- reachable by that route on PostgreSQL 18.4 and the gap stayed DESIGN ONLY.
  -- It is not left as a hypothesis about reachability: the STATE is refused,
  -- which is the only answer that does not depend on finding the route.
  --
  -- IT CANNOT REFUSE LAWFUL WORK, AND THAT IS STRUCTURAL AND NOT A HOPE: the
  -- catalogue read happens ONLY when an obligation has already failed, so a
  -- sound schedule never reaches it at all, and in every state this file
  -- installs all five indexes of the two relations carry the three flags true.
  -- The direction it covers is the only one a missing index entry can produce:
  -- entries can only be ABSENT, so a sum read through an unenforcing index can
  -- only UNDER-report, which makes (a), (b) and (c) FAIL -- it can never make
  -- one of those three pass when it should have failed.
  --
  -- (d) IS THE EXCEPTION, AND THE PREMISE THAT SAVES IT IS NAMED RATHER THAN
  -- LEFT IMPLICIT (`TL-P4-COORD-R63` item 5; an unnamed premise is this
  -- phase's signature defect). Taken ALONE, (d) runs the other way: an
  -- UNDER-reported `v_rows` makes `v_rows > 60` PASS a schedule that is over
  -- the ceiling. What stops that is not this gate, which (d) never reaches,
  -- but `installments.amount_txn_minor BIGINT NOT NULL CHECK
  -- (amount_txn_minor >= 1)` in section 2: every instalment carries at least
  -- one minor unit, so an absent index entry lowers `v_sched` as surely as it
  -- lowers `v_rows`, obligation (a)'s EQUALITY therefore fails in the same
  -- reading, and the gate is entered before (d) is ever evaluated. THE
  -- PREMISE IS THAT CHECK. Relax it to `>= 0` and (d) is unprotected, which
  -- is why this paragraph names it instead of resting on it silently.
  --
  -- WHAT THIS DOES **NOT** CLOSE, STATED RATHER THAN LEFT TO BE FOUND. This
  -- reads the three FLAGS. It cannot see the state where the flags are
  -- PERFECT and the index is nevertheless missing an entry for a row that
  -- qualifies for it -- the state `indisready = false`, a write, and the flag
  -- put back, which `R53` §1 and part 9d exist for. On
  -- `installment_plans` that half is answered at RUNTIME by the two-spelling
  -- count (`installment.plan_index_disagrees`), and THAT INSTRUMENT DOES NOT
  -- TRANSFER HERE: it works because the plan index is PARTIAL, so a query that
  -- restricts no `status` cannot be served by it BY THE IMPLICATION RULE.
  -- `installments_plan_schedule_idx` is NOT partial, so no spelling of this
  -- sum is provably unservable by it and a two-reading comparison would be a
  -- planner preference rather than a law -- which is exactly the mistake
  -- `TL-P4-COORD-R52` F-2 found. The decider for the physical half is
  -- EXECUTION (`REINDEX`), which part 9d runs at apply time over EVERY index of
  -- BOTH relations and which the integration suites re-run over a POPULATED
  -- fixture after every mutation they make. It is not run per plan write,
  -- because a `REINDEX` takes `ACCESS EXCLUSIVE` on the relation and no
  -- ordinary sale may do that. So: the FLAG half is closed on both relations
  -- as of this round, and the PHYSICAL half is apply-time and CI, DECLARED.
  IF v_down + v_sched <> v_total OR v_rows < 1 OR v_max_seq <> v_rows OR v_distinct <> v_rows THEN
    SELECT pg_catalog.string_agg(ic.relname || ' on ' || x.indrelid::REGCLASS::TEXT
                                 || ' (indisvalid=' || x.indisvalid::TEXT
                                 || ', indisready=' || x.indisready::TEXT
                                 || ', indislive=' || x.indislive::TEXT || ')', ', '
                                 ORDER BY ic.relname)
      INTO v_unenforcing
      FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
     WHERE x.indrelid IN ('public.installments'::regclass, 'public.installment_plans'::regclass)
       AND NOT (x.indisvalid AND x.indisready AND x.indislive);
    IF v_unenforcing IS NOT NULL THEN
      RAISE EXCEPTION 'installment.plan_index_unenforcing: the schedule of plan %/% does not satisfy obligation (a) to (c) AS THIS ROUTINE READ IT -- down payment plus schedule % against an invoice total of %, % instalment row(s), max seq_no % -- AND pg_index says these indexes are not enforcing: %. EVERY FIGURE IN THE SENTENCE BEFORE THIS ONE MAY BE AN ARTIFACT OF THAT. The schedule sum is taken WHERE business_id and plan_id, which is the leading pair of installments_plan_schedule_idx, and the plan row is read by primary key, which is served by installment_plans_pkey; an index that is present and not maintained by DML makes either read MISS rows that exist, so a sum read through it UNDER-reports and this routine would otherwise refuse a schedule that is correct, or accept one that is not. Obligations (a), (b) and (c) are not judged on these figures while an index of either relation is unenforcing, and the schedule-length ceiling (d) is not reached past this point: any entry an unenforcing index is missing lowers the schedule SUM as well as the row count, because amount_txn_minor is CHECKed >= 1, so obligation (a) fails on the same reading and arrives here first. REINDEX the named indexes and retry; this is the state an interrupted CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves, and pg_indexes renders it identically to a correct index',
        v_business, v_plan, v_down + v_sched, v_total, v_rows, v_max_seq, v_unenforcing USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- (a) THE EXACT SUM LAW, IN BOTH DIRECTIONS AT ONCE — `R-SAL-06`.
  --     `<>` and not `>`: a schedule summing BELOW the total is refused and a
  --     schedule summing ABOVE it is refused, by the same comparison, so
  --     neither direction can be lost by someone relaxing one inequality. A
  --     `<=` variant would accept the 265-day counterexample of section 3(d).
  --
  --     AND WHEN THIS FIRES WITH NO SCHEDULE AT ALL ON A PLAN'S OWN `INSERT`
  --     EVENT, THE MESSAGE SAYS WHAT THE TWO CAUSES ARE AND WHAT TO DO ABOUT
  --     EACH (`TL-P4-COORD-R59` ordered item 3, F14-5). The NAME is right and
  --     stays -- the schedule really does not sum to the total at the instant
  --     this reads, which is why `R-94`'s fail-closed stance applies and why
  --     this is not round 13's false diagnosis. What was missing is that the
  --     commonest way to reach it is NOT a short schedule: it is
  --     `SET CONSTRAINTS ALL IMMEDIATE`, unprivileged SQL either app role may
  --     issue, which removes this trigger's deferral and fires it at the end of
  --     the PLAN INSERT STATEMENT -- before any `installments` row can exist,
  --     because `installments.plan_id` references the plan and the plan must be
  --     there first. THE ROUND-14 CHALLENGER MEASURED FIVE OF FIVE lawful plan
  --     writes refused that way (`TL-P4-COORD-R59` section 4), and the message
  --     sent their reader to look at a schedule that was never wrong. THAT
  --     FIGURE IS A QUOTATION AND NOT THIS TREE'S OWN READING, and round 16
  --     says so rather than carry a bare count whose instrument was replaced
  --     (`TL-P4-COORD-R63` item 7): no instrument at this SHA reproduces the
  --     five. What the tree's own suites measure is THREE refusals carrying
  --     this two-cause text -- the fact suite's sections R1 and R1b and the
  --     concurrency suite's section G2 -- and those three are PROVEN BY TEST
  --     while the five is PROVEN BY A ROUND-14 MEASUREMENT this tree does not
  --     repeat. Section 3a-quater states why no reordering can eliminate this
  --     the way the fact hazard was eliminated, and the remedy below is the one
  --     that DOES reach it and is MEASURED.
  --
  --     AND WHO READS THE REMEDY IS SETTLED, AND WHAT REACHES THEM IS A
  --     REFERENCE AND NOT THIS TEXT (`TL-P4-COORD-R69` §1 and item 1, which
  --     NARROWS `TL-P4-COORD-R63` item 4, F15-5).
  --     `installment.schedule_incomplete` is a REGISTERED installment
  --     invariant, so `GlobalExceptionFilter` answers it
  --     `500 INTERNAL_ERROR` with a generic body and NO `details`: none of
  --     this text may reach a caller, and none of it does. Round 16 made it
  --     reach an operator by logging the refusal's FIRST LINE beside the
  --     name, and THAT WAS A LEAK OF THE CLASS THE FILTER'S OWN RULE NAMES:
  --     `apps/api/src/common/error.filter.ts:151-153` says «SQL, THE
  --     ROUTINE'S MESSAGE AFTER THE COLON, AN AMOUNT, a journal entry id, an
  --     assertion body and a stack never leave the process», a log line
  --     leaves the process, EIGHT of the thirteen registered `installment.*`
  --     names substitute `business_id` plus an invoice or plan UUID into that
  --     first line, and the first line of THIS refusal substitutes TWO
  --     AMOUNTS. The rule stands and the field is gone. THE DYNAMIC MESSAGE
  --     NOW LEAVES THE PROCESS IN NEITHER THE BODY NOR THE LOG. What the log
  --     carries beside the invariant name is a STATIC REMEDY REFERENCE --
  --     identical for every occurrence of the invariant, resolved from a
  --     table in `apps/api/src/modules/selling/selling-errors.ts`, carrying
  --     no identifier, no amount and no fragment of this sentence -- and THE
  --     PROSE LIVES WHERE THE REFERENCE POINTS: section 3b of this file,
  --     anchor `p4s7-remedy-04`, which states both causes and the
  --     data-modifying-CTE spelling in full. So the reader of this remedy is
  --     an OPERATOR WHO FOLLOWS A REFERENCE, and a reader of this
  --     specification -- never the caller -- and
  --     `tests/guards/p4s7-installment-filter-contract.test.ts` asserts the
  --     half that can fail: the reference present in the log, the anchor
  --     resolving to section 3b, and NEITHER this message NOR the
  --     identifiers a refusal substitutes anywhere in the log line or the
  --     body, pinned on an invariant whose first line DOES carry an
  --     identifier.
  IF v_down + v_sched <> v_total THEN
    IF v_rows = 0 AND TG_TABLE_NAME = 'installment_plans' AND TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'installment.schedule_incomplete: (a) the schedule sums to % and the invoice total is %, and this plan carries NO instalment row at all while its own INSERT is the event being judged. TWO STATES REACH THIS AND THE REMEDY DIFFERS. (1) THE DEFERRAL WAS REMOVED: this verifier is created DEFERRABLE INITIALLY DEFERRED and SET CONSTRAINTS ALL IMMEDIATE -- unprivileged SQL either app role may issue -- makes it fire at the end of the plan INSERT statement instead of at COMMIT, which is BEFORE any installments row can exist, because installments.plan_id references the plan and the plan must be written first. NOTHING IS WRONG WITH THE SCHEDULE IN THAT CASE and no data is bad: either stop issuing SET CONSTRAINTS ALL IMMEDIATE before a plan write, or issue it AFTER the write, or write the plan and its whole schedule in ONE statement (a data-modifying CTE), which this verifier accepts under the removed deferral because both relations'' AFTER-ROW events then belong to the same statement. (2) THE PLAN REALLY HAS NO SCHEDULE: write its instalments in this same transaction, summing with down_payment_minor to the invoice total exactly. This refusal cannot tell the two apart -- PostgreSQL exposes no reading of whether SET CONSTRAINTS has been issued -- so it names both instead of asserting one, which is TL-P4-COORD-R46 F-4''s rule',
        v_down + v_sched, v_total USING ERRCODE = 'P0001';
    END IF;
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
  -- THE COUNT, NOT THE `EXISTS` (`TL-P4-COORD-R50` ordered item 1). See the
  -- block above the recomputation below: `EXISTS` cannot tell ONE active plan
  -- from TWO, and this derivation's totality is exactly the claim that there
  -- is never more than one.
  v_active   BIGINT;
  -- THE SAME COUNT TAKEN BY THE ACCESS PATH THE PARTIAL UNIQUE INDEX CAN
  -- SERVE (`TL-P4-COORD-R52` ordered item 1, F-2). The two are compared, and
  -- a disagreement is the one runtime reading that distinguishes «the index
  -- holds an entry for every qualifying row» from «the index is present».
  v_active_ix BIGINT;
  -- THE OBSERVED CATALOGUE STATE OF EVERY INDEX ON `installment_plans`, read
  -- ONLY on a refusal path, so that a refusal states what it observed and
  -- attributes a cause only where this routine has established one
  -- (`TL-P4-COORD-R55` ordered items 2 and 3, F13-2 and F13-3).
  v_unenforcing TEXT;
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
  -- part 9 refuses to finish the migration unless it is present, partial,
  -- on exactly `(business_id, invoice_id) WHERE status = 'active'` -- AND
  -- ENFORCING, which part 9 did not ask until this round. A derivation that
  -- rests on a constraint must not rest on a belief that the constraint is
  -- there.
  --
  -- AND IT MUST NOT REST ON AN APPLY-TIME READING OF THE CATALOGUE EITHER,
  -- WHICH IS THIS ROUND'S CORRECTION (`TL-P4-COORD-R50` ordered item 1).
  -- Part 9 is a ONE-SHOT block inside a migration: nothing re-asks the
  -- question after the migration has run, and the round-11 challenger
  -- measured the harm in the window part 9 cannot see. With the index
  -- present but `indisvalid = false, indisready = false` -- the state an
  -- interrupted `CREATE UNIQUE INDEX CONCURRENTLY` or `REINDEX CONCURRENTLY`
  -- leaves, and a state `pg_indexes` renders identically to the correct one
  -- -- TWO ORDINARY CONCURRENT PLAN CREATIONS ON ONE INVOICE BOTH COMMITTED
  -- `{flag: true, active plans: 2}`, and `customer_ar_aging` then served the
  -- PRE-INSTALLMENT figure, byte-identical to the no-plan answer, with no
  -- refusal of any kind. Single threaded the same fault is refused;
  -- concurrency was load-bearing for the harm, which is why eleven rounds of
  -- reading did not find it.
  --
  -- SO THE BOUND IS ALSO MEASURED AT RUNTIME, HERE AND IN THE READER, AND IT
  -- IS MEASURED AS A COUNT OVER THE ROWS THIS TRANSACTION CAN SEE RATHER
  -- THAN AS A CATALOGUE READING. A catalogue reading would be a second
  -- apply-time law one level down -- it would say the flags are set, which is
  -- not the same sentence as «no invoice carries two active plans». The count
  -- IS that sentence, and `>= 2` is a fact BLINDNESS CANNOT MANUFACTURE: row
  -- security can only subtract rows, so a blinded count can only
  -- UNDER-report, and refusing on «I can see two» therefore never refuses a
  -- correct state. That is the standing discipline of this file applied to a
  -- count instead of to an `EXISTS`, and it is why the guard may refuse in
  -- this direction and in no other.
  --
  -- THE INVOICE ROW LOCK IS THE OTHER HALF, and it is in
  -- `installment_plan_active_exclusive()` because it has to be taken BEFORE
  -- the plan row is written. Section 3a-ter declares the order.
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
  --
  -- AND WHEN IT FIRES, IT STATES WHAT IT OBSERVED AND READS THE OTHER
  -- CANDIDATE CAUSE BEFORE NAMING ONE (`TL-P4-COORD-R55` ordered items 2 and
  -- 3, F13-2 and F13-3). Until this round this probe raised
  -- `installment.plan_fact_blind`, whose message had just been rewritten to
  -- say, categorically, «THE CAUSE IS ROW SECURITY … look in `pg_policy` and
  -- not in `pg_index`». THAT CLAIM IS FALSE OF THIS SITE. This read is BY
  -- PRIMARY KEY, so it is served by `installment_plans_pkey`, and a primary
  -- key that is present and not being maintained by DML -- `indisready`
  -- false, which `pg_indexes` renders identically to the correct one -- makes
  -- this probe miss a row no policy has touched. Measured: ONE catalogue flag
  -- on `installment_plans_pkey` made EVERY lawful plan write fail under a
  -- name that told the operator to look in the wrong catalogue, while the
  -- apply-time end-state block reported OK and the reader served a figure.
  -- `installment_plans_pkey` occurred ZERO times in this specification.
  --
  -- A refusal may state what it OBSERVED and may attribute a cause only where
  -- the code ESTABLISHES it. So on the failure path this routine READS
  -- `pg_index` for EVERY index of the relation -- not only the partial unique
  -- one, which was the only index any law here read -- and:
  --
  --   * if any index of `installment_plans` is not enforcing, that is a cause
  --     this routine has ESTABLISHED, and it raises
  --     `installment.plan_index_unenforcing` naming each index and each flag;
  --   * otherwise the index explanation is EXCLUDED BY A READING rather than
  --     by assertion, and only then does `installment.plan_fact_blind` name
  --     row security -- which is the one remaining cause of a definer's own
  --     primary-key read missing a row its statement just wrote.
  --
  -- `pg_catalog` carries no row security and no policy can subtract a
  -- `pg_index` row, so this reading is the same for every caller and is not
  -- the retired «certify my own visibility» family: it asks what the INDEX
  -- state is, never what the ASKER can see.
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = NEW.business_id AND p.id = NEW.id)
      INTO v_seen;
    IF NOT v_seen THEN
      SELECT pg_catalog.string_agg(ic.relname || ' (indisvalid=' || x.indisvalid::TEXT
                                   || ', indisready=' || x.indisready::TEXT
                                   || ', indislive=' || x.indislive::TEXT || ')', ', '
                                   ORDER BY ic.relname)
        INTO v_unenforcing
        FROM pg_catalog.pg_index x
        JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
       WHERE x.indrelid = 'public.installment_plans'::regclass
         AND NOT (x.indisvalid AND x.indisready AND x.indislive);
      IF v_unenforcing IS NOT NULL THEN
        RAISE EXCEPTION 'installment.plan_index_unenforcing: this transaction just wrote plan %/% and this writer''s own read of installment_plans BY PRIMARY KEY cannot find it, and pg_index says these indexes of installment_plans are not enforcing: %. A read by primary key is served by installment_plans_pkey, so an index that is present and not maintained by DML makes this read miss a row that exists -- which is what was OBSERVED and is not a row-security fault at all. No fact may be derived while an index of this relation is unenforcing, because installment_plan_fact_sync derives the invoice-borne fact on the strength of installment_plans_one_active_per_invoice_uq holding and reads this relation through its own indexes. REINDEX the named indexes before any further plan is written; this is the state an interrupted CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves',
          NEW.business_id, NEW.id, v_unenforcing USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'installment.plan_fact_blind: this transaction just wrote plan %/% and this writer''s own read of installment_plans by primary key cannot find it, so every read this routine could take is blinded and no fact may be written from one. WHAT WAS OBSERVED, AND WHAT IT EXCLUDES: pg_index was read for every index of installment_plans inside this very event and every one of them carries indisvalid, indisready and indislive true, so a stale or unenforcing index is EXCLUDED BY A READING and not by assertion. installment_plans carries FORCE ROW LEVEL SECURITY, so a policy hiding this row from this routine''s own reads is the remaining known cause and pg_policy is where to look; a cause this routine has not measured is not asserted here',
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
    -- its message names, and the message is true of every state that can
    -- reach it WITHIN ONE STATEMENT -- which is the scope the claim now
    -- carries, because the unqualified version of it was FALSE across
    -- transactions and said nothing about the difference. Section 3a-ter's
    -- table states what a writer meets at each isolation level and for each
    -- racing shape, and the exclusion trigger's own message no longer
    -- prescribes a remedy for a cause it cannot see
    -- (`TL-P4-COORD-R50` ordered item 6).
    --
    -- IT IS A `count(*)` AND NO LONGER AN `EXISTS`, AND THAT IS THE RUNTIME
    -- GUARD FOR THE DERIVATION'S TOTALITY (`TL-P4-COORD-R50` ordered item 1).
    -- `EXISTS` collapses ONE active plan and TWO into the same answer -- the
    -- one distinction the derivation above actually depends on -- so for
    -- eleven rounds the writer could not tell the state its own premise
    -- forbids from the state its premise asserts. The count can, it costs the
    -- same index probe, and the refusal it enables is in the only direction
    -- blindness cannot manufacture.
    --
    -- AND THE COUNT IS TAKEN AFTER THE INVOICE ROW IS LOCKED, WHICH IS A
    -- CORRECTION TO THIS ROUND'S OWN FIRST ATTEMPT (disclosed). The count was
    -- placed here, before the `UPDATE public.invoices` below, and MEASURED
    -- with `installment_plans_active_exclusive` DROPPED and the index NOT
    -- ENFORCING: two concurrent `active` inserters BOTH counted 1, because
    -- each took its count before it reached the `UPDATE` that would have made
    -- it wait, and `READ COMMITTED` gives a statement the snapshot it had
    -- when it STARTED. The guard was therefore sound only while the BEFORE
    -- trigger existed to take the lock first -- which is exactly the
    -- «predicated on the same thing as the derivation» fault
    -- `TL-P4-COORD-R50` ordered item 1 forbids, one level down.
    --
    -- So this routine takes the row itself and does not rely on another
    -- trigger having taken it. Under `READ COMMITTED` the lock wait ends with
    -- a fresh snapshot for the count that follows, so the loser counts 2 and
    -- refuses. It is the SAME row the `UPDATE` below takes, at `P4-AL-41`
    -- rank 3, so it adds no lock and no new edge to the order section 3a-ter
    -- declares; when the BEFORE trigger is present the transaction already
    -- holds the row and this is a no-op. A zero-row result is NOT refused
    -- here -- the `UPDATE` below refuses it as
    -- `installment.plan_fact_unwritable` with the right name -- and a count
    -- taken while this routine's reads are blinded can only UNDER-report,
    -- which is the direction the refusal below is not in.
    PERFORM 1 FROM public.invoices i
      WHERE i.business_id = v_business AND i.id = v_invoice
      FOR NO KEY UPDATE;
    -- ---- A `count(*)` IS NOT AN INSTRUMENT; A `count(*)` PLUS A QUERY PLAN
    --      IS (`TL-P4-COORD-R52` ordered item 1, F-2).
    --
    -- THIS COUNT USED TO BE ANSWERED FROM THE VERY INDEX IT WAS BUILT NOT TO
    -- PRESUPPOSE. `EXPLAIN (COSTS OFF)` of the previous text -- `WHERE
    -- business_id = ? AND invoice_id = ? AND status = 'active'` -- is
    -- `Index Only Scan using installment_plans_one_active_per_invoice_uq`,
    -- identically with `enable_seqscan = off`, because THE PREDICATE IS THE
    -- INDEX'S DEFINITION. So with the index present and `indisready = false`
    -- ALONE -- `indisvalid` and `indislive` still true, which is what lets
    -- the planner keep using it -- the count read 1 while the heap held 2, a
    -- second ACTIVE plan COMMITTED through the ordinary route, part 9's three
    -- flags all read TRUE, the whole end-state block reported OK, and the
    -- reader served a figure over a state a `REINDEX` then refused `23505`.
    -- And the previous round's own green readings for this guard were an
    -- ARTIFACT of also setting `indisvalid = false`, which is precisely the
    -- flag that forces the planner OFF the index: the evidence never
    -- exercised the path it was offered for.
    --
    -- THE REPAIR IS TO TAKE THE COUNT BY A PATH THE PARTIAL INDEX CANNOT
    -- SERVE, AND THAT IS A LAW AND NOT A PREFERENCE. A partial index may be
    -- used only for a query whose own qualifiers IMPLY the index predicate;
    -- a query that does not restrict `status` needs rows the index does not
    -- contain, so no planner of any version may answer it from there. The
    -- status test therefore moves OUT of the `WHERE` and INTO a `FILTER` on
    -- the aggregate, which is evaluated above the scan and cannot be the
    -- source of such an implication. MEASURED: `Bitmap Heap Scan on
    -- installment_plans`, with and without `enable_seqscan`, as the definer
    -- owner and as `daftar_app`, and the index named NOWHERE in the plan.
    -- Section 2b part 9c reads that plan AT APPLY TIME, in every cluster, and
    -- `tests/integration/phase4-s7-installment-fact-db.test.ts` reads it in
    -- CI with the control beside it -- because a premise nothing reads is the
    -- defect this round is repairing, and a planner change must not be able
    -- to reintroduce it silently.
    SELECT pg_catalog.count(*) INTO v_active_ix
      FROM public.installment_plans p
     WHERE p.business_id = v_business AND p.invoice_id = v_invoice
       AND p.status = 'active';
    SELECT pg_catalog.count(*) FILTER (WHERE p.status = 'active') INTO v_active
      FROM public.installment_plans p
     WHERE p.business_id = v_business AND p.invoice_id = v_invoice;
    -- ---- AND THE DISAGREEMENT BETWEEN THE TWO PATHS IS ITSELF THE
    --      INSTRUMENT FOR THE STATE PART 9 CAN ONLY ASK ABOUT ONCE.
    --
    -- The index-served reading can only UNDER-report relative to the heap
    -- reading, and it under-reports in exactly one circumstance that matters:
    -- the index is not holding an entry for a row that qualifies for it. That
    -- is «present but not enforcing», measured at RUNTIME, over the rows this
    -- transaction can see, and it is the sentence part 9's three catalogue
    -- flags are not. Row security cannot manufacture it either: a policy
    -- subtracts the same rows from both readings.
    --
    -- THE SECOND CAUSE IS NAMED BECAUSE IT IS REAL. The two readings are two
    -- statements, and at `READ COMMITTED` each takes a fresh snapshot -- so a
    -- plan committed by another transaction BETWEEN them also produces a
    -- disagreement, in the same direction. It cannot happen while this
    -- transaction holds the invoice row (taken immediately above, and by the
    -- BEFORE trigger before that), because every plan writer on this invoice
    -- must take that row first; it can happen when
    -- `installment_plans_active_exclusive` has been dropped AND this
    -- routine's own lock found no row to take. Both causes are in the
    -- message, with the remedy of each, because a refusal that prescribes one
    -- remedy for two causes sends half its readers to the wrong place.
    IF v_active_ix IS DISTINCT FROM v_active THEN
      RAISE EXCEPTION 'installment.plan_index_disagrees: invoice %/% carries % plan(s) with status = ''active'' when counted with the status test in a FILTER above the scan -- a spelling the PARTIAL unique index cannot serve, by the predicate-implication rule -- and % when counted with status = ''active'' in the WHERE, which it can. THE FIRST READING IS NOT «OVER THE ROWS THEMSELVES» AND IS NO LONGER DESCRIBED AS IT WAS (TL-P4-COORD-R55 ordered item 3): it is index-served too, by installment_plans_pkey in every statistics-free plan, so what the two readings establish is that THE PARTIAL UNIQUE INDEX disagrees with another access path, not that either is a heap scan. Both readings are of the same rows in the same transaction. The index-served reading can only under-report, and it does so when the index holds no entry for a row that qualifies for it -- which is an index that is PRESENT AND NOT ENFORCING (indisready false, the state an interrupted CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves, which pg_indexes renders identically to the correct one) and which REINDEX will refuse. TWO STATES REACH THIS AND THE REMEDY DIFFERS: if the index is unenforcing, nothing may be derived from the bound it is supposed to hold and the index must be rebuilt before any plan is written; if installment_plans_active_exclusive has been dropped, another transaction may have committed a plan on this invoice between these two readings and the remedy is to restore that trigger so that a plan write takes the invoice row first',
        v_business, v_invoice, v_active, v_active_ix USING ERRCODE = 'P0001';
    END IF;
    v_state := (v_active > 0);
    -- ---- THE DERIVATION'S OWN PREMISE, CHECKED AGAINST THE ROWS
    --      (`TL-P4-COORD-R50` ordered item 1).
    --
    -- «AT MOST ONE ACTIVE PLAN EXISTS PER INVOICE AT ANY TIME» is the sentence
    -- that makes this routine's derivation TOTAL. It is asserted thirty lines
    -- above as a consequence of the partial unique index. Here it is MEASURED,
    -- and when it is false this routine REFUSES instead of deciding -- which
    -- is the same rule the cross-check below obeys and for the same reason: a
    -- routine that keeps computing after its premise has failed commits a fact
    -- that can never heal.
    --
    -- IT RAISES AND DOES NOT REPAIR. Choosing which of two active plans is the
    -- real one is a business decision with no derivation behind it, and a
    -- trigger that picked one would be a second authority over the plan
    -- lifecycle. The state is owner-reachable only (an unenforcing index), and
    -- what a refusal buys is that it stops being SILENT.
    IF v_active > 1 THEN
      RAISE EXCEPTION 'installment.plan_active_unbounded: invoice %/% carries % plans with status = ''active'' at once, and installment_plans_one_active_per_invoice_uq admits at most one. The fact this routine derives from the handed row''s transition is TOTAL only because at most one active plan exists per invoice, so with % of them nothing may be derived; a count can only UNDER-report under row security, so two visible active plans are two active plans and not a blinded reading. The index is present-but-unenforcing (indisvalid/indisready false, the state an interrupted CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves) or it is gone',
        v_business, v_invoice, v_active, v_active USING ERRCODE = 'P0001';
    END IF;
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
    --   SCOPED, THOUGH, AND THE SCOPE IS THE WHOLE OF `TL-P4-COORD-R50`'s
    --   F-4: «both orders» means both HEAP orders of ONE STATEMENT. Across
    --   TRANSACTIONS this cross-check never fires at all, because neither
    --   snapshot holds the other's row -- what answers there is the invoice
    --   row lock of section 3a-ter at `READ COMMITTED`, and `40001` at the
    --   two higher levels. Three renderings for one race was the measured
    --   state of this slice before this round and the table in 3a-ter is
    --   where it is now written down.
    --
    --   «derived `true`, recomputed `false`» is the other direction and it IS
    --   the blind one: this routine was handed a row that asserts an active
    --   plan and its own read cannot find one. A dropped index cannot produce
    --   it. That keeps `installment.plan_fact_blind`, and its message is now
    --   true of every state that reaches it.
    IF v_state AND NOT v_value THEN
      RAISE EXCEPTION 'installment.plan_active_conflict: the status transition this transaction wrote on invoice %/% determines has_active_installment_plan = false, and a recomputation over installment_plans then found an ACTIVE plan there. A blinded read can only report FALSE, so this is not blindness: another plan of this invoice is active. Either one statement moved active from one plan to another, in which case cancel the outgoing plan in one statement and activate the incoming plan in a later one, or installment_plans_one_active_per_invoice_uq is gone and two plans are active at once',
        v_business, v_invoice USING ERRCODE = 'P0001';
    END IF;
    IF v_value AND NOT v_state THEN
      -- THE CAUSE IS READ BEFORE IT IS NAMED, AND THE PHRASE THAT WAS FALSE
      -- IS GONE (`TL-P4-COORD-R55` ordered items 2 and 3). The previous
      -- message asserted «THE CAUSE IS ROW SECURITY … look in pg_policy and
      -- not in pg_index», on the strength of «that recomputation is taken
      -- over the rows themselves». NEITHER SENTENCE WAS ESTABLISHED. The
      -- FILTER count cannot be served by the PARTIAL unique index -- that is
      -- a law -- but it IS served by `installment_plans_pkey` in every
      -- statistics-free reading, so with BOTH indexes unenforcing the two
      -- counts under-report TOGETHER, agree, and `plan_index_disagrees`
      -- stays silent. So the index explanation is excluded by a READING of
      -- `pg_index` over every index of the relation, or it is NAMED.
      SELECT pg_catalog.string_agg(ic.relname || ' (indisvalid=' || x.indisvalid::TEXT
                                   || ', indisready=' || x.indisready::TEXT
                                   || ', indislive=' || x.indislive::TEXT || ')', ', '
                                   ORDER BY ic.relname)
        INTO v_unenforcing
        FROM pg_catalog.pg_index x
        JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
       WHERE x.indrelid = 'public.installment_plans'::regclass
         AND NOT (x.indisvalid AND x.indisready AND x.indislive);
      IF v_unenforcing IS NOT NULL THEN
        RAISE EXCEPTION 'installment.plan_index_unenforcing: the status transition this transaction wrote on invoice %/% determines has_active_installment_plan = true, a recomputation over installment_plans then found no active plan there, and pg_index says these indexes of installment_plans are not enforcing: %. Both of this routine''s counts read installment_plans through its own indexes -- the FILTER spelling cannot be served by the PARTIAL unique index, which is a law, but it can be served by installment_plans_pkey -- so with an index unenforcing both readings may under-report together and agree. That is what was OBSERVED; row security is NOT attributed, because it has not been measured. REINDEX the named indexes before any further plan is written',
          v_business, v_invoice, v_unenforcing USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'installment.plan_fact_blind: the status transition this transaction wrote on invoice %/% determines has_active_installment_plan = true, and a recomputation over installment_plans then found no active plan there. This statement just wrote that plan, so the plan is not absent. WHAT WAS OBSERVED, AND WHAT IT EXCLUDES: the same count taken through installment_plans_one_active_per_invoice_uq agreed with this one a statement earlier -- a disagreement there is installment.plan_index_disagrees and names the index -- AND pg_index was read for EVERY index of installment_plans inside this very event, all of them carrying indisvalid, indisready and indislive true, so an unenforcing index is excluded by a reading and not by assertion. installment_plans carries FORCE ROW LEVEL SECURITY, so a policy hiding this row from this routine''s own reads is the remaining known cause and pg_policy is where to look. Writing from a blinded read would commit a fact that can never heal',
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
  v_active   BIGINT;
  -- The same count through the index, for the comparison the sync makes and
  -- for the same reason (`TL-P4-COORD-R52` ordered item 1, F-2).
  v_active_ix BIGINT;
  -- The two trigger NAMES this routine's correctness depends on the order of,
  -- read out of `pg_trigger` per event (`TL-P4-COORD-R55` ordered item 1,
  -- F13-1). Catalogue DATA, not a session setting: no `SET` can reach it.
  v_writer   TEXT;
  v_self     TEXT;
  -- The observed catalogue state of every index of `installment_plans`, read
  -- only on a refusal path (`TL-P4-COORD-R55` ordered items 2 and 3).
  v_unenforcing TEXT;
BEGIN
  -- ---- THE ORDER THIS ROUTINE DEPENDS ON IS A TRIGGER-NAME ORDER, AND IT IS
  --      READ OUT OF THE CATALOGUE PER EVENT (`TL-P4-COORD-R55` ordered
  --      item 1, F13-1)
  --
  -- This trigger is `DEFERRABLE INITIALLY DEFERRED` so that it reads the END
  -- of the transaction, and `installment_plan_fact_sync()` is NOT deferred so
  -- that it has written the fact by the time this looks. `SET CONSTRAINTS ALL
  -- IMMEDIATE` is UNPRIVILEGED SQL that both app roles may issue, and it
  -- removes that deferral: this trigger then fires as an ordinary immediate
  -- `AFTER ... FOR EACH ROW` trigger, and PostgreSQL fires the immediate
  -- `AFTER ROW` triggers of one relation for one event IN TRIGGER-NAME ORDER
  -- -- `strcmp` over `pg_trigger.tgname`, byte order, no collation.
  --
  -- SO THE ORDERING IS MADE NOT TO MATTER RATHER THAN DETECTED. The plan-side
  -- trigger on this routine is named `installment_plans_fact_verified`, which
  -- sorts AFTER `installment_plans_fact_sync`. Made immediate, the WRITER
  -- fires first and this routine reads exactly the state it is built to
  -- judge. The previous round's repair instead COUNTED the two routines'
  -- invocations in a pair of transaction-local custom GUCs -- and PostgreSQL
  -- places no privilege on an unreserved two-part custom setting, so the
  -- caller could write the evidence: one `SET LOCAL` made a LAWFUL plan write
  -- refuse under `installment.plan_fact_unordered` (a false diagnosis of a
  -- lawful sale, rendered `500 INTERNAL_ERROR`), another defeated the
  -- detector outright, and a session-level `SET` turned it off for the life
  -- of a pooled connection while lawful writes still committed. Both GUCs are
  -- gone; nothing in this slice reads or writes a session setting.
  --
  -- AND THE PREMISE IS READ, NOT BELIEVED, WHICH IS THE WHOLE LESSON OF THE
  -- LAST FIVE ROUNDS. «The writer's trigger sorts first» is a fact about
  -- `pg_trigger`, so it is READ from `pg_trigger`, here, inside the event,
  -- for the two rows it is about: the non-internal enabled trigger of this
  -- relation that executes `installment_plan_fact_sync`, and this very
  -- trigger (`TG_NAME`). If the writer's name does not sort strictly before
  -- this one, then making this trigger immediate would run it before the
  -- writer, and the refusal says that and only that. Section 2b part 9e
  -- refuses the migration itself on the same reading.
  --
  -- WHY IT DOES NOT REFUSE WHEN THERE IS NO WRITER. A sync that is DROPPED or
  -- DISABLED has no `pg_trigger` row to compare, and that state is NOT this
  -- refusal: it is the escape section 2c declares, which
  -- `customer_ar_aging`'s `plan_fact_untrusted` refuses at read time and
  -- which the flag comparison below answers under a name of its own. A
  -- refusal must be true of every state that reaches it.
  --
  -- THE `invoices` SIDE IS NOT CHECKED. No sync runs for an invoice-side
  -- event -- an invoice may be born carrying `false` with no plan at all --
  -- so there is no order there to invert, and the invoice-side trigger
  -- therefore keeps its own name.
  IF TG_TABLE_NAME = 'installment_plans' THEN
    SELECT pg_catalog.min(t.tgname) INTO v_writer
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace
     WHERE t.tgrelid = 'public.installment_plans'::regclass
       AND NOT t.tgisinternal AND fn.nspname = 'public'
       AND f.proname = 'installment_plan_fact_sync'
       AND t.tgenabled = 'O';
    v_self := TG_NAME;
    IF v_writer IS NOT NULL AND NOT (v_writer < v_self) THEN
      RAISE EXCEPTION 'installment.plan_fact_unordered: the enabled trigger that executes installment_plan_fact_sync on installment_plans is named % and this deferred verifier''s trigger is named %, read from pg_trigger inside this very event, and % does not sort strictly before %. PostgreSQL fires the immediate AFTER ROW triggers of one relation for one event in TRIGGER-NAME ORDER (strcmp over tgname), so in that name order the VERIFIER would run BEFORE THE WRITER and would judge a fact nobody had written yet. This verifier is created DEFERRABLE INITIALLY DEFERRED so that it reads the end of the transaction, and SET CONSTRAINTS ALL IMMEDIATE -- unprivileged SQL any session may issue -- removes that deferral and makes the name order the firing order. Nothing is desynchronised and no data is wrong: the trigger NAMES of this relation are no longer the names this specification installs. Restore them, or rename so that the writer sorts first',
        v_writer, v_self, v_writer, v_self USING ERRCODE = 'P0001';
    END IF;
  END IF;
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
    --
    -- A `count(*)`, FOR THE REASON SECTION 3a GIVES AT LENGTH
    -- (`TL-P4-COORD-R50` ordered item 1: «the guard must be in the path that
    -- commits the fact»). This routine is the COMMIT-time half of that path,
    -- and the premise it is verifying a consequence of is «at most one active
    -- plan per invoice». An `EXISTS` cannot see the premise fail; a count can.
    --
    -- IT IS NOT A SUBSTITUTE FOR THE SYNC'S COPY AND THE TWO ARE NOT
    -- REDUNDANT. This one is DEFERRED, so it reads at COMMIT and therefore
    -- sees rows the sync's immediate read could not: at `READ COMMITTED` each
    -- statement of a plpgsql routine takes a fresh snapshot, so a transaction
    -- that commits SECOND in the round-11 challenger's two-writer race sees
    -- the first one's committed plan HERE even though its own sync could not
    -- see it. That is the arm that catches the race when the index is not
    -- enforcing. The sync's copy catches the single-transaction state, which
    -- this one would also catch but one statement later, with a less precise
    -- name attached to the write that caused it.
    --
    -- WHAT IT DOES NOT CATCH IS DECLARED RATHER THAN ASSUMED: at `REPEATABLE
    -- READ` and `SERIALIZABLE` a transaction's snapshot cannot hold a
    -- concurrently committed plan at all, so with the index not enforcing
    -- this count reads 1 in both arms of such a race. What refuses THERE is
    -- the invoice row lock of section 3a-ter -- `40001` by the snapshot rules
    -- -- and, if that is bypassed too, the READER's own count, which runs in
    -- a later transaction and is therefore total. Section 3a-ter's table
    -- states which mechanism answers at which isolation level.
    -- AND IT IS TAKEN BY THE PATH THE PARTIAL UNIQUE INDEX CANNOT SERVE,
    -- TWICE, FOR THE REASON THE SYNC STATES AT LENGTH (`TL-P4-COORD-R52`
    -- ordered item 1, F-2). The previous text's plan was `Index Only Scan
    -- using installment_plans_one_active_per_invoice_uq`, so this count --
    -- the COMMIT-time half of the premise check -- was answered from the
    -- index whose enforcement it exists to measure. The status test is in a
    -- `FILTER` and not in the `WHERE`, which makes the index UNUSABLE for the
    -- query by the implication rule and not by the planner's preference; the
    -- index-served reading is taken as well, and a disagreement is refused as
    -- `installment.plan_index_disagrees` -- a runtime detector for an index
    -- that is present and not enforcing, in the one direction row security
    -- cannot manufacture.
    SELECT pg_catalog.count(*) INTO v_active_ix
      FROM public.installment_plans p
     WHERE p.business_id = v_business AND p.invoice_id = v_invoice
       AND p.status = 'active';
    SELECT pg_catalog.count(*) FILTER (WHERE p.status = 'active') INTO v_active
      FROM public.installment_plans p
     WHERE p.business_id = v_business AND p.invoice_id = v_invoice;
    IF v_active_ix IS DISTINCT FROM v_active THEN
      RAISE EXCEPTION 'installment.plan_index_disagrees: invoice %/% ends this transaction carrying % plan(s) with status = ''active'' when counted with the status test in a FILTER above the scan -- a spelling the PARTIAL unique index cannot serve, by the predicate-implication rule -- and % when counted with status = ''active'' in the WHERE, which it can. THE FIRST READING IS NOT «OVER THE ROWS THEMSELVES» AND IS NO LONGER DESCRIBED AS IT WAS (TL-P4-COORD-R55 ordered item 3): it is index-served too, by installment_plans_pkey in every statistics-free plan. Two readings of the same rows in the same transaction disagree, and the index-served one can only under-report: the index holds no entry for a row that qualifies for it, which is an index that is PRESENT AND NOT ENFORCING (indisready false, the state an interrupted CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves) and which REINDEX will refuse. The bound installment_plan_fact_sync derives the invoice-borne fact from is therefore not being held, and it must be rebuilt before any further plan is written',
        v_business, v_invoice, v_active, v_active_ix USING ERRCODE = 'P0001';
    END IF;
    v_state := (v_active > 0);
    IF v_active > 1 THEN
      RAISE EXCEPTION 'installment.plan_active_unbounded: invoice %/% ends this transaction carrying % plans with status = ''active'' at once, and installment_plans_one_active_per_invoice_uq admits at most one. invoices.has_active_installment_plan is ONE BIT and cannot carry which of them customer_ar_aging should age across, so the aging would read one invoice''s outstanding through two schedules; a count can only UNDER-report under row security, so this is not a blinded reading. The index is present-but-unenforcing or gone',
        v_business, v_invoice, v_active USING ERRCODE = 'P0001';
    END IF;
    IF v_flag IS DISTINCT FROM v_state THEN
      -- AND THIS ONE EXCLUDES THE INDEX CAUSE BY A READING TOO
      -- (`TL-P4-COORD-R55` ordered items 2 and 3). `v_state` is derived from
      -- a count of `installment_plans`, and every count of that relation is
      -- served by one of its indexes -- the FILTER spelling by
      -- `installment_plans_pkey`, the WHERE spelling by the partial unique
      -- one. With an index present and not enforcing BOTH may under-report
      -- together, so `v_state = false` beside a flag of `true` is not
      -- evidence of a desynchronised fact until the index state has been
      -- read. It is read here, and when it is at fault the refusal names the
      -- index and not the fact.
      SELECT pg_catalog.string_agg(ic.relname || ' (indisvalid=' || x.indisvalid::TEXT
                                   || ', indisready=' || x.indisready::TEXT
                                   || ', indislive=' || x.indislive::TEXT || ')', ', '
                                   ORDER BY ic.relname)
        INTO v_unenforcing
        FROM pg_catalog.pg_index x
        JOIN pg_catalog.pg_class ic ON ic.oid = x.indexrelid
       WHERE x.indrelid = 'public.installment_plans'::regclass
         AND NOT (x.indisvalid AND x.indisready AND x.indislive);
      IF v_unenforcing IS NOT NULL THEN
        RAISE EXCEPTION 'installment.plan_index_unenforcing: invoices.has_active_installment_plan is % for %/% while this transaction''s own count of active plans says %, AND pg_index says these indexes of installment_plans are not enforcing: %. Every count of installment_plans is served by one of its indexes, so with one unenforcing both of this routine''s readings may under-report together and the disagreement with the column is not evidence about the column. That is what was OBSERVED. REINDEX the named indexes before any further plan is written',
          v_flag, v_business, v_invoice,
          CASE WHEN v_state THEN 'an active plan does exist' ELSE 'none does' END,
          v_unenforcing USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'installment.plan_fact_desynchronised: invoices.has_active_installment_plan is % for %/% while an active installment plan %, and customer_ar_aging ages that invoice from this column. WHAT WAS OBSERVED: pg_index was read for every index of installment_plans inside this very event and all of them carry indisvalid, indisready and indislive true, so an unenforcing index is excluded by a reading and not by assertion',
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
-- Behind it stand the mechanisms that do not depend on a read of
-- `installment_plans` at all — `installment_plans_one_active_per_invoice_uq`
-- itself, which is physical, the INVOICE ROW LOCK this routine now takes
-- first (section 3a-ter), and the sync's cross-check, whose message section
-- 3a now states truthfully.
--
-- AND «WHICH IS PHYSICAL» IS EXACTLY THE SENTENCE THAT COST ROUND 11 ITS
-- SIGNATURE, so it is qualified here rather than left standing. An index is
-- physical and an index CAN STOP ENFORCING without being dropped: with
-- `indisvalid` and `indisready` false it is present, unique, partial on the
-- right predicate, rendered identically by `pg_indexes`, certified by the
-- end-state ratchet — and maintained by no DML. The round-11 challenger
-- committed two active plans from two ordinary concurrent writers in exactly
-- that state. So this file no longer rests anything on the index alone: the
-- bound is read at APPLY time from `indisvalid`/`indisready`/`indislive`
-- (part 9), and MEASURED AT RUNTIME as a `count(*)` in the sync, in the
-- deferred verifier and in the reader, where it raises
-- `installment.plan_active_unbounded`. This
-- trigger's whole contribution is that the writer who meets the limit is told
-- what the limit IS, under one name, in every row order. A guard that names
-- its cause is the difference between a writer who cancels and re-activates in
-- two statements and a writer who files a bug about a blinded policy that was
-- never touched.
CREATE OR REPLACE FUNCTION installment_plan_active_exclusive() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_other      UUID;
  v_was_active BOOLEAN;
  v_locks      UUID[];
  v_locked     INTEGER;
BEGIN
  -- ---- THE INVOICE ROW IS TAKEN FIRST, AND THAT IS THE DECLARED ORDER
  --      (`TL-P4-COORD-R50` ordered item 5; `P4-AL-41`).
  --
  -- THE ORDER THIS SLICE TOOK BEFORE THIS ROUND WAS AN INVERSION OF THE
  -- PHASE 4 LOCK, AND NOBODY HAD WRITTEN IT DOWN. The round-11 challenger
  -- read it off its own measurements, because the slice declared none:
  --
  --     plan row  ->  partial unique index entry  ->  invoice row
  --
  -- the invoice row arriving LAST, from `installment_plan_fact_sync()`'s
  -- `UPDATE public.invoices`. `P4-AL-41` ranks `invoices` THIRD and
  -- `installment_plans` SIXTH (`docs/PHASE_4_ARCHITECTURE_LOCK.md:869-876`),
  -- so the slice was taking rank 6 before rank 3 on every plan write. That is
  -- a lock-order defect by the project's own law, and `P4-AL-41` says what to
  -- do with one: «a deadlock is a lock-order defect and is fixed by changing
  -- the order -- never by a retry loop».
  --
  -- SO THE ORDER IS CHANGED HERE, in the one place that runs BEFORE the plan
  -- row is written:
  --
  --     invoice row  ->  plan row  ->  partial unique index entry
  --
  -- and THE ROWS THIS ONE INVOCATION TAKES are taken ASCENDING BY `id`,
  -- which is `P4-AL-41` rank 3's own qualifier («`invoices` -- ascending by
  -- `id` where several are touched»). The shape that takes two of them in one
  -- invocation is an `UPDATE` that moves an active plan between two invoices
  -- of one business.
  --
  -- THE SCOPE IS ONE INVOCATION AND THE PREVIOUS ROUND DECLARED IT WITHOUT
  -- ONE (`TL-P4-COORD-R52` ordered item 5, F-5). A `BEFORE ... FOR EACH ROW`
  -- trigger cannot order across its own invocations, so a STATEMENT that
  -- touches plans on several invoices takes those invoice rows in ROW ORDER
  -- and not in `id` order -- MEASURED, `FOR NO KEY UPDATE NOWAIT` refused
  -- `55P03` in BOTH heap orders, with the statement holding the higher `id`
  -- while waiting on the lower one in one of them. Section 3a-ter declares
  -- that shape as a `P4-AL-41` rank 3 obligation this slice does not
  -- discharge, rather than leaving a declaration the code does not keep.
  --
  -- WHAT IT BUYS BESIDES THE ORDER, AND IT IS THE LARGER HALF. `FOR NO KEY
  -- UPDATE` on the invoice row makes THE INVOICE ROW the serialization point
  -- of a plan write instead of the index entry, so two concurrent writers on
  -- ONE invoice now meet each other HERE -- before either has written a plan
  -- row -- rather than meeting the index at commit. At `READ COMMITTED` the
  -- loser's lock is granted after the winner commits, each statement inside a
  -- plpgsql function then takes a NEW snapshot, and the recheck below reads
  -- the winner's committed plan and raises `installment.plan_active_conflict`.
  -- THE CROSS-TRANSACTION RACE IS THEREFORE REFUSED UNDER THE SAME NAME AS
  -- THE SINGLE-STATEMENT ONE, AND WITHOUT THE INDEX ENTERING THE ARGUMENT --
  -- which is what `TL-P4-COORD-R50` ordered item 1 asks of the write path:
  -- a guard that does not presuppose the index.
  --
  -- AT `REPEATABLE READ` AND `SERIALIZABLE` IT CANNOT BE THAT NAME AND MUST
  -- NOT PRETEND TO BE. The winner's sync UPDATEs the invoice row, so the
  -- loser's lock on a row a concurrent transaction has changed is refused
  -- `40001` by the snapshot rules themselves, before this routine's recheck
  -- runs. `40001` is the correct answer at those levels and is a RETRYABLE
  -- serialization failure rather than this slice's refusal; section 3a-ter
  -- scopes the determinism claim accordingly instead of over-claiming it a
  -- third time.
  --
  -- A BLINDED LOCK TAKES NOTHING AND IS NOT TREATED AS A REFUSAL. `invoices`
  -- carries its own policies and this routine is a DEFINER, not a bypass, so
  -- a definer that cannot see the invoice locks zero rows. That case is NOT
  -- raised here: `installment_plan_fact_sync()`'s `plan_fact_unwritable`
  -- already owns «this transaction changed a plan on an invoice it could not
  -- write», and two refusals for one state is how a caller comes to be told
  -- the wrong cause. `v_locked` is read so that the state is observable and
  -- not merely assumed, and the number is carried into the conflict message.
  -- ---- AND THERE IS NO `DELETE` ARM, BECAUSE A TRIGGER CANNOT HOLD THE
  --      ORDER ON `DELETE` AT ALL. THAT IS MEASURED, AND IT IS THIS ROUND'S
  --      CORRECTION OF ITS OWN FIRST ANSWER
  --      (`TL-P4-COORD-R59` ordered item 2, F14-2) ------------------------
  --
  -- THE DEFECT IS REAL AND IS NOT IN DOUBT. A `DELETE` of an active plan takes
  -- the `installment_plans` row (`P4-AL-41` rank 6) and reaches the `invoices`
  -- row (rank 3) only afterwards, from `installment_plan_fact_sync()`. The
  -- round-14 challenger MEASURED the deadlock that makes out of TWO ORDINARY
  -- OPERATIONS ON ONE INVOICE: an ordinary invoice write takes the invoice row
  -- `FOR NO KEY UPDATE`, the deleter takes the plan row and blocks on the
  -- invoice row (proved from a third backend by `55P03` on the plan row), the
  -- invoice writer then cancels that plan through the DOCUMENTED route, and the
  -- cycle closes -- `40P01` to the deleter. Section 3a-ter's stated remedy
  -- («one invoice per statement, ascending `invoices.id`») cannot reach it:
  -- there is ONE invoice and ONE statement each.
  --
  -- THIS ROUND'S FIRST ANSWER WAS TO ADD A `DELETE` ARM HERE THAT TOOK THE
  -- INVOICE ROW FIRST, AND IT DOES NOT WORK. IT WAS BUILT, SHIPPED INTO THIS
  -- BODY, AND THE RACE WAS RE-RUN AGAINST IT: the deleter STILL held the plan
  -- row while waiting for the invoice row (`55P03` from the third backend,
  -- unchanged) and STILL got `40P01`. THE REASON IS IN POSTGRESQL AND NOT IN
  -- THIS FILE: for a `BEFORE ROW DELETE` trigger the executor must produce the
  -- `OLD` tuple, and `GetTupleForTrigger` LOCKS THAT TUPLE BEFORE THE TRIGGER
  -- FUNCTION IS CALLED. So rank 6 is already held when the first statement of
  -- any `BEFORE DELETE` arm runs, and no code placed there can take rank 3
  -- first. An `AFTER` arm is later still. There is no earlier hook: a statement
  -- -level `BEFORE` trigger has no row to find the invoice from, and a rule is
  -- not a lock.
  --
  -- SO THE ARM IS GONE AGAIN -- a trigger arm whose stated purpose it provably
  -- does not serve is worse than no arm, because every law around it then
  -- asserts a false rationale -- AND THE CASE IS DECLARED IN 3a-ter WITH A
  -- REMEDY THAT REACHES IT AND IS MEASURED: the deleter takes the invoice row
  -- ITSELF, in its own transaction, before it deletes the plan. That is one
  -- extra statement in the caller, it is the rank-3-before-rank-6 order
  -- `P4-AL-41` asks for, and
  -- `tests/integration/phase4-s7-installment-concurrency-db.test.ts` §G1
  -- measures the identical race with it and without it: with it the deleter
  -- does not deadlock and the `DELETE` commits; without it, `40P01`.
  --
  -- AND THE `40P01` NO LONGER RENDERS AS AN UNNAMED 500 (`R59` ordered item 2's
  -- second half): `apps/api/src/modules/selling/selling-errors.ts` classifies
  -- `40001` and `40P01` BY SQLSTATE and the global filter renders them 409
  -- `CONFLICT` with `retryable: true`. That is a RENDERING and not a retry
  -- loop, and it is deliberately in NEITHER invariant registry, because neither
  -- is an invariant of this slice.
  v_was_active := (TG_OP = 'UPDATE' AND OLD.status = 'active');
  IF NEW.status = 'active' OR v_was_active THEN
    v_locks := ARRAY[NEW.invoice_id];
    IF v_was_active AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      v_locks := v_locks || OLD.invoice_id;
    END IF;
    -- `FOR NO KEY UPDATE` and not `FOR UPDATE`: it is the strength a plain
    -- `UPDATE` of a non-key column takes, it conflicts with itself, and it
    -- does not block the `FOR KEY SHARE` an ordinary foreign-key check takes
    -- against the same invoice. PostgreSQL honours a locking clause on the
    -- strength of `UPDATE` on ANY single column (section 2c), and this
    -- DEFINER holds exactly one: `has_active_installment_plan`.
    PERFORM 1 FROM public.invoices i
      WHERE i.business_id = NEW.business_id AND i.id = ANY (v_locks)
      ORDER BY i.id
      FOR NO KEY UPDATE;
    GET DIAGNOSTICS v_locked = ROW_COUNT;
  ELSE
    v_locked := 0;
  END IF;

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
    -- ---- THE MESSAGE NAMES WHAT IS TRUE AND PRESCRIBES NOTHING IT CANNOT
    --      KNOW (`TL-P4-COORD-R50` ordered item 6, F-5).
    --
    -- The previous message said «one statement may not move active from one
    -- plan to another: cancel the outgoing plan in one statement and activate
    -- the incoming plan in a later one». Measured against a cancel that was
    -- UNCOMMITTED IN ANOTHER TRANSACTION (round-11 challenger K3), every
    -- clause of that was wrong for the caller reading it: no statement had
    -- moved anything, the caller WAS the later statement, and the remedy it
    -- was handed was the thing it had just done.
    --
    -- The cause is not knowable from here -- this routine can see that another
    -- plan is active in its own snapshot and cannot see WHOSE statement made
    -- it so -- so the message states the observable fact, names BOTH causes,
    -- and gives the remedy that belongs to each. A refusal that prescribes one
    -- remedy for two causes sends half its readers to the wrong place, which
    -- is the same family of defect as `plan_fact_blind`'s misnaming in
    -- `TL-P4-COORD-R46` F-4.
    RAISE EXCEPTION 'installment.plan_active_conflict: plan %/% is being made the active installment plan of invoice % while plan % is already that invoice''s active plan in this statement''s own snapshot (% invoice row(s) locked first). At most one plan per invoice may be active. TWO STATES REACH THIS AND THE REMEDY DIFFERS: if this statement is itself moving active from one plan to another, one statement may not do that -- cancel the outgoing plan in one statement and activate the incoming plan in a later one; if the other plan was made active by a DIFFERENT TRANSACTION that has since committed, nothing this caller did was wrong and the plan it means to replace is no longer the one it read -- re-read the invoice''s active plan and decide again',
      NEW.business_id, NEW.id, NEW.invoice_id, v_other, v_locked USING ERRCODE = 'P0001';
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
--
-- AND THAT HAZARD IS NOW REMOVED RATHER THAN DETECTED (`TL-P4-COORD-R55`
-- ordered item 1, F13-1). This comment considered a DEFERRED WRITER. The
-- exposure that existed is a NON-DEFERRED VERIFIER, which `SET CONSTRAINTS
-- ALL IMMEDIATE` -- unprivileged SQL, permitted to `daftar_app` and to
-- `daftar_migrator`, MEASURED -- produces from any session: the deferral
-- goes, both AFTER ROW triggers fire in TRIGGER-NAME ORDER, and the verifier
-- then ran before the writer, read a flag nobody had written yet, and refused
-- a LAWFUL plan write under `installment.plan_fact_desynchronised` -- a false
-- name, rendered `500 INTERNAL_ERROR`.
--
-- ROUND 13 DETECTED THAT STATE WITH A TRANSACTION-LOCAL COUNTER, AND THE
-- COUNTER WAS ITSELF THE DEFECT. A counter in a custom two-part GUC
-- (`installment.plan_fact_sync_events`) has NO privilege on it: PostgreSQL
-- lets ANY role `SET`, `SET LOCAL` and `set_config` an unreserved
-- user-namespaced setting. So one `SET LOCAL
-- installment.plan_fact_verify_events = '5'` made an ORDINARY LAWFUL PLAN
-- WRITE, with no `SET CONSTRAINTS` anywhere, refuse under
-- `installment.plan_fact_unordered` -- a false diagnosis of a lawful sale,
-- rendered `500 INTERNAL_ERROR` because the name is a registered invariant --
-- and one `SET LOCAL installment.plan_fact_sync_events` returned the original
-- attack to its original false name for the price of one statement, while a
-- plain session-level `SET` turned the detector off for the life of a pooled
-- connection with lawful writes still committing. A DETECTOR WHOSE EVIDENCE
-- THE ATTACKER MAY WRITE IS NOT A DETECTOR, and one that renders 500 on a
-- lawful sale is worse than none.
--
-- SO THE ORDERING IS MADE NOT TO MATTER, BY NAME. PostgreSQL fires immediate
-- same-event `AFTER ROW` triggers of one relation in TRIGGER-NAME ORDER --
-- `strcmp` over `pg_trigger.tgname`, byte order, no collation -- and the
-- deferred fact verifier used to be called `installment_plans_fact_agrees`,
-- which sorts BEFORE `installment_plans_fact_sync`. It is called
-- `installment_plans_fact_verified` here, which sorts AFTER it
-- (`installment_plans_fact_` then `s` < `v`). `SET CONSTRAINTS ALL IMMEDIATE`
-- now fires the WRITER first and the verifier second, in the one order the
-- verifier can judge, so there is nothing left to detect and nothing left to
-- forge. The invoice-side trigger keeps its name: no sync runs for an
-- invoice-side event, so there is no order there to invert.
--
-- AND THE PREMISE OF THAT REPAIR IS READ AND NOT BELIEVED, because a premise
-- nothing reads is the defect of every round since `R50`. The name order is
-- catalogue DATA -- `pg_trigger.tgname`, which no `SET` can reach and which
-- only the table owner can change -- and it is read in TWO places: section 2b
-- part 9e refuses to finish the migration unless the writer's trigger name
-- sorts strictly before the plan-side verifier's, and
-- `installment_plan_fact_verify()` re-reads those same two catalogue rows per
-- plan event and refuses `installment.plan_fact_unordered` when they are out
-- of order. That refusal now states a fact read from the catalogue inside the
-- event rather than a count a caller could have written. Section 3a-ter
-- states what remains open: `installment_plans_schedule_complete` still fires
-- into a transaction whose `installments` rows do not exist yet, which fails
-- CLOSED under `installment.schedule_incomplete` -- true of the instant it
-- reads -- and that is the same fail-closed stance frozen `0069`/`0071` take
-- under `R-94`.
CREATE TRIGGER installment_plans_fact_sync
  AFTER INSERT OR UPDATE OR DELETE ON installment_plans
  FOR EACH ROW EXECUTE FUNCTION installment_plan_fact_sync();

-- THE EXCLUSION IS BEFORE, AND THAT IS THE WHOLE POINT: it must have answered
-- before the row is written, which is before the partial unique index is
-- checked and before any AFTER trigger of this statement is fired.
--
-- AND IT DOES NOT FIRE ON `DELETE`, WHICH ROUND 15 TRIED AND MEASURED TO BE
-- USELESS (`TL-P4-COORD-R59` ordered item 2, F14-2). A `BEFORE DELETE` arm was
-- built here to take the `invoices` row (rank 3) before the
-- `installment_plans` row (rank 6), and it CANNOT: for a `BEFORE ROW DELETE`
-- trigger the executor produces the `OLD` tuple through `GetTupleForTrigger`,
-- WHICH LOCKS THAT TUPLE BEFORE THE TRIGGER FUNCTION IS CALLED, so rank 6 is
-- already held when the arm's first statement runs. The identical race was
-- re-run with the arm installed and the deleter STILL held the plan row while
-- awaiting the invoice row (`55P03` from a third backend) and STILL got
-- `40P01`. The arm is therefore not here, the measured case is DECLARED in
-- section 3a-ter with a caller remedy that DOES reach it (take the invoice row
-- yourself, before the DELETE -- measured both ways in §G1 of
-- `tests/integration/phase4-s7-installment-concurrency-db.test.ts`), and the
-- `40P01` is rendered `409` with `retryable: true` instead of an unnamed 500.
CREATE TRIGGER installment_plans_active_exclusive
  BEFORE INSERT OR UPDATE ON installment_plans
  FOR EACH ROW EXECUTE FUNCTION installment_plan_active_exclusive();

-- THE VERIFIER IS DEFERRED, ON BOTH SIDES OF THE FACT -- AND ON THE PLAN SIDE
-- ITS NAME SORTS AFTER THE WRITER'S, WHICH IS LOAD-BEARING AND NOT
-- COSMETIC (`TL-P4-COORD-R55` ordered item 1, F13-1). `installment_plans_fact_
-- verified` > `installment_plans_fact_sync` in byte order, so if this trigger
-- is ever made immediate -- which `SET CONSTRAINTS ALL IMMEDIATE` does from
-- any session, with no privilege -- the writer still fires first and this
-- routine still reads a state it can judge. Part 9e and
-- `installment_plan_fact_verify()` both READ that order out of `pg_trigger`
-- rather than assuming it, because the previous round's repair named a
-- premise nothing read.
CREATE CONSTRAINT TRIGGER installment_plans_fact_verified
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
  'P4-S7 (TL-P4-COORD-R38 direction (d); TL-P4-COORD-R43 F1-c and F1-c-prime). The ONLY writer of invoices.has_active_installment_plan. An ordinary AFTER ROW trigger on installment_plans — not deferred, so the column is right as soon as the statement completes and the deferred verifier has something to check at COMMIT. THE WRITE SET IS DERIVED FROM THE HANDED ROW''S STATUS TRANSITION AND FROM NOTHING ELSE: NEW.status, OLD.status and the two invoice_ids are fields of records this trigger was given, which no policy can hide, and installment_plans_one_active_per_invoice_uq makes the derivation TOTAL — at most one active plan exists per invoice, so a row that BECAME active determines true, a row that LOST active determines false because it was the only active one there was, and a row that was not and is not active determines NOTHING and is NOT WRITTEN. THAT PREMISE IS NOW MEASURED AND NO LONGER ASSUMED (TL-P4-COORD-R50 ordered item 1): the cross-check is a count(*) and not an EXISTS, and more than one active plan on one invoice RAISES installment.plan_active_unbounded instead of being folded into the same answer as one — because an EXISTS cannot distinguish the state the premise forbids from the state the premise asserts, which is the one distinction the derivation depends on. The refusal is in the only direction blindness cannot manufacture: row security can only SUBTRACT rows, so a blinded count can only UNDER-report and two visible active plans are two active plans. With the index present but indisvalid/indisready false — the state an interrupted CREATE INDEX CONCURRENTLY leaves, which pg_indexes renders identically to the correct one — two ORDINARY CONCURRENT plan creations committed two active plans and customer_ar_aging then served the pre-installment figure byte-identical to the no-plan answer with no refusal at all, and the apply-time end-state ratchet certified that state as sound. That empty write set is F1-c''s repair: round 9 derived a floor from NEW but let a blindable recomputation decide the value for every transition, so a NON-ACTIVE plan write — the ordinary re-planned receivable, which the PARTIAL unique index permits — carried no floor and still overwrote the fact. THE RECOMPUTATION IS KEPT AND MAY ONLY REFUSE: EXISTS over status = ''active'' is compared against the derived value and a disagreement is never evidence of absence. THE TWO DIRECTIONS CARRY DIFFERENT NAMES BECAUSE THEY HAVE DIFFERENT CAUSES (TL-P4-COORD-R46, F-4): a blinded EXISTS can only read false, so derived-false-recomputed-true cannot be blindness and raises installment.plan_active_conflict (another plan of this invoice is active, from a single statement that moved active between two plans or from a dropped unique index) while derived-true-recomputed-false is the blind direction and keeps installment.plan_fact_blind. THE SINGLE-STATEMENT MOVE IS NOT JUDGED HERE ANY MORE (TL-P4-COORD-R46, F-4): installment_plan_active_exclusive() refuses it BEFORE the row is written, as installment.plan_active_conflict, in every row order, because judging it here was row-order dependent and named a blinded policy that had not been touched. AND THE WRITER DETECTS A BLINDING THAT HIDES THE ROW IT WAS HANDED: on every INSERT and UPDATE it reads that row by primary key — a row that exists in this snapshot because this statement just wrote it — and refuses when it cannot find it, which is F1-c-prime, the one principal round 9''s floor could not watch. THAT REFUSAL NOW READS pg_index BEFORE IT NAMES A CAUSE (TL-P4-COORD-R55 ordered items 2 and 3, F13-2 and F13-3): the read is BY PRIMARY KEY and is therefore served by installment_plans_pkey, an index this specification did not name even once, and ONE catalogue flag on it made EVERY lawful plan write fail under installment.plan_fact_blind whose message had just been rewritten to say that the cause is row security and that one should look in pg_policy and not in pg_index, while the end-state block reported OK and the reader served a figure. So the failure path reads the three enforcement flags of EVERY index of installment_plans: an unenforcing one is named as installment.plan_index_unenforcing, and only when all of them are enforcing does installment.plan_fact_blind attribute row security — a cause then excluded by a reading rather than asserted. ITS SCOPE IS THAT AND NOT MORE (TL-P4-COORD-R46, F-3, correcting a claim that said every INSERT and every UPDATE whatever the transition): a policy predicated on status <> ''active'' leaves a non-active handed row VISIBLE, so the probe passes while the recomputation is blind, and what closes that direction is the EMPTY write set rather than the probe — measured, with round 9''s INSERT branch committing {flag: false, active plans: 1} on exactly that construction and this body refusing it. The DELETE direction carries no such probe and needs none, because no read enters its derived value. IT TAKES THAT COUNT BY AN ACCESS PATH THE PARTIAL UNIQUE INDEX CANNOT SERVE, AND TAKES IT TWICE (TL-P4-COORD-R52 ordered item 1, F-2): the previous spelling put status = ''active'' in the WHERE, which IS that index''s predicate, so EXPLAIN planned the guard as an Index Only Scan on the very index whose enforcement it measures and it read ONE where the heap held TWO — with indisready false alone, a second active plan committed through the ordinary route while part 9''s three flags, the trigger count and the whole end-state block all reported OK. The status test is now in a FILTER and the scan carries no status qualifier, which makes the index unusable for the query by the implication rule rather than by the planner''s preference; the index-served reading is taken as well and a disagreement RAISES installment.plan_index_disagrees, which is a RUNTIME detector for an index that is present and not enforcing, in the one direction row security cannot manufacture. Section 2b part 9c reads that plan at apply time and the fact suite reads it in CI with the control beside it. AND THE ORDER BETWEEN IT AND THE DEFERRED VERIFIER IS NOW A TRIGGER-NAME ORDER AND NOT A COUNTER (TL-P4-COORD-R55 ordered item 1, F13-1): SET CONSTRAINTS ALL IMMEDIATE is unprivileged SQL that both app roles may issue and it removes the verifier''s deferral, after which PostgreSQL fires the immediate AFTER ROW triggers of one relation in TRIGGER-NAME ORDER — so the plan-side verifier trigger is named installment_plans_fact_verified, which sorts AFTER installment_plans_fact_sync, and the writer fires first in that case too. Round 13 instead counted the two routines'' invocations in transaction-local CUSTOM GUCs, which PostgreSQL places no privilege on: one SET LOCAL made a LAWFUL plan write refuse as installment.plan_fact_unordered rendered 500 INTERNAL_ERROR, another defeated the detector, and a session-level SET disabled it for the life of a pooled connection. The counter is gone and the premise is read from pg_trigger by the verifier and by section 2b part 9e. It refuses a plan that changes business. It carries NO ''WHERE value IS DISTINCT FROM'' guard, deliberately: ROW_COUNT <> 1 must mean "I could not reach the invoice row" and not "it was already correct", and it RAISES installment.plan_fact_unwritable on it. SECURITY DEFINER owned by daftar_accounting_internal, which holds the unconditional accounting_validator read on both relations and the column-level UPDATE on invoices; the UPDATE still passes through invoices'' own tenant_membership and business_isolation_update policies, so a writer must carry the invoice''s app.tenant_id and app.business_id. Pinned search_path. No EXECUTE grantee but its owner.';
COMMENT ON FUNCTION installment_plan_fact_verify() IS
  'P4-S7 (TL-P4-COORD-R38 direction (d)). The COMMIT-time refusal that makes invoices.has_active_installment_plan true rather than merely maintained. A DEFERRABLE INITIALLY DEFERRED constraint trigger on BOTH sides of the fact: on installment_plans for INSERT, UPDATE and DELETE, and on invoices for INSERT and for UPDATE OF that column — the INSERT arm because 0078:264''s GRANT INSERT ON invoices is table-level and therefore covers a column added later, so an invoice could be born carrying the fact with no plan behind it. It re-derives EXISTS(active plan) and refuses installment.plan_fact_desynchronised on any disagreement, and refuses rather than returning when no invoice carries the fact at all, because returning there is the vacuous pass 0075:439-441 names. Blinded, its EXISTS reads false and every state it then reports is a refusal EXCEPT a flag of false beside a hidden active plan; that one direction is quiet here and is NOT claimed unreachable (TL-P4-COORD-R43 F1-c found round 9 claiming exactly that, falsely). What is true is narrower: after F1-c''s repair a false flag can only be WRITTEN by a transition that DETERMINES false from the handed row, with no read in the value, so the writer cannot produce the state from a blinded read — while TRUNCATE and a disabled trigger still can, and in those states the READ refuses as plan_fact_unflagged. THE ORDERING IS MADE NOT TO MATTER, BY NAME, AND THE NAME ORDER IS READ (TL-P4-COORD-R55 ordered item 1, F13-1): SET CONSTRAINTS ALL IMMEDIATE is unprivileged SQL permitted to daftar_app and daftar_migrator and it removes this trigger''s deferral, after which PostgreSQL fires the immediate AFTER ROW triggers of one relation in TRIGGER-NAME ORDER (strcmp over pg_trigger.tgname). The plan-side trigger on this routine is therefore named installment_plans_fact_verified, which sorts AFTER installment_plans_fact_sync, so the writer fires first in the immediate case too and this routine always reads a state it can judge. Round 13 instead counted invocations in transaction-local CUSTOM GUCs, which any role may SET: one SET LOCAL made a LAWFUL write refuse as installment.plan_fact_unordered rendered 500 INTERNAL_ERROR, another defeated the detector for one statement, and a session-level SET disabled it for the life of a pooled connection. The counter is gone. What remains is a READING of pg_trigger per plan event: the enabled trigger executing installment_plan_fact_sync on this relation must sort strictly before TG_NAME, and installment.plan_fact_unordered is raised when the catalogue says it does not — true of exactly what was read, unforgeable by any session, and still failing closed. A sync that is dropped or disabled has no row to compare and is NOT this refusal; it is section 2c''s declared escape, refused at read time as plan_fact_untrusted. Section 3a-ter states what is still open: installment_plans_schedule_complete fires into a transaction whose installments rows do not exist yet and fails closed under installment.schedule_incomplete, which is true of the instant it reads. ITS COUNT IS ALSO TAKEN BY A PATH THE PARTIAL UNIQUE INDEX CANNOT SERVE, AND TWICE (TL-P4-COORD-R52 ordered item 1, F-2), raising installment.plan_index_disagrees on a disagreement between the two readings. It only READS and RAISES: it writes nothing. SECURITY DEFINER owned by daftar_accounting_internal so that its reading cannot be blinded by an absent session context — the asymmetry that makes this construction sound where round 6''s DEFINER count was not: this routine is never asked what a CALLER can see, and the reader is never asked either, because the fact is on the row. Pinned search_path. No EXECUTE grantee but its owner.';

COMMENT ON FUNCTION installment_plan_active_exclusive() IS
  'P4-S7 (TL-P4-COORD-R46, F-4). The one-active exclusion, refused AT THE STATEMENT and under ONE NAME. A BEFORE INSERT OR UPDATE row trigger on installment_plans: a row may not BECOME an invoice''s active plan while another plan is that invoice''s active plan in this statement''s own snapshot, and it raises installment.plan_active_conflict when one is. ITS MESSAGE NAMES BOTH CAUSES AND PRESCRIBES THE REMEDY OF EACH (TL-P4-COORD-R50 ordered item 6, F-5): the previous message said «one statement may not move active from one plan to another: cancel the outgoing plan in one statement and activate the incoming plan in a later one», and measured against a cancel UNCOMMITTED IN ANOTHER TRANSACTION every clause of it was wrong for the caller reading it — no statement had moved anything, the caller WAS the later statement, and the remedy it was handed was the thing it had just done. This routine can see that another plan is active in its own snapshot and cannot see whose statement made it so, so the message states the observable fact and lets the caller pick the remedy that belongs to its own case. It exists because the sync''s AFTER-time cross-check declared this over-strictness and the declaration was ROW-ORDER DEPENDENT and misnamed: AFTER ROW triggers fire after every row of the statement is written while the partial unique index is checked per row, so the active-row-first heap order was refused P0001 installment.plan_fact_blind (a FALSE diagnosis: no policy altered and the index present) and the cancelled-row-first order was refused 23505 on installment_plans_one_active_per_invoice_uq. Judging it BEFORE the write makes both orders, and the two-statement activate-then-cancel order, one name; cancel-then-activate in two statements still COMMITS, because the outgoing row''s cancelled status is then a visible change of an earlier command, and that is the documented route. IT ALSO TAKES THE INVOICE ROW FOR NO KEY UPDATE FIRST — ascending by id ACROSS THE ROWS OF ONE INVOCATION, which is the whole of what a BEFORE ROW trigger can order, a statement touching plans on several invoices taking those invoice rows in ROW order (measured, 55P03 in both heap orders) and section 3a-ter declaring that shape as a P4-AL-41 rank 3 obligation this slice does not discharge (TL-P4-COORD-R52 ordered item 5) — WHICH IS THE DECLARED LOCK ORDER (section 3a-ter; TL-P4-COORD-R50 ordered item 5; P4-AL-41 ranks invoices third and installment_plans sixth, and this slice was taking rank 6 before rank 3 on every plan write). IT HAS NO DELETE ARM, AND THAT IS A MEASUREMENT OF ROUND 15 RATHER THAN AN OMISSION (TL-P4-COORD-R59 ordered item 2, F14-2). A DELETE of an active plan takes rank 6 and reaches rank 3 only afterwards from the sync, which section 3a-ter declared and which the round-14 challenger measured: an ordinary invoice write holding the invoice row, a deleter holding the plan row and blocking on the invoice row (proved by 55P03 from a third backend), and the invoice writer then cancelling that plan through the documented route — 40P01 to the deleter, on ONE invoice, from two ORDINARY operations, one statement each, for which 3a-ter''s stated remedy of one invoice per statement in ascending id order could not apply. A BEFORE DELETE arm taking the invoice row first was BUILT and the race was re-run against it: the deleter still held the plan row while awaiting the invoice row and still got 40P01, because for a BEFORE ROW DELETE trigger the executor produces OLD through GetTupleForTrigger, which LOCKS that tuple before the trigger function is called. No code in a BEFORE DELETE arm can take rank 3 first, so the arm was removed rather than left asserting a rationale it does not serve, part 12 of the end-state block refuses the DELETE bit, and section 3a-ter states the remedy that DOES reach the case: the DELETER takes the invoice row FOR NO KEY UPDATE itself, in its own transaction, before the DELETE — measured both ways in the concurrency suite''s section G1. The 40P01 is separately rendered 409 CONFLICT with retryable: true instead of an unnamed 500, by SQLSTATE and in neither invariant registry. What is still a CALLER obligation and is declared rather than certified absent: deleting a plan''s SCHEDULE first takes installments rows before anything else, and installments carries no BEFORE trigger to order that. That moves the serialization point of a plan write from the index entry to the invoice row, so at READ COMMITTED two concurrent writers on one invoice meet each other HERE and the loser — whose next statement takes a fresh snapshot once the lock is granted — is refused installment.plan_active_conflict rather than a raw 23505 from the index, which is the cross-transaction race answered by the same name as the single-statement one and answered WITHOUT the index entering the argument. THE DETERMINISM CLAIM IS SCOPED ACCORDINGLY AND NOT THIRD-TIME OVER-CLAIMED: one name for a single statement in any row order and for two transactions at READ COMMITTED; 40001 at REPEATABLE READ and SERIALIZABLE, where the snapshot rules refuse the lock before this recheck runs and a retryable serialization failure is the correct answer; and 40P01 for two invoices locked in opposite order, which is a caller obligation P4-AL-41 rank 3 states and no per-row trigger can discharge. A blinded definer locks zero invoice rows and this routine does NOT raise on that, because installment_plan_fact_sync''s plan_fact_unwritable already owns it and two refusals for one state is how a caller is told the wrong cause. IT IS NOT THE MECHANISM AND DOES NOT REPLACE ONE: its read of installment_plans is blindable by FORCE ROW LEVEL SECURITY and blinded it reads nothing and PASSES, behind which stand the partial unique index, which is physical, and the sync''s cross-check. Its contribution is that the writer who meets the limit is told what the limit is. SECURITY DEFINER owned by daftar_accounting_internal, pinned search_path, no EXECUTE grantee but its owner.';
ALTER FUNCTION installment_plan_fact_sync() OWNER TO daftar_accounting_internal;
ALTER FUNCTION installment_plan_fact_verify() OWNER TO daftar_accounting_internal;
ALTER FUNCTION installment_plan_active_exclusive() OWNER TO daftar_accounting_internal;

-- ── 3a-ter. THE LOCK ORDER, DECLARED; AND THE DETERMINISM CLAIM, SCOPED ───
--           (`TL-P4-COORD-R50` ordered items 5 and 6; `P4-AL-41`;
--            `P4-AL-42`)
--
-- THIS SECTION EXISTS BECAUSE THE SLICE DECLARED NO LOCK ORDER AND TOOK ONE.
-- The round-11 challenger had to read it off its own measurements:
--
--     plan row  ->  partial unique index entry  ->  invoice row
--
-- the invoice row arriving LAST, from `installment_plan_fact_sync()`'s
-- `UPDATE public.invoices`. Two transactions each creating a plan on two
-- invoices of one business, in OPPOSITE invoice order, deadlocked `40P01` --
-- on two orderings each of which is an ordinary business operation -- and
-- `40P01` appears in no catalogue of this slice and renders `500
-- INTERNAL_ERROR` at the API.
--
-- AND THE ORDER IT TOOK WAS AN INVERSION OF THE PHASE 4 LOCK, WHICH NOBODY
-- HAD NOTICED EITHER. `P4-AL-41` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:869-876`)
-- ranks `invoices` THIRD and `installment_plans` SIXTH. A plan write was
-- taking rank 6 before rank 3, every time. `P4-AL-41` also says what is owed
-- to a deadlock: «a deadlock is a lock-order defect and is fixed by changing
-- the order -- never by a retry loop, never by `SET deadlock_timeout`, and
-- never by treating the deadlock as a business outcome the caller should
-- handle».
--
-- ── THE DECLARED ORDER FOR A PLAN WRITE, AS OF THIS ROUND ────────────────
--
--   1. `invoices`, the plan's invoice row, `FOR NO KEY UPDATE` -- `P4-AL-41`
--      rank 3. Taken in `installment_plan_active_exclusive()`, a BEFORE ROW
--      trigger, which is the only point in a plan write that runs before the
--      plan row exists.
--
--      ASCENDING BY `id` WITHIN ONE INVOCATION OF THAT TRIGGER, AND NOT
--      ACROSS THE ROWS OF ONE STATEMENT. THE PREVIOUS ROUND DECLARED THIS
--      ORDER WITHOUT THAT SCOPE AND THE DECLARATION WAS STRONGER THAN THE
--      CODE (`TL-P4-COORD-R52` ordered item 5, F-5), which is worse than no
--      declaration because the next author builds on it. What is true, and
--      the measurement that bounds it:
--
--        * the `ORDER BY i.id` in that routine's own `PERFORM ... FOR NO KEY
--          UPDATE` IS honoured, and it is the only shape that takes two
--          invoice rows in one statement of one trigger invocation: an
--          `UPDATE` that moves an active plan between two invoices of one
--          business;
--        * ACROSS THE ROWS OF ONE STATEMENT THE ORDER IS ROW ORDER AND NOT
--          `id` ORDER. A `BEFORE ... FOR EACH ROW` trigger cannot order its
--          own invocations: the server calls it once per row, in the order
--          the plan produces the rows. MEASURED by the round-12 challenger
--          and not disputed: one statement activating a plan on each of two
--          invoices, with a holder on the invoice the row order reaches
--          SECOND, is blocked; a third backend asking for the FIRST-row
--          invoice `FOR NO KEY UPDATE NOWAIT` is refused `55P03` in BOTH heap
--          orders -- so in the high-then-low run the statement held the
--          HIGHER `id` while waiting for the lower one;
--        * and `installment_plan_fact_sync()`'s step-4 lock is a SINGLE ROW
--          per loop iteration over a derived array, with no ordering of its
--          own. It adds no edge when the BEFORE trigger has pre-taken the
--          rows and it takes them in array order when it has not.
--
--      SO THE MULTI-ROW PLAN STATEMENT IS A SECOND SHAPE FOR WHICH
--      `P4-AL-41` RANK 3's ASCENDING QUALIFIER IS NOT DISCHARGED BY THIS
--      SLICE, and it is DECLARED here rather than certified absent -- the
--      caller cannot discharge it either, because the caller addresses PLANS
--      and the row order is the planner's. Its deadlock consequence is
--      DESIGN ONLY and is NOT measured: at most one plan row per invoice can
--      be in a lock-taking transition at a time, so two such statements
--      contend on the PLAN rows first, and the round-12 challenger's own
--      `40P01` from two multi-row statements was attributed by the server log
--      to a tuple of `installment_plans` and not of `invoices`. The remedy
--      available to a caller is the one `P4-AL-41` already states and this
--      section already declares below: ONE INVOICE PER STATEMENT, in
--      ascending `invoices.id` order.
--   2. the `installment_plans` row itself -- `P4-AL-41` rank 6.
--   3. the entry in `installment_plans_one_active_per_invoice_uq`, when the
--      row qualifies for the partial index.
--   4. the `invoices` row again, from `installment_plan_fact_sync()` -- which
--      takes it ITSELF, `FOR NO KEY UPDATE`, immediately before its `count(*)`
--      and ahead of its own `UPDATE`, and does not rely on the BEFORE trigger
--      having taken it. For every transition the BEFORE trigger sees this is
--      a row the transaction already holds from step 1, so it adds no lock and
--      no edge; on a DELETE, and with the BEFORE trigger absent, it is the
--      only lock there is, and the sync's premise check depends on it. (That
--      dependency was MEASURED the hard way: with the count placed before the
--      lock, two concurrent writers each counted 1 on the snapshot their
--      statement started with and both committed. See the sync's own comment.)
--
-- THE `DELETE` INVERSION IS REAL, IS MEASURED, AND NO TRIGGER OF THIS SLICE
-- CAN CLOSE IT -- WHICH ROUND 15 ESTABLISHED BY BUILDING THE TRIGGER THAT WAS
-- SUPPOSED TO (`TL-P4-COORD-R59` ordered item 2, F14-2; `R55` §4 made general
-- by `R59` §4).
--
-- A `BEFORE ROW` trigger fires on INSERT and UPDATE and not on DELETE, so a
-- DELETE of an active plan reaches the invoice row only from the sync, at step
-- 4, AFTER the plan row -- rank 6 before rank 3, on that one transition. Round
-- 14 DECLARED it and said an EIGHTH trigger would be needed to close it. The
-- round-14 challenger then MEASURED what the inversion costs:
--
--     B  SELECT 1 FROM invoices WHERE id = $1 FOR NO KEY UPDATE      -- rank 3
--     A  DELETE FROM installments WHERE plan_id = $1
--     A  DELETE FROM installment_plans WHERE id = $1   -> BLOCKED, asserted
--        (and a third backend's FOR NO KEY UPDATE NOWAIT on the plan row was
--         refused 55P03, which PROVES A held rank 6 while awaiting rank 3)
--     B  UPDATE installment_plans SET status = 'cancelled' WHERE id = $1
--     A  -> 40P01 deadlock detected          B -> null, commits
--
-- TWO ORDINARY OPERATIONS, ONE INVOICE, ONE STATEMENT EACH -- so the remedy
-- this section states below («ONE INVOICE PER STATEMENT, in ascending
-- `invoices.id` order») does not reach it, and B's half is the DOCUMENTED
-- cancel route. `40P01` is in no registry of this slice.
--
-- ── WHAT ROUND 15 TRIED, AND WHAT THE ATTEMPT MEASURED ───────────────────
--
-- No eighth trigger is needed to fire on DELETE: `installment_plans_active_
-- exclusive` can simply be created `BEFORE INSERT OR UPDATE OR DELETE`, with a
-- DELETE arm that takes the invoice row `FOR NO KEY UPDATE` and returns `OLD`
-- without judging anything. THAT WAS BUILT, SHIPPED INTO THE BODY, AND THE
-- RACE ABOVE WAS RE-RUN AGAINST IT. IT DOES NOT WORK:
--
--   * the third backend's `FOR NO KEY UPDATE NOWAIT` on the plan row was
--     refused `55P03` exactly as before -- the deleter held rank 6 while
--     waiting for rank 3 -- and
--   * the deleter was still refused `40P01`.
--
-- THE REASON IS IN POSTGRESQL AND NOT IN THIS FILE. To fire a `BEFORE ROW
-- DELETE` trigger the executor must produce the `OLD` tuple, and it does so
-- through `GetTupleForTrigger`, WHICH LOCKS THAT TUPLE BEFORE THE TRIGGER
-- FUNCTION IS CALLED. Rank 6 is therefore already held when the first
-- statement of ANY `BEFORE DELETE` arm runs, and no code placed there can take
-- rank 3 first. An `AFTER` arm is later still; a statement-level `BEFORE`
-- trigger has no row from which to find the invoice; a rule is not a lock. So
-- `P4-AL-41`'s instruction -- «a deadlock is a lock-order defect, fixed by
-- changing the order» -- is here an instruction TO THE CALLER, because the
-- order on the DELETE path is not this file's to change.
--
-- THE ARM WAS THEREFORE REMOVED AGAIN. A trigger arm whose stated purpose it
-- provably does not serve is worse than no arm: part 12 would read its
-- `tgtype` bit, the body comment and the function COMMENT would state a
-- rationale that is false, and the next round would inherit a closed-looking
-- hazard that is open. The attempt is recorded here instead, because the next
-- author's first idea will be the same one.
--
-- ── THE REMEDY THAT DOES REACH IT, AND IS MEASURED ───────────────────────
--
-- THE DELETER TAKES THE INVOICE ROW ITSELF, IN ITS OWN TRANSACTION, BEFORE IT
-- DELETES THE PLAN:
--
--     SELECT 1 FROM invoices WHERE business_id = $1 AND id = $2
--       FOR NO KEY UPDATE;                                          -- rank 3
--     DELETE FROM installments WHERE plan_id = $3;
--     DELETE FROM installment_plans WHERE id = $3;                  -- rank 6
--
-- One extra statement, no new privilege, and it is the rank-3-before-rank-6
-- order `P4-AL-41` asks for. §G1 of
-- `tests/integration/phase4-s7-installment-concurrency-db.test.ts` measures the
-- SAME race both ways: WITHOUT that first statement the deleter is refused
-- `40P01`, WITH it the deleter waits for the invoice row at its own FIRST
-- statement -- holding nothing -- and then completes. This remedy is ABOUT THE
-- DELETE PATH and is additional to the «one invoice per statement, ascending
-- `invoices.id`» remedy below, which is about several invoices.
--
-- AND THE `40P01` NO LONGER RENDERS AS AN UNNAMED `500` (`R59` ordered item 2's
-- second half), which is the part of this that does not depend on the caller
-- doing anything: see the rendering paragraph after the determinism table.
--
-- ONE MORE TRANSITION TAKES NEITHER LOCK AND IS NOT CLAIMED TO: an `UPDATE`
-- that leaves a non-active plan non-active, whose write set is EMPTY.
--
-- AND ONE FURTHER CALLER OBLIGATION ON THE DELETE PATH, DECLARED AND NOT
-- CERTIFIED ABSENT. A transaction that deletes a plan's SCHEDULE first takes
-- `installments` rows BEFORE it takes anything else, and `installments` carries
-- no BEFORE trigger to order anything. A counterparty that holds the invoice
-- row and then writes that plan's `installments` can close a cycle:
-- TAKE THE INVOICE ROW (or the plan row) BEFORE THE SCHEDULE. DESIGN ONLY and
-- UNMEASURED.
--
-- ── WHAT THE ORDER BUYS BESIDES AGREEING WITH `P4-AL-41` ─────────────────
--
-- The serialization point of a plan write moves from the INDEX ENTRY to the
-- INVOICE ROW, and the invoice row is a lock this slice can reason about:
--
--   * two concurrent writers on ONE invoice now block each other in the
--     BEFORE trigger, before either has written a plan row. At
--     `READ COMMITTED` the loser's lock is granted when the winner commits,
--     each statement of a plpgsql routine then takes a FRESH SNAPSHOT, and
--     the recheck immediately below the lock reads the winner's committed
--     plan and raises `installment.plan_active_conflict`. So the
--     cross-transaction race is refused under THE SAME NAME as the
--     single-statement one, and -- this is the part that matters --
--     WITHOUT THE PARTIAL UNIQUE INDEX ENTERING THE ARGUMENT. That is what
--     `TL-P4-COORD-R50` ordered item 1 asks of the write path.
--   * a plan write and an ordinary invoice write on the same invoice
--     serialize, where before the plan write took the invoice row last and
--     could be the second half of a cycle.
--
-- ── THE DETERMINISM CLAIM, SCOPED, BECAUSE IT HAS NOW BEEN OVER-CLAIMED
--    TWICE ───────────────────────────────────────────────────────────────
--
-- Section 3a-bis says the one-active exclusion is «deterministic in kind …
-- in every row order», and the round-11 challenger confirmed that over TEN
-- single-statement constructions in BOTH heap orders. It then measured what
-- the claim does not cover, and the claim did not say so:
--
--   | what is racing                              | what the writer meets        |
--   |---------------------------------------------|------------------------------|
--   | one statement, any shape, either heap order | `plan_active_conflict`       |
--   | two transactions, `READ COMMITTED`          | `plan_active_conflict`       |
--   |                                             | (THIS ROUND; `23505` before) |
--   | two transactions, `REPEATABLE READ`         | `40001`                      |
--   | two transactions, `SERIALIZABLE`            | `40001`                      |
--   | two invoices, opposite order                | `40P01`                      |
--   | ONE invoice: a plan DELETE against an       | `40P01` (MEASURED) unless    |
--   | ordinary invoice write that then cancels    | the deleter takes the        |
--   | that plan through the documented route      | invoice row FIRST, which no  |
--   |                                             | trigger can do for it        |
--
-- THE CLAIM IS THEREFORE SCOPED TO A SINGLE STATEMENT AND TO
-- `READ COMMITTED`, and the rest is named rather than implied. At
-- `REPEATABLE READ` and `SERIALIZABLE` the loser's lock on an invoice row a
-- concurrent transaction has changed is refused `40001` by the snapshot rules
-- themselves, BEFORE this slice's recheck runs — and `40001` is the correct
-- answer at those levels, a retryable serialization failure that is not this
-- slice's refusal and must not be dressed up as one. `40P01` on two invoices
-- in opposite order is a CALLER obligation that no per-row trigger can
-- discharge, and it is `P4-AL-41` rank 3's qualifier: A TRANSACTION THAT
-- CREATES OR CANCELS PLANS ON SEVERAL INVOICES OF ONE BUSINESS MUST DO SO IN
-- ASCENDING `invoices.id` ORDER. That is the declaration; `gate:phase4:s8`
-- owns the N-run proof of it (`P4-AL-41`), and this slice ships no plan
-- command for it to govern yet.
--
-- THE FOURTH ROW OF THAT TABLE IS THE ONE ROUND 15 ADDED, AND ITS REMEDY IS
-- STATED ABOVE RATHER THAN LEFT TO BE RE-MEASURED: the deleter takes the
-- invoice row itself before the DELETE. It is a CALLER obligation not because
-- that is convenient but because `GetTupleForTrigger` locks the `OLD` tuple
-- before any `BEFORE DELETE` arm can run, which round 15 measured by building
-- the arm and watching it fail. A remedy a caller can carry out is the most a
-- declared hazard may have; this one has it, and the attempt that could not
-- supply it is recorded above rather than quietly dropped.
--
-- AND `40P01` NO LONGER RENDERS AS AN UNNAMED `500` EITHER, for the shapes
-- that remain (`TL-P4-COORD-R59` ordered item 2). Both `40001` and `40P01`
-- used to reach `GlobalExceptionFilter`'s last `unhandled error` branch --
-- `500 INTERNAL_ERROR`, no code, no retry contract, and the whole `pg` error
-- object in the log. They are classified now, in
-- `apps/api/src/modules/selling/selling-errors.ts`, as `409 CONFLICT` with
-- `details.contention` and `retryable: true`, with the SQLSTATE in the LOG and
-- not in the body. They are STILL NOT in either invariant registry, for the
-- reason the last paragraph of this section gives: a registry entry would
-- contract that contention is a defect of this slice.
--
-- ── `SET CONSTRAINTS ALL IMMEDIATE`: AN UNPRIVILEGED STATEMENT WHOSE FACT
--    HAZARD IS NOW REMOVED BY A NAME, AND WHOSE REMAINING EFFECT IS
--    DECLARED (`TL-P4-COORD-R55` ordered item 1, F13-1) ──────────────────
--
-- `SET CONSTRAINTS ALL IMMEDIATE` needs no privilege and both app roles may
-- issue it (MEASURED: `daftar_app` and `daftar_migrator` both succeed). It
-- removes the deferral of `installment_plans_fact_verified`,
-- `invoices_installment_fact_agrees` and the three schedule-completeness
-- triggers for the rest of the transaction, after which they fire as ordinary
-- immediate `AFTER ... FOR EACH ROW` triggers, IN TRIGGER-NAME ORDER --
-- `strcmp` over `pg_trigger.tgname`, byte order, no collation.
--
-- WHAT THE NAME ORDER NOW IS, AND WHY THAT IS THE REPAIR. The plan-side fact
-- verifier was called `installment_plans_fact_agrees`, which sorts BEFORE
-- `installment_plans_fact_sync`: made immediate, THE VERIFIER RAN BEFORE THE
-- WRITER, read a flag nobody had written yet, and refused a lawful plan
-- insert `installment.plan_fact_desynchronised` -- a name FALSE of the state
-- and a registered internal invariant, so the merchant received `500
-- INTERNAL_ERROR` on a lawful sale. It is called
-- `installment_plans_fact_verified` here, which sorts AFTER the sync, so the
-- WRITER FIRES FIRST in the immediate case as well and the verifier reads a
-- state it can judge. There is nothing left to detect and nothing left to
-- forge.
--
-- ROUND 13'S DETECTOR IS GONE, AND WHY IT HAD TO GO. It stamped a
-- transaction-local counter per plan row event in a CUSTOM two-part GUC and
-- compared the two counts. PostgreSQL places no privilege on an unreserved
-- user-namespaced setting, so the attacker owned the evidence: `SET LOCAL
-- installment.plan_fact_verify_events = '5'` plus an ORDINARY LAWFUL PLAN
-- WRITE, with no `SET CONSTRAINTS` anywhere, was refused
-- `installment.plan_fact_unordered` -- a FALSE diagnosis of a lawful sale
-- rendered `500 INTERNAL_ERROR`; `SET LOCAL
-- installment.plan_fact_sync_events` returned the original attack to the
-- original false name for one extra statement; and a plain session-level
-- `SET` was seen at the start of a LATER transaction on the same backend, so
-- the detector was silently off for the life of a pooled connection while
-- lawful writes still committed. A forgeable detector that renders 500 on a
-- lawful sale is worse than no detector. Neither setting is read or written
-- anywhere in this slice any more.
--
-- AND THE PREMISE OF THE RENAME IS READ IN TWO PLACES, because a premise
-- nothing reads is the defect this estate has paid for five rounds running:
-- section 2b part 9e refuses to finish the migration unless the enabled
-- trigger executing `installment_plan_fact_sync` on `installment_plans`
-- sorts strictly before the plan-side trigger executing
-- `installment_plan_fact_verify`, and `installment_plan_fact_verify()`
-- re-reads those same two `pg_trigger` rows per plan event and refuses
-- `installment.plan_fact_unordered` when the catalogue says they are out of
-- order. `pg_trigger.tgname` is catalogue DATA: no `SET` reaches it and only
-- the table owner can change it.
--
-- WHAT IS NOT CLAIMED, AND IT IS THE HALF A RENAME CANNOT FIX.
-- `installment_plans_schedule_complete` still fires BEFORE the transaction's
-- `installments` rows exist, and its premise IS the end of the transaction,
-- so a transaction that issues `SET CONSTRAINTS ALL IMMEDIATE` and then
-- writes a plan is still REFUSED -- now under
-- `installment.schedule_incomplete`, which is TRUE of the instant that
-- trigger reads (the schedule really does sum to less than the invoice
-- total at that moment) and which no longer attributes a fact
-- desynchronisation that did not happen. IT FAILS CLOSED: no wrong fact
-- commits. That is the same stance frozen `0069`/`0071` take under `R-94` --
-- a deferred guard forced early must fail closed -- and `R53` §2 records
-- that those migrations answered this question three phases before this
-- slice asked it. Issued AFTER the write, or not at all, the same write
-- commits: the deferred triggers then fire on a transaction state they can
-- judge, which is the shape every existing use of the statement in this
-- estate's test helpers has (`tests/helpers/p3c-residue.ts`,
-- `stock-ledger.ts`, `supplier-settlement.ts`).
--
-- AND THE PRODUCT ITSELF ISSUES IT NOWHERE: `SET CONSTRAINTS` occurs ZERO
-- times in `apps/` and ZERO times in `packages/` (MEASURED, a
-- case-insensitive sweep of both trees). Every occurrence in the repository
-- is in `tests/` or in a migration COMMENT. That is a reading of today's tree
-- and not a guarantee about a pooler, an ORM or a diagnostic session, which is
-- why the name order is read rather than noted.
--
-- `40001` AND `40P01` ARE NOT IN THIS SLICE'S REFUSAL CATALOGUE AND MUST NOT
-- BE. They are transaction-manager outcomes, not invariant violations, and
-- `apps/api/src/modules/selling/selling-errors.ts` registers invariant names
-- only. A caller that meets either has met contention and not a defect; what
-- is owed is a retry at the caller's own transaction boundary, which is the
-- standard contract for those SQLSTATEs and is `[[daftar-lock-order-not-retry]]`'s
-- one permitted retry — a retry of a SERIALIZATION failure is not a retry of
-- a deadlock.

-- ── 3a-quater. WHY THE SCHEDULE HAZARD IS DECLARED AND NOT ELIMINATED,
--              AND THE REMEDY THAT DOES REACH IT
--              (`TL-P4-COORD-R59` ordered item 3; `R55` §4 made general by
--               `R59` §4; F14-5) ─────────────────────────────────────────
--
-- `R55` §4 prefers REMOVING a hazard to DETECTING one, and `R59` §4 makes the
-- preference general. Round 14 applied it to the FACT triggers -- by a NAME --
-- and left the SCHEDULE triggers declaring the hazard instead. This section is
-- the required statement of why the same remedy cannot apply there, and it is
-- an argument with a measurement in it rather than an assertion.
--
-- ── WHY THE FACT REMEDY WORKED, PRECISELY ────────────────────────────────
--
-- `installment_plan_fact_sync()` and `installment_plan_fact_verify()` fire on
-- THE SAME EVENT OF THE SAME STATEMENT. `SET CONSTRAINTS ALL IMMEDIATE` puts
-- them both in that statement's AFTER-ROW queue, and PostgreSQL orders that
-- queue BY TRIGGER NAME -- so a NAME is enough to put the writer first, and the
-- verifier then reads a state that exists. The repair is a total function of
-- information available INSIDE one statement.
--
-- ── WHY NO NAME CAN DO THE SAME HERE ─────────────────────────────────────
--
-- The schedule obligation's premise is not «the writer ran»; it is «the
-- transaction is over». Its left-hand side is a SUM OVER `installments` ROWS
-- WRITTEN BY A LATER STATEMENT, and they MUST be later: `installments_plan_fk`
-- references `installment_plans`, so the plan row exists before any instalment
-- of it can. At the end of the plan INSERT statement that sum is 0 for reasons
-- of REFERENTIAL ORDER and not of TRIGGER ORDER. Renaming any of the seven
-- triggers, adding an eighth, or reordering the queue in any way
-- cannot make rows exist that no statement has written. That is the difference between the
-- two cases, stated as the thing it is.
--
-- ── AND NO OTHER POSTGRESQL MECHANISM IS OUT OF `SET CONSTRAINTS`' REACH ──
--
-- The hooks PostgreSQL offers at the end of a transaction are: DEFERRABLE
-- constraint triggers (this slice's three), and DEFERRABLE `UNIQUE`, `PRIMARY
-- KEY`, `EXCLUDE` and `FOREIGN KEY` constraints. `SET CONSTRAINTS ALL
-- IMMEDIATE` is defined over ALL of them -- that is the statement's whole
-- meaning -- so there is no «deferred until COMMIT and unreachable by
-- `SET CONSTRAINTS`» mechanism to move the obligation into. `ON COMMIT` exists
-- only for TEMPORARY tables and cannot judge a permanent relation. A
-- NOT DEFERRABLE constraint trigger is not an escape in the other direction
-- either: it would fire at every statement, which is the same refusal made
-- unconditional. The remaining alternative -- not enforcing the sum at all and
-- leaving it to the reader -- is the state `TL-P4-COORD-R43` F1-d rejected,
-- because a receivable whose schedule does not sum can then never be aged.
--
-- SO ELIMINATION IS SHOWN IMPOSSIBLE FOR THIS OBLIGATION, which is the
-- condition `R59` §4 sets for a hazard being allowed to remain DECLARED. It
-- fails CLOSED, under a name TRUE of the instant it reads, which is the stance
-- frozen `0069`/`0071` take under `R-94`.
--
-- ── WHAT WAS WRONG ANYWAY, AND IS FIXED: THE REMEDY ──────────────────────
--
-- Being unavoidable did not make it acceptable as it stood. The refusal named
-- a schedule that was never wrong and offered its reader nothing, and the
-- hazard was «mitigated» only by no plan command having shipped -- a schedule,
-- not a defence. Two things change:
--
--   1. obligation (a) now names BOTH causes when it fires on a plan's own
--      `INSERT` with ZERO instalment rows -- the forced-early one and the
--      genuinely-empty one -- and gives the remedy belonging to each, because
--      PostgreSQL exposes no reading of whether `SET CONSTRAINTS` has been
--      issued and a refusal may not assert a cause it cannot observe
--      (`TL-P4-COORD-R46` F-4's rule, applied to this message);
--   2. THERE IS A REMEDY THAT REACHES THE CASE, AND IT IS MEASURED: write the
--      plan and its WHOLE SCHEDULE IN ONE STATEMENT -- a data-modifying CTE,
--      `WITH p AS (INSERT INTO installment_plans ... RETURNING id) INSERT INTO
--      installments SELECT ... FROM p` -- and the removed deferral becomes
--      harmless, because both relations' AFTER-ROW events then belong to the
--      SAME statement and the sum this verifier takes at the end of it is
--      complete. The two-statement write is refused and the one-statement write
--      COMMITS, under `SET CONSTRAINTS ALL IMMEDIATE`, in the same transaction
--      and the same fixture --
--      `tests/integration/phase4-s7-installment-concurrency-db.test.ts` carries
--      both halves. A declaration whose reader can do nothing is worse than no
--      declaration; this one ends with a statement they can write.

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;


-- ── 3b. THE OPERATOR'S REMEDY INDEX — WHERE A LOGGED REFERENCE POINTS ────
--
-- WHY THIS SECTION EXISTS (`TL-P4-COORD-R69` §1 and ordered item 1, which
-- NARROWS `TL-P4-COORD-R63` item 4). `R63` item 4 found that the remedies
-- written into these refusals reached nobody: `GlobalExceptionFilter` answers
-- every registered `installment.*` name `500 INTERNAL_ERROR` with a generic
-- body and no `details` — correctly, none of this vocabulary is in any
-- localization catalogue — and the log line carried the invariant NAME alone.
-- Round 16 repaired that by logging the refusal's FIRST LINE, and that is a
-- leak of a class the filter's own rule names earlier in the same file than
-- the branch that logged it (`apps/api/src/common/error.filter.ts:151-153`):
-- «SQL, THE
-- ROUTINE'S MESSAGE AFTER THE COLON, AN AMOUNT, a journal entry id, an
-- assertion body and a stack never leave the process». A LOG LINE LEAVES THE
-- PROCESS. EIGHT of the thirteen registered names substitute `business_id`
-- plus an invoice or plan UUID into that first line, and
-- `installment.schedule_incomplete`'s two-cause line substitutes TWO AMOUNTS.
--
-- SO THE LOG CARRIES A NAME AND AN ANCHOR, AND THE PROSE LIVES HERE. The
-- anchor is STATIC — identical for every occurrence of the invariant, a
-- function of the name alone, resolved from a table in
-- `apps/api/src/modules/selling/selling-errors.ts` — so an operator reading
-- `{ invariant, remedy }` has the whole remedy one lookup away and the
-- refusal's own figures never leave the process at all.
--
-- WHAT IS MEASURED ABOUT THIS SECTION, AND WHAT IS NOT. That every registered
-- invariant HAS an entry, that each anchor occurs EXACTLY ONCE in this file,
-- inside this section, on a line that also names its invariant, and that the
-- rendered log line carries the reference while neither the message nor the
-- identifiers reach the log or the body — all of that is asserted by
-- `tests/guards/p4s7-installment-filter-contract.test.ts`. THE REMEDIES
-- THEMSELVES ARE PROSE AND NO INSTRUMENT EXECUTES THEM: each is derived from
-- what this file's own refusal says and from the mechanism the surrounding
-- section states, and each is therefore DESIGN ONLY as a procedure. An
-- operator is told what state was observed and what the shipped mechanism
-- says about it; nobody has run these steps against a cluster as a drill.
--
-- [p4s7-remedy-01] installment.plan_fact_unreadable
--   OBSERVED: open invoices of this customer carry
--   `has_active_installment_plan` true while this caller can read no active
--   plan for them, so their schedules cannot be aged — and must not be aged
--   at the invoice due date instead, which is the silent omission the column
--   alone would leave.
--   DO: list those invoices, then read `installment_plans` for an active plan
--   under the same `business_id` as a principal that bypasses row security.
--   IF THE PLAN IS THERE, the caller's policies are subtracting it: compare
--   `app_business()` against the invoice's `business_id` and check section
--   2a's policies are the shipped ones. IF THERE IS NO PLAN, the fact is
--   stale, which section 3a's deferred verifier refuses at COMMIT — so a
--   write reached the column without the triggers: go to
--   `p4s7-remedy-09`.
--
-- [p4s7-remedy-02] installment.plan_fact_unflagged
--   OBSERVED: an active plan this caller CAN read whose own invoice carries
--   `has_active_installment_plan` false, which would age the schedule and the
--   whole figure both — the double count.
--   DO: section 3a's deferred verifier makes this state unreachable at COMMIT,
--   so a live occurrence is evidence that the fact triggers were not firing
--   when the plan was written. Go to `p4s7-remedy-09`, then re-derive the
--   column for the affected invoices in one transaction so the verifier
--   judges the end state.
--
-- [p4s7-remedy-03] installment.plan_schedule_unreadable
--   OBSERVED: an active plan this caller can read does not satisfy section 3
--   obligation (a) over the rows it can read — either no `installments` row
--   is readable at all, or the readable down payment plus instalments does
--   not equal the invoice's own `total_txn_minor`.
--   DO: re-take the same sum as the routines' owner. IF IT SUMS, the caller's
--   row security is hiding instalment rows (section 2a). IF IT DOES NOT, the
--   invoice total moved after the schedule was last judged — which the
--   `invoices` arm of section 3 now governs — so correct the schedule or the
--   total in ONE transaction, exactly to the equality; obligation (a) is an
--   `<>` comparison and refuses both directions.
--
-- [p4s7-remedy-04] installment.schedule_incomplete
--   OBSERVED: one of (a) the exact sum law, (b) at least one instalment row,
--   (c) `seq_no` contiguous from 1, (d) the declared ceiling of 60. The
--   message names which.
--   DO, FOR (a) WITH NO INSTALMENT ROW AT ALL ON A PLAN'S OWN `INSERT`: TWO
--   STATES REACH IT AND THE REMEDY DIFFERS, and PostgreSQL exposes no reading
--   that tells them apart, which is why this entry names both instead of
--   asserting one.
--     (1) THE DEFERRAL WAS REMOVED. This verifier is created DEFERRABLE
--         INITIALLY DEFERRED, and `SET CONSTRAINTS ALL IMMEDIATE` —
--         unprivileged SQL either app role may issue — makes it fire at the
--         end of the plan INSERT statement instead of at COMMIT, which is
--         BEFORE any `installments` row can exist, because
--         `installments.plan_id` references the plan and the plan must be
--         written first. NOTHING IS WRONG WITH THE SCHEDULE IN THAT CASE and
--         no data is bad. Either stop issuing `SET CONSTRAINTS ALL IMMEDIATE`
--         before a plan write, or issue it AFTER the write, or write the plan
--         and its whole schedule in ONE statement — a DATA-MODIFYING CTE —
--         which this verifier accepts under the removed deferral because both
--         relations' AFTER-ROW events then belong to the same statement.
--     (2) THE PLAN REALLY HAS NO SCHEDULE. Write its instalments in the same
--         transaction, summing with `down_payment_minor` to the invoice total
--         exactly.
--   DO, FOR (a) OTHERWISE: the schedule and the invoice total disagree. Fix
--   whichever is wrong in one transaction; see `p4s7-remedy-03`.
--   DO, FOR (b): an active plan with no instalments is not a schedule; write
--   them or cancel the plan.
--   DO, FOR (c): `seq_no` must be contiguous from 1 within the plan.
--   DO, FOR (d): the ceiling is the DECLARED policy constant of section 3(e)
--   and not a convention; a longer schedule needs that policy changed, not
--   this routine relaxed.
--
-- [p4s7-remedy-05] installment.plan_fact_blind
--   OBSERVED: this transaction wrote a plan and the verifier can read neither
--   it nor its index-independent count — with the index explanation EXCLUDED
--   by a `pg_index` reading taken inside the same event, which is why this
--   name and not `p4s7-remedy-12`.
--   DO: the remaining candidate is row security on `installment_plans` for
--   the writing principal. Check that section 2a's policies are the shipped
--   ones and that `app_business()` is set to the plan's own `business_id` for
--   the connection that wrote it. Nothing committed.
--
-- [p4s7-remedy-06] installment.plan_fact_desynchronised
--   OBSERVED: at COMMIT, `invoices.has_active_installment_plan` disagrees
--   with `installment_plans` for that invoice.
--   DO: nothing partial committed — the transaction is refused whole. Find
--   the statement that moved one side without the other; a direct
--   `UPDATE invoices SET has_active_installment_plan` outside section 3a's
--   sync is the usual cause, and section 2c grants that column to
--   `daftar_accounting_internal` precisely so the sync is the only writer.
--
-- [p4s7-remedy-07] installment.plan_active_conflict
--   OBSERVED: the status transition this transaction wrote leaves the
--   invoice's plan population and its fact disagreeing, or a second plan
--   active on one invoice.
--   DO: complete or cancel the existing active plan in the SAME transaction
--   before activating another; section 3a-bis's exclusion refuses the overlap
--   at the statement and the fact verifier refuses it at COMMIT.
--
-- [p4s7-remedy-08] installment.plan_active_unbounded
--   OBSERVED: an invoice carries MORE THAN ONE active plan that this caller
--   can read, and `installment_plans_one_active_per_invoice_uq` admits at
--   most one. A count can only UNDER-report under row security, so this is
--   never a blinded reading: the partial unique index is present-but-
--   unenforcing (`indisvalid`/`indisready` false) or gone.
--   DO: `REINDEX INDEX installment_plans_one_active_per_invoice_uq` — or
--   re-create it if it is absent — then reduce each affected invoice to ONE
--   active plan. The reader's per-plan arithmetic is predicated on the bound:
--   with two plans the schedule union overshoots the invoice total, the
--   settlement levels saturate at it, and every share after the first
--   collapses to zero, which serves the PRE-INSTALLMENT figure silently.
--
-- [p4s7-remedy-09] installment.plan_fact_untrusted
--   OBSERVED: one or more of the SEVEN triggers that maintain and verify
--   `invoices.has_active_installment_plan` and section 3 obligation (a) is
--   not installed on its own relation under its own name against its own
--   routine with `pg_trigger.tgenabled = 'O'` — missing, renamed,
--   re-pointed, or carrying `D`, `R` (replica-only, which is silence for
--   every ordinary session) or `A`.
--   DO: compare `pg_trigger` against the seven `(relation, trigger name,
--   routine)` triples section 2b part 9 enumerates, and re-create or
--   `ENABLE` the one that differs. This state is OWNER-ONLY reachable, by
--   `ALTER TABLE ... DISABLE TRIGGER` or by DDL on the triggers themselves,
--   so what produced it is a DDL change and not anything a request did. The
--   figure is refused rather than served while it holds, and an extra
--   conforming trigger cannot pay for a disabled real one because the
--   reading is an ENUMERATION and not a total.
--
-- [p4s7-remedy-10] installment.plan_index_disagrees
--   OBSERVED: two readings of the SAME rows in the same transaction disagree
--   — one taken by an access path the partial index can serve and one it
--   cannot — which means the index holds no entry for a row that qualifies
--   for it. That is an index PRESENT AND NOT ENFORCING while every flag reads
--   true.
--   DO: `REINDEX INDEX installment_plans_one_active_per_invoice_uq` and
--   retry. Nothing committed. The instrument works because that index is
--   PARTIAL; it does not transfer to `installments_plan_schedule_idx`, whose
--   physical half is apply-time and CI `REINDEX` (section 3).
--
-- [p4s7-remedy-11] installment.plan_fact_unordered
--   OBSERVED: read out of `pg_trigger` inside the event, the enabled trigger
--   that executes `installment_plan_fact_sync` on `installment_plans` sorts
--   AFTER the deferred fact verifier's trigger. With the deferral removed by
--   `SET CONSTRAINTS ALL IMMEDIATE`, PostgreSQL fires one relation's
--   immediate AFTER ROW triggers in TRIGGER-NAME ORDER, so the verifier runs
--   before the writer and would refuse a LAWFUL write under
--   `p4s7-remedy-06`'s name.
--   DO: it FAILS CLOSED — no wrong fact commits. Either stop issuing
--   `SET CONSTRAINTS ALL IMMEDIATE` around a plan write, or restore the
--   shipped trigger NAMES so the writer sorts first. The subject is catalogue
--   data no session can write; only DDL by the table owner moves it.
--
-- [p4s7-remedy-12] installment.plan_index_unenforcing
--   OBSERVED: an index of `installment_plans` or of `installments` carries
--   `indisvalid`, `indisready` or `indislive` false, read out of `pg_index`
--   inside the failing event. Every figure in the sentence that precedes this
--   one in the refusal may be an artifact of that: entries can only be
--   ABSENT, so a sum read through such an index UNDER-reports.
--   DO: `REINDEX` the indexes the refusal names, then retry. This is the
--   state an interrupted `CREATE INDEX CONCURRENTLY` or
--   `REINDEX CONCURRENTLY` leaves, and `pg_indexes` renders it IDENTICALLY to
--   a correct index — which is why the state is refused rather than inferred
--   from a figure.
--
-- [p4s7-remedy-13] installment.plan_fact_unwritable
--   OBSERVED: section 3a's sync could not write the fact — either the plan
--   was moved between businesses, which the invoice that carries its fact is
--   keyed on and which is therefore refused outright, or the write of
--   `invoices.has_active_installment_plan` did not land.
--   DO: for the move, re-create the plan under the right business rather than
--   re-keying it. For the write, check section 2c's COLUMN grant of
--   `has_active_installment_plan` to `daftar_accounting_internal`: without it
--   the sync can never land and every plan write refuses.
--

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
--      AND THAT SENTENCE WAS ITSELF OVER-CONFIDENT, WHICH IS WHAT ROUND 11
--      COST (`TL-P4-COORD-R50`). «A second ACTIVE plan on one invoice is
--      UNREACHABLE» is true of an ENFORCING index and not of a PRESENT one.
--      With `indisvalid` and `indisready` false the index object stands,
--      `pg_indexes` renders it identically, part 9 certified it -- and it
--      maintained nothing, so two ORDINARY CONCURRENT plan creations
--      committed two active plans on one invoice and the reader served the
--      pre-installment figure byte-identical to the no-plan answer, with no
--      refusal at all. Single threaded the same fault IS refused; concurrency
--      was load-bearing for the harm.
--
--      SO THE STATE «TWO ACTIVE PLANS» IS NO LONGER CALLED UNREACHABLE. It is
--      MEASURED, as a `count(*)` over the rows the transaction can see, in
--      three places -- this writer, the deferred verifier, and the reader's
--      fourth count -- and each of them RAISES
--      `installment.plan_active_unbounded` rather than deciding anything. A
--      blinded count can only UNDER-report, so «I can see two» is a fact row
--      security cannot manufacture, which is why the refusal is permitted in
--      that direction and in no other. Part 9 additionally reads
--      `indisvalid`, `indisready` and `indislive` at APPLY time, and section
--      3a-ter takes the INVOICE ROW LOCK FIRST so that the cross-transaction
--      race is refused by name without the index entering the argument at all.
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
--     round 11). The round-11 challenger then reached the SAME committed state
--     with ONE statement and NO policy fault -- `ALTER TABLE
--     installment_plans DISABLE TRIGGER USER` -- so the fault COUNT was wrong
--     here, though the PRIVILEGE was not: that statement needs the table
--     owner. It FAILS CLOSED at read time, by name, and since
--     `TL-P4-COORD-R50` the reader also refuses
--     `installment.plan_fact_untrusted` on the DISABLED TRIGGER ITSELF rather
--     than only on its downstream consequence, and part 9b refuses the
--     migration in that state instead of certifying it sound. STILL OPEN as
--     an escape; no longer CERTIFIED ABSENT.
--   * Entry 4 is undetectable by construction, as stated there.
--   * CONCURRENCY -- NO LONGER OPEN IN THE SHAPE IT WAS WRITTEN IN, and the
--     correction is the whole of round 12. The round-11 challenger ran the
--     first two-writer measurements and found that the partial unique index
--     is what serialises the two `active` inserters, that it holds at all
--     three isolation levels -- AND THAT IT IS THE ONLY THING THAT DOES, so
--     with the index present-but-unenforcing both writers committed and the
--     reader served the pre-installment figure silently. What answers now:
--     the INVOICE ROW LOCK of section 3a-ter at `READ COMMITTED` (the loser
--     blocks, re-reads on a fresh snapshot and is refused
--     `installment.plan_active_conflict`); `40001` at `REPEATABLE READ` and
--     `SERIALIZABLE`; the SYNC's own `count(*)` with the BEFORE trigger
--     DROPPED and the index NOT ENFORCING, which refuses
--     `installment.plan_active_unbounded` (measured); and the reader's fourth
--     count in a later transaction, which is total because it reads committed
--     rows. The loser is therefore NOT handed a serialisation failure dressed
--     as a blinded read, which was this entry's question.
--
--     AND ONE THING THIS ROUND EXPECTED AND DID NOT FIND. The deferred
--     verifier's `count(*)` was written as the arm that catches two writers
--     who never blocked -- and no such pair exists. `installment_plan_fact_
--     sync` is an AFTER ... FOR EACH ROW trigger that WRITES `public.
--     invoices`, so two `active` writers on ONE invoice take a row lock on
--     the SAME invoice row inside their own statements whether or not the
--     BEFORE trigger of section 3a-ter exists and whether or not the index
--     enforces. Dropping the BEFORE trigger does not remove the
--     serialisation; it moves it later in the statement, from a declared
--     `FOR NO KEY UPDATE` to the sync's `UPDATE`. (That is the strongest
--     argument for the BEFORE trigger: the row is taken anyway, so it should
--     be taken FIRST, in `P4-AL-41` order, rather than halfway through.)
--     The deferred arm is therefore retained as the belt to the sync's
--     braces, and its reachability UNDER CONCURRENCY is UNMEASURED -- not
--     because the measurement was skipped, but because no ordinary
--     interleaving of two plan writes on one invoice reaches COMMIT with two
--     active plans.
--
--     WHAT CONCURRENCY LEAVES OPEN: never more than TWO writers; no barrier
--     INSIDE the commit sequence (there is no hook to pause a backend between
--     its last statement and its deferred triggers, which is also why the
--     paragraph above could not be turned into a measurement); and `40P01` on two
--     invoices locked in opposite order, which section 3a-ter declares as the
--     caller obligation `P4-AL-41` rank 3 states and which `gate:phase4:s8`
--     owns the N-run proof of. This slice ships no plan command for that gate
--     to govern yet.
--   * `TRUNCATE` apart, the OTHER trigger-silencing routes are now
--     MEASURED rather than listed: `session_replication_role = replica` would
--     silence every `'O'` trigger in a session with NO DDL at all, and it is
--     a `superuser`-context GUC -- `daftar_app` and `daftar_migrator` are each
--     refused `42501 permission denied to set parameter` on `SET`, on `SET
--     LOCAL` and on `set_config`, directly and after `SET ROLE
--     daftar_accounting_internal`. `DISABLE TRIGGER ALL` and `NO FORCE ROW
--     LEVEL SECURITY` remain UNMEASURED as faults, and both need the owner.
--   * THE DIGEST COUPLING of part 6b: any edit to any of the five routine
--     bodies must carry the new `sha256`, or the migration will not apply.
--     `packages/domain-core/test/phase4-s7-installment-aging.test.ts` H7
--     asserts the coupling so a stale constant reds a test rather than a
--     deployment, and `scripts/guards/p4s7-body-digests.ts` prints the
--     replacements. This is a DELIBERATE cost, declared, not a hazard
--     discovered later.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION installment_plan_fact_assert(p_unreadable_plan BIGINT,
                                                        p_unflagged_plan BIGINT,
                                                        p_unreadable_schedule BIGINT,
                                                        p_unbounded_plan BIGINT,
                                                        p_untrusted_fact BIGINT)
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
  -- ---- THE FOURTH COUNT: THE BOUND THE ARITHMETIC ABOVE IS PREDICATED ON
  --      (`TL-P4-COORD-R50` ordered items 1 and 2).
  --
  -- THIS IS THE READ-TIME HALF OF THE RUNTIME GUARD, and it exists because
  -- the reader's arithmetic was predicated on the SAME premise as the
  -- writer's derivation and neither measured it. `customer_ar_aging`'s
  -- `visible_schedule` CTE says so in its own words -- «At most one row per
  -- invoice, because `installment_plans_one_active_per_invoice_uq` makes at
  -- most one plan active per invoice, so joining it below multiplies
  -- nothing». With TWO active plans it yields two rows per invoice, each one
  -- summing to the invoice's declared total, so `p_unreadable_schedule`
  -- counts ZERO, this routine passed 0/0/0, the schedule union overshot the
  -- invoice by a factor of two, and `L(c) = least(greatest(c, paid), T)`
  -- saturated at `T` so every share after the first collapsed to nothing. The
  -- caller was served the PRE-INSTALLMENT figure, byte-identical to the
  -- no-plan answer, with no refusal at all (round-11 challenger F-1).
  --
  -- IT IS A COUNT AND NOT A CATALOGUE READING, deliberately. Reading
  -- `pg_index.indisvalid` here would answer «the index says it is enforcing»,
  -- which is a different sentence from «no invoice of this customer carries
  -- two active plans» -- and it is the second sentence the arithmetic needs.
  -- The count is also the one direction row security cannot fake: policies
  -- subtract rows, so a blinded count UNDER-reports, and «I can see two» is
  -- therefore never manufactured by blindness. Part 9 of section 2b reads the
  -- three catalogue flags at APPLY time, where that is the honest instrument;
  -- this is the runtime one.
  IF p_unbounded_plan <> 0 THEN
    RAISE EXCEPTION 'installment.plan_active_unbounded: % of this customer''s open invoices carry more than one active installment plan this caller can read, and installment_plans_one_active_per_invoice_uq admits at most one. This reader ages an invoice ACROSS ONE schedule and its arithmetic is predicated on there being one: two would make the schedule union overshoot the invoice total, the settlement levels saturate at it, and every share after the first collapse to zero -- which serves the pre-installment figure silently. A count can only UNDER-report under row security, so this is not a blinded reading; the partial unique index is present-but-unenforcing (indisvalid/indisready false) or gone',
      p_unbounded_plan USING ERRCODE = 'P0001';
  END IF;
  -- ---- THE FIFTH COUNT: THE SEVEN TRIGGERS THAT MAKE THE FACT A FACT
  --      (`TL-P4-COORD-R50` ordered item 3).
  --
  -- `invoices.has_active_installment_plan` is a DERIVED bit, and everything
  -- that makes it true rather than merely present is a trigger: the sync that
  -- writes it, the deferred verifier on both sides of it, the exclusion that
  -- bounds the plan relation, and the three schedule-completeness triggers
  -- that make obligation (a) exact -- SEVEN in all. `tgenabled` occurred ZERO
  -- times in this specification until this round, in the end-state block and
  -- here alike, so all seven could be DISABLED and the 29-raise apply-time
  -- ratchet still returned OK (round-11 challenger F-2). One statement,
  -- `ALTER TABLE installment_plans DISABLE TRIGGER USER`, then committed
  -- `{flag: false, active plan: 1}` with no policy fault at all.
  --
  -- THE ESCAPE STAYS DECLARED; WHAT GOES IS THE CERTIFICATION THAT IT IS
  -- ABSENT. Section 2c's own comment on the column declares a disabled
  -- trigger as a state and not a hypothesis and says the READ refuses such a
  -- state rather than serving a figure. It did not: nothing anywhere read
  -- `tgenabled`. This count is what makes that declaration true, and the
  -- state it names is owner-only reachable -- MEASURED this round, not
  -- assumed: `session_replication_role` is a `superuser`-context GUC and
  -- `daftar_app` and `daftar_migrator` are both refused `42501 permission
  -- denied to set parameter` on `SET`, `SET LOCAL` and `set_config`, before
  -- and after `SET ROLE daftar_accounting_internal`. So no ordinary principal
  -- can turn the triggers off without `ALTER TABLE`, which needs the owner.
  --
  -- IT IS AN ENUMERATION AND NO LONGER A COUNT (`TL-P4-COORD-R52` ordered
  -- item 3). The caller's fifth argument used to be
  -- `greatest(0, 7 - (the enabled triggers on the four routines))`, which
  -- pinned neither the trigger NAME nor the RELATION -- so ONE conforming
  -- extra trigger paid for ONE disabled real one, the number returned to 7,
  -- and this routine passed while the mechanism was broken. A count is not an
  -- identity. The caller now enumerates the seven `(relation, trigger name,
  -- routine)` triples and counts the ones that are not present and
  -- `tgenabled = 'O'`; `R` (replica-only, which is silence for every
  -- ordinary session) and `A` are refused as deliberately as `D`.
  --
  -- IT IS A CATALOGUE READ AND IT IS NOT THE RETIRED FAMILY. `TL-P4-COORD-R38`
  -- retired every construction that answers «CAN I SEE THE ROWS?» from inside
  -- the reader, because under row security that question has no answer a
  -- reader can give about itself. This asks «IS THE MECHANISM INSTALLED AND
  -- FIRING?», which has ONE answer for every caller: `pg_catalog` carries no
  -- row security, no policy can subtract a `pg_trigger` row, and the number is
  -- the same whoever asks. A property of the installation is not a property of
  -- the asker, and that is the whole of the distinction.
  IF p_untrusted_fact <> 0 THEN
    RAISE EXCEPTION 'installment.plan_fact_untrusted: % of the seven triggers that maintain and verify invoices.has_active_installment_plan and section 3 obligation (a) are not installed on their own relation under their own name against their own routine with pg_trigger.tgenabled = ''O'' -- missing, renamed, re-pointed, or carrying D (disabled), R (replica-only, which is silence for every ordinary session) or A. This count is an ENUMERATION of the seven and not a total, so an extra trigger cannot pay for a disabled one. The column this reader ages from is therefore no longer derived from the plan relation, or the schedule it ages across is no longer judged against the invoice total. A figure read from an unmaintained fact is not a figure. This state is owner-only reachable, by ALTER TABLE ... DISABLE TRIGGER or by DDL on the triggers themselves; it is declared in section 2c and it is refused here rather than served',
      p_untrusted_fact USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) IS
  'P4-S7 (TL-P4-COORD-R38 direction (d); challenger C1.a, third round). The three refusals customer_ar_aging owes once the no-plan arm is keyed on invoices.has_active_installment_plan instead of on a NOT EXISTS through the caller''s row security. It is NOT a visibility guard and the difference is structural: it READS NOTHING — no relation, no catalogue, no pg_policy, no has_table_privilege, no current_user — and it is TOLD five counts the CALLER computed rather than asked whether the caller can see anything. Its argument list is exactly five bigints, pinned by proargtypes in section 2b, so it cannot be asked about a row: five numbers name none. IT TOOK THREE COUNTS UNTIL TL-P4-COORD-R50 AND THREE WAS NOT ENOUGH, for a reason the three shared: all three compare the caller''s readings against each other or against the invoice row, and all three were predicated on premises nothing measured. The fourth, plan_active_unbounded, measures the premise the arithmetic itself names — at most one active plan per invoice — as a COUNT over the rows the caller can see, because row security can only subtract rows so a count can only UNDER-report and two visible active plans are therefore two active plans and never a blinded reading; with the partial unique index present-but-unenforcing the round-11 challenger committed two active plans from two ordinary concurrent writers and this reader served the pre-installment figure byte-identical to the no-plan answer with no refusal at all. The fifth, plan_fact_untrusted, counts the seven triggers that maintain the fact and judge obligation (a) and are not enabled: tgenabled occurred ZERO times in this specification until that ruling, so all seven could be disabled with the apply-time ratchet still reporting OK. That fifth count is a pg_catalog read and it is NOT the retired visibility family: pg_catalog carries no row security, no policy can subtract a pg_trigger row, and the number is the same for every caller — it asks whether the MECHANISM is firing, not whether the ASKER can see rows, and a property of the installation is not a property of the asker. SECURITY INVOKER, so it could see nothing the caller cannot see even if it looked. What it refuses, in order: plan_fact_unreadable, an invoice whose own row says it has an active plan while the caller can read none (the silent OMISSION that the column alone would leave); plan_fact_unflagged, a readable active plan whose invoice is not flagged (the DOUBLE COUNT, which section 3a''s deferred verifier already makes unreachable at COMMIT and which this refuses at read time anyway); plan_schedule_unreadable, a readable active plan whose readable down payment plus instalments does not equal the invoice''s own total_txn_minor (or which has no readable installments row at all); section 3 obligation (a) makes that equality exact, so a difference is proof of hidden instalment rows or of a total that moved after the schedule was last judged, and the three states that reach this count are named in the message rather than reduced to the one of them that is about existence. plan_active_unbounded, an invoice of this customer carrying more than one readable active plan, which is the bound this reader''s own per-plan arithmetic is predicated on and which nothing measured for eleven rounds; and plan_fact_untrusted, a trigger of the seven that is missing or disabled. Called at the ROOT of the projection, on invoice_checked, so it is a dependency of every row the reader can return rather than a property of one arm''s plan shape. STABLE; reads nothing; grants nobody anything.';

-- ...and the transfer last, for the reason section 3 records. Ownership is
-- about who may later ALTER it, not about authority: this routine is INVOKER
-- and grants its callers nothing.
ALTER FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) OWNER TO daftar_accounting_internal;

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
             AS unreadable_schedule,
           -- THE BOUND THE THREE COUNTS ABOVE ARE ALL PREDICATED ON
           -- (`TL-P4-COORD-R50` ordered items 1 and 2).
           --
           -- `visible_schedule` above states the predicate in its own words:
           -- «At most one row per invoice, because
           -- `installment_plans_one_active_per_invoice_uq` makes at most one
           -- plan active per invoice, so joining it below multiplies
           -- nothing». THAT IS AN ASSUMPTION AND THIS IS THE MEASUREMENT OF
           -- IT. With two active plans on one invoice the join DOES multiply:
           -- each of the two rows reads `visible_total = declared_total`, so
           -- `unreadable_schedule` counts ZERO, `unreadable_plan` and
           -- `unflagged_plan` count zero too, and the `sched` union below
           -- carries twice the invoice's money. The levels saturate at `T`
           -- and every share after the first collapses to nothing, so the
           -- caller is served the PRE-INSTALLMENT figure with no refusal --
           -- which the round-11 challenger reached from TWO ORDINARY
           -- CONCURRENT PLAN CREATIONS with the index present but not
           -- enforcing.
           --
           -- IT IS AN UNCORRELATED SCALAR AND NOT A `FILTER` OVER THE JOIN,
           -- because the join is exactly what multiplies in this state: a
           -- `FILTER` would count the invoice once per active plan and the
           -- number in the refusal would be the harm's own doubling. Grouped
           -- first, counted second.
           --
           -- A COUNT CAN ONLY UNDER-REPORT UNDER ROW SECURITY, so this may
           -- refuse on «two visible» and may never conclude anything from
           -- «one visible» -- the same discipline every reading in this file
           -- obeys.
           --
           -- AND IT NO LONGER READS `visible_plan`, WHICH IS THIS ROUND'S
           -- REPAIR (`TL-P4-COORD-R52` ordered item 1, F-2). `visible_plan`
           -- restricts `status = 'active'` in its `WHERE`, which is the
           -- PREDICATE OF `installment_plans_one_active_per_invoice_uq`
           -- ITSELF, so this count was answered FROM the partial index whose
           -- enforcement it exists to measure: with the index present and
           -- `indisready = false` alone it read ONE where the heap held TWO,
           -- and this reader served a figure over two active plans with no
           -- refusal -- the round-11 harm, alive and now invisible. The
           -- status test is therefore in a `FILTER` and the scan carries NO
           -- status qualifier, which makes the partial index UNUSABLE for
           -- this query by the implication rule rather than by the planner's
           -- preference. The arithmetic below still reads `visible_plan`,
           -- because the arithmetic is about the plan it ages and not about
           -- the bound; if the index under-reports there, THIS count
           -- over-reports here and the read is REFUSED, which is the
           -- direction that fails closed. PROVEN BY EXECUTION in
           -- `tests/integration/phase4-s7-installment-fact-db.test.ts`: a
           -- `RETURNS TABLE` SQL routine is not inlined, so no `EXPLAIN` of a
           -- call shows this CTE, and the honest instrument for it is the
           -- refusal arriving in the state that used to serve a figure.
           (SELECT pg_catalog.count(*)
              FROM (SELECT p2.invoice_id
                      FROM public.installment_plans p2
                     WHERE p2.business_id = p_business_id
                       AND p2.invoice_id IN (SELECT i2.invoice_id FROM invoice_fact i2)
                     GROUP BY p2.invoice_id
                    HAVING pg_catalog.count(*) FILTER (WHERE p2.status = 'active') > 1) z)::BIGINT
             AS unbounded_plan,
           -- THE SEVEN TRIGGERS THAT MAKE THE FACT A FACT, READ AS CATALOGUE
           -- DATA (`TL-P4-COORD-R50` ordered item 3).
           --
           -- `tgenabled` occurred ZERO times in this specification until this
           -- round. Section 2c's own comment on the column declares a
           -- disabled trigger as «a state and not a hypothesis» and says the
           -- READ refuses such a state as `plan_fact_unreadable` or
           -- `plan_fact_unflagged` rather than serving a figure -- and the
           -- round-11 challenger measured that nothing read the flag at all,
           -- so one `ALTER TABLE installment_plans DISABLE TRIGGER USER`
           -- committed `{flag: false, active plan: 1}` with the apply-time
           -- ratchet still reporting OK. A slice may declare an escape it
           -- does not close; it may not also certify that the escape is
           -- absent.
           --
           -- A COUNT IS NOT AN IDENTITY, AND THIS USED TO BE A COUNT
           -- (`TL-P4-COORD-R52` ordered item 3, F-3). The previous reading was
           -- `greatest(0, 7 - (the enabled ones on these four routines))`,
           -- which pins neither `tgname` nor `tgrelid` -- so it was defeated
           -- by COMPENSATION: add ONE conforming extra trigger on any of the
           -- four routines, DISABLE one of the seven real ones, and the count
           -- returns to 7 while the mechanism is broken. The reader then
           -- served the full schedule figure in the exact state it refuses
           -- seven times out of seven on a clean fixture. `greatest` made the
           -- suppression SILENT rather than noisy, and the comment that
           -- argued for it («a LATER slice that adds an eighth trigger does
           -- not red this reader») designed the hole in.
           --
           -- SO THE SEVEN ARE ENUMERATED, EACH REQUIRED PRESENT AND ENABLED
           -- ON ITS OWN RELATION AND BOUND TO ITS OWN ROUTINE. Four things
           -- are pinned per row -- the RELATION, the TRIGGER NAME, the
           -- ROUTINE and `tgenabled` -- and the count is of the EXPECTED rows
           -- that are NOT satisfied. An eighth trigger pays for nothing,
           -- because nothing is subtracted; a RENAMED trigger is caught,
           -- because its expected name is then absent, which is the one thing
           -- the four-routine count was chosen for and did not do either; and
           -- an extra trigger still does not red this reader, which was the
           -- legitimate half of the `greatest` argument and is preserved
           -- without the hole. Section 2b part 9b refuses an eighth trigger
           -- at apply time, where a ratchet on this file's own statements
           -- belongs.
           --
           -- `tgenabled` HAS FOUR VALUES AND ONLY ONE PASSES, ENUMERATED
           -- DELIBERATELY: `O` fires for an ordinary origin session, `D` is
           -- disabled, `R` fires ONLY under `session_replication_role =
           -- replica` -- which is silence for every ordinary session, the
           -- harm with a different letter, and a value a `<> ''D''` law would
           -- have admitted -- and `A` always fires, which is strictly
           -- stronger than `O` and is nevertheless refused, because a trigger
           -- this file did not create that way is a trigger somebody altered.
           --
           -- NO `regprocedure` CAST and no `regclass` cast.
           -- `'public.installment_plan_fact_sync()'::regprocedure` RAISES when
           -- the routine is absent, which would turn a missing routine into an
           -- unrelated `42883` from the middle of an arithmetic CTE, and
           -- `'public.installments'::regclass` would do the same for a missing
           -- relation. Joined through `pg_class` and `pg_proc` BY NAME
           -- instead, so an absent routine or relation contributes zero
           -- satisfied rows and is counted as the harm it is.
           (SELECT pg_catalog.count(*)
              FROM (VALUES ('installment_plans', 'installment_plans_fact_sync',                'installment_plan_fact_sync'),
                           ('installment_plans', 'installment_plans_active_exclusive',         'installment_plan_active_exclusive'),
                           ('installment_plans', 'installment_plans_fact_verified',            'installment_plan_fact_verify'),
                           ('invoices',          'invoices_installment_fact_agrees',           'installment_plan_fact_verify'),
                           ('installment_plans', 'installment_plans_schedule_complete',        'installment_schedule_verify'),
                           ('installments',      'installments_schedule_complete',             'installment_schedule_verify'),
                           ('invoices',          'invoices_installment_schedule_complete',     'installment_schedule_verify'))
                     AS e(relname, tgname, proname)
             WHERE NOT EXISTS (SELECT 1
                                 FROM pg_catalog.pg_trigger t
                                 JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                                 JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
                                 JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
                                 JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace
                                WHERE NOT t.tgisinternal
                                  AND cn.nspname = 'public' AND fn.nspname = 'public'
                                  AND c.relname = e.relname AND t.tgname = e.tgname
                                  AND f.proname = e.proname AND t.tgenabled = 'O'))::BIGINT
             AS untrusted_fact
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
                                                       f.unreadable_schedule,
                                                       f.unbounded_plan,
                                                       f.untrusted_fact)
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
  'P4-S1, replaced by P4-S4 (0083, 0084) and by P4-S7 (P4-AL-05, P4-AL-13): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. Since P4-S7 an invoice under an ACTIVE installment plan is aged ACROSS ITS SCHEDULE instead of at its single invoice due date. The schedule is ordered oldest-scheduled-date-first — a DECLARED POLICY and not a derivation, because nothing stored records which instalment a payment settled — and its PREFIX sums are turned into cumulative settlement levels anchored at the authoritative paid figure and clamped at the invoice total: L(c) = least(greatest(c, paid), total). Each row''s transaction share is the difference of two consecutive levels, so the shares are exact integers, no rounding is performed on the transaction side, there is no residue to distribute, and the shares total the authoritative outstanding by telescoping rather than by reconciliation. Each row''s base carrying share is the SAME difference taken through supplier_ap_release(total_base, total_txn, level, share), the canonical cumulative carrying-value law (R-61, R-81, 0067:683) consumed and never re-implemented, so the base shares likewise total outstanding_base_minor EXACTLY and no per-instalment FX conversion and no source_to_base_rate is read: a read creates no realized FX (TL S7 §21). An amount the schedule does not declare is a residual aged at the invoice''s own due date, by its own closed form and never as outstanding minus the allocations. An invoice may now appear in SEVERAL buckets, so invoice_count is count(DISTINCT invoice_id) and the sum of invoice_count over the buckets may exceed the number of open invoices. There is no materialised aging table (P4-AL-06), no stored installment balance, no installment journal and no new reducer: an instalment collection is an ordinary payment allocated to the invoice. The routine does not read the clock (P4-AL-30) and is not IMMUTABLE, because the label is not a guard. INVOKER, reads through the caller''s row security, writes nothing. IT REFUSES FIVE STATES AND NOT THREE SINCE TL-P4-COORD-R50, and the two new ones are the premises its own arithmetic names: installment.plan_active_unbounded when an invoice of this customer carries more than one readable active plan — the bound installment_plans_one_active_per_invoice_uq is supposed to hold and which, with the index present-but-unenforcing, let two ordinary concurrent plan creations make this reader serve the pre-installment figure byte-identical to the no-plan answer with no refusal at all — and installment.plan_fact_untrusted when one of the SEVEN triggers that maintain the fact and judge obligation (a) is missing or carries pg_trigger.tgenabled <> ''O''. The fourth is a COUNT over the caller''s own visible rows, because row security can only subtract rows so a count can only under-report and two visible active plans are never a blinded reading. The fifth is a pg_catalog read and it is NOT the retired visibility family TL-P4-COORD-R38 closed: pg_catalog carries no row security, no policy can subtract a pg_trigger row, and the number is the same for every caller — it asks whether the MECHANISM fires, not whether the ASKER can see rows. EXECUTE: daftar_app and daftar_inventory_internal; this body also requires EXECUTE on supplier_ap_release, which patch request PR-6 owes.';

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
  -- THE TWO BODY DIGESTS (part 6b). `sha256` of the text between the `$fn$`
  -- quotes of each routine, as `pg_proc.prosrc` holds it. Maintained by
  -- `scripts/guards/p4s7-body-digests.ts`, and asserted against the file by
  -- `packages/domain-core/test/phase4-s7-installment-aging.test.ts` so that a
  -- stale constant reds a test rather than a deployment.
  -- THE SIX BODY DIGESTS (part 6b). `sha256` of the text between each
  -- routine's `$fn$` quotes, as `pg_proc.prosrc` holds it, hex-encoded.
  -- GENERATED by `scripts/guards/p4s7-body-digests.ts` from this very file,
  -- and asserted against it by
  -- `packages/domain-core/test/phase4-s7-installment-aging.test.ts`, so a
  -- stale constant reds a test rather than a deployment.
  --
  -- SIX AND NOT FIVE, AND THE COMPLETENESS IS NOW ENFORCED AND NOT ASSERTED
  -- (`TL-P4-COORD-R52` ordered item 4, F-6). This list covered FIVE of the
  -- six routines this file installs, and the one it left out was
  -- `installment_plan_fact_assert` -- THE SINGLE SITE OF FIVE OF THE READER'S
  -- REFUSALS. A stub conforming to every attribute part 7 pins (plpgsql,
  -- STABLE, SECURITY INVOKER, the pinned `search_path`, five BIGINTs, boolean
  -- return, owned by `daftar_accounting_internal`) whose body is
  -- `BEGIN RETURN true; END` passed every law in this block, and the reader
  -- then served a figure with a trigger disabled. The extractor's own comment
  -- said «a digest list that quietly covers four of five routines is worse
  -- than none» and the list was exactly that.
  --
  -- AND THE DECIDING INSTRUMENT IS NOW THE CATALOGUE AND NOT THIS FILE
  -- (`TL-P4-COORD-R55` ordered item 5, F13-5). The extractor
  -- (`scripts/guards/p4s7-body-digests.ts`) reads the `CREATE FUNCTION` heads
  -- out of this file with a REGEX and fails when it finds one this list does
  -- not name. That instrument was line-anchored, case-sensitive in its
  -- keyword spacing and single-space between tokens, and EIGHT VALID
  -- SPELLINGS of a head were invisible to it -- so a SEVENTH routine
  -- installed with this whole block reporting null, after which it could be
  -- replaced by a conforming stub no digest covers. The regex is kept as a
  -- BELT that reds earlier and in cheaper CI; what DECIDES is a reading of
  -- `pg_proc` before and after this file is applied, in
  -- `tests/integration/phase4-s7-installment-aging-db.test.ts`, whose law is
  -- that the routines the apply ADDED are exactly the signatures below. That
  -- subject is what the cluster ended up holding, so no spelling and no
  -- dynamic `EXECUTE` can hide from it. And part 6c below refuses an OVERLOAD
  -- of any pinned signature, which is the one shape a digest of a signature
  -- cannot see.
  c_bodies    CONSTANT TEXT[][] := ARRAY[
    ['public.installment_plan_fact_sync()',                       '613fd36bae4ab68830f0d8167fedf1eafe17729839579d13a7edcbefec72acf1'],
    ['public.installment_plan_fact_verify()',                     'd83b0657a3b9896eccfb66313ad5ca2bf9080158739bf5a9d1e6cb553e423f7c'],
    ['public.installment_plan_active_exclusive()',                '972604870115f80909906ebf4a184d2de56f3c3568c91d0a7b66d288778515c2'],
    ['public.installment_schedule_verify()',                      'c69837085b4386c24f939412a851c0b7d09d2e51ba0dda5182f90ccf1c8f8408'],
    ['public.installment_plan_fact_assert(bigint,bigint,bigint,bigint,bigint)', '61d797de3fcb5f8e7fdb687414e09a2d734de630bdd954c48995661708b122f6'],
    ['public.customer_ar_aging(uuid,uuid,date,integer[])',        '67a3dc0b0bff28b65d4472bdda8c8856e7bc90009d4c9cb1d589c56c1df1eefc']];
  -- The six routine NAMES of the list above, for part 6c's overload law. A
  -- second spelling of one list is a second definition of it, so these are
  -- the bare names and nothing else.
  c_routines  CONSTANT TEXT[] := ARRAY['installment_plan_fact_sync', 'installment_plan_fact_verify',
                                       'installment_plan_active_exclusive', 'installment_schedule_verify',
                                       'installment_plan_fact_assert', 'customer_ar_aging'];
  v_sha       TEXT;
  v_i         INTEGER;
  -- Part 9c's subject: the EXACT text of the index-independent count the sync,
  -- the deferred verifier and the reader take, with literals in place of the
  -- two parameters. A plan is read from it and the index must not be in it.
  c_plan_probe CONSTANT TEXT :=
    'EXPLAIN (COSTS OFF) SELECT pg_catalog.count(*) FILTER (WHERE p.status = ''active'')'
    || ' FROM public.installment_plans p'
    || ' WHERE p.business_id = ''00000000-0000-0000-0000-000000000000''::UUID'
    || '   AND p.invoice_id = ''00000000-0000-0000-0000-000000000000''::UUID';
  v_plan      TEXT;
  v_line      RECORD;
  -- `TL-P4-COORD-R55` ordered items 1, 2, 3, 4 and 7.
  v_detail    TEXT;      -- an observed catalogue state, named in a refusal
  v_writer_tg TEXT;      -- part 9e: the writer trigger's name, from pg_trigger
  v_verify_tg TEXT;      -- part 9e: the plan-side verifier trigger's name
  v_ix        TEXT;      -- part 9c/9d: one index name at a time
  v_heap      BIGINT;    -- part 9d: the FILTER-spelled count
  v_served    BIGINT;    -- part 9d: the same count, index-servable spelling
  v_seqscan   TEXT;      -- part 9c: `enable_seqscan` as it was BEFORE the read
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
  -- absence: five `bigint`s cannot name a row, a business or a tenant, so the
  -- routine cannot be asked a question about any of them -- while a widening
  -- to `(uuid, uuid, bigint)` would red this block. It was THREE bigints until
  -- `TL-P4-COORD-R50`; the fourth and fifth are the bound the reader's own
  -- arithmetic names and the seven triggers that make the fact a fact, and
  -- the ARITY is pinned here so that dropping one of them back out is a
  -- migration that will not apply. It is a structural bound
  -- on what the routine can receive, not a substring test on what it contains,
  -- and that distinction is the whole of `TL-P4-COORD-R38`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = 'public.installment_plan_fact_assert(bigint,bigint,bigint,bigint,bigint)'::regprocedure
       AND r.rolname = 'daftar_accounting_internal' AND NOT r.rolcanlogin
       AND NOT p.prosecdef AND p.provolatile = 's'
       AND p.prorettype = 'boolean'::regtype
       AND p.proargtypes = ARRAY['bigint'::regtype, 'bigint'::regtype, 'bigint'::regtype,
                                 'bigint'::regtype, 'bigint'::regtype]::oidvector
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plan_fact_assert is not a STABLE internal-owned INVOKER of exactly five bigints with the pinned path'
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
  -- THAT WAS TWO `prosrc` SUBSTRING TESTS AND IS NOW PART 6b's DIGEST, which
  -- is strictly stronger and is catalogue DATA: the digest fixes EVERY
  -- property of this body at once, including the two these tests named, and
  -- a body that re-implements the rounding cannot match it. `TL-P4-COORD-R50`
  -- §5 forbids answering a code property with another substring, and that
  -- applies to the laws this file already carried and not only to the ones
  -- the finding was about.
  -- AND THE NO-PLAN ARM IS KEYED ON THE INVOICE'S OWN COLUMN, not on a
  -- `NOT EXISTS` over `installment_plans` (challenger C1.a, THIRD round;
  -- `TL-P4-COORD-R38` direction (d)). The installed body must NAME the column
  -- and must NOT carry the retired guard's call -- and NEITHER OF THOSE IS
  -- ESTABLISHED BY A SUBSTRING ANY MORE. See 6b: the two laws that used to
  -- stand here, and the two text ratchets that used to stand below them, are
  -- replaced by ONE instrument that is catalogue DATA, plus the execution
  -- proof that owns the behavioural half. The retired guard's ABSENCE is
  -- already established, as the absence of a `pg_proc` row, at part 5 above.

  -- 6b. THE INSTALLED BODY IS THE BODY THIS FILE SHIPPED, BY DIGEST
  --     (`TL-P4-COORD-R46`'s structural ruling; `TL-P4-COORD-R50` §5 and
  --      ordered item 4)
  --
  --     THE RULING, RESTATED IN BOTH HALVES BECAUSE THIS FILE HAS NOW PAID
  --     FOR BOTH:
  --
  --      * A `prosrc LIKE` TEST CANNOT ESTABLISH A PROPERTY OF CODE. IT
  --        ESTABLISHES THE PRESENCE OF A STRING, AND A COMMENT IS A STRING.
  --        Round 10's challenger satisfied four such tests with the required
  --        tokens appearing ONLY INSIDE COMMENTS of an otherwise round-9
  --        body; the law returned OK and a blinded writer then COMMITTED
  --        `{flag: false, active plans: 1}`.
  --      * NOR CAN A `prosrc NOT LIKE` TEST ESTABLISH THE ABSENCE OF A
  --        PROPERTY, BECAUSE AN IDENTIFIER IS ALSO A STRING. Round 11's
  --        answer to the first half was to strip comments before matching,
  --        which closed the comment route and nothing else: round 11's
  --        challenger renamed `v_asserted` to `v_floor`, added ONE LIVE
  --        `OLD.status` assignment -- no comment, no dead code -- installed
  --        round 9's body with the ratchet reporting OK, and committed
  --        `{flag: false, active plan: 1}` which did not heal when the policy
  --        was restored.
  --
  --     SO THERE IS NO SUBSTRING PATTERN HERE, NOT A CLEVERER ONE AND NOT A
  --     NARROWER ONE. Two instruments are honest and this file now uses
  --     exactly them:
  --
  --      1. READ CATALOGUE DATA. The digest below is catalogue data: it is
  --         `sha256` of `pg_proc.prosrc`, compared against the digest of the
  --         text THIS FILE SHIPS. It does not claim the body is CORRECT --
  --         no apply-time instrument can -- it claims the body is THE ONE
  --         THAT WAS REVIEWED, which is the only thing a ratchet was ever
  --         for. A rename changes it. Dead code changes it. A comment
  --         changes it. Round 8's body, round 9's body, round 9's body with
  --         `v_asserted` renamed, and every future body that is not this one
  --         all change it, and none of them can be constructed to pass.
  --      2. PROVE BY EXECUTION. The property «the write set is DERIVED from
  --         the handed row and not decided by a blindable read» is
  --         BEHAVIOURAL, and the honest instrument for a behavioural property
  --         is to plant the defective body, blind the relation, and require
  --         the specific refusal. That needs a plan, an invoice and the
  --         invoice's whole foreign-key closure, so it lives in a suite with
  --         a fixture and cannot live in a migration's end-state block, which
  --         has neither. It is
  --         `tests/integration/phase4-s7-installment-fact-db.test.ts`, which
  --         reads the installed body out of `pg_proc`, plants round 8's body,
  --         round 9's body AND ROUND 9's BODY WITH `v_asserted` RENAMED
  --         beside it, and requires the refusal from the shipped one and a
  --         committed wrong fact from each predecessor.
  --
  --     WHAT THE DIGEST COSTS, STATED RATHER THAN DISCOVERED LATER. It is a
  --     MAINTENANCE COUPLING: any edit to either body -- including a
  --     whitespace change, including a comment -- must be accompanied by the
  --     new digest, or the migration will not apply. That is the point, and
  --     the text suite asserts the coupling in the other direction, so a
  --     stale constant is caught by a test and not by a failed deployment.
  --     It also means the migration owner must transcribe these bodies
  --     BYTE-FOR-BYTE; the refusal message says so.
  --
  --     AND THE RULING IS ABOUT THE INSTRUMENT AND NOT ABOUT THE TOKEN
  --     (`TL-P4-COORD-R52` ordered item 7). `~~` IS `LIKE` -- the operator
  --     the parser rewrites `LIKE` into -- `~~*` is `ILIKE`, and `SIMILAR
  --     TO`, `~`, `!~`, `position()`, `strpos()` and a `substring()` test are
  --     the same instrument under other names. A law that forbade the word
  --     `LIKE` forbade one spelling of the defect, so the absence law in
  --     `packages/domain-core/test/phase4-s7-installment-aging.test.ts` is
  --     now over the CLASS: every one of those spellings is caught, each is
  --     measured against the law that must catch it, and the shipped block is
  --     the control that passes. These names appear HERE in a comment, which
  --     is where a ruling is quoted; the law's subject is the block's SQL.
  --
  --     AND IT IS NOT A SELF-CERTIFICATION. The constant is the digest of a
  --     body a REVIEWER read; the subject is what a cluster actually has.
  --     The two are different objects, which is why comparing them is a law
  --     at all -- unlike a `prosrc LIKE`, where both sides came out of the
  --     same text.
  --     SIX ROUTINES AND NOT TWO. The two text ratchets covered the sync
  --     and the reader; the digest covers every routine this file installs,
  --     because the instrument costs one constant each and the two laws that
  --     used to establish `installment_schedule_verify`'s retired obligation
  --     (e) and `customer_ar_aging`'s consumption of the canonical rounding
  --     were substring tests of exactly the kind the ruling forbids. There is
  --     now no `prosrc LIKE` and no `prosrc NOT LIKE` anywhere in this block.
  FOR v_i IN 1 .. pg_catalog.array_length(c_bodies, 1) LOOP
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
      INTO v_sha
      FROM pg_proc p
     WHERE p.oid = c_bodies[v_i][1]::regprocedure;
    IF v_sha IS DISTINCT FROM c_bodies[v_i][2] THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: the installed body of % has sha256 % and this migration ships %, so the routine in this cluster is not the routine that was reviewed. This is an IDENTITY test on catalogue DATA and not a substring test: TL-P4-COORD-R46 ruled that a prosrc LIKE cannot establish a property of code because a comment is a string, and TL-P4-COORD-R50 §5 ruled that a prosrc NOT LIKE cannot establish an absence either, because an identifier is also a string -- a variable rename defeated the comment-stripping version of this law. A migration owner transcribing this specification must copy every routine body BYTE-FOR-BYTE between its dollar quotes. The digest does not claim the body is CORRECT and no apply-time instrument can: the behavioural proofs are the execution proofs in tests/integration/phase4-s7-installment-fact-db.test.ts, which plant round 8''s body, round 9''s body AND round 9''s body with v_asserted renamed to v_floor, and require the refusal from the shipped body and a committed wrong fact from each predecessor',
        c_bodies[v_i][1], v_sha, c_bodies[v_i][2] USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 6c. AND NO ROUTINE OF A PINNED NAME EXISTS THAT THE LIST DOES NOT PIN
  --     (`TL-P4-COORD-R52` ordered item 4).
  --
  --     A DIGEST OF A SIGNATURE SAYS NOTHING ABOUT AN OVERLOAD OF IT, and
  --     that is the one gap the round-12 challenger named in the digest law's
  --     favour («nothing about an added overload of a pinned signature»). An
  --     overload is reachable in principle by anybody who may create a
  --     function in `public` -- which `daftar_accounting_internal` may not,
  --     because `REVOKE CREATE ON SCHEMA public` is taken from it twice in
  --     this file -- and an overload of `installment_plan_fact_assert` taking
  --     five arguments of ANY type would be chosen over the pinned one by
  --     ordinary overload resolution for a call that casts its arguments.
  --
  --     SO THE LAW IS A CARDINALITY ON THE NAME and not a shape test on a
  --     signature: EXACTLY ONE routine per name in `public`, which is what
  --     this file creates. It counts by NAME, from `c_routines`, because the
  --     thing an overload defeats is the signature.
  FOR v_i IN 1 .. pg_catalog.array_length(c_routines, 1) LOOP
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = c_routines[v_i];
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: schema public carries % routines named %, and this file creates exactly one. Part 6b pins each routine''s body by the digest of its SIGNATURE, and an OVERLOAD of a pinned signature is invisible to that: a second installment_plan_fact_assert taking five arguments of other types would be chosen by ordinary overload resolution for a call whose arguments are cast, while every digest in this block still matched. A routine of one of these names that this file did not create is a second authority over the same decision',
        v_n, c_routines[v_i] USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

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
  --
  --    AND IT IS READ FOR WHETHER IT IS ENFORCING, WHICH THIS LAW DID NOT ASK
  --    UNTIL NOW (`TL-P4-COORD-R50` ordered item 2, F-1b). `indisvalid`,
  --    `indisready` and `indislive` occurred ZERO times in this
  --    specification. This law tested `indisunique`, `indpred` and the
  --    `relname` -- every property of the index's DEFINITION and none of its
  --    ENFORCEMENT -- so an index that is present, unique and partial on
  --    exactly the right predicate while being MAINTAINED BY NO DML satisfied
  --    every conjunct and bounded nothing. The round-11 challenger moved only
  --    those flags, left the index object in place, and measured: `pg_indexes`
  --    renders a definition INDISTINGUISHABLE from the correct one, this law
  --    returned OK, and two ordinary concurrent plan creations then committed
  --    two active plans on one invoice while `customer_ar_aging` served the
  --    pre-installment figure silently.
  --
  --    WHAT EACH FLAG MEANS, because three names for one idea is how a law
  --    comes to read the wrong one: `indisready` false means the index is not
  --    being UPDATED by DML; `indisvalid` false means it must not be used by
  --    queries and -- for a UNIQUE index -- its constraint is not enforced;
  --    `indislive` false means it is being dropped and must be ignored
  --    entirely. An interrupted `CREATE UNIQUE INDEX CONCURRENTLY` or
  --    `REINDEX CONCURRENTLY` is documented as leaving an index behind in
  --    exactly one of those states. All three are read, because the harm is
  --    the same whichever one is false and a law that reads two of three is a
  --    law with a third route through it.
  --
  --    IT IS STILL AN APPLY-TIME LAW AND THAT IS STILL NOT ENOUGH, and this
  --    round says so rather than leaving it implied: a `DO` block inside a
  --    migration answers ONCE, and the flags can move afterwards. The RUNTIME
  --    half is a COUNT over the rows the transaction can see -- in
  --    `installment_plan_fact_sync()`, in `installment_plan_fact_verify()`
  --    and in `customer_ar_aging`'s fourth count -- because «the catalogue
  --    says the index is enforcing» and «no invoice carries two active plans»
  --    are different sentences and only the second is the one anything here
  --    depends on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x
      JOIN pg_class c ON c.oid = x.indexrelid
     WHERE x.indrelid = 'public.installment_plans'::regclass
       AND c.relname = 'installment_plans_one_active_per_invoice_uq'
       AND x.indisunique AND x.indpred IS NOT NULL
       AND x.indisvalid AND x.indisready AND x.indislive
       AND pg_get_expr(x.indpred, x.indrelid) = '(status = ''active''::text)'
       AND pg_get_indexdef(x.indexrelid) LIKE '%(business_id, invoice_id)%'
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plans_one_active_per_invoice_uq is not a UNIQUE index on (business_id, invoice_id) partial on status = ''active'' WITH indisvalid, indisready and indislive all true, and installment_plan_fact_sync derives the invoice-borne fact from the handed row on the strength of exactly that bound. An index that is present, unique and partial on the right predicate while not being maintained by DML satisfies every definitional conjunct and enforces nothing, which is the state an interrupted CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY leaves and which pg_indexes renders identically to the correct one'
      USING ERRCODE = 'P0001';
  END IF;

  -- 9a. AND EVERY INDEX OF BOTH RELATIONS IS ENFORCING, NOT ONLY THAT ONE
  --     (`TL-P4-COORD-R55` ordered items 2 and 3, F13-2 and F13-3).
  --
  --     `installment_plans_pkey` occurred ZERO times in this specification.
  --     Part 9 above reads the three enforcement flags of exactly ONE index,
  --     and every other index of these two relations was unread by any law
  --     here. The consequence was measured in round 13: ONE flag on the
  --     PRIMARY KEY made every lawful plan write fail -- because
  --     `installment_plan_fact_sync()`'s blindness probe reads the handed row
  --     BY PRIMARY KEY, so a primary key not maintained by DML makes that
  --     read miss a row that exists -- under a name whose message said the
  --     cause was row security, while THIS BLOCK REPORTED OK and the reader
  --     served a figure.
  --
  --     TWO FURTHER READINGS DEPEND ON IT AND NOTHING SAID SO. The
  --     «index-independent» active-plan count is independent of the PARTIAL
  --     UNIQUE index -- which is a law, by the predicate-implication rule --
  --     and it is NOT independent of the primary key, which serves it in
  --     every statistics-free plan. So with BOTH indexes unenforcing the two
  --     counts under-report TOGETHER, agree, and `plan_index_disagrees` is
  --     silent. The generalisation is therefore the law and the single index
  --     was the special case: EVERY index of `installment_plans` and of
  --     `installments` must carry `indisvalid`, `indisready` and `indislive`
  --     true, and the refusal NAMES the offenders and their flags rather
  --     than reporting a count.
  --
  --     IT IS STILL AN APPLY-TIME LAW. The runtime halves are the three
  --     counts, the by-primary-key probe, and the `pg_index` reading those
  --     refusals now take before they attribute a cause.
  SELECT pg_catalog.string_agg(ic.relname || ' on ' || tc.relname
                               || ' (indisvalid=' || x.indisvalid::TEXT
                               || ', indisready=' || x.indisready::TEXT
                               || ', indislive=' || x.indislive::TEXT || ')', ', '
                               ORDER BY ic.relname)
    INTO v_detail
    FROM pg_index x
    JOIN pg_class ic ON ic.oid = x.indexrelid
    JOIN pg_class tc ON tc.oid = x.indrelid
   WHERE x.indrelid = ANY (SELECT ('public.' || y)::regclass FROM unnest(c_relations) y)
     AND NOT (x.indisvalid AND x.indisready AND x.indislive);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: these indexes of the P4-S7 relations are present and NOT ENFORCING: %. An index that is not maintained by DML satisfies every definitional conjunct and bounds nothing, and pg_indexes renders it identically to the correct one. installment_plan_fact_sync reads the handed row BY PRIMARY KEY to detect a blinded definer and takes its active-plan counts through this relation''s indexes, so a stale index of ANY name makes a read miss a row that exists -- which is why this law is over every index of both relations and not over installment_plans_one_active_per_invoice_uq alone', v_detail
      USING ERRCODE = 'P0001';
  END IF;

  -- 9e. AND THE WRITER'S TRIGGER SORTS BEFORE THE PLAN-SIDE VERIFIER'S, WHICH
  --     IS WHAT MAKES THE DEFERRAL'S REMOVAL HARMLESS TO THE FACT
  --     (`TL-P4-COORD-R55` ordered item 1, F13-1).
  --
  --     `SET CONSTRAINTS ALL IMMEDIATE` is unprivileged SQL any session may
  --     issue. It converts `installment_plans_fact_verified` into an ordinary
  --     immediate `AFTER ... FOR EACH ROW` trigger, and PostgreSQL fires the
  --     immediate `AFTER ROW` triggers of one relation for one event IN
  --     TRIGGER-NAME ORDER (`strcmp` over `pg_trigger.tgname`; byte order, no
  --     collation). While the verifier's name sorted FIRST -- it was called
  --     `installment_plans_fact_agrees` -- the verifier ran before the writer
  --     and refused a LAWFUL plan write `installment.plan_fact_desynchronised`,
  --     a false name rendered `500 INTERNAL_ERROR`.
  --
  --     ROUND 13 DETECTED THAT WITH A TRANSACTION-LOCAL CUSTOM GUC AND THE
  --     CALLER COULD WRITE IT -- one `SET LOCAL` falsely refused a lawful
  --     sale, another defeated the detector, a session-level `SET` disabled
  --     it for a pooled connection's life. The repair is the NAME, and this
  --     is the reading that keeps the name honest: the order is read from
  --     `pg_trigger`, which no `SET` can reach.
  --
  --     STRICTLY BEFORE, AND BOTH ROWS REQUIRED PRESENT. A missing writer or
  --     a missing verifier is already refused by 9b's cardinality; equal
  --     names are impossible on one relation; so the comparison is `<` and a
  --     NULL on either side reaches the raise.
  --
  --     AND IT READS THE PREMISE THE RUNTIME VERIFIER READS, NOT A WEAKER ONE
  --     (`TL-P4-COORD-R59` ordered item 10). The runtime read inside
  --     `installment_plan_fact_verify()` qualifies the writer row with
  --     `t.tgenabled = 'O'`; this one did not, so ONE PREMISE WAS READ TWO
  --     WAYS and the apply-time reading was the weaker of the two -- a
  --     DISABLED writer satisfied 9e and did not satisfy the runtime read.
  --     That it was harmless rested on part 9b, a DIFFERENT law, requiring all
  --     seven to be `'O'`; a law whose soundness rests on another law's
  --     coincidence is the unnamed-premise shape this slice keeps paying for.
  --     Both qualifications are now `tgenabled = 'O'` and the two readings are
  --     ONE reading. The remaining asymmetry is deliberate and is the opposite
  --     of slack: a NULL here RAISES (the migration may not finish without
  --     both triggers enabled), while a NULL writer at RUNTIME is section 2c's
  --     DECLARED escape, answered by `installment.plan_fact_untrusted` at read
  --     time and not by `plan_fact_unordered`. Apply time ratchets the state
  --     this file installs; runtime must be true of every state that reaches
  --     it.
  SELECT (SELECT pg_catalog.min(t.tgname) FROM pg_trigger t
            JOIN pg_proc f ON f.oid = t.tgfoid
            JOIN pg_namespace fn ON fn.oid = f.pronamespace
           WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
             AND fn.nspname = 'public' AND f.proname = 'installment_plan_fact_sync'
             AND t.tgenabled = 'O'),
         (SELECT pg_catalog.min(t.tgname) FROM pg_trigger t
            JOIN pg_proc f ON f.oid = t.tgfoid
            JOIN pg_namespace fn ON fn.oid = f.pronamespace
           WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
             AND fn.nspname = 'public' AND f.proname = 'installment_plan_fact_verify'
             AND t.tgenabled = 'O')
    INTO v_writer_tg, v_verify_tg;
  IF v_writer_tg IS NULL OR v_verify_tg IS NULL OR NOT (v_writer_tg < v_verify_tg) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the ENABLED (tgenabled = O) trigger executing installment_plan_fact_sync on installment_plans is named % and the enabled plan-side trigger executing installment_plan_fact_verify is named %, and the writer does not sort strictly before the verifier. (absent or not enabled) means pg_trigger carries no ENABLED non-internal trigger of that relation on that routine, which is the same qualification installment_plan_fact_verify() applies at runtime. PostgreSQL fires the immediate AFTER ROW triggers of one relation for one event in TRIGGER-NAME ORDER, and SET CONSTRAINTS ALL IMMEDIATE -- unprivileged SQL any session may issue -- makes that name order the firing order for the deferred verifier. In this name order the VERIFIER would run BEFORE THE WRITER and judge a fact nobody had written yet, which is how a LAWFUL plan write came to be refused installment.plan_fact_desynchronised and rendered 500 INTERNAL_ERROR',
      coalesce(v_writer_tg, '(absent or not enabled)'), coalesce(v_verify_tg, '(absent or not enabled)') USING ERRCODE = 'P0001';
  END IF;

  -- 9b. AND EVERY TRIGGER THIS SLICE INSTALLS IS ENABLED
  --     (`TL-P4-COORD-R50` ordered item 3, F-2).
  --
  --     `tgenabled` occurred ZERO times in this specification. Every trigger
  --     law in this block reads `tgrelid`, `tgfoid`, `tgtype`, `tgconstraint`,
  --     `tgdeferrable`, `tginitdeferred`, `tgisinternal` and `tgattr` -- the
  --     trigger's SHAPE, and never whether it FIRES. The round-11 challenger
  --     disabled each of the seven individually and re-ran the whole 29-raise
  --     block each time: OK in all seven. Then one statement, `ALTER TABLE
  --     installment_plans DISABLE TRIGGER USER`, removed the sync and the
  --     verifier together and an ordinary active plan COMMITTED
  --     `{flag: false, active plan: 1}` with this block still reporting OK.
  --
  --     THE ESCAPE IS NOT CLOSED HERE AND IS NOT CLAIMED CLOSED. `ALTER TABLE
  --     ... DISABLE TRIGGER` requires the table owner, and section 2c's
  --     comment on `has_active_installment_plan` DECLARES that route («a
  --     DISABLED trigger is a state and not a hypothesis … owner-only
  --     reachable and assigned to a later round»). What was wrong was not the
  --     declaration: it was that this block CERTIFIED the declared escape
  --     absent. A slice may declare an escape it does not close; it may not
  --     also certify that the escape is not taken.
  --
  --     MEASURED THIS ROUND, so «owner-only» is a reading and not a belief:
  --     `session_replication_role` -- which would silence every `O` trigger
  --     in a session with no DDL at all -- is a `superuser`-context GUC
  --     (`pg_settings.context = 'superuser'`), and `daftar_app` and
  --     `daftar_migrator` are each refused `42501 permission denied to set
  --     parameter "session_replication_role"` on `SET`, on `SET LOCAL` and on
  --     `set_config`, both directly and after `SET ROLE
  --     daftar_accounting_internal`. The boundary holds.
  --
  --     `'O'` AND NOT «NOT `'D'`». The four values are `O` (fires for
  --     ordinary origin sessions), `D` (disabled), `R` (replica only) and `A`
  --     (always). `R` would make these triggers silent in every ordinary
  --     session, which is the harm with a different letter, so the law pins
  --     the one value this file installs. `A` is STRICTLY STRONGER than `O`
  --     -- it fires under `session_replication_role = replica` too -- and is
  --     nevertheless refused here, because a trigger this file did not create
  --     that way is a trigger somebody altered, and the end state is a
  --     ratchet on THIS file's statements and not a search for the best
  --     available configuration.
  --
  --     SEVEN, COUNTED FROM THE FOUR ROUTINES. A count by routine catches a
  --     trigger ADDED on one of them, which is what an apply-time ratchet on
  --     this file's own statements is for. Three on
  --     `installment_schedule_verify()`, two on
  --     `installment_plan_fact_verify()`, one on
  --     `installment_plan_fact_sync()` and one on
  --     `installment_plan_active_exclusive()`.
  --
  --     AND THE READ-TIME LAW IS AN ENUMERATION, WHICH IS A DIFFERENT
  --     SENTENCE (`TL-P4-COORD-R52` ordered item 3, F-3). This law's earlier
  --     comment argued that a name list «would be satisfied by a renamed
  --     trigger», and that was BACKWARDS: a count by routine is satisfied by
  --     a renamed trigger and an enumeration by name is not. What a count
  --     cannot do is survive COMPENSATION -- one conforming extra trigger
  --     paying for one disabled real one, which defeated
  --     `customer_ar_aging`'s copy of this reading and let the reader serve a
  --     figure. The two laws are therefore different instruments and both are
  --     kept: HERE, a cardinality on the routines, which refuses an ADDITION
  --     at apply time; in the reader, the seven `(relation, trigger name,
  --     routine, tgenabled)` rows enumerated, which refuses an ABSENCE at
  --     read time and cannot be paid for.
  IF (SELECT pg_catalog.count(*) FROM pg_trigger t
        JOIN pg_proc f ON f.oid = t.tgfoid
        JOIN pg_namespace fn ON fn.oid = f.pronamespace
       WHERE NOT t.tgisinternal AND fn.nspname = 'public'
         AND f.proname IN ('installment_plan_fact_sync', 'installment_plan_fact_verify',
                           'installment_plan_active_exclusive', 'installment_schedule_verify')) <> 7 THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: the four P4-S7 trigger functions do not carry exactly seven non-internal triggers between them (found %), so one of the fact or schedule triggers is missing or one has been added that this file did not create',
      (SELECT pg_catalog.count(*) FROM pg_trigger t
         JOIN pg_proc f ON f.oid = t.tgfoid
         JOIN pg_namespace fn ON fn.oid = f.pronamespace
        WHERE NOT t.tgisinternal AND fn.nspname = 'public'
          AND f.proname IN ('installment_plan_fact_sync', 'installment_plan_fact_verify',
                            'installment_plan_active_exclusive', 'installment_schedule_verify'))
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
               JOIN pg_proc f ON f.oid = t.tgfoid
               JOIN pg_namespace fn ON fn.oid = f.pronamespace
              WHERE NOT t.tgisinternal AND fn.nspname = 'public'
                AND f.proname IN ('installment_plan_fact_sync', 'installment_plan_fact_verify',
                                  'installment_plan_active_exclusive', 'installment_schedule_verify')
                AND t.tgenabled <> 'O') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: % of the seven P4-S7 triggers carry pg_trigger.tgenabled <> ''O'' (%), so they are installed and do not fire for an ordinary session. invoices.has_active_installment_plan is a DERIVED bit and a trigger that does not fire leaves it unmaintained while every shape test in this block still passes',
      (SELECT pg_catalog.count(*) FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
         JOIN pg_namespace fn ON fn.oid = f.pronamespace
        WHERE NOT t.tgisinternal AND fn.nspname = 'public' AND t.tgenabled <> 'O'
          AND f.proname IN ('installment_plan_fact_sync', 'installment_plan_fact_verify',
                            'installment_plan_active_exclusive', 'installment_schedule_verify')),
      (SELECT pg_catalog.string_agg(t.tgname || '=' || t.tgenabled::TEXT, ', ' ORDER BY t.tgname)
         FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
         JOIN pg_namespace fn ON fn.oid = f.pronamespace
        WHERE NOT t.tgisinternal AND fn.nspname = 'public' AND t.tgenabled <> 'O'
          AND f.proname IN ('installment_plan_fact_sync', 'installment_plan_fact_verify',
                            'installment_plan_active_exclusive', 'installment_schedule_verify'))
      USING ERRCODE = 'P0001';
  END IF;

  -- 9c. AND THE COUNT THAT MEASURES THE INDEX IS NOT ANSWERED FROM THE INDEX
  --     (`TL-P4-COORD-R52` ordered item 1, F-2).
  --
  --     A `count(*)` IS NOT AN INSTRUMENT; A `count(*)` PLUS A QUERY PLAN IS.
  --     The three runtime counts this file added in the previous round were
  --     planned as `Index Only Scan using
  --     installment_plans_one_active_per_invoice_uq` -- identically with
  --     `enable_seqscan = off` -- because their predicate WAS that index's
  --     definition. So the guard built not to presuppose the index rested on
  --     it: with the index present and `indisready = false` alone, the count
  --     read ONE where the heap held TWO, a second active plan committed
  --     through the ordinary route, part 9's three flags all read TRUE, this
  --     whole block reported OK, and the reader served a figure over a state
  --     `REINDEX` then refused `23505`.
  --
  --     THE PREDICATE NOW LIVES IN A `FILTER` AND NOT IN THE `WHERE`, so a
  --     partial index on `status = 'active'` CANNOT answer the query: a
  --     partial index may be used only where the query's own qualifiers IMPLY
  --     its predicate, and a query that does not restrict `status` needs rows
  --     the index does not contain. That is a correctness rule of every
  --     planner and not a cost preference -- which is exactly why it may be
  --     rested on, and exactly why it is READ HERE anyway rather than
  --     believed. The round being repaired rested on a planner choice and
  --     nobody had read a plan.
  --
  --     `enable_seqscan = off` IS SET FOR THE READING, so the planner is
  --     pushed as hard as it can be towards an index before the question is
  --     asked -- AND IT IS RESTORED IMMEDIATELY AFTERWARDS, which the
  --     previous round got wrong: see (i) below.
  --
  --     IT IS ONE-DIRECTIONAL, AND THAT IS DELIBERATE. The law is «the plan
  --     does not name the partial unique index». The MIRROR half -- that the
  --     index-served spelling IS planned on that index, which is what makes
  --     this reading non-vacuous -- belongs in a test and not in a migration:
  --     it depends on the planner choosing between usable indexes, and a
  --     future release choosing the primary key instead would red a
  --     deployment over a state that harms nothing.
  --     `tests/integration/phase4-s7-installment-fact-db.test.ts` carries
  --     that half, on a populated fixture, with both knob settings and as two
  --     roles.
  --     AND THREE THINGS ABOUT THIS READING WERE WRONG, AND ARE REPAIRED
  --     HERE (`TL-P4-COORD-R55` ordered item 4, F13-4).
  --
  --     (i) `SET LOCAL enable_seqscan = off` LEAKED. A `DO` block is an
  --     anonymous code block and has no `proconfig`, so its `SET LOCAL` is
  --     NOT restored when the block exits: measured `on` before this block
  --     and `off` after it, for the rest of the MIGRATION'S OWN TRANSACTION
  --     -- every statement of part 10 and anything a transcriber puts after
  --     it, planned with sequential scans disabled. The previous value is now
  --     read first and restored immediately after the reading, with
  --     `set_config(..., true)`, which is `SET LOCAL`'s own mechanism and
  --     reverts with the transaction either way.
  --
  --     (ii) THE LAW NAMED ONE INDEX AND THE PROPERTY IS ABOUT A CLASS. A
  --     PARTIAL index may serve a query only where the query's own qualifiers
  --     IMPLY its predicate; a query that does not restrict `status` needs
  --     rows no `status = 'active'` index contains. That argument is about
  --     EVERY partial index of the relation, so the law is now: the plan
  --     names NO partial index of `installment_plans`. A second partial index
  --     added later cannot quietly become the thing that answers this count.
  --     The NON-partial indexes are a different matter and are deliberately
  --     NOT forbidden here: `installment_plans_pkey` does serve this count,
  --     the reading is not independent of it, and pretending otherwise was
  --     F13-3. What makes the primary key safe to be served by is part 9a,
  --     which reads its enforcement flags, and the by-primary-key probe in
  --     the writer, which refuses when that index misses a row.
  --
  --     (iii) `c_plan_probe` IS A TRANSCRIPTION AND ITS COUPLING TO THE BODY
  --     IS A LAW SOMEWHERE ELSE, WHICH IS STATED RATHER THAN IMPLIED. It is
  --     the body's query with literals in place of the two plpgsql
  --     variables, and nothing INSIDE this block can compare it to the body:
  --     the only instrument for that inside SQL is a `prosrc` substring
  --     function, which `TL-P4-COORD-R46` and `TL-P4-COORD-R50` §5 rule
  --     cannot establish a property of code and which this file's own H7 law
  --     forbids in this block in every spelling. So the coupling is enforced
  --     where the digest coupling is enforced -- over the FILE, in
  --     `packages/domain-core/test/phase4-s7-installment-aging.test.ts`,
  --     which extracts the `FILTER` count out of each of the three routine
  --     bodies and requires `c_plan_probe` to be exactly that text with the
  --     two parameters substituted. With part 6b's digests beside it a body
  --     cannot change without the digest changing, and the digest cannot be
  --     regenerated without that comparison running.
  --
  --     (iv) AND THE RESTORE IS NOW EXCEPTION-SAFE IN CODE RATHER THAN BY AN
  --     ABORT NOBODY STATED (`TL-P4-COORD-R59` ordered item 6, F14-7). The
  --     restore used to be a plain statement AFTER the reading, so a raise
  --     out of `EXECUTE c_plan_probe` itself would skip it. That was harmless
  --     -- any exception out of this block aborts the transaction and the
  --     setting reverts with it, measured -- but THE CODE DID NOT SAY SO, and
  --     a correctness that rests on an abort nothing names is the exact
  --     defect class fourteen rounds of this slice have been spent on. The
  --     reading is now wrapped and the handler restores and re-raises, so the
  --     property is a property of these statements. (The subtransaction a
  --     plpgsql exception block opens ALSO reverts a `set_config(..., true)`
  --     on rollback, which means the handler's restore is belt as well as
  --     code -- stated here so that this comment does not become the next
  --     unnamed premise.)
  v_seqscan := pg_catalog.current_setting('enable_seqscan');
  BEGIN
    SET LOCAL enable_seqscan = off;
    v_plan := '';
    FOR v_line IN EXECUTE c_plan_probe LOOP
      v_plan := v_plan || v_line."QUERY PLAN" || E'\n';
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('enable_seqscan', v_seqscan, true);
    RAISE EXCEPTION 'installment.migration_end_state_invalid: part 9c could not read the plan of the index-independent active-plan count at all -- EXPLAIN raised % (%). The reading that decides whether a guard measuring a partial index is itself answered BY a partial index therefore did not happen, and enable_seqscan has been restored to % before this refusal. A law that cannot read its subject is not a law',
      SQLSTATE, SQLERRM, v_seqscan USING ERRCODE = 'P0001';
  END;
  PERFORM pg_catalog.set_config('enable_seqscan', v_seqscan, true);
  IF v_plan = '' THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: EXPLAIN of the index-independent active-plan count returned no plan at all, so part 9c measured nothing. A law that cannot read its subject is not a law'
      USING ERRCODE = 'P0001';
  END IF;
  FOR v_ix IN SELECT ic.relname FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
               WHERE x.indrelid = 'public.installment_plans'::regclass AND x.indpred IS NOT NULL
               ORDER BY ic.relname LOOP
    IF pg_catalog.strpos(v_plan, v_ix) > 0 THEN
      RAISE EXCEPTION 'installment.migration_end_state_invalid: the index-independent active-plan count is planned ON the PARTIAL index % of installment_plans in this cluster, so a guard that measures whether a partial index is enforcing is answered BY a partial index and reports one where the rows say two. A partial index may serve only a query whose own qualifiers imply its predicate, and this query restricts no status at all, so this plan contradicts the rule the guard rests on. The plan read was: %',
        v_ix, v_plan USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 9d. AND AN INDEX PHYSICALLY DESCRIBES ITS OWN HEAP
  --     (`TL-P4-COORD-R55` ordered item 7, F13-9).
  --
  --     THERE WAS NO SUCH LAW ANYWHERE. Part 9 and part 9a read catalogue
  --     FLAGS, which is a different sentence: a row written while
  --     `indisready` was false leaves the flags perfect and the index missing
  --     an entry for a row that qualifies for it, for ever. Round 12's
  --     corruption was repaired with two executable `REINDEX` statements in
  --     two test teardowns -- and a measurement in a teardown is a fixture
  --     habit, not an invariant. `R53` §1 called the `REINDEX` «itself a
  --     measurement», which is exactly why it had to become a law.
  --
  --     TWO INSTRUMENTS, BECAUSE THEY ESTABLISH DIFFERENT THINGS. `REINDEX`
  --     rebuilds each index of both relations FROM THE HEAP, so it refuses
  --     `23505` when the heap does not satisfy a unique index -- the state
  --     «two active plans on one invoice», physically. And the two-path count
  --     compares the `FILTER` spelling against the index-servable spelling
  --     over EVERY row of the relation, which is the agreement an entry-level
  --     omission breaks. Neither is a catalogue flag.
  --
  --     IT IS VACUOUS AT APPLY TIME AND THAT IS DECLARED, NOT HIDDEN. This
  --     file creates both relations in the same transaction, so they are
  --     EMPTY here: the counts are 0 = 0 and the `REINDEX` rebuilds nothing.
  --     What the law buys at apply time is that the statements are legal and
  --     the indexes are rebuildable; the NON-VACUOUS arms are in the two
  --     integration suites, whose end-state cases run the same two readings
  --     over a POPULATED fixture after every mutation they make, which is
  --     where a round-12-shaped corruption would now red a law instead of
  --     being silently repaired by a teardown.
  --     AND THE COUNT COMES FIRST, BEFORE THE REBUILD. A `REINDEX` of a heap
  --     that violates a unique index raises `23505 could not create unique
  --     index`, which IS fail-closed but is a sentence about index creation
  --     and names no invariant of this slice. The two-path count is the
  --     reading that can say WHAT WAS OBSERVED and WHY IT MATTERS
  --     (`TL-P4-COORD-R55` ordered item 2), so it is taken first and the
  --     `REINDEX` is the physical corroboration behind it.
  --
  --     AND THE INDEX-SERVABLE SPELLING IS ASKED FOR ON THE INDEX PATH. Over
  --     a small heap a free planner sequential-scans both spellings, they
  --     agree, and the law measures nothing -- which is the shape of every
  --     defect these rounds have found. `enable_seqscan` is a COST and not a
  --     prohibition, so this biases the planner rather than commanding it,
  --     and the setting is SAVED AND RESTORED because a `SET LOCAL` in an
  --     anonymous `DO` block is NOT restored on exit -- a `DO` block has no
  --     `proconfig` -- which is exactly the leak part 9c shipped (F13-4).
  --     AND THIS RESTORE IS EXCEPTION-SAFE IN CODE TOO (`TL-P4-COORD-R59`
  --     ordered item 6, F14-7), on the same grounds and with the same
  --     disclosure: a raise out of either `count(*)` used to skip the
  --     restore, which was harmless only because the exception aborts the
  --     transaction, and nothing said that.
  v_seqscan := pg_catalog.current_setting('enable_seqscan');
  BEGIN
    PERFORM pg_catalog.set_config('enable_seqscan', 'off', true);
    SELECT pg_catalog.count(*) FILTER (WHERE p.status = 'active') INTO v_heap FROM public.installment_plans p;
    SELECT pg_catalog.count(*) INTO v_served FROM public.installment_plans p WHERE p.status = 'active';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('enable_seqscan', v_seqscan, true);
    RAISE EXCEPTION 'installment.migration_end_state_invalid: part 9d could not take the two-path active-plan count over installment_plans -- the reading raised % (%). The belt that compares the FILTER spelling against the index-servable spelling therefore did not happen, and enable_seqscan has been restored to % before this refusal',
      SQLSTATE, SQLERRM, v_seqscan USING ERRCODE = 'P0001';
  END;
  PERFORM pg_catalog.set_config('enable_seqscan', v_seqscan, true);
  IF v_heap IS DISTINCT FROM v_served THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plans holds % rows with status = ''active'' when counted with the status test in a FILTER above the scan and % when counted with it in the WHERE, where a partial index may serve. Two readings of the same heap in the same transaction disagree, so an index of this relation holds no entry for a row that qualifies for it -- the index does not physically describe its own heap, and every bound installment_plan_fact_sync derives the invoice-borne fact from is therefore not being held. THIS IS NOT A CATALOGUE FLAG AND NO FLAG CAN SHOW IT: a row written while indisready was false leaves indisvalid, indisready and indislive all true and the index missing an entry for a row that qualifies for it, for ever. REINDEX INDEX each index of this relation to rebuild it from the heap -- and if that refuses 23505 then the heap itself violates a unique index and the data must be reconciled first',
      v_heap, v_served USING ERRCODE = 'P0001';
  END IF;
  --     AND THE REBUILD'S OWN REFUSAL IS CAUGHT AND RENAMED. `REINDEX` of a
  --     heap that violates a unique index raises `23505 could not create
  --     unique index`, which is fail-closed but is a sentence about index
  --     creation: it names no invariant of this slice and tells an operator
  --     nothing about what depends on it. The two-path count above is
  --     PLANNER-DEPENDENT and is therefore a BELT, not the decider -- over a
  --     small heap a planner may sequential-scan both spellings whatever
  --     `enable_seqscan` costs them, and then they agree and measure nothing.
  --     WHAT DECIDES IS THE REBUILD, which is EXECUTION and not a preference
  --     (`TL-P4-COORD-R46` §5: read catalogue DATA, or prove by EXECUTION),
  --     and its refusal is re-raised under this slice's own name with the
  --     consequence spelled out.
  --
  --     AND EVERY FAILURE IT CAN RAISE IS NAMED, NOT ONLY THE ONE THAT WAS
  --     ANTICIPATED (`TL-P4-COORD-R59` ordered item 6, F14-6). The handler
  --     used to be `WHEN unique_violation` alone, so exactly one of
  --     `REINDEX`'s failures acquired a name of this slice and every other
  --     surfaced raw out of this block: measured, `REINDEX INDEX
  --     public.installment_plans_pkey` is `42501 permission denied for index
  --     installment_plans_pkey` for `daftar_app` and succeeds for the
  --     relations' owner `daftar_migrator`, and a lock timeout
  --     (`55P03`/`57014`) or a `55006` is reachable by any concurrent session
  --     holding a conflicting lock. All of those were fail-closed and NAMED
  --     NO INVARIANT OF THIS SLICE, which is the same defect the two-path
  --     count above was written to repair. The handler is now `WHEN OTHERS`,
  --     it distinguishes the heap-violation case from the could-not-run case
  --     BY `SQLSTATE` rather than by assuming which arrived, and both carry
  --     the original `SQLSTATE` and `SQLERRM` so the operator reads what the
  --     server actually said.
  FOR v_ix IN SELECT ic.relname FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
               WHERE x.indrelid = ANY (SELECT ('public.' || y)::regclass FROM unnest(c_relations) y)
               ORDER BY ic.relname LOOP
    BEGIN
      EXECUTE 'REINDEX INDEX public.' || pg_catalog.quote_ident(v_ix);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE <> '23505' THEN
        RAISE EXCEPTION 'installment.migration_end_state_invalid: index % of installment_plans or installments could not be REBUILT AT ALL -- REINDEX raised % (%), which is not the 23505 a violating heap raises, so this migration has NOT established that the index physically describes its own heap and must not be allowed to finish claiming it has. This is the DECIDER of part 9d and the two-path count above it is only a planner-dependent belt. Among the states that reach here: 42501 (the principal applying is not the relations'' owner -- measured, REINDEX of installment_plans_pkey is permission denied for daftar_app and succeeds for daftar_migrator), 55P03 or 57014 (another session holds a conflicting lock on the relation, or lock_timeout/statement_timeout fired), and 55006 (the object is in use). None of them is evidence about the heap in either direction',
          v_ix, SQLSTATE, SQLERRM USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'installment.migration_end_state_invalid: index % cannot be rebuilt from the heap of its own relation -- REINDEX refused it with %, so the heap CONTAINS rows that violate an index the catalogue reports as valid, ready and live. THIS IS NOT A CATALOGUE FLAG AND NO FLAG CAN SHOW IT: rows written while indisready was false leave all three flags true and the index missing an entry for a row that qualifies for it, FOR EVER, and pg_indexes renders it identically to a correct index. installment_plan_fact_sync derives invoices.has_active_installment_plan from the bound installment_plans_one_active_per_invoice_uq is supposed to hold, and customer_ar_aging refuses a receivable when that bound is broken, so this state is the one in which a plan fact can be written from a premise nothing is enforcing. Reconcile the duplicate rows first; the index cannot be made to describe this heap',
        v_ix, SQLERRM USING ERRCODE = 'P0001';
    END;
  END LOOP;

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
  --     refused, and it must be an ORDINARY row trigger rather than a
  --     deferrable constraint one -- a deferred answer is exactly the answer
  --     this repair replaces.
  --
  --     THE `DELETE` BIT IS REFUSED, AND THE REASON IS NOT «a deleted row
  --     cannot become anything» ALONE (`TL-P4-COORD-R59` ordered item 2,
  --     F14-2). That sentence is true of the EXCLUSION and says nothing about
  --     the LOCK ORDER, which is what round 14's declared `DELETE` inversion
  --     was about. Round 15 built the `BEFORE DELETE` arm that was supposed to
  --     fix that order and MEASURED THAT IT CANNOT: `GetTupleForTrigger` locks
  --     the `OLD` tuple before a `BEFORE ROW DELETE` trigger is called, so
  --     rank 6 is held before the arm's first statement and the same race still
  --     deadlocked. The arm would therefore make this law assert a rationale
  --     that is false, so the bit stays refused, the hazard stays DECLARED in
  --     section 3a-ter, and the remedy stated there is the CALLER's: take the
  --     invoice row before the DELETE. See also the `40P01` rendering, which is
  --     the half of ordered item 2 that does not depend on the caller.
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
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plans carries no BEFORE INSERT OR UPDATE row trigger on installment_plan_active_exclusive() over the whole row, so the one-active exclusion is not judged before the row is written and its refusal is row-order dependent again. A DELETE bit is refused here too: round 15 measured that a BEFORE DELETE arm cannot take the invoices row (P4-AL-41 rank 3) ahead of the installment_plans row (rank 6), because GetTupleForTrigger locks the OLD tuple before the arm runs, so an arm here would carry a rationale that is false -- section 3a-ter declares that case and states the caller remedy that does reach it'
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
  -- THE RETIRED DEFERRED OBLIGATION (e) IS GONE, and that was a `prosrc LIKE`
  -- on a prose fragment of the routine's own refusal message -- an ABSENCE
  -- established by a substring, which `TL-P4-COORD-R50` §5 rules cannot
  -- establish an absence at all. Part 6b's digest of this body is what
  -- establishes it now, and it establishes it the only way an apply-time
  -- instrument can: the installed body IS the body that was reviewed, and the
  -- body that was reviewed does not carry (e). The tenant edges asserted
  -- immediately above are what make (e) unreachable, and they are catalogue
  -- data.
END
$end$;
