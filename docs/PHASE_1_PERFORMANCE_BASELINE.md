# DAFTAR — Phase 1 Performance Baseline / خط الأساس للأداء

> Directive §69. Measured, not estimated. Re-run with `npm run perf:baseline` (optionally `PERF_BASELINE_OUT=<file>` for JSON, `PERF_ITERATIONS=<n>`). The point of this document is the table; the assertions in `tests/perf/phase1-baseline.test.ts` are generous guard-rails (p95 < 750 ms, login < 2 250 ms) so a regression of an order of magnitude fails, and smaller ones are compared by hand at each phase gate.

## 1. Environment

| Item | Value |
|---|---|
| Date | 2026-09-21 |
| Node | v24.12.0 |
| API | in-process NestJS app (`createTestApp`, `PROCESS_MODE=all`), supertest over the HTTP server |
| Database | embedded PostgreSQL 18 on localhost, RLS enabled, six principals, fresh schema 0000–0039 |
| Data | 1 tenant, 1 business, 120 seeded products (2 translations each, SKU registered), 1 member, 1 platform owner |
| Machine | shared Linux container (release-gate runner), single process, no warm-up beyond the seed |

## 2. Results (60 iterations per endpoint; login 8 — under the per-account limiter window)

Two runs of the same code on the same host, both recorded. **Run B is the delivered baseline** (it is the one produced inside the extracted release archive, alongside the archive's own 24/24 gate).

| endpoint | n | Run A p95 ms | Run B p95 ms | Run B p50 / max / mean ms |
|---|---:|---:|---:|---|
| POST /v1/auth/login (argon2id verify m=19456 t=3 + token issue) | 8 | 79.0 | **54.7** | 45.9 / 54.7 / 47.7 |
| GET /v1/auth/me (JWT verify + identity read) | 60 | 5.4 | **2.3** | 2.0 / 2.9 / 2.0 |
| GET /v1/catalog/products?limit=50 (RLS + translation join over 120 rows) | 60 | 14.9 | **8.6** | 7.0 / 14.7 / 7.2 |
| GET /v1/catalog/products?q=… (search over translation rows) | 60 | 13.6 | **8.4** | 6.1 / 9.6 / 6.6 |
| POST /v1/catalog/products (translations + identifier registry + audit + outbox) | 60 | 35.4 | **19.2** | 15.1 / 24.2 / 15.5 |
| GET /v1/businesses/current/entitlement (effective state + 3 usage counters) | 60 | 58.3 | **31.5** | 26.2 / 31.9 / 26.5 |
| GET /v1/businesses/current/members (team screen) | 60 | 17.1 | **10.0** | 7.0 / 21.2 / 7.7 |
| GET /v1/admin/tenants (platform console list) | 60 | 8.5 | **3.7** | 3.1 / 6.8 / 3.2 |

Raw JSON: `release/perf-baseline.json` (Run A, repository) and `release/archive-perf-baseline.json` (Run B, inside the extracted archive). `release/` is not committed; both files ship as artifacts.

**On the spread between the two runs.** This is a shared container, so absolute latency depends on what else the host is doing; the two runs differ by up to a factor of two on the same code. That is measurement noise, not a change in behaviour — the *shape* is identical in both (login dominated by argon2id, entitlement the slowest read, everything else in single-digit to low-double-digit milliseconds). Compare future phases against Run B and against the shape, not against a single absolute number, and re-measure on a quiet host before calling anything a regression.

## 3. Reading the numbers

- **Login** is dominated by argon2id at the OWASP-recommended cost; tens of milliseconds per verify is the intended price. It is measured with 8 iterations because the per-IP+account limiter (10 attempts) is part of the product, not a test artefact.
- **Entitlement** is the slowest read (p95 31.5 ms in Run B, 58.3 ms in Run A): it evaluates plan version + overrides + subscription state and counts usage for three limits (`MAX_USERS`, `MAX_BRANCHES`, `MAX_PRODUCTS`) in one request. The counters are `count(*)` over business-scoped rows (memberships, branches, products) using their `(business_id, …)` primary keys; the remaining cost is the three counts plus the override window lookup. Acceptable for Phase 1 (the merchant plan page and the limit checks); a cached usage snapshot is the Phase 2 optimisation if the POS hits this path per sale.
- **Product create** (p95 19.2 ms in Run B) performs the writes in one transaction (product, one insert per locale — at most three, identifier registry via trigger, audit, outbox). No per-item fan-out beyond the locale count.
- **List/search** (p95 ≤ 8.6 ms in Run B) read through `jsonb_object_agg` over the translation rows (primary key `(business_id, product_id, locale)`). Search is an `ILIKE '%term%'` match over the business's translation, SKU and barcode rows — bounded by the business scope, not indexed for infix matching. At Phase 1 catalog sizes (≤ 100 000 products on the pro plan) this is a bounded scan; a trigram index is the Phase 2 optimisation if search latency grows with catalog size.

## 4. Review checklist (§69) — outcome

| Check | Result |
|---|---|
| No new slow query without an index | `0035` adds delivery-queue (due, lease), invitation (business, status) and audit (created, tenant) indexes; `0036` adds `product_translations (business_id, lower(name))`; `0037` adds `catalog_identifiers (business_id, owner_type, owner_id)` (31 indexes total) |
| No N+1 in list endpoints | Product list = one query with `jsonb_object_agg` over translations; members list = a fixed number of queries independent of member count (no per-member query); verified by reading the services and by the flat p95 across 60 iterations |
| Pagination capped | `limit` ≤ 100 (400 above), cursor-based, stable order (`catalog.test.ts`) |
| Connection budget | Pools opened per `PROCESS_MODE`; the whole integration/security suite runs on a stock `max_connections=100` server after the leak fix |
| Rate limiter cost | Redis limiter in production; the memory limiter in this baseline adds < 1 ms |

## 5. What is NOT claimed

No load test, no multi-instance run, no network latency. Those belong to Phase 9 (load tests + restore drill) and to the AWS reference deployment.
