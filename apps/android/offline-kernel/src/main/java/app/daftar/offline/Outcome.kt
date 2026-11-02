package app.daftar.offline

/**
 * The classifier: one attempt's result becomes one decision.
 *
 * This is the kernel's whole safety surface, so it is a total function over
 * the input space rather than a chain of happy-path cases with a fallthrough.
 * The property that matters, and that `OutcomeExhaustiveTest` proves over
 * every status in 0..699 against every refusal code the kernel knows:
 *
 *   # THERE IS NO PATH FROM AN UNANSWERED ATTEMPT, OR FROM ANY NON-2xx
 *   # ANSWER, TO `Synced`.
 *
 * `Synced` is reachable only from a 2xx, which is the only thing that means
 * the server committed (L1). Everything else is unknown, waiting, or a human's
 * decision — and the three are kept apart, because collapsing "unknown" into
 * "failed" is how an offline queue loses a sale, and collapsing it into "done"
 * is how it duplicates one.
 */
object Outcome {
    /**
     * The refusal codes that mean THIS KEY WAS USED WITH A DIFFERENT PAYLOAD.
     *
     * Taken from the live API, not from a convention: the tenancy module
     * raises `IDEMPOTENCY_KEY_REUSED`
     * (`apps/api/src/modules/tenancy/tenancy.service.ts`) and the accounting
     * modules raise a domain-prefixed `*.idempotency_conflict`. Both are
     * matched, and the suffix rule is what keeps the detection semantic rather
     * than a list of spellings that a new domain silently falls out of — a
     * detector that must be edited every time a module is added is a detector
     * that will eventually be wrong without anything turning red.
     */
    private const val REUSED_KEY_CODE = "IDEMPOTENCY_KEY_REUSED"
    private const val CONFLICT_SUFFIX = ".idempotency_conflict"

    fun isDivergence(errorCode: String?): Boolean {
        val code = errorCode?.trim() ?: return false
        return code == REUSED_KEY_CODE || code.endsWith(CONFLICT_SUFFIX)
    }

    /** The code used when the server refused but named nothing. */
    const val UNNAMED_REFUSAL = "offline.refused_without_code"

    /** The session died and a refresh did not restore it. */
    const val SESSION_EXPIRED = "offline.session_expired"

    /** Authority was removed server-side between capture and send. */
    const val PERMISSION_REVOKED = "offline.permission_revoked"

    /**
     * Classify one attempt.
     *
     * @param attempt   how many attempts have now been made, 1-based, so the
     *                  delay for the next one can be derived.
     * @param operationId the stable local id, which is also the idempotency
     *                  key — the backoff schedule is derived from it so that
     *                  it survives process death.
     */
    fun classify(result: AttemptResult, operationId: String, attempt: Int): Decision {
        require(attempt >= 1) { "an attempt is counted from 1 (got $attempt)" }
        val nextDelay = Backoff.delayMs(operationId, attempt + 1)

        if (result is AttemptResult.NoAnswer) {
            return Decision.ResolveByReplay(nextDelay, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)
        }
        val answered = result as AttemptResult.Answered
        val status = answered.status
        val code = answered.errorCode?.trim()?.takeIf { it.isNotEmpty() }

        return when {
            // The only committed outcome there is.
            status in 200..299 ->
                Decision.Synced(answered.replayed == true, P7Laws.REPLAY_IS_SUCCESS.id)

            // 408 is the server saying it gave up READING the request. It may
            // already have read enough to commit, so this is unknown, not failed.
            status == 408 ->
                Decision.ResolveByReplay(nextDelay, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)

            // Told to wait, explicitly. The server applied nothing, so this is
            // the one 4xx family that is a plain retry. `Retry-After` is
            // honoured when it is sane; a negative or absurd value is ignored
            // in favour of the derived schedule rather than trusted.
            status == 423 || status == 429 -> {
                val advised = answered.retryAfterSeconds
                val afterMs =
                    if (advised != null && advised in 0..3_600) maxOf(advised * 1_000, Backoff.FLOOR_MS) else nextDelay
                Decision.Retry(afterMs, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)
            }

            status == 401 ->
                Decision.NeedsAttention(SESSION_EXPIRED, false, P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)

            status == 403 ->
                Decision.NeedsAttention(PERMISSION_REVOKED, false, P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)

            // The key was reused with a different payload. A device defect, and
            // reported as one: retrying cannot help, and editing the payload to
            // match would be the device deciding what the truth is.
            isDivergence(code) ->
                Decision.NeedsAttention(code ?: UNNAMED_REFUSAL, true, P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id)

            // Every other refusal the server states: a validation error, a
            // business conflict, a missing resource. None of them becomes true
            // by being sent again, so none of them is retried.
            status in 400..499 ->
                Decision.NeedsAttention(code ?: UNNAMED_REFUSAL, false, P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id)

            // The server broke after accepting the request. Whether it
            // committed first is exactly what the device cannot know.
            status in 500..599 ->
                Decision.ResolveByReplay(nextDelay, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)

            // 1xx and 3xx are not outcomes, and a status outside 100..599 is
            // not an answer at all. Neither is evidence of a commit and
            // neither is evidence against one, so both are unknown. This arm
            // is why the function is total: a shape nobody anticipated lands
            // on the safe side by construction, not by a comment asking the
            // next author to remember.
            else ->
                Decision.ResolveByReplay(nextDelay, P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id)
        }
    }
}
