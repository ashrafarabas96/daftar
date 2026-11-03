/**
 * P4-S1 — THE ROSTER'S OWN PROTECTIONS, PLANTED AGAINST.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`, and the estate's own
 * wording of it: «a golden with no red proof is a claim, not a test»
 * (P4-AL-67). Three mechanisms were added to `scripts/phase4-s1-gate.ts` when
 * the four P4-S7 instalment suites were rostered — the case FLOOR, the pinned
 * TITLES, and the DEFERENCE to another slice's basename rule — and a mechanism
 * whose refusal has only ever been exercised by hand, outside the tree, guards
 * nothing against the next commit. So every one of them is planted against
 * here.
 *
 * The three defect classes, in the order they were found:
 *
 * §A THE FLOOR. A row that names only a file protects the FILE: a case deleted
 *    out of a rostered suite leaves the path, the name and the green.
 *
 * §B THE TITLES. A floor protects the COUNT, and a count cannot tell deletion
 *    from SUBSTITUTION. Gut every `expect(` of a money case and rename its
 *    title to something harmless: the count does not move. On instalment and
 *    aging suites that is how «only the fallen-due half is in the oldest band»
 *    (defect C-1), «the not-yet-due half», «the parts sum to the whole» and
 *    «the aging comes from the passed asOf and not from a clock» leave the
 *    estate in silence. These are money claims, so they are pinned by name.
 *
 * §C THE DEFERENCE. The scan defers to the roster that owns a `p4sN-`
 *    basename — today P4-S4's. The first version of that check asked whether
 *    the rule's TEXT appeared anywhere in the owning script, which a COMMENT
 *    satisfies: narrow the live `const S4_BASENAME` to `/^(?:customer-s4-)/`,
 *    leave the old expression behind as a comment, and the text search is happy
 *    while twenty-four `p4s4-` suites — money paths among them — are discovered
 *    by no roster and executed by nothing, both gates green. The check is
 *    anchored on the live declaration instead, and that plant is performed
 *    below rather than described.
 *
 * Nothing here touches a database: every assertion is over the gate's pure
 * functions and over text written into a temporary tree, which is why this
 * suite says what it says on any platform.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FOREIGN_SLICE_ROSTERS_FOR_PROOF,
  S1_SUITES,
  type SuiteEntry,
  caseFloorProblems,
  foreignRosterProblems,
  isPending,
  liveDeclaration,
  unrosteredElsewhere,
} from '../../scripts/phase4-s1-gate';

const ROOT = join(__dirname, '../..');

/** The rostered rows, which is what every arm below judges. */
const ROWS: readonly SuiteEntry[] = S1_SUITES.filter((e): e is SuiteEntry => !isPending(e));
/** The rows this card added: the four P4-S7 instalment suites. */
const S7_ROWS: readonly SuiteEntry[] = ROWS.filter((e) => e.area === 'phase4-s7-spec');

/** A tree that holds exactly the files an arm needs, so nothing else can make it pass or fail. */
const temps: string[] = [];
function treeWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'p4s1-roster-'));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return root;
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** The problems naming `fragment`, so a plant's own finding is read rather than the whole list. */
const about = (problems: readonly string[], fragment: string): string[] => problems.filter((p) => p.includes(fragment));

/** The rostered row an arm is about. Its absence is not a type question: it means the arm has no subject, and that is the finding. */
function rosteredRow(suffix: string): SuiteEntry {
  const found = S7_ROWS.find((r) => r.file.endsWith(suffix));
  if (found === undefined) throw new Error(`no rostered P4-S7 row ends with ${suffix} — this arm has no subject`);
  return found;
}

/** The row's recorded floor, which an arm plants against; a row without one would make the plant prove nothing. */
function floorOf(row: SuiteEntry): number {
  if (row.cases === undefined) throw new Error(`${row.id} carries no case floor — this arm has no subject`);
  return row.cases;
}

