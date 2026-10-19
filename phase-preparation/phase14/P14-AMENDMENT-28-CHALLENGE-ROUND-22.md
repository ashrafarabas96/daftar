# Phase 14 — amendment 28: challenge round 22 answered

**Subject reviewed:** `abe95fcf7866d9b7cad026627332b184487d4c26`.
**Verdict received:** REJECT. One false measured claim of mine, one fail-open with narrow reach,
and one defect in the remedy the reviewer itself proposed and had not measured.
**Reviewer's words:** `P14-CHALLENGE-abe95fc.md` (13,501 bytes,
`7845ff0cf3d866361eb956ecf0ff83a22c5f2ec9c2ec6a557a13fd4338626d9e`), committed unedited and
hashed from the file on disk.

This amendment is the ONE commit owed. Phase 14 remains **PREPARED / NOT PROMOTED** and has
**no signed head at any SHA**.

## 1. `R22-P1-01` — a FALSE MEASURED CLAIM, mine, and the same shape as last round's

Amendment 27 §1 published a guard-deletion run "from a copy of the pack with **only** the `GIT_*`
scrub reverted" in which "all three GIT arms now print FAIL". Three FAILs did appear. They did not
come from the deletion the sentence names: that copy reverted the whole built environment and
dropped the `PATH` pin along with the scrub, so **two** guards were deleted and the sentence
credited one. The reviewer measured one deletion per copy and got 2 + 1. I reproduced it here, two
sweeps, each from a copy of this pack with exactly one line changed:

| the one thing deleted | GIT arms that go FAIL |
|---|---|
| `_env = dict(os.environ)` — scrub reverted, both `GIT_*` keys and the `PATH` pin kept | **2**: `git-dir-decoy-refused`, `git-dir-in-pack-decoy-refused` |
| the `PATH` pin removed from `_env.update(…)`, scrub kept | **1**: `git-binary-shim-refused` |

**One guard per arm** is the fact, and it is stronger than the one I published: the shim arm cannot
be held by the scrub, because the shim is a directory prepended to `PATH` and the pin is what
excludes it. The conclusion survives — these arms are not tautologies — the measurement under it
did not. Struck in place in `P14-AMENDMENT-27-CHALLENGE-ROUND-21.md` and enforced as retracted
claim 27. This is the eleventh instance of "a sentence wider than the measurement under it", and
the second round running in which the sentence I was proudest of is the one that was wrong.

## 2. `R22-P1-02` — a FAIL-OPEN with narrow reach, conceded, reproduced here before it was fixed

Round 21's pin read `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. Its **first two
entries precede `/usr/bin`**, and `/usr/local/bin` is exactly where a locally installed binary
goes. So the pin excluded a shim in a caller's own directory and admitted one in the pinned set.

Measured in my own container, the shim written to `/usr/local/bin/git` and removed again in the
same command, over the round-20 world (pack walk 4, decoy walk 3, both read from git first):

| | `abe95fc` | this head |
|---|---|---|
| shim at `/usr/local/bin/git` | **rc 0, no refusal, "all 3 revision(s)"** | **rc 1, the LAW, 4 revisions** |
| the provenance line it printed | `… git directory …/f/repo/.git; git version 2.43.0 at /usr/local/bin/git` | `… git directory …/w/repo/.git; git version 2.43.0 at /usr/bin/git` |

Narrower than `GIT_DIR`, because it needs write access to a system directory. It is still the
mechanism the pin was added to close, and it is also an **honest-mistake** surface: a CI step that
installs a newer git into `/usr/local/bin` silently changes which binary this gate runs, with no
word in the output about it. Disclosure is not refusal.

The remedy is the reviewer's, measured: the pin is **reordered** with the system locations first,
and the binary is resolved **once** and passed **absolute**.

    _PINNED_PATH = '/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin'
    _GIT_BIN = shutil.which('git', path=_PINNED_PATH)
    …
    return subprocess.run([_GIT_BIN,'-C',_md,'--no-replace-objects', …], env=_env)

Resolving once also closes a smaller gap the reviewer found beside it: the provenance line used to
call `shutil.which` on its own while `subprocess` resolved `'git'` independently, so the line
**asserted** a binary by a second lookup instead of **reporting** the one that ran. It now prints
`_GIT_BIN`. Both tools carry the change — round 18's sibling rule, for the fourth round running.

Against the real pack the remedy moves no figure: 65 artifact rows + the manifest, 65 files, and
the history figures are in §5, measured where that rule requires.

## 3. `R22-P2-01` — the reviewer's own remedy, unmeasured where git lives elsewhere

With **no git anywhere on the pinned path** — an ordinary image with git in `/opt`, `/nix/store` or
a Homebrew prefix — `abe95fc` answered `rc 1` with a `FileNotFoundError` **traceback**. `rc 1` is
this gate's **STALE** verdict, so a runner reading the exit code could not tell "the manifest is
stale" from "this tool could not run at all". Measured, with the pin pointed at an empty directory
in a copy of each tool:

| | `abe95fc` | this head |
|---|---|---|
| `manifest-digests.py --check` | rc 1, `FileNotFoundError: … 'git'` | **rc 2**, `CONFIGURATION ERROR: no \`git\` executable was found on the pinned PATH (…), so no history could be read and nothing here is a verdict about this manifest.` |
| `citation-provenance.py` | rc 1, the same traceback | **rc 2**, the same refusal in its own words about its own block |

2 is this pack's configuration code, already used for an absent `--dir` and `--manifest`.

## 4. The arms that are shipped, the one that is NOT, and the guard read by name

