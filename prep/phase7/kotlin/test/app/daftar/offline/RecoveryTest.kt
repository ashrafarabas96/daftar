package app.daftar.offline

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The merchant-facing half of the kernel (PART 7.4: user-visible recovery and
 * conflict states).
 *
 * Two properties carry everything here. One is that the mapping is COMPLETE,
 * swept from the kernel's own source rather than from a list someone
 * maintained. The other is that no surface can present unconfirmed money as
 * taken — L1 at the only boundary where a person can be misled by it.
 */
class RecoveryTest {
    private val key = "9f8e7d6c-5b4a-4938-8271-615f4e3d2c1b"
    private val digest = "sha256:cafebabe"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    /**
     * Challenger finding G-03: these three were inline inequalities in the
     * filter below, with no name and no reason, so a reader could not tell
     * "deliberately a developer problem" from "forgot to map it" — and the
     * next entry added the same way would be indistinguishable from
     * suppressing a real miss. Each one here states why the generic view is
     * the RIGHT view for it.
     */
    private val deliberatelyADeveloperProblem = mapOf(
        // The server says this key was used for different bytes. Nothing a
        // merchant can do changes that, and no retry clears it.
        "offline.divergence_needs_a_fix" to "the key was reused for different bytes; only a fix helps",
        // The payload was rebuilt between capture and send, which is a client
        // bug: the bytes a merchant approved no longer exist to send.
        "offline.payload_changed_after_capture" to "the app rebuilt a frozen payload; the capture is gone",
        // A restore handed back bytes that are not the captured ones, which
        // means the restore path itself is wrong.
        "offline.restored_payload_does_not_match_capture" to "the restore returned the wrong bytes",
        // J-01. A result for a row nothing was ever sent from, and a result
        // for an attempt this kernel already settled with the server's own
        // refusal, are both the transport out of step with the queue. There is
        // nothing for the merchant to do and nothing for them to wait for,
        // which is why these two stopped sharing a code — and a view — with a
        // late answer for an attempt that really is out.
        "offline.no_attempt_was_ever_made" to "an answer arrived for a row nothing was ever sent from",
        "offline.attempt_already_resolved" to "an answer arrived for an attempt already settled by refusal",
    ).keys

    /**
     * The captured facts per effect class. Challenger finding J-02: only a
     * FINANCIAL capture has an amount in minor units and a currency, and a
     * fixture that gave an inventory count some was denominating stock in a
     * currency.
     */
    private fun amountFor(effect: EffectClass): Long? =
        if (effect == EffectClass.FINANCIAL) 12_500 else null

    private fun currencyFor(effect: EffectClass): String? =
        if (effect == EffectClass.FINANCIAL) "SAR" else null

    private fun kernelSources(): List<File> {
        val root = File(System.getProperty("p7.src") ?: "prep/phase7/kotlin/src")
        val sources = root.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.toList()
        assertTrue(sources.size >= 6, "only ${sources.size} kernel sources found — the sweep found no subject")
        return sources
    }

    /**
     * The completeness proof, and the reason this file is worth more than a
     * table of strings.
     *
     * A hand-written list of codes rots the moment someone adds a refusal.
     * So the subjects come from the kernel's own source: every `offline.*`
     * literal it contains must have a view that is not the unrecognised-code
     * fallback. A code added without deciding what a person is told fails
     * HERE, which is before a till.
     */
    @Test
    fun `every refusal code the kernel can produce has a stated merchant view`() {
        val literal = Regex("\"(offline\\.[a-z_]+)\"")
        val codes = kernelSources()
            .flatMap { file -> literal.findAll(file.readText()).map { it.groupValues[1] } }
            .toSortedSet()

        assertTrue(codes.size >= 20, "the sweep found only ${codes.size} codes; the kernel has more than that")

        val unexplained = codes.filter { code ->
            Recovery.explain(code).message == MerchantMessage.DEVICE_SOFTWARE_PROBLEM &&
                code !in deliberatelyADeveloperProblem
        }
        assertEquals(
            emptyList(), unexplained,
            "these codes reach a merchant as a generic device-software problem, which erases what " +
                "they could actually do about it. If one of them genuinely is a device defect, add " +
                "it to deliberatelyADeveloperProblem WITH ITS REASON rather than widening this test",
        )
    }

