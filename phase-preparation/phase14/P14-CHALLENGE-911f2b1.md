# Phase 14 — independent challenge, round 20

**Subject:** `911f2b1171d4ed70b8b93cc87170af0d738f0903` (parent `06cbc8ff66dc46d768caf9b39ea4451ba4228d36`),
branch `claude/project-thread-1zqgj8`, fetched by full object name into a clone of my own.
**Scope of this round:** `06cbc8f..911f2b1`, as handed over — the graft remedy in both arms, that
`GIT_SHALLOW_FILE` was not added beside it, that the key reached the sibling tool, the two new red
proofs' premises, and the pack and repository figures re-measured at the pushed head.

**Verdict: REJECT.** `R19-P0-01` is **closed**, in both arms, reproduced in worlds I built rather
than read about, and the one key is load-bearing: deleting it alone returns both arms to rc 0.
Every figure in amendment 25 reproduces. The REJECT is for a **new P0 fail-open of the same class,
a third mechanism along**: the helper's environment is `dict(os.environ, …)`, so `GIT_DIR` arrives
from the caller, **overrides `git -C`**, and hands the tool the whole history of a different
repository — at rc 0, with no refusal, under a sentence that still says *"of this manifest"*.

**No signature is given at this head.** `911f2b1` is not signed, and no earlier SHA of this lane is
signed.

---

## 1. `R20-P0-01` — FAIL-OPEN (P0): the history can still be supplied, now by `GIT_DIR`

Rounds 18 and 19 closed two ways for the judged side to replace the history this verdict rests on:
`refs/replace` (closed by the flag **and** the variable) and grafts (closed by
`GIT_GRAFT_FILE=os.devnull`). Both remedies are keys written **into** `dict(os.environ, …)`. The
dictionary that receives them is the caller's environment, and `GIT_DIR` is in it.

`GIT_DIR` beats `-C`: `git -C <pack> rev-list --count HEAD` answered **3** in my world where the
repository at `<pack>` answers **4**, because `GIT_DIR` named another repository.

**The world.** `W`: three honest revisions of a manifest recording a reviewer report's true digest,
then the forgery committed as a fourth revision — the report tampered and its row rewritten to
match. `F`: a **separate** repository, three revisions, every one of them already carrying the
forged digest at the same relative path. The files on disk are `W`'s in both arms; only the
environment changes.

| `W`'s files, one variable | subject `911f2b1` |
|---|---|
| no environment | **rc 1**, `REFUSED: P14-CHALLENGE-test.md`, `STALE: REVIEWER ROW REWRITTEN IN H…`, over **4** revisions |
| `GIT_DIR=F/.git` | **rc 0, no refusal**, *"reviewer-row history checked over all **3** revision(s) of this manifest"* |

The forgery that is refused is accepted, and the sentence printed over the acceptance describes a
history the manifest has no relation to.

**It is not confined to built worlds — it moves the published figure of the real pack.** With
`GIT_DIR` pointed at a clone of this very repository standing at the **previous** head, the pack's
own `--check` run prints, at rc 0 and with no refusal:

    reviewer-row history checked over all 26 revision(s) of this manifest … 1 of them found by the marker

against **27** with the variable unset — the figure amendment 25 reports, and the figure this round
confirms. A reader has no way to tell the two runs apart: same exit code, same shape of sentence,
one number different, and nothing says which repository was read.

**Why this is in scope and not a caller's own foot.** The threat model this lane has been working
to for two rounds already treats the caller's environment as hostile, and both remedies in the
helper are there to defeat it: `GIT_REPLACE_REF_BASE` is named in the round-18 comment as the
reason a *check* could not be the remedy, and round 19's remedy is itself an environment variable
set defensively against the caller's `GIT_GRAFT_FILE`. A tool that sets two keys to stop the
environment redirecting its history, while taking the rest of that environment verbatim, is not
closed against the thing it is defending against. `GIT_DIR` is the same mechanism with a shorter
attack than either: no replacement ref to plant, no graft line to write, nothing inside the judged
repository at all, and the decoy may be an honest clone of this repository.

