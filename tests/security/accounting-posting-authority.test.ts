import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';
import {
  appClient,
  assertionFor,
  post,
  postAs,
  refusal,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostCommand,
  type PostingFixture,
  must,
} from '../helpers/accounting-posting';

/**
 * MATRIX 3 — POSTING AUTHORITY (directive §55, §68, §69, §80).
 *
 * The premise of every case here is the one the threat model actually cares
 * about: the attacker HAS the `daftar_app` credential. They can open a
 * connection, set any GUC they like, name a real user, a real tenant and a
 * real business, and call the primitive as often as they want. What they do
 * not have is the accounting assertion secret.
 *
 * So these tests never borrow the schema owner and never borrow the internal
 * authority. They post the way production posts — as `daftar_app`, through
 * `accounting_post_entry`, carrying an assertion in `app.accounting_assertion`
 * — and every negative case is an attack that the real credential makes
 * available.
 *
 * A note on what "refused" means here. Each case asserts the SPECIFIC refusal,
 * not merely that something threw: a case that expected `assertion_replayed`
 * and silently started failing on `payload_invalid` would still be green while
 * proving nothing about replay.
 */

const SECRET = Buffer.from(ACCOUNTING_ASSERTION_KEY_B64, 'base64');
/** A kid whose key is installed and then retired, for the rotation case. */
const RETIRED_KID = 'retiredk';
const RETIRED_SECRET = Buffer.alloc(32, 0x5a);

let fx: PostingFixture;
let today: string;

/** Mint any eleven claims under any secret — the attacker's own forge. */
function forge(claims: readonly string[], secret: Buffer = SECRET, kid: string = ACCOUNTING_ASSERTION_KID): string {
  const signed = ['v1', kid, ...claims];
  return [...signed, createHmac('sha256', secret).update(signed.join('.'), 'utf8').digest('hex')].join('.');
}

/** Replace one component of a genuine assertion, leaving the signature alone. */
function swap(assertion: string, index: number, value: string): string {
  const p = assertion.split('.');
  p[index] = value;
  return p.join('.');
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'authority');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  const present = await ownerPool().query(`SELECT 1 FROM accounting_assertion_keys WHERE kid = $1`, [RETIRED_KID]);
  if (present.rowCount === 0) {
    await ownerPool().query(`SELECT accounting_assertion_key_install($1, $2)`, [RETIRED_KID, RETIRED_SECRET]);
  }
  await ownerPool().query(`SELECT accounting_assertion_key_retire($1)`, [RETIRED_KID]);
});

const cmd = (sourceId: string = randomUUID()): PostCommand => simpleCommand(fx, sourceId, today);

describe('no assertion is no authority (§18, §55)', () => {
  it('a stolen daftar_app credential with no assertion at all cannot post', async () => {
    const c = cmd();
    expect(await refusal(() => postAs(null, c))).toMatch(/assertion_missing/);
  });

  it('an empty assertion is not an assertion', async () => {
    expect(await refusal(() => postAs('', cmd()))).toMatch(/assertion_missing/);
  });

  it('setting every isolation GUC to a victim does not substitute for an assertion', async () => {
    const c = cmd();
    const message = await refusal(() =>
      postAs(null, c, {
        'app.tenant_id': fx.tenantId,
        'app.business_id': fx.businessId,
        'app.actor_user_id': fx.userId,
        'app.role': 'owner',
      }),
    );
    expect(message).toMatch(/assertion_missing/);
  });

  it('refuses a malformed assertion rather than guessing at its parts', async () => {
    for (const raw of ['garbage', 'v1.a.b', `${'x.'.repeat(12)}x`, forge(['a', 'b', 'c']).replace(/^v1\./, 'v2.')]) {
      expect(await refusal(() => postAs(raw, cmd()))).toMatch(/assertion_malformed/);
    }
  });
});

