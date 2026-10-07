package app.daftar.offline

/**
 * The retry schedule: exponential with full jitter, and DERIVED rather than
 * drawn.
 *
 * The delay is a pure function of `(operationId, attempt)`. Two consequences
 * matter more than the curve:
 *
 *   * The schedule survives process death with nothing persisted. A device
 *     killed between attempts recomputes exactly the delay it had already
 *     chosen, so a crash loop cannot reset a backed-off operation to its first
 *     short delay and hammer a server that is already struggling.
 *   * It is testable. A drawn random delay can only be asserted as a range; a
 *     derived one can be asserted as a value, which is what makes the
 *     anti-herd property below a measured fact rather than a hope.
 *
 * Jitter is per-operation, so a shop whose thousand queued operations all
 * failed at the same moment — the usual shape of an outage — does not resend
 * them in one synchronized burst when connectivity returns.
 */
object Backoff {
    /** The first delay's ceiling. */
    const val BASE_MS: Long = 1_000

    /** No delay is ever shorter than this, jitter included. */
    const val FLOOR_MS: Long = 250

    /** No delay is ever longer than this, however many attempts have failed. */
    const val CAP_MS: Long = 5 * 60 * 1_000

    /** Doubling stops here; beyond it the ceiling is CAP_MS. */
    private const val MAX_DOUBLINGS: Int = 20

    /**
     * The delay before attempt `nextAttempt` of `operationId`.
     *
     * `nextAttempt` is 1-based: the delay before the FIRST retry is
     * `delayMs(id, 2)`. There is no delay before attempt 1, and asking for one
     * is a programming error rather than a zero, because a caller that passes
     * 0 or a negative attempt has lost track of the attempt counter the
     * schedule depends on.
     */
    fun delayMs(operationId: String, nextAttempt: Int): Long {
        require(nextAttempt >= 2) {
            "the first attempt is immediate; a delay exists only before attempt 2 and later (got $nextAttempt)"
        }
        val doublings = minOf(nextAttempt - 2, MAX_DOUBLINGS)
        val ceiling = minOf(BASE_MS shl doublings, CAP_MS)
        val span = ceiling - FLOOR_MS
        if (span <= 0) return FLOOR_MS
        // A 53-bit fraction in [0, 1). `ushr` is logical, so the top bit
        // carries information like any other and must NOT be masked off
        // first: masking before the shift leaves 52 bits, which confines
        // every delay to the lower half of its window and halves the jitter
        // the anti-herd property depends on. The suite measures the spread
        // across the whole window, which is how that was found.
        val bits = mix(operationId, nextAttempt) ushr 11
        val fraction = bits.toDouble() / (1L shl 53).toDouble()
        return FLOOR_MS + (span.toDouble() * fraction).toLong()
    }

    /**
     * SplitMix64's finalizer over the operation id and the attempt.
     *
     * Chosen because its avalanche is good enough that one changed character
     * in an operation id, or one increment of the attempt, redistributes the
     * delay across the whole span — which is the only property the anti-herd
     * argument needs. It is not a cryptographic hash and nothing here needs it
     * to be: the value decides a sleep, never an identity.
     */
    private fun mix(operationId: String, attempt: Int): Long {
        var z = 0xBF58476D1CE4E5B9UL.toLong()
        for (c in operationId) {
            z = (z xor c.code.toLong()) * -0x61c8864680b583ebL
            z = z xor (z ushr 29)
        }
        z += attempt.toLong() * -0x7ee3623a03d3c83fL
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }
}
