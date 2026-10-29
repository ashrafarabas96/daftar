package app.daftar.offline

/**
 * What a queued operation would move if it landed.
 *
 * The distinction carries real authority and is not a label: a material
 * operation may never be dropped, dead-lettered or auto-resolved (L4), while a
 * benign one may be abandoned by the merchant once the server has refused it.
 * Classifying a sale, a payment, a refund, a stock movement or a stocktake as
 * BENIGN is the single most dangerous mistake available in this file, so the
 * classification belongs beside each command's own definition and never
 * defaults: `EffectClass` has no default value anywhere in this kernel.
 */
enum class EffectClass {
    /** Moves money: a sale, a payment, an allocation, a refund, a credit note. */
    FINANCIAL,

    /** Moves stock: a movement, a transfer, an adjustment, a stocktake count. */
    INVENTORY,

    /** Moves neither: a product rename, a locale preference, a media attachment. */
    BENIGN,
    ;

    val isMaterial: Boolean
        get() = this == FINANCIAL || this == INVENTORY
}

/**
 * What came back from one attempt.
 *
 * `NoAnswer` deliberately collapses a connection refusal, a reset, a read
 * timeout and a process death that happened mid-flight into ONE value, and
 * that collapse is the point rather than a loss of detail. The tempting
 * refinement — treating "connection refused" as proof the request never
 * arrived — is false in this deployment: requests traverse a TLS-terminating
 * proxy and a load balancer, either of which can accept a request, forward it
 * to an API process that commits it, and then fail the client's connection. A
 * transport-level diagnosis cannot distinguish "never applied" from "applied,
 * answer lost", so the kernel refuses to pretend it can, and every member of
 * this class resolves the same way: by replay (L7).
 */
sealed interface AttemptResult {
    /** The server answered this attempt. */
    data class Answered(
        val status: Int,
        val errorCode: String?,
        /** The API's own `replayed` flag where the endpoint carries one. */
        val replayed: Boolean?,
        val retryAfterSeconds: Long?,
    ) : AttemptResult

    /** No answer reached the device. The outcome is UNKNOWN, not failed. */
    data object NoAnswer : AttemptResult
}

/** What the kernel decides to do about one attempt's result. */
sealed interface Decision {
    /** The id of the law this decision enforces. */
    val law: String

    /** The server's truth is established. `replayed` says whether this attempt wrote it. */
    data class Synced(val replayed: Boolean, override val law: String) : Decision

    /** The server declined to answer yet; it did not apply anything. Send again later. */
    data class Retry(val afterMs: Long, override val law: String) : Decision

    /**
     * The outcome is unknown. Sending the SAME key again is the only way to
     * learn it, and is safe precisely because the key is the source identity.
     */
    data class ResolveByReplay(val afterMs: Long, override val law: String) : Decision

    /**
     * A human must decide. `code` is the server's refusal code, preserved
     * verbatim — never translated, mapped or widened here, because the merchant
     * UI and the support path both read it.
     */
    data class NeedsAttention(
        val code: String,
        /**
         * True when the server reported that this key was already used with a
         * DIFFERENT payload. That is not a merchant mistake and not a business
         * conflict: it proves L3 was broken somewhere on the device, so it is
         * surfaced as a defect and the row is kept for diagnosis.
         */
        val diverged: Boolean,
        override val law: String,
    ) : Decision
}
