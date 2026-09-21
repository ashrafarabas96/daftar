# DAFTAR — P2-S2 Acceptance / قبول الشريحة الثانية من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S2 — Immutable journal structural core**. It states what is now *enforced by a mechanism and covered by a test*, and, just as deliberately, what is not. It authorizes nothing: P2-S3 begins when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S2. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. هذه الشريحة تبني **هيكل** دفتر القيود فقط: لا يوجد كاتب، ولا دالة ترحيل، ولا صلاحية كتابة لأي مبدأ.

## 0. The one sentence that matters

**P2-S2 gives the journal its structure and gives nobody the ability to write to it.**

The tables exist. Balance, line count, ownership, money range, FX arithmetic, immutability and bidirectional source binding are refused by PostgreSQL at COMMIT. And no principal — not `daftar_app`, not `daftar_platform`, not the worker, not PUBLIC — holds INSERT, UPDATE, DELETE or TRUNCATE on any of it. There is no `accounting_post_entry`, no assertion key table, no posting service. Everything in §4 below is enforced *against whoever can write*; today nobody can, and that is the design.

`تُنشئ هذه الشريحة جداول دفتر القيود وثوابتها فقط. لا يملك أي دور تشغيلي صلاحية الكتابة في دفتر القيود، ولا توجد دالة ترحيل. سلطة الترحيل كلها مؤجَّلة إلى P2-S3.`

## 1. Candidate migrations

| migration | SHA-256 | state |
|---|---|---|
| `0042_accounting_journal.sql` | `78c852cd1f5888013a02244327a1eb606e3f0fd9582fbbed2018b9382cb92e33` | CANDIDATE |
| `0043_accounting_invariants.sql` | `d72737dfd38aa8a9e478310829b394f4b2d99fd464716f125a70e0084f5849ea` | CANDIDATE |

Neither is in `MIGRATION_MANIFEST.json`, and `frozenThrough` remains `0041_accounting_permissions.sql`. That is intentional and is what the P2-S2 gate checks: while the slice is under review a defect must be correctable **in place**, rather than consuming a P2-S3 migration number. Freezing happens on acceptance, never before — the same protocol P2-S1 followed, where the candidate window was used twice for corrections the Tech Lead asked for.

Migrations `0000`–`0041` are byte-for-byte unchanged. Nothing after `0043` exists.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Accepted P2-S1 head: `18d2d1c0d38a726c503ce4b6cafe833de28a1bf6`

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
| No principal can write the journal | the grant shape, compared against the intended model | `journal-privilege-matrix.test.ts`, Matrix 1 + G-1 |
| Error messages carry no financial values | the raised messages themselves | §30 block |

**Guards added.** **G-1** (`scripts/guards/journal-privilege-model.ts`) states the intended grant matrix as data and the test compares it against the live catalogue read two ways — `information_schema.role_table_grants` and the unfiltered `aclexplode(coalesce(relacl, acldefault('r', relowner)))` — so a `GRANT` added years from now fails CI even though no one wrote a test for it. **G-2** (`scripts/guards/no-float-rate.ts`) refuses a floating-point or under-scaled rate column on the journal, the chart and any `accounting_*` table, and deliberately leaves a marketing `conversion_rate` or a product `tax_rate` alone. **G-3** was extended to watch the journal tables. All three have tamper regressions in `tests/integration/accounting-guards.test.ts`: a guard nobody has seen fail is not a guard.

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

The gate refuses the slice if `0042` or `0043` is missing, if anything beyond `0043` exists, if any frozen migration changed, if `0042`/`0043` were frozen prematurely, if a P2-S3 surface appears anywhere, if `session_replication_role` appears in the schema, if either deferred validator is missing or not deferred, if either binding direction loses its deferral, if any immutability trigger is gone, if an immutability trigger starts consulting the current identity, if `ROUND()` appears in `0043`, if a minor-unit sum is not cast to `NUMERIC`, if G-1's model ever describes a writer, if G-2 or G-3 finds an offending column, if any principal holds journal DML, or if Matrix 1, Matrix 2 or the P2-S1 regression fails.
