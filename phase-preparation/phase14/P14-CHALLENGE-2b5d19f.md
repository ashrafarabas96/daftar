# P14 — INDEPENDENT CHALLENGE, ROUND 9, AT `2b5d19f`

| | |
|---|---|
| Head challenged | `2b5d19f` — two commits: `8123830` *an exit code without its path was never a property of the commit*, then `2b5d19f` *the empty-table proof was wrong, and the sweep caught it* |
| Delta reviewed | `7af6438..2b5d19f` — 13 files changed, 904 insertions, 43 deletions |
| Measured on | PostgreSQL **16.15**, `datcollate=en_US.utf8`, four roles `NOSUPERUSER NOBYPASSRLS`, a cluster rebuilt from scratch for this round |
| Challenger worktree | `/tmp/claude-0/…/r12`, **under `/tmp`** — the checkout shape that produced round 8's two P2s |
| Author files edited | **none** · Pushed | **nothing** · worktree left clean (`git status --porcelain` empty) |
| **VERDICT** | **PASS-WITH-SCOPE** |

Every exit code below is given with the path it was measured from, as the
round-8 addendum asked and this head adopts.

---

## §0 — THE TWO ROUND-8 P2s ARE CLOSED, MEASURED IN THE CHECKOUT THAT PRODUCED THEM

My worktree is under `/tmp`, which is exactly where round 8's findings lived.
From `cwd = /tmp/claude-0/…/r12/phase-preparation/phase14`, with the **pack
itself under `/tmp`**:

| gate | rc | measured from |
|---|---|---|
| `citation-provenance.py --check` | **0** | the pack, the repo root, `/tmp`, and a second worktree — identical ×4 |
| `manifest-digests.py --check` | **0** | same four |
| `manifest-shared --check` | **0** | same four |
| `retracted-claims.py --check` | **0** | same four |
| the same three gates **with the pack at** `/tmp/tmp.gsSi59RMmg/wt/phase-preparation/phase14` | **0** each | the sweep's fifth lane |
| `tools/gate-sweep.sh --no-db` | **0** | the pack, under `/tmp` |

**R8-P2-01 and R8-P2-02 are genuinely closed, not worked around.** The foreign
repository is constructed rather than named; the ancestor-that-is-not-a-repository
case refuses by name; the table cannot be empty; and the floor is taken from the
filesystem. Every new red proof is green here: `provenance-stale` 1,
`provenance-foreign-repo` 2, `provenance-nonrepo-ancestor` 2,
`provenance-empty-table` 2 *with* `MEASUREMENT EMPTY`, `provenance-floor` 2
*with* `MEASUREMENT INCOMPLETE`, `manifest-digest-corrupt` 1,
`retracted-claim-planted` 1, `no-cluster` 1, `rolecount-discriminates` 1.

Also verified: **32 of 32 manifest rows** match on disk; my round-8 report
(`2d853e577c51…`) and its addendum (`9e2e4367d787…`) are committed
byte-identical in the pack and in `/mnt/project-files/phase14`; `replay.sh` from
a world-readable copy → **0, 46 cases, 0 off their required exit code**;
`redproof-preflight.sh` → **0, 5 arms, 0 not red**. **R8-P3-04 is closed**: the
arm now prints `1 of the 4 roles under test are ABSENT (p14_resolver)`, and my
round-8 wrong-role plant is a committed proof (`rolecount-discriminates`).

## §1 — THE FIVE REQUESTED PLANTS

**(1) The pack under `/tmp`, cwd inside the pack, under `/tmp` — PASSES.** The
table above. The author's reading is right and worth recording: running *from*
`/tmp` was never the same property as having the *pack* under `/tmp`, because
every command names the pack absolutely. The sweep now tests both.

**(2) A cited file present on disk that git cannot answer — PASSES, by my own
plant.** I created `apps/api/src/common/floor-plant.ts` untracked in the repo
working tree and cited it in a pack document. Both `--markdown` and `--check`
refused, rc **2**: `MEASUREMENT INCOMPLETE: 1 cited file(s) exist in the working
tree of --repo … but resolved to no row — 'apps/api/src/common/floor-plant.ts'`.
The floor is derived, not typed; it names the file; it fires on the `--check`
path the gate actually runs. Restored, worktree clean.

**(3) A mutation that does not change its target — PASSES.** I replaced
`provenance-stale`'s `sed` with `true`, keeping its declared target. The sweep:
`FAIL provenance-stale the MUTATION did not change P14-MIGRATION-PATCH-REQUEST.md
— nothing was proved`, rc **1**. `arm()`'s discipline is now `red()`'s. See
**R9-P2-01** for where that discipline stops.

