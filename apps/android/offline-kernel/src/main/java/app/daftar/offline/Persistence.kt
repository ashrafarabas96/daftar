package app.daftar.offline

/**
 * P7-02 — the encrypted store under the queue, and the places it writes.
 *
 * The kernel in `Queue.kt` is a pure reducer: it decides what an operation
 * becomes, and persists nothing. Every mention of `transaction`, `commit` or
 * `atomic` in it is law text or a comment — measured, not assumed:
 * `grep -nE "atomic|commit|fsync|transaction" Queue.kt` finds only prose. So
 * the durability the laws demand does not exist until this file provides it,
 * and `Queue.kt` is deliberately not the place to look for the write points.
 *
 * TWO LAWS DECIDE THE SHAPE HERE.
 *
 * L2 (`Laws.kt`): "An operation mints exactly one idempotency key, in the same
 * local transaction that persists its payload, before its first attempt". So
 * minting and persisting cannot be two writes. If a key can exist without its
 * payload, or a payload without its key, a crash between them sells something
 * twice or loses it, and no later repair can tell which.
 *
 * L13 (`Laws.kt`): "A persisted queue row carries the schema version it was
 * written under, and a build that does not understand that version refuses the
 * row and leaves it on disk rather than reinterpreting its fields under the
 * current meanings." So every row carries [SCHEMA_VERSION], and a row from a
 * version this build does not know is REFUSED — an exception, not a delete and
 * not a migration in place.
 *
 * WHAT IS ENCRYPTED, AND WHAT IS NOT. The payload — the money, the quantities,
 * the customer — goes through [PayloadCipher] and is never handed to the
 * database in the clear. The queryable metadata (the idempotency key, the
 * state, the attempt count, the schema version) stays readable, because the
 * queue is rows that get selected by state and by key, and a column that must
 * be decrypted to be compared cannot be indexed. That is a real tradeoff, and
 * it is stated rather than hidden: an attacker holding the database file learns
 * HOW MANY operations are pending and in which state, and learns nothing about
 * what any of them says. Encrypting the whole file instead — SQLCipher — is
 * owner decision OD-P7-01, still open. This file does not pre-empt it: the
 * cipher is one seam, and moving to a whole-file cipher replaces how
 * [EncryptedQueueStore] is constructed and nothing else.
 */

/** The schema version every row written by this build carries (L13). */
const val SCHEMA_VERSION: Int = 1

/**
 * Sealing for payload bytes. An implementation must be AUTHENTICATED: a cipher
 * without integrity lets a tampered payload decrypt to something, and a queue
 * row that silently changes meaning is worse than one that refuses.
 *
 * The production implementation is AES-GCM under a key held in the Android
 * Keystore, which cannot be exercised by a JVM unit test — there is no Keystore
 * off-device — so it is injected rather than constructed here, and the suites
 * drive a deterministic double. That boundary is why this is an interface.
 */
interface PayloadCipher {
    fun seal(plaintext: ByteArray): ByteArray

    /** @throws PayloadRefused if the bytes do not authenticate. */
    fun open(sealed: ByteArray): ByteArray
}

/** A row that cannot be trusted is refused, never guessed at. */
class PayloadRefused(message: String) : Exception(message)

/** A row written under a schema version this build does not understand (L13). */
class SchemaVersionRefused(val found: Int, val understood: Int) : Exception(
    "row written under schema $found; this build understands $understood, " +
        "so the row is refused and left on disk",
)

/**
 * The transaction primitive, narrowed to the calls that decide durability. It
 * mirrors `SupportSQLiteDatabase` so the Android implementation is a
 * pass-through, and it is an interface for one reason: a crash test has to kill
 * the process BETWEEN the write and the commit, and nothing can do that to a
 * real SQLite handle from a unit test.
 *
 * The contract is SQLite's own, and it is what the crash tests rely on: work
 * done after [begin] is durable only if [markSuccessful] ran before [end]. An
 * [end] without a [markSuccessful] rolls back.
 */
