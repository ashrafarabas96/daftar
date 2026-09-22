# DAFTAR — P2-S4 Acceptance / قبول الشريحة الرابعة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S4 — Accounting-native sources**. It states what is now *enforced by a mechanism and covered by a test*, and, just as deliberately, what is not. It authorizes nothing: P2-S5 begins when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S4. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. تبني هذه الشريحة ثلاث حقائق محاسبية فوق محرك الترحيل المُحصَّن: التسوية اليدوية، والعكس، والأرصدة الافتتاحية. لا سجلّ أسعار صرف، ولا فترات، ولا تقارير.

## 0. The one sentence that matters

**P2-S4 gives the merchant three ways to state an accounting fact, and every one of them goes through the hardened P2-S3 engine rather than around it.**

A correction is another accounting fact. Nothing in this slice edits a posted entry, deletes one, or marks one as cancelled. A manual adjustment is a new entry; a reversal is a new entry whose lines are derived from the persisted original and whose original is untouched; a replacement opening balance is a new set that supersedes the old one after the old one has been reversed. The journal still has exactly one status, and it is `posted`.

`كل تصحيح في المحاسبة هو واقعة محاسبية جديدة. لا تُعدَّل قيود مُرحَّلة ولا تُحذف. العكس قيد جديد تُشتق سطوره من القيد الأصلي المحفوظ، والقيد الأصلي يبقى كما هو حرفًا بحرف.`

## 1. Candidate migrations

| migration | SHA-256 | state |
|---|---|---|
| `0046_accounting_sources.sql` | `33ae8c2593bae14dd538708f326a0b9adf09dc0b1855b1b23e50019d829f2f16` | CANDIDATE |
| `0047_accounting_opening_balances.sql` | `0938d513c0bb844c5f36cbdb170612a08f9f52f828660ca88e2db00aeea1cabc` | CANDIDATE |

**Both files have now been corrected in place.** Through the first two review rounds `0046` did not move, and earlier revisions of this page said so; the third round's manual-adjustment completeness rule lives in it, so that sentence is no longer true and has been removed rather than qualified. The gate's pinned digest went with it: a digest recomputed after every round proves only that somebody recomputed it. What a candidate owes is unchanged and still checked — it exists, nothing exists beyond it, and it has not been written into the frozen manifest. Neither is in `MIGRATION_MANIFEST.json`, and `frozenThrough` remains `0045_accounting_post_entry.sql` with 46 frozen migrations. That is intentional and is what the P2-S4 gate checks: while the slice is under review a defect must be correctable **in place**, rather than consuming a P2-S5 migration number. Freezing happens on acceptance, never before.

Migrations `0000`–`0045` are byte-for-byte unchanged. Nothing after `0047` exists.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Starting accepted head (P2-S3): `18d29557be41c31cd60898d51f6f9a546201467b`
- P2-S3 freeze commit: `a6a472383ef92850b73c21e468d60b9dac707a2b`, exact-SHA workflow **35717246933**, all five jobs SUCCESS

**Evidence law.** CI SUCCESS is reported for a commit only when GitHub shows a workflow run whose head SHA is that exact commit.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

## 3. What the slice added

**Migration `0046_accounting_sources.sql`**

- `accounting_operation_kinds` — the operation-kind ↔ source-type pairing, **as data**: exactly `(post, manual_adjustment)`, `(post, opening_balance)`, `(reverse, reversal)`, with `UNIQUE (source_type)` so no source type can ever be reachable from two kinds of authority. No routine branches on a hardcoded source name.
- `accounting_manual_adjustments` — the merchant's stated reason, keyed `(business_id, id)`, bound to `accounting_source_bindings` through a deferred composite foreign key. There is no alternative source registry: AL-01's binding remains the only one.
- `accounting_reversals` — one row per reversal, `UNIQUE (business_id, original_entry_id)` and `UNIQUE (business_id, journal_entry_id)`, with composite foreign keys to `journal_entries` in both directions. A second reversal of one entry is not refused by code; it is unwritable.
- Unconditional immutability triggers on both tables, raising `accounting.source_immutable`.
- `journal_entries_reversal_complete` — a **deferred constraint trigger** requiring that any entry whose source type is `reversal` also carries its detail row by COMMIT. Without it, a `post` assertion naming source type `reversal` could drive the frozen primitive directly and produce a reversal nobody registered.
- `accounting_post_manual_adjustment(...)` — checks the pairing, requires a non-empty reason, delegates the journal write to `accounting_post_entry` unchanged, and registers the detail row in the same transaction.
- `accounting_post_reversal(...)` — **the second SECURITY DEFINER journal writer**, and the reason G-4 was widened (see §5).

**Migration `0047_accounting_opening_balances.sql`**

