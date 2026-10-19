# Phase 14 — amendment 29: challenge round 23 answered, and `2091119` signed on all three links

**Subject reviewed:** `2091119b1c02dd3bd8d8e47226336f9359de7fdc`.
**Challenger's verdict:** **PASS-WITH-SCOPE** — the first non-REJECT of this lane, after twelve
consecutive rejections.
**Challenger's words:** `P14-CHALLENGE-2091119.md` (13,217 bytes,
`e84b7bfc02da07cb1e54f54216e6881f67cd2c5e1a086d733a8a7b7dbd79afc3`).
**Coordinator's actual-diff verdict:** **SIGN** of the same SHA.
**Coordinator's words:** `P14-COORD-DIFF-REVIEW-2091119.md` (16,860 bytes,
`9da17e973d86c0aade72b51aa030a1eb99c9302dbde557ec2b150b423eed27bc`).
Both committed unedited and hashed from the files on disk.

**What that signature is, in the challenger's own scope and not a word wider.** It covers
`2091119` and nothing else, with five files pinned by digest:
`P14-HANDOFF-MANIFEST.md` `dd9083ab…` 86,988 B; `tools/manifest-digests.py` `91a3a60f…`
66,099 B; `tools/citation-provenance.py` `afe8d0b9…` 31,274 B; `tools/gate-sweep.sh`
`5d5bd06d…` 93,710 B; `tools/RETRACTED-CLAIMS.tsv` `9fd1d35b…` 11,423 B. I re-verified all five
from a fresh clone of the pushed head and all five match. It is **NOT a promotion**, **NOT** a
statement that Phase 14 is complete, and **NOT** a statement about CI, which has never run a
Phase 14 SHA. **This head is not that SHA**, so it carries no part of that signature: Phase 14 is
**PREPARED / NOT PROMOTED**, and `2091119` is the signed SHA, not this one.

This amendment is the ONE commit the coordinator authorised after its review returned: the three
items below, batched, and nothing else.

## 1. `R23-P2-01` — the reviewer's own finding against the remedy it had just recommended

`_GIT_BIN` is resolved **once at import** and used later. If the resolved executable cannot be run
at the moment of the call — removed, `chmod`'d, or never runnable because its interpreter is
missing — `subprocess.run` raised `FileNotFoundError` and the tool died with an **unnamed
traceback at rc 1**, which is this gate's **STALE** code: the exact failure shape `R22-P2-01`
closed one round earlier, and one a bare name would have survived by falling through to the next
candidate on the path. The coordinator measured it a **P3** rather than a P2, for reasons I adopt
rather than argue: it fails closed, it never produces a green verdict, and `--write` never changes
the manifest.

The call is wrapped in both tools and the refusal is the configuration one, by name:

    except (FileNotFoundError, PermissionError, OSError) as exc:
        _refuse_unrunnable_git(exc)

`CONFIGURATION ERROR: the \`git\` executable resolved on the pinned PATH (…) at start-up could not
be run (FileNotFoundError: …), so no history could be read and nothing here is a verdict about
this manifest.` — and the sibling says the same about its own block.

**Its arm needs no timing window and no system write**, which is why it is shipped where the
in-pinned-set arm is not: `git-binary-unrunnable-refused` puts, on the pinned path, an executable
script whose **shebang names an interpreter that does not exist**. `shutil.which` selects it
(it is a regular executable file) and `exec` of it fails, deterministically, in a temporary
directory. Premise asserted before the arm runs: `which` selected that exact file, and running it
directly exits non-zero.

## 2. `R-COORD-1` — the coordinator's finding: a named refusal in the sibling with no arm

Deleting `tools/citation-provenance.py`'s own `CONFIGURATION ERROR` block for an absent git **red
nothing**. The refusal existed, was correct, and was unmeasured — which is the same defect class as
round 21's header-keyed proof, one file along. `sibling-no-git-refused` is the arm, run against the
**sibling's own sentence** rather than the other tool's, with the premise that the empty pinned
path holds no git and that the shipped pin appears verbatim once in that tool.

**Guard-deletion, read by NAME, one deletion per copy**, four copies of this pack inside a clone of
the branch, baseline included:

