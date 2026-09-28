import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionNotice, SessionRetryNotice } from '@/app/[locale]/SessionNotice';
import { LOCALES, elements, renderAtPhoneWidth, textNodes } from './helpers/render';
import { translate } from '@/lib/i18n';

/**
 * TD-19: the retry notice a page shows while its refresh waits out a rate
 * limit or an outage — plain words in every locale, a touch-safe "Try again",
 * announced politely, and nothing at all while the session is fine.
 */
describe('TD-19 session retry notice', () => {
  it.each(LOCALES)('%s: says the user is still signed in, offers Try again, no missing key', (locale) => {
    const { frame, missingKeys } = renderAtPhoneWidth((base) => <SessionRetryNotice {...base} onRetry={() => undefined} />, locale);
    expect(missingKeys).toEqual([]);
    const text = [...textNodes(frame)].map((n) => n.text).join(' ');
    expect(text).toContain(translate(locale, 'session.retrying'));
    expect(text).toContain(translate(locale, 'common.tryAgain'));
    expect(text).not.toContain('�');
    const status = [...elements(frame)].find((e) => e.attrs['role'] === 'status');
    expect(status?.attrs['aria-live']).toBe('polite');
    const button = [...elements(frame)].find((e) => e.tag === 'button');
    expect(button?.attrs['style']).toContain('min-height:2.75rem');
  });

  it('the three catalogs say it in their own language', () => {
    const [ar, en, tr] = LOCALES.map((l) => translate(l, 'session.retrying'));
    expect(new Set([ar, en, tr]).size).toBe(3);
    expect(ar).toMatch(/[؀-ۿ]/);
  });

  it('renders nothing while the session is fine (the server render, before any refresh)', () => {
    expect(renderToStaticMarkup(<SessionNotice locale="ar" />)).toBe('');
  });
});
