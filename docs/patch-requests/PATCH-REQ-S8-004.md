# PATCH-REQ-S8-004 — four shipped browser steps that `P4-AL-68` does not name

| | |
|---|---|
| raised by | P4-S8 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target | `docs/PHASE_4_ARCHITECTURE_LOCK.md` (`P4-AL-68`) and/or `tests/browser/flows.ts` |
| owner | the architecture-lock owner (the coordinator) |
| detector | `scripts/phase4-s8/golden-and-browser.ts` → `browserMatrixProblems` |
| check | `browser-matrix` (currently **FAIL**) |
| red proof | `tests/guards/p4s89-framework-laws.test.ts::the browser matrix refuses a PHASE4_STEPS entry that collides with a Phase 3 step` |

## The finding

`tests/browser/flows.ts` registers four `p4-` prefixed steps — `p4-pos-till`,
`p4-pos-sale`, `p4-pos-discount`, `p4-pos-close` — and **none of them is named
by `P4-AL-68`'s declared sixteen**. So the completeness claim "sixteen steps ×
three locales × three viewports = 144" cannot be read against the tree at all:
the sixteen are not these four, and these four are described by no document.

This is a NAMING DIVERGENCE, not a missing step. The steps exist and run. What
does not exist is the correspondence between what ships and what the contract
names, and a matrix whose completeness is asserted against a list that does not
intersect the tree is asserting nothing.

## Required change

Either:

1. `P4-AL-68`'s sixteen are renamed to the shipped names (or the four shipped
   steps are added, making it twenty), or
2. the four shipped steps are renamed to the declared ones.

Whichever way, the two lists must intersect, and the matrix size reported must
be computed from the **registered** steps and not from the declared ones.
`browserMatrix` already reports `stepRuns` from the registered set for exactly
this reason: reporting the target as the measurement is how a matrix comes to be
believed complete.

## A constraint on any change to the step lists

`P4-AL-63`: `PHASE3_STEPS` and `PHASE4_STEPS` are **DISJOINT**.
`flows.ts:275` already has `run.step('return', …)` — the SUPPLIER return, one of
the fifteen Phase 3 steps — and `tests/browser/gate.ts` filters `--steps` as a
plain name list with step records keyed by name, so a second `return` would be
run by `--steps=<PHASE3_STEPS>` and would reintroduce the exact coupling
`P4-AL-63` exists to remove. The red proof above plants that collision and
requires the refusal.

## A second constraint

Phase 4 keeps exactly **three** locales and **three** viewports. Adding either
turns the accepted Phase 3 corrective gate red, because it asserts EQUALITY
between its matrix and `tests/browser/config.ts`.

## Expected semantic diff

| | before | after |
|---|---|---|
| `browserMatrix().registeredButUndeclared` | 4 steps | `[]` |
| `browser-matrix` | FAIL | PASS |
| the "16 × 9 = 144" claim | unreadable against the tree | readable, and computed from what is registered |
