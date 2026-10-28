# DR-48 — the repository goes public, temporarily, to get CI back

**Decided 2026-10-28 by the owner.** This record is the tracked half of that
decision (DR-24): it states what changes, what must never ship while it holds,
and exactly how to undo it.

## Why

GitHub Actions is unmetered on public repositories and billed on private ones.
This repository was made private on 2026-10-26; a payment block on the account
then stopped **every** job from starting — measured as `workspaces` failing in
0s with an empty `runner_name` and no log at all, on six unrelated refs
including `main`. The self-hosted runner was built to work around that, and it
did, but it is a laptop: it sleeps, it is a single job slot, and its work
folder is reused rather than disposable.

Public restores free hosted runners and ends all three problems at once.

## What this card changes

`.github/workflows/ci.yml`: six `runs-on:` lines, and the comments that
explained why they used to say something else. `[self-hosted, daftar-wsl]` →
`ubuntu-latest`, for `workspaces`, `backend`, `web-admin`, `android`, `browser`
and `hygiene`. Measured against `main`: 44 lines added and 32 removed, of which
**12 are code — the six `runs-on:` lines, replaced — and 64 are comment.**

Nothing else needed changing, and that is a property of the file rather than
luck: every self-hosted-specific step is already guarded at runtime by
`runner.environment`, not by the job label. On a hosted runner the
work-folder purge skips itself, and the Chromium install takes the
`--with-deps` arm that needs passwordless sudo.

The workflow guard in `scripts/phase4-s4-gate.ts` is unaffected **by
construction, not by a count**. Its reader enters step mode only on a `steps:`
key and never consumes the value of `runs-on`, and the only **non-comment**
change in this diff is those six `runs-on:` lines.

Stated as a table rather than a sentence, because four drafts of this
paragraph each smuggled a false claim into prose and three of them were an
ambiguous list of references. Reduce `ci.yml` by deleting comment lines and
blank lines, and compare line by line:

| `ci.yml` reduced to | lines | `main` vs this commit |
| --- | --- | --- |
| no comments, no blank lines | 490 both | differs on **exactly 6** lines, **all of them `runs-on:`** |
| and no `runs-on:` lines | 484 both | **identical** |

Row 1 had to differ, or nothing would have changed. Row 2 is the one that
matters: every line of the workflow other than those six is `main`'s,
unchanged. (Deliberately no digests here: the value depends on how the
reduction treats indentation, trailing newlines and CRLF, so a digest written
down invites a later reader to compute a different one and think something
drifted. The relation and the counts above reproduce from the recipe.)

Three further corrections, all measured: `requiredCiProblems` pins step
**content** as well as order (the gate step's `run:` must equal its command
exactly and its `name:` must equal the expected name, so a renamed gate step
fails it); that script does not exist on this branch at all — it lives on the
Phase 4 lineage, where this file will eventually be read; and the marker count
is 70, not 53. Nothing here licenses renaming or re-wording a gate step.

The marker count is also unchanged by every way of counting it: 53 `- name:`,
13 `- uses:` and 4 unnamed `- run:` — 70 in total, identical before and after.
Saying "53 steps" would be wrong; 53 is the named-step count.

**No gate, assertion, threshold, timeout or `--max-warnings 0` is altered by
this card.**

## A self-hosted runner may not exist on a public repository

A public repository accepts pull requests from forks. A self-hosted runner
executes whatever a workflow tells it to, on the owner's own machine, with the
owner's own files beside it. Those two facts together are a remote code
execution path onto a personal laptop, and no amount of workflow care closes
it, because the attacker writes the workflow.

So the runners are deregistered from this repository before it goes public,
and their services are stopped. This is not a precaution that can be traded
for convenience.

## ⛔ Release-blocking: the repository must be private again before any launch

This is a blocking item for the release, not a reminder. Public is a measure
taken to finish the seal, and it ends when the seal ends.

Reverse checklist, in order:

1. `gh repo edit ashrafarabas96/daftar --visibility private
   --accept-visibility-change-consequences`, then verify three ways:
   `gh repo view --json visibility` is `PRIVATE`, the API's `.private` is
   `true`, and an unauthenticated `curl` of the repository returns `404`.
2. Re-check branch protection on `main` after the flip, **including the list
   of required status checks** — not just that protection exists. The list is
   part of what has to be re-established: it is `workspaces`, `backend`,
   `web-admin`, `android` and `browser` today, and `hygiene` joins it once #9
   is merged. Protection rules do not always survive a visibility change, and
   on a private repository without GitHub Pro they are not available at all —
   which is how this repository lost them on 2026-10-26 (TD-08). If they are
   gone, the local `pre-push` hook and the `deny` rules are the only remaining
   guard, and that must be stated rather than assumed.
3. Re-register the self-hosted runners only if CI is needed while private,
   and only after confirming the repository is private — never the other way
   round. Their files were left in place, so this is a registration step, not
   a rebuild. The ids GitHub gave them — 21 and 22 — are **not** recoverable:
   an id is issued at registration, so the new runners will have new ones. What
   carries over is their names and their folders on disk: `daftar-wsl` and
   `daftar-wsl-2`, plus their
   systemd services, the `DAFTAR-WSL-KeepAwake` task and the
   `DAFTAR-WSL-Runner-Boot` anchor task.
4. Restore `runs-on` to the self-hosted labels if, and only if, step 3 was
   carried out.
5. Re-check Secret scanning and Push protection. They are free on public
   repositories; on private ones they may need a plan that this account does
   not have, so losing them is an expected consequence of going back and must
   be recorded, not discovered later.

## What was measured before the flip

Full history of every ref that becomes public — 77 branches, 1,569 commits,
52 MB — scanned by gitleaks and by trufflehog. Findings were read one by one
rather than counted: all were test fixtures, UUID literals, migration content
hashes, placeholder DSNs whose hosts are the literals `db` and `host`, and one
deliberate `sk_live_` sentinel that exists so a redaction test has something
to redact. **Zero real credentials.**

No `.env` file, no key or certificate material, and no `.local-context` path
has ever existed in any of those refs — checked against the 2,007 distinct
paths that appear anywhere in that history, with a positive control proving
the patterns match when the thing is actually there.
