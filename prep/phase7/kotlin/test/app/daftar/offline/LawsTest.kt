package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The law table itself, and the map from each law to the test that defends it.
 *
 * The map is the point. A suite can hold a hundred cases and still leave a
 * stated law undefended, and nothing in the suite would say so — the law reads
 * as covered because it is written down. So the coverage is a VALUE here,
 * checked for completeness in both directions, and `tools/red-proofs.sh`
 * closes the other half by planting a mutation against each law and requiring
 * the named test to turn red. A law with a case that cannot fail is not a law.
 */
class LawsTest {
    /** Law id -> the test that turns red when the kernel stops honouring it. */
    private val defendedBy: Map<String, String> = mapOf(
        P7Laws.DEVICE_NOT_AUTHORITY.id to
            "OutcomeExhaustiveTest.no answer outside 2xx can ever produce Synced",
        P7Laws.KEY_MINTED_AT_CAPTURE.id to
            "CrashSafetyTest.a sale committed by the server and lost in transit is not sold twice",
        P7Laws.PAYLOAD_FROZEN_AT_CAPTURE.id to
            "CrashSafetyTest.a payload recomputed at send time is refused here, not by the server",
        P7Laws.NO_SILENT_MATERIAL_RESOLUTION.id to
            "CrashSafetyTest.a stock conflict waits for a person and keeps the server's own words",
        P7Laws.NO_LOCAL_DELETE_BEFORE_CONFIRMED.id to
            "CrashSafetyTest.the merchant cannot cancel a sale that may already exist on the server",
        P7Laws.REPLAY_IS_SUCCESS.id to
            "OutcomeExhaustiveTest.every 2xx syncs and carries the server's own replayed flag unchanged",
        P7Laws.LOST_RESPONSE_RESOLVES_BY_REPLAY.id to
            "OutcomeExhaustiveTest.an unanswered attempt is always unknown, never failed and never done",
        P7Laws.DEVICE_CLOCK_NOT_AUTHORITY.id to
            "BackoffTest.the schedule survives process death because it is derived, not drawn",
        P7Laws.READ_CACHE_IS_A_PROJECTION.id to
            "ConflictTest.a read cache is replaced and nothing else",
        P7Laws.NO_LAST_WRITE_WINS_ON_MATERIAL_STATE.id to
            "ConflictTest.last-write-wins and field merge are permitted nowhere, over the whole table",
        P7Laws.NO_DEFAULT_EFFECT_CLASS.id to
            "CommandEffectsTest.an unregistered command refuses by name and is never treated as benign",
        P7Laws.QUEUE_SCOPED_BY_OWNER.id to
            "ScopeAndSchemaTest.no transition can change the row's owner",
        P7Laws.NO_CROSS_ACCOUNT_SEND.id to
            "ScopeAndSchemaTest.a sale captured in one business is not sent under another",
        P7Laws.UNKNOWN_QUEUE_SCHEMA_REFUSED.id to
            "ScopeAndSchemaTest.a row from a schema version this build does not know is refused, not reinterpreted",
        P7Laws.NO_REENTRY_BEFORE_THE_ORIGINAL_IS_SETTLED.id to
            "ReentryAndRetentionTest.a wiped device may not re-enter an unknown sale while the receipt cannot be read",
        P7Laws.EXPIRY_MINIMIZES_THE_PAYLOAD_AND_NEVER_THE_OBLIGATION.id to
            "ReentryAndRetentionTest.expiry never clears the row, never discards the operation and never forgets why",
        P7Laws.AN_UNFENCED_ABSENCE_SETTLES_NOTHING.id to
            "ReentryAndRetentionTest.an absence settles the original only when the original key is fenced",
        P7Laws.THE_ORIGINAL_KEY_OUTRANKS_A_NEW_ONE.id to
            "ReentryAndRetentionTest.a recoverable original is resent under its own key whatever the receipt says",
    )

    @Test
    fun `every stated law has a named defender and every defender names a stated law`() {
        val stated = P7Laws.ALL.map { it.id }.toSet()
        assertEquals(stated, defendedBy.keys, "the law table and the coverage map have drifted apart")
        assertEquals(P7Laws.ALL.size, stated.size, "two laws share an id")
        assertTrue(stated.size >= 18, "only ${stated.size} laws are stated")
    }

    @Test
    fun `a law states something, in a stable shape`() {
        for (law in P7Laws.ALL) {
            assertTrue(law.id.startsWith("P7-L"), "'${law.id}' is not a Phase 7 law id")
            assertTrue(law.id == law.id.uppercase(), "'${law.id}' is not upper case")
            // Long enough to be a statement rather than a label: the id already
            // labels it, and a one-word "statement" teaches a reader nothing.
            assertTrue(
                law.statement.length > 80,
                "'${law.id}' has a ${law.statement.length}-character statement, which is a label, not a law",
            )
            assertTrue(law.statement.trim().endsWith("."), "'${law.id}' does not state a sentence")
        }
    }

    @Test
    fun `the defenders are distinct, so no one test is credited with every law`() {
        val distinct = defendedBy.values.distinct()
        assertTrue(
            distinct.size >= 14,
            "only ${distinct.size} distinct tests defend ${defendedBy.size} laws — a single test credited " +
                "with several laws is how an undefended law reads as covered",
        )
    }
}
