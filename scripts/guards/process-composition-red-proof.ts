#!/usr/bin/env tsx
/**
 * TL-P4-S3-R5 — THE PLANTED-DEFECT PROOF OF THE PROCESS COMPOSITION GUARD.
 * `npm run proof:composition:red`
 *
 * «A planted-defect proof that cannot be shown failing is not a proof.»
 *
 * So this script does not describe a plant. It PLANTS, in the working tree
 * the guard actually reads, runs the real suite, and requires a non-zero exit
 * status and the specific violation line. Two plants, one per required red
 * case of the ruling:
 *
 *   P5  AN UNATTACHED CONTROLLER. A real `@Controller()` class is written
 *       into `apps/api/src/`, registered by no module. Every reflected list
 *       still agrees with every other reflected list, which is exactly why
 *       the old one-directional containment passed it.
 *   P6  A WRONG-PROCESS CONTROLLER. A real merchant controller is registered
 *       in the PLATFORM runtime. Both lists still agree; only the
 *       authoritative process composition disagrees.
 *
 * ── WHY THE PLANT IS IN THE REAL TREE AND NOT IN A COPY ─────────────────
 *
 * `[[daftar-the-plant-must-land-where-the-check-looks]]`. This repository has
 * already shipped a planted-root proof that copied a directory first, so the
 * plant landed in the copy and the check under proof never saw it; the proof
 * was green either way and isolated nothing. The guard resolves
 * `apps/api/src` from its own `__dirname`, so the plant goes exactly there,
 * and `restore()` puts the tree back and then PROVES it did, by comparing
 * every touched path against the exact bytes — or the absence — recorded
 * before the first plant. T-11 (`tests/security/archive-portability.test.ts`)
 * forbids a tool under `scripts/**` from needing a repository, and a byte
 * comparison is the better witness regardless: it also catches a leftover
 * plant on a path the repository would ignore.
 *
 * ── WHY THE VERDICT IS NEVER READ THROUGH A PIPE ────────────────────────
 *
 * DAFTAR's runner has exited 0 over four failing tests, and a shell
 * pipeline's exit status is its LAST stage's. Every run below is
 * `spawnSync(... stdio: 'pipe')` with the verdict read off `r.status`,
 * `r.signal` and `r.error` of the RESULT OBJECT. `stdio: 'pipe'` captures the
 * child's output into that object; no shell, no `|`, no `tee`.
 *
 * ── BOTH HALVES ─────────────────────────────────────────────────────────
 *
 * A proof that the guard can say no is worthless without the proof that it
 * can say yes. The untouched tree is run FIRST and must be green, and again
 * after each restore. A guard that is always red proves nothing at all.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SUITE = 'tests/integration/process-composition.test.ts';
const VITEST = join(ROOT, 'node_modules/.bin/vitest');

/** The unattached plant: a real controller, in the production tree, that no module composes. */
const UNATTACHED_FILE = 'apps/api/src/modules/platform/composition-red-proof.controller.ts';
const UNATTACHED_CLASS = 'CompositionRedProofUnattachedController';
const UNATTACHED_SOURCE = `import { Controller, Get } from '@nestjs/common';

/** PLANTED by scripts/guards/process-composition-red-proof.ts. Deleted by the same run. */
@Controller('v1/__composition_red_proof__')
export class ${UNATTACHED_CLASS} {
  @Get()
  probe(): { readonly planted: true } {
    return { planted: true };
  }
}
`;

/** The wrong-process plant: a merchant controller registered in the platform runtime. */
const PLATFORM_MODULE = 'apps/api/src/app/platform-api.module.ts';
const WRONG_PROCESS_CLASS = 'CatalogController';
const IMPORT_ANCHOR = `import { AuthController } from '../modules/auth/auth.controller';`;
const IMPORT_PLANT = `${IMPORT_ANCHOR}\nimport { ${WRONG_PROCESS_CLASS} } from '../modules/catalog/catalog.controller';`;
const LIST_ANCHOR = `controllers: [AuthController, AdminController, HealthController],`;
const LIST_PLANT = `controllers: [AuthController, AdminController, HealthController, ${WRONG_PROCESS_CLASS}],`;

interface Run {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly output: string;
}

/** One bounded Vitest run over the suite. The verdict is the RESULT OBJECT's, never a pipeline's. */
function runSuite(): Run {
  const r: SpawnSyncReturns<string> = spawnSync(VITEST, ['run', SUITE], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15 * 60 * 1000,
    env: { ...process.env, CI: '1' },
  });
  return {
    status: r.status,
    signal: r.signal,
    error: r.error === undefined ? null : r.error.message,
    output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

const verdict = (r: Run): string =>
  r.error !== null ? `did not start (${r.error})` : r.signal !== null ? `killed by ${r.signal}` : `exited ${r.status === null ? 'unknown' : r.status}`;

const failures: string[] = [];
const note = (line: string): void => {
  console.log(line);
};

function requireGreen(when: string): void {
  const r = runSuite();
  note(`     untouched tree (${when}): the guard ${verdict(r)}`);
  if (r.status !== 0 || r.signal !== null || r.error !== null)
    failures.push(
      `the guard is NOT green on the untouched tree (${when}): it ${verdict(r)} — a planted-defect proof against an already-red guard proves nothing`,
    );
}

function requireRed(id: string, expected: readonly string[]): void {
  const r = runSuite();
  note(`     ${id}: the guard ${verdict(r)}`);
  if (r.error !== null) {
    failures.push(`${id}: the guard did not start (${r.error}) — a run that never happened is not a red`);
    return;
  }
  if (r.signal !== null) {
    failures.push(`${id}: the guard was killed by ${r.signal} — a signal is not a refusal`);
    return;
  }
  if (r.status === 0) {
    failures.push(`${id}: the guard exited 0 over a planted defect — it does not refuse what it claims to refuse`);
    return;
  }
  for (const fragment of expected)
    if (!r.output.includes(fragment))
      failures.push(
        `${id}: the guard refused the tree but never named the planted defect — its output does not contain «${fragment}», so the red may be some other failure`,
      );
  const head = r.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bP[236]: \w*Controller\b/.test(l))
    .slice(0, 4);
  for (const line of head) note(`       ↳ ${line}`);
}

