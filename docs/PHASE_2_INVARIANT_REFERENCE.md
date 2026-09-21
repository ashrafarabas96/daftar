# DAFTAR — Accounting & security invariant reference / مرجع الثوابت المحاسبية والأمنية

> **What this is.** One page that states each resolved accounting/security invariant, names where it is enforced, and names the test that covers it. It adds no decisions: `PHASE_2_ARCHITECTURE_LOCK.md` remains the decision record, and this page only reports what the repository actually does today.
>
> **Read the status column first.** Compiled against `a510737` (branch `phase/2-accounting-core`), whose tree is Phase 1 (`2e01dba`) plus four documentation commits. A repository-wide search for `journal_entries`, `journal_lines`, `posting_fingerprint` and `accounting` across `*.ts` and `*.sql` returns **nothing**. Migrations stop at `0039`. So **every accounting-specific rule below is SPECIFIED, not ENFORCED** — which is exactly what the lock intends ("This document does NOT authorize... No migration `0040`"), but it means no rule below can be cited as protection today.

## Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository enforces it now, and a named test exercises it |
| **PRECEDENT** | the *mechanism* the rule will reuse is built and tested in Phase 1; the accounting rule itself does not exist yet |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

---

## 1. Bidirectional source integrity (AL-01)

**Rule.** Every posted journal entry corresponds to exactly one registered business-fact identity, and that identity cannot disappear afterwards. Enforced by two `DEFERRABLE INITIALLY DEFERRED` foreign keys — `journal_entries → accounting_source_bindings` and back — both verified at COMMIT, both composite on `business_id`; binding rows carry no DML grant to any runtime role and a `BEFORE UPDATE OR DELETE` trigger.

**Status: SPECIFIED.** `docs/PHASE_2_ARCHITECTURE_LOCK.md` AL-01. No `accounting_source_bindings` table exists.

**Tests.** None. The lock's Matrix 2 case H (entry with no binding → COMMIT FAIL) is planned in slice P2-S2.

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

**Status: SPECIFIED.** Lock AL-18. This is a process rule about commit ordering, so nothing can enforce it mechanically; what *can* be checked is that a released tree never contains a writer without its protections.

**Tests.** None yet. The release gate (`scripts/phase1-release-gate.ts`, `scripts/phase1-gate.ts`) is per-phase and has no equivalent for this rule. The lock now records the missing check as **guard G-4**, due in P2-S3: if `accounting_post_entry` exists in a released tree, its assertion verification, source binding, fingerprint recomputation, audit and outbox must exist too. Until that guard is written, the governing rule remains a habit rather than something CI can refuse.

## 4. Opening balance lifecycle (AL-13)

**Rule.** `draft → posted → superseded`, plus `draft → discarded` (row deleted, no entry ever existed). After `posted`: lines, `as_of_date`, `journal_entry_id` and `id` are immutable; `status` is the only mutable column and only for `posted → superseded`; supersession requires an existing reversal of that opening balance's journal entry (`accounting.supersede_without_reversal` otherwise); the transition is audited in the same transaction; no runtime role holds UPDATE. `CREATE UNIQUE INDEX ... WHERE status = 'posted'` gives exactly one current set per business. The equity plug is an explicit visible line to `opening_equity`.

**Status: SPECIFIED.** Lock AL-13. No table, no trigger, no state machine in code.

**Tests.** None. The lock names eight cases (edit lines after posting, change `as_of_date`, change `journal_entry_id`, supersede without reversal, supersede with reversal, `superseded → posted`, two posted sets, plug line including the zero case).

## 5. Posting-date semantics (AL-14)

**Rule.** Future-dating is forbidden for every source in Phase 2: `entry_date ≤ today` resolved in the business's own timezone (`businesses.timezone`), never the server's. Lower bounds are per source and declared as data on `accounting_source_types`: `opening_balance` — none; `manual_adjustment` — none in Phase 2, back-dating permitted and audited; `reversal` — not earlier than the original entry's date. The `created_at − 10 years` floor is withdrawn. Periods are slice P2-S6 and conditional; when they land they become the authoritative gate.

**Status: SPECIFIED.** Lock AL-14. No `entry_date` column exists, so neither the bounds nor the timezone resolution exist.

**Tests.** None. Note that "today in the business timezone" is the part most likely to be got wrong quietly: it needs a test that fixes a business in a non-UTC zone and posts at a boundary hour, not just a `date <= now()` assertion.

## 6. Privilege matrix vs invariant matrix (AL-02)

