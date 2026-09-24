# DAFTAR — P2-S3 Acceptance / قبول الشريحة الثالثة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S3 — Secure posting engine**. It states what is now *enforced by a mechanism and covered by a test*, and, just as deliberately, what is not. It authorizes nothing: P2-S4 begins when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S3. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. هذه الشريحة تضيف **الكاتب الوحيد** لدفتر القيود، وكل ما يجب أن يكون صحيحًا قبل أن يصبح وجود كاتب آمنًا.

## 0. The one sentence that matters

**P2-S3 gives the journal exactly one writer, and that writer will not act on anything a caller merely asserts.**

`accounting_post_entry` is the only route into `journal_entries`, `journal_lines` and `accounting_source_bindings`. It is `SECURITY DEFINER`, owned by the NOLOGIN principal `daftar_accounting_internal`, executable by `daftar_app` and by nobody else — not `daftar_platform`, not the worker, not PUBLIC. It derives the actor, the tenant and the business from an HMAC-signed server-minted assertion, never from a caller-settable value; it re-canonicalizes the payload it was handed and recomputes the fingerprint, so the signature authorizes a *payload* rather than a number; it resolves accounts inside the business; it reads "today" in the business's timezone under the same row lock that holds the base currency stable; and it writes the entry, its lines, its source binding, its audit event and its outbox event in one transaction or none of them.

`تضيف هذه الشريحة كاتبًا واحدًا لدفتر القيود، لا يقبل أي هوية أو مبلغ من المستدعي مباشرة: الفاعل والمنشأة يُشتقّان من توكيد موقّع على الخادم، والبصمة تُعاد حوسبتها من الحمولة نفسها داخل قاعدة البيانات. لا توجد نقطة HTTP عامة للترحيل، ولا جداول عمليات تشغيلية، ولا P2-S4.`

### The correction of 2026-09-22

The first review of this slice found two blockers, and the second sentence above did not hold when they were found. Both are fixed in place in 0044/0045 themselves, while they were still candidates; §10 is the account of them, and it is the part of this page to read first.

`مراجعة القائد التقني وجدت عيبين قاطعين في النسخة الأولى من هذه الشريحة. صُحّحا داخل 0044/0045 نفسيهما لأنهما ما زالتا مرشّحتين. التفصيل في القسم 10.`

## 1. Accepted migrations, now frozen

| migration | SHA-256 | state |
|---|---|---|
| `0044_accounting_assertion_keys.sql` | `cf49b196598e5dc829b56e656bc7883a2fed3a54f6631cf0bdf112c4521a0902` | FROZEN |
| `0045_accounting_post_entry.sql` | `84fa101e1c25e880b7850a96abd05a5efabd068cec56397c3b465ca11847cb2e` | FROZEN |

Both hashes changed with the 2026-09-22 correction (§10): the values a reader may have from the first review round are stale, and these are the ones the Tech Lead accepted.

**Accepted by the Tech Lead on 2026-09-22** at head `18d29557be41c31cd60898d51f6f9a546201467b`, whose exact-SHA workflow is **35712359018** with all five jobs SUCCESS. Both migrations are now in `MIGRATION_MANIFEST.json`, `frozenThrough` is `0045_accounting_post_entry.sql`, and the manifest lists **46 frozen migrations**. `0000`–`0045` is release history: a defect in any of it needs a NEW migration, never an edit.

`npm run gate:phase2:s3` changed tense with the freeze. It is now a **permanent predecessor gate**: it carries the two accepted hashes as an independent second source, requires the manifest to record them frozen through `0045` or later, and has dropped the candidate-era rules — it no longer asks whether 0044/0045 are unfrozen, and it has no opinion at all about whether `0046` exists, because a permanent gate that forbids its authorized successor is a gate that stops the project.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Accepted P2-S2 head: `cd41573469563dc334bb5f84a660558cd805950c`, frozen at `9214bc1`

**Evidence law.** CI SUCCESS is reported for a commit only when GitHub shows a workflow run whose head SHA is that exact commit. Nothing in this document reports a CI result for a commit that has no such run.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **PRECEDENT** | the identical mechanism is live elsewhere in the codebase and is the pattern this slice followed |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

