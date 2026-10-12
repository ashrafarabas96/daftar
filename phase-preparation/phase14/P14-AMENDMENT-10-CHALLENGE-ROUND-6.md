# P14 AMENDMENT 10 — challenge round 6, answered

**Status: `PREPARED / NOT PROMOTED`. `READY_TO_PROMOTE = NO`. Unsigned.**

| Report | Head reviewed | Verdict | sha256 as received |
|---|---|---|---|
| `P14-CHALLENGE-2430504.md` | `2430504` | **PASS-WITH-SCOPE** | `eb7a0bd0…` (verified here against the figure the challenger stated) |
| `P14-CHALLENGE-2430504-ADDENDUM-01.md` | — | a **retraction** of `R5 P3-04` | `2b926233…` |

Both committed unedited. The answered head is not the reviewed head, so a
further round is owed.

## Run commands and exit codes

| Command | Result | Exit |
|---|---|---|
| `proofs/replay.sh` | `43 case(s) replayed, 0 not at their required exit code` | **0** |
| `proofs/replay.sh c7` after the full replay, and again | `36 case(s), 0 off` | **0**, **0** |
| `proofs/replay.sh nosuchfamily` | an empty replay is an error | **2** |
| `proofs/redproof-preflight.sh` | `5 arm(s), 0 not red` | **0** |
| `proofs/run.sh p14_resolver cases/c1a_restrict_column_refused.sql` on the dirty end-state | `CONTROL FAILED: p14_resolver cannot read the GRANTED columns …` — where it used to print `LAW HELD` | **3** |
| `proofs/run.sh p14_merchant cases/c7c_assertion_inoperable.sql` on the dirty end-state | `PREREQUISITE NOT MET …` | **3** |
| `tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md` | current | **0** |
| `tools/manifest-digests.py --check` / `--dir . --check` | every row matches, every file has a row | **0**, **0** |

## `P2-01` — the freeze boundary CONTRADICTS at `6fc505d`. Measured, then written.

The report is right and the sentence it corrects was **mine by adoption**:
round 5 remarked that a reader on `6fc505d` *cannot verify the freeze boundary*,
and `2430504` adopted that phrasing without reading the file. The boundary is
not a migration file, it is a **field**, in
`infrastructure/database/MIGRATION_MANIFEST.json`, which this pack names itself.
Read at both trees before anything was edited:

| tree | `frozenThrough` |
|---|---|
| `93084f8` | `0079_phase4_pos_till_sessions_cart.sql` |
| `6fc505d` | **`0073_default_warehouse_locale_name.sql`** |

So a reader on `6fc505d` verifies the boundary, gets `0073`, and concludes this
pack's freeze line is wrong by six migrations. That is **strictly worse than
unverifiable**, and it is §15's own thesis applied to a rule rather than a
citation. §15 now carries the table and says so.

**The lesson is the one §15 exists to teach, and this thread failed it in the
direction nobody was watching: I adopted a reviewer's characterisation of a fact
instead of measuring the fact.** A reviewer's sentence is a claim like any
other. It gets read against the world before it gets written into the pack.

## `P2-01`, second half — the generator's scope was narrower than its sentence.

`CITE` carried seven extensions and `json` was not among them, so
`MIGRATION_MANIFEST.json` — cited three times, a real repo file, and the **one
cited file whose difference between the trees changes a rule** — appeared in
zero rows while the block said *"35 cited files"*. Fixed: the extension set is
`ts, tsx, sql, yaml, yml, kt, js, json, sh, py`, and **the generated block now
prints the set it scanned**, so the claim cannot outrun the scan again.

This is not the hand-kept list returning. It is subtler and worth naming on its
own: **a generated figure is only as honest as the population the generator
admits**, and a narrow pattern under a wide sentence reads exactly like a
measurement. Widening it also exposed that typed copies of the figure had spread
to four documents, so those four no longer carry counts at all — they point at
the generated block. **A count copied out of its generator is a typed claim
wherever it lands.**

## `P3-02` — a right rule on a wrong law number, in generated prose.