- `accounting_opening_balances` — AL-13's state machine as rows: `draft → posted → superseded`, a draft discardable, a `CHECK` giving each status exactly one legal column combination, and a partial `UNIQUE (business_id) WHERE status = 'posted'`.
- `accounting_opening_balance_lines` — the merchant's positions. No branch and no warehouse column exists on either table, so a branch-scoped opening balance is unrepresentable rather than merely refused.
- `accounting_opening_balances_state()` — the state trigger: identity columns immutable after posting, `status` the only mutable column, `posted → superseded` the only transition, and supersession refused with `accounting.supersede_without_reversal` unless an `accounting_reversals` row exists for the opening entry. Superseded is terminal.
- `accounting_opening_balance_entry_complete` — the deferred completeness trigger, the opening-balance twin of 0046's.
- Five commands: `accounting_open_balance_draft`, `_edit`, `_discard`, `_post`, `_supersede`. The first four are executable by `daftar_app`; supersession is not granted to any runtime role, because it happens inside posting a replacement and is reachable from nowhere else.

**`packages/accounting/src/sources.ts`** — the derivations, in the engine and not in the API: `deriveSourceId`, `mirrorReversalLines`, `computeReversalFingerprint`, `computeOpeningEquityPlug`, `deriveOpeningBalanceLines`, `computeOpeningBalanceFingerprint`.

**The merchant surface** — exactly three endpoints (§35): `POST /businesses/:id/accounting/adjustments`, `POST /businesses/:id/accounting/entries/:entryId/reversals`, `POST /businesses/:id/accounting/opening-balance`. No generic `/accounting/post`, no chart editor, no FX or period endpoint.

## 4. Enforced by this slice

