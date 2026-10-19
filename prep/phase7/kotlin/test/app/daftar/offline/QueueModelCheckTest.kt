package app.daftar.offline

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A model check of the queue, not a walk through a few scenarios.
 *
 * Every configuration reachable from a fresh capture, under every event, is
 * enumerated breadth-first, and the invariants below are asserted at every
 * edge. A hand-written scenario proves the path someone thought of; the
 * failure that loses a sale is on the path nobody thought of — a process death
 * during the retry of an operation whose answer was already lost once, say.
 *
 * ── Why enumerating representative answers is still exhaustive ────────────
 *
 * The reducer never sees a status code. It sees a `Decision`, because it calls
 * `Outcome.classify` and branches on the result. So the reducer's reachable
 * space is determined by the set of DECISION SHAPES, not by the 700 x 11 x 3 x 8
 * answers that produce them. `the representative answers cover every decision
 * shape the classifier can produce` below closes that gap by sweeping the full
 * answer space and proving every answer's decision shape is one of the shapes
 * the representatives here produce. The two tests together are a proof over
 * the whole input space; either alone is not, and that is why neither is
 * allowed to be deleted quietly — each names the other.
 */
class QueueModelCheckTest {
    private companion object {
        /**
         * Every code a conditional claim in this file is written about, as a
         * literal total.
         *
         * This is an ANCHOR, and it is deliberately not the subject set. The
         * subject set is `claimsMade`, which is built by EVALUATING the claim
         * sites: each one registers the code it is about at the moment it
         * runs, so no spelling, position or formatting of this file decides
         * what is enrolled. What this set does is BOUND THE LOSS, which is the
         * eleventh review's ruling and the half the previous four anchors did
         * not have. The equality fails in both directions: a code here that
         * `claimsMade` does not contain is a claim site nothing evaluated, and
         * a code in `claimsMade` that is not here is a claim site nobody wrote
         * down. Neither can be arrived at quietly, because a count that
         * survives is not a count that was not lost.
         *
         * `WaitIsHonest.reasons` is added to this set where it is used, not
         * copied into it: those four codes are obligations this check inherits
         * from another file's declaration, and they are read from that
         * declaration as a VALUE.
         */
        val CODES_THIS_CHECK_CLAIMS_SOMETHING_ABOUT = setOf(
            "offline.not_sendable",
            "offline.another_members_capture",
            "offline.scope_switched",
            "offline.already_recorded",
            "offline.already_abandoned",
        )

        /**
         * Claims about a code the reachable space cannot produce, each with
         * the reason it is nevertheless written.
         *
         * The coordinator's ruling for this class of guard is that a subject
         * set is DERIVED and an exception is NAMED with a reason; this is that
         * map. It is empty, and an entry is a decision to be argued, not a
         * line to be added quietly: a claim about a code nothing produces is
         * exactly what L-01 was.
         *
         * Where this map is DECLARED is not part of the guard any more. It
         * used to be: the set of claims was swept out of this file's text with
         * the companion object cut out first, so a key written here was a
         * literal in the file, and the eleventh review moved the map into the
         * class body with a stale key and watched the key register itself
         * again. Nothing is swept now, so the map may live anywhere and a
         * stale key still reds.
         */
        val CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE: Map<String, String> = emptyMap()
    }

    private val key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private val digest = "sha256:0d5f1f2b"
    private val wrongDigest = "sha256:deadbeef"
    private val scope = OwnerScope("tenant-1", "business-1", "member-1")

    /**
     * The same till after the staff member switched to the other business they
     * are a member of. Every session-originated event is enumerated under BOTH
     * scopes, so the search decides whether a foreign scope can move anything
     * rather than taking L13's word for it.
     */
    private val foreignScope = OwnerScope("tenant-1", "business-2", "member-1")

    /**
     * The same till, same business, after the shift changed — the one
     * configuration challenger finding F-05 made legal. Enumerating it is what
     * makes INV-2's claim about the send's scope falsifiable: before it existed
     * no permitted event ever acted under a scope other than the row's, so an
     * effect that took its business from the EVENT instead of the ROW moved
     * nothing in this search and nothing here could see it.
     */
    private val nextShiftScope = OwnerScope("tenant-1", "business-1", "member-2")

    /**
     * What L13 permits, written out here rather than asked of the kernel.
     *
     * Calling `mayAct` would make this test agree with whatever the gate says,
     * which is not a check. Tenant and business are the half of the source
     * identity the server cannot validate, so they are required for every
     * event; the member is a decision boundary, so it is required for the
     * events where a person decides something and not for a transmission.
     */
    private fun permittedToAct(acting: OwnerScope, owner: OwnerScope, event: QueueEvent.ByScope): Boolean =
        acting.tenantId == owner.tenantId &&
            acting.businessId == owner.businessId &&
            (
                event is QueueEvent.Send ||
                    event is QueueEvent.CancelByMerchant ||
                    acting.memberId == owner.memberId
                )

    /**
     * What the custody record's `event` label must say, written out here
     * rather than computed the way the kernel computes it.
     *
     * Challenger finding I-02. INV-14 asserted three of the record's four
     * fields and left the one that says WHAT was done, so replacing the label
     * with the literal "CancelByMerchant" passed the whole suite and recorded a
     * foreign SEND as a cancel. Asserting `event::class.simpleName` against
     * `event::class.simpleName` would have agreed with any such edit, which is
     * the same reason `permittedToAct` above does not call `mayAct`: a check
     * that re-derives its expectation the way the subject does is not a check.
     * These are literals, one per event the gate lets through, and a `when`
     * with no `else` so an event added later is a compile error here.
     */
    private fun expectedCustodyLabel(event: QueueEvent.ByScope): String = when (event) {
        is QueueEvent.Release -> "Release"
        is QueueEvent.CancelByMerchant -> "CancelByMerchant"
        is QueueEvent.Send -> "Send"
        is QueueEvent.ResolveByMerchant -> "ResolveByMerchant"
        is QueueEvent.RestorePayload -> "RestorePayload"
    }

