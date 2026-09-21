# DAFTAR — Phase 2 Accounting & Financial Core Execution Plan / خطة تنفيذ النواة المحاسبية

> **⚠ SUPERSEDED IN PART — read `PHASE_2_ARCHITECTURE_LOCK.md` first.** The Architecture Lock (P2-S0) resolved eighteen decisions that this plan left ambiguous or, in seven cases, stated incorrectly (`AL-01` … `AL-18`, conflicts `K-01` … `K-07`). **Where the two differ, the Architecture Lock wins.** The corrected passages below carry an inline `→ AL-nn` marker.
>
> **Status: PLANNING ONLY. No Phase 2 code, migration, table, endpoint or screen exists or may be created under this document.**
> Implementation begins only after the Tech Lead approves the Phase 1 pull request and accepts this plan as the execution contract (`PHASE_2_PREMORTEM.md` entry conditions).
>
> **Scope (per `DAFTAR_IMPLEMENTATION_ROADMAP.md`, normalized 16-phase map): Accounting & Financial Core ONLY.**
> Explicitly **not** in Phase 2: inventory, purchases, suppliers, sales, POS, customers, debts, installments, ecommerce, offline, WhatsApp, AI, CRM. Phase 2 builds the financial authority those later domains post **through**.
>
> **Design inputs (Phase 0, authoritative — this plan does not override them):** `DAFTAR_ACCOUNTING_RULES.md`, `DAFTAR_MULTI_CURRENCY.md`, `DAFTAR_DATA_MODEL.md`, `DAFTAR_TRANSACTION_MAP.md`, `DAFTAR_SOURCE_OF_TRUTH_MATRIX.md`, `DAFTAR_STATE_MACHINES.md`, `DAFTAR_GOLDEN_REGRESSION_SUITE.md`, `DAFTAR_SECURITY_MODEL.md`, `DAFTAR_TEST_STRATEGY.md`, `DAFTAR_OBSERVABILITY.md`, `DAFTAR_RELEASE_GATES.md`.
> Where this plan is narrower than a Phase 0 document, the narrowing is a **scope split across phases**, recorded in §36 (Conflicts and deferrals) — never a silent contradiction.

---

## 0. Gated implementation slices

Phase 2 ships as ten gated slices (`PHASE_2_ARCHITECTURE_LOCK.md` AL-18). **Each slice requires its own documented PASS before the next begins.** A slice may not borrow a later slice's migration number, and no slice may start before the Tech Lead authorizes it.

**Governing rule: every slice must be independently safe.** Structural schema may land before its writer exists — a table nobody can write to is safe. A writer may **not** land before the verification, binding, fingerprint, audit and outbox protections it depends on. `GRANT EXECUTE` on the posting primitive happens in exactly one slice: P2-S3, the slice that supplies all of them. A slice PASS never means "safe after the next slice".

| slice | content | migrations | exit criteria |
|---|---|---|---|
| **P2-S0** | Architecture lock — decisions only | **0** | Tech Lead approval of `PHASE_2_ARCHITECTURE_LOCK.md` |
| **P2-S1** | `accounts`, system-key registry, seeding + trigger + backfill, permissions | `0040`, `0041` | every existing and new business has a chart; AL-05/06/07/08 tests green |
| **P2-S2** | Journal + binding **structural schema only**: tables, CHECKs, immutability triggers, both validation triggers, RLS and the full REVOKE shape. **No writer function, no EXECUTE granted** | `0042`, `0043` | Matrix 1 (privilege, all six roles) **and** Matrix 2 (invariants A–H, schema owner) both green |
| **P2-S3** | Assertion keys, assertion verification, `accounting_post_entry`, fingerprint, audit + outbox — **and only now `GRANT EXECUTE`** | `0044`, `0045` | AL-03 spoofing suite, AL-11 matrix, AL-17 failure-injection matrix green |
| **P2-S4** | Reversal, manual adjustment, opening balance — Phase-2-owned sources only | `0046`, `0047` | AL-12 and AL-13 state-machine tests green |
| **P2-S5** | FX foundation: manual rate source, immutable snapshot, rounding, realized-FX primitive | `0048` | the seven AL-09 vectors green in both implementations |
| **P2-S6** | Accounting periods — **only if confirmed at that point** | `0049` | close/reopen/concurrency tests green |
| **P2-S7** | Trial balance, general ledger, account balances — live aggregation | `0050` (indexes only, if needed) | reports balance; rebuild-equals-live green |
| **P2-S8** | Red team, cross-tenant, raw SQL, failure injection, rollback rehearsal, performance dataset | 0 | budgets met, or materialization justified |
| **P2-S9** | Release closure: gate, RC archive, evidence, docs | 0 | repository and extracted-archive gates both PASS, zero skips |

---

## 0. Non-negotiable accounting laws

These hold for every line of Phase 2 code and for every later phase that posts through it. A change to any of them is an architecture decision, not an implementation choice.

| # | Law |
|---|---|
| L-01 | Posted journal entries are **append-only**. No UPDATE, no DELETE, ever. |
| L-02 | No silent financial mutation. Every change of financial state is an explicit, audited domain command. |
| L-03 | Every entry is **balanced (Σdebit = Σcredit in base currency)** and the balance is enforced at the **database boundary**, not only in the service. |
| L-04 | Posting is **deterministic and idempotent**: the same business fact posted twice yields one entry. |
| L-05 | Money is **fixed precision integer minor units**. No float, no `Number`, anywhere, at any layer. |
| L-06 | One business per record. Every accounting row carries `tenant_id` and `business_id` directly. |
| L-07 | **No cross-tenant and no cross-business posting.** An entry never references an account of another business. |
| L-08 | Corrections happen through **reversal / correcting entries**, never by editing history. |
| L-09 | Every posting is **auditable**: who, when, from which source, with which rate, under which request id. |
| L-10 | **All domains post through the engine.** No later domain writes financial truth directly. |
| L-11 | A derived balance is **never** the sole source of truth. Read models are rebuildable from the journal. |

---

## 1. Accounting invariants carried into Phase 2

`DAFTAR_ACCOUNTING_RULES.md` §10 defines INV-ACC-01…INV-ACC-18. Phase 2 owns the subset that does not depend on an operational domain; the rest is **designed for** now and **enforced** in the phase that creates its source.

| Invariant | Phase 2 responsibility |
|---|---|
| INV-ACC-01 Σdebit = Σcredit per entry (base) | **Owned and enforced** — deferrable constraint trigger + reconciliation. |
| INV-ACC-05 snapshots frozen (price/cost/fx) | **Owned for the FX snapshot**: rate, source and timestamp on the entry/line are immutable once posted. |
| INV-ACC-06 every AR/AP change has a matching entry | **Seam owned** — Phase 4/3 supply the sources; reconciliation query designed now. |
| INV-ACC-07 no two entries for the same source | **Owned** — `UNIQUE(business_id, source_type, source_id)`. |
| INV-ACC-08 revenue created/reversed exactly once | **Rule owned** (the engine refuses a second entry for the same source); the sale/credit-note sources arrive in Phase 4. |
| INV-ACC-09 settlement identity (`payment_base = carrying_released + realized_fx ± documented rounding`) | **Arithmetic owned** in the FX/rounding utilities and unit-tested with synthetic sources; wired to real allocations in Phase 4. |
| INV-ACC-11 GL 1200 = inventory valuation | Designed as a reconciliation check; activated in Phase 3. |
| INV-ACC-12 Realized FX ≠ Rounding ≠ PPV (4900/6900 vs 6100 vs 6200) | **Owned** — three distinct system accounts, posting helpers that cannot target the wrong one, golden tests. |
| INV-ACC-02/03/04/10/13/14/15/16/17/18 | **Not Phase 2** — they belong to invoices, payments, refunds, credit notes, supplier returns and inventory. Phase 2 must not implement them and must not make them impossible: the engine's API shape is validated against each of their journal examples in §30. |

**Phase 2 adds no new invariant number.** If implementation reveals a genuinely new financial invariant, it is proposed as INV-ACC-19+ through a documented decision, not invented in code.

---

## 2. Chart of accounts model

