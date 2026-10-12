# P14 — INDEPENDENT CHALLENGE, narrow check at `a725342`

**Round 11 (narrow check).** Reviewer: the independent Phase 14 challenger, own
container, own clones. **Verdict: `PASS-WITH-SCOPE`.** Nothing blocking.

- **Head checked:** `a7253421fd7d52cce58862ddc22b33ecc515909b`, pinned with
  `git ls-remote origin claude/project-thread-1zqgj8` before anything was read, and equal to
  the fetched `origin/claude/project-thread-1zqgj8`.
- **Delta reviewed:** `c812aa5..a725342` — one commit, *“phase14: three false sentences, and
  the witness is the oldest digest now”*, **17 files changed, 981 insertions, 73 deletions**.
- **Scope of the check:** the coordinator's three blocking sentences at `c812aa5`, the eleven
  named residuals, and nothing else. This is a narrow check, not a full round.
- **Every exit code below is recorded with the directory it was measured from** (round-10
  convention), and every finding carries its round number (round-7 convention).

---

## 1. Blocker 1 — the witness was the newest committed digest. CLOSED BY EXECUTION.

I did not read the fix. I built the attack it is supposed to stop, in a repository I control,
and then ran the **same plant against the old code** to show the difference is a measurement
and not a claim.

**The plant.** `git clone` of the `a725342` worktree; a sentence appended to one of my own
received reports (`P14-CHALLENGE-50b0341.md`) in **both** directories, so the two-directory
witness agrees and cannot be what refuses; the manifest row hand-forged to the tampered digest
and byte count (`91f310f929ca` / 10,515); **one ordinary commit** carrying report and row
together (`c18f093`).

| code under test | command | result | measured from |
|---|---|---|---|
| baseline, `a725342` | `manifest-digests.py --check` | **0** — 39 rows / 39 files, *history checked over every revision, OLDEST first* | `…/scratchpad/tw17` |
| **`a725342`** on the plant | `--check` | **1** — `REVIEWER ROW REWRITTEN IN HISTORY: … recorded as e89fcb1c90ea when it was received, and a later revision (c18f09352468) records 91f310f929ca` | `…/scratchpad/tw17` |
| **`a725342`** on the plant | `--write` | **1**, row left as found | `…/scratchpad/tw17` |
| **`c812aa5`** (newest-first), **identical plant** | `--check` | **0** — *“every artifact row matches the file on disk”*, while printing *history checked over every revision* | `…/scratchpad/tw17` |

The old code was extracted from git (`git show c812aa5:…/manifest-digests.py`,
sha256 `b28b0cce…`) and run against the same tree, the same witness directory and the same
forged commit. Same world, two tools, `0` against `1`. **Blocker 1 is closed, and the closure
is measured.**

## 2. The other two false sentences

| sentence at `c812aa5` | state at `a725342` | how measured |
|---|---|---|
| the generated provenance block counted the pack's own tools as *“files this phase PROPOSES and that correctly do not exist yet”* | **CLOSED.** The block now reads **9 file(s) (10 tokens)** and names none of the pack's tools; `citation-provenance.py --check` on `P14-MIGRATION-PATCH-REQUEST.md` answers *block is current*, **rc 0** (from `…/r17/phase-preparation/phase14`) | I listed the nine and checked each against the declared base myself: all nine absent at `93084f8`. The four pack tools are **also absent at `93084f8`** — they are excluded because the pack is **walked on disk**, not because they exist at the base, which is the honest reason and is what the code does |
| typed counts on the first pages | **CLOSED.** `P14-AMENDMENT-03` §10's *“205 lines”* is gone, replaced by a pointer to the generated table, and that pointer **resolves**: `P14-MIGRATION-PATCH-REQUEST.md:1443` carries `DIFFERS (+190/-15)`. `README-AR.md` §1 no longer types a push count and says in words why it will not | grep over the pack: the remaining *“205 lines”* and *“ثلاث عشرة دفعة”* occurrences are all inside reviewer reports and the annotations that record what the line used to say — dated evidence, correctly left alone |

## 3. The eleven residuals — four re-measured, six credited through the sweep

I re-executed four of the eleven rather than reading their closures.

| # | my measurement | from |
|---|---|---|
| `R-01` | planted retracted claim in a **disallowed** document → **1** from both `…/tools/phase14` and `…/plain/phase14`, **25 documents either way**, naming file, line and the retraction reason; the claim planted in an **allowed** document → **0** (correct); empty pack → **2**, *“An empty population is not a pass”* | `/tmp/r01/{tools,plain}/phase14`, `/tmp/r01/empty/phase14` |
| `R-09` | `redproof-preflight.sh nosucharm` → **2**, *“REFUSING TO MEASURE: no arm is named …”*, arms listed | `…/r17/phase-preparation/phase14` |
| `R-10` | an allow-list row made to name `P14-NO-SUCH-DOCUMENT.md` → **2**, naming the document and the count | `/tmp/r01/plain/phase14` |
| `R-11` | after **four** full sweeps over the live pack, `git status --porcelain` is **0 lines** — every mutation restored by the trap | `…/r17` |

`R-02`, `R-03`, `R-04`, `R-05`, `R-06`, `R-07`, `R-08` are credited through the sweep I ran
myself, below, where each has a red proof asserted by its own message.

## 4. The sweep gives one verdict from every working directory

`tools/gate-sweep.sh --no-db`, run four times, once from each of these:

| cwd | rc | sweep's own tail |
|---|---|---|
| `…/r17/phase-preparation/phase14` | **0** | `== 0 gate(s)/proof(s) not as required` |
| `…/r17` | **0** | identical |
| `/tmp` | **0** | identical |
| `…/scratchpad` | **0** | identical |

**26** `ok` lines each time, none `FAIL`, including the three new refusals
(`coord-review-protected`, `history-truncated-not-checked`, `retracted-claim-planted`). The
sweep itself already runs every gate from four directories and asserts the codes identical
**and** `0`; what this adds is that the sweep's **own** verdict does not move with the cwd.

---

## 5. Findings

Numbered with the round prefix. None blocks under the coordinator's stopping rule: no false
measured claim about an exit code or a count, and no fail-open.

### `R11-P2-01` — in a `--depth 1` clone the forgery this round closed passes again, at `0`

A depth-1 clone of the planted repository, with the counterpart directory present and carrying
the same tampered bytes:

```
reviewer-row history NOT CHECKED (revision c18f09352468 is the shallow boundary of this
clone, so the history below it was never fetched and the oldest digest here need not be the first)
every artifact row matches the file on disk, and every file has a row.
rc=0        (measured from /…/scratchpad/sh1)
```

The same clone with **no** counterpart directory answers **1** (`NO WITNESS`). So the
behaviour depends entirely on whether a second copy exists — and both copies are written by the
same hand, which is `R10-ADD-01` exactly, now with an exit code beside it.

This is **announced, not silent**: the tool prints `NOT CHECKED` and names the boundary, there
is a red proof for it, and `README-AR.md` §6 says a truncated history does not answer. That is
why it is P2 and not blocking. What is missing is the **consequence**: nowhere does the pack say
that in a shallow checkout the committed-forgery route is open again. Amendment 15's
evidence table states *“a `--depth 1` clone answers `NO WITNESS`”* without the qualifier that
§1 does carry two paragraphs earlier (*“in a shallow clone **with no counterpart**”*) — in the
table it reads as a property of the clone, and it is a property of §1's constructed world.

`actions/checkout` defaults to `fetch-depth: 1`, so this is the CI shape, not an exotic one.

**Remedy, one sentence and one proof:** state the consequence where the limit is stated, and add
a red proof `reviewer-row-forged-shallow-with-counterpart` asserting `0` *with* `NOT CHECKED`
in the same output — a gate that must print its own blind spot cannot lose it quietly.

### `R11-P2-02` — the `NO WITNESS` refusal names a cause that is measurably not the cause

In that same depth-1 clone, with the counterpart absent, the refusal reads:

> `NO WITNESS for P14-CHALLENGE-50b0341.md: it has no digest in any revision of this manifest
> and no counterpart under …`

The first clause is false. **Seventeen** revisions of this manifest record a digest for that
report, and the oldest records `e89fcb1c90ea`. The clone cannot see them. The verdict (refuse)
is right; the sentence a reader acts on sends them to re-sign a report that was signed long ago.

This is the **sixth** instance of the class I have now filed in four consecutive rounds —
`R8-P3-05`, `R9-P3-01`, `R10-P3-01`, the author's own `R-04`, and this — *a fail-closed refusal
naming a cause that is measurably not the cause.* Every verdict sound; the diagnosis wrong six
times. It is worth treating as a property of the tooling rather than as six accidents: **a
refusal should be written from the variable it actually read.** Here, `history` is already in
hand — when it is `NOT CHECKED`, the message need only say *“no digest is visible in the
revisions this clone has”*.

### `R11-P3-01` — the `moved` refusal gives a remedy that cannot clear it

I restored the tampered report and its row byte-for-byte to what was received (`e89fcb1c90ea`
in the row, that digest on disk, counterpart identical), committed that restoration, and
re-ran:

```
REVIEWER ROW REWRITTEN IN HISTORY: … Restore the row to the digest the report arrived with.
--check rc=1   --write rc=1      (measured from /…/scratchpad/tw17)
```

The row **is** the digest the report arrived with. The refusal is permanent and the instruction
it prints has already been carried out. The behaviour is intended and documented (*“even if the
file is afterwards restored”*) — a forgery commit should not be erasable from inside the
repository — so the finding is only the sentence: it should say that the history cannot be
cleared from here and name what can be done instead.

### `R11-P3-02` — `R10-ADD-01` is now load-bearing, not theoretical

Whenever the history witness is `NOT CHECKED`, the two-directory witness is the **only** one
left, and both directories are written by the author. That was an argument when I filed it; §5
above makes it an exit code. It stays open, and I would not treat the two-directory
construction as a second witness in any claim made after promotion.

---

## 6. Signature and its scope

**I sign `a7253421fd7d52cce58862ddc22b33ecc515909b` and no other commit**, for this narrow
check only: the three sentences the coordinator blocked on at `c812aa5`, the eleven named
residuals, and the cwd-independence of the sweep. A signature covers one SHA and does not
transfer to the next.

**Restated, unchanged, as in every round since the fourth:** no finding in this lane has ever
landed on Phase 14's **architecture**, because the architecture is unexecuted — there is no API,
no DDL, no route, no CI job. Everything measured here is the pack's own tooling and prose. None
of it is credit against the first review of an executed Phase 14, which should be expected to
be worse than all eleven of these rounds together.

**What I did not do:** no file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; no cluster was needed for this check (`--no-db`),
so nothing here speaks to the database lane at this head.