## 3. What the slice added

**Migration `0044_accounting_assertion_keys.sql` — the key domain**

- `accounting_assertion_keys` — `kid` primary key, a `BYTEA` secret with a ≥32-byte CHECK, and an `active`/`retired` status. No runtime role holds any privilege on it; the secret is never readable by anything a service authenticates as.
- `accounting_assertion_uses` — the replay registry, keyed by `jti`, carrying the `XID8` of the transaction that consumed it. Transaction-scoped, so a rolled-back posting strands nobody.
- `accounting_assertion_key_install()` / `accounting_assertion_key_retire()` — `SECURITY DEFINER`, owned by `daftar_accounting_internal`, `EXECUTE` granted to `daftar_platform` alone. The platform credential can rotate key material and cannot read it back, and cannot post.

**Migration `0045_accounting_post_entry.sql` — the writer**

- `accounting_canonical_line()` returning `BYTEA` and `accounting_fingerprint()` returning the lowercase hex SHA-256 of the `acctfp/1` stream. `BYTEA`, not `TEXT`, because a NULL dimension is the single byte `0x00` and PostgreSQL `TEXT` cannot hold it — faking it would make the two implementations disagree on exactly the value most likely to appear in an attacker's payload.
- `accounting_verified_actor` and `accounting_actor()` — the verifier: signature over the first eleven components, 60-second TTL, single-use `jti`, and the actor, tenant and business read out of the *verified* claims.
- `accounts_used_identity_immutable()` — a custom account's code and type are locked once it carries posted history.
- `businesses_financial_start_guard()` — `financial_started_at` is writable by the posting authority and by nothing else: not set, not changed, not cleared by any other hand.
- `accounting_post_entry(date, text, text, jsonb)` — the primitive, in the order the directive fixes: verify the assertion, lock the business row, read the base currency and timezone under that lock, parse and validate the payload schema, resolve accounts inside the business, check the base currency, canonicalize, recompute and compare the fingerprint, serialize the source identity, resolve idempotency, apply the date policy, insert entry → lines → binding, write audit and outbox, and stamp `financial_started_at` if this is the first posting.
- `journal_lines_fx_rate_at_second_ck` — `fx_rate_at` is truncated to the second, matching the canonical stream's second-precision instant exactly.

**Workspace `packages/accounting` (`@daftar/accounting`)**

`fingerprint.ts`, `assertion.ts`, `fx.ts`, `post.ts`, `ports.ts`, `types.ts`, `errors.ts`, plus `vectors/acctfp-vectors.json` — the shared vectors both the TypeScript and the PL/pgSQL canonicalizer are tested against, so neither can drift without the other failing.

**API**

`ACCOUNTING_ASSERTION_KEY`/`KID` in the configuration, refused at startup if byte-equal to the provisioning key; `Database.withAccountingTransaction`; the assertion minter, the posting adapter and the posting service, which checks `accounting.post`, refuses a command whose business or tenant is not the caller's membership, and derives the actor from the membership rather than from the request.

## 4. Enforced by this slice

