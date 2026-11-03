import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  post,
  postAdjustmentAs,
  postOpeningBalanceAs,
  postReversalAs,
  refusal,
  reversalFingerprintOf,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';
import { readInheritedHead } from '../helpers/phase4-inherited-scope';

/**
 * MATRIX — P2-S4 SOURCE AUTHORITY (directive §16-§21, §38, §39, §53).
 *
 * Same premise as MATRIX 3: the attacker HOLDS the `daftar_app` credential.
 * What they do not hold is the assertion secret, so every case here asks a
 * narrower question — given a GENUINE assertion, minted for something the
 * holder was genuinely entitled to, what else can it be made to do?
 *
 * The answer must be: nothing. An assertion authorizes one operation kind,
 * over one source type, for one source id, in one business, by one actor —
 * and each of those five is proved separately below, because a binding that
 * held four of them would be a bypass in the fifth.
 */

let fx: PostingFixture;
let today: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'src-authority');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

const cmd = (sourceId: string = randomUUID(), sourceType = 'manual_adjustment'): PostCommand => simpleCommand(fx, sourceId, today, 150000n, sourceType);

const FINGERPRINT_SHAPED = 'a'.repeat(64);

interface MintClaims {
  actorUserId: string;
  tenantId: string;
  businessId: string;
  operationKind: 'post' | 'reverse';
  sourceType: string;
  sourceId: string;
  postingFingerprint: string;
}

const claimsFor = (c: PostCommand): MintClaims => ({
  actorUserId: fx.userId,
  tenantId: c.tenantId,
  businessId: c.businessId,
  operationKind: 'post',
  sourceType: c.sourceType,
  sourceId: c.sourceId,
  postingFingerprint: fingerprintOf(c),
});

// ── §39 the five bindings ─────────────────────────────────────────────────

