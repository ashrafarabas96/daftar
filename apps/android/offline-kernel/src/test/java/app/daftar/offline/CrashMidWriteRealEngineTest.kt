package app.daftar.offline

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.SQLiteMode
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * CARD P7-LINK-02 -- the process dies BETWEEN the write and `markSuccessful`,
 * and the row must not come back half-written. **On a real engine.**
 *
 * Why this suite exists even though a crash suite already passes.
 * `PersistenceCrashSafetyTest` injects the kill against a FAKE `Transactional`,
 * and that case is green -- but the rollback it observes is a rollback this
 * module WROTE. The law the card states is a property of the ENGINE, and until
 * now no engine was under it anywhere in this repository: the kernel ships no
 * `Transactional` implementation, `:app` does not depend on `:offline-kernel`,
 * and `src/androidTest` does not exist.
 *
 * So this suite runs the kernel's own write point against **Android's
 * `SQLiteDatabase`**, with `SQLiteMode.NATIVE` set explicitly -- the owner's
 * condition, 2026-11-11 -- and it does not take "real engine" on trust: the
 * first case reads `sqlite_version()` out of the database under test, so a run
 * on a shadow that only pretends to be SQLite fails HERE, by name, instead of
 * lending its green to the cases below (RULE-3, RULE-27).
 *
 * WHAT IS STILL NOT SIMULATED, and is not pretended to be: Robolectric runs in
 * one JVM, so a kill is an exception thrown at the write point -- it is not
 * `SIGKILL` arriving between `fwrite` and `fsync` on a device whose battery
 * dies. That residue is card **P7-DEVICE-KILL-MIDWRITE**, for before launch,
 * and no simulator for it is built here.
 */
