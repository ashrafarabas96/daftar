/**
 * P4-S2 — THE ATOMIC SALE LAW BY FAILURE INJECTION AT EVERY SEAM.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md §15, P4-AL-16 ("one transaction, or no
 *  sale"), §17 G-06; docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §4.)
 *
 * P4-AL-16 lists what a confirmed sale performs in ONE transaction: the `sales`
 * row and its items; the stock movements through
 * `inventory_apply_stock_movements`; the `stock_levels` update that routine
 * performs; the COGS journal entry; the `invoices` row and its items; the
 * invoice number allocation; the revenue/AR/tax entry; and, for a cash sale,
 * the payment, its allocation and the settlement entry. "There is no
 * intermediate state in which stock left the shelf and no invoice exists, or
 * an invoice exists and no movement was written."
 *
 * This suite is the only thing that can make that sentence a fact rather than
 * an intention: it extends the `expectNothingSurvives` idiom of
 * `tests/integration/inventory-s3-atomicity.test.ts:93-103` to a failure at
 * EVERY seam of the commit path, and requires that nothing at all survives
 * each one.
 *
 * ── HOW A SEAM IS INJECTED, AND WHY THE SEAM SET IS DISCOVERED ────────────
 *
 * Two injectors, because the commit path has two kinds of seam:
 *
 *   (a) INSIDE the transaction, at each RELATION the path writes. A `BEFORE
 *       INSERT OR UPDATE` trigger that raises is installed on one relation,
 *       the sale is confirmed, and the census must show that NOTHING survived
 *       — not the `sales` row, not the movements, not the bridge, not the
 *       entries, not the bindings, not the invoice, not the audit row. The
 *       trigger is dropped in a `finally`. This injector needs no cooperation
 *       from the service: it reaches seams no spy outside the transaction can
 *       reach, including the ones inside the SQL routine, and it is exactly as
 *       surgical as "the write at this point failed".
 *
 *   (b) AT THE POSTING PORT, which is where `inventory-s3-atomicity` injects.
 *       The sale posts TWICE (the COGS entry, then the revenue entry), so the
 *       port is failed on the FIRST call and, separately, on the SECOND — two
 *       distinct seams that bracket the invoice.
 *
 * The seam SET for (a) is DISCOVERED: an uninjected sale is run first, and
 * every relation whose row count moved is a seam. A relation the commit path
 * writes that nobody listed is therefore injected the day it is written, which
 * is the opposite of the hand-maintained-list failure mode
 * (`[[daftar-a-closure-rule-is-not-an-invariant]]`). The relations P4-AL-16
 * names by hand are asserted as a FLOOR of that discovered set, never as an
 * equality — a later slice adding a relation to the sale path must not turn
 * this red for being a later slice.
 *
 * ── RED UNTIL THE P4-S2 PRIMITIVE LANDS ───────────────────────────────────
 *
 * By the canary, with the missing names in the message. Not skipped and not
 * conditional. The seam loop is generated from the discovered set, so while
 * the subject is absent there is one canary test and no silent zero-case loop:
 * a `for` over an empty discovered set would be the vacuity defect wearing the
 * costume of a passing suite.
 *
 * Not named `phase4-*` or `p4-*`: the SEALED `scripts/phase4-s1-gate.ts`
 * (`suiteProblems`, :750-753) fails any such suite in `tests/integration`,
 * `tests/security` or `tests/performance` that no `S1_SUITES` entry lists.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  blockedBehind,
  census,
  censusDelta,
  existingRelations,
  must,
  parkRow,
  requireSubject,
  saleSubject,
  waitUntilQueued,
  SALE_COMMIT_ROUTINE,
  type Census,
  type Park,
  type SaleSubject,
} from '../golden-regression/phase4-s2/harness';
import { ownerClient } from '../helpers/stock-ledger';
import { lexBody } from '../helpers/phase3-surface';
import { confirmSale, seedSaleFixtures } from '../golden-regression/phase4-s2/sale-path';

/** The relations P4-AL-16 names by hand. A FLOOR of the discovered seam set, never an equality. */
const P4_AL_16_FLOOR: readonly string[] = [
  'sales',
  'sale_items',
  'stock_movements',
  // The GENERIC source binding the ledger carries for every source document,
  // and the parent `stock_source_bridge_sale` hangs from
  // (`stock_source_bridge_sale_binding_fk`). It was discovered as a written
  // seam and had no case of its own: a seam outside the injection set is a
  // seam at which a partial sale could survive unobserved, which is the one
  // thing this suite exists to rule out.
  'stock_source_bindings',
  'stock_source_bridge_sale',
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'invoices',
  'invoice_items',
];

