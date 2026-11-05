package app.daftar.offline

import java.security.MessageDigest

/**
 * The digest of the bytes this device captured — **a local integrity check on
 * the queue, and nothing else.**
 *
 * WHAT THIS IS NOT (owner decision DR-84, 2026-11-04). It is not the server's
 * proof of intent and it is never compared with one. The server computes its
 * own, from the fields of the request it actually received, with the `invpl/1`
 * encoder in `packages/inventory/src/payload.ts` — a positional, LF-framed
 * stream over `inventoryIntentSchema(opCode)`, hashed to lowercase hex, and
 * rebuilt independently by `inventory_payload_digest` in the database so that
 * no caller-supplied digest is trusted. Measured: the movement schemas accept
 * no client digest at all (zero occurrences of `intentSha256`, beside a
 * sighted control in the same file), and the column refuses anything but
 * `^[0-9a-f]{64}$`. A device-side `invpl/1` encoder is deferred under DR-05 as
 * card P7-INVPL-KOTLIN.
 *
 * WHAT IT IS FOR. L2 says the bytes sent are the bytes stored at capture, and
 * L3 says a payload re-serialized at send time is refused rather than sent.
 * Both are only worth stating if something checks them, and the thing that
 * checks them is this digest: it is frozen with the row, recomputed from the
 * row's own payload whenever that payload is read back, and compared before a
 * send. A recomputed total, a re-resolved locale or a clock-derived date
 * changes the bytes, changes this digest, and is refused on the device —
 * rather than being discovered by the server, which would refuse the key
 * forever.
 *
 * THE FORM IS THE SERVER'S, deliberately: lowercase hex, 64 characters, no
 * prefix. Not because the two values are ever compared — they are not — but
 * because a value that CANNOT be compared should not be shaped as though it
 * could, and because the previous shape (`"sha256:a1b2c3d4"`, eight hex
 * characters behind a prefix) could never be anything but a sentinel. Measured:
 * no such value passes the server column's own check.
 *
 * It is computed over the PLAINTEXT payload, not over the sealed bytes, and
 * that is not an oversight: sealing is authenticated encryption with a fresh
 * nonce, so the sealed bytes of one payload differ on every seal. A digest over
 * them would change without the payload changing, which is the opposite of a
 * frozen digest. A byte flipped in the sealed bytes is still caught — opening
 * them yields different plaintext, whose digest no longer matches the frozen
 * one, and the read is refused.
 */
object QueueDigest {
    /** The shape every digest in the queue has: lowercase hex, 64 characters. */
    val FORM = Regex("^[0-9a-f]{64}$")

    private val HEX = "0123456789abcdef".toCharArray()

    /**
     * sha256 of [bytes], lowercase hex, 64 characters.
     *
     * The hex is written here rather than through a formatter because
     * `%02x`-style formatting is locale-sensitive in some JVM configurations
     * and a digest whose spelling depends on the device's locale is not a
     * digest. `MessageDigest` is reinstantiated per call: the class is not
     * thread-safe, and a shared instance would interleave two captures into one
     * wrong value under exactly the concurrency this queue exists for.
     */
    fun of(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val out = CharArray(digest.size * 2)
        for (i in digest.indices) {
            val b = digest[i].toInt() and 0xff
            out[i * 2] = HEX[b ushr 4]
            out[i * 2 + 1] = HEX[b and 0x0f]
        }
        return String(out)
    }
}
