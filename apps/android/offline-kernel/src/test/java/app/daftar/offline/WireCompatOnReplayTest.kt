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
 *   - `SyncEnvelope.intentSha256` is a field with NO producer on this side,
 *     and it must stay that way: its own KDoc says "it is never filled from a
 *     row's local integrity digest", and `QueueDigest.kt` says of that digest
 *     "it is not the server's proof of intent and it is never compared with
 *     one". An earlier draft of this suite filled the slot from
 *     `row.payloadDigest` and asserted the result -- a value of one kind put
 *     into a slot of another, and then pinned. That is corrected here rather
 *     than quietly dropped, and case 4 is the guard that stops it returning.
 *
 * WHAT THIS SUITE ASSERTS:
 *   1. a sender seam exists in the kernel, fed from a stored row, and it is a
 *      seam a sender can actually be held to -- not merely a name that
 *      resolves;
 *   2. the replay carries the row's own key and byte-for-byte payload, built
 *      from the row and from nothing else -- never a freshly minted key and
 *      never a re-serialised body;
 *   3. as DR-84's other half, the kernel does not grow an intent encoder
 *      behind the owner's deferral;
 *   4. and the seam carries no intent digest at all, so the local digest
 *      cannot reach a wire field that forbids it.
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

        // A NAME THAT RESOLVES IS NOT A SEAM. An empty interface would satisfy
        // the search above, so the shape is measured: the seam must declare a
        // send that takes the attempt type and answers the kernel's own result
        // type. A sender cannot be held to anything less.
        val seam = Class.forName(found.first())
        val sends = seam.methods.filter { it.name == "send" }
        assertTrue(
            sends.isNotEmpty(),
            "${seam.name} declares no send, so it is a name rather than a seam",
        )
        val usable = sends.any { m ->
            m.parameterTypes.size == 1 &&
                m.parameterTypes[0] == Outgoing::class.java &&
                AttemptResult::class.java.isAssignableFrom(m.returnType)
        }
        assertTrue(
            usable,
            "the seam's send does not take one Outgoing and answer an AttemptResult, so the " +
                "envelope a sender transmits is not the one built from the row: " +
                sends.joinToString(", ") { it.toString() },
        )
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

        // The attempt that goes out must be built FROM the row. A sender that
        // mints a key, or re-serialises the body, breaks the server's
        // idempotency and DR-84's division of authority at once.
        val outgoing = Outgoing.fromRow(row, bytes)
        assertEquals(key, outgoing.idempotencyKey, "the attempt must carry the row's key")
        assertTrue(
            outgoing.body.contentEquals(payload),
            "the attempt must carry the stored bytes, not a re-serialisation of them",
        )
        assertEquals(row.schemaVersion, outgoing.payloadSchemaVersion)

        // THE NEGATIVE CONTROL on the same seam: bytes that do not hash to the
        // row's digest must be refused, not sent. Without this the check above
        // would pass for a sender fed a row and somebody else's payload.
        val tampered = "{\"b\":\"1\",\n\"a\":\"3 \"}".toByteArray()
        assertTrue(!tampered.contentEquals(payload), "the control's own premise failed")
        var refused = false
        try {
            Outgoing.fromRow(row, tampered)
        } catch (expected: PayloadRefused) {
            refused = true
        }
        assertTrue(
            refused,
            "the seam built an attempt out of a row and bytes that are not its own",
        )
    }

    @Test
    fun the_seam_carries_no_intent_digest_for_a_wire_field_that_forbids_one() {
        // DR-84, and the correction this case exists to hold. `SyncEnvelope`
        // requires a non-blank `intentSha256`, and its own KDoc forbids filling
        // it from a row's local integrity digest -- which is exactly what
        // `QueueDigest.of(bytes)`, and therefore `StoredRow.payloadDigest`, is.
        // So on this side the slot has NO producer, and the way to keep it that
        // way is for the seam to carry no such value at all.
        val forbidden = listOf("intentSha256", "intentDigest", "intent")
        val carried = Outgoing::class.java.methods
            .filter { it.parameterTypes.isEmpty() && it.name.startsWith("get") }
            .map { it.name.removePrefix("get").replaceFirstChar { c -> c.lowercaseChar() } }

        // POSITIVE CONTROL FIRST: a probe that sees nothing proves nothing
        // about what is absent (RULE-3). These are the fields the seam does
        // carry, so the probe is demonstrably reading the right type.
        for (expected in listOf("idempotencyKey", "body", "payloadSchemaVersion")) {
            assertTrue(
                carried.contains(expected),
                "positive control failed: the probe did not even see $expected on Outgoing, " +
                    "so its silence about an intent digest measures nothing. Saw: $carried",
            )
        }

        val offenders = carried.filter { name -> forbidden.any { name.equals(it, true) } }
        assertEquals(
            emptyList(),
            offenders,
            "the sender seam carries an intent digest ($offenders). SyncEnvelope's own KDoc " +
                "says that field is never filled from a row's local integrity digest, and the " +
                "device computes no canonical intent while P7-INVPL-KOTLIN is deferred",
        )

        // And the prohibition is stated where an implementor reads it, not only
        // here: the seam's own source must name the deferral.
        val sender = kernelSource("Sender.kt")
        assertTrue(
            sender.contains("P7-INVPL-KOTLIN"),
            "Sender.kt does not name the deferred card, so the next writer learns the rule " +
                "from a test failure rather than from the seam",
        )
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

        // THE PROBE'S OWN CONTROL, and it is not the readability check above:
        // that one proves the FILES arrive, this one proves the PREDICATE
        // fires. A marker list that matched nothing -- a typo, a renamed
        // constant -- would give the same empty answer as a clean kernel, and
        // the two must not be indistinguishable (RULE-3, RULE-27).
        val plant = "internal const val INVPL_DOMAIN = \"invpl/1\"\nfun canonicalStream() = 0\n"
        assertTrue(
            intentMarkers.any { plant.contains(it) },
            "the marker probe does not fire on a planted encoder, so its silence about the " +
                "kernel is not a measurement",
        )

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
