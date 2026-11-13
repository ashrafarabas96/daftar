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
 * ── HOW IT IS CHECKED, AND WHICH PARSER ──────────────────────────────────
 *
 * The workflow is PARSED, not grepped. A regex over YAML would match a
 * service named in a comment, or in a different job, and would miss a block
 * that moved — and `ci.yml` is edited by several lanes at once, so a law over
 * its text would be brittle in exactly the way that produces false reds.
 *
 * It is read with a SMALL STRICT READER in this file, and neither with
 * `js-yaml` nor with the parser `required-ci-chain-composition.test.ts`
 * exports. Both were tried and both were measured wrong for this job:
 *
 *   — `js-yaml` is only a transitive dev-dependency of ESLint, ships no type
 *     declarations, and `@types/js-yaml` is not installed, so `npm run
 *     typecheck` cannot compile an import of it. The first version of this
 *     law imported it; the root `tsc -p tsconfig.json` passed and CI's
 *     `Typecheck` step — which also runs the WORKSPACE typechecks — failed
 *     with TS7016. A permanent law may not rest on a package nothing
 *     declares.
 *   — importing the exported parser from that GUARD runs the guard's own
 *     module, so its 37 tests were collected and executed inside this file
 *     (measured: this suite reported 40 tests). That makes this law's result
 *     depend on another lane's suite passing, which is precisely the kind of
 *     false red a law must not have.
 *
 * So the reader below does one thing: slice a top-level job block by
 * indentation and read the two mappings this law asks about. It is STRICT —
 * a boundary it cannot find is a named error, never a silently empty result,
 * because an empty result is how a structural check turns vacuous.
 *
 * Three claims, each with its control:
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

const ROOT = join(__dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

/** Every line of the workflow, without trailing carriage returns. */
function lines(): string[] {
  return readFileSync(WORKFLOW, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
}

/** Indentation of a line, or null for a blank or comment-only line. */
function indentOf(line: string): number | null {
  if (line.trim().length === 0 || line.trim().startsWith('#')) return null;
  return line.length - line.trimStart().length;
}

/**
 * The lines of the block introduced by `key` at `indent`, exclusive of the
 * key line: every following line indented deeper, stopping at the first line
 * at or below `indent`. Blank and comment lines are carried through so a
 * block is never cut short by one.
 */
function block(all: string[], from: number, indent: number): string[] {
  const out: string[] = [];
  for (let i = from; i < all.length; i += 1) {
    const at = indentOf(all[i] ?? '');
    if (at !== null && at <= indent) break;
    out.push(all[i] ?? '');
  }
  return out;
}

/** The line index of `key` at exactly `indent`, within `all`, or a named refusal. */
function keyLine(all: string[], key: string, indent: number, what: string): number {
  const prefix = `${' '.repeat(indent)}${key}:`;
  const found = all.findIndex((line) => line === prefix || line.startsWith(`${prefix} `));
  if (found < 0) throw new Error(`${what} was not found in ci.yml, so this law cannot read it`);
  return found;
}

/** The body of a named job (jobs are at indent 2 in this workflow). */
function job(name: string): string[] {
  const all = lines();
  const at = keyLine(all, name, 2, `job '${name}'`);
  const body = block(all, at + 1, 2);
  if (body.length === 0) throw new Error(`job '${name}' has an empty body in ci.yml, so this law cannot read it`);
  return body;
}

/** The immediate child keys of `key` inside `body`, with the rest of each key's line. */
function childKeys(body: string[], key: string, what: string): Map<string, string[]> {
  const at = keyLine(body, key, 4, what);
  const inner = block(body, at + 1, 4);
  const out = new Map<string, string[]>();
  for (let i = 0; i < inner.length; i += 1) {
    const line = inner[i] ?? '';
    const indent = indentOf(line);
    if (indent !== 6) continue;
    const name = line.trim().replace(/:.*$/, '');
    out.set(name, block(inner, i + 1, 6));
  }
  return out;
}

/** `services:` of a job as name -> its lines; an empty map when it declares none. */
function services(name: string): Map<string, string[]> {
  const body = job(name);
  try {
    return childKeys(body, 'services', `the services of job '${name}'`);
  } catch {
    return new Map(); // declares none — which TD24-CI-B asserts for some jobs
  }
}

/** The `image:` value inside a service's lines. */
function imageOf(serviceLines: string[] | undefined): string | undefined {
  const line = (serviceLines ?? []).find((l) => l.trim().startsWith('image:'));
  return line === undefined ? undefined : line.trim().slice('image:'.length).trim();
}

/**
 * The steps of a job that run `needle`, each with the lines of its own `env:`
 * mapping (empty when it has none).
 */
function stepsRunning(name: string, needle: string): { run: string; env: string[] }[] {
  const body = job(name);
  const at = keyLine(body, 'steps', 4, `the steps of job '${name}'`);
  const inner = block(body, at + 1, 4);
  const out: { run: string; env: string[] }[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const line = inner[i] ?? '';
    if (!line.trimStart().startsWith('- ')) continue;
    const stepIndent = indentOf(line) ?? 6;
    const stepLines = [line.replace(/^(\s*)- /, '$1  '), ...block(inner, i + 1, stepIndent)];
    const run = stepLines.find((l) => l.trim().startsWith('run:'));
    if (run === undefined || !run.includes(needle)) continue;
    const envAt = stepLines.findIndex((l) => l.trim() === 'env:');
    const env = envAt < 0 ? [] : block(stepLines, envAt + 1, indentOf(stepLines[envAt] ?? '') ?? 0);
    out.push({ run: run.trim(), env });
  }
  return out;
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
    const declared = services('backend');

    // POSITIVE CONTROL, first: the service that has been there all along is
    // visible to this reader. A slice that read nothing would fail HERE
    // rather than reporting a missing redis.
    expect(pinnedTag(imageOf(declared.get('postgres')))).not.toBe(null);

    expect([...declared.keys()]).toContain('redis');
    // Pinned, not floating: a moving tag would make a later green run a
    // statement about a different server than acceptance was read on.
    expect(pinnedTag(imageOf(declared.get('redis')))).not.toBe(null);

    const integration = stepsRunning('backend', 'test:integration');
    expect(integration.length).toBeGreaterThan(0); // the input was not empty
    // EVERY step that runs the lane must carry the URL — one that does not
    // would silently skip the live cases.
    for (const step of integration) {
      const url = step.env.find((l) => l.trim().startsWith('REDIS_URL:'));
      expect(typeof url).toBe('string');
      expect((url ?? '').trim().slice('REDIS_URL:'.length).trim()).toMatch(/^redis:\/\/\S+$/);
    }
  });

  it('TD24-CI-B (negative control): a job that should not have the service does not have it', () => {
    // Without this, TD24-CI-A would be satisfied by a reader that answers
    // "present" for anything asked of it.
    for (const name of ['workspaces', 'web-admin']) {
      expect([...services(name).keys()]).not.toContain('redis');
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