describe('the signature binds every claim (§14, §55)', () => {
  it('refuses an assertion signed with a secret the database does not hold', async () => {
    const c = cmd();
    const genuine = assertionFor(c, fx.userId).split('.');
    const forged = forge(genuine.slice(2, 11), Buffer.alloc(32, 0xab));
    expect(await refusal(() => postAs(forged, c))).toMatch(/assertion_invalid_signature/);
  });

  it('refuses a hand-edited signature', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const p = a.split('.');
    const flipped = swap(a, 11, (must(p[11])[0] === '0' ? '1' : '0') + must(p[11]).slice(1));
    expect(await refusal(() => postAs(flipped, c))).toMatch(/assertion_invalid_signature/);
    expect(await refusal(() => postAs(swap(a, 11, 'deadbeef'), c))).toMatch(/assertion_invalid_signature/);
  });

  it('refuses every single-claim swap made after minting', async () => {
    // One case per signed claim. If a future edit stopped covering a claim in
    // the HMAC, exactly one of these would start passing.
    const replacements: ReadonlyArray<readonly [number, string, string]> = [
      [2, 'actor', fx.otherUserId],
      [3, 'tenant', fx.otherTenantId],
      [4, 'business', fx.otherBusinessId],
      [5, 'operation', 'reverse'],
      [6, 'source type', 'opening_balance'],
      [7, 'source id', randomUUID()],
      [8, 'fingerprint', 'f'.repeat(64)],
      [9, 'expiry', String(Math.floor(Date.now() / 1000) + 86400)],
      [10, 'jti', randomUUID()],
    ];
    for (const [index, what, value] of replacements) {
      const c = cmd();
      const tampered = swap(assertionFor(c, fx.userId), index, value);
      expect(await refusal(() => postAs(tampered, c)), `swapping the ${what} was accepted`).toMatch(/assertion_invalid_signature/);
    }
  });
});

describe('key identity and lifetime (§16, §17)', () => {
  it('refuses an assertion naming a key id the registry does not carry', async () => {
    const c = cmd();
    const genuine = assertionFor(c, fx.userId).split('.');
    expect(await refusal(() => postAs(forge(genuine.slice(2, 11), SECRET, 'nosuchkid'), c))).toMatch(/assertion_key_unknown/);
  });

  it('refuses an assertion minted under a RETIRED key, however valid its signature', async () => {
    const c = cmd();
    const genuine = assertionFor(c, fx.userId).split('.');
    const underRetired = forge(genuine.slice(2, 11), RETIRED_SECRET, RETIRED_KID);
    expect(await refusal(() => postAs(underRetired, c))).toMatch(/assertion_key_unknown/);
  });

  it('refuses an expired assertion', async () => {
    const c = cmd();
    const stale = assertionFor(c, fx.userId, { mintedAt: new Date(Date.now() - 3_600_000) });
    expect(await refusal(() => postAs(stale, c))).toMatch(/assertion_expired/);
  });

  it('refuses an assertion minted for an operation other than posting', async () => {
    const c = cmd();
    const genuine = assertionFor(c, fx.userId).split('.');
    const claims = [...genuine.slice(2, 11)];
    claims[3] = 'reverse';
    expect(await refusal(() => postAs(forge(claims), c))).toMatch(/assertion_wrong_operation/);
  });
});

