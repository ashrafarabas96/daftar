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
 *   3. The DDL declares no ANONYMOUS table CHECK. ROUND 12, the challenger's
 *      F-12 (P3): a text scan for `CONSTRAINT <name> CHECK` cannot see an
 *      inline `CHECK (...)`, which PostgreSQL names itself and which
 *      enforces just as hard — it planted one and this gate stayed green.
 *      Two things changed. This file now REFUSES the anonymous form
 *      outright, so law 2's extractor cannot miss a constraint that exists;
 *      and the authoritative enumeration moved to where a catalogue can be
 *      asked, `test/db/credit-ledger-checks.test.ts`, which reads
 *      `pg_constraint` for the requested relations and requires every CHECK
 *      on them — anonymous ones included — to be named by a case. This
 *      gate is the cheap mirror that runs without a cluster; that one is the
 *      measurement.
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

/** Every `.test.ts` under `test/db/`, by absolute path. */
const dbTestPaths = (): string[] =>
  readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(DB_DIR, f));

/** Every `.test.ts` under `test/db/`, read once. */
const dbTests = readdirSync(DB_DIR)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => ({ file: f, literals: stringLiteralsOf(readFileSync(join(DB_DIR, f), 'utf8')) }));

describe('the requested DDL declares no anonymous CHECK', () => {
  it('names every table CHECK it declares', () => {
    const ddl = readFileSync(DDL, 'utf8');
    const offences: string[] = [];
    ddl.split('\n').forEach((line, i) => {
      // `WITH CHECK (...)` is a POLICY clause, not a table constraint, and
      // the house RLS pattern uses it on every policy.
      const stripped = line.replace(/--.*$/, '');
      if (!/\bCHECK\s*\(/i.test(stripped)) return;
      if (/\bWITH\s+CHECK\s*\(/i.test(stripped)) return;
      if (/\bCONSTRAINT\s+\w+\s+CHECK\s*\(/i.test(stripped)) return;
      offences.push(`line ${i + 1}: ${stripped.trim()}`);
    });
    expect(offences, 'an anonymous CHECK in the requested DDL — PostgreSQL would name it, and no case could assert that name').toStrictEqual([]);
  });

  it('proves that scan can see an anonymous CHECK at all', () => {
    // The law above is a prohibition; this is its non-vacuity witness.
    const planted = '  amount_minor bigint NOT NULL CHECK (amount_minor > 0),';
    expect(/\bCHECK\s*\(/i.test(planted)).toBe(true);
    expect(/\bCONSTRAINT\s+\w+\s+CHECK\s*\(/i.test(planted)).toBe(false);
    // And a policy clause is not mistaken for one.
    const policy = '  WITH CHECK (app_bypass() OR business_id::text = app_business());';
    expect(/\bWITH\s+CHECK\s*\(/i.test(policy)).toBe(true);
  });
});

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
  // ── ROUND 14, the coordinator's diff-review R-4 and R-2 ─────────────
  //
  // Two laws about shapes this gate could NOT see when it was written, both
  // found by a reviewer reading the lane rather than by the gate reading
  // itself. A gate that only bans the forms somebody already thought of is
  // a gate over a list, so each of these also carries its own witness.

  it('bans an ANY-ERROR assertion on a refusal, which a bare SQLSTATE ban cannot see', () => {
    // `.not.toBe('')` accepts every failure there is, a lost connection and
    // a typo in the SQL included, so it is weaker than the bare-class
    // assertion this gate was built to ban — and it names no class, so the
    // bare-class law never looked at it. One such assertion stood in
    // `credit-ledger-attempts.test.ts` for four rounds.
    const offences: string[] = [];
    for (const file of dbTestPaths()) {
      // Comments are stripped first. The comment explaining this law quotes
      // the very form it bans, and a law that cannot tell code from the
      // sentence describing it reports its own documentation as a defect —
      // which is what happened on the first run of this law.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      for (const m of code.matchAll(/\.not\.toBe\(\s*''\s*\)/g)) {
        offences.push(`${file.split('/').pop()}: ${m[0]} — assert the defence, not the existence of an error`);
      }
      for (const m of code.matchAll(/expect\(\s*(?:code|refusal|refusedBy[^)]*)\s*[,)][^;]*?\.toBeTruthy\(\)/g)) {
        offences.push(`${file.split('/').pop()}: ${m[0].slice(0, 60)} — toBeTruthy() on a refusal is an any-error assertion`);
      }
    }
    expect(offences, 'a refusal is asserted as "some error happened"').toStrictEqual([]);

    // The witness: the law is over a shape that EXISTS in the corpus, so a
    // typo in the pattern would show up here rather than passing silently.
    const planted = `const code = ''; expect(code).not.toBe('');`;
    expect(/\.not\.toBe\(\s*''\s*\)/.test(planted), 'the pattern no longer matches the form it bans').toBe(true);
  });

  it('pins EVERY figure of the context-setting census, not only the session count', () => {
    // R-2: the helper's scope argument used to DEFAULT to session-level and
    // 12 of 13 sites took the default, while the pack claimed the lane set
    // the context per transaction. The default is gone — every site names
    // its scope — and this law pins the count so the divergence cannot grow
    // back silently. Raising it is allowed; raising it without changing
    // this number and `P5-CHECKPOINT.md` §9.3 is not.
    //
    // ROUND 22, THE CHALLENGER'S B-3, AND THE ADVERTISEMENT WAS MINE. The
    // generated census renders five numbers and this law pinned ONE of them
    // (the 23) while the footnote under the table said "a new case reds the
    // suite and this table at once". Round 21 added two 'transaction' sites:
    // the pure lane stayed 277/277 rc 0, the published total and transaction
    // row went stale, and the Migration Owner read both. A check advertised
    // over a class it covers part of is this phase's own recurring finding,
    // wearing my name this time.
    //
    // So all four figures are now exact equalities against literals. A
    // 'transaction' site added anywhere in the corpus reds this case, which
    // is what the footnote may now claim.
    const sites: string[] = [];
    for (const file of dbTestPaths()) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      for (const m of code.matchAll(/setRequestContext\([^;]*?'(session|transaction)'\s*\)/g)) {
        sites.push(`${file.split('/').pop()}:${m[1]}`);
      }
      // A site that names no scope cannot compile any more, but a literal
      // `set_config('app.…', …, false)` can still be written by hand.
      for (const _ of code.matchAll(/set_config\('app\.[a-z_]+'[^)]*,\s*false\s*\)/g)) {
        sites.push(`${file.split('/').pop()}:literal-session`);
      }
    }
    const helperSession = sites.filter((s) => s.endsWith(':session'));
    const literalSession = sites.filter((s) => s.endsWith(':literal-session'));
    const session = [...helperSession, ...literalSession];
    const transaction = sites.filter((s) => s.endsWith(':transaction'));
    // Measured, never predicted — these numbers have been wrong four times in
    // this phase by being reasoned about instead of read off a run.
    // ROUND 16: 23 = 19 helper sites plus 4 literal `set_config(…, false)`
    // calls, all four of them in the RLS suite. The one site that round added
    // is F-17's case; F-16's case is 'transaction'-scoped, which is why the
    // count moved by one and not by two.
    // ROUND 15 measured 22 (18 + 4), round 14 measured 17 (15 + 2), and the
    // coordinator counted the same population before round 14 as "12 of 13"
    // plus two literals.
    // ROUND 21 added two 'transaction' sites: 9 → 11, total 32 → 34.
    expect(
      {
        helperSession: helperSession.length,
        literalSession: literalSession.length,
        sessionTogether: session.length,
        transaction: transaction.length,
        total: sites.length,
      },
      'a context-setting census figure moved; update this law, the generated block (tools/context-sites.py) and CHECKPOINT §9.3 together',
    ).toStrictEqual({
      helperSession: 19,
      literalSession: 4,
      sessionTogether: 23,
      transaction: 11,
      total: 34,
    });
    // The arithmetic is asserted too, so a future edit cannot satisfy the
    // five literals above with parts that do not add up.
    expect(helperSession.length + literalSession.length).toBe(session.length);
    expect(session.length + transaction.length).toBe(sites.length);
  });
});
