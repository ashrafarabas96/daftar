# P14 — INDEPENDENT CHALLENGE, ROUND 10, AT `50b0341`

**The last tooling round under `P14-RULE-TOOLING-STOP`.** Every finding below is
graded against that bar — a **false measured claim** (a recorded exit code, a
count, or a claim that something was proved) or a **fail-open on a gate** blocks;
everything else is a **named residual**. The grade is stated on each finding.

| | |
|---|---|
| Head challenged | `50b0341` — *the escape hatch was reachable by corrupting what it protects* (8 files, +587/−65 over `2b5d19f`) |
| Measured on | PostgreSQL **16.15**, `datcollate=en_US.utf8`, four roles `NOSUPERUSER NOBYPASSRLS`, cluster rebuilt for this round |
| Paths used | author's worktree `/tmp/claude-0/…/r13` (root-only, so the DB lane cannot run there); world-readable clone **`/tmp/p14r2`**; second clone `/tmp/p14repo`; copy `/tmp/p14` |
| Author files edited | **none** · Pushed | **nothing** |
| **VERDICT** | **PASS-WITH-SCOPE**, with **one blocking finding** |

---

## §0 — WHAT REPRODUCES

**`tools/gate-sweep.sh` → 0**, measured from
`/tmp/p14r2/phase-preparation/phase14` (a clone, **pack under `/tmp`**), with
the DB lane included. Every lane and all fourteen red proofs green:

```
six gates × four directories            → 0 identical
three gates with the pack at /tmp/tmp.d2m0JJftEK/wt/phase-preparation/phase14 → 0 each
provenance-stale 1 · provenance-not-a-repo 2 "is not a git repository"
provenance-repo-without-base 2 "does not contain 93084f8"
provenance-pack-outside-repo 2 "is not inside --repo"
provenance-empty-table 2 MEASUREMENT EMPTY · provenance-floor 2 MEASUREMENT INCOMPLETE
manifest-digest-corrupt 1 · reviewer-row-resign 1 · reviewer-row-unsign 1
retracted-claim-planted 1 · no-cluster 1 · rolecount-discriminates 1
no-cluster-revert 0 · version-arm-fires 3 "is not PostgreSQL 16"
== 0 gate(s)/proof(s) not as required
```

Also measured: **34/34** manifest rows in the pack **and** in
`/mnt/project-files/phase14`; `replay.sh` → **0, 46 cases**; 
`redproof-preflight.sh` → **0, 5 arms**, the version arm disclosed UNFENCED; my
round-9 report committed byte-identical (`187a719a03c6…` in both directories).

**R9-P2-01 is closed, and I proved it by hollowing a world.** I gave
`provenance-not-a-repo`'s temp directory a `git init`, so a sibling's refusal
would answer instead. The proof **failed by name and printed the message it
actually got**: `FAIL provenance-not-a-repo rc=2 (required 2), and the message
was not is not a git repository: CONFIGURATION ERROR: --repo … is a git
repository but does not contain 93084f8`. Each of the five rc-2 refusals is now
required by its own sentence in its own constructed world, and the round-7
ancestry refusal is proved for the first time.

**R9-P3-02 is closed as offered** — `version-arm-fires` mutates the bound in a
copy of `preflight.sql`, asserts the mutation applied, and requires exit 3 with
`is not PostgreSQL 16`. The narrowed UNFENCED note stays, correctly.

**R9-P3-01's revert half is closed**, and better than asked: in my container it
printed `FAIL no-cluster-revert rc=1 while the cluster ANSWERS select 1 — so
this is not the cluster:` followed by the real first line. The false sentence
*"the sweep left the box broken"* is gone.

---

## §1 — R10-P2-01 · **BLOCKS** · the reviewer-row rule as stated is wider than what is enforced: committing the unsign moves a signed digest

Amendment 13 states the rule without qualification — *"**any** transition of an
already-signed reviewer row is a refusal, in either direction"* — and point 2 as
*"A **committed** reviewer digest may not move"*, with one disclosed limit (no
repository → `reviewer-row history NOT CHECKED`). Both red proofs
(`reviewer-row-resign`, `reviewer-row-unsign`) pass, and I reproduced them.

**Where the premise holds, the fix is sound.** In a clone with true history,
against my own round-9 report:

```
cwd /tmp/p14repo/…/phase14            history: reviewer-row history checked
append a retracted sentence → --write → 1  REFUSING to re-sign a challenge report's row
set both cells to `UNSIGNED` → --write → 1  this reviewer's row carried 187a719a03c6 at HEAD and
                                            now carries UNSIGNED — a signed reviewer row does not
                                            move, in either direction
```

**One ordinary commit defeats it, and the output still says the history was
checked.** Same clone, same tampered report, one `git commit -am` of the
`UNSIGNED` row:

```
history: reviewer-row history checked          ← still "checked"
--write → 0   row says UNSIGNED/UNSIGNED bytes, file is aa1692775fdf/13456 bytes
--check → 0
row now `aa1692775fdf`  =  sha256 of the TAMPERED report
```

The guard is `was = head_rows.get(name)` with `was != PLACEHOLDER` — so once the
placeholder is what HEAD carries, the rule disables itself. HEAD is written by
the same hand that writes the row, and a handoff **is** a commit, so this is not
an exotic path: it is the normal one.

