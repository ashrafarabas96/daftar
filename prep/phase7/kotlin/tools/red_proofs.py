#!/usr/bin/env python3
"""P7 — the red proofs: one planted defect per law, each required to turn a NAMED test red.

A green suite proves that the code passes the suite. It does not prove that the
suite would notice the code being wrong, and the two are routinely confused. So
every law in `Laws.kt` has an entry here that breaks exactly that law in a COPY
of the kernel and requires a named test to fail.

Two rules this harness learned the hard way elsewhere in this project, both
enforced below:

  * PROVE THE MUTATION LANDED. A replacement whose pattern no longer matches
    the source silently mutates nothing, the suite stays green, and the proof
    reports success — recording a missing law as fine. Every mutation is
    diff-checked before its run is read, and a mutation that did not land is a
    FAILURE of the proof, not a skip.

  * A RED PROOF MUST NAME THE REFUSAL IT EXPECTS. "The suite went red" is not
    evidence that THIS law is defended: a mutation that breaks compilation, or
    that trips some unrelated assertion, reddens the suite while leaving the
    law undefended. Each proof names the test that must fail, and a red run
    that fails only other tests does not satisfy it.

Exit 0 only when every proof is satisfied.
"""
from __future__ import annotations

# F-A, the coordinator's actual-diff review of `184f7d7`: a P1 fail-open,
# pre-existing and measured rather than argued. `tools/red-proofs.sh` ran this
# file as `python3 red_proofs.py`, with no `-I`, so Python prepended THIS
# DIRECTORY to `sys.path` and a file dropped beside this one shadowed the
# standard library. Reproduced here before it was fixed: with one guard hollowed
# so the run genuinely fails, the wrapper returns **rc 1** on its own and
# **rc 0** with a planted `tools/shutil.py` whose `atexit` hook calls
# `os._exit(0)` — the SAME output, `SELF-TEST FAILED (1 of 16): the guards are
# not armed.`, under both. A verdict the calling command throws away cannot be
# recovered by anything the file does later, so the refusal is here, ABOVE every
# import but `sys`, and it NAMES itself: an arm that reads a return code or a
# digest instead of a refusal name is unarmed.
#
# This refusal never re-execs. Re-exec is how a program loses the very property
# it is checking: the second interpreter's flags are chosen by whatever built the
# command line, and the first one has already imported whatever was planted.
import sys

if not sys.flags.isolated:
    print(
        "REFUSED-P7-HARNESS-NOT-ISOLATED: this harness was started without -I, so the "
        "directory holding it is on sys.path and any file beside it shadows the standard "
        "library. Run it as `/usr/bin/python3 -I prep/phase7/kotlin/tools/red_proofs.py`. "
        "Refusing rather than re-exec'ing: a re-exec would import the planted module first."
    )
    raise SystemExit(2)

import os

# F-H, the coordinator's review of `85bfbf5`. It sits ABOVE every mode — the
# isolation probe included — because the refusal has to precede the first
# opportunity to fork, and because a mode that exits above it is a mode the
# bound does not cover: placed below the probe, the arm that set a depth of
# three watched the probe answer normally and measured nothing. The isolation
# refusal above still runs first, so `-I` is guaranteed here and `os` cannot be
# a file dropped beside this one. Nothing between them spawns anything.
_DEPTH_READ = (os.environ.get("P7_HARNESS_SPAWN_DEPTH", "0") or "0").strip()
try:
    _DEPTH = int(_DEPTH_READ)
    _DEPTH_IS_READABLE = True
except ValueError:
    _DEPTH = 0
    _DEPTH_IS_READABLE = False

# R20-04, the twentieth challenge, and the coordinator's F-N: the guard here was
# `_DEPTH_READ.lstrip("+").isdigit()`, and `isdigit()` is true for Unicode digits
# that `int()` refuses -- so `³` brought back the very traceback this refusal
# was written to remove, one character away, and the arm could not see it
# because the arm was a LIST OF FIVE NAMES. A classification where this lane's
# rule is construction. The readable set is now exactly the set `int()` accepts,
# because `int()` is what decides it, and no list is involved at all.
if not _DEPTH_IS_READABLE:
    # R19-03, the nineteenth challenge. This was `int(...)` unguarded, so a
    # value like `abc` or `3.0` ended the harness in a TRACEBACK. Fail-closed,
    # so it hid nothing — but this lane refuses BY NAME, and a traceback is not
    # a name. Refusing rather than defaulting to 0: a depth nobody can read is
    # not a depth of zero, and treating it as one is the fail-open shape.
    print(
        f"REFUSED-P7-SPAWN-DEPTH-UNREADABLE: P7_HARNESS_SPAWN_DEPTH is "
        f"{_DEPTH_READ!r}, which is not a whole number, so how deep this process is cannot "
        f"be read. This harness will not run at an unknown depth: it has twice exhausted "
        f"this container's memory by spawning itself."
    )
    raise SystemExit(2)

# Coord F-T, the ninth actual-diff review: closing F-N by construction WIDENED
# the accepted set downward, because `int()` accepts what `isdigit()` refused --
# a sign. `P7_HARNESS_SPAWN_DEPTH=-1000000` was read as a depth, the cap `> 2`
# was false, and the child was handed -999,999, so a million spawns stood
# between the refusal and the state it exists to refuse. A depth is a count of
# spawns and cannot be negative, so a negative one is refused BY NAME here
# rather than being carried as a number nothing can act on. Fail-closed either
# way, and it takes an operator setting it, which is why the review filed it
# below the blocking line.
if _DEPTH < 0:
    print(
        f"REFUSED-P7-SPAWN-DEPTH-NEGATIVE: P7_HARNESS_SPAWN_DEPTH is {_DEPTH_READ!r}, and a "
        f"depth is a count of spawns, so a negative one is not a depth. Carrying it would put "
        f"this run that many spawns below the cap that stops this file spawning itself."
    )
    raise SystemExit(2)

if _DEPTH > 2:
    print(
        f"REFUSED-P7-HARNESS-SPAWNED-ITSELF: this process is "
        f"{_DEPTH_READ} spawns deep and the deepest legitimate "
        f"chain is 2 (harness, self-test child, isolation probe). A deeper one is this file "
        f"spawning itself, which has twice exhausted this container's memory, so it refuses "
        f"rather than forking again."
    )
    raise SystemExit(2)

if "--isolation-probe" in sys.argv:
    # Reached only WITH -I, because the refusal above exits first without it.
    # The isolation arms below spawn THIS rather than `--self-test`: the first
    # draft of them spawned the self-test from inside the self-test, which
    # spawns it again without end. It reached 561 processes and 10.4 GB before
    # the Kotlin compiler was OOM-killed and the recursion was caught.
    # Disclosed because this harness's own rule is that a guard which cannot be
    # run is not a guard, and that version could not be run at all.
    # R21-01: the probe also reports the `PATH` it was HANDED, because the
    # wrapper assigning `PATH` and the child receiving it are two facts, and an
    # arm that reads only the first measures a line of text rather than an
    # environment.
    print("P7-ISOLATION-PROBE: isolated, so no file beside this one is importable")
    print("P7-ISOLATION-PROBE: PATH=%s" % os.environ.get("PATH", ""))
    raise SystemExit(0)

import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


@dataclass(frozen=True)
class Proof:
    law: str
    """The file, relative to the kernel root, the defect is planted in."""
    path: str
    """Exact text to replace. Matched literally; a miss is a failed proof."""
    find: str
    replace: str
    """The test that MUST fail. Matched against the runner's failure lines."""
    expect_red: str
    why: str
    edits: tuple[tuple[str, ...], ...] = ()
    """Further (find, replace) pairs applied after the one above, in order.

    A defect that is one edit in one place is one edit here, which is every
    proof written before the eleventh review. Some of that review's plants are
    not: "the companion object moved to the end of the class" is a deletion and
    an insertion, and each of its plants has to be paired with the HARM it used
    to let through, because the edit alone is now a no-op and a proof whose
    mutation changes nothing measures nothing. Every pair is held to the same
    rule as the first — matched literally, exactly once, and a miss is a FAILED
    proof — so a multi-edit plant cannot half-land.

    A pair is an edit to `path`. A TRIPLE is `(path, find, replace)`, for a
    plant that spans two files — the thirteenth review's blocker is one: a
    wrapper in the test and the kernel arm it hides the loss of.
    """


# The HARM the eleventh review's four plants used to let through: one more
# conditional claim, about `offline.permission_revoked` — a code that reaches a
# row as `lastCode` and never as `step.code`, so nothing in the reachable space
# produces it. Each of those plants defeated the old text sweep on its own and
# is a no-op against the registry, so each is paired with this, because an edit
# that changes nothing measures nothing.
CLAIM_SITE = (
    '                            claimAbout(\n'
    '                                "E-04/not-sendable-offers-a-button-its-reader-can-press",\n'
    '                                "offline.not_sendable",\n'
    '                                step.code,\n'
    '                            ) {'
)


def a_claim_about(code: str) -> str:
    """A lawful claim SITE about `code`, through the helper, inserted above E-04's."""
    return (
        '                            claimAbout(\n'
        '                                "a-plant/a-claim-about-a-code-nothing-produces",\n'
        '                                ' + code + ',\n'
        '                                step.code,\n'
        '                            ) {\n'
        '                                assertEquals(\n'
        '                                    OperationState.NEEDS_ATTENTION, op.state,\n'
        '                                    "a permission refusal outside NEEDS_ATTENTION",\n'
        '                                )\n'
        '                            }\n'
    ) + CLAIM_SITE


A_CLAIM_ABOUT_AN_UNPRODUCED_CODE = a_claim_about('"offline.permission_revoked"')
THE_HARM = (CLAIM_SITE, A_CLAIM_ABOUT_AN_UNPRODUCED_CODE)

