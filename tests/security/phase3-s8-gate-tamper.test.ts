/**
 * T-15c — THE GATES THAT GUARD P3-S8 CAN REFUSE (docs/PHASE_3_S8_CONTRACT.md
 * §6.1 T-15c, §7.1, §7.3 pin 2, A-19, Annex R §2.11).
 *
 * A gate proved only by passing proves nothing. Each case below breaks
 * exactly one thing and shows the gate that owns it refusing, with the
 * accepted failure label:
 *
 *   (1) `hmacKeysEquivalent(` replaced by `.equals(` in `apps/api/src/config.ts`:
 *       `gate:phase2:s3` fails `key-separation` (A-19, pin 6);
 *   (2) one column added to a reconciler grant of the S8 migration: the S8
 *       gate fails `migration`;
 *   (2b) a planted DO block that switches to an internal principal and runs
 *       a writing routine: the S8 gate fails `migration` (review L-1);
 *   (2c) the R-B1a trigger neutered with `WHEN (false)`: the S8 gate fails
 *       `migration` (review L-2);
 *   (3) one PM row removed from the premortem matrix: the S8 gate fails
 *       `premortem`;
 *   pin 2: the P2-S8 gate's model check fails `s8-model` both ways — a table
 *       the model names that no migration grants, and a table a migration
 *       after the Phase 2 prefix grants that the model omits.
 *
 * The breaking is done in a HARD-LINKED COPY of the tree, exactly as
 * `tests/security/phase2-s8-gate-tamper.test.ts` does it: the tampered file is
 * unlinked before it is written, so nothing reaches back into this checkout.
 * The S8 and P2-S8 gates are the real scripts pointed at the copy with
 * `--root` and `--structural-only`; the P2-S3 gate takes no root, so the
 * copy's own script runs, and its own `__dirname` makes the copy its root.
 * Each tampered run is paired with the same run over an untampered copy, and
 * the assertion is on the one refusal the tamper must add.
 *
 * The in-memory cases first prove the §2.11 statement reader itself, on the
 * real S8 migration and on single-edit variants of it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PREMORTEM_MATRIX, S8_MIGRATION_NAME, s8MigrationContentProblems, splitSqlStatements } from '../../scripts/phase3-s8-gate';

const REPO = join(__dirname, '../..');
const S8M = `infrastructure/database/migrations/${S8_MIGRATION_NAME}`;
const CONFIG = 'apps/api/src/config.ts';
const MODEL = 'infrastructure/database/reconciler-privilege-model.json';
/** Removed from both P2-S3 copies so its structural half always fails before its regression matrix could start. */
const P2S3_EARLY_STOP = 'packages/accounting/src/fx.ts';

const realS8 = readFileSync(join(REPO, S8M), 'utf8');

