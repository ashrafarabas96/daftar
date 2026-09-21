# DAFTAR — P2-S1 Acceptance / قبول الشريحة الأولى من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S1 — Chart of Accounts, system account registry, atomic seeding, accounting permissions**. It states what is now *enforced by a mechanism and covered by a test*, what is *precedent* (the mechanism exists and is proven, but for something else), and what remains *specified only*. It authorizes nothing: P2-S2 begins when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S1. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. لا شيء في دفتر القيود (journal) مُنفَّذ في هذه الشريحة.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Base accepted P2-S0 head: `3b1d2e23baf754d6a1a133f4d9a890f5a0d11e22`
- Phase 1 baseline: `2e01dbab3df2cf112cb0a7d5ac827a5578c61b81`

## 1. Candidate migrations — not yet frozen

| migration | SHA-256 |
|---|---|
| `0040_accounting_chart.sql` | `84aac994c1d7958db0532c27b26ee64473df5a5dc0a1a361e465276efc07c915` |
| `0041_accounting_permissions.sql` | `3aea7eedfd6ccb9d8fd93ed827d84abaa9923ccd3b01497960237098c19b1f77` |

`MIGRATION_MANIFEST.json` is **unchanged**: `frozenThrough` is still `0039_catalog_identifiers_owner_integrity.sql` and the two files above are absent from it. That is deliberate (directive §3, §30) — a defect found during independent review can be corrected in place instead of consuming a P2-S2 migration number. Freezing them is a separate, explicit instruction after acceptance. The P2-S1 gate **fails** if either file is frozen early, and `tests/integration/accounting-guards.test.ts` asserts the same.

Migrations `0000`–`0039` are byte-for-byte unchanged (40 manifest hashes verified). No `0042` or later file exists.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **PRECEDENT** | the mechanism the rule will reuse is built and tested, but for something other than this rule |
| **SPECIFIED** | written in a binding document; nothing in code or CI enforces it |

## 3. What P2-S1 moved to ENFORCED

