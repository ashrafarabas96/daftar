# P14 — AMENDMENT 20: the repository's own format gate, red since the branch's first commit

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Migration-freeze reference `93084f8` — *not* the branch base. This branch was cut from
`6fc505d`, which is its merge-base with `main`. Committed and pushed on
`claude/project-thread-1zqgj8` only. No product code, no migration, no migration number.**
No timing or performance claim is made anywhere in this pack.
**Unsigned, and now unsigned at every head: every signature in this lane is WITHDRAWN.**

| review | file, as received | verdict |
|---|---|---|
| **Independent challenger**, round 14 at `27c76c3` | `P14-CHALLENGE-27c76c3.md`, sha256 `b3afc2b07df7…7c6ddbee`, 17,332 bytes | **REJECT**, scoped to the repository's own format gate. `27c76c3` not signed, **and every earlier signature withdrawn** |
| **Coordinator ruling** on that round | relayed, recorded here | the REJECT **stands**; Phase 14 has **no signed head** |

---

## 1. `R14-P0-01` (BLOCKING) — `npm run format` has been red for the whole life of this branch, and no reviewer ran it

**The finding, and it is the worst kind this lane has produced: not a wrong sentence about a
proof, but a gate of the repository that nobody — the author, the challenger, three coordinator
reviews — had ever executed.** Fourteen rounds of tooling built, mutated and red-proofed inside
this pack, while `prettier --check .` was failing on a file the pack itself added.

**Verified by me**, with the pinned toolchain from the repository's own lockfile
(`npm ci`, exit **0**; prettier **3.7.1**, the version `package-lock.json` pins; node v22.22.0 in
this container):

