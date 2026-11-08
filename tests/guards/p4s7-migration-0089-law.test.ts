/**
 * P4S7-BUILD — THE LAW OF MIGRATION `0089`, READ FROM ITS BYTES.
 *
 * `0089_phase4_s7_installment_plans_and_aging.sql` is the transcription of
 * `infrastructure/database/specifications/p4s7-installment-aging.spec.sql`
 * into a numbered migration. Two properties of that transcription are the
 * whole reason owner decision DR-106 let it be written at all, and neither is
 * self-evident from reading it:
 *
 *   (1) IT DOES NOT WRITE `customer_ar_aging`. That name is the LIVE law of
 *       customer receivable aging (`0084:705`, after `0084:478` dropped the
 *       `0075` body). The specification ships its projection as `CREATE OR
 *       REPLACE FUNCTION customer_ar_aging`, which would replace a live money
 *       read with a different arithmetic under the same signature, silently.
 *       `0089` ships it as `customer_ar_aging_installments` instead.
 *
 *   (2) THE ROUTINE BODIES ARE BYTE-FOR-BYTE THE SPECIFICATION'S. The
 *       migration's own section 2b pins six of them by the SHA-256 of
 *       `pg_proc.prosrc` at apply time; this file pins the same six from the
 *       FILE, before any cluster exists, and pins them against the
 *       specification as well — so a transcription that drifted is caught
 *       here and not only by a database that happens to be built.
 *
 * EVERY LAW BELOW CARRIES A POSITIVE CONTROL AND A NEGATIVE CONTROL. A law
 * that asserts an absence needs a probe that hits something else with the
 * same pattern, or its zero is blindness and not a measurement (RULE-11,
 * RULE-18); and a law that would pass on a violating file is decoration, so
 * each one is also run against a PLANTED copy and required to fail, with the
 * plant's arrival proved by a digest and not assumed (RULE-27, DR-55).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'infrastructure', 'database', 'migrations');
const MIGRATION = '0089_phase4_s7_installment_plans_and_aging.sql';
const SPEC = join(ROOT, 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');

const SEALED = 'customer_ar_aging';
const SHIPPED = 'customer_ar_aging_installments';

/** The six routine bodies section 2b pins, and the digest it pins each one to. */
const PINNED: ReadonlyArray<readonly [string, string]> = [
  ['installment_plan_fact_sync', 'ac81029839368210ebb29114bdba48facf7190d321dc393a83ecc3fc320eba77'],
  ['installment_plan_fact_verify', 'f9dda4f03c5b05e69b840dba08347bc1d68b2eabfbfd7d6416304f581e98142b'],
  ['installment_plan_active_exclusive', '972604870115f80909906ebf4a184d2de56f3c3568c91d0a7b66d288778515c2'],
  ['installment_schedule_verify', 'c334ebf3b393ceb5d7c010e931c309cb42fb112e7a44a2e406f4f17e997700a3'],
  ['installment_plan_fact_assert', '61d797de3fcb5f8e7fdb687414e09a2d734de630bdd954c48995661708b122f6'],
  [SHIPPED, '54fa1e27f19047e4d1a8732108bee3bde8ff7e46b39bf41980360301d94b7fa7'],
];

const sha256 = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/**
 * The body PostgreSQL would store in `prosrc`: exactly the characters between
 * the dollar quotes of the routine's `AS $tag$ … $tag$`. The opening tag ends
 * a line, so the body opens with the newline after it, which is why the
 * digests here are the digests a cluster computes and not merely of the same
 * text trimmed differently.
 */
