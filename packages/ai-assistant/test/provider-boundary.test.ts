/**
 * P12 — provider boundary, audit minimization, retention.
 *
 * TL rulings §69, §70, §71, §72, §73. The claim under test is the corrected one: nothing the model,
 * the tenant's data, or the client says can create a destination — while the approved processor does
 * receive the minimized inference context, so the residual is bounded, not absent.
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVED_PROVIDERS,
  DEFAULT_RETENTION,
  evaluateRedirect,
  FORWARD_NOTHING,
  isApprovedHost,
  refuseRedirect,
  minimizeForAudit,
  resolveHost,
  retentionReadiness,
  selectProvider,
  type ProviderSpec,
  type SelectionSource,
} from '../src/provider-boundary';

const NON_SERVER_SOURCES: readonly SelectionSource[] = ['model_output', 'tenant_data', 'client_request'];

describe('no production provider is approved yet, and that is asserted rather than assumed', () => {
  it('every allowlist entry is the deterministic fake', () => {
    expect(APPROVED_PROVIDERS.every((p) => p.state === 'fake')).toBe(true);
  });

  it('no entry is reachable over anything but TLS', () => {
    for (const p of APPROVED_PROVIDERS) expect(p.scheme).toBe('https');
  });

  it('no entry carries a wildcard, path, or template in its host', () => {
    for (const p of APPROVED_PROVIDERS) expect(p.host).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe('the model cannot choose the provider (§70, §73)', () => {
  it.each(NON_SERVER_SOURCES)('refuses a selection sourced from %s, naming the source', (source) => {
    const decision = selectProvider('fake.deterministic', source, 'model');
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_provider.selection_not_server_controlled');
      expect(decision.refusal.field).toBe(source);
    }
  });

  it('refuses a model-sourced selection even when the id IS approved', () => {
    // The id being valid is irrelevant: the defect is that something other than server config chose.
    const decision = selectProvider('fake.deterministic', 'model_output', 'model');
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_provider.selection_not_server_controlled');
  });

  it('allows a server-configured selection of an allowlisted provider', () => {
    const decision = selectProvider('fake.deterministic', 'server_config', 'model');
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.host).toBe('fake.invalid');
  });

  it('refuses an unapproved id, and separately from the choose-attempt code', () => {
    const decision = selectProvider('evil.provider', 'server_config', 'model');
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_provider.not_approved');
      expect(decision.refusal.detail).toBe('evil.provider');
    }
  });

  it('refuses an approved id used for the wrong kind', () => {
    const decision = selectProvider('fake.stt.deterministic', 'server_config', 'model');
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_provider.not_approved');
  });

  it('refuses a non-TLS entry even if it is otherwise allowlisted', () => {
    const insecure = [{ id: 'x', kind: 'model', host: 'x.invalid', scheme: 'http', state: 'fake' }] as unknown as readonly ProviderSpec[];
    const decision = selectProvider('x', 'server_config', 'model', insecure);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_provider.insecure_transport');
  });
});

describe('host checking is exact, not a suffix test (§73: injection cannot change the host)', () => {
  it('accepts exactly an approved host', () => {
    expect(isApprovedHost('fake.invalid')).toBe(true);
  });

  it.each(['evil-fake.invalid', 'fake.invalid.evil.test', 'fake.invalid.', 'FAKE.INVALID', 'fake.invalid:8443', 'xfake.invalid', 'sub.fake.invalid'])(
    'refuses %s — a near-miss host is not an approved host',
    (host) => {
      expect(isApprovedHost(host)).toBe(false);
      const decision = resolveHost(host);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.refusal.code).toBe('ai_provider.host_not_approved');
        expect(decision.refusal.detail).toBe(host);
      }
    },
  );

  it('NON-VACUITY: a suffix test would have accepted two of those, so exactness is the law', () => {
    // Demonstrating the hazard the exact check closes. If `isApprovedHost` were `endsWith`, the first
    // two below would pass; they do not.
    expect('evil-fake.invalid'.endsWith('fake.invalid')).toBe(true);
    expect('sub.fake.invalid'.endsWith('fake.invalid')).toBe(true);
    expect(isApprovedHost('evil-fake.invalid')).toBe(false);
    expect(isApprovedHost('sub.fake.invalid')).toBe(false);
  });
});

describe('audit minimization (§71)', () => {
  it('keeps allowlisted fields and names what it dropped', () => {
    const result = minimizeForAudit(['customerId', 'limit'], { customerId: 'c1', limit: 10, fullCustomerRecord: { name: 'أحمد' } });
    expect(result.kept).toEqual({ customerId: 'c1', limit: 10 });
    expect(result.omittedKeys).toEqual(['fullCustomerRecord']);
  });

  it('drops a credential-shaped key EVEN WHEN the caller allowlisted it', () => {
    for (const key of ['apiKey', 'api_key', 'authToken', 'password', 'authorization', 'bearerToken', 'cookie', 'privateKey', 'clientSecret']) {
      const result = minimizeForAudit([key, 'customerId'], { [key]: 'xyz', customerId: 'c1' });
      expect(result.kept).toEqual({ customerId: 'c1' });
      expect(result.omittedKeys).toEqual([key]);
    }
  });

  it('records the omission rather than dropping silently — a complete-looking record that is not', () => {
    const result = minimizeForAudit([], { a: 1, b: 2 });
    expect(result.kept).toEqual({});
    expect(result.omittedKeys).toEqual(['a', 'b']);
  });

  it('keeps nothing by default: an empty allowlist keeps no field', () => {
    expect(minimizeForAudit([], { transcript: 'long sensitive text' }).kept).toEqual({});
  });
});

describe('retention (§72)', () => {
  it('audio is off by default', () => {
    expect(DEFAULT_RETENTION.keepAudio).toBe(false);
  });

  it('an unconfigured transcript period is NOT ready, and never means forever', () => {
    const readiness = retentionReadiness(DEFAULT_RETENTION);
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) expect(readiness.unconfigured).toEqual(['transcriptDays']);
  });

  it('names audioDays as unconfigured only when audio is kept', () => {
    const kept = retentionReadiness({ keepAudio: true, transcriptDays: 30 });
    expect(kept.ready).toBe(false);
    if (!kept.ready) expect(kept.unconfigured).toEqual(['audioDays']);
    expect(retentionReadiness({ keepAudio: false, transcriptDays: 30 }).ready).toBe(true);
  });

  it('is ready once the owner has configured a policy', () => {
    expect(retentionReadiness({ keepAudio: true, transcriptDays: 30, audioDays: 7 }).ready).toBe(true);
  });

  it('invents no jurisdiction-specific period', () => {
    expect(DEFAULT_RETENTION.transcriptDays).toBeUndefined();
    expect(DEFAULT_RETENTION.audioDays).toBeUndefined();
  });
});

describe('provider redirects are REFUSED (PART 75)', () => {
  const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

  it.each(REDIRECT_STATUSES)('refuses a %i from an approved host by default', (status) => {
    const decision = evaluateRedirect({ fromHost: 'fake.invalid', status, locationHost: 'evil.test' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_provider.redirect_refused');
  });

  it('refuses WITHOUT being asked to — the permissive path is not the default', () => {
    // The hazard PART 75 names: most HTTP clients follow redirects unless told not to, which turns an
    // exact-host allowlist into an allowlist on the first hop only. Here the omitted option refuses.
    const decision = evaluateRedirect({ fromHost: 'fake.invalid', status: 302, locationHost: 'fake.invalid' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_provider.redirect_refused');
  });

  it('refuses a redirect to an APPROVED host too, when redirects are not permitted', () => {
    // The refusal is about redirecting, not about the destination. An approved destination does not
    // make the hop acceptable.
    expect(evaluateRedirect({ fromHost: 'fake.invalid', status: 307, locationHost: 'fake.invalid' }).ok).toBe(false);
  });

  it('names both hosts and the status, so infrastructure movement is distinguishable from an attempt', () => {
    const decision = refuseRedirect({ fromHost: 'fake.invalid', status: 302, locationHost: 'evil.test' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.field).toBe('fake.invalid');
      expect(decision.refusal.detail).toBe('302 -> evil.test');
    }
  });

  it('REVALIDATES the destination against the exact allowlist even on the permitted path', () => {
    const decision = evaluateRedirect({ fromHost: 'fake.invalid', status: 307, locationHost: 'evil.test' }, { allowRedirects: true });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_provider.redirect_refused');
  });

  it.each(['sub.fake.invalid', 'evil-fake.invalid', 'fake.invalid.evil.test', 'FAKE.INVALID'])(
    'refuses the near-miss destination %s on the permitted path — revalidation is exact',
    (locationHost) => {
      const decision = evaluateRedirect({ fromHost: 'fake.invalid', status: 308, locationHost }, { allowRedirects: true });
      expect(decision.ok).toBe(false);
    },
  );

  it('forwards NOTHING even when the destination revalidates', () => {
    // PART 75: no authorization header or token reaches a redirected origin. The permitted path
    // returns a forwarding decision, not a destination to call, and that decision carries nothing.
    const decision = evaluateRedirect({ fromHost: 'fake.invalid', status: 307, locationHost: 'fake.invalid' }, { allowRedirects: true });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.authorization).toBe(false);
      expect(decision.value.body).toBe(false);
      expect(decision.value).toEqual(FORWARD_NOTHING);
    }
  });

  it('FORWARD_NOTHING carries no true field — the constant cannot be the source of a credential leak', () => {
    expect(Object.values(FORWARD_NOTHING).some((v) => v === true)).toBe(false);
  });

  it('NON-VACUITY: revalidation uses the allowlist it is given, not a hard-coded host', () => {
    const other: readonly ProviderSpec[] = [{ id: 'o', kind: 'model', host: 'other.invalid', scheme: 'https', state: 'fake' }];
    const toOther = evaluateRedirect({ fromHost: 'fake.invalid', status: 307, locationHost: 'other.invalid' }, { allowRedirects: true, allowlist: other });
    expect(toOther.ok).toBe(true);
    // And the default-allowlist host is NOT approved under that list, so the check really consulted it.
    const toDefault = evaluateRedirect({ fromHost: 'other.invalid', status: 307, locationHost: 'fake.invalid' }, { allowRedirects: true, allowlist: other });
    expect(toDefault.ok).toBe(false);
  });
});
