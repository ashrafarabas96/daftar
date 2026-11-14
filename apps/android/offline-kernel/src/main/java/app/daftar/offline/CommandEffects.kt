package app.daftar.offline

/**
 * The command kind an operation carries: the domain's own name for the command
 * the device captured, not a transport path.
 */
@JvmInline
value class CommandKind(val value: String) {
    init {
        require(value.isNotBlank()) { "a command kind must name a command" }
    }

    override fun toString(): String = value
}

/**
 * Raised when a command has no registered effect class.
 *
 * It is an error rather than a fallback, and that is the whole point of the
 * class existing: the alternative to refusing is guessing, and the only
 * available guess — `BENIGN` — would classify an unregistered sale as
 * something a device may abandon on its own.
 */
class UnclassifiedCommand(val kind: CommandKind) : IllegalStateException(
    "the command '${kind.value}' has no registered effect class, so whether it moves money or stock " +
        "is unknown; its domain owner must register it (${P7Laws.NO_DEFAULT_EFFECT_CLASS.id})",
)

/**
 * Which commands move money, which move stock, and which move neither.
 *
 * **Phase 7 registers nothing here, and that is a requirement rather than an
 * omission.** The Tech Lead's ruling is that effect classification belongs
 * beside each domain's own command definition and is owned by that domain —
 * the Sales owner classifies sales, the Inventory owner classifies inventory —
 * because Phase 7 cannot know what a command it has never seen does to the
 * books. So this file holds the MECHANISM and the refusal; the entries arrive
 * from the owners, through `register`, at promotion.
 *
 * ── Why a refusal AND a build-time obstacle ──────────────────────────────
 *
 * `Operation.capture` takes `EffectClass` as a required argument with no
 * default, so a call site that has not decided cannot be written: that is the
 * build-time half, and it is the half that actually prevents the mistake.
 * `require` below is the run-time half, for a kind that arrives as data — from
 * a queue row written by an older build, say — where there is no call site to
 * stop. Either alone leaves a gap: a default would make the first
 * unreachable, and a compile-time-only rule cannot see a string loaded from a
 * database.
 */
/**
 * A registry of command classifications.
 *
 * An instantiable class rather than only a global, so a caller with its own
 * scope — a test, a tool, a second configuration — gets its own registry
 * instead of mutating a process-wide one. That removes the need for a
 * test-only reset hook, and a reset hook on shared mutable state is a hazard
 * in its own right: it is one accidental call away from erasing the
 * classifications a running queue depends on.
 */
open class CommandEffectRegistry {
    private val registered: MutableMap<CommandKind, EffectClass> = LinkedHashMap()

    /**
     * A domain owner declares what one of its commands moves.
     *
     * Re-registering the same kind with the same class is allowed, because a
     * module may legitimately be initialised twice. Re-registering it with a
     * DIFFERENT class is refused: two answers to "does this move money" is
     * worse than none, since whichever load order wins silently becomes the
     * answer.
     */
    fun register(kind: CommandKind, effect: EffectClass) {
        val existing = registered[kind]
        if (existing != null && existing != effect) {
            throw IllegalStateException(
                "'${kind.value}' is already registered as $existing and cannot also be $effect: " +
                    "two answers to what a command moves is worse than none",
            )
        }
        registered[kind] = effect
    }

    /** What this command moves, or a refusal. Never a guess. */
    fun require(kind: CommandKind): EffectClass = registered[kind] ?: throw UnclassifiedCommand(kind)

    /** Whether a kind is classified, for a caller that would rather ask than catch. */
    fun isRegistered(kind: CommandKind): Boolean = registered.containsKey(kind)

    /** The registry as it stands, for an inventory at promotion. */
    fun snapshot(): Map<CommandKind, EffectClass> = LinkedHashMap(registered)
}

/**
 * The application-wide registry, which each domain owner fills from beside its
 * own command definitions at startup.
 */
object CommandEffects : CommandEffectRegistry() {
    /**
     * Entries authored by Phase 7 itself. Must stay empty.
     *
     * Not a placeholder waiting for whoever passes through: anything added
     * here is Phase 7 deciding what another domain's command does to the
     * ledger, which is exactly the thing the ruling forbids it. It is a value
     * so that "Phase 7 invented no classification" is a fact a test asserts
     * rather than a sentence a comment claims.
     */
    val phase7AuthoredEntries: Map<CommandKind, EffectClass> = emptyMap()
}
