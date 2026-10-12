package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A model check of the queue, not a walk through a few scenarios.
 *
 * Every configuration reachable from a fresh capture, under every event, is
 * enumerated breadth-first, and the invariants below are asserted at every
 * edge. A hand-written scenario proves the path someone thought of; the
 * failure that loses a sale is on the path nobody thought of — a process death
 * during the retry of an operation whose answer was already lost once, say.
 *
 * ── Why enumerating representative answers is still exhaustive ────────────
 *
 * The reducer never sees a status code. It sees a `Decision`, because it calls
 * `Outcome.classify` and branches on the result. So the reducer's reachable
 * space is determined by the set of DECISION SHAPES, not by the 700 x 11 x 3 x 8
 * answers that produce them. `the representative answers cover every decision
 * shape the classifier can produce` below closes that gap by sweeping the full
 * answer space and proving every answer's decision shape is one of the shapes
 * the representatives here produce. The two tests together are a proof over
 * the whole input space; either alone is not, and that is why neither is
 * allowed to be deleted quietly — each names the other.
 */
class QueueModelCheckTest {
    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private val digest = "sha256:0d5f1f2b"
    private val wrongDigest = "sha256:deadbeef"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    /**
     * The same till after the staff member switched to the other business they
     * are a member of. Every session-originated event is enumerated under BOTH
     * scopes, so the search decides whether a foreign scope can move anything
     * rather than taking L13's word for it.
     */
    private val foreignScope = OwnerScope("tenant-1", "business-2", "member-1")

    /**
     * The same till, same business, after the shift changed — the one
     * configuration challenger finding F-05 made legal. Enumerating it is what
     * makes INV-2's claim about the send's scope falsifiable: before it existed
     * no permitted event ever acted under a scope other than the row's, so an
     * effect that took its business from the EVENT instead of the ROW moved
     * nothing in this search and nothing here could see it.
     */
    private val nextShiftScope = OwnerScope("tenant-1", "business-1", "member-2")

    /**
     * What L13 permits, written out here rather than asked of the kernel.
     *
     * Calling `mayAct` would make this test agree with whatever the gate says,
     * which is not a check. Tenant and business are the half of the source
     * identity the server cannot validate, so they are required for every
     * event; the member is a decision boundary, so it is required for the
     * events where a person decides something and not for a transmission.
     */
    private fun permittedToAct(acting: OwnerScope, owner: OwnerScope, event: QueueEvent.ByScope): Boolean =
        acting.tenantId == owner.tenantId &&
            acting.businessId == owner.businessId &&
            (
                event is QueueEvent.Send ||
                    event is QueueEvent.CancelByMerchant ||
                    acting.memberId == owner.memberId
                )

    /**
     * What the custody record's `event` label must say, written out here
     * rather than computed the way the kernel computes it.
     *
     * Challenger finding I-02. INV-14 asserted three of the record's four
     * fields and left the one that says WHAT was done, so replacing the label
     * with the literal "CancelByMerchant" passed the whole suite and recorded a
     * foreign SEND as a cancel. Asserting `event::class.simpleName` against
     * `event::class.simpleName` would have agreed with any such edit, which is
     * the same reason `permittedToAct` above does not call `mayAct`: a check
     * that re-derives its expectation the way the subject does is not a check.
     * These are literals, one per event the gate lets through, and a `when`
     * with no `else` so an event added later is a compile error here.
     */
    private fun expectedCustodyLabel(event: QueueEvent.ByScope): String = when (event) {
        is QueueEvent.Release -> "Release"
        is QueueEvent.CancelByMerchant -> "CancelByMerchant"
        is QueueEvent.Send -> "Send"
        is QueueEvent.ResolveByMerchant -> "ResolveByMerchant"
        is QueueEvent.RestorePayload -> "RestorePayload"
    }

    /**
     * Merchant messages that assert bytes left the device, each with the reason
     * it does.
     *
     * Challenger finding I-01, and the next clause of the law G-03 opened: that
     * one proved every refusal code HAS a view, and a code can have a view and
     * still be the wrong code. A refusal produced before any attempt cannot
     * honestly carry one of these, because nothing has been transmitted to be
     * in progress. The set is small on purpose — it names only what `explain`
     * can actually produce, so an entry here is a message a refusal could
     * really be given, not a hypothetical.
     */
    private val assertsSomethingLeftTheDevice = mapOf(
        MerchantMessage.CANNOT_CANCEL_AFTER_SENDING to
            "it tells the merchant an attempt is out and they must wait for its answer",
    ).keys

