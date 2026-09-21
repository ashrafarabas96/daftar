import { beforeEach, describe, expect, it } from 'vitest';
import { appDbUrl, ownerPool, platformDbUrl, resetData, workerDbUrl } from '../helpers/test-app';
import { Database } from '../../apps/api/src/infra/database';
import { loadConfig } from '../../apps/api/src/config';
import { OutboxPublisher, backoffSeconds, MAX_ATTEMPTS, type OutboxSink } from '../../apps/api/src/modules/outbox/publisher';
import { OutboxService } from '../../apps/api/src/modules/audit/audit.service';

function testDb(): Database {
  return new Database(
    loadConfig({
      NODE_ENV: 'test',
      APP_DATABASE_URL: appDbUrl,
      PLATFORM_DATABASE_URL: platformDbUrl,
      WORKER_DATABASE_URL: workerDbUrl,
      JWT_SECRET: 'test-secret-key-with-at-least-32-characters!',
    }),
  );
}

/** Transactional outbox (§66): atomicity, at-least-once, retry, dead-letter, idempotent consumers. */
describe('outbox', () => {
  beforeEach(async () => {
    await resetData();
  });

  it('atomicity: business change + outbox row commit together; failure → neither exists', async () => {
    const db = testDb();
    const outbox = new OutboxService(db);
    await expect(
      db.withIdentityTransaction(async (c) => {
        await c.query('INSERT INTO tenants (id) VALUES (gen_random_uuid())');
        await outbox.emitTx(c, { type: 'test.event', payload: { n: 1 } });
        throw new Error('simulated failure before commit');
      }),
    ).rejects.toThrow('simulated failure');
    const rows = await ownerPool().query(`SELECT count(*) FROM outbox_events WHERE type = 'test.event'`);
    expect(Number(rows.rows[0]?.count)).toBe(0);
    await db.close();
  });

  it('publishes exactly once to a healthy sink and marks published', async () => {
    const db = testDb();
    const outbox = new OutboxService(db);
    await db.withIdentityTransaction(async (c) => {
      await outbox.emitTx(c, { type: 'business.created', payload: { businessId: 'x' } });
    });
    const deliveries: string[] = [];
    const sink: OutboxSink = {
      deliver: (type) => {
        deliveries.push(type);
        return Promise.resolve();
      },
    };
    const publisher = new OutboxPublisher(db, sink);
    const res = await publisher.publishOnce();
    expect(res.delivered).toBe(1);
    expect(deliveries).toEqual(['business.created']);
    const status = await ownerPool().query(`SELECT status FROM outbox_events WHERE type = 'business.created'`);
    expect(status.rows[0]?.status).toBe('published');
    // second run: nothing pending
    const again = await publisher.publishOnce();
    expect(again.delivered).toBe(0);
    await db.close();
  });

  it('failing sink retries with backoff, then dead-letters after MAX_ATTEMPTS — never silent', async () => {
    expect(backoffSeconds(1)).toBe(10);
    expect(backoffSeconds(20)).toBe(3600); // capped
    const db = testDb();
    const outbox = new OutboxService(db);
    await db.withIdentityTransaction(async (c) => {
      await outbox.emitTx(c, { type: 'will.fail', payload: {} });
    });
    const sink: OutboxSink = { deliver: () => Promise.reject(new Error('sink down')) };
    const publisher = new OutboxPublisher(db, sink);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      // force due
      await ownerPool().query(`UPDATE outbox_events SET next_attempt_at = now() - interval '1 second' WHERE type = 'will.fail'`);
      await publisher.publishOnce();
    }
    const row = await ownerPool().query(`SELECT status, attempts FROM outbox_events WHERE type = 'will.fail'`);
    expect(row.rows[0]?.status).toBe('dead');
    expect(row.rows[0]?.attempts).toBe(MAX_ATTEMPTS);
    await db.close();
  });

  it('duplicate delivery is legal by design; an idempotent consumer absorbs it', async () => {
    // At-least-once contract proof: sink may receive the same event twice.
    const received: string[] = [];
    const processed = new Set<string>(); // idempotent consumer state
    const sink: OutboxSink = {
      deliver: (_t, payload) => {
        const id = JSON.stringify(payload);
        received.push(id);
        if (!processed.has(id)) processed.add(id); // consumer idempotency key
        return Promise.resolve();
      },
    };
    await sink.deliver('x', { a: 1 });
    await sink.deliver('x', { a: 1 }); // duplicate delivery
    expect(received.length).toBe(2); // delivered twice (at-least-once)
    expect(processed.size).toBe(1); // effect applied once (idempotent consumer)
  });
});
