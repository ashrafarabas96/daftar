/**
 * P3-S2 — THE STOCK-LEDGER HARNESS (docs/PHASE_3_S2_CONTRACT.md §5, H-1 … H-5).
 *
 * At the end of P3-S2 no operation kind maps to any movement kind and no
 * source type is registered (L:1992), so the trusted primitive has no
 * reachable producer. Every suite that needs a movement therefore installs a
 * FIXTURE producer — a fixture operation kind with its op→kind mapping, a
 * fixture source type with the bridge-and-binding-trigger template that S3–S5
 * copy, and an entry routine owned by the internal principal that consumes a
 * real `invctl/1` assertion and calls the real primitive — inside a
 * transaction that is ROLLED BACK (A-11, L:1437, P:147). Only the
 * two-connection suites commit it, with an idempotent cleanup before and after
 * and a post-cleanup assertion that the registries are back to the migration
 * state.
 *
 * Nothing here re-implements the primitive. The SQL side of every comparison
 * is R1, R2 or R3 itself (H-4); the only routines this file defines that touch
 * stock rows are the two CONTROL routines (payload-order locking and an
 * unlocked read-modify-write), used exclusively by the negative controls that
 * must show what the real primitive prevents.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Client, DatabaseError, type Pool } from 'pg';
import { expect } from 'vitest';
import { INVCTL_VERSION, configureProductPayload, inventoryAssertionPreimage } from '../../packages/inventory/src';
import {
  INVENTORY_ASSERTION_KID,
  appDbUrl,
  dbUrl,
  identityDbUrl,
  inventoryAssertionKey,
  mintTestInventoryAssertion,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  reconcilerDbUrl,
  resolverDbUrl,
  workerDbUrl,
} from './test-app';

// ── constants ──────────────────────────────────────────────────────────────

export const INTERNAL = 'daftar_inventory_internal';
export const FIXTURE_OP = 'fixture.stock_move';
export const FIXTURE_OP_OTHER = 'fixture.stock_other';
export const FIXTURE_SOURCE_TYPE = 'fixture_line';

/** Every runtime login role and the connection string a stolen credential of it would use. */
export const RUNTIME_ROLES: readonly { readonly role: string; readonly url: string }[] = [
  { role: 'daftar_app', url: appDbUrl },
  { role: 'daftar_platform', url: platformDbUrl },
  { role: 'daftar_worker', url: workerDbUrl },
  { role: 'daftar_identity', url: identityDbUrl },
  { role: 'daftar_resolver', url: resolverDbUrl },
  { role: 'daftar_provisioner', url: provisionerDbUrl },
  { role: 'daftar_reconciler', url: reconcilerDbUrl },
];

/** The eight S2 relations (§2.2, §2.3). */
export const S2_RELATIONS = [
  'inventory_operation_movement_kinds',
  'negative_deficit_coverages',
  'negative_inventory_deficits',
  'stock_levels',
  'stock_movement_kinds',
  'stock_movements',
  'stock_source_bindings',
  'stock_source_types',
] as const;

/** R1–R8 by signature (§2.5), and R9 — the variant stock-identity lock (review finding H-1). */
export const S2_ROUTINES = [
  'inventory_half_even(numeric,numeric,integer)',
  'inventory_quantity_is_representable(numeric,smallint)',
  'inventory_apply_stock_movements(inventory_movement_request[])',
  'inventory_next_deficit_seq(uuid,uuid,uuid)',
  'inventory_stock_fold(uuid,uuid,uuid)',
  'inventory_stock_verify(uuid,uuid,uuid)',
  'products_20_unit_history_lock()',
  'stock_levels_zero_on_hand_zero_value()',
  'product_variants_20_stock_identity_lock()',
] as const;

/** The ten Phase 3 kinds as 0059 seeds them (§2.2). */
export const SEEDED_KINDS: readonly { kind: string; qtySign: string; requiresReason: boolean }[] = [
  { kind: 'adjustment', qtySign: 'either', requiresReason: true },
  { kind: 'damage', qtySign: 'negative', requiresReason: true },
  { kind: 'inventory_opening', qtySign: 'positive', requiresReason: false },
  { kind: 'negative_inventory_cost_adjustment', qtySign: 'zero', requiresReason: false },
  { kind: 'purchase', qtySign: 'positive', requiresReason: false },
  { kind: 'purchase_reversal', qtySign: 'negative', requiresReason: false },
  { kind: 'stocktake', qtySign: 'either', requiresReason: false },
  { kind: 'supplier_return', qtySign: 'negative', requiresReason: false },
  { kind: 'transfer_in', qtySign: 'positive', requiresReason: false },
  { kind: 'transfer_out', qtySign: 'negative', requiresReason: false },
];

export const S1_OPERATION_KINDS = ['inventory.configure_product', 'structure.associate_warehouse_branch', 'structure.dissociate_warehouse_branch'] as const;

// ── small utilities ────────────────────────────────────────────────────────

