# P11 — DECISIONS: RULED, AND WHAT IS LEFT

**Revised 2026-10-08.** Every question this document opened on 2026-10-07 has been ruled, except one that is business/legal by nature. The rulings came back with **two defects in the submission**, both real; they are recorded here as well, because a decision log that hides what was returned is not a log.

---

## 1. Ruled

| id | question | ruling | where |
|---|---|---|---|
| **ADJ-P11-01** | overlay below the key, or extend the stock key? | **Option B — overlay.** Lot and serial extend **traceability identity**; they do **not** extend the authoritative costing key, which stays `business + warehouse + variant`. This **explicitly narrows** the forward-looking Phase 3 wording; the frozen Phase 3 files are not edited and the ruling is recorded instead. | `TL-P11-R1` |
| **OD-P11-01** | per-serial actual cost? | **NO.** No per-serial actual-cost authority. | `TL-P11-R2` |
| **OD-P11-02** | lot-layer / FIFO costing? | **NO.** The variant moving weighted average remains the authority; FEFO/FIFO is **picking only**; **lot choice must not change COGS.** | `TL-P11-R2` |
| **OD-P11-03** | serial uniqueness scope | **Per business + serial kind + normalized value.** The same IMEI may not exist under two variants of one business. | `TL-P11-R3` |
| **OD-P11-04** | expired stock: refuse or warn? | **Refuse** — and **Phase 11 adds no generic override**, not even the audited permission that was recommended. A future country or regulated pack may add a dedicated permission, its audit and an explicit policy once an override is established as lawful and wanted. No silent fresher-lot substitution. | `TL-P11-R4` |
| **OD-P11-05** | warranty duration source | **Record explicitly**: `source` = business or vendor, `starts_on`, `ends_on`. **No warranty inferred from a category.** No accounting provision or accrual in Phase 11. | `TL-P11-R5` |
| **OD-P11-06** | labour: service product or a new line kind? | **Service product.** No new financial line type, no inventory effect — **and it depends on a sealed Phase 10 `SERVICE` stock-effect capability**, which Phase 11 neither owns nor pre-empts, and registers nothing dead in Phase 10 for. | `TL-P11-R6` |

## 2. Returned with the ruling — two defects in the submission

### §55 — the serial cost snapshot violated this phase's own no-money law
The recommendation on OD-P11-01 was "no per-serial costing, but store the inbound `unit_cost_base_minor` on the serial row for reporting only, explicitly non-authoritative". **Refused**, and correctly: that is a copied monetary column on a Phase 11 relation, which law L-P11-02 — written by the same hand, three documents earlier — forbids. "Non-authoritative" describes a hope about how readers will behave, not a property the column has; the first margin report would have used it.
**Now:** no monetary column on any lot, serial or repair relation. Reporting that needs an acquisition cost **joins back** to the canonical inventory and accounting history through the movement the custody chain already names. The red proof for L-P11-02 plants this exact column, with its report-only comment, so the comment cannot exempt it.

### §60 — the repair flow would have decremented inventory twice
The submission billed a repair by putting the consumed parts on a Phase 4 invoice as **ordinary sale lines**, after those parts had already left stock through the repair source. A tracked part on a sale line *is* a stock effect, so the part would have been decremented twice and its COGS posted twice. It reads as reuse of the sales authority; it is a second stock effect, and the financial bar's "no double stock decrement / no double COGS" names it exactly.
**Now, per `TL-P11-R7`:** physical consumption happens **once**, under the repair part consumption authority; billing references it through a **new additive Phase 11 contract extension** — the preconsumed sale-line binding (`P11-AL-21`) — under eight conditions together: server-derived, not client-choosable, exact source, exact qty, same business, one binding per consumption, a prior canonical movement must exist, and zero second movement and zero second COGS, with revenue, AR and cash still through the sales authority. The extension is added by **Phase 11, not Phase 10**, only once a real repair writer exists, and nothing is registered dead in Phase 10.
**The fail-open case to attack first** is condition 7: a binding that can be created before its consumption exists re-opens the defect by another door. And condition 2 is proved by **unrepresentability**, not by a refusal — the request schema has no property for a binding at all, because a refusal can be forgotten on one path while an absent field cannot.

**What the two have in common**, worth carrying into Phases 12–15: a vertical pack's instinct is to hand an existing authority something that *looks* like its normal input. A cost column and a sale line are both "just reuse" until the value is copied or the effect lands twice. In both cases the structural answer was the same — **do not copy the value, do not re-enter the authority, bind to the record that already exists.**

## 3. Also binding, from the same directive
- **§62 — an Accounting Owner gate before `repair_part_consumption` goes live:** the debit account, the inventory credit, valuation from the canonical moving average, the correction/reversal path, and no duplicate COGS at invoice time. Repairs author **no** journal logic. If the current inventory posting map cannot represent repair consumption safely, this becomes an **Accounting-owner Contract Diff** — not a Phase 11 workaround. Task `P11-REP-008`, and it is worth starting now because its answer can change the repair pack's shape.
- **§63 — the customer's device:** not inventory, no valuation, no stock movement, and the terminal custody state is the neutral operational **`uncollected`**, never `abandoned`, until business and legal policy define abandonment. The system records custody facts; it decides no legal ownership or liability. A pack that ships `abandoned` in a CHECK has quietly taken a legal position in a column name.
- **§81 — every DDL here is `SPEC ONLY`** until PostgreSQL parses and applies it, with the first rehearsal **as the intended migrator, application and internal roles, never superuser-only**, capturing the earliest error.
- **§88 — promotion order is unchanged:** Phase 11 promotes eleventh. Preparation is parallel; promotion is not.

## 4. Still with the owner — the only one left

### OD-P11-07 — liability for a customer's device in custody (business / legal)
What the business owes if a device in custody is lost, damaged or never collected, and after how long an uncollected device may be treated as abandoned. **Out of engineering scope** (§94: ask the owner only for legal liability, country tax or legal policy, real pricing, real credentials, irreversible external action, or final production authorization — this is the first of those). The system meanwhile records custody states and their timestamps and actors, faithfully and append-only, computes no liability, and uses the neutral `uncollected`. Nothing in Phase 11 is blocked on the answer; the day it arrives it is a policy value and a possible new state, not a redesign.

## 5. Decisions inherited and closed — do not reopen
- **OD-03 (tax).** Sales tax is a structural zero; a non-zero tax is refused, never normalized. Phase 11 adds no tax field and no country rule.
- **One authority per truth.** Accounting, inventory, AR/AP, settlement, RLS and the migration train each have exactly one. A pack may design, test, attack, review and prepare; it may not create a competing authority.
- **One stock writer**, and lot/serial are traceability overlays — now the directive's own words (§87), not only this phase's proposal.
- **No offline pack state before Phase 7.** Android has no local persistence layer and a static guard forbids a database there; serial and lot capture are input only.
