package app.daftar.offline

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * CARD P7-LINK-01B -- the write points that take no lock, and the attempt the
 * counter loses because of it.
 *
 * Why this suite exists, and why it is RED first. `EncryptedQueueStore` holds
 * exactly one lock: `synchronized(WRITE_GATE)` in `captureWithKey`. Measured,
 * not assumed -- `WRITE_GATE` appears on three lines of `Persistence.kt`, one
 * declaration and one use, and the third is the comment saying so. Five other
 * functions write: `markReleased`, `recordSendAttempt`, `recordOutcome`,
 * `recordProcessDeath` and `purge`. Each of them is a read-modify-write across
 * a transaction whose isolation `Transactional` never promised.
 *
 * `recordSendAttempt` is where that costs a number the device acts on:
 *
 *     val current = readUnderTransaction(idempotencyKey)
 *     val next = current.copy(state = IN_FLIGHT, attempts = current.attempts + 1)
 *     db.write(next)
 *
 * Two callers can both read `attempts = n` and both write `n + 1`. One attempt
 * disappears from the very counter the backoff table reads, so a row that has
 * been sent twice looks like a row that has been sent once, and the next delay
 * is drawn from the wrong rung. That is not a lost log line; it is a send the
 * schedule does not know happened.
 *
 * WHAT THIS SUITE ASSERTS: two recorded attempts leave `attempts == 2`, and
 * both writes reach the engine. Today the second write overwrites the first
 * with the same value and the counter ends at 1: that is the red.
 *
 * WHY THE LAW IS STATED ON THE OUTCOME AND NOT ON THE OVERLAP. A rendezvous
 * that forces the interleave would, once the fix serialises these callers,
 * never complete -- the second thread cannot reach the read until the first has
 * finished -- and a suite whose control cannot be met by correct code is a trap
 * rather than a test. So the engine's read waits only briefly for a partner and
 * then proceeds, and the assertion is about the counter. The second case is the
 * control that keeps that honest: it proves this harness really does interleave
 * an unguarded read-modify-write, so a green first case means the kernel
 * serialised the callers and not that the threads politely took turns
 * (RULE-3, RULE-27).
 */
class UnserialisedWritePointsTest {

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray): ByteArray = plaintext.copyOf()
        override fun open(sealed: ByteArray): ByteArray = sealed.copyOf()
    }

    /**
     * An engine that keeps the kernel's contract and nothing more, and that
     * gives a second caller the chance to arrive while the first holds a read's
     * answer. It replaces on a second write under one key, mirroring
     * `SupportSQLiteDatabase`, so a lost update shows up as a counter that did
     * not advance rather than as an engine error.
     *
     * The wait is BOUNDED on purpose: serialised callers never meet, and they
     * must not hang. See the note on this class's suite.
     */
    private class RendezvousDisk : Transactional {
        private val rows = LinkedHashMap<String, StoredRow>()
        // NOT armed by construction. The setup calls (`captureWithKey`, `markReleased`)
        // read through this engine too, and a latch armed at construction was spent by
        // them before the two threads started -- so the rendezvous forced nothing and
        // the first case passed on a kernel that loses the update. Measured on the
        // runner (run 43133015653: 155 executed, only card 2's red failed), not argued.
        // It is armed explicitly, AFTER the setup, and the case checks it is armed.
        @Volatile private var meeting = CountDownLatch(0)

        fun arm(partners: Int) {
            meeting = CountDownLatch(partners)
        }

        /** Partners still awaited at the rendezvous: 0 means the rendezvous forces nothing. */
        fun pendingPartners(): Long = meeting.count

        val writes = AtomicInteger(0)
        val metAPartner = AtomicInteger(0)

        @Synchronized
        private fun put(row: StoredRow) {
            rows[row.idempotencyKey] = row
        }

        @Synchronized
        private fun get(key: String): StoredRow? = rows[key]

        override fun begin() = Unit
        override fun markSuccessful() = Unit
        override fun end() = Unit

        override fun write(row: StoredRow) {
            writes.incrementAndGet()
            put(row)
        }

        override fun delete(key: String) {
            rows.remove(key)
        }

        override fun read(key: String): StoredRow? {
            val seen = get(key)
            meeting.countDown()
            // Bounded: if the caller holding this read is alone because the
            // kernel serialised the other one, we proceed after the wait
            // instead of deadlocking.
            if (meeting.await(2, TimeUnit.SECONDS)) metAPartner.incrementAndGet()
            return seen
        }

        override fun keysByState(state: OperationState): List<String> =
            rows.values.filter { it.state == state }.map { it.idempotencyKey }

        fun attemptsOf(key: String): Int = get(key)?.attempts ?: -1
    }

    @Test
    fun two_recorded_send_attempts_leave_two_attempts_on_the_row() {
        val key = "77777777-7777-4777-8777-777777777777"
        val disk = RendezvousDisk()
        val store = EncryptedQueueStore(disk, Marker())

        val payload = """{"qty":"3"}""".toByteArray()
        store.captureWithKey(key, payload, QueueDigest.of(payload))
        store.markReleased(key)
        assertEquals(
            0,
            disk.attemptsOf(key),
            "the fixture must start from a row with no attempts, or this measures nothing",
        )

        // ARM the rendezvous now that the setup has finished with the engine, and PROVE it
        // is armed: a harness whose latch is already open forces no overlap, and a green
        // below would then say nothing about the kernel (RULE-27).
        disk.arm(partners = 2)
        assertEquals(
            2L,
            disk.pendingPartners(),
            "the rendezvous is not armed with two partners, so the two reads below are not " +
                "forced to overlap and this case would pass on a kernel that loses the update",
        )

        val failures = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
        val threads = (1..2).map {
            Thread {
                try {
                    store.recordSendAttempt(key)
                } catch (thrown: Throwable) {
                    failures.add(thrown)
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join(30_000) }

        assertEquals(
            emptyList(),
            failures.toList(),
            "recording a send attempt threw, so the counter was never the subject",
        )
        assertEquals(
            2,
            disk.attemptsOf(key),
            "two sends were recorded and the row says it was tried " +
                "${disk.attemptsOf(key)} time(s). An attempt was lost: these callers read, " +
                "modify and write with no lock, and the backoff table reads the counter they " +
                "lost it from",
        )
    }

    @Test
    fun the_harness_can_actually_lose_an_update_so_a_green_above_means_the_kernel_serialised() {
        // THE CONTROL (RULE-27). Nothing of the kernel here: a counter whose
        // read-modify-write is deliberately unguarded, run through the same
        // rendezvous. If this does NOT lose an update, then the rendezvous is
        // not interleaving anything and the case above would pass for a kernel
        // that is still broken.
        val meeting = CountDownLatch(2)
        var counter = 0
        val threads = (1..2).map {
            Thread {
                val seen = counter
                meeting.countDown()
                meeting.await(2, TimeUnit.SECONDS)
                counter = seen + 1
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join(30_000) }

        assertTrue(
            counter == 1,
            "the control did not lose an update (counter = $counter), so this harness does not " +
                "interleave an unguarded read-modify-write and proves nothing about the kernel",
        )
    }
}
