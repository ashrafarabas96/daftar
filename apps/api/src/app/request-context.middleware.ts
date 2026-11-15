import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getContext, runWithContext } from '../infra/request-context';
import type { AppConfig } from '../config';

/**
 * REL-09: the content policy this API answers with.
 *
 * This surface returns JSON. It executes no script, loads no stylesheet,
 * embeds no frame and submits no form, so the strictest policy that exists is
 * also the correct one — there is nothing here for a looser directive to
 * permit. `frame-ancestors 'none'` is the one directive `X-Frame-Options:
 * DENY` (already set below) does not fully cover in modern browsers, and
 * `base-uri`/`form-action` close the two injection sinks that survive
 * `default-src` on a response a browser does render (an error page, a
 * mis-typed `Content-Type`).
 *
 * DR-46 forbids WEAKENING the CSP that the web surfaces enforce. This constant
 * neither touches nor loosens that policy: it is a new header on a different
 * surface, and it is strictly more restrictive than anything it could replace.
 */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * REL-09: the transport policy, emitted in PRODUCTION ONLY.
 *
 * HSTS is a per-HOST instruction a browser remembers for `max-age` seconds.
 * Emitted from a development or test box it pins `localhost` — every port, and
 * so every other project on that machine — to https, and the damage is
 * discovered weeks later by someone who never ran this code. Production is
 * where TLS terminates and the only place the header means anything, so that
 * is the only place it is set.
 *
 * `preload` is deliberately absent: submitting a host to the browsers' preload
 * list cannot be undone on this project's own timetable, and that is an
 * owner's decision about a domain, not a middleware default.
 *
 * `includeSubDomains` is the same KIND of decision about a domain — it binds
 * every subdomain of whatever Host arrives, and this repository holds no
 * deployment definition that fixes which Host that is (REL-09 review, finding
 * 2, which was right to say the earlier comment was silent about it). It is
 * set, and `preload` is not, for one difference that is not cosmetic:
 * `includeSubDomains` is WITHDRAWABLE on this project's own timetable — ship
 * `max-age=0` and every browser forgets it as it comes back — while a preload
 * submission is a list someone else ships. A subdomain served over plain http
 * is therefore a deployment choice this header makes visible and reversible,
 * not a lock.
 *
 * This does NOT claim to be the whole of HSTS for the deployment. Where TLS is
 * terminated by a load balancer, that balancer is the natural place for this
 * header and may already set it; a duplicate identical value is harmless, and
 * an app-level header is what protects the case where it does not. There is no
 * deployment infrastructure in this repository (`infra`/`deploy`/`terraform`/
 * `charts` do not exist), so nothing here can assert what the balancer sends.
 */
export const API_STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

/**
 * Request context middleware (§99): every request runs inside an ALS context
 * with a request id; response carries X-Request-Id; standard security headers.
 *
 * REL-09 review, finding 1 — the exact reach, since "on every response" is
 * wider than the mechanism. These headers are set on every response that
 * REACHES ROUTING. Two kinds of response do not: a CORS preflight that
 * `app.enableCors` answers (it is registered on the express instance in
 * `main.ts` before `app.init()` installs module middleware), and a 400 that
 * the built-in body parser produces for malformed JSON. Both predate this
 * change and neither is introduced by it — it is recorded here because the
 * earlier wording read as a guarantee, and a wrong guarantee is worse than a
 * narrow one.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject('APP_CONFIG') private readonly config: AppConfig) {}

  use(req: Request, res: Response, next: NextFunction): void {
    runWithContext(() => {
      const ctx = getContext();
      if (ctx) res.setHeader('X-Request-Id', ctx.requestId);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
      if (this.config.isProd) res.setHeader('Strict-Transport-Security', API_STRICT_TRANSPORT_SECURITY);
      next();
    });
  }
}
