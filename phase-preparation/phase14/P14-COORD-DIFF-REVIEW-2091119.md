# Phase 14 — coordinator diff review at `2091119`

**Subject:** `2091119b1c02dd3bd8d8e47226336f9359de7fdc` (parent `abe95fcf7866d9b7cad026627332b184487d4c26`,
merge-base with `origin/main` `6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595`). Range `abe95fc..2091119`, one commit:
`2091119 phase14: answer challenge round 22 — one guard per arm, and the pin itself had a door in it`.

**Setup.** Fresh full-depth clone of the public repository in my scratchpad, `git fetch origin
93084f82b8e36ad49ebb207c0b6e7435d7fcb49f` run, subject checked out detached by full SHA, and its tree also
exported with `git archive`. Premises: `refs/replace` rows **0**, no `.git/info/grafts`,
`--is-shallow-repository` **false**, `git status --short` empty.

**Input read.** `P14-CHALLENGE-2091119.md` (round 23), sha256 verified before reading:

    e84b7bfc02da07cb1e54f54216e6881f67cd2c5e1a086d733a8a7b7dbd79afc3  /mnt/project-files/phase14/P14-CHALLENGE-2091119.md

plus round 22 (`P14-CHALLENGE-abe95fc.md`) and amendment 28 for context. I measured every item below
by building the attack myself. I did not take any rating from the challenger.

**Stopping rule applied:** only a false measured claim or a fail-open blocks. Everything else is a
named residual.

---

## 7 (taken first). The five artefact digests

Measured on the checked-out subject. All five match the challenger's table, byte counts included:

    dd9083ab9ad58ce5b37ba764cbf8861ef23e35b7b79cd6832b0e32e3cba6f271 86988 P14-HANDOFF-MANIFEST.md
    91a3a60f8a84b726736ffef710595796d073ba7caf35d672e289470b14b2fe3a 66099 tools/manifest-digests.py
    afe8d0b971566b8b0b5b22fa1290bfd9406332fdb844c205d29144a228260de5 31274 tools/citation-provenance.py
    5d5bd06de325e9ddc5da39f675409b010c463eb39899ec80ea87ab065e7ac492 93710 tools/gate-sweep.sh
    9fd1d35bec9cc55db923c9d82a7c896f13c530ae3122b3bafe2bf7bb9c7ce866 11423 tools/RETRACTED-CLAIMS.tsv

The exported tree gave identical output, and I re-ran this check at the end of the review with the same result.

## 1. PATH pin order: `/usr/bin` first

Both tools ship `_PINNED_PATH = '/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin'`.
I did not write into any system directory. In temp copies I changed only `_PINNED_PATH`. I planted a shim
directory at slot 1 (ahead of `/usr/bin`) and, separately, at slot 3, the slot `/usr/local/bin` holds in the
shipped order. The shim logs each call to a file and then execs `/usr/bin/git`:

    manifest-digests first rc=0 shim-invocations=136
    manifest-digests third rc=0 shim-invocations=0
    citation-provenance cpf rc=0 shim-invocations=155
    citation-provenance cp3 rc=0 shim-invocations=0

Provenance lines from the same runs:

    (first) ... git version 2.43.0 at /tmp/.../scratchpad/atk/shim/git
    (third) ... git version 2.43.0 at /usr/bin/git

The premise holds: a shim placed earlier wins in both tools. In the shipped order, a shim in the
`/usr/local/bin` slot runs zero times. **Measured closed.**

## 2. `_GIT_BIN` is resolved once and passed absolute, in both tools

