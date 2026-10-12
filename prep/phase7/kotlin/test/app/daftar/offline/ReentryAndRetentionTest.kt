package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The continuous-mission directive §14, in the two places it corrected a
 * decision I had already made:
 *
 *  - **Re-entry after a wipe** (L15). My earlier D3 default was "the queue is
 *    lost, the merchant re-enters". That is a duplicate charge whenever the
 *    lost operation had actually committed, and the key machinery cannot catch
 *    it, because a new key is by definition one the server has never seen.
 *
 *  - **Bounded retention** (L16). My earlier D4 proposal was to block new
 *    captures until a human resolved the waiting row. The directive rejected
 *    it in terms: blocking new capture does not prove bounded retention —
 *    expiry, reach and escalation are required, with no silent drop of a
 *    financial operation.
 */
class ReentryAndRetentionTest {
    private val key = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"
    private val digest = "sha256:1a2b3c4d"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    // ── L15: no re-entry under a new key before the original is settled ──

    /**
     * The whole cross product, with the subject count asserted. The expected
     * verdict for each pair is written out rather than computed, so this test
     * cannot agree with the implementation by sharing its logic — the failure
     * mode where a table test re-derives the answer from the function it is
     * checking.
     */
    @Test
    fun `every prior outcome and receipt answer has a stated verdict`() {
        val permitted = setOf(
            PriorOutcome.NONE to ReceiptLookup.COMMITTED,
            PriorOutcome.NONE to ReceiptLookup.ABSENT,
            PriorOutcome.NONE to ReceiptLookup.UNAVAILABLE,
            PriorOutcome.NEVER_SENT to ReceiptLookup.COMMITTED,
            PriorOutcome.NEVER_SENT to ReceiptLookup.ABSENT,
            PriorOutcome.NEVER_SENT to ReceiptLookup.UNAVAILABLE,
            PriorOutcome.UNKNOWN to ReceiptLookup.ABSENT,
        )
        var checked = 0
        for (prior in PriorOutcome.entries) {
            for (lookup in ReceiptLookup.entries) {
                val decision = Reconciliation.decideReentry(prior, lookup)
                if ((prior to lookup) in permitted) {
                    assertIs<Reentry.Permitted>(decision, "$prior / $lookup should permit re-entry")
                } else {
                    val refused = assertIs<Reentry.Refused>(
                        decision, "$prior / $lookup must not permit a new key",
                    )
                    assertEquals(
                        P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id, refused.law,
                        "$prior / $lookup was refused without citing L15",
                    )
                }
                checked++
            }
        }
        assertEquals(
            PriorOutcome.entries.size * ReceiptLookup.entries.size, checked,
            "the cross product was not swept in full",
        )
        assertEquals(12, checked, "the enums changed size; the stated verdicts must be revisited")
        // Non-vacuity in both directions: a function that permitted everything
        // and one that refused everything would each pass only half of this.
        assertTrue(permitted.size in 1 until checked, "the expectation table is degenerate")
    }

    /**
     * The scenario the law exists for, named so a reviewer can see the money.
     *
     * A sale is sent, the server commits it, the answer is lost, and then the
     * phone is wiped. The row is gone, so there is no key to replay — L7's
     * resolution is unavailable. The merchant re-enters the sale, which mints
     * a NEW key. If that is permitted while the server is unreachable, the
     * customer is charged twice, under two different source identities, and no
     * later reconciliation can tell the two rows apart.
     */
    @Test
    fun `a wiped device may not re-enter an unknown sale while the receipt cannot be read`() {
        val decision = Reconciliation.decideReentry(PriorOutcome.UNKNOWN, ReceiptLookup.UNAVAILABLE)
        val refused = assertIs<Reentry.Refused>(decision, "re-entry under a new key was permitted")
        assertEquals("offline.original_unsettled", refused.code)
        assertEquals(P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id, refused.law)
    }

    @Test
    fun `the canonical receipt is what settles it, in both directions`() {
        assertIs<Reentry.Permitted>(
            Reconciliation.decideReentry(PriorOutcome.UNKNOWN, ReceiptLookup.ABSENT),
            "the server said the original never landed, so re-entry is the correct answer",
        )
        val refused = assertIs<Reentry.Refused>(
            Reconciliation.decideReentry(PriorOutcome.UNKNOWN, ReceiptLookup.COMMITTED),
        )
        assertEquals("offline.original_already_committed", refused.code)
    }

    /**
     * A first sale must not require the network. If it did, the offline queue
     * would have made the till less usable offline than it was before, which
     * is the opposite of the point.
     */
    @Test
    fun `a first capture does not need a receipt lookup at all`() {
        for (lookup in ReceiptLookup.entries) {
            assertIs<Reentry.Permitted>(
                Reconciliation.decideReentry(PriorOutcome.NONE, lookup),
                "a first capture was blocked by a $lookup receipt lookup",
            )
        }
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
}
