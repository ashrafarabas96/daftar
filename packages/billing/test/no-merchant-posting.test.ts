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
    const forbidden = ['@daftar/accounting', 'pg', '@nestjs/common', '@nestjs/core', '@daftar/shared-contracts'];
    for (const f of forbidden) {
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
  const POSTING_WORDS = ['journal', 'journalEntry', 'journal_entries', 'postEntry', 'doubleEntry', 'debit', 'credit_note', 'trialBalance', 'chartOfAccounts'];

  it('the words ARE present in prose, so the blanking is doing the work', () => {
    const raw = SOURCES.map(([, s]) => s)
      .join('\n')
      .toLowerCase();
    expect(raw).toContain('journal');
    expect(raw).toContain('posts nothing');
  });

  it('and none of them appears in code', () => {
    const offences: string[] = [];
    for (const [file, source] of SOURCES) {
      const code = blankOut(source).toLowerCase();
      for (const w of POSTING_WORDS) {
        if (code.includes(w.toLowerCase())) offences.push(`${file}: ${w}`);
      }
    }
    expect(offences, 'posting vocabulary reached the code of a package that must not post').toEqual([]);
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
