# Phase 14 — independent challenge, round 24 (narrow, `2091119..32017cf`)

**Subject:** `32017cf576a9784d67b9d26d2437533d1300dd3e`, parent
`2091119b1c02dd3bd8d8e47226336f9359de7fdc`, both resolved in a clone made for this round.
**Verdict: PASS-WITH-SCOPE.** Three residuals, all **P3**, none blocking. No false measured claim
and no fail-open was found at this head.

**What this verdict is not.** It is not a promotion, not a statement that Phase 14 is complete,
and not a statement about CI, which has still never run a Phase 14 SHA. It covers this SHA and the
five files pinned by digest in §9; a later head carries no part of it. My round-23
PASS-WITH-SCOPE covered `2091119` and does not reach here; this report replaces nothing in it.

## 1. The head, and the two reports it carries

* `git rev-parse HEAD` = `32017cf576a9784d67b9d26d2437533d1300dd3e`; `HEAD^` = `2091119…`. The
  amendment's opening says the signature of `2091119` does not reach this head; that is correct
  and it is the first thing the document says.
* The diff is 9 files, **+732 / −16**: two tool files, `gate-sweep.sh`, the manifest, the
  generated block inside `P14-MIGRATION-PATCH-REQUEST.md`, amendment 28 (struck sentence),
  amendment 29 (new), and the two reviewer reports.
* **Both reviewer reports are committed unedited.** `cmp` against the copies the coordinator and I
  froze is clean, and the digests are the ones announced:
  `P14-CHALLENGE-2091119.md` 13,217 B `e84b7bfc02da07cb1e54f54216e6881f67cd2c5e1a086d733a8a7b7dbd79afc3`;
  `P14-COORD-DIFF-REVIEW-2091119.md` 16,860 B `9da17e973d86c0aade72b51aa030a1eb99c9302dbde557ec2b150b423eed27bc`.

## 2. The sweep for call sites, which is where a fix like this usually leaks

A fix to how a tool runs `git` is only as complete as the set of places it runs it. Enumerated at
this head rather than assumed:

* `manifest-digests.py` — **one** `subprocess.run` carrying `_GIT_BIN` (line 303), wrapped.
* `citation-provenance.py` — **two** (the `git()` helper, and the `--repo` bootstrap that resolves
  the top level before the parser's defaults are set), **both** wrapped.
* `retracted-claims.py` — no git call at all.

So the sweep is complete, and the bootstrap site — the one a one-line patch forgets — was not
forgotten. `SystemExit` is a `BaseException`, so neither `except OSError` in the digest tool
(around `open` and `os.listdir`, not around git) can swallow the refusal.

## 3. `R23-P2-01` closed — measured, not read

The remedy I recommended in round 22 resolved `git` once at import and used the file later. I
filed the window it reopens; the coordinator re-rated it P3; this head wraps the call.

* With the pinned path holding a `git` whose shebang names a missing interpreter (premise first:
  `shutil.which` selects exactly that file, and running it directly exits 127):
  **rc 2**, `CONFIGURATION ERROR: the \`git\` executable resolved on the pinned PATH (…) at
  start-up could not be run (FileNotFoundError: …)`.
* The same world with the new `try/except` deleted: **rc 1 and an unnamed traceback.**
* **The `--write` lane under the new failure shape, which nobody had measured** (the author
  measured `--write` against the *absent*-git shape): **rc 2, the named refusal, and the manifest
  byte-identical afterwards** — and, with the guard deleted, rc 1 and the manifest *still*
  byte-identical. That is the measurement behind the P3 rating rather than a P2: the defect was
  never about what gets written, only about which code and which sentence a reader is handed.

`PermissionError` is reachable only inside that same window, because `shutil.which` tests `X_OK`
and will not select a mode-000 file in the first place; it enters by the same handler, so the arm
covers the class.

## 4. `R-COORD-1` closed — measured

Deleting `citation-provenance.py`'s own `CONFIGURATION ERROR` block for an absent git now reds
`sibling-no-git-refused`, which runs against **that tool's own sentence**. Its premise (empty
pinned path holds no git; the shipped pin appears verbatim once in that tool) is asserted before
the arm, which is the discipline that makes a reorder surface as *premise not built*.

## 5. Guard deletion, one deletion per copy — the author's table reproduced, and one row they did not take

Four copies of the branch, one deletion each, baseline included, `--no-db`, read by refusal NAME:

| the one thing deleted | arms that go FAIL beyond the baseline |
|---|---|
| nothing (baseline) | — (rc 0, 70 ok, `0 gate(s)/proof(s) not as required`) |
| the `try/except` around the **digest tool's** git call | `git-binary-unrunnable-refused` — rc 1 with the traceback where 2 is required, **and no other arm** |
| the **sibling's `CONFIGURATION ERROR`** block | `sibling-no-git-refused` — rc 1 with the traceback where 2 is required, **and no other arm** |
| the `try/except` around the **sibling's** git calls (**my deletion, not in the amendment**) | **NONE — rc 0, 70 ok, 0 not as required** |

The first three rows reproduce the amendment's table exactly. The fourth is §6's first finding.

## 6. Findings, all P3

### `R24-P3-01` — a named refusal shipped in this very commit, with no arm

This commit adds the same `try/except` to **both** tools, but ships an arm for the digest tool's
only. Deleting the sibling's two wrapped sites changes nothing in the whole sweep. That the guard
is real, and not merely unarmed, I measured directly rather than inferred:

* sibling as shipped, pinned path holding the unrunnable `git`: **rc 2**, `CONFIGURATION ERROR:
  the \`git\` executable resolved on the pinned PATH (…) could not be run (FileNotFoundError: …),
  so no provenance could be read and nothing here is a verdict about this block.`
* the same sibling with the `try/except` deleted: **rc 1**, `Traceback (most recent call last)` —
  this gate's STALE code.

So it is a guard, it works, and nothing in this tree would notice its removal. This is the defect
class of `R-COORD-1` — the finding this commit closes — reproduced one file along in the same
commit. Severity by the coordinator's own measure of `R23-P2-01`: it fails closed, it never
produces a green verdict, and `--write` writes nothing, so **P3**, a named residual rather than a
blocker. The remedy is one arm, built exactly like `git-binary-unrunnable-refused` but pointed at
`citation-provenance.py` and keyed on that tool's own sentence.

### `R24-P3-02` — "four copies" over a table that accounts for three

Amendment 29 §2 reads: *"Guard-deletion, read by NAME, one deletion per copy, four copies of this
pack inside a clone of the branch, baseline included"*, and the table under it holds a baseline and
**two** deletions. One deletion per copy with a baseline makes that **three** copies. The sentence
is carried over verbatim from amendment 28 §4, where the table has a baseline and three deletions
and **four** was right.

It is a stale count rather than a falsehood about an exit code, which is why it is P3 and not
higher — but it misleads in the one direction that matters here: a reader counting coverage
concludes a third deletion was taken and reds nothing, and the third deletion a reader would reach
for is the one in `R24-P3-01`, which nobody had taken. Either correct the number to three, or add
the fourth copy's row — and the fourth copy is the sibling's `try/except`.

### `R24-P3-03` — `npm run format` reads no file in this diff

§6 says *"repository `npm run format` — rc 0. Gate list derived from the diff: it touches only
`.md`, `.py` and `.sh` under the pack, and the repository has no shell or python gate."* Both
halves are true, and the figure is honest. What the sentence leaves a reader to assume is that the
markdown was gated. Measured with prettier's own answer, not read off `.prettierignore`:

    P14-AMENDMENT-29-CHALLENGE-ROUND-23.md -> { "ignored": true,  "inferredParser": null }
    tools/manifest-digests.py              -> { "ignored": false, "inferredParser": null }
    tools/gate-sweep.sh                    -> { "ignored": false, "inferredParser": null }

`*.md` is ignored repository-wide and `.py`/`.sh` have no parser, so `prettier --check .` reads
**nothing** in this diff. The correct derivation is that this diff's repository-gate set is
**empty**: `format` rc 0 is a true measurement that says nothing about these files, and no
repository gate can go red on account of this commit. I ran the four anyway (§7) because "no gate
reads it" is itself a claim.

## 7. Figures at this head, re-measured by me

Every figure below is my own run in my own clone, not a reading of the amendment.

* **`tools/gate-sweep.sh` — rc 0, `78 ok`, `0 gate(s)/proof(s) not as required`**, four working
  directories, PG16 cluster up (the script starts it itself). The author's 78 reproduces exactly;
  the two added arms are `git-binary-unrunnable-refused` and `sibling-no-git-refused`, both `ok`.
* **`tools/manifest-digests.py --check` — rc 0 in both lanes, byte-identical output from the pack
  directory and from the repository root.** `70 artifact row(s) + the manifest itself; 70 file(s)`;
  `reviewer-row history checked over all 31 revision(s) of this manifest reachable from HEAD,
  OLDEST first — 1 of them found by the marker it carries`. Provenance line:
  `read: repository /tmp/g48; git directory /tmp/g48/.git; git version 2.43.0 at /usr/bin/git`.
* **The 70 rows verified independently of the tool.** I parsed the manifest with my own script,
  hashed each named file on disk and compared digest *and* byte size: **70 rows parsed, 0
  mismatches.** `P14-MIGRATION-PATCH-REQUEST.md` keeps its size of 114,156 B across a changed
  digest because every edit in its generated block is a same-length substitution
  (38→39, 146→149, 114→117, 121→124); the row is correct.
