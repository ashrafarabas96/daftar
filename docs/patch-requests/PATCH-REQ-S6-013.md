# PATCH-REQ-S6-013 — a refusal is a validator's act, not a type's silence

| | |
|---|---|
| **raised by** | P4-S6 (allocation levels, reversals and voids), round 6 |
| **status** | **BLOCKED** — on the slice that first ships a customer-reversal / credit-note route. **Not `OPEN` on S6, and not a defect in the live tree.** |
| **ruled by** | the coordinator, 2026-10-07. The reasoning below is ACCEPTED and the first line is adopted as a project law. The enforcement question is the coordinator's and is ruled here; it is **not** an OD-03 question and is **not** to be put to the owner. |
| **blocks** | nothing at levels A–E, and nothing in the candidate. It blocks the mounting of any S6 route and must land in the same change that mounts one. |

---

## 1. THE LAW

> **A refusal is a validator's act, not a type's silence.**

A TypeScript union or interface settles what an author can **NAME** at a call site. It settles
nothing whatever about a JSON body. "No shape carries a tax field" is an argument about the
former offered as a guarantee about the latter.

| layer | what an absent field settles |
|---|---|
| TypeScript, compile time | a caller inside this repository cannot name the field. **Settled.** |
| JSON, runtime | **nothing.** `"taxMinor": "500"` meets a non-strict validator, is stripped, and the command proceeds with no refusal. |

That is **accept-then-ignore** — one of the three outcomes OD-03's closure forbids — and it
arrives **THROUGH the absence** rather than through a line of code, which is what makes it hard
to see. There is no wrong statement to find in review; there is only a missing one.

---

## 2. THE DEFECT IN MY OWN SLICE'S REASONING, WHICH IS WHAT THIS RECORDS

`packages/shared-contracts/src/customer-reversal.ts` carried the sentence "`OD-03` is OPEN" —
stale, contradicting the closure, and corrected in place. **OD-03 is CLOSED**: tax is a
structural zero, `tax_minor = 0`, and a command attempting a non-zero tax must REFUSE.

The half that survives the comment fix is the real finding: that same header argued the tax
position was already safe **because no request shape carries a tax field**, which is the §1
error exactly.

**And the slice's neighbouring argument is sound, which is why the error was invisible.** The
same file argues that no request carries an **amount**, so a partial reversal "has nowhere to be
said" — the whole-payment law as an absence rather than a validation. That is correct, because
the figure is read from the persisted original and a stray amount field changes nothing
downstream. For **tax** it is not correct, because the closure demands an observable REFUSAL. The
two arguments read alike and are not alike, and the sound one lent its credibility to the unsound
one.

---

## 3. THE HAZARD IS REAL AND **PROSPECTIVE** — NOT A LIVE DEFECT

Ruled by the coordinator and **independently re-verified here by grep against the main checkout
at `54a851c`**, because a report is not evidence:

| fact | check |
|---|---|
| `packages/shared-contracts/src/customer-reversal.ts` exists **only in the S6 worktree** | `ls` in the main checkout: no such file |
| there is **no `apps/api/src/modules/returns/`** | `ls apps/api/src/modules/` lists 16 modules; `returns` is not among them |
| there is **no live customer-reversal or credit-note route** | S6 mounts nothing; §5 of the contract pack is level D, declared and not mounted |
| **no evidence of a non-strict request schema in the live tree** | all **12** `*.schemas.ts` under `apps/api/src` have `.strict()` occurrences **≥** `.object(` occurrences |

**Therefore: there is no reachable path for this hazard today.** It must NOT be recorded as a
defect in the live tree and must NOT be counted against this candidate. It is `BLOCKED` on the
slice that creates the route.

### 3.1 A CAUTION ON THE EVIDENCE OF ABSENCE — THE COUNT IS A SCREEN, NOT A PER-SCHEMA PROOF

The `.strict() ≥ .object(` comparison finds **no counterexample**, and that is worth having. It
is **not** a proof that every schema is strict, and the implementer must not treat it as one.
Two reasons, both measured:

1. **the aggregate does not pair.** A file showing `object=15, strict=19` proves nothing about
   whether those nineteen attach to those fifteen. Counts cannot express a pairing;
