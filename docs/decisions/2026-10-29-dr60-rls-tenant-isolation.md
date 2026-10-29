# DR-60 — tenant isolation on the eight read policies `0086` rewrote

**Date:** 2026-10-29 · **Class:** security, blocking for the Phase 4 seal ·
**Branch:** `p4/dr60-rls-tenant-isolation`, on top of `p4/mig-0084-e1-signature`.

## 1. Why this card exists

`0086_phase4_rls_quals_once_per_query.sql` rewrote the row-invariant parts of
two quals on four relations that carry money — eight `ALTER POLICY`
statements — for a measured performance reason.

**A correction this card makes to its own first draft.** That draft called
`0086` "the first migration in this project's history to alter row-security
policies on relations carrying money". That is **false**, and it was measured
false with a lexer over every migration in the tree:

| migration | `ALTER POLICY` statements | relations |
| --- | --- | --- |
| `0045` | 3 | `journal_entries`, `journal_lines`, `accounting_source_bindings` |
| **`0052`** | **6** | `accounts`, `journal_entries`, `journal_lines` |
| `0067` | 1 | `supplier_credit_notes` |
| `0070` | 1 | `catalog_identifiers` |
| `0077` | 1 | `invoice_items` |
| `0086` | **8** | the four this card is about |

`0052` is `accounting_journal_lines_rls_performance` — the double-entry
journal, rewritten for the same reason and in the same class. A superlative
is not an argument, and this one was wrong.

What **is** true, and is what makes this card worth writing, is narrower:
every Phase 4 branch ships a `ci.yml` with no runnable runner on it, so this
project has **no recorded run in which `0086` was installed on a live
cluster** until the migration-signature card ran `0000 → latest` by hand. So
eight policies that decide which merchant can read which money had been
installed with their behaviour **unmeasured**. This card measures it.

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
| `daftar_inventory_internal` holds `SELECT, INSERT` on **all four** relations | `role_table_grants` |
| and, on top of that, column `UPDATE` on `invoices.status` and on eight columns of `sales` — and **no `UPDATE` at all** on `payment_allocations` or `customer_credit_applications` | `role_column_grants` |
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
3. **Every visibility zero has a positive control** in the same case and the
   same run — the eight policy cases, the no-scope case, both `UPDATE` cases
   and the money readers. The `DELETE` case is a grant sweep rather than a
   visibility claim, and its control is of its own kind: the same probe,
   without the owner exclusion, **does** find `DELETE` grants, so its
   emptiness is a refusal and not a probe that never matches. Stating this
   as "every zero" without the distinction, as the first draft did, claimed
   more than the file does.
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
and a row-security refusal on the one principal and the two relations where an
`UPDATE` privilege does exist (`INSERT` exists on all four, and is governed by
`WITH CHECK` rather than by the clause `0086` rewrote — see §6). Presenting a
`42501` as an RLS proof would have
been the more impressive claim and the false one.

## 5. The negative controls

Eight, one per policy. For each: the qual is replaced with `USING (true)` by
the table owner; **the plant is proved applied by reading `pg_get_expr` back
before anything is run**; the suite runs; the qual is restored from a capture
taken before any plant and **proved byte-identical**. After all eight, a final
sweep confirms all eight match the captured shipped text exactly.

**Two more, for the two assertions the review batch strengthened** — because
a changed assertion with no plant behind it is a claim, not a test:

- the money-reader set is pinned by name, so one reader renamed away turns
  exactly one case red (`the set of money readers present is not the set this
  case claims to be speaking about`). The assertion it replaced — a count
  greater than zero over three named routines — would have stayed green.
- the `DELETE` sweep is a grant sweep, so `GRANT DELETE ON invoices TO
  daftar_app` turns two cases red and is then revoked.

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
- **`INSERT` is not this card's subject, and the surface is not empty.**
  `daftar_inventory_internal` holds `INSERT` on **all four** relations
  (`0077:484`, `0078:264`, `0081:616`, and **zero** `REVOKE` touching it).
  An insert is judged by `WITH CHECK`, not by the `USING` clause `0086`
  rewrote, so `business_isolation_insert` and `tenant_membership`'s
  `WITH CHECK` are **out of scope here and measured by nothing on this
  head**. The exclusion is legitimate; the silence about it in the first
  draft was not, because a reader planning the follow-up card would have
  skipped a surface that exists today.
