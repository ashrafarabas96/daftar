import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { KINDS_AWAITING_SEALED_READ, awaitsSealedRead, catalogEntries, catalogEntry, scheduledKindsFor } from '../src/catalog';
import { planFromScheduleFiring, type ScheduleConfiguration, type ScheduleFiring, type ScheduleReader } from '../src/schedule';

/**
 * THE SEALED-READ LAW, for the two installment kinds.
 *
 * WHAT IT IS FOR. `installment_due_soon` and `installment_overdue` are bound,
 * by their own `boundTo`, to `P4-S7 installment schedule` and
 * `P4-S7 installment aging`. Measured on this head: **there is no installment
 * table and no installment function in any of the 87 numbered migrations**.
 * What exists is `infrastructure/database/specifications/
 * p4s7-installment-aging.spec.sql` — a specification — and tests that create
 * their own objects in a scratch database. A specification is not a schema and
 * a scratch table is not a schema. So a message of either kind would state, to
 * a customer, a due date and an amount that no canonical read can produce.
 *
 * WHY IT IS A LAW AND NOT A SETTING. `enabled: false` on a business's schedule
 * configuration is a setting, and somebody can set it to `true`. The ban is
 * therefore a refusal in source — `KINDS_AWAITING_SEALED_READ` plus the gate in
 * `planFromScheduleFiring`, which stands BEFORE the configuration is read — and
 * this file holds that refusal to the database in BOTH directions:
 *
 *   forward  — with `enabled: true` for either installment schedule, the plan
 *              must be a refusal naming `notification.sealed_read_missing`.
 *   backward — once a numbered migration DOES create the installment table and
 *              its aging function, this law FAILS BY NAME and tells the reader
 *              to lift the ban deliberately. So sealing the read cannot quietly
 *              unlock two customer-facing money messages: it costs an act.
 *
 * THE NEGATIVE CONTROL IS IN THE FILE, not in a comment. `p8.statement.monthly`
 * is planned through the same function with the same shape of reader and must
 * reach `plan: 'dispatch'`. Without it, a refusal proves nothing: a harness
 * that refuses everything would read as a passing gate. And the migration probe
 * carries its own: the same scan must FIND the aging function Phase 4 did seal,
 * `customer_ar_aging`, or its zero for installments is an empty probe and not a
 * measurement.
 */

const REPO = resolve(__dirname, '..', '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure', 'database', 'migrations');

const INSTALLMENT_SCHEDULES = ['p8.installment.due_soon', 'p8.installment.overdue'] as const;
const READY_SCHEDULE = 'p8.statement.monthly';

/**
 * Both spellings, and the WHOLE word. The first writing of this law used
 * /instal/ and went red on four function names ending `_key_install` --
 * `accounting_assertion_key_install` among them. That is a false positive of
 * the probe, not an installment surface, and it would have read as 'P4-S7 has
 * landed'. A loose pattern in a law that asserts an absence is the same defect
 * as no law at all, pointed the other way.
 */
const INSTALLMENT_NAME = /instal{1,2}ment/;

/** Every `CREATE TABLE <name>` / `CREATE FUNCTION <name>` in the numbered migrations. */
function migrationObjects(): { readonly tables: readonly string[]; readonly functions: readonly string[]; readonly files: number } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  const tables: string[] = [];
  const functions: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/gi)) {
      tables.push(
        (m[1] ?? '')
          .replace(/"/g, '')
          .replace(/^public\./, '')
          .toLowerCase(),
      );
    }
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)/gi)) {
      functions.push(
        (m[1] ?? '')
          .replace(/"/g, '')
          .replace(/^public\./, '')
          .toLowerCase(),
      );
    }
  }
  return { tables, functions, files: files.length };
}

function reader(configured: readonly ScheduleConfiguration[]): ScheduleReader {
  return { read: (_business, scheduleId) => configured.find((c) => c.scheduleId === scheduleId) };
}

function firing(scheduleId: string): ScheduleFiring {
  return { businessId: 'b-1', scheduleId, occurrenceKey: '2026-11' };
}