    /**
     * Merchant messages that assert bytes left the device, each with the reason
     * it does.
     *
     * Challenger finding I-01, and the next clause of the law G-03 opened: that
     * one proved every refusal code HAS a view, and a code can have a view and
     * still be the wrong code. A refusal produced before any attempt cannot
     * honestly carry one of these, because nothing has been transmitted to be
     * in progress. The set is small on purpose — it names only what `explain`
     * can actually produce, so an entry here is a message a refusal could
     * really be given, not a hypothetical.
     */
    private val assertsSomethingLeftTheDevice = mapOf(
        MerchantMessage.CANNOT_CANCEL_AFTER_SENDING to
            "it tells the merchant an attempt is out and they must wait for its answer",
        // Coordinator finding C-02′. A send refused because an attempt is
        // already out says so by name now, instead of telling the merchant to
        // confirm a sale they confirmed; the claim is a transmission, so it
        // belongs here and inherits the attempts > 0 requirement below.
        MerchantMessage.ALREADY_SENDING to
            "it tells the merchant the device is sending this operation now",
    ).keys

    /**
     * The states in which a wait is an honest instruction, each with the thing
     * that is actually pending.
     *
     * Challenger finding J-01. The first version of INV-9b judged the
     * MESSAGE and the harm I-01 described was the ACTION:
     * `WAIT_IT_IS_IN_PROGRESS`, whose own documentation reads "Nothing yet. The
     * device is working, or waiting for its turn". Judged on the action, three
     * codes still told a merchant to wait for something that was not coming —
     * a release of an abandoned row answering "already confirmed, wait" being
     * I-01 one button over, reachable because H-01 put a second person in front
     * of the same row.
     *
     * The rule is not "never wait before an attempt", because a released row
     * waiting its turn is genuinely waiting and saying so is true. It is that
     * something must actually be pending, which is a fact about the state and
     * not about who is holding the till — so the invariant does not look at
     * the acting scope, and L20's second clause no longer does either.
     */
    private val somethingIsGenuinelyPending = mapOf(
        OperationState.QUEUED to "released and waiting its turn or its backoff delay",
        OperationState.IN_FLIGHT to "an attempt is out and its answer has not been seen",
        OperationState.UNKNOWN_OUTCOME to "an attempt's answer was lost and the device will ask again",
    ).keys

    /**
     * The captured facts, DIFFERENT for each effect class on purpose.
     *
     * Challenger finding I-04 asks that the custody record describe what was
     * destroyed, and finding I-02 is the reason these are not one constant: a
     * record that hardcoded any single amount would satisfy an equality check
     * against a fixture that used the same one everywhere. Three roots with
     * three amounts and three currencies mean a constant can match at most one
     * of them.
     */
    private fun amountFor(effect: EffectClass): Long? = when (effect) {
        EffectClass.FINANCIAL -> 12_500
        // Challenger finding J-02: a stocktake count has no minor units, and a
        // fixture that gave it some denominated seven units of stock in a
        // currency. An inventory capture carries neither, which is also what
        // makes a planted constant visible here — a record that hardcoded any
        // amount would disagree with two of these three roots.
        EffectClass.INVENTORY, EffectClass.BENIGN -> null
    }

    private fun currencyFor(effect: EffectClass): String? = when (effect) {
        EffectClass.FINANCIAL -> "SAR"
        EffectClass.INVENTORY, EffectClass.BENIGN -> null
    }

    /** One representative answer per branch of the classifier. */
    private val answers: List<AttemptResult> = listOf(
        AttemptResult.Answered(200, null, true, null), // synced, replayed
        AttemptResult.Answered(201, null, null, null), // synced, first write
        AttemptResult.Answered(429, null, null, 30), // told to wait
        AttemptResult.Answered(503, null, null, null), // broke; unknown
        AttemptResult.Answered(409, "IDEMPOTENCY_KEY_REUSED", null, null), // divergence
        AttemptResult.Answered(409, "inventory.insufficient_stock", null, null), // business refusal
        AttemptResult.Answered(401, null, null, null), // session gone
        AttemptResult.NoAnswer, // no answer at all
    )

    private fun events(): List<QueueEvent> = buildList {
        for (acting in listOf(scope, foreignScope, nextShiftScope)) {
            add(QueueEvent.Release(acting))
            add(QueueEvent.CancelByMerchant(acting))
            add(QueueEvent.Send(digest, acting))
            add(QueueEvent.Send(wrongDigest, acting))
            add(QueueEvent.ResolveByMerchant(true, acting))
            add(QueueEvent.ResolveByMerchant(false, acting))
            add(QueueEvent.RestorePayload(digest, acting))
            add(QueueEvent.RestorePayload(wrongDigest, acting))
        }
        add(QueueEvent.ProcessDeath)
        add(QueueEvent.RetentionDeadlineReached)
        answers.forEach { add(QueueEvent.Observe(it)) }
    }

