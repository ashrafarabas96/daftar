# P14 — INDEPENDENT CHALLENGE, narrow check at `8f6c849`

**Round 12 (narrow check).** Reviewer: the independent Phase 14 challenger, own container, own
clones, own cluster. **Verdict: `REJECT` (scoped).** One blocking finding and one fail-open.
Everything this commit set out to do, it does — the two routes it closes are closed, measured
against the old tool — and the remedy for one of them re-opened `R-08` one layer down.

- **Head checked:** `8f6c849ef9bb4b2504094bd9b7a678598bcca52b`, pinned with
  `git ls-remote origin claude/project-thread-1zqgj8` before anything was read, equal to the
  fetched ref. Delta `a725342..8f6c849` = **12 files, 882 insertions, 59 deletions**.
- **Cluster:** PostgreSQL **160015** (16.15), `datcollate = en_US.utf8`, `initdb` and every
  `psql` as the unprivileged `claude` account, port 54314 on `/tmp/p14pg/sock`.
- Every exit code is recorded with the directory it was measured from. Every finding carries
  its round number.

---

## 1. `P2-01-bis` — drop the manifest, re-add it with a forged row. CLOSED BY EXECUTION.

Built as two ordinary commits, no history rewritten (`8f6c849` is still an ancestor of my
HEAD): **step 1** `git rm` the manifest; **step 2** the report `P14-CHALLENGE-50b0341.md`
tampered in **both** directories, the manifest re-added with its row hand-forged to
`ab9fc9146969` / 10,501.

| code under test | command | result | measured from |
|---|---|---|---|
| baseline `8f6c849` | `--check` | **0** — 42 rows / 42 files, *checked … OLDEST first* | `…/scratchpad/tw18` |
| **`8f6c849`** on the plant | `--check` | **1** — `REVIEWER ROW REWRITTEN IN HISTORY … recorded as e89fcb1c90ea … a later revision (a3da9bb446b3) records ab9fc9146969`, and the history line records *the manifest is ABSENT in 1 of them (411d345e8166) — removed and re-added* | `…/scratchpad/tw18` |
| **`8f6c849`** on the plant | `--write` | **1**, and the manifest file was left byte-identical (`cmp`) | `…/scratchpad/tw18` |
| **`a725342`** (previous tool), **identical plant** | `--check` | **0** — *history NOT CHECKED (revision 411d345e8166 … could not be read)* and *every artifact row matches* | `…/scratchpad/tw18` |

Same world, two tools, `0` against `1`. The route is closed and the closure is a measurement.

`R11-P3-01` is closed in the same output: the refusal now says **“This refusal cannot be
cleared from here”** and names what can be done instead.

## 2. `R11-P2-01` — the shallow clone. CLOSED, and the opt-in does not hide the limit.

Depth-1 clone of the planted repository, counterpart present and matching:

| run | rc | what it printed | from |
|---|---|---|---|
| no flag | **1** | `HISTORY NOT VERIFIED: … Fetch the full history (fetch-depth: 0) and re-run, or pass --allow-unverified-history` | `…/scratchpad/sh18` |
| `--allow-unverified-history` | **0** | the limit still on stdout: `reviewer-row history NOT CHECKED (revision a3da9bb446b3 is the shallow boundary of this clone …)` | `…/scratchpad/sh18` |

I could not make the opt-in hide the limit: it is printed from the one unconditional `manifest:`
line, before the flag is consulted, and `--check`'s refusals go to stderr while that line goes to
stdout, so silencing stderr does not silence it. **`R11-P2-02` is closed too** — in a fresh
depth-1 clone with no counterpart the refusal now reads *“no digest for it is visible in the
revisions this clone has”*, which is the sentence the code can support (rc **1** from
`…/scratchpad/sh18b`).

## 3. The author's run, reproduced

My container's `/tmp/claude-0` is `drwx------ root`, so the unprivileged account cannot read a
pack under it: the sweep answers **1** there with 7 failures, all `Permission denied` on the
proofs. That is my layout, not the pack — filed as such in earlier rounds. From a
world-readable clone every figure reproduces:

