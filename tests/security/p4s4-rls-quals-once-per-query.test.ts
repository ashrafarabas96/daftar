/**
 * P4-S4 — THE READ POLICIES' ROW-INVARIANT PARTS, EVALUATED ONCE PER QUERY,
 * ANSWER FOR ANSWER THE SAME POLICY.
 * (`0086_phase4_rls_quals_once_per_query.sql`; P4-AL-72's growth rule; §91's
 *  refusal of a disabled or unforced policy surface.)
 *
 * `0086` rewrote the row-invariant subexpressions of `tenant_membership` and
 * `business_isolation_read` on `invoices`, `sales`, `payment_allocations` and
 * `customer_credit_applications` as scalar subselects, so the executor
 * evaluates them once per query as an `InitPlan` instead of once per row. It
 * was done for a measured reason — 51.3 % of the fat-tail receivable read's
 * marginal cost was policy evaluation — and a performance change to a
 * SECURITY surface is exactly the change that has to prove it moved no
 * answer and admitted no row.
 *
 * The argument for why it cannot is short: `app_bypass()`, `CURRENT_USER` and
 * the two GUCs cannot change in the middle of a statement, so once per query
 * and once per row are the same value by construction. This file does not
 * rest on that argument. It captures every reader's answers under BOTH
 * policy shapes on the same rows in the same session and compares them, and
 * it proves default-deny from the outside rather than from the shape of the
 * expression.
 *
 * HOW BOTH SHAPES ARE REACHED. `ALTER POLICY` is transactional in
 * PostgreSQL, so the per-row form is restored inside a transaction that is
 * always rolled back. Nothing is left altered, and no second database is
 * needed for the comparison — which matters, because a comparison across two
 * databases would be a comparison of two datasets.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { createScratchDb, urlOf } from '../helpers/scratch-db';
import { MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { applyCredit, collectPayment, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';

/** The four relations `0086` names, and the two quals it rewrites on each. */
const RELATIONS = ['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] as const;
const REWRITTEN = ['tenant_membership', 'business_isolation_read'] as const;

/** The per-row form, exactly as 0075/0077/0081 created it. */
const PER_ROW = {
  tenant_membership: `(app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
  business_isolation_read: `(app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
     OR business_id = nullif(app_business(), '')::uuid)`,
} as const;

/**
 * THE SHIPPED FORM IS CAPTURED, NOT WRITTEN DOWN HERE.
 *
 * This file used to carry the once-per-query form as a literal and restore it
 * with `ALTER POLICY`. That made the file SELF-HEALING: the first case
 * committed this file's own correct text over whatever the migration had
 * actually installed, and every later case — the cross-tenant denial case
 * most of all — then tested the literal instead of the migration. A migration
 * that shipped a qual with the tenant barrier deleted would have left this
 * whole file green.
 *
 * So the shipped expression is read out of the catalogue ONCE, before
 * anything alters a policy, and every restore puts THAT text back. The
 * subject of this file is now the shape `0086` installed, and a hostile
 * shipped qual is carried into every case below.
 */
const SHIPPED = new Map<string, string>();
const shippedKey = (rel: string, pol: string): string => `${rel}.${pol}`;

/**
 * THE EXPECTED EXPRESSION, RENDERED BY THIS SERVER.
 *
 * An earlier version of this file asked whether each qual CONTAINED some
 * operands and counted the ` OR ` strings in it. Both are lexical and both
 * are defeated outright, which an independent attack proved by execution and
 * which was then reproduced here: `tenant_id <> (SELECT nullif(app_tenant(),
 * '')::uuid)` names every operand and renders exactly one ` OR `, and admits
 * every other tenant's rows; and an added always-true disjunct renders as
 * `OR` followed by a NEWLINE before a `CASE`, which is not the four-byte
 * ` OR `, so the count never sees it. A lexical test cannot see an operator,
 * and the catalogue's pretty-printer decides its own whitespace.
 *
 * So the comparison is an EXACT equality against the expression `0086` means,
 * rendered by the same `pg_get_expr` on the same server from a probe policy on
 * a TEMP table carrying the same two column names. Identical expression trees
 * render identically, so the equality is exact without hard-coding one
 * PostgreSQL version's whitespace. The probe lives in `pg_temp`, so nothing
 * that counts the policies of `public` sees it.
 */
const EXPECTED_SOURCE: Record<(typeof REWRITTEN)[number], string> = {
  tenant_membership: `((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid))`,
  business_isolation_read: `((SELECT app_bypass())
     OR (SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))
     OR business_id = (SELECT nullif(app_business(), '')::uuid))`,
};

/** The two expected renderings, obtained from a `pg_temp` probe and dropped again. */
async function referenceQuals(): Promise<Record<(typeof REWRITTEN)[number], string>> {
  const c = new Client({ connectionString: urlOf('daftar', 'postgres') });
  await c.connect();
  try {
    await c.query(`DROP TABLE IF EXISTS pg_temp._p4s4_reference`);
    await c.query(`CREATE TEMP TABLE _p4s4_reference (tenant_id UUID, business_id UUID)`);
    await c.query(`ALTER TABLE _p4s4_reference ENABLE ROW LEVEL SECURITY`);
    for (const pol of REWRITTEN) await c.query(`CREATE POLICY ${pol} ON _p4s4_reference USING ${EXPECTED_SOURCE[pol]}`);
    // THE PROBE IS PINNED TO THIS CONNECTION'S OWN TEMP SCHEMA. Matching on
    // `relname` alone is not enough: a table of the same name in any other
    // schema matches too, `DROP TABLE IF EXISTS` without a qualification
    // resolves through `search_path` and leaves a decoy outside it standing,
    // and two matching rows make the row this reads an arbitrary one. A decoy
    // `information_schema._p4s4_reference` carrying a hostile expression was
    // executed against the unpinned form and made the equality law compare a
    // backdoor against itself: 5 of 5 runs accepted it. `pg_my_temp_schema()`
    // is this session's own namespace and no other session can put anything
    // in it, so the reference can only be the table created three lines above.
    const r = await c.query<{ polname: string; q: string | null }>(
      `SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = pg_my_temp_schema() AND c.relname = '_p4s4_reference' ORDER BY 1`,
    );
    if (r.rows.length !== REWRITTEN.length)
      throw new Error(
        `the reference probe returned ${r.rows.length} policies and not ${REWRITTEN.length}, so the comparisons below would rest on the wrong row`,
      );
    const out = {} as Record<(typeof REWRITTEN)[number], string>;
    for (const pol of REWRITTEN) {
      const q = r.rows.find((x) => x.polname === pol)?.q;
      if (q === undefined || q === null || q === '')
        throw new Error(`the reference probe rendered nothing for ${pol}, so every comparison below would be vacuous`);
      out[pol] = q;
    }
    if (out.tenant_membership === out.business_isolation_read) throw new Error('both reference renderings are identical, so the probe distinguishes nothing');
    await c.query(`DROP TABLE pg_temp._p4s4_reference`);
    return out;
  } finally {
    await c.end();
  }
}

/** Every read qual `0086` rewrote, as the catalogue renders it right now. */
async function readQuals(): Promise<{ relname: string; polname: string; q: string | null }[]> {
  const r = await ownerPool().query<{ relname: string; polname: string; q: string | null }>(
    `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) AND p.polname = ANY ($2::text[]) ORDER BY 1, 2`,
    [[...RELATIONS], [...REWRITTEN]],
  );
  return r.rows;
}

/** `0086`'s whole text, as it is on disk. */
function text0086(): string {
  return readFileSync(join(MIGRATIONS_DIR, '0086_phase4_rls_quals_once_per_query.sql'), 'utf8');
}

/**
 * One `DO $tag$ … $tag$;` block of `0086`, sliced out of the file on disk.
 *
 * Disk IS what ran: the runner refuses a migration whose checksum has moved
 * ("Migration tampered after …"), so the applied text and the file agree or
 * the harness never came up.
 */
function blockOf0086(tag: string): string {
  const file = join(MIGRATIONS_DIR, '0086_phase4_rls_quals_once_per_query.sql');
  const text = readFileSync(file, 'utf8');
  const open = `DO $${tag}$`;
  const close = `$${tag}$;`;
  const from = text.indexOf(open);
  const to = text.indexOf(close, from + 1);
  if (from < 0 || to < 0) throw new Error(`0086 carries no ${open} … ${close} block, so the proof below would prove nothing: ${file}`);
  return text.slice(from, to + close.length);
}

let w: SettlementWorld;
const customers: string[] = [];
const invoices: string[] = [];

/** One connection as `role`, scoped the way `Database.applyScope` scopes one. */
async function connectAs(role: 'daftar_app' | 'daftar_migrator', scope: { tenantId?: string; businessId?: string } = {}): Promise<Client> {
  const c = new Client({ connectionString: urlOf('daftar', role) });
  await c.connect();
  if (scope.tenantId !== undefined) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [scope.tenantId]);
  if (scope.businessId !== undefined) await c.query(`SELECT set_config('app.business_id', $1, false)`, [scope.businessId]);
  return c;
}

/**
 * Every answer the five readers give, for EVERY customer and EVERY invoice
 * the connection can see, as one ordered array of strings. Derived from the
 * data rather than from a written-out subject list, so a reader that starts
 * hiding a row changes the capture.
 */
async function captureAnswers(c: Client, businessId: string): Promise<string[]> {
  const out: string[] = [];
  const cs = await c.query<{ id: string }>(`SELECT DISTINCT customer_id AS id FROM invoices WHERE customer_id IS NOT NULL ORDER BY 1`);
  for (const { id } of cs.rows) {
    const ar = await c.query(`SELECT currency_code, txn_minor::text, base_minor::text FROM customer_ar_outstanding($1::uuid, $2::uuid) ORDER BY 1`, [
      businessId,
      id,
    ]);
    out.push(`ar ${id} ${JSON.stringify(ar.rows)}`);
    const aging = await c.query(
      `SELECT bucket_no, currency_code, txn_minor::text, base_minor::text, invoice_count FROM customer_ar_aging($1::uuid, $2::uuid, CURRENT_DATE, ARRAY[30,60,90]) ORDER BY 1, 2`,
      [businessId, id],
    );
    out.push(`aging ${id} ${JSON.stringify(aging.rows)}`);
    const page = await c.query(
      `SELECT invoice_id::text, issue_date::text, currency_code FROM customer_open_invoices_page($1::uuid, $2::uuid, NULL, NULL, 50) ORDER BY 1`,
      [businessId, id],
    );
    out.push(`page ${id} ${JSON.stringify(page.rows)}`);
  }
  const inv = await c.query<{ id: string }>(`SELECT id FROM invoices ORDER BY 1`);
  for (const { id } of inv.rows) {
    const one = await c.query(`SELECT outstanding_txn_minor::text, outstanding_base_minor::text FROM invoice_outstanding($1::uuid, $2::uuid) ORDER BY 1`, [
      businessId,
      id,
    ]);
    out.push(`out ${id} ${JSON.stringify(one.rows)}`);
    const st = await c.query(`SELECT invoice_settlement_state($1::uuid, $2::uuid) AS state`, [businessId, id]);
    out.push(`state ${id} ${JSON.stringify(st.rows)}`);
  }
  // And the SET form over every id at once, which is the one definition.
  const all = await c.query(
    `SELECT invoice_id::text, outstanding_txn_minor::text FROM invoice_outstanding($1::uuid, (SELECT array_agg(id) FROM invoices)::uuid[]) ORDER BY 1`,
    [businessId],
  );
  out.push(`set ${JSON.stringify(all.rows)}`);
  return out;
}

/**
 * Put all eight read quals into `shape` on all four relations.
 *
 * ALTER POLICY needs the table's OWNER, and the owner here is a superuser
 * that bypasses row security altogether — so the role that changes the shape
 * can never be the role that reads under it, and the comparison cannot be
 * done inside one transaction. It is therefore committed and put back in a
 * `finally`, and the last assertion of each case reads the shipped shape back
 * out of the catalogue so a half-finished case cannot be mistaken for a pass.
 */
async function setShape(shape: 'per-row' | 'once-per-query'): Promise<void> {
  const o = new Client({ connectionString: urlOf('daftar', 'postgres') });
  await o.connect();
  try {
    for (const rel of RELATIONS) {
      for (const pol of REWRITTEN) {
        let using: string;
        if (shape === 'per-row') using = PER_ROW[pol];
        else {
          const captured = SHIPPED.get(shippedKey(rel, pol));
          if (captured === undefined || captured === '')
            throw new Error(
              `the shipped qual for ${rel}.${pol} was never captured, so restoring it would restore this file's opinion instead of the migration's`,
            );
          using = `(${captured})`;
        }
        await o.query(`ALTER POLICY ${pol} ON ${rel} USING ${using}`);
      }
    }
  } finally {
    await o.end();
  }
}

/** Every read qual carries the subselect form, read back from the catalogue. */
async function shippedShapeIsBack(): Promise<void> {
  const r = await ownerPool().query<{ relname: string; polname: string; q: string | null }>(
    `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) AND p.polname = ANY ($2::text[]) ORDER BY 1, 2`,
    [[...RELATIONS], [...REWRITTEN]],
  );
  expect(r.rows.length).toBe(RELATIONS.length * REWRITTEN.length);
  for (const row of r.rows) expect(row.q ?? '', `${row.relname}.${row.polname} was left in the per-row form by this file`).toContain('( SELECT');
}

beforeAll(async () => {
  await ensurePostgres();
  // BEFORE anything in this file alters a policy: the shape the migration
  // installed, straight out of the catalogue. Every `once-per-query` restore
  // below puts this text back, so no case can be answered by a literal.
  //
  // AND THE CAPTURE IS NOT TAKEN ON TRUST. Four cases below alter the SHARED
  // database's policies and restore them in a `finally`; a run that dies
  // between the two leaves the plant COMMITTED, and the next run would then
  // capture the plant as "the shape the migration installed" and faithfully
  // restore the backdoor after every case — the suite healing itself into
  // agreement with an attack. So each captured expression is compared against
  // this server's own rendering of the expression `0086` writes, which is
  // produced in a probe pinned to this connection's temp schema and is
  // therefore not something a previous run could have left behind.
  const expected = await referenceQuals();
  for (const row of await readQuals()) {
    if (row.q === null || row.q === '') throw new Error(`${row.relname}.${row.polname} has no qual at all, so 0086 altered something that is not there`);
    const want = expected[row.polname as (typeof REWRITTEN)[number]];
    if (row.q !== want)
      throw new Error(
        `${row.relname}.${row.polname} is not the expression 0086 writes, BEFORE this file has altered anything — a previous run left a plant committed, or the migration did not install what it says. Found: ${row.q}`,
      );
    SHIPPED.set(shippedKey(row.relname, row.polname), row.q);
  }
  if (SHIPPED.size !== RELATIONS.length * REWRITTEN.length)
    throw new Error(`captured ${SHIPPED.size} shipped qual(s) and 0086 rewrites ${RELATIONS.length * REWRITTEN.length}`);
  await resetData();
  w = await settlementWorld('p4s4rlsq');
  const missing = await settlementMissing(w);
  if (missing.length > 0) throw new Error(`the settlement surface is incomplete, so this file would prove nothing: ${missing.join(', ')}`);
  await stockUp(w, '400', '5');
  // Two customers, three credit invoices each, and ONE payment that both
  // allocates and leaves a surplus — so `invoice_outstanding`'s payment arm
  // carries rows, a `customer_credit` exists, and the page reader has a
  // settled invoice and open ones to tell apart. An equality over a dataset
  // where one arm is empty would be an equality about the empty arm.
  for (let i = 0; i < 2; i += 1) {
    const customerId = await newCustomer(w);
    customers.push(customerId);
    const opened = [await sellOnCredit(w, customerId, '2'), await sellOnCredit(w, customerId, '3'), await sellOnCredit(w, customerId, '4')];
    invoices.push(...opened.map((o) => o.invoiceId));
    const first = opened[0];
    if (first === undefined) throw new Error('the fixture sold nothing');
    const legs: AllocationInput[] = [
      {
        invoiceId: first.invoiceId,
        appliedMinor: first.totalTxnMinor,
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: first.totalTxnMinor,
        invoiceTotalBaseMinor: first.totalBaseMinor,
      },
    ];
    const creditId = randomUUID();
    const res = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      creditId,
      amountMinor: (BigInt(first.totalTxnMinor) + 50n).toString(),
      allocations: legs,
    });
    expect(res.status, `the collection commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);

    // AND THE SURPLUS CREDIT IS APPLIED, so `customer_credit_applications`
    // CARRIES ROWS. It is one of the four relations `0086` rewrote, and the
    // visibility proof over it is only worth anything if it has something to
    // be visible: an equality over an empty relation is an equality about
    // nothing. The non-vacuity guard in that case caught exactly this — the
    // relation was globally empty on the first run of it — and seeding the
    // row is the fix, not relaxing the guard.
    const second = opened[1];
    if (second === undefined) throw new Error('the fixture sold no second invoice to apply the credit to');
    const cr = (
      await ownerPool().query<{ oa: string; ob: string }>(
        `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob
           FROM customer_credits WHERE business_id = $1 AND id = $2`,
        [w.shop.businessId, creditId],
      )
    ).rows[0];
    if (cr === undefined) throw new Error(`the surplus credit ${creditId} was not created, so the credit arm would be empty`);
    const applied = await applyCredit(w.t, w.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId,
      invoiceId: second.invoiceId,
      applicationDate: w.day,
      consumedMinor: '1',
      remainingBeforeMinor: cr.oa,
      creditOriginalMinor: cr.oa,
      creditOriginalCarryingMinor: cr.ob,
      leg: {
        invoiceId: second.invoiceId,
        appliedMinor: '1',
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: second.totalTxnMinor,
        invoiceTotalBaseMinor: second.totalBaseMinor,
      },
    });
    expect(applied.status, `the credit application commits: ${JSON.stringify(applied.body)}`).toBeLessThan(300);
  }
}, 900_000);

