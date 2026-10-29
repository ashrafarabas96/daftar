package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * P7-02 — the process is killed between `write` and `commit` at EVERY atomic
 * write point, and a store that is not atomic fails the same suite.
 *
 * The coverage is structural, not a list someone must remember to extend: the
 * cases below iterate [ATOMIC_WRITE_POINTS] and look each name up in
 * [drivers]. A write point added to the declaration with no driver here fails
 * `the declared list is not empty, and every name in it has a driver` BY NAME,
 * and the static guard `tests-unit/p7-02-atomic-write-points.test.ts`
 * separately refuses a write point added to the code without being declared at
 * all. The two together close both directions; neither closes both alone.
 *
 * WHERE THE KILL LANDS, AND WHY THAT TOOK TWO ATTEMPTS. The first version of
 * this suite armed the kill on the next write and ran the driver. Every driver
 * but one begins by capturing, so the kill always fired on THAT write — and
 * because the label was supplied by the caller rather than read from the
 * failure, the assertion agreed it had fired "at" the point under test. Six
 * cases, one of them real. So the kill is now armed at a COUNTED mutation: a
 * clean run of the same driver on a throwaway store says how many mutations the
 * point performs, and the measured run kills the last one. The earlier steps
 * commit normally, which is what makes the surviving state a clean one rather
 * than an empty one.
 *
 * WHY THE KILL IS A THROWN ERROR AND NOT A REAL `kill -9`. What must be proved
 * is SQLite's rollback contract: work after `begin()` is durable only if
 * `markSuccessful()` ran before `end()`. A real process kill proves the same
 * thing and cannot be observed from inside the process that died, so the death
 * is modelled at the only place where its effect differs from a clean path —
 * between the last mutation and the mark — and the durable map is read
 * afterwards by the surviving test. [ProcessDied] is an `Error`, not an
 * `Exception`, so no `catch (e: Exception)` could swallow it and turn a death
 * into a quiet success.
 *
 * NOT RUN on the host this card was executed on: there is no `java`, no
 * `gradle` and no `kotlinc` there, so these cases were never compiled or
 * executed and nothing here may be read as passing. They run under
 * `./gradlew testDebugUnitTest`, which `ci.yml` already invokes unqualified
 * across every subproject.
 */
class PersistenceCrashSafetyTest {
    private val key = "9f8e7d6c-5b4a-4938-8271-615243f5e6d7"
    private val digest = "sha256:a1b2c3d4"
    private val payload = "12500 SAR".toByteArray()

    /** The modelled process death. An `Error`, so no `catch (Exception)` hides it. */
    private class ProcessDied(val atMutation: Int) : Error("process died at mutation $atMutation")

    /**
     * A deterministic stand-in for the Keystore AES-GCM cipher. It is NOT
     * encryption and does not pretend to be: it is a reversible marker, so that
     * a test asserting "the bytes the database saw are not the payload" asserts
     * something a reader can check by eye. The real cipher needs an Android
     * Keystore, which does not exist in a JVM unit test, and that is why
     * [PayloadCipher] is an interface.
     */
    private class ReversibleMarker : PayloadCipher {
        override fun seal(plaintext: ByteArray) =
            ByteArray(plaintext.size) { (plaintext[it] + 1).toByte() }

        override fun open(sealed: ByteArray) =
            ByteArray(sealed.size) { (sealed[it] - 1).toByte() }
    }

    /**
     * A transaction-honouring store. Mutations inside an open transaction land
     * in [pending] and reach [committed] only if `markSuccessful()` ran before
     * `end()` — SQLite's contract, implemented plainly so the crash cases assert
     * against the behaviour they actually depend on.
     */
    private open class FakeDb : Transactional {
        val committed = linkedMapOf<String, StoredRow>()
        private var pending: LinkedHashMap<String, StoredRow?>? = null
        private var successful = false

        /** Mutations seen so far: writes and deletes alike. */
        var mutations = 0

        /** When set, the mutation with this ordinal throws instead of returning. */
        var killAtMutation: Int? = null

        /**
         * `committed` as it stood when the most recent transaction opened. The
         * assertion every crash case makes is against THIS, not against an
         * empty map: the steps before the interrupted one are supposed to have
         * committed.
         */
        var committedAtLastBegin: Map<String, StoredRow> = emptyMap()
            private set

        override fun begin() {
            check(pending == null) { "nested transaction" }
            committedAtLastBegin = LinkedHashMap(committed)
            pending = linkedMapOf()
            successful = false
        }

