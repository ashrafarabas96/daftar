/**
 * DAFTAR Design Tokens — the single source of visual truth.
 * Brand, semantic color, typography, spacing, radius, elevation, motion,
 * breakpoints, focus, z-index, and RTL/LTR logical helpers.
 * Consumed by apps/web, apps/admin, and mirrored by apps/android Theme.kt.
 */

export const colors = {
  brand: {
    primary: '#2563EB',
    primaryHover: '#1D4ED8',
    primaryActive: '#1E40AF',
    primarySoft: '#DBEAFE',
    onPrimary: '#FFFFFF',
    accent: '#60A5FA',
  },
  neutral: {
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
  },
  semantic: {
    success: '#059669',
    successSoft: '#D1FAE5',
    warning: '#D97706',
    warningSoft: '#FEF3C7',
    danger: '#DC2626',
    dangerSoft: '#FEE2E2',
    info: '#0284C7',
    infoSoft: '#E0F2FE',
  },
  focus: '#2563EB',
} as const;

export const typography = {
  fontFamily: {
    base: "'Tajawal', 'Inter', -apple-system, 'Segoe UI', sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
  },
  size: {
    xs: '0.75rem',
    sm: '0.875rem',
    md: '1rem',
    lg: '1.125rem',
    xl: '1.375rem',
    '2xl': '1.75rem',
    '3xl': '2.25rem',
  },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.25, normal: 1.5, relaxed: 1.65 },
} as const;

/** 4px grid. */
export const spacing = {
  0: '0',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
} as const;

export const radius = { sm: '0.375rem', md: '0.5rem', lg: '0.75rem', xl: '1rem', full: '9999px' } as const;

export const elevation = {
  none: 'none',
  sm: '0 1px 2px rgba(16,24,40,0.06)',
  md: '0 4px 8px -2px rgba(16,24,40,0.10), 0 2px 4px -2px rgba(16,24,40,0.06)',
  lg: '0 12px 16px -4px rgba(16,24,40,0.10), 0 4px 6px -2px rgba(16,24,40,0.05)',
} as const;

export const motion = {
  fast: '120ms ease-out',
  normal: '200ms ease-out',
  slow: '320ms ease-in-out',
} as const;

export const breakpoints = { sm: '640px', md: '768px', lg: '1024px', xl: '1280px' } as const;

export const zIndex = { base: 0, dropdown: 1000, sticky: 1100, overlay: 1200, modal: 1300, toast: 1400, tooltip: 1500 } as const;

/** Minimum interactive target (WCAG 2.5.8 / platform HIG). */
export const TOUCH_TARGET = '2.75rem';

/**
 * RTL/LTR logical helpers — components must use logical properties so the
 * same layout renders correctly under dir="rtl" (ar) and dir="ltr" (en/tr).
 */
export const logical = {
  start: (dir: 'ltr' | 'rtl') => (dir === 'rtl' ? 'right' : 'left'),
  end: (dir: 'ltr' | 'rtl') => (dir === 'rtl' ? 'left' : 'right'),
  marginStart: (value: string) => ({ marginInlineStart: value }),
  marginEnd: (value: string) => ({ marginInlineEnd: value }),
  paddingStart: (value: string) => ({ paddingInlineStart: value }),
  paddingEnd: (value: string) => ({ paddingInlineEnd: value }),
} as const;

export type DaftarLocale = 'ar' | 'en' | 'tr';
export type Direction = 'ltr' | 'rtl';
export const dirOf = (locale: DaftarLocale | string): Direction => (locale === 'ar' ? 'rtl' : 'ltr');
