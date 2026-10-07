# PATCH-REQ-S6-009 — classify the nineteen S6 codes, and give each one a sentence in three locales

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Depends on `PATCH-REQ-S6-002`.

## Target files

- a status table in the S6 API module's own `*-errors.ts`, in the shape
  `apps/api/src/modules/receivables/receivables-errors.ts`' `RECEIVABLES_STATUS` uses —
  **S6's own file, once S6 has a module**;
- `apps/web/src/messages/ar.json`, `en.json`, `tr.json` — **three locale catalogues outside
  S6's ownership**, which is what makes this a request.

## Required change

For each of the nineteen `REVERSAL_CODES`
(`packages/inventory/src/customer-reversal.ts`):

1. one status-table row mapping it to its HTTP status — `404` for `*.not_found`, `409` for
   `*.already_reversed`, `*.idempotency_conflict`, `*.not_last_reducer`,
   `*.credit_consumed`, `*.state_invalid`, `*.reducers_not_reversed`,
   `*.direct_update_refused`; `422` for `*.reason_required`, `*.date_before_original`; `500`
   for `*.chain_inconsistent`, which is **ours** and not the merchant's;
2. one `error.payment_reversal.*` / `error.allocation_reversal.*` / `error.invoice_void.*`
   entry per code, in **all three** locales.

## Reason

A code in `InventoryErrorCode` that no status table classifies becomes a 500 reporting our
arithmetic as broken for plainly the merchant's input — the exact defect recorded, with its
cost, at `packages/inventory/src/customer-settlement.ts:113-120`. And the merchant never
reads a code: it renders from the catalogue, so a code with no entry resolves to the **safe
fallback** sentence. The fallback is the correct failure mode and not the finished one.

`apps/web/test/domain-code-fields.test.ts` derives its list from the refusal modules, so it
is the suite that notices a code with no catalogue entry.

## The one refusal that needs its own sentence, not a generic one

`*.not_last_reducer` is the **LIFO law** (`TL-P4-S6-R1`) and is the refusal a merchant will
meet most. It is a real usability wall by ruling — `OD-P4-04`'s option (a) was described as
"a real usability wall: a shop that allocated wrongly three payments ago must reverse three"
(`docs/PHASE_4_ARCHITECTURE_LOCK.md:1710-1711`) — so its sentence must tell the merchant
**which reversal to make first**, driven by the `reverseInThisOrder` list the refusal carries
(`NotLastReducerDetailsDto`, `packages/shared-contracts/src/customer-reversal.ts`). A
generic "this cannot be reversed" turns a lawful next step into a dead end.

The three sentences are a **localization** job and are written by whoever owns the
catalogues: this request states what each must convey, and guesses at none of the Arabic or
Turkish wording.

## Dependency

`PATCH-REQ-S6-002` (the codes must be `InventoryErrorCode` first), and an S6 API module,
which does not exist while S6 is at levels A–E.

## The test that requires it

`apps/web/test/domain-code-fields.test.ts` for the catalogue half; and, in S6's own module
once it exists, the `RECEIVABLES_PLAN_CODES_ARE_REGISTERED` device
(`receivables-errors.ts`) applied to `ReversalCode` — a **compile-time** binding of the
plan's codes to the status table, which "is strictly stronger than a test, because it cannot
go stale and cannot be skipped" (`customer-settlement.ts:124-127`).

## Expected semantic diff

Nineteen rows in one status table; nineteen keys in each of three JSON catalogues. No
existing key changes.
