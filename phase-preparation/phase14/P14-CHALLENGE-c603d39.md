# P14 INDEPENDENT CHALLENGE — ROUND 28, at `c603d39`

Subject: `d34763e..c603d39` (one commit, `phase14: close R27-P1-01 — one shared
enumeration for all three instruments`), 9 files, +1131/−103, nothing outside
`phase-preparation/phase14/`.

**VERDICT: REJECT.** `c603d39` is not signed. One **P1**, a fail-open, in the
refusal this commit adds: **a symbolic link to an existing DIRECTORY is silently
skipped** — no refusal, no row, no count moves, all three instruments rc 0 — while
the refusal's own sentence says a link is *"refused by name rather than followed,
digested or skipped"*, and the pin prints *"every file has a row"* over a
committed tree that carries an entry with none. The remedy is one line.

Everything else in the range verified, and most of it verified well: the shared
enumeration, the exec-by-digest pin, the env hardening of the probe and the
count-prefixed digest all did what the commit says, under attack. Details below,
including what I could **not** break.

---

## 1. `R28-P1-01` (P1, FAIL-OPEN) — a directory symlink is skipped in silence

`pack-domain.py` refuses a link in `walk()` **only where it iterates `files`**
(`if os.path.islink(ap)`). `classify_dirs` asks git whether a directory is a
repository and never asks whether it is a link, and `os.walk` does not descend
into a symlinked directory. So the one link shape the refusal does not reach is
the shape that is skipped.

Measured in a clone of `c603d39`, one plant at a time, every instrument re-run:

```
zz-flink -> P14-HANDOFF-MANIFEST.md (a link to a FILE)
    manifest-digests.py --check  rc=1  "SYMBOLIC LINK IN THE PACK: zz-flink names ..."
zz-dlink -> /tmp/w21/nowhere-at-all (a DANGLING link)
    manifest-digests.py --check  rc=1  "SYMBOLIC LINK IN THE PACK: zz-dlink names ..."
zz-link  -> /tmp/w21/outside28 (a link to an EXISTING DIRECTORY)
    manifest-digests.py --check   rc=0   "every artifact row matches ... every file has a row."
    retracted-claims.py --check   rc=0   43 pack document(s) — UNCHANGED from the baseline 43
    citation-provenance.py --check rc=0
    occurrences of "zz-link" in all three outputs: 0, 0, 0
    "0 directory(ies) were excluded as repositories: none"
    "81 file(s) at the top level" — unchanged
```

It is invisible inside a **declared subtree** as well, which is where the
manifest publishes the strongest claim of all: with `proofs/zz-link ->
/tmp/w21/outside28` planted, `--check` is rc 0, the `proofs/` row does not move,
`55 file(s) under 2 declared subtree(s)` is unchanged and the output does not
mention the link — while that row's own prose says the digest covers "every file
beneath it at any depth".

Two of the three link shapes refuse by name and each has a sweep arm
(`plant-symlink-in-subtree`, `plant-dangling-symlink`). They are exactly the two
shapes I named in round 27. The third variant has no arm and no refusal.

**It is committable, and I committed it** (local probe `18cd475`, never pushed,
discarded):

```
git ls-files -s -- phase-preparation/phase14/zz-link
  120000 efd8ce62a339173a73f1a1f4d255c3deca9428d7 0  phase-preparation/phase14/zz-link
manifest-digests.py --check  rc=0  "...and every file has a row."
```

**And it defeats an enforcement, not just a pin.** The linked directory held a
document carrying a retracted claim from this pack's own list. With the link in
place `retracted-claims.py --check` is **rc 0**. Moving the same bytes to the top
level of the pack: **rc 1**, `RETRACTED CLAIM PRESENT: zz-doc.md:3 — 'six of the
fourteen'`. Unlike the repository exclusion, nothing in any output names the link,
so a reader of a green run has no way to notice.

Why this blocks rather than being named as a residual: the sentence is new in this
commit, a reader sent to it would stop looking for link shapes, and the shape it
misses is the only one that is skipped. One `os.path.islink` test inside
`classify_dirs` — refuse by the same name, dangling or not, directory or file —
closes it, and one arm (`plant-symlink-to-a-directory`) measures it.

