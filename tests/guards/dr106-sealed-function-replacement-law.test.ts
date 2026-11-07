import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DR106_BASELINE,
  MIGRATIONS_PREFIX,
  blankSqlComments,
  candidateOnlyFunctionNames,
  migrationSplit,
  scanForSealedReplacements,
  sealedFunctionNames,
  tally,
  trackedFiles,
  verdict,
} from '../../scripts/guards/sealed-function-replacement';

/**
 * DR-106 CONDITION 1 — THE LAW, ITS POSITIVE CONTROLS, AND ITS PLANTED
 * NEGATIVE CONTROL.
 *
 * The owner's sentence (DR-106 §2.1, 2026-11-07): an automatic guard that
 * fails if ANY FILE OUTSIDE `migrations/` contains a `CREATE OR REPLACE` of a
 * function WHOSE NAME EXISTS IN A SEALED MIGRATION, with a negative control by
 * a planted file. `scripts/guards/sealed-function-replacement.ts` carries the
 * reader, the two false positives it is built against, the measured baseline
 * and the limit of the law; this file is the assertions.
 *
 * ── WHY THIS FILE NEVER SPELLS THE FORBIDDEN HEAD CONTIGUOUSLY ───────────
 *
 * The law reads non-SQL files WITHOUT stripping their comments, deliberately,
 * because a `CREATE OR REPLACE` inside a TypeScript string literal is applied
 * the moment that string is executed. A test that wrote the head as one
 * literal would therefore become an instance of the very thing it forbids and
 * turn its own law red. So the planted heads below are JOINED FROM FRAGMENTS
 * at run time. The bytes that reach the planted file are the real phrase —
 * `plantedPathMustExist` reads them back and proves it — but no scanned source
 * file in this change contains it.
 *
 * ── WHAT IS PROVED HERE AND WHAT IS NOT ──────────────────────────────────
 *
 * Everything in this file is a TEXT measurement over the tracked tree and
 * needs no database. It says NOTHING about any live catalogue: not whether
 * `customer_ar_aging` is installed, not which body is installed, and not
 * whether the two bodies would return the same figures. The owner's DR-106 §3
 * keeps that comparison where it belongs — a future numbered migration with a
 * `daftar-finance` review and the two bodies compared on the same data.
 */

const ROOT = join(__dirname, '..', '..');

/** `CREATE OR REPLACE FUNCTION <fn>(` built at run time — see the header for why. */
function plantedHead(fn: string): string {
  return `${['CREATE', 'OR', 'REPLACE', 'FUNCTION'].join(' ')} ${fn}(p_a UUID) RETURNS INTEGER LANGUAGE sql AS $$ SELECT 1 $$;`;
}