describe('the installment kinds are disabled BY LAW until a migration carries their read', () => {
  it('the migration probe sees things: it finds the aging surface Phase 4 DID seal', () => {
    // RULE-11/RULE-18 in this repository's words: a probe that produces
    // emptiness has not produced a zero. Everything below rests on this.
    const { tables, functions, files } = migrationObjects();
    expect(files, 'no .sql file was read out of the migrations directory').toBeGreaterThan(80);
    expect(tables.length, 'the table scan found nothing at all').toBeGreaterThan(100);
    expect(functions, 'the function scan cannot see customer_ar_aging, which 0075 creates').toContain('customer_ar_aging');
  });

  it('and it finds NO installment table and NO installment function in any numbered migration', () => {
    const { tables, functions } = migrationObjects();
    const t = tables.filter((n) => INSTALLMENT_NAME.test(n));
    const f = functions.filter((n) => INSTALLMENT_NAME.test(n));
    expect(t, `a numbered migration now creates an installment table (${t.join(', ')}) — see the backward direction below`).toEqual([]);
    expect(f, `a numbered migration now creates an installment function (${f.join(', ')}) — see the backward direction below`).toEqual([]);
  });

  it('and the TIGHTENED name pattern is itself sighted: it finds the installment objects the SPECIFICATION declares', () => {
    // Tightening the pattern to the whole word fixed a false positive and
    // created a new risk: a pattern narrow enough to match nothing anywhere
    // would make the absence above free. So the same `INSTALLMENT_NAME` is
    // pointed at the one place the surface does exist — the specification,
    // which is exactly what the P4 card says is all there is — and must hit.
    const spec = readFileSync(join(REPO, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');
    const declared = [...spec.matchAll(/create\s+(?:table|(?:or\s+replace\s+)?function)\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/gi)]
      .map((m) =>
        (m[1] ?? '')
          .replace(/"/g, '')
          .replace(/^public\./, '')
          .toLowerCase(),
      )
      .filter((n) => INSTALLMENT_NAME.test(n));
    expect(
      declared.length,
      'the same pattern finds no installment object in the specification either, so its zero in the migrations measures the pattern and not the tree',
    ).toBeGreaterThan(0);
  });

  it('BACKWARD: when the table AND the function both arrive, this law reds so the ban is lifted deliberately', () => {
    const { tables, functions } = migrationObjects();
    const hasTable = tables.some((n) => INSTALLMENT_NAME.test(n));
    const hasFunction = functions.some((n) => INSTALLMENT_NAME.test(n));
    if (hasTable && hasFunction) {
      expect.fail(
        'P4-S7 has landed: a numbered migration now carries both the installment table and its aging function. ' +
          'That does NOT lift this ban on its own. Remove the two kinds from KINDS_AWAITING_SEALED_READ, delete ' +
          'this test, and record the evidence in the P8 release-blocking card — in the same commit, with ' +
          'daftar-finance on it, because both kinds carry a `money` variable to a customer.',
      );
    }
    // Until then the law stands, and this assertion records which half is absent.
    expect({ hasTable, hasFunction }).toEqual({ hasTable: false, hasFunction: false });
  });

  it('the banned set is exactly the kinds whose boundTo says NOT SEALED — it cannot be narrowed quietly', () => {
    const unsealed = catalogEntries()
      .filter((e) => /NOT SEALED/.test(e.boundTo))
      .map((e) => e.kind)
      .sort();
    expect(unsealed.length, 'no catalogue entry declares an unsealed read, so this law has no subject').toBeGreaterThan(0);
    expect([...KINDS_AWAITING_SEALED_READ].sort()).toEqual(unsealed);
    for (const kind of KINDS_AWAITING_SEALED_READ) {
      expect(catalogEntry(kind), `${kind} is banned and is not in the catalogue`).toBeDefined();
      expect(awaitsSealedRead(kind)).toBe(true);
    }
  });

  it('FORWARD: with the schedule CONFIGURED AND ENABLED, each installment kind is refused by name', () => {
    for (const scheduleId of INSTALLMENT_SCHEDULES) {
      const kinds = scheduledKindsFor(scheduleId);
      expect(kinds.length, `${scheduleId} is bound to no kind, so this case asserts nothing`).toBeGreaterThan(0);
      const plan = planFromScheduleFiring(firing(scheduleId), reader([{ scheduleId, enabled: true }]));
      expect(plan.plan, `${scheduleId} reached a dispatch with enabled: true`).toBe('refuse');
      if (plan.plan !== 'refuse') throw new Error('unreachable');
      expect(plan.code, scheduleId).toBe('notification.sealed_read_missing');
      expect(plan.detail, scheduleId).toContain(scheduleId);
    }
  });

  it('and the refusal is NOT schedule_not_configured: no configuration can answer a missing read', () => {
    // The distinction is the whole point. `schedule_not_configured` means
    // "nobody asked for this", and a business answers it by turning the
    // schedule on. If these two collapsed into one code, an operator reading
    // the log would "fix" a missing canonical read with a settings change.
    for (const scheduleId of INSTALLMENT_SCHEDULES) {
      for (const configured of [[], [{ scheduleId, enabled: false }], [{ scheduleId, enabled: true }]]) {
        const plan = planFromScheduleFiring(firing(scheduleId), reader(configured));
        expect(plan.plan).toBe('refuse');
        if (plan.plan !== 'refuse') throw new Error('unreachable');
        expect(plan.code, `${scheduleId} with ${JSON.stringify(configured)}`).toBe('notification.sealed_read_missing');
      }
    }
  });

  it('NEGATIVE CONTROL: a ready scheduled kind still dispatches through the same function', () => {
    // Without this, every assertion above would be satisfied by a gate that
    // refuses everything, and a broken harness would read as a working ban.
    const plan = planFromScheduleFiring(firing(READY_SCHEDULE), reader([{ scheduleId: READY_SCHEDULE, enabled: true }]));
    expect(plan.plan, 'the statement schedule no longer dispatches, so the refusals above prove nothing').toBe('dispatch');
    if (plan.plan !== 'dispatch') throw new Error('unreachable');
    expect(plan.intents.length).toBeGreaterThan(0);
  });

  it('the other door is closed by construction: no banned kind is triggered by an outbox event', () => {
    // The gate lives in the scheduled path because that is the only path these
    // kinds have. This records WHY, as a measurement rather than a belief: if
    // one were ever bound to an outbox event, `planFromOutboxRow` would reach
    // it without passing the gate, and this case reds first.
    for (const kind of KINDS_AWAITING_SEALED_READ) {
      expect(catalogEntry(kind)?.trigger.source, kind).toBe('schedule');
    }
  });
});
