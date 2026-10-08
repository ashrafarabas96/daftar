/**
 * §21, as an executed law: an add-on may not sell a meter the system does not
 * measure.
 *
 * The owner's words: "DO NOT SELL OR ENFORCE A METERED ADD-ON WHOSE USAGE
 * METER IS NOT REAL … No customer can be charged for a meter the system does
 * not measure."
 *
 * A rule like that cannot be tested against a list this package keeps,
 * because a list this package keeps is exactly the thing that goes stale the
 * day the entitlement engine starts or stops measuring something. So this
 * suite reads BOTH sides from their owners:
 *
 *   the REGISTERED keys  ← `limit_definitions`, seeded in the migrations
 *   the MEASURED keys    ← the `case` labels of `getUsage`'s own `switch`
 *
 * and asserts the gap between them, then proves `priceAddOn` refuses every
 * key in that gap. A fourth measured key appearing in the engine reds the
 * equality below; a regression that stops measuring one reds it too; and a
 * seventh registered key reds the registry assertion until someone decides
 * whether it may be sold.
 *
 * ── Why the extraction is asserted non-vacuous ──────────────────────────
 *
 * A regex that matched nothing would produce an empty measured set, every
 * refusal below would still pass, and the suite would be green while
 * asserting nothing. So the extractors state what they must find and fail if
 * they do not: the `switch` on `limitKey`, its `default` branch, the three
 * case labels, and six registered keys.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { priceAddOn } from '../src/addons';
import { BillingError } from '../src/errors';
import type { BillingPeriod } from '../src/types';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ENGINE = join(REPO_ROOT, 'apps', 'api', 'src', 'modules', 'entitlements', 'entitlements.service.ts');
const MIGRATIONS = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');

const APRIL: BillingPeriod = { startsAt: '2026-04-01T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' };

function expectRefusal(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
}

/**
 * The body of `getUsage`, from its signature to the closing brace of the
 * method, located by brace depth rather than by a line count so an edit above
 * it cannot silently move the window.
 */
function getUsageBody(source: string): string {
  const start = source.indexOf('async getUsage(');
  expect(start, 'getUsage was not found in the live entitlement engine').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  expect(open, "getUsage's body was not found").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('getUsage has no closing brace');
}

/** The limit keys `getUsage` actually measures: its own `case` labels. */
function measuredLimitKeys(source: string): string[] {
  const body = getUsageBody(source);
  expect(body, 'getUsage must switch on the limit key for this extraction to mean anything').toContain('switch (limitKey)');
  expect(body, 'getUsage must have the default branch this law is about').toContain('default:');
  const keys = [...body.matchAll(/case '([A-Z0-9_]+)':/g)].map((m) => m[1] as string);
  return [...new Set(keys)].sort();
}

/** Every key `limit_definitions` registers, from the migration that seeds it. */
function registeredLimitKeys(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  expect(files.length, 'no migrations were found; the path this suite reads is wrong').toBeGreaterThan(20);
  const keys: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const insert = /INSERT\s+INTO\s+limit_definitions[\s\S]*?;/gi;
    for (const block of sql.match(insert) ?? []) {
      for (const m of block.matchAll(/\(\s*'([A-Z0-9_]+)'/g)) keys.push(m[1] as string);
    }
  }
  return [...new Set(keys)].sort();
}

const ENGINE_SOURCE = readFileSync(ENGINE, 'utf8');
const MEASURED = measuredLimitKeys(ENGINE_SOURCE);
const REGISTERED = registeredLimitKeys();
const UNMEASURED = REGISTERED.filter((k) => !MEASURED.includes(k));

