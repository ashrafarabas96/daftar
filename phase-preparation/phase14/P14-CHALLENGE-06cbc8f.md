# Phase 14 — independent challenge, round 19 (narrow)

**Subject:** `06cbc8ff66dc46d768caf9b39ea4451ba4228d36` (`06cbc8f`), parent
`c001cd9e668f9d481d3bc8c92c23df314fefa80c` — ONE commit, as asked. Read with replace objects
disabled; the repository serves no `refs/replace` and no graft file. Clone `/tmp/g36`,
`--branch claude/project-thread-1zqgj8 --single-branch` from origin.

**Verdict: REJECT.** `R18-P0-01` and `R18-P1-01` are closed, both arms measured, and the new
invariant tripwire does what it says. But `refs/replace` is not git's only way to let a repository
dictate its own history, and `--no-replace-objects` does not disable the other one: a **graft file**
truncates the walk just as effectively, and the forgery that is refused at rc 1 over four revisions
passes again at **rc 0 over one** — with the flag on, the environment variable set, and
`refs/replace` empty.

**Digest discipline.** Frozen before the digest was announced. Nothing added after the `sha256sum`
whose value appears in the delivering message; later findings go in
`P14-CHALLENGE-06cbc8f-ADDENDUM-01.md`, never by editing this file.

**My words, committed unedited.** `P14-CHALLENGE-c001cd9.md` at this head is 12,651 bytes /
`4708f1351a8c8c392557d1f6e4a3585278c477c408da0b211308ab6e69deae8f`, with a row that states both of
my findings against this thread.

| id | sev | finding |
|---|---|---|
| `R19-P0-01` | P0 | **Fail-open, same class as `R18-P0-01`, different mechanism.** `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS=1` do not disable **grafts**. Writing one line into `.git/info/grafts` — the forging commit with no parents — makes `git rev-list HEAD` answer **1** *with the flag on*, and the tool answers **rc 0**, *"checked over all 1 revision(s) … 1 of them found by the marker"*, no refusal, where it refused at rc 1 over 4 revisions a moment earlier. `GIT_GRAFT_FILE` pointing anywhere does the same with `.git/info/grafts` absent, so an existence check on that path is not the remedy either. Measured remedy: add **`GIT_GRAFT_FILE=os.devnull`** to the same `_env` → **0 → 1**, 4 revisions, `REFUSED` by name, and the real pack unchanged. |

---

## 1. `R18-P0-01` — closed, both arms, measured against the parent's tool

| world | `c001cd9` | `06cbc8f` |
|---|---|---|
| no replacement refs | 1, `REFUSED`, 4 revisions | 1, `REFUSED`, 4 revisions |
| 3 refs under `refs/replace` | **0**, no refusal, 1 revision | **1**, `REFUSED`, 4 revisions |
| same refs under `refs/other/`, `GIT_REPLACE_REF_BASE` set, `refs/replace` empty | **0**, no refusal, 1 revision | **1**, `REFUSED`, 4 revisions |
| the real pack | rc 0 | rc 0, unchanged |

The flag is on the helper before the subcommand, and `GIT_NO_REPLACE_OBJECTS=1` is in the child
environment, which is more than I asked for and is right. I added a third arm of my own:
`GIT_NO_REPLACE_OBJECTS=0` in the caller's environment — git treats the variable as *set* whatever
its value, so replacement is off and even the parent's tool refuses. Nothing to fix; worth knowing
before someone reads `=0` as "off".

The two new red proofs are honest ones. Each asserts, before requiring the refusal, that the ref
count is what the arm intends **and** that the tree git serves at the oldest revision *with*
replacement differs from the tree it serves with `--no-replace-objects`
(`git --no-replace-objects show <oldest>:<manifest> | sha256sum` against the replaced one), so a
world where replacement is not actually in effect prints `premise not built` instead of passing.
That is the shape I would have asked for.

## 2. `R19-P0-01` — the other way a repository dictates its own history