interface Transactional {
    fun begin()
    fun markSuccessful()
    fun end()
    fun write(row: StoredRow)
    fun delete(key: String)
    fun read(key: String): StoredRow?
    fun keysByState(state: OperationState): List<String>
}

/**
 * A row as it sits on disk: metadata in the clear so it can be queried, the
 * payload sealed.
 */
data class StoredRow(
    val idempotencyKey: String,
    val schemaVersion: Int,
    val state: OperationState,
    val attempts: Int,
    val payloadDigest: String,
    val sealedPayload: ByteArray,
) {
    // `ByteArray` compares by reference, which would make two rows holding the
    // same bytes unequal and quietly break every assertion that compares rows.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is StoredRow) return false
        return idempotencyKey == other.idempotencyKey &&
            schemaVersion == other.schemaVersion &&
            state == other.state &&
            attempts == other.attempts &&
            payloadDigest == other.payloadDigest &&
            sealedPayload.contentEquals(other.sealedPayload)
    }

    override fun hashCode(): Int {
        var result = idempotencyKey.hashCode()
        result = 31 * result + schemaVersion
        result = 31 * result + state.hashCode()
        result = 31 * result + attempts
        result = 31 * result + payloadDigest.hashCode()
        result = 31 * result + sealedPayload.contentHashCode()
        return result
    }
}

/**
 * THE DECLARED LIST OF ATOMIC WRITE POINTS.
 *
 * Every function of [EncryptedQueueStore] that opens a transaction is named
 * here, and nothing else is. The declaration is load-bearing twice over:
 *
 *   * `tests-unit/p7-02-atomic-write-points.test.ts` asserts this list EQUALS
 *     the set of functions in this file that actually call `db.begin()` —
 *     equality, in both directions, not containment. A write point added
 *     without being declared fails it, and so does a name declared here that
 *     no longer opens a transaction. Containment would have let the second kind
 *     rot silently, which is the shape this programme keeps finding.
 *
 *   * [PersistenceCrashSafetyTest] iterates THIS LIST to decide what to kill.
 *     So an undeclared write point is also untested-by-name, and the suite says
 *     which name it could not kill.
 *
 * Each write point below therefore opens its OWN transaction inline. Factoring
 * the read-modify-write shape into one private helper would read better and
 * would break the guard: the four callers would contain no `begin()`, the
 * static set would be `{captureWithKey, purge, <helper>}`, and equality against
 * this list would have to be weakened to containment or to a call-graph walk.
 * The repetition is the price of the check being exact, and it is paid
 * deliberately.
 */
val ATOMIC_WRITE_POINTS: List<String> = listOf(
    "captureWithKey",
    "markReleased",
    "recordSendAttempt",
    "recordOutcome",
    "recordProcessDeath",
    "purge",
)

/**
 * The store. Each function named in [ATOMIC_WRITE_POINTS] is exactly one
 * transaction: it opens it, writes, marks it successful, and ends it — with the
 * mark LAST before the end, so that a death anywhere earlier rolls the whole
 * thing back.
 *
 * The ordering is the entire point. `markSuccessful()` moved ahead of the write
 * — which is what the negative control in the crash suite does — leaves a
 * transaction that commits whatever happened to land, and the suite that passes
 * against this file must fail against that one.
 */
