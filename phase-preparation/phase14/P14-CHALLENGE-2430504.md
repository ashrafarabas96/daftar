# PHASE 14 — INDEPENDENT CHALLENGE, ROUND 6 AT `2430504`

**Challenger:** a session that wrote no part of the Phase 14 pack.
**Target:** `claude/project-thread-1zqgj8`, two commits —
`f7b4f99` (*"a count, a digest and a one-family replay all stop being claims"*,
16 files, +1224/−76) and `2430504` (*"the absent 0079 is the freeze boundary,
not a surface fact"*, text only).
**Declared base of the pack:** `93084f8`. **Date:** 2026-10-12.
**This report's signature scope names `2430504` exactly.**

## VERDICT — PASS-WITH-SCOPE

Every claimed fix is real and I reproduced every reported exit code. Round 5's
`P2-01` is closed **structurally**, which is the right kind of fix. The two new
generators are not just present, they go red when I corrupt what they measure —
I checked, because a gate that has never failed is not a gate.

It is not a plain PASS for one reason, and it is a reason I helped create: the
sentence `2430504` adds is **false**, and it is false because it adopted an
imprecise remark of mine verbatim. The freeze boundary *is* readable at
`6fc505d`. It reads **`0073`**. And the file that carries it is the one cited
file the generated provenance table structurally cannot see.

## 0. TWO CORRECTIONS TO MY OWN EARLIER REPORTS

**(a) Round 4's count was wrong in kind.** I reported *"eleven cited files
differ, not six"*. **Six of those eleven are not differing files — they are
ABSENT at `6fc505d`**: `customers.controller.ts`, `pos-permissions.ts`,
`pos-cart-routes.ts`, `receivables.controller.ts`,
`till-sessions.controller.ts`, `invoices.ts`. I used `git diff --numstat`, which
reports a file added in the gap as `+N/−0`, and I ran `cat-file -e` only on the
subset whose numstat came back empty. The generated answer —
**35 cited files: 5 DIFFER, 21 identical, 9 ABSENT** — is correct; I re-resolved
every row against both trees myself and it reproduces exactly. The five that
genuinely differ are `database.ts`, `permissions.ts`,
`inventory-authorization.ts`, `error.filter.ts`, `static-guards.ts`. My finding
was right that the hand-kept table undercounted, and wrong about what the
remainder were.

**(b) Round 5's freeze-boundary remark was imprecise, and the pack has now
adopted it.** I wrote that *"a reader on `6fc505d` cannot verify the
`frozenThrough = 0079` boundary at all"*. `2430504` carries that into §15 and
the amendment in those words. **It is false**, and the truth is sharper — see
`P2-01`. A reviewer's sentence that gets adopted verbatim is a reviewer's
responsibility.

## 1. Run identity, measured not quoted

| | |
|---|---|
| Cluster | built by me; `server_version` **16.15**, `p14scratch` → `UTF8`, `datcollate = datctype = en_US.utf8` |
| Roles | `p14_merchant`, `p14_owner`, `p14_resolver`, `p14_worker` — all `rolsuper=false`, `rolbypassrls=false`, re-read from `pg_roles` |
| Manifest | **22 of 22 rows verified by my own `sha256sum`/`stat` sweep**, digest and byte count |
| Nothing written | no pack file modified; my mutation experiments ran on a copy at `/tmp`; nothing pushed |

## 2. Every reported exit code, reproduced

| What | Reported | Measured |
|---|---|---|
| `./replay.sh` | 0, 43 cases | **0, `43 case(s) replayed, 0 not at their required exit code`** |
| `./replay.sh c7` straight after the full replay | 0 | **0** — `36 case(s) replayed, 0 not at their required code` |
| `./replay.sh c7` again | 0 | **0** |
| `./replay.sh nosuchfamily` | 2 | **2** — *"nothing would be replayed, which is an error, not a pass"* |
| `./run.sh` on a dirty DB | 3 | **3** — refuses with the named leftover grant and tells the reader to replay clean |
| `./redproof-preflight.sh` | 0 | **0** — 5 arms (collation, encoding, BYPASSRLS, SUPERUSER, role count), `0 not red` |
| `citation-provenance.py --check` | 0 | **0** at both `f7b4f99` and `2430504` |
| `manifest-digests.py --check` | 0 | **0** at both |

**Round 5's `P2-01` is closed, and closed in the right way.** The filtered form
no longer chooses whether the database is clean — there is one unconditional
setup path and a filter only selects how far down `ORDER` the replay goes. So
the state that let a leftover grant print `FINDING REFUTED` about a live ruling
cannot be reached through the driver. The `c7c` absence assertion is the belt to
that braces, and its refusal message names the offending script and the remedy.
This is a structural fix where another assertion would have done, and that
choice is the right one.

**And I red-proofed the two new gates myself**, because `GATE-035` claims they
make a typed claim impossible:

- corrupt one manifest digest → `STALE: … row says 000000000000/8,705 bytes,
  file is 8174a5c30753/8705 bytes`, **exit 1**.
- flip one generated provenance row from `DIFFERS` to `identical` →
  `GENERATED CITATION-PROVENANCE BLOCK IS STALE`, **exit 1**.

Both fenced. The deleted orphan is gone, `localedef` has replaced `locale-gen`
while the original run is still recorded as having used it, and the version arm
is recorded UNFENCED rather than quietly claimed — all correct.

## 3. Findings

### P2-01 — THE FREEZE BOUNDARY IS READABLE AT `6fc505d`, AND IT ANSWERS `0073`

`2430504` states, in §15 and in Amendment 09, that **a reader on `6fc505d`
cannot verify the freeze boundary at all**, because `0079` is absent there.

The boundary is not the migration file. It is a field, and the pack says so
itself in three places: *"`frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`
(`infrastructure/database/MIGRATION_MANIFEST.json`)"*. That file is **present at
both trees**:

```
6fc505d   frozenThrough = 0073_default_warehouse_locale_name.sql
93084f8   frozenThrough = 0079_phase4_pos_till_sessions_cart.sql
```

So a reader on `6fc505d` does not fail to verify the boundary. **They verify it,
get `0073`, and conclude the pack's freeze line is wrong by six migrations.**
That is strictly worse than being unable to check, and it is the base-tree
trap's own thesis — a coherent reading of the wrong world — applied to a rule
rather than a citation.

**And the generated table cannot see the file this turns on.** The generator's
pattern is

```python
CITE = re.compile(r'`([A-Za-z0-9_./-]+\.(?:ts|tsx|sql|yaml|yml|kt|js))(?::[0-9][0-9,\s–-]*)?`')
```

`.json` is not in the list, so `infrastructure/database/MIGRATION_MANIFEST.json`
— cited three times, a real repo file, **differing between the trees in exactly
the field that carries the boundary** — appears nowhere in §15's table (I
grepped the generated block: zero rows). The headline is therefore not *"35
cited files"* but *"35 cited files with one of seven extensions"*, and the one
cited file whose difference changes a rule is the one excluded.

