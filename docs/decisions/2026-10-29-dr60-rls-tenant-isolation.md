# DR-60 — tenant isolation on the eight read policies `0086` rewrote

**Date:** 2026-10-29 · **Class:** security, blocking for the Phase 4 seal ·
**Branch:** `p4/dr60-rls-tenant-isolation`, on top of `p4/mig-0084-e1-signature`.

## 1. Why this card exists

`0086_phase4_rls_quals_once_per_query.sql` is the first migration in this
project's history that altered **row-security policies on relations carrying
money**. It rewrote the row-invariant parts of two quals on four relations —
eight `ALTER POLICY` statements — for a measured performance reason.

Until the migration-signature card ran `0000 → latest` by hand on a real
cluster, no Phase 4 migration had ever been applied anywhere: every Phase 4
branch ships a `ci.yml` with no runnable runner on it. So eight policies that
decide which merchant can read which money had been **installed for the first
time, with their behaviour unmeasured**. This card measures it.

## 2. What was measured, and what it rests on

| Fact | How it was measured |
| --- | --- |
| **8** `ALTER POLICY` statements in `0086` (4 relations × 2 policies) | A lexer that strips comments, strings and dollar-quoted bodies. A plain `grep -c` returns **11**: three of those are inside a comment or a `RAISE` message. |
| `tenant_membership` is **PERMISSIVE**, `polcmd = '*'` (FOR ALL) | `pg_policy`, on the live cluster |
| `business_isolation_read` is **RESTRICTIVE**, `polcmd = 'r'` (FOR SELECT) | `pg_policy`, on the live cluster |
| `customer_ar_aging`, `customer_ar_open_document_counts`, `invoice_outstanding` are **INVOKER** | `pg_proc.prosecdef = false` |
| Row security is **enabled and forced** on all four relations | `pg_class` |
| `daftar_app` holds **SELECT and nothing else** on all four, table-level and column-level | `information_schema.role_table_grants` + `role_column_grants` |
| **No** runtime principal holds `DELETE` on any of the four | the same two views |
| `daftar_inventory_internal` holds column `UPDATE` on `invoices.status` and on eight columns of `sales`, and **nothing** on `payment_allocations` or `customer_credit_applications` | `role_column_grants` |
| `daftar_inventory_internal` is `NOLOGIN`, `NOBYPASSRLS`, reached only by `SET ROLE` from `daftar_migrator` | `pg_roles` + `bootstrap.sql` |

## 3. What this card decides

1. **The eight quals isolate merchants, measured on two live tenants.** Two
   businesses in two tenants, each carrying real rows in all four relations,
   built through the real commands. Each tenant sees exactly its own row ids —
   set equality, not a count, because two equal counts can be two different
   sets.
2. **One case per policy.** Eight cases, each scoped so exactly one of the
   eight quals is the thing refusing: a foreign tenant holding *this*
   business's id isolates `tenant_membership`; this tenant holding a foreign
   business id isolates `business_isolation_read`. The foreign ids are fresh
   UUIDs each run, so no qual can have been written against them.
3. **Every zero has a positive control** in the same case and the same run.
4. **The write path is stated as it actually is, not as the commissioning card
   assumed it.** See §4.

## 4. The correction this card makes to its own card

The card asked for "a tenant can neither read, nor `UPDATE`, nor `DELETE`
another tenant's rows", as though all three were decided by the eight
rewritten quals. Two measurements say otherwise:

- `business_isolation_read` is `FOR SELECT`. It is **not consulted** on an
  `UPDATE` or a `DELETE`. Writes are governed by `business_isolation_update`
  and `business_isolation_delete`, which `0086` never touched and which are
  therefore **not this card's subject**. Only `tenant_membership` is in both.
- `daftar_app` holds no write privilege at all, so its `UPDATE`/`DELETE` is
  refused by **privilege (SQLSTATE 42501) before row security is reached**.

So the write side is proved in two honest parts rather than one flattering
one: a privilege refusal where no privilege exists (measured, and attempted),
and a row-security refusal on the one principal and the two relations where a
write privilege does exist. Presenting a `42501` as an RLS proof would have
been the more impressive claim and the false one.

## 5. The negative controls

Eight, one per policy. For each: the qual is replaced with `USING (true)` by
the table owner; **the plant is proved applied by reading `pg_get_expr` back
before anything is run**; the suite runs; the qual is restored from a capture
taken before any plant and **proved byte-identical**. After all eight, a final
sweep confirms all eight match the captured shipped text exactly.

Every plant turned its own named case red **with an `AssertionError`** — a
failing assertion, never a suite that would not load. The mapping is one to
one: weakening `tenant_membership@X` reddens `[DR60:tenant_membership@X]` and
never `[DR60:business_isolation_read@X]`, and vice versa.

## 6. What this card does NOT decide — every `NOT_RUN` by name

- **CI has not run any of this.** Phase 4 branches carry a `ci.yml` with no
  runnable runner, so the whole measurement is **local, on one machine, by one
  hand**. Re-running it on the seal branch (DR-26) is outstanding.
- **`business_isolation_update` and `business_isolation_delete` are NOT
  proved** by this card. They govern the write path and `0086` did not touch
  them; they have no suite on this head. **A separate card.**
- **`accounting_validator` and `inventory_internal_read`** — the two other
  permissive read policies on these relations — are not this card's subject.
  The escape they grant to the two internal principals is measured by
  `p4s4-rls-quals-once-per-query.test.ts`, not here.
- **Nothing about performance.** `0086`'s reason for existing was cost;
  this card measures only that the answers it gives are still isolated.
- **No HTTP-level isolation.** Everything here is measured at the database
  connection. The route layer has its own suites.
- **Only `customer_ar_aging` and `customer_ar_open_document_counts` were
  exercised** among the money readers. `customer_ar_outstanding`,
  `customer_open_invoices_page`, `invoice_outstanding` and
  `invoice_settlement_state` were **not** exercised under a two-tenant scope
  here; the once-per-query suite exercises them under one.

## 7. Open for the owner

1. **`0086` has shipped eight quals whose behaviour had never been observed.**
   It is now observed, locally. Whether that is enough to seal, or whether the
   seal run must reproduce it in CI, is the owner's call. This card's position:
   the seal run should reproduce it, because a security measurement taken once
   by one hand on one machine is exactly the kind of evidence this project
   refuses elsewhere.
2. **The write-path gap.** `business_isolation_update` and
   `business_isolation_delete` are the quals that actually stand between one
   merchant and another merchant's rows on a write, and nothing measures them.
   Today the gap is narrowed by the fact that no runtime principal holds
   `DELETE` and only one holds a column `UPDATE` — but that is a *grant*
   holding the line, and a later slice that grants a write re-opens it with no
   test watching. **Recommended: a follow-up card before any slice grants
   `UPDATE` or `DELETE` on a Phase 4 money relation.**
