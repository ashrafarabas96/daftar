// Dev/test PostgreSQL launcher (embedded-postgres, port 55432).
// Usage: node scripts/dev-pg.mjs  — keeps running; used by the test suite
// via PG_DIR/PG_PORT defaults in tests/helpers/test-app.ts.
import { existsSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const EmbeddedPostgres = require('embedded-postgres').default;

const PG_DIR = process.env.PG_DIR ?? '/tmp/daftar-pg-shared';
const pg = new EmbeddedPostgres({
  databaseDir: PG_DIR,
  user: 'postgres',
  password: 'postgres',
  port: Number(process.env.PG_PORT ?? 55432),
  persistent: true,
});
if (!existsSync(`${PG_DIR}/PG_VERSION`)) {
  await pg.initialise();
}
await pg.start();
try {
  appendFileSync(`${PG_DIR}/postgresql.auto.conf`, '\nmax_connections=500\n');
} catch {}
try {
  await pg.createDatabase('daftar');
} catch {}
console.log('PG-UP');
setInterval(() => {}, 1 << 30);
