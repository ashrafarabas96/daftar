package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    private fun captureSale() = Operation.capture(key, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR")

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
        var (op, _) = moved(captureSale(), QueueEvent.Release(scope))
        val (sent, effects) = moved(op, QueueEvent.Send(digest, scope))
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
        val (resent, resendEffects) = moved(op, QueueEvent.Send(digest, scope))
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
        var (op, _) = moved(captureSale(), QueueEvent.Release(scope))
        repeat(5) {
            op = moved(op, QueueEvent.Send(digest, scope)).first
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
        var (op, _) = moved(captureSale(), QueueEvent.Release(scope))
        op = moved(op, QueueEvent.Send(digest, scope)).first
        val step = op.step(QueueEvent.CancelByMerchant(scope))
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
        var (op, _) = moved(captureSale(), QueueEvent.Release(scope))
        op = moved(op, QueueEvent.Send(digest, scope)).first
        op = moved(op, QueueEvent.Observe(AttemptResult.Answered(429, null, null, 30))).first
        // Back in the queue, indistinguishable by STATE from a sale that was
        // never sent — and entirely different in fact.
        assertEquals(OperationState.QUEUED, op.state)
        assertEquals(1, op.attempts)

        val step = op.step(QueueEvent.CancelByMerchant(scope))
        assertIs<Step.Refused>(step, "a sent sale was cancellable because it had returned to QUEUED")
        assertEquals("offline.cancel_after_send", step.code)
        assertEquals(P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id, step.law)
    }

    @Test
    fun `a sale not yet sent can be cancelled, and that is the only window`() {
        val (discarded, effects) = moved(captureSale(), QueueEvent.CancelByMerchant(scope))
        assertEquals(OperationState.DISCARDED, discarded.state)
        assertTrue(effects.any { it is SideEffect.ClearLocalRow })
        assertEquals(0, discarded.attempts, "nothing was ever sent, so nothing can exist on the server")
    }

    @Test
    fun `a payload recomputed at send time is refused here, not by the server`() {
        val (op, _) = moved(captureSale(), QueueEvent.Release(scope))
        // The shape of the real bug: a total re-derived at send time, a locale
        // re-resolved, a date taken from the clock. The bytes differ, so the
        // server would bind this key to a different payload and refuse it
        // permanently — and the sale would be unsendable forever.
        val step = op.step(QueueEvent.Send("sha256:recomputed", scope))
        assertIs<Step.Refused>(step)
        assertEquals("offline.payload_changed_after_capture", step.code)
        assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, step.law)
        assertEquals(0, op.attempts, "a send that never left must not consume an attempt")
    }

    @Test
    fun `a stock conflict waits for a person and keeps the server's own words`() {
        var (op, _) = moved(Operation.capture(key, scope, EffectClass.INVENTORY, digest, null, null), QueueEvent.Release(scope))
        op = moved(op, QueueEvent.Send(digest, scope)).first
        val (refused, effects) = moved(
            op, QueueEvent.Observe(AttemptResult.Answered(409, "inventory.insufficient_stock", null, null)),
        )
        assertEquals(OperationState.NEEDS_ATTENTION, refused.state)
        assertEquals("inventory.insufficient_stock", refused.lastCode)
        assertTrue(effects.isEmpty(), "a business refusal is not an operational alert")

        // The merchant may not make it go away.
        val abandon = refused.step(QueueEvent.ResolveByMerchant(keep = false, scope))
        assertIs<Step.Refused>(abandon)
        assertEquals("offline.material_cannot_be_abandoned", abandon.code)

        // They may count the stock and try the same operation again.
        val (requeued, _) = moved(refused, QueueEvent.ResolveByMerchant(keep = true, scope))
        assertEquals(OperationState.QUEUED, requeued.state, "a stated refusal means nothing was committed")
    }

    @Test
    fun `a reused key with a changed payload alerts as a defect and offers no retry`() {
        var (op, _) = moved(captureSale(), QueueEvent.Release(scope))
        op = moved(op, QueueEvent.Send(digest, scope)).first
        val (diverged, effects) = moved(
            op, QueueEvent.Observe(AttemptResult.Answered(409, "IDEMPOTENCY_KEY_REUSED", null, null)),
        )
        assertEquals(OperationState.NEEDS_ATTENTION, diverged.state)
        val alert = effects.filterIsInstance<SideEffect.Alert>().single()
        assertEquals("IDEMPOTENCY_KEY_REUSED", alert.code)
        assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, alert.law)

        // Retrying cannot work: the server will refuse the same key the same
        // way forever. Offering the merchant that button would be a lie.
        val retry = diverged.step(QueueEvent.ResolveByMerchant(keep = true, scope))
        assertIs<Step.Refused>(retry)
        assertEquals("offline.divergence_needs_a_fix", retry.code)
    }

    @Test
    fun `a benign refusal may be let go, and only a benign one`() {
        var (op, _) = moved(Operation.capture(key, scope, EffectClass.BENIGN, digest, null, null), QueueEvent.Release(scope))
        op = moved(op, QueueEvent.Send(digest, scope)).first
        op = moved(op, QueueEvent.Observe(AttemptResult.Answered(422, "VALIDATION_FAILED", null, null))).first
        assertEquals(OperationState.NEEDS_ATTENTION, op.state)
        val (gone, effects) = moved(op, QueueEvent.ResolveByMerchant(keep = false, scope))
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
        // J-01: a result for a row nothing was ever sent from had the same
        // code, and the same "wait for it" view, as a result arriving late for
        // an attempt that really is out. It is the device out of step with
        // itself, and it says so now.
        assertEquals("offline.no_attempt_was_ever_made", step.code)
        assertEquals(RecoveryAction.THIS_NEEDS_A_DEVELOPER, Recovery.explain(step.code).action)
        assertEquals(P7Laws.DEVICE_NOT_AUTHORITY.id, step.law)
    }

    /**
     * Challenger findings J-02, J-03 and J-05 — what a capture must say about
     * what it is worth, and what the kernel refuses to decide about it.
     */
    @Test
    fun `a sale states what it is worth, a stocktake has nothing to state, and neither value is judged`() {
        // J-02. INVENTORY is "a movement, a transfer, an adjustment, a
        // stocktake count": a quantity and a unit, never minor units and never
        // a currency. Requiring them made fabricating a currency a
        // precondition of storing a stocktake — which my own fixtures did, in
        // two different currencies for the same seven units of stock.
        for (effect in listOf(EffectClass.INVENTORY, EffectClass.BENIGN)) {
            val op = Operation.capture(key, scope, effect, digest, null, null)
            assertEquals(null, op.amountMinorUnits, "a $effect capture was made to carry an amount")
            assertEquals(null, op.currency)
        }

        // A sale, by contrast, must say both, and each is its own refusal so
        // that neither can mask the other.
        val noAmount = assertFailsWith<IllegalArgumentException> {
            Operation.capture(key, scope, EffectClass.FINANCIAL, digest, null, "SAR")
        }
        assertTrue(
            noAmount.message!!.contains("what it is worth"),
            "the refusal does not name the missing amount: ${noAmount.message}",
        )
        for (blank in listOf(null, "", "   ")) {
            val noCurrency = assertFailsWith<IllegalArgumentException> {
                Operation.capture(key, scope, EffectClass.FINANCIAL, digest, 12_500, blank)
            }
            assertTrue(
                noCurrency.message!!.contains("currency"),
                "the refusal does not name the missing currency: ${noCurrency.message}",
            )
        }

        // J-05, written down because it is a decision and not an oversight: the
        // kernel does not judge the VALUE. A fully discounted sale may be a
        // legitimate zero and a refund may be negative, and a device that
        // refused a total would be asserting a total of its own. What reaches
        // the custody record is what was captured, unaltered — and the
        // obligation not to capture a basket that has not been totalled yet is
        // the selling surface's, recorded in `P7-S1` §10.
        for (amount in listOf(0L, -999L, Long.MAX_VALUE)) {
            val op = Operation.capture(key, scope, EffectClass.FINANCIAL, digest, amount, "SAR")
            assertEquals(amount, op.amountMinorUnits, "the kernel altered a captured total")
            val bob = OwnerScope(scope.tenantId, scope.businessId, "member-bob")
            val step = op.step(QueueEvent.CancelByMerchant(bob)) as Step.Moved
            val erase = step.effects.filterIsInstance<SideEffect.ClearLocalRowRecording>().single()
            assertEquals(amount, erase.record.amountMinorUnits, "the record did not say what was lost")
            assertEquals("SAR", erase.record.currency)
        }
    }

    /**
     * Challenger finding J-03 — the property no runtime test can hold.
     *
     * `amountMinorUnits` and `currency` arrived with `= null` defaults, so a
     * capture written before this round compiled unchanged and threw the first
     * time it ran. The compiler is the one thing that could have enumerated
     * every call site, and a default switches it off. This kernel already has
     * the idiom twice over — `EffectClass` has no default anywhere, and
     * `QueueEvent.Send` takes `actingScope` as a required argument because
     * "there is no overload that lets it" be skipped — so the guard is the
     * same shape as the one that forbids a defaulted `EffectClass`: a textual
     * sweep that proves it can see a planted default.
     */
    @Test
    fun `the facts a capture must state cannot be omitted by a caller`() {
        val root = java.io.File(System.getProperty("p7.src") ?: "prep/phase7/kotlin/src")
        assertTrue(root.isDirectory, "the kernel source was not found at ${root.absolutePath}")
        val sources = root.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.toList()
        assertTrue(sources.size >= 6, "only ${sources.size} kernel sources found — the sweep found no subject")
        val queue = sources.first { it.name == "Queue.kt" }.readText()
        // Challenger finding K-03: the declaration counter below read `Queue.kt`
        // alone, so a `capture` declared in any other kernel file left the
        // count at one. The reasoning was always about the whole source set —
        // "the number of ways in" — so the subject is the whole source set,
        // the way the refusal-vocabulary sweep already takes it.
        val allSource = sources.joinToString("\n") { it.readText() }

        val forbidden = listOf(
            Regex("""amountMinorUnits:\s*Long\?\s*=\s*"""),
            Regex("""currency:\s*String\?\s*=\s*"""),
            Regex("""effect:\s*EffectClass\s*=\s*"""),
        )
        val offenders = forbidden.mapNotNull { it.find(queue)?.value }
        assertEquals(
            emptyList(), offenders,
            "a fact a capture must state has a default, so a call site that omits it compiles and " +
                "fails at run time instead",
        )

        // And the guard can see what it is looking for.
        val plants = listOf(
            "amountMinorUnits: Long? = null,",
            "currency: String? = null,",
            "effect: EffectClass = EffectClass.BENIGN,",
        )
        for (plant in plants) {
            assertTrue(
                forbidden.any { it.containsMatchIn(plant) },
                "the guard cannot see the default '$plant', so its verdict means nothing",
            )
        }

        // Coordinator finding D-02: the guard above watched for a DEFAULT, and
        // a default is only one of the two ways to let a caller omit a fact.
        // An OVERLOAD does it too — `capture(key, scope, effect, digest)`
        // delegating `null, null` — and the coordinator measured the suite
        // staying green with one added, while a pre-round call site compiled
        // again and threw at the till, which is J-03's harm restored through
        // the door this file left open. `Queue.kt` argues the general form
        // itself at the `EffectClass` property: an obligation is not
        // structural if an overload lets a caller past it. So what is asserted
        // is the number of ways in, not the shape of one of them.
        val declaration = Regex("fun\\s+capture\\s*\\(")
        assertEquals(
            1, declaration.findAll(allSource).count(),
            "the kernel declares more than one capture function. A second one is a way to capture " +
                "without stating what the operation is worth, whatever its body passes for null",
        )
        val signature = queue.substringAfter("fun capture(").substringBefore("): Operation")
        val mustBeAsked = listOf(
            "effect: EffectClass",
            "payloadDigest: String",
            "amountMinorUnits: Long?",
            "currency: String?",
        )
        for (required in mustBeAsked) {
            assertTrue(
                signature.contains(required),
                "the one capture declaration does not take '$required', so the fact it carries is " +
                    "not required of a caller at all",
            )
        }

        // Non-vacuity, both ways: the counter can see an overload, and the
        // signature check can see a parameter that is not there.
        assertEquals(
            2,
            declaration.findAll("fun capture(a: Int) = 1 ; fun capture(\n b: Int,\n) = 2").count(),
            "the declaration counter cannot see an overload, so its verdict means nothing",
        )
        assertTrue(
            !"key: String, scope: OwnerScope, effect: EffectClass, payloadDigest: String"
                .contains("amountMinorUnits: Long?"),
            "the signature check cannot see an omitted parameter",
        )
    }

    @Test
    fun `the key the merchant API will accept is the only key capture allows`() {
        // The merchant API requires 8..200 printable ASCII
        // (`requireIdempotencyKey`, apps/api/src/modules/accounting/accounting.controller.ts),
        // so a key it would reject is refused here — at capture, where the
        // operation can still be re-captured, rather than after an outage when
        // the sale is already made.
        for (bad in listOf("", "short", "a".repeat(201), "has\u0000nul", "عربي")) {
            val threw = runCatching { Operation.capture(bad, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR") }.isFailure
            assertTrue(threw, "capture accepted the key '$bad', which the merchant API would refuse")
        }
        for (good in listOf("12345678", "a".repeat(200), key)) {
            Operation.capture(good, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR")
        }
    }
}
