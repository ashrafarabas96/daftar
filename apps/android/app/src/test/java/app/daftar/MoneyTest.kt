package app.daftar

import app.daftar.data.Money
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Directive §34–36: exact money on Android — values far above the JS/Long safe range keep every digit. */
class MoneyTest {
    private fun digits(s: String) = s.filter { it.isDigit() }

    @Test
    fun `formats values above 2^53 and 2^63 with every digit preserved`() {
        for ((currency, units) in listOf("ILS" to 2, "JOD" to 3, "TRY" to 2, "USD" to 2)) {
            for (minor in listOf("900719925474099399", "999999999999999999", "123456789012345678901234567890")) {
                val out = Money.format(minor, currency, units, Locale.US)
                assertEquals("$currency $minor", digits(minor), digits(out))
                assertTrue(out, out.contains(".") && out.substringAfter(".").length == units)
            }
        }
    }

    @Test
    fun `formats small and zero values per currency minor units`() {
        assertEquals("1.999", Money.format("1999", "JOD", 3, Locale.US).filter { it.isDigit() || it == '.' })
        assertEquals("0.00", Money.format("0", "USD", 2, Locale.US).filter { it.isDigit() || it == '.' })
    }

    @Test
    fun `parses major decimals exactly and rejects excess precision`() {
        assertEquals("1999", Money.parseMajorToMinor("1.999", 3))
        assertEquals("1000", Money.parseMajorToMinor("10", 2))
        assertEquals("900719925474099399", Money.parseMajorToMinor("9007199254740993.99", 2))
        assertThrows(Money.InvalidAmount::class.java) { Money.parseMajorToMinor("1.9999", 3) }
        assertThrows(Money.InvalidAmount::class.java) { Money.parseMajorToMinor("abc", 2) }
    }
}
