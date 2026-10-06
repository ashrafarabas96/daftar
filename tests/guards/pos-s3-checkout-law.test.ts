/**
 * P4-S3 — THE STRUCTURAL LAW OF THE ATOMIC POS CHECKOUT (TL-P4-S3-R1).
 *
 * This is a LAW: it reads the TREE and refuses one. It needs no database and
 * no HTTP — the behavioural halves are
 * `tests/integration/pos-s3-checkout.test.ts` and
 * `tests/integration/pos-s3-checkout-interleaving.test.ts`.
 *
 * The three claims it exists for, and each is a thing a future edit could
 * silently undo while every behavioural case stayed green:
 *
 *   1. **THERE IS NO SECOND SALE WRITER.** `[[daftar-no-second-writer]]`. The
 *      checkout may call the sale authority and may not become one. A law
 *      that read "no duplicate arithmetic" out of a human review is a law
 *      nobody re-reads; this one reads the module's own source and refuses a
 *      write to any financial relation, a second `sale_commit`, a second
 *      posting, a price computation and a second COGS or invoice path.
 *   2. **THE CONSUMPTION IS BOUND TO THE SNAPSHOT.** A `DELETE`, a
 *      table-level `UPDATE`, or any statement that clears "the active lines"
 *      rather than named rows is the replay defect TL-P4-S3-R1 calls
 *      critical, and it is refused HERE as a shape rather than only observed
 *      as a behaviour.
 *   3. **THE REPLAY PROOF COMES BEFORE THE STATE READ.**
 *      `[[daftar-registry-before-state]]`. The order of two calls inside one
 *      function is not something an integration test can see once both are
 *      correct, so it is asserted over the source.
 *
 * ── EACH LAW IS PROVED RED ───────────────────────────────────────────────
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. Every rule below is a
 * FUNCTION over a source text, and each one is driven over a PLANTED text
 * that breaks exactly it — so a rule that stopped refusing anything is red
 * here rather than quietly green over the real file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POS_ROUTE_AUTHORITY, P4_S3_REQUIRED_CONTROLLERS } from '../../apps/api/src/modules/pos/pos-permissions';
import { POS_CHECKOUT_FIELDS, assertNoClientCheckoutAuthority } from '../../apps/api/src/modules/pos/pos-checkout.schemas';
import { mergeByStockKey, type CartSnapshotLine } from '../../apps/api/src/modules/pos/pos-checkout.service';
import { POS_CODES, isPosCode, posRefusal } from '../../apps/api/src/modules/pos/pos-errors';
import { isSellingCode } from '../../apps/api/src/modules/selling/selling-errors';

const REPO = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const SERVICE = 'apps/api/src/modules/pos/pos-checkout.service.ts';
const SALE_WRITER = 'apps/api/src/modules/selling/sale-commit.service.ts';
const CONTROLLER = 'apps/api/src/modules/pos/till-sessions.controller.ts';

/** Prose carries the names the rules look for, so every rule reads CODE and never a comment. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const CHECKOUT_CODES = POS_CODES.filter((c) => c.startsWith('pos.checkout_'));

// ── the rules, as functions, so each can be driven over a planted text ────

/**
 * RULE 1 — the checkout writes no financial relation. It names the sale
 * authority and calls it; it does not `INSERT` or `UPDATE` one.
 */
