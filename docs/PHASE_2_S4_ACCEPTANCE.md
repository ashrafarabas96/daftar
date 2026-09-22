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
| `0046_accounting_sources.sql` | `347faf5063205f9acf71848cb369444f9e03ef11d65cb038e79549e19af0e4e0` | CANDIDATE |
| `0047_accounting_opening_balances.sql` | `975768714affba8719a6cbc8f492b25f7c88ea686c1a4e692b221eed6c3f2f65` | CANDIDATE |

Neither is in `MIGRATION_MANIFEST.json`, and `frozenThrough` remains `0045_accounting_post_entry.sql` with 46 frozen migrations. That is intentional and is what the P2-S4 gate checks: while the slice is under review a defect must be correctable **in place**, rather than consuming a P2-S5 migration number. Freezing happens on acceptance, never before.

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

## 5. The one architectural decision that needs stating

**P2-S4 adds a second SECURITY DEFINER journal writer, and this was not optional.**

§15 requires that a reversal succeed when a custom account used by the original was later deactivated — without reactivating it, without routing elsewhere, and without weakening ordinary posting. The frozen `accounting_post_entry` refuses every line naming an inactive account, and that refusal is exactly right for a new entry: a merchant should not be able to post today into an account they retired. It is exactly wrong for a mirror, whose accounts were chosen when the original was posted and are not being chosen again now.

Those two rules cannot live in one routine without a flag, and a flag is the bypass §38 forbids. So the reversal became its own writer, which is the case §21 anticipates — and §21's condition was met in full: **G-4 no longer protects a named primitive, it discovers every routine in the schema capable of a journal write and requires the whole protection set of each one.** `journalWriters()` finds both writers today; if a third ever appears, it is held to the same standard on the commit that introduces it, or CI fails.

The opening balance, by contrast, rides the hardened primitive unchanged. It needed no relaxation, so it got none.

## 6. Transport idempotency — the gap, stated

§11 permits reusing Phase 1's request-identity mechanism if a reusable one exists. It does not. Phase 1's `onboarding_operations` is scoped to onboarding operations and keyed to their own lifecycle; it is not a general business-scoped command registry, and widening it would have made an onboarding table the arbiter of accounting identity.

The smallest durable thing that works instead: the source id is **derived** from `(business_id, Idempotency-Key)` by `deriveSourceId` — a SHA-256 to a stable v5-shaped UUID. The existing `(business_id, source_type, source_id)` uniqueness then does the whole job, so there is no parallel cache and no second answer to "has this already happened". Same key + same request returns the same source; same key + different request conflicts on the fingerprint; concurrent same key yields one source.

The HTTP `Idempotency-Key` remains **transport only**. It is not the financial identity, and it is not stored as one.

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
