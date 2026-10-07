package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConflictTest {
    private val everyCase = SyncDirection.entries.flatMap { d -> EffectClass.entries.map { e -> d to e } }

    @Test
    fun `last-write-wins and field merge are permitted nowhere, over the whole table`() {
        // Proved over the cross product, not asserted about one row: the
        // failure this guards against is a strategy becoming legal in the one
        // combination nobody wrote a case for.
        assertEquals(6, everyCase.size, "the table must cover every direction x effect pair")
        for ((direction, effect) in everyCase) {
            for (forbidden in listOf(MergeStrategy.LAST_WRITE_WINS, MergeStrategy.FIELD_MERGE)) {
                assertFalse(
                    Conflict.isPermitted(forbidden, direction, effect),
                    "$forbidden became legal for $direction / $effect (${P7Laws.NO_LAST_WRITE_WINS_ON_MATERIAL_STATE.id})",
                )
            }
            assertTrue(Conflict.permitted(direction, effect).isNotEmpty(), "$direction / $effect has no way out")
        }
    }

    @Test
    fun `a read cache is replaced and nothing else`() {
        for (effect in EffectClass.entries) {
            assertEquals(
                setOf(MergeStrategy.SERVER_REPLACES),
                Conflict.permitted(SyncDirection.READ_PROJECTION, effect),
                "a cached read of $effect state may only be replaced",
            )
            assertEquals(P7Laws.READ_CACHE_IS_A_PROJECTION.id, Conflict.lawFor(SyncDirection.READ_PROJECTION, effect))
        }
    }

    @Test
    fun `a refused material command is settled by a person and by nothing else`() {
        for (effect in listOf(EffectClass.FINANCIAL, EffectClass.INVENTORY)) {
            assertEquals(
                setOf(MergeStrategy.HUMAN_DECIDES),
                Conflict.permitted(SyncDirection.WRITE_COMMAND, effect),
                "$effect write conflicts must reach a human",
            )
            assertEquals(
                P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id,
                Conflict.lawFor(SyncDirection.WRITE_COMMAND, effect),
            )
        }
    }

    @Test
    fun `a refused benign command may also simply be let go`() {
        assertEquals(
            setOf(MergeStrategy.HUMAN_DECIDES, MergeStrategy.SERVER_REPLACES),
            Conflict.permitted(SyncDirection.WRITE_COMMAND, EffectClass.BENIGN),
        )
    }

    @Test
    fun `money and stock are material and nothing else is`() {
        assertTrue(EffectClass.FINANCIAL.isMaterial)
        assertTrue(EffectClass.INVENTORY.isMaterial)
        assertFalse(EffectClass.BENIGN.isMaterial)
        assertEquals(3, EffectClass.entries.size, "a new effect class must be classified deliberately, here")
    }
}
