/**
 * P4-S3 — THE POS CLIENT'S HALF OF THE TRUST BOUNDARY (`OD-P4-02`, OPTION A).
 *
 * The server's half is proved by sending forged totals and watching them be
 * refused. That proof is necessary and it is not sufficient: a browser that
 * computes a total and shows it has already lied to the merchant, whether or
 * not the server believed it. So this guard is about the CLIENT, and it is
 * permanent:
 *
 *   1. no POS request type declares a field the server owns (a unit price, a
 *      line total, a subtotal, a discount AMOUNT the client decided, a grand
 *      total) — the one price request allowed is the ruled discount request;
 *   2. every field a POS request type declares is named, with its kind, in
 *      `POS_REQUEST_FIELDS`, so adding a field is a visible act;
 *   3. no POS screen builds a request body carrying such a field;
 *   4. no POS source does ARITHMETIC on money: no `+ - * / %` with a
 *      minor-unit value, no `Number`/`parseFloat`/`parseInt` of one, no
 *      `toFixed`, no `Math.round` — money is an integer minor-unit string
 *      from the server to the formatter, and no Float/Double touches it;
 *   5. exactly one POS request field is a price request at all, and it is the
 *      discount's `amountMinor`.
 *
 * Each rule is a pure function over `path → source`, so each is shown RED on
 * a planted copy of the real files rather than asserted to be green.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
const REPO = join(__dirname, '../..');
const CLIENT = 'apps/web/src/lib/phase4-pos-api.ts';
const SCREEN_ROOTS = ['apps/web/src/app/[locale]/pos', 'apps/web/src/views/pos'];

/**
 * The two declarations the rules are expressed against are read out of the
 * client's SOURCE, not imported from it: the module is a browser module
 * (`'use client'`, `document`, `window`), and the root TypeScript project is a
 * Node project with no DOM lib, so importing it would have cost the whole tree
 * its `tsc -p tsconfig.json`. Reading the text is also the stricter proof —
 * what ships is what is checked, with no transpilation in between — and both
 * parsers REFUSE a declaration they cannot find rather than returning nothing.
 */
function declaredForbiddenFields(clientSource: string): readonly string[] {
  const m = /export const FORBIDDEN_REQUEST_FIELDS[^=]*=\s*\[([\s\S]*?)\];/.exec(clientSource);
  if (m === null) throw new Error(`${CLIENT} no longer declares FORBIDDEN_REQUEST_FIELDS`);
  const fields = [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((f) => f[1] ?? '');
  if (fields.length === 0) throw new Error('FORBIDDEN_REQUEST_FIELDS parsed empty');
  return fields;
}

function declaredRequestFields(clientSource: string): Readonly<Record<string, string>> {
  const m = /export const POS_REQUEST_FIELDS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(clientSource);
  if (m === null) throw new Error(`${CLIENT} no longer declares POS_REQUEST_FIELDS`);
  const pairs = [...(m[1] ?? '').matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((p) => [p[1] ?? '', p[2] ?? ''] as const);
  if (pairs.length === 0) throw new Error('POS_REQUEST_FIELDS parsed empty');
  return Object.fromEntries(pairs);
}

const CLIENT_SOURCE = readFileSync(join(REPO, CLIENT), 'utf8');
const FORBIDDEN_REQUEST_FIELDS = declaredForbiddenFields(CLIENT_SOURCE);
const POS_REQUEST_FIELDS = declaredRequestFields(CLIENT_SOURCE);

// ── The sources under the rule ───────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function posSources(): Record<string, string> {
  const files: Record<string, string> = {};
  files[CLIENT] = readFileSync(join(REPO, CLIENT), 'utf8');
  for (const root of SCREEN_ROOTS) for (const file of walk(join(REPO, root))) files[relative(REPO, file).split('\\').join('/')] = readFileSync(file, 'utf8');
  return files;
}

/** Strip block and line comments, keeping line numbers, so prose about money is not read as money. */
function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

// ── The rules ────────────────────────────────────────────────────────────

/** The bodies of the POS request interfaces, by name. */
export function requestInterfaces(clientSource: string): { name: string; fields: string[] }[] {
  const out: { name: string; fields: string[] }[] = [];
  for (const m of strip(clientSource).matchAll(/export interface (Pos\w*RequestDto)\s*\{([^}]*)\}/g)) {
    const fields = [...(m[2] ?? '').matchAll(/^\s*(\w+)\??\s*:/gm)].map((f) => f[1] ?? '');
    out.push({ name: m[1] ?? '', fields });
  }
  return out;
}

/** Rule 1 and 2, over the client. */
export function requestFieldProblems(clientSource: string): string[] {
  const problems: string[] = [];
  const declared = requestInterfaces(clientSource);
  if (declared.length === 0) problems.push(`${CLIENT} declares no Pos*RequestDto — the POS request shapes are what this guard reads`);
  for (const { name, fields } of declared) {
    for (const field of fields) {
      if (FORBIDDEN_REQUEST_FIELDS.includes(field))
        problems.push(`${name} declares "${field}": the client would be authoritative about price, and only a discount request is ruled legal (OD-P4-02)`);
      else if (!Object.hasOwn(POS_REQUEST_FIELDS, field))
        problems.push(`${name} declares "${field}", which POS_REQUEST_FIELDS does not name — a field the client sends is declared with its kind or not at all`);
    }
  }
  return problems;
}

