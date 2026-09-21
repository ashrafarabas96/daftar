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
| Database at 0035 (JSONB catalog translations, cross-table SKUs) → latest | yes (checkpoint upgrade test: content preserved, identifier registry built, rerun no-op) |
| A migration that fails mid-file            | rolled back atomically, no history row, rerun clean (`failure-injection.test.ts`) |
| Migration under a runtime principal        | refused with permission denied, nothing applied (`failure-injection.test.ts`) |
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

## Final Release Blocker Patch: 0038–0039 appended to the frozen set

- `0038_provisioning_assertions.sql` — provisioning assertions (Blocker 1). Deploy order: apply 0038, install the assertion key with `npm run bootstrap:provisioning-key` under the platform principal, deploy the merchant API carrying `PROVISIONING_ASSERTION_KEY`. Rolling the API back across 0038 without rolling the migration back makes provisioning fail closed (every command raises `PROV:FORBIDDEN`); nothing is corrupted, but onboarding and invitation acceptance stop until the API is rolled forward.
- `0039_catalog_identifiers_owner_integrity.sql` — FK-backed owner columns, DML revoked from runtime roles, SECURITY DEFINER sync routine (Blocker 2). Backward compatible with the pre-0039 API (the trigger writes the new columns itself).
- `frozenThrough` is now `0039_catalog_identifiers_owner_integrity.sql`; the gate's DB-from-zero step refuses any migration newer than `frozenThrough`.

## Phase 1 release freeze (§51–54): 0028–0037 appended to the frozen set

At the Phase 1 release the manifest was extended from `0027` to
`0037_catalog_identifiers.sql`. `frozenThrough` in
`infrastructure/database/MIGRATION_MANIFEST.json` names the last frozen file
and the guard derives its policy message from it, so the next freeze only
appends entries.

Rules that held while 0028–0037 were written:

- `0000`–`0027` were not touched (the guard ran on every commit).
- Every schema correction introduced by the Phase 1 closure is a NEW migration:
  `0033` (provisioner atomic authority), `0034` (platform console grants),
  `0035` (ownership implication + indexes), `0036` (normalized catalog
  translations), `0037` (catalog identifier registry).
- The second and last narrow trigger toggle is in `0035`:
  `ALTER TABLE audit_events DISABLE/ENABLE TRIGGER audit_no_update` around the
  tenant backfill of historical platform-console audit rows. It is scoped to
  one named trigger on one table, inside the migration transaction, and the
  append-only trigger is re-enabled before the migration commits.
- `0036` drops the JSONB translation columns only after a validation block
  proves every row was copied into `product_translations` /
  `category_translations`; the 0035-checkpoint upgrade test replays this on
  real data.
