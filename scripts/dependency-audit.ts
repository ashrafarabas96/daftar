#!/usr/bin/env tsx
/**
 * DEV-TOOL DEPENDENCY AUDIT WITH ONE DATED, SELF-EXPLODING WAIVER (DR-173/4).
 *
 * `npm audit --audit-level=high` over the whole tree fails on eleven packages
 * that all trace to ONE advisory, GHSA-fc5q-39xc-vjpf, in `picomatch` (range
 * `<= 4.0.7`, no patched release, installed 4.0.7). Every package of the chain
 * is a development tool (vite, vitest, tinyglobby, fdir, typescript-eslint),
 * `dev: true` in the lockfile, so nothing of it ships.
 *
 * The owner's decision is NARROWING, not loosening:
 *
 *   - the production audit stays a blocking CI step on its own, one level
 *     STRICTER than before (`npm audit --omit=dev --audit-level=moderate`);
 *   - this script judges the development tree and stays blocking at `high`
 *     for every advisory EXCEPT that one advisory;
 *   - the exception is not a switch. It explodes by itself, in code, when:
 *       (1) the calendar passes WAIVER_EXPIRES,
 *       (2) a newer stable release of the package exists on the registry
 *           (a fix may exist: a person decides again), or `npm audit` itself
 *           reports a direct fix for it,
 *       (3) any lockfile entry of the package, or of anything it makes
 *           vulnerable, is not a development-only entry.
 *
 * `judge` is pure: it takes the two JSON documents `npm audit` prints, the
 * lockfile, the registry's version list and a date, and returns problems. The
 * network and the clock are read only by the entry point at the bottom, so
 * every refusal is exercised by `tests/guards/dependency-audit-law.test.ts`
 * with a planted case and a control that passes.
 *
 * Usage: npm run -s check:dependency-audit   (or: npx tsx scripts/dependency-audit.ts)
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const WAIVED_ADVISORY = 'GHSA-fc5q-39xc-vjpf';
export const WAIVED_PACKAGE = 'picomatch';
/** The waiver is valid THROUGH this day (UTC, ISO date). */
export const WAIVER_EXPIRES = '2026-12-31';

type Via = string | { url?: string; name?: string; severity?: string; source?: number; range?: string };
interface Vulnerability {
  name: string;
  severity: string;
  via: Via[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor?: boolean };
}
export interface AuditJson {
  vulnerabilities?: Record<string, Vulnerability>;
  error?: unknown;
  metadata?: { dependencies?: { total?: number } };
}
export interface LockJson {
  packages?: Record<string, { version?: string; dev?: boolean }>;
}
export interface JudgeInput {
  /** `npm audit --json` over the whole tree (dev tools included). */
  full: AuditJson;
  lock: LockJson;
  /** Every version of WAIVED_PACKAGE the registry lists. */
  registryVersions: string[];
  /** Today, UTC, `YYYY-MM-DD`. */
  today: string;
}

const BLOCKING = new Set(['high', 'critical']);

