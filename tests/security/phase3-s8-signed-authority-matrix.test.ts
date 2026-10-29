/**
 * P3-S8 T-01 — THE SIGNED-AUTHORITY MATRIX, EVERY REGISTERED KIND
 * (docs/PHASE_3_S8_CONTRACT.md A-06; PM-44, PM-45, PM-46).
 *
 * Driven by the registry: `OP_KIND_BUILDERS` must hold exactly the kinds a
 * PHASE 3 registrant registered (`phase3RegisteredOpKinds()`, the registry's
 * own `registered_by` column, which `0074` widened so a later phase can
 * register one), so a Phase 3 kind registered without a builder — or a
 * builder for a Phase 3 kind nobody registered — fails the first case. The
 * whole registry is still accounted for: the first case also asserts that the
 * Phase 3 scope and its complement partition it and that every kind outside
 * the scope records a well-formed later-phase registrant (P4-AL-88).
 *
 * For every kind, in its own business, the honest command is prepared through
 * the real commands and committed; then rows a–l present it to the entry
 * routine as `daftar_app` (row l: as every other runtime principal):
 *   a no carrier · b malformed · c unknown kid · d a MAC by a random key ·
 *   e expired, and a lifetime over the ceiling · f minted for each of the
 *   other 25 kinds · g each signed field altered · h the claims of another
 *   business, and a scope that is not the claim · i replayed in the same
 *   transaction and after a commit · j a rolled-back first use re-presented
 *   (accepted exactly once) · k the same claims MAC'd with the accounting and
 *   the provisioning keys; for a financial kind the two carriers crossed ·
 *   l a direct call by every other runtime principal.
 * Every refused row is judged inside the transaction: the refusal's
 * savepoint is rolled back and the ordered-row digest of every truth table,
 * the assertion-uses log and the journal is compared with the one before.
 *
 * NEGATIVE CONTROL: in a scratch database `inventory_assertion_consume` and
 * `inventory_assertion_current` are replaced, as the superuser, by stubs that
 * verify nothing. Rows a–i then SUCCEED for one kind of every registering
 * slice (the exceptions are named in `DOMAIN_REFUSALS`: the routine's own
 * CHECK, not a verifier): the matrix measures the verifier, not the happy path.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
  PROVISIONING_ASSERTION_KEY_B64,
  ensurePostgres,
  ownerPool,
  resetData,
} from '../helpers/test-app';
import { attempt, must, ownerClient, seedS3Business, seedS3World, type Outcome, type Queryable, type S3Business } from '../helpers/inventory-commands';
import { expectAccepted, expectRefused } from '../helpers/stock-ledger';
import { sourceAssertion } from '../helpers/accounting-posting';
import { OP_KIND_BUILDERS, mintHonest, type Biz, type OpKindBuilder, type PreparedKind, type ResultRow } from '../helpers/op-kind-builders';
import { PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';
import { PREFIX_DB, opKindRegistrants, phase3RegisteredOpKinds, prefixCatalogue, runtimePrincipals, truthTables } from '../helpers/phase3-surface';
import { P3C_OPERATION_KINDS } from '../helpers/p3c-migrations';
import { JOURNAL_AND_LOGS, changedTables, tableDigest, type TableDigest } from '../helpers/table-digest';
import { createScratchDb, scratchPool, urlOf, type ScratchDb } from '../helpers/scratch-db';

const P = 'P0001';
const KINDS = Object.keys(OP_KIND_BUILDERS).sort();
const builderOf = (op: string): OpKindBuilder => must(OP_KIND_BUILDERS[op], `builder of ${op}`);

// ── the call ───────────────────────────────────────────────────────────────

interface Presented {
  readonly carrier: string | null;
  readonly scope: Biz;
  readonly role?: string;
}

/** Present one call in the caller's transaction, inside a savepoint (a refusal leaves the transaction usable). */
function present(c: Queryable, p: PreparedKind, x: Presented): Promise<Outcome<ResultRow[]>> {
  return attempt(c, async () => {
    await c.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
              set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
      [x.scope.tenantId, x.scope.businessId, x.carrier ?? '', p.trace],
    );
    await c.query(`SET LOCAL ROLE ${x.role ?? 'daftar_app'}`);
    const r = await c.query<ResultRow>(p.sql, [...p.params]);
    await c.query('RESET ROLE');
    return r.rows;
  });
}

