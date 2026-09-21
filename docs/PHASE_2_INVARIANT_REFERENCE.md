# DAFTAR — Accounting & security invariant reference / مرجع الثوابت المحاسبية والأمنية

> **What this is.** One page that states each resolved accounting/security invariant, names where it is enforced, and names the test that covers it. It adds no decisions: `PHASE_2_ARCHITECTURE_LOCK.md` remains the decision record, and this page only reports what the repository actually does today.
>
> **Read the status column first.** Recompiled after slice **P2-S2** landed on `phase/2-accounting-core` (migrations `0042`/`0043`). P2-S1 froze first: `0040` and `0041` are in `MIGRATION_MANIFEST.json` at their accepted hashes and `frozenThrough` is `0041_accounting_permissions.sql`.
>
> **What P2-S2 changed, stated narrowly.** It moved the journal's **structural integrity** from SPECIFIED to ENFORCED: the tables exist, and balance, line count, ownership, FX arithmetic, immutability and bidirectional source binding are now refused by the database at COMMIT rather than by a document. It moved **nothing** about authority. There is still no writer: `accounting_post_entry` does not exist, no principal holds INSERT, UPDATE, DELETE or TRUNCATE on any journal table, and the assertion keys, the fingerprint recomputation, the posting service and the atomic audit/outbox posting path are all still SPECIFIED. A rule that depends on *who may post* cannot be cited as protection today; a rule about *what a posted entry must look like* can.
>
> `0042` and `0043` are **candidate** migrations: they are not in `MIGRATION_MANIFEST.json`, so they may still be corrected in place without consuming P2-S3's numbers.

## Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository enforces it now, and a named test exercises it |
| **PRECEDENT** | the *mechanism* the rule will reuse is built and tested in Phase 1; the accounting rule itself does not exist yet |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

---

## 1. Bidirectional source integrity (AL-01)

**Rule.** Every posted journal entry corresponds to exactly one registered business-fact identity, and that identity cannot disappear afterwards. Enforced by two `DEFERRABLE INITIALLY DEFERRED` foreign keys — `journal_entries → accounting_source_bindings` and back — both verified at COMMIT, both composite on `business_id`; binding rows carry no DML grant to any runtime role and a `BEFORE UPDATE OR DELETE` trigger.

**Status: ENFORCED (P2-S2).** `0042` creates `accounting_source_bindings` and both deferred directions: `accounting_source_bindings_entry_fk` (binding → entry) and `journal_entries_binding_fk` (entry → binding), each composite on `business_id` and each `DEFERRABLE INITIALLY DEFERRED`, so either row may be written first and neither may reach COMMIT alone. `accounting_source_bindings_no_mutation` (`BEFORE UPDATE OR DELETE`) makes the binding unchangeable, and no principal holds DML on it. The registry itself is closed: `source_type` is a foreign key into `accounting_source_types`, which holds exactly `opening_balance`, `manual_adjustment` and `reversal`.

**Tests.** `tests/integration/accounting-journal.test.ts` — Matrix 2 case H (entry with no binding → COMMIT FAIL), the reverse direction (binding with no entry → COMMIT FAIL), both orders inside one transaction passing, a binding pointing at another business's entry refused, a duplicate source identity refused, a second binding for the same entry refused, and an unregistered `source_type` refused. The migration text itself is checked in `tests/integration/accounting-guards.test.ts` ("the source binding keeps both deferred foreign-key directions"), so removing one direction fails CI even before a database starts.

**Honest residual, already admitted in the lock and still unclosed:** proof #3 is physical only for the *binding* row. A domain's *detail* row is protected by a per-table `BEFORE DELETE` trigger plus a registry-completeness test that enumerates `accounting_source_types`. That test is the whole guarantee for every future source type, and it does not exist yet — it should land in the same slice as the first detail table, not later.

## 2. Actor and scope anti-spoofing authority (AL-03, AL-04)

**Rule.** `accounting_post_entry` trusts no GUC, no caller-supplied actor UUID and no client permission claim. Authority comes from a signed Accounting Command Assertion — `v1.<kid>.<actor>.<tenant>.<business>.<operation>.<source_type>.<source_id>.<fingerprint>.<exp>.<jti>.<hmac>` — verified inside the database against `accounting_assertion_keys`, a table with no grants at all. 60-second expiry, single-transaction use, separate key namespace from provisioning. Actor shape is `('user'|'system')` with a CHECK; membership is defence-in-depth, never the proof of identity. Branch scope restricts which `branch_id` a scoped member may put on a line, checked inside the primitive.

**Status: PRECEDENT.** The accounting assertion does not exist. The identical mechanism is live for provisioning:

| piece | where |
|---|---|
| key table readable by nobody | `infrastructure/database/migrations/0038_provisioning_assertions.sql:41`–`:47` (`CREATE TABLE ... ; REVOKE ALL ... FROM PUBLIC`, no grants to anyone) |
| in-database verification | same file, `provision_actor(TEXT[])` at `:80` — HMAC over claims 1–6 at `:107`, expiry at `:120`, single-use `jti` + `pg_current_xact_id()` at `:127` |
| key management restricted to `daftar_platform` | same file `:72`–`:75` |
| minting, API side, 60 s TTL | `apps/api/src/infra/provisioning-assertion.ts` |
| owner authority from role identity, never a request flag | `packages/domain-core/src/permissions.ts` (`trustedRoleSet`, `is_system AND key='owner'`) |

**Tests (Phase 1, passing).** `tests/security/provisioner-boundary.test.ts` — no assertion `:220`; old-GUC spoof `:226`; forged assertion `:234`; tampered actor under a genuine signature `:246`; expired `:255`; wrong operation kind `:262`; cross-transaction replay `:275`; valid assertion but non-owner `:292`; key secrets unreadable by every principal including `daftar_platform` `:352`. Branch scope: `tests/security/branch-scopes.test.ts:124`–`:212`. Owner identity: `packages/domain-core/test/domain-core.test.ts:285`, `:291`.

**Gap to close when AL-03 lands:** Phase 1's assertion binds actor and operation kind. The accounting assertion additionally binds tenant, business, source type, source id and the posting fingerprint, and the primitive must **recompute** that fingerprint from the submitted payload and require equality before any write, refusing with `accounting.assertion_payload_mismatch`. None of that has a test yet, and the payload-mismatch case is the one that cannot be inherited from the provisioning suite: Phase 1 has no equivalent, because provisioning assertions carry no payload hash.

## 3. Writer exposure ordering (AL-18)

**Rule.** Every slice is independently safe. Structural schema may land before its writer; a writer may not land before every verification, binding, fingerprint, audit and outbox protection it depends on. `GRANT EXECUTE` on `accounting_post_entry` happens in exactly one slice (P2-S3), the one where all of them are present. P2-S2 ships the journal tables with the full REVOKE shape and no writer at all.

**Status: SPECIFIED, and honoured once.** Lock AL-18. This is a process rule about commit ordering, so nothing can enforce it mechanically; what *can* be checked is that a released tree never contains a writer without its protections.

P2-S2 is the ordering rule's first real exercise, and it held: the journal tables landed with the full REVOKE shape and no writer at all. That is now checked rather than asserted — `scripts/phase2-s2-gate.ts` fails the slice if any P2-S3 surface (`accounting_post_entry`, `accounting_actor`, `accounting_assertion_keys`, `accounting_assertion_uses`) appears in the migration tree or in `apps/`/`packages/`, and guard G-1 fails it if any principal holds a write privilege on a journal table. What remains unenforced is the *converse* — that a writer never lands without its protections — which is guard G-4's job in P2-S3.

**Tests.** `tests/security/journal-privilege-matrix.test.ts` proves the no-writer state against the live database: no routine is callable by any runtime role or by PUBLIC, and no function body in `pg_proc` writes a journal table. The release gate (`scripts/phase1-release-gate.ts`, `scripts/phase1-gate.ts`) is per-phase and has no equivalent for this rule. The lock now records the missing check as **guard G-4**, due in P2-S3: if `accounting_post_entry` exists in a released tree, its assertion verification, source binding, fingerprint recomputation, audit and outbox must exist too. Until that guard is written, the governing rule remains a habit rather than something CI can refuse.

## 4. Opening balance lifecycle (AL-13)

**Rule.** `draft → posted → superseded`, plus `draft → discarded` (row deleted, no entry ever existed). After `posted`: lines, `as_of_date`, `journal_entry_id` and `id` are immutable; `status` is the only mutable column and only for `posted → superseded`; supersession requires an existing reversal of that opening balance's journal entry (`accounting.supersede_without_reversal` otherwise); the transition is audited in the same transaction; no runtime role holds UPDATE. `CREATE UNIQUE INDEX ... WHERE status = 'posted'` gives exactly one current set per business. The equity plug is an explicit visible line to `opening_equity`.

**Status: SPECIFIED.** Lock AL-13. No table, no trigger, no state machine in code.

**Tests.** None. The lock names eight cases (edit lines after posting, change `as_of_date`, change `journal_entry_id`, supersede without reversal, supersede with reversal, `superseded → posted`, two posted sets, plug line including the zero case).

## 5. Posting-date semantics (AL-14)

**Rule.** Future-dating is forbidden for every source in Phase 2: `entry_date ≤ today` resolved in the business's own timezone (`businesses.timezone`), never the server's. Lower bounds are per source and declared as data on `accounting_source_types`: `opening_balance` — none; `manual_adjustment` — none in Phase 2, back-dating permitted and audited; `reversal` — not earlier than the original entry's date. The `created_at − 10 years` floor is withdrawn. Periods are slice P2-S6 and conditional; when they land they become the authoritative gate.

