-- 0015 — SEPARATE IDENTITY DB PRINCIPAL (Final Closure Mission WAVE 2).
-- Auth runtime (login/register/refresh/reset) runs as daftar_identity — a REAL
-- database principal distinct from daftar_platform (platform administration).
-- Credentials differ (IDENTITY_DATABASE_URL ≠ PLATFORM_DATABASE_URL ≠
-- APP_DATABASE_URL). Identity gets identity tables ONLY: no plans, no feature
-- flags, no overrides, no catalog, no businesses, no platform roles.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','password_reset_tokens','session_refresh_tokens'] LOOP
    EXECUTE format('CREATE POLICY identity_access ON %I
      USING (current_user = ''daftar_identity'')
      WITH CHECK (current_user = ''daftar_identity'')', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON users, sessions, password_reset_tokens, session_refresh_tokens TO daftar_identity;

-- Auth actions are audited: identity may append audit events (insert-only).
CREATE POLICY audit_identity_insert ON audit_events
  FOR INSERT TO daftar_identity WITH CHECK (true);
GRANT INSERT ON audit_events TO daftar_identity;
