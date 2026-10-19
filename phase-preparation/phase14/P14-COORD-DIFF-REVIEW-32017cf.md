# Phase 14 — coordinator diff review at `32017cf`

**Subject:** `32017cf576a9784d67b9d26d2437533d1300dd3e` (parent `2091119b1c02dd3bd8d8e47226336f9359de7fdc`,
coordinator-signed; merge-base with `origin/main` `6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595`). Range `2091119..32017cf`,
one commit.

**Setup.** Fresh full-depth clone of the public repository in my own scratchpad directory, `git fetch origin
93084f82b8e36ad49ebb207c0b6e7435d7fcb49f` run, subject checked out detached by full SHA, and its tree also exported
with `git archive`. Premises: `refs/replace` rows **0**, no `.git/info/grafts`, `--is-shallow-repository` **false**,
`git status --porcelain` empty (also re-checked at the end).

**Input read.** `P14-CHALLENGE-32017cf.md` (round 24), sha256 verified before reading:

    16776f02fc58641197f0c0ce41bc00be86133c9a6706da30134efa2560c28edc  /mnt/project-files/phase14/P14-CHALLENGE-32017cf.md

and my own method from `P14-COORD-DIFF-REVIEW-2091119.md`. I measured every item by building the attack myself. I did
not take any rating from the challenger.

**Stopping rule applied:** only a false measured claim or a fail-open blocks. Everything else is a named residual.

---

## 7 (taken first). The five digests the challenger pins

Measured on the checked-out subject. All five match the challenger's §9 table, byte counts included:

    dec42e5a11d3c417609dfe690dcf3bef85859e9e102f912061fc008d4c74b11d 90997 P14-HANDOFF-MANIFEST.md
    53ed45590a2147a5adc783c61ee2b16fbfe2775a2b982b9459de3113ba19c550 67511 tools/manifest-digests.py
    b09d43d988ebd5ce8c6364aa35138408df8aee22a5d2e1fab5c67341b2804a72 32228 tools/citation-provenance.py
    8a92b1c3135cb353f00cfa27613c4951d516a3d11dc3c316f36538e534d1ead7 96554 tools/gate-sweep.sh
    9fd1d35bec9cc55db923c9d82a7c896f13c530ae3122b3bafe2bf7bb9c7ce866 11423 tools/RETRACTED-CLAIMS.tsv

The exported tree gave the same prefixes. I re-hashed at the end of the review and they were unchanged. Both reviewer
reports committed in this diff are `cmp`-clean against `/mnt/project-files/phase14`:

    cmp clean P14-CHALLENGE-2091119.md
    cmp clean P14-COORD-DIFF-REVIEW-2091119.md

## 1. Diff scope

    11	3	phase-preparation/phase14/P14-AMENDMENT-28-CHALLENGE-ROUND-22.md
    133	0	phase-preparation/phase14/P14-AMENDMENT-29-CHALLENGE-ROUND-23.md
    206	0	phase-preparation/phase14/P14-CHALLENGE-2091119.md
    281	0	phase-preparation/phase14/P14-COORD-DIFF-REVIEW-2091119.md
    5	2	phase-preparation/phase14/P14-HANDOFF-MANIFEST.md
    3	3	phase-preparation/phase14/P14-MIGRATION-PATCH-REQUEST.md
    23	5	phase-preparation/phase14/tools/citation-provenance.py
    45	0	phase-preparation/phase14/tools/gate-sweep.sh
    25	3	phase-preparation/phase14/tools/manifest-digests.py

That is 9 files, +732 / −16, all under `phase-preparation/phase14`. `git diff --stat 2091119 HEAD -- .
':!phase-preparation'` is **empty**. In `.py`/`.sh`, the executable lines (not comments, not blank) are **+58 / −8**. The
8 removed lines are the three `subprocess.run` calls, which are re-added inside `try`. `gate-sweep.sh` is +45 / −0, so
no existing arm is deleted or weakened. The `except (FileNotFoundError, PermissionError, OSError)` clauses wrap only
`subprocess.run`, and each handler exits 2 via `SystemExit`. Nothing in them can reach a green verdict.

## 2. `R23-P2-01` fix: wrap and refuse by name at rc 2, both tools

**`git-binary-unrunnable-refused` world** (premise first). Copies whose pin is a directory holding a `git` with shebang
`#!/nonexistent-interpreter-for-p14`:

    which -> <S>/atk/bad/git
    /bin/bash: line 18: <S>/atk/bad/git: cannot execute: required file not found
    direct rc=127

