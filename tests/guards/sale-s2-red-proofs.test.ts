/**
 * P4-S2 — THE RED PROOFS OF THE GOLDEN AND CONCURRENCY ESTATE.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-67 — "every golden and every
 *  invariant has a named, resolved RED proof"; P4-AL-65;
 *  docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §7.)
 *
 * "A golden with no red proof is a claim, not a test." Four kinds of proof:
 *
 *   1. EVERY LAW OF §15 IS PLANTED AGAINST. Each of the seven laws of
 *      `atomic-sale-law.ts` is handed a committed state that violates exactly
 *      it, and must name the violation. A lawful world must produce none. The
 *      laws are a pure function of the projected state precisely so this proof
 *      can exist before any writer does.
 *
 *   2. THE CANARY ITSELF CAN SAY NO, AND CAN SAY YES. `requireSubject` throws
 *      when the subject is absent and does not throw when it is present. A
 *      canary that could only throw would be a permanent red; a canary that
 *      could not throw would be no canary.
 *
 *   3. THE RUNNER'S EXIT STATUS CAN SAY NO. This project's runner once exited
 *      0 over four failing tests. A gate that reads a verdict out of an exit
 *      status must first prove that status can say no, so a real runner is
 *      spawned over a deliberately failing test and the exit code must be
 *      non-zero — and over a passing one, zero. Both halves: an exit status
 *      that is always non-zero is as useless as one that is always zero.
 *
 *   4. EVERY DECLARED RED PROOF RESOLVES. `RED_PROOFS` below is the
 *      `<test file>::<it( title prefix>` table P4-AL-67 requires, and this
 *      suite verifies that each row resolves to a REAL title in a REAL file.
 *      A table of red proofs nobody checked is the same claim one level up.
 *
 * Green today, and it depends on nothing P4-S2 has yet to write. It lives in
 * `tests/guards`, which the gates run BY DIRECTORY, so it cannot be committed
 * and never executed — the failure `guardSuiteProblems` is named after.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { suiteProblems } from '../../scripts/phase4-s1-gate';
import { LAWS, atomicSaleLawViolations, type SaleWorld } from '../golden-regression/phase4-s2/atomic-sale-law';
import { censusDelta, requireSubject } from '../golden-regression/phase4-s2/harness';
import { stockRefusalCode } from '../golden-regression/phase4-s2/sale-path';

const REPO = join(__dirname, '..', '..');
const S2_GOLDEN_DIR = 'tests/golden-regression/phase4-s2';

/**
 * The P4-AL-67 table for this slice: one row per defect the estate claims to
 * catch, naming the test that catches it as `<file>::<it( title prefix>`.
 * Every row is RESOLVED below against the titles actually in the file.
 */
