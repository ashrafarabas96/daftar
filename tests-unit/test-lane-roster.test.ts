import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE TEST-LANE ROSTER LAW
 *
 * A test file that no script runs is not a test. It is a claim, and it rots
 * without anyone noticing, because nothing ever fails.
 *
 * This project has learned that the expensive way. `tests/guards/` held one
 * suite — the comparator behind `npm run check:train-heads` — and NO root
 * script named that directory, so the suite shipped and never executed. It was
 * not caught by review. It was caught by asking, of the tree, "which directory
 * holding a `*.test.ts` is named by no script?"
 *
 * So that question is asked here, every run, as a law.
 *
 * WHAT THIS LAW CHECKS, EXACTLY
 *
 * Two sets, compared BOTH ways:
 *
 *   derived  — every root-level directory under `tests/` or `tests-unit/` that
 *              holds at least one `*.test.ts`, read off the disk
 *   recorded — the roster below, which names, per directory, the root script
 *              that runs it
 *
 * A directory on disk with no roster row fails BY NAME. A roster row whose
 * directory is gone fails BY NAME. Equality in one direction only would let a
 * new directory appear in silence, which is the whole defect.
 *
 * For each row it then checks three separate things, because each can rot on
 * its own:
 *
 *   1. the named script EXISTS in the root `package.json`
 *   2. its command text REACHES the directory — either by naming it, or by
 *      naming the vitest config whose `include` covers it
 *   3. the script is REFERENCED by `.github/workflows/ci.yml` or by a gate
 *      script under `scripts/`, so it is not merely runnable by hand
 *
 * Check 3 is the one that matters. A script that exists and names its
 * directory, and that CI never calls, leaves the suite exactly as unrun as no
 * script at all.
 *
 * WHAT IT DOES NOT CHECK — stated so nobody reads it as wider than it is
 *
 *   - Workspace tests (`packages/*`, `apps/*`). Those are run by
 *     `npm test -w <workspace>`, a different mechanism with a different
 *     failure mode. This law is about the ROOT test directories only.
 *   - Whether any test in a directory asserts anything. A directory can be
 *     reached by a script and still be full of vacuous tests. That is a
 *     different law.
 *   - Nesting below the first level. `tests/integration/a/b.test.ts` is
 *     attributed to `tests/integration`, which is how the scripts address it.
 */

const ROOT = resolve(__dirname, '..');

type Row = {
  readonly dir: string;
  /** The root `package.json` script that runs this directory. */
  readonly script: string;
  /**
   * The substring of that script's command which reaches the directory: the
   * directory itself, or the vitest config whose `include` covers it.
   */
  readonly reaches: string;
  /** Why this lane exists, in one line, so a reader need not guess. */
  readonly why: string;
};

const ROSTER: readonly Row[] = [
  {
    dir: 'tests-unit',
    script: 'test:unit',
    reaches: 'vitest.unit.config.ts',
    why: 'the no-database lane: pure functions and source text, runnable on a machine with no PostgreSQL',
  },
  {
    dir: 'tests/integration',
    script: 'test:integration',
    reaches: 'tests/integration',
    why: 'integration and security suites against a live database',
  },
  {
    dir: 'tests/security',
    script: 'test:integration',
    reaches: 'tests/security',
    why: 'security suites, run in the same lane as integration',
  },
  {
    dir: 'tests/guards',
    script: 'test:integration',
    reaches: 'tests/guards',
    // This directory exists on the Phase 4 lineage and not on `main`, so the
    // roster arrived here without a row for it and this law failed by name on
    // the merge that brought the roster in - which is what it is for. The
    // suites are guards over migrations, contracts and money readers; they sit
    // under `tests/**`, so `tests/helpers/global-setup.ts` gives them a live
    // PostgreSQL, which is why the integration lane runs them and the unit
    // lane cannot.
    why: 'Phase 4 guard suites over migrations, contracts and money readers, against a live database',
  },
  {
    dir: 'tests/golden-regression',
    script: 'test:golden',
    reaches: 'tests/golden-regression',
    why: 'golden regression: recorded outputs that must not move',
  },
  {
    dir: 'tests/perf',
    script: 'perf:baseline',
    reaches: 'tests/perf',
    why: 'the performance baseline lane',
  },
  {
    dir: 'tests/performance',
    script: 'perf:phase2:s8',
    reaches: 'tests/performance',
    why: 'the performance budgets composed by the Phase 2 S8 and Phase 3 gates',
  },
];

