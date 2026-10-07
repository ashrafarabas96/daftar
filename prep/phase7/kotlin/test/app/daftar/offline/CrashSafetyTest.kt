package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The named scenarios: the ways a shop actually loses money, walked end to end
 * so that the failure mode is legible to a reviewer and not only to a model
 * checker.
 */
class CrashSafetyTest {
    private val key = "9f8e7d6c-5b4a-4938-8271-615243f5e6d7"
    private val digest = "sha256:a1b2c3d4"

    private fun captureSale() = Operation.capture(key, EffectClass.FINANCIAL, digest)

    private fun moved(op: Operation, event: QueueEvent): Pair<Operation, List<SideEffect>> {
        val step = op.step(event)
        assertIs<Step.Moved>(step, "expected $event to be legal in ${op.state}")
        return step.operation to step.effects
    }

    /**
     * The scenario the whole kernel exists for: a sale is sent, the server
     * commits it, and the device dies before the answer arrives. The device
     * must resend THE SAME KEY, and must read the server's "already applied"
     * as the success it is.
     */
    @Test
    fun `a sale committed by the server and lost in transit is not sold twice`() {
        var (op, _) = moved(captureSale(), QueueEvent.Release)
        val (sent, effects) = moved(op, QueueEvent.Send(digest))
        op = sent
        val firstSend = effects.filterIsInstance<SideEffect.SendAttempt>().single()
        assertEquals(key, firstSend.idempotencyKey)
        assertEquals(1, firstSend.attempt)

        // The server commits. The phone dies before it hears so.
        val (afterCrash, crashEffects) = moved(op, QueueEvent.ProcessDeath)
        op = afterCrash
        assertEquals(OperationState.UNKNOWN_OUTCOME, op.state, "a lost answer is unknown, not failed")
        assertTrue(crashEffects.isEmpty(), "a crash must not clear the local row")

        // It restarts and sends again. Same key, same payload — which is the
        // entire reason this is safe: the server's source identity is derived
        // from the key, so the second send lands on the row the first created.
        val (resent, resendEffects) = moved(op, QueueEvent.Send(digest))
        op = resent
        val secondSend = resendEffects.filterIsInstance<SideEffect.SendAttempt>().single()
        assertEquals(firstSend.idempotencyKey, secondSend.idempotencyKey, "the key was re-minted after a crash")
        assertEquals(firstSend.payloadDigest, secondSend.payloadDigest)
        assertEquals(2, secondSend.attempt)

        // The server answers with what it already holds.
        val (synced, syncEffects) = moved(
            op, QueueEvent.Observe(AttemptResult.Answered(200, null, true, null)),
        )
        assertEquals(OperationState.SYNCED, synced.state)
        assertTrue(synced.replayed, "the device must record that this was the server's existing truth")
        assertTrue(syncEffects.any { it is SideEffect.ClearLocalRow })
    }

    @Test
    fun `a sale whose answer never comes is never shown as failed and never as done`() {
        var (op, _) = moved(captureSale(), QueueEvent.Release)
        repeat(5) {
            op = moved(op, QueueEvent.Send(digest)).first
            op = moved(op, QueueEvent.Observe(AttemptResult.NoAnswer)).first
            assertEquals(OperationState.UNKNOWN_OUTCOME, op.state)
        }
        assertEquals(5, op.attempts)
        // Five lost answers do not add up to a failure, and they do not add up
        // to a dead letter. A notification may be dropped after N attempts; a
        // sale may not.
        assertTrue(op.state != OperationState.NEEDS_ATTENTION)
        assertTrue(op.state != OperationState.DISCARDED)
    }

    @Test
    fun `the merchant cannot cancel a sale that may already exist on the server`() {
        var (op, _) = moved(captureSale(), QueueEvent.Release)
        op = moved(op, QueueEvent.Send(digest)).first
        val step = op.step(QueueEvent.CancelByMerchant)
        assertIs<Step.Refused>(step)
        assertEquals("offline.cancel_after_send", step.code)
        assertEquals(P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id, step.law)
    }

    /**
     * The regression for the defect the model check found and a hand-written
     * scenario did not: cancelling was gated on the STATE, and QUEUED is
     * reachable AFTER a send, because a 429 returns an in-flight attempt to
     * the queue. So a sale the server might already hold could be cancelled
     * and its row cleared — a silent loss, through the one path nobody walked.
     * This test fails against the state-gated reducer and passes against the
     * attempt-gated one.
     */
    @Test
    fun `a sale told to wait is back in the queue and still cannot be cancelled`() {
        var (op, _) = moved(captureSale(), QueueEvent.Release)
        op = moved(op, QueueEvent.Send(digest)).first
        op = moved(op, QueueEvent.Observe(AttemptResult.Answered(429, null, null, 30))).first
        // Back in the queue, indistinguishable by STATE from a sale that was
        // never sent — and entirely different in fact.
        assertEquals(OperationState.QUEUED, op.state)
        assertEquals(1, op.attempts)

        val step = op.step(QueueEvent.CancelByMerchant)
        assertIs<Step.Refused>(step, "a sent sale was cancellable because it had returned to QUEUED")
        assertEquals("offline.cancel_after_send", step.code)
        assertEquals(P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id, step.law)
    }

