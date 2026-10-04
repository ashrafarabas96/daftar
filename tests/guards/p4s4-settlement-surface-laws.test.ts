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
import { describe, expect, it } from 'vitest';
import {
  SETTLEMENT_ARITHMETIC,
  SETTLEMENT_REFUSALS,
  SETTLEMENT_ROUTINES,
  SETTLEMENT_SOURCE_TYPES,
  SETTLEMENT_VERIFIER,
  settlementContractProblems,
} from '../../scripts/phase4-s4-gate';

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
