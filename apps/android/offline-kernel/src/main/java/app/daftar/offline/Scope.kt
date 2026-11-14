package app.daftar.offline

/**
 * Whose queue row this is.
 *
 * The Tech Lead's directive PART 40 requires, before Phase 7 may be promoted,
 * that the queue be "scoped by tenant/business/member" and that an "account
 * switch cannot replay another account's entries". Those are two requirements,
 * not one, and only the first is satisfied by storing a scope: a row can carry
 * its owner faithfully and still be sent under whoever happens to be signed in
 * when the network returns.
 *
 * So the scope is a VALUE recorded on the row at capture (L12), and the sender
 * must state the scope it is sending under, which the kernel compares (L13).
 * The device cannot send an operation under a scope it was not captured under,
 * because there is no way to ask it to.
 *
 * Why this is not pedantry, in this codebase specifically: the server derives a
 * command's source identity from `(business, Idempotency-Key)`
 * (`packages/accounting/src/sources.ts` `deriveSourceId`). The business comes
 * from the request's `X-Business-Id` header and the key from the row. An
 * operation captured under business A and sent while the client holds business
 * B is therefore posted into business B's ledger under A's key — a cross-tenant
 * financial write that the server has no way to detect, because both halves of
 * the identity it was handed are internally consistent. The isolation the API
 * enforces per request cannot see a device that mislabels the request.
 *
 * `memberId` is carried for the same reason and a weaker one: the server
 * resolves membership itself and is the authority on it, so the member is not a
 * security boundary here. It is recorded because a queue shared by two staff
 * logins on one till must not let one of them release, cancel or resolve the
 * other's captures, and because an audit of "who captured this" has no other
 * source once the row is the only record.
 */
data class OwnerScope(
    val tenantId: String,
    val businessId: String,
    val memberId: String,
) {
    init {
        require(tenantId.isNotBlank()) { "a queue row must record the tenant it was captured under" }
        require(businessId.isNotBlank()) { "a queue row must record the business it was captured under" }
        require(memberId.isNotBlank()) { "a queue row must record the member who captured it" }
    }

    /**
     * Whether a session holding THIS scope may apply `event` to a row owned by
     * `owner`.
     *
     * Challenger finding F-05. Comparing the whole triple for every event was
     * the obvious reading of L13 and it strands a shift change: Alice captures
     * a sale while the till is offline, her shift ends and her session is
     * revoked as PART 40 item 2.3 requires, Bob signs in — and the row is then
     * unsendable, uncancellable, unresolvable and unminimizable, while L4 and
     * L5 forbid dropping it. That is not fail-closed; it is a material
     * operation that can never settle, which is the same class of defect as
     * the one V2 found in L16.
     *
     * The split follows the reasoning this file already states. The tenant and
     * the business are the identity the SERVER CANNOT VALIDATE: it derives the
     * source id from `(business, key)` and both halves look consistent, so a
     * mislabelled business is an undetectable cross-tenant write. Those are
     * compared for everything, with no exception and no handover.
     *
     * The member is different, by this file's own header: "the server resolves
     * membership itself and is the authority on it, so the member is not a
     * security boundary here". It is compared for the three events that COMMIT
     * something or settle it — confirming a capture for sending, resolving a
     * material refusal, restoring the bytes behind one — and not for the two
     * whose worst case is recoverable: a send, which carries the capturer's own
     * scope and so changes nothing about whose sale it is, and a cancel of a
     * capture nothing was ever sent from, which loses a local record that the
     * person at the till can capture again.
     *
     * So a till is never stuck with Alice's row after Alice has gone home: it
     * can send what she confirmed, and it can abandon what she did not. It
     * cannot confirm it for her, it cannot touch the row from another business,
     * and whatever it does to a row that is not its own is recorded as a
     * custody action with the acting member on it — because the row names only
     * the capturer, and a second actor the design introduces is a second actor
     * the audit needs.
     */
    fun mayAct(owner: OwnerScope, event: QueueEvent.ByScope): Boolean {
        // Never relaxed, for any event: this is the half the server cannot check.
        if (tenantId != owner.tenantId || businessId != owner.businessId) return false
        return when (event) {
            // A transmission. Authorized by the server, not by the row, and it
            // changes nothing about the row: the attempt carries the capturer's
            // own scope, so what reaches the ledger is the same sale either way.
            is QueueEvent.Send,

            // Abandoning a capture nothing was ever sent from. Finding H-01 is
            // why this one and not the release.
            //
            // G-02's dead end is real — a capture Alice never released is not
            // in a sendable state, so with every session event gated on the
            // member the row could never leave the device or the till. But of
            // the two ways to open it, the first fix chose the RISKIER one.
            // `Release` is the merchant's confirmation: it is the step that
            // turns a capture into a ledger entry, and an unconfirmed capture
            // may be a sale Alice took cash for and did not tap, or a basket
            // the customer walked away from. The kernel cannot tell those
            // apart, so a release by someone who cannot be established to have
            // witnessed the transaction resolves that ambiguity in the
            // COMMITTING direction. A cancel resolves it in the direction that
            // can be undone by the person standing at the till: nothing left
            // the device, so there is no server truth to contradict (L5's own
            // gate is `attempts == 0`, not the state), and a sale that was real
            // is captured again by whoever is there.
            //
            // So the asymmetry is deliberate: a member of the same business may
            // abandon another's unsent capture and may NOT confirm it. Between
            // losing a local record that can be re-entered and committing a
            // sale nobody confirmed, only the second reaches the ledger.
            is QueueEvent.CancelByMerchant,
            -> true

            // The capturer's own, because each of these is a decision about
            // money that cannot be taken back by the next person at the till:
            // confirming a capture for sending, settling a material refusal,
            // and restoring the bytes behind one.
            //
            // The clean answer to H-01 is neither cashier but a supervisor, and
            // `OwnerScope` has no role dimension to express one — `Recovery`
            // returns `ESCALATE_TO_A_SUPERVISOR` wherever a till cannot settle
            // something by itself, and the kernel cannot represent the
            // authority that action points at. (The count that stood here was
            // five, and closing D-01 made it seven: a sentence that has to be
            // recounted after every round is a C-01′ waiting to happen, so it
            // no longer carries one.) That role belongs to Phase
            // 4's authority model, and inventing a second one here is exactly
            // the duplicated authority the mission forbids, so it is recorded
            // as owed (OD-P7-08) rather than guessed at.
            is QueueEvent.Release,
            is QueueEvent.ResolveByMerchant,
            is QueueEvent.RestorePayload,
            -> memberId == owner.memberId
        }
    }

    /** For an alert or a log line: identifies the scope without quoting a token. */
    override fun toString(): String = "$tenantId/$businessId/$memberId"
}

