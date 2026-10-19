# Phase 14 — independent challenge, round 22

**Subject:** `abe95fcf7866d9b7cad026627332b184487d4c26` (parent `0332d1b0f11ec1b65cea58dfee3d4b7aed9d0226`),
branch `claude/project-thread-1zqgj8`, fetched by full object name into a clone of my own.
**Scope:** `0332d1b..abe95fc` — the required-message change, the replaced and the new arm, the pinned
`PATH`, the provenance line, retracted claim 26, and the pack and repository figures at the pushed
head.

**Verdict: REJECT.** Round 21's two findings are **answered well**: both GIT arms now require the
law rather than the header, the relative arm is rebuilt as the stronger in-pack attack, the `PATH`
mechanism is closed for the shim I measured, the provenance line does exactly what it was asked to
do — in the broken states it **names the decoy** — and retracted claim 26 is genuinely enforced, not
merely filed. The REJECT is for one published sentence and one residue of the fix:

* **`R22-P1-01` (false measured claim, blocking).** Amendment 27 §1 publishes a guard-deletion run
  "from a copy of the pack with **only the `GIT_*` scrub reverted**" in which "**all three** GIT
  arms now print FAIL". Measured here: reverting only the scrub prints **two** FAILs, and
  `git-binary-shim-refused` stays `ok`. The third FAIL needs a **second** deletion, of the `PATH`
  pin, which prints exactly **one** FAIL. The conclusion the sentence draws is true — the arms are
  not tautologies — but the evidence under it is not what it says, and the distinction decides what
  may be deleted later.
* **`R22-P1-02` (fail-open, narrow reach).** The pinned `PATH` lists `/usr/local/sbin:/usr/local/bin`
  **ahead of** `/usr/bin`, so a `git` placed at `/usr/local/bin/git` is still taken: rc **0**, three
  revisions, **no refusal**, on a forgery the subject otherwise refuses.

**`abe95fc` is not signed**, and no earlier SHA of this lane is signed.

---

## 1. What round 21 asked for, re-measured

Four copies of the tool, one world, premises asserted from git first — **pack walk 4, absolute decoy
walk 3, in-pack decoy walk 3**. `LAW` is the required message
`REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md`.

| arm | `0332d1b` | `abe95fc` | subject, **scrub reverted** | subject, **`PATH` pin removed** |
|---|---|---|---|---|
| absolute `GIT_DIR` decoy | rc 1, LAW, 4 | rc 1, LAW, 4 | **rc 0, no refusal, 3** | rc 1, LAW, 4 |
| in-pack `GIT_DIR=decoy.git` | rc 1, LAW, 4 | rc 1, LAW, 4 | **rc 0, no refusal, 3** | rc 1, LAW, 4 |
| `PATH` shim | **rc 0, no refusal, 3** | rc 1, LAW, 4 | rc 1, LAW, 4 | **rc 0, no refusal, 3** |
| no environment | rc 1, LAW, 4 | rc 1, LAW, 4 | rc 1, LAW, 4 | rc 1, LAW, 4 |

Each arm is held by **exactly one** guard, and each guard holds exactly its own arm. That is the
table §2 is about.

**The required message now discriminates.** Through the author's own sweep, the subject prints
`ok git-dir-decoy-refused`, `ok git-dir-in-pack-decoy-refused` and `ok git-binary-shim-refused`,
each *"refused with REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-test.md"* — the law, not the
header. Full sweep at the committed tree: **rc 0, 74 ok, 0 not as required**, cluster up.

**The provenance line earns its place.** It is not decoration: in the broken states it prints the
attack. With the scrub reverted and the absolute decoy in play it reads

    read: repository /tmp/t33/W/pack; git directory /tmp/t33/F/.git; git version 2.43.0 at /usr/bin/git

— the forged repository, named in the output. With the in-pack decoy it reads
`repository NONE (no repository was walked); git directory …/W/pack/decoy.git`, which is accurate
for a bare decoy and conspicuous. At the real pack it reads
`read: repository /tmp/g45; git directory /tmp/g45/.git; git version 2.43.0 at /usr/bin/git`.

**Retracted claim 26 is enforced, not filed.** Measured on copies of the pack: the copied pack is
rc 0; the sentence *"the row refusal specifically"* appended to `P14-MIGRATION-PATCH-REQUEST.md`
gives **rc 1** with `RETRACTED CLAIM PRESENT: P14-MIGRATION-PATCH-REQUEST.md:1576 — 'the row refusal
specifically'` and the reason quoted; the same sentence appended to a challenge report gives rc 0,
exempt as designed. The strike in amendment 26 is in place and accurate.