- **The same-class rewrites outside Phase 4 are not re-proved.** `0045`,
  `0052`, `0067`, `0070` and `0077` each altered policies too, and `0052` is
  the same kind of performance rewrite on the double-entry journal. None of
  them is examined here.
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
2. **The write-path gap is open NOW, not later.** The first draft of this
   section said the gap was narrowed by no runtime principal holding a write,
   and that "a later slice that grants a write re-opens it". That reading was
   wrong and the measurement is in §2: `daftar_inventory_internal` already
   holds `INSERT` on **all four** relations, and column `UPDATE` on two of
   them. So the quals that stand between one merchant and another merchant's
   rows on a write — `business_isolation_insert`, `business_isolation_update`,
   `business_isolation_delete`, and `tenant_membership`'s `WITH CHECK` — are
   **load-bearing today** and are measured by nothing. `DELETE` alone is held
   by no runtime principal, and there the line is a missing grant rather than
   a qual. **Recommended: a follow-up card on the write quals, before the
   seal rather than after it.**

## 8. DR-61 §1 — the grant-pinning law

The owner's decision, in the words it was given in: *write protection must not
stay dependent on a missing grant.* §4 of this document and the two write cases
in the suite both rest on one fact — `daftar_app` holds no `UPDATE`, `DELETE`
or `TRUNCATE` on these four relations — and that fact is an **absence**. An
absence ends without a trace. So it is pinned, in the same suite, by a case
added for this purpose: **`DR-61 — no application role holds UPDATE, DELETE or
TRUNCATE on the four money relations beyond the pinned, measured surface`**.

### 8.1 Who is an "application role"

Derived from the catalogue at run time, **not from a list in the file**: every
role whose `rolname` matches `daftar\_%`, plus `PUBLIC`, **minus, per
relation, that relation's measured owner**.

- `PUBLIC` is in scope because one grant to it reaches every principal at
  once — the worst shape the law could miss.
- The **owner** is excluded because an owner holds its relation by owning it:
  `REVOKE` from an owner is undone by the owner's next grant to itself, and
  `relacl` materialises the owner's whole set as soon as any grant is made.
  The owner is **measured** (`pg_get_userbyid(relowner)`), not named, so a
  managed deployment that hands ownership to `daftar_migrator` is followed
  rather than failed. This is the fix the `DELETE` case already asks for in
  prose. It says nothing about whether the owner is reachable from a merchant
  request; that is a question about connection strings and is not in scope.

Because the set is derived, **a `daftar_%` role created tomorrow is in scope
the moment it is created**, with no edit here. Measured today: twelve
`daftar_%` roles, eight of them `rolcanlogin`.

**The prefix is the limit of the whole law, and it is a real limit.** A role
that can log in but whose name does not begin with `daftar_` is invisible to
every assertion in §8.3: `CREATE ROLE rogue_writer LOGIN` with
`GRANT UPDATE ON invoices` and `GRANT TRUNCATE ON sales` takes the measured
write surface from **9 to 11** — and leaves the suite at **17/17, EXIT 0**.
That is measured, not supposed, and it is now stated **in
the code, beside the role query** rather than only here — a limit declared in
another file does not make the sentence in the failure message true, and the
failure message is what an engineer reads at the moment it matters.

Widening the sweep to every role in `pg_roles` is **not** a free
strengthening and is deliberately not done in this card: a cluster carries
system and tooling roles whose grants are legitimate and are nobody's business
here, and a law that reddens on them teaches people to widen an exclusion
instead of reading it. It is **a follow-up card**, with its own measurement of
what such a sweep would actually see. See §8.6.

### 8.2 What is swept, exactly

`UPDATE`, `DELETE` and `TRUNCATE` at **table** level, and `UPDATE` at
**column** level. **Not** `DELETE` or `TRUNCATE` at column level: PostgreSQL
has no column-level `DELETE` or `TRUNCATE` privilege, so such a probe is empty
by construction and buys the appearance of coverage and nothing else — the
same reason the earlier review batch deleted one. The table-level view is the
whole of the question for those two.

