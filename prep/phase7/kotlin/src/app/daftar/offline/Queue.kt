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
     * Send this operation. The key, the digest **and the scope** are carried
     * in the effect rather than read from anywhere else, so the transport has
     * no opportunity to supply its own.
     *
     * Challenger finding F-02: the scope was missing, and the reasoning that
     * put the key here applies to it with more force. The gate in `step`
     * refuses a sender that ASSERTS the wrong scope, but an effect is
     * performed later, from a coroutine or a WorkManager job, and the live
     * `ApiClient` builds `X-Business-Id` from mutable client state at send
     * time. An account switch between the gate and the send therefore
     * produces a request carrying business B with A's key — both halves
     * internally consistent, answered 201, and `deriveSourceId(business,
     * key)` writes A's sale into B's ledger with nothing able to detect it.
     *
     * Carrying the scope makes the fix structural instead of a sentence in a
     * patch request owed to another owner: an implementer who wires this
     * effect faithfully cannot read the business from anywhere else, because
     * the effect already names it.
     */
    data class SendAttempt(
        val idempotencyKey: String,
        val payloadDigest: String,
        val attempt: Int,
        /** The tenant, business and member the row was captured under (L12/L13). */
        val scope: OwnerScope,
    ) : SideEffect

    /** Raise an operational signal; `code` is for the observability pipeline. */
    data class Alert(val code: String, val law: String) : SideEffect

    /** The local row may now be removed. Emitted only alongside SYNCED (L5). */
    data object ClearLocalRow : SideEffect

    /**
     * Reduce what is stored for this operation to the minimum that keeps the
     * obligation legible: its identity, its amount and the server's refusal
     * code. The personal and price detail of the payload goes.
     *
     * This is NOT a delete, and the distinction is the whole of L16. The row
     * survives, the operation is still owed, and `ClearLocalRow` is never
     * emitted with it — the model check asserts exactly that, because the
     * tempting implementation of "bounded retention" is to drop the row, which
     * is the silent loss of money L4 and L5 forbid.
     */
    data class MinimizePayload(val reason: String, val law: String) : SideEffect
}

/**
 * What may happen to an operation.
 *
 * Every event a signed-in human or session originates carries the scope it is
 * acting under, and `step` refuses any of them whose scope is not the row's
 * own (L13). `Observe` and `ProcessDeath` do not, because neither originates
 * with a session: one is the server's answer to an attempt this row already
 * made, the other is the operating system. Asking the kernel to authorize a
 * process death would be theatre, and would create a path on which a crash
 * could be "refused".
 */
sealed interface QueueEvent {
    /** An event a signed-in session originates, and must therefore be entitled to. */
    sealed interface ByScope : QueueEvent {
        val actingScope: OwnerScope
    }

    /** The merchant confirmed the capture and released it for sending. */
    data class Release(override val actingScope: OwnerScope) : ByScope

    /** The merchant abandoned it. Legal only before anything was sent. */
    data class CancelByMerchant(override val actingScope: OwnerScope) : ByScope

    /**
     * The sender is about to transmit.
     *
     * `digestNow` is what the sender actually has in hand. It is passed in, and
     * compared, because L3 is only worth stating if something checks it: a
     * payload re-serialized at send time — a recomputed total, a re-resolved
     * locale, a clock-derived date — produces a different digest, and the
     * kernel refuses the send rather than letting the server discover the
     * divergence and refuse the key forever.
     *
     * `actingScope` is the scope the signed-in session actually holds, and it
     * is a required argument for the same reason the digest is: L13 is only
     * worth stating if something checks it. A sender that has switched account
     * cannot omit it and inherit the row's own scope, because there is no
     * overload that lets it.
     */
    data class Send(val digestNow: String, override val actingScope: OwnerScope) : ByScope

    /** A result came back (or conclusively did not). */
    data class Observe(val result: AttemptResult) : QueueEvent

    /**
     * The app died, was killed, or the device rebooted, while this operation
     * was in flight.
     */
    data object ProcessDeath : QueueEvent

    /** A human looked at a NEEDS_ATTENTION operation and chose. */
    data class ResolveByMerchant(val keep: Boolean, override val actingScope: OwnerScope) : ByScope

    /**
     * The retention window for a waiting operation has run out.
     *
     * Not a `ByScope` event: it originates with a clock, not a session, and
     * there is nobody to authorize it. That is consistent with L8 — the device
     * clock may order the queue and schedule retries, and here it schedules a
     * data-minimization. It decides nothing financial: the obligation is
     * untouched, and only what is STORED about it shrinks.
     */
    data object RetentionDeadlineReached : QueueEvent

