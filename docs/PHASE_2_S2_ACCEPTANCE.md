# DAFTAR — P2-S2 Acceptance / قبول الشريحة الثانية من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S2 — Immutable journal structural core**. It states what is now *enforced by a mechanism and covered by a test*, and, just as deliberately, what is not. It authorizes nothing: P2-S3 begins when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S2. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. هذه الشريحة تبني **هيكل** دفتر القيود فقط: لا يوجد كاتب، ولا دالة ترحيل، ولا صلاحية كتابة لأي مبدأ.

## 0. The one sentence that matters

**P2-S2 gives the journal its structure and gives nobody the ability to write to it.**

The tables exist. Balance, line count, ownership, money range, FX arithmetic, immutability and bidirectional source binding are refused by PostgreSQL at COMMIT. And no principal — not `daftar_app`, not `daftar_platform`, not the worker, not PUBLIC — holds INSERT, UPDATE, DELETE or TRUNCATE on any of it. There is no `accounting_post_entry`, no assertion key table, no posting service. Everything in §4 below is enforced *against whoever can write*; today no runtime principal can, and no posting primitive exists at all — that is the design. The deployment migrator that creates and owns these tables is a separate deployment trust boundary, not a runtime writer; the claim is that no runtime principal can write directly, never that the schema can never be altered by the credential that deploys it.

`تُنشئ هذه الشريحة جداول دفتر القيود وثوابتها فقط. لا يملك أي دور تشغيلي صلاحية الكتابة في دفتر القيود، ولا توجد دالة ترحيل. سلطة الترحيل كلها مؤجَّلة إلى P2-S3.`

## 1. Candidate migrations

| migration | SHA-256 | state |
|---|---|---|
| `0042_accounting_journal.sql` | `78c852cd1f5888013a02244327a1eb606e3f0fd9582fbbed2018b9382cb92e33` | CANDIDATE |
| `0043_accounting_invariants.sql` | `9744da043d3c8b3fe68af30b135e5f5f36207ec5b457d115a3f5a465d268e70f` | CANDIDATE |

Neither is in `MIGRATION_MANIFEST.json`, and `frozenThrough` remains `0041_accounting_permissions.sql`. That is intentional and is what the P2-S2 gate checks: while the slice is under review a defect must be correctable **in place**, rather than consuming a P2-S3 migration number. Freezing happens on acceptance, never before — the same protocol P2-S1 followed, where the candidate window was used twice for corrections the Tech Lead asked for.

Migrations `0000`–`0041` are byte-for-byte unchanged. Nothing after `0043` exists.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Accepted P2-S1 head: `18d2d1c0d38a726c503ce4b6cafe833de28a1bf6`
- Base reviewed P2-S2 head: `eb4a73fd5e925da76fba305ecb9e6b25111be0b0` (returned CHANGES REQUIRED — see §4b)

**Evidence law.** CI SUCCESS is reported for a commit only when GitHub shows a workflow run whose head SHA is that exact commit. The P2-S1 freeze commit `161369c76223bc7405010f97cb0e266e521f65df` has **no exact-SHA workflow run**: it was pushed together with its successor, so Actions ran on the branch tip. The freeze is nonetheless exercised by every later run through the permanent P2-S1 regression gate, and a previous handoff's "Freeze CI: SUCCESS" line should not be repeated as historical fact.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

## 3. What the slice added

**Migration `0042_accounting_journal.sql`**

- `accounting_source_types` — the closed source registry, holding exactly `opening_balance`, `manual_adjustment` and `reversal`. AL-14's date policy is carried **as data** on this table (`lower_bound_policy`, `upper_bound_policy`, both CHECK-constrained), so a future source type cannot be registered without declaring it, and no branch in any routine encodes the policy.
- `accounting_system_actors` — created and left **EMPTY**. AL-04 refuses to invent a synthetic `users` row for a system actor; the table exists so the actor CHECK has something to reference, and every Phase 2 posting will be a `user` actor.
- `journal_entries`, `journal_lines`, `accounting_source_bindings` — the three business-scoped ledger tables, each carrying `tenant_id` and `business_id`, keyed on `(business_id, id)`, and reaching every parent through a **composite** foreign key so that same-Business membership is proven physically rather than by a query someone remembered to scope.
- The bidirectional binding: `accounting_source_bindings_entry_fk` and `journal_entries_binding_fk`, both composite and both `DEFERRABLE INITIALLY DEFERRED`. No polymorphic foreign key and no per-domain nullable columns.
- Immutability: `BEFORE UPDATE OR DELETE` triggers on all three tables, raising unconditionally. They contain no identity test at all, which is the point — see §5.
- RLS `ENABLE` + `FORCE` on all three, permissive tenant membership composed with a `RESTRICTIVE` business isolation policy.
- Grants: `SELECT` for `daftar_app`, `daftar_platform`, `daftar_worker` and `daftar_accounting_internal`; nothing for `daftar_identity`, `daftar_resolver` or `daftar_provisioner`; nothing at all on the two registries; and no write privilege for anyone.
- `businesses_base_currency_lock` — a business's base currency becomes unchangeable the moment it has a posted entry, and not one moment earlier. Creating a chart does not lock it.

