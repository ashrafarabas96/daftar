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

const SPEC = join(REPO, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');

/**
 * The numbered migrations, concatenated in NUMBER order — which is apply
 * order, and the only order in which "the last definition wins" is true.
 */
const MIGRATIONS_TEXT = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

/**
 * The LAST body `customer_ar_aging` is given in the text, sliced out between
 * its dollar-quote tags. The last one is the live one: `0083` replaces `0075`'s
 * and `0084` drops and recreates it, so reasoning about the first definition
 * reasons about a body no database has.
 */
function agingBody(sql: string): { readonly sites: readonly number[]; readonly body: string } {
  const sites: number[] = [];
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?customer_ar_aging\b/gi)) {
    if (m.index !== undefined) sites.push(m.index);
  }
  const last = sites[sites.length - 1];
  if (last === undefined) return { sites, body: '' };
  const tail = sql.slice(last);
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(tail);
  if (!open || open.index === undefined) return { sites, body: '' };
  const tag = open[1] ?? '';
  const from = open.index + open[0].length;
  const close = tail.indexOf(tag, from);
  return { sites, body: close === -1 ? '' : tail.slice(from, close) };
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

  it('the live aging read is installment-BLIND, and the specification`s is not — both measured off the bodies', () => {
    // WHY THIS CASE EXISTS, and it is a correction. The first writing of this
    // law reasoned about `0075:798` as the aging read. That was WRONG, and the
    // P4 seal lane said so: `customer_ar_aging` is defined THREE times in the
    // numbered migrations — `0075:798`, `0083:383` (OR REPLACE) and
    // `0084:705`, preceded by `0084:478 DROP FUNCTION` — so the LIVE body is
    // `0084`'s, and `0084 > frozenThrough = 0079`, which means it is not even
    // frozen. Measured here, in this repository, not relayed.
    const live = agingBody(MIGRATIONS_TEXT);
    // THREE TODAY, AND THE BOUND IS `>=`, NOT `=`. The first writing pinned it
    // to exactly 3, and the P4 seal lane named what that costs: the owner's
    // DR-106 provides for a FOURTH definition on purpose, by a numbered
    // migration, the day aging moves to installment logic. An exact 3 would
    // then red — a false failure whose natural repair is "raise it to 4", which
    // is editing a control to pass a change, the one thing this repository does
    // not allow. So the bound asserts only that the probe SEES something, and a
    // change in the count is an EVENT TO READ, never a number to raise: the
    // body below is always the LAST definition, which is the live one, whatever
    // the count becomes.
    expect(live.sites.length, 'no definition of customer_ar_aging was found in the migrations at all').toBeGreaterThanOrEqual(3);
    expect(live.sites[live.sites.length - 1], 'the sliced body is not the last definition, so it is not the live one').toBe(Math.max(...live.sites));
    expect(live.body, 'the live body could not be sliced out, so "blind" below would be a fact about the slicer').toContain('invoice_outstanding');
    expect(INSTALLMENT_NAME.test(live.body), 'the LIVE aging read now mentions installments — see the backward direction').toBe(false);

    // The control: the same slicer, pointed at the specification's body, must
    // come back installment-AWARE. Without it, `false` above would measure the
    // slicer and not the read.
    const spec = agingBody(readFileSync(SPEC, 'utf8'));
    expect(spec.body.length, 'the specification body could not be sliced').toBeGreaterThan(live.body.length);
    expect(INSTALLMENT_NAME.test(spec.body), 'the slicer cannot see installments even in the specification body').toBe(true);
  });

  it('BACKWARD: the ban lifts only on a table, an installment function AND an installment-aware aging read', () => {
    const { tables, functions } = migrationObjects();
    const hasTable = tables.some((n) => INSTALLMENT_NAME.test(n));
    const hasFunction = functions.some((n) => INSTALLMENT_NAME.test(n));
    // The third term, and the reason it is here. Without it, a migration that
    // added `installment_plans` and, say, `installment_plan_fact_sync` would
    // flip this law while `customer_ar_aging` stayed installment-blind — and
    // the read these two kinds actually need would still not exist. The P4
    // lane raised exactly this: a condition satisfied by the mere presence of
    // the NAME is the `/instal/` false positive one level up.
    const agingAware = INSTALLMENT_NAME.test(agingBody(MIGRATIONS_TEXT).body);
    if (hasTable && hasFunction && agingAware) {
      expect.fail(
        'P4-S7 has landed: a numbered migration now carries the installment table, an installment function, AND ' +
          'an installment-aware customer_ar_aging. That does NOT lift this ban on its own. Remove the two kinds ' +
          'from KINDS_AWAITING_SEALED_READ, delete this test, and record the evidence in the P8 release-blocking ' +
          'card — in the same commit, with daftar-finance on it, because both kinds carry a `money` variable to a ' +
          'customer.',
      );
    }
    // Until then the law stands, and this records which of the three is absent.
    expect({ hasTable, hasFunction, agingAware }).toEqual({ hasTable: false, hasFunction: false, agingAware: false });
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
