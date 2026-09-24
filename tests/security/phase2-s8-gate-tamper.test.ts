/**
 * A GATE THAT HAS NEVER SAID NO IS NOT KNOWN TO BE ABLE TO (f §24).
 *
 * Every refusal in `scripts/phase2-s8-gate.ts` is a sentence about something
 * that must not happen. Until this file existed, all of them had only ever
 * been observed NOT firing — the tree has always been correct — and a check
 * that has only ever passed proves nothing about the case it was written for.
 * A typo in one regular expression, a set compared against itself, a `some`
 * where an `every` was meant: each of those produces a gate that is green
 * forever, and looks exactly like a gate that is working.
 *
 * ── How the proof is produced without breaking anything ──────────────────
 *
 * f §24 is explicit that the repository may not be modified to make these
 * cases. So each case builds a THROWAWAY COPY of the tracked tree in a
 * temporary directory — hard links, so it costs almost nothing — breaks
 * exactly one thing in it by replacing that one file, and runs the real gate
 * against the copy with `--root`. The copy is deleted afterwards. Nothing in
 * this repository is written to, at any point, by any case below.
 *
 * The FIRST case is the control, and it carries as much weight as the rest:
 * an untampered copy must PASS. Without it, every assertion here could be
 * satisfied by a gate that fails on everything — and it also proves the
 * property f §4 asks for directly, since the copy contains no `release/`
 * directory at all. The Level A gate passes on a clean checkout.
 *
 * ── The three cases that are not a tampered tree ─────────────────────────
 *
 * Three of f §24's cases cannot honestly be made this way, and each is proved
 * where it can be:
 *
 *   — "make the runner canary exit 0". The defect it watches for is a race,
 *     so a fixture built to lose it would prove the point intermittently.
 *     The decision is `canaryRefusal` in `scripts/runner-canary.ts` and it is
 *     handed the exact pair of values a broken runner produces.
 *   — "make the supply-chain check fail". The check reads the lockfile, so
 *     the tampered copy's OWN script is run against the tampered copy.
 *   — "make Tier 1 exceed its ceiling". Re-measuring slowly on demand is not
 *     something a test can arrange; a synthetic over-budget artefact is
 *     written into the copy and the copy's release gate reads it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canaryRefusal } from '../../scripts/runner-canary';

const REPO = join(__dirname, '../..');
const MIGRATIONS = 'infrastructure/database/migrations';
const M0051 = `${MIGRATIONS}/0051_accounting_reconciler_read.sql`;
const M0052 = `${MIGRATIONS}/0052_accounting_journal_lines_rls_performance.sql`;
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/**
 * THE FILES THIS TREE CLAIMS TO CONSIST OF.
 *
 * In a git checkout that is `git ls-files --cached --others
 * --exclude-standard`: tracked, or untracked and not ignored, which is what a
 * reviewer's checkout of the branch contains. `node_modules`, `dist/` and —
 * importantly — `release/` are gitignored and so are not in it.
 *
 * In an EXTRACTED RELEASE CANDIDATE there is no git, by design: f §28 requires
 * the release gate to run from the archive with no `.git` in it, and this
 * suite runs inside that gate. Asking git there produced
 * `fatal: not a git repository` twenty-one times, which is this suite failing
 * to run rather than any gate failing to refuse. The archive carries its own
 * inventory — `DELIVERY_MANIFEST.json` — and there that is the better source
 * anyway: it is what the archive says it contains and what the release gate
 * has already checked the tree against, file by file. Walking the directory
 * instead would copy whatever `npm ci` had just left behind.
 */
function deliveredFiles(): string[] {
  const manifest = join(REPO, 'DELIVERY_MANIFEST.json');
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { inventory?: { path?: string }[] };
    const paths = (parsed.inventory ?? []).map((entry) => entry.path).filter((path): path is string => typeof path === 'string' && path !== '');
    if (paths.length === 0) throw new Error('DELIVERY_MANIFEST.json is present and carries no inventory');
    return paths;
  }
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed.split('\0').filter((rel) => rel !== '');
}

