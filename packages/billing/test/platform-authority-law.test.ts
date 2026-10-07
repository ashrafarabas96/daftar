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

// ───────────────────────────────────────────────────────────────────────────
// The blanker
// ───────────────────────────────────────────────────────────────────────────

/**
 * Replace the CONTENTS of comments, string literals, template literals and
 * regular-expression literals with spaces, preserving the source's length and
 * line structure so an offset in the result is an offset in the original.
 *
 * Delimiters are kept, so `'x'` becomes `' '` and `// y` becomes `//  `. That
 * is what lets a later scan still see that a string was there without being
 * able to read what was in it.
 *
 * The regex-literal state is the one that matters and the one that is usually
 * missing: a `/…/` containing an apostrophe flips quote parity for everything
 * after it, and both the blanked and the unblanked view still return a
 * correct-LENGTH string, so the damage is invisible to a length check.
 */
export function blankOut(source: string): string {
  const out = source.split('');
  let i = 0;
  /** The last significant character, for the regex-or-division decision. */
  let lastSignificant = '';
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n') j++;
      blank(i + 2, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      blank(i + 2, j);
      i = Math.min(j + 2, source.length);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      blank(i + 1, j);
      lastSignificant = c;
      i = Math.min(j + 1, source.length);
      continue;
    }
    if (c === '/') {
      // Division or a regex literal. A `/` starts a regex unless the previous
      // significant character could end an expression — an identifier
      // character, a closing bracket, or a quote (a completed literal).
      const dividable = /[A-Za-z0-9_$)\]'"`]/.test(lastSignificant);
      if (!dividable) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length) {
          const d = source[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '\n') break; // an unterminated regex; stop rather than eat the file
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        blank(i + 1, j);
        lastSignificant = '/';
        i = Math.min(j + 1, source.length);
        continue;
      }
    }
    if (!/\s/.test(c ?? '')) lastSignificant = c ?? '';
    i++;
  }
  return out.join('');
}

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
// The blanker's own fixtures — a blanker nobody tested is the defect
// ───────────────────────────────────────────────────────────────────────────

describe('blankOut', () => {
  it('preserves length and line structure exactly', () => {
    const src = "const a = 'xy';\n// note\nconst b = 1;\n";
    const out = blankOut(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('blanks a string body but keeps its delimiters', () => {
    expect(blankOut("const a = 'secret';")).toBe("const a = '      ';");
  });

  it('blanks a line comment and a block comment body', () => {
    expect(blankOut('a; // hide')).toBe('a; //     ');
    expect(blankOut('a; /* hide */ b;')).toBe('a; /*      */ b;');
  });

  it('survives a REGEX LITERAL CONTAINING A QUOTE without inverting parity for the rest of the file', () => {
    // The exact shape that once flipped quote parity and made nine laws
    // report "no subject found" instead of "defect found".
    const src = "const r = /\\bfrom\\s+'([^']+)'/g;\nconst keep = 'visible';\nx.require('k');";
    const out = blankOut(src);
    expect(out.length).toBe(src.length);
    // The code after the regex is still CODE: the call is still visible.
    expect(out).toContain('x.require(');
    // And the string after the regex was blanked, not left readable.
    expect(out).not.toContain('visible');
  });

  it('treats a division as division, not as the start of a regex', () => {
    const src = "const q = a / b; x.require('k');";
    expect(blankOut(src)).toContain('x.require(');
  });

  it('does not let an escaped quote end a string early', () => {
    const src = "const a = 'it\\'s'; x.require('k');";
    const out = blankOut(src);
    expect(out).toContain('x.require(');
  });

  it('blanks a template literal body', () => {
    expect(blankOut('const a = `abc`;')).toBe('const a = `   `;');
  });
});

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
