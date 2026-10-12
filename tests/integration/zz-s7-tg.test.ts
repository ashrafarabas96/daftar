/** SCRATCH: tgtype/tgattr probe. Deleted before the final commit. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import { ensurePostgres, ensureDatabase, PG_PORT } from '../helpers/test-app';
let out: unknown;
beforeAll(async () => {
  await ensurePostgres();
  await ensureDatabase('daftar_tgprobe');
  const p = new Pool({ connectionString: `postgresql://postgres:postgres@localhost:${PG_PORT}/daftar_tgprobe`, max: 1 });
  await p.query(`DROP TABLE IF EXISTS tgp CASCADE`);
  await p.query(`CREATE TABLE tgp (a INT, b INT)`);
  await p.query(`CREATE OR REPLACE FUNCTION tgpf() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
  await p.query(`CREATE TRIGGER t_before BEFORE INSERT OR UPDATE ON tgp FOR EACH ROW EXECUTE FUNCTION tgpf()`);
  await p.query(`CREATE TRIGGER t_colof AFTER UPDATE OF b ON tgp FOR EACH ROW EXECUTE FUNCTION tgpf()`);
  out = (await p.query(`SELECT tgname, tgtype, tgattr::text AS raw,
      pg_catalog.array_length(tgattr::SMALLINT[],1) AS len,
      (SELECT array_agg(x.attname::TEXT ORDER BY x.attname) FROM pg_catalog.unnest(tgattr::SMALLINT[]) k JOIN pg_attribute x ON x.attrelid=tgrelid AND x.attnum=k) AS cols
      FROM pg_trigger WHERE tgrelid='tgp'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  writeFileSync('/tmp/claude-0/s7r11-tg.json', JSON.stringify(out, null, 1));
  await p.end();
}, 600000);
describe('tg', () => { it('p', () => { console.log(JSON.stringify(out, null, 1)); expect(out).toBeTruthy(); }); });
