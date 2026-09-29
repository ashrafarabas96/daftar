import { isIPv4, isIPv6 } from 'node:net';
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
 * Legacy: TRUST_PROXY=true (no list configured) — dev/test only; production
 * refuses it at startup (config.ts, TD-19 review M-1). It means "exactly one
 * proxy in front, whatever the socket peer is": the client is the RIGHTMOST
 * XFF entry, the one that proxy appended. Entries to its left are the
 * caller's own writing and are never an identity (the leftmost entry once
 * was, and a caller rotating it had an unlimited allowance of every
 * per-client limit).
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
        if (base >>> shift === target >>> shift) return true;
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
  const chain = (Array.isArray(xffRaw) ? xffRaw.join(',') : (xffRaw ?? ''))
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
    return chain[chain.length - 1] ?? remote; // legacy single-proxy mode: the hop that proxy appended
  }
  return remote;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip.toLowerCase();
  // An embedded IPv4 tail (`::ffff:a.b.c.d`, `64:ff9b::a.b.c.d`) is its two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (dotted !== undefined) {
    const v4 = ipv4ToInt(dotted);
    if (v4 === null) return null;
    text = `${text.slice(0, -dotted.length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const hex = (part: string): number[] => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  const [head = '', rest] = text.split('::');
  const left = hex(head);
  const right = rest === undefined ? [] : hex(rest);
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (rest === undefined && fill !== 0)) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * The key the per-client limits count a client address under (TD-19 review
 * L-3): an IPv4 address as itself; an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) as that IPv4 address; any other IPv6 address as its /64,
 * because one subscriber is routinely delegated a whole /64 and could
 * otherwise take a fresh allowance per address. Anything else (`unknown`) is
 * its own key.
 */
export function limiterKey(ip: string): string {
  const bare = ip.trim().replace(/%.*$/, '');
  if (isIPv4(bare)) return bare;
  const groups = ipv6Groups(bare);
  if (groups === null) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** The limiter key of the client `clientIp()` resolves. */
export function clientLimiterKey(req: Request, config: Pick<AppConfig, 'TRUST_PROXY' | 'TRUSTED_PROXIES'>): string {
  return limiterKey(clientIp(req, config));
}
