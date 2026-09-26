import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountingPostingTransaction, PostingCommand } from '@daftar/accounting';
import ts from 'typescript';
import {
  Database,
  TransactionSeamError,
  type BusinessInventoryAccountingTransaction,
  type BusinessInventoryTransaction,
  type BusinessScope,
} from '../../apps/api/src/infra/database';
import { DatabaseAccountingSourcesAdapter } from '../../apps/api/src/modules/accounting/accounting-sources.adapter';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { appDbUrl, createTestApp, ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * THE P3-AL-32 SEAM MATRIX, ROWS 1–6 AND 8 — the transaction primitive only.
 *
 * P3-S1 owns the two business seams and nothing that runs inside them in
 * production, so every mutation here goes into a TEST-OWNED fixture table
 * created by this file, and the one accepted Phase 2 operation used (row 8)
 * is the manual adjustment the P2-S4 suites already accept. No Phase 3 entity
 * is touched. Row 7 — composition with the real `inventory.configure_product`
 * routine — lives in `inventory-seam-posting.test.ts`, because it needs the
 * database half of P3-S1.
 *
 * "Observed from the server" (row 1) is taken literally: the transaction id,
 * the transaction start time, the backend's own view of itself in
 * `pg_stat_activity`, `pg_xact_status()` from a second connection, and the
 * `xmin` of the rows written — not the application's word for it.
 */

const FIXTURE = 'p3s1_seam_fixture.rows';

let t: TestApp;
let db: Database;
let sources: DatabaseAccountingSourcesAdapter;
let posting: DatabaseAccountingPostingAdapter;
let fx: PostingFixture;
let today: string;
let scope: BusinessScope;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'seam');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  scope = { tenantId: fx.tenantId, businessId: fx.businessId, actorUserId: fx.userId };
  // A test-owned table the merchant runtime may write — outside `public`, so
  // no catalogue-wide check of another suite can ever see it.
  await ownerPool().query(`DROP SCHEMA IF EXISTS p3s1_seam_fixture CASCADE`);
  await ownerPool().query(`CREATE SCHEMA p3s1_seam_fixture`);
  await ownerPool().query(`CREATE TABLE ${FIXTURE} (id uuid PRIMARY KEY, business_id uuid NOT NULL, note text NOT NULL)`);
  await ownerPool().query(`GRANT USAGE ON SCHEMA p3s1_seam_fixture TO daftar_app`);
  await ownerPool().query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${FIXTURE} TO daftar_app`);
  t = await createTestApp();
  db = t.app.get(Database);
  sources = t.app.get(DatabaseAccountingSourcesAdapter);
  posting = t.app.get(DatabaseAccountingPostingAdapter);
}, 180_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await ownerPool().query(`DELETE FROM ${FIXTURE}`);
});

afterAll(async () => {
  await t.close();
  await ownerPool().query(`DROP SCHEMA IF EXISTS p3s1_seam_fixture CASCADE`);
});

// ── construction ─────────────────────────────────────────────────────────

/** A structurally real `invctl/1` assertion for `scope` (the seams read its tenant/business only). */
function inventoryAssertion(over: { tenantId?: string; businessId?: string } = {}): string {
  return mintTestInventoryAssertion({
    actorUserId: fx.userId,
    tenantId: over.tenantId ?? fx.tenantId,
    businessId: over.businessId ?? fx.businessId,
    opCode: 'inventory.configure_product',
    payloadSha256: 'a'.repeat(64),
  });
}

/** An accepted Phase 2 operation: a balanced manual adjustment. */
function adjustment(): PostCommand {
  return simpleCommand(fx, randomUUID(), today, 150000n, 'manual_adjustment');
}

function accountingAssertionFor(c: PostCommand, over: { tenantId?: string; businessId?: string } = {}): string {
  return sourceAssertion({
    actorUserId: fx.userId,
    tenantId: over.tenantId ?? c.tenantId,
    businessId: over.businessId ?? c.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
}

function postingCommand(c: PostCommand): PostingCommand {
  return {
    tenantId: c.tenantId,
    businessId: c.businessId,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    entryDate: c.entryDate,
    description: c.description ?? null,
    requestId: c.requestId ?? null,
    lines: c.lines.map((l) => ({ ...l, branchId: l.branchId ?? null, warehouseId: l.warehouseId ?? null })),
  };
}

async function fixtureRows(): Promise<{ id: string; note: string; xmin: string }[]> {
  return (await ownerPool().query<{ id: string; note: string; xmin: string }>(`SELECT id, note, xmin::text AS xmin FROM ${FIXTURE} ORDER BY note`)).rows;
}

async function journalEntriesFor(sourceId: string): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE source_id = $1::uuid`, [sourceId]);
  return Number(must(r.rows[0]).n);
}

