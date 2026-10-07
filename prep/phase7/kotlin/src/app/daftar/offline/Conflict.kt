package app.daftar.offline

/** Which direction a disagreement was found in. */
enum class SyncDirection {
    /** The device holds a cached READ of server state and the two differ. */
    READ_PROJECTION,

    /** The device holds a captured WRITE the server has refused. */
    WRITE_COMMAND,
}

/** How a disagreement could be settled. */
enum class MergeStrategy {
    /** Server state replaces local state entirely. */
    SERVER_REPLACES,

    /** The later write by some clock wins. */
    LAST_WRITE_WINS,

    /** Fields are taken from whichever side changed each one. */
    FIELD_MERGE,

    /** Nothing is settled automatically; a person is shown both and chooses. */
    HUMAN_DECIDES,
}

/**
 * The conflict model, as a permission table rather than a paragraph.
 *
 * Phase 7's hardest line is not "resolve conflicts carefully" — it is that the
 * two kinds of disagreement an offline device can have are settled by opposite
 * rules, and that confusing them is how money gets lost:
 *
 *   * A cached READ that disagrees with the server is not a conflict at all.
 *     The cache is a projection with no authority, so the server's answer
 *     replaces it, silently and completely. Asking a merchant which version of
 *     a product list is correct would be absurd (L9).
 *
 *   * A captured WRITE the server refused is a conflict with no automatic
 *     answer. The device cannot know whether the right outcome is to amend the
 *     sale, abandon it, or count the stock again, and guessing is precisely
 *     what the directive forbids (L4).
 *
 * `LAST_WRITE_WINS` and `FIELD_MERGE` are permitted NOWHERE in this table, and
 * `ConflictTest` proves that over the whole cross product rather than
 * asserting it about one row. They are listed so that the refusal is explicit
 * and discoverable: a future author reaching for a timestamp comparison finds
 * the strategy named, and finds it empty-handed.
 */
object Conflict {
    fun permitted(direction: SyncDirection, effect: EffectClass): Set<MergeStrategy> =
        when (direction) {
            // The cache has nothing to lose, whatever it is a cache OF.
            SyncDirection.READ_PROJECTION -> setOf(MergeStrategy.SERVER_REPLACES)

            SyncDirection.WRITE_COMMAND ->
                if (effect.isMaterial) {
                    // A person, and only a person.
                    setOf(MergeStrategy.HUMAN_DECIDES)
                } else {
                    // A refused product rename may simply be let go in favour
                    // of what the server already holds.
                    setOf(MergeStrategy.HUMAN_DECIDES, MergeStrategy.SERVER_REPLACES)
                }
        }

    /** The law a particular refusal rests on, for the message the merchant sees. */
    fun lawFor(direction: SyncDirection, effect: EffectClass): String =
        when {
            direction == SyncDirection.READ_PROJECTION -> P7Laws.READ_CACHE_IS_A_PROJECTION.id
            effect.isMaterial -> P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id
            else -> P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id
        }

    /**
     * Whether a strategy may be applied, for callers that have one in hand.
     *
     * Stated as a question the caller must ask rather than as a filter it may
     * forget: `permitted(...)` returns a set, and a caller that iterates it
     * cannot reach a forbidden strategy, while a caller that acquired one from
     * somewhere else has this to go through.
     */
    fun isPermitted(strategy: MergeStrategy, direction: SyncDirection, effect: EffectClass): Boolean =
        strategy in permitted(direction, effect)
}