/**
 * The POS COMMANDS, read from the client: every `export const` whose body
 * calls `send<…>`. A command added to the client is covered by rule 3 without
 * anyone remembering to list it.
 */
export function posCommands(clientSource: string): string[] {
  const code = strip(clientSource);
  const names: string[] = [];
  for (const m of code.matchAll(/export const (\w+) = ([\s\S]*?);\n/g)) if ((m[2] ?? '').includes('send<')) names.push(m[1] ?? '');
  return names;
}

/** The source text of each argument list of `name(` in `code`, by balanced parentheses. */
export function callArguments(code: string, name: string): { args: string; index: number }[] {
  const out: { args: string; index: number }[] = [];
  for (const m of code.matchAll(new RegExp(String.raw`\b${name}\s*\(`, 'g'))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      const ch = code.charAt(i);
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    out.push({ args: code.slice(m.index + m[0].length, i - 1), index: m.index });
  }
  return out;
}

/**
 * Rule 3: a forbidden amount in what a POS screen actually SENDS — the
 * argument of a POS command. A screen may name a server field it DISPLAYS
 * (`line.lineTotalMinor` is read out of the answer and shown), so the rule is
 * about the call, not about the word.
 */
export function screenBodyProblems(files: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const commands = posCommands(files[CLIENT] ?? '');
  if (commands.length === 0) return [`${CLIENT} declares no command through send<…> — rule 3 would check nothing`];
  for (const [path, source] of Object.entries(files)) {
    if (path === CLIENT) continue;
    const code = strip(source);
    for (const command of commands) {
      for (const call of callArguments(code, command)) {
        for (const field of FORBIDDEN_REQUEST_FIELDS) {
          if (new RegExp(String.raw`\b${field}\s*[:,}]`).test(call.args))
            problems.push(
              `${path}:${lineOf(code, call.index)}: ${command}(…) sends "${field}" — the server owns that amount, and only a discount request is ruled legal (OD-P4-02)`,
            );
        }
      }
    }
  }
  return problems;
}

