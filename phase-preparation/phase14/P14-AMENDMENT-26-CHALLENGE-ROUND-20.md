# Phase 14 — amendment 26: challenge round 20 answered

**Subject reviewed:** `911f2b1171d4ed70b8b93cc87170af0d738f0903`.
**Verdict received:** REJECT. One P0 fail-open, the same class a **third** mechanism along.
**Reviewer's words:** `P14-CHALLENGE-911f2b1.md` (16,233 bytes,
`8d3641467ed5e39dc3d836271dda14020ea77776aca104d3c4ffe5e55f09f6ac`), committed unedited and
hashed from the file on disk.

This amendment is the ONE commit owed. Phase 14 remains **PREPARED / NOT PROMOTED** and has
**no signed head at any SHA**.

## 1. `R20-P0-01` — a FAIL-OPEN, conceded, reproduced here before it was fixed

The helper built its environment as `dict(os.environ, …)`, which takes the caller's environment
**verbatim** — and `GIT_DIR` is in it. **`GIT_DIR` beats `-C`**, so the repository this tool
believed it was reading was caller-supplied, after two rounds spent making sure the *history*
inside a repository could not be.

Measured in my own container. World **W**: three honest revisions plus the forgery committed as the
fourth. World **F**: a separate repository whose three revisions all already carry the forged digest
at the same relative path. The files on disk are W's in both arms.

| arm | `911f2b1` | this head |
|---|---|---|
| no environment set | rc 1, `REFUSED: P14-CHALLENGE-test.md`, 4 revisions | rc 1, identical |
| `GIT_DIR` = F's git directory | **rc 0, no refusal, "all 3 revision(s)"** | **rc 1, REFUSED, 4 revisions** |
| a RELATIVE `GIT_DIR` | rc 1, but the wrong refusal (*not in a git repository*) | rc 1, the **row** refusal, 4 revisions |
| the REAL pack, `GIT_DIR` at a clone of this repository one head back | **rc 1, "all 26 revision(s)"** | rc 1, **"all 27 revision(s)"** |

The last row is the one worth reading twice: against the real pack, the published revision count
moved to the previous head's figure with the same exit code and the same sentence shape, and
nothing in the output said which repository had been read.

**The remedy is to BUILD the environment rather than inherit it:**

    _env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    _env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull)

Measured against the real pack, the scrub moves **no** figure: 61 rows + the manifest, 61 files,
27 revisions, 1 of them found by the marker, and the count is now pinned at 27 **in both arms**,
redirected or not.

**Two red proofs, one per direction.** `git-dir-decoy-refused` builds W and the decoy, asserts from
git that the pack repository's walk is 4 and the walk `GIT_DIR` serves is 3 — different, so the
redirection is really in effect — and then requires the row refusal. `git-dir-relative-refused`
uses a relative `GIT_DIR` resolved against the caller's working directory, asserts that nothing is
there, and requires **the row refusal specifically**, because at `911f2b1` that arm already exited
non-zero for a reason that had nothing to do with the forgery. A refusal naming a cause that is not
the cause is a defect this pack has named eight times; it is not acceptable as a defence.

**One cost, measured, stated rather than discovered later.** This container exports **eleven**
`GIT_*` variables, among them `GIT_CONFIG_COUNT=3` (a `url.insteadOf` rewrite and
`credential.interactive=false`) and `GIT_SSL_CAINFO` pointing at the proxy CA bundle. The scrub is
safe **inside this helper** because every git call of the tool is a local read, and the pack is
measured unchanged. It is deliberately **not** exported to `tools/gate-sweep.sh` or to any CI step:
those **fetch**, and they need `GIT_SSL_CAINFO` and the migration-freeze anchor's full-object-name
fetch. `GIT_EXEC_PATH` is not set in this container, so whether dropping it matters is
**UNMEASURED**, named here, and not a pass.

## 2. Scope, measured in both directions