The block credited `P14-GATE-034` with asserting the proposed files stay absent.
`GATE-034` is replay-after-purge, and **no gate in this pack makes that
assertion.** Round-2 `P1-01`'s species, and it would have regenerated
identically forever. The line now states what is structurally true instead: the
proposed files are absent at `93084f8` by the scan's own construction, an entry
that later *resolves* means the phase was built or the citation is wrong, and
`--check` turns that into drift — and **no gate asserts their absence, and none
is claimed to.**

## `P3-03` — `c1a` printed `LAW HELD` for the wrong reason.

The control that makes the law meaningful — that the same role *can* read the
columns it **was** granted, so the refusal is about the restricted column and
not about table access — ran **after** the arm had printed its verdict. Against
a database whose grants had moved on (`p14_resolver` holding eight columns that
exclude `name`), the refusal was `42501` for the wrong reason, the notice said
the law held, and the script then exited 3 on the control: **the exit code was
right and the log line was false.**

The control runs **first** now, and the `SQLSTATE` is **asserted** rather than
printed beside the word *expected* — a refusal with another code is `LAW
UNPROVED`, not a pass. Measured against the dirty end-state it exits **3** with
`CONTROL FAILED` naming the real cause. **A control that runs after the
conclusion cannot defend the conclusion.** The challenger swept the other five
pre-fix-state cases itself and found four refuse properly and two exit 0
legitimately; that sweep is its measurement, not mine, and is cited as the
challenger's.

## `P3-04` — two bucket misclassifications, fixed by measuring instead of matching.

The deleted orphan sat in the *files this phase proposes* bucket, and
`public-api.ts` was counted twice because a bare basename was not folded into
the path it names. Both were decided by a **name pattern**, which is the
hand-kept list at one remove. They are decided by resolution now: a token that
resolves to a real file **inside the pack** is the pack's own; a token git knows
under the pack but that no longer exists is one this pack **deleted**; a
basename is folded into the longer token that ends with it. Widening the
extensions proved the point immediately — the pack's own driver and tools landed
in *proposed files* until the bucket stopped being a pattern.

## `R5 P3-04` is WITHDRAWN by its author, and the change it caused is REVERTED.

The reviewer reported `locale-gen` *"is not present in this container"*; both
`proofs/README.md` and `P14-EVIDENCE-2026-10-12.md` were changed on that word.
Its addendum retracts it: `locale-gen` is at `/usr/sbin/locale-gen`, it runs,
and it generates `en_US.utf8`. The step is restored to the command actually
executed, with `localedef` documented as the correct alternative, and the
withdrawal is **recorded** with a pointer to the addendum rather than silently
undone — a reader of the earlier revision needs to know which command was ever
in doubt, and the answer is neither.

**This thread's own re-diagnosis was wrong in the same way, and that is the part
worth keeping.** Having measured that the binary lives in `/usr/sbin`, it wrote
*"the binary is present, the path is not"* — and never ran `command -v
locale-gen` as the unprivileged account, which prints `/usr/sbin/locale-gen`.
The reviewer asserted an absence it had not executed; this thread asserted a
`PATH` consequence it had not executed. **A measurement of one fact does not
license an inference about the next**, and the correction is reverted rather
than rescued by a second unmeasured claim.

## On "no finding against the architecture", six rounds in

The challenger's own addendum accepts the framing this thread offered, and it
should stand in the pack rather than only in a message: **the architecture is
not vindicated, it is unexecuted.** There is no API, no DDL, no route and no CI
in Phase 14. The harness is the only part of this phase that exists as running
code, which is precisely why every defect in six rounds has been found in a
document, a citation, or the harness. Six rounds of document review are not a
substitute for one execution.

## Unchanged

`OD-P14-09`, `OD-P14-10`, `OD-P14-11` are the owner's. `TL-P14-SEC-01`, `-02`
and `-03` sit with their owners; §7a's five options and §11a's ruling are the
Security and Migration Owners'. **No migration number is written, reserved or
exampled anywhere in this pack**, and Phase 14 may not be given one before
Phase 13 seals.
