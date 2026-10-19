# Phase 14 — independent challenge, round 23

**Subject:** `2091119b1c02dd3bd8d8e47226336f9359de7fdc` (parent `abe95fcf7866d9b7cad026627332b184487d4c26`),
branch `claude/project-thread-1zqgj8`, fetched by full object name into a clone of my own.
**Scope:** `abe95fc..2091119` — the struck claim and its enforcement, the reordered pin, the single
resolution, the named configuration refusal in both tools, the two new arms, the guard-deletion
table, and the pack and repository figures at the pushed head.

**Verdict: PASS-WITH-SCOPE.** This is the first verdict in this lane that is not a REJECT, and it
is narrow on purpose. Everything round 22 raised is closed and re-measured here rather than read:
the false claim is struck in place and **enforced** as retracted claim 27, the pin's order is fixed
and the in-pinned-set shim now loses, the absent-git condition is a **named refusal at rc 2 in both
tools and in both lanes**, the two new arms discriminate, and the author's guard-deletion table
reproduces **row for row, including the row that reports their own guard as unproved**. Every
figure in amendment 28 reproduces with the command it names. The repository gates are identical to
the parent and the merge-base.

**What the scope excludes** is in §5: one new P2 of my own making, four residuals the author names
themselves, and the standing ones. None of them is a false measured claim or a fail-open, which is
the line this lane draws between a residual and a block.

---

## Signature scope

I sign **this SHA and nothing else**: `2091119b1c02dd3bd8d8e47226336f9359de7fdc`, with

| artefact | sha256 | bytes |
|---|---|---|
| `P14-HANDOFF-MANIFEST.md` | `dd9083ab9ad58ce5b37ba764cbf8861ef23e35b7b79cd6832b0e32e3cba6f271` | 86,988 |
| `tools/manifest-digests.py` | `91a3a60f8a84b726736ffef710595796d073ba7caf35d672e289470b14b2fe3a` | 66,099 |
| `tools/citation-provenance.py` | `afe8d0b971566b8b0b5b22fa1290bfd9406332fdb844c205d29144a228260de5` | 31,274 |
| `tools/gate-sweep.sh` | `5d5bd06de325e9ddc5da39f675409b010c463eb39899ec80ea87ab065e7ac492` | 93,710 |
| `tools/RETRACTED-CLAIMS.tsv` | `9fd1d35bec9cc55db923c9d82a7c896f13c530ae3122b3bafe2bf7bb9c7ce866` | 11,423 |

This signature is **not** a promotion, **not** a statement that Phase 14 is complete, and **not** a
statement about CI, which has never run a Phase 14 SHA. It says: at this SHA, the defects raised in
rounds 20, 21 and 22 are closed as measured below, the pack's own gates are green from four working
directories with the on-target cluster up, and the repository gates are unmoved. A later head
carries no part of it.

## 1. `R22-P1-01` — struck, and the correction is enforced

* The strike is in place in `P14-AMENDMENT-27-CHALLENGE-ROUND-21.md`: the sentence and its three
  quoted FAIL lines are inside `~~…~~`, with the correction and the **one guard per arm** table
  beneath it.
* **Retracted claim 27 is enforced, not filed.** Measured on a copy of the pack: the retracted
  phrase *"all three GIT arms"* appended to `P14-MIGRATION-PATCH-REQUEST.md` gives **rc 1** with
  `RETRACTED CLAIM PRESENT: P14-MIGRATION-PATCH-REQUEST.md:1576 — 'all three GIT arms'` and the
  reason quoted; the untouched copy is rc 0.
* The replacement fact is the one I measured, published as such.

## 2. `R22-P1-02` — closed, measured in my own container

The shim written to `/usr/local/bin/git` and removed again in the same command, over my round-20
world (pack walk 4, decoy walk 3, asserted from git first), after checking that no `git` already
existed there:

| | `abe95fc` (parent) | `2091119` (subject) |
|---|---|---|
| rc | **0** | **1** |
| refusal | **none** | `REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md` |
| revisions | 3 (the decoy's) | 4 (the pack's) |
| provenance line | `… git directory /tmp/t33/F/.git; git version 2.43.0 at /usr/local/bin/git` | `… git directory /tmp/t33/W/.git; git version 2.43.0 at /usr/bin/git` |

