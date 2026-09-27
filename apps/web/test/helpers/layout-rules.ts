/**
 * The rendered half of the P3-S7 responsive and invisibility law (contract
 * §6: T-08, T-15, T-16; A-13, A-16), as pure functions over a render from
 * `render.tsx`. The suites run them over every `VIEW_REGISTRY` fixture and
 * prove each one red on a planted view (test/fixtures/views).
 */
import { dirOf, type Locale } from '@/lib/i18n';
import { ancestors, elements, styleOf, textNodes, type ElementNode, type Rendered } from './render';

/** 20rem at 16px: the widest fixed size a 360px phone can hold beside its gutters (A-16(1)). */
const MAX_FIXED_PX = 320;
/** The design system's TOUCH_TARGET, 2.75rem = 44px (packages/design-system/src/tokens.ts). */
const TOUCH_TARGET_PX = 44;

/** A CSS length in px, for px/rem/em and a `calc()` of them with + and -; null when it is not a plain length. */
export function lengthPx(value: string): number | null {
  const v = value.trim();
  const calc = /^calc\((.*)\)$/.exec(v);
  if (calc) {
    let total = 0;
    let sign = 1;
    for (const token of (calc[1] ?? '').split(/\s+/)) {
      if (token === '+') sign = 1;
      else if (token === '-') sign = -1;
      else {
        const part = lengthPx(token);
        if (part === null) return null;
        total += sign * part;
      }
    }
    return total;
  }
  const m = /^(-?\d+(?:\.\d+)?)(px|rem|em)$/.exec(v);
  if (!m) return v === '0' ? 0 : null;
  const n = Number.parseFloat(m[1] ?? '0');
  return m[2] === 'px' ? n : n * 16;
}

/** True when a width value cannot exceed 320px at phone width. */
function widthFits(value: string): boolean {
  const v = value.trim();
  const min = /^min\((.*)\)$/.exec(v);
  if (min) return (min[1] ?? '').split(',').some((arg) => widthFits(arg));
  if (/%$/.test(v) || v === 'auto' || v === 'fit-content' || v === 'max-content' || v === 'min-content') return true;
  const vw = /^(\d+(?:\.\d+)?)vw$/.exec(v);
  if (vw) return Number.parseFloat(vw[1] ?? '0') < 100;
  const px = lengthPx(v);
  return px === null ? true : px <= MAX_FIXED_PX;
}

const describe = (el: ElementNode): string => {
  const id = el.attrs['id'] ? `#${el.attrs['id']}` : '';
  const role = el.attrs['role'] ? `[role=${el.attrs['role']}]` : '';
  return `<${el.tag}${id}${role}>`;
};

const DIGIT = /[0-9٠-٩۰-۹]/;
/** Elements whose text is not laid out inline with the page's direction, so a <bdi> is neither possible nor needed. */
const NO_BDI_CONTEXT = new Set(['option', 'textarea', 'title', 'script', 'style']);

/** T-15 over one render: every phone-width rule, one message per violation. */
export function phoneWidthViolations(r: Rendered, locale: Locale): string[] {
  const out: string[] = [];
  if (r.frame.attrs['dir'] !== dirOf(locale)) out.push(`frame dir is ${r.frame.attrs['dir'] ?? 'absent'}, expected ${dirOf(locale)}`);
  if (r.missingKeys.length > 0) out.push(`missing catalog keys: ${r.missingKeys.join(', ')}`);
  if (r.html.includes('�')) out.push('a missing key rendered as �');
  for (const el of elements(r.frame)) {
    if (el === r.frame) continue;
    const style = styleOf(el);
    for (const prop of ['width', 'min-width', 'flex-basis']) {
      const value = style[prop];
      if (value !== undefined && !widthFits(value)) out.push(`${describe(el)} ${prop}: ${value} is wider than 20rem`);
    }
    if (/100vw/.test(el.attrs['style'] ?? '')) out.push(`${describe(el)} uses 100vw`);
    if (el.tag === 'table') out.push(`${describe(el)} design-system table markup scrolls sideways on a phone`);
    if (['button', 'input', 'select', 'textarea'].includes(el.tag) && el.attrs['type'] !== 'hidden') {
      const type = el.attrs['type'] ?? '';
      if (el.tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        // The tap target of a checkbox or radio is its label (Checkbox, RadioCard).
        if (![...ancestors(el)].some((a) => a.tag === 'label')) out.push(`${describe(el)} ${type} outside a label has no touch target`);
      } else {
        const size = lengthPx(style['min-height'] ?? style['height'] ?? '');
        if (size === null || size < TOUCH_TARGET_PX) {
          out.push(`${describe(el)} min-height ${style['min-height'] ?? style['height'] ?? 'absent'} is under the 2.75rem touch target`);
        }
      }
    }
  }
  for (const node of textNodes(r.frame)) {
    if (!DIGIT.test(node.text)) continue;
    const chain = [...ancestors(node)];
    if (chain.some((a) => a.tag === 'bdi' || NO_BDI_CONTEXT.has(a.tag))) continue;
    out.push(`a number outside <bdi>: "${node.text.trim()}" in ${describe(node.parent)}`);
  }
  return out;
}