/** Every path a plant may touch, and what it held before any plant: its exact bytes, or `null` for "did not exist". */
type Snapshot = Readonly<Record<string, string | null>>;

const stateOf = (file: string): string | null => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : null);
const snapshot = (files: readonly string[]): Snapshot => Object.fromEntries(files.map((f) => [f, stateOf(f)]));

/**
 * The restoration witness.
 *
 * NOT `git status`: T-11 (`tests/security/archive-portability.test.ts`) is
 * right that a tool under `scripts/**` must still work where there is no
 * repository — the release gate runs again inside the extracted archive — and
 * a byte comparison is the stronger witness anyway. `git status` would say
 * nothing about a leftover plant on an ignored path, and nothing at all in a
 * checkout with no `.git`. This compares every touched path against the
 * bytes (or the absence) recorded before the first plant.
 */
function restore(apply: () => void, before: Snapshot, label: string): void {
  apply();
  for (const [file, was] of Object.entries(before)) {
    const now = stateOf(file);
    if (now === was) continue;
    failures.push(
      was === null
        ? `${label}: ${file} was planted and still exists — the tree was NOT restored`
        : `${label}: ${file} does not hold the bytes it held before the plant — the tree was NOT restored`,
    );
  }
}

function patch(file: string, replacements: readonly (readonly [string, string])[]): void {
  const path = join(ROOT, file);
  let text = readFileSync(path, 'utf8');
  for (const [from, to] of replacements) {
    const occurrences = text.split(from).length - 1;
    if (occurrences !== 1) throw new Error(`${file}: the anchor «${from}» occurs ${occurrences} times — the plant cannot be placed or unplaced unambiguously`);
    text = text.replace(from, to);
  }
  writeFileSync(path, text);
}

function main(): void {
  if (!existsSync(VITEST)) {
    console.error(
      `FAIL proof:composition:red — ${VITEST} does not exist. A git worktree has no node_modules/.bin; run this in a checkout with dependencies installed.`,
    );
    process.exit(1);
  }
  if (existsSync(join(ROOT, UNATTACHED_FILE))) {
    console.error(`FAIL proof:composition:red — ${UNATTACHED_FILE} already exists; a previous run did not restore the tree. Remove it and re-run.`);
    process.exit(1);
  }

  console.log(`proof:composition:red — planting against ${SUITE}`);
  // Taken over BOTH touched paths before anything is planted, so a plant that
  // leaked into the other file is caught by the other plant's restore too.
  const before = snapshot([UNATTACHED_FILE, PLATFORM_MODULE]);
  requireGreen('before any plant');

  // ── P5: THE UNATTACHED CONTROLLER ──────────────────────────────────────
  note(`  P5 planting an unattached @Controller at ${UNATTACHED_FILE}`);
  writeFileSync(join(ROOT, UNATTACHED_FILE), UNATTACHED_SOURCE);
  try {
    requireRed('P5 (planted unattached controller)', [
      `P3: ${UNATTACHED_CLASS} (${UNATTACHED_FILE}) exists only as a file`,
      `P2: ${UNATTACHED_CLASS} (${UNATTACHED_FILE}) is composed in no production process`,
    ]);
  } finally {
    restore(
      () => {
        rmSync(join(ROOT, UNATTACHED_FILE), { force: true });
      },
      before,
      'P5',
    );
  }
  requireGreen('after the P5 plant was removed');

  // ── P6: THE WRONG-PROCESS CONTROLLER ───────────────────────────────────
  note(`  P6 planting ${WRONG_PROCESS_CLASS} into the platform runtime (${PLATFORM_MODULE})`);
  const original = readFileSync(join(ROOT, PLATFORM_MODULE), 'utf8');
  try {
    patch(PLATFORM_MODULE, [
      [IMPORT_ANCHOR, IMPORT_PLANT],
      [LIST_ANCHOR, LIST_PLANT],
    ]);
    requireRed('P6 (planted wrong-process controller)', [`P6: ${WRONG_PROCESS_CLASS} is registered in production process platform-api`]);
  } finally {
    restore(
      () => {
        writeFileSync(join(ROOT, PLATFORM_MODULE), original);
      },
      before,
      'P6',
    );
  }
  requireGreen('after the P6 plant was reverted');

  if (failures.length === 0) {
    console.log(
      `PASS proof:composition:red: the guard is green on this tree, goes RED on a planted unattached controller and on a planted wrong-process controller, and the tree is restored`,
    );
    process.exit(0);
  }
  console.error(`FAIL proof:composition:red: ${failures.length} problem(s)\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

if (require.main === module) main();
