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
 * for money or stock — together with the eighteen laws it implies once the LIVE
 * server contract is read rather than assumed and the Tech Lead's rulings on
 * effect classification (§34) and local data security (PART 40) are applied.
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

    /**
     * The Tech Lead's directive PART 40 — local data security — which requires,
     * before promotion, that the queue be scoped by tenant, business and member
     * and that an account switch cannot replay another account's entries.
     */
    val QUEUE_SCOPED_BY_OWNER = OfflineLaw(
        "P7-L12-QUEUE-ROW-CARRIES-ITS-OWNER",
        "Every captured operation records the tenant, business and member it was captured under as part of the row itself, never as ambient session state, so the row's owner survives a sign-out, an account switch, a process death and a reinstall-time restore.",
    )

    val NO_CROSS_ACCOUNT_SEND = OfflineLaw(
        "P7-L13-NO-SEND-UNDER-A-SCOPE-IT-WAS-NOT-CAPTURED-UNDER",
        "An attempt is made only under the exact scope the operation was captured under: the sender states the scope it holds, a mismatch is refused rather than adapted, and no signed-in session may send, cancel or resolve another account's captured entries.",
    )

    val UNKNOWN_QUEUE_SCHEMA_REFUSED = OfflineLaw(
        "P7-L14-AN-UNREADABLE-QUEUE-ROW-IS-REFUSED",
        "A persisted queue row carries the schema version it was written under, and a build that does not understand that version refuses the row and leaves it on disk rather than reinterpreting its fields under the current meanings.",
    )

    /**
     * The continuous-mission directive §14: after a device wipe or reinstall an
     * `UNKNOWN_OUTCOME` must be matched against the canonical receipt, and
     * there is no re-entry under a new key before the original is settled.
     *
     * This is the hole L2 and L7 cannot reach: both assume the row still
     * exists, and a wipe removes it. What follows is not a retry but a new
     * capture under a new key, which the server has never seen and will
     * therefore commit a second time.
     */
    val NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED = OfflineLaw(
        "P7-L15-NO-REENTRY-UNDER-A-NEW-KEY-BEFORE-THE-ORIGINAL-IS-SETTLED",
        "An operation whose earlier outcome was never established may be re-entered under a new key only once the canonical receipt has settled the original; a receipt that cannot be read settles nothing and the re-entry is refused, because permitting it wrongly charges twice under a key no later reconciliation can match.",
    )

    /**
     * The same directive's ruling on retention, which REPLACED the default I
     * had proposed: "منع التقاط جديد لا يثبت مدة احتفاظ محدودة؛ تحتاج انتهاءً
     * ووصولًا وتصعيدًا، مع عدم إسقاط العمليات المالية صامتًا وحماية PII" —
     * blocking new capture does not prove bounded retention; expiry, reach and
     * escalation are required, with no silent drop of financial operations and
     * with personal data protected.
     *
     * The two halves pull in opposite directions and that is the whole
     * difficulty: retention must be bounded, and a material operation may not
     * be dropped. They are reconciled by bounding the PAYLOAD rather than the
     * OPERATION — the personal and price data is minimized on expiry while the
     * operation's identity, its amount and the server's refusal code are kept,
     * and the obligation is escalated off the till rather than deleted.
     */
    val EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION = OfflineLaw(
        "P7-L16-EXPIRY-MINIMIZES-THE-PAYLOAD-NEVER-THE-OBLIGATION",
        "Retention is bounded by minimizing the stored payload and escalating the obligation, never by discarding it: on expiry a waiting operation's personal and price data is reduced while its identity, amount and server refusal code are retained, the local row is not cleared, and a material operation is never silently dropped.",
    )

    /**
     * Master Continuous Mission **V2** §14, which corrected the L15 I wrote
     * last round: "نتيجة ABSENT لمجرد عدم وجود صف الآن لا تثبت انتهاء طلب قديم
     * ما زال in-flight؛ نفذ settled absence/fencing أو إعادة الأمر بالمفتاح
     * نفسه حسب العقد، وأثبت سباق lookup مع late commit حتى لا تُنشأ عمليتان."
     *
     * L15 treated a bare ABSENT as settling the original, and that is a race.
     * The lookup answers a question about an INSTANT; the original request may
     * still be in flight somewhere between the device, the proxy and the
     * server, and may commit a second after the device was told there was
     * nothing there. The device then holds a permission that was true when it
     * was granted and false when it was used, and the second commit lands
     * under a key no reconciliation can pair with the first.
     *
     * An absence settles the original only if the original can no longer
     * arrive — that is what FENCING means, and it is a property of the server,
     * not of the answer's wording.
     */
    val AN_UNFENCED_ABSENCE_SETTLES_NOTHING = OfflineLaw(
        "P7-L17-AN-UNFENCED-ABSENCE-SETTLES-NOTHING",
        "A report that no operation exists for a key states a fact about the instant it was asked and does not establish that an in-flight original has ended, so a new key may follow an absence only where the original key is fenced against a later arrival; an unfenced absence is refused exactly as an unreadable receipt is.",
    )

    /**
     * The positive half of the same ruling — "أو إعادة الأمر بالمفتاح نفسه" —
     * and the better half, because it needs nothing from the server that the
     * server does not already do.
     *
     * Resending the ORIGINAL key is safe under every possible answer,
     * including no answer at all: `deriveSourceId(business, key)` makes the
     * ledger's own `(business, source_type, source_id)` uniqueness decide it.
     * If the original committed, the resend returns the stored truth with
     * `replayed: true` and writes nothing; if it did not, it commits exactly
     * once. So where the original key AND its frozen bytes can be recovered,
     * the race does not need to be won — it does not exist, and no receipt
     * lookup and no fence are required.
     *
     * This is why provenance is worth engineering: recovering the original
     * identity is not a convenience, it is the one resolution that is proven
     * against the LIVE contract. Fencing, by contrast, is a server capability
     * that does not exist yet and is carried as SPEC ONLY.
     */
    val THE_ORIGINAL_KEY_OUTRANKS_A_NEW_ONE = OfflineLaw(
        "P7-L18-THE-ORIGINAL-KEY-OUTRANKS-A-NEW-ONE",
        "Where an operation's original key and the exact bytes frozen with it can be recovered, the operation is resent under that key and never re-entered under a new one, because the server's own source uniqueness settles a resend with no receipt lookup, no fence and no possibility of a second commit.",
    )

    /**
     * The independent challenger's finding F-01 against `162b2c8`, which is
     * correct and which no law here reached.
     *
     * `decideReentry` was proven total over its inputs, and nothing specified
     * who SUPPLIES them. Two of the four prior outcomes permitted a new key
     * without consulting the receipt at all — `NONE` and `NEVER_SENT` — and
     * both are sound only given a true classification. The only observation
     * site for either is the local store, and a wipe destroys exactly that
     * store. So a wiped device, asked "is there an earlier operation for this
     * intent?", looks in the one place it has, finds nothing, and honestly
     * answers `NONE`. The gate then permits a new key over a sale the server
     * already holds. **Every law held and the customer was charged twice.**
     *
     * The hole was not in any arm. It was that an absence of evidence was
     * allowed to present itself as evidence of absence, which is the same
     * defect as L17 one level further out: there, an absent receipt did not
     * settle an in-flight original; here, an empty store does not establish
     * that nothing was ever captured.
     *
     * So the store must vouch for itself before its silence counts, exactly
     * as L11 made an unclassified command refuse rather than default to
     * benign. An install that cannot tell "nothing was captured" from
     * "whatever was captured is gone" says so, and what it says is never read
     * as absence.
     */
    val AN_UNVOUCHED_STORE_CANNOT_REPORT_ABSENCE = OfflineLaw(
        "P7-L19-AN-UNVOUCHED-STORE-CANNOT-REPORT-ABSENCE",
        "A local store's silence counts as \"nothing was ever captured\" only where the install can prove it is the one that would have held the row, and a row that store holds counts as current only on the same proof; an install that cannot distinguish an empty store from a destroyed one, or a current row from a restored one, reports its prior state as undetermined, and an undetermined prior state is never read as an absence and never permits a new key for a material operation.",
    )

    /**
     * Challenger findings H-01 and I-04, and the one rule the H-01 exit
     * created that no law stated.
     *
     * Letting a second member abandon a capture nobody released was the right
     * unlock — it is the recoverable one, and the alternative let any member
     * commit a sale nobody can be shown to have witnessed. But it introduced
     * an actor the row has no field for, acting on a row that is erased in the
     * same step, and `Scope.kt`'s own justification for storing the member at
     * all is that an audit of "who captured this" has no other source once the
     * row is the only record. That argument transfers to the second actor
     * whole, and it transfers to WHAT was destroyed with equal force: a record
     * naming two members and a key can establish that Bob abandoned something
     * of Alice's and can never establish that it was a sale she had taken cash
     * for.
     *
     * So the record is part of the act, not a report about it: it carries the
     * actor, the capture's digest, its effect class and, where the capture
     * moves money, what it was worth — and on the path that erases the row it
     * IS the permission to erase, one value, because an obligation stated in
     * prose gives a caller nothing to be held to (J-04). Until Phase 4's
     * authority model exposes a role (OD-P7-08), this record is the only thing
     * standing between a shared till and an unexplainable gap; and since no
     * owner holds its storage yet, that is an intention and not yet a
     * mechanism.
     *
     * Two corrections from the fifth review are in the statement rather than
     * only in the code. **J-02**: an inventory operation has a quantity and a
     * unit and no currency at all, so requiring an amount in minor units of it
     * made a fabricated currency the price of storing a stocktake; the
     * description of an inventory capture is its digest and its effect class,
     * and whether such a record should carry a quantity and a unit of its own
     * is OD-P7-09. **J-01**: the second clause used to be scoped to a foreign
     * session's move, and there is no reason a law about telling a merchant
     * the truth should depend on who is holding the till — the invariant that
     * enforces it never looked at the scope, so the law no longer does either.
     * What makes a wait honest is that something is pending on the device, not
     * that nothing has been sent: a released row waiting its turn is genuinely
     * waiting, and a row the server has refused is waiting on the person
     * reading the message.
     */
    val A_DESTRUCTION_IS_RECORDED_BEFORE_IT_HAPPENS = OfflineLaw(
        "P7-L20-A-DESTRUCTION-IS-RECORDED-BEFORE-IT-HAPPENS",
        "A session that is not the one a row was captured under moves that row only with a record of who acted, what the capture was and — where the capture moves money — what it was worth; the permission to erase such a row is that same record, so it cannot be held without it, and a capture destroyed on a shared till can still be described afterwards. And no refusal tells the merchant that something is in progress, or to wait for it, unless something is genuinely pending on the device.",
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
        QUEUE_SCOPED_BY_OWNER,
        NO_CROSS_ACCOUNT_SEND,
        UNKNOWN_QUEUE_SCHEMA_REFUSED,
        NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED,
        EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION,
        AN_UNFENCED_ABSENCE_SETTLES_NOTHING,
        THE_ORIGINAL_KEY_OUTRANKS_A_NEW_ONE,
        AN_UNVOUCHED_STORE_CANNOT_REPORT_ABSENCE,
        A_DESTRUCTION_IS_RECORDED_BEFORE_IT_HAPPENS,
    )
}