Every subprocess site in the verdict tools:

    tools/manifest-digests.py:283:        return subprocess.run([_GIT_BIN,'-C',_md,'--no-replace-objects',
    tools/citation-provenance.py:87:    return subprocess.run([_GIT_BIN,'-C',repo,'--no-replace-objects',*args],
    tools/citation-provenance.py:116:    _top = subprocess.run([_GIT_BIN,'-C',ap.get_default('pack'),

No `os.system` or `Popen` remains. Resolved values after loading each shipped module:

    manifest-digests.py '/usr/bin/git' /usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin
    citation-provenance.py '/usr/bin/git' /usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin

Putting a shim first on the caller's `PATH` (`PATH=$W/shim:$PATH python3 -I ...`) does not move it:
`git version 2.43.0 at /usr/bin/git`, rc=0. **Measured.**

## 3. No git on the pinned path: named refusal at rc 2, both tools, both lanes

In copies whose pin points at an empty directory (`ls -A` count 0):

    ## manifest-digests --check
    CONFIGURATION ERROR: no `git` executable was found on the pinned PATH (/tmp/.../atk/empty), so no history could be read and nothing here is a verdict about this manifest.
    rc=2
    ## manifest-digests --write
    CONFIGURATION ERROR: no `git` executable was found on the pinned PATH (/tmp/.../atk/empty), so no history could be read and nothing here is a verdict about this manifest.
    rc=2
    cmp clean
    dd9083ab...f271  .../atk/before.md
    dd9083ab...f271  .../atk/wcopy/P14-HANDOFF-MANIFEST.md
    ## citation-provenance --check
    CONFIGURATION ERROR: no `git` executable was found on the pinned PATH (/tmp/.../atk/empty), so no provenance could be read and nothing here is a verdict about this block.
    rc=2
    ## citation-provenance --write
    CONFIGURATION ERROR: ... nothing here is a verdict about this block.
    rc=2
    cmp clean

The manifest is byte-identical after `--write`, and so is the citation block's document. **Measured.**

## 4. Retracted claim 27 is enforced

On a copy of the pack:

    27 retracted claim(s) enforced across 38 pack document(s); 31 challenge report(s) exempt in code (...)
    untouched rc=0
    RETRACTED CLAIM PRESENT: P14-MIGRATION-PATCH-REQUEST.md:1576 — 'all three GIT arms'
      retracted because: CHALLENGE R22-P1-01, mine. AMENDMENT-27 published a guard-deletion run ...
      allowed only in: P14-AMENDMENT-27-CHALLENGE-ROUND-21.md, P14-AMENDMENT-28-CHALLENGE-ROUND-22.md
    1 occurrence(s) of a retracted claim survive outside the files that record the retraction. ...
    planted rc=1
    ... (same sentence planted in P14-CHALLENGE-abe95fc.md instead)
    in-challenge-report rc=0

The planted sentence gets a named refusal. The exemption for challenge reports also behaves as stated. **Measured.**

## 5. Guard deletion, one deletion per copy, read by name

I made five full copies of the clone and applied exactly one edit to each, confirmed with `git diff --stat`
(1 file, 5 deletions or 1±1). I ran `tools/gate-sweep.sh --no-db` in each copy:

    === A: rc=1 ok=66        (manifest-digests: CONFIGURATION ERROR block deleted)
    FAIL  manifest-shared            ... STALE: P14-CHALLENGE-2091119.md: ARTIFACT WITH NO ROW
    FAIL  pinned-path-no-git-refused rc=1 (required 2), and the message was not CONFIGURATION ERROR: ...: Traceback (most recent call last):
    === B: rc=1 ok=66        (manifest-digests: pin back to round 21's order)
    FAIL  manifest-shared            ...
    FAIL  pinned-path-no-git         premise not built (git on the empty path NONE want NONE, shipped pin rows 0/1 want 1/1) — nothing was proved
    === C: rc=1 ok=67        (manifest-digests: _GIT_BIN -> 'git' in the call)
    FAIL  manifest-shared            ...
    === D: rc=1 ok=67        (citation-provenance: its CONFIGURATION ERROR block deleted)  <- my addition
    FAIL  manifest-shared            ...
    === E: rc=1 ok=66        (citation-provenance: pin back to round 21's order)           <- my addition
    FAIL  manifest-shared            ...
    FAIL  pinned-path-no-git         premise not built (... shipped pin rows 1/0 want 1/1) — nothing was proved

`manifest-shared` is red in all five copies and in the baseline, for an environmental reason (see §8).
Excluding it, rows A, B and C reproduce amendment 28's table and the challenger's row for row.
Row C, where nothing reds, is disclosed by the author.
**Row D is new: deleting the sibling tool's named refusal reds nothing.** The behaviour itself is
correct, as measured in §3. Only the arm is missing. Named residual **R-COORD-1** (P3). Amendment 28 claims the
refusal works "in both tools", which is true as a behaviour. It does not claim an arm for the sibling, so no
claim is false.

## 6. Challenger's P2 (R23-P2-01): the resolved git disappears between import and call

**Import-then-remove.** The pin is set to `bin1:bin2` in copies, each directory holds a real git, and
`bin1/git` is removed after import:

    ### manifest-digests --check, resolved git removed after import
    FileNotFoundError: [Errno 2] No such file or directory: '/tmp/.../race/bin1/git'
    rc=1
    ### manifest-digests --write, same
    FileNotFoundError: [Errno 2] No such file or directory: '/tmp/.../race/bin1/git'
    rc=1
    manifest cmp clean
    ### citation-provenance --check, same
    FileNotFoundError: ...
    rc=1
    ### control: bare name 'git' over the same pin after removal
    git version 2.43.0
    rc=0

**Mid-run disappearance.** This goes further than the challenger did. A self-deleting wrapper removes
itself on call N. Neither tool wraps git in any `except` (the only `except OSError` sites, at :509 and :909,
are `open` and `listdir`):

    md --check  N=1    rc=1 calls=1 green=0 last=FileNotFoundError: ...
    md --check  N=2    rc=1 calls=2 green=0 last=FileNotFoundError: ...
    md --check  N=10   rc=1 calls=10 green=0 ...
    md --check  N=50   rc=1 calls=50 green=0 ...
    md --check  N=100  rc=1 calls=100 green=0 ...
    md --check  N=135  rc=1 calls=135 green=0 last=FileNotFoundError: ...
    md --check  N=136  rc=0 calls=136 green=1 last=every artifact row matches ...   (removed after the LAST call ran)
    md --write N=1   rc=1 calls=1   manifest=identical      (inside a repo copy; control --write rc=0 calls=136)
    md --write N=10  rc=1 calls=10  manifest=identical
    md --write N=50  rc=1 calls=50  manifest=identical
    md --write N=100 rc=1 calls=100 manifest=identical
    md --write N=130 rc=1 calls=130 manifest=identical
    cp --check N=1    rc=1 calls=1   last=FileNotFoundError: ...
    cp --check N=154  rc=1 calls=154 last=FileNotFoundError: ...
    cp --check N=155  rc=0 calls=155 (removed after the last call ran)

**My rating: not a fail-open.** At every interior point it fails closed and never prints a green verdict.
The write lane never writes. The defect is that the failure is **unnamed and exits at rc 1**, which is the
gate's STALE code, so a runner reads "stale" instead of "could not run". Reaching it requires deleting or
replacing a file inside a directory on the pin during a run, and that already takes the access the pin
assumes the caller does not have. I rate it **P3 (fail-closed, wrong code)**, one step below the
challenger's P2. Named residual **R23-P2-01 → P3**. The remedy the challenger names (`except
(FileNotFoundError, PermissionError)` refusing at 2) fits.

## 8. Pack gates, all Python under `python3 -I`

Direct runs from `/tmp`:

    python3 -I tools/manifest-digests.py --dir <pack> --check
    read: repository .../scratchpad/r; git directory .../scratchpad/r/.git; git version 2.43.0 at /usr/bin/git
    manifest: 67 artifact row(s) + the manifest itself; 67 file(s) in .../phase14; reviewer-row history checked over all 30 revision(s) of this manifest reachable from HEAD, OLDEST first — 1 of them found by the marker it carries, the rest by a path it has held
    every artifact row matches the file on disk, and every file has a row.
    rc=0

    python3 -I tools/manifest-digests.py --dir <copy of /mnt/project-files/phase14 minus P14-CHALLENGE-2091119.md> --check
    manifest: 67 artifact row(s) + the manifest itself; 67 file(s) in .../scratchpad/sh; ... 30 revision(s) ... 1 of them found by the marker ...
    every artifact row matches the file on disk, and every file has a row.
    rc=0

    python3 -I tools/manifest-digests.py --dir /mnt/project-files/phase14 --check
      STALE: P14-CHALLENGE-2091119.md: ARTIFACT WITH NO ROW
    HANDOFF MANIFEST IS STALE. Run: tools/manifest-digests.py --write
    rc=1

    python3 -I tools/citation-provenance.py --check <pack>/P14-MIGRATION-PATCH-REQUEST.md
    .../P14-MIGRATION-PATCH-REQUEST.md: generated citation-provenance block is current.
    rc=0

    python3 -I tools/retracted-claims.py --check
    27 retracted claim(s) enforced across 38 pack document(s); 31 challenge report(s) exempt in code (...)
    rc=0

The shared folder holds `P14-CHALLENGE-2091119.md`, the round-23 report, which postdates this SHA and so
has no row in it. That red is the tool correctly refusing an unregistered file. Both lanes are green
with that one file removed, and the shared folder's manifest is `cmp`-identical to the subject's.

**Gate sweep** (`tools/gate-sweep.sh`, run in the subject clone):

    full run:   rc=1, 67 ok, "== 2 gate(s)/proof(s) not as required" — manifest-shared (above) and
                db-precondition: "the cluster is not listening on /tmp/p14pg/sock:54314 and this run could not start it, so the DB lanes are BLOCKED, not measured."
    --no-db:    rc=1, 67 ok, "== 1 gate(s)/proof(s) not as required" — manifest-shared only
    ok    git-dir-decoy-refused      rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md
    ok    git-dir-in-pack-decoy-refused rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md
    ok    git-binary-shim-refused    rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md
    ok    pinned-path-no-git-refused rc=2, refused with CONFIGURATION ERROR: no `git` executable was found on the pinned PATH
    ok    pinned-path-order-decides  rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md

There is no `/tmp/p14pg/data` cluster in my container, so **the DB lanes are unmeasured by me**. The
challenger's "76 ok, rc 0, cluster up" is therefore **not reproduced by me**. It is not contradicted
either: the diff touches no DB lane. My 67 equals 76 minus the DB lanes and the shared lane. Every
non-DB gate and proof is green except the environmental shared lane. Named residual **R-COORD-2**.

## 9. Repository gates, three worlds

Each world got a fresh clone from my clone, checked out detached by full SHA, with `dist-before=0` (no
`dist` outside `node_modules`). **Node v22.22.0, npm 10.9.4.** The challenger used Node 24.21 and npm 11.19,
so the toolchains differ, but the readings agree. Order, as run: `npm ci`, `format`, `lint` (cold),
`typecheck` (cold), `build`, `build`, `lint`, `typecheck`, `format`.

| reading | `2091119` (subject) | `abe95fc` (parent) | `6fc505d` (merge-base) |
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

All three columns were measured by me this round. The cold red is the known workspace build order (G6):

    src/app/runtime.ts(28,53): error TS2307: Cannot find module '@daftar/accounting' or its corresponding type declarations.

Note on method: the shared scratchpad was rewritten by another process mid-run. My `gates.sh` driver was
overwritten before its last line executed, so I ran `format after build` directly in each world. The
three readings above are from that direct run. My clone's HEAD and the five digests were re-checked
afterwards and are unchanged.

---

## Residuals (named, none blocking)

| id | what | measured severity |
|---|---|---|
| R23-P2-01 | resolved git removed between import (or call k) and a later call → unnamed `FileNotFoundError`, rc 1 = STALE code; never green, `--write` never writes | **P3**, fail-closed with the wrong code, **not** a fail-open |
| R-COORD-1 | `citation-provenance.py`'s named `CONFIGURATION ERROR` block has no arm: deleting it reds nothing (row D) | P3; the behaviour is correct (§3) |
| row C | `_GIT_BIN` → `'git'` reds nothing; it resolves over the same pin, so it is provenance rather than a guard (author-disclosed, agrees with challenger) | P3 / informational |
| R-COORD-2 | DB lanes not measured in my container (no cluster); 76-ok not reproduced by me | unmeasured, outside the diff |
| shared lane | `/mnt/project-files/phase14` holds the round-23 report, which postdates the SHA; correct refusal; green when that file is removed | environmental |
| standing | in-pinned-set system-dir arm not shipped (I did not build it either, by instruction); `GIT_EXEC_PATH` and the translated-git leg unmeasured; `parents-unknown` unwitnessed; CI has never run a Phase 14 SHA; OD-P14-09/10/11 open with Ashraf | as named |

No false measured claim found. Every figure I re-measured matches amendment 28 and the round-23 report:
the 67 rows, 30 revisions, 1 found by the marker, 27/38/31, the five digests, and the guard-deletion rows A, B and C.
No fail-open was found. R23-P2-01 was the one candidate, and I measured it as fail-closed.

## Verdict

**SIGN** — for `2091119b1c02dd3bd8d8e47226336f9359de7fdc` only. This is not a promotion and says nothing
about CI. No later head carries any part of it.