/** Narrow an optional to its value, loudly (the accounting-posting precedent). */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, found none`);
  return value;
}

export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Anything that can run a query: a pool, a pooled client or a raw client. */
export interface Queryable {
  query: Client['query'];
}

// ── outcomes: SQLSTATE plus the stable code, never a message fragment ─────

export type Outcome<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly sqlstate: string; readonly code: string; readonly constraint: string | null; readonly message: string };

const STABLE_CODE = /^([a-z_]+\.[a-z_]+):/;

export function outcomeOfError(e: unknown): Outcome<never> {
  if (e instanceof DatabaseError) {
    return { ok: false, sqlstate: e.code ?? '', code: STABLE_CODE.exec(e.message)?.[1] ?? '', constraint: e.constraint ?? null, message: e.message };
  }
  if (e instanceof Error) return { ok: false, sqlstate: '', code: '', constraint: null, message: e.message };
  return { ok: false, sqlstate: '', code: '', constraint: null, message: String(e) };
}

/** Run one step without a savepoint (a fresh connection, or the last statement of a transaction). */
export async function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    return outcomeOfError(e);
  }
}

/**
 * Run one step inside a SAVEPOINT of an open transaction, so a refusal leaves
 * the rest of the transaction usable. A refused step is rolled back to the
 * savepoint (which also undoes any SET LOCAL ROLE it made); an accepted one is
 * kept.
 */
export async function attempt<T>(c: Queryable, run: () => Promise<T>): Promise<Outcome<T>> {
  await c.query('SAVEPOINT stock_attempt');
  try {
    const value = await run();
    await c.query('RELEASE SAVEPOINT stock_attempt');
    return { ok: true, value };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT stock_attempt');
    return outcomeOfError(e);
  }
}

/**
 * What COMMIT would say about the deferred constraints, without committing:
 * `SET CONSTRAINTS ALL IMMEDIATE` fires every pending deferred FK check and
 * constraint trigger now (A-11). Always rolled back to its savepoint, so the
 * transaction continues exactly as it was and the checks re-arm for COMMIT.
 */
export async function atCommit(c: Queryable): Promise<Outcome<null>> {
  await c.query('SAVEPOINT stock_commit_probe');
  try {
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { ok: true, value: null };
  } catch (e) {
    return outcomeOfError(e);
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT stock_commit_probe');
  }
}

/**
 * Run `fn` inside a SAVEPOINT that is ALWAYS rolled back: how a negative
 * control removes an invariant (drops a trigger, a constraint, a policy)
 * for exactly one probe and restores it for the rest of the transaction.
 */
export async function scratch<T>(c: Queryable, fn: () => Promise<T>): Promise<T> {
  await c.query('SAVEPOINT stock_scratch');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT stock_scratch');
  }
}

export function expectRefused(o: Outcome, sqlstate: string, code: string | null, why = ''): void {
  if (o.ok) throw new Error(`${why ? `${why}: ` : ''}expected ${sqlstate}${code === null ? '' : ` ${code}`}, but it was accepted`);
  expect({ sqlstate: o.sqlstate, code: code === null ? null : o.code }, `${why} — ${o.message}`).toEqual({ sqlstate, code });
}

export function expectAccepted<T>(o: Outcome<T>, why = ''): T {
  if (!o.ok) throw new Error(`${why ? `${why}: ` : ''}expected acceptance, got ${o.sqlstate} ${o.message}`);
  return o.value;
}

/** A refusal whose FK is the one named `conname` — asserted from pg_constraint, not from the message. */
export function expectConstraint(o: Outcome, sqlstate: string, conname: string, why = ''): void {
  if (o.ok) throw new Error(`${why ? `${why}: ` : ''}expected ${sqlstate} on ${conname}, but it was accepted`);
  expect({ sqlstate: o.sqlstate, constraint: o.constraint }, `${why} — ${o.message}`).toEqual({ sqlstate, constraint: conname });
}

// ── connections ────────────────────────────────────────────────────────────

/** A raw superuser (schema-owner) connection. */
export async function ownerClient(): Promise<Client> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  return c;
}

export async function roleClient(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

export async function pidOf(c: Queryable): Promise<number> {
  return must((await c.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]).pid;
}

/**
 * Wait, bounded, until the backend `pid` is parked on a heavyweight lock.
 * Scoped to that pid: pg_stat_activity is cluster-wide. The bound is a
 * failure, never a pass — a statement that never blocks fails the case.
 */
export async function waitUntilBlocked(pid: number, what: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
      [pid],
    );
    if (must(r.rows[0]).n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what}: backend ${pid} never waited on a lock`);
}

/** Is `pid` waiting on a lock right now? (A point observation, used to prove a statement did NOT block.) */
export async function isBlocked(pid: number): Promise<boolean> {
  const r = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
    [pid],
  );
  return must(r.rows[0]).n > 0;
}

// ── scope and assertions ──────────────────────────────────────────────────

export interface Scope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly userId: string;
}

export async function setScope(c: Queryable, s: { tenantId: string; businessId: string }): Promise<void> {
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [s.tenantId, s.businessId]);
}

/** The `invpl/1` digest of a fixture entry routine's one argument (its nonce). */
export function fixtureDigest(opCode: string, tenantId: string, businessId: string, nonce: string): string {
  return sha256hex(`invpl/1\n${opCode}\n${tenantId}\n${businessId}\n${nonce}\n`);
}

export interface FixtureAssertionInput {
  opCode: string;
  actorUserId: string;
  tenantId: string;
  businessId: string;
  nonce: string;
  jti?: string;
  now?: Date;
  ttlSeconds?: number;
}

/**
 * Mint an `invctl/1` assertion for a FIXTURE operation kind (§5, H-2). The
 * package minter refuses kinds it does not know (assertion.ts:168-173), so the
 * assertion is built here over the same preimage with the same test key.
 */
export function mintFixtureAssertion(i: FixtureAssertionInput): string {
  const now = i.now ?? new Date();
  const ttl = i.ttlSeconds ?? 60;
  const signed = [
    INVCTL_VERSION,
    INVENTORY_ASSERTION_KID,
    i.actorUserId,
    i.tenantId,
    i.businessId,
    i.opCode.replace(/\./g, ':'),
    fixtureDigest(i.opCode, i.tenantId, i.businessId, i.nonce),
    String(Math.floor(now.getTime() / 1000) + ttl),
    i.jti ?? randomUUID(),
  ];
  const mac = createHmac('sha256', inventoryAssertionKey().secret).update(inventoryAssertionPreimage(signed)).digest('hex');
  return `${signed.join('.')}.${mac}`;
}