This is not the hand-kept list's defect returning; the generator is a genuine
improvement. It is the generator's **scope** being narrower than its sentence.
Two one-line fixes: add `json` to the pattern, and replace the new sentence with
what is actually true — the other tree answers `0073`, so §15 should say the
boundary **contradicts** there rather than being unverifiable. (The rest of
`2430504` is sound: I confirmed the diff is text-only — three `.md` files, no
code, no proof script, no tool — and that `frozenThrough = 0079` really does
appear in **four** places as the boundary itself: `P14-AMENDMENT-01:65`,
`P14-HANDOFF-MANIFEST:35`, `P14-MIGRATION-PATCH-REQUEST:10`,
`P14-S0-ARCHITECTURE-LOCK:505`.)

### P3-02 — THE GENERATED BLOCK CITES A GATE THAT DOES SOMETHING ELSE

The generated text closes with:

> *A reader should not look for these in any tree; `P14-GATE-034` asserts they
> stay absent until the phase is built.*

`P14-GATE-034` is **replay-after-purge** (`P14-AL-38`): *"refusal with
`DELIVERY_PAYLOAD_PURGED`, red proofs that re-projection and empty-body sending
are both refused"* (`P14-TASK-DAG:192`). It says nothing about proposed files,
and no gate in the pack asserts that they stay absent.

