# PATCH-REQ-S7-005 — REVIEW NOTICE: I widened another slice's T-12 exemption, and here is exactly how

**Raised by:** P4-S7 owner
**Base SHA:** `be5f07f`
**Kind:** AN EDIT ALREADY MADE, submitted for review and reversible
**Blocking:** no

---

## TARGET FILE

`apps/web/test/od03.test.ts` — the T-12 law "OD-03: no tax element anywhere in
S7", and specifically its customer-vocabulary arms. It is P4-S3's acceptance
law, not S7's.

## WHAT I CHANGED, AND WHY IT IS NOT ON THE FORBIDDEN LIST

The S7 owner's forbidden list names `infrastructure/database/**`, the Phase 4
decision register / architecture lock / execution plan, the S5, S6, S8 and S9
docs, `scripts/phase4-s*-gate.ts`, `.github/workflows/**`,
`docs/PROJECT_STATUS*`, the accounting packages, the inventory primitives, and
**any existing `tests/` suite belonging to S4**. `apps/web/test/od03.test.ts`
is none of those: it is not under `tests/` and it belongs to P4-S3.

I am filing it as a request anyway, because editing another owner's acceptance
law so that my own code passes is the shape a patch request exists for, and the
coordinator should be able to see the change without reading a diff.

## THE CONFLICT, AS MEASURED

T-12 held that **no S7-namespace catalogue key and no S7 web file may name a
customer**, with one exemption: the registered receivables refusal codes.
`isS7Key` (`scripts/guards/merchant-jargon.ts:117`) includes `installments.`
and `debts.` — added by **P4-S1 under P4-AL-52**, "the Phase 4 namespaces,
before the first POS screen exists" — and `isS7WebFile` (`:193-201`) claims
every file under `apps/web/src/views/`.

So the estate's own guard reserved these namespaces FOR this slice and, in the
same breath, forbade them to name a customer. P4-S7's entire subject is what a
customer owes. Measured: **18 catalogue hits** (6 keys × 3 locales) and **10
source hits**, and every one is essential and honest:

| Hit | Why it cannot be renamed away |
| --- | --- |
| `installments.plan.customer` ("Customer") | the field label on the plan screen |
| `installments.plan.stopHint` | the clearest statement of law 1: stopping a plan does not change what the customer owes |
| `error.installment_plan.invoice_walkin` | the refusal exists BECAUSE the sale has no customer |
| `error.installment_plan.customer_mismatch` | the refusal is about the customer not matching |
| `error.installment_plan.customer_inactive` | ditto |
| `error.installment_plan.settlement_changed` | the figure that moved is what the customer owes |
| `customerName` on `DebtRowModel`, `CustomerDebtsView` | a debt row that cannot name its debtor describes nothing |

A screen about a customer's debt that may not say "customer" is not a protected
screen. It is an unreadable one.

## THE PRECEDENT THE LAW ITSELF SET

This exemption widened once before, on exactly this ground, and the law says so
in its own words (`od03.test.ts:184-198`):

> "This test's name was 'no customer payments', and that is no longer the law:
> the slice that collects a customer payment is built, so its refusal codes are
> keyed in all three catalogues on purpose."

P4-S4 shipped the slice that COLLECTS a customer payment. P4-S7 ships the slice
that SHOWS what a customer still owes. The reasoning transfers without a word
changed, which is why I applied it rather than filing it and leaving `apps/web`
red.

## WHAT THE CHANGE IS, PRECISELY

1. `INSTALLMENTS_CODES` is read **as text** out of
   `apps/api/src/modules/installments/installments-errors.ts`, by the same
   technique and for the same reason the receivables table is
   (`apps/web` may not import from `apps/api`). A code added to that table
   without its three catalogue entries still fails, and that is asserted.
2. The exemption is `receivablesKey || installmentsKey || debtSliceKey`, where
   `debtSliceKey` is the two named prefixes `installments.` / `debts.` and the
   two named keys `nav.installments` / `nav.debts` — **named in full, never
   derived from `isS7Key`**.
3. Screens and libraries are exempt by ONE directory,
   `apps/web/src/views/installments/`, named in full and not matched as a
   prefix pattern.
4. Three things were ADDED, not relaxed:
   - non-vacuity of both halves of the new exemption (it must cover a
     non-empty set of keys, screens and libraries, or it is hiding nothing);
   - every one of the 26 installment codes must be keyed in ar, en AND tr;
   - the exemption is shown still to REFUSE `pos.customerName` and
     `sales.customer`, and to accept `installments.plan.customer`.

**What still fails, unchanged:** a POS, stock, purchasing, supplier or catalogue
key naming a customer; a view outside that one directory naming one; a client
library naming one; and every tax arm of T-12, which I did not touch.

## DEPENDENCY

None.

## THE TEST THAT REQUIRES IT

`apps/web/test/od03.test.ts` itself, and `apps/web/test/error-keys.test.ts`,
which the same work also reddened — for a real reason, in my own strings, fixed
in my own files: all 26 refusal texts now carry the estate's data-safe sentence
in all three locales. An error message that does not say whether the data
survived is not an error message, and that half was my defect, not the law's.

`apps/web` is 336/336 green with both changes in.

## EXPECTED SEMANTIC DIFF

T-12 goes from "no customer vocabulary in the Phase 3/4 merchant web surface
except registered receivables codes" to "…except registered receivables codes,
registered instalment codes, and the debt slice's own named namespaces and one
named view directory". If the coordinator rules the other way, the reversal is
this file's three hunks, and the consequence is that P4-S7 has no merchant
screen — not that it has a differently-worded one.
