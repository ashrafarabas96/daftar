# PHASE 14 — INDEPENDENT CHALLENGE, ROUND 7 AT `583a4a0`

**Challenger:** a session that wrote no part of the Phase 14 pack.
**Target:** `2430504..583a4a0` — one commit, *"the freeze boundary contradicts,
and a reviewer's sentence is a claim"*, 13 files, +621/−46.
**Declared base of the pack:** `93084f8`. **Date:** 2026-10-12.

## VERDICT — PASS-WITH-SCOPE

The four plants I was asked to set all pass, and one of them passes decisively:
on an identical constructed database the **old** `c1a` prints `LAW HELD` and the
**new** one refuses before it can, so the fix changed behaviour and not only
prose. My own stronger plant passes too — the provenance table is a real scan,
not a maintained row.

It is not a plain PASS because of one thing I found while verifying a reported
exit code: **`citation-provenance.py --check` exits 1 at the pushed head when it
is run from anywhere outside the pack's own worktree.** `P14-GATE-032` runs that
check, so the gate passes or fails according to where it is invoked. That is
the author's own self-reported bug 3 — *"the provenance gate initially disagreed
with itself"* — recurring inside the fix for it, which is the third time this
class has reappeared one layer up.

## 1. Run identity

| | |
|---|---|
| Cluster | built by me; `16.15`, `p14scratch` → `UTF8`, `datcollate = datctype = en_US.utf8` |
| Roles | 4 of 4 `p14_*` roles `NOSUPERUSER` and `NOBYPASSRLS`, re-read from `pg_roles` |
| Manifest | **25 of 25 rows** pass `manifest-digests.py --check`, rc 0 |
| My five reports in the repo pack | **byte-identical** to what I delivered (`6f744c1`, `fcb85f8`, `23b24ca`, `2430504`, `ADDENDUM-01`) — each re-hashed against my own copy, all unedited |
| Nothing written | no pack file modified; every mutation experiment ran on a `/tmp` copy; nothing pushed |

## 2. The four plants

**Plant 4 — a no-match replay exits 2.** `./replay.sh zzzzz` →
*"no ORDER line matches 'zzzzz' — nothing would be replayed, which is an error,
not a pass"*, **rc 2**. And the documented substring surprise is true as stated:
`./replay.sh nope` replays **33 cases, rc 0**, because `inoperable` contains
`nope`. Documenting the trap with the example that produced it is the right
call.

**Plant 3 — `c1a` on moved grants.** I built the state deliberately
(`REVOKE SELECT (name) ON p14s.api_keys FROM p14_resolver`) and ran **both**
versions against it:

```
OLD c1a (at 2430504):  NOTICE:  LAW HELD: refused with SQLSTATE 42501 (expected 42501)
                       ERROR:   permission denied for table api_keys        exit 3
NEW c1a (at 583a4a0):  ERROR:   CONTROL FAILED: p14_resolver cannot read the GRANTED
                                columns (name, business_id) in this state …   exit 3
```

Same database, same role. The old one announces the law and then dies; the new
one refuses before any verdict exists. I then probed the other two arms, which
the brief did not ask for: granting `secret_sha256` gives
`LAW VIOLATED: lookup on an ungranted column SUCCEEDED` (exit 3), and emptying
the table gives `CONTROL FAILED: granted columns readable but empty — the
fixture did not load` (exit 3). **All three arms fire with distinct messages**,
and the SQLSTATE is asserted rather than printed beside the word "expected".
`c1a` is now fully fenced.

**Plant 1 — a differing cited `.json` appears in the rows.** It does:

```
| `infrastructure/database/MIGRATION_MANIFEST.json` | **DIFFERS** (+27/-3) | … |
**37 cited files resolved: 6 DIFFER, 22 identical, 9 ABSENT at `6fc505d`.**
```

and the block now prints the population it scanned, naming all ten extensions.

**My own plant 1b — is it a scan or a row?** I appended a citation of
`apps/web/src/messages/ar.json` — a differing repo file the pack has never cited
— to a copy of `P14-CONTRACT-PACK.md` and regenerated:

```
| `apps/web/src/messages/ar.json` | **DIFFERS** (+142/-1) | … | P14-CONTRACT-PACK |
**38 cited files resolved: 7 DIFFER, 22 identical, 9 ABSENT at `6fc505d`.**
```

Right file, right numstat, right citing document, and both counts moved. **It is
a measurement.**

**Plant 2 — corrupting the population line reds the check.** I removed `.json`
from the printed extension list and nothing else: `GENERATED
CITATION-PROVENANCE BLOCK IS STALE`, **rc 1**.

**And every other reported exit code reproduces:** full replay 43 cases rc 0;
`./replay.sh c7` rc 0 and rc 0 back to back; `redproof-preflight.sh` 5 arms,
0 not red, rc 0, version arm recorded unfenced; on the genuine dirty end-state
`c7c` rc 3 (naming `c7d_setup_grant`) and `c1a` rc 3 (`CONTROL FAILED`);
`manifest-digests.py --check` rc 0.

## 3. Findings

### P2-01 — THE PROVENANCE GATE STILL DISAGREES WITH ITSELF, BY WORKING DIRECTORY

Same head, same tool, same file, same repository:

| Where it is run | `--check` |
|---|---|
| `cd <pack>` → `tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md` | **rc 0**, *"block is current"* |
| any cwd under the pack's worktree | **rc 0** |
| `cd /tmp` (outside any repository), absolute paths | **rc 1**, *"BLOCK IS STALE"* |
| cwd in a **different worktree of the same repository** | **rc 1**, *"BLOCK IS STALE"* |

The author's reported 0 is the first row, and it is honest for that invocation.
`P14-GATE-032` runs this check, so **the gate's verdict is decided by where CI
happens to stand.**

**Cause, named.** `--pack` defaults to the script's own directory;
`--repo` defaults to the **cwd's** `git rev-parse --show-toplevel`, with `'.'` as
the fallback. The two need not be the same repository, and
`was_in_pack()` then computes

```python
rel = os.path.relpath(a.pack, a.repo)        # tools/citation-provenance.py:168
git(a.repo, 'log', '--all', '--oneline', '-1', '--', os.path.join(rel, d, tok))
```

From a foreign cwd that pathspec climbs out of the repository with `../..`, git
refuses it, `was_in_pack()` returns **False for everything**, and the
deleted-scripts bucket silently collapses into the proposed bucket. That one
line is the whole diff between the two verdicts:

```
< - 1 were proof scripts this pack DELETED and still names: `cases/c7a_cross_business_accepted.sql`. …
> - 10 are files this phase PROPOSES … `cases/c7a_cross_business_accepted.sql`, …
```

Two consequences worth separating. **First, the generator has two fixed points,
selected by cwd**: I ran `--write` then `--check` three times from a foreign cwd
and it converges, stably at rc 0, on a block *without* the deleted-scripts line
— a different document from the one committed. **Second, a location problem is
reported as a content verdict.** `BLOCK IS STALE` tells a reader the pack has
drifted from the trees when nothing has drifted; the fix for bug 3 resolved *a*
repo root but not the invariant that the pack must be inside it.

Remedies, either alone: derive `--repo` from `--pack`
(`git -C <pack> rev-parse --show-toplevel`) rather than from the cwd; or make
`was_in_pack()` fail loudly when its pathspec is outside the repository instead
of returning False. The second is the one that makes the gate honest, because it
converts a silent misclassification into a refusal.

### P3-02 — THE RETRACTED "SURFACE FACTS" SENTENCE SURVIVES IN THE HANDOFF MANIFEST

`2430504` existed to remove one claim: that the three absent migrations are
*"cited only for Phase 4 surface facts"*, which is false because `0079` is the
freeze boundary. §15 now carries the corrected account, and Amendment 09 carries
it too.

`P14-HANDOFF-MANIFEST.md:32` still reads:

> *"The conclusion still holds for the stated reason that every migration cited
> **for an RLS policy, a grant or a role** is byte-identical at both, **and the
> three absent ones are cited only for Phase 4 surface facts.**"*

Corrected in two documents and missed in the third — and the third is the
**handoff manifest**, which is the first page a handoff reader reads, and the
very row that narrates the base-tree trap. It also omits the contradiction
itself: a reader of that row never learns the other tree answers `0073`.

This one is unfenced by construction: `manifest-digests.py --check` validates
digests, byte counts and row/file correspondence, so a stale **prose** claim in
the manifest passes it. `GATE-035` cannot see this class at all. Worth saying in
the gate's own text, since the manifest is now the one generated document whose
narrative is still typed.

## 4. What held

- All four plants, plus mine, plus every reported exit code.
- The `.json` fix is not a special case: the extension set is printed, the scan
  picks up a newly cited differing `.json` I planted, and the counts move.
- The freeze boundary is now stated correctly in §15 — **it contradicts** on the
  other tree rather than being unverifiable — with the `0073`/`0079` table.
- The withdrawn `locale-gen` finding is reverted with a pointer to my addendum,
  and the author records that **his own re-diagnosis of it was unmeasured too**.
  Both of us asserting a cause without running the command is the honest record.
- Buckets are resolved by token rather than by name pattern; deleted scripts are
  their own category (when the tool can see them — `P2-01`); the `GATE-034`
  misattribution is corrected; the typed count copies are gone from the four
  documents, and Amendment 09's figure is explicitly marked as that round's
  record rather than maintained.
- 25/25 manifest rows, and my five reports committed **byte-identical**.

**Standing correction carried from my addendum:** the architecture is not
vindicated by seven rounds, it is **unexecuted**. No API, no DDL, no route and
no CI exist in this phase; the harness is the only part that runs, which is why
every defect has been found there. `TL-P14-SEC-01`/`-02`, `§11a` and
`OD-P14-09/-10/-11` are open with their owners, and no migration number is
written anywhere.

## 5. Required for a plain PASS

1. **`P2-01`** — make `--repo` follow `--pack`, and make `was_in_pack()` refuse
   rather than silently answer False when its pathspec leaves the repository.
   `GATE-032` is currently red from any neutral cwd.
2. **`P3-02`** — correct `P14-HANDOFF-MANIFEST.md:32`, and state in `GATE-035`
   that the manifest's prose is outside what its `--check` can verify.

*This report does not sign the pack. `PREPARED` / `CHALLENGED` / `NOT
PROMOTED`, `READY_TO_PROMOTE` = NO.*
