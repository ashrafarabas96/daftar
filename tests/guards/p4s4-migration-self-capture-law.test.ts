import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly, findSelfCaptureViolations, masks, selfCaptureSurface } from '../../scripts/guards/migration-self-capture';

/**
 * GUARD G-8's own proof. The rule says a migration that verifies itself across
 * its own DDL must take its capture ONCE, before the first statement it is a
 * capture of, and read it only after the last.
 *
 * The rule exists because the runtime half cannot protect itself. On a scratch
 * database built to the predecessor, a planted widening
 * `ALTER POLICY business_isolation_delete ON invoices USING (true)` made the
 * whole of `0086` apply GREEN as soon as ONE extra `set_config` of the capture
 * GUC was placed beside it — 6 runs of 6, deterministic — while the same
 * widening without that one statement was refused with
 * `0086-F: this file altered a clause it never named`. A GUC the file can
 * write is a comparison the file can forge, so the protection has to be a
 * property of the TEXT.
 *
 * Every case below plants into a COPY of the real file's text. Nothing on disk
 * is touched.
 */
const ROOT = join(__dirname, '../..');
const SUBJECT = 'infrastructure/database/migrations/0086_phase4_rls_quals_once_per_query.sql';
const text = (): string => readFileSync(join(ROOT, SUBJECT), 'utf8');

/** Every migration on disk, so the whole-tree arm is about the tree and not one file. */
const tree = (): Record<string, string> => {
  const dir = join(ROOT, 'infrastructure/database/migrations');
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    out[`infrastructure/database/migrations/${f}`] = readFileSync(join(dir, f), 'utf8');
  return out;
};

/** The capture statement, as the file writes it. */
const CAPTURE = `PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', v_snap, true);`;

