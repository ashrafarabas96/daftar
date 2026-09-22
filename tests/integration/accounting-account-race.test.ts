import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  assertionFor,
  dbPayload,
  must,
  post,
  postAs,
  refusal,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX 7 — THE ACCOUNT SNAPSHOT RACE (directive §11-§15).
 *
 * An account's `code` and `type` are not decoration. They ARE the identity the
 * canonical `acctfp/1` fingerprint is computed from, so a posting that reads
 * them and then writes `journal_lines` without holding the row still can
 * persist a line whose account identity is not the identity it was signed
 * under. The damage is not only at write time: a year later, an idempotent
 * replay of the same source recomputes the fingerprint from the CURRENT chart,
 * gets a different value, and the engine reports an idempotency conflict
 * against its own earlier work.
 *
 * P2-S3 has to be correct about this before the account-management slice
 * exists, not after it: by then there would be posted history to reconcile.
 *
 * ── How the stabilization actually works ─────────────────────────────────
 *
 * `SELECT ... FOR SHARE` is the obvious mechanism and PostgreSQL refuses it
 * here: every row-locking clause requires ACL_UPDATE on the table, and the
 * posting authority holds SELECT and INSERT on `accounts` and must never hold
 * UPDATE. So the exclusion is explicit and symmetric instead — a posting takes
 * a SHARED advisory lock per resolved account, and the `accounts_posting_stability`
 * trigger takes the EXCLUSIVE one on every UPDATE and DELETE of an account row.
 * Shared/exclusive, so postings never block each other and a mutation waits for
 * all of them.
 *
 * Every case below uses TWO REAL CONNECTIONS and forces the interleaving
 * explicitly. A case that fired two promises and trusted the scheduler would
 * prove whichever order it happened to get.
 */

let fx: PostingFixture;
let today: string;

/** A business with its own chart, so one case's renames cannot reach another's. */
interface Scope {
  tenantId: string;
  businessId: string;
}

