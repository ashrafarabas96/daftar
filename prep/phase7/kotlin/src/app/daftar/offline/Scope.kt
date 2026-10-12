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
     * security boundary here". It is compared for the three events a PERSON
     * originates — releasing, cancelling, resolving, restoring — because one
     * cashier must not act on another's captures. It is NOT compared for a
     * send, because a send asserts nothing about who the actor is: the server
     * authorizes the sending session on its own, and the row names its
     * capturer for the audit either way.
     *
     * So a till can finish Alice's sale after Alice has gone home, into the
     * same business, under the same key, with the same bytes — and still
     * cannot touch it from the wrong business, and still cannot let Bob cancel
     * what Alice captured.
     */
    fun mayAct(owner: OwnerScope, event: QueueEvent.ByScope): Boolean {
        // Never relaxed, for any event: this is the half the server cannot check.
        if (tenantId != owner.tenantId || businessId != owner.businessId) return false
        return when (event) {
            // A transmission. Authorized by the server, not by the row.
            is QueueEvent.Send,

            // Handing an unsent capture to the network is not a decision about
            // it. G-02: gating this on the member left the case this comment
            // describes stranded one state earlier than the send — a capture
            // Alice never released is unsendable (not in a sendable state),
            // unreleasable, uncancellable and unresolvable once her session is
            // gone, while L4 and L5 forbid dropping it. A release asserts
            // nothing about who took the money: it cannot be the step that
            // loses a sale, because nothing has left the device yet. The
            // reducer permits a release only from CAPTURED, so `attempts` is
            // necessarily 0 here — asserted as INV-13 rather than argued — and
            // the row goes on naming Alice, so the attempt still leaves under
            // her scope and the ledger still records her sale.
            is QueueEvent.Release,
            -> true

            // A person deciding something about someone else's capture. These
            // stay the capturer's: cancelling, resolving a material refusal and
            // restoring the bytes behind one are decisions about money, and a
            // refusal that needs a decision Bob cannot make is escalated to a
            // supervisor by `Recovery`, not quietly reassigned here.
            is QueueEvent.CancelByMerchant,
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
