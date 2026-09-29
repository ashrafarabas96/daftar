/**
 * T-11 · A TEST THAT CALLS `git` MUST STILL RUN WHERE THERE IS NO GIT.
 *
 * The release gate runs a second time inside the extracted release archive,
 * which has no `.git` and none reachable above it (contract §3.2). The third
 * P2-S9 release run failed there on `fatal: not a git repository` in one
 * suite, and P3-S8 reintroduced the same call in two more (A-11, finding F-3).
 * This file makes the class permanent: every `git` invocation under `tests/**`
 * and `scripts/**` either sits on a path that has a fallback, or is in one of
 * the five tools that legitimately need a repository.
 *
 * A call has a fallback when
 *   - the function it sits in (or, at top level, the file) carries a
 *     `DELIVERY_MANIFEST.json` branch — the archive's own inventory, as in
 *     `tests/helpers/delivered-files.ts`; or
 *   - it sits in the `try` block of a `try`/`catch` whose `catch` does not
 *     merely rethrow, as in `tests/performance/accounting-budgets.test.ts`.
 *     `spawn`/`spawnSync` never throw when git exits non-zero, so a `try`
 *     around them is not a fallback.
 *
 * Suites reach git through `tests/helpers/delivered-files.ts`; importing the
 * helper does not excuse a bare call elsewhere in the same file.
 *
 * The scan parses each file with the TypeScript compiler, so comments, test
 * titles and fixture strings (like the ones below) are not calls. It reads
 * the file system only: this file itself runs inside the archive.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../..');

/** The scanned trees. */
const SCANNED = ['tests', 'scripts'] as const;

/** Tools that need a repository by design (contract §7 T-11). Exactly these five. */
const REPOSITORY_TOOLS: readonly string[] = [
  'scripts/export-release.ts',
  'scripts/phase1-release-gate.ts',
  'scripts/phase2-s8-binding.ts',
  'scripts/phase2-s8-evidence.ts',
  'scripts/phase2-rollback-rehearsal.ts',
];

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const CHILD_PROCESS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
const NON_THROWING = new Set(['spawn', 'spawnSync']);
const DELIVERY_MANIFEST = 'DELIVERY_MANIFEST.json';

type Guard = 'delivery-manifest' | 'try-catch' | null;

interface GitCall {
  readonly file: string;
  readonly line: number;
  readonly callee: string;
  readonly guard: Guard;
}

/** Every source file under the scanned trees of `root`, relative, `/`-separated. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE.test(name)) out.push(relative(root, path).split(sep).join('/'));
    }
  };
  for (const top of SCANNED) {
    const dir = join(root, top);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) walk(dir);
  }
  return out.sort();
}

/** The literal text of a string-like expression, or null. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => ` ${span.literal.text}`).join('');
  return null;
}

/** Does `text`, as a command or an executable, run git? */
const namesGit = (text: string): boolean => /(?:^|\/)git$/.test(text.trim());
const commandRunsGit = (text: string): boolean => namesGit(text) || /(?:^|[\s;&|(])git(?:\s|$)/.test(text);

function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return expression.getText();
}

/** The nearest enclosing function-like node, or the file at top level. */
function enclosingScope(node: ts.Node): ts.Node {
  for (let at = node.parent; at !== undefined; at = at.parent) if (ts.isFunctionLike(at)) return at;
  return node.getSourceFile();
}

/** Is `node` in the try block of a try/catch whose catch does something other than rethrow? */
function inFallbackTry(node: ts.Node): boolean {
  for (let child: ts.Node = node, at = node.parent; at !== undefined; child = at, at = at.parent) {
    if (ts.isFunctionLike(at)) return false;
    if (ts.isTryStatement(at) && child === at.tryBlock && at.catchClause !== undefined) {
      const statements = at.catchClause.block.statements;
      if (statements.length > 0 && statements.every((s) => ts.isThrowStatement(s))) continue;
      return true;
    }
  }
  return false;
}

function guardOf(node: ts.Node, callee: string): Guard {
  if (enclosingScope(node).getText().includes(DELIVERY_MANIFEST)) return 'delivery-manifest';
  if (!NON_THROWING.has(callee) && inFallbackTry(node)) return 'try-catch';
  return null;
}

