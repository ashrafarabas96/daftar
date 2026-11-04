/**
 * DR-71 section 3(a) — the zod-consumer sweep, as a RE-RUNNABLE report.
 *
 * Question it answers. zod 4.6 (T-10) can stop a string check at its first
 * failure, so the NUMBER and the ORDER of `issues` are not a stable thing to
 * depend on. Anything that reads `issues[0]`, `issues.length`, `.find(` /
 * `.shift(` over issues, destructures `issues`, snapshots a validation error,
 * or formats one with a helper, can change meaning with an upgrade. This
 * script finds EVERY such site under `apps/**`, `tests/**` and `packages/**`
 * and classifies each one:
 *
 *   intended      the code deliberately consumes issues and is (part of) the contract
 *   safe          the site cannot be affected by the order / count / wording of issues
 *   needs-fixing  the site depends on something zod no longer promises
 *
 * NO SITE MAY BE LEFT UNCLASSIFIED. A site is classified by exactly one of:
 *   - a prose rule        the match is on a pure comment line;
 *   - a receiver rule     the pattern is only a generic `.find(` / `.shift(` /
 *                         `.errors` / `.issues` on something that is not a
 *                         validation-issue collection (no zod token in the
 *                         statement around it);
 *   - a HAND ENTRY below  every other site, with a reason a reviewer can check.
 * A site matching none of them makes the script exit 1 and print it. A hand
 * entry that matches NO site (the code moved or was deleted) is STALE and also
 * exits 1, so the table cannot rot into a list of things that no longer exist.
 *
 * Run:   npx tsx scripts/zod-consumers/report.ts            (writes REPORT.md and sites.tsv here)
 *        npx tsx scripts/zod-consumers/report.ts --check    (no write; exit 1 on unclassified/stale/out-of-date)
 * The unit test `tests-unit/zod-consumer-report.test.ts` runs the check on
 * every `npm test`, so a new `issues[0]` anywhere fails the build until it is
 * classified here.
 *
 * LIMITS, stated: this is a lexical scan. A consumer that reaches issues
 * through an alias the patterns cannot see (`const e = err.issues; e[0]`) is
 * caught only by the `.issues` family (every `.issues` access is a site), not
 * by what is done to the alias afterwards. The alias CASE is therefore handled
 * by classifying the line that creates the alias.
 *
 * No git invocation: the walk is plain `fs`, so this works in an extracted
 * delivery archive (tests/security/archive-portability).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type Class = 'intended' | 'safe' | 'needs-fixing';
export type Family =
  | 'index'
  | 'length'
  | 'method'
  | 'destructure'
  | 'find-shift'
  | 'snapshot'
  | 'formatter'
  | 'issues-access'
  | 'errors-access'
  | 'body-consumer'
  | 'client-details';

export interface Site {
  file: string;
  line: number;
  family: Family;
  text: string;
}
export interface Classified extends Site {
  cls: Class;
  rule: string;
  reason: string;
}

const ROOTS = ['apps', 'tests', 'packages', 'tests-unit', 'scripts'];
const EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|kt)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', '.next', 'build', 'coverage', '.gradle', '.turbo', 'out', 'release']);

/** The scanner's own files describe the patterns, so they are not consumers. */
const SELF = new Set(['scripts/zod-consumers/report.ts', 'tests-unit/zod-consumer-report.test.ts']);

/** Trees that are CLIENTS of the API: how they read an error body's `details` decides whether they could ever read `issues`. */
export const CLIENT_ROOTS = ['apps/web/src/', 'apps/admin/src/', 'apps/android/'];