    /**
     * The captured facts, DIFFERENT for each effect class on purpose.
     *
     * Challenger finding I-04 asks that the custody record describe what was
     * destroyed, and finding I-02 is the reason these are not one constant: a
     * record that hardcoded any single amount would satisfy an equality check
     * against a fixture that used the same one everywhere. Three roots with
     * three amounts and three currencies mean a constant can match at most one
     * of them.
     */
    private fun amountFor(effect: EffectClass): Long = when (effect) {
        EffectClass.FINANCIAL -> 12_500
        EffectClass.INVENTORY -> 7
        EffectClass.BENIGN -> 0
    }

    private fun currencyFor(effect: EffectClass): String = when (effect) {
        EffectClass.FINANCIAL -> "SAR"
        EffectClass.INVENTORY -> "TRY"
        EffectClass.BENIGN -> "USD"
    }

    /** One representative answer per branch of the classifier. */
    private val answers: List<AttemptResult> = listOf(
        AttemptResult.Answered(200, null, true, null), // synced, replayed
        AttemptResult.Answered(201, null, null, null), // synced, first write
        AttemptResult.Answered(429, null, null, 30), // told to wait
        AttemptResult.Answered(503, null, null, null), // broke; unknown
        AttemptResult.Answered(409, "IDEMPOTENCY_KEY_REUSED", null, null), // divergence
        AttemptResult.Answered(409, "inventory.insufficient_stock", null, null), // business refusal
        AttemptResult.Answered(401, null, null, null), // session gone
        AttemptResult.NoAnswer, // no answer at all
    )

    private fun events(): List<QueueEvent> = buildList {
        for (acting in listOf(scope, foreignScope, nextShiftScope)) {
            add(QueueEvent.Release(acting))
            add(QueueEvent.CancelByMerchant(acting))
            add(QueueEvent.Send(digest, acting))
            add(QueueEvent.Send(wrongDigest, acting))
            add(QueueEvent.ResolveByMerchant(true, acting))
            add(QueueEvent.ResolveByMerchant(false, acting))
            add(QueueEvent.RestorePayload(digest, acting))
            add(QueueEvent.RestorePayload(wrongDigest, acting))
        }
        add(QueueEvent.ProcessDeath)
        add(QueueEvent.RetentionDeadlineReached)
        answers.forEach { add(QueueEvent.Observe(it)) }
    }

    /** The part of a configuration that is not the operation itself. */
    private data class History(val serverCommitted: Boolean, val everSent: Boolean)

    private fun fingerprint(op: Operation, h: History): String =
        "${op.id}|${op.scope}|${op.effect}|${op.payloadDigest}|${op.amountMinorUnits}|${op.currency}|" +
            "${op.state}|${op.attempts}|${op.lastCode}|" +
            "${op.replayed}|${op.payloadMinimized}|${h.serverCommitted}|${h.everSent}"

