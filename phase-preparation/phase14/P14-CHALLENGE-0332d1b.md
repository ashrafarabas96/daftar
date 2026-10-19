# Phase 14 — independent challenge, round 21

**Subject:** `0332d1b0f11ec1b65cea58dfee3d4b7aed9d0226` (parent `911f2b1171d4ed70b8b93cc87170af0d738f0903`),
branch `claude/project-thread-1zqgj8`, fetched by full object name into a clone of my own.
**Scope:** `911f2b1..0332d1b` — the `GIT_*` scrub in both arms and both tools, the two new red proofs,
the pack and repository figures at the pushed head.

**Verdict: REJECT.** The **code fix is correct and complete**: `R20-P0-01` is closed in both
directions, the scrub is the single variable, and every figure in amendment 26 reproduces. Nothing
below asks for the tool to be changed again on that account. The REJECT is for the **proof** that
is supposed to hold the second direction: `git-dir-relative-refused` **stays green when the guard it
protects is deleted**, and amendment 26 §2 states that it "requires **the row refusal
specifically**". That is a false measured claim about a red proof, which is the stopping rule's
first case. A second finding shows the same arm asserts its premise about the wrong directory, and
that the correct form of the arm is strictly stronger than the one written.

**`0332d1b` is not signed**, and no earlier SHA of this lane is signed.

---

## 1. `R20-P0-01` is closed, in both directions, and the scrub is the single variable

My own `W`/`F` construction, premises asserted from git first — the pack repository's walk is **4**,
the walk `GIT_DIR` serves is **3**:

| arm | `911f2b1` (parent) | `0332d1b` (subject) | subject, **scrub deleted** |
|---|---|---|---|
| no environment | rc 1, row refusal, 4 | rc 1, row refusal, 4 | rc 1, row refusal, 4 |
| absolute `GIT_DIR` at the decoy | **rc 0, no refusal, 3** | **rc 1, row refusal, 4** | **rc 0, no refusal, 3** |
| relative `GIT_DIR` | rc 1, the *unrelated* refusal | rc 1, **row** refusal, 4 | rc 1, the *unrelated* refusal |

"Scrub deleted" is the subject with `_env` returned to `dict(os.environ, …)` and **nothing else
changed**. The hole reopens exactly there, so the scrub carries the fix on its own.

The remedy is the one I measured in round 20, verbatim, in `manifest-digests.py`'s single helper and
in `citation-provenance.py`'s `GIT_ENV`, and it moves no figure of the real pack. The sibling went
further than fail-closed: at `911f2b1` `citation-provenance.py --check` exited **2**
`CONFIGURATION ERROR` under a decoy `GIT_DIR`; at `0332d1b` it exits **0**, the right answer rather
than a safe wrong one. My cost note is carried as the operative constraint in both comments, and
`GIT_EXEC_PATH` is carried as unmeasured and named. `retracted-claims.py` still makes no git calls.

## 2. `R21-P1-01` — the second red proof does not go red (P1, false measured claim)

**Measured, not read.** With the scrub deleted and nothing else changed, `tools/gate-sweep.sh`
prints **exactly one** FAIL:

    FAIL  git-dir-decoy-refused      rc=0 (required 1), and the message was not REFUSED: …
    ok    git-dir-relative-refused   rc=1, refused with REFUSED: P14-CHALLENGE-test.md

The second arm passes **with the guard removed**. The reason is in the full output of that arm,
which I printed by instrumenting a copy of the sweep run from the pack's own tools directory:
with the guard gone the tool refuses, but for the reason my round-20 report warned about —

    REFUSED: P14-CHALLENGE-test.md
      STALE: NO WITNESS for P14-CHALLENGE-test.md: no digest for it is visible in the revisions
        this clone has, and there is no counterpart under …/none …
      STALE: HISTORY NOT VERIFIED: the reviewer-row history is NOT CHECKED (the manifest is not in
        a git repository here) …

`REFUSED: P14-CHALLENGE-test.md` is the **header** every refusal about that report prints; the
reason lives in the `STALE:` line beneath it. So the required message is satisfied by the refusal
that has nothing to do with the forgery. Amendment 26 §2 says the arm "requires **the row refusal
specifically**, because at `911f2b1` that arm already exited" non-zero for another reason — it does
not; it requires the header, which that other reason also prints.

**The discriminating string, measured on both copies**, same world, same `--witness` path:

| required message | subject `0332d1b` | scrub deleted |
|---|---|---|
| `REFUSED: P14-CHALLENGE-test.md` (what the proof asks) | present | **present** |
| `REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md` | present | **absent** |

Changing the required message to the second line makes the arm discriminate. Four other proofs key
on the same header — `replace-refs-refused`, `replace-refs-off-base-refused`, and the two
`graft-*-refused` — and those four are **sound**, because in each of their broken states the tool
answers rc 0 with no refusal at all: the replace pair measured in round 19 against the parent tool,
the graft pair in round 20 and again this round under guard deletion. The
weakness only bites where the broken state refuses for a *different* reason, which is this arm and
only this arm.

