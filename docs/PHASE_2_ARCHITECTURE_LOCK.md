# DAFTAR — Phase 2 Architecture Lock / قفل معمارية المرحلة الثانية

> **Status: DECISION RECORD. No schema, no code, no migration.** This document resolves every architectural ambiguity that must be settled *before* migration `0040` exists. It is binding on the Phase 2 implementation and supersedes `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` wherever the two differ.
>
> **Baseline.** Accepted Phase 1 merge commit `2e01dbab3df2cf112cb0a7d5ac827a5578c61b81` (source head `64ea585f90d0643b8c3ea8b79af23d853b23d051`), post-merge CI run `35639980849` SUCCESS on all five required jobs. Migrations `0000`–`0039` frozen forever. Phase 1 is not reopened by this document.
>
> **Why this exists.** A mistake in a UI is repairable. A mistake in an authoritative ledger becomes historical truth. Every decision below is therefore written as *what the database physically refuses*, not as what the application intends.

---

## Decision index

| # | Decision | Status |
|---|---|---|
| AL-01 | Source-to-journal relational model | RESOLVED |
| AL-02 | Zero/one-line commit enforcement | RESOLVED |
| AL-03 | Journal physical write authority | RESOLVED |
| AL-04 | Actor model | RESOLVED |
| AL-05 | Account lifecycle / deactivation | RESOLVED |
| AL-06 | Account localization | RESOLVED |
| AL-07 | System account identity | RESOLVED |
| AL-08 | Chart seeding / backfill | RESOLVED |
| AL-09 | FX line consistency | RESOLVED |
| AL-10 | Money limits / overflow | RESOLVED |
| AL-11 | Idempotency mismatch behaviour | RESOLVED |
| AL-12 | Reversal model | RESOLVED |
| AL-13 | Opening balance model | RESOLVED |
| AL-14 | Accounting-period placement | RESOLVED |
| AL-15 | Read-model strategy | RESOLVED |
| AL-16 | Permission sensitivity | RESOLVED |
| AL-17 | Audit / outbox atomicity | RESOLVED |
| AL-18 | Implementation slice boundaries | RESOLVED |

---

## AL-01 — Source-to-journal relational model

**Problem.** The execution plan (§7, C-08) promised that later phases would "add a composite FK for a source table" on `journal_entries.source_id`. That is not implementable. One UUID column cannot carry several conditional foreign keys to different tables: SQL foreign keys are unconditional, so every added FK would apply to *every* row simultaneously and the first non-matching `source_type` would break all of them. The plan promised physical integrity it could never deliver.

**Chosen solution — inverted relational ownership + a closed source-type registry.**

1. `journal_entries` keeps `business_id`, `source_type`, `source_id` and `UNIQUE (business_id, source_type, source_id)` for traceability and posting idempotency. **`source_id` carries no foreign key, now or ever**, and the column comment says so in the migration.
2. `source_type` is constrained by a real FK to `accounting_source_types (source_type PK, owning_phase, registered_in_migration)`. Phase 2 seeds exactly three rows: `opening_balance`, `manual_adjustment`, `reversal`. An unregistered source type is rejected by the database, not by a service.
3. **Every source table owns the link from its own side**:
   ```
   <source_table>.journal_entry_id UUID NOT NULL,
   UNIQUE (business_id, journal_entry_id),
   FOREIGN KEY (business_id, journal_entry_id)
     REFERENCES journal_entries (business_id, id)
     DEFERRABLE INITIALLY DEFERRED
   ```
   The FK is deferred so the source row and its entry can be written in either order inside the one posting transaction.
4. A later operational domain registers its `source_type` in its own migration and adds `journal_entry_id` to **its** table. `journal_entries` is never altered again.

**Rejected alternatives.**

- *Polymorphic FK on `source_id`* — physically impossible, as above.
- *One nullable FK column per source table on `journal_entries`, with a growing XOR CHECK* (the `0039` `catalog_identifiers` pattern). This **is** enforceable and gives slightly stronger immediate integrity: the journal row itself would prove its source exists. Rejected honestly, with the trade-off stated: it requires altering the most sensitive table in the system once per future domain, it grows an unbounded XOR CHECK, and it couples the ledger to every operational domain — the exact coupling the posting engine contract forbids. Inverted ownership keeps the journal domain-agnostic while still giving full physical integrity, enforced from the source side.
- *Leaving the promise vague* — that is the defect being corrected.

**Is `accounting_source_types` a second source of truth?** No. It holds no financial data — only the vocabulary of legal source types. It cannot disagree with the ledger about money; it can only refuse a posting whose type was never registered. The ledger remains the sole financial authority.

**Database implication.** `journal_entries.source_type` → FK to the registry. `source_id` → plain UUID, NOT NULL, documented as a correlation key. Phase-2 source tables each carry a deferred composite FK back to the entry. Source rows use `ON DELETE RESTRICT` toward the journal: a posted entry's source may never vanish.

**API implication.** `post()` returns `{ entryId, created }`; each source command also returns its own source id. A caller cannot invent a source type.

**Security implication.** A forged `source_id` cannot reach another business's data, because the *source table's* FK is composite on `business_id`. A forged `source_type` is refused by the registry FK.

