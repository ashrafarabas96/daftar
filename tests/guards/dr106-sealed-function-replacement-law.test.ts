import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DR106_BASELINE,
  allMigrationFunctionNames,
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

  it('reports BOTH counts — the sealed subset and the widened scope — and the 18 the widening added', () => {
    const sealed = sealedFunctionNames(ROOT);
    const all = allMigrationFunctionNames(ROOT);
    // Each count is the probe's own positive control: an empty set would make
    // the whole law green by finding nothing, the failure mode of RULE-11 and
    // RULE-18. Both are asserted so the widening is a measured DIFFERENCE and
    // not a claim: 277 sealed, 295 across all 87 numbered migrations.
    expect(sealed.size, 'sealed subset (<= frozenThrough)').toBe(277);
    expect(all.size, 'the scope after the owner 2026-11-08 widening').toBe(295);
    expect(all.size - sealed.size, 'names the widening added').toBe(18);
    // The sealed set is a strict SUBSET: a widening that merely replaced the
    // set would satisfy the three numbers above while protecting something else.
    expect(
      [...sealed].every((n) => all.has(n)),
      'sealed names are all still protected',
    ).toBe(true);
    // Members measured by hand: `0075:798` creates the receivables-aging
    // routine DR-106 is about, `invoice_outstanding` is the sibling the
    // planted-body guards use, and both are sealed.
    expect(sealed.has('customer_ar_aging')).toBe(true);
    expect(sealed.has('invoice_outstanding')).toBe(true);
    // THE SEVENTEEN MONEY ROUTINES THE WIDENING RESCUED. Each was created only
    // after `0079`, so each was unprotected under the first scope. This list is
    // the reason the owner widened it, asserted rather than described.
    const added = candidateOnlyFunctionNames(ROOT);
    for (const fn of [
      'customer_collect_payment',
      'customer_apply_credit',
      'payment_complete',
      'payment_guard',
      'payment_closure_verify',
      'payment_allocation_guard',
      'payment_allocation_value_complete',
      'invoice_settlement_verify',
      'customer_credit_consume',
      'customer_credit_guard',
      'customer_credit_verify',
      'customer_credit_application_guard',
      'customer_credit_application_value_complete',
      'customer_open_invoices_page',
      'accounting_customer_payment_allocation_entry_complete',
      'accounting_customer_credit_entry_complete',
      'accounting_customer_credit_application_entry_complete',
    ]) {
      expect(added.has(fn), `${fn} was created only after 0079`).toBe(true);
      expect(sealed.has(fn), `${fn} was NOT protected before the widening`).toBe(false);
      expect(all.has(fn), `${fn} IS protected now`).toBe(true);
    }
    expect(added.size, 'names created only above frozenThrough').toBe(18);
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
    const found = scanForSealedReplacements(ROOT, trackedFiles(ROOT), allMigrationFunctionNames(ROOT));
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
      `a file outside ${MIGRATIONS_PREFIX} now CREATE OR REPLACEs a function that ANY NUMBERED MIGRATION creates. ` +
        `CREATE OR REPLACE substitutes a body WITHOUT WARNING, so applying such a file to a migrated tree can ` +
        `silently change a live financial read — which is the defect DR-106 was written for. Either stop ` +
        `replacing a migration's name, or take the owner's decision to add it to DR106_BASELINE with its reason.`,
    ).toEqual([]);
    // The baseline cannot rot either: an entry that disappeared means the list
    // is stale, and a stale allow-list is how a law stops being one.
    expect(
      v.vanished.map((x) => `${x.file} ${x.fn} expected ${x.expected} found ${x.actual}`),
      'DR106_BASELINE lists an occurrence the tree no longer has — re-measure and shrink the list',
    ).toEqual([]);
    expect(v.found.length, 'occurrences found').toBe(51);
    expect(
      DR106_BASELINE.reduce((a, b) => a + b.count, 0),
      'occurrences the baseline allows',
    ).toBe(51);
    expect(DR106_BASELINE.length, 'distinct (file, function) pairs').toBe(42);
  });

  it('counts a SECOND replacement in an already-listed file as surplus', () => {
    // The baseline is a budget per (file, function), not a licence for a file.
    const listed = DR106_BASELINE.find((b) => b.file === 'infrastructure/database/specifications/p4s7-installment-aging.spec.sql');
    expect(listed?.count).toBe(1);
    const doubled = tally([
      { file: listed?.file as string, line: 4281, fn: 'customer_ar_aging' },
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

      const names = allMigrationFunctionNames(ROOT);
      const red = scanForSealedReplacements(ROOT, [planted], names);
      expect(red, 'the law must name the planted file').toHaveLength(1);
      expect(red[0]?.fn).toBe('customer_ar_aging');
      expect(red[0]?.line, 'and the line, so the failure is openable').toBe(2);
      expect(red[0]?.file).toBe(planted);

      // ── THE PLANT THAT WAS INVERTED BY THE OWNER'S 2026-11-08 WIDENING ───
      //
      // IT USED TO BE REQUIRED TO STAY GREEN. Under the first scope the law
      // was hinged on a SEALED name, so a routine first created by
      // `0080..0086` was unprotected, and this plant proved that gap by NOT
      // being caught. The owner has since widened the scope to every name any
      // numbered migration creates, so THE SAME PLANT MUST NOW GO RED.
      //
      // The inversion is written out rather than quietly deleted, because a
      // plant left asserting the old direction would read as a passing control
      // for a law that no longer exists — and a control that is read as a
      // measurement while measuring nothing is worse than a failure
      // (RULE-17/RULE-27).
      const added = candidateOnlyFunctionNames(ROOT);
      expect(added.size, 'names created only above frozenThrough').toBe(18);

      // `invoice_settlement_verify` is the owner's own named case, and it is
      // the routine that ATTESTS AN INVOICE WAS SETTLED: if a file outside
      // `migrations/` could replace it, it could change what counts as a
      // settled invoice. `customer_collect_payment` is kept BESIDE it, not
      // instead of it, because it is the plant whose direction flipped.
      for (const fn of ['invoice_settlement_verify', 'customer_collect_payment']) {
        expect(added.has(fn), `${fn} is one of the 18 the widening added`).toBe(true);
        const plantedMoney = join(dir, `planted-money-${fn}.sql`);
        writeFileSync(plantedMoney, `${plantedHead(fn)}\n`, 'utf8');
        // DR-55/RULE-27 again, per plant: the bytes are read back BEFORE any
        // verdict, so a plant that matched nothing cannot read as a control.
        expect(existsSync(plantedMoney), `${fn}: the plant exists on disk`).toBe(true);
        expect(readFileSync(plantedMoney, 'utf8'), `${fn}: the plant really carries the forbidden head`).toMatch(
          new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+${fn}\s*\(`, 'i'),
        );
        const money = scanForSealedReplacements(ROOT, [plantedMoney], names);
        expect(money, `${fn}: the WIDENED law must catch a money routine created after 0079`).toHaveLength(1);
        expect(money[0]?.fn).toBe(fn);
        expect(money[0]?.file).toBe(plantedMoney);
        expect(money[0]?.line).toBe(1);
        // And it would NOT have been caught under the first scope — the
        // inversion measured in both directions, not merely asserted.
        expect(
          scanForSealedReplacements(ROOT, [plantedMoney], sealedFunctionNames(ROOT)),
          `${fn}: unprotected before the widening, which is why the owner widened it`,
        ).toEqual([]);
      }
    } finally {
      // Both plants and the directory go, whatever happened above.
      rmSync(dir, { recursive: true, force: true });
    }
    // And green once every plant is gone — asserted AFTER the cleanup, so no
    // control can leave the tree red, or a plant behind, for the next reader.
    expect(existsSync(planted), 'the first plant is gone').toBe(false);
    expect(existsSync(join(dir, 'planted-money-invoice_settlement_verify.sql')), 'the money plant is gone').toBe(false);
    expect(existsSync(dir), 'the temp directory is gone').toBe(false);
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