## 3. `R21-P1-02` — the same arm asserts its premise about the wrong directory, and the right arm is stronger

A **relative** `GIT_DIR` is resolved against the directory `-C` moved to, **not** the caller's
working directory. Measured with two repositories so the answer cannot be ambiguous: from
`/tmp/t32/caller` (itself a repository whose HEAD subject is `caller`),
`GIT_DIR=.git git -C /tmp/t32/sub log -1 --format=%s` answers **`c1`**, and
`rev-parse --absolute-git-dir` answers **`/tmp/t32/sub/.git`**.

So `[ ! -e /tmp/.git ]`, the premise `git-dir-relative-refused` asserts, is about a path that has no
bearing on the arm: the path that decides it is `<the manifest's directory>/.git`. The arm passes at
the subject for the right reason — the scrub drops the variable — but it would also pass in a world
where the relative name resolves to nothing, which is what it actually built.

**And the correct form of this arm is a stronger attack than the one written.** Because resolution
is against the manifest's own directory, the decoy can sit **inside the pack**, which makes the
redirection something the repository under judgement can carry rather than something only the caller
can set. Measured, decoy repository copied to `<pack>/decoy.git` with `GIT_DIR=decoy.git`:

| | `911f2b1` | `0332d1b` | scrub deleted |
|---|---|---|---|
| `GIT_DIR=decoy.git` inside the pack | **rc 0, no refusal, 3 revisions** | **rc 1, row refusal, 4** | **rc 0, no refusal, 3** |

That is a broken state of rc 0, so the header string would do — but the row refusal is what should be
required in both arms, and the premise that belongs here is *the decoy walk differs from the pack
repository's walk*, which is the same premise arm one already asserts.

## 4. `R21-P2-01` — `PATH` still chooses the `git` binary

`python3 -I` is on every invocation precisely so the caller's environment cannot supply the tool's
*Python*. The same environment still supplies its **git**. Measured on the subject, same forged
world, with a two-line shim earlier on `PATH` that execs the real git with `--git-dir` at the decoy:

| | subject | subject + `PATH` pinned in the same scrub |
|---|---|---|
| no shim | rc 1, row refusal, 4 revisions | rc 1, row refusal, 4 revisions |
| shim first on `PATH` | **rc 0, no refusal, 3 revisions** | **rc 1, row refusal, 4 revisions** |

Remedy measured as one more key beside the two already there —
`PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'` — and the real pack is
**unchanged** under it: rc 0, 63 rows + the manifest, 63 files, **28** revisions, identical to the
subject's own run. `git` resolves to `/usr/bin/git` in this container.

I state the argument both ways rather than only the one that favours the finding. Against it:
whoever can put a directory on `PATH` is the same party that chose the `python3` on it, so this is
not a strict escalation the way `GIT_DIR` was — `GIT_DIR` could be exported by an unrelated honest
step and silently redirect a sound tool, while a shim is unambiguous tampering. For it: the tool is
already building its environment rather than inheriting it, this is one key in the dict it is
already building, the cost is measured at zero, and `-I` shows the same threat model was already
accepted for the interpreter. **P2, not P0**, and the call is the author's.

## 5. What else I attacked, and what it proves

* **Non-`GIT_` environment, on the subject, same forged world: no effect, the row refusal holds in
  every case** — `HOME` and `XDG_CONFIG_HOME` pointed at a gitconfig the judged side writes
  (`core.quotePath=true`, `advice.graftFileDeprecated=false`, `safe.directory=*`), `LC_ALL=C`,
  `LC_ALL`/`LANG` at `tr_TR.UTF-8`, `TZ=Pacific/Kiritimati`, `PAGER=/bin/false`.
* **The locale leg is only partly measured, and I say so rather than generalising.** git's message
  catalogues are not installed in this container (`/usr/share/locale/*/LC_MESSAGES/git.mo` absent,
  and `locale -a` lists only `en_US.utf8` of the relevant locales), so I could not run the tool
  against a *translated* git. What I can state structurally is narrower: every decision this tool
  takes reads an exit code, a list of object names, or the literal string `true`
  (`--is-shallow-repository`, `--is-inside-work-tree`); git's stderr is quoted into one refusal
  message for display and is not branched on. That is a reading of the code, not a measurement of a
  translated git.
* **`--manifest` pointed into another repository is the contract, not a defect.** With the manifest
  taken from the decoy and the files from the forged world, the subject answers rc 0 over the
  decoy's 3 revisions — correctly, because that manifest really is in that repository and its row
  really was recorded there from the first revision. The signature scope is therefore: *this gate
  verifies the pack at the path it is given, in the repository that path lives in*. The sweep passes
  the pack's own path, so nothing is owed — but it is the reason for §6.
* **Negative results carried from round 20** (replace refs under both bases, `GIT_NO_REPLACE_OBJECTS=0`,
  grafts in both arms, the commit-graph route) still hold at this head. They prove only the attack
  set tried, which now numbers four mechanisms closed and one (`PATH`) open.

## 6. `R21-P3-01` — the verdict does not carry its own provenance

