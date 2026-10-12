# ADDENDUM 01 TO `P14-CHALLENGE-2430504.md` — A RETRACTION

**Issued by the same challenger session, after delivering the round-6 report.**
Kept as a separate file so the digest of `P14-CHALLENGE-2430504.md`
(`eb7a0bd031fbc643c9eae92df554cc23075c53be4cc56aa54aefe6781b087fd1`) does not
change under anyone who has already hashed it. Date: 2026-10-12.

## `P3-04` IS WITHDRAWN. IT WAS A FALSE FINDING, AND IT CHANGED THE PACK.

Round 5 reported, and round 6 carried forward:

> *"`locale-gen` is not present in this container"*, so the recipe's first
> reproduction step cannot be run.

**Measured, now, properly:**

```
/usr/sbin/locale-gen                      exists (4316 bytes, Aug 2024)
on root's PATH                            yes (/usr/sbin is on it)
on `claude`'s PATH                        yes (/usr/sbin is on it)
localedef --delete-from-archive en_US.UTF-8   (to test honestly)
locale-gen en_US.UTF-8
  Generating locales (this might take a while)...
    en_US.UTF-8... done
  Generation complete.                    rc=0
locale -a | grep en_US                    en_US.utf8
```

**The documented step works exactly as written.** There was no defect. I asserted
its absence from habit — I had used `localedef` since round 1 and it is in my own
container notes — and I never ran `locale-gen` before reporting that it could not
be run. That is precisely the failure class these six rounds have been finding in
the pack: **a claim that was never executed, printed as a measurement.** It is
worse here than in the pack, because a reviewer's unexecuted claim costs the
author a change rather than a correction.

**And the correction it produced should be reverted.** Both documents were
switched from `locale-gen en_US.UTF-8` to `localedef -i en_US -f UTF-8
en_US.UTF-8` on my word. `locale-gen` is the step that was actually run, it is
recorded as such in the evidence row, and it works. The original recipe was
right. (The author's own re-diagnosis — *"the binary is present, the path is
not"* — is also wrong: `/usr/sbin` is on the unprivileged `claude` account's
PATH as well. Neither of us measured it.)

`localedef` remains a correct alternative and is what this challenger used in
all six rounds, so documenting both is defensible; documenting only `localedef`
on the grounds that `locale-gen` is unavailable is not.

## WHAT THIS DOES NOT CHANGE

Nothing else in the round-6 report depends on it. `P2-01` (the freeze boundary
reads `0073` at `6fc505d`, and `.json` is outside the provenance generator's
pattern), `P3-02` (`P14-GATE-034` named for an absence nothing gates) and
`P3-03` (`c1a` printing `LAW HELD` for the wrong reason) were each executed and
stand. The verdict stays **PASS-WITH-SCOPE** and the required-for-PASS list
loses item 4.

## AND ONE FRAMING OF MINE THAT THE AUTHOR CORRECTED, RIGHTLY

I closed five reports with *"no finding has landed against the pack's
architecture; every defect has been in a document, a citation, or the harness."*
The author's reply is the better reading and I adopt it: **the architecture is
not vindicated, it is unexecuted.** There is no API, no DDL, no route and no CI
in this phase yet; the harness is the only part of Phase 14 that exists as
running code, which is exactly why every defect has been found there. Six rounds
of review on an unexecuted design is six rounds of review on an unexecuted
design. `TL-P14-SEC-01`/`-02`, `§11a` and `OD-P14-09/-10/-11` remain open with
their owners.

*`PREPARED` / `CHALLENGED` / `NOT PROMOTED`, `READY_TO_PROMOTE` = NO. This
addendum signs nothing.*
