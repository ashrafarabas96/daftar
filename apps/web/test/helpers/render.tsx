/**
 * The phone-width render helper (P3-S7 contract §5(3)) — how the screen
 * agents and the SSR suites (T-08, T-15, T-16) render a pure view.
 *
 * A view is rendered with `renderToStaticMarkup` inside
 * `<div dir lang style="width:360px">` and the design system's provider for
 * the locale. The markup is then read back by a small tag-and-attribute
 * walker written here: React's static markup is well-formed, so no jsdom is
 * needed (adding it would be a new dependency).
 *
 *     const { root, html, missingKeys } = renderAtPhoneWidth((base) => <MyView {...base} {...data} />, 'ar');
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DaftarProvider } from '@daftar/design-system';
import { dirOf, LOCALES, translate, type Locale } from '@/lib/i18n';
import type { Translate, ViewBaseProps, ViewEntry, ViewFixture } from '@/lib/phase3-format';

export { LOCALES };
export type { Locale };

/** The narrowest common Android width, in CSS pixels (§0). */
export const PHONE_WIDTH_PX = 360;

// ── The light parsed tree ────────────────────────────────────────────────

export interface ElementNode {
  readonly kind: 'element';
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: HtmlNode[];
  readonly parent: ElementNode | null;
}
export interface TextNode {
  readonly kind: 'text';
  readonly text: string;
  readonly parent: ElementNode;
}
export type HtmlNode = ElementNode | TextNode;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Parse React static markup into a tree under a synthetic `#root` element. Throws on markup it cannot balance. */
export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { kind: 'element', tag: '#root', attrs: {}, children: [], parent: null };
  let current = root;
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let consumed = 0;
  for (const m of html.matchAll(token)) {
    if (m.index !== consumed) throw new Error(`unparseable markup at ${consumed}: ${html.slice(consumed, consumed + 40)}`);
    consumed = m.index + m[0].length;
    const [whole, closing, opening, attrText = '', selfClose, text] = m;
    if (whole.startsWith('<!--')) continue;
    if (text !== undefined) {
      current.children.push({ kind: 'text', text: decodeEntities(text), parent: current });
      continue;
    }
    if (closing !== undefined) {
      if (current.tag !== closing.toLowerCase()) throw new Error(`unbalanced </${closing}> inside <${current.tag}>`);
      current = current.parent ?? root;
      continue;
    }
    const tag = (opening ?? '').toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) attrs[(a[1] ?? '').toLowerCase()] = decodeEntities(a[2] ?? '');
    const node: ElementNode = { kind: 'element', tag, attrs, children: [], parent: current };
    current.children.push(node);
    if (selfClose !== '/' && !VOID.has(tag)) current = node;
  }
  if (consumed !== html.length) throw new Error(`unparseable markup tail: ${html.slice(consumed, consumed + 40)}`);
  if (current !== root) throw new Error(`unclosed <${current.tag}>`);
  return root;
}

/** Every element under `node`, depth first, `node` included. */
export function* elements(node: ElementNode): Generator<ElementNode> {
  yield node;
  for (const child of node.children) if (child.kind === 'element') yield* elements(child);
}

/** Every text node under `node`, depth first. */
export function* textNodes(node: ElementNode): Generator<TextNode> {
  for (const child of node.children) {
    if (child.kind === 'text') yield child;
    else yield* textNodes(child);
  }
}

/** The element's ancestors, nearest first. */
export function* ancestors(node: HtmlNode): Generator<ElementNode> {
  for (let p = node.parent; p !== null; p = p.parent) yield p;
}

/** The inline `style` of an element as `property → value` (CSS names, lower case). */
export function styleOf(node: ElementNode): Record<string, string> {
  const out: Record<string, string> = {};
  const text = node.attrs['style'] ?? '';
  let depth = 0;
  let start = 0;
  const declarations: string[] = [];
  for (let i = 0; i <= text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if ((ch === ';' && depth === 0) || i === text.length) {
      declarations.push(text.slice(start, i));
      start = i + 1;
    }
  }
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    out[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
  }
  return out;
}

