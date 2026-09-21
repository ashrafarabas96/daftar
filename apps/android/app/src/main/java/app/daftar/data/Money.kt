package app.daftar.data

import java.math.BigDecimal
import java.math.BigInteger
import java.text.DecimalFormat
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/**
 * Money on Android (Directive §34–36): minor units travel as decimal STRINGS
 * and are formatted through BigDecimal + DecimalFormat, which formats
 * BigDecimal EXACTLY. No Long/Double conversion — values above 2^53 (and
 * above 2^63) keep every digit. Minor units per currency are NOT a local
 * registry: they come from the API's /platform/currencies (domain-core).
 */
object Money {
    class InvalidAmount(message: String) : IllegalArgumentException(message)

    fun format(minor: String, currency: String, minorUnits: Int, locale: Locale): String {
        val value = BigDecimal(BigInteger(minor.trim())).movePointLeft(minorUnits)
        val nf = NumberFormat.getCurrencyInstance(locale)
        nf.currency = Currency.getInstance(currency)
        nf.minimumFractionDigits = minorUnits
        nf.maximumFractionDigits = minorUnits
        if (nf is DecimalFormat) nf.isParseBigDecimal = true
        return nf.format(value)
    }

    /** Exact decimal-string → minor-units string. Rejects excess precision instead of rounding. */
    fun parseMajorToMinor(input: String, minorUnits: Int): String {
        val trimmed = input.trim().replace(",", "").replace(" ", "")
        if (!Regex("^-?\\d+(\\.\\d+)?$").matches(trimmed)) throw InvalidAmount("invalid decimal: $input")
        val value = BigDecimal(trimmed)
        if (value.scale() > minorUnits) throw InvalidAmount("too many decimal places: ${value.scale()} > $minorUnits")
        return value.movePointRight(minorUnits).toBigIntegerExact().toString()
    }
}
