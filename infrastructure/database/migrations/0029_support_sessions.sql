-- 0029: Support sessions (§LII–LIV) — time-boxed, reason-bound, fully audited
-- platform-actor access into a specific tenant. READ_ONLY only in Phase 1;
-- expired or revoked sessions deny IMMEDIATELY; credentials are never shared
-- (the platform actor authenticates as themselves; the session is the grant).

CREATE TABLE support_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reason          TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
    actor_user_id   UUID NOT NULL REFERENCES users(id),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    business_id     UUID,                       -- optional narrower scope
    mode            TEXT NOT NULL DEFAULT 'READ_ONLY' CHECK (mode IN ('READ_ONLY')),
    starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    revoked_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > starts_at)
);

-- business_id, when present, must belong to the session's tenant.
CREATE UNIQUE INDEX businesses_id_tenant_uq ON businesses (id, tenant_id);
ALTER TABLE support_sessions
    ADD CONSTRAINT support_sessions_business_tenant_fk
    FOREIGN KEY (business_id, tenant_id)
    REFERENCES businesses (id, tenant_id) ON DELETE CASCADE;

CREATE INDEX support_sessions_actor_idx ON support_sessions (actor_user_id, expires_at);
CREATE INDEX support_sessions_tenant_idx ON support_sessions (tenant_id, expires_at);

-- No UPDATE of terms after creation: sessions are immutable except revocation.
CREATE OR REPLACE FUNCTION support_sessions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.mode IS DISTINCT FROM OLD.mode
       OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'support sessions are immutable except revocation' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'support session already revoked' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER support_sessions_immutable_trg
    BEFORE UPDATE ON support_sessions
    FOR EACH ROW EXECUTE FUNCTION support_sessions_immutable();

GRANT SELECT, INSERT ON support_sessions TO daftar_platform;
GRANT UPDATE (revoked_at, revoked_reason) ON support_sessions TO daftar_platform;
