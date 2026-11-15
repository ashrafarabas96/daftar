/**
 * The ONE literal the merchant-language guards let through (DR-35, DR-114(b)).
 *
 * The owner's wording for a credit-bearing invoice row is «رصيد دائن على فاتورة
 * عمرها X يومًا» (DR-35), and the «دائن» / credit / alacak words are otherwise
 * refused by both guards: `scripts/guards/merchant-jargon.ts` (catalog half) and
 * `tests/browser/invariants.ts` (in-page half). Both import THIS module, so a
 * screen cannot pass one gate and fail the other.
 *
 * The exception is a TEXT, not a key and not a namespace: an exact, whole
 * occurrence of a template below is cut out of the scanned text before the
 * denylist runs. Nothing else is loosened. A value that is the template plus
 * anything else keeps the "anything else" scanned; the bare word anywhere else is
 * still refused.
 *
 * No imports, so the browser invariants can take it as plain data and inject the
 * pattern sources into the in-page program.
 */

export type Dr35Locale = 'ar' | 'en' | 'tr';

/** The templates, per locale. `{days}` is the invoice age in days. */
export const DR35_CREDIT_TEMPLATES: Readonly<Record<Dr35Locale, string>> = {
  ar: 'رصيد دائن على فاتورة عمرها {days} يومًا',
  en: 'Credit balance on an invoice {days} days old',
  tr: '{days} günlük faturada alacak bakiyesi',
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One regex SOURCE per template: the template escaped, `{days}` matching digits
 * (or the literal `{days}` itself, which is how the catalog holds the template),
 * and a letter/digit boundary on both sides so only a whole occurrence matches.
 * Plain strings, because the in-page program receives them as JSON.
 */
export const DR35_PATTERN_SOURCES: readonly string[] = Object.values(DR35_CREDIT_TEMPLATES).map(
  (t) => `(?<![\\p{L}\\p{N}])${t.split('{days}').map(escapeRe).join('(?:\\p{Nd}+|\\{days\\})')}(?![\\p{L}\\p{N}])`,
);

/** `text` with every whole occurrence of a template replaced by a space (so neighbours do not fuse). */
export function stripDr35Literal(text: string): string {
  return DR35_PATTERN_SOURCES.reduce((s, p) => s.replace(new RegExp(p, 'gu'), ' '), text);
}
