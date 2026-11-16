/**
 * `0094` — THE OWNER BRACKET, AS A LAW THAT CANNOT BE DROPPED BY ACCIDENT.
 *
 * WHY THIS FILE EXISTS, and it is not a tidy-up. `#126`'s first run
 * (`43897541407`) was red in `backend-work` with
 *
 *     must be owner of function accounting_ar_control_line_source_document
 *
 * `0090:196` hands that function to `daftar_accounting_internal`, so a later
 * `CREATE OR REPLACE` of it needs the OWNER. `daftar_migrator` is not, and a
 * SUPERUSER is exempt — which is why every local cluster, applying the
 * migrations as `postgres`, was green and blind. The five
 * `migration-portability` cases whose names end "with no superuser anywhere in
 * the path" are the only witnesses of that whole class.
 *
 * The remedy is the estate's own bracket (`0045:973-985`): `SET LOCAL ROLE
 * daftar_accounting_internal` around the replacement, then `RESET ROLE`. The
 * membership exists already and is held `WITH SET TRUE` for exactly this kind
 * of statement and `WITH INHERIT FALSE` so it is never accounting authority by
 * accident — so the bracket USES a privilege rather than widening one.
 *
 * AND THE CONTROL THAT PROVED IT WAS WRITTEN IN A ONE-OFF SCRIPT, which is a
 * control that does not survive. This file is that control made permanent, and
 * it is a pure text law: no database, so nothing about it can be blind to who
 * owns what.
 *
 * It asserts the SHAPE and not merely the presence:
 *   - the bracket opens once and closes once;
 *   - it encloses the replacement that needs it;
 *   - and it does NOT enclose `invoice_outstanding`, which has no
 *     `ALTER … OWNER TO` anywhere in the tree and so belongs to the migrator.
 *     A bracket swallowing the whole file would be a privilege held longer
 *     than the statement that needs it.
 * Each of those is then shown to FAIL under a mutation of the file's text, so
 * none of them can pass vacuously.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = '0094_c3_allocation_reversal_debt_return.sql';
const PATH = join(__dirname, '../../infrastructure/database/migrations', MIGRATION);

const OPEN = 'SET LOCAL ROLE daftar_accounting_internal;';
const CLOSE = 'RESET ROLE;';
const OWNED_REPLACE = 'CREATE OR REPLACE FUNCTION accounting_ar_control_line_source_document()';
const MIGRATOR_REPLACE = 'CREATE OR REPLACE FUNCTION invoice_outstanding';

function text(): string {
  const sql = readFileSync(PATH, 'utf8');
  // The subject is not empty, asserted before anything is concluded from it.
  expect(sql.length, `${MIGRATION} must be readable and non-empty, or every claim below is vacuous`).toBeGreaterThan(1000);
  return sql;
}

/** The findings of the law, so a mutation can be shown to produce some. */
function bracketProblems(sql: string): string[] {
  const problems: string[] = [];
  const opens = sql.split(OPEN).length - 1;
  const closes = sql.split(CLOSE).length - 1;
  if (opens !== 1) problems.push(`the owner bracket must open exactly once; it opens ${String(opens)} times`);
  if (closes !== 1) problems.push(`the owner bracket must close exactly once; it closes ${String(closes)} times`);
  if (opens !== 1 || closes !== 1) return problems;

  const iOpen = sql.indexOf(OPEN);
  const iClose = sql.indexOf(CLOSE);
  const iOwned = sql.indexOf(OWNED_REPLACE);
  const iMigrator = sql.indexOf(MIGRATOR_REPLACE);
  if (iOwned < 0) problems.push(`${MIGRATION} no longer replaces the function the bracket exists for`);
  if (iMigrator < 0) problems.push(`${MIGRATION} no longer replaces invoice_outstanding, so this law has lost half its subject`);
  if (iOwned >= 0 && !(iOpen < iOwned && iOwned < iClose))
    problems.push('the replacement of the role-owned function is not inside the bracket, so it runs as the migrator and is refused');
  if (iMigrator >= 0 && iOpen < iMigrator && iMigrator < iClose)
    problems.push('invoice_outstanding is inside the bracket, which holds the accounting role for a statement that does not need it');
  return problems;
}

describe('0094 §G — the owner bracket encloses exactly the replacement that needs it', () => {
  it('holds on the real migration', () => {
    const problems = bracketProblems(text());
    expect(problems, `the owner bracket is wrong: ${problems.join(' | ')}`).toStrictEqual([]);
  });

  it('RED: with the bracket removed, the law names the refusal that follows', () => {
    const mutated = text().replace(`${OPEN}\n\n`, '');
    expect(mutated, 'the mutation must really have removed the opener, or this control proves nothing').not.toContain(OPEN);
    const problems = bracketProblems(mutated);
    expect(problems.join(' | '), `a file with no bracket must be refused: ${problems.join(' | ')}`).toContain('must open exactly once');
  });

  it('RED: with the bracket closed BEFORE the replacement, the law says the statement runs as the migrator', () => {
    // The subtlest way to get this wrong: keep both halves, in the wrong
    // order. Presence is not shape.
    const sql = text();
    const iClose = sql.indexOf(CLOSE);
    const iOwned = sql.indexOf(OWNED_REPLACE);
    const mutated = `${sql.slice(0, iOwned)}${CLOSE}\n\n${sql.slice(iOwned, iClose)}${sql.slice(iClose + CLOSE.length)}`;
    expect(mutated.split(CLOSE).length - 1, 'the mutation must leave exactly one closer, or it fails for the wrong reason').toBe(1);
    const problems = bracketProblems(mutated);
    expect(problems.join(' | '), `a bracket closed too early must be refused: ${problems.join(' | ')}`).toContain('runs as the migrator');
  });

  it('RED: with invoice_outstanding pulled inside the bracket, the law refuses the wider hold', () => {
    const sql = text();
    const iClose = sql.indexOf(CLOSE);
    // Move the closer to the very end, so the bracket swallows the rest of the
    // file including the migrator-owned replacement.
    const mutated = `${sql.slice(0, iClose)}${sql.slice(iClose + CLOSE.length)}\n${CLOSE}\n`;
    const problems = bracketProblems(mutated);
    expect(problems.join(' | '), `a bracket held past the statement that needs it must be refused: ${problems.join(' | ')}`).toContain('does not need it');
  });
});