PROOFS: list[Proof] = [
    Proof(
        law="P7-L1-DEVICE-IS-NOT-AUTHORITY",
        path="src/app/daftar/offline/Outcome.kt",
        find="            status in 200..299 ->\n                Decision.Synced(answered.replayed == true, P7Laws.REPLAY_IS_SUCCESS.id)",
        replace="            status in 200..299 || status in 500..599 ->\n                Decision.Synced(answered.replayed == true, P7Laws.REPLAY_IS_SUCCESS.id)",
        expect_red="no answer outside 2xx can ever produce Synced",
        why="a 5xx is treated as a commit, so the device reports a sale the server may never have made",
    ),
    Proof(
        law="P7-L2-KEY-MINTED-AT-CAPTURE-AND-IMMUTABLE",
        path="src/app/daftar/offline/Queue.kt",
        find="                    listOf(SideEffect.SendAttempt(id, payloadDigest, attempts + 1, scope)),",
        replace='                    listOf(SideEffect.SendAttempt(id + "-" + (attempts + 1), payloadDigest, attempts + 1, scope)),',
        expect_red="a sale committed by the server and lost in transit is not sold twice",
        why="every attempt carries a fresh key, so a retry after a lost answer posts the sale a second time",
    ),
    Proof(
        law="P7-L3-PAYLOAD-FROZEN-AT-CAPTURE",
        path="src/app/daftar/offline/Queue.kt",
        find="""            } else if (event.digestNow != payloadDigest) {
                // Loud, local, and before the wire: the server would answer
                // this with a permanent key conflict.
                Step.Refused("offline.payload_changed_after_capture", P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id)""",
        replace="""            } else if (false) {
                // Loud, local, and before the wire: the server would answer
                // this with a permanent key conflict.
                Step.Refused("offline.payload_changed_after_capture", P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id)""",
        expect_red="a payload recomputed at send time is refused here, not by the server",
        why="a payload rebuilt at send time goes out under the original key, which the server then refuses forever",
    ),
    Proof(
        law="P7-L4-NO-SILENT-RESOLUTION-OF-A-MATERIAL-CONFLICT",
        path="src/app/daftar/offline/Queue.kt",
        find="                } else if (effect.isMaterial) {\n                    // Abandoning a financial or stock operation that the server\n                    // may hold is not a decision the device may record.\n                    Step.Refused(\"offline.material_cannot_be_abandoned\", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)",
        replace="                } else if (false) {\n                    Step.Refused(\"offline.material_cannot_be_abandoned\", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)",
        expect_red="a stock conflict waits for a person and keeps the server's own words",
        why="a refused stock movement can be made to disappear by the device, with no human and no record",
    ),
    Proof(
        law="P7-L5-NO-LOCAL-DELETE-BEFORE-A-CONFIRMED-OUTCOME",
        path="src/app/daftar/offline/Queue.kt",
        find="            if (attempts == 0 && !isTerminal) {",
        replace="            if (state == OperationState.CAPTURED || state == OperationState.QUEUED) {",
        expect_red="a sale told to wait is back in the queue and still cannot be cancelled",
        why="the original defect: gating the cancel on the state lets a sale the server may hold be cancelled once a 429 has returned it to the queue",
    ),
    Proof(
        law="P7-L6-A-REPLAY-IS-A-SUCCESS",
        path="src/app/daftar/offline/Outcome.kt",
        find="                Decision.Synced(answered.replayed == true, P7Laws.REPLAY_IS_SUCCESS.id)",
        replace='                if (answered.replayed == true) {\n                    Decision.NeedsAttention("offline.duplicate", false, P7Laws.REPLAY_IS_SUCCESS.id)\n                } else {\n                    Decision.Synced(false, P7Laws.REPLAY_IS_SUCCESS.id)\n                }',
        expect_red="every 2xx syncs and carries the server's own replayed flag unchanged",
        why="the server's own truth is treated as a duplicate to be queried, which is how a merchant is asked to resolve a sale that is already correct",
    ),
    Proof(
        law="P7-L7-A-LOST-RESPONSE-RESOLVES-ONLY-BY-REPLAY",
        path="src/app/daftar/offline/Outcome.kt",
        find="        if (result is AttemptResult.NoAnswer) {\n            return Decision.ResolveByReplay(nextDelay, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)",
        replace='        if (result is AttemptResult.NoAnswer) {\n            return Decision.NeedsAttention("offline.network", false, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)',
        expect_red="an unanswered attempt is always unknown, never failed and never done",
        why="a lost answer is reported as a failure, so a committed sale is shown to the merchant as not made",
    ),
    Proof(
        law="P7-L8-THE-DEVICE-CLOCK-IS-NOT-AUTHORITY",
        path="src/app/daftar/offline/Backoff.kt",
        find="        val bits = mix(operationId, nextAttempt) ushr 11",
        replace="        val bits = java.util.Random().nextLong() ushr 11",
        expect_red="the schedule survives process death because it is derived, not drawn",
        why="a drawn delay is re-drawn after a crash, so a crash loop walks a backed-off operation back to its first short delay",
    ),
    Proof(
        law="P7-L9-A-READ-CACHE-IS-REPLACED-NOT-MERGED",
        path="src/app/daftar/offline/Conflict.kt",
        find="            SyncDirection.READ_PROJECTION -> setOf(MergeStrategy.SERVER_REPLACES)",
        replace="            SyncDirection.READ_PROJECTION -> setOf(MergeStrategy.SERVER_REPLACES, MergeStrategy.FIELD_MERGE)",
        expect_red="a read cache is replaced and nothing else",
        why="a cache with no authority is allowed to contribute fields to the answer, so stale local values survive a server read",
    ),
    Proof(
        law="P7-L10-NO-LAST-WRITE-WINS-ON-MATERIAL-STATE",
        path="src/app/daftar/offline/Conflict.kt",
        find="                    setOf(MergeStrategy.HUMAN_DECIDES)",
        replace="                    setOf(MergeStrategy.HUMAN_DECIDES, MergeStrategy.LAST_WRITE_WINS)",
        expect_red="last-write-wins and field merge are permitted nowhere, over the whole table",
        why="money and stock become resolvable by whichever clock is later, which is the defect the entire conflict model exists to forbid",
    ),
    Proof(
        law="P7-L11-NO-DEFAULT-EFFECT-CLASS",
        path="src/app/daftar/offline/CommandEffects.kt",
        find="    fun require(kind: CommandKind): EffectClass = registered[kind] ?: throw UnclassifiedCommand(kind)",
        replace="    fun require(kind: CommandKind): EffectClass = registered[kind] ?: EffectClass.BENIGN",
        expect_red="an unregistered command refuses by name and is never treated as benign",
        why="an unclassified command is answered BENIGN, so an unregistered sale becomes something the device may abandon by itself",
    ),
    Proof(
        law="HARNESS-THE-BENIGN-FALLBACK-GUARD-CAN-SEE",
        path="src/app/daftar/offline/CommandEffects.kt",
        find="    fun register(kind: CommandKind, effect: EffectClass) {",
        replace="    fun register(kind: CommandKind, effect: EffectClass = EffectClass.BENIGN) {",
        expect_red="no source in the kernel defaults or falls back to BENIGN",
        why="a defaulted BENIGN parameter is planted where no caller omits the argument, so ONLY the textual guard can notice it — which is what makes that guard's green verdict mean absence rather than blindness",
    ),
    # ── The harness proving its OWN guards, not the kernel's ───────────────
    Proof(
        law="HARNESS-THE-MODEL-CHECK-IS-NOT-VACUOUS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="        add(QueueEvent.ProcessDeath)",
        replace="        // add(QueueEvent.ProcessDeath)",
        expect_red="every reachable configuration honours every invariant",
        why="the search stops exercising process death; without the non-vacuity assertions it would still pass every invariant, having simply stopped looking",
    ),
    Proof(
        law="HARNESS-THE-EXHAUSTIVE-SWEEP-CANNOT-SHRINK",
        path="test/app/daftar/offline/OutcomeExhaustiveTest.kt",
        find="        for (status in 0..699) {\n            for (code in codes) {\n                for (replayed in listOf(null, false, true)) {\n                    for (ra in retryAfters) {\n                        block(AttemptResult.Answered(status, code, replayed, ra))",
        replace="        for (status in 200..299) {\n            for (code in codes) {\n                for (replayed in listOf(null, false, true)) {\n                    for (ra in retryAfters) {\n                        block(AttemptResult.Answered(status, code, replayed, ra))",
        expect_red="no answer outside 2xx can ever produce Synced",
        why="the sweep is narrowed to the statuses that pass; the counted subject set is what makes an exhaustive claim falsifiable",
    ),
    Proof(
        law="P7-L12-QUEUE-ROW-CARRIES-ITS-OWNER",
        path="src/app/daftar/offline/Scope.kt",
        find='        require(businessId.isNotBlank()) { "a queue row must record the business it was captured under" }',
        replace="        // require(businessId.isNotBlank())",
        expect_red="a scope with a blank tenant, business or member cannot be constructed",
        why="a row can be captured with no business, so the one field the server derives source identity from is absent and the row's owner is whoever is signed in at send time",
    ),
    Proof(
        law="P7-L13-NO-SEND-UNDER-A-SCOPE-IT-WAS-NOT-CAPTURED-UNDER",
        path="src/app/daftar/offline/Queue.kt",
        # NOT `if (false && event is ...)`: putting the constant first kills
        # Kotlin's smart cast, so `event.actingScope` stops resolving and the
        # mutation fails to COMPILE. A compile failure reddens the suite while
        # proving nothing about the law, which is the exact trap this harness
        # refuses — and it did refuse it, by name, when that was tried. The
        # mutation below keeps the `is` check, so the smart cast survives, and
        # neutralises only the comparison.
        find="        if (event is QueueEvent.ByScope && !event.actingScope.mayAct(scope, event)) {",
        replace="        if (event is QueueEvent.ByScope && !event.actingScope.mayAct(event.actingScope, event)) {",
        expect_red="a sale captured in one business is not sent under another",
        why="the scope gate is disabled, so a sale captured in business A is sent under business B's header with A's key and is committed into B's ledger, which the server cannot detect because both halves of the identity it is handed are consistent",
    ),
    Proof(
        law="P7-L14-AN-UNREADABLE-QUEUE-ROW-IS-REFUSED",
        path="src/app/daftar/offline/Scope.kt",
        find="        if (!isReadable(version)) throw UnreadableQueueRow(version, CURRENT)",
        replace="        if (false) throw UnreadableQueueRow(version, CURRENT)",
        expect_red="a row from a schema version this build does not know is refused, not reinterpreted",
        why="a row written by a newer build is read under the current field meanings, so a downgraded app sends bytes that are not the bytes that were frozen, under a key that can never be reused",
    ),
    Proof(
        law="HARNESS-THE-SCOPE-SEARCH-CANNOT-STOP-OFFERING-A-FOREIGN-SESSION",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="        for (acting in listOf(scope, foreignScope, nextShiftScope)) {",
        replace="        for (acting in listOf(scope)) {",
        expect_red="every reachable configuration honours every invariant",
        why="the model check stops offering the kernel another account's session; every invariant still passes, so only the non-vacuity count distinguishes a search that proved INV-9 from one that never tested it",
    ),
    Proof(
        law="HARNESS-THE-SCOPE-SEARCH-CANNOT-STOP-OFFERING-THE-NEXT-SHIFT",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="        for (acting in listOf(scope, foreignScope, nextShiftScope)) {",
        replace="        for (acting in listOf(scope, foreignScope)) {",
        expect_red="every reachable configuration honours every invariant",
        why="the search stops offering the one configuration F-05 made legal: another member of the SAME business. Every invariant still passes, because no permitted event then ever acts under a scope other than the row's — which is exactly the blindness that let the send effect take its business from the event rather than the row and move nothing here. Only the non-vacuity count distinguishes the two searches",
    ),
    Proof(
        law="P7-L15-NO-REENTRY-UNDER-A-NEW-KEY-BEFORE-THE-ORIGINAL-IS-SETTLED",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="            Provenance.ORIGINAL_LOST -> when (lookup) {",
        replace="            Provenance.ORIGINAL_LOST -> when (ReceiptLookup.ABSENT_FENCED) {",
        expect_red="a wiped device may not re-enter an unknown sale while the receipt cannot be read",
        why="an unreachable server is treated as settling the original, so a wiped device re-enters a sale the server may already hold, under a new key that no later reconciliation can match to the first",
    ),
    Proof(
        law="P7-L16-EXPIRY-MINIMIZES-THE-PAYLOAD-NEVER-THE-OBLIGATION",
        path="src/app/daftar/offline/Queue.kt",
        find="""                Step.Moved(
                    withPayloadMinimized(true),
                    listOf(
                        SideEffect.MinimizePayload(""",
        replace="""                Step.Moved(
                    moved(OperationState.DISCARDED),
                    listOf(
                        SideEffect.ClearLocalRow,
                        SideEffect.MinimizePayload(""",
        expect_red="expiry never clears the row, never discards the operation and never forgets why",
        why="bounded retention is implemented as a delete, which is the one implementation the ruling forbids: a financial operation the server may hold is silently dropped when its retention window elapses",
    ),
    Proof(
        law="HARNESS-THE-SEARCH-CANNOT-STOP-OFFERING-A-RETENTION-DEADLINE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="        add(QueueEvent.RetentionDeadlineReached)",
        replace="        // add(QueueEvent.RetentionDeadlineReached)",
        expect_red="every reachable configuration honours every invariant",
        why="the search stops exercising the retention deadline, so INV-10 holds vacuously; only the counted event and effect sets notice that the minimize-versus-delete invariant was never tested",
    ),
    Proof(
        law="P7-L17-AN-UNFENCED-ABSENCE-SETTLES-NOTHING",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="            Provenance.ORIGINAL_LOST -> when (lookup) {",
        replace="            Provenance.ORIGINAL_LOST -> when (if (lookup == ReceiptLookup.ABSENT_UNFENCED) ReceiptLookup.ABSENT_FENCED else lookup) {",
        expect_red="an absence settles the original only when the original key is fenced",
        why="an absence that the original can still contradict is treated as settling it, which is the exact race V2 named: the device mints a new key on an answer that was true when it was given and false when it was used",
    ),
    Proof(
        law="P7-L18-THE-ORIGINAL-KEY-OUTRANKS-A-NEW-ONE",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="        PriorOutcome.UNKNOWN -> when (provenance) {",
        replace="        PriorOutcome.UNKNOWN -> when (Provenance.ORIGINAL_LOST) {",
        expect_red="a recoverable original is resent under its own key whatever the receipt says",
        why="a recoverable original is sent down the lookup path instead of being resent under its own key, which throws away the one resolution that is safe with no receipt and no fence and puts the race back in front of a case that did not have one",
    ),
    Proof(
        law="P7-L16-MINIMIZATION-MUST-NOT-MAKE-SETTLEMENT-IMPOSSIBLE",
        path="src/app/daftar/offline/Queue.kt",
        find="            } else if (event.keep && payloadMinimized) {",
        replace="            } else if (false && payloadMinimized) {",
        expect_red="a minimized operation cannot be resent until its approved payload is back",
        why="this restores the defect V2 found in my own L16: an expired row goes back to QUEUED with no payload, so the sender either sends different bytes under the original key and burns it forever or cannot produce a digest at all, leaving money that can never be settled",
    ),
    Proof(
        law="P7-L3-PAYLOAD-FROZEN-AT-CAPTURE-ACROSS-A-RESTORE",
        path="src/app/daftar/offline/Queue.kt",
        find="""                } else if (event.digestNow != payloadDigest) {
                    Step.Refused(
                        "offline.restored_payload_does_not_match_capture",""",
        replace="""                } else if (event.digestNow != event.digestNow) {
                    Step.Refused(
                        "offline.restored_payload_does_not_match_capture",""",
        expect_red="a restore that does not reproduce the captured bytes is refused",
        why="a restore accepts bytes that are not the ones the key is bound to, which converts a recoverable obligation into a permanently refused key — the one outcome the restore path exists to avoid",
    ),
    Proof(
        law="HARNESS-THE-RACE-TEST-MUST-DETECT-A-SECOND-COMMIT",
        path="test/app/daftar/offline/ReentryAndRetentionTest.kt",
        find="            if (key in fenced) return false",
        replace="            if (false) return false",
        expect_red="no interleaving of a lookup and a late commit ever creates two operations",
        why="the fake server stops honouring its own fence, so an original that lands after a fenced answer commits anyway; if the race test cannot see the second operation appear here, it was never proving that two are not created",
    ),
    Proof(
        law="HARNESS-THE-SEARCH-CANNOT-STOP-OFFERING-A-RESTORE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="            add(QueueEvent.RestorePayload(digest, acting))",
        replace="            // add(QueueEvent.RestorePayload(digest, acting))",
        expect_red="every reachable configuration honours every invariant",
        why="the search stops exercising the restore, so INV-11 and INV-12 hold vacuously: no minimized row is ever offered a way forward, and only the counted event set notices that the settlement path was never walked",
    ),
    Proof(
        law="P7-L1-DEVICE-IS-NOT-AUTHORITY-AT-THE-SCREEN",
        path="src/app/daftar/offline/Recovery.kt",
        find="""        OperationState.CAPTURED -> MerchantView(
            MerchantMessage.SALE_NOT_CONFIRMED_YET,
            RecoveryAction.CONFIRM_THE_CAPTURE,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,""",
        replace="""        OperationState.CAPTURED -> MerchantView(
            MerchantMessage.SALE_NOT_CONFIRMED_YET,
            RecoveryAction.CONFIRM_THE_CAPTURE,
            blocksNewCaptures = false,
            showsMoneyAsTaken = true,""",
        expect_red="no state but SYNCED is ever shown to the merchant as money taken",
        why="a captured sale that has never been sent is presented to the cashier as recorded money, which makes the device a financial authority at the only boundary where a person can be misled by it, however correct the kernel underneath remains",
    ),
    Proof(
        law="P7-L15-THE-RE-ENTRY-GATE-MUST-REACH-THE-TILL",
        path="src/app/daftar/offline/Recovery.kt",
        find="""        "offline.original_unsettled" ->
            view(MerchantMessage.ORIGINAL_NOT_SETTLED_YET, RecoveryAction.ESCALATE_TO_A_SUPERVISOR, blocks = true)""",
        replace="""        "offline.original_unsettled" ->
            view(MerchantMessage.ORIGINAL_NOT_SETTLED_YET, RecoveryAction.ESCALATE_TO_A_SUPERVISOR, blocks = false)""",
        expect_red="only the re-entry refusals stop the till, and all three of them do",
        why="the kernel still refuses the re-entry, but the till keeps taking captures, so a merchant told no with nothing stopping them keys the sale in again — which is the duplicate charge L15 exists to prevent, arriving through the UI instead of the kernel",
    ),
    Proof(
        law="P7-L4-A-DEVICE-DEFECT-IS-NOT-A-MERCHANT-PROBLEM",
        path="src/app/daftar/offline/Recovery.kt",
        find="        Outcome.isDivergence(operation.lastCode) -> MerchantView(",
        replace="        false -> MerchantView(",
        expect_red="needing attention is not one state as far as the merchant is concerned",
        why="a reused key with a different payload is offered to a supervisor as something to escalate, when the server will refuse it identically forever: the merchant is sent to a person who also cannot fix it, instead of to the developer who can",
    ),
    Proof(
        law="HARNESS-AN-UNMAPPED-REFUSAL-CODE-CANNOT-REACH-A-TILL",
        path="src/app/daftar/offline/Queue.kt",
        find='Step.Refused("offline.already_released", P7Laws.KEY_MINTED_AT_CAPTURE.id)',
        replace='Step.Refused("offline.a_newly_added_refusal", P7Laws.KEY_MINTED_AT_CAPTURE.id)',
        expect_red="every refusal code the kernel can produce has a stated merchant view",
        why="this is the real failure the source sweep exists for: a refusal code added to the kernel without deciding what a person is told. The code reaches a cashier as a generic device-software problem, erasing what they could have done about it, and only a sweep of the kernel's own source notices — a hand-written list of codes would still be green",
    ),
    Proof(
        law="P7-L19-AN-UNVOUCHED-STORE-CANNOT-REPORT-ABSENCE",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="            StoreAttestation.CANNOT_VOUCH -> PriorOutcome.UNDETERMINED",
        replace="            StoreAttestation.CANNOT_VOUCH -> PriorOutcome.NONE",
        expect_red="a wiped install cannot report an absence, so re-entry is refused rather than permitted",
        why="challenger finding F-01, restored: an install that cannot tell an empty queue from a destroyed one reports an absence, which permits a new key with no lookup at all — so a wiped phone re-enters a sale the server already holds and the customer is charged twice, while every other law in the file still holds",
    ),
    Proof(
        law="P7-L19-UNDETERMINED-IS-NOT-ROUTED-TO-A-REFUSAL",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="""            Provenance.ORIGINAL_LOST -> Reentry.Refused(
                "offline.prior_state_undetermined",
                P7Laws.AN_UNVOUCHED_STORE_CANNOT_REPORT_ABSENCE.id,
                "this install cannot tell an empty queue from a destroyed one, so it cannot " +
                    "establish that nothing was captured; a new key here would commit a second " +
                    "time if the earlier operation landed",
            )""",
        replace="""            Provenance.ORIGINAL_LOST -> Reentry.Permitted(
                "the store cannot be vouched for, but an empty read is good enough",
            )""",
        expect_red="every prior outcome, receipt answer and provenance has a stated verdict",
        why="the classification correctly reports that it cannot vouch for the store, and the decision then permits a new key anyway: F-01 reintroduced one level further in, where the new enum value exists but decides nothing",
    ),
    Proof(
        law="P7-L13-THE-SEND-EFFECT-CARRIES-ITS-OWN-BUSINESS",
        path="src/app/daftar/offline/Queue.kt",
        find="listOf(SideEffect.SendAttempt(id, payloadDigest, attempts + 1, scope)),",
        replace="listOf(SideEffect.SendAttempt(id, payloadDigest, attempts + 1, event.actingScope)),",
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding F-02: the attempt goes out under the SENDER's scope instead of the row's. After a shift change that is A's key with B's business, both halves internally consistent, answered 201, and deriveSourceId writes A's sale into B's ledger with nothing able to detect it",
    ),
    Proof(
        law="HARNESS-THE-STATE-COVERAGE-GUARD-CAN-FAIL-ON-SYNCED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                                if (visited.add(print)) frontier.addLast(next to nextHistory)",
        replace="                                if (next.state != OperationState.SYNCED && visited.add(print)) frontier.addLast(next to nextHistory)",
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding F-03, as its probe 3 exactly: a plausible do-not-explore-from-a-terminal-state optimization. SYNCED nodes are never enqueued, so the search never dequeues one, never records the state, and INV-1 — the invariant the whole model check exists for — becomes vacuous. With the union the challenger found still in place this stayed green; the first attempt at this plant, a fingerprint collapsed to a constant for SYNCED, ALSO stayed green, because the first such node is still visited and the state is still recorded. A plant that does not reproduce the finding measures nothing, which is why this one is written the way the finding was found",
    ),
    Proof(
        law="P7-L13-THE-BUSINESS-IS-NEVER-RELAXED",
        path="src/app/daftar/offline/Scope.kt",
        find="        if (tenantId != owner.tenantId || businessId != owner.businessId) return false",
        replace="        if (tenantId != owner.tenantId) return false",
        expect_red="the business is compared for every event, the send included",
        why="the F-05 split is widened one field too far. Relaxing the member for a send is sound because the server authorizes the session; relaxing the BUSINESS is the undetectable cross-tenant write, because the server derives the source id from the business it was handed and both halves look consistent",
    ),
    Proof(
        law="P7-L13-A-PERSON-STILL-CANNOT-ACT-ON-ANOTHER-MEMBERS-CAPTURE",
        path="src/app/daftar/offline/Scope.kt",
        find="            -> memberId == owner.memberId",
        replace="            -> true",
        expect_red="another member on the same till cannot confirm or settle another member's capture",
        why="the F-05 and G-02 splits collapse entirely and the member stops being compared for anything: Bob can cancel and clear the local row of a sale Alice captured, which is the shared-till case PART 40 item 2 names. G-02 narrowed this proof's subject rather than weakening it: a release is now business-gated by design, so what is left to defend is the three events where a person decides something about money",
    ),
    Proof(
        law="P7-L17-NOTHING-MAY-INFER-A-FENCE",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="    UNAVAILABLE,\n}",
        replace="    UNAVAILABLE;\n\n    companion object {\n        fun of(status: Int): ReceiptLookup =\n            if (status == 404) ReceiptLookup.ABSENT_FENCED else ReceiptLookup.UNAVAILABLE\n    }\n}",
        expect_red="no source in the kernel infers a fenced absence from a status, a null or an empty read",
        why="challenger finding F-06: a fence inferred from an HTTP 404. A 404 says the server did not find the key at that instant and says nothing about whether the original can still arrive, so this converts the one absence that settles the original into the one that does not — and nothing but a textual guard can see it, because the type checks out perfectly",
    ),
    Proof(
        law="P7-L19-A-STALE-ROW-IS-NOT-A-CURRENT-ONE",
        path="src/app/daftar/offline/Reconciliation.kt",
        find="                    PriorOutcome.NEVER_SENT -> PriorOutcome.UNDETERMINED",
        replace="                    PriorOutcome.NEVER_SENT -> PriorOutcome.NEVER_SENT",
        expect_red="a stale counter from a store that cannot vouch for itself is not a report that nothing was sent",
        why="challenger finding G-01, restored: the fix for F-01 distinguished presence from absence and not presence from CURRENCY. A row restored from a backup reads attempts == 0, which is the one held value that permits, and attempts only ever increases — so the sale released, sent and committed after the backup was taken is re-entered under a new key and the customer pays twice, from a store that has already declared it cannot vouch for itself",
    ),
    Proof(
        law="P7-L13-AN-UNRELEASED-CAPTURE-HAS-AN-EXIT",
        path="src/app/daftar/offline/Scope.kt",
        find=(
            "            is QueueEvent.CancelByMerchant,\n"
            "            -> true\n"
        ),
        replace=(
            "            -> true\n"
            "            is QueueEvent.CancelByMerchant,\n"
        ),
        expect_red="a capture the previous shift never released can be abandoned by the next one, never confirmed",
        why="challenger finding G-02, restored: the one open exit closes, so a sale Alice captured while the till was offline and never released is unsendable (CAPTURED is not a sendable state), unreleasable, uncancellable, unresolvable and unminimizable once her session is revoked — seven refusals and a material row that can never settle, which L4 and L5 forbid dropping",
    ),
    Proof(
        law="INV-13-A-RELEASE-ONLY-EVER-MOVES-AN-UNSENT-ROW",
        path="src/app/daftar/offline/Queue.kt",
        find="            if (state == OperationState.CAPTURED) {\n                Step.Moved(moved(OperationState.QUEUED), emptyList())",
        replace="            if (state == OperationState.CAPTURED || state == OperationState.UNKNOWN_OUTCOME) {\n                Step.Moved(moved(OperationState.QUEUED), emptyList())",
        expect_red="every reachable configuration honours every invariant",
        why="the ground G-02's relaxation stands on is removed: a release becomes legal from a state only reachable AFTER a send, so the member check that was dropped would be handing another member a row the server may already hold. The relaxation is sound only while a release is structurally unsent, which is why that is an invariant over the whole space and not a remark about the Release arm",
    ),
    Proof(
        law="HARNESS-THE-MERCHANT-VIEW-SWEEP-CATCHES-A-REAL-MISS",
        path="src/app/daftar/offline/Recovery.kt",
        find='        "offline.absence_not_fenced" ->',
        replace='        "offline.absence_not_fenced_typo" ->',
        expect_red="every refusal code the kernel can produce has a stated merchant view",
        why="challenger finding G-03's practical risk: a real refusal loses its view and falls through to the generic device-software message. The named allow-list must not be able to swallow it — the merchant would be told the till is broken instead of that the original sale is still being confirmed, and would key the sale in again",
    ),
    Proof(
        law="P7-L13-ONLY-THE-CAPTURER-CONFIRMS-A-CAPTURE",
        path="src/app/daftar/offline/Queue.kt",
        # Exempting one event from the gate, which is how a special case
        # actually gets written: not by editing the rule, by stepping around
        # it. Keeps the `is` check so the smart cast survives and it compiles.
        find="        if (event is QueueEvent.ByScope && !event.actingScope.mayAct(scope, event)) {",
        replace=(
            "        if (event is QueueEvent.ByScope && event !is QueueEvent.Release &&\n"
            "            !event.actingScope.mayAct(scope, event)\n"
            "        ) {"
        ),
        expect_red="a capture the previous shift never released can be abandoned by the next one, never confirmed",
        why="challenger finding H-01, restored exactly: the release moves back into the ungated arm, so any member of the business may CONFIRM a capture they cannot be shown to have witnessed. A release is the step that turns a capture into a ledger entry, and an unconfirmed capture may equally be a basket the customer walked away from — so this is the one unlock of the two that can invent a sale, which is why the cancel is the one that is open",
    ),
    Proof(
        law="INV-14-A-FOREIGN-SESSION-NEVER-ACTS-UNRECORDED",
        path="src/app/daftar/offline/Queue.kt",
        find="        if (event is QueueEvent.ByScope && event.actingScope != scope && step is Step.Moved) {",
        replace="        if (event is QueueEvent.ByScope && event.actingScope == scope && step is Step.Moved) {",
        expect_red="every reachable configuration honours every invariant",
        why="H-01's second half: the custody record is emitted for the row's OWN session and not for the foreign one, which is the exact inversion that leaves the second actor the design introduced unrecorded while the effect still appears in every trace a reader is likely to look at. The row names only the capturer and a cancel clears it at once, so there is no later moment from which the actor could be recovered",
    ),
    Proof(
        law="INV-14-THE-RECORD-NAMES-THE-ACTOR-NOT-THE-ROW",
        path="src/app/daftar/offline/Queue.kt",
        find="                id, scope, event.actingScope, event::class.simpleName.orEmpty(),",
        replace="                id, scope, scope, event::class.simpleName.orEmpty(),",
        expect_red="every reachable configuration honours every invariant",
        why="the plausible version of the same defect: the record is emitted, in the right places and with the right shape, and names the capturer twice. An audit trail that records every custody action and attributes all of them to the person who did not perform them is worse than none, because it reads as evidence",
    ),
    Proof(
        law="P7-L20-AN-ABANDONED-ROW-IS-NOT-A-SENT-ONE",
        path="src/app/daftar/offline/Queue.kt",
        find='            Step.Refused("offline.already_abandoned", P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id)',
        replace='            Step.Refused("offline.cancel_after_send", P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id)',
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding I-01, restored exactly: the second cancel of a row that was abandoned before anything was sent is answered with the code whose merchant view says an attempt is out and to wait for it. The cashier — who may be the colleague of whoever abandoned it seconds earlier — is told to wait for a sale that will never arrive, which is the re-key harm the merchant-view work exists to prevent. G-03 proved every code HAS a view; this is the next clause, that a code can have a view and still be the wrong code",
    ),
    Proof(
        law="INV-14-THE-RECORD-SAYS-WHAT-WAS-DONE",
        path="src/app/daftar/offline/Queue.kt",
        find='                id, scope, event.actingScope, event::class.simpleName.orEmpty(),',
        replace='                id, scope, event.actingScope, "CancelByMerchant",',
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding I-02: three of the record\u2019s fields were asserted and the fourth — the one that says what was done — was not, so a constant label passed the whole suite and recorded a foreign SEND as a cancel. The expectation now comes from a literal per event rather than from the kernel\u2019s own expression, because a check that re-derives its answer the way the subject does agrees with any edit to it",
    ),
    Proof(
        law="P7-L20-THE-RECORD-SAYS-WHAT-WAS-LOST",
        path="src/app/daftar/offline/Queue.kt",
        find="                payloadDigest, effect, amountMinorUnits, currency,",
        replace="                payloadDigest, effect, null, currency,",
        expect_red="a capture the previous shift never released can be abandoned by the next one, never confirmed",
        why="challenger finding I-04: the record names the person and the key and cannot say how much was destroyed. The row is erased in the same step, so this is the only surviving description of the capture, and an audit that can establish that Bob abandoned something of Alice\u2019s but never that it was a sale she had taken cash for cannot be repaired afterwards",
    ),
    Proof(
        law="INV-13-A-TERMINAL-ROW-IS-NOT-CANCELLED-TWICE",
        path="src/app/daftar/offline/Queue.kt",
        find="            if (attempts == 0 && !isTerminal) {",
        replace="            if (attempts == 0) {",
        expect_red="a capture the previous shift never released can be abandoned by the next one, never confirmed",
        why="challenger finding I-03, which was a missing proof rather than a defect: `attempts == 0` masks `!isTerminal` on the path a reviewer checks (SYNCED is unreachable with no attempt), so the only state the second condition defends is DISCARDED — and nothing covered it. Mutated, a second cancel moves again and emits a second clear and a second custody record for one key, which an audit with no sequence on the record cannot tell from one cancel",
    ),
    Proof(
        law="P7-L20-A-FINISHED-ROW-DOES-NOT-SAY-WAIT",
        path="src/app/daftar/offline/Queue.kt",
        find=(
            "                refusalForAFinishedRow()\n"
            "                    ?: refusalForARowAwaitingAPerson()\n"
            '                    ?: Step.Refused("offline.already_released", P7Laws.KEY_MINTED_AT_CAPTURE.id)'
        ),
        replace='                Step.Refused("offline.already_released", P7Laws.KEY_MINTED_AT_CAPTURE.id)',
        expect_red="a refusal never tells the merchant to wait for a device that has finished",
        why="challenger finding J-01, restored exactly: a release of a row that was abandoned, or that the server has already recorded, or that is waiting on a person, is answered \u201calready confirmed, wait for it\u201d. On the shared till H-01 opened, that is I-01 one button over — Bob abandons Alice\u2019s capture, somebody presses confirm, and the till says the sale exists and to wait for it, both halves false, same row, same double tap",
    ),
    Proof(
        law="INV-9B-THE-ACTION-IS-WHAT-INSTRUCTS-THE-MERCHANT",
        path="src/app/daftar/offline/Recovery.kt",
        find='            view(MerchantMessage.SALE_NEEDS_YOUR_ATTENTION, RecoveryAction.SEE_WHAT_THIS_OPERATION_NEEDS)',
        replace='            view(MerchantMessage.SALE_NEEDS_YOUR_ATTENTION, RecoveryAction.WAIT_IT_IS_IN_PROGRESS)',
        expect_red="every reachable configuration honours every invariant",
        why="J-01 at the layer the first version of INV-9b could not see: the message stays honest and the ACTION tells the merchant to wait for a device that has finished with the row. INV-9b judged the message only, and three codes survived it; it judges the instruction now, over every reachable configuration rather than the states somebody thought to list",
    ),
    Proof(
        law="P7-L20-A-STOCKTAKE-IS-NOT-DENOMINATED",
        path="src/app/daftar/offline/Queue.kt",
        find="            if (effect == EffectClass.FINANCIAL) {",
        replace="            if (effect.isMaterial) {",
        expect_red="a sale states what it is worth, a stocktake has nothing to state, and neither value is judged",
        why="challenger finding J-02, restored exactly: `isMaterial` is FINANCIAL or INVENTORY, and an inventory capture is a movement or a stocktake count — a quantity and a unit, with no minor units and no currency. Requiring them makes fabricating a currency a precondition of storing a stocktake, which is what my own fixtures did: seven units of stock denominated in riyals in one file and lira in another, in the field the record exists to add",
    ),
    Proof(
        law="P7-L20-THE-KERNEL-DOES-NOT-JUDGE-A-TOTAL",
        path="src/app/daftar/offline/Queue.kt",
        find='                require(amountMinorUnits != null) {',
        replace='                require(amountMinorUnits != null && amountMinorUnits != 0L) {',
        expect_red="a sale states what it is worth, a stocktake has nothing to state, and neither value is judged",
        why="challenger finding J-05, taken as a decision rather than a defect and therefore planted: refusing a zero total is the plausible reading of \u201cguard the amount the way you guarded the currency\u201d, and it refuses a fully discounted sale, which is a legitimate zero. Which totals are permissible is the selling surface\u2019s business and the server\u2019s; a device that refused one would be asserting a total of its own",
    ),
    Proof(
        law="P7-L20-THE-ERASE-CARRIES-ITS-RECORD",
        path="src/app/daftar/offline/Queue.kt",
        find=(
            "            val effects = if (step.effects.any { it is SideEffect.ClearLocalRow }) {\n"
            "                step.effects.map {\n"
            "                    if (it is SideEffect.ClearLocalRow) SideEffect.ClearLocalRowRecording(record) else it\n"
            "                }\n"
            "            } else {\n"
            "                listOf(record) + step.effects\n"
            "            }"
        ),
        replace="            val effects = listOf(record) + step.effects",
        expect_red="a capture the previous shift never released can be abandoned by the next one, never confirmed",
        why="challenger finding J-04: the record goes back to being a separate effect that merely PRECEDES the erase, which is an obligation on whoever performs the list and nothing a type can hold them to. Fused, the permission to destroy another member\u2019s capture and the description of what is destroyed are one value; unfused, a caller that performs the erase and drops the record is doing something the kernel permitted",
    ),
    Proof(
        law="P7-L20-A-RE-ENTRY-REFUSAL-DOES-NOT-SAY-WAIT",
        path="src/app/daftar/offline/Recovery.kt",
        find=(
            '        "offline.absence_not_fenced" ->\n'
            "            view(MerchantMessage.CANNOT_CONFIRM_ORIGINAL_ENDED, "
            "RecoveryAction.ESCALATE_TO_A_SUPERVISOR, blocks = true)"
        ),
        replace=(
            '        "offline.absence_not_fenced" ->\n'
            "            view(MerchantMessage.CANNOT_CONFIRM_ORIGINAL_ENDED, "
            "RecoveryAction.WAIT_IT_IS_IN_PROGRESS, blocks = true)"
        ),
        expect_red="no re-entry refusal instructs a wait, because the row it is about is gone",
        why="coordinator finding D-01, restored exactly: the merchant is told to wait for a fenced absence, and the fence is a server capability the merchant API does not have, so the wait is for something nobody is building and no device is doing. L20\u2019s clause was widened to every refusal while its only guard watched Operation.step, and re-entry refuses from somewhere else — which is why this proof plants in the layer the invariant could not see",
    ),
    Proof(
        law="INV-9B-A-NEW-CODE-MAY-NOT-SAY-WAIT-BY-DEFAULT",
        path="src/app/daftar/offline/Recovery.kt",
        find=(
            '        "offline.another_members_capture" ->\n'
            "            view(MerchantMessage.ANOTHER_MEMBER_MUST_CONFIRM_THIS, "
            "RecoveryAction.SEE_WHAT_THIS_OPERATION_NEEDS)"
        ),
        replace=(
            '        "offline.another_members_capture" ->\n'
            "            view(MerchantMessage.ANOTHER_MEMBER_MUST_CONFIRM_THIS, "
            "RecoveryAction.WAIT_IT_IS_IN_PROGRESS)"
        ),
        expect_red="no refusal in any layer tells the merchant to wait for a device with nothing pending",
        why="D-01\u2019s other half: a refusal that is not a wait starts telling the merchant to wait. The sweep takes its subjects from the kernel\u2019s own source and compares the set of waiting refusals for EQUALITY against the ones the model check proved are reachable only while something is pending, so a code added anywhere — in a layer written after this round — is judged by absence rather than by a list someone has to remember to extend. What this plant does NOT show, and the round-seven review was right to say so, is the one direction only that sweep can cover: `offline.another_members_capture` is returned by `Operation.step`, so the per-layer invariant over the reachable space sees it too and either guard would have caught this plant. It is kept because it measures the sweep end to end — source literal, view, instruction, equality — and the direction no per-layer guard reaches is measured separately by E-03-A-CODE-NO-QUEUE-STATE-EVER-PRODUCES",
    ),
    Proof(
        law="INV-15-A-FINISHED-ROW-ANSWERS-IN-ITS-OWN-TERMS",
        path="src/app/daftar/offline/Queue.kt",
        find=(
            "                refusalForAFinishedRow()\n"
            "                    ?: refusalForARowAwaitingAPerson()\n"
            "                    ?: refusalForARowAlreadySending()\n"
            "                    ?: refusalForACaptureSomebodyElseMustConfirm(event.actingScope)\n"
            '                    ?: Step.Refused("offline.not_sendable", P7Laws.KEY_MINTED_AT_CAPTURE.id)'
        ),
        replace='                Step.Refused("offline.not_sendable", P7Laws.KEY_MINTED_AT_CAPTURE.id)',
        expect_red="every reachable configuration honours every invariant",
        why="coordinator finding C-02\u2032: the Send arm goes back to answering every non-sendable state with one code, so a row the server has already recorded, and one a colleague abandoned, are both answered NOT_READY_TO_SEND / CONFIRM_THE_CAPTURE — the till offers a cashier the button for a sale that is finished. The doc sentence on refusalForAFinishedRow said \u2018whatever was asked of it\u2019 while three arms out of six consulted it, so the invariant is asserted over the whole reachable space rather than arm by arm",
    ),
    Proof(
        law="J-03-AN-OVERLOAD-IS-A-DEFAULT-WITH-A-DIFFERENT-SHAPE",
        path="src/app/daftar/offline/Queue.kt",
        find="        fun capture(\n",
        replace=(
            "        fun capture(key: String, scope: OwnerScope, effect: EffectClass, "
            "payloadDigest: String): Operation =\n"
            "            capture(key, scope, effect, payloadDigest, null, null)\n"
            "\n"
            "        fun capture(\n"
        ),
        expect_red="the facts a capture must state cannot be omitted by a caller",
        why="coordinator finding D-02, measured by the coordinator as green before this round: the textual guard watched for a PARAMETER DEFAULT, and an overload omits the same facts without one. With this plant a pre-round four-argument FINANCIAL call site compiles again and throws at the till, which is J-03\u2019s exact harm through the one door the guard did not watch — so the guard now counts the ways in rather than checking the shape of one of them",
    ),
    Proof(
        law="L13-TWO-DIFFERENT-REFUSALS-MAY-NOT-SHARE-ONE-VIEW",
        path="src/app/daftar/offline/Queue.kt",
        find=(
            '            val code = if (sameBusiness) "offline.another_members_capture" '
            'else "offline.scope_switched"'
        ),
        replace='            val code = "offline.scope_switched"',
        expect_red="another member on the same till cannot confirm or settle another member's capture",
        why="coordinator finding C-02\u2032: the gate refuses on two grounds — a business that is not the row\u2019s, which is never relaxed, and a colleague\u2019s capture inside one business, which is gated only for the three committing events — and with one code the second is told SIGNED_IN_TO_ANOTHER_BUSINESS and to switch back to the owning account. It is the same business, and the account named is a colleague\u2019s; a cashier who follows that instruction is being sent to sign in as someone else",
    ),
    Proof(
        law="K-02-A-CODE-NEED-NOT-BE-A-LITERAL-TO-REACH-A-MERCHANT",
        path="src/app/daftar/offline/Outcome.kt",
        find=(
            "            status == 401 ->\n"
            "                Decision.NeedsAttention(SESSION_EXPIRED, false, "
            "P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)"
        ),
        replace=(
            "            status == 401 ->\n"
            '                Decision.NeedsAttention("off" + "line." + "cancel_after_send", false, '
            "P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)"
        ),
        expect_red="no code this classifier produces tells the merchant to wait",
        why="challenger finding K-02, in one file instead of two: the classifier answers an expired session with a code that is ASSEMBLED rather than written, and the code it assembles is one whose view tells the merchant an attempt is out and to wait for it. The literal sweep in RecoveryTest cannot see a code that is not a literal, and the challenger measured exactly this shape staying green — so the subjects of this layer\u2019s judge are the codes `classify` actually returns over its own exhaustive input space, not the strings its source contains",
    ),
    Proof(
        law="K-03-A-SECOND-WAY-IN-NEED-NOT-BE-IN-THE-SAME-FILE",
        path="src/app/daftar/offline/Scope.kt",
        find=(
            "    fun admit(version: Int) {\n"
            "        if (!isReadable(version)) throw UnreadableQueueRow(version, CURRENT)\n"
            "    }\n"
            "}"
        ),
        replace=(
            "    fun admit(version: Int) {\n"
            "        if (!isReadable(version)) throw UnreadableQueueRow(version, CURRENT)\n"
            "    }\n"
            "}\n"
            "\n"
            "fun capture(key: String, scope: OwnerScope, effect: EffectClass, payloadDigest: String): Operation =\n"
            "    Operation.capture(key, scope, effect, payloadDigest, null, null)"
        ),
        expect_red="the facts a capture must state cannot be omitted by a caller",
        why="challenger finding K-03: the declaration counter read `Queue.kt` alone, and a second way to capture without stating what the operation is worth does not have to live in that file. This plant puts a four-argument `capture` in another kernel source, in the same package, where it resolves for any caller in the module and passes null for both facts — D-02\u2019s harm one file over. The guard\u2019s subject is now the whole source set, the way the refusal-vocabulary sweep already takes it",
    ),
    Proof(
        law="E-03-A-CODE-NO-QUEUE-STATE-EVER-PRODUCES",
        path="src/app/daftar/offline/Recovery.kt",
        find=(
            '        "offline.session_expired" -> '
            "view(MerchantMessage.SESSION_ENDED, RecoveryAction.SIGN_IN_AGAIN)"
        ),
        replace=(
            '        "offline.session_expired" -> '
            "view(MerchantMessage.SESSION_ENDED, RecoveryAction.WAIT_IT_IS_IN_PROGRESS)"
        ),
        expect_red="no refusal in any layer tells the merchant to wait for a device with nothing pending",
        why="coordinator finding E-03, the direction proof 57 did not reach. `offline.session_expired` is not a queue state: no `Operation.step` returns it, so the model check\u2019s reachable space cannot contain it — it arrives from the server\u2019s answer, through the outcome classifier, and the merchant meets it only as a view. Planted here, a till whose session has ended is told its sale is in progress and to wait, while nothing is pending and nothing will be until somebody signs in. Every per-layer guard stays green, because the code never passes through the layer they watch; only a sweep whose subjects are the kernel\u2019s own literals can see it, and this is the measurement that it does",
    ),
    Proof(
        law="E-04-A-REFUSAL-MAY-NOT-OFFER-A-BUTTON-ITS-READER-CANNOT-PRESS",
        path="src/app/daftar/offline/Queue.kt",
        find="                    ?: refusalForACaptureSomebodyElseMustConfirm(event.actingScope)\n",
        replace="",
        expect_red="every reachable configuration honours every invariant",
        why="coordinator finding E-04. Without this arm the next shift\u2019s send of a colleague\u2019s CAPTURED row falls through to `offline.not_sendable`, whose view tells the merchant to confirm the capture — the one thing L13 forbids that session from doing, so the till shows a button that refuses when pressed. The invariant now asks of every `not_sendable` in the reachable space whether its reader could act on it, computing the answer from the acting scope with the test\u2019s own permission function rather than reading it back from the kernel",
    ),
    Proof(
        law="L-01-A-CLAIM-ABOUT-A-CODE-NOTHING-PRODUCES-IS-A-CLAIM-ABOUT-NOTHING",
        path="src/app/daftar/offline/Queue.kt",
        find="        if (state == OperationState.CAPTURED && !acting.mayAct(scope, QueueEvent.Release(acting))) {",
        replace="        if (state == OperationState.CAPTURED) {",
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding L-01, the hole inside E-04\u2019s own fix. E-04\u2019s assertion is an implication — if the code is `offline.not_sendable`, then the row is CAPTURED and its actor may confirm it — and `Queue.kt` has exactly one producer of that code, in the arm this helper sits above. A helper that fires for EVERY CAPTURED row therefore leaves the implication true of nothing: the suite stayed green while the cashier who captured the sale was told another member must confirm it, on their own row, on their own till. The review\u2019s own bound is why this plant is this shape: the plain inversion, keeping the conjunction, is already red on the invariant, so the hole was exactly one shape wide. The observability loop now covers every code this check makes a conditional claim about, not only the four honest-wait codes",
    ),
    Proof(
        law="M-01-O-01-A-CLAIM-IS-ENROLLED-BY-BEING-EVALUATED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=A_CLAIM_ABOUT_AN_UNPRODUCED_CODE,
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding M-01, and the review\u2019s own plant: one more conditional claim, about `offline.permission_revoked`, which reaches a row only as `lastCode` and never as `step.code`. The review measured it green at 98 of 98 against a hand-written five — L-01 again, inside the guard L-01 produced. Three heads enrolled it by SWEEPING THIS FILE\u2019S TEXT, and the eleventh review then defeated the sweep four ways. The site is enrolled by being EVALUATED now: `claimAbout` registers the code before deciding whether the claim applies, so the plant registers `offline.permission_revoked`, the registry no longer equals its literal total, and the check says which code arrived and which went missing",
    ),
    Proof(
        law="O-01-AN-ASSEMBLED-CODE-REGISTERS-THE-VALUE-IT-TESTS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=a_claim_about('"offline." + "permission_revoked"'),
        expect_red="every reachable configuration honours every invariant",
        why="challenger findings qA and qE of the eleventh review, and the sharpest of them, because the file USED this escape itself: the literal sweep matched a code written as one string, so a code assembled (`\u201coffline.\u201d + \u201cpermission_revoked\u201d`) or interpolated was not enrolled — and the sweep\u2019s own prose sentinel was assembled three lines above it precisely so the sweep would not see it. A technique a file relies on to hide a string from its own guard is available to whoever writes the next claim. Execution registers the VALUE, so the assembled code is enrolled exactly as the written one is, and the review would not report its green until a control showed the construct live",
    ),
    Proof(
        law="O-01-A-CLAIM-WHOSE-REGISTRATION-IS-REMOVED-IS-A-CLAIM-NOTHING-BOUNDS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace='                            if (step.code == "offline.not_sendable") {',
        expect_red="every reachable configuration honours every invariant",
        why="the first proof the coordinator required of the registry, and the one that makes it a derivation rather than a convention. A claim written the old way — the bare equality, no helper — asserts everything it asserted before and registers nothing, so `claimsMade` loses `offline.not_sendable` and the literal total is not met. The previous four anchors asked whether the derivation still found something and this asks whether it lost anything, which is the ruling: an anchor must BOUND THE LOSS, because a set that survives is not a set that was not reduced",
    ),
    Proof(
        law="O-01-THE-COMPANION-S-SPELLING-IS-NOT-PART-OF-THE-GUARD",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="    private companion object {",
        replace="    companion object {",
        expect_red="every reachable configuration honours every invariant",
        why="plant qC of the eleventh review, paired with the harm. The old sweep cut the companion object out of the text before reading it, by `indexOf(\u201cprivate companion object {\u201d)`; dropping `private` — a widening nobody would read as a weakening — made the needle miss, the brace walk excised 728 lines, and the enrolled set fell to two codes with the suite green at 98 of 98. Nothing reads the file now, so the respelling is a no-op and the harm it used to admit reds by name. The edit alone would measure nothing, which is why this proof carries two",
        edits=(THE_HARM,),
    ),
    Proof(
        law="O-01-A-LINE-THAT-LOOKS-LIKE-THE-INSTRUMENTS-IS-NOT-THE-INSTRUMENTS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find='    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"',
        replace=(
            '    private val whatTheOldSweepLookedFor = "private companion object {"\n\n'
            '    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="plant qG of the eleventh review in its mechanism, paired with the harm. qG moved the companion object to the end of the class — instruments after the thing they serve, a normal ordering, the declaration spelled character for character — and `indexOf` then matched ITS OWN SOURCE LINE, excising 739 lines, more than half the file, with the enrolled set down to the two codes the anchor happened to check. The defect is that a text in the file which LOOKS like the declaration is indistinguishable from it, which this plant states directly and in two lines rather than by relocating fifty. The relocation itself was measured separately at this head and is recorded in the evidence; here the point is that no line of this file decides what is enrolled",
        edits=(THE_HARM,),
    ),
    Proof(
        law="O-01-A-STRING-LITERAL-IS-NOT-A-COMMENT",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find='    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"',
        replace=(
            '    private val globPattern = "/*"\n\n'
            '    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="plant qD of the eleventh review, paired with the harm. The sweep stripped comments before reading the file so that prose could not be load-bearing (N-03), and a STRING holding a comment-opening sequence is not a comment: the block regex ran from that literal to the next closing sequence and deleted 596 lines, with three codes left enrolled and the suite green. The review predicted the two-code anchor would catch this and wrote that prediction down before the run; it did not, because both anchored codes also occur outside the swallowed region — containment is not survival. The stripper is deleted at this head, along with the sweep it served, so the literal is inert and the harm reds",
        edits=(THE_HARM,),
    ),
    Proof(
        law="P-01-A-REGISTRATION-PROVES-THE-SITE-RAN-NOT-THAT-THE-CLAIM-WAS-EXERCISED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            if (op.state == OperationState.UNKNOWN_OUTCOME) {\n'
            + CLAIM_SITE
        ),
        edits=((
            '                            }\n                            if (aForeignScopeRefusal) {\n'
            '                                foreignScopeRefusals++',
            '                            }\n                            }\n'
            '                            if (aForeignScopeRefusal) {\n'
            '                                foreignScopeRefusals++',
        ),),
        expect_red="every reachable configuration honours every invariant",
        why="the twelfth review's blocker, and the only FAIL-OPEN this phase has had since L-01. The site is wrapped in a condition that is REACHED — UNKNOWN_OUTCOME rows do reach that arm and do produce refusals, so the registration fires and the registry's equality is satisfied — while `offline.not_sendable` is produced only on CAPTURED rows, so the body runs ZERO times. The review then planted proof 64's own harm underneath it, E-04's refusal arm deleted, and measured the pair GREEN at 98 of 98 against rc 1 red by name on a clean subject: a cashier's own capture refused with \u201canother member must confirm this\u201d, with every assertion in the file passing. The observability loop cannot see it either, because the code IS produced — by the rows the conditioned site no longer looks at. `claimsExercised` records the branch that actually runs the claim, so this plant now reds by name on the site that never exercised. **A registration certifies that a site ran; only the branch inside it certifies that anything was tested.**",
    ),
    Proof(
        law="Q-01-A-CLAIM-EXERCISED-ONCE-IS-NOT-A-CLAIM-EXERCISED-OVER-ITS-DOMAIN",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            if (event !is QueueEvent.ByScope ||\n'
            '                                permittedToAct(\n'
            '                                    event.actingScope, op.scope, QueueEvent.Release(event.actingScope),\n'
            '                                )\n'
            '                            ) {\n'
            + CLAIM_SITE
        ),
        edits=(
            (
                '                            }\n\n'
                "                            // INV-9c, added for the fourteenth review's R-01.",
                '                            }\n                            }\n\n'
                "                            // INV-9c, added for the fourteenth review's R-01.",
            ),
            (
                "src/app/daftar/offline/Queue.kt",
                "                    ?: refusalForACaptureSomebodyElseMustConfirm(event.actingScope)\n",
                "",
            ),
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the thirteenth review's blocker, a FAIL-OPEN inside the remedy that review had itself specified one round earlier. The site is wrapped in its OWN PRECONDITION rather than in an excluding state — `event !is ByScope || permittedToAct(\u2026, Release(\u2026))`, the very condition its second assertion exists to judge. Rows whose actor may release still produce the code, so the site runs, the body runs, and BOTH the made and the exercised equalities are satisfied; the only rows excluded are the ones the assertion is for. With E-04's refusal arm deleted underneath (the third edit, which is why this plant spans two files) the review measured **99 of 99 GREEN**, against rc 1 red by name on a clean subject — reproduced here on a `git archive 00cf44f` export before the fix was written. A registration of exercise says the claim ran once SOMEWHERE. The count equality reads it as a RATIO against the domain declared for the claim, so the wrapper leaves the body running 6 times against a domain reached 12 times — measured, not reasoned — and the shortfall is named with the site, the code and the domain. The wrapper ALONE is green, here as there, and that is correct rather than a miss: without the harm the only productions of the code are rows the wrapper keeps",
    ),
    Proof(
        law="Q-02-TWO-SITES-UNDER-ONE-LABEL-RUN-TWICE-THEIR-DOMAIN",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            claimAbout(\n'
            '                                "E-04/not-sendable-offers-a-button-its-reader-can-press",\n'
            '                                "offline.not_sendable",\n'
            '                                step.code,\n'
            '                            ) {\n'
            '                                assertEquals(\n'
            '                                    OperationState.CAPTURED, op.state,\n'
            '                                    "a not_sendable refusal outside CAPTURED",\n'
            '                                )\n'
            '                            }\n'
            + CLAIM_SITE
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the thirteenth review's Q-02. The pair anchor's loss bound was defeated by REUSING a label, and the review was careful to say why that is not forgery: `INV-9a/\u2026` already labels two pairs in the literal total, so a second claim under one invariant inherits the label by copy-paste. Two sites under one label collapsed into one pair, and the anchor could not tell. The count is what bounds it without any convention about labelling: the label's body now runs 12 times against a declared domain of 6, and 2N against N is named as such",
    ),
    Proof(
        law="Q-02-A-LABEL-NAMES-ONE-SITE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            if (op.attempts > 1_000) {\n'
            '                                claimAbout(\n'
            '                                    "E-04/not-sendable-offers-a-button-its-reader-can-press",\n'
            '                                    "offline.not_sendable",\n'
            '                                    step.code,\n'
            '                                ) {\n'
            '                                    assertTrue(true, "a second site under a copied label")\n'
            '                                }\n'
            '                            }\n'
            + CLAIM_SITE
        ),
        expect_red="a claim about a refusal code is written through the registering helper",
        why="the half of Q-02 the count cannot see, and the reason the convention check also counts LABELS. A second site under an existing label, in a branch the search never reaches, changes no pair and no count: 6 of 6 still holds and the registry is satisfied. Only the text says there are two sites where the declaration names one. It reds through the CONVENTION CHECK, which is where a text check belongs — it derives nothing and carries that check's stated fail-open. What it cannot catch is a DECOY that replaces a claim's body in place while keeping its label and its count: measured green at 99 of 99 on this tree, and caught instead by THIS HARNESS, which reports proof 64 as `STAYED GREEN — the law is undefended` and exits 1. Bounding the loss of a site's CONTENT is what the harness is for; bounding the loss of a SITE is what the registry is for",
    ),
    Proof(
        law="Q-03-A-LOCAL-VARIABLE-IS-NOT-A-SPELLING",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            val codeHere = step.code\n'
            '                            when (codeHere) {\n'
            '                                "offline.permission_revoked" ->\n'
            '                                    assertEquals(\n'
            '                                        OperationState.NEEDS_ATTENTION, op.state,\n'
            '                                        "a permission refusal outside NEEDS_ATTENTION",\n'
            '                                    )\n'
            '                                else -> {}\n'
            '                            }\n'
            + CLAIM_SITE
        ),
        expect_red="a claim about a refusal code is written through the registering helper",
        why="the thirteenth review's Q-03, and the correction it asked for in the DISCLOSURE as much as in the code. The convention check said its fail-open was that \u201ca steered spelling escapes it\u201d, and the review measured two escapes that are not spellings: a local variable assigned from `step.code` and then compared, and the same comparison broken across two lines — each green at 99 of 99 with its control red. An assignment is a pattern now, so this plant reds; the line break is NOT reachable by a line-wise check and the disclosure says so in those words instead. A fail-open stated too kindly is worse than one stated plainly, because a reader believes the kind version",
    ),
    Proof(
        law="P-03-AN-ANCHOR-BOUNDS-THE-LOSS-OF-A-SITE-NOT-OF-A-CODE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            claimAbout(\n'
            '                                "a-second-lawful-site/about-the-same-code",\n'
            '                                "offline.not_sendable",\n'
            '                                step.code,\n'
            '                            ) {\n'
            '                                assertEquals(\n'
            '                                    OperationState.CAPTURED, op.state,\n'
            '                                    "a not_sendable refusal outside CAPTURED",\n'
            '                                )\n'
            '                            }\n'
            '                            if (step.code == "offline.not_sendable") {'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the twelfth review's P-03, filed latent and fixed as filed. A second LAWFUL claim about `offline.not_sendable` is added and the original site's registration is removed, its claim left as a bare equality. Keyed on CODES the two sites collapsed into one member, so the set was unchanged and the removal was invisible — green at 98 of 98 — while this check's own KDoc promised that a removed registration reddens. No code has two sites today; the promise is what made that latent rather than harmless. The registry is keyed on (site, code) PAIRS now, which is the coordinator's amendment that an anchor bounds the loss of the thing that can be LOST, and what can be lost is a site",
    ),
    Proof(
        law="P-02-A-CLAIM-WRITTEN-AROUND-THE-HELPER-IS-ENROLLED-BY-NOTHING",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=(
            '                            when (step.code) {\n'
            '                                "offline.permission_revoked" ->\n'
            '                                    assertEquals(\n'
            '                                        OperationState.NEEDS_ATTENTION, op.state,\n'
            '                                        "a permission refusal outside NEEDS_ATTENTION",\n'
            '                                    )\n'
            '                                else -> {}\n'
            '                            }\n'
            + CLAIM_SITE
        ),
        expect_red="a claim about a refusal code is written through the registering helper",
        why="the residual this session disclosed and the twelfth review measured: a conditional claim written AROUND the helper is enrolled by neither registry, so this exact plant — the tenth review's — was green at 98 of 98 on the head before this one, with its control (the same construct, a produced code, a false assertion) rc 1 red by name, so the green was genuine vacuity. This is the proof that was RETIRED one round ago because it could no longer redden, and it is restored here reddening through the CONVENTION CHECK the coordinator ruled in: that check derives nothing, states its own fail-open in its message, and can only ADD reds — a subject set steered by text yields a false green, a prohibition steered by text yields nothing, so its worst case is the residual it replaces. Note which test it reds: the convention check, not the registry",
    ),
    Proof(
        law="O-02-A-STALE-EXEMPTION-REDDENS-WHEREVER-THE-MAP-IS-DECLARED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find='    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"',
        replace=(
            '    private val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> =\n'
            '        mapOf("offline.a_code_no_claim_mentions" to "stale, and nobody noticed")\n\n'
            '    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="plant qB of the eleventh review, and the one that showed the previous head\u2019s governance was keyed to a LOCATION. The three assertions that make an exemption a claim of its own were sound; what carried them was a sweep of this file with the companion cut out, so declaring the map in the class body instead — legal, and what anyone does consolidating a test\u2019s data — swept the key into the set the key was then checked against, `key in claimed` true of its own input, and the hole N-02 was written to close was one `private val` away from open. The exemption is read as a VALUE from wherever it is declared now, and this plant reds by name with the stale key named",
    ),
    Proof(
        law="O-03-A-CLAIM-SITE-NOTHING-EVALUATES-REGISTERS-NOTHING",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                            if (aFinishedRowAnsweringAPerson) {",
        replace="                            if (false && aFinishedRowAnsweringAPerson) {",
        expect_red="every reachable configuration honours every invariant",
        why="the honest cost of deriving the subject set from EXECUTION, measured here rather than left for the next review to find — and the review said it would attack exactly this. A claim site in a branch nothing reaches registers nothing, so INV-15\u2019s two codes would vanish from `claimsMade` as quietly as a missed spelling once did. That is what the literal total is for: the registry is asserted for EQUALITY, so the two codes go missing by name. The site\u2019s own non-vacuity assertion (`terminalRefusals > 0`) is the second net, and the registry equality is asserted first so the message a reader sees names the codes",
    ),
    Proof(
        law="N-02-AN-EXEMPTION-MAY-NOT-HIDE-A-LIVE-OBLIGATION",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> = "
            "emptyMap()"
        ),
        replace=(
            "        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> =\n"
            '            mapOf("offline.not_sendable" to "a reason nobody checked")'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding N-02, filed P2 and rightly: `offline.not_sendable` is the only code this loop makes a derived claim about at this head, so ONE line in the exemption map removed the loop\u2019s entire live obligation with the suite green at 98 of 98 and nothing naming the loss. The guard built to make a silent weakening impossible could be silently weakened in one line. An exemption is a claim of its own: a code the reachable space DOES produce may not be exempted, so this plant reds by name — and at this head the claim it would hide is registered by EXECUTION, so no respelling or relocation of this map reaches the obligation either",
    ),
    Proof(
        law="N-02-AN-EXEMPTION-MUST-NAME-A-CODE-SOMETHING-CLAIMS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> = "
            "emptyMap()"
        ),
        replace=(
            "        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> =\n"
            '            mapOf("offline.a_code_no_claim_mentions" to "stale, and nobody noticed")'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding N-02, the other direction: a key for a code no claim mentions any more sat in the map green at 98 of 98, and the next reader takes a stale exemption for a justified one. Every key must name a code something here actually claims, read off the registry of claim sites that RAN rather than off a sweep of this file, so an exemption rots loudly instead of quietly",
    ),
    Proof(
        law="N-02-AN-EXEMPTION-WITHOUT-A-REASON-IS-NOT-AN-EXEMPTION",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> = "
            "emptyMap()"
        ),
        replace=(
            "        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> =\n"
            '            mapOf("offline.not_sendable" to "   ")'
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the third of N-02\u2019s directions, and the cheapest to get wrong: the map\u2019s type requires a reason and nothing required the reason to SAY anything, so whitespace would have bought the same silence as a sentence. The reason is asserted non-blank where it is read",
    ),
    Proof(
        law="R-01-A-NARROW-DOMAIN-S-GAP-MUST-BE-COVERED-BY-SOMETHING-NAMED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="        enum class ClaimDomain { EVERY_PRODUCTION, ON_A_FOREIGN_SCOPE_REFUSAL }",
        replace=(
            "        enum class ClaimDomain {\n"
            "            EVERY_PRODUCTION, ON_A_FOREIGN_SCOPE_REFUSAL, WHERE_THE_ACTOR_MAY_RELEASE,\n"
            "        }"
        ),
        edits=(
            (
                '            ("E-04/not-sendable-offers-a-button-its-reader-can-press" to "offline.not_sendable")\n'
                "                to ClaimDomain.EVERY_PRODUCTION,",
                '            ("E-04/not-sendable-offers-a-button-its-reader-can-press" to "offline.not_sendable")\n'
                "                to ClaimDomain.WHERE_THE_ACTOR_MAY_RELEASE,",
            ),
            (
                "    private val timesProducedOnACaptureSomebodyElseMustConfirm = mutableMapOf<String, Int>()",
                "    private val timesProducedOnACaptureSomebodyElseMustConfirm = mutableMapOf<String, Int>()\n\n"
                "    private val timesProducedWhereTheActorMayRelease = mutableMapOf<String, Int>()",
            ),
            (
                "                            val aForeignScopeRefusal = event is QueueEvent.ByScope &&",
                "                            if (event !is QueueEvent.ByScope ||\n"
                "                                permittedToAct(\n"
                "                                    event.actingScope, op.scope, QueueEvent.Release(event.actingScope),\n"
                "                                )\n"
                "                            ) {\n"
                "                                timesProducedWhereTheActorMayRelease[step.code] =\n"
                "                                    (timesProducedWhereTheActorMayRelease[step.code] ?: 0) + 1\n"
                "                            }\n"
                "                            val aForeignScopeRefusal = event is QueueEvent.ByScope &&",
            ),
            (
                "                ClaimDomain.ON_A_FOREIGN_SCOPE_REFUSAL ->\n"
                "                    timesProducedOnAForeignScopeRefusal[code] ?: 0",
                "                ClaimDomain.ON_A_FOREIGN_SCOPE_REFUSAL ->\n"
                "                    timesProducedOnAForeignScopeRefusal[code] ?: 0\n"
                "                ClaimDomain.WHERE_THE_ACTOR_MAY_RELEASE ->\n"
                "                    timesProducedWhereTheActorMayRelease[code] ?: 0",
            ),
            (
                CLAIM_SITE,
                "                            if (event !is QueueEvent.ByScope ||\n"
                "                                permittedToAct(\n"
                "                                    event.actingScope, op.scope, QueueEvent.Release(event.actingScope),\n"
                "                                )\n"
                "                            ) {\n"
                + CLAIM_SITE,
            ),
            (
                "                            }\n\n"
                "                            // INV-9c, added for the fourteenth review's R-01.",
                "                            }\n                            }\n\n"
                "                            // INV-9c, added for the fourteenth review's R-01.",
            ),
            (
                "src/app/daftar/offline/Queue.kt",
                "                    ?: refusalForACaptureSomebodyElseMustConfirm(event.actingScope)\n",
                "",
            ),
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the fourteenth review's R-01, and the hole it measured was in the ACCOUNTING rather than in any site. The denominator was chosen by an exhaustive `when`, so a new `ClaimDomain` value was forced to supply one — fail-closed. The partition that makes a narrow domain honest was guarded by `if (domain == ON_A_FOREIGN_SCOPE_REFUSAL)`, so a THIRD value got a denominator and no accounting at all, with the compiler silent. This is the review's own plant, seven edits across two files, each one a shape the file already contained and none of them inside the branch the site sits in: the value, a counter beside the others incremented at the TOP of the refusal arm, the `when` branch, E-04's claim redeclared over it, the site wrapped in that same condition, and E-04's refusal arm deleted underneath. **It measured 99 of 99 GREEN at `fe41d84`**, a cashier again told a colleague must confirm their own capture. What reds it now is that the gap is found by MEASURING it — any denominator below every production of the code is a gap, whatever its domain is called — and that a gap must be covered by something NAMED, which for this plant does not exist",
    ),
    Proof(
        law="R-01-A-COVER-THAT-NAMES-A-CLAIM-THAT-IS-NOT-THERE-COVERS-NOTHING",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "                to WhatCoversTheRest.AnotherClaimOverEveryProduction(\n"
            '                    "INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it",\n'
            "                ),"
        ),
        replace=(
            "                to WhatCoversTheRest.AnotherClaimOverEveryProduction(\n"
            '                    "INV-9c/a-claim-that-is-not-in-this-map",\n'
            "                ),"
        ),
        expect_red="every reachable configuration honours every invariant",
        why="a cover is a NAME, so the name has to resolve. The narrow claim's gap is declared to be covered by another claim about the same code over every production, and this plant points that declaration at a site nothing declares — a rename of the covering claim does the same thing by accident. Without this assertion the cover would be a comment with a type: the author writes a plausible site, the partition is never read, and the productions in the gap are judged by nothing while the file says they are covered",
    ),
    Proof(
        law="R-01-A-GAP-DECLARED-EMPTY-IS-MEASURED-EMPTY-OR-IT-REDS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "                to WhatCoversTheRest.AnotherClaimOverEveryProduction(\n"
            '                    "INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it",\n'
            "                ),"
        ),
        replace=(
            "                to WhatCoversTheRest.NothingIsLeftOut(\n"
            '                    "every production of this code is a foreign-scope refusal",\n'
            "                ),"
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the other half of the same requirement, and the one the review warned about: a reason is not a measurement. The second way to cover a gap is to say there is no gap, and an author who says so is believed only to the extent that the gap is then measured at ZERO. Here the sentence is false — the code has a second producer, E-04's own arm on a CAPTURED row — and the plant reds with the measured count beside the claim. If the reason alone were enough, this is the edit that would make any narrow domain honest by assertion",
    ),
    Proof(
        law="INV-9C-A-COLLEAGUES-CAPTURE-IS-REFUSED-ONLY-WHERE-THE-ACTOR-MAY-NOT-RELEASE-IT",
        path="src/app/daftar/offline/Queue.kt",
        find="        if (state == OperationState.CAPTURED && !acting.mayAct(scope, QueueEvent.Release(acting))) {",
        replace="        if (state == OperationState.CAPTURED) {",
        expect_red="every reachable configuration honours every invariant",
        why="the claim added for R-01 is a claim, so it is defended like one rather than taken on trust. Drop the permission half of this arm and a CAPTURED row is refused `offline.another_members_capture` — whose view tells the merchant that a colleague must confirm it — to the very session that captured it and may release it itself. The new claim asks of EVERY production of that code whether this acting session may release the row, computing the answer from the acting scope with this file's own permission function, and reds by name here. Without it the cover for INV-9a's narrow domain would be a name pointing at an assertion that could not fail",
    ),
    Proof(
        law="R-01-A-NARROW-DOMAIN-WITH-NO-DECLARED-COVER-IS-A-FAILURE-BEFORE-IT-IS-MEASURED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "        val WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT:\n"
            "            Map<Pair<String, String>, WhatCoversTheRest> = mapOf(\n"
            '            ("INV-9a/a-foreign-scope-is-refused-as-a-scope-problem" to "offline.another_members_capture")\n'
            "                to WhatCoversTheRest.AnotherClaimOverEveryProduction(\n"
            '                    "INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it",\n'
            "                ),\n"
            "        )"
        ),
        replace=(
            "        val WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT:\n"
            "            Map<Pair<String, String>, WhatCoversTheRest> = emptyMap()"
        ),
        expect_red="a claim about a refusal code is written through the registering helper",
        why="the coordinator's condition on R-01: the accounting must be FAIL-CLOSED, so a new domain is a failure until its accounting exists rather than a hole waiting for a search to reach it. Three things stand between a domain and silence, and this plant is the one that tests the first: the denominator's `when` is exhaustive with no `else`, so the compiler refuses a value with no denominator; a DECLARED narrow domain with no entry in this map reds here, before any count is read; and a MEASURED gap with no cover reds in the model check. Emptying the map leaves every count true — the search is unchanged — and reds on the declaration alone, which is what makes the rule independent of what this particular search happens to reach",
    ),
    Proof(
        law="T-02-NARROWING-THE-WAIT-JUDGMENT-DROPS-A-CLASS-TOTAL",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="""                            if (view.action == RecoveryAction.WAIT_IT_IS_IN_PROGRESS ||
                                view.message in assertsSomethingLeftTheDevice
                            ) {""",
        replace="""                            if ((view.action == RecoveryAction.WAIT_IT_IS_IN_PROGRESS ||
                                view.message in assertsSomethingLeftTheDevice) &&
                                op.state != OperationState.UNKNOWN_OUTCOME
                            ) {""",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the sixteenth review's T-02, in the form that actually removes judgments. Two words "
            "added to a gated condition stop the till being judged for telling a cashier to wait "
            "while nothing is pending. The judgment was counted, but its count was bounded by "
            "`> 0` — witness survival, which one surviving row satisfies — so the loss was "
            "invisible to the suite and to all 89 proofs. What reds it now is a LITERAL TOTAL for "
            "that class: 939 judgments, not at least one. The review's own narrowing excluded "
            "CAPTURED rows, and that one is a NO-OP in this space, measured rather than argued: "
            "the states reaching this judgment are QUEUED 399, IN_FLIGHT 210 and UNKNOWN_OUTCOME "
            "330, and CAPTURED is not among them — it cannot be, because a CAPTURED row here "
            "would fail the assertion this branch makes. So that plant removes an EMPTY set and "
            "stays green on a literal total too, which is correct. This one excludes a state the "
            "space does produce, which is what arms the anchor"
        ),
    ),
    Proof(
        law="T-02-A-GATED-JUDGMENT-WITH-NO-TOTAL-IS-REMOVED-IN-SILENCE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="""                            if (view.message in assertsSomethingLeftTheDevice) {
                                // T-02, the sixteenth review: this judgment was""",
        replace="""                            if (view.message in assertsSomethingLeftTheDevice &&
                                op.state != OperationState.QUEUED
                            ) {
                                // T-02, the sixteenth review: this judgment was""",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the sharper half of T-02: this was the ONE gated judgment in the search loop with no "
            "counter at all, so narrowing it removed a merchant-visible promise — that a refusal "
            "is never shown as something that left the device when nothing was sent — with "
            "nothing in the file able to notice. It is counted now and pinned at 312: QUEUED 72, "
            "IN_FLIGHT 180, UNKNOWN_OUTCOME 60, measured. This plant excludes QUEUED, which the "
            "space does produce here, and reds on the total. The review's own vD1 excluded "
            "CAPTURED, which this judgment never sees, so it removed nothing and was green for "
            "that reason rather than for want of an anchor"
        ),
    ),
    Proof(
        law="U-01-DELETING-THE-WAIT-JUDGMENT-TAKES-ITS-COUNT-WITH-IT",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find='                                judged(JudgmentKind.WAIT, op) {\n                                    "a ${op.state} row refused ${step.code}, which tells the merchant to " +\n                                        "wait (${view.message} / ${view.action}) while nothing is pending: " +\n                                        "$op on $event"\n                                }\n',
        replace="",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the seventeenth review's U-01, as the plant it built. A literal total on a counter "
            "bounds how many rows the gate ADMITS and says nothing about whether the judgment "
            "beside it still runs: `waitsJudged++` and its `assertTrue` were two statements with "
            "nothing tying them, and deleting the assertion while keeping the increment was the "
            "whole suite at 99 of 99 GREEN, rc 0, with the 939 anchor present and PASSING. The "
            "judgment and its count are ONE statement now, so this plant cannot keep the count"
        ),
    ),
    Proof(
        law="U-01-DELETING-THE-TRANSMISSION-JUDGMENT-TAKES-ITS-COUNT-WITH-IT",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find='                                judged(JudgmentKind.TRANSMISSION, op) {\n                                    "a refusal with nothing sent (${step.code}) is shown as " +\n                                        "${view.message}, which asserts a transmission: $op on $event"\n                                }\n',
        replace="",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the same, on the judgment the round before this one exists to protect — that a "
            "refusal is never shown as something that left the device when nothing was sent. Its "
            "brand-new anchor did not notice its deletion: 99 of 99 GREEN with 312 passing"
        ),
    ),
    Proof(
        law="U-01-THE-HELPER-THAT-COUNTS-AND-JUDGES-CANNOT-STOP-JUDGING",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find='            if (!holds) fail(message())\n',
        replace="",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the cost of the fix, named and then armed. Routing both judgments through one helper "
            "moves the whole question onto ONE line, and deleting that line is an edit no count "
            "can catch: every count survives it and every anchor passes while nothing in the loop "
            "judges anything. So a judgment known FALSE is put to the helper on every run, under "
            "a name of its own, and the helper must refuse it. This plant deletes the line and "
            "the arm reds by name"
        ),
    ),
    Proof(
        law="U-01-THE-TRANSMISSION-JUDGMENTS-PREDICATE-CANNOT-BE-REPLACED-BY-TRUE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="    private fun aTransmissionIsHonest(attempts: Int) = attempts > 0\n",
        replace="    private fun aTransmissionIsHonest(attempts: Int) = true\n",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the coordinator's F-E one layer in, after the measurement it asked for came back "
            "the wrong way. Deleting a judgment now takes its count with it, but REPLACING its "
            "predicate with `true` leaves every row arriving and every total holding: a count "
            "sees reach, never content. Measured at the previous head with this exact hollowing "
            "and nothing else: suite 99 of 99 GREEN, and the harness exited 1 only because F-2 "
            "refused a substitution — the kernel plant for that judgment moved the WAIT "
            "counter to 1077 and the wait anchor red first, so the declared refusal never "
            "printed. An incidental catch by an unrelated anchor is not an instrument, which is "
            "the third time in this round that distinction has decided a finding. So the "
            "predicate is NAMED and the loop and its arm read the same function, with a case it "
            "must refuse and a case it must accept, both on every run"
        ),
    ),
    Proof(
        law="U-01-THE-WAIT-JUDGMENTS-PREDICATE-CANNOT-BE-REPLACED-BY-TRUE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="    private fun aWaitIsHonest(state: OperationState) = state in somethingIsGenuinelyPending\n",
        replace="    private fun aWaitIsHonest(state: OperationState) = true\n",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the same, on the judgment that keeps a till from telling a cashier to wait while "
            "nothing is pending. Two cases per predicate rather than one, because a predicate "
            "stuck at FALSE is as wrong as one stuck at `true` and would pass a refusal case "
            "offered alone"
        ),
    ),
    Proof(
        law="R18-01-THE-WAIT-DISPATCH-CANNOT-BE-REPLACED-BY-TRUE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                JudgmentKind.WAIT -> aWaitIsHonest(op.state)\n",
        replace="                JudgmentKind.WAIT -> true\n",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the eighteenth review's R18-01, answered one layer further in than it asked. Naming "
            "each predicate closed hollowing of the function's BODY and OPENED hollowing of the "
            "call's argument: the call site passed the predicate's RESULT, an expression no arm "
            "saw, and one line changed left the whole suite at 99 of 99 rc 0 with both predicate "
            "arms passing and every per-state count identical. The call site now passes the KIND "
            "and the ROW, so choosing the predicate and reading its field both happen inside the "
            "helper, on the one path the arms travel. This plant hollows that choice where it now "
            "lives, and the wait arm below the walk reds by name at 98 of 99"
        ),
    ),
    Proof(
        law="R18-01-THE-TRANSMISSION-DISPATCH-CANNOT-BE-REPLACED-BY-TRUE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                JudgmentKind.TRANSMISSION -> aTransmissionIsHonest(op.attempts)\n",
        replace="                JudgmentKind.TRANSMISSION -> true\n",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the same on the other branch, and on the judgment this lane exists to keep: that a "
            "refusal with nothing sent is never shown to a merchant as something that left the "
            "device. This is the exact plant the eighteenth review measured as green against the "
            "previous head"
        ),
    ),
    Proof(
        law="R18-01-A-DISPATCH-BRANCH-CANNOT-BE-STUCK-AT-FALSE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                JudgmentKind.WAIT -> aWaitIsHonest(op.state)\n",
        replace="                JudgmentKind.WAIT -> false\n",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "two cases per branch rather than one, for the same reason there are two per "
            "predicate: a dispatch stuck at FALSE judges nothing it exists to judge and would "
            "pass a refusal arm offered alone. It reds inside the walk itself, on the first "
            "honest wait it meets, before the accept arm below is reached — which is the "
            "right order and is why both arms exist"
        ),
    ),
    Proof(
        law="R18-01-A-CALL-SITE-CANNOT-SWAP-WHICH-JUDGMENT-A-ROW-IS-PUT-TO",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                                judged(JudgmentKind.TRANSMISSION, op) {\n",
        replace="                                judged(JudgmentKind.WAIT, op) {\n",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "what a one-line edit at a call site CAN still change, now that it passes no "
            "predicate: which judgment the row is put to. It is not silent, because the kind is "
            "also the counter's key — the swap moves 312 rows onto the wait total and the "
            "per-state anchors red. Measured: 98 of 99. This is the pair to the two above: the "
            "dispatch is armed from inside, the kind from the counts"
        ),
    ),
    Proof(
        law="S-1-THE-SHAPE-TRIPWIRE-CANNOT-BE-LEFT-UNARMED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="""            judgmentsByState.entries.filter { it.key.first == "transmissions" }\n""",
        replace="""            judgmentsByState.entries.filter { it.key.first == "waits" }\n""",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the coordinator's S-1 on `9809db1`: the guard that announces when the per-state "
            "anchor stops being able to see a kind swap was armed by nothing, and deleting it "
            "left the suite at 99 of 99. This plant makes the guard's precondition false in the "
            "only way one edit can — it points the second reading at the first, so the two "
            "shapes coincide — and the guard must refuse. The bound, said rather than "
            "hidden: no single edit makes the two DISTRIBUTIONS coincide without a nearer guard "
            "firing first, because a row judged under the wrong kind trips the helper or the "
            "per-state anchor before this line is reached. So this arms the tripwire, not the "
            "convergence it warns about"
        ),
    ),
    Proof(
        law="R18-01-AN-ARMS-WITNESS-CANNOT-GO-MISSING-IN-SILENCE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "                if (aRowWithNothingPending == null && !aWaitIsHonest(op.state)) {\n"
            "                    aRowWithNothingPending = op\n"
            "                }\n"
        ),
        replace="",
        expect_red="every reachable configuration honours every invariant",
        why=(
            "the arms are put rows the WALK produced, not rows written beside them, because a row "
            "built next to its own arm is a row chosen to pass it. The cost is that a witness can "
            "be absent, and an arm that skips because its witness is null measures nothing. So "
            "each witness is REQUIRED to exist, by name, before its arm runs — fail on "
            "absence, never skip — and this plant removes one and reds on that refusal"
        ),
    ),
    Proof(
        law="U-01-THE-TRANSMISSION-JUDGMENTS-CONTENT-IS-NOT-ARMED-BY-ITS-COUNT",
        path="src/app/daftar/offline/Recovery.kt",
        find=(
            '        "offline.payload_changed_after_capture" ->\n'
            "            view(MerchantMessage.DETAILS_CHANGED_SINCE_CAPTURE, "
            "RecoveryAction.THIS_NEEDS_A_DEVELOPER)"
        ),
        replace=(
            '        "offline.payload_changed_after_capture" ->\n'
            "            view(MerchantMessage.ALREADY_SENDING, RecoveryAction.THIS_NEEDS_A_DEVELOPER)"
        ),
        expect_red="every reachable configuration honours every invariant",
        why=(
            "F-E, the coordinator's actual-diff review of `184f7d7`, and it is that review's own "
            "plant rather than one of this author's: the transmission judgment's CONTENT was armed "
            "by nothing here. `184f7d7` added `transmissionsJudged` and pinned it at 312, and none "
            "of the frozen refusals was that judgment's message, so hollowing the assertion to "
            "`true` left the suite at 99 of 99 with the counter and every literal total untouched "
            "— one changed line, invisible to both instruments. A count bounds the gate's "
            "REACH and never what the judgment says, which is U-01 one layer down. The review "
            "built the severity rather than asserting it: this code is produced 6 times with "
            "`attempts == 0`, all on QUEUED rows, measured, so pointing it at a message that "
            "asserts a transmission is a refusal shown to a cashier as something that left the "
            "device when nothing was sent. It is caught twice over — here, and by "
            "`RecoveryTest` reading the same mapping independently in another file — which is "
            "why the review rated the gap P3 and recorded that its attack did not escape"
        ),
    ),
    Proof(
        law="R-03-A-SWEEPS-TOTAL-READ-FROM-ITS-OWN-LIST-MOVES-WITH-A-NARROWING",
        path="test/app/daftar/offline/OutcomeExhaustiveTest.kt",
        # The find is anchored to the newline before its EIGHT spaces: this
        # commit adds a literal pin of the same list at a deeper indentation,
        # and an unanchored pattern matched both — the harness refused the
        # proof as a mutation that did not land, which is what it is for.
        find='\n        "customer.credit_limit_exceeded",\n',
        replace='\n',
        expect_red="no answer outside 2xx can ever produce Synced",
        why=(
            "R-03, found while recording the sixteenth review's withdrawal of T-02 and measured "
            "before it was written down. This is THE load-bearing sweep — the one that says no "
            "answer outside 2xx can ever report a sale as committed — and its exhaustiveness was "
            "anchored at `700 * codes.size * 3 * retryAfters.size`, two of whose four factors are "
            "read from the very lists the sweep walks. So a narrowing moved BOTH terms: deleting "
            "ONE server code from the list left the whole suite at 99 of 99 GREEN, rc 0, with "
            "that equality and `checked > 100_000` both in place, sweeping 168,000 inputs instead "
            "of 184,800 with no name saying so. The existing sweep proof attacked the STATUS "
            "range, the one factor written as a literal, which is why fourteen rounds never "
            "reached this. What reds it now is the DOMAIN pinned by value and the total written "
            "as a literal 184,800 — the same answer S-02 and T-02 got, in the sweep neither "
            "review looked at"
        ),
    ),
    Proof(
        law="R-03-THE-DECISION-SHAPE-SWEEP-COUNTS-ITS-OWN-NARROWING-AS-COMPLETE",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "        val codes = listOf(\n"
            "            null, \"\", \"IDEMPOTENCY_KEY_REUSED\", \"accounting.idempotency_conflict\",\n"
            "            \"inventory.insufficient_stock\", \"VALIDATION_FAILED\", \"accounting.period_closed\",\n"
            "        )"
        ),
        replace=(
            "        val codes = listOf(\n"
            "            null, \"\", \"IDEMPOTENCY_KEY_REUSED\", \"accounting.idempotency_conflict\",\n"
            "            \"inventory.insufficient_stock\", \"VALIDATION_FAILED\",\n"
            "        )"
        ),
        expect_red="the representative answers cover every decision shape the classifier can produce",
        why=(
            "the second instance of R-03, in the sweep that stands under the model check's lemma "
            "about decision shapes. Its total read `700 * codes.size * 3 * 4` and was measured "
            "the same way: deleting `accounting.period_closed` from the list left the suite at 99 "
            "of 99 GREEN, rc 0. The claim this sweep exists to make is that the representatives "
            "cover every shape the classifier can produce, and a narrowed domain makes that claim "
            "about a smaller classifier than the one shipped. The domain is pinned by value and "
            "the total is the literal 58,800"
        ),
    ),
    Proof(
        law="S-02-NARROWING-THE-PREDICATE-THAT-DEFINES-A-DOMAIN-MOVES-BOTH-COUNTS-TOGETHER",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=(
            "                            val aForeignScopeRefusal = event is QueueEvent.ByScope &&\n"
            "                                !permittedToAct(event.actingScope, op.scope, event)"
        ),
        replace=(
            "                            val aForeignScopeRefusal = event is QueueEvent.ByScope &&\n"
            "                                !permittedToAct(event.actingScope, op.scope, event) &&\n"
            "                                !(\n"
            "                                    op.state == OperationState.CAPTURED &&\n"
            "                                        event.actingScope.tenantId == op.scope.tenantId &&\n"
            "                                        event.actingScope.businessId == op.scope.businessId\n"
            "                                    )"
        ),
        expect_red="every reachable configuration honours every invariant",
        why="the fifteenth review's S-02, and it is the cost of the design that answered the attack announced before it. The predicate that defines the narrow domain is hoisted ONCE and read by both the counter and the branch — deliberately, because two copies of a predicate drift apart — so NARROWING it moves the numerator and the denominator together: `ran == denominator` holds by construction, the complement counter's own `!aForeignScopeRefusal && state == CAPTURED` absorbs exactly what the narrowing expelled, the measured gap still has its declared cover, and every R-01 instrument stays green. Five lines inside an existing `&&`, no new value, claim or map entry, **99 of 99 at `ae18b10`** — and the model check silently stopped judging which CODE and which LAW a colleague's captured row is refused with, which the review then showed by an A/B on a law-id harm: red in both trees from a hand-written unit test, red in the model check only on the unnarrowed one. A ratio cannot see a narrowing that moves both of its terms, so what reds this plant is a LITERAL TOTAL PER CLASS: an anchor that bounds the LOSS instead of one the narrowing preserves. 1,125 foreign-scope productions of the code become 1,110 and the anchor names the class",
    ),
]

FAILURE_LINE = re.compile(r"^\s+JUnit Jupiter:(\S+):(.+)\(\)\s*$")

# The fifteenth review's S-01. A cover declared in `QueueModelCheckTest` is
# checked there for the STRENGTH of its domain and for its RATIO, never for
# what it asserts: a claim whose body cannot fail satisfies both, because a
# body that asserts nothing still RUNS on every production of its code. The
# review measured it — a decoy cover with E-04's harm live, 99 of 99 green,
# and E-04's own proof staying green with it.
#
# What a claim MEANS is bound by a defect planted against it, so the obligation
# belongs here rather than in the subject: **every claim named as a cover must
# have a proof in this file, and that proof must have gone RED in THIS run.**
#
# Both sides of the check are derived by EXECUTION, which is the rule this lane
# learned the hard way: the covers come from the lines the SUITE PRINTS in the
# baseline run, never from reading the Kotlin source (a subject that writes the
# text deciding what is checked decides what is checked), and the proofs come
# from this run's own verdicts, never from a count written down. A cover with
# no entry here FAILS the harness, and so does one whose proof did not redden.
A_PROOF_DEFENDS_THIS_COVER: dict[tuple[str, str], str] = {
    (
        "INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it",
        "offline.another_members_capture",
    ): "INV-9C-A-COLLEAGUES-CAPTURE-IS-REFUSED-ONLY-WHERE-THE-ACTOR-MAY-NOT-RELEASE-IT",
}

COVER_CLAIM_LINE = re.compile(r"^P7-COVER-CLAIM\|(.+)\|(.+)$")


def covers_the_suite_declared(log: str) -> set[tuple[str, str]]:
    """The covers a RUN of the suite printed. Execution, not source text."""
    return {
        (m.group(1).strip(), m.group(2).strip())
        for line in log.splitlines()
        if (m := COVER_CLAIM_LINE.match(line.strip()))
    }


# The coordinator's F-1, of `771b525`. Deriving the cover set from EXECUTION
# bounds forgery — a printed line that nothing declares fails closed — and it
# does not bound OMISSION: delete the loop that prints those lines and the set
# is empty, every cover in it is vacuously defended, and the harness exits 0.
# The review measured exactly that.
#
# Omission is bounded by a SECOND derivation that cannot be deleted by the same
# edit, and by comparing the two SETS rather than trusting either. This one
# reads the DECLARATIONS out of the test source, which is the representation the
# subject itself writes — weak on its own, for the reason this lane has recorded
# since the eleventh review, and that is the point: the two derivations have
# different weaknesses, so a disagreement between them is a refusal.
#
# What the pair cannot catch is an edit that removes the print loop AND the
# declaration together. That is not left to an argument either: deleting the
# declaration leaves a narrow domain with no cover entry, and the suite's own
# convention test reds on it before any count is read (proof 88). Three
# instruments, each deletable, no single deletion silent.
COVER_MAP_DECL = "val WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT:"
COVER_MAP_FILE = "test/app/daftar/offline/QueueModelCheckTest.kt"
A_WIDER_COVER = "AnotherClaimOverEveryProduction"
NOTHING_IS_LEFT_OUT = "NothingIsLeftOut"
KOTLIN_STRING = re.compile(r'"([^"\\\n]*)"')


class CannotRead(Exception):
    """The declarations could not be read. A reader that cannot read REFUSES."""


def _balanced_mapof(text: str) -> str:
    """The body of the `mapOf(` that follows the declaration, by paren depth."""
    at = text.find(COVER_MAP_DECL)
    if at < 0:
        raise CannotRead(f"{COVER_MAP_DECL} is not in {COVER_MAP_FILE}")
    opener = text.find("mapOf(", at)
    if opener < 0:
        raise CannotRead("the declaration is not followed by a mapOf(")
    i = opener + len("mapOf(")
    depth, start, in_string = 1, i, False
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[start:i]
        i += 1
    raise CannotRead("the mapOf( that follows the declaration is never closed")


def _entries(body: str) -> list[str]:
    """Top-level comma-separated entries of a Kotlin map literal body."""
    out, depth, in_string, current = [], 0, False, []
    i = 0
    while i < len(body):
        ch = body[i]
        if in_string:
            if ch == "\\":
                current.append(body[i : i + 2])
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    if "".join(current).strip():
        out.append("".join(current))
    return [e for e in out if e.strip()]


def covers_the_source_declares(text: str) -> set[tuple[str, str]]:
    """The covers the TEST SOURCE declares, as (covering site, code) pairs.

    The same pair shape the suite prints, so the two sets are comparable. A
    shape this cannot read is a refusal, never an empty set: an unreadable
    declaration that counted as zero covers would be the same hole again.
    """
    declared: set[tuple[str, str]] = set()
    for entry in _entries(_balanced_mapof(text)):
        wider, nothing = A_WIDER_COVER in entry, NOTHING_IS_LEFT_OUT in entry
        if wider == nothing:
            raise CannotRead(
                "an entry names neither exactly one of "
                f"{A_WIDER_COVER} and {NOTHING_IS_LEFT_OUT}: {' '.join(entry.split())[:120]}"
            )
        if nothing:
            continue
        literals = KOTLIN_STRING.findall(entry)
        if len(literals) != 3:
            raise CannotRead(
                f"an entry naming {A_WIDER_COVER} holds {len(literals)} readable string "
                f"literals, and this reader requires exactly 3 (narrow claim, code, covering "
                f"site): {' '.join(entry.split())[:120]}"
            )
        _narrow, code, site = literals
        declared.add((site, code))
    return declared


# T-01, the sixteenth review. F-1's answer compares two derivations, and the
# review then measured what neither the coordinator nor this session had: the
# five lines that PRINT the covers are planted by no proof, so `grep` finds
# `P7-COVER-CLAIM` in this harness exactly once, in the regex that parses it.
# The comparison refuses when they are deleted — but nothing in the shipped
# harness was DOING that deletion, so the whole obligation rested on a line
# whose removal was measured only by hand, in a review, by one session at a
# time.
#
# So the harness does it itself, once per run, on a copy: delete those five
# lines, run the suite, and require the comparison to refuse. The arm is held
# to the same rule as a plant — the text must match exactly once, and a miss is
# a FAILURE rather than a skip — which makes the five lines load-bearing twice
# over: delete them in the subject and the arm no longer lands.
COVER_PRINT_LOOP = """        for ((claim, cover) in WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT) {
            if (cover is WhatCoversTheRest.AnotherClaimOverEveryProduction) {
                println("P7-COVER-CLAIM|${cover.site}|${claim.second}")
            }
        }
"""


def omission_arm(declared: set[tuple[str, str]]) -> tuple[list[str], str]:
    """Delete the lines that print the covers, and require a refusal."""
    if not declared:
        return (
            [
                "the omission arm has nothing to omit: no cover is declared in "
                f"{COVER_MAP_FILE}, so the arm measures nothing and cannot be read as a pass"
            ],
            "NOTHING DECLARED",
        )
    tree = a_tree("p7-omission-arm-")
    for part in ("src", "test"):
        shutil.copytree(os.path.join(ROOT, part), os.path.join(tree, part))
    target = os.path.join(tree, COVER_MAP_FILE)
    before = open(target, encoding="utf-8").read()
    hits = before.count(COVER_PRINT_LOOP)
    if hits != 1:
        return (
            [
                f"the omission arm's edit matched {hits} times in {COVER_MAP_FILE} (must be "
                f"exactly 1) — THE ARM DID NOT LAND, so the one line the cover obligation "
                f"rests on is unmeasured again, which is T-01"
            ],
            f"ARM DID NOT LAND ({hits} matches)",
        )
    open(target, "w", encoding="utf-8").write(before.replace(COVER_PRINT_LOOP, ""))
    rc, _failing, _details, log = run_suite(tree)
    if rc != 0:
        return (
            [
                "the omission arm's copy is not green with the print loop removed, so the arm "
                "cannot tell a refusal from a broken tree"
            ],
            f"ARM TREE NOT GREEN (rc {rc})",
        )
    printed = covers_the_suite_declared(log)
    if printed:
        return (
            [
                "the omission arm deleted the loop that prints the covers and the run printed "
                f"covers anyway: {sorted(printed)} — something else prints them, so this arm "
                f"is not measuring what it claims to"
            ],
            "ARM MEASURED NOTHING",
        )
    refusals = cover_failures(printed, declared, set(A_PROOF_DEFENDS_THIS_COVER.values()))
    if not any("F-1: omission" in refusal for refusal in refusals):
        return (
            [
                "the omission arm removed every printed cover and the comparison did not refuse: "
                f"{refusals or 'no refusal at all'} — the obligation fails OPEN on absence, "
                f"which is T-01"
            ],
            "NO REFUSAL ON ABSENCE",
        )
    return ([], f"refused as required ({len(printed)} printed, {len(declared)} declared)")


def cover_failures(
    printed: set[tuple[str, str]],
    declared: set[tuple[str, str]],
    reddened: set[str],
) -> list[str]:
    """Every refusal the cover obligation owes, over its three derivations.

    Pure, and called from `main` with the real sets and from `--self-test` with
    crafted ones, which is how each branch below is armed: a branch deleted here
    is a `--self-test` failure, and the self-test runs as this harness's own
    first step. A guard nothing can redden is not a guard.
    """
    failures: list[str] = []
    for cover in sorted(declared - printed):
        failures.append(
            f"the cover naming {cover[0]} for a narrow domain about {cover[1]} is DECLARED in "
            f"{COVER_MAP_FILE} and was never PRINTED by the run — the loop that prints the "
            f"declared covers is how this harness learns what to check, so a cover missing from "
            f"the run is an unbounded cover, not an absent one (F-1: omission)"
        )
    for cover in sorted(printed - declared):
        failures.append(
            f"the run PRINTED a cover naming {cover[0]} for a narrow domain about {cover[1]} "
            f"that no declaration in {COVER_MAP_FILE} contains — the two derivations of "
            f"this set disagree, and a disagreement is a refusal (F-1: forgery)"
        )
    for cover in sorted(printed):
        law = A_PROOF_DEFENDS_THIS_COVER.get(cover)
        if law is None:
            failures.append(
                f"the claim at {cover[0]} is named as the cover for a narrow domain about "
                f"{cover[1]}, and no proof in this file is declared to defend it — a cover "
                f"checked for its domain and its ratio but never for what it asserts is a name, "
                f"and a claim whose body cannot fail satisfies both of those checks"
            )
        elif law not in reddened:
            failures.append(
                f"the claim at {cover[0]} is named as the cover for a narrow domain about "
                f"{cover[1]}, and the proof declared to defend it ({law}) did not redden in this "
                f"run, so what that cover asserts is bound by nothing here"
            )
    return failures


# The coordinator's F-2, of `771b525`, and pre-existing: "reddened" has always
# meant THE NAMED TEST FAILED, never WHY it failed. The review measured the
# consequence — INV-9c's assertion hollowed out, and the proof declared to
# defend that cover still reds, through `a claim this check makes was never
# EXERCISED` rather than through the law. A proof that reddens for an unrelated
# reason measures the test's existence, not the law.
#
# So every proof also names the REFUSAL it expects, and the refusal the runner
# printed under the named test must contain it. The strings below were HARVESTED
# from a measured run and then frozen — they are not predictions, and this is
# said plainly because a harvested expectation proves that the reason has not
# CHANGED, which is what F-2 is about, and proves nothing about whether the
# reason was right on the day it was harvested. A law with no entry here is a
# FAILED proof, not an unchecked one.
EXPECTED_REFUSAL: dict[str, str | tuple[str, ...]] = {
    'U-01-THE-TRANSMISSION-JUDGMENTS-PREDICATE-CANNOT-BE-REPLACED-BY-TRUE': (
        "org.opentest4j.AssertionFailedError: the TRANSMISSION judgment's own predicate accepts a row with no attempt, so a refusal with nothing sent could be shown to a cashier as something that left the device, which is the promise this phase exists to keep"
    ),
    'U-01-THE-WAIT-JUDGMENTS-PREDICATE-CANNOT-BE-REPLACED-BY-TRUE': (
        "org.opentest4j.AssertionFailedError: the WAIT judgment's own predicate accepts a CAPTURED row, a row with nothing pending on the device, so it would pass a till that tells a cashier to wait for a transmission that was never started"
    ),
    'U-01-THE-TRANSMISSION-JUDGMENTS-CONTENT-IS-NOT-ARMED-BY-ITS-COUNT': (
        'org.opentest4j.AssertionFailedError: a refusal with nothing sent (offline.payload_changed_after_capture) is shown as ALREADY_SENDING, which asserts a transmission: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=QUEUED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Send(digestNow=sha256:deadbeef, actingScope=tenant-1/business-1/member-1)'
    ),
    'U-01-DELETING-THE-WAIT-JUDGMENT-TAKES-ITS-COUNT-WITH-IT': (
        "org.opentest4j.AssertionFailedError: a different number of refusals was judged for telling the merchant to wait while nothing is pending, which is the judgment a narrowing of that condition removes in silence. 939 of these are the walk's own and 2 are the arms above, which go through the same helper and are counted by it like any other row ==> expected: <941> but was: <2>"
    ),
    'U-01-DELETING-THE-TRANSMISSION-JUDGMENT-TAKES-ITS-COUNT-WITH-IT': (
        "org.opentest4j.AssertionFailedError: a different number of refusals was judged for being shown as something that left the device, which is the judgment that had no counter at all until T-02. 312 of these are the walk's own and 2 are the arms above ==> expected: <314> but was: <2>"
    ),
    'U-01-THE-HELPER-THAT-COUNTS-AND-JUDGES-CANNOT-STOP-JUDGING': (
        'org.opentest4j.AssertionFailedError: put a CAPTURED row with nothing pending, the helper did not refuse the WAIT judgment, so either its dispatch no longer reads that predicate or it no longer fails on a false judgment, and every wait judged in the walk above judged nothing'
    ),
    'R-03-A-SWEEPS-TOTAL-READ-FROM-ITS-OWN-LIST-MOVES-WITH-A-NARROWING': (
        'org.opentest4j.AssertionFailedError: THE-SWEEPS-DOMAIN-CHANGED: the server codes this exhaustive sweep walks are not the ones it claims to walk, so every claim made over it is made over a narrower space than it names. codes = [null, ,    , IDEMPOTENCY_KEY_REUSED, accounting.idempotency_conflict, inventory.idempotency_conflict, sales.idempotency_conflict, inventory.insufficient_stock, VALIDATION_FAILED, accounting.period_closed] ==> expected: <[null, ,    , IDEMPOTENCY_KEY_REUSED, accounting.idempotency_conflict, inventory.idempotency_conflict, sales.idempotency_conflict, inventory.insufficient_stock, customer.credit_limit_exceeded, VALIDATION_FAILED, accounting.period_closed]> but was: <[null, ,    , IDEMPOTENCY_KEY_REUSED, accounting.idempotency_conflict, inventory.idempotency_conflict, sales.idempotency_conflict, inventory.insufficient_stock, VALIDATION_FAILED, accounting.period_closed]>'
    ),
    'R-03-THE-DECISION-SHAPE-SWEEP-COUNTS-ITS-OWN-NARROWING-AS-COMPLETE': (
        'org.opentest4j.AssertionFailedError: THE-SWEEPS-DOMAIN-CHANGED: the server codes this sweep covers are not the ones it claims to cover, so the lemma that reads its result is reading a narrower search than it says. codes = [null, , IDEMPOTENCY_KEY_REUSED, accounting.idempotency_conflict, inventory.insufficient_stock, VALIDATION_FAILED] ==> expected: <[null, , IDEMPOTENCY_KEY_REUSED, accounting.idempotency_conflict, inventory.insufficient_stock, VALIDATION_FAILED, accounting.period_closed]> but was: <[null, , IDEMPOTENCY_KEY_REUSED, accounting.idempotency_conflict, inventory.insufficient_stock, VALIDATION_FAILED]>'
    ),
    'T-02-A-GATED-JUDGMENT-WITH-NO-TOTAL-IS-REMOVED-IN-SILENCE': (
        "org.opentest4j.AssertionFailedError: a different number of refusals was judged for being shown as something that left the device, which is the judgment that had no counter at all until T-02. 312 of these are the walk's own and 2 are the arms above ==> expected: <314> but was: <242>"
    ),
    'T-02-NARROWING-THE-WAIT-JUDGMENT-DROPS-A-CLASS-TOTAL': (
        "org.opentest4j.AssertionFailedError: a different number of refusals was judged for telling the merchant to wait while nothing is pending, which is the judgment a narrowing of that condition removes in silence. 939 of these are the walk's own and 2 are the arms above, which go through the same helper and are counted by it like any other row ==> expected: <941> but was: <611>"
    ),
    'E-03-A-CODE-NO-QUEUE-STATE-EVER-PRODUCES': (
        'org.opentest4j.AssertionFailedError: the set of refusals that tell a merchant something is in progress is not the set of refusals the model check has proven can only be produced while something is pending on the device (P7-L20-A-DESTRUCTION-IS-RECORDED-BEFORE-IT-HAPPENS). A code that belongs here needs its state proven in QueueModelCheckTest first; a code that no longer belongs is a line to delete from waitIsHonest, with its reason ==> expected: <[offline.already_released, offline.already_sending, offline.cancel_after_send, offline.no_attempt_in_flight]> but was: <[offline.already_released, offline.already_sending, offline.cancel_after_send, offline.no_attempt_in_flight, offline.session_expired]>'
    ),
    'E-04-A-REFUSAL-MAY-NOT-OFFER-A-BUTTON-ITS-READER-CANNOT-PRESS': (
        'org.opentest4j.AssertionFailedError: a session that may not confirm this row was told to confirm it (offline.not_sendable): Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=CAPTURED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Send(digestNow=sha256:0d5f1f2b, actingScope=tenant-1/business-1/member-2)'
    ),
    'HARNESS-AN-UNMAPPED-REFUSAL-CODE-CANNOT-REACH-A-TILL': (
        'org.opentest4j.AssertionFailedError: these codes reach a merchant as a generic device-software problem, which erases what they could actually do about it. If one of them genuinely is a device defect, add it to deliberatelyADeveloperProblem WITH ITS REASON rather than widening this test ==> expected: <[]> but was: <[offline.a_newly_added_refusal]>'
    ),
    'HARNESS-THE-BENIGN-FALLBACK-GUARD-CAN-SEE': (
        "org.opentest4j.AssertionFailedError: a command's effect class was defaulted to BENIGN (P7-L11-NO-DEFAULT-EFFECT-CLASS) ==> expected: <[]> but was: <[CommandEffects.kt: EffectClass = EffectClass.BENIGN]>"
    ),
    'HARNESS-THE-EXHAUSTIVE-SWEEP-CANNOT-SHRINK': (
        'org.opentest4j.AssertionFailedError: expected: <184800> but was: <26400>'
    ),
    'HARNESS-THE-MERCHANT-VIEW-SWEEP-CATCHES-A-REAL-MISS': (
        'org.opentest4j.AssertionFailedError: these codes reach a merchant as a generic device-software problem, which erases what they could actually do about it. If one of them genuinely is a device defect, add it to deliberatelyADeveloperProblem WITH ITS REASON rather than widening this test ==> expected: <[]> but was: <[offline.absence_not_fenced]>'
    ),
    'HARNESS-THE-MODEL-CHECK-IS-NOT-VACUOUS': (
        'org.opentest4j.AssertionFailedError: some event never moved anything, so its transitions were never checked ==> expected: <[Release, CancelByMerchant, Send, ProcessDeath, Observe, ResolveByMerchant, RetentionDeadlineReached, RestorePayload]> but was: <[Release, CancelByMerchant, Send, Observe, RetentionDeadlineReached, ResolveByMerchant, RestorePayload]>'
    ),
    'HARNESS-THE-RACE-TEST-MUST-DETECT-A-SECOND-COMMIT': (
        'org.opentest4j.AssertionFailedError: fencing=true, original lands between: the server holds 2 operations for one sale'
    ),
    'HARNESS-THE-SCOPE-SEARCH-CANNOT-STOP-OFFERING-A-FOREIGN-SESSION': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]>'
    ),
    'HARNESS-THE-SCOPE-SEARCH-CANNOT-STOP-OFFERING-THE-NEXT-SHIFT': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]>'
    ),
    'HARNESS-THE-SEARCH-CANNOT-STOP-OFFERING-A-RESTORE': (
        'org.opentest4j.AssertionFailedError: some event never moved anything, so its transitions were never checked ==> expected: <[Release, CancelByMerchant, Send, ProcessDeath, Observe, ResolveByMerchant, RetentionDeadlineReached, RestorePayload]> but was: <[Release, CancelByMerchant, ProcessDeath, Send, Observe, RetentionDeadlineReached, ResolveByMerchant]>'
    ),
    'HARNESS-THE-SEARCH-CANNOT-STOP-OFFERING-A-RETENTION-DEADLINE': (
        'org.opentest4j.AssertionFailedError: some event never moved anything, so its transitions were never checked ==> expected: <[Release, CancelByMerchant, Send, ProcessDeath, Observe, ResolveByMerchant, RetentionDeadlineReached, RestorePayload]> but was: <[Release, CancelByMerchant, ProcessDeath, Send, Observe, ResolveByMerchant]>'
    ),
    'HARNESS-THE-STATE-COVERAGE-GUARD-CAN-FAIL-ON-SYNCED': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]>'
    ),
    'INV-13-A-RELEASE-ONLY-EVER-MOVES-AN-UNSENT-ROW': (
        'org.opentest4j.AssertionFailedError: a Release(actingScope=tenant-1/business-1/member-1) moved a row that had already been sent: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=UNKNOWN_OUTCOME, attempts=1, lastCode=null, replayed=false, schema=1, minimized=false) (P7-L5-NO-LOCAL-DELETE-BEFORE-A-CONFIRMED-OUTCOME) ==> expected: <0> but was: <1>'
    ),
    'INV-13-A-TERMINAL-ROW-IS-NOT-CANCELLED-TWICE': (
        'org.opentest4j.AssertionFailedError: an already-abandoned row was abandoned a second time, clearing it twice. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'INV-14-A-FOREIGN-SESSION-NEVER-ACTS-UNRECORDED': (
        "org.opentest4j.AssertionFailedError: a move by the row's own session was recorded as a custody action: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=CAPTURED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Release(actingScope=tenant-1/business-1/member-1)"
    ),
    'INV-14-THE-RECORD-NAMES-THE-ACTOR-NOT-THE-ROW': (
        'org.opentest4j.AssertionFailedError: the record names the wrong actor ==> expected: <tenant-1/business-1/member-2> but was: <tenant-1/business-1/member-1>'
    ),
    'INV-14-THE-RECORD-SAYS-WHAT-WAS-DONE': (
        'org.opentest4j.AssertionFailedError: the record says CancelByMerchant about a Send(digestNow=sha256:0d5f1f2b, actingScope=tenant-1/business-1/member-2): Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=QUEUED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) ==> expected: <Send> but was: <CancelByMerchant>'
    ),
    'INV-15-A-FINISHED-ROW-ANSWERS-IN-ITS-OWN-TERMS': (
        'org.opentest4j.AssertionFailedError: a session that may not confirm this row was told to confirm it (offline.not_sendable): Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=CAPTURED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Send(digestNow=sha256:0d5f1f2b, actingScope=tenant-1/business-1/member-2)'
    ),
    'INV-9B-A-NEW-CODE-MAY-NOT-SAY-WAIT-BY-DEFAULT': (
        'org.opentest4j.AssertionFailedError: the set of refusals that tell a merchant something is in progress is not the set of refusals the model check has proven can only be produced while something is pending on the device (P7-L20-A-DESTRUCTION-IS-RECORDED-BEFORE-IT-HAPPENS). A code that belongs here needs its state proven in QueueModelCheckTest first; a code that no longer belongs is a line to delete from waitIsHonest, with its reason ==> expected: <[offline.already_released, offline.already_sending, offline.cancel_after_send, offline.no_attempt_in_flight]> but was: <[offline.already_released, offline.already_sending, offline.another_members_capture, offline.cancel_after_send, offline.no_attempt_in_flight]>'
    ),
    'INV-9B-THE-ACTION-IS-WHAT-INSTRUCTS-THE-MERCHANT': (
        'org.opentest4j.AssertionFailedError: a NEEDS_ATTENTION row refused offline.waiting_on_a_person, which tells the merchant to wait (SALE_NEEDS_YOUR_ATTENTION / WAIT_IT_IS_IN_PROGRESS) while nothing is pending: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=NEEDS_ATTENTION, attempts=1, lastCode=IDEMPOTENCY_KEY_REUSED, replayed=false, schema=1, minimized=false) on Release(actingScope=tenant-1/business-1/member-1)'
    ),
    'INV-9C-A-COLLEAGUES-CAPTURE-IS-REFUSED-ONLY-WHERE-THE-ACTOR-MAY-NOT-RELEASE-IT': (
        "org.opentest4j.AssertionFailedError: a session that MAY release this row was told it is another member's capture (offline.another_members_capture), whose view tells the merchant a colleague must confirm it: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=CAPTURED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Send(digestNow=sha256:0d5f1f2b, actingScope=tenant-1/business-1/member-1)"
    ),
    'J-03-AN-OVERLOAD-IS-A-DEFAULT-WITH-A-DIFFERENT-SHAPE': (
        'org.opentest4j.AssertionFailedError: the kernel declares more than one capture function. A second one is a way to capture without stating what the operation is worth, whatever its body passes for null ==> expected: <1> but was: <2>'
    ),
    'K-02-A-CODE-NEED-NOT-BE-A-LITERAL-TO-REACH-A-MERCHANT': (
        'org.opentest4j.AssertionFailedError: the classifier produced offline.cancel_after_send for status 401 / errorCode null, and the merchant is told CANNOT_CANCEL_AFTER_SENDING / WAIT_IT_IS_IN_PROGRESS — but the server has answered and this row is waiting on a person, so nothing is pending on the device to wait for'
    ),
    'K-03-A-SECOND-WAY-IN-NEED-NOT-BE-IN-THE-SAME-FILE': (
        'org.opentest4j.AssertionFailedError: the kernel declares more than one capture function. A second one is a way to capture without stating what the operation is worth, whatever its body passes for null ==> expected: <1> but was: <2>'
    ),
    'L-01-A-CLAIM-ABOUT-A-CODE-NOTHING-PRODUCES-IS-A-CLAIM-ABOUT-NOTHING': (
        "org.opentest4j.AssertionFailedError: a session that MAY release this row was told it is another member's capture (offline.another_members_capture), whose view tells the merchant a colleague must confirm it: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=CAPTURED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Send(digestNow=sha256:0d5f1f2b, actingScope=tenant-1/business-1/member-1)"
    ),
    'L13-TWO-DIFFERENT-REFUSALS-MAY-NOT-SHARE-ONE-VIEW': (
        'org.opentest4j.AssertionFailedError: Release(actingScope=tenant-1/business-1/member-bob) was refused for the wrong reason ==> expected: <offline.another_members_capture> but was: <offline.scope_switched>'
    ),
    'M-01-O-01-A-CLAIM-IS-ENROLLED-BY-BEING-EVALUATED': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture), (a-plant/a-claim-about-a-code-nothing-produces, offline.permission_revoked)]>'
    ),
    'N-02-AN-EXEMPTION-MAY-NOT-HIDE-A-LIVE-OBLIGATION': (
        'org.opentest4j.AssertionFailedError: the exemption for offline.not_sendable is stale in the direction that matters: the reachable space DOES produce it, so the claim about it is measurable and the exemption is hiding a live obligation rather than excusing an unmeasurable one'
    ),
    'N-02-AN-EXEMPTION-MUST-NAME-A-CODE-SOMETHING-CLAIMS': (
        'org.opentest4j.AssertionFailedError: offline.a_code_no_claim_mentions is exempted from the observability loop, but no claim site in this check registered it and WaitIsHonest does not license it, so the exemption is stale and the next reader will take it for a justified one: claimed = [offline.already_abandoned, offline.already_recorded, offline.already_released, offline.already_sending, offline.another_members_capture, offline.cancel_after_send, offline.no_attempt_in_flight, offline.not_sendable, offline.scope_switched]'
    ),
    'N-02-AN-EXEMPTION-WITHOUT-A-REASON-IS-NOT-AN-EXEMPTION': (
        'org.opentest4j.AssertionFailedError: offline.not_sendable is exempted with no reason given, and an exemption without a reason is the silent weakening this loop exists to make impossible'
    ),
    'O-01-A-CLAIM-WHOSE-REGISTRATION-IS-REMOVED-IS-A-CLAIM-NOTHING-BOUNDS': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]>'
    ),
    'O-01-A-LINE-THAT-LOOKS-LIKE-THE-INSTRUMENTS-IS-NOT-THE-INSTRUMENTS': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture), (a-plant/a-claim-about-a-code-nothing-produces, offline.permission_revoked)]>'
    ),
    'O-01-A-STRING-LITERAL-IS-NOT-A-COMMENT': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture), (a-plant/a-claim-about-a-code-nothing-produces, offline.permission_revoked)]>'
    ),
    'O-01-AN-ASSEMBLED-CODE-REGISTERS-THE-VALUE-IT-TESTS': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture), (a-plant/a-claim-about-a-code-nothing-produces, offline.permission_revoked)]>'
    ),
    'O-01-THE-COMPANION-S-SPELLING-IS-NOT-PART-OF-THE-GUARD': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture), (a-plant/a-claim-about-a-code-nothing-produces, offline.permission_revoked)]>'
    ),
    'O-02-A-STALE-EXEMPTION-REDDENS-WHEREVER-THE-MAP-IS-DECLARED': (
        'org.opentest4j.AssertionFailedError: offline.a_code_no_claim_mentions is exempted from the observability loop, but no claim site in this check registered it and WaitIsHonest does not license it, so the exemption is stale and the next reader will take it for a justified one: claimed = [offline.already_abandoned, offline.already_recorded, offline.already_released, offline.already_sending, offline.another_members_capture, offline.cancel_after_send, offline.no_attempt_in_flight, offline.not_sendable, offline.scope_switched]'
    ),
    'O-03-A-CLAIM-SITE-NOTHING-EVALUATES-REGISTERS-NOTHING': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]>'
    ),
    'P-01-A-REGISTRATION-PROVES-THE-SITE-RAN-NOT-THAT-THE-CLAIM-WAS-EXERCISED': (
        'org.opentest4j.AssertionFailedError: a claim this check makes was never EXERCISED: its site ran and registered, and the branch that tests the claim never did, so whatever it asserts was asserted of nothing. A site reached under a condition that excludes the cases its claim is about looks identical to a working one in every other assertion here, which is how a refusal telling a cashier that a colleague must confirm their own capture stayed green at 98 of 98 ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]>'
    ),
    # Two FRAGMENTS rather than one message, because the whole refusal holds a LINE
    # NUMBER, and a line number is a coordinate this file's own edits move: round 17
    # added one line above it and 827 became 828. The fragments carry the prose and
    # the spelling that distinguishes this proof from its neighbour, and no coordinate.
    'P-02-A-CLAIM-WRITTEN-AROUND-THE-HELPER-IS-ENROLLED-BY-NOTHING': (
        'org.opentest4j.AssertionFailedError: a refusal code is compared outside claimAbout, so whatever is claimed there is enrolled in neither registry and is asserted of nothing the moment the code stops being produced. Write it as a claim site. This is a CONVENTION CHECK and not a derivation: it can only add reds, and a spelling it does not know escapes it ==> expected: <[]> but was: <[<LINE>: when (step.code) {]>'
    ),
    'P-03-AN-ANCHOR-BOUNDS-THE-LOSS-OF-A-SITE-NOT-OF-A-CODE': (
        'org.opentest4j.AssertionFailedError: the claims this check REGISTERED are not the claims it is written to make. A pair missing from the right-hand side is a claim site nothing evaluated at all; a pair missing from the left is a claim site that was added without being written down here, so nothing bounds what else it changed ==> expected: <[(E-04/not-sendable-offers-a-button-its-reader-can-press, offline.not_sendable), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture)]> but was: <[(INV-15/a-finished-row-answers-in-its-own-terms, offline.already_abandoned), (INV-15/a-finished-row-answers-in-its-own-terms, offline.already_recorded), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.another_members_capture), (INV-9a/a-foreign-scope-is-refused-as-a-scope-problem, offline.scope_switched), (INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it, offline.another_members_capture), (a-second-lawful-site/about-the-same-code, offline.not_sendable)]>'
    ),
    'P7-L1-DEVICE-IS-NOT-AUTHORITY': (
        'org.opentest4j.AssertionFailedError: status 500 / code null produced Synced(replayed=false, law=P7-L6-A-REPLAY-IS-A-SUCCESS) — only a 2xx means the server committed (P7-L1-DEVICE-IS-NOT-AUTHORITY)'
    ),
    'P7-L1-DEVICE-IS-NOT-AUTHORITY-AT-THE-SCREEN': (
        'org.opentest4j.AssertionFailedError: a CAPTURED FINANCIAL operation is presented as recorded money (P7-L1-DEVICE-IS-NOT-AUTHORITY) ==> expected: <SYNCED> but was: <CAPTURED>'
    ),
    'P7-L10-NO-LAST-WRITE-WINS-ON-MATERIAL-STATE': (
        'org.opentest4j.AssertionFailedError: LAST_WRITE_WINS became legal for WRITE_COMMAND / FINANCIAL (P7-L10-NO-LAST-WRITE-WINS-ON-MATERIAL-STATE)'
    ),
    'P7-L11-NO-DEFAULT-EFFECT-CLASS': (
        'org.opentest4j.AssertionFailedError: Expected an exception of class app.daftar.offline.UnclassifiedCommand to be thrown, but was completed successfully.'
    ),
    'P7-L12-QUEUE-ROW-CARRIES-ITS-OWNER': (
        'org.opentest4j.AssertionFailedError: OwnerScope(tenant-1, , member-1) was accepted. Expected an exception of class java.lang.IllegalArgumentException to be thrown, but was completed successfully.'
    ),
    'P7-L13-A-PERSON-STILL-CANNOT-ACT-ON-ANOTHER-MEMBERS-CAPTURE': (
        'org.opentest4j.AssertionFailedError: Release(actingScope=tenant-1/business-1/member-bob) by another member was allowed. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L13-AN-UNRELEASED-CAPTURE-HAS-AN-EXIT': (
        'org.opentest4j.AssertionFailedError: a capture left behind by a shift change had no exit at all. Expected value to be of type <app.daftar.offline.Step$Moved (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Refused (Kotlin reflection is not available)>.'
    ),
    'P7-L13-NO-SEND-UNDER-A-SCOPE-IT-WAS-NOT-CAPTURED-UNDER': (
        'org.opentest4j.AssertionFailedError: a cross-business send was allowed. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L13-ONLY-THE-CAPTURER-CONFIRMS-A-CAPTURE': (
        'org.opentest4j.AssertionFailedError: another member confirmed a capture they cannot be shown to have witnessed. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L13-THE-BUSINESS-IS-NEVER-RELAXED': (
        'org.opentest4j.AssertionFailedError: Send(digestNow=sha256:5e4d3c2b, actingScope=tenant-1/business-2/member-alice) from tenant-1/business-2/member-alice was allowed. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L13-THE-SEND-EFFECT-CARRIES-ITS-OWN-BUSINESS': (
        "org.opentest4j.AssertionFailedError: a send carried a scope that is not the row's own: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=QUEUED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Send(digestNow=sha256:0d5f1f2b, actingScope=tenant-1/business-1/member-2) (P7-L13-NO-SEND-UNDER-A-SCOPE-IT-WAS-NOT-CAPTURED-UNDER) ==> expected: <tenant-1/business-1/member-1> but was: <tenant-1/business-1/member-2>"
    ),
    'P7-L14-AN-UNREADABLE-QUEUE-ROW-IS-REFUSED': (
        'org.opentest4j.AssertionFailedError: schema 2 was admitted. Expected an exception of class app.daftar.offline.UnreadableQueueRow to be thrown, but was completed successfully.'
    ),
    'P7-L15-NO-REENTRY-UNDER-A-NEW-KEY-BEFORE-THE-ORIGINAL-IS-SETTLED': (
        'org.opentest4j.AssertionFailedError: re-entry under a new key was permitted. Expected value to be of type <app.daftar.offline.Reentry$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Reentry$Permitted (Kotlin reflection is not available)>.'
    ),
    'P7-L15-THE-RE-ENTRY-GATE-MUST-REACH-THE-TILL': (
        'org.opentest4j.AssertionFailedError: the set of refusals that stop the till is not the set of re-entry refusals ==> expected: <[offline.original_already_committed, offline.original_unsettled, offline.absence_not_fenced, offline.prior_state_undetermined]> but was: <[offline.original_already_committed, offline.prior_state_undetermined, offline.absence_not_fenced]>'
    ),
    'P7-L16-EXPIRY-MINIMIZES-THE-PAYLOAD-NEVER-THE-OBLIGATION': (
        'org.opentest4j.AssertionFailedError: expiry cleared the local row, which is the silent loss of money this law forbids'
    ),
    'P7-L16-MINIMIZATION-MUST-NOT-MAKE-SETTLEMENT-IMPOSSIBLE': (
        'org.opentest4j.AssertionFailedError: a minimized row was queued for sending with no payload to send. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L17-AN-UNFENCED-ABSENCE-SETTLES-NOTHING': (
        'org.opentest4j.AssertionFailedError: an absence that the original can still contradict was treated as settling it. Expected value to be of type <app.daftar.offline.Reentry$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Reentry$Permitted (Kotlin reflection is not available)>.'
    ),
    'P7-L17-NOTHING-MAY-INFER-A-FENCE': (
        'org.opentest4j.AssertionFailedError: a fenced absence was inferred rather than stated by the server (P7-L17-AN-UNFENCED-ABSENCE-SETTLES-NOTHING) ==> expected: <[]> but was: <[Reconciliation.kt: status == 404) ReceiptLookup.ABSENT_FENCED]>'
    ),
    'P7-L18-THE-ORIGINAL-KEY-OUTRANKS-A-NEW-ONE': (
        'org.opentest4j.AssertionFailedError: a recoverable original was not resent under its own key when the receipt said COMMITTED. Expected value to be of type <app.daftar.offline.Reentry$UseOriginalKey (Kotlin reflection is not available)>, actual <class app.daftar.offline.Reentry$Refused (Kotlin reflection is not available)>.'
    ),
    'P7-L19-A-STALE-ROW-IS-NOT-A-CURRENT-ONE': (
        "org.opentest4j.AssertionFailedError: a restored backup's attempts == 0 was read as a fact about now (P7-L19-AN-UNVOUCHED-STORE-CANNOT-REPORT-ABSENCE) ==> expected: <UNDETERMINED> but was: <NEVER_SENT>"
    ),
    'P7-L19-AN-UNVOUCHED-STORE-CANNOT-REPORT-ABSENCE': (
        'org.opentest4j.AssertionFailedError: an install that cannot vouch for its store reported an absence, which is F-01 ==> expected: <UNDETERMINED> but was: <NONE>'
    ),
    'P7-L19-UNDETERMINED-IS-NOT-ROUTED-TO-A-REFUSAL': (
        'org.opentest4j.AssertionFailedError: (UNDETERMINED, COMMITTED, ORIGINAL_LOST) must not permit a new key. Expected value to be of type <app.daftar.offline.Reentry$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Reentry$Permitted (Kotlin reflection is not available)>.'
    ),
    'P7-L2-KEY-MINTED-AT-CAPTURE-AND-IMMUTABLE': (
        'org.opentest4j.AssertionFailedError: expected: <9f8e7d6c-5b4a-4938-8271-615243f5e6d7> but was: <9f8e7d6c-5b4a-4938-8271-615243f5e6d7-1>'
    ),
    'P7-L20-A-FINISHED-ROW-DOES-NOT-SAY-WAIT': (
        'org.opentest4j.AssertionFailedError: a DISCARDED row refused Release(actingScope=tenant-1/business-1/member-1) as offline.already_released ==> expected: <offline.already_abandoned> but was: <offline.already_released>'
    ),
    'P7-L20-A-RE-ENTRY-REFUSAL-DOES-NOT-SAY-WAIT': (
        'org.opentest4j.AssertionFailedError: re-entry refused offline.absence_not_fenced for (UNKNOWN, ABSENT_UNFENCED, ORIGINAL_LOST) and the merchant is told CANNOT_CONFIRM_ORIGINAL_ENDED / WAIT_IT_IS_IN_PROGRESS — but re-entry is reached because the local row is gone, so nothing is pending on this device to wait for (P7-L20-A-DESTRUCTION-IS-RECORDED-BEFORE-IT-HAPPENS)'
    ),
    'P7-L20-A-STOCKTAKE-IS-NOT-DENOMINATED': (
        'java.lang.IllegalArgumentException: a INVENTORY capture must state what it is worth; a destroyed row cannot be described later'
    ),
    'P7-L20-AN-ABANDONED-ROW-IS-NOT-A-SENT-ONE': (
        'org.opentest4j.AssertionFailedError: a DISCARDED row refused Release(actingScope=tenant-1/business-1/member-1) as offline.cancel_after_send, which describes a row that is still live; the merchant is then told WAIT_IT_IS_IN_PROGRESS ==> expected: <offline.already_abandoned> but was: <offline.cancel_after_send>'
    ),
    'P7-L20-THE-ERASE-CARRIES-ITS-RECORD': (
        'org.opentest4j.AssertionFailedError: the next shift was handed a bare erase, so the capture can be destroyed undescribed'
    ),
    'P7-L20-THE-KERNEL-DOES-NOT-JUDGE-A-TOTAL': (
        'java.lang.IllegalArgumentException: a FINANCIAL capture must state what it is worth; a destroyed row cannot be described later'
    ),
    'P7-L20-THE-RECORD-SAYS-WHAT-WAS-LOST': (
        'org.opentest4j.AssertionFailedError: the record cannot say how much was lost ==> expected: <12500> but was: <null>'
    ),
    'P7-L3-PAYLOAD-FROZEN-AT-CAPTURE': (
        'org.opentest4j.AssertionFailedError: Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L3-PAYLOAD-FROZEN-AT-CAPTURE-ACROSS-A-RESTORE': (
        'org.opentest4j.AssertionFailedError: Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L4-A-DEVICE-DEFECT-IS-NOT-A-MERCHANT-PROBLEM': (
        'org.opentest4j.AssertionFailedError: expected: <THIS_NEEDS_A_DEVELOPER> but was: <ESCALATE_TO_A_SUPERVISOR>'
    ),
    'P7-L4-NO-SILENT-RESOLUTION-OF-A-MATERIAL-CONFLICT': (
        'org.opentest4j.AssertionFailedError: Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L5-NO-LOCAL-DELETE-BEFORE-A-CONFIRMED-OUTCOME': (
        'org.opentest4j.AssertionFailedError: a sent sale was cancellable because it had returned to QUEUED. Expected value to be of type <app.daftar.offline.Step$Refused (Kotlin reflection is not available)>, actual <class app.daftar.offline.Step$Moved (Kotlin reflection is not available)>.'
    ),
    'P7-L6-A-REPLAY-IS-A-SUCCESS': (
        'org.opentest4j.AssertionFailedError: status 200 gave NeedsAttention(code=offline.duplicate, diverged=false, law=P7-L6-A-REPLAY-IS-A-SUCCESS)'
    ),
    'P7-L7-A-LOST-RESPONSE-RESOLVES-ONLY-BY-REPLAY': (
        'org.opentest4j.AssertionFailedError: attempt 1 gave NeedsAttention(code=offline.network, diverged=false, law=P7-L7-A-LOST-RESPONSE-RESOLVES-ONLY-BY-REPLAY)'
    ),
    # The ONE exemption, and it is a claim this file tests rather than a note:
    # this plant's harm IS nondeterminism — it replaces a derived delay with
    # `java.util.Random().nextLong()` — so the numbers in its refusal differ
    # every run, and freezing them froze one run's dice. Measured: the harvest
    # read `expected: <696> but was: <587>` and the verification run printed
    # `expected: <311> but was: <571>`, which is the new check catching its own
    # author. What is frozen is the REFUSAL; the numbers are the harm's own
    # randomness. `HARM_IS_NONDETERMINISTIC` below keeps the exemption honest
    # in both directions.
    'P7-L8-THE-DEVICE-CLOCK-IS-NOT-AUTHORITY': (
        'was not reproducible'
    ),
    'P7-L9-A-READ-CACHE-IS-REPLACED-NOT-MERGED': (
        'org.opentest4j.AssertionFailedError: a cached read of FINANCIAL state may only be replaced ==> expected: <[SERVER_REPLACES]> but was: <[SERVER_REPLACES, FIELD_MERGE]>'
    ),
    'Q-01-A-CLAIM-EXERCISED-ONCE-IS-NOT-A-CLAIM-EXERCISED-OVER-ITS-DOMAIN': (
        'org.opentest4j.AssertionFailedError: the claim at E-04/not-sendable-offers-a-button-its-reader-can-press about offline.not_sendable ran 6 times where its declared domain EVERY_PRODUCTION was reached 12 times. A claim that runs on some of its cases is asserted of the rest not at all, and a site reached under a condition that excludes the cases its claim is about registers and counts exactly like a working one until this ratio is read ==> expected: <12> but was: <6>'
    ),
    'Q-02-A-LABEL-NAMES-ONE-SITE': (
        "org.opentest4j.AssertionFailedError: the label E-04/not-sendable-offers-a-button-its-reader-can-press occurs 3 times in this file's code, and it is declared for 1 claim(s) and named by 0 cover(s), so it should occur 2 times: once for each declaration, once for each cover that names it, and once at the single site that carries it. A label on two sites makes the registry's pairs collapse, which is how a site that asserts nothing can stand in for one that does ==> expected: <2> but was: <3>"
    ),
    'Q-02-TWO-SITES-UNDER-ONE-LABEL-RUN-TWICE-THEIR-DOMAIN': (
        'org.opentest4j.AssertionFailedError: the claim at E-04/not-sendable-offers-a-button-its-reader-can-press about offline.not_sendable ran 12 times where its declared domain EVERY_PRODUCTION was reached 6 times. A claim that runs on some of its cases is asserted of the rest not at all, and a site reached under a condition that excludes the cases its claim is about registers and counts exactly like a working one until this ratio is read ==> expected: <6> but was: <12>'
    ),
    # Two FRAGMENTS rather than one message, because the whole refusal holds a LINE
    # NUMBER, and a line number is a coordinate this file's own edits move: round 17
    # added one line above it and 827 became 828. The fragments carry the prose and
    # the spelling that distinguishes this proof from its neighbour, and no coordinate.
    'Q-03-A-LOCAL-VARIABLE-IS-NOT-A-SPELLING': (
        'org.opentest4j.AssertionFailedError: a refusal code is compared outside claimAbout, so whatever is claimed there is enrolled in neither registry and is asserted of nothing the moment the code stops being produced. Write it as a claim site. This is a CONVENTION CHECK and not a derivation: it can only add reds, and a spelling it does not know escapes it ==> expected: <[]> but was: <[<LINE>: val codeHere = step.code]>'
    ),
    'R-01-A-COVER-THAT-NAMES-A-CLAIM-THAT-IS-NOT-THERE-COVERS-NOTHING': (
        'org.opentest4j.AssertionFailedError: the gap the claim at INV-9a/a-foreign-scope-is-refused-as-a-scope-problem leaves is declared to be covered by the claim at INV-9c/a-claim-that-is-not-in-this-map about offline.another_members_capture over every production, and that claim is not in CLAIMS_THIS_CHECK_MAKES with that domain, so the cover names nothing that judges those 6 productions ==> expected: <EVERY_PRODUCTION> but was: <null>'
    ),
    'R-01-A-GAP-DECLARED-EMPTY-IS-MEASURED-EMPTY-OR-IT-REDS': (
        'org.opentest4j.AssertionFailedError: the claim at INV-9a/a-foreign-scope-is-refused-as-a-scope-problem declares that nothing falls outside ON_A_FOREIGN_SCOPE_REFUSAL (every production of this code is a foreign-scope refusal), and 6 productions of offline.another_members_capture fall outside it. A reason is not a measurement ==> expected: <0> but was: <6>'
    ),
    'R-01-A-NARROW-DOMAIN-S-GAP-MUST-BE-COVERED-BY-SOMETHING-NAMED': (
        'org.opentest4j.AssertionFailedError: the claim at E-04/not-sendable-offers-a-button-its-reader-can-press is declared over WHERE_THE_ACTOR_MAY_RELEASE, which was reached 6 times, while offline.not_sendable was produced 12 times in all. The 6 productions outside it are judged by this claim not at all, and nothing in WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT names what does cover them'
    ),
    'R-01-A-NARROW-DOMAIN-WITH-NO-DECLARED-COVER-IS-A-FAILURE-BEFORE-IT-IS-MEASURED': (
        'org.opentest4j.AssertionFailedError: the claim INV-9a/a-foreign-scope-is-refused-as-a-scope-problem about offline.another_members_capture is declared over ON_A_FOREIGN_SCOPE_REFUSAL, which is narrower than every production of its code, and nothing in WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT says what covers the productions it leaves out. A narrow domain with no declared cover is a claim about part of a code and silence about the rest'
    ),
    'S-02-NARROWING-THE-PREDICATE-THAT-DEFINES-A-DOMAIN-MOVES-BOTH-COUNTS-TOGETHER': (
        'org.opentest4j.AssertionFailedError: a different number of offline.another_members_capture refusals is now classed as a foreign-scope refusal, which is the class INV-9a judges ==> expected: <1125> but was: <1110>'
    ),
    # R18-01, the eighteenth challenger's P1. Naming the predicate closed hollowing
    # of its BODY and opened hollowing of the ARGUMENT, so these five proofs arm the
    # call itself: the two dispatch branches, a branch stuck at false, a call site
    # that names the other kind, and a witness that goes missing. Their expectations
    # are the messages a harvest run printed, not sentences written here.
    'R18-01-A-CALL-SITE-CANNOT-SWAP-WHICH-JUDGMENT-A-ROW-IS-PUT-TO': (
        "org.opentest4j.AssertionFailedError: a different number of refusals was judged for telling the merchant to wait while nothing is pending, which is the judgment a narrowing of that condition removes in silence. 939 of these are the walk's own and 2 are the arms above, which go through the same helper and are counted by it like any other row ==> expected: <941> but was: <1253>"
    ),
    'R18-01-A-DISPATCH-BRANCH-CANNOT-BE-STUCK-AT-FALSE': (
        'org.opentest4j.AssertionFailedError: a QUEUED row refused offline.already_released, which tells the merchant to wait (ALREADY_CONFIRMED / WAIT_IT_IS_IN_PROGRESS) while nothing is pending: Operation(id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee, scope=tenant-1/business-1/member-1, effect=FINANCIAL, amount=12500 SAR, state=QUEUED, attempts=0, lastCode=null, replayed=false, schema=1, minimized=false) on Release(actingScope=tenant-1/business-1/member-1)'
    ),
    'R18-01-AN-ARMS-WITNESS-CANNOT-GO-MISSING-IN-SILENCE': (
        'org.opentest4j.AssertionFailedError: the walk never produced a row with nothing pending, so the arm that needs it would measure nothing'
    ),
    'R18-01-THE-TRANSMISSION-DISPATCH-CANNOT-BE-REPLACED-BY-TRUE': (
        'org.opentest4j.AssertionFailedError: put a row with 0 attempts out, the helper did not refuse the TRANSMISSION judgment, so either its dispatch no longer reads that predicate or it no longer fails on a false judgment, and every transmission judged in the walk above judged nothing'
    ),
    'R18-01-THE-WAIT-DISPATCH-CANNOT-BE-REPLACED-BY-TRUE': (
        'org.opentest4j.AssertionFailedError: put a CAPTURED row with nothing pending, the helper did not refuse the WAIT judgment, so either its dispatch no longer reads that predicate or it no longer fails on a false judgment, and every wait judged in the walk above judged nothing'
    ),
    # R18-01, the eighteenth challenger's P1. Naming the predicate closed hollowing
    # of its BODY and opened hollowing of the ARGUMENT, so these five proofs arm the
    # call itself: the two dispatch branches, a branch stuck at false, a call site
    # that names the other kind, and a witness that goes missing. Their expectations
    # are the messages a harvest run printed, not sentences written here.
    'S-1-THE-SHAPE-TRIPWIRE-CANNOT-BE-LEFT-UNARMED': (
        'org.opentest4j.AssertionFailedError: the two judgments now have the SAME per-state distribution, so the anchor above can no longer see a call site that names the other kind: swapping both sites would move every figure onto an identical one. Add a discriminator the swap cannot preserve before trusting that anchor again ==> expected: not equal but was: <{QUEUED=400, IN_FLIGHT=210, UNKNOWN_OUTCOME=330, CAPTURED=1}>'
    ),
}

# A refusal whose text a plant makes nondeterministic cannot be frozen whole,
# and an exemption nobody checks is where the next hole goes. So the exemption
# is read off the PROOFS THEMSELVES, in both directions: a law exempted whose
# plant draws nothing is a stale exemption, and a plant that draws whose law is
# not exempted is an expectation that will rot on the next run. Read from the
# objects this run holds, never from this file's text.
DRAWS_RATHER_THAN_DERIVES = re.compile(r"Random|currentTimeMillis|nanoTime|UUID\.randomUUID")
HARM_IS_NONDETERMINISTIC: frozenset[str] = frozenset(
    {"P7-L8-THE-DEVICE-CLOCK-IS-NOT-AUTHORITY"}
)


def plant_text(proof: Proof) -> str:
    """Everything a plant writes into the tree, as one string."""
    parts = [proof.find, proof.replace]
    for edit in proof.edits:
        parts.extend(edit[1:] if len(edit) == 3 else edit)
    return "\n".join(parts)


def exemption_failures(proofs: tuple[Proof, ...] | list[Proof]) -> list[str]:
    """The exemption above, measured against the plants in this run."""
    draws = {proof.law for proof in proofs if DRAWS_RATHER_THAN_DERIVES.search(plant_text(proof))}
    failures = []
    for law in sorted(HARM_IS_NONDETERMINISTIC - draws):
        failures.append(
            f"{law} is exempted from freezing the VALUES in its refusal because its plant draws "
            f"them, and this run's plant for it draws nothing — a stale exemption is a "
            f"refusal nobody is binding"
        )
    for law in sorted(draws - HARM_IS_NONDETERMINISTIC):
        failures.append(
            f"{law}'s plant draws a value rather than deriving it, so the numbers in its refusal "
            f"differ every run, and it is not in HARM_IS_NONDETERMINISTIC — a frozen "
            f"expectation holding those numbers would pass once and rot"
        )
    return failures


FAILURE_DETAIL = re.compile(r"^\s+=>\s+(.+)$")


def failures_with_details(log: str) -> dict[str, str]:
    """Each failing test, with the refusal lines the runner printed under it."""
    out: dict[str, list[str]] = {}
    current: str | None = None
    for line in log.splitlines():
        named = FAILURE_LINE.match(line)
        if named:
            current = named.group(2).strip()
            out.setdefault(current, [])
            continue
        if current is not None and (detail := FAILURE_DETAIL.match(line)):
            out[current].append(detail.group(1).strip())
    return {name: " | ".join(lines) for name, lines in out.items()}


BARE_ASSERTION = re.compile(r"[\w.]+(?:Error|Exception): expected: <[^>]*> but was: <[^>]*>")

# U-04, the seventeenth review. The rule as stated was about COORDINATES; as
# implemented it was `<\[\d+: `, which is one printing format of one check. Six
# renderings of the same coordinate were put to it and five walked through:
# `<[a, 827: ` (not first in the list), `<[827:` (no space), `at line 827`,
# `<[827] `, `File.kt:827`. So the pattern now names the SHAPES a coordinate
# takes rather than one check's current output, and the first draft of it was
# run over the whole table to make sure it reds nothing that is not one — a
# hardening that causes a false red is not hardening.
LINE_COORDINATE = re.compile(
    r"\.kt:\d+"                     # File.kt:827
    r"|\bline\s+\d+\b"              # at line 827
    r"|(?<![\w.])\d{1,6}:(?=\s|\S)"  # 827: foo  and  827:foo
    r"|(?<![\w.])\d{1,6}\]"          # 827]
)

# U-03, the same review, and it is the bill for the fragments. They bought
# freedom from the coordinate and sold the SET: `refusal_mismatch` returned None
# for a refusal listing TWO offenders, and for one listing FIVE, as long as the
# pinned one came last — and the list is ordered by line number, so any
# un-enrolled spelling at a LOWER line was invisible to F-2. The answer is the
# other half of what that review offered: NORMALISE the coordinate out and
# freeze the message WHOLE. Applied to both sides, so the comparison is
# symmetric, and the expectation then pins the whole list again.
A_COORDINATE_IN_A_LISTING = re.compile(r"(?<![\d.])\d{1,6}(?=: )")


def without_coordinates(text: str) -> str:
    """`827: foo` becomes `<LINE>: foo`, so a frozen message can pin the SET."""
    return A_COORDINATE_IN_A_LISTING.sub("<LINE>", text)


def declared_fragments(law: str) -> tuple[str, ...]:
    """What `law` declares, as fragments. A string is one fragment."""
    declared = EXPECTED_REFUSAL.get(law)
    if declared is None:
        return ()
    return (declared,) if isinstance(declared, str) else tuple(declared)


def coordinate_failures() -> list[str]:
    """No frozen expectation may hold a coordinate the subject's edits move.

    The second thing this round learned by being caught: a line NUMBER inside a
    refusal is as volatile as a drawn value, and for a worse reason — it moves
    when an unrelated line is added above it, so the expectation rots on the
    next commit rather than on the next run. Such a refusal is frozen as
    FRAGMENTS around the coordinate instead, and this refuses the whole-message
    form wherever it reappears.
    """
    failures = []
    for law in sorted(EXPECTED_REFUSAL):
        for fragment in declared_fragments(law):
            if LINE_COORDINATE.search(fragment):
                failures.append(
                    f"{law}'s expected refusal holds a line number ({fragment[-60:]!r}), which "
                    f"this file's own edits move — freeze the prose and the spelling as "
                    f"separate fragments and leave the coordinate out"
                )
    return failures


def refusal_mismatch(law: str, expect_red: str, details: dict[str, str]) -> str | None:
    """None when the named test's own refusal is the one this law declares.

    Every declared fragment must appear in ONE printed refusal. Fragments exist
    for a refusal whose middle is volatile; requiring all of them in the same
    text is what keeps two fragments from being satisfied by two different
    failures.
    """
    expected = declared_fragments(law)
    if not expected or not all(expected):
        return (
            f"{law}: no expected refusal is declared for this proof, so a red run proves the "
            f"named test failed and not WHY it failed (F-2)"
        )
    # U-03: both sides are normalised, so a message carrying a coordinate can be
    # frozen WHOLE — which is what pins the number of offenders listed.
    expected = tuple(without_coordinates(fragment) for fragment in expected)
    printed = [
        without_coordinates(text) for name, text in details.items() if expect_red in name
    ]
    if any(all(fragment in text for fragment in expected) for text in printed):
        return None
    return (
        f"{law}: '{expect_red}' failed, but not with the refusal this proof declares. "
        f"expected to contain: {expected!r}; printed: {printed or 'no refusal line at all'} "
        f"— a proof that reddens for an unrelated reason measures the test's existence, "
        f"not the law (F-2)"
    )


# F-D, the coordinator's review of `184f7d7`. This file opens by saying "every
# law in `Laws.kt` has an entry here", and nothing in it enforced that. Arrivals
# refused — an expectation for a law no proof carries is caught — but departures
# did not: removing 89 `Proof` objects TOGETHER WITH their 89 expectations, which
# is what one coherent edit to this file looks like, was `ALL 2 RED PROOFS
# SATISFIED`, exit 0, with the PASS banner naming the reduced number and nothing
# comparing it to a set. A count the file computes from itself is not a census.
#
# So the SET comes from the KERNEL: every law id declared in `Laws.kt` must
# prefix at least one proof, a proof naming a law id the kernel does not declare
# is stale, and the number of declared ids is pinned as a literal so that a
# deletion THERE cannot shrink the obligation here. Unreadable is a REFUSAL, not
# an empty set — an absent file would otherwise discharge the whole census.
LAW_ID_IN_THE_KERNEL = re.compile(r'"(P7-L\d+-[A-Z0-9-]+)"')
LAWS_THE_KERNEL_DECLARES = 20
LAWS_KT = os.path.join("src", "app", "daftar", "offline", "Laws.kt")


def kotlin_code_only(text: str) -> str:
    """`Laws.kt` with its comments removed, so a comment declares nothing.

    R19-05, the nineteenth challenge: the census matched any QUOTED id anywhere
    in the file, a comment included, and the challenger built the withdrawal an
    author would actually write -- delete the law, keep its id in a comment so
    the history reads. Both files read as twenty ids with `P7-L14` present. The
    census's own sentence is about what the kernel DECLARES, and a comment
    declares nothing.

    R20-05 and the coordinator's F-J: the first version of this knew `"`,
    backslash escapes, `//` and block comments, and nothing else. A char
    literal holding a quote (`'"'`) flipped the string state, and a raw string
    (a triple-quote delimiter) with an odd number of plain quotes inside did the
    same, so a later
    comment was not stripped -- measured on the real `Laws.kt` with law twenty
    withdrawn, census OK at 20. Raw strings and char literals are therefore
    tracked here as well. Both are scanned rather than enumerated: there is no
    list of constructs to fall behind.
    """
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith('"""', i):
            # A raw string: nothing inside it ends it but the closing triple,
            # and backslashes are not escapes there.
            j = text.find('"""', i + 3)
            out.append(text[i:n] if j == -1 else text[i:j + 3])
            i = n if j == -1 else j + 3
            continue
        if c == '"':
            out.append(c)
            i += 1
            while i < n:
                out.append(text[i])
                if text[i] == "\\" and i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
                if text[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        if c == "'":
            # A char literal, which is what F-J walked in through: `'"'` is one
            # character and not the start of a string.
            out.append(c)
            i += 1
            while i < n:
                out.append(text[i])
                if text[i] == "\\" and i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
                if text[i] == "'":
                    i += 1
                    break
                i += 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def law_ids_the_kernel_declares(root: str) -> set[str]:
    path = os.path.join(root, LAWS_KT)
    try:
        text = open(path, encoding="utf-8").read()
    except OSError as exc:
        raise CannotRead(f"{LAWS_KT} could not be read ({exc}), so the law set is unknown")
    ids = set(LAW_ID_IN_THE_KERNEL.findall(kotlin_code_only(text)))
    if len(ids) != LAWS_THE_KERNEL_DECLARES:
        raise CannotRead(
            f"{LAWS_KT} declares {len(ids)} law ids and this census is pinned to "
            f"{LAWS_THE_KERNEL_DECLARES}. A law added there needs a proof here; a law removed "
            f"there needs this number changed with its reason. Read: {sorted(ids)}"
        )
    # F-G, the coordinator's review of `85bfbf5`, second half. The pin above
    # counts IDS; everything downstream joins on the law NUMBER. Those are not
    # the same set, so a removal plus an arrival that REUSES a number keeps this
    # count at 20 while one number is covered twice and another is not declared
    # at all — a count sees reach, never content, which is the finding this file
    # has now answered at four depths. Numbers are therefore compared as a set
    # of their own, and a collision is a refusal naming both ids.
    numbers: dict[str, list[str]] = {}
    for law in sorted(ids):
        # No arm for an id with no number, and no guard for it either: this
        # census reads ids through LAW_ID_IN_THE_KERNEL, which requires
        # `P7-L<n>-`, so an unnumbered id is never READ here and a guard against
        # one could not be run. What closes that shape is ABSENCE — the id is
        # not counted, the count falls below the pin, and the pin refuses. The
        # arm below measures exactly that rather than asserting it.
        numbers.setdefault(re.match(r"(P7-L\d+)-", law).group(1), []).append(law)
    collisions = {n: laws for n, laws in numbers.items() if len(laws) > 1}
    if collisions:
        raise CannotRead(
            f"{LAWS_KT} declares two or more law ids sharing one number, so the census's join "
            f"covers one of them twice and the other never: {collisions}"
        )
    return ids


def census_failures(proofs: list[Proof], root: str = ROOT) -> list[str]:
    try:
        declared = law_ids_the_kernel_declares(root)
    except CannotRead as exc:
        return [f"THE PROOF CENSUS COULD NOT BE TAKEN, which is a refusal and not a pass: {exc}"]
    carried = {proof.law for proof in proofs}
    failures = []
    # A proof names the law's NUMBER and then says in its own words which defect
    # it plants, so the match is on `P7-L<n>-` and not on the whole declared id.
    # That is the one join between two independently written name spaces here,
    # and getting it wrong in either direction is a false red, which is not
    # hardening: the first draft of this census compared whole ids and reported
    # eighteen stale proofs and an uncovered law, all four of them wrong.
    def number(name: str) -> str | None:
        head = re.match(r"(P7-L\d+)-", name)
        return head.group(1) if head else None

    declared_numbers = {number(law) for law in declared} - {None}
    carried_numbers = {number(name) for name in carried} - {None}
    uncovered = sorted(
        law for law in declared if number(law) not in carried_numbers
    )
    if uncovered:
        failures.append(
            f"{len(uncovered)} law(s) the kernel declares carry no proof in this file, so this "
            f"file's own opening claim is false and a departure of proofs would pass unnoticed: "
            f"{uncovered}"
        )
    stale = sorted(
        name for name in carried
        if name.startswith("P7-L") and number(name) not in declared_numbers
    )
    if stale:
        failures.append(
            f"{len(stale)} proof(s) name a law id the kernel does not declare, so they describe a "
            f"law that has been renamed or removed: {stale}"
        )
    return failures


def self_test() -> int:
    """Arm every guard branch this file declares, as a SUBPROCESS of the harness.

    The families armed here are the cover rule, the refusal rules, the guard-branch
    census itself and the interpreter/shell isolation pins. The number of branches is
    not written in this sentence, because a sentence cannot be made to red: the arm
    below compares the length of `checks` to GUARD_BRANCHES_THIS_HARNESS_DECLARES and
    refuses by name on any difference, in either direction, so an arm added or removed
    without the declaration moving reds this self-test rather than passing quietly.

    The coordinator's review of `771b525` proved the `did not redden` branch by
    DELETING it, and recorded that no plant reaches it. A plant cannot: the
    guards live in this file, and this file is the instrument rather than the
    subject. So they are armed here, and `main` runs this as its own first step
    through a separate interpreter — never by importing it, because a gate
    inside the set it measures has to run as a subprocess.
    """
    cover = ("INV-9c/x", "offline.c")
    other = ("DECOY/x", "offline.c")
    checks: list[tuple[str, bool]] = []

    def expect(name: str, ok: bool) -> None:
        checks.append((name, ok))

    with_entry = dict(A_PROOF_DEFENDS_THIS_COVER)
    with_entry[cover] = "SOME-LAW"
    globals()["A_PROOF_DEFENDS_THIS_COVER"] = with_entry
    expect(
        "a declared cover the run never printed is a refusal (F-1: omission)",
        any("F-1: omission" in f for f in cover_failures(set(), {cover}, {"SOME-LAW"})),
    )
    expect(
        "a printed cover no declaration contains is a refusal (F-1: forgery)",
        any("F-1: forgery" in f for f in cover_failures({cover}, set(), {"SOME-LAW"})),
    )
    expect(
        "a printed and declared cover with a reddened proof is clean",
        cover_failures({cover}, {cover}, {"SOME-LAW"}) == [],
    )
    expect(
        "a cover no proof is declared to defend is a refusal",
        any("no proof in this file is declared" in f for f in cover_failures({other}, {other}, set())),
    )
    expect(
        "a cover whose proof did not redden is a refusal",
        any("did not redden" in f for f in cover_failures({cover}, {cover}, set())),
    )
    globals()["A_PROOF_DEFENDS_THIS_COVER"] = {
        k: v for k, v in with_entry.items() if k != cover
    }
    expect(
        "an unreadable declaration REFUSES rather than reading as zero covers",
        _refuses_to_read(),
    )
    expect(
        "a readable declaration of one cover reads as that one cover",
        covers_the_source_declares(_SAMPLE_SOURCE) == {("INV-9c/x", "offline.c")},
    )
    globals()["EXPECTED_REFUSAL"] = {"SOME-LAW": "the number this law is about"}
    expect(
        "a named test failing with the declared refusal is clean (F-2)",
        refusal_mismatch("SOME-LAW", "SomeTest", {"SomeTest:a case": "the number this law is about"})
        is None,
    )
    expect(
        "a named test failing with some OTHER refusal is a refusal (F-2)",
        (refusal_mismatch("SOME-LAW", "SomeTest", {"SomeTest:a case": "never EXERCISED"}) or "")
        .find("F-2") > 0,
    )
    expect(
        "a law with no declared refusal is a refusal (F-2)",
        (refusal_mismatch("NO-ENTRY", "SomeTest", {"SomeTest:a case": "anything"}) or "")
        .find("F-2") > 0,
    )

    globals()["EXPECTED_REFUSAL"] = {"COORD": "but was: <[827: when (step.code) {]>"}
    expect(
        "a frozen expectation holding a line number is a refusal",
        any("holds a line number" in f for f in coordinate_failures()),
    )
    globals()["EXPECTED_REFUSAL"] = {"FRAGS": ("but was: <[", "when (step.code) {]>")}
    expect(
        "the same refusal frozen as fragments around the coordinate is clean",
        coordinate_failures() == [],
    )
    expect(
        "every fragment must appear in ONE printed refusal",
        refusal_mismatch("FRAGS", "T", {"T:c": "but was: <[828: when (step.code) {]>"}) is None
        and refusal_mismatch("FRAGS", "T", {"T:c": "but was: <[828: val x = y]>"}) is not None,
    )

    drawn = Proof(
        law="DRAWN", path="p", find="val a = derived()",
        replace="val a = java.util.Random().nextLong()", expect_red="t", why="w",
    )
    derived = Proof(
        law="P7-L8-THE-DEVICE-CLOCK-IS-NOT-AUTHORITY", path="p", find="val a = derived()",
        replace="val a = alsoDerived()", expect_red="t", why="w",
    )
    expect(
        "a plant that DRAWS its values with no exemption is a refusal",
        any("would pass once and rot" in f for f in exemption_failures([drawn])),
    )
    expect(
        "an exemption whose plant draws nothing is a refusal",
        any("stale exemption" in f for f in exemption_failures([derived])),
    )
    expect(
        "the exempted law's own drawing plant is clean",
        exemption_failures(
            [Proof(law="P7-L8-THE-DEVICE-CLOCK-IS-NOT-AUTHORITY", path="p",
                   find="val a = derived()", replace="val a = java.util.Random().nextLong()",
                   expect_red="t", why="w")]
        ) == [],
    )

    # U-03's arms. The fragments used to pass a refusal listing TWO offenders,
    # or five, as long as the pinned one came last — and the list is ordered by
    # line number, so an un-enrolled spelling at a LOWER line was invisible.
    # Now that the message is frozen whole with the coordinate normalised, the
    # SET is pinned again: one offender matches, two do not.
    one = (
        "org.opentest4j.AssertionFailedError: a refusal code is compared outside claimAbout "
        "==> expected: <[]> but was: <[868: val codeHere = step.code]>"
    )
    two = one.replace(
        "<[868: val codeHere = step.code]>",
        "<[12: when (step.code) {, 868: val codeHere = step.code]>",
    )
    globals()["EXPECTED_REFUSAL"] = dict(EXPECTED_REFUSAL)
    EXPECTED_REFUSAL["SET-PIN-ARM"] = without_coordinates(one)
    expect(
        "a whole frozen message matches the refusal it was frozen from",
        refusal_mismatch("SET-PIN-ARM", "t", {"t": one}) is None,
    )
    expect(
        "a refusal listing a SECOND offender no longer matches (U-03)",
        refusal_mismatch("SET-PIN-ARM", "t", {"t": two}) is not None,
    )
    expect(
        "the coordinate is normalised on both sides, so neither side's line number matters",
        refusal_mismatch("SET-PIN-ARM", "t", {"t": one.replace("868:", "1204:")}) is None,
    )
    del EXPECTED_REFUSAL["SET-PIN-ARM"]

    # F-D's arms: the census must refuse a DEPARTURE, refuse a proof naming a
    # law the kernel does not declare, refuse an unreadable law file rather than
    # treat it as an empty obligation, and pass clean on the file as it stands.
    expect(
        "the census refuses when proofs have departed",
        any("carry no proof in this file" in f for f in census_failures(PROOFS[:2])),
    )
    expect(
        "the census refuses a proof naming a law the kernel does not declare",
        any(
            "name a law id the kernel does not declare" in f
            for f in census_failures(
                PROOFS + [Proof(law="P7-L99-A-LAW-THE-KERNEL-NEVER-DECLARED", path="p",
                                find="a", replace="b", expect_red="t", why="w")]
            )
        ),
    )
    expect(
        "an unreadable law file is a refusal, not an empty obligation",
        any("COULD NOT BE TAKEN" in f for f in census_failures(PROOFS, root="/nonexistent-p7")),
    )
    expect(
        "the census passes on the law set and proofs as they stand",
        census_failures(PROOFS) == [],
    )

    # F-A's arm, and it is the only branch here that measures something OUTSIDE
    # this file's own functions: the isolation refusal is a property of how this
    # file is STARTED, so the only way to test it is to start it. Both
    # directions, by REFUSAL NAME rather than by exit code, because a code is
    # exactly what the fail-open destroyed.
    me = os.path.abspath(__file__)
    loose = subprocess.run(
        [sys.executable, me, "--isolation-probe"],
        capture_output=True, text=True, env=env_for_a_child(),
    )
    expect(
        "started without -I, this harness refuses BY NAME",
        "REFUSED-P7-HARNESS-NOT-ISOLATED" in loose.stdout and loose.returncode != 0,
    )
    tight = subprocess.run(
        [sys.executable, "-I", me, "--isolation-probe"],
        capture_output=True, text=True, env=env_for_a_child(),
    )
    expect(
        "started with -I, the refusal does not fire and the probe answers",
        "REFUSED-P7-HARNESS-NOT-ISOLATED" not in tight.stdout
        and "P7-ISOLATION-PROBE: isolated" in tight.stdout
        and tight.returncode == 0,
    )
    # F-H's arm, and the reason the bound is a counter the children CARRY
    # rather than an early return: a depth marker can be set directly, so this
    # branch measures the refusal without spawning a single extra process. The
    # review's objection to the early-exit block was exactly that arming it
    # meant running the recursion.
    too_deep = subprocess.run(
        [sys.executable, "-I", me, "--isolation-probe"],
        capture_output=True, text=True,
        env=dict(os.environ, **{SPAWN_DEPTH_ENV: str(DEEPEST_LEGITIMATE_SPAWN + 1)}),
    )
    expect(
        "a spawn deeper than the legitimate chain refuses BY NAME (F-H)",
        "REFUSED-P7-HARNESS-SPAWNED-ITSELF" in too_deep.stdout
        and too_deep.returncode != 0,
    )
    expect(
        "at the legitimate depth the probe still answers, so the bound is not a false red (F-H)",
        too_deep_to_be_anything_but_a_fork() is None
        and "P7-ISOLATION-PROBE: isolated" in subprocess.run(
            [sys.executable, "-I", me, "--isolation-probe"],
            capture_output=True, text=True,
            env=dict(os.environ, **{SPAWN_DEPTH_ENV: str(DEEPEST_LEGITIMATE_SPAWN)}),
        ).stdout,
    )
    # F-G's arms. The count pin and the number collision are both put a planted
    # `Laws.kt` and required to refuse BY the CannotRead they raise, because a
    # pin nothing exercises is a sentence — which is the finding.
    def laws_kt_holding(ids: list[str]) -> str:
        tree = a_tree("p7-census-arm-")
        path = os.path.join(tree, LAWS_KT)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        body = "\n".join(f'    val L{i} = Law("{law}")' for i, law in enumerate(ids))
        open(path, "w", encoding="utf-8").write("object P7Laws {\n" + body + "\n}\n")
        return tree

    twenty = [f"P7-L{n}-A-LAW-THIS-ARM-DECLARES" for n in range(1, 21)]
    def census_refusal(ids: list[str]) -> str:
        try:
            law_ids_the_kernel_declares(laws_kt_holding(ids))
        except CannotRead as exc:
            return str(exc)
        return ""

    expect(
        "the law COUNT pin refuses an arrival, so the pin is armed (F-G)",
        "pinned to" in census_refusal(twenty + ["P7-L21-ONE-LAW-TOO-MANY"]),
    )
    expect(
        "the law COUNT pin refuses a departure too (F-G)",
        "pinned to" in census_refusal(twenty[:-1]),
    )
    expect(
        "two law ids sharing ONE number is a refusal, which no count can see (F-G)",
        # TWENTY ids, not twenty-one: the count pin refuses first otherwise and
        # the arm measures the count rather than the collision, which is the
        # very confusion F-G is about. L19 is declared twice and L20 not at all.
        "sharing one number" in census_refusal(
            twenty[:-2] + ["P7-L19-THE-NINETEENTH", "P7-L19-THE-NINETEENTH-AGAIN"]
        ),
    )
    expect(
        "an id carrying no number is not read at all, and the COUNT is what refuses (F-G)",
        # The pair to the arm above. There the count cannot see the defect and
        # the numbers must; here the numbers never see the id and the count
        # must. Both halves of `a count sees reach, never content` are measured.
        (lambda refusal: "pinned to" in refusal and "LAWLESS" not in refusal)(
            census_refusal(twenty[:-1] + ["LAWLESS-ID-WITH-NO-P7-NUMBER"])
        ),
    )
    expect(
        "the arms' own planted file of twenty well-formed ids READS, so none of this is vacuous",
        census_refusal(twenty) == "",
    )
    # And the WRAPPER, pinned by bytes rather than by a regex over its text: a
    # pattern says the flag APPEARS somewhere, and only byte equality says the
    # command the wrapper runs is the whole command it runs. The refusal above
    # makes a wrapper without `-I` fail closed; this makes a wrapper EDITED to
    # drop the flag a refusal here as well, which is the half a reader of the
    # wrapper alone would miss.
    wrapper = os.path.join(os.path.dirname(me), "red-proofs.sh")
    try:
        wrapper_text = open(wrapper, encoding="utf-8").read()
    except OSError:
        wrapper_text = ""
    # The pin reads the wrapper's CODE lines, not its prose: a "must not
    # contain" over the whole file trips on a comment that quotes the very
    # mistake it describes, which is a false red, and a hardening that causes a
    # false red is not hardening. So: exactly one `exec` among the code lines,
    # and that line byte-equal to the pinned one.
    execs = [
        line for line in wrapper_code_lines(wrapper_text) if line.startswith("exec ")
    ]
    # R18-02, the eighteenth challenge. `"PY=/usr/bin/python3" in wrapper_code`
    # asked whether that assignment APPEARS among the code lines. Measured by
    # that review: one line added after it, assigning a different interpreter,
    # left this line and the `exec` line byte-identical and the guard GREEN at
    # 27 of 27, while the wrapper then ran the planted interpreter — its own
    # line was in the output. A membership test is the same mistake one layer
    # down from the regex this file already refuses: a pattern says a command
    # appears, and only byte equality over the WHOLE SET says it is all that
    # runs. So the assignments are compared as a set of exactly one, which also
    # closes the `export PY=`, `readonly PY=` and indented variants.
    expect(
        "the wrapper runs the pinned interpreter in isolated mode, verbatim and once",
        the_wrapper_pin_holds(wrapper_text),
    )
    # And the pin's own arms, because a pin whose failure nothing exercises is a
    # sentence. The first is R18-02's plant verbatim: one line added below the
    # pinned assignment, with that line and the `exec` line untouched.
    expect(
        "a SECOND PY= assignment below the pinned one is a refusal (R18-02)",
        not the_wrapper_pin_holds(
            wrapper_text.replace(
                "PY=/usr/bin/python3",
                "PY=/usr/bin/python3\nPY=/tmp/not-the-pinned-interpreter",
                1,
            )
        ),
    )
    expect(
        "an exported or indented second assignment is a refusal too (R18-02)",
        not the_wrapper_pin_holds(wrapper_text + "\n  export PY=/tmp/not-the-pinned-interpreter\n")
        and not the_wrapper_pin_holds(wrapper_text + "\nreadonly PY=/tmp/not-the-pinned-interpreter\n"),
    )
    # R19-01's arms: the three shapes the challenger walked past the old
    # SHAPE LIST with, each a single added line that `.strip()` leaves starting
    # with something the regex did not recognise. Under byte equality each is
    # simply a line the pinned code does not have.
    for _shape, _line in (
        ("a compound command on one line", 'true; PY=/tmp/not-the-pinned-interpreter'),
        ("an `if` wrapper", 'if true; then PY=/tmp/not-the-pinned-interpreter; fi'),
        ("a brace group", '{ PY=/tmp/not-the-pinned-interpreter; }'),
    ):
        expect(
            f"a second assignment hidden behind {_shape} is a refusal (R19-01)",
            not the_wrapper_pin_holds(
                wrapper_text.replace(
                    "PY=/usr/bin/python3", "PY=/usr/bin/python3\n" + _line, 1
                )
            ),
        )
    # And the other direction, because a pin that reds on prose is a false red
    # and a hardening causing one is not hardening: a comment added or changed
    # is NOT a difference, which is the whole reason the pin reads code lines.
    expect(
        "a comment added to the wrapper is not a refusal (R19-01)",
        the_wrapper_pin_holds(
            wrapper_text.replace(
                "PY=/usr/bin/python3",
                "# a comment that even quotes PY=/tmp/not-the-pinned-interpreter\nPY=/usr/bin/python3",
                1,
            )
        ),
    )
    # R20-01's arm. The shebang is the line the old rule dropped, so it gets an
    # arm of its own: changing the program that interprets the file is a
    # difference, and the two prose arms above must still be green, which is
    # what makes the first-line exception positional rather than another shape.
    expect(
        "an edited SHEBANG is a refusal, because line one decides what runs (R20-01)",
        not the_wrapper_pin_holds(
            wrapper_text.replace("#!/bin/bash -p", "#!/tmp/not-the-pinned-shell", 1)
        )
        # R21-01's own shape: dropping back to a PATH-resolved interpreter is a
        # difference, because `env` chooses `bash` through `PATH` and a forged
        # `bash` earlier on it forges the whole verdict without reading a byte
        # of this file.
        and not the_wrapper_pin_holds(
            wrapper_text.replace("#!/bin/bash -p", "#!/usr/bin/env -S bash -p", 1)
        )
        # And dropping `-p` alone, which is the privileged flag the rest of the
        # file's defences assume.
        and not the_wrapper_pin_holds(
            wrapper_text.replace("#!/bin/bash -p", "#!/bin/bash", 1)
        ),
    )
    expect(
        "the pinned assignment REMOVED is a refusal, so the pin is not vacuous (R18-02)",
        not the_wrapper_pin_holds(wrapper_text.replace("PY=/usr/bin/python3\n", "", 1)),
    )
    expect(
        "every line the self-test child prints is marked as the child's (R18-03)",
        marked_as_the_childs("SELF-TEST: 1 of 1 guard branches armed.\nTREES: 0 made\n")
        == "[self-test] SELF-TEST: 1 of 1 guard branches armed.\n[self-test] TREES: 0 made\n"
        and marked_as_the_childs("") == ""
        and "\n" not in marked_as_the_childs("one line").rstrip("\n"),
    )
    # F-I's arms. The first is the "derive the set from the other side" shape
    # that closed F-G: one tree is planted under EVERY prefix the tuple
    # declares, and the census must return all of them. A prefix the census
    # cannot see therefore reds here, rather than on a disk nobody is watching.
    # These go through `an_arms_tree` and not through `a_tree`, because
    # `a_tree` registers a tree as THIS run's and the census excludes this
    # run's trees by design; what is measured here is which PREFIXES the
    # census recognises. `an_arms_tree` therefore keeps them visible to the
    # census while still registering them for scrubbing, which is R20-03's
    # correction of five sites that used to call `mkdtemp` with nothing
    # tracking the result. They are scrubbed immediately and are counted as
    # neither made nor left.
    planted_one_each = [an_arms_tree(prefix) for prefix in TREE_PREFIXES]
    censused = set(strays_from_earlier_runs())
    for stray in planted_one_each:
        scrub(stray)
    expect(
        "the stray census returns a tree under EVERY prefix this harness creates under (F-I)",
        censused >= set(planted_one_each),
    )

    def a_tree_outside_the_tuple() -> str:
        try:
            a_tree("p7-not-in-the-tuple-")
        except CannotRead as exc:
            return str(exc)
        return ""

    expect(
        "a tree asked for under a prefix the census does not know is REFUSED by name (F-I)",
        "REFUSED-P7-TREE-PREFIX-NOT-CENSUSED" in a_tree_outside_the_tuple(),
    )
    # S-4's arms. These three verdicts used to be inline branches in
    # `__main__`, outside this census; the coordinator's point was that being
    # reachable is not being counted, which is F-G one layer out. Every branch
    # of each is armed here, including the ones that must stay SILENT, because a
    # verdict that refuses when nothing is wrong is a false red and this
    # harness's own rule is that a hardening causing one is not hardening.
    #
    # Coord F-Q, recorded rather than papered over: the three prediction arms
    # below are fed `one_runs_worth_of_trees()`'s OWN output as their expected
    # figure, so what they certify is the COMPARISON and its refusal name, not
    # the figure. An arm fed the derivation's own output cannot contradict the
    # derivation. The figure itself is bounded by the real run, where the same
    # function's value is compared against a count of trees LISTED on disk, and
    # by review of the one line that derives it — not by anything below.
    _one_run = one_runs_worth_of_trees()
    _some = [f"/tmp/p7-proof-{i}-x" for i in range(_one_run)]
    expect(
        "a clean run says nothing about leftovers (S-4)",
        the_leftover_verdict([]) is None,
    )
    expect(
        "a tree this run made and failed to remove is a refusal BY NAME (S-4)",
        (lambda v: v is not None and v[1] and "REFUSED-P7-TREES-LEFT-BEHIND" in v[0])(
            the_leftover_verdict(["/tmp/p7-proof-0-left"])
        ),
    )
    expect(
        "the derived tree figure equals the literal declared for it, which is the one check "
        "an arm fed the derivation's own output cannot make (F-Q)",
        one_runs_worth_of_trees() == ONE_RUNS_TREES_DECLARED,
    )
    expect(
        "a tree count equal to the derived figure says nothing (S-4 / F-I)",
        the_prediction_verdict(_one_run, False, 0) is None,
    )
    expect(
        "a tree count unequal to the derived figure is a refusal BY NAME (S-4 / F-I)",
        (lambda v: v is not None and v[1]
         and "REFUSED-P7-TREE-COUNT-PREDICTION-STALE" in v[0])(
            the_prediction_verdict(_one_run - 1, False, 0)
        ),
    )
    expect(
        "the self-test child is not compared against a main run's tree count (S-4 / F-I)",
        the_prediction_verdict(5, True, 0) is None,
    )
    expect(
        "a run that already failed is not compared either, its counter predicting nothing (S-4)",
        the_prediction_verdict(_one_run - 1, False, 1) is None,
    )
    expect(
        "no strays on disk means no sentence about strays (S-4)",
        the_strays_verdict([]) is None,
    )
    expect(
        "strays below one run's worth are a NOTE and do NOT block (S-4)",
        (lambda v: v is not None and not v[1] and v[0].startswith("NOTE:"))(
            the_strays_verdict(_some[: _one_run - 1])
        ),
    )
    expect(
        "strays at one whole run's worth REFUSE by name and block (S-4)",
        (lambda v: v is not None and v[1]
         and "REFUSED-P7-TEMP-DIRECTORY-FILLING" in v[0])(the_strays_verdict(_some)),
    )
    # R19-02's arms. The mid-run signal itself cannot be a branch here — a
    # handler that re-raises the signal with its default disposition ends the
    # process — so it is measured as a control outside the self-test and
    # recorded in the evidence. What IS armed here is each mechanism the fix
    # rests on: the stop flag, and a listing that sees a tree whoever made it.
    _not_this_runs = an_arms_tree("p7-proof-not-this-runs-")
    expect(
        "the directory listing sees a tree this run never registered (R19-02)",
        _not_this_runs in trees_on_disk() and _not_this_runs not in TREES_THIS_RUN,
    )
    scrub(_not_this_runs)
    expect(
        "and stops seeing it once it is gone, so the listing is a listing (R19-02)",
        _not_this_runs not in trees_on_disk(),
    )

    def how_a_tree_refuses() -> str:
        try:
            a_tree("p7-census-arm-")
        except CannotRead as exc:
            return str(exc)
        return ""

    def a_tree_after_the_end() -> str:
        _NO_MORE_TREES.set()
        try:
            a_tree("p7-census-arm-")
        except CannotRead as exc:
            return str(exc)
        finally:
            _NO_MORE_TREES.clear()
        return ""

    expect(
        "once a signal has ended the run, a further tree is REFUSED by name (R19-02)",
        "REFUSED-P7-TREE-AFTER-THE-RUN-WAS-ENDED" in a_tree_after_the_end(),
    )
    expect(
        "and with the flag clear a tree is made again, so the flag is not a one-way door "
        "that would make this arm vacuous (R19-02)",
        (lambda tree: (tree.startswith(tempfile.gettempdir()), scrub(tree))[0])(
            a_tree("p7-census-arm-")
        ),
    )

    # R19-03's arms, run as children because the refusal is at module level and
    # ends the process. The pair matters: a value that cannot be read refuses by
    # name, and the values that CAN be read are still read, or the refusal is a
    # false red and this harness's rule is that such a hardening is not
    # hardening.
    def depth_run(value: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-I", me, "--isolation-probe"],
            capture_output=True, text=True,
            env=dict(os.environ, **{SPAWN_DEPTH_ENV: value}),
        )

    expect(
        "a spawn depth that is not a whole number is REFUSED by name, not a traceback (R19-03)",
        all(
            "REFUSED-P7-SPAWN-DEPTH-UNREADABLE" in depth_run(bad).stdout
            and "Traceback" not in depth_run(bad).stderr
            # An EMPTY variable is not an unreadable one: `or "0"` reads it as
            # not set, which is what an unset variable means, and refusing it
            # would be a false red. Measured: the probe answers normally.
            for bad in ("abc", "3.0", "1e2", "0x3", "three")
        ),
    )
    expect(
        "an EMPTY depth variable is read as not set, not refused (R19-03)",
        "P7-ISOLATION-PROBE: isolated" in depth_run("").stdout,
    )
    expect(
        "the readable forms of a legitimate depth are still read, not refused (R19-03)",
        all(
            "P7-ISOLATION-PROBE: isolated" in depth_run(good).stdout
            for good in ("2", "+2", "02", " 2 ")
        ),
    )
    # Coord F-T's arm. `int()` accepts a sign, so closing R20-04 by construction
    # widened the set downward: at the head before this one `-1000000` was READ
    # as a depth, the cap was false, and the child was handed -999,999.
    expect(
        "a NEGATIVE spawn depth is refused by name, since a depth is a count of spawns "
        "(F-T)",
        all(
            "REFUSED-P7-SPAWN-DEPTH-NEGATIVE" in depth_run(below).stdout
            and "Traceback" not in depth_run(below).stderr
            for below in ("-1", "-1000000", "-0001")
        ),
    )
    expect(
        "and `-0` is zero, not a negative, so the refusal is not a false red (F-T)",
        "P7-ISOLATION-PROBE: isolated" in depth_run("-0").stdout,
    )

    # R19-05's arm. The id is in a comment, where nothing is declared, so the
    # census must read nineteen and refuse — and the control beside it is the
    # same file with the comment removed entirely, which must also read
    # nineteen, so the arm is measuring the comment and not the deletion.
    def laws_kt_text(body: str) -> str:
        tree = a_tree("p7-census-arm-")
        path = os.path.join(tree, LAWS_KT)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w", encoding="utf-8").write(body)
        return tree

    _nineteen = "\n".join(
        f'    val L{n} = Law("P7-L{n}-A-LAW-THIS-ARM-DECLARES")' for n in range(1, 20)
    )
    def how_the_census_refuses(body: str) -> str:
        try:
            law_ids_the_kernel_declares(laws_kt_text(body))
        except CannotRead as exc:
            return str(exc)
        return ""

    expect(
        "a law id left behind in a COMMENT declares nothing, and the census refuses (R19-05)",
        "pinned to" in how_the_census_refuses(
            "object P7Laws {\n" + _nineteen
            + '\n    // Withdrawn for now; the id is kept here so the history reads:\n'
            + '    // "P7-L20-THE-WITHDRAWN-ONE"\n}\n'
        ),
    )
    expect(
        "a `//` inside a STRING is not treated as a comment, so a declaration AFTER it on the "
        "same line survives (R19-05, armed properly per F-K)",
        # F-K, the coordinator's review of `72e6af4`: the first version of this
        # arm put the id BEFORE the `//`, so deleting the string tracking left
        # the arm green -- an arm that passes without the branch it names. The
        # id is now the second argument, AFTER a `//` inside the first string,
        # so without the tracking the rest of the line is read as a comment,
        # the count falls to nineteen and the census refuses.
        len(
            law_ids_the_kernel_declares(
                laws_kt_text(
                    "object P7Laws {\n" + _nineteen
                    + '\n    val L20 = Law("see http://x // and here", "P7-L20-DECLARED-AFTER-A-SLASH-SLASH")\n}\n'
                )
            )
        ) == 20,
    )
    expect(
        "an id inside a BLOCK comment declares nothing either, so that branch is armed too "
        "(F-K)",
        "pinned to" in how_the_census_refuses(
            "object P7Laws {\n" + _nineteen
            + '\n    /* withdrawn: "P7-L20-THE-WITHDRAWN-ONE" */\n}\n'
        ),
    )
    expect(
        "a CHAR LITERAL holding a quote does not flip the string state, so a comment after it "
        "is still stripped (R20-05 / F-J)",
        "pinned to" in how_the_census_refuses(
            "object P7Laws {\n" + _nineteen
            + '\n    val quote = \'"\'\n    // withdrawn: "P7-L20-THE-WITHDRAWN-ONE"\n}\n'
        ),
    )
    expect(
        "a RAW STRING with an odd number of plain quotes inside does not flip it either "
        "(R20-05 / F-J)",
        "pinned to" in how_the_census_refuses(
            "object P7Laws {\n" + _nineteen
            + '\n    val raw = """a " b"""\n    // withdrawn: "P7-L20-THE-WITHDRAWN-ONE"\n}\n'
        ),
    )
    expect(
        "and a declaration INSIDE a raw string is still a declaration, so none of the three "
        "above is a false red (R20-05)",
        len(
            law_ids_the_kernel_declares(
                laws_kt_text(
                    "object P7Laws {\n" + _nineteen
                    + '\n    val L20 = Law("P7-L20-DECLARED-BESIDE-A-RAW-STRING", """a " b""")\n}\n'
                )
            )
        ) == 20,
    )
    # F-L's arms. Until this round the signal handler's three mechanisms were
    # armed and its CALLER was not: three one-line edits to the handler -- the
    # figure taken from the list again, the stop flag deleted, the lock removed
    # -- each left the self-test green. `stop_then_scrub_and_report` is a
    # function for exactly this reason, and these read what it returns.
    _handler_mine = a_tree("p7-census-arm-")
    # This one stays deliberately UNregistered: the arm below measures that the
    # handler leaves alone a tree that is not this run's, and registering it
    # would make it this run's and destroy the thing being measured. The
    # residual that buys, named rather than hidden: a signal arriving between
    # this line and the `scrub` after the arms leaves this one tree behind. The
    # handler's own report then counts it on disk and attributes it correctly to
    # nobody, which is the outcome R19-02 asked for, so what is lost is one
    # directory, not a figure.
    _handler_foreign = tempfile.mkdtemp(prefix="p7-proof-someone-elses-")
    # R21-04: a tree named the way this run's self-test child names its own.
    # Unregistered here on purpose -- the point is attribution by the NONCE this
    # process issued, not by a registry it could have consulted.
    _childs_tree = tempfile.mkdtemp(prefix="p7-proof-" + THE_TAG_I_HAND_MY_CHILD + "-")
    _handler_said = stop_then_scrub_and_report(15)
    # R21-03 / coord F-U: the flag the handler set stays SET across the arms
    # below, because one of them reads it. It used to be cleared here, one line
    # after the call, and the arm that named it then set the flag itself and
    # cleared it again -- so it measured `a_tree`'s check, which has had its own
    # arm since round 19, and said nothing about whether the handler sets
    # anything. Deleting `_NO_MORE_TREES.set()` from the handler left the whole
    # self-test green at 78 of 78, reproduced here before this was changed.
    # This is `R18-01` again, inside the arm raised to answer it: an instrument
    # fed its own input certifies the mechanism and never the path the run
    # travels. The clear now happens AFTER the last arm that reads the flag.
    expect(
        "the signal report counts the DIRECTORY, not the list it was handed (F-L / R19-02)",
        f"holds {len(trees_on_disk())} tree(s)" in _handler_said,
    )
    # R21-05: this used to pin the literal sentence `of which 0 are this run's
    # and 1 are not`, which carries a count of OTHER people's trees. One stray
    # left in the temp directory by any earlier killed run -- the ordinary
    # condition this harness has a census and a threshold for -- made this arm
    # red and stopped every proof, four lines after another arm saying a stray
    # below one run's worth does not block. A hardening that causes a false red
    # is not hardening, so what is asserted now is the PARTITION: the three
    # numbers account for the listing exactly, whatever else is on disk.
    _said_numbers = re.search(
        r"holds (\d+) tree\(s\) under this harness's prefixes, of which (\d+) are this "
        r"process's, (\d+) were made by this run's self-test child and (\d+) are neither",
        _handler_said,
    )
    expect(
        "the report's three ownership numbers account for the listing exactly, whatever else "
        "is on disk (R20-03 / R21-05)",
        _said_numbers is not None
        and int(_said_numbers.group(1))
        == int(_said_numbers.group(2)) + int(_said_numbers.group(3)) + int(_said_numbers.group(4)),
    )
    expect(
        "a tree that is nobody's is counted as neither, by name and not by a leftover phrase "
        "(R20-03)",
        os.path.basename(_handler_foreign) in _handler_said
        and "Neither: [" in _handler_said,
    )
    expect(
        "a tree carrying the nonce this run handed its self-test child is attributed to the "
        "CHILD and not to a stranger (R21-04)",
        (lambda report: f"The self-test child's: ['{_childs_tree}']" in report)(
            stop_then_scrub_and_report(15)
        ),
    )
    expect(
        "a truncated enumeration says how many it is showing, so a reader can reconcile it "
        "with the count (F-V)",
        first_few("L", [str(i) for i in range(7)]).endswith("(first 5 of 7)."),
    )
    expect(
        "and a complete enumeration carries no marker, because one on a complete list is "
        "noise (F-V)",
        first_few("L", ["a", "b"]) == "L: ['a', 'b'].",
    )
    expect(
        "it removed the tree this run had registered, including an arm's own (F-L / R20-03)",
        not os.path.exists(_handler_mine),
    )
    expect(
        "it did NOT remove a tree that is not this run's, which is not its to delete (F-L)",
        os.path.exists(_handler_foreign),
    )
    expect(
        "and the HANDLER stopped the creators: the flag it set is read, not set here, and a "
        "tree asked for now is refused by name (F-L / R21-03)",
        _NO_MORE_TREES.is_set()
        and "REFUSED-P7-TREE-AFTER-THE-RUN-WAS-ENDED" in how_a_tree_refuses(),
    )
    _NO_MORE_TREES.clear()
    scrub(_handler_foreign)
    scrub(_childs_tree)

    # R20-02's arms. The subject here is the SHELL, not this file, so each one
    # runs the wrapper as a child with a hijacked environment and reads what
    # comes back. `--isolation-probe` is used rather than `--self-test`, because
    # the self-test spawning its own wrapper is the recursion F-H exists to
    # refuse. The hijack is the challenge's own: a function named after the
    # builtin the wrapper uses to hand over to Python.
    hijack_function = 'exec() { echo P7-HIJACKED-EXEC-RAN; }'
    wrapper_path = os.path.join(os.path.dirname(me), "red-proofs.sh")

    def through_the_wrapper(argv: list[str], **env: str | None) -> str:
        # A value of None REMOVES the key, which R21-02 made necessary: a
        # privileged bash exports `SHELLOPTS` containing `privileged`, so a
        # child started as `bash <path>` from inside this run is privileged by
        # inheritance. An arm that means to measure a NON-privileged start has
        # to take that inheritance away, or it measures the opposite state from
        # the one its sentence names.
        handed = dict(os.environ)
        for key, value in env.items():
            if value is None:
                handed.pop(key, None)
            else:
                handed[key] = value
        run = subprocess.run(
            argv, capture_output=True, text=True,
            cwd=os.path.dirname(me), env=handed,
        )
        return run.stdout + run.stderr

    # First: that the hijack WORKS in this container, against a wrapper written
    # the way this one used to be. Without this the three arms below could all
    # be passing because the mechanism does nothing here.
    _plain = os.path.join(a_tree("p7-census-arm-"), "unhardened.sh")
    open(_plain, "w", encoding="utf-8").write(
        "#!/usr/bin/env bash\nexec /usr/bin/python3 -I %s --isolation-probe\n" % me
    )
    expect(
        "the environment hijack DOES take effect on a wrapper that does not defend itself, "
        "so the arms below are not vacuous (R20-02)",
        "P7-HIJACKED-EXEC-RAN" in through_the_wrapper(
            ["bash", _plain], **{"BASH_FUNC_exec%%": "() { echo P7-HIJACKED-EXEC-RAN; }"}
        ),
    )
    expect(
        "an exported function named after a builtin cannot reach the wrapper run as a program "
        "(R20-02)",
        (lambda out: "P7-ISOLATION-PROBE: isolated" in out and "P7-HIJACKED-EXEC-RAN" not in out)(
            through_the_wrapper(
                [wrapper_path, "--isolation-probe"],
                **{"BASH_FUNC_exec%%": "() { echo P7-HIJACKED-EXEC-RAN; }"},
            )
        ),
    )
    expect(
        "run as `bash <path>` with no privilege inherited, which the shebang cannot govern, "
        "the wrapper REFUSES by name rather than running unprivileged (R20-02)",
        # No function is planted here, deliberately: with one planted the
        # FUNCTIONS-WERE-IMPORTED refusal below fires FIRST and this arm would
        # pass on the wrong refusal, leaving the `$-` case unmeasured. One arm,
        # one refusal.
        "REFUSED-P7-WRAPPER-NOT-PRIVILEGED" in through_the_wrapper(
            ["bash", wrapper_path, "--isolation-probe"], SHELLOPTS=None
        ),
    )
    # R21-02's arms. `p` in `$-` is a FLAG, and `SHELLOPTS=privileged` sets it
    # while the environment's functions are still imported, so the refusal above
    # passed in exactly the state it existed to stop. The first arm measures
    # bash, not this file, and is here as the vacuity closer: if a future bash
    # stops importing functions in that state, this arm says so instead of
    # leaving the refusal below looking load-bearing when it is not.
    _flag_vs_property = through_the_wrapper(
        ["bash", "-c", 'case $- in *p*) echo P7-FLAG-SAYS-PRIVILEGED;; esac; declare -F'],
        SHELLOPTS="privileged",
        **{"BASH_FUNC_exec%%": "() { echo P7-HIJACKED-EXEC-RAN; }"},
    )
    expect(
        "SHELLOPTS=privileged sets the privileged FLAG while the hijack is STILL imported, "
        "so the flag and the property disagree (R21-02)",
        "P7-FLAG-SAYS-PRIVILEGED" in _flag_vs_property and "exec" in _flag_vs_property,
    )
    expect(
        "a function imported in that state is a refusal BY NAME, which is the property the "
        "flag cannot see (R21-02)",
        (lambda out: "REFUSED-P7-WRAPPER-FUNCTIONS-WERE-IMPORTED" in out
         and "P7-HIJACKED-EXEC-RAN" not in out)(
            through_the_wrapper(
                ["bash", wrapper_path, "--isolation-probe"],
                SHELLOPTS="privileged",
                **{"BASH_FUNC_exec%%": "() { echo P7-HIJACKED-EXEC-RAN; }"},
            )
        ),
    )
    expect(
        "and the hijack of `unset` that neutralised this script's own defence is refused with "
        "it, since the capture happens BEFORE `unset -f` runs (R21-02)",
        (lambda out: "REFUSED-P7-WRAPPER-FUNCTIONS-WERE-IMPORTED" in out
         and "P7-HIJACKED-EXEC-RAN" not in out)(
            through_the_wrapper(
                ["bash", wrapper_path, "--isolation-probe"],
                SHELLOPTS="privileged",
                **{"BASH_FUNC_unset%%": "() { : ; }",
                   "BASH_FUNC_exec%%": "() { echo P7-HIJACKED-EXEC-RAN; }"},
            )
        ),
    )
    _bash_env = os.path.join(a_tree("p7-census-arm-"), "sourced.sh")
    open(_bash_env, "w", encoding="utf-8").write(hijack_function + "\n")
    expect(
        "BASH_ENV, which the shell sources before the script, is REFUSED by name (R20-02)",
        (lambda out: "REFUSED-P7-WRAPPER-" in out and "P7-HIJACKED-EXEC-RAN" not in out)(
            through_the_wrapper(["bash", wrapper_path, "--isolation-probe"], BASH_ENV=_bash_env)
        ),
    )
    expect(
        "and with BASH_ENV set, the program invocation refuses rather than ignoring it quietly "
        "(R20-02)",
        (lambda out: "REFUSED-P7-WRAPPER-ENVIRONMENT-SOURCES-A-FILE" in out
         and "P7-HIJACKED-EXEC-RAN" not in out)(
            through_the_wrapper([wrapper_path, "--isolation-probe"], BASH_ENV=_bash_env)
        ),
    )
    # R21-01's arms. The subject is `PATH`, and the plants are the challenge's
    # own: a forged `bash`, which the old `env -S` shebang resolved through
    # `PATH`, and a forged `dirname`, which the handover line used to call
    # unqualified. The first arm is the vacuity closer -- the same poisoned
    # `PATH` against a wrapper written the way this one used to be -- because
    # without it the two arms after could pass in a container where planting an
    # executable earlier on `PATH` does nothing at all.
    _bin = a_tree("p7-census-arm-")
    _elsewhere = a_tree("p7-census-arm-")
    open(os.path.join(_bin, "bash"), "w", encoding="utf-8").write(
        "#!/bin/sh\necho P7-FORGED-BASH-RAN\nexit 0\n"
    )
    open(os.path.join(_bin, "dirname"), "w", encoding="utf-8").write(
        "#!/bin/sh\nprintf '%s\\n' " + _elsewhere + "\n"
    )
    os.chmod(os.path.join(_bin, "bash"), 0o755)
    os.chmod(os.path.join(_bin, "dirname"), 0o755)
    open(os.path.join(_elsewhere, "red_proofs.py"), "w", encoding="utf-8").write(
        "print('P7-FORGED-HARNESS-RAN')\n"
    )
    _old_shape = os.path.join(a_tree("p7-census-arm-"), "env-shebang.sh")
    open(_old_shape, "w", encoding="utf-8").write(
        "#!/usr/bin/env -S bash -p\n"
        'exec /usr/bin/python3 -I "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/red_proofs.py"\n'
    )
    os.chmod(_old_shape, 0o755)
    _poisoned = _bin + ":" + os.environ.get("PATH", "")
    expect(
        "a forged `bash` earlier on PATH DOES reach a wrapper whose shebang goes through `env`, "
        "so the two arms below are not vacuous (R21-01)",
        "P7-FORGED-BASH-RAN" in through_the_wrapper([_old_shape], PATH=_poisoned),
    )
    expect(
        "a forged `bash` earlier on PATH cannot reach this wrapper, whose shebang names the "
        "interpreter absolutely (R21-01)",
        (lambda out: "P7-ISOLATION-PROBE: isolated" in out
         and "P7-FORGED-BASH-RAN" not in out)(
            through_the_wrapper([wrapper_path, "--isolation-probe"], PATH=_poisoned)
        ),
    )
    expect(
        "and a forged `dirname` cannot redirect the handover, which names it absolutely and "
        "assigns PATH before it runs (R21-01)",
        (lambda out: "P7-ISOLATION-PROBE: isolated" in out
         and "P7-FORGED-HARNESS-RAN" not in out)(
            through_the_wrapper([wrapper_path, "--isolation-probe"], PATH=_poisoned)
        ),
    )
    expect(
        "the PATH the wrapper hands its child is the assigned one, not the inherited one "
        "(R21-01)",
        "PATH=/usr/bin:/bin" in through_the_wrapper(
            [wrapper_path, "--isolation-probe"], PATH=_poisoned
        ),
    )
    expect(
        "with no hijack at all the wrapper still answers, so none of the above is a false red "
        "(R20-02)",
        "P7-ISOLATION-PROBE: isolated" in through_the_wrapper(
            [wrapper_path, "--isolation-probe"]
        ),
    )
    expect(
        "no module file sits beside this harness where it could shadow the standard library",
        # S-4, the coordinator's review of `85bfbf5`: this scanned `*.py` only
        # while its NAME says module file. Not a hole — under `-I` the
        # directory is off `sys.path` and the refusal at the top of this file
        # guarantees `-I` — but a check whose name is broader than its scan is
        # read by the next editor as covering what it does not. These are the
        # extensions an interpreter will import from a directory on the path,
        # plus a package directory, so the name and the scan now agree.
        sorted(
            f for f in os.listdir(os.path.dirname(me))
            if f != os.path.basename(me)
            and (
                f.endswith((".py", ".pyc", ".pyo", ".pyd", ".so", ".pth"))
                or os.path.isfile(os.path.join(os.path.dirname(me), f, "__init__.py"))
            )
        ) == [],
    )

    for name, ok in checks:
        print(f"  SELF-TEST {'ok  ' if ok else 'FAIL'} {name}")
    bad = [name for name, ok in checks if not ok]
    if bad:
        print(f"SELF-TEST FAILED ({len(bad)} of {len(checks)}): the guards are not armed.")
        return 1
    # The arms are a census of themselves, and a census pins its SET. `N of N`
    # is satisfied by any number of arms, including fewer: deleting one lowered
    # both sides and printed a clean line, which is the same shape as every
    # total this file has had to replace with a literal. So the count is a
    # LITERAL, and a departure is a refusal by name. An arrival is a refusal
    # too, deliberately: an arm added without this number being raised is an arm
    # nobody reviewed.
    if len(checks) != GUARD_BRANCHES_THIS_HARNESS_DECLARES:
        print(
            f"REFUSED-P7-GUARD-BRANCH-CENSUS: {len(checks)} guard branches ran and this harness "
            f"declares {GUARD_BRANCHES_THIS_HARNESS_DECLARES}. An arm deleted lowers `N of N` on "
            f"both sides and reads as armed; an arm added unreviewed reads the same. Neither is "
            f"a figure a reader can act on, so the count is pinned."
        )
        return 1
    print(f"SELF-TEST: {len(checks)} of {len(checks)} guard branches armed.")
    return 0


_SAMPLE_SOURCE = """
        val WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT:
            Map<Pair<String, String>, WhatCoversTheRest> = mapOf(
            ("INV-9a/x" to "offline.c")
                to WhatCoversTheRest.AnotherClaimOverEveryProduction(
                    "INV-9c/x",
                ),
        )
"""


def _refuses_to_read() -> bool:
    """Three unreadable shapes, each of which must RAISE rather than return."""
    for broken in (
        "nothing here declares anything",
        _SAMPLE_SOURCE.replace("mapOf(", "mapOf"),
        _SAMPLE_SOURCE.replace('"INV-9c/x",', ""),
        _SAMPLE_SOURCE.replace("AnotherClaimOverEveryProduction", "SomethingElse"),
    ):
        try:
            covers_the_source_declares(broken)
        except CannotRead:
            continue
        return False
    return True


# The coordinator's housekeeping finding, measured before it was fixed: this
# harness made one copied tree per proof and removed none of them. 2,613 trees
# and 2.5 GB were sitting in the temp directory, from a handful of rounds, and a
# container whose disk fills stops being able to run the thing that measures it.
# Every tree this run creates is recorded here, removed in a `finally` so an
# early return cannot skip it, and then CONFIRMED gone by looking: a cleanup
# that reports success without checking is the shape this lane keeps refusing.
CHILD_MARK = "[self-test] "


def marked_as_the_childs(text: str) -> str:
    """Mark every line of the self-test child's relayed output as the child's.

    R18-03, the eighteenth challenge. The child's output was relayed verbatim,
    and the child reaches the same cleanup block as the parent, so its `TREES:`
    line read as the parent's — on an interrupted run it was the ONLY such line
    in the log, saying nothing leaked while the parent had trees on disk. The
    child is silent about trees it never made now, and this marks what it does
    say. What this binds is the relay: it is the one path the child's output
    reaches this log through, so a line without the mark is the parent's. It
    does not bind what the child CHOOSES to print, which is the other half and
    is closed in `__main__`.
    """
    if not text:
        return text
    lines = text.split("\n")
    trailing = lines.pop() if lines and lines[-1] == "" else None
    out = "\n".join(CHILD_MARK + line for line in lines)
    return out + "\n" if trailing is not None else out


# F-H, the coordinator's review of `85bfbf5`. The recursion stop added for the
# isolation arms was ONE early-exit block with no depth bound: deleting it
# reproduced the fork (566 live processes, a neighbouring run OOM-killed), and
# the coordinator's point was that arming an early return means running the
# recursion. It does not, once the bound is a COUNTER the children carry: a
# child spawned past the legitimate depth refuses by name, and an arm can set
# the marker directly and read that refusal without a single extra process.
#
# The legitimate chain is exactly three deep: the harness, the `--self-test`
# child it runs, and the `--isolation-probe` that child spawns. Anything deeper
# is this file spawning itself.
SPAWN_DEPTH_ENV = "P7_HARNESS_SPAWN_DEPTH"

# R21-04, the twenty-first challenge, P2 and measured on the head with no plant:
# a SIGTERM during the self-test child printed `0 are this run's and 5 are not`
# about five trees this run's OWN CHILD had made seconds earlier. The partition
# was computed against this PROCESS's two registries, so "this run's" meant
# "this process's", and a reader was told five foreign trees existed.
#
# The child cannot be attributed by its paths, because at the moment the parent
# is signalled the child has printed nothing and its registry lives in another
# process. So the parent issues the child a NONCE and the child puts it in every
# tree name it creates. Attribution is then derived from the name the parent
# itself handed down: no file another writer could append to -- which would let a
# foreign tree read as ours, the fail-open direction -- and no guess. THE BOUND:
# a tree whose name carries the nonce is this run's child's as far as anything
# here can tell, and someone who knows the nonce could mint one; the nonce is
# fresh per run and never printed before the attribution is made.
TREE_TAG_ENV = "P7_TREE_TAG"
MY_TREE_TAG = os.environ.get(TREE_TAG_ENV, "")
THE_TAG_I_HAND_MY_CHILD = "c" + os.urandom(6).hex()
DEEPEST_LEGITIMATE_SPAWN = 2


def spawn_depth() -> int:
    """How deep this process is. No `except ValueError`: the module-level
    refusal above has already exited on anything this cannot parse, so a
    handler here could never run, and a defensive branch that cannot be reached
    is the same class of thing as a guard nobody calls (R19-03)."""
    return int((os.environ.get(SPAWN_DEPTH_ENV, "0") or "0").strip())


def env_for_a_child() -> dict[str, str]:
    """This process's environment with the spawn depth incremented."""
    env = dict(os.environ)
    env[SPAWN_DEPTH_ENV] = str(spawn_depth() + 1)
    env[TREE_TAG_ENV] = THE_TAG_I_HAND_MY_CHILD
    return env


def too_deep_to_be_anything_but_a_fork() -> str | None:
    depth = spawn_depth()
    if depth <= DEEPEST_LEGITIMATE_SPAWN:
        return None
    return (
        f"REFUSED-P7-HARNESS-SPAWNED-ITSELF: this process is {depth} spawns deep and the "
        f"deepest legitimate chain is {DEEPEST_LEGITIMATE_SPAWN} (harness, self-test child, "
        f"isolation probe). A deeper one is this file spawning itself, which has twice "
        f"exhausted this container's memory, so it refuses rather than forking again."
    )


def wrapper_code_lines(wrapper_text: str) -> list[str]:
    """The wrapper's CODE lines, with line ONE always among them.

    Not its prose: a "must not contain" over the whole file trips on a comment
    that quotes the very mistake it describes, which is a false red, and a
    hardening that causes a false red is not hardening.

    R20-01, the twentieth challenge, and the coordinator's F-R: the shebang
    starts with `#`, so the comment rule dropped it -- and it is the one line in
    the file that decides which program interprets the rest. One edit to it ran
    a forged shell that printed `ALL 105 RED PROOFS SATISFIED` at rc 0, while
    this pin, asked in that same tree, said the wrapper was byte-for-byte
    intact. So line one is taken by POSITION and the comment rule applies from
    line two onward. Positional and not another shape rule, because the two
    arms that add prose add it BELOW line one and must stay green.
    """
    lines = wrapper_text.split("\n")
    return lines[:1] + [
        line for line in lines[1:]
        if line.strip() and not line.lstrip().startswith("#")
    ]


# R19-01, the nineteenth challenge, RULED P1 by the coordinator. The pin was a
# SET OF EXACTLY ONE over the assignments a regex recognised at the start of a
# line — an enumeration of SHAPES. The shell does not require a line to start
# with an assignment, and the challenger walked past it with three one-line
# edits (`true; PY=…`, `if true; then PY=…; fi`, `{ PY=…; }`), each leaving the
# self-test log BYTE-IDENTICAL to the clean tree's, and then ran the whole
# harness under a forged interpreter that printed
# `ALL 104 RED PROOFS SATISFIED` at rc 0 while running nothing. The arm's own
# sentence — "runs the pinned interpreter in isolated mode, verbatim and once" —
# was printed while a foreign interpreter ran it, and a printed sentence the
# measurement contradicts is this lane's blocking class.
#
# So the pin is BYTE EQUALITY over the wrapper's whole CODE, which is the one
# shape of the three the challenger's plants do not evade: an added line of ANY
# shape is a difference. Comments are still excluded, because a "must not
# contain" over prose trips on a comment quoting the mistake it describes, and a
# hardening that causes a false red is not hardening.
#
# Where this regress stops, said rather than left implied: the literal below is
# bounded by REVIEW, exactly as the guard-branch count is. It cannot be bounded
# from inside the file, because a check whose expectation is read out of the
# subject is the subject checking itself.
#
# What the literal buys, stated as narrowly as it was measured, and NOT as the
# earlier sentence here put it: every CODE line of the wrapper differs from the
# pin if it is edited, so none of the three plants above survives a run whose
# output the reader is reading. Two kinds of edit are invisible to it and the
# reader should know both. The first is an edit confined to COMMENTS: they are
# excluded by construction, for the false-red reason given above, so wrapper
# prose can be made to lie while this pin stays green — which is why every
# claim the wrapper's comments make is itself bounded by review, not by this
# check. The second is the forging plant that does not edit the wrapper at all:
# the pin is read by the harness the wrapper EXECs, so anything that replaces
# what runs at `/usr/bin/python3` runs BEFORE the pin is ever read and may print
# whatever it likes, this sentence included. That hole cannot be closed from
# inside this file at all; it is closed, if anywhere, by the shebang's
# privileged mode and by the reader trusting the interpreter path, and it is a
# named residual here, not a thing this literal covers.
#
# The challenger also measured the alternative it would have recommended and
# found it worthless: a shim that `exec`s the pinned interpreter leaves nothing
# of itself in the surviving process, so `sys.executable` is identical under the
# plant and the clean tree. A PROJECTION is not an IDENTITY.
WRAPPER_CODE_PINNED: tuple[str, ...] = (
    '#!/bin/bash -p',
    '_P7_FUNCS_AT_ENTRY=$(declare -F 2>/dev/null)',
    'unset -f exec echo exit cd pwd set test [ unset command builtin printf declare 2>/dev/null',
    'PATH=/usr/bin:/bin',
    'export PATH',
    'if [ -n "$_P7_FUNCS_AT_ENTRY" ]; then',
    '  echo "REFUSED-P7-WRAPPER-FUNCTIONS-WERE-IMPORTED: a shell function was already defined when"',
    '  echo "this script was read, so a command it uses could run as that function and forge a"',
    '  echo "verdict with no file edited. SHELLOPTS=privileged sets the privileged FLAG while still"',
    '  echo "importing functions, which is why the flag alone is not asked. Functions seen:"',
    '  echo "$_P7_FUNCS_AT_ENTRY"',
    '  exit 3',
    'fi',
    'case $- in',
    '  *p*) ;;',
    '  *)',
    '    echo "REFUSED-P7-WRAPPER-NOT-PRIVILEGED: this script was started without privileged mode,"',
    '    echo "so an inherited shell function named after a builtin it uses could run in its place"',
    '    echo "and forge a verdict with no file edited. Run it as ./tools/red-proofs.sh, which uses"',
    '    echo "the pinned shebang, or as: bash -p tools/red-proofs.sh"',
    '    exit 3',
    '    ;;',
    'esac',
    'if [ -n "${BASH_ENV:-}" ] || [ -n "${ENV:-}" ]; then',
    '  echo "REFUSED-P7-WRAPPER-ENVIRONMENT-SOURCES-A-FILE: BASH_ENV or ENV is set, which names a"',
    '  echo "file the shell sources before this script. Privileged mode ignores it, and this refuses"',
    '  echo "rather than running with it set, because a verdict should not depend on which of the two"',
    '  echo "the reader has to know about."',
    '  exit 3',
    'fi',
    'set -uo pipefail',
    'PY=/usr/bin/python3',
    'if [ ! -x "$PY" ]; then',
    '  echo "REFUSED-P7-NO-PINNED-INTERPRETER: $PY is not executable, and this script will not"',
    '  echo "search PATH for a substitute: the interpreter is part of the command being pinned."',
    '  exit 3',
    'fi',
    'echo "P7 RED PROOFS: interpreter $PY ($("$PY" -V 2>&1)), isolated mode -I"',
    'exec "$PY" -I "$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && pwd)/red_proofs.py" "$@"',
)


def the_wrapper_pin_holds(wrapper_text: str) -> bool:
    """Whether the wrapper's code is, byte for byte, the code pinned above."""
    return tuple(wrapper_code_lines(wrapper_text)) == WRAPPER_CODE_PINNED


# The number of guard branches this harness's self-test declares. Pinned, not
# derived: see the census in `self_test`.
GUARD_BRANCHES_THIS_HARNESS_DECLARES = 92

# F-I, the coordinator's actual-diff review of `9809db1`, a P1 fail-open that
# needed no edit to reach: the stray census recognised trees by an ENUMERATED
# prefix list, and the fourth prefix — `p7-census-arm-`, created by the F-G arms
# of the very commit that turned the stray report into a refusal — was not on
# it. Measured before the fix: 120 census-arm trees on disk, census sees 0, no
# NOTE and no refusal at any number, so limitation 10's promise about a killed
# run's leftovers was false for one prefix in four. This is the project's own
# settled shape: a count rule that enumerates labels fails open on the next one,
# and here the next label arrived in the same commit as the rule.
#
# So the prefixes are ONE tuple, every creation site goes through `a_tree`, and
# `a_tree` refuses a prefix the tuple does not carry. A new creation site cannot
# now be added without the census seeing it: it either uses the tuple or it does
# not run.
TREE_PREFIXES: tuple[str, ...] = (
    "p7-proof-",
    "p7-baseline-",
    "p7-omission-arm-",
    "p7-census-arm-",
)

TREES_THIS_RUN: list[str] = []

# R19-02, the nineteenth challenge, P1 and the reason that head carries no
# signature. The signal handler scrubbed and then printed
# `N of N tree(s) removed, 0 left` — a claim about a RESOURCE, derived from a
# list rather than from the directory. The challenger signalled four runs and
# two of them printed a figure the filesystem contradicts; in one, four trees
# were BORN 4 to 16 milliseconds AFTER the line claiming `0 left` was written.
#
# Mechanism, identified and not guessed: the proofs run in a thread pool, the
# signal is delivered to the MAIN thread, and the workers keep running until the
# process dies. So a worker creates a tree after `scrub_all()` has returned, and
# `mkdtemp` followed by `append` is not atomic — a worker interrupted between
# them leaves a tree this list never knew about at all.
#
# Three things, and F-M is the coordinator's correction of my claim that all
# three are needed for the PRINTED FIGURE: it removed the lock and four of four
# signalled runs still printed a figure the directory confirmed. Load-bearing
# for the figure are the stop flag and the listing. The lock closes a different
# defect, which is why it stays:
#   * creation and registration happen together, under this lock, so no tree
#     exists unregistered even for an instant -- R20-03's companion half, for
#     which the arms' own trees now go through `an_arms_tree` rather than
#     bypassing registration altogether;
#   * a STOP flag the creation path reads inside that same lock, so once the
#     handler has set it no further tree can be made;
#   * the printed figure comes from LISTING the directory afterwards, which is
#     the standard the normal-exit line already holds itself to: "confirmed by
#     looking, not by assuming the call worked."
# The lock is reentrant because the main thread makes trees too, and a signal
# arriving while it holds the lock would otherwise deadlock the handler.
_TREE_BOOKKEEPING = threading.RLock()
_NO_MORE_TREES = threading.Event()

# R20-03, the twentieth challenge's companion half. Five sites made trees with
# `mkdtemp` directly, bypassing `a_tree`, because a tree registered as this
# run's is EXCLUDED from the census and these are the arms that measure the
# census. The author knew and said so, but what they needed was not to bypass
# registration: it was to be registered for SCRUBBING while staying visible to
# the census. That is this list. `scrub_all` empties it with the other, and a
# signal during one of those arms therefore no longer leaves up to four trees
# that nothing was tracking.
ARM_TREES_THIS_RUN: list[str] = []


def tag_for_my_trees() -> str:
    """The nonce this process was handed, as a name fragment, or nothing.

    R21-04: a child of this harness puts the parent's nonce in every tree name,
    so the PARENT can attribute those trees when it is signalled while the child
    is still alive -- the one moment at which the child's own registry is in
    another process and its output has not been written yet. The top-level run
    is handed no nonce and adds none, which keeps its tree names what every
    earlier round measured.
    """
    return MY_TREE_TAG + "-" if MY_TREE_TAG else ""


def trees_on_disk() -> list[str]:
    """Every directory under this harness's prefixes, whoever made it."""
    tmp = tempfile.gettempdir()
    try:
        names = sorted(os.listdir(tmp))
    except OSError:
        return []
    return [
        os.path.join(tmp, name) for name in names
        if name.startswith(TREE_PREFIXES) and os.path.isdir(os.path.join(tmp, name))
    ]


def an_arms_tree(prefix: str) -> str:
    """A tree the CENSUS must still see, and that cleanup must still remove.

    Same lock and same stop flag as `a_tree`, so nothing is created unregistered
    and nothing is created after a signal has ended the run; it is only the
    census's own exclusion set that this stays out of (R20-03).
    """
    if not prefix.startswith(TREE_PREFIXES) and not prefix.startswith("p7-proof-"):
        raise CannotRead(
            f"REFUSED-P7-TREE-PREFIX-NOT-CENSUSED: an arm asked for a tree under {prefix!r}, "
            f"which no prefix in TREE_PREFIXES covers, so the census could never see it."
        )
    with _TREE_BOOKKEEPING:
        if _NO_MORE_TREES.is_set():
            raise CannotRead(
                "REFUSED-P7-TREE-AFTER-THE-RUN-WAS-ENDED: an arm asked for a tree after a "
                "signal ended this run."
            )
        tree = tempfile.mkdtemp(prefix=prefix + tag_for_my_trees())
        ARM_TREES_THIS_RUN.append(tree)
    return tree


def a_tree(prefix: str) -> str:
    """Make a temp tree under a prefix the census knows, and register it.

    The refusal is by NAME and it fires on ABSENCE: a prefix absent from
    TREE_PREFIXES is not quietly accepted, because the whole finding was a tree
    nobody counted. `p7-proof-` sites pass `p7-proof-<i>-`, so the check is
    membership of the declared prefix this one starts with, not equality.
    """
    if not prefix.startswith(TREE_PREFIXES):
        raise CannotRead(
            f"REFUSED-P7-TREE-PREFIX-NOT-CENSUSED: a tree was asked for under {prefix!r}, which "
            f"no prefix in TREE_PREFIXES covers, so the stray census could never see it. Add it "
            f"to TREE_PREFIXES — the arm that plants one tree per prefix will then cover it too."
        )
    with _TREE_BOOKKEEPING:
        if _NO_MORE_TREES.is_set():
            raise CannotRead(
                "REFUSED-P7-TREE-AFTER-THE-RUN-WAS-ENDED: a tree was asked for after a signal "
                "ended this run and its trees were scrubbed. Making one now would leave a tree "
                "behind that nothing is left to remove."
            )
        tree = tempfile.mkdtemp(prefix=prefix + tag_for_my_trees())
        TREES_THIS_RUN.append(tree)
    return tree


def scrub(tree: str) -> None:
    """Remove a tree. Never raises: a failed cleanup must not eat a verdict."""
    shutil.rmtree(tree, ignore_errors=True)


def scrub_all() -> list[str]:
    """Remove every tree this run made and RETURN the ones still there.

    Both lists: the trees registered as this run's, and the arms' trees, which
    the census must see but cleanup must still remove (R20-03).
    """
    left = []
    for tree in list(TREES_THIS_RUN) + list(ARM_TREES_THIS_RUN):
        scrub(tree)
        if os.path.exists(tree):
            left.append(tree)
    return left


# R18-03, the eighteenth challenge, second limb: A SIGNAL DOES NOT RUN THE
# `finally`. Measured by that review, three killed runs of this harness at the
# head before this one: SIGTERM rc 143, SIGINT rc 130 and SIGKILL rc 137 each
# left the run's own trees on disk, with no `TREES:` line and no refusal. The
# `finally` closes an early RETURN, which is what it was written for, and says
# nothing about a kill — and in this container the normal end of a long run IS
# a kill, which is how 2,620 trees accumulated in the first place.
#
# SIGTERM and SIGINT are closable from inside and are closed here: scrub what
# this run made, then re-raise the signal with the default disposition so the
# exit status is the one the signal means (128 + n) rather than a status this
# handler invented. SIGKILL CANNOT BE CLOSED FROM INSIDE — the process is gone
# before any Python runs — so it is named here rather than left for a reader to
# discover: a run killed with -9 leaves its trees, and the next run reports them
# as strays, which is why that report is a refusal above a threshold and no
# longer a note.
def first_few(label: str, trees: list[str], show: int = 5) -> str:
    """`label: [a, b] (first 2 of 7).` -- F-V: a truncated list says so.

    The signal report used to print `mine[:5]` beside a count of seven, so a
    reader reconciling the list against the number saw a contradiction that was
    not there. A list shorter than the limit carries no marker, because a marker
    on a complete list is noise.
    """
    shown = trees[:show]
    more = "" if len(trees) <= show else f" (first {len(shown)} of {len(trees)})"
    return f"{label}: {shown}{more}."


def stop_then_scrub_and_report(signum: int) -> str:
    """Stop the creators, scrub, LIST the directory, and say what the listing says.

    R19-02 is why the figure is a listing and not a count of a list other
    threads append to. The coordinator's F-L is why this is a function and not
    three statements inside a signal handler: a signal handler re-raises the
    signal and ends the process, so no arm could ever reach it, and the
    mechanisms were armed while the CALLER was not. Three one-line edits to it
    -- the figure taken from the list again, the stop flag deleted, the lock
    removed -- each left the self-test at 62 of 62. Now each reds an arm.

    R20-03 is why ownership is COMPUTED. The sentence used to read "Not all of
    these are this run's" whenever the directory was not empty, which is emitted
    identically when every leftover IS this run's -- false in the direction that
    stops a reader acting. Both numbers are printed now.

    F-M is why the comment above `_TREE_BOOKKEEPING` no longer says all three
    things are needed: the coordinator removed the lock and four of four
    signalled runs still printed a figure the directory confirmed. The lock
    closes a different defect -- a tree existing unregistered between `mkdtemp`
    and `append` -- and that is what it is for.
    """
    _NO_MORE_TREES.set()
    with _TREE_BOOKKEEPING:
        registered = len(TREES_THIS_RUN) + len(ARM_TREES_THIS_RUN)
        known = set(TREES_THIS_RUN) | set(ARM_TREES_THIS_RUN)
        left = scrub_all()
    on_disk = trees_on_disk()
    mine = [tree for tree in on_disk if tree in known]
    childs = [
        tree for tree in on_disk
        if tree not in known and THE_TAG_I_HAND_MY_CHILD in os.path.basename(tree)
    ]
    others = [tree for tree in on_disk if tree not in known and tree not in childs]
    return (
        f"P7-SCRUBBED-ON-SIGNAL: signal {signum} ended this run; {registered - len(left)} of "
        f"{registered} tree(s) this run had registered were removed, and the temp directory now "
        f"holds {len(on_disk)} tree(s) under this harness's prefixes, of which {len(mine)} "
        f"are this process's, {len(childs)} were made by this run's self-test child and "
        f"{len(others)} are neither — confirmed by LISTING the directory after the creators "
        f"were stopped, and by computing the three sets rather than guessing which. "
        + first_few("This process's", mine)
        + " " + first_few("The self-test child's", childs)
        + " " + first_few("Neither", others)
    )


def _scrub_on_signal(signum: int, _frame: object) -> None:
    print(stop_then_scrub_and_report(signum), flush=True)
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def arm_the_signal_handlers() -> None:
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _scrub_on_signal)


# One whole run of this harness makes this many trees, so more strays than this
# means at least one entire run's worth was left behind by something — a kill, a
# crash, or a copy of this file run by hand. Below it, a stray is ordinary
# overlap with another session's run; at or above it, the disk is being filled
# by runs that are not cleaning up and somebody has to act.
#
# F-I's second limb: this was the literal 101, written when there were 99
# proofs, and it sat five lines above the run's own `106 made`. A hand-written
# figure that no command reproduces is the class this lane has closed twice
# already, so it is DERIVED here from the only three things that make a tree in
# a main run — one per proof, one baseline, one omission arm — and the run
# compares its own counter to it at the end, so the figure is measured rather
# than asserted. The self-test child makes census-arm trees in its OWN process
# and reports them separately, which is why they are not in this sum.
# Coord F-Q, carried for two rounds and closed here the way this lane closes
# this shape. The derivation below is sound and its ARMS could not contradict
# it, because they are fed its own output: changing `+ 2` to `+ 3` left the
# self-test at 78 of 78 at the two previous heads, and only the authoritative
# run's own counter caught it. An arm fed the derivation's own output certifies
# the comparison and the refusal name, never the figure. So the figure gets an
# EXTERNAL literal, exactly as the guard-branch census does, and the self-test
# compares the two: the literal is bounded by REVIEW and by the fact that adding
# a proof without touching it reds the self-test, which is the correct red.
ONE_RUNS_TREES_DECLARED = 107


def one_runs_worth_of_trees() -> int:
    """How many trees a main run of this harness makes, derived not written."""
    return len(PROOFS) + 2  # the baseline tree, and the omission arm's tree


def the_leftover_verdict(left: list[str]) -> tuple[str, bool] | None:
    """What to say about trees THIS run made and failed to remove."""
    if not left:
        return None
    return (
        f"REFUSED-P7-TREES-LEFT-BEHIND: {len(left)} copied tree(s) this run made are still "
        f"in the temp directory after cleanup, so this harness is filling the disk it runs "
        f"on: {left[:5]}",
        True,
    )


def the_prediction_verdict(made: int, am_child: bool, code: int) -> tuple[str, bool] | None:
    """Whether this run's own tree count matches the figure the threshold uses.

    Not compared for the self-test child, which makes census-arm trees and no
    proof trees, and not on a run that already failed: there the counter
    predicts nothing, because the sweep may have stopped early.
    """
    if am_child or code != 0 or made == one_runs_worth_of_trees():
        return None
    return (
        f"REFUSED-P7-TREE-COUNT-PREDICTION-STALE: this run made {made} tree(s) and "
        f"`one_runs_worth_of_trees()` says a run makes {one_runs_worth_of_trees()}. The "
        f"threshold the stray refusal uses, and the figure limitation 10 prints, are "
        f"therefore about a different run than this one.",
        True,
    )


def the_strays_verdict(earlier: list[str]) -> tuple[str, bool] | None:
    """What to say about trees on disk that this run did NOT make."""
    if not earlier:
        return None
    if len(earlier) >= one_runs_worth_of_trees():
        return (
            f"REFUSED-P7-TEMP-DIRECTORY-FILLING: {len(earlier)} tree(s) matching this harness's "
            f"prefixes are in {tempfile.gettempdir()} and are NOT this run's — at least one "
            f"whole run's worth ({one_runs_worth_of_trees()}) was left behind by a killed or "
            f"crashed run, and this harness cannot keep running on a disk it is filling. "
            f"Remove them: {earlier[:5]}",
            True,
        )
    return (
        f"NOTE: {len(earlier)} tree(s) matching this harness's prefixes were already in "
        f"{tempfile.gettempdir()} before this run and are NOT this run's to delete.",
        False,
    )


def strays_from_earlier_runs() -> list[str]:
    """Trees matching this harness's prefixes that THIS run did not create."""
    tmp = tempfile.gettempdir()
    mine = set(TREES_THIS_RUN)
    found = []
    for name in sorted(os.listdir(tmp)):
        path = os.path.join(tmp, name)
        if path in mine or not os.path.isdir(path):
            continue
        if name.startswith(TREE_PREFIXES):
            found.append(path)
    return found


def run_suite(tree: str) -> tuple[int, set[str], dict[str, str], str]:
    """Compile and run the suite in `tree`.

    Returns (rc, failing test names, each failing test's printed refusal, log).
    The refusals are read for F-2: a red run has to say WHY it went red.
    """
    env = dict(os.environ)
    env["P7_SRC"] = os.path.join(tree, "src")
    env["P7_TEST"] = os.path.join(tree, "test")
    env["P7_OUT"] = os.path.join(tree, "build")
    proc = subprocess.run(
        ["bash", os.path.join(HERE, "run-tests.sh")],
        capture_output=True, text=True, env=env,
    )
    log = proc.stdout + proc.stderr
    failing = {m.group(2).strip() for line in log.splitlines() if (m := FAILURE_LINE.match(line))}
    return proc.returncode, failing, failures_with_details(log), log


def main() -> int:
    harvesting = "--harvest" in sys.argv

    # The guards' own guard, and it runs FIRST, in its own interpreter. A gate
    # inside the set it measures runs as a subprocess, never imported: an
    # imported self-test shares this process's globals, and this process is the
    # thing being tested.
    probe = subprocess.run(
        [sys.executable, "-I", os.path.abspath(__file__), "--self-test"],
        capture_output=True, text=True, env=env_for_a_child(),
    )
    sys.stdout.write(marked_as_the_childs(probe.stdout))
    sys.stdout.write(marked_as_the_childs(probe.stderr))
    if probe.returncode != 0:
        print("THE GUARDS ARE NOT ARMED — no proof below means anything. Fix the self-test first.")
        return 1
    # F-B, the coordinator's review of `184f7d7`: the CALL above could be
    # deleted and every proof below would still report, with nothing saying the
    # guards had never been armed — an exit code is not a presence check. So the
    # self-test's own banner is PARSED, its absence is a refusal, and its branch
    # count is carried onto the PASS line at the end. A reader of the last line
    # can then tell armed from unarmed without scrolling, and a deletion of this
    # block takes the count off that line with it.
    armed = re.search(r"SELF-TEST: (\d+) of (\d+) guard branches armed\.", probe.stdout)
    if armed is None or armed.group(1) != armed.group(2):
        print(
            "REFUSED-P7-SELF-TEST-DID-NOT-REPORT: the self-test subprocess exited 0 without "
            "printing its `SELF-TEST: N of N guard branches armed.` line, so nothing here "
            "measured whether the guards are armed."
        )
        return 1
    guards_armed = armed.group(1)
    print()

    baseline_tree = a_tree("p7-baseline-")
    for part in ("src", "test"):
        shutil.copytree(os.path.join(ROOT, part), os.path.join(baseline_tree, part))
    rc, failing, _details, log = run_suite(baseline_tree)
    if rc != 0:
        print("BASELINE IS NOT GREEN — no red proof means anything against a red tree.")
        print(log[-4000:])
        return 1
    tests = re.search(r"\[\s*(\d+) tests successful", log)
    baseline_cases = int(tests.group(1)) if tests else 0
    print(f"BASELINE: exit 0, {baseline_cases} cases green\n")
    covers = covers_the_suite_declared(log)
    print(
        f"COVERS THE SUITE DECLARED AT RUNTIME: {len(covers)}"
        + (f" — {sorted(covers)}" if covers else " — none")
    )
    # F-1's second derivation, read from the subject's own text, compared as a
    # SET against the one above. Unreadable is a refusal, never zero.
    declared_covers: set[tuple[str, str]] = set()
    unreadable: str | None = None
    try:
        declared_covers = covers_the_source_declares(
            open(os.path.join(ROOT, COVER_MAP_FILE), encoding="utf-8").read()
        )
    except (CannotRead, OSError) as cannot:
        unreadable = str(cannot)
    print(
        f"COVERS THE SOURCE DECLARES: "
        + (f"REFUSED — {unreadable}" if unreadable else f"{len(declared_covers)} — {sorted(declared_covers) or 'none'}")
        + "\n"
    )

    # One proof per tree, and the trees are independent, so they run in
    # parallel. This is scheduling, not correctness: every proof does exactly
    # what it did sequentially, in its own copy, and the verdicts are printed
    # in order so two runs read the same. It matters because an independent
    # reviewer could not FINISH the sequential run — it timed out at 21 of 27
    # with no exit code, and a proof harness nobody can run to completion
    # proves nothing to anybody but its author.
    workers = max(1, min(len(PROOFS), (os.cpu_count() or 2)))

    def run_one(indexed: tuple[int, Proof]) -> tuple[int, Proof, str | None, str]:
        """Make this proof's tree, run it, and remove the tree WHATEVER happens.

        The body has eight early returns, which is why the removal is a
        `finally` and not a line at the end of it.
        """
        i, _ = indexed
        tree = a_tree(f"p7-proof-{i}-")
        try:
            return run_one_in(indexed, tree)
        finally:
            scrub(tree)

    def run_one_in(indexed: tuple[int, Proof], tree: str) -> tuple[int, Proof, str | None, str]:
        """Returns (index, proof, failure or None, verdict line)."""
        i, proof = indexed
        for part in ("src", "test"):
            shutil.copytree(os.path.join(ROOT, part), os.path.join(tree, part))
        for n, edit in enumerate(((proof.find, proof.replace),) + proof.edits, start=1):
            rel, find, replace = edit if len(edit) == 3 else (proof.path, edit[0], edit[1])
            target = os.path.join(tree, rel)
            before = open(target, encoding="utf-8").read()
            hits = before.count(find)
            if hits != 1:
                return (
                    i,
                    proof,
                    f"{proof.law}: edit {n} matched {hits} times in {rel} "
                    f"(must be exactly 1) — THE MUTATION DID NOT LAND, so this proof measured nothing",
                    f"MUTATION DID NOT LAND (edit {n}, {hits} matches)",
                )
            after = before.replace(find, replace)
            if after == before:
                return (
                    i, proof,
                    f"{proof.law}: edit {n} produced an identical file",
                    f"REPLACEMENT WAS A NO-OP (edit {n})",
                )
            open(target, "w", encoding="utf-8").write(after)

        rc, failing, details, _log = run_suite(tree)
        named = any(proof.expect_red in name for name in failing)
        if rc == 0:
            return (
                i, proof,
                f"{proof.law}: the suite stayed GREEN with the defect planted — the law is undefended",
                "STAYED GREEN",
            )
        if not named:
            return (
                i, proof,
                f"{proof.law}: the suite went red but '{proof.expect_red}' did not fail "
                f"(failed instead: {sorted(failing) or 'nothing named — did it compile?'})",
                "RED, BUT NOT THE NAMED TEST",
            )
        if harvesting:
            printed = " | ".join(text for name, text in sorted(details.items()) if proof.expect_red in name)
            print(f"HARVEST\t{proof.law}\t{printed}")
            return (i, proof, None, f"RED as required ({len(failing)} case(s) failed)")
        mismatch = refusal_mismatch(proof.law, proof.expect_red, details)
        if mismatch is not None:
            return (i, proof, mismatch, "RED, BUT NOT WITH THE DECLARED REFUSAL")
        return (i, proof, None, f"RED as required ({len(failing)} case(s) failed), with the refusal it declares")

    print(f"Running {len(PROOFS)} proofs across {workers} worker(s); each in its own tree.\n")
    failures: list[str] = []

    # T-01's arm, run before the proofs because it is cheap beside them and
    # because a harness whose own cover obligation fails open should say so
    # before it says anything else.
    arm_failures, arm_verdict = omission_arm(declared_covers)
    print(f"OMISSION ARM (T-01): the print loop deleted on a copy — {arm_verdict}\n")
    failures.extend(arm_failures)

    # An expectation for a law no proof carries is a STALE expectation: it was
    # harvested from a proof that has since been renamed or removed, and it
    # would read as coverage. A missing one is caught per proof, below.
    stale = sorted(set(EXPECTED_REFUSAL) - {proof.law for proof in PROOFS})
    if stale and not harvesting:
        failures.append(
            f"{len(stale)} expected refusal(s) are declared for laws no proof carries, so they "
            f"describe nothing this run measured: {stale}"
        )
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = sorted(pool.map(run_one, enumerate(PROOFS, start=1)), key=lambda r: r[0])
    for i, proof, failure, verdict in results:
        if failure is not None:
            failures.append(failure)
        print(f"  [{i:2}] {proof.law}\n       plant: {proof.why}\n       expect red: {proof.expect_red}\n       {verdict}")

    # S-01: every cover the SUITE ITSELF printed must have a proof here, and
    # that proof must have reddened in this run. Both halves read execution:
    # the covers from the baseline run's output, the verdicts from the results
    # above. A cover with no proof is a name pointing at an assertion nothing
    # tested, which is exactly the hole the review measured.
    reddened = {
        proof.law for _i, proof, failure, _verdict in results if failure is None
    }
    if unreadable is not None:
        failures.append(
            f"the covers {COVER_MAP_FILE} declares could not be read, so the set the run printed "
            f"is bounded by nothing: {unreadable} — a reader that cannot read REFUSES, "
            f"because an unreadable declaration counting as zero covers is the hole F-1 names"
        )
    failures.extend(cover_failures(covers, declared_covers, reddened))
    failures.extend(exemption_failures(PROOFS))
    failures.extend(coordinate_failures())
    failures.extend(census_failures(PROOFS))

    # §83: the baseline must RESTORE green. Each proof ran in its own copy, so
    # nothing could have leaked into the original — but "could not have" is an
    # argument, and this is a measurement. It also catches the case the argument
    # misses: a proof that reached outside its copy.
    rc, _, _, log = run_suite(baseline_tree)
    restored = re.search(r"\[\s*(\d+) tests successful", log)
    restored_cases = int(restored.group(1)) if restored else -1
    if rc != 0 or restored_cases != baseline_cases:
        failures.append(
            f"the baseline did not restore green after the proofs: exit {rc}, "
            f"{restored_cases} cases green against {baseline_cases} before"
        )
        print(f"\nBASELINE DID NOT RESTORE: exit {rc}, {restored_cases}/{baseline_cases} cases")
    else:
        print(f"\nBASELINE RESTORED: exit 0, {restored_cases} cases green, unchanged")

    print()
    if failures:
        print(f"RED PROOFS FAILED ({len(failures)} of {len(PROOFS)}):")
        for f in failures:
            print(f"  - {f}")
        return 1

    if harvesting:
        # F-C, the coordinator's review of `184f7d7`: a harvest run SKIPS the
        # declared-refusal comparison by construction — that is what harvesting
        # is for — so printing the same final sentence as a verifying run makes
        # the weaker run indistinguishable from the stronger one in a pasted log.
        print(
            f"HARVEST RUN COMPLETE: {len(PROOFS)} proofs red against their named test, with "
            f"{guards_armed} guard branches armed. THIS IS NOT A VERIFYING RUN: the refusal each "
            "proof declares was PRINTED above for freezing, not compared. Re-run without "
            "--harvest before citing a verdict."
        )
        return 0
    print(
        f"ALL {len(PROOFS)} RED PROOFS SATISFIED over a {baseline_cases}-case green baseline, "
        f"with {guards_armed} of {guards_armed} guard branches armed."
    )
    print()
    print("LIMITATIONS, printed on PASS because they are true on PASS:")
    print("  1. These proofs measure THE SUITE, not the kernel's fitness for the Android app.")
    print("     Nothing here runs on a device, against Room, against okhttp, or against the")
    print("     real merchant API. The kernel is pure logic and is proved as pure logic.")
    print("  2. One mutation per law. A law may still be under-defended against a defect")
    print("     shaped differently from the one planted here.")
    print("  3. The model check bounds the attempt counter, so it proves the behaviour of a")
    print("     bounded trace space, not of an unbounded one.")
    print("  4. No performance or timing claim is made by anything in this directory; the")
    print("     delays asserted are the schedule's own arithmetic, never a measured wait.")
    print("  5. This is a RECORD, not a required CI step. Phase 7 is PREPARED / NOT PROMOTED.")
    print("  6. The cover obligation above (S-01) is enforced HERE and nowhere else, so it is")
    print("     conditional on this harness being run at a head — which limitation 5 is about.")
    print("  7. Each proof's expected refusal (F-2) was HARVESTED from a measured run and then")
    print("     frozen. It proves the reason a proof reds has not CHANGED since it was read; it")
    print("     does not prove the reason was the right one on the day it was harvested.")
    print("     F-F, measured by the coordinator over the table: eight distinct containment pairs")
    print("     exist and six are between proofs that also name the SAME test, so for those the")
    print("     refusal adds nothing beyond `the named test failed` — which is the state F-2")
    print("     exists to improve on. It is not a hole, because each plant runs in its own tree")
    print("     carrying only its own defect, so the assertion that fires is still that plant's;")
    print("     it is the claim being weaker for those proofs than this limitation reads.")
    # U-05, the seventeenth review: this limitation used to state "88 of those
    # 91", a figure no command reproduced. The counts are DERIVED here, from the
    # table itself, by predicates the next reader can apply by hand: a BARE
    # expectation is one whose text after the exception class is nothing but
    # `expected: <…> but was: <…>`, and a FRAGMENT expectation is one stored as
    # a tuple. A figure in prose that no command reproduces is the shape this
    # lane keeps finding, and a printed figure is the only kind worth stating.
    bare = sorted(
        law for law, text in EXPECTED_REFUSAL.items()
        if isinstance(text, str) and BARE_ASSERTION.fullmatch(text) is not None
    )
    fragments = sorted(law for law, text in EXPECTED_REFUSAL.items() if isinstance(text, tuple))
    named = len(EXPECTED_REFUSAL) - len(bare) - len(fragments)
    print(f"  8. {named} of those {len(EXPECTED_REFUSAL)} refusals name the law or the refusal in")
    print(f"     prose. {len(bare)} are bare assertion text carrying the values that identify")
    print(f"     them ({', '.join(bare)}), and {len(HARM_IS_NONDETERMINISTIC)} (P7-L8) is exempted")
    print("     from freezing its values because its own plant draws them — an exemption this")
    print("     harness measures against the plants, in both directions.")
    if fragments:
        print(f"     {len(fragments)} are frozen as FRAGMENTS rather than whole, around a")
        print("     coordinate that moves when a line is added above it:")
        print(f"     {', '.join(fragments)}.")
    else:
        print("     NONE is frozen as fragments. U-03 retired that form: fragments pinned the")
        print("     prose on either side of a coordinate and stopped pinning the SET between")
        print("     them, so a refusal listing a second offender matched. The coordinate is")
        print("     normalised on both sides now and the message is frozen WHOLE.")
    print("  9. The omission arm deletes the print loop on a copy and requires a refusal, so")
    print("     that line is load-bearing twice over — but the ARM's own removal is bounded")
    print("     by review and not by measurement. What IS measured is the arms' census: the")
    print(f"    count is pinned at {GUARD_BRANCHES_THIS_HARNESS_DECLARES} as a literal, so an arm")
    print("     deleted or added is a refusal by name rather than a lower `N of N` that still")
    print("     reads as armed — measured by deleting one and reading")
    print("     REFUSED-P7-GUARD-BRANCH-CENSUS. The literal itself is bounded by review, and")
    print("     that is where this regress stops; it is named here rather than left to a reader.")
    print(" 10. A SIGNAL does not run a `finally`. SIGTERM and SIGINT are handled: this run's")
    print("     trees are scrubbed and the signal is then re-raised with its default")
    print("     disposition, so the exit status is the signal's own. SIGKILL CANNOT be closed")
    print("     from inside — nothing of this process runs after it — so a run killed")
    print("     with -9 leaves its trees, and the next run refuses above one whole run's worth")
    print(f"    ({one_runs_worth_of_trees()}, derived from the proof count, not written down)")
    print("     rather than noting them and exiting 0. Every prefix this harness creates under is")
    print("     in ONE tuple that the census reads and that `a_tree` refuses to go outside, so")
    print("     the sentence above is true of all four and not of three (F-I).")
    return 0


if __name__ == "__main__":
    arm_the_signal_handlers()
    _am_the_self_test_child = "--self-test" in sys.argv
    try:
        _code = self_test() if _am_the_self_test_child else main()
    except CannotRead as _refusal:
        # F-O, the coordinator's review of `72e6af4`: `a_tree`'s own prefix
        # refusal reached the operator as an uncaught traceback with the name
        # buried in it. This lane refuses BY NAME, and a name at the end of a
        # traceback is not one. Only CannotRead: it is this harness's own
        # refusal type, and catching anything wider would swallow the bugs a
        # traceback is the right answer to.
        print(f"{_refusal}", flush=True)
        _code = 1
    _earlier = strays_from_earlier_runs()
    _left = scrub_all()

    # The coordinator's S-4 on `9809db1`: these verdicts lived here as inline
    # branches, outside the guard-branch census, which is F-G's shape one layer
    # out. They are now functions the census reaches, and this block only
    # prints what they decide and ORs the exit code. Order is kept: leftovers
    # first, then the TREES line, then this run's own prediction, then strays.
    _leftover = the_leftover_verdict(_left)
    if _leftover is not None:
        print(_leftover[0])
        _code = _code or 1
    elif TREES_THIS_RUN or not _am_the_self_test_child:
        # R18-03, first limb. `main()` runs the self-test as a SUBPROCESS and
        # relays its output; the child reaches this same block and printed the
        # same sentence, unprefixed. Measured by the eighteenth challenge on an
        # interrupted run: the ONLY `TREES:` line in the log was the child's
        # `0 made, 0 removed, 0 left`, printed while the parent had trees on
        # disk — so a reader, or a `grep TREES:`, was handed a confirmation
        # that nothing leaked by the one process that could not have leaked
        # anything. The child made no trees, so it now says nothing, and the
        # relay marks every line it does print. Both halves: either alone
        # leaves the other readable as the parent's.
        print(
            f"TREES: {len(TREES_THIS_RUN)} made, {len(TREES_THIS_RUN)} removed, 0 left — "
            f"confirmed by looking, not by assuming the call worked."
        )
        _prediction = the_prediction_verdict(
            len(TREES_THIS_RUN), _am_the_self_test_child, _code
        )
        if _prediction is not None:
            print(_prediction[0])
            _code = _code or 1

    _strays = the_strays_verdict(_earlier)
    if _strays is not None:
        print(_strays[0])
        if _strays[1]:
            _code = _code or 1
    sys.exit(_code)
