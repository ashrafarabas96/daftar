/**
 * P3-S4 T-17 — THE UPGRADE MATRIX (docs/PHASE_3_S4_CONTRACT.md A-02, §2.1,
 * §2.5, §2.7, §6 T-17).
 *
 * A database frozen at the P3-S3 checkpoint (0062) holding a live business —
 * suppliers do not exist yet, but stock does: an S3 adjustment with its
 * journal entry, and a transfer — is migrated to 0063/0064 and:
 *
 * - exactly the S4 migrations apply, first 0063 then 0064;
 * - books, ledger, documents and catalogue are byte-for-byte as they were,
 *   plus the two accounting source types 0063 is authorized to add;
 * - the registries are exactly S3 + S4 (§2.5), every S4 table and bridge is
 *   empty and arrived with row security enabled and forced;
 * - no internal principal keeps CREATE on `public`;
 * - the existing business then works under the new rules (a supplier, a
 *   draft and a receipt onto its existing stock, rolled back);
 * - a second run applies nothing.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { parseQuantity, toQ4 } from '../../packages/inventory/src';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  APP_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  PLATFORM_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  dbUrl,
  ensurePostgres,
} from '../helpers/test-app';
import { must, runCommand as runS3, seedS3Business, today, transferCommand } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import { createSupplier, draftAndReceive, draftCommand, entryOf, S4_BRIDGES, S4_TABLES } from '../helpers/purchase-commands';
import { S4_OPERATION_KINDS, S4_OPERATION_MOVEMENT_KINDS, S4_SOURCE_TYPES } from '../helpers/purchase-deficits';
// P3-S5 (0065/0066)
// P3-S6 (0067/0068): and the S6 kinds and accounting source types.
import { S5_OPERATION_KINDS, S5_OPERATION_MOVEMENT_KINDS, S5_SOURCE_TYPES, S6_ACCOUNTING_SOURCE_TYPES, S6_OPERATION_KINDS } from '../helpers/stock-ledger';
import { P3C_REGISTRY_ROWS, P3C_SOURCE_TYPE_ROWS } from '../helpers/p3c-migrations';
// P4-AL-88: the accepted Phase 3 head, the boundary this suite's exact equalities are scoped to.
import { PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';
import { backfillAuditViolations, phase3RegistryViolations, phase3Registrants, phase3ScopeViolations } from '../helpers/phase3-scope-drift';

const SCRATCH = 'daftar_upgrade_0062';
const scratchUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
const FROZEN = '0062_inventory_movement_commands.sql';

function bootstrapSql(): string {
  return readFileSync(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8')
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD);
}

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-mig-s4-'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (f <= upTo) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
}

function migrationsAfter(after: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f > after)
    .sort();
}

/** The scratch database is dropped WITH (FORCE); the pool must not re-throw that termination (the migration-upgrade precedent). */
function scratchPool(connectionString: string, max = 2): Pool {
  const pool = new Pool({ connectionString, max });
  pool.on('error', () => undefined);
  return pool;
}

const admin = scratchPool(dbUrl, 1);

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
});