Two new arms, neither of which writes anything outside a temporary directory:

* **`pinned-path-no-git-refused`** — a copy of the tool with `_PINNED_PATH` pointed at an empty
  directory must answer **rc 2** with the named refusal. Premise asserted first:
  `shutil.which('git', <that path>)` is `None`, and the shipped pin appears verbatim once in each
  tool.
* **`pinned-path-order-decides`** — two copies, the shim directory inserted into the pin **first**
  in one and **last** in the other. The first copy is the premise (it must answer rc 0 with no
  refusal, or a shim ahead of `/usr/bin` could not win even there and the arm would prove nothing);
  the second is the shipped order and must refuse by the law.

**NOT shipped, and a named residual with its reason:** the arm for a shim at `/usr/local/bin/git`
itself. It can only be built by writing an executable called `git` into a system directory, and a
gate that does that leaves every later git call in this container redirected if it is killed
between the write and the removal. The measurement in §2 was taken by hand instead, with the file
removed in the same command and a refusal to run at all if `/usr/local/bin/git` already existed.

**Guard-deletion, read by NAME, one deletion per copy** — four copies of this pack inside a clone
of the branch, baseline included, `--no-db`:

| the one thing deleted | arms that go FAIL beyond the baseline |
|---|---|
| nothing (baseline) | — |
| the named `CONFIGURATION ERROR` block | `pinned-path-no-git-refused` — rc 1 with the traceback where 2 is required |
| the pin reordered back to round 21's order | `pinned-path-no-git` — **premise not built**, the shipped pin no longer appears in the tool |
| `_GIT_BIN` reverted to `'git'` inside the call | **NONE** |

~~That last row is the honest one: the absolute resolution has **no shipped arm**, because its only
attack is the in-pinned-set binary that cannot be proved without writing into a system directory.~~

**REWORDED IN ROUND 23, and in my favour: it is not a guard with a missing arm, it is not a
guard.** The reviewer measured why nothing reds, instead of accepting my framing: `_GIT_BIN` and
`'git'` resolve over **the same pinned string**, so in any world where both see that pin they
select the same file. There is no security property there to prove, and a change that is not a
guard owes no red proof — the row is explained, not owed. What the absolute form does buy is
stated in `P14-AMENDMENT-29-CHALLENGE-ROUND-23.md`: the provenance line reports the object that
ran, and an absent git is caught early by name. What the shipped arms hold is the pin's presence,
its exact order, and the named refusal. The
baseline's own `manifest-shared` FAIL in those runs is this round's manifest being stale while the
round is being written, and it is green at the committed head (§5).

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in
a fresh clone of the pushed head and reported to the reviewers.

* `tools/gate-sweep.sh` — rc 0, **76 ok**, `0 gate(s)/proof(s) not as required`, from four working
  directories, with the cluster up. 74 at `abe95fc`; the two added are `pinned-path-no-git-refused`
  and `pinned-path-order-decides`.
* `tools/manifest-digests.py --check` — rc 0 in both lanes, 67 artifact rows + the manifest,
  67 files, **1 revision found by the marker**.
* `tools/citation-provenance.py` — rc 0, with the same built environment and the resolved binary.
* `tools/retracted-claims.py` — rc 0, 27 claims across 38 pack documents (predicted 39 before it
  was run: the new reviewer report counts among the 31 challenge reports exempt in code, not
  among the documents scanned).
* repository `npm run format` — rc 0. Gate list derived from the diff: it touches only `.md`, `.py`
  and `.sh` under the pack; the repository has no shell or python gate, so `prettier --check .` is
  the one repository gate this diff can move.

## 6. What the reviewer closed, recorded as theirs

* Retracted claim 26 is **enforced, not filed**: they planted claim 26's retracted sentence in
  `P14-MIGRATION-PATCH-REQUEST.md` and got rc 1 with `RETRACTED CLAIM PRESENT: …:1576` and the
  reason quoted, while the same sentence inside a challenge report is rc 0, exempt as designed.
* The provenance line **names the decoy** in the broken states —
  `read: repository /tmp/t33/W/pack; git directory /tmp/t33/F/.git; …` — which is the first time in
  this lane an attack appears in the output rather than only in an exit code.
* They re-measured every figure of this pack in a fresh clone (replace refs 0, no graft file,
  `is-shallow false`) and the five repository gates in a never-built clone, node v24.21.0,
  npm 11.19.0, in order: `ci` 0, `format` 0, `lint` COLD 1 (4,220), `typecheck` COLD 2, `build`
  FIRST 1, `build` SECOND 0, then `lint` 0, `typecheck` 0, `format` 0 — identical to `0332d1b` and
  to the merge-base `6fc505d`. The cold reds are **G6**, a build-ORDER item, and are no attribution
  to this diff.
* My round-21 words reached them unedited: 15,546 bytes, `019daf22…`, `cmp` clean.

## 7. Residuals carried at this head, signed by neither of us

* The in-pinned-set binary arm, not shipped, with the reason in §4.
* `parents-unknown` unwitnessed — five constructions between us, none reaching the state, fails
  closed.
* `GIT_EXEC_PATH` **UNMEASURED**: not set in this container.
* The translated-git leg **UNMEASURED**: no git message catalogues here.
* **CI has never run a Phase 14 SHA, and no workflow in this tree runs this pack's gates at all.**
* `OD-P14-09`, `-10`, `-11` open with Ashraf.
* The attack set on this class is now five mechanisms closed and one open; that is the set we have
  tried, not a claim that it is exhausted.