describe('an assertion is bound to every claim it names (§38, §39)', () => {
  it('a post assertion cannot drive the reversal writer', async () => {
    const c = cmd();
    const original = await post(c, fx.userId);
    // Genuinely minted, genuinely entitled — for POSTING. The holder now
    // points it at the reversal writer.
    const posty = sourceAssertion({
      ...claimsFor(c),
      operationKind: 'post',
      sourceType: 'reversal',
      sourceId: original.entryId,
      postingFingerprint: reversalFingerprintOf(c, original.entryId, today),
    });
    expect(await refusal(() => postReversalAs(posty, original.entryId, today, 'wrong kind', randomUUID()))).toMatch(/assertion_wrong_operation/);
  });

  it('a reverse assertion cannot drive the adjustment writer, or the primitive', async () => {
    const c = cmd();
    const reversey = sourceAssertion({ ...claimsFor(c), operationKind: 'reverse' });
    expect(await refusal(() => postAdjustmentAs(reversey, c, 'wrong kind'))).toMatch(/assertion_wrong_operation/);

    const conn = await appClient();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [reversey]);
      await expect(conn.query(`SELECT entry_id FROM accounting_post_entry($1::date, 'x', null, $2::jsonb)`, [c.entryDate, JSON.stringify([])])).rejects.toThrow(
        /assertion_wrong_operation/,
      );
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
  });

  it('an operation kind is tightly paired with ONE source type, as data', async () => {
    // `reverse` owns `reversal` and nothing else; `post` owns the other two
    // native types and, since 0061 (P3-S3, contract A-14(e)), the two
    // inventory source types. The pairing is a table, so it is provable by
    // reading it. P3-S4 (0063/0064, contract A-05): `post` also owns the two
    // purchase-side source types, and nothing else was added. P3-S5
    // (0065/0066, contract A-05): `post` also owns `supplier_return`; R-B2a
    // registers no accounting `purchase_reversal` (its fact is a `reversal`).
    // P3-S6 (0067/0068, contract A-05): `post` also owns the three supplier
    // settlement source types, in sort position; nothing else was added.
    // Phase 3 corrective (0072, TD-16): `post` also owns
    // `purchase_residue_write_off`, in sort position; nothing else was added.
    /**
     * ── P4-AL-88 ─────────────────────────────────────────────────────────
     *
     * This was an exact equality over the WHOLE of
     * `accounting_operation_kinds`, which made it a claim about every phase
     * that follows: registering a source type and pairing it with an
     * operation kind is precisely what a later phase's migration does, and
     * `0077` registers `('post','sale')` and `('post','invoice')`. An
     * accepted P2-S4 matrix therefore went red for the registry doing its job
     * (`[[daftar-a-closure-rule-is-not-an-invariant]]`).
     *
     * Unlike `inventory_operation_kinds`, this registry carries NO provenance
     * column (`0046:86-93`), and neither does `accounting_source_types`
     * (`0042:51-57`) — so the `registered_by ~ '^P3-'` idiom is not available
     * here. The scope is the other one the estate already owns
     * (`tests/security/phase3-s8-signed-authority-matrix.test.ts:262`): a
     * database built to the ACCEPTED PHASE 3 HEAD
     * (`PHASE4_INHERITED_PREFIX_END`, frozen byte for byte by P4-AL-85, so no
     * later phase can enter it), read as data. The twelve pairs below are
     * claimed against it EXACTLY and word for word, and a pair the accepted
     * head registered that has since VANISHED is named too.
     *
     * The later phases' half is claimed SEPARATELY AND POSITIVELY, with the
     * property this case is actually about — tight pairing: every pair beyond
     * the accepted head names a source type registered in
     * `accounting_source_types`, and across BOTH scopes no source type is
     * owned by two operation kinds, which is the "one owner per source
     * identity" UNIQUE stated as a claim rather than trusted. A CLOSURE
     * assertion states that the two scopes together are the whole live
     * registry.
     */
    const atHead = await readInheritedHead(async (q) =>
      (
        await q.query<{ operation_kind: string; source_type: string }>(
          `SELECT operation_kind, source_type FROM accounting_operation_kinds ORDER BY operation_kind, source_type`,
        )
      ).rows.map((r) => ({ operation_kind: r.operation_kind, source_type: r.source_type })),
    );
    const key = (r: { operation_kind: string; source_type: string }): string => `${r.operation_kind}:${r.source_type}`;
    const live = (
      await ownerPool().query<{ operation_kind: string; source_type: string }>(
        `SELECT operation_kind, source_type FROM accounting_operation_kinds ORDER BY operation_kind, source_type`,
      )
    ).rows;
    const headKeys = atHead.map(key);
    const liveKeys = live.map(key);
    expect(
      headKeys.filter((k) => !liveKeys.includes(k)),
      'no pair the accepted head registered has been removed',
    ).toEqual([]);
    const beyond = liveKeys.filter((k) => !headKeys.includes(k));
    expect([...headKeys, ...beyond].sort(), 'and the two scopes together are the whole live registry').toEqual([...liveKeys].sort());
    const registeredTypes = new Set(
      (await ownerPool().query<{ t: string }>(`SELECT source_type::text AS t FROM accounting_source_types`)).rows.map((x) => x.t),
    );
    expect(
      beyond.filter((k) => !registeredTypes.has(k.slice(k.indexOf(':') + 1))),
      'a pair beyond the accepted head names a registered accounting source type',
    ).toEqual([]);
    const owners = new Map<string, string[]>();
    for (const r of live) owners.set(r.source_type, [...(owners.get(r.source_type) ?? []), r.operation_kind]);
    expect(
      [...owners].filter(([, kinds]) => kinds.length !== 1).map(([t, kinds]) => `${t}: ${kinds.join(',')}`),
      'every source type, in either scope, is owned by exactly one operation kind',
    ).toEqual([]);
    expect(atHead).toEqual([
      { operation_kind: 'post', source_type: 'inventory_adjustment' },
      { operation_kind: 'post', source_type: 'inventory_opening' },
      { operation_kind: 'post', source_type: 'manual_adjustment' },
      // P3-S4 (0063/0064)
      { operation_kind: 'post', source_type: 'negative_inventory_cost_adjustment' },
      { operation_kind: 'post', source_type: 'opening_balance' },
      // P3-S4 (0063/0064)
      { operation_kind: 'post', source_type: 'purchase' },
      // Phase 3 corrective (0072)
      { operation_kind: 'post', source_type: 'purchase_residue_write_off' },
      // P3-S6 (0067/0068)
      { operation_kind: 'post', source_type: 'supplier_credit_allocation' },
      { operation_kind: 'post', source_type: 'supplier_payment' },
      { operation_kind: 'post', source_type: 'supplier_refund' },
      // P3-S5 (0065/0066)
      { operation_kind: 'post', source_type: 'supplier_return' },
      { operation_kind: 'reverse', source_type: 'reversal' },
    ]);

    // A `reverse` assertion naming a source type it does not own is refused
    // by the pairing, not by a branch on a hardcoded name.
    const c = cmd();
    const original = await post(c, fx.userId);
    const mismatched = sourceAssertion({
      ...claimsFor(c),
      operationKind: 'reverse',
      sourceType: 'manual_adjustment',
      sourceId: original.entryId,
      postingFingerprint: FINGERPRINT_SHAPED,
    });
    expect(await refusal(() => postReversalAs(mismatched, original.entryId, today, 'mismatched pairing', randomUUID()))).toMatch(/assertion_wrong_source/);
  });

  it('a source type cannot be swapped after minting', async () => {
    const c = cmd();
    // Minted for `manual_adjustment`; presented to the opening-balance
    // workflow, whose source type is different.
    const wrongType = sourceAssertion({ ...claimsFor(c), sourceType: 'manual_adjustment', sourceId: randomUUID() });
    const refused = await refusal(() =>
      postOpeningBalanceAs(wrongType, { asOfDate: today, positions: c.lines, openingBalanceId: randomUUID(), requestId: randomUUID() }),
    );
    expect(refused).toMatch(/assertion_wrong_source|assertion_payload_mismatch/);
  });

  it('a source id cannot be swapped after minting — there is no argument for one', async () => {
    const c = cmd();
    // The strongest form of this binding is structural: no writer takes a
    // source id as a parameter. The financial identity comes from the signed
    // assertion and from nowhere else, so a caller has nothing to swap.
    const args = await ownerPool().query<{ name: string; args: string }>(
      `SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('accounting_post_entry','accounting_post_manual_adjustment')`,
    );
    for (const row of args.rows) expect(row.args, row.name).not.toMatch(/source_id|source_type/);

    // And the one place it IS stated — the assertion — is signed, so editing
    // that component breaks the signature rather than redirecting the post.
    const genuine = sourceAssertion(claimsFor(c));
    const parts = genuine.split('.');
    const sourceIdIndex = parts.findIndex((part) => part === c.sourceId);
    expect(sourceIdIndex).toBeGreaterThan(0);
    parts[sourceIdIndex] = randomUUID();
    expect(await refusal(() => postAdjustmentAs(parts.join('.'), c, 'swapped id'))).toMatch(/assertion_invalid_signature/);
  });

  it('a business cannot be swapped after minting', async () => {
    const c = cmd();
    const foreign = sourceAssertion({ ...claimsFor(c), businessId: fx.otherBusinessId, tenantId: fx.otherTenantId });
    // The assertion names another business; the lines name accounts of this
    // one. Either way the caller never reaches this business's ledger.
    expect(await refusal(() => postAdjustmentAs(foreign, c, 'swapped business'))).toMatch(
      /assertion_payload_mismatch|account_not_found|account_foreign_business/,
    );
  });

  it('an actor cannot be swapped after minting', async () => {
    const c = cmd();
    const asOther = sourceAssertion({ ...claimsFor(c), actorUserId: fx.otherUserId });
    const out = await postAdjustmentAs(asOther, c, 'whose adjustment');
    // The entry and the detail row both record the SIGNED actor, never a GUC
    // the caller set: an attacker cannot post in someone else's name by
    // claiming it, only by holding their assertion.
    const head = await ownerPool().query<{ actor_user_id: string }>(
      `SELECT actor_user_id::text AS actor_user_id FROM journal_entries WHERE business_id = $1 AND id = $2`,
      [fx.businessId, out.entryId],
    );
    expect(must(head.rows[0]).actor_user_id).toBe(fx.otherUserId);

    const detail = await ownerPool().query<{ actor_user_id: string }>(
      `SELECT actor_user_id::text AS actor_user_id FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2`,
      [fx.businessId, c.sourceId],
    );
    expect(must(detail.rows[0]).actor_user_id).toBe(fx.otherUserId);
  });

  it('a spoofed GUC changes nothing about who posted or where', async () => {
    const c = cmd();
    const genuine = sourceAssertion(claimsFor(c));
    const conn = await appClient();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [genuine]);
      for (const [k, v] of Object.entries({
        'app.business_id': fx.otherBusinessId,
        'app.tenant_id': fx.otherTenantId,
        'app.user_id': fx.otherUserId,
      })) {
        await conn.query(`SELECT set_config($1, $2, true)`, [k, v]);
      }
      const r = await conn.query<{ entry_id: string }>(`SELECT entry_id FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`, [
        c.entryDate,
        'spoofed gucs',
        'spoof test',
        null,
        JSON.stringify(
          c.lines.map((l) => ({
            account: l.account.kind === 'system' ? { kind: 'system', system_key: l.account.systemKey } : { kind: 'code', code: l.account.code },
            side: l.side,
            base_amount_minor: l.baseAmountMinor.toString(),
            base_currency: l.baseCurrency,
            txn_amount_minor: l.txnAmountMinor.toString(),
            txn_currency: l.txnCurrency,
            fx_rate: '1.0000000000',
            fx_rate_source: l.fxRateSource,
            fx_rate_at: `${l.fxRateAt.toISOString().slice(0, 19)}Z`,
            branch_id: null,
            warehouse_id: null,
            memo: null,
          })),
        ),
      ]);
      await conn.query('COMMIT');
      const entryId = must(r.rows[0]).entry_id;
      const head = await ownerPool().query<{ business_id: string; actor_user_id: string }>(
        `SELECT business_id::text AS business_id, actor_user_id::text AS actor_user_id FROM journal_entries WHERE id = $1`,
        [entryId],
      );
      expect(must(head.rows[0]).business_id).toBe(fx.businessId);
      expect(must(head.rows[0]).actor_user_id).toBe(fx.userId);
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
  });
});

