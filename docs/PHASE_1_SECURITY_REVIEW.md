# DAFTAR — Phase 1 Security Review (Review B) / المراجعة الأمنية

> Independent review lens: security, architecture, rollback. Verdict at the end. Every claim points at a test that fails if the property is lost.

## 1. Trust boundaries

| Boundary | Enforcement | Guard |
|---|---|---|
| Tenant / business isolation | PostgreSQL RLS (33 policies) keyed on transaction-local `set_config`; default-deny with no context; pooled-connection reset proven | `tests/security/isolation.test.ts`, `db-privileges.test.ts` |
| Process isolation | Three runtime modules; pools opened only for the mode; secrets of other processes are REJECTED by config (`must NOT be set in PROCESS_MODE=…`) | `runtime-isolation.test.ts`, `production-providers.test.ts` |
| Database principals | 6 roles; `daftar_app` has no DDL, no identity tables, no platform tables; `app_bypass()` names only `daftar_platform`; provisioner holds EXECUTE only on 6 commands | `provisioner-boundary.test.ts`, `db-privileges.test.ts`, `owner-authority.test.ts` |
| Cross-scope provisioning | SECURITY DEFINER commands owned by `daftar_platform`; actor from a server-minted HMAC **provisioning assertion** verified in `provision_actor()` against a key no runtime role can read (`0038`); authorization asserted inside the same statement as the mutation | `provisioner-boundary.test.ts` "direct EXECUTE attacks (Blocker 1)" |
| Platform console | Separate `platform-api` runtime; support sessions scoped to one tenant with expiry and revoke; every support access audited | `support-sessions.test.ts`, `admin.test.ts` |

## 2. Identity and session

- Passwords: argon2id (m=19456 KiB, t=3, p=1). Refresh tokens: single-use, lineage-tracked, reuse revokes the whole lineage BEFORE the error is thrown (`refresh-lineage.test.ts`).
- JWT key ring with `kid`; rotation keeps previous key verifiable; unknown or retired kid rejected (`jwt-keyring.test.ts`).
- Layered rate limiting (per IP, per IP+account, per email for reset) with a SOFT account-wide delay, never a lockout DoS; trusted-proxy walk with CIDR/IPv6 (`auth-abuse.test.ts`, 22 cases). Limiter backend outage → **503 + Retry-After** (fail closed), never fail open.
- Credential delivery: token payload encrypted at rest (AES-GCM, key ring, AAD binds kind/email/parent/delivery id); ciphertext unreadable by app/identity/platform roles; wiped on terminal state (`credential-payload.test.ts`, `credential-keyring.test.ts`). In production the HTTP runtimes hold NO decrypt key (KMS-style encrypt endpoint only); the DEV key fallback throws under `NODE_ENV=production`.

## 3. Authorization

- 38 permissions; owner is a system role that can never be granted through `setMemberRoles`; system roles immutable at API and DB trigger level.
- Delegation ceiling: nobody can create, assign or invite with authority beyond their own (`delegation-ceiling.test.ts`, `role-crud.test.ts`).
- Last-owner protection under concurrency (advisory lock + row locks; `owner-authority.test.ts`, `isolation.test.ts`).
- Branch scope (`all` / `assigned` + explicit set) enforced on every branch/warehouse read and write (`branch-scopes.test.ts`).
- Membership lifecycle: removed members lose effective roles immediately and never resurrect privileges (`membership-lifecycle.test.ts`, `concurrency-matrix.test.ts`).

## 4. Input, output and data

- Every body validated by zod schemas (strict: unknown fields → 400); path UUIDs validated; page size capped (`catalog.test.ts` adversarial group).
- Money as string minor units end-to-end; `bigint` in the API; `BigDecimal` on Android; formatting through one registry (static guard 6b).
- Media: magic-byte sniff + declared MIME agreement, re-encode, metadata strip, server-generated keys, private bucket + signed URLs, compensation on partial failure with an orphan record when compensation itself fails (`media*.test.ts`).
- Error envelope: stable `code` + `requestId` in every error; no stack traces to clients; provider errors classified before persistence (`DELIVERY_FAILED`, never raw SMTP text).
- Audit: append-only (`audit_no_update` trigger), business ⇒ tenant CHECK (`0035`), outbox rows committed with the business change (`outbox.test.ts`).

## 5. Supply chain and artifacts