export const PATTERNS: { family: Family; re: RegExp; onlyUnder?: string[] }[] = [
  { family: 'index', re: /\bissues\s*\??\.?\s*\[/ },
  { family: 'length', re: /\bissues\s*\??\.\s*length\b/ },
  { family: 'method', re: /\bissues\s*\??\.\s*(find|findLast|shift|pop|some|every|map|filter|forEach|reduce|slice|at|flatMap|sort|splice)\s*\(/ },
  { family: 'destructure', re: /(\{[^{}]*\bissues\b[^{}]*\}\s*=[^=>])|(\[[^\]]*\]\s*=\s*[^;]*\bissues\b)|(\(\s*\{[^)]*\bissues\b[^)]*\}\s*\))/ },
  { family: 'find-shift', re: /\.(find|shift)\s*\(/ },
  { family: 'snapshot', re: /toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot/ },
  { family: 'formatter', re: /treeifyError|prettifyError|flattenError|formatError|\.flatten\s*\(|\.format\s*\(\s*\)|\bz\.core\b|\$ZodError|\bZodError\b/ },
  { family: 'issues-access', re: /\.issues\b/ },
  { family: 'errors-access', re: /\.errors\b/ },
  { family: 'body-consumer', re: /details\s*\??\.\s*issues|\bissues\s*:\s*\[/ },
  { family: 'client-details', re: /\bdetails\s*\??\.?\s*\[|\.details\b/, onlyUnder: CLIENT_ROOTS },
];

/** A token that makes a generic pattern a candidate zod-issue consumer. Its ABSENCE (around the statement) proves the receiver is not one. */
const ZOD_TOKEN = /\bissues\b|ZodError|safeParse|\.parse\(|VALIDATION_FAILED|ZodValidationPipe|\bzod\b|details\s*\??\./;

export function isPureCommentLine(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const r of ROOTS) if (existsSync(join(root, r))) walk(join(root, r), out);
  return out
    .map((p) => relative(root, p).split('\\').join('/'))
    .filter((p) => !SELF.has(p))
    .sort();
}

/** Every textual site, before classification. A line can yield several families. */
export function findSites(root: string): Site[] {
  const sites: Site[] = [];
  for (const file of listFiles(root)) {
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      for (const { family, re, onlyUnder } of PATTERNS)
        if ((!onlyUnder || onlyUnder.some((u) => file.startsWith(u))) && re.test(raw))
          sites.push({ file, line: i + 1, family, text: raw.trim().slice(0, 220) });
    });
  }
  // Snapshot FILES are sites too (a .snap / __snapshots__ entry is a snapshot of something).
  return sites;
}

function statementWindow(lines: string[], idx: number): string {
  return lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 3)).join('\n');
}

// ───────────────────────── the hand table ─────────────────────────

interface Entry {
  file: string | RegExp;
  /** substring of the trimmed source line */
  match: string;
  cls: Class;
  reason: string;
}
const E = (file: string | RegExp, match: string, cls: Class, reason: string): Entry => ({ file, match, cls, reason });