| # | rule | mechanism | test | status |
|---|---|---|---|---|
| 1 | A manual adjustment is a posted entry with ≥2 balanced lines in base currency | `accounting_post_manual_adjustment` → `accounting_post_entry` | `accounting-sources.test.ts` — "posts a balanced two-line adjustment…", "refuses a single-line adjustment…" | **ENFORCED** |
| 2 | An adjustment requires a non-empty reason | `accounting.adjustment_reason_required` | "refuses an empty reason" | **ENFORCED** |
| 3 | Financial idempotency is `(business_id, source_type, source_id)`, not the HTTP key | frozen `accounting_source_bindings` uniqueness | "is idempotent on the financial identity…" | **ENFORCED** |
| 4 | A future-dated entry is refused; a backdated one is permitted | `accounting_post_entry` date policy, read from `accounting_source_types` | "refuses a future date and permits a backdated one" | **ENFORCED** |
| 5 | A posted source never mutates | unconditional immutability triggers | "never mutates after posting…" | **ENFORCED** |
| 6 | A reversal is a NEW entry; the original is byte-for-byte unchanged | no update path exists; the test snapshots before and after | "mirrors a domestic entry exactly…" | **ENFORCED** |
| 7 | `journal_entries` carries no reversal marker | no such column; gate and test both read the catalogue | "is a NEW entry bound to the original…"; `gate:phase2:s4` | **ENFORCED** |
| 8 | Reversal lines are DERIVED, never submitted | `accounting_post_reversal` takes no line parameter at all | `ports.ts` `PostReversalRequest`; "a source id cannot be swapped…" | **ENFORCED** |
| 9 | The mirror copies the original FX snapshot; today's rate is never used | lines are read from `journal_lines` and re-signed | "carries the original FX snapshot, never today's rate" | **ENFORCED** |
| 10 | A reversal works when a custom account was deactivated afterwards, without reactivating it | `accounting_post_reversal` does not apply the `is_active` rule to a derived mirror | "reverses an entry whose custom account was deactivated afterwards…" | **ENFORCED** |
| 11 | Ordinary posting is NOT weakened by rule 10 | `accounting_post_entry` unchanged | same test, second half; `accounting-sources-authority.test.ts` — "the inactive-account rule holds…" | **ENFORCED** |
| 12 | A second reversal is physically impossible and refused by name | `UNIQUE (business_id, original_entry_id)` + `accounting.reversal_exists` | "refuses a second reversal…"; "a concurrent DIFFERENT reversal loses by name, never by index" | **ENFORCED** |
| 13 | An exact retry replays instead of writing a second entry | fingerprint + date + reason equality | "replays an exact retry…" | **ENFORCED** |
| 14 | A reversal of a reversal is refused | source-type check on the original | "refuses a reversal of a reversal" | **ENFORCED** |
| 15 | Reversal requires `accounting.reverse`, never `accounting.post` | `accounting_actor(ARRAY['reverse'])`, no fallback | `accounting-sources-authority.test.ts` — "a post assertion cannot drive the reversal writer" | **ENFORCED** |
| 16 | Reversal date is `>= original` and `<= today` in the business timezone | policy read from `accounting_source_types` | "refuses a future date and one earlier than the original" | **ENFORCED** |
| 17 | One audit row and one outbox event per reversal, identifiers only | single INSERT each, in one transaction | "records exactly one reversal registration…" | **ENFORCED** |
| 18 | Exactly one POSTED opening balance per business | partial unique index | "refuses a second posted set…"; "at most one posted set survives…" | **ENFORCED** |
| 19 | `draft → posted → superseded`, and superseded is terminal | `accounting_opening_balances_state()` | "leaves superseded terminal" | **ENFORCED** |
| 20 | Supersession requires a reversal of the opening entry | DB-boundary check, `accounting.supersede_without_reversal` | "refuses supersession without a reversal…" | **ENFORCED** |
| 21 | Replacement is reverse → supersede → new source; never edit, never delete | the only path the commands expose | "replaces a posted set the only legal way" | **ENFORCED** |
| 22 | The opening equity plug is explicit and visible | derived in the engine, re-derived in the DB, compared by fingerprint | "posts a positive plug", "posts a negative plug", "posts a ZERO plug…" | **ENFORCED** |
| 23 | An opening balance is business-level with NULL branch dimensions | no branch column exists on either table | "posts at business level with NULL branch and warehouse on every line" | **ENFORCED** |
| 24 | Foreign positions carry full manual FX snapshots | `fx_rate_source IN ('base','manual')` CHECK | "carries a full manual FX snapshot for a foreign position" | **ENFORCED** |
| 25 | A position may not be stated on the equity account the plug owns | `accounting_opening_balance_check_payload` | "refuses a position on the equity account the plug owns" | **ENFORCED** |
| 26 | Source and journal commit atomically; a failure leaves nothing | one transaction, deferred completeness triggers | "leaves nothing behind when the post is refused…"; the three §44 cases | **ENFORCED** |
| 27 | An assertion is bound to its operation kind, source type, source id, business and actor | HMAC over all twelve components + DB recomputation | `accounting-sources-authority.test.ts`, five separate cases | **ENFORCED** |
| 28 | No trusted path, no skip flag, no "allow inactive" switch | none exists; the gate reads the code | "neither writer offers a bypass parameter"; `gate:phase2:s4` | **ENFORCED** |
| 29 | Every journal writer carries the full protection set (G-4 widened) | `scripts/guards/posting-surface.ts` discovers writers from the schema | `posting-surface-guard.test.ts`; `gate:phase2:s4` | **ENFORCED** |
| 30 | Every new SECURITY DEFINER routine pins `search_path` with `pg_temp` LAST (G-5) | `scripts/guards/definer-search-path.ts` | `search-path-shadowing.test.ts`; "every SECURITY DEFINER routine…pins its path" | **ENFORCED** |
| 31 | Refusals never leak SQLSTATE, index names, amounts, rates or assertions | `AccountingError.toSafeJSON()` is the only representation out | `error.filter.ts`; "a concurrent DIFFERENT reversal loses by name, never by index" | **ENFORCED** |
| 32 | Same source identity + materially different financial payload → refused, on EVERY source | `accounting_post_entry` (0045 §7) and the fingerprint comparison in `accounting_open_balance_post` | `accounting-idempotency.test.ts` — the §9 matrix, all nine acctfp/1 fields; the manual-adjustment and reversal audits | **ENFORCED** |
| 33 | A canonically equivalent retry replays rather than conflicting | acctfp/1 sorts lines and normalizes rates; nothing outside it counts | "positions submitted in a different order…", "a rate written with fewer digits…" | **ENFORCED** |
| 34 | A conflicting retry writes nothing and rewrites nothing | one transaction; the refusal precedes every write | "refuses with accounting.idempotency_conflict and adds nothing to the ledger" | **ENFORCED** |
| 35 | Two connections, one key, different payloads → exactly one financial truth | the per-business advisory lock plus the fingerprint comparison | `accounting-sources-concurrency.test.ts` — "same key, DIFFERENT payload…" | **ENFORCED** |
| 36 | Two connections, one key, same payload → one posting, one `created=true` | the same lock; the loser replays | "same key, SAME payload…" | **ENFORCED** |
| 37 | The current fingerprint always comes from the verified assertion, never a parameter | no command takes a fingerprint argument | `gate:phase2:s4` idempotency-proof check (§5) | **ENFORCED** |
| 38 | No P2-S4 row can claim a tenant that does not own its business | `(tenant_id, business_id) → businesses (tenant_id, id)` on all four business-owned tables | `accounting-ownership.test.ts` — "tenant A with tenant B's business is refused"; the §12 catalogue audit | **ENFORCED** |
| 39 | An opening-balance currency must be a currency, not a three-letter word | `base_currency` / `txn_currency` `REFERENCES currencies (code)` | "an unknown base currency is refused by the registry, not by a regex" | **ENFORCED** |
| 40 | A domestic opening position carries `fx_rate` exactly 1 and equal amounts | `accounting_opening_balance_lines_fx_ck` | "domestic with a rate that is not 1 is refused by the database" | **ENFORCED** |
| 41 | An opening position never carries a `provider` rate | the same CHECK admits only `base` and `manual` | "a provider rate source is refused outright" | **ENFORCED** |
| 42 | A merchant reversal states its own date; the server never supplies one | `entryDate` required in the DTO, the Zod schema, the service and the engine; `readBusinessToday` removed from the port | `accounting-reversal-contract.test.ts` — "a request that omits entryDate is refused" | **ENFORCED** |
| 43 | An identical reversal request replays across a civil-day boundary | the command is a pure function of the request | "the identical request replayed after the business day has advanced returns the same entry" | **ENFORCED** |
| 44 | The accounting routes exist in the composition integration tests can reach | `AppModule` and `MerchantApiModule` are held to each other | `process-composition.test.ts` | **ENFORCED** |
| 45 | A `manual_adjustment` entry owes its detail row at COMMIT | `accounting_manual_adjustment_entry_complete()` on a deferred constraint trigger | `accounting-source-completeness.test.ts` — "the statement passes, the COMMIT does not, and nothing survives" | **ENFORCED** |
| 46 | All three native sources are protected identically | the three triggers, read out of `pg_trigger` and `pg_proc` as a set | "all three native sources carry the same completeness trigger, equally deferred" | **ENFORCED** |
| 47 | A native source detail row cannot exist without its binding | three `DEFERRABLE INITIALLY DEFERRED` foreign keys to `accounting_source_bindings` | "a source detail row written without its binding cannot commit either" | **ENFORCED** |
| 48 | The generic engine path refuses the three native source types | `AccountingEngine.post` rejects before minting | `accounting-engine.test.ts` — "refuses every Phase-2-native source type on the generic posting path" | **ENFORCED** |
| 49 | Every opening-balance command takes one per-business lock, before any row lock | `accounting_opening_balance_lock_key`, read out of `pg_proc` | "every opening-balance command takes the one per-business lock, and takes it first" | **ENFORCED** |
| 50 | Two genuinely simultaneous opening balances get an accounting answer, never a lock-manager error | the lock order, plus the fingerprint comparison | `accounting-opening-balance-race.test.ts` — CASE A, B, C, all asserting no 40P01 and no `23505` | **ENFORCED** |
| 51 | A lost race leaves no orphan draft and no half-stated position | the whole command is one transaction | CASE C — the ledger is counted after the rollback | **ENFORCED** |
| 52 | An opening balance and a business's first ordinary posting do not deadlock | both take the business row `FOR UPDATE`, in the same order | CASE D | **ENFORCED** |