/**
 * Relations the path reaches WITHOUT inserting a row, so a count delta cannot
 * discover them. They are added to the discovered set by name.
 *
 * `invoice_sequences` is here but is NOT in `TRIGGER_SEAMS`, and that is the
 * point of E-01: P4-AL-31 forbids a stored counter, so the routine takes the
 * series row `FOR NO KEY UPDATE`, reads `max(number_seq) + 1` and never
 * UPDATEs it. A `BEFORE UPDATE` trigger on it therefore never fires — the
 * injection observed nothing, the sale succeeded, and the case asserted a
 * refusal it then failed to get. The seam that matters here is reached by a
 * ROW LOCK, so it is proved by HOLDING that row in another session: see the
 * dedicated case below.
 *
 * TL-P4-S2-R4 added ONE write to the relation and did not change that: the
 * routine now creates the series row of a `(business, year)` on FIRST USE,
 * `INSERT … ON CONFLICT DO NOTHING`. In THIS suite `seedSaleFixtures` has
 * already seeded the row, so the sale's initialiser conflicts and inserts
 * nothing, which is why a count delta still cannot discover the relation and
 * why it is still named here. The initialiser has its own suite —
 * `tests/integration/sale-s2-sequence-init.test.ts` — which starts from
 * businesses that have seeded NOTHING, and the case below is extended to
 * police the shape of that one write: exactly one INSERT, `DO NOTHING`, and
 * still no UPDATE and no DELETE.
 */
const UPDATE_SEAMS: readonly string[] = ['stock_levels', 'invoice_sequences'];

/**
 * The seams a raising trigger can actually observe: every one the routine
 * WRITES, plus `stock_levels`, which it genuinely UPDATEs. Derived, so adding
 * a relation to the floor adds its case.
 */
const TRIGGER_SEAMS: readonly string[] = [...P4_AL_16_FLOOR, 'stock_levels'];

const CLAIM = 'a failure at any seam of the sale commit path leaves nothing behind';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let subject: SaleSubject;
let customerId: string;
let posting: DatabaseAccountingPostingAdapter | null = null;
/** The seams discovered from an uninjected sale, plus the update seams that exist. */
let seams: readonly string[] = [];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'atomic law owner');
  A = await onboardS3Business(t, owner, 's2atom');
  ({ customerId } = await seedSaleFixtures(ownerPool(), A, day));
  subject = await saleSubject(ownerPool());
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
  await stockUp('200');

  if (subject.missing.length === 0) {
    const before = await census(ownerPool(), A.businessId);
    const res = await sale();
    expect(res.status, 'the uninjected sale the seam set is discovered from is accepted').toBeLessThan(300);
    const moved = Object.entries(censusDelta(before, await census(ownerPool(), A.businessId)))
      .filter(([, n]) => n > 0)
      .map(([table]) => table);
    seams = [...new Set([...moved, ...(await existingRelations(ownerPool(), UPDATE_SEAMS))])].sort();
  }
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await t?.close();
  await resetData();
});

async function stockUp(quantity: string): Promise<void> {
  const res = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(owner, A.businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'atomicity fixture',
      lines: [{ productId: A.piece.productId, quantity, unitCost: '5' }],
    });
  expect(res.status, 'the fixture inbound adjustment is accepted').toBe(201);
}

/** A fresh credit sale of one unit. A fresh document id every time: a replay would be answered, not re-attempted. */
const sale = (): Promise<Response> =>
  confirmSale(t, asMember(owner, A.businessId), {
    saleId: randomUUID(),
    customerId,
    warehouseId: A.w1,
    branchId: A.branchX,
    occurredOn: day,
    lines: [{ productId: A.piece.productId, quantity: '1' }],
  });

