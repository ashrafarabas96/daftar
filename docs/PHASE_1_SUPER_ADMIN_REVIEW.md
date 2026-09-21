# DAFTAR — Phase 1 Super Admin Review / مراجعة لوحة المنصة

## 1. Runtime

- The platform console talks only to the `platform-api` runtime (`PlatformApiModule`): merchant mutation surface absent, worker absent, business context refused (`runtime-isolation.test.ts`).
- Principal `daftar_platform` owns the SECURITY DEFINER provisioning commands and is the only role named by `app_bypass()`; even it cannot remove the last active tenant owner (`owner-authority.test.ts`).
- Production requires `CREDENTIAL_KMS_ENDPOINT` for password-reset enqueue and `REDIS_URL` for the limiter; no decrypt key ring exists in this process.

## 2. Capabilities (11 admin pages, 24 audited client calls in golden 07)

| Area | Endpoints | Notes |
|---|---|---|
| Tenants / businesses | list, detail (members, subscription, usage) | Read-only in Phase 1 |
| Plans | list plans, create plan (empty DRAFT v1), create version, edit DRAFT (full replace), publish, clone, diff, sunset | Versions immutable after publish (`plan-lifecycle.test.ts`) |
| Overrides | list, create (feature XOR limit, windowed), revoke | Non-overlapping windows enforced at DB |
| Feature flags | list, toggle | Only platform role can write (`db-privileges.test.ts`) |
| Support sessions | create (tenant, reason, expiry), revoke, list; tenant reads allowed only while active | Concurrent revoke safe; access denied after revoke (`support-sessions.test.ts`) |
| Users | list, capabilities per user, platform role grant (`POST /v1/admin/platform-roles`) | Audited; revoke is a Phase 8 item |
| Audit | list events with filters | Append-only table |
| Operations | liveness/readiness view of the platform runtime | Dead-letter views live in the DB (`credential_deliveries`, `outbox_events` status columns); a console page for them is a Phase 8 item |

## 3. Bootstrap of the first owner (§44–46)

- CLI `npm run bootstrap:platform-owner -- --email=… --confirm=BOOTSTRAP [--promote-existing]` under `BOOTSTRAP_DATABASE_URL` (must connect as `daftar_platform`; migration credentials are refused).
- Advisory lock: two simultaneous bootstraps → exactly one owner, one audit event (`bootstrap-owner.test.ts`).
- Existing identity is never overwritten: without `--promote-existing` the CLI refuses; with it, the platform role is granted and the password is untouched. The one-time password is printed exactly once for a NEW identity and never stored in plaintext.

## 4. Findings

- Closure fix: platform-console audit rows had no tenant; `0035` backfills and adds the `business_id IS NULL OR tenant_id IS NOT NULL` CHECK; `AuditService` resolves the tenant from the business for every audit/outbox write.
- Admin pages previously read raw proxy shapes; now every page is built on `@daftar/shared-contracts` DTOs and golden 07 fails on any snake_case or local DTO drift.

**Verdict: PASS.**
