import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountingAdjustmentCreateSchema } from '../../apps/api/src/modules/accounting/accounting.schemas';
import { SaleCommitSchema } from '../../apps/api/src/modules/selling/selling.schemas';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { refusalOf, runFilter, type CapturedRefusal } from '../helpers/validation-refusal';

/**
 * DR-71 section 3(b) — the validation refusal on the MONEY and PERMISSION paths
 * is stable under the ORDER and the NUMBER of problems in a request.
 *
 * `t10-zod-error-contract` pins the contract for catalog schemas (status, code,
 * `path`, no prose). This suite does not repeat that. It asks the question the
 * zod upgrade makes live on the paths where a wrong answer costs money or
 * grants access: when a request is wrong in 1, 3 or 9 ways, and the problems
 * arrive in any order, does the DECISION stay the same (refused, 400,
 * VALIDATION_FAILED) and does every broken FIELD still get named — while
 * `message` and `keys` (zod's prose and the attacker's key names) never leave
 * the process?
 *
 * Part 1 is pure: the real schemas, the real filter, every subset of defects,
 * every permutation of the lines, three key orderings. Part 2 is HTTP and adds
 * what a pure test cannot: that a refused money/permission request changed
 * NOTHING, and that an unauthorised caller gets 403 whatever the body holds
 * (a validation answer would hand a stranger the schema).
 *
 * WHAT WOULD MAKE A GREEN HERE VACUOUS (each is asserted, not hoped):
 *  - a base body the schema already refuses  -> `base accepted` below;
 *  - a defect that does not break what it claims -> the single-defect
 *    calibration names each defect's path ALONE before it is used in a combination;
 *  - an ordering dimension that never varies -> the suite asserts that the
 *    EMITTED ORDER differs across line permutations for at least one subset
 *    (zod walks the schema's shape, so key order alone does not change it —
 *    measured — which is why the lines are what is permuted);
 *  - a count dimension that never varies -> distinct problem counts >= 4;
 *  - HTTP cases that are refused by authentication instead of the schema
 *    -> each money/permission request first proves a schema-VALID body gets
 *    past the guards (not a 400 VALIDATION_FAILED).
 */

// ───────────────────────── the engine ─────────────────────────

type Body = Record<string, unknown>;

interface HeaderDefect {
  id: string;
  mutate: (b: Body) => void;
  /** Path the refusal must name. */
  path: string;
  code?: string;
  /** Strings that must never appear in the response (the bad value, a rejected key name). */
  secrets: string[];
}
interface LineDefect {
  id: string;
  mutate: (line: Body) => void;
  /** Path RELATIVE to the line ('' = the line object itself). */
  rel: string;
  code?: string;
  secrets: string[];
}
interface Suite {
  name: string;
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
  base: () => Body;
  linesKey: string;
  header: HeaderDefect[];
  lineDefects: LineDefect[];
  /** Paths a CROSS-FIELD rule may add on its own; allowed in a refusal, never required in a combination. */
  crossField: string[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

function subsets<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let m = 0; m < 1 << xs.length; m += 1) out.push(xs.filter((_, i) => (m >> i) & 1));
  return out;
}

/** Deterministic key reordering at every depth (arrays keep their order — that is what lines permutation is for). */
function reorderKeys(v: unknown, mode: 'schema' | 'reverse' | 'rotate'): unknown {
  if (Array.isArray(v)) return v.map((x) => reorderKeys(x, mode));
  if (v === null || typeof v !== 'object') return v;
  let keys = Object.keys(v as Body);
  if (mode === 'reverse') keys = keys.reverse();
  if (mode === 'rotate') keys = [...keys.slice(2), ...keys.slice(0, 2)];
  const out: Body = {};
  for (const k of keys) out[k] = reorderKeys((v as Body)[k], mode);
  return out;
}

interface Observation {
  captured: CapturedRefusal;
  issues: { path: string; code: string }[];
}

