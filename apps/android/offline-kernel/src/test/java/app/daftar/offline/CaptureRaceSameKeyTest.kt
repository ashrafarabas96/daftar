package app.daftar.offline

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * CARD P7-LINK-01 -- two surfaces capture THE SAME idempotency key at the same
 * moment.
 *
 * Why this suite exists, and why it is RED first. `EncryptedQueueStore
 * .captureWithKey` refuses a second capture under a key that is already on
 * disk, and its own comment states where that refusal gets its force:
 *
 *   "The read is INSIDE the transaction on purpose: outside it, two captures
 *    racing on one key could both find nothing and both write."
 *
 * So the refusal is only as strong as the ISOLATION of the transaction it runs
 * in. The kernel holds no lock of its own: nothing in `EncryptedQueueStore`
 * serialises two callers, and `Transactional` promises `begin` / `end` without
 * promising a level. On a deferred SQLite transaction -- which is what
 * `beginTransaction` gives, and what any implementation written to that
 * interface may give -- both readers see no row, and the second `write`
 * replaces the first, because the interface's own comment says its row write
 * "replaces on conflict".
 *
 * The defect is therefore NOT that the refusal is missing. It is that the
 * refusal depends on a property no caller can see and no type can state, and
 * the kernel accepts an engine that does not have it.
 *
 * WHAT THIS SUITE ASSERTS: with an engine whose transaction does not isolate
 * (the realistic case, not a pathological one), exactly ONE capture may win
 * and exactly ONE row may exist. Today both win: that is the red.
 *
 * POSITIVE CONTROL, which the card requires: a run where the two threads did
 * not actually overlap proves nothing about a race, so the overlap is measured
 * and a non-overlapping run FAILS instead of passing quietly (RULE-3, RULE-27).
 */
class CaptureRaceSameKeyTest {

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray): ByteArray = plaintext.copyOf()
        override fun open(sealed: ByteArray): ByteArray = sealed.copyOf()
    }

    /**
     * An engine that keeps the kernel's contract and nothing more: it begins,
     * it writes, it ends, and its transaction does NOT isolate a read from a
     * concurrent write -- which is all `Transactional` ever promised. It also
     * REPLACES on a second write under one key, mirroring
     * `SupportSQLiteDatabase`, so a lost capture shows up as a replaced row
     * rather than as an engine error.
     *
     * It records what the kernel did, not what this suite hoped: how many
     * reads saw the key absent, and how many writes reached the engine.
     */
    private class RacyDisk : Transactional {
        private val rows = LinkedHashMap<String, StoredRow>()
        val writes = AtomicInteger(0)
        val readsThatSawNothing = AtomicInteger(0)

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
            if (seen == null) readsThatSawNothing.incrementAndGet()
            // A pause with the read's answer already in hand. On an engine that
            // does not isolate, this is the window in which the other caller
            // reads the same absence -- so if anything but the kernel's own
            // mutual exclusion were holding the law up, this is where it would
            // fail.
            Thread.sleep(25)
            return seen
        }

        override fun keysByState(state: OperationState): List<String> =
            rows.values.filter { it.state == state }.map { it.idempotencyKey }

        fun rowCount(): Int = rows.size
    }

    @Test
    fun two_captures_of_one_key_leave_one_row_and_one_refusal() {
        val key = "11111111-1111-4111-8111-111111111111"
        val disk = RacyDisk()
        val store = EncryptedQueueStore(disk, Marker())

        val firstPayload = """{"qty":"1"}""".toByteArray()
        val secondPayload = """{"qty":"9"}""".toByteArray()

        // THE CONTROL, and it is a rendezvous rather than a hope: neither
        // thread calls the store until both have arrived, so the two captures
        // are in flight at the same instant. A run where one finished before
        // the other started would prove nothing about a race, and this latch is
        // what makes that case fail instead of pass (RULE-27).
        val startGate = CountDownLatch(2)
        val bothStarted = AtomicReference(false)

        val refusals = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
        val accepted = AtomicInteger(0)

        val threads = listOf(firstPayload, secondPayload).map { payload ->
            Thread {
                startGate.countDown()
                if (startGate.await(5, TimeUnit.SECONDS)) bothStarted.set(true)
                try {
                    store.captureWithKey(key, payload, QueueDigest.of(payload))
                    accepted.incrementAndGet()
                } catch (refused: PayloadRefused) {
                    refusals.add(refused)
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join(30_000) }

        assertTrue(
            bothStarted.get(),
            "the two captures were not in flight together, so this run measured nothing " +
                "about a race",
        )

        assertEquals(
            1,
            accepted.get(),
            "both captures were accepted under one key: the refusal is resting on an isolation " +
                "level the kernel neither requires of Transactional nor provides itself",
        )
        assertEquals(
            1,
            refusals.size,
            "exactly one of the two captures must be refused as a frozen key",
        )
        assertEquals(
            1,
            disk.rowCount(),
            "one key must leave one row; a second write under the same key replaces a frozen payload",
        )
        assertEquals(
            1,
            disk.writes.get(),
            "the losing capture must not reach the engine's write at all",
        )
        assertEquals(
            1,
            disk.readsThatSawNothing.get(),
            "only the FIRST capture may see the key absent; a second read that also saw nothing " +
                "means the two read-modify-writes interleaved",
        )
    }

    @Test
    fun the_kernel_states_the_isolation_its_refusal_depends_on() {
        // The law above cannot be met by the store alone: it needs the engine
        // to serialise read-then-write under one key. A kernel that depends on
        // that property must SAY so where an implementor reads it -- either as
        // a documented requirement on `Transactional`, or by holding its own
        // lock. Neither exists today, which is why two engines can both be
        // "correct" and still lose a capture.
        // Same convention as the kernel's other source-sweeping suites: the
        // root comes from `p7.src`, and a subject that cannot be read FAILS --
        // an empty read is never a quiet pass (RULE-18).
        val root = java.io.File(System.getProperty("p7.src") ?: "prep/phase7/kotlin/src")
        val file = java.io.File(root, "app/daftar/offline/Persistence.kt")
        if (!file.isFile) {
            fail("the subject was not readable, so this check measured nothing: ${file.absolutePath}")
        }
        val persistence = file.readText()
        assertTrue(persistence.length > 1_000, "the subject read back empty or truncated")
        val mentionsSerialisation = listOf(
            "SERIALIZABLE",
            "serializable",
            "beginTransactionNonExclusive",
            "exclusive",
            "synchronized",
            "ReentrantLock",
            "withLock",
        ).any { persistence.contains(it) }
        if (!mentionsSerialisation) {
            fail(
                "Persistence.kt makes a frozen key depend on the transaction isolating a read " +
                    "from a concurrent write, and states no such requirement on Transactional " +
                    "and takes no lock of its own",
            )
        }
    }
}