/** The composed command: the entry call, then its entries, in one savepoint. */
function composed(c: Queryable, p: PreparedKind, x: Presented, accountingCarrier?: string): Promise<Outcome<number>> {
  return attempt(c, async () => {
    const o = await present(c, p, x);
    if (!o.ok) throw new Error(`${o.sqlstate} ${o.message}`);
    return p.post(c, o.value, accountingCarrier);
  });
}

// ── carriers ───────────────────────────────────────────────────────────────

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function nine(biz: Biz & { readonly userId: string }, op: string, sha: string, exp: number, kid = INVENTORY_ASSERTION_KID): string[] {
  return ['invctl1', kid, biz.userId, biz.tenantId, biz.businessId, op.replace(/\./g, ':'), sha, String(exp), randomUUID()];
}

/** Sign nine components over the `invctl/1` preimage with `secret` — for what the minter refuses to produce. */
function handSigned(components: readonly string[], secret: Buffer): string {
  const mac = createHmac('sha256', secret)
    .update(`invctl/1\n${components.join('.')}`, 'utf8')
    .digest('hex');
  return [...components, mac].join('.');
}

const INVENTORY_KEY = Buffer.from(INVENTORY_ASSERTION_KEY_B64, 'base64');
const ACCOUNTING_KEY = Buffer.from(ACCOUNTING_ASSERTION_KEY_B64, 'base64');
const PROVISIONING_KEY = Buffer.from(PROVISIONING_ASSERTION_KEY_B64, 'base64');

/** A genuine accounting assertion for `sourceType` in `biz` (claims that cannot name the kind's source — only its shape matters). */
function accountingCarrierOf(biz: Biz & { readonly userId: string }, sourceType: string): string {
  return sourceAssertion({
    actorUserId: biz.userId,
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    operationKind: sourceType === 'reversal' ? 'reverse' : 'post',
    sourceType,
    sourceId: randomUUID(),
    postingFingerprint: randomBytes(32).toString('hex'),
  });
}

// ── the world ──────────────────────────────────────────────────────────────

interface KindState {
  readonly biz: S3Business;
  readonly prepared: PreparedKind;
}

let A: S3Business;
let A2: S3Business;
let B: S3Business;
let tables: string[];
let principals: string[];

async function cashOf(q: Queryable, businessId: string): Promise<string> {
  const r = await q.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId]);
  return must(r.rows[0], 'cash account').id;
}