function scripts(): Readonly<Record<string, string>> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/** Every root-level test directory that actually holds a `*.test.ts`. */
function derivedDirs(): readonly string[] {
  const found = new Set<string>();

  const holdsTest = (dir: string): boolean => {
    let any = false;
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        if (entry === 'node_modules') continue;
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith('.test.ts')) any = true;
      }
    };
    walk(dir);
    return any;
  };

  const unitDir = join(ROOT, 'tests-unit');
  let unitExists = false;
  try {
    unitExists = statSync(unitDir).isDirectory();
  } catch {
    unitExists = false;
  }
  if (unitExists && holdsTest(unitDir)) found.add('tests-unit');

  for (const entry of readdirSync(join(ROOT, 'tests'))) {
    const p = join(ROOT, 'tests', entry);
    if (!statSync(p).isDirectory()) continue;
    if (holdsTest(p)) found.add(`tests/${entry}`);
  }

  return [...found].sort();
}

/** The text of `ci.yml` plus every script under `scripts/`, concatenated. */
function invokerText(): string {
  const parts: string[] = [readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')];
  for (const entry of readdirSync(join(ROOT, 'scripts'))) {
    if (!entry.endsWith('.ts')) continue;
    parts.push(readFileSync(join(ROOT, 'scripts', entry), 'utf8'));
  }
  return parts.join('\n');
}

describe('the test-lane roster', () => {
  it('is not empty, and neither is the tree it reads — so a later zero means something', () => {
    // A law that asserts an absence is worthless until its probe is shown to
    // find things. Both of these are the probe, not the subject.
    expect(ROSTER.length).toBeGreaterThan(0);
    expect(derivedDirs().length).toBeGreaterThan(0);
  });

  it('names every root test directory on disk — a directory nothing runs fails here BY NAME', () => {
    const recorded = new Set(ROSTER.map((r) => r.dir));
    const unrostered = derivedDirs().filter((d) => !recorded.has(d));
    expect(
      unrostered,
      `these root test directories hold a *.test.ts and no roster row claims them, so no script runs them: ` +
        `${unrostered.join(', ')} — a suite nothing runs is a claim, not a test`,
    ).toEqual([]);
  });

  it('names no directory that is gone — a stale row is a lie about coverage', () => {
    const onDisk = new Set(derivedDirs());
    const stale = ROSTER.map((r) => r.dir).filter((d) => !onDisk.has(d));
    expect(stale, `roster rows whose directory no longer holds any test: ${stale.join(', ')}`).toEqual([]);
  });

  it('every rostered script exists in the root package.json', () => {
    const s = scripts();
    const missing = ROSTER.filter((r) => !(r.script in s)).map((r) => `${r.dir} -> ${r.script}`);
    expect(missing, `rostered scripts that the root package.json does not declare: ${missing.join(', ')}`).toEqual([]);
  });

  it("every rostered script's command actually reaches its directory", () => {
    const s = scripts();
    const unreached = ROSTER.filter((r) => !(s[r.script] ?? '').includes(r.reaches)).map((r) => `${r.script} does not mention ${r.reaches} (for ${r.dir})`);
    expect(unreached, unreached.join('; ')).toEqual([]);
  });

  it('every rostered script is REACHED by ci.yml or a gate script, directly or through composition', () => {
    // Being named in `ci.yml` is one route. Composition is another and just as
    // real: `ci.yml` runs `npm test`, and `npm test` ends in
    // `&& npm run test:unit`. Demanding the literal name would have called that
    // lane an orphan while CI ran it on every push — a false alarm, and the
    // kind that gets a law disabled. So the question asked is the true one:
    // starting from what CI and the gates name, can we reach this script by
    // following `npm run <x>` through the root scripts?
    const s = scripts();
    const text = invokerText();

    const reached = new Set<string>(Object.keys(s).filter((name) => text.includes(name)));
    // Transitive closure over `npm run <x>` inside the root script commands.
    for (let grew = true; grew; ) {
      grew = false;
      for (const name of [...reached]) {
        for (const m of (s[name] ?? '').matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
          const next = m[1];
          if (next !== undefined && next in s && !reached.has(next)) {
            reached.add(next);
            grew = true;
          }
        }
      }
    }

    // The probe must find things, or "reached" would be trivially satisfied by
    // nothing and this law would pass on an empty set forever.
    expect(reached.size, 'the reachability probe found no scripts at all').toBeGreaterThan(3);

    const orphans = ROSTER.map((r) => r.script)
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((script) => !reached.has(script))
      .map((script) => `${script} is declared but nothing in ci.yml or scripts/*.ts reaches it, directly or by composition`);
    expect(orphans, orphans.join('; ')).toEqual([]);
  });

  it('the unit lane is composed into `npm test`, which is the step CI runs', () => {
    // `ci.yml` runs `npm test`. A `test:unit` script that exists and is not in
    // that chain is run by nobody, which is the defect this card closes.
    const chain = scripts()['test'] ?? '';
    expect(chain, 'the root `test` script must compose `test:unit`, or the no-database lane never runs in CI').toContain('test:unit');
  });
});
