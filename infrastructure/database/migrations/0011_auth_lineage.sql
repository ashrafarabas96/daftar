-- 0011 — Refresh token LINEAGE (§16–18). Every refresh token ever issued is a
-- row with an explicit state machine: issued → consumed (rotated) | revoked |
-- expired. replaced_by links the rotation chain. Single-use is enforced by
-- row lock + state transition; reuse of any non-issued token is detectable
-- forever (not just the current+previous window).
-- Platform/identity boundary: app role gets NO access.

CREATE TABLE session_refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  state       TEXT NOT NULL CHECK (state IN ('issued','consumed','replaced','revoked','expired')),
  replaced_by UUID REFERENCES session_refresh_tokens(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX srt_session_idx ON session_refresh_tokens (session_id);
CREATE INDEX srt_state_idx ON session_refresh_tokens (state) WHERE state = 'issued';

ALTER TABLE session_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY srt_platform_only ON session_refresh_tokens
  USING (app_bypass()) WITH CHECK (app_bypass());

GRANT SELECT, INSERT, UPDATE ON session_refresh_tokens TO daftar_platform;

-- Backfill: live sessions get a lineage row for their current token.
INSERT INTO session_refresh_tokens (session_id, token_hash, state)
  SELECT id, refresh_token_hash, 'issued' FROM sessions WHERE status = 'active';
