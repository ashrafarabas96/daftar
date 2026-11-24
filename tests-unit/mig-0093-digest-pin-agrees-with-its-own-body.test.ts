/**
 * `0093` PINS A DIGEST OF ITS OWN FUNCTION BODY, AND NOTHING CHECKED THAT THE
 * TWO AGREED WITHOUT A DATABASE.
 *
 * The cluster suite already asserts the digest the DATABASE recorded
 * (`tests/integration/l3-c6-transfer-value-arm-cluster.test.ts`), which is the
 * right subject for "what did Postgres store" — but it needs a live cluster,
 * so it says nothing on a machine or a job that has none. The gap that leaves
 * is narrow and it bit me three times on this branch alone: the body's PROSE
 * changed (a stale sentence stating the rejected design), the digest therefore
 * moved, and the only thing standing between a stale pin and a push was ME
 * running a throwaway script by hand. A check that lives in a scratchpad file
 * is not a check; it is a habit, and a habit is what fails on the day the work
 * is hurried.
 *
 * So this is the text-level half: the file's own body must hash to the digest
 * the SAME file pins for it.
 *
 * WHY IT LIVES UNDER `tests-unit/` AND NOT `tests/guards/`, measured and not
 * assumed: `vitest.config.ts`'s `globalSetup` (`tests/helpers/global-setup.ts`)
 * calls `ensurePostgres()` UNCONDITIONALLY, so a file placed under `tests/**`
 * needs a live PostgreSQL before its first assertion — a cost this check has
 * no use for. `vitest.unit.config.ts` hosts the no-database suites. I learned
 * this the expensive way: I first put this file under `tests/guards/`, and
 * running it there booted a local cluster while three CI runs were in flight,
 * which RULE-10 forbids. The placement is the remedy, not a preference.
 *
 * WHAT THIS DOES NOT CLAIM, said rather than left to be assumed:
 *   - It does NOT prove Postgres stored that digest. That is the cluster
 *     suite's claim and it stays there.
 *   - It does NOT prove the body is CORRECT. A wrong body pinned honestly
 *     passes here. The money reviews judge the body.
 * It proves one thing only: the pin is not stale.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');
const MIGRATION = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', '0093_c6_transfer_value_conservation.sql');

const FUNCTION_NAME = 'inventory_transfer_value_conserved()';
const CREATE = `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}`;

/**
 * The body between `AS $$` and the closing `$$;`, INCLUSIVE of the newline
 * before the terminator — which is what `prosrc` holds and therefore what the
 * recorded digest is taken over. The boundary is not a detail: move it by one
 * character and every digest in the chain becomes unreproducible.
 */
const bodyOf = (sql: string): string => {
  const start = sql.indexOf(CREATE);
  if (start < 0) throw new Error(`the migration does not define ${FUNCTION_NAME}`);
  const open = sql.indexOf('AS $$', start);
  if (open < 0) throw new Error('the function has no `AS $$` opener');
  const close = sql.indexOf('\n$$;', open);
  if (close < 0) throw new Error('the function body is not terminated by `$$;`');
  return sql.slice(open + 'AS $$'.length, close + 1);
};

const digestOf = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * The pin is a JSON map entry keyed by the function's name, NOT a `c_digest`
 * line. I wrote an anchor for `c_digest` first, it matched nothing, and the
 * probe reported "the migration pins no digest" — a blind probe reading as a
 * finding about the file (RULE-11). Hence the emptiness check below is an
 * assertion in its own right and not defensive noise.
 */
const PIN = new RegExp(`"${FUNCTION_NAME.replace('()', '\\(\\)')}": "([0-9a-f]{64})"`, 'g');

// `matchAll` types every capture group as optional, so mapping `m[1]` yields
// `(string | undefined)[]`. The lane preflight caught that as TS2322 before it
// reached CI a second time. Dropping the undefined cases is not a cast: a match
// without group 1 is not a pin, and the arm above already asserts the count, so
// a silently dropped match would fail there rather than pass as a string.
const pinsIn = (sql: string): string[] => [...sql.matchAll(PIN)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

describe('0093 — the pinned digest and the body it pins', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('the anchor and the body extractor both MATCH SOMETHING, so a later zero is a fact and not blindness', () => {
    // The positive control for every claim below. Without it, a renamed
    // function or a reformatted pin would turn this whole suite green by
    // matching nothing at all -- which is how a guard dies silently.
    const pins = pinsIn(sql);
    expect(pins.length, `no pin for ${FUNCTION_NAME} was found -- the anchor is blind, the file is not necessarily wrong`).toBe(1);
    expect(pins[0]).toMatch(/^[0-9a-f]{64}$/);

    const body = bodyOf(sql);
    expect(body.length, 'the extracted body is empty, so any digest over it is meaningless').toBeGreaterThan(200);
    expect(body, 'the extracted region is not this function body').toContain('inventory.transfer_value_not_conserved');
  });

  it('the body hashes to EXACTLY the digest the same file pins for it', () => {
    expect(digestOf(bodyOf(sql))).toBe(pinsIn(sql)[0]);
  });

  it('and it DISCRIMINATES: a body changed by one comment stops matching the pin', () => {
    // The negative control, and the reason this file exists. All three times
    // the digest moved on this branch it moved because PROSE inside the body
    // changed -- not code -- so the planted change here is a comment, the
    // cheapest edit anyone would believe is harmless. Nothing is written to
    // disk: the plant lives in this variable only.
    const body = bodyOf(sql);
    const planted = `${body}\n  -- a planted comment, never written to disk\n`;
    expect(planted, 'the plant did not change the body, so this arm proves nothing (DR-55)').not.toBe(body);
    expect(digestOf(planted), 'a changed body still matched the pin, so this guard cannot catch a stale pin and is vacuous').not.toBe(pinsIn(sql)[0]);
  });
});
