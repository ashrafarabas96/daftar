import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEGIN, END, PATTERNS, classify, findSites, isPureCommentLine, renderReport, run } from '../scripts/zod-consumers/report';

/**
 * DR-71 section 3(a): the zod-consumer sweep is a LAW, not a listing.
 *
 * `scripts/zod-consumers/report.ts` finds every site that reads zod `issues`
 * by index, count, `.find(` / `.shift(`, destructuring, snapshot or formatting
 * helper, and classifies each one. This suite makes that sweep run on every
 * `npm test`, so a NEW `issues[0]` anywhere in `apps/**`, `tests/**` or
 * `packages/**` fails the build until a person classifies it.
 *
 * WHAT WOULD MAKE A GREEN HERE VACUOUS
 *  - a scanner whose patterns match nothing -> the pattern controls below fire
 *    every family on a seeded line, and the real-tree run must find a
 *    non-trivial number of sites (hundreds) and at least one in the production
 *    consumer (`error.filter.ts`);
 *  - a classifier that classifies everything as safe -> the fail-closed case
 *    plants an unknown `issues[0]` in a scratch tree and requires it to come
 *    back UNCLASSIFIED;
 *  - a committed report nobody regenerates -> the sites section is compared
 *    with a fresh render.
 */

describe('DR-71 s3a. the zod-consumer scanner can see what it claims to see (positive controls)', () => {
  const seeded: Record<string, string> = {
    index: 'const first = err.issues[0];',
    length: 'if (err.issues.length > 1) {}',
    method: 'const hit = err.issues.find((i) => i.path[0] === "a");',
    destructure: 'const { issues } = parsed.error;',
    'find-shift': 'queue.shift();',
    snapshot: 'expect(body).toMatchSnapshot();',
    formatter: 'const t = z.treeifyError(err);',
    'issues-access': 'log(err.issues);',
    'errors-access': 'for (const e of err.errors) {}',
    'body-consumer': 'expect(res.body.error.details.issues).toBeDefined();',
  };
  for (const [family, line] of Object.entries(seeded)) {
    it(`family "${family}" fires on a seeded line`, () => {
      const fired = PATTERNS.filter((p) => p.re.test(line)).map((p) => p.family);
      expect(fired).toContain(family);
    });
  }

  it('a pure comment line is prose; a trailing comment is NOT (it is conservatively code)', () => {
    expect(isPureCommentLine('  // issues[0] is how it used to work')).toBe(true);
    expect(isPureCommentLine('   * `issues[0]` in a block comment')).toBe(true);
    expect(isPureCommentLine('const x = e.issues[0]; // fine?')).toBe(false);
  });
});

const ISSUE_FAMILIES: readonly string[] = ['index', 'length', 'method', 'destructure', 'snapshot', 'formatter', 'issues-access', 'body-consumer'];

describe('DR-71 s3a. the sweep over the real tree', () => {
  const root = join(__dirname, '..');
  const result = run(root);

  it('no site is left unclassified and no hand entry is stale', () => {
    expect(
      result.unclassified.map((s) => `${s.file}:${s.line} [${s.family}] ${s.text}`),
      'classify new sites in scripts/zod-consumers/report.ts',
    ).toEqual([]);
    expect(result.staleEntries.map((e) => `${String(e.file)} :: ${e.match}`)).toEqual([]);
  });

  it('is not vacuous: hundreds of sites, every family hit, and the production consumer is among them', () => {
    expect(result.classified.length).toBeGreaterThan(300);
    const families = new Set(result.classified.map((c) => c.family));
    for (const f of ['length', 'method', 'find-shift', 'formatter', 'issues-access', 'errors-access', 'body-consumer'])
      expect(families.has(f as never), `family ${f} found at least once`).toBe(true);
    const prod = result.classified.filter((c) => c.file === 'apps/api/src/common/error.filter.ts' && c.family === 'issues-access');
    expect(prod.length, 'the one production consumer of zod issues').toBeGreaterThanOrEqual(1);
    expect(prod[0]?.cls).toBe('intended');
  });

  it('nothing is classified needs-fixing (a site that needs fixing is FIXED, not kept in the table)', () => {
    expect(result.classified.filter((c) => c.cls === 'needs-fixing').map((c) => `${c.file}:${c.line}`)).toEqual([]);
  });

  it('the API clients never read validation issues: no client-tree site touches `issues`', () => {
    const clientIssues = result.classified.filter((c) => /^apps\/(web\/src|admin\/src|android)\//.test(c.file) && ISSUE_FAMILIES.includes(c.family));
    expect(clientIssues.map((c) => `${c.file}:${c.line} ${c.text}`)).toEqual([]);
    expect(
      result.classified.some((c) => c.family === 'client-details'),
      'positive control: the client details reads ARE seen',
    ).toBe(true);
  });

  it('the committed REPORT.md sites section is current (regenerate with `npx tsx scripts/zod-consumers/report.ts`)', () => {
    const committed = readFileSync(join(root, 'scripts', 'zod-consumers', 'REPORT.md'), 'utf8');
    const fresh = renderReport(result.classified);
    const section = (t: string): string => t.slice(t.indexOf(BEGIN), t.indexOf(END));
    expect(section(committed).length, 'the section markers exist').toBeGreaterThan(200);
    expect(section(committed)).toBe(section(fresh));
  });
});

describe('DR-71 s3a. fail-closed: a new consumer nobody classified is caught', () => {
  it('an unknown `issues[0]` in a scratch tree comes back UNCLASSIFIED; the same text in a comment is prose; an unrelated .find( is safe by receiver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zod-sweep-'));
    try {
      mkdirSync(join(dir, 'apps', 'x'), { recursive: true });
      writeFileSync(join(dir, 'apps', 'x', 'consumer.ts'), 'export const first = (e: { issues: { path: string[] }[] }) => e.issues[0];\n');
      writeFileSync(join(dir, 'apps', 'x', 'prose.ts'), '// the old code read issues[0]\nexport const a = 1;\n');
      writeFileSync(join(dir, 'apps', 'x', 'generic.ts'), 'export const f = (xs: number[]) => xs.find((n) => n > 1);\n');
      const r = classify(findSites(dir), dir);
      expect(r.unclassified.map((s) => `${s.file}:${s.family}`).sort()).toEqual(['apps/x/consumer.ts:index', 'apps/x/consumer.ts:issues-access']);
      const prose = r.classified.find((c) => c.file === 'apps/x/prose.ts');
      expect(prose?.rule).toBe('R-PROSE');
      const generic = r.classified.find((c) => c.file === 'apps/x/generic.ts');
      expect(generic?.rule).toBe('R-RECEIVER');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
