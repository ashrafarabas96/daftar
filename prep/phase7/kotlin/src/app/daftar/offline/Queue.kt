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

    /**
     * Someone other than the capturer moved this row, and this records who.
     *
     * Challenger finding H-01's second half. `Scope.kt` justifies storing the
     * member at all on the ground that "an audit of 'who captured this' has no
     * other source once the row is the only record" — and the moment the design
     * lets a second person act on the row, that argument applies to them too.
     * The row names the capturer and has nowhere to name anybody else, so the
     * actor is recorded as an effect at the moment it happens, which is also
     * the only moment it is known: a cancel clears the row immediately
     * afterwards, so a field on the row could not survive the very action most
     * worth recording.
     *
     * `event` is the kind of action, not a message: what it reads like to a
     * person is the message layer's business and never this file's.
     */
    data class RecordCustodyAction(
        val idempotencyKey: String,
        /** The scope the row was captured under. */
        val capturedBy: OwnerScope,
        /** The scope that acted on it, which is not the one above. */
        val actedBy: OwnerScope,
        val event: String,
        /**
         * The digest of what was captured, and its effect class.
         *
         * Challenger finding I-04, and it is the same argument as the one
         * above carried one step further. The reason the actor is recorded as
         * an effect rather than as a field on the row is that a cancel clears
         * the row in the same step, so a field could not survive the action
         * most worth recording — and that applies with equal force to WHAT was
         * destroyed. A record naming the person and the key, and nothing else,
         * can establish that Bob abandoned something of Alice's and can never
         * establish that it was a sale she had taken cash for. The
         * justification for the new exit is that a real sale is captured
         * again by whoever is standing there, which presumes somebody can
         * still tell a sale was there; once the row is gone this record is the
         * only thing that outlives it, and unlike a missing refusal code this
         * is not repairable afterwards.
         *
         * The digest rather than the payload: the bytes themselves are the
         * merchant's data and this is an audit record, so what is kept is
         * enough to recognise the capture again and not enough to reconstruct
         * it. The amount and currency are carried as well, because a digest
         * cannot be reconciled against a till: the question somebody asks
         * afterwards is "how much was lost", and only these two answer it.
         *
         * **Ordering is part of the contract.** This effect is emitted BEFORE
         * `ClearLocalRow` in the same step's list, and the caller must perform
         * the effects of a step in the order given, within the one local
         * transaction that applies the move. If the record cannot be written,
         * the erase must not happen — the kernel is a decision function and
         * cannot enforce that from here, so it is a caller obligation, stated
         * here and asserted on the ordering of the list, which is all this
         * kernel owns. The Android storage owner carries it in
         * `P7-S1-ANDROID-CLIENT-KEY-PATCH-REQUEST.md`.
         */
        val payloadDigest: String,
        val effect: EffectClass,
        /**
         * What the capture was worth, in the currency's minor units, exactly as
         * the capturing surface stated it. The kernel does not compute,
         * re-derive or validate it: a device that recalculated an amount would
         * be asserting a total of its own, which is the authority L1 denies it.
         */
        val amountMinorUnits: Long?,
        /**
         * The currency the amount is in, as captured. Whether the code is a
         * real currency is the canonical currency table's business on the
         * server and never a shape check here.
         */
        val currency: String?,
    ) : SideEffect

    /**
     * The local row may now be removed (L5).
     *
     * Coordinator finding C-01′: this said "emitted only alongside SYNCED",
     * which is false and was false when it was written. It is emitted on three
     * paths, and what they have in common is not the state but that no custody
     * action exists for them: a SYNCED row, where the server's own truth is
     * the record; the capturer's OWN cancel of a row nothing was sent from,
     * which is nobody else's capture to describe; and a benign resolve the
     * capturer makes. Every FOREIGN destruction carries its record instead,
     * as `ClearLocalRowRecording`.
     */
    data object ClearLocalRow : SideEffect

    /**
     * Remove the local row, and here is the record of what is being removed.
     *
     * Challenger finding J-04, and the reason it is a type and not a sentence.
     * The obligation — never erase a capture you failed to record — was true
     * and was stated in prose, and prose gives a caller nothing to be held to:
     * no value represented the boundary, no test of theirs could assert
     * against it, and no type would notice a caller that erased without
     * recording. `QueueEvent.Send` carries `actingScope` as a required
     * argument for exactly this reason, and this kernel makes L2 and L3
     * structural by refusing to compile the alternative. So on the one path
     * where another member's capture is destroyed, the permission to erase and
     * the description of what was erased are **one value**: a caller cannot
     * obtain the first without holding the second.
     *
     * `ClearLocalRow` survives for the paths where no custody action exists or
     * should: alongside SYNCED, where the server's own truth is the record,
     * and on the capturer's own cancel or benign resolve, where the acting
     * session IS the row's session and there is no second actor to name
     * (C-01′ corrected the earlier sentence, which named only SYNCED).
     */
    data class ClearLocalRowRecording(val record: RecordCustodyAction) : SideEffect

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
    /**
     * What the capture is worth, in minor units, as the capturing surface
     * stated it, with its currency.
     *
     * Challenger finding I-04. These are held because the row is not always
     * the last thing to go: a cancel clears it, and the custody record that
     * outlives it can only describe what was destroyed from facts the row
     * carried. They are required for a material capture (see `capture`) and
     * never computed here — L16's minimization already says the amount is part
     * of what keeps an obligation legible, and this is the same fact needed one
     * step earlier.
     */
    val amountMinorUnits: Long?,
    val currency: String?,
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
            amountMinorUnits: Long?,
            currency: String?,
        ): Operation {
            require(key.length in 8..200 && key.all { it.code in 0x20..0x7e }) {
                "an idempotency key must be 8 to 200 printable ASCII characters, as the merchant API requires"
            }
            require(payloadDigest.isNotEmpty()) { "a captured payload must have a digest" }
            // Fail closed, at the only moment the facts exist. A capture that
            // moves money and cannot say how much cannot be described after it
            // is destroyed (I-04), and the surface that captured it is the only
            // thing that knows.
            //
            // FINANCIAL and not `isMaterial`, which is challenger finding
            // J-02. `isMaterial` is FINANCIAL or INVENTORY, and an inventory
            // operation is a movement, a transfer, an adjustment or a
            // stocktake count: it has a quantity and a unit, and no amount in
            // minor units and no currency at all. Requiring them of it made
            // fabricating a currency a precondition of storing a stocktake —
            // my own fixtures denominated seven units of stock in riyals in
            // one file and in lira in another, in the field this record exists
            // to add. An inventory capture is described by its digest and its
            // effect class, which is what L20 now says; whether such a record
            // should carry a quantity and a unit of its own is OD-P7-09, owed
            // to the inventory authority and not invented here.
            //
            // The VALUE is never judged (J-05). A fully discounted sale may be
            // a legitimate zero and a refund may be negative, and deciding
            // which totals are permissible is the selling surface's business
            // and the server's, never this kernel's: a device that refused a
            // total would be asserting a total of its own. The currency is
            // checked for blankness and not merely for null because blank is
            // what an unset string decays to, and a blank currency names
            // nothing; there is no equivalent in-band "unset" for the amount
            // now that the parameter carries no default, so `0` reaching here
            // is a stated zero and is recorded as one. A surface that has not
            // totalled the basket yet must not capture: `P7-S1` §10 carries
            // that as the surface's obligation, because the kernel cannot
            // distinguish it from a sale that is genuinely free.
            if (effect == EffectClass.FINANCIAL) {
                require(amountMinorUnits != null) {
                    "a $effect capture must state what it is worth; a destroyed row cannot be described later"
                }
                require(!currency.isNullOrBlank()) {
                    "a $effect capture must state its currency as captured; whether the code exists is the " +
                        "canonical currency table's decision on the server, never a shape check here"
                }
            }
            return Operation(
                key, scope, effect, payloadDigest, amountMinorUnits, currency,
                OperationState.CAPTURED, 0, null, false,
            )
        }
    }

    private fun moved(
        state: OperationState,
        attempts: Int = this.attempts,
        lastCode: String? = this.lastCode,
        replayed: Boolean = this.replayed,
    ): Operation = Operation(
        id, scope, effect, payloadDigest, amountMinorUnits, currency,
        state, attempts, lastCode, replayed, schemaVersion, payloadMinimized,
    )

    private fun withPayloadMinimized(minimized: Boolean): Operation = Operation(
        id, scope, effect, payloadDigest, amountMinorUnits, currency,
        state, attempts, lastCode, replayed, schemaVersion, minimized,
    )

    val isTerminal: Boolean
        get() = state == OperationState.SYNCED || state == OperationState.DISCARDED

    /**
     * The refusal a finished row gives, whatever was asked of it.
     *
     * Coordinator finding C-02′ made that sentence true. It was written while
     * only `Release`, `CancelByMerchant` and `Observe` consulted it, so a
     * `Send`, a `RestorePayload` or a `ResolveByMerchant` on a recorded or
     * abandoned row still answered in the vocabulary of a row that was still
     * live — `not_sendable`, whose view tells the merchant to CONFIRM a
     * capture the server has already recorded or a colleague has abandoned.
     * Every arm now routes its refusal of a finished row through here, which
     * is the same "one place, not one per arm" reason the scope gate and the
     * custody record have one site each.
     *
     * Challenger finding J-01. A refusal's code decides what a person is told,
     * and three codes told a merchant to wait for something that was not
     * coming: a release of an abandoned row answered "already confirmed, wait",
     * which on the one path H-01 opened means a second cashier is told a sale
     * exists when a colleague has just abandoned it. A finished row has nothing
     * pending by definition, so it answers in its own terms — recorded, or
     * abandoned — and never with a sequencing refusal that implies the device
     * is still working.
     */
    private fun refusalForAFinishedRow(): Step.Refused? = when (state) {
        OperationState.SYNCED ->
            Step.Refused("offline.already_recorded", P7Laws.DEVICE_NOT_AUTHORITY.id)

        OperationState.DISCARDED ->
            Step.Refused("offline.already_abandoned", P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id)

        else -> null
    }

    /**
     * The refusal a row waiting on a PERSON gives to an attempt to move it.
     *
     * J-01's second case, found by the strengthened invariant rather than by
     * the review. A `NEEDS_ATTENTION` row answered a release with "already
     * confirmed, wait for it" and a cancel with "an attempt is out, wait for
     * it". The first halves are arguable; the instruction is false in both. The
     * device has finished with this row and is waiting for a decision, so
     * telling a cashier to wait for the device is telling them to wait for
     * themselves.
     */
    private fun refusalForARowAwaitingAPerson(): Step.Refused? =
        if (state == OperationState.NEEDS_ATTENTION) {
            Step.Refused("offline.waiting_on_a_person", P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)
        } else {
            null
        }

    /**
     * The refusal a row that is already being sent gives.
     *
     * Coordinator finding C-02′. `offline.not_sendable` answers "confirm this
     * capture", which is right for a CAPTURED row and false for one whose
     * attempt is out: the merchant confirmed it, the device is sending it, and
     * the button they are offered is the one they already pressed. Here the
     * instruction to wait is honest, because IN_FLIGHT is pending on the
     * device — which is exactly the distinction L20's clause draws.
     */
    private fun refusalForARowAlreadySending(): Step.Refused? =
        if (state == OperationState.IN_FLIGHT) {
            Step.Refused("offline.already_sending", P7Laws.KEY_MINTED_AT_CAPTURE.id)
        } else {
            null
        }

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
            // Coordinator finding C-02′: one code for two different refusals
            // made one of them lie. `mayAct` refuses on two separate grounds —
            // the tenant-and-business half, which is never relaxed, and the
            // member half, which gates only the three committing events — and
            // both answered `offline.scope_switched`, whose view says
            // SIGNED_IN_TO_ANOTHER_BUSINESS and "switch back to the owning
            // account". For the next shift on the SAME business that is false
            // in both halves. The gate still refuses exactly what it refused;
            // only what the person is told is split.
            val sameBusiness = event.actingScope.tenantId == scope.tenantId &&
                event.actingScope.businessId == scope.businessId
            val code = if (sameBusiness) "offline.another_members_capture" else "offline.scope_switched"
            return Step.Refused(code, P7Laws.NO_CROSS_ACCOUNT_SEND.id)
        }
        val step = stepWithinScope(event)

        // ONE place for the custody record too, for the same reason the gate is
        // one place: a per-arm record is the law restated, and the arm added
        // later is the one that forgets it. A refusal moves nothing, so there is
        // nothing to record; what is recorded is every MOVE caused by a session
        // that is not the row's own (H-01).
        if (event is QueueEvent.ByScope && event.actingScope != scope && step is Step.Moved) {
            val record = SideEffect.RecordCustodyAction(
                id, scope, event.actingScope, event::class.simpleName.orEmpty(),
                payloadDigest, effect, amountMinorUnits, currency,
            )
            // Where this move erases the row, the erase and the record become
            // one value (J-04), so that the permission to destroy the capture
            // cannot be held without its description. Where it erases nothing,
            // the record simply goes first — there is nothing it has to
            // survive, and ordering is all that is left to say.
            val effects = if (step.effects.any { it is SideEffect.ClearLocalRow }) {
                step.effects.map {
                    if (it is SideEffect.ClearLocalRow) SideEffect.ClearLocalRowRecording(record) else it
                }
            } else {
                listOf(record) + step.effects
            }
            return Step.Moved(step.operation, effects)
        }
        return step
    }

    private fun stepWithinScope(event: QueueEvent): Step = when (event) {
        is QueueEvent.Release ->
            if (state == OperationState.CAPTURED) {
                Step.Moved(moved(OperationState.QUEUED), emptyList())
            } else {
                // A finished row first (J-01): "already confirmed, wait for it"
                // is false about a row that was abandoned and false about one
                // the server has already recorded. Everywhere else it is true —
                // the row is in the queue, in flight, or resolving a lost
                // answer — and the merchant is told to wait because something
                // genuinely is.
                refusalForAFinishedRow()
                    ?: refusalForARowAwaitingAPerson()
                    ?: Step.Refused("offline.already_released", P7Laws.KEY_MINTED_AT_CAPTURE.id)
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
                // Challenger finding I-01. `!isTerminal` above does its work on
                // exactly one state: SYNCED is unreachable with attempts == 0,
                // because the only road to it passes through an attempt, so the
                // row this arm turns away is a DISCARDED one — which is the
                // state the H-01 exit itself produces. Folding it into
                // `cancel_after_send` tells the cashier to wait for a sale that
                // was abandoned seconds ago, possibly by the colleague beside
                // them, and waiting for a sale that will never arrive is the
                // re-key harm the merchant-view work exists to prevent. The
                // code is distinct because the view must be, and nothing was
                // ever sent here. J-01 widened it to the other finished state:
                // "you cannot cancel, an attempt is out" is equally false about
                // a sale the server has already recorded.
                refusalForAFinishedRow()
                    ?: refusalForARowAwaitingAPerson()
                    ?: Step.Refused("offline.cancel_after_send", P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id)
            }

        is QueueEvent.Send ->
            if (!isSendable) {
                // C-02′. Each non-sendable state answers in its own terms, and
                // what is left for `not_sendable` after the three helpers is
                // exactly CAPTURED — the one state where "confirm this
                // capture" is the true instruction.
                refusalForAFinishedRow()
                    ?: refusalForARowAwaitingAPerson()
                    ?: refusalForARowAlreadySending()
                    ?: Step.Refused("offline.not_sendable", P7Laws.KEY_MINTED_AT_CAPTURE.id)
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
                // Three different facts used to share one code and one view
                // that said "wait" (J-01). A finished row answers in its own
                // terms; a row nothing was ever sent from is a device out of
                // step with itself, and so is an answer for an attempt this
                // kernel has already settled with the server's own refusal;
                // only a row that is queued or resolving a lost answer is
                // genuinely waiting for something.
                refusalForAFinishedRow()
                    ?: if (attempts == 0) {
                        Step.Refused("offline.no_attempt_was_ever_made", P7Laws.DEVICE_NOT_AUTHORITY.id)
                    } else if (state == OperationState.NEEDS_ATTENTION) {
                        Step.Refused("offline.attempt_already_resolved", P7Laws.DEVICE_NOT_AUTHORITY.id)
                    } else {
                        Step.Refused("offline.no_attempt_in_flight", P7Laws.DEVICE_NOT_AUTHORITY.id)
                    }
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
            // C-02′: a finished row first, for the same reason as every other
            // arm. Restoring the bytes of a row the server has recorded, or of
            // one that was abandoned, is not a payload question.
            refusalForAFinishedRow()
                ?: if (!payloadMinimized) {
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
                    // Nothing else moves: same state, same key, same digest.
                    // The row is simply storable-and-sendable again.
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
            // C-02′: "nothing is waiting on you" is true of a finished row but
            // says less than the kernel knows, and on a DISCARDED row it reads
            // as though the operation simply never existed.
            refusalForAFinishedRow()
                ?: if (state != OperationState.NEEDS_ATTENTION) {
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
        "Operation(id=$id, scope=$scope, effect=$effect, amount=$amountMinorUnits $currency, " +
            "state=$state, attempts=$attempts, " +
            "lastCode=$lastCode, replayed=$replayed, schema=$schemaVersion, minimized=$payloadMinimized)"
}
