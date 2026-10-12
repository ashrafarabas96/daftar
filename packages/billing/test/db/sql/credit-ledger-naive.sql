-- =====================================================================
-- THE NAIVE VARIANT — the same ledger with invariant (4) and the
-- identical-source key REMOVED, so that conservation is enforced only by
-- application code.
--
-- This file exists to be RED. Directive #11 PART 17 and the Master
-- Continuous Mission both forbid a proof that would pass with the thing
-- it tests removed, and the only way to show that the per-grant
-- remainder and the partial unique index are what close the double-spend
-- is to run the same interleaving against a schema that lacks them and
-- watch the money duplicate. It is the mutation, kept as a file rather
-- than applied to the real one, because a mutation applied in place is
-- how a tree gets left dirty.
--
-- Everything else — ownership FK, kind CHECK, the self-FK pinned to
-- business, currency and kind, append-only, chronology, RLS — is
-- identical, so the only difference the test can be attributing the
-- outcome to is the one removed.
-- =====================================================================

-- ROUND 12: the schema is created by the LANE, not by this file, because
-- in the real-schema lane the principal applying it holds no CREATE on the
-- database — exactly as a deployment principal would not.
SET search_path = p5naive, public;

CREATE TABLE p5naive.businesses (
  tenant_id uuid NOT NULL,
  id        uuid NOT NULL PRIMARY KEY,
  CONSTRAINT businesses_tenant_id_id_uq UNIQUE (tenant_id, id)
);

CREATE TABLE p5naive.platform_credit_adjustments (
  id                  uuid        NOT NULL PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  business_id         uuid        NOT NULL,
  kind                text        NOT NULL,
  amount_minor        bigint      NOT NULL,
  currency            text        NOT NULL,
  occurred_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_ref          text        NOT NULL,
  reason              text        NOT NULL,
  applies_to_grant_id uuid,
  invoice_id          uuid,
  applies_to_kind     text GENERATED ALWAYS AS
                        (CASE WHEN applies_to_grant_id IS NOT NULL THEN 'grant' END) STORED,
  CONSTRAINT pca_kind_known          CHECK (kind IN ('grant', 'consumption')),
  CONSTRAINT pca_amount_positive     CHECK (amount_minor > 0),
  CONSTRAINT pca_currency_shape      CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT pca_reason_present      CHECK (length(reason) BETWEEN 1 AND 500),
  CONSTRAINT pca_kind_names_grant    CHECK ((kind = 'consumption') = (applies_to_grant_id IS NOT NULL)),
  CONSTRAINT pca_consumption_invoice CHECK ((kind = 'consumption') = (invoice_id IS NOT NULL)),
  CONSTRAINT pca_owner_fk FOREIGN KEY (tenant_id, business_id)
    REFERENCES p5naive.businesses (tenant_id, id),
  CONSTRAINT pca_scoped_identity_uq UNIQUE (tenant_id, business_id, currency, kind, id),
  CONSTRAINT pca_grant_same_owner_currency_kind
    FOREIGN KEY (tenant_id, business_id, currency, applies_to_kind, applies_to_grant_id)
    REFERENCES p5naive.platform_credit_adjustments (tenant_id, business_id, currency, kind, id)
);

-- DELIBERATELY ABSENT: platform_credit_grant_remainders and its trigger
-- (invariant 4), and pca_one_consumption_per_grant_per_invoice.

-- ROUND 5: the invoice relation, so the naive variant differs from the
-- requested one ONLY in the mechanisms under test. It gets the same
-- CHECKs and the same deferrable FK from a consumption to its invoice.
--
-- DELIBERATELY ABSENT here too: the deferred agreement trigger that makes
-- an invoice's `credit_minor` equal the sum of the consumption
-- rows naming it. So on this schema an invoice may claim a figure its own
-- ledger rows do not support, which is the second symptom of the naive
-- double-spend and is asserted as such.
CREATE SEQUENCE p5naive.scratch_period_seq;

CREATE TABLE p5naive.subscription_invoices (
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
  -- The naive schema keeps the invoice's own arithmetic: what it lacks is
  -- the per-grant conservation row, the identical-source key and the
  -- immutability trigger. An attack has to succeed somewhere specific.
  CONSTRAINT si_state_known           CHECK (state IN ('draft', 'open', 'paid', 'uncollectible', 'voided')),
  CONSTRAINT si_credit_non_negative   CHECK (credit_minor >= 0),
  CONSTRAINT si_total_non_negative    CHECK (total_minor >= 0),
  CONSTRAINT si_owner_fk FOREIGN KEY (tenant_id, business_id)
    REFERENCES p5naive.businesses (tenant_id, id),
  CONSTRAINT si_scoped_identity_uq UNIQUE (tenant_id, business_id, currency, id)
);

ALTER TABLE p5naive.platform_credit_adjustments
  ADD CONSTRAINT pca_invoice_fk
  FOREIGN KEY (tenant_id, business_id, currency, invoice_id)
  REFERENCES p5naive.subscription_invoices (tenant_id, business_id, currency, id)
  DEFERRABLE INITIALLY DEFERRED;