## 5. The one architectural decision that needs stating

**P2-S4 adds a second SECURITY DEFINER journal writer, and this was not optional.**

§15 requires that a reversal succeed when a custom account used by the original was later deactivated — without reactivating it, without routing elsewhere, and without weakening ordinary posting. The frozen `accounting_post_entry` refuses every line naming an inactive account, and that refusal is exactly right for a new entry: a merchant should not be able to post today into an account they retired. It is exactly wrong for a mirror, whose accounts were chosen when the original was posted and are not being chosen again now.

Those two rules cannot live in one routine without a flag, and a flag is the bypass §38 forbids. So the reversal became its own writer, which is the case §21 anticipates — and §21's condition was met in full: **G-4 no longer protects a named primitive, it discovers every routine in the schema capable of a journal write and requires the whole protection set of each one.** `journalWriters()` finds both writers today; if a third ever appears, it is held to the same standard on the commit that introduces it, or CI fails.

The opening balance, by contrast, rides the hardened primitive unchanged. It needed no relaxation, so it got none.

## 6. Transport idempotency — the gap, stated

§11 permits reusing Phase 1's request-identity mechanism if a reusable one exists. It does not. Phase 1's `onboarding_operations` is scoped to onboarding operations and keyed to their own lifecycle; it is not a general business-scoped command registry, and widening it would have made an onboarding table the arbiter of accounting identity.

The smallest durable thing that works instead: the source id is **derived** from `(business_id, Idempotency-Key)` by `deriveSourceId` — a SHA-256 to a stable v5-shaped UUID. The existing `(business_id, source_type, source_id)` uniqueness then does the whole job, so there is no parallel cache and no second answer to "has this already happened".