**(4) The version arm — DISCLOSED, not presented as a pass.** The script's own
summary says `5 arm(s), 0 not red. The version arm is UNFENCED (needs a second
cluster)`, and `proofs/README.md`, `P14-GATE-035` and Amendment 12 all repeat it.
Worth stating precisely, because the two are easy to conflate: the **law is
asserted** — `preflight.sql:13-14` raises `RUNTIME CLAIM FALSE: server_version_num
% is not PostgreSQL 16` outside `[160000,170000)` — and only the **red proof** is
missing. See **R9-P3-02** for a way to fence most of it without a second cluster.

**(5) Corrupt a challenger report — the refusal FIRES, and then is bypassed in
one step.** See **R9-P2-02**.

---

## §2 — FINDINGS

### R9-P2-02 — the refusal that protects a reviewer's report is bypassed by zeroing the digest first

`--write` refuses to re-sign a drifted challenge row, as the author says. I
appended a retracted sentence to `P14-CHALLENGE-7af6438.md` (my own round-8
report) in a copy of the pack:

```
manifest-digests.py --dir <pack> --check   → 1  STALE: row says 2d853e577c51/17,898 bytes, file is 36951aee2121/17962 bytes
manifest-digests.py --dir <pack> --write   → 1  REFUSING to re-sign a challenge report's row — the file no longer matches
                                                the digest committed when it was received
manifest-digests.py --dir <pack> --check   → 1
```

Then one `sed` sets that row's digest to sixty-four zeros — the **unsigned
placeholder** the author deliberately allows so that a first signing works:

```
manifest-digests.py --dir <pack> --write   → 0  updated: row says 000000000000/17,898 bytes, file is 36951aee2121/17962 bytes
manifest-digests.py --dir <pack> --check   → 0      ← green
retracted-claims.py --pack <pack> --check  → 0      ← green
```

**The tampered reviewer document now passes both prose gates with a valid row.**
The escape hatch is reachable by corrupting the very thing it protects, and it
is one line of `sed` away from any editor of the manifest.

Two things make the remedy cheap, and the second is already in the tool's hands:

- **The byte count gives it away at the moment of the write.** The row read
  `000000000000/17,898 bytes` while the file was 17,962 — a genuinely new row has
  no byte count either. Treat a row as unsigned only when it has **no digest and
  no byte count**, or make the placeholder a literal that cannot be produced by
  corrupting a digest (`UNSIGNED`), so a wiped signature is not a first signing.
- **A challenge row's digest should not be allowed to move from a non-placeholder
  value at all**, which `git show HEAD:P14-HANDOFF-MANIFEST.md` can answer
  without any new state.

**The shared folder still witnesses it**, exactly as in round 8: with the pack
lane green, `manifest-digests.py --manifest <pack>/P14-HANDOFF-MANIFEST.md --dir
/mnt/project-files/phase14 --check` → **1**, `row says 36951aee2121/17,962 bytes,
file is 2d853e577c51/17898 bytes`. So this is not a way to forge a review
undetected while GATE-035 runs whole — it is the second time the protection has
turned out to rest on the two-directory construction rather than on the
mechanism credited with it. That is the thing to write down.

### R9-P2-01 — two red proofs are judged by exit code where five different refusals all answer 2, and the refusal they are named for is proved by neither

`citation-provenance.py` has **six** `return 2` sites. Five are reachable
refusals with distinct messages:

1. `--repo … is not a git repository`
2. `--repo … is a git repository but does not contain 93084f8`
3. `--pack … is not inside --repo` — the round-7 P2-01 remedy
4. `MEASUREMENT EMPTY`
5. `MEASUREMENT INCOMPLETE`

The author applied `named()` — required message, not just code — to 4 and 5,
for exactly this reason. **1, 2 and 3 are still separated by nothing**, and two
consequences follow, both measured:

- **The committed `provenance-foreign-repo` proof fires refusal 2, not the one
  its name and comment describe.** Its world is `FR=$(mktemp -d); git -C "$FR"
  init -q`, and that repository is not foreign to a pathspec — it simply does not
  contain `93084f8`. Measured: rc 2 with `--repo … is a git repository but does
  not contain 93084f8`.
- **Delete `git init` from that world and the proof still passes.** I removed it:
  `ok provenance-foreign-repo rc=2 (required 2)`, sweep rc **0**. What fired was
  refusal 1 — which is the next proof's job. A proof that cannot tell which
  refusal it triggered is the shape `arm()` was rewritten to kill, one layer up.