| invariant | mechanism | test |
|---|---|---|
| The ledger has exactly one writer | `accounting_post_entry`, `SECURITY DEFINER`, owned by `daftar_accounting_internal` | `journal-privilege-matrix.test.ts`, guard G-4 |
| No runtime credential holds journal DML | grants; G-1's model compared to the live catalogue | `journal-privilege-matrix.test.ts` |
| The primitive is executable by `daftar_app` only | `REVOKE … FROM PUBLIC` then one `GRANT` | `accounting-posting-authority.test.ts`, G-4 |
| The platform credential cannot post | no EXECUTE grant | `accounting-posting-authority.test.ts` |
| The actor is never caller-settable | derived from the verified assertion; GUCs ignored | authority suite, the spoofing cases |
| The tenant and business are never caller-settable | same; `app.business_id` and friends change nothing | authority suite |
| A tampered payload is refused | the fingerprint is recomputed from the payload in SQL | `accounting-posting.test.ts` §27 cases |
| An expired assertion is refused | 60-second TTL | authority suite |
| A replayed assertion is refused | `accounting_assertion_uses`, `jti` primary key | authority suite |
| A provisioning assertion is not financial authority | separate key, separate domain, byte-equality refused at startup | `config` tests, gate check |
| Debits equal credits; ≥2 lines; base currency agrees | the frozen `0043` validators, reached through the writer | `accounting-posting.test.ts` |
| Every line is in the business's base currency | checked in `0045` under the business row lock, and again at COMMIT by `0043` | `accounting-concurrency.test.ts` §42 |
| An entry may not be dated after today **in the business timezone** | `accounting_source_types` policy, read under the same lock | `accounting-posting.test.ts`, `accounting-concurrency.test.ts` §43 |
| A retry is the same fact, not a second entry | source identity + fingerprint; advisory lock on the source | `accounting-posting.test.ts`, §50 cases |
| Concurrent duplicates yield one entry, one binding, one audit, one outbox | advisory transaction lock, then idempotent resolution | `accounting-concurrency.test.ts` §50 |
| A rolled-back posting leaves nothing behind | one transaction; the advisory lock and the `jti` are transaction-scoped | `accounting-concurrency.test.ts` §51 |
| Audit and outbox are written with the entry or not at all | same transaction | `accounting-posting.test.ts` §37/§62 |
| `financial_started_at` becomes non-NULL exactly when the first entry is posted | the primitive, under the business row lock; `businesses_financial_start_guard()` refuses every other hand | `accounting-posting.test.ts` §38, `accounting-concurrency.test.ts` §41 |
| A business's base currency cannot change once it has posted history | `businesses_base_currency_lock` (frozen `0042`) | `accounting-concurrency.test.ts` §42 Case B |
| A custom account's identity locks once it has posted history | `accounts_used_identity_immutable()` | `accounting-posting.test.ts` §31 |
| No HTTP posting endpoint exists | static controller scan + live probes | `accounting-posting-authority.test.ts` |
| SQL and TypeScript canonicalization agree byte for byte | shared `acctfp/1` vectors | `accounting-fingerprint-parity.test.ts` |
| The engine can express every worked journal in the rules document | 27 goldens asserting lines literally | `golden-regression/phase2/01-engine-shapes.golden.test.ts` |
| No runtime role can create a relation in any schema an elevated routine searches | `bootstrap.sql` revokes `TEMPORARY` and `CREATE`; `0045` refuses to commit otherwise | `search-path-shadowing.test.ts`, guard G-5 |
| Every routine this repository may own names `pg_temp` last | headers in `0044`/`0045`; `ALTER FUNCTION` in `0045` §9b for the frozen ones | `search-path-shadowing.test.ts`, guard G-5 |
| The writer depends on no session-created relation | the intermediate result is a plpgsql array of `accounting_posting_line` | `search-path-shadowing.test.ts`, guard G-5 |
| A forged assertion backed by a caller-owned key registry is refused | the whole attack, run end to end | `search-path-shadowing.test.ts` |
| A resolved account cannot be renamed, retyped, deactivated or deleted underneath a posting | shared advisory lock per account; `accounts_posting_stability` takes the exclusive one | `accounting-account-race.test.ts` |
| Accounts are locked in `id` order, so opposite line orders cannot deadlock | the lock loop orders by `id`, never by payload order | `accounting-account-race.test.ts` |
| An accounting assertion cannot be minted to outlive 60 seconds | the TTL is a bounded argument, not just a default | `packages/accounting/test/assertion.test.ts` |

### The new cross-layer invariant, stated explicitly

**A business's first successful journal posting and `businesses.financial_started_at` becoming non-NULL are one atomic fact.**

Neither can exist without the other. The stamp is written inside `accounting_post_entry`, in the same transaction as the entry, under the same `FOR UPDATE` lock on the business row that the first posting takes — so a rolled-back posting leaves `financial_started_at` NULL (`accounting-posting.test.ts` §38), and two simultaneous first postings produce two entries and exactly one stamp, which the second does not rewrite (`accounting-concurrency.test.ts` §41). `businesses_financial_start_guard()` refuses the column to every other writer, so there is no path that sets it without an entry and no path that posts an entry without setting it. **ENFORCED.**