afterAll(async () => {
  await resetData();
});

/**
 * The format `0086` aggregates its policy-set capture with. The capture is
 * taken in `0086-A` and compared in `0086-F`, so a block sliced off disk and
 * run ALONE has no capture to compare against and `0086-F` refuses it as
 * vacuous — correctly. A case whose subject is the QUAL law therefore supplies
 * the capture from the live state first, which makes the set comparison a
 * deliberate no-op there and leaves the qual law as the only thing deciding.
 * The format string below is asserted to be the file's own, so this stand-in
 * cannot drift away from what the file actually compares.
 */
const SNAPSHOT_FORMAT = `'%s.%s permissive=%s cmd=%s roles=%s check=%s qual=%s'`;

/**
 * A single statement that stores the CURRENT policy set where `0086-F` reads it.
 *
 * This statement is EXACTLY the forgery guard G-8
 * (`scripts/guards/migration-self-capture.ts`) forbids inside a migration: one
 * extra `set_config` of the capture GUC lets a file change what it captured
 * and then re-capture, and a planted widening was made to apply green that
 * way, 6 runs of 6. It is legal HERE and only here — in a test, against a
 * block sliced off disk and run alone, to make the set comparison a
 * deliberate no-op so that the qual law is the only thing deciding. G-8's
 * subject is the migration text, so this helper cannot satisfy it.
 */