async function bindingsFor(sourceId: string): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM accounting_source_bindings WHERE source_id = $1::uuid`, [sourceId]);
  return Number(must(r.rows[0]).n);
}

async function insertFixture(tx: { query: BusinessInventoryTransaction['query'] }, note: string): Promise<void> {
  await tx.query(`INSERT INTO ${FIXTURE} (id, business_id, note) VALUES ($1, $2, $3)`, [randomUUID(), fx.businessId, note]);
}

/** The seam's refusal code, or a failure if it did not refuse with one. */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    throw e;
  }
  throw new Error('expected the seam to refuse, but it did not');
}

interface ServerView {
  xid: string;
  ts: string;
  pid: number;
  tenant: string;
  business: string;
  actor: string;
  inventory: string;
  accounting: string;
}

const SERVER_VIEW = `SELECT pg_current_xact_id()::text AS xid, transaction_timestamp()::text AS ts, pg_backend_pid() AS pid,
  current_setting('app.tenant_id', true) AS tenant, current_setting('app.business_id', true) AS business,
  current_setting('app.actor_user_id', true) AS actor, current_setting('app.inventory_assertion', true) AS inventory,
  current_setting('app.accounting_assertion', true) AS accounting`;

// ── row 1 ────────────────────────────────────────────────────────────────

describe('row 1 — one BEGIN and one COMMIT for the whole callback, observed from the server', () => {
  it.each(['inventory', 'inventory+accounting'] as const)('%s seam', async (which) => {
    const issued: { client: unknown; text: string }[] = [];
    const original = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      issued.push({ client: this, text: typeof first === 'string' ? first : String((first as { text?: unknown } | null)?.text ?? '') });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof Client.prototype.query);

    const inv = inventoryAssertion();
    const c = adjustment();
    const acct = accountingAssertionFor(c);
    const body = async (
      tx: BusinessInventoryTransaction,
    ): Promise<{ first: ServerView; last: ServerView; outside: { status: string; state: string; xactStart: string; visible: number } }> => {
      const first = must((await tx.query<ServerView>(SERVER_VIEW)).rows[0]);
      await insertFixture(tx, 'a');
      // A second connection, mid-callback: the transaction is open, uncommitted
      // and invisible, and the server dates it to the seam's own BEGIN.
      const status = must((await ownerPool().query<{ s: string }>(`SELECT pg_xact_status($1::xid8) AS s`, [first.xid])).rows[0]).s;
      const activity = must(
        (await ownerPool().query<{ state: string; xact_start: string }>(`SELECT state, xact_start::text FROM pg_stat_activity WHERE pid = $1`, [first.pid]))
          .rows[0],
      );
      const visible = (await ownerPool().query(`SELECT 1 FROM ${FIXTURE}`)).rowCount ?? 0;
      await insertFixture(tx, 'b');
      const last = must((await tx.query<ServerView>(SERVER_VIEW)).rows[0]);
      return { first, last, outside: { status, state: activity.state, xactStart: activity.xact_start, visible } };
    };

    const seen =
      which === 'inventory'
        ? await db.withBusinessInventoryTransaction(scope, inv, body)
        : await db.withBusinessInventoryAccountingTransaction(scope, inv, acct, body);

    // One transaction for the whole callback: one id, one start instant.
    expect(seen.last.xid).toBe(seen.first.xid);
    expect(seen.last.ts).toBe(seen.first.ts);
    expect(seen.last.pid).toBe(seen.first.pid);
    // Mid-callback, from outside: open, not committed, not visible.
    expect(seen.outside.status).toBe('in progress');
    expect(seen.outside.state).toBe('idle in transaction');
    expect(seen.outside.xactStart).toBe(seen.first.ts);
    expect(seen.outside.visible).toBe(0);
    // The scope and the carriers were set inside THIS transaction, before the
    // callback ran — transaction-local GUCs would be gone after any COMMIT.
    expect(seen.first.tenant).toBe(fx.tenantId);
    expect(seen.first.business).toBe(fx.businessId);
    expect(seen.first.actor).toBe(fx.userId);
    expect(seen.first.inventory).toBe(inv);
    // Seam 1 leaves the posting carrier EMPTY; seam 2 carries it.
    expect(seen.first.accounting).toBe(which === 'inventory' ? '' : acct);

    // After the seam: the server says that one transaction committed, and
    // every row the callback wrote carries its id.
    const status = must(
      (await ownerPool().query<{ s: string; x: string }>(`SELECT pg_xact_status($1::xid8) AS s, xid($1::xid8)::text AS x`, [seen.first.xid])).rows[0],
    );
    expect(status.s).toBe('committed');
    const rows = await fixtureRows();
    expect(rows.map((r) => r.note)).toEqual(['a', 'b']);
    expect(new Set(rows.map((r) => r.xmin))).toEqual(new Set([status.x]));

    // And on the wire of that connection: exactly one BEGIN and one COMMIT.
    const seamClient = must(issued.find((q) => q.text === SERVER_VIEW)).client;
    const control = issued.filter((q) => q.client === seamClient).map((q) => q.text.trim().toUpperCase());
    expect(control.filter((q) => q === 'BEGIN')).toHaveLength(1);
    expect(control.filter((q) => q === 'COMMIT')).toHaveLength(1);
    expect(control.filter((q) => q === 'ROLLBACK')).toHaveLength(0);
  });
});

// ── row 2 ────────────────────────────────────────────────────────────────

describe('row 2 — a failure anywhere in the callback removes every mutation made through it', () => {
  it.each(['inventory', 'inventory+accounting'] as const)('%s seam: an application error after inserts and an update', async (which) => {
    const existing = randomUUID();
    await ownerPool().query(`INSERT INTO ${FIXTURE} (id, business_id, note) VALUES ($1, $2, 'before')`, [existing, fx.businessId]);
    const body = async (tx: BusinessInventoryTransaction): Promise<never> => {
      await insertFixture(tx, 'x');
      await insertFixture(tx, 'y');
      await tx.query(`UPDATE ${FIXTURE} SET note = 'changed' WHERE id = $1`, [existing]);
      await tx.query(`DELETE FROM ${FIXTURE} WHERE note = 'x'`);
      throw new Error('injected failure');
    };
    const c = adjustment();
    const run =
      which === 'inventory'
        ? db.withBusinessInventoryTransaction(scope, inventoryAssertion(), body)
        : db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), body);
    await expect(run).rejects.toThrow('injected failure');
    const rows = await fixtureRows();
    expect(rows.map((r) => [r.id, r.note])).toEqual([[existing, 'before']]);
  });

  it('a database error mid-callback rolls back what came before it', async () => {
    const run = db.withBusinessInventoryTransaction(scope, inventoryAssertion(), async (tx) => {
      await insertFixture(tx, 'x');
      await tx.query(`SELECT 1 / 0`);
    });
    await expect(run).rejects.toThrow(/division by zero/);
    expect(await fixtureRows()).toEqual([]);
  });

  it('the handle is inert once its transaction has ended', async () => {
    let escaped: BusinessInventoryTransaction | undefined;
    await db.withBusinessInventoryTransaction(scope, inventoryAssertion(), async (tx) => {
      escaped = tx;
    });
    expect(
      await refusalCode(() => must(escaped).query(`INSERT INTO ${FIXTURE} (id, business_id, note) VALUES ($1, $2, 'late')`, [randomUUID(), fx.businessId])),
    ).toBe('seam.transaction_closed');
    expect(await fixtureRows()).toEqual([]);
  });
});

// ── row 3 ────────────────────────────────────────────────────────────────

describe('row 3 — the non-posting handle exposes no accounting posting port (runtime half)', () => {
  it('carries exactly its scope and its SQL, and no member the posting ports accept', async () => {
    const inside = await db.withBusinessInventoryTransaction(scope, inventoryAssertion(), async (tx) => {
      const values: unknown[] = Object.values(tx);
      const accepted = values.filter((v) => {
        try {
          db.postingTransactionSql(v as AccountingPostingTransaction);
          return true;
        } catch (e) {
          if (e instanceof TransactionSeamError && e.code === 'seam.not_a_posting_transaction') return false;
          throw e;
        }
      });
      return { keys: Object.keys(tx).sort(), hasAccounting: 'accounting' in tx, frozen: Object.isFrozen(tx), accepted: accepted.length };
    });
    expect(inside).toEqual({ keys: ['query', 'scope'], hasAccounting: false, frozen: true, accepted: 0 });
  });

  it('the posting handle carries exactly one more member, and it is the posting capability', async () => {
    const c = adjustment();
    const inside = await db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), async (tx) => {
      db.postingTransactionSql(tx.accounting);
      return { keys: Object.keys(tx).sort(), frozen: Object.isFrozen(tx) };
    });
    expect(inside).toEqual({ keys: ['accounting', 'query', 'scope'], frozen: true });
  });
});

// ── row 4 ────────────────────────────────────────────────────────────────

describe('row 4 — no accidental escape: the posting port refuses anything the accounting seam did not issue', () => {
  it('inside the non-posting seam, neither its handle nor its SQL nor a look-alike can post', async () => {
    const c = adjustment();
    const codes = await db.withBusinessInventoryTransaction(scope, inventoryAssertion(), async (tx) => {
      const request = { command: postingCommand(c), reason: 'a fixture adjustment' };
      const attempts: unknown[] = [tx, tx.query, tx.scope, Object.freeze(Object.create(null) as object), {}];
      const out: string[] = [];
      for (const candidate of attempts) {
        out.push(await refusalCode(() => sources.postAdjustmentInTransaction(candidate as AccountingPostingTransaction, request)));
        out.push(await refusalCode(() => posting.postEntryInTransaction(candidate as AccountingPostingTransaction, { command: postingCommand(c) })));
      }
      await insertFixture(tx, 'still-usable');
      return out;
    });
    expect(new Set(codes)).toEqual(new Set(['seam.not_a_posting_transaction']));
    expect(await journalEntriesFor(c.sourceId)).toBe(0);
    // The refusals changed nothing about the transaction they happened in.
    expect((await fixtureRows()).map((r) => r.note)).toEqual(['still-usable']);
  });

  it('a raw pg client is refused too, and so is a posting capability whose transaction has ended', async () => {
    const c = adjustment();
    const raw = new Client({ connectionString: appDbUrl });
    await raw.connect();
    try {
      expect(
        await refusalCode(() =>
          sources.postAdjustmentInTransaction(raw as unknown as AccountingPostingTransaction, { command: postingCommand(c), reason: 'x' }),
        ),
      ).toBe('seam.not_a_posting_transaction');
    } finally {
      await raw.end();
    }
    let escaped: AccountingPostingTransaction | undefined;
    await db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), async (tx) => {
      escaped = tx.accounting;
    });
    expect(await refusalCode(() => sources.postAdjustmentInTransaction(must(escaped), { command: postingCommand(c), reason: 'too late' }))).toBe(
      'seam.transaction_closed',
    );
    expect(await journalEntriesFor(c.sourceId)).toBe(0);
  });
});

// ── row 5 ────────────────────────────────────────────────────────────────

describe('row 5 — no seam opens inside a seam, and no independent commit opens inside either', () => {
  it.each(['inventory', 'inventory+accounting'] as const)('inside the %s seam: both seams and every other boundary are refused', async (which) => {
    const c = adjustment();
    const body = async (tx: BusinessInventoryTransaction): Promise<string[]> => {
      await insertFixture(tx, 'outer');
      const codes = [
        await refusalCode(() => db.withBusinessInventoryTransaction(scope, inventoryAssertion(), (inner) => insertFixture(inner, 'nested-1'))),
        await refusalCode(() =>
          db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), (inner) => insertFixture(inner, 'nested-2')),
        ),
        await refusalCode(() =>
          db.withTransaction(scope, (client) =>
            client.query(`INSERT INTO ${FIXTURE} (id, business_id, note) VALUES ($1, $2, 'nested-3')`, [randomUUID(), fx.businessId]),
          ),
        ),
        // The accepted Phase 2 single-operation method opens its OWN
        // transaction, so inside a seam it would be an independent commit.
        await refusalCode(() => sources.postAdjustment({ assertion: accountingAssertionFor(c), command: postingCommand(c), reason: 'nested' })),
      ];
      return codes;
    };
    const codes =
      which === 'inventory'
        ? await db.withBusinessInventoryTransaction(scope, inventoryAssertion(), body)
        : await db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), body);
    expect(codes).toEqual(['seam.nested_transaction', 'seam.nested_transaction', 'seam.nested_transaction', 'seam.nested_transaction']);
    expect((await fixtureRows()).map((r) => r.note)).toEqual(['outer']);
    expect(await journalEntriesFor(c.sourceId)).toBe(0);
  });

  it('a seam cannot be opened inside a Phase 1/2 transaction either', async () => {
    const codes = await db.withTransaction(scope, async () => [
      await refusalCode(() => db.withBusinessInventoryTransaction(scope, inventoryAssertion(), (inner) => insertFixture(inner, 'nested'))),
    ]);
    expect(codes).toEqual(['seam.nested_transaction']);
    expect(await fixtureRows()).toEqual([]);
  });
});

// ── rows 6 and 6a ────────────────────────────────────────────────────────

describe('row 6 — assertion/scope coherence is refused before the callback, and before a connection', () => {
  const cases: ReadonlyArray<readonly [string, () => { inv: string; acct: (c: PostCommand) => string }, string]> = [
    [
      'inventory assertion for another business',
      () => ({ inv: inventoryAssertion({ tenantId: fx.otherTenantId, businessId: fx.otherBusinessId }), acct: (c) => accountingAssertionFor(c) }),
      'seam.inventory_assertion_scope_mismatch',
    ],
    [
      'inventory assertion for another tenant, same business id',
      () => ({ inv: inventoryAssertion({ tenantId: fx.otherTenantId }), acct: (c) => accountingAssertionFor(c) }),
      'seam.inventory_assertion_scope_mismatch',
    ],
    [
      'inventory assertion for another business, same tenant id',
      () => ({ inv: inventoryAssertion({ businessId: fx.otherBusinessId }), acct: (c) => accountingAssertionFor(c) }),
      'seam.inventory_assertion_scope_mismatch',
    ],
  ];

  it.each(cases)('%s: both seams refuse, the callback never runs and the fixture stays empty', async (_name, make, code) => {
    const connect = vi.spyOn(Pool.prototype, 'connect');
    const callback = vi.fn(async (tx: BusinessInventoryTransaction) => insertFixture(tx, 'must-not-exist'));
    const { inv, acct } = make();
    const c = adjustment();
    expect(await refusalCode(() => db.withBusinessInventoryTransaction(scope, inv, callback))).toBe(code);
    expect(await refusalCode(() => db.withBusinessInventoryAccountingTransaction(scope, inv, acct(c), callback))).toBe(code);
    expect(callback).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await fixtureRows()).toEqual([]);
  });

  it.each([
    ['for another business', { tenantId: '', businessId: '' }],
    ['for another tenant, same business id', { tenantId: '', businessId: 'same' }],
    ['for another business, same tenant id', { tenantId: 'same', businessId: '' }],
  ] as const)('an accounting assertion %s: the accounting seam refuses before the callback', async (_name, shape) => {
    const connect = vi.spyOn(Pool.prototype, 'connect');
    const callback = vi.fn(async (tx: BusinessInventoryAccountingTransaction) => insertFixture(tx, 'must-not-exist'));
    const c = adjustment();
    const acct = accountingAssertionFor(c, {
      tenantId: shape.tenantId === 'same' ? fx.tenantId : fx.otherTenantId,
      businessId: shape.businessId === 'same' ? fx.businessId : fx.otherBusinessId,
    });
    expect(await refusalCode(() => db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), acct, callback))).toBe(
      'seam.accounting_assertion_scope_mismatch',
    );
    expect(callback).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await fixtureRows()).toEqual([]);
  });
});

describe('row 6a — neither seam opens without an inventory assertion (runtime half)', () => {
  const c = (): PostCommand => adjustment();
  const bad: ReadonlyArray<readonly [string, unknown, string]> = [
    ['empty', '', 'seam.inventory_assertion_missing'],
    ['undefined', undefined, 'seam.inventory_assertion_missing'],
    ['null', null, 'seam.inventory_assertion_missing'],
    ['not a string', 42, 'seam.inventory_assertion_missing'],
    ['unparseable', 'not-an-assertion', 'seam.inventory_assertion_malformed'],
    ['nine components', 'invctl1.a.b.c.d.e.f.g.h', 'seam.inventory_assertion_malformed'],
    ['an accounting assertion in its place', 'ACCOUNTING', 'seam.inventory_assertion_malformed'],
  ];

  it.each(bad)('%s: both seams refuse before the callback', async (_name, value, code) => {
    const connect = vi.spyOn(Pool.prototype, 'connect');
    const callback = vi.fn(async (tx: BusinessInventoryTransaction) => insertFixture(tx, 'must-not-exist'));
    const cmd = c();
    const acct = accountingAssertionFor(cmd);
    const inv = (value === 'ACCOUNTING' ? acct : value) as string;
    expect(await refusalCode(() => db.withBusinessInventoryTransaction(scope, inv, callback))).toBe(code);
    expect(await refusalCode(() => db.withBusinessInventoryAccountingTransaction(scope, inv, acct, callback))).toBe(code);
    expect(callback).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await fixtureRows()).toEqual([]);
  });

  it('the accounting seam also refuses a missing or unparseable accounting assertion', async () => {
    const callback = vi.fn(async (tx: BusinessInventoryAccountingTransaction) => insertFixture(tx, 'must-not-exist'));
    expect(await refusalCode(() => db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), '', callback))).toBe(
      'seam.accounting_assertion_missing',
    );
    expect(await refusalCode(() => db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), inventoryAssertion(), callback))).toBe(
      'seam.accounting_assertion_malformed',
    );
    expect(callback).not.toHaveBeenCalled();
    expect(await fixtureRows()).toEqual([]);
  });

  it('a refusal never echoes the assertion it refused', async () => {
    const inv = inventoryAssertion({ businessId: fx.otherBusinessId });
    const run = db.withBusinessInventoryTransaction(scope, inv, async () => undefined);
    await expect(run).rejects.toBeInstanceOf(TransactionSeamError);
    await run.catch((e: Error) => {
      expect(e.message).not.toContain(inv);
      expect(e.message).not.toContain(fx.otherBusinessId);
    });
  });
});

// ── row 8 ────────────────────────────────────────────────────────────────

describe('row 8 — joint atomicity with an accepted Phase 2 posting', () => {
  it('committed: the posting and the fixture mutation land in ONE transaction', async () => {
    const c = adjustment();
    const result = await db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), async (tx) => {
      await insertFixture(tx, 'companion');
      const posted = await sources.postAdjustmentInTransaction(tx.accounting, { command: postingCommand(c), reason: 'a fixture adjustment' });
      const xid = must((await tx.query<{ x: string }>(`SELECT xid(pg_current_xact_id())::text AS x`)).rows[0]).x;
      return { ...posted, xid };
    });
    expect(result.created).toBe(true);
    const entry = must((await ownerPool().query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM journal_entries WHERE id = $1`, [result.entryId])).rows[0]);
    const rows = await fixtureRows();
    expect(rows.map((r) => r.note)).toEqual(['companion']);
    expect(entry.xmin).toBe(result.xid);
    expect(must(rows[0]).xmin).toBe(result.xid);
    expect(await bindingsFor(c.sourceId)).toBe(1);
  });

  it('a failure injected AFTER the accepted posting rolls back the posting AND the companion fixture mutation', async () => {
    const c = adjustment();
    let postedEntryId: string | undefined;
    let visibleInside = 0;
    const run = db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion(), accountingAssertionFor(c), async (tx) => {
      await insertFixture(tx, 'companion');
      const posted = await sources.postAdjustmentInTransaction(tx.accounting, { command: postingCommand(c), reason: 'a fixture adjustment' });
      postedEntryId = posted.entryId;
      visibleInside = (await tx.query(`SELECT 1 FROM journal_entries WHERE id = $1`, [posted.entryId])).rowCount ?? 0;
      await insertFixture(tx, 'after-posting');
      throw new Error('injected after the posting');
    });
    await expect(run).rejects.toThrow('injected after the posting');
    // The posting really happened inside the transaction …
    expect(postedEntryId).toBeDefined();
    expect(visibleInside).toBe(1);
    // … and nothing of it, or of its companion, survived.
    expect(await journalEntriesFor(c.sourceId)).toBe(0);
    expect(await bindingsFor(c.sourceId)).toBe(0);
    expect(await fixtureRows()).toEqual([]);
  });

  it('the accepted single-operation method still posts on its own, unchanged (row 9 spot check)', async () => {
    const c = adjustment();
    const posted = await sources.postAdjustment({ assertion: accountingAssertionFor(c), command: postingCommand(c), reason: 'a fixture adjustment' });
    expect(posted.created).toBe(true);
    expect(await journalEntriesFor(c.sourceId)).toBe(1);
  });
});

