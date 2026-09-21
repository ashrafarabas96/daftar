# DAFTAR — Implementation Roadmap / خارطة الطريق التنفيذية

> **Authoritative phase map.** Every phase has a gate in `DAFTAR_RELEASE_GATES.md` and must close clean (no accumulated defects). No phase starts before the previous one is documented PASS.
>
> This document was normalized on 2026-09-21 to the approved 16-phase map. The pre-normalization map (Phase 0–9, "Money Core" at Phase 2 bundling accounting + inventory + sales + POS) is preserved at the end of this file as a historical record — it is **not** the plan of record.

## Phase 0 — Architecture Constitution ✅ PASS

All `docs/` specifications, data model, security model, accounting rules, state machines, golden-suite definition + `PHASE_0_ACCEPTANCE_REPORT.md`.

## Phase 1 — Foundation, Security, Platform ✅ PASS

Tenancy · identity + auth (sessions, refresh lineage, JWT ring) · multi-user + RBAC (roles, delegation ceiling, branch scope) · business/branch/warehouse structure · catalog (products, variants, categories, normalized translations, identifier registry, media) · merchant web · admin web · Android foundation · entitlement foundation (plans, versions, limits, overrides) · super-admin foundation (platform console, support sessions) · localization ar/en/tr · CI, release gate, observability basics.

**Gate:** `PHASE_1_ACCEPTANCE_REPORT.md` — repository and extracted-archive release gates both PASS, tenant isolation proven, bug budget clean.

## Phase 2 — Accounting & Financial Core ⟵ NEXT (not started)

Chart of accounts · immutable double-entry journal (entries + lines) · posting engine with balanced debit/credit enforced at the database boundary · deterministic, idempotent posting keyed by `(source_type, source_id)` · integer minor-unit money · base-currency authority + FX rate snapshots · rounding policy · opening balances · reversal/correction semantics · trial balance, general ledger and account balances as read models · RBAC permissions · outbox events · audit.

**Explicitly NOT in Phase 2:** inventory, purchases, suppliers, sales, POS, customers, debts, installments, ecommerce, offline, WhatsApp, AI, CRM. Phase 2 builds the financial authority those later domains post **through**.

**Gate:** `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` acceptance gates + accounting golden tests + invariant enforcement.

## Phase 3 — Inventory, Purchases, Suppliers

Inventory ledger and stock movements · warehouses/locations dimensionality · purchase cycle · suppliers · landed cost · stock valuation posting **through** the Phase 2 engine · transfers and stock counts.

## Phase 4 — Sales, POS, Customers, Debts, Installments

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
- **Phase 1: PASS** (`PHASE_1_ACCEPTANCE_REPORT.md`, 2026-09-21). Nothing from Phase 2 exists: no accounting, inventory, sales or POS table, endpoint or screen.
- **Phase 2: planned, not started.** Entry conditions in `PHASE_2_PREMORTEM.md`; the execution plan is `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md`. Implementation begins only after the Tech Lead approves the Phase 1 pull request.

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
