# PATCH-REQ-S6-013 — the tax REFUSAL is a runtime obligation, and an absent field is not one

| | |
|---|---|
| **raised by** | P4-S6 (allocation levels, reversals and voids), round 6 |
| **status** | OPEN |
| **file not this slice's to write** | the request validator that mounts the S6 shapes — `apps/api/src/modules/receivables` (schema layer), beside the existing S4 settlement schemas |
| **blocking** | nothing at level A–E. It blocks the mounting of any S6 route, and it must land in the same change that mounts one. |

## The ruling this serves

**OD-03 is CLOSED for Phase 4.** Sales tax is a STRUCTURAL ZERO: `tax_minor = 0`,
a command attempting a non-zero tax must **REFUSE**, and it may not be silently
normalised to zero, accepted-and-ignored, or turned into a tax journal line.

## The defect in my own slice that this corrects

`packages/shared-contracts/src/customer-reversal.ts` carried the sentence
"`OD-03` is OPEN" — stale, contradicting the ruling, and now corrected in place.

The second half is the one that matters, because it survives the comment fix.
That file argued the tax position was already safe, on the grounds that **no
request shape carries a tax field**. That argument is good for exactly one
layer and no further:

| layer | what the absence of the field settles |
|---|---|
| TypeScript, compile time | a caller inside this repository cannot name a tax field. SETTLED. |
| JSON, runtime | **nothing.** A body carrying `"taxMinor": "500"` has no declared home, so a non-strict validator strips it, the command proceeds, and the figure is gone without a refusal. |

That is **accept-then-ignore**, reached *through* the absence rather than in
spite of it, and it is one of the three outcomes the ruling names explicitly.

This slice's own law elsewhere is the same law, and is worth quoting against
itself: "a client that wanted to reverse part of a payment has nowhere to say
so — which is the whole-payment law expressed as an absence rather than as a
validation." The absence is sound for the AMOUNT because the figure is read
from the persisted original and a stray field changes nothing downstream. It is
NOT sound for tax, because the ruling demands an observable REFUSAL and a
refusal is a thing a validator does, not a thing a type fails to say.

## The edit requested

The validator that mounts any S6 request shape must **reject unknown keys** —
for zod, `.strict()` on every S6 object schema, not `.passthrough()` and not
the default strip — so that a body carrying any tax field is refused with a
named code before the command runs.

Two conditions on the edit:

1. **the refusal is named, not generic.** A bare 400 "unexpected property" is
   acceptable only if the catalogue entry distinguishes it; a request carrying
   tax should be answerable as such, because the merchant-facing truth is "this
   estate has no sales tax", not "you sent an unknown field";
2. **it is proved capable of going red.** The red proof is a request body
   carrying a non-zero tax field, asserted to be REFUSED, beside a counterpart
   body without it asserted to be ACCEPTED — otherwise a schema that refused
   everything would pass. `[[daftar-a-green-gate-must-prove-it-can-be-red]]`.

## What is NOT requested

No tax column, no tax field on any S6 shape, no tax journal line, and no
normalisation step. The structural zero stays structural; this asks only that
the boundary say NO out loud instead of saying nothing.

## Status of the claim while this is OPEN

S6's tax position is **SPECIFIED AND NOT ENFORCED**. It is recorded that way in
`docs/PHASE_4_S6_CONTRACT_PACK.md` and in the promotion kit, and it is not
counted as a proof.