2. **my two structural probes DISAGREE with each other, because both are formatting-sensitive.**
   A line-based `grep` for `}).strict()` found 0 in `receivables.schemas.ts`; a multiline pattern
   allowing `})` and `.strict()` on separate lines found **3 of 3** — the house convention is
   `.object({…})\n  .strict()`, which the line-based probe cannot see. Run across all twelve, the
   multiline pattern accounts for 66 of 98 `.object(` sites; the residue is dominated by **nested**
   object schemas at deeper indentation and by `pos-cart.schemas.ts`'s inline form, which the
   multiline pattern misses for the opposite reason.

**Neither number is a finding, and I report no gap.** What they establish is the methodological
point: a cheap grep cannot settle per-schema strictness in this tree, which is precisely why §4
demands a check that parses or a red proof per schema, and why **a proof asked only where it
already passes is not the proof.**

Note also that **nesting matters**: a non-strict nested object strips unknown keys inside a nested
body just as a non-strict top-level one does. The live set is every object in a request body
schema, not only the outermost.

---

## 4. THE EDIT REQUESTED, IN THE STRONG FORM THE RULING SETS

**Not a per-route patch.** The law is stated over the **LIVE SET**:

> **Every Phase 4 request body schema refuses unknown keys.**

With the red proof that makes it non-vacuous:

> **Removing the refusal from ANY ONE member of the set must redden the check** — not a proof
> asked only where it already passes. `[[daftar-a-green-gate-must-prove-it-can-be-red]]`.

The set is derived from the tree, never from a hand-maintained list: a list of twelve files is a
list that is eleven files the day someone adds a module. And the check must **parse** rather than
grep, for the reason §3.1 measures.

### 4.1 TWO MECHANISMS, AND THEY ARE NOT ALTERNATIVES

| mechanism | what it gives | what it does not give |
|---|---|---|
| **set-wide strictness** (`.strict()`) | it converts accept-then-ignore into a **refusal**, and therefore **already satisfies the owner's "must REFUSE"** | a bare unrecognised-key error — a poor merchant outcome for a field as specific as tax |
| **a NAMED domain refusal** for the tax case | the message for the field we **did** think of | nothing for the field nobody thought of |

**Set-wide strictness is the FLOOR that catches the field nobody thought of; the named refusal is
the MESSAGE for the field we did.** Neither substitutes for the other. A slice that ships only
the named refusal leaves every other unknown key stripped; a slice that ships only strictness
answers a tax attempt with "unrecognised key `taxMinor`", which tells a merchant nothing about
why this estate has no sales tax.

### 4.2 THE REACHABILITY OBLIGATION ON THE NAMED REFUSAL

When the named tax refusal is registered, **assert that something REACHES it.**

The precedent is live and in a neighbouring module. `customer.aging_buckets_invalid` is declared
in a status registry at **`apps/api/src/modules/selling/selling-errors.ts:67`** and is **thrown
nowhere in the tree** — the identifier occurs exactly twice in the whole repository, both in that
one file, the second being the docstring that now says it is *not* the code in question. A
docstring had cited it as the check that justified a 500.

That is the mirror image of this request's own finding, and both are the same mistake in opposite
directions:

| | the declaration | the enforcement |
|---|---|---|
| `aging_buckets_invalid` | present | **absent** — a declared code nothing throws |
| the tax field | **absent** (no shape names it) | absent — and the absence was read as the enforcement |

A declared code nothing throws is the dead config member the owner forbade, and a comment citing
a check that does not exist is how a false belief ships. So the red proof must drive the code from
**a request**, not from the registry.

---

## 5. WHAT IS NOT REQUESTED

No tax column, no tax field on any S6 shape, no tax journal line, and **no normalisation step**.
The structural zero stays structural. This asks only that the boundary say **NO out loud** instead
of saying nothing.

---

## 6. THE STATUS OF THE CLAIM WHILE THIS IS BLOCKED

**S6's tax position is SPECIFIED AND NOT ENFORCED.** It is recorded that way in
`docs/PHASE_4_S6_CONTRACT_PACK.md` §14 and in the promotion kit, and it is **counted as no proof
anywhere** — not as "specified and therefore safe", which is the error this request exists to
name.
