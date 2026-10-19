# Phase 14 — independent challenge, round 18 (narrow)

**Subject:** `c001cd9e668f9d481d3bc8c92c23df314fefa80c` (`c001cd9`), parent
`b49d612da3164e746c26ef10ce612f648bc3933b` — ONE commit, as asked. Read with replace objects
disabled; the repository serves no `refs/replace`. Clone `/tmp/g34`,
`--branch claude/project-thread-1zqgj8 --single-branch` from origin.

**Verdict: REJECT.** `R17-P1-01` and `R17-P3-01` are closed by real fixes and I verified both. But
the tool whose entire output is a claim about git history makes **no git call with
`--no-replace-objects`**, so the witness it reads is supplied by a ref inside the repository: with
`refs/replace` planted over three honest revisions the forgery it caught at rc 1 passes at **rc 0**,
and the same holds with the replace namespace moved by an environment variable while `refs/replace`
is empty. This is the lesson the pack already carries from Phase 8 and Phase 13, and it is already
applied in `citation-provenance.py` one directory over — but not in `manifest-digests.py`.

**Digest discipline.** Frozen before the digest was announced. Nothing added after the `sha256sum`
whose value appears in the delivering message; later findings go in
`P14-CHALLENGE-c001cd9-ADDENDUM-01.md`, never by editing this file.

**My words, committed unedited.** `P14-CHALLENGE-b49d612.md` is 12,568 bytes / `1ed42b9b…` and
`P14-CHALLENGE-b49d612-ADDENDUM-01.md` is 3,843 bytes / `78e9c5ee…` at this head, both byte-identical
to what I delivered, each with a manifest row that states my findings against this thread fairly.

| id | sev | finding |
|---|---|---|
| `R18-P0-01` | P0 | **Fail-open.** `_g()` runs `git -C <dir> -c core.quotePath=false …` and never `--no-replace-objects`, and nothing in the tool reads `refs/replace`. Planting replace commits over the three honest revisions turns the caught forgery (rc 1, *"all 4 revision(s)"*, `REFUSED`) into **rc 0, *"all 1 revision(s)"*, no refusal**. An emptiness check on `refs/replace` would not close it: with the refs moved to `refs/other/` and `GIT_REPLACE_REF_BASE` set, `refs/replace` is empty and the forgery still passes. Remedy measured: one word on one line → **0 → 1**, 4 revisions, refused by name; the real pack is unchanged. |
| `R18-P1-01` | P1 | `P14-AMENDMENT-23`'s evidence section says *"Measured AT the pushed head … 57 artifact rows + the manifest, 57 files, **24** revisions"*. At `c001cd9` the manifest's own history is **25** revisions; 24 is the **parent's** figure. The rows and files reproduce exactly; the revision count does not. Third round running in which a quoted figure is older than the head it is attributed to — and a new wrinkle: for a number that counts the manifest's own commits, measuring *after the last document write* is not enough, because committing that write adds the revision being counted. |

---

## 1. `R17-P1-01` — closed, and the fix is the fix I asked for

The diff is the one deleted line, with `_marker_revs` now written once from the marker leg's own
output. The true figure in each world is read from the leg's own command before either tool runs:

| world | `git log --no-renames -G '^# P14-HANDOFF-MANIFEST[.]md[[:space:]]*$' HEAD` | path leg | the parent's tool, same world | `c001cd9` prints |
|---|---|---|---|---|
| the real pack, `/mnt/project-files/phase14` | **1** | 25 | *"25 of them"* | *"**1** of them"*, rc 0 |
| the proofs' plain world | **1** | 2 | *"2 of them"* | *"**1** of them"*, rc 0 |
| the proofs' `*.md binary` world (inert anchor) | **0** | 2 | *"2 of them"* | *"**0** of them"*, rc 0 |

An inert anchor now reads as `0 of them`, which is what the sentence was for. `R17-P3-01` is closed
too: *23 of 23* is struck in place in amendment 22 and enforced as row 24 of
`tools/RETRACTED-CLAIMS.tsv`, allowed only in the three files that quote it as retracted.