/** Every git invocation in one source text. */
function gitCalls(file: string, text: string): GitCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // `const GIT = 'git'` — a name that is git wherever it is passed.
  const gitNames = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const value = literalText(node.initializer);
      if (value !== null && namesGit(value)) gitNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const out: GitCall[] = [];
  const record = (node: ts.Node, callee: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    out.push({ file, line, callee, guard: guardOf(node, callee) });
  };
  const visit = (node: ts.Node): void => {
    const first = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (ts.isCallExpression(node) && first !== undefined) {
      const callee = calleeName(node.expression);
      const value = literalText(first);
      const isGit =
        (value !== null && (CHILD_PROCESS.has(callee) ? commandRunsGit(value) : namesGit(value))) || (ts.isIdentifier(first) && gitNames.has(first.text));
      if (isGit) record(node, callee);
    } else if (ts.isTaggedTemplateExpression(node)) {
      const value = literalText(node.template);
      if (value !== null && /^\s*git\s/.test(value)) record(node, calleeName(node.tag));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Every git invocation under the scanned trees of `root`. */
function scan(root: string): GitCall[] {
  return sourceFiles(root).flatMap((file) => gitCalls(file, readFileSync(join(root, file), 'utf8')));
}

/** The calls outside the repository tools that have no fallback, as findings. */
function problems(calls: readonly GitCall[]): string[] {
  return calls
    .filter((call) => call.guard === null && !REPOSITORY_TOOLS.includes(call.file))
    .map((call) => `${call.file}:${call.line} ${call.callee}(git …) has no ${DELIVERY_MANIFEST} branch and no try/catch fallback`);
}

const fixture = (text: string): GitCall[] => gitCalls('tests/security/planted.test.ts', text);

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe('the tools that need a repository', () => {
  it('are exactly the five of the contract, each present and each invoking git', () => {
    expect([...REPOSITORY_TOOLS].sort()).toEqual([
      'scripts/export-release.ts',
      'scripts/phase1-release-gate.ts',
      'scripts/phase2-rollback-rehearsal.ts',
      'scripts/phase2-s8-binding.ts',
      'scripts/phase2-s8-evidence.ts',
    ]);
    for (const file of REPOSITORY_TOOLS) {
      expect(gitCalls(file, readFileSync(join(REPO, file), 'utf8')).length, `${file} no longer calls git; drop it from the allowlist`).toBeGreaterThan(0);
    }
  });
});

describe('every git invocation in tests/** and scripts/**', () => {
  const calls = scan(REPO);

  it('is found by the scan — the known sites are all seen', () => {
    const files = new Set(calls.map((call) => call.file));
    for (const known of [
      'tests/helpers/delivered-files.ts',
      'tests/security/phase2-s8-gate-tamper.test.ts',
      'tests/performance/accounting-budgets.test.ts',
      'tests/performance/accounting-correction-candidate.test.ts',
      'tests/performance/accounting-rls-equivalence.test.ts',
      'tests/performance/accounting-trial-balance-diagnosis.test.ts',
      ...REPOSITORY_TOOLS,
    ]) {
      expect(files.has(known), known).toBe(true);
    }
  });

  it('has a DELIVERY_MANIFEST.json branch or a try/catch fallback, or is in a repository tool', () => {
    expect(problems(calls)).toEqual([]);
  });

  it('in the known suites, is covered by the fallback each one actually has', () => {
    const guards = (file: string) => calls.filter((call) => call.file === file).map((call) => call.guard);
    expect(guards('tests/helpers/delivered-files.ts')).toEqual(['delivery-manifest']);
    expect(guards('tests/security/phase2-s8-gate-tamper.test.ts')).toEqual(['delivery-manifest']);
    for (const suite of ['accounting-budgets', 'accounting-correction-candidate', 'accounting-rls-equivalence', 'accounting-trial-balance-diagnosis']) {
      expect(guards(`tests/performance/${suite}.test.ts`), suite).toEqual(['try-catch']);
    }
  });

  it('is absent from the two S8 tree-copy suites, which read the inventory through the helper (A-11)', () => {
    for (const suite of ['tests/security/phase3-s8-gate-tamper.test.ts', 'tests/integration/phase3-s8-guards.test.ts']) {
      const text = readFileSync(join(REPO, suite), 'utf8');
      expect(gitCalls(suite, text), suite).toEqual([]);
      expect(text, suite).toMatch(/from '\.\.\/helpers\/delivered-files'/);
    }
  });
});

describe('red: a bare call is flagged', () => {
  const flagged = (text: string): string[] => problems(fixture(text));

  it.each([
    ['execFileSync with git', `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['ls-files', '-z']);\n`],
    ['execSync with a git command', `import { execSync } from 'node:child_process';\nconst sha = execSync('git rev-parse HEAD').toString();\n`],
    ['spawnSync with git', `import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);\n`],
    ['a member call', `import * as cp from 'node:child_process';\ncp.execFileSync('git', ['ls-files']);\n`],
    ['a template command', 'import { execSync } from "node:child_process";\nconst ref = "HEAD";\nexecSync(`git rev-parse ${ref}`);\n'],
    ['git later in a shell command', `import { execSync } from 'node:child_process';\nexecSync('cd /tmp && git status --porcelain');\n`],
    ['an absolute git path', `import { execFileSync } from 'node:child_process';\nexecFileSync('/usr/bin/git', ['ls-files']);\n`],
    ['a wrapper taking the executable', `const run = (cmd: string, args: string[]) => cmd + args.join(' ');\nrun('git', ['worktree', 'add']);\n`],
    ['git through a named constant', `import { execFileSync } from 'node:child_process';\nconst GIT = 'git';\nexecFileSync(GIT, ['ls-files']);\n`],
    ['a tagged template', 'declare const $: (s: TemplateStringsArray) => string;\n$`git ls-files`;\n'],
    [
      'a try whose catch only rethrows',
      `import { execFileSync } from 'node:child_process';\ntry {\n  execFileSync('git', ['ls-files']);\n} catch (e) {\n  throw e;\n}\n`,
    ],
    [
      'spawnSync inside a try (it never throws on exit 128)',
      `import { spawnSync } from 'node:child_process';\ntry {\n  spawnSync('git', ['ls-files']);\n} catch {\n  /* never reached */\n}\n`,
    ],
    [
      'a call in the catch block, not the try',
      `import { execFileSync } from 'node:child_process';\ntry {\n  JSON.parse('x');\n} catch {\n  execFileSync('git', ['ls-files']);\n}\n`,
    ],
    [
      'a function with no manifest branch, beside one that has it',
      `import { execFileSync } from 'node:child_process';\nimport { existsSync } from 'node:fs';\nfunction good(): string { return existsSync('DELIVERY_MANIFEST.json') ? 'm' : execFileSync('git', ['ls-files'], { encoding: 'utf8' }); }\nfunction bad(): string { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }); }\n`,
    ],
    [
      'a bare call in a file that imports the helper',
      `import { execFileSync } from 'node:child_process';\nimport { deliveredFiles } from '../helpers/delivered-files';\ndeliveredFiles('.');\nexecFileSync('git', ['ls-files']);\n`,
    ],
  ])('%s', (_name, text) => {
    const found = flagged(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^tests\/security\/planted\.test\.ts:\d+ [\w$]+\(git …\) has no DELIVERY_MANIFEST\.json branch and no try\/catch fallback$/);
  });

  it('a planted file with a bare call makes the whole-tree scan fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'daftar-archive-portability-'));
    temporaries.push(root);
    const planted = join(root, 'tests/security/planted.test.ts');
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(
      planted,
      `import { execFileSync } from 'node:child_process';\n\nexport const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });\n`,
    );
    const helper = join(root, 'tests/helpers/ok.ts');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, `export const title = 'git ls-files is not a call';\n// execFileSync('git', ['ls-files']) in a comment is not a call either\n`);
    expect(problems(scan(root))).toEqual([
      'tests/security/planted.test.ts:3 execFileSync(git …) has no DELIVERY_MANIFEST.json branch and no try/catch fallback',
    ]);
  });
});

