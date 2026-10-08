package app.daftar.offline

/**
 * P7-S0 — the Phase 7 offline laws, as VALUES.
 *
 * Every refusal this kernel produces cites the id of the law it enforces, and
 * every law stated here is asserted by a test that names it. A law stated only
 * in a comment is evidence of nothing: it cannot be asserted, it cannot be
 * counted, and it cannot turn red when the code stops honouring it. So the
 * statement lives here, the code cites it, and `LawsTest` proves that the set
 * of stated laws and the set of laws the kernel can actually cite are the same
 * set — in both directions.
 *
 * Status: PREPARED / NOT PROMOTED. Nothing in this directory is canonical, is
 * compiled by the Android application build, is wired into required CI, or
 * allocates a migration number.
 */
data class OfflineLaw(
    /** Stable id, cited by refusals and by tests. */
    val id: String,
    /** What the law requires or forbids, in one sentence. */
    val statement: String,
)

/**
 * The absolute law of the Tech Lead's directive — an offline device is never
 * canonical financial authority, and there is no silent conflict resolution
 * for money or stock — together with the nine laws it implies once the LIVE
 * server contract is read rather than assumed.
 *
 * The live contract that shapes these: the merchant API derives a command's
 * source identity from `(business, Idempotency-Key)`
 * (`packages/accounting/src/sources.ts` `deriveSourceId`), so transport
 * idempotency IS the ledger's own `(business, source_type, source_id)`
 * uniqueness with no second store; a second send of the same key with the
 * same payload returns the stored truth with `replayed: true` and HTTP 200
 * and writes nothing; and a same-key-different-payload send is REFUSED
 * (`IDEMPOTENCY_KEY_REUSED`, `apps/api/src/modules/tenancy/tenancy.service.ts`)
 * rather than reshaping stored truth to match the newer request.
 *
 * An offline queue is therefore replay-safe exactly to the degree that its key
 * and its payload are both frozen at capture. L2 and L3 are not hygiene; they
 * are the whole of the safety argument.
 */
object P7Laws {
    /** The directive, verbatim in substance. */
    val DEVICE_NOT_AUTHORITY = OfflineLaw(
        "P7-L1-DEVICE-IS-NOT-AUTHORITY",
        "A device may capture intent; only a server commit creates financial or inventory truth, so no local state may be presented or treated as a completed material effect without a server-confirmed outcome.",
    )

    val KEY_MINTED_AT_CAPTURE = OfflineLaw(
        "P7-L2-KEY-MINTED-AT-CAPTURE-AND-IMMUTABLE",
        "An operation mints exactly one idempotency key, in the same local transaction that persists its payload, before its first attempt; every later attempt sends that same key, and no retry, process death, token refresh or edit may re-mint it.",
    )

    val PAYLOAD_FROZEN_AT_CAPTURE = OfflineLaw(
        "P7-L3-PAYLOAD-FROZEN-AT-CAPTURE",
        "The bytes sent are the bytes stored at capture: no field is recomputed at send time, and a payload whose digest no longer matches the one recorded at capture is refused locally and loudly rather than sent under the original key.",
    )

    val NO_SILENT_MATERIAL_RESOLUTION = OfflineLaw(
        "P7-L4-NO-SILENT-RESOLUTION-OF-A-MATERIAL-CONFLICT",
        "A refusal of a financial or inventory command is never resolved by the device: it is never retried with an altered payload, never dropped, never dead-lettered and never answered with a local fallback — it waits, with the server refusal code preserved, for a human.",
    )

    val NO_LOCAL_DELETE_BEFORE_CONFIRMED = OfflineLaw(
        "P7-L5-NO-LOCAL-DELETE-BEFORE-A-CONFIRMED-OUTCOME",
        "A local operation row is removable only after a server-confirmed terminal outcome; a merchant cancel is permitted only before the first attempt, and never once an attempt has left the device.",
    )

    val REPLAY_IS_SUCCESS = OfflineLaw(
        "P7-L6-A-REPLAY-IS-A-SUCCESS",
        "An outcome of \"already applied\" is a success with the same effect as \"applied now\": a replayed response syncs the operation, and the device never treats it as a duplicate to be undone, reversed or re-sent.",
    )

    val LOST_RESPONSE_RESOLVES_BY_REPLAY = OfflineLaw(
        "P7-L7-A-LOST-RESPONSE-RESOLVES-ONLY-BY-REPLAY",
        "A lost answer leaves the outcome unknown, never failed: the only resolution is resending the same key and reading the server's own answer, and the operation may be shown neither as failed nor as done while it is unknown.",
    )

    val DEVICE_CLOCK_NOT_AUTHORITY = OfflineLaw(
        "P7-L8-THE-DEVICE-CLOCK-IS-NOT-AUTHORITY",
        "A business date or `asOf` is the value the merchant chose at capture, carried unchanged; the device clock may order the local queue and schedule retries, and may decide nothing else.",
    )

    val READ_CACHE_IS_A_PROJECTION = OfflineLaw(
        "P7-L9-A-READ-CACHE-IS-REPLACED-NOT-MERGED",
        "A local read cache is a projection of server truth and holds no authority, so a server read replaces it silently and entirely; it is never merged, never reconciled field by field and never wins a disagreement.",
    )

    /**
     * The Tech Lead's ruling of 2026-10-08 (§34): classification belongs beside
     * each domain's command definition, Phase 7 invents none, and an unknown
     * command effect refuses rather than defaulting.
     */
    val NO_DEFAULT_EFFECT_CLASS = OfflineLaw(
        "P7-L11-NO-DEFAULT-EFFECT-CLASS",
        "A command's effect class is declared by its own domain owner and is never defaulted or inferred; an unclassified command has no classification to pass at the call site and refuses by name at run time, and is never treated as benign.",
    )

    val NO_LAST_WRITE_WINS_ON_MATERIAL_STATE = OfflineLaw(
        "P7-L10-NO-LAST-WRITE-WINS-ON-MATERIAL-STATE",
        "Timestamp ordering, vector clocks, last-write-wins and every other automatic merge are forbidden for financial and inventory state in both directions; an automatic strategy is legitimate only for a read projection, which has no authority to lose.",
    )

    /** Every stated law, for the completeness proof. */
    val ALL: List<OfflineLaw> = listOf(
        DEVICE_NOT_AUTHORITY,
        KEY_MINTED_AT_CAPTURE,
        PAYLOAD_FROZEN_AT_CAPTURE,
        NO_SILENT_MATERIAL_RESOLUTION,
        NO_LOCAL_DELETE_BEFORE_CONFIRMED,
        REPLAY_IS_SUCCESS,
        LOST_RESPONSE_RESOLVES_BY_REPLAY,
        DEVICE_CLOCK_NOT_AUTHORITY,
        READ_CACHE_IS_A_PROJECTION,
        NO_LAST_WRITE_WINS_ON_MATERIAL_STATE,
        NO_DEFAULT_EFFECT_CLASS,
    )
}