describe('the measured set, read from the live entitlement engine', () => {
  it('extracts exactly the three keys getUsage measures', () => {
    // Restated here so a change on either side is a conversation and not a
    // silently updated expectation. These three are the only `case` labels in
    // `getUsage`; everything else falls to `default: return 0`.
    expect(MEASURED).toEqual(['MAX_BRANCHES', 'MAX_PRODUCTS', 'MAX_USERS']);
  });

  it('extracts the six keys limit_definitions registers', () => {
    expect(REGISTERED).toEqual(['MAX_AI_USAGE', 'MAX_BRANCHES', 'MAX_PRODUCTS', 'MAX_STORAGE', 'MAX_USERS', 'MAX_WHATSAPP_USAGE']);
  });

  it('names the registered keys that are NOT measured — the subject of §21', () => {
    // This is `FINDING-P5-02`, as an assertion rather than a sentence in a
    // document. The three keys below are registered in the registry, carry a
    // `measurement_strategy` that describes an intent, and read 0 from
    // `getUsage` forever. A quota check against 0 always passes.
    expect(UNMEASURED).toEqual(['MAX_AI_USAGE', 'MAX_STORAGE', 'MAX_WHATSAPP_USAGE']);
  });

  it('is not an empty extraction', () => {
    // Guards the one way every other case in this file could pass vacuously.
    expect(MEASURED.length).toBe(3);
    expect(UNMEASURED.length).toBe(3);
  });
});

describe('priceAddOn under §21', () => {
  const base = { kind: 'flat' as const, unitPrice: { amountMinor: 4_900n, currency: 'ILS' }, quantity: 1 };

  it('refuses an add-on that grants each unmeasured limit key', () => {
    expect(UNMEASURED.length).toBeGreaterThan(0);
    for (const key of UNMEASURED) {
      expectRefusal(() => priceAddOn({ ...base, key: `SELLS_${key}`, grantsLimitKey: key }, APRIL, MEASURED), 'billing.addon_meter_unmeasured');
    }
  });

  it('names the add-on and the key in the refusal, and no amount', () => {
    let caught: BillingError | undefined;
    try {
      priceAddOn({ ...base, key: 'STORAGE_PACK_100GB', grantsLimitKey: 'MAX_STORAGE' }, APRIL, MEASURED);
    } catch (e) {
      caught = e as BillingError;
    }
    expect(caught).toBeInstanceOf(BillingError);
    const safe = (caught as BillingError).toSafeJSON();
    expect(safe).toEqual({ code: 'billing.addon_meter_unmeasured', addOnKey: 'STORAGE_PACK_100GB', limitKey: 'MAX_STORAGE' });
    // A refusal is read by logs and by support; a price is not theirs to see.
    expect(JSON.stringify(safe)).not.toMatch(/4900|4_900/);
  });

  it('prices an add-on that grants a measured limit key, and echoes the key back', () => {
    for (const key of MEASURED) {
      const result = priceAddOn({ ...base, key: `PACK_${key}`, grantsLimitKey: key }, APRIL, MEASURED);
      expect(result.amountMinor).toBe(4_900n);
      expect(result.grantsLimitKey).toBe(key);
    }
  });

  it('prices an add-on that grants no limit key at all', () => {
    const result = priceAddOn({ ...base, key: 'PRIORITY_SUPPORT' }, APRIL, MEASURED);
    expect(result.amountMinor).toBe(4_900n);
    expect(result.grantsLimitKey).toBeUndefined();
  });

  it('fails CLOSED: an empty measured set refuses even a key the engine measures', () => {
    // The direction of the failure is the point. A caller that does not know
    // its meters sells nothing, rather than selling everything.
    expectRefusal(() => priceAddOn({ ...base, key: 'EXTRA_USER', grantsLimitKey: 'MAX_USERS' }, APRIL, []), 'billing.addon_meter_unmeasured');
  });

  it('refuses when the measured set is not supplied at all', () => {
    // There is no optional registry and so no bypass seam: the argument is
    // required by the type, and a caller that defeats the type still refuses.
    expectRefusal(
      () => priceAddOn({ ...base, key: 'EXTRA_USER', grantsLimitKey: 'MAX_USERS' }, APRIL, undefined as unknown as string[]),
      'billing.payload_invalid',
    );
  });

  it('refuses a granted limit key that is not a key', () => {
    expectRefusal(() => priceAddOn({ ...base, key: 'X', grantsLimitKey: '   ' }, APRIL, MEASURED), 'billing.payload_invalid');
  });
});
