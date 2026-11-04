# DR-84 — the queue's digest, and the gate that keeps its one open door shut

**Status: OPEN**

That line is read by a test. `tests-unit/p7-01-capture-digest-gate.test.ts`
refuses any dependency from `apps/android/app` on `:offline-kernel` while it
says `OPEN`, and permits it when it says `CLOSED`. Changing it is therefore a
decision, taken here, and not a side effect of editing a build file.

## The decision

The server's `invpl/1` digest (`inventoryIntentSha256`,
`packages/inventory/src/payload.ts:1342`) is the only proof of intent and the
only thing that suppresses a replay. The device does not compute one: no
`invpl/1` encoder is written in Kotlin now, and that work is deferred under
DR-05.

What the device guarantees instead is narrower and checkable: the request body
is captured once as bytes under a fixed idempotency key, and every resend
transmits those same bytes. `QueueDigest` computes a real SHA-256 over them —
lowercase hex, 64 characters, no prefix — and `EncryptedQueueStore` enforces it
at both of its doors: `captureWithKey` refuses a digest that is not the digest
of the payload offered with it, and `load` recomputes it from what comes back
out and refuses bytes that are no longer the ones captured. That digest is a
LOCAL integrity check on the queue and is never compared with the server, which
accepts no client digest at all.

A 409 with the same key and a different intent is never retried automatically:
the row is marked as needing attention, it alerts, and it waits for a person.
The same key with the same intent is a safe replay that returns the original
result.

## The open door, at its measured size

`Operation.capture` asks only that the digest be non-empty (`Queue.kt:358`), and
an `Operation` holds no bytes, so it cannot verify one. Measured:

- every `Operation.capture` call in this repository is under `src/test` —
  eighteen call sites, no production caller;
- `SideEffect.SendAttempt` is emitted in exactly one place, `Queue.kt:655`,
  carrying the operation's own digest;
- every caller of the store is a test too;
- `apps/android/app` does not depend on this module at all;
- no file wires the store to the state machine.

So there is no production path from an operation to a send, and the gap is
structural rather than live. It becomes reachable on the day the app is wired —
which is the day the wiring must pass the store's verified digest in.

Closing it means editing `Queue.kt` and five suites whose bytes are pinned by
the 27/27 P7-01 promotion proof, so it needs an explicit owner decision that
re-pins those digests and records the bytes before and after. Until then:

## The gate

**No pull request may add a dependency from `apps/android/app` on
`:offline-kernel` while this record says OPEN.** The guard named above fails if
one appears, and it ships its own negative control: the same check applied to a
build file that declares the dependency must fail, and applied with the status
set to CLOSED must pass, so the gate is proved able to refuse and able to be
lifted — deliberately, here.

What keeps the gap measured meanwhile is
`apps/android/offline-kernel/src/test/java/app/daftar/offline/FakeDigestOnTheWireTest.kt`:
the sanctioned path cannot carry a fake digest, and bypassing the store puts one
on the wire, asserted as a failure rather than described.
