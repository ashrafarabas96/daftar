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

import os
import re
import shutil
import subprocess
import sys
import tempfile
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
    edits: tuple[tuple[str, str], ...] = ()
    """Further (find, replace) pairs applied after the one above, in order.

    A defect that is one edit in one place is one edit here, which is every
    proof written before the eleventh review. Some of that review's plants are
    not: "the companion object moved to the end of the class" is a deletion and
    an insertion, and each of its plants has to be paired with the HARM it used
    to let through, because the edit alone is now a no-op and a proof whose
    mutation changes nothing measures nothing. Every pair is held to the same
    rule as the first — matched literally, exactly once, and a miss is a FAILED
    proof — so a multi-edit plant cannot half-land.
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
        why="challenger finding G-01, restored: the fix for F-01 distinguished presence from absence and not presence from CURRENCY. A row restored from a backup reads attempts == 0, which is the one held value that permits, and attempts only ever increases \u2014 so the sale released, sent and committed after the backup was taken is re-entered under a new key and the customer pays twice, from a store that has already declared it cannot vouch for itself",
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
        why="challenger finding G-02, restored: the one open exit closes, so a sale Alice captured while the till was offline and never released is unsendable (CAPTURED is not a sendable state), unreleasable, uncancellable, unresolvable and unminimizable once her session is revoked \u2014 seven refusals and a material row that can never settle, which L4 and L5 forbid dropping",
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
        why="challenger finding G-03's practical risk: a real refusal loses its view and falls through to the generic device-software message. The named allow-list must not be able to swallow it \u2014 the merchant would be told the till is broken instead of that the original sale is still being confirmed, and would key the sale in again",
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
        why="challenger finding H-01, restored exactly: the release moves back into the ungated arm, so any member of the business may CONFIRM a capture they cannot be shown to have witnessed. A release is the step that turns a capture into a ledger entry, and an unconfirmed capture may equally be a basket the customer walked away from \u2014 so this is the one unlock of the two that can invent a sale, which is why the cancel is the one that is open",
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
        why="challenger finding I-01, restored exactly: the second cancel of a row that was abandoned before anything was sent is answered with the code whose merchant view says an attempt is out and to wait for it. The cashier \u2014 who may be the colleague of whoever abandoned it seconds earlier \u2014 is told to wait for a sale that will never arrive, which is the re-key harm the merchant-view work exists to prevent. G-03 proved every code HAS a view; this is the next clause, that a code can have a view and still be the wrong code",
    ),
    Proof(
        law="INV-14-THE-RECORD-SAYS-WHAT-WAS-DONE",
        path="src/app/daftar/offline/Queue.kt",
        find='                id, scope, event.actingScope, event::class.simpleName.orEmpty(),',
        replace='                id, scope, event.actingScope, "CancelByMerchant",',
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding I-02: three of the record\u2019s fields were asserted and the fourth \u2014 the one that says what was done \u2014 was not, so a constant label passed the whole suite and recorded a foreign SEND as a cancel. The expectation now comes from a literal per event rather than from the kernel\u2019s own expression, because a check that re-derives its answer the way the subject does agrees with any edit to it",
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
        why="challenger finding I-03, which was a missing proof rather than a defect: `attempts == 0` masks `!isTerminal` on the path a reviewer checks (SYNCED is unreachable with no attempt), so the only state the second condition defends is DISCARDED \u2014 and nothing covered it. Mutated, a second cancel moves again and emits a second clear and a second custody record for one key, which an audit with no sequence on the record cannot tell from one cancel",
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
        why="challenger finding J-01, restored exactly: a release of a row that was abandoned, or that the server has already recorded, or that is waiting on a person, is answered \u201calready confirmed, wait for it\u201d. On the shared till H-01 opened, that is I-01 one button over \u2014 Bob abandons Alice\u2019s capture, somebody presses confirm, and the till says the sale exists and to wait for it, both halves false, same row, same double tap",
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
        why="challenger finding J-02, restored exactly: `isMaterial` is FINANCIAL or INVENTORY, and an inventory capture is a movement or a stocktake count \u2014 a quantity and a unit, with no minor units and no currency. Requiring them makes fabricating a currency a precondition of storing a stocktake, which is what my own fixtures did: seven units of stock denominated in riyals in one file and lira in another, in the field the record exists to add",
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
        why="coordinator finding D-01, restored exactly: the merchant is told to wait for a fenced absence, and the fence is a server capability the merchant API does not have, so the wait is for something nobody is building and no device is doing. L20\u2019s clause was widened to every refusal while its only guard watched Operation.step, and re-entry refuses from somewhere else \u2014 which is why this proof plants in the layer the invariant could not see",
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
        why="D-01\u2019s other half: a refusal that is not a wait starts telling the merchant to wait. The sweep takes its subjects from the kernel\u2019s own source and compares the set of waiting refusals for EQUALITY against the ones the model check proved are reachable only while something is pending, so a code added anywhere \u2014 in a layer written after this round \u2014 is judged by absence rather than by a list someone has to remember to extend. What this plant does NOT show, and the round-seven review was right to say so, is the one direction only that sweep can cover: `offline.another_members_capture` is returned by `Operation.step`, so the per-layer invariant over the reachable space sees it too and either guard would have caught this plant. It is kept because it measures the sweep end to end \u2014 source literal, view, instruction, equality \u2014 and the direction no per-layer guard reaches is measured separately by E-03-A-CODE-NO-QUEUE-STATE-EVER-PRODUCES",
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
        why="coordinator finding C-02\u2032: the Send arm goes back to answering every non-sendable state with one code, so a row the server has already recorded, and one a colleague abandoned, are both answered NOT_READY_TO_SEND / CONFIRM_THE_CAPTURE \u2014 the till offers a cashier the button for a sale that is finished. The doc sentence on refusalForAFinishedRow said \u2018whatever was asked of it\u2019 while three arms out of six consulted it, so the invariant is asserted over the whole reachable space rather than arm by arm",
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
        why="coordinator finding D-02, measured by the coordinator as green before this round: the textual guard watched for a PARAMETER DEFAULT, and an overload omits the same facts without one. With this plant a pre-round four-argument FINANCIAL call site compiles again and throws at the till, which is J-03\u2019s exact harm through the one door the guard did not watch \u2014 so the guard now counts the ways in rather than checking the shape of one of them",
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
        why="coordinator finding C-02\u2032: the gate refuses on two grounds \u2014 a business that is not the row\u2019s, which is never relaxed, and a colleague\u2019s capture inside one business, which is gated only for the three committing events \u2014 and with one code the second is told SIGNED_IN_TO_ANOTHER_BUSINESS and to switch back to the owning account. It is the same business, and the account named is a colleague\u2019s; a cashier who follows that instruction is being sent to sign in as someone else",
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
        why="challenger finding K-02, in one file instead of two: the classifier answers an expired session with a code that is ASSEMBLED rather than written, and the code it assembles is one whose view tells the merchant an attempt is out and to wait for it. The literal sweep in RecoveryTest cannot see a code that is not a literal, and the challenger measured exactly this shape staying green \u2014 so the subjects of this layer\u2019s judge are the codes `classify` actually returns over its own exhaustive input space, not the strings its source contains",
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
        why="challenger finding K-03: the declaration counter read `Queue.kt` alone, and a second way to capture without stating what the operation is worth does not have to live in that file. This plant puts a four-argument `capture` in another kernel source, in the same package, where it resolves for any caller in the module and passes null for both facts \u2014 D-02\u2019s harm one file over. The guard\u2019s subject is now the whole source set, the way the refusal-vocabulary sweep already takes it",
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
        why="coordinator finding E-03, the direction proof 57 did not reach. `offline.session_expired` is not a queue state: no `Operation.step` returns it, so the model check\u2019s reachable space cannot contain it \u2014 it arrives from the server\u2019s answer, through the outcome classifier, and the merchant meets it only as a view. Planted here, a till whose session has ended is told its sale is in progress and to wait, while nothing is pending and nothing will be until somebody signs in. Every per-layer guard stays green, because the code never passes through the layer they watch; only a sweep whose subjects are the kernel\u2019s own literals can see it, and this is the measurement that it does",
    ),
    Proof(
        law="E-04-A-REFUSAL-MAY-NOT-OFFER-A-BUTTON-ITS-READER-CANNOT-PRESS",
        path="src/app/daftar/offline/Queue.kt",
        find="                    ?: refusalForACaptureSomebodyElseMustConfirm(event.actingScope)\n",
        replace="",
        expect_red="every reachable configuration honours every invariant",
        why="coordinator finding E-04. Without this arm the next shift\u2019s send of a colleague\u2019s CAPTURED row falls through to `offline.not_sendable`, whose view tells the merchant to confirm the capture \u2014 the one thing L13 forbids that session from doing, so the till shows a button that refuses when pressed. The invariant now asks of every `not_sendable` in the reachable space whether its reader could act on it, computing the answer from the acting scope with the test\u2019s own permission function rather than reading it back from the kernel",
    ),
    Proof(
        law="L-01-A-CLAIM-ABOUT-A-CODE-NOTHING-PRODUCES-IS-A-CLAIM-ABOUT-NOTHING",
        path="src/app/daftar/offline/Queue.kt",
        find="        if (state == OperationState.CAPTURED && !acting.mayAct(scope, QueueEvent.Release(acting))) {",
        replace="        if (state == OperationState.CAPTURED) {",
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding L-01, the hole inside E-04\u2019s own fix. E-04\u2019s assertion is an implication \u2014 if the code is `offline.not_sendable`, then the row is CAPTURED and its actor may confirm it \u2014 and `Queue.kt` has exactly one producer of that code, in the arm this helper sits above. A helper that fires for EVERY CAPTURED row therefore leaves the implication true of nothing: the suite stayed green while the cashier who captured the sale was told another member must confirm it, on their own row, on their own till. The review\u2019s own bound is why this plant is this shape: the plain inversion, keeping the conjunction, is already red on the invariant, so the hole was exactly one shape wide. The observability loop now covers every code this check makes a conditional claim about, not only the four honest-wait codes",
    ),
    Proof(
        law="M-01-O-01-A-CLAIM-IS-ENROLLED-BY-BEING-EVALUATED",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=A_CLAIM_ABOUT_AN_UNPRODUCED_CODE,
        expect_red="every reachable configuration honours every invariant",
        why="challenger finding M-01, and the review\u2019s own plant: one more conditional claim, about `offline.permission_revoked`, which reaches a row only as `lastCode` and never as `step.code`. The review measured it green at 98 of 98 against a hand-written five \u2014 L-01 again, inside the guard L-01 produced. Three heads enrolled it by SWEEPING THIS FILE\u2019S TEXT, and the eleventh review then defeated the sweep four ways. The site is enrolled by being EVALUATED now: `claimAbout` registers the code before deciding whether the claim applies, so the plant registers `offline.permission_revoked`, the registry no longer equals its literal total, and the check says which code arrived and which went missing",
    ),
    Proof(
        law="O-01-AN-ASSEMBLED-CODE-REGISTERS-THE-VALUE-IT-TESTS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace=a_claim_about('"offline." + "permission_revoked"'),
        expect_red="every reachable configuration honours every invariant",
        why="challenger findings qA and qE of the eleventh review, and the sharpest of them, because the file USED this escape itself: the literal sweep matched a code written as one string, so a code assembled (`\u201coffline.\u201d + \u201cpermission_revoked\u201d`) or interpolated was not enrolled \u2014 and the sweep\u2019s own prose sentinel was assembled three lines above it precisely so the sweep would not see it. A technique a file relies on to hide a string from its own guard is available to whoever writes the next claim. Execution registers the VALUE, so the assembled code is enrolled exactly as the written one is, and the review would not report its green until a control showed the construct live",
    ),
    Proof(
        law="O-01-A-CLAIM-WHOSE-REGISTRATION-IS-REMOVED-IS-A-CLAIM-NOTHING-BOUNDS",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find=CLAIM_SITE,
        replace='                            if (step.code == "offline.not_sendable") {',
        expect_red="every reachable configuration honours every invariant",
        why="the first proof the coordinator required of the registry, and the one that makes it a derivation rather than a convention. A claim written the old way \u2014 the bare equality, no helper \u2014 asserts everything it asserted before and registers nothing, so `claimsMade` loses `offline.not_sendable` and the literal total is not met. The previous four anchors asked whether the derivation still found something and this asks whether it lost anything, which is the ruling: an anchor must BOUND THE LOSS, because a set that survives is not a set that was not reduced",
    ),
    Proof(
        law="O-01-THE-COMPANION-S-SPELLING-IS-NOT-PART-OF-THE-GUARD",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="    private companion object {",
        replace="    companion object {",
        expect_red="every reachable configuration honours every invariant",
        why="plant qC of the eleventh review, paired with the harm. The old sweep cut the companion object out of the text before reading it, by `indexOf(\u201cprivate companion object {\u201d)`; dropping `private` \u2014 a widening nobody would read as a weakening \u2014 made the needle miss, the brace walk excised 728 lines, and the enrolled set fell to two codes with the suite green at 98 of 98. Nothing reads the file now, so the respelling is a no-op and the harm it used to admit reds by name. The edit alone would measure nothing, which is why this proof carries two",
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
        why="plant qG of the eleventh review in its mechanism, paired with the harm. qG moved the companion object to the end of the class \u2014 instruments after the thing they serve, a normal ordering, the declaration spelled character for character \u2014 and `indexOf` then matched ITS OWN SOURCE LINE, excising 739 lines, more than half the file, with the enrolled set down to the two codes the anchor happened to check. The defect is that a text in the file which LOOKS like the declaration is indistinguishable from it, which this plant states directly and in two lines rather than by relocating fifty. The relocation itself was measured separately at this head and is recorded in the evidence; here the point is that no line of this file decides what is enrolled",
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
        why="plant qD of the eleventh review, paired with the harm. The sweep stripped comments before reading the file so that prose could not be load-bearing (N-03), and a STRING holding a comment-opening sequence is not a comment: the block regex ran from that literal to the next closing sequence and deleted 596 lines, with three codes left enrolled and the suite green. The review predicted the two-code anchor would catch this and wrote that prediction down before the run; it did not, because both anchored codes also occur outside the swallowed region \u2014 containment is not survival. The stripper is deleted at this head, along with the sweep it served, so the literal is inert and the harm reds",
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
            '                            }\n                            if (event is QueueEvent.ByScope &&',
            '                            }\n                            }\n'
            '                            if (event is QueueEvent.ByScope &&',
        ),),
        expect_red="every reachable configuration honours every invariant",
        why="the twelfth review's blocker, and the only FAIL-OPEN this phase has had since L-01. The site is wrapped in a condition that is REACHED \u2014 UNKNOWN_OUTCOME rows do reach that arm and do produce refusals, so the registration fires and the registry's equality is satisfied \u2014 while `offline.not_sendable` is produced only on CAPTURED rows, so the body runs ZERO times. The review then planted proof 64's own harm underneath it, E-04's refusal arm deleted, and measured the pair GREEN at 98 of 98 against rc 1 red by name on a clean subject: a cashier's own capture refused with \u201canother member must confirm this\u201d, with every assertion in the file passing. The observability loop cannot see it either, because the code IS produced \u2014 by the rows the conditioned site no longer looks at. `claimsExercised` records the branch that actually runs the claim, so this plant now reds by name on the site that never exercised. **A registration certifies that a site ran; only the branch inside it certifies that anything was tested.**",
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
        why="the twelfth review's P-03, filed latent and fixed as filed. A second LAWFUL claim about `offline.not_sendable` is added and the original site's registration is removed, its claim left as a bare equality. Keyed on CODES the two sites collapsed into one member, so the set was unchanged and the removal was invisible \u2014 green at 98 of 98 \u2014 while this check's own KDoc promised that a removed registration reddens. No code has two sites today; the promise is what made that latent rather than harmless. The registry is keyed on (site, code) PAIRS now, which is the coordinator's amendment that an anchor bounds the loss of the thing that can be LOST, and what can be lost is a site",
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
        why="the residual this session disclosed and the twelfth review measured: a conditional claim written AROUND the helper is enrolled by neither registry, so this exact plant \u2014 the tenth review's \u2014 was green at 98 of 98 on the head before this one, with its control (the same construct, a produced code, a false assertion) rc 1 red by name, so the green was genuine vacuity. This is the proof that was RETIRED one round ago because it could no longer redden, and it is restored here reddening through the CONVENTION CHECK the coordinator ruled in: that check derives nothing, states its own fail-open in its message, and can only ADD reds \u2014 a subject set steered by text yields a false green, a prohibition steered by text yields nothing, so its worst case is the residual it replaces. Note which test it reds: the convention check, not the registry",
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
        why="plant qB of the eleventh review, and the one that showed the previous head\u2019s governance was keyed to a LOCATION. The three assertions that make an exemption a claim of its own were sound; what carried them was a sweep of this file with the companion cut out, so declaring the map in the class body instead \u2014 legal, and what anyone does consolidating a test\u2019s data \u2014 swept the key into the set the key was then checked against, `key in claimed` true of its own input, and the hole N-02 was written to close was one `private val` away from open. The exemption is read as a VALUE from wherever it is declared now, and this plant reds by name with the stale key named",
    ),
    Proof(
        law="O-03-A-CLAIM-SITE-NOTHING-EVALUATES-REGISTERS-NOTHING",
        path="test/app/daftar/offline/QueueModelCheckTest.kt",
        find="                            if (op.isTerminal &&",
        replace="                            if (false && op.isTerminal &&",
        expect_red="every reachable configuration honours every invariant",
        why="the honest cost of deriving the subject set from EXECUTION, measured here rather than left for the next review to find \u2014 and the review said it would attack exactly this. A claim site in a branch nothing reaches registers nothing, so INV-15\u2019s two codes would vanish from `claimsMade` as quietly as a missed spelling once did. That is what the literal total is for: the registry is asserted for EQUALITY, so the two codes go missing by name. The site\u2019s own non-vacuity assertion (`terminalRefusals > 0`) is the second net, and the registry equality is asserted first so the message a reader sees names the codes",
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
]

FAILURE_LINE = re.compile(r"^\s+JUnit Jupiter:(\S+):(.+)\(\)\s*$")


def run_suite(tree: str) -> tuple[int, set[str], str]:
    """Compile and run the suite in `tree`. Returns (rc, failing test names, log)."""
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
    return proc.returncode, failing, log


def main() -> int:
    baseline_tree = tempfile.mkdtemp(prefix="p7-baseline-")
    for part in ("src", "test"):
        shutil.copytree(os.path.join(ROOT, part), os.path.join(baseline_tree, part))
    rc, failing, log = run_suite(baseline_tree)
    if rc != 0:
        print("BASELINE IS NOT GREEN — no red proof means anything against a red tree.")
        print(log[-4000:])
        return 1
    tests = re.search(r"\[\s*(\d+) tests successful", log)
    baseline_cases = int(tests.group(1)) if tests else 0
    print(f"BASELINE: exit 0, {baseline_cases} cases green\n")

    # One proof per tree, and the trees are independent, so they run in
    # parallel. This is scheduling, not correctness: every proof does exactly
    # what it did sequentially, in its own copy, and the verdicts are printed
    # in order so two runs read the same. It matters because an independent
    # reviewer could not FINISH the sequential run — it timed out at 21 of 27
    # with no exit code, and a proof harness nobody can run to completion
    # proves nothing to anybody but its author.
    workers = max(1, min(len(PROOFS), (os.cpu_count() or 2)))

    def run_one(indexed: tuple[int, Proof]) -> tuple[int, Proof, str | None, str]:
        """Returns (index, proof, failure or None, verdict line)."""
        i, proof = indexed
        tree = tempfile.mkdtemp(prefix=f"p7-proof-{i}-")
        for part in ("src", "test"):
            shutil.copytree(os.path.join(ROOT, part), os.path.join(tree, part))
        target = os.path.join(tree, proof.path)
        after = open(target, encoding="utf-8").read()

        for n, (find, replace) in enumerate(((proof.find, proof.replace),) + proof.edits, start=1):
            hits = after.count(find)
            if hits != 1:
                return (
                    i,
                    proof,
                    f"{proof.law}: edit {n} matched {hits} times in {proof.path} "
                    f"(must be exactly 1) — THE MUTATION DID NOT LAND, so this proof measured nothing",
                    f"MUTATION DID NOT LAND (edit {n}, {hits} matches)",
                )
            before = after
            after = after.replace(find, replace)
            if after == before:
                return (
                    i, proof,
                    f"{proof.law}: edit {n} produced an identical file",
                    f"REPLACEMENT WAS A NO-OP (edit {n})",
                )
        open(target, "w", encoding="utf-8").write(after)

        rc, failing, _log = run_suite(tree)
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
        return (i, proof, None, f"RED as required ({len(failing)} case(s) failed)")

    print(f"Running {len(PROOFS)} proofs across {workers} worker(s); each in its own tree.\n")
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = sorted(pool.map(run_one, enumerate(PROOFS, start=1)), key=lambda r: r[0])
    for i, proof, failure, verdict in results:
        if failure is not None:
            failures.append(failure)
        print(f"  [{i:2}] {proof.law}\n       plant: {proof.why}\n       expect red: {proof.expect_red}\n       {verdict}")

    # §83: the baseline must RESTORE green. Each proof ran in its own copy, so
    # nothing could have leaked into the original — but "could not have" is an
    # argument, and this is a measurement. It also catches the case the argument
    # misses: a proof that reached outside its copy.
    rc, _, log = run_suite(baseline_tree)
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

    print(f"ALL {len(PROOFS)} RED PROOFS SATISFIED over a {baseline_cases}-case green baseline.")
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
