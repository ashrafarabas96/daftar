/**
 * §16 / `TL-P5-R1`, as an executed boundary: platform billing is NOT merchant
 * accounting.
 *
 * The owner's ruling: never post platform SaaS revenue, provider settlement,
 * SaaS tax or dunning entries into a merchant's journals. Operator
 * double-entry, if the owner ever wants it, is a separate explicit platform
 * accounting architecture, and it never reuses the merchant books.
 *
 * ── Why this is a law over imports and symbols, not over behaviour ──────
 *
 * There is nothing to observe. The violation this rule prevents is a FUTURE
 * one: a later edit to this package that reaches for `@daftar/accounting`
 * because the posting engine is right there and already correct. By then the
 * reviewer is reading a plausible diff that makes a platform invoice appear
 * in a merchant's trial balance. So the boundary is stated where it can be
 * broken — the import list — and it reds on the first line that crosses it.
 *
 * `packages/accounting` is the merchant's one financial authority (Phase 3),
 * and `MAX_BILLING_MINOR` in `types.ts` is deliberately a RESTATEMENT of its
 * `MAX_MONEY_MINOR` pinned by a test, rather than an import, for exactly this
 * reason: a dependency edge, once it exists for a constant, is the edge a
 * posting call later travels along.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { blankOut, stringLiteralsOf } from './helpers/lexer';

const SRC = join(__dirname, '..', 'src');

const SOURCES: ReadonlyArray<readonly [string, string]> = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

/** Every module specifier `src/` imports, read as a string literal in code. */
function importedModules(source: string): string[] {
  const blanked = blankOut(source);
  const specs: string[] = [];
  // The specifier is a string literal, so its body is blanked. The positions
  // are preserved, so the literal is read back out of the ORIGINAL at the
  // offsets the blanked text gives — which is what `stringLiteralsOf` does.
  const literals = stringLiteralsOf(source);
  const importCount = [...blanked.matchAll(/\bimport\b[^\n]*\bfrom\s*['"]/g)].length;
  // Each `import … from '…'` contributes exactly one specifier, and the
  // specifiers are the only literals that appear in an import statement.
  for (const m of blanked.matchAll(/\bimport\b[^\n]*\bfrom\s*(['"])/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const quote = m[1] as string;
    const close = blanked.indexOf(quote, open + 1);
    if (close > open) specs.push(source.slice(open + 1, close));
  }
  expect(specs.length, 'the import extraction did not find what the regex counted').toBe(importCount);
  // Guards a lexer regression that would make every assertion below vacuous.
  expect(literals.length).toBeGreaterThanOrEqual(specs.length);
  return specs;
}

const ALL_IMPORTS = SOURCES.flatMap(([, s]) => importedModules(s));

/** What `src/` may never import: the merchant's authority, or a driver. */
const FORBIDDEN_IMPORTS = ['@daftar/accounting', 'pg', '@nestjs/common', '@nestjs/core', '@daftar/shared-contracts'] as const;

/** The specifiers of `imports` that are neither relative nor allowed here. */
function crossings(imports: readonly string[]): string[] {
  return imports.filter((spec) => !spec.startsWith('./') || FORBIDDEN_IMPORTS.includes(spec as (typeof FORBIDDEN_IMPORTS)[number]));
}

/**
 * The posting vocabulary, read over BLANKED source so prose that explains the
 * rule does not red the rule. Named here so a PLANTED module can go through
 * the same checker: until 2026-11-12 this file carried positive controls and
 * no planted violation, so nothing had seen it say no (§5).
 */
const POSTING_WORDS = [
  'journal',
  'journalEntry',
  'journal_entries',
  'postEntry',
  'doubleEntry',
  'debit',
  'credit_note',
  'trialBalance',
  'chartOfAccounts',
] as const;

function postingOffences(sources: ReadonlyArray<readonly [string, string]>): string[] {
  const offences: string[] = [];
  for (const [file, source] of sources) {
    const code = blankOut(source).toLowerCase();
    for (const w of POSTING_WORDS) {
      if (code.includes(w.toLowerCase())) offences.push(`${file}: ${w}`);
    }
  }
  return offences;
}

describe('§16 — this package imports nothing that can post to a merchant journal', () => {
  it('finds imports at all (the extraction is not vacuous)', () => {
    expect(ALL_IMPORTS.length).toBeGreaterThan(10);
    // Two specifiers that must be found if the extraction works.
    expect(ALL_IMPORTS).toContain('./errors');
    expect(ALL_IMPORTS).toContain('./types');
  });

  it('imports only its own modules — no package, not even its own dependency', () => {
    // Every specifier is relative. `@daftar/domain-core` is declared as a
    // dependency in `package.json` for the promotion step that will map
    // `billing.*` onto the HTTP contract, and nothing in `src/` imports it
    // yet; this case says so out loud rather than leaving it to be noticed.
    const foreign = ALL_IMPORTS.filter((s) => !s.startsWith('./'));
    expect(foreign, 'src/ imports something outside this package').toEqual([]);
  });

  it('imports neither the merchant posting engine nor a database client', () => {
    for (const f of FORBIDDEN_IMPORTS) {
      expect(ALL_IMPORTS, `src/ imports ${f}`).not.toContain(f);
    }
  });
});

describe('§16 — no posting vocabulary appears in this package code', () => {
  /**
   * The words a posting call would have to use. They are checked over BLANKED
   * source, because several modules explain in prose that they post nothing —
   * `index.ts` says "It posts nothing", `proration.ts` says it "does not know
   * what a journal is" — and a raw-text law would red on the documentation of
   * the rule it enforces.
   */
  it('the words ARE present in prose, so the blanking is doing the work', () => {
    const raw = SOURCES.map(([, s]) => s)
      .join('\n')
      .toLowerCase();
    expect(raw).toContain('journal');
    expect(raw).toContain('posts nothing');
  });

  it('and none of them appears in code', () => {
    expect(postingOffences(SOURCES), 'posting vocabulary reached the code of a package that must not post').toEqual([]);
  });
});

describe('PART 26 — a missing credential can never become a fake success', () => {
  /**
   * The ruling: "Missing credential: external activation pending, not a
   * reason to fake provider success."
   *
   * The structural guarantee is that NOTHING in `src/` chooses a provider.
   * `PaymentProviderPort` is an interface, `FakePaymentProvider` is a class a
   * caller must name, and there is no factory, no registry and no default. So
   * there is no code path along which an absent credential could fall back to
   * the fake — the fall-back would have to be written at the call site, in
   * daylight, by someone typing the fake's name.
   */
  it('contains no provider factory, registry or default', () => {
    const offences: string[] = [];
    for (const [file, source] of SOURCES) {
      const code = blankOut(source);
      for (const w of ['createProvider', 'getProvider', 'resolveProvider', 'defaultProvider', 'providerFor', 'PROVIDER_REGISTRY', 'process.env']) {
        if (code.includes(w)) offences.push(`${file}: ${w}`);
      }
    }
    expect(offences, 'src/ selects a provider, so a missing credential has somewhere to fall back to').toEqual([]);
  });

  it('nothing but the fake module mentions the fake', () => {
    // If a real code path named `FakePaymentProvider`, that path is the
    // fall-back this rule forbids.
    const leaks: string[] = [];
    for (const [file, source] of SOURCES) {
      if (file === 'fake-provider.ts' || file === 'index.ts') continue;
      if (blankOut(source).includes('FakePaymentProvider')) leaks.push(file);
    }
    expect(leaks, 'a module other than the fake itself reaches for the fake').toEqual([]);
  });

  it('the port carries no credential, endpoint or test-mode field', () => {
    // A port with a credential field is a port that can be constructed
    // without one, and "constructed without one" is where a fake success
    // comes from.
    const code = blankOut(readFileSync(join(SRC, 'ports.ts'), 'utf8'));
    for (const w of ['apiKey', 'secret', 'token', 'credential', 'endpoint', 'baseUrl', 'testMode', 'sandbox']) {
      expect(code, `${w} appears in the payment port`).not.toContain(w);
    }
  });

  it('a declined or failed charge is a RESULT, and unreachability throws', () => {
    // The distinction PART 26 depends on: a provider that could not be
    // reached must not look like a provider that answered. A decline is data
    // on the result; unreachability is an exception, and it records nothing.
    const ports = blankOut(readFileSync(join(SRC, 'ports.ts'), 'utf8'));
    expect(ports).toContain('CHARGE_OUTCOMES');
    expect(stringLiteralsOf(readFileSync(join(SRC, 'ports.ts'), 'utf8'))).toContain('declined');
    // And there is no refusal code for a decline, because a decline is not a
    // refusal — `test/error-codes-are-live.test.ts` found the dead code that
    // claimed otherwise.
    expect(stringLiteralsOf(readFileSync(join(SRC, 'errors.ts'), 'utf8'))).not.toContain('billing.provider_declined');
  });
});

describe('§17 / TL-P5-R2 — platform SaaS tax stays unsupported', () => {
  it('states tax as a structural zero that a caller cannot change', () => {
    // Already enforced in `invoice.test.ts` by calling the composer; this case
    // pins the SHAPE, so a later edit that adds a configurable rate is caught
    // even before a behavioural case is written for it.
    const invoice = readFileSync(join(SRC, 'invoice.ts'), 'utf8');
    const code = blankOut(invoice);
    expect(code).toContain('taxMinor: 0n');
    // The refusal code is a STRING, so it is read out of the literals rather
    // than out of the blanked code, where its body is spaces by design.
    expect(stringLiteralsOf(invoice)).toContain('billing.subscription_tax_unsupported');
    // No rate, no percentage, no jurisdiction table.
    for (const w of ['taxRate', 'vatRate', 'rateBasisPoints', 'jurisdiction']) {
      expect(code, `${w} appears in invoice.ts; TL-P5-R2 forbids a guessed tax policy`).not.toContain(w);
    }
  });
});

describe('§16 — the boundary says no to a planted crossing (the negative controls)', () => {
  // Every plant below is a STRING. Nothing is written into `src/`, so there
  // is nothing to restore and DR-09 is untouched.

  it('NEGATIVE CONTROL: an import of the merchant posting engine is reported', () => {
    const planted = "import { postEntry } from '@daftar/accounting';\nexport const post = postEntry;\n";
    const specs = importedModules(planted);
    expect(specs, 'the extractor read nothing out of the plant, so this control proves nothing').toContain('@daftar/accounting');
    expect(crossings(specs), 'the checker missed an import of the merchant authority').toEqual(['@daftar/accounting']);
  });

  it('NEGATIVE CONTROL: a database driver import is reported too', () => {
    const planted = "import { Client } from 'pg';\nexport const c = Client;\n";
    expect(importedModules(planted), 'the driver plant did not parse').toContain('pg');
    expect(crossings(importedModules(planted)), 'the checker missed a database client').toEqual(['pg']);
  });

  it('NEGATIVE CONTROL: posting vocabulary in CODE is reported, with its file', () => {
    const planted: ReadonlyArray<readonly [string, string]> = [['planted.ts', 'export const x = (journalEntry: number): number => journalEntry + 1;\n']];
    const reported = postingOffences(planted);
    expect(reported.length, 'the checker missed posting vocabulary in code').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('planted.ts');
  });

  it('NO FALSE RED: the same word in prose or in a string literal is not reported', () => {
    // This is what the blanking buys, and the direction the law must not
    // fail in: `index.ts` explains that it posts nothing, and a raw-text law
    // would red on the documentation of the rule it enforces.
    const planted: ReadonlyArray<readonly [string, string]> = [
      ['prose.ts', '// this module writes no journalEntry and knows no chartOfAccounts\nexport const n = 1;\n'],
      ['literal.ts', "export const label = 'journalEntry';\n"],
    ];
    expect(postingOffences(planted), 'a comment or a string literal was read as code').toEqual([]);
  });

  it('NO FALSE RED: a relative import of this package`s own module is not a crossing', () => {
    const specs = importedModules("import { money } from './types';\nexport const m = money;\n");
    expect(specs, 'the relative plant did not parse').toContain('./types');
    expect(crossings(specs), 'an own-module import was reported as a crossing').toEqual([]);
  });
});
