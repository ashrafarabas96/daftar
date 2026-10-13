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

But "anchored to Git" is not a property of naming a SHA. Git does **not** verify a loose
object's hash when it reads it — only `fsck` does — so a store holding this file's blob
loose can serve any bytes at all under the real blob's id, and reached through
`.git/objects/info/alternates` that forges the pin with no replacement anywhere: no
`refs/replace/` exists, `rev-parse <sha>:<path>` still prints the id recorded in the tree,
and the commit, tree, worktree and branch resolution are all genuinely correct. Only the
bytes are not the object. So the identity is not taken from the store's word for it: the
id the **tree** records is read, the bytes handed over are re-hashed as Git defines an
object (`sha1("blob <len>\0" + data)`), and a mismatch is a named refusal. That is a
statement the store cannot lie about, and it subsumes the replacement case — with both
git guards stripped, a `replace` plant refuses anyway.

`proofs/r15-replace-ref-proof.sh` is the red proof for the replacement case, and it needs
no pack:
`sh docs/phase13/proofs/r15-replace-ref-proof.sh [<sha>]` builds its own clone, plants
`refs/replace/<the generator blob>`, and asserts three arms — the committed generator is
accepted; the forged one is refused **by name**; and with the guard deleted the same
forgery succeeds again. Aimed at the commit before the fix it goes red on the second arm,
which is how one knows the arms mean anything.

`proofs/a01-object-integrity-proof.sh` is the red proof for the object-integrity case, in
five arms: arm 0 establishes git's own behaviour on a tampered loose object, arm 1 accepts
an honest prepared store, arm 2 refuses the forgery **by name** with no replace ref in
sight, arm 3 shows the re-hash catching a `replace` plant with both git guards stripped,
and arm 4 deletes the re-hash and requires both forgeries to succeed again.

The CI job `phase13-proofs` runs both scripts and **asserts their exit codes**; a step that
merely ran them and printed output would report rather than check. Note what that job does
and does not cover today: this workflow's `push` trigger is `main` and `phase/**`, so it
does not fire on this preparation branch. It fires on a pull request from it, and the
branch filter is the Repo Owner's to widen.

A signature on this phase names a **triple**: the commit SHA, the pack manifest's
SHA-256, and this file's SHA-256.