function captureStatement(): string {
  if (!text0086().includes(SNAPSHOT_FORMAT))
    throw new Error('0086 no longer aggregates its capture with the format this stand-in copies, so the stand-in must be updated with it');
  return `SELECT pg_catalog.set_config('app.p4s4_0086_policy_snapshot', (
    SELECT pg_catalog.string_agg(
             pg_catalog.format(${SNAPSHOT_FORMAT},
               c.relname, p.polname, p.polpermissive, p.polcmd, p.polroles::text,
               COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '<none>'),
               CASE WHEN p.polname IN ('tenant_membership', 'business_isolation_read')
                    THEN '<rewritten by this file>'
                    ELSE COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '<none>') END),
             E'\\n' ORDER BY c.relname, p.polname)
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY ($$1$$::text[])), true)`.replace('$$1$$', `ARRAY[${RELATIONS.map((r) => `'${r}'`).join(', ')}]`);
}

describe('P4-S4 — 0086: the read quals are evaluated once per query and answer identically', () => {
  it('every reader gives byte-identical answers under both policy shapes, on the same rows', async () => {
    const c = await connectAs('daftar_app', { tenantId: w.shop.tenantId, businessId: w.shop.businessId });
    try {
      const asShipped = await captureAnswers(c, w.shop.businessId);
      expect(asShipped.length, 'the capture found no subject, so an equality between two empty captures would prove nothing').toBeGreaterThan(10);
      let perRow: string[];
      try {
        await setShape('per-row');
        perRow = await captureAnswers(c, w.shop.businessId);
      } finally {
        await setShape('once-per-query');
      }
      expect(perRow).toEqual(asShipped);
      await shippedShapeIsBack();
    } finally {
      await c.end();
    }
  }, 300_000);

  it('RED PROOF: under the per-row form the shape assertion 0086-E(1) makes would FAIL, so that assertion is not vacuous', async () => {
    try {
      await setShape('per-row');
      const r = await ownerPool().query<{ relname: string; polname: string; q: string | null }>(
        `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) AND p.polname = ANY ($2::text[]) ORDER BY 1, 2`,
        [[...RELATIONS], [...REWRITTEN]],
      );
      expect(r.rows.length).toBe(RELATIONS.length * REWRITTEN.length);
      for (const row of r.rows)
        expect(row.q ?? '', `${row.relname}.${row.polname} reverted, so the subselect must be absent — else 0086-E(1) can never go red`).not.toContain(
          '( SELECT',
        );
    } finally {
      await setShape('once-per-query');
    }
    await shippedShapeIsBack();
  }, 120_000);

  it('each SHIPPED qual IS the expression 0086 writes, compared whole against this server’s own rendering', async () => {
    // Not "contains the operands" and not "has N disjuncts" — both are
    // lexical and both were broken. The whole installed expression is
    // compared, character for character, against the rendering of the
    // expression this file names, produced by the same printer on the same
    // server. An inverted operator, a swapped disjunct, an added one, a
    // wrapper that makes the comparison always true: each changes the text.
    const ref = await referenceQuals();
    const rows = await readQuals();
    expect(rows.length).toBe(RELATIONS.length * REWRITTEN.length);
    for (const row of rows) {
      const want = ref[row.polname as (typeof REWRITTEN)[number]];
      expect(want, `${row.polname} has no reference rendering, so this case would pass over an unknown policy`).toBeDefined();
      expect(row.q ?? '', `${row.relname}.${row.polname} is not the expression 0086 writes`).toBe(want);
    }
  }, 180_000);

  it('RED PROOF: the four attacks that defeated the earlier LEXICAL law are each refused, by the law that can see them', async () => {
    // Every plant below passed the operand-and-count law that `0086-E(1)`
    // once carried. They are kept as the standing proof that what replaced it
    // is not lexical — AND as the statement of which law catches which, since
    // the two halves have different reach:
    //
    //   0086-A / 0086-F EVALUATE the installed qual with the scope GUC set,
    //   so they catch anything that changes the truth table over the values
    //   they supply: the barrier deleted, the comparison INVERTED, an ADDED
    //   always-true disjunct.
    //
    //   A TARGETED backdoor — the real barrier plus a disjunct true for one
    //   chosen tenant — changes the truth table for NOBODY ELSE, so an
    //   evaluated check over values the attacker did not choose cannot see
    //   it, and neither can a cross-tenant case drawing a random foreign
    //   tenant. That one is caught here, by comparing the whole installed
    //   expression against this server's rendering of the expression 0086
    //   writes. Stated rather than glossed: an evaluated law and an equality
    //   law are both necessary, and neither is sufficient.
    const block = `${captureStatement()};\n${blockOf0086('fin')}`;
    expect(block, 'the sliced block is not 0086’s end-state block').toContain('0086-F');
    const restore = RELATIONS.map((rel) => {
      const captured = SHIPPED.get(shippedKey(rel, 'tenant_membership'));
      if (captured === undefined) throw new Error(`no captured shipped qual for ${rel}.tenant_membership, so the plant could not be undone`);
      return { rel, captured };
    });
    // The capture guard is not decoration: the end-state block run ALONE has
    // no capture to compare against, and it must say so rather than pass.
    // Every case here that runs that block in isolation supplies the capture
    // first, which is only honest if the block refuses to run without it.
    {
      const bare = new Client({ connectionString: urlOf('daftar', 'postgres') });
      await bare.connect();
      try {
        await expect(bare.query(blockOf0086('fin'))).rejects.toThrow(/0086-F: the capture 0086-A took is not here/);
      } finally {
        await bare.end();
      }
    }
    const ref = await referenceQuals();
    const EVALUATED: readonly { readonly why: string; readonly using: string }[] = [
      { why: 'the tenant barrier deleted', using: `((SELECT app_bypass()) OR (SELECT true))` },
      { why: 'the comparison inverted', using: `((SELECT app_bypass()) OR tenant_id <> (SELECT nullif(app_tenant(), '')::uuid))` },
      {
        why: 'an added always-true disjunct behind a CASE, which the printer renders as OR + newline',
        using: `((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid) OR CASE WHEN true THEN true ELSE false END)`,
      },
    ];
    const TARGETED = `((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid) OR (SELECT app_tenant()) = '00000000-0000-0000-0000-0000000000ff')`;
    const o = new Client({ connectionString: urlOf('daftar', 'postgres') });
    await o.connect();
    try {
      for (const plant of EVALUATED) {
        for (const rel of RELATIONS) await o.query(`ALTER POLICY tenant_membership ON ${rel} USING ${plant.using}`);
        const landed = (await readQuals()).filter((r) => r.polname === 'tenant_membership');
        expect(landed.length).toBe(RELATIONS.length);
        for (const row of landed)
          expect(row.q ?? '', `the plant did not land on ${row.relname}`).not.toBe(SHIPPED.get(shippedKey(row.relname, 'tenant_membership')));
        await expect(o.query(block), `0086-F accepted ${plant.why}`).rejects.toThrow(
          /0086-F: \w+\.tenant_membership (ADMITS another scope|does not admit its own scope|admits a row with the scope GUC unset)/,
        );
      }

      // THE TARGETED BACKDOOR, AND A LIMIT THAT IS NOW CLOSED. A qual that
      // admits exactly one other tenant passes every evaluated case — it
      // admits its own scope, denies the one other scope the probe supplies,
      // denies with the GUC unset and denies NULL — and 0086-F used to run it
      // GREEN. That was recorded here as the measured limit of an evaluated
      // law. The literal-set arm closes it INSIDE the file: the tenant it
      // names is a literal `tenant_membership` is not entitled to, whatever
      // the evaluation says.
      for (const rel of RELATIONS) await o.query(`ALTER POLICY tenant_membership ON ${rel} USING ${TARGETED}`);
      await expect(o.query(block), 'the targeted backdoor is no longer a limit: the literal-set arm must name it').rejects.toThrow(
        /0086-F: \w+\.tenant_membership names the literal\(s\) \{00000000-0000-0000-0000-0000000000ff\} and is entitled to exactly \{\}/,
      );
      // And the equality law refuses it on every relation too, so neither arm
      // is load-bearing alone.
      const backdoored = (await readQuals()).filter((r) => r.polname === 'tenant_membership');
      expect(backdoored.length).toBe(RELATIONS.length);
      for (const row of backdoored)
        expect(row.q ?? '', `${row.relname}.tenant_membership carries a targeted backdoor and the equality law did not see it`).not.toBe(ref.tenant_membership);
    } finally {
      for (const { rel, captured } of restore) await o.query(`ALTER POLICY tenant_membership ON ${rel} USING (${captured})`);
      await o.end();
    }
    // Restored, read back from the catalogue and compared against the
    // reference rather than against a substring.
    for (const row of (await readQuals()).filter((r) => r.polname === 'tenant_membership'))
      expect(row.q ?? '', `${row.relname}.tenant_membership was not restored`).toBe(ref.tenant_membership);
    await shippedShapeIsBack();
  }, 600_000);

  it('RED PROOF: 0086-A refuses a pre-state that is not the expression 0086 rewrites, on a database built to 0085', async () => {
    // `0086`'s whole safety argument — "the same expression, with subselects"
    // — is a claim about the state BEFORE it runs, and `ALTER POLICY ...
    // USING` replaces the clause whatever it held. 0086-A reads that
    // pre-state out of the catalogue and compares it WHOLE against this
    // server's rendering of the per-row form. This is the negative control: a
    // scratch database built from the real migration files up to 0085, one
    // qual moved off that form, and 0086's own text applied to it.
    const db = await createScratchDb('daftar_p4s4_pre0086', { upTo: '0085_phase4_allocation_recompute_set_based.sql' });
    try {
      expect(db.applied.at(-1), 'the scratch build did not stop at 0085, so the plant would be against the wrong state').toBe(
        '0085_phase4_allocation_recompute_set_based.sql',
      );
      const sql = text0086();
      expect(sql, 'the file carries no pre-apply block, so this case would prove nothing').toContain('0086-A');
      // 0086 applies cleanly to the state 0085 leaves — the control for the
      // control, so a refusal below cannot be the build's own fault.
      await db.pool.query('BEGIN');
      await db.pool.query(sql);
      await db.pool.query('ROLLBACK');

      // Already rewritten ahead of time: 0086 must refuse rather than
      // overwrite an expression it did not read.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices USING ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid))`);
      await expect(db.pool.query(sql)).rejects.toThrow(/0086-A/);
      // Still the per-row shape, but the comparison INVERTED — the plant the
      // operand-and-count law accepted.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices USING (app_bypass() OR tenant_id <> nullif(app_tenant(), '')::uuid)`);
      await expect(db.pool.query(sql)).rejects.toThrow(/0086-A/);
      // And the barrier simply gone.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices USING (app_bypass() OR true)`);
      await expect(db.pool.query(sql)).rejects.toThrow(/0086-A/);
    } finally {
      await db.drop();
    }
  }, 900_000);

  it('RED PROOF: a WITH CHECK that is present and subselect-free but admits a foreign tenant is REFUSED, and a version of this file that touches a clause it never named is refused by its own last block', async () => {
    // Two routes removed a barrier while every assertion this file made still
    // passed, and both were executed against it:
    //
    //   B1  `ALTER POLICY tenant_membership ON <rel> WITH CHECK (tenant_id IS
    //       NOT NULL)`. 0086-E(2) asks only whether the clause is present and
    //       whether it holds a subselect. A blanket predicate satisfies both
    //       and admits a write carrying a FOREIGN tenant_id.
    //   B2  a RESTRICTIVE policy dropped and re-created under the SAME name
    //       with the SAME USING text `AS PERMISSIVE`. The count stays 7 and
    //       every text comparison is byte-identical, yet an AND-ed barrier has
    //       become an OR-ed one.
    //
    // Presence is not a barrier and a count is not a set, so the file now
    // evaluates the check expression (0086-A(w), 0086-F(w)) and captures the
    // whole policy set — permissiveness, command, roles, WITH CHECK, and the
    // USING of every policy it does not rewrite — comparing it whole at the
    // end (0086-F). This is the control for both.
    const db = await createScratchDb('daftar_p4s4_pre0086_clauses', { upTo: '0085_phase4_allocation_recompute_set_based.sql' });
    try {
      const sql = text0086();
      expect(sql, 'the file carries no evaluated write-barrier block, so this case would prove nothing').toContain('0086-A(w)');
      expect(sql, 'the file captures no policy set, so the comparison below would prove nothing').toContain('app.p4s4_0086_policy_snapshot');

      // The control for the control: the file applies cleanly to the state
      // 0085 leaves, so a refusal below is the plant and not the build.
      await db.pool.query('BEGIN');
      await db.pool.query(sql);
      await db.pool.query('ROLLBACK');

      // B1 — present, no subselect, and no barrier.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices WITH CHECK (tenant_id IS NOT NULL)`);
      await expect(db.pool.query(sql)).rejects.toThrow(/0086-A\(w\)/);
      // Restored to the expression 0085 left, read back rather than assumed.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`);
      await db.pool.query('BEGIN');
      await db.pool.query(sql);
      await db.pool.query('ROLLBACK');

      // B1 the other way: a check that refuses every write in its own scope is
      // not a barrier either, it is an outage, and the file must not ship it.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices WITH CHECK (false)`);
      await expect(db.pool.query(sql)).rejects.toThrow(/0086-A\(w\)/);
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`);

      // B2 and the general case, planted into the FILE: a version of 0086
      // that also widens a clause it never names must be refused by its own
      // final comparison. The plant goes immediately before the last block,
      // so everything 0086 really does has already happened.
      const at = sql.indexOf('DO $fin$');
      expect(at, 'the final block is not where this plant expects it').toBeGreaterThan(0);
      const plant = (stmt: string): string => `${sql.slice(0, at)}${stmt}\n${sql.slice(at)}`;

      const widened = plant(`ALTER POLICY business_isolation_delete ON invoices USING (true);`);
      expect(widened, 'the plant did not change the file').not.toBe(sql);
      await expect(db.pool.query(widened)).rejects.toThrow(/0086-F: this file altered a clause it never named/);

      const permissive = plant(
        `DROP POLICY business_isolation_delete ON invoices;\n` +
          `CREATE POLICY business_isolation_delete ON invoices AS PERMISSIVE FOR DELETE ` +
          `USING (app_bypass() OR business_id = nullif(app_business(), '')::uuid);`,
      );
      await expect(db.pool.query(permissive)).rejects.toThrow(/0086-F: this file altered a clause it never named/);

      const rewrittenCheck = plant(`ALTER POLICY tenant_membership ON invoices WITH CHECK (tenant_id IS NOT NULL);`);
      await expect(db.pool.query(rewrittenCheck)).rejects.toThrow(/0086-F/);

      // C-2 — THE ESCAPE LIST. `business_isolation_read` carries
      // `current_user IN ('daftar_inventory_internal',
      // 'daftar_accounting_internal')`, and no truth table in this file can
      // see a name added to it: every block runs as the migrator, for whom
      // every `current_user` test is FALSE whatever the list holds. A
      // nine-character edit of the file's own `ALTER` — appending
      // `'daftar_app'` — therefore applied GREEN and was measured as a real
      // cross-business read, 0 rows before and 1 row after. So the role
      // literals are pinned by EQUALITY, and this is that law's red proof.
      //
      // THE PATTERN WAS THE HOLE. The first version of that law read only
      // `'(daftar_[a-z_]+)'` out of the clause, and an independent challenge
      // round measured FOUR spellings through it, each admitting a foreign
      // business when the planted qual was evaluated as `daftar_app`. So the
      // law now enumerates the clause's WHOLE literal set and refuses
      // concatenation, and each of those four spellings is a red proof.
      const LIST = `(SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))`;
      expect(sql, 'the escape list is not written the way these plants expect, so they prove nothing').toContain(LIST);
      for (const [why, widenedRoles, expected] of [
        [
          'the measured nine-character edit',
          LIST.replace(`'daftar_accounting_internal')`, `'daftar_accounting_internal', 'daftar_app')`),
          /is entitled to exactly/,
        ],
        ['a name carrying a digit', LIST.replace(`'daftar_accounting_internal')`, `'daftar_accounting_internal', 'daftar_app2')`), /is entitled to exactly/],
        [
          'a name without the daftar_ prefix',
          LIST.replace(`'daftar_accounting_internal')`, `'daftar_accounting_internal', 'appserver')`),
          /is entitled to exactly/,
        ],
        [
          'a name carrying an upper-case letter',
          LIST.replace(`'daftar_accounting_internal')`, `'daftar_accounting_internal', 'daftar_App')`),
          /is entitled to exactly/,
        ],
        [
          'a name assembled at runtime, which pg_get_expr never folds back into a literal',
          `${LIST.slice(0, -1)} OR (SELECT current_user::text = 'daftar' || '_app'))`,
          /ASSEMBLES a value in its USING clause/,
        ],
      ] as const) {
        const planted = sql.replaceAll(LIST, widenedRoles);
        expect(planted, `${why}: the plant changed nothing`).not.toBe(sql);
        await expect(db.pool.query(planted), why).rejects.toThrow(expected);
      }

      // M-2 — THE FOURTH CASE IS A FOURTH *VALUE*. A qual pinned to ONE other
      // business — `OR business_id = '3333…'` — admits its own scope, denies
      // the scope the probe supplies, denies with the GUC unset and denies
      // NULL, so every evaluated case passes and an independent challenge
      // round measured both of these applying GREEN. Two independent arms now
      // refuse them: the denied scope is a FRESH value each run, so the clause
      // cannot have been written against it, and the literal-set equality sees
      // the UUID as a literal the clause is not entitled to.
      const BUSINESS = `OR business_id = (SELECT nullif(app_business(), '')::uuid)`;
      expect(sql, 'the business clause is not written the way these plants expect').toContain(BUSINESS);
      for (const other of ['33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000']) {
        const planted = sql.replaceAll(BUSINESS, `${BUSINESS} OR business_id = '${other}'::uuid`);
        expect(planted, `the ${other} plant changed nothing`).not.toBe(sql);
        await expect(db.pool.query(planted), `a backdoor pinned to business ${other}`).rejects.toThrow(
          /0086-[AF]: \w+\.business_isolation_read names the literal\(s\)|0086-[AF]: \w+\.business_isolation_read ADMITS another scope/,
        );
      }

      // M-3 — A NULL SCOPE COLUMN. `OR tenant_id IS NULL` admits no other
      // scope's row and nothing with the GUC unset, so it passes the first
      // three cases outright while admitting every row outside every scope.
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid OR tenant_id IS NULL)`);
      await expect(db.pool.query(sql)).rejects.toThrow(/0086-A: .*scope column is NULL/);
      await db.pool.query(`ALTER POLICY tenant_membership ON invoices USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`);

      // And the file itself still applies, so none of the plants above left
      // the database in a state that would make a pass meaningless.
      await db.pool.query('BEGIN');
      await db.pool.query(sql);
      await db.pool.query('ROLLBACK');
    } finally {
      await db.drop();
    }
  }, 900_000);

  it('DEFAULT-DENY holds from the outside: no scope sees nothing, and another business’s scope sees nothing of this one', async () => {
    const bare = await connectAs('daftar_app');
    try {
      expect((await bare.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n, 'an unscoped connection sees invoices').toBe('0');
      expect((await bare.query<{ n: string }>(`SELECT count(*)::text AS n FROM payment_allocations`)).rows[0]?.n).toBe('0');
    } finally {
      await bare.end();
    }
    const elsewhere = await connectAs('daftar_app', { tenantId: w.shop.tenantId, businessId: '00000000-0000-0000-0000-000000000001' });
    try {
      expect(
        (await elsewhere.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n,
        'a foreign business scope sees this business’s invoices',
      ).toBe('0');
    } finally {
      await elsewhere.end();
    }
  }, 120_000);

  it('CROSS-TENANT denial holds on all four relations, under BOTH shapes', async () => {
    // `tenant_membership` is the qual `0086` rewrote, and the case above
    // proves the BUSINESS boundary, not the TENANT one. They are different
    // policies over different columns: a foreign tenant carrying this
    // business's own `business_id` would satisfy `business_isolation_read`
    // outright, so `tenant_membership` is the only thing standing between it
    // and every row. That makes it exactly the boundary a rewrite of
    // `tenant_membership` has to be shown not to have moved.
    const foreignTenant = randomUUID();
    for (const shape of ['once-per-query', 'per-row'] as const) {
      try {
        if (shape === 'per-row') await setShape('per-row');
        const c = await connectAs('daftar_app', { tenantId: foreignTenant, businessId: w.shop.businessId });
        try {
          for (const rel of RELATIONS) {
            const n = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${rel}`)).rows[0]?.n;
            expect(n, `[${shape}] a FOREIGN TENANT carrying this business's own business_id reads ${rel}`).toBe('0');
          }
        } finally {
          await c.end();
        }
      } finally {
        await setShape('once-per-query');
      }
    }
    await shippedShapeIsBack();
  }, 180_000);

  it('NO ROW BECAME VISIBLE: the exact visible row SET of each relation is identical under both shapes', async () => {
    // The obligation the equivalence case above does not quite discharge. It
    // compares the READERS' answers; this compares the RELATIONS themselves,
    // and it compares the row identities rather than a count, because two
    // equal counts can still be two different sets — one row newly admitted
    // and one newly hidden would cancel out perfectly in a `count(*)`.
    const digests = async (c: Client): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const rel of RELATIONS) {
        const r = await c.query<{ d: string | null; n: string }>(
          `SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) AS d, count(*)::text AS n FROM ${rel}`,
        );
        out[rel] = `${r.rows[0]?.n ?? '?'}:${r.rows[0]?.d ?? '?'}`;
      }
      return out;
    };
    const c = await connectAs('daftar_app', { tenantId: w.shop.tenantId, businessId: w.shop.businessId });
    try {
      const shipped = await digests(c);
      for (const rel of RELATIONS)
        expect(Number((shipped[rel] ?? '0:').split(':')[0]), `${rel} is empty, so an equality over it would be vacuous`).toBeGreaterThan(0);
      let perRow: Record<string, string> = {};
      try {
        await setShape('per-row');
        perRow = await digests(c);
      } finally {
        await setShape('once-per-query');
      }
      expect(perRow, 'the visible row set of at least one relation differs between the per-row and once-per-query policy shapes').toEqual(shipped);
    } finally {
      await c.end();
    }
    await shippedShapeIsBack();
  }, 180_000);

  it('the POLICY ROLE restrictions and the PUBLIC surface are untouched on all four relations', async () => {
    // Obligations 8, 10 and 11, and an honest note on what each can mean
    // here: a GRANT is not a function of policy shape, so asserting that
    // privileges are equal "under both shapes" would be vacuous by
    // construction. What is NOT vacuous is the absolute state — PUBLIC holds
    // nothing, and the two internal read policies are still restricted TO a
    // role rather than having become a PUBLIC `USING (true)`, which is the
    // one way an `ALTER POLICY` file could have widened the read surface
    // without dropping or creating a single policy.
    const r = await ownerPool().query<{ relname: string; polname: string; restricted: boolean }>(
      `SELECT c.relname, p.polname, (p.polroles <> '{0}'::oid[]) AS restricted
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1)
          AND p.polname IN ('inventory_internal_read', 'accounting_validator')
        ORDER BY 1, 2`,
      [[...RELATIONS]],
    );
    expect(r.rows.length, 'the two internal read policies must exist on each of the four relations').toBe(RELATIONS.length * 2);
    for (const row of r.rows) expect(row.restricted, `${row.relname}.${row.polname} lost its TO <role> and is now a PUBLIC USING (true)`).toBe(true);

    const pub = await ownerPool().query<{ relname: string; priv: string }>(
      `SELECT c.relname, pr.priv
         FROM pg_class c
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS pr(priv)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1)
          AND has_table_privilege('public', c.oid, pr.priv)
        ORDER BY 1, 2`,
      [[...RELATIONS]],
    );
    expect(pub.rows, 'PUBLIC must hold no table privilege on any of the four relations').toEqual([]);
  }, 120_000);

  it('the two INTERNAL principals read the same rows under both shapes — the escape inside a subselect is the same escape', async () => {
    for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
      const c = await connectAs('daftar_migrator', { tenantId: w.shop.tenantId, businessId: w.shop.businessId });
      try {
        await c.query(`SET ROLE ${role}`);
        const shipped = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n;
        expect(Number(shipped), `${role} reads no invoice at all, so an equality here would be vacuous`).toBeGreaterThan(0);
        let perRow: string | undefined;
        try {
          await setShape('per-row');
          perRow = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n;
        } finally {
          await setShape('once-per-query');
        }
        expect(perRow, `${role} sees a different number of invoices under the two shapes`).toBe(shipped);
      } finally {
        await c.end();
      }
    }
    await shippedShapeIsBack();
  }, 180_000);

  it('the WRITE path was not touched: every WITH CHECK and every write restrictive keeps the per-row form', async () => {
    const r = await ownerPool().query<{ relname: string; polname: string; q: string | null; w: string | null }>(
      `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY 1, 2`,
      [[...RELATIONS]],
    );
    expect(r.rows.length, 'the four relations carry seven policies each').toBe(RELATIONS.length * 7);
    for (const row of r.rows) {
      if (row.w !== null) expect(row.w, `${row.relname}.${row.polname} WITH CHECK was rewritten by a file that names no WITH CHECK`).not.toContain('( SELECT');
      if (!REWRITTEN.includes(row.polname as (typeof REWRITTEN)[number]))
        expect(row.q ?? '', `${row.relname}.${row.polname} is not named by 0086 and must be untouched`).not.toContain('( SELECT');
    }
  }, 60_000);

  it('row security is still ENABLED and FORCED on all four relations (§91)', async () => {
    const r = await ownerPool().query<{ relname: string; e: boolean; f: boolean }>(
      `SELECT relname, relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1::text[]) ORDER BY 1`,
      [[...RELATIONS]],
    );
    expect(r.rows.map((x) => `${x.relname} ${x.e} ${x.f}`)).toEqual(RELATIONS.map((n) => `${n} true true`).sort());
  }, 60_000);
});
