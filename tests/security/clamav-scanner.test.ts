import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvMalwareScanner, createMalwareScanner, DisabledDevelopmentMalwareScanner } from '../../apps/api/src/infra/storage';
import { loadConfig } from '../../apps/api/src/config';

/**
 * The REAL clamd adapter, driven against peers that speak the INSTREAM wire
 * protocol to varying degrees of honesty.
 *
 * Two independent checks have to hold before a file is called clean, and these
 * cases exist to prove that each one refuses on its own:
 *   - the peer must answer `zPING` with exactly `PONG\0`, so a listener that
 *     was never clamd can never have its answer read as a verdict at all.
 *     This is a misconfiguration detector, not authentication: anyone who
 *     controls the address can answer `PONG\0`, and the cases below measure
 *     only what it does catch;
 *   - the INSTREAM reply must equal clamd's own `stream: OK\0` byte for byte.
 * Both were verified against real clamd 1.5.4 before these stand-ins were
 * written: `PONG\0`, `stream: OK\0`, `stream: <sig> FOUND\0`.
 */
describe('ClamAvMalwareScanner (clamd INSTREAM)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  /**
   * A clamd stand-in. `pong` is what it answers to `zPING`, `reply` what it
   * answers once the INSTREAM terminator arrives (null = never answer), and
   * both are written as RAW bytes so a case can omit the terminator or add
   * bytes after it.
   */
  async function fakePeer(options: { reply: Buffer | null; pong?: Buffer | null }): Promise<number> {
    const pong = options.pong === undefined ? Buffer.from('PONG\0', 'utf8') : options.pong;
    const server = createServer((socket: Socket) => {
      let sawTerminator = false;
      let isPing = false;
      socket.on('data', (buf: Buffer) => {
        if (buf.subarray(0, 6).toString('utf8') === 'zPING\0') isPing = true;
        if (isPing) {
          if (pong) socket.write(pong);
          socket.end();
          return;
        }
        // The INSTREAM terminator is a zero-length chunk header.
        if (buf.length >= 4 && buf.readUInt32BE(buf.length - 4) === 0) sawTerminator = true;
        if (sawTerminator && options.reply !== null) {
          socket.write(options.reply);
          socket.end();
        }
      });
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return addr.port;
  }

  /** One TCP connection as the peer saw it: every byte that arrived on it. */
  interface PeerConnection {
    received: Buffer;
  }

  const PING_COMMAND = Buffer.from('zPING\0', 'utf8');

  /**
   * The same stand-in, but it records what actually reached it, one entry per
   * TCP connection in the order they were opened, and it reads `pong` and
   * `reply` fresh on every connection so a case can flip the peer between two
   * scans. The recording is what makes two properties testable that the
   * refusal reason alone cannot show: that the handshake is repeated per scan
   * rather than cached, and that when it fails no file byte is ever written.
   */
  async function observedPeer(options: { reply: () => Buffer | null; pong: () => Buffer | null }): Promise<{ port: number; connections: PeerConnection[] }> {
    const connections: PeerConnection[] = [];
    const server = createServer((socket: Socket) => {
      const entry: PeerConnection = { received: Buffer.alloc(0) };
      connections.push(entry);
      let sawTerminator = false;
      let isPing = false;
      socket.on('data', (buf: Buffer) => {
        entry.received = Buffer.concat([entry.received, buf]);
        if (buf.subarray(0, PING_COMMAND.length).equals(PING_COMMAND)) isPing = true;
        if (isPing) {
          // Read only when a PING actually arrives, so a case counting its
          // answers counts handshakes and nothing else.
          const pong = options.pong();
          if (pong) socket.write(pong);
          socket.end();
          return;
        }
        if (buf.length >= 4 && buf.readUInt32BE(buf.length - 4) === 0) sawTerminator = true;
        if (sawTerminator) {
          const reply = options.reply();
          if (reply !== null) {
            socket.write(reply);
            socket.end();
          }
        }
      });
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return { port: addr.port, connections };
  }

  /** Connections that carried nothing but the PING command, in order. */
  const handshakes = (connections: PeerConnection[]): PeerConnection[] => connections.filter((c) => c.received.equals(PING_COMMAND));

  const scannerFor = (port: number, timeoutMs = 3000): ClamAvMalwareScanner =>
    new ClamAvMalwareScanner(
      loadConfig({
        NODE_ENV: 'test',
        APP_DATABASE_URL: 'postgresql://unused:unused@localhost/daftar',
        JWT_SECRET: 'test-secret-key-with-at-least-32-characters!',
        MALWARE_SCANNER: 'clamav',
        MALWARE_SCANNER_URL: `clamav://127.0.0.1:${port}`,
        MALWARE_SCAN_TIMEOUT_MS: String(timeoutMs),
      }),
    );

  const bytes = Buffer.alloc(4096, 0x41);
  const scanWith = async (options: { reply: Buffer | null; pong?: Buffer | null }, timeoutMs = 3000) =>
    scannerFor(await fakePeer(options), timeoutMs).scan({ bytes, filename: 'a.png' });
  const raw = (text: string): Buffer => Buffer.from(text, 'utf8');

  describe('the clean reply is matched byte for byte', () => {
    it("clamd's own `stream: OK\\0` → clean", async () => {
      const v = await scanWith({ reply: raw('stream: OK\0') });
      expect(v.outcome).toBe('clean');
    });

    // The round-2 defect: the parser accepted any colon-free prefix, so a
    // mis-pointed peer echoing something similar marked every file clean.
    it.each([
      ['a longer word: `stream: OKAY`', 'stream: OKAY\0'],
      ['a prefixed name: `xstream: OK`', 'xstream: OK\0'],
      ['a foreign label: `scanner: OK`', 'scanner: OK\0'],
      ['no label at all: `OK`', 'OK\0'],
      ['an HTTP banner', 'HTTP/1.1 200 OK\r\n\r\n'],
      ['leading whitespace', '  stream: OK\0'],
      ['no terminator', 'stream: OK'],
      ['trailing bytes after the terminator', 'stream: OK\0extra'],
      ['a second reply appended', 'stream: OK\0stream: OK\0'],
      ['the clean words inside a longer line', 'stream: OK and also something else\0'],
      ['an uppercase spelling', 'STREAM: OK\0'],
      ['a tab instead of a space', 'stream:\tOK\0'],
    ])('%s → unavailable, never clean', async (_label, text) => {
      const v = await scanWith({ reply: raw(text) });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toMatch(/scan_reply_not_clamd_format/);
    });

    it('an empty reply → unavailable, named as empty', async () => {
      const v = await scanWith({ reply: Buffer.alloc(0) });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toBe('scan_reply_empty');
    });

    it('a clamd ERROR reply → unavailable', async () => {
      const v = await scanWith({ reply: raw('INSTREAM size limit exceeded. ERROR\0') });
      expect(v.outcome).toBe('unavailable');
    });
  });

  describe('the infected reply', () => {
    it('`stream: <sig> FOUND\\0` → infected, carrying the signature name', async () => {
      const v = await scanWith({ reply: raw('stream: Eicar-Signature FOUND\0') });
      expect(v.outcome).toBe('infected');
      expect(v.outcome === 'infected' && v.signature).toBe('Eicar-Signature');
    });

    it('the real clamd spelling with the UNOFFICIAL suffix → infected', async () => {
      const v = await scanWith({ reply: raw('stream: Daftar.Test.Signature.UNOFFICIAL FOUND\0') });
      expect(v.outcome).toBe('infected');
      expect(v.outcome === 'infected' && v.signature).toBe('Daftar.Test.Signature.UNOFFICIAL');
    });

    it.each([
      ['an empty signature', 'stream:  FOUND\0'],
      ['a prefixed label', 'xstream: Sig FOUND\0'],
      ['no terminator', 'stream: Sig FOUND'],
    ])('%s is NOT read as infected and NOT read as clean', async (_label, text) => {
      const v = await scanWith({ reply: raw(text) });
      expect(v.outcome).toBe('unavailable');
    });
  });

  describe('a listener that does not behave like clamd is refused before anything is scanned', () => {
    it('a peer that never answers `zPING` → refused by name', async () => {
      const v = await scanWith({ reply: raw('stream: OK\0'), pong: null }, 600);
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toMatch(/clamd_timeout|peer_is_not_clamd/);
    });

    it.each([
      ['an HTTP server', 'HTTP/1.1 200 OK\r\n\r\n'],
      ['a near-miss: `PONG` with no terminator', 'PONG'],
      ['a near-miss: `PONGPONG`', 'PONGPONG\0'],
      ['an echo server repeating the command', 'zPING\0'],
      ['an SMTP banner', '220 mail.example.com ESMTP\r\n'],
    ])('%s answers PING wrongly → peer_is_not_clamd, even though it would answer the stream cleanly', async (_label, text) => {
      const v = await scanWith({ reply: raw('stream: OK\0'), pong: raw(text) });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toMatch(/^peer_is_not_clamd:/);
    });

    it('a refused reason never carries the scanned bytes and is bounded', async () => {
      const v = await scanWith({ reply: raw('stream: OK\0'), pong: raw('X'.repeat(4000)) });
      expect(v.outcome).toBe('unavailable');
      const reason = v.outcome === 'unavailable' ? v.reason : '';
      expect(reason.length).toBeLessThan(200);
      expect(reason).not.toContain('AAAA');
    });
  });

  describe('the handshake is per scan, and the stream waits for it', () => {
    const clean = (): Buffer => raw('stream: OK\0');

    it('a second scan on the same instance handshakes again, and a peer that changes between scans is refused', async () => {
      let pongs = 0;
      // The peer answers PING correctly once and then stops being clamd.
      const peer = await observedPeer({
        reply: clean,
        pong: () => (++pongs === 1 ? raw('PONG\0') : raw('HTTP/1.1 200 OK\r\n\r\n')),
      });
      const scanner = scannerFor(peer.port);

      const first = await scanner.scan({ bytes, filename: 'a.png' });
      expect(first.outcome).toBe('clean');

      const second = await scanner.scan({ bytes, filename: 'b.png' });
      expect(second.outcome).toBe('unavailable');
      expect(second.outcome === 'unavailable' && second.reason).toMatch(/^peer_is_not_clamd:/);

      // Two scans, two handshakes: a cached verification would leave one.
      expect(handshakes(peer.connections)).toHaveLength(2);
      expect(pongs).toBe(2);
    });

    it('when the handshake fails, not one file byte reaches the peer and no scan connection is opened', async () => {
      const peer = await observedPeer({ reply: clean, pong: () => raw('HTTP/1.1 200 OK\r\n\r\n') });
      const scanner = scannerFor(peer.port);

      const v = await scanner.scan({ bytes, filename: 'a.png' });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toMatch(/^peer_is_not_clamd:/);

      // Exactly one connection, carrying exactly the PING command: the refusal
      // reason alone cannot show this, and streaming first would break it.
      expect(peer.connections).toHaveLength(1);
      expect(peer.connections[0]?.received.equals(PING_COMMAND)).toBe(true);
      const streamed = peer.connections.reduce((n, c) => n + c.received.length, 0) - PING_COMMAND.length;
      expect(streamed).toBe(0);
    });
  });
  describe('transport failures are refusals', () => {
    it('server accepts but never answers the stream → unavailable on the timeout', async () => {
      const v = await scanWith({ reply: null }, 800);
      expect(v.outcome).toBe('unavailable');
    });

    it('nothing listening → unavailable', async () => {
      const port = await fakePeer({ reply: raw('stream: OK\0') });
      for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
      const v = await scannerFor(port, 1000).scan({ bytes, filename: 'a.png' });
      expect(v.outcome).toBe('unavailable');
    });

    it('a peer that answers with an endless reply is cut off and refused by name (stream leg)', async () => {
      // The peer chooses how much it writes. Unbounded accumulation would be a
      // memory sink held open by the very budget meant to bound the exchange.
      const v = await scanWith({ reply: Buffer.alloc(1_000_000, 0x42) });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toBe('clamd_reply_too_long');
    });

    it('a peer that answers the handshake endlessly is cut off and refused by name (ping leg)', async () => {
      const v = await scanWith({ reply: raw('stream: OK\0'), pong: Buffer.alloc(1_000_000, 0x42) });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toBe('clamd_reply_too_long');
    });

    it('bytes over the deployment ceiling are refused, not scanned', async () => {
      const scanner = scannerFor(await fakePeer({ reply: raw('stream: OK\0') }));
      const v = await scanner.scan({ bytes: Buffer.alloc(6 * 1024 * 1024, 1), filename: 'big.png' });
      expect(v.outcome).toBe('unavailable');
      expect(v.outcome === 'unavailable' && v.reason).toBe('payload_exceeds_scan_ceiling');
    });
  });
});

/** The factory: no silent fallback, and the placeholder is impossible in production. */
describe('createMalwareScanner (§21 factory, fail-closed)', () => {
  const devEnv = {
    NODE_ENV: 'development',
    APP_DATABASE_URL: 'postgresql://daftar_app:x@localhost/daftar',
    JWT_SECRET: 'dev-secret-with-at-least-32-characters!',
  } as const;

  it('dev/test default → the DISABLED placeholder, which can only answer `unavailable`', async () => {
    const scanner = createMalwareScanner(loadConfig({ ...devEnv }));
    expect(scanner).toBeInstanceOf(DisabledDevelopmentMalwareScanner);
    expect(scanner.enabled).toBe(false);
    const v = await scanner.scan({ bytes: Buffer.alloc(1), filename: 'a.png' });
    expect(v.outcome).toBe('unavailable');
  });

  it('production REFUSES the placeholder instead of composing it', () => {
    const cfg = loadConfig({ ...devEnv });
    expect(() => createMalwareScanner({ ...cfg, isProd: true })).toThrow(/forbidden in production/);
  });

  it('MALWARE_SCANNER=clamav without a URL throws instead of falling back', () => {
    const cfg = loadConfig({ ...devEnv, MALWARE_SCANNER: 'clamav' });
    expect(() => createMalwareScanner(cfg)).toThrow(/MALWARE_SCANNER_URL/);
  });

  it('a non-clamd URL scheme is refused', () => {
    const cfg = loadConfig({ ...devEnv, MALWARE_SCANNER: 'clamav', MALWARE_SCANNER_URL: 'https://scanner.example.com' });
    expect(() => createMalwareScanner(cfg)).toThrow(/clamav:\/\/|tcp:\/\//);
  });
});