**Status: PARTLY ENFORCED (P2-S2) — the policy is data, the gate is not built.** `0042` creates `journal_entries.entry_date DATE NOT NULL` and `accounting_source_types` carries the bounds **as data** rather than as branching code: `lower_bound_policy` (`none` | `not_before_origin`) and `upper_bound_policy` (`not_after_today`), both CHECK-constrained, seeded as `opening_balance`/none, `manual_adjustment`/none, `reversal`/`not_before_origin`, with a migration-time assertion that every row refuses future posting. A new source type therefore cannot be added without declaring its date policy.

**Still SPECIFIED:** the enforcement itself. Nothing yet resolves "today in the business's timezone" or rejects an out-of-bounds `entry_date`; that is the posting path's job and it belongs to P2-S3, deliberately not implemented here.

**Tests.** The registry's exactness and its refusal of future posting are covered in `tests/integration/accounting-journal.test.ts` and by the migration's own DO block. The timezone-boundary test the rule really needs still does not exist, because the thing it would test does not exist: it needs a business in a non-UTC zone posting at a boundary hour, not a `date <= now()` assertion.

## 6. Privilege matrix vs invariant matrix (AL-02)

**Rule.** Two separate matrices, and a PASS requires both. **Matrix 1 (privilege):** for each of the six runtime roles, direct INSERT/UPDATE/DELETE on `journal_entries`, `journal_lines` and `accounting_source_bindings` must fail with *permission denied*. **Matrix 2 (invariants):** executed as the schema owner so the constraint itself is exercised — A zero lines, B one line, C unbalanced, D balanced (PASS), E foreign-business account, F DELETE a posted line, G UPDATE a posted line, H entry with no binding. The entry-side deferred constraint trigger is the crux: it fires at COMMIT even when a transaction writes an entry and no lines.

**Status: ENFORCED (P2-S2).** Both matrices exist and both run in CI, as separate suites so that neither can be mistaken for the other.

**Matrix 1** — `tests/security/journal-privilege-matrix.test.ts`. The enumeration the lock asked for: the live catalogue is read twice, once through `information_schema.role_table_grants` and once through `aclexplode(coalesce(relacl, acldefault('r', relowner)))` (the unfiltered form, which sees grants to roles the first view hides), and both are compared against the intended model in `scripts/guards/journal-privilege-model.ts`. Anything present that is not intended fails, and anything intended that is missing fails. Three tamper cases prove the comparator itself notices an added INSERT, a removed SELECT and an opened registry. The hand-written adversarial half stays alongside it: six roles × three tables × three verbs, each expecting *permission denied for table*.

**Matrix 2** — `tests/integration/accounting-journal.test.ts`, executed as the schema owner so the constraint is what refuses, not a grant. A permission error must never be able to masquerade as invariant coverage, which is exactly why the two suites are separate and Matrix 2 runs as the owner.

**Tests (Phase 1, passing).** `tests/security/db-privileges.test.ts` — `daftar_app` bypass flag does nothing `:44`, cross-business read `:57`, cross-business write `:73`, DDL impossible `:84`, RLS cannot be disabled `:92`, revoked grants `:103`–`:146`; `daftar_identity` separation `:178`–`:260`. `tests/security/provisioner-boundary.test.ts:55`, `:66` cover the provisioner's grant shape.

**Managed-PostgreSQL portability (P2-S1).** `0039` → `0040`/`0041` is proven to apply over a `NOSUPERUSER`, `NOBYPASSRLS` migration principal in `tests/integration/migration-portability.test.ts`. Writing that test found that the `0040` backfill would have been a silent no-op under a non-superuser migrator, because `businesses` FORCEs RLS and no policy admits a deployment principal; the backfill now runs under the seeder's own identity. **Still open, recorded not fixed:** `0032`/`0033`/`0038` transfer function ownership to `daftar_platform`, which a non-superuser migrator can only do if that LOGIN runtime role holds `CREATE` on `public` — so the frozen Phase 1 history is not yet portable, and fixing it in place would undo the P2-S1 authority correction. See `docs/PHASE_2_S1_ACCEPTANCE.md` §6.

**Closed in P2-S1 for the chart:** `tests/security/accounting-boundary.test.ts` enumerates `information_schema.role_table_grants` for `accounts` and `accounting_system_account_keys` and asserts the whole shape, and runs a DML-denied and an EXECUTE-denied matrix across all six login roles; `scripts/guards/authority-isolation.ts` refuses the same violations from the migration text before any database starts — extended in P2-S2 with a rule that any write grant on a journal table, to anyone, is a violation.

