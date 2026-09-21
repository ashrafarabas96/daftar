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

## AL-01 — Source-to-journal relational model (CORRECTED)

**Problem, restated.** The first version of this decision claimed that a foreign key from each source table to `journal_entries`, with `ON DELETE RESTRICT`, meant "a posted entry's source may never vanish". **That was relationally wrong.** A FK from SOURCE → JOURNAL proves the journal row exists when the source references it, and it prevents deleting the *journal* row. It does **not** prevent deleting the *source* row, and it does **not** prove that every journal entry has a source at all. The model was one-way and the stated guarantee was unearned.

**Required invariant.** Every posted journal entry corresponds to exactly one registered business-fact identity, and once posted that identity may not silently disappear.

**Chosen solution — an internal source-binding registry with mutually deferred links in both directions (approach A).**

```
accounting_source_bindings (
  business_id       UUID NOT NULL,
  source_type       TEXT NOT NULL REFERENCES accounting_source_types (source_type),
  source_id         UUID NOT NULL,
  journal_entry_id  UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, source_type, source_id),
  UNIQUE (business_id, journal_entry_id),
  FOREIGN KEY (business_id, journal_entry_id)
    REFERENCES journal_entries (business_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

-- the other direction, so an entry cannot exist without its binding:
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_binding_fk
  FOREIGN KEY (business_id, source_type, source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED;
```

Both foreign keys are `DEFERRABLE INITIALLY DEFERRED`, so the two rows may be written in either order inside the posting transaction and **both directions are verified at COMMIT**. This is the bidirectional integrity the earlier version only asserted.

**The binding registry is the source identity.** It is not a convenience index: it is where a business fact's accounting identity lives. Domain detail tables (`accounting_manual_adjustments`, `accounting_opening_balances`, and every future domain's table) reference the binding rather than owning identity themselves:

```
FOREIGN KEY (business_id, source_type, id)
  REFERENCES accounting_source_bindings (business_id, source_type, source_id)
```

so deleting a detail row cannot destroy the identity or the journal link — the binding survives, and it is undeletable.

**Binding rows are inside the immutable ledger perimeter**: no runtime role holds `INSERT`, `UPDATE` or `DELETE` on `accounting_source_bindings` (AL-03), and `BEFORE UPDATE OR DELETE` triggers raise unconditionally. The only writer is the posting primitive.

**The six required proofs.**

| # | requirement | how it is physically enforced |
|---|---|---|
| 1 | orphan journal entry impossible | `journal_entries → accounting_source_bindings` deferred FK, verified at COMMIT |
| 2 | source referencing a wrong-business journal impossible | both FKs are composite on `business_id` |
| 3 | source identity cannot disappear after posting | binding rows have no DELETE grant and a BEFORE DELETE trigger; detail rows additionally carry a per-table deletion guard (below) |
| 4 | duplicate source impossible | `PRIMARY KEY (business_id, source_type, source_id)` |
| 5 | future domains extend without touching `journal_entries.source_id` | a domain registers its `source_type` and FKs **its** table to the binding; the journal is never altered again |
| 6 | journal stays domain-agnostic | `journal_entries` references only the binding registry and the type registry — never a domain table |

**Honest residual.** Requirement 3 is fully physical for the *identity* (the binding row cannot be deleted by anyone). For a domain's *detail* row, the guard is a `BEFORE DELETE` trigger installed by the migration that creates that table — a per-table contract, not one global constraint, because a single global constraint would require exactly the polymorphic reference this decision exists to avoid. The contract is enforced by a test that enumerates `accounting_source_types` and asserts that every registered type's detail table carries the guard; a new source type without a guard fails the suite. This is stated as a contract-plus-test, not as a foreign key, because it is not one.

**Rejected alternatives.** The original source-side-only FK (the defect — one-way, as shown). A polymorphic FK on `source_id` (physically impossible). One nullable FK column per source on `journal_entries` with a growing XOR CHECK (enforceable, but alters the ledger for every future domain and couples it to every operational domain).

**API implication.** `post()` writes entry, lines and binding in one transaction and returns `{ entryId, sourceType, sourceId, created }`.

**Test implication.** Insert a journal entry with no binding → COMMIT FAIL (case H in Matrix 2, AL-02). Binding pointing at another business's entry → FAIL. Delete a binding → FAIL for every role. Delete a detail row whose binding exists → FAIL. Duplicate `(business_id, source_type, source_id)` → FAIL. Registry-completeness test over every registered source type.

---

## AL-02 — Zero-line / one-line / unbalanced prevention, and how it is tested

**Problem.** A trigger on `journal_lines` never fires when a transaction inserts an entry with no lines, so raw SQL could commit a phantom entry.

**Chosen solution — deferred constraint triggers on BOTH mutation paths.**

```
CREATE CONSTRAINT TRIGGER journal_entry_validate
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION accounting_validate_entry();

CREATE CONSTRAINT TRIGGER journal_line_validate
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION accounting_validate_entry_of_line();
```

The entry-side trigger is the crux: it is attached to the **entry insert**, so a transaction that writes an entry and no lines still has a pending deferred check that fires at COMMIT.

