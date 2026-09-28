/**
 * THE CORRECTIVE GATE CAN REFUSE (the Tech Lead's corrective directive §19;
 * docs/PHASE_3_FINAL_CORRECTIVE_AUDIT.md requirement O).
 *
 * "A gate that has never been proven capable of failing on the defect is
 * insufficient." Each case below puts one old defect back, or breaks one
 * thing the gate declares, and shows `gate:phase3:corrective` refusing:
 *
 *   TD-19 red   the BFF fix reverted (the BFF forwards no client address, so
 *               every browser behind one web server shares one allowance):
 *               the gate's web-suite step fails;
 *   TD-20 red   the old Adjust Stock model (Starting stock still offered once
 *               the business's opening is posted): the same step fails;
 *   F red       Turkish, or a viewport, removed from the real-browser matrix
 *               (the browser gate's own config, or this gate's declared
 *               matrix), or the missing-string plant removed: FAIL [browser-matrix];
 *   E red       a secret scan that is not the explicit Phase 3 range scan
 *               (none declared, or one whose program does not start from
 *               the Phase 3 base): FAIL [secret-scan];
 *   and the no-silent-pass rules: an unfilled entry is FAIL [pending], a
 *   listed suite that skips or is missing and an unlisted p3c suite are
 *   FAIL [suites], and the corrective migration boundary is exact.
 *
 * The TD-16, I-1 and TD-18 red proofs belong to the DB stream's suites; until
 * they are wired in, `RED_PROOFS` carries them as pending, which is a FAIL of
 * the gate, not a skip.
 *
 * The breaking is done in a HARD-LINKED COPY of the tree, as
 * tests/security/phase3-s8-gate-tamper.test.ts does it: a tampered file is
 * unlinked before it is written, so nothing reaches back into this checkout.
 * Structural cases run the real gate with `--root <copy> --structural-only`,
 * or, when the tamper is to the gate itself, the copy's own gate script. The
 * runtime cases run the exact command of the gate's web-suite step
 * (`correctivePlan`) inside the copy. Each tampered run is paired with the
 * same run over an untampered copy, and the assertion is on the refusal the
 * tamper adds.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deliveredFiles } from '../helpers/delivered-files';
import {
  BROWSER_MATRIX,
  CORRECTIVE_ACCEPTED,
  CORRECTIVE_COMMANDS,
  CORRECTIVE_MIGRATIONS,
  CORRECTIVE_MIGRATION_HEADER,
  CORRECTIVE_SUITES,
  PHASE3_BASE,
  RED_PROOFS,
  SECRET_RANGE_SCAN,
  boundaryProblems,
  browserMatrixProblems,
  correctivePlan,
  isPending,
  pendingProblems,
  secretScanProblems,
} from '../../scripts/phase3-corrective-gate';

const REPO = join(__dirname, '../..');
const GATE = 'scripts/phase3-corrective-gate.ts';
const BROWSER_CONFIG = 'tests/browser/config.ts';
const RUN_CONTEXT = 'tests/browser/run-context.ts';
const MIGRATIONS = 'infrastructure/database/migrations';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';
const BFF_UPSTREAM = 'apps/web/src/lib/bff-upstream.ts';
const STOCK_MODEL = 'apps/web/src/views/stock/model.ts';

/** Replace exactly one occurrence; a fixture that no longer matches is a broken test, not a pass. */
function once(text: string, from: string | RegExp, to: string): string {
  const matches =
    typeof from === 'string' ? text.split(from).length - 1 : [...text.matchAll(new RegExp(from.source, `${from.flags.replace('g', '')}g`))].length;
  if (matches !== 1) throw new Error(`the fixture expects exactly one occurrence of ${String(from)}, found ${matches}`);
  return text.replace(from, () => to);
}