Right rule, wrong law number — **round-2 `P1-01`'s species**, the one settled by
re-grounding the claim on `P14-AL-29`. It now lives in generated prose
(`tools/citation-provenance.py:145`), so it will be regenerated identically
every time the gate runs. Either name the gate that does this or drop the
clause.

### P3-03 — A CASE CAN STILL PRINT `LAW HELD` ON A WORLD IT IS NOT IN

`c7c` got an absence assertion because round 5 named it. The class was not
swept. I ran all six pre-fix-state cases directly against the dirty end-state of
a full replay. Four refuse properly and say why — `c2a`: *"EXPECTED THE DEFECT,
GOT A REFUSAL: the table-wide INSERT was already scoped"*; `c6a`: *"DEFECT NOT
REPRODUCED"*; `c7a`: *"FENCE FAILED"*; `c7c`: the new guard. `c3a` and `c9a`
exit 0, and I checked the states: both legitimately still hold (`c9c` narrows
the grant rather than widening it, and `c9a`'s isolation arms still name the
right cause).

`c1a_restrict_column_refused` is the one that misreports:

```
NOTICE:  LAW HELD: refused with SQLSTATE 42501 (expected 42501)
ERROR:   permission denied for table api_keys          (exit 3)
```

At that state `p14_resolver` holds SELECT on seven columns and **`name` is not
among them**, so the first arm's `42501` is about table-level access to an
ungranted column, not about the column the query *restricts* on — which is the
whole law. The case prints `LAW HELD` for the wrong reason, then fails on its
own control. **The exit code is right and the log line is false**, and the
control that would have caught it runs *after* the conclusion rather than
before. This is `daftar-a-red-proof-can-pass-for-the-wrong-reason` in miniature:
move the control above the arm, or assert that `name` is granted before
concluding anything about the restriction. P3 and not P2 because the exit code
is the stated verdict and the driver always starts clean.

### P3-04 — TWO MISCLASSIFICATIONS IN THE "PROPOSED FILES" BUCKET

The generated block lists *"11 … files this phase PROPOSES and that correctly do
not exist yet"*. Two of the eleven are not that:
`cases/c7a_cross_business_accepted.sql` is the **orphan this very commit
deleted**, cited now only in the text recording its deletion; and
`public-api.ts` is counted twice, once as `packages/shared-contracts/src/public-api.ts`
and once as the bare basename, because the basename is not unified with the path
it resolves to. The headline 35/5/21/9 is unaffected — this is the residual
bucket only.

## 4. What held

- 43/43 at required exit codes, exit 0, on the settled target with
  non-superuser non-bypassrls roles; every one of the eight reported exit codes
  reproduced.
- 22/22 manifest rows byte-exact by my own sweep; both generators current at
  both heads and **both red-proofed by me**.
- The three self-found bugs in Amendment 09 are honest, and one of them is a
  real trap worth keeping: **`git rev-parse <rev>:<missing path>` echoes the ref
  instead of failing**, which is what made the first count miss absences. That is
  the same mechanism that made *my* round-4 count wrong, independently.
- **Six rounds, and no finding has yet landed against the pack's
  architecture.** Every defect has been in a document, a citation, or the
  harness.

## 5. Required for a plain PASS

1. **`P2-01`** — add `json` to the generator's pattern, and correct the new
   sentence: the boundary is readable at `6fc505d` and answers `0073`.
2. **`P3-02`** — name the gate that asserts the proposed files stay absent, or
   drop the clause.
3. **`P3-03`** — move `c1a`'s control above its conclusion.
4. **`P3-04`** — unify a bare basename with its resolved path, and drop the
   deleted orphan from the proposed bucket.

*This report does not sign the pack. `PREPARED` / `CHALLENGED` / `NOT
PROMOTED`, `READY_TO_PROMOTE` = NO.*