function observe(schema: Suite['schema'], body: unknown): Observation {
  const err = refusalOf(schema, body);
  if (err === null) throw new Error('the body was ACCEPTED — a refusal case that is not refused is vacuous');
  const captured = runFilter(err);
  return { captured, issues: captured.body.error.details?.issues ?? [] };
}

/** The contract every refusal must satisfy, whatever the defects. */
function assertContract(o: Observation, secrets: string[], label: string): void {
  expect(o.captured.status, label).toBe(400);
  expect(o.captured.body.error.code, label).toBe('VALIDATION_FAILED');
  expect(o.captured.body.error.message, `${label}: the message is the generic fallback and nothing else`).toBe('Validation failed');
  expect(typeof o.captured.body.error.requestId, label).toBe('string');
  for (const i of o.issues) expect(Object.keys(i).sort(), `${label}: an issue carries exactly path and code — no message, no keys`).toEqual(['code', 'path']);
  const wire = JSON.stringify(o.captured.body);
  for (const s of secrets) expect(wire, `${label}: "${s}" must not reach the client`).not.toContain(s);
  expect(wire, `${label}: no zod prose and no 'keys' member`).not.toMatch(
    /"keys"|"message":"(?!Validation failed)|Invalid input|Unrecognized key|expected|received/i,
  );
}

function exercise(s: Suite): { combos: number; counts: Set<number>; orderVaries: boolean } {
  // Calibration: the base is accepted, and every defect ALONE names the path it claims.
  expect(refusalOf(s.schema, s.base()), `${s.name}: base accepted`).toBeNull();
  for (const h of s.header) {
    const b = s.base();
    h.mutate(b);
    const o = observe(s.schema, b);
    expect(
      o.issues.map((i) => i.path),
      `${s.name}: header defect ${h.id} alone`,
    ).toContain(h.path);
    if (h.code) expect(o.issues.find((i) => i.path === h.path)?.code, `${s.name}: ${h.id} code`).toBe(h.code);
  }
  s.lineDefects.forEach((d) => {
    const b = s.base();
    d.mutate((b[s.linesKey] as Body[])[1] as Body);
    const o = observe(s.schema, b);
    const want = d.rel === '' ? 'lines.1' : `lines.1.${d.rel}`;
    expect(
      o.issues.map((i) => i.path),
      `${s.name}: line defect ${d.id} alone`,
    ).toContain(want);
    if (d.code) expect(o.issues.find((i) => i.path === want)?.code, `${s.name}: ${d.id} code`).toBe(d.code);
  });

  const counts = new Set<number>();
  let combos = 0;
  let orderVaries = false;
  const lineIdx = s.lineDefects.map((_, i) => i);
  for (const hs of subsets(s.header)) {
    for (const ls of subsets(lineIdx)) {
      if (hs.length === 0 && ls.length === 0) continue;
      const emitted = new Set<string>();
      let canonical: string | null = null;
      for (const perm of permutations(lineIdx)) {
        // perm[k] = which line DEFECT SLOT sits at array index k
        for (const mode of ['schema', 'reverse', 'rotate'] as const) {
          const b = s.base();
          for (const h of hs) h.mutate(b);
          const lines = b[s.linesKey] as Body[];
          const expectedPaths = hs.map((h) => h.path);
          const secrets = hs.flatMap((h) => h.secrets);
          perm.forEach((slot, idx) => {
            if (!ls.includes(slot)) return;
            const d = s.lineDefects[slot] as LineDefect;
            d.mutate(lines[idx] as Body);
            expectedPaths.push(d.rel === '' ? `lines.${idx}` : `lines.${idx}.${d.rel}`);
            secrets.push(...d.secrets);
          });
          const o = observe(s.schema, reorderKeys(b, mode));
          const label = `${s.name} hs=[${hs.map((h) => h.id)}] ls=[${ls}] perm=[${perm}] ${mode}`;
          assertContract(o, secrets, label);
          const got = o.issues.map((i) => i.path);
          for (const p of expectedPaths) expect(got, `${label}: every broken field is still named`).toContain(p);
          // No phantom field: a path nobody broke (a cross-field rule's own path is the only exception).
          for (const p of got) expect([...expectedPaths, ...s.crossField], `${label}: the refusal names a field nobody broke: ${p}`).toContain(p);
          // Normalise the line INDEX back to the defect SLOT that sits there, so the set can be compared across permutations.
          const norm = (path: string): string => path.replace(/^lines\.(\d+)/, (_m, n: string) => `lines.@${perm[Number(n)]}`);
          const set = [...new Set(o.issues.map((i) => `${norm(i.path)}|${i.code}`))].sort().join(';');
          if (canonical === null) canonical = set;
          expect(set, `${label}: the SET of (slot, code) is independent of line order and key order`).toBe(canonical);
          emitted.add(got.join(','));
          counts.add(o.issues.length);
          combos += 1;
        }
      }
      if (emitted.size > 1) orderVaries = true;
    }
  }
  return { combos, counts, orderVaries };
}

