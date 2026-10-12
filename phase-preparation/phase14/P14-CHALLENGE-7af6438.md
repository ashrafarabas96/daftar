# P14 — INDEPENDENT CHALLENGE, ROUND 8, AT `7af6438`

| | |
|---|---|
| Head challenged | `7af6438485c89ef3cca04d7d86aeb0562157a24c` — *phase14: the fence passed when nothing was running, and prose had no gate* |
| Delta reviewed | `583a4a0..7af6438` — 22 files changed, 1,326 insertions, 124 deletions, one commit |
| Declared base of the pack | `93084f8` (container tree `6fc505d`) — unchanged this round |
| Measured on | PostgreSQL **16.15** (Ubuntu 16.15-0ubuntu0.24.04.1), `datcollate=en_US.utf8`, four roles under test **NOSUPERUSER NOBYPASSRLS**, scratch cluster built for this round |
| Working copy | a worktree of the author's branch at `7af6438`, clean (`git status --porcelain` empty, 0 commits ahead of `origin/claude/project-thread-1zqgj8`); a second copy under `/tmp` for execution |
| Author files edited by the challenger | **none** |
| Pushed by the challenger | **nothing** |
| **VERDICT** | **PASS-WITH-SCOPE** |

Every finding below is prefixed with the round that raised it, as required from
round 7 onward.

---

## §0 — WHAT WAS RE-VERIFIED BEFORE ANY FINDING

- **29 of 29 manifest artifact rows** match the file on disk in the worktree at
  `7af6438`, and every file has a row — `manifest-digests.py --dir <worktree>
  --check` exit **0**: *"every artifact row matches the file on disk, and every
  file has a row."*
- **My own two round-7 documents are committed unedited.**
  `P14-CHALLENGE-583a4a0.md` is `1655d5ea02cbb6ea…` and
  `P14-CHALLENGE-583a4a0-ADDENDUM-01.md` is `130be952a53b27bb…` in the pack and
  in `/mnt/project-files/phase14`, both identical to the digests I delivered.
- **Baseline, measured before any plant:** `proofs/replay.sh` → **46 cases, 0
  not at their required exit code, rc 0**. `proofs/redproof-preflight.sh` with
  the cluster up → **5 arms, 0 not red, rc 0** (e.g. `ok superuser preflight
  exit=3  PRINCIPAL CLAIM FALSE: p14_merchant is SUPERUSER`).

## §1 — THE FOUR REQUESTED PLANTS, MEASURED

### Plant 1 — stop the cluster; then silently neuter one arm

**1a. Cluster stopped.** `proofs/redproof-preflight.sh` printed five
`FAIL … the MUTATION did not apply, so nothing was proved (cluster down? role
missing?)` lines, `== 5 arm(s), 5 not red.`, exit **1**. The coordinator review's
**P2-05** is closed, by execution. The fix is itself fenced inside
`tools/gate-sweep.sh`, and both halves of that fence measured green here:
`ok no-cluster rc=1 with the cluster STOPPED` and `ok no-cluster-revert rc=0
again once the cluster is back` — the proof reverts its own world.

**1b. A mutation made into a true no-op.** On my own copy, the `bypassrls`
arm's `ALTER ROLE p14_worker BYPASSRLS` was replaced by `SELECT 1`. The harness
caught it: `FAIL bypassrls preflight exit=0 — not an assertion failure`, exit
**1**. The new `arm()` is sound against a silent no-op. **PASSES.**

**1b, second variant — a mutation of the WRONG object.** See **R8-P3-04**.

### Plant 2 — `gate-sweep.sh` from a fifth directory it does not list

I ran it from `/tmp/p14fifth`, a directory that is **its own git repository**
and carries two decoys: a `P14-MIGRATION-PATCH-REQUEST.md` containing the word
`DECOY`, and a `tools/citation-provenance.py` that exits 0 printing
`DECOY GATE`. Output from the fifth directory is **byte-identical** to the run
from the pack (`diff` → IDENTICAL), including every `ok`/`FAIL` line and the
summary. `python3 -I` defeats the module decoy; `$HERE`/`$PACK`/`$REPO` defeat
the document decoy. **The fifth-directory property PASSES.**

But the run itself does not: see **R8-P2-01** and **R8-P2-02**, which the fifth
directory is not responsible for — the sweep fails from the pack directory too.

### Plant 3 — a retracted sentence put back

Claim used: `the three absent ones are cited only for Phase 4 surface facts`
(row 1 of `tools/RETRACTED-CLAIMS.tsv`). All four variants on my own copy.

