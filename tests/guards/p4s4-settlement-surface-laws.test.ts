/**
 * P4-S4 — THE CONTRACT'S OWN STRUCTURAL RULINGS OVER THE SETTLEMENT TEXT, AND
 * A PLANTED RED PROOF FOR EACH ONE.
 *
 * The BUILD CONTRACT settles three things the implementation map left open, and
 * all three are the kind of ruling that is quietly lost between a document and
 * a migration. The law is `settlementContractProblems` in
 * `scripts/phase4-s4-gate.ts`; the gate applies it to every candidate
 * migration that creates one of the slice's relations, so the ruling is
 * enforced by the gate rather than remembered at review.
 *
 * ── DEPARTURE A — THE INVOICE-SIDE FK TAKES NO NEW KEY ON `invoices` ─────
 *
 * `invoices` is a table an earlier slice of THIS phase created and applied, so
 * adding `UNIQUE (business_id, id, customer_id)` to it is an ownership question
 * the Tech Lead has not answered. The FK is therefore the EXISTING primary key
 * `(business_id, id)` — and what the narrower key stops proving must then be
 * proved by `invoice_settlement_verify`, a `CREATE CONSTRAINT TRIGGER …
 * DEFERRABLE INITIALLY DEFERRED` of the same class the purchase chain already
 * relies on:
 *
 *   — the CUSTOMER IDENTITY PIN: the settling row's `customer_id` equals the
 *     invoice's. Refusal `invoice_settlement.customer_mismatch`;
 *   — the WALK-IN LAW: an invoice whose `customer_id IS NULL` carries no
 *     allocation and no credit application at all. Refusal
 *     `invoice_settlement.walkin_not_settleable`.
 *
 * Both halves can fail in two opposite directions, and the law states both: a
 * text that takes the three-column key has made a decision this slice was told
 * not to make, and a text that takes the two-column key with no deferred
 * verifier has dropped the guarantee on the floor. `[[daftar-a-deferred-
 * guarantee-is-still-a-guarantee]]` — neither may be left to the application
 * layer.
 *
 * ── THE SETTLEMENT ARITHMETIC IS REUSED, NEVER RE-IMPLEMENTED ────────────
 *
 * `supplier_convert_base`, `supplier_ap_release` and
 * `supplier_credit_remaining_carrying` are `IMMUTABLE`, take plain `BIGINT`,
 * and carry nothing supplier-specific but their names. A second body of that
 * arithmetic is a duplicate financial truth, so the law refuses a text that
 * DEFINES any of the three and refuses a settlement text that calls none of
 * them.
 *
 * ── WHY THE SUBJECT IS A FIXTURE AND NOT THE SLICE'S MIGRATION ───────────
 *
 * The slice's migration is being written in another worktree while this suite
 * is written. A law stated only against a file that does not exist yet is a
 * law nobody can show failing, so the subject here is a contract-shaped
 * fixture: the law is proved GREEN on a text that obeys every ruling and RED
 * on a copy of that text with ONE ruling broken, and the gate applies the same
 * function to whatever candidate migration the tree holds. Each plant is
 * required to have actually changed the text.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROW_LOCK_ONLY_ROUTINES,
  ROW_LOCK_ONLY_TABLES,
  SETTLEMENT_ARITHMETIC,
  SETTLEMENT_REFUSALS,
  SETTLEMENT_ROUTINES,
  SETTLEMENT_SOURCE_TYPES,
  SETTLEMENT_VERIFIER,
  routineBody,
  rowLockOnlyWriteProblems,
  settlementContractProblems,
  stripSqlComments,
} from '../../scripts/phase4-s4-gate';
import { MIGRATIONS_SUBDIR } from '../../scripts/guards/phase4-rls-force';

/** This repository's root, from this file's own location. */
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * A contract-shaped settlement text: the two child relations with the
 * Departure A two-column invoice FK, the deferred verifier with both named
 * refusals, and the three accepted arithmetic primitives CALLED and not
 * redefined.
 */
/**
 * One `CREATE OR REPLACE FUNCTION` per ruled routine the verifier is not,
 * generated FROM the ruling itself: a name added to `SETTLEMENT_ROUTINES` is
 * then declared by this fixture too, so the green case cannot silently fall
 * behind the law.
 */
