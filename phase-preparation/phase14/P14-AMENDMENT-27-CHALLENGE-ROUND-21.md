# Phase 14 — amendment 27: challenge round 21 answered

**Subject reviewed:** `0332d1b0f11ec1b65cea58dfee3d4b7aed9d0226`.
**Verdict received:** REJECT — not on the code, which the reviewer verified complete, but on the
**proof** that was supposed to hold one direction of it, and on one sentence of amendment 26.
**Reviewer's words:** `P14-CHALLENGE-0332d1b.md` (15,546 bytes,
`019daf2257e941ffaf9b20101d91fe4b5b32810e28adfeac0cb2e6b499f9744d`), committed unedited and
hashed from the file on disk.

This amendment is the ONE commit owed. Phase 14 remains **PREPARED / NOT PROMOTED** and has
**no signed head at any SHA**.

## 1. `R21-P1-01` — a FALSE MEASURED CLAIM, conceded, and it was my strongest-sounding sentence

`REFUSED: <report>` is the **header** every refusal about that report prints; the reason is in the
`STALE:` line beneath it. Both round-20 arms keyed on that header, so one of them passed **with the
guard removed**. The reviewer measured it with the scrub reverted and nothing else changed: my own
sweep printed exactly **one** FAIL — `git-dir-decoy-refused` at rc 0 — while
`git-dir-relative-refused` stayed `ok`, refusing for reasons that have nothing to do with the
forgery (`NO WITNESS …` and `HISTORY NOT VERIFIED … the manifest is not in a git repository here`).

I reproduced that before changing anything, and then ran the stronger test the pack has been
asking of itself since round 16: a **guard-deletion run of the whole sweep**, from a copy of the
pack with only the `GIT_*` scrub reverted. All three GIT arms now print FAIL at rc 0:

    FAIL  git-dir-decoy-refused          rc=0 (required 1) …
    FAIL  git-dir-in-pack-decoy-refused  rc=0 (required 1) …
    FAIL  git-binary-shim-refused        rc=0 (required 1) …

Both GIT_DIR arms now require **`REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md`**, the
refusal that is about the forgery. The other four proofs that key on the header
(`replace-refs-refused`, `replace-refs-off-base-refused`, both `graft-*-refused`) are sound as the
reviewer says, because each of their broken states is rc 0 with **no refusal at all** — measured in
round 19 for the replace pair and round 20 for the graft pair — but the lesson is the general one:
a required message must name the law, not the subject.

## 2. `R21-P1-02` — conceded, and the corrected arm is a stronger attack than the one I wrote

A relative `GIT_DIR` resolves against the directory `-C` moved to, **not** the caller's working
directory. The reviewer measured it with two repositories so it could not be read two ways. So the
old arm asserted `/tmp/.git` does not exist — a path that does not decide it.

Because resolution is against the manifest's own directory, the decoy can sit **inside the pack**,
which makes the redirection **repository-supplied** rather than caller-supplied. Measured, with a
decoy repository at `<pack>/decoy.git` and `GIT_DIR=decoy.git`:

| | `0332d1b` | with the scrub deleted |
|---|---|---|
| `GIT_DIR=decoy.git` (in-pack) | rc 1, the ROW refusal, 4 revisions | **rc 0, no refusal, 3 revisions** |

The arm is rebuilt in that form as `git-dir-in-pack-decoy-refused`, with arm one's premise: the
decoy's walk (3) differs from the pack repository's walk (4), both read from git before the tool
runs.

## 3. `R21-P2-01` — PATH: fixed, with the reason recorded so round 22 does not re-find it

Ruled a P2 by the reviewer and left to me; the coordinator ruled to apply the measured remedy. I
agree, and the reason is the one that decided it: **this environment is already built rather than
inherited, so the git binary is one more key in a dict that exists.** `python3 -I` already stops the
caller's environment supplying the tool's PYTHON while the same environment supplied its GIT, which
is an asymmetry with no defence behind it.

Measured, with a two-line shim earlier on `PATH` that execs the real git with `--git-dir` at the
decoy:

| | no shim | shim first on `PATH` |
|---|---|---|
| `0332d1b` | rc 1, ROW refusal, 4 revisions | **rc 0, no refusal, 3 revisions** |
| this head (PATH pinned in the built environment) | rc 1, ROW refusal, 4 | rc 1, ROW refusal, 4 |

`PATH` is pinned to `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` in both git-using
tools; git is `/usr/bin/git` here, and the real pack is unchanged under it. Red proof:
`git-binary-shim-refused`, whose premise is that the walk git serves **through the shim** differs
from the pack repository's.

The reviewer's argument against calling it a P0 is recorded because it is true: whoever sets `PATH`
chose the `python3` too, so unlike `GIT_DIR` it is not something an honest unrelated step exports by
accident. That is why it is a P2 and not a fail-open — and why it is fixed anyway.

## 4. `R21-P3-01` — the verdict now carries its provenance

It earns its lines, and the argument is the reviewer's: *this is exactly what made `R20-P0-01`
invisible* — "27 revisions" and "26 revisions" were the same exit code and the same sentence one
number apart, with nothing saying which repository had been read. Every `--check` run now prints,
before the summary:

    read: repository <toplevel>; git directory <absolute git dir>; git version <v> at <path>

so `R20-P0-01` (which repository), `R21-P2-01` (which binary) and the `--manifest` question below
are answered in the output instead of in the environment. A run with no repository at all says so
by name rather than leaving the field blank.

## 5. What the reviewer closed and bounded, recorded as theirs

* **`R20-P0-01` closed in both directions**, with the scrub measured as the single variable, and the
  sibling tool measured going from a safe wrong answer to the right one under a decoy `GIT_DIR`
  (rc 2 `CONFIGURATION ERROR` at `911f2b1` → rc 0 at `0332d1b`). Every figure in amendment 26
  reproduces with the command it names.
* **Attacked with no effect**, on the subject in the same forged world, the row refusal holding
  throughout: `HOME`/`XDG_CONFIG_HOME` pointed at a gitconfig the judged side writes (`quotePath`,
  `advice.graftFileDeprecated`, `safe.directory=*`), `LC_ALL=C`, `LC_ALL`/`LANG=tr_TR.UTF-8`,
  `TZ=Pacific/Kiritimati`, `PAGER=/bin/false`.
* **UNMEASURED and named by them**, not a pass: the translated-git leg. git's message catalogues are
  not installed in this container (`locale -a` lists only `en_US.utf8`), so their statement that
  every decision reads an exit code, a list of object names or the literal `true` is a reading of
  the code rather than a measurement.
* **Not a defect, recorded as the signature's scope:** `--manifest` pointed into the decoy, with the
  files of the forged world, answers rc 0 over the decoy's three revisions — correctly, because that
  manifest really is in that repository. This gate verifies the pack at the path it is given, in the
  repository that path lives in; the sweep passes the pack's own path. It is also the reason the
  provenance line in §4 matters.
* The parents branch is unchanged, with no new construction from either of us. `GIT_EXEC_PATH`
  remains unmeasured and named. Their standing residual stands: **CI has never run a Phase 14 SHA,
  and no workflow in this tree runs this pack's gates at all.**

## 6. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in a
fresh clone of the pushed head and reported to the reviewers.

* `tools/gate-sweep.sh` — rc 0, **74 ok**, `0 gate(s)/proof(s) not as required`, from four working
  directories, with the cluster up. 73 at `0332d1b`: `git-dir-relative-refused` is replaced by
  `git-dir-in-pack-decoy-refused` and `git-binary-shim-refused` is added.
* `tools/manifest-digests.py --check` — rc 0 in both lanes, 65 artifact rows + the manifest,
  65 files, **1 revision found by the marker**.
* `tools/citation-provenance.py` — rc 0, with `PATH` pinned in its built environment too.
* `tools/retracted-claims.py` — rc 0, 26 claims across 37 pack documents.
* repository `npm run format` — rc 0.
