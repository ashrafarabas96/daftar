# DAFTAR — Implementation Roadmap / خارطة الطريق التنفيذية

> **Authoritative phase map.** Every phase has a gate in `DAFTAR_RELEASE_GATES.md` and must close clean (no accumulated defects). No phase starts before the previous one is documented PASS.
>
> This document was normalized on 2026-09-21 to the approved 16-phase map. The pre-normalization map (Phase 0–9, "Money Core" at Phase 2 bundling accounting + inventory + sales + POS) is preserved at the end of this file as a historical record — it is **not** the plan of record.

## Phase 0 — Architecture Constitution ✅ PASS

All `docs/` specifications, data model, security model, accounting rules, state machines, golden-suite definition + `PHASE_0_ACCEPTANCE_REPORT.md`.

## Phase 1 — Foundation, Security, Platform ✅ PASS

Tenancy · identity + auth (sessions, refresh lineage, JWT ring) · multi-user + RBAC (roles, delegation ceiling, branch scope) · business/branch/warehouse structure · catalog (products, variants, categories, normalized translations, identifier registry, media) · merchant web · admin web · Android foundation · entitlement foundation (plans, versions, limits, overrides) · super-admin foundation (platform console, support sessions) · localization ar/en/tr · CI, release gate, observability basics.

**Gate:** `PHASE_1_ACCEPTANCE_REPORT.md` — repository and extracted-archive release gates both PASS, tenant isolation proven, bug budget clean.

## Phase 2 — Accounting & Financial Core ✅ CLOSED / PASS

Chart of accounts · immutable double-entry journal (entries + lines) · posting engine with balanced debit/credit enforced at the database boundary · deterministic, idempotent posting keyed by `(source_type, source_id)` · integer minor-unit money · base-currency authority + FX rate snapshots · rounding policy · opening balances · reversal/correction semantics · trial balance, general ledger and account balances as read models · RBAC permissions · outbox events · audit.

**Explicitly NOT in Phase 2:** inventory, purchases, suppliers, sales, POS, customers, debts, installments, ecommerce, offline, WhatsApp, AI, CRM. Phase 2 builds the financial authority those later domains post **through**.

**Gate:** `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` acceptance gates + accounting golden tests + invariant enforcement.

## Phase 3 — Inventory, Purchases, Suppliers ✅ CLOSED / PASS

Inventory ledger and stock movements · warehouses/locations dimensionality · purchase cycle · suppliers · landed cost · stock valuation posting **through** the Phase 2 engine · transfers and stock counts.

## Phase 4 — Sales, POS, Customers, Debts, Installments ⟵ IN PROGRESS (P4-S1 accepted and frozen; P4-S2 authorized)

Sales documents and invoices · POS (web first) · customers · receivables · payments (cash/credit/partial) · debts and statements · installment plans · returns, refunds and credit notes.

## Phase 5 — SaaS Billing, Plans, Limits, Add-ons, Merchant Billing Portal

Subscription billing for the platform itself · plan catalogue and add-ons · limit enforcement surfaces · merchant-facing billing portal · dunning.

## Phase 6 — Orders, Ecommerce, Omnichannel

Public storefront · cart and checkout · order lifecycle · channel reconciliation.

## Phase 7 — Offline and Mobile Production Workflows

Android offline capture and sync · conflict resolution · mobile-first operational flows.

## Phase 8 — Notifications, WhatsApp, Automation

Official WhatsApp integration · templates · automated messages, statements and daily reports · notification engine.

## Phase 9 — Universal Booking and Services

Appointments and service scheduling · resources and calendars.

## Phase 10 — Restaurant / Cafe Pack

Tables, orders, kitchen flow, modifiers.

## Phase 11 — Apparel, Electronics, Repair, Lot/Expiry Packs

Vertical packs: variants matrices, serials, repair tickets, lot and expiry tracking.

## Phase 12 — AI Assistant

Speech to text · intent · drafts with explicit confirmation · full auditing.

## Phase 13 — Advanced Reports, CRM, Loyalty, Marketing

Analytical reporting · customer relationship features · loyalty · campaigns.

## Phase 14 — Integrations, Public API, Developer Platform

Outbound/inbound integrations · public API · keys, scopes and developer docs.

## Phase 15 — Production Hardening, Pentest, Load, DR, Launch

External penetration test · load testing · disaster-recovery drill · final audits (simplicity, premium experience, financial integrity, regression) · launch definition.

## Rules

1. No phase transition without a documented PASS.
2. Dependency order is not negotiable: **accounting before every operational domain that posts money**; inventory before storefront fulfilment; billing before paid-plan enforcement at scale.
3. Every operational domain posts through the accounting engine — none writes financial truth directly.
4. Minor ordering adjustments require a documented decision; the dependency order above does not bend.

