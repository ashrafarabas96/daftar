#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE LIVE TREE, READ RATHER THAN REMEMBERED
 *
 * Every fact an S8 check stands on is DISCOVERED from the tree at `root`:
 * the migrations on disk, the relations and columns they create, the
 * constraints, the policies, the routines, the registry rows they insert, the
 * permission registry, the suites, the workflow steps and the npm scripts.
 *
 * Nothing here is a hand-written list of what the tree contains, for the
 * reason the derived-truth guard's own header gives: a list rots, and the
 * sibling slice that adds the twelfth relation does not come back to update
 * it. `[[daftar-a-list-is-not-a-discovery]]`.
 *
 * TWO HONEST LIMITS, STATED RATHER THAN HIDDEN:
 *
 *   1. This is a STATIC read of the migration text. It answers "does the tree
 *      claim to create this relation" — not "does a live catalogue hold it".
 *      That is sufficient for SUBJECT REALITY (the question "has the slice
 *      that owns this shipped it yet?") and insufficient for a semantic
 *      invariant. Where a check needs the catalogue, it says so and takes a
 *      `pg` client; see `rls-estate.ts` and `lock-order.ts`.
 *   2. `--root` points the whole module at a copy of the tree, which is how
 *      every red proof plants its defect without touching the real tree.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SubjectProbe, SubjectRequirement } from './verdict';

export const MIGRATIONS_REL = 'infrastructure/database/migrations';
export const MANIFEST_REL = 'infrastructure/database/MIGRATION_MANIFEST.json';
export const CI_WORKFLOW_REL = '.github/workflows/ci.yml';
export const PERMISSIONS_REL = 'packages/domain-core/src/permissions.ts';

export interface MigrationFile {
  readonly name: string;
  readonly ordinal: number;
  readonly text: string;
}

/** Everything the module knows, computed once per root. */
export interface TreeFacts {
  readonly root: string;
  readonly migrations: readonly MigrationFile[];
  /** `CREATE TABLE [IF NOT EXISTS] <name>` across every migration, in ordinal order. */
  readonly relations: ReadonlyMap<string, string>;
  /** `<relation>.<column>` for every column of every discovered `CREATE TABLE` body. */
  readonly columns: ReadonlySet<string>;
  /** Every named constraint: `CONSTRAINT <name>` and `ADD CONSTRAINT <name>`. */
  readonly constraints: ReadonlyMap<string, string>;
  /** `<relation>.<policy>` for every `CREATE POLICY <policy> ON <relation>`. */
  readonly policies: ReadonlySet<string>;
  /** Every routine `CREATE [OR REPLACE] FUNCTION <name>` → the migration that last defines it. */
  readonly routines: ReadonlyMap<string, string>;
  /** Rows inserted into `accounting_source_types`. */
  readonly accountingSourceTypes: ReadonlyMap<string, string>;
  /** Rows inserted into `stock_source_types`. */
  readonly stockSourceTypes: ReadonlyMap<string, string>;
  /** Rows inserted into `inventory_operation_kinds`. */
  readonly operationKinds: ReadonlyMap<string, string>;
  /** The closed permission registry, in declaration order. */
  readonly permissions: readonly string[];
  /** Permission keys in `SENSITIVE_PERMISSIONS`. */
  readonly sensitivePermissions: ReadonlySet<string>;
  /** Built-in role → its default key list, as the registry declares it. */
  readonly builtinRoleDefaults: ReadonlyMap<string, readonly string[]>;
  /** Every `tests/**` file the root runner would execute, relative to root. */
  readonly suites: readonly string[];
  /** Every `- name:` step of `.github/workflows/ci.yml`, with its job and 1-based line. */
  readonly workflowSteps: readonly WorkflowStep[];
  /** The root `package.json` scripts. */
  readonly npmScripts: ReadonlyMap<string, string>;
}

export interface WorkflowStep {
  readonly job: string;
  readonly name: string;
  readonly line: number;
  readonly run: string | null;
  readonly uses: string | null;
  readonly ifExpr: string | null;
  readonly continueOnError: boolean;
}

const cache = new Map<string, TreeFacts>();

/**
 * A `CREATE TABLE` body, from the opening paren to the matching close.
 *
 * Written as a paren walker rather than a regex because a column default can
 * contain a parenthesis and a `CHECK` almost always does, so a lazy
 * `\(([^)]*)\)` stops at the first `CHECK (char_length(` it meets and reports
 * half the columns of every interesting table.
 */
