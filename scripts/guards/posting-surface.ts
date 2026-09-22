/**
 * Guard G-4 (P2-S3 §67, widened in P2-S4 §21) — NO routine capable of a
 * journal write may exist without the protections that make it safe.
 *
 * The failure mode this exists for is not someone writing a bad posting
 * primitive today. It is someone, later, editing a good one: deleting the
 * fingerprint recomputation to fix a flaky test, widening the EXECUTE grant
 * to unblock a batch job, dropping the outbox insert because a phase "does
 * not need events yet". Each of those leaves a primitive that still works,
 * still passes the happy-path tests, and is no longer the thing that was
 * reviewed.
 *
 * So the rule is stated as an implication, and both halves matter:
 *
 *   IF a routine writes the journal, THEN every protection must be present.
 *
 * The other half is about application code. The database can refuse a raw
 * INSERT because no runtime role holds journal DML — but a service that tries
 * is a service that believed it could, and that belief is the bug. The second
 * rule below catches it in the repository, before anyone runs it.
 */

import { stripComments } from './sql-schema';

/** The tables that hold posted financial truth. */
export const LEDGER_TABLES = ['journal_entries', 'journal_lines', 'accounting_source_bindings'] as const;

/**
 * The primitive P2-S3 built. It is no longer the only routine this guard
 * watches — see `journalWriters` below — but it is still the one whose absence
 * means the guard is watching nothing at all.
 */
export const POSTING_PRIMITIVE = 'accounting_post_entry';

/**
 * Tables that hold a source's own detail. Application code may not write them
 * either: they are inside the ledger perimeter, written only by the elevated
 * commands, and a service that tried would be a service that believed it
 * could.
 */
export const SOURCE_DETAIL_TABLES = [
  'accounting_manual_adjustments',
  'accounting_reversals',
  'accounting_opening_balances',
  'accounting_opening_balance_lines',
] as const;

/** The one runtime role that may execute it. */
export const POSTING_CALLER = 'daftar_app';

/**
 * Each protection, as a name and the evidence that it is present.
 *
 * The patterns read the migration text rather than a live database on
 * purpose: this guard has to fail in CI before anything is deployed, and a
 * check that needs a server is a check that does not run on a pull request.
 */
export interface Protection {
  readonly name: string;
  readonly why: string;
  readonly present: (schema: string) => boolean;
}

const has =
  (re: RegExp) =>
  (schema: string): boolean =>
    re.test(schema);