export function secondWriterProblems(source: string): string[] {
  const body = code(source);
  const problems: string[] = [];
  const relations = [
    'sales',
    'sale_items',
    'invoices',
    'invoice_items',
    'stock_movements',
    'stock_levels',
    'journal_entries',
    'journal_lines',
    'accounting_source_bindings',
  ];
  for (const relation of relations) {
    const write = new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${relation}\\b`, 'i');
    if (write.test(body)) problems.push(`the POS checkout writes ${relation} — the sale authority is the one writer of it`);
  }
  for (const routine of ['sale_commit', 'inventory_apply_stock_movements', 'accounting_post_entry', 'invoice_number_allocate']) {
    if (new RegExp(`\\b${routine}\\s*\\(`).test(body))
      problems.push(`the POS checkout calls ${routine} itself — it must go through the accepted sale primitive`);
  }
  if (/postEntryInTransaction|authorizeSaleCommit|SalePostingService|DatabaseAccountingPostingAdapter/.test(body))
    problems.push('the POS checkout reaches a posting authority directly — the sale writer mints and posts, and this service does neither');
  return problems;
}

/** RULE 2 — the checkout derives no money. Every figure is the sale writer's. */
export function priceArithmeticProblems(source: string): string[] {
  const body = code(source);
  const problems: string[] = [];
  for (const name of [
    'halfEvenDiv',
    'convertToBaseMinor',
    'unitPriceC10',
    'grossTxnMinor',
    'netTxnMinor',
    'subtotalTxnMinor',
    'totalTxnMinor',
    'baseShareMinor',
    'cogs',
    'readFx',
    'fxRate',
  ])
    if (new RegExp(`\\b${name}\\b`).test(body)) problems.push(`the POS checkout names ${name} — a sale figure it would then be a second derivation of`);
  return problems;
}

/**
 * RULE 3 — the consumption names its rows. No `DELETE`, no table-level
 * `UPDATE` of the basket, and no statement clearing the live lines.
 */
export function consumptionShapeProblems(source: string): string[] {
  const body = code(source);
  const problems: string[] = [];
  if (/\bDELETE\s+FROM\s+pos_cart_lines\b/i.test(body))
    problems.push('the POS checkout DELETEs cart lines — a removal is a tombstone and a basket is the record of its shift');
  if (/\bUPDATE\s+pos_cart_lines\b/i.test(body))
    problems.push('the POS checkout UPDATEs pos_cart_lines directly — the tombstone is pos_cart_remove_line, one named row at a time');
  if (!/pos_cart_remove_line\s*\(\s*\$1::uuid,\s*\$2::uuid\s*\)/.test(body))
    problems.push('the POS checkout does not call pos_cart_remove_line by its two-id signature — the consumption must name one row per call');
  if (!/for\s*\(const \{ line \} of removals\)/.test(body))
    problems.push('the consumption does not walk the BOUND snapshot — a loop over anything else is a basket the sale was not derived from');
  return problems;
}

/**
 * RULE 4 — the order of the proof, the one argument it cannot see, and the
 * state (`[[daftar-registry-before-state]]`, and the
 * `customer_credit_application` precedent).
 *
 * This rule used to say only "the proof comes before every state read", and
 * THAT IS THE LAW THAT HELD THE DEFECT IN PLACE. `opened_by` is the
 * `invctl/1` assertion's actor and appears in no POS payload grammar, so the
 * sale's intent digest cannot carry the authenticated user; while the
 * ownership refusal sat after `provenReplay`, a colleague who delivered an
 * already-committed `saleId` was answered `200` with the drawer's sale, its
 * totals and its `cogsBaseMinor`, and `pos.session_not_owned` — OD-P4-09's
 * whole sentence — was never reached. A law that forbids reading the session
 * at all cannot tell that case from the one it was written for.
 *
 * So the rule now states the ORDER in three parts, and each part is the half
 * of the ruling the other cannot express:
 *
 *   (a) the CART is read after the proof. That is what
 *       `[[daftar-registry-before-state]]` is actually about here: the cart is
 *       the state the sale is derived from, and a handler that derived a sale
 *       from the basket before consulting the proof would perform a second
 *       real change on a stale retry.
 *   (b) `pos.session_not_owned` is judged BEFORE the proof, and the only
 *       thing between the session read and the proof is that one refusal — so
 *       the read cannot grow into a decision the proof has not seen.
 *   (c) `pos.session_not_open` is judged AFTER the proof. A cashier who
 *       checks out and then closes her till is entitled to have her own retry
 *       answered from the stored sale; refusing it is the false conflict in
 *       another spelling.
 */
export function proofBeforeStateProblems(source: string): string[] {
  const body = code(source);
  const run = body.slice(body.indexOf('private async run('), body.indexOf('private async consume('));
  if (run === '') return ['the POS checkout has no run() to judge'];
  const proof = run.indexOf('this.provenReplay(');
  const session = run.indexOf('this.readSession(');
  const cart = run.indexOf('this.readCartSnapshot(');
  const notOwned = run.indexOf("'pos.session_not_owned'");
  const notOpen = run.indexOf("'pos.session_not_open'");
  const problems: string[] = [];
  if (proof < 0) problems.push('the checkout consults no replay proof at all');
  if (session < 0 || cart < 0) problems.push('the checkout reads no session or no cart — there is no state read to be ordered against');
  if (notOwned < 0) problems.push('the checkout never refuses pos.session_not_owned — OD-P4-09 is the whole point of one session, one user');
  if (notOpen < 0) problems.push('the checkout never refuses pos.session_not_open');
  // (a) the cart, the state the sale is derived from, comes after the proof.
  if (proof >= 0 && cart >= 0 && proof > cart) problems.push('the checkout reads the cart BEFORE proving which command it is replaying');
  // (b) the one argument the digest cannot carry is judged first, and the
  //     session read exists for nothing else until the proof has answered.
  if (proof >= 0 && notOwned >= 0 && notOwned > proof)
    problems.push(
      'the checkout judges pos.session_not_owned AFTER the replay proof — an argument the intent digest cannot carry must be judged before the branch that answers on the digest alone',
    );
  if (proof >= 0 && session >= 0 && session > proof)
    problems.push('the checkout reads the till session AFTER the proof, so the owner cannot have been judged first');
  if (proof >= 0 && session >= 0 && session < proof) {
    const between = run.slice(run.indexOf('\n', session) + 1, run.lastIndexOf('\n', proof) + 1);
    const executable = between
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    const permitted = /^if \(session !== null && session\.openedBy !== m\.userId\) throw posRefusal\('pos\.session_not_owned'\);$/;
    for (const line of executable)
      if (!permitted.test(line)) problems.push(`the checkout does something other than the ownership refusal between the session read and the proof: ${line}`);
  }
  // (c) the status refusal stays after the proof, so the owner's own retry
  //     still replays once the shift is closed.
  if (proof >= 0 && notOpen >= 0 && notOpen < proof)
    problems.push('the checkout refuses pos.session_not_open BEFORE the replay proof — a cashier who closed her till could not retry her own checkout');
  return problems;
}

/** RULE 5 — the seam extraction is real: the sale writer still owns `plan`, `execute` and the minting. */
export function seamExtractionProblems(saleWriter: string, checkoutSource: string): string[] {
  const problems: string[] = [];
  const writer = code(saleWriter);
  for (const member of ['async plan(', 'async execute(', 'seamAuthority('])
    if (!writer.includes(member))
      problems.push(`the sale writer no longer exposes ${member} — the POS checkout reuses the accepted sale through exactly these three`);
  if (!/this\.authorization\.mint\(plan\.authority, plan\.built\.payload\)/.test(writer))
    problems.push('the sale writer no longer mints its own inventory assertion inside seamAuthority — a caller minting it would be a second authority');
  const checkout = code(checkoutSource);
  for (const call of ['this.sales.plan(', 'this.sales.seamAuthority(', 'this.sales.execute('])
    if (!checkout.includes(call)) problems.push(`the POS checkout does not call ${call} — it would then not be using the one sale writer`);
  if (!/withBusinessInventoryAccountingTransaction/.test(checkout))
    problems.push('the POS checkout opens no transaction of its own — the cart tombstones would then commit separately from the sale');
  return problems;
}

describe('rule 1: the POS checkout is not a second sale writer', () => {
  it('the real module writes no financial relation, calls no financial routine and reaches no posting authority', () => {
    expect(secondWriterProblems(read(SERVICE))).toEqual([]);
  });

  it('red: rule 1 names a planted INSERT into sales, a planted sale_commit call and a planted posting', () => {
    expect(secondWriterProblems(`const q = 'INSERT INTO sales (id) VALUES ($1)';`)).toHaveLength(1);
    expect(secondWriterProblems(`await tx.query('SELECT sale_commit($1)');`)).toHaveLength(1);
    expect(secondWriterProblems(`await this.posting.postEntryInTransaction(tx.accounting, cmd);`)).toHaveLength(1);
    expect(secondWriterProblems(`UPDATE stock_levels SET on_hand = 0`)).toHaveLength(1);
    // And a COMMENT naming the same thing is NOT a violation: a rule that
    // judged prose would push the next author to delete the explanation.
    expect(secondWriterProblems(`/* never INSERT INTO sales here */\n// and never sale_commit(...)\nconst x = 1;`)).toEqual([]);
  });
});