const RULED_STUBS = SETTLEMENT_ROUTINES.filter((fn) => fn !== SETTLEMENT_VERIFIER)
  .map(
    (fn) =>
      `CREATE OR REPLACE FUNCTION ${fn}(p_business_id UUID, p_id UUID) RETURNS VOID\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;`,
  )
  .join('\n\n');

/**
 * The two registry statements, generated FROM the ruling: a source type added
 * to `SETTLEMENT_SOURCE_TYPES` is registered by this fixture too, so the green
 * case cannot fall behind the law.
 */
const SOURCE_TYPE_ROWS = [
  `INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES\n${SETTLEMENT_SOURCE_TYPES.map(
    (t, i) => `  ('${t}', 'none', 'not_after_today', 'A P4-S4 settlement source.', ${12 + i})`,
  ).join(',\n')};`,
  `INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES\n${SETTLEMENT_SOURCE_TYPES.map(
    (t) => `  ('post', '${t}', 'Derived by the settlement command.')`,
  ).join(',\n')};`,
].join('\n');

const SETTLEMENT_SQL = `
CREATE TABLE payments (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  customer_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  base_amount_minor BIGINT NOT NULL,
  CONSTRAINT payments_pk PRIMARY KEY (business_id, id)
);
CREATE TABLE payment_allocations (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  payment_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  invoice_amount_applied_minor BIGINT NOT NULL,
  ar_released_minor BIGINT NOT NULL,
  ar_dust_minor BIGINT NOT NULL,
  accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('customer_payment_allocation') STORED,
  CONSTRAINT payment_allocations_pk PRIMARY KEY (business_id, id),
  -- Departure A: the EXISTING primary key of invoices. A
  -- UNIQUE (business_id, id, customer_id) on invoices would make the customer
  -- pin and the walk-in law structural; 0067:274 is the accepted precedent for
  -- adding exactly such a key to an earlier slice's table, and it is deferred
  -- to a Tech Lead ruling rather than forgotten. The cross-relation guarantee
  -- rests on ${SETTLEMENT_VERIFIER} until then.
  CONSTRAINT payment_allocations_invoice_fk FOREIGN KEY (business_id, invoice_id)
    REFERENCES invoices (business_id, id) ON DELETE RESTRICT
);
CREATE TABLE customer_credits (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  customer_id UUID NOT NULL,
  remaining_minor BIGINT NOT NULL,
  remaining_carrying_minor BIGINT NOT NULL,
  accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('customer_credit') STORED,
  CONSTRAINT customer_credits_pk PRIMARY KEY (business_id, id)
);
CREATE TABLE customer_credit_applications (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  credit_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  invoice_amount_applied_minor BIGINT NOT NULL,
  ar_released_minor BIGINT NOT NULL,
  ar_dust_minor BIGINT NOT NULL,
  credit_dust_minor BIGINT NOT NULL,
  accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('customer_credit_application') STORED,
  CONSTRAINT customer_credit_applications_pk PRIMARY KEY (business_id, id),
  CONSTRAINT customer_credit_applications_invoice_fk FOREIGN KEY (business_id, invoice_id)
    REFERENCES invoices (business_id, id) ON DELETE RESTRICT
);

-- The settlement arithmetic is the ACCEPTED one. The names are historical; the
-- arithmetic is general (IMMUTABLE, plain BIGINT, nothing supplier-specific
-- but the name), so it is called here and never re-implemented.
CREATE OR REPLACE FUNCTION ${SETTLEMENT_VERIFIER}(p_business_id UUID, p_invoice_id UUID) RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_customer UUID;
  v_rel BIGINT;
BEGIN
  SELECT i.customer_id INTO v_customer FROM invoices i
   WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION '${SETTLEMENT_REFUSALS[1] ?? ''}: a walk-in invoice carries no allocation and no credit application'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations a
              WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id
                AND a.customer_id IS DISTINCT FROM v_customer) THEN
    RAISE EXCEPTION '${SETTLEMENT_REFUSALS[0] ?? ''}: the settling row names another customer than the invoice'
      USING ERRCODE = 'P0001';
  END IF;
  v_rel := supplier_ap_release(0, supplier_convert_base(0, 1.0), 0);
  PERFORM supplier_credit_remaining_carrying(0, 0, 0);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_allocations_settlement_verify
  AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ${SETTLEMENT_VERIFIER}();

-- The other RULED routine names of this slice: the two commands, the credit
-- chain verifier, and the internal-owned consume helper that is the only
-- writer of a credit's remaining pair. Declared here as stubs because this
-- fixture is the subject of a NAMING law, not of their bodies — the bodies are
-- the migration's, and the arithmetic they call is the accepted one above.
${RULED_STUBS}

-- (e) The registries, LAST, with the owning operation kind the 0046 rule
-- requires — the accepted shape of 0067:2280-2287. THREE source types: the
-- two allocation-side ones, and customer_credit, which carries a payment''s
-- surplus leg and is forced rather than chosen (a payment with zero
-- allocations has no allocation entry for that leg to ride).
${SOURCE_TYPE_ROWS}
`;

