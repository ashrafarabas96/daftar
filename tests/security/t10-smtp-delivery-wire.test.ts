import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpDelivery } from '../../apps/api/src/modules/delivery/smtp-delivery';
import type { AppConfig } from '../../apps/api/src/config';

/**
 * T-10, `nodemailer` 10.0.10 → 10.1.4, on the wire.
 *
 * The companion file pins the transport options and the failure path without
 * a server. This one drives the real library over a real socket into an SMTP
 * server that lives inside the test process: no mail leaves the machine, no
 * container, no network. A stubbed transport would have told us about the
 * stub, which is worth nothing when the question is what a library upgrade
 * changed.
 *
 * TLS is off for the fixture only, through the constructor's test-only
 * override. It is not a configuration key, so there is no way to reach it
 * from a deployment — and the last case here pins that the production
 * factory never relaxes it.
 */

const FROM = 'DAFTAR <no-reply@daftar.test>';
const TOKEN = 'TOKEN-abcdef0123456789';

interface Captured {
  from: string;
  rcpt: string[];
  data: string;
}

interface Fixture {
  port: number;
  messages: Captured[];
  /** Connections the server has accepted — one send must not open two. */
  connections: number;
}

type Behaviour = Readonly<{ rejectRcpt?: boolean; failMailFrom?: boolean; stallAfterDot?: boolean }>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/**
 * Enough of RFC 5321 for nodemailer to complete a transaction, and no more.
 * It advertises AUTH PLAIN and SMTPUTF8 and does not advertise STARTTLS,
 * which is why the client must be told not to require it.
 */