    /**
     * Non-vacuity for the sweep above. If `explain` returned a real message
     * for everything, including nonsense, the test would pass while proving
     * nothing — so the fallback is required to still be reachable by a code
     * that does not exist.
     */
    @Test
    fun `a code this layer does not understand is not dressed up as something actionable`() {
        val view = Recovery.explain("offline.a_code_from_a_later_version")
        assertEquals(MerchantMessage.DEVICE_SOFTWARE_PROBLEM, view.message)
        assertEquals(RecoveryAction.THIS_NEEDS_A_DEVELOPER, view.action)
        assertTrue(!view.showsMoneyAsTaken)
    }

    /**
     * L1, at the boundary where it is visible to a person.
     *
     * A kernel that never calls an unconfirmed operation SYNCED, in front of a
     * screen that shows a green tick for a captured sale, has still told the
     * merchant the money is in. This is the assertion that the screen cannot.
     */
    @Test
    fun `no state but SYNCED is ever shown to the merchant as money taken`() {
        var shown = 0
        for (state in OperationState.entries) {
            for (effect in EffectClass.entries) {
                val op = operationIn(state, effect)
                val view = Recovery.viewOf(op)
                if (view.showsMoneyAsTaken) {
                    assertEquals(
                        OperationState.SYNCED, state,
                        "a $state $effect operation is presented as recorded money " +
                            "(${P7Laws.DEVICE_NOT_AUTHORITY.id})",
                    )
                    shown++
                }
            }
        }
        // Non-vacuity: a mapping that showed nothing as taken would pass the
        // loop above and would also never tell a merchant a sale succeeded.
        assertEquals(EffectClass.entries.size, shown, "no state is shown as recorded at all")
    }

    @Test
    fun `a refusal is never presented as money taken, over every code the kernel has`() {
        val literal = Regex("\"(offline\\.[a-z_]+)\"")
        val codes = kernelSources()
            .flatMap { file -> literal.findAll(file.readText()).map { it.groupValues[1] } }
            .toSortedSet()
        for (code in codes) {
            assertTrue(
                !Recovery.explain(code).showsMoneyAsTaken,
                "the refusal $code is shown to the merchant as recorded money",
            )
        }
    }

    /**
     * No internal vocabulary reaches a person. A message key that carried a
     * server code or a law id would put `P7-L13` or `offline.scope_switched`
     * in front of a cashier the first time somebody rendered the key as a
     * fallback string — and the same leak is how internal structure ends up
     * in a screenshot in a support ticket.
     */
    @Test
    fun `no merchant message key carries a server code or a law id`() {
        for (message in MerchantMessage.entries) {
            val name = message.name
            assertTrue(!name.contains("OFFLINE_"), "$name looks like a server code")
            assertTrue(!name.startsWith("P7"), "$name looks like a law id")
            assertTrue(
                name.none { it.isDigit() },
                "$name carries a number, which in this project means a law or an error id",
            )
        }
    }

    /**
     * The three re-entry refusals are the only ones that stop the till, and
     * they have to. A merchant told "no" with no explanation and no block
     * will key the sale in again, which is precisely the duplicate L15 and
     * L17 exist to prevent — so the gate has to reach the UI, not only the
     * kernel.
     */
    @Test
    fun `only the re-entry refusals stop the till, and all three of them do`() {
        val blocking = mutableSetOf<String>()
        val literal = Regex("\"(offline\\.[a-z_]+)\"")
        for (file in kernelSources()) {
            for (m in literal.findAll(file.readText())) {
                val code = m.groupValues[1]
                if (Recovery.explain(code).blocksNewCaptures) blocking += code
            }
        }
        assertEquals(
            setOf(
                "offline.original_already_committed",
                "offline.original_unsettled",
                "offline.absence_not_fenced",
                "offline.prior_state_undetermined",
            ),
            blocking,
            "the set of refusals that stop the till is not the set of re-entry refusals",
        )
    }