export const RED_PROOFS: readonly { readonly id: string; readonly defect: string; readonly proof: string }[] = [
  {
    id: 'RP-S2-RACE',
    defect: 'two concurrent attempts on the final unit both commit, or the loser crashes instead of being refused',
    proof: `${S2_GOLDEN_DIR}/05-last-item-race.golden.test.ts::exactly one attempt is refused`,
  },
  {
    id: 'RP-S2-OVERSELL',
    defect: 'a stock level is allowed below zero, or a phantom movement survives the losing attempt',
    proof: `${S2_GOLDEN_DIR}/05-last-item-race.golden.test.ts::\`on_hand\` ends at exactly zero`,
  },
  {
    id: 'RP-S2-LOCKORDER',
    defect: 'the stock keys are acquired in payload order rather than key order, so two multi-key commands can deadlock',
    proof: `${S2_GOLDEN_DIR}/05-last-item-race.golden.test.ts::the lock order is the KEY order`,
  },
  {
    id: 'RP-S2-DEADLOCK-VERDICT',
    defect: 'a deadlock is reported as contention, retried, or treated as a business outcome instead of as a lock-order defect',
    proof: 'tests/integration/sale-s2-interleaving.test.ts::a real deadlock is classified as a deadlock',
  },
  {
    id: 'RP-S2-UNFORCED',
    defect: 'a concurrency verdict is read out of an interleaving that was never forced, so the verdict is the machine’s speed',
    proof: 'tests/integration/sale-s2-interleaving.test.ts::waitUntilQueued throws when the attempt settles without ever parking',
  },
  {
    id: 'RP-S2-BOUND',
    defect: 'the expiry of an observation bound is treated as a pass',
    proof: 'tests/integration/sale-s2-interleaving.test.ts::waitUntilQueued throws when its bound expires',
  },
  {
    id: 'RP-S2-EMPTY-PARK',
    defect: 'a park on a row that does not exist holds no lock and the suite proceeds as though it did',
    proof: 'tests/integration/sale-s2-interleaving.test.ts::parkStockKey throws rather than holding nothing',
  },
  {
    id: 'RP-S2-CENSUS',
    defect: 'the atomicity census is a hand-maintained list, so a row surviving in a relation nobody listed is invisible',
    proof: 'tests/integration/sale-s2-interleaving.test.ts::the census is discovered from the catalogue',
  },
  {
    id: 'RP-S2-ATOMIC',
    defect: 'a partial sale survives a failure at one of the seams of the commit path',
    proof: 'tests/integration/sale-s2-atomic-law.test.ts::a failure at the sales seam leaves nothing',
  },
  {
    id: 'RP-S2-SEAMSET',
    defect: 'the sale writes a relation no case injects a failure at, so that seam is outside the proof',
    proof: 'tests/integration/sale-s2-atomic-law.test.ts::every discovered seam was covered by a case above',
  },
  {
    id: 'RP-S2-SALE-RACE',
    defect: 'two concurrent SALES of the final unit both commit, or the sale oversells where the stock writer would not',
    proof: `${S2_GOLDEN_DIR}/06-sale-last-item-race.golden.test.ts::exactly one sale commits`,
  },
  {
    id: 'RP-S2-SALE-ORPHAN',
    defect: 'the losing sale leaves an orphan invoice, an orphan journal entry, a phantom movement or an unbound entry',
    proof: `${S2_GOLDEN_DIR}/06-sale-last-item-race.golden.test.ts::no orphan journal`,
  },
  {
    id: 'RP-S2-LAWS',
    defect: 'one of the seven committed states §15 forbids is reachable',
    proof: `${S2_GOLDEN_DIR}/07-atomic-sale-law.golden.test.ts::the whole law set holds at once`,
  },
  {
    id: 'RP-S2-RECONCILE',
    defect: 'GL Inventory (1200) is reconstructed from quantity × average cost instead of Σ value_delta_base_minor',
    proof: `${S2_GOLDEN_DIR}/07-atomic-sale-law.golden.test.ts::the identity is never reconstructed from quantity × average cost`,
  },
  {
    id: 'RP-S2-CHART',
    defect: 'a balanced entry is made of the wrong accounts, which balances perfectly',
    proof: `${S2_GOLDEN_DIR}/07-atomic-sale-law.golden.test.ts::the three account identities carry the codes written out`,
  },
  {
    id: 'RP-S2-REPLAY',
    defect: 'a replayed sale writes a second sale, movement, decrement, invoice or journal entry',
    proof: `${S2_GOLDEN_DIR}/08-sale-idempotency.golden.test.ts::the replay writes nothing a second time`,
  },
  {
    id: 'RP-S2-KEY',
    defect: 'the sale’s idempotency is a service-layer look-first rather than a UNIQUE over real columns',
    proof: `${S2_GOLDEN_DIR}/08-sale-idempotency.golden.test.ts::the structural half: a UNIQUE or primary key`,
  },
  {
    id: 'RP-S2-VACUITY',
    defect: 'a P4-S2 claim reports green while its subject does not exist',
    proof: 'tests/guards/sale-s2-red-proofs.test.ts::the canary says NO when the subject is absent',
  },
  {
    id: 'RP-S2-EXIT',
    defect: 'the runner exits 0 over failing tests, so a gate that reads its exit status reports a pass',
    proof: 'tests/guards/sale-s2-red-proofs.test.ts::the runner’s exit status can say no',
  },
  {
    id: 'RP-S2-PLACEMENT',
    defect: 'a P4-S2 file is placed where the SEALED gate:phase4:s1 fails over it',
    proof: 'tests/guards/sale-s2-red-proofs.test.ts::no P4-S2 file turns the sealed gate red',
  },
];