export const REQUIRED_PROTECTIONS: readonly Protection[] = [
  {
    name: 'assertion key registry',
    why: 'without a key table there is nothing to verify a signature against, and the verifier would have to trust the caller',
    present: has(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?accounting_assertion_keys\b/i),
  },
  {
    name: 'replay registry',
    why: 'without it a captured assertion could be presented again in a later transaction',
    present: has(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?accounting_assertion_uses\b/i),
  },
  {
    name: 'assertion verifier',
    why: 'the actor, tenant, business and source must come from a verified signature, never from a GUC or an argument',
    present: has(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+accounting_actor\b/i),
  },
  {
    name: 'HMAC verification',
    why: 'a parsed assertion that is never verified is a caller-supplied claim',
    present: has(/\bhmac\s*\(/i),
  },
  {
    name: 'canonical fingerprint recomputation',
    why: 'the signed fingerprint must be compared against one recomputed from the payload that actually arrived',
    present: (schema) => /accounting_fingerprint\s*\(/i.test(schema) && /accounting_canonical_line\s*\(/i.test(schema),
  },
  {
    name: 'payload mismatch refusal',
    why: 'recomputing a fingerprint and not refusing a mismatch protects nothing',
    present: has(/accounting\.assertion_payload_mismatch/),
  },
  {
    name: 'source binding insert',
    why: 'the binding registry is what makes one source identity resolve to exactly one entry',
    present: has(/INSERT\s+INTO\s+accounting_source_bindings\b/i),
  },
  {
    name: 'audit insert',
    why: 'a posting that leaves no audit row is a financial mutation nobody can account for',
    present: has(/INSERT\s+INTO\s+audit_events\b/i),
  },
  {
    name: 'outbox insert',
    why: 'downstream consumers must learn of a posting in the same transaction that made it',
    present: has(/INSERT\s+INTO\s+outbox_events\b/i),
  },
  {
    name: 'idempotency lock',
    why: 'two concurrent postings of one source must serialize, or the same fact posts twice',
    present: has(/pg_advisory_xact_lock\s*\(/i),
  },
  {
    name: 'security definer, owned by the unreachable principal',
    why: 'a primitive owned by a LOGIN role hands its authority to whoever holds that password',
    present: (schema) =>
      /SECURITY\s+DEFINER/i.test(schema) &&
      new RegExp(`ALTER\\s+FUNCTION\\s+${POSTING_PRIMITIVE}[^;]*OWNER\\s+TO\\s+daftar_accounting_internal`, 'i').test(schema),
  },
  {
    name: 'EXECUTE revoked from PUBLIC',
    why: 'a function nobody revokes is executable by everyone — that is the default, not a decision',
    present: has(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${POSTING_PRIMITIVE}[^;]*FROM\\s+PUBLIC`, 'i')),
  },
];

/**
 * ── Why this guard had to grow (P2-S4 §21) ───────────────────────────────
 *
 * P2-S3 named one function and checked it. That was honest while one function
 * could write the journal, and it stopped being honest the moment a second
 * one could: a rule keyed on a NAME protects a name, and the next writer
 * simply has a different one.
 *
 * P2-S4 added `accounting_post_reversal`, because a reversal must succeed
 * against an account that has since been deactivated and the frozen primitive
 * refuses one. So the rule is restated as a property of the CAPABILITY: any
 * routine whose body inserts into the journal is a writer, is discovered
 * here rather than listed, and carries every protection or fails CI.
 */
export interface RoutineDefinition {
  readonly name: string;
  /** Everything between `CREATE FUNCTION` and the body delimiter — the options. */
  readonly header: string;
  /** The routine's body, between its dollar-quote delimiters. */
  readonly body: string;
}

/**
 * Every routine a schema defines, with its options and its body.
 *
 * The body is delimited by the dollar quote that opens after the argument
 * list, and the search for it is bounded by the next `CREATE FUNCTION`, so a
 * routine declared with a string-literal body contributes nothing rather than
 * swallowing the next routine's text.
 */
export function routineDefinitions(schema: string): RoutineDefinition[] {
  const out: RoutineDefinition[] = [];
  const starts: { name: string; at: number }[] = [];
  for (const m of schema.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi)) {
    starts.push({ name: m[1] ?? '', at: m.index ?? 0 });
  }
  starts.forEach((start, i) => {
    const limit = starts[i + 1]?.at ?? schema.length;
    const window = schema.slice(start.at, limit);
    const open = /\$([A-Za-z_]*)\$/.exec(window);
    if (!open) return;
    const tag = open[0];
    const openAt = (open.index ?? 0) + tag.length;
    const closeAt = window.indexOf(tag, openAt);
    if (closeAt < 0) return;
    out.push({ name: start.name, header: window.slice(0, open.index ?? 0), body: window.slice(openAt, closeAt) });
  });
  return out;
}

/** Every routine whose body inserts into a table that holds posted financial truth. */
export function journalWriters(schema: string): RoutineDefinition[] {
  const writes = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?(?:journal_entries|journal_lines)\\b`, 'i');
  return routineDefinitions(schema).filter((r) => writes.test(r.body));
}

/**
 * What every journal writer must contain in its OWN body. These are not
 * schema-wide facts: a second writer that skipped the fingerprint comparison
 * would sit in a schema where the comparison exists and still write whatever
 * it was handed.
 */
export const WRITER_BODY_PROTECTIONS: readonly Protection[] = [
  {
    name: 'verified actor',
    why: 'the actor, tenant, business and source must come from a verified signature, never from a GUC or an argument',
    present: has(/accounting_actor\s*\(/i),
  },
  {
    name: 'fingerprint recomputation',
    why: 'a writer that does not recompute the digest of what it is about to write is writing whatever it was handed',
    present: has(/accounting_fingerprint\s*\(/i),
  },
  {
    name: 'payload mismatch refusal',
    why: 'recomputing a fingerprint and not refusing a mismatch protects nothing',
    present: has(/accounting\.assertion_payload_mismatch/),
  },
  {
    name: 'source binding insert',
    why: 'an entry that reaches COMMIT without a registered source identity is an entry nobody can trace to a business fact',
    present: has(/INSERT\s+INTO\s+accounting_source_bindings\b/i),
  },
  {
    name: 'audit insert',
    why: 'a posting that leaves no audit row is a financial mutation nobody can account for',
    present: has(/INSERT\s+INTO\s+audit_events\b/i),
  },
  {
    name: 'outbox insert',
    why: 'downstream consumers must learn of a posting in the same transaction that made it',
    present: has(/INSERT\s+INTO\s+outbox_events\b/i),
  },
  {
    name: 'idempotency lock',
    why: 'two concurrent commands for one source must serialize, or the same fact posts twice',
    present: has(/pg_advisory_xact_lock\s*\(/i),
  },
];

export interface PostingSurfaceSources {
  /** Every migration, concatenated, in order. */
  readonly schema: string;
  /** Application source files that are not tests: path → contents. */
  readonly appFiles: Readonly<Record<string, string>>;
}

/** Every `GRANT EXECUTE ... ON FUNCTION <name> ... TO <roles>` grantee. */
export function functionGrantees(schema: string, routine: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(schema).matchAll(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${routine}\\s*\\([^)]*\\)[^;]*?\\sTO\\s+([^;]+);`, 'gi'))) {
    for (const grantee of (m[1] ?? '').split(',')) {
      const name = grantee.trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/** Kept for the P2-S3 vocabulary; the primitive is one writer among the writers now. */
export function postingPrimitiveGrantees(schema: string): string[] {
  return functionGrantees(schema, POSTING_PRIMITIVE);
}

const LEDGER_DML = new RegExp(
  `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:public\\.)?(${[...LEDGER_TABLES, ...SOURCE_DETAIL_TABLES].join('|')})\\b`,
  'i',
);

/**
 * Returns one human-readable violation per broken rule. Empty means the
 * writer exists with every protection it needs, is reachable only by the one
 * runtime role that should reach it, and no application code tries to go
 * around it.
 */
export function findPostingSurfaceViolations(src: PostingSurfaceSources): string[] {
  const v: string[] = [];
  const schema = stripComments(src.schema);
  const writerExists = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${POSTING_PRIMITIVE}\\b`, 'i').test(schema);

  if (writerExists) {
    for (const protection of REQUIRED_PROTECTIONS) {
      if (!protection.present(schema)) {
        v.push(`${POSTING_PRIMITIVE} exists without its ${protection.name} — ${protection.why} (G-4)`);
      }
    }

    const grantees = postingPrimitiveGrantees(schema);
    if (grantees.length === 0) {
      v.push(`${POSTING_PRIMITIVE} exists and is granted to nobody — either it is dead code or the grant was lost (G-4)`);
    }
    for (const grantee of grantees) {
      if (grantee !== POSTING_CALLER) {
        v.push(
          `${POSTING_PRIMITIVE} is granted EXECUTE to ${grantee} — only ${POSTING_CALLER} may post, and platform administration is not financial authority (G-4)`,
        );
      }
    }

    // ── Every writer, not just the one with the familiar name (§21) ──────
    //
    // Discovered from the schema rather than listed, so a third writer added
    // by a future slice is covered the day it is written and not the day
    // somebody remembers to add its name here.
    for (const writer of journalWriters(schema)) {
      for (const protection of WRITER_BODY_PROTECTIONS) {
        if (!protection.present(writer.body)) {
          v.push(`${writer.name} writes the journal without its ${protection.name} — ${protection.why} (G-4)`);
        }
      }
      if (!/SECURITY\s+DEFINER/i.test(writer.header)) {
        v.push(`${writer.name} writes the journal without SECURITY DEFINER — it would need the CALLER to hold ledger DML, which no runtime role may (G-4)`);
      }
      if (!new RegExp(`ALTER\\s+FUNCTION\\s+${writer.name}\\s*\\([^)]*\\)[^;]*OWNER\\s+TO\\s+daftar_accounting_internal`, 'i').test(schema)) {
        v.push(
          `${writer.name} writes the journal but is not owned by daftar_accounting_internal — a writer owned by a LOGIN role hands its authority to whoever holds that password (G-4)`,
        );
      }
      if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${writer.name}\\s*\\([^)]*\\)[^;]*FROM\\s+PUBLIC`, 'i').test(schema)) {
        v.push(`${writer.name} writes the journal and is never revoked from PUBLIC — a function nobody revokes is executable by everyone (G-4)`);
      }
      const writerGrantees = functionGrantees(schema, writer.name);
      if (writerGrantees.length === 0) {
        v.push(`${writer.name} writes the journal and is granted to nobody — either it is dead code or the grant was lost (G-4)`);
      }
      for (const grantee of writerGrantees) {
        if (grantee !== POSTING_CALLER) {
          v.push(`${writer.name} is granted EXECUTE to ${grantee} — only ${POSTING_CALLER} may write the journal (G-4)`);
        }
      }
    }

    // No migration may hand a runtime role direct DML on the ledger. G-1 says
    // the same thing from the grant model's side; this says it from the
    // writer's side, so removing either one does not silently remove both.
    for (const m of schema.matchAll(/\bGRANT\s+([^;]+?)\s+ON\s+([^;]+?)\s+TO\s+([^;]+);/gi)) {
      const [, privText = '', objText = '', granteeText = ''] = m;
      if (/^\s*(FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|SEQUENCE)\b/i.test(objText)) continue;
      const tables = objText.split(',').map((t) => t.trim().replace(/^public\./i, ''));
      const perimeter = [...LEDGER_TABLES, ...SOURCE_DETAIL_TABLES] as readonly string[];
      if (!tables.some((t) => perimeter.includes(t))) continue;
      const privileges = privText.split(',').map((p) =>
        p
          .trim()
          .replace(/\s*\([^)]*\)\s*$/, '')
          .toUpperCase(),
      );
      if (!privileges.some((p) => ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(p) || p.startsWith('ALL'))) continue;
      for (const grantee of granteeText.split(',').map((g) => g.trim())) {
        if (grantee.startsWith('daftar_') && grantee !== 'daftar_accounting_internal') {
          v.push(`a migration grants ${grantee} direct DML inside the ledger perimeter — the only writers are the elevated accounting commands (G-4)`);
        }
      }
    }
  }

  // Application code may CALL the primitive and must never write the ledger
  // itself. The database would refuse it anyway; code that tries is code that
  // believed it could, and that belief is what this catches.
  for (const [path, source] of Object.entries(src.appFiles)) {
    const match = LEDGER_DML.exec(source);
    if (match) {
      v.push(`${path} issues \`${match[1]?.toUpperCase()} ${match[2]}\` — application code may only CALL the accounting commands (G-4)`);
    }
  }

  return v;
}