Read from `pg_class.relacl` and `pg_attribute.attacl` through `aclexplode`,
**not** from `information_schema.role_table_grants`: that view shows only
grants whose grantor or grantee is a *currently enabled* role, so it can return
nothing for a reason that has nothing to do with grants — a silent green.

### 8.3 The two assertions

- **(a) A plain zero.** No **`daftar_%`** principal a connection can
  authenticate as (`rolcanlogin`), and not `PUBLIC`, holds any of the three at
  either level. Nothing is pinned here and there is nothing to maintain; the
  measured answer today is zero. It is a zero over the prefixed roles, **not**
  over every role in the cluster — §8.1.
- **(b) The whole write surface held by `daftar_%` roles, pinned by set
  equality**, including the
  `NOLOGIN` internal principals. Measured on a live PostgreSQL 16.15 cluster
  carrying migrations `0000 … 0086` (**87 applied**), the surface is exactly
  **nine** entries, all of them column-level `UPDATE` held by
  `daftar_inventory_internal`: `invoices.status`, and eight columns on `sales`
  (`binding_source_id`, `business_transaction_id`, `confirmed_at`,
  `confirmed_by`, `status`, `void_intent_sha256`, `voided_at`, `voided_by`).
  No table-level `UPDATE`, no `DELETE` and no `TRUNCATE` is held at any level
  by any `daftar_%` role or by `PUBLIC`.

### 8.4 The decision taken where the card left a choice, and why

The card allowed either excluding `daftar_inventory_internal` from the
definition of "application role" — on the grounds that it is an internal
principal no merchant logs in as — **or** recording its existing grants as a
measured floor. **The second was taken.** Excluding it would make the law blind
to the *only* principal in the cluster that can write to these relations at
all, which is precisely the thing worth watching; the law would then be green
whatever was granted to it. Pinning it costs nine literal lines and reddens on
`GRANT UPDATE (total_txn_minor) ON invoices TO daftar_inventory_internal` —
which is measured below, not asserted.

It is a **pin, not an exception list**. Nothing is appended to it to make a new
grant pass. The failure message of both assertions carries the precondition
verbatim: the write quals must first be proved **for the principal receiving
the grant**, live, on a cluster with two populated tenants in it. Editing the
pinned set is the deliberate act of a card that has already done that; it is
not the quiet maintenance an exception list invites.

**And the precondition states what already exists, because an earlier draft of
it said "neither qual has ever been executed in this project" and that is
false.** Measured in `tests/security/p4s4-rls-barrier-behaviour.test.ts`:

- **`business_isolation_update` IS exercised by behaviour** — for
  `daftar_inventory_internal` on `invoices` and `sales`, over the narrow
  column list it holds. A row of a foreign business is reached by **zero**
  rows and the same statement reaches the principal's own row, so there is a
  positive control. But that arm **does not isolate it**: the suite's own
  comment says the refuser there is `business_isolation_update` *or* the
  tenant policy, and which one is not decided. And it is exercised for **no
  other principal** — `daftar_app` cannot reach it at all, which is precisely
  the absence this card pins.
- **`business_isolation_delete` is not exercised under the shipped grants**,
  and cannot be: every `DELETE` dies at the privilege check (42501) before row
  security is reached. The one place it is executed is a rolled-back case in
  that suite which **grants the missing `DELETE` to itself** in order to show
  the `RESTRICTIVE` operator is load-bearing — a hypothesis, not this cluster.

The error direction of the retired sentence was conservative — it claimed
*less* protection than exists — so it was never a security risk. It was still
a false statement of fact inside the text that governs a later blocking card,
and someone reading it would have rebuilt work that is already there.

### 8.5 The plants (DR-55 and its complement)

Five. For each: the grant is applied, **proved applied by counting the write
surface in the catalogue before and after** — never assumed — the law is run,
then the grant is revoked and the count proved returned, and the law is run
again and is green. Every plant reddened **this** case with an
`AssertionError` naming the grantee, the privilege and the relation.

