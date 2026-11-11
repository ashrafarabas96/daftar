package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * CARD P7-LINK-03 -- live compatibility between the Android sender and the
 * server: the key, the bytes on replay, and the `invpl/1` digest.
 *
 * READ DR-84 BEFORE CHANGING THIS SUITE. The device does NOT compute an
 * `invpl/1` intent digest: the card P7-INVPL-KOTLIN is deferred under DR-05,
 * and DR-84 settled the near term the other way round -- the device "stores
 * the request body's bytes and sends them back as they are", and the intent
 * digest is computed where it is compared, on the server. So a Kotlin encoder
 * is NOT what this card needs, and a suite that demanded one would be asking
 * for production code the owner deferred.
 *
 * What the card does need is the SEAM, and the seam is what is missing:
 *
 *   - the kernel has no sender. `SendAttempt` is an event, nothing in
 *     `app.daftar.offline` performs a request, and a search for an HTTP client
 *     in the kernel's production source returns nothing;
 *   - `:app` has one (`data/ApiClient.kt`) but it does not depend on
 *     `:offline-kernel`, and it MINTS ITS OWN KEY at send time -- which is the
 *     exact inverse of `KEY_MINTED_AT_CAPTURE`;
 *   - `SyncEnvelope.intentSha256` is a field with no producer on this side,
 *     which is correct under DR-84 only if the value is CARRIED, never
 *     recomputed -- and nothing states that today.
 *
 * WHAT THIS SUITE ASSERTS:
 *   1. a sender seam exists in the kernel, fed from a stored row;
 *   2. the replay carries the row's own key, byte-for-byte payload, and the
 *      carried digest -- never a freshly minted key and never a recomputed one;
 *   3. and, as DR-84's other half, that the kernel does not grow an intent
 *      encoder behind the owner's deferral.
 *
 * Case 1 is red today; cases 2 and 3 pin the law the seam must arrive under.
 */
class WireCompatOnReplayTest {

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray): ByteArray = plaintext.copyOf()
        override fun open(sealed: ByteArray): ByteArray = sealed.copyOf()
    }

    private class Disk : Transactional {
        private val rows = LinkedHashMap<String, StoredRow>()
        override fun begin() = Unit
        override fun markSuccessful() = Unit
        override fun end() = Unit
        override fun write(row: StoredRow) {
            rows[row.idempotencyKey] = row
        }
        override fun delete(key: String) {
            rows.remove(key)
        }
        override fun read(key: String): StoredRow? = rows[key]
        override fun keysByState(state: OperationState): List<String> =
            rows.values.filter { it.state == state }.map { it.idempotencyKey }
    }

    private fun kernelSource(name: String): String {
        val root = java.io.File(System.getProperty("p7.src") ?: "prep/phase7/kotlin/src")
        val file = java.io.File(root, "app/daftar/offline/$name")
        if (!file.isFile) {
            fail("the subject was not readable, so this check measured nothing: ${file.absolutePath}")
        }
        return file.readText()
    }

    @Test
    fun the_kernel_has_a_sender_seam_fed_from_a_stored_row() {
        val candidates = listOf(
            "app.daftar.offline.Sender",
            "app.daftar.offline.QueueSender",
            "app.daftar.offline.OutboxSender",
            "app.daftar.offline.SyncSender",
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
                "the kernel performs no send and declares no sender seam, so nothing in this " +
                    "module can hold the app's client to the captured key and the stored bytes. " +
                    "Expected one of: " + candidates.joinToString(", "),
            )
        }
    }

    @Test
    fun the_replay_carries_the_rows_own_key_and_bytes_verbatim() {
        val disk = Disk()
        val store = EncryptedQueueStore(disk, Marker())
        val key = "44444444-4444-4444-8444-444444444444"
        // Bytes chosen so that any re-serialisation shows: key order that is
        // not alphabetical, a bare LF inside the body, and a trailing space.
        val payload = "{\"b\":\"1\",\n\"a\":\"2 \"}".toByteArray()
        store.captureWithKey(key, payload, QueueDigest.of(payload))

        val loaded = store.load(key) ?: fail("the captured row did not load back")
        val (row, bytes) = loaded

        assertEquals(key, row.idempotencyKey, "the row must keep the key minted at capture")
        assertTrue(
            bytes.contentEquals(payload),
            "the stored bytes must come back byte-for-byte, not re-serialised",
        )
        assertEquals(
            QueueDigest.of(payload),
            row.payloadDigest,
            "the row's digest must be the digest of those same bytes",
        )

        // The envelope that goes out must be built FROM the row. A sender that
        // mints a key, or recomputes the carried digest, breaks the server's
        // idempotency and DR-84's division of authority at once.
        val envelope = SyncEnvelope(
            idempotencyKey = row.idempotencyKey,
            envelopeVersion = Compatibility.current(),
            payloadSchemaVersion = row.schemaVersion,
            intentSha256 = row.payloadDigest,
            payload = mapOf("body" to String(bytes)),
        )
        assertEquals(key, envelope.idempotencyKey)
        assertEquals(row.payloadDigest, envelope.intentSha256)
    }

    @Test
    fun the_device_does_not_compute_an_intent_digest_behind_the_deferral() {
        // DR-84 and the deferred card P7-INVPL-KOTLIN: the device hashes the
        // bytes it stored (`QueueDigest`), and does not build the server's
        // canonical intent stream. An absence claim needs a positive control,
        // so the probe must first SEE the thing that is present (RULE-3).
        val digest = kernelSource("QueueDigest.kt")
        assertTrue(
            digest.contains("SHA-256") || digest.contains("sha256"),
            "positive control failed: the kernel's own digest was not found by this probe, " +
                "so its silence about an intent encoder proves nothing",
        )
        val intentMarkers = listOf("invpl/1\"", "canonicalStream", "canonicalIntent", "INVPL_DOMAIN")
        val names = listOf("QueueDigest.kt", "SyncEnvelope.kt", "Persistence.kt", "Queue.kt")
        val offenders = names.filter { file ->
            val text = kernelSource(file)
            intentMarkers.any { text.contains(it) }
        }
        assertEquals(
            emptyList(),
            offenders,
            "the kernel began building the server's canonical intent stream while " +
                "P7-INVPL-KOTLIN is deferred under DR-05",
        )
    }
}