class EncryptedQueueStore(
    private val db: Transactional,
    private val cipher: PayloadCipher,
) {
    /**
     * L2's write, and the reason this class exists. The key and the payload
     * land in ONE transaction. There is deliberately no `mintKey` and no
     * `persistPayload` to call separately: the only way to get a key onto disk
     * is to bring its payload with it.
     */
    fun captureWithKey(
        idempotencyKey: String,
        payload: ByteArray,
        payloadDigest: String,
    ): StoredRow {
        // Sealing happens BEFORE the transaction opens. A cipher that throws
        // would otherwise do so with a transaction held open, and the row would
        // be rolled back by the `finally` — correct, but it would also mean the
        // most likely failure in this function is the one the crash tests
        // cannot distinguish from a kill.
        val sealed = cipher.seal(payload)
        val row = StoredRow(
            idempotencyKey = idempotencyKey,
            schemaVersion = SCHEMA_VERSION,
            state = OperationState.CAPTURED,
            attempts = 0,
            payloadDigest = payloadDigest,
            sealedPayload = sealed,
        )
        db.begin()
        try {
            db.write(row)
            db.markSuccessful()
        } finally {
            db.end()
        }
        return row
    }

    /** Released by the merchant for sending: CAPTURED becomes QUEUED. */
    fun markReleased(idempotencyKey: String): StoredRow {
        db.begin()
        try {
            val current = readUnderTransaction(idempotencyKey)
            val next = current.copy(state = OperationState.QUEUED)
            db.write(next)
            db.markSuccessful()
            return next
        } finally {
            db.end()
        }
    }

    /**
     * The attempt counter advances in the SAME transaction that moves the row
     * to IN_FLIGHT. A counter that can advance without the state moving is a
     * retry the backoff schedule cannot account for.
     */
    fun recordSendAttempt(idempotencyKey: String): StoredRow {
        db.begin()
        try {
            val current = readUnderTransaction(idempotencyKey)
            val next = current.copy(
                state = OperationState.IN_FLIGHT,
                attempts = current.attempts + 1,
            )
            db.write(next)
            db.markSuccessful()
            return next
        } finally {
            db.end()
        }
    }

    /** The server's truth, once there is one: SYNCED or NEEDS_ATTENTION. */
    fun recordOutcome(idempotencyKey: String, state: OperationState): StoredRow {
        db.begin()
        try {
            val current = readUnderTransaction(idempotencyKey)
            val next = current.copy(state = state)
            db.write(next)
            db.markSuccessful()
            return next
        } finally {
            db.end()
        }
    }

    /**
     * A process that dies in flight leaves an operation whose outcome the
     * device cannot know (L1, and `Outcome.kt`). Writing UNKNOWN_OUTCOME is
     * itself a write that can be interrupted, so it is a transaction like any
     * other — which is exactly why it is in the declared list.
     */
    fun recordProcessDeath(idempotencyKey: String): StoredRow {
        db.begin()
        try {
            val current = readUnderTransaction(idempotencyKey)
            val next = current.copy(state = OperationState.UNKNOWN_OUTCOME)
            db.write(next)
            db.markSuccessful()
            return next
        } finally {
            db.end()
        }
    }

    /** Retention: a terminal row leaves disk, and that removal is atomic too. */
    fun purge(idempotencyKey: String) {
        db.begin()
        try {
            db.delete(idempotencyKey)
            db.markSuccessful()
        } finally {
            db.end()
        }
    }

    /**
     * Reading is not a write point and is not declared as one. It refuses a row
     * from an unknown schema version rather than reinterpreting its fields
     * (L13), and leaves it on disk: the refusal is an exception, not a delete.
     */
    fun load(idempotencyKey: String): Pair<StoredRow, ByteArray>? {
        val row = db.read(idempotencyKey) ?: return null
        if (row.schemaVersion != SCHEMA_VERSION) {
            throw SchemaVersionRefused(row.schemaVersion, SCHEMA_VERSION)
        }
        return row to cipher.open(row.sealedPayload)
    }

    fun keysByState(state: OperationState): List<String> = db.keysByState(state)

    /**
     * Read the row a mutation is about to change. It opens no transaction of
     * its own — it is called with one already held — so it is correctly absent
     * from [ATOMIC_WRITE_POINTS], and the static guard confirms that by
     * deriving its set from `db.begin()` and finding this name nowhere.
     */
    private fun readUnderTransaction(idempotencyKey: String): StoredRow {
        val current = db.read(idempotencyKey)
            ?: throw PayloadRefused("no row for $idempotencyKey; refusing to invent one")
        if (current.schemaVersion != SCHEMA_VERSION) {
            throw SchemaVersionRefused(current.schemaVersion, SCHEMA_VERSION)
        }
        return current
    }
}
