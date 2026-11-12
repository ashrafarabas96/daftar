package app.daftar.offline

/**
 * The refusal codes whose merchant-facing view is allowed to say that
 * something is in progress, each with the reason it is honest.
 *
 * It is a DECLARATION, shared by the two tests that need it, and that is the
 * point. It began as a `mapOf` local to `RecoveryTest`, and this check read it
 * back out of that file's SOURCE TEXT, anchored on the words
 * `val waitIsHonest = mapOf(` and on a closing marker. The eleventh review's
 * ruling for this class of guard is that a derived subject set may not be
 * derived from a representation its subject can alter — and source text is
 * exactly that: a rename, a reflow, a consolidation of two maps into one, or a
 * `mapOf` built from a helper would each have left the reader of the text
 * finding nothing or finding too little, with nothing saying so.
 *
 * Read as a VALUE there is no spelling to get around: `RecoveryTest` asserts
 * its equality against the set of codes whose view says wait, and
 * `QueueModelCheckTest` requires every key to be OBSERVED in the reachable
 * space. Adding a code here puts it under both obligations at once, and that
 * is the only way to add one.
 */
internal object WaitIsHonest {
    val reasons: Map<String, String> = mapOf(
        "offline.already_released" to "the row is released and the device is working through it",
        "offline.cancel_after_send" to "an attempt is out and its answer has not been seen",
        "offline.no_attempt_in_flight" to "the row is queued or re-asking after a lost answer",
        "offline.already_sending" to "the attempt is out now",
    )
}
