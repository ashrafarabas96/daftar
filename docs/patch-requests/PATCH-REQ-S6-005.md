# PATCH-REQ-S6-005 — a frozen `prosrc` digest blocks TD-15's supplier twin. A ruling is needed.

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN — **this is the one blocker that is a decision and not a task.**
**Severity:** blocks TD-15, which `docs/PHASE_4_ARCHITECTURE_LOCK.md:1630` makes
non-optional: *"Phase 4 may not close with TD-15 unowned."*

## Target files

- the S6 migration (number unknown), **and**
- `tests/security/settlement-s6-guard-gaps.test.ts` — an **existing Phase 3 suite**, which
  S6 may not edit, **and**
- `infrastructure/database/migrations/0067_payment_methods_supplier_settlement_sources.sql` —
  **FROZEN**, and not editable by anyone.

## The measured fact

`supplier_settlement_guard_gaps()` (`0067:1795`) carries `c_digest`, a JSONB of the SHA-256
of each Phase-3-S6-era guard, helper and arithmetic function's `prosrc`, "recorded at
migration time (0067)". Among them:

```
"purchase_settlement_verify(uuid,uuid)": "4fcbb7931c06fbf9cf11fc2ede6e4b97357d24b038ed412329c55a48cbafe8ba"
```

at `0067:1817`, with that function as row 15 of the function's own discovery table
(`0067:1829`). The function is a **reporting** set-returning function; its consumer is
`tests/security/settlement-s6-guard-gaps.test.ts`.

## Why S6 must touch it

`purchase_settlement_verify(uuid,uuid)` (`0067:717`) is the supplier-side chain verifier. It
chains **every** AP reducer of a purchase — `supplier_returns`,
`supplier_payment_allocations`, `supplier_credit_allocations` — with no notion of an
**active** subset, because Phase 3 has no reversal (that is TD-15). TD-15's closure requires
reversing a supplier payment, a supplier credit allocation **or** a supplier refund
(`TECHNICAL_DEBT.md:24`; `docs/PHASE_4_ARCHITECTURE_LOCK.md:172` records that the debt's own
text names **three** sources, not one). Each of those leaves a reversed reducer in place, so
the verifier must chain over the **active** subset — which changes its `prosrc`.

> **Widening `purchase_settlement_verify` makes a digest pinned inside a frozen migration
> read false, which turns an accepted Phase 3 security suite RED.**

This is the same class of cross-phase surface `0081:55-67` (R-85) discloses for Departure B,
and it is disclosed here for the same reason: *"The gap is REAL and DISCLOSED"* beats a
workaround.

## A second, independent hazard in the same change

`0067:2790`, `0072:903` and `0077` each assert a **SUBSTRING** of
`accounting_reversals_20_domain_source_guard()`'s always-refused source-type list, and
`0081:1395-1399` records why: *"Appended, not inserted, because … a reordering would make a
frozen migration's own end-state claim read false against the body the database then holds."*
S6 **moves three types out of** that list into a `purchase`-style paired arm, which changes
its membership. The S6 migration must probe what those substring assertions still match, and
either keep the plain arm's remaining order byte-identical or carry this same ruling.

## The three ways through, each a decision above this slice

1. **Re-record the digest** in the S6 migration, with the probe ritual `0067` itself uses.
   Cheapest. It means a Phase 4 migration writes a number that a frozen Phase 3 migration
   authored, which is cross-phase surface no one has ruled on.
2. **Re-express the Phase 3 suite** to scope its digest claim to the Phase 3 prefix's own
   functions — the device already applied to
   `tests/security/settlement-s6-no-customer-payments.test.ts`
   (`docs/PHASE_4_S5_PREPARATION.md` §0 item 3). It edits a `tests/` suite S6 does not own.
3. **Compose a new active-subset verifier beside the pinned one.** Touches nothing frozen,
   and risks a **second statement of the chain law** — which law 7 of S6's brief and
   `P4-AL-22` both forbid. This is the option this request likes least and records only so
   the enumeration is complete.

## Dependency

Nothing can be built on the supplier side until this is ruled. **No supplier-side reversal is
specified past level E in S6's pack**, and `READY_TO_PROMOTE = NO` carries this as its first
missing item (`docs/PHASE_4_S6_CONTRACT_PACK.md` §14).

## The test that requires it

`tests/security/settlement-s6-guard-gaps.test.ts`, which goes **red** on the widening and is
therefore the test that forces the decision rather than one that waits for it.

## Expected semantic diff

None until ruled. Each option has a different one, and choosing between them is the request.