describe('DR-106 §2.1 — the protected set is real, and the probe discriminates', () => {
  it('reads frozenThrough from the manifest and agrees with it on how many migrations are sealed', () => {
    const { frozenThrough, sealed, candidates, manifestCount } = migrationSplit(ROOT);
    // Read from its source, never from a decision's prose.
    expect(frozenThrough).toBe('0079_phase4_pos_till_sessions_cart.sql');
    expect(sealed.length, `sealed migrations (<= ${frozenThrough})`).toBe(manifestCount);
    expect(sealed.length).toBe(80);
    // POSITIVE CONTROL ON THE SPLIT ITSELF: a split that put everything on one
    // side would satisfy the equality above by being blind.
    expect(candidates.length, 'candidate migrations above frozenThrough').toBeGreaterThan(0);
    expect(sealed.every((f) => f.startsWith(MIGRATIONS_PREFIX))).toBe(true);
  });

  it('collects a NON-EMPTY set of sealed function names, and names two measured members', () => {
    const names = sealedFunctionNames(ROOT);
    // The count is the probe's own positive control: an empty set would make
    // the whole law green by finding nothing, which is the failure mode of
    // RULE-11 and RULE-18. 277 measured on a191d9da; sealed migrations never
    // change, so this number only moves when frozenThrough does.
    expect(names.size, 'sealed function names').toBe(277);
    // Two members measured by hand: `0075:798` creates the receivables-aging
    // routine DR-106 is about, and `invoice_outstanding` is the sibling the
    // planted-body guards use.
    expect(names.has('customer_ar_aging')).toBe(true);
    expect(names.has('invoice_outstanding')).toBe(true);
  });

  it('scans a NON-EMPTY list of tracked files and excludes migrations BY PATH, not by name', () => {
    const all = trackedFiles(ROOT);
    const outside = all.filter((f) => !f.startsWith(MIGRATIONS_PREFIX));
    expect(all.length, 'tracked files').toBe(1331);
    expect(outside.length, 'files scanned outside migrations/').toBe(1244);
    expect(all.length - outside.length, 'files excluded by path prefix').toBe(87);
    // The exclusion is by prefix: every excluded file really is under the
    // migrations directory, so nothing was dropped for looking like one.
    expect(all.filter((f) => !outside.includes(f)).every((f) => f.startsWith(MIGRATIONS_PREFIX))).toBe(true);
  });

  it('FINDS THE CASE DR-106 WAS WRITTEN FOR — the specification, by file, line and name', () => {
    const found = scanForSealedReplacements(ROOT, trackedFiles(ROOT), sealedFunctionNames(ROOT));
    const spec = found.filter((r) => r.file === 'infrastructure/database/specifications/p4s7-installment-aging.spec.sql' && r.fn === 'customer_ar_aging');
    // THIS is the discrimination proof on the real subject: the law is not
    // green because it looks at nothing.
    expect(spec).toHaveLength(1);
    // 4222 before the DR-106 §2.2 header; the header is 59 lines, so 4281.
    expect(spec[0]?.line, 'the specification replaces the live aging law at this line').toBe(4281);
  });

  it('is not fooled by the pattern written in PROSE — the specification says it twice in comments', () => {
    const raw = readFileSync(join(ROOT, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8') as string;
    // POSITIVE CONTROL: the comment really is there, so the negative below is
    // a measurement and not an empty probe.
    // The box was at :33 before the 59-line DR-106 §2.2 header, so :92 now.
    expect(raw.split('\n')[91], 'the comment box at :92 names the pattern').toContain('REPLACE FUNCTION');
    const blanked = blankSqlComments(raw);
    expect(blanked.split('\n')[91], 'and after blanking, the comment is gone').not.toContain('REPLACE FUNCTION');
    // And the line numbering survives blanking, which is what lets a failure
    // name a line the reader can open.
    expect(blanked.split('\n')).toHaveLength(raw.split('\n').length);
    expect(blanked.split('\n')[4280]).toContain('customer_ar_aging');
  });
});

describe('DR-106 §2.1 — the law', () => {
  it('finds EXACTLY the measured baseline: no new file outside migrations/ replaces a sealed function', () => {
    const v = verdict(ROOT);
    const surplus = v.surplus.map((r) => `${r.file}:${r.line} ${r.fn}`);
    expect(
      surplus,
      `a file outside ${MIGRATIONS_PREFIX} now CREATE OR REPLACEs a function that a SEALED migration creates. ` +
        `CREATE OR REPLACE substitutes a body WITHOUT WARNING, so applying such a file to a migrated tree can ` +
        `silently change a live financial read — which is the defect DR-106 was written for. Either stop ` +
        `replacing a sealed name, or take the owner's decision to add it to DR106_BASELINE with its reason.`,
    ).toEqual([]);
    // The baseline cannot rot either: an entry that disappeared means the list
    // is stale, and a stale allow-list is how a law stops being one.
    expect(
      v.vanished.map((x) => `${x.file} ${x.fn} expected ${x.expected} found ${x.actual}`),
      'DR106_BASELINE lists an occurrence the tree no longer has — re-measure and shrink the list',
    ).toEqual([]);
    expect(v.found.length, 'occurrences found').toBe(48);
    expect(
      DR106_BASELINE.reduce((a, b) => a + b.count, 0),
      'occurrences the baseline allows',
    ).toBe(48);
    expect(DR106_BASELINE.length, 'distinct (file, function) pairs').toBe(40);
  });

  it('counts a SECOND replacement in an already-listed file as surplus', () => {
    // The baseline is a budget per (file, function), not a licence for a file.
    const listed = DR106_BASELINE.find((b) => b.file === 'infrastructure/database/specifications/p4s7-installment-aging.spec.sql');
    expect(listed?.count).toBe(1);
    const doubled = tally([
      { file: listed?.file as string, line: 4222, fn: 'customer_ar_aging' },
      { file: listed?.file as string, line: 9999, fn: 'customer_ar_aging' },
    ]);
    expect(doubled.get(`${listed?.file}\u0000customer_ar_aging`)).toBe(2);
    expect(doubled.get(`${listed?.file}\u0000customer_ar_aging`)).toBeGreaterThan(listed?.count as number);
  });
});

describe('DR-106 §2.1 — THE NEGATIVE CONTROL, BY A PLANTED FILE', () => {
  it('goes RED on a planted file outside migrations/, and GREEN again when it is removed', () => {
    // A unique temp directory, outside the repository: RULE-17 (a measuring
    // tool two writers share reports on a third tree) and RULE-14 (never
    // inside the repo, which would dirty the owner's DR-09 count).
    const dir = mkdtempSync(join(tmpdir(), 'dr106-plant-'));
    const planted = join(dir, 'planted-sealed-replacement.sql');
    try {
      writeFileSync(planted, `-- a planted violation\n${plantedHead('customer_ar_aging')}\n`, 'utf8');

      // DR-55/RULE-27: PROVE THE PLANT APPLIED BEFORE READING ITS RESULT. A
      // plant that matched nothing reads as a passing control while being
      // nothing at all.
      expect(existsSync(planted), 'the planted file exists on disk').toBe(true);
      const back = readFileSync(planted, 'utf8') as string;
      expect(back, 'the planted file really carries the forbidden head').toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+customer_ar_aging\s*\(/i);

      const names = sealedFunctionNames(ROOT);
      const red = scanForSealedReplacements(ROOT, [planted], names);
      expect(red, 'the law must name the planted file').toHaveLength(1);
      expect(red[0]?.fn).toBe('customer_ar_aging');
      expect(red[0]?.line, 'and the line, so the failure is openable').toBe(2);
      expect(red[0]?.file).toBe(planted);

      // THE SAME PLANT WITH A NAME NO SEALED MIGRATION CREATES STAYS GREEN.
      // This is not a decoration: it is DR-106 §3's gap, executed. The law is
      // hinged on a sealed name, so a routine first created by 0080..0086 is
      // NOT protected — and `customer_collect_payment` moves money.
      const gap = candidateOnlyFunctionNames(ROOT);
      expect(gap.size, 'function names created only above frozenThrough').toBe(18);
      expect(gap.has('customer_collect_payment')).toBe(true);
      const unprotected = join(dir, 'planted-unprotected.sql');
      writeFileSync(unprotected, `${plantedHead('customer_collect_payment')}\n`, 'utf8');
      expect(existsSync(unprotected)).toBe(true);
      expect(
        scanForSealedReplacements(ROOT, [unprotected], names),
        'DR-106 §3: the law as the owner wrote it does NOT reach a post-0079 name. ' +
          'Widening it to «a name any numbered migration creates» would, and that is the owner to decide.',
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // And green once the plant is gone — asserted after the cleanup, so the
    // control cannot leave the tree red for the next reader.
    expect(existsSync(planted)).toBe(false);
    expect(verdict(ROOT).surplus).toEqual([]);
  });
});

describe('DR-106 §2.2 — the specification is marked as an UNAPPLIED DESIGN', () => {
  it('says so in its first lines, names 0084 as the law, and warns what applying it does', () => {
    const head = (readFileSync(join(ROOT, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8') as string)
      .split('\n')
      .slice(0, 40)
      .join('\n');
    // Marking rather than renaming, because BOTH renames were measured to
    // break consumers — see the module header and the PR body.
    expect(head).toContain('UNAPPLIED DESIGN');
    expect(head).toContain('NOT THE LAW');
    expect(head).toContain('0084');
    expect(head).toContain('DR-106');
  });
});
