/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production';

// Every page's CSP is set per request by src/middleware.ts, with a fresh
// script nonce (src/lib/csp.ts): Next's inline bootstrap scripts carry it, and
// nothing else inline runs. The BFF routes and Next's own assets, which the
// middleware does not see, keep this static self-only policy.
const staticCsp = {
  key: 'Content-Security-Policy',
  value: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'${isProd ? '; upgrade-insecure-requests' : ''}`,
};

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig = {
  transpilePackages: ['@daftar/design-system'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', headers: [staticCsp] },
      { source: '/_next/:path*', headers: [staticCsp] },
    ];
  },
};

export default nextConfig;