The pin is reordered with the system locations first and the binary is resolved once into
`_GIT_BIN`, in both tools. I checked the consequence rather than the edit: **no bare-name executable
remains in either verdict tool** — all three `subprocess.run` sites (one in `manifest-digests.py`,
two in `citation-provenance.py`) pass `_GIT_BIN`.

## 3. `R22-P2-01` — closed in both tools and in both lanes

Pin pointed at an empty directory, in a copy of each tool:

| | `abe95fc` | `2091119` |
|---|---|---|
| `manifest-digests.py --check` | rc **1**, `FileNotFoundError: [Errno 2] … 'git'` (a traceback) | rc **2**, `CONFIGURATION ERROR: no \`git\` executable was found on the pinned PATH (…), so no history could be read and nothing here is a verdict about this manifest.` |
| `citation-provenance.py --check` | rc **1**, the same traceback | rc **2**, the same refusal about its own block |

I measured the parent by patching its **inline** pin, because `abe95fc` has no `_PINNED_PATH`
constant; a `sed` on a constant that does not exist would have measured nothing.

**And the lane the amendment does not mention: `--write`.** A write lane that proceeded without
history would be worse than a check lane that did. Measured on a scratch copy: rc **2**, the same
named refusal, and the manifest on disk is **byte-identical afterwards** (`cmp` clean). Nothing is
written when nothing can be read.

## 4. The arms, and the deletion table reproduced row for row

Full sweep at the committed tree: **rc 0, 76 ok, 0 not as required**, four working directories,
cluster up. The five arms of this family all pass, each by the law or by the configuration refusal:

    ok    git-dir-decoy-refused          rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: …
    ok    git-dir-in-pack-decoy-refused  rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: …
    ok    git-binary-shim-refused        rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: …
    ok    pinned-path-no-git-refused     rc=2, refused with CONFIGURATION ERROR: no `git` executable …
    ok    pinned-path-order-decides      rc=1, refused with REVIEWER ROW REWRITTEN IN HISTORY: …

**Guard deletion, one change per copy, run through the author's own sweep and read by name.** My
three runs reproduce their published table exactly:

| the one thing deleted | result |
|---|---|
| the named `CONFIGURATION ERROR` block | **1 FAIL**, `pinned-path-no-git-refused rc=1 (required 2), and the message was not CONFIGURATION ERROR…` |
| the pin reordered back to round 21's order | **1 FAIL**, `pinned-path-no-git premise not built (… shipped pin rows 0/1 want 1/1)` |
| `_GIT_BIN` reverted to `'git'` in the call | **0 FAILs, rc 0 — nothing reds** |

The third row is the author's own disclosure, and it reproduces. §5 says what I think it means,
which is not quite what the amendment says.

**One structural reading, stated as an observation and not as a defect.**
`pinned-path-order-decides` proves a property of `PATH` resolution — a shim first wins, a shim last
loses — on copies whose pin is *shipped-pin plus the shim*, not the shipped pin itself. What holds
the **shipped order** is the verbatim `grep` in `pinned-path-no-git-refused`'s premise, which is why
reordering the pin surfaces as *premise not built* rather than as a behavioural red. Both facts
together do cover the property; I note it so nobody later deletes the grep believing the behavioural
arm covers the order.

## 5. What this signature does **not** cover

* **`R23-P2-01`, a new one, and it is mine again.** `_GIT_BIN` is resolved **once at import** and
  used later, so if the resolved file disappears between those two moments the call raises
  `FileNotFoundError` — rc 1, an unnamed traceback, the exact failure shape `R22-P2-01` closed —
  where the bare name would have fallen through to the next candidate on the pin. Measured, two
  directories each holding a `git`, the first removed after resolution:
  `absolute _GIT_BIN: raised FileNotFoundError … '/tmp/t35/bin1/git'` against
  `bare name 'git': 0 git version 2.43.0`. The window is narrow and nobody is attacking through it;
  the fix is to wrap the call in `except (FileNotFoundError, PermissionError)` and refuse by name at
  the configuration code, which is the refusal that already exists three lines up.