**Closed in P2-S2 for the journal: guard G-1.** The intended matrix lives as data in `scripts/guards/journal-privilege-model.ts` — `daftar_app`, `daftar_platform` and `daftar_worker` hold SELECT on the three journal tables, `daftar_accounting_internal` holds SELECT so the deferred validators can see a whole entry, `daftar_identity`/`daftar_resolver`/`daftar_provisioner` hold nothing, the two registries are granted to nobody, and no grantee holds any write privilege anywhere. The model is compared against the live catalogue rather than restated in tests, so a `GRANT` added years from now by someone who never read this page still fails CI. `npm run gate:phase2:s2` additionally refuses the model itself if it ever starts describing a writer.

## 7. Fingerprint canonicalization (AL-11)

**Rule.** `posting_fingerprint CHAR(64)` = SHA-256 over canonical bytes `acctfp/1`, never `JSON.stringify()`. Fields `\x1f`-separated, lines `\x1e`-terminated; lowercase canonical UUIDs; account identity = `system_key` else `code:<code>`, never the display name or surrogate id; side `D`/`C`; amounts as bare decimal integers; uppercase ISO-4217; `fx_rate` always 10 fraction digits including `1.0000000000`; `fx_rate_at` RFC 3339 UTC seconds; NULL is the single byte `\x00`; lines sorted by their own serialized bytes; UTF-8. Description, memos, request id, actor and timestamps are excluded as narrative. FX rate, source and timestamp are *inside* the fingerprint, so a changed rate is a conflict, not a silent replay. Idempotency: `UNIQUE (business_id, source_type, source_id)`; identical retry → `created=false`; materially different → `accounting.idempotency_conflict` / HTTP 409, never silent success.

The fingerprint a caller presents is never believed on its own: `accounting_post_entry` recomputes the canonical form from the submitted payload inside the database and requires it to equal the fingerprint the assertion signed, refusing with `accounting.assertion_payload_mismatch` before any write (AL-03). The canonicalization is therefore implemented twice — TypeScript and PL/pgSQL — and the two must agree byte-for-byte.

**Status: the COLUMN and the idempotency key exist (P2-S2); the fingerprint itself is still SPECIFIED.** `0042` adds `posting_fingerprint CHAR(64) NOT NULL` with a `^[0-9a-f]{64}$` CHECK — lowercase hex, structurally — and `UNIQUE (business_id, source_type, source_id)` gives the idempotency key its physical shape. That is all. There is no canonicalizer in either language, nothing recomputes the fingerprint, and the database does not and cannot check that the 64 characters mean anything: a structurally valid fingerprint over the wrong payload is accepted by P2-S2 exactly as a correct one is. The recomputation is the whole protection, and it lands with the writer in P2-S3.

**Tests.** The column's shape is tested in `tests/integration/accounting-journal.test.ts` (uppercase, short and non-hex fingerprints refused). Nothing tests the canonical form, because it does not exist. The lock asks for the five behaviour rows, the concurrent case on two real connections, and a byte-vector suite pinning the canonical form. The byte-vector suite is the load-bearing one: without it a refactor re-hashes history silently and every stored fingerprint becomes unverifiable.

**Related precedent.** Actor-scoped provisioning idempotency, including the "another actor cannot replay or forge" case, is tested at `tests/security/provisioner-boundary.test.ts:317`.

## 8. The FX formula (AL-09)

**Rule.** `fx_rate` means 1 major unit of transaction currency = R major units of base currency. With `rate_scaled = R × 10^10`:

```
numerator   = txn_minor × rate_scaled × 10^max(0, eb − et)
denominator = 10^10 × 10^max(0, et − eb)
base_minor  = HALF_EVEN(numerator / denominator)
```

Half-even by floor-and-remainder comparison (`2r > d`, `2r < d`, `2r = d` → tie to even). No floating point at any step; `BigInt` in TypeScript, `NUMERIC`/`BIGINT` in PostgreSQL, and `ROUND()` is deliberately not used because PostgreSQL rounds half-up and would disagree on ties. Structural completeness is immediate CHECKs on `journal_lines` (exactly one booked side; `base_amount_minor = GREATEST(debit, credit)`; `fx_rate > 0`; domestic lines pinned to `fx_rate = 1` and `fx_rate_source = 'base'`); the arithmetic equality itself is asserted by the deferred validation trigger, because a CHECK may not read `currencies`. Seven pinned vectors, of which cases 5 and 6 are the half-even ties.

