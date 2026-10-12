package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The continuous-mission directive §14, in the places it corrected a decision
 * I had already made — in V1, and then again in V2, where it corrected a
 * defect in the V1 fix itself:
 *
 *  - **Re-entry after a wipe** (L15). My D3 default was "the queue is lost,
 *    the merchant re-enters". That is a duplicate charge whenever the lost
 *    operation had actually committed, and the key machinery cannot catch it,
 *    because a new key is by definition one the server has never seen.
 *
 *  - **Bounded retention** (L16). My D4 proposal was to block new captures
 *    until a human resolved the waiting row. The directive rejected it in
 *    terms: blocking new capture does not prove bounded retention — expiry,
 *    reach and escalation are required, with no silent drop of a financial
 *    operation.
 *
 *  - **An unfenced absence** (L17, V2). My L15 fix treated an `ABSENT`
 *    receipt as settling the original. V2 named it a race, and it is one: the
 *    answer describes an instant, and the original can commit after it.
 *
 *  - **The original key outranks a new one** (L18, V2). The better half of
 *    the same ruling, and the half that needs nothing new from the server.
 *
 *  - **Minimization must not make settlement impossible** (L16 again, V2).
 *    A defect my own L16 introduced: an expired row could be sent back to
 *    QUEUED with no payload left to send.
 */
class ReentryAndRetentionTest {
    private val key = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"
    private val digest = "sha256:1a2b3c4d"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    // ── L15 / L17 / L18: what may follow a wipe ──────────────────────────

    /**
     * The whole cross product, with the subject count asserted. The expected
     * verdict for each triple is written out rather than computed, so this
     * test cannot agree with the implementation by sharing its logic — the
     * failure mode where a table test re-derives the answer from the function
     * it is checking.
     *
     * Three outcomes, so the table has to say which, not merely yes or no:
     * the difference between `Permitted` (mint a new key) and `UseOriginalKey`
     * (finish the old one) is the difference V2 asked for.
     */
    @Test
    fun `every prior outcome, receipt answer and provenance has a stated verdict`() {
        // Mint a new key. Only where there is provably nothing to collide with.
        val permitted = setOf(
            Triple(PriorOutcome.NONE, ReceiptLookup.COMMITTED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NONE, ReceiptLookup.COMMITTED, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NONE, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NONE, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NONE, ReceiptLookup.ABSENT_UNFENCED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NONE, ReceiptLookup.ABSENT_UNFENCED, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NONE, ReceiptLookup.UNAVAILABLE, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NONE, ReceiptLookup.UNAVAILABLE, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.COMMITTED, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.ABSENT_UNFENCED, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.UNAVAILABLE, Provenance.ORIGINAL_LOST),
            Triple(PriorOutcome.UNKNOWN, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_LOST),
        )
        // Finish the original instead. Wherever its identity survives and it
        // may still need sending.
        val useOriginal = setOf(
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.COMMITTED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.ABSENT_UNFENCED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.NEVER_SENT, ReceiptLookup.UNAVAILABLE, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.UNKNOWN, ReceiptLookup.COMMITTED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.UNKNOWN, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.UNKNOWN, ReceiptLookup.ABSENT_UNFENCED, Provenance.ORIGINAL_RECOVERABLE),
            Triple(PriorOutcome.UNKNOWN, ReceiptLookup.UNAVAILABLE, Provenance.ORIGINAL_RECOVERABLE),
        )
        val lawOfRefusal = mapOf(
            "offline.original_already_committed" to P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
            "offline.original_unsettled" to P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
            "offline.absence_not_fenced" to P7Laws.AN_UNFENCED_ABSENCE_SETTLES_NOTHING.id,
        )

