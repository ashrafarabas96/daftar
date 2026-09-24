import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand } from '@daftar/accounting';
import { AccountingError } from '@daftar/accounting';
import type { AccountingAdjustmentCreateDto, AccountingLineDto } from '@daftar/shared-contracts';
import { AccountingPostingService } from '../../apps/api/src/modules/accounting/accounting-posting.service';
import { AccountingSourcesService } from '../../apps/api/src/modules/accounting/accounting-sources.service';
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
 *
 * The posting behaviour below is driven through `AccountingSourcesService`,
 * the command that OWNS `manual_adjustment`, and not through the generic
 * `AccountingPostingService`. That is not a detail of convenience. Every
 * source type the registry holds today belongs to this slice and has a
 * command of its own, so the generic path has no legitimate caller in Phase 2
 * — and since the round-three correction it says so: `AccountingEngine.post`
 * refuses all three by name, and the database refuses them again at COMMIT.
 * A test that kept posting an adjustment through the generic path would be a
 * test that keeps the bypass alive in order to prove something else.
 *
 * What the generic service still proves here is its authorization boundary,
 * which is reached before the engine: permission and business scoping. The
 * refusal itself is asserted too, for each of the three native types.
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
let sources: AccountingSourcesService;
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
  // Registration is rate limited per IP, and a suite that quietly runs out of
  // attempts otherwise fails several tests later with "not a member".
  if (on.status >= 400 || typeof on.body.businessId !== 'string') throw new Error(`onboarding failed ${on.status}: ${JSON.stringify(on.body)}`);
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

/** The same two lines as `command`, in the shape the owning command takes. */
function adjustment(branchId: string | null = null, amount = '50000'): AccountingAdjustmentCreateDto {
  const line = (systemKey: string, side: 'D' | 'C'): AccountingLineDto => ({
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1.0000000000',
    fxRateSource: 'base',
    fxRateAt: '2026-03-14T09:15:00Z',
    branchId,
    warehouseId: null,
  });
  return { entryDate: today, description: 'engine posting', reason: 'the correction under test', lines: [line('cash', 'D'), line('opening_equity', 'C')] };
}

const key = (): string => `idem-${randomUUID()}`;

/**
 * One owner, shared by the cases that need A membership rather than a fresh
 * one. Registration is rate limited per IP and this suite sits close to the
 * ceiling; a case that does not care whose business it is should not spend an
 * attempt on its own.
 */
let shared: Owner | null = null;
async function sharedOwner(): Promise<Owner> {
  shared ??= await onboard();
  return shared;
}

beforeAll(async () => {
  t = await createTestApp();
  await resetData();
  posting = t.app.get(AccountingPostingService);
  sources = t.app.get(AccountingSourcesService);
  tenancy = t.app.get(TenancyService);
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

describe('the engine, composed as the merchant API composes it', () => {
  it('posts for an owner, all the way to a committed journal entry', async () => {
    const o = await onboard();
    const r = await sources.postAdjustment(o.membership, adjustment(), key(), 'req-engine');
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
    const c = adjustment() as AccountingAdjustmentCreateDto & { actorUserId?: string };
    // There is no actor field on the DTO. This asserts the runtime shape too:
    // a stray property changes nothing about who is recorded.
    c.actorUserId = randomUUID();
    const r = await sources.postAdjustment(o.membership, c, key(), 'req-engine');
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
    const message = await refusal(() => sources.postAdjustment(scoped, adjustment(null), key(), null));
    expect(message).toMatch(/every line to an assigned branch/);
  });

  it('refuses a branch-scoped member who posts to a branch they do not hold', async () => {
    const o = await onboard();
    const scoped: MembershipContext = { ...o.membership, branchScopeMode: 'assigned', allowedBranchIds: [randomUUID()] };
    await expect(sources.postAdjustment(scoped, adjustment(randomUUID()), key(), null)).rejects.toBeInstanceOf(AccountingError);
  });

  it('accepts a branch-scoped member posting to a branch they do hold, and binds it into the entry', async () => {
    const o = await onboard();
    const branch = await ownerPool().query<{ id: string }>(`SELECT id FROM branches WHERE business_id = $1 AND is_default LIMIT 1`, [o.businessId]);
    const branchId = must(branch.rows[0]).id;
    const scoped: MembershipContext = { ...o.membership, branchScopeMode: 'assigned', allowedBranchIds: [branchId] };
    const r = await sources.postAdjustment(scoped, adjustment(branchId), key(), null);
    const lines = await ownerPool().query<{ branch_id: string }>(`SELECT branch_id FROM journal_lines WHERE journal_entry_id = $1`, [r.entryId]);
    expect(lines.rows.map((l) => l.branch_id)).toEqual([branchId, branchId]);
  });

  it('returns a typed accounting error, carrying identifiers and no financial values (§78)', async () => {
    const o = await onboard();
    // ONE transport key, two materially different financial commands.
    const k = key();
    await sources.postAdjustment(o.membership, adjustment(), k, null);
    try {
      await sources.postAdjustment(o.membership, adjustment(null, '60000'), k, null);
      throw new Error('the conflicting posting was accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(AccountingError);
      const safe = (e as AccountingError).toSafeJSON();
      expect(safe.code).toBe('accounting.idempotency_conflict');
      expect(JSON.stringify(safe)).not.toContain('60000');
      expect(Object.keys(safe).sort()).toEqual(['businessId', 'code', 'sourceId', 'sourceType']);
    }
  });

  it('refuses every Phase-2-native source type on the generic posting path', async () => {
    // §2-§3 of the round-three directive. `post` is the entry point for a
    // source a later phase will own. Reaching a source THIS slice owns
    // through it produces an entry with no reason, no original to mirror or
    // no persisted draft -- which is why the database refuses it at COMMIT
    // too, whichever process wrote the row. Here the caller learns at the
    // call rather than at the commit, and learns which command they wanted.
    const o = await sharedOwner();
    for (const sourceType of ['manual_adjustment', 'reversal', 'opening_balance']) {
      const generic: PostingCommand = { ...command(o.membership), sourceType };
      let caught: unknown;
      try {
        await posting.post(o.membership, generic);
      } catch (e) {
        caught = e;
      }
      expect(caught, `${sourceType} was accepted by the generic path`).toBeInstanceOf(AccountingError);
      const safe = (caught as AccountingError).toSafeJSON();
      expect(safe.code).toBe('accounting.assertion_wrong_source');
      expect(safe.sourceType).toBe(sourceType);
    }
    // And nothing reached the ledger.
    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1`, [o.businessId]);
    expect(must(n.rows[0]).n).toBe(0);
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

    const o = await sharedOwner();
    const paths = ['/v1/accounting/entries', '/v1/accounting/post', '/v1/businesses/current/accounting/entries', '/v1/journal/entries'];
    for (const p of paths) {
      const r = await t.request.post(p).set('Authorization', `Bearer ${o.token}`).set('X-Business-Id', o.businessId).send({});
      expect(r.status, `${p} answered`).toBe(404);
    }
  });
});