/**
 * Walks SQL text respecting what SQL text actually contains: single-quoted
 * literals (in which `'` is the only escape via doubling), `$$`-quoted bodies,
 * `--` line comments and block comments.
 *
 * Written once, as a scanner, after the naive version lost `invoices.tax_minor`
 * - the CREATE TABLE body holds an apostrophe inside a -- comment, and a
 * walker that does not know about comments treats the rest of the file as one
 * string literal and reports the relation as having no columns at all. A
 * discovery rule that silently reports FEWER rows than exist is the dangerous
 * direction of wrong.
 */
type ScanState = 'code' | 'single' | 'dollar' | 'line-comment' | 'block-comment';

function scanForward(text: string, from: number, onCode: (ch: string, index: number) => boolean): void {
  let state: ScanState = 'code';
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    switch (state) {
      case 'single':
        if (ch === "'") state = text[i + 1] === "'" ? 'single' : 'code';
        if (ch === "'" && text[i + 1] === "'") i += 1;
        continue;
      case 'dollar':
        if (text.startsWith('$$', i)) {
          state = 'code';
          i += 1;
        }
        continue;
      case 'line-comment':
        if (ch === '\n') state = 'code';
        continue;
      case 'block-comment':
        if (text.startsWith('*/', i)) {
          state = 'code';
          i += 1;
        }
        continue;
      default:
        break;
    }
    if (text.startsWith('--', i)) {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      state = 'block-comment';
      i += 1;
      continue;
    }
    if (text.startsWith('$$', i)) {
      state = 'dollar';
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = 'single';
      continue;
    }
    if (!onCode(ch, i)) return;
  }
}

/**
 * SQL text with its comments and string literals blanked out, offsets kept.
 *
 * Every positional rule in this framework — the lock-order walker, the
 * registry-before-state measurement, the conflict-branch finder — reads the
 * body as SQL CODE. A routine body is heavily commented in this codebase
 * (`-- 7. Lock step 2b: the customer FOR SHARE.`), so a walker that does not
 * strip comments reports locks on relations the routine never touches, in an
 * order it never uses. The characters are replaced with spaces rather than
 * removed, so every offset a caller reports still points at the real file.
 */
export function blankCommentsAndLiterals(sql: string): string {
  // `scanForward` calls back only on CODE characters, so anything it never
  // reaches is inside a comment, a string literal or a dollar-quoted body.
  const out = new Array<string>(sql.length).fill(' ');
  scanForward(sql, 0, (ch, i) => {
    out[i] = ch;
    return true;
  });
  return out.join('');
}

/** A `CREATE TABLE` body, from the opening paren to the matching close. */
function balancedBody(text: string, openParenIndex: number): string | null {
  let depth = 0;
  let end = -1;
  scanForward(text, openParenIndex, (ch, i) => {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        return false;
      }
    }
    return true;
  });
  return end === -1 ? null : text.slice(openParenIndex + 1, end);
}

/** The first `;` of a statement that is real punctuation and not inside a literal. */
function statementEnd(text: string, from: number): number {
  let end = -1;
  scanForward(text, from, (ch, i) => {
    if (ch !== ';') return true;
    end = i;
    return false;
  });
  return end === -1 ? text.length : end;
}

/** The leading identifier of each top-level item of a `CREATE TABLE` body. */
function topLevelColumnNames(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  scanForward(body, 0, (ch, i) => {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
    return true;
  });
  items.push(body.slice(start));
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    const first = /^([a-z_][a-z0-9_]*)/i.exec(trimmed);
    if (first === null) continue;
    const word = (first[1] ?? '').toLowerCase();
    // A table-level constraint is not a column.
    if (['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like'].includes(word)) continue;
    out.push(word);
  }
  return out;
}

