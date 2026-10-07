import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogEntries } from '../src/catalog';

/**
 * The catalog claims to subscribe to outbox event types that EXIST. This suite
 * reads the live migrations and checks each claim against them, so a renamed
 * event type or a dropped payload key turns this red instead of producing a
 * notification pipeline that silently never fires.
 *
 * It is the opposite of a comment citing a check: the subject is the repository
 * itself, and the suite refuses to pass over an empty or unreadable subject.
 */
const MIGRATIONS = join(__dirname, '..', '..', '..', 'infrastructure', 'database', 'migrations');

function migrationSources(): readonly { readonly file: string; readonly sql: string }[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  return files.map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), 'utf8') }));
}

describe('catalog claims against the live migration tree', () => {
  const sources = migrationSources();

  it('has a non-empty subject (no vacuous green)', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.some((s) => s.sql.includes('INSERT INTO outbox_events'))).toBe(true);
  });

  it('every outbox event type the catalog subscribes to is written by a migration', () => {
    const outboxKinds = catalogEntries().filter((e) => e.trigger.source === 'outbox');
    expect(outboxKinds.length).toBeGreaterThan(0);
    for (const entry of outboxKinds) {
      if (entry.trigger.source !== 'outbox') continue;
      const literal = `'${entry.trigger.eventType}'`;
      const writers = sources.filter((s) => s.sql.includes('INSERT INTO outbox_events') && s.sql.includes(literal));
      expect(writers.length, `${entry.kind} → ${entry.trigger.eventType}`).toBeGreaterThan(0);
    }
  });

  it('every payload key the catalog reads is built by that event write', () => {
    for (const entry of catalogEntries()) {
      if (entry.trigger.source !== 'outbox') continue;
      const literal = `'${entry.trigger.eventType}'`;
      const bodies = sources
        .filter((s) => s.sql.includes(literal))
        .flatMap((s) => {
          const out: string[] = [];
          let from = s.sql.indexOf(literal);
          while (from !== -1) {
            out.push(s.sql.slice(from, from + 900));
            from = s.sql.indexOf(literal, from + 1);
          }
          return out;
        });
      expect(bodies.length, entry.trigger.eventType).toBeGreaterThan(0);
      for (const key of entry.trigger.payloadKeys) {
        expect(
          bodies.some((b) => b.includes(`'${key}'`)),
          `${entry.trigger.eventType} payload key ${key}`,
        ).toBe(true);
      }
    }
  });

  it('the check can fail: an invented event type is not found in the tree', () => {
    const literal = `'sale.unicorned.v9'`;
    expect(sources.some((s) => s.sql.includes(literal))).toBe(false);
  });
});
