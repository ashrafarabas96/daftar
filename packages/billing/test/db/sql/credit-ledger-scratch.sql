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
CREATE FUNCTION p5scratch.pca_chronology() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  latest timestamptz;
BEGIN
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
-- §11c of the patch request, realized: `credit_applied_minor` and
-- `payable_minor` as COLUMNS with CHECKs, because the provider charge is
-- taken against `payable_minor` and a figure a charge was taken against
-- must be the figure that was recorded.
CREATE TABLE p5scratch.subscription_invoices (
  id                   uuid        NOT NULL PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  business_id          uuid        NOT NULL,
  currency             text        NOT NULL,
  total_minor          bigint      NOT NULL,
  credit_applied_minor bigint      NOT NULL DEFAULT 0,
  payable_minor        bigint      NOT NULL,
  state                text        NOT NULL,
  finalized_at         timestamptz,
  CONSTRAINT si_total_positive        CHECK (total_minor > 0),
  CONSTRAINT si_currency_shape        CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT si_state_known           CHECK (state IN ('draft', 'finalized')),
  CONSTRAINT si_finalized_has_instant CHECK ((state = 'finalized') = (finalized_at IS NOT NULL)),
  CONSTRAINT si_credit_non_negative   CHECK (credit_applied_minor >= 0),
  CONSTRAINT si_credit_within_total   CHECK (credit_applied_minor <= total_minor),
  CONSTRAINT si_payable_non_negative  CHECK (payable_minor >= 0),
  -- PART 25's "invoice payable cannot become negative" as arithmetic the
  -- database owns, not a code path a later edit changes.
  CONSTRAINT si_payable_is_total_minus_credit CHECK (payable_minor = total_minor - credit_applied_minor),
  CONSTRAINT si_owner_fk FOREIGN KEY (tenant_id, business_id)
    REFERENCES p5scratch.businesses (tenant_id, id),
  CONSTRAINT si_scoped_identity_uq UNIQUE (tenant_id, business_id, currency, id)
);

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
-- same transaction": an invoice's `credit_applied_minor` must equal the
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
CREATE FUNCTION p5scratch.assert_invoice_credit_agrees(p_invoice uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  claimed bigint;
  consumed bigint;
  invoice_state text;
BEGIN
  SELECT i.credit_applied_minor, i.state INTO claimed, invoice_state
    FROM p5scratch.subscription_invoices i WHERE i.id = p_invoice;
  IF claimed IS NULL THEN
    -- The invoice is gone: the transaction rolled it back, or never wrote
    -- it. `pca_invoice_fk` is the constraint that reports that; there is
    -- nothing here left to compare.
    RETURN;
  END IF;
  IF invoice_state <> 'finalized' THEN
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
