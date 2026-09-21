-- 0021 — SaaS enforcement (Final Closure §21–33):
-- limit_definitions registry with FKs from plan_limits + entitlement_overrides
-- (no arbitrary strings), expanded subscription state machine, plan-configured
-- trial days (no hardcoded 14), and period bounds for effective-state math.

-- 1) Limit registry (§26–27).
CREATE TABLE limit_definitions (
    key                  TEXT PRIMARY KEY,
    unit                 TEXT NOT NULL,
    description          TEXT NOT NULL,
    measurement_strategy TEXT NOT NULL,
    active               BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO limit_definitions (key, unit, description, measurement_strategy) VALUES
  ('MAX_USERS',           'count',  'Active memberships + valid pending invitations', 'count_rows'),
  ('MAX_BRANCHES',        'count',  'Active branches per business',                   'count_rows'),
  ('MAX_PRODUCTS',        'count',  'Non-archived products per business',             'count_rows'),
  ('MAX_STORAGE',         'bytes',  'Media storage usage (Phase 2 measurement)',      'sum_bytes'),
  ('MAX_AI_USAGE',        'tokens', 'AI assistant usage (Phase 2 measurement)',       'metered'),
  ('MAX_WHATSAPP_USAGE',  'messages','WhatsApp automation usage (Phase 2 measurement)','metered');

-- 2) Registry FKs (§28).
ALTER TABLE plan_limits
    ADD CONSTRAINT plan_limits_limit_key_fk FOREIGN KEY (limit_key) REFERENCES limit_definitions (key);
ALTER TABLE entitlement_overrides
    ADD CONSTRAINT entitlement_overrides_limit_key_fk FOREIGN KEY (limit_key) REFERENCES limit_definitions (key);

-- 3) Subscription state machine (§29).
ALTER TABLE business_entitlements DROP CONSTRAINT IF EXISTS business_entitlements_state_check;
ALTER TABLE business_entitlements ADD CONSTRAINT business_entitlements_state_check
    CHECK (state IN ('trial','active','grace_period','past_due','paused',
                     'cancel_at_period_end','cancelled','expired','complimentary'));
-- Period bounds drive the EFFECTIVE state (§30): no scheduler required.
ALTER TABLE business_entitlements ADD COLUMN period_ends_at TIMESTAMPTZ;

-- 4) Trial length is PLAN CONFIG, not code (§33).
ALTER TABLE plans ADD COLUMN trial_days INT NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 365);