    /**
     * The approved payload has been fetched back from wherever policy keeps it,
     * so a minimized operation can be settled under its ORIGINAL key.
     *
     * `digestNow` is compared against the digest frozen at capture, so a
     * restore that produces different bytes is refused rather than sent: a
     * restored payload that is not byte-identical is not the payload this key
     * is bound to, and the server would refuse the key forever.
     */
    data class RestorePayload(
        val digestNow: String,
        override val actingScope: OwnerScope,
    ) : ByScope
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
    /** The tenant, business and member this row was captured under (L12). */
    val scope: OwnerScope,
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
    /** The row layout this operation was written under (L14). */
    val schemaVersion: Int = QueueSchema.CURRENT,
    /**
     * Whether the stored payload has been reduced by a retention expiry (L16).
     *
     * This flag exists because the first version of L16 created a defect: an
     * expired row could be sent back to QUEUED by a merchant resolve, and then
     * the sender had no payload to send. It would either send different bytes
     * under the original key — burning that key permanently — or be unable to
     * produce a digest at all, leaving a material operation that can never be
     * settled. Minimizing storage must not make settlement impossible.
     */
    val payloadMinimized: Boolean = false,
) {
    companion object {
        /**
         * Persist an operation. The caller mints `key` and writes the payload
         * in ONE local transaction with this row; a key that exists before the
         * payload, or after it, is not a key minted at capture.
         */
        fun capture(
            key: String,
            scope: OwnerScope,
            effect: EffectClass,
            payloadDigest: String,
        ): Operation {
            require(key.length in 8..200 && key.all { it.code in 0x20..0x7e }) {
                "an idempotency key must be 8 to 200 printable ASCII characters, as the merchant API requires"
            }
            require(payloadDigest.isNotEmpty()) { "a captured payload must have a digest" }
            return Operation(key, scope, effect, payloadDigest, OperationState.CAPTURED, 0, null, false)
        }
    }

    private fun moved(
        state: OperationState,
        attempts: Int = this.attempts,
        lastCode: String? = this.lastCode,
        replayed: Boolean = this.replayed,
    ): Operation = Operation(
        id, scope, effect, payloadDigest, state, attempts, lastCode, replayed, schemaVersion, payloadMinimized,
    )

    private fun withPayloadMinimized(minimized: Boolean): Operation = Operation(
        id, scope, effect, payloadDigest, state, attempts, lastCode, replayed, schemaVersion, minimized,
    )

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
    fun step(event: QueueEvent): Step {
        // ONE gate, ahead of every arm, rather than a check repeated inside
        // each one. L13 is about every session-originated event, so a
        // per-arm test would be a law restated four times, and the fifth arm
        // added later is the one that would omit it.
        //
        // What the gate COMPARES is decided in one place too, by `mayAct`,
        // for challenger finding F-05: comparing the whole triple on a SEND
        // stranded a shift change. Alice captures offline, her shift ends and
        // her session is revoked as PART 40 requires, Bob signs in — and the
        // row is then unsendable, uncancellable and unminimizable, while L4
        // and L5 forbid dropping it. A permanently closed state is not
        // fail-closed, it is a lost sale.
        if (event is QueueEvent.ByScope && !event.actingScope.mayAct(scope, event)) {
            return Step.Refused("offline.scope_switched", P7Laws.NO_CROSS_ACCOUNT_SEND.id)
        }
        return stepWithinScope(event)
    }

    private fun stepWithinScope(event: QueueEvent): Step = when (event) {
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
                    listOf(SideEffect.SendAttempt(id, payloadDigest, attempts + 1, scope)),
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

        is QueueEvent.RestorePayload ->
            if (!payloadMinimized) {
                Step.Refused(
                    "offline.payload_was_never_minimized",
                    P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id,
                )
            } else if (event.digestNow != payloadDigest) {
                Step.Refused(
                    "offline.restored_payload_does_not_match_capture",
                    P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id,
                )
            } else {
                // Nothing else moves: same state, same key, same digest. The
                // row is simply storable-and-sendable again.
                Step.Moved(withPayloadMinimized(false), emptyList())
            }

        is QueueEvent.RetentionDeadlineReached ->
            if (state != OperationState.NEEDS_ATTENTION) {
                // Everywhere else the row is either moving or already terminal.
                // Minimizing a payload that is still going to be SENT would
                // destroy the frozen bytes L3 exists to preserve.
                Step.Refused(
                    "offline.nothing_awaiting_a_person",
                    P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id,
                )
            } else {
                // Expiry, reach and escalation in one step, and no fourth
                // thing: the state does not move, the row is not cleared, and
                // the operation stays exactly as owed as it was.
                Step.Moved(
                    withPayloadMinimized(true),
                    listOf(
                        SideEffect.MinimizePayload(
                            "offline.retention_window_elapsed",
                            P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id,
                        ),
                        SideEffect.Alert(
                            "offline.waiting_operation_escalated",
                            P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id,
                        ),
                    ),
                )
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
            } else if (event.keep && payloadMinimized) {
                // The bytes this key is bound to no longer exist on the device.
                // Sending anything else under it would burn the key for good,
                // and L3 would refuse it at the wire anyway — so say the real
                // reason here instead of letting it surface as a digest
                // mismatch two steps later. The approved payload must be
                // restored first, which is a settlement path that needs no new
                // intent and no new key.
                Step.Refused(
                    "offline.payload_minimized_cannot_resend",
                    P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id,
                )
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
        "Operation(id=$id, scope=$scope, effect=$effect, state=$state, attempts=$attempts, " +
            "lastCode=$lastCode, replayed=$replayed, schema=$schemaVersion, minimized=$payloadMinimized)"
}
