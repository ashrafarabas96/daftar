-- owner: reproduce the daftar RLS idiom on a scratch relation
CREATE OR REPLACE FUNCTION p14s.app_business() RETURNS TEXT LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.business_id', true) $$;
CREATE OR REPLACE FUNCTION p14s.app_tenant() RETURNS TEXT LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.tenant_id', true) $$;
CREATE OR REPLACE FUNCTION p14s.app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.bypass_rls', true),'') = 'on' $$;

CREATE TABLE p14s.webhook_deliveries (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  tenant_id   UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  payload JSONB,
  PRIMARY KEY (business_id, id)
);
ALTER TABLE p14s.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON p14s.webhook_deliveries AS PERMISSIVE FOR ALL
  USING      (EXISTS (SELECT 1 FROM p14s.businesses b
                       WHERE b.id = webhook_deliveries.business_id
                         AND b.tenant_id::text = p14s.app_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM p14s.businesses b
                       WHERE b.id = webhook_deliveries.business_id
                         AND b.tenant_id::text = p14s.app_tenant()));

CREATE POLICY business_isolation ON p14s.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING      (p14s.app_bypass() OR business_id::text = p14s.app_business())
  WITH CHECK (p14s.app_bypass() OR business_id::text = p14s.app_business());

GRANT SELECT, INSERT, UPDATE ON p14s.webhook_deliveries TO p14_worker, p14_merchant;
GRANT SELECT ON p14s.businesses TO p14_worker, p14_merchant;   -- 0020:54-58 requirement

INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, payload) VALUES
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
  '0d000000-0000-0000-0000-000000000001','{"b":1}'),
 ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001',
  '0d000000-0000-0000-0000-000000000002','{"b":2}');

ALTER TABLE p14s.webhook_deliveries FORCE ROW LEVEL SECURITY;

-- the construction under test: a PERMISSIVE policy admitting the context-free worker
CREATE POLICY worker_delivery ON p14s.webhook_deliveries AS PERMISSIVE FOR ALL
  USING (current_user = 'p14_worker') WITH CHECK (current_user = 'p14_worker');

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename='webhook_deliveries' AND policyname='worker_delivery' AND permissive='PERMISSIVE';
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: worker_delivery permissive policy absent'; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename='webhook_deliveries' AND policyname='business_isolation' AND permissive='RESTRICTIVE';
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: business_isolation not RESTRICTIVE'; END IF;
  RAISE NOTICE 'LANDED: PERMISSIVE worker_delivery exists AND business_isolation is RESTRICTIVE';
END $$;
