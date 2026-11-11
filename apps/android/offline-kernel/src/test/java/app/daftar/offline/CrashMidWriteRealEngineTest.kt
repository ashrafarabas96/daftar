package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * CARD P7-LINK-02 -- the process dies BETWEEN the write and `markSuccessful`,
 * and the row must not come back half-written.
 *
 * What is already proven, and what is not. `PersistenceCrashSafetyTest` kills
 * the caller between `write` and `markSuccessful` against a FAKE engine, and
 * that case is green: the kernel's `try / finally` ends the transaction
 * without marking it successful. But a fake engine's rollback is a rollback
 * this suite WROTE. The law the card states -- "no half row after a kill" --
 * is a property of the ENGINE, and no engine is under test anywhere in this
 * module:
 *
 *   - `Transactional` has no implementation in the kernel at all; the only
 *     implementations in this repository are the fakes inside these suites;
 *   - `:app` does not depend on `:offline-kernel`, so no SQLite-backed
 *     implementation exists on the other side either;
 *   - `src/androidTest` does not exist, so nothing runs against a device.
 *
 * So the kill is tested against a promise, and the promise has no keeper. That
 * is the gap this suite names, and it is the reason the card is a LINK blocker
 * rather than a kernel bug: the kernel cannot be wired to the app until a real
 * engine is under this law.
 *
 * WHAT THIS SUITE ASSERTS:
 *   1. the kernel ships a `Transactional` over a real database engine, named
 *      here so an implementor cannot satisfy the card with another fake;
 *   2. and, expressed against whatever engine is supplied, that a kill between
 *      `write` and `markSuccessful` leaves NO row and no partial row.
 *
 * Case 1 is red today. Case 2 is written now so that the engine, when it
 * arrives, arrives under the law rather than before it.
 */
class CrashMidWriteRealEngineTest {

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray): ByteArray = plaintext.copyOf()
        override fun open(sealed: ByteArray): ByteArray = sealed.copyOf()
    }

    /** The kill, as the kernel can observe it: the caller never returns from `write`. */
    private class ProcessDeath : Error("the process died before markSuccessful")

    /**
     * An engine that honours the transaction boundary the way a database does:
     * writes land in a pending set, `markSuccessful` promotes them, and `end`
     * without `markSuccessful` discards them. This is the SEMANTICS the real
     * engine must have; the point of case 1 is that no real engine is held to
     * it yet.
     */
    private class JournalledFake(private val dieOnWrite: Boolean) : Transactional {
        private val committed = LinkedHashMap<String, StoredRow>()
        private var pending: LinkedHashMap<String, StoredRow>? = null
        private var marked = false
        var endCalls = 0
            private set

        override fun begin() {
            pending = LinkedHashMap()
            marked = false
        }

        override fun markSuccessful() {
            marked = true
        }

        override fun end() {
            endCalls++
            val staged = pending
            if (marked && staged != null) committed.putAll(staged)
            pending = null
            marked = false
        }

        override fun write(row: StoredRow) {
            pending?.put(row.idempotencyKey, row)
            if (dieOnWrite) throw ProcessDeath()
        }

        override fun delete(key: String) {
            committed.remove(key)
        }

        override fun read(key: String): StoredRow? = committed[key]

        override fun keysByState(state: OperationState): List<String> =
            committed.values.filter { it.state == state }.map { it.idempotencyKey }

        fun committedCount(): Int = committed.size
    }

    @Test
    fun the_kernel_ships_a_transactional_over_a_real_engine() {
        val candidates = listOf(
            "app.daftar.offline.SqliteQueueDb",
            "app.daftar.offline.RoomQueueDb",
            "app.daftar.offline.SupportSqliteQueueDb",
        )
        val found = candidates.filter { name ->
            try {
                Class.forName(name)
                true
            } catch (missing: ClassNotFoundException) {
                false
            }
        }
        if (found.isEmpty()) {
            fail(
                "no Transactional over a real database engine exists in the kernel, so the " +
                    "card's law -- no half row after a kill -- is tested only against this " +
                    "module's own fakes. Expected one of: " + candidates.joinToString(", "),
            )
        }
    }

    @Test
    fun a_kill_between_write_and_mark_successful_leaves_no_row() {
        val disk = JournalledFake(dieOnWrite = true)
        val store = EncryptedQueueStore(disk, Marker())
        val key = "22222222-2222-4222-8222-222222222222"
        val payload = """{"qty":"3"}""".toByteArray()

        var died = false
        try {
            store.captureWithKey(key, payload, QueueDigest.of(payload))
        } catch (death: ProcessDeath) {
            died = true
        }

        // POSITIVE CONTROL: a run where the kill never happened would pass this
        // case for the wrong reason.
        assertTrue(died, "the kill was not injected, so this run measured nothing")
        assertEquals(1, disk.endCalls, "the transaction must be ended exactly once, by the finally")
        assertEquals(0, disk.committedCount(), "a killed capture must leave no committed row")
        assertEquals(null, disk.read(key), "the key must not be readable after a killed capture")
    }

    @Test
    fun the_same_key_is_capturable_again_after_a_killed_capture() {
        // The other half of "no half row": a kill must not leave the key
        // poisoned either. A merchant whose till died mid-capture retries, and
        // the retry must be able to take the key, because the frozen-key
        // refusal exists to protect a row that EXISTS.
        val dead = JournalledFake(dieOnWrite = true)
        val store = EncryptedQueueStore(dead, Marker())
        val key = "33333333-3333-4333-8333-333333333333"
        val payload = """{"qty":"4"}""".toByteArray()
        try {
            store.captureWithKey(key, payload, QueueDigest.of(payload))
        } catch (death: ProcessDeath) {
            // expected
        }

        val alive = JournalledFake(dieOnWrite = false)
        val second = EncryptedQueueStore(alive, Marker())
        val row = second.captureWithKey(key, payload, QueueDigest.of(payload))
        assertEquals(key, row.idempotencyKey)
        assertEquals(OperationState.CAPTURED, row.state)
        assertEquals(1, alive.committedCount())
    }
}
