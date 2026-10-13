# P14 — INDEPENDENT CHALLENGE, narrow check at `d14e14b`

**Round 15 (narrow check).** Reviewer: the independent Phase 14 challenger, own container, own
clones, own cluster. **Verdict: `REJECT`.** Three blocking findings. The round-14 blocker is
genuinely closed — `npm run format` is rc 0 at this head and the fix is the seven-line change, with
no ignore file, no config edit and nothing outside the pack. Five of the six attack routes the
coordinator asked for refuse by name. But the new revision walk has **two fail-opens** left, each
measured in its own world, and the amendment's four-gate table carries a **false exit code**: its
`typecheck` row is 0 in all three worlds and the measured value in a cold clone is 2 in all three.

- **Head checked:** `d14e14b01230da08dd88c0d31c4965b6d09990ce`, cloned fresh from `origin`
  (`--branch claude/project-thread-1zqgj8 --single-branch`), equal to the fetched ref.
  Delta `27c76c3..d14e14b` = 10 files, 600 insertions, 22 deletions, over two commits.
- **My round-14 report is committed unedited:** `P14-CHALLENGE-27c76c3.md` hashes
  `b3afc2b07df7…` in the pack and in the shared folder, 17,332 bytes — the digest I announced, and
  its manifest row says so.
- **Cluster:** PostgreSQL **160015**, `datcollate = en_US.utf8`, `initdb` and `pg_ctl` as the
  unprivileged `claude` account, port 54314, socket `/tmp/p14pg/sock`; the four roles under test
  re-read from `pg_roles` as `rolsuper=f, rolbypassrls=f`.