// ───────────────────────── Part 1: pure, the money schemas ─────────────────────────

const uuidN = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const sale: Suite = {
  name: 'SaleCommitSchema',
  schema: SaleCommitSchema,
  linesKey: 'lines',
  base: () => ({
    saleId: uuidN(1),
    settlementMode: 'cash',
    customerId: null,
    warehouseId: uuidN(2),
    documentDate: '2026-10-30',
    dueDate: null,
    taxMinor: '0',
    notes: null,
    lines: [10, 11, 12].map((n) => ({ lineId: uuidN(n), productId: uuidN(n + 100), variantId: null, quantity: '1', discountMinor: '0' })),
  }),
  header: [
    { id: 'saleId', mutate: (b) => (b['saleId'] = 'not-a-uuid-SECRET1'), path: 'saleId', secrets: ['not-a-uuid-SECRET1'] },
    { id: 'settlementMode', mutate: (b) => (b['settlementMode'] = 'barter-SECRET2'), path: 'settlementMode', secrets: ['barter-SECRET2'] },
    { id: 'documentDate', mutate: (b) => (b['documentDate'] = '2026-02-31'), path: 'documentDate', secrets: ['2026-02-31'] },
    { id: 'taxMinor', mutate: (b) => (b['taxMinor'] = '7777'), path: 'taxMinor', secrets: ['7777'] },
    { id: 'clientTotal', mutate: (b) => (b['totalMinor'] = '424242'), path: '', code: 'unrecognized_keys', secrets: ['totalMinor', '424242'] },
  ],
  lineDefects: [
    { id: 'negative quantity', mutate: (l) => (l['quantity'] = '-3-SECRET3'), rel: 'quantity', secrets: ['-3-SECRET3'] },
    { id: 'negative discount', mutate: (l) => (l['discountMinor'] = '-9-SECRET4'), rel: 'discountMinor', secrets: ['-9-SECRET4'] },
    { id: 'client price', mutate: (l) => (l['unitPrice'] = '0.01'), rel: '', code: 'unrecognized_keys', secrets: ['unitPrice', '0.01'] },
  ],
  crossField: ['customerId', 'dueDate', 'lines'],
};

const adjLine = (side: 'D' | 'C', n: number): Body => ({
  account: { kind: 'system', systemKey: n % 2 ? 'cash' : 'sales_revenue' },
  side,
  baseAmountMinor: '100',
  baseCurrency: 'ILS',
  txnAmountMinor: '100',
  txnCurrency: 'ILS',
  fxRate: '1',
  fxRateSource: 'base',
  fxRateAt: '2026-10-30T00:00:00Z',
});