    @Test
    fun `a sale not yet sent can be cancelled, and that is the only window`() {
        val (discarded, effects) = moved(captureSale(), QueueEvent.CancelByMerchant)
        assertEquals(OperationState.DISCARDED, discarded.state)
        assertTrue(effects.any { it is SideEffect.ClearLocalRow })
        assertEquals(0, discarded.attempts, "nothing was ever sent, so nothing can exist on the server")
    }

    @Test
    fun `a payload recomputed at send time is refused here, not by the server`() {
        val (op, _) = moved(captureSale(), QueueEvent.Release)
        // The shape of the real bug: a total re-derived at send time, a locale
        // re-resolved, a date taken from the clock. The bytes differ, so the
        // server would bind this key to a different payload and refuse it
        // permanently — and the sale would be unsendable forever.
        val step = op.step(QueueEvent.Send("sha256:recomputed"))
        assertIs<Step.Refused>(step)
        assertEquals("offline.payload_changed_after_capture", step.code)
        assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, step.law)
        assertEquals(0, op.attempts, "a send that never left must not consume an attempt")
    }

    @Test
    fun `a stock conflict waits for a person and keeps the server's own words`() {
        var (op, _) = moved(Operation.capture(key, EffectClass.INVENTORY, digest), QueueEvent.Release)
        op = moved(op, QueueEvent.Send(digest)).first
        val (refused, effects) = moved(
            op, QueueEvent.Observe(AttemptResult.Answered(409, "inventory.insufficient_stock", null, null)),
        )
        assertEquals(OperationState.NEEDS_ATTENTION, refused.state)
        assertEquals("inventory.insufficient_stock", refused.lastCode)
        assertTrue(effects.isEmpty(), "a business refusal is not an operational alert")

        // The merchant may not make it go away.
        val abandon = refused.step(QueueEvent.ResolveByMerchant(keep = false))
        assertIs<Step.Refused>(abandon)
        assertEquals("offline.material_cannot_be_abandoned", abandon.code)

        // They may count the stock and try the same operation again.
        val (requeued, _) = moved(refused, QueueEvent.ResolveByMerchant(keep = true))
        assertEquals(OperationState.QUEUED, requeued.state, "a stated refusal means nothing was committed")
    }

    @Test
    fun `a reused key with a changed payload alerts as a defect and offers no retry`() {
        var (op, _) = moved(captureSale(), QueueEvent.Release)
        op = moved(op, QueueEvent.Send(digest)).first
        val (diverged, effects) = moved(
            op, QueueEvent.Observe(AttemptResult.Answered(409, "IDEMPOTENCY_KEY_REUSED", null, null)),
        )
        assertEquals(OperationState.NEEDS_ATTENTION, diverged.state)
        val alert = effects.filterIsInstance<SideEffect.Alert>().single()
        assertEquals("IDEMPOTENCY_KEY_REUSED", alert.code)
        assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, alert.law)

        // Retrying cannot work: the server will refuse the same key the same
        // way forever. Offering the merchant that button would be a lie.
        val retry = diverged.step(QueueEvent.ResolveByMerchant(keep = true))
        assertIs<Step.Refused>(retry)
        assertEquals("offline.divergence_needs_a_fix", retry.code)
    }

    @Test
    fun `a benign refusal may be let go, and only a benign one`() {
        var (op, _) = moved(Operation.capture(key, EffectClass.BENIGN, digest), QueueEvent.Release)
        op = moved(op, QueueEvent.Send(digest)).first
        op = moved(op, QueueEvent.Observe(AttemptResult.Answered(422, "VALIDATION_FAILED", null, null))).first
        assertEquals(OperationState.NEEDS_ATTENTION, op.state)
        val (gone, effects) = moved(op, QueueEvent.ResolveByMerchant(keep = false))
        assertEquals(OperationState.DISCARDED, gone.state)
        assertTrue(effects.any { it is SideEffect.ClearLocalRow })
    }

    @Test
    fun `a crash outside a flight changes nothing at all`() {
        val captured = captureSale()
        val (afterCrash, effects) = moved(captured, QueueEvent.ProcessDeath)
        assertEquals(OperationState.CAPTURED, afterCrash.state)
        assertEquals(0, afterCrash.attempts)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun `an outcome cannot be recorded for an attempt that was never made`() {
        val step = captureSale().step(QueueEvent.Observe(AttemptResult.Answered(200, null, null, null)))
        assertIs<Step.Refused>(step)
        assertEquals("offline.no_attempt_in_flight", step.code)
        assertEquals(P7Laws.DEVICE_NOT_AUTHORITY.id, step.law)
    }

    @Test
    fun `the key the merchant API will accept is the only key capture allows`() {
        // The merchant API requires 8..200 printable ASCII
        // (`requireIdempotencyKey`, apps/api/src/modules/accounting/accounting.controller.ts),
        // so a key it would reject is refused here — at capture, where the
        // operation can still be re-captured, rather than after an outage when
        // the sale is already made.
        for (bad in listOf("", "short", "a".repeat(201), "has\u0000nul", "عربي")) {
            val threw = runCatching { Operation.capture(bad, EffectClass.FINANCIAL, digest) }.isFailure
            assertTrue(threw, "capture accepted the key '$bad', which the merchant API would refuse")
        }
        for (good in listOf("12345678", "a".repeat(200), key)) {
            Operation.capture(good, EffectClass.FINANCIAL, digest)
        }
    }
}
