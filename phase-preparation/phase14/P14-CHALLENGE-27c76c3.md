# P14 — INDEPENDENT CHALLENGE, narrow check at `27c76c3`

**Round 14 (narrow check).** Reviewer: the independent Phase 14 challenger, own container, own
clones, own cluster. **Verdict: `REJECT`, scoped to the repository's own
format gate.** Everything this round set out to check passed: round 13's finding and the
coordinator's `B1`–`B3` are closed, each measured old-tool-against-new in one world, and every new
guard reds when deleted. One new P2 and two P3s below. But `npm run format` — the repository's own
gate, `prettier --check .` — is **rc 1** at this head, and **Phase 14 is the whole of the red**
(§9). Under the P4 round-20 ruling a head that turns a repo gate red carries no signature, so
**`27c76c3` is not signed, and every signature I issued earlier in this lane is withdrawn** (§10).
The pack's own tooling is in better shape than it has been; it cannot be merged as it stands.

- **Head checked:** `27c76c3cfa8b35324c6644b23e18b42e1d14a598`, pinned with
  `git ls-remote origin claude/project-thread-1zqgj8` before anything was read, equal to the
  fetched ref. Delta `03b3a0b..27c76c3` = **15 files, 1,322 insertions, 88 deletions**.
- **My round-13 report is committed unedited:** `P14-CHALLENGE-03b3a0b.md` hashes
  `3d5af8cb7e81…` in the pack and in the shared folder — the digest I announced.
- **Cluster:** PostgreSQL **160015**, `datcollate = en_US.utf8`, unprivileged `claude`, port 54314.
- Every exit code is recorded with the directory or world it was measured from.
- **This report's own digest:** 17,006 bytes was the size before this line was added; the
  authoritative figure for the manifest row is whatever `sha256sum` reports on the delivered file,
  announced in the message that delivers it. No earlier digest for this filename was ever
  published, so there is nothing to supersede.

---

## 1. `R13-P2-01` — closed twice over, both halves measured

| world | `03b3a0b`'s tool | `27c76c3` | what the head printed |
|---|---|---|---|
| the manifest is a **symlink** from the first commit; report tampered, row forged, counterpart agrees | **0** — *checked over every revision* | **1** | `NOT CHECKED (revision f7977d919a95 records this manifest at P14-HANDOFF-MANIFEST.md with mode 120000, not a regular file …)` |
| every revision carries the reviewer row as `UNSIGNED`/`UNSIGNED`, the row is signed on disk only, counterpart agrees | **0** — *checked over every revision* | **1** | `NO RECORD IN ANY REVISION (1 revision(s) … not one of them carries a digest for any reviewer report, so the history confirms nothing about what was received)` |

Measured from `/tmp/t20/A` and `/tmp/t20/B`. The mode is read for **every** revision, not only the
oldest, which is the right shape — the author's own `B2` note shows a single commit can start a
fresh first revision, so an oldest-only check would have been another one-layer-down fix.

## 2. `B2`, the rename route — closed for a moved **directory**

A promotion commit built as one ordinary commit: `git mv phase14 phase14-promoted` **plus** the
report tampered **plus** the row hand-forged, with **no counterpart** at all, nothing rewritten.

| code under test | rc | result | from |
|---|---|---|---|
| `03b3a0b` | **0** | *checked over every revision*, with **1 of 3** revisions actually read | `/tmp/t20/C` |
| `27c76c3` | **1** | `REVIEWER ROW REWRITTEN IN HISTORY: … recorded as 23f87ee03797 … (eaec18c47089) records 1dff427ea1b1` | `/tmp/t20/C` |

`git rev-list HEAD -- ':(top,glob)**/P14-HANDOFF-MANIFEST.md'` finds **3** revisions where the
current path finds **1**; that is the whole fix and it works.

## 3. `B3` — an unverifiable history now certifies nothing, in all four shapes

Depth-1 clone of this head, every reviewer row (21) and every reviewer file removed from the pack
copy, the counterpart varied:

| counterpart | rc | from |
|---|---|---|
| absent (the CI shape, no shared folder) | **1** | `/tmp/t20/sh` |
| a **regular file** where a directory is expected | **1** | `/tmp/t20/sh` |
| an **empty** directory | **1** | `/tmp/t20/sh` |
| populated | **1** | `/tmp/t20/sh` |
| populated, **with** `--allow-unverified-history` | **0**, and the limit still on stdout | `/tmp/t20/sh` |

