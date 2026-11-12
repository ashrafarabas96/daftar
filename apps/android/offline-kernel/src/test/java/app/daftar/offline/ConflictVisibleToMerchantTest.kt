package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * CARD P7-LINK-04 -- an offline sale that oversells must become VISIBLE to the
 * merchant as conflicted, and must never be retried for them.
 *
 * The owner's decision (recorded as DR-128 and renumbered to DR-130 by the
 * reservation rule) states it in three parts:
 *
 *   1. no negative stock, no exception -- the server refuses;
 *   2. an offline sale that exceeds stock at sync time is NOT refused
 *      silently and opens no negative-stock door: it enters the EXISTING
 *      conflict path (409), the operation is marked conflicted and SHOWN to
 *      the merchant, with NO automatic replay;
 *   3. the merchant resolves it by an explicit step -- a stock receipt or a
 *      stock adjustment -- and then resends.
 *
 * The server's half is measured, not assumed: `inventory.insufficient_stock`
 * is the whole no-oversell vocabulary and it is a 409 on the sale path exactly
 * as on a transfer (`apps/api/src/modules/selling/selling-errors.ts`, the
 * `sellingInventoryRefusal` contract), raised by
 * `inventory_apply_stock_movements` for any outbound movement larger than the
 * level's `on_hand`.
 *
 * The device half is where this is red. `Outcome.classify` puts a 409 in the
 * generic `400..499` arm, so the operation does reach `NEEDS_ATTENTION` and is
 * NOT retried -- parts 2a and 2c already hold, and the cases below assert them
 * so a regression cannot pass. What does NOT hold is part 3: `Recovery.explain`
 * has no arm for `inventory.insufficient_stock`, so the merchant is told
 * nothing about stock and is given no action to resolve it. A screen that says
 * "needs your attention" without naming the shortage or the step is the silent
 * refusal the decision forbids, one layer up.
 */
class ConflictVisibleToMerchantTest {

    private companion object {
        /** The server's one no-oversell code, measured at its HTTP contract. */
        const val INSUFFICIENT_STOCK = "inventory.insufficient_stock"
        const val HTTP_CONFLICT = 409
        const val OPERATION = "55555555-5555-4555-8555-555555555555"
    }

    @Test
    fun an_oversell_409_is_never_retried_by_the_device() {
        val answered = AttemptResult.Answered(
            status = HTTP_CONFLICT,
            errorCode = INSUFFICIENT_STOCK,
            replayed = null,
            retryAfterSeconds = null,
        )
        val decision = Outcome.classify(answered, OPERATION, attempt = 1)

        assertTrue(
            decision is Decision.NeedsAttention,
            "a stock conflict must stop and ask the merchant, not retry: got $decision",
        )
        val needs = decision as Decision.NeedsAttention
        assertEquals(
            INSUFFICIENT_STOCK,
            needs.code,
            "the server's own code must reach the merchant layer unchanged",
        )
        assertFalse(
            needs.diverged,
            "an oversell is not a device defect: the payload never changed, the stock did",
        )
    }

    @Test
    fun the_conflicted_operation_is_parked_where_the_merchant_sees_it() {
        assertEquals(
            OperationState.NEEDS_ATTENTION,
            Replay.afterConflict(),
            "a conflict must park the row in the state the merchant's list reads",
        )

        // Through the state machine, not around it: capture, release, send,
        // then observe the server's 409 on the stock.
        val scope = OwnerScope("tenant-1", "business-1", "member-1")
        val digest = QueueDigest.of("{\"totalMinor\":12500}".toByteArray())
        val captured = Operation.capture(OPERATION, scope, EffectClass.FINANCIAL, digest, 12_500, "SAR")
        val released = legal(captured, QueueEvent.Release(scope))
        val inFlight = legal(released, QueueEvent.Send(digest, scope))
        assertEquals(OperationState.IN_FLIGHT, inFlight.state)

        val answer = AttemptResult.Answered(HTTP_CONFLICT, INSUFFICIENT_STOCK, false, null)
        val step = inFlight.step(QueueEvent.Observe(answer))
        assertTrue(step is Step.Moved, "observing a stock conflict must be legal in IN_FLIGHT")
        val conflicted = (step as Step.Moved).operation

        assertEquals(
            OperationState.NEEDS_ATTENTION,
            conflicted.state,
            "a stock conflict must park the row for the merchant, not drop or retry it",
        )
        assertEquals(
            emptyList(),
            step.effects.filterIsInstance<SideEffect.SendAttempt>(),
            "the device must schedule no further attempt after a stock conflict",
        )

        val view = Recovery.viewOf(conflicted)
        assertEquals(MerchantMessage.SALE_NEEDS_YOUR_ATTENTION, view.message)
        assertFalse(
            view.showsMoneyAsTaken,
            "a refused sale must not be shown as money taken",
        )
    }

    /** The step must be legal; an illegal one is a failure, never a skip. */
    private fun legal(op: Operation, event: QueueEvent): Operation {
        val step = op.step(event)
        assertTrue(step is Step.Moved, "expected $event to be legal in ${op.state}, got $step")
        return (step as Step.Moved).operation
    }

    @Test
    fun the_merchant_is_told_it_is_stock_and_given_the_step_that_resolves_it() {
        // The vocabulary is asserted BY NAME rather than by symbol: a case that
        // named a constant the enums do not have yet would not fail, it would
        // stop the module compiling, and a module that does not compile runs
        // zero cases -- which is the silent pass the kernel's own count gate
        // exists to catch. So the red here is an assertion, not a build break.
        val messageNames = MerchantMessage.entries.map { it.name }
        val actionNames = RecoveryAction.entries.map { it.name }
        assertTrue(
            messageNames.any { it.contains("STOCK") },
            "no MerchantMessage names a stock shortage, so the merchant cannot be told why " +
                "the sale was refused. Have: $messageNames",
        )
        assertTrue(
            actionNames.any { it.contains("STOCK") },
            "no RecoveryAction offers the explicit step the decision requires -- a stock " +
                "receipt or adjustment, then a resend. Have: $actionNames",
        )

        val view = Recovery.explain(INSUFFICIENT_STOCK)

        assertTrue(
            view.message.name.contains("STOCK"),
            "the merchant must be told the sale was refused for stock, not given a generic " +
                "'needs attention' or a device-software message; got ${view.message}",
        )
        assertTrue(
            view.action.name.contains("STOCK") || view.action == RecoveryAction.RETRY_THE_SAME_OPERATION,
            "the decision's part 3 is an EXPLICIT merchant step -- a receipt or an adjustment -- " +
                "and then a resend; got ${view.action}",
        )
        assertFalse(
            view.showsMoneyAsTaken,
            "nothing was taken: the server refused the movement",
        )
        assertFalse(
            view.blocksNewCaptures,
            "one refused line must not stop the till from selling what IS in stock",
        )
    }
}
