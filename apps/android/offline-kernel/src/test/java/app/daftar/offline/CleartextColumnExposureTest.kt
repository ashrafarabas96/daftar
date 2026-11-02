package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * DR-67 CONDITION 1 — nothing personal and nothing financial reaches a column
 * stored outside the AES-GCM payload.
 *
 * OD-P7-01 (whole-file encryption, SQLCipher) is deferred to P7-04, and this
 * suite is the condition that keeps the deferral from being a gap: the five
 * cleartext columns are inventoried in `Persistence.kt`, and a row is written
 * here whose payload carries a customer name, a phone number, an amount and a
 * note. If ANY of those four reaches ANY cleartext column, the case fails and
 * names the column and the sentinel.
 *
 * The sentinels are fictional and are chosen to be unmistakable in a failure
 * message. They are checked case-insensitively and as substrings, because a
 * leak that lowercased a name or embedded it in a longer string is still a
 * leak.
 *
 * NOT RUN on the host this card was executed on: no `kotlinc`. It runs under
 * `./gradlew testDebugUnitTest`.
 */
class CleartextColumnExposureTest {
    private val customerName = "Fulana Al-Fulaniyya"
    private val phone = "+966500000000"
    private val amount = "12500"
    private val note = "deliver behind the blue door"

    /** Everything that must never be readable without the key. */
    private val sentinels = mapOf(
        "customer name" to customerName,
        "phone number" to phone,
        "amount" to amount,
        "note" to note,
    )

    private val payload: ByteArray =
        "{\"customer\":\"$customerName\",\"phone\":\"$phone\"," +
            "\"totalMinor\":$amount,\"note\":\"$note\"}".toByteArray()

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray) =
            ByteArray(plaintext.size) { (plaintext[it] + 1).toByte() }

        override fun open(sealed: ByteArray) =
            ByteArray(sealed.size) { (sealed[it] - 1).toByte() }
    }

    /**
     * The cleartext columns of a row, as the strings a database file would
     * hold. Derived from the row rather than restated, so a column added to
     * [StoredRow] is covered here the moment the inventory names it — and the
     * static guard refuses an uninventoried one.
     */
    private fun cleartextOf(row: StoredRow): Map<String, String> = mapOf(
        "idempotencyKey" to row.idempotencyKey,
        "schemaVersion" to row.schemaVersion.toString(),
        "state" to row.state.name,
        "attempts" to row.attempts.toString(),
        "payloadDigest" to row.payloadDigest,
    )

    @Test
    fun `the inventory covers exactly the cleartext columns this suite inspects`() {
        // Equality, so the suite cannot inspect a subset of what is inventoried
        // and still pass. The other direction — a row column nobody
        // inventoried — is refused by the static guard, which can read the
        // `data class` declaration itself.
        assertEquals(
            CLEARTEXT_COLUMNS.toSet(),
            cleartextOf(aRow()).keys,
            "inventory vs inspected columns",
        )
    }

    @Test
    fun `no personal or financial datum appears in any cleartext column`() {
        val row = aRow()
        val leaks = mutableListOf<String>()
        for ((column, value) in cleartextOf(row)) {
            for ((what, sentinel) in sentinels) {
                if (value.contains(sentinel, ignoreCase = true)) {
                    leaks.add("$column carries the $what ($sentinel)")
                }
            }
        }
        assertEquals(emptyList(), leaks, "cleartext columns leaked")

        // And the payload really did contain them, or the case above is empty
        // of meaning: a probe that found nothing because nothing was there.
        val opened = String(Marker().open(row.sealedPayload))
        for ((what, sentinel) in sentinels) {
            assertTrue(opened.contains(sentinel), "the payload never carried the $what")
        }
    }

    @Test
    fun `the sealed payload is not readable as the plaintext`() {
        val row = aRow()
        val sealedAsText = String(row.sealedPayload)
        for ((what, sentinel) in sentinels) {
            assertTrue(
                !sealedAsText.contains(sentinel, ignoreCase = true),
                "the sealed payload still reads as the $what",
            )
        }
    }

    /**
     * THE CONTROL DR-67 ASKS FOR, carried by the suite rather than planted from
     * outside: a store that writes the customer's name into a cleartext column
     * (`payloadDigest`). The check above MUST fail against it, or it proves
     * nothing about the honest store.
     *
     * It is in-suite for the same reason as `NotAtomic`: a plant has to be
     * proven applied before its result is read, and a control that ships is
     * proven to have run by the suite's own verdict — including in CI, where
     * nobody is there to apply a plant.
     */
    @Test
    fun `a store that leaks a name into a cleartext column fails this very check`() {
        val leaky = aRow().copy(payloadDigest = "sha256:$customerName")
        val leaks = cleartextOf(leaky).filter { (_, value) ->
            value.contains(customerName, ignoreCase = true)
        }
        if (leaks.isEmpty()) {
            fail("the leak probe did not notice a name written into a cleartext column")
        }
        assertEquals(setOf("payloadDigest"), leaks.keys, "the probe named the wrong column")
    }

    private fun aRow(): StoredRow {
        val db = object : Transactional {
            var written: StoredRow? = null
            override fun begin() = Unit
            override fun markSuccessful() = Unit
            override fun end() = Unit
            override fun write(row: StoredRow) {
                written = row
            }
            override fun delete(key: String) = Unit
            override fun read(key: String): StoredRow? = written
            override fun keysByState(state: OperationState): List<String> = emptyList()
        }
        return EncryptedQueueStore(db, Marker())
            .captureWithKey("11111111-2222-4333-8444-555555555555", payload, "sha256:deadbeef")
    }
}
