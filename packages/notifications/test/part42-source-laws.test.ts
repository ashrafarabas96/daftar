/**
 * PART 42, as executable laws over this package's own source.
 *
 * The HIGH finding this round closes was not a missing test — it was a NAME.
 * One field called `idempotencyKey`, filled with an attempt key, read by an
 * adapter as if it were an idempotency authority. A law that reads the source
 * is what stops that name coming back, in this adapter or the next one.
 *
 * Each law is a pure function over a file map, so a planted violation can be
 * fed to the same scanner the live tree is fed to — and every red proof below
 * asserts that its mutation actually LANDED in the copy it scans.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function readSource(dir = SRC): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, readSource(full));
    else if (name.endsWith('.ts')) out[relative(SRC, full)] = readFileSync(full, 'utf8');
  }
  return out;
}

/** Strip comments, so a law reads CODE and never a comment that mentions a word. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A missing file is a broken law, not an optional one: say so loudly. */
function fileOf(files: Record<string, string>, name: string): string {
  const content = files[name];
  if (content === undefined) throw new Error(`the law's subject is missing: ${name}`);
  return content;
}

type Violation = { readonly law: string; readonly file: string; readonly detail: string };

export function sourceViolations(files: Record<string, string> = readSource()): readonly Violation[] {
  const found: Violation[] = [];
  for (const [file, raw] of Object.entries(files)) {
    const body = code(raw);

    // L-P42-1: the conflated name is gone. There is no field, argument or
    // property called `idempotencyKey` anywhere in this package's code.
    if (/\bidempotencyKey\b/.test(body)) {
      found.push({ law: 'L-P42-1 no conflated idempotencyKey', file, detail: 'the name `idempotencyKey` is back in code' });
    }

    // L-P42-2: nothing hands an ATTEMPT key to a provider as an idempotency
    // key. Any line mentioning both `attemptKey` and `idempotency` is one.
    for (const line of body.split('\n')) {
      if (/attemptKey/.test(line) && /idempotenc/i.test(line)) {
        found.push({ law: 'L-P42-2 an attempt key is not an idempotency key', file, detail: line.trim().slice(0, 120) });
      }
    }

    // L-P42-3: a provider adapter must DECLARE its idempotency semantics. An
    // adapter that forgets to would default to `undefined`, which `mayAutoRetry`
    // reads as "no guarantee" — safe, but silent. Say it out loud.
    //
    // Scoped by what the file IS, not by where it sits. The directory test
    // `file.startsWith('providers/')` let an adapter at `src/sms-twilio.ts`
    // escape the law entirely, so the one thing the law exists to prevent — a
    // silent `undefined` — was reachable by putting a file in the obvious
    // place instead of the conventional one.
    if (/implements NotificationProvider/.test(body) && !/serverSideIdempotency/.test(body)) {
      found.push({ law: 'L-P42-3 an adapter declares its idempotency semantics', file, detail: 'no serverSideIdempotency declaration' });
    }

    // L-F5-1: the dispatcher must DECIDE the channel fallback by asking
    // `blocksAnotherChannel`, and must not re-derive it.
    //
    // The challenger found `blocksAnotherChannel` — the rule Mission V3
    // corrected, and the application-side twin of the partial unique index —
    // with no caller in `src/` at all: the dispatcher used its own
    // `next.action === 'retry'` latch instead. The two agreed by coincidence,
    // so the rule that was fixed was not the rule that ran, and no behavioural
    // test could tell. Only a law over the source can hold them together,
    // which is why this one is written here rather than as a case over outputs.
    if (file === 'dispatch.ts') {
      if (!/blocksAnotherChannel\(/.test(body)) {
        found.push({ law: 'L-F5-1 the dispatcher asks blocksAnotherChannel', file, detail: 'no call to blocksAnotherChannel' });
      }
      if (/next\.action === 'retry'/.test(body)) {
        found.push({ law: 'L-F5-1 the dispatcher asks blocksAnotherChannel', file, detail: 'the fallback is re-derived from next.action' });
      }
    }

    // L-F5-2: one rejection policy. `classifySend` must ask `retry.ts` rather
    // than carry a second copy of the attempt limit — the two differed only by
    // which field they read, and nothing made a divergence visible.
    if (file === 'delivery.ts' && !/nextStepAfterFailure\(/.test(body)) {
      found.push({ law: 'L-F5-2 one rejection policy, in retry.ts', file, detail: 'classifySend does not ask nextStepAfterFailure' });
    }

    // L-P48-1: no caller-supplied verification flag. A boolean a caller can set
    // is a boolean an attacker can set.
    if (/\bsignatureVerified\b/.test(body)) {
      found.push({ law: 'L-P48-1 no caller-supplied signatureVerified', file, detail: 'a caller-supplied verification flag exists' });
    }

    // L-M15-1 (Mission §15): "a notification failure never cancels a
    // successful sale or payment". This package holds no transaction and no
    // rollback, so it CANNOT cancel one — and that is a property worth keeping
    // mechanically, because the cheapest way to lose it is for an adapter
    // helper to drift in here carrying a handle. `businessTransactionId` is an
    // outbox payload key and is not a transaction handle, so the law names the
    // verbs rather than the noun.
    if (/\brollback\b|\bbeginTransaction\b|\.rollback\s*\(|\.commit\s*\(|\bsavepoint\b/i.test(body)) {
      found.push({ law: 'L-M15-1 the engine cannot cancel a sale', file, detail: 'transaction control reached a pure domain module' });
    }

    // L-M15V2-1 (Mission V2 §15): "ChannelLimits must come from approved
    // provider policy". The shipped table is provider documentation read from
    // this container, with no live provider call and no owner confirmation, so
    // every one of its entries must keep saying UNAPPROVED. The day the owner
    // rules, that is an edit to this line and a visible diff — not a figure
    // that quietly became policy because it had been there a while.
    if (file === 'limits.ts') {
      const entries = [...body.matchAll(/policySource:\s*([A-Za-z0-9_]+|'[^']*')/g)].map((m) => m[1] ?? '');
      // `policySource: string` is the INTERFACE, not an entry — a law that
      // counted it would be satisfied by a table with no entries at all.
      const shipped = entries.filter((e) => !e.startsWith("'") && e !== 'string');
      if (shipped.length < 4) {
        found.push({ law: 'L-M15V2-1 shipped limits declare their policy source', file, detail: `${shipped.length} of 4 channels name a source` });
      }
      if (!/UNAPPROVED/.test(body)) {
        found.push({ law: 'L-M15V2-1 shipped limits declare their policy source', file, detail: 'the shipped default no longer declares itself unapproved' });
      }
    }
  }
  return found;
}

const LAWS = [
  'L-P42-1 no conflated idempotencyKey',
  'L-P42-2 an attempt key is not an idempotency key',
  'L-P42-3 an adapter declares its idempotency semantics',
  'L-P48-1 no caller-supplied signatureVerified',
  'L-M15-1 the engine cannot cancel a sale',
  'L-M15V2-1 shipped limits declare their policy source',
  'L-F5-1 the dispatcher asks blocksAnotherChannel',
  'L-F5-2 one rejection policy, in retry.ts',
] as const;

describe('PART 42/48 — laws read over the live source', () => {
  it('the live source satisfies every law', () => {
    expect(sourceViolations()).toEqual([]);
  });

  it('the subject set is non-empty and real: it includes both adapters', () => {
    const files = Object.keys(readSource());
    expect(files).toContain('providers/whatsapp-cloud.ts');
    expect(files).toContain('providers/fake-provider.ts');
    expect(files.length).toBeGreaterThan(15);
  });

  it('L-F5-1 reds when the dispatcher decides the fallback itself again', () => {
    const files = readSource();
    const planted = {
      ...files,
      'dispatch.ts': fileOf(files, 'dispatch.ts')
        .replace(/blocksAnotherChannel\(\{ state: classified\.state \}\)/, "classified.next.action === 'retry'")
        .replace(/import \{ blocksAnotherChannel, /, 'import { '),
    };
    expect(fileOf(planted, 'dispatch.ts'), 'the mutation must land').not.toMatch(/blocksAnotherChannel\(/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-F5-1 the dispatcher asks blocksAnotherChannel');
  });

  it('L-F5-2 reds when classifySend carries its own copy of the attempt limit again', () => {
    const files = readSource();
    const planted = {
      ...files,
      'delivery.ts': fileOf(files, 'delivery.ts').replace(/nextStepAfterFailure\(/g, 'ownCopyOfThePolicy('),
    };
    expect(fileOf(planted, 'delivery.ts'), 'the mutation must land').not.toMatch(/nextStepAfterFailure\(/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-F5-2 one rejection policy, in retry.ts');
  });

  it('L-P42-3 catches an adapter placed OUTSIDE providers/, which the directory test missed', () => {
    const files = readSource();
    // The escape the challenger found: an adapter in `src/` rather than in
    // `src/providers/`. It declares nothing, so `mayAutoRetry` would read
    // `undefined` and silently treat an ambiguous send as non-idempotent.
    const planted = { ...files, 'sms-twilio.ts': 'export class TwilioProvider implements NotificationProvider {\n  readonly name = "twilio";\n}\n' };
    expect(fileOf(planted, 'sms-twilio.ts'), 'the mutation must land').toMatch(/implements NotificationProvider/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-P42-3 an adapter declares its idempotency semantics');
  });

  it('L-P42-1 reds when the conflated name returns', () => {
    const files = readSource();
    const planted = { ...files, 'provider.ts': fileOf(files, 'provider.ts').replace('readonly deliveryKey: string;', 'readonly idempotencyKey: string;') };
    expect(fileOf(planted, 'provider.ts'), 'the mutation must land').toMatch(/readonly idempotencyKey: string;/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-P42-1 no conflated idempotencyKey');
  });

  it('L-P42-2 reds when an attempt key is sent as an idempotency key', () => {
    const files = readSource();
    const planted = {
      ...files,
      'providers/whatsapp-cloud.ts': fileOf(files, 'providers/whatsapp-cloud.ts').replace(
        "'x-daftar-delivery-key': message.deliveryKey,",
        "'x-idempotency-key': message.attemptKey,",
      ),
    };
    expect(fileOf(planted, 'providers/whatsapp-cloud.ts'), 'the mutation must land').toMatch(/'x-idempotency-key': message\.attemptKey,/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-P42-2 an attempt key is not an idempotency key');
  });

  it('L-P42-3 reds when an adapter stops declaring its idempotency semantics', () => {
    const files = readSource();
    const planted = {
      ...files,
      'providers/whatsapp-cloud.ts': fileOf(files, 'providers/whatsapp-cloud.ts').replace(/readonly serverSideIdempotency = false;/, ''),
    };
    // The declaration is gone from the CODE; the file's prose still discusses
    // it, which is precisely what the law must not be satisfied by.
    expect(code(fileOf(planted, 'providers/whatsapp-cloud.ts')), 'the mutation must land').not.toMatch(/serverSideIdempotency/);
    expect(fileOf(planted, 'providers/whatsapp-cloud.ts'), 'and only the declaration changed').toMatch(/PART 42/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-P42-3 an adapter declares its idempotency semantics');
  });

  it('L-P48-1 reds when a caller-supplied verification flag returns', () => {
    const files = readSource();
    const planted = {
      ...files,
      'webhook.ts': fileOf(files, 'webhook.ts').replace('readonly status: string;', 'readonly status: string;\n  readonly signatureVerified: boolean;'),
    };
    expect(fileOf(planted, 'webhook.ts'), 'the mutation must land').toMatch(/readonly signatureVerified: boolean;/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-P48-1 no caller-supplied signatureVerified');
  });

  it('L-M15-1 reds when transaction control reaches a pure module', () => {
    const files = readSource();
    const planted = {
      ...files,
      'dispatch.ts': fileOf(files, 'dispatch.ts').replace(
        'const outcomes: DispatchOutcome[] = [];',
        'await tx.rollback();\n  const outcomes: DispatchOutcome[] = [];',
      ),
    };
    expect(code(fileOf(planted, 'dispatch.ts')), 'the mutation must land').toMatch(/await tx\.rollback\(\);/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-M15-1 the engine cannot cancel a sale');
  });

  it('L-M15-1 is not satisfied by the absence of its subject: the outbox payload key stays legal', () => {
    // `businessTransactionId` is live in catalog.ts. A law written against the
    // noun would red on the real tree, and the fix would be to delete a true
    // payload key — so the law names the verbs, and this proves it.
    const files = readSource();
    expect(fileOf(files, 'catalog.ts')).toMatch(/businessTransactionId/);
    expect(sourceViolations(files)).toEqual([]);
  });

  it('L-M15V2-1 reds when the shipped limits stop declaring themselves unapproved', () => {
    const files = readSource();
    const planted = {
      ...files,
      'limits.ts': fileOf(files, 'limits.ts').replace(/UNAPPROVED/g, 'APPROVED-BY-NOBODY'),
    };
    expect(code(fileOf(planted, 'limits.ts')), 'the mutation must land').not.toMatch(/UNAPPROVED/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-M15V2-1 shipped limits declare their policy source');
  });

  it('L-M15V2-1 also reds when the shipped table carries no policy source at all', () => {
    const files = readSource();
    const planted = { ...files, 'limits.ts': fileOf(files, 'limits.ts').replaceAll('policySource: UNAPPROVED,', '') };
    expect(code(fileOf(planted, 'limits.ts')), 'the mutation must land').not.toMatch(/policySource: UNAPPROVED,/);
    expect(sourceViolations(planted).map((v) => v.law)).toContain('L-M15V2-1 shipped limits declare their policy source');
  });

  it('every declared law has a red proof above', () => {
    // The law that reds if a law is added without one. The names below are the
    // ones each red proof asserts on; a new law with no proof fails here.
    const proved = new Set([
      'L-P42-1 no conflated idempotencyKey',
      'L-P42-2 an attempt key is not an idempotency key',
      'L-P42-3 an adapter declares its idempotency semantics',
      'L-P48-1 no caller-supplied signatureVerified',
      'L-M15-1 the engine cannot cancel a sale',
      'L-M15V2-1 shipped limits declare their policy source',
      'L-F5-1 the dispatcher asks blocksAnotherChannel',
      'L-F5-2 one rejection policy, in retry.ts',
    ]);
    for (const law of LAWS) expect(proved.has(law), law).toBe(true);
    expect(proved.size).toBe(LAWS.length);
  });

  it('the scanner reads code, not comments: the words appear in prose and the laws stay green', () => {
    // Proof that `code()` is doing work — otherwise every law above would be
    // satisfied by nothing more than careful comment wording, which is exactly
    // the defect TL-P4-COORD-R46 found elsewhere in this program.
    const files = readSource();
    const commentOnly = {
      'x.ts': '// idempotencyKey signatureVerified attemptKey idempotency rollback savepoint\n/* idempotencyKey .commit( */\nexport const a = 1;\n',
    };
    expect(sourceViolations(commentOnly)).toEqual([]);
    const realCode = { 'x.ts': 'export interface A { readonly idempotencyKey: string }\n' };
    expect(sourceViolations(realCode).map((v) => v.law)).toContain('L-P42-1 no conflated idempotencyKey');
    expect(Object.keys(files).length).toBeGreaterThan(0);
  });
});
