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
 *       `0075` body). The specification ships its projection under that same
 *       name with `CREATE OR REPLACE`, which would replace a live money read
 *       with a different arithmetic under the same signature, silently.
 *       `0089` ships it as `customer_ar_aging_installments` instead.
 *
 *   (2) THE ROUTINE BODIES ARE BYTE-FOR-BYTE THE SPECIFICATION'S. The
 *       migration's own section 2b pins six of them by the SHA-256 of
 *       `pg_proc.prosrc` at apply time; this file pins the same six from the
 *       FILE, before any cluster exists, and pins them against the
 *       specification as well — so a transcription that drifted is caught
 *       here and not only by a database that happens to be built.
 *
 * ── HOW §1 IS SPELLED, AND WHY IT WAS SPELLED WRONG FIRST ─────────────────
 *
 * The first version of §1 asked «which STATEMENTS name the sealed routine?»,
 * line by line, anchored on a leading statement keyword. `daftar-finance`
 * measured four texts that defeat it and pass: the identifier on the line
 * AFTER the `CREATE OR REPLACE FUNCTION` keyword; the whole statement inside a
 * `DO $mig$ … EXECUTE '…' … $mig$;` block — which is `0089`'s own idiom, so it
 * is the likely shape and not a contrived one; the identifier in double quotes;
 * and two statements on one line where the second names the LONGER routine,
 * which made the long-name exclusion swallow the line entire.
 *
 * NONE OF THE FOUR IS SPELLED OUT IN THIS FILE, and that is deliberate rather
 * than coy. DR-106 clause 1 commissions a guard that refuses the sealed name in
 * a declaration in ANY FILE OUTSIDE `migrations/`, against a baseline measured
 * on `main` — so a test that wrote those statements literally would be a NEW
 * HIT in that baseline and would red that guard, by name, on the day it lands.
 * The plants below are therefore ASSEMBLED FROM `SEALED` at run time: the
 * statements the probe sees are byte-identical to the literal ones, and this
 * file holds the bare identifier exactly once, in its declaration.
 *
 * SO THE QUESTION IS INVERTED, which is the only spelling that is total. The
 * law no longer asks which statements name the routine; it asks WHERE EVERY
 * OCCURRENCE OF THE BARE NAME SITS, and admits exactly three places:
 *
 *   * inside a `--` comment — the transcribed prose discusses the live law and
 *     must be free to;
 *   * inside one of the SIX PINNED ROUTINE BODIES — their comments and their
 *     `RAISE` messages mention it, and editing them would change the digest
 *     that proves the transcription faithful, so they are untouchable;
 *   * inside the literal of a `COMMENT ON` statement — same reason, in the
 *     statements that carry the specification's own documentation.
 *
 * Anywhere else — ordinary SQL, a string inside a `DO` block, an `EXECUTE`
 * argument, a quoted identifier — is a violation. That classification is made
 * by walking the file as a lexer walks it, tracking line comments, single
 * quotes and dollar quotes by tag, so no spelling of the statement escapes it
 * and `0089`'s own `DO $end$` block is not a hiding place.
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
const PINNED_NAMES = new Set(PINNED.map(([n]) => n));

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

type Zone = 'code' | 'comment' | 'pinned-body' | 'other-dollar-body' | 'comment-on-literal' | 'string' | 'end-state-block';

/**
 * Classify every character of `text` by the lexical zone it sits in, the way a
 * lexer would: line comments, single-quoted literals (with `''` escaping),
 * and dollar-quoted strings matched BY TAG so a nested quote of another tag
 * does not close the outer one.
 *
 * Two zones are richer than a lexer's: a dollar-quoted body opened by a
 * `CREATE [OR REPLACE] FUNCTION <pinned>(` is `pinned-body` (untouchable: its
 * bytes are under a digest), and a single-quoted literal inside a `COMMENT ON`
 * statement is `comment-on-literal`. Everything a `DO` block holds is
 * `other-dollar-body` — NOT exempt — which is what closes the `EXECUTE`
 * bypass.
 */