/** The foreign roster the deference arms attack, read from the real list rather than from a copy. */
function firstForeignRoster(): (typeof FOREIGN_SLICE_ROSTERS_FOR_PROOF)[number] {
  const found = FOREIGN_SLICE_ROSTERS_FOR_PROOF[0];
  if (found === undefined) throw new Error('no foreign roster is declared, so the deference arms have no subject');
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// §0 the subject is not empty
// ─────────────────────────────────────────────────────────────────────────────

describe('§0 the rows this suite judges', () => {
  it('the four P4-S7 instalment suites are rostered, and each carries a floor and pinned titles', () => {
    expect(S7_ROWS.map((r) => r.file).sort(), 'the four instalment suites are not in the roster, so every arm below judges nothing').toStrictEqual([
      'tests/integration/phase4-s7-installment-aging-db.test.ts',
      'tests/integration/phase4-s7-installment-aging-live.test.ts',
      'tests/integration/phase4-s7-installment-concurrency-db.test.ts',
      'tests/integration/phase4-s7-installment-fact-db.test.ts',
    ]);
    for (const row of S7_ROWS) {
      expect(row.cases, `${row.id} carries no case floor`).toBeGreaterThan(1);
      expect((row.titles ?? []).length, `${row.id} pins no title, so a substitution in it would be silent`).toBeGreaterThan(0);
    }
  });

  it('the real tree satisfies every floor and every pinned title it records', () => {
    expect(caseFloorProblems(ROOT, ROWS), 'the recorded floors and titles do not hold on the tree they were measured from').toStrictEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §A the floor
// ─────────────────────────────────────────────────────────────────────────────

describe('§A the case floor', () => {
  const victim = (): SuiteEntry => rosteredRow('phase4-s7-installment-aging-db.test.ts');

  it('RED: a floor ABOVE the measured case count is reported, with both numbers named', () => {
    const planted: SuiteEntry = { ...victim(), cases: floorOf(victim()) + 1 };
    const found = about(caseFloorProblems(ROOT, [planted]), planted.file);
    expect(found.length, 'a floor above the measured count left the law silent').toBe(1);
    expect(found[0]).toContain(`its recorded floor is ${planted.cases}`);
  });

  it('RED: a floor of one, and a floor of zero, are each refused as no floor at all', () => {
    for (const dead of [1, 0]) {
      const planted: SuiteEntry = { ...victim(), cases: dead, titles: undefined };
      const found = about(caseFloorProblems(ROOT, [planted]), 'bounds nothing');
      expect(found.length, `a floor of ${dead} was accepted, so a row could record a number that judges nothing`).toBe(1);
    }
  });

  it('RED: a floor or a pinned title on a DIRECTORY row is refused, because the directory is not a fixed set', () => {
    const planted: SuiteEntry = { id: 'GD-PLANT', area: 'guard-proofs', runner: 'root', file: 'tests/guards', directory: true, cases: 5 };
    expect(about(caseFloorProblems(ROOT, [planted]), 'DIRECTORY row').length, 'a floor on a directory row was accepted').toBe(1);
  });

  it('RED: an EMPTY pinned-title list is refused rather than passing vacuously', () => {
    const planted: SuiteEntry = { ...victim(), cases: undefined, titles: [] };
    expect(about(caseFloorProblems(ROOT, [planted]), 'EMPTY pinned-title list').length, 'an empty title list passed, and it judges nothing').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §B the pinned titles — the substitution a count cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('§B the pinned money claims', () => {
  const live = rosteredRow('phase4-s7-installment-aging-live.test.ts');

  it('the oldest-band, not-yet-due, conservation and asOf claims are among the pinned titles', () => {
    const pinned = (live.titles ?? []).join('\n');
    for (const claim of ['only the FALLEN-DUE half is in the oldest band', 'the NOT-YET-DUE half', 'CONSERVATION', 'BASE CONSERVATION', 'asOf'])
      expect(pinned, `the money boundary "${claim}" is not pinned, so renaming its case would be silent`).toContain(claim);
  });

  it('RED: a pinned money claim RENAMED — the count unchanged — is reported by name', () => {
    const planted: SuiteEntry = {
      ...live,
      titles: [...(live.titles ?? []).slice(1), 'the module loads'],
    };
    const found = about(caseFloorProblems(ROOT, [planted]), 'the module loads');
    expect(found.length, 'a pinned claim replaced by a harmless title left the law silent — this is the substitution the floor cannot see').toBe(1);
    expect(found[0]).toContain('no longer has the pinned case');
  });

  it('RED: the SAME plant is invisible to the floor alone, which is why the titles exist', () => {
    // The count is untouched by a rename, so the floor arm of the very same
    // function reports nothing. If this ever starts failing, the floor has
    // grown an ability it does not have and §B has stopped isolating anything.
    const planted: SuiteEntry = { ...live, titles: undefined };
    expect(
      about(caseFloorProblems(ROOT, [planted]), 'recorded floor is'),
      'the floor reported a renamed case, so this arm is not isolating the substitution class',
    ).toStrictEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §C the basename rule, and the deference to the roster that owns it
// ─────────────────────────────────────────────────────────────────────────────

describe('§C the sliced basename and the foreign roster', () => {
  it('the widening is ADDITIVE: every basename the old rule caught is still caught', () => {
    for (const base of ['p4-anything.test.ts', 'phase4-s1-forward-scope.test.ts', 'phase4-route-surface.test.ts'])
      expect(unrosteredElsewhere(base), `${base} was visible to the old rule and is not visible now`).toBe(true);
  });

  it('a p4sN- suite no other roster owns must be listed here, and one P4-S4 owns is deferred', () => {
    expect(unrosteredElsewhere('p4s9-roster-escape.test.ts'), 'a p4s9- suite escapes this roster, so nothing would run it').toBe(true);
    expect(unrosteredElsewhere('p4s7-installment-filter-contract.test.ts'), 'a p4s7- suite escapes this roster').toBe(true);
    expect(
      unrosteredElsewhere('p4s4-payment-closure.test.ts'),
      'a P4-S4 suite is demanded here too, which would run that slice’s matrix inside this gate',
    ).toBe(false);
    expect(unrosteredElsewhere('selling.service.test.ts'), 'a suite of no phase is claimed by this roster').toBe(false);
  });

  it('the deference is to a LIVE declaration, and the real tree still carries it', () => {
    expect(FOREIGN_SLICE_ROSTERS_FOR_PROOF.length, 'no foreign roster is declared, so §C judges nothing').toBeGreaterThan(0);
    expect(foreignRosterProblems(ROOT), 'the foreign roster rule this scan defers to is not declared where it was read').toStrictEqual([]);
  });

  it('RED: the foreign rule NARROWED while the old text survives as a COMMENT is reported — the hole a free text search left open', () => {
    const r = firstForeignRoster();
    // The exact shape of the attack: the live rule now matches almost nothing,
    // and the expression this gate reads is still present — in prose.
    const planted = `// const ${r.constName} = ${r.literal};\nconst ${r.constName} = /^(?:customer-s4-)/;\n`;
    expect(planted, 'the plant does not carry the old expression, so it is not the attack this arm is about').toContain(r.literal);
    const root = treeWith({ [r.script]: planted });
    const found = about(foreignRosterProblems(root), r.constName);
    expect(found.length, 'a narrowed live rule with the old expression left in a comment passed — a comment is not the rule').toBe(1);
    expect(found[0]).toContain('is not the rule');
  });

  it('RED: the foreign rule REPLACED outright, and the owning script GONE, are each reported', () => {
    const r = firstForeignRoster();
    const replaced = treeWith({ [r.script]: `const ${r.constName} = /^(?:customer-s4-)/;\n` });
    expect(about(foreignRosterProblems(replaced), 'no longer DECLARES').length, 'a replaced rule passed').toBe(1);
    const absent = treeWith({ 'package.json': '{}' });
    expect(about(foreignRosterProblems(absent), 'the deference is void').length, 'a missing owning script passed').toBe(1);
  });

  it('the declaration matcher accepts the real shapes and rejects prose, assignment and a different name', () => {
    const re = liveDeclaration('S4_BASENAME', '/^(?:p4s4-)/');
    expect(re.test('const S4_BASENAME = /^(?:p4s4-)/;'), 'the plain declaration is not matched').toBe(true);
    expect(re.test('export const S4_BASENAME: RegExp = /^(?:p4s4-)/;'), 'an exported, annotated declaration is not matched').toBe(true);
    expect(re.test('S4_BASENAME = /^(?:p4s4-)/;'), 'a bare assignment is accepted as a declaration').toBe(false);
    expect(re.test('const S4_BASENAME_OLD = /^(?:p4s4-)/;'), 'a different constant is accepted').toBe(false);
    expect(re.test('const S4_BASENAME = /^(?:p4s4-|x)/;'), 'a different expression is accepted').toBe(false);
  });
});
