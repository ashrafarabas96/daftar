package app.daftar.offline

/**
 * The send seam, and the reason it is an interface in the kernel rather than a
 * client.
 *
 * CARD P7-LINK-03, red first. Before this file the kernel performed no send and
 * declared no seam: `SideEffect.SendAttempt` is an event, and the only HTTP
 * client in the project lives in `:app` (`data/ApiClient.kt`), which does not
 * depend on this module and MINTS ITS OWN KEY at send time -- the exact inverse
 * of [P7Laws.KEY_MINTED_AT_CAPTURE]. So there was nothing a test in this module
 * could hold a sender to, and the kernel's laws stopped at the edge of the
 * queue.
 *
 * WHAT THIS SEAM EXISTS TO FORBID, which is the whole of DR-84's division of
 * authority on this side:
 *
 *  - a key minted at send. The key is an argument of [Outgoing], taken from the
 *    row, and this file offers no way to make one;
 *  - a payload re-serialised on the way out. [Outgoing.body] is the bytes as
 *    they were stored, carried, never rebuilt from fields;
 *  - an intent digest recomputed on the device. [Outgoing.intentSha256] is
 *    CARRIED from the row. The device does not build the server's canonical
 *    `invpl/1` stream -- that encoder is card P7-INVPL-KOTLIN, deferred under
 *    DR-05, and DR-84 settled the near term the other way: the device stores
 *    the request body and replays it, and the intent is computed where it is
 *    compared, on the server.
 *
 * It performs no I/O and names no HTTP type on purpose: the implementation is
 * `:app`'s, and a kernel that imported a client would make this module's
 * ninety-nine pure-JVM cases depend on a transport.
 */
interface Sender {
    /**
     * Send [outgoing] once, and report only what the server said. An
     * implementation must not retry, must not alter the envelope, and must not
     * interpret the answer: [Outcome.classify] is the one place an answer
     * becomes a decision.
     */
    fun send(outgoing: Outgoing): AttemptResult
}

/**
 * One attempt's wire content, built from a stored row and from nothing else.
 *
 * The constructor is private and [fromRow] is the only way in, so a caller
 * cannot assemble an attempt out of fields it happens to hold: the row is the
 * only authority for the key, the bytes and the carried digest.
 */
class Outgoing private constructor(
    /** The idempotency key minted at capture, as the server will see it. */
    val idempotencyKey: String,
    /** The payload bytes exactly as they were persisted. */
    val body: ByteArray,
    /** The digest carried with the row; never recomputed here. */
    val intentSha256: String,
    /** The queue schema the row was written under. */
    val payloadSchemaVersion: Int,
) {
    /** The envelope version this device speaks. */
    val envelopeVersion: Int = Compatibility.current()

    companion object {
        /**
         * Build an attempt from a row and its opened payload -- the pair
         * [EncryptedQueueStore.load] returns, so the bytes are the ones that
         * passed the digest check on the way out of the store.
         *
         * The digest is checked here too, and that is not duplication: `load`
         * proves the bytes match the row, and this proves the thing being SENT
         * matches both. A sender fed from a row and a different byte array is
         * exactly the mistake this seam exists to make impossible.
         */
        fun fromRow(row: StoredRow, body: ByteArray): Outgoing {
            val offered = QueueDigest.of(body)
            if (offered != row.payloadDigest) {
                throw PayloadRefused(
                    "refusing to send ${row.idempotencyKey}: the bytes offered hash to $offered " +
                        "and the row carries ${row.payloadDigest}. A send is a replay of what was " +
                        "captured, never a re-serialisation of it",
                )
            }
            return Outgoing(
                idempotencyKey = row.idempotencyKey,
                body = body.copyOf(),
                intentSha256 = row.payloadDigest,
                payloadSchemaVersion = row.schemaVersion,
            )
        }
    }
}