Validated at COMMIT for each touched entry: line count ≥ 2; Σ base debit = Σ base credit and > 0; every line's `business_id` and `tenant_id` match the entry; every line's account belongs to the same business; FX arithmetic holds exactly (AL-09); status is `posted`. Sums are computed in `NUMERIC`, never `bigint`, so the check itself cannot overflow (AL-10).

Immutability is separate and unconditional: `BEFORE UPDATE OR DELETE` triggers raise for any posted row, **and** no runtime role holds UPDATE or DELETE (AL-03). Two independent mechanisms, deliberately redundant.

### Error messages must not carry financial values

Commit-time failures raise a **stable machine code plus safe identifiers only** — `ERRCODE` plus the entry id. They do **not** include debit/credit sums, amounts, rates or balances. `DAFTAR_OBSERVABILITY.md` forbids financial values in logs, and a database exception message propagates into driver logs and generic error handlers where that rule cannot be re-applied. The earlier draft of this decision proposed putting the two sums in the message; that is withdrawn.

Codes: `accounting.entry_unbalanced`, `accounting.entry_too_few_lines`, `accounting.entry_business_mismatch`, `accounting.entry_account_foreign`, `accounting.entry_fx_arithmetic`, `accounting.entry_status_invalid`, `accounting.entry_binding_missing`.

The posting primitive refuses earlier and under the same redaction rule with `accounting.assertion_payload_mismatch` when the recomputed canonical fingerprint does not equal the one the assertion signed (AL-03) — before any write, and with no amounts in the message.

Where reconciliation tooling genuinely needs the offending sums, it obtains them through an explicitly authorized internal diagnostic path that is subject to the normal redaction and audit rules — never through an exception message.

### Two independent test matrices — they prove different things

The earlier version claimed cases A–G "run as each of the six database roles". That is misleading: under AL-03 no runtime role holds journal DML, so such an attempt fails at **permission checking** and never reaches the invariant. Authorization and structural integrity are separate properties and are tested separately.

**Matrix 1 — privilege boundary.** For every runtime role (`daftar_app`, `daftar_platform`, `daftar_worker`, `daftar_identity`, `daftar_resolver`, `daftar_provisioner`): direct `INSERT` / `UPDATE` / `DELETE` on `journal_entries`, `journal_lines` and `accounting_source_bindings` must fail with *permission denied*, matching the intended grant model exactly. This proves **nobody may write directly**.

**Matrix 2 — database invariants.** Executed through the schema owner (a dedicated test authority that legitimately holds DML), so the structural constraint itself is exercised rather than the grant:

| # | case | expected |
|---|---|---|
| A | entry + zero lines | COMMIT FAIL |
| B | entry + one line | COMMIT FAIL |
| C | two unbalanced lines | COMMIT FAIL |
| D | balanced two-line entry | COMMIT PASS |
| E | line referencing another business's account | FAIL |
| F | DELETE a line of a posted entry | FAIL |
| G | UPDATE a line of a posted entry | FAIL |
| H | entry with no source binding (AL-01) | COMMIT FAIL |

A PASS requires **both** matrices. Neither substitutes for the other.

**Future-phase implication.** The validation routine is the single plug-in point for a future accounting-period check (AL-14) — no journal schema change.

---

## AL-03 — Journal write authority and the unforgeable command boundary (CORRECTED)

**Problem 1.** Granting `daftar_app` `INSERT` on the journal lets any code path holding that credential insert a balanced but unaudited entry, bypassing the source binding, the fingerprint, audit, outbox and the FX checks.

**Problem 2 — the serious one, raised in review.** The earlier design had `accounting_post_entry` authorize by reading `app_tenant()` / `app_business()` and verifying the supplied actor is an active member of that business. **Those GUCs are caller-settable.** A stolen `daftar_app` database credential can `set_config('app.tenant_id', <victim>)`, `set_config('app.business_id', <victim>)`, pick the UUID of a genuinely active member of that business, and post an entry attributed to that member. Membership verification does not help: the attacker chooses a *real* member. This is precisely the Phase 1 provisioner actor-spoofing defect, reappearing in the ledger. **GUC scope does not prove authorization, and a caller-supplied UUID does not prove identity.**

**Chosen solution — a signed Accounting Command Assertion, verified inside the database against key material `daftar_app` cannot read.**

Grants:

```
REVOKE ALL ON journal_entries, journal_lines, accounting_source_bindings FROM PUBLIC;
-- no INSERT/UPDATE/DELETE to any runtime role, ever
GRANT SELECT ON journal_entries, journal_lines, accounting_source_bindings
  TO daftar_app, daftar_worker, daftar_platform;
GRANT EXECUTE ON FUNCTION accounting_post_entry(...) TO daftar_app;
```

`daftar_app` keeps EXECUTE, and the function therefore carries the whole authority check itself. It trusts **none** of: the GUC business scope, the caller-supplied actor UUID, or any client-supplied permission claim.

**Assertion format** — the proven `0038` shape, with accounting semantics:

```
v1.<kid>.<actor uuid>.<tenant uuid>.<business uuid>.<operation kind>
   .<source_type>.<source uuid>.<posting fingerprint>.<exp epoch s>.<jti uuid>
   .<hmac-sha256 hex>
```

Minted by the merchant API **only after** authentication, tenant/business resolution, RBAC authorization and branch-scope authorization have all succeeded. Verified inside `accounting_post_entry` by `accounting_actor(kinds TEXT[])`, which:

- recomputes the HMAC with the key named by `<kid>`, read from `accounting_assertion_keys` — a table with **no grants at all**, unreadable by `daftar_app` and by every other runtime role;
- binds every field above, so an assertion minted for one business, actor, operation, source or payload cannot be replayed for another. Because the **posting fingerprint** is inside the signature, an assertion cannot be re-pointed at a different financial snapshot after minting — but the signature alone says nothing about the payload actually submitted, which is why the primitive recomputes the fingerprint itself (below);
- enforces the expiry (60 s) and single-transaction use with cross-transaction replay protection via `accounting_assertion_uses` (`jti` + `pg_current_xact_id()`), exactly as `0038` does;
- returns the actor; the function derives tenant, business and actor **from the verified assertion**, never from a GUC or an argument. The GUCs remain only as RLS scoping for *reads*.

### The signed fingerprint is a claim about the payload, not evidence — the database recomputes it (CORRECTED)

**Problem.** Binding the posting fingerprint into the assertion proves only that *the fingerprint string* was not altered after minting. It proves nothing about the payload actually handed to `accounting_post_entry`. A caller presenting a genuine assertion for fingerprint F while submitting lines that canonicalize to G would write G into the ledger under an authorization that was never granted for it — no forgery required. An engine defect produces the same divergence with no attacker at all. **A caller-supplied fingerprint is a claim; only a recomputed one is evidence.**

**Required invariant.** `accounting_post_entry` **MUST** recompute the canonical posting fingerprint from the **actual submitted payload** — the entry header and every line as passed to it — inside the trusted database boundary, using the exact `acctfp/1` canonicalization contract of AL-11, and **MUST** require

```
recomputed_fingerprint = the fingerprint carried by the verified assertion
```

before any ledger write. On difference the call is refused with the stable, value-free code `accounting.assertion_payload_mismatch`. The comparison precedes every write in the function body — entry, lines, binding, audit and outbox alike — so a mismatch cannot leave a partial trace. A fingerprint the caller supplies as an argument is never trusted by itself and is never what is stored.

**Fields the recomputation covers** — every immutable financial field AL-11 canonicalizes, and nothing else: tenant, business, `source_type`, `source_id`, `entry_date`, and per line the resolved account identity, the debit/credit side, base amount, base currency, transaction amount, transaction currency, `fx_rate`, `fx_rate_source`, `fx_rate_at`, `branch_id`, `warehouse_id`. Narrative fields stay excluded exactly as AL-11 specifies, so a retry differing only in a description still matches.

**Consequence for AL-11 and for the division of authority.** The canonical serialization becomes a **dual implementation**, exactly like the FX formula of AL-09: `accounting_canonical_fingerprint(...)` in PL/pgSQL and the TypeScript canonicalizer must emit byte-identical output, and one shared vector suite runs against both. This is the single piece of domain serialization that legitimately belongs in the database, because it is verification rather than orchestration. The engine still computes the fingerprint in order to mint; the database simply no longer believes it.

**Test implication.** A genuine assertion for fingerprint F presented with a payload canonicalizing to G → `accounting.assertion_payload_mismatch`, and all four tables are counted afterwards to prove nothing was written. One amount, one rate, one `fx_rate_source`, one `fx_rate_at`, one `branch_id`, one `warehouse_id` and one resolved account identity altered in turn, each under an otherwise valid assertion → refused in every case. Description changed only → accepted, because narrative is outside the canonical form. The shared vector suite asserts SQL and TypeScript agree byte-for-byte on every pinned entry, including the `\x00` NULL sentinel and the line-ordering rule.

**Key ownership and rotation.** A **separate** key namespace from provisioning — `accounting_assertion_keys`, with its own `accounting_assertion_key_install` / `_retire` commands whose EXECUTE belongs to `daftar_platform` alone. Reusing the provisioning key was rejected: the two domains have different blast radii and different rotation cadences, and a single key would mean a provisioning-key compromise is also a ledger compromise. Rotation is the Phase 1 CLI pattern (install new kid → roll the API → retire old kid), and the CLI never prints key material.

### Threat boundary, stated honestly

| threat | outcome |
|---|---|
| **Stolen `daftar_app` database credential, alone** | **Cannot post.** It cannot read the assertion key, so it cannot mint a valid assertion; the function refuses every call without one. No cross-business posting, no actor impersonation, no arbitrary accounting command. It can still `SELECT` whatever RLS allows for its GUC scope — a confidentiality exposure that exists today in Phase 1 and is unchanged here. |
| **Fully compromised merchant API process** | **Can post as any business and actor it can reach**, because the minting key is in that process's memory. This is a strictly larger compromise and is **not** defended by this design. Stated plainly rather than implied away. |
| Compromised worker or platform process | Cannot post: neither holds EXECUTE on the primitive, and neither holds the minting key. |
| Compromised `daftar_platform` credential | Can install or retire assertion keys (it is the key-management principal) but holds no EXECUTE on the posting primitive and cannot read existing key secrets. |