function routineBody(text: string, name: string): string | null {
  const lines = text.split('\n');
  const head = new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${name}\\(`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!head.test(lines[i] ?? '')) continue;
    let j = i;
    let tag: string | null = null;
    for (; j < lines.length; j += 1) {
      const m = /AS (\$\w*\$)\s*$/.exec(lines[j] ?? '');
      if (m?.[1] !== undefined) {
        tag = m[1];
        break;
      }
    }
    if (tag === null) return null;
    let k = j + 1;
    for (; k < lines.length; k += 1) if ((lines[k] ?? '').startsWith(tag)) break;
    if (k >= lines.length) return null;
    return `\n${lines.slice(j + 1, k).join('\n')}\n`;
  }
  return null;
}

/**
 * The statements of `text` that NAME a routine — a declaration or an authority
 * change, never a mention in prose. The probe is anchored on the statement
 * keyword precisely so that a comment inside a pinned body, which may not be
 * edited without changing its digest, is not read as a declaration.
 */
function statementsNaming(text: string, routine: string): string[] {
  const out: string[] = [];
  const probe = new RegExp(`\\b${routine}\\s*\\(`);
  const longer = new RegExp(`\\b${SHIPPED}\\s*\\(`);
  const keyword = /^\s*(CREATE|DROP|ALTER|GRANT|REVOKE|COMMENT)\b/;
  for (const line of text.split('\n')) {
    if (!keyword.test(line)) continue;
    if (!probe.test(line)) continue;
    // `customer_ar_aging_installments(` also matches a probe for
    // `customer_ar_aging(` unless the longer name is excluded, and reading a
    // statement about the SHIPPED routine as one about the SEALED routine
    // would be a false alarm of exactly the shape this file exists to refuse.
    if (routine === SEALED && longer.test(line)) continue;
    out.push(line.trim());
  }
  return out;
}

const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const sql = readFileSync(join(MIGRATIONS, MIGRATION), 'utf8');
const spec = readFileSync(SPEC, 'utf8');

describe('P4S7-BUILD section 0 — there is a subject', () => {
  it('the migration is on disk, and it is the only file this lane adds above the inherited head', () => {
    const names = migrationNames();
    expect(names.length, 'NO SUBJECT — no migration files on disk at all').toBeGreaterThan(0);
    expect(names, `${MIGRATION} is not on disk, so every law below would pass by having nothing to read`).toContain(MIGRATION);
    expect(
      names.filter((n) => n > '0086_z'),
      'this lane ships exactly one migration above the inherited head 0086',
    ).toEqual([MIGRATION]);
  });

  it('the file is stored with LF endings, so every digest below is a digest of content and not of line endings', () => {
    const raw = readFileSync(join(MIGRATIONS, MIGRATION));
    expect(raw.includes('\r'), 'a CR in the file would make every body digest a measurement of the checkout and not of the transcription (RULE-23)').toBe(
      false,
    );
    expect(raw.length, 'NO SUBJECT — the file is empty').toBeGreaterThan(100_000);
  });
});

describe('P4S7-BUILD section 1 — the sealed reader is not written', () => {
  it('no statement of the migration declares or re-authorises customer_ar_aging', () => {
    const sealed = statementsNaming(sql, SEALED);
    const shipped = statementsNaming(sql, SHIPPED);
    // THE POSITIVE CONTROL, and it is the whole weight of the zero above: the
    // same probe, on the same file, finds the four statements that declare and
    // authorise the SHIPPED routine. A zero from a probe that finds nothing at
    // all is blindness.
    expect(
      shipped.length,
      'the probe finds no statement naming the shipped routine either, so its zero for the sealed one is blindness and not a measurement',
    ).toBeGreaterThanOrEqual(4);
    expect(sealed, `the migration names the sealed customer_ar_aging in a statement: ${sealed.join(' | ')}`).toEqual([]);
  });

  it('and the law fails on a planted replacement, with the plant proved to have arrived', () => {
    const before = sha256(sql);
    const planted = `${sql}\nCREATE OR REPLACE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])\nRETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)\nLANGUAGE sql STABLE AS $p$ SELECT 1 $p$;\n`;
    expect(sha256(planted), 'the plant did not change the subject, so what follows would measure the clean file (RULE-27)').not.toBe(before);
    expect(statementsNaming(planted, SEALED).length, 'the planted CREATE OR REPLACE of the sealed reader was not caught').toBeGreaterThan(0);
  });

  it('a GRANT, a DROP or an ALTER of the sealed reader is caught too, and not only a CREATE', () => {
    for (const plant of [
      'DROP FUNCTION public.customer_ar_aging(UUID, UUID, DATE, INTEGER[]);',
      'GRANT EXECUTE ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) TO daftar_worker;',
      'ALTER FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) OWNER TO daftar_migrator;',
    ]) {
      expect(statementsNaming(`${sql}\n${plant}\n`, SEALED), `the plant ${plant} was not caught`).toContain(plant);
    }
  });
});

describe('P4S7-BUILD section 2 — the bodies are the specification own bytes', () => {
  it('each of the six pinned bodies hashes to the digest section 2b pins it to', () => {
    for (const [name, digest] of PINNED) {
      const body = routineBody(sql, name);
      expect(body, `NO SUBJECT — ${name} has no dollar-quoted body in the migration`).not.toBeNull();
      expect(
        sha256(body as string),
        `the body of ${name} in the migration is not the body section 2b pins, so the apply-time identity test would refuse this very file`,
      ).toBe(digest);
    }
  });

  it('and section 2b really does carry those six digests, so this file is not checking the migration against itself from memory', () => {
    for (const [, digest] of PINNED) {
      expect(sql, `section 2b does not carry the digest ${digest}, so the pin this file asserts is not the pin the migration applies`).toContain(digest);
    }
  });

  it('each body is also identical to the specification one, which is what makes this a transcription', () => {
    for (const [name] of PINNED) {
      const specName = name === SHIPPED ? SEALED : name;
      const fromSpec = routineBody(spec, specName);
      expect(fromSpec, `NO SUBJECT — ${specName} has no dollar-quoted body in the specification`).not.toBeNull();
      expect(sha256(routineBody(sql, name) as string), `${name} drifted from the specification ${specName}`).toBe(sha256(fromSpec as string));
    }
  });

  it('and one changed character inside a body is caught', () => {
    const body = routineBody(sql, SHIPPED) as string;
    const mutated = sql.replace(body, body.replace('bucket_no', 'bucket_nO'));
    expect(sha256(mutated), 'the mutation did not change the subject').not.toBe(sha256(sql));
    expect(sha256(routineBody(mutated, SHIPPED) as string), 'a one-character change inside the projection body was not caught by the digest').not.toBe(
      PINNED[5]?.[1],
    );
  });
});

describe('P4S7-BUILD section 3 — section 2b judges the routine this file creates', () => {
  it('every regprocedure literal of the aging reader in the migration names the shipped routine', () => {
    const literals = sql.match(/'public\.customer_ar_aging[a-z_]*\(uuid,uuid,date,integer\[\]\)'/g) ?? [];
    expect(literals.length, 'NO SUBJECT — section 2b carries no regprocedure literal for the aging reader at all').toBeGreaterThan(0);
    for (const l of literals) {
      expect(l, `section 2b would read the SEALED routine out of the catalogue: ${l}`).toBe(`'public.${SHIPPED}(uuid,uuid,date,integer[])'`);
    }
  });

  it('and the uniqueness law of section 2b names the shipped routine and not the sealed one', () => {
    expect(sql, 'the uniqueness law of section 2b does not name the shipped routine').toContain(`'${SHIPPED}'`);
    expect(
      sql.includes(`'${SEALED}',`),
      'the uniqueness law of section 2b still names the sealed routine, where it would count the live 0084 body as its own',
    ).toBe(false);
  });
});

describe('P4S7-BUILD section 4 — the authority this file does NOT take', () => {
  it('PR-6 is not granted here: no EXECUTE on supplier_ap_release is handed to anyone', () => {
    const granted = sql.split('\n').filter((l) => /^\s*GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(public\.)?supplier_ap_release\b/i.test(l));
    // Positive control for the zero: the same shape of probe finds the EXECUTE
    // grants this file DOES make.
    const others = sql.split('\n').filter((l) => /^\s*GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(public\.)?installment_plan_fact_assert\b/i.test(l));
    expect(others.length, 'the probe finds no EXECUTE grant in the file at all, so its zero for supplier_ap_release is blindness').toBeGreaterThan(0);
    expect(granted, 'this file takes patch request PR-6, which it declares it does not — see OWNER_QUEUE_AR.md, P4S7-BUILD temporary decision (1)').toEqual([]);
  });

  it('the frozen set is not touched, and the manifest needs no entry for a migration above it', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure', 'database', 'MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough?: string;
      migrations?: ReadonlyArray<{ name: string; sha256: string }>;
    };
    expect(manifest.frozenThrough, 'frozenThrough moved, and this lane may not move it').toBe('0079_phase4_pos_till_sessions_cart.sql');
    expect(manifest.migrations?.length, 'NO SUBJECT — the manifest lists no migrations').toBe(80);
    for (const entry of manifest.migrations ?? []) {
      const got = createHash('sha256')
        .update(readFileSync(join(MIGRATIONS, entry.name)))
        .digest('hex');
      expect(got, `frozen migration ${entry.name} changed`).toBe(entry.sha256);
    }
    expect(MIGRATION > (manifest.frozenThrough as string), 'the migration this lane adds is not above the frozen set').toBe(true);
  });
});