| property | mechanism | test |
|---|---|---|
| The 21 system identities are a closed registry, and `system_key` — not the code, not the name, not the UUID — is the engine identity | `accounting_system_account_keys` with a 21-row assertion inside `0040`; `accounts.system_key` is nullable and references it | `accounting-chart.test.ts` "registry holds exactly the 21 Phase 2 identities"; `phase2-s1-gate.ts` re-derives the list statically |
| A system key can never be attached to the wrong account type | composite FK `accounts (system_key, type) → accounting_system_account_keys (system_key, account_type)`; `MATCH SIMPLE` leaves custom accounts (NULL key) free to take any valid type | `accounting-chart.test.ts` "wrong account type (composite FK)" and "custom account may take any valid type" |
| One account per system identity per business | partial `UNIQUE (business_id, system_key) WHERE system_key IS NOT NULL` | case G |
| One code per business | `UNIQUE (business_id, code)` | case H |
| An account cannot claim tenant A while belonging to a business of tenant B | composite FK `(tenant_id, business_id) → businesses (tenant_id, id)` (the `0016` unique constraint) | case I |
| A system account cannot be deleted, re-keyed, un-keyed, re-coded, re-typed or deactivated — and **no** principal is exempt, platform bypass included | `accounts_protect_system()` BEFORE UPDATE OR DELETE trigger | cases J, K, L, M, N, O |
| A system account **can** be renamed; the name is presentation only | same trigger allows `name` | case P; plus "an idempotent re-run never overwrites a rename" |
| A custom account can never be promoted into an engine identity | same trigger refuses NULL → non-NULL `system_key` | `accounting-chart.test.ts` "custom account cannot be promoted" |
| Every existing business was backfilled, and the migration rolls back rather than finishing incomplete | `0040` backfill loop + an independent completeness assertion + a duplicate-identity assertion | `migration-upgrade.test.ts` P2-S1 §25 checkpoint (parked at `0039`, two tenants, two businesses) |
| Every **new** business gets its chart in the same transaction as the business row, without editing a frozen provisioning migration | `businesses_seed_chart` AFTER INSERT trigger → `accounting_seed_chart()` (SECURITY DEFINER, owner `daftar_accounting_internal`, pinned `search_path`, PUBLIC EXECUTE revoked, no EXECUTE grant to any login role) | case S, and the same check through the real HTTP onboarding path |
| A failure while seeding destroys the business creation rather than leaving a chart-less business | the trigger raises inside the caller's transaction | case T, using a transaction-local failure-injection trigger; **no production test-only switch exists** |
| Seeding is idempotent and concurrency-safe | `pg_advisory_xact_lock(hashtext(business), hashtext('ACCOUNTING_CHART'))` + set-wise `INSERT ... WHERE NOT EXISTS` | case R |
| A conflicting chart fails loudly instead of being "repaired" | three explicit pre-checks in `accounting_seed_chart()`: inactive required account, foreign tenant row, required code already owned | "no silent repair (§32)" cases |
| Creating a chart is **not** a financial transaction | nothing in `0040`/`0041` reads or writes `businesses.financial_started_at` | case Q, and the §25 upgrade checkpoint asserts it across every business |
| `accounts` carries no authoritative balance column, and CI refuses one being added later — **guard G-3** | `scripts/guards/no-authoritative-balance.ts`, wired as static-guard Rule 15 | `accounting-guards.test.ts` tests the guard itself (accepted and rejected shapes), not only today's schema |
| System accounts localize through i18n keys; there is no `account_translations` table | 21 `accounting.account.*` keys × ar/en/tr; `check:localization` now gates 208 keys × 3 locales | `accounting-guards.test.ts` parity + Arabic-script assertions |
| **No LOGIN runtime principal has direct account DML.** `daftar_app` and `daftar_platform` may read the chart and nothing more; identity, resolver, provisioner and worker hold nothing at all. The only `INSERT` in the system belongs to `daftar_accounting_internal`, which is `NOLOGIN`, has no password and is granted to nobody | grants in `0040`: `daftar_app` SELECT, `daftar_platform` SELECT, `daftar_accounting_internal` SELECT + INSERT (and no `UPDATE`/`DELETE` for anyone) | `tests/security/accounting-boundary.test.ts` — the grant enumeration, a DML-denied matrix and an EXECUTE-denied matrix across all six login roles, plus the `pg_authid` attributes of the internal principal |
| Authority isolation cannot silently regress | `scripts/guards/authority-isolation.ts`, run by `npm run gate:phase2:s1` before any database starts | `tests/integration/accounting-guards.test.ts` — the guard is shown to reject platform INSERT, DML for each of the six login roles, DML for `PUBLIC`, `UPDATE`/`DELETE` for anyone, a routine owned by a login role, EXECUTE left with `PUBLIC` or handed to a login role, an internal principal that gains `LOGIN`/a password/`BYPASSRLS`/`SUPERUSER`/`CREATEROLE`/`CREATEDB`/`CONNECT`/membership, and any attempt to widen `app_bypass()` |
| Business isolation on the chart | `ENABLE`/`FORCE ROW LEVEL SECURITY` + the Phase 1 two-policy pattern (permissive tenant membership + RESTRICTIVE business isolation) | `accounting-boundary.test.ts`: cross-business read, unscoped read, RLS flags, policy tamper attempts |
| The five non-period accounting permissions are registered, four of them sensitive | `packages/domain-core/src/permissions.ts`; `0041` backfills owner roles only | `domain-core.test.ts` P2-S1 block; `accounting-permissions.test.ts` through the real onboarding flow |
| No period permission is registered or persisted anywhere | absent from `PERMISSIONS`; `0041` raises if any row holds one | `domain-core.test.ts`, `accounting-permissions.test.ts`, and the `0041` assertion itself |
| No existing member gains financial authority | `BUILTIN_ROLE_PERMISSIONS.manager` / `.cashier` untouched; `0041` writes owner rows only and raises if a non-owner role holds an accounting key | `accounting-permissions.test.ts`; the `0041` overreach assertion |
| P2-S1 exposes no accounting HTTP surface | no controller, no route | `accounting-permissions.test.ts` "NO accounting HTTP mutation surface (§20)" — POST/PATCH/DELETE all 404 |

## 4. What is still PRECEDENT

| property | what exists | what is missing |
|---|---|---|
| Delegation ceiling over accounting permissions | `beyondGrantAuthority()` is Phase 1 code, now exercised with accounting keys | nothing — but the ceiling protects *granting*, and there is no accounting command to exercise yet |
| Audit of chart changes (AL-05 "every change audited") | `audit.service.ts` `recordTx` is live and proven | no chart-change command exists in P2-S1, so there is nothing to audit yet. It lands with the first account command |

## 5. What remains SPECIFIED — do not cite these as protection

Everything about the journal. `journal_entries`, `journal_lines`, `accounting_source_types`, `accounting_source_bindings`, `accounting_post_entry`, Accounting Command Assertions, the canonical fingerprint and its in-database recomputation, balance validation at COMMIT, reversal, opening balances, FX snapshots and rounding, accounting periods, the trial balance and the general ledger: **none of it exists**. AL-01, AL-02, AL-03, AL-04, AL-09 through AL-14, AL-17 and AL-18 are unchanged by this slice, and guards **G-1**, **G-2** and **G-4** are not in CI.

`accounting_resolve_system_account()` and the `accounting.system_account_missing` error named in AL-07 are **not** implemented: they are posting-time concerns and belong with the engine, not with the chart. The reserved code range that would stop a custom account shadowing `4900`/`6900` is likewise absent, because P2-S1 ships no account-creation path at all (directive §9).

