# PHASE 14 — INDEPENDENT CHALLENGE, ROUND 4 AT `fcb85f8`

**Challenger:** a session that wrote no part of the Phase 14 pack.
**Target:** `claude/project-thread-1zqgj8` @ `fcb85f8`, delta `6f744c1..fcb85f8`
(one commit, *"phase14: the base-tree trap is the root cause of the cashier
finding, not a footnote"*, 7 files, +122/-26, documents only).
**Declared base of the pack:** `93084f8`. **Container tree:** `6fc505d`.
**Date:** 2026-10-12.

## VERDICT — PASS-WITH-SCOPE

The delta is a good commit. It re-diagnoses a finding **against its own author's
interest**, replaces a wrong cause with the right one, declines both available
remediations and says why in full rather than silently, and converts the
disclosure into a gate obligation. I re-measured every factual claim it makes
and all the load-bearing ones reproduce exactly.

It is not a plain PASS because the one *new measurement* the commit introduces —
the heart of new §15 — is **wrong in the same way the defect it documents was
wrong**: it enumerates its sources by a hand-picked list instead of by scanning,
so it undercounts. **Eleven cited files differ between the two trees, not six**,
and the stated remediation ("every live-code citation in this pack names the
tree it was verified in") is not implemented for the large majority of
citations. No citation is *incorrect* at the declared base — I checked every one
of the omitted files' cited lines — so the exposure is to a future reader, not
to the design.

Round 3's two open items (`P2-01` replay rc=127, `P2-02` the C7 isolation
collapse) are **untouched by this delta** and remain open; they were delivered
after this commit was cut.

## 1. Run identity

| | |
|---|---|
| Head reviewed | `fcb85f8` (fetched, `git merge-base --is-ancestor 93084f8 fcb85f8` **fails**, as §15 states by design) |
| Worktrees used | `fcb85f8` and `93084f8` and `6fc505d`, read-only; nothing pushed, no branch of the author's touched |
| Manifest digests | **17 of 17 byte-exact** (recomputed with `sha256sum`), including the five rows the delta updates and both challenge reports, which remain **unedited by the author** |
| Nothing written | no file under `phase-preparation/phase14/` modified by this session |

## 2. What the delta claims, and what I measured

| Claim in the delta | Measured | Result |
|---|---|---|
| `6fc505d` is `93084f8`'s ancestor | `git merge-base --is-ancestor` | **TRUE** |
| the declared base is not in the head's history | `--is-ancestor 93084f8 fcb85f8` exits non-zero | **TRUE** |
| `93084f8` carries **327 files / 133,615 insertions** of Phase 4 | `git diff --shortstat 6fc505d 93084f8` → `327 files changed, 133615 insertions(+), 931 deletions(-)` | **EXACT** |
| at `6fc505d`, `:149` **is** `cashier: ['catalog.view']` | `git show 6fc505d:…/permissions.ts \| sed -n 149p` | **EXACT** |
| at `6fc505d`, `:144` **is** `'inventory.view'` in the manager block | same, line 144 | **EXACT** |
| `permissions.ts` differs by **66 lines** | `--numstat` → `+66/-1` | **EXACT** |
| the round-1 diagnosis (Phase 1 set read as current) was **wrong** | the comment at `:206` exists, but the cited lines are literal matches at `6fc505d` | **CORRECT — and against the author's own prior position** |
| the designated-branch rule is **no answer** to this finding | it constrains the branch name, not the commit it is cut from | **CORRECT.** My round-2 refusal of that answer is upheld by the author, properly |
| `GATE-032` extended to assert citations against an explicit `93084f8` worktree | present and **identical in both** `P14-AMENDMENT-05` and `P14-TASK-DAG` | **CONSISTENT** |

The six rows of §15's own table reproduce to the line: `database.ts` +190/-15,
`permissions.ts` +66/-1, `customers.controller.ts` +113/-0,
`inventory-authorization.ts` +117/-1, `pos-permissions.ts` +138/-0,
`pos-cart-routes.ts` +212/-0; `publisher.ts` and
`inventory-reads.controller.ts` identical.

## 3. Findings

### P2-01 — §15's TABLE UNDERCOUNTS THE TRAP BY THE SAME MECHANISM THE TRAP IS MADE OF

§15 and the manifest both say *"**six of the fourteen cited files** differ between
the two trees, not one"*, and §15's table enumerates fourteen rows.

I scanned the pack for every file citation instead of reading the table, and
resolved each against both trees. **Eleven cited files differ.** The five the
table omits:

| Omitted cited file | `6fc505d` vs `93084f8` | Cited at |
|---|---|---|
| `apps/api/src/common/error.filter.ts` | **DIFFERS** (+59/-0), present in both | `P14-S0:488` → `error.filter.ts:41-47` |
| `apps/api/src/modules/receivables/receivables.controller.ts` | **DIFFERS** (+123/-0), **absent at `6fc505d`** | `P14-S0:91,215,254,272`, `P14-OPEN-DECISIONS-AR:68,115` — six citations |
| `apps/api/src/modules/pos/till-sessions.controller.ts` | **DIFFERS** (+163/-0), **absent at `6fc505d`** | `P14-MIGRATION-PATCH-REQUEST:1001` → `:89` |
| `packages/shared-contracts/src/invoices.ts` | **DIFFERS** (+216/-0), **absent at `6fc505d`** | `P14-AMENDMENT-01:75,95` → `:37-41`, `:160` |
| `scripts/static-guards.ts` | **DIFFERS** (+106/-9), present in both | `P14-S0:488` |

Also outside the fourteen, and **identical**, so not exposed but not counted
either: `redis.ts`, `credential-protector.ts`, `guards.ts`, `tenancy.service.ts`,
`capabilities.ts`, `tokens.ts`, and five further frozen migrations (`0002`,
`0003`, `0025`, `0054`, and see `P3-03`). The cited-file population is at least
**nineteen existing files**, not fourteen.

**Why this is the same defect and not a nitpick.** `P14-GATE-033` was restated
in round 1 precisely because *"a gate that enumerates its sources by name is
blind to the next section added"*. §15's table enumerates its sources by name.
The `GATE-032` extension inherits the undercount verbatim in two documents, so
the gate that is supposed to close the trap will be written against a population
that is missing five files — four of which **do not exist at `6fc505d` at all**,
which is the loudest form of the same trap.

**What is NOT wrong:** I read every cited line of all five omitted files at
`93084f8`. Every one resolves and says what the pack says it says —
`till-sessions.controller.ts:89` is `@RequiresPermission('sales.create')`,
`error.filter.ts:41-47` is the `AccountingError` block (at `6fc505d` those same
lines are the `ZodError` block, a coherent reading of the wrong world, exactly as
§15 warns). **The defect is in the enumeration, not in any citation.** That is
why this is a P2 and not a P1.

### P2-02 — THE STATED REMEDIATION IS PRINTED AS DONE AND IS NOT DONE

§15's fix is two parts. The gate obligation is real and is written. The other
part is:

> *"every live-code citation in this pack names the tree it was verified in"*

Measured: the four principal documents carry **56** `file.ts:line` citations of
live code, and the whole pack mentions `93084f8` **~70 times in prose**, of which
19 are in the patch request. `permissions.ts` alone is cited **31 times** and
`publisher.ts` **15**; the overwhelming majority of individual citations carry no
tree. Spot-check: `receivables.controller.ts:43-45` appears three times with no
tree named; `invoices.ts:37-41` names none.

The sentence is a description of a per-citation provenance discipline that does
not exist in the file. A reader who trusts it will check a citation against
whatever tree they have — the exact failure §15 was written to prevent. Either
implement it (an inline tree marker, or one sentence per document rather than
one per pack) or restate the claim to what the pack actually does: **a single
declared base, disclosed in §15 and the manifest.**

### P3-03 — "EVERY CITED FROZEN MIGRATION IS BYTE-IDENTICAL AT BOTH TREES" IS FALSE AS PRINTED

§15 and the manifest both carry that sentence, and it licenses the conclusion
that *"no RLS, grant or policy citation is exposed to this trap"*.

`0079_phase4_pos_till_sessions_cart.sql` is cited four times (as
`frozenThrough`) and **does not exist at `6fc505d`**. Ten of the eleven cited
migrations are byte-identical; the eleventh is absent.

The **conclusion survives** — `0079` is cited only as the freeze boundary, never
for RLS, grant or policy content, and all ten migrations carrying those are
identical — so this is a P3. But it is a measurement printed as universal that a
reader can falsify in one command, and it has a second consequence worth a line:
**a reader on `6fc505d` cannot verify the `frozenThrough = 0079` boundary at
all**, because the file is not there.

### P3-04 — A BARE BASENAME CITATION RESOLVES TO THREE FILES, TWO OF WHICH DIFFER

`errors.ts` is cited three times without a path. At `93084f8` it resolves to
`packages/accounting/src/errors.ts` (**differs**, +13/-1),
`packages/inventory/src/errors.ts` (**differs**, +44/-1) and
`packages/domain-core/src/errors.ts` (identical). The reader cannot tell which,
and two of the three candidates are inside the trap. `tokens.ts` has the same
shape (two candidates, both identical, so harmless). Cheap fix: cite paths, not
basenames — which is also what makes `P2-01`'s scan mechanisable.

## 4. What held, and should not be reopened

- **All 17 manifest digests** byte-exact at `fcb85f8`; both challenge reports
  hashed as received and unedited.
- **The re-diagnosis itself.** The author discarded his own accepted account of
  a finding when measurement contradicted it, and recorded that the challenger's
  round-2 refusal of his first answer was correct. Both original cashier
  citations are literal matches at `6fc505d`. This is the right behaviour and
  the lesson in §15 — *a citation verified against the wrong tree is a coherent
  reading of the wrong world, not a typo* — is correct and general.
- **Both remediations correctly declined.** Re-cutting the branch from `93084f8`
  would pull 327 files / 133,615 insertions of Phase 4's unmerged, unsigned work
  (PR #6, `S7 C1` open) into a docs-only branch: I verified the figures and
  agree with the refusal. History rewriting is forbidden outright by the owner
  directive and is correctly not proposed.
- **The escalation survives the re-diagnosis.** At `93084f8` the cashier holds
  five permissions and not `inventory.view`, so mapping `GET /stock` to
  `catalog.view` was a real privilege escalation and `P14-AL-39` /
  `P14-GATE-032` stand. Re-measured.
- The architecture is untouched by this delta and remains sound. **Across four
  rounds, no finding has landed against the pack's design** — every defect has
  been in a document, a citation, or the harness.

## 5. Required for a plain PASS

1. **`P2-01`** — regenerate §15's table by *scanning* the pack for file
   citations rather than from a list, and correct the count in §15, the manifest
   row, `P14-AMENDMENT-05` and `P14-TASK-DAG` (the `GATE-032` text repeats the
   wrong number in two places). Make `GATE-032` do the scanning too.
2. **`P2-02`** — either implement per-citation provenance or restate the claim
   to what the pack does.
3. **`P3-03`** — correct the "every cited frozen migration is byte-identical"
   sentence to name `0079`'s absence, keeping the conclusion.
4. **`P3-04`** — cite paths for `errors.ts`.
5. **Round 3 remains open:** `P2-01` (the committed replay recipe exits 127 on
   all four red proofs; `P14_CASE_ALIAS` is never set) and `P2-02` (the whole C7
   family, i.e. all of `TL-P14-SEC-02`'s evidence, exits 3 in isolation because
   `c7_setup.sql:16` alters a table `c3_setup.sql` creates). See
   `P14-CHALLENGE-6f744c1.md`.

*This report does not sign the pack. `PREPARED / NOT PROMOTED`.*