| what | result | from |
|---|---|---|
| `tools/gate-sweep.sh` (full, with the cluster) | **0**, **38 ok**, 0 FAIL, *0 gate(s)/proof(s) not as required* | `/tmp/p14r18/…/phase14` |
| the same sweep, cwd varied | **0** / 38 ok / 0 FAIL from `/tmp`, `/tmp/p14r18`, `…/phase14` | three cwds |
| `proofs/replay.sh` | **0** — *46 case(s) replayed, 0 not at their required exit code* | `/tmp/p14r18/…/phase14` |
| `proofs/redproof-preflight.sh` | **0** — *5 arm(s), 0 not red*, version arm UNFENCED | `/tmp/p14r18/…/phase14` |
| `manifest-digests.py --check`, pack dir and shared folder | **0** / **0**, **42 rows / 42 files** each | `/tmp/p14r18/…/phase14` |
| `--write` with one reviewer row and one amendment row removed | **1**, and the two causes are now distinct: one `SIGNED REVIEWER ROW REMOVED`, one `SIGNED ROW REMOVED` | `…/scratchpad/tw18` |
| `R-04`'s lock refusal, met by accident | **5**, *“This is not another run holding it; it is this run unable to take it at all”* — correct, the lock file was root-owned after my first sweep | `/tmp/p14r18/…/phase14` |

---

## 4. Findings

### `R12-P1-01` — BLOCKING. A missing BLOB is counted as a deletion, so the witness is dropped while the tool says *checked*

The remedy for `P2-01-bis` narrowed `NOT CHECKED` to a missing **commit** object. A revision
whose manifest `git show` cannot read is now tested with `git cat-file -e <rev>:<path>`, and when
that fails the revision is recorded as a **gap** — *“removed and re-added, which does not erase
the records before it”*. But `cat-file -e` fails for **two** different reasons: the path is not in
that tree, **or** the blob is not available. The second is a `--filter=blob:none` partial clone
whose promisor cannot be reached, a pruned object, a corrupt object.

Measured with the real tool (`tools/manifest-digests.py` copied from `8f6c849`) in a
purpose-built scratch repository — one reviewer report, one manifest row, three states:

| state | rc | what it printed | from |
|---|---|---|---|
| the report as received | **0** | *every artifact row matches* | `…/scratchpad/mb/repo` |
| tampered in both dirs + hand-forged row, objects intact | **1** | `REVIEWER ROW REWRITTEN IN HISTORY … recorded as f035b6b8f692` | `…/scratchpad/mb/repo` |
| **the oldest revision's manifest blob deleted** (`7a6ef799f83d`) | **0** | *reviewer-row history **checked** over every revision of the manifest, OLDEST first, and the manifest is **ABSENT** in 1 of them (3b66cf58e5cc) — removed and re-added, which does not erase the records before it* | `…/scratchpad/mb/repo` |

No flag was passed. No limit was announced. Two sentences in that line are false as measured:
the manifest is **not** absent in `3b66cf58e5cc` — the path is in the tree, its blob is
unreadable — and the records before it **were** erased from the witness, which is why the
forgery passes. Before this commit that revision was `NOT CHECKED`; this is `R-08` re-opened one
layer in, and it is the pack's own doctrine inverted: an unverifiable history must say so, and
here it says the opposite.

**Threat model, stated honestly:** this is object *unavailability*, not something a forger does
to the verifier's machine. It matters because blobless clones are a normal CI shape for large
repositories, because `git gc` and object corruption produce it, and because the gate's promise
is that it cannot be made to say *checked* when it has not checked.

**Remedy, measured.** Ask the **tree**, which needs no blob:

```
git ls-tree --name-only <rev> -- P14-HANDOFF-MANIFEST.md
   blob deleted, path present  -> prints "P14-HANDOFF-MANIFEST.md"
   genuine deletion revision   -> prints nothing
```

I ran both: the entry prints in my broken repository, and nothing prints for the real deletion
revision `411d345e8166`. So record a gap only when `ls-tree` is empty; any other failure is
`NOT CHECKED`. (`git rev-parse <rev>:<path>` does **not** discriminate — it exits 0 and echoes
the string for a deleted path. Do not use it.)

