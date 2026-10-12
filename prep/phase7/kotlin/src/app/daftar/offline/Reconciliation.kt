package app.daftar.offline

/**
 * Re-entry after the local queue is gone.
 *
 * The Tech Lead's continuous-mission directive, §14: "بعد مسح الجهاز أو إعادة
 * تثبيته، تحتاج UNKNOWN_OUTCOME مطابقة مع الإيصال الرسمي؛ لا إعادة إدخال بمفتاح
 * جديد قبل حسم الأصل." — after a device wipe or reinstall, an `UNKNOWN_OUTCOME`
 * needs to be matched against the canonical receipt, and **there is no re-entry
 * under a new key before the original is settled**.
 *
 * This closes a hole that L2 and L7 do not reach, and that the earlier D3
 * default walked straight into. L2 guarantees one key per row and L7 says a
 * lost answer resolves only by replaying that key — both of which assume the
 * row still exists. A wipe removes the row. What the merchant then does is not
 * a retry at all: it is a NEW capture, with a new key, of an operation the
 * server may already hold. The key machinery cannot help, because the whole
 * point of a new key is that the server has never seen it: the second send
 * lands on a different source identity and commits a second time.
 *
 * ## What V2 corrected here
 *
 * The first version of this file treated an `ABSENT` receipt as settling the
 * original, and V2 §14 named that as a race: "نتيجة ABSENT لمجرد عدم وجود صف
 * الآن لا تثبت انتهاء طلب قديم ما زال in-flight؛ نفذ settled absence/fencing
 * أو إعادة الأمر بالمفتاح نفسه حسب العقد".
 *
 * The correction is right, and the reason is worth stating precisely. A lookup
 * answers a question about an INSTANT. The original request may still be alive
 * between the device, a proxy and the server, and may commit a second after
 * the device was told there was nothing there. The device then acts on a
 * permission that was true when it was granted and false when it was used.
 *
 * There are exactly two sound answers, and this file implements both:
 *
 *  1. **Resend the original key** (L18). Available whenever the original key
 *     and the exact bytes frozen with it can be recovered. It needs no lookup
 *     and no fence: `deriveSourceId(business, key)` means the ledger's own
 *     uniqueness decides the outcome, so the resend either returns the stored
 *     truth with `replayed: true` or commits exactly once. The race is not won
 *     — it does not exist. This is the path proven against the LIVE contract
 *     and it is the preferred one wherever it is available.
 *
 *  2. **A fenced absence** (L17). Where the original identity is gone, an
 *     absence permits a new key only if the original key can no longer arrive.
 *     Fencing is a property of the SERVER, not of the answer's wording, and
 *     the merchant API has no such capability today — so this arm is carried
 *     as SPEC ONLY and is requested in
 *     `P7-S1-ANDROID-CLIENT-KEY-PATCH-REQUEST.md`. Until it exists, the
 *     reachable answers are "resend the original" or "refuse".
 *
 * Everything else refuses. Fail-closed, because the cost of the two errors is
 * not symmetric: refusing re-entry wrongly costs a delay, while permitting it
 * wrongly charges a customer twice, in a row with a different key, which no
 * later reconciliation can identify as a duplicate.
 */

/** What the server said when asked whether the original operation exists. */
enum class ReceiptLookup {
    /** The server holds a committed operation for the original key. */
    COMMITTED,

    /**
     * The server reports no operation for the key **and** has fenced that key
     * against a later arrival: an original still in flight will be refused
     * rather than committed.
     *
     * This is the only absence that settles anything (L17), and it is a
     * capability the merchant API does not have yet — see the patch request.
     */
    ABSENT_FENCED,

    /**
     * The server reports no operation for the key as of the instant it was
     * asked, with nothing stopping the original from landing afterwards.
     *
     * The common case, and the one the first version of this file got wrong.
     * It must also be the answer when the report is an inference rather than
     * the server's own statement about the key — an empty list, a 404 on an
     * unrelated path, or a local cache (L9: a read projection has no
     * authority).
     */
    ABSENT_UNFENCED,

    /** The question could not be answered: offline, timeout, error, or unknown. */
    UNAVAILABLE,
}

/**
 * Whether the original operation's own identity survived the wipe.
 *
 * V2 §14 asks for this to be tested — "اختبر provenance لمعرفة هوية الأصل بعد
 * wipe" — and it is the single most valuable thing the Android owner can
 * build, because it converts every hard case in `decideReentry` into the one
 * easy case. It is not merely the key: a resend under the original key with
 * different bytes is refused by the server permanently
 * (`IDEMPOTENCY_KEY_REUSED`), so recovering the key without the bytes is not a
 * resolution at all. Both, or neither.
 */
