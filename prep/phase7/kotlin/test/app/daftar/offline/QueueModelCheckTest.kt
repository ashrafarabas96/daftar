package app.daftar.offline

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

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
         * Every conditional claim in this file, as a literal total of
         * **(site, code)** pairs.
         *
         * This is an ANCHOR, and it is deliberately not the subject set. The
         * subject sets are `claimsMade` and `claimsExercised`, both built by
         * EVALUATING the claim sites, so no spelling, position or formatting
         * of this file decides what is enrolled. What this set does is BOUND
         * THE LOSS, which was the eleventh review's ruling and is the half the
         * four anchors before it did not have.
         *
         * **It is keyed on the SITE and not only on the code, which is the
         * twelfth review's amendment: an anchor bounds the loss of the thing
         * that can be lost, and what can be lost is a SITE.** Keyed on codes
         * alone, two sites about one code collapsed into one member, so a
         * second lawful claim about `offline.not_sendable` would have let the
         * first site's registration be removed with the set unchanged. No code
         * has two sites today; the equality's own promise is what made that
         * latent rather than harmless.
         *
         * The equality fails in both directions. A pair here that the registry
         * does not contain is a claim site nothing evaluated; a pair in the
         * registry that is not here is a claim site nobody wrote down.
         *
         * The four codes `WaitIsHonest` licenses are NOT in this set and are
         * not registered as claims. They are obligations this check inherits
         * from another file's declaration, they are read from it as a VALUE,
         * and they join the observability loop directly. The twelfth review's
         * P-04: they used to be registered unconditionally two lines above an
         * equality that added them to its own left-hand side, so that half of
         * the equality could not fail. An assertion that cannot fail says
         * nothing, whatever it is about.
         */
        val CLAIMS_THIS_CHECK_MAKES: Map<Pair<String, String>, ClaimDomain> = mapOf(
            ("E-04/not-sendable-offers-a-button-its-reader-can-press" to "offline.not_sendable")
                to ClaimDomain.EVERY_PRODUCTION,
            ("INV-9a/a-foreign-scope-is-refused-as-a-scope-problem" to "offline.scope_switched")
                to ClaimDomain.EVERY_PRODUCTION,
            ("INV-15/a-finished-row-answers-in-its-own-terms" to "offline.already_recorded")
                to ClaimDomain.EVERY_PRODUCTION,
            ("INV-15/a-finished-row-answers-in-its-own-terms" to "offline.already_abandoned")
                to ClaimDomain.EVERY_PRODUCTION,
            // INV-9c, and it is here because of the fourteenth review's
            // R-01: the one claim with a narrow domain leaves productions of
            // its code outside what it judges, and a COUNTER that measures
            // that gap is not a cover for it. A cover has to be something
            // NAMED, and this is the name: every production of
            // `offline.another_members_capture`, in either class, is a row
            // this acting session may not RELEASE. Declared over
            // `EVERY_PRODUCTION`, so it judges the narrow claim's gap and its
            // own domain at once.
            ("INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it"
                to "offline.another_members_capture")
                to ClaimDomain.EVERY_PRODUCTION,
            // The only claim here whose domain is narrower than every
            // production of its code, and it is narrower for a reason that is
            // itself counted: `offline.another_members_capture` is produced on
            // a foreign-scope refusal, which INV-9a judges, AND by E-04's own
            // arm, where the event is permitted and the release is not. Those
            // are different questions about one code, so this claim's
            // denominator is the foreign-scope count. What the gap that opens
            // is covered BY is declared in
            // `WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT` and asserted, and
            // the partition assertion below is kept as a second, independent
            // reading of the same facts rather than as the accounting itself.
            ("INV-9a/a-foreign-scope-is-refused-as-a-scope-problem" to "offline.another_members_capture")
                to ClaimDomain.ON_A_FOREIGN_SCOPE_REFUSAL,
        )

        /**
         * What covers the productions a claim's NARROW domain leaves out.
         *
         * The fourteenth review's R-01, a fail-open along this file's own
         * extension path. The denominator is chosen by an exhaustive `when`,
         * so a new `ClaimDomain` value is forced to supply one — that half was
         * fail-closed. The accounting was not: it was an
         * `if (domain == ON_A_FOREIGN_SCOPE_REFUSAL)` around a partition
         * assertion, so a THIRD value got a denominator and no accounting at
         * all, and the compiler said nothing. Declaring a third domain the way
         * this file declares its second — the value, a counter beside the
         * others, incremented at the top of the refusal arm, a `when` branch —
         * and wrapping E-04's site in that same condition was measured at
         * **99 of 99 GREEN with E-04's harm underneath**.
         *
         * Two things close it, and the second is the one that bites.
         *
         * 1. **The gap is detected by MEASUREMENT, not by the enum.** Any
         *    claim whose denominator is below every production of its code has
         *    a gap, whatever its domain is called and whenever that domain was
         *    added, so there is no per-domain branch for a later author to
         *    write as `-> {}`.
         * 2. **A gap must be covered by something NAMED.** A complement
         *    counter is not a cover: any author can add one, derived from the
         *    very predicate that narrows the site, and the partition then
         *    holds by construction — which is exactly how R-01's plant works.
         *    So a cover is either another claim IN THIS MAP, about the same
         *    code, declared over `EVERY_PRODUCTION`, whose site is named here
         *    and asserted to be there; or a reasoned statement that nothing is
         *    left out, which is asserted by MEASURING the gap at zero. A
         *    reason that is merely written down covers nothing.
         *
         * Checked with no grandfathering, on the coordinator's ruling: the
         * narrow domain this file already had did not satisfy this rule, and
         * INV-9c above is the claim that was added so that it does.
         */
        val WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT:
            Map<Pair<String, String>, WhatCoversTheRest> = mapOf(
            ("INV-9a/a-foreign-scope-is-refused-as-a-scope-problem" to "offline.another_members_capture")
                to WhatCoversTheRest.AnotherClaimOverEveryProduction(
                    "INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it",
                ),
        )

        /** What a narrow claim's gap is covered by. See the map above. */
        sealed interface WhatCoversTheRest {
            /**
             * Another claim in `CLAIMS_THIS_CHECK_MAKES`, about the SAME code,
             * declared over `EVERY_PRODUCTION` — so the productions this
             * claim's domain excludes are inside that one's. The site is named
             * here and asserted to be present with that domain, so renaming or
             * narrowing the covering claim reds instead of going quiet.
             */
            data class AnotherClaimOverEveryProduction(val site: String) : WhatCoversTheRest

            /**
             * Nothing is left out. The reason is recorded for the reader, and
             * the claim is checked by measuring the gap at ZERO rather than by
             * reading the reason.
             */
            data class NothingIsLeftOut(val why: String) : WhatCoversTheRest
        }

        /**
         * What a claim's body is required to have run over: the DENOMINATOR
         * the count equality reads it against.
         *
         * The thirteenth review's Q-01: recording that a claim was exercised
         * records that it ran ONCE SOMEWHERE in the search, which is not that
         * it ran on the cases it is about. A site wrapped in its own
         * precondition — the very condition its second assertion exists to
         * judge — still runs, still registers, and excludes exactly the rows
         * that matter. So a claim states where it must have run, and the count
         * says whether it did.
         *
         * `EVERY_PRODUCTION` is the strongest denominator available and the
         * one to prefer: the body must run on every production of the code
         * anywhere in the reachable space. A narrower domain is a claim of its
         * own and is counted independently of the branch its site sits in —
         * counted at the top of the refusal arm, so a condition added inside
         * the site drops the numerator while the denominator stands.
         */
        enum class ClaimDomain { EVERY_PRODUCTION, ON_A_FOREIGN_SCOPE_REFUSAL }

        /**
         * Comparisons against a refusal code that this file forbids outside
         * the registering helper.
         *
         * **This is a CONVENTION CHECK and not a derivation. Nothing derives a
         * subject set from it, and nothing relies on it being complete.** It
         * exists because the registry enrolls a claim only when the claim goes
         * through `claimAbout`, so a claim written around the helper is
         * enrolled by nothing — the residual this session disclosed and the
         * twelfth review then measured: the tenth review's `when (step.code)`
         * plant is green at 98 of 98 against the registry alone.
         *
         * **Its own fail-open, stated precisely, because a reader of this
         * file will otherwise assume a text check here is a derivation and
         * trust it as one:** it sees a comparison against the EXPRESSION
         * `step.code` written ON ONE LINE, and nothing else. The thirteenth
         * review measured two escapes that are not spellings at all — a local
         * variable assigned from `step.code` and then compared, and the same
         * comparison broken across two lines — each green at 99 of 99 with its
         * control red. An assignment is one of the patterns below now; a line
         * break is not reachable by a line-wise check at all, and "a steered
         * spelling escapes it" was too kind to this check, because a local
         * variable is not a spelling. The
         * difference is the direction of the failure. A subject set derived
         * from steered text yields a false GREEN, which is every finding of
         * the tenth and eleventh reviews. A prohibition that is steered yields
         * NOTHING: it fails to fire and leaves the residual that already
         * exists. Its worst case is the status quo and its best case closes a
         * live hole, so it can only ADD reds.
         *
         * The patterns are ASSEMBLED from pieces so that these four lines are
         * not themselves offenders. Written out, they were — and the check
         * went RED rather than quiet, which is the direction a convention
         * check is allowed to fail in. The retired sweep assembled a string
         * for the opposite reason, to hide it from a subject set; nothing is
         * derived here, so this is bookkeeping rather than a hole.
         */
        val A_COMPARISON_AGAINST_A_CODE = listOf(
            "step.code" + " ==",
            "==" + " step.code",
            "step.code" + " in ",
            "when (" + "step.code" + ")",
            " = " + "step.code",
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
    private val claimsMade = mutableSetOf<Pair<String, String>>()

    /**
     * The claims this check actually EXERCISED: the ones whose body ran,
     * because the code they are about was the code produced.
     *
     * **The twelfth review's blocker, and it was a fail-open rather than a
     * residual.** `claimsMade` certifies that a site RAN, which is not that
     * its claim was ever tested. Wrap a site in a condition that is REACHED
     * but excludes the cases the claim is about — `if (op.state ==
     * OperationState.UNKNOWN_OUTCOME) { … }` around the `not_sendable` site,
     * where those rows do refuse and do register, while `not_sendable` is
     * produced only on CAPTURED rows — and the body runs zero times with the
     * registry's equality satisfied. The review then planted proof 64's own
     * harm underneath it: E-04's refusal arm deleted, so a cashier's own
     * capture is refused with "another member must confirm this", **green at
     * 98 of 98**, against rc 1 and red by name on a clean subject. The
     * observability loop cannot see it either, because the code IS produced —
     * by the rows the conditioned site no longer looks at.
     *
     * So the branch that runs the claim records it. **That records EXISTENCE
     * of exercise and nothing more, and the sentence that used to stand here
     * — that the proposition this loop defends is now asserted rather than
     * assumed — was false as measured.** The thirteenth review wrapped this
     * same site in its own precondition instead of an excluding state:
     *
     *     if (event !is QueueEvent.ByScope ||
     *         permittedToAct(event.actingScope, op.scope, QueueEvent.Release(event.actingScope))
     *     ) { claimAbout(…) { … } }
     *
     * Rows whose actor may release still produce the code, so the site ran,
     * the body ran, both equalities were satisfied — and the only rows
     * excluded were the ones the second assertion exists for. With E-04's
     * refusal arm deleted underneath it: **99 of 99 green**, against rc 1 and
     * red by name on a clean subject. The hole was in the remedy that review
     * had itself specified, built as specified.
     *
     * What closes it is a COUNT, not an existence. `timesTheBodyRan` is read
     * against `timesTheCodeWasProduced` pair by pair, so a claim must be
     * exercised on EVERY production of the code it is about, over the domain
     * declared for it in `CLAIMS_THIS_CHECK_MAKES`. A wrapper drops the
     * numerator below the denominator and names the shortfall. Counting is
     * also what bounds a REUSED label (Q-02): two sites under one label show
     * as 2N against N, so the pair anchor no longer has to be defended by a
     * convention about labelling.
     *
     * **What this registry does NOT bound, stated here because this is where
     * its promise is made (the fourteenth review's R-02).** The pairs and the
     * counts bound a site's EXISTENCE and its FREQUENCY: a site removed, a
     * site never evaluated, a site that runs on part of its domain, a label on
     * two sites. They do not bound a site's CONTENT. A DECOY — the same site,
     * the same label, the same number of runs, with its assertions deleted —
     * satisfies every equality here, and was measured green at 99 of 99 with
     * E-04's harm underneath, by this session and then independently by the
     * review. The only instrument that bounds content is the red-proof
     * harness, `tools/red_proofs.py`, which reports that same tree as
     * `the suite stayed GREEN with the defect planted — the law is undefended`
     * and exits 1. **And that harness is not a required step anywhere:** it
     * says so in its own limitations, it is run by a person at a head, and no
     * workflow in this repository runs anything under `prep/phase7`. So the
     * assurance against a decoy is conditional on the harness being run, and
     * a reader who takes this registry for the whole guard is reading it
     * wrong.
     *
     * The residual that WAS named here as the next thing to attack — a site
     * whose declared DOMAIN is itself steered — was attacked, and the
     * fourteenth review's R-01 found the level above it: not the domain of a
     * site, but the ACCOUNTING for what a narrow domain leaves out. See
     * `WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT`. Four of the six claims
     * declare `EVERY_PRODUCTION`, which is the strongest denominator
     * available, and the one narrow domain is counted independently of the
     * branch its site sits in and has its gap covered by a NAMED claim.
     */
    private val claimsExercised = mutableSetOf<Pair<String, String>>()

    /** How many times each claim site's body actually ran, keyed on (site, code). */
    private val timesTheBodyRan = mutableMapOf<Pair<String, String>, Int>()

    /** How many times each refusal code was produced anywhere in the search. */
    private val timesTheCodeWasProduced = mutableMapOf<String, Int>()

    /**
     * How many times each code was produced on a refusal of a FOREIGN-SCOPE
     * event, and on a refusal of a finished row that answers a person —
     * counted at the top of the refusal arm, from the same predicate the
     * branches use, so a condition added INSIDE a site drops its numerator
     * while its denominator stands.
     */
    private val timesProducedOnAForeignScopeRefusal = mutableMapOf<String, Int>()

    /**
     * How many times each code was produced on a CAPTURED row by a session
     * whose event is permitted — the other producer of
     * `offline.another_members_capture`, which is E-04's own arm. It exists so
     * that the one claim with a narrower domain has its excluded productions
     * ACCOUNTED FOR rather than merely declared: the two counts must add up to
     * every production of that code, so a third producer reds.
     */
    private val timesProducedOnACaptureSomebodyElseMustConfirm = mutableMapOf<String, Int>()

    /**
     * Registers a claim made at `site` about `code`, and returns the code, so
     * that what is registered is the very value the claim is asserted against.
     * A registration written beside the claim could record a different code
     * from the one the claim tests; a registration that RETURNS the code it
     * registers cannot.
     *
     * These sites are exercised by construction: they register the value an
     * `assertEquals` is about to compare, so there is no branch in which the
     * registration happens and the claim does not.
     */
    private fun claimingCode(site: String, code: String): String {
        claimsMade += site to code
        claimsExercised += site to code
        timesTheBodyRan[site to code] = (timesTheBodyRan[site to code] ?: 0) + 1
        return code
    }

    /**
     * Makes the claim `site` holds about one refusal code. `claim` runs only
     * where `produced` is that code; the site is recorded as MADE either way
     * and as EXERCISED only in the branch that runs it, which is the
     * difference between a site that ran and a claim that was tested.
     */
    private fun claimAbout(site: String, code: String, produced: String, claim: () -> Unit) {
        claimsMade += site to code
        if (produced == code) {
            claimsExercised += site to code
            timesTheBodyRan[site to code] = (timesTheBodyRan[site to code] ?: 0) + 1
            claim()
        }
    }

    /**
     * A claim about a refusal code is written through `claimAbout`, by
     * CONVENTION — and this check is a convention check, not a derivation.
     *
     * Read `A_COMPARISON_AGAINST_A_CODE`'s KDoc before trusting this: it says
     * what this cannot do. Nothing derives a subject set from it, nothing
     * assumes it is complete, and a steered spelling escapes it. It is here
     * because its failure mode is the residual that already exists rather than
     * a false green, so it can only ADD reds — which is the coordinator's
     * ruling after this session disclosed the residual and the twelfth review
     * measured it: a claim written around the helper is enrolled by nothing,
     * and the tenth review's `when (step.code)` plant is green against the
     * registry alone.
     *
     * A line whose first non-blank characters begin a comment is treated as
     * prose, and this file's prose quotes these constructs often. That is a
     * HEURISTIC, and it is part of the fail-open named above: a claim written
     * on a line that looks like prose is not seen. It is not a hole in the
     * registry, which does not read this file at all.
     */
    @Test
    fun `a claim about a refusal code is written through the registering helper`() {
        val src = File(System.getProperty("p7.src") ?: "prep/phase7/kotlin/src")
        val tests = System.getProperty("p7.test")?.let(::File) ?: src.parentFile?.resolve("test")
        val own = tests?.walkTopDown()?.firstOrNull { it.isFile && it.name == "QueueModelCheckTest.kt" }
        assertTrue(
            own != null && own.isFile,
            "this check could not find its own source under ${tests?.path}. It fails rather than " +
                "finds nothing: a convention check that silently reads an empty file is the one " +
                "failure mode worse than the convention being unenforced",
        )
        val text = own!!.readText()
        val offenders = text.lines().withIndex().filter { (_, line) ->
            val code = line.trimStart()
            val prose = code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")
            !prose && A_COMPARISON_AGAINST_A_CODE.any { it in code }
        }.map { (i, line) -> "${i + 1}: ${line.trim()}" }
        assertEquals(
            emptyList(), offenders,
            "a refusal code is compared outside ${"claimAbout"}, so whatever is claimed there is " +
                "enrolled in neither registry and is asserted of nothing the moment the code " +
                "stops being produced. Write it as a claim site. This is a CONVENTION CHECK and " +
                "not a derivation: it can only add reds, and a spelling it does not know escapes " +
                "it",
        )
        // Non-vacuity. The patterns must be able to find something, or this
        // check passes by not looking: the list is exercised against a line of
        // each shape it forbids, assembled so that this file does not contain
        // the shapes it is checked against.
        val eq = "step.code" + " == " + "\"offline.x\""
        val sw = "when (" + "step.code" + ")"
        for (shape in listOf(eq, sw)) {
            assertTrue(
                A_COMPARISON_AGAINST_A_CODE.any { it in shape },
                "none of this check's patterns matches $shape, so it would not notice the " +
                    "construct it exists to forbid",
            )
        }
        assertTrue(
            A_COMPARISON_AGAINST_A_CODE.none { it in "codesSeen += step.code" },
            "this check's patterns match a plain READ of the code, so it forbids the reads this " +
                "file is built on rather than the comparisons it means to forbid",
        )

        // S-01, the fifteenth review: a cover is checked for the STRENGTH of
        // its domain and for its RATIO, never for WHAT IT ASSERTS. A claim
        // whose body cannot fail satisfies both halves, because a body that
        // asserts nothing still RUNS on every production of its code — and the
        // review measured that with a decoy cover and E-04's harm live: 99 of
        // 99, with this session's own E-04 proof STAYING GREEN.
        //
        // Nothing inside this file can close that. An instrument in the subject
        // can bind a claim's EXISTENCE, its DECLARATION and its FREQUENCY; what
        // a claim MEANS is bound by a defect planted against it, which is what
        // `tools/red_proofs.py` is for. So the obligation is written where it
        // can be enforced and the reference is written here: every claim named
        // as a cover must have a red proof of its own, the harness requires one
        // by EXECUTION — it reads the lines printed below from a RUN of this
        // suite, not from this file's text, and matches them against the proofs
        // that actually reddened in that run — and a cover with no such proof
        // fails the harness. **And the harness is a required step in no gate
        // and no workflow**, which is round 14's R-02 and is still true, so
        // this obligation is conditional on the harness being run at a head.
        for ((claim, cover) in WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT) {
            if (cover is WhatCoversTheRest.AnotherClaimOverEveryProduction) {
                println("P7-COVER-CLAIM|${cover.site}|${claim.second}")
            }
        }

        // FAIL-CLOSED, by declaration and before any measurement: a claim
        // declared over a domain narrower than every production of its code
        // must say here what covers the productions it leaves out. The
        // coordinator's condition on the fourteenth review's R-01 is that a
        // new `ClaimDomain` value be a FAILURE until its accounting exists,
        // not merely that the gap be noticed once a search measures one. The
        // count equality in the other test reds on a measured gap with no
        // cover; this reds on the DECLARATION, so a new narrow domain whose
        // gap this particular search happens not to reach is a red here as
        // well. The denominator's own `when` is exhaustive with no `else`, so
        // the compiler already refuses a value with no denominator: between
        // the three, a domain cannot be added quietly.
        for ((claim, domain) in CLAIMS_THIS_CHECK_MAKES) {
            if (domain == ClaimDomain.EVERY_PRODUCTION) continue
            assertTrue(
                claim in WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT,
                "the claim ${claim.first} about ${claim.second} is declared over $domain, which is " +
                    "narrower than every production of its code, and nothing in " +
                    "WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT says what covers the productions it " +
                    "leaves out. A narrow domain with no declared cover is a claim about part of a " +
                    "code and silence about the rest",
            )
        }

        // And a site's LABEL names one site, which is the other half of the
        // same convention.
        //
        // The thirteenth review's Q-02: a second claim written under an
        // existing site's label is not forgery — `INV-9a/…` already labels two
        // pairs, so a second claim under one invariant inherits the label by
        // copy-paste. The count equality catches that version, because two
        // sites under one label run 2N times against a denominator of N. It
        // does NOT catch a DECOY: a site under a copied label that runs the
        // same number of times and asserts nothing, with the real claim's
        // assertions deleted. Measured on this tree, with E-04's refusal arm
        // deleted underneath it, that is green — so the registry's promise
        // that a removed claim site goes missing by name holds against a
        // plausible edit and not against a deliberate one.
        //
        // This closes the deliberate one at the only place it can be seen: a
        // label occurs once where its site is, plus once for each pair
        // declared under it, plus once wherever a COVER names it — and the
        // last of those three is counted from the declared maps, never from
        // the text, so a label cannot buy itself an extra occurrence by being
        // written into a comment or a string. It is part of the CONVENTION
        // CHECK and carries the same fail-open as the rest of it — it reads
        // text, and it is not what the registry relies on.
        for ((site, pairs) in CLAIMS_THIS_CHECK_MAKES.keys.groupBy { it.first }) {
            val occurrences = text.lines().count { line ->
                val code = line.trimStart()
                val prose = code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")
                !prose && site in code
            }
            val namedByACover =
                WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT.keys.count { it.first == site } +
                    WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT.values.count {
                        it is WhatCoversTheRest.AnotherClaimOverEveryProduction && it.site == site
                    }
            val expected = pairs.size + 1 + namedByACover
            assertEquals(
                expected, occurrences,
                "the label $site occurs $occurrences times in this file's code, and it is " +
                    "declared for ${pairs.size} claim(s) and named by $namedByACover cover(s), so " +
                    "it should occur $expected times: once for each declaration, once for each " +
                    "cover that names it, and once at the single site that carries it. A label on " +
                    "two sites makes the registry's pairs collapse, which is how a site that " +
                    "asserts nothing can stand in for one that does",
            )
        }
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
        var terminalRefusals = 0
        // U-01, the seventeenth review, and the fourth appearance of one family
        // — Q-01 the site, R-01 the denominator, S-01 the cover, U-01 the
        // counter. A literal total on a counter bounds how many rows the gate
        // ADMITS and says nothing about whether the judgment on the next line
        // still runs: `waitsJudged++` and the `assertTrue` beneath it were two
        // statements with nothing tying them. Measured, three plants, each the
        // suite's whole 99 of 99 GREEN at rc 0 with every anchor passing:
        // deleting the wait assertion while keeping the increment; the same for
        // the transmission assertion, the judgment this file's previous round
        // exists to protect; and keeping the assertion but skipping it for
        // UNKNOWN_OUTCOME rows with the counter untouched — the judgment then
        // evaluated for 609 of 939 rows. So the sentence "these bound the LOSS"
        // was measured FALSE for the plainest loss there is, and the true one is
        // narrower: a total bounds the gate's reach.
        //
        // The judgment and its count are now ONE statement. Deleting the
        // judgment deletes the count, and the counts are kept PER STATE, so a
        // predicate narrowed to skip a state drops that state's total to zero
        // rather than hiding inside a surviving sum. The per-state figures are
        // the ones the sixteenth review's own probe measured.
        val judgmentsByState = mutableMapOf<Pair<String, OperationState>, Int>()
        fun judged(name: String, state: OperationState, holds: Boolean, message: () -> String) {
            judgmentsByState[name to state] = (judgmentsByState[name to state] ?: 0) + 1
            if (!holds) fail(message())
        }
        // The helper's own arm, and it is here rather than in a review's notes
        // because deleting the `if (!holds)` line above is a ONE-LINE edit that
        // no count can catch: every count would survive it and every anchor
        // would pass while nothing in this loop judged anything. So a judgment
        // known false is put to the helper on every run, under a name of its
        // own, and the helper must refuse it.
        var theHelperRefusedAKnownFalseJudgment = false
        try {
            judged("the helper's own arm", OperationState.QUEUED, false) { "a known-false judgment" }
        } catch (expected: AssertionError) {
            theHelperRefusedAKnownFalseJudgment = true
        }
        assertTrue(
            theHelperRefusedAKnownFalseJudgment,
            "the helper that counts and judges in one statement did not refuse a judgment known " +
                "to be false, so it has stopped judging and every count below counts nothing",
        )
        // The coordinator's F-E, one layer in, and the reason a count was never
        // going to be enough. Deleting a judgment now takes its count with it,
        // but REPLACING a judgment's predicate with `true` leaves every row
        // arriving and every total holding: a count sees REACH and never
        // CONTENT. Measured at the head before this one, with the transmission
        // predicate hollowed to `true` and nothing else touched: the suite is
        // 99 of 99 GREEN, and the harness exits 1 only because F-2 refuses a
        // substitution — the kernel plant written for that judgment moves the
        // WAIT counter to 1077 and the wait anchor reds first, so the declared
        // refusal never prints. That is an incidental catch by an unrelated
        // anchor, in a program that is a step in no gate, and it is the third
        // time this round that an incidental catch has been mistaken for an
        // instrument.
        //
        // So each judgment's predicate is NAMED and put a case it must refuse
        // and a case it must accept, on every run. The loop and the arm read
        // the SAME function, so a predicate replaced by `true` reds here by
        // name rather than somewhere else by luck. Two cases each, because a
        // predicate stuck at `false` is as wrong as one stuck at `true` and
        // would otherwise pass the refusal case alone.
        fun aWaitIsHonest(state: OperationState) = state in somethingIsGenuinelyPending
        fun aTransmissionIsHonest(attempts: Int) = attempts > 0
        assertFalse(
            aWaitIsHonest(OperationState.CAPTURED),
            "the WAIT judgment's own predicate accepts a CAPTURED row, a row with nothing pending " +
                "on the device, so it would pass a till that tells a cashier to wait for a " +
                "transmission that was never started",
        )
        assertTrue(
            aWaitIsHonest(OperationState.IN_FLIGHT),
            "the WAIT judgment's own predicate refuses an IN_FLIGHT row, so it is stuck at false " +
                "and judges nothing it is written to judge",
        )
        assertFalse(
            aTransmissionIsHonest(0),
            "the TRANSMISSION judgment's own predicate accepts a row with no attempt, so a refusal " +
                "with nothing sent could be shown to a cashier as something that left the " +
                "device, which is the promise this phase exists to keep",
        )
        assertTrue(
            aTransmissionIsHonest(1),
            "the TRANSMISSION judgment's own predicate refuses a row with one attempt, so it is " +
                "stuck at false and judges nothing it is written to judge",
        )
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

                            // The DENOMINATORS, counted here and not inside
                            // the branches, which is what makes a condition
                            // added inside a claim site visible: the numerator
                            // falls and the denominator does not.
                            timesTheCodeWasProduced[step.code] =
                                (timesTheCodeWasProduced[step.code] ?: 0) + 1
                            val aForeignScopeRefusal = event is QueueEvent.ByScope &&
                                !permittedToAct(event.actingScope, op.scope, event)
                            if (aForeignScopeRefusal) {
                                timesProducedOnAForeignScopeRefusal[step.code] =
                                    (timesProducedOnAForeignScopeRefusal[step.code] ?: 0) + 1
                            }
                            if (!aForeignScopeRefusal && op.state == OperationState.CAPTURED) {
                                timesProducedOnACaptureSomebodyElseMustConfirm[step.code] =
                                    (timesProducedOnACaptureSomebodyElseMustConfirm[step.code] ?: 0) + 1
                            }
                            val aFinishedRowAnsweringAPerson = op.isTerminal &&
                                event !is QueueEvent.RetentionDeadlineReached &&
                                (
                                    event !is QueueEvent.ByScope ||
                                        permittedToAct(event.actingScope, op.scope, event)
                                    )

                            // E-04, first half: `not_sendable`'s view says
                            // "confirm this capture", so it may be refused
                            // only where that instruction is true — a CAPTURED
                            // row, and an actor who may confirm it. The
                            // expectation is written from the acting scope
                            // here, not read from the kernel, and the question
                            // "may this session confirm" is asked of the test's
                            // own independent `permittedToAct` with a Release.
                            claimAbout(
                                "E-04/not-sendable-offers-a-button-its-reader-can-press",
                                "offline.not_sendable",
                                step.code,
                            ) {
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

                            // INV-9c, added for the fourteenth review's R-01.
                            // `offline.another_members_capture` has two
                            // producers — a foreign-scope refusal inside one
                            // business, and E-04's own arm on a CAPTURED row —
                            // and INV-9a judges only the first of them. What
                            // is true of BOTH is the sentence the merchant is
                            // shown: this is somebody else's capture, so this
                            // session may not release it. Asserted over every
                            // production of the code, which is what makes it a
                            // cover for INV-9a's narrower domain rather than a
                            // counter that measures the gap and judges none of
                            // it. The question is asked of this file's own
                            // `permittedToAct` with a Release, never of the
                            // kernel's `mayAct`.
                            claimAbout(
                                "INV-9c/a-colleagues-capture-is-refused-only-where-the-actor-may-not-release-it",
                                "offline.another_members_capture",
                                step.code,
                            ) {
                                val acting = (event as? QueueEvent.ByScope)?.actingScope
                                    ?: fail(
                                        "offline.another_members_capture was refused on $event, which no " +
                                            "session performs, so there is no actor whose release it " +
                                            "could be about: $op",
                                    )
                                assertFalse(
                                    permittedToAct(acting, op.scope, QueueEvent.Release(acting)),
                                    "a session that MAY release this row was told it is another member's " +
                                        "capture (offline.another_members_capture), whose view tells the " +
                                        "merchant a colleague must confirm it: $op on $event",
                                )
                            }
                            if (aForeignScopeRefusal) {
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
                                        "INV-9a/a-foreign-scope-is-refused-as-a-scope-problem",
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
                            if (aFinishedRowAnsweringAPerson) {
                                terminalRefusals++
                                assertEquals(
                                    claimingCode(
                                        "INV-15/a-finished-row-answers-in-its-own-terms",
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
                                judged("waits", op.state, aWaitIsHonest(op.state)) {
                                    "a ${op.state} row refused ${step.code}, which tells the merchant to " +
                                        "wait (${view.message} / ${view.action}) while nothing is pending: " +
                                        "$op on $event"
                                }
                            }
                            if (view.message in assertsSomethingLeftTheDevice) {
                                // T-02, the sixteenth review: this judgment was
                                // the one gated branch in this loop with no
                                // counter at all, so narrowing its condition
                                // removed it in silence. It is counted now, and
                                // the count is pinned with the others below.
                                judged("transmissions", op.state, aTransmissionIsHonest(op.attempts)) {
                                    "a refusal with nothing sent (${step.code}) is shown as " +
                                        "${view.message}, which asserts a transmission: $op on $event"
                                }
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

        // The claim registry and its two anchors, asserted FIRST because they
        // are the assertions that say which of the others were real.
        //
        // Each claim site above registers the pair (site, code) when it RUNS,
        // and the branch that runs its body registers the same pair as
        // EXERCISED. Both are asserted against the same literal total, and the
        // second is the one the twelfth review's blocker needed: a site
        // wrapped in a condition that is reached but excludes the cases its
        // claim is about registers as made, never as exercised, and the claim
        // is gone while the registry says it was made.
        //
        // Keyed on PAIRS, because an anchor bounds the loss of the thing that
        // can be lost and what can be lost is a site: two sites about one code
        // collapsed into one member when this was keyed on codes.
        assertEquals(
            CLAIMS_THIS_CHECK_MAKES.keys.toSortedSet(compareBy({ it.first }, { it.second })),
            claimsMade.toSortedSet(compareBy({ it.first }, { it.second })),
            "the claims this check REGISTERED are not the claims it is written to make. A pair " +
                "missing from the right-hand side is a claim site nothing evaluated at all; a " +
                "pair missing from the left is a claim site that was added without being written " +
                "down here, so nothing bounds what else it changed",
        )
        assertEquals(
            CLAIMS_THIS_CHECK_MAKES.keys.toSortedSet(compareBy({ it.first }, { it.second })),
            claimsExercised.toSortedSet(compareBy({ it.first }, { it.second })),
            "a claim this check makes was never EXERCISED: its site ran and registered, and the " +
                "branch that tests the claim never did, so whatever it asserts was asserted of " +
                "nothing. A site reached under a condition that excludes the cases its claim is " +
                "about looks identical to a working one in every other assertion here, which is " +
                "how a refusal telling a cashier that a colleague must confirm their own capture " +
                "stayed green at 98 of 98",
        )

        // And the COUNT, which is the assertion the two above could not make.
        //
        // The thirteenth review's Q-01: a registration of exercise says the
        // claim ran once SOMEWHERE in the search. Wrapping this file's E-04
        // site in its own precondition — `event !is ByScope ||
        // permittedToAct(…, Release(…))`, the very condition its second
        // assertion exists to judge — leaves the site running, the body
        // running, both sets complete, and only the rows that matter excluded.
        // With E-04's refusal arm deleted underneath, that was 99 of 99 GREEN.
        //
        // So each claim is read as a RATIO against the domain declared for it:
        // the body must have run as many times as the code was produced in
        // that domain. A wrapper drops the numerator and the shortfall is
        // named. Two sites sharing one label show as 2N against N, which is
        // what bounds a reused label (Q-02) without a convention about
        // labelling. The denominators are counted at the top of the refusal
        // arm, never inside the branch a site sits in.
        for ((claim, domain) in CLAIMS_THIS_CHECK_MAKES) {
            val (site, code) = claim
            val ran = timesTheBodyRan[claim] ?: 0
            val denominator = when (domain) {
                ClaimDomain.EVERY_PRODUCTION -> timesTheCodeWasProduced[code] ?: 0
                ClaimDomain.ON_A_FOREIGN_SCOPE_REFUSAL ->
                    timesProducedOnAForeignScopeRefusal[code] ?: 0
            }
            assertTrue(
                denominator > 0,
                "nothing in the reachable space produced $code inside the domain $domain " +
                    "declared for the claim at $site, so the count below is a ratio of nothing " +
                    "to nothing and would hold however little the claim ran",
            )
            assertEquals(
                denominator, ran,
                "the claim at $site about $code ran $ran times where its declared domain " +
                    "$domain was reached $denominator times. A claim that runs on some of its " +
                    "cases is asserted of the rest not at all, and a site reached under a " +
                    "condition that excludes the cases its claim is about registers and counts " +
                    "exactly like a working one until this ratio is read",
            )
            // The fourteenth review's R-01. A narrow domain leaves
            // productions of its code outside what the claim judges, and the
            // gap used to be read only for the one domain written so far —
            // `if (domain == ON_A_FOREIGN_SCOPE_REFUSAL)` — so a THIRD domain
            // got a denominator and no accounting, with the compiler silent.
            // The gap is now found by MEASURING it, so no later domain can be
            // added past it, and a gap must be covered by something NAMED: a
            // complement counter is not a cover, because an author adds it
            // from the very predicate that narrowed the site and the partition
            // then holds by construction.
            val productionsOutsideTheDeclaredDomain = (timesTheCodeWasProduced[code] ?: 0) - denominator
            assertTrue(
                productionsOutsideTheDeclaredDomain >= 0,
                "the domain $domain declared for the claim at $site was reached $denominator times " +
                    "while $code was produced ${timesTheCodeWasProduced[code]} times in all, so the " +
                    "denominator counts rows the total does not and one of the two counters is wrong",
            )
            if (productionsOutsideTheDeclaredDomain > 0) {
                val cover = WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT[claim]
                    ?: fail(
                        "the claim at $site is declared over $domain, which was reached $denominator " +
                            "times, while $code was produced ${timesTheCodeWasProduced[code]} times in " +
                            "all. The $productionsOutsideTheDeclaredDomain productions outside it are " +
                            "judged by this claim not at all, and nothing in " +
                            "WHAT_COVERS_WHAT_A_NARROW_CLAIM_LEAVES_OUT names what does cover them",
                    )
                when (cover) {
                    is WhatCoversTheRest.AnotherClaimOverEveryProduction -> assertEquals(
                        ClaimDomain.EVERY_PRODUCTION,
                        CLAIMS_THIS_CHECK_MAKES[cover.site to code],
                        "the gap the claim at $site leaves is declared to be covered by the claim at " +
                            "${cover.site} about $code over every production, and that claim is not in " +
                            "CLAIMS_THIS_CHECK_MAKES with that domain, so the cover names nothing that " +
                            "judges those $productionsOutsideTheDeclaredDomain productions",
                    )
                    is WhatCoversTheRest.NothingIsLeftOut -> {
                        assertTrue(
                            cover.why.isNotBlank(),
                            "the claim at $site declares that nothing falls outside $domain and gives " +
                                "no reason, and a reason nobody wrote is a reason nobody can check",
                        )
                        assertEquals(
                            0, productionsOutsideTheDeclaredDomain,
                            "the claim at $site declares that nothing falls outside $domain " +
                                "(${cover.why}), and $productionsOutsideTheDeclaredDomain productions " +
                                "of $code fall outside it. A reason is not a measurement",
                        )
                    }
                }
            }
            if (domain == ClaimDomain.ON_A_FOREIGN_SCOPE_REFUSAL) {
                // Kept as a SECOND and independent reading of the same facts,
                // and no longer the accounting itself: every production of
                // this code is either a foreign-scope refusal, which this
                // claim judges, or E-04's own arm on a CAPTURED row. A third
                // producer of the same code reds here as well as above.
                assertEquals(
                    timesTheCodeWasProduced[code] ?: 0,
                    denominator + (timesProducedOnACaptureSomebodyElseMustConfirm[code] ?: 0),
                    "$code is produced ${timesTheCodeWasProduced[code]} times, and the two " +
                        "classes this check accounts for — a foreign-scope refusal and a " +
                        "capture somebody else must confirm — cover only $denominator plus " +
                        "${timesProducedOnACaptureSomebodyElseMustConfirm[code]}. The claim at " +
                        "$site is declared over the narrower of them, so a third producer " +
                        "would sit in the difference judged by nothing",
                )
            }
        }

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
        // The four codes `WaitIsHonest` licenses a wait for are obligations
        // this check inherits — `RecoveryTest` proves its view equality over
        // them, and that equality is blind to a code nothing produces any more
        // (E-04), so each must be OBSERVED in the reachable space here. They
        // are read from that declaration as a VALUE, which is the eleventh
        // review's ruling, and they are NOT registered as claims of this file:
        // registering them put them on both sides of an equality that then
        // could not fail for them (P-04).
        val claimed = claimsExercised.map { it.second }.toSet() + WaitIsHonest.reasons.keys
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
        val waitsJudged = judgmentsByState.entries.filter { it.key.first == "waits" }.sumOf { it.value }
        val transmissionsJudged =
            judgmentsByState.entries.filter { it.key.first == "transmissions" }.sumOf { it.value }
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
        // S-02, the fifteenth review. The numerator and the denominator of a
        // narrow claim are gated by ONE expression — deliberately, because two
        // copies of a predicate drift apart — and the consequence is that
        // NARROWING that expression moves both: the ratio holds by
        // construction, the complement counter absorbs exactly what the
        // narrowing expelled, and every R-01 instrument stays green. Five
        // lines added inside the existing `&&` chain, with no new value, claim
        // or map entry, were measured at 99 of 99, and the model check then
        // stopped judging which CODE and which LAW a colleague's captured row
        // is refused with, silently.
        //
        // A ratio cannot see that, so these are LITERAL TOTALS per class: an
        // anchor that bounds the LOSS rather than one a narrowing preserves.
        // They are facts about this kernel's reachable space at this head, and
        // they are meant to be brittle — a change to what the space produces
        // must be a deliberate edit here, with the reason in the commit, and
        // never an unnoticed consequence of narrowing a predicate somewhere
        // else. The totals, not merely their sum: a narrowing that moves rows
        // from one class to the other keeps the sum and breaks a class.
        assertEquals(
            1_131, timesTheCodeWasProduced["offline.another_members_capture"] ?: 0,
            "the reachable space produces offline.another_members_capture a different number of " +
                "times than this anchor records",
        )
        assertEquals(
            1_125, timesProducedOnAForeignScopeRefusal["offline.another_members_capture"] ?: 0,
            "a different number of offline.another_members_capture refusals is now classed as a " +
                "foreign-scope refusal, which is the class INV-9a judges",
        )
        assertEquals(
            6, timesProducedOnACaptureSomebodyElseMustConfirm["offline.another_members_capture"] ?: 0,
            "a different number of offline.another_members_capture refusals is now classed as a " +
                "capture somebody else must confirm",
        )
        assertEquals(2_925, foreignScopeRefusals, "a different number of foreign-scope refusals")
        assertEquals(969, terminalRefusals, "a different number of refusals of a finished row")
        // T-02, the sixteenth review. The five anchors above bound the loss of
        // the two classes the fifteenth review happened to attack, and the
        // review that answered it left nine other gated judgments in this loop
        // bounded by `> 0` — witness survival, which a narrowing cannot break
        // while one witness remains.
        //
        // U-02, the seventeenth review, correcting what this comment used to
        // say. It credited the sixteenth review's own two plants with removing
        // "two judgments this phase exists to make". That is FALSE and its
        // author has withdrawn it: both plants exclude CAPTURED rows, and
        // CAPTURED reaches neither judgment — it is absent from
        // `somethingIsGenuinelyPending` and carries `attempts == 0`, so such a
        // row at either branch would fail the assertion that branch makes.
        // Re-measured against THIS head rather than quoted: both are 99 of 99
        // GREEN at rc 0 with every total in place, and their cost is ZERO
        // judgments. A plant that changes nothing measures nothing. The shape
        // the review named was real; its demonstration was not, and the
        // demonstration that works excludes a state the space does produce,
        // which is what the two proofs for these anchors plant.
        //
        // So every counter in this loop carries a LITERAL TOTAL. The `> 0`
        // assertions above are kept for what they say that a total does not —
        // that a zero would make a named invariant vacuous — and these bound
        // the LOSS. They are deliberately brittle: a change to what the
        // reachable space produces is a deliberate edit here, with its reason
        // in the commit, and never a silent consequence of narrowing a
        // condition somewhere else.
        assertEquals(7_650, edges, "a different number of edges was explored")
        assertEquals(6_876, refusals, "a different number of events was refused")
        assertEquals(
            75, nextShiftSends,
            "a different number of events under another member of the same business moved a row",
        )
        assertEquals(
            3, releasesOfAnUnsentRow,
            "a different number of releases moved an unsent row, which is the ground INV-13's " +
                "relaxation stands on",
        )
        assertEquals(
            75, custodyRecords,
            "a different number of moves was made by a session other than the row's own",
        )
        assertEquals(
            6, custodyRecordsBeforeAnErase,
            "a different number of foreign-session moves erased the local row",
        )
        assertEquals(
            276, refusalsWithNothingSent,
            "a different number of refusals was produced with nothing sent",
        )
        assertEquals(
            939, waitsJudged,
            "a different number of refusals was judged for telling the merchant to wait while " +
                "nothing is pending, which is the judgment a narrowing of that condition removes " +
                "in silence",
        )
        assertEquals(
            312, transmissionsJudged,
            "a different number of refusals was judged for being shown as something that left " +
                "the device, which is the judgment that had no counter at all until T-02",
        )
        // U-01, per STATE. The totals above bound the gate's reach; these bound
        // it per class, because a predicate narrowed to skip one state keeps a
        // surviving sum plausible while that state is judged not at all. The
        // figures are the reachable space's own, and they sum to the two totals.
        assertEquals(
            mapOf(
                "waits" to mapOf(
                    OperationState.QUEUED to 399,
                    OperationState.IN_FLIGHT to 210,
                    OperationState.UNKNOWN_OUTCOME to 330,
                ),
                "transmissions" to mapOf(
                    OperationState.QUEUED to 72,
                    OperationState.IN_FLIGHT to 180,
                    OperationState.UNKNOWN_OUTCOME to 60,
                ),
                "the helper's own arm" to mapOf(OperationState.QUEUED to 1),
            ),
            judgmentsByState.entries
                .groupBy { it.key.first }
                .mapValues { (_, rows) -> rows.associate { it.key.second to it.value } },
            "a different number of rows reached a counted judgment, PER STATE. A judgment " +
                "deleted takes its whole row with it; a condition narrowed to skip one state " +
                "drops that state to nothing while the sum stays plausible",
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
        val replayedValues = listOf(null, false, true)
        val retryAfterValues = listOf<Long?>(null, 0, 30, 86_400)
        // R-03, found while recording the sixteenth review's withdrawal of
        // T-02, in the one loop neither that review nor the fifteenth looked
        // at. This sweep used to end at
        //     assertEquals(700 * codes.size * 3 * 4, swept)
        // — a total computed from the very lists it sweeps, which is exactly
        // the class this lane has now retired twice: a narrowing moves BOTH
        // terms, so the equality is preserved by construction and the anchor
        // bounds nothing. Measured rather than inferred: deleting
        // `accounting.period_closed` from the list above left the WHOLE suite
        // at 99 of 99 GREEN, rc 0, with this assertion in place, because
        // `codes.size` fell from 7 to 6 along with it.
        //
        // So the domain is pinned HERE, by VALUE and by LITERAL size, and the
        // total below is a literal. An edit that narrows the list AND this pin
        // together is the declared limit of a check that lives inside its own
        // subject, bounded by review and not by this file.
        assertEquals(
            listOf(
                null, "", "IDEMPOTENCY_KEY_REUSED", "accounting.idempotency_conflict",
                "inventory.insufficient_stock", "VALIDATION_FAILED", "accounting.period_closed",
            ),
            codes,
            "THE-SWEEPS-DOMAIN-CHANGED: the server codes this sweep covers are not the ones it " +
                "claims to cover, so the lemma that reads its result is reading a narrower " +
                "search than it says. codes = $codes",
        )
        assertEquals(
            3, replayedValues.size,
            "THE-SWEEPS-DOMAIN-CHANGED: the replayed dimension no longer carries three values, " +
                "so the total below no longer counts what it names",
        )
        assertEquals(
            4, retryAfterValues.size,
            "THE-SWEEPS-DOMAIN-CHANGED: the retry-after dimension no longer carries four " +
                "values, so the total below no longer counts what it names",
        )
        var swept = 0
        for (status in 0..699) {
            for (code in codes) {
                for (replayed in replayedValues) {
                    for (ra in retryAfterValues) {
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
        assertEquals(
            58_800, swept,
            "THE-SWEEPS-TOTAL-CHANGED: a different number of classifier answers was swept; " +
                "700 statuses x 7 codes x 3 replayed values x 4 retry-after values is 58800",
        )
    }
}
