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

DROP SCHEMA IF EXISTS p5naive CASCADE;
CREATE SCHEMA p5naive;

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