    /** The part of a configuration that is not the operation itself. */
    private data class History(val serverCommitted: Boolean, val everSent: Boolean)

    private fun fingerprint(op: Operation, h: History): String =
        "${op.id}|${op.scope}|${op.effect}|${op.payloadDigest}|${op.amountMinorUnits}|${op.currency}|" +
            "${op.state}|${op.attempts}|${op.lastCode}|" +
            "${op.replayed}|${op.payloadMinimized}|${h.serverCommitted}|${h.everSent}"

    /**
     * The codes this check claims something about, registered as each claim
     * site is EVALUATED.
     *
     * The eleventh review rejected the head before this one, and this is the
     * replacement it and the coordinator asked for. Four rounds running, the
     * set of claims was DERIVED FROM THIS FILE'S SOURCE TEXT, and four times
     * the derivation turned out to be a spelling: of an operator
     * (`step.code == "…"`, N-01), of a declaration (`indexOf("private
     * companion object {")`, which matched its OWN line once the companion was
     * moved to the end of the class and excised 739 lines of this file), of a
     * comment (a string literal holding a comment-opening sequence, which let
     * the stripper eat 596 lines), and of a literal (a code assembled as
     * `"offline." +
     * "permission_revoked"` was not enrolled — the escape this file itself
     * used, three lines above the sweep, to hide a sentinel from its own
     * guard). In each case the sweep reported itself healthy with
     * three-quarters of its subject set gone.
     *
     * The ruling that followed is the general one: a derived subject set may
     * not be derived from a representation its subject can alter, and SOURCE
     * TEXT is exactly such a representation. So the set is derived from
     * EXECUTION instead. A claim site calls `claimAbout`, which registers the
     * code before deciding whether the claim applies, so the code is enrolled
     * because the site RAN and not because a pattern matched it. There is no
     * text, so there is no spelling; an assembled or interpolated code
     * registers the value actually used; and the exemption map may be declared
     * anywhere, because nothing reads the file it is declared in.
     *
     * The cost, which is named here because it is real and not elsewhere
     * because it is not hidden: a claim site in a branch nothing reaches
     * registers nothing. That is why every site calls the helper
     * UNCONDITIONALLY with its condition inside, and why
     * `CODES_THIS_CHECK_CLAIMS_SOMETHING_ABOUT` is a literal total asserted
     * for EQUALITY — a site that never ran goes missing from `claimsMade` and
     * fails by name. The residual the design keeps is a conditional claim
     * written WITHOUT the helper at all: it is enrolled by nothing. That is
     * measured and recorded as a residual rather than argued away, and it is
     * the one thing a text sweep caught that this does not.
     */
    private val claimsMade = mutableSetOf<String>()

    /**
     * Registers `code` as a code this check claims something about, and
     * returns it, so that what is registered is the very value the claim is
     * asserted against. A registration written beside the claim could record a
     * different code from the one the claim tests; a registration that RETURNS
     * the code it registers cannot.
     */
    private fun claimingCode(code: String): String {
        claimsMade += code
        return code
    }

    /**
     * Makes a claim about one refusal code. `claim` runs only where `produced`
     * is that code, and the code is registered either way: the call is the
     * claim, and the condition is inside it.
     */
    private fun claimAbout(code: String, produced: String, claim: () -> Unit) {
        if (produced == claimingCode(code)) claim()
    }