        override fun markSuccessful() {
            checkNotNull(pending) { "markSuccessful outside a transaction" }
            successful = true
        }

        override fun end() {
            val staged = checkNotNull(pending) { "end outside a transaction" }
            if (successful) {
                for ((k, v) in staged) if (v == null) committed.remove(k) else committed[k] = v
            }
            pending = null
            successful = false
        }

        override fun write(row: StoredRow) {
            val staged = checkNotNull(pending) { "write outside a transaction" }
            staged[row.idempotencyKey] = row
            countAndMaybeDie()
        }

        override fun delete(key: String) {
            val staged = checkNotNull(pending) { "delete outside a transaction" }
            staged[key] = null
            countAndMaybeDie()
        }

        protected fun countAndMaybeDie() {
            mutations += 1
            if (mutations == killAtMutation) throw ProcessDied(mutations)
        }

        override fun read(key: String): StoredRow? {
            // A staged delete must read as absent. Falling through to
            // `committed` on a null staged value would make a pending deletion
            // invisible, and `purge` would look like it had not happened.
            val staged = pending
            if (staged != null && staged.containsKey(key)) return staged[key]
            return committed[key]
        }

        override fun keysByState(state: OperationState) =
            committed.values.filter { it.state == state }.map { it.idempotencyKey }
    }

    /**
     * THE NEGATIVE CONTROL. Atomicity is defeated in the one way that matters:
     * a write lands in the durable map immediately instead of being staged, so
     * a death before the mark leaves the half-write behind. Everything else is
     * identical.
     *
     * It is a control that SHIPS WITH the suite rather than a patch applied to
     * the source from outside, and that is deliberate. A planted defect has to
     * be proven to have landed before its result is read and restored
     * byte-identically afterwards; a control carried by the suite is proven to
     * have run by the suite's own verdict, on every machine, every time —
     * including in CI, where nobody is there to apply a plant.
     */
    private class NotAtomic : FakeDb() {
        override fun write(row: StoredRow) {
            committed[row.idempotencyKey] = row
            countAndMaybeDie()
        }
    }

    /**
     * One driver per declared write point: it puts the store into the state
     * that write point starts from, then performs it. The map's keys are checked
     * for EQUALITY against [ATOMIC_WRITE_POINTS], so this map cannot drift from
     * the declaration in either direction.
     */
    private fun drivers(store: EncryptedQueueStore): Map<String, () -> Unit> = mapOf(
        "captureWithKey" to {
            store.captureWithKey(key, payload, digest)
            Unit
        },
        "markReleased" to {
            store.captureWithKey(key, payload, digest)
            store.markReleased(key)
            Unit
        },
        "recordSendAttempt" to {
            store.captureWithKey(key, payload, digest)
            store.markReleased(key)
            store.recordSendAttempt(key)
            Unit
        },
        "recordOutcome" to {
            store.captureWithKey(key, payload, digest)
            store.recordOutcome(key, OperationState.SYNCED)
            Unit
        },
        "recordProcessDeath" to {
            store.captureWithKey(key, payload, digest)
            store.markReleased(key)
            store.recordSendAttempt(key)
            store.recordProcessDeath(key)
            Unit
        },
        "purge" to {
            store.captureWithKey(key, payload, digest)
            store.recordOutcome(key, OperationState.SYNCED)
            store.purge(key)
            Unit
        },
    )

    /** How many mutations a point performs on a clean run. */
    private fun mutationsFor(point: String): Int {
        val db = FakeDb()
        drivers(EncryptedQueueStore(db, ReversibleMarker())).getValue(point)()
        check(db.mutations >= 1) { "$point performed no mutation at all" }
        return db.mutations
    }

    @Test
    fun `the declared list is not empty, and every name in it has a driver`() {
        // A suite that iterated an empty list would kill nothing and go green,
        // so the size is pinned against the declaration's own literal.
        assertEquals(6, ATOMIC_WRITE_POINTS.size, "the declared write points")
        val driven = drivers(EncryptedQueueStore(FakeDb(), ReversibleMarker())).keys
        // Equality, not containment: a driver for a name nobody declares is as
        // much a defect as a declared name nobody drives.
        assertEquals(ATOMIC_WRITE_POINTS.toSet(), driven, "declared write points vs drivers")
    }