| world | `npm run format` | what it printed |
|---|---|---|
| **subject**, `27c76c3` as checked out | **1** | `[warn] phase-preparation/phase14/P14-OPENAPI-SKELETON.yaml`, and nothing else in the repository |
| **merge-base**, `6fc505d` (`main`'s tree, in its own worktree) | **0** | *All matched files use Prettier code style!* |
| **this commit** | **0** | *All matched files use Prettier code style!* |

**One file, and it never changed.** `P14-OPENAPI-SKELETON.yaml` is blob
`ba2d1d3d9d96a57db013d6dbb711d971047ba7e8` at `08d23da` (this branch's first Phase 14 commit), at
`03b3a0b` and at `27c76c3` — read with `git rev-parse <sha>:<path>`, not typed. So the gate went
red with the file's arrival and stayed red for thirteen reviewed heads.

**The fix is the one the challenger measured sufficient**: `prettier --write` on that one file with
the pinned binary — **7 insertions, 7 deletions**, every one a double-quoted YAML scalar becoming
single-quoted, which is what `.prettierrc.json`'s `"singleQuote": true` asks for. No key, value,
path, schema or description changed; `git diff` is quotes only. No tooling, config or ignore file
was touched.

**`npm run lint` is NOT this phase's**, and this commit does not touch it. It exits 1 at the
subject, the previous head and the merge-base alike; the challenger normalised the three logs and
found them byte-identical. It is inherited from `main` and it is not an excuse for the format red.

**Signatures.** Under the coordinator's standing rule (`P4 r20`) a head that turns a repository
gate red carries no signature. The challenger has therefore withdrawn every `PASS-WITH-SCOPE` and
every signature it issued in this lane, `a725342` and `03b3a0b` included, and the round-12
`REJECT` at `8f6c849` stands. **Phase 14 has no signed head.** Nothing in this pack may be cited
as reviewed-and-signed until a head passes the three repository gates and the phase suite
together.

**The lesson, recorded for every phase:** a phase's own suite being green says nothing about the
repository's gates. Run the repository's gates — `npm ci`, `npm run format`, `npm run lint`,
`npm run build`, `npm run typecheck` — against the subject head, the previous head and the
merge-base, and report them as a three-world table, before claiming any head is reviewable.
`P14-GATE-035` now carries that requirement.

## 2. `R14-P2-01` — rename to a different basename *and* move out of `--dir`, in one commit with the forge

Amendment 19 closed `B2` by anchoring the walk to the manifest's **name** anywhere in the tree.
That closes a move. It does not close a move **plus a rename to a different basename** in the same
commit as the forge: the new basename then has exactly one revision, the forging one, so the walk
read **1 of 3** and printed *checked over every revision*. The challenger filed it non-blocking
because under the gate's default `--manifest` the same world answers **2 CONFIGURATION ERROR**;
**the coordinator ruled it must refuse by name under every invocation**, and that ruling is what
this commit implements.

**The fix.** The revision set is the **union** of two questions git can answer, and each revision
is read at the path **it** had:

- every path whose basename is this manifest's, anywhere in the tree (Amendment 19's anchor);
- `git log --follow` on this manifest's own path, which crosses a rename when git scores one — and
  a forged manifest is ~99% similar to the one it replaces, which is exactly when `--follow` sees
  it.

Neither question is sufficient and neither is trusted alone: the first misses a basename change,
the second misses a move git does not score. And the printed line now states **how many revisions
were read** — *"checked over all N revision(s) of this manifest reachable from HEAD"* — so a walk
that read one can no longer be read as a walk that read twenty.

**Measured by me**, the verifier pointed at the renamed file, which is the shape that answered 0:

| what | result |
|---|---|
| revisions of the new basename `LEDGER.md` | **1** |
| revisions `--follow` sees for that path | **2** |
| **`27c76c3`**'s tool | **rc 0** — *reviewer-row history checked over every revision of the manifest, OLDEST first* |
| **this head** | **rc 1** — `REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-7af6438.md …`, over *all 2 revision(s)* |

Fenced by `manifest-renamed-and-moved` and `-write`, with the premise asserted first (one revision
by basename, more than one by `--follow`).

**And a measured correction inside the fix.** My first version passed `--follow` a path relative to
the repository root while `git -C` was the manifest's own directory, so the pathspec matched
nothing, the union never fired and the plant still answered **0**. `:(top)` anchors it. A guard
that cannot fire is not a guard — the third time this lane has recorded that.

## 3. `R14-P3-02` fixed, `R14-P3-01` named

- **`R14-P3-02` fixed.** `--allow-unverified-history`'s help text said it accepts *"a manifest
  history that cannot be read in full"*, which reads as covering `NO RECORD IN ANY REVISION` too.
  It does not, and measurably: with the flag that state still refuses at **1**, because a history
  that **was** read and records nothing is not a history that could not be read. The help text now
  says which state it covers and which it does not.
- **`R14-P3-01` NAMED, not fixed.** A rename of the manifest **inside** `--dir` is refused, but
  incidentally — as `ARTIFACT WITH NO ROW` for the new name rather than as a statement about the
  manifest. The refusal is sound and the exit code is right; what is missing is the sentence. It is
  recorded as a residual in `P14-TASK-DAG.md` rather than patched with a special case, because the
  honest fix is the same generated-baseline work that `R-1` needs.

## 4. Item (d) — what `93084f8` is

Every header in this pack that says *base `93084f8`* means the **migration-freeze reference**: the
tree this phase's live-code citations were verified against, past which migrations are frozen. It
is **not** the branch base — this branch was cut from **`6fc505d`**, its merge-base with `main`,
and `93084f8` is not an ancestor of it. That statement is now in the headers of the three live
documents a reader meets first (`P14-HANDOFF-MANIFEST.md`, `P14-TASK-DAG.md`, `README-AR.md`), and
two rows in `tools/RETRACTED-CLAIMS.tsv` fence the wrong readings (*"branch base `93084f8`"*,
*"cut from `93084f8`"*) so they cannot enter any document. The 133 existing citations are not
rewritten: they are correct under that reading, and a sweep of 133 lines would churn every digest
in the pack for no gain in truth.

## 5. What is still open at this head

`R14-P3-01` and `R-1` above; `COORD P3-07`; `R10-ADD-01`; the PROPOSES-new-directory property;
the preflight **version arm UNFENCED**; **concurrency and performance UNMEASURED**; `npm run lint`
inherited from `main` (4,220 errors, not this phase's); `npm run build` and `npm run typecheck`
red cold on `main` (`G6`, the CI-owner queue's, not this phase's); `TL-P14-SEC-01/-02/-03`, §7a and
§11a with the Security and Migration Owners, no migration number named; and `OD-P14-09`,
`OD-P14-10`, `OD-P14-11` with the owner.

**No head of this phase is signed.** The next verdict is the challenger's, and it will include the
repository's gates.
