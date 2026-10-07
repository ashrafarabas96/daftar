# P4-S7 — DDL SPECIFICATION (maturity level E)

**Base SHA:** `be5f07fff1ae423cf23c6b3bc71f47b066852533`
**Status:** SPECIFICATION ONLY.

> **THIS DOCUMENT ALLOCATES NO MIGRATION NUMBER AND IS NOT A `.sql` FILE.**
> There is exactly one migration owner in Phase 4 and it is not the S7 owner.
> `0000`–`0079` are byte-for-byte immutable and `0080`–`0086` are S4
> candidates. The real prefix for this DDL is **unknown** until S4, S5 and S6
> seal, so writing one here would be inventing it. The candidate text is
> evaluated by `tests/guards/p4s7-schedule-laws.test.ts`, which copies the
> tree's Phase 4 DDL into an `mkdtemp` root and adds this specification as
> `zz-p4s7-candidate-spec.sql` — a name that sorts after every real migration
> and is never a migration. The checkout is never written.

---

## E.0 THE TWO STRUCTURAL LAWS THIS DDL IS WRITTEN AGAINST

`FINANCIAL_CORE` (`scripts/phase4-s1-gate.ts:504-505`) **already names**
`installment_plans` and `installments`. Two consequences, before a line is
written:

1. **G-19: no polymorphic foreign key on `FINANCIAL_CORE`.** The plan's source
   is bound through the **composite bridge**: `installment_plans` references
   `invoices (business_id, id, customer_id)` — the three-column edge `0082`
   created `invoices_customer_uq` for — and `installments` references
   `installment_plans (business_id, id)`. There is **no `source_type` /
   `source_id` pair, and no `document_type`, anywhere** in this slice.
   `tests/guards/p4s7-schedule-laws.test.ts §1` plants one and shows the
   estate's own `compositeFkProblems` refusing it.

2. **A business-owned entity is never identified by ONE component of its
   composite key.** `installments` carries `business_id`, keys on
   `(business_id, plan_id, seq_no)`, and every edge it draws carries
   `business_id` with it. An edge on `plan_id` alone would let a row of one
   business point at a plan of another; §1.2 plants exactly that.

---

## E.1 `installment_plans`

```sql
CREATE TABLE installment_plans (
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  id                  UUID NOT NULL,
  invoice_id          UUID NOT NULL,
  customer_id         UUID NOT NULL,
  currency_code       TEXT NOT NULL REFERENCES currencies(code),
  start_date          DATE NOT NULL,
  down_payment_minor  BIGINT NOT NULL DEFAULT 0,
  total_minor         BIGINT NOT NULL,
  installment_count   INTEGER NOT NULL,
  remainder_placement TEXT NOT NULL DEFAULT 'first',
  lifecycle           TEXT NOT NULL DEFAULT 'active',
  intent_sha256       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT installment_plans_pkey PRIMARY KEY (business_id, id),
  CONSTRAINT installment_plans_invoice_fk FOREIGN KEY (business_id, invoice_id, customer_id)
    REFERENCES invoices (business_id, id, customer_id) ON DELETE RESTRICT,
  CONSTRAINT installment_plans_customer_fk FOREIGN KEY (business_id, customer_id)
    REFERENCES customers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT installment_plans_invoice_uq UNIQUE (business_id, invoice_id, lifecycle),
  CONSTRAINT installment_plans_total_positive CHECK (total_minor > 0),
  CONSTRAINT installment_plans_down_bounded
    CHECK (down_payment_minor >= 0 AND down_payment_minor < total_minor),
  CONSTRAINT installment_plans_count_bounded CHECK (installment_count BETWEEN 1 AND 120),
  CONSTRAINT installment_plans_placement CHECK (remainder_placement IN ('first', 'last')),
  CONSTRAINT installment_plans_lifecycle CHECK (lifecycle IN ('active', 'cancelled'))
);
```

Notes on each decision:

- **`created_at` is the only clock in the slice**, and it is an audit instant,
  never a financial input. Nothing derives a status from it. Every derived
  answer takes a **supplied `asOf`**.
- **`total_minor` is `BIGINT`** — integer minor units, the existing money
  contract. There is no `NUMERIC`, no `DOUBLE PRECISION` and no scaling factor.
- **`down_payment_minor < total_minor`**, not `<=`: a down payment equal to the
  total leaves nothing to schedule, which is not a plan.
- **`installment_plans_invoice_uq (business_id, invoice_id, lifecycle)`** — at
  most one `'active'` plan per invoice, with unlimited `'cancelled'` history.
  One receivable, one schedule.
- **`ON DELETE RESTRICT` to `invoices` is deliberate** (contract-pack A6-1): if
  S6 ever hard-deletes an invoice, the delete is REFUSED rather than silently
  orphaning a schedule.
- **`remainder_placement`** is stored, not inferred, so a plan replays to the
  same amounts. It is the one rounding policy and it has two legal values.
- **`intent_sha256`** carries the idempotency fingerprint. It covers the
  supplied `asOf` and nothing server-resolved.