enum class Provenance {
    /**
     * The original idempotency key AND the exact payload bytes frozen with it
     * are both recoverable — from a server-side echo, a paired receipt, or an
     * exported journal. Whether any such source exists is a device-and-server
     * design question; this kernel only states what follows if one does.
     */
    ORIGINAL_RECOVERABLE,

    /** The intent is known. The original key, or its frozen bytes, are gone. */
    ORIGINAL_LOST,
}

/** What the merchant may do about an intent whose earlier operation is gone. */
sealed interface Reentry {
    /**
     * Resend under the ORIGINAL key and the original bytes. Not a new
     * operation: the same one, finishing. Safe under every receipt answer and
     * under none, so this outcome never depends on the lookup (L18).
     */
    data class UseOriginalKey(val why: String) : Reentry

    /** A new key may be minted. `why` records what settled the original. */
    data class Permitted(val why: String) : Reentry

    data class Refused(val code: String, val law: String, val detail: String) : Reentry
}

object Reconciliation {
    /**
     * Decide what may be done about an intent whose local row is gone.
     *
     * Total over all three enums: every triple has an arm, and
     * `ReentryAndRetentionTest` asserts the full 4 x 4 x 2 cross product with
     * the subject count checked and the expected verdicts written out as
     * literals, so neither a member added later nor a logic change can fall
     * through an `else` or be silently agreed with.
     */
    fun decideReentry(
        prior: PriorOutcome,
        lookup: ReceiptLookup,
        provenance: Provenance,
    ): Reentry = when (prior) {
        // Nothing happened before, so there is nothing to settle. Neither the
        // lookup nor provenance is consulted — demanding a receipt lookup
        // before every first sale would make the whole till depend on the
        // network, which is the one thing an offline queue exists to avoid.
        PriorOutcome.NONE -> Reentry.Permitted("no earlier operation exists for this intent")

        // Known committed. Re-entry is not a safety question but a correctness
        // one: the sale exists, and entering it again is a second sale. There
        // is also nothing to resend, so recovering the original does not help.
        PriorOutcome.COMMITTED -> Reentry.Refused(
            "offline.original_already_committed",
            P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
            "the original operation is known to be committed; re-entering it would charge twice",
        )

        // Provably never sent: the server cannot hold what never left. Still,
        // if the original identity survived, finishing the original is strictly
        // better than minting a second one — it keeps one intent to one key,
        // which is what makes any later audit possible (L18).
        PriorOutcome.NEVER_SENT -> when (provenance) {
            Provenance.ORIGINAL_RECOVERABLE -> Reentry.UseOriginalKey(
                "the original was never sent and its key and bytes survive, so it is sent, not re-entered",
            )

            Provenance.ORIGINAL_LOST -> Reentry.Permitted(
                "the original was captured but never sent, so the server cannot hold it",
            )
        }

        // F-01. There is nothing to look up: an undetermined prior state has
        // no key to ask about, so the receipt is not consulted and could not
        // help if it were. Only recovering the original resolves this, and
        // that is resolved off the device — at sign-in, which is already an
        // online operation, so requiring it costs a merchant nothing they were
        // not already paying.
        PriorOutcome.UNDETERMINED -> when (provenance) {
            Provenance.ORIGINAL_RECOVERABLE -> Reentry.UseOriginalKey(
                "the install cannot vouch for its store, but the original key and bytes were " +
                    "recovered, so the operation is finished rather than re-entered",
            )

            Provenance.ORIGINAL_LOST -> Reentry.Refused(
                "offline.prior_state_undetermined",
                P7Laws.AN_UNVOUCHED_STORE_CANNOT_REPORT_ABSENCE.id,
                "this install cannot tell an empty queue from a destroyed one, so it cannot " +
                    "establish that nothing was captured; a new key here would commit a second " +
                    "time if the earlier operation landed",
            )
        }

        PriorOutcome.UNKNOWN -> when (provenance) {
            // The resolution L7 always wanted, now reachable after a wipe. It
            // is deliberately decided BEFORE the lookup is read: a resend of
            // the same key is safe when the receipt says committed, when it
            // says absent, when it is fenced, when it is not, and when the
            // server cannot be reached at all. Making this arm depend on the
            // lookup would be adding a precondition the server does not need
            // and the race cannot survive.
            Provenance.ORIGINAL_RECOVERABLE -> Reentry.UseOriginalKey(
                "the original key and its frozen bytes are recoverable, so the server's own source " +
                    "uniqueness settles it with no lookup and no second commit",
            )

            Provenance.ORIGINAL_LOST -> when (lookup) {
                ReceiptLookup.COMMITTED -> Reentry.Refused(
                    "offline.original_already_committed",
                    P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
                    "the canonical receipt shows the original was committed; re-entering it would charge twice",
                )

                // The one absence that settles the original: it cannot arrive
                // any more, so a new key cannot become its duplicate.
                ReceiptLookup.ABSENT_FENCED -> Reentry.Permitted(
                    "the canonical receipt shows the original never committed and its key is fenced " +
                        "against a later arrival",
                )

                // V2's correction. "No row now" is a fact about an instant,
                // and the original may commit immediately after the answer is
                // given; the new key would then be a duplicate that no
                // reconciliation can pair with the first.
                ReceiptLookup.ABSENT_UNFENCED -> Reentry.Refused(
                    "offline.absence_not_fenced",
                    P7Laws.AN_UNFENCED_ABSENCE_SETTLES_NOTHING.id,
                    "the receipt shows no operation as of the moment it was asked, but nothing prevents " +
                        "the original from committing afterwards, so the absence settles nothing",
                )

                // The directive's own sentence, enforced: no re-entry under a
                // new key before the original is settled. An unreachable
                // server settles nothing.
                ReceiptLookup.UNAVAILABLE -> Reentry.Refused(
                    "offline.original_unsettled",
                    P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
                    "the original outcome is unknown and the canonical receipt could not be read; " +
                        "re-entry under a new key would commit a second time if the original landed",
                )
            }
        }
    }
}