/** The problems naming `fragment`, so a plant's own finding is read rather than the whole list. */
const about = (problems: readonly string[], fragment: string): string[] => problems.filter((p) => p.includes(fragment));

/** A copy of the fixture with one ruling broken; the plant must really change the text. */
function planted(what: string, mutate: (sql: string) => string): string {
  const mutated = mutate(SETTLEMENT_SQL);
  expect(mutated === SETTLEMENT_SQL, `the plant "${what}" changed nothing, so the proof would prove nothing`).toBe(false);
  return mutated;
}

// ─────────────────────────────────────────────────────────────────────────

describe('the contract-shaped settlement text is accepted, and the silence is about real subjects', () => {
  it('the law is silent', () => {
    expect(settlementContractProblems(SETTLEMENT_SQL)).toEqual([]);
  });

  it('the silence is not vacuous: the text really does carry both refusals, the verifier and the deferred trigger', () => {
    expect(SETTLEMENT_REFUSALS.length).toBe(2);
    for (const code of SETTLEMENT_REFUSALS) expect(SETTLEMENT_SQL).toContain(code);
    expect(SETTLEMENT_SQL).toContain(SETTLEMENT_VERIFIER);
    expect(SETTLEMENT_SQL).toMatch(/CREATE CONSTRAINT TRIGGER/);
    expect(SETTLEMENT_SQL).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    for (const fn of SETTLEMENT_ARITHMETIC) expect(SETTLEMENT_SQL).toContain(fn);
  });

  it('a text that creates none of this slice’s relations is not judged against these rulings at all', () => {
    // A candidate migration about something else must not be refused for not
    // being the settlement migration.
    expect(settlementContractProblems('CREATE OR REPLACE FUNCTION invoice_outstanding(p UUID, q UUID) RETURNS BIGINT LANGUAGE sql AS $$ SELECT 0 $$;')).toEqual(
      [],
    );
  });
});

