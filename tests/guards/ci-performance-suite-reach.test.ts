/**
 * CI-SPEED law: every performance suite must be REACHABLE from a CI entry
 * point — and reachability is asked transitively, not by name.
 *
 * Why this law exists at all. `package.json`'s `test:integration` runs whole
 * DIRECTORIES (`vitest run tests/integration tests/security tests/guards`), so
 * a new file dropped into any of those three is picked up by CI the moment it
 * is committed. `tests/performance` is deliberately NOT in that list: its
 * suites are expensive and are invoked one at a time, so that a slice gate can
 * own its own step, report its own budget line and be ratcheted on its own.
 * The price of that isolation is the failure mode this law closes: a new file
 * under `tests/performance/` runs NOWHERE, and nothing says so. It is not a
 * red test, not a skipped test and not a warning — the suite simply never
 * executes, and the green tick that follows means less than a reader thinks.
 * That is the worst class of defect in this repository: evidence that reads as
 * stronger than it is.
 *
 * Why the question is transitive reach and NOT "is the file named in ci.yml".
 * Measured on `main` @ c079a2df: of 12 tracked performance suites, 6 are named
 * literally in `.github/workflows/ci.yml` and 6 are not — yet three of those
 * six DO execute on the runner, through gate scripts that CI invokes by name
 * (`scripts/phase2-s7-gate.ts` runs accounting-read-plans;
 * `scripts/phase3-s8-gate.ts` runs phase3-s8-budgets; both were observed
 * running in run 43073393847), and a fourth executes in a different workflow
 * (`.github/workflows/phase2-s8-evidence.yml`). A law that demanded the name
 * appear in `ci.yml` would therefore be born with three false failures, and a
 * false failure is how a law gets disabled. So the law walks the graph:
 * workflows -> npm scripts -> gate scripts -> suites, to a fixpoint.
 *
 * What it refuses to do. It does not add a step, does not run anything, and
 * does not decide that an unreached suite OUGHT to run — whose suite it is
 * decides that. It refuses the tree and names the file, which is the whole of
 * its job.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

/** Every tracked-ish file under `dir`, as repo-relative posix paths. */
function walk(dir: string, acc: string[] = [], base = ''): string[] {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(REPO + dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const rel = (base ? base + '/' : '') + e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(dir + '/' + e.name, acc, rel);
    } else {
      acc.push(dir + '/' + e.name);
    }
  }
  return acc;
}

/**
 * Comments cannot reach anything. YAML has one comment form; TypeScript and
 * JavaScript have two. Nothing clever is attempted for a `#` or `//` inside a
 * string literal: treating a little real code as a comment can only make this
 * law stricter (fewer references found, so more suites reported), and a law
 * that errs toward refusing the tree is the one you can trust.
 */
