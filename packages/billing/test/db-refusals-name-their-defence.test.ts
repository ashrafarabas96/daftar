/**
 * ROUND 10 — the gate that stops F-11 recurring.
 *
 * The challenger's F-11 (P2) had two halves. One was a coverage hole: 19 of
 * the 25 CHECK constraints in the requested DDL were provoked by no case, so
 * dropping any one of them left the DB lane green. The other was a
 * RESOLUTION hole: the cases that did refuse asserted the bare SQLSTATE, and
 * a class is shared — 23514 is raised by six constraints in this schema,
 * 23503 by six keys, 23505 by four, and 23000 by every one of the fifteen
 * RAISE sites in the invariant functions. An assertion that names only the
 * class is satisfied by the wrong defence, which is how a masking pair
 * (`si_credit_within_charge` and `si_total_non_negative`) stayed invisible.
 *
 * Both halves are closed in `test/db/**`. This file is why they stay closed,
 * and it lives in the PURE lane on purpose: it reads source text and needs
 * no cluster, so it runs on every `npm test` rather than only when someone
 * pays for the DB lane.
 *
 * It asserts two laws:
 *
 *   1. No case in `test/db/**` asserts a SHARED SQLSTATE on its own. The
 *      shared classes are listed below with the count that makes them
 *      shared; a class raised by exactly one defence is not listed and may
 *      be asserted bare (`42501` for a permission refusal, `40P01` for a
 *      deadlock), because there nothing else can have answered.
 *   2. Every CHECK constraint in the requested DDL is named by at least one
 *      assertion, or appears in `MASKED` below WITH its reason and the
 *      constraint that answers first. An exemption is a sentence someone has
 *      to write, not a silence.
 *
 * Both laws read STRING LITERALS, not raw source, through the shared lexer:
 * a text law over unstripped source is satisfied by a comment, which is the
 * defect P4-S7's H6 order law had. The comments in this very file name every
 * shared class, and would satisfy a raw scan.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stringLiteralsOf } from './helpers/lexer';

const DB_DIR = join(__dirname, 'db');
const DDL = join(DB_DIR, 'sql', 'credit-ledger-scratch.sql');

/**
 * The SQLSTATE classes more than one defence in this schema raises, with the
 * number of defences, so the reason for the prohibition is in the data and
 * not only in the prose above.
 */
const SHARED: ReadonlyMap<string, string> = new Map([
  ['23514', 'six CHECK constraints'],
  ['23503', 'six foreign keys from round 11, four before it'],
  ['23505', 'four unique keys'],
  ['23000', 'fifteen RAISE sites in the invariant functions'],
]);

/**
 * CHECK constraints that no case can provoke ALONE, each with the defence
 * that answers first and the measurement that shows the masked constraint
 * is not dead. A name may sit here only while that sentence is true.
 */
const MASKED: ReadonlyMap<string, string> = new Map([
  [
    'si_total_non_negative',
    'masked by si_credit_within_charge: tax_minor is a structural zero and si_total_is_charge_minus_credit makes the total a function of charge and credit, so a negative total requires credit > charge, which the credit bound refuses first. Red proof M39 drops the credit bound on a scratch copy and the same row is then refused by si_total_non_negative.',
  ],
]);

/** Every `.test.ts` under `test/db/`, read once. */
const dbTests = readdirSync(DB_DIR)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => ({ file: f, literals: stringLiteralsOf(readFileSync(join(DB_DIR, f), 'utf8')) }));

describe('a refusal in the DB lane names the defence that refused, not its class', () => {
  it('finds the DB cases at all', () => {
    // A law over a directory that came back empty proves nothing, and would
    // pass loudest exactly when the files were moved.
    expect(dbTests.length, 'no DB cases were found — this gate would be vacuous').toBeGreaterThanOrEqual(5);
    const total = dbTests.reduce((n, t) => n + t.literals.length, 0);
    expect(total, 'the lexer returned no string literals — the scan is not reading the cases').toBeGreaterThan(200);
  });

  it('asserts no shared SQLSTATE on its own', () => {
    const bare: string[] = [];
    for (const { file, literals } of dbTests) {
      for (const literal of literals) {
        const shared = SHARED.get(literal);
        if (shared !== undefined) bare.push(`${file}: '${literal}' is raised by ${shared}`);
      }
    }
    expect(bare, 'a DB case asserts a SQLSTATE that more than one defence raises').toStrictEqual([]);
  });

  it('names a defence for every CHECK constraint in the requested DDL', () => {
    const ddl = readFileSync(DDL, 'utf8');
    const constraints = [...ddl.matchAll(/CONSTRAINT\s+(\w+)\s+CHECK/gi)].map((m) => m[1] ?? '');
    expect(constraints.length, 'no CHECK constraints were extracted from the DDL — the extractor is broken').toBeGreaterThanOrEqual(25);

    const named = new Set<string>();
    for (const { literals } of dbTests) {
      for (const literal of literals) {
        const m = /^(\d{5})\/(\w+)$/.exec(literal);
        if (m) named.add(m[2] ?? '');
      }
    }

    const unobserved = constraints.filter((c) => !named.has(c) && !MASKED.has(c)).sort();
    expect(unobserved, 'a CHECK constraint is provoked by no case and carries no recorded masking').toStrictEqual([]);

    // And an exemption that has become reachable must be spent: a name in
    // MASKED that some case now names by itself is a stale excuse.
    const staleExemptions = [...MASKED.keys()].filter((c) => named.has(c)).sort();
    expect(staleExemptions, 'a masked constraint is now asserted by name — remove its exemption').toStrictEqual([]);

    // An exemption for a constraint the DDL no longer has is also stale.
    const orphanExemptions = [...MASKED.keys()].filter((c) => !constraints.includes(c)).sort();
    expect(orphanExemptions, 'an exemption names a constraint that is not in the DDL').toStrictEqual([]);

    for (const [name, reason] of MASKED) {
      expect(reason.length, `the exemption for ${name} carries no reason`).toBeGreaterThan(80);
    }
  });
});