    @Test
    fun `every reachable configuration honours every invariant`() {
        // Attempts are bounded for the search only. Beyond a few attempts the
        // configuration repeats in every respect except the counter, so the
        // bound loses no reachable BEHAVIOUR — and `attempts never decrease`
        // is asserted on every edge regardless of the bound.
        val attemptBound = 4
        var edges = 0
        var refusals = 0
        val statesSeen = mutableSetOf<OperationState>()
        var foreignScopeRefusals = 0
        var nextShiftSends = 0
        var releasesOfAnUnsentRow = 0
        var custodyRecords = 0
        var refusalsWithNothingSent = 0
        var custodyRecordsBeforeAnErase = 0
        var waitsJudged = 0
        var terminalRefusals = 0
        val eventsThatMoved = mutableSetOf<String>()
        val effectsSeen = mutableSetOf<String>()
        val codesSeen = mutableSetOf<String>()

        for (effect in EffectClass.entries) {
            val start = Operation.capture(
                key, scope, effect, digest, amountFor(effect), currencyFor(effect),
            ) to History(false, false)
            val visited = mutableSetOf(fingerprint(start.first, start.second))
            val frontier = ArrayDeque(listOf(start))

            while (frontier.isNotEmpty()) {
                val (op, history) = frontier.removeFirst()
                statesSeen += op.state
                for (event in events()) {
                    edges++
                    when (val step = op.step(event)) {
                        is Step.Refused -> {
                            refusals++
                            codesSeen += step.code

                            // E-04, first half: `not_sendable`'s view says
                            // "confirm this capture", so it may be refused
                            // only where that instruction is true — a CAPTURED
                            // row, and an actor who may confirm it. The
                            // expectation is written from the acting scope
                            // here, not read from the kernel, and the question
                            // "may this session confirm" is asked of the test's
                            // own independent `permittedToAct` with a Release.
                            claimAbout("offline.not_sendable", step.code) {
                                assertEquals(
                                    OperationState.CAPTURED, op.state,
                                    "a ${op.state} row was refused offline.not_sendable, whose view tells " +
                                        "the merchant to confirm a capture: $op on $event",
                                )
                                assertTrue(
                                    event !is QueueEvent.ByScope ||
                                        permittedToAct(
                                            event.actingScope, op.scope, QueueEvent.Release(event.actingScope),
                                        ),
                                    "a session that may not confirm this row was told to confirm it " +
                                        "(offline.not_sendable): $op on $event",
                                )
                            }
                            if (event is QueueEvent.ByScope &&
                                !permittedToAct(event.actingScope, op.scope, event)
                            ) {
                                foreignScopeRefusals++
                                // INV-9a: a foreign scope is refused AS a scope
                                // problem, never as a payload or a sequencing
                                // one, so the merchant is not told their sale
                                // is corrupt when they are simply signed into
                                // the wrong business.
                                //
                                // Coordinator finding C-02′ split the code in
                                // two, because one code was answering two
                                // different refusals and telling the second
                                // one's merchant something false. The
                                // expectation is written out from the acting
                                // scope here, not read from the kernel: a
                                // cross-business act is a business problem, and
                                // a colleague's capture inside one business is
                                // not.
                                val sameBusiness =
                                    event.actingScope.tenantId == op.scope.tenantId &&
                                        event.actingScope.businessId == op.scope.businessId
                                assertEquals(
                                    claimingCode(
                                        if (sameBusiness) {
                                            "offline.another_members_capture"
                                        } else {
                                            "offline.scope_switched"
                                        },
                                    ),
                                    step.code,
                                    "a foreign-scope $event was refused as ${step.code}",
                                )
                                assertEquals(P7Laws.NO_CROSS_ACCOUNT_SEND.id, step.law)
                            }
                            // INV-9b: a refusal produced before anything was
                            // ever sent never reaches the merchant as "an
                            // attempt is out, wait for it". INV-9a judges
                            // whether a refusal is the RIGHT refusal on one
                            // axis (a foreign scope is a scope problem); this
                            // is the same question on the axis I-01 found,
                            // where a second cancel of an abandoned row was
                            // answered with CANNOT_CANCEL_AFTER_SENDING and a
                            // cashier was told to wait for a sale nobody will
                            // send. It is asserted over the whole reachable
                            // space because "which states can be refused with
                            // nothing sent" is exactly the kind of question a
                            // later edit changes without noticing.
                            // INV-15: a finished row answers in its own terms,
                            // whatever was asked of it (coordinator finding
                            // C-02′). The sentence was in `Queue.kt` and the
                            // routing was in three arms out of six, so a send,
                            // a restore or a resolve on a row the server had
                            // already recorded answered `not_sendable` —
                            // whose view tells the merchant to CONFIRM a
                            // capture that is recorded, or one a colleague
                            // abandoned. It is asserted here rather than per
                            // arm for the reason the gate and the custody
                            // record have one site each: the arm added later
                            // is the one that would forget.
                            //
                            // The retention deadline is excluded by name and
                            // not by accident: it is the only event in this
                            // kernel that no person performs, so its refusal
                            // is not an answer to anybody.
                            if (op.isTerminal &&
                                event !is QueueEvent.RetentionDeadlineReached &&
                                (event !is QueueEvent.ByScope || permittedToAct(event.actingScope, op.scope, event))
                            ) {
                                terminalRefusals++
                                assertEquals(
                                    claimingCode(
                                        if (op.state == OperationState.SYNCED) {
                                            "offline.already_recorded"
                                        } else {
                                            "offline.already_abandoned"
                                        },
                                    ),
                                    step.code,
                                    "a ${op.state} row refused $event as ${step.code}, which describes a " +
                                        "row that is still live; the merchant is then told " +
                                        "${Recovery.explain(step.code).action}",
                                )
                            }
                            val view = Recovery.explain(step.code)
                            if (view.action == RecoveryAction.WAIT_IT_IS_IN_PROGRESS ||
                                view.message in assertsSomethingLeftTheDevice
                            ) {
                                waitsJudged++
                                assertTrue(
                                    op.state in somethingIsGenuinelyPending,
                                    "a ${op.state} row refused ${step.code}, which tells the merchant to " +
                                        "wait (${view.message} / ${view.action}) while nothing is pending: " +
                                        "$op on $event",
                                )
                            }
                            if (view.message in assertsSomethingLeftTheDevice) {
                                assertTrue(
                                    op.attempts > 0,
                                    "a refusal with nothing sent (${step.code}) is shown as " +
                                        "${view.message}, which asserts a transmission: $op on $event",
                                )
                            }
                            if (op.attempts == 0) refusalsWithNothingSent++

                            // INV-7: a refusal moves nothing and cites a law.
                            assertTrue(
                                step.law in P7Laws.ALL.map { it.id }.toSet(),
                                "refusal ${step.code} cites the unstated law ${step.law}",
                            )
                        }

                        is Step.Moved -> {
                            val next = step.operation
                            eventsThatMoved += event::class.simpleName.orEmpty()
                            step.effects.forEach { effectsSeen += it::class.simpleName.orEmpty() }

                            // INV-6: identity and the frozen payload never change,
                            // and the attempt counter never walks backwards.
                            assertEquals(op.id, next.id, "the idempotency key changed: $op -> $next on $event")
                            assertEquals(
                                op.payloadDigest, next.payloadDigest,
                                "the captured payload digest changed: $op -> $next on $event",
                            )
                            assertEquals(op.effect, next.effect, "the effect class changed: $op -> $next")
                            assertEquals(
                                op.amountMinorUnits, next.amountMinorUnits,
                                "the captured amount changed: $op -> $next on $event",
                            )
                            assertEquals(
                                op.currency, next.currency,
                                "the captured currency changed: $op -> $next on $event",
                            )

                            // INV-9: nothing a foreign session asked for ever
                            // moved, and the row's owner is as immutable as its
                            // key. This is the invariant PART 40 item 2 asks
                            // for, asserted over the whole reachable space
                            // rather than in one scenario.
                            assertEquals(
                                op.scope, next.scope,
                                "the row's owner changed: $op -> $next on $event " +
                                    "(${P7Laws.QUEUE_SCOPED_BY_OWNER.id})",
                            )
                            if (event is QueueEvent.ByScope) {
                                assertTrue(
                                    permittedToAct(event.actingScope, op.scope, event),
                                    "a session L13 does not permit moved this row: $op -> $next " +
                                        "on $event (${P7Laws.NO_CROSS_ACCOUNT_SEND.id})",
                                )
                                if (event.actingScope != op.scope) nextShiftSends++
                            }
                            assertEquals(
                                QueueSchema.CURRENT, next.schemaVersion,
                                "the row's schema version drifted: $op -> $next on $event",
                            )
                            assertTrue(
                                next.attempts >= op.attempts,
                                "attempts went backwards: $op -> $next on $event",
                            )

                            // INV-13: a release only ever moves a row nothing
                            // has been sent from, and so does a cancel. H-01
                            // moved the relaxed event from the release to the
                            // cancel, and the ground is the same one: nothing
                            // left the device, so there is no server truth to
                            // contradict. It is asserted over the whole
                            // reachable space instead of read off the reducer's
                            // arms — if a later edit made either legal from a
                            // state reachable after a send, the relaxation
                            // would hand another member a row the server may
                            // already hold.
                            if (event is QueueEvent.Release || event is QueueEvent.CancelByMerchant) {
                                assertEquals(
                                    0, op.attempts,
                                    "a $event moved a row that had already been sent: $op " +
                                        "(${P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id})",
                                )
                                if (event is QueueEvent.Release) releasesOfAnUnsentRow++
                            }

                            // INV-14: whatever a session that is not the row's
                            // own manages to do to it is recorded, with the
                            // acting scope on it, exactly once. The row names
                            // only the capturer, so without this the second
                            // actor H-01 introduced would act unrecorded — and
                            // a cancel clears the row immediately, so there is
                            // no later moment at which it could be recovered.
                            if (event is QueueEvent.ByScope && event.actingScope != op.scope) {
                                // J-04: the record is either an effect of its
                                // own, or it is INSIDE the effect that erases
                                // the row — there is no third place, and the
                                // count is over both so that fusing one path
                                // cannot quietly drop the record from it.
                                val records = step.effects.filterIsInstance<SideEffect.RecordCustodyAction>() +
                                    step.effects.filterIsInstance<SideEffect.ClearLocalRowRecording>()
                                        .map { it.record }
                                assertEquals(
                                    1, records.size,
                                    "a foreign-session move produced ${records.size} custody records: " +
                                        "$op on $event (${P7Laws.QUEUE_SCOPED_BY_OWNER.id})",
                                )
                                val record = records.single()
                                assertEquals(op.scope, record.capturedBy, "the record names the wrong capturer")
                                assertEquals(event.actingScope, record.actedBy, "the record names the wrong actor")
                                assertEquals(op.id, record.idempotencyKey)
                                // I-02: what was done, from a literal rather
                                // than from the kernel's own expression.
                                assertEquals(
                                    expectedCustodyLabel(event), record.event,
                                    "the record says ${record.event} about a $event: $op",
                                )
                                // I-04: what was destroyed, not only who did
                                // it. The row is cleared in the same step on
                                // the one path that opens, so these two fields
                                // are the only surviving description of the
                                // capture.
                                assertEquals(
                                    op.payloadDigest, record.payloadDigest,
                                    "the record describes a capture that is not this row's: $op on $event",
                                )
                                assertEquals(
                                    op.effect, record.effect,
                                    "the record names the wrong effect class: $op on $event",
                                )
                                assertEquals(
                                    op.amountMinorUnits, record.amountMinorUnits,
                                    "the record cannot say what was lost: $op on $event",
                                )
                                assertEquals(
                                    op.currency, record.currency,
                                    "the record names the wrong currency: $op on $event",
                                )
                                // I-04's second half, now as a structure
                                // rather than an order (J-04). A record that
                                // merely precedes the erase in a list is an
                                // obligation on whoever performs the list; a
                                // record the erase CARRIES cannot be omitted by
                                // anyone, because the permission to erase is
                                // the same value as the description of what is
                                // being erased. So no step by a foreign session
                                // may contain a bare `ClearLocalRow` at all.
                                assertTrue(
                                    step.effects.none { it is SideEffect.ClearLocalRow },
                                    "a session that is not the row's own was handed a bare erase, so the " +
                                        "capture can be destroyed without its description: $op on $event",
                                )
                                val fused = step.effects.filterIsInstance<SideEffect.ClearLocalRowRecording>()
                                if (fused.isNotEmpty()) {
                                    assertEquals(
                                        1, fused.size,
                                        "the row was erased ${fused.size} times in one step: $op on $event",
                                    )
                                    assertEquals(
                                        record, fused.single().record,
                                        "the erase carries a different record from the one this step made",
                                    )
                                    custodyRecordsBeforeAnErase++
                                }
                                custodyRecords++
                            } else {
                                assertTrue(
                                    step.effects.none { it is SideEffect.RecordCustodyAction },
                                    "a move by the row's own session was recorded as a custody action: " +
                                        "$op on $event",
                                )
                            }

                            // INV-5: at most one attempt is ever in flight.
                            val sends = step.effects.filterIsInstance<SideEffect.SendAttempt>()
                            if (op.state == OperationState.IN_FLIGHT) {
                                assertTrue(
                                    sends.isEmpty(),
                                    "a second attempt was started while one was in flight: $op on $event",
                                )
                            }

                            // INV-2: a send carries THIS key and THIS digest.
                            for (send in sends) {
                                assertEquals(op.id, send.idempotencyKey, "a send carried a foreign key")
                                assertEquals(
                                    op.payloadDigest, send.payloadDigest,
                                    "a send carried a payload that is not the captured one",
                                )
                                assertEquals(next.attempts, send.attempt, "the send's attempt number disagrees")
                                // F-02: the business is the half of the source
                                // identity the server cannot validate, so the
                                // effect must name it rather than leaving the
                                // transport to re-derive it at build time.
                                assertEquals(
                                    op.scope, send.scope,
                                    "a send carried a scope that is not the row's own: $op on $event " +
                                        "(${P7Laws.NO_CROSS_ACCOUNT_SEND.id})",
                                )
                            }

                            val committed = history.serverCommitted ||
                                (event is QueueEvent.Observe && isCommit(event.result))
                            val everSent = history.everSent || sends.isNotEmpty()

                            // INV-1: the whole point. SYNCED requires that the
                            // server said so.
                            if (next.state == OperationState.SYNCED) {
                                assertTrue(
                                    committed,
                                    "reached SYNCED without a 2xx from the server: $op -> $next on $event " +
                                        "(${P7Laws.DEVICE_NOT_AUTHORITY.id})",
                                )
                            }

                            // INV-3 / INV-8: a material operation that has been
                            // sent can never be thrown away by the device.
                            if (next.state == OperationState.DISCARDED) {
                                assertTrue(
                                    !everSent || !next.effect.isMaterial,
                                    "a sent ${next.effect} operation was discarded: $op -> $next on $event " +
                                        "(${P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id})",
                                )
                            }

                            // INV-10: minimizing a payload is not a delete. The
                            // tempting implementation of "bounded retention" is
                            // to drop the row, so the two side effects are
                            // asserted mutually exclusive over the whole space,
                            // and a minimized operation must remain exactly as
                            // owed as it was.
                            val minimized = step.effects.filterIsInstance<SideEffect.MinimizePayload>()
                            if (minimized.isNotEmpty()) {
                                assertTrue(
                                    step.effects.none {
                                        it is SideEffect.ClearLocalRow || it is SideEffect.ClearLocalRowRecording
                                    },
                                    "a payload was minimized AND the row cleared: $op on $event " +
                                        "(${P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id})",
                                )
                                assertEquals(
                                    OperationState.NEEDS_ATTENTION, next.state,
                                    "minimizing a payload moved the operation out of NEEDS_ATTENTION: " +
                                        "$op -> $next on $event",
                                )
                                assertEquals(
                                    op.lastCode, next.lastCode,
                                    "minimizing a payload discarded the server's refusal code",
                                )
                            }

                            // INV-11: the defect V2 found in L16, closed over
                            // the whole reachable space rather than argued.
                            // A minimized row has no bytes to send, so an
                            // attempt from one would either burn the key on
                            // different bytes or have no digest at all. The
                            // reducer has no explicit guard in the `Send` arm
                            // on purpose — one would be unreachable code, and
                            // unreachable code is not evidence. What makes the
                            // property true is that the only exit from a
                            // minimized row goes through a restore, and only
                            // a search over every path can say that.
                            if (op.payloadMinimized) {
                                assertTrue(
                                    sends.isEmpty(),
                                    "an attempt was made from a minimized row: $op on $event " +
                                        "(${P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id})",
                                )
                            }

                            // INV-12: a restore gives back the bytes and
                            // changes nothing else. It is not a second
                            // capture: no new key, no new digest, no state
                            // move, no attempt consumed.
                            if (event is QueueEvent.RestorePayload) {
                                assertTrue(
                                    !next.payloadMinimized,
                                    "a restore left the row minimized: $op -> $next",
                                )
                                assertEquals(
                                    op.state, next.state,
                                    "a restore moved the operation: $op -> $next",
                                )
                                assertEquals(op.attempts, next.attempts, "a restore consumed an attempt")
                                assertEquals(op.lastCode, next.lastCode, "a restore forgot the server's reason")
                            }

                            // INV-4: the local row is cleared only once there is
                            // nothing left that could exist only on the device.
                            if (step.effects.any {
                                    it is SideEffect.ClearLocalRow || it is SideEffect.ClearLocalRowRecording
                                }
                            ) {
                                assertTrue(
                                    next.state == OperationState.SYNCED || next.state == OperationState.DISCARDED,
                                    "the local row was cleared in state ${next.state} " +
                                        "(${P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id})",
                                )
                            }

                            val nextHistory = History(committed, everSent)
                            if (next.attempts <= attemptBound) {
                                val print = fingerprint(next, nextHistory)
                                if (visited.add(print)) frontier.addLast(next to nextHistory)
                            }
                        }
                    }
                }
            }
        }

        // The claim registry and its anchor, asserted FIRST because it is the
        // assertion that says which of the others were real.
        //
        // `claimsMade` holds the codes the claim sites above registered as
        // they ran. The four codes `WaitIsHonest` licenses a wait for are
        // obligations this check inherits — `RecoveryTest` proves its view
        // equality over them, and that equality is blind to a code nothing
        // produces any more (E-04), so each must be OBSERVED here. They are
        // registered from that declaration as a VALUE, which is the whole of
        // the eleventh review's ruling: the previous head read them out of
        // `RecoveryTest`'s source text, anchored on the words of a `mapOf`.
        //
        // The equality against a literal total is what bounds the loss. A
        // claim site that stops being evaluated — because a branch became
        // unreachable, or because somebody removed its registration — is
        // MISSING here, by name, with the code named. The four anchors this
        // guard carried before all asked whether something survived, which is
        // not the same question.
        for (code in WaitIsHonest.reasons.keys) claimingCode(code)
        assertEquals(
            (CODES_THIS_CHECK_CLAIMS_SOMETHING_ABOUT + WaitIsHonest.reasons.keys).toSortedSet(),
            claimsMade.toSortedSet(),
            "the set of codes this check registered a claim about is not the set it is written " +
                "to claim something about. A code missing from the right-hand side is a claim " +
                "site nothing evaluated, so whatever it asserts was asserted of nothing; a code " +
                "missing from the left is a claim site that was added without being written " +
                "down here, so nothing bounds what else it changed",
        )

        // Non-vacuity. A model check that explored three configurations and
        // asserted nothing would pass every invariant above, so the search
        // itself is measured: every state reachable, every event exercised,
        // every side effect produced, and both verdicts observed.
        // Challenger finding F-03: this used to read `statesSeen +
        // OperationState.SYNCED`, which satisfied the assertion for SYNCED by
        // construction — and SYNCED is the one state INV-1 is about. A
        // plausible "do not explore from a terminal state" optimization would
        // have made INV-1 vacuous with all tests green. The union was dead
        // weight too: the search reaches SYNCED on its own.
        assertEquals(
            OperationState.entries.toSet(), statesSeen,
            "the search did not reach every state; it saw $statesSeen",
        )
        assertEquals(
            setOf(
                "Release", "CancelByMerchant", "Send", "ProcessDeath", "Observe",
                "ResolveByMerchant", "RetentionDeadlineReached", "RestorePayload",
            ),
            eventsThatMoved,
            "some event never moved anything, so its transitions were never checked",
        )
        assertEquals(
            setOf(
                "SendAttempt", "Alert", "ClearLocalRow", "MinimizePayload", "RecordCustodyAction",
                "ClearLocalRowRecording",
            ),
            effectsSeen,
            "some side effect was never produced, so its invariant was never exercised",
        )
        assertTrue(refusals > 0, "no event was ever refused, so the refusal invariant is vacuous")
        assertTrue(
            foreignScopeRefusals > 0,
            "no foreign-scope event was ever refused, so INV-9 is vacuous: the search never " +
                "offered the kernel another account's session",
        )
        assertTrue(
            nextShiftSends > 0,
            "no event under another member of the same business ever moved anything, so INV-2's " +
                "claim that a send carries the ROW's scope rather than the sender's is vacuous",
        )
        assertTrue(
            releasesOfAnUnsentRow > 0,
            "no release ever moved anything, so INV-13 — the ground the relaxation stands on " +
                "— is vacuous",
        )
        assertTrue(
            custodyRecords > 0,
            "no session but the row's own ever moved it, so INV-14 is vacuous: the search never " +
                "offered the kernel the shared till H-01 is about",
        )
        assertTrue(
            custodyRecordsBeforeAnErase > 0,
            "no foreign-session move ever erased the local row, so the fused half of INV-14 " +
                "is vacuous: the path I-04 and J-04 are about was never explored",
        )
        // E-04, second half. The vocabulary sweep in `RecoveryTest` compares
        // the set of refusals whose VIEW instructs a wait against the set this
        // model check has proven reachable only while something is pending —
        // and an equality over views is blind to a code nothing produces any
        // more. Removing a helper from the Send arm made `already_sending`
        // unreachable while that equality stayed green, which the coordinator
        // measured. So each of those four codes must be OBSERVED here, in the
        // reachable space, and a code that stops being produced fails by name
        // rather than by nobody noticing.
        //
        // L-01, from the eighth review, generalised that to the rule the
        // paragraph above had already stated and the loop had not kept: EVERY
        // code about which this check makes a CONDITIONAL claim must be
        // observed, because an implication whose antecedent is never satisfied
        // is green by vacuity.
        //
        // M-01, from the ninth, is that the loop which stated that rule was
        // five pairs WRITTEN BY HAND. The rule was in the comment and nothing
        // derived it, so the next conditional claim a reviewer adds is not
        // enrolled: the review planted `if (step.code ==
        // "offline.permission_revoked")`, a code that reaches a row only as
        // `lastCode` and never as `step.code`, and the suite stayed green at 98
        // of 98. That is L-01 again, inside the guard L-01 produced, and it is
        // the third time this phase that a subject set gathered by hand let the
        // harm in through what the hand had not written down — after the
        // vocabulary sweep's alphabet (E-01) and the capture counter's file
        // (K-03).
        //
        // N-01 and N-02, from the tenth review, were the fourth and fifth
        // instances of the same family — and the first found INSIDE the class
        // remedy itself. The derivation keyed on one spelling,
        // `step.code == "…"`, so `when (step.code) { "…" -> }` — the shape this
        // file already used a few lines above — was green at 98 of 98 with a
        // claim about a code nothing produces.
        //
        // And the exemption map was a hatch. One line — `offline.not_sendable`
        // exempted — removed this loop's entire live obligation with the suite
        // green at 98 of 98 and nothing naming the loss; a stale key for a code
        // no claim mentions sat there equally quietly. So an exemption is a
        // CLAIM OF ITS OWN, which is the coordinator's ruling for the class,
        // and it goes red when it stops being true in either direction: it must
        // carry a reason, the code it exempts must really be unproducible, and
        // every key must name a code this check actually claims something
        // about.
        //
        // O-01..O-03, from the eleventh review, are the sixth, seventh and
        // eighth instances — all three in the DERIVATION, none in the kernel.
        // The literal sweep that answered N-01 was itself a spelling four ways
        // over, so the subject set is no longer read from this file at all. It
        // is `claimsMade`, registered as each claim site runs, and the
        // assertion above pins it against a literal total. The three
        // assertions below are unchanged in substance and now read that
        // registry: an exemption must carry a reason, must not cover a code
        // the space produces, and must name a code something here claims.
        val claimed = claimsMade.toSet()
        for (key in CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE.keys.sorted()) {
            assertTrue(
                key in claimed,
                "$key is exempted from the observability loop, but no claim site in this check " +
                    "registered it and WaitIsHonest does not license it, so the exemption is stale " +
                    "and the next reader will take it for a justified one: claimed = " +
                    "${claimed.sorted()}",
            )
        }
        for (code in claimed.sorted()) {
            val exemption = CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE[code]
            if (exemption != null) {
                assertTrue(
                    exemption.isNotBlank(),
                    "$code is exempted with no reason given, and an exemption without a reason is " +
                        "the silent weakening this loop exists to make impossible",
                )
                assertFalse(
                    code in codesSeen,
                    "the exemption for $code is stale in the direction that matters: the reachable " +
                        "space DOES produce it, so the claim about it is measurable and the " +
                        "exemption is hiding a live obligation rather than excusing an " +
                        "unmeasurable one",
                )
                continue
            }
            assertTrue(
                code in codesSeen,
                "a conditional claim is written about $code, but nothing in the reachable space " +
                    "produces it, so what is claimed about it is claimed about nothing. Either the " +
                    "producer is gone, or the claim belongs in " +
                    "CLAIMS_ABOUT_A_CODE_THIS_SPACE_CANNOT_PRODUCE with its reason. " +
                    "produced = ${codesSeen.sorted()}",
            )
        }
        assertTrue(
            terminalRefusals > 0,
            "no refusal on a finished row was judged, so INV-15 defends nothing",
        )
        assertTrue(
            waitsJudged > 0,
            "no refusal anywhere told the merchant to wait, so INV-9b judged nothing",
        )
        assertTrue(
            refusalsWithNothingSent > 0,
            "no refusal was ever produced with nothing sent, so INV-9b is vacuous",
        )
        assertTrue(
            MerchantMessage.CANNOT_CANCEL_AFTER_SENDING in assertsSomethingLeftTheDevice,
            "the set of messages that assert a transmission does not contain the one the " +
                "kernel actually produces for a cancel after a send, so INV-9b judges nothing",
        )
        assertTrue(edges > 1_000, "only $edges edges were explored")
    }