| variant | `retracted-claims --check` | `manifest-digests --check` |
|---|---|---|
| baseline | 0 — *7 retracted claim(s) enforced across 31 pack document(s)* | 0 |
| **3a** appended to `README-AR.md` (a non-challenge document) | **1** — names the claim, why it was retracted, and the three files it is allowed in | 1 |
| **3b** a NEW file `P14-CHALLENGE-deadbee.md` | **0** — exempt by filename | **1** — `ARTIFACT WITH NO ROW` |
| **3c** 3b plus `manifest-digests --write` to give it a row | **0** | **1** — `--write` exits 1 and **refuses**: *"NOT ADDED (a row is a description, not a digest — write it)"* |
| **3d** the sentence appended to a GENUINE report, `P14-CHALLENGE-583a4a0.md` | **0** — exempt | **1** — `row says 1655d5ea02cb/10,369 bytes, file is 3eab4bbf1f9c/10433 bytes` |

So: **the filename exemption is blind on its own in every variant**, and
**`P14-GATE-035` as a whole is not abusable** — the digest gate reds on an
unlisted report, refuses to invent a row for one, and reds on a single appended
line in a real one. The exemption's stated justification (editing a received
review would be falsifying it) stands. One residual: **R8-P3-01**.

### Plant 4 — pair-drop the overlapping gates

The pair is `retracted-claims.py --check` (prose, with the filename exemption)
and `manifest-digests.py --check` (bytes). Dropping either one alone leaves the
plant visible — that is plant 3's table. **Dropping the pair the way an author
actually would** is the test that matters: tamper the report, then run the
pack's own `--write` to re-sign the row.

```
printf '\n%s\n' "$CLAIM" >> P14-CHALLENGE-583a4a0.md
tools/manifest-digests.py --dir <pack> --write     → rc 0, row re-signed
tools/manifest-digests.py --dir <pack> --check     → rc 0      ← green
tools/retracted-claims.py --pack <pack> --check    → rc 0      ← green
```

Both prose gates go green on a tampered reviewer document. What stops it is
neither of them:

```
tools/manifest-digests.py --manifest <pack>/P14-HANDOFF-MANIFEST.md \
                          --dir /mnt/project-files/phase14 --check
  → rc 1  STALE: P14-CHALLENGE-583a4a0.md: row says 3eab4bbf1f9c/10,433 bytes,
                 file is 1655d5ea02cb/10369 bytes
```

**`--manifest` is pinned to the pack while `--dir` is not, so ONE manifest is
checked against TWO directories, and re-signing the pack copy immediately
contradicts the shared folder.** That construction is what protects a
reviewer's text, and it is a good one. It is worth recording because
`P14-GATE-035`'s wording credits the retraction enforcement to
`retracted-claims.py`, which is not where the protection lives: if the
`--dir $SHARED` gate is ever dropped — the one gate that needs a path outside
the repository — the pair above goes green with no witness left. Suggested, not
required: have `--write` refuse to UPDATE a `P14-CHALLENGE-*.md` row exactly as
it already refuses to ADD one, since those files are received, not authored.

---

## §2 — FINDINGS

### R8-P2-01 — `tools/gate-sweep.sh` exits **1** at this head, from every directory; `P14-GATE-035` is red in any checkout under `/tmp`

`P14-TASK-DAG.md:193` makes `P14-GATE-035` *"`tools/gate-sweep.sh` exits `0`"*
and gives it **blocks any handoff**; `P14-AMENDMENT-11` records its expected
exit as **0**. Measured at `7af6438`:

```
== every gate, from 4 working directories
ok    citation-provenance        rc=0 identical from 4 directories
ok    manifest-digests           rc=0 identical from 4 directories
ok    manifest-shared            rc=0 identical from 4 directories
ok    retracted-claims           rc=0 identical from 4 directories
== red proofs
ok    provenance-stale           rc=1 (required 1)
FAIL  provenance-foreign-repo    rc=1, required 2 — the gate did not turn red
ok    manifest-digest-corrupt    rc=1 (required 1)
ok    retracted-claim-planted    rc=1 (required 1)
== 1 gate(s)/proof(s) not as required          exit 1
```

Identical with the DB lane added (there `replay`, `redproof-preflight`,
`no-cluster` and `no-cluster-revert` are all green and the count is 2 only
because the pack copy sits outside a git checkout — see R8-P3-03).

**Cause.** The red proof is `--repo /tmp`, required to exit 2. `/tmp` is
"foreign" only when the pack is not under `/tmp`. My worktree is at
`/tmp/claude-0/…/r10/phase-preparation/phase14`, so `os.path.relpath(pack,
'/tmp')` is `claude-0/…` — no leading `..`, the configuration check at
`tools/citation-provenance.py:208-214` cannot fire, and the tool answers 1
instead. Measured in both directions:

| `--repo` | `relpath(pack, repo)` | rc |
|---|---|---|
| `/home/user/daftar` | `../../../tmp/claude-0/…` | **2** — refuses |
| `/tmp/p14fifth` | `../claude-0/…` | **2** — refuses |
| `/tmp` | `claude-0/…` | **1** |
| `/` | `tmp/claude-0/…` | **1** |

**This is the mutation-did-not-apply failure mode, in the author's own sweep.**
The arm's mutation silently becomes a no-op depending on where the pack was
checked out, and the sweep then reports the gate as not turning red. It is
fail-closed — the handoff gate goes red, it does not go falsely green — but a
reviewer or a CI runner that clones into `mktemp -d`, a worktree under `/tmp`,
or any scratch path sees `P14-GATE-035` red at a head the pack records as 0,
and the red says nothing about the real cause.

**Remedy.** Do not hard-code a path as foreign. Compute one that cannot be an
ancestor (`R=$(mktemp -d); git -C "$R" init -q`, then `--repo $R` — measured
above as rc 2 via `/tmp/p14fifth`), and keep a second arm for the
non-repository case from **R8-P2-02**.

### R8-P2-02 — the provenance tool tests path ancestry, not repository-ness: a non-repository `--repo` deletes the whole base-tree table and exits **0**

