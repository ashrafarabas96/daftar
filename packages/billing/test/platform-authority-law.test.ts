/**
 * THE PLATFORM AUTHORITY LAW — a Phase 5 prep artifact.
 *
 * Handed over by the Phase 4 owner (`TL-P4-COORD-R39`): the mutating routes of
 * `apps/api/src/modules/admin/admin.controller.ts` — plans, plan versions,
 * entitlement overrides, feature flags, platform roles, support sessions —
 * enforce authority in the HANDLER BODY, as
 * `await this.admin.require(userId, '<platform key>')`, and not by decorator.
 * Phase 5 owns that surface (the plan catalogue and the override grants are
 * Phase 5's own commands), so the law belongs here.
 *
 * ── Why a decorator-level law would be worse than no law ────────────────
 *
 * A law that looked for `@RequiresPermission` would report all eleven of those
 * handlers as uncovered. They are not uncovered: the file's own header says so
 * — these routes carry NO business context, authorize on PLATFORM role through
 * `AdminService.require`, and the merchant permission system is deliberately
 * never involved. A law that cannot see the body would therefore produce
 * eleven false positives, and the first person to "fix" it would reach for a
 * merchant decorator on a platform route.
 *
 * The honest law is the one the handoff states: **every mutating handler
 * demonstrates an authority check, whichever layer performs it, and the law
 * can see both layers.**
 *
 * ── Why this file holds a lexer ────────────────────────────────────────
 *
 * Because a text law over raw source is satisfied by a comment. P4-S7's H6
 * order law was `SPEC.indexOf` over unstripped source, and a planted comment
 * satisfied it while 94 cases passed. So the source is blanked first —
 * comments and string bodies replaced by spaces, length preserved — and the
 * blanker is itself fixture-tested, including a REGEX LITERAL containing a
 * quote, which is the exact shape that inverted quote parity for the rest of a
 * file once already. `admin.controller.ts` contains such a literal
 * (`UUID_RE`), so this is not a hypothetical.
 *
 * ── What this is NOT ──────────────────────────────────────────────────
 *
 * Not a CI step and not a gate: `packages/billing` is outside the npm
 * workspace list (`PATCH-REQ-P5-001`), so nothing runs it today. It is a
 * RECORD, and a lead for the tree's owner — never a verdict on their file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankOut } from './helpers/lexer';

// ───────────────────────────────────────────────────────────────────────────
// The law
// ───────────────────────────────────────────────────────────────────────────

export const MUTATING_METHODS = ['Post', 'Put', 'Patch', 'Delete'] as const;

export interface HandlerRecord {
  readonly httpMethod: string;
  readonly route: string;
  readonly handler: string;
  readonly mutating: boolean;
  /** Which layer demonstrated the authority check. Empty means none did. */
  readonly layers: readonly ('decorator' | 'body')[];
}

/**
 * Read every route handler out of a Nest controller's source and record which
 * layer, if any, demonstrates an authority check for it.
 *
 * Both detectors are deliberately present even though the subject file uses
 * only one of them: a detector that is dead on its subject is a dead constant
 * authority, and the fixture tests below are what keep both of them live.
 */
