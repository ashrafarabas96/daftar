# DAFTAR — AWS Reference Architecture / المعمارية المرجعية على AWS

> Reference deployment for the Phase 1 runtimes. Nothing here is required to run the code locally (`PROCESS_MODE=all` in development); in production the config refuses to start without the real adapters listed below.

## 1. Topology

```
Route 53 → CloudFront (web, admin, storefront later) → ALB
   ALB /api/*      → ECS Fargate service: merchant-api   (PROCESS_MODE=merchant-api)
   ALB /admin-api/*→ ECS Fargate service: platform-api   (PROCESS_MODE=platform-api, internal ALB + SSO/VPN)
   (no ingress)    → ECS Fargate service: worker         (PROCESS_MODE=worker)
   Next.js web / admin → ECS Fargate (SSR + BFF proxy) or Amplify Hosting
RDS PostgreSQL 16+ (Multi-AZ) · ElastiCache Redis (limiter) · S3 private bucket (media) · SES SMTP (credential delivery) · KMS bridge: a private HTTPS endpoint (Lambda behind API Gateway with an IAM-scoped role that holds kms:Encrypt only) authenticated with `CREDENTIAL_KMS_TOKEN` from Secrets Manager; the worker's key ring is the decrypt side
```

## 2. Process → secrets matrix (mirrors `loadConfig` validation)

| Process | DB principals | Other secrets | Must NOT have |
|---|---|---|---|
| merchant-api | `APP_DATABASE_URL`, `IDENTITY_DATABASE_URL`, `RESOLVER_DATABASE_URL`, `PROVISIONER_DATABASE_URL` | `JWT_SECRET`/`JWT_KEYS`, `REDIS_URL`, S3 credentials, `CREDENTIAL_KMS_ENDPOINT` (https) + `CREDENTIAL_KMS_TOKEN`, `PROVISIONING_ASSERTION_KEY` | platform pool, worker pool, `CREDENTIAL_PAYLOAD_KEY`, `SMTP_URL` |
| platform-api | `PLATFORM_DATABASE_URL`, `IDENTITY_DATABASE_URL`, `RESOLVER_DATABASE_URL` | `JWT_*`, `REDIS_URL`, `CREDENTIAL_KMS_ENDPOINT` (https) + `CREDENTIAL_KMS_TOKEN` | worker/provisioner pools, payload key, SMTP, `PROVISIONING_ASSERTION_KEY` |
| worker | `WORKER_DATABASE_URL` | `CREDENTIAL_PAYLOAD_KEY` (ring), `SMTP_URL`, `SMTP_FROM` | any HTTP secret, app/platform pools, JWT |
| migrate job | `MIGRATION_DATABASE_URL` (table owner) | — | runtime secrets |
| bootstrap job | `BOOTSTRAP_DATABASE_URL` (= platform principal) | `PROVISIONING_ASSERTION_KEY` for `npm run bootstrap:provisioning-key` (installs/rotates the key the database verifies assertions with) | migration credentials (refused by the CLI) |

Secrets live in AWS Secrets Manager; each ECS task definition injects only its row. Static guard 13/14 and `production-providers.test.ts` keep the code honest.

## 3. Database

- One RDS instance, one database, six roles created by `infrastructure/database/bootstrap.sql` (run once by the DBA job with generated passwords).
- Migrations run as a one-off ECS task (`npm run migrate -w @daftar/api`) before the new task set is rolled; the advisory lock makes a double run safe; `npm run verify:history` asserts hashes against the frozen manifest.
- RLS is the isolation mechanism; connection pooling (RDS Proxy or PgBouncer in transaction mode) is compatible because every request sets its context inside the transaction and the pooled-connection test proves no leakage.
- Backups: automated snapshots + PITR; restore drill per `DAFTAR_BACKUP_AND_DR.md`.

## 4. Media

- Private S3 bucket, SSE-KMS, no public ACLs; the API issues short-lived signed GET URLs (`/v1/catalog/media/{id}/access-url`), uploads go through the API (validated, re-encoded), never direct-to-bucket in Phase 1.
- Failed compensation deletes emit `media.orphan_cleanup_failed` outbox events with the leftover keys; a lifecycle rule plus that event feed drive orphan deletion.

## 5. Rate limiting and sessions

- ElastiCache Redis (cluster mode disabled, Multi-AZ). Limiter outage → API answers 503 with `Retry-After` (fail closed) and readiness turns red, so the ALB drains the task.
- `TRUST_PROXY` set to the ALB CIDR list; `X-Forwarded-For` walked right-to-left (`auth-abuse.test.ts` matrix).

## 6. Observability

- Logs: pino JSON → CloudWatch Logs (redaction happens in-process). Metric filters on `level>=50`, `rate limiter outage`, `credential delivery drain failed`, `outbox dead-letter`.
- Alarms: readiness failures per service, RDS connections, dead-letter counts > 0, 5xx rate.
- Tracing: `requestId` propagated in every log line and error body; X-Ray/OTel can attach at the ALB when Phase 2 adds distributed flows.

## 7. Release flow

1. CI green on the commit (workspaces, backend DB-from-zero, web/admin builds, Android, hygiene).
2. `npm run gate:phase1:release -- --evidence=release/evidence.json` on a clean runner.
3. `npm run export:release` → `release/DAFTAR_PHASE_1_RC.zip` + `.sha256`; the zip's `DELIVERY_MANIFEST.json` carries tree hash and migration hashes.
4. Build images from the exported tree; run migrate task; roll `worker`, then `platform-api`, then `merchant-api`; verify `/v1/health/ready` on each.