@RunWith(RobolectricTestRunner::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class CrashMidWriteRealEngineTest {

    private class Marker : PayloadCipher {
        override fun seal(plaintext: ByteArray): ByteArray = plaintext.copyOf()
        override fun open(sealed: ByteArray): ByteArray = sealed.copyOf()
    }

    /** The kill, as the kernel can observe it: the caller never returns from `write`. */
    private class ProcessDeath : Error("the process died before markSuccessful")

    /**
     * `Transactional` over Android's own SQLite. Deliberately thin: it opens
     * the engine's transaction, writes through the engine, and ends it -- so
     * what the cases below measure is SQLite's rollback, not this adapter's.
     *
     * It lives in the test source set on purpose. The kernel shipping such an
     * adapter is the subject of `the_kernel_ships_a_transactional_over_a_real_engine`
     * below, and satisfying that case with a class written here would be the
     * suite answering its own question.
     */
    private class RealSqlite(val db: SQLiteDatabase, private val dieOnWrite: Boolean) : Transactional {
        var endCalls = 0
            private set

        override fun begin() {
            db.beginTransaction()
        }

        override fun markSuccessful() {
            db.setTransactionSuccessful()
        }

        override fun end() {
            endCalls++
            db.endTransaction()
        }

        override fun write(row: StoredRow) {
            val values = ContentValues().apply {
                put("idempotencyKey", row.idempotencyKey)
                put("schemaVersion", row.schemaVersion)
                put("state", row.state.name)
                put("attempts", row.attempts)
                put("payloadDigest", row.payloadDigest)
                put("sealedPayload", row.sealedPayload)
            }
            db.insertOrThrow(TABLE, null, values)
            if (dieOnWrite) throw ProcessDeath()
        }

        override fun delete(key: String) {
            db.delete(TABLE, "idempotencyKey = ?", arrayOf(key))
        }

        override fun read(key: String): StoredRow? =
            db.query(TABLE, null, "idempotencyKey = ?", arrayOf(key), null, null, null).use { c ->
                if (!c.moveToFirst()) return null
                StoredRow(
                    idempotencyKey = c.getString(c.getColumnIndexOrThrow("idempotencyKey")),
                    schemaVersion = c.getInt(c.getColumnIndexOrThrow("schemaVersion")),
                    state = OperationState.valueOf(c.getString(c.getColumnIndexOrThrow("state"))),
                    attempts = c.getInt(c.getColumnIndexOrThrow("attempts")),
                    payloadDigest = c.getString(c.getColumnIndexOrThrow("payloadDigest")),
                    sealedPayload = c.getBlob(c.getColumnIndexOrThrow("sealedPayload")),
                )
            }

        override fun keysByState(state: OperationState): List<String> =
            db.query(TABLE, arrayOf("idempotencyKey"), "state = ?", arrayOf(state.name), null, null, null)
                .use { c ->
                    val keys = mutableListOf<String>()
                    while (c.moveToNext()) keys.add(c.getString(0))
                    keys
                }

        fun rowCount(): Int =
            db.rawQuery("SELECT COUNT(*) FROM $TABLE", null).use { c ->
                c.moveToFirst()
                c.getInt(0)
            }

        companion object {
            const val TABLE = "queue_rows"
        }
    }

    private lateinit var db: SQLiteDatabase

    @BeforeTest
    fun openTheEngine() {
        // A file-backed database, not `:memory:`: an in-memory database is one
        // more thing that could make a rollback look clean for a reason the
        // card is not about.
        val file = java.io.File(
            RuntimeEnvironment.getApplication().cacheDir,
            "p7-link-02-${System.nanoTime()}.db",
        )
        db = SQLiteDatabase.openOrCreateDatabase(file, null)
        db.execSQL(
            "CREATE TABLE ${RealSqlite.TABLE} (" +
                "idempotencyKey TEXT PRIMARY KEY NOT NULL, " +
                "schemaVersion INTEGER NOT NULL, " +
                "state TEXT NOT NULL, " +
                "attempts INTEGER NOT NULL, " +
                "payloadDigest TEXT NOT NULL, " +
                "sealedPayload BLOB NOT NULL)",
        )
    }

    @AfterTest
    fun closeTheEngine() {
        if (this::db.isInitialized) db.close()
    }

    @Test
    fun the_engine_under_this_suite_is_a_real_sqlite() {
        val version = db.rawQuery("SELECT sqlite_version()", null).use { c ->
            assertTrue(c.moveToFirst(), "the engine answered no row for sqlite_version()")
            c.getString(0)
        }
        assertNotNull(version, "sqlite_version() came back null")
        assertTrue(
            Regex("""^\d+\.\d+\.\d+""").containsMatchIn(version),
            "sqlite_version() did not look like a SQLite version: '$version'",
        )
        // And it is the engine that answers writes, not a map: a PRIMARY KEY
        // violation must come from the engine itself.
        val values = ContentValues().apply {
            put("idempotencyKey", "probe")
            put("schemaVersion", 1)
            put("state", OperationState.CAPTURED.name)
            put("attempts", 0)
            put("payloadDigest", "x")
            put("sealedPayload", byteArrayOf(1))
        }
        db.insertOrThrow(RealSqlite.TABLE, null, values)
        var refusedByTheEngine = false
        try {
            db.insertOrThrow(RealSqlite.TABLE, null, values)
        } catch (constraint: android.database.SQLException) {
            refusedByTheEngine = true
        }
        assertTrue(refusedByTheEngine, "the engine did not enforce its own primary key")
        db.delete(RealSqlite.TABLE, "idempotencyKey = ?", arrayOf("probe"))
    }

    @Test
    fun a_kill_between_write_and_mark_successful_leaves_no_row_on_a_real_engine() {
        val disk = RealSqlite(db, dieOnWrite = true)
        val store = EncryptedQueueStore(disk, Marker())
        val key = "22222222-2222-4222-8222-222222222222"
        val payload = """{"qty":"3"}""".toByteArray()

        var died = false
        try {
            store.captureWithKey(key, payload, QueueDigest.of(payload))
        } catch (death: ProcessDeath) {
            died = true
        }

        // POSITIVE CONTROL: a run where the kill never happened would pass this
        // case for the wrong reason.
        assertTrue(died, "the kill was not injected, so this run measured nothing")
        assertEquals(1, disk.endCalls, "the transaction must be ended exactly once, by the finally")
        assertEquals(0, disk.rowCount(), "a killed capture must leave no row on disk")
        assertNull(disk.read(key), "the key must not be readable after a killed capture")
    }

    @Test
    fun the_same_key_is_capturable_again_after_a_killed_capture() {
        // The other half of "no half row": the kill must not leave the key
        // poisoned either. A merchant whose till died mid-capture retries, and
        // the retry must be able to take the key, because the frozen-key
        // refusal exists to protect a row that EXISTS.
        val key = "33333333-3333-4333-8333-333333333333"
        val payload = """{"qty":"4"}""".toByteArray()

        val dead = RealSqlite(db, dieOnWrite = true)
        try {
            EncryptedQueueStore(dead, Marker()).captureWithKey(key, payload, QueueDigest.of(payload))
        } catch (death: ProcessDeath) {
            // expected
        }

        val alive = RealSqlite(db, dieOnWrite = false)
        val row = EncryptedQueueStore(alive, Marker()).captureWithKey(key, payload, QueueDigest.of(payload))
        assertEquals(key, row.idempotencyKey)
        assertEquals(OperationState.CAPTURED, row.state)
        assertEquals(1, alive.rowCount())
        assertEquals(listOf(key), alive.keysByState(OperationState.CAPTURED))
    }

    @Test
    fun the_kernel_ships_a_transactional_over_a_real_engine() {
        val candidates = listOf(
            "app.daftar.offline.SqliteQueueDb",
            "app.daftar.offline.RoomQueueDb",
            "app.daftar.offline.SupportSqliteQueueDb",
        )
        val found = candidates.filter { name ->
            try {
                Class.forName(name)
                true
            } catch (missing: ClassNotFoundException) {
                false
            }
        }
        if (found.isEmpty()) {
            fail(
                "no Transactional over a real database engine exists in the kernel, so the app " +
                    "has nothing to wire the queue to and every engine-level law is carried by " +
                    "adapters written inside test suites. Expected one of: " +
                    candidates.joinToString(", "),
            )
        }
    }
}
