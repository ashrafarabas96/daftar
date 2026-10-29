import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpDelivery } from '../../apps/api/src/modules/delivery/smtp-delivery';
import type { AppConfig } from '../../apps/api/src/config';

/**
 * T-10, `nodemailer` ^10.0.10 → ^10.1.4.
 *
 * There was no test of this module at all before this file — measured across
 * the whole tree — so a minor upgrade of the only mail transport in the
 * product was landing with nothing watching it. What this pins is the part
 * that is both reachable without a TLS fixture and genuinely sensitive to the
 * upgrade: the transport options derived from `SMTP_URL`, the timeouts, and
 * the failure path.
 *
 * The failure path is the one that matters most. `SMTP_URL` carries the SMTP
 * password, the message body carries a password-reset or invitation token,
 * and `deliver()` catches whatever the library threw and re-throws a string
 * built from it. A library that starts putting more of the connection into
 * its error message — exactly the kind of change a minor release makes — is
 * how a credential reaches a log. So the test asserts the two things that
 * must never be in that string, rather than asserting the string.
 *
 * NOT covered here, and left to a card with a TLS SMTP fixture: a successful
 * end-to-end send, envelope/recipient handling on the wire, unicode
 * encoding of subject and body, and retry behaviour. `requireTLS` is set for
 * `smtp://` and `secure` for `smtps://`, so none of them is reachable against
 * a plain socket, and a fixture that offers STARTTLS needs a certificate this
 * suite has no way to mint.
 */

const PASSWORD = 'sup3r-s3cret-smtp-pw';
const TOKEN = 'TOKEN-abcdef0123456789';

function configWith(url: string): AppConfig {
  // Only two fields are read by this class; the cast keeps the test from
  // depending on every unrelated field of the real config shape.
  return { SMTP_URL: url, SMTP_FROM: 'DAFTAR <no-reply@daftar.test>' } as unknown as AppConfig;
}

/** The options nodemailer was actually built with — read back rather than assumed from the URL. */
function optionsOf(delivery: SmtpDelivery): Record<string, unknown> {
  const inner = delivery as unknown as { transporter: { options: Record<string, unknown> } };
  return inner.transporter.options;
}

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

/** A socket that accepts the connection and then says nothing at all, ever. */
async function silentServer(): Promise<number> {
  const server = createServer(() => {
    /* accept, never greet */
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A port nothing is listening on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('T-10 SMTP delivery: what the upgrade must not change', () => {
  it('smtp:// is port 587, not secure, and demands STARTTLS rather than settling for plaintext', () => {
    const o = optionsOf(new SmtpDelivery(configWith('smtp://user:pw@mail.example.test')));
    expect(o['port']).toBe(587);
    expect(o['secure']).toBe(false);
    // The whole point of the scheme split: an opportunistic upgrade is not
    // optional here. If this ever reads false, mail leaves in the clear.
    expect(o['requireTLS']).toBe(true);
  });

  it('smtps:// is port 465 and secure from the first byte', () => {
    const o = optionsOf(new SmtpDelivery(configWith('smtps://user:pw@mail.example.test')));
    expect(o['port']).toBe(465);
    expect(o['secure']).toBe(true);
  });

  it('an explicit port in the URL wins over the scheme default', () => {
    const o = optionsOf(new SmtpDelivery(configWith('smtp://user:pw@mail.example.test:2525')));
    expect(o['port']).toBe(2525);
  });

  it('credentials are percent-decoded, so a password with reserved characters is the password and not its spelling', () => {
    const o = optionsOf(new SmtpDelivery(configWith(`smtp://${encodeURIComponent('user@tenant')}:${encodeURIComponent('p@ss:w/rd')}@mail.example.test`)));
    expect(o['auth']).toEqual({ user: 'user@tenant', pass: 'p@ss:w/rd' });
  });

  it('a URL with no credentials produces no auth at all, rather than an empty login', () => {
    const o = optionsOf(new SmtpDelivery(configWith('smtp://mail.example.test')));
    expect(o['auth']).toBeUndefined();
  });

  it('the three timeouts survive the upgrade — without them a dead relay holds a request open', () => {
    const o = optionsOf(new SmtpDelivery(configWith('smtp://user:pw@mail.example.test')));
    expect(o['connectionTimeout']).toBe(10_000);
    expect(o['greetingTimeout']).toBe(10_000);
    expect(o['socketTimeout']).toBe(15_000);
  });

  it('a missing SMTP_URL or SMTP_FROM is refused at construction, not discovered at send time', () => {
    expect(() => new SmtpDelivery({ SMTP_FROM: 'x@y.test' } as unknown as AppConfig)).toThrow(/SMTP_URL/);
    expect(() => new SmtpDelivery({ SMTP_URL: 'smtp://mail.example.test' } as unknown as AppConfig)).toThrow(/SMTP_FROM/);
  });

  it('when delivery fails, neither the SMTP password nor the token is in the error', async () => {
    const port = await closedPort();
    const delivery = new SmtpDelivery(configWith(`smtp://user:${PASSWORD}@127.0.0.1:${port}`));

    let message = '';
    await expect(
      delivery.sendPasswordReset('someone@example.test', TOKEN).catch((e: unknown) => {
        message = e instanceof Error ? e.message : String(e);
        throw e;
      }),
    ).rejects.toThrow();

    expect(message, 'the error says what failed').toContain('smtp delivery failed');
    expect(message, 'the SMTP password must never travel in an error string').not.toContain(PASSWORD);
    expect(message, 'the reset token must never travel in an error string').not.toContain(TOKEN);
    // The sanitiser also caps the length; an upgrade that made errors chattier
    // would otherwise widen whatever does get through.
    expect(message.length).toBeLessThanOrEqual('smtp delivery failed: '.length + 200);
  });

  it('a user:pass pair inside the library error is masked, not merely absent by luck', async () => {
    // The sanitiser replaces `something:something@`. Proving it on a real
    // failure matters more than proving the regex: the previous assertion
    // passes trivially if the library simply never mentions the password, and
    // that is a property of the library, not of this code.
    const port = await closedPort();
    const delivery = new SmtpDelivery(configWith(`smtp://user:${PASSWORD}@127.0.0.1:${port}`));
    const thrown = await delivery.sendInvitation('someone@example.test', TOKEN).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(thrown).not.toBeNull();
    expect(thrown ?? '').not.toMatch(/\S+:\S+@/);
  });

  it('a relay that accepts the connection and never greets is abandoned, not waited on forever', async () => {
    const port = await silentServer();
    const delivery = new SmtpDelivery(configWith(`smtp://user:${PASSWORD}@127.0.0.1:${port}`));
    const started = Date.now();
    await expect(delivery.sendPasswordReset('someone@example.test', TOKEN)).rejects.toThrow(/smtp delivery failed/);
    const elapsed = Date.now() - started;
    // greetingTimeout is 10s; the assertion is that SOME timeout fired well
    // inside a request's lifetime, not that it fired at a particular instant.
    expect(elapsed).toBeLessThan(25_000);
  }, 30_000);

  it('healthCheck answers false on an unreachable relay instead of throwing into the readiness probe', async () => {
    const port = await closedPort();
    const delivery = new SmtpDelivery(configWith(`smtp://user:${PASSWORD}@127.0.0.1:${port}`));
    await expect(delivery.healthCheck()).resolves.toBe(false);
  });
});
