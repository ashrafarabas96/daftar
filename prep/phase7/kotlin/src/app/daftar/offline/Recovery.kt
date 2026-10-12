package app.daftar.offline

/**
 * P7-S1 — what the MERCHANT sees, and what they can do about it.
 *
 * The High-Velocity mission's PART 7.4 names "user-visible recovery and
 * conflict states" as Phase 7 work, and PART 14 says a screen that looks
 * finished while its operation is not connected is not acceptable. This file
 * is the seam between the two: the kernel decides, and this decides what a
 * person is told.
 *
 * ── Why this is a kernel concern and not a UI one ─────────────────────────
 *
 * Because the dangerous failure is a translation, not a layout. Every refusal
 * this kernel produces carries a code and a law id, and both are written for
 * a developer. An Android screen that receives one has three tempting options
 * and all three are defects:
 *
 *  - show the raw code, which tells a cashier `offline.scope_switched` and
 *    leaves them to guess;
 *  - show a generic "something went wrong", which erases the difference
 *    between "sign in again" and "this sale needs a developer";
 *  - fall through a `when` to a default, which is how a code added next
 *    quarter silently becomes "something went wrong" for the rest of time.
 *
 * So the mapping is total, closed, and proven here — in the layer that can be
 * tested without a device — and the screen is left with nothing to decide.
 *
 * ── What this file deliberately does NOT contain ──────────────────────────
 *
 * **No text.** Not in Arabic, not in English, not in Turkish. A
 * `MerchantMessage` is a KEY, and the strings belong to the Localization
 * Owner under the single-authority rule; Phase 7 writing merchant-facing
 * Arabic would be a second localization source. The keys are named so that a
 * translator can see what each must say without reading this kernel.
 *
 * Status: PREPARED / NOT PROMOTED. No Android surface consumes this yet, and
 * `MerchantView` is a decision about what to show, not a rendering of it.
 */

/** What the merchant may actually DO about what they are looking at. */
enum class RecoveryAction {
    /** Nothing. The server's truth is established and the money is recorded. */
    NOTHING_IT_IS_DONE,

    /** Nothing yet. The device is working, or waiting for its turn. */
    WAIT_IT_IS_IN_PROGRESS,

    /** Release the capture for sending. The merchant has not confirmed it yet. */
    CONFIRM_THE_CAPTURE,

    /**
     * Try the SAME operation again — same key, same bytes. Offered only when
     * the merchant has changed something on the server's side of the problem
     * (paid the balance, counted the stock, reopened the period).
     */
    RETRY_THE_SAME_OPERATION,

    /** Fetch the approved payload back before this can be sent again (L16). */
    RESTORE_THE_APPROVED_PAYLOAD,

    /** This row belongs to another account. Switch back to it (L13). */
    SWITCH_BACK_TO_THE_OWNING_ACCOUNT,

    /** Sign in again. The session, not the sale, is the problem. */
    SIGN_IN_AGAIN,

    /**
     * A person with more authority than a cashier must look at this. The
     * operation is owed and the till cannot resolve it alone.
     */
    ESCALATE_TO_A_SUPERVISOR,

    /**
     * This cannot be fixed from the till at all — it is a defect in the
     * device software. Offering a merchant a retry here would be offering
     * them a button that cannot work.
     */
    THIS_NEEDS_A_DEVELOPER,
}

/**
 * A stable message key. The merchant-facing string for each is the
 * Localization Owner's, in all three locales.
 *
 * A closed enum rather than a string, so a screen cannot invent a key and a
 * key cannot be a smuggled server code.
 */
