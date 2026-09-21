-- 0026_versioned_trial_override_shape_ownership.sql — Gate A §40–51.
--
-- §40–44 PLAN CONTRACT VERSIONING: trial configuration is part of the
-- VERSIONED commercial contract (plan_versions), not a mutable global plan
-- row. Backfill from plans.trial_days, then drop the mutable source.
-- Published immutability is already enforced row-wide by
-- plan_versions_lifecycle (0022) — the new column is covered automatically.
--
-- §45–48 OVERRIDE STRICT SHAPE: not only the key XOR — the VALUE columns
-- must match the override kind exactly.
--
-- §49–51 AUDIT/OUTBOX OWNERSHIP INTEGRITY: when business_id is present,
-- tenant_id MUST match the business's owning tenant — composite FK.
-- Platform-level events keep business_id NULL (MATCH SIMPLE passes).

-- §41: versioned trial config + safe backfill.
-- The backfill UPDATE touches PUBLISHED rows; the lifecycle trigger (0022)
-- would block it. Managed-PostgreSQL-safe (§17–18): NO session_replication_role
-- (superuser-only). The migration role OWNS the schema, so it may suspend the
-- trigger for exactly the backfill and re-enable it immediately.
ALTER TABLE plan_versions DISABLE TRIGGER plan_versions_lifecycle_trg;
ALTER TABLE plan_versions ADD COLUMN trial_days INT;
UPDATE plan_versions pv SET trial_days = p.trial_days FROM plans p WHERE p.key = pv.plan_key;
ALTER TABLE plan_versions ENABLE TRIGGER plan_versions_lifecycle_trg;
ALTER TABLE plan_versions
    ALTER COLUMN trial_days SET NOT NULL,
    ALTER COLUMN trial_days SET DEFAULT 14,
    ADD CONSTRAINT plan_versions_trial_days_range CHECK (trial_days BETWEEN 0 AND 365);
ALTER TABLE plans DROP COLUMN trial_days;

-- §46–47: exact override shapes.
ALTER TABLE entitlement_overrides
    ADD CONSTRAINT entitlement_overrides_feature_shape CHECK (
        feature_key IS NULL
        OR (enabled_value IS NOT NULL AND limit_key IS NULL AND limit_value IS NULL)
    ),
    ADD CONSTRAINT entitlement_overrides_limit_shape CHECK (
        limit_key IS NULL
        OR (limit_value IS NOT NULL AND feature_key IS NULL AND enabled_value IS NULL)
    );

-- §50: composite ownership FK target.
CREATE UNIQUE INDEX businesses_tenant_id_id_uq ON businesses (tenant_id, id);

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_business_tenant_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id);

ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_events_business_tenant_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id);
