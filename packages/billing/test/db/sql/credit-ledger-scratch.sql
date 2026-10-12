-- =====================================================================
-- SCRATCH DDL — the platform credit ledger as §11 of
-- `/mnt/project-files/phase5/P5-MIGRATION-PATCH-REQUEST.md` requests it.
--
-- WHAT THIS FILE IS, exactly, and what it is not:
--
--   * It is NOT a migration. It carries no number and no migration
--     filename, it lives under `test/db/sql/` and not under
--     `infrastructure/database/migrations`, and it creates its own schema
--     so that it cannot collide with anything the Migration Owner later
--     writes. The master mission allows unnumbered DDL on scratch, and
--     this is that.
--   * It is a REALIZATION of the request, written so the request can be
--     EXECUTED instead of asserted. The Master Continuous Mission (§12)
--     says the prepared pure core does not prove atomicity and that the
--     transaction, the lock, the constraint, the double-spend detection
--     at concurrent finalizations, rollback/retry and identical-source
--     invoices must be EXECUTED. This file plus
--     `test/db/credit-ledger-concurrency.test.ts` is that execution.
--   * Therefore what it proves is that THE REQUESTED DESIGN closes the
--     hazard. It proves nothing about the promoted schema, which does not
--     exist yet, and nothing about an application transaction, which has
--     no integrated surface in this package. Evidence class:
--     `PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER)`.
--     That is a weaker claim than `PROVEN BY DATABASE CATALOGUE` on the
--     real tree and it is deliberately named differently.
--
-- `p5scratch.businesses` is a STAND-IN for the live relation. It exists
-- only to give the composite ownership FK something to point at; its two
-- columns are the two the live `businesses_tenant_id_id_uq` carries.
-- =====================================================================

DROP SCHEMA IF EXISTS p5scratch CASCADE;
CREATE SCHEMA p5scratch;

CREATE TABLE p5scratch.businesses (
  tenant_id uuid NOT NULL,
  id        uuid NOT NULL PRIMARY KEY,
  CONSTRAINT businesses_tenant_id_id_uq UNIQUE (tenant_id, id)
);

-- ── the ledger ───────────────────────────────────────────────────────
CREATE TABLE p5scratch.platform_credit_adjustments (
  id                  uuid        NOT NULL PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  kind                text        NOT NULL,
  amount_minor        bigint      NOT NULL,
  currency            text        NOT NULL,
  occurred_at         timestamptz NOT NULL,
  -- "the ledger's own write order; the ALLOCATION KEY". The database
  -- supplies it: a command that could choose its own write order could
  -- choose its own allocation order, which is the whole point of pinning
  -- the key to the ledger rather than to the caller.
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_ref          text        NOT NULL,
  reason              text        NOT NULL,
  applies_to_grant_id uuid,
  invoice_id          uuid,

  -- The referenced row must be a GRANT, and a foreign key cannot say
  -- "where kind = 'grant'". So the referencing row carries the kind it
  -- demands of its target, as a generated column that cannot disagree
  -- with `applies_to_grant_id`, and the FK includes it. A consumption
  -- naming another consumption is then refused by the key itself and not
  -- by a trigger anyone can disable.
  applies_to_kind     text GENERATED ALWAYS AS
                        (CASE WHEN applies_to_grant_id IS NOT NULL THEN 'grant' END) STORED,

  CONSTRAINT pca_kind_known           CHECK (kind IN ('grant', 'consumption')),
  CONSTRAINT pca_amount_positive      CHECK (amount_minor > 0),
  CONSTRAINT pca_currency_shape       CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT pca_reason_present       CHECK (length(reason) BETWEEN 1 AND 500),
  -- invariant (1): a grant cannot draw down a grant; a consumption must
  -- name what it draws. Both directions, as one equality.
  CONSTRAINT pca_kind_names_grant     CHECK ((kind = 'consumption') = (applies_to_grant_id IS NOT NULL)),
  CONSTRAINT pca_consumption_invoice  CHECK ((kind = 'consumption') = (invoice_id IS NOT NULL)),

  CONSTRAINT pca_owner_fk FOREIGN KEY (tenant_id, business_id)
    REFERENCES p5scratch.businesses (tenant_id, id),

  -- the identity the self-FK below resolves against: it carries owner,
  -- currency and kind, which is what makes the FK enforce all three.
  CONSTRAINT pca_scoped_identity_uq UNIQUE (tenant_id, business_id, currency, kind, id),

  -- invariant (2): same business, same currency, and a grant. Enforced by
  -- the key, so a direct INSERT cannot bypass it.
  CONSTRAINT pca_grant_same_owner_currency_kind
    FOREIGN KEY (tenant_id, business_id, currency, applies_to_kind, applies_to_grant_id)
    REFERENCES p5scratch.platform_credit_adjustments (tenant_id, business_id, currency, kind, id)
);