**Rule.** Two separate matrices, and a PASS requires both. **Matrix 1 (privilege):** for each of the six runtime roles, direct INSERT/UPDATE/DELETE on `journal_entries`, `journal_lines` and `accounting_source_bindings` must fail with *permission denied*. **Matrix 2 (invariants):** executed as the schema owner so the constraint itself is exercised — A zero lines, B one line, C unbalanced, D balanced (PASS), E foreign-business account, F DELETE a posted line, G UPDATE a posted line, H entry with no binding. The entry-side deferred constraint trigger is the crux: it fires at COMMIT even when a transaction writes an entry and no lines.

**Status: SPECIFIED** for accounting. **PRECEDENT** for the shape: Phase 1 already runs a role-by-role privilege matrix.

**Tests (Phase 1, passing).** `tests/security/db-privileges.test.ts` — `daftar_app` bypass flag does nothing `:44`, cross-business read `:57`, cross-business write `:73`, DDL impossible `:84`, RLS cannot be disabled `:92`, revoked grants `:103`–`:146`; `daftar_identity` separation `:178`–`:260`. `tests/security/provisioner-boundary.test.ts:55`, `:66` cover the provisioner's grant shape.

**Gap:** the Phase 1 matrix is written per-table by hand. Matrix 1 as specified is *six roles × three tables × three verbs*, and the lock asks it to match the intended grant model **exactly** — that is an enumeration over `information_schema.role_table_grants`, not a list of hand-written negative cases. Writing it by hand is how a later `GRANT` slips in unnoticed. Recorded in the lock as **guard G-1**, due in P2-S2.

## 7. Fingerprint canonicalization (AL-11)

**Rule.** `posting_fingerprint CHAR(64)` = SHA-256 over canonical bytes `acctfp/1`, never `JSON.stringify()`. Fields `\x1f`-separated, lines `\x1e`-terminated; lowercase canonical UUIDs; account identity = `system_key` else `code:<code>`, never the display name or surrogate id; side `D`/`C`; amounts as bare decimal integers; uppercase ISO-4217; `fx_rate` always 10 fraction digits including `1.0000000000`; `fx_rate_at` RFC 3339 UTC seconds; NULL is the single byte `\x00`; lines sorted by their own serialized bytes; UTF-8. Description, memos, request id, actor and timestamps are excluded as narrative. FX rate, source and timestamp are *inside* the fingerprint, so a changed rate is a conflict, not a silent replay. Idempotency: `UNIQUE (business_id, source_type, source_id)`; identical retry → `created=false`; materially different → `accounting.idempotency_conflict` / HTTP 409, never silent success.

The fingerprint a caller presents is never believed on its own: `accounting_post_entry` recomputes the canonical form from the submitted payload inside the database and requires it to equal the fingerprint the assertion signed, refusing with `accounting.assertion_payload_mismatch` before any write (AL-03). The canonicalization is therefore implemented twice — TypeScript and PL/pgSQL — and the two must agree byte-for-byte.

**Status: SPECIFIED.** No canonicalizer in either language, no fingerprint column, no idempotency key.

**Tests.** None. The lock asks for the five behaviour rows, the concurrent case on two real connections, and a byte-vector suite pinning the canonical form. The byte-vector suite is the load-bearing one: without it a refactor re-hashes history silently and every stored fingerprint becomes unverifiable.

**Related precedent.** Actor-scoped provisioning idempotency, including the "another actor cannot replay or forge" case, is tested at `tests/security/provisioner-boundary.test.ts:317`.

## 8. The FX formula (AL-09)

**Rule.** `fx_rate` means 1 major unit of transaction currency = R major units of base currency. With `rate_scaled = R × 10^10`:

```
numerator   = txn_minor × rate_scaled × 10^max(0, eb − et)
denominator = 10^10 × 10^max(0, et − eb)
base_minor  = HALF_EVEN(numerator / denominator)
```

Half-even by floor-and-remainder comparison (`2r > d`, `2r < d`, `2r = d` → tie to even). No floating point at any step; `BigInt` in TypeScript, `NUMERIC`/`BIGINT` in PostgreSQL, and `ROUND()` is deliberately not used because PostgreSQL rounds half-up and would disagree on ties. Structural completeness is immediate CHECKs on `journal_lines` (exactly one booked side; `base_amount_minor = GREATEST(debit, credit)`; `fx_rate > 0`; domestic lines pinned to `fx_rate = 1` and `fx_rate_source = 'base'`); the arithmetic equality itself is asserted by the deferred validation trigger, because a CHECK may not read `currencies`. Seven pinned vectors, of which cases 5 and 6 are the half-even ties.

**Status: SPECIFIED.** A search for `HALF_EVEN`, `half-even`, `bankers` or `roundHalf` across `*.ts` returns nothing. No conversion function exists in either implementation.

