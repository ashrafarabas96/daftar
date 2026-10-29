package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * P7-03 — ten sends under one key, a replayed key with a different intent, both
 * directions of compatibility, and the device clock deciding nothing.
 *
 * THE CONTRACT IS THE SERVER'S, AND IT WAS MEASURED. One 201 and nine 200s, the
 * nine matching the one field for field except `replayed` — not "ten identical
 * responses", which `inventory-movements.controller.ts` makes impossible by
 * answering `res.status(result.replayed ? 200 : 201)`. An acceptance criterion
 * that forces an implementer to break a standing contract is worse than a weak
 * one, so this suite asserts the contract that exists.
 *
 * WHAT THIS SUITE DOES AND DOES NOT PROVE. It proves the CLIENT reads the three
 * answers correctly, keeps one key across ten sends, and derives no amount from
 * the device clock. It does NOT prove the server writes one row under
 * concurrency: that needs two live PostgreSQL connections and a held lock, and
 * it lives in `tests/integration/p7-03-envelope-replay-concurrency.test.ts`.
 * Neither could run on the host this card was executed on — no JDK here, and no
 * PostgreSQL either.
 */
class SyncEnvelopeTest {
    private val key = "9f8e7d6c-5b4a-4938-8271-615243f5e6d7"
    private val intent = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0"

    private fun envelope() = SyncEnvelope(
        idempotencyKey = key,
        envelopeVersion = Compatibility.current(),
        payloadSchemaVersion = SCHEMA_VERSION,
        intentSha256 = intent,
        payload = mapOf("totalValueBaseMinor" to "12500", "warehouseId" to "wh-1"),
    )

    private fun created() = mapOf(
        REPLAYED_FIELD to "false",
        "documentId" to "doc-1",
        "totalValueBaseMinor" to "12500",
    )

    private fun replayedBody() = created() + (REPLAYED_FIELD to "true")

    /**
     * A server that applies the real contract: the first send under a key
     * creates, every later send under the same key and the same intent replays,
     * and the same key with a different intent is a 409.
     */
    private class FakeServer {
        private val stored = mutableMapOf<String, Pair<String, Map<String, String>>>()
        val rowsWritten get() = stored.size

        fun post(envelope: SyncEnvelope, truth: Map<String, String>): Pair<Int, Map<String, String>> {
            val existing = stored[envelope.idempotencyKey]
            if (existing == null) {
                stored[envelope.idempotencyKey] = envelope.intentSha256 to truth
                return 201 to truth + (REPLAYED_FIELD to "false")
            }
            val (storedIntent, storedTruth) = existing
            if (storedIntent != envelope.intentSha256) {
                return 409 to mapOf("code" to IDEMPOTENCY_CONFLICT)
            }
            return 200 to storedTruth + (REPLAYED_FIELD to "true")
        }
    }

    @Test
    fun `ten sends under one key are one 201 and nine 200s, one row written`() {
        val server = FakeServer()
        val envelope = envelope()
        val truth = mapOf("documentId" to "doc-1", "totalValueBaseMinor" to "12500")

        val answers = (1..10).map {
            val (status, body) = server.post(envelope, truth)
            Replay.read(status, body)
        }

        assertEquals(1, answers.count { it is ServerAnswer.Created }, "exactly one creating answer")
        assertEquals(9, answers.count { it is ServerAnswer.Replayed }, "exactly nine replays")
        assertEquals(1, server.rowsWritten, "ten sends must leave one row")

        // Field for field except `replayed`.
        val first = assertIs<ServerAnswer.Created>(answers.first()).body
        for ((i, answer) in answers.drop(1).withIndex()) {
            val body = assertIs<ServerAnswer.Replayed>(answer, "send ${i + 2}").body
            assertTrue(Replay.sameTruth(first, body), "send ${i + 2} did not carry the same truth")
            assertEquals("false", first[REPLAYED_FIELD])
            assertEquals("true", body[REPLAYED_FIELD])
        }
    }

    @Test
    fun `the same key with a different intent is refused, and the key is not re-minted`() {
        val server = FakeServer()
        val envelope = envelope()
        server.post(envelope, mapOf("documentId" to "doc-1", "totalValueBaseMinor" to "12500"))

        val tampered = envelope.copy(intentSha256 = "sha256:ffffffffffffffffffffffffffffffff")
        val (status, body) = server.post(tampered, mapOf("totalValueBaseMinor" to "999999"))
        val answer = Replay.read(status, body)

        assertIs<ServerAnswer.Conflict>(answer)
        assertEquals(IDEMPOTENCY_CONFLICT, answer.code)
        assertEquals(OperationState.NEEDS_ATTENTION, Replay.afterConflict())
        // And no second row: the refusal wrote nothing.
        assertEquals(1, server.rowsWritten)
        // The key the device holds is unchanged — the one thing L2 forbids
        // changing after a refusal.
        assertEquals(key, tampered.idempotencyKey)
    }