-- Identical-source invoices: one consumption per grant per invoice. A
-- second finalization of the SAME invoice cannot draw a second time, with
-- no lock and no application check — the key refuses it.
CREATE UNIQUE INDEX pca_one_consumption_per_grant_per_invoice
  ON p5scratch.platform_credit_adjustments (business_id, invoice_id, applies_to_grant_id)
  WHERE kind = 'consumption';

CREATE INDEX pca_ledger_read ON p5scratch.platform_credit_adjustments
  (tenant_id, business_id, currency, created_at, id);

-- ── invariant (4): per-grant conservation, at the INSERT ─────────────
-- The remainder is a ROW, not a query, for one reason: a row can be
-- locked. `sum(...) <= grant` evaluated inside an INSERT reads a snapshot
-- and two concurrent snapshots both pass it; decrementing a row forces
-- the second transaction to wait for the first and then see its result.
-- The CHECK is what makes an overdraw impossible; the row lock is what
-- makes the check see a committed world.
CREATE TABLE p5scratch.platform_credit_grant_remainders (
  tenant_id       uuid   NOT NULL,
  business_id     uuid   NOT NULL,
  currency        text   NOT NULL,
  grant_id        uuid   NOT NULL PRIMARY KEY,
  -- A constant column, so that the key below can demand that the row it
  -- summarises is a GRANT. Same device as `applies_to_kind` above, and
  -- for the same reason: a key that cannot be bypassed beats a trigger.
  grant_kind      text   NOT NULL DEFAULT 'grant',
  granted_minor   bigint NOT NULL,
  remaining_minor bigint NOT NULL,
  CONSTRAINT pcgr_granted_positive CHECK (granted_minor > 0),
  CONSTRAINT pcgr_never_overdrawn  CHECK (remaining_minor >= 0 AND remaining_minor <= granted_minor),
  CONSTRAINT pcgr_kind_is_grant    CHECK (grant_kind = 'grant'),
  CONSTRAINT pcgr_grant_fk FOREIGN KEY (tenant_id, business_id, currency, grant_kind, grant_id)
    REFERENCES p5scratch.platform_credit_adjustments (tenant_id, business_id, currency, kind, id)
    DEFERRABLE INITIALLY IMMEDIATE
);

-- The remainder is maintained ONLY by the ledger's own trigger. The
-- application role has no privilege on this table at all, so there is no
-- route by which a remainder can disagree with the rows it summarises.
CREATE FUNCTION p5scratch.pca_maintain_remainder() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = p5scratch, pg_temp AS $fn$
DECLARE
  hit integer;
BEGIN
  IF NEW.kind = 'grant' THEN
    INSERT INTO p5scratch.platform_credit_grant_remainders
      (tenant_id, business_id, currency, grant_id, granted_minor, remaining_minor)
    VALUES (NEW.tenant_id, NEW.business_id, NEW.currency, NEW.id, NEW.amount_minor, NEW.amount_minor);
    RETURN NEW;
  END IF;

  -- A consumption decrements its grant's remainder. The UPDATE takes the
  -- row lock; `pcgr_never_overdrawn` refuses the overdraw.
  UPDATE p5scratch.platform_credit_grant_remainders
     SET remaining_minor = remaining_minor - NEW.amount_minor
   WHERE grant_id = NEW.applies_to_grant_id;
  GET DIAGNOSTICS hit = ROW_COUNT;
  IF hit <> 1 THEN
    RAISE EXCEPTION 'credit consumption names a grant with no remainder row: %', NEW.applies_to_grant_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE CONSTRAINT TRIGGER pca_maintain_remainder_trg
  AFTER INSERT ON p5scratch.platform_credit_adjustments
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION p5scratch.pca_maintain_remainder();

-- ── invariant (3): append-only, by the database ──────────────────────
-- Privileges alone would leave a superuser or a future role grant able to
-- UPDATE. The trigger refuses regardless of who asks, which is what
-- "posted history immutable" means for a relation whose balance is a
-- fold: changing one row changes history with no trace.
CREATE FUNCTION p5scratch.pca_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'platform_credit_adjustments is append-only: % refused', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;