## 2. `R22-P1-01` — "only the scrub reverted … all three FAIL" is not what happens

Two guard-deletion runs of the whole sweep, each from a copy of the pack with **one** change and
nothing else, both read by the required message rather than by the exit code:

| copy | FAILs | which |
|---|---|---|
| `_env = dict(os.environ)` — the scrub reverted, **both keys and the `PATH` pin kept** | **2** | `git-dir-decoy-refused`, `git-dir-in-pack-decoy-refused` |
| the `PATH` pin removed from `_env.update(...)`, **the scrub kept** | **1** | `git-binary-shim-refused` |

2 + 1, from two deletions. Amendment 27 §1 attributes 3 to one. The shim arm cannot be held by the
scrub: the shim is a directory prepended to `PATH`, and the pin — untouched in the first copy —
is what excludes it. I expect the copy that produced the published output reverted the whole `_env`
construction, dropping the pin with it; either way the sentence does not describe the run, and this
is the same shape as the claim struck as retracted claim 26 one round ago: a sentence wider than the
measurement beneath it.

The fix is a sentence, not code: say two deletions and give both counts, or say the copy reverted
the whole built environment. The useful fact to publish is the one in §1's table — **one guard per
arm**, which is a stronger statement than "three arms fail together".

## 3. `R22-P1-02` — the pinned `PATH` puts `/usr/local/bin` ahead of `/usr/bin`

The pin is `'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'`. The first two entries
precede `/usr/bin`, and `/usr/local/bin` is the conventional place for a locally installed binary.
Measured, with the shim written to `/usr/local/bin/git` and removed again in the same command:

    rc=0
    read: repository /tmp/t33/W/pack; git directory /tmp/t33/F/.git; git version 2.43.0 at /usr/local/bin/git
    manifest: … reviewer-row history checked over all 3 revision(s) of this manifest …

A forgery the subject refuses by row passes at rc 0 with no refusal. The reach is narrower than
`GIT_DIR`'s — it needs write access to a system directory rather than an exported variable — but it
is the same mechanism the pin was added to close, and it is also an **honest-mistake** surface: a CI
step that builds or installs a newer git into `/usr/local/bin` silently changes which binary the
gate runs. The provenance line discloses it, which is the first time in this lane that an attack
shows up in the output; disclosure is not refusal.

**Remedy, measured, and it folds in §4.** Put `/usr/bin:/bin` first and resolve the binary **once**,
then use that absolute path:

    _PINNED_PATH = '/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin:/usr/local/sbin'
    _GIT_BIN = shutil.which('git', path=_PINNED_PATH)
    … subprocess.run([_GIT_BIN, '-C', _md, '--no-replace-objects', …], env=_env)

| | subject | subject + remedy |
|---|---|---|
| shim at `/usr/local/bin/git` | **rc 0, no refusal, 3 revisions**, line names `/usr/local/bin/git` | **rc 1, LAW, 4 revisions**, line names `/usr/bin/git` |
| real pack | rc 0, 65 rows + manifest, 65 files, 29 revisions | **identical** |

Resolving once also closes a smaller gap: today the provenance line resolves the binary with
`shutil.which` while `subprocess` resolves `'git'` independently on the same string, so the line
*asserts* the binary by a second lookup instead of *reporting* the one that ran. With `_GIT_BIN`
they are one object.

## 4. `R22-P2-01` — no `git` on the pinned `PATH` is an unhandled traceback, not a refusal

The pin I recommended in round 21 created a way for this tool to die without naming why. With the
pinned `PATH` containing no `git` — which is an ordinary CI image where git lives in `/opt/...`,
`/nix/store/...` or a Homebrew prefix — the subject answers:

    rc=1
    Traceback (most recent call last):
    FileNotFoundError: [Errno 2] No such file or directory: 'git'

**rc 1 is the gate's stale code**, so a runner that reads the exit code cannot tell *the manifest is
stale* from *this tool could not run at all*. The pack's own rule is that a refusal is by name. With
the §3 remedy the same condition answers

    rc=2
    CONFIGURATION ERROR: no `git` executable was found on the pinned PATH (…), so no history could
    be read and nothing here is a verdict about this manifest.

rc 2 is the pack's configuration code, distinct from 1. This is mine as much as the author's: I
proposed the pin without measuring what it does where git is elsewhere.

## 5. What else I attacked at this head