    @Test
    fun `a death between the last mutation and the commit leaves nothing behind, at every write point`() {
        for (point in ATOMIC_WRITE_POINTS) {
            val last = mutationsFor(point)
            val db = FakeDb()
            db.killAtMutation = last
            val store = EncryptedQueueStore(db, ReversibleMarker())

            val died = assertFailsWith<ProcessDied>("$point: the kill did not fire") {
                drivers(store).getValue(point)()
            }
            // Read the ordinal from the FAILURE, not from the caller. The first
            // version of this suite took it from the loop variable and so agreed
            // with itself no matter where the death actually happened.
            assertEquals(last, died.atMutation, "$point: the kill fired at the wrong mutation")

            // THE ASSERTION. The durable map is exactly what it was when the
            // interrupted transaction opened.
            assertEquals(
                db.committedAtLastBegin,
                db.committed,
                "$point: an interrupted transaction left state behind",
            )
        }
    }

    /**
     * The same loop against [NotAtomic]. It MUST fail wherever it writes, which
     * is what makes the case above evidence rather than a tautology: a suite
     * that cannot tell an atomic store from a broken one proves nothing about
     * the atomic one.
     */
    @Test
    fun `the non-atomic store fails the very same check`() {
        val survived = mutableListOf<String>()
        for (point in ATOMIC_WRITE_POINTS) {
            val last = mutationsFor(point)
            val db = NotAtomic()
            db.killAtMutation = last
            val store = EncryptedQueueStore(db, ReversibleMarker())
            assertFailsWith<ProcessDied>("$point: the kill did not fire") {
                drivers(store).getValue(point)()
            }
            if (db.committedAtLastBegin == db.committed) survived.add(point)
        }
        // `purge`'s final mutation is a DELETE, and this control only defeats
        // `write`, so that one point is genuinely unaffected by it. Naming it is
        // the point: a control claimed to reach "everything" would be false, and
        // a control whose reach nobody states is a control nobody can check.
        assertEquals(
            listOf("purge"),
            survived,
            "the non-atomic store must lose state at every write point except the delete-only one",
        )
    }

    @Test
    fun `a committed capture is durable, and its payload is readable again`() {
        val db = FakeDb()
        val store = EncryptedQueueStore(db, ReversibleMarker())
        store.captureWithKey(key, payload, digest)
        val (row, opened) = store.load(key) ?: error("the capture did not persist")
        assertEquals(OperationState.CAPTURED, row.state)
        assertEquals(SCHEMA_VERSION, row.schemaVersion)
        assertEquals(payload.toList(), opened.toList())
    }

    @Test
    fun `the database never sees the payload in the clear`() {
        val db = FakeDb()
        val store = EncryptedQueueStore(db, ReversibleMarker())
        store.captureWithKey(key, payload, digest)
        val stored = db.committed.getValue(key).sealedPayload
        assertNotEquals(
            payload.toList(),
            stored.toList(),
            "the payload reached the database unsealed",
        )
        assertEquals(payload.toList(), ReversibleMarker().open(stored).toList())
    }

    @Test
    fun `the key and its payload arrive together or not at all (L2)`() {
        // The one write L2 is about. Killed mid-transaction there must be no row
        // at all — not a key without a payload, and not a payload without a key.
        val db = FakeDb()
        db.killAtMutation = 1
        val store = EncryptedQueueStore(db, ReversibleMarker())
        assertFailsWith<ProcessDied> { store.captureWithKey(key, payload, digest) }
        assertTrue(db.committed.isEmpty(), "a key or a payload survived alone")
        assertNull(store.load(key))
    }

    @Test
    fun `a row from an unknown schema version is refused and left on disk (L13)`() {
        val db = FakeDb()
        val store = EncryptedQueueStore(db, ReversibleMarker())
        store.captureWithKey(key, payload, digest)
        val fromTheFuture = db.committed.getValue(key).copy(schemaVersion = SCHEMA_VERSION + 1)
        db.committed[key] = fromTheFuture

        val refusal = assertFailsWith<SchemaVersionRefused> { store.load(key) }
        assertEquals(SCHEMA_VERSION + 1, refusal.found)
        assertEquals(SCHEMA_VERSION, refusal.understood)
        // Left on disk: the refusal is not a delete.
        assertEquals(
            fromTheFuture,
            db.committed.getValue(key),
            "the refused row was not left alone",
        )
    }

    @Test
    fun `a mutation refuses a row that is not there rather than inventing one`() {
        val store = EncryptedQueueStore(FakeDb(), ReversibleMarker())
        assertFailsWith<PayloadRefused> { store.markReleased("no-such-key") }
    }
}