The refusal is now unconditional on `NOT CHECKED`, which is what makes all four agree. **The opt-in
cannot be switched on by the environment:** the tool reads no environment variable anywhere
(`grep -n 'environ\|getenv'` returns nothing), and the flag is a bare `store_true` with no
`default=` of its own.

## 4. `B1` — the dead strings and the flag that never existed

| check | result |
|---|---|
| `manifest-digests.py --require-history --check` | **2**, *unrecognized arguments: --require-history* — so a CI job following the old gate definition did break the gate |
| `--require-history` in `P14-TASK-DAG.md` (the gate definition) | **0 occurrences**; it survives only in the superseded reviews and in `RETRACTED-CLAIMS.tsv` |
| `shallow-with-counterpart-passes` (the retracted proof name) | a row in `RETRACTED-CLAIMS.tsv`, allow-listed to the two reviews and `README-AR.md` |
| the five proof names the gate definition does cite | all five exist in `gate-sweep.sh` — `manifest-dropped-and-readded`, `…-write`, `shallow-counterpart-refused`, `shallow-optin-prints-the-limit`, `shallow-no-witness-names-the-clone` |
| `retracted-claims.py --check` | **0** — *18 retracted claim(s) enforced across 29 pack document(s)* |

I checked the one that looked wrong: `shallow-counterpart-refused` **is** in the live gate
definition, and it is a real proof, not a retracted string.

## 5. Their figures, reproduced

From a world-readable clone with the cluster up:

| what | result | from |
|---|---|---|
| `tools/gate-sweep.sh` (full) | **0**, **53 ok**, 0 FAIL | `/tmp/mr20`, `/tmp/mr20/…/phase14`, `/tmp` — identical from all three |
| `proofs/replay.sh` | **0** — *46 case(s) replayed, 0 not at their required exit code* | `/tmp/mr20/…/phase14` |
| `proofs/redproof-preflight.sh` | **0** — *5 arm(s), 0 not red*, version arm **UNFENCED** | `/tmp/mr20/…/phase14` |
| `manifest-digests.py --check`, pack and shared folder | **0** / **0**, **48 rows / 48 files** each | `/tmp/mr20/…/phase14` |

## 6. Every new guard, deleted

Baseline in a clone I control: **rc 0, 45 ok, 0 FAIL** (`--no-db`). Four mutations, each asserted
to have landed:

| guard deleted | rc | which proofs went red |
|---|---|---|
| the mode check (`_bad = [...]` → `_bad = []`) | 1 | `symlink-manifest-refused` |
| `NO RECORD IN ANY REVISION` (renamed to a `checked …` string) | 1 | `no-record-in-any-revision` |
| the name anchor (`':(top,glob)**/%s'` → `'./%s'`) | 1 | `manifest-moved-and-forged`, `…-write` |
| `B3`'s refusal condition, reverted to its pre-`B3` form | 1 | `shallow-no-counterpart-refused`, `shallow-counterpart-is-a-file`, `shallow-counterpart-empty` |

Each guard reds its own proofs and only those. **The move proof asserts its message, not merely a
non-zero code** — `named manifest-moved-and-forged 1 "REWRITTEN IN HISTORY"` — which matters
exactly as the author says: with the walk mutated, that world still exits 1 by a different
refusal, so a proof requiring only non-zero would have passed the mutant. It also refuses to
judge at all unless its world was built (`1` revision at the new path and `2` by name).

---

## 7. Findings

The blocking finding of this round, `R14-P0-01`, is not in this list: it came out of the
repository's own gates and is stated with its evidence in §9 and §10.

### `R14-P2-01` — the anchor moved from the path to the **name**, and the name is the attacker's too

One ordinary commit that renames the manifest to a **different basename** *and* moves it out of the
artifact directory, carrying the tampered report and the forged row:

```
reviewer-row history checked over every revision of the manifest, OLDEST first
every artifact row matches the file on disk, and every file has a row.
rc=0        (measured from /tmp/t20/E, --manifest …/MANIFEST-PROMOTED.md --dir …/phase14)
```

**1 of 3** revisions was read — the forging commit — and the line still says *checked over every
revision*. No history was rewritten, no counterpart was needed, and `03b3a0b`'s tool answers `0`
here too, so this is not a regression: it is the same class one step over, and `B2`'s remedy is
itself name-shaped.

