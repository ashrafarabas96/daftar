/**
 * P4-S4 — DEPARTURE B, DOCUMENTED AS BEHAVIOUR RATHER THAN AS A SENTENCE.
 *
 * THIS SUITE DOES NOT ASSERT THAT THE GAP IS CORRECT. It records what the
 * accepted tree DOES today, so that the day the arm is extended this file goes
 * red and has to be rewritten by the person extending it — and nobody has to
 * rediscover the shape from the code.
 *
 * ── A MEASURED CORRECTION, READ THIS FIRST ───────────────────────────────
 *
 * Every CLAIM below is still true and still worth keeping. The CONCLUSION this
 * header used to draw from them was not, and it is corrected here rather than
 * deleted, because the wrong version is the one a reader would otherwise
 * re-derive.
 *
 * It used to say: "a method's posting account can still be changed after
 * customer payments exist, whereas the supplier side forbids it", and that the
 * remaining exposure was "a FUTURE payment could post to a different account
 * than past ones". MEASUREMENT SAYS OTHERWISE —
 * `tests/integration/p4s4-payment-method-posting-lock.test.ts` asks the real
 * `payment_method_update` command to move the account of a method that has
 * taken a customer payment AND NO SUPPLIER PAYMENT, and the database refuses
 * it. The posting account cannot drift on the customer side either.
 *
 * The reason is the third claim of this very file: each settlement row reaches
 * the method through a THREE-COLUMN FK naming the method AND the account. That
 * edge is not merely a per-row pin — it is the lock. Moving
 * `payment_methods.posting_account_id` dissolves the parent tuple
 * `(business, id, old account)` that a live child depends on, so the parent
 * UPDATE is refused, on the customer side (`payments_method_fk`) exactly as on
 * the supplier side (`supplier_payments_method_fk`). The trigger arm is not
 * what makes the account un-driftable on EITHER side.
 *
 * SO WHAT IS DEPARTURE B, REALLY? A DIAGNOSTICS DIFFERENCE. On the supplier
 * side the BEFORE trigger reaches the arm first and a merchant reads
 * `payment_method.posting_account_locked`; on the customer side the arm passes
 * and the edge answers with a raw `foreign_key_violation`. Both refuse. Only
 * the sentence differs — and that is why the §23 item asking for the lock was
 * answered with a proof rather than with a build.
 *
 * ── WHY NO SLICE HAS EXTENDED THE ARM ────────────────────────────────────
 *
 * Extending the arm means replacing a PHASE 3 routine BODY and re-recording
 * its SHA-256 inside `supplier_settlement_guard_gaps()` with the probe ritual:
 * re-create the discovery in the same migration with the one digest changed,
 * then prove the replacement with a rolled-back probe that neuters the body and
 * requires the discovery to name it. That is cross-phase surface and the Tech
 * Lead has not ruled, so the routine is left untouched and the difference is
 * DISCLOSED. The fourth claim below measures the cost of the ritual directly:
 * the digest is pinned in more than one accepted migration, and every pin
 * carries the same value. Paying that cost would buy a better REFUSAL MESSAGE
 * and no additional integrity, which is why it has not been prioritised over a
 * structural gap — and the corrective migration `0082` says so in its R-97
 * rather than quietly extending a frozen body.
 *
 * ── WHAT GOES RED WHEN THE ARM IS EXTENDED ───────────────────────────────
 *
 * `lockSubjects` reads the relations the lock arm consults out of the accepted
 * text. The day a migration extends the arm to a customer-side relation, the
 * first claim fails with the new relation named, and the digest claim fails
 * because the body was replaced. Both are the intended signal: this file is
 * then updated to record the EXTENDED behaviour and the probe evidence, and so
 * is the last `it` of
 * `tests/integration/p4s4-payment-method-posting-lock.test.ts`, which records
 * the refusal a merchant currently reads.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`: the last claim plants
 * exactly that change on a COPY of the accepted text and requires the reader to
 * name it, so this suite is not a test that passes because it looks at nothing.
 * The real migration directory is never touched — editing an applied migration
 * breaks every suite with "Migration tampered after apply".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_RELATIONS } from '../../scripts/phase4-s4-gate';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');

/** The guarded routine and the refusal its account lock raises — the two names this documentation is about. */
const ROUTINE = 'payment_method_guard()';
const REFUSAL = 'payment_method.posting_account_locked';