// ── the fixture producer (H-2) ─────────────────────────────────────────────

function entryRoutineSql(name: string, op: string): string {
  return `
CREATE FUNCTION ${name}(p_nonce UUID, p_requests inventory_movement_request[], p_bridge BOOLEAN DEFAULT true)
RETURNS TABLE (ordinal INTEGER, movement_id UUID, warehouse_id UUID, variant_id UUID, stock_seq BIGINT, movement_kind TEXT,
               qty_delta NUMERIC, unit_cost_base_minor NUMERIC, value_delta_base_minor BIGINT,
               on_hand NUMERIC, valuation_base_minor BIGINT, avg_unit_cost_base_minor NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fx$
#variable_conflict use_column
DECLARE
  v_actor inventory_verified_actor;
BEGIN
  v_actor := inventory_assertion_consume('${op}',
               inventory_claimed_payload_digest('${op}', ARRAY['uuid'], ARRAY[p_nonce::text]));
  -- The domain lines: one per distinct (source_id, source_line_id). Values
  -- that a line could not hold are left NULL: the line is the SOURCE's row,
  -- the primitive decides the movement.
  INSERT INTO stock_fixture_lines (business_id, source_id, id, warehouse_id, variant_id, qty, unit_cost_base_minor)
  SELECT DISTINCT ON (r.source_id, r.source_line_id)
         v_actor.business_id, r.source_id, r.source_line_id, r.warehouse_id, r.variant_id,
         CASE WHEN abs(r.qty_delta) < 100000000000000 THEN r.qty_delta END,
         CASE WHEN r.unit_cost_base_minor >= 0 AND r.unit_cost_base_minor < 1000000000000000000 THEN r.unit_cost_base_minor END
  FROM unnest(coalesce(p_requests, ARRAY[]::inventory_movement_request[])) AS r
  WHERE r.source_id IS NOT NULL AND r.source_line_id IS NOT NULL
  ORDER BY r.source_id, r.source_line_id
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT * FROM inventory_apply_stock_movements(p_requests);

  -- The bridge rows, after the bindings exist (the bridge's binding FK is immediate).
  IF p_bridge THEN
    INSERT INTO stock_source_bridge_fixture_line (business_id, source_id, source_line_id, movement_kind)
    SELECT DISTINCT v_actor.business_id, r.source_id, r.source_line_id, r.movement_kind
    FROM unnest(p_requests) AS r
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN;
END;
$fx$;
REVOKE ALL ON FUNCTION ${name}(UUID, inventory_movement_request[], BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${name}(UUID, inventory_movement_request[], BOOLEAN) TO daftar_app;
ALTER FUNCTION ${name}(UUID, inventory_movement_request[], BOOLEAN) OWNER TO ${INTERNAL};
`;
}