/** A persisted queue row this build is not able to read. */
class UnreadableQueueRow(val version: Int, val current: Int) :
    IllegalStateException(
        "offline.queue_schema_unreadable: a queue row written under schema version $version " +
            "cannot be read by a build that understands version $current, and its fields will " +
            "not be reinterpreted under the current meanings (${P7Laws.UNKNOWN_QUEUE_SCHEMA_REFUSED.id})",
    )

/**
 * The version of the local queue row layout.
 *
 * PART 40 requires a versioned queue schema and tested local migrations. The
 * version matters most in the direction that is easy to forget: a DOWNGRADE.
 * An upgrade can migrate rows forward, and that migration is testable. But a
 * merchant who installs an older build — a rollback, a sideload, a staged
 * release that reverts — hands that build rows written by a newer one, whose
 * fields it will read under the OLD meanings. A row is not self-describing;
 * silently reading a newer row is how a frozen payload stops being the payload
 * that was frozen.
 *
 * So admission is fail-closed in both directions: a version this build does not
 * know is refused, loudly, and the row is left on disk for a build that does
 * know it. Refusing to send a captured sale is recoverable. Sending the wrong
 * bytes under a key that can never be reused is not.
 */
object QueueSchema {
    /**
     * The layout `Operation.capture` writes. Phase 7 is the first version;
     * it is 1 and has never been migrated, which is a fact and not an
     * achievement.
     */
    const val CURRENT: Int = 1

    /** The versions this build can read. A future build may read several. */
    val READABLE: Set<Int> = setOf(CURRENT)

    fun isReadable(version: Int): Boolean = version in READABLE

    /**
     * Called by the loader on every row it reads, before the row's fields are
     * used for anything. Throws rather than returning a boolean, because a
     * boolean invites a caller to carry on.
     */
    fun admit(version: Int) {
        if (!isReadable(version)) throw UnreadableQueueRow(version, CURRENT)
    }
}