    /**
     * An unknown outcome is the state most likely to be mistranslated, and
     * both wrong answers cost money: "failed" invites a re-key, "done"
     * records a sale the server may not hold.
     */
    @Test
    fun `an unknown outcome is shown as neither failed nor done`() {
        val view = Recovery.viewOf(operationIn(OperationState.UNKNOWN_OUTCOME, EffectClass.FINANCIAL))
        assertEquals(MerchantMessage.SALE_OUTCOME_UNKNOWN_WILL_RETRY, view.message)
        assertEquals(RecoveryAction.WAIT_IT_IS_IN_PROGRESS, view.action)
        assertTrue(!view.showsMoneyAsTaken)
    }

    /**
     * The two NEEDS_ATTENTION cases that must not share a button: a
     * divergence is a device defect no retry can clear, and a minimized
     * payload needs the payload back before anything can be sent at all.
     */
    @Test
    fun `needing attention is not one state as far as the merchant is concerned`() {
        val diverged = Recovery.viewOf(
            needingAttention(EffectClass.FINANCIAL, lastCode = "IDEMPOTENCY_KEY_REUSED"),
        )
        assertEquals(RecoveryAction.THIS_NEEDS_A_DEVELOPER, diverged.action)

        val closedPeriod = Recovery.viewOf(
            needingAttention(EffectClass.FINANCIAL, lastCode = "accounting.period_closed"),
        )
        assertEquals(RecoveryAction.ESCALATE_TO_A_SUPERVISOR, closedPeriod.action)

        val minimized = Recovery.viewOf(
            minimizedAndWaiting(),
        )
        assertEquals(RecoveryAction.RESTORE_THE_APPROVED_PAYLOAD, minimized.action)
        assertEquals(MerchantMessage.DETAILS_REDUCED_TO_PROTECT_PRIVACY, minimized.message)

        // A benign operation CAN be retried by the till, and a material one
        // cannot be abandoned by it, so the two get different offers.
        val benign = Recovery.viewOf(needingAttention(EffectClass.BENIGN, lastCode = "validation.failed"))
        assertEquals(RecoveryAction.RETRY_THE_SAME_OPERATION, benign.action)
    }

    /**
     * Challenger finding J-01, by name, for every refusal it reaches.
     *
     * A refusal's code decides what a person is told, and four facts used to
     * share two codes whose view said "wait": a row that was abandoned, a row
     * the server had already recorded, a row waiting on a decision, and a
     * result for an attempt that was never made. The harm I-01 described was
     * the ACTION — `WAIT_IT_IS_IN_PROGRESS`, whose own documentation says the
     * device is working — and the first version of INV-9b judged the message,
     * so three of these survived it. Each is named here, and the model check
     * asserts the general rule over every reachable configuration: a view may
     * instruct a wait only where something is genuinely pending.
     */
    @Test
    fun `a refusal never tells the merchant to wait for a device that has finished`() {
        val abandoned = operationIn(OperationState.DISCARDED, EffectClass.FINANCIAL)
        val recorded = operationIn(OperationState.SYNCED, EffectClass.FINANCIAL)
        val awaitingAPerson = operationIn(OperationState.NEEDS_ATTENTION, EffectClass.FINANCIAL)
        val captured = operationIn(OperationState.CAPTURED, EffectClass.FINANCIAL)
        val anAnswer = QueueEvent.Observe(AttemptResult.Answered(201, null, false, null))

        val expected: List<Triple<Operation, QueueEvent, String>> = listOf(
            // Abandoned: I-01's own case, and the two events beside it.
            Triple(abandoned, QueueEvent.Release(scope), "offline.already_abandoned"),
            Triple(abandoned, QueueEvent.CancelByMerchant(scope), "offline.already_abandoned"),
            Triple(abandoned, anAnswer, "offline.already_abandoned"),
            // Recorded by the server: not "already confirmed, wait for it".
            Triple(recorded, QueueEvent.Release(scope), "offline.already_recorded"),
            Triple(recorded, QueueEvent.CancelByMerchant(scope), "offline.already_recorded"),
            Triple(recorded, anAnswer, "offline.already_recorded"),
            // Waiting on a decision: telling the person to wait would be
            // telling them to wait for themselves.
            Triple(awaitingAPerson, QueueEvent.Release(scope), "offline.waiting_on_a_person"),
            Triple(awaitingAPerson, QueueEvent.CancelByMerchant(scope), "offline.waiting_on_a_person"),
            // The transport out of step with the queue, in both directions.
            Triple(captured, anAnswer, "offline.no_attempt_was_ever_made"),
            Triple(awaitingAPerson, anAnswer, "offline.attempt_already_resolved"),
        )

        for ((op, event, code) in expected) {
            val step = op.step(event)
            assertIs<Step.Refused>(step, "${op.state} moved on $event")
            assertEquals(code, step.code, "a ${op.state} row refused $event as ${step.code}")
            val view = Recovery.explain(step.code)
            assertTrue(
                view.action != RecoveryAction.WAIT_IT_IS_IN_PROGRESS,
                "a ${op.state} row tells the merchant to wait: $code -> ${view.message}",
            )
            assertTrue(!view.showsMoneyAsTaken)
        }

        // Non-vacuity, and the other half of the rule: where something IS
        // pending, the wait is the honest instruction and is still given.
        val queued = operationIn(OperationState.QUEUED, EffectClass.FINANCIAL)
        val again = assertIs<Step.Refused>(queued.step(QueueEvent.Release(scope)))
        assertEquals("offline.already_released", again.code)
        assertEquals(RecoveryAction.WAIT_IT_IS_IN_PROGRESS, Recovery.explain(again.code).action)
    }

