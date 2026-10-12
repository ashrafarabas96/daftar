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
