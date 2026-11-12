/**
 * THE SCRATCH DATABASE'S HEAD IS DERIVED, NOT WRITTEN DOWN.
 *
 * `tests/security/p4s4-rls-barrier-behaviour.test.ts` used to say
 * `!head.startsWith('0086_')`. The claim behind that line is "the scratch
 * database was built to the WHOLE migration set", and a literal number is a
 * way of writing it that stops being true the day anyone adds a migration:
 * the suite then throws in `beforeAll`, before one assertion runs, and the
 * red is read as a defect in the policy surface. It happened when 0091 landed
 * (PR #82, run 43154786640, step #26: "the scratch database was not built to
 * 0086 but to 0091_p4s1_customer_write_commands.sql").
 *
 * The fix is a number that is DERIVED — the head the folder actually holds —
 * and NOT a weaker claim. So the law below is what "built to the whole set"
 * has to keep meaning:
 *
 *   - a database whose last applied migration IS the folder's head is accepted,
 *     whatever number that head carries;
 *   - a database built LOWER than the head is refused, by name, and so is an
 *     empty one — otherwise a half-built database would pass for a full one;
 *   - a head that merely shares a prefix with the expected one is not enough.
 *
 * The honest case is the control for the others: it proves the checker does
 * not answer "problem" to everything.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scratchHeadProblem } from '../tests/helpers/scratch-head';

const FILES = ['0000_a.sql', '0085_b.sql', '0086_c.sql', '0090_d.sql', '0091_e.sql'];

describe('scratchHeadProblem', () => {
  it('accepts a database whose last applied migration is the folder head, whatever number that is', () => {
    expect(scratchHeadProblem(FILES, '0091_e.sql')).toBeNull();
    expect(scratchHeadProblem(FILES.slice(0, 3), '0086_c.sql')).toBeNull();
  });

  it('refuses a database built lower than the head, and names both', () => {
    const problem = scratchHeadProblem(FILES.slice(0, 4), '0091_e.sql');
    expect(problem).not.toBeNull();
    expect(problem).toContain('0090_d.sql');
    expect(problem).toContain('0091_e.sql');
  });

  it('refuses a database nothing was applied to', () => {
    expect(scratchHeadProblem([], '0091_e.sql')).toContain('no migration was applied');
  });

  it('refuses a head that only shares the prefix with the expected one', () => {
    expect(scratchHeadProblem([...FILES.slice(0, 4), '0091_other.sql'], '0091_e.sql')).not.toBeNull();
  });

  it('refuses a database built HIGHER than the folder head, so a stale folder cannot read as current', () => {
    expect(scratchHeadProblem(FILES, '0090_d.sql')).not.toBeNull();
  });
});

describe('the barrier suite uses the derived head', () => {
  const suite = readFileSync(join(__dirname, '..', 'tests', 'security', 'p4s4-rls-barrier-behaviour.test.ts'), 'utf8');

  it('reads the right file', () => {
    expect(suite).toContain("createScratchDb('daftar_p4s4_barrier')");
  });

  it('no longer pins a literal migration number in its beforeAll', () => {
    expect(suite, 'the suite is back to a literal head, so the next migration reds it before one assertion runs').not.toMatch(/startsWith\('00\d\d_'\)/);
  });

  it('refuses to derive the head from an EMPTY folder: a comparison against nothing passes vacuously', () => {
    expect(suite, 'the derivation has no positive control that the migrations folder holds files').toContain('migrationFiles()');
    expect(suite).toContain('NO SUBJECT');
  });

  it('asks the checker, against the head the folder holds', () => {
    expect(suite).toContain('scratchHeadProblem(');
    expect(suite).toContain('headMigration()');
  });
});