describe('T-17 the P3-S4 upgrade matrix', () => {
  it('frozen 0062-checkpoint + a business with stock and books → 0063/0064, everything untouched, registries exactly S3 + S4 (P3-S5: + S5), rerun no-op', async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const pool = scratchPool(scratchUrl);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(scratchUrl, preDir);
      rmSync(preDir, { recursive: true, force: true });
      await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);
      await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);

      // The checkpoint is honest: the S3 documents are there, the S4 ones are not.
      for (const t of [...S4_TABLES, ...S4_BRIDGES]) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t])).rows, t).toEqual([]);
      }

      // A live business of the checkpoint: stock through the real S3 commands, with its entry.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Upgrade owner') RETURNING id`, [
            `s4-upgrade-${randomUUID().slice(0, 8)}@test.daftar.local`,
          ])
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 's4up');
      const seed = await pool.connect();
      try {
        await seed.query('BEGIN');
        await stockUp(seed, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '5', unitCost: '10' }]);
        await runS3(seed, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '1' }]));
        await seed.query('COMMIT');
      } catch (e) {
        await seed.query('ROLLBACK');
        throw e;
      } finally {
        seed.release();
      }

      const registries = async (): Promise<string[]> =>
        (
          await pool.query<{ r: string }>(
            `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
             UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
             UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
             UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds`,
          )
        ).rows
          .map((x) => x.r)
          .sort();
      const protectedRows = async (): Promise<string[]> =>
        (
          await pool.query<{ t: string }>(
            `SELECT concat_ws(':', 'acc', id, business_id, code, type, system_key, is_active) AS t FROM accounts
             UNION ALL SELECT concat_ws(':', 'je', id, business_id, entry_date, source_type, source_id) FROM journal_entries
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor, warehouse_id, branch_id) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'bind', business_id, source_type, source_id, journal_entry_id) FROM accounting_source_bindings
             UNION ALL SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
             UNION ALL SELECT concat_ws(':', 'wh', business_id, id, branch_id, name, is_default, status) FROM warehouses
             UNION ALL SELECT concat_ws(':', 'p', business_id, id, sku, status, track_inventory, unit_code, unit_decimals) FROM products
             UNION ALL SELECT concat_ws(':', 'v', business_id, id, product_id, sku, status, is_base) FROM product_variants
             UNION ALL SELECT concat_ws(':', 'mv', business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, qty_delta, unit_cost_base_minor, value_delta_base_minor) FROM stock_movements
             UNION ALL SELECT concat_ws(':', 'lvl', business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq) FROM stock_levels
             UNION ALL SELECT concat_ws(':', 'sb', business_id, source_type, source_id, source_line_id, movement_kind) FROM stock_source_bindings
             UNION ALL SELECT concat_ws(':', 'adj', business_id, id, warehouse_id, total_value_base_minor) FROM inventory_adjustments
             UNION ALL SELECT concat_ws(':', 'tr', business_id, id) FROM inventory_transfers
             UNION ALL SELECT concat_ws(':', 'use', jti, op_code) FROM inventory_assertion_uses
             UNION ALL SELECT concat_ws(':', 'audit', id, action) FROM audit_events
             UNION ALL SELECT concat_ws(':', 'kind', movement_kind, qty_sign, requires_reason, registered_by) FROM stock_movement_kinds`,
          )
        ).rows
          .map((x) => x.t)
          .sort();
      /**
       * Every role of the upgraded business with THE KEYS of its permission
       * set, and the roles a permission backfill has audited — the two
       * readings R-P4-12's correspondence is asserted over. The keys, not
       * their count: a successor that swapped one key for another on an
       * inherited role would leave a count unchanged.
       */
      const rolePermissionKeys = async (): Promise<Record<string, string[]>> =>
        Object.fromEntries(
          (
            await pool.query<{ role_id: string; keys: string[] | null }>(
              `SELECT r.id::text AS role_id,
                      (SELECT array_agg(rp.permission ORDER BY rp.permission)
                         FROM role_permissions rp WHERE rp.business_id = r.business_id AND rp.role_id = r.id) AS keys
                 FROM business_roles r`,
            )
          ).rows.map((x) => [x.role_id, x.keys ?? []]),
        );
      const backfillAuditedRoles = async (): Promise<string[]> =>
        (
          await pool.query<{ role_id: string }>(
            `SELECT DISTINCT entity_id AS role_id FROM audit_events
              WHERE action = 'structure.permission_backfilled' AND entity = 'role' ORDER BY 1`,
          )
        ).rows.map((x) => x.role_id);

      const before = await protectedRows();
      expect(before.filter((t) => t.startsWith('mv:')).length, 'the checkpoint holds movements').toBe(3);
      expect(before.filter((t) => t.startsWith('je:')).length, 'and an entry').toBe(1);
      const registriesBefore = await registries();

      // P4-AL-88. The two equalities that follow — a digest of every protected
      // row, and the whole of four registries — were taken after an UNBOUNDED
      // upgrade, so they were claims about the phase that follows this one:
      // `0076`'s audited permission backfill leaves an `audit_events` row, and
      // an accepted P3-S4 gate went red for a reason that has nothing to do
      // with the S4 upgrade. They are re-expressed by SCOPE, not loosened: the
      // upgrade is stopped at the ACCEPTED PHASE 3 HEAD, which `0000`-`0073`
      // being frozen byte for byte (P4-AL-85) closes to every later phase, and
      // both equalities below are the ones that were here, word for word. The
      // migrations BEYOND that head are then applied in their own step, which
      // carries the disjointness half and admits that audit row POSITIVELY —
      // by what it records, and by the backfill it records having really
      // happened (R-P4-12) — never by relaxing the list. This is the shape the
      // three sibling upgrade matrices (P3-S5, P3-S6, and the P3-S8 row of
      // `migration-upgrade.test.ts`) now carry.
      const toPhase3Head = migrationsUpTo(PHASE4_INHERITED_PREFIX_END);
      let applied: string[];
      try {
        applied = await runMigrations(scratchUrl, toPhase3Head);
      } finally {
        rmSync(toPhase3Head, { recursive: true, force: true });
      }
      expect(applied).toEqual(migrationsAfter(FROZEN).filter((f) => f <= PHASE4_INHERITED_PREFIX_END));
      expect(applied.slice(0, 2)).toEqual(['0063_purchases_suppliers_sources.sql', '0064_purchase_commands.sql']);

      // Everything as it was, plus the two accounting source types 0063 adds (§2.1, A-14).
      // P3-S5 (0065/0066): and the one 0065 adds (docs/PHASE_3_S5_CONTRACT.md A-05).
      // P3-S6 (0067/0068): and the three 0067 adds (docs/PHASE_3_S6_CONTRACT.md A-05).
      expect(await protectedRows()).toEqual(
        [
          ...before,
          'src:purchase:6',
          'src:negative_inventory_cost_adjustment:7',
          // P3-S5 (0065/0066)
          'src:supplier_return:8',
          // P3-S6 (0067/0068)
          'src:supplier_payment:9',
          'src:supplier_credit_allocation:10',
          'src:supplier_refund:11',
          // Phase 3 corrective (0072)
          ...P3C_SOURCE_TYPE_ROWS,
        ].sort(),
      );

      // The registries: the checkpoint's rows plus exactly S4's (§2.5).
      expect(await registries()).toEqual(
        [
          ...registriesBefore,
          ...S4_SOURCE_TYPES.map((t) => `type:${t}:P3-S4`),
          ...S4_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `map:${op}:${kind}:P3-S4`),
          ...S4_OPERATION_KINDS.map((op) => `op:${op}:P3-S4`),
          'acct:post:purchase',
          'acct:post:negative_inventory_cost_adjustment',
          // P3-S5 (0065/0066): the upgrade runs to the latest migration, so S5's
          // rows follow (docs/PHASE_3_S5_CONTRACT.md §2.1, §2.6, §7.3 row 24) — and only they.
          ...S5_SOURCE_TYPES.map((t) => `type:${t}:P3-S5`),
          ...S5_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `map:${op}:${kind}:P3-S5`),
          ...S5_OPERATION_KINDS.map((op) => `op:${op}:P3-S5`),
          'acct:post:supplier_return',
          // P3-S6 (0067/0068): then S6's (docs/PHASE_3_S6_CONTRACT.md §2.8, A-03,
          // A-05, §7.3 row 5) — seven op kinds, three accounting pairs, no stock row.
          ...S6_OPERATION_KINDS.map((op) => `op:${op}:P3-S6`),
          ...S6_ACCOUNTING_SOURCE_TYPES.map((t) => `acct:post:${t}`),
          // Phase 3 corrective (0072, TD-16): the write-off kind and its accounting pair.
          ...P3C_REGISTRY_ROWS,
        ].sort(),
      );

      // ── BEYOND the accepted Phase 3 head: the disjointness half ─────────
      //
      // What the migrations past the accepted head CREATE is the next phase's
      // business, and this suite claims nothing about it. What they may not do
      // is reach back into the scope P3-S4 owns, and that is asserted here —
      // so "and nothing more" is still said about the scope that is Phase 3's.
      const atPhase3Head = await protectedRows();
      const registriesAtPhase3Head = await registries();
      const permsAtPhase3Head = await rolePermissionKeys();
      const beyond = await runMigrations(scratchUrl);
      expect(beyond, 'and beyond the accepted head, exactly the files that follow it').toEqual(migrationsAfter(PHASE4_INHERITED_PREFIX_END));
      const afterBeyond = await protectedRows();
      const registriesAfterBeyond = await registries();
      // (i) Not one row that stood at the accepted head was removed or
      //     rewritten, and nothing was ADDED to that scope but a declarative
      //     registration or a migration's own audited structure record.
      expect(phase3ScopeViolations(atPhase3Head, afterBeyond), 'the migrations beyond the accepted head did not reach into the Phase 3 scope').toEqual([]);
      expect(atPhase3Head.length, 'and that scope is not empty').toBeGreaterThan(0);
      // (ii) In the registries: every row that stood at the head still stands,
      //      and the rows whose provenance records a PHASE 3 registrant are
      //      EXACTLY the ones that were there.
      expect(phase3RegistryViolations(registriesAtPhase3Head, registriesAfterBeyond), 'and no Phase 3 registry row was removed, rewritten or added').toEqual(
        [],
      );
      expect(phase3Registrants(registriesAtPhase3Head).length, 'and the Phase 3 half of the registries is not empty').toBeGreaterThan(0);
      // (iii) The one audit row the digest legitimately gained is admitted by
      //       what it RECORDS. R-P4-12: a permission backfill that leaves no
      //       audit row raises, so the correspondence is asserted in both
      //       directions — a silent backfill, an audit row with no backfill, a
      //       permission taken away and a role appearing or vanishing are each
      //       red.
      const permsAfterBeyond = await rolePermissionKeys();
      expect(Object.keys(permsAfterBeyond).length, 'the upgraded business really has roles, so this is not vacuous').toBeGreaterThan(0);
      expect(
        backfillAuditViolations(permsAtPhase3Head, permsAfterBeyond, await backfillAuditedRoles()),
        'the audited-backfill correspondence holds in both directions',
      ).toEqual([]);

      // Every S4 table and bridge is empty, and arrived with row security enabled and forced.
      const s4 = [...S4_TABLES, ...S4_BRIDGES];
      const counts = (await pool.query<{ t: string; n: number }>(s4.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))).rows;
      expect(Object.fromEntries(counts.map((r) => [r.t, r.n]))).toEqual(Object.fromEntries(s4.map((t) => [t, 0])));
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [s4],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...s4].sort());
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // The existing business lives under the new rules: a supplier, a draft
      // and a receipt of 2 at 12.00 onto its existing 4 @ 10 (rolled back).
      const live = await pool.connect();
      try {
        await live.query('BEGIN');
        const supplierId = await createSupplier(live, biz, { name: 'Post-upgrade supplier' });
        const levelOf = async (): Promise<{ onHand: bigint; valuation: bigint }> => {
          const r = must(
            (
              await live.query<{ on_hand: string; valuation: string }>(
                `SELECT on_hand::text AS on_hand, valuation_base_minor::text AS valuation FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
                [biz.businessId, biz.w1, biz.piece.variantId],
              )
            ).rows[0],
          );
          return { onHand: parseQuantity(r.on_hand), valuation: BigInt(r.valuation) };
        };
        const existing = await levelOf();
        const run = await draftAndReceive(
          live,
          biz,
          await draftCommand(live, supplierId, biz.w1, [{ variantId: biz.piece.variantId, qty: '2', unitPriceMinor: '1200' }], {
            documentDate: await today(live),
          }),
        );
        expect(run.purchaseEntry?.created).toBe(true);
        const B = run.prepared.cmd.totalBaseMinor.toString(10);
        const entry = must(await entryOf(live, biz.businessId, 'purchase', run.prepared.cmd.purchaseId));
        expect(entry.lines.map((l) => [l.system_key, l.debit, l.credit])).toEqual([
          ['inventory', B, '0'],
          ['accounts_payable', '0', B],
        ]);
        expect(await levelOf(), 'the receipt lands on the existing key').toEqual({
          onHand: existing.onHand + toQ4('2'),
          valuation: existing.valuation + run.prepared.cmd.totalBaseMinor,
        });
        await live.query('SET CONSTRAINTS ALL IMMEDIATE');
      } finally {
        await live.query('ROLLBACK');
        live.release();
      }

      // A second run applies nothing — and changes nothing. The expected list
      // that stood here was the same exact equality as above, so it is
      // re-expressed as IDENTITY with the state the assertions above pinned:
      // that state is the accepted head's exact list plus only what (i), (ii)
      // and (iii) permit a successor to have added, and this claim is stricter
      // about the rerun itself, since a rerun that added ANY row — Phase 3's or
      // a later phase's — is now red.
      expect(await runMigrations(scratchUrl)).toEqual([]);
      expect(await protectedRows(), 'the rerun is a no-op over every protected row').toEqual(afterBeyond);
      expect(await registries(), 'and over every registry').toEqual(registriesAfterBeyond);
      expect(await rolePermissionKeys(), 'and over every role’s permissions').toEqual(permsAfterBeyond);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    }
  }, 180_000);
});