## 5. Decisions worth stating plainly

**The fingerprint is bytes, not JSON.** `JSON.stringify` is not a financial identity: key order, unicode escaping, number formatting and whitespace are all implementation-defined and none of them is stable across two languages. `acctfp/1` is defined at the byte level — US `0x1f` between fields, RS `0x1e` after each record, `0x00` for a NULL dimension, lines sorted by their own bytes — and both implementations are tested against one vector file.

**The ACL comes before the ownership transfer.** A non-superuser deployment migrator is a member of `daftar_accounting_internal` `WITH INHERIT FALSE`: enough to `ALTER … OWNER TO`, not enough to `REVOKE` as that owner. A `REVOKE` issued after the transfer matches no grantor, and PostgreSQL emits a warning and changes nothing. Writing the portability test found this: the original ordering would have shipped `accounting_post_entry` PUBLIC-executable on managed PostgreSQL. Both `0044` and `0045` now issue every `REVOKE`, `GRANT` and `COMMENT` *before* the ownership transfer, and `tests/integration/migration-portability.test.ts` asserts with `has_function_privilege` — not by pattern-matching `proacl`, which is vacuous when the ACL is NULL, which is exactly the case a failed REVOKE produces.

**The catalogue is asked with the privilege functions, not the `information_schema` views.** Those views are filtered to roles the querying session is a member of, so under the migrator they would have made the migrations' own self-checks pass by seeing nothing. `has_table_privilege` and `has_column_privilege` answer the question that was asked.

**A search_path that omits `pg_temp` is not a path without `pg_temp`.** PostgreSQL searches the session temporary schema for relation and type names whether or not it is listed — and when it is not listed, it is searched FIRST, ahead of every schema that is. Leaving it out does not exclude it; it forfeits the choice of where it sits. Every routine this repository can own now names it, and names it last.

**The boundary is the privilege, not the path.** Pinning `pg_temp` last fixes the routines whose configuration this slice may change. It cannot fix `daftar_platform`'s seven frozen provisioning commands, because a non-superuser migrator is not a member of that role and must not become one. What closes the class for all of them at once is `bootstrap.sql` revoking `TEMPORARY` from PUBLIC and from every runtime role: with no relation to find, where `pg_temp` sits stops mattering. The path hardening is defence in depth on top of that, never instead of it.

**`FOR SHARE` was not available, and the reason is a boundary worth keeping.** Every PostgreSQL row-locking clause — `FOR KEY SHARE` included — requires `ACL_UPDATE` on the table. The posting authority holds `SELECT` and `INSERT` on `accounts` and must never hold `UPDATE`; granting it `UPDATE` so it could take a *read* lock would hand the ledger writer the power to rename and deactivate accounts. So the exclusion is explicit and symmetric instead: the posting takes a **shared** advisory lock per resolved account, and `accounts_posting_stability` takes the **exclusive** one on every `UPDATE` and `DELETE` of an account row. Two postings never block each other; a mutation waits for all of them.

**A permanent predecessor gate must never block an authorized successor.** Two checks written when no writer existed asked the *live database* whether one did. Both were rescoped to the text of the frozen files they are actually about — `tests/security/accounting-boundary.test.ts` and the P2-S2 gate's slice-boundary check — because a gate that forbids its successors is a gate that stops the project.

## 6. Managed-PostgreSQL portability

`tests/integration/migration-portability.test.ts` applies `0039 → 0045` under a `NOSUPERUSER`, `NOBYPASSRLS` `daftar_migrator` and asserts that no accounting routine is PUBLIC-executable afterwards, asked with `has_function_privilege` over all ten, the account-stabilization pair the correction added included. The Phase 1 residual recorded in `PHASE_2_S1_ACCEPTANCE.md` §6 is unchanged: `0032`/`0033`/`0038` transfer ownership to `daftar_platform`, which a non-superuser migrator can only do if that LOGIN role holds `CREATE` on `public`. P2-S3 did not touch it, and fixing it in place is impossible now that Phase 1 history is frozen.

## 7. The accepted threat boundary — stated without overclaiming