// ── the forbidden spellings (P3-AL-32 item 3, P3-AL-33) ───────────────────

describe('no flag, option or bypass exists in the seam or the ports', () => {
  const ROOT = join(__dirname, '../..');
  const FILES = [
    'apps/api/src/infra/database.ts',
    'packages/accounting/src/ports.ts',
    'apps/api/src/modules/accounting/accounting-posting.adapter.ts',
    'apps/api/src/modules/accounting/accounting-sources.adapter.ts',
    'apps/api/src/modules/inventory/inventory-assertion.minter.ts',
  ];
  const FORBIDDEN = [
    'skipAccounting',
    'requiresAccounting',
    'skipAuthorization',
    'skipInventoryAssertion',
    'requiresAssertion',
    'rawInventoryWrite',
    'postTrusted',
    'rawJournalInsert',
    'bypassAccountingPermission',
    'trusted',
  ];
  /** Code only: the accepted files explain in comments why these do not exist. */
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it.each(FILES)('%s', (file) => {
    const src = code(readFileSync(join(ROOT, file), 'utf8'));
    for (const name of FORBIDDEN) expect(src, name).not.toMatch(new RegExp(`\\b${name}\\b`, 'i'));
  });
});

// ── rows 3, 4 and 6a — the compile-time half ─────────────────────────────