/** The `('a', 'b'), ('c', 'd')` rows of one `INSERT INTO <table> (...) VALUES ...;`. */
function insertedFirstColumns(text: string, table: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(`, 'gi');
  let match = pattern.exec(text);
  while (match !== null) {
    const statement = text.slice(match.index, statementEnd(text, match.index));
    const valuesAt = statement.search(/VALUES/i);
    if (valuesAt !== -1) {
      const rows = statement.slice(valuesAt);
      const row = /\(\s*'([^']+)'/g;
      let r = row.exec(rows);
      while (r !== null) {
        const value = r[1];
        if (value !== undefined) out.push(value);
        r = row.exec(rows);
      }
    }
    match = pattern.exec(text);
  }
  return out;
}

function listTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      const childRel = `${rel}/${entry}`;
      const childAbs = join(root, childRel);
      if (statSync(childAbs).isDirectory()) walk(childRel);
      else if (entry.endsWith('.test.ts')) out.push(childRel);
    }
  };
  walk('tests');
  return out.sort();
}

/**
 * The steps of `.github/workflows/ci.yml`, parsed from the text.
 *
 * Deliberately a line parser over the real file rather than a YAML library:
 * the claim the S9 tooling has to make is about THIS TEXT — which step runs on
 * which trigger — and the repository has no YAML dependency to add. The
 * indentation contract (`  <job>:`, `      - name:`) is the file's own and is
 * asserted, so a reshaped file is a loud failure rather than a silent empty
 * step list.
 */
/** A step under construction: the same fields as a `WorkflowStep`, mutable. */
interface StepDraft {
  job: string;
  name: string;
  line: number;
  run: string | null;
  uses: string | null;
  ifExpr: string | null;
  continueOnError: boolean;
}

export function parseWorkflowSteps(text: string): WorkflowStep[] {
  const lines = text.split('\n');
  const steps: WorkflowStep[] = [];
  let job = '';
  let inJobs = false;
  // The in-progress step lives in a HOLDER rather than in a plain `let`.
  // Reason, and it is not style: every assignment of a non-null draft below is
  // immediately followed by `continue`, and `flush` assigns null from inside a
  // closure, so TypeScript's control-flow analysis concluded that a bare
  // `current` was `null` at the `if (current === null) continue` guard — which
  // made the surviving branch `never` and the rest of the parser dead code it
  // could not see. The holder keeps the declared type honest.
  const state: { current: StepDraft | null } = { current: null };
  const flush = (): void => {
    if (state.current !== null) steps.push({ ...state.current });
    state.current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch !== null) {
      flush();
      job = jobMatch[1] ?? '';
      continue;
    }
    const nameMatch = /^ {6}- name:\s*(.*)$/.exec(line);
    if (nameMatch !== null) {
      flush();
      state.current = { job, name: (nameMatch[1] ?? '').trim(), line: i + 1, run: null, uses: null, ifExpr: null, continueOnError: false };
      continue;
    }
    const usesStep = /^ {6}- uses:\s*(.*)$/.exec(line);
    if (usesStep !== null) {
      flush();
      state.current = { job, name: '', line: i + 1, run: null, uses: (usesStep[1] ?? '').trim(), ifExpr: null, continueOnError: false };
      continue;
    }
    if (state.current === null) continue;
    const ifMatch = /^ {8}if:\s*(.*)$/.exec(line);
    if (ifMatch !== null) state.current = { ...state.current, ifExpr: (ifMatch[1] ?? '').trim() };
    const usesMatch = /^ {8}uses:\s*(.*)$/.exec(line);
    if (usesMatch !== null) state.current = { ...state.current, uses: (usesMatch[1] ?? '').trim() };
    const coeMatch = /^ {8}continue-on-error:\s*(.*)$/.exec(line);
    if (coeMatch !== null) state.current = { ...state.current, continueOnError: (coeMatch[1] ?? '').trim() === 'true' };
    const runMatch = /^ {8}run:\s*(.*)$/.exec(line);
    if (runMatch !== null) {
      // A block scalar's body is the following more-indented lines.
      const first = (runMatch[1] ?? '').trim();
      if (first === '|' || first === '>' || first === '|-' || first === '>-') {
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j] ?? '';
          if (next.trim() === '') {
            body.push('');
            continue;
          }
          if (!next.startsWith('          ')) break;
          body.push(next.trim());
        }
        state.current = { ...state.current, run: body.join('\n') };
      } else state.current = { ...state.current, run: first };
    }
  }
  flush();
  return steps;
}

export function readTree(root: string): TreeFacts {
  const cached = cache.get(root);
  if (cached !== undefined) return cached;

  const migrationsDir = join(root, MIGRATIONS_REL);
  const migrations: MigrationFile[] = [];
  if (existsSync(migrationsDir))
    for (const name of readdirSync(migrationsDir).sort()) {
      if (!name.endsWith('.sql')) continue;
      const ordinal = Number.parseInt(name.slice(0, 4), 10);
      migrations.push({ name, ordinal: Number.isNaN(ordinal) ? -1 : ordinal, text: readFileSync(join(migrationsDir, name), 'utf8') });
    }

  const relations = new Map<string, string>();
  const columns = new Set<string>();
  const constraints = new Map<string, string>();
  const policies = new Set<string>();
  const routines = new Map<string, string>();
  const accountingSourceTypes = new Map<string, string>();
  const stockSourceTypes = new Map<string, string>();
  const operationKinds = new Map<string, string>();

  for (const migration of migrations) {
    const text = migration.text;

    const table = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let t = table.exec(text);
    while (t !== null) {
      const name = (t[1] ?? '').toLowerCase();
      if (!relations.has(name)) relations.set(name, migration.name);
      const open = text.indexOf('(', t.index + (t[0] ?? '').length - 1);
      const body = balancedBody(text, open);
      if (body !== null) for (const column of topLevelColumnNames(body)) columns.add(`${name}.${column}`);
      t = table.exec(text);
    }

    // `ALTER TABLE ... ADD COLUMN` widens a relation after its creation.
    const addColumn = /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    let ac = addColumn.exec(text);
    while (ac !== null) {
      columns.add(`${(ac[1] ?? '').toLowerCase()}.${(ac[2] ?? '').toLowerCase()}`);
      ac = addColumn.exec(text);
    }

    const constraint = /(?:ADD\s+)?CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi;
    let c = constraint.exec(text);
    while (c !== null) {
      const name = (c[1] ?? '').toLowerCase();
      if (!constraints.has(name)) constraints.set(name, migration.name);
      c = constraint.exec(text);
    }

    const policy = /CREATE\s+POLICY\s+([a-z_][a-z0-9_]*)\s+ON\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    let p = policy.exec(text);
    while (p !== null) {
      policies.add(`${(p[2] ?? '').toLowerCase()}.${(p[1] ?? '').toLowerCase()}`);
      p = policy.exec(text);
    }

    const routine = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let r = routine.exec(text);
    while (r !== null) {
      routines.set((r[1] ?? '').toLowerCase(), migration.name);
      r = routine.exec(text);
    }

    for (const value of insertedFirstColumns(text, 'accounting_source_types'))
      if (!accountingSourceTypes.has(value)) accountingSourceTypes.set(value, migration.name);
    for (const value of insertedFirstColumns(text, 'stock_source_types')) if (!stockSourceTypes.has(value)) stockSourceTypes.set(value, migration.name);
    for (const value of insertedFirstColumns(text, 'inventory_operation_kinds')) if (!operationKinds.has(value)) operationKinds.set(value, migration.name);
  }

  const permissionsPath = join(root, PERMISSIONS_REL);
  const permissionsText = existsSync(permissionsPath) ? readFileSync(permissionsPath, 'utf8') : '';
  const permissions = arrayLiteralStrings(permissionsText, 'PERMISSIONS');
  const sensitivePermissions = new Set(arrayLiteralStrings(permissionsText, 'SENSITIVE_PERMISSIONS'));
  const builtinRoleDefaults = new Map<string, readonly string[]>();
  const builtinBlock = blockAfter(permissionsText, 'BUILTIN_ROLE_PERMISSIONS');
  if (builtinBlock !== null) {
    const role = /^\s{2}([a-z_]+):\s*(PERMISSIONS|\[)/gm;
    let m = role.exec(builtinBlock);
    while (m !== null) {
      const key = m[1] ?? '';
      if (m[2] === 'PERMISSIONS') builtinRoleDefaults.set(key, permissions);
      else {
        const open = builtinBlock.indexOf('[', m.index);
        const close = matchingBracket(builtinBlock, open);
        const inner = close === -1 ? '' : builtinBlock.slice(open + 1, close);
        builtinRoleDefaults.set(key, stringLiterals(inner));
      }
      m = role.exec(builtinBlock);
    }
  }

  const workflowPath = join(root, CI_WORKFLOW_REL);
  const workflowSteps = existsSync(workflowPath) ? parseWorkflowSteps(readFileSync(workflowPath, 'utf8')) : [];

  const npmScripts = new Map<string, string>();
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    for (const [key, value] of Object.entries(parsed.scripts ?? {})) npmScripts.set(key, value);
  }

  const facts: TreeFacts = {
    root,
    migrations,
    relations,
    columns,
    constraints,
    policies,
    routines,
    accountingSourceTypes,
    stockSourceTypes,
    operationKinds,
    permissions,
    sensitivePermissions,
    builtinRoleDefaults,
    suites: listTestFiles(root),
    workflowSteps,
    npmScripts,
  };
  cache.set(root, facts);
  return facts;
}

/** Drops the memo for one root. Every red proof that mutates a copy calls it. */
export function forgetTree(root: string): void {
  cache.delete(root);
}

function matchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function blockAfter(text: string, identifier: string): string | null {
  const at = text.indexOf(`export const ${identifier}`);
  if (at === -1) return null;
  const open = text.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function stringLiterals(block: string): string[] {
  const out: string[] = [];
  const literal = /'([^']+)'/g;
  let m = literal.exec(block);
  while (m !== null) {
    const value = m[1];
    if (value !== undefined) out.push(value);
    m = literal.exec(block);
  }
  return out;
}

/** The string literals of `export const <identifier> = [ ... ]`. */
export function arrayLiteralStrings(text: string, identifier: string): string[] {
  const at = text.indexOf(`export const ${identifier}`);
  if (at === -1) return [];
  const open = text.indexOf('[', at);
  if (open === -1) return [];
  const close = matchingBracket(text, open);
  if (close === -1) return [];
  return stringLiterals(text.slice(open + 1, close));
}

/** Is `name` the name of a routine the tree defines? Case-insensitive. */
export function hasRoutine(facts: TreeFacts, name: string): boolean {
  return facts.routines.has(name.toLowerCase());
}

/** The text of the migration that last defines `routine`, or null. */
export function routineBody(facts: TreeFacts, routine: string): string | null {
  const migration = facts.routines.get(routine.toLowerCase());
  if (migration === undefined) return null;
  const file = facts.migrations.find((m) => m.name === migration);
  if (file === undefined) return null;
  const at = file.text.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${routine}\\s*\\(`, 'i'));
  if (at === -1) return null;
  const open = file.text.indexOf('$$', at);
  if (open === -1) return null;
  const close = file.text.indexOf('$$', open + 2);
  return close === -1 ? file.text.slice(open) : file.text.slice(open + 2, close);
}

