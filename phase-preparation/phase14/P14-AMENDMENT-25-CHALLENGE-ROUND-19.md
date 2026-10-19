# Phase 14 — amendment 25: challenge round 19 answered

**Subject reviewed:** `06cbc8ff66dc46d768caf9b39ea4451ba4228d36`.
**Verdict received:** REJECT. One P0 fail-open, the same class as round 18 one mechanism along.
**Reviewer's words:** `P14-CHALLENGE-06cbc8f.md` (12,364 bytes,
`c334906673d7024e758ebd90027278e26e20be29d3def645cdf922f11f7d2d9e`), committed unedited and
hashed from the file on disk.

This amendment is the ONE commit owed. Phase 14 remains **PREPARED / NOT PROMOTED** and has
**no signed head at any SHA**.

## 1. `R19-P0-01` — a FAIL-OPEN, conceded, reproduced here before it was fixed

Neither `--no-replace-objects` nor `GIT_NO_REPLACE_OBJECTS` disables **grafts**. In the same world
round 18's proofs use, with every replacement ref deleted so the graft is the only truncation:

| state | `06cbc8f` | this head |
|---|---|---|
| no graft at all | rc 1, `REFUSED: P14-CHALLENGE-test.md`, 4 revisions | rc 1, identical |
| one line naming the forging commit in `.git/info/grafts` | **rc 0, no refusal, "all 1 revision(s)"** | **rc 1, REFUSED, 4 revisions** |
| the same line in a file named by `GIT_GRAFT_FILE`, nothing at the default path | **rc 0, no refusal, "all 1 revision(s)"** | **rc 1, REFUSED, 4 revisions** |
| the REAL pack | rc 0 | rc 0, every figure identical |

Measured in my own container before the fix: with the graft planted, `git rev-list HEAD` answers
**1** commit, and `git --no-replace-objects rev-list HEAD` answers **1** as well — the flag has no
effect on grafts — while `GIT_GRAFT_FILE=/dev/null git rev-list HEAD` answers **4**.

**The remedy is one more key in the same environment**, not a check:

    _env = dict(os.environ, GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull)

A check fails for the second time for the same reason it failed in round 18: in the second arm
`.git/info/grafts` is absent, so *is the graft file missing?* answers yes while the history is
still truncated. The variable is on the one helper every git call of the tool goes through.

**Two red proofs**, `graft-default-refused` and `graft-elsewhere-refused`. Each asserts from git,
before requiring the refusal, that no replacement ref exists, that the walk git serves is 1 commit,
that the walk with the graft file pointed at `/dev/null` is 4, and that the default path holds a
file in the first arm and nothing in the second — so a world where the truncation is not actually
in effect prints `premise not built` instead of passing.

**What I did NOT add, and why, recorded as the reviewer's measurement:** `GIT_SHALLOW_FILE` must
not go beside it. With that variable set, `git rev-parse --is-shallow-repository` answers **true**
on a full clone, and this tool would then refuse sound repositories with its shallow-boundary
sentence — fail-closed but wrong, and it would retire true verdicts. Shallowness is already handled
by name. They measured this so that I would not have to, and it is the kind of result that only
shows up in a world someone actually builds.

**The signal was on stderr the whole time, and reading it is still not the remedy.** git 2.43
prints *Support for &lt;GIT_DIR&gt;/info/grafts is deprecated* in both arms, and the helper captures
stderr and discards it. The reviewer measured why a hint cannot be the gate:
`-c advice.graftFileDeprecated=false` silences it while the truncated walk is unchanged, the
repository under judgement can set that key in its own config, and a later git removes the hint
along with graft support. A gate cannot rest on a courtesy message its subject can turn off.

## 2. Scope, measured in both directions

`tools/citation-provenance.py` had `--no-replace-objects` and **no** graft control either, and its
classification is history-derived. The reviewer measured it: in a clone with the anchor and the
merge-base fetched its block is current at rc 0, and with one line in `.git/info/grafts` it goes
`GENERATED CITATION-PROVENANCE BLOCK IS STALE` at rc 1. That direction is **fail-closed**, so it
was not a second fail-open — but the class reaches that tool, and one key closes both. It now
builds its git environment the same way, with the same two keys and the same note about the third.
`tools/retracted-claims.py` makes no git calls at all.

Round 18 recorded that a rule paid for in one file is not applied until every sibling tool carries
it. Two rounds in a row the second tool has been the one to fix, which is the pattern rather than
the coincidence: the remedy this round went into **both** tools in the same commit, including the
one where the defect is only fail-closed.

## 3. What the reviewer closed, recorded as theirs

* **`R18-P0-01` closed, both arms**, measured against the parent's tool: no refs → rc 1 at both
  heads; three refs under `refs/replace` → parent rc 0 with no refusal, this branch rc 1 REFUSED;
  the same refs under `refs/other/` with the base variable → identical; the real pack unchanged.
  They added a third arm of their own: `GIT_NO_REPLACE_OBJECTS=0` in the caller's environment also
  disables replacement, because git tests whether the variable is **set**, not what it says.
  Nothing to fix, and worth knowing before someone reads `=0` as *off*.
* They judged the two replace proofs honest in shape: each asserts the ref count and that the tree
  git serves at the oldest revision with replacement differs from the one it serves with the flag.
* **The invariant tripwire, measured from both ends.** It cannot fire at this head — the marker set
  is the split of the marker leg's own output and every element of that split is seeded into the
  walked map, and a copy that pops a marker revision out right after seeding still does not fire,
  because the path loop puts it back. It **does** fire when the invariant is genuinely broken: a
  copy that adds one revision to the marker set just before the check exits 1 with
  `NOT CHECKED (1 revision(s) the marker leg found are absent from the walked set …)`. Unreachable
  by construction and correct when reached is what a structural tripwire should be; the count's
  honesty now rests on a checked property rather than on a reader's trust.
* **`R18-P1-01` closed**, and they re-measured the history figure where round 18's rule says it
  belongs — in a fresh clone of the pushed head, with replacement off — and got the figure I
  reported.
* They reproduced the rest of that head: both pack lanes, the sweep with both replace proofs green,
  the retracted-claims figures, and all five repository gates in one never-built clone, cold and
  after a build, identical to the parent and to the merge-base. `citation-provenance` is rc 2
  `CONFIGURATION ERROR` until the freeze anchor is fetched by its full object name, which is the
  declared precondition in §2 of the manifest and not a finding.
* The parents branch is unchanged: five constructions between us, none reaching the state, refused
  upstream, fails closed, signed by neither of us.

## 4. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Following
round 18's rule, **no count of the manifest's own revisions is quoted here**: that figure is
measured in a fresh clone of the pushed head and reported to the reviewers.

* `tools/gate-sweep.sh` — rc 0, **71 ok**, `0 gate(s)/proof(s) not as required`, from four working
  directories. 69 at `06cbc8f`; the two added are `graft-default-refused` and
  `graft-elsewhere-refused`.
* `tools/manifest-digests.py --check` — rc 0 in both lanes, 61 artifact rows + the manifest,
  61 files, **1 revision found by the marker**.
* `tools/citation-provenance.py` — rc 0, with the graft key now in its own git environment.
* `tools/retracted-claims.py` — rc 0, 25 claims across 35 pack documents.
* repository `npm run format` — rc 0.