const INSTALL_SQL = `
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('${FIXTURE_OP}', 'P3-S2'), ('${FIXTURE_OP_OTHER}', 'P3-S2');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by)
  SELECT '${FIXTURE_OP}', k.movement_kind, 'P3-S2' FROM stock_movement_kinds k WHERE k.movement_kind <> 'purchase_reversal';
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES ('${FIXTURE_OP_OTHER}', 'purchase_reversal', 'P3-S2');
INSERT INTO stock_source_types (source_type, registered_by) VALUES ('${FIXTURE_SOURCE_TYPE}', 'P3-S2');

-- The fixture's DOMAIN line table: what purchase_items / inventory_transfer_lines will be.
CREATE TABLE stock_fixture_lines (
  business_id          UUID NOT NULL,
  source_id            UUID NOT NULL,
  id                   UUID NOT NULL,
  warehouse_id         UUID,
  variant_id           UUID,
  qty                  NUMERIC(18,4),
  unit_cost_base_minor NUMERIC(28,10),
  PRIMARY KEY (business_id, source_id, id)
);
REVOKE ALL ON stock_fixture_lines FROM PUBLIC;
GRANT SELECT, INSERT ON stock_fixture_lines TO ${INTERNAL};

-- The bridge: exactly the L:1501-1519 template (the one S3-S5 copy).
CREATE TABLE stock_source_bridge_fixture_line (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('${FIXTURE_SOURCE_TYPE}') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT bridge_fixture_line_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES stock_fixture_lines (business_id, source_id, id) ON DELETE RESTRICT,
  CONSTRAINT bridge_fixture_line_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_fixture_line FROM PUBLIC;
ALTER TABLE stock_source_bridge_fixture_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_fixture_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON stock_source_bridge_fixture_line
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_source_bridge_fixture_line AS RESTRICTIVE
  USING      (app_bypass() OR current_user = '${INTERNAL}' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_fixture_line
  FOR SELECT TO ${INTERNAL} USING (true);
GRANT SELECT, INSERT ON stock_source_bridge_fixture_line TO ${INTERNAL};
CREATE TRIGGER stock_bridge_immutable_${FIXTURE_SOURCE_TYPE}
  BEFORE UPDATE OR DELETE ON stock_source_bridge_fixture_line
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

-- The binding-side check: a binding of this type has its bridge row at COMMIT.
CREATE FUNCTION stock_binding_requires_${FIXTURE_SOURCE_TYPE}() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fx$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_fixture_line b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$fx$;
REVOKE ALL ON FUNCTION stock_binding_requires_${FIXTURE_SOURCE_TYPE}() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER stock_binding_requires_${FIXTURE_SOURCE_TYPE}
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = '${FIXTURE_SOURCE_TYPE}')
  EXECUTE FUNCTION stock_binding_requires_${FIXTURE_SOURCE_TYPE}();
ALTER FUNCTION stock_binding_requires_${FIXTURE_SOURCE_TYPE}() OWNER TO ${INTERNAL};

-- The source-side freeze (P3-AL-51 §D): a line with a bridge row is final.
CREATE FUNCTION stock_fixture_lines_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fx$
BEGIN
  IF (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.unit_cost_base_minor IS DISTINCT FROM OLD.unit_cost_base_minor
      OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id)
     AND EXISTS (SELECT 1 FROM stock_source_bridge_fixture_line b
                  WHERE b.business_id = OLD.business_id AND b.source_id = OLD.source_id AND b.source_line_id = OLD.id) THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: a bound source line is final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fx$;
REVOKE ALL ON FUNCTION stock_fixture_lines_freeze() FROM PUBLIC;
CREATE TRIGGER stock_fixture_lines_freeze BEFORE UPDATE ON stock_fixture_lines
  FOR EACH ROW EXECUTE FUNCTION stock_fixture_lines_freeze();

${entryRoutineSql('stock_fixture_apply', FIXTURE_OP)}
${entryRoutineSql('stock_fixture_apply_other', FIXTURE_OP_OTHER)}

-- CONTROL (T-04.N only): lock the keys FOR UPDATE in PAYLOAD order, pausing at
-- a test-held gate after the first key. Superuser-owned, granted to nobody.
CREATE FUNCTION stock_fixture_lock_in_payload_order(p_tenant UUID, p_business UUID, p_warehouses UUID[], p_variants UUID[], p_gate BIGINT)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fx$
DECLARE
  i INTEGER;
BEGIN
  FOR i IN 1 .. cardinality(p_warehouses) LOOP
    INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id)
    VALUES (p_tenant, p_business, p_warehouses[i], p_variants[i])
    ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING;
    PERFORM 1 FROM stock_levels l
     WHERE l.business_id = p_business AND l.warehouse_id = p_warehouses[i] AND l.variant_id = p_variants[i]
       FOR UPDATE;
    IF i = 1 THEN
      PERFORM pg_advisory_xact_lock_shared(p_gate);
    END IF;
  END LOOP;
  RETURN cardinality(p_warehouses);
END;
$fx$;
REVOKE ALL ON FUNCTION stock_fixture_lock_in_payload_order(UUID, UUID, UUID[], UUID[], BIGINT) FROM PUBLIC;

-- CONTROL (T-03.N only): a read-modify-write of the cache WITHOUT the locking
-- read, pausing at a test-held gate between the read and the write.
CREATE FUNCTION stock_fixture_unlocked_add(p_business UUID, p_warehouse UUID, p_variant UUID, p_qty NUMERIC, p_gate BIGINT)
RETURNS NUMERIC LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fx$
DECLARE
  v_read NUMERIC;
BEGIN
  SELECT l.on_hand INTO v_read FROM stock_levels l
   WHERE l.business_id = p_business AND l.warehouse_id = p_warehouse AND l.variant_id = p_variant;
  PERFORM pg_advisory_xact_lock_shared(p_gate);
  UPDATE stock_levels l SET on_hand = v_read + p_qty
   WHERE l.business_id = p_business AND l.warehouse_id = p_warehouse AND l.variant_id = p_variant;
  RETURN v_read + p_qty;
END;
$fx$;
REVOKE ALL ON FUNCTION stock_fixture_unlocked_add(UUID, UUID, UUID, NUMERIC, BIGINT) FROM PUBLIC;
`;

/** H-2: install the fixture producer, as the superuser, in the CALLER's transaction. */
export async function installStockFixture(c: Queryable): Promise<void> {
  await c.query(INSTALL_SQL);
}

/**
 * The default lifecycle (A-11): BEGIN, install the fixture, run, ROLLBACK —
 * always, whatever `fn` did. `install: false` gives the bare migration state;
 * `isolation` opens the transaction at another level (the M-1 refusals).
 */