export function stripComments(name: string, text: string): string {
  if (/\.(ya?ml)$/.test(name)) {
    return text
      .split('\n')
      .map((l) => (/^\s*#/.test(l) ? '' : l.replace(/\s#.*$/, '')))
      .join('\n');
  }
  if (/\.(ts|tsx|cjs|mjs|js)$/.test(name)) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  }
  if (/\.sh$/.test(name)) {
    return text
      .split('\n')
      .map((l) => (/^\s*#/.test(l) ? '' : l))
      .join('\n');
  }
  return text;
}

/**
 * The resolver, kept pure so that its negative control can be a fixture and
 * not a plant on disk: a plant that fails to apply reads as a pass (DR-55).
 *
 * `files` maps a repo-relative posix path to its text. `scripts` maps an npm
 * script name to its command line. `entryPoints` are the files CI itself
 * starts from. A file is reached when some reached text names it, or when some
 * reached text runs a directory that contains it, or when a reached text runs
 * an npm script whose command does either of those.
 */
export function computeReach(input: { files: Map<string, string>; scripts: Map<string, string>; entryPoints: string[]; dirs: Set<string> }): {
  reached: Set<string>;
  via: Map<string, string>;
} {
  const { files, scripts, entryPoints, dirs } = input;
  const reached = new Set<string>(entryPoints);
  const via = new Map<string, string>();
  for (const e of entryPoints) via.set(e, 'CI entry point');

  // Texts whose outgoing references have not been followed yet. An npm script's
  // command line is a text in its own right, named `npm:<script>`.
  const frontier: Array<{ name: string; text: string }> = entryPoints.map((p) => ({
    name: p,
    text: files.get(p) ?? '',
  }));

  const mark = (target: string, from: string) => {
    if (reached.has(target)) return;
    reached.add(target);
    via.set(target, from);
    // A JSON manifest does not execute. This is not pedantry: a workflow names
    // `package.json` for a cache key, and if that made its whole body an
    // executable text then `"perf:phase2:s8": "vitest run tests/performance"`
    // would sweep every performance suite in as "reached" — measured, that is
    // exactly what happened to the first version of this law, and it turned it
    // green on a tree where the sweep runs nowhere. The repository already
    // states the same truth in its own sealed words at
    // `scripts/phase4-s4-gate.ts`: "`perf:phase2:s8` covers the whole
    // directory and no step of any job runs it". A script's body becomes a
    // text only when something actually says `npm run <script>`.
    if (/\.json$/.test(target)) return;
    const text = files.get(target);
    if (text !== undefined) frontier.push({ name: target, text });
  };

  // Paths are read out of a text as TOKENS, not by asking `text.includes(p)`
  // for every known path. Two reasons, and the first is correctness: a
  // substring test lets a long path drag a shorter one in with it, so naming
  // `tests/performance/a-budgets.test.ts` would also "reach" a file called
  // `performance/a-budgets.test.ts` if one existed. The second is cost: this
  // suite runs inside the integration step, and substring-testing every path
  // against every text is quadratic in a tree of this size.
  const PATH_TOKEN = /[A-Za-z0-9_@./-]*[A-Za-z0-9_-](?:\.(?:ts|tsx|yml|yaml|json|sh|cjs|mjs))/g;
  const DIR_TOKEN = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+/g;

  while (frontier.length > 0) {
    const item = frontier.pop();
    if (item === undefined) break;
    const { name, text } = item;
    // A COMMENT IS NOT REACH. This is the difference between a law and a
    // rubber stamp here: `ci.yml` discusses its own suites at length, and one
    // of those very comments says "covering `tests/performance` and nothing
    // runs it". Count prose as a reference and every suite is reached by the
    // sentence explaining that nothing reaches it — the law would be green
    // forever and no one would know. So references are read from code only.
    const code = stripComments(name, text);
    for (const line of code.split('\n')) {
      // 1) direct references, by path token — but WHO names it matters.
      //
      // Measured while writing this law: with any code mention counting as a
      // reference, the two frozen candidate suites came out "reached", because
      // `tests/security/archive-portability.test.ts` lists their paths as data
      // for a portability assertion. Listing a path is not running it, and a
      // law that accepts it would report every suite as wired the moment some
      // test enumerated the directory — green, and worthless.
      //
      // So: a workflow, an npm script line and anything under `scripts/` exist
      // in order to run things, and any path they name in code is taken as a
      // reference. A TEST file is different: it is full of paths it reasons
      // about, so it reaches a suite only by importing it or by naming it on a
      // runner's command line.
      const orchestrator = name.startsWith('.github/workflows/') || name.startsWith('scripts/') || name.startsWith('npm:');
      const executes = /\b(?:vitest|jest|tsx|npx|node|execFileSync|execSync|spawnSync|spawn)\b/.test(line);
      const imports = /\b(?:import|require|from)\b/.test(line);
      if (orchestrator || executes || imports) {
        for (const token of line.match(PATH_TOKEN) ?? []) {
          const candidate = token.replace(/^\.\//, '');
          if (candidate !== name && files.has(candidate)) mark(candidate, name);
        }
        // A TypeScript import carries no extension and is relative to the
        // importing file: `import { testTitles } from './phase3-s8-gate'` is
        // how the corrective gate reaches the S8 gate, and a law that only
        // understood full paths called that gate unreached while the runner
        // was plainly running it (measured: run 43073393847).
        for (const m of line.matchAll(/from\s+'(\.[^']+)'|require\('(\.[^']+)'\)/g)) {
          const spec = m[1] ?? m[2];
          if (!spec) continue;
          const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
          const parts = (dir ? dir + '/' + spec : spec).split('/');
          const stack: string[] = [];
          for (const p of parts) {
            if (p === '.' || p === '') continue;
            if (p === '..') stack.pop();
            else stack.push(p);
          }
          const resolvedBase = stack.join('/');
          for (const suffix of ['.ts', '.tsx', '/index.ts', '']) {
            const candidate = resolvedBase + suffix;
            if (files.has(candidate)) {
              mark(candidate, name);
              break;
            }
          }
        }
      }
      // 2) a directory runner reaches everything under that directory. Only
      // vitest sweeps directories in this repository (`package.json`'s
      // `test:integration`), so the sweep is read off a vitest command line
      // and nowhere else; a new runner would make this law red, which is the
      // safe direction.
      if (!/vitest/.test(line)) continue;
      for (const token of line.match(DIR_TOKEN) ?? []) {
        const dir = token.replace(/^\.\//, '').replace(/\/$/, '');
        if (!dirs.has(dir)) continue;
        for (const candidate of files.keys()) {
          if (candidate.startsWith(dir + '/')) mark(candidate, `${name} (directory ${dir})`);
        }
      }
    }
    // 3) `npm run <script>` / `npm <script>` pulls that script's command in
    for (const [script, command] of scripts) {
      const re = new RegExp(`npm (?:run |run-script )?${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'"\`&;])`);
      // `code`, never `text`: measured, reading the raw text here let
      // ci.yml's own comment — "`perf:phase2:s8` is the only script …" —
      // pull that script's directory sweep in and turn this law green.
      //
      // The second form is how a gate script spawns another gate:
      // `args: ['run', 'gate:phase3:s8']` (phase3-corrective-gate.ts:482).
      // There is no `npm run …` string anywhere in that line, so only the
      // quoted script name gives it away. Restricted to names that carry a
      // colon, because `'build'` or `'test'` appear quoted in unrelated code
      // and would hand out reach for free.
      // And the third problem, measured: `scripts/test-census.ts` carries the
      // line `command: 'npm run perf:phase2:s8 and npm run perf:baseline
      // (need PostgreSQL)'` — a sentence ABOUT two commands, stored as data
      // for a census report. Read at file scope it pulled `perf:phase2:s8`,
      // whose body is `vitest run tests/performance`, and that one data string
      // swept every performance suite in as reached — the law went green again
      // on a tree where, in the repository's own sealed words, "no step of any
      // job runs it". So a WORKFLOW may say `npm run X` in prose-free YAML and
      // be believed, while a SCRIPT must look like it is actually spawning:
      // an exec call, or the `['run', '<script>']` argument array.
      const quotedName = new RegExp(`['"\`]${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
      const isWorkflow = name.startsWith('.github/workflows/') || name.startsWith('npm:');
      let pulled = false;
      for (const line of code.split('\n')) {
        if (isWorkflow) {
          if (re.test(line)) pulled = true;
        } else {
          const spawning = /\b(?:execFileSync|execSync|spawnSync|spawn|exec)\b/.test(line) || /'run'\s*,/.test(line);
          if (spawning && (re.test(line) || (script.includes(':') && quotedName.test(line)))) pulled = true;
        }
        if (pulled) break;
      }
      if (pulled && !reached.has(`npm:${script}`)) {
        reached.add(`npm:${script}`);
        via.set(`npm:${script}`, name);
        frontier.push({ name: `npm:${script}`, text: command });
      }
    }
  }
  return { reached, via };
}

/**
 * Suites that are deliberately not reached. Each entry needs a reason and the
 * decision it rests on; an exemption without one is the blindness this law was
 * written against, wearing the law's own clothes.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'tests/performance/accounting-correction-candidate.test.ts',
    why: 'the frozen correction candidate: kept in the tree as the record of a rejected design, frozen by owner decision, and deliberately wired to no step',
  },
  {
    file: 'tests/performance/accounting-trial-balance-diagnosis.test.ts',
    why: 'the diagnosis that produced the candidate above; a one-off measurement in test clothing, which is read rather than run, and is kept for the same reason',
  },
];

export function realTree() {
  const files = new Map<string, string>();
  for (const p of [...walk('.github/workflows'), ...walk('scripts'), ...walk('tests'), 'package.json']) {
    if (!/\.(ya?ml|ts|json|cjs|mjs|sh)$/.test(p)) continue;
    try {
      files.set(p, readFileSync(REPO + p, 'utf8'));
    } catch {
      /* unreadable files cannot reach anything, and are not the subject here */
    }
  }
  const pkg = JSON.parse(files.get('package.json') ?? '{}') as {
    scripts?: Record<string, string>;
  };
  const scripts = new Map<string, string>(Object.entries(pkg.scripts ?? {}));
  const entryPoints = [...files.keys()].filter((p) => p.startsWith('.github/workflows/'));
  const dirs = new Set<string>();
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, scripts, entryPoints, dirs };
}

describe('every performance suite is reachable from a CI entry point', () => {
  const tree = realTree();
  const { reached, via } = computeReach(tree);
  const suites = [...tree.files.keys()].filter((p) => p.startsWith('tests/performance/') && p.endsWith('.test.ts'));

  it('the probe is sighted: it finds the tree, its entry points and its suites', () => {
    // Without this, every assertion below could be passing on an empty set —
    // the silent false positive this repository has been bitten by (RULE-11).
    expect(tree.entryPoints.length).toBeGreaterThan(0);
    expect(suites.length).toBeGreaterThan(5);
    expect(tree.scripts.get('test:integration')).toBeDefined();
  });

  it('reach is transitive: suites invoked only by a gate script count as reached', () => {
    // Measured on the runner (run 43073393847): both of these execute, and
    // NEITHER is named in ci.yml. If this test ever fails, the resolver has
    // regressed to asking about literal naming, and the law below would start
    // failing trees that are perfectly well wired.
    const transitive = ['tests/performance/accounting-read-plans.test.ts', 'tests/performance/phase3-s8-budgets.test.ts'];
    for (const suite of transitive) {
      expect(tree.files.has(suite), `${suite} is missing from the tree`).toBe(true);
      expect(reached.has(suite), `${suite} was not reached: ${via.get(suite) ?? 'nothing'}`).toBe(true);
      const ciYml = tree.files.get('.github/workflows/ci.yml') ?? '';
      expect(ciYml.includes(suite), `${suite} is named in ci.yml, so it is a weak witness`).toBe(false);
    }
  });

  it('no performance suite runs nowhere', () => {
    const unreached = suites.filter((s) => !reached.has(s) && !EXEMPT.some((e) => e.file === s));
    expect(
      unreached,
      'these suites are in the tree and no CI entry point reaches them: either wire each one to a step (its own lane decides that) or declare it in EXEMPT with its reason',
    ).toEqual([]);
  });

  it('every exemption is live and honest', () => {
    for (const e of EXEMPT) {
      expect(tree.files.has(e.file), `stale exemption: ${e.file} is not in the tree`).toBe(true);
      expect(reached.has(e.file), `${e.file} is exempted as unreached, but something does reach it: ${via.get(e.file)}`).toBe(false);
      expect(e.why.length, `exemption for ${e.file} carries no reason`).toBeGreaterThan(40);
    }
  });
});

describe('the resolver itself, on fixtures (the negative controls)', () => {
  const base = () => ({
    files: new Map<string, string>([
      ['.github/workflows/ci.yml', 'run: npx tsx scripts/gate.ts\nrun: npm run test:integration\n'],
      ['scripts/gate.ts', "execFileSync('npx', ['vitest', 'run', 'tests/performance/named.test.ts'])"],
      ['tests/performance/named.test.ts', ''],
      ['tests/performance/orphan.test.ts', ''],
      ['tests/guards/swept.test.ts', ''],
      ['package.json', '{}'],
    ]),
    scripts: new Map<string, string>([['test:integration', 'vitest run tests/guards']]),
    entryPoints: ['.github/workflows/ci.yml'],
    dirs: new Set<string>(['.github/workflows', 'scripts', 'tests', 'tests/performance', 'tests/guards']),
  });

  it('red: a suite nothing names is reported as unreached', () => {
    const { reached } = computeReach(base());
    expect(reached.has('tests/performance/orphan.test.ts')).toBe(false);
  });

  it('green: a suite named only by a gate script is reached', () => {
    const { reached, via } = computeReach(base());
    expect(reached.has('tests/performance/named.test.ts')).toBe(true);
    expect(via.get('tests/performance/named.test.ts')).toBe('scripts/gate.ts');
  });

  it('green: a directory runner behind an npm script reaches what is under it', () => {
    const { reached, via } = computeReach(base());
    expect(reached.has('tests/guards/swept.test.ts')).toBe(true);
    expect(via.get('tests/guards/swept.test.ts')).toContain('directory tests/guards');
  });

  it('red: a comment naming the orphan does not reach it', () => {
    const fixture = base();
    fixture.files.set(
      '.github/workflows/ci.yml',
      [
        '# the suite tests/performance/orphan.test.ts is discussed here, and',
        '# this very sentence must not be what makes it look wired',
        'run: npx tsx scripts/gate.ts',
        'run: npm run test:integration',
      ].join('\n'),
    );
    const { reached } = computeReach(fixture);
    expect(reached.has('tests/performance/orphan.test.ts')).toBe(false);
    // and the sighted half: the same fixture still reaches what code names
    expect(reached.has('tests/performance/named.test.ts')).toBe(true);
  });

  it('red: a directory named only in prose does not sweep', () => {
    const fixture = base();
    fixture.files.set('.github/workflows/ci.yml', '# covering tests/performance and nothing runs it\nrun: npx tsx scripts/gate.ts\n');
    const { reached } = computeReach(fixture);
    expect(reached.has('tests/performance/orphan.test.ts')).toBe(false);
  });

  it('red: a near-miss directory name does not sweep anything in', () => {
    const fixture = base();
    fixture.scripts.set('test:integration', 'vitest run tests/guardsomething');
    const { reached } = computeReach(fixture);
    expect(reached.has('tests/guards/swept.test.ts')).toBe(false);
  });
});