describe('rule 2: the POS checkout derives no money', () => {
  it('the real module names no sale figure and no conversion', () => {
    expect(priceArithmeticProblems(read(SERVICE))).toEqual([]);
  });

  it('red: rule 2 names a planted total, a planted conversion and a planted COGS', () => {
    expect(priceArithmeticProblems(`const totalTxnMinor = a + b;`)).toHaveLength(1);
    expect(priceArithmeticProblems(`const base = convertToBaseMinor({});`)).toHaveLength(1);
    expect(priceArithmeticProblems(`const cogs = 0n;`)).toHaveLength(1);
  });
});

describe('rule 3: the consumption names its rows, and a replay therefore cannot clear a basket', () => {
  it('the real module tombstones through the accepted routine, one bound row at a time', () => {
    expect(consumptionShapeProblems(read(SERVICE))).toEqual([]);
  });

  it('red: rule 3 names a planted DELETE, a planted table-level UPDATE and a missing routine call', () => {
    const real = read(SERVICE);
    expect(consumptionShapeProblems(`${real}\nconst bad = 'DELETE FROM pos_cart_lines WHERE till_session_id = $1';`)).toHaveLength(1);
    expect(consumptionShapeProblems(`${real}\nconst bad = 'UPDATE pos_cart_lines SET removed_at = now() WHERE removed_at IS NULL';`)).toHaveLength(1);
    // The most dangerous shape of all, and the one the ruling calls critical:
    // clearing every active line instead of the ones the sale was made from.
    expect(consumptionShapeProblems(real.replace(/pos_cart_remove_line\(\$1::uuid, \$2::uuid\)/, "x'"))).not.toEqual([]);
  });
});