* **History, measured with my own git commands in the fresh clone:** `31` revisions of the manifest
  path, `1` found by the marker ERE and it is `08d23da4e850b7498d03eefd893283d39309c712`; clone not
  shallow; `0` replace refs; no graft file. Both figures match the amendment.
* **`tools/citation-provenance.py`** rc 0, and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0.
* **`tools/retracted-claims.py`** rc 0: `27 retracted claim(s) enforced across 39 pack
  document(s); 33 challenge report(s) exempt in code`. Consistent with last round's 27/38/31: this
  round commits one pack document and two reviewer reports.
* **Repository gates at this head, with the order stated, both columns.** Cold, in a clone made
  fresh from GitHub (`npm ci` only, and the known `G6` red reproduces, which is the signal the tree
  really was cold): `format` **0**, `lint` **1** (`✖ 4220 problems (4220 errors, 0 warnings)`),
  `typecheck` **2** (286 `error TS`), `build` **1** first run / **0** run again. Warm, in a tree
  already built at the parent, run in the order format → lint → typecheck → build: **all four rc
  0**. Node v22.22.0, npm 10.9.4. The cold reds are the non-topological workspace build order,
  present on `main`, and not this head's: `git diff --stat 2091119..HEAD -- . ':!phase-preparation'`
  is **empty**, so this commit changes no input to any of them.
* Nothing in the diff deletes or weakens an existing arm: `gate-sweep.sh` is **+45 / −0**, and both
  tool diffs are additions plus the wrapping of calls that already existed.

## 8. What I did not measure, and what stays open

* **CI.** No workflow in this tree runs this pack's gates and no Phase 14 SHA has ever been run by
  CI. Nothing in this report is a statement about CI.
* **The in-pinned-set `git` arm** stays absent and named. I took it by hand in round 22 and would
  not ship it either: an arm must not write an executable called `git` into a system directory.
* `parents-unknown` unwitnessed; `GIT_EXEC_PATH` and the translated-git leg **UNMEASURED** in this
  container (neither is set and git's message catalogues are not installed).
* `OD-P14-09`, `-10`, `-11` are open with Ashraf. No signature of mine touches them.
* Phase 14 remains **PREPARED / NOT PROMOTED**.

## 9. Signature scope

**PASS-WITH-SCOPE of `32017cf576a9784d67b9d26d2437533d1300dd3e`**, together with these five files
as they stand at that SHA, each hashed from the file on disk in my clone:

| file | sha256 | bytes |
|---|---|---|
| `P14-HANDOFF-MANIFEST.md` | `dec42e5a11d3c417609dfe690dcf3bef85859e9e102f912061fc008d4c74b11d` | 90,997 |
| `tools/manifest-digests.py` | `53ed45590a2147a5adc783c61ee2b16fbfe2775a2b982b9459de3113ba19c550` | 67,511 |
| `tools/citation-provenance.py` | `b09d43d988ebd5ce8c6364aa35138408df8aee22a5d2e1fab5c67341b2804a72` | 32,228 |
| `tools/gate-sweep.sh` | `8a92b1c3135cb353f00cfa27613c4951d516a3d11dc3c316f36538e534d1ead7` | 96,554 |
| `tools/RETRACTED-CLAIMS.tsv` | `9fd1d35bec9cc55db923c9d82a7c896f13c530ae3122b3bafe2bf7bb9c7ce866` | 11,423 |

It covers nothing else: not the phase, not a promotion, not CI, and not the three residuals in §6,
which are named and unsigned. The next commit is a new SHA this report does not reach.

## 10. Two runs of mine that were void, disclosed

* My first full sweep was void and is not quoted anywhere above. A detached run I had started
  earlier was still alive and both processes were writing one log; the mixed file showed
  `== 1 …` and `== 3 gate(s)/proof(s) not as required` in the same output, and the
  `concurrent-run-refused` arm was passing against a real second run. I confirmed no sweep was
  running, re-ran once, and §7's figures are from that single clean run.
* My first set of guard-deletion copies was taken while that clean sweep was mutating the pack, so
  the baseline came back with 7 FAILs cascading from a `P14-MIGRATION-PATCH-REQUEST.md` left in a
  mutated state. I discarded all four copies, re-made them from a tree verified clean
  (`git status --porcelain` empty), re-applied one deletion each, and §5 is from that second set,
  whose baseline is rc 0 with `0 gate(s)/proof(s) not as required`.

Both are the same mistake — reading a tree while something else was writing it — and both were
caught by a baseline that refused to be green rather than by me noticing.