**Status: ENFORCED in the database (P2-S2); still SPECIFIED in TypeScript.** `0042` carries the structural half as immediate CHECKs on `journal_lines`: exactly one booked side, `base_amount_minor = GREATEST(debit, credit)` on a domestic line, `fx_rate > 0` declared `NUMERIC(20,10)`, a domestic line pinned to `fx_rate = 1` with `fx_rate_source = 'base'` and no rate timestamp, and a foreign line required to carry the complete snapshot — rate, source and `fx_rate_at` together, never a partial one. `0043` carries the arithmetic: `accounting_assert_entry_valid()` recomputes the expected `base_amount_minor` for every foreign line from both currencies' real exponents in `currencies`, and refuses the entry at COMMIT with `accounting.entry_fx_arithmetic` if the stored value differs by a single minor unit. Half-even is spelled out by quotient and remainder (`2r > d`, `2r < d`, tie → even); `ROUND()` is not used anywhere in `0043`, and `accounting_pow10()` builds its power of ten with `repeat()` rather than `power()` or `^`, both of which return double precision.

**Still SPECIFIED:** the TypeScript side. A search for `HALF_EVEN`, `half-even`, `bankers` or `roundHalf` across `*.ts` still returns nothing, so the "implemented twice and the two must agree" requirement is half met. The database is currently the only implementation, and it is the authoritative one.

**Tests.** `tests/integration/accounting-journal.test.ts` pins seven vectors against a real database — USD(2)→ILS(2), JOD(3)→ILS(2), ILS(2)→JOD(3), a large LBP amount, the half-even tie to an even quotient, the tie to an odd quotient, and `MAX_MONEY_MINOR` at rate 1 — each with an accepting case and a case one minor unit away that must be refused. Six structural cases cover the partial-snapshot and domestic-pinning rules.

**Precedent that does exist.** Exact minor-unit money with no float path: `packages/domain-core/src/money.ts` (BigInt only; `Number` accepted solely when `Number.isSafeInteger`; excess precision throws `PRECISION_OVERFLOW`), `packages/shared-contracts/src/money.ts` (`parseMajorToMinor`, exact decimal string parsing). Tested at `packages/domain-core/test/domain-core.test.ts:89`–`:151` and `packages/shared-contracts/test/money.test.ts:10`–`:77`. Guarded statically by `scripts/static-guards.ts` Rule 6 (money as `number`, `Number()` on minor units, float money columns in SQL) and by `tests/golden-regression/phase1/05-artifact-hygiene.golden.test.ts:48` (P1-GOLD-35).

**One gap closed in P2-S2, one still open:**
- **Closed — guard G-2.** Static-guard Rule 6's SQL check keys off column *names* (`amount|price|total|balance`), so `fx_rate DOUBLE PRECISION` would have passed it untouched. `scripts/guards/no-float-rate.ts` is the rate-shaped half: on the journal, the chart and every `accounting_*` table (matched by prefix, so a future accounting table is watched the day it is created), a column with `rate` as a whole underscore token may not be `REAL`, `FLOAT`, `DOUBLE PRECISION`, bare `NUMERIC`, or `NUMERIC` with a scale under 10. It runs as static-guard Rule 16 and has its own tamper regressions in `tests/integration/accounting-guards.test.ts`, including the negative half: a `conversion_rate` on a campaign or a `tax_rate` on a product is not accounting authority and stays declarable, because a guard nobody can live with is a guard that gets deleted. P2-S5 extends the watch list to the FX rate tables it introduces.
- **Still open.** `MAX_MONEY_MINOR = 10^18` and `assertWithinMoneyRange()` (AL-10) do not exist in TypeScript. `MoneyError` already reserves the `PRECISION_OVERFLOW` code, so this is an addition to an existing type, not a new concept. The database enforces the cap now — `journal_lines` CHECKs every minor-unit column into `0 < amount <= 10^18` — but the application does not.

## 9. Error redaction (AL-02, AL-10)

**Rule.** Commit-time failures raise a stable machine code plus safe identifiers only — never debit/credit sums, amounts, rates or balances: `accounting.entry_unbalanced`, `...entry_too_few_lines`, `...entry_business_mismatch`, `...entry_account_foreign`, `...entry_fx_arithmetic`, `...entry_status_invalid`, `...entry_binding_missing`. The earlier proposal to put the two sums in the message is withdrawn. SQLSTATE `22003` maps to `accounting.amount_out_of_range`, never a leaked driver error. Reconciliation tooling that needs the offending sums gets them through an authorized diagnostic path under the normal redaction and audit rules.

**Status: ENFORCED for the codes P2-S2 raises.** `0043` raises exactly the stable codes above — `accounting.entry_missing`, `...entry_status_invalid`, `...entry_business_mismatch`, `...entry_account_foreign`, `...entry_too_few_lines`, `...entry_base_currency_mismatch`, `...entry_unbalanced`, `...entry_fx_arithmetic`, `...entry_binding_missing` — and none of their messages contains a debit sum, a credit sum, an amount, a rate or a balance. The two immutability codes (`accounting.journal_immutable`, `accounting.binding_immutable`) and `accounting.base_currency_locked` follow the same rule. What is still SPECIFIED is the mapping layer: `22003` → `accounting.amount_out_of_range` at the API boundary, and the authorized diagnostic path that gives reconciliation tooling the offending sums. Both belong to the slice that has a posting API.