Shipped wrapping (`md`, `cp`) against the same copy with the wrapping deleted (`mdx`: 1 site unwrapped; `cpx`: 2 sites
unwrapped):

    ## md --check
    CONFIGURATION ERROR: the `git` executable resolved on the pinned PATH (<S>/atk/bad/git) at start-up could not be run (FileNotFoundError: [Errno 2] No such file or directory: '<S>/atk/bad/git'), so no history could be read and nothing here is a verdict about this manifest.
    rc=2
    ## md --write
    CONFIGURATION ERROR: ... nothing here is a verdict about this manifest.
    rc=2
    manifest cmp clean
    ## mdx --check
    FileNotFoundError: [Errno 2] No such file or directory: '<S>/atk/bad/git'
    rc=1
    ## mdx --write
    FileNotFoundError: [Errno 2] No such file or directory: '<S>/atk/bad/git'
    rc=1
    manifest cmp clean
    ## cp
    CONFIGURATION ERROR: the `git` executable resolved on the pinned PATH (<S>/atk/bad/git) at start-up could not be run (FileNotFoundError: ...), so no provenance could be read and nothing here is a verdict about this block.
    rc=2
    ## cp --check   -> same CONFIGURATION ERROR, rc=2
    ## cp --write   -> same CONFIGURATION ERROR, rc=2
    ## cpx          -> FileNotFoundError: ..., rc=1
    ## cpx --check  -> FileNotFoundError: ..., rc=1
    cpx --write rc=1
    doc cmp clean