export const HAND_TABLE: Entry[] = [
  // ── the one production consumer ──
  E(
    'apps/api/src/common/error.filter.ts',
    "issues: exception.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),",
    'intended',
    'THE contract. Maps every issue to exactly {path, code}; reads no index, no length, no message, no keys, so neither the order nor the number of issues changes any other field of the response. Pinned by t10-zod-error-contract and dr71-zod-sensitive-paths.',
  ),
  E(
    'apps/api/src/common/error.filter.ts',
    'if (exception instanceof ZodError) {',
    'intended',
    'The single place a ZodError becomes a response: 400 VALIDATION_FAILED, generic message. Decision depends on the TYPE of the exception, never on its issues.',
  ),
  E('apps/api/src/common/error.filter.ts', "import { ZodError } from 'zod';", 'safe', 'import'),
  E(
    'apps/api/src/config.ts',
    "const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');",
    'safe',
    'Startup configuration failure, read by an operator in a log line, never by a client or by code. It does print zod prose (`i.message`), which may be reworded by an upgrade; nothing parses it. Not part of any HTTP contract.',
  ),
  E(
    'tests/integration/p4s4-customer-aging-oldest-band-live.test.ts',
    "expect((body.error?.details?.issues ?? []).map((i) => i.path)).toContain('bucketDays');",
    'safe',
    'Membership of a path in the response list (toContain): independent of order and of any other issue.',
  ),
  E('tests/helpers/validation-refusal.ts', 'import type { ZodError }', 'safe', 'type import'),
  E(
    'apps/web/src/lib/client.ts',
    'const details = this.details;',
    'safe',
    'CLIENT: ApiError.domainCode reads NAMED fields of `details` (DOMAIN_CODE_FIELDS, `code`); a validation refusal carries only `issues`, which it never reads. The web client reads no validation issue at all.',
  ),
  E(
    'apps/web/src/lib/client.ts',
    'const value = details[field];',
    'safe',
    'CLIENT: indexes details by a fixed domain-code field name, not by position and not into issues.',
  ),
  E('apps/web/src/lib/client.ts', "const value = details['code'];", 'safe', 'CLIENT: reads details.code under ACCOUNTING_REFUSED only.'),
  E(
    'apps/web/src/lib/client.ts',
    'plainObject(data.error?.details)',
    'safe',
    'CLIENT: copies the details object whole into ApiError; no field of it is interpreted here.',
  ),
  E(
    'apps/web/src/app/[locale]/stock/stock-page-kit.ts',
    "error.details?.['lines']",
    'safe',
    'CLIENT: reads the `lines` detail of inventory.unit_cost_required, a product refusal; not a validation issue.',
  ),
  E('apps/web/src/app/[locale]/catalog/[id]/page.tsx', "t('catalog.details')", 'safe', 'an i18n label for the word "details" in a page heading'),
  E('tests/helpers/validation-refusal.ts', 'ZodError | null', 'safe', 'declares the return type of the refusal helper; reads no issue'),
  E(
    'tests/helpers/validation-refusal.ts',
    'return r.success ? null : (r.error as ZodError);',
    'safe',
    'returns the error whole; the caller hands it to the real filter',
  ),
  E(
    'tests/golden-regression/phase1/06-web-contract.golden.test.ts',
    'parsed.error.issues',
    'safe',
    'Failure MESSAGE only: the assertion is `parsed.success`; issues are stringified for the reader and never branched on. This parses a SERVER RESPONSE against a client DTO, not a request.',
  ),
  E(
    'tests/golden-regression/phase1/07-admin-contract.golden.test.ts',
    'parsed.error.issues',
    'safe',
    'Failure MESSAGE only (assertion is `parsed.success`); parses a server response against a DTO.',
  ),
  E(
    'tests/security/phase4-route-surface.test.ts',
    'Object.entries(details).find(',
    'safe',
    'Scans an AppError `details` object for a key ending in "Code"; those details are product error details, not zod issues (zod refusals carry `issues`, whose entries are {path, code}).',
  ),
  E(
    'tests/performance/receivables-open-page-equivalence.test.ts',
    'tied.rows[0]?.issues',
    'safe',
    '`issues` is a SQL column alias counting distinct invoice ISSUE DATES, not validation issues.',
  ),
  E('tests/performance/receivables-open-page-equivalence.test.ts', "cases.find((k) => k.key === 'tiedDates')", 'safe', 'finds a seeded fixture case by key'),
  E('tests/performance/phase3-s8-budgets.test.ts', '(report.testResults ?? []).find(', 'safe', 'finds a vitest report entry by file name'),
  E('tests/guards/p4s4-settlement-surface-laws.test.ts', 'ROW_LOCK_ONLY_ROUTINES.find(', 'safe', 'finds a routine name in a constant list'),
  E('tests/security/phase2-s8-gate-tamper.test.ts', 'Object.entries(lock.packages).find(', 'safe', 'finds a package in package-lock'),
  E('tests/security/t10-upgrade-lock-contract.test.ts', 'FLOORS.find(', 'safe', 'finds a version floor by package name'),
  E('packages/inventory/scripts/s5-vector-cases.ts', '.entry.find((e) => e.systemKey', 'safe', 'finds a journal-entry line by system key in a test vector'),
  E(
    'tests/security/dr71-zod-sensitive-paths.test.ts',
    'counts.add(o.issues.length);',
    'intended',
    'Reads issues.length ONLY to prove that the NUMBER of problems varied across the combinations (the suite asserts >= 4 distinct counts); it never asserts what a count IS.',
  ),
  E(
    'tests/security/dr71-zod-sensitive-paths.test.ts',
    'o.issues.find((i) => i.path ===',
    'intended',
    'Looks up the code of the issue at a named path (only for defects with a stated code); independent of position.',
  ),

  // ── tests that read issues ──
  E(
    'tests/security/t10-zod-error-contract.test.ts',
    'expect(issues.length).toBeGreaterThan(0);',
    'safe',
    "Asserts non-emptiness only, deliberately not a count (the file header says why). Loop body then checks each issue's key set.",
  ),
  E(
    'tests/security/t10-zod-error-contract.test.ts',
    'const issues = c.body.error.details?.issues ?? [];',
    'safe',
    'Reads the already-mapped {path, code} list from the response, not zod issues.',
  ),
  E(
    'tests/security/t10-zod-error-contract.test.ts',
    'const paths = (c: Captured)',
    'safe',
    'Maps the response list to paths; consumers use toContain / toEqual on sets.',
  ),
  E(
    'tests/security/t10-zod-error-contract.test.ts',
    'expect((c.body.error.details?.issues ?? []).map((i) => i.code)).toEqual',
    'safe',
    'Single-issue case (`unrecognized_keys`) measured and pinned; zod emits one issue for an unknown key on a strict object.',
  ),
  E('tests/security/t10-zod-error-contract.test.ts', 'import { ZodError, z }', 'safe', 'import'),
  E('tests/security/t10-zod-error-contract.test.ts', 'expect(r.error).toBeInstanceOf(ZodError);', 'safe', 'Type check of the refusal, no issue read.'),
  E('tests/security/t10-zod-error-contract.test.ts', 'function refuse(', 'safe', 'helper signature'),
  E('tests/security/t10-zod-error-contract.test.ts', 'return r.error as ZodError;', 'safe', 'returns the error object whole'),
  E(
    'tests/guards/p4s4-standard-aging-not-due-band.test.ts',
    "if (!r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain('bucketDays');",
    'safe',
    'Membership of a path in a list (`toContain`): independent of order and of how many other issues exist.',
  ),
];