describe('in memory: what the gate declares', () => {
  it('the declared browser matrix is directive §8’s: ar, en, tr × 360×640, 768×1024, 1280×800', () => {
    expect(BROWSER_MATRIX).toEqual({
      locales: ['ar', 'en', 'tr'],
      viewports: [
        { name: 'phone', width: 360, height: 640 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'desktop', width: 1280, height: 800 },
      ],
    });
    expect(browserMatrixProblems(REPO)).toEqual([]);
  });

  it('a matrix without tr, or without the tablet, is refused against the directive floor and against what the browser gate runs', () => {
    const noTr = browserMatrixProblems(REPO, { ...BROWSER_MATRIX, locales: ['ar', 'en'] });
    expect(noTr).toContain('BROWSER_MATRIX drops the locale tr — directive §8 requires ar, en and tr');
    expect(noTr).toContainEqual(expect.stringMatching(/^tests\/browser\/config\.ts runs the locales ar, en, tr — the corrective matrix is ar, en$/));
    const noTablet = browserMatrixProblems(REPO, { ...BROWSER_MATRIX, viewports: BROWSER_MATRIX.viewports.filter((v) => v.name !== 'tablet') });
    expect(noTablet).toContain('BROWSER_MATRIX drops the viewport 768x1024 — directive §8 requires it');
  });

  it('every pending entry is a FAIL: one problem per pending row, none silently dropped', () => {
    const rows: readonly object[] = [...CORRECTIVE_SUITES, ...CORRECTIVE_COMMANDS, SECRET_RANGE_SCAN, ...RED_PROOFS];
    const pending = rows.filter(isPending);
    expect(pendingProblems()).toHaveLength(pending.length);
    for (const p of pending) expect(pendingProblems()).toContainEqual(expect.stringMatching(new RegExp(`^${p.id} \\(`)));
  });

  it('the corrective migrations follow 0069 directly, in order, with no gap', () => {
    CORRECTIVE_MIGRATIONS.forEach((name, i) => expect(name.slice(0, 5)).toBe(`${String(70 + i).padStart(4, '0')}_`));
  });

  it('the red-proof register names each old defect of directive §19', () => {
    expect(RED_PROOFS.map((r) => r.id)).toEqual(['RP-TD16', 'RP-I1', 'RP-TD19', 'RP-TD18', 'RP-SCAN', 'RP-TR', 'RP-TD20']);
  });
});

// ── The tree copies ─────────────────────────────────────────────────────────

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A hard-linked copy of every delivered file, with the installed modules linked in so its runners and scripts can load. */
function cleanCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'p3c-gate-tamper-'));
  temporaries.push(root);
  for (const rel of deliveredFiles(REPO)) {
    const source = join(REPO, rel);
    if (!existsSync(source)) continue; // tracked, deleted in the worktree
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    linkSync(source, target);
  }
  for (const modules of ['node_modules', 'apps/web/node_modules', 'apps/admin/node_modules']) {
    if (existsSync(join(REPO, modules))) symlinkSync(join(REPO, modules), join(root, modules), 'dir');
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

/** The environment of a nested runner: this runner's own worker variables stripped. */
const nestedEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'TEST'));

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Ten minutes, then SIGKILL: a structural half that failed to stop would otherwise start a regression matrix inside this suite. */
function spawn(cmd: string, args: readonly string[], cwd: string): Run {
  const res = spawnSync(cmd, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 600_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...nestedEnv(), FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (res.signal !== null) throw new Error(`${cmd} ${args.join(' ')} was killed (${res.signal})`);
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(ANSI, '') };
}

/** The real gate, pointed at a copy. */
const gate = (root: string): Run => spawn('npx', ['tsx', GATE, '--structural-only', '--root', root], REPO);
/** The copy's own gate script: its `__dirname` makes the copy its root. */
const gateInCopy = (root: string): Run => spawn('npx', ['tsx', join(root, GATE), '--structural-only'], REPO);

const failLines = (r: Run, area: string): string[] => r.output.split('\n').filter((l) => l.includes(`FAIL [${area}]`));

let control: Run | null = null;
const untampered = (): Run => {
  control ??= gate(cleanCheckout());
  return control;
};