- `npm audit --audit-level=high`: 0 high/critical after the dependency audit (`da2f995`). Remaining: 2 moderate in `@vitest/mocker` (dev-only; tracked in `TECHNICAL_DEBT.md`).
- Migrations frozen with SHA-256 manifest (0000–0039); tampering fails `check:migrations` and `verify:history` (CI tamper proof and the gate's DB-from-zero step).
- Release export ships every git-tracked file, audits that every reproduction input is tracked, scans for forbidden files and raw credential material, writes `DELIVERY_MANIFEST.json` with tree hash, source commit and migration hashes, and a sibling `.sha256` (`scripts/export-release.ts`, golden 05).
- Static guards (14 rules) stop: `@ts-ignore`, float money, `session_replication_role`, runtime code reading `MIGRATION_DATABASE_URL`, admin module imports in merchant runtime, credentials in migrations, etc.

## 6. Observability (§68)

- Structured JSON logs (pino) with path-based redaction of tokens/passwords/secrets; request id from `AsyncLocalStorage` on every log line and error body.
- `/v1/health/live` and `/v1/health/ready`: readiness checks the adapters THIS mode serves and, in production, refuses to be ready with non-production adapter kinds.
- Worker: drain failures counted and logged with worker id; deliveries have `status/attempts/last_error/next_attempt_at/lease_until`; outbox dead-letters after `MAX_ATTEMPTS`; nothing is retried silently.
- Every security-relevant action (role change, scope change, invitation, support access, plan publish, override, bootstrap) writes an audit event with actor and metadata.

## 7. Rollback

- Every migration runs in its own transaction; a mid-file failure leaves no partial DDL and no history row (`failure-injection.test.ts`).
- Upgrade matrix: 0024 / 0026 / 0035 checkpoints → latest, latest → no-op. Backward data compatibility: no destructive column drop without a validated copy (`0036`).
- Application rollback: previous image + same database is safe for `0033`–`0039` except `0036` (JSONB columns removed) and `0038` (the provisioning commands now require an assertion the pre-0038 API does not mint, so onboarding/acceptance would fail closed until the API is rolled forward again): both boundaries are documented in `PHASE_1_MIGRATION_HISTORY_DECISION.md`.

## 8. Residual risks (accepted, documented)

| Risk | Why accepted | Mitigation in place |
|---|---|---|
| vitest mocker path traversal (moderate) | Dev/test only, never in a runtime image | Tracked; fix lands with the vitest major upgrade |
| Admin console English-only | Platform staff tool, not merchant-facing | Documented decision (`PHASE_1_DESIGN_REVIEW.md`) |
| At-least-once credential delivery | By design (lease reclaim) | Tokens single-use; duplicate email harmless |

**Verdict (Review B): PASS** — no open P0/P1, no open security P2.

## 9. Final Release Blocker Patch — what changed and how it is proven

| Blocker | Before | After | Guard |
|---|---|---|---|
| 1 — provisioner actor spoofing | `provision_actor()` read the GUC `app.actor_user_id`; a `daftar_provisioner` connection could `set_config` any user id and EXECUTE `provision_create_business` against a victim tenant | Migration `0038`: the actor is a **provisioning assertion** `v1.<kid>.<actor>.<kind>.<exp>.<jti>.<hmac-sha256>` minted by the merchant API with `PROVISIONING_ASSERTION_KEY` and verified inside `provision_actor(kinds)` with the same key stored in `provisioning_assertion_keys` — a table with **no grants to any runtime role**. Bound to one operation kind, 60 s TTL, single-use per transaction (`provisioning_assertion_uses`). The 0033 authority checks (tenant owner, invitation addressee, actor-scoped idempotency) stay inside the same SECURITY DEFINER commands. Keys are installed by the platform principal (`npm run bootstrap:provisioning-key`), never by migrations | `tests/security/provisioner-boundary.test.ts` "direct EXECUTE attacks (Blocker 1)": GUC spoofing, forged key, tampered claims, expired, wrong kind, replay, non-owner with valid assertion, foreign invitation, key table unreachable from all six roles; positive paths in `onboarding`, `invitation-lifecycle`, `concurrency-matrix` |
| 2 — identifier owner integrity | Registry rows carried `(owner_type, owner_id)` with no referential proof; `daftar_app` held INSERT/UPDATE/DELETE | Migration `0039`: `product_id` / `variant_id` composite FKs (`ON DELETE CASCADE`) + XOR CHECK; DML revoked from `daftar_app` and `daftar_platform`; the sync trigger is a SECURITY DEFINER routine owned by the schema owner and driven only by product/variant mutations | `tests/security/catalog-identifiers.test.ts` "owner integrity": fake product/variant owner, cross-business owner, XOR shapes, direct DML as `daftar_app`, full lifecycle incl. cascade, sync routine not callable |
| 3 — self-contained release archive | Allowlist export omitted build configs and bootstrap material | Export inventory = every git-tracked file, with an audit of every input the scripts, CI and workspace builds reference (fails if untracked); the gate runs without `.git` and checks the same required inputs; acceptance was executed from the extracted archive with fresh `node_modules` and a fresh PostgreSQL | `scripts/export-release.ts`, gate step "self-contained source tree", `PHASE_1_ACCEPTANCE_REPORT.md` §archive run |
| 4 — KMS transport | Unauthenticated HTTP endpoint, no timeout, unbounded body | Production config requires `https://` and `CREDENTIAL_KMS_TOKEN` (≥32 chars); client enforces bearer auth, `CREDENTIAL_KMS_TIMEOUT_MS` with abort, 64 KiB response cap, schema-validated response, no redirects, one retry only on transport/502–504, classified errors that never carry plaintext or response bodies; the enqueue transaction rolls back on failure (no invitation, no reset token, no delivery row) | `tests/integration/kms-encryptor.test.ts` (config rejections, timeout, unreachable, 503/400, malformed, oversized, redirect, fail-closed enqueue) |
| 5 — skippable gate | `RELEASE_GATE_SKIP_ANDROID=1` yielded PASS with a SKIPPED row | Any `RELEASE_GATE_SKIP_*` fails the release gate before the first step; only `gate:phase1:dev` may skip and it can never print a release verdict | `tests/integration/release-gate.test.ts` runs the gate itself |
| 6 — Android networking | Debug base URL `http://10.0.2.2:3000` while cleartext was denied globally | `src/debug/res/xml/network_security_config.xml` permits cleartext for `10.0.2.2` only; release keeps `src/main` (cleartext denied everywhere, https base URL) | `NetworkSecurityConfigTest.kt` parses both configs and the build script |
| 7 — raw evidence | Evidence held step results only | `release/evidence.json` v2 records toolchain, OS, source identity (commit or archive tree hash), migration count/latest/manifest hash, DB-from-zero results, parsed test counts, Android lint/test/APK facts, build and scan results, every command with exit code | gate step data; archive run passes `--archive-sha256` |

Residual: an assertion key that leaks together with the provisioner credential equals the merchant API's own authority (the inherent floor); rotation is `bootstrap:provisioning-key --retire=<old kid>` after deploying the new key.