describe('green twins: what is not a finding', () => {
  it('a manifest branch in the same function', () => {
    const calls = fixture(
      `import { execFileSync } from 'node:child_process';\nimport { existsSync } from 'node:fs';\nexport function files(): string {\n  if (existsSync('DELIVERY_MANIFEST.json')) return 'from the manifest';\n  return execFileSync('git', ['ls-files'], { encoding: 'utf8' });\n}\n`,
    );
    expect(calls.map((call) => call.guard)).toEqual(['delivery-manifest']);
    expect(problems(calls)).toEqual([]);
  });

  it('a try/catch that falls back to a value', () => {
    const calls = fixture(
      `import { execSync } from 'node:child_process';\nexport const sha = (() => {\n  try {\n    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();\n  } catch {\n    return 'unknown';\n  }\n})();\n`,
    );
    expect(calls.map((call) => call.guard)).toEqual(['try-catch']);
    expect(problems(calls)).toEqual([]);
  });

  it('comments, test titles and strings that only mention git', () => {
    expect(
      fixture(
        `import { it } from 'vitest';\n// execFileSync('git', ['ls-files'])\nit('git is not needed here', () => undefined);\nexport const s = "execSync('git status')";\nexport const github = 'github';\n`,
      ),
    ).toEqual([]);
  });

  it('a bare call in a repository tool', () => {
    const calls = gitCalls('scripts/export-release.ts', `import { spawnSync } from 'node:child_process';\nspawnSync('git', ['ls-files', '-z']);\n`);
    expect(calls).toHaveLength(1);
    expect(problems(calls)).toEqual([]);
  });
});
