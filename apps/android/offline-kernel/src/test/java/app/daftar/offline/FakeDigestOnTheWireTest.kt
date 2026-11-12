package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * What stops a made-up digest from reaching the wire, and what does not.
 *
 * DR-84 put the real sha256 at the store's two doors: `captureWithKey` refuses
 * a digest that is not the digest of the payload handed in with it, and `load`
 * recomputes it from what comes back out. The state machine's own door is
 * weaker — `Operation.capture` asks only that the digest be non-empty
 * (`Queue.kt:358`) — and it cannot be anything else without changing a file
 * whose bytes are pinned by the 27/27 P7-01 promotion proof.
 *
 * MEASURED, so that the gap is recorded at its true size. Every
 * `Operation.capture` call in this repository is in a test: twenty call sites
 * at 5f5083ab, all under `src/test`, and the count is dated because adding a
 * suite moves it. `SendAttempt` is emitted in exactly one place,
 * `Queue.kt:655`, carrying the operation's own digest. Every caller of the
 * store is a test too. And `apps/android/app` does not depend on this module
 * at all — zero `project(` and zero `offline-kernel` in its build file. So
 * there is no production path from an operation to a send, in either
 * direction, and no file anywhere wires the store to the state machine. The
 * gap is structural and not live: it becomes reachable on the day the app is
 * wired, which is the day the wiring must pass the store's verified digest in.
 *
 * Card P7-CAPTURE-DIGEST-FORM records that strengthening, and it needs an
 * explicit owner decision because closing it re-pins the twenty-seven digests
 * and touches five pinned suites. This suite is what keeps the gap measured
 * until then: its first case proves the sanctioned path cannot carry a fake
 * digest, and its second proves the bypass can — which is the whole reason the
 * card exists rather than a sentence in a report.
 */
class FakeDigestOnTheWireTest {
    private val opId = "2b1a0f9e-8d7c-4b6a-9584-736251f4e3d2"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")
    private val body = "{\"totalMinor\":12500,\"currency\":\"SAR\"}".toByteArray()
    private val fake = "sha256:deadbeef"

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray) = ByteArray(plaintext.size) { (plaintext[it] + 1).toByte() }

        override fun open(sealed: ByteArray) = ByteArray(sealed.size) { (sealed[it] - 1).toByte() }
    }

    private class Disk : Transactional {
        val rows = LinkedHashMap<String, StoredRow>()

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

    /** The digest the kernel would actually put on the wire for this operation. */
    private fun digestOnTheWire(op: Operation): String {
        val released = op.step(QueueEvent.Release(scope))
        assertIs<Step.Moved>(released)
        val sent = released.operation.step(QueueEvent.Send(op.payloadDigest, scope))
        assertIs<Step.Moved>(sent, "the send was refused, so nothing reached the wire")
        return sent.effects.filterIsInstance<SideEffect.SendAttempt>().single().payloadDigest
    }

    /**
     * The law, as one function, so the same words are applied to the sanctioned
     * path and to the bypass. A law written twice is two laws.
     */
    private fun onlyARealDigestReachesTheWire(op: Operation) {
        val onTheWire = digestOnTheWire(op)
        assertTrue(
            QueueDigest.FORM.matches(onTheWire),
            "$onTheWire reached a send attempt, and it is not 64 lowercase hex characters",
        )
        assertEquals(QueueDigest.of(body), onTheWire, "the digest on the wire is not the captured bytes'")
    }

    @Test
    fun `the sanctioned path cannot carry a fake digest, because the store refuses it`() {
        val disk = Disk()
        val store = EncryptedQueueStore(disk, Marker())

        // There is no way to get the fake digest onto disk, so there is no row
        // to build an operation from and nothing to send.
        assertFailsWith<PayloadRefused> { store.captureWithKey(opId, body, fake) }
        assertTrue(disk.rows.isEmpty(), "a refused capture left a row behind")

        // The honest capture, and the operation built from what the store
        // verified: its digest reaches the wire and satisfies the law.
        val row = store.captureWithKey(opId, body, QueueDigest.of(body))
        val op = Operation.capture(row.idempotencyKey, scope, EffectClass.FINANCIAL, row.payloadDigest, 12_500, "SAR")
        onlyARealDigestReachesTheWire(op)
    }

    /**
     * The negative control the owner asked for: bypass the store, and the law
     * above fails. It is asserted as a failure rather than described in a
     * comment, so the law is proved able to fail and the gap is proved to be
     * real — today, on this commit, with this kernel.
     *
     * When card P7-CAPTURE-DIGEST-FORM is executed, `Operation.capture` will
     * refuse this digest outright. `assertFails` catches that too, so this
     * case does not become a tripwire against its own fix; what must change in
     * the same commit is this comment and the card's status.
     */
    @Test
    fun `bypassing the store puts the fake digest on the wire, which is the recorded gap`() {
        val bypassed = Operation.capture(opId, scope, EffectClass.FINANCIAL, fake, 12_500, "SAR")

        // It is accepted at construction: the state machine's door asks only
        // that the digest be non-empty.
        assertEquals(fake, bypassed.payloadDigest)

        val failure = assertFails("the bypass satisfied a law that only the store can satisfy") {
            onlyARealDigestReachesTheWire(bypassed)
        }
        assertTrue(
            failure.message!!.contains(fake),
            "the failure must name the value that reached the wire, not merely that something did",
        )

        // And the measurement behind the card: the fake digest DOES reach a
        // send attempt by this route. Stated once, here, rather than left for
        // a reader to infer from the failure above.
        assertEquals(fake, digestOnTheWire(bypassed))
    }

    /**
     * Which door is shut, and which is not.
     *
     * An earlier version of this comment said the store was shut "for both
     * halves of DR-84 — so the only way to a fake digest on the wire is to not
     * use the store at all". Independent review falsified it: a SECOND capture
     * under a key already on disk replaced the frozen row, with its own correct
     * digest, and neither half could see it because neither compared the row
     * with the row already there. That is now a third refusal, with
     * `CaptureIsFrozenTest` behind it, and the sentence is corrected here
     * rather than removed, because a comment that overstated a guard is how a
     * reader comes to trust one.
     *
     * So the store refuses three things — a digest that is not its payload's,
     * bytes that no longer hash to the frozen digest, and a capture under a key
     * that is taken — and what remains open is the state machine's own door,
     * which is this suite's subject and card P7-CAPTURE-DIGEST-FORM.
     */
    @Test
    fun `the store refuses both a wrong digest going in and changed bytes coming out`() {
        val disk = Disk()
        val store = EncryptedQueueStore(disk, Marker())
        store.captureWithKey(opId, body, QueueDigest.of(body))

        val stored = disk.rows.getValue(opId)
        val tampered = stored.sealedPayload.copyOf()
        tampered[0] = (tampered[0] + 1).toByte()
        disk.rows[opId] = stored.copy(sealedPayload = tampered)
        assertFailsWith<PayloadRefused> { store.load(opId) }

        disk.rows[opId] = stored
        val (row, opened) = store.load(opId) ?: error("the restored row did not read back")
        assertEquals(body.toList(), opened.toList())
        assertEquals(QueueDigest.of(body), row.payloadDigest)
    }
}
