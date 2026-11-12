package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * DR-84 condition 4 — the same key with a different intent is never retried by
 * the device.
 *
 * The server computes the intent itself, from the fields of the request it
 * received (`inventoryIntentSha256`, `packages/inventory/src/payload.ts`), and
 * refuses a key it already holds against different fields. That refusal is
 * final: sending again cannot make it true, and editing the payload to match
 * would be the device deciding what the merchant meant. So the row is marked
 * needing attention, it alerts — a divergence is a device defect, not a
 * merchant mistake — and it waits for a human.
 *
 * The other half of the decision is here too: the same key with the SAME
 * intent is a safe replay that returns the original result, which is the whole
 * reason the key exists.
 *
 * Each case carries a control that would catch a kernel which simply never
 * retries anything, because "no retry" is only a law if something else does
 * retry.
 */
class ConflictNoAutoRetryTest {
    private val opId = "8c7b6a59-4d3e-4f21-9a08-1b2c3d4e5f60"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")
    private val digest = QueueDigest.of("{\"totalMinor\":12500}".toByteArray())

    private fun moved(op: Operation, event: QueueEvent): Pair<Operation, List<SideEffect>> {
        val step = op.step(event)
        assertIs<Step.Moved>(step, "expected $event to be legal in ${op.state}")
        return step.operation to step.effects
    }

    /** A row that has been sent once and is waiting for its answer. */
    private fun inFlight(): Operation {
        var (op, _) = moved(
            Operation.capture(opId, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR"),
            QueueEvent.Release(scope),
        )
        val (sent, _) = moved(op, QueueEvent.Send(digest, scope))
        op = sent
        assertEquals(OperationState.IN_FLIGHT, op.state)
        return op
    }

    @Test
    fun `a 409 idempotency conflict marks the operation and schedules nothing`() {
        val answer = AttemptResult.Answered(409, IDEMPOTENCY_CONFLICT, false, null)
        val (op, effects) = moved(inFlight(), QueueEvent.Observe(answer))

        assertEquals(OperationState.NEEDS_ATTENTION, op.state, "a conflict must stop and wait for a human")

        // Nothing that would send again, in any form.
        assertEquals(
            emptyList(),
            effects.filterIsInstance<SideEffect.SendAttempt>(),
            "the device scheduled another attempt after a conflict",
        )
        assertEquals(
            emptyList(),
            effects.filterIsInstance<SideEffect.ClearLocalRow>(),
            "a conflicted row must be kept for diagnosis, not cleared",
        )

        // And it is surfaced: a divergence alerts, because it is a defect on
        // this device and the merchant cannot fix it by waiting.
        val alert = effects.filterIsInstance<SideEffect.Alert>().single()
        assertEquals(IDEMPOTENCY_CONFLICT, alert.code, "the server's code must reach the merchant verbatim")

        // And the row that is now conflicted REFUSES a send, so "no automatic
        // retry" is a property of the state and not only of the step that
        // reached it. A caller that tries anyway — a worker waking up on a
        // schedule, which is exactly how a retry would arrive — is told why,
        // with the code and the law pinned rather than merely non-empty.
        val tried = op.step(QueueEvent.Send(digest, scope))
        assertIs<Step.Refused>(tried, "a conflicted row accepted another send")
        assertEquals("offline.waiting_on_a_person", tried.code)
        assertEquals(P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id, tried.law)
    }

    @Test
    fun `the decision for a conflict is attention with divergence, never a retry`() {
        val decision = Outcome.classify(
            AttemptResult.Answered(409, IDEMPOTENCY_CONFLICT, false, null),
            opId,
            1,
        )
        assertIs<Decision.NeedsAttention>(decision, "a conflict was classified as something other than attention")
        assertEquals(IDEMPOTENCY_CONFLICT, decision.code)
        assertTrue(decision.diverged, "a reused key with a different intent is a divergence by definition")
    }

    /**
     * The control for the case above. If `classify` never returned a retry at
     * all, "a conflict is not retried" would be true and worthless. A 429 is
     * the server saying it applied nothing and to come back, and it must still
     * be a retry.
     */
    @Test
    fun `something else does retry, so the refusal above is the conflict and not the kernel`() {
        val retry = Outcome.classify(AttemptResult.Answered(429, null, null, 2), opId, 1)
        assertIs<Decision.Retry>(retry, "a 429 is a plain retry; if it is not, the conflict case proves nothing")
        assertTrue(retry.afterMs > 0)

        val lost = Outcome.classify(AttemptResult.NoAnswer, opId, 1)
        assertIs<Decision.ResolveByReplay>(lost, "a lost answer is resolved by replaying the same key")
    }

    @Test
    fun `the same key with the same intent is a safe replay that returns the original result`() {
        // The server's own `replayed` flag: it did not write again, it handed
        // back what it already held. That is success, not a conflict.
        val answer = AttemptResult.Answered(200, null, true, null)
        val (op, effects) = moved(inFlight(), QueueEvent.Observe(answer))

        assertEquals(OperationState.SYNCED, op.state, "a replay is the success it is")
        assertTrue(op.replayed, "the row must record that this result was a replay, not a second write")
        assertTrue(
            effects.filterIsInstance<SideEffect.ClearLocalRow>().isNotEmpty(),
            "a settled row is cleared locally",
        )
        assertEquals(
            emptyList(),
            effects.filterIsInstance<SideEffect.Alert>(),
            "a safe replay must not alert anyone",
        )
    }

    /**
     * The conflict code is not matched by spelling. The detector is semantic —
     * any domain's `*.idempotency_conflict`, plus the tenancy module's own
     * `IDEMPOTENCY_KEY_REUSED` — so a module added later does not fall out of
     * it silently. Measured here over a domain that does not exist yet.
     */
    @Test
    fun `a conflict from a domain this kernel has never heard of is still a conflict`() {
        val decision = Outcome.classify(
            AttemptResult.Answered(409, "receivables.idempotency_conflict", false, null),
            opId,
            1,
        )
        assertIs<Decision.NeedsAttention>(decision)
        assertTrue(decision.diverged)

        // The control: a 409 that is NOT an idempotency conflict is still not
        // retried, but it is not a divergence either -- it is the merchant's
        // business conflict, and the two must not be conflated.
        val business = Outcome.classify(
            AttemptResult.Answered(409, "inventory.insufficient_stock", false, null),
            opId,
            1,
        )
        assertIs<Decision.NeedsAttention>(business)
        assertEquals(false, business.diverged, "a business refusal was reported as a device defect")
    }
}
