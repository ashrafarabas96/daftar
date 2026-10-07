package app.daftar.offline

/**
 * Where one captured operation stands.
 *
 * This extends the Phase 0 sync machine
 * (`docs/DAFTAR_STATE_MACHINES.md` §8: `local_pending → syncing → synced`,
 * with `failed → needs_attention`) by the one state that machine lacks and
 * that every real outage produces: UNKNOWN_OUTCOME. Phase 0 offers only
 * `failed`, and calling a lost answer a failure is the bug — it invites a
 * merchant, or a later author, to re-capture a sale the server already holds.
 */
enum class OperationState {
    /** Persisted locally with its key and payload; nothing has been sent. */
    CAPTURED,

    /** Released by the merchant for sending, waiting for its turn or its delay. */
    QUEUED,

    /** An attempt has left the device and no result has been observed yet. */
    IN_FLIGHT,

    /** An attempt returned no usable answer. The server's state is unknown. */
    UNKNOWN_OUTCOME,

    /** The server's truth is established. Terminal. */
    SYNCED,

    /** The server refused in a way no retry can change. A human must act. */
    NEEDS_ATTENTION,

    /** Abandoned before anything was ever sent, or abandoned benign work. Terminal. */
    DISCARDED,
}

/** Something the caller must actually do as a result of a step. */
sealed interface SideEffect {
    /**
     * Send this operation. The key and the digest are carried in the effect
     * rather than read from anywhere else, so the transport has no opportunity
     * to supply its own.
     */
    data class SendAttempt(val idempotencyKey: String, val payloadDigest: String, val attempt: Int) : SideEffect

    /** Raise an operational signal; `code` is for the observability pipeline. */
    data class Alert(val code: String, val law: String) : SideEffect

    /** The local row may now be removed. Emitted only alongside SYNCED (L5). */
    data object ClearLocalRow : SideEffect
}

/** What may happen to an operation. */
sealed interface QueueEvent {
    /** The merchant confirmed the capture and released it for sending. */
    data object Release : QueueEvent

    /** The merchant abandoned it. Legal only before anything was sent. */
    data object CancelByMerchant : QueueEvent

    /**
     * The sender is about to transmit.
     *
     * `digestNow` is what the sender actually has in hand. It is passed in, and
     * compared, because L3 is only worth stating if something checks it: a
     * payload re-serialized at send time — a recomputed total, a re-resolved
     * locale, a clock-derived date — produces a different digest, and the
     * kernel refuses the send rather than letting the server discover the
     * divergence and refuse the key forever.
     */
    data class Send(val digestNow: String) : QueueEvent

    /** A result came back (or conclusively did not). */
    data class Observe(val result: AttemptResult) : QueueEvent

    /**
     * The app died, was killed, or the device rebooted, while this operation
     * was in flight.
     */
    data object ProcessDeath : QueueEvent

    /** A human looked at a NEEDS_ATTENTION operation and chose. */
    data class ResolveByMerchant(val keep: Boolean) : QueueEvent
}

/** The outcome of applying one event. */
sealed interface Step {
    data class Moved(val operation: Operation, val effects: List<SideEffect>) : Step

    /** The event was not legal here. Nothing moved; the reason names a law. */
    data class Refused(val code: String, val law: String) : Step
}

/**
 * One captured operation.
 *
 * The constructor is private and there is no `copy`, which makes L2 and L3
 * STRUCTURAL rather than merely tested: `id` and `payloadDigest` are set by
 * `capture` and there is no code path in this kernel, correct or incorrect,
 * that can produce an `Operation` with the same identity and a different key
 * or digest. A law that only a test defends is a law that survives until
 * someone deletes the test; this one survives because saying it differently
 * does not compile.
 *
 * `capture` is also the only place a key is minted, and it takes the key as an
 * argument rather than generating one, so the caller is forced to mint it in
 * the same local transaction that persists the row. A kernel that generated
 * the key itself would make "minted at capture" depend on being CALLED at
 * capture, which is not a property of the kernel at all.
 */
