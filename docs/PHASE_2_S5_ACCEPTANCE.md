# DAFTAR — P2-S5 Acceptance / قبول الشريحة الخامسة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S5 — FX rate foundation**, submitted as a **CANDIDATE for Tech Lead review**. It states what is enforced by a mechanism and covered by a test, and, just as deliberately, what is not.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S5، مقدَّمة للمراجعة ولم تُقبل بعد. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. تبني هذه الشريحة سجلًّا لأسعار الصرف يكتبه التاجر بنفسه ولا يُعدَّل بعد كتابته، وأداتين حسابيتين خالصتين تقرران الحساب دون أن ترحّلا شيئًا. لا مزوّد أسعار، ولا فترات محاسبية، ولا تقارير.

## 0. The one sentence that matters

**P2-S5 records what a business SAID a rate was, at an instant that business chose, and never computes, infers, inverts, chains or refreshes one.**

A rate is entered, not fetched. There is no network dependency anywhere in the slice — no provider, no cache, no scheduled refresh, no fallback. The lookup answers exactly one question: *what is the latest rate this business stated for this exact ordered pair, at or before this instant?* If nobody stated one, the answer is a refusal by name, never an implicit 1, never the nearest rate, never the reciprocal, and never a cross-rate through a third currency.

`سعر الصرف يُدخَل ولا يُجلَب. لا مزوّد ولا شبكة ولا تحديث تلقائي. البحث يجيب سؤالًا واحدًا: ما آخر سعر أعلنته هذه المنشأة لهذا الزوج بهذا الاتجاه عند تلك اللحظة أو قبلها؟ وإن لم يوجد، يكون الجواب رفضًا باسمه لا رقمًا مُخترعًا.`

## 1. Candidate migration — P2-S5 is UNDER REVIEW

| migration | SHA-256 | state |
|---|---|---|
| `0048_accounting_fx_rates.sql` | `5438538a9f335c918b231db3faa94dd4eac7b71a1a688d1c62b5cda9f8ee4cc1` | **CANDIDATE — not frozen** |

`MIGRATION_MANIFEST.json` still records **48 frozen migrations** with `frozenThrough = 0047_accounting_opening_balances.sql`, exactly where P2-S4's acceptance left it. `0048` is deliberately absent from it: a candidate is corrected **in place** while it is under review, and freezing it before a Tech Lead has read it would turn the first draft into history. `npm run gate:phase2:s5` enforces both halves of that — the boundary must not move, and `0048` must not appear in the manifest — and those two checks invert on the day the slice is accepted, exactly as P2-S4's did.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Starting accepted head (P2-S4): `2987fbe914645ebae600e95a126c908472f04e1b`, exact-SHA workflow **35775902377**, all five jobs SUCCESS
- P2-S4 freeze commit: `9a503b029c705a4e290cf737c244bcdd35ef67db`, exact-SHA workflow **35779530630**, all five jobs SUCCESS
- P2-S5 candidate head: recorded in the handoff message for this submission, with its own exact-SHA workflow

**Evidence law.** CI SUCCESS is reported for a commit only when GitHub shows a workflow run whose head SHA is that exact commit.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

## 3. What the slice added

**Migration `0048_accounting_fx_rates.sql`** (one migration; there is no `0049`)