The HTTP `Idempotency-Key` remains **transport only**. It is not the financial identity, and it is not stored as one.

The contract, stated exactly:

| the retry | the answer |
|---|---|
| same key, same financial payload | the existing entry, `created: false`, no second journal, binding, source, audit or outbox row |
| same key, **materially different** financial payload | `accounting.idempotency_conflict` |
| same key, narrative-only difference (description, request id) | the existing entry, `created: false` — and the posted narrative is **not** rewritten |
| same key twice at once | one creates; the other replays or conflicts by the same rule |

"Materially different" is exactly `acctfp/1` and nothing wider: the fields the canonical fingerprint carries. Reordered positions and a rate written with fewer digits are the *same* fact, because acctfp/1 sorts lines by their canonical bytes and normalizes a rate to ten fraction digits — so they replay, and the tests pin that too. This wording is deliberately no stronger than the fingerprint contract that enforces it.

## 6a. The correction this slice needed (§2–§5, §29)

The first revision of `accounting_open_balance_post` got this wrong, and it is worth writing down plainly rather than quietly fixing.

The routine short-circuited on an already-posted source:

```sql
IF v_status = 'posted' THEN
  RETURN QUERY SELECT v_entry, false;   -- before proving WHICH command this was
END IF;
```

So a merchant who re-sent one `Idempotency-Key` with a different opening position was told **success**, and handed back the position they had just tried to change. `accounting_post_entry` had always compared the signed fingerprint to the entry it already held (0045 §7) and refused `accounting.idempotency_conflict` — but this path returned before the primitive was ever reached, so the guarantee the rest of the slice rests on was simply skipped here.

The fix lives at the **database command boundary**, not in NestJS: a direct caller of the trusted command is owed the same guarantee as the HTTP caller, and a guarantee that lives in an `if` above the database is a guarantee only for callers who go through that `if`. Before replaying, the routine now loads the existing entry by **composite** identity `(business_id, journal_entry_id)`, requires it to be this opening balance's own entry (`source_type`, `source_id` and `entry_date` all agree with the source row), and requires its persisted `posting_fingerprint` to equal `v_actor.posting_fingerprint` — the fingerprint `accounting_actor` verified out of the HMAC-signed assertion. There is deliberately **no** `p_fingerprint` parameter: a fingerprint the caller could choose is a fingerprint the caller could match.

Two things the fix deliberately does **not** do:

- It does not repair the stored source to match the newest request. The `draft` call preceding `post` leaves a posted source's positions alone, and must: rewriting them so a key becomes reusable is the silent rewrite of history this slice exists to prevent (§19). The first committed financial fact wins; conflict is the correct answer.
- It does not re-derive the *submitted* payload's fingerprint inside `post`. It could not do so honestly — `post` never receives the new payload, only the persisted one — and reaching for it would have meant duplicating the plug arithmetic in a second place, which is a second source of truth about what the entry is. Comparing the verified assertion fingerprint is the strongest comparison available without inventing one.

`تصحيح: كان الرصيد الافتتاحي يعيد القيد القديم بصمت عند إعادة إرسال نفس مفتاح Idempotency بمبلغ مختلف. الآن يقارن البصمة المالية الموقَّعة بالبصمة المحفوظة قبل أي إعادة، ويرفض بـ accounting.idempotency_conflict عند الاختلاف.`

## 6b. Early-return self-review (§24)

Every exit point in the five commands, asked one question: *could this return success for the same source while the financial payload differs?*

| routine | exit point | verdict |
|---|---|---|
| `accounting_post_manual_adjustment` | `ON CONFLICT (business_id, id) DO NOTHING` on the detail row | **No** — narrative only; the financial decision was already made by `accounting_post_entry`, and the reason is deliberately not rewritten on replay (§16) |
| `accounting_post_manual_adjustment` | final `RETURN QUERY` | **No** — returns whatever the primitive decided, and the primitive conflicts on a different fingerprint |
| `accounting_post_reversal` | replay of an existing reversal | **No** — reached only after the assertion fingerprint was required to equal the freshly derived mirror, and guarded by fingerprint **and** date **and** reason equality |
| `accounting_post_reversal` | final `RETURN QUERY … true` | **No** — only after the insert |
| `accounting_open_balance_draft` | draft re-stated (→ `edit`) | **No** — returns an id, never an entry; nothing financial is confirmed here |
| `accounting_open_balance_draft` | posted or superseded source | **No** — returns an id and deliberately leaves the stored positions alone; `post` is what answers, and `post` now compares |
| `accounting_open_balance_draft` | fresh draft inserted | **No** — returns an id |
| `accounting_open_balance_post` | replay of a posted source | **This was the defect.** Now compares the verified assertion fingerprint to the persisted one and raises `accounting.idempotency_conflict` on any difference |
| `accounting_open_balance_post` | final `RETURN QUERY` | **No** — only after the primitive posted, and the primitive made the same comparison |
| `accounting_open_balance_edit` | — | **No** — refuses anything but `draft` |
| `accounting_open_balance_supersede` | — | **No** — no early return; refuses anything but `posted`, and only with an existing reversal |

