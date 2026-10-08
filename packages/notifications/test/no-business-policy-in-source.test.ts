import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogEntries } from '../src/catalog';

/**
 * §41 / §94 — no business policy is invented in source.
 *
 * A statement cadence, an instalment reminder lead time and an operational
 * recipient list are business configuration. This suite reads the package's own
 * source and refuses a default for any of them, so the rule is measured rather
 * than promised.
 */
const SRC = join(__dirname, '..', 'src');

function sources(dir: string = SRC): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!name.endsWith('.ts')) return [];
    return [{ file: path.slice(SRC.length + 1), text: readFileSync(path, 'utf8') }];
  });
}

/** Comments are prose about policy; code is policy. Only code is judged. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no business policy in source', () => {
  const files = sources();

  it('has a non-empty subject', () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
    expect(files.some((f) => f.file === 'catalog.ts')).toBe(true);
  });

  it('declares every scheduled kind as requiring configuration', () => {
    const scheduled = catalogEntries().filter((e) => e.trigger.source === 'schedule');
    expect(scheduled.length).toBeGreaterThan(0);
    for (const entry of scheduled) {
      if (entry.trigger.source !== 'schedule') continue;
      expect(entry.trigger.requiresConfiguration, entry.kind).toBe(true);
    }
  });

  it('holds no cadence, no cron expression and no reminder lead default', () => {
    const forbidden: readonly [string, RegExp][] = [
      ['the word cron', /\bcron\b/i],
      ['a five-field cron expression', /['"`][\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+['"`]/],
      ['a lead time default', /lead(Days|Hours|Minutes)\s*[=:]\s*\d/i],
      ['a cadence default', /\b(cadence|interval|everyDays|dayOfMonth)\s*[=:]\s*\d/i],
      ['a reminder-days default', /reminder\w*\s*[=:]\s*\d/i],
    ];
    for (const file of files) {
      const code = codeOnly(file.text);
      for (const [what, pattern] of forbidden) {
        expect(pattern.test(code), `${file.file} contains ${what}`).toBe(false);
      }
    }
  });

  it('the scan can fail: the same patterns match a planted default', () => {
    const planted = "const leadDays = 3;\nconst dayOfMonth = 1;\nconst schedule = '0 9 1 * *';\n";
    expect(/lead(Days|Hours|Minutes)\s*[=:]\s*\d/i.test(planted)).toBe(true);
    expect(/\b(cadence|interval|everyDays|dayOfMonth)\s*[=:]\s*\d/i.test(planted)).toBe(true);
    expect(/['"`][\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+['"`]/.test(planted)).toBe(true);
  });

  it('contains no scheduler, no timer and no clock read', () => {
    for (const file of files) {
      const code = codeOnly(file.text);
      expect(/Date\.now\(|new Date\(|setInterval\(|setTimeout\(/.test(code), `${file.file} reads a clock or sets a timer`).toBe(false);
    }
  });
});