/** Replace exactly one occurrence; a fixture that no longer matches is a broken test, not a pass. */
function once(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`the fixture expects exactly one occurrence of ${JSON.stringify(from)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

describe('T-15c (in memory): the §2.11 content check of the S8 migration', () => {
  it('splits the real migration into its statements, bodies and COMMENT text never split', () => {
    const statements = splitSqlStatements(realS8);
    expect(statements.filter((s) => s.skeleton.startsWith('DO ')).length).toBe(3);
    expect(statements.filter((s) => /^GRANT SELECT/i.test(s.skeleton)).length).toBe(4);
    expect(statements.every((s) => !s.skeleton.includes(';'))).toBe(true);
  });

  it('admits the real S8 migration exactly', () => {
    expect(s8MigrationContentProblems(realS8)).toEqual([]);
  });

  it('refuses one more reconciler column', () => {
    const tampered = once(realS8, 'qty_delta, value_delta_base_minor)', 'qty_delta, value_delta_base_minor, reason)');
    expect(s8MigrationContentProblems(tampered)).toEqual([
      expect.stringMatching(/^stock_movements grants daftar_reconciler \(.*\breason\b.*\) — §2\.2 is exactly/),
    ]);
  });

  it('refuses a table-level SELECT, and a reconciler grant of a table §2.2 does not name', () => {
    const tableLevel = `${realS8}\nGRANT SELECT ON stock_movements TO daftar_reconciler;\n`;
    expect(s8MigrationContentProblems(tableLevel)).toEqual([
      expect.stringMatching(/GRANT SELECT ON stock_movements TO daftar_reconciler\) is not admitted by §2\.11$/),
    ]);
    const other = `${realS8}\nGRANT SELECT (id) ON suppliers TO daftar_reconciler;\n`;
    expect(s8MigrationContentProblems(other)).toEqual([expect.stringMatching(/^suppliers is granted to daftar_reconciler — §2\.2 names only/)]);
  });

  it('refuses a DO block that changes something, even through dynamic SQL', () => {
    const tampered = `${realS8}\nDO $$ BEGIN EXECUTE 'GRANT SELECT ON suppliers TO daftar_reconciler'; END $$;\n`;
    expect(s8MigrationContentProblems(tampered)).toEqual([expect.stringMatching(/^a DO block .* contains EXECUTE/)]);
  });

  it('refuses a planted DO block that borrows an internal role and runs a writing routine (review L-1: an allow-list, not a denylist)', () => {
    const planted = `DO $$ BEGIN SET LOCAL ROLE daftar_accounting_internal;\n  PERFORM accounting_post_entry(current_date, 'x', NULL, '[]'::jsonb); RESET ROLE; END $$;`;
    const outside = s8MigrationContentProblems(`${realS8}\n${planted}\n`);
    expect(outside).toEqual([
      expect.stringMatching(/^a DO block .* contains SET LOCAL ROLE daftar_accounting_internal — .*outside the R-B1a section/),
      expect.stringMatching(/^a DO block .* contains PERFORM accounting_post_entry\(/),
      expect.stringMatching(/^a DO block .* calls accounting_post_entry\(/),
    ]);
    // Inside the R-B1a section the role switch is admitted, the writing call never is.
    const inside = s8MigrationContentProblems(once(realS8, '-- ══ END R-B1a', `${planted}\n-- ══ END R-B1a`));
    expect(inside).toEqual([
      expect.stringMatching(/^a DO block .* contains PERFORM accounting_post_entry\(/),
      expect.stringMatching(/^a DO block .* calls accounting_post_entry\(/),
    ]);
    // A call hidden in an assignment or a SELECT … INTO is a call all the same.
    const assigned = s8MigrationContentProblems(
      `${realS8}\nDO $$ DECLARE v UUID; BEGIN v := gen_random_uuid(); SELECT pg_advisory_xact_lock(1) INTO v; END $$;\n`,
    );
    expect(assigned).toEqual([
      expect.stringMatching(/^a DO block .* calls gen_random_uuid\(/),
      expect.stringMatching(/^a DO block .* calls pg_advisory_xact_lock\(/),
    ]);
  });

  it('refuses the R-B1a trigger with any WHEN other than the two merchant-stated types, and a guard or helper body other than the pinned one (review L-2)', () => {
    const whenFalse = once(realS8, "FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment', 'opening_balance'))", 'FOR EACH ROW WHEN (false)');
    expect(s8MigrationContentProblems(whenFalse)).toEqual([
      expect.stringMatching(/^statement at offset \d+ \(CREATE CONSTRAINT TRIGGER journal_entries_inventory_account_domain .* is not admitted by §2\.11$/),
      'R-B1a needs exactly 1 × trigger:journal_entries_inventory_account_domain, found 0',
    ]);
    const oneType = once(realS8, "WHEN (NEW.source_type IN ('manual_adjustment', 'opening_balance'))", "WHEN (NEW.source_type IN ('manual_adjustment'))");
    expect(s8MigrationContentProblems(oneType)).toContain('R-B1a needs exactly 1 × trigger:journal_entries_inventory_account_domain, found 0');
    const guard = once(realS8, "a.system_key = 'inventory')", "a.system_key = 'inventory' AND false)");
    expect(s8MigrationContentProblems(guard)).toEqual([
      expect.stringMatching(/^statement at offset \d+ \(CREATE FUNCTION accounting_inventory_account_domain_guard\(\) .* is not admitted by §2\.11$/),
      'R-B1a needs exactly 1 × create-function:accounting_inventory_account_domain_guard, found 0',
    ]);
    const helper = once(realS8, 'WHERE m.business_id = p_business_id)', 'WHERE m.business_id = p_business_id AND false)');
    expect(s8MigrationContentProblems(helper)).toContain('R-B1a needs exactly 1 × create-function:inventory_business_has_stock_movements, found 0');
  });

  it('refuses an R-B1a statement moved outside its delimited section', () => {
    const grant = 'GRANT EXECUTE ON FUNCTION inventory_business_has_stock_movements(UUID) TO daftar_accounting_internal;';
    const tampered = `${once(realS8, grant, '')}\n${grant}\n`;
    expect(s8MigrationContentProblems(tampered)).toEqual([
      expect.stringMatching(/^grant-execute:inventory_business_has_stock_movements .* is outside the delimited R-B1a section$/),
    ]);
  });

  it('refuses a second EXECUTE grantee, and a missing REVOKE … FROM PUBLIC', () => {
    const extra = once(
      realS8,
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
      'GRANT EXECUTE ON FUNCTION inventory_business_has_stock_movements(UUID) TO daftar_app;\nREVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    );
    expect(s8MigrationContentProblems(extra)).toEqual([expect.stringMatching(/TO daftar_app\) is not admitted by §2\.11$/)]);
    const missing = once(realS8, 'REVOKE ALL ON FUNCTION accounting_inventory_account_domain_guard() FROM PUBLIC;', '');
    expect(s8MigrationContentProblems(missing)).toEqual(['R-B1a needs exactly 1 × revoke-public:accounting_inventory_account_domain_guard, found 0']);
  });

  it('under an R-B1b/c ruling the section must be gone — and deleting it is the whole change', () => {
    expect(s8MigrationContentProblems(realS8, 'R-B1c')).toContain('B1_RULING is R-B1c but the R-B1a section is still in the file');
    const begin = realS8.indexOf('-- ══ BEGIN R-B1a');
    const endMarker = realS8.indexOf('-- ══ END R-B1a');
    const end = realS8.indexOf('\n', endMarker);
    expect(begin).toBeGreaterThan(0);
    expect(endMarker).toBeGreaterThan(begin);
    const deleted = realS8.slice(0, begin) + realS8.slice(end);
    expect(s8MigrationContentProblems(deleted, 'R-B1c')).toEqual([]);
    expect(s8MigrationContentProblems(deleted, 'R-B1a')[0]).toMatch(/^the R-B1a section must be delimited/);
  });
});

// ── The tree copies ─────────────────────────────────────────────────────────

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** What a checkout of this branch contains: tracked, or untracked and not ignored. */
function deliveredFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((rel) => rel !== '');
}

/** A hard-linked copy of every delivered file. */
function cleanCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'p3s8-tamper-'));
  temporaries.push(root);
  for (const rel of deliveredFiles()) {
    const source = join(REPO, rel);
    if (!existsSync(source)) continue; // tracked, deleted in the worktree
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    linkSync(source, target);
  }
  return root;
}

/** Replace a file in the copy; the unlink is what protects the original. */
function rewrite(root: string, rel: string, contents: string): void {
  const target = join(root, rel);
  rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

interface Run {
  readonly status: number | null;
  readonly output: string;
}

/** Ten minutes, then SIGKILL: a structural half that failed to stop would otherwise start a regression matrix inside this suite. */
const SPAWN = { cwd: REPO, encoding: 'utf8' as const, timeout: 600_000, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 * 1024 };

function run(args: readonly string[]): Run {
  const res = spawnSync('npx', ['tsx', ...args], { ...SPAWN, env: { ...process.env, GITHUB_SHA: '', P2S8_EXPECTED_SHA: '' } });
  if (res.signal !== null) throw new Error(`${args.join(' ')} was killed (${res.signal}) — it did not stop after its structural half`);
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const s8Gate = (root: string): Run => run(['scripts/phase3-s8-gate.ts', '--structural-only', '--root', root]);
const p2s8Gate = (root: string): Run => run(['scripts/phase2-s8-gate.ts', '--structural-only', '--root', root]);
const p2s3GateInCopy = (root: string): Run => run([join(root, 'scripts/phase2-s3-gate.ts')]);

const failLines = (r: Run, area: string): string[] => r.output.split('\n').filter((l) => l.includes(`FAIL [${area}]`));

describe('T-15c (1): the P2-S3 gate refuses a byte comparison of the accounting and provisioning keys (A-19)', () => {
  it('hmacKeysEquivalent( replaced by .equals( in config.ts → FAIL [key-separation]', () => {
    const control = cleanCheckout();
    rmSync(join(control, P2S3_EARLY_STOP));
    const before = p2s3GateInCopy(control);
    expect(failLines(before, 'accounting-package').length, before.output.slice(-3000)).toBeGreaterThan(0);
    expect(failLines(before, 'key-separation'), before.output.slice(-3000)).toEqual([]);

    const tampered = cleanCheckout();
    rmSync(join(tampered, P2S3_EARLY_STOP));
    const config = readFileSync(join(tampered, CONFIG), 'utf8');
    expect(config).toContain('hmacKeysEquivalent(');
    rewrite(tampered, CONFIG, config.split('hmacKeysEquivalent(').join('.equals('));
    const after = p2s3GateInCopy(tampered);
    expect(failLines(after, 'key-separation').length, after.output.slice(-3000)).toBeGreaterThan(0);
    expect(after.status).not.toBe(0);
  }, 1_300_000);
});

describe('T-15c (2), (3): the S8 gate refuses a widened migration and an incomplete premortem matrix', () => {
  let control: Run | null = null;
  const untampered = (): Run => {
    control ??= s8Gate(cleanCheckout());
    return control;
  };

  it('the untampered copy carries neither refusal', () => {
    const r = untampered();
    expect(r.output, r.output.slice(-3000)).toContain('P3-S8 GATE — migration content');
    expect(failLines(r, 'migration').filter((l) => l.includes(S8_MIGRATION_NAME))).toEqual([]);
    expect(failLines(r, 'premortem').filter((l) => l.includes('PM-07'))).toEqual([]);
  }, 700_000);

  it('(2) one column added to a reconciler grant → FAIL [migration]', () => {
    const root = cleanCheckout();
    rewrite(root, S8M, once(realS8, 'qty_delta, value_delta_base_minor)', 'qty_delta, value_delta_base_minor, reason)'));
    const r = s8Gate(root);
    expect(failLines(r, 'migration'), r.output.slice(-3000)).toContainEqual(
      expect.stringMatching(new RegExp(`${S8_MIGRATION_NAME.replace(/\./g, '\\.')}: stock_movements grants daftar_reconciler \\(.*\\breason\\b`)),
    );
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('(2b) a planted DO block that borrows an internal role and runs accounting_post_entry → FAIL [migration] (review L-1)', () => {
    const root = cleanCheckout();
    rewrite(
      root,
      S8M,
      `${realS8}\nDO $$ BEGIN SET LOCAL ROLE daftar_accounting_internal;\n  PERFORM accounting_post_entry(current_date, 'x', NULL, '[]'::jsonb); RESET ROLE; END $$;\n`,
    );
    const r = s8Gate(root);
    expect(failLines(r, 'migration'), r.output.slice(-3000)).toContainEqual(expect.stringMatching(/a DO block .* calls accounting_post_entry\(/));
    expect(r.output).not.toContain('P3-S8 GATE: PASS');
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('(2c) the R-B1a trigger neutered with WHEN (false) → FAIL [migration] (review L-2)', () => {
    const root = cleanCheckout();
    rewrite(root, S8M, once(realS8, "FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment', 'opening_balance'))", 'FOR EACH ROW WHEN (false)'));
    const r = s8Gate(root);
    expect(failLines(r, 'migration'), r.output.slice(-3000)).toContainEqual(
      expect.stringContaining('R-B1a needs exactly 1 × trigger:journal_entries_inventory_account_domain, found 0'),
    );
    expect(r.output).not.toContain('P3-S8 GATE: PASS');
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('(3) one PM row removed from the matrix → FAIL [premortem]', () => {
    const root = cleanCheckout();
    const matrix = JSON.parse(readFileSync(join(REPO, PREMORTEM_MATRIX), 'utf8')) as { rows: Record<string, unknown> };
    delete matrix.rows['PM-07'];
    rewrite(root, PREMORTEM_MATRIX, `${JSON.stringify(matrix, null, 2)}\n`);
    const r = s8Gate(root);
    expect(failLines(r, 'premortem'), r.output.slice(-3000)).toContainEqual(expect.stringContaining('PM-07 is missing from the matrix'));
    expect(r.status).not.toBe(0);
  }, 700_000);
});

describe('T-15c (pin 2): the P2-S8 model check still refuses both directions after the S8 widening', () => {
  const MODEL_REFUSAL =
    /FAIL \[s8-model\] the model grants SELECT on \[.*\] but 0051 and the migrations after 0052_accounting_journal_lines_rls_performance\.sql grant it on \[/;

  it('the untampered copy: the model names 0051’s six tables and the three granted after 0052 — nothing else', () => {
    const r = p2s8Gate(cleanCheckout());
    expect(r.output, r.output.slice(-3000)).toContain(
      "the intended model names 0051's six tables and the 3 granted after 0052 (stock_levels, stock_movements, stock_source_bindings) — nothing else",
    );
    expect(r.output).not.toMatch(MODEL_REFUSAL);
  }, 700_000);

  it('a table a later migration grants that the model omits → FAIL [s8-model]', () => {
    const root = cleanCheckout();
    const model = JSON.parse(readFileSync(join(REPO, MODEL), 'utf8')) as { selectColumns: Record<string, unknown> };
    delete model.selectColumns['stock_source_bindings'];
    rewrite(root, MODEL, `${JSON.stringify(model, null, 2)}\n`);
    const r = p2s8Gate(root);
    expect(r.output, r.output.slice(-3000)).toMatch(MODEL_REFUSAL);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('a table the model names that no migration grants → FAIL [s8-model]', () => {
    const root = cleanCheckout();
    rewrite(
      root,
      S8M,
      once(
        realS8,
        'GRANT SELECT (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind)\n  ON stock_source_bindings TO daftar_reconciler;',
        '',
      ),
    );
    const r = p2s8Gate(root);
    expect(r.output, r.output.slice(-3000)).toMatch(MODEL_REFUSAL);
    expect(r.status).not.toBe(0);
  }, 700_000);
});
