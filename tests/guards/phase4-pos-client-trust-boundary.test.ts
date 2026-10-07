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
 *      line gross or net, a subtotal, a cart total, a grand total, a rate, a
 *      cost) — the one price request allowed is the ruled discount request;
 *   2. every field a POS request type declares is named, with its kind, in
 *      `POS_REQUEST_FIELDS`, so adding a field is a visible act;
 *   3. no POS screen builds a request body carrying such a field;
 *   4. no POS source does ARITHMETIC on money: no `+ - * / %` with a
 *      minor-unit value, no `Number`/`parseFloat`/`parseInt` of one, no
 *      `toFixed`, no `Math.round` — money is an integer minor-unit string
 *      from the server to the formatter, and no Float/Double touches it;
 *   5. exactly one POS request field is a price request at all, and it is the
 *      discount's `discountMinor`; and exactly one is a STRUCTURAL ZERO, and
 *      it is the sale commit's `taxMinor`, spelled only as the named constant;
 *   6. no POS read puts a forbidden, a session-derived or an undeclared field
 *      in a query string;
 *   7. the SALE COMMIT's body is built from the server's own two answers and
 *      four stated constants, and from nothing else — in particular from no
 *      field of the CART itself.
 *
 * ── WHY RULES 5 AND 7 LOOK DIFFERENT FROM THEIR FIRST VERSION ────────────
 * The first version of this guard was written against a PLANNED basket
 * surface. It pinned the one price request to `amountMinor` and forbade
 * `discountMinor` — which is backwards for the surface the server actually
 * mounts: `CartRequestDiscountSchema` is `{ discountMinor }`, and
 * `pos-price-authority.ts:103` lists `amountMinor` as a FORGED field ("every
 * amount on a cart line is derived"), so the old client's one legal price
 * request was the one spelling the server refuses outright.
 *
 * It also had no rule for the sale commit, because it believed in a
 * `POST /pos/sales` taking `{ documentId, revision }`. The real commit is
 * P4-S2's `POST /v1/sales` with nine required fields, so the client must now
 * BUILD a document — which is a much bigger surface for a forged figure to
 * hide in than a two-field body. Rule 7 is that surface's guard, and it is
 * stricter than rule 1 could be: it judges the EXPRESSIONS, not just the
 * field names, so `totalMinor: cart.subtotalMinor` and
 * `quantity: cart.subtotalMinor` are both caught.
 *
 * ── THE THIRD LIST ───────────────────────────────────────────────────────
 * `SESSION_DERIVED_FIELDS` is new. `warehouseId` is not a forged amount — it
 * is a fact the server stated about the till session — but a request that
 * NAMES one is choosing something the session already fixed (RULING 2,
 * `P4-AL-18`). It cannot be one flat forbidden list any more, because
 * `TillSessionOpenSchema` REQUIRES `warehouseId` (the open is where the
 * warehouse is chosen) and `SaleCommitSchema` requires it too (the server
 * resolves the branch from it). So the field is allowed in exactly the two
 * request types `SESSION_DERIVED_ALLOWED_IN` names, refused in every other
 * request type, and refused in every query string — which is where the
 * client's authority over its own read scope is actually decided.
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
 * The declarations the rules are expressed against are read out of the
 * client's SOURCE, not imported from it: the module is a browser module
 * (`'use client'`, `document`, `window`), and the root TypeScript project is a
 * Node project with no DOM lib, so importing it would have cost the whole tree
 * its `tsc -p tsconfig.json`. Reading the text is also the stricter proof —
 * what ships is what is checked, with no transpilation in between — and every
 * parser below REFUSES a declaration it cannot find rather than returning
 * nothing.
 */
function declaredList(clientSource: string, name: string): readonly string[] {
  const m = new RegExp(String.raw`export const ${name}[^=]*=\s*\[([\s\S]*?)\];`).exec(clientSource);
  if (m === null) throw new Error(`${CLIENT} no longer declares ${name}`);
  const fields = [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((f) => f[1] ?? '');
  if (fields.length === 0) throw new Error(`${name} parsed empty`);
  return fields;
}

function declaredForbiddenFields(clientSource: string): readonly string[] {
  return declaredList(clientSource, 'FORBIDDEN_REQUEST_FIELDS');
}

function declaredSessionDerivedFields(clientSource: string): readonly string[] {
  return declaredList(clientSource, 'SESSION_DERIVED_FIELDS');
}

function declaredRecord(clientSource: string, name: string): Readonly<Record<string, string>> {
  const m = new RegExp(String.raw`export const ${name}[^=]*=\s*\{([\s\S]*?)\n\};`).exec(clientSource);
  if (m === null) throw new Error(`${CLIENT} no longer declares ${name}`);
  const pairs = [...(m[1] ?? '').matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((p) => [p[1] ?? '', p[2] ?? ''] as const);
  if (pairs.length === 0) throw new Error(`${name} parsed empty`);
  return Object.fromEntries(pairs);
}

function declaredRequestFields(clientSource: string): Readonly<Record<string, string>> {
  return declaredRecord(clientSource, 'POS_REQUEST_FIELDS');
}

function declaredSessionDerivedAllowedIn(clientSource: string): Readonly<Record<string, string>> {
  return declaredRecord(clientSource, 'SESSION_DERIVED_ALLOWED_IN');
}

// Comments are stripped FIRST: an apostrophe in prose — "the till's
// warehouse" — opens a string literal as far as a quote-matching parser is
// concerned, and the parser then read a doc comment as a forbidden field name.
const CLIENT_SOURCE = strip(readFileSync(join(REPO, CLIENT), 'utf8'));
const FORBIDDEN_REQUEST_FIELDS = declaredForbiddenFields(CLIENT_SOURCE);
const SESSION_DERIVED_FIELDS = declaredSessionDerivedFields(CLIENT_SOURCE);
const POS_REQUEST_FIELDS = declaredRequestFields(CLIENT_SOURCE);
const SESSION_DERIVED_ALLOWED_IN = declaredSessionDerivedAllowedIn(CLIENT_SOURCE);

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

/**
 * Rules 1 and 2, plus the session-derived half, over the client.
 *
 * The allow-list is re-parsed from the SOURCE PASSED IN rather than taken from
 * the module-level constant: the red fixtures plant a stale exemption, and a
 * rule that read the shipped list would report nothing on them and be green
 * for the wrong reason.
 */
export function requestFieldProblems(clientSource: string): string[] {
  const problems: string[] = [];
  const declared = requestInterfaces(clientSource);
  const SESSION_DERIVED_ALLOWED_IN = declaredSessionDerivedAllowedIn(strip(clientSource));
  if (declared.length === 0) problems.push(`${CLIENT} declares no Pos*RequestDto — the POS request shapes are what this guard reads`);
  for (const { name, fields } of declared) {
    for (const field of fields) {
      if (FORBIDDEN_REQUEST_FIELDS.includes(field))
        problems.push(`${name} declares "${field}": the client would be authoritative about price, and only a discount request is ruled legal (OD-P4-02)`);
      else if (SESSION_DERIVED_FIELDS.includes(field) && !Object.hasOwn(SESSION_DERIVED_ALLOWED_IN, name))
        problems.push(
          `${name} declares "${field}", a fact of the till SESSION that only the requests in SESSION_DERIVED_ALLOWED_IN may name — a client that named it would choose the scope of its own read (RULING 2)`,
        );
      else if (!Object.hasOwn(POS_REQUEST_FIELDS, field))
        problems.push(`${name} declares "${field}", which POS_REQUEST_FIELDS does not name — a field the client sends is declared with its kind or not at all`);
    }
  }
  // The other direction: an entry in the allow-list for a type that does not
  // name a session-derived field is a stale exemption, and a stale exemption
  // is how a real one gets added later without anybody noticing.
  for (const name of Object.keys(SESSION_DERIVED_ALLOWED_IN)) {
    const found = declared.find((d) => d.name === name);
    if (found === undefined) problems.push(`SESSION_DERIVED_ALLOWED_IN names "${name}", which is not a POS request type`);
    else if (!found.fields.some((f) => SESSION_DERIVED_FIELDS.includes(f)))
      problems.push(`SESSION_DERIVED_ALLOWED_IN exempts "${name}", which names no session-derived field — a stale exemption`);
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
 * Which COMMAND carries which request type, read out of the client's own
 * signatures (`body: Pos…RequestDto`). It is derived rather than listed so a
 * command renamed in the client cannot quietly lose or gain an exemption.
 */
export function commandRequestTypes(clientSource: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of strip(clientSource).matchAll(/export const (\w+) = \([^)]*body: (Pos\w*RequestDto)/g)) out[m[1] ?? ''] = m[2] ?? '';
  return out;
}

/**
 * Rule 3: a forbidden amount in what a POS screen actually SENDS — the
 * argument of a POS command. A screen may name a server field it DISPLAYS
 * (`line.netMinor` is read out of the answer and shown), so the rule is about
 * the call, not about the word.
 *
 * A SESSION-DERIVED field is refused in every call EXCEPT the two commands
 * whose request type `SESSION_DERIVED_ALLOWED_IN` exempts: the till open names
 * the warehouse because that is where it is chosen, and the sale commit
 * because the server resolves the branch from it. Every other command — and
 * in particular every cart command — is refused by name.
 */
export function screenBodyProblems(files: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const client = files[CLIENT] ?? '';
  const commands = posCommands(client);
  if (commands.length === 0) return [`${CLIENT} declares no command through send<…> — rule 3 would check nothing`];
  const allowed = declaredSessionDerivedAllowedIn(strip(client));
  const types = commandRequestTypes(client);
  for (const [path, source] of Object.entries(files)) {
    if (path === CLIENT) continue;
    const code = strip(source);
    for (const command of commands) {
      const mayNameSessionFacts = Object.hasOwn(allowed, types[command] ?? '');
      for (const call of callArguments(code, command)) {
        for (const field of FORBIDDEN_REQUEST_FIELDS) {
          if (new RegExp(String.raw`\b${field}\s*[:,}]`).test(call.args))
            problems.push(
              `${path}:${lineOf(code, call.index)}: ${command}(…) sends "${field}" — the server owns that amount, and only a discount request is ruled legal (OD-P4-02)`,
            );
        }
        if (mayNameSessionFacts) continue;
        for (const field of SESSION_DERIVED_FIELDS) {
          if (new RegExp(String.raw`\b${field}\s*[:,}]`).test(call.args))
            problems.push(
              `${path}:${lineOf(code, call.index)}: ${command}(…) sends "${field}" — a fact of the till SESSION, which only the requests in SESSION_DERIVED_ALLOWED_IN may name (RULING 2)`,
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

/**
 * Rule 5: the one price request the client may make, and the one structural
 * position that merely looks like one.
 *
 * `taxMinor` is the hard case and it is checked rather than waved through.
 * `SaleCommitSchema` declares it `z.literal(SALE_STRUCTURAL_ZERO_TAX_MINOR)`,
 * so the position must EXIST in a request type while `P4-AL-44` holds and
 * `OD-03` is open — but there is no value the client could put there that the
 * server would adopt. So it is admitted with its own kind, pinned to a named
 * constant, and the constant is required to be the bare literal `'0'`: a
 * `taxMinor` computed from anything at all is caught here even though the
 * server would refuse it too.
 */
export function priceRequestProblems(fields: Readonly<Record<string, string>> = POS_REQUEST_FIELDS, clientSource = CLIENT_SOURCE): string[] {
  const problems: string[] = [];
  const price = Object.entries(fields).filter(([, kind]) => kind === 'discount-request');
  if (price.length !== 1) problems.push(`POS_REQUEST_FIELDS names ${price.length} price requests; the ruling allows exactly one, the discount (OD-P4-02)`);
  else if ((price[0]?.[0] ?? '') !== 'discountMinor')
    problems.push(`the one price request is "${price[0]?.[0] ?? ''}", expected the discount's "discountMinor" (CartRequestDiscountSchema)`);

  const zero = Object.entries(fields).filter(([, kind]) => kind === 'structural-zero');
  if (zero.length !== 1) problems.push(`POS_REQUEST_FIELDS names ${zero.length} structural zeros; P4-AL-44 admits exactly one, the sale commit's taxMinor`);
  else if ((zero[0]?.[0] ?? '') !== 'taxMinor') problems.push(`the one structural zero is "${zero[0]?.[0] ?? ''}", expected "taxMinor"`);

  // The constant, and the only spelling of the field that is allowed to exist.
  if (!/export const POS_SALE_TAX_MINOR = '0';/.test(clientSource))
    problems.push(
      `${CLIENT} does not declare POS_SALE_TAX_MINOR as the bare literal '0' — a tax the client computes is a tax policy the client invented (OD-03 is OPEN)`,
    );
  for (const m of clientSource.matchAll(/\btaxMinor\s*:\s*([^,\n]+)/g)) {
    const value = (m[1] ?? '').trim().replace(/;$/, '');
    // Three spellings are not a value being SENT: the field's TYPE in a
    // request or answer interface (`string`), its KIND row in
    // `POS_REQUEST_FIELDS`, and the one constant it may be set from. Anything
    // else is a tax the client stated.
    if (value === 'string' || value === "'structural-zero'" || value === 'POS_SALE_TAX_MINOR') continue;
    problems.push(`${CLIENT}:${lineOf(clientSource, m.index)} spells taxMinor as "${value}" — the only admitted spelling is POS_SALE_TAX_MINOR`);
  }
  return problems;
}

/**
 * Rule 6: the QUERY STRINGS too. A POS read is not a `send<…>`, so rules 1-3
 * never saw it — and `GET /v1/pos/products` is where the client's authority
 * over its own read scope was actually decided. Every key a POS read puts in a
 * query string must be named in `POS_REQUEST_FIELDS`, and none may be
 * forbidden or session-derived: `warehouseId` in `SESSION_DERIVED_FIELDS` is
 * only a claim until something checks the query, because the till's warehouse
 * is a fact of the SESSION and a client that could name it would choose the
 * scope of its own read (RULING 2, `P4-AL-18`).
 */
export function queryFieldProblems(clientSource: string): string[] {
  const code = strip(clientSource);
  // `qs(` matches the helper's own declaration too, and `function qs(params: …)`
  // is not a query string: a rule that read it would report `params` forever.
  const calls = callArguments(code, 'qs').filter(({ index }) => !/\bfunction\s+$/.test(code.slice(0, index)));
  const problems: string[] = [];
  if (calls.length === 0) problems.push(`${CLIENT} builds no query string with qs( — the query shapes are what this rule reads`);
  for (const { args, index } of calls) {
    for (const m of args.matchAll(/(?:^|[{,])\s*(\w+)\s*:/g)) {
      const field = m[1] ?? '';
      if (FORBIDDEN_REQUEST_FIELDS.includes(field) || SESSION_DERIVED_FIELDS.includes(field))
        problems.push(`${CLIENT}:${lineOf(code, index)} puts "${field}" in a query string: the client would choose the scope or the price of its own read`);
      else if (!Object.hasOwn(POS_REQUEST_FIELDS, field))
        problems.push(`${CLIENT}:${lineOf(code, index)} puts "${field}" in a query string, which POS_REQUEST_FIELDS does not name`);
    }
  }
  return problems;
}

// ── Rule 7: the sale commit is built from the server's own answers ───────

/** The cart-line fields the sale commit may read. Identities, the quantity, the discount REQUEST. */
export const SALE_COMMIT_CART_LINE_FIELDS: readonly string[] = ['cartLineId', 'productId', 'variantId', 'quantity', 'discountMinor'];

/** The body of `saleCommitFromCart`, by balanced braces from its signature. */
export function saleCommitBuilder(clientSource: string): string {
  const code = strip(clientSource);
  const at = code.indexOf('export function saleCommitFromCart');
  if (at < 0) throw new Error(`${CLIENT} no longer declares saleCommitFromCart — rule 7 would check nothing`);
  const open = code.indexOf('{', code.indexOf('): PosSaleCommitRequestDto', at));
  if (open < 0) throw new Error(`${CLIENT}: saleCommitFromCart has no readable body`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error(`${CLIENT}: saleCommitFromCart's body does not close`);
}

/**
 * Rule 7. Every value the sale commit carries must come from one of four
 * places, and nothing in the body may name an amount the server owns.
 *
 * The claim that matters most is the third one: `args.cart.<anything but
 * lines>` is REFUSED. A sale commit that read `args.cart.totalMinor` would be
 * stating a total — and a sale commit that read `args.cart.currency` would be
 * stating a currency, which `SALE_FORBIDDEN_REQUEST_FIELDS` forbids for the
 * same reason. The cart is read for its LINES and for nothing else.
 */
export function saleCommitProblems(clientSource: string): string[] {
  const problems: string[] = [];
  const body = saleCommitBuilder(clientSource);

  for (const field of [...FORBIDDEN_REQUEST_FIELDS, 'netMinor', 'grossMinor', 'unitPriceMinor']) {
    if (new RegExp(String.raw`\b${field}\b`).test(body))
      problems.push(`saleCommitFromCart names "${field}": the sale commit carries no amount the server owns (P4-AL-18)`);
  }
  for (const m of body.matchAll(/\bargs\.cart\.(\w+)/g)) {
    if ((m[1] ?? '') !== 'lines')
      problems.push(`saleCommitFromCart reads args.cart.${m[1] ?? ''} — the cart is read for its LINES and for nothing else, never for a figure of its own`);
  }
  for (const m of body.matchAll(/\bline\.(\w+)/g)) {
    const field = m[1] ?? '';
    if (!SALE_COMMIT_CART_LINE_FIELDS.includes(field))
      problems.push(`saleCommitFromCart reads line.${field}, which is not one of ${SALE_COMMIT_CART_LINE_FIELDS.join(', ')}`);
  }
  // Every key the body puts in the document, with its value's shape.
  // `merchantVariantOf` is admitted as a value form because it is audited
  // separately, by `merchantVariantProblems` below: it may read nothing of a
  // cart line but its two identities. Admitting a named helper here and
  // auditing its body there is strictly stronger than admitting `\w+(...)`.
  const allowedValue = /^(?:args\.\w+|args\.session\.\w+|args\.cart\.lines\.map|line\.\w+|'cash'|null|POS_SALE_TAX_MINOR|merchantVariantOf)$/;
  let keys = 0;
  // `.+?` and not `[^,\n]+`: a value may be a call whose own arguments carry
  // commas, and a pattern that stopped at the first comma simply did not match
  // such a line — it checked nothing. Measured: `variantId:` escaped the loop
  // entirely until this was widened. One key per line, so the line is the unit.
  for (const m of body.matchAll(/^\s*(\w+)\s*:\s*(.+?),?$/gm)) {
    const [, key = '', raw = ''] = m;
    keys += 1;
    if (!Object.hasOwn(POS_REQUEST_FIELDS, key)) problems.push(`saleCommitFromCart puts "${key}" in the document, which POS_REQUEST_FIELDS does not name`);
    const value = raw.replace(/\(.*$/s, '').trim();
    if (!allowedValue.test(value))
      problems.push(
        `saleCommitFromCart sets ${key} from "${raw.trim()}" — a sale commit value is a minted id, a field of the session, a field of a cart LINE, or a stated constant`,
      );
  }
  if (keys === 0) problems.push('rule 7 read no key out of saleCommitFromCart — the parser is broken, not the client');
  return problems;
}

/**
 * Rule 7b. `merchantVariantOf` is the one helper the sale commit calls, so it
 * is held to the same claim as the builder: it may read a cart line's two
 * IDENTITIES and nothing else. It exists because `CartDto` reports the
 * resolved BASE variant id for a product with no merchant variants, which
 * `resolveVariants` then refuses — see its comment in the client for what was
 * measured. A version of it that read `line.unitPriceMinor`, or that minted an
 * id of its own, would be stating a fact the server owns.
 */
export function merchantVariantProblems(clientSource: string): string[] {
  const problems: string[] = [];
  const code = strip(clientSource);
  const at = code.indexOf('export function merchantVariantOf');
  if (at < 0) return ['the client no longer declares merchantVariantOf — rule 7 admits it as a value form, so rule 7b would check nothing'];
  const open = code.indexOf('{', code.indexOf(')', at));
  let depth = 0;
  let body = '';
  for (let i = open; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        body = code.slice(open, i + 1);
        break;
      }
    }
  }
  if (body === '') return ['merchantVariantOf has no readable body'];
  const allowedLineFields = ['productId', 'variantId'];
  for (const m of body.matchAll(/\bline\.(\w+)/g)) {
    const field = m[1] ?? '';
    if (!allowedLineFields.includes(field))
      problems.push(`merchantVariantOf reads line.${field} — it may read only ${allowedLineFields.join(' and ')}, the line's identities`);
  }
  for (const field of [...FORBIDDEN_REQUEST_FIELDS, 'netMinor', 'grossMinor', 'unitPriceMinor']) {
    if (new RegExp(String.raw`\b${field}\b`).test(body)) problems.push(`merchantVariantOf names "${field}", an amount the server owns (P4-AL-18)`);
  }
  return problems;
}

// ── Green over the tree as delivered ─────────────────────────────────────

const FILES = posSources();

describe('P4-S3 — the POS client sends identities, quantities and a discount request, and nothing else', () => {
  it('reads the real POS sources (the guard is not vacuous)', () => {
    expect(Object.keys(FILES)).toContain(CLIENT);
    expect(Object.keys(FILES).length).toBeGreaterThan(4);
    expect(requestInterfaces(FILES[CLIENT] ?? '').map((i) => i.name)).toContain('PosAddLineRequestDto');
    expect(requestInterfaces(FILES[CLIENT] ?? '').map((i) => i.name)).toContain('PosSaleCommitRequestDto');
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

  it('no POS read puts a forbidden, session-derived or undeclared field in a query string', () => {
    expect(queryFieldProblems(FILES[CLIENT] ?? '')).toEqual([]);
    // The one that matters: the product type-ahead names the session, never the warehouse.
    expect(SESSION_DERIVED_FIELDS).toContain('warehouseId');
    expect(FILES[CLIENT] ?? '').toContain('/pos/products');
  });

  it('exactly one POS request field is a price request, and exactly one is the structural zero', () => {
    expect(priceRequestProblems()).toEqual([]);
    expect(POS_REQUEST_FIELDS['discountMinor']).toBe('discount-request');
    expect(POS_REQUEST_FIELDS['taxMinor']).toBe('structural-zero');
    for (const field of FORBIDDEN_REQUEST_FIELDS) expect(Object.hasOwn(POS_REQUEST_FIELDS, field)).toBe(false);
  });

  it('the sale commit is built from the till session, the cart lines and four stated constants', () => {
    expect(saleCommitProblems(FILES[CLIENT] ?? '')).toEqual([]);
  });

  it("rule 7b — merchantVariantOf reads only the cart line's two identities", () => {
    expect(merchantVariantProblems(FILES[CLIENT] ?? '')).toEqual([]);
    // The route, and the one it is NOT: there is no POS route that sells.
    expect(strip(FILES[CLIENT] ?? '')).toContain('`${BFF}/sales`');
    expect(strip(FILES[CLIENT] ?? '')).not.toContain('/pos/sales');
  });

  it('the client names the surface the server mounts, and none of the six invented endpoints', () => {
    // Read with the COMMENTS STRIPPED: this file's own prose names every
    // invented endpoint, because the reason each one is gone is worth writing
    // down. The rule is about the code.
    const source = strip(FILES[CLIENT] ?? '');
    for (const real of ['/cart-lines', '/discount', '/pos/till-sessions/current', '/pos/products', "'PATCH'"]) expect(source).toContain(real);
    // The planned basket surface, which was never built: every one of these
    // answered 404, and `GET /pos/basket` alone was 36 of the gate's failures.
    for (const invented of ['/pos/basket', '/pos/sales', "'PUT'"]) expect(source).not.toContain(invented);
    // The invented concurrency plumbing is DELETED, not defaulted: a parameter
    // the server ignores is a lie in a signature.
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('revision');
    expect(Object.hasOwn(POS_REQUEST_FIELDS, 'revision')).toBe(false);
    expect(Object.hasOwn(POS_REQUEST_FIELDS, 'documentId')).toBe(false);
    expect(source).not.toContain('documentId');
    // `revision` itself appears once more in the CODE and must: it is in the
    // forbidden list, which is how the deleted plumbing stays deleted.
    expect(source).not.toMatch(/\brevision\s*[:,)]/);
  });

  it('the discount GRAIN is declared in one place, and the one discount command is at that grain', () => {
    const source = FILES[CLIENT] ?? '';
    // `POS_DISCOUNT_GRAIN` is the named decision (the alternative, a
    // basket-level server command that allocates across the lines, is
    // recorded beside it). While it is `'line'`, the discount command must
    // address a line.
    expect(source).toContain("export const POS_DISCOUNT_GRAIN = 'line' as const;");
    expect(/export const requestDiscount = \(tillSessionId: string, cartLineId: string, body: PosDiscountRequestDto\)/.test(source)).toBe(true);
  });

  it('the declarations were really read out of the shipped client, and a missing one is refused', () => {
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('totalMinor');
    expect(FORBIDDEN_REQUEST_FIELDS).toContain('unitPriceMinor');
    expect(Object.keys(POS_REQUEST_FIELDS)).toContain('quantity');
    expect(POS_REQUEST_FIELDS['branchId']).toBe('identity');
    expect(Object.keys(SESSION_DERIVED_ALLOWED_IN).sort()).toEqual(['PosOpenTillRequestDto', 'PosSaleCommitRequestDto']);
    // A client that dropped any declaration must fail loudly, never quietly
    // check nothing: an empty forbidden list would make rule 1 vacuous.
    expect(() => declaredForbiddenFields('export const x = 1;\n')).toThrow(/FORBIDDEN_REQUEST_FIELDS/);
    expect(() => declaredForbiddenFields('export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = [];\n')).toThrow(/parsed empty/);
    expect(() => declaredSessionDerivedFields('export const x = 1;\n')).toThrow(/SESSION_DERIVED_FIELDS/);
    expect(() => declaredRequestFields('export const x = 1;\n')).toThrow(/POS_REQUEST_FIELDS/);
    expect(() => declaredRequestFields('export const POS_REQUEST_FIELDS: X = {\n};\n')).toThrow(/parsed empty/);
    expect(() => saleCommitBuilder('export const x = 1;\n')).toThrow(/saleCommitFromCart/);
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
  it('red: a total smuggled into the sale commit request type', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'export interface PosSaleCommitRequestDto {\n  saleId: string;',
      'export interface PosSaleCommitRequestDto {\n  totalMinor: string;\n  saleId: string;',
    );
    expect(requestFieldProblems(planted)).toContainEqual(expect.stringContaining('PosSaleCommitRequestDto declares "totalMinor"'));
  });

  it('red: a field added to a request type and not declared in POS_REQUEST_FIELDS', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'export interface PosAddLineRequestDto {\n  productId: string;',
      'export interface PosAddLineRequestDto {\n  tillNickname: string;\n  productId: string;',
    );
    expect(requestFieldProblems(planted)).toContainEqual(expect.stringContaining('declares "tillNickname", which POS_REQUEST_FIELDS does not name'));
  });

  it('red: a cart command that names the till warehouse instead of letting the session fix it', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'export interface PosAddLineRequestDto {\n  productId: string;',
      'export interface PosAddLineRequestDto {\n  warehouseId: string;\n  productId: string;',
    );
    expect(requestFieldProblems(planted)).toContainEqual(expect.stringContaining('PosAddLineRequestDto declares "warehouseId", a fact of the till SESSION'));
  });

  it('red: a stale exemption in SESSION_DERIVED_ALLOWED_IN', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      "  PosOpenTillRequestDto: 'the open is the moment",
      "  PosSetLineQuantityRequestDto: 'nothing',\n  PosOpenTillRequestDto: 'the open is the moment",
    );
    expect(requestFieldProblems(planted)).toContainEqual(
      expect.stringContaining('exempts "PosSetLineQuantityRequestDto", which names no session-derived field'),
    );
  });

  it('red: the register sending a total it worked out itself', () => {
    const planted = once(
      FILES[REGISTER] ?? '',
      'addCartLine(tillSessionId, { productId: hit.productId',
      'addCartLine(tillSessionId, { totalMinor: hit.unitPriceMinor, productId: hit.productId',
    );
    expect(screenBodyProblems({ ...FILES, [REGISTER]: planted })).toContainEqual(expect.stringContaining(`${REGISTER}:`));
    expect(screenBodyProblems({ ...FILES, [REGISTER]: planted })).toContainEqual(expect.stringContaining('addCartLine(…) sends "totalMinor"'));
  });

  it('red: the register naming a warehouse in a cart command', () => {
    const planted = once(
      FILES[REGISTER] ?? '',
      'removeCartLine(tillSessionId, cartLineId));',
      'removeCartLine(tillSessionId, cartLineId, { warehouseId: tillSessionId }));',
    );
    expect(screenBodyProblems({ ...FILES, [REGISTER]: planted })).toContainEqual(expect.stringContaining('removeCartLine(…) sends "warehouseId"'));
  });

  it('red: a total added up in the browser, as text or as a number', () => {
    const asText = moneyArithmeticProblems({ 'apps/web/src/views/pos/planted.tsx': 'const shown = subtotalMinor - discountMinor;\n' });
    expect(asText).toContainEqual(expect.stringContaining('arithmetic on a minor-unit value'));
    const asNumber = moneyArithmeticProblems({
      'apps/web/src/views/pos/planted.tsx': 'const shown = Number(cart.subtotalMinor) - Number(cart.discountMinor);\n',
    });
    expect(asNumber).toContainEqual(expect.stringContaining('a minor-unit value parsed into a JavaScript number'));
  });

  it('red: money rounded with a Float in the browser', () => {
    const problems = moneyArithmeticProblems({ 'apps/web/src/views/pos/planted.tsx': 'const text = (totalMinor / 100).toFixed(2);\n' });
    expect(problems).toContainEqual(expect.stringContaining('money rounded or fixed in the browser'));
    expect(problems).toContainEqual(expect.stringContaining('arithmetic on a minor-unit value'));
  });

  it('red: a second price request, or a second structural zero, would break the ruling', () => {
    expect(priceRequestProblems({ ...POS_REQUEST_FIELDS, percentOff: 'discount-request' })).toContainEqual(expect.stringContaining('names 2 price requests'));
    expect(priceRequestProblems({ ...POS_REQUEST_FIELDS, vatMinor: 'structural-zero' })).toContainEqual(expect.stringContaining('names 2 structural zeros'));
    // And the spelling the client is allowed to give the one structural zero.
    const planted = once(FILES[CLIENT] ?? '', 'taxMinor: POS_SALE_TAX_MINOR,', 'taxMinor: args.cart.taxMinor,');
    expect(priceRequestProblems(POS_REQUEST_FIELDS, strip(planted))).toContainEqual(expect.stringContaining('spells taxMinor as "args.cart.taxMinor"'));
    const dropped = once(FILES[CLIENT] ?? '', "export const POS_SALE_TAX_MINOR = '0';", 'export const POS_SALE_TAX_MINOR = computeTax();');
    expect(priceRequestProblems(POS_REQUEST_FIELDS, strip(dropped))).toContainEqual(expect.stringContaining('bare literal'));
  });

  it('the money rules do not fire on an ordinary name, and rule 3 does not fire on a field a screen DISPLAYS', () => {
    expect(moneyArithmeticProblems({ 'apps/web/src/views/pos/ok.tsx': 'const a = quantity + 1;\nconst b = lines.length - 1;\n' })).toEqual([]);
    expect(
      screenBodyProblems({
        ...FILES,
        'apps/web/src/views/pos/ok.tsx': 'const shown = <Money amountMinor={line.netMinor} currency={c} locale={l} />;\n',
      }),
    ).toEqual([]);
    expect(posCommands(FILES[CLIENT] ?? '')).toContain('commitSale');
    expect(posCommands(FILES[CLIENT] ?? '')).not.toContain('getCart');
  });

  it('red: a POS read that names the warehouse instead of the session', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'qs({ sessionId: q.sessionId, q: q.q, limit: q.limit })',
      'qs({ warehouseId: q.sessionId, q: q.q, limit: q.limit })',
    );
    expect(queryFieldProblems(planted)).toContainEqual(expect.stringContaining('puts "warehouseId" in a query string'));
  });

  it('red: a POS read that names a price in its query string', () => {
    const planted = once(FILES[CLIENT] ?? '', 'qs({ sessionId: q.sessionId', 'qs({ unitPriceMinor: q.sessionId');
    expect(queryFieldProblems(planted)).toContainEqual(expect.stringContaining('puts "unitPriceMinor" in a query string'));
  });

  it('red: a POS read that names a field nobody declared', () => {
    const planted = once(FILES[CLIENT] ?? '', 'q: q.q, limit: q.limit })', 'q: q.q, limit: q.limit, tillNickname: q.q })');
    expect(queryFieldProblems(planted)).toContainEqual(expect.stringContaining('which POS_REQUEST_FIELDS does not name'));
  });

  it('red: a client that stopped building query strings at all is not silently green', () => {
    expect(queryFieldProblems('export const x = 1;\n')).toContainEqual(expect.stringContaining('builds no query string'));
  });

  it('red: a sale commit that states a figure of the cart', () => {
    const planted = once(FILES[CLIENT] ?? '', '    documentDate: args.documentDate,', '    documentDate: args.cart.totalMinor,');
    const problems = saleCommitProblems(planted);
    expect(problems).toContainEqual(expect.stringContaining('names "totalMinor"'));
    expect(problems).toContainEqual(expect.stringContaining('reads args.cart.totalMinor'));
  });

  it('red: a sale commit line that reads a price off the cart line', () => {
    const planted = once(FILES[CLIENT] ?? '', '      quantity: line.quantity,', '      quantity: line.unitPriceMinor,');
    const problems = saleCommitProblems(planted);
    expect(problems).toContainEqual(expect.stringContaining('names "unitPriceMinor"'));
    expect(problems).toContainEqual(expect.stringContaining('reads line.unitPriceMinor'));
  });

  it('red: a sale commit value that comes from somewhere other than the server', () => {
    const planted = once(FILES[CLIENT] ?? '', '    documentDate: args.documentDate,', '    documentDate: new Date().toISOString(),');
    expect(saleCommitProblems(planted)).toContainEqual(expect.stringContaining('sets documentDate from "new Date().toISOString()"'));
  });

  it('red: a sale commit field nobody declared', () => {
    const planted = once(FILES[CLIENT] ?? '', '    notes: null,', '    notes: null,\n    tillNickname: null,');
    expect(saleCommitProblems(planted)).toContainEqual(expect.stringContaining('puts "tillNickname" in the document'));
  });

  it('red: a sale commit that calls a helper rule 7b does not audit', () => {
    const planted = once(FILES[CLIENT] ?? '', 'variantId: merchantVariantOf(line, args.simpleProducts),', 'variantId: pickVariant(line, args.simpleProducts),');
    expect(saleCommitProblems(planted)).toContainEqual(expect.stringContaining('sets variantId from'));
  });

  it('red: merchantVariantOf reaching for an amount of the line', () => {
    const planted = once(
      FILES[CLIENT] ?? '',
      'return simpleProducts.has(line.productId) ? null : line.variantId;',
      'return simpleProducts.has(line.unitPriceMinor) ? null : line.variantId;',
    );
    const problems = merchantVariantProblems(planted);
    expect(problems).toContainEqual(expect.stringContaining('reads line.unitPriceMinor'));
    expect(problems).toContainEqual(expect.stringContaining('names "unitPriceMinor"'));
  });

  it('red: a client that dropped merchantVariantOf leaves rule 7 admitting an unaudited name', () => {
    expect(merchantVariantProblems('export const x = 1;\n')).toContainEqual(expect.stringContaining('no longer declares merchantVariantOf'));
  });
});
