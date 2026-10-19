# P14 INDEPENDENT CHALLENGE — ROUND 29, at `4fb37bf`

Subject: `c603d39..4fb37bf` (one commit, `phase14: close R28-P1-01 — a symlink to
a directory was skipped in silence`), 9 files, +631/−37, nothing outside
`phase-preparation/phase14/`.

**VERDICT: PASS-WITH-SCOPE.** `R28-P1-01` is closed and armed from both branches
of the walk, and the object-kind sweep the ruling asked for holds on every shape I
could build. Two **P2** residuals, one **P3**, no P1 and no false measured claim
about a static tree.

**Signature scope.** I sign `4fb37bf` for the link and non-regular-file refusals,
the composite repository probe against the worlds of rounds 27 and 28, and the
figures in §5. It expressly does **not** cover (a) any statement that a directory
this pack excludes is a real repository with history of its own — `R29-P2-01`
shows it need own no object at all — or (b) any run made while another process is
writing the directory under `--dir`, which `R29-P2-02` measures.

---

## 1. `R29-P2-01` (P2) — the commit bar is satisfied by BORROWED objects

The probe became composite: `rev-parse --git-dir` **and** `rev-parse --verify
HEAD^{commit}`, both rc 0. Against the worlds it was built for, it works, and I
measured the controls first:

```
HEAD "ref: refs/heads/main" (20 B) + empty objects/ + empty refs/
                                   git-dir rc 0, HEAD^{commit} rc 128   (R28's forgery, now rejected)
an EMPTY bare repository           git-dir rc 0, HEAD^{commit} rc 128   (rejected, fail-closed)
a bare clone WITH commits          git-dir rc 0, HEAD^{commit} rc 0     (accepted, correct)
```

But `objects/info/alternates` is a file **inside the candidate directory**, and
neither `GIT_NO_REPLACE_OBJECTS` nor `GIT_GRAFT_FILE` reaches it. So a directory
that owns **no git object whatsoever** resolves a commit by borrowing someone
else's store:

```
zz-hide/HEAD                      -> one 41-byte sha
zz-hide/refs/                     -> empty
zz-hide/objects/info/alternates   -> "/tmp/g60/.git/objects"
   two files, three directories, 63 bytes in total
   git-dir rc 0, HEAD^{commit} rc 0  -> printed 4fb37bf97059aff209c88fe585f8a9e251050845
a RELATIVE alternates path ("../../../../g60/.git/objects") resolves too
```

Through the instruments, with a document inside it carrying a claim from this
pack's own `RETRACTED-CLAIMS.tsv`:

```
manifest-digests.py --check    rc=0, "1 directory(ies) were excluded as repositories: zz-hide"
                                     "every artifact row matches ... every file has a row."
retracted-claims.py --check    rc=0, "across 44 pack document(s)" — UNCHANGED from the baseline 44
citation-provenance.py --check rc=0
```

So the price of the hiding place went from 20 bytes to 63, and the sentence "a
repository HOLDING AT LEAST ONE COMMIT" is satisfied by a commit the directory
does not hold. It stays P2 for the same honest reason as `R28-P2-01`: the manifest
**names the excluded directory** in its population sentence, so the exclusion is
disclosed rather than silent.

**A discriminator exists, and I measured it rather than proposing one.** A third
leg asking the candidate to own at least one object separates the two worlds:

```
git --git-dir=<dir> count-objects -v
  the alternates world   count: 0   size: 0   in-pack: 0   packs: 0
  a real bare clone      count: 19  size: 252  in-pack: 22934
```

`cat-file --batch-all-objects` does **not** discriminate — it answered 15,075
objects for both, because it reads through alternates — so that is the obvious
instrument to avoid. A legitimate repository whose objects all live in alternates
(a `--shared` clone) would be rejected by the third leg and therefore stay in the
domain, which is fail-closed and the direction this pack refuses in. If the leg is
not wanted, then §6 should say that a directory this pack excludes may own no
object of its own.

## 2. `R29-P2-02` (P2) — a directory swapped for a link MID-WALK gives back both shapes this pack just closed

`classify_dirs` refuses a link before asking git, which is right. But the descent
decision is made again, later, by `os.walk` itself, and between the two the answer
can change. Measured with one concurrent swapper, `mkdir zz-dir` with a document
in it, then `mv zz-dir zz-real && ln -s <an empty dir> zz-dir` after a short
delay, 30 runs of `retracted-claims.py --check`:

```
16 runs   SYMBOLIC LINK IN THE PACK: zz-dir ...        (refused by name — the intended outcome)
 2 runs   RETRACTED CLAIM PRESENT: zz-real/...          (the moved copy found)
 4 runs   rc 0 and NOTHING said about zz-dir            <- R28-P1-01's silent skip, back
 the rest rc 1 with an UNHANDLED TRACEBACK:
   File ".../tools/retracted-claims.py", line 159, in main
     text = open(path, encoding='utf-8', errors='replace').read().split('\n')
   FileNotFoundError: [Errno 2] No such file or directory: './zz-dir/zz-doc.md'
```

One window, two defect classes: the silent skip of `R28-P1-01` and the unnamed
failure of `R23-P2-01`/`R24-P3-01` — rc 1 with a traceback where rc 1 means
STALE.

Why this is reachable and not a thought experiment: the `manifest-shared`,
`reports-in-tree` and `reports-at-head` lanes read `/mnt/project-files/phase14`,
a directory **every session in this project writes**, and round 25's finding was
exactly a concurrent write there ninety seconds before a push. A scanner cannot
be exact against a writer, but it can refuse instead of going quiet. Cheapest
fix: `os.walk(root, onerror=..., followlinks=True)` with the explicit link
refusal kept in `classify_dirs` — then a swap lands either on the refusal or on
real rows, never on silence — and one `try/except OSError` per read, named.

