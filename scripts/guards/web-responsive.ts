/**
 * Rule 23 — the P3-S7 responsive law, statically (contract §7.2(c), A-16;
 * MP-3). Scoped to the "S7 web files" (§0), so Phase 1 pages are not
 * re-litigated.
 *
 * The design system is inline-style only, with no media queries (DS:113), so
 * a phone layout is a matter of which primitives a screen reaches for. Each
 * flag below is one way a screen stops working at 360px, stops mirroring in
 * Arabic, or shrinks a touch target under 44px; each carries its reason.
 * The rendered half of the same law is the SSR suite (T-15, T-16).
 */
import { isS7WebFile, stripTsComments } from './merchant-jargon';

export interface ResponsiveRule {
  readonly name: string;
  readonly why: string;
  readonly find: (code: string) => { index: number; evidence: string }[];
}

const all = (code: string, re: RegExp): { index: number; evidence: string }[] =>
  [...code.matchAll(re)].map((m) => ({ index: m.index, evidence: m[0].replace(/\s+/g, ' ').trim() }));

/** 320px, the widest fixed size a phone at 360px can hold beside its gutters (A-16(1)). */
const MAX_FIXED_PX = 320;

const pxOf = (value: number, unit: string): number => (unit === 'px' ? value : value * 16);

export const RESPONSIVE_RULES: readonly ResponsiveRule[] = [
  {
    name: 'physical direction',
    why: 'a physical side does not mirror under dir="rtl"; use marginInlineStart/…End or the `logical` helpers (A-16(3), DAFTAR_LOCALIZATION §4)',
    find: (code) =>
      all(
        code,
        /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft\w*|borderRight\w*)\s*:|(?<![\w-])(?:left|right)\s*:|\bfloat\s*:|\btextAlign\s*:\s*['"](?:left|right)['"]/g,
      ),
  },
  {
    name: 'fixed width above 20rem',
    why: 'a fixed width, min-width or flex-basis above 320px overflows a 360px phone (A-16(1), DS:113)',
    find: (code) =>
      [...code.matchAll(/\b(?:width|minWidth|flexBasis)\s*:\s*['"`]?\s*(\d+(?:\.\d+)?)\s*(px|rem|em)\b/g)]
        .filter((m) => pxOf(Number.parseFloat(m[1] ?? '0'), m[2] ?? 'px') > MAX_FIXED_PX)
        .map((m) => ({ index: m.index, evidence: m[0] })),
  },
  {
    name: '100vw',
    why: '100vw includes the scrollbar and ignores the page gutter, so it scrolls sideways on a phone (A-16(1))',
    find: (code) => all(code, /100vw/g),
  },
  {
    name: 'design-system Table',
    why: 'the design-system Table scrolls sideways (overflowX: auto); S7 uses List and Card rows (A-16(2))',
    find: (code) => all(code, /import\s*(?:type\s*)?\{[^}]*\bTable\b[^}]*\}\s*from\s*['"]@daftar\/design-system['"]/g),
  },
  {
    name: 'raw clickable element',
    why: 'a raw <button> or <a onClick> has no guaranteed 44px target; use Button, Select, Combobox, TextField or a List row (A-16(4))',
    find: (code) => all(code, /<button\b|<a\b[^>]*\bonClick\s*=/g),
  },
  {
    name: 'small button',
    why: 'Button size="sm" is calc(2.75rem - 0.5rem), under the 44px touch target (A-16(4), buttons.tsx:9)',
    find: (code) => all(code, /\bsize\s*=\s*(?:"sm"|'sm'|\{\s*['"]sm['"]\s*\})|\bsize\s*:\s*['"]sm['"]/g),
  },
  {
    name: 'number conversion of a quantity or amount',
    why: 'a double rounds a large or long-fraction value in silence; money and quantities stay strings, parsed only by parseMajorToMinor (A-17, Rule 6b)',
    find: (code) => all(code, /\b(?:Number|parseFloat|parseInt)\s*\(\s*[^)]*(?:qty|quantity|amount|minor|price|cost|total)[^)]*\)/gi),
  },
];

export interface ResponsiveViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly evidence: string;
  readonly why: string;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Rule 23 over `files` (repository-relative path → contents). Non-S7 files are ignored. */
export function findResponsiveViolations(files: Readonly<Record<string, string>>): ResponsiveViolation[] {
  const out: ResponsiveViolation[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!isS7WebFile(file)) continue;
    const code = stripTsComments(source);
    for (const rule of RESPONSIVE_RULES) {
      for (const hit of rule.find(code)) out.push({ file, line: lineOf(code, hit.index), rule: rule.name, evidence: hit.evidence, why: rule.why });
    }
  }
  return out;
}

/** The S7 web files among `files`, so the caller can prove the rule watches something. */
export function responsiveSurface(files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files).filter(isS7WebFile).sort();
}