    private fun isCommit(result: AttemptResult): Boolean =
        result is AttemptResult.Answered && result.status in 200..299

    /**
     * The covering lemma. Without this, the model check above is a proof about
     * eight answers rather than about every answer a server can give.
     */
    @Test
    fun `the representative answers cover every decision shape the classifier can produce`() {
        val op = "11111111-2222-4333-8444-555555555555"
        fun shape(d: Decision): String = when (d) {
            is Decision.Synced -> "Synced(replayed=${d.replayed})"
            is Decision.Retry -> "Retry"
            is Decision.ResolveByReplay -> "ResolveByReplay"
            is Decision.NeedsAttention -> "NeedsAttention(diverged=${d.diverged})"
        }

        val covered = answers.map { shape(Outcome.classify(it, op, 1)) }.toSet()
        // Six shapes exist — the two `Synced` and the two `NeedsAttention` are
        // distinguished because the merchant is told different things — and all
        // six must be represented, or the search below the lemma is blind to
        // one of them. (The comment said five while the set below listed six:
        // coordinator finding C-01′.)
        assertEquals(
            setOf(
                "Synced(replayed=true)",
                "Synced(replayed=false)",
                "Retry",
                "ResolveByReplay",
                "NeedsAttention(diverged=true)",
                "NeedsAttention(diverged=false)",
            ),
            covered,
            "the representatives do not produce every decision shape",
        )

        val codes = listOf(
            null, "", "IDEMPOTENCY_KEY_REUSED", "accounting.idempotency_conflict",
            "inventory.insufficient_stock", "VALIDATION_FAILED", "accounting.period_closed",
        )
        var swept = 0
        for (status in 0..699) {
            for (code in codes) {
                for (replayed in listOf(null, false, true)) {
                    for (ra in listOf<Long?>(null, 0, 30, 86_400)) {
                        val d = Outcome.classify(AttemptResult.Answered(status, code, replayed, ra), op, 2)
                        assertTrue(
                            shape(d) in covered,
                            "status $status / code $code produces ${shape(d)}, which no representative covers",
                        )
                        swept++
                    }
                }
            }
        }
        assertTrue(shape(Outcome.classify(AttemptResult.NoAnswer, op, 2)) in covered)
        assertEquals(700 * codes.size * 3 * 4, swept)
    }
}