/** Every migration on disk, oldest first, as `[name, text]`. Discovered, so no file name is written down here. */
function migrations(): [string, string][] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => [f, readFileSync(join(MIGRATIONS, f), 'utf8')]);
}

/** The text of the migration that defines the routine, and its name. The routine is defined once, in the accepted prefix. */
function definingMigration(): [string, string] {
  const hits = migrations().filter(([, sql]) => new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+payment_method_guard\s*\(`).test(sql));
  expect(hits.length, `${ROUTINE} is defined in ${hits.length} migration(s) — this documentation reads the one accepted body`).toBe(1);
  return hits[0] as [string, string];
}

/** The body of `payment_method_guard()`: everything between its `AS $$` and the `$$;` that closes it. */
function guardBody(sql: string): string {
  const start = new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+payment_method_guard\s*\(\)[\s\S]*?AS \$\$`).exec(sql);
  expect(start, `${ROUTINE} has no readable body`).not.toBeNull();
  const from = (start?.index ?? 0) + (start?.[0].length ?? 0);
  const end = sql.indexOf('$$;', from);
  expect(end, `${ROUTINE}'s body is not terminated`).toBeGreaterThan(from);
  return sql.slice(from, end);
}

/**
 * THE READER. The relations the posting-account lock arm consults, in one
 * routine body: the `EXISTS (SELECT … FROM <relation> …)` subqueries of the
 * `IF` whose `RAISE` is the account-lock refusal. Sorted, de-duplicated.
 *
 * It reads the ARM and not the whole body on purpose. The body consults other
 * relations for other reasons (the account's eligibility, the method's own
 * revision), and a reader that swept the whole routine would call the gap
 * closed as soon as any customer-side relation was mentioned anywhere.
 */
export function lockSubjects(body: string): string[] {
  const arm = new RegExp(String.raw`IF\s+NEW\.posting_account_id[\s\S]*?${REFUSAL.replace('.', '\\.')}`).exec(body);
  expect(arm, `no IF arm of ${ROUTINE} raises ${REFUSAL}`).not.toBeNull();
  const text = arm?.[0] ?? '';
  // Anchored on `EXISTS (SELECT 1 FROM …`, the shape the arm is written in:
  // a bare `FROM\s+(\w+)` would also match the `IS DISTINCT FROM OLD` of the
  // immutability comparison two lines above and report `old` as a relation.
  return [...new Set([...text.matchAll(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)].map((m) => (m[1] ?? '').toLowerCase()))].sort();
}

/** The SHA-256 the guard-gaps discovery pins for the routine, in every migration that pins it. */
function recordedDigests(): { file: string; digest: string }[] {
  const out: { file: string; digest: string }[] = [];
  for (const [file, sql] of migrations())
    for (const m of sql.matchAll(new RegExp(String.raw`"${ROUTINE.replace('(', '\\(').replace(')', '\\)')}"\s*:\s*"([0-9a-f]{64})"`, 'g')))
      out.push({ file, digest: m[1] as string });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────

describe('Departure B — the posting-account lock is supplier-side only (CURRENT behaviour, not an endorsement)', () => {
  it('the account lock consults the supplier settlement relations and NOT this slice’s customer relations', () => {
    const [, sql] = definingMigration();
    const subjects = lockSubjects(guardBody(sql));

    // The arm has subjects at all: a reader that found none would make every
    // claim below vacuously true.
    expect(subjects.length).toBeGreaterThan(0);

    // CURRENT BEHAVIOUR. Every relation the lock consults is a supplier-side
    // settlement relation, and the consequence is the disclosed gap: a
    // payment method's posting account is still mutable while CUSTOMER
    // payments reference it, whereas the supplier side forbids it.
    expect(subjects).toEqual(['supplier_payments', 'supplier_refunds']);

    // Stated the other way round too, against the four relations this slice
    // adds, so the claim survives a rename of either side.
    for (const relation of CONTRACT_RELATIONS)
      expect(
        subjects,
        `${relation} is consulted by the account lock — Departure B has been CLOSED and this file must now record the closed behaviour`,
      ).not.toContain(relation);
  });

  it('no other migration on disk closes the gap behind this suite’s back', () => {
    // Including every CANDIDATE: the day a candidate extends the arm, this is
    // the claim that says so, and the claim above says which relation.
    for (const [file, sql] of migrations()) {
      if (!sql.includes(REFUSAL)) continue;
      const bodies = [...sql.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1] ?? '').filter((b) => b.includes(REFUSAL));
      for (const body of bodies)
        for (const relation of CONTRACT_RELATIONS)
          expect(
            new RegExp(String.raw`EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:public\.)?${relation}\b`, 'i').test(body),
            `${file} locks the posting account on ${relation} — Departure B is closed and this documentation is out of date`,
          ).toBe(false);
    }
  });

  it('and this is WHY only the message is missing: every settlement relation reaches the method through a composite FK naming method AND account', () => {
    // THE MECHANISM THAT ACTUALLY LOCKS THE ACCOUNT, on both sides. Every
    // accepted settlement relation reaches the method through a composite FK
    // that names the method AND the account, so moving
    // `payment_methods.posting_account_id` dissolves a parent tuple a live
    // child depends on and the parent UPDATE is refused — no existing row is
    // rewritten, no posted entry is retroactively changed, and no FUTURE
    // payment posts anywhere else either. The behavioural half of this claim
    // is measured against the real command in
    // `tests/integration/p4s4-payment-method-posting-lock.test.ts`; what is
    // asserted here is the shape it rests on.
    const [, sql] = definingMigration();
    const pinned = [...sql.matchAll(/FOREIGN KEY\s*\(([^)]*posting_account_id[^)]*)\)\s*REFERENCES\s+(?:public\.)?payment_methods\s*\(([^)]*)\)/gi)];
    expect(pinned.length, 'no accepted relation pins its payment method AND its posting account in one composite FK').toBeGreaterThan(0);
    for (const fk of pinned) {
      expect((fk[1] ?? '').toLowerCase()).toContain('payment_method_id');
      expect((fk[2] ?? '').toLowerCase()).toContain('posting_account_id');
    }
  });

  it('the cross-phase cost is real: the routine’s body is digest-pinned, identically, in more than one accepted migration', () => {
    const pins = recordedDigests();
    // More than one pin is the ritual's cost: closing the gap means replacing
    // the body AND re-recording the digest in a new discovery, with a
    // rolled-back probe proving the replacement.
    expect(pins.length).toBeGreaterThan(1);
    const distinct = [...new Set(pins.map((p) => p.digest))];
    expect(
      distinct.length,
      `the pinned digest of ${ROUTINE} differs between ${pins.map((p) => p.file).join(', ')} — the body was replaced and the probe ritual is owed`,
    ).toBe(1);
  });
});

