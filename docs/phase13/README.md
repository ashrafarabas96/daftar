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

The copy in the pack and the copy here are therefore the same bytes by construction. If
they ever differ, the gate says so and refuses.

A signature on this phase names a **triple**: the commit SHA, the pack manifest's
SHA-256, and this file's SHA-256.