async function freshBusiness(label: string): Promise<Scope> {
  const tenantId = must((await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
  const businessId = must(
    (
      await ownerPool().query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
        [tenantId, `Race ${label}`, `race-${label}-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0],
  ).id;
  return { tenantId, businessId };
}

/** A CUSTOM account — the only kind whose code and type may ever be renamed. */
async function customAccount(scope: Scope, code: string, type = 'asset'): Promise<string> {
  return must(
    (
      await ownerPool().query<{ id: string }>(
        `INSERT INTO accounts (tenant_id, business_id, code, name, type, is_active)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [scope.tenantId, scope.businessId, code, `Custom ${code}`, type],
      )
    ).rows[0],
  ).id;
}

/** A balanced two-line command naming one custom account by code and cash by system key. */
function commandOn(scope: Scope, code: string, sourceId = randomUUID(), amount = 90000n): PostCommand {
  const base = simpleCommand({ ...fx, ...scope }, sourceId, today, amount);
  const [debit, credit] = base.lines;
  return { ...base, lines: [{ ...must(debit), account: { kind: 'code', code } }, must(credit)] };
}

async function closeAll(...clients: Client[]): Promise<void> {
  for (const c of clients) await c.end().catch(() => undefined);
}

/** Is `client` currently waiting on a lock rather than running? */
async function isBlocked(pid: number): Promise<boolean> {
  const r = await ownerPool().query<{ waiting: boolean }>(`SELECT (wait_event_type = 'Lock') AS waiting FROM pg_stat_activity WHERE pid = $1`, [pid]);
  return r.rows[0]?.waiting === true;
}

async function pidOf(client: Client | PoolClient): Promise<number> {
  return Number(must((await client.query<{ pid: string }>(`SELECT pg_backend_pid()::text AS pid`)).rows[0]).pid);
}

/** Wait, bounded, for a statement issued on `pid` to be parked on a lock. */
async function waitUntilBlocked(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (await isBlocked(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** The account identity every line of an entry was actually persisted against. */
async function persistedCodes(entryId: string): Promise<string[]> {
  const r = await ownerPool().query<{ code: string }>(
    `SELECT a.code FROM journal_lines jl
     JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id
     WHERE jl.journal_entry_id = $1 ORDER BY jl.line_no`,
    [entryId],
  );
  return r.rows.map((x) => x.code);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'acctrace');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

describe('the stabilization is real (§12)', () => {
  it('an account UPDATE waits while a posting that resolved it is still open', async () => {
    const scope = await freshBusiness('wait');
    await customAccount(scope, '7100');
    const poster = await appClient();
    const mutator = await ownerPool().connect();
    try {
      const c = commandOn(scope, '7100');
      await poster.query('BEGIN');
      await poster.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertionFor(c, fx.userId)]);
      // Through the command that owns `manual_adjustment`: it forwards this
      // assertion and this payload to `accounting_post_entry` unchanged, so
      // the account advisory lock under test is taken exactly as before, and
      // the entry is source-complete when the transaction commits below.
      await poster.query(`SELECT entry_id FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`, [
        c.entryDate,
        c.description ?? '',
        'a fixture adjustment',
        c.requestId ?? null,
        JSON.stringify(dbPayload(c.lines)),
      ]);
      // The posting holds the shared advisory lock and has NOT committed.
      const mutatorPid = await pidOf(mutator);
      const rename = mutator.query(`UPDATE accounts SET name = 'renamed while posting' WHERE business_id = $1 AND code = '7100'`, [scope.businessId]);
      expect(await waitUntilBlocked(mutatorPid), 'the account UPDATE ran straight through a posting that had resolved that account').toBe(true);

      await poster.query('COMMIT');
      await rename; // released by the commit above
    } finally {
      mutator.release();
      await closeAll(poster);
    }
  });

  it('two postings that share an account do NOT block each other — the lock is shared, not a bottleneck', async () => {
    const scope = await freshBusiness('shared');
    await customAccount(scope, '7110');
    // One committed posting first. The FIRST posting in a business takes the
    // business row FOR UPDATE so the financial_started_at transition is
    // serialized (§41), and two first postings blocking each other would say
    // nothing about the ACCOUNT lock this case is here to measure.
    await post(commandOn(scope, '7110', randomUUID(), 5000n), fx.userId);
    const a = await appClient();
    const b = await appClient();
    try {
      const ca = commandOn(scope, '7110', randomUUID(), 11000n);
      const cb = commandOn(scope, '7110', randomUUID(), 22000n);
      await a.query('BEGIN');
      await postAs(assertionFor(ca, fx.userId), ca, {}, a);
      // b runs to completion while a still holds its locks. If the account
      // lock were exclusive this would hang until the test timed out.
      await b.query('BEGIN');
      await postAs(assertionFor(cb, fx.userId), cb, {}, b);
      await b.query('COMMIT');
      await a.query('COMMIT');

      const n = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1`, [scope.businessId]);
      expect(n.rows[0]?.n).toBe('3');
    } finally {
      await closeAll(a, b);
    }
  });
});

describe('CASE A — the code change wins first (§14)', () => {
  it('a payload signed against the OLD code is refused, never posted under an identity that no longer exists', async () => {
    const scope = await freshBusiness('case-a');
    await customAccount(scope, '7200');
    const c = commandOn(scope, '7200');

    await ownerPool().query(`UPDATE accounts SET code = '7201' WHERE business_id = $1 AND code = '7200'`, [scope.businessId]);

    expect(await refusal(() => post(c, fx.userId))).toMatch(/account_not_found/);
    const n = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1`, [scope.businessId]);
    expect(n.rows[0]?.n, 'a refused posting wrote an entry').toBe('0');
  });

  it('and the same posting re-signed against the NOW-CURRENT code commits against that identity', async () => {
    const scope = await freshBusiness('case-a2');
    await customAccount(scope, '7210');
    await ownerPool().query(`UPDATE accounts SET code = '7211' WHERE business_id = $1 AND code = '7210'`, [scope.businessId]);

    const c = commandOn(scope, '7211');
    const outcome = await post(c, fx.userId);
    expect(outcome.created).toBe(true);
    expect(await persistedCodes(outcome.entryId)).toContain('7211');
  });
});

describe('CASE B — the posting locks first (§14, §15)', () => {
  it('the code change waits, then finds posted history and is refused', async () => {
    const scope = await freshBusiness('case-b');
    await customAccount(scope, '7300');
    const poster = await appClient();
    const mutator = await ownerPool().connect();
    try {
      const c = commandOn(scope, '7300');
      await poster.query('BEGIN');
      await postAs(assertionFor(c, fx.userId), c, {}, poster);

      const mutatorPid = await pidOf(mutator);
      const rename = mutator
        .query(`UPDATE accounts SET code = '7301' WHERE business_id = $1 AND code = '7300'`, [scope.businessId])
        .then(() => null)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(await waitUntilBlocked(mutatorPid)).toBe(true);

      await poster.query('COMMIT');
      const outcome = await rename;
      expect(outcome, 'the rename succeeded against an account that now has posted history').not.toBeNull();
      expect(outcome).toMatch(/account_identity_locked/);
    } finally {
      mutator.release();
      await closeAll(poster);
    }
  });

  it('the type change is refused the same way, and for the same reason', async () => {
    const scope = await freshBusiness('case-b2');
    await customAccount(scope, '7310');
    const c = commandOn(scope, '7310');
    await post(c, fx.userId);

    await expect(ownerPool().query(`UPDATE accounts SET type = 'expense' WHERE business_id = $1 AND code = '7310'`, [scope.businessId])).rejects.toThrow(
      /account_identity_locked/,
    );
  });

  it('but the display NAME is not identity, and may still be changed after posting (§15)', async () => {
    const scope = await freshBusiness('case-b3');
    await customAccount(scope, '7320');
    await post(commandOn(scope, '7320'), fx.userId);
    await expect(
      ownerPool().query(`UPDATE accounts SET name = 'Renamed freely' WHERE business_id = $1 AND code = '7320'`, [scope.businessId]),
    ).resolves.toBeDefined();
  });
});

describe('CASE C — deactivation wins first (§14)', () => {
  it('a NEW posting naming the now-inactive account is refused', async () => {
    const scope = await freshBusiness('case-c');
    await customAccount(scope, '7400');
    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND code = '7400'`, [scope.businessId]);

    expect(await refusal(() => post(commandOn(scope, '7400'), fx.userId))).toMatch(/account_inactive/);
  });
});

describe('CASE D — the posting locks first, then deactivation (§14, §15)', () => {
  it('the posting commits, the deactivation waits, and then succeeds — lifecycle is not identity', async () => {
    const scope = await freshBusiness('case-d');
    await customAccount(scope, '7500');
    const poster = await appClient();
    const mutator = await ownerPool().connect();
    try {
      const c = commandOn(scope, '7500');
      await poster.query('BEGIN');
      await postAs(assertionFor(c, fx.userId), c, {}, poster);

      const mutatorPid = await pidOf(mutator);
      const deactivate = mutator
        .query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND code = '7500'`, [scope.businessId])
        .then(() => null)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(await waitUntilBlocked(mutatorPid)).toBe(true);

      await poster.query('COMMIT');
      expect(await deactivate, 'deactivating a used CUSTOM account is allowed and was refused').toBeNull();

      const state = await ownerPool().query<{ active: boolean }>(`SELECT is_active AS active FROM accounts WHERE business_id = $1 AND code = '7500'`, [
        scope.businessId,
      ]);
      expect(state.rows[0]?.active).toBe(false);
    } finally {
      mutator.release();
      await closeAll(poster);
    }
  });
});

describe('CASE E — the accepted idempotency survives all of it (§14)', () => {
  it('an identical retry after deactivation returns the ORIGINAL entry, created=false', async () => {
    const scope = await freshBusiness('case-e');
    await customAccount(scope, '7600');
    const c = commandOn(scope, '7600');
    const first = await post(c, fx.userId);
    expect(first.created).toBe(true);

    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND code = '7600'`, [scope.businessId]);

    const retry = await post(c, fx.userId);
    expect(retry.entryId).toBe(first.entryId);
    expect(retry.created).toBe(false);
  });
});

describe('deterministic lock ordering (§13)', () => {
  /**
   * The deadlock this rules out is not exotic. Two postings, three accounts,
   * the same two of them named in opposite line order: if each caller locked
   * the accounts in ITS payload's order, A would hold cash and want sales
   * while B held sales and wanted cash, and PostgreSQL would kill one of them.
   *
   * Ordering by account id — not by line number, not by the order the JSON
   * arrived in — is what makes that impossible, and this is the case that
   * would notice if someone removed the ORDER BY.
   */
  it('two postings naming the same accounts in OPPOSITE order both finish', async () => {
    const scope = await freshBusiness('deadlock');
    await customAccount(scope, '7700');
    await customAccount(scope, '7710', 'revenue');
    // Establish financial life first, for the §41 reason above: two FIRST
    // postings serialize on the business row and would mask the account
    // ordering this case exists to prove.
    await post(commandOn(scope, '7700', randomUUID(), 1000n), fx.userId);

    const lines = (first: string, second: string, amount: bigint): PostCommand => {
      const base = simpleCommand({ ...fx, ...scope }, randomUUID(), today, amount);
      const [debit, credit] = base.lines;
      return {
        ...base,
        lines: [
          { ...must(debit), account: { kind: 'code', code: first } },
          { ...must(credit), account: { kind: 'code', code: second } },
        ],
      };
    };

    const a = await appClient();
    const b = await appClient();
    try {
      const ca = lines('7700', '7710', 31000n);
      const cb = lines('7710', '7700', 32000n);

      await a.query('BEGIN');
      await postAs(assertionFor(ca, fx.userId), ca, {}, a);
      // b's payload names the two accounts the other way round while a still
      // holds both. With payload-order locking this is the deadlock.
      await b.query('BEGIN');
      await postAs(assertionFor(cb, fx.userId), cb, {}, b);
      await a.query('COMMIT');
      await b.query('COMMIT');

      const n = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1`, [scope.businessId]);
      expect(n.rows[0]?.n, 'one of the two postings did not survive').toBe('3');
    } finally {
      await closeAll(a, b);
    }
  });
});

describe('deletion cannot happen underneath a posting either (§12)', () => {
  it('a DELETE of a resolved account waits for the posting, then meets the foreign key', async () => {
    const scope = await freshBusiness('delete');
    await customAccount(scope, '7800');
    const poster = await appClient();
    const mutator = await ownerPool().connect();
    try {
      const c = commandOn(scope, '7800');
      await poster.query('BEGIN');
      await postAs(assertionFor(c, fx.userId), c, {}, poster);

      const mutatorPid = await pidOf(mutator);
      const remove = mutator
        .query(`DELETE FROM accounts WHERE business_id = $1 AND code = '7800'`, [scope.businessId])
        .then(() => null)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(await waitUntilBlocked(mutatorPid), 'the DELETE ran straight through an open posting').toBe(true);

      await poster.query('COMMIT');
      expect(await remove, 'an account with posted lines was deleted').not.toBeNull();
    } finally {
      mutator.release();
      await closeAll(poster);
    }
  });
});