describe('RP-S4-DEP-B — the documentation is not vacuous', () => {
  it('red: the lock arm extended to this slice’s payment relation on a COPY of the accepted text is named', () => {
    const [, sql] = definingMigration();
    const relation = CONTRACT_RELATIONS[0] as string;
    const body = guardBody(sql);
    const closed = body.replace(
      /OR EXISTS \(SELECT 1 FROM supplier_refunds/,
      `OR EXISTS (SELECT 1 FROM ${relation} p WHERE p.business_id = OLD.business_id AND p.payment_method_id = OLD.id)\n          OR EXISTS (SELECT 1 FROM supplier_refunds`,
    );
    expect(closed === body, 'the plant changed nothing, so this proof would prove nothing').toBe(false);

    // The reader names the new subject, which is exactly what makes the first
    // claim of this file go red the day Departure B is closed.
    const subjects = lockSubjects(closed);
    expect(subjects).toContain(relation);
    expect(subjects).not.toEqual(['supplier_payments', 'supplier_refunds']);

    // And the real tree is unchanged: the plant was applied to a string.
    expect(lockSubjects(guardBody(sql))).toEqual(['supplier_payments', 'supplier_refunds']);
  });

  it('red: a body whose account-lock arm has been removed altogether is named rather than read as silence', () => {
    const [, sql] = definingMigration();
    const body = guardBody(sql);
    const gone = body.split(REFUSAL).join('payment_method.something_else');
    expect(gone === body).toBe(false);
    expect(() => lockSubjects(gone)).toThrow();
  });
});
