/**
 * P4-S1 ACTION 1 — THE REGISTRY WIDENING, AND THE RULE THAT POLICES IT.
 *
 * `0074_phase4_registry_widening.sql` is the first Phase 4 migration. It
 * widens the `registered_by` CHECK of four accepted registries from
 * `^P3-S[0-9]+$` to `^P[0-9]+-S[0-9]+$`, keeping the corrective `P3-C` arm on
 * the one table that holds such a row (TL-P4-S1-C3), and it does nothing else:
 * no table, no function, no trigger, no policy, no sequence and — ruling C8 —
 * no registry row.
 *
 * Two things are proved here, because a widening that is only read is not a
 * widening that is known to work.
 *
 * §A THE RULE. `registeredByProblems` in `scripts/phase4-s1-gate.ts` refuses a
 *    Phase 4 migration that puts the Phase-3-only pattern back. That rule used
 *    to grep the WHOLE Phase 4 SQL for the pattern, which made it wrong in one
 *    direction: it fired on `0074`'s own pre-flight assertion, the `DO` block
 *    that compares `pg_get_constraintdef()` against the shape the migration was
 *    written for — the discipline P4-AL-84 explicitly demands of it ("a
 *    migration reads the live catalogue, never the migration that wrote it").
 *    Answering that by deleting the assertion would be the check contorting its
 *    subject. The rule is scoped to the `ADD CONSTRAINT … CHECK` clause
 *    instead, and both directions are proved: a re-added Phase-3-only CHECK is
 *    still caught, and naming the old shape inside an assertion is not a
 *    finding.
 *
 * §B THE END STATE, PERFORMED. Against the live database: each of the four
 *    registries admits a `P4-S1` registrant and still refuses a malformed one,
 *    the `P3-C` row is still admitted where it lives, and the registries hold
 *    exactly the rows the Phase 3 prefix put there — `0074` registered nothing.
 *    Every write is inside a transaction that is always rolled back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool } from '../helpers/test-app';
import { REGISTERED_BY_RELATIONS, REGISTERED_BY_WIDENED, REGISTERED_BY_PHASE3_ONLY, S1_MIGRATIONS, registeredByProblems } from '../../scripts/phase4-s1-gate';

const ROOT = join(__dirname, '../..');

// ─────────────────────────────────────────────────────────────────────────────
// §A the rule
// ─────────────────────────────────────────────────────────────────────────────

describe('§A action 1: the re-introduction rule reads the ADD CONSTRAINT clause, not the file', () => {
  it('the tree as it stands has no finding, and the four relations are the subject', () => {
    expect(registeredByProblems(ROOT)).toEqual([]);
    expect(REGISTERED_BY_RELATIONS.length).toBe(4);
  });

  it('0074 is the declared P4-S1 migration, and it is the file that carries the widening', () => {
    expect(S1_MIGRATIONS).toContain('0074_phase4_registry_widening.sql');
    const sql = readFileSync(join(ROOT, 'infrastructure/database/migrations/0074_phase4_registry_widening.sql'), 'utf8');
    // The four widenings, and the fourth keeping the corrective arm.
    for (const relation of REGISTERED_BY_RELATIONS) expect(sql, relation).toMatch(new RegExp(`ADD CONSTRAINT ${relation}_registered_by_check`));
    expect(sql).toContain(`CHECK (registered_by ~ '${REGISTERED_BY_WIDENED}' OR registered_by = 'P3-C')`);
    // Ruling C8 and P4-AL-84: nothing else of substance.
    for (const forbidden of [
      /\bCREATE\s+TABLE\b/i,
      /\bCREATE\s+SEQUENCE\b/i,
      /\bCREATE\s+POLICY\b/i,
      /\bCREATE\s+TRIGGER\b/i,
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i,
    ])
      expect(forbidden.test(sql), `0074 contains ${String(forbidden)}`).toBe(false);
  });

  it('RED: a Phase 4 migration that RE-ADDS the Phase-3-only CHECK is still caught', () => {
    // The defect in its real shape: widen, then put it back.
    const planted = REGISTERED_BY_RELATIONS.map(
      (r) =>
        `ALTER TABLE ${r} DROP CONSTRAINT ${r}_registered_by_check;\n` +
        `ALTER TABLE ${r} ADD CONSTRAINT ${r}_registered_by_check CHECK (registered_by ~ '${REGISTERED_BY_WIDENED}');\n` +
        `ALTER TABLE ${r} DROP CONSTRAINT ${r}_registered_by_check;\n` +
        `ALTER TABLE ${r} ADD CONSTRAINT ${r}_registered_by_check CHECK (registered_by ~ '${REGISTERED_BY_PHASE3_ONLY}');\n`,
    ).join('\n');
    const problems = registeredByProblems(ROOT, planted);
    expect(problems.join('\n')).toContain('re-introduces');
    // Once per re-adding clause, so a file that puts one of the four back is
    // not laundered by the other three being correct.
    expect(problems.filter((p) => /re-introduces/.test(p))).toHaveLength(4);
  });

  it('NOT A FINDING: a migration that NAMES the old shape in a pre-flight assertion', () => {
    // `0074`'s own shape. The old pattern appears inside a `DO` block that
    // reads `pg_get_constraintdef`, never inside an `ADD CONSTRAINT`.
    const assertion = REGISTERED_BY_RELATIONS.map(
      (r) =>
        `DO $$\nBEGIN\n  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = '${r}_registered_by_check')\n` +
        `     IS DISTINCT FROM 'CHECK ((registered_by ~ ''${REGISTERED_BY_PHASE3_ONLY}''::text))' THEN\n` +
        `    RAISE EXCEPTION 'unrecognised shape';\n  END IF;\nEND;\n$$;\n` +
        `ALTER TABLE ${r} DROP CONSTRAINT ${r}_registered_by_check;\n` +
        `ALTER TABLE ${r} ADD CONSTRAINT ${r}_registered_by_check CHECK (registered_by ~ '${REGISTERED_BY_WIDENED}');\n`,
    ).join('\n');
    expect(registeredByProblems(ROOT, assertion)).toEqual([]);
  });

  it('RED: a migration that never widens one of the four is caught, assertion or not', () => {
    const missing = REGISTERED_BY_RELATIONS.slice(1)
      .map((r) => `ALTER TABLE ${r} ADD CONSTRAINT ${r}_registered_by_check CHECK (registered_by ~ '${REGISTERED_BY_WIDENED}');`)
      .join('\n');
    const problems = registeredByProblems(ROOT, missing);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(REGISTERED_BY_RELATIONS[0] as string);
    expect(problems[0]).toContain('no Phase 4 migration widens');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §B the end state, performed against the live database
// ─────────────────────────────────────────────────────────────────────────────

let pool: Pool;

beforeAll(async () => {
  await ensurePostgres();
  pool = ownerPool();
});

afterAll(() => {
  // `ownerPool()` is the shared pool; nothing to close here.
});

/** Run `fn` inside a transaction that is ALWAYS rolled back. */
async function inRolledBackTx(fn: (c: { query: Pool['query'] }) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c as unknown as { query: Pool['query'] });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** A row that registers `registeredBy` in each of the four registries, and how to place it. */
async function insertRegistration(c: { query: Pool['query'] }, relation: string, registeredBy: string): Promise<void> {
  switch (relation) {
    case 'inventory_operation_kinds':
      await c.query(`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.probe', $1)`, [registeredBy]);
      return;
    case 'stock_movement_kinds':
      await c.query(`INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by) VALUES ('probe_p4', 'either', FALSE, $1)`, [
        registeredBy,
      ]);
      return;
    case 'stock_source_types':
      await c.query(`INSERT INTO stock_source_types (source_type, registered_by) VALUES ('probe_p4', $1)`, [registeredBy]);
      return;
    case 'inventory_operation_movement_kinds': {
      // A pair the registry does not already hold, so the probe reaches the
      // CHECK rather than the primary key. Both components are real parent
      // keys, so no foreign key can refuse it either.
      const pair = await c.query<{ op_code: string; movement_kind: string }>(
        `SELECT k.op_code, m.movement_kind
           FROM inventory_operation_kinds k CROSS JOIN stock_movement_kinds m
          WHERE NOT EXISTS (SELECT 1 FROM inventory_operation_movement_kinds p WHERE p.op_code = k.op_code AND p.movement_kind = m.movement_kind)
          ORDER BY k.op_code, m.movement_kind LIMIT 1`,
      );
      const row = pair.rows[0];
      expect(row, 'no unregistered op-code/movement-kind pair exists, so this probe would prove nothing').toBeDefined();
      await c.query(`INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES ($1, $2, $3)`, [
        (row as { op_code: string }).op_code,
        (row as { movement_kind: string }).movement_kind,
        registeredBy,
      ]);
      return;
    }
    default:
      throw new Error(`no probe for ${relation}`);
  }
}

