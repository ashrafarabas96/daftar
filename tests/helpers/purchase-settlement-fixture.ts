/**
 * P3-S5 — THE SETTLEMENT FIXTURE (docs/PHASE_3_S5_CONTRACT.md §5, A-16, TL-9;
 * the L:470 precedent: a test fixture, never a production failpoint).
 *
 * S5 has no supplier payment or supplier credit allocation: the two INVOKER
 * read functions `purchase_ap_outstanding` and `purchase_settlement_state` are
 * the S6 extension points. The paths that depend on them — A-09(a)/(b) and
 * the A-10 1150 branch — are proven here by an OWNER-installed replacement of
 * the two functions inside the TEST database only:
 *
 *  1. the current definitions are saved (`pg_get_functiondef`, the `prosrc`
 *     SHA-256, owner, ACL, security, volatility and pinned path);
 *  2. each original is kept, verbatim, as a `test_s5_*` copy, and the entry
 *     point is `CREATE OR REPLACE`d with a fixture body driven by the
 *     test-only table `test_settlement_fixture(business_id, purchase_id,
 *     outstanding_txn, payment_allocated, credit_allocated)` — with no fixture
 *     row the S5 answer is returned unchanged;
 *  3. `restore()` re-creates the saved definitions, drops the copies and the
 *     table, and asserts every saved property — the `prosrc` SHA-256 first —
 *     equals its pre-install value.
 *
 * `outstanding_txn` is the purchase's outstanding AP BEFORE its returns, as
 * S6 would compute it after its allocations (T − allocated): the fixture body
 * answers `max(0, S5 answer − (T − outstanding_txn))`, so a return that takes
 * AP lowers the next answer exactly as the S6 body will.
 *
 * Both replacements stay SECURITY INVOKER, STABLE and pinned, and the table
 * carries `GRANT SELECT` to `daftar_app` and `daftar_inventory_internal` for
 * the fixture's life. A committed install is used by one file at a time; the
 * saved definitions are also kept in `test_settlement_fixture_saved`, so a
 * run that died before its `restore()` is repaired by the next install.
 */
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { must, type Queryable } from './inventory-commands';

/** The two S6 extension points (A-16). */
export const SETTLEMENT_FUNCTIONS = ['purchase_ap_outstanding(uuid,uuid)', 'purchase_settlement_state(uuid,uuid)'] as const;

type SettlementFunction = (typeof SETTLEMENT_FUNCTIONS)[number];

/** The catalogue facts the fixture must leave exactly as it found them. */
export interface FunctionFacts {
  readonly signature: SettlementFunction;
  readonly def: string;
  readonly prosrcSha256: string;
  readonly owner: string;
  readonly acl: string | null;
  readonly securityDefiner: boolean;
  readonly volatility: string;
  readonly config: string | null;
}

const COPY_OF: Readonly<Record<SettlementFunction, { readonly name: string; readonly copy: string }>> = {
  'purchase_ap_outstanding(uuid,uuid)': { name: 'purchase_ap_outstanding', copy: 'test_s5_purchase_ap_outstanding' },
  'purchase_settlement_state(uuid,uuid)': { name: 'purchase_settlement_state', copy: 'test_s5_purchase_settlement_state' },
};

