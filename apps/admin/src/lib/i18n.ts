import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';

// Flat key -> string catalogs with `{var}` substitution (same mechanism as apps/web/src/lib/i18n.ts).
// The console renders in ONE fixed locale ('en', exactly as before T-06). Locale detection, lang/dir
// and a language switcher are NOT part of this change (see proposal branch t06-proposal/admin-locale-dir).
export type Locale = 'ar' | 'en' | 'tr';
export const DEFAULT_LOCALE: Locale = 'en';

const dicts: Record<Locale, Record<string, string>> = { ar, en, tr };

/** Translate. NEVER renders the raw key — missing keys render the replacement char. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let value = dicts[locale][key] ?? dicts.en[key];
  if (value === undefined) return '�';
  if (vars) {
    for (const [k, v] of Object.entries(vars)) value = value.replaceAll(`{${k}}`, String(v));
  }
  return value;
}

export function makeT(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
}

const fixedT = makeT(DEFAULT_LOCALE);
/** Translator for the fixed default locale. */
export function useT() {
  return fixedT;
}