describe('§B action 1: the live registries admit a Phase 4 registrant and refuse a malformed one', () => {
  it('each of the four CHECKs is the widened one, read from the catalogue', async () => {
    for (const relation of REGISTERED_BY_RELATIONS) {
      const r = await pool.query<{ def: string }>(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = $1 AND c.contype = 'c'`, [
        `${relation}_registered_by_check`,
      ]);
      const def = r.rows[0]?.def;
      expect(def, `${relation} has no registered_by CHECK`).toBeDefined();
      expect(def as string, relation).toContain(REGISTERED_BY_WIDENED);
      expect(def as string, `${relation} still carries the Phase-3-only pattern`).not.toContain(REGISTERED_BY_PHASE3_ONLY);
    }
  });

  it("each registry ADMITS 'P4-S1', proved by inserting and rolling back", async () => {
    for (const relation of REGISTERED_BY_RELATIONS)
      await inRolledBackTx(async (c) => {
        // The claim is the live constraint's, not a regex's: if the widening
        // had not landed, this insert raises 23514 and the test fails here.
        await insertRegistration(c, relation, 'P4-S1');
      });
  });

  it("each registry still REFUSES 'P4' — a widening that admits anything is a deletion", async () => {
    for (const relation of REGISTERED_BY_RELATIONS)
      await inRolledBackTx(async (c) => {
        await expect(insertRegistration(c, relation, 'P4'), relation).rejects.toMatchObject({ code: '23514' });
      });
  });

  it("inventory_operation_kinds still admits the corrective 'P3-C' arm, and it is the only table that has one", async () => {
    const held = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_operation_kinds WHERE registered_by = 'P3-C'`);
    expect(held.rows[0]?.n ?? 0, 'the 0072 corrective row is gone').toBeGreaterThan(0);
    for (const relation of REGISTERED_BY_RELATIONS.filter((r) => r !== 'inventory_operation_kinds')) {
      const r = await pool.query<{ def: string }>(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = $1 AND c.contype = 'c'`, [
        `${relation}_registered_by_check`,
      ]);
      expect(r.rows[0]?.def ?? '', `${relation} grew a P3-C arm it never had`).not.toContain('P3-C');
    }
  });

  it('0074 registered nothing: every row in all four registries carries Phase 3 provenance', async () => {
    for (const relation of REGISTERED_BY_RELATIONS) {
      const all = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${relation}`);
      const p3 = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${relation} WHERE registered_by ~ '^P3-'`);
      expect(all.rows[0]?.n ?? 0, `${relation} is empty, so this says nothing`).toBeGreaterThan(0);
      expect(p3.rows[0]?.n, `${relation} holds a row no Phase 3 slice registered — 0074 carries no registry row (ruling C8)`).toBe(all.rows[0]?.n);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §C P4-AL-28 — the operation-code namespace, which the widening does not change
// ─────────────────────────────────────────────────────────────────────────────

describe('§C P4-AL-28: the Phase 4 op-code namespaces are `sale.*` and `customer.*`', () => {
  it('0074 asserts both halves, and says why the namespace changed instead of the regex', () => {
    const sql = readFileSync(join(ROOT, 'infrastructure/database/migrations/0074_phase4_registry_widening.sql'), 'utf8');
    expect(sql).toContain("'customer.collect_payment'");
    expect(sql).toContain("'customer_payment.collect'");
    expect(sql).toContain('P4-AL-28');
    // The reason, recorded: the same regex is inside the frozen routine body,
    // so widening it is the change P4-AL-27 and P4-AL-29 forbid.
    expect(sql).toMatch(/0054:229/);
  });

  it('a `customer.*` code is ADMITTED and `customer_payment.*` is REFUSED, live', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('customer.collect_payment', 'P4-S1')`);
    });
    await inRolledBackTx(async (c) => {
      // An underscore in the FIRST segment is not representable. The refusal
      // must come from the op-code pattern, not from anything else, or the
      // claim is about the wrong constraint.
      await expect(
        c.query(`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('customer_payment.collect', 'P4-S1')`),
      ).rejects.toMatchObject({ code: '23514', constraint: 'inventory_operation_kinds_op_code_check' });
    });
  });

  it('a frozen routine body carries the same regex, which is why the namespace is the thing that moved', async () => {
    // The second copy of the op-code pattern is the whole reason P4-AL-28
    // changed the NAMESPACE instead of the regex: widening the table's CHECK
    // would be an ordinary migration, while widening the copy inside a frozen
    // routine body means replacing that routine, which P4-AL-27 and P4-AL-29
    // forbid. If the two copies ever disagreed, an op code could be accepted
    // on insert and refused at call time.
    //
    // The routine is DISCOVERED from `pg_proc`, not named, for two reasons. A
    // later migration may add a third copy, which this then covers by
    // existing. And the lock's own citation of which routine holds it is
    // wrong: P4-AL-28 says the copy is "inside the frozen
    // `inventory_assertion_consume` body at `0054:229`", but `0054:229` is
    // inside `inventory_payload_digest` (the `CREATE OR REPLACE FUNCTION` at
    // `0054:214`), and `inventory_assertion_consume` carries a different
    // pattern — the colon-separated assertion preimage `^[a-z]+(:[a-z_]+)+$`.
    // The DECISION is sound and the citation is not, so this test reads the
    // catalogue rather than the citation.
    const carriers = await pool.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p WHERE strpos(p.prosrc, $1) > 0 ORDER BY p.proname`, [
      '^[a-z]+(\\.[a-z_]+)+$',
    ]);
    expect(
      carriers.rows.map((r) => r.proname),
      'no routine body carries the op-code pattern any more — P4-AL-28 rests on a second copy that no longer exists',
    ).not.toEqual([]);
    // And the table's CHECK is the same pattern, so the two agree.
    const check = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = 'inventory_operation_kinds_op_code_check'`,
    );
    expect(check.rows[0]?.def ?? '', 'the table CHECK and the routine copy have diverged').toContain('^[a-z]+(\\.[a-z_]+)+$');
  });
});
