package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class BackoffTest {
    private fun id(n: Int) = "op-%08d-aaaa-4bbb-8ccc-dddddddddddd".format(n)

    @Test
    fun `the schedule survives process death because it is derived, not drawn`() {
        // The same question asked twice, as a restarted process would ask it,
        // gets the same answer. Nothing is persisted and nothing is seeded, so
        // a crash loop cannot walk an operation back to its first short delay.
        for (attempt in 2..30) {
            val first = Backoff.delayMs(id(7), attempt)
            val second = Backoff.delayMs(id(7), attempt)
            assertEquals(first, second, "attempt $attempt was not reproducible")
        }
    }

    @Test
    fun `every delay stays inside the floor and the cap`() {
        for (n in 0 until 200) {
            for (attempt in 2..60) {
                val d = Backoff.delayMs(id(n), attempt)
                assertTrue(
                    d in Backoff.FLOOR_MS..Backoff.CAP_MS,
                    "op $n attempt $attempt gave ${d}ms, outside ${Backoff.FLOOR_MS}..${Backoff.CAP_MS}",
                )
            }
        }
    }

    @Test
    fun `the ceiling doubles and then stops at the cap`() {
        // Asserted on the CEILING rather than on a single operation's sampled
        // delay: with full jitter an individual delay may fall anywhere below
        // its ceiling, so "attempt 5 is slower than attempt 4" is false for
        // some operations and asserting it would be a flaky test pinned to one
        // id's luck. The ceiling is the real contract, so the maximum over a
        // population is what rises.
        fun ceilingOver(attempt: Int): Long = (0 until 2_000).maxOf { Backoff.delayMs(id(it), attempt) }
        var previous = 0L
        for (attempt in 2..11) {
            val ceiling = ceilingOver(attempt)
            assertTrue(ceiling > previous, "attempt $attempt ceiling $ceiling did not rise above $previous")
            previous = ceiling
        }
        // Far out, everything is capped and nothing exceeds it.
        for (attempt in 30..60) {
            assertTrue(ceilingOver(attempt) <= Backoff.CAP_MS)
        }
        assertTrue(ceilingOver(40) > Backoff.CAP_MS / 2, "the cap should actually be approached")
    }

    @Test
    fun `a thousand operations that failed together do not resend together`() {
        // The outage shape this exists for: connectivity drops, every queued
        // operation fails at the same instant, connectivity returns. If the
        // delay were a function of the attempt alone, all of them would resend
        // in one burst and knock the server over as it recovers.
        val delays = (0 until 1_000).map { Backoff.delayMs(id(it), 6) }
        val distinct = delays.distinct().size
        assertTrue(distinct > 900, "only $distinct distinct delays over 1000 operations — this is a herd")

        // And the spread really covers the window, rather than clustering.
        val ceiling = Backoff.BASE_MS shl 4
        val buckets = delays.map { (it * 10 / ceiling).coerceAtMost(9) }.distinct().size
        assertTrue(buckets >= 9, "the delays only reached $buckets of 10 buckets below the ceiling")
    }

    @Test
    fun `one changed character redistributes the delay`() {
        val a = Backoff.delayMs("operation-aaaa-4bbb-8ccc-dddddddddddd", 8)
        val b = Backoff.delayMs("operation-aaab-4bbb-8ccc-dddddddddddd", 8)
        assertTrue(a != b, "two near-identical ids share a delay of ${a}ms")
    }

    @Test
    fun `there is no delay before the first attempt`() {
        for (bad in listOf(1, 0, -1)) {
            assertFailsWith<IllegalArgumentException> { Backoff.delayMs(id(1), bad) }
        }
    }
}
