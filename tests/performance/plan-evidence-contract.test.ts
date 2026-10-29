/**
 * THE PLAN-EVIDENCE CONTRACT, AS AN EXECUTABLE STATEMENT.
 *
 * P4-S3's defect was not that somebody wrote a wrong assertion. It was that
 * the assertion was never executed anywhere it could be wrong. It asserted a
 * `>= / <` index range, it was green locally for months, and it went red the
 * first time required CI ever ran the gate that contains it.
 *
 * Three things have to be true for that not to recur, and this file asserts
 * all three — structurally, from the tree, with no database and no network:
 *
 *   1. THE INVENTORY IS CURRENT. The set of plan-shape claims is DERIVED from
 *      the working tree by `scripts/plan-evidence/discover-plan-claims.ts`,
 *      not remembered. If someone adds a plan gate and does not regenerate
 *      the inventory, this suite goes red.
 *
 *   2. EVERY PLAN GATE IS EXECUTED BY REQUIRED CI AGAINST THE TARGET. Each
 *      file the inventory marks as holding a plan gate must be reachable from
 *      a step of the required `backend` job, and that job's database must be
 *      the `postgres:16` service, and the step must point the harness at it
 *      (`PG_PORT: '5432'`). A plan claim that required CI never executes is
 *      exactly the defect, and no amount of local green substitutes.
 *
 *   3. THE CONTRACT GATES ON THE PROPERTY, NOT THE SPELLING. PostgreSQL
 *      stores `datcollate` verbatim; `en_US.utf8` and `en_US.UTF-8` are the
 *      same glibc locale and different strings. A contract that string-matched
 *      would reject the environment it describes.
 *
 * This file deliberately does NOT modify `.github/workflows/ci.yml` — it only
 * reads it. Wiring belongs to the workflow's owner; proving the wiring is
 * present belongs here.
 */
import { readFileSync, existsSync, readdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  TARGET_PLAN_EVIDENCE_CONTRACT,
  BYTE_ORDER_COLLATIONS,
  isByteOrderCollation,
  classifyPlanEvidence,
  type PlanEvidenceEnvironment,
} from '../helpers/plan-evidence-env';
import { discover } from '../../scripts/plan-evidence/discover-plan-claims';

const ROOT = join(__dirname, '..', '..');
const INVENTORY = join(ROOT, 'docs', 'plan-evidence', 'plan-claim-inventory.json');
const CI = join(ROOT, '.github', 'workflows', 'ci.yml');

interface Inventory {
  totals: { hits: number; planGates: number; assertions: number; files: number };
  byFile: Record<string, { planGates: number; assertions: number; mentions: number; phase: string }>;
  hits: { file: string; line: number; kind: string; phase: string; signals: string[] }[];
}

/**
 * The inventory is DERIVED here, in-process, from the working tree — never
 * read from the committed artifact and trusted.
 *
 * The committed file at `docs/plan-evidence/` exists so a reviewer can read
 * the inventory without running anything. It is not the source of truth, and
 * a test that read it would prove only that somebody once generated a file.
 * The staleness check below makes the two agree; everything else in this
 * suite runs against the freshly derived set.
 */
