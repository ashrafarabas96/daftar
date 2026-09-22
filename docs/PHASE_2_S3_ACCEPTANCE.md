# DAFTAR — P2-S3 Acceptance / قبول الشريحة الثالثة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S3 — Secure posting engine**. It states what is now *enforced by a mechanism and covered by a test*, and, just as deliberately, what is not. It authorizes nothing: P2-S4 begins when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S3. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. هذه الشريحة تضيف **الكاتب الوحيد** لدفتر القيود، وكل ما يجب أن يكون صحيحًا قبل أن يصبح وجود كاتب آمنًا.

## 0. The one sentence that matters

**P2-S3 gives the journal exactly one writer, and that writer will not act on anything a caller merely asserts.**

`accounting_post_entry` is the only route into `journal_entries`, `journal_lines` and `accounting_source_bindings`. It is `SECURITY DEFINER`, owned by the NOLOGIN principal `daftar_accounting_internal`, executable by `daftar_app` and by nobody else — not `daftar_platform`, not the worker, not PUBLIC. It derives the actor, the tenant and the business from an HMAC-signed server-minted assertion, never from a caller-settable value; it re-canonicalizes the payload it was handed and recomputes the fingerprint, so the signature authorizes a *payload* rather than a number; it resolves accounts inside the business; it reads "today" in the business's timezone under the same row lock that holds the base currency stable; and it writes the entry, its lines, its source binding, its audit event and its outbox event in one transaction or none of them.

`تضيف هذه الشريحة كاتبًا واحدًا لدفتر القيود، لا يقبل أي هوية أو مبلغ من المستدعي مباشرة: الفاعل والمنشأة يُشتقّان من توكيد موقّع على الخادم، والبصمة تُعاد حوسبتها من الحمولة نفسها داخل قاعدة البيانات. لا توجد نقطة HTTP عامة للترحيل، ولا جداول عمليات تشغيلية، ولا P2-S4.`

## 1. Candidate migrations

| migration | SHA-256 | state |
|---|---|---|
| `0044_accounting_assertion_keys.sql` | `51ba3917ce3a6b4012365d80c9e70253d8355bf69a9387aec0c1fd6d497776fb` | CANDIDATE |
| `0045_accounting_post_entry.sql` | `d3e26b839e2fa783e282a5c8c65b8f7726ebaaa75cbfb7a2b84ff51a7831ae76` | CANDIDATE |

Neither is in `MIGRATION_MANIFEST.json`, and `frozenThrough` remains `0043_accounting_invariants.sql`. That is intentional and is what the P2-S3 gate checks in both directions: while the slice is under review a defect must be correctable **in place** rather than consuming a P2-S4 migration number, and a slice must never freeze itself — acceptance is the Tech Lead's decision and nobody else's.

Migrations `0000`–`0043` are byte-for-byte unchanged, and `0046` does not exist.

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

### The new cross-layer invariant, stated explicitly

**A business's first successful journal posting and `businesses.financial_started_at` becoming non-NULL are one atomic fact.**

Neither can exist without the other. The stamp is written inside `accounting_post_entry`, in the same transaction as the entry, under the same `FOR UPDATE` lock on the business row that the first posting takes — so a rolled-back posting leaves `financial_started_at` NULL (`accounting-posting.test.ts` §38), and two simultaneous first postings produce two entries and exactly one stamp, which the second does not rewrite (`accounting-concurrency.test.ts` §41). `businesses_financial_start_guard()` refuses the column to every other writer, so there is no path that sets it without an entry and no path that posts an entry without setting it. **ENFORCED.**

## 5. Four decisions worth stating plainly

**The fingerprint is bytes, not JSON.** `JSON.stringify` is not a financial identity: key order, unicode escaping, number formatting and whitespace are all implementation-defined and none of them is stable across two languages. `acctfp/1` is defined at the byte level — US `0x1f` between fields, RS `0x1e` after each record, `0x00` for a NULL dimension, lines sorted by their own bytes — and both implementations are tested against one vector file.

**The ACL comes before the ownership transfer.** A non-superuser deployment migrator is a member of `daftar_accounting_internal` `WITH INHERIT FALSE`: enough to `ALTER … OWNER TO`, not enough to `REVOKE` as that owner. A `REVOKE` issued after the transfer matches no grantor, and PostgreSQL emits a warning and changes nothing. Writing the portability test found this: the original ordering would have shipped `accounting_post_entry` PUBLIC-executable on managed PostgreSQL. Both `0044` and `0045` now issue every `REVOKE`, `GRANT` and `COMMENT` *before* the ownership transfer, and `tests/integration/migration-portability.test.ts` asserts with `has_function_privilege` — not by pattern-matching `proacl`, which is vacuous when the ACL is NULL, which is exactly the case a failed REVOKE produces.

**The catalogue is asked with the privilege functions, not the `information_schema` views.** Those views are filtered to roles the querying session is a member of, so under the migrator they would have made the migrations' own self-checks pass by seeing nothing. `has_table_privilege` and `has_column_privilege` answer the question that was asked.

**A permanent predecessor gate must never block an authorized successor.** Two checks written when no writer existed asked the *live database* whether one did. Both were rescoped to the text of the frozen files they are actually about — `tests/security/accounting-boundary.test.ts` and the P2-S2 gate's slice-boundary check — because a gate that forbids its successors is a gate that stops the project.

## 6. Managed-PostgreSQL portability

`tests/integration/migration-portability.test.ts` applies `0039 → 0045` under a `NOSUPERUSER`, `NOBYPASSRLS` `daftar_migrator` and asserts that no accounting routine is PUBLIC-executable afterwards, asked with `has_function_privilege` over all eight. The Phase 1 residual recorded in `PHASE_2_S1_ACCEPTANCE.md` §6 is unchanged: `0032`/`0033`/`0038` transfer ownership to `daftar_platform`, which a non-superuser migrator can only do if that LOGIN role holds `CREATE` on `public`. P2-S3 did not touch it, and fixing it in place is impossible now that Phase 1 history is frozen.

## 7. The accepted threat boundary — stated without overclaiming

1. **A stolen `daftar_app` database credential, alone, cannot mint or post arbitrary financial truth.** It can execute `accounting_post_entry`, and the primitive will refuse it: without a valid assertion there is no actor, no tenant and no business, and the GUCs such a credential can set are not read for authority.
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

It refuses if `0044` or `0045` is missing, if either is already frozen or `frozenThrough` has moved past `0043`, if any frozen `0000`–`0043` migration changed, if `0046` exists, if any required P2-S3 surface is missing, if the assertion key domain is incomplete, if the primitive stops recomputing the fingerprint or stops establishing `financial_started_at`, if guard G-4 is absent from `static-guards.ts` or reports a violation, if `accounting_post_entry` is granted EXECUTE to anyone but `daftar_app`, if the grant model ever gives a runtime credential journal DML, if authority isolation finds a reachable write path, if `packages/accounting` or any of its modules or the shared `acctfp/1` vectors are missing, if nothing compares the SQL and TypeScript canonicalizers, if the accounting assertion key is not configured separately from provisioning or the startup refusal on byte-equality is gone, or if any predecessor gate, the unit suite, the posting, concurrency, parity, authority or engine-shape matrices fail.