/** The visible text of a subtree, whitespace collapsed. */
export function textOf(node: ElementNode): string {
  return [...textNodes(node)]
    .map((t) => t.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Rendering ────────────────────────────────────────────────────────────

export interface Rendered {
  readonly html: string;
  /** The `#root` of the parsed markup; its single child is the 360px wrapper. */
  readonly root: ElementNode;
  /** The wrapper `<div dir lang style="width:360px">`. */
  readonly frame: ElementNode;
  /** Keys the view asked `t` for that no catalog holds (they render `�`). */
  readonly missingKeys: readonly string[];
}

/** A `t` for `locale` that records every key no catalog holds. */
export function recordingT(locale: Locale): { t: Translate; missing: string[] } {
  const missing: string[] = [];
  const t: Translate = (key, vars) => {
    const value = translate(locale, key, vars);
    if (value === '�') missing.push(key);
    return value;
  };
  return { t, missing };
}

/** Render `view(base)` at phone width in `locale`, and read it back. */
export function renderAtPhoneWidth(view: (base: ViewBaseProps) => ReactElement, locale: Locale): Rendered {
  const { t, missing } = recordingT(locale);
  const html = renderToStaticMarkup(
    <div dir={dirOf(locale)} lang={locale} style={{ width: `${PHONE_WIDTH_PX}px` }}>
      <DaftarProvider locale={locale}>{view({ t, locale })}</DaftarProvider>
    </div>,
  );
  const root = parseHtml(html);
  const frame = root.children[0];
  if (frame?.kind !== 'element') throw new Error('the render produced no frame');
  return { html, root, frame, missingKeys: missing };
}

/** Render one registry fixture at phone width. */
export function renderFixture(fixture: ViewFixture, locale: Locale): Rendered {
  return renderAtPhoneWidth(fixture.render, locale);
}

// ── Registry discovery ───────────────────────────────────────────────────

const WEB_ROOT = join(__dirname, '..', '..');

/** The merchant view areas (§4.3, §8, plus P4-S3's `pos`): each has a `src/views/<area>/registry.ts(x)` once its views exist. */
export const VIEW_AREAS = ['stock', 'catalog', 'structure', 'purchases', 'suppliers', 'common', 'pos'] as const;

export interface AreaRegistry {
  readonly area: string;
  readonly file: string;
  readonly entries: readonly ViewEntry[];
}

function isViewEntry(value: unknown): value is ViewEntry {
  if (typeof value !== 'object' || value === null) return false;
  const name: unknown = Reflect.get(value, 'name');
  const fixtures: unknown = Reflect.get(value, 'fixtures');
  return typeof name === 'string' && Array.isArray(fixtures);
}

/** The areas under `src/views` that hold at least one view file. */
export function viewAreasOnDisk(): string[] {
  const dir = join(WEB_ROOT, 'src', 'views');
  let areas: string[] = [];
  try {
    areas = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return areas.filter((area) => readdirSync(join(dir, area)).some((f) => /\.tsx?$/.test(f))).sort();
}

/** Load every `src/views/<area>/registry.ts(x)` and its `VIEW_REGISTRY`. An area with views but no registry is an error. */
export async function loadViewRegistries(): Promise<AreaRegistry[]> {
  const out: AreaRegistry[] = [];
  for (const area of viewAreasOnDisk()) {
    const files = readdirSync(join(WEB_ROOT, 'src', 'views', area)).filter((f) => /^registry\.tsx?$/.test(f));
    const file = files[0];
    if (file === undefined) throw new Error(`src/views/${area} holds views but no registry.ts exporting VIEW_REGISTRY (T-08, T-15, T-16)`);
    const mod: unknown = await import(join(WEB_ROOT, 'src', 'views', area, file));
    const registry: unknown = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'VIEW_REGISTRY') : undefined;
    if (!Array.isArray(registry) || registry.length === 0 || !registry.every(isViewEntry)) {
      throw new Error(`src/views/${area}/${file} does not export a non-empty VIEW_REGISTRY of defineView(...) entries`);
    }
    out.push({ area, file: `src/views/${area}/${file}`, entries: registry });
  }
  return out;
}