Zero remaining cases where a material financial difference returns success.

**Re-audited in the second review round (§13).** Every return path above was walked again after the corrections. The `accounting_open_balance_post` fingerprint comparison is intact and is still the only gate on that path; no command accepts a caller-supplied fingerprint; no conflicting retry repairs the stored source. One detail worth stating: `accounting_post_reversal`'s replay compares with `=` rather than `IS DISTINCT FROM`, and that is safe here — a NULL persisted fingerprint makes the condition NULL, the replay branch is not taken, and the call falls through to `accounting.reversal_exists`. It fails closed.

## 6c. The second review round — ownership, FX shape and a date the server chose

Three defects, all found by the Tech Lead reading the candidate rather than by any test, because no test asked these questions. Each is written out here with what was actually wrong, not just what changed.

### A. A position could disown its tenant

`accounting_opening_balance_lines` proved that a line belonged to an opening balance of its business — and said nothing about its `tenant_id` column. The three other tables this slice added all carry `(tenant_id, business_id) → businesses (tenant_id, id)`; this one did not, so a row could name one tenant while belonging to another tenant's business and the database would accept it.

The defence in place was that only the routines in `0047` write these rows, and they copy the tenant from `businesses` after verifying it. That is true today and is not the point: the table outlives every writer that exists now, and a cross-tenant row in a ledger is the one defect that cannot be corrected after the fact. Application correctness is not a substitute for database ownership integrity. The constraint is now there, and `accounting-ownership.test.ts` proves it by writing **as the schema owner** — a test that connected as a runtime role would stop on "permission denied" and prove nothing about the constraint it claims to test.

The same question was then asked of all four tables from `pg_constraint` rather than from the migration text, so a table that gains a tenant column later must gain the constraint with it. The audit found `accounting_manual_adjustments`, `accounting_reversals` and `accounting_opening_balances` already correct; the gap was `accounting_opening_balance_lines` alone. `0046` therefore needed no change.

### B. The draft could hold an FX snapshot the journal would refuse

Two gaps, and one overclaim.

`ILS → ILS, base 100, txn 100, source 'base', rate 2.0` was writable as a draft. `journal_lines` has always refused it — a domestic line must carry `fx_rate = 1` — so the merchant would have stated a position the ledger rejected only at posting time. And the currency columns checked a **shape**, `^[A-Z]{3}$`, so `ZZZ` was a perfectly good currency as far as the draft was concerned, while `journal_lines` has always referenced the canonical `currencies` registry.

The overclaim was the comment above the constraint, which called it "the same shape `journal_lines` requires". It was not, and a comment that asserts an invariant the code does not enforce is worse than no comment: it is what a later reader trusts instead of checking.

Both columns now `REFERENCES currencies (code)`, the domestic branch requires `fx_rate = 1` with equal amounts and the `base` source, the foreign branch requires a genuinely different currency at a positive `manual` rate, and `provider` remains impossible — there is no rate feed for a date that predates the merchant's arrival.

What the constraint deliberately still does **not** do is check that `txn_amount_minor × fx_rate` equals `base_amount_minor`. That conversion is HALF_EVEN at the currency's own minor-unit scale and it has exactly two authorities: the posting engine, which computes it, and the frozen P2-S2 journal validator, which proves it at COMMIT. A third copy here would be a second source of arithmetic truth, and the copy that drifts is the one nobody posts through. This is stated plainly in the migration so the next reader does not have to infer it.

### C. The reversal date was the server's, so the retry was not the merchant's

A reversal carries no `Idempotency-Key`: the original entry's id **is** its source identity, so an identical request is meant to replay. That only holds if the command is a pure function of the request — and `entryDate` was optional, filled in with "today in the business's timezone" when omitted. The fingerprint covers the entry date. So the signed fact depended on *when the request arrived*.

This was reproduced end to end before it was fixed, and the reproduction is worth recording:

```
POST …/reversals   { "reason": "a considered correction" }
  → 201  { "created": true }                              (business day 2026-09-22)

business's civil day advances

POST …/reversals   { "reason": "a considered correction" }   ← byte-identical
  → 409  accounting.reversal_exists
```

The merchant changed nothing and was refused. That is the failure mode an at-least-once client hits when a network timeout lands near local midnight: it cannot safely retry, and it cannot find out what happened.