/** (a) Raise inside the transaction at the first write to `relation`; drop the injector whatever happens. */
async function withRaisingTrigger<T>(relation: string, fn: () => Promise<T>): Promise<T> {
  const fname = `p4s2_inject_${relation}`;
  // `zz_` so it is the LAST BEFORE trigger alphabetically: the row's own
  // constraints and triggers have already run, so the failure lands as late in
  // the write as a trigger can.
  await ownerPool().query(
    `CREATE OR REPLACE FUNCTION ${fname}() RETURNS trigger LANGUAGE plpgsql AS
     $fx$ BEGIN RAISE EXCEPTION 'p4s2.injected_failure: a failure at the % seam of the sale commit path', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $fx$`,
  );
  await ownerPool().query(`CREATE TRIGGER zz_p4s2_inject BEFORE INSERT OR UPDATE ON ${relation} FOR EACH ROW EXECUTE FUNCTION ${fname}()`);
  try {
    return await fn();
  } finally {
    await ownerPool().query(`DROP TRIGGER IF EXISTS zz_p4s2_inject ON ${relation}`);
    await ownerPool().query(`DROP FUNCTION IF EXISTS ${fname}()`);
  }
}

/** Inject, confirm a sale, and prove the WHOLE business unchanged. */
async function expectNothingSurvives(inject: <T>(fn: () => Promise<T>) => Promise<T>, what: string): Promise<void> {
  const before: Census = await census(ownerPool(), A.businessId);
  const res = await inject(() => sale());
  expect(res.status >= 400, `${what}: the injected failure surfaces as a refusal rather than a success`).toBe(true);
  expect(censusDelta(before, await census(ownerPool(), A.businessId)), `${what}: NOTHING survives — not a row of any business-scoped relation`).toEqual({});
}

