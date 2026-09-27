/**
 * The real `VIEW_REGISTRY` entries, loaded once per suite, with the coverage
 * rule the SSR suites share: every S7 page area that exists must have its
 * views registered, so no screen escapes T-08, T-15 and T-16 by omission.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ViewEntry, ViewFixture } from '@/lib/phase3-format';
import { loadViewRegistries, type AreaRegistry } from './render';

const WEB = join(__dirname, '..', '..');

/** The S7 page areas (A-11) and the view area each renders through. */
export const PAGE_AREAS: Readonly<Record<string, string>> = { stock: 'stock', purchases: 'purchases', suppliers: 'suppliers' };

/** The page areas present on disk. */
export function pageAreasOnDisk(): string[] {
  return Object.keys(PAGE_AREAS).filter((area) => existsSync(join(WEB, 'src', 'app', '[locale]', area)));
}

export interface RegisteredFixture {
  readonly area: string;
  readonly entry: ViewEntry;
  readonly fixture: ViewFixture;
  readonly label: string;
}

/** Every (area, view, fixture) of the shipped registries. */
export async function registeredFixtures(): Promise<{ registries: AreaRegistry[]; fixtures: RegisteredFixture[] }> {
  const registries = await loadViewRegistries();
  const fixtures = registries.flatMap((r) =>
    r.entries.flatMap((entry) => entry.fixtures.map((fixture) => ({ area: r.area, entry, fixture, label: `${r.area}/${entry.name}/${fixture.name}` }))),
  );
  return { registries, fixtures };
}

/** Page areas that exist but whose view area has no registry. */
export function unregisteredPageAreas(registries: readonly AreaRegistry[]): string[] {
  const registered = new Set(registries.map((r) => r.area));
  return pageAreasOnDisk().filter((area) => !registered.has(PAGE_AREAS[area] ?? area));
}
