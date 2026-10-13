# Phase 14 — round 17, addendum 01

**Subject:** `b49d612da3164e746c26ef10ce612f648bc3933b`. Written after
`P14-CHALLENGE-b49d612.md` was frozen (12,568 bytes,
`1ed42b9bdc2049a48bc29c3d62f68c798fa3cd110adced105e27d1826d843787`), which is why it is a separate
file and not an edit to that one.

**Nothing here changes the round-17 verdict.** `R17-P1-01` and `R17-P3-01` stand as written; this
addendum adds measurements the author asked for in their handover and one figure of theirs I had not
checked. **No new finding.**

## 1. The four attacks the author declared unattempted and un-hardened

Their handover says: *"The four attacks you queued … are all unattempted by me — I have not
pre-hardened against them."* Measured at this head and at the parent, each with the carriers at HEAD
read from git before the tool runs.

| attack | carriers at HEAD | `7f6f535` | `b49d612` |
|---|---|---|---|
| a second **committed** document carrying the marker whole-line, then forge | `pack/AMENDMENT.md`, `pack/M.md` | 1, `AMBIGUOUS (revision … carries the manifest marker in 2 files)` | 1, identical |
| **add here / remove there** in ONE commit — the marker stripped from the manifest and added to a decoy, with the forge | `pack/DECOY.md` | 1, `NOT ANCHORED (… carries the manifest marker 0 time(s), not once)` | 1, identical |
| the marker on its own line **inside a fenced code block** of another document, then forge | `pack/HOWTO.md`, `pack/M.md` | 1, `AMBIGUOUS` | 1, identical |
| the parent backstop under a **graft boundary** | — | see §5 of the round-17 report: five constructions, all refused upstream | identical at both heads |

All four fail closed, by name, and the first three do so at the parent too, so none of them is a
behaviour this commit introduced or needed to introduce. The author's statement that they did not
pre-harden is consistent with what I measure: these worlds are refused by guards that were already
there (the carrier-count refusal and the subject-marker requirement), not by anything added this
round.

**One named residual, not a finding.** The fenced-code-block case means *any* pack document that
quotes the marker on a line of its own — inside a fence or not — turns the gate `AMBIGUOUS`. That is
fail-closed and therefore safe, but it is a convention the pack now depends on and nothing in the
pack states it. A document that explains the manifest cannot show its heading on its own line. I do
not ask for a code change for this; I ask that the constraint be written down where an author of the
next amendment will read it.

## 2. `retracted-claims.py`, a figure of theirs I had not measured

Their handover reports *"retracted-claims.py rc 0 (23 claims / 32 documents, 24 reviewer reports
exempt in code)"*. Measured in `/tmp/g33` at this head:

    rc_retracted_claims = 0   (cwd /tmp/g33/phase-preparation/phase14)
    23 retracted claim(s) enforced across 32 pack document(s); 24 challenge report(s) exempt in code

Reproduces exactly, all three figures. The exemption is still an enumeration read in code with a
refusal for a name that matches no file, which is the shape the earlier rounds asked for.

## 3. On the count, once more, since their handover quotes it differently

The committed `P14-AMENDMENT-22` §1 says the count is *"23 of 23"* at this head; the handover message
says *"24 of 24"*. The head prints **24 of 24**, so the handover's figure is the one that matches the
output and `R17-P3-01` is about the committed document only. It makes no difference to `R17-P1-01`:
both figures are the mixed count, and the marker leg's true contribution on the real pack is **1** of
24.

**What I did not do.** No file of the author's was edited; nothing was pushed; no `--write` was run
against the pack or the shared folder; the cluster was the scratch cluster on `/tmp/p14pg`.