**Vanish between resolve and call.** The pin is `<A>/v1:/usr/bin:/bin`. `v1/git` is a wrapper that counts calls,
deletes itself on call N, and then execs `/usr/bin/git`, so call N+1 hits a missing resolved file. For
`citation-provenance`, the tool copy sits inside a repo copy, because citations resolve from the tool's own pack.

    md control rc=0 calls=140
    md --check N=1 rc=2 calls=1 last=CONFIGURATION ERROR: the `git` executable resolved on the pinned PATH (...
    md --check N=10 rc=2 calls=10 last=CONFIGURATION ERROR: ...
    md --check N=100 rc=2 calls=100 last=CONFIGURATION ERROR: ...
    md --check N=135 rc=2 calls=135 ...
    md --check N=139 rc=2 calls=139 last=CONFIGURATION ERROR: ...
    md --check N=140 rc=0 calls=140 last=every artifact row matches the file on disk, and every file has a row.   (removed after the LAST call)
    md --write N=50 rc=2 calls=50 ; manifest cmp clean
    cp control rc=0 calls=155
    cp --check N=1 rc=2 calls=1 last=CONFIGURATION ERROR: ...
    cp --check N=50 rc=2 calls=50 last=CONFIGURATION ERROR: ...
    cp --check N=154 rc=2 calls=154 last=CONFIGURATION ERROR: ...
    cp --check N=155 rc=0 calls=155 (removed after the last call)

At `2091119` the same shape gave rc 1 with an unnamed `FileNotFoundError` at every interior N (my previous review §6).
At this head every interior N gives **rc 2 and the named refusal**, and `--write` writes nothing. **R23-P2-01 is
measured closed.** (One aside: a `citation-provenance` copy placed outside any repo answered `MEASUREMENT EMPTY` rc 2,
which is a correct refusal for a mislocated tool and has nothing to do with this fix.)

## 3. `R-COORD-1`: `sibling-no-git-refused`, one guard deleted per copy

I made four clones of my verified-clean clone (`git status --porcelain` empty), each detached at the subject, and
applied exactly one edit per copy, confirmed with `git diff --stat`:

    == base
    == d1  manifest-digests.py      | 9 +++------    (try/except around its git call removed)
    == d2  citation-provenance.py   | 5 -----        (its `_GIT_BIN is None` CONFIGURATION ERROR block removed)
    == d3  citation-provenance.py   | 16 +++++----------- (both try/excepts removed)

`tools/gate-sweep.sh --no-db` in each copy, read by refusal name:

    === base
    FAIL  manifest-shared            rc=1 identical from 4 directories — consistent, but FAILING
    == 1 gate(s)/proof(s) not as required
    rc=1   ok=69
    === d1
    FAIL  manifest-shared            ...
    FAIL  git-binary-unrunnable-refused rc=1 (required 2), and the message was not CONFIGURATION ERROR: the `git` executable resolved on the pinned PATH: Traceback (most recent call last):
    == 2 gate(s)/proof(s) not as required
    rc=1   ok=68
    === d2
    FAIL  manifest-shared            ...
    FAIL  sibling-no-git-refused     rc=1 (required 2), and the message was not CONFIGURATION ERROR: no `git` executable was found on the pinned PATH: Traceback (most recent call last):
    == 2 gate(s)/proof(s) not as required
    rc=1   ok=68
    === d3
    FAIL  manifest-shared            ...
    == 1 gate(s)/proof(s) not as required
    rc=1   ok=69

`manifest-shared` is red in all four copies, the baseline included, for an environmental reason (§8). Leaving it
aside, d2 reds `sibling-no-git-refused` and no other arm. **R-COORD-1 is measured closed.** d1 likewise reds only its
own arm. These rows reproduce amendment 29 §2's table and the challenger's §5.

## 4. `R24-P3-01`: deleting citation-provenance's new try/except reds nothing

Row d3 above shows that this deletion reds **nothing**. In §2, the same deletion (`cpx`) turns the named refusal into
an unnamed traceback at rc 1 in `check`, `--check` and `--write`, and the document is `cmp`-clean afterwards. So the
guard is real, works, and has no arm.

**My rating: P3.** It fails closed and never prints a green verdict, and the write lane writes nothing. Without the
guard, the only damage is the wrong exit code and sentence (STALE instead of CONFIGURATION). This is the same severity
I gave R23-P2-01 and R-COORD-1. Remedy: one arm, a copy of `git-binary-unrunnable-refused` pointed at
`citation-provenance.py` and keyed on that tool's sentence. **Named residual, not blocking.**

## 5. `R24-P3-02`: "four copies" over a three-row table

Confirmed by reading. Amendment 29 line 61 says "four copies of this pack … baseline included", and the table has a
baseline and two deletions. The sentence is carried over verbatim from amendment 28 line 103, whose table had four
rows.

**Ruling: stale prose, not a false measured claim.** The test is whether a reader would act differently. What a reader
acts on is the table and the sentence under it, "Each new arm reds on its own deletion and on no other". I reproduced
both rows and that sentence exactly (§3 d1, d2). No exit code, row, count of gates, or verdict depends on the word
"four", and no measurement in this review would change if it read "three". At most, a reader might assume a third
deletion had been taken off-table. That is the d3 deletion, and it is already named as R24-P3-01, so nothing is
hidden. **P3 (documentary)**: correct it to "three", or add the d3 row, which would show the R24-P3-01 gap. Not
blocking.

## 6. `R24-P3-03`: prettier ignores the diff's files

`npx prettier --file-info`, measured identically in all three worlds:

    { "ignored": true, "inferredParser": null } <- amendment-29 file-info
    { "ignored": false, "inferredParser": null } <- manifest-digests.py
    { "ignored": false, "inferredParser": null } <- citation-provenance.py
    { "ignored": false, "inferredParser": null } <- gate-sweep.sh

`*.md` is ignored, and `.py` and `.sh` have no parser. So `npm run format` rc 0 is true but reads no file in this diff,
and this diff's repository-gate set is **empty**. Amendment 29 §6's sentence is literally true and omits that. A reader
who took it to mean "the markdown was formatted-checked" would be wrong, but no gate outcome depends on it.
**P3 / informational.** Not blocking.

## 8. Pack gates, all Python under `python3 -I`

Both lanes, `--dir` the subject's pack, run from `/tmp` and from inside the pack:

    read: repository <S>/repo; git directory <S>/repo/.git; git version 2.43.0 at /usr/bin/git
    manifest: 70 artifact row(s) + the manifest itself; 70 file(s) in <S>/repo/phase-preparation/phase14; reviewer-row history checked over all 31 revision(s) of this manifest reachable from HEAD, OLDEST first — 1 of them found by the marker it carries, the rest by a path it has held
    every artifact row matches the file on disk, and every file has a row.
    /tmp lane rc=0
    (identical text)  pack lane rc=0

The tool's default `--dir` is `/mnt/project-files/phase14`. When I first ran it bare, that directory held
`P14-CHALLENGE-32017cf.md`, which postdates this SHA:

    STALE: P14-CHALLENGE-32017cf.md: ARTIFACT WITH NO ROW
    HANDOFF MANIFEST IS STALE. Run: tools/manifest-digests.py --write
    rc=1  (pack-dir lane and repo-root lane: rc=1, byte-identical output)

A copy of the shared folder taken at that moment, minus that one file, gave rc 0 in both lanes ("70 file(s) in
<S>/sh … 31 revision(s) … 1 … found by the marker"), and its manifest was `cmp`-clean against the subject's. **Later in
the run, at 08:46:21 UTC, another process rewrote `/mnt/project-files/phase14`** (`P14-MIGRATION-PATCH-REQUEST.md` is
now `75fb818f…`, the subject's is `8412034f…`, and the manifest is 93,890 B). That is a later head in the shared
folder, not this SHA. The `manifest-shared` red in §3 and below is therefore environmental. It is the tool correctly
refusing a folder that is not this SHA's.

    python3 -I tools/citation-provenance.py                -> resolved=45 differ=9 identical=27 absent=9 ambiguous=0 unresolved=149 ... rc=0
    python3 -I tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md
    phase-preparation/phase14/P14-MIGRATION-PATCH-REQUEST.md: generated citation-provenance block is current.
    rc=0
    python3 -I tools/retracted-claims.py --check
    27 retracted claim(s) enforced across 39 pack document(s); 33 challenge report(s) exempt in code (...)
    rc=0

**Gate sweep at the subject** (base copy):

    --no-db:  rc=1, 69 ok, "== 1 gate(s)/proof(s) not as required" — manifest-shared only (environmental, above)
    full:     rc=1, 69 ok, "== 2 gate(s)/proof(s) not as required" — manifest-shared, and
    FAIL  db-precondition            the cluster is not listening on /tmp/p14pg/sock:54314 and this run
          could not start it, so the DB lanes are BLOCKED, not measured. Nothing
          below says anything about replay or the preflight.

There is no `/tmp/p14pg` cluster in my container, so **the DB lanes are UNMEASURED by me**. The author's and
challenger's "78 ok, rc 0, cluster up" is neither reproduced nor contradicted. The diff touches no DB lane. 69 ok plus
the shared lane is 70 non-DB gates, which matches the challenger's `--no-db` baseline of 70 ok. Both new arms are `ok`
in the base copy.

## 9. Repository gates, three worlds

Each world was a fresh clone from my clone, checked out detached by full SHA, with `dist-before=0`. The worlds ran one
at a time, each on a tmpfs (`/dev/shm`), because the shared scratchpad disk had 584 MB free. My first attempt failed
in `npm ci` with ENOSPC and is void; nothing from it is quoted. **Node v22.22.0, npm 10.9.4.** Order as run: `npm ci`,
`format`, `lint` (cold), `typecheck` (cold), `build`, `build`, `lint`, `typecheck`, `format`. No file named `git` was
written into any system directory at any point; every planted `git` was in my own scratchpad.

| reading | `32017cf` (subject) | `2091119` (parent) | `6fc505d` (merge-base) |
|---|---|---|---|
| `npm ci` | 0 | 0 | 0 |
| `npm run format` cold | 0 | 0 | 0 |
| `npm run lint` cold | 1 (4220 problems) | 1 (4220 problems) | 1 (4220 problems) |
| `npm run typecheck` cold | 2 | 2 | 2 |
| `npm run build` first | 1 | 1 | 1 |
| `npm run build` second | 0 | 0 | 0 |
| `npm run lint` after build | 0 | 0 | 0 |
| `npm run typecheck` after build | 0 | 0 | 0 |
| `npm run format` after build | 0 | 0 | 0 |

The cold red is the known workspace build order (G6) and is identical in all three worlds:

    src/app/runtime.ts(28,53): error TS2307: Cannot find module '@daftar/accounting' or its corresponding type declarations.
    ✖ 4220 problems (4220 errors, 0 warnings)

---

## Residuals (named, none blocking)

| id | what | measured severity |
|---|---|---|
| R24-P3-01 | `citation-provenance.py`'s new try/except has no arm. Deleting it reds nothing (d3), yet without it the tool goes rc 1 with a traceback; `--write` writes nothing | **P3**, fail-closed with the wrong code |
| R24-P3-02 | amendment 29 §2 says "four copies" over a three-row table, a count carried over from amendment 28 | **P3 documentary**: stale prose, not a false measured claim; every row and the "reds on its own deletion and on no other" sentence reproduce |
| R24-P3-03 | prettier ignores `*.md` and has no parser for `.py`/`.sh`, so no repository gate reads this diff | **P3 / informational** |
| R-COORD-2 | DB lanes unmeasured in my container (no cluster); 78 ok not reproduced | unmeasured, outside the diff |
| shared lane | `/mnt/project-files/phase14` held the round-24 report, then was rewritten to a later head mid-review; correct refusal; green when it matched this SHA | environmental |
| standing | in-pinned-set system-dir arm not shipped (I did not build it either, by instruction); `GIT_EXEC_PATH` and the translated-git leg unmeasured; `parents-unknown` unwitnessed; CI has never run a Phase 14 SHA; OD-P14-09/10/11 open with Ashraf | as named |

**Closed at this head, measured:** R23-P2-01 (rc 2 by name at every interior N, both tools, both lanes) and R-COORD-1
(d2 reds `sibling-no-git-refused` alone).

No false measured claim was found. The figures I re-measured match amendment 29 and the round-24 report: 70 rows, 31
revisions, 1 found by the marker, 27/39/33, the five digests, and guard-deletion rows d1 and d2. No fail-open was
found: every deletion and vanish case I built fails closed, and no write lane wrote.

## Verdict

**SIGN** — for `32017cf576a9784d67b9d26d2437533d1300dd3e` only. This is not a promotion and says nothing about CI or the
DB lanes. No later head carries any part of it.