export async function withRolledBackFixture<T>(
  fn: (c: Client) => Promise<T>,
  opts: { install?: boolean; isolation?: 'REPEATABLE READ' | 'SERIALIZABLE' } = {},
): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query(opts.isolation === undefined ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${opts.isolation}`);
    if (opts.install !== false) await installStockFixture(c);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/** The migration state the registries must be back to after any committed fixture. */
export async function assertMigrationState(q: Queryable = ownerPool()): Promise<void> {
  const r = await q.query<{ types: number; mapping: number; kinds: string[]; uses: number; rels: number; fns: number }>(
    `SELECT (SELECT count(*)::int FROM stock_source_types) AS types,
            (SELECT count(*)::int FROM inventory_operation_movement_kinds) AS mapping,
            (SELECT array_agg(op_code ORDER BY op_code) FROM inventory_operation_kinds) AS kinds,
            (SELECT count(*)::int FROM inventory_assertion_uses WHERE op_code LIKE 'fixture.%') AS uses,
            (SELECT count(*)::int FROM pg_class WHERE relname IN ('stock_fixture_lines', 'stock_source_bridge_fixture_line')) AS rels,
            (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'stock\\_fixture\\_%' OR proname = 'stock_binding_requires_fixture_line') AS fns`,
  );
  expect(r.rows[0]).toEqual({ types: 0, mapping: 0, kinds: [...S1_OPERATION_KINDS], uses: 0, rels: 0, fns: 0 });
}

/**
 * Remove a committed fixture and everything it produced. Idempotent: every
 * step tolerates the fixture being absent. Append-only triggers refuse DELETE,
 * so the stock rows go by TRUNCATE (deliberately unguarded, E-24).
 */
export async function removeCommittedFixture(): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const bridge = must((await c.query<{ r: string | null }>(`SELECT to_regclass('public.stock_source_bridge_fixture_line')::text AS r`)).rows[0]).r;
    const lines = must((await c.query<{ r: string | null }>(`SELECT to_regclass('public.stock_fixture_lines')::text AS r`)).rows[0]).r;
    const extra = [bridge, lines].filter((x): x is string => x !== null);
    await c.query(
      `TRUNCATE ${['stock_source_bindings', 'stock_movements', 'stock_levels', 'negative_deficit_coverages', 'negative_inventory_deficits', ...extra].join(', ')}`,
    );
    await c.query(`DROP TRIGGER IF EXISTS stock_binding_requires_${FIXTURE_SOURCE_TYPE} ON stock_source_bindings`);
    await c.query(`DROP TABLE IF EXISTS stock_source_bridge_fixture_line`);
    await c.query(`DROP TABLE IF EXISTS stock_fixture_lines`);
    for (const f of [
      `stock_binding_requires_${FIXTURE_SOURCE_TYPE}()`,
      'stock_fixture_lines_freeze()',
      'stock_fixture_apply(UUID, inventory_movement_request[], BOOLEAN)',
      'stock_fixture_apply_other(UUID, inventory_movement_request[], BOOLEAN)',
      'stock_fixture_lock_in_payload_order(UUID, UUID, UUID[], UUID[], BIGINT)',
      'stock_fixture_unlocked_add(UUID, UUID, UUID, NUMERIC, BIGINT)',
    ]) {
      await c.query(`DROP FUNCTION IF EXISTS ${f}`);
    }
    await c.query(`DELETE FROM inventory_assertion_uses WHERE op_code LIKE 'fixture.%'`);
    await c.query(`DELETE FROM inventory_operation_movement_kinds WHERE op_code LIKE 'fixture.%'`);
    await c.query(`DELETE FROM stock_source_types WHERE source_type = $1`, [FIXTURE_SOURCE_TYPE]);
    await c.query(`DELETE FROM inventory_operation_kinds WHERE op_code LIKE 'fixture.%'`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end().catch(() => undefined);
  }
  await assertMigrationState();
}

/** H-3 suites only: clean, install and COMMIT the fixture. */
export async function installCommittedFixture(): Promise<void> {
  await removeCommittedFixture();
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await installStockFixture(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end().catch(() => undefined);
  }
}

// ── requests and calls ─────────────────────────────────────────────────────

/** One `inventory_movement_request`; every numeric travels as exact text. */
export interface MovementRequest {
  warehouseId: string | null;
  variantId: string | null;
  kind: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceLineId: string | null;
  qty: string | null;
  unitCost: string | null;
  value: string | null;
  reason: string | null;
}

export interface Key {
  readonly warehouseId: string;
  readonly variantId: string;
}

/** A request on `key` with a fresh source identity; `over` replaces any field. */
export function req(key: Key, kind: string, qty: string, over: Partial<MovementRequest> = {}): MovementRequest {
  return {
    warehouseId: key.warehouseId,
    variantId: key.variantId,
    kind,
    sourceType: FIXTURE_SOURCE_TYPE,
    sourceId: randomUUID(),
    sourceLineId: randomUUID(),
    qty,
    unitCost: null,
    value: null,
    reason: null,
    ...over,
  };
}

function requestJson(r: MovementRequest | null): Record<string, string | null> | null {
  if (r === null) return null;
  return {
    warehouse_id: r.warehouseId,
    variant_id: r.variantId,
    movement_kind: r.kind,
    source_type: r.sourceType,
    source_id: r.sourceId,
    source_line_id: r.sourceLineId,
    qty_delta: r.qty,
    unit_cost_base_minor: r.unitCost,
    value_delta_base_minor: r.value,
    reason: r.reason,
  };
}

/** SQL for `$n` as an `inventory_movement_request[]`, preserving order, NULL elements and a NULL array. */
export function requestsParam(n: number): string {
  return `(CASE WHEN $${n}::jsonb IS NULL THEN NULL::inventory_movement_request[] ELSE ARRAY(
            SELECT CASE WHEN t.x = 'null'::jsonb THEN NULL::inventory_movement_request
                        ELSE jsonb_populate_record(NULL::inventory_movement_request, t.x) END
            FROM jsonb_array_elements($${n}::jsonb) WITH ORDINALITY AS t(x, n) ORDER BY t.n) END)`;
}

export function requestsJson(requests: readonly (MovementRequest | null)[] | null): string | null {
  return requests === null ? null : JSON.stringify(requests.map(requestJson));
}

/** One row of the primitive's answer, as node-pg returns it. */
export interface MovementRow {
  ordinal: number;
  movement_id: string;
  warehouse_id: string;
  variant_id: string;
  stock_seq: string;
  movement_kind: string;
  qty_delta: string;
  unit_cost_base_minor: string | null;
  value_delta_base_minor: string;
  on_hand: string;
  valuation_base_minor: string;
  avg_unit_cost_base_minor: string | null;
}

export interface ApplyOptions {
  /** A ready assertion (tampering cases); otherwise one is minted for the call. */
  assertion?: string;
  nonce?: string;
  /** Use `stock_fixture_apply_other` (op `fixture.stock_other`). */
  other?: boolean;
  bridge?: boolean;
  /** Extra transaction-local GUCs (spoofing cases). */
  gucs?: Record<string, string>;
}

/**
 * H-2 calling convention: the scope GUCs and the carrier, `SET LOCAL ROLE
 * daftar_app`, the fixture entry routine, `RESET ROLE` — in the caller's
 * transaction. On a refusal the role is still daftar_app; callers wrap this in
 * `attempt`, whose ROLLBACK TO SAVEPOINT undoes the role switch.
 */
export async function applyAsApp(c: Queryable, s: Scope, requests: readonly (MovementRequest | null)[] | null, o: ApplyOptions = {}): Promise<MovementRow[]> {
  const nonce = o.nonce ?? randomUUID();
  const assertion =
    o.assertion ??
    mintFixtureAssertion({ opCode: o.other ? FIXTURE_OP_OTHER : FIXTURE_OP, actorUserId: s.userId, tenantId: s.tenantId, businessId: s.businessId, nonce });
  await setScope(c, s);
  await c.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [assertion]);
  for (const [k, v] of Object.entries(o.gucs ?? {})) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<MovementRow>(`SELECT * FROM ${o.other ? 'stock_fixture_apply_other' : 'stock_fixture_apply'}($1::uuid, ${requestsParam(2)}, $3)`, [
    nonce,
    requestsJson(requests),
    o.bridge ?? true,
  ]);
  await c.query('RESET ROLE');
  return r.rows;
}

/** `applyAsApp` inside a savepoint. */
export function tryApply(c: Queryable, s: Scope, requests: readonly (MovementRequest | null)[] | null, o: ApplyOptions = {}): Promise<Outcome<MovementRow[]>> {
  return attempt(c, () => applyAsApp(c, s, requests, o));
}

/** The one row `applyAsApp` must return for a single request. */
export async function applyOne(c: Queryable, s: Scope, r: MovementRequest, o: ApplyOptions = {}): Promise<MovementRow> {
  const rows = await applyAsApp(c, s, [r], o);
  expect(rows).toHaveLength(1);
  return must(rows[0]);
}

// ── reads (as the superuser, so RLS never hides what a test asserts) ──────

export interface LevelText {
  on_hand: string;
  valuation_base_minor: string;
  avg_unit_cost_base_minor: string | null;
  last_stock_seq: string;
}

export async function levelOf(c: Queryable, businessId: string, key: Key): Promise<LevelText | null> {
  const r = await c.query<LevelText>(
    `SELECT on_hand::text, valuation_base_minor::text, avg_unit_cost_base_minor::text, last_stock_seq::text
     FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
    [businessId, key.warehouseId, key.variantId],
  );
  return r.rows[0] ?? null;
}

