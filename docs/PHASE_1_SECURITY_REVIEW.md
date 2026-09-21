# DAFTAR — Phase 1 Security Review (Review B) / المراجعة الأمنية

> Independent review lens: security, architecture, rollback. Verdict at the end. Every claim points at a test that fails if the property is lost.

## 1. Trust boundaries

| Boundary | Enforcement | Guard |
|---|---|---|
| Tenant / business isolation | PostgreSQL RLS (33 policies) keyed on transaction-local `set_config`; default-deny with no context; pooled-connection reset proven | `tests/security/isolation.test.ts`, `db-privileges.test.ts` |
| Process isolation | Three runtime modules; pools opened only for the mode; secrets of other processes are REJECTED by config (`must NOT be set in PROCESS_MODE=…`) | `runtime-isolation.test.ts`, `production-providers.test.ts` |
| Database principals | 6 roles; `daftar_app` has no DDL, no identity tables, no platform tables; `app_bypass()` names only `daftar_platform`; provisioner holds EXECUTE only on 6 commands | `provisioner-boundary.test.ts`, `db-privileges.test.ts`, `owner-authority.test.ts` |
| Cross-scope provisioning | SECURITY DEFINER commands owned by `daftar_platform`; actor from `app.actor_user_id` GUC; authorization asserted inside the same statement as the mutation | `provisioner-boundary.test.ts` "direct EXECUTE attacks" |
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
- Migrations frozen with SHA-256 manifest; tampering fails `check:migrations` and `verify:history` (CI tamper proof).
- Release export is allowlist-based, scans for forbidden files and raw credential material, writes `DELIVERY_MANIFEST.json` with tree hash and a sibling `.sha256` (`scripts/export-release.ts`, golden 05).
- Static guards (14 rules) stop: `@ts-ignore`, float money, `session_replication_role`, runtime code reading `MIGRATION_DATABASE_URL`, admin module imports in merchant runtime, credentials in migrations, etc.

## 6. Observability (§68)

- Structured JSON logs (pino) with path-based redaction of tokens/passwords/secrets; request id from `AsyncLocalStorage` on every log line and error body.
- `/v1/health/live` and `/v1/health/ready`: readiness checks the adapters THIS mode serves and, in production, refuses to be ready with non-production adapter kinds.
- Worker: drain failures counted and logged with worker id; deliveries have `status/attempts/last_error/next_attempt_at/lease_until`; outbox dead-letters after `MAX_ATTEMPTS`; nothing is retried silently.
- Every security-relevant action (role change, scope change, invitation, support access, plan publish, override, bootstrap) writes an audit event with actor and metadata.

## 7. Rollback

- Every migration runs in its own transaction; a mid-file failure leaves no partial DDL and no history row (`failure-injection.test.ts`).
- Upgrade matrix: 0024 / 0026 / 0035 checkpoints → latest, latest → no-op. Backward data compatibility: no destructive column drop without a validated copy (`0036`).
- Application rollback: previous image + same database is safe for `0033`–`0037` except `0036` (JSONB columns removed): rollback across `0036` requires restoring the pre-`0036` snapshot, documented in `PHASE_1_MIGRATION_HISTORY_DECISION.md`.

## 8. Residual risks (accepted, documented)

| Risk | Why accepted | Mitigation in place |
|---|---|---|
| vitest mocker path traversal (moderate) | Dev/test only, never in a runtime image | Tracked; fix lands with the vitest major upgrade |
| Admin console English-only | Platform staff tool, not merchant-facing | Documented decision (`PHASE_1_DESIGN_REVIEW.md`) |
| At-least-once credential delivery | By design (lease reclaim) | Tokens single-use; duplicate email harmless |

**Verdict (Review B): PASS** — no open P0/P1, no open security P2.
