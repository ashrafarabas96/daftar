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
 * owner decision OD-P7-01, which the owner deferred to P7-04 on 2026-10-29 —
 * a date, not an open question. This file does not pre-empt it: the
 * cipher is one seam, and moving to a whole-file cipher replaces how
 * [EncryptedQueueStore] is constructed and nothing else.
 */

/** The schema version every row written by this build carries (L13). */
const val SCHEMA_VERSION: Int = 1

/**
 * DR-67 CONDITION 1 — THE OPEN INVENTORY: every column stored OUTSIDE the
 * AES-GCM payload, named, so that deferring OD-P7-01 is a measured acceptance
 * rather than a gap nobody wrote down.
 *
 * These five are in the clear because the queue is rows SELECTED by them: a
 * column that must be decrypted to be compared cannot be indexed. Each is
 * listed with what an attacker holding the database file learns from it:
 *
 *   * `idempotencyKey`   — a client-minted UUID v4. Links a row to a server
 *                          document id. Carries no merchant data and is not
 *                          derived from any: it is random, not a hash of the
 *                          intent, so it cannot be brute-forced back to one.
 *   * `schemaVersion`    — a small integer. Which build wrote the row (L13).
 *   * `state`            — one of seven enum names. WHERE in the lifecycle the
 *                          row is. This is the real residual leak: counts per
 *                          state are visible, so "how many sales are pending"
 *                          is readable. Not WHAT any of them says.
 *   * `attempts`         — a small integer. How many sends were tried.
 *   * `payloadDigest`    — sha256 OF the payload, never the payload. A digest
 *                          is one-way, and it is a LOCAL integrity check on
 *                          this queue: [QueueDigest] computes it over the
 *                          captured bytes, this store refuses a row whose
 *                          digest is not theirs, and a read recomputes it
 *                          before handing the bytes back. It is NEVER compared
 *                          with the server, which computes its own proof of
 *                          intent from the request it received (owner decision
 *                          DR-84, 2026-11-04). It cannot be encrypted for that
 *                          local use: a column that must be decrypted to be
 *                          compared cannot be indexed, and recomputing it on
 *                          every read is what detects a changed byte.
 *                          An earlier version of this line said it was
 *                          "exactly what the server compares". Measured: the
 *                          server accepts no client digest at all, so that
 *                          sentence described a comparison that never happens.
 *
 * WHAT MAY NEVER APPEAR IN ANY OF THEM: a customer name, a phone number, an
 * amount, a note, or any other personal or financial datum. That is not a
 * convention — [CleartextColumnExposureTest] writes all four into a payload
 * and fails if any reaches a cleartext column, and its own leaky control
 * proves the check can fail.
 *
 * `tests-unit/p7-02-cleartext-column-inventory.test.ts` asserts this list
 * EQUALS [StoredRow]'s fields minus `sealedPayload` — so a column added to the
 * row without being inventoried here fails, and so does an entry here that no
 * longer corresponds to a column. Equality, both directions.
 */
