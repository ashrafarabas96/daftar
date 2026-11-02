import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DR-67 CONDITION 1 — the inventory of cleartext columns equals the row's real
 * columns, and the exposure suite actually inspects all of them.
 *
 * OD-P7-01 is deferred to P7-04. The condition that keeps that deferral from
 * being a gap is this: every column stored outside the AES-GCM payload is
 * named, and nothing personal or financial may appear in one. The behavioural
 * half is `CleartextColumnExposureTest`, which cannot run on this host (no
 * `kotlinc`). The half that CAN be measured anywhere is the agreement between
 * the inventory and the code — which is also the half that rots silently, since
 * adding a column to `StoredRow` is a one-line change nobody would think to
 * cross-check.
 */

const ROOT = join(__dirname, '..');
const OFFLINE = join(ROOT, 'apps', 'android', 'offline-kernel', 'src');
const PERSISTENCE = join(OFFLINE, 'main', 'java', 'app', 'daftar', 'offline', 'Persistence.kt');
const EXPOSURE = join(OFFLINE, 'test', 'java', 'app', 'daftar', 'offline', 'CleartextColumnExposureTest.kt');

const persistence = () => readFileSync(PERSISTENCE, 'utf8');
const exposure = () => readFileSync(EXPOSURE, 'utf8');

/** The names in `CLEARTEXT_COLUMNS`, read from the declaration. */
function inventory(source: string): string[] {
  const start = source.indexOf('val CLEARTEXT_COLUMNS: List<String> = listOf(');
  if (start === -1) throw new Error('Persistence.kt declares no CLEARTEXT_COLUMNS inventory');
  const close = source.indexOf(')', start);
  return [...source.slice(start, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

/** Every field of the `StoredRow` data class, in declaration order. */
function storedRowFields(source: string): string[] {
  const start = source.indexOf('data class StoredRow(');
  if (start === -1) throw new Error('Persistence.kt declares no StoredRow');
  const close = source.indexOf(') {', start);
  return [...source.slice(start, close).matchAll(/^ {4}val ([A-Za-z0-9_]+):/gm)].map((m) => m[1] ?? '');
}

describe('DR-67: the cleartext inventory equals the row minus the sealed payload', () => {
  it('names the five columns stored outside the payload', () => {
    expect(inventory(persistence())).toEqual(['idempotencyKey', 'schemaVersion', 'state', 'attempts', 'payloadDigest']);
  });

  it('EQUALS StoredRow fields minus sealedPayload, in both directions', () => {
    const fields = storedRowFields(persistence());
    expect(fields).toContain('sealedPayload');
    const expected = fields.filter((f) => f !== 'sealedPayload').sort();
    expect([...inventory(persistence())].sort()).toEqual(expected);
  });

  it('notices a column added to the row but never inventoried', () => {
    // Positive control for the direction that rots silently.
    const planted = persistence().replace('    val sealedPayload: ByteArray,', '    val customerName: String,\n    val sealedPayload: ByteArray,');
    expect(planted).not.toBe(persistence());
    const fields = storedRowFields(planted).filter((f) => f !== 'sealedPayload');
    expect(fields).toContain('customerName');
    expect([...inventory(planted)].sort()).not.toEqual([...fields].sort());
  });

  it('notices an inventory entry that no longer corresponds to a column', () => {
    const planted = persistence().replace('    "payloadDigest",\n', '    "payloadDigest",\n    "ghostColumn",\n');
    expect(planted).not.toBe(persistence());
    const fields = storedRowFields(planted).filter((f) => f !== 'sealedPayload');
    expect(inventory(planted)).toContain('ghostColumn');
    expect([...inventory(planted)].sort()).not.toEqual([...fields].sort());
  });
});

describe('DR-67: the exposure suite inspects every inventoried column, with a control', () => {
  it('inspects all five by name', () => {
    const source = exposure();
    const missing = inventory(persistence()).filter((c) => !source.includes(`"${c}" to`));
    expect(missing).toEqual([]);
  });

  it('writes a name, a phone, an amount and a note into the payload', () => {
    const source = exposure();
    for (const what of ['customer name', 'phone number', 'amount', 'note']) {
      expect(source).toContain(`"${what}" to`);
    }
    // And proves the payload really carried them, so the absence check is not
    // a probe that found nothing because nothing was there.
    expect(source).toContain('the payload never carried the');
  });

  it('carries the in-suite leaky control and names the column it must catch', () => {
    const source = exposure();
    expect(source).toContain('a store that leaks a name into a cleartext column fails this very check');
    expect(source).toContain('payloadDigest = "sha256:$customerName"');
    expect(source).toMatch(/assertEquals\(setOf\("payloadDigest"\), leaks\.keys/);
    expect(source).toContain('the leak probe did not notice a name written into a cleartext column');
  });

  /**
   * A LIMIT FOUND BY RUNNING A PLANT, AND THEN CLOSED.
   *
   * A DR-55 plant appended the customer's name to the `payloadDigest` column
   * inside `cleartextOf` — a real leak — and this guard stayed GREEN, because
   * everything above reads the suite's SHAPE while the leak is behavioural and
   * the behavioural half needs `kotlinc`. The plant proved the guard blind, not
   * the store safe.
   *
   * So the mapping is now pinned exactly: each inventoried column must be
   * `"<name>" to row.<name>` with nothing done to it — no concatenation, no
   * interpolation, no call. A column that is transformed on its way into the
   * inspected map can hide a leak from the very suite meant to find it, and
   * that is now a static failure rather than one only CI could see.
   *
   * What remains CI-only is stated rather than implied: a leak written by the
   * STORE itself, into an honest mapping, is invisible here and is caught by
   * `CleartextColumnExposureTest` under `./gradlew testDebugUnitTest`.
   */
  it('maps every inventoried column to its row field untransformed', () => {
    const source = exposure();
    const wrong: string[] = [];
    for (const column of inventory(persistence())) {
      // `state` and the two integers are rendered, which is the one allowed
      // transformation and is named here rather than left as a loophole.
      const allowed = [`"${column}" to row.${column},`, `"${column}" to row.${column}.name,`, `"${column}" to row.${column}.toString(),`];
      if (!allowed.some((form) => source.includes(form))) wrong.push(column);
    }
    expect(wrong).toEqual([]);
  });

  it('compares case-insensitively and as a substring', () => {
    // A leak that lowercased a name, or embedded it in a longer string, is a
    // leak. An exact equality check would miss both.
    expect(exposure()).toMatch(/contains\([^)]*ignoreCase = true\)/);
  });

  it('carries no skipped, focused or pending marker', () => {
    const banned = /@Ignore\b|\.skip\b|\.only\b|\.todo\b|@Disabled\b/;
    expect(banned.test('@Ignore')).toBe(true);
    expect(banned.test(exposure())).toBe(false);
  });
});