**The Tech Lead's decision was to make `entryDate` required**, and it is now required at the DTO, the Zod schema, the service and the engine input. `accounting-reversal-contract.test.ts` proves it through the real HTTP endpoint — the real validation pipe, the real permission guard, the real engine, the real database — including the replay across a civil-day boundary, simulated by moving the business between `Pacific/Honolulu` (UTC−10) and `Pacific/Kiritimati` (UTC+14), which are a full day apart at every instant. The test does not wait for midnight.

**The exact choice about the database, documented as §8 asks.** `accounting_post_reversal` in `0046` still accepts `p_entry_date := NULL` and resolves it to the business's today. `0046` is frozen by directive at the reviewed digest, so tightening the routine itself was not available — and §8's own fallback permits retaining NULL internally provided it is unreachable from the merchant boundary. Rather than rely on that as a convention, the seam was **removed**: `readBusinessToday` is gone from `AccountingLedgerReader`, from its database adapter and from the port interface entirely. `AccountingEngine.reverse` now has no way to learn what day it is, so it structurally cannot pass NULL, and a future caller cannot quietly reintroduce a clock-dependent command because there is nothing left to call. The gate checks both halves: the contract requires the date, and none of the four files on that path mentions the removed method.

### D. Found while reproducing C: the accounting routes were untestable

Every HTTP case answered `404` at first. `AccountingController` had been registered in `MerchantApiModule` (what production runs) and never in `AppModule` (what development and **every integration test** compose). The three merchant accounting endpoints therefore existed in no composition a test could reach, which is why the boundary contract in C was never exercised from outside and the defect survived a green gate.

This was not in the directive — it was found by executing it. `AppModule` now composes `AccountingController`, and `process-composition.test.ts` holds the two module definitions to each other permanently: everything the merchant process serves, the single process serves too, plus exactly one named exception (`AdminController`, which the merchant process must never carry).

`الجولة الثانية من المراجعة صحّحت ثلاثة عيوب: سطر الرصيد الافتتاحي كان يستطيع ادّعاء مستأجر لا يملك النشاط، ومسودّة الرصيد كانت تقبل عملة غير مسجَّلة وسعر صرف محلي غير 1، وتاريخ قيد العكس كان اختياريًا فيحدّده الخادم من ساعته — فتفشل إعادة الإرسال نفسها بعد منتصف الليل المحلي. التاريخ صار إلزاميًا، وأُزيلت من المحرّك إمكانية قراءة "اليوم" أصلًا. كما تبيّن أن مسارات المحاسبة لم تكن مُركَّبة في بيئة الاختبار، وهذا سبب عدم اكتشاف العيب الثالث سابقًا.`

## 6d. The third review round — a source that owed nothing, and a race nobody had run

### A. A manual adjustment could exist with no reason and no actor

`journal_entries` carried a deferred completeness trigger for `reversal` and another for `opening_balance`: an entry of either type must have its detail row by COMMIT. `manual_adjustment` had none.

That asymmetry was the whole defect. `accounting_post_entry` is generic by design — it posts whatever source type the verified assertion names, which is what lets a later phase's sale be a thin derivation in front of one hardened primitive. An assertion for `post` / `manual_adjustment` is not a forgery; it is exactly the assertion `accounting_post_manual_adjustment` carries. So anyone holding one could drive the primitive **directly** and get an entry, its lines, its binding, its audit row and its outbox row while `accounting_manual_adjustments` stayed empty. The adjustment would sit in the ledger with no reason and no actor: the one source whose entire justification is "a person decided this" was the one source that recorded neither who nor why. "A manual adjustment requires a reason" was a convention about which function people called, not an invariant.

And nobody had to be hostile to get there. `@daftar/accounting` offers `post()` beside `adjust()` and takes the source type as a string; a domain written next year reaches for the general one.

Reproduced first, as a permanent regression: a real assertion, the real primitive, the real runtime role. Before the fix the statement succeeded **and so did the COMMIT**. After it the statement still succeeds — that is what DEFERRED means, and asserting it is what distinguishes a completeness rule from a `NOT NULL` that would have stopped the INSERT — and the COMMIT fails with `accounting.adjustment_detail_missing`, leaving zero entries, lines, bindings, detail rows, audit rows and outbox rows.

`accounting_manual_adjustment_entry_complete()` is the twin of the other two: SECURITY DEFINER, owned by `daftar_accounting_internal`, `pg_temp` last, installed as a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `journal_entries`. With `accounting_manual_adjustments_binding_fk` in the other direction, neither end can be an orphan.

