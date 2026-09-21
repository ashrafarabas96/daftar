/**
 * Store slug normalization, validation, reserved words, and Arabic-name
 * suggestion (Recovery Directive §24).
 *
 * Slug is part of `{store_slug}.{PLATFORM_ROOT_DOMAIN}` — the root domain is
 * platform configuration, never hard-coded.
 *
 * Arabic business names must produce an ASCII-safe suggestion automatically:
 * a deterministic Arabic→Latin transliteration, then normalization. If
 * transliteration yields nothing usable, the fallback is
 * `store-<short-stable-random-token>` — never a hard-coded word like
 * "store-shop" that would collide across merchants.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 48;

const RESERVED = new Set([
  'www',
  'api',
  'app',
  'admin',
  'dashboard',
  'support',
  'help',
  'docs',
  'blog',
  'mail',
  'email',
  'status',
  'cdn',
  'static',
  'assets',
  'media',
  'img',
  'images',
  'daftar',
  'daftr',
  'store',
  'stores',
  'shop',
  'pos',
  'pay',
  'payments',
  'billing',
  'auth',
  'login',
  'logout',
  'signup',
  'register',
  'account',
  'security',
  'legal',
  'privacy',
  'terms',
  'about',
  'contact',
  'sales',
  'dev',
  'staging',
  'test',
  'demo',
  'beta',
  'alpha',
  'internal',
  'infra',
  'ns1',
  'ns2',
  'ftp',
  'smtp',
  'imap',
  'pop',
  'webmail',
  'portal',
  'my',
  'null',
  'undefined',
  'root',
  'system',
  'super',
  'superadmin',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface SlugResult {
  ok: boolean;
  slug: string;
  reason?: 'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_CHARS' | 'RESERVED';
}

/** Normalize user input: lowercase NFC, map Arabic-Indic digits, strip spaces to hyphen. */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function validateSlug(raw: string): SlugResult {
  const slug = normalizeSlug(raw);
  if (slug.length === 0) return { ok: false, slug, reason: 'EMPTY' };
  if (slug.length < SLUG_MIN) return { ok: false, slug, reason: 'TOO_SHORT' };
  if (slug.length > SLUG_MAX) return { ok: false, slug, reason: 'TOO_LONG' };
  if (!SLUG_RE.test(slug)) return { ok: false, slug, reason: 'INVALID_CHARS' };
  if (RESERVED.has(slug)) return { ok: false, slug, reason: 'RESERVED' };
  return { ok: true, slug };
}

export function isReservedSlug(raw: string): boolean {
  return RESERVED.has(normalizeSlug(raw));
}

/**
 * Arabic → ASCII transliteration for slug suggestion. Phonetic, deterministic,
 * covers the Arabic alphabet incl. alef variants, teh marbuta, and tatweel.
 * This is a slug suggestion aid, not a linguistic transliteration standard.
 */
const AR_MAP: Readonly<Record<string, string>> = {
  ا: 'a',
  أ: 'a',
  إ: 'i',
  آ: 'a',
  ب: 'b',
  ت: 't',
  ث: 'th',
  ج: 'j',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ذ: 'th',
  ر: 'r',
  ز: 'z',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  ة: 'h',
  و: 'w',
  ؤ: 'w',
  ي: 'y',
  ى: 'a',
  ئ: 'y',
  ء: '',
  ٱ: 'a',
  پ: 'p',
  چ: 'ch',
  ڤ: 'v',
  گ: 'g',
  ڨ: 'g',
};

export function transliterateArabic(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFC')) {
    if (ch === 'ـ') continue; // tatweel
    const mapped = AR_MAP[ch];
    out += mapped !== undefined ? mapped : ch;
  }
  return out;
}

/**
 * Automatic ASCII-safe slug suggestion from a (possibly Arabic) business name.
 * Always returns a valid, reserved-safe candidate. Unicode input safe.
 */
export function suggestSlugFromName(businessName: string, random: () => string = defaultToken): string {
  const transliterated = transliterateArabic(businessName);
  const base = normalizeSlug(transliterated);
  if (base.length >= SLUG_MIN && !RESERVED.has(base)) return base.slice(0, SLUG_MAX).replace(/-+$/g, '');
  return `store-${random()}`;
}

function defaultToken(): string {
  // Short stable random token — safe fallback, never a reused word.
  // Web Crypto (globalThis.crypto) is available in Node ≥ 20 and every
  // browser, so this package stays isomorphic for the web client bundle.
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic alternative suggestions when a slug is taken. */
export function suggestSlugs(raw: string, taken: (slug: string) => boolean, max = 3): string[] {
  const base = normalizeSlug(transliterateArabic(raw)) || `store-${defaultToken()}`;
  const out: string[] = [];
  const candidates = [`${base}-market`, `${base}-co`, `${base}1`, `${base}2`, `${base}-${defaultToken().slice(0, 4)}`];
  for (const c of candidates) {
    const v = validateSlug(c);
    if (v.ok && !taken(v.slug)) out.push(v.slug);
    if (out.length >= max) break;
  }
  return out;
}