// ── §38 no trusted path ───────────────────────────────────────────────────

describe('there is no trusted path and no "allow inactive" flag (§38)', () => {
  it('neither writer offers a bypass parameter', async () => {
    const args = await ownerPool().query<{ name: string; args: string }>(
      `SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('accounting_post_entry','accounting_post_reversal','accounting_post_manual_adjustment',
                            'accounting_open_balance_draft','accounting_open_balance_edit','accounting_open_balance_discard',
                            'accounting_open_balance_post','accounting_open_balance_supersede')`,
    );
    expect(args.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of args.rows) {
      expect(row.args, row.name).not.toMatch(/trusted|skip|bypass|force|allow_inactive|system_post|raw|unsafe|override/i);
    }
  });

  it('no routine named like a bypass exists at all', async () => {
    const r = await ownerPool().query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.proname ~* '(post_?trusted|skip_?permission|system_?post|raw_?write|force_?post|unsafe)')`,
    );
    expect(r.rows.map((x) => x.name)).toEqual([]);
  });

  it('the inactive-account rule holds for ordinary posting even though a reversal may mirror one', async () => {
    // The ONE relaxation P2-S4 introduces is scoped to mirroring a persisted
    // original, and this is the case that proves it did not leak into the
    // ordinary path (§15, §38).
    const code = `SEC${Date.now() % 100000}`;
    await ownerPool().query(`INSERT INTO accounts (tenant_id, business_id, code, name, type, is_active) VALUES ($1,$2,$3,$4,'asset',false)`, [
      fx.tenantId,
      fx.businessId,
      code,
      'Retired',
    ]);
    const c = cmd();
    must(c.lines[0]).account = { kind: 'code', code };
    expect(await refusal(() => postAdjustmentAs(sourceAssertion(claimsFor(c)), c, 'inactive'))).toMatch(/account_inactive/);
    expect(await refusal(() => post(c, fx.userId))).toMatch(/account_inactive/);
  });
});

// ── §21 / §45 the writers themselves ──────────────────────────────────────

describe('every journal writer carries the same protections (§21, §45)', () => {
  it('exactly two routines can write the journal, both SECURITY DEFINER, both owned by the internal authority', async () => {
    const r = await ownerPool().query<{ name: string; secdef: boolean; owner: string; config: string[] | null }>(
      `SELECT p.proname AS name, p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('accounting_post_entry','accounting_post_reversal')
        ORDER BY p.proname`,
    );
    expect(r.rows.map((x) => x.name)).toEqual(['accounting_post_entry', 'accounting_post_reversal']);
    for (const row of r.rows) {
      expect(row.secdef, row.name).toBe(true);
      expect(row.owner, row.name).toBe('daftar_accounting_internal');
      // §45: pinned path, pg_temp explicit and LAST.
      expect(must(row.config, row.name).join(','), row.name).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });

  it('every SECURITY DEFINER routine in the accounting surface pins its path with pg_temp last', async () => {
    const r = await ownerPool().query<{ name: string; config: string[] | null }>(
      `SELECT p.proname AS name, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef AND p.proname LIKE 'accounting%'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      const setting = must(row.config, row.name).find((c) => c.startsWith('search_path='));
      const schemas = must(setting, `${row.name} search_path`)
        .slice('search_path='.length)
        .split(',')
        .map((x) => x.trim());
      // G-5's rule exactly: pg_temp NAMED, and named LAST. PostgreSQL
      // searches it first when it is not named, so "somewhere in the string"
      // is not the property — its position is.
      expect(schemas.at(-1), row.name).toBe('pg_temp');
      expect(
        schemas.filter((x) => x === 'pg_temp'),
        row.name,
      ).toHaveLength(1);
      expect(schemas, row.name).toContain('pg_catalog');
    }
  });

  it('only daftar_app may execute the runtime commands, and nobody else may execute the internals', async () => {
    const grants = async (routine: string): Promise<string[]> => {
      const r = await ownerPool().query<{ grantee: string }>(
        `SELECT DISTINCT grantee FROM information_schema.routine_privileges
          WHERE specific_schema = 'public' AND routine_name = $1 AND privilege_type = 'EXECUTE'
            AND grantee <> 'daftar_accounting_internal'
          ORDER BY grantee`,
        [routine],
      );
      return r.rows.map((x) => x.grantee);
    };
    for (const routine of [
      'accounting_post_entry',
      'accounting_post_reversal',
      'accounting_post_manual_adjustment',
      'accounting_open_balance_draft',
      'accounting_open_balance_edit',
      'accounting_open_balance_discard',
      'accounting_open_balance_post',
    ]) {
      expect(await grants(routine), routine).toEqual(['daftar_app']);
    }
    // Supersession is never a merchant command: it happens inside posting a
    // replacement, under the same authority, and is reachable from nowhere
    // else.
    expect(await grants('accounting_open_balance_supersede')).toEqual([]);
  });
});

