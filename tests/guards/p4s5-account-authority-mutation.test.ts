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
import { readFileSync, readdirSync } from 'node:fs';
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
 * TWO VIEWS OF A SOURCE FILE, and why one is not enough.
 *
 * This is the gate engineer's `stripProse` / `stripCommentsKeepStrings` pair,
 * which is the shape this estate settled on. It is reimplemented here rather
 * than imported because the module that exports it
 * (`scripts/guards/performance-contract.ts`) is not on this branch; if it lands
 * here, this should become an import and the duplicate should go.
 *
 * - `codeWithProseBlanked` blanks comments AND string bodies. It answers "is
 *   this IDENTIFIER right", and no amount of prose can satisfy it;
 * - `codeWithCommentsBlanked` blanks comments and KEEPS string bodies. It
 *   answers "does this region RAISE this code", because a refusal code is a
 *   string literal — `refuse('customer_refund.fx_rate_changed', …)` — so the
 *   first view blanks the very thing being looked for and would classify every
 *   code in the slice as unraised.
 *
 * Both preserve length, so an index computed in one addresses the same
 * character in the other.
 *
 * Why this matters here and is not plumbing: the previous version of §15
 * scanned RAW source, so a code named only in a COMMENT counted as raised.
 * That is how a dead member comes to be declared closed, which is the exact
 * subject of this file.
 */