Mitigations for the second row, which reduce blast radius without pretending to eliminate it: the key lives only in the merchant API process (never the worker, never the admin API); assertions expire in 60 seconds and are single-transaction; every posting writes an audit row naming actor, source and request id; and moving the signer behind the existing KMS bridge is recorded as the future hardening step (P2-S8 review item).

**Division of authority.** TypeScript engine → domain orchestration, FX computation, rounding, fingerprint, the mint call. `accounting_post_entry` → assertion verification, **canonical fingerprint recomputation and payload equality**, and atomic write authority. Constraints and triggers → the invariants at COMMIT. PostgreSQL logic stays narrow: verification plus writes, no domain orchestration.

**Test implication.** No assertion → refused. Assertion minted for business A replayed against business B → refused. Actor field altered → HMAC fails. A single amount changed after minting → fingerprint mismatch inside the signature → refused. Expired → refused. Replayed in a second transaction → refused. Wrong operation kind → refused. `daftar_app` reading `accounting_assertion_keys` → permission denied. Every runtime role attempting direct journal DML → permission denied (Matrix 1). A stolen-credential simulation that sets arbitrary GUCs and supplies a real member's UUID → **refused**, which is the regression test for this exact defect.

---

## AL-04 — Actor model

**Problem.** `posted_by_user_id NOT NULL` plus a mention of a "system actor" is contradictory, and inventing a synthetic user to represent the system is forbidden. Separately — and more seriously — the actor must not be believable merely because a caller supplied it (AL-03).

**Chosen solution — an explicit two-shape actor, enforced by CHECK; the value derived from a verified assertion, never from a caller.**

```
actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('user','system')),
actor_user_id     UUID NULL REFERENCES users (id),
actor_system_key  TEXT NULL REFERENCES accounting_system_actors (system_key),
CHECK (
  (actor_kind = 'user'   AND actor_user_id IS NOT NULL AND actor_system_key IS NULL) OR
  (actor_kind = 'system' AND actor_user_id IS NULL     AND actor_system_key IS NOT NULL)
)
```

`accounting_system_actors` is a closed registry **seeded empty in Phase 2**, so every Phase 2 posting is `actor_kind='user'`. The shape exists from day one so a later worker-initiated posting registers a key instead of inventing a fake user; the Phase 2 policy is that no system actor exists yet.

**Authority.** The actor identity is taken from the **signed assertion** (AL-03) and from nowhere else — not from a DTO, not from a GUC, not from a function argument the caller controls. Membership is additionally verified, but as a defence-in-depth check, **not** as the proof of identity: the earlier version treated membership as the authorization, which an attacker defeats by naming a genuine member.

**Rejected alternatives.** A synthetic system user (forbidden; pollutes identity and audit). `posted_by_user_id NOT NULL` alone (cannot express a future worker posting). A nullable user id with no `actor_kind` (no CHECK expressible). Caller-supplied actor with membership verification only (the defect corrected above).

**Test implication.** `user` shape with NULL user id → CHECK FAIL. `system` shape with a user id → CHECK FAIL. Unregistered system key → FK FAIL. Actor in the request body → ignored. Actor field tampered after minting → HMAC failure. Actor who is a real member but whose assertion names a different actor → refused.

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

## AL-09 — FX line consistency and the exact conversion formula

**Structural completeness — immediate CHECK constraints on `journal_lines`:**

```
CHECK ((debit_minor > 0)::int + (credit_minor > 0)::int = 1)
CHECK (debit_minor >= 0 AND credit_minor >= 0)
CHECK (base_amount_minor = GREATEST(debit_minor, credit_minor))
CHECK (fx_rate > 0)
CHECK (
  (txn_currency =  base_currency AND fx_rate = 1
     AND txn_amount_minor = base_amount_minor
     AND fx_rate_source = 'base'   AND fx_rate_at IS NOT NULL)
  OR
  (txn_currency <> base_currency AND fx_rate > 0
     AND fx_rate_source IN ('manual','provider')
     AND fx_rate_at IS NOT NULL   AND txn_amount_minor > 0)
)
```

`base_currency` is denormalised onto the line so the CHECK is self-contained; `fx_rate NUMERIC(20,10)`, never float; domestic lines use the explicit sentinel `fx_rate_source = 'base'`. **Partially populated FX snapshots are structurally impossible.**

### The conversion formula, exactly

`fx_rate` means: **1 major unit of the transaction currency = R major units of the base currency.**

Let `et` = transaction currency minor-unit exponent, `eb` = base currency minor-unit exponent, `rate_scale = 10^10`, and `rate_scaled = R × rate_scale` (an exact integer, since `fx_rate` is `NUMERIC(20,10)`).

