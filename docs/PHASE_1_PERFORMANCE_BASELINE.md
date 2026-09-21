# DAFTAR — Phase 1 Performance Baseline / خط الأساس للأداء

> Directive §69. Measured, not estimated. Re-run with `npm run perf:baseline` (optionally `PERF_BASELINE_OUT=<file>` for JSON, `PERF_ITERATIONS=<n>`). The point of this document is the table; the assertions in `tests/perf/phase1-baseline.test.ts` are generous guard-rails (p95 < 750 ms, login < 2 250 ms) so a regression of an order of magnitude fails, and smaller ones are compared by hand at each phase gate.

## 1. Environment

| Item | Value |
|---|---|
| Date | 2026-09-21 |
| Node | v24.12.0 |
| API | in-process NestJS app (`createTestApp`, `PROCESS_MODE=all`), supertest over the HTTP server |
| Database | embedded PostgreSQL 18 on localhost, RLS enabled, six principals, fresh schema 0000–0037 |
| Data | 1 tenant, 1 business, 120 seeded products (2 translations each, SKU registered), 1 member, 1 platform owner |
| Machine | shared Linux container (release-gate runner), single process, no warm-up beyond the seed |

## 2. Results (60 iterations per endpoint; login 8 — under the per-account limiter window)

| endpoint | n | p50 ms | p95 ms | max ms | mean ms |
|---|---:|---:|---:|---:|---:|
| POST /v1/auth/login (argon2id verify m=19456 t=3 + token issue) | 8 | 59.5 | 79 | 79 | 64.6 |
| GET /v1/auth/me (JWT verify + identity read) | 60 | 3.2 | 5.4 | 9.3 | 3.5 |
| GET /v1/catalog/products?limit=50 (RLS + translation join over 120 rows) | 60 | 13.1 | 14.9 | 18.6 | 13.0 |
| GET /v1/catalog/products?q=Product 7 (search over translation rows) | 60 | 11.5 | 13.6 | 14.1 | 11.4 |
| POST /v1/catalog/products (translations + identifier registry + audit + outbox) | 60 | 27.3 | 35.4 | 40.2 | 27.9 |
| GET /v1/businesses/current/entitlement (effective state + 3 usage counters) | 60 | 46.1 | 58.3 | 65.7 | 46.8 |
| GET /v1/businesses/current/members (team screen) | 60 | 10.1 | 17.1 | 21.8 | 11.4 |
| GET /v1/admin/tenants (platform console list) | 60 | 5.0 | 8.5 | 20.2 | 5.8 |

Raw JSON: `release/perf-baseline.json` (written by the run that produced this table; the `release/` directory is not committed).

## 3. Reading the numbers

- **Login** is dominated by argon2id at the OWASP-recommended cost; ~60 ms per verify is the intended price. It is measured with 8 iterations because the per-IP+account limiter (10 attempts) is part of the product, not a test artefact.
- **Entitlement** is the slowest read (p95 58 ms): it evaluates plan version + overrides + subscription state and counts usage for three limits (`MAX_USERS`, `MAX_BRANCHES`, `MAX_PRODUCTS`) in one request. Indexes from `0035` cover the counters; the remaining cost is the three `count(*)` queries. Acceptable for Phase 1 (the merchant plan page and the limit checks); a cached usage snapshot is the Phase 2 optimisation if the POS hits this path per sale.
- **Product create** (p95 35 ms) performs five writes in one transaction (product, translations, identifier registry via trigger, audit, outbox). No N+1: translations are inserted with one multi-row statement.
- **List/search** (p95 ≤ 15 ms) read through `jsonb_object_agg` over the translation rows with the `(business_id, product_id)` index; the search path uses the translation index rather than a full scan.

## 4. Review checklist (§69) — outcome

| Check | Result |
|---|---|
| No new slow query without an index | `0035` added indexes for audit/outbox/entitlement counters; `0036`/`0037` add translation and registry indexes (31 indexes total) |
| No N+1 in list endpoints | Product list = 1 query + aggregation; members = 2 queries (members, roles); verified by reading the services and by the flat p95 across 60 iterations |
| Pagination capped | `limit` ≤ 100 (400 above), cursor-based, stable order (`catalog.test.ts`) |
| Connection budget | Pools opened per `PROCESS_MODE`; the harness runs 291 tests on a stock `max_connections=100` server after the leak fix |
| Rate limiter cost | Redis limiter in production; the memory limiter in this baseline adds < 1 ms |

## 5. What is NOT claimed

No load test, no multi-instance run, no network latency. Those belong to Phase 9 (load tests + restore drill) and to the AWS reference deployment.