export interface StoredMovementText {
  id: string;
  stock_seq: string;
  movement_kind: string;
  source_id: string;
  source_line_id: string;
  qty_delta: string;
  unit_cost_base_minor: string | null;
  value_delta_base_minor: string;
  reason: string | null;
  actor_user_id: string;
}

export async function movementsOf(c: Queryable, businessId: string, key: Key): Promise<StoredMovementText[]> {
  const r = await c.query<StoredMovementText>(
    `SELECT m.id::text, m.stock_seq::text, m.movement_kind, m.source_id::text, m.source_line_id::text, m.qty_delta::text,
            m.unit_cost_base_minor::text, m.value_delta_base_minor::text, m.reason, m.actor_user_id::text
     FROM stock_movements m WHERE m.business_id = $1 AND m.warehouse_id = $2 AND m.variant_id = $3
     ORDER BY m.stock_seq`,
    [businessId, key.warehouseId, key.variantId],
  );
  return r.rows;
}

export interface VerifyRow {
  cache_on_hand: string | null;
  rebuilt_on_hand: string | null;
  cache_valuation: string | null;
  rebuilt_valuation: string | null;
  cache_avg: string | null;
  rebuilt_avg: string | null;
  cache_last_seq: string | null;
  rebuilt_last_seq: string | null;
  matches: boolean;
}

/** R6 as the superuser under the business's scope (R6 refuses any other scope). */
export async function verify(c: Queryable, s: { tenantId: string; businessId: string }, key: Key): Promise<VerifyRow> {
  await setScope(c, s);
  const r = await c.query<VerifyRow>(
    `SELECT cache_on_hand::text, rebuilt_on_hand::text, cache_valuation::text, rebuilt_valuation::text,
            cache_avg::text, rebuilt_avg::text, cache_last_seq::text, rebuilt_last_seq::text, matches
     FROM inventory_stock_verify($1, $2, $3)`,
    [s.businessId, key.warehouseId, key.variantId],
  );
  return must(r.rows[0], 'verify row');
}

export interface FoldRow {
  on_hand: string;
  valuation_base_minor: string;
  avg_unit_cost_base_minor: string | null;
  last_stock_seq: string;
  movement_count: string;
  sequence_gapless: boolean;
}

/** R5 as the superuser under the business's scope. */
export async function fold(c: Queryable, s: { tenantId: string; businessId: string }, key: Key): Promise<FoldRow> {
  await setScope(c, s);
  const r = await c.query<FoldRow>(
    `SELECT on_hand::text, valuation_base_minor::text, avg_unit_cost_base_minor::text, last_stock_seq::text, movement_count::text, sequence_gapless
     FROM inventory_stock_fold($1, $2, $3)`,
    [s.businessId, key.warehouseId, key.variantId],
  );
  return must(r.rows[0], 'fold row');
}

// ── H-1: owner-raw seeding ─────────────────────────────────────────────────

export interface OwnerMovement {
  scope: Scope;
  key: Key;
  kind: string;
  qty: string;
  unitCost: string | null;
  value: string;
  reason?: string | null;
  stockSeq: number;
  /** The cache row after this movement, written as given. */
  cache: { onHand: string; valuation: string; avg: string | null };
  sourceId?: string;
  sourceLineId?: string;
}

/**
 * H-1: as the schema owner, write the whole chain — fixture line, binding,
 * bridge row, cache row and movement — with the GIVEN stored values. Used for
 * the P3-AL-08 seeds that stand in for a Phase 4 oversell, which no S2 kind
 * can produce through the primitive. Requires the fixture in the transaction.
 */