From `base_major = txn_major × R` and `x_minor = x_major × 10^e`:

```
base_minor = txn_minor × R × 10^(eb − et)
           = txn_minor × rate_scaled × 10^(eb − et) / 10^10
```

Kept in integers by moving the sign of the exponent into either side:

```
numerator   = txn_minor × rate_scaled × 10^max(0, eb − et)
denominator = rate_scale × 10^max(0, et − eb)
base_minor  = HALF_EVEN(numerator / denominator)
```

with half-even on non-negative integers defined as:

```
q = numerator / denominator          -- floor
r = numerator − q × denominator
if 2r > denominator            -> q + 1
if 2r < denominator            -> q
if 2r = denominator            -> q if q is even else q + 1
```

**No floating point at any step.** In TypeScript every value is `BigInt`. In PostgreSQL the same expression is evaluated in `NUMERIC`/`BIGINT` with the identical floor-and-remainder comparison — `ROUND()` is **not** used, because PostgreSQL rounds half-up and would disagree with the engine on ties. The two implementations are mathematically identical by construction and are pinned by a shared test vector table.

### Worked examples

| # | case | txn_minor | R | rate_scaled | et → eb | numerator / denominator | base_minor | check |
|---|---|---:|---:|---:|---|---|---:|---|
| 1 | USD→ILS | 10 000 (100.00) | 3.70 | 37 000 000 000 | 2→2 | 3.7×10¹⁴ / 10¹⁰ | 37 000 | 370.00 ILS ✓ |
| 2 | JOD→ILS | 10 000 (10.000) | 5.25 | 52 500 000 000 | 3→2 | 5.25×10¹⁴ / 10¹¹ | 5 250 | 52.50 ILS ✓ |
| 3 | ILS→JOD | 5 250 (52.50) | 0.1904761905 | 1 904 761 905 | 2→3 | 1.000000000125×10¹⁴ / 10¹⁰ | 10 000 | 10.000 JOD ✓ |
| 4 | LBP→ILS (large) | 1 000 000 000 (10 000 000.00) | 0.0000111 | 111 000 | 2→2 | 1.11×10¹⁴ / 10¹⁰ | 11 100 | 111.00 ILS ✓ |
| 5 | halfway, q even | 5 (0.05) | 0.1 | 1 000 000 000 | 2→2 | 5×10⁹ / 10¹⁰ → q=0, 2r=10¹⁰=denominator | **0** | ties to even ✓ |
| 6 | halfway, q odd | 15 (0.15) | 0.1 | 1 000 000 000 | 2→2 | 1.5×10¹⁰ / 10¹⁰ → q=1, 2r=10¹⁰=denominator | **2** | ties to even ✓ |
| 7 | `MAX_MONEY_MINOR` boundary | 10¹⁸ | 1.0 | 10¹⁰ | 2→2 | 10²⁸ / 10¹⁰ | 10¹⁸ | at the cap, accepted; ×1.000000001 → rejected by AL-10 |

Cases 5 and 6 are the ones that separate HALF_EVEN from HALF_UP and are mandatory test vectors. Case 7's intermediate (10²⁸) exceeds `BIGINT` and is the reason intermediates live in `BigInt`/`NUMERIC` and never touch a `bigint` column (AL-10).

**Why the arithmetic is a trigger, not a CHECK.** The formula needs both currencies' minor-unit exponents, which requires reading `currencies`; a `CHECK` may only call IMMUTABLE expressions and may not read other tables. The equality is therefore asserted by the same deferred constraint trigger that validates balance (AL-02), which may join freely. Still database-enforced against every writer — it simply fires at COMMIT.

**Test implication.** All seven vectors above in both implementations, asserted equal. Rate without source → FAIL. Domestic line with rate ≠ 1 → FAIL. Foreign line with rate ≤ 0 → FAIL. `base_amount_minor` ≠ booked side → FAIL. `base` ≠ HALF_EVEN(txn × rate) → FAIL at COMMIT.

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

## AL-11 — Idempotency, and the canonical fingerprint specification

**Chosen solution — `UNIQUE (business_id, source_type, source_id)` plus a precisely specified financial fingerprint.**

`journal_entries.posting_fingerprint CHAR(64) NOT NULL` — SHA-256 over a **canonical byte string**, not over `JSON.stringify()`.

### Canonical serialization (version `acctfp/1`)

```
acctfp/1\n
<tenant_id>\n<business_id>\n<source_type>\n<source_id>\n<entry_date>\n
<line>\n<line>\n...
```

Each line, fields separated by `\x1f` (unit separator), lines terminated by `\x1e` (record separator):

```
<account_identity><side><base_amount_minor><base_currency>
<txn_currency><txn_amount_minor><fx_rate><fx_rate_source>
<fx_rate_at><branch_id><warehouse_id>
```

Normalization rules, all mandatory:

| element | rule |
|---|---|
| version prefix | literal `acctfp/1`, so the format can evolve without silently changing meaning |
| UUID | lowercase canonical 8-4-4-4-12, no braces |
| `account_identity` | `system_key` when present, else `code:` + the code — resolved identity, never the display name, never the surrogate id |
| `side` | literal `D` or `C` |
| amounts | decimal integer, no sign for positive, no leading zeros, no separators |
| currency | uppercase ISO-4217 |
| `fx_rate` | fixed **10** fraction digits, always, including `1.0000000000` for domestic lines |
| `fx_rate_source` | lowercase enum literal |
| `fx_rate_at` | RFC 3339 UTC with `Z`, second precision |
| `entry_date` | `YYYY-MM-DD` |
| NULL | the single byte `\x00` — distinct from an empty string, so a NULL branch and an empty branch cannot collide |
| line ordering | sort ascending by the serialized line bytes themselves, so ordering is defined by the canonical form and not by insertion order |
| text | no free text is included, so no Unicode normalization question arises; if a future version adds text it must specify NFC |
| encoding | UTF-8 |

**Included** (every immutable field that changes the financial snapshot): tenant, business, source type, source id, entry date, and per line — resolved account identity, side, base amount, base currency, transaction currency, transaction amount, rate, rate source, rate timestamp, branch, warehouse.

**Deliberately excluded**, and documented as narrative-only: description, line memos, request id, actor, created timestamps. A retry differing only in narrative is the same financial fact. **A materially different FX snapshot is not narrative** — rate, source and timestamp are all inside the fingerprint, so changing any of them produces a conflict rather than a silent replay.

### Behaviour matrix

| scenario | behaviour |
|---|---|
| sequential retry, identical content | `created=false`, existing entry id; no second audit row, no second outbox event |
| concurrent retry, identical content | one inserts; the loser catches the unique violation, re-reads, compares fingerprints, returns `created=false` |
| same source, **materially different** content (including a different rate, source or rate timestamp) | `accounting.idempotency_conflict` → HTTP 409 with the existing entry id. **Never silent success** |
| rollback then retry | nothing persisted; the retry posts normally — uniqueness lives in the database |
| same source, different description only | `created=false` |

The comparison happens inside `accounting_post_entry`, so no caller can skip it. The fingerprint is also bound into the command assertion (AL-03), and the primitive **recomputes the canonical form from the submitted payload** before any write, so a signature over a fingerprint that does not describe that payload is refused with `accounting.assertion_payload_mismatch`. Consequently the serialization specified above is implemented twice — TypeScript and PL/pgSQL — and pinned by one shared vector suite; the two must agree byte-for-byte.

**Test implication.** All five rows, the concurrent case on two real connections, and a vector suite pinning the canonical bytes for a known entry so an accidental serialization change fails loudly rather than silently re-hashing history — run against **both** implementations, since a divergence between them would refuse every legitimate posting.

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

## AL-13 — Opening balance model and its exact state machine (CORRECTED)

**Problem.** The earlier version said `posted` is "terminal and immutable" and then described a `posted → superseded` transition. Those cannot both be true.

**Chosen lifecycle — financial CONTENT is immutable after posting; ONE controlled status transition exists.**

```
draft ──post──▶ posted ──supersede──▶ superseded
  │                                        
  └──discard──▶ (row deleted, no journal entry ever existed)
```

| property after `posted` | rule | enforcement |
|---|---|---|
| lines | immutable | BEFORE UPDATE/DELETE trigger on `accounting_opening_balance_lines` raises when the parent is not `draft` |
| `as_of_date` | immutable | BEFORE UPDATE trigger |
| `journal_entry_id` | immutable | BEFORE UPDATE trigger |
| `id` (source identity) | immutable | primary key + the AL-01 binding, which is undeletable |
| `status` | **the only mutable column**, and only `posted → superseded` | BEFORE UPDATE trigger admits exactly that one transition and rejects every other column change |
| supersession precondition | a valid reversal of this opening balance's journal entry must already exist | the same trigger checks `accounting_reversals` for `original_entry_id = journal_entry_id`; absent → `accounting.supersede_without_reversal` |
| who may do it | the narrow audited command only — no runtime role holds UPDATE on the table | grants + AL-03 write boundary |
| audit | mandatory row in the same transaction | AL-17 |

So the resolved statement is: **the posted financial content is immutable; the source row carries one audited, precondition-guarded status transition.** An arbitrary `UPDATE` is denied by grants, and even through the owner the trigger admits nothing but that single transition.

**Rejected alternative.** An append-only `accounting_opening_balance_supersessions` record instead of a status column. It is equally sound and avoids mutating the source row at all; it was rejected only because "which set is current" then requires a join on every read, and the partial unique index below gives the same guarantee more cheaply. Recorded so the choice is visible rather than assumed.

Other properties, unchanged: `CREATE UNIQUE INDEX ... ON accounting_opening_balances (business_id) WHERE status = 'posted'` gives exactly one current set per business, and makes replacement impossible without first superseding; the equity plug is an explicit visible line to the `opening_equity` system account, never an invisible adjustment; foreign positions carry a complete FX snapshot with `fx_rate_source='manual'`; `source_type='opening_balance'`, `source_id = accounting_opening_balances.id`; and it posts through `accounting_post_entry` like everything else.