val CLEARTEXT_COLUMNS: List<String> = listOf(
    "idempotencyKey",
    "schemaVersion",
    "state",
    "attempts",
    "payloadDigest",
)

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
 *
 * WHAT THIS INTERFACE DOES **NOT** PROMISE, stated because the kernel used to
 * depend on it silently: **no isolation level**. A deferred SQLite transaction
 * — which is what `beginTransaction` gives — lets two callers both read a key
 * as absent and then both write it, and [write] mirrors
 * `SupportSQLiteDatabase`, whose row write REPLACES on conflict. So an
 * implementor owes this interface atomicity and durability, and owes it
 * nothing about concurrency.
 *
 * The frozen-key law therefore cannot rest here, and no longer does:
 * [EncryptedQueueStore] serialises its own read-modify-write instead of asking
 * an engine for a guarantee this contract never required. Card P7-LINK-01, red
 * first: two threads capturing one key were BOTH accepted, with the overlap
 * measured rather than assumed, and the losing one reached the engine's write.
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
        // DR-84: the digest offered must BE the digest of the bytes offered.
        // Before this check the only requirement anywhere was that a digest be
        // non-empty, so `"sha256:a1b2c3d4"` was a legal digest for any payload
        // at all — and a digest that cannot detect a change is not an integrity
        // check, it is a field that looks like one. Enforced here rather than
        // in the state machine because this is the one place the bytes and the
        // digest are both in hand, and because the state machine's file is
        // byte-pinned by the P7-01 promotion proof.
        val offered = QueueDigest.of(payload)
        if (payloadDigest != offered) {
            throw PayloadRefused(
                "the digest offered for $idempotencyKey is not the sha256 of its payload; " +
                    "refusing to store a row whose digest could not detect a changed byte",
            )
        }
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
        // ONE WRITER AT A TIME, and the reason it is here rather than left to
        // the engine. Everything below between `begin()` and `end()` is a
        // read-modify-write whose correctness needs the read and the write to
        // be indivisible, and `Transactional` promises no isolation level at
        // all: on a deferred transaction two callers both read the key as
        // absent, both write, and the second replaces a frozen payload.
        //
        // Card P7-LINK-01, measured before this lock existed: two threads
        // capturing the same key were BOTH accepted and both reached the
        // engine's write, with the overlap proven by a control inside the case
        // rather than hoped for. The refusal below was never wrong; it was
        // resting on a guarantee nobody had made.
        //
        // The gate is process-wide, not per instance: two `EncryptedQueueStore`
        // objects over one database are the same disk, and an instance lock
        // would serialise the wrong thing.
        //
        // AND IT COVERS THIS WRITE POINT ONLY, measured: `WRITE_GATE` appears
        // at one site in this file. `markReleased`, `recordSendAttempt`,
        // `recordOutcome`, `recordProcessDeath` and `purge` do NOT take it, so
        // they are still read-modify-writes resting on an isolation level
        // `Transactional` does not promise -- `recordSendAttempt` most
        // visibly, where two callers can both read `attempts = n` and both
        // write `n + 1`, losing an attempt from the very counter the backoff
        // table reads. That is card P7-LINK-01B, raised and not fixed here:
        // widening the gate to every write point changes the kernel's
        // concurrency shape well beyond one key's freeze, and this card's law
        // is the freeze. Nothing in this comment should be read as ordering
        // those points against this one; it does not.
        // And it is held INLINE, not in a helper. `ATOMIC_WRITE_POINTS` is
        // checked by equality against the functions that contain `begin()`, so
        // factoring this read-modify-write into a private helper would empty
        // this function of its transaction and weaken that guard to
        // containment or a call-graph walk -- the file says so where the list
        // is declared, and this lock is not worth paying that.
        synchronized(WRITE_GATE) {
            db.begin()
            try {
                // L2's other half, and the one DR-84 did not cover: A KEY ON DISK IS
                // FROZEN. The digest guards above compare a payload with its own
                // digest, so a SECOND capture under this key with different bytes and
                // their own correct digest is internally consistent -- it would
                // replace the frozen row, hash correctly, read back, and send a
                // different intent under a key the server already holds. Neither
                // door could see it, because neither compares the row with the row
                // that is already there.
                //
                // The read is INSIDE the transaction on purpose: outside it, two
                // captures racing on one key could both find nothing and both write.
                // And `Transactional.write` is no help here -- it promises neither
                // insert nor replace, mirroring `SupportSQLiteDatabase`, whose row
                // write replaces on conflict.
                //
                // Found by independent review. An identical second capture is
                // refused too: this store cannot tell a caller retrying from a
                // caller replacing, and a key whose row exists has already decided
                // its payload.
                if (db.read(idempotencyKey) != null) {
                    throw PayloadRefused(
                        "the key $idempotencyKey is already captured; refusing to replace a frozen payload. " +
                            "A caller that needs those bytes reads the row, it does not capture them again",
                    )
                }
                db.write(row)
                db.markSuccessful()
            } finally {
                db.end()
            }
        }
        return row
    }

    private companion object {
        /**
         * The process-wide capture gate. A plain object, because what is needed
         * is mutual exclusion and nothing else: no fairness, no reentrancy
         * beyond the JVM monitor's own, and no timeout -- a capture that cannot
         * take the gate is waiting on another capture, which is microseconds of
         * disk work, and a timeout here would turn contention into a lost sale.
         */
        private val WRITE_GATE = Any()
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
        val opened = cipher.open(row.sealedPayload)
        // The other half of DR-84, and the half a flipped byte meets. The
        // digest was frozen over the plaintext at capture; recomputing it from
        // what comes back out says whether these are still those bytes. A
        // single byte changed in `sealedPayload` on disk opens to different
        // plaintext — or fails to open at all under an authenticated cipher —
        // and either way the read is refused rather than handed to a sender.
        val found = QueueDigest.of(opened)
        if (found != row.payloadDigest) {
            throw PayloadRefused(
                "the payload stored for $idempotencyKey no longer hashes to the digest frozen with it; " +
                    "refusing to hand back bytes that are not the ones captured",
            )
        }
        return row to opened
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