## 2. `R18-P0-01` — the history witness is supplied by a ref in the repository

Every conclusion this tool draws about reviewer rows comes from `git` calls made through one helper:

    def _g(*argv):
        return subprocess.run(['git','-C',_md,'-c','core.quotePath=false'] + list(argv), …)

`git` honours `refs/replace` by default in `rev-list`, `log`, `grep`, `show` and `ls-tree` — every
command this tool uses. World: three honest commits recording the true digest, then a forging commit;
then, with plumbing only (`hash-object`, `read-tree`, `write-tree`, `commit-tree`, `replace -f`), a
replacement commit for each honest revision whose manifest already records the **forged** digest.

| state | result |
|---|---|
| before any replace ref | rc **1** — *"checked over all 4 revision(s) … 1 of them found by the marker"*, `REFUSED: P14-CHALLENGE-test.md` |
| three `refs/replace` planted | rc **0** — *"checked over all 1 revision(s) … 1 of them found by the marker"*, **no refusal** |
| same refs moved to `refs/other/`, `GIT_REPLACE_REF_BASE=refs/other/`, `refs/replace` **empty** | rc **0**, *"all 1 revision(s)"*, no refusal |
| the tool with `--no-replace-objects` added to `_g`, replace refs planted | rc **1**, *"all 4 revision(s)"*, `REFUSED` |
| the tool with `--no-replace-objects`, the real pack | rc **0**, 57 rows, 57 files, 25 revisions, 1 by the marker — unchanged |

Control, so the mechanism is not in doubt: `git --no-replace-objects show <oldest>:pack/M.md` holds
the **true** digest, and the same `show` without the flag returns the **forged** one.

Three things follow. The **remedy is the flag, not a check**: the env-var row above is a world where
`refs/replace` is empty and the forgery still passes, so a gate that greps for replace refs would
report clean. The **flag must be on the helper**, before the subcommand, where it cannot be forgotten
at a call site — which is exactly the shape `tools/citation-provenance.py:57` already uses
(`['git','-C',repo,'--no-replace-objects',*args]`). And the **scope is this tool only**:
`retracted-claims.py` makes no git calls, and `citation-provenance.py`'s single raw call is
`rev-parse --show-toplevel`, which a replacement cannot usefully move.