/**
 * The type system IS the first half of rows 3, 4 and 6a, so it is tested as
 * one: each probe below is compiled by the real TypeScript compiler against
 * the real modules, with the repository's compiler options, and must fail
 * with the named diagnostic — while the positive control, the same calls
 * written correctly, must compile with none. A probe that failed for an
 * unrelated reason would fail with a different code, and this case says so.
 */
describe('rows 3, 4 and 6a — compile-time: the signatures admit no escape', () => {
  const ROOT = join(__dirname, '../..');
  const DIR = join(ROOT, 'tests/integration');
  const HEADER = `
import type { PoolClient } from 'pg';
import type { AccountingPostingTransaction, PostingCommand } from '@daftar/accounting';
import type { Database, BusinessScope, BusinessInventoryAccountingTransaction } from '../../apps/api/src/infra/database';
import type { DatabaseAccountingSourcesAdapter } from '../../apps/api/src/modules/accounting/accounting-sources.adapter';
import type { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
declare const db: Database;
declare const scope: BusinessScope;
declare const sources: DatabaseAccountingSourcesAdapter;
declare const posting: DatabaseAccountingPostingAdapter;
declare const command: PostingCommand;
declare const client: PoolClient;
declare const inv: string;
declare const acct: string;
export type Unused = [PoolClient, AccountingPostingTransaction, BusinessInventoryAccountingTransaction];
void [db, scope, sources, posting, command, client, inv, acct];
`;

  /** [probe name, body, the diagnostic codes it must raise (empty = must compile)] */
  const PROBES: ReadonlyArray<readonly [string, string, readonly number[]]> = [
    [
      'positive control: both seams, used as designed',
      `export async function ok(): Promise<void> {
         await db.withBusinessInventoryTransaction(scope, inv, async (tx) => { await tx.query('SELECT 1'); return tx.scope.businessId; });
         await db.withBusinessInventoryAccountingTransaction(scope, inv, acct, async (tx) => {
           await tx.query('SELECT 1');
           await sources.postAdjustmentInTransaction(tx.accounting, { command, reason: 'r' });
           await posting.postEntryInTransaction(tx.accounting, { command });
         });
       }`,
      [],
    ],
    [
      'row 3: the non-posting handle has no accounting member',
      `export const p = db.withBusinessInventoryTransaction(scope, inv, async (tx) => sources.postAdjustmentInTransaction(tx.accounting, { command, reason: 'r' }));`,
      [2339],
    ],
    [
      'row 4: the non-posting handle is not a posting transaction',
      `export const p = db.withBusinessInventoryTransaction(scope, inv, async (tx) => posting.postEntryInTransaction(tx, { command }));`,
      [2345],
    ],
    [
      'row 4: its SQL is not a posting transaction either',
      `export const p = db.withBusinessInventoryTransaction(scope, inv, async (tx) => posting.postEntryInTransaction(tx.query, { command }));`,
      [2345],
    ],
    ['row 4: a raw pg client is not a posting transaction', `export const p = sources.postAdjustmentInTransaction(client, { command, reason: 'r' });`, [2345]],
    [
      'row 4: nor is the posting seam handle itself — only its capability',
      `export const p = db.withBusinessInventoryAccountingTransaction(scope, inv, acct, async (tx) => posting.postEntryInTransaction(tx, { command }));`,
      [2345],
    ],
    ['row 4: a look-alike object cannot be written', `export const fake: AccountingPostingTransaction = {};`, [2741]],
    [
      'row 4: the Phase 2 boundary hands out the capability, not a client',
      `export const p = db.withAccountingTransaction(acct, async (tx) => tx.query('SELECT 1'));`,
      [2339],
    ],
    [
      'row 3: annotating the non-posting callback as the posting handle does not convert it',
      `export const p = db.withBusinessInventoryTransaction(scope, inv, async (tx: BusinessInventoryAccountingTransaction) => tx.accounting);`,
      [2345],
    ],
    ['row 6a: seam 1 without an inventory assertion', `export const p = db.withBusinessInventoryTransaction(scope, async () => undefined);`, [2554]],
    [
      'row 6a: seam 2 without an inventory assertion',
      `export const p = db.withBusinessInventoryAccountingTransaction(scope, acct, async () => undefined);`,
      [2554],
    ],
    ['row 6a: an undefined inventory assertion', `export const p = db.withBusinessInventoryTransaction(scope, undefined, async () => undefined);`, [2345]],
    [
      'item 3: no option bag',
      `export const p = db.withBusinessInventoryTransaction(scope, inv, async () => undefined, { skipInventoryAssertion: true });`,
      [2554],
    ],
    ['item 3: no boolean', `export const p = db.withBusinessInventoryAccountingTransaction(scope, inv, acct, async () => undefined, true);`, [2554]],
  ];

  it('each probe raises exactly its diagnostic, and the positive control compiles clean', () => {
    const files = new Map(PROBES.map(([, body], i) => [join(DIR, `__seam_probe_${i}__.ts`), `${HEADER}\n${body}\n`] as const));
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      lib: ['lib.es2022.d.ts'],
      types: ['node'],
      strict: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const baseGet = host.getSourceFile.bind(host);
    const baseExists = host.fileExists.bind(host);
    const baseRead = host.readFile.bind(host);
    host.fileExists = (f) => files.has(f) || baseExists(f);
    host.readFile = (f) => files.get(f) ?? baseRead(f);
    host.getSourceFile = (f, lang, onError, create) => {
      const text = files.get(f);
      return text === undefined ? baseGet(f, lang, onError, create) : ts.createSourceFile(f, text, lang);
    };
    const program = ts.createProgram([...files.keys()], options, host);

    // Nothing OUTSIDE the probes may fail: an error in the real modules would
    // make every negative probe pass for the wrong reason.
    const elsewhere = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file === undefined || !files.has(d.file.fileName))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(elsewhere).toEqual([]);

    const results = PROBES.map(([name], i) => {
      const sf = must(program.getSourceFile(join(DIR, `__seam_probe_${i}__.ts`)));
      const codes = [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)].map((d) => d.code);
      return [name, [...new Set(codes)].sort()] as const;
    });
    expect(results).toEqual(PROBES.map(([name, , codes]) => [name, [...codes].sort()]));
  }, 120_000);
});
