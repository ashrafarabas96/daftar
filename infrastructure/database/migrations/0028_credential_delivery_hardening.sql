-- 0028_credential_delivery_hardening.sql — Execution Contract §XVII–XIX.
--
-- 1) §XVII: daftar_platform (super-admin) must NOT read encrypted credential
--    payloads. Platform admins get safe delivery METADATA only. Only
--    daftar_worker reads ciphertext columns.
--
-- 2) §XVIII: a safe view for delivery monitoring (masked recipient, no
--    ciphertext/nonce/key_version).
--
-- 3) §XIX: strict parent invariant — an invitation delivery's business_id
--    must be the invitation's business (composite FK); a password-reset
--    delivery never carries a business_id.

-- §XVII: revoke table-wide SELECT from platform; grant safe columns only.
REVOKE SELECT ON credential_deliveries FROM daftar_platform;
GRANT SELECT (id, kind, business_id, invitation_id, password_reset_token_id, email,
              status, attempts, next_attempt_at, last_error, locked_at, locked_by,
              lease_until, created_at, updated_at)
    ON credential_deliveries TO daftar_platform;

-- §XVIII: safe monitoring view — masked recipient, classified state only.
CREATE OR REPLACE VIEW credential_deliveries_safe AS
SELECT id,
       kind,
       business_id,
       status,
       attempts,
       next_attempt_at,
       last_error,
       created_at,
       updated_at,
       -- masked recipient: first char + *** + domain
       regexp_replace(email::text, '^(.).*(@.*)$', '\1***\2') AS recipient_masked
FROM credential_deliveries;
GRANT SELECT ON credential_deliveries_safe TO daftar_platform;

-- §XIXa: password-reset deliveries are identity-scoped — never business-bound.
ALTER TABLE credential_deliveries DROP CONSTRAINT IF EXISTS credential_deliveries_parent_chk;
ALTER TABLE credential_deliveries ADD CONSTRAINT credential_deliveries_parent_chk CHECK (
    (kind = 'invitation'
        AND invitation_id IS NOT NULL
        AND password_reset_token_id IS NULL
        AND business_id IS NOT NULL)
    OR
    (kind = 'password_reset'
        AND password_reset_token_id IS NOT NULL
        AND invitation_id IS NULL
        AND business_id IS NULL)
);

-- §XIXb: the delivery's business must BE the invitation's business.
CREATE UNIQUE INDEX business_invitations_id_business_uq
    ON business_invitations (id, business_id);
ALTER TABLE credential_deliveries
    ADD CONSTRAINT credential_deliveries_invitation_business_fk
    FOREIGN KEY (invitation_id, business_id)
    REFERENCES business_invitations (id, business_id) ON DELETE CASCADE;