## Status

- **Phase 0: PASS** (`PHASE_0_ACCEPTANCE_REPORT.md`).
- **Phase 1: CLOSED / PASS** (`PHASE_1_ACCEPTANCE_REPORT.md`, 2026-09-21).
- **Phase 2: CLOSED / PASS**, merged into `main` at `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f` (2026-09-24; `PHASE_2_S9_RELEASE.md`). Migrations `0000`–`0052`, protected permanently by `gate:phase2:release` (`scripts/phase2-prefix.ts`).
- **Phase 3: CLOSED / PASS**, merged into `main`. Draft PR #4 was marked ready and merged on 2026-09-29 as the merge commit `042f5d43d2edefd35eadab1cf8243b385aca9514` (parents `0f2b09e7…` and the sealed head `dd59962c2e53119d5cd5dea0d44df5d2f207a512`, tree identical to the sealed head). `DAFTAR CI` was then RED on `main` on three post-merge tooling defects — history-walking checks that break once the sealed head is inside `main` — and the follow-up PR #5 (tests and scripts only) was merged as `6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595`. **`DAFTAR CI` 36637141476 on `6fc505d` is SUCCESS on all six jobs** (workspaces, backend, web-admin, android, hygiene, browser), push event, attempt 1. The final Phase 3 database history is `0053`–`0073` (74 migrations in total, `frozenThrough = 0073_default_warehouse_locale_name.sql`, no `0074`): `0053`–`0069` from the slices P3-S1 … P3-S8, `0070`–`0073` Phase 3 corrective hardening, protected permanently by `gate:phase3:release` (`scripts/phase3-prefix.ts`). Open: OD-03 (tax; a non-zero tax is refused) and the debt in `TECHNICAL_DEBT.md`.
- **Phase 4: IN PROGRESS — P4-S0 LOCKED, P4-S1 ACCEPTED AND FROZEN, P4-S2 AUTHORIZED.** The Tech Lead authorized Phase 4 (Sales, POS, Customers, Debts, Receivables & Installments) on 2026-09-30 from the baseline `main = 6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595`, CI 36637141476 PASS. P4-S0, the Architecture Lock, created no product code, no endpoint, no POS screen and no migration, and was accepted on 2026-09-30 (docs-only `050952e`, CI 36690234626 SUCCESS). **P4-S1 — customers, sales documents and per-business document numbering — is accepted and frozen** (2026-10-01) at candidate `9a41089724e585f90fa3d2eee9b08c27254318ae`, exact-SHA `DAFTAR CI` 36804706477 (push) and 36804714710 (pull_request), six jobs SUCCESS each: migrations `0074`–`0076` are frozen, 77 in total, `frozenThrough = 0076_phase4_permission_defaults_backfill.sql` (`docs/PHASE_4_S1_ACCEPTANCE.md`). **P4-S2 — the atomic sale commit primitive — is authorized, and its first mandatory protection is the general Phase 4 RLS/FORCE discovery guard (`TL-P4-S1-R2`) before `0077` is created.** Work branch `phase/4-sales-pos-customers-receivables`; every Phase 4 change goes through a pull request, and PR #6 stays Draft. No slice after P4-S2 starts without a new explicit Tech Lead directive.

---

## Historical — pre-normalization map (superseded 2026-09-21)

Kept for traceability of earlier documents that cite these numbers. Do **not** plan against it.

| Old phase | Old scope | Where that scope lives now |
|---|---|---|
| Phase 2 — Money Core | Accounting engine + inventory ledger + sales/invoices/payments/receivables + POS | split: accounting → Phase 2; inventory → Phase 3; sales/POS/receivables → Phase 4 |
| Phase 3 — Debts, Installments, Returns | Installments, returns, credit notes, statements | Phase 4 |
| Phase 4 — Purchases, Suppliers, Expenses + Offline Android | Purchase cycle, advanced inventory, offline sync | purchases/suppliers → Phase 3; offline → Phase 7 |
| Phase 5 — Online Store & Orders | Storefront, cart, checkout, orders, bookings | ecommerce/orders → Phase 6; bookings → Phase 9 |
| Phase 6 — WhatsApp | WhatsApp integration and automation | Phase 8 |
| Phase 7 — AI Assistant | STT, intent, drafts | Phase 12 |
| Phase 8 — Subscriptions, Entitlements, Super Admin | Entitlement engine, plans, platform console, billing | foundation delivered in Phase 1; SaaS billing → Phase 5 |
| Phase 9 — Hardening & Launch | Final audits, load, restore drill, launch | Phase 15 |