function stableParts(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** The advisory URLs a vulnerable package ultimately rests on. */
function rootAdvisories(vulns: Record<string, Vulnerability>, name: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  for (const via of vulns[name]?.via ?? []) {
    if (typeof via === 'string') {
      for (const u of rootAdvisories(vulns, via, seen)) out.add(u);
    } else {
      out.add(via.url ?? `source:${String(via.source)}`);
    }
  }
  return out;
}

export function judge(input: JudgeInput): string[] {
  const problems: string[] = [];
  const vulns = input.full.vulnerabilities;

  // The probe must have read a live audit: an error document, or a tree of no
  // dependencies, would otherwise pass as "no vulnerabilities" (RULE-18).
  if (input.full.error !== undefined) {
    problems.push(`npm audit returned an error document: ${JSON.stringify(input.full.error).slice(0, 200)}`);
    return problems;
  }
  if (vulns === undefined || !((input.full.metadata?.dependencies?.total ?? 0) > 0)) {
    problems.push('npm audit output has no vulnerabilities map or no dependency count: it read nothing, so it judges nothing');
    return problems;
  }

  const blocking = Object.values(vulns).filter((v) => BLOCKING.has(v.severity));
  let waivedUsed = false;
  for (const v of blocking) {
    const roots = rootAdvisories(vulns, v.name);
    const foreign = [...roots].filter((u) => !u.endsWith(`/${WAIVED_ADVISORY}`));
    if (roots.size === 0) {
      problems.push(`${v.name} (${v.severity}) is vulnerable but names no advisory: it cannot be explained, so it is not waived`);
    } else if (foreign.length > 0) {
      problems.push(`${v.name} (${v.severity}) rests on an advisory other than ${WAIVED_ADVISORY}: ${foreign.join(', ')}`);
    } else {
      waivedUsed = true;
    }
  }
  if (!waivedUsed) return problems; // nothing is waived, so no waiver condition applies

  // (1) the date
  if (input.today > WAIVER_EXPIRES) {
    problems.push(`the ${WAIVED_ADVISORY} waiver expired after ${WAIVER_EXPIRES} (today ${input.today}): decide again`);
  }

  // (2) a fix may exist
  const installed = Object.entries(input.lock.packages ?? {})
    .filter(([k]) => k === `node_modules/${WAIVED_PACKAGE}` || k.endsWith(`/node_modules/${WAIVED_PACKAGE}`))
    .map(([, p]) => p.version ?? '');
  const installedParts = installed.map(stableParts).filter((p): p is number[] => p !== null);
  if (installedParts.length === 0) {
    problems.push(`no lockfile entry of ${WAIVED_PACKAGE} with a stable version was read: the fix test would be blind`);
  } else {
    const top = installedParts.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
    const newer = input.registryVersions.map(stableParts).filter((p): p is number[] => p !== null && compare(p, top) > 0);
    if (input.registryVersions.length === 0) {
      problems.push(`the registry listed no versions of ${WAIVED_PACKAGE}: the fix test would be blind`);
    } else if (newer.length > 0) {
      problems.push(`${WAIVED_PACKAGE} has a stable release newer than the installed ${top.join('.')}: a fix may exist, the waiver no longer holds`);
    }
  }
  const fix = vulns[WAIVED_PACKAGE]?.fixAvailable;
  if (fix === true || (typeof fix === 'object' && fix !== null && fix.name === WAIVED_PACKAGE)) {
    problems.push(`npm audit reports a direct fix for ${WAIVED_PACKAGE}: the waiver no longer holds`);
  }

  // (3) development-only, for the package and everything it makes vulnerable
  const names = new Set<string>([WAIVED_PACKAGE, ...blocking.map((v) => v.name)]);
  for (const name of names) {
    const entries = Object.entries(input.lock.packages ?? {}).filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`));
    if (entries.length === 0) {
      problems.push(`${name} has no lockfile entry: the development-only test would be blind`);
    }
    for (const [k, p] of entries) {
      if (p.dev !== true) problems.push(`${k} is not a development-only entry (dev !== true): the waiver covers development tools only`);
    }
  }
  return problems;
}

function runNpm(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', status: r.status };
}

function main(): number {
  const root = process.cwd();
  const auditRun = runNpm(['audit', '--json']);
  let full: AuditJson;
  let versions: string[];
  try {
    full = JSON.parse(auditRun.stdout) as AuditJson;
  } catch {
    console.error('dependency-audit: `npm audit --json` printed no JSON, so nothing was judged');
    return 1;
  }
  const view = runNpm(['view', WAIVED_PACKAGE, 'versions', '--json']);
  try {
    versions = JSON.parse(view.stdout) as string[];
  } catch {
    console.error(`dependency-audit: \`npm view ${WAIVED_PACKAGE} versions\` printed no JSON, so the fix test could not run`);
    return 1;
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as LockJson;
  const problems = judge({ full, lock, registryVersions: versions, today: new Date().toISOString().slice(0, 10) });
  if (problems.length > 0) {
    console.error('dependency-audit: FAIL');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  const waived = Object.values(full.vulnerabilities ?? {}).filter((v) => BLOCKING.has(v.severity)).length;
  console.log(`dependency-audit: PASS (${waived} development-tool findings, all ${WAIVED_ADVISORY}, waived through ${WAIVER_EXPIRES})`);
  return 0;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (/scripts\/dependency-audit\.[cm]?[tj]s$/.test(entry)) process.exit(main());
