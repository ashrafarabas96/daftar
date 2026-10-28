# DR-51 and DR-52 — the runner rule is suspended, and a card is not accepted on its author's word

**Status.** Both decided by the owner on 2026-10-28. Binding on every session.

---

## DR-51 — DR-34 is **suspended**, not retired

**The decision.** While no self-hosted runner is registered on this repository
there is **no limit on local load**: tests, builds and several agents in
parallel are all allowed. DR-34 becomes effective again **automatically** the
moment a self-hosted runner is registered — and registering one is permitted
**only after the repository has been made private again** (DR-48).

**Why it was in force.** DR-34 forbade any local test run, build, Docker,
`typecheck` or `lint` while `backend` or `browser` was running. It was a
**resource** rule, never a correctness rule: the runner was a systemd service
inside a WSL distribution on the owner's laptop with a single job slot, so local
work competed with CI for the same cores and RAM. Measured at the time:
`backend` peaked at 4.4 GiB of the distribution's 8.9 GiB, and the `Lint` step
alone is allowed a 6144 MiB V8 heap by the INFRA-02 fix. Worse, a long job that
lost the runner was **cancelled rather than failed**, so two runs were lost
without a failure to read.

**Why it is suspended.** DR-48 made the repository public, deleted both runners
and moved every job back to GitHub-hosted machines. Measured:
`GET /repos/.../actions/runners` reports `total_count: 0`, and
`.github/workflows/ci.yml` names `ubuntu-latest` for all six jobs. A
GitHub-hosted job runs on GitHub's machine and cannot be slowed by this laptop,
and the six jobs now run in parallel instead of queueing behind one slot. The
rule's subject no longer exists.

**Why suspended rather than retired.** The runner was built once and can be
built again; DR-48's own reverse-migration checklist is a release blocker, and
making the repository private is exactly the step that would bring a
self-hosted runner back. A retired rule would have to be rediscovered at that
moment, which is when it matters most. So it is written down as dormant with a
stated trigger instead.

**The trigger, so it cannot be missed.** The rule is dormant **if and only if**
`GET /repos/<owner>/<repo>/actions/runners` reports `total_count: 0`. That is
one command, and it is the condition — not the repository's visibility, and not
anyone's memory of which machine CI last ran on. Anyone registering a runner
re-arms DR-34 by that act, and must say so.

**What was never a capacity rule and is therefore untouched:** no pull request
is pushed before its local verification has passed (T5); review notes are
batched into one round rather than pushed one at a time, because a review
signature belongs to one commit (DR-25); and one writer per file.

## DR-52 — a card is not accepted on its author's word

**The decision.** No card is accepted until the **main session itself** re-runs
`format`, `lint` and `typecheck` — **after building the packages the card
depends on** — and records the exit codes. An author's report that they are
green is not evidence.

**What produced the rule.** The DR-29 card was handed over with its red-then-
green ordering and its static checks described as *claimed by construction, not
measured*. When the main session ran them: `check:migrations` 0, the body-digest
guard 0, `lint` 0 — and `prettier --check` **1** across five of the card's own
files, with `typecheck` **2** carrying **15 errors, every one of them in a file
the card had modified**. The cause was in the card: DR-39 had made `bucket_no`,
`currency_code` and `invoice_count` nullable in the aging row type, the card
updated its fixture rows for the two new fields, and it did not update the
places that read those fields. None of it was environmental — the five files
carried **zero** CR bytes, so the line-ending explanation that has excused
`prettier` here before did not apply.

**Two traps this rule has to survive, both measured in this project.**

1. **Build first, or the measurement is noise.** In a fresh worktree
   `typecheck` reported **286** errors, all `Cannot find module '@daftar/...'`;
   after building the packages it reported **0**. A card is neither green nor
   red until its dependencies are built. Relatedly, the root
   `npm run build --workspaces --if-present` builds in alphabetical order, so
   `apps/api` is attempted before `packages/accounting` and fails — a
   pre-existing property of the root script, not a card's defect.
2. **An exit code read off a pipe is not evidence.** `cmd | tail` reports
   `tail`'s status. One batch in this very session printed `exit 0` while the
   script it was supposed to run did not exist. Redirect to a file and read
   `$?`.

**And the measurement must be attributed before it is reported.** Baseline
first: a failure is the card's only once the same command has been shown to pass
without the card's changes. Three of the failures above were the card's; the
build failure was not, and it is recorded as not.
