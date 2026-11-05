/**
 * TD-24 — THE LAW THAT KEEPS THE LIVE EVIDENCE FROM GOING QUIET.
 *
 * `tests/security/td24-redis-live.test.ts` is the only suite that runs the
 * rate-limit Lua and the `redis.ts` handshake patch against a real Redis.
 * It skips when `REDIS_URL` is absent — it has to, since the development host
 * has neither Redis nor Docker — and a skip reports nothing. So the
 * configuration that makes it run is itself held to a law: if the `backend`
 * job stops defining the service, or stops passing the URL to the step that
 * runs the suite, THIS test fails by name rather than that suite falling
 * silent.
 *
 * That is the shape of defect this project keeps paying for: a suite that no
 * script runs is a claim, not a test (`tests-unit/test-lane-roster.test.ts`
 * exists for the same reason). An acceptance read off a run where the
 * decisive cases never executed would be a PASS without evidence.
 *
 * ── HOW IT IS CHECKED ────────────────────────────────────────────────────
 *
 * The workflow is PARSED (`js-yaml`), not grepped. A regex over YAML would
 * match a service named in a comment, or in a different job, and would miss a
 * block that moved — and `ci.yml` is edited by several lanes at once, so a
 * law over its text would be brittle in exactly the way that produces false
 * reds. Three claims, each with its control:
 *
 *   TD24-CI-A  the `backend` job defines a `redis` service, pinned to a
 *              version rather than a floating tag, and the step that runs
 *              `npm run test:integration` passes `REDIS_URL` to it.
 *              POSITIVE CONTROL in the same assertion: the long-standing
 *              `postgres` service is found by the same probe, so a zero
 *              cannot come from a parse that read nothing (RULE-11/18).
 *   TD24-CI-B  NEGATIVE CONTROL: a job that should NOT have the service does
 *              not have it. Without this, `A` would also pass against a probe
 *              that answered "yes" for everything.
 *   TD24-CI-C  the suite the service exists for is actually in the lane the
 *              job runs — `test:integration` names the directory it lives in.
 *
 * No assertion here pins a count, a step number or a line: `ci.yml` grows,
 * and an equality against today's shape is the P4-AL-88 defect.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const ROOT = join(__dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Service {
  readonly image?: string;
}
interface Job {
  readonly services?: Record<string, Service>;
  readonly steps?: Step[];
}
interface Workflow {
  readonly jobs?: Record<string, Job>;
}

function workflow(): Workflow {
  const parsed: unknown = load(readFileSync(WORKFLOW, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('jobs' in parsed))
    throw new Error(`${WORKFLOW} did not parse to a workflow with jobs, so this law cannot read it`);
  return parsed as Workflow;
}

function job(name: string): Job {
  const found = workflow().jobs?.[name];
  if (found === undefined) throw new Error(`the workflow has no job named '${name}', so this law is reading the wrong file or the job was renamed`);
  return found;
}

/** `image: name:tag` with a tag that is neither absent nor `latest`. */
function pinnedTag(image: string | undefined): string | null {
  if (image === undefined) return null;
  const at = image.lastIndexOf(':');
  if (at <= 0) return null; // `redis` with no tag floats
  const tag = image.slice(at + 1);
  return tag.length > 0 && tag !== 'latest' ? tag : null;
}

describe('TD-24 law — the live Redis evidence cannot go quiet', () => {
  it('TD24-CI-A: the backend job defines a pinned redis service and passes REDIS_URL to the integration step', () => {
    const backend = job('backend');
    const services = backend.services ?? {};

    // POSITIVE CONTROL, first: the service that has been there all along is
    // visible to this probe. A parse that saw nothing would fail HERE rather
    // than reporting a missing redis.
    expect(pinnedTag(services['postgres']?.image)).not.toBe(null);

    expect(Object.keys(services)).toContain('redis');
    // Pinned, not floating: a moving tag would make a later green run a
    // statement about a different server than acceptance was read on.
    expect(pinnedTag(services['redis']?.image)).not.toBe(null);

    const steps = backend.steps ?? [];
    expect(steps.length).toBeGreaterThan(0); // the input was not empty
    const integration = steps.filter((step) => typeof step.run === 'string' && step.run.includes('test:integration'));
    expect(integration.length).toBeGreaterThan(0);
    // EVERY step that runs the lane must carry the URL — one that does not
    // would silently skip the live cases.
    for (const step of integration) {
      const url = step.env?.['REDIS_URL'];
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^redis:\/\/\S+$/);
    }
  });

  it('TD24-CI-B (negative control): a job that should not have the service does not have it', () => {
    // Without this, TD24-CI-A would be satisfied by a probe that answers
    // "present" for anything asked of it.
    for (const name of ['workspaces', 'web-admin']) {
      expect(Object.keys(job(name).services ?? {})).not.toContain('redis');
    }
  });

  it('TD24-CI-C: the lane that job runs is the lane the live suite lives in', () => {
    // The service is pointless if the suite that needs it is not reached.
    // `test:integration` is asserted to name `tests/security`, where
    // `td24-redis-live.test.ts` lives, so a narrowing of that script also
    // fails here.
    const pkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    const integration = scripts['test:integration'];
    expect(typeof integration).toBe('string');
    expect(integration).toContain('tests/security');
  });
});
