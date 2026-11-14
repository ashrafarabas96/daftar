/**
 * TD-24 — THE TWO KEYS OF THE ONE `EVAL` MUST HASH TO THE SAME CLUSTER SLOT.
 *
 * Card TD-24-ق-8, launch-blocking by the owner's decision. Raised as the
 * seventh item of the third independent review of PR #46 and deliberately NOT
 * answered there, for a measured reason: there is no cluster-mode Redis in CI
 * or on a development host, so the defect could not be measured in that lane.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────
 *
 * `RedisThrottlerStorage.increment` runs ONE `EVAL` over TWO keys: the window
 * counter and its `:blocked` flag. Redis Cluster refuses any command whose
 * keys do not hash to one slot — `CROSSSLOT Keys in request don't hash to the
 * same slot`. With no shared hash tag, EVERY `EVAL` fails, `increment` falls
 * through to the per-replica fallback, and the general allowance is counted
 * PER REPLICA again — for the whole life of the deployment, behind one
 * cooled-down warning line and one metric. That is TD-24 itself, reached
 * through the fix for TD-24, with nothing visibly broken.
 *
 * What holds it shut today is a document, not the code:
 * `docs/DAFTAR_AWS_REFERENCE_ARCHITECTURE.md` guarantees it in the line that
 * reads "ElastiCache Redis (cluster mode disabled, Multi-AZ)". The citation is
 * by TEXT and not by line number on purpose: the first form of this comment
 * said `:42`, which was true where it was written and pointed at an unrelated
 * worker-JWT paragraph once the patch was carried onto another base (review of
 * #77). A setting changed in the infrastructure unit would open this silently,
 * which is why this is a law and not a comment.
 *
 * ── WHAT IS MEASURED, AND WHAT IS NOT ────────────────────────────────────
 *
 * MEASURED: that the keys of one `EVAL` fall in the same slot, computed here
 * with `CRC16(hash tag) mod 16384` — the cluster's own published condition
 * (`docs/DAFTAR_...` aside, it is in Redis's cluster specification).
 *
 * NOT MEASURED, and not claimed anywhere in this card: Redis Cluster's own
 * behaviour. Neither CI nor this host runs a cluster. A green run here is
 * evidence about slot equality, NOT evidence of a successful cluster deploy.
 *
 * Three claims, and the last two are what keep the first from being vacuous:
 *
 *   TD24-SLOT-A  REFERENCE. The slot calculator in this file is checked
 *                against values that do not come from it: the standard
 *                CRC-16/XMODEM check value for `123456789` (`0x31C3`), the
 *                slot Redis's cluster specification cites for `foo` (12182),
 *                and a documented `{...}` pair that must land on the slot of
 *                the tag alone. Without this, "the slots match" could just be
 *                a broken function answering the same number for everything.
 *   TD24-SLOT-B  THE CLAIM, on the keys the STORE ITSELF sends — recorded
 *                from the evaluator, not re-derived here, so the law cannot
 *                pass against a key shape the store does not use. Every key
 *                of the one `EVAL` shares a slot, for the pre-auth scope, for
 *                a tenant scope, and for caller text carrying braces of its
 *                own. And the tags are NOT all one constant: that would also
 *                satisfy a cluster, by collapsing every allowance in the
 *                system into a single slot.
 *   TD24-SLOT-C  NEGATIVE CONTROL. The shape this card removes — the same two
 *                keys with no tag — lands in DIFFERENT slots. Without it, A
 *                and B would pass just as well against a calculator that
 *                could not tell two keys apart.
 */
import { describe, expect, it } from 'vitest';
import { PRE_AUTH_SCOPE, RATE_LIMIT_KEY_PREFIX, RedisThrottlerStorage, type RateLimitEvaluator } from '../apps/api/src/infra/rate-limit-store';
import { InMemoryMetrics } from '../apps/api/src/infra/metrics';

const LIMIT = 300; // apps/api/src/app/runtime.ts — unchanged by this card (DR-41/DR-74)
const TTL_MS = 60_000;
const TENANT = '11111111-1111-4111-8111-111111111111';
/** Redis Cluster's fixed number of slots. */
const SLOTS = 16_384;

