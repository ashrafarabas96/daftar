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

---

## DR-53 — three classes of wording block a merge; the rest do not

**The decision.** Wording and documentation findings are **not** merge-blocking and
are collected into a follow-up pull request. Three classes are blocking:

1. a **false security or protection claim**;
2. **wrong documentation of financial behaviour** — including an assertion on a
   money figure that **cannot fail**;
3. **wrong operating instructions that could cause harm**.

And any review round beyond the third on one card is reported to the owner in
one line.

**Why the ceiling exists.** One card's decision record went through five review
rounds, and every round found a false claim in the same paragraph — each one a
sentence restating a measurement that was already correct beside it. Four of
those were patched and the fifth was deleted instead; deleting ended the class.
The ceiling is there because rounds of prose repair generate the defects they
are meant to remove.

**What the blocking classes have in common** is that the reader acts on them. A
comment claiming the repository refuses GitHub-hosted jobs sat directly above
`runs-on: ubuntu-latest`; a reader who believed it would reach for a
self-hosted runner, which on a public repository is the one thing the CI
decision record forbids outright. That is class 3, not a typo.

## DR-55 — a money or security assertion arrives with the mutation that reddens it

**The decision.** Every **new** assertion about money or security carries, before
it is sent for review, a planted defect that is shown to make it fail.

**And its complement, from a probe of mine that returned nothing:** a negative
control must first prove **the mutation was applied** — the file's digest
changed, or the pattern matched. **A mutation that did not apply is a control
that did not run, not a control that passed.** A generic text substitution can
silently match nothing; the run that follows it then looks like a green
negative control and is worth nothing. The guard that caught this was a digest
comparison after the write.

**What produced the rule.** A test case named its strongest assertion "the proof
that the exactness is real" and the assertion could not fail. The prose said a
total was odd; the total is even, and the odd quantity was the bucket number.
The assertion tested `total % 2 === 0`, and the mutated total —
`18014398509481984`, exactly 2^54 — is also even, so it passed on the correct
value and on the wrong one alike. Non-representability in `[2^54, 2^55)` rests
on `% 4 === 2`, because the double step there is 4, not 2.

**Chained assertions hide each other.** That assertion sat behind a literal
comparison that failed first, so the case went red and the useless assertion
looked like the guard. Proving a specific assertion bites means blinding the
ones before it in the same case and watching that one fail alone.

## DR-56 — `0084` may be amended for a comment, and the digests say what changed

**The decision.** Changing `0084`'s blob for a **comment** is accepted: the
migration is a **candidate, not frozen** (DR-03). The conditions were measured
before the decision: the six function-body digests are identical,
`check:migrations` exits 0, and there is no behavioural effect.

**The record.** Two hash functions are named with every value, because quoting a
digest without naming its function produced a contradiction between reviewers
on this very card — one quoted git object ids, another sha256 of the content,
and both were right about the same blob. `0084`'s non-comment line count is the
load-bearing number.

| commit | git object id | sha256 of content | non-comment lines |
| --- | --- | --- | --- |
| `7b7c9cdd` (branch base) | `374814af…` | `d7205005…` | **424** |
| `a2f48d31` (the card's SQL work) | `0b5f2225…` | `a80317f3…` | **443** |
| `59eb73fb` (fix batch 1) | `0b5f2225…` | `a80317f3…` | **443** |
| `fe9e43c8` (fix batch 2) | `0b5f2225…` | `a80317f3…` | **443** |
| `30fe12b6` (comment: `count(*)`) | `ae4a7780…` | `7ebd272f…` | **443** |
| `18536104` (comment: DR-54) | `74478a87…` | `338c68ac…` | **443** |

Read down the last column: the non-comment body moved **once**, from 424 to 443,
and that was the card's actual SQL. Batches 1 and 2 are byte-identical to
`a2f48d31` under both functions — they touched no SQL at all. The last two rows
move the blob and leave 443 untouched, which is what "a comment only" means
here.

**What the comment changes bought.** The first removed a sentence saying
`customer_ar_aging` counts DISTINCT invoices within a band when its body is
`count(*)` — correct today only because `invoice_outstanding` returns one row
per invoice and asserts it, which is the very reliance the routine this card
adds refuses for itself. The second carried DR-54 into the contract. Both are
class 2 of DR-53, so neither could wait for a follow-up.
