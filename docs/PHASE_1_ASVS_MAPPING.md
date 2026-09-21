# DAFTAR — Phase 1 OWASP ASVS 4.0 Mapping / مطابقة ASVS

> Level 2 target for a multi-tenant SaaS handling merchant identity and catalog data (no payment data in Phase 1). Each row names the control and the automated evidence. "N/A" means the feature does not exist in Phase 1 by roadmap.

| ASVS | Requirement (abridged) | Status | Evidence |
|---|---|---|---|
| V1.1 | Secure SDLC, threat model, security requirements | Met | `DAFTAR_THREAT_MODEL.md`, `DAFTAR_SECURITY_MODEL.md`, static guards, CI gates |
| V1.4 | Access control architecture: enforced server-side, single mechanism | Met | RLS + permission decorator + delegation ceiling; `isolation.test.ts` |
| V1.5 | Input/output architecture; strict schemas | Met | zod strict schemas; `catalog.test.ts` adversarial |
| V1.11 | Business logic: high-value flows are idempotent and thread-safe | Met | `onboarding.test.ts`, `concurrency-matrix.test.ts`, `quota-race.test.ts` |
| V2.1 | Password security (length, breach-resistant hashing) | Met | argon2id m=19456/t=3; policy in zod schema |
| V2.2 | Anti-automation: rate limiting, no lockout DoS | Met | `auth-abuse.test.ts` (per-IP, per-IP+account, soft delay) |
| V2.5 | Credential recovery: one-time, time-limited, no plaintext at rest | Met | `credential-payload.test.ts`, `delivery-outbox.test.ts` |
| V2.7 | Out-of-band tokens delivered via configured channel, single use | Met | invitations/password reset via worker; single-use tokens |
| V3.2 | Session generation, rotation on login, revocation | Met | `refresh-lineage.test.ts`, `auth.test.ts` (logout-all) |
| V3.3 | Session termination, reuse detection | Met | reuse revokes lineage before throw |
| V3.5 | Token-based session: signed, `kid`, rotation | Met | `jwt-keyring.test.ts` |
| V4.1 | General access control: deny by default, enforced at trusted layer | Met | RLS default-deny; `db-privileges.test.ts` |
| V4.2 | Operation-level access control; no IDOR; CSRF for cookies | Met | business-scoped RLS; cross-business FK tests; BFF cookies same-site |
| V4.3 | Admin interfaces protected, MFA | Partial | Separate `platform-api` runtime + platform roles + support sessions; MFA not in Phase 1 (`TECHNICAL_DEBT.md`) |
| V5.1 | Input validation: allow-lists, strict types | Met | zod strict; UUID/path validation; page-size cap |
| V5.2 | Sanitization; file upload validation | Met | `media.test.ts` (magic bytes, MIME agreement, re-encode, size) |
| V5.3 | Output encoding, SQL injection | Met | Parameterized `pg` queries only (no string SQL with user input); React escapes output |
| V6.2 | Algorithms: approved primitives, AEAD, key rotation | Met | AES-256-GCM with AAD; key ring; `credential-keyring.test.ts` |
| V6.4 | Secret management: no secrets in code, per-process secrets | Met | config rejects foreign secrets per mode; static guard 14 |
| V7.1 | Log content: no secrets, correlation id | Met | pino redaction; `requestId` everywhere |
| V7.2 | Log processing: security events logged | Met | audit events; limiter outage logged |
| V7.4 | Error handling: generic messages, no stack to client | Met | `error.filter.ts` stable codes |
| V8.1 | Data protection at rest; sensitive data minimization | Met | credential ciphertext wiped on terminal state; no PII in outbox payloads |
| V8.3 | Sensitive private data: access audited | Met | support-session access audit |
| V9.1 | TLS for client communications | Met (deployment) | `upgrade-insecure-requests` CSP in prod; `DAFTAR_AWS_REFERENCE_ARCHITECTURE.md` |
| V10.3 | Application integrity: dependencies, artifacts | Met | `npm audit --audit-level=high` in CI; frozen migrations manifest; signed release export |
| V11.1 | Business logic limits, anti-abuse | Met | plan limits under concurrency (`quota-race.test.ts`), invitation caps |
| V12.1 | File upload: size, type, storage outside web root | Met | 413 on oversize, 415 on type, private object storage |
| V12.4 | File storage: server-generated names, no path traversal | Met | `media.test.ts` malicious filename case |
| V13.1 | Generic web service security: consistent auth, errors | Met | global guards; error envelope |
| V13.2 | RESTful: methods, schema validation, idempotency | Met | Idempotency-Key required on onboarding/create-business |
| V14.2 | Dependency management | Met | lockfile reproducibility, audit gate, overrides documented |
| V14.4 | HTTP security headers | Met | CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy in both Next apps |
| V14.5 | Validate HTTP request header (proxy trust) | Met | `TRUST_PROXY` matrix in `auth-abuse.test.ts` |

## Items outside Phase 1 (by roadmap)

- V2.8 (MFA), V3.7 (re-authentication for sensitive ops) — Phase 8/9 hardening.
- V11.1.7 (financial transaction limits) — Phase 2 money core.
- V13.4 (GraphQL) — not used.