## 3. `R29-P3-01` (P3) — the sentence names three shapes and one has an arm

`NOT A REGULAR FILE IN THE PACK: ... (a FIFO, a socket, a device or something
else ...)`. I built all four:

```
zz-fifo  (mkfifo)             rc 1  NOT A REGULAR FILE IN THE PACK: zz-fifo
zz-sock  (AF_UNIX bind)       rc 1  NOT A REGULAR FILE IN THE PACK: zz-sock
zz-dev   (mknod c 1 3)        rc 1  NOT A REGULAR FILE IN THE PACK: zz-dev
zz-blk   (mknod b 7 0)        rc 1  NOT A REGULAR FILE IN THE PACK: zz-blk
```

The refusal is right in every case. Only `plant-fifo-in-the-pack` arms it. By the
lesson that cost round 28 — a net is read as covering the variants of the shapes
it names — each shape the sentence names should have its own plant, and all four
are two lines of shell.

## 4. The rest of the ruling's sweep, measured

* **Hard links are pinned, not refused, and that is correct.** `ln
  P14-HANDOFF-MANIFEST.md zz-hard` → rc 1, `zz-hard: ARTIFACT WITH NO ROW`; a hard
  link to a file **outside** the pack → rc 1, `zz-hard2: ARTIFACT WITH NO ROW`. A
  hard link is a regular file with the pack's own bytes, so demanding a row is the
  right answer. Unarmed, worth one plant.
* **Bind mounts are fail-closed.** `mount --bind` of an outside directory into the
  pack → the manifest reds with `SUBTREE WITH NO ROW: zz-bind/` and
  `retracted-claims.py` catches the planted claim: `RETRACTED CLAIM PRESENT:
  zz-bind/zz-bound.md:3`. A bind mount presents as an ordinary directory, so it is
  walked and pinned.
* **Case-colliding names.** This container's filesystem is case-sensitive (I
  created `zz-A.md` and `zz-a.md` and `ls` returned 2), and both demanded rows
  (rc 1). On a case-INSENSITIVE filesystem two rows would address one file; that
  is **UNMEASURED here** and I record it as unmeasured rather than reasoning about
  it.
* **Replace refs would be a bypass, and the hardening closes it.** A candidate
  whose `HEAD` names a nonexistent sha with `refs/replace/<that sha>` pointing at
  a real commit resolves `HEAD^{commit}` at **rc 0 with replace enabled** — and
  **rc 128** as the tools run it (`GIT_NO_REPLACE_OBJECTS=1` plus
  `--no-replace-objects`). Measured both ways, so the env is load-bearing and now
  has a reason on the record.
* **Grafts are closed and could not have worked anyway.** The same world with
  `info/grafts` instead → rc 128 under `GIT_GRAFT_FILE=/dev/null`; and a graft
  rewrites parents, it cannot bring a missing object into existence.
* **The unreadable-directory refusal is correctly declared UNMEASURED.** I
  reproduced the author's own reason independently: `chmod 000` then `--check` →
  **rc 0 and no refusal**, because this container runs as uid 0 and `os.listdir`
  on a 000 directory succeeds. The sweep says so in a comment instead of shipping
  a plant that would pass for the wrong reason, which is the right call.

## 5. Figures reproduced at this head

* `tools/gate-sweep.sh --no-db` in my own clone: **rc 0, 96 ok, 0 gate(s)/proof(s)
  not as required, 0 off-repository lane(s) differ** — the published figure
  exactly.
* **All 85 rows verified against disk by my own implementation of the published
  domain** — composite commit probe, link refusal in both branches, non-regular
  refusal, count-prefixed digest — not by the tool: 83 file rows + 2 subtree rows,
  **0 mismatches**; `tools/` 6 files / 277,191 B / `64a6c0636aea`, `proofs/` 49
  files / 107,024 B / `ed09fec3a0ba`; 83 top-level files and 55 below, 6 + 49 = 55,
  0 excluded and 0 refused at this head.
* **The bounded recipe is faithful.** Run as published: `tools/`
  `64a6c0636aea227f…` and `proofs/` `ed09fec3a0ba709d…`, both equal to their rows.
  `R28-P3-01`'s clause is now in the sentence.
* **37** manifest revisions reachable from HEAD.
* My round-28 report is committed **byte-identical** to the frozen file at the
  digest I announced: `61f85e70ca0d…` / 12,074 B, `cmp`-clean against the shared
  copy.
* The six arms this commit adds are present: `plant-link-to-directory`,
  `plant-link-to-directory-subtree`, `plant-fifo-in-the-pack`,
  `plant-retracted-behind-link`, `plant-retracted-at-top-level`,
  `plant-repo-without-commit`.

## 6. Disclosures about my own runs

* No commit of mine at this head; §1's world was measured in the working tree of
  my own clone and removed, and the clone re-verified at rc 0 after each plant.
* §2 deliberately mutated the pack of my own clone **while a gate was running** —
  that is what the finding is about. The clone is back at `4fb37bf` with an empty
  `git status --porcelain` and `--check` rc 0.
* §4's bind mount was mounted and unmounted inside my own clone; `mknod` and the
  socket worked because this container runs as uid 0, which is also why the
  unreadable-directory arm cannot fire here.
* I wrote nothing into `/mnt/project-files/phase14` except this report, and no
  sweep of mine ran concurrently with another.