| the one thing deleted | arms that go FAIL beyond the baseline |
|---|---|
| nothing (baseline) | — |
| the `try/except` around the digest tool's git call | `git-binary-unrunnable-refused` — rc 1 with the traceback where 2 is required |
| the sibling's `CONFIGURATION ERROR` block | `sibling-no-git-refused` — rc 1 with the traceback where 2 is required |

Each new arm reds on its own deletion and on no other.

## 3. Amendment 28 §4's sentence, reworded in place, and in my favour

I had written that the absolute resolution is a guard whose arm is missing. The reviewer measured
why nothing reds rather than accepting that framing: `_GIT_BIN` and `'git'` resolve over **the same
pinned string**, so in any world where both see that pin they select the same file. **It is not a
security property at all**, and a change that is not a guard owes no red proof. What it does buy is
real but smaller: the provenance line **reports** the object that ran instead of asserting one by a
second lookup, and an absent git is caught early, by name. Struck and corrected in place in
`P14-AMENDMENT-28-CHALLENGE-ROUND-22.md`. The lesson, which is the useful part: **before owing a
red proof for a change, establish that the change is a guard.**

## 4. Two things the reviewers measured that this pack had not

* **The `--write` lane**, which amendment 28 never mentioned. A write lane that proceeded without
  history would be worse than a check lane that did. Measured by the challenger and re-measured
  here on a scratch copy: **rc 2, the same named refusal, and the manifest byte-identical
  afterwards (`cmp` clean)**. Nothing is written when nothing can be read.
* **A structural reading of `pinned-path-order-decides`**, the challenger's, recorded here because
  it is load-bearing and not colour: that arm proves a property of PATH resolution on copies whose
  pin is *shipped-pin-plus-shim*, **not** the shipped pin itself. What holds the **shipped** order
  is the **verbatim grep** in `pinned-path-no-git`'s premise, which is why a reorder surfaces as
  *premise not built*. **Nobody should delete that grep believing the behavioural arm covers the
  order.**

## 5. What the coordinator's diff review measured, recorded as theirs

* `2091119` now carries **all three links** of the chain: author, independent challenger,
  coordinator actual-diff review. No head of Phase 14 has carried three before.
* `R23-P2-01` re-rated **P3** with the reasons quoted in §1.
* `R-COORD-1` is new and is §2.
* **The sweep gave 67 ok in their container, not 76, because that container had no cluster: the DB
  lanes there are UNMEASURED.** Their figure and mine are both correct and are not comparable; the
  difference is the eight DB gates and the cluster-dependent arms, exactly as `--no-db` behaves
  here.

## 6. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in
a fresh clone of the pushed head and reported to the reviewers.

* `tools/gate-sweep.sh` — rc 0, **78 ok**, `0 gate(s)/proof(s) not as required`, from four working
  directories, with the cluster up. 76 at `2091119`; the two added are
  `git-binary-unrunnable-refused` and `sibling-no-git-refused`.
* `tools/manifest-digests.py --check` — rc 0 in both lanes, **70** artifact rows + the manifest,
  70 files, **1 revision found by the marker**. (Predicted 69 before it was run, and corrected
  here: this round commits THREE documents, two reviewer reports and this amendment, not two.)
* `tools/citation-provenance.py` — rc 0, and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0.
* `tools/retracted-claims.py` — rc 0, 27 claims across 39 pack documents.
* repository `npm run format` — rc 0. Gate list derived from the diff: it touches only `.md`, `.py`
  and `.sh` under the pack, and the repository has no shell or python gate.

## 7. Residuals at this head, signed by neither reviewer

* The in-pinned-set binary arm stays **absent and named**; both reviewers took the measurement by
  hand and neither would ship it as an arm.
* `parents-unknown` unwitnessed — five constructions between us, none reaching the state.
* `GIT_EXEC_PATH` **UNMEASURED** (not set in this container); the translated-git leg
  **UNMEASURED** (no git message catalogues here).
* **CI has never run a Phase 14 SHA, and no workflow in this tree runs this pack's gates.**
* `OD-P14-09`, `-10`, `-11` remain open with Ashraf, and the hold on them is unchanged by any
  signature.