And **refusal 3, the round-7 remedy itself, has no red proof anywhere in the
sweep.** It needs a repository that *does* carry the revisions with the pack
*outside* it, which neither constructed world builds. I built it in one command
and it answers correctly — `--pack /tmp/p14 --repo /home/user/daftar` → rc 2,
`CONFIGURATION ERROR: --pack (/tmp/p14) is not inside --repo (/home/user/daftar)`
— so the fix is a third `named()` line, not new machinery.

**Remedy:** give proofs 1 and 2 the `named()` treatment that 4 and 5 already
have, and add the ancestry proof. Then every rc-2 refusal is required by the
sentence it prints, and COORD **P3-07** is closed for the whole provenance lane
rather than for two lines of it.

### R9-P3-01 — the sweep cannot tell a failing gate from an unrunnable one

In this container `gate-sweep.sh` reports, from all four directories:

```
FAIL  replay              rc=1 identical from 4 directories — consistent, but FAILING
FAIL  redproof-preflight  rc=1 identical from 4 directories — consistent, but FAILING
FAIL  no-cluster-revert   rc=1 after restarting the cluster — the sweep left the box broken
```

**None of that is a defect in the pack, and I nearly reported it as one.** The
cause is my container: `/tmp/claude-0` is `drwx------ root`, so the unprivileged
account the proofs run as cannot read the pack —
`psql: error: …/proofs/fixture.sql: Permission denied`. From a world-readable
copy of the same tree, `replay.sh` → **0, 46 cases**, and
`redproof-preflight.sh` → **0, 5 arms**.

The finding is what the sweep *said*. `gate()` discards stdout and stderr, so a
gate that could not run and a gate that ran and failed print the same line; and
`no-cluster-revert` asserted *"the sweep left the box broken"* when the cluster
was up and answering `select 1` — a message naming a cause that was measurably
false. This is **R8-P3-05 one layer up**, in the sweep the author built to carry
`arm()`'s discipline: the verdict is sound, the diagnosis is not. Remedy: have
`gate()` keep the first line of output and print it beside a FAIL, and let the
revert check distinguish "the cluster did not come back" from "the script failed
for another reason" by asking the cluster.

### R9-P3-02 — the version arm can be fenced most of the way without a second cluster

The pack's statement is accurate: the law is asserted and the arm is unproved
because the container has one PostgreSQL major version. But the arm's purpose is
to prove **the assertion fires**, and that does not need a second cluster — it
needs the assertion's *bound* mutated, which is `red()`'s existing shape: change
`160000`/`170000` in a copy of `preflight.sql`, require the preflight to abort
with `RUNTIME CLAIM FALSE: server_version_num … is not PostgreSQL 16`, restore,
and require the target to have changed and been put back. That proves the branch
is reachable and correctly worded. It does **not** prove a real PostgreSQL 17 or
18 cluster is refused, so the UNFENCED note should stay, narrowed to what is
genuinely unmeasurable here. Offered as a remedy, not raised as a defect.

---

## §3 — SIGNATURE SCOPE

**PASS-WITH-SCOPE at `2b5d19f` ONLY.** A signature covers one SHA.

**Signed, measured here:** 32/32 manifest rows; my two round-8 documents
committed byte-identical; every static gate 0 from four directories *and* with
the pack under `/tmp`; `gate-sweep.sh --no-db` 0 from the pack; `replay.sh` 0 at
46 cases and `redproof-preflight.sh` 0 at 5 arms from a world-readable copy; the
floor refusing my own untracked-file plant by name; `red()` refusing a no-op
mutation by name; the version arm's UNFENCED status disclosed in four places
with the law itself asserted; and the challenge-row refusal firing on a first,
honest attempt.

**Not signed:** the `--write` refusal as a protection, while zeroing a digest
re-opens it (**R9-P2-02**); `provenance-foreign-repo` and
`provenance-nonrepo-ancestor` as proofs of the refusals they are named for, and
the ancestry refusal as proved at all (**R9-P2-01**); any claim that
`gate-sweep.sh` exits 0 in **this** container, where it exits 1 for a reason
outside the pack (**R9-P3-01**) — the author's recorded 0 from
`/home/user/daftar` and my 1 from a root-only path are both true, which is why
every code above carries its path; the version arm; and concurrency and
performance, unmeasured as in every round.

**The standing caveat, unchanged.** Nine rounds, no finding against the
architecture, because the architecture is unexecuted: no API, no DDL, no routes,
no CI. Nine rounds of harness review are not credit against the first round run
on an executed Phase 14.

— Phase 14 independent challenger, round 9, 2026-10-12
