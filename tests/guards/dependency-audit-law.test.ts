/**
 * DR-173/4: the dev-tool audit waiver explodes in code, and each explosion has
 * a planted case that makes it red (a waiver without them is blind, which is
 * exactly what the decision forbids).
 *
 * The positive control is a REAL capture of `npm audit --json` on `main`
 * 7ec72a55 (2026-11-18): eleven high findings, ten of them derived from one
 * advisory object, GHSA-fc5q-39xc-vjpf in picomatch. The lockfile is derived
 * from that capture's own `nodes` lists (every node `dev: true`), not from the
 * live tree, so a later upgrade of the real lockfile cannot turn this red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge, WAIVED_ADVISORY, WAIVER_EXPIRES, type AdvisoryDoc, type AuditJson, type LockJson } from '../../scripts/dependency-audit';

const root = join(__dirname, '..', '..');
const raw = readFileSync(join(root, 'tests/fixtures/dependency-audit/npm-audit-full-2026-11-18.json'), 'utf8');
const capture = (): AuditJson => JSON.parse(raw) as AuditJson;

function lockOf(audit: AuditJson, dev = true): LockJson {
  const packages: NonNullable<LockJson['packages']> = {};
  for (const v of Object.values(audit.vulnerabilities ?? {})) {
    for (const node of (v as unknown as { nodes: string[] }).nodes) {
      packages[node] = { version: node.endsWith('/picomatch') ? '4.0.7' : '1.0.0', ...(dev ? { dev: true } : {}) };
    }
  }
  return { packages };
}

function entry(full: AuditJson, name: string): { fixAvailable: unknown; via: unknown[] } {
  const e = (full.vulnerabilities as Record<string, { fixAvailable: unknown; via: unknown[] }> | undefined)?.[name];
  if (e === undefined) throw new Error(`fixture has no ${name}`);
  return e;
}

const advisoryRaw = readFileSync(join(root, 'tests/fixtures/dependency-audit/advisory-GHSA-fc5q-39xc-vjpf-2026-11-18.json'), 'utf8');
const advisoryCapture = (): AdvisoryDoc => JSON.parse(advisoryRaw) as AdvisoryDoc;

const base = () => {
  const full = capture();
  return {
    full,
    lock: lockOf(full),
    registryVersions: ['3.0.1', '4.0.6', '4.0.7'],
    advisory: advisoryCapture() as AdvisoryDoc | undefined,
    today: '2026-11-18',
  };
};

describe('dependency-audit law (DR-173/4)', () => {
  it('control: the real capture is eleven high findings, ten derived from the one waived advisory, and it passes', () => {
    const { full } = base();
    const vulns = Object.values(full.vulnerabilities ?? {});
    expect(vulns.filter((v) => v.severity === 'high')).toHaveLength(11);
    const advisoryUrls = vulns
      .flatMap((v) => v.via)
      .filter((x) => typeof x !== 'string')
      .map((x) => (x as { url: string }).url);
    expect(advisoryUrls).toEqual([`https://github.com/advisories/${WAIVED_ADVISORY}`]);
    expect(judge(base())).toEqual([]);
  });

  it('the waiver holds through its last day and not after (date shifted)', () => {
    expect(judge({ ...base(), today: WAIVER_EXPIRES })).toEqual([]);
    const after = judge({ ...base(), today: '2027-01-01' });
    expect(after.join('\n')).toMatch(/expired after 2026-12-31/);
  });

  it('a fix appears: a newer stable release on the registry reddens', () => {
    const p = judge({ ...base(), registryVersions: ['4.0.7', '4.0.8'] });
    expect(p.join('\n')).toMatch(/stable release newer than the installed 4\.0\.7/);
  });

  it('a fix appears: the advisory itself lists a patched release (read from the advisory document, not a constant)', () => {
    const advisory = advisoryCapture();
    expect(advisory.vulnerabilities?.[0]?.first_patched_version).toBeNull(); // control: the real capture says null
    const planted = advisoryCapture();
    const first = planted.vulnerabilities?.[0];
    if (first === undefined) throw new Error('fixture has no vulnerabilities entry');
    first.first_patched_version = '4.0.8';
    expect(judge({ ...base(), advisory: planted }).join('\n')).toMatch(/advisory lists a patched release of picomatch \(4\.0\.8\)/);
  });

  it('an advisory that could not be read, or is a different document, reddens instead of passing', () => {
    expect(judge({ ...base(), advisory: undefined }).join('\n')).toMatch(/could not be read/);
    expect(judge({ ...base(), advisory: { ghsa_id: 'GHSA-aaaa-bbbb-cccc', vulnerabilities: [] } }).join('\n')).toMatch(/not the GHSA-fc5q-39xc-vjpf advisory/);
    const other = advisoryCapture();
    const first = other.vulnerabilities?.[0];
    if (first === undefined) throw new Error('fixture has no vulnerabilities entry');
    first.package = { name: 'micromatch' };
    expect(judge({ ...base(), advisory: other }).join('\n')).toMatch(/0 matching entries/);
  });

  it('a prerelease newer than the installed one is not a fix signal (negative control for the plant above)', () => {
    expect(judge({ ...base(), registryVersions: ['4.0.7', '4.1.0-beta.1'] })).toEqual([]);
  });

  it('a fix appears: npm audit itself reports a direct fix for picomatch (fixAvailable true, and an object naming it)', () => {
    for (const fixAvailable of [true, { name: 'picomatch', version: '4.0.8', isSemVerMajor: false }] as const) {
      const full = capture();
      entry(full, 'picomatch').fixAvailable = fixAvailable;
      const p = judge({ ...base(), full, lock: lockOf(full) });
      expect(p.join('\n')).toMatch(/direct fix for picomatch/);
    }
  });

  it('the advisory appears in a production library: the lockfile entry is not dev-only', () => {
    const full = capture();
    const p = judge({ ...base(), full, lock: lockOf(full, false) });
    expect(p.join('\n')).toMatch(/node_modules\/picomatch is not a development-only entry/);
  });

  it('one chain package outside development reddens even when picomatch itself stays dev (planted on vite)', () => {
    const full = capture();
    const lock = lockOf(full);
    lock.packages = { ...lock.packages, 'node_modules/vite': { version: '7.3.7' } };
    const p = judge({ ...base(), full, lock });
    expect(p.join('\n')).toMatch(/node_modules\/vite is not a development-only entry/);
    expect(p.join('\n')).not.toMatch(/node_modules\/picomatch is not/);
  });

  it('any OTHER high advisory stays blocking: a second advisory object on a dev tool is not waived', () => {
    const full = capture();
    entry(full, 'vitest').via.push({
      source: 1,
      name: 'vitest',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      severity: 'high',
      range: '<9',
    });
    const p = judge({ ...base(), full });
    expect(p.join('\n')).toMatch(/vitest \(high\) rests on an advisory other than GHSA-fc5q-39xc-vjpf: https:\/\/github\.com\/advisories\/GHSA-aaaa-bbbb-cccc/);
  });

  it('a new unrelated high finding on a package outside the chain is blocking', () => {
    const full = capture();
    (full.vulnerabilities as Record<string, unknown>).lodash = {
      name: 'lodash',
      severity: 'critical',
      via: [{ source: 2, name: 'lodash', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'critical', range: '<5' }],
      fixAvailable: true,
      nodes: ['node_modules/lodash'],
    };
    const p = judge({ ...base(), full, lock: lockOf(full) });
    expect(p.join('\n')).toMatch(/lodash \(critical\) rests on an advisory other than/);
  });

  it("a moderate finding is not this script's business (the production audit step owns moderate)", () => {
    const full = capture();
    (full.vulnerabilities as Record<string, unknown>).left = {
      name: 'left',
      severity: 'moderate',
      via: [{ source: 3, name: 'left', url: 'https://github.com/advisories/GHSA-gggg-hhhh-iiii', severity: 'moderate', range: '*' }],
      fixAvailable: false,
      nodes: ['node_modules/left'],
    };
    expect(judge({ ...base(), full, lock: lockOf(full) })).toEqual([]);
  });

  it('a vulnerability that names no advisory is not waived', () => {
    const full = capture();
    entry(full, 'vitest').via = [];
    expect(judge({ ...base(), full }).join('\n')).toMatch(/vitest \(high\) is vulnerable but names no advisory/);
  });

  describe('the probe reads something (blind cases are red, not green)', () => {
    it('an error document', () => {
      const p = judge({ ...base(), full: { error: { code: 'ENOAUDIT' } } });
      expect(p.join('\n')).toMatch(/returned an error document/);
    });
    it('no vulnerabilities map or no dependency count', () => {
      expect(judge({ ...base(), full: {} }).join('\n')).toMatch(/read nothing/);
      const full = capture();
      full.metadata = { dependencies: { total: 0 } };
      expect(judge({ ...base(), full }).join('\n')).toMatch(/read nothing/);
    });
    it('an empty registry list, and a lockfile with no picomatch entry', () => {
      expect(judge({ ...base(), registryVersions: [] }).join('\n')).toMatch(/registry listed no versions/);
      const full = capture();
      expect(judge({ ...base(), full, lock: { packages: {} } }).join('\n')).toMatch(/no lockfile entry of picomatch with a stable version/);
    });
  });

  it('a clean audit with the advisory gone passes with no waiver condition applied (expired date does not redden it)', () => {
    const full: AuditJson = { vulnerabilities: {}, metadata: { dependencies: { total: 506 } } };
    expect(judge({ ...base(), full, today: '2027-06-01' })).toEqual([]);
  });
});

describe('dependency-audit wiring in ci.yml (DR-173/4 (a): narrowing, not loosening)', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const stepRuns = (name: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`^\\s*- name: ${name.replace(/[()]/g, '\\$&')}\\s*\\n\\s*run: (.+)$`, 'gm');
    for (const m of ci.matchAll(re)) out.push((m[1] ?? '').trim());
    return out;
  };

  it('the production audit is a blocking step of its own, at moderate', () => {
    expect(stepRuns('Dependency audit (production, moderate)')).toEqual(['npm audit --omit=dev --audit-level=moderate']);
  });

  it('the development audit runs the judging script, and no step is a bare whole-tree high audit any more', () => {
    expect(stepRuns('Dependency audit (development tools, one dated waiver)')).toEqual(['npx tsx scripts/dependency-audit.ts']);
    const bare = ci.split('\n').filter((l) => /^\s*(- )?run: npm audit\b/.test(l) && !/--omit=dev/.test(l));
    expect(bare).toEqual([]);
  });

  it('no audit step is softened: no continue-on-error, no || true, no retry on the audit steps', () => {
    const at = ci.indexOf('Dependency audit (production, moderate)');
    expect(at).toBeGreaterThan(-1);
    const block = ci.slice(at, ci.indexOf('Forbidden artifact scan', at));
    expect(block).not.toMatch(/continue-on-error|\|\|\s*true|retry|nick-fields/);
  });

  it('control: a copy whose production step were weakened to high is read as different (the check can say no)', () => {
    const weakened = ci.replace('--omit=dev --audit-level=moderate', '--omit=dev --audit-level=high');
    expect(weakened).not.toBe(ci);
    const re = /run: npm audit --omit=dev --audit-level=moderate/;
    expect(re.test(ci)).toBe(true);
    expect(re.test(weakened)).toBe(false);
  });
});
