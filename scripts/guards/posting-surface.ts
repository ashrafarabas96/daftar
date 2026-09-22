/**
 * Guard G-4 (P2-S3, directive §67) — a writer may not exist without the
 * protections that make it safe.
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

/** The primitive that is allowed to write them. */
export const POSTING_PRIMITIVE = 'accounting_post_entry';

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

export interface PostingSurfaceSources {
  /** Every migration, concatenated, in order. */
  readonly schema: string;
  /** Application source files that are not tests: path → contents. */
  readonly appFiles: Readonly<Record<string, string>>;
}

/** Every `GRANT EXECUTE ... ON FUNCTION accounting_post_entry ... TO <roles>` grantee. */
export function postingPrimitiveGrantees(schema: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(schema).matchAll(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${POSTING_PRIMITIVE}[^;]*?\\sTO\\s+([^;]+);`, 'gi'))) {
    for (const grantee of (m[1] ?? '').split(',')) {
      const name = grantee.trim();
      if (name) out.push(name);
    }
  }
  return out;
}

const LEDGER_DML = new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:public\\.)?(${LEDGER_TABLES.join('|')})\\b`, 'i');

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

    // No migration may hand a runtime role direct DML on the ledger. G-1 says
    // the same thing from the grant model's side; this says it from the
    // writer's side, so removing either one does not silently remove both.
    for (const m of schema.matchAll(/\bGRANT\s+([^;]+?)\s+ON\s+([^;]+?)\s+TO\s+([^;]+);/gi)) {
      const [, privText = '', objText = '', granteeText = ''] = m;
      if (/^\s*(FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|SEQUENCE)\b/i.test(objText)) continue;
      const tables = objText.split(',').map((t) => t.trim().replace(/^public\./i, ''));
      if (!tables.some((t) => (LEDGER_TABLES as readonly string[]).includes(t))) continue;
      const privileges = privText.split(',').map((p) =>
        p
          .trim()
          .replace(/\s*\([^)]*\)\s*$/, '')
          .toUpperCase(),
      );
      if (!privileges.some((p) => ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(p) || p.startsWith('ALL'))) continue;
      for (const grantee of granteeText.split(',').map((g) => g.trim())) {
        if (grantee.startsWith('daftar_') && grantee !== 'daftar_accounting_internal') {
          v.push(`a migration grants ${grantee} direct DML on the ledger — the only writer is ${POSTING_PRIMITIVE} (G-4)`);
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
      v.push(`${path} issues \`${match[1]?.toUpperCase()} ${match[2]}\` — application code may only CALL ${POSTING_PRIMITIVE} (G-4)`);
    }
  }

  return v;
}
