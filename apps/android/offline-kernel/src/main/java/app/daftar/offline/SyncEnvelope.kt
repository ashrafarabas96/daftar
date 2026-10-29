package app.daftar.offline

/**
 * P7-03 — the sync envelope, replay suppression, and immunity to the device
 * clock.
 *
 * THE SERVER CONTRACT THIS IS WRITTEN AGAINST WAS MEASURED, NOT ASSUMED.
 * `apps/api/src/modules/inventory/inventory-movements.controller.ts` answers
 * `res.status(result.replayed ? 200 : 201)` at five sites and carries
 * `replayed` in the body. The services compare a stored `intentSha256` against
 * the one just built and raise `inventory.idempotency_conflict` when they
 * differ (`inventory-transfer.service.ts:88`,
 * `inventory-adjustment.service.ts:156`, `inventory-opening.service.ts:132`,
 * `inventory-stocktake.service.ts:197`), and
 * `apps/api/src/common/error.filter.ts:209` puts that code in the 409 set.
 *
 * So the three answers are 201, 200 and 409 — and the FIRST of ten identical
 * sends is a 201 while the other nine are 200s. Any client written to expect
 * "ten identical responses" would have to break that contract to pass, which
 * is why it is spelled out here: the nine 200s match the 201 field for field
 * EXCEPT `replayed`, and [Replay.sameTruth] is what checks it.
 *
 * WHAT THE ENVELOPE DOES NOT CARRY, AND WHY THAT IS THE POINT. There is no
 * device clock in it. Not a `sentAt`, not a `capturedAt`, not a timestamp under
 * another name. A device clock is attacker-controlled and merchant-controlled
 * — a phone's date can be moved by a year with two taps — so if any amount,
 * any ordering or any aging bucket were derived from it, moving the clock would
 * move money. The server timestamps its own truth; the device's only clock use
 * is the local retry schedule in `Backoff.kt`, which is never sent and decides
 * nothing but when to try again.
 *
 * `tests-unit/p7-03-sync-envelope.test.ts` enforces that absence statically,
 * with a positive control proving the probe finds a clock field when one is
 * there, and [SyncEnvelopeTest] advances a clock by a year and asserts no
 * amount anywhere moves.
 */

/** The schema version of the envelope itself, negotiated with the server. */
const ENVELOPE_VERSION: Int = 1

/**
 * What leaves the device. Every field is frozen at capture and re-sent
 * byte-identically on every later attempt (L2): the key is minted once, and the
 * intent digest is computed once over the payload as captured.
 *
 * [intentSha256] is the whole of replay suppression on the server side. A
 * retry carrying the same key and the same digest is a replay and returns the
 * stored truth; a retry carrying the same key and a DIFFERENT digest is a
 * different intent wearing an old key, and the server refuses it rather than
 * guessing which one the merchant meant.
 */
data class SyncEnvelope(
    /** The client-minted document id, which IS the idempotency key. */
    val idempotencyKey: String,
    /** The envelope schema this device speaks. */
    val envelopeVersion: Int,
    /** The queue-row schema the payload was persisted under (L13). */
    val payloadSchemaVersion: Int,
    /** sha256 over the payload exactly as captured, frozen with it. */
    val intentSha256: String,
    /** The captured intent. Never rebuilt from current state on a retry. */
    val payload: Map<String, String>,
) {
    init {
        require(idempotencyKey.isNotBlank()) { "an envelope without a key cannot be replayed safely" }
        require(intentSha256.isNotBlank()) { "an envelope without an intent digest cannot be refused on conflict" }
    }
}

/**
 * The server's answer, as the three statuses the contract actually produces.
 * Modelled as a closed set so that a status nobody planned for cannot be read
 * as a success by default.
 */
sealed interface ServerAnswer {
    /** 201: this send created the truth. `replayed` is false in the body. */
    data class Created(val body: Map<String, String>) : ServerAnswer

    /** 200: the truth already existed. `replayed` is true in the body. */
    data class Replayed(val body: Map<String, String>) : ServerAnswer

    /**
     * 409 `inventory.idempotency_conflict`: the key is known and the intent is
     * not the stored one. A human must act; no retry can change it, and the key
     * is NEVER re-minted (L2).
     */
    data class Conflict(val code: String) : ServerAnswer

    /** Anything else: no usable answer, so the outcome is unknown (L1). */
    data class NoUsableAnswer(val detail: String) : ServerAnswer
}

/** The code the server uses for a replayed key carrying a different intent. */
const val IDEMPOTENCY_CONFLICT: String = "inventory.idempotency_conflict"