export async function seedOwnerMovement(c: Queryable, m: OwnerMovement): Promise<{ movementId: string; sourceId: string; sourceLineId: string }> {
  const s = m.scope;
  const sourceId = m.sourceId ?? randomUUID();
  const sourceLineId = m.sourceLineId ?? randomUUID();
  const movementId = randomUUID();
  await setScope(c, s);
  await c.query(
    `INSERT INTO stock_fixture_lines (business_id, source_id, id, warehouse_id, variant_id, qty, unit_cost_base_minor)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric) ON CONFLICT DO NOTHING`,
    [s.businessId, sourceId, sourceLineId, m.key.warehouseId, m.key.variantId, m.qty, m.unitCost],
  );
  await c.query(
    `INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) VALUES ($1, $2, $3, $4, $5, $6)`,
    [s.tenantId, s.businessId, FIXTURE_SOURCE_TYPE, sourceId, sourceLineId, m.kind],
  );
  await c.query(`INSERT INTO stock_source_bridge_fixture_line (business_id, source_id, source_line_id, movement_kind) VALUES ($1, $2, $3, $4)`, [
    s.businessId,
    sourceId,
    sourceLineId,
    m.kind,
  ]);
  await c.query(
    `INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::bigint, $7::numeric, $8)
     ON CONFLICT (business_id, warehouse_id, variant_id) DO UPDATE
       SET on_hand = EXCLUDED.on_hand, valuation_base_minor = EXCLUDED.valuation_base_minor,
           avg_unit_cost_base_minor = EXCLUDED.avg_unit_cost_base_minor, last_stock_seq = EXCLUDED.last_stock_seq`,
    [s.tenantId, s.businessId, m.key.warehouseId, m.key.variantId, m.cache.onHand, m.cache.valuation, m.cache.avg, m.stockSeq],
  );
  await c.query(
    `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id,
                                  source_line_id, qty_delta, unit_cost_base_minor, value_delta_base_minor, reason, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13::bigint, $14, $15)`,
    [
      s.tenantId,
      s.businessId,
      movementId,
      m.key.warehouseId,
      m.key.variantId,
      m.stockSeq,
      m.kind,
      FIXTURE_SOURCE_TYPE,
      sourceId,
      sourceLineId,
      m.qty,
      m.unitCost,
      m.value,
      m.reason ?? null,
      s.userId,
    ],
  );
  return { movementId, sourceId, sourceLineId };
}

// ── negative controls that remove ONE refusal from a trusted routine ──────

/**
 * Replace `routine` in the current transaction with its own definition in
 * which every `RAISE EXCEPTION '<code>` is demoted to a NOTICE, so the check
 * that raises `<code>` no longer refuses and control continues past it. The
 * rest of the body is byte-for-byte what is installed. `CREATE OR REPLACE` by
 * the superuser keeps the owner, the ACL and SECURITY DEFINER. Requires the
 * §0 error convention; if the code is not raised that way, the control fails
 * loudly rather than silently proving nothing.
 */
export async function withoutRefusal(c: Queryable, routine: string, code: string): Promise<void> {
  const def = must((await c.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [routine])).rows[0]).d;
  const needle = `RAISE EXCEPTION '${code}:`;
  const count = def.split(needle).length - 1;
  if (count < 1) throw new Error(`control: ${routine} raises no '${code}' in the §0 convention; nothing to remove`);
  await c.query(def.split(needle).join(`RAISE NOTICE '${code}:`));
}

// ── seeding (§5 "Seeding") ─────────────────────────────────────────────────

export interface ProductRef {
  readonly productId: string;
  readonly variantId: string;
}

export interface StockBusiness extends Scope {
  readonly otherUserId: string;
  readonly branchId: string;
  readonly warehouse1: string;
  readonly warehouse2: string;
  /** Tracked `piece`/0 with its base variant. */
  readonly piece: ProductRef;
  /** Tracked `metre`/2 with its base variant. */
  readonly dec2: ProductRef;
  /** Tracked `kg`/4 with its base variant. */
  readonly dec4: ProductRef;
  /** An untracked product and a merchant variant of it. */
  readonly untracked: ProductRef;
  /** A tracked variant product: two merchant variants, no base. */
  readonly variantProduct: { readonly productId: string; readonly variantIds: readonly [string, string] };
  /** A tracked product WITH a base variant AND a merchant variant beside it (A-29). */
  readonly mixed: { readonly productId: string; readonly baseVariantId: string; readonly merchantVariantId: string };
  /** A second tenant and business, with its own warehouse and tracked product. */
  readonly other: Scope & { readonly branchId: string; readonly warehouseId: string; readonly piece: ProductRef };
}

async function one(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  return must((await pool.query<{ id: string }>(sql, params)).rows[0], `id from: ${sql}`).id;
}

export async function addWarehouse(pool: Pool, businessId: string, branchId: string, name = 'Extra WH'): Promise<string> {
  return one(pool, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, $3, false) RETURNING id`, [businessId, branchId, name]);
}

/** An unconfigured product with its one required translation (the translation check is deferred). */
export async function createProduct(pool: Pool, businessId: string): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = randomUUID();
    await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 1000, 'ILS')`, [businessId, id]);
    await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Stock ledger product')`, [businessId, id]);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A merchant variant, written the way S1 lets `daftar_app`-class writers do it (not a base variant). */