**And in any copy outside a repository the two-step bypass still works**, with
the limit disclosed rather than hidden: `/tmp/p14` prints
`reviewer-row history NOT CHECKED (the manifest is not in a git repository
here)`, `--write` refuses the plain re-sign (rc 1), then both cells set to
`UNSIGNED` give `--write` **0**, `--check` **0**, `retracted-claims` **0**, and
the row carries the tampered digest. That is the shape a handoff archive has.

**Grade.** This meets the bar on the *claim that something was proved* limb: the
rule is asserted unconditionally and the two red proofs cover only the
**uncommitted** transitions, so the sentence is wider than the measurement
behind it. It is a fail-open of **the refusal**; it is **not** a fail-open of
`P14-GATE-035` as a whole, and I measured that rather than assuming it — with
the pack lane green, the shared lane reds: `STALE: P14-CHALLENGE-2b5d19f.md: row
says aa1692775fdf/13,456 bytes, file is 187a719a03c6/13392 bytes`, rc **1**.

**So, for the third round running, the protection is carried by the
one-manifest-two-directories construction and not by the mechanism credited with
it.** The remedy follows from that, and the pack already has every piece:
compare each `P14-CHALLENGE-*` row against the file in the **shared folder** and
refuse when the two directories disagree, instead of against HEAD. A reviewer's
digest then rests on a witness the author's own commits cannot rewrite. The
narrower fix — treat `was == PLACEHOLDER` as "still signed if any earlier commit
carried a digest" (`git log -p`), rather than as unsigned — closes the committed
case but leaves the non-repository one, so it is the weaker of the two.

## §2 — R10-P3-01 · **named residual** · the UNRUNNABLE label cannot fire for the two gates that were unrunnable

`gate()` now keeps output and separates the two states, exactly as Amendment 13
says. But it tests `out1`, which is `grep -m1 .` — the **first non-empty line** —
and a driver that prints a banner first hides its own diagnostic. Measured from
the author's worktree at `/tmp/claude-0/…/r13`, where `/tmp/claude-0` is
`drwx------ root` and the unprivileged account the proofs run as cannot read the
pack:

```
FAIL  replay              rc=1 identical from 4 directories — consistent, but FAILING
      first line: == recreating p14scratch so the replay starts from a clean database
FAIL  redproof-preflight  rc=1 identical from 4 directories — consistent, but FAILING
```

The real line is four lines further down:
`psql: error: …/proofs/fixture.sql: Permission denied`. So the two gates that
*were* unrunnable are the two the label cannot reach. **Grade: residual.** It is
fail-closed, the sweep goes red, the first line is printed, and no recorded
figure is false — the author's own run had no unrunnable gate, so nothing he
recorded is wrong. Remedy, one line, and the pack already uses it in `arm()`:
sample `grep -m1 -E 'ERROR|error|FATAL|Permission denied|No such file'` instead
of the first non-empty line, or test the whole output.

## §3 — WHAT I CHECKED AND FOUND NOTHING WRONG WITH

The coordinator's five plants, each measured: zeroing a digest and re-signing
(refused, rc 1); restoring a signed row to `UNSIGNED` (refused by its own
sentence); a manifest with no history (`NOT CHECKED` **is** printed — the limit
is disclosed, not silent, and the bypass that survives there is R10-P2-01);
hollowing an exit-2 proof so a sibling's message answers (fails by name);
and a gate made unrunnable (the sweep does not go green — it goes red, with the
labelling residual above).

---

## §4 — SIGNATURE SCOPE AND THE STOPPING RULE

**PASS-WITH-SCOPE at `50b0341` only**, and under `P14-RULE-TOOLING-STOP`:

- **One finding blocks: R10-P2-01.** It is a claim-of-proof wider than its
  proofs, and the refusal it describes fails open on the ordinary path.
- **One finding is a named residual: R10-P3-01.**
- Carried forward as named residuals, not round-openers, per the bar settled
  with the coordinator: **R8-P3-05** and **R9-P3-01** (a fail-closed refusal that
  names the wrong cause), and the version arm's genuine unmeasurability here (no
  second PostgreSQL major version).

**Signed, measured here:** `gate-sweep.sh` **0** from `/tmp/p14r2/…/phase14`
with the DB lane and fourteen red proofs green; 34/34 rows in both directories;
`replay.sh` 0 at 46 cases; `redproof-preflight.sh` 0 at 5 arms;
`version-arm-fires` 3 by message; the five rc-2 refusals each proved by its own
sentence, which I verified by hollowing one; the reviewer-row refusal for every
**uncommitted** transition.

**Not signed:** the reviewer-row rule as stated (R10-P2-01); the UNRUNNABLE
label (R10-P3-01); any claim that `gate-sweep.sh` exits 0 in a root-only
checkout, where the DB lane cannot run at all — which is why every code above
carries its path; and concurrency and performance, unmeasured as in every round.

**The standing caveat, for the last tooling round.** Ten rounds, and no finding
has ever landed against the architecture. That is because the architecture is
unexecuted: no API, no DDL, no routes, no CI. Ten rounds of harness review are
not credit against the first round run on an executed Phase 14, and the stopping
rule does not change that — it ends the tooling rounds, not the review.

— Phase 14 independent challenger, round 10, 2026-10-12
