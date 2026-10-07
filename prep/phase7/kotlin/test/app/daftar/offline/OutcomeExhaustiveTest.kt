package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The classifier, proved over its whole input space rather than sampled.
 *
 * "Exhaustive" here means every integer status from 0 to 699 — below, inside
 * and above the HTTP range — crossed with every refusal code the kernel can
 * meet, both `replayed` values, and a spread of `Retry-After` values including
 * the absurd ones. 0..699 is the real input space and not a tidy stand-in for
 * it: the status reaching this function comes from a transport that has met
 * proxies and load balancers, and a function that is total only over the
 * statuses an RFC lists is not total.
 */
class OutcomeExhaustiveTest {
    private val codes = listOf(
        null,
        "",
        "   ",
        "IDEMPOTENCY_KEY_REUSED",
        "accounting.idempotency_conflict",
        "inventory.idempotency_conflict",
        "sales.idempotency_conflict",
        "inventory.insufficient_stock",
        "customer.credit_limit_exceeded",
        "VALIDATION_FAILED",
        "accounting.period_closed",
    )
    private val retryAfters = listOf<Long?>(null, -5, 0, 1, 30, 3_600, 3_601, 86_400)
    private val op = "11111111-2222-4333-8444-555555555555"

    private fun every(block: (AttemptResult.Answered) -> Unit) {
        for (status in 0..699) {
            for (code in codes) {
                for (replayed in listOf(null, false, true)) {
                    for (ra in retryAfters) {
                        block(AttemptResult.Answered(status, code, replayed, ra))
                    }
                }
            }
        }
    }

    /**
     * THE load-bearing property of the kernel. If this test is the only one
     * that survives, the queue still cannot report a sale as done that the
     * server never committed.
     */
    @Test
    fun `no answer outside 2xx can ever produce Synced`() {
        var checked = 0
        every { answered ->
            val decision = Outcome.classify(answered, op, 1)
            if (answered.status !in 200..299) {
                assertFalse(
                    decision is Decision.Synced,
                    "status ${answered.status} / code ${answered.errorCode} produced $decision — " +
                        "only a 2xx means the server committed (${P7Laws.DEVICE_NOT_AUTHORITY.id})",
                )
            }
            checked++
        }
        // The count is asserted so that a future edit which narrows the loops
        // cannot leave this proof passing over a handful of inputs: an
        // exhaustive claim whose subject set quietly shrank is no longer
        // exhaustive, and nothing else here would notice.
        assertEquals(700 * codes.size * 3 * retryAfters.size, checked)
        assertTrue(checked > 100_000, "the exhaustive sweep must really be exhaustive, saw $checked")
    }

    @Test
    fun `an unanswered attempt is always unknown, never failed and never done`() {
        for (attempt in 1..25) {
            val decision = Outcome.classify(AttemptResult.NoAnswer, op, attempt)
            assertTrue(decision is Decision.ResolveByReplay, "attempt $attempt gave $decision")
            assertEquals(P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id, decision.law)
            assertTrue(decision.afterMs in Backoff.FLOOR_MS..Backoff.CAP_MS, "delay ${decision.afterMs}")
        }
    }

    @Test
    fun `every 2xx syncs and carries the server's own replayed flag unchanged`() {
        for (status in 200..299) {
            for (replayed in listOf(null, false, true)) {
                val decision = Outcome.classify(
                    AttemptResult.Answered(status, null, replayed, null), op, 1,
                )
                assertTrue(decision is Decision.Synced, "status $status gave $decision")
                // `null` means the endpoint carries no flag, which is a first
                // write, not a replay. Reading an absent flag as a replay
                // would make the device claim knowledge it was never given.
                assertEquals(replayed == true, decision.replayed, "status $status, replayed=$replayed")
                assertEquals(P7Laws.REPLAY_IS_SUCCESS.id, decision.law)
            }
        }
    }

    @Test
    fun `the classifier is total and every decision cites a stated law`() {
        val stated = P7Laws.ALL.map { it.id }.toSet()
        every { answered ->
            val decision = Outcome.classify(answered, op, 1)
            assertTrue(decision.law in stated, "$decision cites an unstated law")
        }
    }

    @Test
    fun `a reused key with a different payload is detected by meaning, not by spelling`() {
        assertTrue(Outcome.isDivergence("IDEMPOTENCY_KEY_REUSED"))
        assertTrue(Outcome.isDivergence("  IDEMPOTENCY_KEY_REUSED  "))
        assertTrue(Outcome.isDivergence("accounting.idempotency_conflict"))
        // The suffix rule is what keeps a domain added later from falling
        // silently out of the detector.
        assertTrue(Outcome.isDivergence("a_domain_invented_tomorrow.idempotency_conflict"))

        // Look-alikes are NOT divergences. A detector that matched these would
        // report a device defect for an ordinary business refusal.
        assertFalse(Outcome.isDivergence(null))
        assertFalse(Outcome.isDivergence(""))
        assertFalse(Outcome.isDivergence("IDEMPOTENCY_KEY_REUSED_TWICE"))
        assertFalse(Outcome.isDivergence("idempotency_conflict"))
        assertFalse(Outcome.isDivergence("conflict.idempotency"))
        assertFalse(Outcome.isDivergence("inventory.insufficient_stock"))
    }