## 2. `R28-P2-01` (P2) — the hiding place costs what it always cost, and it is wider than §6 declares

The exclusion moved from structure to `git --git-dir=<dir> rev-parse --git-dir`.
The amendment justifies it by saying structure "was too weak — the challenger's
cheapest forgery was three entries with an EMPTY `HEAD`, which git rejects (rc
128)". True, and a 20-byte `HEAD` restores it. Measured on this container,
`git 2.43.0`:

```
rc=128  a nonexistent path                    rc=128  an empty directory
rc=128  HEAD empty + objects/ + refs/         rc=128  HEAD + refs/, no objects/
rc=128  HEAD + objects/, no refs/             rc=128  objects or refs as a FILE
rc=0    HEAD "ref: refs/heads/main" + objects/ + refs/     (3 entries)
rc=0    HEAD naming a branch that does not exist
rc=0    HEAD as a detached all-zero sha
rc=0    HEAD "ref: refs/heads/main" with NO trailing newline  -> 20 bytes, 3 entries
rc=0    a real bare repository owned by uid 65534 (ownership does not change the verdict)
```

So the price is three entries, before and after; only the content of `HEAD` went
from 0 to 20 bytes, and git checks neither that the branch exists nor that
`objects/` holds anything. Through the instruments, with
`zz-hide/{HEAD (20 B), objects/, refs/, zz-doc.md}` planted:

```
manifest-digests.py --check   rc=0, "1 directory(ies) were excluded as repositories: zz-hide"
retracted-claims.py --check   rc=0  (the planted retracted claim is NOT caught)
citation-provenance.py --check rc=0  (no figure moves — the three domains do agree)
control, the same bytes at the top level:  retracted-claims rc=1, refused by name
```

§6 declares the residual as *"a file inside a REAL repository directory inside the
pack is pinned by no instrument"* and argues it is bounded because no figure moves
and no two figures disagree — both of which I reproduce and confirm. What it does
not say is that **a retraction this pack enforces is not enforced there**, and
that the directory need not be a real repository in any useful sense: 20 bytes and
two empty directories buy it. This is P2 and not P1 for one honest reason: the
manifest **names the excluded directory in its population sentence**, so a reader
of the run sees `zz-hide` and can ask why. Say the enforcement consequence in §6,
and the residual is complete.

## 3. `R28-P3-01` (P3) — the published recipe has no notion of the exclusion

The recipe was updated for the count line and the claim is that it is "the tool's
text EXACTLY". At this head it is, and I ran it rather than reading it:

```
tools/  recipe 76052912a3496f38...   row 76052912a349...   (identical)
proofs/ recipe ed09fec3a0ba709d...   row ed09fec3a0ba...   (identical)
```

But `find <dir> -type f` descends into a directory git accepts as a repository and
the tool does not. With a real repository planted inside `proofs/`, the tool holds
the row unchanged at **rc 0** (disclosing `1 directory(ies) were excluded as
repositories: proofs/zz-hide`) while the recipe returns **`5d61975e3fe2…`**. The
divergence is in the safe direction — a reviewer sees a false alarm, not a missed
forgery — but the sentence needs its clause: the recipe is the tool's text exactly
**when the run reports 0 excluded directories**.

## 4. What I could not break, measured rather than assumed

* **No TOCTOU in the exec-by-digest load.** All three loaders read the file once
  into one buffer, hash *that* buffer, and `exec(compile(src, ...))` the same
  buffer. There is no second read and no path re-resolution between them.
* **The pin fires, in one voice.** One byte appended to `pack-domain.py`:
  `manifest-digests` rc 2, `retracted-claims` rc 2, `citation-provenance` rc 2,
  and all three print the identical sentence `CONFIGURATION ERROR: THE SHARED
  ENUMERATION DOES NOT MATCH ITS PIN` — one name for one condition, which is what
  a runner can grep.