// ── §23, §31 branch scope ─────────────────────────────────────────────────

describe('branch scope (§18, §31)', () => {
  it('an opening balance posts at business level, with no branch anywhere on it', async () => {
    const other = await seedPostingFixture(ownerPool(), `src-auth-ob-${Date.now()}`);
    const openingBalanceId = randomUUID();
    const positions = [
      {
        account: { kind: 'system' as const, systemKey: 'cash' },
        side: 'D' as const,
        baseAmountMinor: 25000n,
        baseCurrency: 'ILS',
        txnAmountMinor: 25000n,
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base' as const,
        fxRateAt: new Date('2026-03-14T09:15:00Z'),
        memo: null,
      },
    ];
    const assertion = sourceAssertion({
      actorUserId: other.userId,
      tenantId: other.tenantId,
      businessId: other.businessId,
      operationKind: 'post',
      sourceType: 'opening_balance',
      sourceId: openingBalanceId,
      postingFingerprint: openingBalanceFingerprintOf({
        tenantId: other.tenantId,
        businessId: other.businessId,
        openingBalanceId,
        asOfDate: today,
        baseCurrency: 'ILS',
        positions,
      }),
    });
    const out = await postOpeningBalanceAs(assertion, { asOfDate: today, positions, openingBalanceId, requestId: randomUUID() });
    const lines = await ownerPool().query<{ branch_id: string | null; warehouse_id: string | null }>(
      `SELECT branch_id, warehouse_id FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2`,
      [other.businessId, out.entryId],
    );
    for (const line of lines.rows) {
      expect(line.branch_id).toBeNull();
      expect(line.warehouse_id).toBeNull();
    }
    // §31: the opening-balance table carries no branch dimension at all, so
    // a branch-scoped opening balance is not merely refused — it is
    // unrepresentable.
    const cols = await ownerPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('accounting_opening_balances','accounting_opening_balance_lines')`,
    );
    for (const row of cols.rows) expect(row.column_name).not.toMatch(/branch|warehouse/);
  });
});