**Test implication.** Edit lines after posting → FAIL. Change `as_of_date` after posting → FAIL. Change `journal_entry_id` → FAIL. `posted → superseded` without a reversal → FAIL. With a reversal → PASS, audited. `superseded → posted` → FAIL. Two posted sets → unique violation. Plug line present and correct, including the zero case.

---

## AL-14 — Posting-date semantics, and where periods belong (CORRECTED)

**Periods are NOT in the first implementation slice.** They are slice **P2-S6**, conditional on confirmation at that point. Nothing in P2-S1…P2-S5 needs a closed period to be correct, and designing close/reopen concurrency before any posting traffic exists would be speculation. `journal_entries.entry_date DATE NOT NULL` ships in P2-S2, and the AL-02 validation routine is the documented plug-in point, so adding periods later requires **no journal schema change**. When periods land, **the period model becomes the authoritative posting-date gate** and the interim rules below are superseded by it.

### The arbitrary 10-year rule is withdrawn

The earlier version proposed rejecting any `entry_date` before `business.created_at − 10 years`. That has **no accounting authority** and would reject legitimate history: a company founded in 1974 joining DAFTAR in 2026 has a real opening position older than any such window. It is removed, not softened.

### Source-specific date semantics instead

Each source type declares its own rule, because the correct rule genuinely differs by source. All comparisons use "today" in the **business's own timezone** (`businesses.timezone`, already stored in Phase 1), never the server's.

| source | lower bound | upper bound | rationale |
|---|---|---|---|
| `opening_balance` | **none** — it may predate DAFTAR onboarding by any amount | `as_of_date ≤ today` | the opening position is historical by definition; an arbitrary cutoff would exclude long-running companies |
| `manual_adjustment` | none in Phase 2; back-dating is permitted and audited | `entry_date ≤ today` | once periods exist, the open-period boundary becomes the real lower bound |
| `reversal` | `entry_date ≥ the original entry's date` | `entry_date ≤ today` | a reversal cannot precede the fact it reverses |

**Future-dated postings are forbidden in Phase 2 for every source**, explicitly and uniformly: `entry_date ≤ today` in the business timezone. The earlier draft's `today + 1 day` tolerance is withdrawn — it existed only to paper over timezone ambiguity, which resolving "today" in the business timezone removes.

The rule is enforced in `accounting_post_entry` per source type, so it cannot be bypassed, and it is expressed as data (a column on `accounting_source_types`) rather than as branching logic, so a future source type declares its policy rather than editing the primitive.

**When P2-S6 is authorized it must specify**: non-overlapping contiguous periods (exclusion constraint), open/closed state, close actor and time, reopen actor, time and mandatory reason, closed-period posting refused in the database, the timezone/date authority, close↔post concurrency, and full audit.

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

## AL-18 — Implementation slice boundaries (CORRECTED)

**Problem.** The earlier ordering put the journal **and** `accounting_post_entry` in P2-S2, with the source binding, fingerprint and idempotency arriving in P2-S3. That would have ended a slice with an executable ledger writer whose integrity and authority dependencies did not yet exist. A slice PASS must never mean "safe after the next slice".

**Governing rule.** *Every slice must be independently safe.* Structural schema may land before its writer exists — a table nobody can write to is safe. A writer may **not** land before every verification, binding, fingerprint, audit and outbox protection it depends on. `GRANT EXECUTE` on the posting primitive happens in exactly one slice: the one where all of them are present.

| slice | content | migrations | why it is safe on its own | exit criteria |
|---|---|---|---|---|
| **P2-S0** | Architecture lock — decisions only | **0** | no schema, no code | Tech Lead approval |
| **P2-S1** | `accounts`, system-key registry, seeding routine + `businesses` trigger + backfill, accounting permissions | `0040`, `0041` | a chart with no journal and no writer cannot record financial truth | every existing and new business has a chart; AL-05/06/07/08 green; guard G-3 active |
| **P2-S2** | Journal + binding **structural schema only**: `journal_entries`, `journal_lines`, `accounting_source_types`, `accounting_source_bindings`, all CHECKs, both immutability triggers, both deferred validation triggers, RLS, **and the full REVOKE shape**. **No writer function. No EXECUTE granted to anyone.** | `0042`, `0043` | nothing can write to these tables at all — not `daftar_app`, not any runtime role, and no primitive exists yet. The invariants are already active before the first row can exist | Matrix 1 (privilege, generated from the live catalogue) and Matrix 2 (invariants A–H) both green; guard G-2 active |
| **P2-S3** | Assertion keys + `accounting_actor()` verification + `accounting_post_entry` + fingerprint **computed in TypeScript and recomputed in PL/pgSQL, with the equality check before any write (AL-03)** + audit + outbox, **and only now `GRANT EXECUTE` to `daftar_app`** | `0044`, `0045` | the writer becomes reachable in the same slice that gives it its unforgeable authority boundary, its binding integrity and its atomicity — never before | AL-03 spoofing suite including the payload-mismatch cases, the shared canonical-fingerprint vectors green in both implementations, AL-11 matrix, AL-17 failure-injection matrix all green; guard G-4 active |
| **P2-S4** | Manual adjustment, reversal, opening balance — Phase-2-owned sources | `0046`, `0047` | each source rides the already-hardened writer | AL-12 and AL-13 state-machine tests green |
| **P2-S5** | FX foundation: manual rate source, immutable snapshot, rounding, realized-FX primitive | `0048` | additive to a hardened engine | the seven AL-09 vectors green in both implementations; guard G-2 extended to every rate field introduced here |
| **P2-S6** | Accounting periods — **only if confirmed** (AL-14) | `0049` | plugs into the existing validation routine | close/reopen/concurrency green |
| **P2-S7** | Trial balance, general ledger, account balances — live aggregation | `0050` (indexes only, if needed) | read-only | reports balance; rebuild-equals-live green; guard G-3 extended to any read-model table added here |
| **P2-S8** | Red team, cross-tenant, raw SQL, failure injection, rollback rehearsal, performance dataset, KMS-backed signer review | 0 | verification only | budgets met or materialization justified |
| **P2-S9** | Release closure: gate, RC archive, evidence, docs | 0 | verification only | repository and extracted-archive gates both PASS, zero skips |