function blankOut(source: string, blankStrings: boolean): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '//') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      blank(i, end);
      i = end;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      if (blankStrings) blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let textFrom = j;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '`') break;
        if (source.slice(j, j + 2) === '${') {
          if (blankStrings) blank(textFrom, j);
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === '{') depth += 1;
            else if (source[j] === '}') depth -= 1;
            j += 1;
          }
          textFrom = j;
          continue;
        }
        j += 1;
      }
      if (blankStrings) blank(textFrom, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const codeWithProseBlanked = (source: string): string => blankOut(source, true);
const codeWithCommentsBlanked = (source: string): string => blankOut(source, false);
const readSource = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');

/**
 * The S5 module surface, DISCOVERED rather than listed — S5-5's finding was
 * that the compensating literal scan covered two files by name.
 */
const s5ModuleFiles = (): readonly string[] => {
  const dir = 'apps/api/src/modules/returns';
  return readdirSync(join(__dirname, '../..', dir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `${dir}/${f}`);
};

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

    // NO DEAD CONFIG MEMBER — with the ONE honest exception stated as a
    // classification rather than hidden in the threshold.
    //
    // This lever can only observe a member that is read ACROSS the module
    // boundary, because an ESM module's own internal reads do not go through
    // its exports. `CUSTOMER_CREDIT_LIABILITY` has exactly one consumer and it
    // is `refundLiabilityAccount`, INSIDE the declaring module, so no mock of
    // that module's exports can move it. That is a limit of the lever, not a
    // dead member — and inside one module there is no drift surface for a
    // mutation to detect in the first place, which is precisely why the
    // previous round's compensating check in `planCustomerRefund` was a
    // tautology and had to be deleted.
    //
    // So the classification is declared, and then CHECKED IN BOTH DIRECTIONS:
    // a declared domain-internal member must move nothing (or the
    // classification is stale and a real cross-module reader now exists), and
    // every other member must move something.
    const DOMAIN_INTERNAL: readonly string[] = ['CUSTOMER_CREDIT_LIABILITY'];
    for (const member of members) {
      const moved = movedBy.get(member) as number[];
      if (DOMAIN_INTERNAL.includes(member)) {
        expect(
          moved.length,
          `${member} is classified as read only inside its declaring module, but a mutation of it MOVED a planner — the classification is stale and this member should be proved by mutation like the others`,
        ).toBe(0);
        continue;
      }
      expect(
        moved.length,
        `the canonical member ${member} changed NO planner's behaviour: either it is a dead config member, or every reader of it holds a literal`,
      ).toBeGreaterThan(0);
    }

    // And the domain-internal member is not left unproven, only proven
    // DIFFERENTLY and more weakly, which is said out loud: its live consumer's
    // answer is asserted to BE the canonical member, by value. That shows
    // agreement; it cannot show non-duplication, and no test in this file
    // claims otherwise.
    const liveDomain: Domain = await vi.importActual('@daftar/domain-core');
    const liveSettlement: Settlement = await vi.importActual('../../apps/api/src/modules/returns/returns-settlement');
    const creditRefund = liveSettlement.planCustomerRefund({
      source: refundSource('customer_credit'),
      consumedMinor: 1_000n,
      sameCurrency: false,
      disbursementAmountMinor: 1_100n,
      disbursement: BASE,
    });
    expect(
      creditRefund.entryLines.map((l) => l.account),
      'a refund on a customer credit must debit the canonical CUSTOMER_CREDIT_LIABILITY and no other liability',
    ).toContain(liveDomain.S5_ACCOUNT.CUSTOMER_CREDIT_LIABILITY);
    expect(creditRefund.entryLines.map((l) => l.account)).not.toContain(liveDomain.S5_ACCOUNT.CUSTOMER_REFUND_LIABILITY);

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
    // not reconstruct them from the matrix — and stated at the strength the
    // lever actually has, which is less than an earlier version of this file
    // claimed:
    //
    // - 2200 moves the APPLICATION (index 0) and the RETURN entry (1). Those
    //   are two of the three laws that were three equal literals, and they are
    //   the two whose account-id reads cross the module boundary;
    // - the third, the refund drawn on a credit note (2), takes its liability
    //   from `refundLiabilityAccount` INSIDE the declaring module, so this
    //   lever cannot move it and does not pretend to. It is covered by this
    //   matrix through `POSTING_ACCOUNT` and `FX_GAIN` instead — the planner is
    //   proved to consume the canonical source, just not at the liability line;
    // - 2210 moves NOTHING, for the same reason, and is classified above.
    expect(movedBy.get('CUSTOMER_REFUND_LIABILITY')).toEqual([0, 1]);
    expect(movedBy.get('CUSTOMER_CREDIT_LIABILITY')).toEqual([]);
    // The refund planner's own coverage, named rather than left implicit in the
    // "every planner is moved" arm above.
    expect(movedBy.get('POSTING_ACCOUNT')).toEqual([2, 3]);
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

  it('the refund planner is NOT given a compensating check, and the reason is recorded', async () => {
    // A previous round added one here: it compared `refundLiabilityAccount`'s
    // answer against the two `S5_ACCOUNT` members that function itself returns.
    // Both authorities live in one module and the function reads the same
    // frozen object the comparison reads, so the condition was `x !== A && x
    // !== B` for `x` provably in `{A, B}` — always false in live code, and
    // firing only under this file's own mock. It gave
    // `customer_refund.registry_incomplete` a raise site that existed only
    // under instrumentation, which is the `customer.aging_buckets_invalid`
    // defect with a paragraph in the file denying it.
    //
    // This test asserts the DELETION, in both halves: the branch is gone from
    // the live code, and the code it claimed to raise is now declared as OWED
    // by an authority that is genuinely independent — the SQL chart of
    // accounts, which is a different source and not a second read of the same
    // object.
    const settlementCode = codeWithCommentsBlanked(readSource('apps/api/src/modules/returns/returns-settlement.ts'));
    expect(settlementCode, 'the tautological compensating check must not come back').not.toContain('registry_incomplete');
    const errors = await import('../../apps/api/src/modules/returns/returns-errors');
    const owed: Readonly<Record<string, string>> = errors.RETURNS_CODES_OWED_BY;
    expect(Object.prototype.hasOwnProperty.call(owed, 'customer_refund.registry_incomplete')).toBe(true);
    expect(owed['customer_refund.registry_incomplete']).toMatch(/level G/);
    // And the lawful refund on either source kind still plans, so the deletion
    // removed a refusal nobody could reach and nothing else.
    const settlement: Settlement = await import('../../apps/api/src/modules/returns/returns-settlement');
    for (const kind of ['credit_note', 'customer_credit'] as const) {
      expect(() =>
        settlement.planCustomerRefund({ source: refundSource(kind), consumedMinor: 1_000n, sameCurrency: false, disbursementAmountMinor: 900n, disbursement: BASE }),
      ).not.toThrow();
    }
  });
});