The redaction architecture this builds on:

| piece | where |
|---|---|
| stable code + requestId + safe details; no SQL text, stack traces or class names | `apps/api/src/common/error.filter.ts` |
| PostgreSQL codes mapped to safe contracts (`23503`, `23505`, `42501`, `P0001`) | same file, bottom half |
| structured logger redacts by path, censor `[redacted]` | `apps/api/src/infra/logger.ts:7`–`:21` |
| no token/secret passed to a logger | `scripts/static-guards.ts` Rule 11 |

**Tests.** `tests/integration/accounting-journal.test.ts` posts a deliberately unbalanced entry and asserts the message carries `accounting.entry_unbalanced` and neither of the two sums involved; and posts a deliberately wrong FX conversion and asserts the message carries `accounting.entry_fx_arithmetic` and the line number, but not the booked amount, the transaction amount or the rate. `tests/integration/auth.test.ts:147` — error responses never leak secrets, SQL or stack traces.

**Documentation gap, and it matters for this rule specifically.** AL-02 justifies the no-financial-values rule by citing `DAFTAR_OBSERVABILITY.md`. That document says logs carry no secrets and no sensitive data with redaction (line 5); it does **not** say financial values are forbidden in logs or exception messages. The logger's redact paths likewise cover token/secret/password-shaped keys, not amounts. So the rule AL-02 leans on is not actually written down anywhere binding, and nothing tests it. Either add the sentence to `DAFTAR_OBSERVABILITY.md` and a guard alongside static-guard Rule 11, or stop citing the observability document as the authority.

---

## Supporting invariants, same treatment