| plant | surface before → after | law | named in the failure |
| --- | --- | --- | --- |
| `GRANT UPDATE ON invoices TO daftar_app` | 9 → 10 | EXIT 1 | `daftar_app holds UPDATE on invoices` |
| `GRANT DELETE ON sales TO daftar_app` | 9 → 10 | EXIT 1 | `daftar_app holds DELETE on sales` |
| `GRANT TRUNCATE ON payment_allocations TO daftar_worker` | 9 → 10 | EXIT 1 | `daftar_worker holds TRUNCATE on payment_allocations` |
| `GRANT UPDATE (total_txn_minor) ON invoices TO daftar_inventory_internal` | 9 → 10 | EXIT 1 | `invoices\|daftar_inventory_internal\|UPDATE\|total_txn_minor` |
| `GRANT UPDATE ON customer_credit_applications TO PUBLIC` | 9 → 10 | EXIT 1 | `PUBLIC holds UPDATE on customer_credit_applications` |

After every revoke the surface returned to **9** and the law returned **EXIT
0**. The third plant uses a login role that is *not* `daftar_app`, and the
fifth uses `PUBLIC`, so the three together show the role set is derived rather
than written down. The fourth is the only one that reddens assertion (b)
rather than (a) — which is the evidence that the pin, not the zero, is what
covers the internal principals.

**Two things these plants do not show, recorded so the table is not read for
more than it says.**

- **Removing a pinned grant is not a plant for this case.** The nine entries
  are load-bearing: `invoices.status` and the `sales` columns are what the
  inventory routines write. Delete one and the fixture's own commands fail
  first (HTTP 403), so the file ends **17 skipped** rather than with a named
  failure here. That is a correct red, but it is the fixture collapsing, not
  this law biting, and it must not be counted as evidence for it. Every plant
  above **adds** a grant; none removes one.
- **`DELETE` is caught twice, `UPDATE` and `TRUNCATE` once.** The older case
  `DELETE is held by NO runtime principal …` also reddens on plant two —
  **by coincidence of subject, not by design**: it sweeps `DELETE` only, so
  it is silent on the `TRUNCATE` and `UPDATE` plants. It is not a second
  layer under this law and must not be read as one.

**The positive control**, without which every assertion above is satisfied by a
broken probe: the sweep is taken over *all* privileges first, and the case
asserts that it can see `daftar_app`'s `SELECT` on each of the four, that every
relation has a measured owner, that `daftar_app` is reported `rolcanlogin` and
`daftar_inventory_internal` is reported not, and that the pinned set is not
empty. A probe that returns nothing therefore fails rather than passes.

### 8.6 What this law does NOT do — `NOT_RUN` by name

- **It does not prove the write policies.** It pins the absence that makes
  proving them unnecessary *today*. What is already there is in §8.4 and is
  narrow: `business_isolation_update` exercised **only** for
  `daftar_inventory_internal`, on two of the four relations, and **not in
  isolation** from `tenant_membership`; `business_isolation_delete`
  unreachable under the shipped grants. Proving them for the principal that
  receives a write is **a blocking card for the first slice that grants one,
  not for the seal** — the owner's decision, recorded here.
- **It is not run by CI.** Like the rest of this suite, the evidence is local,
  on one machine, by one hand, with the cluster described in §8.3.
  Reproducing it on the seal branch (DR-26) is outstanding.
- **`INSERT` is not swept.** It is already held by
  `daftar_inventory_internal` on all four and is judged by `WITH CHECK`, not
  by the clauses this suite is about; §6 keeps it named.
- **Default privileges are not swept.** `ALTER DEFAULT PRIVILEGES` can grant
  on relations created *later*; it cannot add a privilege to these four, which
  already exist, so it is out of scope here and not a hole in this law.
- **Relations outside the four are not swept.** The law's subject is the four
  relations `0086` rewrote quals on.
- **A write principal whose role name does not match `daftar\_%` is invisible
  to the whole law** — measured, not supposed: `rogue_writer LOGIN` holding
  `UPDATE ON invoices` and `TRUNCATE ON sales` takes the write surface from 9
  to 11 and leaves the suite at 17/17, EXIT 0. Every role this deployment creates is prefixed (`bootstrap.sql`),
  so nothing it ships falls in the gap, but the gap is real. **Follow-up
  card: sweep every role in `pg_roles`, measure first what such a sweep sees
  on a stock cluster (system and tooling roles hold legitimate grants), and
  decide the exclusion from that measurement rather than ahead of it.** It is
  not folded into this card because a law that reddens on legitimate grants
  teaches people to widen an exclusion instead of reading it.
