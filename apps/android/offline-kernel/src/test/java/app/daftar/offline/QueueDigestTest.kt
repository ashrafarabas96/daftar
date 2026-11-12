package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * DR-84 — the queue's digest is a real sha256 of real bytes, in the one shape
 * that cannot be mistaken for a sentinel.
 *
 * Before DR-84 nothing in the kernel computed a digest at all: `digestNow` was
 * a string a caller passed in, `capture` asked only that it be non-empty, and
 * `MessageDigest` appeared in none of the module's files. `"sha256:a1b2c3d4"`
 * was therefore a legal digest for every payload that has ever existed.
 *
 * The expected values below were computed OUTSIDE this file, twice, by two
 * independent implementations — Node's `crypto` and Python's `hashlib` — and
 * they agreed. That matters: a vector computed by the code under test proves
 * only that the code agrees with itself.
 */
class QueueDigestTest {
    private val vector1 = "daftar/p7 queue integrity vector 1\n".toByteArray()
    private val vector2 = "daftar/p7 queue integrity vector 2\n".toByteArray()

    private val expected1 = "26ae0498c7908eaffb66a9ea371a6ed64281f93f9281a7ddbc77044a220de00d"
    private val expected2 = "9925c73eb1f10f7fd9a3969ad064881d07d2a94e80241f2137c1580e76814eb1"

    @Test
    fun `the digest of a fixed input is the value two other implementations computed`() {
        assertEquals(35, vector1.size, "the vector's own length, so a changed literal is not silent")
        assertEquals(expected1, QueueDigest.of(vector1))
    }

    /**
     * The negative control for the vector above. These two inputs differ in a
     * single byte — `1` against `2`, one character of thirty-five — and the
     * digests must differ. Without this, a function that returned a constant
     * would pass the first case.
     */
    @Test
    fun `one byte of difference is a different digest`() {
        assertEquals(vector1.size, vector2.size, "the control must differ in content, not in length")
        var differences = 0
        for (i in vector1.indices) if (vector1[i] != vector2[i]) differences += 1
        assertEquals(1, differences, "the control is meant to differ by exactly one byte")

        assertEquals(expected2, QueueDigest.of(vector2))
        assertNotEquals(QueueDigest.of(vector1), QueueDigest.of(vector2))
    }

    @Test
    fun `the shape is the server's own -- lowercase hex, sixty-four characters, no prefix`() {
        val digest = QueueDigest.of(vector1)
        assertEquals(64, digest.length)
        assertTrue(QueueDigest.FORM.matches(digest), "$digest is not 64 lowercase hex characters")
        assertTrue(digest == digest.lowercase(), "an uppercase digit would fail the server's own column check")
        assertEquals(false, digest.startsWith("sha256:"), "the prefixed shape was the sentinel shape")
    }

    /**
     * The shape the kernel used to accept, measured against the shape the
     * server's column accepts. Not because the two values are ever compared —
     * DR-84 says they are not — but because the old literals could not have
     * been digests of anything, and this names why.
     */
    @Test
    fun `the sentinel shapes this replaces are refused by the form`() {
        for (sentinel in listOf("sha256:a1b2c3d4", "sha256:deadbeef", "a1b2c3d4", "", "x")) {
            assertEquals(false, QueueDigest.FORM.matches(sentinel), "$sentinel passed a form it must fail")
        }
    }

    @Test
    fun `the empty payload still has a digest, and it is the known one`() {
        // A capture with an empty body is not a capture with no digest. The
        // value is the published sha256 of the empty string, so a wrong
        // special case here would be visible rather than plausible.
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            QueueDigest.of(ByteArray(0)),
        )
    }
}
