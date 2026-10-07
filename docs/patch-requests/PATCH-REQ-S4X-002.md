# PATCH-REQ-S4X-002 — P4-AL-68 names sixteen browser steps; the tree ships four, none of them named, and nothing reads the "16 × 9 = 144" arithmetic

- **Raised by:** `p4s4c/exit-criteria` (P4-S4 exit-criteria stream)
- **Target file:** `docs/PHASE_4_ARCHITECTURE_LOCK.md`, `P4-AL-68`
- **Status:** OPEN — documentary correction, owner's edit

---

## The disagreement, measured

`P4-AL-68` says, in the completed tense: "Sixteen new steps added to `flows.ts` and
exported as `PHASE4_STEPS`", and names them:

```
p4-pos, p4-pos-credit, p4-pos-keypad, p4-customers, p4-customer, p4-statement,
p4-invoices, p4-invoice, p4-collect, p4-return, p4-refund, p4-installments,
p4-installment-collect, p4-debts, p4-void, p4-states
```

The tree exports FOUR (`tests/browser/flows.ts:64`):

```ts
export const PHASE4_STEPS: readonly string[] = ['p4-pos-till', 'p4-pos-sale', 'p4-pos-discount', 'p4-pos-close'];
```

and declares exactly those four as `run.step` calls, at `tests/browser/flows.ts:619`, `:645`,
`:700` and `:770`. **None of the four is named by the sixteen**, and the sixteen are not a
superset with four filled in: for the POS screens S3 actually shipped, the lock names three
(`p4-pos`, `p4-pos-credit`, `p4-pos-keypad`) and the tree ships four with a different
decomposition (till / sale / discount / close).

## Which side is wrong: the declaration

**The tree is internally consistent and machine-checked.** `stepOwnershipProblems`
(`tests/browser/flows.ts:81-110`) enforces a bijection between the `run.step` names the file
declares and the union of `PHASE3_STEPS` and `PHASE4_STEPS`, plus the `p4-` prefix rule and
disjointness from Phase 3. `scripts/phase4-s1-gate.ts:1014-1033` re-asserts the prefix and
the disjointness over the exported lists. All of it is green, and
`tests/guards/phase4-browser-step-ownership.test.ts` carries the planted-defect proofs for
each way of breaking it. A step name the lists do not hold is already a red gate.

So the four shipped steps are owned, prefixed, disjoint and walked. Nothing about them is a
defect; what is wrong is the sentence that claims sixteen specific other names exist.

**And the sixteen are a Phase-4-WIDE end-state roster written in the completed tense.** Six
of them (`p4-collect`, `p4-return`, `p4-refund`, `p4-installments`,
`p4-installment-collect`, `p4-debts`, `p4-void`) name screens owned by S4, S5, S6 and S7
that do not exist yet. P4-S3 opened the list with the POS screens, which is what
`flows.ts:57-62` says it did. A list that describes the end of Phase 4 while asserting it is
already in `flows.ts` cannot be read against any intermediate tree.

## Second half: the arithmetic is read by nothing

`P4-AL-68` states "16 × 9 = 144 step-runs per gate run on top of the existing 135". **No
check in the tree computes it.** Grepping the whole tree for `144`, `16 * 9`,
`PHASE4_STEPS.length` and `ALL_BROWSER_STEPS` finds no arithmetic over the step count at
all — only unrelated money figures in the inventory settlement vectors. `ALL_BROWSER_STEPS`
is exported from `flows.ts:75` and is consumed only by `stepOwnershipProblems` in the same
file, for the bijection.

So the count is unfalsifiable as written: it would not change if the list held four, sixteen
or sixty.

## Required change

1. Restate the roster as the **Phase 4 end state**, with per-slice ownership, in a tense
   that does not claim the steps are already in `flows.ts`. The accepted idiom for this is
   the one `P4-AL-43` uses for the abuse scenarios: a table of step, screen and owning
   slice.
2. **Adopt the four shipped POS names** (`p4-pos-till`, `p4-pos-sale`, `p4-pos-discount`,
   `p4-pos-close`) in place of `p4-pos`, `p4-pos-credit`, `p4-pos-keypad`. The tree's
   decomposition is the one that exists and the one the ownership test enforces; the lock
   renaming them would make an accepted, green, machine-checked partition retroactively
   wrong.
3. Replace the fixed `16 × 9 = 144` with the **derived** arithmetic
   `PHASE4_STEPS.length × 9`, and say which check reads it — or drop the figure. A number
   nothing reads is a sentence in a document.

## Reason

`P4-AL-68`'s arithmetic "is read against the tree" per the slice's exit expectations, and it
cannot be: the multiplicand names four steps none of which the declaration knows, and the
product is computed by nothing. As written the law can neither pass nor fail, which is the
one verdict a law must not have.

## The test that requires it

`tests/browser/flows.ts:81-110` (`stepOwnershipProblems`) and
`tests/guards/phase4-browser-step-ownership.test.ts` are the tests that currently pass over
the four shipped steps, and `scripts/phase4-s1-gate.ts:1014-1033` is the gate arm. They are
what make the tree's side of this disagreement authoritative: they are green, they carry
their own red proofs, and they would turn red on any of the three defects the lock's prefix
rule exists to prevent.

After change (3), the derived arithmetic becomes checkable and
`tests/guards/phase4-browser-step-ownership.test.ts` is the natural home for the assertion
that the lock's stated product equals `PHASE4_STEPS.length × 9`. That file is not owned by
this stream's constraints and can carry it once the lock states a derived figure.

## Expected semantic diff

`P4-AL-68` stops asserting the existence of twelve step names that do not exist and three
that were decomposed differently, and starts naming the four that do plus the end-state
roster with owners. The step-run arithmetic becomes a derived figure a check can read rather
than a constant. No test changes behaviour; no step is added or removed; the prefix rule,
the disjointness rule and the bijection are untouched.

**No law is weakened.** Every obligation the sixteen represent survives as a per-slice
obligation with a named owner; what is removed is the false claim that they are already
shipped, which is what currently hides the twelve that are not.
