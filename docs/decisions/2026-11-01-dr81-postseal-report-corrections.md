# DR-81 — the post-seal reports carried false claims, and the debt register carried the same ones

**Decision: the external review's round-2 findings are accepted, and the
corrections are applied to the reports *and* to the tracked debt register.** The
review found internal contradictions and evidence attributed to a CI run that did
not contain it. **It found no defect in the code**, and no code file was changed.

## Why this is a tracked decision and not a documentation tidy-up

`TD-25` and `TD-26` in `TECHNICAL_DEBT.md` **carried the same false claims as the
reports**. A register that contradicts the reports built from it is worse than one
that is merely incomplete, because the register is what the next session reads.
So the corrections land in both, and the register is the authoritative copy.

## What was withdrawn, and the measurement behind each withdrawal

| Claim withdrawn | Why it is false | Measurement |
|---|---|---|
| "an overpayment produces a lawful negative outstanding figure" | the overpayment suite measures the opposite — the surplus becomes a **customer credit** and the invoice closes at **exactly zero, never negative** | `12-overpayment-customer-credit.golden.test.ts:386`, `:401` |
| "a zero transaction figure with a non-zero base" is an open case | malformed as written; superseded by the closure proof in **DR-82**, which also corrects the first attempt at withdrawing it | `0081:38`, `:777`, `:1330`; and see DR-82 |
| "fix by the remainder method" | prescribes a repair for a behaviour nobody has observed — and **DR-72 had already withdrawn the remainder method** | `docs/decisions/2026-10-30-dr72-closure-conservation.md` |
| "all of it ran in the decisive run" | false for one row: the FX closure suite **does not exist in the tree that run executed** — and **that tree is not `58d24469`** (corrected under DR-82-A, 2026-11-03) | the run's log reads `HEAD is now at 34d212d4 Merge 181e4081… into b4fc7b90…` ⇒ executed commit `34d212d4`. Suite ⇒ **HTTP 404** on `34d212d4` and on `181e4081`, control `package.json` ⇒ **HTTP 200** on both. Kept as a third reading: `git cat-file -e 58d24469:…fx-closure.test.ts` ⇒ **EXIT 128**; on `1aff66c6` ⇒ **EXIT 0**; control ⇒ **EXIT 0** |
| "this suite has never run in CI" | true only of the decisive run; it **has** run, and the step output names it | `✓ tests/integration/receivables-s4-fx-closure.test.ts (8 tests)` in run `41248454929`, lane `358` files / `6,626` tests |
| "109 s and 85 s show the sample loops completed" | a duration discriminates nothing here, and the log cannot supply the count | run `41213587774`'s own control steps `18:06:50Z → 18:08:39Z` and `18:08:39Z → 18:10:04Z` hold **64 lines** (identity: lines whose own leading timestamp falls in the window), **zero** with a sample count, against a positive control of such lines elsewhere in the same log. **The control's figure is probe-specific and is named with its probe, not carried bare** (DR-82-A): the regex `"iterations":\d+|iterations=\d+|samples?[:=]\d+` gives **44**, an earlier probe gave **45**, and **the zero is unaffected either way** |
| "no claim lost its gate" | the figures support only *"no item was deleted from the inventory"*; binding each claim to a gate **was never verified**, and no command or result for one exists | 428 → 429 claims, new 1, removed 0 |

## The rule this leaves behind

**A refutation must be measured in the same run as the claim it refutes.** The
first attempt at the duration withdrawal was measured in run `41248454929` while
the durations belonged to `41213587774` — the two runs' control steps take
**109 s / 85 s** and **104 s / 82 s** respectively. An independent review caught
it. This is the same family as the standing rule against carrying one branch's
result to another, and it now has a second instance.

## Cards

- **TD-25** and **TD-26** corrected in place rather than duplicated.
- **TD-28**'s remaining item closed by measurement.
- **TD-29** added — overpayment on a non-base-currency invoice is uncovered.
  **Money card: owner `daftar-finance`, double review required.**
- **TD-30** added — nothing keeps the FX suite in the CI lane; a roster guard with
  a negative control that must be shown to fire.

## What this decision does not claim

No PASS for Phase 4. No approval of any commit. The review signature on
`181e4081` remains **REQUEST_CHANGES with its blocker remedied by record**, and
does not transfer to any later commit.
