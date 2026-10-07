/**
 * THE DATABASE-BACKED RED PROOFS OF THE S8 FRAMEWORK.
 *
 * Three of S8's checks read the LIVE CATALOGUE rather than the tree: the RLS
 * estate, the lock order, and the permission grant. For those, a red proof
 * that mutated a FILE would prove nothing about the checker, because the
 * checker never looks at files. So each proof here PLANTS A REAL SUBJECT in a
 * real database — a real relation, a real routine, a real grant — evaluates
 * the law SEMANTICALLY out of `pg_class`, `pg_policy`, `pg_proc.prosrc` and
 * `role_permissions`, and then drops the plant.
 *
 * WHY A REAL SUBJECT AND NOT A FICTIONAL ONE
 *
 * A proof that plants a relation which could never exist, or names a routine
 * nothing defines, asserts "no finding" — the OPPOSITE of its intent. It would
 * pass against a checker that always returned green. So every plant below is
 * something Postgres actually accepts and actually enforces, created in a
 * SCRATCH DATABASE built from the real migration files and dropped afterwards.
 *
 * AND THE PASSING CASE, EVERY TIME
 *
 * Each proof asserts the UNPLANTED state is clean first. A refusal that was
 * already there before the plant is not evidence the plant caused it, and
 * `[[daftar-a-check-only-asked-where-it-passes]]` cuts both ways: a law shown
 * only refusing is as unproven as one shown only passing.
 *
 * It lives under `tests/guards/` because that directory is executed by
 * `npm run test:integration`, a required step of the `backend` CI job.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_ROLE_GRANT_SQL, type LiveRoleGrantRow, discoverPermissions, liveRoleGrantProblems } from '../../scripts/phase4-s8/inventories';
import { acquisitionOrderProblems } from '../../scripts/phase4-s8/lock-order';
import { LIVE_POLICY_SQL, LIVE_RELATION_SQL, type LivePolicyRow, type LiveRelationRow, liveEstateProblems } from '../../scripts/phase4-s8/rls-estate';
import { createScratchDb } from '../helpers/scratch-db';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

// Each proof builds its own scratch database and drops it, so one proof's
// plant can never be the reason another one is red.
const TIMEOUT = 600_000;

describe('the RLS estate checker, over a REAL planted relation', () => {
  it(
    'the RLS estate checker names a REAL planted relation with FORCE missing and three policies',
    async () => {
      const db = await createScratchDb('daftar_p4s8_rls_red_proof', { keys: false });
      try {
        // ── THE PASSING CASE, over a REAL Phase 4 relation ────────────────
        // `invoices` is real since 0075 and carries the full estate. If this
        // is red, the plant below proves nothing.
        const names = ['invoices'];
        const cleanRelations = (await db.pool.query<LiveRelationRow>(LIVE_RELATION_SQL, [names])).rows;
        const cleanPolicies = (await db.pool.query<LivePolicyRow>(LIVE_POLICY_SQL, [names])).rows;
        expect(cleanRelations.length, 'the live estate query must find invoices, or this proof is about nothing').toBe(1);
        expect(liveEstateProblems(cleanRelations, cleanPolicies, new Map([['invoices', 6]]))).toEqual([]);

        // ── THE PLANT ────────────────────────────────────────────────────
        // A REAL relation, created in a real database, with row security
        // ENABLED but NOT FORCED and only three of the four RESTRICTIVE
        // policies. Postgres accepts every statement; the defect is exactly
        // the one the law exists for, and it is invisible to any lexical scan
        // of the migrations because no migration says any of this.
        await db.pool.query(`
          CREATE TABLE p4s8_planted_estate (
            tenant_id UUID NOT NULL,
            business_id UUID NOT NULL,
            id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY
          )`);
        await db.pool.query(`ALTER TABLE p4s8_planted_estate ENABLE ROW LEVEL SECURITY`);
        // Deliberately NOT: ALTER TABLE ... FORCE ROW LEVEL SECURITY.
        for (const [name, command] of [
          ['p4s8_planted_tenant_select', 'SELECT'],
          ['p4s8_planted_tenant_insert', 'INSERT'],
          ['p4s8_planted_tenant_update', 'UPDATE'],
        ] as const) {
          const clause = command === 'INSERT' ? 'WITH CHECK' : 'USING';
          await db.pool.query(
            `CREATE POLICY ${name} ON p4s8_planted_estate AS RESTRICTIVE FOR ${command} TO PUBLIC ${clause} (tenant_id = nullif(app_tenant(), '')::uuid)`,
          );
        }

        const planted = ['p4s8_planted_estate'];
        const relations = (await db.pool.query<LiveRelationRow>(LIVE_RELATION_SQL, [planted])).rows;
        const policies = (await db.pool.query<LivePolicyRow>(LIVE_POLICY_SQL, [planted])).rows;

        // The plant is REAL: the catalogue says so, not this test.
        expect(relations.length).toBe(1);
        expect(relations[0]?.relrowsecurity).toBe(true);
        expect(relations[0]?.relforcerowsecurity).toBe(false);
        expect(policies.length).toBe(3);

        const problems = liveEstateProblems(relations, policies, new Map([['p4s8_planted_estate', 6]]));
        expect(problems.join('\n')).toContain('relforcerowsecurity is false');
        expect(problems.join('\n')).toContain('the table owner bypasses every policy');
        expect(problems.join('\n')).toContain('3 live policies');
        expect(problems.join('\n')).toContain('no RESTRICTIVE policy covers DELETE');

        // And the ACCOUNTING-SOURCE arm: a relation expected to carry seven
        // policies and holding no `accounting_validator` reads ZERO rows under
        // FORCE and passes vacuously (TL-P4-S1-C2).
        const asSource = liveEstateProblems(relations, policies, new Map([['p4s8_planted_estate', 7]]));
        expect(asSource.join('\n')).toContain('accounting_validator');
        expect(asSource.join('\n')).toContain('VACUOUSLY');

        // ── THE PLANT IS DROPPED ─────────────────────────────────────────
        await db.pool.query(`DROP TABLE p4s8_planted_estate`);
        const gone = (await db.pool.query<LiveRelationRow>(LIVE_RELATION_SQL, [planted])).rows;
        expect(gone.length, 'the plant must be gone, or the next reader of this database inherits it').toBe(0);
        // An empty result set is NOT a pass, and the law says so.
        expect(liveEstateProblems(gone, [], new Map()).join('\n')).toContain('an empty result set is never a refusal');
      } finally {
        await db.drop();
      }
    },
    TIMEOUT,
  );
});

describe('the lock-order checker, over a REAL planted routine', () => {
  it(
    'the lock-order checker names a REAL planted routine that inverts the declared order',
    async () => {
      const db = await createScratchDb('daftar_p4s8_lock_red_proof', { keys: false });
      try {
        // ── THE PASSING CASE, over the REAL shipped routine ───────────────
        // Read from `pg_proc.prosrc`, which is the body the server will
        // actually execute — not the migration text, which is what the file
        // asked for. The two can differ: 0085 re-defines
        // `customer_collect_payment`, so a checker reading the migrations
        // could be judging a body that no longer exists.
        const real = await db.pool.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc WHERE proname = 'sale_commit' LIMIT 1`);
        const realBody = real.rows[0]?.prosrc;
        expect(realBody, 'sale_commit must exist in the live catalogue, or this proof is about nothing').toBeDefined();
        if (realBody === undefined) return;
        // `sale_commit` reaches `products` through a helper it PERFORMs, so
        // the bodies map carries every routine in the database and the walk
        // inlines them. A walk that stopped at the body would see two locks
        // and report no problem — the vacuous pass on the one question asked.
        const all = await db.pool.query<{ proname: string; prosrc: string }>(`
          SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f'`);
        const bodies = new Map(all.rows.map((r) => [r.proname, r.prosrc]));
        expect(acquisitionOrderProblems('sale_commit', realBody, bodies)).toEqual([]);

        // ── THE PLANT ────────────────────────────────────────────────────
        // A REAL routine, created in a real database, that locks
        // `invoice_sequences` and only THEN `invoices` — the declared order
        // puts the sequence LAST (`P4-AL-32`), because it is the hottest row
        // in the system and holding it across other work serialises every
        // concurrent sale. Every relation named is real; the routine compiles;
        // Postgres would run it.
        await db.pool.query(`
          CREATE FUNCTION p4s8_planted_inverted_order(p_business UUID) RETURNS void
          LANGUAGE plpgsql AS $fn$
          DECLARE v_next BIGINT;
          BEGIN
            -- The sequence row FIRST, which is the inversion.
            SELECT last_number INTO v_next FROM invoice_sequences WHERE business_id = p_business FOR UPDATE;
            -- And only then the documents it is numbering.
            PERFORM 1 FROM invoices WHERE business_id = p_business FOR UPDATE;
          END
          $fn$`);

        const plantedRow = await db.pool.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc WHERE proname = 'p4s8_planted_inverted_order' LIMIT 1`);
        const plantedBody = plantedRow.rows[0]?.prosrc;
        expect(plantedBody, 'the planted routine must be in the catalogue — a plant that did not take proves nothing').toBeDefined();
        if (plantedBody === undefined) return;

        const problems = acquisitionOrderProblems(
          'p4s8_planted_inverted_order',
          plantedBody,
          new Map([...bodies, ['p4s8_planted_inverted_order', plantedBody]]),
        );
        expect(problems.length, 'the inverted order must be named').toBeGreaterThan(0);
        expect(problems.join('\n')).toContain('invoice_sequences');
        expect(problems.join('\n')).toContain('invoices');

        await db.pool.query(`DROP FUNCTION p4s8_planted_inverted_order(UUID)`);
        const after = await db.pool.query(`SELECT 1 FROM pg_proc WHERE proname = 'p4s8_planted_inverted_order'`);
        expect(after.rowCount).toBe(0);
      } finally {
        await db.drop();
      }
    },
    TIMEOUT,
  );
});

describe('the permission inventory, over a REAL planted grant', () => {
  it(
    'the permission inventory names a REAL planted cashier -> sales.void grant',
    async () => {
      const db = await createScratchDb('daftar_p4s8_grant_red_proof', { keys: false });
      try {
        const sensitive = discoverPermissions(ROOT)
          .filter((r) => r.sensitive)
          .map((r) => r.key);
        expect(sensitive.length, 'the sensitive classification must be non-empty, or this check passes over every grant there is').toBeGreaterThan(0);

        // ── A REAL BUSINESS, A REAL SYSTEM ROLE ──────────────────────────
        // Built with real statements through the real constraints: the
        // composite FK ties the grant to the SAME business as the role, so a
        // fabricated pair would simply be refused — which is why the plant has
        // to be built rather than asserted.
        const tenant = await db.pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
        const tenantId = tenant.rows[0]?.id;
        expect(tenantId).toBeDefined();
        if (tenantId === undefined) return;
        const business = await db.pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone) VALUES ($1, 'p4s8 red proof business', 'p4s8-red-proof', 'TR', 'TRY', 'Europe/Istanbul') RETURNING id`,
          [tenantId],
        );
        const businessId = business.rows[0]?.id;
        expect(businessId).toBeDefined();
        if (businessId === undefined) return;
        // `is_system = false`, and that is not a weakening of the plant.
        // `business_roles_protect_system` (0006_rls.sql:85-92) REFUSES an
        // insert with `is_system` true outside a bypass transaction — a real
        // constraint, met rather than circumvented. And the finding does not
        // depend on the flag: a role KEYED `cashier` holding a sensitive
        // permission is what authorises the request, whoever created it. The
        // flag is reported in the finding so a reader can tell the two apart.
        const role = await db.pool.query<{ id: string }>(
          `INSERT INTO business_roles (business_id, key, name, is_system) VALUES ($1, 'cashier', 'Cashier', false) RETURNING id`,
          [businessId],
        );
        const roleId = role.rows[0]?.id;
        expect(roleId).toBeDefined();
        if (roleId === undefined) return;

        // ── THE PASSING CASE: the cashier's accepted five ─────────────────
        for (const permission of ['catalog.view', 'sales.view', 'sales.create', 'customers.view', 'payments.collect'])
          await db.pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)`, [businessId, roleId, permission]);
        const clean = (await db.pool.query<LiveRoleGrantRow>(LIVE_ROLE_GRANT_SQL)).rows;
        expect(clean.length).toBe(5);
        expect(liveRoleGrantProblems(clean, sensitive)).toEqual([]);

        // ── THE PLANT: a REAL sensitive grant to the cashier ──────────────
        const victim = sensitive.find((k) => k.startsWith('sales.')) ?? sensitive[0];
        expect(victim).toBeDefined();
        if (victim === undefined) return;
        await db.pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)`, [businessId, roleId, victim]);

        const planted = (await db.pool.query<LiveRoleGrantRow>(LIVE_ROLE_GRANT_SQL)).rows;
        expect(planted.length, 'the plant must be in the catalogue').toBe(6);
        const problems = liveRoleGrantProblems(planted, sensitive);
        expect(problems.join('\n')).toContain("the built-in role 'cashier'");
        expect(problems.join('\n')).toContain(victim);
        expect(problems.join('\n')).toContain('what the catalogue holds is what the request is authorised by');

        await db.pool.query(`DELETE FROM role_permissions WHERE business_id = $1 AND role_id = $2 AND permission = $3`, [businessId, roleId, victim]);
        expect(liveRoleGrantProblems((await db.pool.query<LiveRoleGrantRow>(LIVE_ROLE_GRANT_SQL)).rows, sensitive)).toEqual([]);

        // And the two vacuity guards, so neither empty collection reads as a pass.
        expect(liveRoleGrantProblems([], sensitive).join('\n')).toContain('an empty result set is never a refusal');
        expect(liveRoleGrantProblems(planted, []).join('\n')).toContain('a vacuous pass');
      } finally {
        await db.drop();
      }
    },
    TIMEOUT,
  );
});