Grafts are git's older mechanism for rewriting parentage, and **`--no-replace-objects` has no effect
on them.** In the same world as §1, with every replace ref deleted:

    refs/replace: 0
    baseline, no graft              rc 1   "all 4 revision(s)"   REFUSED: P14-CHALLENGE-test.md
    echo <forging commit> > .git/info/grafts        # one line, no parents
    git rev-list HEAD                        -> 1
    git --no-replace-objects rev-list HEAD   -> 1        <-- the flag does not disable it
    06cbc8f                         rc 0   "checked over all 1 revision(s) … 1 of them found by the marker"   no refusal

The three honest revisions recording the true digest become unreachable, the forging commit is the
whole history, and the tool reports a clean check over it. `GIT_GRAFT_FILE` reaches the same state
with no file at the default path:

    rm .git/info/grafts ; GIT_GRAFT_FILE=.git/elsewhere-grafts
    git rev-list HEAD -> 1 ;  06cbc8f  rc 0, "all 1 revision(s)", no refusal

So, as with the replace arms, **a check is not the remedy**: neither "is `.git/info/grafts` absent"
nor "is `refs/replace` empty" is true in the second world, and the forgery still passes.

**Remedy, measured:** one more key in the same `_env`:

    _env = dict(os.environ, GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull)

| world | committed | patched |
|---|---|---|
| `.git/info/grafts` planted | **0**, no refusal, 1 revision | **1**, `REFUSED`, 4 revisions |
| `GIT_GRAFT_FILE` pointing elsewhere | **0**, no refusal, 1 revision | **1**, `REFUSED`, 4 revisions |
| no graft at all | 1, `REFUSED`, 4 | 1, `REFUSED`, 4 — unchanged |
| the real pack | rc 0, 26 revisions, 1 by the marker | rc 0, **identical** |

**Scope, measured rather than assumed.** `citation-provenance.py` has `--no-replace-objects` and no
graft control either, and its classification is history-derived — the same shape that moved between
clone depths in round 16. Measured in a fresh clone with the anchor and the merge-base fetched: rc
**0**, *block is current*; with one line in `.git/info/grafts`, rc **1**, `GENERATED
CITATION-PROVENANCE BLOCK IS STALE`. That direction is **fail-closed**, so it is not a second
fail-open — but the class reaches that tool too, and the one key closes both.
`retracted-claims.py` makes no git calls and is unaffected.

**The signal was in stderr all along, and is still not the remedy.** git 2.43 prints *"Support for
<GIT_DIR>/info/grafts is deprecated"* in both arms, and `_g` captures stderr and discards it. Reading
that hint would not do: `git -c advice.graftFileDeprecated=false rev-list HEAD` prints no hint and
still returns the truncated 1 commit (measured), the repository's own config can set that advice key,
and a future git removes the hint with the support. The environment variable is the remedy.

**And one thing not to do, which I measured so you do not have to.** The symmetric-looking move is to
add `GIT_SHALLOW_FILE=os.devnull` beside it. Do not: with that variable set,
`git rev-parse --is-shallow-repository` answers **true** on a full clone (the variable names a file
that exists), and the tool then refuses a sound repository with the shallow-boundary message — *"…
below it was never fetched and the oldest digest here need not be the first"*. Fail-closed, but
wrong, and it would retire a true verdict. Shallow is already handled by name and should be left
alone; the graft variable is the only one to add.

## 3. The invariant tripwire — it fires, and it cannot fire today

`if not _marker_revs <= set(_revmap)` is my own suggestion from round 18, implemented with a named
refusal. Two things measured:

* **It cannot fire at this head.** `_marker_revs` is `set(_gm.stdout.split())` and the loop
  immediately above `setdefault`s every element of that same split into `_revmap`, so the subset
  relation holds by construction. I tried breaking it from the other end — a copy that pops a marker
  revision out of `_revmap` right after seeding — and the refusal still did not fire, because the
  path-discovery loop puts that revision back. The assertion is unreachable, which is exactly what a
  regression tripwire over a structural invariant should be.
* **It fires correctly when the invariant is actually broken.** A copy that adds one revision to
  `_marker_revs` just before the check: *"NOT CHECKED (1 revision(s) the marker leg found are absent
  from the walked set, the first being 000000000000, so the count reported beside it would describe
  neither set)"*, rc 1. With the simulation off, the same copy is rc 1 with the ordinary refusal.