**Migration `0043_accounting_invariants.sql`**

- `accounting_pow10(integer)` — exact powers of ten built with `repeat()`, because `power()` and `^` return double precision.
- `accounting_assert_entry_valid(uuid, uuid)` — the commit-time validator: entry exists, status is `posted`, every line belongs to the same business, every account belongs to that business, at least two lines, all lines agree with the business's base currency, debits equal credits, every foreign line's `base_amount_minor` is the exact HALF_EVEN conversion, and a binding exists.
- Two `DEFERRABLE INITIALLY DEFERRED` **constraint triggers**: `journal_entry_validate` on entries and `journal_line_validate` on lines. Both are mandatory — see §5.
- The REVOKE shape: all four routines owned by `daftar_accounting_internal`, EXECUTE revoked from PUBLIC and never granted to any runtime role.

## 4. Enforced by this slice

| invariant | mechanism | test |
|---|---|---|
| A zero-line entry cannot reach COMMIT | `journal_entry_validate`, the entry-side deferred trigger | `accounting-journal.test.ts` Matrix 2 A |
| A one-line entry cannot reach COMMIT | same, plus `accounting.entry_too_few_lines` | Matrix 2 B |
| Debits must equal credits | `accounting.entry_unbalanced`, sums cast to `NUMERIC` first | Matrix 2 C |
| A balanced entry commits | both triggers pass | Matrix 2 D |
| A line may not reference another business's account | composite FK `journal_lines (business_id, account_id) → accounts (business_id, id)` | Matrix 2 E |
| A posted line cannot be updated or deleted | `journal_lines_no_mutation` | Matrix 2 F, G |
| A posted entry cannot be updated or deleted | `journal_entries_no_mutation` | Matrix 2, immutability block |
| An entry cannot reach COMMIT without its binding, and a binding cannot without its entry | two deferred FKs, both directions | Matrix 2 H and its mirror case |
| A binding cannot be changed or removed afterwards | `accounting_source_bindings_no_mutation` + no DML grant | immutability block |
| The actor is exactly one of user or system, never both, never neither, never invented | `journal_entries_actor_shape_ck` + the empty actor registry | AL-04 block, five cases |
| Money stays inside `0 < amount ≤ 10^18` | CHECKs on every minor-unit column | AL-10 block, including four lines at the cap |
| A foreign line carries a complete FX snapshot or none | `journal_lines_fx_shape_ck` | AL-09 structural block, six cases |
| `base_amount_minor` is the exact HALF_EVEN conversion at both currencies' real exponents | `accounting_assert_entry_valid` | AL-09 arithmetic block, seven vectors each with an accepting and a one-minor-unit-off case |
| A business's base currency locks on its first posted entry, not on its chart | `businesses_base_currency_lock` | §26 block |
| No runtime principal can write the journal directly | the grant shape, compared against the intended model | `journal-privilege-matrix.test.ts`, Matrix 1 + G-1 |
| Error messages carry no financial values | the raised messages themselves | §30 block |

**Guards added.** **G-1** (`scripts/guards/journal-privilege-model.ts`) states the intended grant matrix as data and the test compares it against the live catalogue read two ways — `information_schema.role_table_grants` and the unfiltered `aclexplode(coalesce(relacl, acldefault('r', relowner)))` — so a `GRANT` added years from now fails CI even though no one wrote a test for it. **G-2** (`scripts/guards/no-float-rate.ts`) refuses a floating-point or under-scaled rate column on the journal, the chart and any `accounting_*` table, and deliberately leaves a marketing `conversion_rate` or a product `tax_rate` alone. **G-3** was extended to watch the journal tables. All three have tamper regressions in `tests/integration/accounting-guards.test.ts`: a guard nobody has seen fail is not a guard.

