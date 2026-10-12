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
        find="                    listOf(SideEffect.SendAttempt(id, payloadDigest, attempts + 1)),",
        replace='                    listOf(SideEffect.SendAttempt(id + "-" + (attempts + 1), payloadDigest, attempts + 1)),',
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
        find="            } else if (effect.isMaterial) {\n                // Abandoning a financial or stock operation that the server\n                // may hold is not a decision the device may record.\n                Step.Refused(\"offline.material_cannot_be_abandoned\", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)",
        replace="            } else if (false) {\n                Step.Refused(\"offline.material_cannot_be_abandoned\", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)",
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
        find="        if (event is QueueEvent.ByScope && event.actingScope != scope) {",
        replace="        if (event is QueueEvent.ByScope && event.actingScope != event.actingScope) {",
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
        find="        for (acting in listOf(scope, foreignScope)) {",
        replace="        for (acting in listOf(scope)) {",
        expect_red="every reachable configuration honours every invariant",
        why="the model check stops offering the kernel another account's session; every invariant still passes, so only the non-vacuity count distinguishes a search that proved INV-9 from one that never tested it",
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
        find="""            } else if (event.digestNow != payloadDigest) {
                Step.Refused(
                    "offline.restored_payload_does_not_match_capture",""",
        replace="""            } else if (event.digestNow != event.digestNow) {
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

    failures: list[str] = []
    for i, proof in enumerate(PROOFS, start=1):
        tree = tempfile.mkdtemp(prefix=f"p7-proof-{i}-")
        for part in ("src", "test"):
            shutil.copytree(os.path.join(ROOT, part), os.path.join(tree, part))
        target = os.path.join(tree, proof.path)
        before = open(target, encoding="utf-8").read()

        hits = before.count(proof.find)
        if hits != 1:
            failures.append(
                f"{proof.law}: the mutation pattern matched {hits} times in {proof.path} "
                f"(must be exactly 1) — THE MUTATION DID NOT LAND, so this proof measured nothing"
            )
            print(f"  [{i:2}] {proof.law}\n       MUTATION DID NOT LAND ({hits} matches)")
            continue
        after = before.replace(proof.find, proof.replace)
        if after == before:
            failures.append(f"{proof.law}: replacement produced an identical file")
            continue
        open(target, "w", encoding="utf-8").write(after)

        rc, failing, log = run_suite(tree)
        named = any(proof.expect_red in name for name in failing)
        if rc == 0:
            failures.append(f"{proof.law}: the suite stayed GREEN with the defect planted — the law is undefended")
            verdict = "STAYED GREEN"
        elif not named:
            failures.append(
                f"{proof.law}: the suite went red but '{proof.expect_red}' did not fail "
                f"(failed instead: {sorted(failing) or 'nothing named — did it compile?'})"
            )
            verdict = "RED, BUT NOT THE NAMED TEST"
        else:
            verdict = f"RED as required ({len(failing)} case(s) failed)"
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