* **Each guard against the other's arm** (§1's table) — no cross-protection, which is what makes
  §2's distinction matter.
* **The three arms' premises** — asserted from git before every verdict: pack walk 4, absolute decoy
  3, in-pack decoy 3.
* **Retracted claim 26** — planted in a non-exempt document (refused by name, file and line) and in
  an exempt reviewer report (rc 0, as designed).
* Carried from rounds 20 and 21, unchanged at this head: `refs/replace` under both bases,
  `GIT_NO_REPLACE_OBJECTS=0`, grafts in both arms, the commit-graph route, `HOME`/`XDG_CONFIG_HOME`,
  `LC_ALL`, `LANG`, `TZ`, `PAGER`. The attack set is now five mechanisms closed
  (replace, grafts, `GIT_DIR` absolute, `GIT_DIR` in-pack relative, `PATH` prepend) and one open
  (`PATH` *inside* the pinned set, §3). That is the set I tried, not a statement that it is
  exhausted.

## 6. Figures at the pushed head

Fresh clone of `abe95fc`, premises asserted — `refs/replace` rows **0**, no file at
`.git/info/grafts`, `rev-parse --is-shallow-repository` **false**:

* `tools/gate-sweep.sh` — **rc 0, 74 ok, 0 not as required**, cluster up.
* `tools/manifest-digests.py --check` — **rc 0 in both lanes**, **65** artifact rows + the manifest,
  **65** files, **29** revisions, **1** found by the marker.
* The marker revision, by the tool's own ERE run independently: **`08d23da`**, and only that one.
* `tools/citation-provenance.py --check` — **rc 0**. `tools/retracted-claims.py --check` — **rc 0**,
  *"26 retracted claim(s) enforced across 37 pack document(s); 30 challenge report(s) exempt"*.
* My round-21 words are committed **unedited**: `P14-CHALLENGE-0332d1b.md`, 15,546 bytes,
  `019daf2257e941ffaf9b20101d91fe4b5b32810e28adfeac0cb2e6b499f9744d`, byte-identical to my frozen
  copy (`cmp` clean).

## 7. Repository gates — three worlds, one never-built clone each

Node v24.21.0, npm 11.19.0, in the order shown, in a clone with no `dist` anywhere before `npm ci`.

| reading | `abe95fc` (subject) | `0332d1b` (parent) | `6fc505d` (merge-base) |
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

Subject measured this round in `/tmp/g45`; the parent column is round 21's reading in `/tmp/g43`
and the merge-base column round 19's in `/tmp/g36`, quoted as measured and not re-run. The cold reds
are `G6`, present on `main` too. Gate list derived from the diff, which touches only `.md`, `.py`,
`.sh` and one `.tsv` under the pack: the repository has no shell, python or tsv gate, so
`prettier --check .` is the one gate this diff can move, and it is **0**.

## 8. Residuals carried, not closed

* **Parents-unknown unwitnessed** — five constructions, none reaching the state, fails closed,
  signed by neither of us. No new construction from either side this round.
* **`GIT_EXEC_PATH`** unmeasured in this container, named in both tools.
* **The translated-git leg** unmeasured here: git's message catalogues are not installed.
* **CI has never run a Phase 14 SHA**, and no workflow in this tree runs the pack's gates.
* **`OD-P14-09/-10/-11`** open with Ashraf; not mine to close.

## 9. What is owed

**ONE commit**, holding:

1. Amendment 27 §1 corrected: two deletions, two counts — the scrub reverted alone prints 2 FAILs
   (both `GIT_DIR` arms), the `PATH` pin removed alone prints 1 (`git-binary-shim-refused`) — or
   say plainly that the copy reverted the whole built environment. Publishing *one guard per arm*
   is the stronger claim and it is true.
2. The pinned `PATH` reordered with `/usr/bin:/bin` first, the binary resolved **once** into
   `_GIT_BIN` and passed as an absolute path, in both tools, with the provenance line reporting that
   same object.
3. A refusal by name, at the pack's configuration exit code, when no `git` is found on the pinned
   path — the condition §4 measures.
4. A red proof for §3's arm: a `git` inside the pinned set ahead of `/usr/bin`, premise asserted
   (the binary `shutil.which` finds is not `/usr/bin/git`, and the walk it serves differs from the
   pack repository's), requiring the law. If that proof cannot be written without writing into a
   system directory, say so and leave §3 as a named residual rather than claiming it closed.

Nothing else is owed to me. I hold at `abe95fc` and will run round 23 narrow on the commit that
answers this.
