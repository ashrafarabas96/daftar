/**
 * Canonical instants and civil dates, validated on the VALUE and not on its
 * shape.
 *
 * A regular expression that accepts `2026-13-45` is not a date check. That
 * exact defect was found in Phase 4 S5 — a refusal whose comment claimed to
 * catch an impossible date shape-matched `/^\d{4}-\d{2}-\d{2}$/` and reported
 * the impossible value as a legitimate one — so both helpers here parse the
 * value back and require the parse to reproduce the input digit for digit. A
 * month of 13 and a 31st of February are refused because the round trip does
 * not hold, not because a pattern was widened to exclude them.
 */

/** `YYYY-MM-DDTHH:MM:SSZ` — the only instant shape this package accepts. */
const INSTANT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** `YYYY-MM-DD` — a civil date in the business's timezone. */
const CIVIL_DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealCivilDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Whether `value` is a canonical RFC3339 UTC instant at second precision that names a real moment. */
export function isCanonicalInstant(value: string): boolean {
  const m = INSTANT_SHAPE.exec(value);
  if (m === null) return false;
  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  if (!isRealCivilDate(Number(y), Number(mo), Number(d))) return false;
  // A leap second is not representable in this contract, and 24:00 is not a
  // time: both are refused rather than silently rolled into the next day.
  return Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59;
}

/** Whether `value` is a `YYYY-MM-DD` civil date that names a real day. */
export function isCanonicalCivilDate(value: string): boolean {
  const m = CIVIL_DATE_SHAPE.exec(value);
  if (m === null) return false;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  return isRealCivilDate(Number(y), Number(mo), Number(d));
}

/**
 * Lexicographic comparison IS chronological comparison for these two shapes:
 * both are fixed-width, zero-padded and big-endian, so no parse is needed to
 * order them and no timezone can be introduced by ordering them.
 */
export function compareCanonical(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