        var checked = 0
        for (prior in PriorOutcome.entries) {
            for (lookup in ReceiptLookup.entries) {
                for (provenance in Provenance.entries) {
                    val triple = Triple(prior, lookup, provenance)
                    val decision = Reconciliation.decideReentry(prior, lookup, provenance)
                    when (triple) {
                        in permitted -> assertIs<Reentry.Permitted>(
                            decision, "$triple should permit a new key",
                        )

                        in useOriginal -> assertIs<Reentry.UseOriginalKey>(
                            decision, "$triple should finish the original, not mint a new key",
                        )

                        else -> {
                            val refused = assertIs<Reentry.Refused>(
                                decision, "$triple must not permit a new key",
                            )
                            assertEquals(
                                lawOfRefusal[refused.code], refused.law,
                                "$triple was refused citing a law that does not match its code",
                            )
                        }
                    }
                    checked++
                }
            }
        }
        assertEquals(
            PriorOutcome.entries.size * ReceiptLookup.entries.size * Provenance.entries.size, checked,
            "the cross product was not swept in full",
        )
        assertEquals(32, checked, "the enums changed size; the stated verdicts must be revisited")
        // Non-vacuity in every direction: a function that gave one answer to
        // everything would pass at most one of these three.
        assertTrue(permitted.size in 1 until checked, "the permitted table is degenerate")
        assertTrue(useOriginal.size in 1 until checked, "the use-the-original table is degenerate")
        assertTrue(
            permitted.size + useOriginal.size < checked,
            "nothing is refused anywhere, so L15 and L17 are untested",
        )
    }

    /**
     * The scenario the law exists for, named so a reviewer can see the money.
     *
     * A sale is sent, the server commits it, the answer is lost, and then the
     * phone is wiped. The original identity is gone with the row, so L7's
     * resolution by replay is unavailable. The merchant re-enters the sale,
     * which mints a NEW key. If that is permitted while the server is
     * unreachable, the customer is charged twice, under two different source
     * identities, and no later reconciliation can tell the two rows apart.
     */
    @Test
    fun `a wiped device may not re-enter an unknown sale while the receipt cannot be read`() {
        val decision = Reconciliation.decideReentry(
            PriorOutcome.UNKNOWN, ReceiptLookup.UNAVAILABLE, Provenance.ORIGINAL_LOST,
        )
        val refused = assertIs<Reentry.Refused>(decision, "re-entry under a new key was permitted")
        assertEquals("offline.original_unsettled", refused.code)
        assertEquals(P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id, refused.law)
    }

    /**
     * L17, stated as the pair V2 was pointing at: the SAME question, answered
     * with the same words — "there is no such operation" — settles the
     * original in one case and nothing at all in the other. The difference is
     * not in the answer, it is in whether the server can still change its mind
     * afterwards.
     */
    @Test
    fun `an absence settles the original only when the original key is fenced`() {
        val fenced = Reconciliation.decideReentry(
            PriorOutcome.UNKNOWN, ReceiptLookup.ABSENT_FENCED, Provenance.ORIGINAL_LOST,
        )
        assertIs<Reentry.Permitted>(fenced, "a fenced absence does settle the original")

        val unfenced = assertIs<Reentry.Refused>(
            Reconciliation.decideReentry(
                PriorOutcome.UNKNOWN, ReceiptLookup.ABSENT_UNFENCED, Provenance.ORIGINAL_LOST,
            ),
            "an absence that the original can still contradict was treated as settling it",
        )
        assertEquals("offline.absence_not_fenced", unfenced.code)
        assertEquals(P7Laws.AN_UNFENCED_ABSENCE_SETTLES_NOTHING.id, unfenced.law)
    }

    /**
     * L18. The recoverable case does not consult the receipt at all, and that
     * is the point rather than an optimization: a resend of the same key is
     * correct under every answer the lookup can give, so making the decision
     * depend on it would introduce a precondition the server does not have and
     * hand the race a way back in.
     */
    @Test
    fun `a recoverable original is resent under its own key whatever the receipt says`() {
        for (lookup in ReceiptLookup.entries) {
            assertIs<Reentry.UseOriginalKey>(
                Reconciliation.decideReentry(
                    PriorOutcome.UNKNOWN, lookup, Provenance.ORIGINAL_RECOVERABLE,
                ),
                "a recoverable original was not resent under its own key when the receipt said $lookup",
            )
        }
    }

    /**
     * A first sale must not require the network. If it did, the offline queue
     * would have made the till less usable offline than it was before, which
     * is the opposite of the point.
     */
    @Test
    fun `a first capture does not need a receipt lookup at all`() {
        for (lookup in ReceiptLookup.entries) {
            for (provenance in Provenance.entries) {
                assertIs<Reentry.Permitted>(
                    Reconciliation.decideReentry(PriorOutcome.NONE, lookup, provenance),
                    "a first capture was blocked by a $lookup receipt lookup",
                )
            }
        }
    }

    // ── The race: a lookup, and a late commit ────────────────────────────

    /**
     * A canonical server with ONE key-space, which is the only property that
     * matters here: `deriveSourceId(business, key)` means two different keys
     * are two different operations, and the server has no way to know they
     * were meant to be one.
     *
     * `commit` therefore counts operations, not requests, and a resend of a
     * key it already holds is a replay that writes nothing — which is the live
     * contract, not a convenience for this test.
     */
    private class CanonicalServer(private val fencing: Boolean) {
        private val committed = mutableSetOf<String>()
        private val fenced = mutableSetOf<String>()

        /** True if this call created an operation; false if it replayed or was fenced. */
        fun commit(key: String): Boolean {
            if (key in fenced) return false
            return committed.add(key)
        }

        fun lookup(key: String): ReceiptLookup = when {
            key in committed -> ReceiptLookup.COMMITTED
            // Answering the question is also the act of closing the key, which
            // is what a fencing server would have to do for its answer to
            // mean anything a moment later.
            fencing -> { fenced.add(key); ReceiptLookup.ABSENT_FENCED }
            else -> ReceiptLookup.ABSENT_UNFENCED
        }

        val operations: Int get() = committed.size
    }

    /**
     * V2 §14: "أثبت سباق lookup مع late commit حتى لا تُنشأ عمليتان" — prove
     * the lookup-versus-late-commit race, so that two operations are never
     * created.
     *
     * The race, concretely. The original request is alive somewhere. The
     * device asks whether it landed and is told no. The original then lands.
     * If the device minted a new key on the strength of that answer, the
     * server now holds two operations for one sale.
     *
     * So the sweep enumerates every interleaving of (ask, original lands,
     * device acts) against both a fencing and a non-fencing server, follows
     * `decideReentry` exactly, and asserts the only thing that actually
     * matters: the server ends with at most one operation for the intent.
     */
    @Test
    fun `no interleaving of a lookup and a late commit ever creates two operations`() {
        val originalKey = "original-$key"
        val newKey = "re-entered-$key"
        var sweep = 0
        var permittedAtLeastOnce = 0
        var refusedAtLeastOnce = 0

        for (fencing in listOf(false, true)) {
            // Where the original lands relative to the question: before it,
            // between the answer and the device acting on it (the race), or
            // after the device has acted.
            for (landsAt in listOf("before", "between", "after")) {
                val server = CanonicalServer(fencing)
                if (landsAt == "before") server.commit(originalKey)

                val lookup = server.lookup(originalKey)
                if (landsAt == "between") server.commit(originalKey)

                // The original identity is gone — this is the wiped-device
                // case, which is the only one where a new key is even on the
                // table. The recoverable case is covered above and cannot
                // reach this race at all.
                val decision = Reconciliation.decideReentry(
                    PriorOutcome.UNKNOWN, lookup, Provenance.ORIGINAL_LOST,
                )
                when (decision) {
                    is Reentry.Permitted -> {
                        permittedAtLeastOnce++
                        server.commit(newKey)
                    }

                    is Reentry.Refused -> refusedAtLeastOnce++

                    is Reentry.UseOriginalKey -> throw AssertionError(
                        "a lost original was resent under a key the device does not have",
                    )
                }
                if (landsAt == "after") server.commit(originalKey)

                assertTrue(
                    server.operations <= 1,
                    "fencing=$fencing, original lands $landsAt: the server holds " +
                        "${server.operations} operations for one sale",
                )
                sweep++
            }
        }

        assertEquals(6, sweep, "the interleaving sweep did not run in full")
        // Non-vacuity. A function that refused everything would hold the
        // invariant trivially and would also make the till unusable, so the
        // sweep has to show the permitted path being taken as well.
        assertTrue(refusedAtLeastOnce > 0, "nothing was ever refused; the race was not exercised")
        assertTrue(
            permittedAtLeastOnce > 0,
            "re-entry was never permitted anywhere, so the invariant holds for the wrong reason",
        )
    }

    // ── L16: expiry minimizes the payload, never the obligation ──────────

    private fun waitingForAPerson(): Operation {
        var op = Operation.capture(key, scope, EffectClass.FINANCIAL, digest)
        op = (op.step(QueueEvent.Release(scope)) as Step.Moved).operation
        op = (op.step(QueueEvent.Send(digest, scope)) as Step.Moved).operation
        val step = op.step(
            QueueEvent.Observe(AttemptResult.Answered(409, "accounting.period_closed", null, null)),
        )
        val moved = assertIs<Step.Moved>(step)
        assertEquals(OperationState.NEEDS_ATTENTION, moved.operation.state)
        return moved.operation
    }

    private fun minimized(): Operation {
        val op = waitingForAPerson()
        val step = assertIs<Step.Moved>(op.step(QueueEvent.RetentionDeadlineReached))
        assertTrue(step.operation.payloadMinimized)
        return step.operation
    }

    @Test
    fun `an expired waiting operation has its payload minimized and is escalated`() {
        val op = waitingForAPerson()
        val step = assertIs<Step.Moved>(op.step(QueueEvent.RetentionDeadlineReached))

        val minimized = step.effects.filterIsInstance<SideEffect.MinimizePayload>().single()
        assertEquals("offline.retention_window_elapsed", minimized.reason)
        assertEquals(P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id, minimized.law)

        // Reach and escalation: the obligation leaves the till rather than
        // sitting on it silently, which is the half of the ruling that
        // "block new captures" did not satisfy.
        val alert = step.effects.filterIsInstance<SideEffect.Alert>().single()
        assertEquals("offline.waiting_operation_escalated", alert.code)
    }

    /**
     * The failure this law was written against. "Bounded retention" invites
     * exactly one implementation — delete the row — and that is the silent
     * loss of money L4 and L5 forbid. The operation must come out of expiry
     * owed in precisely the way it went in.
     */
    @Test
    fun `expiry never clears the row, never discards the operation and never forgets why`() {
        val op = waitingForAPerson()
        val step = assertIs<Step.Moved>(op.step(QueueEvent.RetentionDeadlineReached))

        assertTrue(
            step.effects.none { it is SideEffect.ClearLocalRow },
            "expiry cleared the local row, which is the silent loss of money this law forbids",
        )
        assertEquals(OperationState.NEEDS_ATTENTION, step.operation.state, "expiry moved the operation")
        assertEquals("accounting.period_closed", step.operation.lastCode, "expiry forgot the server's reason")
        assertEquals(op.id, step.operation.id, "expiry changed the operation's identity")
        assertEquals(op.attempts, step.operation.attempts)
        assertTrue(step.operation.effect.isMaterial && !step.operation.isTerminal)
    }

    @Test
    fun `a deadline means nothing anywhere except on an operation awaiting a person`() {
        // Minimizing a payload that is still going to be sent would destroy the
        // frozen bytes, so every other state refuses rather than obliging.
        var op = Operation.capture(key, scope, EffectClass.FINANCIAL, digest)
        val captured = assertIs<Step.Refused>(op.step(QueueEvent.RetentionDeadlineReached))
        assertEquals("offline.nothing_awaiting_a_person", captured.code)
        assertEquals(P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id, captured.law)

        op = (op.step(QueueEvent.Release(scope)) as Step.Moved).operation
        assertIs<Step.Refused>(op.step(QueueEvent.RetentionDeadlineReached))
        op = (op.step(QueueEvent.Send(digest, scope)) as Step.Moved).operation
        assertIs<Step.Refused>(op.step(QueueEvent.RetentionDeadlineReached))
        op = (
            op.step(QueueEvent.Observe(AttemptResult.Answered(200, null, true, null))) as Step.Moved
            ).operation
        assertEquals(OperationState.SYNCED, op.state)
        assertIs<Step.Refused>(op.step(QueueEvent.RetentionDeadlineReached))
    }

    /**
     * The deadline is a clock event, not a session one, so it carries no
     * acting scope. That is deliberate and consistent with L8: the clock may
     * schedule a data-minimization, and it decides nothing financial, because
     * the obligation is identical on both sides of the step.
     */
    @Test
    fun `the retention deadline is not a session-originated event`() {
        assertTrue(QueueEvent.RetentionDeadlineReached !is QueueEvent.ByScope)
    }

    // ── L16 again: minimization must not make settlement impossible ──────

    /**
     * The defect V2 found in my own L16, reproduced as the test that would
     * have caught it.
     *
     * The first version let a merchant resolve an expired row straight back to
     * QUEUED. The row then had no payload, so the sender either sent different
     * bytes under the original key — which the server refuses permanently,
     * burning the key and stranding the money for good — or could not produce
     * a digest at all. Minimizing what is STORED is legitimate; making the
     * obligation unsettleable is not, and the two had been conflated.
     */
    @Test
    fun `a minimized operation cannot be resent until its approved payload is back`() {
        val op = minimized()
        val refused = assertIs<Step.Refused>(
            op.step(QueueEvent.ResolveByMerchant(keep = true, actingScope = scope)),
            "a minimized row was queued for sending with no payload to send",
        )
        assertEquals("offline.payload_minimized_cannot_resend", refused.code)
        assertEquals(P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id, refused.law)
    }

    /**
     * The other half of the same requirement — "يحتاج استعادة الحمولة المعتمدة
     * أو مسار حسم دون intent/key جديد" — and the one that makes the refusal
     * above legitimate rather than merely safe. A refusal with no way past it
     * is also an unsettleable obligation; it is just a quieter one.
     *
     * So the path is walked end to end: minimized, restored, resolved, sent,
     * synced. What matters is what it does NOT contain — no new intent, no new
     * key, no new digest. The operation that settles is the operation that was
     * captured.
     */
    @Test
    fun `a minimized operation can still be settled under its original key and bytes`() {
        val expired = minimized()

        val restored = assertIs<Step.Moved>(
            expired.step(QueueEvent.RestorePayload(digest, scope)),
            "the approved payload could not be restored, so the obligation cannot be settled",
        ).operation
        assertTrue(!restored.payloadMinimized)

        val queued = assertIs<Step.Moved>(
            restored.step(QueueEvent.ResolveByMerchant(keep = true, actingScope = scope)),
        ).operation
        assertEquals(OperationState.QUEUED, queued.state)

        val sent = assertIs<Step.Moved>(queued.step(QueueEvent.Send(digest, scope)))
        val attempt = sent.effects.filterIsInstance<SideEffect.SendAttempt>().single()
        assertEquals(expired.id, attempt.idempotencyKey, "settlement used a key other than the original")
        assertEquals(digest, attempt.payloadDigest, "settlement sent bytes other than the ones captured")

        val synced = assertIs<Step.Moved>(
            sent.operation.step(QueueEvent.Observe(AttemptResult.Answered(200, null, true, null))),
        ).operation
        assertEquals(OperationState.SYNCED, synced.state, "the restored operation never reached a settlement")
        assertEquals(expired.id, synced.id, "the operation that settled is not the one that was captured")
    }

    /**
     * A restore is not a second capture, so it has to be as strict about the
     * bytes as the sender is. A restored payload that is not byte-identical is
     * not the payload this key is bound to, and letting it through would
     * convert a recoverable obligation into a permanently refused key — the
     * exact outcome the restore path exists to avoid.
     */
    @Test
    fun `a restore that does not reproduce the captured bytes is refused`() {
        val refused = assertIs<Step.Refused>(
            minimized().step(QueueEvent.RestorePayload("sha256:something-else", scope)),
        )
        assertEquals("offline.restored_payload_does_not_match_capture", refused.code)
        assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, refused.law)
    }

    @Test
    fun `a restore means nothing on a row that was never minimized`() {
        val refused = assertIs<Step.Refused>(
            waitingForAPerson().step(QueueEvent.RestorePayload(digest, scope)),
        )
        assertEquals("offline.payload_was_never_minimized", refused.code)
    }

    /**
     * And the restore is a session-originated event, unlike the deadline that
     * made it necessary: putting the approved payload back onto a till is
     * something a signed-in person does, and L13 applies to it exactly as it
     * applies to a send.
     */
    @Test
    fun `another account cannot restore a payload onto someone else's row`() {
        val other = OwnerScope("tenant-1", "business-2", "member-1")
        val refused = assertIs<Step.Refused>(minimized().step(QueueEvent.RestorePayload(digest, other)))
        assertEquals("offline.scope_switched", refused.code)
        assertEquals(P7Laws.NO_CROSS_ACCOUNT_SEND.id, refused.law)
    }
}