describe('P4-S4 — G-8: a migration cannot forge its own self-capture', () => {
  it('the tree PASSES the rule, and the rule is watching something', () => {
    const migrations = { [SUBJECT]: text() };
    expect(findSelfCaptureViolations({ migrations })).toEqual([]);
    expect(selfCaptureSurface({ migrations }), 'the rule found no file carrying the shape, so its silence would be absence').toContain(SUBJECT);
  });

  it('RED PROOF: the forging re-capture — one extra set_config beside a planted widening — is REFUSED', () => {
    // This is the attack verbatim: the widening, then a re-capture, inserted
    // immediately before the final block so everything the file really does
    // has already happened.
    const at = text().indexOf('DO $fin$');
    expect(at, 'the final block is not where this plant expects it').toBeGreaterThan(0);
    const forged = `${text().slice(0, at)}ALTER POLICY business_isolation_delete ON invoices USING (true);\n${CAPTURE}\n${text().slice(at)}`;
    expect(forged, 'the plant did not change the file').not.toBe(text());
    const problems = findSelfCaptureViolations({ migrations: { [SUBJECT]: forged } });
    expect(problems.join(' | ')).toMatch(/sets the capture app\.p4s4_0086_policy_snapshot 2 times/);
    expect(problems.join(' | ')).toMatch(/AFTER a policy statement/);
  });

  it('RED PROOF: a capture taken after the first policy statement is REFUSED even when it is the only one', () => {
    const one = text().replace(CAPTURE, '-- moved');
    expect(one, 'the capture is not where this plant expects it').not.toBe(text());
    const at = one.indexOf('DO $fin$');
    const moved = `${one.slice(0, at)}DO $x$ BEGIN ${CAPTURE} END $x$;\n${one.slice(at)}`;
    const problems = findSelfCaptureViolations({ migrations: { [SUBJECT]: moved } });
    expect(problems.join(' | ')).toMatch(/AFTER a policy statement/);
    expect(problems.join(' | '), 'this plant leaves exactly one capture, so the count arm must stay silent').not.toMatch(/2 times/);
  });

  it('RED PROOF: a comparison read BEFORE the last policy statement is REFUSED', () => {
    const t = text();
    const firstAlter = codeOnly(t).indexOf('ALTER POLICY');
    expect(firstAlter).toBeGreaterThan(0);
    const early = `${t.slice(0, firstAlter)}DO $y$ BEGIN PERFORM pg_catalog.current_setting('app.p4s4_0086_policy_snapshot', true); END $y$;\n${t.slice(firstAlter)}`;
    expect(findSelfCaptureViolations({ migrations: { [SUBJECT]: early } }).join(' | ')).toMatch(/reads the capture .* BEFORE the last policy statement/);
  });

  it('RED PROOF: a capture that is never read, and a read with no capture, are both REFUSED', () => {
    const unread = text().replace(/pg_catalog\.current_setting\('app\.p4s4_0086_policy_snapshot'[^;]*;/g, "'';");
    expect(unread).not.toBe(text());
    expect(findSelfCaptureViolations({ migrations: { [SUBJECT]: unread } }).join(' | ')).toMatch(/never reads it, so nothing is compared/);

    const unset = text().replace(CAPTURE, '-- removed');
    expect(unset).not.toBe(text());
    expect(findSelfCaptureViolations({ migrations: { [SUBJECT]: unset } }).join(' | ')).toMatch(/never sets it/);
  });

  it('the rule reads CODE, not prose: a comment naming ALTER POLICY moves no offset', () => {
    // The real file's own comments say `ALTER POLICY` while explaining what
    // this rule is for. Read as statements they put the first `ALTER`
    // hundreds of bytes before the capture, which is a false red — and it was
    // the rule's first measured verdict before `codeOnly` existed.
    const commented = `-- ALTER POLICY tenant_membership ON invoices USING (true);\n/* ALTER POLICY x ON y USING (true); */\n${text()}`;
    expect(findSelfCaptureViolations({ migrations: { [SUBJECT]: commented } })).toEqual([]);
    // And the blanking keeps every offset: same length, same newlines.
    const t = text();
    expect(codeOnly(t)).toHaveLength(t.length);
    expect(codeOnly(t).split('\n')).toHaveLength(t.split('\n').length);
    // A canary: the plant above really is a comment the rule had to strip.
    expect(codeOnly(commented).indexOf('ALTER POLICY'), 'the stripped text still carries the commented ALTER, so this case proves nothing').toBe(
      codeOnly(t).indexOf('ALTER POLICY') + commented.length - t.length,
    );
  });
});

/**
 * THE NINE SPELLINGS AN INDEPENDENT CHALLENGE ROUND DROVE END TO END.
 *
 * The first version of this rule counted occurrences of the literal text
 * `set_config('<the capture>'`. A challenge round built a database from zero
 * to the predecessor and applied a widening `ALTER POLICY … USING (true)`
 * GREEN three different ways with the rule silent, and took the file off the
 * rule's surface entirely by renaming the capture. Each of those spellings is
 * planted here. Every one is required to be named — and the whole tree is
 * required to stay silent, because a rule that reds the file it protects is
 * not a protection either.
 */
describe("P4-S4 — G-8 cannot be evaded by spelling (the challenge round's own forgeries)", () => {
  const beside = (extra: string): string => {
    const t = text();
    const fin = t.indexOf('DO $fin$');
    expect(fin).toBeGreaterThan(0);
    return t.slice(0, fin) + extra + t.slice(fin);
  };
  const named = (planted: string): string => {
    expect(planted).not.toBe(text());
    const problems = findSelfCaptureViolations({ migrations: { [SUBJECT]: planted } });
    expect(problems.length, 'the forgery must be named').toBeGreaterThan(0);
    return problems.join(' | ');
  };

  it.each([
    [
      'a second plain write',
      `DO $x$ BEGIN PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', 'f', true); END $x$;\n`,
      /sets the capture .* 2 times/,
    ],
    [
      'the name handed to format and executed',
      `DO $x$ BEGIN EXECUTE pg_catalog.format('SELECT pg_catalog.set_cfg(%L, %L, true)', 'app.p4s4_0086_policy_snapshot', 'f'); END $x$;\n`,
      /appears at offset \d+ somewhere other than as the first argument/,
    ],
    [
      'the name assembled by concatenation',
      `DO $x$ BEGIN PERFORM pg_catalog.set_config('app.p4s4_0086' || '_policy_snapshot', 'f', true); END $x$;\n`,
      /ASSEMBLES its GUC name/,
    ],
    [
      'a write after a literal containing --, which the first lexer let blank the line',
      `DO $x$ BEGIN PERFORM 'sep--x'; PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', 'f', true); END $x$;\n`,
      /sets the capture .* 2 times/,
    ],
    [
      'a write after a literal containing /*, which the first lexer let start a block comment',
      `DO $x$ BEGIN PERFORM '/*'; PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', 'f', true); END $x$;\n`,
      /sets the capture .* 2 times/,
    ],
    [
      'a write inside an executed string',
      `DO $x$ BEGIN EXECUTE 'SELECT pg_catalog.set_config(''app.p4s4_0086_policy_snapshot'', ''f'', true)'; END $x$;\n`,
      /appears at offset \d+ somewhere other than as the first argument/,
    ],
    [
      'a write inside an E-string',
      `DO $x$ BEGIN EXECUTE E'SELECT pg_catalog.set_config(\\'app.p4s4_0086_policy_snapshot\\', \\'f\\', true)'; END $x$;\n`,
      /string literal at offset \d+ contains set_config/,
    ],
    [
      'a write inside a routine the file creates and calls',
      `CREATE FUNCTION pg_temp.forge() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', 'f', true); END $f$;\nDO $y$ BEGIN PERFORM pg_temp.forge(); END $y$;\n`,
      /sets the capture .* 2 times/,
    ],
  ])('RED PROOF: %s is REFUSED', (_what, extra, expected) => {
    expect(named(beside(extra))).toMatch(expected);
  });

  it('RED PROOF: renaming the capture is a VIOLATION, not an escape from the surface', () => {
    const renamed = text().replace(/app\.p4s4_0086_policy_snapshot/g, 'app.p4s4_0086_policy_before');
    expect(renamed).not.toBe(text());
    // It stays on the surface, because the surface is derived from the file's
    // OWN NUMBER and not from the capture's spelling.
    expect(selfCaptureSurface({ migrations: { [SUBJECT]: renamed } })).toEqual([SUBJECT]);
    expect(named(renamed)).toMatch(/carries this migration's own number and is both written and read by it, so it IS a capture of its own state/);
  });

  it('the lexer nests block comments and keeps a comment marker inside a literal out of it', () => {
    // PostgreSQL nests /* */. A non-nesting reader ends the comment at the
    // first */ and reads the rest of a comment as code.
    const nested = masks('a /* x /* y */ z */ b').code;
    expect(nested).toHaveLength('a /* x /* y */ z */ b'.length);
    const src = 'a /* x /* y */ z */ b';
    expect(nested).toBe(src.replace('/* x /* y */ z */', ' '.repeat('/* x /* y */ z */'.length)));
    // A non-nesting reader would end the comment at the first */ and leave
    // `z */` as code, so the canary is that nothing of the comment survives.
    expect(nested).not.toContain('z');
    expect(masks("SELECT 'sep--x'; SELECT 1;").code).toContain('SELECT 1;');
    // And a question about STATEMENTS reads the mask with literals blanked,
    // so policy DDL inside a string is not a statement.
    expect(/ALTER\s+POLICY/i.test(masks("SELECT 'ALTER POLICY p ON t';").statements)).toBe(false);
    // Both masks keep every offset.
    const t = text();
    const m = masks(t);
    expect(m.code).toHaveLength(t.length);
    expect(m.statements).toHaveLength(t.length);
    expect(m.statements.split('\n')).toHaveLength(t.split('\n').length);
  });

  it('the whole migration tree is silent, and the rule is watching this file', () => {
    expect(findSelfCaptureViolations({ migrations: tree() })).toEqual([]);
    expect(selfCaptureSurface({ migrations: tree() })).toContain(SUBJECT);
  });
});
