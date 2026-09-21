# PHASE 1 — Migration History Decision

**Decision date:** 2026-09-20
**Authority:** DAFTAR — PHASE 1 ABSOLUTE CLOSURE & RELEASE CANDIDATE EXECUTION CONTRACT (§III–VII, BLOCKER 1)

## Facts (verified, not guessed)

1. The migration runner (`apps/api/src/infra/migrate.ts`) stores a SHA-256
   checksum per applied migration in `schema_migrations` and refuses to run
   against a database whose applied files were modified ("tamper" error).
2. During development, `0025_credential_payload_protection.sql` and
   `0026_versioned_trial_override_shape_ownership.sql` were corrected in place
   (legacy-delivery upgrade safety; managed-PostgreSQL-safe trigger handling).
   The corrections changed their bytes relative to earlier development
   iterations.
3. Every database those earlier bytes were ever applied to is a **disposable
   development/test database** (embedded-postgres instances under
   `/tmp/daftar-pg-shared`, per-run CI/ephemeral schemas). DAFTAR has **never
   been deployed to any persistent or production environment**; no customer,
   staging, or shared database exists. There is no non-disposable database
   anywhere containing the old hashes.

## Decision: PATH A — NOT RELEASED / ONLY DISPOSABLE DATABASES

- Phase 1 migrations are **pre-release**.
- All disposable databases were reset (DROP/CREATE) and re-migrated from 0000.
- The **current corrected bytes** of migrations `0000`–`0027` are **FROZEN**
  as of this decision.
- `infrastructure/database/MIGRATION_MANIFEST.json` records filename + SHA-256
  for every frozen migration. A repository guard
  (`scripts/check-migration-manifest.ts`) fails CI if any frozen file changes.
- **From this point forward, 0000–0027 are never modified again.** All future
  schema changes — including any correction to behavior introduced by
  0000–0027 — are new migrations `0028+`.

## Compatibility commitments (§V)

The supported upgrade matrix is enforced by
`tests/integration/migration-upgrade.test.ts`:

| Path                                      | Covered |
|-------------------------------------------|---------|
| Fresh database 0000 → latest              | yes (every test run; global setup migrates from empty) |
| Database at 0024 (pre-encryption, with legacy plaintext pending/failed/sent deliveries, plan versions, tenants/businesses) → latest | yes (dedicated fixture test) |
| Database at 0026 → latest                 | yes (checkpoint upgrade test) |
| Latest → migration command is a no-op     | yes (idempotency test) |
| Legitimate supported upgrade NEVER hits a checksum mismatch | yes (checksums only trip on tampering with applied files) |

Because PATH A holds, no database exists at the *old* 0025/0026 bytes; those
interim states are not supported upgrade sources (they only ever existed in
disposable databases, which were reset).

## Managed PostgreSQL rule (§VII)

- Migrations never use `session_replication_role = replica` (superuser-only).
- The single controlled exception strategy is a **narrow, named** trigger
  toggle (`ALTER TABLE … DISABLE/ENABLE TRIGGER plan_versions_lifecycle_trg`)
  around the 0026 trial_days backfill — permitted for the table-owner
  migration role on managed PostgreSQL without SUPERUSER.
- No broad trigger disabling anywhere else.