- **Node:** `v24.21.0` (tarball verified against that release's `SHASUMS256.txt`), npm 11.19.0,
  prettier 3.7.1 and eslint 9.39.1 read from the installed tree.
- Every exit code below is recorded with the directory or world it was measured from.
- **Revision history of this report, because its digest moved after I had announced one.** It was
  delivered at 16,643 bytes / `23105dd3…`, then gained the Node control and the G6 build-order
  paragraph in §5 (17,274, then 17,837 / `e9aea4a7…`, announced in an addendum), and then the
  retraction in §6 (19,271 / `e31a455e…`). **The authoritative digest is whatever `sha256sum`
  reports on this file when a row is written for it, and the author is right to hash what is on
  disk rather than what a message declared.** The fault is mine: a report whose digest has been
  published should be frozen, and anything further said in a separate file. From the next round the
  digest goes out only after the file is final.

---

## 1. `R14-P0-01` — CLOSED, and the fix is a real fix

| world | head | `npm ci` | `npm run format` | `npm run lint` |
|---|---|---|---|---|
| `/tmp/g25` | `d14e14b` | 0 | **0** | 1 |
| `/tmp/g24a` | `27c76c3` | 0 | 1 | 1 |
| `/tmp/g26`, `/tmp/g24c` | `6fc505d` (merge-base) | 0 | 0 | 1 |

`prettier --check .` prints *All matched files use Prettier code style!* at `d14e14b`. I checked
that the green came from the file and not from an exclusion: `git diff 27c76c3..d14e14b` over
`package.json`, `.prettierignore`, `.prettierrc.json`, `prettier.config.js` and `.gitattributes` is
**empty**, `02bf8ca` touches **no file outside `phase-preparation/phase14/`**, and the YAML's diff
is the seven double-quoted scalars becoming single-quoted. `lint` stays rc 1 with the log
byte-identical to `main`'s, sha256 `ffd4388c1b0a3e93541b69f496cea242479bbc1a9e9c7b62b8e3560b23cce361`
normalised for the clone prefix at all three heads — inherited, as the amendment says.

## 2. The five routes that now refuse, each by name

Worlds are purpose-made repositories under `/tmp/t21`, built with the real tool extracted from
`d14e14b` (`sha256 bf6fd6f6c1e7…`) and compared against the tool extracted from `27c76c3`
(`fbb9318d3076…`) in the **identical** world. The forged report is written into both the artifact
directory and the witness directory, so the two directories agree and only the history can speak.
Every manifest is the size the real one is, because git's rename scoring is a function of size.

| world | route | old tool | new tool | refusal |
|---|---|---|---|---|
| `G1` | `git mv` to a new basename in a new directory, forging in the same commit | **0** | **1** | `REVIEWER ROW REWRITTEN IN HISTORY`, 4 revisions read |
| `H` | the same, then a **second** rename in a later commit | — | **1** | same, 5 revisions |
| `K` | move into a directory named `d*r` (pathspec glob magic) with a new basename **and a decoy manifest in `dXr/`** | — | **1** | same, 5 revisions; the decoy is not read |
| `P` | **copy** the manifest, delete the old path in a later commit, forge in a third | — | **1** | same, 5 revisions |
| `O` | `--depth 1` clone of `G1` | — | **1** | `HISTORY NOT VERIFIED … shallow boundary`; with `--allow-unverified-history`, 0 and the limit printed |
| `N` | `G1` run from the manifest's directory, the repository root, `/tmp` and `/` | — | **1, 1, 1, 1** | identical verdict and identical sentence from all four |

`G1` is the author's answer to `R14-P2-01` and it holds: old **0**, new **1**, one world. The
`:(top)` premise in case 3 is sound — the verdict does not move with the cwd. The shallow clone
refuses by default, which is the behaviour `B3` settled; the opt-in still exits 0, which is the
caller explicitly accepting the limit and is not new.

## 3. `R15-P0-01` (BLOCKING, fail-open) — the `--follow` leg is a similarity lottery

World `G2` is `G1` with one addition: the promotion commit that renames, moves and forges **also
rewrites the manifest's prose** (400 added narrative lines). That is one ordinary commit, of
exactly the kind a promotion is.

    new tool, /tmp/t21/G2 : rc 0
      "reviewer-row history checked over all 1 revision(s) of this manifest
       reachable from HEAD, OLDEST first"
    revisions actually in the history: 4

Both legs of the union miss it: the basename leg sees 1 (the name changed), and `--follow` sees 1
because git no longer **scores** the rename. Measured in that world:

| `git log --follow …` | revisions found |
|---|---|
| default | 1 |
| `-M50%` | 1 |
| `-M20%` | 1 |
| `-M10%` | **4** |
| `-M5%`, `-M1%` | **4** |
| `-C -C` (copies) | 1 |

So the defence's strength is git's rename heuristic applied to **content the attacker writes in the
same commit**. This is the fifth round of one species — the witness anchored to something one
commit can change — and the anchor is now a similarity score. The code comment says *"(b) misses a
move git does not score"*, which is the right diagnosis; a comment is not a statement to the
reader, and what the reader is told is *checked over all 1 revision(s)*. Under the pack's own rule
that an announced blind spot still exits 0, this blocks.

**A remedy, measured.** A content anchor instead of a similarity score: the revisions where any
`*.md` document's diff mentions a reviewer report's name.

    git log --all --format=%h -G'P14-CHALLENGE-test.md' -- '*.md'
      G2: 4 of 4 commits      M: 3 of 3 commits

I patched the head's tool with that leg plus the fix in §4 (`/tmp/w21/md-patched2.py`) and measured
it over every world, and over the real pack in both lanes:

| world | head tool | patched |
|---|---|---|
| `G0` honest, no forge | 0 | **0** |
| `G1` rename+move+forge | 1 | **1** |
| `G2` + manifest rewritten | **0** | **1** |
| `M` non-ASCII old path | **0** | **1** |
| `P` copy-then-delete | 1 | **1** |
| `K` magic directory + decoy | 1 | **1** |
| real pack, `--dir` the repo copy | 0 | **0**, 22 revisions |
| real pack, `--dir` the shared folder | 0 | **0**, 22 revisions |

It closes both fail-opens, changes no honest verdict, and raises no false positive on the real
pack. It is a direction, not a design: a leg that reads other documents needs care, because an
amendment that quotes a manifest row could otherwise contribute an "oldest" record of its own.
That is the author's call to make, and the figures above are what I measured, not a patch to adopt.

## 4. `R15-P0-02` (BLOCKING, fail-open) — a path git quotes is silently dropped

The new extras lookup takes the paths `git log --follow --name-only` prints and asks
`ls-tree <rev> -- <path>` for each. Git **quotes** a path containing non-ASCII bytes
(`core.quotePath` defaults to true), and `ls-tree` asked for the quoted form answers **nothing, at
rc 0** — which the walk reads as "the manifest does not exist in this revision".

World `M`: the manifest is added and amended at `مرحلة/M.md` (an Arabic directory — this is an
ar/en/tr product), then a later commit moves it to `pack/HANDOFF.md`, renames it and forges the
reviewer row.

    new tool, /tmp/t21/M : rc 0
      "checked over all 3 revision(s) … and the manifest is ABSENT in 2 of them
       (964508830f0a, fc84186cfb2d) — removed and re-added, which does not erase
       the records before it"

The union found all three revisions. Both revisions holding the **true** digest were then counted
as gaps, the forging revision became the only record read, `signed_history` agreed with the file on
disk, and the gate said the row was fine. Mechanism, measured directly:

    git log --follow --name-only          prints  "\331\205\330\261\330\255\331\204\330\251/M.md"
    git ls-tree <rev> -- '"\331\205…/M.md"'  →  (empty), rc 0
    git ls-tree <rev> -- 'مرحلة/M.md'        →  100644 "\331\205…/M.md"
    git -c core.quotePath=false log …      prints  مرحلة/M.md

Adding `-c core.quotePath=false` to the tool's own `git` invocation closes it: world `M` goes to
**1** with `REVIEWER ROW REWRITTEN IN HISTORY`, measured, and no other world changes.

This is also the eighth instance of the class this lane keeps finding: **a refusal, or here a
reassurance, naming a cause that is measurably not the cause.** "The manifest is ABSENT in 2 of
them — removed and re-added" is a sentence about a deletion that never happened. The file was
present in both revisions; the tool could not look it up. (`R15-P3-01`.)

## 5. `R15-P0-03` (BLOCKING, false measured claim) — the `typecheck` row

`P14-AMENDMENT-20` publishes the repository's gates as a three-world table, and writes: *"Nothing
was run from a checkout that had been built before, because a `build` or `typecheck` reading taken
in a warm tree is not a reading of the commit."* Its `typecheck` row is **0 / 0 / 0**, and from
that row it concludes that the `G6` queue item's typecheck half *"does not reproduce at this
revision with this Node"*.

Measured here, each in a clone that had never been built, `npm ci` only:

| world | head | `npm run typecheck`, COLD |
|---|---|---|
| `/tmp/g25` | `d14e14b` | **2** |
| `/tmp/g24a` | `27c76c3` | **2** |
| `/tmp/g26` | `6fc505d` | **2** |

And in the **same** `/tmp/g25` clone, immediately after `npm run build` (which is itself rc 1, and
still emits the packages' declarations):

    rc_typecheck_AFTER_build_d14e14b = 0   (cwd /tmp/g25)
    packages/{accounting,design-system,domain-core,inventory,shared-contracts}/dist/index.d.ts now exist

**The Node version is measured OUT as the cause.** The author's table was taken on
`node v24.12.0 / npm 11.6.2`; mine above on `v24.21.0 / 11.19.0`. So I fetched their exact
toolchain (tarball verified against `v24.12.0`'s own `SHASUMS256.txt`), cloned `d14e14b` fresh into
`/tmp/g27`, ran `npm ci` (rc 0) and nothing else:

    rc_typecheck_COLD_d14e14b_node24.12.0 = 2   (cwd /tmp/g27)
    rc_format_node24.12.0                 = 0   (cwd /tmp/g27)

Same toolchain, same head, cold: **2**. The `format` 0 reproduces on their Node too, so the clone
and the toolchain are sound and only the `typecheck` figure does not reproduce.

The merge-base behaves identically, which rules out anything particular to this branch:
`/tmp/g26` at `6fc505d` gives `rc_build = 1`, `rc_typecheck_COLD = 2`, and
`rc_typecheck_AFTER_build = 0`, in that order, in one clone.

So a `typecheck` of 0 is reachable only in a tree where `build` ran first, which is the state the
amendment says it avoided. The row is wrong in all three columns, the sentence under it is wrong,
and the conclusion drawn from it — that `G6`'s typecheck half does not reproduce — is wrong: it
reproduces, cold, at the merge-base and at both heads. `G6` stays on the queue in full.

Nothing else in that table is contradicted: `format` 0/1/0 and `lint` 1/1/1 are what I measure, and
`build` is rc 1 at `d14e14b` with `TS2307 Cannot find module '@daftar/accounting'` as its first
error, consistent with the inherited reading.

**What the row should say instead of 0.** `G6` is a build-ORDER item, not a code debt: in this
monorepo the root `lint` and `typecheck` resolve workspace types through each package's
`dist/*.d.ts`, so both are red cold and green once the workspaces are built, and the first `build`
is itself red because `apps/api` compiles before its dependencies' `dist` exists. The honest cell
is therefore two numbers — cold and after a build — and the remedy is in CI's job graph, never in
the rules. Reported as one number it says the opposite of the truth about `G6`.

## 6. `R15-P1-01` — `GATE-035`'s 55 and the commit it needs from another phase

`tools/gate-sweep.sh`, run from the pack in a fresh single-branch clone of this branch:

    rc_gate_sweep = 1   (cwd /tmp/g25/phase-preparation/phase14)   51 ok, 4 FAIL

All four failures are `citation-provenance` at rc 2:

    CONFIGURATION ERROR: --repo (/tmp/g25) is a git repository but does not contain 93084f8

`93084f8` is a **Phase 4** commit. Measured: it is reachable from neither `origin/main` nor
`origin/claude/project-thread-1zqgj8` (`git merge-base --is-ancestor` says no for both), and it is
carried only by Phase 4 and other prep branches.

> **RETRACTED IN PLACE, 2026-10-13, by my own measurement.** This section first said *"it cannot be
> fetched by SHA — `git fetch origin 93084f8` answers `fatal: couldn't find remote ref 93084f8`,
> because the server does not serve arbitrary objects."* **The sentence is false and the reasoning
> under it was wrong.** The author narrowed it, after the Phase 8 challenger's relay, and I
> re-measured rather than accepting either reading. In a clean single-branch clone:
>
>     git fetch --depth 1 origin 93084f8                                  → fatal: couldn't find remote ref
>     git fetch --depth 1 origin 93084f82b8e36ad49ebb207c0b6e7435d7fcb49f → rc 0, cat-file -t = commit
>
> What is refused is the **abbreviated** name; the full 40-character object name **is** served. My
> error was to test one spelling and generalise to the server's policy — the same mistake I have
> now named three times in other people's work. The precondition is therefore one CI line, not
> anything waiting on the owner.
>
> **The minimal recipe, measured.** In a fresh full-history single-branch clone of this branch
> (`/tmp/g29`), `citation-provenance.py --check` is rc **2** naming `93084f8`; after one
> `git fetch origin 93084f82b8e36ad49ebb207c0b6e7435d7fcb49f` (rc 0) in that same clone it is rc
> **0** — *generated citation-provenance block is current*. In a `--depth 1` clone (`/tmp/g28`) the
> same fetch succeeds but the gate then names a **second** missing object, `6fc505d`, so depth-1
> needs both; `fetch-depth: 0` plus the one fetch is enough.

I first made it available by fetching one of the backup branches that carries it, and re-ran in the
same directory:

    rc_gate_sweep = 0   (cwd /tmp/g25/phase-preparation/phase14)   55 ok, 0 FAIL

**The author's figure is exact, and its precondition was undeclared.** A checkout of this branch —
which is what a CI job and any reviewer gets, `fetch-depth: 0` included — cannot pass `GATE-035`
until that object is also fetched, which is the one line measured above. The gate's verdict is a property not only of the head
and the directory but of **which other branches the clone happens to carry**, which is the same
class as `R8-P2-01` one layer out. Not a fail-open and not a false claim, so a named residual:
the precondition belongs in the gate's own output and in the DAG row.

## 7. Their other figures, reproduced

| figure | mine | where |
|---|---|---|
| `proofs/replay.sh` | **0**, 46 case(s) replayed, 0 not at their required exit code | `/tmp/g25/phase-preparation/phase14/proofs` |
| `proofs/redproof-preflight.sh` | **0**, 5 arms, 0 not red; version arm **UNFENCED** | same |
| `manifest-digests.py --check`, repo lane | **0**, 50 rows / 50 files, history over **22** revisions | `/tmp/g25/phase-preparation/phase14` |
| `manifest-digests.py --check`, shared lane | **0**, 50 rows / 50 files, **22** revisions | `--dir /mnt/project-files/phase14` |
| `gate-sweep.sh` | **0**, 55 ok (with `93084f8` present; see §6) | pack directory |

The coordinator's brief asked me to verify **21** revisions. It is **22** at this head, confirmed
two independent ways — `git rev-list --count d14e14b -- <the manifest's path>` and the same count
over `':(top,glob)**/P14-HANDOFF-MANIFEST.md'` both say 22 — and 21 at `02bf8ca`, because
`d14e14b` itself touches the manifest. The brief's figure is one commit stale, not wrong about
anything.

## 8. Findings

| id | sev | finding |
|---|---|---|
| `R15-P0-01` | P0 | A rename+move whose commit also rewrites the manifest defeats both legs of the union: 1 of 4 revisions read, rc **0**, printing *checked over all 1 revision(s)*. The anchor is git's rename score over attacker-written content. World `/tmp/t21/G2`. Remedy measured in §3. |
| `R15-P0-02` | P0 | A path git quotes (non-ASCII) is silently dropped by the extras lookup — `ls-tree` answers empty at rc 0 — so the revisions holding the true digest are counted as gaps and the forgery becomes the oldest record: rc **0**. World `/tmp/t21/M`. `-c core.quotePath=false` closes it, measured. |
| `R15-P0-03` | P0 | `P14-AMENDMENT-20`'s `typecheck` row is 0/0/0 under an explicit "nothing was built first"; measured cold it is **2/2/2**, and 0 only after `build` in the same tree. The `G6` conclusion drawn from it is wrong. |
| `R15-P1-01` | P1 | `GATE-035`'s *55 ok, rc 0* requires a Phase 4 commit (`93084f8`) that this branch does not contain and that cannot be fetched by SHA; from a clean clone of this branch the sweep is rc **1** with 4 `citation-provenance` failures. Undeclared precondition. |
| `R15-P3-01` | P3 | The *"ABSENT in N of them — removed and re-added"* sentence is written for revisions where the file was present and merely unlookupable. Eighth instance of a refusal naming a cause that is not the cause. |
| `R15-P3-02` | P3 | `--allow-unverified-history` still turns a committed forgery in a `--depth 1` clone into rc 0 (world `O`). That is the documented opt-in and was settled earlier; it is restated here because it is the one route in this round that passes a forgery with no further defect. |

## 9. Signature, withheld

**I do not sign `d14e14b01230da08dd88c0d31c4965b6d09990ce`.** Two fail-opens in the walk this round
was convened to check, and a false exit code in the table that accompanies it.

What I verified and will stand behind at a head that closes them: `R14-P0-01` closed with a real
fix (§1), the five refusal routes of §2 each measured old-against-new or by name, and the figures in
§7 — replay 46, preflight 5 arms, manifest 50/50 over 22 revisions in both lanes, sweep 55 with the
precondition of §6 stated.

**Restated, unchanged since round 4:** nothing in this lane has landed on Phase 14's
**architecture**, which is unexecuted — no API, no DDL, no route, no CI job. Fifteen rounds have
measured the pack's own tooling and prose. None of it is credit against the first review of an
executed Phase 14.

**What I did not do:** no file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; the patched tool is a copy under `/tmp/w21` and was
never written into the pack; the cluster was a scratch cluster on `/tmp/p14pg` and no frozen
migration was read or written. This report has no manifest row yet, so the shared-folder lane will
read `ARTIFACT WITH NO ROW` until the author writes one.