Where the gate is *meant* to run makes the vector concrete rather than hypothetical: §2 of the
manifest declares the CI recipe for these gates (`fetch-depth: 0` **and** one full-object-name
anchor fetch), and a workflow is a file inside the repository under judgement, so whoever can forge
a reviewer row can export a variable in the step beside it. I am not claiming that is reachable
today, and I measured why: **no workflow in this tree runs the pack's gates at all** — `ci.yml` and
the three other workflows mention neither `phase14` nor any pack tool (measured by grep). So today
the environment comes from whoever runs the sweep by hand or from any wrapper around it. The class
is what rounds 18 and 19 were decided on, not the current reachability.

**The remedy, measured.** Scrub the namespace instead of patching one key at a time, which is what
the helper has now done twice:

    _env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    _env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_GRAFT_FILE=os.devnull)

| arm | subject | with the scrub |
|---|---|---|
| `W`, no environment | rc 1 REFUSED, 4 revisions | rc 1 REFUSED, 4 revisions |
| `W`, `GIT_DIR=F/.git` | **rc 0, no refusal, 3 revisions** | **rc 1 REFUSED, 4 revisions** |
| real pack, no environment | rc 0, 27 revisions | rc 0, **27** revisions |
| real pack, `GIT_DIR=`previous head | rc 0, **26** revisions | rc 0, **27** revisions |

The scrub closes the hole, and it does not move one figure of the real pack: 61 rows + the
manifest, 61 files, 27 revisions, 1 found by the marker, rc 0 — identical to the subject's own
unredirected run.

**And one cost of this remedy I measured, so it is decided with the numbers in view.** This
container exports **eleven** `GIT_*` variables, among them `GIT_CONFIG_COUNT=3` with three
key/value pairs (a `url.…insteadOf` rewrite and `credential.interactive=false`) and
`GIT_SSL_CAINFO` pointing at the proxy's CA bundle. A blanket scrub therefore changes the config
git sees, and in an environment that fetches over HTTPS it would break the fetch. It is safe
**here** because every git call of this tool is a local read — `rev-list`, `log`, `grep`,
`ls-tree`, `rev-parse` — and I measured the real pack unchanged with the scrub in place. The scrub
belongs **inside the helper**, where the local reads are. It must not be exported to
`gate-sweep.sh` or to a CI step, which do fetch, and which need `GIT_SSL_CAINFO` and the full-SHA
anchor fetch declared in §2 of the manifest. If `GIT_EXEC_PATH` is ever set in a deploy
environment it must be kept; it is **not** set here, so I could measure no difference between a
scrub that drops it and one that keeps it — both closed the hole and both left the pack's figures
at 27. That is an unmeasured leg, named, not a pass.

## 2. Scope of `R20-P0-01`, measured in both directions

* `tools/citation-provenance.py` — **affected but fail-closed.** With `GIT_DIR` naming another
  repository it exits **2**, `CONFIGURATION ERROR: --repo (…) is a git repository but d…`, both
  with a decoy clone of this repository at the previous head and with an unrelated world. rc 0
  with the variable unset. Not a second fail-open; the same class reaches it, and the same scrub
  closes it, which is round 18's rule and the one this lane has now paid for three rounds running.
* `tools/retracted-claims.py` — **unaffected.** rc 0 with the variable set and unset; it makes no
  git calls (measured: no `subprocess.run` site in the file).
