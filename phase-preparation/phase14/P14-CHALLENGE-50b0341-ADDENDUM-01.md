# P14-CHALLENGE-50b0341 — ADDENDUM 01
## A narrow check of **R10-P2-01 only**, at `f7fe056`

**This is not a new tooling round.** It is the re-test of the one blocking
finding from round 10, plus the three attacks the coordinator asked for and the
author's own disclosed residual. Everything else at this head is unexamined, and
nothing here signs it.

| | |
|---|---|
| Head | `f7fe056` — `7aba4cd` *the rule I wrote was wider than the rule I enforced*, then `f7fe056` *prefer the cause over the summary, and name what I cannot explain* (9 files, +496/−42) |
| Verified first | **36/36** manifest rows in the pack **and** in `/mnt/project-files/phase14`; my round-10 report committed byte-identical (`e89fcb1c90eaaed8…` in both) |
| Measured on | PostgreSQL **16.15** @ `en_US.utf8`, four roles `NOSUPERUSER NOBYPASSRLS`, cluster rebuilt for this check |
| Author files edited | **none** · Pushed | **nothing** |
| **R10-P2-01** | **CLOSED** |

---

## 1 — R10-P2-01 IS CLOSED

The remedy is the one I proposed: a reviewer's row is held to the copy in the
other directory **and** to every revision of the manifest, and with neither
witness nothing may be signed.

**My round-10 two-step no longer works.** In a repository holding two
independent copies (`--dir /tmp/tw/packA --witness /tmp/tw/packB`), against my
own round-10 report:

```
append a retracted sentence → --write → 1  REVIEWER COPIES DIFFER: … hashes 166af14044fc under packA
                                           but e89fcb1c90ea under packB
set both cells to UNSIGNED, COMMIT it → --write → 1  (same refusal)   --check → 1
```

The commit that defeated the previous fix now changes nothing.

**(a) Both directories edited identically — still witnessed.** With `packA` and
`packB` byte-identical and both tampered, the first witness is satisfied and the
second refuses:

```
--write → 1   P14-CHALLENGE-50b0341.md: a signed reviewer row does not move. Some revision of this
              manifest recorded e89fcb1c90ea for it and the file under /tmp/tw/packA now hashes
              166af14044fc — a committed placeholder does not erase that.
```

**(b) Rewritten history with the counterpart absent — it refuses, it does not
pass.** Two worlds, both measured:

| world | result |
|---|---|
| a plain copy, no repository, counterpart directory absent | `--check` **1**, `NO WITNESS for … it has no digest in any revision of this manifest and no counterpart under …` |
| a repository whose **only** revision carries the row as `UNSIGNED`, counterpart absent | `--write` **1**, `NO WITNESS …` |

**(c) Hollowing one of the four new proofs fails it by name.** I replaced
`reviewer-row-no-repo`'s counterpart directory with the empty one, so a
sibling's refusal would answer:

```
FAIL  reviewer-row-no-repo  rc=1 (required 1), and the message was not REVIEWER COPIES DIFFER: …
ok    reviewer-row-no-witness  rc=1, refused with NO WITNESS
```

Each of the four is required by its own sentence, and the unmodified sweep is
`rc 0` (`--no-db`, 21 `ok` lines) from a clone with the pack under `/tmp`.

### R10-ADD-01 · named residual · the enumeration is missing one cell, and in that cell the tool signs

Amendment 14's own witness table says of the other directory: *"forging
requires changing both copies in step"* — so the limit is disclosed, and this is
not a false claim. What the four-route table does not list is the combination of
both its caveats: **no repository and a counterpart that agrees because it was
changed in step.** Measured, with two directories I control and no git history:

```
both copies tampered identically, row set to UNSIGNED in both cells
  reviewer-row history NOT CHECKED (the manifest is not in a git repository here)
  --write → 0        --check → 0        row now 166af14044fc = the tampered file
```