describe('RP-S4-DEP-A — Departure A, planted in both directions', () => {
  it('red: the three-column invoice FK — a new key on an earlier slice’s table — is named', () => {
    const sql = planted('the invoice FK widened to (business_id, id, customer_id)', (s) =>
      s.replace(
        'FOREIGN KEY (business_id, invoice_id)\n    REFERENCES invoices (business_id, id) ON DELETE RESTRICT\n);\nCREATE TABLE customer_credits',
        'FOREIGN KEY (business_id, invoice_id, customer_id)\n    REFERENCES invoices (business_id, id, customer_id) ON DELETE RESTRICT\n);\nCREATE TABLE customer_credits',
      ),
    );
    const problems = about(settlementContractProblems(sql), 'payment_allocations');
    expect(problems.join('\n')).toContain('Departure A');
  });

  it('red: no composite invoice FK at all is named — cross-business linkage must be unrepresentable', () => {
    const sql = planted('the invoice FK removed from payment_allocations', (s) =>
      s.replace(
        '  CONSTRAINT payment_allocations_invoice_fk FOREIGN KEY (business_id, invoice_id)\n    REFERENCES invoices (business_id, id) ON DELETE RESTRICT\n',
        '',
      ),
    );
    expect(about(settlementContractProblems(sql), 'declares no composite FOREIGN KEY')).not.toEqual([]);
  });

  it('red: the verifier missing while the narrower key is used is named — the guarantee would be on the floor', () => {
    const sql = planted('the deferred verifier deleted', (s) =>
      s.replace(new RegExp(String.raw`CREATE OR REPLACE FUNCTION ${SETTLEMENT_VERIFIER}[\s\S]*$`), ''),
    );
    const problems = settlementContractProblems(sql);
    expect(about(problems, SETTLEMENT_VERIFIER)).not.toEqual([]);
    expect(problems.join('\n')).toContain('may be left to the application layer');
  });

  it('red: a verifier that nothing fires at COMMIT is named — a declared verifier with no deferred trigger verifies nothing', () => {
    const sql = planted('the constraint trigger made immediate', (s) => s.replace('  DEFERRABLE INITIALLY DEFERRED\n', ''));
    expect(about(settlementContractProblems(sql), 'wires it')).not.toEqual([]);
  });

  it('red: the customer-mismatch refusal removed is named', () => {
    const code = SETTLEMENT_REFUSALS[0] ?? '';
    const sql = planted('the customer-mismatch refusal removed', (s) => s.split(code).join('invoice_settlement.some_other_thing'));
    expect(about(settlementContractProblems(sql), code)).not.toEqual([]);
  });

  it('red: the walk-in refusal removed is named', () => {
    const code = SETTLEMENT_REFUSALS[1] ?? '';
    const sql = planted('the walk-in refusal removed', (s) => s.split(code).join('invoice_settlement.some_other_thing'));
    expect(about(settlementContractProblems(sql), code)).not.toEqual([]);
  });
});

describe('RP-S4-NAMES — every RULED routine name, planted as a rename', () => {
  it('the ruling has subjects, and the green fixture declares every one of them', () => {
    expect(SETTLEMENT_ROUTINES.length).toBeGreaterThan(1);
    expect(SETTLEMENT_ROUTINES).toContain(SETTLEMENT_VERIFIER);
    for (const fn of SETTLEMENT_ROUTINES) expect(SETTLEMENT_SQL, `${fn} is not declared by the green fixture`).toContain(`FUNCTION ${fn}(`);
    expect(settlementContractProblems(SETTLEMENT_SQL)).toEqual([]);
  });

  it.each(SETTLEMENT_ROUTINES.map((fn) => [fn]))('red: %s renamed in the settlement text is named by the law', (fn: string) => {
    const sql = planted(`${fn} renamed`, (s) => s.split(`FUNCTION ${fn}(`).join('FUNCTION some_other_name('));
    const problems = about(settlementContractProblems(sql), fn);
    expect(problems, `${fn} was renamed and the law said nothing`).not.toEqual([]);
    expect(problems.join('\n')).toMatch(/RULED name|not declared in the text/);
  });
});

