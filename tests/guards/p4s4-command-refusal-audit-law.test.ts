/**
 * P4-S4 — THE GATE LAW «EVERY PHASE 4 COMMAND AUDITS ITS REFUSALS», PROVED
 * RED (P4-AL-48, `[[daftar-a-green-gate-must-prove-it-can-be-red]]`).
 *
 * `scripts/phase4-s4-gate.ts`'s `command-refusal-audit` check is a DISCOVERY
 * law: it reads the declared Phase 4 `invctl/1` operation vocabulary off its
 * own type unions, finds the command paths in the API's services, and requires
 * each one's refusal path to reach the ONE `auditThenRethrow…` composer. So
 * the set grows by itself: a P4-S5 refund command is a subject on the day its
 * service lands, with nothing registered here.
 *
 * A discovery law has two failure modes that look like success, and this suite
 * exists for both:
 *
 *   1. **it finds nothing.** A law whose subject set is empty passes
 *      vacuously, and the tree it passes on is the tree where every command's
 *      audit was deleted. Rule 3 below plants exactly that.
 *   2. **it finds everything and judges nothing.** Rule 2 plants a defect in
 *      ONE discovered command — the audit call removed from
 *      `TillSessionService.close` and from nowhere else — and requires the law
 *      to go red NAMING that command. A law that reported a file, or a count,
 *      would leave a reviewer to go looking.
 *
 * Every defect is planted on a MUTATED COPY of the real source text. Nothing
 * here writes to the tree, so the law this suite proves is the law the gate
 * runs, judged on the text this repository actually holds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandRefusalAuditProblems,
  commandRefusalAuditReport,
  discoverPhase4Commands,
  maskLiterals,
  methodBodies,
  phase4Commands,
  phase4OperationCodes,
  refusalAuditProblems,
  refusalAuditSubject,
  type CommandPath,
} from '../../scripts/phase4-s4-gate';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const TILL = 'apps/api/src/modules/pos/till-session.service.ts';
const SALE = 'apps/api/src/modules/selling/sale-commit.service.ts';
const CHECKOUT = 'apps/api/src/modules/pos/pos-checkout.service.ts';
const CART = 'apps/api/src/modules/pos/pos-cart.service.ts';
const PAYMENT = 'apps/api/src/modules/receivables/customer-payment.service.ts';

/** The operation vocabulary, and the constant table the real discovery uses — reused so a mutation changes ONE thing. */
const OPS = phase4OperationCodes(ROOT);
const CONSTANTS = new Map<string, readonly string[]>([
  ['OP_CODE', ['pos.cart_set_line', 'pos.cart_remove_line']],
  ['CUSTOMER_COLLECT_PAYMENT_OP', ['customer.collect_payment']],
]);

/** Run the discovery over supplied TEXT rather than over the tree. */
function discover(sources: readonly { readonly file: string; readonly text: string }[]): CommandPath[] {
  return discoverPhase4Commands(OPS, sources, () => CONSTANTS);
}

/** The law's verdict over supplied command paths, with everything else about the tree left true. */
function verdict(commands: readonly CommandPath[]): string[] {
  return refusalAuditProblems({ ...refusalAuditSubject(ROOT), commands });
}