    // ── fixtures, built through the real reducer, never hand-constructed ──

    private fun needingAttention(effect: EffectClass, lastCode: String): Operation {
        var op = Operation.capture(key, scope, effect, digest, amountFor(effect), currencyFor(effect))
        op = (op.step(QueueEvent.Release(scope)) as Step.Moved).operation
        op = (op.step(QueueEvent.Send(digest, scope)) as Step.Moved).operation
        val step = op.step(QueueEvent.Observe(AttemptResult.Answered(409, lastCode, null, null))) as Step.Moved
        assertEquals(OperationState.NEEDS_ATTENTION, step.operation.state, "fixture did not reach the state it names")
        return step.operation
    }

    private fun minimizedAndWaiting(): Operation {
        val waiting = needingAttention(EffectClass.FINANCIAL, "accounting.period_closed")
        val step = waiting.step(QueueEvent.RetentionDeadlineReached) as Step.Moved
        assertTrue(step.operation.payloadMinimized)
        return step.operation
    }

    /**
     * Every state, reached by the events that actually produce it. A
     * hand-built `Operation` cannot exist — the constructor is private — and
     * that is deliberate: a fixture that fakes a state proves the view of a
     * configuration the kernel cannot produce.
     */
    private fun operationIn(state: OperationState, effect: EffectClass): Operation {
        var op = Operation.capture(key, scope, effect, digest, amountFor(effect), currencyFor(effect))
        if (state == OperationState.CAPTURED) return op
        if (state == OperationState.DISCARDED) {
            return (op.step(QueueEvent.CancelByMerchant(scope)) as Step.Moved).operation
        }
        op = (op.step(QueueEvent.Release(scope)) as Step.Moved).operation
        if (state == OperationState.QUEUED) return op
        op = (op.step(QueueEvent.Send(digest, scope)) as Step.Moved).operation
        if (state == OperationState.IN_FLIGHT) return op
        return when (state) {
            OperationState.UNKNOWN_OUTCOME ->
                (op.step(QueueEvent.Observe(AttemptResult.NoAnswer)) as Step.Moved).operation

            OperationState.SYNCED ->
                (
                    op.step(QueueEvent.Observe(AttemptResult.Answered(201, null, false, null))) as Step.Moved
                    ).operation

            OperationState.NEEDS_ATTENTION -> needingAttention(effect, "accounting.period_closed")

            else -> error("unreachable: $state is handled above")
        }
    }
}
