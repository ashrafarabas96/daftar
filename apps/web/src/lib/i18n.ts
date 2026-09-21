import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';

export type Locale = 'ar' | 'en' | 'tr';
export const LOCALES: Locale[] = ['ar', 'en', 'tr'];
export const dirOf = (locale: Locale): 'rtl' | 'ltr' => (locale === 'ar' ? 'rtl' : 'ltr');
export const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

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
