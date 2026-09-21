# DAFTAR — Extension Readiness / جاهزية التوسّع

> How Phase 2+ features attach to the Phase 1 skeleton without re-architecture. Every extension point below exists in code today.

## 1. Runtime seams

| Seam | Today | Phase 2+ use |
|---|---|---|
| `PROCESS_MODE` modules (`MerchantApiModule`, `PlatformApiModule`, `WorkerModule`) | Composed from `runtime.ts` provider groups | Add `pos-api`, `storefront`, `sync-worker` by composing the same groups; config validation per mode already refuses foreign secrets |
| Outbox (`outbox_events` + `OutboxPublisher` + `OutboxSink`) | At-least-once relay, dead-letter, idempotent consumer contract | Journal posting, stock movements, WhatsApp notifications subscribe to business events |
| Credential delivery worker (lease, retry, dead-letter) | Invitations, password reset | Any out-of-band message (statements, OTP) reuses the same table pattern |
| `EntitlementsService.assertCanConsume` + registries | MAX_USERS/BRANCHES/PRODUCTS, 11 feature keys | New limits/features are registry rows in a new migration + plan version; engine unchanged |
| Permission registry (domain-core) | 38 permissions, delegation ceiling | Append `sale.create`, `journal.post`, … to one file; web/Android pick them up through shared contracts |
| Audit (`AuditService.recordTx`) | business ⇒ tenant CHECK, append-only | Financial `business_transaction_id` field is the next column (see `DAFTAR_OBSERVABILITY.md` §2) |

## 2. Data model seams

- Catalog: `products`, `product_variants`, `product_translations`, `catalog_identifiers` (SKU/barcode registry) are what inventory ledger rows and sale lines reference by composite `(business_id, id)` FKs; no stock column exists on products (proven in `catalog.test.ts`), so the ledger owns quantity from day one.
- Branch/warehouse structure exists with scope enforcement; stock locations reference `warehouses`.
- Money is stored as `bigint` minor + ISO currency; the multi-currency doc (`DAFTAR_MULTI_CURRENCY.md`) attaches FX tables without changing existing columns.
- `plan_versions` immutability + overrides support paid tiers without touching the engine.

## 3. Contract seams

- `@daftar/shared-contracts` is the only shape source for web, admin and Android; goldens 06/07 fail on drift. A new endpoint = DTO in shared-contracts + controller + client function + golden row.
- Error envelope `{ error: { code, message, requestId, details? } }` is stable; new codes extend the `ApiErrorCode` union.
- Idempotency-Key semantics (replay same payload → 200 replayed; different payload → 409) are implemented in the provisioner path and are the template for financial POSTs.

## 4. Operational seams

- Readiness reports per-mode adapters; adding a queue or search backend means one more component in `/v1/health/ready`.
- Static guards and CI DB-from-zero are generic: new migrations are frozen at each release by appending to the manifest.
- Perf baseline (`npm run perf:baseline`) gives numbers to compare after each phase.

## 5. Deliberately absent (not stubbed)

No placeholder tables, endpoints or screens exist for accounting, inventory, sales, storefront, WhatsApp or AI. Phase 2 starts from a documented pre-mortem (`PHASE_2_PREMORTEM.md`) rather than from partially built code.