const PHYSICAL = /^(?:left|right|margin-left|margin-right|padding-left|padding-right|border-left(?:-[\w-]+)?|border-right(?:-[\w-]+)?|float)$/;

/** T-16: every physical-direction property in any rendered style. */
export function physicalDirectionViolations(r: Rendered): string[] {
  const out: string[] = [];
  for (const el of elements(r.frame)) {
    for (const [prop, value] of Object.entries(styleOf(el))) {
      if (PHYSICAL.test(prop)) out.push(`${describe(el)} ${prop}: ${value}`);
      if (prop === 'text-align' && (value === 'left' || value === 'right')) out.push(`${describe(el)} text-align: ${value}`);
    }
  }
  return out;
}

/** Attributes that carry translated words: their names are structure, their values are text. */
const TEXT_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'alt', 'aria-description']);

/**
 * T-16: the structure of a render — every element, its attribute names and its
 * non-text attribute values — with the frame's `dir`/`lang` and every text
 * node left out. An ar render and an en render of the same fixture must have
 * the same signature.
 */
export function structureSignature(r: Rendered): string {
  const walk = (el: ElementNode, depth: number): string[] => {
    const attrs = Object.entries(el.attrs)
      .filter(([name]) => !(el === r.frame && (name === 'dir' || name === 'lang')))
      .map(([name, value]) => (TEXT_ATTRIBUTES.has(name) ? name : `${name}=${value}`))
      .sort()
      .join(' ');
    const line = `${'  '.repeat(depth)}<${el.tag}${attrs ? ` ${attrs}` : ''}>`;
    return [line, ...el.children.flatMap((c) => (c.kind === 'element' ? walk(c, depth + 1) : []))];
  };
  return walk(r.frame, 0).join('\n');
}

// ── T-08 ─────────────────────────────────────────────────────────────────

/**
 * The fields that must never reach the merchant (A-13, L:1311): the base
 * variant, the stock sequence, the trace and entry ids, movement ids and the
 * posting account. Matched on the fixture's own property names.
 */
export const HIDDEN_FIELD =
  /^(?:baseVariantId|lastStockSeq|capturedAtStockSeq|stockSeq|businessTransactionId|journalEntryId|entryId|\w+EntryId|movementId|\w+MovementId|movementIds|postingAccountId)$/;

/** Every value a fixture carries under a hidden field name, found anywhere in its props. */
export function hiddenValues(props: unknown): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  const visit = (value: unknown, field: string | null): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, field);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, k);
      return;
    }
    if (field !== null && HIDDEN_FIELD.test(field) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')) {
      out.push({ field, value: String(value) });
    }
  };
  visit(props, null);
  return out;
}

/** A hidden value short enough to appear in ordinary text by chance proves nothing (T-08 fixture rule). */
export const MIN_HIDDEN_VALUE_LENGTH = 8;

/** T-08 over one render: each hidden value that appears anywhere in the markup. */
export function leakedHiddenValues(r: Rendered, props: unknown): string[] {
  return hiddenValues(props)
    .filter((h) => r.html.includes(h.value))
    .map((h) => `${h.field} = ${h.value}`);
}
