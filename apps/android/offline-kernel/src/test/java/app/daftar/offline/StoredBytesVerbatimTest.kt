package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * DR-84 condition 2 — the bytes of the first send, the bytes of every resend,
 * and the bytes on disk are one and the same, and nothing on the way re-builds
 * them.
 *
 * The device does not compute an intent: that is the server's `invpl/1` digest,
 * and a Kotlin encoder for it is deferred under DR-05. What the device
 * guarantees instead is narrower and checkable here: the request body is
 * captured ONCE, as bytes, under a key minted with it, and every attempt
 * transmits those same bytes — never a value re-serialized from current state.
 * A recomputed total, a re-resolved locale or a clock-derived date produces
 * different bytes, and the refusal happens on the device rather than as a 409
 * that burns the key forever.
 *
 * Every case here ships its own control, because a suite that only asserts
 * equality of things it built from one source proves the source, not the law.
 */
class StoredBytesVerbatimTest {
    private val opId = "4f3c2b1a-9e8d-4c7b-8a69-5d4c3b2a1908"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    /** The request body as the capturing surface stated it, once. */
    private val body = "{\"customer\":\"Fulana\",\"totalMinor\":12500,\"note\":\"blue door\"}".toByteArray()

    /** Reversible, so a test can read what the database holds. */
    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray) = ByteArray(plaintext.size) { (plaintext[it] + 1).toByte() }

        override fun open(sealed: ByteArray) = ByteArray(sealed.size) { (sealed[it] - 1).toByte() }
    }

    /** An in-memory disk whose rows a test can corrupt by one byte. */
    private class Disk : Transactional {
        val rows = LinkedHashMap<String, StoredRow>()

        override fun begin() = Unit

        override fun markSuccessful() = Unit

        override fun end() = Unit

        override fun write(row: StoredRow) {
            rows[row.idempotencyKey] = row
        }

        override fun delete(opId: String) {
            rows.remove(opId)
        }

        override fun read(opId: String): StoredRow? = rows[opId]

        override fun keysByState(state: OperationState): List<String> =
            rows.values.filter { it.state == state }.map { it.idempotencyKey }
    }

    private fun store(disk: Disk) = EncryptedQueueStore(disk, Marker())

    private fun moved(op: Operation, event: QueueEvent): Pair<Operation, List<SideEffect>> {
        val step = op.step(event)
        assertIs<Step.Moved>(step, "expected $event to be legal in ${op.state}")
        return step.operation to step.effects
    }

    @Test
    fun `the first send, every resend and the row on disk carry the same bytes`() {
        val disk = Disk()
        val store = store(disk)
        val digest = QueueDigest.of(body)
        store.captureWithKey(opId, body, digest)

        // Three independent reads, as three attempts would make.
        val reads = (1..3).map { store.load(opId) ?: error("the capture did not persist") }
        for ((index, read) in reads.withIndex()) {
            assertEquals(body.toList(), read.second.toList(), "read ${index + 1} did not return the captured bytes")
            assertEquals(digest, read.first.payloadDigest, "the row's digest moved between reads")
            assertEquals(digest, QueueDigest.of(read.second), "the bytes read do not hash to the frozen digest")
        }

        // And the kernel's own two attempts carry that same digest, which is
        // the only thing a sender is allowed to put on the wire.
        var (op, _) = moved(
            Operation.capture(opId, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR"),
            QueueEvent.Release(scope),
        )
        val (afterFirst, firstEffects) = moved(op, QueueEvent.Send(QueueDigest.of(reads[0].second), scope))
        op = afterFirst
        val (afterDeath, _) = moved(op, QueueEvent.ProcessDeath)
        op = afterDeath
        val (_, secondEffects) = moved(op, QueueEvent.Send(QueueDigest.of(reads[1].second), scope))

        val first = firstEffects.filterIsInstance<SideEffect.SendAttempt>().single()
        val second = secondEffects.filterIsInstance<SideEffect.SendAttempt>().single()
        assertEquals(first.idempotencyKey, second.idempotencyKey, "the key was re-minted between attempts")
        assertEquals(digest, first.payloadDigest)
        assertEquals(digest, second.payloadDigest, "the resend did not carry the captured bytes' digest")
    }

    /**
     * The negative control the owner asked for, and the whole point of the case
     * above: a sender that re-serializes on the way out. This one does what a
     * careless sender does — rebuilds the JSON from the same facts, with the
     * amount re-rendered and the keys in another order. Semantically the same
     * intent; different bytes; and the kernel must refuse it.
     *
     * It ships with the suite rather than being applied by hand, because a
     * plant nobody applies is a control nobody ran (DR-55).
     */
    @Test
    fun `a sender that rebuilds the body instead of resending it is refused`() {
        val disk = Disk()
        val store = store(disk)
        val digest = QueueDigest.of(body)
        store.captureWithKey(opId, body, digest)

        // Same facts, re-serialized: a decimal amount, a different key order.
        val rebuilt = "{\"note\":\"blue door\",\"customer\":\"Fulana\",\"totalMinor\":12500.00}".toByteArray()
        assertNotEquals(body.toList(), rebuilt.toList(), "the control must actually produce different bytes")
        val rebuiltDigest = QueueDigest.of(rebuilt)
        assertNotEquals(digest, rebuiltDigest, "the control's bytes hash to the captured digest, so it proves nothing")

        var (op, _) = moved(
            Operation.capture(opId, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR"),
            QueueEvent.Release(scope),
        )
        val refused = op.step(QueueEvent.Send(rebuiltDigest, scope))
        assertIs<Step.Refused>(refused, "a re-serialized payload was accepted for sending")
        // The code and the law are pinned, not merely present. A refusal for
        // some other reason — a switched account, a row already sending — would
        // otherwise read as this law being enforced when it was never reached.
        assertEquals("offline.payload_changed_after_capture", refused.code)
        // The law is read from the registry rather than spelled again here: a
        // second spelling of an id is a second source of truth for it.
        assertEquals(P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id, refused.law)

        // And the honest bytes are still accepted, so the refusal above is the
        // law speaking and not a send path that refuses everything.
        val honest = op.step(QueueEvent.Send(digest, scope))
        assertIs<Step.Moved>(honest, "the captured bytes' own digest was refused")
    }

    /**
     * DR-84 condition 1's control: one byte changed in what the database holds
     * must fire the guard. It is changed in `sealedPayload`, where a corrupted
     * file or a tampered row would change it, and the read is refused rather
     * than handed to a sender.
     */
    @Test
    fun `one byte changed on disk is refused on the way back out`() {
        val disk = Disk()
        val store = store(disk)
        store.captureWithKey(opId, body, QueueDigest.of(body))

        val stored = disk.rows.getValue(opId)
        val tampered = stored.sealedPayload.copyOf()
        tampered[3] = (tampered[3] + 1).toByte()
        assertNotEquals(
            stored.sealedPayload.toList(),
            tampered.toList(),
            "the plant did not change a byte, so its result is not a measurement",
        )
        disk.rows[opId] = stored.copy(sealedPayload = tampered)

        val refusal = assertFailsWith<PayloadRefused> { store.load(opId) }
        assertTrue(refusal.message!!.contains(opId), "the refusal must name the row it refused")

        // Restored byte for byte, the same read succeeds — so the refusal was
        // the tampering and not the store.
        disk.rows[opId] = stored
        val (row, opened) = store.load(opId) ?: error("the restored row did not read back")
        assertEquals(body.toList(), opened.toList())
        assertEquals(QueueDigest.of(body), row.payloadDigest)
    }

    @Test
    fun `a digest that is not the digest of the payload cannot be stored at all`() {
        val disk = Disk()
        val store = store(disk)

        val refusal = assertFailsWith<PayloadRefused> { store.captureWithKey(opId, body, "sha256:a1b2c3d4") }
        assertTrue(refusal.message!!.contains(opId))
        assertTrue(disk.rows.isEmpty(), "a refused capture must leave nothing on disk")

        // The same call with the real digest writes exactly one row.
        store.captureWithKey(opId, body, QueueDigest.of(body))
        assertEquals(1, disk.rows.size)
    }
}