describe('rule 4: the owner first, then the proof, then the state', () => {
  it('the real module judges the owner, proves the command, and only then reads the basket', () => {
    expect(proofBeforeStateProblems(read(SERVICE))).toEqual([]);
  });

  it('red: THE DEFECT ITSELF — the ownership refusal moved back behind the proof', () => {
    const real = read(SERVICE);
    const defective = real
      .replace("if (session !== null && session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');", '')
      .replace(
        "if (session.status !== 'open') throw posRefusal('pos.session_not_open');",
        "if (session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');\n    if (session.status !== 'open') throw posRefusal('pos.session_not_open');",
      );
    expect(proofBeforeStateProblems(defective)).toContain(
      'the checkout judges pos.session_not_owned AFTER the replay proof — an argument the intent digest cannot carry must be judged before the branch that answers on the digest alone',
    );
  });

  it('red: the status refusal pulled AHEAD of the proof, which breaks a closed till’s own retry', () => {
    const real = read(SERVICE);
    const defective = real
      .replace("if (session.status !== 'open') throw posRefusal('pos.session_not_open');", '')
      .replace(
        "if (session !== null && session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');",
        "if (session !== null && session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');\n    if (session !== null && session.status !== 'open') throw posRefusal('pos.session_not_open');",
      );
    expect(proofBeforeStateProblems(defective)).toContain(
      'the checkout refuses pos.session_not_open BEFORE the replay proof — a cashier who closed her till could not retry her own checkout',
    );
  });

  it('red: a SECOND sentence smuggled between the session read and the proof', () => {
    const real = read(SERVICE);
    const defective = real.replace(
      "if (session !== null && session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');",
      "if (session !== null && session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');\n    const sneaky = await this.readCartSnapshotEarly(m, tillSessionId);",
    );
    expect(proofBeforeStateProblems(defective).join(' | ')).toContain('does something other than the ownership refusal between the session read and the proof');
  });

  it('red: the cart read pulled ahead of the proof, and a run() with no proof at all', () => {
    const reversed = `private async run(a) {
      const session = await this.readSession(m, id);
      if (session !== null && session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');
      const snapshot = await this.readCartSnapshot(m, id);
      const replay = await this.provenReplay(m, id, input);
      if (session.status !== 'open') throw posRefusal('pos.session_not_open');
    }
    private async consume(b) {}`;
    expect(proofBeforeStateProblems(reversed)).toContain('the checkout reads the cart BEFORE proving which command it is replaying');
    expect(
      proofBeforeStateProblems(
        `private async run(a) { const s = await this.readSession(m, id); const c = await this.readCartSnapshot(m, id); } private async consume(b) {}`,
      ),
    ).toContain('the checkout consults no replay proof at all');
  });
});

