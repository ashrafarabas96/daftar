/**
 * The merchant web's Content-Security-Policy (ADR-001), built per request.
 *
 * Next's App Router bootstraps every page with inline `<script>` tags, so a
 * bare `script-src 'self'` blocks them and the page never hydrates. The fix
 * Next supports is a per-request nonce: the middleware mints one, sends this
 * policy on the REQUEST (Next reads the nonce from it and stamps every script
 * it renders) and on the response (the browser enforces it). With
 * `'strict-dynamic'`, only a script carrying the nonce — and what that script
 * loads — runs; `'self'` stays for browsers without CSP 3.
 *
 * Never `'unsafe-inline'` for scripts. `'unsafe-eval'` only in development,
 * where React's refresh runtime needs it; the production build never has it.
 * Inline styles stay allowed (`style-src 'unsafe-inline'`): the design system
 * styles with the `style` attribute (ADR-001).
 */

/** A fresh nonce: 128 random bits, base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The page policy for one response, carrying that response's nonce. */
export function pageCsp(nonce: string, options: { production: boolean }): string {
  const script = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`, ...(options.production ? [] : [`'unsafe-eval'`])];
  return [
    `default-src 'self'`,
    `script-src ${script.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    ...(options.production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