* **Swapping the pin does not buy a silent domain.** With `retracted-claims.py`'s
  `_DOMAIN_SHA` updated to the edited domain: that tool rc 0, its sibling rc 2,
  `manifest-digests` rc 2 — the drift is loud in the siblings. With **all three**
  pins swapped, the manifest's own subtree row reds: `tools/: row says
  76052912a349 over 266,124 bytes, the directory holds 6 file(s) ... hashing
  1cb077898036 over 266,125`. The weakest link is a `--write` of the manifest,
  where it has always been, fenced by the reviewer-row and history rules.
* **Env leakage into the probe: none found.** `--check` re-run under each of
  `GIT_DIR`, `GIT_CEILING_DIRECTORIES`, `GIT_WORK_TREE`,
  `GIT_OBJECT_DIRECTORY`, `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` (`safe.directory
  = *`), `HOME` and `XDG_CONFIG_HOME` pointed at a config of my own — rc 0 and
  `0 directory(ies) were excluded as repositories: none` in every one. I found no
  configuration knob that makes git accept a non-repository, and
  `safe.directory` does not enter this question at all, because `--git-dir=`
  with `rev-parse --git-dir` accepted a repository owned by another uid.
* **The count prefix cannot be armed, and the amendment says so correctly.** My
  attack set, each built and run: round 27's exact construction (a file named
  `a\n<sha256 of empty>  b`) — now **rc 1, `UNNAMEABLE PATH ... a newline or
  carriage return`**; a carriage-return name — rc 1, refused; a name that looks
  like a row (64 hex characters, two spaces, `b`) beside an empty file — rc 1
  with a *different* digest, because a 64-character fixed-width prefix cannot be
  forged from the right-hand side; and the empty-directory case. With newline, CR
  and NUL refused before the digest, the number of lines equals the number of
  files, so no admitted world distinguishes the count prefix. `c4` in the
  amendment's table reports exactly that, and the table discloses that each copy's
  three pins were updated first — which is the right method, since I measured that
  an unrefreshed deletion makes even `--help` exit 2 on the pin.

## 5. Figures reproduced at this head

* `tools/gate-sweep.sh --no-db` in my own clone: **rc 0, 90 ok, 0 gate(s)/proof(s)
  not as required, 0 off-repository lane(s) differ** — the author's published figure
  exactly. With the database lanes, my run of the same script answers
  **rc 0, 98 ok, 0 gate(s)/proof(s) not as required, 0 off-repository lane(s)
  differ**.
* **All 83 rows verified against disk by my own implementation of the published
  domain** — count-prefixed digest, repository exclusion asked of git, symlinks
  and unnameable names refused — not by the tool: 81 file rows + 2 subtree rows,
  **0 mismatches**; `tools/` 6 files / 266,124 B / `76052912a349`, `proofs/` 49
  files / 107,024 B / `ed09fec3a0ba`; 81 top-level files and 55 below it, 6 + 49 =
  55, matching the tool's own sentence.
* **36** manifest revisions reachable from HEAD.
* My round-27 report is committed **byte-identical** to the frozen file at the
  digest I announced: `10f569104af1…` / 12,666 B, `cmp`-clean against the shared
  copy.
* The eight arms this commit adds are present and discriminate:
  `plant-repo-shaped-forgery`, `plant-real-repo-excluded`, `domain-pin-manifest`,
  `domain-pin-retracted`, `domain-pin-provenance`, `plant-symlink-in-subtree`,
  `plant-dangling-symlink`, `plant-newline-in-name`.

## 6. Disclosures about my own runs

* One local commit in my own clone (`18cd475`) to measure §1's committed world;
  never pushed, discarded, the clone back at `c603d39` with an empty
  `git status --porcelain` and `--check` rc 0.
* The §2 and §4 worlds were built in clones of mine, one plant or one edit at a
  time, each removed and the clone re-verified at rc 0 before the next. The
  count-prefix copy had its three pins swapped and its manifest `--write`-refreshed
  deliberately, as the amendment prescribes.
* I wrote nothing into `/mnt/project-files/phase14` except this report. No sweep of
  mine ran concurrently with another, and the pack copies for the plant worlds were
  taken before any sweep started.