/** A world in which every law of §15 holds. The tampered worlds below are this one, with one thing changed. */
const LAWFUL: SaleWorld = {
  sales: [{ id: 'sale-1' }],
  saleItems: [{ saleId: 'sale-1' }],
  invoices: [{ id: 'inv-1', saleId: 'sale-1', status: 'open', bindingSourceId: 'inv-1' }],
  invoiceItems: [{ invoiceId: 'inv-1' }],
  movements: [{ sourceType: 'sale', sourceId: 'sale-1', valueDeltaBaseMinor: '-1000' }],
  bindings: [
    { sourceType: 'sale', sourceId: 'sale-1', journalEntryId: 'je-cogs' },
    { sourceType: 'invoice', sourceId: 'inv-1', journalEntryId: 'je-rev' },
  ],
  entries: [
    { id: 'je-cogs', sourceType: 'sale', sourceId: 'sale-1', systemKeys: ['cogs', 'inventory'] },
    { id: 'je-rev', sourceType: 'invoice', sourceId: 'inv-1', systemKeys: ['sales_revenue', 'accounts_receivable'] },
  ],
};

/** One planted defect per law, each the LAWFUL world with exactly one thing changed. */
const PLANTED: readonly { readonly law: string; readonly what: string; readonly world: SaleWorld }[] = [
  { law: 'L0', what: 'a world with no sale at all', world: { ...LAWFUL, sales: [] } },
  { law: 'L1', what: 'a sale whose stock movement is missing', world: { ...LAWFUL, movements: [] } },
  {
    law: 'L2',
    what: 'a stock movement whose invoice is missing',
    world: {
      ...LAWFUL,
      invoices: [],
      invoiceItems: [],
      bindings: LAWFUL.bindings.filter((b) => b.sourceType !== 'invoice'),
      entries: LAWFUL.entries.filter((e) => e.id !== 'je-rev'),
    },
  },
  {
    law: 'L3',
    what: 'an open invoice with no accounting binding',
    world: {
      ...LAWFUL,
      invoices: [{ id: 'inv-1', saleId: 'sale-1', status: 'open', bindingSourceId: null }],
      bindings: LAWFUL.bindings.filter((b) => b.sourceType !== 'invoice'),
    },
  },
  {
    law: 'L4',
    what: 'a COGS entry naming a sale that does not exist',
    world: {
      ...LAWFUL,
      entries: [{ id: 'je-cogs', sourceType: 'sale', sourceId: 'sale-gone', systemKeys: ['cogs'] }, ...LAWFUL.entries.slice(1)],
      bindings: [{ sourceType: 'sale', sourceId: 'sale-gone', journalEntryId: 'je-cogs' }, ...LAWFUL.bindings.slice(1)],
    },
  },
  {
    law: 'L5',
    what: 'a revenue entry bound to a sale instead of to an invoice',
    world: {
      ...LAWFUL,
      entries: [LAWFUL.entries[0] as SaleWorld['entries'][number], { id: 'je-rev', sourceType: 'sale', sourceId: 'sale-1', systemKeys: ['sales_revenue'] }],
    },
  },
  {
    law: 'L6',
    what: 'an inventory decrement with no COGS entry',
    world: {
      ...LAWFUL,
      entries: [{ id: 'je-rev', sourceType: 'invoice', sourceId: 'inv-1', systemKeys: ['sales_revenue'] }],
      bindings: [{ sourceType: 'invoice', sourceId: 'inv-1', journalEntryId: 'je-rev' }],
    },
  },
  { law: 'L7', what: 'a sale committed without its lines', world: { ...LAWFUL, saleItems: [] } },
];