describe('rule 5: the accepted sale primitive is REUSED, not reimplemented', () => {
  it('the sale writer exposes the three members and the checkout calls all three inside its own transaction', () => {
    expect(seamExtractionProblems(read(SALE_WRITER), read(SERVICE))).toEqual([]);
  });

  it('red: rule 5 names a sale writer that lost seamAuthority and a checkout that stopped calling execute', () => {
    const writer = read(SALE_WRITER);
    const checkout = read(SERVICE);
    expect(seamExtractionProblems(writer.replace(/seamAuthority\(/g, 'mintItAgain('), checkout)).not.toEqual([]);
    expect(seamExtractionProblems(writer, checkout.replace(/this\.sales\.execute\(/g, 'this.ownExecute('))).toContain(
      'the POS checkout does not call this.sales.execute( — it would then not be using the one sale writer',
    );
    expect(seamExtractionProblems(writer, checkout.replace(/withBusinessInventoryAccountingTransaction/g, 'withPlainTransaction'))).toContain(
      'the POS checkout opens no transaction of its own — the cart tombstones would then commit separately from the sale',
    );
  });
});

describe('the request states nothing the server derives', () => {
  it('the accepted keys are the sale HEADER and nothing about the basket', () => {
    expect([...POS_CHECKOUT_FIELDS].sort()).toEqual(['customerId', 'documentDate', 'dueDate', 'notes', 'saleId', 'settlementMode', 'taxMinor'].sort());
    for (const absent of ['lines', 'warehouseId', 'branchId', 'currency', 'discountMinor', 'totalMinor', 'subtotalMinor', 'unitPriceMinor'])
      expect(POS_CHECKOUT_FIELDS, `${absent} is a figure or a scope the SERVER owns and must not be a checkout field`).not.toContain(absent);
  });

  it('red: a forged total, a forged basket and an unknown key are each refused BY NAME', () => {
    const ok = { saleId: 'x', settlementMode: 'cash', customerId: null, documentDate: '2026-01-01', dueDate: null, taxMinor: '0', notes: null };
    expect(() => assertNoClientCheckoutAuthority(ok)).not.toThrow();
    const refusal = (body: unknown): string => {
      try {
        assertNoClientCheckoutAuthority(body);
      } catch (e) {
        return String((e as { details?: { sellingCode?: string } }).details?.sellingCode ?? 'none');
      }
      return 'none';
    };
    expect(refusal({ ...ok, cartTotalMinor: '1' })).toBe('pos.checkout_price_authority_refused');
    expect(refusal({ ...ok, unitPriceMinor: '1' })).toBe('pos.checkout_price_authority_refused');
    expect(refusal({ ...ok, lines: [] })).toBe('pos.checkout_price_authority_refused');
    expect(refusal({ ...ok, somethingElse: 1 })).toBe('pos.cart_field_unknown');
    // A nested object is refused too: no accepted field of a checkout has one.
    expect(refusal({ ...ok, notes: { total: '1' } })).toBe('pos.checkout_price_authority_refused');
  });
});

describe('the refusal vocabulary and the route authority', () => {
  it('every checkout code is in the ONE canonical registry, with a pinned status', () => {
    expect(CHECKOUT_CODES.length, 'the checkout registered no code of its own').toBeGreaterThan(0);
    for (const c of CHECKOUT_CODES) {
      expect(isSellingCode(c)).toBe(true);
      expect(isPosCode(c)).toBe(true);
    }
    expect(Object.fromEntries(CHECKOUT_CODES.map((c) => [c, posRefusal(c).httpStatus]))).toEqual({
      'pos.checkout_cart_empty': 409,
      'pos.checkout_cart_state_changed': 409,
      'pos.checkout_idempotency_conflict': 409,
      'pos.checkout_price_authority_refused': 400,
    });
  });

  it('red: a checkout code the registry does not hold is not a refusal at all', () => {
    expect(isPosCode('pos.checkout_made_up')).toBe(false);
    expect(isPosCode('pos.checkout_cart_state_changed')).toBe(true);
  });

  it('the route is on the POS authority table, under the cashier’s own ORDINARY key, and the controller mounts it', () => {
    const row = POS_ROUTE_AUTHORITY.find((r) => r.path === '/v1/pos/till-sessions/:sessionId/checkout');
    expect(row, 'the checkout route is not in POS_ROUTE_AUTHORITY, so no reviewer reads its authority').toBeDefined();
    expect(row?.method).toBe('POST');
    expect(row?.permission, 'ringing a basket up IS selling: no thirteenth permission is invented').toBe('sales.create');
    expect(row?.sensitive, 'the SENSITIVE discount key is checked against the CART, never declared on the route').toBe(false);
    const controller = read(CONTROLLER);
    // The literal, because `discoverPhase4Routes` reads the SOURCE TEXT with a
    // regex and a path assembled at runtime would be invisible to the gate and
    // to the golden that is checked against it.
    expect(controller).toContain("@Post(':sessionId/checkout')");
    expect(controller, 'a checkout that answered 201 would tell a till it had made a second sale on a replay').toMatch(
      /@Post\(':sessionId\/checkout'\)\s*\n\s*@HttpCode\(200\)/,
    );
    // No new controller: the route lives on the till-session surface that both
    // Nest compositions already register.
    expect(P4_S3_REQUIRED_CONTROLLERS).toEqual(['PosCartController', 'PosReadsController', 'TillSessionsController']);
  });
});

describe('the merge: two scans of one product become one sale line carrying their total', () => {
  const line = (id: string, lineNo: number, productId: string, qtyQ4: bigint, discountMinor = 0n): CartSnapshotLine => ({
    cartLineId: id,
    lineNo,
    productId,
    merchantVariantId: null,
    qtyQ4,
    discountMinor,
  });

  it('the quantities and the discount requests are summed as EXACT INTEGERS, and the group keeps the first line’s id', () => {
    const merged = mergeByStockKey([line('a', 1, 'p', 15_000n, 25n), line('b', 2, 'q', 10_000n), line('c', 3, 'p', 5_000n, 75n)]);
    expect(
      merged.map((m) => m.cartLineId),
      'the representative is the FIRST cart line of its group, so a sale line id is still a cart line id',
    ).toEqual(['a', 'b']);
    expect(merged[0]?.qtyQ4, '1.5 + 0.5 is exactly 2, in Q4 integers and never in a float').toBe(20_000n);
    expect(merged[0]?.discountMinor).toBe(100n);
    expect(merged[1]?.qtyQ4).toBe(10_000n);
  });

  it('red: a merge that kept duplicates would hand the sale writer two lines on one key', () => {
    // The defect this function exists to prevent, stated as the thing that
    // would be true without it: the raw snapshot has two rows for `p`, and
    // `sale_commit` answers `inventory.duplicate_line` for exactly that.
    const raw = [line('a', 1, 'p', 15_000n), line('c', 2, 'p', 5_000n)];
    expect(new Set(raw.map((l) => l.productId)).size).toBe(1);
    expect(raw).toHaveLength(2);
    expect(mergeByStockKey(raw)).toHaveLength(1);
    // And a different variant of one product is NOT merged: they are two
    // stock keys and two movements.
    const twoKeys = [
      { ...line('a', 1, 'p', 1n), merchantVariantId: 'v1' },
      { ...line('b', 2, 'p', 1n), merchantVariantId: 'v2' },
    ];
    expect(mergeByStockKey(twoKeys)).toHaveLength(2);
  });

  it('an empty snapshot merges to nothing, and a single line is returned unchanged', () => {
    expect(mergeByStockKey([])).toEqual([]);
    expect(mergeByStockKey([line('a', 1, 'p', 30_000n, 5n)])).toEqual([line('a', 1, 'p', 30_000n, 5n)]);
  });
});