## 4b. Correction after Tech Lead review — composite journal identity

The first submitted head (`eb4a73f`) was returned CHANGES REQUIRED for one structural blocker, corrected in place in `0043`.

**The defect.** `accounting_assert_entry_valid(p_business_id, p_entry_id)` loaded the entry by `(business_id, id)` correctly, and then addressed its lines by `journal_entry_id` alone — in the ownership check, the account check, the line count, the base-currency check, the balance sums and the FX loop. `journal_entries` is keyed on `(business_id, id)` and carries no global `UNIQUE (id)`, deliberately: two businesses may legitimately hold entries whose UUID component is identical while being entirely different relational entities. Reading by the UUID alone pulled the other business's independent entry into this one's validation, which counted its lines, summed its amounts, judged its base currency, and reported `accounting.entry_business_mismatch` for data that was perfectly correct.

The ownership check was the root of it, and its own comment said why: lines were gathered by entry id alone *so that the business comparison would not be tautological*. That reasoning inverted the priority — it manufactured cross-business visibility in order to double-check a constraint the composite foreign keys already enforce physically. The correct scope makes the business half structurally true rather than checked, and leaves the tenant comparison as the defence in depth.

**The fix.** Every statement that means "this entry's lines" now reads `jl.business_id = e.business_id AND jl.journal_entry_id = e.id`. `p_entry_id` survives only in the entry lookup and in error messages. No index was added: `(business_id, journal_entry_id)` is already the left prefix of `UNIQUE (business_id, journal_entry_id, line_no)`. No `UNIQUE (id)` was added, and no foreign key or key shape changed — business-scoped composite identity is the relational contract, not an accident to be normalised away.

**Proof, in the order it was produced.** Five behavioural cases were written first and failed against the reviewed implementation:

| case | what it proves | before the fix |
|---|---|---|
| two businesses, same entry UUID, both balanced, one transaction | the headline case: both COMMIT | `accounting.entry_business_mismatch` |
| two same-UUID entries unbalanced in opposite directions by the same amount | sums are per business — merged they would balance at 11000 = 11000 | wrong verdict |
| two same-UUID entries with one line each | the line count is per business — merged they would be two | wrong verdict |
| two businesses with different base currencies sharing a UUID | the currency rule is per business | `accounting.entry_business_mismatch` |
| a line claiming business A while referencing B's entry, and B's account | cross-business isolation is unchanged by the fix | already refused, still refused |

The two properties now hold at once: two legitimate entries in different businesses may share the UUID component, and neither can ever reach the other's financial rows.

A sixth test is a tripwire rather than a proof — it reads the installed routine from `pg_proc` and refuses any line predicate keyed on `p_entry_id` — and `npm run gate:phase2:s2` performs the same check on the migration text so a reintroduction fails before a database starts.

**Scope audit (§9).** Every remaining query in `0042` and `0043` that touches a business-owned row was re-read. The RLS policies and the base-currency lock resolve `businesses.id`, which is a global primary key, so they are correct as written; the binding check was already composite. Three assertions in the P2-S2 test suite addressed an entry or its lines by UUID alone — correct only because the fixtures happen to generate distinct UUIDs — and were scoped to the pair as well.

## 5. Three decisions worth stating plainly

**Both validation triggers, not just the line-side one.** A transaction that inserts an entry and no lines touches no line trigger at all. Line-only validation would let the emptiest possible entry — the one with nothing in it — commit silently. The entry-side constraint trigger is the one that catches it, and it is mandatory.

**Immutability has no privileged exemption.** The trigger functions contain no `current_user`, no `session_user`, no `current_setting()`. There is nothing to exempt `daftar_platform`, the migration credential, a support account or the schema owner, because the moment such a branch exists it becomes the thing an attacker looks for and the thing a tired engineer reaches for at 2am. The test proves it by asserting the connection is a superuser and *then* attempting the update.

**The validators can see what the writer cannot.** A deferred validator that runs under RLS would pass vacuously the day a writing session's row visibility hid half an entry from it. The fix is the one `0040` already used for the seeder: `SECURITY DEFINER` routines owned by `daftar_accounting_internal`, plus a narrow `FOR SELECT` policy naming that principal. Its `WITH CHECK` deliberately omits the internal clause, so the policy can never become a write path. `app_bypass()` was not widened, `BYPASSRLS` was not granted, and the principal remains NOLOGIN, passwordless and unelevated.

