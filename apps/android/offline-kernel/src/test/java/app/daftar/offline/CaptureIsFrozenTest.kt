package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * L2 and DR-84 condition 2, at the one door that can still break them: a key
 * that is on disk is FROZEN, and a second capture under it is refused.
 *
 * DR-84 says the request body is captured once, as bytes, under a fixed
 * idempotency key, and that every resend carries those same bytes. The store
 * enforces the digest at both of its doors — a digest that is not its payload's
 * cannot be written, and bytes that no longer hash to the frozen digest cannot
 * be read back. Neither of those catches this: a SECOND capture under the same
 * key, with different bytes AND their own correct digest, is internally
 * consistent. `captureWithKey` wrote without reading, and `Transactional.write`
 * promises neither insert nor replace — it "mirrors `SupportSQLiteDatabase`",
 * whose replace-on-conflict is exactly what a row-level write usually is.
 *
 * So the frozen payload could be replaced, with the digest agreeing, and
 * nothing downstream could tell: the row would hash correctly, `load` would
 * hand back the new bytes, and the server would be sent a different intent
 * under a key it already holds — the 409 that burns the key, caused on the
 * device, by the device.
 *
 * Found by independent review, not by the author. Measured before the fix: no
 * case in this module captured the same key twice, so nothing could have seen
 * it.
 */
class CaptureIsFrozenTest {
    private val opId = "6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a"

    private val first = "{\"totalMinor\":12500,\"currency\":\"SAR\"}".toByteArray()
    private val second = "{\"totalMinor\":99900,\"currency\":\"SAR\"}".toByteArray()

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray) = ByteArray(plaintext.size) { (plaintext[it] + 1).toByte() }

        override fun open(sealed: ByteArray) = ByteArray(sealed.size) { (sealed[it] - 1).toByte() }
    }

    private class Disk : Transactional {
        val rows = LinkedHashMap<String, StoredRow>()
        var writes = 0

        override fun begin() = Unit

        override fun markSuccessful() = Unit

        override fun end() = Unit

        override fun write(row: StoredRow) {
            writes += 1
            rows[row.idempotencyKey] = row
        }

        override fun delete(key: String) {
            rows.remove(key)
        }

        override fun read(key: String): StoredRow? = rows[key]

        override fun keysByState(state: OperationState): List<String> =
            rows.values.filter { it.state == state }.map { it.idempotencyKey }
    }

    @Test
    fun `a second capture under a key already on disk is refused, bytes and all`() {
        val disk = Disk()
        val store = EncryptedQueueStore(disk, Marker())
        store.captureWithKey(opId, first, QueueDigest.of(first))
        val frozen = disk.rows.getValue(opId)
        val writesAfterTheFirst = disk.writes

        // Different bytes, and their own correct digest: nothing about this
        // capture is malformed. It is refused because the key is taken.
        val refusal = assertFailsWith<PayloadRefused> {
            store.captureWithKey(opId, second, QueueDigest.of(second))
        }
        assertTrue(refusal.message!!.contains(opId), "the refusal must name the key it refused")

        // Nothing moved: not the row, not the bytes, not the digest, and not
        // even the write count — a refusal that wrote and rolled back would
        // leave the same map but a different story.
        assertEquals(frozen, disk.rows.getValue(opId), "the frozen row was replaced")
        assertEquals(writesAfterTheFirst, disk.writes, "a refused capture reached the write door")
        val (row, opened) = store.load(opId) ?: error("the first capture did not survive")
        assertEquals(first.toList(), opened.toList(), "load returned the second capture's bytes")
        assertEquals(QueueDigest.of(first), row.payloadDigest)
    }

    /**
     * The same key with the SAME bytes is refused too, and that is deliberate.
     * The store cannot tell a caller retrying a capture from a caller
     * replacing one, and a key whose row exists is a key whose payload is
     * already decided: the right move is to read the row, not to write it
     * again. Refusing is also what makes the law above checkable without
     * comparing payloads, which a sealed payload cannot be compared by.
     */
    @Test
    fun `even an identical second capture is refused, because the key is taken`() {
        val disk = Disk()
        val store = EncryptedQueueStore(disk, Marker())
        store.captureWithKey(opId, first, QueueDigest.of(first))

        assertFailsWith<PayloadRefused> { store.captureWithKey(opId, first, QueueDigest.of(first)) }
        assertEquals(1, disk.rows.size)
    }

    /**
     * The negative control, and it is the measurement that makes the case above
     * mean something: the DISK itself replaces happily. So the refusal is the
     * store's doing, and the suite would notice if the store stopped doing it.
     */
    @Test
    fun `the disk underneath replaces without complaint, which is why the store must refuse`() {
        val disk = Disk()
        val store = EncryptedQueueStore(disk, Marker())
        store.captureWithKey(opId, first, QueueDigest.of(first))
        val frozen = disk.rows.getValue(opId)

        // Straight to the write door, with the store bypassed: a row whose
        // digest is correct for DIFFERENT bytes.
        val sealedSecond = Marker().seal(second)
        disk.write(
            StoredRow(
                idempotencyKey = opId,
                schemaVersion = SCHEMA_VERSION,
                state = OperationState.CAPTURED,
                attempts = 0,
                payloadDigest = QueueDigest.of(second),
                sealedPayload = sealedSecond,
            ),
        )

        // It went through, and it is self-consistent: this is what the store's
        // refusal prevents, and what `load` cannot catch.
        val replaced = disk.rows.getValue(opId)
        assertTrue(replaced != frozen, "the control did not actually replace the row")
        val (row, opened) = store.load(opId) ?: error("the replaced row did not read back")
        assertEquals(second.toList(), opened.toList())
        assertEquals(QueueDigest.of(second), row.payloadDigest)
    }
}