`citation-provenance.py:204-214` is the round-7 remedy, with its own comment:
*"a pathspec that leaves the repository must FAIL LOUDLY. Answering False turns
a misconfiguration into a silent misclassification, and a wrong bucket then
reads as drift."* The test it implements is `rel.startswith('..') or
os.path.isabs(rel)` — **an ancestry test**. Whether `--repo` is a git repository
at all is never asked. `git()` (`:44-45`) returns the `CompletedProcess` and
`returncode` is read only by `tracked()`, never on the `log` calls in
`was_in_pack()`.

Measured, from the pack directory, at `7af6438`:

```
tools/citation-provenance.py --markdown              → rc 0, 57 lines
tools/citation-provenance.py --markdown --repo /tmp  → rc 0, 13 lines
```

**All 41 rows of the base-tree table vanish** — every frozen migration, every
`ABSENT at 6fc505d`, the `MIGRATION_MANIFEST.json` **DIFFERS** (+27/-3) row,
`permissions.ts` **DIFFERS** (+66/-1), `static-guards.ts` **DIFFERS**
(+106/-9) — and the generator **exits 0** while printing a table with nothing
in it. `--check` then calls it `GENERATED CITATION-PROVENANCE BLOCK IS STALE`
and tells the reader to run `--write`, which would commit the empty table.

This is, word for word, the defect the round-7 comment at `:60-64` says was
removed: *"A LOCATION problem printed as a CONTENT verdict."* The fix closed
the direction where the pack is outside the repository and left the direction
where `--repo` is an ancestor that is not a repository. Same lesson as round 7:
a remedy covers the input shape it was written against, not the property.

**Remedy, two parts, both cheap.** Require
`git -C "$repo" rev-parse --git-dir` to succeed and refuse with rc 2 naming the
directory when it does not; and assert the generated table is **non-empty**
(`if not rows: return 2`), because a table with no rows is never a true
description of a pack that cites 41 files. The second part is the one that
generalises: this pack's own law is that **a count must be generated and then
measured** — the row count is generated and never measured.

### R8-P3-01 — `retracted-claims --check` counts the documents it exempted among the documents it enforced

The run ends `7 retracted claim(s) enforced across 31 pack document(s)`.
Adding `P14-CHALLENGE-deadbee.md` makes it `… across 32 pack document(s)` with
exit 0 — the number grew by a document the check **skipped**. Nothing in the
output names an exempt file or counts them. A reader cannot distinguish 32
documents checked from 31 checked and 1 waived. Remedy: print the exempt files
by name and report the two counts separately (*"enforced across 31; 1 file
exempt by name: …"*). Same class as `R6 §0` and the generator's bucket
partition: a count that does not show its exclusions is not a measurement.

### R8-P3-02 — the shared-folder gate refuses by traceback, not by name

`manifest-digests.py --dir <absent> --check` exits 1 with an uncaught
`FileNotFoundError: [Errno 2] No such file or directory`. Fail-closed, which is
right, but by Python traceback — against this pack's own discipline of refusing
by a named message, which it follows everywhere else (`ROW WITH NO FILE in …`,
measured on an empty directory: rc 1 with 29 named rows). The shared folder is
the one gate input outside the repository and therefore the one most likely to
be absent in CI; its refusal should say *"the shared folder … is not present;
the handoff integrity gate cannot run"*.

### R8-P3-03 — the four-directory property is reported, never asserted

`DIRS` is built from `$PACK`, `$REPO` and `/tmp` plus a worktree. Both
git-derived entries fail silently: `REPO=$(git -C "$PACK" rev-parse
--show-toplevel)` leaves `REPO` empty outside a checkout (printing `fatal: not
a git repository` to stderr), and `git worktree add` is `2>/dev/null` with
`WT2=""` on failure. Measured from a pack copy outside a git checkout:

```
== every gate, from 2 working directories
ok    manifest-digests           rc=0 identical from 2 directories
ok    manifest-shared            rc=0 identical from 2 directories
ok    retracted-claims           rc=0 identical from 2 directories
```

Three gates print `ok … identical from 2 directories` and nothing requires 4.
`P14-GATE-035` and `P14-AMENDMENT-11` both name **four**. The sweep exits 1
here only because of R8-P2-01/02; with those fixed it would exit 0 having
measured half the property it is credited with. Remedy: refuse unless
`$(echo $DIRS | wc -w) -ge 4`, and say which entry could not be built.

### R8-P3-04 — the `rolecount` arm cannot tell which role vanished

Four of the five arms assert by name (`p14_worker has BYPASSRLS`,
`p14_merchant is SUPERUSER`). The fifth requires the message `PRINCIPAL CLAIM
FALSE: 3 of the 4 roles under test exist`, which is a **count**. I replaced its
mutation with one of a different role — `ALTER ROLE p14_merchant RENAME TO
p14_merchant_x` in place of `p14_resolver` — and the arm still reported

```
ok    rolecount    preflight exit=3  PRINCIPAL CLAIM FALSE: 3 of the 4 roles under test exist
```

So the arm proves *some* role's absence is detected, not that
`p14_resolver`'s is. The law itself is **not** affected: `preflight.sql:35-38`
counts membership of a hard-coded four-name list, so any one of the four going
missing aborts the run — hence P3, not P2. What is affected is the red proof's
discriminating power and the operator's remedy: the message says `3 of the 4`
and `run bootstrap.sql` without naming the role to create. Remedy: name the
missing role(s) in the exception, and plant the arm once per role. (The
cluster was left clean: four roles, all `NOSUPERUSER NOBYPASSRLS`, verified
after the plant.)

---

## §3 — SIGNATURE SCOPE

**PASS-WITH-SCOPE at `7af6438` ONLY.** A signature covers one SHA and does not
transfer to the next commit.

**Signed, because I measured it myself at this head:** the 29 manifest digests;
that my two round-7 documents are committed byte-identical; `replay.sh` at
46 cases, 0 off their required exit code; `redproof-preflight.sh` at 5 arms,
0 not red, on PG 16.15 @ `en_US.utf8` with four NOSUPERUSER NOBYPASSRLS roles;
the stopped-cluster fence in both directions (`no-cluster` rc 1,
`no-cluster-revert` rc 0), closing coordinator **P2-05** by execution; the
no-op-mutation guard in `arm()`; the fifth-directory invariance of
`gate-sweep.sh`; and that `P14-GATE-035` taken as a whole catches every one of
the four plant-3 variants.

**Explicitly NOT signed:**
- `tools/gate-sweep.sh` **exits 1 at this head** (R8-P2-01). `P14-GATE-035` is
  therefore **not satisfied** at `7af6438` as the gate is written, in this
  container. No handoff can be signed on it until the gate exits 0 in the
  checkout it is run from.
- Any provenance figure produced with a `--repo` that is not a git repository
  (R8-P2-02). The committed block is correct — I re-generated it with the
  correct default and it is current (`--check` rc 0) — but the tool will produce
  an empty table and exit 0 on the wrong input, so the figures are only as good
  as the invocation.
- The `rolecount` arm as proof that `p14_resolver` specifically is fenced
  (R8-P3-04).
- The **version** arm, which the pack correctly records as UNFENCED: it needs a
  second cluster of a different major version, which this container does not
  have.
- Concurrency, performance and anything requiring a second PostgreSQL major
  version: **unmeasured**, as in every prior round.

**The standing caveat, unchanged and restated because it is the most important
sentence in eight rounds of this challenge.** No finding has landed against the
pack's architecture in any round. That is **not** because the architecture is
vindicated — it is because **the architecture is unexecuted**. Phase 14 has no
API, no DDL, no routes, no CI. Everything I have been able to attack is the
evidence harness and the documents, which is why eight rounds have produced
harness findings and nothing else. None of the eight rounds counts as credit
against the first round run on an executed Phase 14, and that round should be
expected to be the worst yet.

— Phase 14 independent challenger, round 8, 2026-10-12
