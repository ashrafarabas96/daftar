import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly, findSelfCaptureViolations, selfCaptureSurface } from '../../scripts/guards/migration-self-capture';

/**
 * GUARD G-7's own proof. The rule says a migration that verifies itself across
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

/** The capture statement, as the file writes it. */
const CAPTURE = `PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', v_snap, true);`;

describe('P4-S4 — G-7: a migration cannot forge its own self-capture', () => {
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
