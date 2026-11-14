import { describe, expect, it } from 'vitest';
import { PRE_AUTH_SCOPE, RATE_LIMIT_KEY_PREFIX, rateLimitKey, rateLimitScopeSegment, type RateLimitScope } from '../apps/api/src/infra/rate-limit-store';

/**
 * TD-24 — THE KEY NAMESPACE IS A VERSION, AND NOTHING HELD ITS VALUE.
 *
 * `apps/api/src/infra/rate-limit-store.ts` became L4's with the merge of #46
 * and #77 (2026-11-13T05:14:56Z), so DR-145 applies to it: every guard over it
 * is proved by PLANTING, not by reading. Four seeds were planted into the
 * production file, one at a time, each a missing refusal, with the tree proved
 * green first and restored byte for byte after:
 *
 *   T  the hash tag `{…}` removed from `rateLimitKey`  -> RED (2 files, 4 cases)
 *   U  a malformed tenant id accepted                  -> RED (1 case)
 *   V  a non-finite script answer trusted              -> RED (1 case)
 *   W  `RATE_LIMIT_KEY_PREFIX` moved `rl:thr:v1` -> `rl:thr:v2`
 *                                                      -> GREEN. Nothing saw it.
 *
 * W is this file's reason, and it is the other face of a correction I had
 * already made to myself: the existing laws IMPORT the constant and never
 * spell `rl:thr:v1`, which is right for a claim about the key's SHAPE — and is
 * exactly what makes them blind to its VALUE. An importer follows the constant
 * wherever it goes.
 *
 * The damage is not stylistic. The key namespace is a compatibility contract
 * between replicas across a deploy: every counter and every live block lives
 * under this prefix. Move it and, in one instant, every allowance resets and
 * every blocked client is unblocked, while half the replicas count in the old
 * namespace and half in the new. During the pilot that is an entry door, not a
 * configuration detail.
 *
 * So this law pins the VALUE, and says in its own text who may move it:
 *
 *   WHO MOVES THIS EXPECTATION, AND WHEN. `KEY_NAMESPACE` below is not a
 *   preference. It changes in the SAME commit that changes
 *   `RATE_LIMIT_KEY_PREFIX` in the store, and only for a deliberate namespace
 *   break — one that is allowed to drop every live counter and every live
 *   block. The owner of `rate-limit-store.ts` (L4) makes that change; it is
 *   not a merge artefact, and a lane that finds this case red without having
 *   decided a namespace break has found a defect, not a stale number.
 *
 * Boundary, because a law needs both faces (DR-145): seed W reddens this file,
 * and a change to the SCOPE SEGMENT (`ip`, `t:<uuid>`) must NOT — that is a
 * different claim, owned by the hash-tag and tenant-id laws. KEY-NS-C below is
 * written so that it reads the segment through the production helper and
 * therefore cannot be the thing that reddens here.
 */

/** The namespace this store is deployed with. See WHO MOVES THIS EXPECTATION above. */
const KEY_NAMESPACE = 'rl:thr:v1';

describe('TD-24: the rate-limit key namespace carries a pinned version', () => {
  it('KEY-NS-A: the prefix is exactly the deployed namespace, so moving it cannot pass unseen', () => {
    // The one case in the repository that spells the value. Seed W (v1 -> v2)
    // reddens here and nowhere else.
    expect(RATE_LIMIT_KEY_PREFIX).toBe(KEY_NAMESPACE);
  });

  it('KEY-NS-B: the namespace ends in a version segment, so a break is declared and not drifted into', () => {
    const segments = RATE_LIMIT_KEY_PREFIX.split(':');
    const version = segments[segments.length - 1] ?? '';
    expect(version).toMatch(/^v[1-9][0-9]*$/);
    // And the version is the LAST segment before the hash tag opens, so a new
    // namespace cannot be smuggled in as a suffix after it.
    //
    // Asserted as a LITERAL prefix, not as a pattern: the first draft built a
    // `RegExp` from the namespace through a hand-rolled escaper, and the escaper
    // was inert -- measured, not supposed: `escape('a.b') === 'a.b'`, and on a
    // value carrying `+` the assertion went false rather than loose. A claim that
    // needs no pattern should carry none. (Review of #106, finding 1.)
    expect(rateLimitKey(PRE_AUTH_SCOPE, 'x').startsWith(`${KEY_NAMESPACE}:{`)).toBe(true);
  });

  it('KEY-NS-C: the boundary — the scope segment is read through the store, so a segment change does not redden this law', () => {
    const tenant: RateLimitScope = { kind: 'tenant', tenantId: '00000000-0000-4000-8000-000000000000' };
    for (const scope of [PRE_AUTH_SCOPE, tenant]) {
      // No segment literal here on purpose: this case holds the namespace, and
      // the segment's own shape belongs to the tenant-id and hash-tag laws.
      expect(rateLimitKey(scope, 'login')).toBe(`${KEY_NAMESPACE}:{${rateLimitScopeSegment(scope)}:login}`);
    }
  });
});
