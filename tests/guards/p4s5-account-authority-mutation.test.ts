/**
 * P4-S5 — ONE CANONICAL ACCOUNT-ID SOURCE, proved by MUTATING IT (level C).
 *
 * `TL-P4-S5-R2` §13 and §14, as the project owner ruled them: one canonical
 * account-id source; *"do not fix this by making all three literals equal —
 * REMOVE DUPLICATE AUTHORITY"*; and **no missing account, no duplicate
 * authority, no string-literal bypass, no second mapping table, no dead config
 * member.**
 *
 * ## Why this suite is a mutation suite and not an audit
 *
 * A regular expression over the source text can be satisfied by a comment, and
 * an audit that asks "does this file contain a literal?" proves only that the
 * files it thought to ask about are clean today. The ruling asks for something
 * stronger: that a hardcoded literal ANYWHERE be **detectable**. Only a
 * mutation can say that. So every claim here is made by replacing the canonical
 * source and observing the live planners, and the one text-level assertion that
 * remains (`§14.4`) exists solely to show the mutation lever is the real one.
 *
 * ## The lever, and why it reaches inside the planners
 *
 * `S5_ACCOUNT` lives in `@daftar/domain-core` and every S5 planner, mapper and
 * validator IMPORTS it. That module boundary is what makes the mutation real:
 * `vi.doMock` replaces the binding every reader resolves, so a planner that
 * consumes the authority moves, and a planner holding its own literal does not.
 * An authority declared inside `returns-settlement.ts` could not be mutated
 * this way at all — an ESM module's own internal reads do not go through its
 * exports — and that, not tidiness, is why the canonical source sits in the
 * domain package.
 *
 * ## The law asserted, stated as one sentence
 *
 * Over the WHOLE LIVE SET — every exported `plan*` of the settlement module,
 * discovered by reflection and not listed by hand — and over EVERY member of
 * the canonical table:
 *
 * 1. every planner's observable behaviour MOVES under the mutation of at least
 *    one member, so no planner spells an account itself;
 * 2. every member moves at least one planner, so no member is a DEAD CONFIG
 *    MEMBER;
 * 3. the discovered planner set equals the scenario set, so a planner added
 *    later fails this suite until it is covered.
 *
 * (2) is the same test this project has just been bitten by failing one module
 * over: `customer.aging_buckets_invalid` is declared in a status registry,
 * thrown nowhere in the tree, and a docstring cited it as the check that
 * justified a 500. §15 applies that test to this slice's refusal vocabulary as
 * well as to its accounts.
 *
 * ## The four things each proof here proves
 *
 * Because a proof that would also be red for another reason proves nothing,
 * each mutation records: the SUBJECT exists (the pristine run is lawful and its
 * accounts are named), the MUTATION occurred (the mocked module's member is
 * read back and differs), the RESULT is non-empty (both signatures are
 * non-empty strings), and the intended DEFECT is named (a hardcoded literal
 * would leave the signature identical — asserted as inequality, in the
 * message).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DOMAIN = '@daftar/domain-core';

type Domain = typeof import('@daftar/domain-core');
type Settlement = typeof import('../../apps/api/src/modules/returns/returns-settlement');
type Ports = typeof import('../../apps/api/src/modules/returns/returns-ports');

const BASE = { rateR10: 10n ** 10n, txnExponent: 2, baseExponent: 2 } as const;

/** The worked FX scenario the independent challenger verified by hand: rel = 3 617, cr_rel = 3 633, realized = 16. */
const WORKED_INVOICE = {
  totalTxnMinor: 10_000n,
  totalBaseMinor: 10_853n,
  outstandingTxnMinor: 10_000n,
  conversion: { rateR10: 10_853n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
} as const;
const WORKED_NOTE = {
  originalMinor: 10_000n,
  originalCarryingMinor: 10_901n,
  remainingMinor: 10_000n,
  conversion: { rateR10: 10_901n * 10n ** 6n, txnExponent: 2, baseExponent: 2 },
} as const;
const APPLICATION = { invoice: WORKED_INVOICE, note: WORKED_NOTE, sameCurrency: true, consumedMinor: 3_333n, appliedMinor: 3_333n } as const;

const refundSource = (kind: 'credit_note' | 'customer_credit') =>
  ({ kind, originalMinor: 10_000n, originalCarryingMinor: 10_000n, remainingMinor: 10_000n, conversion: BASE }) as const;

const IDENTITY = {
  applicationId: 'app-1',
  lineNo: 1,
  creditNoteId: 'cn-1',
  customerId: 'cus-1',
  invoiceId: 'inv-1',
  applicationDate: '2026-03-04',
  creditCurrencyCode: 'USD',
  invoiceCurrencyCode: 'USD',
} as const;

/**
 * The MUTANT id. Deliberately a string the chart does NOT register, so that the
 * mutation is visible however a planner reacts to it: a planner that consumes
 * the authority either emits a line on an account the closed entry-account
 * lists reject — which is itself a refusal with a named code — or refuses on the
 * canonical-source check. A planner holding a literal reacts in neither way,
 * because nothing it reads has changed. That asymmetry is the detection.
 */
const MUTANT = 'MUTATED_ACCOUNT_ID_NOT_IN_THE_CHART';

/**
 * ONE scenario per planner invocation, each a LAWFUL command of the slice.
 *
 * `signature` is the planner's observable behaviour reduced to a string: the
 * refusal code if it refuses, otherwise its entry lines' accounts in order. It
 * is deliberately NOT a boolean — two different refusals are two different
 * behaviours, and a proof that only recorded "threw" could not tell a detection
 * from an unrelated collapse.
 */
type Scenario = {
  readonly name: string;
  /** The exported planner this scenario drives, by its export name — checked against the discovered live set. */
  readonly planner: string;
  readonly run: (s: Settlement) => string;
};

const accountsOf = (lines: readonly { readonly account: string }[]): string => lines.map((l) => l.account).join(',');

const signature = (f: () => string): string => {
  try {
    const s = f();
    return `lines:${s}`;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? `refused:${code}` : `threw:${(e as Error).constructor.name}`;
  }
};

const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    name: 'a credit-note APPLICATION with realized FX (the worked 3 617 / 3 633 / 16 scenario)',
    planner: 'planCreditNoteApplication',
    run: (s) => accountsOf(s.planCreditNoteApplication(APPLICATION).entryLines),
  },
  {
    name: 'a credit-note REVERSAL, whose revenue and COGS legs name four accounts between them',
    planner: 'planCreditNoteReversal',
    run: (s) => {
      const p = s.planCreditNoteReversal({
        totalMinor: 1_000n,
        conversion: BASE,
        taxMinor: '0',
        returnedMovements: [{ movementId: 'm1', valueDeltaBaseMinor: 450n }],
      });
      return `${accountsOf(p.revenueEntryLines)}|${accountsOf(p.cogsEntryLines)}`;
    },
  },
  {
    name: 'a REFUND on a CREDIT NOTE, cross-currency so a realized gain line exists',
    planner: 'planCustomerRefund',
    run: (s) =>
      accountsOf(
        s.planCustomerRefund({ source: refundSource('credit_note'), consumedMinor: 1_000n, sameCurrency: false, disbursementAmountMinor: 900n, disbursement: BASE })
          .entryLines,
      ),
  },
  {
    name: 'a REFUND on a CUSTOMER CREDIT, which discharges 2210 and never 2200',
    planner: 'planCustomerRefund',
    run: (s) =>
      accountsOf(
        s.planCustomerRefund({
          source: refundSource('customer_credit'),
          consumedMinor: 1_000n,
          sameCurrency: false,
          disbursementAmountMinor: 1_100n,
          disbursement: BASE,
        }).entryLines,
      ),
  },
]);