describe('the untampered copy', () => {
  it('carries no browser-matrix, red-proof or suite refusal, and every pending entry is a FAIL [pending] that keeps it red', () => {
    const r = untampered();
    expect(r.output, r.output.slice(-4000)).toContain('P3 CORRECTIVE GATE — real-browser matrix (§8)');
    expect(failLines(r, 'browser-matrix')).toEqual([]);
    expect(failLines(r, 'red-proof')).toEqual([]);
    expect(failLines(r, 'suites')).toEqual([]);
    const pending = pendingProblems();
    expect(failLines(r, 'pending')).toHaveLength(pending.length);
    if (pending.length > 0) {
      expect(r.status).not.toBe(0);
      expect(r.output).not.toContain('P3 CORRECTIVE GATE: PASS');
    }
  }, 700_000);
});

describe('F red: missing Turkish (or any locale or viewport) real-browser coverage fails the gate structurally', () => {
  it('F red: tr removed from the browser gate’s LOCALES → FAIL [browser-matrix]', () => {
    const root = cleanCheckout();
    const config = readFileSync(join(REPO, BROWSER_CONFIG), 'utf8');
    rewrite(
      root,
      BROWSER_CONFIG,
      once(config, "export const LOCALES: readonly Locale[] = ['ar', 'en', 'tr'];", "export const LOCALES: readonly Locale[] = ['ar', 'en'];"),
    );
    const r = gate(root);
    expect(failLines(r, 'browser-matrix'), r.output.slice(-3000)).toEqual([
      expect.stringContaining('tests/browser/config.ts runs the locales ar, en — the corrective matrix is ar, en, tr'),
    ]);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('F red: the tablet viewport removed from the browser gate → FAIL [browser-matrix]', () => {
    const root = cleanCheckout();
    const config = readFileSync(join(REPO, BROWSER_CONFIG), 'utf8');
    rewrite(root, BROWSER_CONFIG, once(config, /\n\s*\{ name: 'tablet', width: 768, height: 1024 \},/, ''));
    const r = gate(root);
    expect(failLines(r, 'browser-matrix'), r.output.slice(-3000)).toEqual([
      expect.stringMatching(/tests\/browser\/config\.ts runs the viewports phone:360x640, desktop:1280x800 — the corrective matrix is/),
    ]);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('F red: tr removed from the corrective gate’s own BROWSER_MATRIX → FAIL [browser-matrix]', () => {
    const root = cleanCheckout();
    const source = readFileSync(join(REPO, GATE), 'utf8');
    rewrite(root, GATE, once(source, "  locales: ['ar', 'en', 'tr'],\n  viewports: [\n", "  locales: ['ar', 'en'],\n  viewports: [\n"));
    const r = gateInCopy(root);
    expect(failLines(r, 'browser-matrix'), r.output.slice(-3000)).toEqual([
      expect.stringContaining('BROWSER_MATRIX drops the locale tr — directive §8 requires ar, en and tr'),
      expect.stringContaining('tests/browser/config.ts runs the locales ar, en, tr — the corrective matrix is ar, en'),
    ]);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('F red: the missing-string plant (the untranslated Turkish and Arabic text proof) removed → FAIL [browser-matrix]', () => {
    const root = cleanCheckout();
    const context = readFileSync(join(REPO, RUN_CONTEXT), 'utf8');
    rewrite(
      root,
      RUN_CONTEXT,
      once(
        context,
        "export const PLANTS: readonly Plant[] = ['overflow', 'raw-key', 'console-error', 'missing-string'];",
        "export const PLANTS: readonly Plant[] = ['overflow', 'raw-key', 'console-error'];",
      ),
    );
    const r = gate(root);
    expect(failLines(r, 'browser-matrix'), r.output.slice(-3000)).toEqual([expect.stringContaining('PLANTS lacks missing-string')]);
    expect(r.status).not.toBe(0);
  }, 700_000);
});

describe('E red: a partial secret-history scan fails the gate', () => {
  const FIXTURE_SCRIPT = 'scan:secrets:phase3:fixture';
  const FIXTURE_PROGRAM = 'scripts/fixture-range-scan.ts';

  /** The copy's gate with SECRET_RANGE_SCAN set to `declaration`, and the copy's package.json running `program`. */
  function withScan(declaration: string, program: string | null): string {
    const root = cleanCheckout();
    const source = readFileSync(join(REPO, GATE), 'utf8');
    rewrite(
      root,
      GATE,
      once(
        source,
        /export const SECRET_RANGE_SCAN: CommandEntry \| Pending = \{[\s\S]*?\};/,
        `export const SECRET_RANGE_SCAN: CommandEntry | Pending = ${declaration};`,
      ),
    );
    if (program !== null) {
      const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      pkg.scripts[FIXTURE_SCRIPT] = `tsx ${FIXTURE_PROGRAM}`;
      rewrite(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      rewrite(root, FIXTURE_PROGRAM, program);
    }
    return root;
  }
  const filled = `{ id: 'E-SCAN', blocker: 'E secret scan', npmScript: '${FIXTURE_SCRIPT}', args: [] }`;

  it('E red: no range scan declared (the gitleaks action’s PR window only) → FAIL [secret-scan] and FAIL [pending]', () => {
    const r = gateInCopy(withScan("{ id: 'E-SCAN', blocker: 'E secret scan', pending: 'fixture' }", null));
    expect(failLines(r, 'secret-scan'), r.output.slice(-3000)).toEqual([expect.stringContaining('E-SCAN: no Phase 3 range scan is declared')]);
    expect(failLines(r, 'pending')).toContainEqual(expect.stringContaining('E-SCAN (E secret scan) is not filled: fixture'));
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('E red: a declared scan over the last 30 commits, not from the Phase 3 base → FAIL [secret-scan]', () => {
    const partial = "// fixture: the PR-window scan\nexport const RANGE = 'HEAD~30..HEAD';\n";
    const r = gateInCopy(withScan(filled, partial));
    expect(failLines(r, 'secret-scan'), r.output.slice(-3000)).toEqual([
      expect.stringContaining(`${FIXTURE_PROGRAM} does not derive its range from the Phase 3 base ${PHASE3_BASE}`),
    ]);
    expect(failLines(r, 'pending').some((l) => l.includes('E-SCAN'))).toBe(false);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('the same declaration with a program that starts from the Phase 3 base carries no secret-scan refusal', () => {
    const full = `export const PHASE3_BASE = '${PHASE3_BASE}';\nexport const RANGE = \`\${PHASE3_BASE}..HEAD\`;\n`;
    const r = gateInCopy(withScan(filled, full));
    expect(r.output, r.output.slice(-3000)).toContain('P3 CORRECTIVE GATE — full-range secret scan (§7)');
    expect(failLines(r, 'secret-scan')).toEqual([]);
  }, 700_000);

  it('a base named only in a comment is not a range (in memory)', () => {
    const root = withScan(filled, `// ${PHASE3_BASE}\nexport const RANGE = 'HEAD~30..HEAD';\n`);
    expect(secretScanProblems(root, { id: 'E-SCAN', blocker: 'E secret scan', npmScript: FIXTURE_SCRIPT, args: [] })).toEqual([
      expect.stringContaining('does not derive its range from the Phase 3 base'),
    ]);
  }, 700_000);
});

describe('no silent pass: suites and pending entries', () => {
  const listedRootSuite = (): string => {
    const entry = CORRECTIVE_SUITES.find((e) => !isPending(e) && e.runner === 'root' && e.file !== 'tests/security/p3c-corrective-gate-tamper.test.ts');
    if (entry === undefined || isPending(entry)) throw new Error('no listed root suite');
    return entry.file;
  };

  it('a listed suite that skips → FAIL [suites]', () => {
    const root = cleanCheckout();
    const file = listedRootSuite();
    rewrite(root, file, `${readFileSync(join(REPO, file), 'utf8')}\ndescribe.skip('planted', () => {});\n`);
    const r = gate(root);
    expect(failLines(r, 'suites'), r.output.slice(-3000)).toEqual([expect.stringContaining(`${file} contains describe.skip`)]);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('a listed suite deleted, and an unlisted p3c suite planted → FAIL [suites]', () => {
    const root = cleanCheckout();
    const file = listedRootSuite();
    rmSync(join(root, file));
    rewrite(root, 'tests/security/p3c-planted-unlisted.test.ts', "import { it } from 'vitest';\nit('planted', () => undefined);\n");
    const r = gate(root);
    expect(failLines(r, 'suites'), r.output.slice(-3000)).toEqual([
      expect.stringContaining(`${file} is missing`),
      expect.stringContaining('tests/security/p3c-planted-unlisted.test.ts is a corrective suite no CORRECTIVE_SUITES entry lists'),
    ]);
    expect(r.status).not.toBe(0);
  }, 700_000);

  it('a filled entry turned back into a placeholder → FAIL [pending], never a skip', () => {
    const root = cleanCheckout();
    const source = readFileSync(join(REPO, GATE), 'utf8');
    rewrite(
      root,
      GATE,
      once(
        source,
        "{ id: 'K-01', blocker: 'K TD-14', runner: 'root', file: 'tests/security/p3c-td14-platform-credential.test.ts' },",
        "{ id: 'K-01', blocker: 'K TD-14', pending: 'planted placeholder' },",
      ),
    );
    const r = gateInCopy(root);
    expect(failLines(r, 'pending'), r.output.slice(-3000)).toContainEqual(expect.stringContaining('K-01 (K TD-14) is not filled: planted placeholder'));
    // The suite on disk is then unlisted: the placeholder cannot hide it either.
    expect(failLines(r, 'suites')).toEqual([
      expect.stringContaining('p3c-td14-platform-credential.test.ts is a corrective suite no CORRECTIVE_SUITES entry lists'),
    ]);
    expect(r.status).not.toBe(0);
  }, 700_000);
});

describe('§18: the corrective migration boundary is exact', () => {
  const synthetic = (name: string, header: string): string => `-- ${name}\n-- ${header} — fixture.\nSELECT 1;\n`;
  /** The copy with every declared corrective migration present (the real file where it has landed, a synthetic one otherwise). */
  function withCorrectiveFiles(): string {
    const root = cleanCheckout();
    for (const name of CORRECTIVE_MIGRATIONS)
      if (!existsSync(join(root, MIGRATIONS, name))) rewrite(root, `${MIGRATIONS}/${name}`, synthetic(name, CORRECTIVE_MIGRATION_HEADER));
    return root;
  }

  it('exactly the declared files after 0069, unrecorded, named Phase 3 corrective hardening → no boundary or header refusal', () => {
    const r = gate(withCorrectiveFiles());
    expect(failLines(r, 'boundary'), r.output.slice(-3000)).toEqual([]);
    expect(failLines(r, 'migration')).toEqual([]);
  }, 700_000);

  it('one more file after the declared list → FAIL [boundary]', () => {
    const root = withCorrectiveFiles();
    rewrite(root, `${MIGRATIONS}/0099_planted_extra.sql`, synthetic('0099_planted_extra.sql', CORRECTIVE_MIGRATION_HEADER));
    const r = gate(root);
    expect(failLines(r, 'boundary'), r.output.slice(-3000)).toEqual([
      expect.stringMatching(/are exactly CORRECTIVE_MIGRATIONS .* — found .*0099_planted_extra\.sql$/),
    ]);
  }, 700_000);

  // The candidate tense is asked of boundaryProblems directly, with an empty
  // accepted set, so the premature-freeze refusal stays proven after the
  // corrective freeze fills CORRECTIVE_ACCEPTED.
  it('candidate tense: a corrective migration recorded in the manifest before the gate passed → a boundary problem (premature freeze)', () => {
    const root = withCorrectiveFiles();
    const first = CORRECTIVE_MIGRATIONS[0] ?? '';
    const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8')) as { migrations: { name: string; sha256: string }[] };
    if (!manifest.migrations.some((m) => m.name === first)) manifest.migrations.push({ name: first, sha256: '0'.repeat(64) });
    rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(boundaryProblems(root, {})).toContainEqual(expect.stringContaining(`${first} is in the manifest before the corrective gate passed`));
  });

  it('accepted tense: a corrective migration recorded at a digest other than its accepted one → FAIL [boundary]', () => {
    const root = withCorrectiveFiles();
    const first = CORRECTIVE_MIGRATIONS[0] ?? '';
    const accepted: Readonly<Record<string, string>> =
      Object.keys(CORRECTIVE_ACCEPTED).length > 0 ? CORRECTIVE_ACCEPTED : Object.fromEntries(CORRECTIVE_MIGRATIONS.map((n) => [n, '1'.repeat(64)]));
    const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8')) as { migrations: { name: string; sha256: string }[] };
    manifest.migrations = manifest.migrations.filter((m) => m.name !== first);
    manifest.migrations.push({ name: first, sha256: '0'.repeat(64) });
    rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(boundaryProblems(root, accepted)).toContainEqual(`${first} is not frozen in the manifest at its accepted digest`);
    if (Object.keys(CORRECTIVE_ACCEPTED).length > 0) {
      const r = gate(root);
      expect(failLines(r, 'boundary'), r.output.slice(-3000)).toContainEqual(
        expect.stringContaining(`${first} is not frozen in the manifest at its accepted digest`),
      );
    }
  }, 700_000);

  it('a corrective migration that does not call itself Phase 3 corrective hardening → FAIL [migration]', () => {
    const root = withCorrectiveFiles();
    const last = CORRECTIVE_MIGRATIONS[CORRECTIVE_MIGRATIONS.length - 1] ?? '';
    rewrite(root, `${MIGRATIONS}/${last}`, synthetic(last, 'Phase 4 hardening'));
    const r = gate(root);
    expect(failLines(r, 'migration'), r.output.slice(-3000)).toEqual([expect.stringContaining(`${last}: its leading comment does not name it`)]);
  }, 700_000);
});

describe('the old defects, put back, turn the gate’s web-suite step red', () => {
  /** The exact command of the gate's web-suite step, run inside `root`. */
  const webStep = (root: string): Run => {
    const step = correctivePlan(root).find((s) => s.kind === 'command' && s.area === 'web-suites');
    if (step === undefined || step.kind !== 'command') throw new Error('the corrective plan has no web-suite step');
    return spawn(step.cmd, step.args, root);
  };

  let webControl: Run | null = null;
  const untamperedWeb = (): Run => {
    webControl ??= webStep(cleanCheckout());
    return webControl;
  };

  it('the untampered copy passes the web-suite step', () => {
    const r = untamperedWeb();
    expect(r.status, r.output.slice(-4000)).toBe(0);
    expect(r.output).toMatch(/Test Files\s+\d+ passed/);
  }, 700_000);

  it('TD-19 red: the BFF fix reverted — the BFF forwards no client address, so one web server is one shared allowance → the step fails', () => {
    const root = cleanCheckout();
    const upstream = readFileSync(join(REPO, BFF_UPSTREAM), 'utf8');
    rewrite(
      root,
      BFF_UPSTREAM,
      once(
        upstream,
        '  if (!stampMatches(req.headers.get(EDGE_TOKEN_HEADER))) return {};',
        '  if (req.method !== "") return {}; // planted: the pre-TD-19 BFF\n  if (!stampMatches(req.headers.get(EDGE_TOKEN_HEADER))) return {};',
      ),
    );
    const r = webStep(root);
    expect(r.status, r.output.slice(-4000)).not.toBe(0);
    expect(r.output).toMatch(/FAIL\s+test\/bff-client-address\.test\.ts/);
    expect(untamperedWeb().status).toBe(0);
  }, 700_000);

  it('TD-20 red: the old Adjust Stock model — Starting stock still offered once the opening is posted → the step fails', () => {
    const root = cleanCheckout();
    const model = readFileSync(join(REPO, STOCK_MODEL), 'utf8');
    rewrite(root, STOCK_MODEL, once(model, "  if (openingPosted) return { reasons: ['found', 'missing', 'damaged'], startingRecorded: true };\n", ''));
    const r = webStep(root);
    expect(r.status, r.output.slice(-4000)).not.toBe(0);
    expect(r.output).toMatch(/FAIL\s+test\/starting-stock\.test\.tsx/);
    expect(untamperedWeb().status).toBe(0);
  }, 700_000);
});