describe('P4-AL-48 — the gate law: every Phase 4 command audits its refusals', () => {
  describe('the law is satisfied by this tree, and it has a subject', () => {
    it('`command-refusal-audit` is silent on the tree as committed', () => {
      expect(commandRefusalAuditProblems(ROOT), commandRefusalAuditReport(ROOT)).toEqual([]);
    });

    it('the discovery found the Phase 4 operation vocabulary from its own type unions', () => {
      // Not a list of what the vocabulary must hold: the law learns it. What
      // is asserted is that the READING worked and found the operations this
      // slice's commands are known to exercise.
      expect(OPS.length).toBeGreaterThan(0);
      expect(OPS).toEqual(expect.arrayContaining(['sale.commit', 'pos.session_open', 'pos.session_close', 'customer.collect_payment']));
    });

    it('it found the command paths of this slice and the slices behind it, from the code', () => {
      const found = phase4Commands(ROOT).map((c) => `${c.file}#${c.method}`);
      for (const expected of [`${SALE}#commit`, `${TILL}#open`, `${TILL}#close`, `${CHECKOUT}#checkout`, `${CART}#addLine`, `${PAYMENT}#collect`])
        expect(found, commandRefusalAuditReport(ROOT)).toContain(expected);
    });

    it('and it did NOT take the READS for commands — a read authorizes no operation', () => {
      // The discovery excludes them by its own rule rather than by an
      // exception list, which is the thing that makes it survive a new read.
      const found = phase4Commands(ROOT).map((c) => `${c.file}#${c.method}`);
      expect(found).not.toContain(`${TILL}#read`);
      expect(found).not.toContain(`${TILL}#current`);
      expect(found).not.toContain(`${CART}#readCart`);
    });
  });

  describe('rule 1 — the structural readers do not fire on prose', () => {
    it('`maskLiterals` blanks a comment and a template literal, so neither can be mistaken for code', () => {
      const masked = maskLiterals("// authorize(m, 'sale.commit')\nconst q = `SELECT {$a} FROM t`;\nconst r = 1;");
      expect(masked).not.toContain('sale.commit');
      expect(masked).not.toContain('SELECT');
      expect(masked).toContain('const r = 1;');
      // Indices must still line up, or every brace match below is off by the
      // length of the prose it skipped.
      expect(masked).toHaveLength("// authorize(m, 'sale.commit')\nconst q = `SELECT {$a} FROM t`;\nconst r = 1;".length);
    });

    it('`methodBodies` reads a class method and not an interface signature of the same shape', () => {
      const names = methodBodies(read(TILL)).map((m) => m.name);
      expect(names).toEqual(expect.arrayContaining(['open', 'close', 'read', 'current']));
      expect(names).not.toContain('constructor');
    });
  });

  describe('rule 2 — RED on a PLANTED defect: the audit call removed from ONE command', () => {
    /** The real till-session service with `close`'s composer call — and only `close`'s — replaced. */
    function tillWithoutCloseAudit(): string {
      const text = read(TILL);
      const close = text.indexOf('async close(');
      expect(close, 'the planted defect has no subject: `async close(` is not in the till-session service').toBeGreaterThan(0);
      const call = text.indexOf('auditThenRethrowSellingRefusal', close);
      expect(call, 'the planted defect has no subject: `close` does not call the composer in the tree as committed').toBeGreaterThan(0);
      return `${text.slice(0, call)}rethrowPosRefusal${text.slice(call + 'auditThenRethrowSellingRefusal'.length)}`;
    }

    it('the law NAMES the un-audited command, and leaves the audited one alone', () => {
      const commands = discover([
        { file: TILL, text: tillWithoutCloseAudit() },
        { file: SALE, text: read(SALE) },
      ]);
      const problems = verdict(commands);
      expect(problems.some((p) => p.includes(`${TILL}: close`))).toBe(true);
      // The sibling command in the SAME file is untouched, which is what makes
      // this a per-command law rather than a per-file one: a file-level check
      // would have reported `open` too and a reviewer could not tell which
      // command lost its audit.
      expect(problems.some((p) => p.includes(`${TILL}: open`))).toBe(false);
      expect(problems.some((p) => p.includes(`${SALE}: commit`))).toBe(false);
    });

    it('the refusal says what was lost: the operation, and that no evidence would persist', () => {
      const problems = verdict(discover([{ file: TILL, text: tillWithoutCloseAudit() }]));
      const named = problems.find((p) => p.includes(`${TILL}: close`)) ?? '';
      expect(named).toContain('pos.session_close');
      expect(named).toContain('no audit evidence');
    });

    it('and the same mutation applied to the SALE commit is named too, so the law is not about one file', () => {
      const text = read(SALE);
      const call = text.indexOf('auditThenRethrowSellingRefusal(this.audit');
      expect(call).toBeGreaterThan(0);
      const planted = `${text.slice(0, call)}rethrowSellingRefusal(${text.slice(call + 'auditThenRethrowSellingRefusal('.length)}`;
      const problems = verdict(discover([{ file: SALE, text: planted }]));
      expect(problems.some((p) => p.includes(`${SALE}: commit`) && p.includes('sale.commit'))).toBe(true);
    });
  });

  describe('rule 3 — RED when the discovery finds NO SUBJECT AT ALL', () => {
    it('an empty command set is a refusal and never a pass', () => {
      const problems = verdict([]);
      expect(problems.some((p) => p.includes('matched no service method'))).toBe(true);
    });

    it('and a tree whose operation vocabulary cannot be read is a refusal too', () => {
      const problems = refusalAuditProblems({ ...refusalAuditSubject(ROOT), ops: [] });
      expect(problems.some((p) => p.includes('no InventoryP4S<n>OperationCode union'))).toBe(true);
    });

    it('a service whose text authorizes nothing Phase 4 contributes no subject — which is why rule 3 can happen at all', () => {
      expect(
        discover([{ file: 'apps/api/src/modules/x/x.service.ts', text: 'export class X {\n  async go(): Promise<void> {\n    await this.q();\n  }\n}\n' }]),
      ).toEqual([]);
    });
  });

  describe('rule 4 — RED on a SECOND refusal-audit mechanism', () => {
    it('a surface binding that does not delegate to the one composer module is named', () => {
      const problems = refusalAuditProblems({
        ...refusalAuditSubject(ROOT),
        bindings: [{ file: 'apps/api/src/modules/pos/pos-refusal-audit.ts', delegates: false }],
      });
      expect(problems.some((p) => p.includes('second refusal-audit mechanism'))).toBe(true);
    });

    it('and the missing composer module is named', () => {
      const problems = refusalAuditProblems({ ...refusalAuditSubject(ROOT), composerModule: false });
      expect(problems.some((p) => p.includes('refusal-audit.ts is missing'))).toBe(true);
    });

    it('both surface bindings in this tree DO delegate, so rule 4 is satisfied rather than unreachable', () => {
      const { bindings } = refusalAuditSubject(ROOT);
      expect(bindings.length).toBeGreaterThan(0);
      for (const b of bindings) expect(b.delegates, `${b.file} does not delegate to the one composer`).toBe(true);
    });
  });
});