- **No `status`, no `balance_minor`, no `outstanding_minor`.** Those are the
  shapes `scripts/guards/no-authoritative-balance.ts` refuses by name, and
  the reason is law 1: the plan is not a second ledger.

---

## E.2 `installments`

```sql
CREATE TABLE installments (
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  plan_id      UUID NOT NULL,
  seq_no       INTEGER NOT NULL,
  due_date     DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  CONSTRAINT installments_pkey PRIMARY KEY (business_id, plan_id, seq_no),
  CONSTRAINT installments_plan_fk FOREIGN KEY (business_id, plan_id)
    REFERENCES installment_plans (business_id, id) ON DELETE CASCADE,
  CONSTRAINT installments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT installments_seq_positive CHECK (seq_no BETWEEN 1 AND 120),
  CONSTRAINT installments_due_uq UNIQUE (business_id, plan_id, due_date)
);
```

The table has **five columns and that is the point**. A row is a DATE and an
AMOUNT. It carries no `settled_minor`, no `outstanding_minor`, no `status`, no
`settled_at` and no `paid` flag: every one of those would be a second balance,
and §2 of the guard suite plants each and shows the estate refusing it.

`installments_due_uq` makes the due dates strictly distinct within a plan,
which is what makes `(due_date, seq_no)` a total order and therefore a sound
keyset key and a sound waterfall order.

---

## E.3 THE CLOSURE INVARIANT — a DEFERRED CONSTRAINT TRIGGER

`Σ installments.amount_minor + plan.down_payment_minor = plan.total_minor`
is a **set-level** invariant: it is false after the first of `n` inserts and
true only when the whole schedule is in. A row-level CHECK cannot express it
and a row-level trigger would refuse a correct schedule mid-write.

```sql
CREATE FUNCTION installment_plan_closes() RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_sum   BIGINT;
  v_count INTEGER;
  v_plan  installment_plans;
BEGIN
  SELECT * INTO v_plan FROM installment_plans
   WHERE business_id = NEW.business_id AND id = NEW.plan_id;
  IF NOT FOUND THEN RETURN NULL; END IF;        -- the plan was cancelled away
  SELECT coalesce(sum(amount_minor), 0), count(*) INTO v_sum, v_count
    FROM installments
   WHERE business_id = NEW.business_id AND plan_id = NEW.plan_id;
  IF v_sum + v_plan.down_payment_minor <> v_plan.total_minor THEN
    RAISE EXCEPTION 'installment_plan.schedule_sum_mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_count <> v_plan.installment_count THEN
    RAISE EXCEPTION 'installment_plan.installment_count_invalid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER installments_close_trg
  AFTER INSERT OR UPDATE OR DELETE ON installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installment_plan_closes();
```

**Two measured facts about this trigger**, both demonstrated against a REAL
trigger on REAL tables in `tests/integration/p4s7-asof-and-closure-redproofs.test.ts`:

1. The command path must issue `SET CONSTRAINTS ALL IMMEDIATE` so the trigger
   fires **inside** the transaction and a refusal is a refusal rather than a
   commit-time surprise.
2. `SET CONSTRAINTS ALL IMMEDIATE` **changes the mode for the rest of the
   transaction**. A test (or a command) that fires it and then writes a second
   correct schedule gets that schedule judged row-by-row and refused. The test
   helper therefore restores `SET CONSTRAINTS ALL DEFERRED` after firing — and
   that is the same mechanism the IMMEDIATE-trigger red proof demonstrates
   deliberately.

The raised message is the slice's own refusal code, parsed back by
`DATABASE_CODE_RE` in `installments-errors.ts`. The database and the API
therefore speak the SAME vocabulary, which is what makes a validation-layer
test evidence about the pipe and a database-layer test evidence about the
command.

---

## E.4 INDEXES

```sql
CREATE INDEX installments_keyset_idx
  ON installments (business_id, plan_id, due_date, seq_no);
CREATE INDEX installment_plans_customer_idx
  ON installment_plans (business_id, customer_id, start_date, id);
```

`installments_keyset_idx` carries **every ordering component of the keyset**,
in order. The schedule page orders by `(due_date, seq_no)` and continues from
`(due_date, seq_no) > (:after_due, :after_seq)`, so the index is a prefix walk
and the deep page costs what the first page costs. That is the property
`KEYSET_DRIFT_MAX_RATIO` measures; a drift above it means the plan is not using
this index and the page is an `OFFSET` in disguise.

`installment_plans_customer_idx` serves "this customer's plans, oldest first",
with `id` as the tie-break so the ordering is total.

**No index is created for a status or a balance**, because there is none to
index.

---

## E.5 ROW LEVEL SECURITY AND GRANTS

```sql
ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE installments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE installments      FORCE ROW LEVEL SECURITY;

CREATE POLICY installment_plans_tenant ON installment_plans
  USING (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());
CREATE POLICY installments_tenant ON installments
  USING (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

REVOKE ALL ON installment_plans, installments FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON installment_plans, installments TO daftar_app;
```