    @Test
    fun `every reachable configuration honours every invariant`() {
        // Attempts are bounded for the search only. Beyond a few attempts the
        // configuration repeats in every respect except the counter, so the
        // bound loses no reachable BEHAVIOUR — and `attempts never decrease`
        // is asserted on every edge regardless of the bound.
        val attemptBound = 4
        var edges = 0
        var refusals = 0
        val statesSeen = mutableSetOf<OperationState>()
        var foreignScopeRefusals = 0
        var nextShiftSends = 0
        var releasesOfAnUnsentRow = 0
        var custodyRecords = 0
        var refusalsWithNothingSent = 0
        var custodyRecordsBeforeAnErase = 0
        val eventsThatMoved = mutableSetOf<String>()
        val effectsSeen = mutableSetOf<String>()

        for (effect in EffectClass.entries) {
            val start = Operation.capture(
                key, scope, effect, digest, amountFor(effect), currencyFor(effect),
            ) to History(false, false)
            val visited = mutableSetOf(fingerprint(start.first, start.second))
            val frontier = ArrayDeque(listOf(start))

            while (frontier.isNotEmpty()) {
                val (op, history) = frontier.removeFirst()
                statesSeen += op.state
                for (event in events()) {
                    edges++
                    when (val step = op.step(event)) {
                        is Step.Refused -> {
                            refusals++
                            if (event is QueueEvent.ByScope &&
                                !permittedToAct(event.actingScope, op.scope, event)
                            ) {
                                foreignScopeRefusals++
                                // INV-9a: a foreign scope is refused AS a scope
                                // problem, never as a payload or a sequencing
                                // one, so the merchant is not told their sale
                                // is corrupt when they are simply signed into
                                // the wrong business.
                                assertEquals(
                                    "offline.scope_switched", step.code,
                                    "a foreign-scope $event was refused as ${step.code}",
                                )
                                assertEquals(P7Laws.NO_CROSS_ACCOUNT_SEND.id, step.law)
                            }
                            // INV-9b: a refusal produced before anything was
                            // ever sent never reaches the merchant as "an
                            // attempt is out, wait for it". INV-9a judges
                            // whether a refusal is the RIGHT refusal on one
                            // axis (a foreign scope is a scope problem); this
                            // is the same question on the axis I-01 found,
                            // where a second cancel of an abandoned row was
                            // answered with CANNOT_CANCEL_AFTER_SENDING and a
                            // cashier was told to wait for a sale nobody will
                            // send. It is asserted over the whole reachable
                            // space because "which states can be refused with
                            // nothing sent" is exactly the kind of question a
                            // later edit changes without noticing.
                            if (op.attempts == 0) {
                                refusalsWithNothingSent++
                                val view = Recovery.explain(step.code)
                                assertTrue(
                                    view.message !in assertsSomethingLeftTheDevice,
                                    "a refusal with nothing sent (${step.code}) is shown as " +
                                        "${view.message}, which asserts a transmission: $op on $event",
                                )
                            }

                            // INV-7: a refusal moves nothing and cites a law.
                            assertTrue(
                                step.law in P7Laws.ALL.map { it.id }.toSet(),
                                "refusal ${step.code} cites the unstated law ${step.law}",
                            )
                        }

                        is Step.Moved -> {
                            val next = step.operation
                            eventsThatMoved += event::class.simpleName.orEmpty()
                            step.effects.forEach { effectsSeen += it::class.simpleName.orEmpty() }

                            // INV-6: identity and the frozen payload never change,
                            // and the attempt counter never walks backwards.
                            assertEquals(op.id, next.id, "the idempotency key changed: $op -> $next on $event")
                            assertEquals(
                                op.payloadDigest, next.payloadDigest,
                                "the captured payload digest changed: $op -> $next on $event",
                            )
                            assertEquals(op.effect, next.effect, "the effect class changed: $op -> $next")
                            assertEquals(
                                op.amountMinorUnits, next.amountMinorUnits,
                                "the captured amount changed: $op -> $next on $event",
                            )
                            assertEquals(
                                op.currency, next.currency,
                                "the captured currency changed: $op -> $next on $event",
                            )

                            // INV-9: nothing a foreign session asked for ever
                            // moved, and the row's owner is as immutable as its
                            // key. This is the invariant PART 40 item 2 asks
                            // for, asserted over the whole reachable space
                            // rather than in one scenario.
                            assertEquals(
                                op.scope, next.scope,
                                "the row's owner changed: $op -> $next on $event " +
                                    "(${P7Laws.QUEUE_SCOPED_BY_OWNER.id})",
                            )
                            if (event is QueueEvent.ByScope) {
                                assertTrue(
                                    permittedToAct(event.actingScope, op.scope, event),
                                    "a session L13 does not permit moved this row: $op -> $next " +
                                        "on $event (${P7Laws.NO_CROSS_ACCOUNT_SEND.id})",
                                )
                                if (event.actingScope != op.scope) nextShiftSends++
                            }
                            assertEquals(
                                QueueSchema.CURRENT, next.schemaVersion,
                                "the row's schema version drifted: $op -> $next on $event",
                            )
                            assertTrue(
                                next.attempts >= op.attempts,
                                "attempts went backwards: $op -> $next on $event",
                            )

                            // INV-13: a release only ever moves a row nothing
                            // has been sent from, and so does a cancel. H-01
                            // moved the relaxed event from the release to the
                            // cancel, and the ground is the same one: nothing
                            // left the device, so there is no server truth to
                            // contradict. It is asserted over the whole
                            // reachable space instead of read off the reducer's
                            // arms — if a later edit made either legal from a
                            // state reachable after a send, the relaxation
                            // would hand another member a row the server may
                            // already hold.
                            if (event is QueueEvent.Release || event is QueueEvent.CancelByMerchant) {
                                assertEquals(
                                    0, op.attempts,
                                    "a $event moved a row that had already been sent: $op " +
                                        "(${P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id})",
                                )
                                if (event is QueueEvent.Release) releasesOfAnUnsentRow++
                            }

                            // INV-14: whatever a session that is not the row's
                            // own manages to do to it is recorded, with the
                            // acting scope on it, exactly once. The row names
                            // only the capturer, so without this the second
                            // actor H-01 introduced would act unrecorded — and
                            // a cancel clears the row immediately, so there is
                            // no later moment at which it could be recovered.
                            if (event is QueueEvent.ByScope && event.actingScope != op.scope) {
                                val records = step.effects.filterIsInstance<SideEffect.RecordCustodyAction>()
                                assertEquals(
                                    1, records.size,
                                    "a foreign-session move produced ${records.size} custody records: " +
                                        "$op on $event (${P7Laws.QUEUE_SCOPED_BY_OWNER.id})",
                                )
                                val record = records.single()
                                assertEquals(op.scope, record.capturedBy, "the record names the wrong capturer")
                                assertEquals(event.actingScope, record.actedBy, "the record names the wrong actor")
                                assertEquals(op.id, record.idempotencyKey)
                                // I-02: what was done, from a literal rather
                                // than from the kernel's own expression.
                                assertEquals(
                                    expectedCustodyLabel(event), record.event,
                                    "the record says ${record.event} about a $event: $op",
                                )
                                // I-04: what was destroyed, not only who did
                                // it. The row is cleared in the same step on
                                // the one path that opens, so these two fields
                                // are the only surviving description of the
                                // capture.
                                assertEquals(
                                    op.payloadDigest, record.payloadDigest,
                                    "the record describes a capture that is not this row's: $op on $event",
                                )
                                assertEquals(
                                    op.effect, record.effect,
                                    "the record names the wrong effect class: $op on $event",
                                )
                                assertEquals(
                                    op.amountMinorUnits, record.amountMinorUnits,
                                    "the record cannot say what was lost: $op on $event",
                                )
                                assertEquals(
                                    op.currency, record.currency,
                                    "the record names the wrong currency: $op on $event",
                                )
                                // I-04's second half: the record is only an
                                // audit of a destruction if it exists before
                                // the destruction. A caller performing these in
                                // order within one transaction cannot erase a
                                // row it failed to record; a record appended
                                // after the erase would reverse that, and the
                                // ordering is the only part of it this kernel
                                // owns.
                                val recordAt = step.effects.indexOfFirst {
                                    it is SideEffect.RecordCustodyAction
                                }
                                val clearAt = step.effects.indexOfFirst { it is SideEffect.ClearLocalRow }
                                if (clearAt >= 0) {
                                    assertTrue(
                                        recordAt < clearAt,
                                        "the local row is erased at effect $clearAt and the custody " +
                                            "record written at $recordAt, so the erase is not fail-closed: " +
                                            "$op on $event",
                                    )
                                    custodyRecordsBeforeAnErase++
                                }
                                custodyRecords++
                            } else {
                                assertTrue(
                                    step.effects.none { it is SideEffect.RecordCustodyAction },
                                    "a move by the row's own session was recorded as a custody action: " +
                                        "$op on $event",
                                )
                            }

                            // INV-5: at most one attempt is ever in flight.
                            val sends = step.effects.filterIsInstance<SideEffect.SendAttempt>()
                            if (op.state == OperationState.IN_FLIGHT) {
                                assertTrue(
                                    sends.isEmpty(),
                                    "a second attempt was started while one was in flight: $op on $event",
                                )
                            }

                            // INV-2: a send carries THIS key and THIS digest.
                            for (send in sends) {
                                assertEquals(op.id, send.idempotencyKey, "a send carried a foreign key")
                                assertEquals(
                                    op.payloadDigest, send.payloadDigest,
                                    "a send carried a payload that is not the captured one",
                                )
                                assertEquals(next.attempts, send.attempt, "the send's attempt number disagrees")
                                // F-02: the business is the half of the source
                                // identity the server cannot validate, so the
                                // effect must name it rather than leaving the
                                // transport to re-derive it at build time.
                                assertEquals(
                                    op.scope, send.scope,
                                    "a send carried a scope that is not the row's own: $op on $event " +
                                        "(${P7Laws.NO_CROSS_ACCOUNT_SEND.id})",
                                )
                            }

                            val committed = history.serverCommitted ||
                                (event is QueueEvent.Observe && isCommit(event.result))
                            val everSent = history.everSent || sends.isNotEmpty()

                            // INV-1: the whole point. SYNCED requires that the
                            // server said so.
                            if (next.state == OperationState.SYNCED) {
                                assertTrue(
                                    committed,
                                    "reached SYNCED without a 2xx from the server: $op -> $next on $event " +
                                        "(${P7Laws.DEVICE_NOT_AUTHORITY.id})",
                                )
                            }

                            // INV-3 / INV-8: a material operation that has been
                            // sent can never be thrown away by the device.
                            if (next.state == OperationState.DISCARDED) {
                                assertTrue(
                                    !everSent || !next.effect.isMaterial,
                                    "a sent ${next.effect} operation was discarded: $op -> $next on $event " +
                                        "(${P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id})",
                                )
                            }

                            // INV-10: minimizing a payload is not a delete. The
                            // tempting implementation of "bounded retention" is
                            // to drop the row, so the two side effects are
                            // asserted mutually exclusive over the whole space,
                            // and a minimized operation must remain exactly as
                            // owed as it was.
                            val minimized = step.effects.filterIsInstance<SideEffect.MinimizePayload>()
                            if (minimized.isNotEmpty()) {
                                assertTrue(
                                    step.effects.none { it is SideEffect.ClearLocalRow },
                                    "a payload was minimized AND the row cleared: $op on $event " +
                                        "(${P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id})",
                                )
                                assertEquals(
                                    OperationState.NEEDS_ATTENTION, next.state,
                                    "minimizing a payload moved the operation out of NEEDS_ATTENTION: " +
                                        "$op -> $next on $event",
                                )
                                assertEquals(
                                    op.lastCode, next.lastCode,
                                    "minimizing a payload discarded the server's refusal code",
                                )
                            }

                            // INV-11: the defect V2 found in L16, closed over
                            // the whole reachable space rather than argued.
                            // A minimized row has no bytes to send, so an
                            // attempt from one would either burn the key on
                            // different bytes or have no digest at all. The
                            // reducer has no explicit guard in the `Send` arm
                            // on purpose — one would be unreachable code, and
                            // unreachable code is not evidence. What makes the
                            // property true is that the only exit from a
                            // minimized row goes through a restore, and only
                            // a search over every path can say that.
                            if (op.payloadMinimized) {
                                assertTrue(
                                    sends.isEmpty(),
                                    "an attempt was made from a minimized row: $op on $event " +
                                        "(${P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id})",
                                )
                            }

                            // INV-12: a restore gives back the bytes and
                            // changes nothing else. It is not a second
                            // capture: no new key, no new digest, no state
                            // move, no attempt consumed.
                            if (event is QueueEvent.RestorePayload) {
                                assertTrue(
                                    !next.payloadMinimized,
                                    "a restore left the row minimized: $op -> $next",
                                )
                                assertEquals(
                                    op.state, next.state,
                                    "a restore moved the operation: $op -> $next",
                                )
                                assertEquals(op.attempts, next.attempts, "a restore consumed an attempt")
                                assertEquals(op.lastCode, next.lastCode, "a restore forgot the server's reason")
                            }

                            // INV-4: the local row is cleared only once there is
                            // nothing left that could exist only on the device.
                            if (step.effects.any { it is SideEffect.ClearLocalRow }) {
                                assertTrue(
                                    next.state == OperationState.SYNCED || next.state == OperationState.DISCARDED,
                                    "the local row was cleared in state ${next.state} " +
                                        "(${P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id})",
                                )
                            }

                            val nextHistory = History(committed, everSent)
                            if (next.attempts <= attemptBound) {
                                val print = fingerprint(next, nextHistory)
                                if (visited.add(print)) frontier.addLast(next to nextHistory)
                            }
                        }
                    }
                }
            }
        }

        // Non-vacuity. A model check that explored three configurations and
        // asserted nothing would pass every invariant above, so the search
        // itself is measured: every state reachable, every event exercised,
        // every side effect produced, and both verdicts observed.
        // Challenger finding F-03: this used to read `statesSeen +
        // OperationState.SYNCED`, which satisfied the assertion for SYNCED by
        // construction — and SYNCED is the one state INV-1 is about. A
        // plausible "do not explore from a terminal state" optimization would
        // have made INV-1 vacuous with all tests green. The union was dead
        // weight too: the search reaches SYNCED on its own.
        assertEquals(
            OperationState.entries.toSet(), statesSeen,
            "the search did not reach every state; it saw $statesSeen",
        )
        assertEquals(
            setOf(
                "Release", "CancelByMerchant", "Send", "ProcessDeath", "Observe",
                "ResolveByMerchant", "RetentionDeadlineReached", "RestorePayload",
            ),
            eventsThatMoved,
            "some event never moved anything, so its transitions were never checked",
        )
        assertEquals(
            setOf("SendAttempt", "Alert", "ClearLocalRow", "MinimizePayload", "RecordCustodyAction"),
            effectsSeen,
            "some side effect was never produced, so its invariant was never exercised",
        )
        assertTrue(refusals > 0, "no event was ever refused, so the refusal invariant is vacuous")
        assertTrue(
            foreignScopeRefusals > 0,
            "no foreign-scope event was ever refused, so INV-9 is vacuous: the search never " +
                "offered the kernel another account's session",
        )
        assertTrue(
            nextShiftSends > 0,
            "no event under another member of the same business ever moved anything, so INV-2's " +
                "claim that a send carries the ROW's scope rather than the sender's is vacuous",
        )
        assertTrue(
            releasesOfAnUnsentRow > 0,
            "no release ever moved anything, so INV-13 — the ground the relaxation stands on " +
                "— is vacuous",
        )
        assertTrue(
            custodyRecords > 0,
            "no session but the row's own ever moved it, so INV-14 is vacuous: the search never " +
                "offered the kernel the shared till H-01 is about",
        )
        assertTrue(
            custodyRecordsBeforeAnErase > 0,
            "no foreign-session move ever erased the local row, so the ordering half of INV-14 " +
                "is vacuous: the path I-04 is about was never explored",
        )
        assertTrue(
            refusalsWithNothingSent > 0,
            "no refusal was ever produced with nothing sent, so INV-9b is vacuous",
        )
        assertTrue(
            MerchantMessage.CANNOT_CANCEL_AFTER_SENDING in assertsSomethingLeftTheDevice,
            "the set of messages that assert a transmission does not contain the one the " +
                "kernel actually produces for a cancel after a send, so INV-9b judges nothing",
        )
        assertTrue(edges > 1_000, "only $edges edges were explored")
    }

