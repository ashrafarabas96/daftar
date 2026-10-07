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

-- ── 6a. THE NO-PLAN ARM MUST FAIL CLOSED — challenger C1.a ───────────────
--
-- THE DEFECT THE FIRST VERSION SHIPPED. Arm (c) of the projection was keyed on
-- `WHERE NOT EXISTS (SELECT 1 FROM active_plan …)`. `customer_ar_aging` is
-- `SECURITY INVOKER` (`R-P4-07`, and it must stay so), so `active_plan` is read
-- THROUGH THE CALLER'S ROW SECURITY. Under row security, «absent» and
-- «invisible» are the same answer, and `NOT EXISTS` asks the question that
-- cannot tell them apart. A caller who could see the invoice and not its plan
-- was therefore served THE WHOLE OUTSTANDING AT THE SINGLE INVOICE DUE DATE —
-- the exact pre-S7 defect this slice exists to repair, with no error, no empty
-- result and no `42501`. A plausible wrong number a merchant would believe.
--
-- THE REPAIR HAS TWO HALVES, and the first is the one that matters.
--
--   1. REMOVE EVERY ASYMMETRY. The projection reads `public.invoices` through
--      the same row security, so for a caller whose visibility of the two
--      relations agrees, hiding the plan hides the invoice too and the result
--      is NO ROW rather than a wrong row. Two asymmetries existed and both are
--      now closed at their source: `daftar_inventory_internal` holds an
--      unconditional read on `invoices` (`0075:455-456`) and now holds one
--      here (section 2a); and a plan whose `tenant_id` differed from its
--      invoice's was expressible, which obligation (e) of section 3 now
--      refuses at COMMIT.
--
--   2. AND THEN FAIL CLOSED ANYWAY. An argument that an asymmetry is
--      unreachable is still an argument. This guard turns any residual one
--      into a REFUSAL rather than a wrong number, which is the only direction
--      a financial read may fail in.
--
-- WHY THIS IS NOT A SECOND READER, AND LEAKS NOTHING. It returns no amount, no
-- date and no count — one boolean, or an exception. It is asked only about
-- invoice ids that CAME OUT OF the caller's own row-security-filtered read of
-- `public.invoices`, so it can confirm nothing the caller cannot already see.
-- It is `STABLE`, so it is callable from the `STABLE` projection; it is
-- DEFINER because a guard that ran under the caller's visibility would be the
-- defect it exists to catch.
-- Its own CREATE bracket, for the same reason as section 3's: this guard is
-- transferred to `daftar_accounting_internal` too, and a transfer to a role
-- without CREATE on the schema is `42501`.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION installment_plan_absence_guard(p_business_id UUID, p_invoice_ids UUID[])
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_hidden INTEGER;
BEGIN
  SELECT pg_catalog.count(*) INTO v_hidden
    FROM public.installment_plans p
   WHERE p.business_id = p_business_id
     AND p.status = 'active'
     AND p.invoice_id = ANY (p_invoice_ids);
  IF v_hidden > 0 THEN
    RAISE EXCEPTION 'installment.plan_invisible: % of the invoices served without a schedule do have an active plan this caller cannot see',
      v_hidden USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION installment_plan_absence_guard(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installment_plan_absence_guard(UUID, UUID[]) TO daftar_app, daftar_inventory_internal;
COMMENT ON FUNCTION installment_plan_absence_guard(UUID, UUID[]) IS
  'P4-S7 (challenger C1.a). The no-plan arm of customer_ar_aging fails CLOSED. Given the invoice ids the INVOKER projection is about to serve without a schedule, it raises installment.plan_invisible if any of them does have an active plan, judged WITHOUT the caller''s row security. Under row security "absent" and "invisible" are one answer, and the arm keyed on NOT EXISTS served the whole outstanding at the single invoice due date — the pre-S7 defect — to any caller whose visibility of the plan and of its invoice disagreed. It returns no amount, no date and no count, only a boolean or an exception, and it is asked only about invoices that came out of the caller''s own filtered read, so it confirms nothing the caller cannot already see. STABLE, internal-owned DEFINER, pinned search_path, reads only.';

-- ...and the transfer last, for the reason section 3 records.
ALTER FUNCTION installment_plan_absence_guard(UUID, UUID[]) OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

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
  no_plan AS (
    -- The open invoices the caller sees NO active plan for. Named as its own
    -- CTE so the guard of section 6a can be asked about the SET once, instead
    -- of once per row, and so arm (c) below reads one relation and not two.
    SELECT oi.invoice_id, oi.currency_code, oi.due_date,
           oi.outstanding_txn_minor, oi.outstanding_base_minor
      FROM open_invoice oi
     WHERE NOT EXISTS (SELECT 1 FROM active_plan ap WHERE ap.invoice_id = oi.invoice_id)
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
    --     AND IT FAILS CLOSED (challenger C1.a, section 6a). `NOT EXISTS`
    --     cannot distinguish a plan that is ABSENT from one that is INVISIBLE,
    --     and the invisible case served the pre-S7 number silently. The guard
    --     is asked ONCE about the whole set rather than once per row, and it
    --     returns a boolean or raises `installment.plan_invisible`.
    SELECT n.invoice_id, n.currency_code, n.due_date,
           n.outstanding_txn_minor, n.outstanding_base_minor
      FROM no_plan n
     CROSS JOIN (SELECT public.installment_plan_absence_guard(
                          p_business_id,
                          coalesce((SELECT pg_catalog.array_agg(y.invoice_id) FROM no_plan y), ARRAY[]::UUID[])) AS ok) g
     WHERE g.ok
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
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = 'public.installment_plan_absence_guard(uuid,uuid[])'::regprocedure
       AND r.rolname = 'daftar_accounting_internal' AND NOT r.rolcanlogin
       AND p.prosecdef AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: installment_plan_absence_guard is not a STABLE internal-owned definer with the pinned path'
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
  -- AND THE NO-PLAN ARM FAILS CLOSED (challenger C1.a): the installed body
  -- really calls the absence guard. An arm keyed on NOT EXISTS alone cannot
  -- tell «absent» from «invisible» and served the pre-S7 number silently.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure
                    AND p.prosrc LIKE '%installment_plan_absence_guard(%') THEN
    RAISE EXCEPTION 'installment.migration_end_state_invalid: customer_ar_aging does not guard its no-plan arm against row-security invisibility'
      USING ERRCODE = 'P0001';
  END IF;
END
$end$;