describe('RP-S4-SOURCES — the THREE ruled accounting source types, each planted', () => {
  it('the ruling has three subjects, and the green fixture registers and pins every one of them', () => {
    expect(SETTLEMENT_SOURCE_TYPES.length).toBe(3);
    expect(SETTLEMENT_SOURCE_TYPES).toContain('customer_credit');
    for (const type of SETTLEMENT_SOURCE_TYPES) {
      expect(SETTLEMENT_SQL, `'${type}' is not registered by the green fixture`).toContain(`('${type}', 'none'`);
      expect(SETTLEMENT_SQL, `'${type}' has no owning operation kind in the green fixture`).toContain(`('post', '${type}'`);
      expect(SETTLEMENT_SQL, `'${type}' is not pinned on a carrier in the green fixture`).toContain(`GENERATED ALWAYS AS ('${type}') STORED`);
    }
    expect(settlementContractProblems(SETTLEMENT_SQL)).toEqual([]);
  });

  it.each(SETTLEMENT_SOURCE_TYPES.map((t) => [t]))('red: the source type %s left unregistered is named', (type: string) => {
    const sql = planted(`${type} removed from accounting_source_types`, (s) =>
      s
        .split(`  ('${type}', 'none', 'not_after_today', 'A P4-S4 settlement source.',`)
        .join(`  ('unrelated_type', 'none', 'not_after_today', 'A P4-S4 settlement source.',`),
    );
    expect(about(settlementContractProblems(sql), type).join('\n')).toContain('not registered in accounting_source_types');
  });

  it.each(SETTLEMENT_SOURCE_TYPES.map((t) => [t]))('red: the source type %s with no owning operation kind is named', (type: string) => {
    const sql = planted(`${type} removed from accounting_operation_kinds`, (s) => s.split(`('post', '${type}'`).join(`('post', 'unrelated_type'`));
    expect(about(settlementContractProblems(sql), type).join('\n')).toContain('no owning operation kind');
  });

  it.each(SETTLEMENT_SOURCE_TYPES.map((t) => [t]))(
    'red: the source type %s not pinned on its carrier is named — a type a caller supplies makes the binding FK spoofable',
    (type: string) => {
      const sql = planted(`${type} no longer pinned`, (s) =>
        s.split(`accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('${type}') STORED`).join('accounting_source_type TEXT NOT NULL'),
      );
      expect(about(settlementContractProblems(sql), type).join('\n')).toContain('nowhere PINNED on its carrier relation');
    },
  );

  it('red: the THIRD type dropped altogether — the "two source types" reading — is named on every one of its three facts', () => {
    const credit = 'customer_credit';
    const sql = planted('customer_credit dropped as a source type entirely', (s) =>
      s
        .split(`,\n  ('${credit}', 'none', 'not_after_today', 'A P4-S4 settlement source.', 14)`)
        .join('')
        .split(`,\n  ('post', '${credit}', 'Derived by the settlement command.')`)
        .join('')
        .split(`accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('${credit}') STORED,\n  `)
        .join('  '),
    );
    const problems = about(settlementContractProblems(sql), `'${credit}'`);
    // All three registration facts are missing, and the law says all three
    // rather than stopping at the first.
    expect(problems.length).toBe(3);
    expect(problems.join('\n')).toContain('not registered in accounting_source_types');
    expect(problems.join('\n')).toContain('no owning operation kind');
    expect(problems.join('\n')).toContain('nowhere PINNED on its carrier relation');
  });
});

describe('RP-S4-ARITH — the settlement arithmetic, planted as a second body and as no call at all', () => {
  it('red: a second body of an accepted primitive is named a duplicate financial truth', () => {
    const fn = SETTLEMENT_ARITHMETIC[1] ?? '';
    const sql = planted(
      'a second body of the release primitive',
      (s) => `${s}\nCREATE OR REPLACE FUNCTION ${fn}(a BIGINT, b BIGINT, c BIGINT) RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$ SELECT a $$;\n`,
    );
    expect(about(settlementContractProblems(sql), 'DEFINED again')).not.toEqual([]);
  });

  it('red: a settlement text that never calls the accepted primitives is named — the arithmetic is reused, not re-implemented', () => {
    const sql = planted('every call to the accepted arithmetic removed', (s) => {
      let out = s;
      for (const fn of SETTLEMENT_ARITHMETIC) out = out.split(`${fn}(`).join('local_recomputed_thing(');
      return out;
    });
    const problems = settlementContractProblems(sql);
    for (const fn of SETTLEMENT_ARITHMETIC) expect(about(problems, fn).join('\n'), fn).toContain('never called');
  });
});

/**
 * RP-S4-ROWLOCK — THE ROW-LOCK GRANT'S STANDING PRECONDITION.
 *
 * `0081:660-661` hands `daftar_inventory_internal` a one-column
 * `GRANT UPDATE (status)` on `invoices` and on `customers`. It is not there so
 * that anything may be written: PostgreSQL refuses a locking clause
 * (`FOR UPDATE` / `FOR SHARE`) to a role holding SELECT alone — it wants
 * SELECT **plus one of** UPDATE/DELETE/TRUNCATE — and `customer_collect_payment`
 * and `customer_apply_credit` lock both tables. `0075:495` supplied the SELECT
 * half; this is the other half, and nothing more.
 *
 * Which means the grant is safe only on a condition: NEITHER ROUTINE WRITES
 * EITHER TABLE. The invoice lifecycle belongs to `0078` and the customer
 * revision to `0075`; a settlement routine that began to UPDATE one would have
 * quietly converted a lock privilege into a write capability over a lifecycle
 * it does not own, and no suite would have noticed, because the migration says
 * it does not in a COMMENT. `[[a wrapper is not an invariant]]` reads the same
 * way about a comment, so the condition is machine-checked instead — over the
 * routine BODIES with every SQL comment stripped, so the migration's own prose
 * about the grant can neither satisfy the law nor break it.
 *
 * The law is `rowLockOnlyWriteProblems`, and the gate already applies it to
 * every candidate settlement migration through `settlementContractProblems`,
 * so it is enforced rather than remembered at review. It is proved here GREEN
 * against the REAL settlement migration on disk and RED against a copy of that
 * same text with an `UPDATE` planted into each routine — in memory, because
 * editing an applied migration breaks every suite with "Migration tampered
 * after apply".
 */