enum class MerchantMessage {
    SALE_RECORDED,
    SALE_WAITING_TO_SEND,
    SALE_SENDING,
    SALE_OUTCOME_UNKNOWN_WILL_RETRY,
    SALE_NEEDS_YOUR_ATTENTION,
    SALE_NOT_CONFIRMED_YET,
    SALE_DISCARDED,
    ALREADY_CONFIRMED,
    CANNOT_CANCEL_AFTER_SENDING,
    ALREADY_ABANDONED_NOTHING_WAS_SENT,
    NOT_READY_TO_SEND,
    DETAILS_CHANGED_SINCE_CAPTURE,
    DETAILS_ARCHIVED_RESTORE_FIRST,
    NOTHING_TO_RESTORE,
    RESTORED_DETAILS_DO_NOT_MATCH,
    SIGNED_IN_TO_ANOTHER_BUSINESS,
    SESSION_ENDED,
    PERMISSION_REMOVED,
    NOTHING_WAITING_ON_YOU,
    CANNOT_BE_DISCARDED_IT_IS_OWED,
    WAITING_TOO_LONG_ESCALATED,
    DETAILS_REDUCED_TO_PROTECT_PRIVACY,
    DEVICE_SOFTWARE_PROBLEM,
    ORIGINAL_ALREADY_RECORDED,
    ORIGINAL_NOT_SETTLED_YET,
    CANNOT_CONFIRM_ORIGINAL_ENDED,
    TILL_STILL_CHECKING_EARLIER_SALES,
    SERVER_DID_NOT_EXPLAIN,
}

/**
 * What one merchant-facing surface shows about one operation.
 *
 * `showsMoneyAsTaken` is the field this whole file exists for. It is L1 at
 * the only boundary where a merchant can be misled by it: a screen that
 * presents a captured-but-unconfirmed sale as money taken has made the
 * device a financial authority, whatever the kernel believes. The model check
 * asserts it is true only where the server has actually said so.
 */
data class MerchantView(
    val message: MerchantMessage,
    val action: RecoveryAction,
    /** Whether this operation stops the till taking the next sale. */
    val blocksNewCaptures: Boolean,
    /** Whether the merchant is shown this money as RECORDED. See above. */
    val showsMoneyAsTaken: Boolean,
)

object Recovery {
    /**
     * What a merchant sees about an operation that is simply sitting there.
     *
     * Exhaustive over `OperationState` with no `else`, so a state added later
     * is a compile error rather than a silent "something went wrong".
     */
    fun viewOf(operation: Operation): MerchantView = when (operation.state) {
        OperationState.CAPTURED -> MerchantView(
            MerchantMessage.SALE_NOT_CONFIRMED_YET,
            RecoveryAction.CONFIRM_THE_CAPTURE,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )

        OperationState.QUEUED -> MerchantView(
            MerchantMessage.SALE_WAITING_TO_SEND,
            RecoveryAction.WAIT_IT_IS_IN_PROGRESS,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )

        OperationState.IN_FLIGHT -> MerchantView(
            MerchantMessage.SALE_SENDING,
            RecoveryAction.WAIT_IT_IS_IN_PROGRESS,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )

        // The state Phase 0's machine lacked, and the one a merchant is most
        // likely to be shown wrongly. It is NOT a failure and NOT a success,
        // and the message says so in those terms: the device will keep asking.
        OperationState.UNKNOWN_OUTCOME -> MerchantView(
            MerchantMessage.SALE_OUTCOME_UNKNOWN_WILL_RETRY,
            RecoveryAction.WAIT_IT_IS_IN_PROGRESS,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )

        // The one place this may be true.
        OperationState.SYNCED -> MerchantView(
            MerchantMessage.SALE_RECORDED,
            RecoveryAction.NOTHING_IT_IS_DONE,
            blocksNewCaptures = false,
            showsMoneyAsTaken = true,
        )

        OperationState.NEEDS_ATTENTION -> needsAttentionView(operation)

        OperationState.DISCARDED -> MerchantView(
            MerchantMessage.SALE_DISCARDED,
            RecoveryAction.NOTHING_IT_IS_DONE,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )
    }