1. **A stolen `daftar_app` database credential, alone, cannot mint or post arbitrary financial truth.** It can execute `accounting_post_entry`, and the primitive will refuse it: without a valid assertion there is no actor, no tenant and no business, and the GUCs such a credential can set are not read for authority. **This claim was false in the first version of this slice** — the credential could redirect the verifier to a key registry of its own making, and did, in a reproduction that committed a forged entry. What makes it true is §10 Blocker A, and the case that would notice if it became false again runs the whole attack and requires it to be refused.
2. **A fully compromised `merchant-api` process CAN mint accounting assertions for any authority it can reach, because it holds the signing key.** This is the honest limit of the design. The assertion protects against a stolen database credential, a tampered payload, a replayed request and a caller-dictated actor; it does not protect against an attacker who owns the process that signs.
3. **The platform credential can install and retire accounting keys and cannot read existing key secrets, and cannot post.** Platform administration is not financial authority.
4. **The worker cannot post.** It holds `SELECT` on the ledger and no EXECUTE on the primitive.
5. **The migration/deployment principal is a separate, high-trust deployment boundary.** It owns the tables and PostgreSQL gives an owner rights that cannot be revoked. It is loaded by no service. The claim is that no *runtime* principal can write the ledger directly — never that the schema cannot be altered by the credential that deploys it. The immutability triggers in `0042` refuse the owner as well.
6. **Error text carries no financial value.** No refusal from `0044`, `0045` or the service names an amount, a rate, a balance, a key, an assertion, a canonical byte stream, a secret or a raw payload.

## 8. Not enforced — and not attempted

1. **Manual adjustment, reversal and opening-balance source workflows.** Registered as source types since P2-S2, with no merchant-facing behaviour behind them. The engine-shape goldens use `manual_adjustment` as an internal test identity; that is not a workflow. **SPECIFIED** (P2-S4).
2. **A generic posting HTTP endpoint.** Deliberately absent, and tested for. **SPECIFIED.**
3. **Periods and period close** (AL-14). **SPECIFIED** (P2-S6, conditional).
4. **An FX rate registry.** Rates arrive with the command and are snapshotted on the line; nothing looks them up. **SPECIFIED.**
5. **Read models, trial balance and general ledger reporting.** **SPECIFIED.**
6. **Invoices, payments, refunds, credit notes, suppliers and inventory.** Their journals are proven representable by §30's goldens; not one of their tables exists. **SPECIFIED.**
7. **Key rotation operations.** `accounting_assertion_key_install`/`_retire` exist and are tested; no scheduled rotation, no overlap policy. **PRECEDENT** — the provisioning key domain (`0038`) is the live pattern.
8. **Performance budgets** (execution plan §34). Not measured for the posting path in this slice. **SPECIFIED.**

## 9. How to re-run the evidence

```
npm run gate:phase2:s3      # composes gate:phase2:s2, which composes s1 and Phase 1
```

It refuses if `0044` or `0045` is missing or no longer matches its accepted hash, if the manifest stops recording them frozen through `0045` or later, if any frozen migration changed, if any required P2-S3 surface is missing, if the assertion key domain is incomplete, if the primitive stops recomputing the fingerprint or stops establishing `financial_started_at`, if guard G-4 is absent from `static-guards.ts` or reports a violation, if `accounting_post_entry` is granted EXECUTE to anyone but `daftar_app`, if the grant model ever gives a runtime credential journal DML, if authority isolation finds a reachable write path, if `packages/accounting` or any of its modules or the shared `acctfp/1` vectors are missing, if nothing compares the SQL and TypeScript canonicalizers, if the accounting assertion key is not configured separately from provisioning or the startup refusal on byte-equality is gone, or if any predecessor gate, the unit suite, the posting, concurrency, parity, authority or engine-shape matrices fail.

## 10. The correction of 2026-09-22 — two blockers found in review

### Blocker A — a stolen `daftar_app` credential could choose the key the verifier trusts

