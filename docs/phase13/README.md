# Phase 13 — the prep pack's gate

Phase 13's preparation pack (the design documents, the handoff manifest, the challenge
records and the raw run logs) is kept **off Git**, under `/mnt/project-files/phase13/`.
One file of it is versioned here, and only one: the gate.

`regenerate-manifest.py` generates the pack's digest table, its git-status rows, its
measured-install block and its own verdict row, and `--check` judges all of them. While
it lived only in the pack, anyone with access to that folder could change the checker
without any committed artefact moving — and a digest of the checker stored *in* the pack
would only be the pack certifying its own checker.

So the file is committed here and the pin is anchored to Git. On every `--check` the
script hashes the bytes it is **running from** and compares them with
`git show <subject SHA>:docs/phase13/regenerate-manifest.py`. A mismatch, an absent
blob, an unreachable commit or a foreign repository are **named refusals** (exit 2), not
skips: "I could not check the checker" must never read as "the checker is fine".

"Anchored to Git" has to mean anchored to the objects, not to whatever the handed
repository reports. `git replace` rewrites what every read of an object returns, so a
clone carrying `refs/replace/<blob>` made the gate print "the generator is PINNED" while
a patched generator ran. Every git invocation in this script therefore runs with
`--no-replace-objects` **and** `GIT_NO_REPLACE_OBJECTS=1` — the blob read, the branch
resolution, the committer date the stamp is bounded by, the HEAD read and the
worktree-cleanliness read alike — and any `refs/replace/` present in the repository is
listed by name beside the pin's verdict, because being handed one is itself worth
reading.

The copy in the pack and the copy here are therefore the same bytes by construction. If
they ever differ, the gate says so and refuses.

`proofs/r15-replace-ref-proof.sh` is the red proof for that, and it needs no pack:
`sh docs/phase13/proofs/r15-replace-ref-proof.sh [<sha>]` builds its own clone, plants
`refs/replace/<the generator blob>`, and asserts three arms — the committed generator is
accepted; the forged one is refused **by name**; and with the guard deleted the same
forgery succeeds again. Aimed at the commit before the fix it goes red on the second arm,
which is how one knows the arms mean anything.

A signature on this phase names a **triple**: the commit SHA, the pack manifest's
SHA-256, and this file's SHA-256.
