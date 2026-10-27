# CI on a self-hosted runner (`daftar-wsl`) — decision and open follow-ups

Recorded under DR-24: a card, a technical-debt item, or a decision that touches code is
recorded in a **tracked** file in the nearest pull request, not only in untracked notes.

## Decision

GitHub-hosted runners stopped starting jobs entirely: every job was recorded as a failure
with **zero steps** and an empty `runner_name`, and the check annotation read *"The job was
not started because recent account payments have failed or your spending limit needs to be
increased."* That is a boot failure on the account, not a failure of any branch, and no code
change can clear it.

Because every job declares `needs: workspaces`, one blocked job left the other five
`skipped`, so the whole workflow stopped. Five jobs therefore moved to a self-hosted runner
labelled `[self-hosted, daftar-wsl]` (Ubuntu 24.04 under WSL2 on the owner's machine).

**Nothing was removed, skipped, weakened or narrowed to achieve this.** `--max-warnings 0`,
the lint scope and rule set, `NODE_OPTIONS=--max-old-space-size=6144`, the `permissions:`
block on `hygiene` and the `postgres:16` service all stand unchanged, and the per-job step
counts are unchanged.

## Follow-ups that are open, with what is and is not measured

| # | Item | Status |
|---|---|---|
| 1 | **`gitleaks` has never run on the self-hosted runner.** It is the only container action in the workflow, and in every run so far it was `skipped` because `hygiene` fails earlier at `Dependency audit`. The claim that the runner can run it is therefore **unmeasured**. It must be proven on the first run after the dependency upgrades land, by the same precedent used for the workflow-permissions fix. | NOT_RUN |
| 2 | **Playwright's apt dependencies are now machine state with no guard in the repository.** On the self-hosted path the `--with-deps` half of the browser install was satisfied once, out of band, as root; the 33 packages were taken from the tool's own `--dry-run` for the locked version, not written by hand. Nothing in CI asserts they are still present, so a `playwright-core` upgrade in the lockfile can change the required set silently. The likely failure is closed (the browser does not launch) but it is not named. | open |
| 3 | **Trust is genuinely widened.** Any `pull_request` now executes code on the owner's machine as a user in the `docker` group, which is effectively root inside the distro. The workspace is emptied before every checkout, but the npm and tool caches under `HOME` are deliberately kept, so a persistence channel between runs exists that job code can write to. The repository is private with zero forks, so the risk is **suspended, not absent**. | accepted by the owner, documented |
| 4 | **Three workflows were left on GitHub-hosted runners** — `phase2-s8-evidence.yml`, `phase2-s9-release.yml`, `phase3-s9-release.yml`. They remain blocked while the account block stands. Out of scope here, deliberately. | open |
| 5 | **The `browser` job's apt step needs root and `embedded-postgres` refuses to run as root**, which is why that job needed the out-of-band install rather than a `sudo` rule. No `NOPASSWD` rule was added: a `NOPASSWD` entry for `apt-get` is root in practice, since apt runs maintainer scripts as root. | resolved without a sudo rule |
| 6 | **YAML was not validated by a parser** — neither `js-yaml` nor PyYAML is installed locally. The evidence that the file parses is GitHub's own execution of it. | not measured |
| 7 | **Inserting a first step into six jobs is unverified against the Phase 4 gate.** `scripts/phase4-s4-gate.ts` reads this workflow and asserts step ordering, and it does not exist on `main`. This must be checked when the Phase 4 gate is wired into CI, not here. | NOT_RUN |

## Two defects found by independent review of this change and fixed in it

- The `concurrency` comment claimed that keying on `github.event.pull_request.number || github.ref`
  put the `push` and `pull_request` events of one branch in a single group. It did not: on `push`
  there is no `pull_request` context, so the key fell back to `refs/heads/<branch>` while the
  `pull_request` event keyed on the number — two groups, and the race survived. The key is now
  `github.head_ref || github.ref_name`, which is the branch name on both events, so the stated
  intent now holds.
- The workspace-purge guard was narrower than it claimed. `/home/*/` demands a trailing slash, so a
  workspace equal to the runner user's home (`/home/laptop`) would have passed the guard and been
  deleted. The guard now refuses system paths, the user's home itself, and any path less than three
  components deep. Every arm was exercised directly before commit, which is how a second hole was
  caught: stripping the trailing slash turns `/` into the empty string, which fell through the
  original replacement and made the depth test error on an empty operand.