* The rest of the namespace, on the subject tool, same world:
  `GIT_OBJECT_DIRECTORY` and `GIT_COMMON_DIR` → **fail-closed** (rc 1,
  `NOT CHECKED (this is a git repository, but it could not lis…)` + `STALE: HISTORY NOT VERIFIED`);
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`
  and `GIT_CONFIG_COUNT/KEY/VALUE` forcing `core.quotePath=true` → **no effect**, rc 1 REFUSED over
  4 revisions, the `-c` on the command line winning over the injected config.
* A **relative** `GIT_DIR` (`../F/.git`) already fails closed at the subject, but for the wrong
  reason: `NOT CHECKED (the manifest is not in a git reposit…)`. With the scrub it is rc 1
  `REFUSED` over 4 revisions — the right refusal for the right reason.
* `HOME` and `XDG_CONFIG_HOME` redirected to a gitconfig the judged side writes
  (`core.quotePath=true`, `advice.graftFileDeprecated=false`, `safe.directory=*`) → **no effect**,
  rc 1 REFUSED at both the subject and the patched copy. Not a vector.

## 3. `R19-P0-01` is closed, and the key is the single variable

Re-built in my own worlds, with every replacement ref deleted so the graft is the only truncation,
and with each world's premise asserted from git before the verdict was read:

| arm (premise asserted) | `06cbc8f` | `911f2b1` |
|---|---|---|
| default path: replace refs 0, grafted walk 1, ungrafted 4, file at default path present | **rc 0, no refusal, "all 1 revision(s)"** | **rc 1, `REFUSED: P14-CHALLENGE-test.md`, `STALE: REVIEWER ROW REWRITTEN IN H…`, 4 revisions** |
| elsewhere: replace refs 0, grafted walk 1, ungrafted 4, default path **absent** | **rc 0, no refusal, "all 1 revision(s)"** | **rc 1, REFUSED, 4 revisions** |

**Guard deletion, read by the refusal name and not by the exit code.** A copy of the subject tool
with `GIT_GRAFT_FILE=os.devnull` removed from `_env` and **nothing else changed** answers rc 0 with
no refusal in both arms. Run against the author's own two new proofs through `gate-sweep.sh`, that
one deletion prints

    FAIL  graft-default-refused      rc=0 (required 1), and the message was not REFUSED: P14-CHALLENGE-test.md: …
    FAIL  graft-elsewhere-refused    rc=0 (required 1), and the message was not REFUSED: P14-CHALLENGE-test.md: …

and **exactly two** FAILs in the whole sweep, at rc 1. The proofs are not tautologies, they read
the refusal by name, and the key they protect is the only variable between green and red.

**`GIT_SHALLOW_FILE` is not set.** Measured, not read: no non-comment line of any tool in the pack
mentions it (`grep` over `phase-preparation/phase14/tools/`), and the fresh clone of the pushed
head answers `false` to `rev-parse --is-shallow-repository`. The comments in both tools record my
measurement of why it must not be added, as mine.

**The key reached the sibling.** `tools/citation-provenance.py` has exactly two `subprocess.run`
sites and both now carry `env=GIT_ENV` with the same two keys, including the `--show-toplevel` read
that had no `--no-replace-objects` before. `tools/manifest-digests.py` has exactly **one**
`subprocess.run` site, so no call site can forget either key.

**One negative result, worth its line because it is the next mechanism someone would reach for.**
A crafted commit-graph cannot carry a graft's truncation into a repository where the graft file is
gone: with a graft in effect, `git commit-graph write --reachable` writes **no graph file at all**
(measured: 0 files under `.git/objects/info/`), and after the graft file is removed the walk is 4
again. This proves only the attack set I tried — grafts, replace refs under both bases,
`GIT_NO_REPLACE_OBJECTS=0`, the commit-graph route, and the nine environment variables of §2. It is
not a statement that the namespace is exhausted.

## 4. Amendment 25 re-measured

Every figure it quotes reproduces, measured at the committed tree and in a fresh clone of the
pushed head, with the command each one names:

* `tools/gate-sweep.sh` — **rc 0, 71 ok, 0 not as required**, with the cluster up (63 ok with
  `--no-db`; the eight DB gates are the difference, and the cluster this sweep starts is the
  on-target PG16 `en_US.utf8` one at `/tmp/p14pg`).
* `tools/manifest-digests.py --check` — **rc 0 in both lanes** (cwd = the pack, cwd = `/`), **61**
  artifact rows + the manifest, **61** files, **1** revision found by the marker.
* `tools/citation-provenance.py --check` — **rc 0** with the anchor present in the clone.
* `tools/retracted-claims.py --check` — **rc 0**, *"25 retracted claim(s) enforced across 35 pack
  document(s); 28 challenge report(s) exempt in code"*.
* **27 revisions** of the manifest, with replacement off and the graft file at `/dev/null`, in a
  fresh clone of the pushed head whose premises I asserted: `refs/replace` rows **0**, no file at
  `.git/info/grafts`, `rev-parse --is-shallow-repository` **false**.
* My round-19 words are committed **unedited**: `P14-CHALLENGE-06cbc8f.md`, 12,364 bytes,
  `c334906673d7024e758ebd90027278e26e20be29d3def645cdf922f11f7d2d9e`, byte-identical to the copy I
  froze (`cmp` clean), and its manifest row states the finding against the author.

## 5. Repository gates — three worlds, one never-built clone each

Node v24.21.0, npm 11.19.0, in the order shown, in a clone that had no `dist` anywhere before
`npm ci` (asserted with `find`). Cold = the clone as cloned; after-build = the same clone after
`npm run build`.

| reading | `911f2b1` (subject) | `06cbc8f` (parent) | `6fc505d` (merge-base) |
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

The parent and merge-base columns are last round's readings in `/tmp/g36`, quoted as measured
there, not re-run this round. The subject column was measured this round in `/tmp/g41`. The cold
reds are `G6`, the non-topological workspace build order, present on `main` as well: a cold figure
measures the missing build and is no attribution to this diff. The gate list is derived from the
diff, which touches only `.md`, `.py` and `.sh` files under `phase-preparation/phase14/`: the
repository has no shell or python gate (`package.json` scripts and the four workflows carry
none), so `prettier --check .` is the one gate the diff can actually move, and it is **0**.

## 6. Residuals carried, not closed

* **The parents-unknown branch is still unwitnessed.** Five constructions between us, none
  reaching the state; it is refused upstream and fails closed. Signed by neither of us, and
  reasoned rather than measured. I built no new construction for it this round, so the count is
  unchanged and so is the gap.
* **`GIT_EXEC_PATH` is an unmeasured leg of §1's remedy** in this container, because the variable
  is not set here.
* **The missing-anchor and `success`-vs-exit residuals of the pack** are not in this round's scope
  and are not re-asserted either way.
* **CI has never run a P14 SHA.** The anchor requirement — `fetch-depth: 0` **and** an explicit
  fetch of `93084f82b8e36ad49ebb207c0b6e7435d7fcb49f` by its full object name — is declared and
  unexercised; neither workflow in this tree runs the pack's gates at all.

## 7. What is owed

**ONE commit**, holding:

1. The `GIT_*` scrub in `tools/manifest-digests.py`'s one helper, with the two keys set after it.
2. The same scrub in `tools/citation-provenance.py`'s `GIT_ENV`, for the reason round 18 wrote
   down, even though the class is only fail-closed there.
3. A red proof per direction, each asserting its premise from git before it requires the refusal:
   one with `GIT_DIR` naming a decoy repository whose every revision carries the forged digest
   (assert that the walk `GIT_DIR` serves differs from the walk the pack's own repository serves,
   and that the forgery is refused at rc 1 by name), and one with a **relative** `GIT_DIR`, whose
   refusal must be the row refusal and not *"not in a git repository"*.
4. The comment that records why the scrub is inside the helper and must not be exported to the
   sweep or to CI — `GIT_SSL_CAINFO` and the anchor fetch live out there.

Nothing else is owed to me. I hold at `911f2b1` and will run round 21 narrow on the commit that
answers this.