/** Rule 4, over every POS source. */
export function moneyArithmeticProblems(files: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const rules: readonly { why: string; re: RegExp }[] = [
    { why: 'arithmetic on a minor-unit value', re: /\b\w*[Mm]inor\w*\b[)\]]*\s*[-+*/%](?![/*>])|(?<![/*])[-+*/%]\s*\b\w*[Mm]inor\w*\b/g },
    { why: 'a minor-unit value parsed into a JavaScript number', re: /\b(?:Number|parseFloat|parseInt)\s*\(\s*[\w.?[\]'"]*[Mm]inor/g },
    { why: 'money rounded or fixed in the browser', re: /\.toFixed\s*\(|\bMath\.(?:round|floor|ceil|abs)\s*\(/g },
  ];
  for (const [path, source] of Object.entries(files)) {
    const code = strip(source);
    for (const rule of rules) for (const m of code.matchAll(rule.re)) problems.push(`${path}:${lineOf(code, m.index)}: ${rule.why} ("${m[0].trim()}")`);
  }
  return problems;
}

/** Rule 5: the one price request the client may make. */
export function priceRequestProblems(): string[] {
  const price = Object.entries(POS_REQUEST_FIELDS).filter(([, kind]) => kind === 'discount-request');
  if (price.length !== 1) return [`POS_REQUEST_FIELDS names ${price.length} price requests; the ruling allows exactly one, the discount (OD-P4-02)`];
  const [field] = price[0] ?? [''];
  return field === 'amountMinor' ? [] : [`the one price request is "${field}", expected the discount's "amountMinor"`];
}

// ── Green over the tree as delivered ─────────────────────────────────────

const FILES = posSources();

describe('P4-S3 — the POS client sends identities, quantities and a discount request, and nothing else', () => {
  it('reads the real POS sources (the guard is not vacuous)', () => {
    expect(Object.keys(FILES)).toContain(CLIENT);
    expect(Object.keys(FILES).length).toBeGreaterThan(4);
    expect(requestInterfaces(FILES[CLIENT] ?? '').map((i) => i.name)).toContain('PosAddLineRequestDto');
  });

  it('no POS request type declares an amount the server owns, and every field it declares is named with its kind', () => {
    expect(requestFieldProblems(FILES[CLIENT] ?? '')).toEqual([]);
  });

  it('no POS screen builds a body carrying such an amount', () => {
    expect(screenBodyProblems(FILES)).toEqual([]);
  });

  it('no POS source does arithmetic on money, parses it into a number, or rounds it', () => {
    expect(moneyArithmeticProblems(FILES)).toEqual([]);
  });

  it('exactly one POS request field is a price request, and it is the ruled discount', () => {
    expect(priceRequestProblems()).toEqual([]);
    expect(POS_REQUEST_FIELDS['amountMinor']).toBe('discount-request');
    for (const field of FORBIDDEN_REQUEST_FIELDS) expect(Object.hasOwn(POS_REQUEST_FIELDS, field)).toBe(false);
  });

  it('the two declarations were really read out of the shipped client, and a missing one is refused', () => {
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('totalMinor');
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('unitPriceMinor');
    expect(Object.keys(POS_REQUEST_FIELDS)).toContain('quantity');
    expect(POS_REQUEST_FIELDS['branchId']).toBe('identity');
    // A client that dropped either declaration must fail loudly, never quietly
    // check nothing: an empty forbidden list would make rule 1 vacuous.
    expect(() => declaredForbiddenFields('export const x = 1;\n')).toThrow(/FORBIDDEN_REQUEST_FIELDS/);
    expect(() => declaredForbiddenFields('export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = [];\n')).toThrow(/parsed empty/);
    expect(() => declaredRequestFields('export const x = 1;\n')).toThrow(/POS_REQUEST_FIELDS/);
    expect(() => declaredRequestFields('export const POS_REQUEST_FIELDS: X = {\n};\n')).toThrow(/parsed empty/);
  });
});

// ── Red: each rule planted on a copy of the real sources ─────────────────

/** Replace exactly one occurrence; a fixture that no longer matches is a broken test, not a pass. */
function once(text: string, from: string, to: string): string {
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`the fixture expects exactly one occurrence of ${from}, found ${hits}`);
  return text.replace(from, to);
}

const REGISTER = 'apps/web/src/app/[locale]/pos/page.tsx';

describe('red: each way of making the browser authoritative about price is refused by name', () => {
  it('red: a total smuggled into the finish-sale request type', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'export interface PosFinishSaleRequestDto {\n  documentId: string;',
      'export interface PosFinishSaleRequestDto {\n  totalMinor: string;\n  documentId: string;',
    );
    expect(requestFieldProblems(planted)).toContainEqual(expect.stringContaining('PosFinishSaleRequestDto declares "totalMinor"'));
  });

  it('red: a field added to a request type and not declared in POS_REQUEST_FIELDS', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'export interface PosAddLineRequestDto {\n  documentId: string;',
      'export interface PosAddLineRequestDto {\n  tillNickname: string;\n  documentId: string;',
    );
    expect(requestFieldProblems(planted)).toContainEqual(expect.stringContaining('declares "tillNickname", which POS_REQUEST_FIELDS does not name'));
  });

  it('red: the register sending a total it worked out itself', () => {
    const planted = once(
      FILES[REGISTER] ?? '',
      'finishSale({ documentId, revision: basket.revision })',
      'finishSale({ documentId, revision: basket.revision, totalMinor: basket.totalMinor })',
    );
    expect(screenBodyProblems({ ...FILES, [REGISTER]: planted })).toContainEqual(expect.stringContaining(`${REGISTER}:`));
    expect(screenBodyProblems({ ...FILES, [REGISTER]: planted })).toContainEqual(expect.stringContaining('finishSale(…) sends "totalMinor"'));
  });

  it('red: a total added up in the browser, as text or as a number', () => {
    const asText = moneyArithmeticProblems({ 'apps/web/src/views/pos/planted.tsx': 'const shown = subtotalMinor - discountMinor;\n' });
    expect(asText).toContainEqual(expect.stringContaining('arithmetic on a minor-unit value'));
    const asNumber = moneyArithmeticProblems({
      'apps/web/src/views/pos/planted.tsx': 'const shown = Number(basket.subtotalMinor) - Number(basket.discountMinor);\n',
    });
    expect(asNumber).toContainEqual(expect.stringContaining('a minor-unit value parsed into a JavaScript number'));
  });

  it('red: money rounded with a Float in the browser', () => {
    const problems = moneyArithmeticProblems({ 'apps/web/src/views/pos/planted.tsx': 'const text = (totalMinor / 100).toFixed(2);\n' });
    expect(problems).toContainEqual(expect.stringContaining('money rounded or fixed in the browser'));
    expect(problems).toContainEqual(expect.stringContaining('arithmetic on a minor-unit value'));
  });

  it('red: a second price request would break the one-request ruling', () => {
    const planted = Object.entries({ ...POS_REQUEST_FIELDS, percentOff: 'discount-request' as const }).filter(([, k]) => k === 'discount-request');
    expect(planted).toHaveLength(2);
  });

  it('the money rules do not fire on an ordinary name, and rule 3 does not fire on a field a screen DISPLAYS', () => {
    expect(moneyArithmeticProblems({ 'apps/web/src/views/pos/ok.tsx': 'const a = quantity + 1;\nconst b = lines.length - 1;\n' })).toEqual([]);
    expect(
      screenBodyProblems({
        ...FILES,
        'apps/web/src/views/pos/ok.tsx': 'const shown = <Money amountMinor={line.lineTotalMinor} currency={c} locale={l} />;\n',
      }),
    ).toEqual([]);
    expect(posCommands(FILES[CLIENT] ?? '')).toContain('finishSale');
    expect(posCommands(FILES[CLIENT] ?? '')).not.toContain('getPosBasket');
  });
});