The migration numbers shifted by one from the first version because assertion-key management is its own migration in P2-S3.

### Mechanical guards required by slice

Each of these is a machine check in CI, not a review habit. A guard lands **in the slice named**, so no slice ships a surface its guard does not yet watch.

| # | guard | slice | what it refuses |
|---|---|---|---|
| G-1 | privilege matrix generated from the **live** PostgreSQL grant catalogue (`information_schema.role_table_grants` and the function ACLs), compared against the intended grant model as data | P2-S2 | any DML grant on `journal_entries`, `journal_lines` or `accounting_source_bindings` reaching any runtime role, including one added later by a migration nobody re-reviewed. Hand-written negative tests stay, but they prove only the cases someone thought of; the enumeration proves the rest |
| G-2 | static guard rejecting `REAL`, `DOUBLE PRECISION` and `FLOAT` for `fx_rate` and every accounting financial-rate column | P2-S2, extended in P2-S5 | a float rate. The existing `static-guards.ts` money rule keys off the column names `amount|price|total|balance`, so a rate column passes it untouched today — the guard must match rate-shaped names as well |
| G-3 | static guard forbidding an authoritative mutable balance column on `accounts` or any accounting source-of-truth table | P2-S1, extended in P2-S7 | the AL-15 failure mode. The existing rule's comment names `customer.balance` but its pattern matches `stock` only, so nothing would catch it today |
| G-4 | release check tying the writer to its protections: if `accounting_post_entry` exists in a released tree, then assertion verification, the source-binding registry, the canonical fingerprint recomputation, the audit write and the outbox write must all exist too | P2-S3 | a tree in which AL-18's governing rule was broken by a later edit. This is the one mechanical expression of "a writer may not land before its protections" |



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

| K-08 | The first version of AL-01 claimed a source-side FK with `ON DELETE RESTRICT` stopped a source row from disappearing | **Relationally false** — that FK restricts deletion of the *journal* row, not the source row, and proves nothing about entries without a source. Corrected by the bidirectional binding registry |
| K-09 | The first version of AL-03/AL-04 treated `app_tenant()`/`app_business()` plus membership verification as authorization | **Insufficient** — GUCs are caller-settable and an attacker names a genuine member. Corrected by the signed Accounting Command Assertion |
| K-10 | The first version of AL-13 called `posted` terminal *and* described a `posted → superseded` transition | Corrected to one explicit state machine: content immutable, exactly one audited status transition, gated on an existing reversal |
| K-11 | The first version of AL-14 imposed an arbitrary `created_at − 10 years` floor | Withdrawn — it has no accounting authority and rejects legitimate history. Replaced by source-specific date semantics |
| K-12 | The first version of AL-02 claimed cases A–G run meaningfully as all six roles, and allowed sums in error messages | Corrected — two separate matrices (privilege vs invariant), and stable codes with no financial values in exceptions |
| K-13 | The first version of AL-18 exposed the writer in P2-S2, before its authority and integrity dependencies | Corrected — structural schema and writer are separated; `GRANT EXECUTE` lands only with the full protection set |
| K-14 | AL-03/AL-11 treated the **caller-supplied** posting fingerprint inside the assertion as proof about the submitted payload | **Insufficient** — the signature proves only that the fingerprint string is intact, not that it describes the lines actually submitted, so a genuine assertion for fingerprint F could accompany a payload canonicalizing to G. Corrected: the primitive recomputes the canonical fingerprint in the database and requires equality before any write, refusing with `accounting.assertion_payload_mismatch` |

No conflict was resolved by silently preferring one document; each is recorded above.

---

## What this document does NOT authorize

No migration `0040`. No `accounts` table. No `journal_entries` or `journal_lines` table. No accounting module, endpoint or screen. No placeholder operational-domain tables. Implementation begins only when the Tech Lead approves this lock and issues the P2-S1 directive.