- `accounting_fx_rates` — the append-only history. `rate NUMERIC(20,10)` (AL-09's type, the same one `journal_lines.fx_rate` carries), `source` pinned by CHECK to the single value `'manual'`, `effective_at TIMESTAMPTZ` constrained to whole UTC seconds, and a composite `(tenant_id, business_id) → businesses (tenant_id, id)` so no row can claim a tenant that does not own its business. Both currency columns `REFERENCES currencies (code)`. There is **no** `status`, `is_current`, `superseded_by` or `last_used_at` column: a rate is not a setting that changes.
- `UNIQUE (business_id, from_currency, to_currency, effective_at)` — one business, one ordered pair, one instant, one truth. It is also the slice's **only** index: its leading columns are exactly the lookup's predicate followed by its `ORDER BY … DESC LIMIT 1`, and PostgreSQL reads a B-tree backwards as happily as forwards.
- `accounting_fx_rates_immutable()` on a `BEFORE UPDATE OR DELETE` trigger, raising `accounting.fx_rate_immutable` **unconditionally** — with no identity exemption, so the schema owner is refused too.
- `accounting_control_actor(TEXT[])` — the verifier for a **second** assertion format on the existing key material (§29). See §5.
- `accounting_fx_rate_canonical(...)` / `accounting_fx_rate_fingerprint(...)` — the `fxrate/1` canonical byte stream and its SHA-256, the PostgreSQL half of a specification whose TypeScript half is `packages/accounting/src/fx-rate.ts` and whose single vector source is `packages/accounting/vectors/fxrate-vectors.json`.
- `accounting_fx_rate_lock_key(...)` / `accounting_fx_rate_identity_lock_key(...)` — two narrow, deterministic advisory keys. Neither is business-wide: entering a USD rate does not block entering a EUR one, and neither blocks a posting.
- `accounting_fx_rate_enter(...)` — the **only** write path. `SECURITY DEFINER`, owned by `daftar_accounting_internal`, `EXECUTE` granted to `daftar_app` alone. The rate arrives as **TEXT**, so a value outside the contract is refused before any numeric cast can round it.
- `accounting_fx_rate_lookup(...)` — the deterministic read. Deliberately **not** `SECURITY DEFINER`: running as the caller is what makes cross-business isolation row level security's answer rather than this function's arithmetic. It is `STABLE` and writes nothing at all.

**`packages/accounting/src/fx-rate.ts`** — `fxrate/1`: the canonical stream, the fingerprint, `deriveFxRateId`, and `canonicalEnteredRate`, which **refuses** an out-of-contract rate rather than rounding it.

**`packages/accounting/src/control-assertion.ts`** — the `acctctl/1` format: eleven components, a 60-second TTL, and a MAC computed over a **domain-prefixed** preimage.

**`packages/accounting/src/realized-fx.ts`** — `classifyRealizedFx`: a pure `BigInt` function that decides whether a settlement difference is a gain or a loss and returns `{ systemKey, side, amountMinor }` or `null`. It posts nothing.

**`packages/accounting/src/rounding.ts`** — `classifyRoundingResidual`: the same shape for an allocation residual, whose only account is `rounding`, whose balancing side the caller must state, whose magnitude is bounded by the allocation count, and which requires a non-empty reason.

**The merchant surface** — one new endpoint: `POST /v1/businesses/:businessId/accounting/fx-rates`, permission `accounting.fx.manage`, `Idempotency-Key` required. No list route, no update, no delete, and no read endpoint at all: the lookup exists for the domains that will copy a snapshot into a journal line, and nothing in P2-S5 exposes it over HTTP.

## 4. Enforced by this slice

| # | rule | mechanism | test | status |
|---|---|---|---|---|
| 1 | A rate is entered manually; nothing fetches one | no provider table, no HTTP client, no scheduler anywhere in the slice | `gate:phase2:s5` scope checks | **ENFORCED** |
| 2 | `source` can only ever be `manual` | `CHECK (source = 'manual')` + the command hardcodes it | `accounting-fx-rates.test.ts`; `accounting-fx-http.test.ts` — "is stored with the server-fixed source" | **ENFORCED** |
| 3 | A rate row cannot claim a tenant that does not own its business | composite `(tenant_id, business_id)` foreign key | `accounting-fx-rates.test.ts` — cross-tenant insert refused | **ENFORCED** |
| 4 | Both currencies must be registered currencies | `REFERENCES currencies (code)` + `accounting.fx_currency_unknown` | "a well-formed code that is not a registered currency" — `ZZZ` matches `[A-Z]{3}` and is still refused | **ENFORCED** |
| 5 | A currency has no rate against itself | `CHECK (from_currency <> to_currency)` + `accounting.fx_same_currency` | `accounting-fx-rates.test.ts`; the HTTP matrix | **ENFORCED** |
| 6 | The rate is `NUMERIC(20,10)`, strictly positive, never a float | `CHECK (rate > 0)`; guard G-2 fails CI on any float or under-scaled rate in an `accounting_*` table | `accounting-guards.test.ts`; `gate:phase2:s5` | **ENFORCED** |
| 7 | A rate crosses HTTP as a STRING and is REFUSED, never rounded, if it exceeds ten fraction digits | `fxRateString` at the edge; the command takes TEXT and validates the shape before casting | `accounting-fx-http.test.ts` — the seventeen-case rate matrix (JSON number, exponent, NaN, negative, zero, eleven digits…) | **ENFORCED** |
| 8 | `effective_at` is UTC at whole-second precision, physically | `CHECK (date_trunc('second', effective_at) = effective_at)` + `accounting.fx_effective_at_precision` | `accounting-fx-rates.test.ts`; the HTTP instant matrix | **ENFORCED** |
| 9 | One business, one pair, one instant, one truth | `UNIQUE (business_id, from_currency, to_currency, effective_at)` | `accounting-fx-rates.test.ts`; `accounting-fx-concurrency.test.ts` | **ENFORCED** |
| 10 | A stated rate can never be updated or deleted, by anyone | unconditional `BEFORE UPDATE OR DELETE` trigger, **plus** the absence of the grant | `accounting-fx-rates.test.ts` — the mutation cases run as the **schema owner**, the one principal no privilege check can stop | **ENFORCED** |
| 11 | A correction is a NEW rate at a later instant | no update path exists at all | the same cases | **ENFORCED** |
| 12 | A lookup never returns the reciprocal | the query filters on the exact ordered pair; the gate refuses any division in the routine | `accounting-fx-rates.test.ts` — "reciprocal" cases | **ENFORCED** |
| 13 | A lookup never infers a cross-rate | it reads the registry exactly once; the gate counts the reads | "cross-rate" cases | **ENFORCED** |
| 14 | A lookup never substitutes an implicit 1 for a foreign pair | `accounting.fx_rate_missing`; the gate refuses any `coalesce` onto 1 | "implicit 1" cases | **ENFORCED** |
| 15 | A lookup never returns a future rate | `effective_at <= p_at`, `ORDER BY … DESC LIMIT 1` | the §46 matrix | **ENFORCED** |
| 16 | A lookup never returns another business's rate | RLS, with the routine running as the CALLER | the cross-business cases, under the merchant scope | **ENFORCED** |
| 17 | Reading a rate mutates nothing | `STABLE`, and no write statement exists in the routine | `gate:phase2:s5`; the snapshot cases | **ENFORCED** |
| 18 | The snapshot a caller gets is complete: rate, source, instant, id | `accounting_fx_rate_snapshot` composite type | `accounting-fx-rates.test.ts` | **ENFORCED** |
| 19 | No login role may INSERT, UPDATE or DELETE a rate | the grant model; one runtime role holds `SELECT` and nothing else | `journal-privilege-matrix.test.ts` (the live matrix against the model) | **ENFORCED** |
| 20 | Exactly one elevated write path exists, granted to the merchant runtime alone | `accounting_fx_rate_enter`, owned by `daftar_accounting_internal`, no PUBLIC EXECUTE | `accounting-fx-authority.test.ts`; `migration-portability.test.ts` | **ENFORCED** |
| 21 | Every SECURITY DEFINER routine pins `search_path` with `pg_temp` LAST (G-5) | `scripts/guards/definer-search-path.ts` | `search-path-shadowing.test.ts`; `gate:phase2:s5` | **ENFORCED** |
| 22 | A GUC is a transport, never an authorization | the actor, tenant, business and rate id come from the verified assertion only | `accounting-fx-authority.test.ts` — the spoofed-GUC cases | **ENFORCED** |
| 23 | Entering a rate registers no source type and writes no journal entry | nothing in `0048` touches `accounting_source_types` or the journal | `gate:phase2:s5`; `migration-upgrade.test.ts` | **ENFORCED** |
| 24 | A posting assertion cannot be substituted for a control assertion, or the reverse | the two preimage sets are **disjoint**: `acctctl/1` prefixes its MAC with a domain label containing `/` and `\n`, neither of which can occur in a posting preimage | `accounting-fx-authority.test.ts` — "both directions" | **ENFORCED** |
| 25 | A control assertion is single-use and expires in 60 seconds | `accounting_assertion_uses` (jti → first transaction) + the TTL bound | the replay and expiry cases | **ENFORCED** |
| 26 | Tampering with any claim invalidates the assertion | HMAC over all ten claims | the ten-case tamper matrix | **ENFORCED** |
| 27 | `fxrate/1` is byte-identical in TypeScript and PostgreSQL | one specification, two implementations, one vector file | `accounting-fx-parity.test.ts` — canonical bytes **and** digest, per vector | **ENFORCED** |
| 28 | `1`, `1.0` and `1.0000000000` are one rate | canonicalization to ten fraction digits, in both implementations | `fx-rate.test.ts`; `accounting-fx-parity.test.ts` | **ENFORCED** |
| 29 | A sub-one rate keeps its leading digit in both implementations | the SQL mask `FM9999999990.0000000000` | `accounting-fx-parity.test.ts` — `0.709` → `0.7090000000`, never `.7090000000` | **ENFORCED** |
| 30 | The rate id is derived from `(business_id, Idempotency-Key)` under its own domain label | `deriveFxRateId` | `fx-rate.test.ts`, with `deriveSourceId`'s pre-refactor value re-pinned so P2-S4 identities are provably unchanged | **ENFORCED** |
| 31 | Same key + same payload → the existing row, `created: false` | the identity branch of the command | `accounting-fx-http.test.ts`; `accounting-fx-concurrency.test.ts` | **ENFORCED** |
| 32 | Same key + different payload → `accounting.idempotency_conflict` | the same branch | the HTTP and concurrency matrices | **ENFORCED** |
| 33 | Two keys, same pair and instant, identical rate → the existing row, no second audit or outbox row | the pair branch | `accounting-fx-concurrency.test.ts` | **ENFORCED** |
| 34 | Two keys, same pair and instant, different rate → `accounting.fx_rate_conflict`, never an overwrite | the same branch, plus the unique constraint as the physical backstop | the HTTP and concurrency matrices | **ENFORCED** |
| 35 | Genuine concurrency produces an accounting answer, never `23505`, a constraint name, a deadlock or a serialization failure | two narrow advisory locks in a fixed order (identity first), plus the mapped `unique_violation` handler | `accounting-fx-concurrency.test.ts` — two real connections, both backend pids observed waiting | **ENFORCED** |
| 36 | `entered_by_user_id` comes from verified authority, never from a payload | the command reads it from `accounting_control_actor` | `accounting-fx-http.test.ts` — the row's actor is the authenticated user; the DTO has no such field | **ENFORCED** |
| 37 | The route requires `accounting.fx.manage`, not `accounting.post` | `@RequiresPermission` | `accounting-fx-http.test.ts` | **ENFORCED** |
| 38 | A branch-scoped member may not set a rate **even holding the permission** | a separate `branch_scope_mode === 'all'` check in the service | "refuses a BRANCH-SCOPED member who does hold accounting.fx.manage", then accepts the same member once widened | **ENFORCED** |
| 39 | The path business must be the business the membership resolved | `sameBusiness` | "refuses a path business that is not the business the membership resolved" | **ENFORCED** |
| 40 | The payload is strict: an unknown field is refused, never ignored | `.strict()` Zod schema | the six unknown-field cases, including `source`, `enteredByUserId`, `tenantId`, `businessId` and `rateId` | **ENFORCED** |
| 41 | Exactly one audit event per accepted entry, carrying no rate value | one `INSERT INTO audit_events`, identifiers and labels only | `accounting-fx-concurrency.test.ts` — the audit shape; `gate:phase2:s5` | **ENFORCED** |
| 42 | Exactly one outbox event per accepted entry, carrying no rate value | one `INSERT INTO outbox_events` | the same | **ENFORCED** |
| 43 | An audit or outbox failure rolls the rate back | one transaction; proved by injecting a failing trigger on each table | `accounting-fx-concurrency.test.ts` — the two failure-injection cases | **ENFORCED** |
| 44 | Row level security is ENABLED and FORCED on the registry | `ALTER TABLE … ENABLE/FORCE`, asserted from `pg_class` | `migration-upgrade.test.ts`; `migration-portability.test.ts` | **ENFORCED** |
| 45 | No `daftar_*` role holds `BYPASSRLS` | asserted from `pg_roles` | the `0048` DO block; `migration-portability.test.ts` | **ENFORCED** |
| 46 | `0048` installs under a NOSUPERUSER, NOBYPASSRLS migration principal | the ownership transfers use ordinary membership | `migration-portability.test.ts` — "applies 0048 alone onto the frozen 0047 boundary" | **ENFORCED** |
| 47 | The upgrade path from a frozen 0047 applies exactly one migration, protected on arrival, and reruns as a no-op | the migrator's checksum history | `migration-upgrade.test.ts` — "frozen 0047-checkpoint → 0048 alone" | **ENFORCED** |
| 48 | Migrations `0000`–`0047` are byte-for-byte what the manifest recorded | the manifest compared against the history the migrator wrote | the same test; `gate:phase2:s5`'s independent second read | **ENFORCED** |
| 49 | No effective instant is ever derived from a clock | `accounting.fx_effective_at_required`; no `coalesce` onto a clock value anywhere in `0048` | `gate:phase2:s5`'s clock audit, which enumerates **every** clock reference in the migration by line | **ENFORCED** |
| 50 | A realized FX difference of zero posts nothing | `classifyRealizedFx` returns `null` | `realized-fx.test.ts` | **ENFORCED** |
| 51 | A gain is a CREDIT to `fx_gain`; a loss is a DEBIT to `fx_loss` | pinned in the return shape | the eight pinned examples, plus a swept invariant over both directions | **ENFORCED** |
| 52 | The economic direction must be stated explicitly | `'inflow' \| 'outflow'`, no default | `realized-fx.test.ts` | **ENFORCED** |
| 53 | The realized-FX primitive is exact-integer only and bounded by `MAX_MONEY_MINOR` | `BigInt` throughout; no `Number`, `parseFloat` or `Math.*` | `realized-fx.test.ts`; `gate:phase2:s5` | **ENFORCED** |
| 54 | Neither helper can return the other's account, or `purchase_price_variance` | the return types admit only their own keys | `realized-fx.test.ts` — the exhaustive separation proof; `gate:phase2:s5` | **ENFORCED** |
| 55 | A rounding residual's only account is `rounding`, with an explicit side, a bounded magnitude and a stated reason | `classifyRoundingResidual` + `accounting.rounding_residual_unbounded` | the rounding cases | **ENFORCED** |
| 56 | AL-09's conversion vectors still hold in both implementations | the seven vectors, pinned as literals | `accounting-fx-parity.test.ts` — TypeScript computes each one, and the database accepts it at COMMIT and refuses one minor unit either way | **ENFORCED** |
| 57 | There is no third arithmetic implementation | one `convertToBaseMinor`, one `accounting_assert_entry_valid` | `gate:phase2:s5`; `0048` adds no conversion routine | **ENFORCED** |
| 58 | The journal's per-line snapshot remains the historical authority for anything posted | the registry is not consulted by any posting path | no posting path references `accounting_fx_rates`; `gate:phase2:s5` | **ENFORCED** |
| 59 | P2-S4's accepted manual-adjustment payload contract is unchanged | `deriveSourceId` delegates to a shared derivation with byte-identical output | `fx-rate.test.ts` re-pins the pre-refactor UUID; the whole P2-S4 matrix runs in this slice's gate | **ENFORCED** |

## 5. The one architectural decision that needs stating

**P2-S5 adds a SECOND assertion format on the SAME key material, and the separation is cryptographic rather than structural.**

§29 asks for a control-assertion format distinct from the posting format, and §30 requires that substituting one for the other fail in **both** directions as a tested property — explicitly *"do not rely merely on different parser lengths"*.

A length check would have been the easy answer and the wrong one. Two formats that share a secret are two formats one HMAC can be made to cover if the preimages ever collide, and "they happen to have different component counts today" is a property of a parser, not of a MAC. So the domain label is inside the MAC:

- a **posting** assertion signs `v1.<kid>.<ten more components>` — dot-separated, and nothing more;
- a **control** assertion signs `'acctctl/1' + '\n' + <ten claims joined by '.'>`.

Neither `/` nor `\n` can occur anywhere in a posting preimage, so the two preimage **sets are disjoint**. A valid posting assertion presented as a control assertion does not merely parse wrong; its MAC cannot verify, because no control preimage can ever equal a posting preimage. The two also travel in different GUCs (`app.accounting_assertion` and `app.accounting_control_assertion`), so neither verifier ever reads the other's transport. `accounting-fx-authority.test.ts` proves both directions and, separately, proves that stripping the domain prefix breaks verification — so the separation is tested where it lives, not where it is convenient.

`القرار المعماري: صيغة توكيد ثانية على المفتاح نفسه، وفصلها تشفيري لا بنيوي. اسم النطاق داخل التوقيع نفسه، ومجموعتا النص الموقَّع منفصلتان تمامًا، فلا يمكن لتوكيد ترحيل أن يعمل كتوكيد تحكّم ولا العكس.`

## 6. The lookup matrix, stated exactly (§46)

| the question | the answer |
|---|---|
| this business stated a rate for this pair at or before the instant | that rate — the latest such one |
| this business stated only a LATER rate | `accounting.fx_rate_missing` |
| this business stated nothing for this pair | `accounting.fx_rate_missing` |
| another business stated it | `accounting.fx_rate_missing` — the row is not visible, so it is not "not found for you", it is not found |
| the reverse pair was stated | `accounting.fx_rate_missing` — direction is part of the identity |
| a chain through a third currency exists | `accounting.fx_rate_missing` — it is not an FX graph solver |
| the two currencies are the same | `accounting.fx_same_currency` — domestic money uses the posting sentinel |
| a currency is not registered | `accounting.fx_currency_unknown` — a typo is distinguishable from an unstated rate |

There is **no implicit 1.0 for a foreign pair**, at any point in that table.

## 7. What this slice deliberately did NOT build

- **No rate provider, and no seam for one.** `source` is a CHECK-pinned constant rather than an enum with room in it: a `provider` value nothing can write is a promise the schema makes and the code cannot keep. When a provider exists it will arrive with its own migration, its own credentials and its own review.
- **No reciprocal, no cross-rate, no interpolation.** Each is a number nobody stated.
- **No read endpoint.** The lookup exists for the domains that will copy a snapshot into a journal line (§47); exposing it now would be a surface with no caller.
- **No accounting periods, no balances, no trial balance, no reports.**
- **No posting.** `classifyRealizedFx` and `classifyRoundingResidual` decide *which account and which side*; they return an intent and never touch a database. The domain that settles a payment will post it.
- **No change to the journal's authority.** A posted line's FX snapshot is, and remains, the historical truth for that line. The registry is what a FUTURE fact may be measured against; it is not a retroactive correction mechanism, and no posting path reads it.

## 8. The stated limit

These controls do not protect against an attacker who has compromised the `merchant-api` process itself: that process holds the signing key, so it can mint a control assertion for any authority it can reach. That is the same limit P2-S3 declared and P2-S4 inherited, and this slice does not narrow it.

What this slice *does* add to the attacker's cost is stated precisely: a stolen `daftar_app` credential cannot enter a rate, because the command refuses without a verified `acctctl/1` assertion and no login role holds INSERT; a stolen or replayed assertion cannot enter a second rate, because the jti is single-use and the TTL is 60 seconds; and a compromised process still cannot rewrite a rate it already entered, because the immutability trigger has no identity exemption at all.

`الحدّ المُعلن: هذه الضوابط لا تحمي من اختراق عملية merchant-api نفسها، لأنها تحمل مفتاح التوقيع. لكن بيانات اعتماد قاعدة البيانات المسروقة وحدها لا تكفي لإدخال سعر، والتوكيد المسروق لا يُعاد استخدامه، ولا أحد — ولا حتى مالك المخطط — يستطيع تعديل سعر أُدخل.`

## 9. Review status

**P2-S5 IS A CANDIDATE.** `0048` is not frozen, the manifest boundary has not moved, and no part of this slice may be treated as history until a Tech Lead accepts it. A green gate grants no authority.
