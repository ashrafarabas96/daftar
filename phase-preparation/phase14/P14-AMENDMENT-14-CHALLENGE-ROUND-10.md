# P14-AMENDMENT-14 — CHALLENGE ROUND 10 (THE LAST TOOLING ROUND), ANSWERED

Status: **PREPARED / NOT PROMOTED**. `READY_TO_PROMOTE = NO`, unsigned.

| report | sha256 | bytes |
|---|---|---|
| `P14-CHALLENGE-50b0341.md` | `e89fcb1c90eaaed8b3cddef5cfe15d1d13f39b067909099b01a49e4500882458` | 10,436 |

Round 10's verdict: **PASS-WITH-SCOPE at `50b0341`** with **one BLOCKING
finding**, and it blocks on the right limb of the stopping rule — not because
the gate failed, but because **a sentence in my own amendment claimed something
was proved that was not**.

---

## 1 — R10-P2-01: THE RULE I WROTE WAS WIDER THAN THE RULE I ENFORCED

Amendment 13 said, without qualification, that **any** transition of an
already-signed reviewer row is refused in either direction, and that a
**committed** reviewer digest may not move. What the code did was compare the
row against **HEAD**:

```
was = head_rows.get(name);  if was and was != PLACEHOLDER and dig != was: refuse
```

So once HEAD carried the placeholder, the rule disabled itself — and **HEAD is
written by the same hand that writes the row.** The reviewer measured it with
one ordinary commit:

```
tamper a committed report, set both cells to UNSIGNED, git commit -am
  history: "reviewer-row history checked"        ← still says checked
  --write 0   --check 0    row now carries the sha256 of the TAMPERED report
```

**A handoff is a commit, so that is the normal path, not an exotic one.** And
outside a repository the two-step bypass survived as a limit I had disclosed
rather than closed. Both of my round-9 red proofs covered only **uncommitted**
transitions, which is exactly why the gap was invisible from inside.

### Third round running, the protection was the construction and not the mechanism

The reviewer says it plainly, and measured it rather than assuming it:
`P14-GATE-035` run whole does **not** fail open, because the shared lane reds
(`row says aa1692775fdf/13,456 bytes, file is 187a719a03c6/13392 bytes`, rc 1).
What failed open was the refusal credited with the protection. So the
construction that has been doing the work three rounds in a row is now **the
rule itself**:

| witness | what it is | why the author cannot rewrite it |
|---|---|---|
| the **other directory** | the same report under `/mnt/project-files/phase14` (or, when `--dir` is the shared folder, under the pack) | a commit does not touch it; forging requires changing both copies in step |
| **every revision** of the manifest | the first non-placeholder digest found walking `git rev-list HEAD -- <manifest>` newest-first | a committed placeholder no longer erases a digest that was once recorded |
| *neither* | — | then **nothing may be signed**: `NO WITNESS` |

Measured, each refusal by its own sentence, in constructed worlds:

| route | refusal | rc |
|---|---|---|
| tampered report, both directories available | `REVIEWER COPIES DIFFER: … hashes aa1692775fdf under . but 187a719a03c6 under …` | **1** |
| **the round-10 bypass**: both cells `UNSIGNED` **and committed**, no counterpart directory | `a signed reviewer row does not move. Some revision of this manifest recorded 187a719a03c6 … a committed placeholder does not erase that` | **1** |
| no repository at all, counterpart present | `REVIEWER COPIES DIFFER` | **1** |
| no repository and no counterpart | `NO WITNESS … Place the reviewer's report in both directories before signing its row` | **1** |

All four are committed red proofs in `tools/gate-sweep.sh`
(`reviewer-row-two-dirs`, `reviewer-row-committed-unsign`,
`reviewer-row-no-repo`, `reviewer-row-no-witness`), each asserted by its
message, because four refusals share one exit code — `COORD P3-07` again, at the
place where it is cheap.

**The wording is narrowed to what is enforced**, in `P14-GATE-035` and by an
annotation on amendment 13 that records what that amendment used to claim.

---

## 2 — R10-P3-01, THE NAMED RESIDUAL, FIXED BECAUSE IT WAS CHEAP

`UNRUNNABLE` classified a gate by its **first** output line, and the two
database gates print a banner first, so a permission failure under them still
read *"consistent, but FAILING"*. The diagnostic line is now chosen from the
whole output, preferring an error (`Permission denied`, `No such file`, `FAIL`,
`ERROR`, `FATAL`, `STALE`, `CONFIGURATION`, `MEASUREMENT`) over a banner. It was
fail-closed either way; it is now also diagnosable.

### And one layer in, within the hour

The same defect bit me again while fixing it. My pattern list preferred `FAIL`
over the line that explains it, so when the database gates failed the sweep
printed *"consistent, but FAILING — first line: `== recreating p14scratch`"*
and hid the arm's own `psql said:` diagnosis. Cause lines are now preferred over
summary lines: a summary tells a reader what they already know.

### R10-RESIDUAL-AUTHOR-01 — an INTERMITTENT database-lane failure I have not explained

Twice this hour the sweep reported `replay` and `redproof-preflight` as `rc=1`
from all four directories — *"the MUTATION did not apply, so nothing was
proved"* for the collation arm — while both scripts exited **0** standalone
minutes later, and the four lanes each exited **0** when I ran them by hand in
the same order. Roles and databases were measured clean in between (four roles
present, `NOSUPERUSER NOBYPASSRLS`, only `p14scratch` left over). Three later
sweeps were green.

**I am not claiming a cause, and I am not claiming it fixed.** My suspicion is
contention on this shared box, since Phase 4 owns it and other phases run
clusters here too, or residue from my own earlier interactive plants. What is
fixed is only the *diagnosis*: the next occurrence will print the cluster's own
error beside the failure instead of a banner. Recorded as a residual, named,
rather than left as a green claim — the exact species of thing this pack's
rounds have been about.

---

## 3 — CARRIED RESIDUALS, NAMED RATHER THAN RE-OPENED

Under `P14-RULE-TOOLING-STOP`, these are recorded and do not open another round:

| residual | state |
|---|---|
| `COORD P3-07` for the **SQL** proofs | OPEN. A red proof judged by exit `3` alone cannot name its own law; the honest fix is an expected SQLSTATE or law name per `ORDER` line, which changes every red-proof line and must be reviewed as its own change. Closed for the provenance and manifest lanes, where refusals are asserted by message. |
| the **version arm** | UNFENCED for the claim that a real PostgreSQL 17 cluster is refused; fenced for *does the assertion fire* by a mutated bound in a copy of `preflight.sql`. |
| `R8-P3-05`, `R9-P3-01` | closed in code; carried here as the lesson that a refusal naming a cause must have asked it. |
| concurrency and performance | **UNMEASURED**, and no timing number from this container enters the evidence. |
| `TL-P14-SEC-01/-02/-03`, §7a's five options, §11a | with the Security and Migration Owners. No migration number is written anywhere in this pack. |
| `OD-P14-09`, `OD-P14-10`, `OD-P14-11` | the owner's, and the service refuses to start until they are set. |

---

## 4 — THE STANDING CAVEAT, FOR THE LAST TIME IN A TOOLING ROUND

Ten rounds, and not one finding has landed against the architecture — because
the architecture is **unexecuted**: no API, no DDL, no routes, no CI. Every
finding of these ten rounds landed on documents, instruments and proofs, and
three of them landed on protections I had credited to the wrong mechanism.
**None of it is credit against the first round run on an executed Phase 14, and
that round should be expected to be the worst yet.**

— Phase 14 author, round 10 answered, 2026-10-12