export async function addMerchantVariant(pool: Pool, businessId: string, productId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO product_variants (business_id, id, product_id, sku) VALUES ($1, $2, $3, $4)`, [
    businessId,
    id,
    productId,
    `SKU-${id.slice(0, 12)}`,
  ]);
  return id;
}

/**
 * Configure a product as the inventory principal would, under scope
 * (`inventory-db-authority.test.ts:446-452`): the tracking columns, and the
 * base variant when asked. Returns the base variant id, or null.
 */
export async function configureRaw(
  pool: Pool,
  s: { tenantId: string; businessId: string },
  productId: string,
  unit: string,
  decimals: number,
  withBase: boolean,
): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setScope(c, s);
    await c.query(`SET LOCAL ROLE ${INTERNAL}`);
    await c.query(`UPDATE products SET track_inventory = true, unit_code = $2, unit_decimals = $3 WHERE business_id = $4 AND id = $1`, [
      productId,
      unit,
      decimals,
      s.businessId,
    ]);
    let base: string | null = null;
    if (withBase) {
      base = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [s.businessId, base, productId]);
    }
    await c.query('COMMIT');
    return base;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A tracked variant product: `count` merchant variants and no base variant. */
export async function addVariantProduct(
  pool: Pool,
  s: { tenantId: string; businessId: string },
  count = 2,
): Promise<{ productId: string; variantIds: string[] }> {
  const productId = await createProduct(pool, s.businessId);
  const variantIds: string[] = [];
  for (let i = 0; i < count; i += 1) variantIds.push(await addMerchantVariant(pool, s.businessId, productId));
  await configureRaw(pool, s, productId, 'piece', 0, false);
  return { productId, variantIds };
}

export async function addTrackedProduct(pool: Pool, s: { tenantId: string; businessId: string }, unit = 'piece', decimals = 0): Promise<ProductRef> {
  const productId = await createProduct(pool, s.businessId);
  const variantId = must(await configureRaw(pool, s, productId, unit, decimals, true), 'base variant');
  return { productId, variantId };
}

async function seedOne(pool: Pool, slug: string, label: string): Promise<Scope & { branchId: string; warehouseId: string }> {
  const tenantId = await one(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const businessId = await one(
    pool,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantId, `Stock ${label}`, `stock-${slug}-${label}-${randomUUID().slice(0, 8)}`],
  );
  const userId = await one(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Stock actor') RETURNING id`, [
    `stock-${slug}-${label}-${randomUUID().slice(0, 8)}@test.daftar.local`,
  ]);
  const branchId = await one(pool, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
  const warehouseId = await one(pool, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
    businessId,
    branchId,
  ]);
  return { tenantId, businessId, userId, branchId, warehouseId };
}

/** §5 seeding: a business with two warehouses and every product shape S2 needs, plus a second tenant/business. */
export async function seedStockBusiness(pool: Pool, slug: string): Promise<StockBusiness> {
  const a = await seedOne(pool, slug, 'a');
  const warehouse2 = await addWarehouse(pool, a.businessId, a.branchId, 'Second WH');
  const otherUserId = await one(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Other actor') RETURNING id`, [
    `stock-${slug}-other-${randomUUID().slice(0, 8)}@test.daftar.local`,
  ]);

  const piece = await addTrackedProduct(pool, a, 'piece', 0);
  const dec2 = await addTrackedProduct(pool, a, 'metre', 2);
  const dec4 = await addTrackedProduct(pool, a, 'kg', 4);

  const untrackedId = await createProduct(pool, a.businessId);
  const untrackedVariant = await addMerchantVariant(pool, a.businessId, untrackedId);

  const vpId = await createProduct(pool, a.businessId);
  const v1 = await addMerchantVariant(pool, a.businessId, vpId);
  const v2 = await addMerchantVariant(pool, a.businessId, vpId);
  await configureRaw(pool, a, vpId, 'piece', 0, false);

  const mixed = await addTrackedProduct(pool, a, 'piece', 0);
  const mixedMerchant = await addMerchantVariant(pool, a.businessId, mixed.productId);

  const b = await seedOne(pool, slug, 'b');
  const bPiece = await addTrackedProduct(pool, b, 'piece', 0);

  return {
    tenantId: a.tenantId,
    businessId: a.businessId,
    userId: a.userId,
    otherUserId,
    branchId: a.branchId,
    warehouse1: a.warehouseId,
    warehouse2,
    piece,
    dec2,
    dec4,
    untracked: { productId: untrackedId, variantId: untrackedVariant },
    variantProduct: { productId: vpId, variantIds: [v1, v2] },
    mixed: { productId: mixed.productId, baseVariantId: mixed.variantId, merchantVariantId: mixedMerchant },
    other: { tenantId: b.tenantId, businessId: b.businessId, userId: b.userId, branchId: b.branchId, warehouseId: b.warehouseId, piece: bPiece },
  };
}

// ── the S1 configuration command, through its real boundary ───────────────

export interface ConfigureCall {
  productId: string;
  track: boolean;
  unitCode: string | null;
  unitDecimals: number | null;
}

/** `inventory_configure_product` as `daftar_app`, carrying an assertion minted by the S1 minter, in the caller's transaction. */
export async function configureAsApp(
  c: Queryable,
  s: Scope,
  call: ConfigureCall,
): Promise<{ unit_code: string | null; unit_decimals: number | null; track_inventory: boolean }> {
  const payload = configureProductPayload({
    tenantId: s.tenantId,
    businessId: s.businessId,
    productId: call.productId,
    trackInventory: call.track,
    unitCode: call.unitCode,
    unitDecimals: call.unitDecimals,
  });
  const assertion = mintTestInventoryAssertion({
    actorUserId: s.userId,
    tenantId: s.tenantId,
    businessId: s.businessId,
    opCode: 'inventory.configure_product',
    payloadSha256: payload.sha256,
  });
  await setScope(c, s);
  await c.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [assertion]);
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<{ unit_code: string | null; unit_decimals: number | null; track_inventory: boolean }>(
    `SELECT unit_code, unit_decimals, track_inventory FROM inventory_configure_product($1::uuid, $2, $3, $4::smallint)`,
    [call.productId, call.track, call.unitCode, call.unitDecimals],
  );
  await c.query('RESET ROLE');
  return must(r.rows[0], 'configure row');
}

export function tryConfigure(
  c: Queryable,
  s: Scope,
  call: ConfigureCall,
): Promise<Outcome<{ unit_code: string | null; unit_decimals: number | null; track_inventory: boolean }>> {
  return attempt(c, () => configureAsApp(c, s, call));
}