const adjustment: Suite = {
  name: 'AccountingAdjustmentCreateSchema',
  schema: AccountingAdjustmentCreateSchema,
  linesKey: 'lines',
  base: () => ({ entryDate: '2026-10-30', description: 'fix', reason: 'correction', lines: [adjLine('D', 1), adjLine('C', 2), adjLine('C', 3)] }),
  header: [
    { id: 'entryDate', mutate: (b) => (b['entryDate'] = '2026-02-31'), path: 'entryDate', secrets: ['2026-02-31'] },
    { id: 'reason', mutate: (b) => (b['reason'] = '   '), path: 'reason', secrets: [] },
    { id: 'clientBalance', mutate: (b) => (b['balanceMinor'] = '555555'), path: '', code: 'unrecognized_keys', secrets: ['balanceMinor', '555555'] },
  ],
  lineDefects: [
    { id: 'negative amount', mutate: (l) => (l['baseAmountMinor'] = '-5-SECRET5'), rel: 'baseAmountMinor', secrets: ['-5-SECRET5'] },
    { id: 'zero txn amount', mutate: (l) => (l['txnAmountMinor'] = '0'), rel: 'txnAmountMinor', secrets: [] },
    { id: 'bad side', mutate: (l) => (l['side'] = 'X-SECRET6'), rel: 'side', secrets: ['X-SECRET6'] },
  ],
  crossField: ['lines'],
};

describe('DR-71 s3b. MONEY paths: the refusal is stable under the order and the number of problems', () => {
  for (const s of [sale, adjustment]) {
    it(`${s.name}: every subset of defects x every permutation of the lines x three key orders -> same decision, every broken field named, no message/keys leak`, () => {
      const r = exercise(s);
      expect(r.combos, 'a meaningful number of combinations was exercised').toBeGreaterThan(500);
      expect(
        r.counts.size,
        'the NUMBER of problems varied across the combinations (>= 4 distinct counts), so the count dimension is not vacuous',
      ).toBeGreaterThanOrEqual(4);
      expect(r.orderVaries, 'the EMITTED ORDER differed across line permutations for at least one subset, so the order dimension is not vacuous').toBe(true);
    });
  }

  it('SaleCommitSchema cross-field rules: ALONE they name their own field; beside a field defect they never throw (a refinement that dereferenced half-validated data would be a 500)', () => {
    const credit = { ...sale.base(), settlementMode: 'credit', customerId: null };
    expect(observe(sale.schema, credit).issues.map((i) => i.path)).toContain('customerId');
    const early = { ...sale.base(), documentDate: '2026-10-30', dueDate: '2026-01-01', settlementMode: 'credit', customerId: uuidN(7) };
    expect(observe(sale.schema, early).issues.map((i) => i.path)).toContain('dueDate');
    const dup = sale.base();
    (dup['lines'] as Body[])[1] = clone((dup['lines'] as Body[])[0] as Body);
    expect(observe(sale.schema, dup).issues.map((i) => i.path)).toContain('lines');
    // Beside broken lines the refinements dereference `lines` and `customerId`; they must refuse, not throw.
    const hostile: Body = { ...sale.base(), settlementMode: 'credit', customerId: 5, dueDate: 7, lines: [null, 'x', { lineId: 1 }] };
    const o = observe(sale.schema, hostile);
    assertContract(o, [], 'cross-field beside malformed data');
  });

  it('the values the attacker chose are never echoed: not the rejected key, not the rejected value, not a type name', () => {
    const b = sale.base();
    b['isAdmin-SECRETKEY'] = 'yes-SECRETVAL';
    ((b['lines'] as Body[])[0] as Body)['costMinor-SECRETKEY2'] = '1-SECRETVAL2';
    const o = observe(sale.schema, b);
    const wire = JSON.stringify(o.captured.body);
    for (const leak of ['SECRETKEY', 'SECRETVAL', 'SECRETKEY2', 'SECRETVAL2', 'isAdmin', 'costMinor']) expect(wire).not.toContain(leak);
    expect(o.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['unrecognized_keys']));
  });
});

// ───────────────────────── Part 2: HTTP, the decision and its side effects ─────────────────────────