    /**
     * The only state whose view depends on more than the state.
     *
     * A divergence and a closed period both read as "needs attention", and
     * offering the same button for both would be wrong in opposite
     * directions: one is a device defect no retry can clear, the other is
     * cleared by the merchant doing something and retrying.
     */
    private fun needsAttentionView(operation: Operation): MerchantView = when {
        Outcome.isDivergence(operation.lastCode) -> MerchantView(
            MerchantMessage.DEVICE_SOFTWARE_PROBLEM,
            RecoveryAction.THIS_NEEDS_A_DEVELOPER,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )

        operation.payloadMinimized -> MerchantView(
            MerchantMessage.DETAILS_REDUCED_TO_PROTECT_PRIVACY,
            RecoveryAction.RESTORE_THE_APPROVED_PAYLOAD,
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )

        else -> MerchantView(
            MerchantMessage.SALE_NEEDS_YOUR_ATTENTION,
            // A material operation cannot be abandoned by the till, so the
            // only way out that is not a retry is a person with authority.
            if (operation.effect.isMaterial) {
                RecoveryAction.ESCALATE_TO_A_SUPERVISOR
            } else {
                RecoveryAction.RETRY_THE_SAME_OPERATION
            },
            blocksNewCaptures = false,
            showsMoneyAsTaken = false,
        )
    }

