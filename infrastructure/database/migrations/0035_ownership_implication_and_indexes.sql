-- 0035_ownership_implication_and_indexes.sql
-- Completion Directive §47 + §69.
--
-- §47 AUDIT / OUTBOX: "if business_id IS NOT NULL then tenant_id IS NOT NULL".
-- 0026 added the composite FK (tenant_id, business_id) → businesses(tenant_id,
-- id), which proves the business belongs to the tenant WHEN BOTH ARE SET —
-- but a MATCH SIMPLE FK is satisfied by a NULL tenant_id, so a row could name
-- a business with no tenant. The CHECK below closes that gap; together with
-- the FK it is now impossible to record a business-scoped audit/outbox row
-- without its owning tenant.
-- Backfill (pre-release databases only, PATH A): rows recorded with a
-- business but no tenant take the tenant of that business; a business-scoped
-- row whose business no longer exists loses its dangling business reference.
-- audit_events is append-only by trigger (0004); this one-time schema
-- correction lifts the trigger for the backfill only and restores it.
ALTER TABLE audit_events DISABLE TRIGGER audit_no_update;
UPDATE audit_events a SET tenant_id = b.tenant_id FROM businesses b
  WHERE a.business_id = b.id AND a.tenant_id IS NULL;
UPDATE audit_events SET business_id = NULL WHERE business_id IS NOT NULL AND tenant_id IS NULL;
ALTER TABLE audit_events ENABLE TRIGGER audit_no_update;
UPDATE outbox_events o SET tenant_id = b.tenant_id FROM businesses b
  WHERE o.business_id = b.id AND o.tenant_id IS NULL;
UPDATE outbox_events SET business_id = NULL WHERE business_id IS NOT NULL AND tenant_id IS NULL;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_business_implies_tenant
  CHECK (business_id IS NULL OR tenant_id IS NOT NULL);
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_business_implies_tenant
  CHECK (business_id IS NULL OR tenant_id IS NOT NULL);

-- §69 PERFORMANCE / QUERY REVIEW — obvious indexes for hot paths:
--   * worker claim: WHERE status IN ('pending','failed') AND next_attempt_at <= now()
--                   OR (status = 'processing' AND lease_until < now())
--   * invitation sweeps/lists: WHERE business_id = $1 AND status = 'pending' AND expires_at ...
--   * audit console/tenant views: ORDER BY created_at DESC, tenant lookups
CREATE INDEX credential_deliveries_due_idx
  ON credential_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX credential_deliveries_lease_idx
  ON credential_deliveries (lease_until)
  WHERE status = 'processing';
CREATE INDEX business_invitations_business_status_idx
  ON business_invitations (business_id, status, expires_at);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, created_at DESC);