The engine refuses it too, one layer earlier: `AccountingEngine.post` now rejects all three native source types by name, before minting anything. That is a convenience, not the guarantee — TypeScript is not a constraint, and the database is what actually holds. Its consequence is that the generic path has no legitimate caller in Phase 2, because the closed registry holds exactly the three types this slice owns. Every suite that had been building fixtures through it now builds them through the command that owns the source, which is how the application builds them.

### B. The opening-balance concurrency tests were not concurrent

The earlier cases held two connections and used them in sequence: `await` the whole of A's command, then start B, then commit A. Everything A could lock, A had locked before B existed. What they proved is that a transaction blocks behind a finished statement — worth keeping, and not the race.

Run as a real race, two defects appeared immediately, both as `deadlock detected`:

`accounting_open_balance_draft` read the existing status and then INSERTed with nothing serializing the decision. Two simultaneous requests carrying the same `Idempotency-Key` derive the **same** source id, so both could read "no draft here" and both go on to write it.

And the lock order was inverted. Every command took `businesses FOR SHARE` and only then the per-business advisory lock. SHARE does not conflict with SHARE, so two opening balances could both hold the business row before one queued behind the other's advisory lock — and the advisory-lock holder then called `accounting_post_entry`, which takes that row **FOR UPDATE** for a business's first posting, and waited for the SHARE lock the blocked transaction still held. Neither could move. A merchant received a 40P01 where the accounting answer was `accounting.opening_balance_exists`.

The fix is the order, not a retry. All five commands — draft, edit, discard, post, supersede — now take one `accounting_opening_balance_lock_key(business)` advisory lock FIRST, then the business row **FOR UPDATE**, then the source row. A transaction without the advisory lock holds nothing for the advisory-lock holder to wait behind, and taking the strong mode once means there is no upgrade to perform. An opening balance is stated about once in a business's life; serializing it costs nothing anybody will measure.

The new matrix launches both commands before either transaction commits and then refuses to proceed until PostgreSQL reports one of **its own two backends** waiting on a lock — the barrier is also the evidence, and a case where the two never met fails rather than passing quietly. Six cases: same key/same payload, same key/different payload, different keys, against a first ordinary posting, against a base-currency change, against a timezone change. Every one asserts that no deadlock, serialization failure, statement timeout, duplicate key or index name reaches the caller.

### C. What the fixtures were doing

Making the completeness rule real broke a number of existing suites, and the reason is worth recording rather than smoothing over: they built their fixtures by driving the generic primitive with `manual_adjustment` — the bypass itself. The shared helper now routes a `manual_adjustment` through `accounting_post_manual_adjustment`, which forwards the same assertion and the same payload to the primitive unchanged, so every property those suites prove about it is proved exactly as before. The raw-SQL fixtures in the journal and RLS matrices write the detail row themselves, so the journal invariant under test stays the only thing that can refuse.

`الجولة الثالثة صحّحت عيبين. الأول: قيد التسوية اليدوية لم يكن مُلزَمًا بسجل السبب والفاعل، فكان يمكن كتابته عبر الدالة العامة بلا سبب ولا فاعل — وهي الحالة الوحيدة التي مبرّرها كلّه "قرار إنسان". صار القيد يسقط عند COMMIT إن غاب السجل، كما هو الحال في المصدرين الآخرين منذ البداية. الثاني: اختبارات التزامن للرصيد الافتتاحي لم تكن متزامنة فعلًا، وعند تشغيلها كسباق حقيقي ظهر تعارض ترتيب أقفال ينتهي بـ deadlock. أُعيد ترتيب الأقفال في الأوامر الخمسة كلها: قفل واحد لكل نشاط أولًا، ثم صفّ النشاط بـ FOR UPDATE، ثم صفّ المصدر. الاختبارات الجديدة لا تمرّ إلا إذا تصادم الأمران فعلًا.`

## 7. What this slice deliberately did NOT build

| deferred | why |
|---|---|
| FX rate registry | §7 — a later slice |
| Accounting periods / close | §7 |
| Trial balance, balances, any financial read model | §7 |
| Merchant accounting UI | §7 |
| Inventory, purchases, sales, POS, customers, payments, suppliers | §7 |
| Any source type beyond the three | §7; `accounting_source_types` is a closed registry |
| A `0048` migration | §7 and §59 |

The P2-S4 gate fails if any of the first five appears, so this is a checked claim and not a promise.

## 8. Hard stop

Per §59: 0046 and 0047 are **not** frozen, there is no 0048, P2-S5 has not begun, and no FX registry, period machinery, trial balance or merchant accounting UI exists. The slice waits for independent Tech Lead review.

`حسب البند ٥٩: لم تُجمَّد 0046 و0047، ولا توجد 0048، ولم تبدأ P2-S5. الشريحة تنتظر مراجعة القيادة التقنية.`