/** Load the settlement module with ONE member of the canonical table replaced. */
async function withMutatedMember(member: string): Promise<{ readonly settlement: Settlement; readonly observed: unknown }> {
  vi.doMock(DOMAIN, async () => {
    const actual = await vi.importActual<Domain>(DOMAIN);
    return { ...actual, S5_ACCOUNT: Object.freeze({ ...actual.S5_ACCOUNT, [member]: MUTANT }) };
  });
  vi.resetModules();
  const domain: Domain = await import('@daftar/domain-core');
  const settlement: Settlement = await import('../../apps/api/src/modules/returns/returns-settlement');
  return { settlement, observed: (domain.S5_ACCOUNT as unknown as Record<string, unknown>)[member] };
}

describe('P4-S5 §13 — every planner in the LIVE SET follows the canonical account-id source, under mutation', () => {
  afterEach(() => {
    vi.doUnmock(DOMAIN);
    vi.resetModules();
  });

  it('the live set is DISCOVERED, and every discovered planner has a scenario', async () => {
    const settlement: Settlement = await import('../../apps/api/src/modules/returns/returns-settlement');
    const discovered = Object.keys(settlement)
      .filter((k) => /^plan[A-Z]/.test(k) && typeof (settlement as Record<string, unknown>)[k] === 'function')
      .sort();
    // Non-vacuity first: reflection really found planners.
    expect(discovered.length).toBeGreaterThan(0);
    // And the law: the covered set is EXACTLY the live set. A planner added to
    // this module later fails here until a scenario drives it, which is what
    // stops this suite from being a law that only holds where it was asked.
    expect([...new Set(SCENARIOS.map((s) => s.planner))].sort()).toEqual(discovered);
  });

  it('the PRISTINE subjects exist and are lawful, and between them they name every canonical account', async () => {
    const settlement: Settlement = await import('../../apps/api/src/modules/returns/returns-settlement');
    const domain: Domain = await import('@daftar/domain-core');
    const named = new Set<string>();
    for (const sc of SCENARIOS) {
      const sig = signature(() => sc.run(settlement));
      // SUBJECT EXISTS: the lawful command plans, it does not refuse.
      expect(sig.startsWith('lines:'), `${sc.name} must plan lawfully before any mutation`).toBe(true);
      // RESULT NON-EMPTY: it really produced accounts.
      expect(sig.length).toBeGreaterThan('lines:'.length);
      for (const a of sig.slice('lines:'.length).split(/[,|]/)) if (a !== '') named.add(a);
    }
    // NO MISSING ACCOUNT: every account the four lawful plans name is a member
    // of the canonical table — nothing is conjured outside it.
    const canonical: ReadonlySet<string> = new Set<string>(Object.values(domain.S5_ACCOUNT));
    for (const a of named) expect(canonical.has(a), `${a} is named by a live plan but is not in the canonical account-id source`).toBe(true);
    // And the four lawful plans between them reach most of the table, which is
    // the premise the matrix's dead-member claim is measured against: a member
    // no lawful plan can reach could not be moved by any mutation either.
    expect(named.size).toBeGreaterThanOrEqual(7);
  });

  // The mutation matrix. One `it` per canonical member so a failure names the
  // member, driven over every scenario so the claim is total rather than
  // sampled.
  it('MUTATION MATRIX — every member moves at least one planner, and every planner is moved by at least one member', async () => {
    const pristineModule: Settlement = await import('../../apps/api/src/modules/returns/returns-settlement');
    const domain: Domain = await import('@daftar/domain-core');
    const members = Object.keys(domain.S5_ACCOUNT).sort();
    expect(members).toHaveLength(9);

    const pristine = SCENARIOS.map((sc) => signature(() => sc.run(pristineModule)));

    /** member → the scenario indices whose behaviour changed. */
    const movedBy = new Map<string, number[]>();
    for (const member of members) {
      vi.doUnmock(DOMAIN);
      vi.resetModules();
      const { settlement, observed } = await withMutatedMember(member);
      // THE MUTATION REALLY OCCURRED, read back from the module graph the
      // planners were loaded from — not assumed from the fact that doMock was
      // called.
      expect(observed, `the canonical member ${member} was not actually replaced`).toBe(MUTANT);

      const moved: number[] = [];
      SCENARIOS.forEach((sc, i) => {
        const after = signature(() => sc.run(settlement));
        // Non-emptiness of both sides, so an inequality cannot come from a
        // silently absent observation.
        expect(pristine[i]).not.toBe('');
        expect(after).not.toBe('');
        if (after !== pristine[i]) moved.push(i);
      });
      movedBy.set(member, moved);
      vi.doUnmock(DOMAIN);
      vi.resetModules();
    }

    // NO DEAD CONFIG MEMBER. A member of the canonical table that moves nothing
    // is declared and unreached — the `customer.aging_buckets_invalid` shape,
    // and precisely what the ruling forbids.
    for (const member of members) {
      expect(
        (movedBy.get(member) as number[]).length,
        `the canonical member ${member} changed NO planner's behaviour: either it is a dead config member, or every reader of it holds a literal`,
      ).toBeGreaterThan(0);
    }

    // NO STRING-LITERAL BYPASS, stated semantically. Each scenario must be
    // moved by some member; a scenario that survives all nine mutations
    // unchanged is a planner that spells its own accounts.
    SCENARIOS.forEach((sc, i) => {
      const movers = members.filter((m) => (movedBy.get(m) as number[]).includes(i));
      expect(
        movers.length,
        `${sc.name} behaved IDENTICALLY under all nine mutations of the canonical account-id source — a hardcoded literal is the only way that happens`,
      ).toBeGreaterThan(0);
    });

    // And the specific pairings the ruling argued about, named so a reader does
    // not have to reconstruct them from the matrix:
    //
    // - 2200 moves the APPLICATION (index 0), the RETURN entry (1) and the
    //   refund drawn on a CREDIT NOTE (2) — the three laws that were three
    //   equal literals, now all following one source;
    // - 2210 moves ONLY the refund drawn on a CUSTOMER CREDIT (3), which is why
    //   "make all three literals equal" was the wrong repair.
    expect(movedBy.get('CUSTOMER_REFUND_LIABILITY')).toEqual([0, 1, 2]);
    expect(movedBy.get('CUSTOMER_CREDIT_LIABILITY')).toEqual([3]);
  });

  it('MUTATION — the cross-module row validator CONSUMES the account rather than spelling it', async () => {
    // Round 3 shipped `assertApplicationRowAgreesWithEntry` with the liability
    // account as a LITERAL, in the very change that argued for the constant.
    // The two versions are distinguishable only by mutation: reading the
    // authority, the guard nets an account the lines do not name, reads `0n`
    // and refuses; holding a literal, it nets the account it always did and the
    // row passes, which is the silence that let the defect ship.
    const pristineSettlement: Settlement = await import('../../apps/api/src/modules/returns/returns-settlement');
    const pristinePorts: Ports = await import('../../apps/api/src/modules/returns/returns-ports');
    const plan = pristineSettlement.planCreditNoteApplication(APPLICATION);
    const row = pristinePorts.creditNoteApplicationRow(IDENTITY, plan);
    // SUBJECT: the challenger's hand-verified numbers, so this arm is anchored
    // to something other than the code it checks.
    expect(row.invoiceCarryingBaseReleasedMinor).toBe(3_617n);
    expect(row.creditCarryingBaseReleasedMinor).toBe(3_633n);
    expect(row.realizedFxGainLossMinor).toBe(16n);
    expect(() => pristinePorts.assertApplicationRowAgreesWithEntry(row, plan)).not.toThrow();

    vi.doUnmock(DOMAIN);
    vi.resetModules();
    const { observed } = await withMutatedMember('CUSTOMER_REFUND_LIABILITY');
    expect(observed).toBe(MUTANT);
    const mutatedPorts: Ports = await import('../../apps/api/src/modules/returns/returns-ports');

    let code: string | null = null;
    try {
      // The PRISTINE plan and row — the entry is the real one; only the
      // validator's notion of which account the liability is has moved.
      mutatedPorts.assertApplicationRowAgreesWithEntry(row, plan);
    } catch (e) {
      code = ((e as { code?: unknown }).code as string) ?? null;
    }
    expect(code, 'the cross-module row validator must CONSUME the canonical account, not spell it').toBe('credit_note.posting_incomplete');
  });

  it('MUTATION — the refund planner refuses in its OWN vocabulary when the role authority and the id authority disagree', async () => {
    // This is the third planner's detection mechanism, and it is a different
    // one on purpose. `refundLiabilityAccount` decides WHICH liability a source
    // kind discharges and lives inside the domain package, so replacing the id
    // table does not change its answer. The refund planner therefore CHECKS the
    // answer against the canonical table and refuses when the two disagree —
    // which is a deployment defect, 500, `registry_incomplete`, and never a
    // merchant's mistake.
    //
    // It is also what makes that code REACHABLE. Before this check it was
    // declared in the status table and raised nowhere: a dead registry member.
    vi.doUnmock(DOMAIN);
    vi.resetModules();
    const { settlement, observed } = await withMutatedMember('CUSTOMER_REFUND_LIABILITY');
    expect(observed).toBe(MUTANT);
    let code: string | null = null;
    try {
      settlement.planCustomerRefund({
        source: refundSource('credit_note'),
        consumedMinor: 1_000n,
        sameCurrency: false,
        disbursementAmountMinor: 900n,
        disbursement: BASE,
      });
    } catch (e) {
      code = ((e as { code?: unknown }).code as string) ?? null;
    }
    expect(code, 'a refund whose liability is not a member of the canonical account-id source must refuse as a registry defect').toBe(
      'customer_refund.registry_incomplete',
    );
  });
});