So the count's honesty now rests on a checked property rather than on a reading of the code, and the
two count proofs' tautology is no longer load-bearing. That item is closed.

## 4. `R18-P1-01` and the figures

Struck in place, enforced as row 25 of `tools/RETRACTED-CLAIMS.tsv`, and the rule is now stated the
way the measurement supports it: after-the-last-write is enough for digests, row counts and file
counts, and is not enough for a history-derived number. Amendment 24 quotes no count of the
manifest's own revisions, and the figure is given where it can be checked — a fresh clone of the
pushed head. I checked it there:

    git --no-replace-objects rev-list HEAD -- ':(top)…/P14-HANDOFF-MANIFEST.md' | wc -l   ->  26
    git --no-replace-objects log --no-renames -G '^# P14-HANDOFF-MANIFEST[.]md[[:space:]]*$' HEAD   ->  1
    refs/replace in that clone: 0

| gate | result |
|---|---|
| `manifest-digests.py --check`, both lanes | rc **0** — 59 artifact rows + the manifest, 59 files, 26 revisions, **1** found by the marker |
| `gate-sweep.sh`, 4 working directories | rc **0** — **69 ok / 0 FAIL** (67 at the parent); `replace-refs-refused` and `replace-refs-off-base-refused` both ok |
| `retracted-claims.py --check` | rc **0** — 25 claims across 34 documents, 27 reviewer reports exempt in code |
| `citation-provenance.py --check` | rc **0** once the anchor is fetched by its full object name; rc **2** `CONFIGURATION ERROR` before that, which is the declared fail-closed precondition and not a finding |

## 5. Repository gates

`npm ci` first, then the readings in the order printed, in one clone that had never been built. Node
**v24.21.0 / npm 11.19.0**. The cold state is a fresh clone plus `npm ci` and nothing else — **no
`dist` directory exists anywhere in the tree**, so nothing was removed to produce it; the *after
build* rows are the same clone immediately after `npm run build`, in the order shown.

| reading | `/tmp/g36` `06cbc8f` | `c001cd9` (round 18) | `6fc505d` merge-base |
|---|---|---|---|
| `npm ci` | 0 | 0 | 0 |
| `npm run format` | **0** | 0 | 0 |
| `npm run lint` — cold | 1 (`4220 problems`) | 1 (`4220 problems`) | 1 |
| `npm run typecheck` — cold | 2 | 2 | 2 |
| `npm run build` — first | 1 | 1 | 1 |
| `npm run build` — second | **0** | 0 | 0 |
| `npm run lint` — after build | **0** | 0 | 0 |
| `npm run typecheck` — after build | **0** | 0 | 0 |
| `npm run format` — after build | **0** | 0 | — |

## 6. Signature, withheld

**I do not sign `06cbc8ff66dc46d768caf9b39ea4451ba4228d36`.** One fail-open (`R19-P0-01`), in the
same class as the one this commit closed and reachable with one line in a file git still reads.

What I will stand behind at a head that closes it: §1's four rows at both heads and the two new
proofs' premises, §3's two measurements of the tripwire, and §4's four pack gates with the figures
re-measured in a fresh clone of the pushed head.

**The parents branch** stays where round 17 left it: reasoned, not witnessed, five constructions
between us, fails closed, signed by neither of us.

**Restated, unchanged since round 4:** nothing in this lane has landed on Phase 14's
**architecture**, which is unexecuted — no API, no DDL, no route, no CI job. Nineteen rounds have
measured the pack's own tooling and prose. None of it is credit against the first review of an
executed Phase 14.

**What I did not do.** No file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; no history was rewritten and nothing was force-pushed.
The patched tool and the three test copies are copies under `/tmp/w21` and were never written into
the pack. The replace refs and the graft files exist only in `/tmp/t25`, scratch repositories I
created; none was created in any clone of this branch, and the clone this round was measured in
carries neither. No `--write` was run against the pack or the shared folder. This report has no
manifest row yet, so the shared-folder lane will read `ARTIFACT WITH NO ROW` until the author writes
one.