### `R12-P2-01` — a fail-open: in a shallow clone, deleting every review passes at `0`

`HISTORY NOT VERIFIED` fires only `if … any(n.startswith(REVIEWER_PREFIXES) for n in listed)` —
only when a reviewer row survives. And the detector that would catch the deletion,
`SIGNED ROW REMOVED`, reads `signed_history`, which `NOT CHECKED` empties. Both protections are
switched off by the same condition, so the two readings of “no reviewer row” — *this manifest
never had one* and *every one was just deleted* — are indistinguishable, and the gate takes the
permissive one.

| world | action | rc | from |
|---|---|---|---|
| depth-1 clone | all **18** reviewer rows and their 18 files removed | **0**, *every artifact row matches*, 24 rows / 24 files | `…/scratchpad/sh18` |
| full history | the identical removal | **1**, **18** `SIGNED REVIEWER ROW REMOVED` refusals | `…/scratchpad/tw18` |

The commit's own title is *“NOT CHECKED is not a pass.”* In this one shape it is.

**Remedy:** when the history is `NOT CHECKED`, refuse if the **counterpart directory** holds
reviewer reports, not only if the manifest still lists one. In the run above that directory held
all eighteen while the manifest listed none — the witness the refusal's own sentence names was
sitting there unread. One `os.listdir(wdir)` closes it.

### `R12-P2-02` — the `no-cluster` proof never checks that its own stop took effect, and that is the disclosed failure

The sweep stops the cluster with `pg_ctl … stop >/dev/null 2>&1` and **neither reads its exit
code nor asks whether anything still answers**, then requires the preflight to exit 1 *and* to
say *“no cluster is listening”*. The restart two lines later **is** verified (`no-cluster-revert`
asserts `select 1`). The asymmetry is the defect: if the stop does not take hold, the proof
measures a different world, and its FAIL line then reports a code and a missing sentence with no
cause — which is exactly what was disclosed at `20:24:17Z`.

I reproduced those conditions by execution. With the cluster **up** and `p14_merchant` left
renamed — the state an **interrupted sweep leaves behind**, because the sweep's own
`rolecount-discriminates` proof renames that role and renames it back:

```
proofs/redproof-preflight.sh   ->  rc=1    'no cluster is listening' present: 0
   FAIL rolecount  exit=3 but the required message is absent: … 2 of the 4 roles …
   (measured from /tmp/p14r18/phase-preparation/phase14)
```

rc **1** with the sentence **absent** — the two conditions the FAIL line reports, and it names
no cause. With the roles intact the same command answers **0**. So the cause is claimable: the
proof's premise was never asserted. **Remedy:** after the stop, require `select 1` to fail
before judging the preflight, and if the cluster still answers, print *the stop did not take
effect* instead of a verdict about the preflight.

### `R12-P3-01` — residue the sweep can leave, and nobody cleans

`rolecount-discriminates` renames `p14_merchant`, and `no-cluster` stops the cluster; neither is
inside the `trap` that restores the pack's **files**. An interrupted sweep therefore leaves the
cluster stopped or a role renamed, and the next sweep measures that. Extending the trap to the
cluster state costs two lines and removes a whole class of unexplained reds.

---

## 5. Signature and its scope

**I do not sign `8f6c849`.** `R12-P1-01` is a false measured claim and a fail-open in the code
this commit changed; `R12-P2-01` is a fail-open. Under the coordinator's stopping rule either
blocks. Everything else in this check passed, and §1–§3 are mine to stand behind at this head.

**Restated, unchanged since round 4:** no finding in this lane has ever landed on Phase 14's
**architecture**, because the architecture is unexecuted — no API, no DDL, no route, no CI job.
All twelve rounds have measured the pack's own tooling and prose. None of it is credit against
the first review of an executed Phase 14.

**What I did not do:** no file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; the cluster I built is a scratch cluster on
`/tmp/p14pg` and no frozen migration was read or written. This report has no row in the manifest
yet, so the shared-folder lane will read `ARTIFACT WITH NO ROW` until the author writes one.