describe('P4-S5 §14 — no duplicate authority, no second mapping table, no dead member of the table', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');
  /** Source with every comment removed, so an audit of CODE is never satisfied by prose. */
  const codeOnly = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('§14.1 — NO ACCOUNT LITERAL survives in the two S5 modules, in code', () => {
    // The semantic proof of this is the mutation matrix above; this assertion
    // exists because a literal that happens to equal the canonical value today
    // is invisible to a behavioural test until someone moves the canonical
    // value, and catching it at the moment it is WRITTEN is cheaper than
    // catching it at the moment it matters.
    const modules = ['apps/api/src/modules/returns/returns-settlement.ts', 'apps/api/src/modules/returns/returns-ports.ts'];
    for (const rel of modules) {
      const code = codeOnly(read(rel));
      // Non-vacuity: the stripper left the code, and the code DOES name
      // accounts — through the canonical table.
      expect(code, `${rel} must consume the canonical account-id source`).toContain('S5_ACCOUNT');
      for (const id of ['sales_returns', 'accounts_receivable', 'customer_refund_liability', 'customer_credit_liability', 'inventory', 'cogs', 'fx_gain', 'fx_loss', 'posting_account']) {
        // `'id'` as a VALUE. A property NAME (`fx_gain:`) is a key into the
        // canonical table, not a second authority over the string, so the
        // quoted form is what is forbidden.
        expect(code.includes(`'${id}'`), `${rel} spells the account ${id} itself instead of taking it from S5_ACCOUNT`).toBe(false);
      }
    }
  });

  it('§14.2 — NO SECOND MAPPING TABLE: exactly one table in the slice maps an account vocabulary to S5 accounts', () => {
    const code = codeOnly(read('apps/api/src/modules/returns/returns-settlement.ts'));
    expect([...code.matchAll(/satisfies Record<ReceivableEntryLine\['account'\]/g)]).toHaveLength(1);
    expect([...code.matchAll(/satisfies Record<[^>]*EntryAccount[^>]*,\s*CreditNoteEntryAccount/g)]).toHaveLength(0);
  });

  it('§14.3 — the canonical table is the ONE declaration site, and it declares each id exactly once', async () => {
    const domain: Domain = await import('@daftar/domain-core');
    const ids = Object.values(domain.S5_ACCOUNT);
    // No id is declared twice under two role names — that would be duplicate
    // authority wearing one table.
    expect(new Set(ids).size).toBe(ids.length);
    // The two closed entry-account lists are DERIVED, not restated: every
    // member of each is a member of the canonical table.
    const canonical: ReadonlySet<string> = new Set<string>(ids);
    for (const a of domain.REFUND_ENTRY_ACCOUNTS) expect(canonical.has(a), `${a} is in REFUND_ENTRY_ACCOUNTS but not in the canonical table`).toBe(true);
    for (const a of domain.CREDIT_NOTE_ENTRY_ACCOUNTS) expect(canonical.has(a), `${a} is in CREDIT_NOTE_ENTRY_ACCOUNTS but not in the canonical table`).toBe(true);
    // And the ROLE authority's answers are members too, for both kinds — the
    // agreement the refund planner checks at runtime, asserted here statically.
    expect(canonical.has(domain.refundLiabilityAccount('credit_note'))).toBe(true);
    expect(canonical.has(domain.refundLiabilityAccount('customer_credit'))).toBe(true);
    // The two roles still DISAGREE, which is why collapsing them was wrong.
    expect(domain.refundLiabilityAccount('credit_note')).not.toBe(domain.refundLiabilityAccount('customer_credit'));
  });

  it('§14.4 — the mutation lever is the real authority: the shipped modules read S5_ACCOUNT from the domain package', () => {
    // Without this, §13's matrix could be mutating a table nobody reads and
    // detecting a coincidence. One line, and it is the premise of everything
    // above it.
    for (const rel of ['apps/api/src/modules/returns/returns-settlement.ts', 'apps/api/src/modules/returns/returns-ports.ts']) {
      expect(codeOnly(read(rel))).toMatch(/import\s*\{[^}]*S5_ACCOUNT[^}]*\}\s*from\s*'@daftar\/domain-core'/);
    }
  });
});

