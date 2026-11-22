/**
 * P4-S1 — THE CROSS-TENANT GOLDEN IS ENUMERATED FROM THE ROUTE SURFACE, AND
 * THE PROOF THAT THE ENUMERATION CAN GO RED
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-43 scenario 8; the `cross-tenant`
 * check of scripts/phase4-s1-gate.ts; RP-XTENANT).
 *
 * `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts` proves that
 * each of the eight Phase 4 routes refuses another tenant at the API and again
 * at SQL. That suite is worth exactly as much as the guarantee that a NINTH
 * route cannot be mounted without appearing in it — because the route nobody
 * remembered to add is, by construction, the one route with no cross-tenant
 * case.
 *
 * So the gate derives the golden's subject from the controllers
 * (`discoverPhase4Routes`) and requires the golden's text to name every route
 * it finds. This suite plants a controller that mounts a route the golden does
 * not name and requires the gate to say so — and then plants the route INTO a
 * copy of the golden and requires silence, so the rule is about the missing
 * case and not about the number eight.
 *
 * The planting is done in a temporary root, never in the repository: the
 * golden and the controllers are both accepted files here.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crossTenantProblems, discoverPhase4Routes, S1_SUITES } from '../../scripts/phase4-s1-gate';

const REPO = join(__dirname, '..', '..');
const CONTROLLERS = 'apps/api/src/modules/selling';
const GOLDEN = 'tests/golden-regression/phase4/01-cross-tenant.golden.test.ts';
const temporaries: string[] = [];

/** A copy of the repository's route surface and golden, so a plant is local to one test. */
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-xtenant-'));
  temporaries.push(root);
  mkdirSync(join(root, CONTROLLERS), { recursive: true });
  cpSync(join(REPO, CONTROLLERS), join(root, CONTROLLERS), { recursive: true });
  mkdirSync(join(root, 'tests/golden-regression/phase4'), { recursive: true });
  cpSync(join(REPO, GOLDEN), join(root, GOLDEN));
  return root;
}

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A controller mounting one route on the Phase 4 surface. */
const plantedController = (path: string): string => `
import { Controller, Get } from '@nestjs/common';

@Controller('/v1')
export class PlantedController {
  @Get('${path}')
  planted(): Record<string, never> {
    return {};
  }
}
`;

/**
 * THE PLANTED PATH MUST BE ONE THE PRODUCT WILL NEVER MOUNT.
 *
 * This guard used to plant `customers/:customerId/statement`, chosen because
 * no such route existed. Then one was built (PR #139), the golden named it as
 * it must, and both RED arms went silent: the plant was no longer missing from
 * the golden, so `crossTenantProblems` reported nothing and
 * `expected [] to have a length of 1` was the result. The guard did not become
 * wrong — it became VACUOUS, which is worse, and it would have stayed green on
 * a tree where the law it protects had been broken.
 *
 * So the plant is now a path with a reserved segment no controller may serve,
 * and the arm below PROVES it absent from the real surface before any plant is
 * written. If anybody ever mounts it, this guard fails by name instead of
 * quietly losing its subject.
 */
const PLANTED_PATH = 'customers/:customerId/__cross-tenant-probe';
const PLANTED_ROUTE = `GET /v1/${PLANTED_PATH}`;

describe('the plant itself is a usable control', () => {
  it('the planted route is ABSENT from the real route surface, so planting it means something', () => {
    const discovered = discoverPhase4Routes(REPO);
    expect(discovered.length, 'an empty surface would make every claim below vacuous').toBeGreaterThan(0);
    expect(
      discovered,
      `${PLANTED_ROUTE} is now a real route — this guard has lost its subject and the plant must be renamed, not the assertion relaxed`,
    ).not.toContain(PLANTED_ROUTE);
  });
});

describe('the golden is declared as this gate’s subject', () => {
  it('a real golden row carries the cross-tenant file, so the check reads a file and not an empty string', () => {
    const files = S1_SUITES.flatMap((e) => ('file' in e && e.area === 'golden' ? [e.file] : []));
    expect(files, 'no S1_SUITES golden row names the cross-tenant golden').toContain(GOLDEN);
  });

  it('the repository as it stands is silent: every discovered route is named by the golden', () => {
    expect(crossTenantProblems(REPO)).toEqual([]);
    // The silence is not the silence of an empty subject.
    expect(discoverPhase4Routes(REPO).length).toBeGreaterThan(0);
    expect(readFileSync(join(REPO, GOLDEN), 'utf8')).toContain('/v1/invoices/:invoiceId/settlement');
  });
});

describe('RED: a planted Phase 4 route with no cross-tenant case is named', () => {
  it('a ninth route the golden does not mention is a finding, and the finding names it', () => {
    const root = sandbox();
    writeFileSync(join(root, CONTROLLERS, 'planted.controller.ts'), plantedController(PLANTED_PATH));
    const problems = crossTenantProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`/v1/${PLANTED_PATH}`);
    expect(problems[0]).toContain('enumerated from the route surface');
  });

  it('NOT A FINDING: the same route, once the golden names it', () => {
    const root = sandbox();
    writeFileSync(join(root, CONTROLLERS, 'planted.controller.ts'), plantedController(PLANTED_PATH));
    const golden = join(root, GOLDEN);
    writeFileSync(golden, `${readFileSync(golden, 'utf8')}\n// '${PLANTED_ROUTE}'\n`);
    expect(crossTenantProblems(root)).toEqual([]);
  });

  it('a route mounted on a DIFFERENT Phase 4 prefix is caught too, so the rule is not about the customers path', () => {
    const root = sandbox();
    writeFileSync(join(root, CONTROLLERS, 'planted.controller.ts'), plantedController('invoices/:invoiceId/history'));
    const problems = crossTenantProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/v1/invoices/:invoiceId/history');
  });

  it('two planted routes are two findings: the check reports every missing case, not the first', () => {
    const root = sandbox();
    writeFileSync(
      join(root, CONTROLLERS, 'planted.controller.ts'),
      `
import { Controller, Get } from '@nestjs/common';

@Controller('/v1')
export class PlantedController {
  @Get('${PLANTED_PATH}')
  a(): Record<string, never> {
    return {};
  }

  @Get('invoices/:invoiceId/history')
  b(): Record<string, never> {
    return {};
  }
}
`,
    );
    expect(crossTenantProblems(root)).toHaveLength(2);
  });
});