describe('RP-S4-ROWLOCK — neither settlement routine writes the tables it only locks', () => {
  const settlementText = (): string => {
    const dir = join(REPO_ROOT, MIGRATIONS_SUBDIR);
    const hit = readdirSync(dir).find((f) => /_phase4_customer_payments_credits\.sql$/.test(f));
    expect(hit, 'the slice’s settlement migration is not on disk, so this law has no subject').toBeDefined();
    return readFileSync(join(dir, hit as string), 'utf8');
  };

  /** A body-shaped two-routine text: the law's subject, with one statement planted. */
  const shape = (stmt: string): string =>
    `CREATE OR REPLACE FUNCTION customer_collect_payment(p UUID) RETURNS VOID LANGUAGE plpgsql AS $$\nBEGIN\n${stmt}\nEND;\n$$;\n` +
    `CREATE OR REPLACE FUNCTION customer_apply_credit(p UUID) RETURNS VOID LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;\n`;

  it('green: the real settlement migration’s two routines issue no UPDATE of invoices or customers', () => {
    expect(rowLockOnlyWriteProblems(settlementText())).toEqual([]);
  });

  it('the silence is not vacuous: both bodies are really read, and each really takes the locks the grant is for', () => {
    const sql = settlementText();
    expect(ROW_LOCK_ONLY_ROUTINES.length).toBe(2);
    expect([...ROW_LOCK_ONLY_TABLES]).toEqual(['invoices', 'customers']);
    for (const fn of ROW_LOCK_ONLY_ROUTINES) {
      const body = routineBody(sql, fn);
      expect(body, `${fn}'s body was not read, so the green case above proves nothing`).not.toBeNull();
      // Long enough to be the routine and not a stub, and one that actually
      // locks — otherwise "issues no UPDATE" is true of nothing.
      expect((body as string).length, fn).toBeGreaterThan(2000);
      expect(stripSqlComments(body as string), fn).toMatch(/FOR\s+(?:UPDATE|SHARE)/i);
    }
    // The grant the law exists for is really in the text, as a COLUMN grant.
    expect(sql).toMatch(/GRANT\s+UPDATE\s*\(\s*status\s*\)\s+ON\s+invoices\s+TO\s+daftar_inventory_internal\s*;/i);
    expect(sql).toMatch(/GRANT\s+UPDATE\s*\(\s*status\s*\)\s+ON\s+customers\s+TO\s+daftar_inventory_internal\s*;/i);
    // And never a table-level UPDATE, nor DELETE, nor TRUNCATE, on either.
    expect(stripSqlComments(sql)).not.toMatch(/GRANT\s+[A-Za-z, ]*UPDATE\s+ON\s+(?:public\s*\.\s*)?(?:invoices|customers)\b/i);
    expect(stripSqlComments(sql)).not.toMatch(
      /GRANT\s+[A-Za-z, ()_]*\b(?:DELETE|TRUNCATE)\b[A-Za-z, ()_]*\s+ON\s+(?:public\s*\.\s*)?(?:invoices|customers)\b/i,
    );
  });

  // One red proof per (routine, table) pair, planted into the REAL text.
  for (const fn of ROW_LOCK_ONLY_ROUTINES)
    for (const table of ROW_LOCK_ONLY_TABLES)
      it(`red: an UPDATE of ${table} planted into ${fn} is named`, () => {
        const sql = settlementText();
        const body = routineBody(sql, fn) as string;
        const mutatedBody = body.replace('BEGIN', `BEGIN\n  UPDATE ${table} SET status = status WHERE false;`);
        expect(mutatedBody === body, 'the plant changed nothing, so the proof would prove nothing').toBe(false);
        const problems = rowLockOnlyWriteProblems(sql.split(body).join(mutatedBody));
        expect(problems.join('\n')).toContain(`${fn} issues an UPDATE of ${table}`);
        // And the OTHER routine is not blamed for this one's plant.
        const other = ROW_LOCK_ONLY_ROUTINES.find((r) => r !== fn) as string;
        expect(problems.join('\n')).not.toContain(`${other} issues an UPDATE of ${table}`);
      });

  it('red: whitespace, the schema prefix and ONLY are all reached, and a locking clause is not mistaken for a write', () => {
    for (const stmt of [
      '  UPDATE invoices SET status = status;',
      '  UPDATE\n    invoices\n  SET status = status;',
      '  UPDATE public.invoices SET status = status;',
      '  UPDATE public . invoices SET status = status;',
      '  UPDATE ONLY customers SET status = status;',
      '  WITH x AS (UPDATE invoices SET status = status RETURNING id) SELECT 1 FROM x;',
    ])
      expect(rowLockOnlyWriteProblems(shape(stmt)).join('\n'), stmt).toContain('issues an UPDATE of');
    for (const stmt of [
      '  PERFORM 1 FROM invoices WHERE false FOR UPDATE;',
      '  PERFORM 1 FROM invoices WHERE false FOR UPDATE OF invoices;',
      '  PERFORM 1 FROM invoices WHERE false FOR UPDATE NOWAIT;',
      '  PERFORM 1 FROM customers WHERE false FOR SHARE;',
      '  PERFORM 1 FROM invoices i JOIN customers c ON true WHERE false FOR SHARE;',
    ])
      expect(rowLockOnlyWriteProblems(shape(stmt)), stmt).toEqual([]);
  });

  it('a comment cannot satisfy the law, and cannot break it either', () => {
    // Prose ABOUT an update is not an update — in either comment syntax.
    expect(rowLockOnlyWriteProblems(shape('  -- this routine never runs UPDATE invoices, and must not\n  PERFORM 1;'))).toEqual([]);
    expect(rowLockOnlyWriteProblems(shape('  /* no UPDATE customers here, ever */\n  PERFORM 1;'))).toEqual([]);
    // A real statement COMMENTED OUT is not a write either.
    expect(rowLockOnlyWriteProblems(shape('  -- UPDATE invoices SET status = status;\n  PERFORM 1;'))).toEqual([]);
    // But a comment cannot HIDE one: stripping leaves a space, never a splice.
    expect(rowLockOnlyWriteProblems(shape('  UPDATE /* sneaky */ invoices SET status = status;')).join('\n')).toContain('issues an UPDATE of invoices');
    // An apostrophe in a comment does not derail the scanner.
    expect(rowLockOnlyWriteProblems(shape("  -- the invoice's status is 0078's\n  UPDATE invoices SET status = status;")).join('\n')).toContain(
      'issues an UPDATE of invoices',
    );
    // A `--` inside a LITERAL is not a comment, so what follows it still counts.
    expect(rowLockOnlyWriteProblems(shape("  PERFORM 'a -- b';\n  UPDATE customers SET status = status;")).join('\n')).toContain(
      'issues an UPDATE of customers',
    );
  });

  it('a routine whose body cannot be read is reported, never skipped', () => {
    expect(rowLockOnlyWriteProblems('-- nothing at all').length).toBe(ROW_LOCK_ONLY_ROUTINES.length);
    expect(rowLockOnlyWriteProblems('-- nothing at all').join('\n')).toContain('cannot be read from the settlement text');
    // An unterminated dollar-quoted body is unreadable, not empty.
    expect(
      rowLockOnlyWriteProblems('CREATE OR REPLACE FUNCTION customer_collect_payment(p UUID) RETURNS VOID LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\n').join(
        '\n',
      ),
    ).toContain("customer_collect_payment's body cannot be read");
  });
});
