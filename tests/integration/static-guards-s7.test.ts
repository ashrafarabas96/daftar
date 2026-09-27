import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_SURFACE, MODULE_CACHE, findReadSurfaceViolations, readSurfaceFiles } from '../../scripts/guards/read-surface';
import { RESPONSIVE_RULES, findResponsiveViolations, responsiveSurface } from '../../scripts/guards/web-responsive';
import { findS7SourceViolations, isS7WebFile } from '../../scripts/guards/merchant-jargon';

/**
 * P3-S7 guards (contract §7.2(b), (c); rulings header on G-6): Rule 23 and the
 * widened G-6 are each shown RED on a planted violation — an in-memory string,
 * never an edit of a real file — and GREEN on the real tree. A guard that
 * cannot be made to fail is not a guard.
 */

const ROOT = join(__dirname, '../..');

function readTree(dir: string, ext: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      if (e === 'node_modules' || e === 'dist' || e === '.next') continue;
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (ext.test(e)) out[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(join(ROOT, dir));
  return out;
}

describe('Rule 23 — the responsive law over S7 web files (§7.2(c), A-16)', () => {
  const view = 'apps/web/src/views/stock/StockList.tsx';
  const rules = (source: string, file = view): string[] => findResponsiveViolations({ [file]: source }).map((v) => v.rule);

  it('the S7 surface is the stock, purchases and suppliers pages, the views and the phase3 libraries — nothing else', () => {
    for (const p of [
      'apps/web/src/app/[locale]/stock/page.tsx',
      'apps/web/src/app/[locale]/purchases/[purchaseId]/return/page.tsx',
      'apps/web/src/app/[locale]/suppliers/[supplierId]/pay/page.tsx',
      'apps/web/src/views/suppliers/PaySupplierForm.tsx',
      'apps/web/src/lib/phase3-api.ts',
      'apps/web/src/lib/phase3-format.ts',
    ]) {
      expect(isS7WebFile(p), p).toBe(true);
    }
    for (const p of [
      'apps/web/src/app/[locale]/catalog/page.tsx',
      'apps/web/src/app/[locale]/AppHeader.tsx',
      'apps/web/src/lib/client.ts',
      'apps/web/test/fixtures/views/probe-views.tsx',
      'apps/admin/src/views/stock/X.tsx',
    ]) {
      expect(isS7WebFile(p), p).toBe(false);
    }
  });

  it('fires on a physical side and not on its logical counterpart', () => {
    for (const bad of [
      `<p style={{ marginLeft: '1rem' }} />`,
      `<p style={{ paddingRight: 4 }} />`,
      `<p style={{ borderLeftWidth: 1 }} />`,
      `<p style={{ textAlign: 'right' }} />`,
      `<p style={{ position: 'absolute', left: 0 }} />`,
      `<p style={{ float: 'left' }} />`,
    ]) {
      expect(rules(bad), bad).toContain('physical direction');
    }
    for (const good of [
      `<p style={{ marginInlineStart: '1rem', paddingInlineEnd: 4, textAlign: 'start', insetInlineStart: 0 }} />`,
      `<p style={{ borderInlineStartWidth: 1 }} />`,
    ]) {
      expect(rules(good), good).toEqual([]);
    }
  });

  it('fires on a fixed width above 20rem, and not at or under it', () => {
    expect(rules(`<div style={{ width: '25rem' }} />`)).toContain('fixed width above 20rem');
    expect(rules(`<div style={{ minWidth: 400 + 'px' }} />`)).toEqual([]); // a computed width is the SSR suite's to catch
    expect(rules(`<div style={{ minWidth: '400px' }} />`)).toContain('fixed width above 20rem');
    expect(rules(`<div style={{ flexBasis: '21rem' }} />`)).toContain('fixed width above 20rem');
    expect(rules(`<div style={{ width: '20rem', minWidth: '320px', flexBasis: '10rem' }} />`)).toEqual([]);
  });

  it('fires on 100vw', () => {
    expect(rules(`<div style={{ width: '100vw' }} />`)).toContain('100vw');
  });

  it('fires on the design-system Table, and not on List', () => {
    expect(rules(`import { Card, Table } from '@daftar/design-system';`)).toContain('design-system Table');
    expect(rules(`import {\n  Button,\n  Table,\n} from '@daftar/design-system';`)).toContain('design-system Table');
    expect(rules(`import { Card, List } from '@daftar/design-system';`)).toEqual([]);
  });

  it('fires on a raw button or a clickable anchor, and not on a plain link', () => {
    expect(rules(`<button type="button">x</button>`)).toContain('raw clickable element');
    expect(rules(`<a href="#" onClick={go}>x</a>`)).toContain('raw clickable element');
    expect(rules(`<a href="/en/stock">x</a>`)).toEqual([]);
  });

  it('fires on a small Button in either spelling', () => {
    expect(rules(`<Button size="sm">x</Button>`)).toContain('small button');
    expect(rules(`<Button size={'sm'}>x</Button>`)).toContain('small button');
    expect(rules(`const props = { size: 'sm' };`)).toContain('small button');
    expect(rules(`<Button fullWidth>x</Button>`)).toEqual([]);
  });

  it('fires on Number()/parseFloat/parseInt of a quantity or amount, and not of a page size', () => {
    for (const bad of [`Number(row.qty)`, `parseFloat(amountText)`, `parseInt(line.quantity, 10)`, `Number(totalMinor)`, `Number(unitCost)`]) {
      expect(rules(`const x = ${bad};`), bad).toContain('number conversion of a quantity or amount');
    }
    expect(rules(`const n = Number(limitText);`)).toEqual([]);
  });

  it('every rule carries its reason, and a comment naming the forbidden thing does not trip it', () => {
    for (const rule of RESPONSIVE_RULES) expect(rule.why, rule.name).toMatch(/A-16|DS:113|Rule 6b|A-17/);
    expect(rules(`/** Never marginLeft, never 100vw, never <button>. */\n// size="sm" is refused\nexport const x = 1;`)).toEqual([]);
  });

  it('ignores files outside the S7 surface', () => {
    expect(rules(`<button style={{ marginLeft: '100vw' }} />`, 'apps/web/src/app/[locale]/catalog/page.tsx')).toEqual([]);
  });

  it('the real S7 web files pass, and there are some to check', () => {
    const files = readTree('apps/web/src', /\.tsx?$/);
    expect(responsiveSurface(files).length).toBeGreaterThanOrEqual(3);
    expect(findResponsiveViolations(files)).toEqual([]);
    expect(findS7SourceViolations(files)).toEqual([]);
  });
});

describe('G-6 widened to the merchant read modules (§7.2(b); rulings header)', () => {
  const inventory = 'apps/api/src/modules/inventory/inventory-reads.ts';
  const supplier = 'apps/api/src/modules/purchasing/supplier-balance-reads.ts';
  const check = (source: string, file = inventory): string[] => findReadSurfaceViolations({ [file]: source }).map((v) => v.rule);

  it('watches inventory-reads.ts and supplier-balance-reads.ts, and NOT purchasing-reads.ts', () => {
    expect(READ_SURFACE.test(inventory)).toBe(true);
    expect(READ_SURFACE.test(supplier)).toBe(true);
    expect(READ_SURFACE.test('apps\\api\\src\\modules\\purchasing\\supplier-balance-reads.ts')).toBe(true);
    // S6's command-side FX binding (readSettlementFx) lives there and must look the rate up.
    expect(READ_SURFACE.test('apps/api/src/modules/purchasing/purchasing-reads.ts')).toBe(false);
    expect(READ_SURFACE.test('apps/api/src/modules/inventory/inventory-reads.controller.ts')).toBe(false);
    expect(READ_SURFACE.test('apps/api/src/modules/inventory/inventory-movements.service.ts')).toBe(false);
  });

  it('keeps the accounting surface it had', () => {
    for (const p of [
      'apps/api/src/modules/accounting/accounting-reports.reader.ts',
      'apps/api/src/modules/accounting/accounting-reports.service.ts',
      'packages/accounting/src/reports.ts',
    ]) {
      expect(READ_SURFACE.test(p), p).toBe(true);
    }
  });

  it('fires on a write to a stock or supplier table inside a merchant read', () => {
    expect(check('const sql = `UPDATE stock_levels SET on_hand = $1`;')).toContain('no write to an accounting table');
    expect(check('const sql = `INSERT INTO purchases (id) VALUES ($1)`;', supplier)).toContain('no write to an accounting table');
    expect(check('const sql = `DELETE FROM supplier_credit_notes WHERE id = $1`;', supplier)).toContain('no write to an accounting table');
  });

  it('fires on OFFSET, a current FX lookup and a quantity or balance turned into a double', () => {
    expect(check('const sql = `SELECT 1 FROM stock_levels ORDER BY product_id LIMIT $1 OFFSET $2`;')).toContain('no OFFSET pagination');
    expect(check('const sql = `SELECT accounting_fx_rate_lookup($1, $2, now())`;', supplier)).toContain('no current exchange-rate lookup');
    expect(check('const q = Number(row.on_hand);')).toContain('no floating-point parse of an amount');
    expect(check('const q = parseFloat(row.qty);')).toContain('no floating-point parse of an amount');
    expect(check('const size = Number(limitText);')).toEqual([]);
  });

  it('fires on an is_active filter over stock or settlement history', () => {
    expect(check('const sql = `SELECT 1 FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id WHERE w.is_active`;')).toContain(
      'no historical filter on accounts.is_active',
    );
    expect(check('const sql = `SELECT n.id FROM supplier_credit_notes n JOIN suppliers s ON s.id = n.supplier_id WHERE s.is_active`;', supplier)).toContain(
      'no historical filter on accounts.is_active',
    );
  });

  it('fires on a module-level result cache in each spelling (T-02 negative fixture)', () => {
    for (const bad of [
      'const cache = new Map();',
      'export const seen: Map<string, string> = new Map();',
      'let rows = new WeakMap();',
      "import { createClient } from 'redis';",
      "import { LRUCache } from 'lru-cache';",
      "const r = require('ioredis');",
      'class X { @Memoize() read() {} }',
      'const read = memoize(load);',
    ]) {
      expect(check(bad), bad).toContain('no module-level result cache');
      expect(MODULE_CACHE.test(bad), bad).toBe(true);
    }
    // A Map built inside a function lives for one request.
    expect(check('export function group(rows: Row[]) {\n  const byId = new Map();\n  return byId;\n}')).toEqual([]);
  });

  it('the real read surface passes every rule', () => {
    const files: Record<string, string> = { ...readTree('apps/api/src', /\.ts$/), ...readTree('packages', /\.ts$/) };
    expect(readSurfaceFiles(files).length).toBeGreaterThanOrEqual(3);
    expect(findReadSurfaceViolations(files)).toEqual([]);
  });
});
