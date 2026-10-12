import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvMalwareScanner, createMalwareScanner, DisabledDevelopmentMalwareScanner } from '../../apps/api/src/infra/storage';
import { loadConfig } from '../../apps/api/src/config';

/**
 * The REAL clamd adapter, driven against a clamd stand-in that speaks the
 * INSTREAM wire protocol. The point of these cases is the parse: ONLY clamd's
 * own `stream: OK` is a pass. A FOUND line, a protocol error, a truncated
 * reply, silence or a refused connection must all come back `unavailable`, so
 * the upload path refuses — there is no reply that accidentally reads as clean.
 */
describe('ClamAvMalwareScanner (clamd INSTREAM)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  /** A clamd stand-in: consumes the INSTREAM frames, then answers `reply`. */
  async function fakeClamd(reply: string | null): Promise<number> {
    const server = createServer((socket) => {
      let seenTerminator = false;
      socket.on('data', (buf: Buffer) => {
        // The terminator is a zero-length chunk header (four zero bytes).
        if (buf.length >= 4 && buf.readUInt32BE(buf.length - 4) === 0) seenTerminator = true;
        if (seenTerminator && reply !== null) {
          socket.write(`${reply}\0`);
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

  const scannerFor = (port: number, timeoutMs = 2000): ClamAvMalwareScanner =>
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

  it('`stream: OK` → clean', async () => {
    const v = await scannerFor(await fakeClamd('stream: OK')).scan({ bytes, filename: 'a.png' });
    expect(v.outcome).toBe('clean');
  });

  it('`stream: <sig> FOUND` → infected, carrying the signature name', async () => {
    const v = await scannerFor(await fakeClamd('stream: Eicar-Signature FOUND')).scan({ bytes, filename: 'a.png' });
    expect(v.outcome).toBe('infected');
    expect(v.outcome === 'infected' && v.signature).toBe('Eicar-Signature');
  });

  it('clamd ERROR reply → unavailable (never clean)', async () => {
    const v = await scannerFor(await fakeClamd('INSTREAM size limit exceeded. ERROR')).scan({ bytes, filename: 'a.png' });
    expect(v.outcome).toBe('unavailable');
  });

  it('garbage reply → unavailable (never clean)', async () => {
    const v = await scannerFor(await fakeClamd('something entirely else')).scan({ bytes, filename: 'a.png' });
    expect(v.outcome).toBe('unavailable');
  });

  it('server accepts but never answers → unavailable on the timeout', async () => {
    const v = await scannerFor(await fakeClamd(null), 400).scan({ bytes, filename: 'a.png' });
    expect(v.outcome).toBe('unavailable');
  });

  it('nothing listening → unavailable', async () => {
    const port = await fakeClamd('stream: OK');
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    const v = await scannerFor(port, 1000).scan({ bytes, filename: 'a.png' });
    expect(v.outcome).toBe('unavailable');
  });

  it('bytes over the deployment ceiling are refused, not scanned', async () => {
    const scanner = scannerFor(await fakeClamd('stream: OK'));
    const v = await scanner.scan({ bytes: Buffer.alloc(6 * 1024 * 1024, 1), filename: 'big.png' });
    expect(v.outcome).toBe('unavailable');
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
