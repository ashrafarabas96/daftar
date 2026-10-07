# PATCH-REQ-S8-003 — G-14 and G-15 are not in the Phase 4 golden estate

| | |
|---|---|
| raised by | P4-S8 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target | `tests/golden-regression/phase4*` |
| owner | **P4-S4** (the declared owner of both goldens) |
| detector | `scripts/phase4-s8/golden-and-browser.ts` → `goldenCompletenessProblems` |
| check | `golden-completeness` (currently **FAIL**) |
| red proof | `tests/guards/p4s89-framework-laws.test.ts::golden completeness names a declared golden whose shipped owner left it unreferenced` |

## The finding, stated exactly

Measured: 10 golden files; **8 delivered, 10 waiting, 2 missing of 20**.

- **G-14** is owned by P4-S4, which has SHIPPED. No file under
  `tests/golden-regression/phase4*` references it. Its canonical id `GOLD-07` is
  referenced by `tests/golden-regression/phase1/01-identity-access.golden.test.ts`.
- **G-15** is owned by P4-S4, which has SHIPPED. No file under
  `tests/golden-regression/phase4*` references it. Its canonical ids
  `GOLD-68, GOLD-69, GOLD-70, GOLD-79, GOLD-80` are referenced by
  `tests/integration/p4s4-payment-closure.test.ts`.

Note what the finding does **not** say. It does not say the invariants are
untested; it says they are not in the estate `P4-AL-65` declares mandatory and
that `gate:phase4:s8` asserts complete. The checker distinguishes the two cases
and uses different words for each, because reporting "unproven" for an invariant
that has an integration assertion would be an over-claim, and reporting
"complete" would be the vacuous pass.

For G-15 specifically: a canonical id referenced only by an **integration**
suite is an invariant that is TESTED and not GOLDEN. A golden is a byte-stable
artefact a reviewer diffs; an integration assertion is a program. They answer
different questions and `P4-AL-65` asks for the first.

## Required change

Either:

1. P4-S4 adds the two goldens under `tests/golden-regression/phase4*`, each
   referencing its `G-nn` and its canonical ids and each with a resolved RED
   proof (`P4-AL-67`); or
2. the architecture lock records, for each of the two, that the invariant is
   satisfied by the named existing suite and that `G-14` / `G-15` are
   deliberately not golden — in which case `DECLARED_GOLDENS` must say so and
   the twenty becomes eighteen plus two named exemptions.

S8 does not get to pick, and in particular does not get to pick (2): the
cheaper of the two is the one that makes the gate green, which is exactly the
reason a gate owner may not choose it.

## Why S8 did not write the goldens

`tests/` suites belonging to S4 are on the forbidden list. A golden written by
the gate's own author, asserting what the gate asserts, is one claim recorded
twice.

## Expected semantic diff

| | before | after |
|---|---|---|
| `goldenCompleteness().missing` | `['G-14', 'G-15']` | `[]` |
| `golden-completeness` | FAIL | PASS |
| the "twenty goldens" claim | unreadable against the tree | readable |
