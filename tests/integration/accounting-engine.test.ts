import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand } from '@daftar/accounting';
import { AccountingError } from '@daftar/accounting';
import { AccountingPostingService } from '../../apps/api/src/modules/accounting/accounting-posting.service';
import { TenancyService, type MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { refusal, todayIn, must } from '../helpers/accounting-posting';

/**
 * MATRIX 5 — THE ENGINE AS THE API ACTUALLY USES IT (§52, §53, §54).
 *
 * The suites above call the database primitive directly, because that is where
 * the authority boundary lives. This one goes the other way: through the Nest
 * composition, the real `MembershipContext`, the real permission check, the
 * real branch-scope resolution and the real minter, so the wiring is proved to
 * hold together and not merely to compile.
 *
 * There is no HTTP request here because there is no posting endpoint (§12).
 * That absence is itself asserted at the end.
 */

/** Every file under `dir` whose name ends with `suffix`, recursively. */
async function glob(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await glob(full, suffix)));
    else if (e.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

let t: TestApp;
let posting: AccountingPostingService;
let tenancy: TenancyService;
let today: string;

interface Owner {
  token: string;
  userId: string;
  businessId: string;
  membership: MembershipContext;
}

async function onboard(): Promise<Owner> {
  const reg = await t.request
    .post('/v1/auth/register')
    .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Ledger Owner', preferredLocale: 'ar' });
  const token = reg.body.accessToken as string;
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Ledger Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `led-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  const businessId = on.body.businessId as string;
  const userId = (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.userId as string;
  const membership = await tenancy.resolveMembership(userId, businessId);
  return { token, userId, businessId, membership };
}

function command(m: MembershipContext, branchId: string | null = null): PostingCommand {
  const at = new Date('2026-03-14T09:15:00Z');
  const line = (systemKey: string, side: 'D' | 'C') => ({
    account: { kind: 'system' as const, systemKey },
    side,
    baseAmountMinor: 50000n,
    baseCurrency: 'ILS',
    txnAmountMinor: 50000n,
    txnCurrency: 'ILS',
    fxRate: '1.0000000000',
    fxRateSource: 'base' as const,
    fxRateAt: at,
    branchId,
    warehouseId: null,
  });
  return {
    tenantId: m.tenantId,
    businessId: m.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate: today,
    description: 'engine posting',
    requestId: 'req-engine',
    lines: [line('cash', 'D'), line('opening_equity', 'C')],
  };
}

beforeAll(async () => {
  t = await createTestApp();
  await resetData();
  posting = t.app.get(AccountingPostingService);
  tenancy = t.app.get(TenancyService);
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

describe('the engine, composed as the merchant API composes it', () => {
  it('posts for an owner, all the way to a committed journal entry', async () => {
    const o = await onboard();
    const r = await posting.post(o.membership, command(o.membership));
    expect(r.created).toBe(true);
    const row = await ownerPool().query<{ business_id: string; actor_user_id: string }>(
      `SELECT business_id, actor_user_id FROM journal_entries WHERE id = $1`,
      [r.entryId],
    );
    expect(must(row.rows[0]).business_id).toBe(o.businessId);
    expect(must(row.rows[0]).actor_user_id).toBe(o.userId);
  });

  it('takes the actor from the membership, so a command cannot name one', async () => {
    const o = await onboard();
    const c = command(o.membership) as PostingCommand & { actorUserId?: string };
    // There is no actor field on the command type. This asserts the runtime
    // shape too: a stray property changes nothing about who is recorded.
    c.actorUserId = randomUUID();
    const r = await posting.post(o.membership, c);
    const row = await ownerPool().query<{ actor_user_id: string }>(`SELECT actor_user_id FROM journal_entries WHERE id = $1`, [r.entryId]);
    expect(must(row.rows[0]).actor_user_id).toBe(o.userId);
  });

  it('refuses a member who does not hold accounting.post', async () => {
    const o = await onboard();
    const withoutPermission: MembershipContext = {
      ...o.membership,
      roles: { roles: [{ key: 'viewer', isSystem: false, permissions: new Set(['accounting.view']) }] } as MembershipContext['roles'],
    };
    await expect(posting.post(withoutPermission, command(withoutPermission))).rejects.toThrow(/accounting\.post is required/);
  });

  it('refuses a command whose business is not the one the membership resolved', async () => {
    const a = await onboard();
    const b = await onboard();
    const foreign: PostingCommand = { ...command(a.membership), businessId: b.businessId, tenantId: b.membership.tenantId };
    await expect(posting.post(a.membership, foreign)).rejects.toThrow(/only be raised for the business the membership resolved/);
  });

  it('refuses a branch-scoped member who posts to no branch at all', async () => {
    const o = await onboard();
    const scoped: MembershipContext = { ...o.membership, branchScopeMode: 'assigned', allowedBranchIds: [randomUUID()] };
    const message = await refusal(() => posting.post(scoped, command(scoped, null)));
    expect(message).toMatch(/every line to an assigned branch/);
  });

  it('refuses a branch-scoped member who posts to a branch they do not hold', async () => {
    const o = await onboard();
    const scoped: MembershipContext = { ...o.membership, branchScopeMode: 'assigned', allowedBranchIds: [randomUUID()] };
    await expect(posting.post(scoped, command(scoped, randomUUID()))).rejects.toBeInstanceOf(AccountingError);
  });

  it('accepts a branch-scoped member posting to a branch they do hold, and binds it into the entry', async () => {
    const o = await onboard();
    const branch = await ownerPool().query<{ id: string }>(`SELECT id FROM branches WHERE business_id = $1 AND is_default LIMIT 1`, [o.businessId]);
    const branchId = must(branch.rows[0]).id;
    const scoped: MembershipContext = { ...o.membership, branchScopeMode: 'assigned', allowedBranchIds: [branchId] };
    const r = await posting.post(scoped, command(scoped, branchId));
    const lines = await ownerPool().query<{ branch_id: string }>(`SELECT branch_id FROM journal_lines WHERE journal_entry_id = $1`, [r.entryId]);
    expect(lines.rows.map((l) => l.branch_id)).toEqual([branchId, branchId]);
  });

  it('returns a typed accounting error, carrying identifiers and no financial values (§78)', async () => {
    const o = await onboard();
    const c = command(o.membership);
    await posting.post(o.membership, c);
    const conflicting: PostingCommand = { ...c, lines: c.lines.map((l) => ({ ...l, baseAmountMinor: 60000n, txnAmountMinor: 60000n })) };
    try {
      await posting.post(o.membership, conflicting);
      throw new Error('the conflicting posting was accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(AccountingError);
      const safe = (e as AccountingError).toSafeJSON();
      expect(safe.code).toBe('accounting.idempotency_conflict');
      expect(JSON.stringify(safe)).not.toContain('60000');
      expect(Object.keys(safe).sort()).toEqual(['businessId', 'code', 'sourceId', 'sourceType']);
    }
  });

  it('exposes no HTTP posting surface at all (§12)', async () => {
    // Two halves, because either alone is weak. No controller may reach the
    // posting service, and no plausible posting route may answer a request.
    const controllers = await glob(join(__dirname, '../../apps/api/src/modules'), '.controller.ts');
    expect(controllers.length).toBeGreaterThan(0);
    for (const file of controllers) {
      const src = await readFile(file, 'utf8');
      expect(src, `${file} reaches the posting engine`).not.toMatch(/AccountingPostingService|AccountingEngine/);
    }

    const o = await onboard();
    const paths = ['/v1/accounting/entries', '/v1/accounting/post', '/v1/businesses/current/accounting/entries', '/v1/journal/entries'];
    for (const p of paths) {
      const r = await t.request.post(p).set('Authorization', `Bearer ${o.token}`).set('X-Business-Id', o.businessId).send({});
      expect(r.status, `${p} answered`).toBe(404);
    }
  });
});