- `FORCE` as well as `ENABLE`, so the table owner is not exempt.
- `WITH CHECK` as well as `USING`, so a row cannot be *written* into another
  business either — a policy with only `USING` hides foreign rows and still
  lets you create one.
- **A cross-business plan id answers `installment_plan.not_found`, never a
  forbidden** (G-02). "Forbidden" confirms the id exists, which is the leak.
- `daftar_app` only. No grant to `daftar_inventory_internal`: a schedule is not
  an inventory object.

---

## E.6 THE STATEMENT READ ROUTINE

```sql
CREATE FUNCTION customer_statement_entries(
  p_business_id UUID,
  p_customer_id UUID,
  p_from        DATE,
  p_to          DATE
) RETURNS TABLE (
  entry_kind   TEXT,
  entry_id     UUID,
  entry_date   DATE,
  amount_minor BIGINT
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ ... $$;
```

- **Four parameters and no clock.** `p_from` and `p_to` are supplied; the
  routine resolves no "today", no "this month" and no default window.
- `STABLE`, not `IMMUTABLE`: it reads tables. **And a measured finding:
  PostgreSQL 18 ACCEPTS an `IMMUTABLE` body that reads `CURRENT_DATE`** — the
  volatility marker is a promise the server trusts, not a check it performs.
  So the asOf seam is closed by the PARAMETER, never by the marker.
- **It returns entries, not a running balance.** A `running_balance_minor`
  column would be a second AR total that disagrees with
  `customer_ar_outstanding` the moment a row is backdated. The merchant's
  "what is still owed" comes from the one reader of record.
- Entry kinds are `'invoice' | 'payment' | 'credit_application' |
  'installment_due'`, matching `STATEMENT_ENTRY_KINDS`. `'installment_due'` is
  a **date and an amount from this slice's own rows** — it is not money that
  moved, and the DTO marks it as such so no client can sum it into a balance.
  The final set of kinds depends on S5 and S6; see `PATCH-REQ-S7-003`.
- The keyset is `(entry_date, entry_kind, entry_id)`, every component in the
  continuation token, and the SQL carries **no `OFFSET`** (law 5).

---

## E.7 EXPECTED CATALOGUE SHAPE (what a level-F test should assert)

| Catalogue | Expectation |
| --- | --- |
| `pg_class` | `installment_plans`, `installments` exist; both `relrowsecurity` AND `relforcerowsecurity` are true |
| `pg_constraint` | the 2 PKs, the 3 FKs, the 2 UNIQUEs and the 6 CHECKs above, by name; `installment_plans_invoice_fk` has `confkey` of three columns |
| `pg_trigger` | `installments_close_trg` exists with `tgdeferrable` AND `tginitdeferred` true |
| `pg_proc` | `installment_plan_closes` and `customer_statement_entries` exist; `proconfig` contains `search_path=pg_catalog, public, pg_temp`; `provolatile` is `s` for the reader |
| `pg_policy` | one policy per table, with BOTH `polqual` and `polwithcheck` non-null |
| `information_schema.role_table_grants` | no grant to `PUBLIC`; `daftar_app` holds the four DML privileges |
| `pg_index` | `installments_keyset_idx` has exactly the four key columns in the stated order |
| `pg_attribute` | **absence** is asserted: no `status`, `settled_minor`, `outstanding_minor`, `settled_at`, `balance_minor`, `paid` on either table |

---

## E.8 UPGRADE EXPECTATIONS

- **Forward only.** Both tables are new, so the migration adds and never
  rewrites. It takes no `ACCESS EXCLUSIVE` lock on any existing relation, and
  it alters no S4 relation — the three-column FK uses `invoices_customer_uq`
  as it already stands.
- **`ANALYZE` is part of the migration, not of the benchmark.** «A benchmark
  measures what the planner saw»: both tables must be `ANALYZE`d before any
  budget is claimed, and the harness reads the evidence back from
  `pg_stat_user_tables`. One accepted budget in this estate cost 2.9 s and then
  122 ms after a single `ANALYZE`, with no query and no migration change.
- **Down is a `DROP`**, and it is safe only while no plan exists, because
  `ON DELETE CASCADE` from plan to instalments means dropping the parent
  discards schedules. A down migration that runs with plans in place destroys
  merchant data, so the down path must refuse on a non-empty
  `installment_plans`.
- **Nothing backfills.** There is no historical plan to infer: an invoice
  without a plan is an invoice without a plan, and inventing schedules from
  payment history would be inventing a commercial relation.

---

## E.9 WHAT THIS SPECIFICATION DELIBERATELY DOES NOT CONTAIN

- a migration number, a file name under `infrastructure/database/migrations/`,
  or any edit to an existing migration;
- an interest, fee, penalty or late-charge column, rate or table;
- a tax column (OD-03: structural zero, the owner's alone);
- an AR account, a journal source type, or any posting — a plan posts nothing;
- a status column, a balance column, or anything a cron would maintain;
- a materialized aging, or any change to `customer_ar_aging`
  (see `PATCH-REQ-S7-001` for the grain question, which is a DECISION and not
  an edit this slice may make);
- a `running_balance_minor` on any read.