export function readHandlers(rawSource: string): HandlerRecord[] {
  const source = blankOut(rawSource);
  const records: HandlerRecord[] = [];
  // A route decorator, then any number of further decorators, then the
  // handler's name. The route string's CONTENTS are blanked, so the route is
  // recovered from the original source at the same offset.
  const routeDecorator = /@(Get|Post|Put|Patch|Delete)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = routeDecorator.exec(source)) !== null) {
    const httpMethod = match[1];
    if (httpMethod === undefined) continue;
    const decoratorStart = match.index;
    // The handler signature is the first `async <name>(` or `<name>(` at the
    // start of a line after the decorators.
    const rest = source.slice(decoratorStart);
    const sig = /\n\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    if (!sig || sig[1] === undefined) continue;
    const handler = sig[1];
    const sigAt = decoratorStart + sig.index;
    const decoratorBlock = source.slice(decoratorStart, sigAt);
    const routeText = rawSource.slice(decoratorStart, sigAt);
    const routeMatch = /@(?:Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]*)['"`]/.exec(routeText);

    // The body: from the signature to the next route decorator, or the end.
    routeDecorator.lastIndex = sigAt;
    const nextDecorator = /@(?:Get|Post|Put|Patch|Delete)\s*\(/.exec(source.slice(sigAt));
    const bodyEnd = nextDecorator ? sigAt + nextDecorator.index : source.length;
    const body = source.slice(sigAt, bodyEnd);

    const layers: ('decorator' | 'body')[] = [];
    if (/@Requires[A-Za-z]*\s*\(/.test(decoratorBlock)) layers.push('decorator');
    if (/\.\s*require\s*\(/.test(body)) layers.push('body');

    records.push({
      httpMethod,
      route: routeMatch?.[1] ?? '',
      handler,
      mutating: (MUTATING_METHODS as readonly string[]).includes(httpMethod),
      layers,
    });
  }
  return records;
}

/** The handlers the law says are uncovered. */
export function uncoveredMutatingHandlers(rawSource: string): string[] {
  return readHandlers(rawSource)
    .filter((r) => r.mutating && r.layers.length === 0)
    .map((r) => `${r.httpMethod} ${r.route} (${r.handler})`);
}

// ───────────────────────────────────────────────────────────────────────────
// The law's own fixtures — both detectors must be live, and the law must red
// ───────────────────────────────────────────────────────────────────────────

const FIXTURE_BODY_LAYER = `
@Controller('/v1/x')
export class C {
  @Post('thing')
  async makeThing(@Principal() p: P): Promise<D> {
    await this.admin.require(p.userId, 'thing.manage');
    return this.admin.makeThing();
  }
}
`;

const FIXTURE_DECORATOR_LAYER = `
@Controller('/v1/x')
export class C {
  @Post('thing')
  @RequiresPermission('thing.manage')
  async makeThing(@Body() body: unknown): Promise<D> {
    return this.svc.makeThing();
  }
}
`;

const FIXTURE_UNCHECKED = `
@Controller('/v1/x')
export class C {
  @Post('thing')
  async makeThing(@Body() body: unknown): Promise<D> {
    return this.svc.makeThing();
  }
}
`;

const FIXTURE_COMMENTED_OUT_CHECK = `
@Controller('/v1/x')
export class C {
  @Post('thing')
  async makeThing(@Body() body: unknown): Promise<D> {
    // await this.admin.require(p.userId, 'thing.manage');
    return this.svc.makeThing();
  }
}
`;

const FIXTURE_CHECK_IN_A_STRING = `
@Controller('/v1/x')
export class C {
  @Post('thing')
  async makeThing(@Body() body: unknown): Promise<D> {
    const hint = 'call this.admin.require(p.userId, k) first';
    return this.svc.makeThing(hint);
  }
}
`;

describe('the law, on fixtures', () => {
  it('sees the BODY layer', () => {
    const [record] = readHandlers(FIXTURE_BODY_LAYER);
    expect(record?.layers).toEqual(['body']);
    expect(uncoveredMutatingHandlers(FIXTURE_BODY_LAYER)).toEqual([]);
  });

  it('sees the DECORATOR layer, so that detector is not a dead constant', () => {
    const [record] = readHandlers(FIXTURE_DECORATOR_LAYER);
    expect(record?.layers).toEqual(['decorator']);
    expect(uncoveredMutatingHandlers(FIXTURE_DECORATOR_LAYER)).toEqual([]);
  });

  it('REDS on a mutating handler with no check, and names it', () => {
    expect(uncoveredMutatingHandlers(FIXTURE_UNCHECKED)).toEqual(['Post thing (makeThing)']);
  });

  it('is NOT satisfied by a commented-out check', () => {
    expect(uncoveredMutatingHandlers(FIXTURE_COMMENTED_OUT_CHECK)).toEqual(['Post thing (makeThing)']);
  });

  it('is NOT satisfied by a check that only appears inside a string', () => {
    expect(uncoveredMutatingHandlers(FIXTURE_CHECK_IN_A_STRING)).toEqual(['Post thing (makeThing)']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The live subject
// ───────────────────────────────────────────────────────────────────────────

describe('the law, on the live platform console', () => {
  const SOURCE = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'api', 'src', 'modules', 'admin', 'admin.controller.ts'), 'utf8');
  const handlers = readHandlers(SOURCE);
  const mutating = handlers.filter((h) => h.mutating);

  it('finds a non-empty handler set, with both reads and mutations', () => {
    // Non-vacuity first: an extractor that found nothing would otherwise
    // report "no uncovered handler" and pass forever.
    expect(handlers.length).toBeGreaterThan(0);
    expect(mutating.length).toBeGreaterThan(0);
    expect(handlers.filter((h) => !h.mutating).length).toBeGreaterThan(0);
  });

  it('finds the eleven mutating handlers the Phase 4 owner named, BY NAME', () => {
    // By name, not by count: a count alone is satisfied by a renamed-out
    // handler and a new one arriving together.
    expect(mutating.map((h) => h.handler).sort()).toEqual([
      'createOverride',
      'createPlan',
      'createPlanVersion',
      'createSupportSession',
      'editDraftPlanVersion',
      'grantPlatformRole',
      'publishPlanVersion',
      'revokeOverride',
      'revokeSupportSession',
      'setFeatureFlag',
      'sunsetPlanVersion',
    ]);
  });

  it('finds EVERY mutating handler covered, and all of them at the body layer', () => {
    expect(uncoveredMutatingHandlers(SOURCE)).toEqual([]);
    expect(mutating.every((h) => h.layers.includes('body'))).toBe(true);
  });

  it('records that NOT ONE of them is covered at the decorator layer', () => {
    // This is the handoff's finding, measured rather than described: a
    // decorator-level law would report eleven false positives here. It is a
    // LEAD for the tree's owner, not a defect — the file's own header says
    // these routes authorize on platform role by design.
    expect(mutating.filter((h) => h.layers.includes('decorator'))).toEqual([]);
  });
});