## 6. Managed-PostgreSQL portability

`0042` and `0043` are proven to apply over a `NOSUPERUSER`, `NOBYPASSRLS` migration principal in `tests/integration/migration-portability.test.ts`, which also asserts that all five P2-S2 routines end up owned by `daftar_accounting_internal` and that both deferred constraint triggers survive that path. Writing that test found a real defect: `0043`'s closing self-check called `accounting_pow10()` *after* EXECUTE had been revoked and ownership moved, so it passed as a superuser and failed as a migrator. The self-check now runs immediately after `CREATE FUNCTION`, before the ownership transfer.

The Phase 1 residual recorded in `PHASE_2_S1_ACCEPTANCE.md` §6 is unchanged: `0032`/`0033`/`0038` transfer ownership to `daftar_platform`, which a non-superuser migrator can only do if that LOGIN role holds `CREATE` on `public`. P2-S2 did not touch it, and fixing it in place is impossible now that Phase 1 history is frozen.

## 7. Not enforced — and not attempted

Stated plainly, because a slice's honesty is measured here and not in §4.

1. **Posting authority.** `accounting_post_entry` does not exist. Neither does `accounting_actor`. **SPECIFIED.**
2. **Accounting command assertions.** `accounting_assertion_keys`, the HMAC verification, the 60-second expiry, the single-transaction `jti`. **SPECIFIED.** The identical mechanism is live for provisioning (`0038`) and is the precedent P2-S3 will follow.
3. **Fingerprint recomputation.** `posting_fingerprint CHAR(64)` exists with a lowercase-hex CHECK, and that is all the database can say about it. Nothing canonicalizes, nothing recomputes, and a structurally valid fingerprint over the wrong payload is accepted exactly as a correct one is. The recomputation is the whole protection and it lands with the writer. **SPECIFIED.**
4. **The posting service.** No API, no TypeScript entry point, no DTO. **SPECIFIED.**
5. **Atomic audit and outbox posting.** AL-17's "entry → lines → audit → outbox in one transaction". The Phase 1 mechanism exists and is tested; the accounting use of it does not. **SPECIFIED.**
6. **Posting-date enforcement.** The bounds are data on `accounting_source_types`; nothing resolves "today in the business's timezone" or rejects an out-of-bounds `entry_date`. **SPECIFIED.**
7. **The TypeScript half of AL-09.** The HALF_EVEN conversion exists in PL/pgSQL only, so "implemented twice and the two must agree" is half met. **SPECIFIED.**
8. **Reversal, manual adjustment and opening balances** (AL-12, AL-13) — registered as source types, with no behaviour behind them. **SPECIFIED.**
9. **Periods** (AL-14) — slice P2-S6, conditional. **SPECIFIED.**
10. **Guard G-4** — the check that refuses a released tree containing a writer without its protections. P2-S2's gate refuses any P2-S3 surface, which is the forward direction; G-4 is the converse and belongs to P2-S3. **SPECIFIED.**

## 8. How to re-run the evidence

```
npm run gate:phase2:s2      # includes gate:phase2:s1 as a permanent predecessor
```

P2-S2 is now accepted and frozen, so the gate is a **permanent regression gate**, and the tense of its questions has changed. It no longer asks "did the slice stay a candidate?" — it asks "is the accepted slice still exactly what was accepted?". It refuses if `0042` or `0043` is missing or no longer byte-for-byte the accepted hashes (which it carries as its own second copy, independent of the manifest), if any frozen migration changed, if the manifest does not record `0042`/`0043` at their accepted hashes with `frozenThrough ≥ 0043`, if the two accepted migrations ever grow a posting or assertion surface or a `session_replication_role` escape, if either deferred validator is missing or not deferred, if either binding direction loses its deferral, if any immutability trigger is gone, if an immutability trigger starts consulting the current identity, if `ROUND()` appears in `0043`, if a minor-unit sum is not cast to `NUMERIC`, if a validator addresses journal lines by the UUID alone rather than the composite `(business_id, id)`, if G-1's model ever describes a writer, if G-2 or G-3 finds an offending column, if any principal holds journal DML, or if Matrix 1, Matrix 2 or the P2-S1 regression fails. It deliberately has **no** opinion about whether a migration after `0043` exists: a historical accepted gate that forbade its successors would be a gate that blocks the next authorized slice, so `0044`, `0045` and beyond are none of its business.