/**
 * CRC-16/XMODEM — polynomial `0x1021`, initial value `0x0000`, no reflection,
 * no final xor — which is the function Redis Cluster hashes keys with.
 *
 * Written out here rather than imported: the point of the law is to compute
 * the slot INDEPENDENTLY of the code under test, and `TD24-SLOT-A` checks
 * this implementation against values that originate outside this file.
 */
function crc16(text: string): number {
  let crc = 0;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/**
 * The hash tag of a key: what lies between the FIRST `{` and the first `}`
 * after it. An absent, unterminated or EMPTY tag means the whole key is
 * hashed — the three exceptions the cluster specification names, and the
 * reason this is a function rather than one regular expression.
 */
function hashTag(key: string): string {
  const open = key.indexOf('{');
  if (open === -1) return key;
  const close = key.indexOf('}', open + 1);
  if (close === -1 || close === open + 1) return key;
  return key.slice(open + 1, close);
}

/** The slot a cluster would place this key in. */
function slotOf(key: string): number {
  return crc16(hashTag(key)) % SLOTS;
}

/**
 * An evaluator that answers plausibly and RECORDS THE KEYS IT WAS GIVEN, so
 * the law measures what the store actually sends. Its answer is deliberately
 * the uninteresting one — admitted, not blocked — because nothing here is
 * about counting.
 */
class RecordingEvaluator implements RateLimitEvaluator {
  readonly keysSeen: readonly string[][] = [];

  eval(_script: string, keys: readonly string[], _args: readonly string[]): Promise<readonly number[]> {
    (this.keysSeen as string[][]).push([...keys]);
    return Promise.resolve([1, TTL_MS, 0, 0]);
  }
}

/** The keys of the single `EVAL` one `increment` performs, as the store sent them. */
async function keysOfOneEval(options: { readonly key: string; readonly tenantId?: string }): Promise<readonly string[]> {
  const redis = new RecordingEvaluator();
  const store = new RedisThrottlerStorage(redis, {
    metrics: new InMemoryMetrics(),
    scope: options.tenantId === undefined ? PRE_AUTH_SCOPE : { kind: 'tenant', tenantId: options.tenantId },
  });
  await store.increment(options.key, TTL_MS, LIMIT, TTL_MS, 'default');
  const keys = redis.keysSeen[0];
  if (keys === undefined) throw new Error('the store performed no EVAL, so this law measured nothing');
  // Two keys, not one: a store that had stopped sending the block key would
  // make slot equality trivially true.
  expect(keys).toHaveLength(2);
  return keys;
}

describe('TD-24 law — one EVAL, one slot', () => {
  it('TD24-SLOT-A (reference): the slot calculator agrees with values that did not come from it', () => {
    // The published check value of CRC-16/XMODEM. If this is wrong, every
    // other number in this file is decoration.
    expect(crc16('123456789')).toBe(0x31c3);
    expect(crc16('')).toBe(0x0000);
    // The slot Redis's cluster specification uses as its own example.
    expect(slotOf('foo')).toBe(12_182);
    // A tagged pair hashes on the TAG ALONE, so two different keys sharing a
    // tag share a slot, and it is the slot of the bare tag.
    expect(slotOf('{user1000}.following')).toBe(slotOf('{user1000}.followers'));
    expect(slotOf('{user1000}.following')).toBe(slotOf('user1000'));
    // And the three exceptions: no tag, an unterminated tag, an empty tag.
    expect(hashTag('plain')).toBe('plain');
    expect(hashTag('a{bc')).toBe('a{bc');
    expect(hashTag('a{}b')).toBe('a{}b');
    expect(hashTag('a{t}b')).toBe('t');
  });

  it('TD24-SLOT-B: every key of the one EVAL shares a slot, and the tags are not one constant', async () => {
    const cases: readonly { readonly what: string; readonly key: string; readonly tenantId?: string }[] = [
      { what: 'the general allowance, which has no verified tenant by construction', key: 'POST-/v1/orders-203.0.113.9' },
      { what: 'an IPv6 client, whose address carries colons', key: 'GET-/v1/products-2001:db8::1' },
      { what: 'a verified tenant', key: 'k', tenantId: TENANT },
      // Caller text with braces of its own cannot break the pair. NOT because
      // the tag ends before that text — it does not; see TD24-SLOT-D — but
      // because whatever the tag turns out to be, both keys compute it from
      // the same characters.
      { what: 'caller text carrying a closing brace', key: 'POST-/v1/x-a}b' },
      { what: 'caller text carrying a whole brace pair', key: 'POST-/v1/x-{z}q' },
    ];

    const tags: string[] = [];
    for (const { what, key, tenantId } of cases) {
      const keys = await keysOfOneEval({ key, tenantId });
      const slots = keys.map(slotOf);
      // THE CLAIM: one command, one slot — the cluster's condition for not
      // refusing this `EVAL` with CROSSSLOT.
      expect(new Set(slots).size, `${what}: ${JSON.stringify(keys)} landed in slots ${JSON.stringify(slots)}`).toBe(1);
      // And the pair really is the counter and its flag, so this is the
      // command the store runs rather than some other pair of keys.
      const [counterKey = '', blockKey = ''] = keys;
      expect(blockKey).toBe(`${counterKey}:blocked`);
      expect(counterKey.startsWith(`${RATE_LIMIT_KEY_PREFIX}:{`)).toBe(true);
      const tag = hashTag(counterKey);
      // An empty tag would mean the whole key is hashed, which is the
      // untagged shape wearing braces.
      expect(tag.length).toBeGreaterThan(0);
      tags.push(tag);
    }

    // NOT ONE CONSTANT. A single fixed tag would also satisfy the cluster, by
    // putting every allowance in the system into one slot of 16384 — a
    // performance defect traded for a correctness one. Measured, not assumed.
    expect(new Set(tags).size).toBe(cases.length);
    expect(new Set(tags.map((t) => crc16(t) % SLOTS)).size).toBeGreaterThan(1);
  });

  it('TD24-SLOT-D: a `}` in the caller key truncates the tag — the pair still agrees, the spread is what pays', async () => {
    // The review of #77 found the comment in `rate-limit-store.ts` claiming the
    // tag "ends before" the caller's text. It does not: the tag runs from the
    // first `{` to the first `}` AFTER it, so a brace inside the caller's own
    // key cuts the tag at that point. This case pins both halves of what that
    // means, so the next reader does not have to trust a sentence.
    //
    // HALF ONE — correctness is untouched, because the truncation is identical
    // for the counter and its flag.
    const withBrace = await keysOfOneEval({ key: 'POST-/v1/x-}z' });
    expect(new Set(withBrace.map(slotOf)).size).toBe(1);

    // HALF TWO — and the tag really is cut: it carries no `}` and stops at the
    // brace rather than spanning the whole caller key.
    const [counterKey = ''] = withBrace;
    const tag = hashTag(counterKey);
    expect(tag).not.toContain('}');
    expect(tag.endsWith('POST-/v1/x-')).toBe(true);

    // HALF THREE — the price. Two DIFFERENT caller keys that agree up to their
    // first `}` collapse into one slot. That is a spread cost, not a CROSSSLOT
    // defect, and no caller reaches it today: the general allowance's key is a
    // `sha256` from `@nestjs/throttler`, which carries no brace.
    const a = await keysOfOneEval({ key: 'POST-/v1/x-}aaa' });
    const b = await keysOfOneEval({ key: 'POST-/v1/x-}bbb' });
    expect(hashTag(a[0] ?? '')).toBe(hashTag(b[0] ?? ''));
    expect(slotOf(a[0] ?? '')).toBe(slotOf(b[0] ?? ''));
    // While two keys that differ BEFORE any brace do not collapse — so the
    // assertion above is about the truncation and not about everything.
    const c = await keysOfOneEval({ key: 'POST-/v1/y-}aaa' });
    expect(hashTag(c[0] ?? '')).not.toBe(hashTag(a[0] ?? ''));
  });

  it('TD24-SLOT-C (negative control): the untagged shape this card removes does NOT share a slot', async () => {
    // The exact pair the store built before this card: prefix, scope, key,
    // and the same `:blocked` suffix — with no hash tag anywhere.
    const counterKey = `${RATE_LIMIT_KEY_PREFIX}:ip:default:POST-/v1/orders-203.0.113.9`;
    const blockKey = `${counterKey}:blocked`;
    expect(slotOf(counterKey)).not.toBe(slotOf(blockKey));

    // And the tagged pair for the SAME caller does share one, so the
    // difference is the tag and nothing else about these keys.
    const tagged = await keysOfOneEval({ key: 'POST-/v1/orders-203.0.113.9' });
    expect(new Set(tagged.map(slotOf)).size).toBe(1);
  });
});