function derive(): Inventory {
  const out = execFileSync('npx', ['tsx', 'scripts/plan-evidence/discover-plan-claims.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return JSON.parse(out) as Inventory;
}

/** The files the discovery rule says hold at least one plan gate. */
function planGateFiles(inv: Inventory): string[] {
  return Object.entries(inv.byFile)
    .filter(([, v]) => v.planGates > 0)
    .map(([f]) => f)
    .sort();
}

describe('the plan-evidence contract', () => {
  it('gates on the collation PROPERTY, never on a spelling', () => {
    // Measured on PostgreSQL 16.13: these two are the same glibc locale and
    // different strings, because PostgreSQL stores datcollate verbatim.
    expect(isByteOrderCollation('en_US.utf8')).toBe(false);
    expect(isByteOrderCollation('en_US.UTF-8')).toBe(false);
    // And the two that bit: non-byte-order despite the `C` prefix.
    expect(isByteOrderCollation('C.utf8')).toBe(false);
    expect(isByteOrderCollation('C.UTF-8')).toBe(false);
    // Exactly two spellings are byte order. PostgreSQL recognises no others.
    expect([...BYTE_ORDER_COLLATIONS].sort()).toEqual(['C', 'POSIX']);
    expect(TARGET_PLAN_EVIDENCE_CONTRACT.major).toBe(16);
    expect(TARGET_PLAN_EVIDENCE_CONTRACT.collationIsByteOrder).toBe(false);
  });

  it('refuses the exact environment that produced the P4-S3 false green', () => {
    const base = {
      serverVersion: '18.4',
      datname: 'daftar',
      datctype: 'C',
      localeProvider: 'c',
      icuLocale: null,
      encoding: 'UTF8',
    };
    // The local embedded cluster: PostgreSQL 18, bare `C`. Both wrong.
    const local: PlanEvidenceEnvironment = {
      ...base,
      serverVersionNum: 180004,
      serverMajor: 18,
      datcollate: 'C',
      collationIsByteOrder: true,
    };
    const v = classifyPlanEvidence(local);
    expect(v.authoritative).toBe(false);
    expect(v.reasons).toHaveLength(2);

    // Right major, wrong collation — still not authoritative. This is the
    // case that matters: a PG16 run at `C` looks like the target and is not.
    const pg16AtC = classifyPlanEvidence({
      ...base,
      serverVersion: '16.13',
      serverVersionNum: 160013,
      serverMajor: 16,
      datcollate: 'C',
      collationIsByteOrder: true,
    });
    expect(pg16AtC.authoritative).toBe(false);

    // The target itself, in the spelling the postgres:16 image reports.
    const target = classifyPlanEvidence({
      ...base,
      serverVersion: '16.13',
      serverVersionNum: 160013,
      serverMajor: 16,
      datcollate: 'en_US.utf8',
      datctype: 'en_US.utf8',
      collationIsByteOrder: false,
    });
    expect(target.authoritative).toBe(true);
    expect(target.reasons).toEqual([]);
  });
});

describe('every discovered plan-shape claim is executed by required CI against postgres:16', () => {
  const inv = derive();
  const ci = readFileSync(CI, 'utf8');

  it('the committed inventory matches the tree', () => {
    expect(existsSync(INVENTORY), 'docs/plan-evidence/plan-claim-inventory.json is missing — run `npm run plan-evidence:inventory`').toBe(true);
    const committed = JSON.parse(readFileSync(INVENTORY, 'utf8')) as Inventory;
    // Compare the claims, not the whole file: the generator's own metadata
    // may gain fields without any claim having changed.
    expect(
      committed.hits,
      'the committed plan-claim inventory is STALE. A plan gate was added, moved or removed without regenerating it: `npm run plan-evidence:inventory`',
    ).toEqual(inv.hits);
  });

  /**
   * The generator excludes exactly one directory — its own output, because
   * the inventory quotes every line it reports and scanning itself has no
   * fixpoint (measured: 196 hits became 416 on the second run).
   *
   * An exclusion is how a claim hides, so the exclusion is sealed here: the
   * directory may hold only the artifact and prose about it. Put a `.ts` in
   * it and this goes red.
   */
  it('the one excluded directory cannot hold an executable claim', () => {
    const dir = join(ROOT, 'docs', 'plan-evidence');
    const offenders = readdirSync(dir).filter((f) => /\.(ts|mts|tsx|sql|yml|yaml)$/.test(f));
    expect(offenders, 'docs/plan-evidence/ is excluded from discovery, so nothing executable may live there').toEqual([]);
  });

  /**
   * ARCHIVE PORTABILITY, PROVED RATHER THAN DECLARED.
   *
   * `tests/security/archive-portability.test.ts` requires every git call under
   * `tests/**` and `scripts/**` to carry a `DELIVERY_MANIFEST.json` branch,
   * because the release gate runs from an extracted archive with no `.git`.
   * That law reads the SHAPE of the code. This reads the BEHAVIOUR: the
   * generator is driven over a root that has a manifest and no repository at
   * all, and must discover the same claims from it. A branch nothing ever
   * takes is a branch that satisfies the shape law and still fails in the
   * archive.
   */
  it('discovers claims from DELIVERY_MANIFEST.json with no repository present', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-evidence-manifest-'));
    try {
      // Only `tests/` and `docs/` are linked through, so the manifest also
      // exercises three filters at once: a path outside ROOTS is never read,
      // a path under the excluded SELF directory is dropped, and a path the
      // manifest names but the tree does not carry is skipped rather than
      // throwing.
      symlinkSync(join(ROOT, 'tests'), join(root, 'tests'));
      symlinkSync(join(ROOT, 'docs'), join(root, 'docs'));
      writeFileSync(
        join(root, 'DELIVERY_MANIFEST.json'),
        JSON.stringify({
          inventory: [
            { path: 'tests/performance/pos-s3-budgets.test.ts' },
            { path: 'tests/security/policy-helper-inlining.test.ts' },
            { path: 'docs/plan-evidence/plan-claim-inventory.json' },
            { path: 'a-path-the-tree-does-not-carry.md' },
          ],
        }),
      );
      expect(existsSync(join(root, '.git')), 'the fixture root must have no repository, or this proves nothing').toBe(false);

      const hits = discover(root);
      const files = [...new Set(hits.map((hit) => hit.file))].sort();
      expect(files).toEqual(['tests/performance/pos-s3-budgets.test.ts', 'tests/security/policy-helper-inlining.test.ts']);
      // The P4-S3 barcode gate itself is among what the manifest branch finds,
      // so the claim that matters most in this slice is reproducible from the
      // artifact the deployment is cut from.
      expect(hits.some((hit) => hit.kind === 'plan-gate' && hit.file === 'tests/performance/pos-s3-budgets.test.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the discovery rule finds the claims it is supposed to find', () => {
    // A sanity floor, not a remembered list: if the rule stops finding the
    // gates we know exist, the rule has broken and the inventory is lying.
    const files = planGateFiles(inv);
    expect(inv.totals.planGates).toBeGreaterThan(0);
    expect(files).toContain('tests/performance/pos-s3-budgets.test.ts');
    expect(files.every((f) => existsSync(join(ROOT, f)))).toBe(true);
  });

  it('the required backend job runs postgres:16 and points the harness at it', () => {
    expect(ci).toContain('image: postgres:16');
    expect(ci).toContain("PG_PORT: '5432'");
  });

  /**
   * The wiring itself. Every plan-gate file must be executed by the required
   * `backend` job — either directly by a `vitest run <file>` step, or
   * transitively through a gate script the job runs that names the file.
   *
   * The transitive case is resolved by reading the gate scripts, not by
   * trusting a comment: a gate is only composed if the script actually names
   * the suite.
   */
  it('each plan-gate file is reachable from a step of the required backend job', () => {
    const unreached = unreachedBy(ci, planGateFiles(inv));
    expect(
      unreached,
      `these files hold plan-shape claims that required CI never executes against its postgres:16 service, ` +
        `which is the exact shape of the P4-S3 defect:\n  ${unreached.join('\n  ')}\n\n` +
        `Wire each one into the required \`backend\` job of .github/workflows/ci.yml, ` +
        `with PG_PORT: '5432' so the harness reuses the postgres:16 service. For this suite that step is:\n` +
        `      - name: Plan-evidence contract\n` +
        `        run: npm run plan-evidence:contract\n` +
        `        env:\n` +
        `          PG_PORT: '5432'`,
    ).toEqual([]);
  });

  /**
   * RED PROOF. A check that cannot fail proves nothing, and this project has
   * already paid once for a gate that was only ever green.
   *
   * `ci.yml` belongs to another owner, so the defect is planted in a COPY of
   * its text rather than on disk: the step that EXECUTES
   * `pos-s3-budgets.test.ts` — the measurement of P4-A and P4-B, the one
   * whose absence would have hidden the barcode defect indefinitely — is
   * deleted, and the same resolver must then name the file as unreached.
   *
   * It plants that step and not the `gate:phase4:s3` step on purpose. The
   * gate does run the suite, but through a roster it derives at run time,
   * which no reader of `ci.yml` can see; what the gate script contributed to
   * THIS resolver was a comment, not a run. So planting the gate step proved
   * nothing once any other gate script named `gate:phase4:s3`.
   */
  it('goes red when a plan-gate step is removed from the required job', () => {
    const planted = ci.replace(/ {6}- name: POS read budgets — P4-A and P4-B, measured[\s\S]*?PG_PORT: '5432'\n/, '');
    expect(planted, 'the POS read budgets step was not found to remove — update this proof').not.toBe(ci);
    expect(unreachedBy(planted, ['tests/performance/pos-s3-budgets.test.ts'])).toEqual(['tests/performance/pos-s3-budgets.test.ts']);
    // And the control: unplanted, the same file is reached.
    expect(unreachedBy(ci, ['tests/performance/pos-s3-budgets.test.ts'])).toEqual([]);
  });
});

/**
 * Which of `files` the required `backend` job of `ciText` never executes.
 *
 * Resolution is by reading, not by trusting a comment: a `npm run <script>`
 * step is expanded to the script body, every `scripts/*.ts` it names is read,
 * and every `gate:phaseN:sM` those scripts compose is expanded in turn. A
 * gate is composed only if the script actually names the suite.
 */
function unreachedBy(ciText: string, files: readonly string[]): string[] {
  const backend = ciText.slice(ciText.indexOf('\n  backend:'), ciText.indexOf('\n  web-admin:'));
  const commands = [...backend.matchAll(/run:\s*(npm run [\w:-]+|npx [^\n]+)/g)].map((m) => (m[1] ?? '').trim());
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  // TWO HAYSTACKS, and the distinction is load-bearing.
  //
  //   runCommands  — the shell a step actually executes, directly or through
  //                  an npm script. `vitest run tests/integration` RUNS a
  //                  directory, so a directory named here reaches its files.
  //   scriptSource — the text of gate scripts. A gate that names a suite
  //                  FILE runs it. A gate that names a DIRECTORY is usually
  //                  enumerating it (the census loops over
  //                  `['tests/integration','tests/security','tests/performance']`)
  //                  and running nothing, so only exact file paths count here.
  //
  // Collapsing the two made the red proof come back green: deleting the
  // P4-S3 step left `pos-s3-budgets.test.ts` "reachable" because some other
  // gate's census mentions `tests/performance`.
  const runCommands: string[] = [];
  const scriptSource: string[] = [];
  const seen = new Set<string>();
  const addScript = (body: string, depth: number): void => {
    if (depth > 4 || seen.has(body)) return;
    seen.add(body);
    runCommands.push(body);
    for (const m of body.matchAll(/scripts\/[\w/-]+\.ts/g)) {
      const p = join(ROOT, m[0]);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, 'utf8');
      // COMMENTS ARE NOT EXECUTION. The docstring above says resolution is by
      // reading rather than by trusting a comment; for a long time the code
      // did not keep that promise, and the cost was exact. The only thing in
      // the required job's reachable TEXT that named
      // `tests/performance/pos-s3-budgets.test.ts` was one sentence inside
      // `scripts/phase4-s3-gate.ts` arguing that demanding a planted-defect
      // proof OF that file is a category error.
      //
      // The file was in fact being executed — the P4-S3 gate derives its
      // roster from the tree at run time and runs all fourteen suites — but
      // nothing readable said so, so the law was green for a reason that
      // would have survived the execution going away, and the red proof had
      // no force: deleting the P4-S3 step left the comment reachable through
      // any other gate script that names `gate:phase4:s3`. The remedy is a
      // step in `ci.yml` that names the file, not a resolver taught to model
      // a runtime derivation.
      //
      // A gate script therefore names a suite only in code. `://` is spared so
      // a URL in a comment-stripped line cannot amputate the line itself.
      scriptSource.push(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'));
      for (const g of src.matchAll(/gate:[\w:]+/g)) {
        const body2 = pkg.scripts[g[0]];
        if (body2 !== undefined) addScript(body2, depth + 1);
      }
    }
  };
  for (const cmd of commands) {
    const m = /^npm run ([\w:-]+)/.exec(cmd);
    const body = m?.[1] === undefined ? undefined : pkg.scripts[m[1]];
    if (body !== undefined) addScript(body, 0);
    else runCommands.push(cmd);
  }
  const runs = runCommands.join('\n');
  const sources = scriptSource.join('\n');

  const reaches = (file: string): boolean => {
    // Named outright, by a step or by a gate script.
    if (runs.includes(file) || sources.includes(file)) return true;
    // Or covered by a directory a RUN COMMAND passes to the runner.
    const parts = file.split('/');
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const dir = parts.slice(0, i).join('/');
      if (new RegExp(`(^|[\\s'"])${dir}([\\s'"]|$)`, 'm').test(runs)) return true;
    }
    return false;
  };
  return files.filter((f) => !reaches(f));
}