/** The body field the contract carries alongside the status. */
const val REPLAYED_FIELD: String = "replayed"

object Replay {
    /**
     * Read an HTTP status and body as one of the three answers.
     *
     * The status and the body field must AGREE. A 200 whose body says
     * `replayed: false`, or a 201 whose body says `replayed: true`, is a server
     * that has changed its contract under us, and treating either as a success
     * would mean reporting a sale as new when it was a replay, or as a replay
     * when it was new. Both are refused as unusable rather than resolved in
     * favour of one half.
     */
    fun read(status: Int, body: Map<String, String>): ServerAnswer {
        val replayed = body[REPLAYED_FIELD]
        return when (status) {
            201 ->
                if (replayed == "false") {
                    ServerAnswer.Created(body)
                } else {
                    ServerAnswer.NoUsableAnswer("201 with $REPLAYED_FIELD=$replayed")
                }

            200 ->
                if (replayed == "true") {
                    ServerAnswer.Replayed(body)
                } else {
                    ServerAnswer.NoUsableAnswer("200 with $REPLAYED_FIELD=$replayed")
                }

            409 ->
                if (body["code"] == IDEMPOTENCY_CONFLICT) {
                    ServerAnswer.Conflict(IDEMPOTENCY_CONFLICT)
                } else {
                    ServerAnswer.NoUsableAnswer("409 ${body["code"]}")
                }

            else -> ServerAnswer.NoUsableAnswer("status $status")
        }
    }

    /**
     * Whether a replay's body carries the SAME truth as the creating answer:
     * every field equal except [REPLAYED_FIELD], and the same field NAMES on
     * both sides.
     *
     * Comparing only the fields the replay happens to carry would pass a
     * response that had dropped half of them, so the key sets are compared too.
     */
    fun sameTruth(created: Map<String, String>, replayed: Map<String, String>): Boolean {
        if (created.keys != replayed.keys) return false
        return created.keys.filter { it != REPLAYED_FIELD }.all { created[it] == replayed[it] }
    }

    /**
     * The only safe thing to do with a conflict: stop. The key is not re-minted
     * and the payload is not rebuilt — either would turn one refused intent into
     * two accepted ones.
     */
    fun afterConflict(): OperationState = OperationState.NEEDS_ATTENTION
}

/**
 * Backward compatibility, in BOTH directions, which is one requirement and not
 * two.
 *
 * FORWARD (an older device talking to a newer server): the server may add
 * fields to a response. An old client must ignore what it does not know rather
 * than refusing — a refusal here would strand a committed sale on the device
 * because the server learned a new field. [readKnownFields] drops the unknown
 * ones and keeps the truth.
 *
 * BACKWARD (a newer device talking to an older server): the device may not make
 * a new field REQUIRED, because the old server will not echo it and the old
 * server's stored `intentSha256` was computed without it. [Compatibility.accepts]
 * states the rule the envelope must satisfy: the fields an older server needs
 * are a subset of what a newer device sends, and a newer device adds nothing the
 * digest depends on.
 */
object Compatibility {
    /** The response fields every version of this contract carries. */
    val KNOWN_RESPONSE_FIELDS: Set<String> = setOf(REPLAYED_FIELD, "documentId", "totalValueBaseMinor")

    fun readKnownFields(body: Map<String, String>): Map<String, String> =
        body.filterKeys { it in KNOWN_RESPONSE_FIELDS }

    /**
     * Whether a peer's answer is usable. Compatibility is carried by the FIELD
     * SET, not by the version number, and that is the whole design.
     *
     * Refusing on the NUMBER alone breaks forward compatibility: an older
     * device would strand a committed sale because the server learned a field
     * it does not need. Accepting on the number alone breaks the other way: a
     * response that had dropped `replayed` would be read as a success. So any
     * real version is tolerated, and every field in [KNOWN_RESPONSE_FIELDS]
     * must be present.
     *
     * This is deliberately NOT L13's rule. L13 refuses a PERSISTED ROW written
     * under an unknown schema, because reinterpreting stored fields under new
     * meanings silently changes what the merchant captured. A response is read
     * once and never stored under the wrong meaning, so the same strictness
     * there would cost availability and buy nothing.
     */
    fun accepts(theirVersion: Int, body: Map<String, String>): Boolean =
        theirVersion >= 1 && KNOWN_RESPONSE_FIELDS.all { it in body.keys }

    fun current(): Int = ENVELOPE_VERSION
}