That is the handoff-archive shape: an archive carries no history, so **two
copies written by the same hand are one witness**. The refusal behaves exactly
as the narrowed rule says — one witness, agreeing, so it signs — which is why
this is a residual and not a block. Worth adding as a fifth row of the table,
with the honest sentence beside it: *outside a repository, the two directories
are one witness, and a reviewer's digest rests on the archive being published
with its history or with the reviewer's own recorded digest.*

---

## 2 — R10-RESIDUAL-AUTHOR-01: **contention, not residue**, and provably so

The author reports `replay` and `redproof-preflight` twice answering 1 from all
four directories with *"the MUTATION did not apply"* on the collation arm, while
exiting 0 standalone, and does not claim a cause. **Reproduced on the first
attempt**, and the discriminating evidence is clean:

| experiment | result |
|---|---|
| **8 runs back to back**, as `gate()` runs it four times | **8 × rc 0** — no failure, no drift |
| a `replay.sh` concurrent with a `redproof-preflight.sh` | both **0** — different objects, no collision |
| **two `redproof-preflight.sh` concurrently** | one **0**, the other **1**: `FAIL collation the MUTATION did not apply` — and again on a second attempt, with the winner and loser swapped |
| the **residue** case planted deliberately (`p14wrongcoll` left behind, one run) | **rc 0** — the precondition teardown from `R8-P3-05` already clears it |

So residue is not the cause: it is the one explanation that is already fixed.
The loser's own output names the wrong one —

```
psql said: ERROR:  duplicate key value violates unique constraint "pg_database_datname_index"
CAUSE: an earlier interrupted run of THIS script left its object behind.
Clear it and re-run: … DROP DATABASE IF EXISTS p14wrongcoll …
```

— when there was no earlier run, nothing is left behind (the cluster holds only
`p14scratch` afterwards), and the suggested command would find nothing to drop.
The loser also showed a second symptom the author did not report:
`FAIL encoding preflight exit=2 … (2 = psql could not connect)`, because the
winner's teardown dropped the database the loser was about to preflight.

**The error itself is the discriminator.** Residue produces
`database "p14wrongcoll" already exists` (42P04); a genuine concurrent `CREATE
DATABASE` produces the raw `duplicate key value violates unique constraint
"pg_database_datname_index"`, which residue cannot. The CAUSE branch keys on
`*"already exists"*` and catches both.

**Grade: it stays a residual, and it hides no fail-open.** The loser exits 1 and
says nothing was proved; an arm still requires its own sentence, so a connect
failure cannot be mistaken for a red. Remedy, in two parts:

- **Name the arm's objects per run** — `p14wrongcoll_$$`, `p14wrongenc_$$` — so
  two runs cannot collide over a database at all.
- **For the role-mutating arms, which cannot be renamed**, take
  `pg_try_advisory_lock` at the top of the script and refuse with *"another
  red-proof run holds the lock"*, because two runs flipping `BYPASSRLS` on the
  same role would otherwise produce a red for the other run's mutation.
- And split the CAUSE branch on the two errors above, so the script stops
  pointing at residue when the cause is a sibling run.

This is the fourth instance of one pattern, and it is the right thing to carry
out of the tooling rounds: **R8-P3-05, R9-P3-01, R10-P3-01 and this one are all
a fail-closed refusal naming a cause that is measurably not the cause.** The
verdicts have been sound every time; the diagnoses have not.

---

## 3 — SCOPE

**Signed here, and only this:** R10-P2-01 is closed at `f7fe056`; 36/36 rows in
both directories; my round-10 report committed unedited; the four new refusals
each proved by its own sentence, one of them verified by hollowing its world;
`gate-sweep.sh --no-db` **0** from `/tmp/pr/phase-preparation/phase14`.

**Not signed:** anything else at this head — this was a narrow check, not a
round; the fifth table cell (**R10-ADD-01**); the four diagnosis residuals
above; the version arm; concurrency and performance of the phase itself.

And unchanged, for the record: the architecture is still unexecuted, so none of
these ten rounds is credit against the first review of an executed Phase 14.

— Phase 14 independent challenger, narrow check at `f7fe056`, 2026-10-12