describe('replay (§17)', () => {
  it('refuses the same assertion in a LATER transaction', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const first = await postAs(a, c);
    expect(first.created).toBe(true);
    expect(await refusal(() => postAs(a, c))).toMatch(/assertion_replayed/);
  });

  it('accepts the same assertion twice inside ONE transaction — composition is not replay', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const client = await appClient();
    try {
      await client.query('BEGIN');
      const first = await postAs(a, c, {}, client);
      const second = await postAs(a, c, {}, client);
      await client.query('COMMIT');
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.entryId).toBe(first.entryId);
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('a rolled-back transaction leaves the jti spent, so the retry needs a fresh assertion', async () => {
    // The replay registry is written by the verifier and rolls back with
    // everything else, so the SAME assertion is usable again after a rollback
    // — what must not happen is that the rolled-back posting survives.
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const client = await appClient();
    try {
      await client.query('BEGIN');
      await postAs(a, c, {}, client);
      await client.query('ROLLBACK');
    } finally {
      await client.end().catch(() => undefined);
    }
    const rows = await ownerPool().query(`SELECT 1 FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [fx.businessId, c.sourceId]);
    expect(rows.rowCount).toBe(0);
    const retry = await postAs(a, c);
    expect(retry.created).toBe(true);
  });
});

describe('the payload is bound to the assertion (§27)', () => {
  it('refuses a payload whose amounts are not the amounts that were authorized', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const tampered: PostCommand = {
      ...c,
      lines: c.lines.map((l) => ({ ...l, baseAmountMinor: l.baseAmountMinor + 1n, txnAmountMinor: l.txnAmountMinor + 1n })),
    };
    expect(await refusal(() => postAs(a, tampered))).toMatch(/assertion_payload_mismatch/);
  });

  it('refuses a payload whose accounts are not the accounts that were authorized', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const swapped: PostCommand = {
      ...c,
      lines: [{ ...must(c.lines[0]), account: { kind: 'system', systemKey: 'bank' } }, must(c.lines[1])],
    };
    expect(await refusal(() => postAs(a, swapped))).toMatch(/assertion_payload_mismatch/);
  });

  it('refuses a payload whose entry date is not the date that was authorized', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    expect(await refusal(() => postAs(a, { ...c, entryDate: '2026-01-01' }))).toMatch(/assertion_payload_mismatch/);
  });

  it('refuses a payload whose dimensions are not the dimensions that were authorized', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const moved: PostCommand = { ...c, lines: [{ ...must(c.lines[0]), branchId: fx.branchId }, must(c.lines[1])] };
    expect(await refusal(() => postAs(a, moved))).toMatch(/assertion_payload_mismatch/);
  });

  it('accepts a payload whose NARRATIVE differs — description and request id are not financial truth (§28)', async () => {
    const c = cmd();
    const a = assertionFor(c, fx.userId);
    const reworded: PostCommand = { ...c, description: 'a completely different narrative', requestId: 'req-other' };
    const r = await postAs(a, reworded);
    expect(r.created).toBe(true);
    const row = await ownerPool().query<{ description: string }>(`SELECT description FROM journal_entries WHERE business_id = $1 AND id = $2`, [
      fx.businessId,
      r.entryId,
    ]);
    expect(must(row.rows[0]).description).toBe('a completely different narrative');
  });
});

describe('tenancy comes from the assertion, never from the caller (§18, §55)', () => {
  it("cannot spend another business's genuine assertion against this business's chart", async () => {
    // The attacker legitimately holds an assertion for their OWN business and
    // tries to spend it against the victim's. Every identity the primitive
    // uses comes from the assertion, so the accounts are resolved in the
    // attacker's chart — where the victim's custom account does not exist.
    await ownerPool().query(`INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1, $2, 'V-9001', 'Victim Only', 'asset')`, [
      fx.tenantId,
      fx.businessId,
    ]);
    const victim: PostCommand = {
      ...cmd(),
      lines: [{ ...must(cmd().lines[0]), account: { kind: 'code', code: 'V-9001' } }, must(cmd().lines[1])],
    };
    const attackers = assertionFor({ ...victim, tenantId: fx.otherTenantId, businessId: fx.otherBusinessId }, fx.otherUserId);
    expect(await refusal(() => postAs(attackers, victim))).toMatch(/account_not_found/);
    const leaked = await ownerPool().query(`SELECT 1 FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [fx.businessId, victim.sourceId]);
    expect(leaked.rowCount).toBe(0);
  });

  it("confines an assertion's effect to the business it names, never the one the payload came from", async () => {
    // Even when the two charts agree — both businesses have `cash` and
    // `opening_equity` — the entry lands in the ASSERTION's business, and the
    // victim's ledger is untouched.
    const shape = cmd();
    const attackers = assertionFor({ ...shape, tenantId: fx.otherTenantId, businessId: fx.otherBusinessId }, fx.otherUserId);
    const r = await postAs(attackers, shape);
    const landed = await ownerPool().query<{ business_id: string }>(`SELECT business_id FROM journal_entries WHERE id = $1`, [r.entryId]);
    expect(must(landed.rows[0]).business_id).toBe(fx.otherBusinessId);
    const victimSide = await ownerPool().query(`SELECT 1 FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [fx.businessId, shape.sourceId]);
    expect(victimSide.rowCount).toBe(0);
  });

  it('refuses an assertion pairing a real business with a tenant that does not own it', async () => {
    const c = cmd();
    const mismatched = assertionFor({ ...c, tenantId: fx.otherTenantId }, fx.userId);
    // The fingerprint is computed over the assertion's own tenant, so this is
    // a genuine, self-consistent assertion — and still refused, because the
    // pairing is a lie about the world.
    const message = await refusal(() => postAs(mismatched, { ...c, tenantId: fx.otherTenantId }));
    expect(message).toMatch(/accounting\.forbidden/);
    expect(message).toMatch(/tenant does not own/);
  });

  it('refuses an assertion naming a business that does not exist', async () => {
    const ghost = randomUUID();
    const c = { ...cmd(), businessId: ghost };
    const a = assertionFor(c, fx.userId);
    expect(await refusal(() => postAs(a, c))).toMatch(/accounting\.forbidden/);
  });

  it('writes into the assertion’s business even when every GUC names the victim', async () => {
    const own: PostCommand = { ...cmd(), tenantId: fx.otherTenantId, businessId: fx.otherBusinessId };
    const a = assertionFor(own, fx.otherUserId);
    const r = await postAs(a, own, {
      'app.tenant_id': fx.tenantId,
      'app.business_id': fx.businessId,
      'app.actor_user_id': fx.userId,
    });
    expect(r.created).toBe(true);
    const where = await ownerPool().query<{ business_id: string; actor_user_id: string }>(
      `SELECT business_id, actor_user_id FROM journal_entries WHERE id = $1`,
      [r.entryId],
    );
    expect(must(where.rows[0]).business_id).toBe(fx.otherBusinessId);
    expect(must(where.rows[0]).actor_user_id).toBe(fx.otherUserId);
  });
});

describe('the live privilege surface (§68, §69)', () => {
  const ROLE_URLS: Readonly<Record<string, string>> = {
    daftar_platform: platformDbUrl,
    daftar_worker: workerDbUrl,
    daftar_identity: identityDbUrl,
    daftar_resolver: resolverDbUrl,
    daftar_provisioner: provisionerDbUrl,
  };

  const asRole = async (url: string, sql: string, params: unknown[] = []): Promise<string> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql, params);
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  it('grants EXECUTE on the posting primitive to daftar_app and to nobody else', async () => {
    const r = await ownerPool().query<{ role: string; allowed: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'accounting_post_entry(date,text,text,jsonb)', 'EXECUTE') AS allowed
       FROM unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_migrator']) r`,
    );
    const allowed = r.rows.filter((x) => x.allowed).map((x) => x.role);
    expect(allowed).toEqual(['daftar_app']);
  });

  it('refuses the primitive to a platform credential, in practice and not only on paper', async () => {
    const message = await asRole(platformDbUrl, `SELECT accounting_post_entry(current_date, null, null, '[]'::jsonb)`);
    expect(message).toMatch(/permission denied for function accounting_post_entry/);
  });

  it('refuses the primitive to every other runtime role', async () => {
    for (const [role, url] of Object.entries(ROLE_URLS)) {
      const message = await asRole(url, `SELECT accounting_post_entry(current_date, null, null, '[]'::jsonb)`);
      expect(message, `${role} reached the primitive`).toMatch(/permission denied for function accounting_post_entry/);
    }
  });

  it('exposes the verifier to no runtime role at all — it is an internal, not an API', async () => {
    const r = await ownerPool().query<{ role: string; allowed: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'accounting_actor(text[])', 'EXECUTE') AS allowed
       FROM unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner']) r`,
    );
    expect(r.rows.filter((x) => x.allowed)).toEqual([]);
    const message = await asRole(appDbUrl, `SELECT accounting_actor(ARRAY['post'])`);
    expect(message).toMatch(/permission denied for function accounting_actor/);
  });

  it('lets no runtime role read key material, not even the one that posts (§58)', async () => {
    for (const [role, url] of Object.entries({ daftar_app: appDbUrl, ...ROLE_URLS })) {
      const message = await asRole(url, `SELECT secret FROM accounting_assertion_keys`);
      expect(message, `${role} could read an accounting secret`).toMatch(/permission denied for table accounting_assertion_keys/);
    }
  });

  it('lets no runtime role read or forge a replay record', async () => {
    expect(await asRole(appDbUrl, `SELECT jti FROM accounting_assertion_uses`)).toMatch(/permission denied for table accounting_assertion_uses/);
    expect(await asRole(appDbUrl, `DELETE FROM accounting_assertion_uses`)).toMatch(/permission denied for table accounting_assertion_uses/);
  });

  it('lets only the platform credential install or retire a key, and never read one back', async () => {
    expect(await asRole(appDbUrl, `SELECT accounting_assertion_key_install('x1', $1)`, [Buffer.alloc(32, 1)])).toMatch(
      /permission denied for function accounting_assertion_key_install/,
    );
    expect(await asRole(appDbUrl, `SELECT accounting_assertion_key_retire('x1')`)).toMatch(/permission denied for function accounting_assertion_key_retire/);
    expect(await asRole(platformDbUrl, `SELECT secret FROM accounting_assertion_keys`)).toMatch(/permission denied for table accounting_assertion_keys/);
  });

  it('still grants no runtime role direct journal DML, now that a writer exists (§69)', async () => {
    const r = await ownerPool().query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_name IN ('journal_entries','journal_lines','accounting_source_bindings')
         AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
         AND grantee IN ('daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','PUBLIC')`,
    );
    expect(r.rows).toEqual([]);
    const message = await asRole(
      appDbUrl,
      `INSERT INTO journal_entries (tenant_id, business_id, entry_date, source_type, source_id, actor_kind, actor_user_id, posting_fingerprint)
       VALUES ($1, $2, current_date, 'manual_adjustment', gen_random_uuid(), 'user', $3, repeat('a', 64))`,
      [fx.tenantId, fx.businessId, fx.userId],
    );
    expect(message).toMatch(/permission denied for table journal_entries/);
  });

  it('gives the internal authority INSERT and nothing beyond it (§33)', async () => {
    // SELECT is 0042's, for the commit-time validator; INSERT is this slice's.
    // What must never appear is a privilege that could rewrite posted truth.
    const r = await ownerPool().query<{ table_name: string; privileges: string }>(
      `SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants
       WHERE grantee = 'daftar_accounting_internal'
         AND table_name IN ('journal_entries','journal_lines','accounting_source_bindings')
       GROUP BY table_name ORDER BY table_name`,
    );
    expect(r.rows).toEqual([
      { table_name: 'accounting_source_bindings', privileges: 'INSERT,SELECT' },
      { table_name: 'journal_entries', privileges: 'INSERT,SELECT' },
      { table_name: 'journal_lines', privileges: 'INSERT,SELECT' },
    ]);
  });

  it('keeps the posting authority unreachable: NOLOGIN, NOBYPASSRLS, NOSUPERUSER, no CREATE (§15)', async () => {
    const r = await ownerPool().query<{ rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean; can_create: boolean }>(
      `SELECT rolcanlogin, rolbypassrls, rolsuper, has_schema_privilege('daftar_accounting_internal','public','CREATE') AS can_create
       FROM pg_authid WHERE rolname = 'daftar_accounting_internal'`,
    );
    expect(r.rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false, can_create: false });
  });

  it('leaves app_bypass() exempting exactly the principal Phase 1 named (§3)', async () => {
    // 0052 replaced the body with a SQL-standard one — a parse tree rather
    // than text — so the deparsed form reads `CURRENT_USER = 'daftar_platform'
    // ::name` where Phase 1 wrote `current_user = 'daftar_platform'`. The same
    // comparison against the same role: `current_user` HAS type `name`, so the
    // cast is what the original always meant. What this case is for is the
    // principal, so it asks about the principal and not about the spelling.
    const r = await ownerPool().query<{ def: string }>(`SELECT pg_get_functiondef('app_bypass()'::regprocedure) AS def`);
    expect(must(r.rows[0]).def.toLowerCase()).toContain("current_user = 'daftar_platform'");
    expect(must(r.rows[0]).def).not.toContain('daftar_accounting_internal');
    // …and no other DAFTAR principal joined it.
    expect([...new Set(must(r.rows[0]).def.match(/daftar_[a-z_]+/g) ?? [])]).toEqual(['daftar_platform']);
  });
});

