-- Scratch fixture (p14_owner). NOT a migration; no number, no frozen file.
CREATE SCHEMA p14s;
GRANT USAGE ON SCHEMA p14s TO p14_merchant, p14_resolver, p14_worker;

CREATE TABLE p14s.businesses (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL
);

-- api_keys analogue: no status column; usability derives from revoked_at/expires_at
CREATE TABLE p14s.api_keys (
  key_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  business_id     UUID NOT NULL,
  subject_user_id UUID NOT NULL,
  secret_sha256   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoke_scheduled BOOLEAN NOT NULL DEFAULT false,
  name            TEXT NOT NULL,
  replaces_api_key_id UUID,
  PRIMARY KEY (business_id, id),
  UNIQUE (key_id)
);

INSERT INTO p14s.businesses (id, tenant_id) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO p14s.api_keys (key_id,id,tenant_id,business_id,subject_user_id,secret_sha256,expires_at,revoked_at,name) VALUES
 ('0a000000-0000-0000-0000-000000000001'::uuid,'0b000000-0000-0000-0000-000000000001'::uuid,
  'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-000000000001'::uuid, repeat('a',64), NULL, NULL, 'live-never-expires'),
 ('0a000000-0000-0000-0000-000000000002'::uuid,'0b000000-0000-0000-0000-000000000002'::uuid,
  'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-000000000001'::uuid, repeat('b',64),
  now() - interval '365 days', NULL, 'expired-never-revoked'),
 ('0a000000-0000-0000-0000-000000000003'::uuid,'0b000000-0000-0000-0000-000000000003'::uuid,
  'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-000000000001'::uuid, repeat('c',64),
  now() + interval '30 days', now() - interval '1 day', 'revoked-not-expired');