**Test implication.** Raw SQL with an unregistered `source_type` → FAIL. Source row referencing another business's entry → FAIL. Deleting a source row whose entry exists → FAIL. Posting the same source twice → one entry (AL-11).

**Future-phase implication.** Phase 3/4 add their rows to the registry and their own `journal_entry_id`; no journal migration, no change to this decision.

---

## AL-02 — Zero-line / one-line / unbalanced entry prevention at COMMIT

**Problem.** The plan relied on a deferred trigger over `journal_lines`. A trigger on lines never fires when there are no lines, so raw SQL inserting a `journal_entries` row and zero lines would commit a phantom entry.

**Chosen solution — deferred constraint triggers on BOTH mutation paths, validating the entry as a whole.**

```
CREATE CONSTRAINT TRIGGER journal_entry_validate
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_validate_entry();

CREATE CONSTRAINT TRIGGER journal_line_validate
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_validate_entry_of_line();
```

The entry-side trigger is the crux: it is attached to the **entry insert**, so a transaction that writes an entry and no lines still has a pending deferred check that fires at COMMIT and raises. The line-side trigger catches any attempt to touch lines of an entry written earlier.

Both call one validation routine, which for a given entry id asserts, at COMMIT:

| assertion | error code |
|---|---|
| line count ≥ 2 | `accounting.entry_too_few_lines` |
| Σ base debit = Σ base credit, and > 0 | `accounting.entry_unbalanced` |
| every line's `business_id` and `tenant_id` equal the entry's | `accounting.entry_business_mismatch` |
| every line's account belongs to the same business | `accounting.entry_account_foreign` (also FK-enforced) |
| every line's base amount equals HALF_EVEN(txn × rate) | `accounting.entry_fx_arithmetic` (AL-09) |
| entry status is `posted` | `accounting.entry_status_invalid` |

Sums are computed in `NUMERIC`, not `bigint`, so the check itself cannot overflow (AL-10).

Immutability is separate and unconditional: `BEFORE UPDATE OR DELETE` triggers on both tables raise for any posted row, and no runtime role holds UPDATE or DELETE grants (AL-03). Two independent mechanisms, deliberately redundant.