    private fun isCommit(result: AttemptResult): Boolean =
        result is AttemptResult.Answered && result.status in 200..299

    /**
     * The covering lemma. Without this, the model check above is a proof about
     * eight answers rather than about every answer a server can give.
     */
    @Test
    fun `the representative answers cover every decision shape the classifier can produce`() {
        val op = "11111111-2222-4333-8444-555555555555"
        fun shape(d: Decision): String = when (d) {
            is Decision.Synced -> "Synced(replayed=${d.replayed})"
            is Decision.Retry -> "Retry"
            is Decision.ResolveByReplay -> "ResolveByReplay"
            is Decision.NeedsAttention -> "NeedsAttention(diverged=${d.diverged})"
        }

        val covered = answers.map { shape(Outcome.classify(it, op, 1)) }.toSet()
        // Five shapes exist; all five must be represented, or the search below
        // the lemma is blind to one of them.
        assertEquals(
            setOf(
                "Synced(replayed=true)",
                "Synced(replayed=false)",
                "Retry",
                "ResolveByReplay",
                "NeedsAttention(diverged=true)",
                "NeedsAttention(diverged=false)",
            ),
            covered,
            "the representatives do not produce every decision shape",
        )

        val codes = listOf(
            null, "", "IDEMPOTENCY_KEY_REUSED", "accounting.idempotency_conflict",
            "inventory.insufficient_stock", "VALIDATION_FAILED", "accounting.period_closed",
        )
        var swept = 0
        for (status in 0..699) {
            for (code in codes) {
                for (replayed in listOf(null, false, true)) {
                    for (ra in listOf<Long?>(null, 0, 30, 86_400)) {
                        val d = Outcome.classify(AttemptResult.Answered(status, code, replayed, ra), op, 2)
                        assertTrue(
                            shape(d) in covered,
                            "status $status / code $code produces ${shape(d)}, which no representative covers",
                        )
                        swept++
                    }
                }
            }
        }
        assertTrue(shape(Outcome.classify(AttemptResult.NoAnswer, op, 2)) in covered)
        assertEquals(700 * codes.size * 3 * 4, swept)
    }
}
