-- 0018: onboarding / creation-command idempotency operations.
-- Same key + same payload -> replay stored result. Same key + different payload -> 409.
-- Platform-managed table: written only through the trusted provisioning boundary.

CREATE TABLE onboarding_operations (
    user_id UUID NOT NULL REFERENCES users (id),
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
    kind TEXT NOT NULL CHECK (kind IN ('initial_onboarding', 'create_business')),
    payload_hash TEXT NOT NULL,
    result_tenant_id UUID,
    result_business_id UUID REFERENCES businesses (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, idempotency_key)
);

ALTER TABLE onboarding_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY onboarding_operations_platform_only ON onboarding_operations
    USING (app_bypass())
    WITH CHECK (app_bypass());

GRANT SELECT, INSERT ON onboarding_operations TO daftar_platform;
