# P14 COORDINATOR DIFF REVIEW: `4fb37bf97059aff209c88fe585f8a9e251050845`

Range `1b694d1..4fb37bf` (d34763e, c603d39, 4fb37bf). Fresh clone, SHA pinned, tree exported with `git archive`. All python ran with `-I`.

**VERDICT: SIGN `4fb37bf97059aff209c88fe585f8a9e251050845`.** No measured-false claim. No silent fail-open in the SHA-pinned (clone) lane. Two P2 residuals and two P3 residuals, all rated by me.

## Inputs
- Challenger report `P14-CHALLENGE-4fb37bf.md`: 10655 B, sha256 `182948f0391ee65f0789f915c3b8499efb9568ba32720b9c913121dabe0a200b`. Both match. Verdict PASS-WITH-SCOPE.
- Diff scope: all 14 changed paths are under `phase-preparation/phase14/`. Nothing else changed.

## Claims, measured
| Claim | Result |
|---|---|
| pack-domain.py is shared by three instruments, pinned by sha and exec'd from one buffer | TRUE. sha256 `d6a48ae0a4f8961ff25b35aff8a61c5e2c6e234cd2b85505544e610de1c44483`. That literal appears exactly once in each of manifest-digests.py, retracted-claims.py and citation-provenance.py, and each calls `exec(compile(<buf>...))`. |
| Symlinks of every kind are refused from both walk branches | TRUE. A link to a directory at the top level gives manifest rc1 and retracted/citation rc2 (`SYMBOLIC LINK IN THE PACK: zz-link ... (a link to a directory)`). Inside `proofs/` it is refused by name too. |
| onerror handler | Present (`os.walk(root, onerror=_onerror)`). |
| Non-regular files are refused | TRUE for an AF_UNIX socket and for `mknod c 1 3`: all three instruments name `NOT A REGULAR FILE IN THE PACK`. |
| Composite repository probe | Implemented as stated. Bypassed by alternates (R29-P2-01, below). |
| Count-prefixed digest with NUL/LF/CR refused | Present in `_unnameable` and `subtree_digest`. |
| 96 ok / 0, 85 rows, 37 revisions | REPRODUCED. My clone gives `96` ok lines and `== 0 gate(s)/proof(s) not as required`. The manifest reports `85 artifact row(s)` and `37 revision(s)`. The sweep's overall rc is 1 only because of `== 3 off-repository lane(s) differ`. The shared folder now holds the uncommitted round-29 report, which is expected and is not included in the SHA figure. |

## Regressions, rebuilt by me
- **R27-P1-01** (empty `HEAD` + `objects/` + `refs/` + a document): manifest rc1 `SUBTREE WITH NO ROW: zz-hide/`. Retracted-claims rc1 `RETRACTED CLAIM PRESENT: zz-hide/zz-doc.md:1`, and its document count went 44 -> 45. Citation rc1. **Reds by name.**
- **R28-P1-01** (link to a directory): top level and `proofs/` both refused by name in all three instruments. **Reds by name.**

## Residuals (my severities)
**R29-P2-01: P2. Reaches the CLONE lane. Disclosed, not silent.** I built a 66 B world (`HEAD` = a commit sha, `refs/heads/.k`, `objects/info/alternates` = `../../../../.git/objects`, which is relative and points into the clone's own store), committed it, made a fresh clone, and ran the instruments there:
```
GIT_NO_REPLACE_OBJECTS=1 git --git-dir=zz-hide rev-parse --verify 'HEAD^{commit}'
4fb37bf97059aff209c88fe585f8a9e251050845   probe rc=0
retracted-claims.py --check: "28 retracted claim(s) enforced across 44 pack document(s)" ... "1 directory(ies) excluded as a repository: zz-hide"   rc=0
```
So a retracted claim inside the directory goes unenforced by that instrument in the clone lane. It is still not a silent fail-open, for two reasons:
- Every population sentence names `zz-hide`.
- `gate-sweep.sh` in that same fresh clone went **rc 1, 9 not as required**, with 87 ok. In its copied worlds (`plant-baseline`, shallow and blobless opt-ins, and others) the alternates path does not resolve, so they print `SUBTREE WITH NO ROW: zz-hide/`.

Note: git does not commit empty directories, so the clone-lane form needs a file under `refs/`. With an empty `refs/` the committed world simply reds.

Discriminator: `git count-objects -v` on the alternates world gives `count: 0, size: 0, in-pack: 0, packs: 0` plus an `alternate:` line. On a real bare clone it gives `count: 0, in-pack: 15133, packs: 1`. The working test is `count + in-pack > 0`. `count` alone does not work: a freshly cloned bare repository has count 0. The challenger's "count: 19" figure depends on that particular repository. Recommended: add `count+in-pack>0` as a third leg, or state in the domain sentence that an excluded directory may own no object.

**"Holds a commit" sentence: P3 wording. Not measured-false.** The only tree sentence of that kind is `tools/pack-domain.py:55`, "a repository HOLDING AT LEAST ONE COMMIT (`... --git-dir` AND `... HEAD^{commit}`, both rc 0)". The parenthetical is the operative definition, and the code does exactly that, so as a statement of the rule it is true. Read as plain English, "holding" is false for the alternates world: that directory owns zero objects. Reword it, for example to "whose HEAD resolves to a commit".

**R29-P2-02 (concurrent swap of a directory for a link mid-walk): my severity is P3. Off-repository lane only. Observation.** This needs a writer concurrent with the walk, and only `/mnt/project-files/phase14` has one. A pinned clone does not. My first run of 30 gave 11 link refusals, 7 claims found, **12 unhandled `Traceback` at rc 1** and **0 silent**. A further 60 runs with longer delays gave 60 claims found. I did not reproduce the challenger's 4/30 silent rc 0 runs. The traceback-at-rc-1 shape (an unnamed failure) is reproduced. Fix: wrap each read in `try/except OSError`, with a named refusal.

**R29-P3-01 (only the FIFO has a plant): P3. Clone lane, test coverage only.** The socket and the character device are refused correctly, as measured above. Only `plant-fifo-in-the-pack` exists. Add `plant-socket` and `plant-device`.

## Clean-up
The scratch clones, worlds and bare store were removed. Nothing was pushed or committed upstream. This file is the only thing I wrote to the shared folder.