describe('P4-AL-16 one transaction, or no sale: a failure at every seam leaves nothing', () => {
  it('the subject exists: the sale commit primitive and its registrations are in the tree', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('the seam set was discovered, is non-empty, and covers every relation P4-AL-16 names', () => {
    requireSubject(subject.missing, CLAIM);
    expect(seams.length, 'NO SUBJECT — no seam was discovered, so the loop below would assert nothing').toBeGreaterThan(0);
    const missing = P4_AL_16_FLOOR.filter((r) => !seams.includes(r));
    expect(
      missing,
      `the sale wrote none of ${missing.join(', ')}, which P4-AL-16 says one transaction performs. A seam that is not written is not a seam ` +
        `this suite can inject at, and the law about it would be vacuous.`,
    ).toEqual([]);
  });

  // One `it` per seam, generated from the DISCOVERED set. A single `it` over
  // all of them would stop at the first surviving row and hide every seam
  // after it — the measurement defect that made P4-S1's breakage count grow
  // round after round instead of being known once.
  for (const relation of TRIGGER_SEAMS) {
    it(`a failure at the ${relation} seam leaves nothing`, async () => {
      requireSubject(subject.missing, CLAIM);
      expect(seams, `${relation} is not among the discovered seams, so this case has no subject`).toContain(relation);
      await expectNothingSurvives((fn) => withRaisingTrigger(relation, fn), `the ${relation} seam`);
    });
  }

  /**
   * THE PREMISE OF E-01, ASSERTED RATHER THAN ASSUMED.
   *
   * `invoice_sequences` is proved by HOLDING its row because the ORDINAL seam
   * is reached by a lock and by nothing else. That premise has been reported
   * twice as a defect — "the invoice_sequences injection does not fire" — and
   * both times the answer was that a row trigger cannot observe a row lock.
   * So the premise is a law now, stated in both directions, and a future edit
   * that puts the relation into the generated trigger set, or a migration
   * that starts UPDATEing the row, is refused HERE with the reason rather
   * than as an obscure "expected false to be true" inside a generated case.
   *
   * TL-P4-S2-R4 CORRECTED ONE HALF OF THE OLD PREMISE, AND THE LAW IS
   * NARROWER AND STRONGER FOR IT. The old reading was "the routine writes
   * this relation nowhere", which left a clean business with no path to its
   * first invoice number and was ruled a product blocker. The routine now
   * carries exactly ONE write: the first-use initialiser,
   * `INSERT … ON CONFLICT (business_id, document_kind, period) DO NOTHING`.
   * What the slice's privilege argument and P4-AL-31 actually need is that
   * the routine never REWRITES the row — no UPDATE, no DELETE, and no
   * `DO UPDATE` that would overwrite a merchant's `number_format` with the
   * default on every sale — and that is what is asserted below, together
   * with the count of initialisers, so a SECOND write cannot slip in beside
   * the first. The relation stays out of `TRIGGER_SEAMS` because the ordinal
   * seam this suite is about is still the LOCK, and because in this suite the
   * fixture has already created the row.
   *
   * The routine body is read through `lexBody`, the repo's own recogniser,
   * which strips `--` and block comments and replaces every single-quoted
   * literal with a placeholder. A law that grepped the raw text would be
   * satisfied — or broken — by a word in a comment or an error message.
   */
  it('invoice_sequences is LOCKED and never UPDATED, so the ordinal seam belongs to the held-lock case and not to the trigger set', async () => {
    requireSubject(subject.missing, CLAIM);
    // (a) the list invariant, both ways.
    expect(UPDATE_SEAMS, 'invoice_sequences is a seam, named because a count delta cannot discover it').toContain('invoice_sequences');
    expect(
      TRIGGER_SEAMS,
      'invoice_sequences is in TRIGGER_SEAMS: the ORDINAL seam is reached by the row lock the routine takes FOR NO KEY UPDATE, and a row ' +
        'trigger cannot observe a lock (P4-AL-31 forbids a stored counter, so there is no UPDATE to observe either). This suite seeds the ' +
        'series row, so the first-use initialiser of TL-P4-S2-R4 conflicts and writes nothing here. This seam is proved by the held-lock ' +
        'case below, through pg_blocking_pids; the initialiser is proved in tests/integration/sale-s2-sequence-init.test.ts.',
    ).not.toContain('invoice_sequences');

    // (b) the claim about the ROUTINE, from the live catalogue. `0078`'s
    //     `sale_commit` is the only writer of a sale, so it is the only body
    //     that could write the series row.
    const def = must(
      (
        await ownerPool().query<{ src: string }>(
          `SELECT pg_get_functiondef(p.oid) AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = $1`,
          [SALE_COMMIT_ROUTINE],
        )
      ).rows[0],
      `the ${SALE_COMMIT_ROUTINE} definition`,
    ).src;
    const { code } = lexBody(def);
    expect(code.length, `NO SUBJECT — ${SALE_COMMIT_ROUTINE}'s lexed body is empty, so both claims below read nothing`).toBeGreaterThan(0);
    expect(
      /invoice_sequences/i.test(code),
      `${SALE_COMMIT_ROUTINE} does not mention invoice_sequences at all, so this law has no subject and the seam is not the one it claims to be`,
    ).toBe(true);
    expect(
      /\bUPDATE\s+(?:public\.)?invoice_sequences\b/i.test(code),
      `${SALE_COMMIT_ROUTINE} UPDATEs invoice_sequences: the ordinal has become a stored counter (P4-AL-31), and the held-lock case below is no ` +
        `longer the only way to reach this seam`,
    ).toBe(false);
    expect(
      /\bFOR\s+NO\s+KEY\s+UPDATE\b/i.test(code) || /\bFOR\s+UPDATE\b/i.test(code),
      `${SALE_COMMIT_ROUTINE} takes no row lock at all, so nothing serialises two sales on the same series and the ordinal is racy`,
    ).toBe(true);
    expect(
      /\bDELETE\s+FROM\s+(?:public\.)?invoice_sequences\b/i.test(code),
      `${SALE_COMMIT_ROUTINE} DELETEs a series row, and a deleted series is a renumbered business`,
    ).toBe(false);

    // The ONE write TL-P4-S2-R4 added, and its shape. Exactly one, and it can
    // only ever CREATE: `DO UPDATE` would rewrite a merchant's number_format
    // with the default on every sale, which is the authority the column-level
    // grant of `0078` §1 deliberately withholds.
    const initialisers = [...code.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?invoice_sequences\b/gi)];
    expect(
      initialisers.length,
      `${SALE_COMMIT_ROUTINE} carries ${initialisers.length} inserts into invoice_sequences. TL-P4-S2-R4 asks for EXACTLY ONE — the first-use ` +
        `initialiser of a (business, year) series. None means a clean business has no path to its first invoice number again; two means there ` +
        `is a second, unreviewed way for a series row to come into existence.`,
    ).toBe(1);
    expect(
      /\bON\s+CONFLICT\b[^;]*\bDO\s+NOTHING\b/i.test(code),
      `${SALE_COMMIT_ROUTINE}'s series initialiser is not ON CONFLICT … DO NOTHING, so two concurrent first sales of one year are not decided by ` +
        `the primary key and the loser has no defined outcome`,
    ).toBe(true);
    expect(
      /\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b/i.test(code),
      `${SALE_COMMIT_ROUTINE} UPSERTS the series row: the default format would be written over a merchant's stated number_format on every sale`,
    ).toBe(false);

    // (c) the recognisers, PLANTED, because a `.toBe(false)` over a regex that
    //     matches nothing is the quietest vacuous pass there is. Both are
    //     proved to see a real write and to NOT see one written in a comment
    //     or inside a message — which is the whole reason the body is lexed.
    const plantedWrite = 'BEGIN UPDATE invoice_sequences SET number_seq = 1; END';
    expect(/\bUPDATE\s+(?:public\.)?invoice_sequences\b/i.test(lexBody(plantedWrite).code), 'the recogniser sees a real UPDATE of the series row').toBe(true);
    expect(
      /\bUPDATE\s+(?:public\.)?invoice_sequences\b/i.test(lexBody("BEGIN RAISE EXCEPTION 'never UPDATE invoice_sequences'; END").code),
      'and does not see one inside a message, so the law cannot be broken by its own documentation',
    ).toBe(false);
    expect(/\bUPDATE\s+(?:public\.)?invoice_sequences\b/i.test(lexBody('-- UPDATE invoice_sequences\nBEGIN NULL; END').code), 'nor one inside a comment').toBe(
      false,
    );
    // And the same for the initialiser recognisers, so neither the count nor
    // the DO NOTHING / DO UPDATE readings can be a vacuous pass.
    const plantedUpsert = lexBody(
      'BEGIN INSERT INTO invoice_sequences (period) VALUES (1) ON CONFLICT (business_id, document_kind, period) DO UPDATE SET number_format = 1; END',
    ).code;
    expect([...plantedUpsert.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?invoice_sequences\b/gi)].length, 'the counter sees a real initialiser').toBe(1);
    expect(/\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b/i.test(plantedUpsert), 'and the upsert recogniser sees a real DO UPDATE').toBe(true);
    expect(/\bON\s+CONFLICT\b[^;]*\bDO\s+NOTHING\b/i.test(plantedUpsert), 'and does not read a DO UPDATE as a DO NOTHING').toBe(false);
    expect(
      [...lexBody('-- INSERT INTO invoice_sequences\nBEGIN NULL; END').code.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?invoice_sequences\b/gi)].length,
      'nor does the counter see an initialiser written in a comment',
    ).toBe(0);
    expect(
      /\bDELETE\s+FROM\s+(?:public\.)?invoice_sequences\b/i.test(lexBody('BEGIN DELETE FROM invoice_sequences; END').code),
      'and the delete recogniser sees a real DELETE',
    ).toBe(true);
  });

  /**
   * E-01, THE SEAM THAT IS REACHED BY A LOCK AND NOT BY A WRITE.
   *
   * `invoice_sequences` is read `FOR NO KEY UPDATE` and never updated, so the only
   * way to be at that seam when the sale arrives is to be HOLDING the row.
   * The interleaving is FORCED, not hoped for: the series row is parked on a
   * connection of its own, the sale is launched once, and it is OBSERVED into
   * the lock queue through `pg_blocking_pids` before anything is asserted —
   * `waitUntilQueued` throws if the sale ever settles without parking, so a
   * sale that sailed past the seam is a FAILURE and never a pass. No sleep is
   * involved at any point: a verdict read out of an unforced interleaving is a
   * verdict about the machine's speed
   * (`[[daftar-a-test-whose-verdict-is-the-machines-speed]]`).
   */
  it('a sale held at the invoice_sequences seam has committed NOTHING, and serialises once the row is released', async () => {
    requireSubject(subject.missing, CLAIM);
    expect(seams, 'invoice_sequences is not among the discovered seams, so this case has no subject').toContain('invoice_sequences');

    const before: Census = await census(ownerPool(), A.businessId);
    let park: Park | null = null;
    const settledFlag = { done: false };
    let inFlight: Promise<Response> | null = null;
    try {
      park = await parkRow(
        () => ownerClient(),
        `SELECT 1 FROM invoice_sequences WHERE business_id = $1 AND document_kind = 'invoice' FOR UPDATE`,
        [A.businessId],
        'the invoice series row of this business',
      );
      const held = park;
      inFlight = sale().then(
        (r) => {
          settledFlag.done = true;
          return r;
        },
        (e: unknown) => {
          settledFlag.done = true;
          throw e;
        },
      );
      const queued = await waitUntilQueued([held.pid], 1, settledFlag, 'the sale at the invoice_sequences seam');
      expect(queued.length, 'the sale is queued behind the held series row — the seam is really reached by a row lock').toBeGreaterThanOrEqual(1);

      // Everything the routine has written so far is inside its own open
      // transaction, so a census taken from another connection must see NONE
      // of it. This is the atomicity half of the case: a sale stopped at this
      // seam has committed nothing, whatever it has already written.
      expect(
        censusDelta(before, await census(ownerPool(), A.businessId)),
        'a sale held at the invoice_sequences seam has committed NOTHING — not a row of any business-scoped relation',
      ).toEqual({});
      expect((await blockedBehind([held.pid])).length, 'and it is STILL queued after the census, so the census was taken mid-sale').toBeGreaterThanOrEqual(1);
    } finally {
      await park?.release();
    }

    // Released, it serialises: the ordinal it then reads is the one the lock
    // was protecting, and the sale commits. A seam that blocked and then
    // failed would be a lock-order or contention defect, not a business
    // outcome, and it is reported as the refusal it is.
    const res = await must(inFlight, 'the in-flight sale');
    expect(res.status, `once the series row is released the sale serialises and commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  });

  it('every discovered seam was covered by a case above, or is named here', () => {
    requireSubject(subject.missing, CLAIM);
    // The FLOOR is hand-written; the SET is discovered. This is the assertion
    // that stops the two from drifting apart silently: a relation the sale
    // writes that no case injects at is reported, rather than being quietly
    // outside the proof.
    const covered = new Set([...P4_AL_16_FLOOR, ...UPDATE_SEAMS, 'audit_events', 'outbox_events', 'inventory_assertion_uses', 'accounting_assertion_uses']);
    const uncovered = seams.filter((r) => !covered.has(r));
    expect(
      uncovered,
      `the sale writes ${uncovered.join(', ')}, and no case above injects a failure there. Add a case — a seam outside the injection set is a seam ` +
        `at which a partial sale could survive unobserved.`,
    ).toEqual([]);
  });

  it('a failure at the FIRST posting — after the stock movements, before the invoice — leaves nothing', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectNothingSurvives(async (fn) => {
      vi.spyOn(must(posting), 'postEntryInTransaction').mockRejectedValueOnce(new Error('injected: after the routine, before the first posting'));
      try {
        return await fn();
      } finally {
        vi.restoreAllMocks();
      }
    }, 'the first posting seam');
  });

  it('a failure at the SECOND posting — after the invoice, before the revenue entry commits — leaves nothing', async () => {
    requireSubject(subject.missing, CLAIM);
    await expectNothingSurvives(async (fn) => {
      const port = must(posting);
      const original = port.postEntryInTransaction.bind(port);
      let calls = 0;
      vi.spyOn(port, 'postEntryInTransaction').mockImplementation(async (...args: Parameters<typeof original>) => {
        calls += 1;
        if (calls >= 2) throw new Error('injected: after the invoice, before the second posting');
        return original(...args);
      });
      try {
        const res = await fn();
        expect(calls, 'the sale posts twice (the COGS entry and the revenue entry), so there IS a second seam to inject at').toBeGreaterThanOrEqual(2);
        return res;
      } finally {
        vi.restoreAllMocks();
      }
    }, 'the second posting seam');
  });
});