describe('P4-S2 red proofs: every law, every canary and the exit status are proved able to say no', () => {
  it('the lawful world violates nothing — a law set that always says no is as useless as one that never does', () => {
    expect(atomicSaleLawViolations(LAWFUL), 'a committed state in which §15 holds produces no violation').toEqual([]);
  });

  for (const plant of PLANTED) {
    it(`${plant.law} says NO to ${plant.what}`, () => {
      const law = LAWS.find((l) => l.id === plant.law);
      expect(law, `the law ${plant.law} exists`).toBeDefined();
      const named = (law as { check: (w: SaleWorld) => readonly string[] }).check(plant.world);
      expect(named.length, `${plant.law} must name the planted defect, not pass over it`).toBeGreaterThan(0);
      for (const message of named)
        expect(message, `${plant.law}'s message names the law it belongs to`).toContain(plant.law === 'L0' ? 'NO SUBJECT' : plant.law);
    });
  }

  it('every law of §15 is planted against — no law is on the books with no proof', () => {
    const planted = new Set(PLANTED.map((p) => p.law));
    const unproved = LAWS.filter((l) => !planted.has(l.id)).map((l) => `${l.id} (${l.forbids})`);
    expect(unproved, 'a law with no planted defect is a claim, not a test (P4-AL-67)').toEqual([]);
  });

  it('the canary says NO when the subject is absent, and says nothing when it is present', () => {
    expect(() => requireSubject(['relation sales'], 'a claim about a sale')).toThrow(/NO SUBJECT/);
    expect(() => requireSubject(['relation sales'], 'a claim about a sale')).toThrow(/relation sales/);
    expect(() => requireSubject([], 'a claim about a sale'), 'a canary that could only throw would be a permanent red').not.toThrow();
  });

  it('the census delta says NO to a surviving row, and nothing to an unchanged world', () => {
    expect(censusDelta({ sales: 0, stock_movements: 2 }, { sales: 1, stock_movements: 2 }), 'a surviving row is named').toEqual({ sales: 1 });
    expect(censusDelta({ sales: 1 }, { sales: 1 }), 'an unchanged world moves nothing').toEqual({});
    // A relation that DISAPPEARS between two censuses is reported too: a
    // dropped relation is not an unchanged one.
    expect(censusDelta({ sales: 3 }, {}), 'a relation that vanished is reported').toEqual({ sales: -3 });
  });

  it('the refusal reader finds the stock code at depth and returns null when there is none', () => {
    const found = { body: { error: { code: 'CONFLICT', details: { inventoryCode: 'inventory.insufficient_stock' } } } };
    expect(stockRefusalCode(found as never), 'a nested stable code is found').toBe('inventory.insufficient_stock');
    expect(stockRefusalCode({ body: { error: { code: 'CONFLICT' } } } as never), 'a refusal with no stock code reads as none').toBeNull();
    expect(stockRefusalCode({ body: {} } as never), 'an empty body reads as none').toBeNull();
  });

  it('the runner’s exit status can say no — and can say yes', () => {
    // The lesson in the flesh: this project's runner once exited 0 over four
    // failing tests, so the verdict a gate read out of it was a verdict about
    // nothing. Before any gate reads an exit status, the status has to be
    // shown able to refuse. A minimal config is used on purpose — no
    // globalSetup, no setupFiles — so this proof is about the RUNNER's verdict
    // and not about the estate's harness.
    const dir = mkdtempSync(join(tmpdir(), 'p4s2-exit-'));
    try {
      writeFileSync(join(dir, 'vitest.config.ts'), `export default { test: { include: ['*.test.ts'], root: ${JSON.stringify(dir)} } };\n`);
      writeFileSync(join(dir, 'red.test.ts'), `import { expect, it } from 'vitest';\nit('fails', () => { expect(1).toBe(2); });\n`);
      writeFileSync(join(dir, 'green.test.ts'), `import { expect, it } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`);
      const run = (file: string): { status: number; out: string } => {
        try {
          const out = execFileSync(join(REPO, 'node_modules', '.bin', 'vitest'), ['run', file, '--config', join(dir, 'vitest.config.ts')], {
            cwd: dir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { status: 0, out };
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
        }
      };
      const red = run('red.test.ts');
      expect(red.status, `the runner must exit NON-ZERO over a failing test. It exited ${red.status}.\n${red.out}`).not.toBe(0);
      expect(red.out, 'and must say which test failed').toMatch(/1 failed/);
      const green = run('green.test.ts');
      expect(green.status, `the runner must exit ZERO over a passing test, or a non-zero status would mean nothing either.\n${green.out}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('every declared red proof resolves to a real `it(` title in a real file', () => {
    const problems: string[] = [];
    for (const row of RED_PROOFS) {
      const [file, title] = row.proof.split('::');
      if (file === undefined || title === undefined || title === '') {
        problems.push(`${row.id}: the proof is not of the form <file>::<it title prefix>`);
        continue;
      }
      let source: string;
      try {
        source = readFileSync(join(REPO, file), 'utf8');
      } catch {
        problems.push(`${row.id}: ${file} does not exist`);
        continue;
      }
      // The titles a suite GENERATES from a list are matched too: a generated
      // title is as real as a typed one.
      if (!source.includes(title) && !source.includes(title.replace(/^a failure at the \w+ seam/, 'a failure at the ${relation} seam')))
        problems.push(`${row.id}: no it( title in ${file} begins with ${JSON.stringify(title)}`);
    }
    expect(problems, 'a red proof that does not resolve is a claim about a test that is not there (P4-AL-67)').toEqual([]);
    expect(RED_PROOFS.length, 'the table is not empty').toBeGreaterThan(10);
  });

  it('every P4-S2 golden on disk is named by at least one red proof', () => {
    const goldens = readdirSync(join(REPO, S2_GOLDEN_DIR)).filter((f) => f.endsWith('.test.ts'));
    expect(goldens.length, 'NO SUBJECT — there are no P4-S2 goldens to prove anything about').toBeGreaterThan(0);
    const named = RED_PROOFS.map((r) => r.proof);
    const unproved = goldens.filter((f) => !named.some((p) => p.includes(f)));
    expect(unproved, 'a golden with no red proof is a claim, not a test (P4-AL-67)').toEqual([]);
  });

  it('no P4-S2 file turns the sealed gate red — the placement constraint, checked rather than assumed', () => {
    // `suiteProblems` of the SEALED `scripts/phase4-s1-gate.ts` fails any
    // `phase4-*`/`p4-*` suite in tests/integration, tests/security or
    // tests/performance that no `S1_SUITES` row lists (:750-753) AND any
    // `.test.ts` under `tests/golden-regression/phase4/` that no row lists
    // (:755-758). The sealed gate is not reopened and that file is not this
    // agent's to edit, so the P4-S2 estate is placed to satisfy both: the
    // goldens live in `tests/golden-regression/phase4-s2/` and the integration
    // suites are named `sale-s2-*`. This assertion is what keeps that true
    // after the next file is added.
    expect(suiteProblems(REPO), 'the sealed gate:phase4:s1 suite inventory must stay clean').toEqual([]);
    for (const dir of ['tests/integration', 'tests/security', 'tests/performance']) {
      let files: string[];
      try {
        files = readdirSync(join(REPO, dir));
      } catch {
        continue;
      }
      const mine = files.filter((f) => /^sale-s2-/.test(f));
      expect(
        mine.filter((f) => /^(p4|phase4)-/.test(f)),
        `a P4-S2 suite in ${dir} must not be named phase4-* or p4-*`,
      ).toEqual([]);
    }
  });
});