CREATE TRIGGER pca_append_only_trg
  BEFORE UPDATE OR DELETE ON p5scratch.platform_credit_adjustments
  FOR EACH ROW EXECUTE FUNCTION p5scratch.pca_append_only();

-- ── the recorded `created_at,id` vs `occurred_at` conflict ───────────
-- Resolved by making the two orders incapable of disagreeing, which is
-- neither a new formula nor a second allocation key: the allocation key
-- stays `(created_at, id)`, and a row whose `occurred_at` would make the
-- business/currency ledger non-monotonic in that order is REFUSED. The
-- pure core already refuses such a ledger on read
-- (`billing.credit_ledger_out_of_order`); this refuses it on write, so no
-- reader has to.
--
-- ROUND 8, the independent challenger's F-03. The `max(occurred_at)` below
-- is a SNAPSHOT read, and two concurrent transactions cannot see each
-- other's uncommitted row, so both used to pass: A wrote 10:00 and took the
-- earlier `created_at`, B wrote 09:00 and took the later one, and the
-- committed ledger was non-monotonic in `(created_at, id)` — the allocation
-- key. Because the ledger is append-only by trigger, the offending row can
-- never be amended, and `foldCreditBalance` is the single credit-balance
-- authority and refuses a non-monotonic ledger: that business's balance in
-- that currency became PERMANENTLY unreadable, with no remediation path.
-- A writer promising a property it cannot enforce, and a reader bricking on
-- the result, is worse than no guard at all.
--
-- The per-business advisory lock is taken HERE rather than left to the
-- caller, for the reason already recorded above `lock_grants_in_order`: the
-- caller convention is what round 4's case 12 violated. Finalization already
-- holds this exact key (`hashtext(schema || ':' || business_id)`), and an
-- advisory lock is re-entrant within a transaction, so that path is
-- unaffected; the ADMIN GRANT path, which takes no lock of its own, is the
-- one this closes.
--
-- The lock is taken BEFORE the read and held to commit, so the second writer
-- waits for the first and then reads a committed world. LIMIT, stated rather
-- than discovered later: this makes the guard total under READ COMMITTED,
-- which is what this lane runs and what the API uses. Under REPEATABLE READ
-- the second transaction's snapshot predates the first's commit and the read
-- would still not see it; a serializable caller needs
-- `pg_advisory_xact_lock` before it opens its statement, not inside a
-- trigger. A transaction that holds remainder row locks WITHOUT having taken
-- this key and then inserts a grant can now deadlock with a finalization —
-- PostgreSQL detects it and aborts one of them, which is a refusal and not a
-- corruption, and no path in this slice does that.
CREATE FUNCTION p5scratch.pca_chronology() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  latest timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('p5scratch:' || NEW.business_id::text));
  SELECT max(occurred_at) INTO latest
    FROM p5scratch.platform_credit_adjustments
   WHERE tenant_id = NEW.tenant_id AND business_id = NEW.business_id
     AND currency = NEW.currency AND id <> NEW.id;
  IF latest IS NOT NULL AND NEW.occurred_at < latest THEN
    RAISE EXCEPTION 'credit ledger would be out of order: occurred_at % precedes %', NEW.occurred_at, latest
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE CONSTRAINT TRIGGER pca_chronology_trg
  AFTER INSERT ON p5scratch.platform_credit_adjustments
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION p5scratch.pca_chronology();

-- ── invariant (5): RLS ENABLE + FORCE, deny by default ──────────────
ALTER TABLE p5scratch.platform_credit_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE p5scratch.platform_credit_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE p5scratch.platform_credit_grant_remainders ENABLE ROW LEVEL SECURITY;
ALTER TABLE p5scratch.platform_credit_grant_remainders FORCE ROW LEVEL SECURITY;

CREATE POLICY pca_tenant_isolation ON p5scratch.platform_credit_adjustments
  FOR SELECT USING (business_id = current_setting('app.business_id', true)::uuid);
CREATE POLICY pca_tenant_insert ON p5scratch.platform_credit_adjustments
  FOR INSERT WITH CHECK (business_id = current_setting('app.business_id', true)::uuid);