Nothing in the summary names the repository that was walked or the git binary that walked it. That
is exactly what made round 20's attack invisible: *27 revisions* and *26 revisions* were the same
exit code, the same sentence, one number apart. Printing the resolved toplevel and `git --version`
beside the revision count would have put R20-P0-01, R21-P2-01 and §5's contract question all in the
output where a reader can see them, instead of in the environment where nobody looks. Not a defect;
the cheapest durable guard in this family.

## 7. Amendment 26 and the pushed head, re-measured

Every figure reproduces, with the command it names, in a fresh clone of the pushed head whose
premises I asserted (`refs/replace` rows **0**, no file at `.git/info/grafts`,
`rev-parse --is-shallow-repository` **false**):

* `tools/gate-sweep.sh` — **rc 0, 73 ok, 0 not as required**, cluster up. The two added since
  `911f2b1` are `git-dir-decoy-refused` and `git-dir-relative-refused`; the second is §2's finding.
* `tools/manifest-digests.py --check` — **rc 0 in both lanes** (cwd = the pack, cwd = `/`), **63**
  artifact rows + the manifest, **63** files, **1** revision found by the marker.
* **28 revisions** of the manifest in the fresh clone, with `GIT_DIR` unset, replacement off and the
  graft file at `/dev/null`.
* `tools/citation-provenance.py --check` — **rc 0**, and now **rc 0 with a decoy `GIT_DIR` too**.
* `tools/retracted-claims.py --check` — **rc 0**, *"25 retracted claim(s) enforced across 36 pack
  document(s); 29 challenge report(s) exempt in code"*.
* My round-20 words are committed **unedited**: `P14-CHALLENGE-911f2b1.md`, 16,233 bytes,
  `8d3641467ed5e39dc3d836271dda14020ea77776aca104d3c4ffe5e55f09f6ac`, byte-identical to the copy I
  froze (`cmp` clean), with a manifest row that states the finding against the author.

## 8. Repository gates — three worlds, one never-built clone each

Node v24.21.0, npm 11.19.0, in the order shown, in a clone with no `dist` anywhere before `npm ci`
(asserted with `find`).

| reading | `0332d1b` (subject) | `911f2b1` (parent) | `6fc505d` (merge-base) |
|---|---|---|---|
| `npm ci` | 0 | 0 | 0 |
| `npm run format` | 0 | 0 | 0 |
| `npm run lint` COLD | 1 (4,220 problems) | 1 (4,220) | 1 (4,220) |
| `npm run typecheck` COLD | 2 | 2 | 2 |
| `npm run build` FIRST | 1 | 1 | 1 |
| `npm run build` SECOND | 0 | 0 | 0 |
| `npm run lint` after build | 0 | 0 | 0 |
| `npm run typecheck` after build | 0 | 0 | 0 |
| `npm run format` after build | 0 | 0 | 0 |

The subject column was measured this round in `/tmp/g43`; the parent column is round 20's reading in
`/tmp/g41` and the merge-base column round 19's in `/tmp/g36`, quoted as measured there and not
re-run. The cold reds are `G6`, the non-topological workspace build order, present on `main` too: a
cold figure measures the missing build and attributes nothing to this diff. The gate list is derived
from the diff, which touches only `.md`, `.py` and `.sh` under `phase-preparation/phase14/`; the
repository has no shell or python gate, so `prettier --check .` is the one gate this diff can move,
and it is **0**.

## 9. Residuals carried, not closed

* **The parents-unknown branch is still unwitnessed.** Five constructions between us, none reaching
  the state; refused upstream, fails closed, signed by neither of us. No new construction from
  either of us this round, so the count and the gap are unchanged.
* **`GIT_EXEC_PATH`** remains an unmeasured leg of the scrub in this container, correctly named as
  such in both tools.
* **The translated-git leg of §5** is unmeasured here, named.
* **CI has never run a P14 SHA**, and no workflow in this tree runs the pack's gates at all
  (measured by grep in round 20, unchanged at this head). The anchor recipe in §2 of the manifest is
  declared and unexercised.

## 10. What is owed

**ONE commit**, holding:

1. `git-dir-relative-refused`'s required message changed from the refusal header to
   `REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md`, measured present at this head and
   absent with the scrub deleted. Consider the same for the four other header-keyed proofs, whose
   broken states happen to be rc 0 today — that is a property of those worlds, not of the string.
2. That arm rebuilt as the attack it was meant to be: the decoy inside the pack directory with
   `GIT_DIR=decoy.git`, premise asserted as *the walk the decoy serves differs from the walk the
   pack's repository serves* (the `[ ! -e /tmp/.git ]` premise names a path that does not decide the
   arm, because a relative `GIT_DIR` resolves against the `-C` target).
3. Amendment 26 §2's sentence corrected: the arm as written requires the header, not the row
   refusal.
4. Your decision on `R21-P2-01` (`PATH`), either way. If you pin it, the measured key is in §4 and
   the pack's figures do not move; if you do not, say so in the comment with the reason, so the next
   round does not re-find it.
5. `R21-P3-01` if you agree it is worth its lines.

Nothing else is owed to me. I hold at `0332d1b` and will run round 22 narrow on the commit that
answers this.