/** The saved and live facts of one function, as the owner reads the catalogue. */
export async function functionFacts(q: Queryable, signature: SettlementFunction): Promise<FunctionFacts> {
  const r = must(
    (
      await q.query<{ def: string; src: string; owner: string; acl: string | null; secdef: boolean; vol: string; config: string | null }>(
        `SELECT pg_get_functiondef(p.oid) AS def, p.prosrc AS src, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
                p.prosecdef AS secdef, p.provolatile::text AS vol, array_to_string(p.proconfig, ',') AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [signature],
      )
    ).rows[0],
    signature,
  );
  return {
    signature,
    def: r.def,
    prosrcSha256: createHash('sha256').update(r.src, 'utf8').digest('hex'),
    owner: r.owner,
    acl: r.acl,
    securityDefiner: r.secdef,
    volatility: r.vol,
    config: r.config,
  };
}

/** The saved definition re-targeted at its `test_s5_*` copy (the S5 body, verbatim). */
function copyDefinition(f: FunctionFacts): string {
  const { name, copy } = COPY_OF[f.signature];
  const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
  if (!f.def.startsWith(head)) throw new Error(`settlement fixture: unexpected definition head of ${f.signature}`);
  return `CREATE FUNCTION public.${copy}(${f.def.slice(head.length)}`;
}

const FIXTURE_AP_OUTSTANDING = `
CREATE OR REPLACE FUNCTION public.purchase_ap_outstanding(p_business_id uuid, p_purchase_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fixture$
DECLARE
  v_s5    BIGINT;
  v_total BIGINT;
  v_fix   BIGINT;
BEGIN
  -- The S5 answer first: purchase.not_found for an invisible purchase, 0 when not received or reversed.
  v_s5 := test_s5_purchase_ap_outstanding(p_business_id, p_purchase_id);
  SELECT f.outstanding_txn INTO v_fix FROM test_settlement_fixture f
   WHERE f.business_id = p_business_id AND f.purchase_id = p_purchase_id;
  IF v_fix IS NULL THEN
    RETURN v_s5;
  END IF;
  SELECT p.total_txn_minor INTO v_total FROM purchases p WHERE p.business_id = p_business_id AND p.id = p_purchase_id;
  -- As S6 will: the S5 answer less what the fixture says is allocated (T - outstanding), never below zero.
  RETURN GREATEST(v_s5 - (v_total - v_fix), 0);
END;
$fixture$`;

const FIXTURE_SETTLEMENT_STATE = `
CREATE OR REPLACE FUNCTION public.purchase_settlement_state(p_business_id uuid, p_purchase_id uuid,
                                                            OUT payment_allocated boolean, OUT credit_allocated boolean)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fixture$
BEGIN
  SELECT s.payment_allocated, s.credit_allocated INTO payment_allocated, credit_allocated
    FROM test_s5_purchase_settlement_state(p_business_id, p_purchase_id) AS s;
  SELECT payment_allocated OR coalesce(f.payment_allocated, false), credit_allocated OR coalesce(f.credit_allocated, false)
    INTO payment_allocated, credit_allocated
    FROM test_settlement_fixture f WHERE f.business_id = p_business_id AND f.purchase_id = p_purchase_id;
  IF NOT FOUND THEN
    SELECT s.payment_allocated, s.credit_allocated INTO payment_allocated, credit_allocated
      FROM test_s5_purchase_settlement_state(p_business_id, p_purchase_id) AS s;
  END IF;
END;
$fixture$`;

export interface SettlementState {
  /** The outstanding AP before returns (T − allocated); null keeps the S5 answer. */
  readonly outstandingTxn?: bigint | null;
  readonly paymentAllocated?: boolean;
  readonly creditAllocated?: boolean;
}

export interface SettlementFixture {
  /** The facts saved before the install. */
  readonly saved: readonly FunctionFacts[];
  /** Set (upsert) the fixture state of one purchase. */
  set(businessId: string, purchaseId: string, state: SettlementState): Promise<void>;
  /** Remove the fixture state of one purchase (the S5 answer again). */
  clear(businessId: string, purchaseId: string): Promise<void>;
  /** Restore the saved definitions, drop the copies and the tables, and assert the catalogue is as found. */
  restore(): Promise<void>;
}

/** Undo an install whose `restore()` never ran (a dead run), from the saved definitions it left. */
async function repairAbandoned(q: Queryable): Promise<void> {
  const left = await q.query<{ t: string | null }>(`SELECT to_regclass('public.test_settlement_fixture_saved')::text AS t`);
  if (must(left.rows[0]).t === null) return;
  const saved = await q.query<{ signature: string; def: string }>(`SELECT signature, def FROM test_settlement_fixture_saved ORDER BY signature`);
  for (const s of saved.rows) await q.query(s.def);
  await dropScaffolding(q);
}

async function dropScaffolding(q: Queryable): Promise<void> {
  await q.query(`DROP FUNCTION IF EXISTS public.test_s5_purchase_ap_outstanding(uuid, uuid)`);
  await q.query(`DROP FUNCTION IF EXISTS public.test_s5_purchase_settlement_state(uuid, uuid)`);
  await q.query(`DROP TABLE IF EXISTS public.test_settlement_fixture`);
  await q.query(`DROP TABLE IF EXISTS public.test_settlement_fixture_saved`);
}

/**
 * Install the fixture as the schema owner on `q`: a client inside a
 * transaction (a rolled-back test — the install dies with it) or a pool /
 * autocommit client (a committed install for two-connection tests, removed
 * by `restore()`).
 */
export async function installSettlementFixture(q: Queryable): Promise<SettlementFixture> {
  await repairAbandoned(q);
  const saved: FunctionFacts[] = [];
  for (const s of SETTLEMENT_FUNCTIONS) saved.push(await functionFacts(q, s));
  for (const f of saved) {
    expect(f.securityDefiner, `${f.signature} is SECURITY INVOKER before the install`).toBe(false);
  }
  await q.query(`CREATE TABLE public.test_settlement_fixture_saved (signature text PRIMARY KEY, def text NOT NULL)`);
  for (const f of saved) await q.query(`INSERT INTO public.test_settlement_fixture_saved (signature, def) VALUES ($1, $2)`, [f.signature, f.def]);
  await q.query(
    `CREATE TABLE public.test_settlement_fixture (
       business_id uuid NOT NULL,
       purchase_id uuid NOT NULL,
       outstanding_txn bigint,
       payment_allocated boolean NOT NULL DEFAULT false,
       credit_allocated boolean NOT NULL DEFAULT false,
       PRIMARY KEY (business_id, purchase_id))`,
  );
  await q.query(`GRANT SELECT ON public.test_settlement_fixture TO daftar_app, daftar_inventory_internal`);
  for (const f of saved) {
    const { copy } = COPY_OF[f.signature];
    await q.query(copyDefinition(f));
    await q.query(`REVOKE ALL ON FUNCTION public.${copy}(uuid, uuid) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION public.${copy}(uuid, uuid) TO daftar_app, daftar_inventory_internal`);
  }
  await q.query(FIXTURE_AP_OUTSTANDING);
  await q.query(FIXTURE_SETTLEMENT_STATE);
  // The replacements keep every catalogue property but the body.
  for (const f of saved) {
    const now = await functionFacts(q, f.signature);
    expect({ ...now, def: '', prosrcSha256: '' }, `${f.signature}: the replacement keeps owner, ACL, INVOKER, STABLE and the pinned path`).toEqual({
      ...f,
      def: '',
      prosrcSha256: '',
    });
    expect(now.prosrcSha256, `${f.signature}: the fixture body is installed`).not.toBe(f.prosrcSha256);
  }

  return {
    saved,
    async set(businessId, purchaseId, state) {
      await q.query(
        `INSERT INTO public.test_settlement_fixture (business_id, purchase_id, outstanding_txn, payment_allocated, credit_allocated)
         VALUES ($1, $2, $3::bigint, $4, $5)
         ON CONFLICT (business_id, purchase_id) DO UPDATE
            SET outstanding_txn = EXCLUDED.outstanding_txn, payment_allocated = EXCLUDED.payment_allocated, credit_allocated = EXCLUDED.credit_allocated`,
        [
          businessId,
          purchaseId,
          state.outstandingTxn === undefined || state.outstandingTxn === null ? null : state.outstandingTxn.toString(10),
          state.paymentAllocated ?? false,
          state.creditAllocated ?? false,
        ],
      );
    },
    async clear(businessId, purchaseId) {
      await q.query(`DELETE FROM public.test_settlement_fixture WHERE business_id = $1 AND purchase_id = $2`, [businessId, purchaseId]);
    },
    async restore() {
      for (const f of saved) await q.query(f.def);
      await dropScaffolding(q);
      for (const f of saved) {
        const now = await functionFacts(q, f.signature);
        expect(now.prosrcSha256, `${f.signature}: the restored prosrc SHA-256 equals the pre-install value`).toBe(f.prosrcSha256);
        expect(now, `${f.signature}: every catalogue property restored`).toEqual(f);
      }
    },
  };
}
