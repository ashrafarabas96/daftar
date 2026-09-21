-- 0004 — audit (append-only) + transactional outbox
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  business_id UUID,
  actor_user_id UUID,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- safe metadata only: no tokens/passwords/private URLs
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_business_idx ON audit_events (business_id, created_at);
CREATE INDEX audit_entity_idx ON audit_events (entity, entity_id);

-- Append-only: no UPDATE/DELETE ever (defense in depth beyond grants).
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_append_only();

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  business_id UUID,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','dead')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at) WHERE status = 'pending';