| rule | authority | status | enforced by | test |
|---|---|---|---|---|
| Zero-line / one-line / unbalanced entry impossible at COMMIT | AL-02 | **ENFORCED** (P2-S2) | `0043`: two `DEFERRABLE INITIALLY DEFERRED` constraint triggers — `journal_entry_validate` on entries and `journal_line_validate` on lines. The entry-side one is the crux: a transaction that writes an entry and no lines touches no line trigger at all, so line-only validation would pass it | `accounting-journal.test.ts` Matrix 2 A–D |
| Posted entries and lines immutable (triggers **and** absent grants, deliberately redundant) | AL-02, AL-03 | **ENFORCED** (P2-S2) | `0042`: `BEFORE UPDATE OR DELETE` triggers on entries, lines and bindings, with no identity test inside them — the platform role, the migration credential and the schema owner are refused exactly as an application would be; plus the absent grants | `accounting-journal.test.ts` Matrix 2 F–G, and a case that runs as the schema owner after asserting `rolsuper` is true, so the "no admin bypass" claim is tested rather than assumed |
| Account lifecycle: delete forbidden, `code`/`system_key` immutable, deactivation allowed, system accounts stricter | AL-05 | **ENFORCED** (system accounts) | `0040` `accounts_protect_system()` BEFORE UPDATE OR DELETE trigger — no principal is exempt, not even the platform bypass | `tests/integration/accounting-chart.test.ts` cases J–P |
| `system_key` is the engine's identity, never the code or the name | AL-07 | **ENFORCED** | `0040`: `accounting_system_account_keys` closed registry, composite FK `accounts (system_key, type) → (system_key, account_type)`, partial `UNIQUE (business_id, system_key)`, immutability trigger, and `system_key` writable only by the seeding routine | `accounting-chart.test.ts` (registry exactness, wrong-type FK, G/K/L, custom-account promotion refused) |
| No `account_translations`; system accounts localized by i18n key from `system_key` | AL-06 | **ENFORCED** | 21 `accounting.account.*` keys in `apps/web/src/messages/{ar,en,tr}.json`; `scripts/check-localization.ts` now gates 208 keys × 3 locales; no `account_translations` table exists | `tests/integration/accounting-guards.test.ts` (parity, Arabic-script check, absence of the table) |
| Chart seeding by `AFTER INSERT` trigger on `businesses` + `0040` backfill that fails the migration if incomplete | AL-08 | **ENFORCED** | `0040`: `accounting_seed_chart(uuid)` (SECURITY DEFINER **owned by `daftar_accounting_internal`** — a `NOLOGIN`, passwordless principal no runtime role may assume; its only member is the deployment migrator, `WITH INHERIT FALSE` — pinned `search_path`, advisory xact lock, loud on conflict, no silent repair) + `businesses_seed_chart` trigger + a backfill block that RAISEs and rolls the migration back | `accounting-chart.test.ts` S and T (same-transaction chart; injected failure kills the whole business creation); `migration-upgrade.test.ts` P2-S1 §25 checkpoint |
| Money: BIGINT minor units, cap `10^18`, sums in `NUMERIC`, minor units as a JSON string never a number | AL-10 | **ENFORCED in the database** (P2-S2); PRECEDENT in TypeScript (`assertWithinMoneyRange` still missing) | `0042`: every minor-unit column is `BIGINT` with a `0 < amount <= 10^18` CHECK; `0043` casts each side to `NUMERIC` before summing, so four lines at the cap cannot overflow the sum before the balance check runs. `packages/domain-core/src/money.ts`, static-guard Rule 6 | `accounting-journal.test.ts` (cap accepted, cap + 1 refused, and the four-lines-at-the-cap case that a `BIGINT` sum would overflow); `domain-core.test.ts:89`–`:151`, `money.test.ts`, P1-GOLD-35 |
| Reversal is a new entry, `source_type='reversal'`, `source_id = original entry id`; second reversal physically impossible; mirror lines at the **original** FX snapshot; original row never touched | AL-12 | SPECIFIED | — | planned |
| No materialized balances; `accounts` carries no balance column; no cached balance is authoritative | AL-15 | **ENFORCED** for `accounts` (guard G-3) | `scripts/guards/no-authoritative-balance.ts`, run as static-guard Rule 15; `accounts` has no balance column | `accounting-guards.test.ts` tests the GUARD itself, not just today's schema. Extends to read-model tables in P2-S7 |
| `accounting.post`, `.reverse`, `.chart.manage`, `.fx.manage` are sensitive; default deny; delegation ceiling; no permission grants direct DML | AL-16 | **ENFORCED** for the five non-period keys | `packages/domain-core/src/permissions.ts` (`PERMISSIONS`, `SENSITIVE_PERMISSIONS`); `0041` backfills the owner role only; **no LOGIN runtime role holds any DML on `accounts`** — the single `INSERT` belongs to the `NOLOGIN` principal `daftar_accounting_internal`, and nobody at all holds `UPDATE` or `DELETE` | `domain-core.test.ts` P2-S1 block; `tests/integration/accounting-permissions.test.ts` (real onboarding path); `tests/security/accounting-boundary.test.ts` (grant shape) |
| Entry → lines → audit → outbox in one transaction; no asynchronous step decides whether the ledger commits; outbox payloads carry ids only, never amounts | AL-17 | PRECEDENT | `apps/api/src/modules/audit/audit.service.ts` (`recordTx` / `emitTx` both take the caller's `PoolClient`), `apps/api/src/modules/outbox/publisher.ts` | `tests/integration/outbox.test.ts:26` (atomicity), `:41` (exactly once), `:66` (backoff then dead-letter), `:87` (idempotent consumer); `tests/integration/failure-injection.test.ts:60`, `:90`, `:121`, `:135` |
| Migrations `0000`–`0041` frozen byte-for-byte | Phase 1 directive; P2-S1 freeze §6 | ENFORCED | `infrastructure/database/MIGRATION_MANIFEST.json` (`frozenThrough` = `0041_accounting_permissions.sql`), plus `scripts/phase2-s1-gate.ts`, which carries the two accepted P2-S1 hashes as an independent second source so one commit cannot move a migration and its recorded hash together | `scripts/check-migration-manifest.ts`, `scripts/verify-migration-history.ts`, `tests/integration/migration-upgrade.test.ts`, `accounting-guards.test.ts` ("P2-S1 migration freeze") |
| Every business-owned accounting table proves same-Business membership physically | AL-02 | **ENFORCED** (P2-S2) | `0042`: `journal_entries`, `journal_lines` and `accounting_source_bindings` each carry `tenant_id` and `business_id`, key on `(business_id, id)`, and reach their parents through composite foreign keys — `journal_lines (business_id, account_id) → accounts (business_id, id)`, and the same shape for the nullable branch and warehouse dimensions. A cross-business account is refused by the foreign key, not by a query someone remembered to scope | `accounting-journal.test.ts` Matrix 2 E, plus the tenant/business pair and line-tenant-mismatch cases |
| A business's base currency locks the moment it has a posted entry — and not before | AL-09 | **ENFORCED** (P2-S2) | `0042`: `businesses_base_currency_lock`, `BEFORE UPDATE OF base_currency`, `SECURITY DEFINER` owned by `daftar_accounting_internal` so RLS cannot hide the entry that should have locked it | `accounting-journal.test.ts` §26 — a business with a chart but no entry may still change it and `financial_started_at` is still NULL; after one posted entry the change is refused even for the schema owner; the name stays editable |

**RLS on the journal (P2-S2).** All three journal tables are `ENABLE`d **and** `FORCE`d, so the owner is subject to them too, under the two-layer model Phase 1 established: a permissive `tenant_membership` policy and a `RESTRICTIVE business_isolation` policy that composes with it, because a GUC is a scoping convenience and never a proof of identity. The deferred validators need to see a whole entry regardless of the writing session's row visibility, and that is solved the way `0040` solved the seeder — a narrow `FOR SELECT` policy naming `daftar_accounting_internal`, whose `WITH CHECK` deliberately omits the internal clause so the policy can never become a write path — rather than by widening `app_bypass()`, granting `BYPASSRLS` or adding the principal to the global bypass.

**AL-15 gap — closed in P2-S1.** Static-guard Rule 7 still matches only `stock`, so it was never the protection AL-15 needed. Guard **G-3** now lives in `scripts/guards/no-authoritative-balance.ts` and runs as Rule 15: it parses `CREATE TABLE` column lists and `ALTER TABLE ... ADD COLUMN` for the tables declared authoritative (`accounts` today) and refuses any balance-, running-total- or stock-shaped column, while ignoring comments, string literals and function bodies. It is about **storage authority**, not vocabulary, so a report DTO named `balance` is untouched. P2-S7 extends the declared table list to whatever read-model tables it introduces.

---

## Everything I could not find enforced

Stated plainly, because the list is the point of this page. Recompiled after P2-S2; the shrinking is real, but read item 1 carefully before citing anything here as protection.

1. **The whole of posting AUTHORITY** — AL-03, AL-04's assertion half, AL-11's recomputation, AL-17. `accounting_post_entry` does not exist, `accounting_assertion_keys` does not exist, nothing recomputes a fingerprint, there is no posting service and no atomic audit/outbox posting path. P2-S2 deliberately shipped the journal with **no writer at all**: every structural invariant below is enforced against whoever can write, and today nobody can. The day a writer lands, these rules become the only thing standing between a caller and the ledger, and they are P2-S3's subject.
2. **AL-12 (reversal)** — a new entry with `source_type='reversal'`, mirror lines at the original FX snapshot, a second reversal physically impossible. `reversal` is registered in `accounting_source_types` with its date policy, and the `UNIQUE (business_id, source_type, source_id)` shape that makes a second reversal impossible exists; the reversal *behaviour* does not.
3. **AL-13 (opening balance lifecycle)** — no table, no state machine. `opening_balance` is a registered source type and nothing more.
4. **AL-01's detail-table delete guard** — the binding row is protected physically now; a domain's *detail* row still needs a per-table `BEFORE DELETE` trigger plus a registry-completeness test enumerating `accounting_source_types`. It should land with the first detail table, not later.
5. **AL-18's converse** — that a writer never lands without its protections. P2-S2 proved the forward direction (structure without a writer) and the P2-S2 gate now refuses any P2-S3 surface, but guard **G-4** in P2-S3 is what refuses a released tree containing `accounting_post_entry` without its assertion verification, binding, fingerprint recomputation, audit and outbox.
6. **AL-14's enforcement** — the bounds are data on `accounting_source_types`, but nothing resolves "today in the business's timezone" or rejects an out-of-bounds `entry_date`. That is the posting path's job (P2-S3). Periods remain slice P2-S6 and conditional.
7. **AL-09's TypeScript half** — the HALF_EVEN conversion exists in PL/pgSQL only. "Implemented twice and the two must agree byte-for-byte" is half met, and the byte-vector suite pinning the canonical fingerprint form does not exist at all.
8. **AL-10's `MAX_MONEY_MINOR` / `assertWithinMoneyRange()`** — the cap is enforced by CHECK constraints in the database; the TypeScript constant and assertion are still absent.
9. **AL-02's "no financial values in errors or logs"** — the P2-S2 codes honour it and two tests prove it, but the cited authority (`DAFTAR_OBSERVABILITY.md`) still does not contain the rule, and no static guard covers amounts in exception messages outside the journal. The `22003` → `accounting.amount_out_of_range` mapping at the API boundary does not exist.
10. ~~**AL-15's no-balance-column rule**~~ — **closed in P2-S1**: guard G-3 is in CI with its own regression test, and P2-S2 added the journal tables to its watch list. P2-S7 extends it to read-model tables.
11. ~~**AL-02's Matrix 1 as an enumeration**~~ — **closed in P2-S2** as guard G-1.
12. ~~**AL-09's rate column type**~~ — **closed in P2-S2** as guard G-2.

Of the guards the lock scheduled, **G-1, G-2 and G-3 now exist in CI**; **G-4 does not**, and it is the one that matters most, because it is the check that stands between P2-S3 and a writer shipped without its protections.

## Where these documents live

`PHASE_2_ARCHITECTURE_LOCK.md` and this reference are on `phase/2-accounting-core`, not on `main`. Anyone reading `main` sees Phase 1 only and will not find either document.