    /**
     * What a merchant is told when the kernel REFUSED what they just did.
     *
     * Total over every code this kernel can produce. `RefusalVocabularyTest`
     * sweeps the kernel's own source for `offline.*` literals and requires
     * each one to appear here, so a code introduced without deciding what a
     * person is told fails the suite rather than reaching a till.
     *
     * The `else` at the end is not a fallback in the usual sense and must not
     * be read as one: it maps an unrecognised code to "the device software has
     * a problem, call support", which is the only honest thing to say about a
     * refusal this layer does not understand, and the source sweep makes it
     * unreachable for every code that actually exists.
     */
    fun explain(code: String): MerchantView = when (code) {
        "offline.already_released" -> view(MerchantMessage.ALREADY_CONFIRMED, RecoveryAction.WAIT_IT_IS_IN_PROGRESS)

        "offline.cancel_after_send" ->
            view(MerchantMessage.CANNOT_CANCEL_AFTER_SENDING, RecoveryAction.WAIT_IT_IS_IN_PROGRESS)

        // Challenger finding I-01. This row was abandoned before anything left
        // the device, so there is nothing in progress and nothing to wait for.
        // It shared `cancel_after_send`'s view until the H-01 exit made the
        // state reachable by a second person: the cashier who cancelled a
        // colleague's capture, then pressed cancel again, was told to wait for
        // a sale nobody will ever send. Telling them it is already abandoned is
        // what lets them key it in again if it was real — which is the whole
        // reason the exit is a cancel and not a release.
        "offline.already_abandoned" ->
            view(MerchantMessage.ALREADY_ABANDONED_NOTHING_WAS_SENT, RecoveryAction.NOTHING_IT_IS_DONE)

        "offline.not_sendable" -> view(MerchantMessage.NOT_READY_TO_SEND, RecoveryAction.CONFIRM_THE_CAPTURE)

        "offline.no_attempt_in_flight" ->
            view(MerchantMessage.NOT_READY_TO_SEND, RecoveryAction.WAIT_IT_IS_IN_PROGRESS)

        // A recomputed payload is a device defect, not a merchant mistake.
        "offline.payload_changed_after_capture" ->
            view(MerchantMessage.DETAILS_CHANGED_SINCE_CAPTURE, RecoveryAction.THIS_NEEDS_A_DEVELOPER)

        "offline.restored_payload_does_not_match_capture" ->
            view(MerchantMessage.RESTORED_DETAILS_DO_NOT_MATCH, RecoveryAction.THIS_NEEDS_A_DEVELOPER)

        "offline.divergence_needs_a_fix" ->
            view(MerchantMessage.DEVICE_SOFTWARE_PROBLEM, RecoveryAction.THIS_NEEDS_A_DEVELOPER)

        "offline.payload_minimized_cannot_resend" ->
            view(MerchantMessage.DETAILS_ARCHIVED_RESTORE_FIRST, RecoveryAction.RESTORE_THE_APPROVED_PAYLOAD)

        "offline.payload_was_never_minimized" ->
            view(MerchantMessage.NOTHING_TO_RESTORE, RecoveryAction.WAIT_IT_IS_IN_PROGRESS)

        // The quiet one that matters most on a shared till: two staff logins,
        // and one of them is looking at the other's captures.
        "offline.scope_switched" ->
            view(MerchantMessage.SIGNED_IN_TO_ANOTHER_BUSINESS, RecoveryAction.SWITCH_BACK_TO_THE_OWNING_ACCOUNT)

        "offline.session_expired" -> view(MerchantMessage.SESSION_ENDED, RecoveryAction.SIGN_IN_AGAIN)

        "offline.permission_revoked" ->
            view(MerchantMessage.PERMISSION_REMOVED, RecoveryAction.ESCALATE_TO_A_SUPERVISOR)

        "offline.nothing_to_resolve", "offline.nothing_awaiting_a_person" ->
            view(MerchantMessage.NOTHING_WAITING_ON_YOU, RecoveryAction.NOTHING_IT_IS_DONE)

        "offline.material_cannot_be_abandoned" ->
            view(MerchantMessage.CANNOT_BE_DISCARDED_IT_IS_OWED, RecoveryAction.ESCALATE_TO_A_SUPERVISOR)

        "offline.refused_without_code" ->
            view(MerchantMessage.SERVER_DID_NOT_EXPLAIN, RecoveryAction.ESCALATE_TO_A_SUPERVISOR)

        // The re-entry gate (L15, L17). All three are refusals of a NEW
        // capture, so they are the only views that stop the till: a merchant
        // who is told "no" and given no reason will simply key the sale in
        // again, which is the duplicate the gate exists to prevent.
        "offline.original_already_committed" ->
            view(MerchantMessage.ORIGINAL_ALREADY_RECORDED, RecoveryAction.NOTHING_IT_IS_DONE, blocks = true)

        "offline.original_unsettled" ->
            view(MerchantMessage.ORIGINAL_NOT_SETTLED_YET, RecoveryAction.WAIT_IT_IS_IN_PROGRESS, blocks = true)

        "offline.absence_not_fenced" ->
            view(MerchantMessage.CANNOT_CONFIRM_ORIGINAL_ENDED, RecoveryAction.WAIT_IT_IS_IN_PROGRESS, blocks = true)

        // F-01. A reinstalled till that cannot vouch for its own store. The
        // merchant is not told "no" and left to key it in again: they are told
        // the till is still checking, and the till stops taking captures until
        // it has.
        "offline.prior_state_undetermined" ->
            view(MerchantMessage.TILL_STILL_CHECKING_EARLIER_SALES, RecoveryAction.WAIT_IT_IS_IN_PROGRESS, blocks = true)

        // Effect reasons rather than refusals, but a surface can be handed
        // either, so both have a stated view instead of falling through.
        "offline.retention_window_elapsed" ->
            view(MerchantMessage.DETAILS_REDUCED_TO_PROTECT_PRIVACY, RecoveryAction.RESTORE_THE_APPROVED_PAYLOAD)

        "offline.waiting_operation_escalated" ->
            view(MerchantMessage.WAITING_TOO_LONG_ESCALATED, RecoveryAction.ESCALATE_TO_A_SUPERVISOR)

        else -> view(MerchantMessage.DEVICE_SOFTWARE_PROBLEM, RecoveryAction.THIS_NEEDS_A_DEVELOPER)
    }

    private fun view(
        message: MerchantMessage,
        action: RecoveryAction,
        blocks: Boolean = false,
    ): MerchantView = MerchantView(
        message,
        action,
        blocksNewCaptures = blocks,
        // A refusal is never money taken. There is no argument for an
        // exception, so there is no parameter for one.
        showsMoneyAsTaken = false,
    )
}
