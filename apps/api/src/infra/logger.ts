import { pino, type Logger } from 'pino';

/** Structured logger (§99–100). Secrets/tokens/passwords are redacted by path. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.password_hash',
        '*token*',
        '*Token*',
        '*.refreshToken',
        '*.accessToken',
        '*secret*',
        '*Secret*',
      ],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
