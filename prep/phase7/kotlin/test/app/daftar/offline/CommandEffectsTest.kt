package app.daftar.offline

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CommandEffectsTest {
    /** Each test gets its own registry, so no test can see another's entries. */
    private fun registry() = CommandEffectRegistry()

    @Test
    fun `an unregistered command refuses by name and is never treated as benign`() {
        val reg = registry()
        val kind = CommandKind("sales.record_sale")
        assertFalse(reg.isRegistered(kind))
        val failure = assertFailsWith<UnclassifiedCommand> { reg.require(kind) }
        assertEquals(kind, failure.kind)
        assertTrue(
            failure.message.orEmpty().contains(P7Laws.NO_DEFAULT_EFFECT_CLASS.id),
            "the refusal must cite the law it enforces, got: ${failure.message}",
        )
        // The refusal names the command, because "unclassified command" without
        // the name sends a reader hunting through a registry to find which one.
        assertTrue(failure.message.orEmpty().contains("sales.record_sale"))
    }

    @Test
    fun `Phase 7 authors no classification of its own`() {
        // Asserted as a value rather than promised in a comment. Anything added
        // to that map is Phase 7 deciding what another domain's command does to
        // the ledger, which is the one thing the ruling forbids it.
        assertEquals(
            emptyMap(), CommandEffects.phase7AuthoredEntries,
            "Phase 7 has classified a command it does not own",
        )
    }

    @Test
    fun `a domain owner's registration is what answers the question`() {
        val reg = registry()
        reg.register(CommandKind("sales.record_sale"), EffectClass.FINANCIAL)
        reg.register(CommandKind("inventory.adjust"), EffectClass.INVENTORY)
        reg.register(CommandKind("catalog.rename_product"), EffectClass.BENIGN)

        assertEquals(EffectClass.FINANCIAL, reg.require(CommandKind("sales.record_sale")))
        assertEquals(EffectClass.INVENTORY, reg.require(CommandKind("inventory.adjust")))
        assertEquals(EffectClass.BENIGN, reg.require(CommandKind("catalog.rename_product")))
        assertEquals(3, reg.snapshot().size)
    }

    @Test
    fun `registering the same command twice is fine and contradicting it is not`() {
        val reg = registry()
        val kind = CommandKind("sales.record_sale")
        reg.register(kind, EffectClass.FINANCIAL)
        reg.register(kind, EffectClass.FINANCIAL) // a module initialised twice

        // Two answers to "does this move money" is worse than none, because
        // whichever load order wins silently becomes the answer.
        val clash = assertFailsWith<IllegalStateException> {
            reg.register(kind, EffectClass.BENIGN)
        }
        assertTrue(clash.message.orEmpty().contains("already registered"))
        assertEquals(EffectClass.FINANCIAL, reg.require(kind), "the clash must not have overwritten it")
    }

    @Test
    fun `a command kind must name something`() {
        for (blank in listOf("", " ", "\t", "\n")) {
            assertFailsWith<IllegalArgumentException> { CommandKind(blank) }
        }
    }

    /**
     * The textual half of the law, and it carries its own non-vacuity check.
     *
     * A grep-shaped law is only as strong as what it reads, so this one proves
     * it found its subject before it reports anything: an empty file list is a
     * FAILURE, never a quiet pass. The guard exists because `BENIGN` is the one
     * value that would make an unclassified command look harmless, so a
     * fallback to it is the specific defect worth forbidding textually — and
     * `Operation.capture` having no default parameter is not something a type
     * system lets a test observe.
     */
    @Test
    fun `no source in the kernel defaults or falls back to BENIGN`() {
        val root = File(System.getProperty("p7.src") ?: "prep/phase7/kotlin/src")
        assertTrue(root.isDirectory, "the kernel source was not found at ${root.absolutePath}")
        val sources = root.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.toList()
        assertTrue(sources.size >= 6, "only ${sources.size} kernel sources found — the sweep found no subject")

        val forbidden = listOf(
            Regex("""EffectClass\s*=\s*EffectClass\.BENIGN"""), // a defaulted parameter
            Regex("""\?:\s*EffectClass\.BENIGN"""), // an elvis fallback
            Regex("""getOrDefault\([^)]*EffectClass\.BENIGN"""),
            Regex("""\?\.\s*let[^\n]*\?:\s*EffectClass\.BENIGN"""),
        )
        val offenders = mutableListOf<String>()
        for (file in sources) {
            val text = file.readText()
            for (pattern in forbidden) {
                pattern.find(text)?.let { offenders += "${file.name}: ${it.value}" }
            }
        }
        assertEquals(
            emptyList(), offenders,
            "a command's effect class was defaulted to BENIGN (${P7Laws.NO_DEFAULT_EFFECT_CLASS.id})",
        )

        // And the guard can see what it is looking for: the same patterns match
        // when planted, so a green result above means absence, not blindness.
        val planted = "val effect: EffectClass = EffectClass.BENIGN"
        assertTrue(
            forbidden.any { it.containsMatchIn(planted) },
            "the patterns do not match even a planted default, so their green verdict means nothing",
        )
    }
}
