import type { Request } from 'express';
import type { AppConfig } from '../config';

/**
 * §XXXIX: trusted-proxy-aware client IP resolution.
 *
 * TRUSTED_PROXIES is a comma-separated list of exact IPs (v4/v6) and/or IPv4
 * CIDR ranges — the KNOWN proxies of the deployment. Resolution walks the
 * X-Forwarded-For chain from RIGHT to LEFT (most recent hop first), skipping
 * trusted proxies; the first UNTRUSTED address is the real client. If the
 * immediate socket peer is not trusted, XFF is ignored entirely (a direct
 * client can never spoof).
 *
 * Legacy: TRUST_PROXY=true (no list configured) trusts the first XFF entry —
 * accepted only for simple single-LB deployments; TRUSTED_PROXIES is the
 * serious-production knob.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function isTrustedProxy(ip: string, trusted: string[]): boolean {
  const norm = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  for (const entry of trusted) {
    const e = entry.trim();
    if (!e) continue;
    if (e === norm || e === ip) return true;
    const slash = e.indexOf('/');
    if (slash > 0) {
      const base = ipv4ToInt(e.slice(0, slash));
      const mask = Number(e.slice(slash + 1));
      const target = ipv4ToInt(norm);
      if (base !== null && target !== null && mask >= 0 && mask <= 32) {
        const shift = 32 - mask;
        if ((base >>> shift) === (target >>> shift)) return true;
      }
    }
  }
  return false;
}

export function clientIp(req: Request, config: Pick<AppConfig, 'TRUST_PROXY' | 'TRUSTED_PROXIES'>): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const trustedList = (config.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const xffRaw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(xffRaw) ? xffRaw.join(',') : xffRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 45); // malformed entries dropped

  if (trustedList.length > 0) {
    if (!isTrustedProxy(remote, trustedList)) return remote; // direct client — XFF ignored
    // Walk right→left: remote (trusted) → XFF tail → ... → first untrusted.
    for (let i = chain.length - 1; i >= 0; i--) {
      const hop = chain[i] as string;
      if (!isTrustedProxy(hop, trustedList)) return hop;
    }
    return chain[0] ?? remote; // entire chain trusted (e.g. internal) — leftmost
  }
  if (config.TRUST_PROXY === 'true') {
    return chain[0] ?? remote; // legacy single-proxy mode
  }
  return remote;
}