/** Group rules: whole classes of sites that are not zod issues at all. */
interface Rule {
  id: string;
  test: (s: Site, window: string) => boolean;
  cls: Class;
  reason: string;
}
const GROUP_RULES: Rule[] = [
  {
    id: 'R-DR71-SUITE',
    test: (s) => s.file === 'tests/security/dr71-zod-sensitive-paths.test.ts',
    cls: 'intended',
    reason:
      'the suite whose purpose is to read the response issues: it compares them as SETS and by MEMBERSHIP (map/toContain/sort), never by index and never by count, across every permutation of order and number of problems.',
  },
  {
    id: 'R-BROWSER-GATE',
    test: (s) => s.file.startsWith('tests/browser/'),
    cls: 'safe',
    reason: "tests/browser/** reads the browser gate's OWN issue records (kind/detail per step), not zod issues.",
  },
  {
    id: 'R-GUARD-ISSUES',
    test: (s) => s.file === 'tests/guards/phase4-merchant-language-guard.test.ts',
    cls: 'safe',
    reason: "the language guard's own `issues` (kind/detail), unrelated to zod.",
  },
  {
    id: 'R-FIXTURE-ISSUES',
    test: (s) => s.file === 'packages/shared-contracts/test/dr31-credit-age.test.ts',
    cls: 'safe',
    reason: '`issues` here is a list of ISSUE DATES (invoice issue dates), not validation issues.',
  },
];

export function classify(sites: Site[], root: string): { classified: Classified[]; unclassified: Site[]; staleEntries: Entry[] } {
  const cache = new Map<string, string[]>();
  const linesOf = (f: string): string[] => {
    let l = cache.get(f);
    if (!l) {
      l = readFileSync(join(root, f), 'utf8').split(/\r?\n/);
      cache.set(f, l);
    }
    return l;
  };
  const used = new Set<Entry>();
  const classified: Classified[] = [];
  const unclassified: Site[] = [];
  for (const s of sites) {
    const raw = linesOf(s.file)[s.line - 1] ?? '';
    if (isPureCommentLine(raw)) {
      classified.push({ ...s, cls: 'safe', rule: 'R-PROSE', reason: 'a pure comment line: prose, not code' });
      continue;
    }
    const entry = HAND_TABLE.find((e) => (typeof e.file === 'string' ? e.file === s.file : e.file.test(s.file)) && raw.includes(e.match));
    if (entry) {
      used.add(entry);
      classified.push({ ...s, cls: entry.cls, rule: 'HAND', reason: entry.reason });
      continue;
    }
    const win = statementWindow(linesOf(s.file), s.line - 1);
    const rule = GROUP_RULES.find((r) => r.test(s, win));
    if (rule) {
      classified.push({ ...s, cls: rule.cls, rule: rule.id, reason: rule.reason });
      continue;
    }
    // Receiver rule: only for the GENERIC families, and only when nothing zod-shaped is around the statement.
    if ((s.family === 'find-shift' || s.family === 'errors-access') && !ZOD_TOKEN.test(win)) {
      classified.push({
        ...s,
        cls: 'safe',
        rule: 'R-RECEIVER',
        reason: 'generic .find/.shift/.errors on a receiver that is not a validation-issue collection (no zod token in the surrounding statement)',
      });
      continue;
    }
    unclassified.push(s);
  }
  const staleEntries = HAND_TABLE.filter((e) => !used.has(e));
  return { classified, unclassified, staleEntries };
}

// ───────────────────────── output ─────────────────────────

