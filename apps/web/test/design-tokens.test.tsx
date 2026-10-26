import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUTTON_MIN_PRIMARY, Button, IconButton, TOUCH_TARGET, badgeColors, colors, textColors, toastColors } from '@daftar/design-system';
import { lengthPx } from './helpers/layout-rules';
import { elements, parseHtml, styleOf } from './helpers/render';

/**
 * T-07 / T-08 (governance 04 §3): every semantic text token meets WCAG 2.x AA
 * for normal text (>= 4.5:1) on the backgrounds it is used on, the base brand
 * and semantic colors are unchanged, and the design-system buttons meet the
 * touch (>= 44px) and primary-button (>= 48px) minimums.
 */

/** WCAG 2.x relative luminance of a #RRGGBB color. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB color: ${hex}`);
  const value = Number.parseInt(m[1] ?? '0', 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2.x contrast ratio between two colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const AA_NORMAL_TEXT = 4.5;
const PAGE_BACKGROUNDS = { white: colors.neutral[0], 'neutral.50': colors.neutral[50], 'neutral.100': colors.neutral[100] } as const;

describe('T-08 — contrast helper', () => {
  it('matches the published WCAG reference values', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // The T-03 measurements this card fixes.
    expect(contrast(colors.semantic.success, '#FFFFFF')).toBeCloseTo(3.77, 2);
    expect(contrast(colors.neutral[500], colors.neutral[100])).toBeCloseTo(4.39, 2);
  });
});

describe('T-08 — text tokens are AA (>= 4.5:1) on their intended backgrounds', () => {
  const pairs: [string, string, string][] = [];
  for (const [name, fg] of Object.entries(textColors)) {
    for (const [bgName, bg] of Object.entries(PAGE_BACKGROUNDS)) pairs.push([`textColors.${name} on ${bgName}`, fg, bg]);
  }
  for (const [tone, { fg, bg }] of Object.entries(badgeColors)) pairs.push([`badgeColors.${tone} fg on its bg`, fg, bg]);
  for (const [tone, bg] of Object.entries(toastColors)) pairs.push([`white on toastColors.${tone}`, colors.neutral[0], bg]);
  pairs.push(['white on the primary button', colors.brand.onPrimary, colors.brand.primary]);
  pairs.push(['white on the danger button', colors.neutral[0], colors.semantic.danger]);

  it.each(pairs)('%s', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('pins the approved values (T07_T08 proposal; owner confirmation pending)', () => {
    expect(textColors).toEqual({
      primary: '#111827',
      secondary: '#4B5563',
      link: '#2563EB',
      success: '#047857',
      warning: '#92400E',
      danger: '#B91C1C',
      info: '#0369A1',
    });
    expect(badgeColors.brand.fg).toBe('#1D4ED8');
  });
});

describe('T-08 — the base brand, semantic and neutral colors are unchanged', () => {
  it('keeps every base value', () => {
    expect(colors.brand.primary).toBe('#2563EB');
    expect(colors.semantic).toEqual({
      success: '#059669',
      successSoft: '#D1FAE5',
      warning: '#D97706',
      warningSoft: '#FEF3C7',
      danger: '#DC2626',
      dangerSoft: '#FEE2E2',
      info: '#0284C7',
      infoSoft: '#E0F2FE',
    });
    expect(colors.neutral).toEqual({
      0: '#FFFFFF',
      50: '#F9FAFB',
      100: '#F3F4F6',
      200: '#E5E7EB',
      300: '#D1D5DB',
      400: '#9CA3AF',
      500: '#6B7280',
      600: '#4B5563',
      700: '#374151',
      800: '#1F2937',
      900: '#111827',
    });
  });
});

const TOUCH_PX = 44;
const PRIMARY_PX = 48;

/** The rendered min-height (or height) of the first <button>, in px. */
function buttonHeightPx(markup: string): number {
  const button = [...elements(parseHtml(`<div>${markup}</div>`))].find((e) => e.tag === 'button');
  if (!button) throw new Error('no <button> rendered');
  const style = styleOf(button);
  const px = lengthPx(style['min-height'] ?? style['height'] ?? '');
  if (px === null) throw new Error(`no measurable height in ${button.attrs['style'] ?? ''}`);
  return px;
}

describe('T-07 — button sizes (governance 04 §3)', () => {
  it('the size tokens are 44px and 48px', () => {
    expect(lengthPx(TOUCH_TARGET)).toBe(TOUCH_PX);
    expect(lengthPx(BUTTON_MIN_PRIMARY)).toBe(PRIMARY_PX);
  });

  const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
  const sizes = ['sm', 'md', 'lg'] as const;
  const cases = variants.flatMap((variant) => sizes.map((size) => [variant, size] as const));

  it.each(cases)('%s / %s is a >= 44px touch target, and a primary button is >= 48px', (variant, size) => {
    const px = buttonHeightPx(
      renderToStaticMarkup(
        <Button variant={variant} size={size}>
          x
        </Button>,
      ),
    );
    expect(px).toBeGreaterThanOrEqual(TOUCH_PX);
    if (variant === 'primary') expect(px).toBeGreaterThanOrEqual(PRIMARY_PX);
  });

  it('the default Button (primary, md) is 48px', () => {
    expect(buttonHeightPx(renderToStaticMarkup(<Button>x</Button>))).toBe(PRIMARY_PX);
  });

  it('IconButton keeps a 44px touch target', () => {
    expect(buttonHeightPx(renderToStaticMarkup(<IconButton aria-label="x">x</IconButton>))).toBeGreaterThanOrEqual(TOUCH_PX);
  });
});