function zones(text: string): Zone[] {
  const out: Zone[] = new Array(text.length).fill('code');
  let i = 0;
  let pendingFunction: string | null = null;
  let inCommentOn = false;
  while (i < text.length) {
    // `--` to end of line.
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      for (let k = i; k < stop; k += 1) out[k] = 'comment';
      i = stop;
      continue;
    }
    // A dollar-quoted string: `$tag$ … $tag$`.
    const dollar = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
    if (dollar !== null) {
      const tag = dollar[0];
      const close = text.indexOf(tag, i + tag.length);
      const stop = close === -1 ? text.length : close + tag.length;
      const zone: Zone =
        pendingFunction !== null && PINNED_NAMES.has(pendingFunction) ? 'pinned-body' : tag === '$end$' ? 'end-state-block' : 'other-dollar-body';
      // The tag characters themselves are code; the content carries the zone.
      for (let k = i + tag.length; k < stop - tag.length; k += 1) out[k] = zone;
      // A `--` comment INSIDE a body stays exempt either way, and inside a
      // non-pinned body a comment is still only a comment: re-scan it.
      for (let k = i + tag.length; k < stop - tag.length; k += 1) {
        if (text.startsWith('--', k) && (k === 0 || text[k - 1] !== '-')) {
          const e = text.indexOf('\n', k);
          const s2 = e === -1 ? stop - tag.length : Math.min(e, stop - tag.length);
          for (let m = k; m < s2; m += 1) out[m] = 'comment';
          k = s2;
        }
      }
      pendingFunction = null;
      i = stop;
      continue;
    }
    // A single-quoted literal, `''` escaping its own quote.
    if (text[i] === "'") {
      let k = i + 1;
      while (k < text.length) {
        if (text[k] === "'" && text[k + 1] === "'") {
          k += 2;
          continue;
        }
        if (text[k] === "'") break;
        k += 1;
      }
      const zone: Zone = inCommentOn ? 'comment-on-literal' : 'string';
      for (let m = i + 1; m < Math.min(k, text.length); m += 1) out[m] = zone;
      i = Math.min(k + 1, text.length);
      continue;
    }
    if (text[i] === ';') {
      inCommentOn = false;
      pendingFunction = null;
      i += 1;
      continue;
    }
    // `COMMENT ON …` opens a statement whose literal carries documentation.
    if (/^COMMENT\s+ON\b/i.test(text.slice(i, i + 16))) {
      inCommentOn = true;
      i += 7;
      continue;
    }
    // `CREATE [OR REPLACE] FUNCTION <name>(` — the name decides whether the
    // dollar-quoted body that follows is one of the pinned six. The name may
    // be on a LATER LINE than the keyword, which is one of the four texts that
    // defeated the first spelling of this law.
    const fn = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i.exec(text.slice(i, i + 200));
    if (fn !== null) {
      pendingFunction = fn[1] ?? null;
      i += fn[0].length;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Every occurrence of the BARE sealed identifier, with the zone it sits in and
 * the line it is on. `(?!_)` keeps `customer_ar_aging_installments` out, and
 * `(?<![A-Za-z0-9_])` keeps a longer name that merely ENDS with it out — the
 * exclusion is on the identifier, never on the line, so two statements sharing
 * a line are judged separately.
 */
function sealedOccurrences(text: string): Array<{ line: number; zone: Zone; excerpt: string }> {
  const z = zones(text);
  const out: Array<{ line: number; zone: Zone; excerpt: string }> = [];
  const probe = new RegExp(`(?<![A-Za-z0-9_])"?${SEALED}"?(?![A-Za-z0-9_])`, 'g');
  let m: RegExpExecArray | null = probe.exec(text);
  while (m !== null) {
    const at = m.index + (m[0].startsWith('"') ? 1 : 0);
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    out.push({
      line: text.slice(0, m.index).split('\n').length,
      zone: z[at] ?? 'code',
      excerpt: text
        .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
        .trim()
        .slice(0, 160),
    });
    m = probe.exec(text);
  }
  return out;
}

/**
 * WHERE THE BARE NAME MAY SIT.
 *
 * `end-state-block` is the fourth, and it is a RETREAT MADE DELIBERATELY. The
 * money review that defeated this law's first spelling four ways then defeated
 * its inversion too, with a class no text analysis can close: an identifier
 * assembled from fragments — `'customer_ar_' || 'aging'`, a name read out of
 * `pg_proc`, `format('%I', 'customer_ar_agin' || chr(103))` — never spells
 * itself anywhere in the file. A lexer sees string pieces.
 *
 * So the end-state block is no longer policed by READING IT. It is policed by
 * the instrument it now carries: part 10 of section 2b reads
 * `sha256(prosrc)` of the live reader OUT OF THE CATALOGUE, last, after every
 * statement of the migration has run — including anything a `DO` executed
 * dynamically — and refuses the whole migration if the body has moved by a
 * byte or is absent. The catalogue carries no spelling, so no concatenation
 * reaches it. The law below ASSERTS THAT INSTRUMENT IS THERE, which is what
 * pays for this exemption, and asserts that nothing executable follows it.
 */
const EXEMPT: ReadonlySet<Zone> = new Set<Zone>(['comment', 'pinned-body', 'comment-on-literal', 'end-state-block']);
const LIVE_BODY_DIGEST = '9c3d304e26cdddd2c34b878ebd06459c850b8aea87c32ea2e3e4bcf18ae274ad';
const offending = (text: string): Array<{ line: number; zone: Zone; excerpt: string }> => sealedOccurrences(text).filter((o) => !EXEMPT.has(o.zone));

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

describe('P4S7-BUILD section 1 — the sealed reader is not written, in any spelling', () => {
  it('the zone classifier reads this file as a lexer would, which is the positive control for every zero below', () => {
    const all = sealedOccurrences(sql);
    // THE POSITIVE CONTROL, and it is the whole weight of the law. A probe
    // that finds nothing proves nothing; this one finds the bare name many
    // times and places each occurrence in a zone.
    expect(all.length, 'the probe finds no occurrence of the bare sealed name at all — its verdict would be blindness, not a measurement').toBeGreaterThan(10);
    const found = new Set(all.map((o) => o.zone));
    // And it distinguishes zones rather than calling everything exempt: the
    // transcribed prose, the pinned bodies and the documentation literals are
    // each actually represented.
    expect(found.has('comment'), 'the classifier found no occurrence in a comment, so it is not distinguishing zones').toBe(true);
    expect(found.has('pinned-body'), 'the classifier found no occurrence inside a pinned body, so the exemption it grants is untested').toBe(true);
    expect(found.has('comment-on-literal'), 'the classifier found no occurrence in a COMMENT ON literal, so that exemption is untested').toBe(true);
  });

  it('and no occurrence sits in SQL the database would execute', () => {
    const bad = offending(sql);
    expect(bad, `the migration reaches the sealed ${SEALED} in executable SQL: ${bad.map((o) => `${o.zone}@${o.line}: ${o.excerpt}`).join(' | ')}`).toEqual([]);
  });

  it('the four texts that defeated the first spelling of this law are each caught now', () => {
    const SIG = '(UUID, UUID, DATE, INTEGER[])';
    const SHAPE = 'RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)';
    const plants: ReadonlyArray<readonly [string, string]> = [
      [
        'the identifier on the line AFTER the keyword',
        `CREATE OR REPLACE FUNCTION\n  ${SEALED}(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])\n${SHAPE}\nLANGUAGE sql STABLE AS $p$ SELECT 1 $p$;`,
      ],
      [
        'the whole statement inside a DO block, which is this file own idiom',
        `DO $mig$\nBEGIN\n  EXECUTE 'CREATE OR REPLACE FUNCTION public.${SEALED}(p_a UUID, p_b UUID, p_c DATE, p_d INTEGER[]) ${SHAPE} LANGUAGE sql STABLE AS $x$ SELECT 1 $x$';\nEND\n$mig$;`,
      ],
      ['the quoted identifier', `DROP FUNCTION public."${SEALED}"${SIG};`],
      [
        'two statements on one line, the second naming the LONGER routine',
        `DROP FUNCTION ${SEALED}${SIG}; GRANT EXECUTE ON FUNCTION ${SHIPPED}${SIG} TO daftar_app;`,
      ],
    ];
    for (const [what, plant] of plants) {
      const planted = `${sql}\n${plant}\n`;
      // The plant must actually have arrived before its result is read.
      expect(sha256(planted), `the plant (${what}) did not change the subject, so what follows would measure the clean file (RULE-27)`).not.toBe(sha256(sql));
      const bad = offending(planted);
      expect(bad.length, `NOT CAUGHT — ${what}`).toBeGreaterThan(0);
    }
  });

  it('and the exemptions are not a hole: the same statement is caught even when it is spelled inside a comment-bearing region', () => {
    // A `COMMENT ON` literal is exempt; a `COMMENT ON FUNCTION <sealed>` is
    // NOT, because the identifier is in the statement and not in the literal.
    const SIG = '(UUID, UUID, DATE, INTEGER[])';
    const planted = `${sql}\nCOMMENT ON FUNCTION ${SEALED}${SIG} IS 'rewritten';\n`;
    expect(offending(planted).length, 'a COMMENT ON of the sealed routine was swallowed by the COMMENT ON literal exemption').toBeGreaterThan(0);
    // And a non-pinned routine body is not a hiding place either.
    const planted2 = `${sql}\nCREATE OR REPLACE FUNCTION some_other_helper() RETURNS VOID LANGUAGE plpgsql AS $h$\nBEGIN\n  EXECUTE 'DROP FUNCTION ${SEALED}${SIG}';\nEND\n$h$;\n`;
    expect(offending(planted2).length, 'a body that is not one of the pinned six was treated as exempt').toBeGreaterThan(0);
  });

  it('the end-state block carries the catalogue claim that pays for its exemption', () => {
    // The digest is the live body's, measured from `0084:705..:739` — the same
    // string PostgreSQL stores in `prosrc` — and not copied from a report.
    expect(sql, 'section 2b does not pin the live reader body at all, so the end-state exemption above is unpaid for').toContain(LIVE_BODY_DIGEST);
    expect(sql, 'the claim does not read prosrc out of the catalogue').toContain("pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8'))");
    expect(sql, 'the claim does not identify the live reader by name in pg_proc').toContain(`p.proname = '${SEALED}'`);
    expect(sql, 'the claim does not pin the signature, so an overload of other argument types would satisfy it').toContain(
      "p.proargtypes = ARRAY['uuid'::regtype, 'uuid'::regtype, 'date'::regtype, 'integer[]'::regtype]::oidvector",
    );
    expect(sql, 'the claim does not refuse on a difference').toContain('installment.sealed_reader_disturbed');
    // NEGATIVE CONTROL: without the digest the law must fail, so this is not a
    // test that passes on any file.
    // `replaceAll`, because the digest is written more than once — in the
    // comparison, and again in the refusal that names what it required. A
    // single `replace` left one behind and the control passed on a file the
    // law should have refused, which is the control failing rather than the
    // law working.
    const stripped = sql.replaceAll(LIVE_BODY_DIGEST, '0'.repeat(64));
    expect(sha256(stripped), 'the plant did not change the subject').not.toBe(sha256(sql));
    expect(stripped.includes(LIVE_BODY_DIGEST), 'removing the digest did not remove it').toBe(false);
  });

  it('and nothing executable follows that claim, so it really is the last word on the state', () => {
    const at = sql.lastIndexOf('installment.sealed_reader_disturbed');
    expect(at, 'NO SUBJECT — the claim is not in the file').toBeGreaterThan(0);
    // What may follow: whitespace, `--` comments, the block's own `END` and its
    // closing dollar quote. Anything else runs AFTER the state was judged, and
    // could undo what the claim just certified.
    const residueOf = (text: string, from: number): string[] =>
      text
        .slice(text.indexOf('END IF;', from) + 'END IF;'.length)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('--') && l !== 'END' && l !== '$end$;');
    const residue = residueOf(sql, at);
    expect(residue, `statements follow the sealed-reader claim inside the end-state block: ${residue.join(' | ')}`).toEqual([]);
    // NEGATIVE CONTROL: a statement planted after the claim is caught.
    const tail = '\nEND\n$end$;\n';
    expect(sql.endsWith(tail), 'NO SUBJECT — the end-state block does not close the file as expected').toBe(true);
    const planted = `${sql.slice(0, -tail.length)}\n  EXECUTE 'SELECT 1';${tail}`;
    expect(sha256(planted), 'the plant did not change the subject').not.toBe(sha256(sql));
    expect(
      residueOf(planted, planted.lastIndexOf('installment.sealed_reader_disturbed')).length,
      'a statement planted after the claim was not caught',
    ).toBeGreaterThan(0);
  });

  it('the shipped routine IS declared, four times, so section 1 is not passing by the file being empty of both', () => {
    const declarations = sql.split('\n').filter((l) => /^\s*(CREATE|GRANT|REVOKE|COMMENT)\b/.test(l) && new RegExp(`\\b${SHIPPED}\\s*\\(`).test(l));
    expect(declarations.length, 'the migration declares and authorises the shipped routine nowhere, so it ships no projection at all').toBeGreaterThanOrEqual(
      4,
    );
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
    // The probe names NO routine: it matches every `regprocedure` literal of
    // THIS SIGNATURE, whatever it is called, and the assertion then requires
    // each one to be the shipped routine. A probe that named the sealed one
    // would find nothing once the file is correct, and would then be unable to
    // tell «correct» from «I looked in the wrong place».
    const literals = sql.match(/'public\.[a-z_]+\(uuid,uuid,date,integer\[\]\)'/g) ?? [];
    expect(literals.length, 'NO SUBJECT — section 2b carries no regprocedure literal of the aging signature at all').toBeGreaterThan(0);
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

/**
 * P4S7-BUILD section 5 — THE PRICE OF THE RULE-22 EXCEPTION, PAID HERE.
 *
 * Owner decision DR-111 (2026-11-08) adds `installment_plan_fact_sync` to
 * `WRITER_AUTHORITY_EXCEPTIONS`. The owner's condition was that the exception
 * be the NARROWEST POSSIBLE — one routine, one column, one statement — and
 * that negative controls prove the law still refuses everything else.
 *
 * WHY THE NARROWNESS CANNOT LIVE IN THE GUARD. `WRITER_AUTHORITY_EXCEPTIONS`
 * is a list of NAMES, and `inventory-writer-authority.ts` skips an exempt
 * routine by name BEFORE every other check. So the guard cannot express «one
 * column», «one statement» or «one file», and the narrowness is enforced here
 * instead.
 *
 * ── WHAT A MONEY REVIEW MEASURED AGAINST THE FIRST VERSION OF THIS SECTION ──
 *
 * `daftar-finance` refused it with three findings, each reproduced from a
 * PLANT rather than argued, and each is closed below:
 *
 *   1. THE FILE DIMENSION WAS MISSING, and it was the blocker. The exception is
 *      keyed on the NAME, and these laws read only `0089`. A SECOND definition
 *      of the same name in another migration — writing `supplier_credit_notes`,
 *      `stock_movements` and `invoices.total_txn_minor`, with an impure
 *      `DECLARE` initialiser and `EXCEPTION WHEN OTHERS` — produced
 *      `violations = 0`, while the same body under any other name produced
 *      three. So the grant covered a routine, and the law covered a file.
 *   2. A CONTROL PASSED ON WRONG WORK. `SET has_active_installment_plan = v,
 *      total_txn_minor = 0` was read as one column, because the probe captured
 *      only the FIRST assignment after `SET`. The statement counter was
 *      anchored at `^\s*` too, so a write not starting its line, a `MERGE` and
 *      an `EXECUTE` all escaped it.
 *   3. TWO CLAIMS IN THE DOCUMENTATION WERE FALSE: that these laws catch a
 *      second column (they did not, per 2), and that a trigger body «cannot
 *      satisfy rule 22 at all» (a body opening with `PERFORM
 *      inventory_assertion_current(...)` would satisfy it syntactically — the
 *      true reason is that no signed command and no installment op code exist).
 *
 * The probe is therefore stated once, over the WHOLE write clause and over
 * EVERY definition in EVERY migration, and `EXECUTE` is refused outright in
 * the exempt routine because a dynamic statement is a write no text probe can
 * bound.
 */
describe('P4S7-BUILD section 5 — the rule-22 exception is as narrow as it was granted', () => {
  const MIGRATIONS_DIR = join(ROOT, 'infrastructure', 'database', 'migrations');
  const EXEMPT = 'installment_plan_fact_sync';
  // `COPY` is in the vocabulary of the law this mirrors
  // (`inventory-writer-authority.ts:179`) and was missing here, and a table name
  // may be QUOTED or qualified by ANY schema, not only `public`. A probe whose
  // vocabulary is narrower than the law's reports green on a write the law
  // itself would refuse — measured by a money review on both spellings.
  const WRITE_VERB =
    /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;

  /** A body with its `--` comments removed: a comment that mentions a write is not one. */
  const code = (body: string): string =>
    body
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');

  /** Every write statement in `body`, as [verb, table]. NOT line-anchored. */
  const writesOf = (body: string): Array<[string, string]> =>
    [...code(body).matchAll(WRITE_VERB)].map((m) => [(m[1] ?? '').toUpperCase().replace(/\s+/g, ' '), (m[2] ?? '').toLowerCase().replace(/^public\./, '')]);

  /**
   * Every column assigned by every `SET` clause — THE WHOLE CLAUSE, to the
   * first `WHERE`, `FROM`, `RETURNING` or `;`, and the `SET (a, b) = (...)`
   * spelling as well. Capturing only the first assignment is how a second
   * money column rode in beside the one the decision covers.
   */
  const setClauses = (body: string): string[] => [...code(body).matchAll(/\bSET\s+([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|;)/gi)].map((m) => m[1] ?? '');

  const columnsSetBy = (body: string): string[] => {
    const out: string[] = [];
    for (const clause of setClauses(body)) {
      for (const g of clause.matchAll(/\(([^)]*)\)\s*=/g)) for (const n of (g[1] ?? '').split(',')) out.push(n.trim().toLowerCase());
      for (const a of clause.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi)) out.push((a[1] ?? '').toLowerCase());
    }
    return [...new Set(out.filter((c) => c !== ''))];
  };

  /**
   * Every definition of `name` across EVERY migration, with the file it is in.
   *
   * `files` is injectable so the negative control can RUN THIS FUNCTION on a
   * planted set rather than hand-build the array it expects — a control that
   * composes its own answer tests nothing, which a money review measured
   * against the first version of it.
   *
   * THE SPELLING IT RECOGNISES IS THE BARE NAME ONLY, deliberately: the
   * schema-qualified form `FUNCTION public.<name>(` is REFUSED outright by the
   * law below rather than chased here. Chasing it would leave every other
   * qualification (`"public".`, another schema, whitespace around the dot) to
   * be found one at a time, and the guard this mirrors normalises to the bare
   * name — so the two would keep disagreeing about what "the same routine" is.
   */
  const definitionsAcrossMigrations = (name: string, files?: Readonly<Record<string, string>>): Array<{ file: string; body: string }> => {
    const out: Array<{ file: string; body: string }> = [];
    const source = files ?? Object.fromEntries(migrationNames().map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')]));
    for (const [f, text] of Object.entries(source)) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(`FUNCTION ${name}(`, from);
        if (at === -1) break;
        from = at + 1;
        const body = routineBody(text.slice(Math.max(0, text.lastIndexOf('CREATE', at))), name);
        if (body !== null) out.push({ file: f, body });
      }
    }
    return out;
  };

  /**
   * EVERY PLACE THE SYMBOL IS NAMED AS A ROUTINE, however it is spelled.
   *
   * THIS IS THE ONE LAW THAT CLOSES THE CLASS, and it replaces two probes that
   * were each chasing a spelling. Three rounds of money review produced seven
   * spellings of a second definition — bare; `public.`; `PUBLIC.`;
   * `"public" . ` with whitespace around the dot; another schema `acct.`;
   * a block comment sitting between the keyword and the name; and the whole statement inside
   * `DO $mig$ … EXECUTE '…' … $mig$;`, WHICH IS THIS FILE'S OWN IDIOM. Each
   * one defeated a probe keyed on the previous one, and the guard exempts them
   * all because it normalises to the bare name.
   *
   * So the question stops being «which spelling?» and becomes «how many times
   * is this symbol named as a routine AT ALL?». For every occurrence of the
   * symbol followed by `(`, the text before it is read backwards — block
   * comments removed, then an optional quote, an optional schema qualifier and
   * whitespace stripped — and the occurrence counts when what remains ends in
   * `FUNCTION`. It is not anchored to a line, so a statement inside an
   * `EXECUTE` string is seen; and it does not enumerate separators, so the
   * eighth spelling is caught without being predicted.
   */
  type MentionKind = 'create' | 'binding' | 'grant' | 'revoke' | 'comment' | 'alter' | 'unknown';
  const KIND_OF: ReadonlyArray<readonly [MentionKind, RegExp]> = [
    ['create', /\bCREATE\s+(?:OR\s+REPLACE\s+)?$/i],
    ['grant', /\bGRANT\s+EXECUTE\s+ON\s+$/i],
    ['revoke', /\bREVOKE\s+(?:ALL|EXECUTE)\s+ON\s+$/i],
    ['comment', /\bCOMMENT\s+ON\s+$/i],
    ['alter', /\bALTER\s+$/i],
    ['binding', /\bEXECUTE\s+$/i],
  ];

  const functionMentionsOf = (
    name: string,
    files?: Readonly<Record<string, string>>,
  ): Array<{ file: string; kind: MentionKind; qualified: boolean; excerpt: string }> => {
    const out: Array<{ file: string; kind: MentionKind; qualified: boolean; excerpt: string }> = [];
    const source = files ?? Object.fromEntries(migrationNames().map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')]));
    const occurrence = new RegExp(String.raw`(?<![a-z0-9_])"?${name}"?\s*\(`, 'gi');
    for (const [file, text] of Object.entries(source)) {
      for (const m of text.matchAll(occurrence)) {
        // A MENTION INSIDE A `--` COMMENT IS NOT A MENTION. The independent
        // review measured both halves of this: `-- the FUNCTION <name>() …`
        // was classified `unknown` and would have RED-ed the law on legitimate
        // prose, and `-- see CREATE OR REPLACE FUNCTION <name>() above` was
        // counted as a definition. A commented-out statement cannot execute,
        // so skipping it is not a hole — and it is why `/* */` was already
        // dropped from the window below.
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        if (text.slice(lineStart, m.index).includes('--')) continue;
        const before = text.slice(Math.max(0, m.index - 240), m.index).replace(/\/\*[\s\S]*?\*\//g, ' ');
        // Strip, in order: trailing space, an opening quote, a schema
        // qualifier (quoted or not, with space around the dot), more space.
        const stripped = before.replace(/\s*"?\s*(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?$/i, '');
        if (!/\bFUNCTION\s*$/i.test(stripped)) continue;
        const keyword = stripped.replace(/\bFUNCTION\s*$/i, '');
        out.push({
          file,
          kind: KIND_OF.find(([, re]) => re.test(keyword))?.[0] ?? 'unknown',
          qualified: /\.\s*$/.test(before.replace(/\s*"?\s*$/, '')),
          excerpt: text
            .slice(Math.max(0, m.index - 60), m.index + name.length + 1)
            .replace(/\s+/g, ' ')
            .trim(),
        });
      }
    }
    return out;
  };

  it('THE FILE DIMENSION: the exempt name is defined in exactly ONE migration, and writes only invoices across all of them', () => {
    const defs = definitionsAcrossMigrations(EXEMPT);
    expect(defs.length, `NO SUBJECT — ${EXEMPT} has no definition in any migration`).toBeGreaterThan(0);
    expect(
      [...new Set(defs.map((d) => d.file))],
      `the exempt name is defined in more than one migration, and the exception is keyed on the NAME: ${defs.map((d) => d.file).join(', ')}`,
    ).toEqual([MIGRATION]);
    expect(defs.length, `the exempt name has ${defs.length} definitions, and DR-111 grants one`).toBe(1);
    const tables = [...new Set(defs.flatMap((d) => writesOf(d.body)).map(([, t]) => t))];
    expect(tables, `across every migration the exempt routine writes ${tables.join(', ')}, and DR-111 covers invoices alone`).toEqual(['invoices']);
    // AND THE SCHEMA-QUALIFIED SPELLING IS REFUSED OUTRIGHT, which is the
    // blocker a money review measured: `FUNCTION public.<name>(` is a second
    // definition the guard exempts (it normalises to the bare name) and that
    // the law above could not see. It is refused rather than chased, because
    // chasing leaves `"public".`, another schema and whitespace around the dot
    // to be found one at a time.
    const mentions = functionMentionsOf(EXEMPT);
    // MEASURED, NOT ASSUMED: the migration names this routine SIX times, and
    // five of them must. One `CREATE`, one trigger binding
    // (`EXECUTE FUNCTION`), and the four authority statements `REVOKE`,
    // `GRANT`, `COMMENT ON` and `ALTER … OWNER TO`. The law is therefore not
    // «one mention» — it is ONE DEFINITION, every other mention classified,
    // and nothing unclassified.
    const creates = mentions.filter((o) => o.kind === 'create');
    expect(
      creates.map((o) => `${o.file}${o.qualified ? ' (qualified)' : ''}`),
      `the symbol is DEFINED somewhere other than once, unqualified, in ${MIGRATION}: ${creates.map((o) => o.excerpt).join(' | ')}`,
    ).toEqual([MIGRATION]);
    expect(
      mentions.filter((o) => o.kind === 'unknown').map((o) => `${o.file}: ${o.excerpt}`),
      'the symbol is named by a statement kind this law does not classify — read it before admitting it',
    ).toEqual([]);
    expect(
      [...new Set(mentions.map((o) => o.kind))].sort(),
      'the set of statement kinds naming this routine changed, which is a change in how it is reached',
    ).toEqual(['alter', 'binding', 'comment', 'create', 'grant', 'revoke']);

    // NEGATIVE CONTROL for the `unknown` law, which the independent review
    // found asserting silence with no plant behind it. Both directions are
    // measured: a statement kind this law does not classify MUST surface, and
    // ordinary prose MUST NOT — the second being a false red the review
    // reached with a `--` comment before the window learned to skip them.
    expect(
      functionMentionsOf(EXEMPT, { '0099_planted.sql': `DROP FUNCTION ${EXEMPT}();` }).map((o) => o.kind),
      'an unclassified statement kind did not surface, so the `unknown` law asserts a silence it cannot hear',
    ).toEqual(['unknown']);
    expect(
      functionMentionsOf(EXEMPT, { '0099_planted.sql': `-- the routine ${EXEMPT}() and CREATE OR REPLACE FUNCTION ${EXEMPT}() are discussed here` }),
      'prose in a line comment was counted, which would red this law on legitimate text',
    ).toEqual([]);
  });

  it('POSITIVE CONTROL — the mention law sees all seven spellings a money review produced', () => {
    const head = (spelling: string): string =>
      `CREATE OR REPLACE FUNCTION ${spelling}() RETURNS TRIGGER LANGUAGE plpgsql AS $x$\nBEGIN\n  UPDATE public.supplier_credit_notes SET note_no = 0 WHERE false;\n  RETURN NEW;\nEND\n$x$;\n`;
    const spellings: ReadonlyArray<readonly [string, string]> = [
      ['bare', head(EXEMPT)],
      ['public.', head(`public.${EXEMPT}`)],
      ['PUBLIC. in upper case', head(`PUBLIC.${EXEMPT}`)],
      ['quoted schema with spaces around the dot', head(`"public" . "${EXEMPT}"`)],
      ['another schema', head(`acct.${EXEMPT}`)],
      ['a block comment between the keyword and the name', head(`/* c */ public.${EXEMPT}`)],
      [
        'inside DO/EXECUTE, which is this file own idiom',
        `DO $mig$\nBEGIN\n  EXECUTE 'CREATE OR REPLACE FUNCTION ${EXEMPT}() RETURNS TRIGGER LANGUAGE plpgsql AS $y$ BEGIN RETURN NEW; END $y$';\nEND\n$mig$;\n`,
      ],
    ];
    for (const [what, planted] of spellings) {
      const seen = functionMentionsOf(EXEMPT, { '0099_planted.sql': planted }).filter((o) => o.kind === 'create');
      expect(seen.length, `NOT SEEN — a second DEFINITION spelled «${what}» is invisible to the mention law`).toBeGreaterThan(0);
      expect(seen[0]?.file, `the definition spelled «${what}» was attributed to the wrong file`).toBe('0099_planted.sql');
    }
    // NEGATIVE CONTROL FOR THE LAW ITSELF: a mention that is not a routine
    // NAME — a call, a trigger binding of another routine, prose — must not
    // count, or the law would refuse this file's own comments.
    for (const [what, text] of [
      ['a call', `BEGIN\n  PERFORM ${EXEMPT}();\nEND`],
      ['a trigger binding of another routine', `CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW EXECUTE FUNCTION other_name();`],
      ['prose', `-- the routine ${EXEMPT}() is discussed here`],
    ] as const) {
      expect(
        functionMentionsOf(EXEMPT, { '0099_planted.sql': text }).filter((o) => o.kind === 'create'),
        `a ${what} was counted as a DEFINITION, which would make the law refuse ordinary text`,
      ).toEqual([]);
    }
  });

  it('ONE STATEMENT, ONE TABLE, ONE COLUMN — and no dynamic statement at all', () => {
    const body = routineBody(sql, EXEMPT);
    expect(body, `NO SUBJECT — ${EXEMPT} has no body in ${MIGRATION}`).not.toBeNull();
    const writes = writesOf(body as string);
    expect(writes.length, `the exempt routine writes ${writes.length} statements: ${writes.map((w) => w.join(' ')).join(' | ')}`).toBe(1);
    expect(writes[0], 'the one write is not an UPDATE of invoices').toEqual(['UPDATE', 'invoices']);
    expect(columnsSetBy(body as string), 'the exempt routine assigns a column DR-111 does not cover').toEqual(['has_active_installment_plan']);
    // A dynamic statement is a write no text probe can bound, so it is refused
    // outright rather than parsed. The positive control is that the probe sees
    // the body at all: it finds the one static write above.
    expect(/\bEXECUTE\b/i.test(code(body as string)), 'the exempt routine carries EXECUTE, and a dynamic write cannot be held to one column').toBe(false);
    // A SUBQUERY INSIDE A `SET` VALUE IS REFUSED FOR THE SAME REASON, and this
    // is a hole a money review measured: the clause is cut at the first
    // `WHERE`/`FROM`/`RETURNING`, so an inner `FROM` ended it early and every
    // assignment after it went unread — `SET flag = (SELECT … FROM …),
    // total_txn_minor = 0` was read as ONE column. Rather than parse nesting,
    // the SHAPE is refused: a value this probe cannot bound may not sit in the
    // one statement the exception covers.
    expect(
      setClauses(body as string).some((c) => /\bSELECT\b/i.test(c)),
      'the exempt routine carries a subquery in a SET value, and a clause this probe cannot bound may not carry the one column DR-111 covers',
    ).toBe(false);
  });

  it('NEGATIVE CONTROLS — the six body plants a money review used, each required to fail', () => {
    const body = routineBody(sql, EXEMPT) as string;
    const plants: ReadonlyArray<readonly [string, string, 'writes' | 'columns' | 'execute']> = [
      [
        'a second column in the SAME SET clause',
        body.replace('SET has_active_installment_plan = v_value', 'SET has_active_installment_plan = v_value, total_txn_minor = 0'),
        'columns',
      ],
      [
        'the SET (a, b) = (...) spelling',
        body.replace('SET has_active_installment_plan = v_value', 'SET (has_active_installment_plan, total_txn_minor) = (v_value, 0)'),
        'columns',
      ],
      ['a second statement, not starting its line', `${body}\n    PERFORM 1; UPDATE public.stock_levels SET on_hand = 0 WHERE false;\n`, 'writes'],
      ['a MERGE', `${body}\n    MERGE INTO public.stock_movements USING (SELECT 1) s ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES;\n`, 'writes'],
      ['a second write to the same table', `${body}\n    UPDATE public.invoices i SET status = 'void' WHERE false;\n`, 'columns'],
      ['a dynamic statement', `${body}\n    EXECUTE format('UPDATE %I SET on_hand = 0', 'stock_levels');\n`, 'execute'],
    ];
    for (const [what, planted, dimension] of plants) {
      expect(sha256(planted), `the plant (${what}) did not change the subject (RULE-27)`).not.toBe(sha256(body));
      if (dimension === 'writes') {
        expect(writesOf(planted).length, `NOT CAUGHT — ${what}`).toBeGreaterThan(1);
      } else if (dimension === 'columns') {
        const cols = columnsSetBy(planted);
        expect(cols.length, `NOT CAUGHT — ${what} (columns read: ${cols.join(', ')})`).toBeGreaterThan(1);
      } else {
        expect(/\bEXECUTE\b/i.test(code(planted)), `NOT CAUGHT — ${what}`).toBe(true);
      }
    }
  });

  it('NEGATIVE CONTROL — a SECOND definition of the exempt name in another migration is caught', () => {
    // This is the blocker the money review measured: the guard skips by name
    // before every other check, so a second definition anywhere is covered by
    // the same grant. The file law above is what refuses it, and this proves
    // the law refuses rather than merely being written.
    // AND IT RUNS THE REAL PROBE ON A PLANTED FILE MAP. The first version of
    // this control hand-built the array it then asserted over, so it tested
    // its own arithmetic and not the law — which a money review measured and
    // refused.
    const clean = Object.fromEntries(migrationNames().map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')]));
    expect(definitionsAcrossMigrations(EXEMPT, clean).length, 'the probe does not see the real definition, so the plant below proves nothing').toBe(1);

    // (a) THE BARE SPELLING, in a second migration: the file law catches it.
    const bare = `CREATE OR REPLACE FUNCTION ${EXEMPT}() RETURNS TRIGGER LANGUAGE plpgsql AS $z$\nBEGIN\n  UPDATE public.stock_movements SET qty = 0 WHERE false;\n  RETURN NEW;\nEND\n$z$;\n`;
    const withBare = definitionsAcrossMigrations(EXEMPT, { ...clean, '0099_elsewhere.sql': bare });
    expect([...new Set(withBare.map((d) => d.file))].length, 'a second BARE definition in another migration was not seen').toBeGreaterThan(1);
    const tables = [...new Set(withBare.flatMap((d) => writesOf(d.body)).map(([, t]) => t))];
    expect(tables, `a second definition writing another truth table was not caught (tables: ${tables.join(', ')})`).not.toEqual(['invoices']);

    // (b) THE SPELLINGS THE BODY PROBE CANNOT SEE. `definitionsAcrossMigrations`
    //     matches `FUNCTION <bare-name>(` and so misses a qualification, a
    //     comment between the keyword and the name, and the whole statement
    //     inside `EXECUTE` — seven spellings in all, measured over three
    //     rounds. The MENTION law is what refuses them, and this proves both
    //     halves: the body probe stays blind (so the catch has not silently
    //     moved) and the mention law catches.
    for (const [what, text] of [
      ['schema-qualified', `CREATE OR REPLACE FUNCTION public.${EXEMPT}() RETURNS TRIGGER LANGUAGE plpgsql AS $q$ BEGIN RETURN NEW; END $q$;`],
      [
        'a comment between the keyword and the name',
        `CREATE OR REPLACE FUNCTION /* c */ public.${EXEMPT}() RETURNS TRIGGER LANGUAGE plpgsql AS $q$ BEGIN RETURN NEW; END $q$;`,
      ],
      [
        'inside DO/EXECUTE',
        `DO $mig$\nBEGIN\n  EXECUTE 'CREATE OR REPLACE FUNCTION ${EXEMPT}() RETURNS TRIGGER LANGUAGE plpgsql AS $y$ BEGIN RETURN NEW; END $y$';\nEND\n$mig$;\n`,
      ],
    ] as const) {
      const planted = { ...clean, '0099_planted.sql': text };
      expect(
        definitionsAcrossMigrations(EXEMPT, planted).length,
        `the body probe now sees «${what}», so the catch has moved to another law without anyone noticing — re-read both`,
      ).toBe(1);
      const seen = functionMentionsOf(EXEMPT, planted).filter((o) => o.file === '0099_planted.sql' && o.kind === 'create');
      expect(seen.length, `NOT CAUGHT — a second definition spelled «${what}»`).toBeGreaterThan(0);
    }
  });

  it('NEGATIVE CONTROL — ANOTHER routine writing invoices is still refused by rule 22 itself', async () => {
    const { checkInventoryWriterAuthority } = await import('../../scripts/guards/inventory-writer-authority');
    const map: Record<string, string> = {};
    for (const f of migrationNames()) map[join('infrastructure', 'database', 'migrations', f)] = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    expect(checkInventoryWriterAuthority(map).violations, 'rule 22 is not green on the clean tree, so this control measures nothing').toEqual([]);
    const key = join('infrastructure', 'database', 'migrations', MIGRATION);
    const intruder = `\nCREATE OR REPLACE FUNCTION p4s7_intruder_writes_the_fact() RETURNS TRIGGER\nLANGUAGE plpgsql AS $i$\nBEGIN\n  UPDATE public.invoices i SET has_active_installment_plan = true WHERE i.id = NEW.invoice_id;\n  RETURN NEW;\nEND\n$i$;\n`;
    const violations = checkInventoryWriterAuthority({ ...map, [key]: `${map[key] ?? ''}${intruder}` }).violations;
    // NOTE THE EXACT CLAIM: rule 22's granularity is the TABLE, not the
    // column. What is proven is that another routine writing the `invoices`
    // TABLE is refused — not that it is refused for touching that column.
    expect(
      violations.some((v) => v.includes('p4s7_intruder_writes_the_fact')),
      `another routine writing the invoices table was NOT refused: ${violations.join(' | ') || '(no violation at all)'}`,
    ).toBe(true);
  });

  it('NEGATIVE CONTROL — the same body outside the exception is refused, and the set shrinks by itself', async () => {
    const guard = join(ROOT, 'scripts', 'guards', 'inventory-writer-authority.ts');
    const text = readFileSync(guard, 'utf8');
    expect(text, 'the exception entry DR-111 grants is not in the law').toContain(`'${EXEMPT}'`);
    expect(text, 'the pre-existing exception was removed to make room, which DR-111 does not authorise').toContain("'warehouses_home_branch_maintain'");
    const { checkInventoryWriterAuthority } = await import('../../scripts/guards/inventory-writer-authority');
    const map: Record<string, string> = {};
    for (const f of migrationNames()) map[join('infrastructure', 'database', 'migrations', f)] = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const key = join('infrastructure', 'database', 'migrations', MIGRATION);
    // Renaming, not mocking: the exception is keyed on the NAME, so a renamed
    // but byte-identical routine is outside it — which is the state "the entry
    // is gone" produces. Mocking the export was tried and does NOT work: the
    // function reads the list from its own module closure, so the mock passed
    // a control it never varied.
    const renamed = (map[key] ?? '').replaceAll(EXEMPT, 'zz_unexempt_fact_sync');
    expect(sha256(renamed), 'the rename did not change the subject (RULE-27)').not.toBe(sha256(map[key] ?? ''));
    const violations = checkInventoryWriterAuthority({ ...map, [key]: renamed }).violations;
    expect(
      violations.some((v) => v.includes('zz_unexempt_fact_sync')),
      `the same body outside the exception is NOT refused: ${violations.join(' | ') || '(no violation at all)'}`,
    ).toBe(true);
    // And the exception set audits itself: with no routine of that name on the
    // tree, the law reports the exception as having outlived its reason.
    expect(
      violations.some((v) => v.includes(EXEMPT) && v.includes('writes no truth table')),
      'the exception set did not report itself as unused when its routine was renamed away',
    ).toBe(true);
  });
});