/**
 * THE SUBJECT PROBE.
 *
 * One function, one switch, one rule per kind. It answers REALITY, not
 * correctness: `relation:refunds` is real the moment some migration creates
 * it, however wrong the shape. Correctness is what the check's `evaluate`
 * decides once reality is established — and keeping the two apart is what
 * stops a shape defect being reported as "not built yet".
 */
export const probeSubject: SubjectProbe = (root: string, subject: SubjectRequirement): boolean => {
  const facts = readTree(root);
  switch (subject.kind) {
    case 'relation':
      return facts.relations.has(subject.name.toLowerCase());
    case 'column':
      return facts.columns.has(subject.name.toLowerCase());
    case 'constraint':
      return facts.constraints.has(subject.name.toLowerCase());
    case 'policy':
      return facts.policies.has(subject.name.toLowerCase());
    case 'routine':
      return facts.routines.has(subject.name.toLowerCase());
    case 'accounting-source-type':
      return facts.accountingSourceTypes.has(subject.name);
    case 'stock-source-type':
      return facts.stockSourceTypes.has(subject.name);
    case 'operation-kind':
      return facts.operationKinds.has(subject.name);
    case 'permission':
      return facts.permissions.includes(subject.name);
    case 'suite':
      return existsSync(join(root, subject.name));
    case 'golden-directory':
      return existsSync(join(root, subject.name)) && readdirSync(join(root, subject.name)).some((f) => f.endsWith('.test.ts'));
    case 'workflow-step':
      return facts.workflowSteps.some((s) => s.name === subject.name);
    case 'npm-script':
      return facts.npmScripts.has(subject.name);
    case 'module-export': {
      const [file, exported] = subject.name.split('#');
      if (file === undefined || exported === undefined) return false;
      const path = join(root, file);
      return existsSync(path) && new RegExp(`export\\s+(?:const|function|class|type|interface)\\s+${exported}\\b`).test(readFileSync(path, 'utf8'));
    }
    default:
      return false;
  }
};
