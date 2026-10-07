-- ═══════════════════════════════════════════════════════════════════════════
-- P4-S7 — INSTALLMENT AGING GRANULARITY: THE DDL SPECIFICATION.
--
-- THIS PROJECTION IS TRANSACTION-CURRENCY ONLY. It allocates
-- `outstanding_txn_minor` across the aging buckets and allocates NO base
-- figure. That is a RULING (coordinator, ruling 2) and not an omission left
-- to be discovered: the base column cannot be split exactly from the inputs
-- this design is permitted, for the reason measured in section 5 below. The
-- widening that would allow it is with the owner and must not be written
-- until he rules.
--
-- THE SETTLEMENT ORDER IS A DECLARED POLICY, NOT A DERIVATION.
-- `payment_allocations` carries `invoice_id` and no instalment reference, so
-- nothing stored records which instalment a payment settled. The order is
-- RULED oldest-scheduled-date-first (coordinator, ruling 1) for three
-- recorded reasons: it is the ordinary AR convention a merchant expects;
-- `installments_seq_uq` already makes `(due_date, seq_no)` a total order, so
-- it is the only order the schema can reproduce deterministically without new
-- state; and it minimises reported delinquency, so if it is wrong it errs
-- toward understating what a customer owes rather than toward accusing them.
-- It is one named constant, `DECLARED_SETTLEMENT_ORDER`, and `meta_6` proves
-- every money law under BOTH conventions, so overturning the ruling is a
-- one-constant change whose proofs still run.
--
-- THIS FILE IS A SPECIFICATION AND NOT A MIGRATION. It carries NO migration
-- number, it is not in `infrastructure/database/migrations/`, and it is not in
-- the migration manifest. `0000`-`0079` are byte-immutable and `0080`-`0086`
-- are S4 candidates; the single migration owner allocates this slice's number
-- at promotion and this text is what they transcribe. Nothing here is applied
-- by `npm run migrate`.
--
-- It is asserted over, not merely written: proofs 6 and 7 in
-- `packages/domain-core/test/phase4-s7-installment-aging.test.ts` read THIS
-- FILE and run the estate's own guard predicates
-- (`scripts/guards/no-authoritative-balance.ts`) over it, so a forbidden
-- column or a journal source type added here turns those proofs red.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. THE PLAN: a schedule over a receivable that already exists ─────────
--
-- `P4-AL-13` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:349-355`): «An installment
-- plan is a schedule over a receivable that already exists. It is never a
-- second ledger of debt. … Collecting an instalment is an ordinary payment
-- allocated to the invoice — the same command, the same journal, the same
-- reversal path.»
--
-- So this relation carries DATES, AMOUNTS and a LIFECYCLE, and not one
-- number that any payment, reversal, credit application or refund would have
-- to keep right. There is no `outstanding_minor`, no `settled_minor`, no
-- `collected_minor`, no `paid_minor`, no `remaining_minor` and no plan-level
-- total: the plan's total is the invoice's `total_txn_minor` and is read
-- there.

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
  -- the projection orders the schedule by date, so a schedule row with no
  -- date of its own would have to borrow one, and borrowing `invoices.due_date`
  -- can place the down payment AFTER instalment 1 and invert the settlement
  -- order. A civil DATE, never a timestamp (`G-13`).
  down_payment_due_date   DATE NOT NULL,
  installment_count       INTEGER NOT NULL CHECK (installment_count BETWEEN 1 AND 60),
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_transaction_id UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT installment_plans_invoice_fk FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id),
  CONSTRAINT installment_plans_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
);

-- AT MOST ONE ACTIVE PLAN PER INVOICE. Two active plans on one invoice would
-- make the projection read that invoice's authoritative outstanding twice and
-- report it twice, which is the double count proof 3 is about. The exclusion
-- is structural and not a convention: a partial unique index cannot be
-- satisfied by two active rows.
CREATE UNIQUE INDEX installment_plans_one_active_per_invoice_uq
  ON installment_plans (business_id, invoice_id) WHERE status = 'active';

-- ── 2. THE SCHEDULE ROWS: a date and an amount, and nothing derived ───────

CREATE TABLE installments (
  tenant_id        UUID NOT NULL,
  business_id      UUID NOT NULL,
  id               UUID NOT NULL,
  plan_id          UUID NOT NULL,
  seq_no           INTEGER NOT NULL CHECK (seq_no >= 1),
  -- A civil DATE, never a timestamp (`G-13`): the aging boundary is a day
  -- and a host offset may not move it.
  due_date         DATE NOT NULL,
  amount_txn_minor BIGINT NOT NULL CHECK (amount_txn_minor >= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT installments_plan_fk FOREIGN KEY (business_id, plan_id) REFERENCES installment_plans (business_id, id),
  -- `seq_no` unique within the plan, which is what makes `(due_date, seq_no)`
  -- a TOTAL order and therefore makes the allocation deterministic even when
  -- two instalments fall on one date.
  CONSTRAINT installments_seq_uq UNIQUE (business_id, plan_id, seq_no)
);

-- The one index the schedule read needs (budget `P4-H`, p95 <= 50 ms):
-- the projection's order is exactly this index's order.
CREATE INDEX installments_plan_schedule_idx ON installments (business_id, plan_id, due_date, seq_no);

-- Row security, FORCEd, like every Phase 4 relation; the policies are the
-- estate's standard tenant/business pair and are transcribed at promotion.
ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE installments FORCE ROW LEVEL SECURITY;

-- ── 3. WHAT THIS SPECIFICATION DELIBERATELY DOES NOT CREATE ──────────────
--
--   * NO accounting source type. Neither relation carries an
--     `accounting_source_type` column, neither is registered in
--     `accounting_source_bindings`, and no trigger posts a journal entry from
--     either. Collecting an instalment is an ordinary payment allocated to
--     the invoice (`P4-AL-13`), so the journal it moves is the payment's.
--     Proof 6 asserts this over this file's text.
--   * NO reducer relation, and therefore NO new `UNION ALL` branch in
--     `invoice_outstanding(UUID, UUID[])`. That routine's comment
--     (`0083:348`) says it is «replaced by the slice that adds a reducer
--     relation, which appends one UNION ALL branch»; an installment plan is
--     not a reducer, so S7 appends nothing and the one definition of the
--     settlement sum is untouched. Proof 6 asserts the branch set is
--     unchanged, read from the shipped migration.
--   * NO stored outstanding, settled, collected, paid or remaining figure on
--     either relation, and no plan-level or instalment-level balance of any
--     kind. Proof 7 asserts this with the estate's own predicate.
--   * NO materialised aging, no aging table, no aging column, no cache and no
--     snapshot. The aging is a function of its arguments.
--   * NO second AR ledger. The projection's only money input from outside the
--     schedule is `invoice_outstanding`'s authoritative figure.

-- ── 4. THE PROJECTION ────────────────────────────────────────────────────
--
-- `customer_ar_aging` is REPLACED (`CREATE OR REPLACE`, same signature, same
-- owner, same STABLE/SECURITY INVOKER standing, same pinned `search_path`,
-- same ACL). Its answer changes — that is the whole point of the slice — and
-- its shape does not.
--
-- `p_as_of` STAYS A PARAMETER AND THE BODY READS NO CLOCK. The body contains
-- no `CURRENT_DATE`, `now()`, `LOCALTIMESTAMP`, `localtime`,
-- `transaction_timestamp()`, `statement_timestamp()` or `clock_timestamp()`.
-- The routine is NOT declared `IMMUTABLE` and the design does not ask for it
-- to be: PostgreSQL trusts the volatility label and never reads the body, so
-- `IMMUTABLE` is not a clock guard. The protections are the explicit
-- parameter, the static guard widened in the design document §8, and the red
-- proof that guard carries.
--
-- The algorithm is the one in
-- `packages/domain-core/test/phase4-s7-aging-reference-model.ts`
-- (`projectInvoice`), and that file's header states why the TypeScript is a
-- reference model and not a second implementation (`P4-AL-07`).
--
-- Shape of the replacement body, in one statement, no loop, no accumulator.
-- The block between the two markers is the SQL this design is judged on:
-- proof 8 extracts it by those markers, strips the leading comment prefix and
-- guards the result for financial time functions. The markers exist so the
-- law's subject is a DELIMITED BLOCK and never a textual coincidence found in
-- the surrounding prose.
--
-- >>> P4S7 PROJECTION SKETCH BEGIN
--   WITH open_invoice AS (
--          -- the authoritative outstanding, once, set-based
--          SELECT o.invoice_id, i.currency_code::TEXT AS currency_code,
--                 i.due_date, o.outstanding_txn_minor
--            FROM public.invoice_outstanding(p_business_id, (SELECT array_agg(x.id) ...)) o
--            JOIN public.invoices i ON ...
--           WHERE o.outstanding_txn_minor <> 0),
--        active_plan AS (
--          SELECT p.id, p.invoice_id, p.down_payment_minor, p.down_payment_due_date
--            FROM public.installment_plans p
--           WHERE p.business_id = p_business_id AND p.status = 'active'
--             AND p.invoice_id IN (SELECT invoice_id FROM open_invoice)),
--        sched AS (  -- the down payment at seq 0, then the instalments
--          SELECT ap.invoice_id, 0 AS seq_no, ap.down_payment_due_date AS due_date,
--                 ap.down_payment_minor AS amount
--            FROM active_plan ap
--          UNION ALL
--          SELECT ap.invoice_id, n.seq_no, n.due_date, n.amount_txn_minor
--            FROM active_plan ap
--            JOIN public.installments n ON n.business_id = p_business_id AND n.plan_id = ap.id),
--        suffixed AS (  -- s_{i+1}: the amounts scheduled STRICTLY AFTER this row
--          SELECT s.*, coalesce(sum(s.amount) OVER (
--                   PARTITION BY s.invoice_id
--                   -- DESC because the DECLARED POLICY is oldest-scheduled-
--                   -- first: the outstanding occupies the LATEST rows, so the
--                   -- window sums the amounts scheduled strictly after this
--                   -- one. The other convention is this ORDER BY ascending,
--                   -- and nothing else changes.
--                   ORDER BY s.due_date DESC, s.seq_no DESC
--                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS suffix_after,
--                 sum(s.amount) OVER (PARTITION BY s.invoice_id) AS schedule_total
--            FROM sched s),
--        contribution AS (
--          -- (a) the schedule rows: the closed-form clamp
--          SELECT x.invoice_id, oi.currency_code, x.due_date AS bucket_date,
--                 least(greatest(oi.outstanding_txn_minor - x.suffix_after, 0), x.amount) AS txn_minor
--            FROM suffixed x JOIN open_invoice oi ON oi.invoice_id = x.invoice_id
--          UNION ALL
--          -- (b) the residual, by its OWN closed form, bucketed at the
--          --     invoice's due date. Never `outstanding - sum(alloc)`.
--          SELECT oi.invoice_id, oi.currency_code, oi.due_date,
--                 oi.outstanding_txn_minor
--                   - least(greatest(oi.outstanding_txn_minor, 0), t.schedule_total)
--            FROM open_invoice oi
--            JOIN (SELECT invoice_id, max(schedule_total) AS schedule_total FROM suffixed GROUP BY invoice_id) t
--              ON t.invoice_id = oi.invoice_id
--          UNION ALL
--          -- (c) the invoices with NO active plan: the whole figure, as today.
--          --     The three arms PARTITION the open invoices; (a) and (b) read
--          --     only invoices in `active_plan`, (c) only those not in it.
--          SELECT oi.invoice_id, oi.currency_code, oi.due_date, oi.outstanding_txn_minor
--            FROM open_invoice oi
--           WHERE NOT EXISTS (SELECT 1 FROM active_plan ap WHERE ap.invoice_id = oi.invoice_id))
--   SELECT 1 + (SELECT count(*) FROM unnest(p_bucket_days) t(threshold)
--                WHERE c.bucket_date IS NOT NULL AND (p_as_of - c.bucket_date) > t.threshold) AS bucket_no,
--          c.currency_code,
--          sum(c.txn_minor)::BIGINT AS txn_minor,
--          count(DISTINCT c.invoice_id)::INTEGER AS invoice_count
--     FROM contribution c
--    WHERE c.txn_minor <> 0
--    GROUP BY 1, c.currency_code;
-- <<< P4S7 PROJECTION SKETCH END
--
-- `count(DISTINCT c.invoice_id)` and not `count(*)`: an invoice now makes
-- several contributions, so `count(*)` would report a number of instalments
-- under a column named `invoice_count`.
--
-- ── 5. THE `base_minor` COLUMN IS RULED OUT FOR NOW, NOT GUESSED ─────────
--
-- The shipped `customer_ar_aging` returns `base_minor` beside `txn_minor`.
-- The transaction-currency allocation above is EXACT and performs zero
-- roundings. The base column cannot be split exactly from the inputs this
-- design is permitted, and the reason is measured rather than assumed:
-- `invoice_outstanding`'s `paid_base_minor` is the sum of
-- `invoice_carrying_base_released_minor` — THE CARRYING RELEASED — and
-- «never a conversion of the paid transaction amount» (`0083:277-281`). So
-- `outstanding_base_minor / outstanding_txn_minor` is not the invoice's
-- `source_to_base_rate` under realized FX, and any per-row base figure needs
-- either that rate (an input outside the permitted list) or that quotient (a
-- rounded quotient fed back as an authoritative input, which is forbidden).
-- RULED (coordinator, ruling 2): the aging projection is transaction-currency
-- only and this specification writes NO base allocation. The recommended
-- widening — permit `invoices.source_to_base_rate` and define the base
-- schedule as DIFFERENCES OF THE ROUNDED CUMULATIVE CONVERSION
-- `C_i = round(s_i * rate)`, so the row amounts telescope and exactly ONE
-- rounding is performed, at one grain, with `outstanding_base_minor` left as
-- the authoritative input and never recomputed — is with the OWNER, because
-- widening the permitted input set is his. It must not be written until he
-- rules. The three options are compared in the design document §5.