## 6. Decisions recorded by this slice

**C-12 — no built-in `accountant` role.** The role topology stays `owner` / `manager` / `cashier`. Accounting authority is composed through the existing custom-role flow, under the unchanged delegation ceiling. Reasons: no role proliferation before a real accounting workflow exists; the custom-role system already composes these permissions; onboarding's role topology should not change prematurely; and `manager`/`cashier` must not silently acquire financial authority. Recorded in `DAFTAR_OPEN_DECISIONS.md` as **OD-18** and in `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` §37 C-12.

**Chart write authority belongs to an internal, unreachable principal.** `daftar_platform` is a LOGIN runtime role: a stolen platform password is a credential someone can actually hold. Platform administration is not financial configuration authority, so the chart's physical `INSERT` was moved off it entirely.

`bootstrap.sql` creates `daftar_accounting_internal` — `NOLOGIN`, `NOINHERIT`, no password, no `CONNECT`, granted to nobody, and none of `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS`. It holds exactly `SELECT businesses`, `SELECT accounting_system_account_keys`, `SELECT, INSERT accounts` and `USAGE` on the schema, and it owns both seeding routines. Its authority is therefore reachable only from inside `accounting_seed_chart()`, which is itself reachable only from the `businesses` AFTER INSERT trigger and from the migration — never from a connection, because no connection as that role can be opened.

RLS stays real for it: `app_bypass()` is **unchanged**, no `BYPASSRLS` is granted anywhere, and the seeder is admitted by two narrow identity policies (`accounting_seeder` on `accounts`, `accounting_seeder_read` for `SELECT` on `businesses`) plus the same identity clause in the `RESTRICTIVE` `business_isolation` policy. Those policies name one identity, and it is not a login role, so no credential reaches them. `UPDATE` and `DELETE` on `accounts` are granted to **nobody**, the internal principal included: it can create a chart and can never rewrite or remove one.

This replaces the earlier arrangement, in which `daftar_platform` owned the routines and held `SELECT, INSERT` on `accounts` on the precedent of `0032`/`0033`/`0038`. Following that precedent was the defect: precedent for provisioning data is not precedent for financial authority, and a grant that a live credential can use is a hole whether or not a test proves the grant exists. `0040` was corrected in place, before freezing; no `0042` was created.

**No `ON DELETE CASCADE` from `accounts` to `businesses`.** Deleting a business that owns a chart now fails. Nothing in the repository deletes a business, and financial history should not disappear as a side effect of a row deletion.

## 7. The slice gate

`npm run gate:phase2:s1` (`scripts/phase2-s1-gate.ts`) refuses the tree when `0040` or `0041` is missing, any `0042+` exists, any Phase 1 migration changed, the P2-S1 migrations were frozen early, any journal/binding/posting surface appeared, the 21-key registry is incomplete or has extras, `account_translations` appeared, guard G-3 is absent or failing, **any LOGIN role holds `INSERT`/`UPDATE`/`DELETE` on the chart, anyone at all holds `UPDATE`/`DELETE` on `accounts`, either seeding routine is owned by a LOGIN role or leaves `EXECUTE` with `PUBLIC`, the internal principal gains `LOGIN`, a password, `BYPASSRLS`, `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `CONNECT` or a member, or the slice touches `app_bypass()`**, or any composed check fails. It composes `check:migrations`, `check:guards`, `check:localization`, `gate:phase1`, the `@daftar/domain-core` unit tests and the five P2-S1 suites rather than duplicating them.

## 8. Defect found and fixed during implementation

`scripts/db-from-zero.ts` refused **any** migration newer than `frozenThrough`, with the message "freeze it in the manifest before release". That check runs on every CI push, not only at release, so it made a candidate migration impossible mid-phase — contradicting the manifest's own stated policy ("New migrations ... are appended to the manifest only at release time", `scripts/check-migration-manifest.ts`) and directive §3, which forbids freezing `0040`/`0041` before acceptance.

Smallest correct fix: the freeze requirement now belongs to **release mode**. `npm run check:db-from-zero` treats a migration past `frozenThrough` as a candidate and still proves it applied exactly once with a history hash equal to the file on disk; `scripts/phase1-release-gate.ts` passes `--release`, which restores the hard refusal, so a release still cannot ship an unfrozen migration. Nothing was disabled, weakened or skipped. A permanent regression test in `tests/integration/accounting-guards.test.ts` fails if the release gate ever stops passing `--release` or if the candidate hash check is removed.

## 9. Hard stop

P2-S1 ends here. No `0042`, no journal table, no binding registry, no assertion key, no posting engine. P2-S2 begins only on an explicit Tech Lead authorization.