**What was wrong.** Every accounting routine pinned `SET search_path = public, pg_catalog`. That reads as a locked-down path and is not one: PostgreSQL searches the session temporary schema for relation and type names whether or not `pg_temp` is listed, and when it is not listed it is searched **first**, ahead of every schema that is. Separately, `TEMPORARY` on a database is granted to PUBLIC by default and `bootstrap.sql` never revoked it.

**It was not theoretical.** The reproduction ran before anything was changed and succeeded:

```
CREATE TEMP TABLE accounting_assertion_keys (kid TEXT, secret BYTEA, status TEXT);
INSERT INTO pg_temp.accounting_assertion_keys VALUES ('attacker', <attacker secret>, 'active');
GRANT SELECT ON pg_temp.accounting_assertion_keys TO daftar_accounting_internal;
CREATE TEMP TABLE accounting_assertion_uses (...);
GRANT SELECT, INSERT, DELETE ON pg_temp.accounting_assertion_uses TO daftar_accounting_internal;
SELECT accounting_post_entry(...);   -- assertion signed with the ATTACKER's key
```

`accounting_actor()`, running as `daftar_accounting_internal`, read the caller's table, verified the signature against the caller's secret, and the posting committed a real journal entry. The `GRANT` step is the part worth noticing: the attacker **owns** the temporary relation, so it can hand the elevated principal exactly the access the definer's own ACL check would otherwise have denied. This invalidated the claim in §7.1.

**The fix, in three layers.**

1. **The boundary.** `bootstrap.sql` revokes `TEMPORARY` on the database from PUBLIC and from all six runtime roles and the internal principal, and revokes `CREATE` on schema `public` from PUBLIC and all six. It uses `current_database()` rather than the literal name, so a scratch database, a staging restore under another name or a per-tenant deployment gets the same policy. Nothing anywhere grants `TEMPORARY` back. This closes the class for **every** SECURITY DEFINER routine at once, frozen Phase 1 included.
2. **The paths.** Every routine in `0044`/`0045` pins `pg_catalog, public, pg_temp`. Section 9b of `0045` then hardens the effective state of everything the frozen files left behind — appending `, pg_temp` to the 29 routines that pinned `public, pg_catalog`, and pinning the repository's standard path on those that pinned nothing at all — by `ALTER FUNCTION`, which changes catalogue configuration and not one frozen byte. Existing order is preserved; `pg_temp` is only appended, because `public` holds pgcrypto's `digest`/`hmac` and citext's operator overloads and which schema is searched first is not a free choice. Extension-owned functions are deliberately untouched.
3. **No session relation at all.** `accounting_post_entry` held its intermediate result in `CREATE TEMP TABLE IF NOT EXISTS accounting_posting_scratch`, which a caller could pre-create, own and grant away — `IF NOT EXISTS` would then quietly decline to create the real one and the primitive would `INSERT INTO journal_lines` from the caller's relation. It is gone. The intermediate result is an array of the composite type `accounting_posting_line` held in a plpgsql variable: unnameable, unshadowable, still one statement to resolve every account and one statement to insert every line.

**The honest edge.** `daftar_platform` owns seven frozen SECURITY DEFINER provisioning commands. A non-superuser migrator cannot `ALTER` them and must not be made a member of `daftar_platform` — a deployment credential that can assume platform authority is a worse problem than the one being fixed. They still pin `public, pg_catalog`. Layer 1 is what protects them, and `tests/security/search-path-shadowing.test.ts` asserts that this exception is **exactly** that set and does not grow.

**Enforcement.** Guard **G-5** (`scripts/guards/definer-search-path.ts`, static-guard rule 18) fails a pull request if `bootstrap.sql` stops revoking `TEMPORARY`, if anything grants it back, if a candidate routine pins no path or does not name `pg_temp` last, or if any candidate migration creates a temporary relation. It deliberately does not accept a path merely because the string `pg_temp` occurs in it: `pg_temp, public` names it and is exactly as broken as omitting it. The live half is the catalogue matrix, which asks the database rather than the text.

### Blocker B — a resolved account could change underneath a posting

**What was wrong.** The primitive resolved each line's account and then wrote `journal_lines` without holding those rows still. An account's `code` and `type` are the identity the `acctfp/1` fingerprint is computed from, so a concurrent rename could persist a line under an identity the posting was not signed for — and, worse, a later idempotent replay of the same source would recompute a different fingerprint and report an idempotency conflict against the engine's own earlier work.

