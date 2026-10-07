# PATCH-REQ-S5-002 — register the three P4-S5 accounting source types, and move the reversal guard with them

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target | the S5 migration (prefix UNKNOWN until S4 seals), written by the ONE migration owner; plus `scripts/phase4-s4-gate.ts` if its ruled source-type list is to name S5's |
| owner of target | the single migration owner; `scripts/**` is a shared permanent area |
| depends on | S4 sealing, because `0081` is an S4 candidate and becomes frozen on acceptance |
| blocks | the S5 migration itself — a source type with no reversal-guard row is a type `daftar_app` can reverse through the generic path |

## Required change

### 5.2.0 Measured first: no row exists for any of the three, and the naming follows `0065`

`accounting_source_types` is created CLOSED by `0042:65-68` (three natives, with a `DO $$`
asserting exactly three) and widened only by an explicit `INSERT`. Every such `INSERT` in the
tree was read at `6587460`. The live registry holds **seventeen** types:

```
0042  opening_balance, manual_adjustment, reversal                      (1-3)
0061  inventory_adjustment, inventory_opening
0063  purchase, negative_inventory_cost_adjustment
0065  supplier_return
0067  supplier_payment, supplier_credit_allocation, supplier_refund
0072  purchase_residue_write_off
0077  sale (13), invoice (14)
0081  customer_payment_allocation (15), customer_credit_application (16), customer_credit (17)
```

**None of them is a credit note, a return of a customer's goods, or a refund to a customer.**
There is no `credit_note`, no `refund`, no `customer_return` and no `allocation_reversal`. So
binding to an existing identity — the pattern to prefer — is simply NOT AVAILABLE here: there is
nothing to bind to. Minting is forced, and the three take `sort_order` 18, 19, 20.

**What the precedent does decide is the NAMING.**
`supplier_credit_notes.accounting_source_type` is
`GENERATED ALWAYS AS ('supplier_return') STORED` (`0065:199`) — the supplier credit note binds to
the `supplier_return` type and **no `supplier_credit_note` type was ever minted**, because the
credit note is the accounting FACE of the return rather than a second event.
`purchase_reversals` does the same one step further out, binding to the native `reversal`
(`0065:310`). So S5's first type is **`customer_return`** and not `customer_credit_note`: the
event is the customer returning goods, and `credit_notes` is its document. The registry gains one
identity for the whole return rather than one per relation — the exact mirror of the supplier
side.

**Three types and not one**, because they are three entries at three grains with three different
expected journal shapes, and one type with a branch inside its completeness validator is how a
shape nobody checks arrives (`TL-P4-S1-R1`). The supplier side reached the same answer:
`supplier_return`, `supplier_credit_allocation` and `supplier_refund` are three.

**And S5 mints no reversal type and ships no reversal relation.** `payment_reversals` and
`allocation_reversals` belong to P4-S6, with `void_invoice`. Nothing in this specification names,
creates or needs one, and a refund has no dependency on a reversal existing: a refund lawfully
discharges a liability that was correctly recorded, where a reversal unwinds an entry that should
not have been made.

### 5.2.1 The change

**(a) Register three source types** in the S5 migration:

```sql
INSERT INTO accounting_source_types (source_type, lower_bound_policy, sort_order) VALUES
  ('customer_return',              <policy>, 18),
  ('customer_credit_note_application',  <policy>, 19),
  ('customer_refund',                   <policy>, 20);
```

The `sort_order` values continue the live sequence: `0077:1702-1703` registered `sale` (13) and
`invoice` (14); `0081:2468-2472` registered `customer_payment_allocation` (15),
`customer_credit_application` (16) and `customer_credit` (17).

**(b) In the SAME migration**, `CREATE OR REPLACE accounting_reversals_20_domain_source_guard()`
so its `source_type IN (…)` list at `0081:1412` — thirteen types today — names the three new
ones. The replacement keeps the surrounding
`SET LOCAL ROLE daftar_accounting_internal` / `RESET ROLE` (`0081:1403`, `:1437`) and changes
nothing else, and it re-issues `REVOKE ALL … FROM PUBLIC` because `CREATE OR REPLACE` resets a
function's ACL.

**(c) Ship the THREE deferred completeness validators** — one per registered type — in the same migration, because
`TL-P4-S1-R1` is that *"an accounting source type with no writer, no binding, no expected
journal shape and no deferred completeness validator is a dead concept"*.

## Reason

`P4-AL-47` and seam `S-P4-02` (`scripts/phase4-s1-gate.ts:1483-1495`) require a registration
and the reversal guard's list to move TOGETHER. `0081:1398-1402` states the handover explicitly.
The moment a type is registered without its guard row, `daftar_app` can reverse an S5 entry
through the generic path — an ordinary runtime credential effecting an accounting reversal it
has no authority for.

**The spelling follows the LIVE REGISTRY and not `P4-AL-20`.** The lock
(`docs/PHASE_4_ARCHITECTURE_LOCK.md:476-478`) enumerates six types and names
`payment_allocation`, `credit_note`, `refund`. All three are wrong against the tree:
the live name is `customer_payment_allocation`, the S4 gate pins that spelling as RULED
(`scripts/phase4-s4-gate.ts:577`, refusing a settlement text that does not register each of the
three at `:865-870`), and `customer_credit` is a live type the lock never enumerated. The
convention the live rows establish — the row's own domain, singular, `customer_`-prefixed, in a
different namespace from the `customer.*` op codes "which is why the two deliberately differ"
(`0081:2460-2465`) — is the authority. **Whichever spelling the Tech Lead rules, the lock's
enumeration is not it.**

## Dependency on S4

`0081` is an S4 CANDIDATE file at `6587460` and becomes frozen on acceptance. A
`CREATE OR REPLACE` of a routine shipped by a frozen migration is done in a NEW migration,
never by editing the frozen file. So (b) cannot be written until the prefix is known, which is
after S4 seals.

## The test that requires it

- the integrated S5 gate's source-type arm: every registered type has a writer, a binding, an
  expected journal shape and a deferred validator;
- `tests/guards/p4s5-refund-plan-red-proofs.test.ts`, §9 ("the source types follow the LIVE
  registry convention, not P4-AL-20's stale enumeration") asserts the naming today, at level C,
  from `@daftar/domain-core`'s `S5_ACCOUNTING_SOURCE_TYPES`;
- the red proof the patch itself owes: a `daftar_app` attempt to reverse a `customer_refund`
  entry through the generic path must be REFUSED, and the proof must show it was ADMITTED before
  the guard's list was widened.

## Expected semantic diff

- `accounting_source_types` goes from 17 Phase-2-through-S4 rows to 20;
- `accounting_reversals_20_domain_source_guard`'s list goes from 13 types to 16;
- `daftar_app` loses a reversal path it never should have had on three types that did not exist
  before, so no existing behaviour changes.