**Precedent that does exist.** Exact minor-unit money with no float path: `packages/domain-core/src/money.ts` (BigInt only; `Number` accepted solely when `Number.isSafeInteger`; excess precision throws `PRECISION_OVERFLOW`), `packages/shared-contracts/src/money.ts` (`parseMajorToMinor`, exact decimal string parsing). Tested at `packages/domain-core/test/domain-core.test.ts:89`–`:151` and `packages/shared-contracts/test/money.test.ts:10`–`:77`. Guarded statically by `scripts/static-guards.ts` Rule 6 (money as `number`, `Number()` on minor units, float money columns in SQL) and by `tests/golden-regression/phase1/05-artifact-hygiene.golden.test.ts:48` (P1-GOLD-35).

**Two gaps worth fixing before P2-S5:**
- `MAX_MONEY_MINOR = 10^18` and `assertWithinMoneyRange()` (AL-10) do not exist. `MoneyError` already reserves the `PRECISION_OVERFLOW` code, so this is an addition to an existing type, not a new concept.
- Static-guard Rule 6's SQL check keys off column *names* — `amount|price|total|balance`. A column named `fx_rate` declared `DOUBLE PRECISION` would pass the guard untouched, which is precisely the mistake AL-09 exists to prevent. Recorded in the lock as **guard G-2**, due in P2-S2 and extended in P2-S5.

## 9. Error redaction (AL-02, AL-10)

**Rule.** Commit-time failures raise a stable machine code plus safe identifiers only — never debit/credit sums, amounts, rates or balances: `accounting.entry_unbalanced`, `...entry_too_few_lines`, `...entry_business_mismatch`, `...entry_account_foreign`, `...entry_fx_arithmetic`, `...entry_status_invalid`, `...entry_binding_missing`. The earlier proposal to put the two sums in the message is withdrawn. SQLSTATE `22003` maps to `accounting.amount_out_of_range`, never a leaked driver error. Reconciliation tooling that needs the offending sums gets them through an authorized diagnostic path under the normal redaction and audit rules.

**Status: PRECEDENT.** The accounting codes do not exist. The redaction architecture does:

| piece | where |
|---|---|
| stable code + requestId + safe details; no SQL text, stack traces or class names | `apps/api/src/common/error.filter.ts` |
| PostgreSQL codes mapped to safe contracts (`23503`, `23505`, `42501`, `P0001`) | same file, bottom half |
| structured logger redacts by path, censor `[redacted]` | `apps/api/src/infra/logger.ts:7`–`:21` |
| no token/secret passed to a logger | `scripts/static-guards.ts` Rule 11 |

**Tests.** `tests/integration/auth.test.ts:147` — error responses never leak secrets, SQL or stack traces.

**Documentation gap, and it matters for this rule specifically.** AL-02 justifies the no-financial-values rule by citing `DAFTAR_OBSERVABILITY.md`. That document says logs carry no secrets and no sensitive data with redaction (line 5); it does **not** say financial values are forbidden in logs or exception messages. The logger's redact paths likewise cover token/secret/password-shaped keys, not amounts. So the rule AL-02 leans on is not actually written down anywhere binding, and nothing tests it. Either add the sentence to `DAFTAR_OBSERVABILITY.md` and a guard alongside static-guard Rule 11, or stop citing the observability document as the authority.

---

## Supporting invariants, same treatment