**The red proof is cheap, and here is the recipe I used.** In a scratch repository: three honest
commits recording a report's true digest, then a forging commit; `blob=$(git hash-object -w --stdin
< forged-manifest)`; for each honest revision `git read-tree <rev>`, `git update-index --add
--cacheinfo 100644,$blob,<manifest path>`, `t=$(git write-tree)`,
`new=$(git commit-tree $t [-p <rev>^])`, `git replace -f <rev> $new`. Assert the premise from git
before the tool runs — `git for-each-ref refs/replace | wc -l` is 3 and
`git --no-replace-objects show <oldest>:<manifest>` still holds the TRUE digest — then require the
refusal. A second arm moves the refs to `refs/other/` with `GIT_REPLACE_REF_BASE` and asserts
`refs/replace` is empty, so the proof also fails any remedy that only greps for replace refs.

I note what this does **not** claim: nothing in this repository has a replace ref, and I planted none
outside `/tmp/t24`. The finding is that the tool's verdict is decided by repository state that is not
the history, and the pack's own rule for that is already written down.

## 3. The author's own question, answered by measurement

They asked: the two count proofs assert the figure the marker leg returns, so do they prove the count
is the set the walk actually used? **No — and I can show it rather than argue it.** I built a copy
whose count ignores the walk entirely and simply re-runs the leg's command:

    len(_g('log','--format=%H','--no-renames','-G',MARKER_ERE,'HEAD','--',':(top)').stdout.split())

| world | committed tool | the copy that never consults the walk |
|---|---|---|
| the real pack | *"25 revision(s) … 1 of them found by the marker"* | **identical** |
| the proofs' plain world | *"— 1 of them found by the marker…"* | **identical** |
| the proofs' `binary` world | *"— 0 of them found by the marker…"* | **identical** |

Byte-identical output in all three, so `marker-count-plain` and `marker-count-binary` pass for both:
they pin the **figure**, not its provenance.

**It is not a defect at this head, and here is why I say so.** Every revision the `-G` leg returns is
`_revmap.setdefault(_r, set())`'d, so `_marker_revs ⊆ _revmap`; the walked set is `_revs`, which is
either replaced by the `_revmap`-filtered order or left alone only when no revision was added, in
which case the two sets are equal. So `len(_marker_revs & set(_revmap))` is identically
`len(_marker_revs)`, and that is genuinely *the walked revisions the marker leg found*. The proofs are
tautological **because** the invariant holds — there is nothing for them to distinguish while it does.

So this is a residual, not a finding, and the useful move is to make the invariant explicit rather
than to build a world that cannot exist: assert `_marker_revs <= set(_revmap)` and refuse by name if
it ever fails. The proofs' tautology then rests on a checked property instead of on a reading of the
code, and a future change that recomputes the count independently would be caught by the assertion
rather than sail past both proofs.

## 4. The rest of this head, reproduced

| gate | result |
|---|---|
| `manifest-digests.py --check`, both lanes | rc **0** — 57 artifact rows + the manifest, 57 files, **25** revisions, **1** found by the marker |
| `gate-sweep.sh`, 4 working directories | rc **0** — **67 ok / 0 FAIL** (65 at the parent); `marker-count-plain` and `marker-count-binary` both ok |
| `retracted-claims.py --check` | rc **0** — 24 claims across 33 documents, 26 reviewer reports exempt in code — their three figures exactly |
| `citation-provenance.py --check` | rc **0** — generated block current, regenerated this round |

The addendum's residual is written down and not coded around: §2 of the manifest now carries, as its
third precondition, that no other pack document may hold `# P14-HANDOFF-MANIFEST.md` on a line of its
own, in prose or inside a fenced code block, with the `AMBIGUOUS` consequence stated. That is what I
asked for, and the refusal itself is correct and unchanged.

## 5. Repository gates

`npm ci` first, then the readings in the order printed, in one clone that had never been built.
Node **v24.21.0 / npm 11.19.0**. The cold state is a fresh clone plus `npm ci` and nothing else —
**no `dist` directory exists anywhere in the tree**, so nothing was removed to produce it; the
*after build* rows are the same clone immediately after `npm run build`, in the order shown.

| reading | `/tmp/g34` `c001cd9` | `b49d612` (round 17) | `6fc505d` merge-base |
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

**I do not sign `c001cd9e668f9d481d3bc8c92c23df314fefa80c`.** One fail-open whose remedy is one word
(`R18-P0-01`), and one committed figure that belongs to the parent (`R18-P1-01`).

What I will stand behind at a head that closes them: §1's closure of `R17-P1-01` measured against
git's own figure in three worlds, §3's reading and its measurement, and §4's four pack gates.

**The parents branch** stays where round 17 left it: reasoned, not witnessed, in five constructions
between us, fails closed, signed by neither of us.

**Restated, unchanged since round 4:** nothing in this lane has landed on Phase 14's
**architecture**, which is unexecuted — no API, no DDL, no route, no CI job. Eighteen rounds have
measured the pack's own tooling and prose. None of it is credit against the first review of an
executed Phase 14.

**What I did not do.** No file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; no history was rewritten and nothing was force-pushed.
The patched tool, the guard-deletion copy and the tautology copy are copies under `/tmp/w21` and were
never written into the pack. The replace refs exist only in `/tmp/t24/replace_witness`, a scratch
repository I created; none was created in any clone of this branch. No `--write` was run against the
pack or the shared folder. The cluster was the scratch cluster on `/tmp/p14pg`. This report has no
manifest row yet, so the shared-folder lane will read `ARTIFACT WITH NO ROW` until the author writes
one.