async function smtpFixture(behaviour: Behaviour = {}): Promise<Fixture> {
  const fixture: Fixture = { port: 0, messages: [], connections: 0 };
  const server = createServer((socket: Socket) => {
    fixture.connections += 1;
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let rcpt: string[] = [];
    const say = (line: string): void => void socket.write(`${line}\r\n`);
    say('220 fixture ESMTP');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            fixture.messages.push({ from, rcpt: [...rcpt], data });
            data = '';
            from = '';
            rcpt = [];
            if (behaviour.stallAfterDot === true) return; // accepted the body, then says nothing
            say('250 2.0.0 Ok: queued');
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          say('250-fixture');
          say('250-AUTH PLAIN');
          say('250-8BITMIME');
          say('250 SMTPUTF8');
        } else if (upper.startsWith('AUTH')) {
          say('235 2.7.0 Accepted');
        } else if (upper.startsWith('MAIL FROM')) {
          from = line.slice(line.indexOf(':') + 1).trim();
          say(behaviour.failMailFrom === true ? '451 4.3.0 Temporary local problem' : '250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          const who = line.slice(line.indexOf(':') + 1).trim();
          if (behaviour.rejectRcpt === true) say('550 5.1.1 No such user');
          else {
            rcpt.push(who);
            say('250 2.1.5 Ok');
          }
        } else if (upper.startsWith('DATA')) {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper.startsWith('QUIT')) {
          say('221 2.0.0 Bye');
          socket.end();
        } else {
          say('250 2.0.0 Ok');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.port = (server.address() as AddressInfo).port;
  return fixture;
}

function deliveryFor(port: number): SmtpDelivery {
  return new SmtpDelivery({ SMTP_URL: `smtp://user:pw@127.0.0.1:${port}`, SMTP_FROM: FROM } as unknown as AppConfig, {
    requireTLS: false,
    secure: false,
  });
}

/** The body is base64 or quoted-printable depending on content; decode whichever the message declares. */
function decodedBody(raw: string): string {
  const headerEnd = raw.indexOf('\n\n');
  const headers = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 2);
  if (/content-transfer-encoding:\s*base64/i.test(headers)) return Buffer.from(body.replace(/\n/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return body;
}

describe('T-10 SMTP delivery on the wire, against an in-process server', () => {
  it('a password reset is delivered once, to one recipient, carrying the token', async () => {
    const f = await smtpFixture();
    await deliveryFor(f.port).sendPasswordReset('merchant@example.test', TOKEN);

    expect(f.messages).toHaveLength(1);
    const msg = f.messages[0];
    expect(msg?.rcpt).toEqual(['<merchant@example.test>']);
    expect(msg?.from).toContain('no-reply@daftar.test');
    expect(decodedBody(msg?.data ?? '')).toContain(TOKEN);
  });

  it('one call opens one connection and sends one message — no duplicate reaches the merchant', async () => {
    const f = await smtpFixture();
    const d = deliveryFor(f.port);
    await d.sendInvitation('merchant@example.test', TOKEN);

    expect(f.messages, 'exactly one message').toHaveLength(1);
    expect(f.connections, 'exactly one connection').toBe(1);
  });

  it('two calls are two messages, not one coalesced or three retried', async () => {
    const f = await smtpFixture();
    const d = deliveryFor(f.port);
    await d.sendPasswordReset('a@example.test', TOKEN);
    await d.sendInvitation('b@example.test', TOKEN);

    expect(f.messages).toHaveLength(2);
    expect(f.messages.map((m) => m.rcpt[0])).toEqual(['<a@example.test>', '<b@example.test>']);
  });

  it('the invitation and the reset are different messages, so a merchant cannot be told the wrong thing', async () => {
    const f = await smtpFixture();
    const d = deliveryFor(f.port);
    await d.sendPasswordReset('x@example.test', TOKEN);
    await d.sendInvitation('x@example.test', TOKEN);

    const [reset, invite] = f.messages;
    expect(decodedBody(reset?.data ?? '')).toMatch(/reset/i);
    expect(decodedBody(invite?.data ?? '')).toMatch(/invit/i);
    expect(reset?.data).not.toBe(invite?.data);
  });

  it('an internationalised recipient reaches the server in a form it can route', async () => {
    // The product's own subjects and bodies are ASCII, so this is the only
    // place Unicode actually enters the transaction: the address. What the
    // library does with it — punycode for the domain, SMTPUTF8 for the local
    // part — is exactly the kind of thing a minor release revisits, so it is
    // pinned rather than assumed.
    const f = await smtpFixture();
    await deliveryFor(f.port).sendPasswordReset('merchant@مثال.test', TOKEN);

    expect(f.messages).toHaveLength(1);
    const to = f.messages[0]?.rcpt[0] ?? '';
    expect(to, 'the recipient is not dropped or mangled into nothing').toContain('merchant@');
    // Either form is routable; which one it is must not change silently.
    expect(to === '<merchant@xn--mgbh0fb.test>' || to.includes('مثال.test'), `unexpected envelope recipient: ${to}`).toBe(true);
  });

  it('a refused recipient fails the call, and nothing is queued', async () => {
    const f = await smtpFixture({ rejectRcpt: true });
    await expect(deliveryFor(f.port).sendPasswordReset('nobody@example.test', TOKEN)).rejects.toThrow(/smtp delivery failed/);
    expect(f.messages, 'a rejected recipient must not leave a message behind').toHaveLength(0);
  });

  it('a transient 4xx is NOT retried — recorded as the behaviour in force, not endorsed', async () => {
    // `deliver()` calls `sendMail` once and turns any throw into a sanitised
    // error; there is no retry anywhere in this module. A caller that wants
    // one has to add it. This case exists so that if retries are ever
    // introduced, they are introduced deliberately and this assertion is
    // rewritten rather than quietly satisfied.
    const f = await smtpFixture({ failMailFrom: true });
    await expect(deliveryFor(f.port).sendInvitation('merchant@example.test', TOKEN)).rejects.toThrow(/smtp delivery failed/);
    expect(f.connections, 'one attempt, not two').toBe(1);
    expect(f.messages).toHaveLength(0);
  });

  it('a server that swallows the body and never acknowledges it is abandoned on the socket timeout', async () => {
    const f = await smtpFixture({ stallAfterDot: true });
    const started = Date.now();
    await expect(deliveryFor(f.port).sendPasswordReset('merchant@example.test', TOKEN)).rejects.toThrow(/smtp delivery failed/);
    const elapsed = Date.now() - started;
    // socketTimeout is 15s. The assertion is that one fired at all, inside a
    // request's lifetime — without it this call never returns.
    expect(elapsed).toBeLessThan(30_000);
  }, 40_000);

  it('healthCheck says true when the relay answers', async () => {
    const f = await smtpFixture();
    await expect(deliveryFor(f.port).healthCheck()).resolves.toBe(true);
  });

  it('the production path never relaxes TLS — the override is reachable from code, never from configuration', async () => {
    const { createCredentialDelivery } = await import('../../apps/api/src/modules/delivery/smtp-delivery');
    const made = createCredentialDelivery({
      CREDENTIAL_DELIVERY_KIND: 'smtp',
      SMTP_URL: 'smtp://user:pw@mail.example.test',
      SMTP_FROM: FROM,
      isProd: true,
      isTest: false,
    } as unknown as AppConfig);
    const options = (made as unknown as { transporter: { options: Record<string, unknown> } }).transporter.options;
    expect(options['requireTLS'], 'the factory must never pass the test-only override').toBe(true);
    expect(options['secure']).toBe(false);
  });
});
