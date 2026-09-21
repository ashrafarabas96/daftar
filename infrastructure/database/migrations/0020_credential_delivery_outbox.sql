-- 0020 — Credential delivery outbox (Final Closure §18–20).
-- Invitations and password resets share ONE reliable pipeline:
-- enqueue (same tx as the credential) → worker drain (retry + backoff) →
-- dead-letter after the retry limit. Parent rows mirror the delivery state.

CREATE TABLE credential_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('invitation', 'password_reset')),
    business_id UUID,
    invitation_id UUID REFERENCES business_invitations (id) ON DELETE CASCADE,
    password_reset_token_id UUID REFERENCES password_reset_tokens (id) ON DELETE CASCADE,
    email CITEXT NOT NULL,
    secret TEXT NOT NULL, -- raw token, visible only to the delivery pipeline
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'invitation' AND invitation_id IS NOT NULL AND password_reset_token_id IS NULL)
        OR (kind = 'password_reset' AND password_reset_token_id IS NOT NULL))
);

ALTER TABLE credential_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_deliveries FORCE ROW LEVEL SECURITY;

-- Worker reads/updates; app+identity enqueue their own kind; platform bypasses.
CREATE POLICY credential_deliveries_select ON credential_deliveries
    USING (app_bypass() OR current_user IN ('daftar_worker', 'daftar_app', 'daftar_identity'));
CREATE POLICY credential_deliveries_insert ON credential_deliveries
    FOR INSERT WITH CHECK (
        app_bypass()
        OR (current_user = 'daftar_app' AND kind = 'invitation')
        OR (current_user = 'daftar_identity' AND kind = 'password_reset')
    );
CREATE POLICY credential_deliveries_update ON credential_deliveries
    FOR UPDATE USING (app_bypass() OR current_user = 'daftar_worker')
    WITH CHECK (app_bypass() OR current_user = 'daftar_worker');

GRANT SELECT, INSERT ON credential_deliveries TO daftar_app;
GRANT SELECT, INSERT ON credential_deliveries TO daftar_identity;
GRANT SELECT, INSERT, UPDATE ON credential_deliveries TO daftar_platform;
GRANT SELECT, UPDATE ON credential_deliveries TO daftar_worker;

-- Expanded delivery states on the parent rows (processing / dead added).
ALTER TABLE business_invitations DROP CONSTRAINT IF EXISTS business_invitations_delivery_status_check;
ALTER TABLE business_invitations ADD CONSTRAINT business_invitations_delivery_status_check
    CHECK (delivery_status IN ('pending', 'processing', 'sent', 'failed', 'dead'));
ALTER TABLE password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_delivery_status_check;
ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_delivery_status_check
    CHECK (delivery_status IN ('pending', 'processing', 'sent', 'failed', 'dead'));

-- Worker mirror: column-scoped grants + RLS exemptions on the parent tables.
-- SELECT on businesses: the permissive tenant_membership policy subquery
-- evaluates `EXISTS (SELECT 1 FROM businesses ...)` regardless of which
-- permissive policy matches, so the worker needs the table privilege.
GRANT SELECT ON businesses TO daftar_worker;
GRANT SELECT ON business_invitations TO daftar_worker;
GRANT UPDATE (delivery_status, delivery_attempts, last_delivery_error) ON business_invitations TO daftar_worker;
GRANT SELECT ON password_reset_tokens TO daftar_worker;
GRANT UPDATE (delivery_status, delivery_attempts, last_delivery_error) ON password_reset_tokens TO daftar_worker;

-- Permissive worker policies (OR'd with the existing tenant policies).
CREATE POLICY worker_delivery ON business_invitations
    USING (current_user = 'daftar_worker')
    WITH CHECK (current_user = 'daftar_worker');
CREATE POLICY worker_delivery ON password_reset_tokens
    USING (current_user = 'daftar_worker')
    WITH CHECK (current_user = 'daftar_worker');

-- The RESTRICTIVE business_isolation policy on business_invitations must not
-- block the worker. Recreate it with the worker exemption (0014 pattern).
DROP POLICY business_isolation ON business_invitations;
CREATE POLICY business_isolation ON business_invitations AS RESTRICTIVE
    USING (app_bypass() OR current_user = 'daftar_worker' OR business_id::text = app_business())
    WITH CHECK (app_bypass() OR current_user = 'daftar_worker' OR business_id::text = app_business());