`tools/citation-provenance.py` is `GIT_DIR`-sensitive too, and the reviewer measured it
**fail-closed**: rc 2 `CONFIGURATION ERROR`, both against a decoy clone and against an unrelated
repository. Not a second fail-open — and the same scrub is in that tool in this commit, which is
round 18's rule for the **third** round running. `tools/retracted-claims.py` is unaffected and
makes no git calls.

The reviewer also swept the rest of the namespace against this tool, and the results belong here
because they bound what is left: `GIT_OBJECT_DIRECTORY` and `GIT_COMMON_DIR` fail **closed**
(rc 1 `NOT CHECKED` plus `STALE: HISTORY NOT VERIFIED`); `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES` and `GIT_CONFIG_*` forcing
`core.quotePath=true` have **no** effect, because the `-c` on the command line wins; and `HOME` or
`XDG_CONFIG_HOME` redirected to a gitconfig the judged side writes (`quotePath`,
`advice.graftFileDeprecated`, `safe.directory=*`) is not a vector. The scrub closes the class
rather than the one name, which is why it is the remedy even where the individual variable was
harmless.

One negative result of theirs, recorded because it is the next mechanism someone reaches for: a
commit-graph cannot carry a graft's truncation — with a graft in effect
`git commit-graph write --reachable` writes no graph at all. That proves the attack set they tried,
not the absence of a fourth mechanism.

## 3. What the reviewer closed, recorded as theirs

* **`R19-P0-01` closed, and rebuilt rather than read.** Both graft arms with premises asserted from
  git: `06cbc8f` rc 0 with no refusal over one revision, this branch rc 1 with the row refusal and
  `STALE: REVIEWER ROW REWRITTEN` over four. They then read the guard by **name**: a copy with only
  `GIT_GRAFT_FILE` removed from the helper answers rc 0 in both arms and, run through my own sweep,
  prints exactly two FAILs — `graft-default-refused` and `graft-elsewhere-refused`. So those proofs
  are not tautologies, which is the question I had asked about the count proofs in round 18 and had
  no answer for about these.
* They verified `GIT_SHALLOW_FILE` appears in no non-comment line of any tool and that a fresh
  clone answers `is-shallow false`; and that the graft key reached the sibling — two subprocess
  sites in `citation-provenance.py`, both carrying the built environment, including the
  `--show-toplevel` read, and exactly one site in `manifest-digests.py`.
* They re-measured every figure of amendment 25 with the command it names, and reported one of mine
  back more precisely: the sweep is 71 ok with the cluster up and **63** with `--no-db`, the eight
  DB gates being the difference.
* Gate list derived from the diff, their words: it touches only `.md`, `.py` and `.sh` under the
  pack, the repository has no shell or python gate, so `prettier --check .` is the one repository
  gate this diff can move, and it is rc 0. All five repository gates in a never-built clone, cold
  and after a build, are identical to `06cbc8f` and to the merge-base; the cold reds are `G6` and
  are no attribution to this diff.
* The parents branch is unchanged, with no new construction this round: five constructions between
  us, none reaching the state, fails closed, signed by neither of us.
* Their standing residual, measured by grep rather than assumed: **CI has never run a Phase 14 SHA,
  and no workflow in this tree runs this pack's gates at all**, which is why the CI direction of
  the scrub is stated as a class and not as something reachable today.

## 4. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in
a fresh clone of the pushed head and reported to the reviewers.

* `tools/gate-sweep.sh` — rc 0, **73 ok**, `0 gate(s)/proof(s) not as required`, from four working
  directories, with the cluster up. 71 at `911f2b1`; the two added are `git-dir-decoy-refused` and
  `git-dir-relative-refused`.
* `tools/manifest-digests.py --check` — rc 0 in both lanes, 63 artifact rows + the manifest,
  63 files, **1 revision found by the marker**.
* `tools/citation-provenance.py` — rc 0, with the same built environment.
* `tools/retracted-claims.py` — rc 0, 25 claims across 36 pack documents.
* repository `npm run format` — rc 0.