/** A fresh business of tenant A for `op`, and its honest command prepared and COMMITTED through the real commands. */
async function prepareKind(pool: Pool, open: () => Promise<Client>, op: string, label: string, other: S3Business, owner: S3Business): Promise<KindState> {
  const biz = await seedS3Business(pool, owner.tenantId, owner.userId, label);
  const c = await open();
  try {
    await c.query('BEGIN');
    const prepared = await builderOf(op).prepare(c, { biz, other, cashAccountId: await cashOf(c, biz.businessId) });
    await c.query('COMMIT');
    return { biz, prepared };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** One transaction on a fresh superuser connection; ROLLBACK unless told to commit. */
async function inTx<T>(fn: (c: Client) => Promise<T>, commit = false): Promise<T> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** Every refused row: named refusal, and the digest (whole tables) unchanged after the savepoint rolled back. */
async function refusedIdentical(c: Queryable, before: TableDigest, o: Outcome, code: string, why: string, sqlstate = P): Promise<void> {
  expectRefused(o, sqlstate, code, why);
  expect(changedTables(before, await tableDigest(c, tables)), `${why}: tables identical`).toEqual([]);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const w = await seedS3World(ownerPool(), 't01');
  A = w.A;
  A2 = w.A2;
  B = w.B;
  tables = [...(await truthTables()), ...JOURNAL_AND_LOGS];
  principals = await runtimePrincipals();
});

afterAll(async () => {
  await resetData();
});

// ── the registry ───────────────────────────────────────────────────────────

describe('T-01 the matrix is driven by the registry', () => {
  it('the builders are exactly the registered kinds; each builder names its consuming routine, which posts nothing; financial = the accounting source types, whose union is the eight post-0052 types plus reversal', async () => {
    // P4-AL-88. This was `KINDS toEqual registeredOpKinds()` — an exact
    // equality over a registry a later phase populates, and `0074` widened
    // `registered_by` from `^P3-S[0-9]+$` to `^P[0-9]+-S[0-9]+$` precisely so
    // that it could. It is scoped by PROVENANCE, the registry's own column and
    // the estate's existing idiom for this, and kept "and nothing more" by a
    // partition: the builders here are exactly the kinds a PHASE 3 registrant
    // registered, both ways, and every registered kind is either one of those
    // or carries a well-formed later-phase registrant.
    const phase3Kinds = await phase3RegisteredOpKinds();
    expect(KINDS, 'builders = the Phase 3 registry, both ways').toEqual(phase3Kinds);
    // Phase 3 corrective (0072): the 26 S8-head kinds plus exactly the corrective kinds.
    expect(KINDS).toHaveLength(26 + P3C_OPERATION_KINDS.length);
    const registrants = await opKindRegistrants();
    const all = Object.keys(registrants).sort();
    const beyond = all.filter((k) => !phase3Kinds.includes(k));
    expect(
      phase3Kinds.filter((k) => beyond.includes(k)),
      'the two scopes are disjoint',
    ).toEqual([]);
    expect([...phase3Kinds, ...beyond].sort(), 'and together they are the whole registry').toEqual(all);
    // Not "these exist and that is fine": a kind outside the Phase 3 scope
    // must carry a registrant of the accepted shape that is not a Phase 3 one,
    // so its provenance is recorded and reviewable.
    expect(
      beyond.filter((k) => !/^P[0-9]+-S[0-9]+$/.test(registrants[k] ?? '') || /^P3-/.test(registrants[k] ?? '')),
      'every kind beyond the Phase 3 scope records its registrant',
    ).toEqual([]);
    for (const k of P3C_OPERATION_KINDS) expect(builderOf(k).slice, `${k} is registered by the corrective pass`).toBe('P3-C');

    const r = await ownerPool().query<{ sig: string | null; src: string | null; op: string }>(
      `SELECT k.op AS op, to_regprocedure(k.routine)::text AS sig, p.prosrc AS src
         FROM unnest($1::text[], $2::text[]) AS k(op, routine)
         LEFT JOIN pg_proc p ON p.oid = to_regprocedure(k.routine)`,
      [KINDS, KINDS.map((k) => builderOf(k).routine)],
    );
    for (const row of r.rows) {
      const b = builderOf(row.op);
      expect(row.sig, `${row.op}: its routine exists`).toBe(b.routine);
      const src = must(row.src, row.op);
      expect(new RegExp(`inventory_assertion_consume\\(\\s*'${row.op.replace('.', '\\.')}'`).test(src), `${row.op}: ${b.routine} consumes it`).toBe(true);
      expect(/accounting_post_(entry|reversal)\s*\(/.test(src), `${row.op}: the routine posts nothing (seam 2)`).toBe(false);
      expect(b.financial, `${row.op}: financial iff it has accounting source types`).toBe(b.accountingSourceTypes.length > 0);
    }

    await prefixCatalogue();
    const prefix = scratchPool(urlOf(PREFIX_DB), 1);
    try {
      const types = async (q: Queryable): Promise<string[]> =>
        (await q.query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types ORDER BY 1`)).rows.map((x) => x.t);
      const before = new Set(await types(prefix));
      // P4-AL-88. `added` was the difference between the 0052 prefix and the
      // WHOLE tree, so "eight after 0052 plus the corrective one" was a claim
      // about every phase that FOLLOWS Phase 3: `0077` registers `sale` and
      // `invoice`, and an accepted Phase 3 matrix went red for a reason that
      // has nothing to do with the signed-authority surface. `accounting_
      // source_types` carries no provenance column, so the scope cannot be
      // `registered_by ~ '^P3-'`; it is the ACCEPTED PHASE 3 HEAD instead,
      // frozen byte for byte by P4-AL-85 so no later phase can enter it. The
      // nine are still claimed EXACTLY, word for word, and the types a later
      // phase registers are claimed separately and positively just below.
      const phase3Head = await createScratchDb('daftar_p3s8_phase3_head', { upTo: PHASE4_INHERITED_PREFIX_END, keys: false });
      let atPhase3Head: string[];
      try {
        atPhase3Head = await types(phase3Head.pool);
      } finally {
        await phase3Head.drop();
      }
      const added = atPhase3Head.filter((t) => !before.has(t));
      // Phase 3 corrective (0072, TD-16): plus `purchase_residue_write_off`.
      expect(added, 'eight source types registered after 0052, plus the corrective one').toHaveLength(9);
      expect(added).toContain('purchase_residue_write_off');
      const union = [...new Set(KINDS.flatMap((k) => builderOf(k).accountingSourceTypes))].sort();
      expect(union).toEqual([...added, 'reversal'].sort());
      // The later phases' half, positively, so nothing was merely dropped from
      // the claim: every source type the LIVE catalogue holds beyond the
      // accepted head is one no Phase 3 builder claims, and the two scopes
      // together are still the whole registry.
      const live = await types(ownerPool());
      const beyondHead = live.filter((t) => !atPhase3Head.includes(t));
      expect(
        beyondHead.filter((t) => union.includes(t)),
        'no source type a later phase registers is claimed by a Phase 3 builder',
      ).toEqual([]);
      expect([...atPhase3Head, ...beyondHead].sort(), 'and the two scopes together are the whole registry').toEqual([...live].sort());
    } finally {
      await prefix.end();
    }
    expect(new Set(KINDS.map((k) => builderOf(k).slice))).toEqual(new Set(['P3-S1', 'P3-S3', 'P3-S4', 'P3-S5', 'P3-S6', 'P3-C']));
  });
});

// ── rows a–l, every kind ───────────────────────────────────────────────────

describe.each(KINDS.map((op, i) => [op, i] as const))('T-01 %s', (op, i) => {
  const b = builderOf(op);
  const opCode = b.op;
  let s: KindState;

  beforeAll(async () => {
    s = await prepareKind(ownerPool(), ownerClient, op, `t01-${i}`, A2, A);
  });

  const honest = (o: { now?: Date; jti?: string } = {}): string => mintHonest(s.biz, opCode, s.prepared.sha256(s.biz), o);
  const own = (): Biz => s.biz;

  it('a–e: no carrier, malformed, unknown kid, a random key, expired or over the lifetime ceiling → refused, tables identical', async () => {
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      const sha = s.prepared.sha256(s.biz);
      const good = honest();
      const exp = nowSeconds() + 60;
      await refusedIdentical(c, before, await present(c, s.prepared, { carrier: null, scope: own() }), 'inventory.assertion_missing', 'a: no carrier');
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: good.split('.').slice(0, 9).join('.'), scope: own() }),
        'inventory.assertion_malformed',
        'b: nine components',
      );
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: [...good.split('.').slice(0, 9), 'bm90LWhleA=='].join('.'), scope: own() }),
        'inventory.assertion_malformed',
        'b: a base64 MAC',
      );
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: handSigned(nine(s.biz, opCode, sha, exp, 'no-such-kid'), INVENTORY_KEY), scope: own() }),
        'inventory.assertion_key_unknown',
        'c: unknown kid',
      );
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: handSigned(nine(s.biz, opCode, sha, exp), randomBytes(32)), scope: own() }),
        'inventory.assertion_invalid_signature',
        'd: a random 32-byte key',
      );
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: honest({ now: new Date(Date.now() - 600_000) }), scope: own() }),
        'inventory.assertion_expired',
        'e: expired',
      );
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: handSigned(nine(s.biz, opCode, sha, nowSeconds() + 3600), INVENTORY_KEY), scope: own() }),
        'inventory.assertion_ttl_exceeded',
        'e: an hour of lifetime',
      );
      expectAccepted(await present(c, s.prepared, { carrier: good, scope: own() }), 'the honest assertion');
    });
  });

  it('f: an assertion minted for each of the other kinds (25, plus the corrective ones) → assertion_wrong_operation', async () => {
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      const others = KINDS.filter((k) => k !== op);
      expect(others).toHaveLength(25 + P3C_OPERATION_KINDS.length);
      for (const other of others) {
        const carrier = mintHonest(s.biz, builderOf(other).op, s.prepared.sha256(s.biz));
        await refusedIdentical(
          c,
          before,
          await present(c, s.prepared, { carrier, scope: own() }),
          'inventory.assertion_wrong_operation',
          `f: minted for ${other}`,
        );
      }
    });
  });

  it('g: each signed field altered in turn → assertion_payload_mismatch', async () => {
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      expect(s.prepared.fields.length, 'every kind signs at least one field').toBeGreaterThan(0);
      const honestSha = s.prepared.sha256(s.biz);
      for (const f of s.prepared.fields) {
        const sha = f.sha256(s.biz);
        expect(sha, `g: ${f.field} changes the digest`).not.toBe(honestSha);
        await refusedIdentical(
          c,
          before,
          await present(c, s.prepared, { carrier: mintHonest(s.biz, opCode, sha), scope: own() }),
          'inventory.assertion_payload_mismatch',
          `g: ${f.field}`,
        );
      }
    });
  });

  it('h: the claims of another business (same tenant, other tenant), or a scope that is not the claim → assertion_scope_mismatch', async () => {
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      for (const [name, claimed] of [
        ['A2 (same tenant, same owner)', A2],
        ['B (another tenant)', B],
      ] as const) {
        const carrier = mintHonest({ ...claimed, userId: s.biz.userId }, opCode, s.prepared.sha256(claimed));
        await refusedIdentical(c, before, await present(c, s.prepared, { carrier, scope: own() }), 'inventory.assertion_scope_mismatch', `h: claims ${name}`);
        await refusedIdentical(
          c,
          before,
          await present(c, s.prepared, { carrier: honest(), scope: claimed }),
          'inventory.assertion_scope_mismatch',
          `h: scope ${name}`,
        );
      }
    });
  });

  it('k (PM-46): the same claims MAC’d with the accounting or the provisioning key under the inventory kid → invalid_signature; a financial kind’s carriers never cross', async () => {
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      const claims = nine(s.biz, opCode, s.prepared.sha256(s.biz), nowSeconds() + 60);
      for (const [name, key] of [
        ['accounting', ACCOUNTING_KEY],
        ['provisioning', PROVISIONING_KEY],
      ] as const) {
        expect(key.equals(INVENTORY_KEY), `${name} key ≠ inventory key`).toBe(false);
        await refusedIdentical(
          c,
          before,
          await present(c, s.prepared, { carrier: handSigned(claims, key), scope: own() }),
          'inventory.assertion_invalid_signature',
          `k: the ${name} key`,
        );
      }
      expect(handSigned(claims, INVENTORY_KEY).split('.').length, 'the same claims under the inventory key are a well-formed carrier').toBe(10);
      if (!b.financial) return;
      for (const sourceType of b.accountingSourceTypes) {
        await refusedIdentical(
          c,
          before,
          await present(c, s.prepared, { carrier: accountingCarrierOf(s.biz, sourceType), scope: own() }),
          'inventory.assertion_malformed',
          `k: a ${sourceType} accounting assertion in app.inventory_assertion`,
        );
      }
      const invctl = honest();
      const crossed = await composed(c, s.prepared, { carrier: invctl, scope: own() }, invctl);
      expectRefused(crossed, P, 'accounting.assertion_malformed', 'k: an invctl/1 string in app.accounting_assertion');
      expect(changedTables(before, await tableDigest(c, tables)), 'k: the crossed composed command left nothing').toEqual([]);
    });
  });

  it('l (PM-44): a direct call by every runtime principal other than daftar_app → 42501; none of them, nor PUBLIC, holds EXECUTE', async () => {
    const others = principals.filter((p) => p !== 'daftar_app');
    expect(others.length).toBe(principals.length - 1);
    const r = await ownerPool().query<{ g: string; ok: boolean }>(
      `SELECT g, has_function_privilege(g, $2::regprocedure, 'EXECUTE') AS ok FROM unnest($1::text[]) AS g ORDER BY g`,
      [[...others, 'public', 'daftar_app'], b.routine],
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.g, x.ok]))).toEqual(
      Object.fromEntries([...others, 'public', 'daftar_app'].map((g) => [g, g === 'daftar_app'])),
    );
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      for (const role of others) {
        await refusedIdentical(c, before, await present(c, s.prepared, { carrier: honest(), scope: own(), role }), '', `l: as ${role}`, '42501');
      }
    });
  });

  it('i, j: replayed in the same transaction, and after a commit → assertion_replayed; a rolled-back first use re-presented → accepted exactly once', async () => {
    await inTx(async (c) => {
      const once = honest();
      expectAccepted(await composed(c, s.prepared, { carrier: once, scope: own() }), 'i: the first use');
      const before = await tableDigest(c, tables);
      await refusedIdentical(
        c,
        before,
        await present(c, s.prepared, { carrier: once, scope: own() }),
        'inventory.assertion_replayed',
        'i: in the same transaction',
      );
    });
    const jti = randomUUID();
    const carrier = honest({ jti });
    await inTx(async (c) => {
      expectAccepted(await composed(c, s.prepared, { carrier, scope: own() }), 'j: a first use, rolled back');
    });
    const posted = await inTx(async (c) => expectAccepted(await composed(c, s.prepared, { carrier, scope: own() }), 'j: re-presented within the TTL'), true);
    expect(posted > 0, `${op}: a financial composed command posts`).toBe(b.financial);
    const uses = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_assertion_uses WHERE jti = $1`, [jti]);
    expect(must(uses.rows[0]).n, 'j: consumed exactly once').toBe(1);
    await inTx(async (c) => {
      const before = await tableDigest(c, tables);
      await refusedIdentical(c, before, await present(c, s.prepared, { carrier, scope: own() }), 'inventory.assertion_replayed', 'i: after the commit');
    });
  });
});

// ── the negative control ───────────────────────────────────────────────────

/** Verifiers that verify nothing: the actor from the carrier when it has one, the scope from the session, a fresh jti. */
const STUBS = `
CREATE OR REPLACE FUNCTION inventory_assertion_consume(p_op_code TEXT, p_payload_sha256 TEXT) RETURNS inventory_verified_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $stub$
DECLARE
  v_parts TEXT[] := string_to_array(coalesce(current_setting('app.inventory_assertion', true), ''), '.');
  v_out   inventory_verified_actor;
BEGIN
  PERFORM set_config('app.t01_stub_op', p_op_code, true);
  v_out.actor_user_id := CASE WHEN v_parts[3] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_parts[3]::uuid
                              ELSE current_setting('app.t01_stub_actor')::uuid END;
  v_out.tenant_id     := current_setting('app.tenant_id')::uuid;
  v_out.business_id   := current_setting('app.business_id')::uuid;
  v_out.op_code       := p_op_code;
  v_out.jti           := gen_random_uuid();
  RETURN v_out;
END;
$stub$;
CREATE OR REPLACE FUNCTION inventory_assertion_current(p_allowed_op_codes TEXT[]) RETURNS inventory_verified_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $stub$
DECLARE
  v_parts TEXT[] := string_to_array(coalesce(current_setting('app.inventory_assertion', true), ''), '.');
  v_out   inventory_verified_actor;
BEGIN
  v_out.actor_user_id := CASE WHEN v_parts[3] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_parts[3]::uuid
                              ELSE current_setting('app.t01_stub_actor')::uuid END;
  v_out.tenant_id     := current_setting('app.tenant_id')::uuid;
  v_out.business_id   := current_setting('app.business_id')::uuid;
  v_out.op_code       := coalesce(nullif(current_setting('app.t01_stub_op', true), ''), p_allowed_op_codes[1]);
  v_out.jti           := gen_random_uuid();
  RETURN v_out;
END;
$stub$;
`;

/** One kind of every registering slice (Phase 3 corrective: plus the write-off). */
const CONTROL_KINDS = [
  'inventory.configure_product',
  'inventory.stocktake_open',
  'supplier.create',
  'purchase.reverse',
  'payment.create_method',
  'purchase.write_off_residue',
] as const;

/**
 * The rows the stub cannot carry past the routine: `supplier_create` and
 * `payment_method_create` store the carrier's payload digest (component 7) as
 * their creation intent, and an absent carrier has none — their own CHECK
 * refuses (23514). That is the domain, not the verifier; every other row of
 * every control kind commits.
 */
const DOMAIN_REFUSALS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'supplier.create': { 'a: no carrier': '23514' },
  'payment.create_method': { 'a: no carrier': '23514' },
};

describe('T-01 NEGATIVE CONTROL — the verifier stubbed, rows a–i succeed', () => {
  let db: ScratchDb;
  let w: { A: S3Business; A2: S3Business; B: S3Business };
  const open = async (): Promise<Client> => {
    const c = new Client({ connectionString: db.url() });
    await c.connect();
    return c;
  };

  beforeAll(async () => {
    db = await createScratchDb('daftar_p3s8_t01_nc');
    await db.pool.query(STUBS);
    const owner = await db.pool.query<{ o: string }>(
      `SELECT DISTINCT pg_get_userbyid(proowner)::text AS o FROM pg_proc WHERE proname IN ('inventory_assertion_consume', 'inventory_assertion_current')`,
    );
    expect(
      owner.rows.map((x) => x.o),
      'replaced in place: the owner is unchanged',
    ).toEqual(['daftar_inventory_internal']);
    w = await seedS3World(db.pool, 't01nc');
  });

  afterAll(async () => {
    await db.drop();
  });

  it.each(CONTROL_KINDS.map((k) => [k]))('PM-44 %s: rows a–i are accepted once the verifier verifies nothing', async (op) => {
    expect(KINDS).toContain(op);
    const b = builderOf(op);
    const s = await prepareKind(db.pool, open, op, `t01nc-${CONTROL_KINDS.indexOf(op)}`, w.A2, w.A);
    const opCode = b.op;
    const sha = s.prepared.sha256(s.biz);
    const exp = nowSeconds() + 60;
    const other = must(KINDS.find((k) => k !== op));
    const field = must(s.prepared.fields[0], 'a signed field');
    const rows: readonly [string, string | null][] = [
      ['a: no carrier', null],
      ['b: nine components', mintHonest(s.biz, opCode, sha).split('.').slice(0, 9).join('.')],
      ['c: unknown kid', handSigned(nine(s.biz, opCode, sha, exp, 'no-such-kid'), INVENTORY_KEY)],
      ['d: a random key', handSigned(nine(s.biz, opCode, sha, exp), randomBytes(32))],
      ['e: expired', mintHonest(s.biz, opCode, sha, { now: new Date(Date.now() - 600_000) })],
      ['e: an hour of lifetime', handSigned(nine(s.biz, opCode, sha, nowSeconds() + 3600), INVENTORY_KEY)],
      ['f: minted for another kind', mintHonest(s.biz, builderOf(other).op, sha)],
      [`g: ${field.field} altered`, mintHonest(s.biz, opCode, field.sha256(s.biz))],
      ['h: the claims of A2', mintHonest({ ...w.A2, userId: s.biz.userId }, opCode, s.prepared.sha256(w.A2))],
    ];
    const c = await open();
    try {
      for (const [why, carrier] of rows) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.t01_stub_actor', $1, true)`, [s.biz.userId]);
        const before = await tableDigest(c, tables);
        const o = await present(c, s.prepared, { carrier, scope: s.biz });
        const domain = DOMAIN_REFUSALS[op]?.[why];
        if (domain === undefined) {
          expectAccepted(o, `NC ${op} ${why}`);
          expect(changedTables(before, await tableDigest(c, tables)).length, `NC ${op} ${why}: the attack wrote`).toBeGreaterThan(0);
        } else {
          // Past the stubbed verifier; what stops it now is the routine's own constraint, never an assertion refusal.
          expectRefused(o, domain, '', `NC ${op} ${why}`);
        }
        await c.query('ROLLBACK');
      }
      const once = mintHonest(s.biz, opCode, sha);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.t01_stub_actor', $1, true)`, [s.biz.userId]);
      expectAccepted(await composed(c, s.prepared, { carrier: once, scope: s.biz }), `NC ${op} i: first use`);
      expectAccepted(await present(c, s.prepared, { carrier: once, scope: s.biz }), `NC ${op} i: replay in the same transaction`);
      await c.query('COMMIT');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.t01_stub_actor', $1, true)`, [s.biz.userId]);
      expectAccepted(await present(c, s.prepared, { carrier: once, scope: s.biz }), `NC ${op} i: replay after the commit`);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