**Rejected alternatives.** A line-only trigger (leaves case A open). A `CHECK` constraint (cannot aggregate across rows). A maintained `line_count` column with `CHECK (line_count >= 2)` (still needs a trigger, and stores derived data inside the authoritative table). Application-only validation (forbidden by the project's law).

**Database implication.** Two constraint triggers, one shared validation function, `SET CONSTRAINTS` never relaxed by application code.

**API implication.** A commit-time failure surfaces as a typed error carrying the entry id and the two sums — never a generic 500.

**Security implication.** The guarantee holds against raw SQL from any of the six roles, not only against the service layer.

**Test implication — mandatory raw-SQL matrix (P2-S2 exit criteria).**

| # | case | expected |
|---|---|---|
| A | entry + zero lines | COMMIT FAIL |
| B | entry + one line | COMMIT FAIL |
| C | two unbalanced lines | COMMIT FAIL |
| D | balanced two-line entry | COMMIT PASS |
| E | line whose `business_id` differs from the entry | FAIL |
| F | DELETE a line of a posted entry | FAIL |
| G | UPDATE a line of a posted entry | FAIL |

Each case is run as every one of the six database roles.

**Future-phase implication.** The same validation routine is the single place a future accounting-period check plugs in (AL-14) — no journal schema change.

---

## AL-03 — Who may physically write journal truth

**Problem.** The plan granted `daftar_app` `SELECT, INSERT` on `journal_entries` and `journal_lines`. Any application code path — or anything holding that credential — could then insert a *balanced but unaudited* entry, bypassing the posting engine's validation, the source registry, audit creation, outbox creation, FX validation and idempotency handling. Balance alone is not integrity.

**Chosen solution — no runtime role holds any DML on the journal; one narrow SECURITY DEFINER primitive is the only physical writer.**

Grants:

```
REVOKE ALL ON journal_entries, journal_lines FROM PUBLIC;
-- no INSERT/UPDATE/DELETE to any runtime role, ever
GRANT SELECT ON journal_entries, journal_lines TO daftar_app, daftar_worker, daftar_platform;
GRANT EXECUTE ON FUNCTION accounting_post_entry(...) TO daftar_app;
-- daftar_identity, daftar_resolver, daftar_provisioner: nothing at all
```

`accounting_post_entry(...)` is SECURITY DEFINER, owned by the schema owner, and deliberately narrow — **structural integrity and atomic write authority only**:

- accepts `business_id`, `tenant_id`, `source_type`, `source_id`, `entry_date`, `description`, the actor shape (AL-04), `request_id`, the posting fingerprint (AL-11) and a `jsonb` array of lines;
- resolves accounts by `(business_id, system_key | code)` and refuses unknown or inactive accounts (AL-05, AL-07);
- verifies the target business is inside the caller's RLS context (`app_tenant()` / `app_business()`), because a SECURITY DEFINER routine bypasses RLS and must re-assert it — the same discipline the Phase 1 provisioning commands use;
- writes entry + lines + audit row + outbox row (AL-17);
- returns `(entry_id, created)`, handling replay per AL-11;
- contains **no domain orchestration**: no invoice logic, no allocation logic, no rate-sourcing policy. Amounts, rates and the fingerprint are computed by the TypeScript posting engine and handed over.

Division of authority, stated once:

| layer | owns |
|---|---|
| TypeScript posting engine | domain orchestration, FX computation, rounding, fingerprint, the developer-facing API |
| `accounting_post_entry` | atomic write authority and the refusal of malformed input |
| constraints + triggers | the invariants, at COMMIT, against every role |

**Rejected alternatives.** `daftar_app` INSERT (the plan's original — bypass demonstrated above). Updatable views or rules (obscure failure modes). Moving domain logic into PL/pgSQL (explicitly forbidden: the DB primitive must stay narrow).

**Database implication.** Two tables with no write grants; one EXECUTE-granted function; the `0039` `catalog_identifiers` precedent already proves this pattern works in this codebase.

**API implication.** `@daftar/accounting` remains the only module that may call the primitive; static guard (new) fails the build if any module outside it writes SQL naming `journal_entries` or `journal_lines`.

**Security implication.** A compromised merchant application credential can still only produce well-formed, audited, outboxed, fingerprinted entries inside its own business. It cannot write an unaudited entry, an unbalanced entry, a cross-business entry, or mutate history.

**Test implication.** For each of the six roles: direct INSERT/UPDATE/DELETE on both tables → permission denied. EXECUTE of the primitive by a role other than `daftar_app` → denied. The primitive called with a business outside the RLS context → refused inside the function.

**Future-phase implication.** Worker-initiated posting (Phase 3+) gains `GRANT EXECUTE` to `daftar_worker` plus a registered system actor (AL-04) — no new write path.

---

## AL-04 — Actor authority model

**Problem.** `posted_by_user_id NOT NULL` combined with a mention of a "system actor" is contradictory, and inventing a synthetic user row to represent the system is forbidden.

**Chosen solution — an explicit two-shape actor, enforced by CHECK; Phase 2 policy permits only the user shape.**

```
actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('user','system')),
actor_user_id     UUID NULL REFERENCES users (id),
actor_system_key  TEXT NULL REFERENCES accounting_system_actors (system_key),
CHECK (
  (actor_kind = 'user'   AND actor_user_id IS NOT NULL AND actor_system_key IS NULL) OR
  (actor_kind = 'system' AND actor_user_id IS NULL     AND actor_system_key IS NOT NULL)
)
```

`accounting_system_actors` is a closed registry **seeded empty in Phase 2**. Every Phase 2 posting is therefore `actor_kind='user'`. The *shape* exists from day one so that a later worker-initiated posting registers a key instead of inventing a fake user; the *policy* in Phase 2 is that no system actor exists yet. This satisfies both directions the directive allowed, without ambiguity.

**Authority derivation — the Phase 1 lesson, applied.** The actor is never taken from a client DTO. The TypeScript layer passes the authenticated user id from server context, and `accounting_post_entry` independently verifies that this user holds an **active membership in the target business**. A forged id therefore fails in the database, not merely in the service. A request body field named `actorUserId` is ignored by the contract and asserted absent by a contract test.

**Rejected alternatives.** A synthetic "system" user row (forbidden; pollutes identity and audit). `posted_by_user_id NOT NULL` alone (cannot express a future worker posting). A nullable user id with no `actor_kind` (unreadable shape, no CHECK possible).

**Database implication.** Three columns plus one CHECK on `journal_entries`; a registry table; an FK to `users`.

**API implication.** DTOs never carry actor identity. Responses expose the actor as `{ kind, userId | systemKey }`.

**Security implication.** Closes the Phase 1 class of defect (caller-settable actor identity) by construction.

**Test implication.** `user` shape with NULL user id → CHECK FAIL. `system` shape with a user id → CHECK FAIL. Unregistered system key → FK FAIL. Actor who is not a member of the business → refused inside the primitive. `actorUserId` supplied in the request body → ignored.

**Future-phase implication.** Compatible with `audit_events.actor_user_id` (nullable), which carries the system key in `metadata` when the actor is a system one.

---

## AL-05 — Account lifecycle and deactivation

**Problem.** The plan said an account with posted lines cannot be deactivated, and simultaneously that it may be "hidden from pickers" — two names for one concept, pointing in opposite directions.

**Chosen solution — one flag, normal accounting semantics.**

`accounts.is_active BOOLEAN NOT NULL DEFAULT true` is the only state. "Hidden from pickers" is not a separate concept: an inactive account is simply not offered for future posting.

| operation on an account with posted history | policy | enforcement |
|---|---|---|
| DELETE | **forbidden** | `ON DELETE RESTRICT` from `journal_lines` + no DELETE grant to any role |
| change `code` | **forbidden** | BEFORE UPDATE trigger |
| change `system_key` | **forbidden** | BEFORE UPDATE trigger (AL-07) |
| rename `name` | allowed, audited | display only |
| deactivate (non-system) | **allowed**, audited | — |
| reactivate | allowed, audited | — |
| post to it while inactive | **forbidden** | refused inside `accounting_post_entry` |
| appear in historical reports | **always** | reports never filter on `is_active` |

System accounts (those carrying a `system_key` the engine requires) are stricter: they cannot be deactivated at all, cannot be deleted, cannot be re-coded.

**Rejected alternative.** Forbidding deactivation of any used account — it would force merchants to keep obsolete accounts in every picker forever, and it confuses *historical use* with *future availability*. Historical use must never prevent historical reporting; it must also never force future posting.

**Database implication.** One boolean, two BEFORE UPDATE triggers, one RESTRICT FK.

**API implication.** `PATCH .../accounts/:id` accepts `isActive` and `name`; it rejects `code` and `system_key` outright.

**Security implication.** Requires `accounting.chart.manage` (sensitive, AL-16); every change audited.

**Test implication.** Deactivate a used non-system account → PASS, and its history still appears in the trial balance. Post to it → FAIL. Delete it → FAIL. Re-code it → FAIL. Deactivate a system account → FAIL.

---

## AL-06 — Account localization

**Problem.** The plan claimed the seeded chart carries ar/en/tr names while the proposed schema had a single `name` column — multilingual persistence asserted without a data model.

**Chosen solution — no `account_translations` table.**

- `accounts.name TEXT NOT NULL` is one label.
- **System accounts**: the seed writes a stable label, and the UI renders the display name from an i18n key derived from `system_key` (`accounting.account.cash`, `accounting.account.fx_gain`, …) in the existing `messages/*.json` files — the same mechanism `check:localization` already gates at 187 keys × 3 locales.
- **Custom accounts**: the merchant's typed `name` is shown verbatim in every locale. Translating merchant free text is not the platform's job.
- **Accounting truth never depends on display text** — the engine addresses accounts by `system_key` or `code` only (AL-07).

**Rejected alternative.** `account_translations` — a table, an RLS policy, a sync path and a completeness gate, for text that is either generated from a fixed key set (better in i18n files) or merchant free text (untranslatable). Complexity with no benefit, on an internal subsystem the merchant barely sees.

**Database implication.** None beyond the single column — a table deliberately *not* created.

**API implication.** System accounts expose `systemKey` so the client can localize; custom accounts expose `name`.

**Test implication.** `check:localization` covers the new accounting keys across ar/en/tr. A golden test asserts the engine resolves accounts without reading `name`.

---

## AL-07 — System account identity

**Problem.** The engine must never identify accounting semantics by a mutable display name, and the plan left "flagged `is_system`" without saying what the stable identifier is.

**Chosen solution — an explicit immutable `system_key`, not the numeric code.**

```
system_key TEXT NULL REFERENCES accounting_system_account_keys (system_key),
CREATE UNIQUE INDEX ON accounts (business_id, system_key) WHERE system_key IS NOT NULL;
```

Registry keys for Phase 2: `cash`, `bank`, `card_clearing`, `wallet_clearing`, `cheque_clearing`, `accounts_receivable`, `supplier_receivable`, `inventory`, `accounts_payable`, `tax_payable`, `customer_refund_liability`, `customer_credit_liability`, `opening_equity`, `sales_revenue`, `sales_returns`, `discounts`, `cogs`, `fx_gain`, `fx_loss`, `rounding`, `purchase_price_variance`.

**Why not the numeric code.** Codes are a merchant-visible chart convention, and country packs may legitimately renumber — a Jordanian or Turkish chart does not have to use `4900` for realized FX gain. Binding engine semantics to a number would make a country pack unable to renumber without breaking the engine. `system_key` survives both renumbering and renaming.

Properties, each enforced:

- **business-scoped** — the partial unique index is on `(business_id, system_key)`;
- **immutable** — BEFORE UPDATE trigger forbids changing or clearing it;
- **one authoritative mapping** — `accounting_resolve_system_account(business_id, system_key)` raises `accounting.system_account_missing` if absent or inactive, so a missing system account is a loud failure, never a silent posting to the wrong account;
- **no merchant shadowing** — `system_key` is written only by the seeding routine; the merchant-facing API never accepts the field, so an account a merchant names "FX Gain" carries no engine meaning;
- **country-pack safe** — codes and names may vary per pack; keys may not.

**Rejected alternative.** Identity by reserved code range — simpler, but couples engine semantics to a presentation convention and blocks country-pack renumbering.

**Test implication.** Merchant attempts to set `system_key` → rejected by the contract and by the absence of any write path. Renaming a system account → engine still resolves it. Deleting a system account → FAIL. Missing system account at posting time → typed loud error.

---

## AL-08 — Chart seeding for new and existing businesses

**Problem.** Every Phase 1 business already in the database must receive a chart when `0040` lands, and every future business must receive one atomically — without editing frozen provisioning migrations `0000`–`0039`.

**Chosen solution — one SECURITY DEFINER seeding routine, driven by an AFTER INSERT trigger on `businesses`, plus a migration-time backfill.**

```
CREATE FUNCTION accounting_seed_chart(p_business_id uuid) ... SECURITY DEFINER;   -- idempotent
CREATE TRIGGER businesses_seed_chart AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION accounting_seed_chart_trg();
```

**Why this works without touching frozen migrations.** A trigger attaches to the *table*, not to the caller. `provision_create_business` (frozen, `0038`) inserts into `businesses`; the trigger fires inside that same SECURITY DEFINER transaction. A business can therefore never exist without a chart, and no frozen file changes. The trigger function is itself SECURITY DEFINER so it succeeds even though `daftar_provisioner` holds no INSERT on `accounts`.

**Backfill.** Migration `0040` seeds every existing business, then asserts completeness and *fails the migration* if any business is left without a chart:

```
PERFORM accounting_seed_chart(b.id) FROM businesses b;
IF EXISTS (SELECT 1 FROM businesses b
           WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.business_id = b.id))
THEN RAISE EXCEPTION 'chart backfill incomplete — refusing to finish the migration'; END IF;
```

**Proof that provisioning is not weakened.** The trigger only inserts rows into `accounts`; it reads no caller-settable state; it changes none of the `0033`/`0038` authority checks; and it cannot fail open — any error inside it aborts the whole business-creation transaction. The failure mode is explicitly the safe one: **no business rather than a chart-less business.**

**Rejected alternatives.** Editing `provision_create_business` (forbidden — frozen). Seeding from application code after business creation (leaves a window where a business exists without a chart, and does not cover provisioning paths that bypass the service). A nightly repair job (accepts the broken state as normal).

**Database implication.** One function, one trigger, one backfill block with a hard assertion.

**Test implication.** Create a business through the real onboarding path → chart present in the same transaction. Force the seeding routine to raise → the business is absent afterwards (failure injection). Re-run `0040` → no duplicate accounts (idempotent). `db-from-zero` proves 41 migrations then a no-op re-run.

**Future-phase implication.** Country-pack-specific charts extend `accounting_seed_chart` by `businesses.country_code`; the trigger and the invariant stay unchanged.

---

## AL-09 — FX line consistency

**Problem.** A line carrying both `debit_minor`/`credit_minor` and an FX snapshot can be internally contradictory: a partially filled snapshot, a domestic line with a rate ≠ 1, or a base amount that does not match the booked side.

**Chosen solution — structural completeness by CHECK; arithmetic correctness by the AL-02 commit-time trigger.**

Immediate CHECK constraints on `journal_lines`:

```
CHECK ((debit_minor > 0)::int + (credit_minor > 0)::int = 1)        -- exactly one side
CHECK (debit_minor >= 0 AND credit_minor >= 0)
CHECK (base_amount_minor = GREATEST(debit_minor, credit_minor))     -- base = the booked side
CHECK (fx_rate > 0)
CHECK (
  (txn_currency =  base_currency AND fx_rate = 1
     AND txn_amount_minor = base_amount_minor
     AND fx_rate_source = 'base'      AND fx_rate_at IS NOT NULL)
  OR
  (txn_currency <> base_currency AND fx_rate > 0
     AND fx_rate_source IN ('manual','provider')
     AND fx_rate_at IS NOT NULL       AND txn_amount_minor > 0)
)
```

Notes that matter:

- `base_currency` is denormalised onto the line (copied from the entry, itself copied from the business) so the CHECK is self-contained and a historical line remains readable without a join. Immutability comes from the posted-row trigger.
- `fx_rate NUMERIC(20,10) NOT NULL` — never float, never double, never a JavaScript number.
- Domestic lines use the explicit sentinel `fx_rate_source = 'base'`, so "domestic" is a stated fact rather than an inferred NULL. **Partially populated FX snapshots are structurally impossible.**

**Why the base↔txn arithmetic is a trigger, not a CHECK.** `base = HALF_EVEN(txn × rate)` needs both currencies' minor units, which requires reading the `currencies` table — a `CHECK` constraint may only call IMMUTABLE expressions and may not read other tables. The equality is therefore asserted by the same deferred constraint trigger that validates balance (AL-02), which may join freely. It is still database-enforced against every role; it simply fires at COMMIT rather than on the row. This is a real trade-off and is recorded rather than glossed over.

**Rejected alternatives.** Nullable FX columns with "the service will fill them" (the defect). A per-line CHECK calling a non-IMMUTABLE function (PostgreSQL refuses it). Storing the rate as a float (forbidden).

**Test implication.** Rate without source → FAIL. Domestic line with rate ≠ 1 → FAIL. Foreign line with rate 0 or negative → FAIL. `base_amount_minor` ≠ booked side → FAIL. `base` ≠ HALF_EVEN(txn × rate) → FAIL at COMMIT. Cases in JOD (3 minor units) and LBP (large magnitude).

---

## AL-10 — Money range, overflow and representation

**Chosen solution.**

| concern | decision |
|---|---|
| storage | `BIGINT` minor units, signed; PostgreSQL range ±9,223,372,036,854,775,807 |
| domain cap | `MAX_MONEY_MINOR = 10^18` — every line amount and every API-accepted amount satisfies `0 < amount ≤ 10^18`, by column CHECK **and** contract validation |
| why 10^18 | the largest realistic single amount (LBP/SYP at 2 minor units) stays orders of magnitude below it, while leaving ~9.2× headroom so sums cannot approach the type limit |
| aggregate safety | the balance trigger and every report sum with `::NUMERIC`, not `bigint`, so the check itself can never overflow |
| TypeScript arithmetic | `Money` already refuses unsafe `number`; Phase 2 adds `assertWithinMoneyRange()` on construction and on every arithmetic result, throwing `MoneyError('PRECISION_OVERFLOW')` |
| FX intermediates | rate carried as an exact integer scaled to 10 decimals (`rate × 10^10`); conversion is `txn × rate_scaled`, then HALF_EVEN division by `10^10` with a minor-unit adjustment. All intermediates are JS `BigInt` (unbounded) and never reach the database; the bounded final result (≤ 10^18) is what is stored. Worst-case intermediate ≈ 10^31 — harmless in BigInt, impossible in `Number` |
| JSON | minor units as a decimal **string**, never a JSON number; the API rejects a numeric JSON literal for a money field |
| PG range failure | SQLSTATE `22003` mapped to `accounting.amount_out_of_range`, never a leaked driver error — unreachable given the cap, tested anyway |

A financially valid operation must never wrap, truncate or silently coerce. **Planned boundary tests:** exactly `MAX_MONEY_MINOR`; `MAX_MONEY_MINOR + 1` (reject); `2^63 − 1` (reject by cap before reaching PG); an entry with enough lines that a `bigint` SUM would overflow but `NUMERIC` does not; a JOD 3-decimal conversion at the cap; a JSON number supplied for a money field (reject).

---

## AL-11 — Idempotency semantics and mismatch behaviour

**Chosen solution — `UNIQUE (business_id, source_type, source_id)` plus a canonical financial fingerprint.**

`journal_entries.posting_fingerprint CHAR(64) NOT NULL` — SHA-256 over a canonical serialization of the **financial content only**:

*included*: business id, source type, source id, entry date, and the ordered list of `(account system_key or code, side, base_amount_minor, txn_currency, txn_amount_minor, fx_rate, branch_id, warehouse_id)`.
*excluded*: description, line memos, request id, actor, timestamps — a retry differing only in narrative is the same financial fact.

| scenario | behaviour |
|---|---|
| sequential retry, identical content | `created=false`, existing entry id returned; **no** second audit row, **no** second outbox event |
| concurrent retry, identical content | one transaction inserts; the loser catches the unique violation, re-reads, compares the fingerprint, returns `created=false` |
| same source, **materially different** financial content | `accounting.idempotency_conflict` → HTTP 409, carrying the existing entry id. **Never silent success, never a second entry** |
| rollback then retry | nothing persisted; the retry posts normally — uniqueness lives in the database, not in a cache |
| same source, different description only | `created=false` (fingerprint unchanged by design) |

The comparison happens **inside** `accounting_post_entry`, so no caller can skip it. The Phase 1 transport-level `Idempotency-Key` header remains as an additional, independent guard on the HTTP mutation path.

**Rejected alternative.** Returning the existing entry on any replay regardless of content — it would let a caller believe a *different* financial fact was recorded when it was not. That is the single most dangerous failure mode in a ledger API.

**Test implication.** All five rows above, plus the concurrent case with two real connections.

---

## AL-12 — Reversal model

**Chosen solution.**

- A reversal is a **new** entry with `source_type='reversal'`, `source_id = <original entry id>`. The unique source key therefore makes a **second reversal of the same entry physically impossible** — no application check required.
- Relational link lives in `accounting_reversals (business_id, id, original_entry_id, journal_entry_id, reason, actor_kind, actor_user_id, actor_system_key, created_at)` with composite FKs to `journal_entries` on both ids and `UNIQUE (business_id, original_entry_id)` — AL-01 inverted ownership.
- **Correction of the earlier plan:** the plan proposed `journal_entries.reversed_by_entry_id` on the original. Writing that column would *mutate a posted entry*, contradicting immutability. It is therefore rejected. "Is this entry reversed?" is answered by a join to `accounting_reversals`, never by a flag on the original.
- Lines are the exact mirror — debit ↔ credit swapped — at the **original base amounts and the original FX snapshots** (rate, source and timestamp copied verbatim). Never recomputed at today's rate (`DAFTAR_ACCOUNTING_RULES.md` §5.2, stated there as an absolute prohibition).
- Reversal of a reversal: refused (the original may not itself be `source_type='reversal'`).
- `reason TEXT NOT NULL` with a non-empty CHECK; actor per AL-04; `entry_date` defaults to today.
- Audit + outbox in the same transaction (AL-17); event `accounting.entry.reversed`.
- The original row is never touched, in any column.

**Test implication.** Mirror lines match the original amounts and rates exactly; second reversal → unique violation surfaced as `accounting.reversal_exists`; reversal of a reversal → refused; empty reason → CHECK FAIL; original unchanged byte-for-byte after reversal.

---

## AL-13 — Opening balance model

**Chosen solution.**

```
accounting_opening_balances(business_id, id, as_of_date,
  status TEXT CHECK (status IN ('draft','posted','superseded')),
  journal_entry_id UUID NULL, actor_*, created_at, posted_at)
accounting_opening_balance_lines(business_id, opening_balance_id, account_id, side,
  amount_minor, txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at)

CREATE UNIQUE INDEX ON accounting_opening_balances (business_id) WHERE status = 'posted';
```

- **Draft lifecycle**: freely editable while `draft`; `posted` is terminal and immutable (BEFORE UPDATE trigger on the posted row).
- **Exactly one posted set per business**, enforced by the partial unique index.
- **Explicit equity plug**: the engine computes `plug = Σcredits − Σdebits` over the merchant-supplied positions and emits a **visible line** to the `opening_equity` system account. Never an invisible adjustment; if the plug is zero, no line is emitted.
- **Date rules**: `as_of_date` is the entry date, and the opening entry is the only entry permitted to predate the business's first period when periods land (AL-14).
- **FX**: foreign positions carry a complete snapshot with `fx_rate_source='manual'` and `fx_rate_at = as_of_date`.
- **Idempotency**: `source_type='opening_balance'`, `source_id = accounting_opening_balances.id`.
- **Corrections after posting**: reverse the opening entry (AL-12), mark the set `superseded` (a change to the *source* row, audited — not to the journal), then post a new set. The partial unique index makes replacement impossible without that sequence.
- **Not a magical import**: it goes through `accounting_post_entry` exactly like every other posting.

**Test implication.** Two posted sets → unique violation. Plug line present and correct, including the zero case. Edit after posting → FAIL. Foreign-currency opening with a full snapshot. Replacement only via reversal + supersede.

---

## AL-14 — Accounting periods: placement

**Decision — periods are NOT in the first implementation slice.** They become slice **P2-S6**, conditional on Tech Lead confirmation at that point.

**Reasoning.** Periods introduce a second temporal authority — timezone and date semantics, close/reopen actors and reasons, and close↔post concurrency — whose only Phase 2 consumer would be "prevent back-dating". Phase 2 has three sources, all created by an authenticated merchant action dated today or at an explicit opening date. Nothing in P2-S1…P2-S5 needs a closed period to be correct. Designing close/reopen concurrency before any posting traffic exists would be speculation, and the directive forbids introducing them merely because the plan mentions them.

**What is done now so periods remain cheap to add.** `journal_entries.entry_date DATE NOT NULL` ships in P2-S2, and the AL-02 validation routine is the single, documented plug-in point for a future period check — adding periods later requires **no journal schema change**.

**The narrower temporal rule Phase 2 does enforce**, so back-dating is not unbounded in the meantime: `entry_date` must fall within `[business.created_at − 10 years, today + 1 day]` evaluated in the business's own timezone (`businesses.timezone`, already stored in Phase 1). This refuses absurd dates without pretending to be a period system.

**When P2-S6 is authorized it must specify**: non-overlapping contiguous periods (exclusion constraint), open/closed state, close actor and time, reopen actor, time and mandatory reason, closed-period posting refused **in the database**, the timezone/date authority, close↔post concurrency (`FOR UPDATE` on the period row vs `FOR SHARE` on posting), and full audit.

---

## AL-15 — Read-model strategy

**Chosen solution — live aggregation only in Phase 2; zero materialized balance tables.**

- Trial balance, general ledger and account balances are SQL aggregates over `journal_lines`, supported by the indexes `(business_id, entry_date)`, `(business_id, account_id, journal_entry_id)` and the unique source key.
- `accounts` carries **no balance column at all**. This is stated explicitly because a balance column is the single most common way a ledger rots.
- A materialized read model may be introduced **only** after the committed performance dataset in P2-S8 demonstrates a budget miss — and then only as a derived, rebuildable table with a nightly full rebuild plus a reconciliation check against live aggregation.
- **No cached balance is ever authoritative.** There is no API that writes a balance.
- The rebuild-equals-live test is a release gate whether or not materialization exists.

**Rejected alternative.** Materializing balances up front "for performance" before any measurement — premature, and it creates a second thing that can disagree with the journal.

---

## AL-16 — Permission model and sensitivity

| permission | sensitivity | note |
|---|---|---|
| `accounting.view` | ordinary | chart, entries, trial balance, GL, balances |
| `accounting.post` | **sensitive** | **upgraded** from the earlier plan — it creates financial truth |
| `accounting.reverse` | sensitive | |
| `accounting.chart.manage` | sensitive | |
| `accounting.fx.manage` | sensitive | a rate changes booked values |
| `accounting.period.manage` | sensitive | registered only in P2-S6 |
| `accounting.period.reopen` | sensitive | registered only in P2-S6 |

Preserved Phase 1 properties, unchanged: default deny; delegation ceiling (no member grants what they do not hold); owner authority from trusted role identity, never a boolean on a request object; custom merchant-defined roles; every grant audited.

Rules specific to Phase 2:

- **No permission grants direct table mutation.** AL-03 makes this structurally true, not merely policy: there is no DML grant to bind a permission to.
- **Branch scope** applies to *reads* (branch-filtered reports) and, for posting, restricts which `branch_id` values a scoped member may put on a line — checked inside the primitive.
- **Later-domain postings are authorized by their own domain permission** (e.g. `sale.create`), not by `accounting.post`; otherwise every cashier would need ledger rights.
- Period permissions are **not registered until P2-S6**, so the registry never ships dead keys.

---

## AL-17 — Audit and outbox atomicity

**Chosen solution — all four writes inside one transaction, inside `accounting_post_entry`.**

Order: entry → lines → `audit_events` row → `outbox_events` row. Any failure aborts everything. The AL-02 deferred triggers then fire at COMMIT, so even a function call that returned successfully can still fail the whole transaction at commit — which is the correct behaviour.

**Required failure-injection matrix (P2-S3 exit criteria).**

| injected failure | required outcome |
|---|---|
| audit insert fails | entry, lines and outbox all absent |
| outbox insert fails | entry, lines and audit all absent |
| commit-time validation trigger raises | nothing persisted |
| publisher fails **after** commit | ledger intact; event retried with the Phase 1 backoff; dead-lettered after 8 attempts; never lost |
| database connection lost mid-posting | nothing persisted |

**No asynchronous step may determine whether the ledger transaction commits.** The publisher runs in the worker and reads `outbox_events` only after commit — the Phase 1 contract, reused rather than reinvented (`outbox.test.ts` already proves the atomicity shape for business events).

Outbox payloads carry **ids only, never amounts**, so the event stream does not become a second, unauthorized copy of financial data.

---

## AL-18 — Implementation slice boundaries

Each slice requires its own documented PASS before the next begins. Migration numbers are reserved per slice; `0000`–`0039` stay frozen forever and Phase 2 starts at `0040`.

| slice | content | migrations | exit criteria |
|---|---|---|---|
| **P2-S0** | Architecture lock (this document) | **0** | Tech Lead approval |
| **P2-S1** | `accounts`, system-key registry, seeding routine + trigger + backfill, accounting permissions | `0040`, `0041` | every existing and new business has a chart; AL-05/06/07/08 tests green |
| **P2-S2** | Journal tables, immutability triggers, AL-02 constraint triggers, AL-09 CHECKs, narrow write authority and grants | `0042`, `0043` | raw-SQL matrix A–G green for all six roles; no write grant exists |
| **P2-S3** | TypeScript posting engine, source-type registry, fingerprint, idempotency and concurrency, audit + outbox atomicity | `0044` | AL-11 matrix and AL-17 failure-injection matrix green |
| **P2-S4** | Reversal, manual adjustment, opening balance — Phase-2-owned sources only | `0045`, `0046` | AL-12 and AL-13 tests green |
| **P2-S5** | FX foundation: manual rate source, immutable snapshot, rounding, realized-FX primitive | `0047` | Phase 0 worked FX journals reproduced line by line through the engine |
| **P2-S6** | Accounting periods — **only if confirmed at that point** (AL-14) | `0048` | close/reopen/concurrency tests green |
| **P2-S7** | Trial balance, general ledger, account balances — live aggregation | `0049` (indexes only, if needed) | reports balance; rebuild-equals-live green |
| **P2-S8** | Red team, cross-tenant/cross-business, raw SQL, failure injection, rollback rehearsal, performance dataset | 0 | all budgets met or materialization justified (AL-15) |
| **P2-S9** | Release closure: full gate, RC archive, evidence, documentation | 0 | repository and extracted-archive gates both PASS with zero skips |

---

## Conflicts found between authoritative documents

| # | Conflict | Resolution |
|---|---|---|
| K-01 | `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` §7/C-08 promised future FKs on `journal_entries.source_id`; `DAFTAR_DATA_MODEL.md` §7 forbids a generic FK without a target | AL-01 — inverted ownership; the plan is corrected |
| K-02 | The plan granted `daftar_app` INSERT on the journal; `DAFTAR_SOURCE_OF_TRUTH_MATRIX.md` requires the GL to be the sole authority reachable only through the posting engine | AL-03 — no DML grants; narrow SECURITY DEFINER primitive |
| K-03 | The plan proposed `reversed_by_entry_id` on the original entry; the same plan's law L-01 makes posted entries append-only | AL-12 — the link lives in `accounting_reversals` only |
| K-04 | The plan asserted ar/en/tr account names with a single `name` column | AL-06 — i18n keys for system accounts; no translation table |
| K-05 | The plan said used accounts cannot be deactivated *and* may be hidden | AL-05 — one flag, deactivation allowed, history preserved |
| K-06 | The plan required `posted_by_user_id NOT NULL` while mentioning a system actor | AL-04 — explicit actor shape, system registry seeded empty |
| K-07 | The plan's deferred trigger was line-driven only | AL-02 — entry-side constraint trigger closes the zero-line hole |

No conflict was resolved by silently preferring one document; each is recorded above.

---

## What this document does NOT authorize

No migration `0040`. No `accounts` table. No `journal_entries` or `journal_lines` table. No accounting module, endpoint or screen. No placeholder operational-domain tables. Implementation begins only when the Tech Lead approves this lock and issues the P2-S1 directive.
