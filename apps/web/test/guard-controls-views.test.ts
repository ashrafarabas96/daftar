import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hiddenValues } from './helpers/layout-rules';
import { loadViewRegistries } from './helpers/render';
import { registeredFixtures, type RegisteredFixture } from './helpers/registries';

/**
 * Controls for the view-registry laws that T-08 (invisible), T-15 (phone width)
 * and T-16 share. `invisible.test.tsx` returns silently on an empty fixture
 * set, so without a count floor an emptied registry would pass every one of
 * them. Measured on the tree: 8 areas, 22 views, 134 fixtures, 12 distinct
 * hidden field names.
 *
 * `render.tsx` reads `src/views` through `node:fs`; the mock lets a ghost area
 * (views, no registry) appear there without adding a file to the tree.
 */
const state = vi.hoisted(() => ({ ghost: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readdirSync = ((path: unknown, options?: unknown) => {
    const p = String(path).split('\\').join('/');
    if (state.ghost && p.endsWith('/src/views/ghost')) return ['GhostView.tsx'];
    const real = (actual.readdirSync as (a: unknown, b?: unknown) => unknown)(path, options);
    if (state.ghost && p.endsWith('/src/views') && Array.isArray(real)) {
      const ghost = { name: 'ghost', isDirectory: () => true };
      return options ? [...real, ghost] : [...real, 'ghost'];
    }
    return real;
  }) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, readdirSync }, readdirSync };
});

describe('view registries are a non-empty set', () => {
  let loaded: Awaited<ReturnType<typeof registeredFixtures>>;
  beforeAll(async () => {
    loaded = await registeredFixtures();
  });

  it('holds at least 8 areas, 20 views and 120 fixtures', () => {
    expect(loaded.registries.length).toBeGreaterThanOrEqual(8);
    expect(loaded.registries.reduce((n, r) => n + r.entries.length, 0)).toBeGreaterThanOrEqual(20);
    expect(loaded.fixtures.length).toBeGreaterThanOrEqual(120);
  });

  it('plants at least 10 distinct hidden field names, so the "every hidden kind is covered" test is not vacuous', () => {
    const fields = new Set(loaded.fixtures.flatMap(({ fixture }: RegisteredFixture) => hiddenValues(fixture.props).map((h) => h.field)));
    expect(fields.size).toBeGreaterThanOrEqual(10);
  });
});

describe('a view area without a registry is refused', () => {
  it('the real tree loads', async () => {
    state.ghost = false;
    expect((await loadViewRegistries()).length).toBeGreaterThanOrEqual(8);
  });

  it('an area that holds views but no registry.ts throws, naming the area', async () => {
    state.ghost = true;
    try {
      await expect(loadViewRegistries()).rejects.toThrow(/src\/views\/ghost holds views but no registry\.ts/);
    } finally {
      state.ghost = false;
    }
  });
});