class Operation private constructor(
    /** The local operation id, which IS the idempotency key sent to the server. */
    val id: String,
    val effect: EffectClass,
    /** The digest of the payload exactly as it was persisted at capture. */
    val payloadDigest: String,
    val state: OperationState,
    /** How many attempts have left the device. Never decreases. */
    val attempts: Int,
    /** The server's own refusal code, where there was one. */
    val lastCode: String?,
    /** Whether the server reported the effect as already applied. */
    val replayed: Boolean,
) {
    companion object {
        /**
         * Persist an operation. The caller mints `key` and writes the payload
         * in ONE local transaction with this row; a key that exists before the
         * payload, or after it, is not a key minted at capture.
         */
        fun capture(key: String, effect: EffectClass, payloadDigest: String): Operation {
            require(key.length in 8..200 && key.all { it.code in 0x20..0x7e }) {
                "an idempotency key must be 8 to 200 printable ASCII characters, as the merchant API requires"
            }
            require(payloadDigest.isNotEmpty()) { "a captured payload must have a digest" }
            return Operation(key, effect, payloadDigest, OperationState.CAPTURED, 0, null, false)
        }
    }

    private fun moved(
        state: OperationState,
        attempts: Int = this.attempts,
        lastCode: String? = this.lastCode,
        replayed: Boolean = this.replayed,
    ): Operation = Operation(id, effect, payloadDigest, state, attempts, lastCode, replayed)

    val isTerminal: Boolean
        get() = state == OperationState.SYNCED || state == OperationState.DISCARDED

    /** Sendable states: an attempt may be made from here. */
    val isSendable: Boolean
        get() = state == OperationState.QUEUED || state == OperationState.UNKNOWN_OUTCOME

    /**
     * Apply one event.
     *
     * Every refusal cites a law, and nothing moves on a refusal — in
     * particular, a refused `Send` does not consume an attempt, because an
     * attempt that never left the device is not an attempt and counting it
     * would advance the backoff schedule for a failure the server never saw.
     */
    fun step(event: QueueEvent): Step = when (event) {
        is QueueEvent.Release ->
            if (state == OperationState.CAPTURED) {
                Step.Moved(moved(OperationState.QUEUED), emptyList())
            } else {
                Step.Refused("offline.already_released", P7Laws.KEY_MINTED_AT_CAPTURE.id)
            }

        is QueueEvent.CancelByMerchant ->
            // The test is `attempts == 0`, not the state, and the difference is
            // a defect the model check found: QUEUED is reachable AFTER a send,
            // because a 429 returns an in-flight attempt to the queue. Gating
            // on the state would therefore let a merchant cancel — and clear
            // the local row of — a sale the server may already hold, which is
            // the exact silent loss L5 exists to prevent. What matters is
            // whether anything ever left the device, and only the counter
            // knows that.
            if (attempts == 0 && !isTerminal) {
                Step.Moved(moved(OperationState.DISCARDED), listOf(SideEffect.ClearLocalRow))
            } else {
                Step.Refused("offline.cancel_after_send", P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id)
            }

        is QueueEvent.Send ->
            if (!isSendable) {
                Step.Refused("offline.not_sendable", P7Laws.KEY_MINTED_AT_CAPTURE.id)
            } else if (event.digestNow != payloadDigest) {
                // Loud, local, and before the wire: the server would answer
                // this with a permanent key conflict.
                Step.Refused("offline.payload_changed_after_capture", P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id)
            } else {
                Step.Moved(
                    moved(OperationState.IN_FLIGHT, attempts = attempts + 1),
                    listOf(SideEffect.SendAttempt(id, payloadDigest, attempts + 1)),
                )
            }

        is QueueEvent.Observe ->
            if (state != OperationState.IN_FLIGHT) {
                Step.Refused("offline.no_attempt_in_flight", P7Laws.DEVICE_NOT_AUTHORITY.id)
            } else {
                when (val decision = Outcome.classify(event.result, id, attempts)) {
                    is Decision.Synced -> Step.Moved(
                        moved(OperationState.SYNCED, replayed = decision.replayed, lastCode = null),
                        listOf(SideEffect.ClearLocalRow),
                    )

                    is Decision.Retry -> Step.Moved(moved(OperationState.QUEUED), emptyList())

                    is Decision.ResolveByReplay ->
                        Step.Moved(moved(OperationState.UNKNOWN_OUTCOME), emptyList())

                    is Decision.NeedsAttention -> Step.Moved(
                        moved(OperationState.NEEDS_ATTENTION, lastCode = decision.code),
                        // A divergence is a device defect, not a merchant
                        // problem, so it alerts as well as waiting.
                        if (decision.diverged) {
                            listOf(SideEffect.Alert(decision.code, decision.law))
                        } else {
                            emptyList()
                        },
                    )
                }
            }

        is QueueEvent.ProcessDeath ->
            if (state == OperationState.IN_FLIGHT) {
                // The attempt is spent and its answer is gone. UNKNOWN, not failed.
                Step.Moved(moved(OperationState.UNKNOWN_OUTCOME), emptyList())
            } else {
                // Every other state is already durable; a crash changes nothing.
                Step.Moved(this, emptyList())
            }

        is QueueEvent.ResolveByMerchant ->
            if (state != OperationState.NEEDS_ATTENTION) {
                Step.Refused("offline.nothing_to_resolve", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)
            } else if (event.keep && Outcome.isDivergence(lastCode)) {
                // A reused key with a different payload is a device defect. The
                // server will refuse it identically forever, so offering the
                // merchant a retry would be offering them a button that cannot
                // work; this needs a developer, and says so.
                Step.Refused("offline.divergence_needs_a_fix", P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id)
            } else if (event.keep) {
                // Try the SAME operation again — same key, same payload. A
                // stated refusal means the server committed nothing, so this
                // goes back to QUEUED rather than to UNKNOWN_OUTCOME: calling
                // a definitively refused operation "unknown" would be the
                // device misreporting an answer it actually received. What the
                // merchant changed is a condition on the server's side — paid
                // the balance, counted the stock — never the operation.
                Step.Moved(moved(OperationState.QUEUED), emptyList())
            } else if (effect.isMaterial) {
                // Abandoning a financial or stock operation that the server
                // may hold is not a decision the device may record.
                Step.Refused("offline.material_cannot_be_abandoned", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)
            } else {
                Step.Moved(moved(OperationState.DISCARDED), listOf(SideEffect.ClearLocalRow))
            }
    }

    override fun toString(): String =
        "Operation(id=$id, effect=$effect, state=$state, attempts=$attempts, lastCode=$lastCode, replayed=$replayed)"
}