-- =====================================================================
-- ROUND 5 — added for Master Continuous Mission V2 §12.
--
-- V2 adds two asks to Phase 5 that round 4 did not meet:
--
--   «رتّب grant locks حتميًا؛ reverse-order deadlock المسجل يحتاج التحقق
--    من النسخة المصححة»
--     — order the grant locks deterministically, and the recorded
--       reverse-order deadlock needs the CORRECTED version verified.
--       Round 4 PROVED that hazard exists; it did not fix it.
--
--   «لا يثبت هذا ربط إقفال subscription_invoices الحقيقي بالمنح
--    والاستهلاك في المعاملة نفسها»
--     — nothing so far ties the invoice finalization to the grant and
--       the consumption in the SAME transaction.
--
-- V2 defers the second one to integration, "on the official schema and
-- command". It is realized here anyway, in the same deliberately weaker
-- class as everything else in this file, because a design that cannot be
-- shown to work is a design the Migration Owner has to take on trust.
-- =====================================================================

-- ── the deterministic grant lock order ───────────────────────────────
-- The fix for the reverse-order deadlock, as a function rather than a
-- convention, because a convention is what round 4's case 12 violated.
--
-- Every writer takes the remainder row locks UP FRONT, for the whole
-- business-and-currency ledger, in the ledger's own total order
-- `(created_at, id)` — the same order PART 25 pins allocation to. Two
-- writers that both do this cannot form a cycle: whoever gets the first
-- row gets all of them, and the other waits once instead of holding one
-- and reaching for another.
--
-- This is the SECOND line, not the first. The per-business advisory lock
-- is the first: it stops two finalizations for one business from
-- overlapping at all. This function is what protects a future code path
-- that forgets the advisory lock — and `test/db/` proves that both close
-- the deadlock, separately.
CREATE FUNCTION p5scratch.lock_grants_in_order(p_tenant uuid, p_business uuid, p_currency text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = p5scratch, pg_temp AS $fn$
DECLARE
  locked integer;
BEGIN
  -- `FOR UPDATE OF r` sits above the sort in the plan, so the rows are
  -- locked in sorted order and not in whatever order the scan found
  -- them. `test/db/credit-ledger-atomicity.test.ts` reads the plan and
  -- asserts that LockRows is above Sort, because "the planner happens to
  -- do this" is not a guarantee anyone can rely on.
  WITH ordered AS (
    SELECT r.grant_id
      FROM p5scratch.platform_credit_grant_remainders r
      JOIN p5scratch.platform_credit_adjustments a ON a.id = r.grant_id
     WHERE r.tenant_id = p_tenant AND r.business_id = p_business AND r.currency = p_currency
     ORDER BY a.created_at, a.id
       FOR UPDATE OF r
  )
  SELECT count(*)::integer INTO locked FROM ordered;
  RETURN locked;
END;
$fn$;

-- ── the platform invoice, and the tie to the ledger ──────────────────
-- §11c of the patch request, realized, in the vocabulary the round-6
-- Contract Diff settled: `charge_minor` is the composed invoice,
-- `credit_minor` is the platform credit applied, `tax_minor` is the
-- structural zero and `total_minor` is what is left to collect. Round 5
-- realized the same relation under three different names — and called the
-- figure BEFORE credit `total_minor`, which the earlier spec uses for the
-- figure AFTER it. One relation with two meanings for one column name is
-- the conflict V3 §12 required settled before promotion; the names here
-- are now the spec's, and `src/invoice-states.ts` holds the settled
-- lifecycle that `credit-ledger-contract.test.ts` pins this DDL to.
--
-- Realized here: the money columns, the state machine, the immutability
-- rule and one invoice per business per period. NOT realized: the period
-- bounds (`period_starts_at`, `period_ends_at`) and the invoice LINES —
-- nothing in the credit attack reads either, and a fixture that carried
-- columns no case exercises would claim coverage it does not have.
CREATE TABLE p5scratch.subscription_invoices (
  id            uuid        NOT NULL PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  business_id   uuid        NOT NULL,
  period_index  integer     NOT NULL,
  currency      text        NOT NULL,
  charge_minor  bigint      NOT NULL,
  credit_minor  bigint      NOT NULL DEFAULT 0,
  tax_minor     bigint      NOT NULL DEFAULT 0,
  total_minor   bigint      NOT NULL,
  state         text        NOT NULL,
  issued_at     timestamptz,
  CONSTRAINT si_charge_non_negative   CHECK (charge_minor >= 0),
  CONSTRAINT si_period_index_valid    CHECK (period_index >= 0),
  CONSTRAINT si_currency_shape        CHECK (currency ~ '^[A-Z]{3}$'),
  -- The five states of the settled contract. `finalized` is NOT one of
  -- them: a finalized, uncollected invoice is `open`, and two names for
  -- one state is how a sign gets lost.
  CONSTRAINT si_state_known           CHECK (state IN ('draft', 'open', 'paid', 'uncollectible', 'voided')),
  -- A draft has no issue instant, and anything that was ever OPEN has one.
  -- `voided` is the exception on purpose, and it was found by the
  -- twenty-five-pair law in `credit-ledger-contract.test.ts`: the first
  -- version of this CHECK read `(state = 'draft') = (issued_at IS NULL)`,
  -- which made the contract's own `draft -> voided` transition
  -- UNREACHABLE — an abandoned draft was never issued, so it has no
  -- instant to carry, and the trigger rightly refuses to invent one. A
  -- state machine with a transition no row can take is two contracts
  -- again, in miniature.
  CONSTRAINT si_issued_when_not_draft CHECK (
    (state = 'draft'  AND issued_at IS NULL)
    OR state = 'voided'
    OR (state IN ('open', 'paid', 'uncollectible') AND issued_at IS NOT NULL)
  ),
  CONSTRAINT si_credit_non_negative   CHECK (credit_minor >= 0),
  CONSTRAINT si_credit_within_charge  CHECK (credit_minor <= charge_minor),
  -- Platform tax is a policy nobody has settled, so it is structurally
  -- unrepresentable rather than defaulted (`OPEN-P5-02`).
  CONSTRAINT si_tax_structural_zero   CHECK (tax_minor = 0),
  CONSTRAINT si_total_non_negative    CHECK (total_minor >= 0),
  -- PART 25's "invoice payable cannot become negative" as arithmetic the
  -- database owns, not a code path a later edit changes.
  CONSTRAINT si_total_is_charge_minus_credit CHECK (total_minor = charge_minor - credit_minor + tax_minor),
  CONSTRAINT si_owner_fk FOREIGN KEY (tenant_id, business_id)
    REFERENCES p5scratch.businesses (tenant_id, id),
  -- §5's defence against a double renewal: a second invoice for the same
  -- business and period cannot insert, whatever the application does.
  CONSTRAINT si_one_per_period_uq UNIQUE (business_id, period_index),
  CONSTRAINT si_scoped_identity_uq UNIQUE (tenant_id, business_id, currency, id)
);

-- A period number for fixtures that do not care which period they are in.
-- `period_index` is NOT NULL and unique per business, so every draft needs
-- one; a sequence keeps the cases that are about credit from having to
-- invent periods, and leaves the one case that IS about the period free to
-- pass its own.
CREATE SEQUENCE p5scratch.scratch_period_seq;

-- ── the immutability rule, as the settled contract states it ─────────
-- The earlier spec's trigger allowed ONLY `state` to change. That would
-- refuse the finalization this whole phase is built on, because applying
-- credit writes `credit_minor` and `total_minor` in the same statement.
-- So the settled contract names the columns that one transition may
-- write — `src/invoice-states.ts`, `FINALIZATION_WRITABLE_COLUMNS` — and
-- freezes every other column and every other transition.
--
-- A BEFORE trigger rather than a CHECK because a CHECK cannot see OLD.
CREATE FUNCTION p5scratch.si_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a subscription invoice is never deleted: %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.business_id <> OLD.business_id
     OR NEW.period_index <> OLD.period_index
     OR NEW.currency <> OLD.currency
     OR NEW.charge_minor <> OLD.charge_minor
     OR NEW.tax_minor <> OLD.tax_minor THEN
    RAISE EXCEPTION 'a subscription invoice is fixed at composition: % may not change its identity, period, currency, charge or tax', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state = 'draft' AND NEW.state = 'open' THEN
    -- The finalization. `credit_minor`, `total_minor` and `issued_at` are
    -- the three the contract lets it write, and the CHECKs above are what
    -- keep them consistent with each other.
    RETURN NEW;
  END IF;

  IF (OLD.state = 'draft' AND NEW.state = 'voided')
     OR (OLD.state = 'open' AND NEW.state IN ('paid', 'uncollectible', 'voided')) THEN
    IF NEW.credit_minor <> OLD.credit_minor OR NEW.total_minor <> OLD.total_minor
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'only the state may change once invoice % is past draft', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'the subscription invoice contract does not allow % -> % on %', OLD.state, NEW.state, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;

CREATE TRIGGER si_immutable_trg
  BEFORE UPDATE OR DELETE ON p5scratch.subscription_invoices
  FOR EACH ROW EXECUTE FUNCTION p5scratch.si_immutable();

-- A consumption's invoice must exist, in the same business and currency.
-- DEFERRABLE, so the two writes may happen in either order inside one
-- transaction — and NOT INITIALLY DEFERRED, so a transaction that never
-- writes the invoice still fails, at commit.
ALTER TABLE p5scratch.platform_credit_adjustments
  ADD CONSTRAINT pca_invoice_fk
  FOREIGN KEY (tenant_id, business_id, currency, invoice_id)
  REFERENCES p5scratch.subscription_invoices (tenant_id, business_id, currency, id)
  DEFERRABLE INITIALLY DEFERRED;

-- ── the invariant V2 says is unproven ────────────────────────────────
-- "the invoice finalization tied to the grant and the consumption in the
-- same transaction": an invoice's `credit_minor` must equal the
-- sum of the consumption rows naming it. DEFERRED to commit, which is
-- what makes it a statement about the TRANSACTION rather than about one
-- statement inside it — and what makes partial consumption impossible:
-- a transaction that writes 500 of credit onto the invoice and only 300
-- of consumption rows cannot commit, whichever order it wrote them in.
-- One check, reached from two triggers.
--
-- It is a separate function rather than one trigger function branching on
-- TG_TABLE_NAME because plpgsql resolves `NEW.<field>` against the trigger
-- table at RUNTIME: a single function reading `NEW.invoice_id` compiles
-- fine and then fails with `record "new" has no field "invoice_id"` the
-- first time the invoice table fires it. (It did.)
--
-- ROUND 8, the independent challenger's F-01, a P1. This function used to be
-- plain `LANGUAGE plpgsql` with no `SECURITY DEFINER` and no `search_path`,
-- unlike its two neighbours `pca_maintain_remainder()` and
-- `lock_grants_in_order()`, which both carry it. So both of its reads ran
-- under the CALLER's row-level security policy, which is keyed to
-- `current_setting('app.business_id', true)`. When the invoice was not
-- visible, `claimed` came back NULL and the function took the branch below
-- that treats NULL as "the invoice is gone" and RETURNED. Silently. The
-- triggers are DEFERRABLE INITIALLY DEFERRED, so this runs at COMMIT, by
-- which time a pooled worker that processes tenants in a loop may have
-- legitimately moved `app.business_id` on — no privilege required that the
-- application role does not already hold. The challenger's reproduction
-- committed an invoice claiming 500 of credit against consumption rows
-- summing to 300. The ledger is append-only, so that state is not
-- repairable by any later write.
--
-- `pca_invoice_fk` does not save it: foreign-key enforcement bypasses RLS,
-- so the key was satisfied while the agreement check was skipped.
--
-- The second read was wrong the same way and nobody had noticed: even with
-- the invoice visible, `sum(a.amount_minor)` over the consumption rows is
-- subject to the same policy, so a partially visible ledger would have made
-- `consumed` too small and raised on a transaction that was correct.
--
-- Definer rights make the invariant see the whole relation, which is what an
-- invariant must do. The schema owner holds the two `..._invariant_read`
-- policies in `credit-ledger-roles.sql`, so this does NOT rest on the owner
-- being a superuser — which is the thing the challenger's F-05 showed was
-- concealing this defect.
CREATE FUNCTION p5scratch.assert_invoice_credit_agrees(p_invoice uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = p5scratch, pg_temp AS $fn$
DECLARE
  claimed bigint;
  consumed bigint;
  invoice_state text;
BEGIN
  SELECT i.credit_minor, i.state INTO claimed, invoice_state
    FROM p5scratch.subscription_invoices i WHERE i.id = p_invoice;
  IF claimed IS NULL THEN
    -- The invoice does not exist: the transaction rolled it back, or never
    -- wrote it. `pca_invoice_fk` is the constraint that reports that, and it
    -- is PROVEN to: "consumption rows with no invoice at all cannot commit
    -- either" in `credit-ledger-atomicity.test.ts` reddens when that key is
    -- dropped (round 7's mutation M28). So this RETURN hands the case to a
    -- constraint that is measured, not to an assumption.
    --
    -- Under definer rights, NULL now means "no such row" and nothing else.
    -- Before round 8 it also meant "a row I am not allowed to see", and
    -- those two are not the same thing — which is the whole of F-01.
    RETURN;
  END IF;
  IF invoice_state = 'draft' THEN
    -- A draft carries no credit. Checked rather than assumed, because a
    -- draft with a non-zero figure would otherwise pass unexamined.
    IF claimed <> 0 THEN
      RAISE EXCEPTION 'a draft invoice may not claim applied credit: % claims %', p_invoice, claimed
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN;
  END IF;
  SELECT coalesce(sum(a.amount_minor), 0) INTO consumed
    FROM p5scratch.platform_credit_adjustments a
   WHERE a.kind = 'consumption' AND a.invoice_id = p_invoice;
  IF claimed <> consumed THEN
    RAISE EXCEPTION 'invoice % claims % of applied credit but its consumption rows sum to %',
      p_invoice, claimed, consumed
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$fn$;

CREATE FUNCTION p5scratch.si_credit_agrees() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM p5scratch.assert_invoice_credit_agrees(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION p5scratch.pca_credit_agrees() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM p5scratch.assert_invoice_credit_agrees(NEW.invoice_id);
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER si_credit_agrees_trg
  AFTER INSERT OR UPDATE ON p5scratch.subscription_invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p5scratch.si_credit_agrees();

CREATE CONSTRAINT TRIGGER pca_credit_agrees_trg
  AFTER INSERT ON p5scratch.platform_credit_adjustments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'consumption')
  EXECUTE FUNCTION p5scratch.pca_credit_agrees();

ALTER TABLE p5scratch.subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE p5scratch.subscription_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY si_tenant_isolation ON p5scratch.subscription_invoices
  FOR SELECT USING (business_id = current_setting('app.business_id', true)::uuid);
CREATE POLICY si_tenant_insert ON p5scratch.subscription_invoices
  FOR INSERT WITH CHECK (business_id = current_setting('app.business_id', true)::uuid);
-- An UPDATE policy is required and is NOT implied by the other two: with
-- FORCE RLS and no UPDATE policy, the application role holds the UPDATE
-- privilege and can still update no row at all — which would look like a
-- working finalization in a unit test and fail in production. Both the
-- USING and the WITH CHECK side are scoped, so a row cannot be moved to
-- another business by updating it either.
CREATE POLICY si_tenant_update ON p5scratch.subscription_invoices
  FOR UPDATE USING (business_id = current_setting('app.business_id', true)::uuid)
          WITH CHECK (business_id = current_setting('app.business_id', true)::uuid);

-- =====================================================================
-- ROUND 6 — the collection attempt, and the rule V3 §12 adds
--
--   «قبل مزوّد تحصيل حقيقي، اربط محاولة التحصيل بهوية منطقية ثابتة لدى
--    المزوّد؛ إذا قُبل الطلب وضاع الرد فلا تُنشئ محاولة بمفتاح جديد قبل
--    المصالحة، لأن تفرد صف النجاح في DB لا يمنع خصمًا خارجيًا ثانيًا»
--
-- The last clause is the one that decides what this table can and cannot
-- be. It cannot prevent the second debit: by the time a second request
-- leaves the process the money has moved at another institution, and a
-- unique index here could then only refuse to RECORD it — which is worse
-- than useless. The defence is in `src/collection.ts`, in what the
-- request is NAMED.
--
-- What the database CAN do, and does here, is make the application unable
-- to ADVANCE past an attempt it has not accounted for. Three witnesses:
--   1. a key that does not name its own attempt is unrepresentable;
--   2. no second attempt may be inserted for an invoice while one has no
--      verdict (the trigger), and two racing unresolved attempts cannot
--      both exist (the partial unique index);
--   3. at most one success per invoice, ever.
--
-- §7 of the patch request is amended by this round in one way: the
-- relation is append-only EXCEPT for the single transition
-- `unknown -> succeeded | declined | failed`, which is RECONCILIATION —
-- recording the verdict the provider always had and we had not read. It
-- is the same shape as the invoice's one mutable transition, and it is
-- why the application role needs UPDATE here, narrowed by a trigger, where
-- §7 originally granted none.
-- =====================================================================
CREATE TABLE p5scratch.subscription_charge_attempts (
  id              uuid        NOT NULL PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  business_id     uuid        NOT NULL,
  invoice_id      uuid        NOT NULL,
  attempt_no      integer     NOT NULL,
  idempotency_key text        NOT NULL,
  amount_minor    bigint      NOT NULL,
  currency        text        NOT NULL,
  outcome         text        NOT NULL,
  provider        text        NOT NULL,
  provider_ref    text        NOT NULL,
  provider_code   text,
  attempted_at    timestamptz NOT NULL,
  CONSTRAINT sca_attempt_no_valid CHECK (attempt_no >= 1),
  CONSTRAINT sca_amount_positive  CHECK (amount_minor > 0),
  CONSTRAINT sca_outcome_known    CHECK (outcome IN ('succeeded', 'declined', 'failed', 'unknown')),
  -- A declined or failed attempt carries the provider's own code; a
  -- success needs none, and an UNKNOWN attempt has none to carry — which
  -- the original §7 CHECK would have made unrepresentable without a
  -- fabricated code, since it required a code for everything but a
  -- success.
  CONSTRAINT sca_code_present CHECK (outcome IN ('succeeded', 'unknown') OR provider_code IS NOT NULL),
  -- The key NAMES the attempt. A key that does not end in the invoice and
  -- the ordinal it belongs to is refused, so a caller that generated a
  -- fresh random key per call cannot record it at all. The namespace is
  -- deliberately NOT named here: that part is the application's
  -- (`COLLECTION_KEY_NAMESPACE`), and a schema that pinned it would need a
  -- migration to rename a string.
  CONSTRAINT sca_key_names_attempt CHECK (idempotency_key LIKE '%:' || invoice_id::text || ':' || attempt_no::text),
  CONSTRAINT sca_key_long_enough   CHECK (length(idempotency_key) >= 8),
  CONSTRAINT sca_owner_fk FOREIGN KEY (tenant_id, business_id)
    REFERENCES p5scratch.businesses (tenant_id, id),
  CONSTRAINT sca_invoice_fk FOREIGN KEY (tenant_id, business_id, currency, invoice_id)
    REFERENCES p5scratch.subscription_invoices (tenant_id, business_id, currency, id),
  -- One key is one charge, and the order of attempts is a fact.
  CONSTRAINT sca_key_uq   UNIQUE (idempotency_key),
  CONSTRAINT sca_order_uq UNIQUE (invoice_id, attempt_no)
);

-- An invoice is collected at most once.
CREATE UNIQUE INDEX sca_one_success_per_invoice
  ON p5scratch.subscription_charge_attempts (invoice_id) WHERE outcome = 'succeeded';

-- And has at most one attempt awaiting a verdict. This is the witness that
-- holds under concurrency: two processes that both decide to retry, in the
-- same instant, cannot both record an unresolved attempt.
CREATE UNIQUE INDEX sca_one_unresolved_per_invoice
  ON p5scratch.subscription_charge_attempts (invoice_id) WHERE outcome = 'unknown';

CREATE FUNCTION p5scratch.sca_no_attempt_while_unresolved() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM p5scratch.subscription_charge_attempts
     WHERE invoice_id = NEW.invoice_id AND outcome = 'unknown'
  ) THEN
    RAISE EXCEPTION 'invoice % has an attempt with no verdict; reconcile it before attempting again', NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sca_no_attempt_while_unresolved_trg
  BEFORE INSERT ON p5scratch.subscription_charge_attempts
  FOR EACH ROW EXECUTE FUNCTION p5scratch.sca_no_attempt_while_unresolved();

CREATE FUNCTION p5scratch.sca_append_only_except_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a collection attempt is never deleted: %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.outcome <> 'unknown' THEN
    RAISE EXCEPTION 'a collection attempt with a verdict is immutable: %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.outcome NOT IN ('succeeded', 'declined', 'failed') THEN
    RAISE EXCEPTION 'reconciliation records a verdict, and % is not one', NEW.outcome
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.business_id <> OLD.business_id
     OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.attempt_no <> OLD.attempt_no
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency
     OR NEW.attempted_at <> OLD.attempted_at THEN
    RAISE EXCEPTION 'reconciliation may record the verdict and the provider''s own fields, and nothing else: %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sca_append_only_trg
  BEFORE UPDATE OR DELETE ON p5scratch.subscription_charge_attempts
  FOR EACH ROW EXECUTE FUNCTION p5scratch.sca_append_only_except_reconciliation();

ALTER TABLE p5scratch.subscription_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE p5scratch.subscription_charge_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY sca_tenant_isolation ON p5scratch.subscription_charge_attempts
  FOR SELECT USING (business_id = current_setting('app.business_id', true)::uuid);
CREATE POLICY sca_tenant_insert ON p5scratch.subscription_charge_attempts
  FOR INSERT WITH CHECK (business_id = current_setting('app.business_id', true)::uuid);
CREATE POLICY sca_tenant_update ON p5scratch.subscription_charge_attempts
  FOR UPDATE USING (business_id = current_setting('app.business_id', true)::uuid)
          WITH CHECK (business_id = current_setting('app.business_id', true)::uuid);