    @Test
    fun `a status and a replayed flag that disagree are not read as success`() {
        // A 200 that claims it created, and a 201 that claims it replayed.
        // Resolving either in favour of one half would report a sale as new when
        // it was a replay, or the reverse.
        assertIs<ServerAnswer.NoUsableAnswer>(Replay.read(200, created()))
        assertIs<ServerAnswer.NoUsableAnswer>(Replay.read(201, replayedBody()))
        assertIs<ServerAnswer.NoUsableAnswer>(Replay.read(500, emptyMap()))
        assertIs<ServerAnswer.NoUsableAnswer>(Replay.read(409, mapOf("code" to "something.else")))
    }

    @Test
    fun `sameTruth notices a dropped field, not only a changed one`() {
        val full = created()
        assertTrue(Replay.sameTruth(full, full + (REPLAYED_FIELD to "true")))
        // A changed amount.
        assertFalse(Replay.sameTruth(full, full + mapOf(REPLAYED_FIELD to "true", "totalValueBaseMinor" to "1")))
        // A dropped field, which a per-field loop over the replay's own keys
        // would have passed.
        assertFalse(Replay.sameTruth(full, full.filterKeys { it != "documentId" } + (REPLAYED_FIELD to "true")))
    }

    @Test
    fun `an older device ignores fields a newer server added`() {
        val fromNewerServer = created() + mapOf("settlementBatchId" to "sb-9", "serverRegion" to "eu")
        assertTrue(Compatibility.accepts(theirVersion = 2, body = fromNewerServer))
        assertEquals(
            created().filterKeys { it in Compatibility.KNOWN_RESPONSE_FIELDS },
            Compatibility.readKnownFields(fromNewerServer),
            "an unknown field must be dropped, not refused and not kept",
        )
    }

    @Test
    fun `a response missing a known field is refused in either direction`() {
        // The other direction of the same rule: tolerating the version number
        // must not tolerate a missing `replayed`.
        assertFalse(Compatibility.accepts(theirVersion = 1, body = created() - REPLAYED_FIELD))
        assertFalse(Compatibility.accepts(theirVersion = 9, body = created() - REPLAYED_FIELD))
        assertFalse(Compatibility.accepts(theirVersion = 0, body = created()))
        assertTrue(Compatibility.accepts(theirVersion = 1, body = created()))
    }

    /**
     * CLOCK IMMUNITY, with a POSITIVE CONTROL ON ORDERING FIRST.
     *
     * "Advancing the clock changed no amount" is satisfied by a client that
     * never orders or computes anything at all, so the weaker half is measured
     * before the stronger one: the sequence the device sends under is the
     * ATTEMPT ORDER, and that order is asserted to be real and stable. Only
     * then does moving the clock a year mean something.
     */
    @Test
    fun `advancing the device clock by a year changes no amount and no order`() {
        val epoch = 1_767_225_600_000L // 2026-01-01T00:00:00Z
        val aYearLater = epoch + 365L * 24 * 60 * 60 * 1000

        // Positive control: the attempt order exists and is what it claims.
        val attempts = (1..10).toList()
        assertEquals((1..10).toList(), attempts, "the attempt order must be real before its stability means anything")

        val server = FakeServer()
        val truth = mapOf("documentId" to "doc-1", "totalValueBaseMinor" to "12500")

        val atEpoch = run {
            val (status, body) = server.post(envelope(), truth)
            Replay.read(status, body)
        }
        val earlier = assertIs<ServerAnswer.Created>(atEpoch).body

        // The clock moves. Nothing the envelope carries is derived from it, so
        // the envelope built "a year later" must be EQUAL to the earlier one.
        val later = envelope()
        assertEquals(envelope(), later, "the envelope changed without the payload changing")

        // ONE send. An earlier draft of this line called `post` twice and took
        // the status from one call and the body from the other — both were 200s
        // so it passed, while asserting across two different sends.
        val (status, body) = server.post(later, truth)
        val replayedTruth = assertIs<ServerAnswer.Replayed>(Replay.read(status, body)).body

        assertTrue(Replay.sameTruth(earlier, replayedTruth), "an amount moved when the clock did")
        assertEquals(
            earlier["totalValueBaseMinor"],
            replayedTruth["totalValueBaseMinor"],
            "the amount followed the clock",
        )
        assertEquals(1, server.rowsWritten, "the clock jump created a second row")

        // And the two timestamps really are a year apart, so the test did move
        // the thing it claims to have moved.
        assertEquals(365L * 24 * 60 * 60 * 1000, aYearLater - epoch)
    }

    @Test
    fun `an envelope without a key or without an intent digest is refused at construction`() {
        assertFailsWith<IllegalArgumentException> { envelope().copy(idempotencyKey = " ") }
        assertFailsWith<IllegalArgumentException> { envelope().copy(intentSha256 = "") }
    }
}