| rule | authority | status | enforced by | test |
|---|---|---|---|---|
| Zero-line / one-line / unbalanced entry impossible at COMMIT | AL-02 | SPECIFIED | — | Matrix 2 A–D, planned |
| Posted entries and lines immutable (triggers **and** absent grants, deliberately redundant) | AL-02, AL-03 | SPECIFIED | — | Matrix 2 F–G, planned |
| Account lifecycle: delete forbidden, `code`/`system_key` immutable, deactivation allowed, system accounts stricter | AL-05 | SPECIFIED | — | planned |
| `system_key` is the engine's identity, never the code or the name; missing system account is a loud failure | AL-07 | SPECIFIED | — | planned |
| No `account_translations`; system accounts localized by i18n key from `system_key` | AL-06 | SPECIFIED | gate exists: `scripts/check-localization.ts` (keys × ar/en/tr parity) | gate runs today; no accounting keys yet |
| Chart seeding by `AFTER INSERT` trigger on `businesses` + `0040` backfill that fails the migration if incomplete | AL-08 | SPECIFIED | — | planned; `scripts/db-from-zero.ts` is the existing from-zero harness |
| Money: BIGINT minor units, cap `10^18`, sums in `NUMERIC`, minor units as a JSON string never a number | AL-10 | PRECEDENT (cap and `assertWithinMoneyRange` missing) | `packages/domain-core/src/money.ts`, static-guard Rule 6 | `domain-core.test.ts:89`–`:151`, `money.test.ts`, P1-GOLD-35 |
| Reversal is a new entry, `source_type='reversal'`, `source_id = original entry id`; second reversal physically impossible; mirror lines at the **original** FX snapshot; original row never touched | AL-12 | SPECIFIED | — | planned |
| No materialized balances; `accounts` carries no balance column; no cached balance is authoritative | AL-15 | SPECIFIED | partial: static-guard Rule 7 | **see gap below** |
| `accounting.post`, `.reverse`, `.chart.manage`, `.fx.manage` are sensitive; default deny; delegation ceiling; no permission grants direct DML | AL-16 | PRECEDENT | `packages/domain-core/src/permissions.ts` (`PERMISSIONS`, `SENSITIVE_PERMISSIONS:48`, `isSensitive:61`) — no `accounting.*` key registered | `tests/security/delegation-ceiling.test.ts`, `tests/security/owner-authority.test.ts`, `tests/security/role-crud.test.ts` |
| Entry → lines → audit → outbox in one transaction; no asynchronous step decides whether the ledger commits; outbox payloads carry ids only, never amounts | AL-17 | PRECEDENT | `apps/api/src/modules/audit/audit.service.ts` (`recordTx` / `emitTx` both take the caller's `PoolClient`), `apps/api/src/modules/outbox/publisher.ts` | `tests/integration/outbox.test.ts:26` (atomicity), `:41` (exactly once), `:66` (backoff then dead-letter), `:87` (idempotent consumer); `tests/integration/failure-injection.test.ts:60`, `:90`, `:121`, `:135` |
| Migrations `0000`–`0039` frozen byte-for-byte | Phase 1 directive | ENFORCED | `infrastructure/database/MIGRATION_MANIFEST.json` | `scripts/check-migration-manifest.ts`, `scripts/verify-migration-history.ts`, `tests/integration/migration-upgrade.test.ts` |

**AL-15 gap.** Static-guard Rule 7 is commented "no mutable derived financial columns (product.stock / customer.balance ledgers)", but its regex matches only `stock` (`scripts/static-guards.ts:116`–`:121`). Nothing would catch a `balance` column added to `accounts`, which AL-15 calls "the single most common way a ledger rots". Recorded in the lock as **guard G-3**, due in P2-S1 and extended in P2-S7.

---

## Everything I could not find enforced

Stated plainly, because the list is the point of this page.

1. **All of AL-01 through AL-18** — no accounting schema, no accounting code, no accounting test. Migrations stop at `0039`; no `accounting.*` permission key is registered; no `HALF_EVEN` implementation exists in either language.
2. **AL-01's detail-table delete guard** — a contract-plus-test by the lock's own admission, and the enumerating test does not exist.
3. **AL-18 (writer exposure ordering)** — a process rule with no mechanical check today; now scheduled as guard G-4 in P2-S3.
4. **AL-02's Matrix 1 as specified** — needs an enumeration over the live grant catalogue; the Phase 1 equivalent is hand-written per table and will not notice a new `GRANT`. Now scheduled as guard G-1 in P2-S2.
5. **AL-02's "no financial values in errors or logs"** — the cited authority (`DAFTAR_OBSERVABILITY.md`) does not contain that rule, and no guard or test covers amounts in exception messages.
6. **AL-09's rate column type** — static-guard Rule 6 does not match `*_rate` columns, so a float rate would pass CI. Now scheduled as guard G-2 in P2-S2.
7. **AL-10's `MAX_MONEY_MINOR` / `assertWithinMoneyRange()`** — absent; `MoneyError.PRECISION_OVERFLOW` already exists to carry it.
8. **AL-15's no-balance-column rule** — static-guard Rule 7 covers `stock` only. Now scheduled as guard G-3 in P2-S1.
9. **AL-14's periods** — slice P2-S6, explicitly conditional; until then no posting-date gate of any kind exists.
10. **The database-side fingerprint recomputation** (AL-03, added after Tech Lead review) — specified, with no implementation in either language and no payload-mismatch test.

Items 3, 4, 6 and 8 are now scheduled as named guards G-1…G-4 in the lock's slice table. Scheduled is not enforced: none of them exists in CI today.

## Where these documents live

`PHASE_2_ARCHITECTURE_LOCK.md` and this reference are on `phase/2-accounting-core`, not on `main`. Anyone reading `main` sees Phase 1 only and will not find either document.
