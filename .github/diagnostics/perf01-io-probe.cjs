/**
 * PERF01 TAIL DIAGNOSIS — a probe, not a gate. It asserts nothing and always
 * exits 0 unless it cannot connect at all.
 *
 * The question it answers: when budget A's p95 blows out on a hosted runner
 * while its p50 stays at 3 ms, is the stall in the DURABLE COMMIT path (the
 * WAL fsync on COMMIT) or in the plain client/server ROUND TRIP (scheduler
 * preemption, container networking)? Budget A measures through COMMIT, so the
 * two are indistinguishable from its numbers alone.
 *
 * Three loops on the same connection, same iteration count and warm-up as the
 * hardened budget (200 and 20):
 *   1. SELECT 1            — a round trip, no write, no fsync.
 *   2. INSERT, no COMMIT   — a write into a scratch table inside one open
 *                            transaction: server work, still no fsync.
 *   3. BEGIN/INSERT/COMMIT — the shape budget A measures, fsync included.
 * A tail in 3 alone points at durable write latency. A tail in all three
 * points at the runner's scheduler. A tail in 1 and 3 but not 2 would point at
 * the socket.
 */
const { Client } = require('pg');

const URL = process.env.PROBE_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/daftar';
const N = 200;
const WARMUP = 20;
const BUDGET = 15;

function stats(name, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const over = s.filter((v) => v > BUDGET).length;
  console.log(
    `${name.padEnd(26)} n=${s.length} p50=${at(0.5).toFixed(3)} p95=${at(0.95).toFixed(3)} ` +
      `p99=${at(0.99).toFixed(3)} max=${s[s.length - 1].toFixed(3)} min=${s[0].toFixed(3)} ` +
      `over_${BUDGET}ms=${over}/${s.length} (${((100 * over) / s.length).toFixed(2)}%)`,
  );
  console.log(`${name.padEnd(26)} samples=${JSON.stringify(samples.map((v) => Number(v.toFixed(3))))}`);
}

async function loop(label, once) {
  for (let i = 0; i < WARMUP; i += 1) await once();
  const out = [];
  for (let i = 0; i < N; i += 1) {
    const t = process.hrtime.bigint();
    await once();
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  stats(label, out);
}

(async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  const v = await c.query('show server_version');
  const sets = await c.query(
    'select name, setting from pg_settings where name in ' +
      "('fsync','synchronous_commit','wal_sync_method','wal_level','full_page_writes','max_wal_size','checkpoint_timeout','shared_buffers','track_io_timing') order by name",
  );
  console.log('server_version:', v.rows[0].server_version);
  for (const r of sets.rows) console.log(`setting ${r.name} = ${r.setting}`);
  console.log('cpus:', require('node:os').cpus().length, require('node:os').cpus()[0].model);

  await c.query('drop table if exists perf01_probe');
  await c.query('create table perf01_probe (id bigserial primary key, payload text not null)');

  await loop('1 SELECT 1 round trip', async () => {
    await c.query('select 1');
  });

  await c.query('begin');
  await loop('2 INSERT, no commit', async () => {
    await c.query('insert into perf01_probe (payload) values ($1)', ['x']);
  });
  await c.query('rollback');

  await loop('3 BEGIN/INSERT/COMMIT', async () => {
    await c.query('begin');
    await c.query('insert into perf01_probe (payload) values ($1)', ['x']);
    await c.query('commit');
  });

  await c.query('drop table if exists perf01_probe');
  await c.end();
})().catch((e) => {
  console.error('PROBE COULD NOT RUN:', e.message);
  process.exit(1);
});
