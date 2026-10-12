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
 * So the device's own queue is not the only thing that has to be consulted
 * before re-entry. The canonical receipt is, and this file is the gate that
 * says so.
 *
 * It is the one place where the device is allowed to ask a question whose
 * answer changes what the merchant may do — and even here it decides nothing:
 * a lookup that cannot reach the server returns `UNAVAILABLE`, which refuses.
 * Fail-closed, because the cost of the two errors is not symmetric. Refusing
 * re-entry wrongly costs a delay. Permitting it wrongly charges a customer
 * twice, in a row with a different key, which no later reconciliation can
 * identify as a duplicate.
 */

/** What the server said when asked whether the original operation exists. */
enum class ReceiptLookup {
    /** The server holds a committed operation for the original key. */
    COMMITTED,

    /**
     * The server authoritatively reports no operation for the original key.
     *
     * This must be the server's own answer about the key, not an inference
     * from an empty list, a 404 on an unrelated path, or a local cache (L9:
     * a read projection has no authority). "I did not find it" from a cache
     * is `UNAVAILABLE`, not `ABSENT`.
     */
    ABSENT,

    /** The question could not be answered: offline, timeout, error, or unknown. */
    UNAVAILABLE,
}

/** What is known locally about the operation the merchant is re-entering. */
enum class PriorOutcome {
    /** No earlier operation exists for this intent. A first capture. */
    NONE,

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

/** Whether a fresh capture, under a new key, may be made for this intent. */
sealed interface Reentry {
    /** A new key may be minted. `why` records what settled the original. */
    data class Permitted(val why: String) : Reentry

    data class Refused(val code: String, val law: String, val detail: String) : Reentry
}

object Reconciliation {
    /**
     * Decide whether the merchant may re-enter an operation under a new key.
     *
     * Total over both enums: every pair has an arm, and `ReentryTest` asserts
     * the full 4 x 3 cross product with the subject count checked, so a pair
     * added later cannot fall through an `else`.
     */
    fun decideReentry(prior: PriorOutcome, lookup: ReceiptLookup): Reentry = when (prior) {
        // Nothing happened before, so there is nothing to settle. The lookup is
        // not consulted — demanding a receipt lookup before every first sale
        // would make the whole till depend on the network, which is the one
        // thing an offline queue exists to avoid.
        PriorOutcome.NONE -> Reentry.Permitted("no earlier operation exists for this intent")

        // Provably never sent: the server cannot hold what never left. This is
        // the only case besides NONE that does not need the network, and it is
        // sound only because `attempts == 0` is the monotone fact the cancel
        // window already relies on.
        PriorOutcome.NEVER_SENT ->
            Reentry.Permitted("the original was captured but never sent, so the server cannot hold it")

        // Known committed. Re-entry is not a safety question but a correctness
        // one: the sale exists, and entering it again is a second sale.
        PriorOutcome.COMMITTED -> Reentry.Refused(
            "offline.original_already_committed",
            P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
            "the original operation is known to be committed; re-entering it would charge twice",
        )

        PriorOutcome.UNKNOWN -> when (lookup) {
            ReceiptLookup.COMMITTED -> Reentry.Refused(
                "offline.original_already_committed",
                P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
                "the canonical receipt shows the original was committed; re-entering it would charge twice",
            )

            ReceiptLookup.ABSENT -> Reentry.Permitted(
                "the canonical receipt shows the original was never committed",
            )

            // The directive's sentence, enforced: no re-entry under a new key
            // before the original is settled. An unreachable server does not
            // settle anything.
            ReceiptLookup.UNAVAILABLE -> Reentry.Refused(
                "offline.original_unsettled",
                P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id,
                "the original outcome is unknown and the canonical receipt could not be read; " +
                    "re-entry under a new key would commit a second time if the original landed",
            )
        }
    }
}
