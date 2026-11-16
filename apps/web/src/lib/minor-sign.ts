/**
 * The sign of a minor-unit amount, read off its TEXT (MVP-02, customer account).
 *
 * A server amount is an integer string of minor units and may exceed 2^53, so
 * it is never turned into a `number`, and the screens do no arithmetic on it
 * (§0). Taking the sign off is string handling, nothing more: the magnitude is
 * the same digits without the leading `-`, so `formatMoney` spells exactly the
 * figure the server stated.
 *
 * Text that is not `-?\d+` is refused with `null` rather than guessed at: a
 * page that meets it treats the whole answer as unreadable.
 */
export type MinorSign = 'negative' | 'zero' | 'positive';

const MINOR_TEXT = /^(-?)(\d+)$/;

/** `{ sign, magnitude }` of a minor-unit integer string, or null when the text is not one. `-0` is zero. */
export function splitMinorSign(amountMinor: string): { sign: MinorSign; magnitude: string } | null {
  const m = MINOR_TEXT.exec(amountMinor);
  if (!m) return null;
  const minus = m[1] ?? '';
  const digits = m[2] ?? '';
  if (/^0+$/.test(digits)) return { sign: 'zero', magnitude: minus === '' ? digits : '0' };
  return { sign: minus === '-' ? 'negative' : 'positive', magnitude: digits };
}
