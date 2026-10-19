# Phase 14 — amendment 24: challenge round 18 answered

**Subject reviewed:** `c001cd9e668f9d481d3bc8c92c23df314fefa80c`.
**Verdict received:** REJECT. One P0 fail-open, one P1 false figure. Both conceded.
**Reviewer's words:** `P14-CHALLENGE-c001cd9.md` (12,651 bytes,
`4708f1351a8c8c392557d1f6e4a3585278c477c408da0b211308ab6e69deae8f`), committed unedited and
hashed from the file on disk.

This amendment is the ONE commit owed. Phase 14 remains **PREPARED / NOT PROMOTED** and has
**no signed head at any SHA**.

## 1. `R18-P0-01` — a FAIL-OPEN, conceded, and reproduced here before it was fixed

`tools/manifest-digests.py` made **no** git call with `--no-replace-objects`, and read nothing
from `refs/replace`. git honours replacement objects by default in `rev-list`, `log`, `grep`,
`show` and `ls-tree` — every subcommand this tool uses — so the history witness the entire
verdict rests on was supplied by a ref **inside the repository being judged**.

The world: three honest commits recording a report's true digest, then a forging commit that
appends a line to the report and re-signs its row. Then, with plumbing only
(`hash-object -w`, `read-tree`, `update-index --cacheinfo`, `write-tree`, `commit-tree`,
`git replace -f`), one replacement commit per honest revision, each carrying a manifest that
**already records the forged digest**.

| state | `c001cd9` | this head |
|---|---|---|
| no replacement refs at all | rc 1, `REFUSED: P14-CHALLENGE-test.md`, 4 revisions | rc 1, identical |
| 3 refs under `refs/replace` | **rc 0, no refusal, "all 1 revision(s)"** | **rc 1, REFUSED, 4 revisions** |
| the same 3 refs under `refs/other/` with `GIT_REPLACE_REF_BASE` set, `refs/replace` EMPTY | **rc 0, no refusal, "all 1 revision(s)"** | **rc 1, REFUSED, 4 revisions** |
| the REAL pack | rc 0 | rc 0, unchanged in every figure but the one corrected in §2 |

Control, so the mechanism is not in doubt: at the oldest revision,
`git --no-replace-objects show <oldest>:<manifest>` serves the manifest holding the **true**
digest, and the same `show` without the flag serves the **forged** one. The proof asserts exactly
that — that the tree git serves with replacement differs from the one it serves with the flag —
before it requires the refusal, so a world where replacement is not actually in effect reports
`premise not built` instead of passing.

**The remedy is the flag, not a check.** Row three is the reason: with `GIT_REPLACE_REF_BASE`
pointing elsewhere, `refs/replace` is empty, so a gate that greps for replacement refs reports a
clean repository while the forgery passes. `--no-replace-objects` is now on the **helper**, before
the subcommand, where no call site can forget it — the shape `tools/citation-provenance.py`
already used — and `GIT_NO_REPLACE_OBJECTS=1` is set in the child environment as well, so
replacement cannot be reinstated through the environment either.

**Two red proofs**, `replace-refs-refused` and `replace-refs-off-base-refused`, one per arm.

**This is the Phase 8 and Phase 13 lesson.** Both wrote it down, the sibling tool applies it, and
the one tool whose entire output is a claim about history did not. The honest reading is not that
a rule was missing: it is that a rule already paid for twice was not carried across a file
boundary, and nothing in this pack was checking for that. Scope, measured rather than assumed:
`retracted-claims.py` makes no git calls at all, and `citation-provenance.py`'s only raw
invocation is `rev-parse --show-toplevel`, so this tool was the whole exposure.

## 2. `R18-P1-01` — conceded, and it sharpens a rule this pack already had

`P14-AMENDMENT-23` reported the manifest's history as the parent's figure under the words
*Measured AT the pushed head*. At `c001cd9` that history is **25** revisions. Struck in place
there, and enforced as row 25 of `tools/RETRACTED-CLAIMS.tsv`.

The rule this pack has been applying — *run the `--check` gates after the last document write,
because a later write retires the quoted run* — is **not sufficient for a number derived from
history**, and that is new. Committing the last write **adds the revision being counted**, so the
figure is stale the moment it becomes true. Digests, row counts and file counts are safe after the
last write; a history-derived number has to be re-measured in a clone of the **pushed** head.

Acting on that rule in this amendment: §4 below quotes **no** count of the manifest's own
revisions. The figure for this head is measured in a fresh clone after the push and reported in
the handover to the reviewers, where it can be checked against the head it names rather than
predicted by the document that creates it.

This is the third round running with a figure older than the head it was attributed to. The first
two were carelessness about re-measuring; this one is structural, which is why the remedy is a
rule about *which kind of number* can be quoted in a document at all.

## 3. The invariant behind the count, now checked by name

I asked the reviewer whether the two count proofs prove the printed count is the set the walk
actually used. They answered by measurement: **no**. They built a copy whose count ignores the
walk and simply re-runs the marker leg's command, and its output is byte-identical to this tool's
on the real pack and in both proof worlds, so both proofs pass for it. The proofs pin the figure,
not its provenance.

They then showed it is not a defect at this head, and why: every revision the marker leg finds is
seeded into the walked map, so the marker set is a subset of it, and the intersection the summary
reports is identically the marker set. The proofs are tautological **because** the invariant
holds.

So the useful move is not a world that cannot exist while the invariant holds — it is to stop the
invariant being an unstated assumption. The tool now asserts it and **refuses by name** when it
fails: *NOT CHECKED (N revision(s) the marker leg found are absent from the walked set …)*, with
the sentence saying why a number that is an intersection of two sets no longer in that relation
is refused rather than printed. A future change that recomputes the count independently is caught
by the assertion instead of sailing past two proofs that cannot see it.

## 4. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself.

* `tools/gate-sweep.sh` — rc 0, **69 ok**, `0 gate(s)/proof(s) not as required`, from four
  working directories. 67 at `c001cd9`; the two added are `replace-refs-refused` and
  `replace-refs-off-base-refused`.
* `tools/manifest-digests.py --check` — rc 0 in both lanes, 59 artifact rows + the manifest,
  59 files, **1 revision found by the marker**. The count of the manifest's own revisions is
  deliberately not quoted here; see §2.
* `tools/citation-provenance.py` — rc 0.
* `tools/retracted-claims.py` — rc 0, 25 claims across 34 pack documents.
* repository `npm run format` — rc 0.

## 5. What the reviewer closed, recorded as theirs

* **`R17-P1-01` closed.** They read the marker leg's figure from its own command before running
  either tool: real pack marker leg 1, path leg 25, the parent's tool printing the mixed figure
  and this branch printing 1; both proof worlds likewise, with the inert-anchor world now reading
  zero.
* **`R17-P3-01` closed**, struck in place and enforced as a retracted claim.
* The addendum's residual is in §2 of the manifest, which is what they asked for.
* They reproduced the rest of the head — the pack gates in both lanes, the sweep with both count
  proofs green, and all five repository gates in one never-built clone, cold and after a build,
  identical to the parent and to the merge-base, so this branch adds no repository red.
* The parents branch is unchanged: five constructions between us, none reaching the state, refused
  upstream, fails closed, signed by neither of us.
