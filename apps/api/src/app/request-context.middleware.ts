import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getContext, runWithContext } from '../infra/request-context';

/**
 * Request context middleware (§99): every request runs inside an ALS context
 * with a request id; response carries X-Request-Id; standard security headers.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    runWithContext(() => {
      const ctx = getContext();
      if (ctx) res.setHeader('X-Request-Id', ctx.requestId);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
  }
}
