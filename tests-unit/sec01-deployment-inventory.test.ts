import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SEC-01, pre-launch gate item 6: the repository holds NO deployment artefact,
 * so nothing here can say what a deployed worker is actually given.
 *
 * WHY THIS IS A TEST AND NOT A SENTENCE
 *
 * The whole of SEC-01 is one lesson repeated: a protection that lives only in
 * prose is a protection that is already gone. The reference architecture said
 * the worker must not have JWT, and `config.ts` had no such refusal; it said
 * guards and `production-providers.test.ts` "keep the code honest", and `JWT`
 * appeared zero times in every guard. Both statements were true of intent and
 * false of the tree, and nothing failed.
 *
 * `docs/DAFTAR_RELEASE_GATES.md` section 4 item 6 now rests the ordering of
 * this change — remove the key from the deployed worker FIRST, then merge the
 * refusal — on a measurement: there is no deployment file here, so the owner
 * must confirm what runs outside. The day someone adds a Dockerfile or an ECS
 * task definition, that measurement is stale, and the gate would keep saying
 * what used to be true. So the measurement is pinned here instead.
 *
 * WHAT A FAILURE MEANS
 *
 * Not "deployment files are forbidden". It means a deployment artefact now
 * exists and gate item 6 must be re-read against it: does it pass JWT_SECRET
 * or JWT_KEYS to a `PROCESS_MODE=worker` process? Answer that, update the
 * gate, then add the path here.
 */

const ROOT = resolve(__dirname, '..');

const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

/**
 * Deployment and process-configuration artefacts, matched on the BASENAME or
 * an exact extension or a path segment — never on a bare substring.
 *
 * A substring is how this probe lies. `chart` as a substring matches
 * `0040_accounting_chart.sql` and `accounting-chart.test.ts`, neither of which
 * is a Helm chart; `ecs` as a substring matches any word containing it. Two
 * false hits in a security measurement are worse than none, because the next
 * reader stops believing the whole number.
 */
const DEPLOYMENT_ARTEFACT = (path: string): string | null => {
  const b = basename(path);
  const segs = path.split('/');
  if (b === 'Dockerfile' || b.startsWith('Dockerfile.') || b.endsWith('.dockerfile') || b === '.dockerignore') return 'container image';
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b)) return 'compose';
  if (/\.(tf|tfvars)$/.test(b) || b === '.terraform.lock.hcl') return 'terraform';
  if (/cloudformation/i.test(b) || b === 'template.yaml' || b === 'samconfig.toml') return 'cloudformation/sam';
  if (b === 'Chart.yaml' || b === 'values.yaml' || segs.includes('helm') || segs.includes('k8s') || segs.includes('kubernetes')) return 'helm/kubernetes';
  if (/task-?definition/i.test(b)) return 'ecs task definition';
  if (
    b === 'Procfile' ||
    b === 'fly.toml' ||
    /^render\.ya?ml$/.test(b) ||
    b === 'vercel.json' ||
    b === 'netlify.toml' ||
    b === 'railway.toml' ||
    b === 'app.yaml'
  )
    return 'managed platform';
  if (segs.includes('.ebextensions')) return 'elastic beanstalk';
  if (/\.service$/.test(b) || b === 'ecosystem.config.js' || b === 'ecosystem.config.cjs') return 'process manager';
  if (/^\.env(\..+)?$/.test(b) || b === 'env.example' || b === 'example.env' || b === '.env.example') return 'dotenv';
  return null;
};

describe('SEC-01 pre-launch gate item 6: the deployment inventory it rests on', () => {
  it('the probe is sighted — the same listing finds the file kinds that DO exist', () => {
    // RULE-11/RULE-18: a zero from a probe that finds nothing anywhere is not
    // a measurement. Before believing the zero below, prove this lister sees
    // the tree at all, with counts the tree is known to carry.
    const files = tracked();
    expect(files.length, 'git ls-files returned nothing — the probe is blind, not the tree empty').toBeGreaterThan(1000);
    expect(files.filter((f) => f.endsWith('.sql')).length, 'migrations exist').toBeGreaterThan(50);
    expect(files.filter((f) => /\.ya?ml$/.test(f)).length, 'workflow files exist').toBeGreaterThan(0);
    expect(files.filter((f) => f.startsWith('infrastructure/')).length, 'the infrastructure tree exists').toBeGreaterThan(0);
  });

  it('zero tracked deployment artefacts, so what a deployed worker receives is UNKNOWN from here', () => {
    const hits = tracked()
      .map((p) => ({ p, kind: DEPLOYMENT_ARTEFACT(p) }))
      .filter((h): h is { p: string; kind: string } => h.kind !== null);

    expect(
      hits.map((h) => `${h.p} (${h.kind})`),
      'A deployment artefact is now tracked. This is not forbidden — but gate item 6 of docs/DAFTAR_RELEASE_GATES.md rests on there being none, ' +
        'so read it against this file: does it pass JWT_SECRET or JWT_KEYS to a PROCESS_MODE=worker process? config.ts refuses both in every ' +
        'environment, so a worker deployed with either will not start. Update the gate, then add the path to this test.',
    ).toEqual([]);
  });

  it('and gate item 6 still names the two variables, the worker mode and the ordering', () => {
    // The converse control. The measurement above is only worth pinning while
    // the gate that rests on it still exists and still says what it says — a
    // gate quietly reworded is the same defect as a stale measurement.
    const gate = readFileSync(resolve(ROOT, 'docs/DAFTAR_RELEASE_GATES.md'), 'utf8').replace(/\s+/g, ' ');
    for (const needle of ['SEC-01', 'JWT_SECRET', 'JWT_KEYS', 'PROCESS_MODE=worker']) {
      expect(gate, `gate item 6 no longer names ${needle}`).toContain(needle);
    }
  });
});
