-- 0025_credential_payload_protection.sql — Gate A §3–19.
--
-- 1) NEVER store recoverable credential material as plaintext rows.
--    credential_deliveries.secret (raw token) is replaced by an
--    application-level envelope-encrypted payload (AES-256-GCM):
--      secret_ciphertext / secret_nonce / key_version
--    The encryption key NEVER lives in the database.
--
-- 2) Read privileges: daftar_app / daftar_identity ENQUEUE only — they lose
--    table-wide SELECT and receive a column-scoped SELECT that EXCLUDES the
--    ciphertext payload. Only daftar_worker (delivery) and daftar_platform
--    (bypass administration, UI never displays payloads) can read it.
--
-- 3) Retention: payloads are wiped on terminal states (sent/dead). The CHECK
--    requires a payload for every non-terminal row.
--
-- 4) Worker lease: claim stamps locked_at/locked_by/lease_until; a
--    'processing' row whose lease expired is reclaimable (worker crash
--    recovery, at-least-once semantics).

ALTER TABLE credential_deliveries
    ADD COLUMN secret_ciphertext TEXT,
    ADD COLUMN secret_nonce TEXT,
    ADD COLUMN key_version TEXT,
    ADD COLUMN locked_at TIMESTAMPTZ,
    ADD COLUMN locked_by TEXT,
    ADD COLUMN lease_until TIMESTAMPTZ;

-- Upgrade path (applied history exists): plaintext secrets can not be
-- re-encrypted inside SQL (the key is application-side). Any undelivered
-- plaintext payload is wiped and the row is parked as 'reissue_required' —
-- a TERMINAL-EQUIVALENT state the worker never claims; the standard resend
-- flow enqueues a fresh encrypted delivery. Terminal rows are wiped too.
-- (Using 'failed' here would violate the payload CHECK below and break the
-- upgrade on any database holding pending deliveries.)
ALTER TABLE credential_deliveries DROP CONSTRAINT credential_deliveries_status_check;
ALTER TABLE credential_deliveries ADD CONSTRAINT credential_deliveries_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead', 'reissue_required'));

-- Drop the plaintext FIRST (it is NOT NULL; wiping it via UPDATE would
-- violate its own constraint) — dropping destroys every legacy secret.
ALTER TABLE credential_deliveries DROP COLUMN secret;

UPDATE credential_deliveries
SET status = CASE WHEN status IN ('sent', 'dead') THEN status ELSE 'reissue_required' END,
    last_error = CASE WHEN status IN ('sent', 'dead') THEN last_error
                      ELSE 'credential payload migrated: reissue required' END,
    updated_at = now();

ALTER TABLE credential_deliveries
    ADD CONSTRAINT credential_deliveries_payload_required CHECK (
        status IN ('sent', 'dead', 'reissue_required')
        OR (secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND key_version IS NOT NULL)
    );

-- §8: enqueue-only for app/identity — payload columns are unreadable.
REVOKE SELECT ON credential_deliveries FROM daftar_app, daftar_identity;
GRANT SELECT (id, kind, business_id, invitation_id, password_reset_token_id, email,
              status, attempts, next_attempt_at, last_error, locked_at, locked_by,
              lease_until, created_at, updated_at)
    ON credential_deliveries TO daftar_app, daftar_identity;