export function renderSitesSection(classified: Classified[]): string {
  const rows = classified
    .filter((c) => c.rule === 'HAND' || c.rule.startsWith('R-GUARD') || c.rule.startsWith('R-FIXTURE') || c.rule === 'R-BROWSER-GATE')
    .map((c) => ({ key: `${c.file}\u0000${c.family}\u0000${c.text}`, c }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  const out: string[] = ['| file | family | code | class | why |', '| --- | --- | --- | --- | --- |'];
  for (const { key, c } of rows) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      `| ${c.file} | ${c.family} | \`${c.text.replace(/\|/g, '\\|').slice(0, 110)}\` | ${c.cls} | ${c.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
    );
  }
  return out.join('\n');
}

export const BEGIN = '<!-- BEGIN SITES (compared by the unit test; no line numbers) -->';
export const END = '<!-- END SITES -->';

export function renderReport(classified: Classified[]): string {
  const byRule = new Map<string, number>();
  const byClass = new Map<string, number>();
  for (const c of classified) {
    byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + 1);
    byClass.set(c.cls, (byClass.get(c.cls) ?? 0) + 1);
  }
  const fam = new Map<string, number>();
  for (const c of classified) fam.set(c.family, (fam.get(c.family) ?? 0) + 1);
  const lines = [
    '# zod-consumer sweep (DR-71 s3a)',
    '',
    'GENERATED by `npx tsx scripts/zod-consumers/report.ts`. Do not edit by hand: change the table in that script.',
    "Scope: `apps/**`, `tests/**`, `packages/**`, `tests-unit/**`, `scripts/**` (the scanner's own files excluded). Every site of every pattern family is classified; the run exits 1 if one is not.",
    '',
    '## Totals (informational: they move whenever unrelated code adds a `.find(`)',
    '',
    `classified sites: ${classified.length} — ${[...byClass].map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    '',
    `by family: ${[...fam]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
    '',
    `by rule: ${[...byRule]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
    '',
    '`needs-fixing` sites: ' + String(byClass.get('needs-fixing') ?? 0),
    '',
    '## Sites that are zod-related or hand-classified (compared by the unit test)',
    '',
    BEGIN,
    renderSitesSection(classified),
    END,
    '',
    '## Rules that classified the rest',
    '',
    '- `R-PROSE` — the match is on a pure comment line.',
    ...GROUP_RULES.map((r) => `- \`${r.id}\` — ${r.reason}`),
    '- `R-RECEIVER` — a generic `.find(` / `.shift(` / `.errors` whose surrounding statement contains no zod token (`issues`, `ZodError`, `safeParse`, `.parse(`, `VALIDATION_FAILED`, `ZodValidationPipe`, `zod`, `details.`).',
    '',
    'Every classified site, with its line number, is in `sites.tsv` (regenerated, not compared).',
    '',
  ];
  return lines.join('\n');
}

export function renderTsv(classified: Classified[]): string {
  return (
    [
      'file\tline\tfamily\tclass\trule\ttext',
      ...classified.map((c) => `${c.file}\t${c.line}\t${c.family}\t${c.cls}\t${c.rule}\t${c.text.replace(/\t/g, ' ')}`),
    ].join('\n') + '\n'
  );
}

export function run(root: string): { classified: Classified[]; unclassified: Site[]; staleEntries: Entry[] } {
  return classify(findSites(root), root);
}

function main(): number {
  const root = join(dirname(__filename), '..', '..');
  const { classified, unclassified, staleEntries } = run(root);
  const check = process.argv.includes('--check');
  let bad = 0;
  if (unclassified.length > 0) {
    bad = 1;
    console.error(`UNCLASSIFIED: ${unclassified.length} site(s) — classify them in scripts/zod-consumers/report.ts (HAND_TABLE) or fix them:`);
    for (const s of unclassified) console.error(`  ${s.file}:${s.line} [${s.family}] ${s.text}`);
  }
  if (staleEntries.length > 0) {
    bad = 1;
    console.error(`STALE hand entries (match no site): ${staleEntries.length}`);
    for (const e of staleEntries) console.error(`  ${String(e.file)} :: ${e.match}`);
  }
  const dir = join(root, 'scripts', 'zod-consumers');
  const md = renderReport(classified);
  if (check) {
    const current = existsSync(join(dir, 'REPORT.md')) ? readFileSync(join(dir, 'REPORT.md'), 'utf8') : '';
    const section = (t: string): string => t.slice(t.indexOf(BEGIN), t.indexOf(END));
    if (section(current) !== section(md)) {
      bad = 1;
      console.error('REPORT.md sites section is out of date: run `npx tsx scripts/zod-consumers/report.ts`');
    }
  } else if (bad === 0) {
    writeFileSync(join(dir, 'REPORT.md'), md);
    writeFileSync(join(dir, 'sites.tsv'), renderTsv(classified));
  }
  console.log(
    `zod-consumers: ${classified.length} classified, ${unclassified.length} unclassified, ${staleEntries.length} stale, needs-fixing=${classified.filter((c) => c.cls === 'needs-fixing').length}`,
  );
  return bad;
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) process.exit(main());