describe('DR-71 s3b. HTTP: money and permission refusals change nothing, and authorisation answers before validation', () => {
  let t: TestApp;
  let ownerToken: string;
  let businessId: string;
  let strangerToken: string;

  const post = (path: string, token: string, biz: string) => t.request.post(path).set({ Authorization: `Bearer ${token}`, 'X-Business-Id': biz });
  const patch = (path: string, token: string, biz: string) => t.request.patch(path).set({ Authorization: `Bearer ${token}`, 'X-Business-Id': biz });
  const err = (res: { body?: { error?: Record<string, unknown> } }): Record<string, unknown> => res.body?.error ?? {};

  async function newBusiness(label: string): Promise<{ token: string; businessId: string; userId: string }> {
    const reg = await t.request
      .post('/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: label, preferredLocale: 'ar' });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: label, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `dr71z-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, businessId: on.body.businessId as string, userId: me.body.userId as string };
  }

  async function count(table: 'sales' | 'business_roles'): Promise<number> {
    const r = await ownerPool().query(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [businessId]);
    return (r.rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetData();
    const a = await newBusiness('Zod Owner Co');
    ownerToken = a.token;
    businessId = a.businessId;
    await grantFeature(a.businessId, a.userId, 'CUSTOM_ROLES');
    const b = await newBusiness('Zod Stranger Co');
    strangerToken = b.token;
  });
  afterAll(async () => {
    await t.close();
  });

  /** Bodies wrong in 1, 3 and many ways, in two key orders. */
  const roleBodies = (): Body[] => {
    const bad = [
      { key: 'Bad Key!-SECRET7', name: 'ok', permissions: [] },
      { key: 'good-key', name: '', permissions: [] },
      { key: 'good-key', name: 'ok', permissions: 'not-an-array-SECRET8' },
      { key: 'Bad Key!-SECRET7', name: '', permissions: 'not-an-array-SECRET8', isSystem: true },
      { key: 'good-key', name: 'ok', permissions: Array.from({ length: 101 }, (_, i) => `perm.${i}`) },
      { key: 7, name: 7, permissions: 7, role: 'owner', permissionsExtra: ['*'] },
    ];
    return bad.flatMap((b) => [b as Body, reorderKeys(b, 'reverse') as Body]);
  };

  it('PERMISSIONS: role creation refused for any number/order of problems -> always 400 VALIDATION_FAILED and NO role is created; the attacker-chosen names never echo', async () => {
    const ok = await post('/v1/businesses/current/roles', ownerToken, businessId).send({ key: 'dr71-probe', name: 'Probe', permissions: [] });
    expect(ok.status, 'positive control: a schema-valid body passes the guards and creates a role').toBeLessThan(300);
    const before = await count('business_roles');
    for (const body of roleBodies()) {
      const res = await post('/v1/businesses/current/roles', ownerToken, businessId).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(err(res).code).toBe('VALIDATION_FAILED');
      const wire = JSON.stringify(res.body);
      for (const leak of ['SECRET7', 'SECRET8', 'isSystem', 'permissionsExtra', '"keys"']) expect(wire, `${leak} must not echo`).not.toContain(leak);
      for (const i of (err(res).details as { issues: object[] }).issues) expect(Object.keys(i).sort()).toEqual(['code', 'path']);
    }
    expect(await count('business_roles'), 'a refused request created no role').toBe(before);
  });

  it("PERMISSIONS: setting a member's roles to an invalid list is refused whole and leaves the member's roles as they were", async () => {
    const members = await t.request.get('/v1/businesses/current/members').set({ Authorization: `Bearer ${ownerToken}`, 'X-Business-Id': businessId });
    expect(members.status).toBe(200);
    const me = (members.body.items as { userId: string; roles?: unknown }[])[0];
    expect(me, 'the owner is listed').toBeTruthy();
    const uid = (me as { userId: string }).userId;
    expect(uid).toBeTruthy();
    // Positive control: a schema-VALID body gets past the pipe (the service may still judge it), so the 400s below are the schema's.
    const valid = await patch(`/v1/businesses/current/members/${uid}/roles`, ownerToken, businessId).send({ roleKeys: ['owner'] });
    expect(err(valid).code, 'a valid body is not refused as VALIDATION_FAILED').not.toBe('VALIDATION_FAILED');
    const snapshot = JSON.stringify(
      (
        (await t.request.get('/v1/businesses/current/members').set({ Authorization: `Bearer ${ownerToken}`, 'X-Business-Id': businessId })).body.items as {
          userId: string;
        }[]
      ).find((m) => m.userId === uid),
    );
    const bodies: Body[] = [
      { roleKeys: [] },
      { roleKeys: [''] },
      { roleKeys: Array.from({ length: 11 }, (_, i) => `r${i}`) },
      { roleKeys: ['owner'], grantAll: true },
      { grantAll: true, roleKeys: 'owner-SECRET9' },
      { roleKeys: [1, 2, 3], extra: 1 },
    ];
    for (const body of bodies.flatMap((b) => [b, reorderKeys(b, 'reverse') as Body])) {
      const res = await patch(`/v1/businesses/current/members/${uid}/roles`, ownerToken, businessId).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(err(res).code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/grantAll|SECRET9|"keys"/);
    }
    const after = await t.request.get('/v1/businesses/current/members').set({ Authorization: `Bearer ${ownerToken}`, 'X-Business-Id': businessId });
    expect(JSON.stringify((after.body.items as { userId: string }[]).find((m) => m.userId === uid)), 'the member is exactly as before').toBe(snapshot);
  });

  it('AUTHORISATION ANSWERS BEFORE VALIDATION: a caller from another business gets the same 403 for a valid body and for any number of problems — the schema is not handed to a stranger', async () => {
    const valid = { key: 'stranger-role', name: 'X', permissions: [] };
    const answers = [] as { status: number; code: unknown; keys: string[] }[];
    for (const body of [valid, ...roleBodies()]) {
      const res = await post('/v1/businesses/current/roles', strangerToken, businessId).send(body);
      answers.push({ status: res.status, code: err(res).code, keys: Object.keys(err(res)).sort() });
      expect(err(res).details, 'no validation detail reaches a caller who is not a member').toBeUndefined();
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size, 'one answer, whatever the body holds').toBe(1);
    expect(answers[0]?.status).toBe(403);
    expect(answers[0]?.code).toBe('FORBIDDEN');
    // And the same for money.
    const sales = [] as string[];
    for (const body of [sale.base(), { nonsense: true }, { ...sale.base(), saleId: 'x', taxMinor: '9' }]) {
      const res = await post('/v1/sales', strangerToken, businessId).send(body);
      sales.push(`${res.status}:${String(err(res).code)}:${err(res).details === undefined}`);
    }
    expect(new Set(sales).size, 'the stranger gets one answer on /v1/sales as well').toBe(1);
    expect(sales[0]).toMatch(/^403:FORBIDDEN:true$/);
  });

  it('MONEY: POST /v1/sales refused for any number/order of problems -> always 400 VALIDATION_FAILED, no sale row, and the server-owned money fields are never accepted from the client', async () => {
    const before = await count('sales');
    // Positive control: a schema-VALID body passes the guards and is judged by the service (not a 400 VALIDATION_FAILED).
    const valid = await post('/v1/sales', ownerToken, businessId).send(sale.base());
    expect(err(valid).code, "positive control: the body reaches the service, so the guards did not answer in the schema's place").not.toBe('VALIDATION_FAILED');
    const bodies: Body[] = [];
    for (const hs of [[], ...sale.header.map((h) => [h])]) {
      for (const ls of [[], ...sale.lineDefects.map((_, i) => [i])]) {
        if (hs.length === 0 && ls.length === 0) continue;
        const b = sale.base();
        hs.forEach((h) => h.mutate(b));
        ls.forEach((slot) => (sale.lineDefects[slot] as LineDefect).mutate((b['lines'] as Body[])[slot] as Body));
        bodies.push(b, reorderKeys(b, 'reverse') as Body);
      }
    }
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      const res = await post('/v1/sales', ownerToken, businessId).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(err(res).code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/SECRET|totalMinor|unitPrice|424242|"keys"/);
    }
    expect(await count('sales'), 'a refused request committed no sale').toBe(before);
  });
});
