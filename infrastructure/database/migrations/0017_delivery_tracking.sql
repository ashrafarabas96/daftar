-- 0017 — INVITATION & CREDENTIAL DELIVERY TRACKING (Final Closure Mission
-- WAVE 4). A committed invitation/reset token whose delivery failed must never
-- be invisible: track delivery state, attempts, and the last SAFE error
-- (never the token, never secrets) on the row itself. Delivery happens AFTER
-- commit; the result is recorded in a follow-up update.

ALTER TABLE business_invitations
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','sent','failed')),
  ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN last_delivery_error TEXT;

ALTER TABLE password_reset_tokens
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','sent','failed')),
  ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN last_delivery_error TEXT;
