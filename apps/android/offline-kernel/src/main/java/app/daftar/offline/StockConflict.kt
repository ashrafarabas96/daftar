package app.daftar.offline

/**
 * What the merchant is told when the server refuses a synced sale for stock,
 * and the explicit step that gets them out of it.
 *
 * CARD P7-LINK-04 / DR-130, red first. The server's whole no-oversell
 * vocabulary is one code -- `inventory.insufficient_stock`, a 409 on the sale
 * path exactly as on a transfer -- and the device already refuses to retry it,
 * which is right. What was missing was the sentence the merchant reads:
 * [Recovery.explain] has no arm for that code, so it fell to the catch-all and
 * the shortage reached the till as `DEVICE_SOFTWARE_PROBLEM` with
 * `THIS_NEEDS_A_DEVELOPER`. A stock shortage is not a device defect, and a
 * merchant sent to find a developer cannot do the one thing that resolves it.
 *
 * WHY THIS IS A NEW FILE AND NOT AN ARM IN [Recovery]. `Recovery.kt`,
 * `Model.kt` and `Queue.kt` are byte-pinned at the P7-01 promotion: the proof
 * `tests-unit/p7-01-offline-kernel-promotion.test.ts` asserts the sha256 of
 * twenty-seven files, and its claim is a historical one -- that the promotion
 * was a move and not a rewrite. Editing `Recovery.kt` to add two enum
 * constants would move that hash, and re-pinning it would quietly convert the
 * claim from "these are the promoted bytes" into "these are the current
 * bytes", which is the evidence being spent rather than kept. So the law lands
 * in a file the pin does not cover, the pinned file is left exactly as
 * promoted, and whether the arms should eventually move INTO [Recovery] is the
 * owner's call on that pin, recorded rather than taken here.
 */
object StockConflict {

    /** The server's one no-oversell code, as its HTTP contract names it. */
    const val INSUFFICIENT_STOCK: String = "inventory.insufficient_stock"

    /**
     * What the merchant is shown, and what they can do about it. Deliberately
     * separate from [MerchantMessage] and [RecoveryAction] -- see the note on
     * this object -- and deliberately not a string: the wording belongs to the
     * surface, the CASE belongs here.
     */
    enum class StockMessage {
        /**
         * The sale was refused because the stock is not there. The way out is a
         * stock receipt or a stock adjustment, and THEN a resend of the same
         * operation under the same key: DR-130's part 3, an explicit merchant
         * step, never an automatic replay.
         */
        NOT_ENOUGH_STOCK_RECEIVE_OR_ADJUST_THEN_RESEND,
    }

    /** The step that resolves a stock refusal. */
    enum class StockAction {
        /** Record the stock that is physically there, then send this sale again. */
        FIX_THE_STOCK_THEN_RESEND,
    }

    /**
     * The merchant-facing reading of a stock refusal.
     *
     * `showsMoneyAsTaken` is false and `blocksNewCaptures` is false, and both
     * matter: nothing was taken, because the server refused the movement; and
     * one refused line must not stop the till from selling what IS in stock.
     */
    data class StockView(
        val message: StockMessage,
        val action: StockAction,
        val showsMoneyAsTaken: Boolean = false,
        val blocksNewCaptures: Boolean = false,
    )

    /** True when [errorCode] is the server's stock refusal, trimmed, exactly. */
    fun isStockRefusal(errorCode: String?): Boolean =
        errorCode?.trim() == INSUFFICIENT_STOCK

    /**
     * The view for a stock refusal, or `null` when the code is not one -- so a
     * caller cannot read this object as an explanation for everything. A
     * `null` means "not mine", never "no problem".
     *
     * NO SURFACE READS THIS YET, and that is measured, not an oversight:
     * nothing outside this module's own tests references [StockConflict], and
     * `ci.yml`'s DR-84 link gate deliberately keeps `:app` from resolving
     * `:offline-kernel`, so no till could reach it even if it tried. The
     * intended caller asks here first and falls back to [Recovery.explain];
     * wiring it is card 5 of this lane, and until that lands DR-130's second
     * part -- the conflict is SHOWN to the merchant -- is not delivered. What
     * is delivered is the reading itself, with the sentence and the step the
     * merchant needs, so card 5 has something true to display.
     */
    fun explain(errorCode: String?): StockView? =
        if (isStockRefusal(errorCode)) {
            StockView(
                message = StockMessage.NOT_ENOUGH_STOCK_RECEIVE_OR_ADJUST_THEN_RESEND,
                action = StockAction.FIX_THE_STOCK_THEN_RESEND,
            )
        } else {
            null
        }
}
