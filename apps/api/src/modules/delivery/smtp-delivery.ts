import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../../config';
import type { CredentialDelivery } from '../auth/tokens';
import { LogDelivery } from '../auth/tokens';

/**
 * Real SMTP credential delivery (Gate A §26). Production-capable: TLS via the
 * SMTP_URL scheme (smtps:// forces TLS; smtp:// uses STARTTLS opportunistically
 * with requireTLS below), connection/greeting/socket timeouts, SAFE errors —
 * a failure message never contains the token or the SMTP credentials.
 *
 * §15: TOKENS ARE NEVER LOGGED. The token appears only inside the message body
 * handed to the configured transport.
 */
export class SmtpDelivery implements CredentialDelivery {
  readonly kind = 'smtp';
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: AppConfig) {
    if (!config.SMTP_URL) throw new Error('SMTP_URL required for SmtpDelivery');
    if (!config.SMTP_FROM) throw new Error('SMTP_FROM required for SmtpDelivery');
    this.from = config.SMTP_FROM;
    const url = new URL(config.SMTP_URL);
    const secure = url.protocol === 'smtps:';
    this.transporter = nodemailer.createTransport({
      host: url.hostname,
      port: url.port ? Number(url.port) : secure ? 465 : 587,
      secure,
      requireTLS: !secure,
      ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  private async deliver(kind: 'password-reset' | 'invitation', email: string, token: string): Promise<void> {
    const subject = kind === 'password-reset' ? 'DAFTAR password reset' : 'DAFTAR invitation';
    const text =
      kind === 'password-reset'
        ? `Use this code to reset your DAFTAR password: ${token}\nIf you did not request this, ignore this message.`
        : `You have been invited to DAFTAR. Use this code to accept: ${token}`;
    try {
      await this.transporter.sendMail({ from: this.from, to: email, subject, text });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'smtp error';
      // Sanitize: strip anything resembling credentials/tokens from the error.
      throw new Error(`smtp delivery failed: ${msg.replaceAll(/[^\s]+:[^\s]+@/g, '***@').slice(0, 200)}`);
    }
  }

  sendPasswordReset(email: string, token: string): Promise<void> {
    return this.deliver('password-reset', email, token);
  }

  sendInvitation(email: string, token: string): Promise<void> {
    return this.deliver('invitation', email, token);
  }

  /** Readiness probe (§29): verify the SMTP connection + credentials. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * §27 provider factory: dev/test may use the log adapter; production is
 * SMTP-only (config validation enforces; the factory never silently falls back).
 */
export function createCredentialDelivery(config: AppConfig): CredentialDelivery {
  if (config.CREDENTIAL_DELIVERY_KIND === 'smtp') return new SmtpDelivery(config);
  if (config.isProd) throw new Error('CREDENTIAL_DELIVERY_KIND=log is forbidden in production');
  // Tests never write into the repository tree (artifact hygiene gate).
  if (config.isTest) return new LogDelivery('/tmp/daftar-dev-mailbox.log');
  return new LogDelivery(config.DEV_MAILBOX_FILE);
}