**The fix.** `accounting_post_entry` now resolves once without a lock to learn which rows to hold, takes a **shared** advisory lock per account **in `id` order**, and then resolves again against the locked set — and only the second resolution counts. `accounts_posting_stability`, a `BEFORE UPDATE OR DELETE` trigger on `accounts`, takes the **exclusive** lock, so every mutation waits for every posting that holds the account and vice versa. It is named to sort before `accounts_system_guard` and `accounts_used_identity_lock`, because a guard that decided first and waited afterwards would read the history of a posting that had not committed yet.

**The lock key is an internal, not a fourth entry point.** `accounting_account_lock_key` derives the key from `(business_id, id)`, and the first version of this fix left it executable by PUBLIC, reasoning that the trigger runs as whoever is updating the account and that a hash of two identifiers the caller already holds is not a secret. Both halves of that reasoning are true and the conclusion was still wrong: it took §68's runtime EXECUTE surface from three routines to four, and the P2-S2 privilege matrix refused the build for exactly that reason — which is the regression gate doing its job. The helper is now revoked from PUBLIC and owned by `daftar_accounting_internal` like every other internal, and `accounts_posting_stability` is `SECURITY DEFINER` so it reaches the key as that principal. The trigger reads nothing, writes nothing and decides nothing, so the elevated identity confers no authority. What it does **not** claim to prevent is a runtime credential taking the same advisory lock on its own: the key formula is a built-in hash of two public identifiers, so anyone who can call `pg_advisory_lock` can stall a posting. That is a denial-of-service property of advisory locks generally, it was equally true before this correction, and closing it needs a mechanism that does not exist in this slice.

Restricting the second resolution to the locked set is what makes the lock mean something: an account that only started matching after the unlocked read, or stopped matching, is refused by name rather than posted against a row nobody is holding. Both refusals are safely retryable.

**What is proven**, in `tests/integration/accounting-account-race.test.ts`, on two real connections with the interleaving forced:

| case | outcome |
|---|---|
| a mutation while a posting holds the account | waits, and is observed waiting in `pg_stat_activity` |
| two postings sharing an account | neither blocks the other — the lock is shared |
| A — code change commits first | the stale signed payload is refused `account_not_found`; nothing is written |
| A — re-signed against the new code | commits, and the line persists against the current identity |
| B — posting locks first, then rename | the rename waits, then meets `account_identity_locked` |
| B — the same for `type`; the display `name` stays free | refused / allowed |
| C — deactivation commits first | a NEW posting is refused `account_inactive` |
| D — posting locks first, then deactivation | the posting commits, the deactivation waits and then succeeds |
| E — identical retry after deactivation | the ORIGINAL entry, `created = false` |
| deterministic ordering | two postings naming the same accounts in OPPOSITE line order both finish |
| deletion | waits for the posting, then meets the foreign key |

**The one honest limitation.** A single statement updating several account rows takes their locks in whatever order the executor produces them, so it can deadlock against a posting holding them in `id` order. PostgreSQL detects that and aborts one side. No path in DAFTAR issues such a statement today; the account-management slice must lock in `id` order when it does.

### Also in this correction

- **§16 — the assertion TTL is a ceiling, not a default.** `mintAccountingAssertion` refuses a `ttlSeconds` that is not an integer in `1 … 60`. The parameter exists so a test can mint something shorter-lived, and a parameter only tests are expected to pass is one production eventually passes by accident.
- **§18 — the provisioning boundary is covered by the same fix.** `daftar_provisioner` cannot create `pg_temp.provisioning_assertion_keys`, and `tests/security/search-path-shadowing.test.ts` proves it against the live roles.
- `0045` refuses to commit if any runtime role still holds `TEMPORARY` or `CREATE` on `public`, if any routine it was allowed to harden does not pin `pg_temp` last, or if the primitive creates a temporary relation. A deployment that applied migrations without re-running `bootstrap.sql` fails at deploy time, which is the correct outcome.