describe('P4-S5 §14 — no duplicate authority, no second mapping table, no dead member of the table', () => {
  it('§14.0 — the two views of a source file actually work, so no scan below is vacuous', () => {
    // A mis-copied blanker is the one failure that would make every scan in
    // this file pass for every input, and nothing else would notice. So the
    // blanker is exercised on a fixture whose answer is known by inspection.
    const fixture = ["// a comment naming 'accounts_receivable'", "const a = 'fx_gain'; /* and 'cogs' in a block */", 'const b = `t ${x} t`;'].join('\n');
    const kept = codeWithCommentsBlanked(fixture);
    const prose = codeWithProseBlanked(fixture);
    // Comments go in BOTH views.
    expect(kept).not.toContain('accounts_receivable');
    expect(kept).not.toContain('cogs');
    expect(prose).not.toContain('accounts_receivable');
    // A CODE string survives the comments-blanked view and not the prose view.
    // This is the exact asymmetry §14.1 depends on, and the reason it uses the
    // first view and §15's shape scan does too.
    expect(kept).toContain("'fx_gain'");
    expect(prose).not.toContain('fx_gain');
    // The identifiers around the string survive both.
    for (const view of [kept, prose]) expect(view).toContain('const a =');
    // Length is preserved in both, so an index in one addresses the same
    // character in the other.
    expect(kept).toHaveLength(fixture.length);
    expect(prose).toHaveLength(fixture.length);
    // A template's `${…}` substitution is code and survives the prose view.
    expect(prose).toContain('${x}');
  });

  it('§14.1 — NO ACCOUNT LITERAL survives in ANY S5 module, in ANY quoting style', () => {
    // S5-5's finding: the earlier version of this scan named two files and one
    // quoting style. The file set is now DISCOVERED from the module directory,
    // and all three JavaScript quoting styles are forbidden, because
    // `"fx_gain"` and a backticked `fx_gain` are the same bypass as `'fx_gain'`.
    //
    // The semantic proof of consumption is §13's matrix. This exists because a
    // literal that happens to EQUAL the canonical value today is invisible to a
    // behavioural test until someone moves the canonical value, and catching it
    // when it is written is cheaper than catching it when it matters.
    const files = s5ModuleFiles();
    // Non-vacuity: the discovery found the modules, including the two the old
    // scan named.
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain('apps/api/src/modules/returns/returns-settlement.ts');
    expect(files).toContain('apps/api/src/modules/returns/returns-ports.ts');

    const ids = ['sales_returns', 'accounts_receivable', 'customer_refund_liability', 'customer_credit_liability', 'inventory', 'cogs', 'fx_gain', 'fx_loss', 'posting_account'];
    let consumers = 0;
    for (const rel of files) {
      // The COMMENTS-BLANKED view, and it must be that one. Every question in
      // this describe is "does this STRING appear in code", so string bodies
      // have to SURVIVE: under the prose-blanked view `'accounts_receivable'`
      // is blanked to `'                  '` and the scan below would pass for
      // every file whatever it contained. A draft of this file used the wrong
      // view and was therefore vacuous; §14.0 exists so that cannot recur
      // silently.
      const code = codeWithCommentsBlanked(readSource(rel));
      if (code.includes('S5_ACCOUNT')) consumers += 1;
      for (const id of ids) {
        for (const q of ["'", '"', '`']) {
          // A quoted VALUE is forbidden. A property NAME (`fx_gain:`) is a key
          // into the canonical table and not a second authority over the
          // string, which is why only the quoted form is looked for.
          expect(code.includes(`${q}${id}${q}`), `${rel} spells the account ${id} itself instead of taking it from S5_ACCOUNT`).toBe(false);
        }
      }
    }
    // And the scan is not passing because the modules name no accounts at all.
    expect(consumers, 'no S5 module consumes the canonical account-id source — the scan above would then be vacuous').toBeGreaterThanOrEqual(2);
  });

  it('§14.2 — NO SECOND MAPPING TABLE: exactly one table in the slice maps an account vocabulary to S5 accounts', () => {
    const code = codeWithCommentsBlanked(readSource('apps/api/src/modules/returns/returns-settlement.ts'));
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
    // The ROLE authority's answers are members too, for both kinds.
    //
    // **This is an agreement check and not an independence check, and the
    // difference is the whole of S5-1.** `refundLiabilityAccount` reads the
    // same object this assertion reads, so a disagreement here is impossible
    // while both live in one module — which is why there is no runtime check of
    // it in `planCustomerRefund` and why `customer_refund.registry_incomplete`
    // is OWED rather than raised. A real independence check needs a second
    // source, and the chart of accounts in the database is that source, at
    // level G.
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
      expect(codeWithCommentsBlanked(readSource(rel))).toMatch(/import\s*\{[^}]*S5_ACCOUNT[^}]*\}\s*from\s*'@daftar\/domain-core'/);
    }
  });
});