* **And the framing that goes with it.** The amendment calls the absolute resolution a guard whose
  arm is missing. I measured why nothing reds when it is reverted: `_GIT_BIN` and `'git'` resolve
  over **the same pinned string**, so in any world where both see the same pin they select the same
  file — the absolute form is not a security property at all. Its real value is that the provenance
  line reports the object that ran and that the absence is caught early by name. The honest row in
  §4's table is therefore explained rather than owed: what has no arm is not a guard.
* **The in-pinned-set binary arm**, not shipped, with the author's reason — a gate that writes an
  executable called `git` into a system directory leaves this container redirected if it is killed
  between the write and the removal. I accept that reason: I took the same measurement by hand, with
  the same guard against a pre-existing file, and I would not ship it as an arm either. The
  mechanism is closed by the order; the **arm** for it is absent and stays named.
* `GIT_EXEC_PATH` **unmeasured** — not set in this container. The translated-git leg
  **unmeasured** — git's message catalogues are not installed here.
* **`parents-unknown` is still unwitnessed** — five constructions between us, none reaching the
  state, refused upstream, fails closed. No new construction from either side this round.
* **CI has never run a Phase 14 SHA**, and no workflow in this tree runs this pack's gates at all.
  The anchor recipe in §2 of the manifest is declared and unexercised. **This signature says nothing
  about CI.**
* `OD-P14-09`, `-10`, `-11` are open with Ashraf and are not mine to close.
* The attack set on this class is five mechanisms closed and one open. That is the set we have
  tried, not a claim that it is exhausted.

## 6. Figures at the pushed head

Fresh clone of `2091119`, premises asserted — `refs/replace` rows **0**, no file at
`.git/info/grafts`, `rev-parse --is-shallow-repository` **false**:

* `tools/gate-sweep.sh` — **rc 0, 76 ok, 0 not as required**, cluster up (74 at `abe95fc`).
* `tools/manifest-digests.py --check` — **rc 0 in both lanes**, **67** artifact rows + the manifest,
  **67** files, **30** revisions, **1** found by the marker.
* The marker revision, by the tool's own ERE run independently in that clone: **`08d23da`**, and
  only that one.
* `tools/citation-provenance.py --check` — **rc 0**. `tools/retracted-claims.py --check` — **rc 0**,
  *"27 retracted claim(s) enforced across 38 pack document(s); 31 challenge report(s) exempt"*.
* The amendment's §5 arithmetic checks out: 26 → 27 claims, 37 → 38 scanned documents (amendment 28
  itself), 30 → 31 exempt reports (my round-22 words). The prediction of 39 double-counted the
  report; the correction is right.
* My round-22 words are committed **unedited**: `P14-CHALLENGE-abe95fc.md`, 13,501 bytes,
  `7845ff0cf3d866361eb956ecf0ff83a22c5f2ec9c2ec6a557a13fd4338626d9e`, byte-identical to my frozen
  copy (`cmp` clean).

## 7. Repository gates — three worlds, one never-built clone each

Node v24.21.0, npm 11.19.0, in the order shown, in a clone with no `dist` anywhere before `npm ci`.

| reading | `2091119` (subject) | `abe95fc` (parent) | `6fc505d` (merge-base) |
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

Subject measured this round in `/tmp/g47`; the parent column is round 22's reading in `/tmp/g45`
and the merge-base column round 19's in `/tmp/g36`, quoted as measured and not re-run. The cold reds
are `G6`, the non-topological workspace build order, present on `main` as well. Gate list derived
from the diff, which touches only `.md`, `.py`, `.sh` and one `.tsv` under the pack: the repository
has no shell, python or tsv gate, so `prettier --check .` is the one gate this diff can move, and it
is **0**.

## 8. What is owed

Nothing blocks. Two things are worth a commit when one is next made — neither is a condition of this
signature, and neither should be rushed into a head on its own:

1. `except (FileNotFoundError, PermissionError)` around the git call, refusing by name at the
   configuration code (§5's first item).
2. §4's sentence about the absolute resolution reworded: it is not a guard without an arm, it is not
   a guard. What the arms hold is the pin's presence, its exact order and the named refusal — which
   is what the amendment already says in the next sentence.

If a head is pushed carrying those, it is a new SHA and this signature does not reach it; send it and
I will run round 24 narrow on the difference.