**Why I did not block on it.** With the gate as defined the same change is **fail-closed**: the
default `--manifest` is the pack's fixed path, so after the rename `manifest-digests.py --check`
answers **2** — *CONFIGURATION ERROR: --manifest … does not exist. This is not a stale manifest and
must not be read as one.* I measured that. The route therefore needs the verifier to be re-pointed
at the new name, which no gate in this pack does — and `B1` is a reminder that a gate definition
can be wrong about its own flags, which is why this is P2 and not P3.

**Remedy, and I checked that it is available.** The witness for a report is not a property of a
file path or a file name; it is the oldest digest recorded for **that report** anywhere in the
history. In my world `git log --all --format=%h -S'P14-CHALLENGE-test.md' -- '*.md'` returns the
two earlier commits that the name anchor missed. Anchoring on the row's own subject — the report
name — closes the directory move, the basename change and the next variant together, and it is the
only anchor the forger does not get to choose.

### `R14-P3-01` — one refusal in this family is incidental

Renaming the manifest **inside** the artifact directory is refused, but for an unrelated reason:
the renamed file becomes a `.md` in `--dir` with no row, so the answer is
`P14-HANDOFF-MANIFEST-V2.md: ARTIFACT WITH NO ROW` (rc **1**, `/tmp/t20/D`; `03b3a0b` also 1). The
verdict is right and the sentence says nothing about the history anchor, which is the thing a
reader needs to know there. One clause would fix it.

### `R14-P3-02` — the opt-in's help is wider than the opt-in

`--allow-unverified-history` reads *“accept a manifest history that cannot be read in full”*, but
it does not excuse `NO RECORD IN ANY REVISION`: measured, World B with the flag still answers
**1**. I think the behaviour is right — a history that was read completely and recorded nothing is
not an unreadable history — so this is only the help text.

### Carried, unchanged

`R-1` (the headline counts are unfenced, named not fixed), `COORD P3-07`, `R10-ADD-01`, the
PROPOSES-new-directory property, the **version arm UNFENCED**, **concurrency and performance
UNMEASURED**, Node and CI not run, `TL-P14-SEC-01/-02/-03`, `OD-P14-09/-10/-11`. None is touched by
this commit, as Amendment 18 says.

I also note the author's two self-recorded mistakes in making this commit — a refusal keyed to
`not signed_history`, which carries every row any revision recorded and so could never fire, and
two heredocs passed through a non-raw Python string, which turned `\n` into real newlines so the
symlink proof's forge never landed and it passed on an untampered world. The second is why that
proof now asserts **both** halves of its premise, the mode and that the forge landed. Both are the
reason I re-measure premises rather than outcomes, and I verified the premise assertion is there.

## 9. The repository's own gates, run from fresh clones on Node 24

This is the first round in which I ran the **repository's** gates rather than only the phase's
suite. The coordinator made it a standing requirement this round; it should have been mine from
round 1. Three clones, each cloned fresh from `origin` and world-readable, `npm ci` first, then
the gate scripts **by the names `package.json` gives them**:

| world | head | `npm ci` | `npm run format` | `npm run lint` |
|---|---|---|---|---|
| `/tmp/g24a` | `27c76c3` (this subject) | **0** | **1** | **1** |
| `/tmp/g24b` | `03b3a0b` (round 13, which I signed) | **0** | **1** | **1** |
| `/tmp/g24c` | `6fc505d` (`main`, the branch's merge-base — pre-Phase-14) | **0** | **0** | **1** |

Engine and pinned tools, read from the installed tree, not from the manifest: `node v24.21.0`
(tarball `node-v24.21.0-linux-x64.tar.xz` verified against that release's `SHASUMS256.txt`),
`npm 11.19.0`, `prettier 3.7.1`, `eslint 9.39.1`.

**`npm run format` — RED, and Phase 14 is the whole of it.** `prettier --check .` flags exactly
**one** file at both Phase 14 heads:

    [warn] phase-preparation/phase14/P14-OPENAPI-SKELETON.yaml

Nothing else in the repository is flagged, and the same command is **rc 0** at `6fc505d`. The
file carries blob `ba2d1d3d9d96a57db013d6dbb711d971047ba7e8`, and that blob is byte-identical at
**every one of the thirteen heads this lane has reviewed** — `08d23da`, `23b24ca`, `2430504`,
`2b5d19f`, `50b0341`, `583a4a0`, `6f744c1`, `7af6438`, `fcb85f8`, `a725342`, `8f6c849`,
`03b3a0b`, `27c76c3` — generated with `git rev-parse <sha>:<path>` per head, not typed. It entered
in `08d23da`, the branch's **first** Phase 14 commit, and has never been touched since. So the
gate has been red for the whole life of this branch and no reviewer, me included, ran it.

The remedy is seven lines and I measured that it is sufficient: `prettier --write` on that one file
changes **7 insertions, 7 deletions** (double-quoted YAML scalars the repo's config wants single-
quoted), after which `npm run format` is **rc 0 (cwd `/tmp/g24a`)** — *All matched files use
Prettier code style!* I reverted the file immediately (`git checkout --`, tree clean) and pushed
nothing. This is in my own clone; no file of the author's was touched.

**`npm run lint` — RED, and Phase 14 is none of it.** `eslint . --max-warnings 0` is rc 1 with
**4,220 errors** at all three heads. Normalised for the clone prefix, the three logs are
**byte-identical**, sha256 `ffd4388c1b0a3e93541b69f496cea242479bbc1a9e9c7b62b8e3560b23cce361` for
each of `27c76c3`, `03b3a0b` and `6fc505d`, and `diff` between them is empty. The flagged files are
139 under `apps/`, 20 under `tests/`, 2 under `packages/`; zero mention `phase14`. Phase 14 adds
not one error, and does not remove one either. This is a **pre-existing red on `main`** and a
repository-level item, not this phase's — the known `G6` item covers root `build` and `typecheck`;
**`lint` red on `main` with 4,220 errors is not in that item and should be added to the queue.**

Nothing here is a reason to relax the format verdict. A gate the phase turns red blocks the phase
even when a different gate was already red before it.

## 10. Withdrawal of my earlier signatures in this lane

Under the P4 round-20 ruling — *a head that turns a repo gate red carries no signature* — and on
the blob evidence above, **I withdraw every PASS-WITH-SCOPE signature I have issued in the Phase 14
lane**: `08d23da`, `23b24ca`, `2430504`, `2b5d19f`, `50b0341`, `583a4a0`, `6f744c1`, `7af6438`,
`fcb85f8`, `a725342` and `03b3a0b`, together with their addenda. The round-12 `REJECT` at
`8f6c849` stands as it was. No head on this branch has ever been format-green, so there is no
earlier head to fall back to.

What the withdrawn rounds **measured** is not withdrawn: the defects they found were real, the
old-tool-against-new comparisons stand, and the author's fixes for them stand. What is withdrawn
is the certification that those heads were fit to merge. They were not, and the reason was in a
command I had not run.

**`R14-P0-01` (new, blocking).** `npm run format` is rc 1 at `27c76c3` because of
`phase-preparation/phase14/P14-OPENAPI-SKELETON.yaml`, a Phase 14 file, present unformatted since
`08d23da`. Evidence: the table and the blob census above. Remedy: `prettier --write` that one file;
measured to bring the gate to rc 0 with a 7-line change. One commit, no tooling change.

## 11. Signature, withheld

**I do not sign `27c76c3cfa8b35324c6644b23e18b42e1d14a598`**, and I sign no other commit on this
branch. The reason is §9 alone: the repository's format gate is red at this head and Phase 14 is
the whole of the red.

**What I did verify at this head, and will stand behind when the gate is green:** `R13-P2-01` both
halves, `B1`, `B2` for a moved directory, `B3`'s four shapes and the opt-in, the four guard
deletions, and the figures in §5 — all as measured above. `R14-P2-01` remains an open P2 with its
precondition. That list is a record of measurement, not a signature, and it does not become one
until `R14-P0-01` is fixed and I have re-measured the gate at the fixed head. A signature covers
one SHA and does not transfer.

**Restated, unchanged since round 4:** no finding in this lane has ever landed on Phase 14's
**architecture**, because the architecture is unexecuted — no API, no DDL, no route, no CI job.
Fourteen rounds have measured the pack's own tooling and prose. None of it is credit against the
first review of an executed Phase 14, which should be expected to be worse than all fourteen.

**What I did not do:** no file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; the cluster was a scratch cluster on `/tmp/p14pg`
and no frozen migration was read or written. This report has no manifest row yet, so the
shared-folder lane will read `ARTIFACT WITH NO ROW` until the author writes one.