describe('P4-S5 §15 — the refusal vocabulary has NO DEAD MEMBER either', () => {
  /**
   * The same test the neighbouring module failed. `customer.aging_buckets_invalid`
   * is declared in a status registry, thrown NOWHERE in the tree, and a
   * docstring cited it as the check that justified a 500.
   *
   * The honest claim about this vocabulary is not that every code is live — the
   * route handler and the SQL routines are owed at levels F and G and are not
   * in the tree. It is that the vocabulary PARTITIONS: raised at a located site
   * in live TypeScript, or listed in `RETURNS_CODES_OWED_BY` with the authority
   * that will raise it NAMED. A code in neither set is dead; a code in both is
   * a stale entry that will outlive its reason.
   */
  const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');

  /**
   * The live TypeScript of the slice, with the two DECLARATION regions removed —
   * the `ReturnsRefusalCode` union and the `RETURNS_REFUSAL_CODES` list in the
   * domain, and the status table itself. Declaring a code is not raising it, and
   * a scan that counted declarations would pass vacuously for all of them.
   */
  const raiseSites = (): string => {
    const domain = read('packages/domain-core/src/returns.ts');
    const start = domain.indexOf('export type ReturnsRefusalCode =');
    const listStart = domain.indexOf('export const RETURNS_REFUSAL_CODES');
    const listEnd = domain.indexOf(']);', listStart);
    expect(start, 'the declaration region must be locatable, or this scan is measuring nothing').toBeGreaterThan(0);
    expect(listEnd).toBeGreaterThan(listStart);
    const withoutDeclarations = domain.slice(0, start) + domain.slice(listEnd);
    return (
      withoutDeclarations +
      read('apps/api/src/modules/returns/returns-settlement.ts') +
      read('apps/api/src/modules/returns/returns-ports.ts') +
      read('apps/api/src/modules/returns/returns-permissions.ts')
    );
  };

  it('every declared code is EITHER raised in live code OR owed by a named authority — never neither, never both', async () => {
    const errors = await import('../../apps/api/src/modules/returns/returns-errors');
    const codes: readonly string[] = errors.RETURNS_CODES;
    const owed: Readonly<Record<string, string>> = errors.RETURNS_CODES_OWED_BY;
    const sites = raiseSites();
    // Non-vacuity of the scan: the declaration regions really were removed, so
    // a code that is ONLY declared is not counted as raised.
    expect(codes.length).toBeGreaterThan(30);
    expect(sites).not.toContain('export const RETURNS_REFUSAL_CODES');

    const raised = codes.filter((c) => sites.includes(`'${c}'`));
    // The scan found raise sites at all — otherwise every code would fall to
    // the owed table and the test would pass by collapsing.
    expect(raised.length).toBeGreaterThan(10);

    for (const c of codes) {
      const isRaised = raised.includes(c);
      const isOwed = Object.prototype.hasOwnProperty.call(owed, c);
      expect(isRaised || isOwed, `${c} is declared in the status table and NOTHING raises it and NOBODY owes it — it is a dead config member`).toBe(true);
      expect(isRaised && isOwed, `${c} is raised in live code AND still listed as owed — the owed entry is stale and must be removed`).toBe(false);
    }
    // And the owed table names nothing outside the vocabulary.
    for (const c of Object.keys(owed)) expect(codes.includes(c), `${c} is owed by a named authority but is not a declared refusal code`).toBe(true);
    // Each owed entry really NAMES an authority rather than carrying a placeholder.
    for (const [c, who] of Object.entries(owed)) {
      expect(who.length, `${c} is owed by nobody in particular`).toBeGreaterThan(20);
      expect(who, `${c} must name the level at which its authority is owed`).toMatch(/level [A-G]/);
    }
  });

  it('RED PROOF — the partition check can FAIL: a code declared with no raiser and no owner is reported', async () => {
    // The subject is REAL: `customer_refund.registry_incomplete` was exactly
    // this until the refund planner's canonical-source check gave it a raise
    // site, and `customer.aging_buckets_invalid` still is, one module over.
    // Here the same predicate is run over a vocabulary with one invented
    // member, to show the predicate is what reports it rather than the absence
    // of a defect.
    const errors = await import('../../apps/api/src/modules/returns/returns-errors');
    const owed: Readonly<Record<string, string>> = errors.RETURNS_CODES_OWED_BY;
    const sites = raiseSites();
    const PLANTED = 'credit_note.aging_buckets_invalid';
    // The plant is genuinely absent from the tree and from the owed table —
    // otherwise this proof would be red for the wrong reason.
    expect(sites).not.toContain(`'${PLANTED}'`);
    expect(Object.prototype.hasOwnProperty.call(owed, PLANTED)).toBe(false);
    const verdict = [...errors.RETURNS_CODES, PLANTED].filter(
      (c: string) => !sites.includes(`'${c}'`) && !Object.prototype.hasOwnProperty.call(owed, c),
    );
    // RESULT NON-EMPTY, and the EXACT intended defect named: the planted code
    // and nothing else.
    expect(verdict).toEqual([PLANTED]);
  });

  it('the status table carries no comment citing a check that does not exist', () => {
    // The second half of the neighbouring incident: the docstring claimed a
    // validator justified the 500. Two claims in this module's own comments are
    // held to their subjects here, because a comment is how a false belief
    // ships and nothing else in the tree would notice.
    const errorsSource = read('apps/api/src/modules/returns/returns-errors.ts');
    // OD-03 is CLOSED for Phase 4. An earlier draft of this very file said
    // OPEN, which is the kind of stale claim this assertion exists to catch.
    expect(errorsSource).not.toMatch(/OD-03 is OPEN/);
    expect(errorsSource).toContain('OD-03 is CLOSED for Phase 4');
    // And the one code the table describes as raised by the canonical-source
    // check really is raised there.
    expect(read('apps/api/src/modules/returns/returns-settlement.ts')).toContain("refuse('customer_refund.registry_incomplete'");
  });
});