/**
 * A copy of every delivered file, hard-linked.
 *
 * The copy is what a fresh clone — or a fresh extraction — gives you, before
 * anybody has produced any evidence. Hard-linked, so the copy is essentially
 * free and shares the original's blocks; `rewrite` below unlinks before
 * writing, which is what keeps a tampered file from reaching back into the
 * tree this suite is running in.
 */
function cleanCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'p2s8-tamper-'));
  temporaries.push(root);
  for (const rel of deliveredFiles()) {
    const source = join(REPO, rel);
    if (!existsSync(source)) continue; // a tracked file deleted in the worktree
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    linkSync(source, target);
  }
  return root;
}

/** Replace a file in the copy. The unlink is what protects the original. */
function rewrite(root: string, rel: string, contents: string): void {
  const target = join(root, rel);
  rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const readFrom = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');

/** Delete a file from the copy. */
function remove(root: string, rel: string): void {
  rmSync(join(root, rel), { force: true });
}

interface Run {
  readonly status: number | null;
  readonly output: string;
}

/** The REAL gate, structural half only, pointed at a tree that is not this one. */
function structuralGate(root: string): Run {
  const res = spawnSync('npx', ['tsx', 'scripts/phase2-s8-gate.ts', '--structural-only', '--root', root], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: '', P2S8_EXPECTED_SHA: '' },
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** A script INSIDE the copy, so its own `__dirname` makes the copy its root. */
function scriptInCopy(root: string, rel: string): Run {
  const res = spawnSync('npx', ['tsx', join(root, rel)], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: '', P2S8_EXPECTED_SHA: '' },
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Every case below asserts BOTH: the gate refused, and it said why. */
function expectRefusal(run: Run, reason: RegExp): void {
  expect(run.output).toMatch(reason);
  expect(run.status, run.output.slice(-3000)).not.toBe(0);
}

describe('the control: an untampered clean checkout passes (f §4, §24)', () => {
  it('passes with no release/ directory anywhere — the Level A gate is self-contained', () => {
    const root = cleanCheckout();
    expect(existsSync(join(root, 'release')), 'the copy must not contain produced evidence').toBe(false);
    const run = structuralGate(root);
    expect(run.output, run.output.slice(-4000)).toContain('P2-S8 GATE: PASS (structural checks only)');
    expect(run.status).toBe(0);
  }, 180_000);
});

describe('the migration boundary can be broken, and the gate says so (f §24)', () => {
  it('refuses a tree with 0051 removed', () => {
    const root = cleanCheckout();
    remove(root, M0051);
    expectRefusal(structuralGate(root), /0051_accounting_reconciler_read\.sql is missing/);
  }, 180_000);

  it('refuses a tree with 0052 removed', () => {
    const root = cleanCheckout();
    remove(root, M0052);
    expectRefusal(structuralGate(root), /0052_accounting_journal_lines_rls_performance\.sql is missing/);
  }, 180_000);

  /**
   * The converse of every other case here, and the one that has to be proved
   * rather than assumed. P2-S8 is accepted history now, and an accepted
   * historical gate that forbids its successor is a gate that stops the
   * project. The candidate-era rule — "no 0053 may exist" — went with the
   * candidacy; this case exists so that nobody can quietly put it back.
   */
  it('ACCEPTS a tree that carries a later migration — a permanent gate does not block its successor', () => {
    const root = cleanCheckout();
    rewrite(root, `${MIGRATIONS}/0053_accounting_next_slice.sql`, '-- a later slice, authorized by a future directive\nSELECT 1;\n');
    const run = structuralGate(root);
    expect(run.output, run.output.slice(-4000)).toContain('P2-S8 GATE: PASS (structural checks only)');
    expect(run.status).toBe(0);
  }, 180_000);

  it.each([
    ['0051', '0051_accounting_reconciler_read.sql'],
    ['0052', '0052_accounting_journal_lines_rls_performance.sql'],
  ])(
    'refuses an unfrozen %s — it is accepted history, not a candidate',
    (_label, name) => {
      const root = cleanCheckout();
      const manifest = JSON.parse(readFrom(root, MANIFEST)) as { frozenThrough: string; migrations: { name: string; sha256: string }[] };
      manifest.migrations = manifest.migrations.filter((m) => m.name !== name);
      rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
      expectRefusal(structuralGate(root), /is not recorded in MIGRATION_MANIFEST\.json — P2-S8 was accepted/);
    },
    180_000,
  );

  it.each([
    ['0051', '0051_accounting_reconciler_read.sql'],
    ['0052', '0052_accounting_journal_lines_rls_performance.sql'],
  ])(
    'refuses a %s re-frozen at a digest that is not the accepted one',
    (_label, name) => {
      const root = cleanCheckout();
      // Both halves moved together — the file AND its recorded hash — which is
      // exactly what a manifest-only check cannot see. The gate's second
      // source is the accepted digest compiled into it.
      rewrite(root, `${MIGRATIONS}/${name}`, `${readFrom(root, `${MIGRATIONS}/${name}`)}\n-- a byte nobody accepted\n`);
      const manifest = JSON.parse(readFrom(root, MANIFEST)) as { frozenThrough: string; migrations: { name: string; sha256: string }[] };
      const sha = createHash('sha256')
        .update(readFileSync(join(root, MIGRATIONS, name)))
        .digest('hex');
      manifest.migrations = manifest.migrations.map((m) => (m.name === name ? { name, sha256: sha } : m));
      rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
      expectRefusal(structuralGate(root), /but was accepted at .+ — the manifest disagrees with the acceptance/);
    },
    180_000,
  );

  it('refuses a manifest whose boundary moved BACK below 0052', () => {
    const root = cleanCheckout();
    const manifest = JSON.parse(readFrom(root, MANIFEST)) as { frozenThrough: string; migrations: { name: string; sha256: string }[] };
    manifest.frozenThrough = '0050_accounting_report_indexes.sql';
    rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    expectRefusal(structuralGate(root), /P2-S8 was accepted and frozen, so it must be at least/);
  }, 180_000);
});

describe('the reconciler authority can be widened, and the gate says so (f §24)', () => {
  it('refuses a write privilege granted to the reconciler', () => {
    const root = cleanCheckout();
    rewrite(root, M0051, `${readFrom(root, M0051)}\nGRANT INSERT ON journal_lines TO daftar_reconciler;\n`);
    expectRefusal(structuralGate(root), /reconciliation may DETECT, never REPAIR/);
  }, 180_000);

  it('refuses an accounting read granted to daftar_worker', () => {
    const root = cleanCheckout();
    rewrite(root, M0051, `${readFrom(root, M0051)}\nGRANT SELECT ON journal_lines TO daftar_worker;\n`);
    expectRefusal(structuralGate(root), /grants SELECT on journal_lines to daftar_worker/);
  }, 180_000);

  it('refuses a privilege model that claims a write privilege', () => {
    const root = cleanCheckout();
    const model = JSON.parse(readFrom(root, 'infrastructure/database/reconciler-privilege-model.json')) as Record<string, unknown>;
    model['writePrivileges'] = [{ table: 'journal_lines', privilege: 'UPDATE' }];
    rewrite(root, 'infrastructure/database/reconciler-privilege-model.json', `${JSON.stringify(model, null, 2)}\n`);
    expectRefusal(structuralGate(root), /the model grants a write privilege/);
  }, 180_000);
});

describe('the RLS correction can be weakened, and the gate says so (f §24)', () => {
  it('refuses an app_bypass() that names a second principal', () => {
    const root = cleanCheckout();
    const sql = readFrom(root, M0052).replace(
      /RETURN CURRENT_USER OPERATOR\(pg_catalog\.=\) 'daftar_platform'::pg_catalog\.name;/,
      "RETURN CURRENT_USER OPERATOR(pg_catalog.=) ANY (ARRAY['daftar_platform'::pg_catalog.name, 'daftar_worker'::pg_catalog.name]);",
    );
    expect(sql, 'the tamper must actually change the file').not.toBe(readFrom(root, M0052));
    rewrite(root, M0052, sql);
    expectRefusal(structuralGate(root), /rewrites app_bypass\(\) to name .* §4 pins it to daftar_platform alone/);
  }, 180_000);

  it('refuses a PARTIALLY applied policy correction — every subset measured slower than none', () => {
    const root = cleanCheckout();
    // Remove exactly one of the six ALTER POLICY statements.
    const sql = readFrom(root, M0052).replace(/ALTER POLICY tenant_membership ON accounts[\s\S]*?;\n/, '');
    expect(sql, 'the tamper must actually remove one statement').not.toBe(readFrom(root, M0052));
    rewrite(root, M0052, sql);
    expectRefusal(structuralGate(root), /is missing accounts\.tenant_membership/);
  }, 180_000);

  it('refuses a history in which a load-bearing composite foreign key is dropped', () => {
    const root = cleanCheckout();
    rewrite(root, M0052, `${readFrom(root, M0052)}\nALTER TABLE journal_lines DROP CONSTRAINT journal_lines_tenant_business_fk;\n`);
    expectRefusal(structuralGate(root), /drops it journal_lines_tenant_business_fk/);
  }, 180_000);
});

describe('the exit-code guard can be un-installed, and the gate says so (f §17, §18, §24)', () => {
  it('refuses a vitest.config.ts with no globalSetup', () => {
    const root = cleanCheckout();
    rewrite(root, 'vitest.config.ts', readFrom(root, 'vitest.config.ts').replace(/^\s*globalSetup:.*$/m, ''));
    expectRefusal(structuralGate(root), /does not set globalSetup to tests\/helpers\/global-setup\.ts/);
  }, 180_000);

  it('refuses a global setup that imports the guard and never calls it — a dormant guard is not a guard', () => {
    const root = cleanCheckout();
    const setup = readFrom(root, 'tests/helpers/global-setup.ts').replace(/^protectFailingExitCode\(\);$/m, '// protectFailingExitCode();');
    expect(setup).toContain('protectFailingExitCode');
    rewrite(root, 'tests/helpers/global-setup.ts', setup);
    expectRefusal(structuralGate(root), /imports protectFailingExitCode but does not call it at module scope/);
  }, 180_000);
});

describe('the runner canary refuses the pair of values a broken runner produces (f §3, §24)', () => {
  it('refuses a run that printed a failure and still exited 0', () => {
    const refusal = canaryRefusal({ output: 'Tests  1 failed (1)\n', status: 0 });
    expect(refusal).toMatch(/exited 0 over a failing test/);
  });

  it('refuses a run in which the failing test never ran, whatever the status', () => {
    expect(canaryRefusal({ output: 'Tests  1 passed (1)\n', status: 0 })).toMatch(/did not run its failing test/);
    expect(canaryRefusal({ output: 'could not resolve config\n', status: 1 })).toMatch(/did not run its failing test/);
  });

  it('accepts only the real thing: the failure printed AND a non-zero status', () => {
    expect(canaryRefusal({ output: 'Tests  1 failed (1)\n', status: 1 })).toBeNull();
    expect(canaryRefusal({ output: 'Tests  1 failed (1)\n', status: null })).toBeNull();
  });
});

describe('the supply-chain check can fail, and does (f §22, §24)', () => {
  it('refuses a lockfile entry with no integrity hash', () => {
    const root = cleanCheckout();
    const lock = JSON.parse(readFrom(root, 'package-lock.json')) as { packages: Record<string, { integrity?: string; link?: boolean }> };
    const victim = Object.entries(lock.packages).find(
      ([name, entry]) => name.startsWith('node_modules/') && entry.link !== true && entry.integrity !== undefined,
    );
    if (victim === undefined) throw new Error('the lockfile must contain a checksummed package to un-checksum');
    const [name, entry] = victim;
    lock.packages[name] = { ...entry, integrity: undefined };
    rewrite(root, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    const run = scriptInCopy(root, 'scripts/check-supply-chain.ts');
    expect(run.output).toContain(`${name} has no integrity hash`);
    expect(run.status, run.output.slice(-2000)).not.toBe(0);
  }, 180_000);
});

describe('a Tier 1 measurement over its ceiling is a FAIL, not a note (f §12, §24)', () => {
  it('refuses a Tier 1 artefact whose p95 exceeds the accepted budget', () => {
    const root = cleanCheckout();
    mkdirSync(join(root, 'release'), { recursive: true });
    const budgets = {
      A_POST_P95: 15,
      B_ADJUSTMENT_ENDPOINT_P95: 60,
      C_TRIAL_BALANCE_P95: 500,
      D_LEDGER_PAGE_P95: 150,
      E_BALANCE_AS_OF_P95: 100,
      F_RECONCILIATION_TOTAL: 300_000,
    };
    writeFileSync(
      join(root, 'release/phase2-s8-performance-tier1.json'),
      `${JSON.stringify(
        {
          slice: 'P2-S8',
          tier: 1,
          budgets,
          measurements: Object.entries(budgets).map(([name, budgetMs], i) => ({
            name,
            budgetMs,
            iterations: 30,
            p50: budgetMs / 2,
            // Exactly one of the six is over, which is the case a reader most
            // needs the gate to catch: five green numbers beside one red.
            p95: i === 2 ? budgetMs + 1 : budgetMs / 2,
          })),
        },
        null,
        2,
      )}\n`,
    );
    const run = scriptInCopy(root, 'scripts/phase2-s8-release-gate.ts');
    expect(run.output).toMatch(/Tier 1 — C_TRIAL_BALANCE_P95: p95 501\.0 ms against a 500 ms ceiling/);
    expect(run.status, run.output.slice(-2000)).not.toBe(0);
  }, 180_000);

  it('refuses a Tier 1 artefact measured by a planner that had no statistics', () => {
    // The case this catches actually happened. `accounts` is read by the
    // trial balance, written by nothing in the dataset generator, and about
    // twenty rows per business — under `autovacuum_analyze_threshold`, so it
    // went into the measurement with no statistics at all. The planner
    // estimated one row where there were twenty-one and re-executed the whole
    // journal aggregate once per account: 2.9 s on a GitHub runner against a
    // 500 ms ceiling. Every number in the file was inside its budget on the
    // run before that one, so only the statistics state tells a reader which
    // of the two the file describes.
    const root = cleanCheckout();
    mkdirSync(join(root, 'release'), { recursive: true });
    const budgets = {
      A_POST_P95: 15,
      B_ADJUSTMENT_ENDPOINT_P95: 60,
      C_TRIAL_BALANCE_P95: 500,
      D_LEDGER_PAGE_P95: 150,
      E_BALANCE_AS_OF_P95: 100,
      F_RECONCILIATION_TOTAL: 300_000,
    };
    writeFileSync(
      join(root, 'release/phase2-s8-performance-tier1.json'),
      `${JSON.stringify(
        {
          slice: 'P2-S8',
          tier: 1,
          budgets,
          measurements: Object.entries(budgets).map(([name, budgetMs]) => ({ name, budgetMs, iterations: 30, p50: budgetMs / 2, p95: budgetMs / 2 })),
          planningStatistics: [
            { table: 'accounts', relpages: 0, reltuples: -1, analyzedAt: null },
            { table: 'journal_lines', relpages: 540, reltuples: 21614, analyzedAt: '2026-09-24 05:45:47.519354+00' },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const run = scriptInCopy(root, 'scripts/phase2-s8-release-gate.ts');
    expect(run.output).toMatch(/accounts had no statistics when the budgets were measured/);
    expect(run.status, run.output.slice(-2000)).not.toBe(0);
  }, 180_000);

  it('refuses a Tier 1 artefact in which only some of the budgets were measured', () => {
    const root = cleanCheckout();
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(
      join(root, 'release/phase2-s8-performance-tier1.json'),
      `${JSON.stringify(
        {
          slice: 'P2-S8',
          tier: 1,
          budgets: {
            A_POST_P95: 15,
            B_ADJUSTMENT_ENDPOINT_P95: 60,
            C_TRIAL_BALANCE_P95: 500,
            D_LEDGER_PAGE_P95: 150,
            E_BALANCE_AS_OF_P95: 100,
            F_RECONCILIATION_TOTAL: 300_000,
          },
          measurements: [{ name: 'A_POST_P95', budgetMs: 15, iterations: 30, p50: 4, p95: 6 }],
        },
        null,
        2,
      )}\n`,
    );
    const run = scriptInCopy(root, 'scripts/phase2-s8-release-gate.ts');
    expect(run.output).toMatch(/Tier 1: 1 of 6 budgets were measured — a partial run is not a pass/);
    expect(run.status).not.toBe(0);
  }, 180_000);
});