    /**
     * Five 4xx statuses mean something on their own and take precedence over
     * whatever code rides along with them: a 401 is a dead session whatever
     * the body says, and a 429 is an instruction to wait. The precedence is
     * asserted in its own test below rather than excluded silently here.
     */
    private val statusesWithTheirOwnMeaning = setOf(401, 403, 408, 423, 429)

    @Test
    fun `a divergence is reported as a device defect and never as a retry`() {
        for (code in listOf("IDEMPOTENCY_KEY_REUSED", "accounting.idempotency_conflict")) {
            for (status in (400..499) - statusesWithTheirOwnMeaning) {
                val decision = Outcome.classify(
                    AttemptResult.Answered(status, code, null, null), op, 3,
                )
                assertTrue(decision is Decision.NeedsAttention, "status $status gave $decision")
                assertTrue(decision.diverged, "status $status / $code was not reported as a divergence")
                assertEquals(code, decision.code, "the server's code must be preserved verbatim")
                assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, decision.law)
            }
        }
    }

    @Test
    fun `a transport status outranks a refusal code that rides along with it`() {
        // Not a nicety: a device that read "key reused" out of a 401 body would
        // mark a perfectly good sale as an unfixable device defect, when all
        // that happened is that the session expired while it was queued.
        for (code in listOf("IDEMPOTENCY_KEY_REUSED", "accounting.idempotency_conflict")) {
            assertEquals(
                Outcome.SESSION_EXPIRED,
                (Outcome.classify(AttemptResult.Answered(401, code, null, null), op, 1) as Decision.NeedsAttention).code,
            )
            assertEquals(
                Outcome.PERMISSION_REVOKED,
                (Outcome.classify(AttemptResult.Answered(403, code, null, null), op, 1) as Decision.NeedsAttention).code,
            )
            for (status in listOf(423, 429)) {
                assertTrue(Outcome.classify(AttemptResult.Answered(status, code, null, null), op, 1) is Decision.Retry)
            }
            assertTrue(
                Outcome.classify(AttemptResult.Answered(408, code, null, null), op, 1) is Decision.ResolveByReplay,
            )
        }
        assertEquals(5, statusesWithTheirOwnMeaning.size)
    }

    @Test
    fun `a stated business refusal waits for a human and is never retried`() {
        for (code in listOf("inventory.insufficient_stock", "customer.credit_limit_exceeded", "VALIDATION_FAILED")) {
            for (status in listOf(400, 404, 409, 410, 422, 451, 499)) {
                val decision = Outcome.classify(AttemptResult.Answered(status, code, null, null), op, 1)
                assertTrue(decision is Decision.NeedsAttention, "status $status gave $decision")
                assertFalse(decision.diverged)
                assertEquals(code, decision.code)
            }
        }
    }

    @Test
    fun `a lost or broken answer is unknown while a stated wait is a retry`() {
        // 5xx and 408: the server may have committed before it broke.
        for (status in (500..599) + listOf(408)) {
            val decision = Outcome.classify(AttemptResult.Answered(status, null, null, null), op, 1)
            assertTrue(decision is Decision.ResolveByReplay, "status $status gave $decision")
        }
        // 423 and 429: the server declined to act, so nothing was applied.
        for (status in listOf(423, 429)) {
            val decision = Outcome.classify(AttemptResult.Answered(status, null, null, null), op, 1)
            assertTrue(decision is Decision.Retry, "status $status gave $decision")
        }
    }

    @Test
    fun `Retry-After is honoured when sane and ignored when it is not`() {
        fun delayFor(ra: Long?): Long {
            val d = Outcome.classify(AttemptResult.Answered(429, null, null, ra), op, 1)
            assertTrue(d is Decision.Retry)
            return d.afterMs
        }
        assertEquals(30_000, delayFor(30))
        assertEquals(3_600_000, delayFor(3_600))
        // A zero wait is still a wait: it is floored, never turned into a hot loop.
        assertEquals(Backoff.FLOOR_MS, delayFor(0))
        // Out of range values fall back to the derived schedule rather than
        // being trusted; a day-long wait from a misconfigured proxy would
        // strand a sale, and a negative one would be a busy loop.
        val derived = Backoff.delayMs(op, 2)
        assertEquals(derived, delayFor(-5))
        assertEquals(derived, delayFor(3_601))
        assertEquals(derived, delayFor(86_400))
        assertEquals(derived, delayFor(null))
    }

    @Test
    fun `a status nobody anticipated lands on the safe side`() {
        for (status in (0..99) + (100..199) + (300..399) + (600..699)) {
            val decision = Outcome.classify(AttemptResult.Answered(status, null, null, null), op, 1)
            assertTrue(
                decision is Decision.ResolveByReplay,
                "status $status gave $decision — an unrecognised status is not evidence of a commit " +
                    "and not evidence against one",
            )
        }
    }

    @Test
    fun `an attempt is counted from one`() {
        for (bad in listOf(0, -1, -100)) {
            assertFailsWith<IllegalArgumentException> { Outcome.classify(AttemptResult.NoAnswer, op, bad) }
        }
    }
}