describe('the posting path is the only path (§32)', () => {
  it('a successful post writes exactly one audit row and one outbox row, carrying no money (§35, §36)', async () => {
    const c = cmd();
    const r = await post(c, fx.userId);
    const audit = await ownerPool().query<{ metadata: Record<string, unknown>; action: string }>(
      `SELECT action, metadata FROM audit_events WHERE entity = 'journal_entry' AND entity_id = $1`,
      [r.entryId],
    );
    expect(audit.rowCount).toBe(1);
    expect(must(audit.rows[0]).action).toBe('accounting.entry_posted');
    expect(Object.keys(must(audit.rows[0]).metadata).sort()).toEqual(['sourceId', 'sourceType']);

    const outbox = await ownerPool().query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM outbox_events WHERE payload->>'entryId' = $1`,
      [r.entryId],
    );
    expect(outbox.rowCount).toBe(1);
    expect(must(outbox.rows[0]).type).toBe('accounting.entry.posted');
    expect(Object.keys(must(outbox.rows[0]).payload).sort()).toEqual(['businessId', 'entryId', 'sourceId', 'sourceType']);
    expect(JSON.stringify(must(outbox.rows[0]).payload)).not.toMatch(/amount|minor|debit|credit|balance|rate/i);
  });

  it('never leaks an amount, a balance or key material in a refusal message (§78)', async () => {
    const c = cmd();
    const messages = [
      await refusal(() => postAs(null, c)),
      await refusal(() =>
        postAs(assertionFor(c, fx.userId), { ...c, lines: c.lines.map((l) => ({ ...l, baseAmountMinor: 999999n, txnAmountMinor: 999999n })) }),
      ),
    ];
    for (const m of messages) {
      expect(m).not.toContain('999999');
      expect(m).not.toContain(ACCOUNTING_ASSERTION_KEY_B64);
      expect(m).not.toMatch(/balance is|current balance/i);
    }
  });
});
