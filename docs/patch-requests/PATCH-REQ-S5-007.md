# PATCH-REQ-S5-007 — make `phase4RoutineBody` read EVERY definition, not the last by name

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target file | `scripts/phase4-s1-gate.ts:1181-1197` (`phase4RoutineBody`) and every caller that assumes one body per name |
| owner of target | `scripts/phase4-s*-gate.ts` is a shared permanent module. **Another agent is fixing exactly this right now** |
| depends on | nothing |
| blocks | nothing. It is a SOUNDNESS request about a hole, not a blocker |

## Status: possibly already in hand

The preparation page records that an agent is fixing this trap at the time of writing. **This
request exists so the obligation is written down from S5's side, with the consequence for S5's
own ruling stated, and it is withdrawn the moment the fix lands.** S5 has not touched
`scripts/phase4-s1-gate.ts` and does not propose to.

## Required change

`phase4RoutineBody` (`scripts/phase4-s1-gate.ts:1181-1197`) resolves a routine by NAME and
returns the **LAST** definition matching it, ignoring the signature. Change it — or add a
sibling — so a caller receives EVERY definition of the name, and make each caller judge all of
them.

## Reason

`invoice_outstanding` has two overloads and four definitions across `0081`/`0083`/`0084`.
Measured: the text the device returns begins
`CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])` — the `UUID[]`
set-based overload at `0084:593`. So two laws are affected, in opposite directions:

1. **seam `S-P4-03`** (`:1497-1518`) will stay **RED** if S5 teaches only the scalar overload
   (`0084:526`) to read `credit_note_applications` / `credit_notes`. The array overload must
   read them too — which `PATCH-REQ-S5-003` (d)+(e) already requires, so this half is handled
   whether or not the device is fixed;
2. **`TL-P4-S5-R1`** (`invoiceReducerProblems`, `:1304`) inspects only that ONE overload for
   `invoice_outstanding`. **A refund subtraction planted into the scalar overload alone would be
   MISSED.** That is the hole, and it is the hole in the law that is most specifically about
   S5's own ruling.

`TL-P4-S5-R1` is not a law S5 may leave with a known blind spot in its only enforcement device,
even a blind spot nobody has exploited. A guard that can be bypassed by choosing an overload is
a guard that is green for the wrong reason.

## Why S5 does not make the change itself

It is a change to a permanent shared module and therefore a Tech Lead item, not a silent edit —
and another agent holds it. S5's design is written on the assumption that every definition WILL
be read, and is correct either way: teaching both overloads satisfies both the current reader and
the fixed one.

## The test that requires it

The red proof this patch owes: plant a `FROM public.refunds` subtraction inside the SCALAR
`invoice_outstanding` overload only, and show that `invoiceReducerProblems` **misses it today**
and **catches it after the fix**. That is the proof that distinguishes the two devices, and
without it the fix is unverifiable.

`tests/guards/phase4-refund-not-a-reducer-guard.test.ts` already plants against the other three
refused ways of making the gate green (a comment, a dead SQL reference, a rename), in its
direction C. This is the fourth, and it is the one the current device cannot see.

## Expected semantic diff

- `invoiceReducerProblems`' subject set grows from one body per name to one per DEFINITION:
  at `6587460` the family is 7 names, of which `invoice_outstanding` alone contributes four
  bodies;
- `invoiceReducerProblems(root)` must still be `[]` at `6587460` — the fix must not turn the
  tree red, and if it does, what it found is a real finding and belongs in its own report;
- `deferredSeamProblems(root)` must still be `[]`.