/**
 * What the local store can attest about ITSELF, which is not the same thing as
 * what it contains.
 *
 * Challenger finding F-01: every arm of `decideReentry` was sound given a true
 * classification, and nothing established one. This enum is the missing
 * premise. It is deliberately about the INSTALL, not about the row: the
 * question "is there an earlier operation?" can only be answered by a store
 * that is the store that would have held it.
 */
enum class StoreAttestation {
    /**
     * This install can prove it is the one that would hold the row — a marker
     * kept outside the queue store itself matches, or the server has
     * confirmed this install has no operations outstanding from an earlier
     * one. Only here does an empty store mean "nothing was ever captured".
     *
     * How an install earns this is an Android and API concern, not the
     * kernel's: see `P7-S1` §8.1. The kernel states what follows from it.
     */
    VOUCHED,

    /**
     * A fresh install, a restored backup, a cleared data directory, or a
     * marker that does not match. The store may be empty because nothing was
     * captured, or because what was captured is gone, and this install cannot
     * tell those apart.
     *
     * The default for any install that has not established otherwise. An
     * install that is unsure is `CANNOT_VOUCH`, because being unsure is what
     * `CANNOT_VOUCH` means.
     */
    CANNOT_VOUCH,
}

/**
 * The classification step, which is where F-01 lived.
 *
 * Fail-closed in the one direction that matters: a store that cannot vouch for
 * itself never produces `NONE`. It may still produce a row's own state, because
 * a row that is PRESENT is evidence regardless of what else was lost — finding
 * something tells you something, finding nothing does not.
 */
object PriorState {
    /**
     * @param attestation what this install can prove about its own store.
     * @param rowState the state of the row the store actually holds for this
     *   intent, or `null` when the store holds none. `NONE` is not accepted
     *   here: "the store holds no row" is the `null`, and whether that means
     *   absence is precisely what this function decides.
     */
    fun classify(attestation: StoreAttestation, rowState: PriorOutcome?): PriorOutcome {
        require(rowState != PriorOutcome.NONE && rowState != PriorOutcome.UNDETERMINED) {
            "rowState is what the store HOLDS; pass null for an empty store rather than a verdict"
        }
        if (rowState != null) return rowState
        return when (attestation) {
            StoreAttestation.VOUCHED -> PriorOutcome.NONE
            StoreAttestation.CANNOT_VOUCH -> PriorOutcome.UNDETERMINED
        }
    }
}

/** What is known locally about the operation the merchant is re-entering. */
enum class PriorOutcome {
    /**
     * No earlier operation exists for this intent, **and the store that says
     * so can vouch for itself** (L19). Only `PriorState.classify` produces
     * this, and only from a `VOUCHED` install.
     */
    NONE,

    /**
     * The store holds no row and cannot establish that none was ever held —
     * the state a wiped or freshly installed device is in.
     *
     * Not a synonym for `UNKNOWN`. `UNKNOWN` means a specific operation was
     * sent and its answer was lost, so there is a key to replay and a receipt
     * to look up. `UNDETERMINED` means there may be no operation at all, or
     * one whose key this device cannot name — so there is nothing to look up,
     * and the lookup cannot help.
     */
    UNDETERMINED,

    /** An earlier attempt was made and its outcome was never established. */
    UNKNOWN,

    /** An earlier attempt is known to have been committed by the server. */
    COMMITTED,

    /**
     * An earlier operation was captured but provably never sent — the row's
     * attempt counter was zero when it was lost.
     */
    NEVER_SENT,
}