describe('P4-S5 §15 — the refusal vocabulary has NO DEAD MEMBER either', () => {
  /**
   * The same test the neighbouring module failed, and that S5 then failed in
   * its own way. `customer.aging_buckets_invalid` is declared in a status
   * registry, thrown nowhere, and a docstring cited it as the check that
   * justified a 500. S5's version was worse: a raise site whose condition could
   * not be false, with a paragraph in the file asserting it made the code
   * reachable.
   *
   * The honest claim is not that every code is live — the route handler and the
   * SQL routines are owed at levels F and G. It is that the vocabulary
   * PARTITIONS: RAISED (a raise-shaped site in code, comments blanked), or OWED
   * (listed in `RETURNS_CODES_OWED_BY` with its authority and level NAMED).
   *
   * **The classifier measures a raise SHAPE, not presence**, which is S5-4's
   * finding. Three things it now rejects that raw-source presence accepted: a
   * code named in a comment, a code named in a message or any other
   * non-argument string, and a code named in a docstring that claims a check
   * exists. What it still cannot see is whether a raise-shaped site's condition
   * is REACHABLE — that is a semantic question, and the one place it mattered
   * is settled by deleting the tautology rather than by teaching this scanner
   * to find it.
   */
  const RAISE_SHAPES = (code: string): readonly RegExp[] => {
    const q = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      // Thrown directly: `refuse('code', …)`, `new ReturnsPlanError('code', …)`.
      new RegExp(`refuse\\(\\s*'${q}'`),
      new RegExp(`ReturnsPlanError\\(\\s*'${q}'`),
      // RETURNED as a value by a domain refusal function — `return 'code'`,
      // `=> 'code'`, and either arm of a conditional. The domain layer does not
      // throw; it answers with a code and the caller refuses with it, so a
      // scanner that only knew about `refuse(` would call most of this
      // vocabulary dead.
      new RegExp(`return\\s+'${q}'`),
      new RegExp(`=>\\s*'${q}'`),
      new RegExp(`\\?\\s*'${q}'`),
      // A VALUE after a colon: the `{ code: 'x' }` result objects, and the
      // translation map that turns a sibling slice's code into one of ours.
      // The negative lookahead is what keeps a KEY from counting: the status
      // table, the owed table and the type union all put the code on the left
      // of a colon, and none of them raises anything.
      new RegExp(`:\\s*'${q}'(?!\\s*:)`),
    ];
  };

  /**
   * THE THIRD CATEGORY, and the one a shape scanner cannot have.
   *
   * Four codes are COMPOSED at runtime and appear nowhere as a literal:
   * `returnsDateRefusal` returns `` `${domain}.date_invalid` `` and
   * `` `${domain}.date_in_future` ``, so the only text in the tree is the
   * suffix. A regex that accepted the suffix would accept a comment; a regex
   * that demanded the whole code would call four live refusals dead.
   *
   * So these are not classified by shape at all. They are classified by
   * CALLING the live function and collecting what it actually returns, which is
   * a stronger statement than any of the shapes above: it proves the code is
   * produced, not merely written. The input matrix is documented rather than
   * minimal — two domains × two defects — so the set is derived from behaviour
   * and not from a list someone has to maintain.
   */
  const composedCodes = async (): Promise<readonly string[]> => {
    const domain: Domain = await import('@daftar/domain-core');
    const out = new Set<string>();
    for (const d of ['credit_note', 'customer_refund'] as const) {
      // A malformed calendar date, and a document dated after the business's today.
      for (const [documentDate, originDate, businessToday] of [
        ['2026-13-45', '2026-01-01', '2026-03-04'],
        ['2026-04-01', '2026-01-01', '2026-03-04'],
      ] as const) {
        const verdict = domain.returnsDateRefusal(d, documentDate, originDate, businessToday);
        if (verdict !== null) out.add(verdict);
      }
    }
    return [...out].sort();
  };

  /** The live TypeScript of the slice, comments blanked and string bodies KEPT. */
  const liveCode = (): string =>
    [`packages/domain-core/src/returns.ts`, ...s5ModuleFiles()].map((rel) => codeWithCommentsBlanked(readSource(rel))).join('\n');

  it('the vocabulary partitions THREE ways — raise-shaped, composed-and-proved, or owed by a named authority — exhaustively and disjointly', async () => {
    const errors = await import('../../apps/api/src/modules/returns/returns-errors');
    const codes: readonly string[] = errors.RETURNS_CODES;
    const owed: Readonly<Record<string, string>> = errors.RETURNS_CODES_OWED_BY;
    const code = liveCode();
    expect(codes.length).toBeGreaterThan(30);

    const raised = codes.filter((c) => RAISE_SHAPES(c).some((re) => re.test(code)));
    const composed = await composedCodes();
    // Non-vacuity of both classifiers: the shape scan finds raise sites, and
    // the composed arm really produced codes by calling the live function.
    expect(raised.length).toBeGreaterThan(10);
    expect(composed.length).toBe(4);
    // Every composed code is a declared code — the function cannot answer with
    // something outside the vocabulary.
    for (const c of composed) expect(codes.includes(c), `${c} was produced by a live refusal function but is not a declared code`).toBe(true);
    // And the shape scan is STRICTER than presence, which is the point of the
    // change: the declaration regions name every code and it counts none of
    // them.
    expect(raised.length).toBeLessThan(codes.length);

    for (const c of codes) {
      const isRaised = raised.includes(c);
      const isComposed = composed.includes(c);
      const isOwed = Object.prototype.hasOwnProperty.call(owed, c);
      const where = [isRaised, isComposed, isOwed].filter(Boolean).length;
      expect(
        where,
        `${c} is declared in the status table and NOTHING raises it, NOTHING composes it and NOBODY owes it — it is a dead config member`,
      ).toBeGreaterThan(0);
      expect(
        where,
        `${c} is in more than one category: a code that is raised or composed must not also be listed as owed, or the owed entry outlives its reason`,
      ).toBe(1);
    }
    for (const c of Object.keys(owed)) expect(codes.includes(c), `${c} is owed by a named authority but is not a declared refusal code`).toBe(true);
    for (const [c, who] of Object.entries(owed)) {
      expect(who.length, `${c} is owed by nobody in particular`).toBeGreaterThan(20);
      expect(who, `${c} must name the level at which its authority is owed`).toMatch(/level [A-G]/);
    }
  });

  it('RED PROOF — the classifier rejects a COMMENT-ONLY mention, which is how the previous version passed', () => {
    // The subject is the real text of the real file. `returns-settlement.ts`
    // names `customer_refund.registry_incomplete` twice in COMMENTS — the
    // paragraph recording why its tautological check was deleted — and names it
    // nowhere in code.
    const settlement = readSource('apps/api/src/modules/returns/returns-settlement.ts');
    const CODE = 'customer_refund.registry_incomplete';
    // That the subject exists: the raw file really does mention it.
    expect(settlement).toContain(CODE);
    // That the two views really differ on this file, so the proof is not red
    // for want of a subject.
    expect(codeWithCommentsBlanked(settlement)).not.toContain(CODE);
    // THE DETECTION, and the exact defect named: the old classifier asked
    // whether the string was present and would have called this code raised
    // from a comment alone; the new one asks for a raise shape and does not.
    expect(settlement.includes(`'${CODE}'`), 'the raw-source classifier would have called this code RAISED from a comment').toBe(true);
    expect(RAISE_SHAPES(CODE).some((re) => re.test(codeWithCommentsBlanked(settlement)))).toBe(false);
  });

  it('RED PROOF — the partition check can FAIL: a code declared with no raiser and no owner is reported', async () => {
    const errors = await import('../../apps/api/src/modules/returns/returns-errors');
    const owed: Readonly<Record<string, string>> = errors.RETURNS_CODES_OWED_BY;
    const code = liveCode();
    const composed = await composedCodes();
    const PLANTED = 'credit_note.aging_buckets_invalid';
    // The plant is genuinely absent from all three categories, so this proof
    // cannot be red for another reason.
    expect(RAISE_SHAPES(PLANTED).some((re) => re.test(code))).toBe(false);
    expect(composed.includes(PLANTED)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(owed, PLANTED)).toBe(false);
    const verdict = [...errors.RETURNS_CODES, PLANTED].filter(
      (c: string) =>
        !RAISE_SHAPES(c).some((re) => re.test(code)) && !composed.includes(c) && !Object.prototype.hasOwnProperty.call(owed, c),
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
    const errorsSource = readSource('apps/api/src/modules/returns/returns-errors.ts');
    // OD-03 is CLOSED for Phase 4. An earlier draft of this very file said
    // OPEN, which is the kind of stale claim this assertion exists to catch.
    expect(errorsSource).not.toMatch(/OD-03 is OPEN/);
    expect(errorsSource).toContain('OD-03 is CLOSED for Phase 4');
    // And the claim that replaced the deleted one is held to ITS subject: the
    // owed entry must name an authority that is not another read of
    // `S5_ACCOUNT`. Asserted on the text of the entry, because that text is the
    // claim.
    expect(errorsSource).toMatch(/not a second read of S5_ACCOUNT \(level G\)/);
  });
});