- One chart **per business** (`DAFTAR_ACCOUNTING_RULES.md` §1). Never per tenant, never shared.
- `accounts (id, tenant_id, business_id, code, name, type, is_active, UNIQUE(business_id, code))` — exactly as `DAFTAR_DATA_MODEL.md` §13 defines it. Phase 2 implements that shape; it does not redesign it.
- `type ∈ {asset, liability, equity, revenue, expense}` with the normal-balance side derived from the type (asset/expense = debit, liability/equity/revenue = credit). Normal balance is **presentational**, never a posting constraint: a contra account (4100 Sales Returns, 4200 Discounts) legitimately carries the opposite side.
- **Seeding (→ AL-08).** An `AFTER INSERT` trigger on `businesses` calls a SECURITY DEFINER seeding routine, so the chart is written in the **same transaction** as the business row — including inside the frozen `provision_create_business` command, because a trigger attaches to the table, not to the caller. No frozen migration is edited. Migration `0040` backfills every existing business and **fails** if any business is left without a chart. Seeding writes one `name` per account; **there is no `account_translations` table (→ AL-06)** — system accounts are displayed through i18n keys derived from their `system_key`, custom accounts through the merchant's own text.
- **System accounts (→ AL-07).** Engine semantics are bound to an immutable `system_key` (`cash`, `fx_gain`, `rounding`, `opening_equity`, …) from a closed registry — **not** to the numeric code, because a country pack may legitimately renumber the chart. `UNIQUE (business_id, system_key)` (partial) gives exactly one account per role per business. System accounts may be renamed but **not deleted, not deactivated and not re-coded**, and `system_key` itself is immutable. Merchants can never set `system_key`, so a custom account named "FX Gain" carries no engine meaning. A missing or inactive system account raises `accounting.system_account_missing` — loud, never a silent posting to the wrong account.
- **Merchant-facing?** No. Accounting is internal in Phase 2 (`DAFTAR_ACCOUNTING_RULES.md` header: "داخلية — لا تظهر في واجهة التاجر"). Chart management is a platform/admin capability plus a read-only merchant view behind `accounting.view` (§19). No merchant chart editor ships in Phase 2.
- **Custom accounts** may be added by an authorized principal inside the business's own code space, with a reserved range for system codes so a custom account can never shadow 4900/6900/6100/6200.
- **Deactivation (→ AL-05).** The earlier "cannot deactivate / but hidden from pickers" contradiction is resolved to normal accounting semantics: a **non-system** account with posted history **may** be deactivated. `is_active` is the only flag — "hidden from pickers" is not a separate concept. Deactivation stops **future** posting (refused inside the posting primitive) and changes nothing about history: the account keeps appearing in the trial balance, the general ledger and every historical report. Deleting or re-coding an account with posted lines stays forbidden (`ON DELETE RESTRICT` + BEFORE UPDATE trigger); renaming is allowed and audited; codes are never reused.

---

## 3. Immutable double-entry journal

Two tables, exactly as `DAFTAR_DATA_MODEL.md` §13:

```
journal_entries (id, tenant_id, business_id, entry_date, description,
                 source_type, source_id,                  -- real columns
                 status [posted],                          -- append-only
                 UNIQUE(business_id, source_type, source_id))

journal_lines   (id, tenant_id, business_id, journal_entry_id, account_id,
                 debit_minor BIGINT DEFAULT 0, credit_minor BIGINT DEFAULT 0,
                 CHECK ((debit_minor > 0)::int + (credit_minor > 0)::int = 1),
                 CHECK (debit_minor >= 0 AND credit_minor >= 0))

-- composite FKs:
--   journal_lines(business_id, journal_entry_id) -> journal_entries(business_id, id)
--   journal_lines(business_id, account_id)       -> accounts(business_id, id)
```

Immutability (L-01) is enforced **in the database**, using the pattern Phase 1 already ships for frozen plan versions:

- `BEFORE UPDATE OR DELETE` triggers on both tables raise unconditionally for `status='posted'` rows.
- **No runtime role receives ANY DML on `journal_entries` / `journal_lines` — not even INSERT (→ AL-03).** The earlier `daftar_app → SELECT, INSERT` proposal was withdrawn: a balanced entry inserted directly would still bypass the source registry, the fingerprint, the audit row, the outbox row and the FX checks. The only physical writer is the narrow SECURITY DEFINER primitive `accounting_post_entry(...)`; runtime roles hold `SELECT` plus `EXECUTE` on that one function.
- `entry_date` is the **accounting date** (a `DATE` in the business's calendar); `created_at` is the wall clock. They are different facts and are never conflated.
- Only status `posted` exists in Phase 2. There is no draft journal. A fact is either posted or it does not exist. (A `draft`/`void` state machine is a later decision, recorded in §36.)

**Entry-level FX/description metadata** that `DAFTAR_MULTI_CURRENCY.md` §5 requires — `transaction_currency`, `transaction_amount_minor`, `exchange_rate NUMERIC(20,10)`, `exchange_rate_source`, `exchange_rate_time`, `base_amount_minor` — lives on the **line** where the foreign-currency amount lives, because a single entry may touch two foreign sides (`DAFTAR_ACCOUNTING_RULES.md` §5.1). See §12.

---

## 4. Journal entries and lines — field contract

| Field | Rule |
|---|---|
| `tenant_id`, `business_id` | NOT NULL on **both** tables (`DAFTAR_DATA_MODEL.md` §1: no sub-table exception). RLS policies identical in shape to `catalog_identifiers` (tenant membership permissive + business isolation restrictive). |
| `entry_date` | NOT NULL, `DATE`. Must fall inside an open period (§16). |
| `description` | Short, non-localized internal text. Human-readable narrative for auditors; never parsed. |
| `source_type` | NOT NULL, from a closed enum-like registry in `@daftar/domain-core` (§5). No free strings. |
| `source_id` | NOT NULL `UUID`. The identity of the originating business fact. |
| `status` | NOT NULL, `'posted'` only in Phase 2. |
| `actor_kind` / `actor_user_id` / `actor_system_key` (→ AL-04) | Replaces `posted_by_user_id`. A CHECK admits exactly two shapes: `user` (user id set, system key NULL) or `system` (system key set from a closed registry, user id NULL). **No fake user is ever invented.** The Phase 2 registry is seeded empty, so every Phase 2 posting is a `user` actor. The identity comes from the **verified assertion** (→ AL-03) and from nowhere else — not a DTO, not a GUC, not a caller-controlled argument. Membership is checked as defence in depth, never as the proof of identity. |
| `request_id` | The correlation id already carried by Phase 1 logging, stored for audit joins. |
| `journal_lines.line_no` | Stable ordering within an entry, so golden tests can assert lines **literally** (GOLD-28 requires line-by-line equality, not just a balance check). |
| `journal_lines.account_id` | Composite FK to `accounts(business_id, id)` — a cross-business account is a foreign-key error, not a policy question (L-07). |
| `debit_minor` / `credit_minor` | `BIGINT`, XOR CHECK, non-negative. A zero-amount line is illegal by the XOR. |
| `memo` | Optional per-line note. |
| Dimensions | `branch_id`, `warehouse_id` — nullable FKs, §9. |
| FX snapshot | `txn_currency`, `txn_amount_minor`, `fx_rate NUMERIC(20,10)`, `fx_rate_source`, `fx_rate_at`, `base_amount_minor` — §12. |

Indexes designed up front (reads in §24): `(business_id, entry_date)`, `(business_id, source_type, source_id)` (the unique), `journal_lines(business_id, account_id, journal_entry_id)`, and `journal_lines(business_id, branch_id)` when branch reporting lands.

---

## 5. Posting engine

One entry point, one shape, no alternatives:

```
post({
  businessId, tenantId,
  sourceType, sourceId,          // identity of the business fact
  entryDate,
  description,
  lines: [{ accountCode|accountId, debitMinor?|creditMinor?, branchId?, warehouseId?, memo?, fx? }],
  actor,                         // resolved server-side
}) -> { entryId, created: boolean }
```

Rules:

1. **Transactional.** The engine posts **inside the caller's transaction**. It never opens its own connection, never commits on the caller's behalf. A domain that writes an invoice and posts its entry does both or neither — the same discipline `outbox.test.ts` already proves for business events in Phase 1.
2. **Balanced or refused.** The engine validates Σdebit = Σcredit in base minor units before INSERT and the database re-validates at COMMIT (§6). Two independent checks, deliberately redundant.
3. **Closed source registry.** `sourceType` must be a member of a registry in `@daftar/domain-core`. Phase 2 registers only what Phase 2 can produce: `opening_balance`, `manual_adjustment`, `reversal`, `period_close` (if §16 lands the close entry). Later phases extend the registry in their own migration + contract change; an unregistered `sourceType` is rejected.
4. **No account code invention.** Lines address accounts by code resolved against the business's own chart. An unknown or inactive code fails the posting.
5. **Return, don't throw, on replay.** A second post of the same `(business_id, source_type, source_id)` returns the existing entry with `created: false` (§23).
6. **No partial writes.** Entry + lines + outbox event + audit record are one statement group in one transaction.
7. **Caller supplies facts, engine supplies arithmetic.** FX conversion, rounding distribution and realized-FX line generation are engine responsibilities (§12–14) so two callers can never compute them differently.
8. **No reads of operational tables.** The engine knows accounts, entries, lines, periods and rates. It must not join invoices, stock or customers — that coupling is what makes a ledger un-portable.

---

## 6. Debit = credit at the database boundary

- **Two deferred constraint triggers, not one (→ AL-02).** A line-only trigger never fires when a transaction inserts an entry with **zero** lines, so raw SQL could commit a phantom entry. Phase 2 therefore installs a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on **`journal_entries`** (fires for the entry row itself, closing the zero-line hole) **and** one on `journal_lines` (catches later tampering), both calling one validation routine that evaluates the whole entry at COMMIT. Deferral is required either way: lines are inserted one by one and the entry is momentarily unbalanced mid-transaction.
- The trigger raises a **stable machine code with safe identifiers only** (`accounting.entry_unbalanced` plus the entry id) — never a generic 500, and **never the debit/credit sums** (→ AL-02): a database exception propagates into driver logs where the observability redaction rules cannot be re-applied.
- The balance is checked on **base-currency** amounts (`DAFTAR_MULTI_CURRENCY.md` §7.3). Foreign-currency line amounts are informational; only base amounts balance.
- Phase 1's failure-injection discipline applies: a test proves that raw SQL inserting an unbalanced entry through `daftar_app` **fails at COMMIT**, not merely that the service refuses it.
- The same routine refuses an entry with **fewer than two lines**, an entry whose lines reference more than one `business_id` or `tenant_id`, an entry whose status is not `posted`, an entry with no source binding (→ AL-01), and an entry whose FX arithmetic does not hold (→ AL-09). Sums are computed in `NUMERIC`, never `bigint` (→ AL-10).
- **Two separate test matrices, not one (→ AL-02, corrected).** Claiming cases A–G "run as all six roles" was misleading: under AL-03 no runtime role holds journal DML, so the attempt fails at permission checking and never reaches the invariant. **Matrix 1** proves the privilege boundary for every role; **Matrix 2** exercises invariants A–H through the schema owner. A P2-S2 PASS requires both.
- **Errors carry stable codes and safe identifiers only (→ AL-02).** No debit/credit sums, amounts, rates or balances in exception messages — a database exception reaches driver logs where `DAFTAR_OBSERVABILITY.md` redaction cannot be re-applied. Diagnostic sums are available only through an authorized internal reconciliation path.

---

## 7. `source_type` / `source_id` idempotency

- `UNIQUE(business_id, source_type, source_id)` on `journal_entries`, columns real (never expression/partial), per `DAFTAR_DATA_MODEL.md` §13 and INV-ACC-07.
- The pair is the **business fact's identity**, not a request id: two different HTTP requests describing the same fact collapse to one entry; one request describing two facts posts two entries.
- **Bidirectional binding registry (→ AL-01, corrected twice).** First correction: later phases cannot add composite FKs onto `journal_entries.source_id`, because one UUID column cannot carry several conditional FKs. Second correction: a source-side FK alone is **one-way** — it restricts deleting the *journal* row, not the source row, and proves nothing about entries that have no source. The model is therefore `accounting_source_bindings (business_id, source_type, source_id) ↔ journal_entries`, with a `PRIMARY KEY` on the source triple, `UNIQUE (business_id, journal_entry_id)`, and mutually `DEFERRABLE INITIALLY DEFERRED` FKs in **both** directions so either row may be written first and both are verified at COMMIT.
- **Source identity lives in `accounting_source_bindings` (→ AL-01, corrected).** Every posted entry has exactly one binding row, linked in **both** directions by mutually `DEFERRABLE` foreign keys verified at COMMIT: the binding references the entry, and `journal_entries (business_id, source_type, source_id)` references the binding. An orphan entry is therefore impossible, not merely unlikely. `journal_entries.source_id` itself still carries no FK. Phase 2 detail tables (`accounting_manual_adjustments`, `accounting_opening_balances`, `accounting_reversals`) reference the binding, so deleting a detail row cannot destroy the identity or the journal link; binding rows are undeletable by every role.

---

## 8. Business and tenant ownership

- Every accounting table: `tenant_id UUID NOT NULL`, `business_id UUID NOT NULL`, composite FK `(tenant_id, business_id) -> businesses(tenant_id, id)` so the pair can never disagree (the Phase 1 `0035` ownership-implication pattern).
- RLS enabled **and forced** on every accounting table, with the two-policy shape Phase 1 uses:
  - permissive `tenant_membership`: `app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = <t>.business_id AND b.tenant_id::text = app_tenant())`
  - restrictive `business_isolation`: `app_bypass() OR business_id::text = app_business()`
- Grants (→ AL-03): `daftar_app` → `SELECT` on entries/lines/bindings/accounts **plus `EXECUTE` on `accounting_post_entry`**; **no `INSERT`, `UPDATE` or `DELETE` on the journal or the bindings to anyone**; `daftar_worker` → `SELECT` for reconciliation and read-model rebuild; `daftar_platform` → `SELECT` plus chart management; `daftar_identity`, `daftar_resolver`, `daftar_provisioner` → **nothing**.
- **Authorization is a signed command assertion, not a GUC (→ AL-03, security-critical correction).** `app_tenant()` / `app_business()` are **caller-settable**: a stolen `daftar_app` credential can set any tenant/business and name a genuinely active member, so GUC scope plus membership verification proves nothing. `accounting_post_entry` therefore derives tenant, business and actor from an **HMAC-signed Accounting Command Assertion** minted by the merchant API after authentication, RBAC and branch-scope checks, and verified in the database against `accounting_assertion_keys` — a table with no grants at all. The assertion binds version, kid, actor, tenant, business, operation kind, source type, source id, **posting fingerprint**, expiry and jti, and is single-transaction with cross-transaction replay protection. A stolen database credential alone cannot post. A fully compromised merchant API process holds the minting key and **can** — that larger boundary is stated honestly in AL-03 rather than implied away.
- `db-privileges.test.ts` and static guard 13 already fail the build if merchant runtime code reaches the platform pool; Phase 2 extends the privilege test with the accounting tables rather than adding a parallel mechanism.

---

## 9. Branch and location dimensionality

- `journal_lines.branch_id` and `journal_lines.warehouse_id`: **nullable**, composite FK to `(business_id, id)` of the Phase 1 branch/warehouse tables.
- Nullable is deliberate: a business-level entry (opening balance, FX revaluation) has no branch. Making the dimension mandatory would force a fake "head office" branch — a data lie.
- Dimensions are **reporting attributes only**. They never affect the balance rule, never partition the chart, and never gate a posting. A branch is not a separate ledger in Phase 2.
- Phase 1's branch-scope RBAC (`member.branch_scope.manage`, `mode/branchIds`) governs who may **read** branch-filtered financial reports; it does not create per-branch balances.
- Whether a future phase needs branch-level trial balances as a first-class concept is an open decision (§36), not a Phase 2 assumption.

---

## 10. Fixed-decimal money rules

- `Money = { amount_minor: BIGINT, currency: ISO4217 }` (`DAFTAR_MULTI_CURRENCY.md` §3), already implemented in `@daftar/domain-core` and guarded by static guard 6b and the 18-digit money tests Phase 1 ships.
- Every money column is `BIGINT` minor units + an explicit currency (or the business base currency where the column is definitionally base). **No `NUMERIC` money column, no float, no `Number` round-trip.**
- The existing BigInt→Number prohibition extends unchanged: serialization uses the contract's string encoding; Android uses `BigDecimal` (`MoneyTest.kt`).
- `minor_units` comes from the currency registry (ILS/TRY/USD/EUR = 2, JOD = 3, LBP/SYP per registry). Every golden includes at least one 3-decimal currency and one large-magnitude currency (`DAFTAR_MULTI_CURRENCY.md` §9).
- Quantities and unit costs are **not** money and keep their `NUMERIC(18,4)` / `NUMERIC(28,10)` shapes — but the moment a quantity becomes an amount it is converted to integer minor units with the documented rounding (§13) and the remainder is accounted for, never dropped.
- A static guard is added: no accounting source file may contain a floating-point literal in a money path, and no accounting column may be declared `REAL`/`DOUBLE PRECISION`/`MONEY`.

---

## 11. Base currency authority

- Base currency is a **Business** property, not a tenant property (`DAFTAR_MULTI_CURRENCY.md` §4). Phase 1 already sets it from the country pack with a validated registry (`business-locale.test.ts`), and the server is the authority.
- Phase 2 makes base currency **effectively immutable**: once a business has one posted journal entry, changing it is refused at the database level (a trigger, not a service check). Changing it earlier remains possible through the existing settings path.
- A formal re-denomination migration is explicitly **out of scope** and recorded in §36.
- Every balance, every report and every balance check is expressed in base currency. There is no "multi-base" reporting in Phase 2.
- The base currency of the business is snapshotted onto each entry (`base_currency` column) so a report of historical entries is readable even if a future migration ever changes it.

---

## 12. FX snapshot design

Per-line snapshot, because one entry can legitimately carry two different foreign sides (`DAFTAR_ACCOUNTING_RULES.md` §5.1, §6):

| Column | Meaning |
|---|---|
| `txn_currency` | Currency the fact happened in. Equals base currency for domestic lines. |
| `txn_amount_minor` | Amount in `txn_currency` minor units. |
| `fx_rate NUMERIC(20,10)` | `txn_currency → base` rate used. `1.0` exactly for domestic lines. |
| `fx_rate_source` | `'manual'` (default, §14) or a provider identifier. **NOT NULL.** |
| `fx_rate_at` | Timestamp the rate is attributed to. **NOT NULL.** |
| `base_amount_minor` | The posted amount; equals `debit_minor` or `credit_minor`. |

Rules:

1. **Frozen at posting** (INV-ACC-05). The snapshot columns are covered by the same immutability trigger as the rest of the line. A historical report re-reads the stored rate and never recomputes (`DAFTAR_MULTI_CURRENCY.md` §7.1).
2. **`NUMERIC(20,10)` everywhere** — never float, never a narrower numeric (`DAFTAR_MULTI_CURRENCY.md` §6). The rate converts; all final arithmetic is integer minor units.
3. **No single-rate model.** A settlement that touches two currencies carries both sides, with the historical carrying rate on the released side (`invoice_historical_to_base_rate` / `source_carrying_base_amount_released` in the Phase 4 shape) and the settlement rate on the cash side. Phase 2 provides the **line-level primitives** these later structures snapshot into; it does not implement allocations.
4. **Direct cross-currency comparison is forbidden** (INV-ACC-09). Comparison and capping always happen either in base currency or in the source's own currency — never one against the other. The engine exposes no API that would allow it: amounts are always accompanied by their currency and the type system refuses a bare minor-unit comparison across currencies.
5. **Rate table.** `fx_rates (tenant_id, business_id, from_currency, to_currency, rate NUMERIC(20,10), source, effective_at, entered_by_user_id, UNIQUE(business_id, from_currency, to_currency, effective_at))` — a history, append-only, never a mutable "current rate" row. Lookup is "the latest effective rate at or before the fact's timestamp"; a missing rate is an explicit, actionable failure, never an implicit `1.0`.

---

## 13. Rounding policy

- Rounding mode: **HALF_EVEN**, applied only at conversion boundaries (`DAFTAR_MULTI_CURRENCY.md` §3).
- **Range and overflow (→ AL-10).** Domain cap `MAX_MONEY_MINOR = 10^18` on every line amount and every API-accepted amount, by column CHECK and by contract validation — roughly 9.2× below the `BIGINT` limit so aggregates cannot approach it. FX conversion multiplies in unbounded JS `BigInt` (rate carried as an integer scaled to 10 decimals); intermediates never reach the database. Money crosses the wire as a decimal **string**; a JSON number for a money field is rejected. `SQLSTATE 22003` maps to `accounting.amount_out_of_range`.
- **6100 Rounding Adjustment receives arithmetic rounding differences only.** It is never a dumping ground: FX differences go to 4900/6900 and purchase-price differences to 6200. Mixing them violates INV-ACC-12 and is caught by golden tests.
- **Residual distribution.** When an amount is split across N lines (allocation of a total to components), the engine distributes the integer remainder deterministically across the lines so `Σ lines = total` **exactly** — the discipline GOLD-45 already specifies for COGS. Only a residual that cannot be distributed within the entry's own lines reaches 6100, and its magnitude is bounded by the line count. A rounding line larger than that bound is a bug and fails a test, not a silent posting.
- Every posting that generates a 6100 line records **why** in the line memo and in the audit record. An unexplained rounding line is not acceptable.
- Rounding is never applied twice to the same amount (no round-then-round). Conversion happens once, at posting, and is frozen.

---

## 14. Realized FX foundation

- Accounts **4900 Realized FX Gain** and **6900 Realized FX Loss**, seeded as system accounts per business.
- Phase 2 ships the **primitive**: given a carrying base amount released and the actual base amount moved, the engine computes `realized = actual − carrying` and emits a 4900 (gain) or 6900 (loss) line so the entry balances — the exact arithmetic of `DAFTAR_ACCOUNTING_RULES.md` §5.1, §6, §9.3.
- The primitive is **unit- and golden-tested in Phase 2 against the worked Phase 0 examples** using synthetic `manual_adjustment` sources, so the arithmetic is proven before any invoice exists: the 360/369/−9 refund case (§5.1), the 1480/1440/+40 settlement case (§6), and the 1554/1480/−74 and 1470/1400/−70 partial-consumption cases (§5.2, INV-ACC-17).
- **Unrealized FX revaluation is out of scope** for Phase 2 and recorded in §36. Only realized differences post.
- The engine refuses to post a realized-FX line to any account other than 4900/6900, and refuses to post a rounding residual to them — enforced by the posting helper's signature, not by reviewer vigilance.

---

## 15. Opening balances

- A dedicated source: `opening_balances (id, tenant_id, business_id, as_of_date, status [draft|posted], created_by, posted_at, UNIQUE(business_id) WHERE status='posted')` with `opening_balance_lines`.
- A business gets **at most one posted opening balance**. It is the only entry allowed to predate the first open period.
- Posting it produces one journal entry with `source_type='opening_balance'`, whose balancing account is **3000 Equity / Opening**. The merchant supplies asset/liability positions; the engine computes the equity plug and posts it explicitly as a line — never as an invisible adjustment.
- **Draft then post.** The opening balance may be edited freely while `draft`. Once posted it is immutable like any other entry; a correction is a reversal + a new correcting entry (§21), never an edit.
- Opening balances in foreign currency carry the same per-line FX snapshot (§12), with `fx_rate_source='manual'` and `fx_rate_at = as_of_date`.
- A business with no opening balance is valid (it started from zero). The absence is an explicit state, not a NULL to guess at.

---

## 16. Periods and status

- `accounting_periods (id, tenant_id, business_id, starts_on, ends_on, status [open|closed], closed_by, closed_at, UNIQUE(business_id, starts_on))`, non-overlapping, contiguous, monthly by default.
- **Posting into a closed period is refused at the database level** (a trigger on `journal_entries` checking `entry_date` against the period table), not only in the service. A closed period is a financial fact, so a raw-SQL insert must fail too.
- Closing a period is a domain command: it locks the period row, verifies the period's entries balance, writes an audit record and emits an outbox event. Phase 2 does **not** implement year-end income-statement closing entries (revenue/expense → equity) — that requires a retained-earnings policy decision, recorded in §36.
- **Reopening** a closed period is a separate, audited, permission-gated command (`accounting.period.reopen`, sensitive). It is allowed in Phase 2 — a company that cannot reopen a mistakenly closed month is worse off than one that can, provided every reopen is recorded and every entry posted afterwards is visible as post-close activity.
- **Placement (→ AL-14): periods are NOT in the first implementation slice.** They are slice **P2-S6**, conditional on confirmation. `journal_entries.entry_date` ships in P2-S2 and the AL-02 validation routine is the documented plug-in point, so adding periods later needs **no journal schema change**. When periods land they become the authoritative posting-date gate.
- **The arbitrary 10-year floor is withdrawn (→ AL-14).** It had no accounting authority and would reject a legitimate opening position for a company older than the window. Date rules are now **source-specific**, all evaluated in the business's own timezone: `opening_balance` — **no lower bound**, it may predate onboarding by any amount; `manual_adjustment` — back-dating permitted and audited; `reversal` — not earlier than the entry it reverses. **Future-dated posting is forbidden for every source** (`entry_date ≤ today`). The policy is data on `accounting_source_types`, so a new source declares its rule rather than editing the primitive.

---

## 17. Reconciliation foundation

A worker job (the Phase 1 worker runtime, not a new process), daily, read-only, alerting — **never correcting** (`DAFTAR_ACCOUNTING_RULES.md` §11: "اختلاف → Alert — لا تصحيح صامت").

Phase 2 checks:

| Check | Assertion |
|---|---|
| Entry balance | No posted entry where Σdebit ≠ Σcredit (base). Should be impossible; verified anyway. |
| Global balance | Σ all debits = Σ all credits per business. |
| Trial balance identity | Assets + Expenses = Liabilities + Equity + Revenue, per business, per period. |
| Read-model drift | Every materialized balance equals its journal-derived value (§27). |
| Orphan lines | No line without an entry; no line whose account belongs to another business (should be FK-impossible). |
| Period integrity | No posted entry dated inside a closed period after its close timestamp, except those carrying an audited reopen. |
| Source registry | No posted entry with an unregistered `source_type`. |
| FX snapshot completeness | No line with a foreign `txn_currency` and a NULL rate, source or timestamp. |

Each check that finds a discrepancy raises an alert carrying business id, check name and the offending ids — and **fails the reconciliation golden test** if seeded deliberately (GOLD-23 already requires a planted-discrepancy test).

---

## 18. Audit requirements

- Every domain command (post, reverse, correct, close period, reopen period, post opening balance, seed/modify chart, enter FX rate) writes an `audit_logs` row through the Phase 1 audit module — the same table, the same tenant/business CHECK + FK (migration `0035`), no parallel audit mechanism.
- Recorded: actor user id, effective role set, business id, command, target ids, `request_id`, timestamp, and the **before/after that matters** (for append-only entries: the created ids and totals; there is no "before").
- **Reads of financial data are audited too** where they are privileged: a platform/support principal reading a business's ledger records an access log entry, exactly as support sessions already do in Phase 1.
- Audit records are written **in the same transaction** as the effect. An effect without its audit row is impossible by construction, and a test proves the rollback case.
- No money value, rate, or account balance is ever written to an application log at info level; structured logs carry ids and counts (`DAFTAR_OBSERVABILITY.md` redaction rules).

---

## 19. RBAC permissions

New permission keys added to the `PERMISSIONS` registry in `@daftar/domain-core` (the single registry Phase 1 established; no parallel list):

| Permission | Grants |
|---|---|
| `accounting.view` | Read chart, entries, trial balance, GL, balances. Ordinary. |
| `accounting.post` | Post a manual adjustment / opening balance through the API. **Sensitive (→ AL-16 — upgraded: it creates financial truth).** |
| `accounting.reverse` | Post a reversal of an existing entry. **Sensitive.** |
| `accounting.chart.manage` | Add/rename/deactivate accounts within the business's own chart. **Sensitive.** |
| `accounting.fx.manage` | Enter or correct an FX rate. **Sensitive.** |
| `accounting.period.manage` | Close a period. **Sensitive.** Registered only in P2-S6 (→ AL-14) — the registry ships no dead keys. |
| `accounting.period.reopen` | Reopen a closed period. **Sensitive.** Registered only in P2-S6. |

Rules:

- `accounting.reverse`, `accounting.period.reopen`, `accounting.chart.manage`, `accounting.fx.manage` join `SENSITIVE_PERMISSIONS`.
- The Phase 1 **delegation ceiling** applies unchanged: no member may grant a permission they do not themselves hold, and owner authority remains role **identity** from trusted persistence, never a boolean on a request object.
- **Engine-initiated postings** (a later domain posting a sale) are authorized by the *domain* permission (e.g. `sale.create`), not by `accounting.post`. `accounting.post` is strictly the manual path. Otherwise every cashier would need ledger rights.
- Default roles: `owner` gets everything; `accountant` (a new system role, or an owner-defined role — decided at implementation, recorded either way) gets view/post/reverse/period.manage; no existing Phase 1 role silently gains financial authority.

---

## 20. Outbox integration

- Every posting emits an outbox event **in the same transaction** as the entry, through the existing `outbox_events` table and `OutboxPublisher` — no new queue, no new publisher (`outbox.test.ts` is the existing proof of the atomicity contract).
- Event types: `accounting.entry.posted`, `accounting.entry.reversed`, `accounting.period.closed`, `accounting.period.reopened`, `accounting.opening_balance.posted`.
- Payloads carry **ids, not money**: business id, entry id, source type/id, entry date, line count. A consumer that needs amounts reads them under its own authorization. This keeps the outbox free of financial data that would then live in a second, unauthorized place.
- Delivery stays at-least-once with the existing backoff and dead-lettering; consumers must be idempotent, as the publisher's contract already states.
- Read-model updates (§24) consume these events **or** are rebuilt from the journal directly; either way the journal remains the only truth (L-11).

---

## 21. Reversal and correction strategy

- **No edit. No delete. Ever.** (L-01, L-08.)
- A correction is a new entry with `source_type='reversal'` and `source_id = <the original entry id>`, whose lines are the original lines with debit and credit exchanged, at the **original base amounts and original FX snapshots** — never recomputed at today's rate (the explicit rule of `DAFTAR_ACCOUNTING_RULES.md` §5.2: "ممنوع إعادة الحساب بسعر اليوم").
- The unique `(business_id, source_type, source_id)` makes **double reversal structurally impossible**: a second reversal of the same entry collides on the unique index.
- **The link lives in `accounting_reversals`, not on the original entry (→ AL-12).** A `reversed_by_entry_id` column on the original was rejected: writing it would mutate a posted entry and contradict law L-01. "Is this entry reversed?" is answered by a join, never by a flag on the original. The unique source key `(business_id, 'reversal', original_entry_id)` makes a second reversal physically impossible.
- A reversal of a reversal is refused. A correcting entry after a reversal is an ordinary new posting with its own source.
- Reversal requires `accounting.reverse`, a mandatory non-empty `reason`, and an audit record. A reversal into a closed period is refused; reopen first (§16), visibly.
- The **operational** reversal semantics of Phase 0 (`reverse_payment_allocation` vs `payment_reversal`, INV-ACC-18) are **not** Phase 2 work. Phase 2 guarantees only that both can be expressed as distinct source types with distinct entries — which §30 verifies by constructing both journals against the engine's API.

---

## 22. Concurrency

| Race | Control |
|---|---|
| Two requests posting the same fact | Unique `(business_id, source_type, source_id)`; the loser catches the violation and returns the existing entry (§23). No advisory lock needed for the common path. |
| Concurrent period close and posting | The close command takes `SELECT … FOR UPDATE` on the period row; posting takes a `FOR SHARE` read of it. A posting cannot slip in between the close's validation and its commit. |
| Concurrent chart mutation and posting | Account deactivation takes `FOR UPDATE` on the account row and refuses when posted lines exist; posting reads the account `FOR SHARE`. |
| Concurrent opening-balance posting | Partial unique index `UNIQUE(business_id) WHERE status='posted'`. |
| Concurrent FX rate entry | Unique `(business_id, from, to, effective_at)`; rates are append-only, so a duplicate is a no-op, not a conflict to resolve. |
| Read-model update races | Updates are derived, ordered by entry id, and **idempotent**; the nightly rebuild is authoritative over any incremental drift. |
| Deadlocks | A fixed lock ordering is documented and enforced by review: period → account → entry. Serialization failures are retried once at the request boundary, as Phase 1 already does. |

Every row above gets a real concurrency test in the style of the existing `concurrency-matrix.test.ts` — two real connections, real contention, not a mocked race.

---

## 23. Posting idempotency

- **Key:** `(business_id, source_type, source_id)`. Not the HTTP `Idempotency-Key`, which is a *transport* concern; the two coexist.
- **Behaviour (→ AL-11, corrected):** every entry stores a `posting_fingerprint` — SHA-256 over a canonical serialization of the **financial content only** (business, source, date, and the ordered lines with account key, side, base amount, currency, rate, branch, warehouse). Description, memos, request id, actor and timestamps are deliberately excluded, so a retry that differs only in narrative is the same fact. On unique violation the primitive re-reads the existing entry and **compares fingerprints**: identical → `{ entryId, created: false }` with no second audit row and no second outbox event; different → `accounting.idempotency_conflict` (HTTP 409) carrying the existing entry id. Returning the old entry as success for materially different financial content is the most dangerous failure mode a ledger API can have, and is explicitly refused.
- **Replay across transactions** is safe because the uniqueness lives in the database, not in a cache.
- The manual API path additionally honours the Phase 1 `Idempotency-Key` header so a retried HTTP request does not create a second *manual adjustment source*, mirroring the Android retry contract (`RetryContractTest.kt`).
- Idempotency is proven by test at three levels: same transaction, two sequential transactions, two concurrent transactions.

---

## 24. Financial read models

- Read models are **derived and rebuildable**. Dropping every read model and rebuilding from `journal_lines` must reproduce them byte-for-byte; a golden test does exactly that (L-11).
- Phase 2 ships three: trial balance (§25), general ledger (§26), account balances (§27).
- **Implementation choice, decided at implementation time and recorded:** start with direct aggregate queries over `journal_lines` with the indexes of §4. Materialize only when the performance gate (§34) shows a real need — a materialized balance that nobody needed is just another thing to drift.
- If materialization lands, it is a table with a `rebuilt_at` watermark, updated in the posting transaction **and** rebuilt nightly, with the reconciliation check of §17 comparing the two.
- No read model is ever writable through an API. There is no endpoint that sets a balance.

---

## 25. Trial balance

- Per business, per date range (or as of a date), per currency = base only.
- Columns: account code, name, type, total debit, total credit, net balance in the account's normal direction.
- **Must balance**: Σdebit = Σcredit across the whole report. The endpoint asserts this and returns an explicit error rather than an unbalanced report — an unbalanced trial balance is an incident, not a view.
- Optional filters: period, branch (§9), account type, include/exclude zero-activity accounts.
- Golden tests assert the trial balance **line by line** against hand-computed expectations for the Phase 0 worked examples, not merely that totals match.

---

## 26. General ledger

- Per business, per account, per date range: opening balance, then each line in `(entry_date, entry id, line_no)` order with running balance, then closing balance.
- Every row carries its `source_type`/`source_id` so a number is always traceable to the fact that caused it (L-09).
- Foreign-currency lines display transaction amount, rate and base amount from the frozen snapshot — never a recomputation.
- Pagination is keyset (not OFFSET) so a long ledger stays fast and stable under concurrent posting.
- The opening balance of a range is computed from the journal, not from a stored number, unless a materialized balance exists and reconciles (§24).

---

## 27. Account balances

- `balance(account, as_of)` = Σ debits − Σ credits over lines up to and including `as_of`, signed by the account's normal direction for presentation only.
- Exposed as a read API for the (internal) dashboard and for later domains that need a figure — always with its `as_of`, never as a bare number.
- **Never writable.** There is no "set balance" path, no adjustment column, no cached total that can be edited (`DAFTAR_SOURCE_OF_TRUTH_MATRIX.md`: "أرصدة الحسابات = Σ أسطر القيود؛ لا رصيد يدوي").
- A balance query for an account of another business is not "empty" — it is a 404/authorization failure, so cross-business probing yields no information.

---

## 28. Migration plan

Phase 2 migrations begin at **`0040`**. Migrations `0000`–`0039` are frozen and are never edited (`PHASE_1_MIGRATION_HISTORY_DECISION.md`, `npm run check:migrations`). **This closure task itself adds no migration**; every number below is a Phase 2 proposal that exists only after approval.

Migration numbers are **reserved per slice** (§0). No slice may use a number reserved for a later one.

| # | Slice | Migration | Contents |
|---|---|---|---|
| 0040 | P2-S1 | `accounting_chart` | `accounts` (+ `system_key`), system-key registry, RLS, grants, seeding routine + `businesses` AFTER INSERT trigger, **backfill for every existing business with a hard completeness assertion** (→ AL-07, AL-08). |
| 0041 | P2-S1 | `accounting_permissions` | Accounting permission keys and their sensitivity flags (→ AL-16). |
| 0042 | P2-S2 | `accounting_journal` | `journal_entries`, `journal_lines`, `accounting_source_types`, `accounting_source_bindings`, the mutually deferred bidirectional FKs, XOR + non-negative + FX-completeness CHECKs, actor CHECK, immutability triggers, RLS (→ AL-01, AL-04, AL-09). |
| 0043 | P2-S2 | `accounting_invariants` | Deferred constraint triggers on **both** tables, the shared validation routine, and the REVOKE shape that leaves no runtime role any DML. **No writer function and no EXECUTE grant in this slice** (→ AL-02, AL-18). |
| 0044 | P2-S3 | `accounting_assertion_keys` | Assertion key table with no grants at all, install/retire commands granted to `daftar_platform` only, `accounting_actor()` verification (→ AL-03). |
| 0045 | P2-S3 | `accounting_post_entry` | The narrow SECURITY DEFINER writer, fingerprint handling, audit + outbox, **and the single `GRANT EXECUTE` to `daftar_app`** (→ AL-03, AL-11, AL-17). |
| 0046 | P2-S4 | `accounting_sources` | `accounting_manual_adjustments`, `accounting_reversals`, each referencing the binding registry plus its own deletion guard (→ AL-01, AL-12). |
| 0047 | P2-S4 | `accounting_opening_balances` | Opening-balance source tables, partial unique on `status='posted'`, the guarded `posted → superseded` transition (→ AL-13). |
| 0048 | P2-S5 | `accounting_fx_rates` | `fx_rates` append-only history + lookup function (→ AL-09). |
| 0049 | P2-S6 | `accounting_periods` | **Only if P2-S6 is confirmed** (→ AL-14). Period table, non-overlap exclusion constraint, closed-period check added to the existing validation routine — no journal schema change. |
| 0050 | P2-S7 | `accounting_report_indexes` | Reporting indexes, only if measurement requires them. |
| — | P2-S8 | none | Materialized read models only if the performance dataset proves the need (→ AL-15). |

Rules carried from Phase 1, unchanged:

- Every migration is **expand → migrate → contract**, with the destructive step at least two releases after the expand step (`0036` is the worked example).
- Every migration re-runs as a **no-op** on an already-migrated database; `scripts/db-from-zero.ts` proves roles → migrate → re-migrate → verify → tamper-rejected on every gate run.
- Every migration is added to the manifest with its SHA-256 in the same commit; an unmanifested migration fails the release gate.
- The upgrade matrix gains a new checkpoint (pre-0040 → latest) in `migration-upgrade.test.ts`.
- **No `0040` may be created under the closure task.** If Phase 2 design reveals a Phase 1 schema defect, it is documented and escalated, not patched under cover of a Phase 2 migration.

---

## 29. API boundaries

Two surfaces, both internal in Phase 2:

**Internal (in-process) — the posting engine.** `@daftar/accounting` exposes `post()`, `reverse()`, `balance()`, `trialBalance()`, `ledger()`. Later domains depend on this package, not on tables. Static guard 15 (new): no module outside `@daftar/accounting` may write SQL referencing `journal_entries` or `journal_lines`.

**HTTP (merchant/admin) — narrow and read-dominant.**

| Method | Path | Permission |
|---|---|---|
| GET | `/businesses/:id/accounting/accounts` | `accounting.view` |
| GET | `/businesses/:id/accounting/entries` (keyset, filters) | `accounting.view` |
| GET | `/businesses/:id/accounting/entries/:entryId` | `accounting.view` |
| GET | `/businesses/:id/accounting/trial-balance` | `accounting.view` |
| GET | `/businesses/:id/accounting/ledger` | `accounting.view` |
| GET | `/businesses/:id/accounting/balances` | `accounting.view` |
| POST | `/businesses/:id/accounting/adjustments` | `accounting.post` |
| POST | `/businesses/:id/accounting/entries/:entryId/reversals` | `accounting.reverse` |
| POST | `/businesses/:id/accounting/opening-balance` | `accounting.post` |
| POST | `/businesses/:id/accounting/periods/:periodId/close` | `accounting.period.manage` |
| POST | `/businesses/:id/accounting/periods/:periodId/reopen` | `accounting.period.reopen` |
| POST | `/businesses/:id/accounting/fx-rates` | `accounting.fx.manage` |

Contract rules from Phase 1 hold without exception: DTOs live in `@daftar/shared-contracts` and are the **only** source for web and Android; list responses are `{ items }`; no `{ok:true}` DTO; money is encoded as minor-unit strings + currency; branch scope is `mode/branchIds`; every mutation accepts `Idempotency-Key`; every error carries the request id. The golden web/admin contract tests (`06-web-contract`, `07-admin-contract`) are extended mechanically, not replaced.

**No merchant UI ships in Phase 2** beyond a read-only internal view, consistent with accounting being internal. Any screen beyond that is a Phase 3+ decision.

---

## 30. Test strategy

Phase 2 inherits the Phase 1 harness unchanged: vitest with embedded PostgreSQL, one fork, real database, no mocked adapters, no fake providers.

| Layer | Content |
|---|---|
| Unit (`@daftar/accounting`, `@daftar/domain-core`) | Balance arithmetic, minor-unit conversion, HALF_EVEN rounding and residual distribution, realized-FX computation, normal-balance derivation, source registry validation, permission evaluation for the new keys. Large magnitudes and 3-decimal currencies in every money test. |
| Integration | Posting inside a caller transaction; rollback leaves no entry, no outbox row, no audit row; replay returns the existing entry; closed-period refusal at the DB; immutability triggers; chart seeding on business creation; period close/reopen; FX rate lookup; read-model rebuild equals live aggregation. |
| Security | RLS proof per accounting table (a second business's rows invisible and un-writable); `daftar_app` denied UPDATE/DELETE on entries and lines; identity/resolver/provisioner denied everything; cross-business account id refused by FK; permission matrix per endpoint including the delegation ceiling; a support principal's ledger read audited. |
| Golden | §33. |
| Performance | §34. |
| Android | No Phase 2 Android surface; the money contract tests stay green as a regression guard. |

**Engine-shape validation (required, Phase 2, no operational tables).** Every worked journal in `DAFTAR_ACCOUNTING_RULES.md` — §4.7 partial return, §5.1 cross-currency refund, §5.2 A/B/C allocation reversals, §5.2ب chargeback, §6 tri-currency settlement, §7 A/B void, §9.1/9.2/9.3 supplier returns and PPV — is posted through the engine using `manual_adjustment` sources and asserted **line by line**. This proves the engine can express every future domain's journal *before* those domains exist, which is the whole point of building accounting first. It creates no invoice, payment, supplier or inventory table.

Every defect found during Phase 2 gets a permanent regression test, continuing the `PHASE_1_REGRESSION_REPORT.md` R-numbering.

---

## 31. Security strategy

- **Threat model additions** to `DAFTAR_THREAT_MODEL.md`: forged posting (a client dictating the actor or the account), cross-business posting, ledger tampering through a compromised app role, replay of a posting request, information disclosure through balance probing, privilege escalation through a self-granted accounting permission, closed-period back-dating.
- **Controls:** actor resolved server-side only (the Phase 1 provisioning-assertion lesson generalizes — never trust a caller-settable value for authority); account addressed by code resolved inside the business; grants withhold UPDATE/DELETE from every role; RLS forced; period trigger in the database; unique source key; delegation ceiling; audit on every command and on privileged reads.
- **Red-team tests (mandatory, in the style of `provisioner-boundary.test.ts`):** direct SQL attempts as each of the six roles to update a posted line, delete an entry, insert an unbalanced entry, insert a line referencing another business's account, back-date into a closed period, and read another tenant's ledger. Each must fail **inside the database**, not merely at the service.
- **ASVS mapping** extended in `PHASE_1_ASVS_MAPPING.md`'s successor for the new endpoints.
- No security control may be weakened to make a test pass. Where a control makes a test hard, the test changes.

---

## 32. Failure-injection strategy

Extending `failure-injection.test.ts`:

| Injected failure | Required behaviour |
|---|---|
| Crash between entry insert and outbox insert | Transaction rolls back; no entry, no event. |
| Outbox sink outage | Entry stays posted; event retries with backoff; dead-letters after 8 attempts; never lost. |
| Worker crash mid-reconciliation | Next run repeats cleanly; reconciliation is read-only so partial work is harmless. |
| Migration failure mid-`0041` | Transactional migration rolls back; `db-from-zero` still passes from scratch. |
| Unbalanced entry forced through raw SQL | COMMIT fails with `accounting.entry_unbalanced`. |
| Concurrent duplicate posting | Exactly one entry; the other returns the existing one. |
| FX rate missing at posting time | Explicit, actionable failure; no implicit `1.0`, no partial entry. |
| Period closed between validation and commit | Posting fails; no entry. |
| Read-model store unavailable | Reports fall back to live aggregation or fail loudly; they never serve a stale number as current. |
| Database connection lost mid-posting | No entry; the caller's whole transaction rolls back. |

---

## 33. Golden regression strategy

- The Phase 0 golden suite already enumerates the accounting cases (GOLD-21, 23, 26, 27, 28, 40, 41, 42, 43, 44, 45, 46, 47, 48, 50, 54–59, 61, 62, 65–71, 73, 79–84, 86, 87). Phase 2 implements the **subset expressible without operational tables** as engine-shape goldens (§30) and leaves the rest registered as pending for the phase that owns their source.
- Goldens assert **expected journal lines literally** — account code, side, amount, currency, rate — never "the entry balances" alone (GOLD-28's explicit requirement).
- New Phase 2 goldens: chart seeding completeness per country pack; opening-balance equity plug; period close/reopen audit trail; reversal produces exactly the mirrored lines at the original rates; double reversal refused; read-model rebuild equality; trial balance balances for every worked example.
- Goldens run in the release gate as their own step, as they do today.

---

## 34. Performance strategy

Baseline first, then budget. `PHASE_1_PERFORMANCE_BASELINE.md` is the comparison point; the same harness (`tests/perf/phase1-baseline.test.ts` extended, same machine class, same reporting) produces the Phase 2 numbers.

| Operation | Budget (p95) |
|---|---|
| `post()` of a 2–6 line entry inside an existing transaction | ≤ 15 ms |
| Manual adjustment endpoint end-to-end | ≤ 60 ms |
| Trial balance, 100k lines, one period | ≤ 500 ms |
| General ledger page (50 rows, keyset), 100k lines | ≤ 150 ms |
| Account balance as-of | ≤ 100 ms |
| Reconciliation daily job, 1M lines, one business | ≤ 5 min |

Budgets are measured against a seeded dataset generated by a committed script, not against a hand-made fixture. Missing the budget is a Phase 2 defect, not a reason to materialize blindly — the cause is diagnosed first (§24).

---

## 35. Rollback strategy

- **Code rollback**: the accounting module is additive. Reverting the application to the previous release leaves the tables in place and unread. No later domain depends on it during Phase 2, so the blast radius is bounded by construction.
- **Schema rollback**: the expand/contract discipline means no Phase 2 migration drops or narrows a Phase 1 column. Rolling the *application* back across `0040`–`0046` is safe because Phase 1 code never reads those tables.
- **Data rollback is not a thing.** Posted entries are never deleted, including by a rollback. If a release posted wrong entries, the remedy is reversal entries (§21) under the normal audited path — the ledger records that the mistake happened and that it was corrected. That is the correct behaviour, not a limitation.
- **Rollback rehearsal** is part of the Phase 2 gate: restore a pre-0040 dump, apply migrations, run the suite, roll the app back, confirm Phase 1 behaviour is unaffected.
- The `PHASE_1_MIGRATION_HISTORY_DECISION.md` rollback boundary table gains a Phase 2 section.

---

## 36. Observability

Extending `DAFTAR_OBSERVABILITY.md`:

- **Structured logs** on every command: `request_id`, business id, command, source type/id, entry id, line count, duration. **No amounts, no rates, no balances in logs** — the redaction rule is unchanged and tested.
- **Metrics**: postings per minute by source type; posting duration histogram; idempotent-replay counter; unbalanced-rejection counter (should be zero — a non-zero value is an alert); reversal counter; period close/reopen counter; reconciliation check results; outbox lag for accounting events.
- **Alerts**: any reconciliation discrepancy; any unbalanced-entry rejection reaching the database trigger (it means the service check was bypassed); dead-lettered accounting event; reconciliation job not completing.
- **Traces** carry the accounting span inside the caller's transaction span so a slow posting is attributable to the domain that triggered it.
- **Readiness** per process mode is unchanged; the worker reports the last successful reconciliation timestamp.

---

## 37. Conflicts, deferrals and open decisions

Recorded rather than resolved silently, per the directive.

| # | Item | Disposition |
|---|---|---|
| C-01 | Phase 0 documents describe accounting together with sales, payments, refunds, inventory and suppliers. | **Scope split, not a contradiction.** Phase 2 builds the engine and the primitives; INV-ACC-02/03/04/10/13/14/15/16/17/18 are enforced by the phases that create their sources (Phase 3 inventory/suppliers, Phase 4 sales/payments/refunds). §30's engine-shape goldens prevent the split from becoming a design divergence. |
| C-02 | `DAFTAR_IMPLEMENTATION_ROADMAP.md` previously bundled accounting + inventory + sales + POS as "Phase 2 — Money Core". | Superseded by the normalized 16-phase map; the old map is preserved in that file's historical section. |
| C-03 | Unrealized FX revaluation (period-end retranslation of foreign balances). | **Out of scope for Phase 2.** Only realized differences post. Needs a policy decision before any phase implements it. |
| C-04 | Year-end closing entries (revenue/expense → retained earnings) and a retained-earnings account. | **Out of scope for Phase 2.** Requires a fiscal-year and retained-earnings policy decision. |
| C-05 | Draft / unposted journal entries. | **Not in Phase 2** — posted is the only status. Opening balances have their own draft state on their own source table. |
| C-06 | Base-currency re-denomination migration for a business that already posted. | **Forbidden in Phase 2** (trigger-enforced). A formal migration procedure is a separate decision. |
| C-07 | Branch-level trial balances as a first-class concept. | Dimensions are reporting attributes in Phase 2 (§9). First-class per-branch books are a later decision. |
| C-08 | `source_id` has no composite FK for source types whose tables do not exist yet. | **Superseded by AL-01.** The earlier wording promised future FKs on `journal_entries.source_id`, which is not implementable. `source_id` now carries no FK by design; `source_type` carries a real FK to a closed registry; each source table owns a deferred composite FK to the entry from its own side. |
| C-09 | Materialized read models. | Deferred pending the performance gate (§34). Live aggregation first. |
| C-10 | OD-11 (manual vs provider FX rates). | Settled for Phase 2 by §38: manual is the default and the only implemented source; a provider is optional and must never become a dependency. |
| C-11 | Merchant-facing accounting UI. | None in Phase 2 beyond an internal read-only view; accounting is internal by `DAFTAR_ACCOUNTING_RULES.md`. |
| C-12 | An `accountant` system role vs owner-defined roles. | Decided at implementation; whichever is chosen is recorded in `DAFTAR_OPEN_DECISIONS.md` with its rationale. |

---

## 38. FX rate sourcing (directive §14)

- **Manual rate entry is the default and the only source implemented in Phase 2.** A merchant or accountant enters the rate; the server stores it with `source='manual'`, the entering user and the effective timestamp.
- An **external provider is optional**, later, and must never become a runtime dependency: if a provider is configured and unavailable, manual entry still works and posting still succeeds. A provider outage may never block the books.
- **Every posted foreign-currency transaction preserves the rate snapshot and its metadata** — rate, source, timestamp — frozen at posting (§12). Historical reports read the stored rate; nothing is ever re-derived from a current rate.
- A rate is never inferred, never defaulted to `1.0` for a foreign currency, and never silently carried forward past its effective window without that being visible in the snapshot.

---

## 39. Acceptance gates for Phase 2

Phase 2 is PASS only when **every** row holds, with generated evidence, in both the repository and an extracted release archive — the same two-run discipline Phase 1 used.

| # | Gate |
|---|---|
| A-01 | All Phase 1 gates still PASS. Nothing in Phase 2 weakened a Phase 1 control, test or contract. |
| A-02 | Migrations `0040`+ manifested, frozen, no-op on re-run, `db-from-zero` green, upgrade matrix extended. |
| A-03 | `journal_entries` / `journal_lines` immutable: UPDATE and DELETE refused at the database for every role, proven per role. |
| A-04 | Unbalanced entry impossible: refused by the service **and** by the deferred trigger at COMMIT, proven by raw SQL. |
| A-05 | `UNIQUE(business_id, source_type, source_id)` proven idempotent in the same transaction, in sequential transactions and under real concurrency. |
| A-06 | Cross-business and cross-tenant posting impossible: FK + RLS + policy, proven per role. |
| A-07 | Every worked journal in `DAFTAR_ACCOUNTING_RULES.md` reproduced line by line through the engine (§30). |
| A-08 | Realized FX, rounding and PPV never mixed (INV-ACC-12), proven by golden. |
| A-09 | Money integer-only end to end; static guards extended; no float, no `Number`, no `NUMERIC` money column. |
| A-10 | Closed-period posting refused at the database; reopen audited; period close audited. |
| A-11 | Opening balance: at most one posted per business; equity plug explicit; immutable once posted. |
| A-12 | Reversal mirrors original lines at original rates; double reversal refused; reason and audit mandatory. |
| A-13 | Read models rebuildable: drop and rebuild reproduces live aggregation exactly. |
| A-14 | Trial balance balances for every scenario; an unbalanced report is an error, not a view. |
| A-15 | Reconciliation detects every planted discrepancy and corrects nothing. |
| A-16 | Every command audited in the same transaction as its effect; no money or rate in application logs. |
| A-17 | RBAC: new permissions in the single registry, sensitive ones flagged, delegation ceiling holds, endpoint matrix proven. |
| A-18 | Outbox event emitted in the posting transaction; rollback leaves no event; payload carries no amounts. |
| A-19 | Red-team suite: every direct-SQL tamper attempt fails inside the database. |
| A-20 | Failure-injection matrix (§32) fully green. |
| A-21 | Performance budgets (§34) met on the seeded dataset, recorded as a Phase 2 baseline. |
| A-22 | Rollback rehearsal executed and recorded. |
| A-23 | Release gate PASS in the repository and from the extracted archive, with generated evidence, zero skips. |
| A-24 | Bug budget: P0 = P1 = security P2 = 0; every defect found has a permanent regression test. |
| A-25 | Documentation: accounting rules, data model, source-of-truth matrix, golden suite, open decisions, technical debt and the roadmap all updated to match what shipped — no document claims a behaviour the code does not have. |

---

## 40. What Phase 2 must NOT do

Inventory. Purchases. Suppliers. Sales. Invoices. POS. Customers. Receivables. Payments. Debts. Installments. Credit notes. Refunds. Returns. Ecommerce. Orders. Storefront. Offline sync. WhatsApp. AI. CRM. Loyalty. SaaS billing.

Also: no rewrite of a working Phase 1 module, no broad refactor, no change to a frozen migration, no weakening of RLS or grants to make a query convenient, no `@ts-ignore`, no disabled or skipped test, and no new phase scope invented in code instead of in the roadmap.
