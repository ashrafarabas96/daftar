/**
 * THE TARGET PLAN-EVIDENCE CONTRACT.
 *
 * A plan-shape claim made on a different server major or a different
 * collation is not automatically a claim about deployment. P4-S3 proved that
 * at cost: the POS barcode arms asserted a `>= / <` index range, were green
 * locally for months, and went red the first time CI ever executed the gate.
 *
 * The mechanism, measured on PostgreSQL 16.13 (see the audit report):
 * PostgreSQL derives a prefix range from `^@` only when the index's collation
 * is BYTE ORDER, and it recognises exactly `C` and `POSIX`. It does not
 * recognise `C.utf8`, and it does not recognise `en_US.utf8`. The local
 * embedded cluster is initdb'd at the bare `C` locale; the deployment target
 * is not. So the local green was a true statement about a collation the
 * product does not deploy on.
 *
 *     datcollate   | `^@` over a default-collation index
 *     -------------|------------------------------------
 *     C            | Index Cond: barcode >= 'x' AND barcode < 'y'
 *     POSIX        | Index Cond: barcode >= 'x' AND barcode < 'y'
 *     C.utf8       | Seq Scan, Filter: barcode ^@ 'x'
 *     en_US.utf8   | Seq Scan, Filter: barcode ^@ 'x'
 *
 * THE LOAD-BEARING PROPERTY IS "NOT BYTE ORDER", NOT A LITERAL STRING.
 * PostgreSQL stores `datcollate` exactly as it was given and normalises
 * nothing — measured on one 16.13 cluster, three databases created from the
 * same template with three spellings of locale:
 *
 *     CREATE DATABASE … LOCALE 'en_US.utf8'   -> datcollate = en_US.utf8
 *     CREATE DATABASE … LOCALE 'en_US.UTF-8'  -> datcollate = en_US.UTF-8
 *     CREATE DATABASE … LOCALE 'C.utf8'       -> datcollate = C.utf8
 *
 * The official `postgres:16` image sets `LANG=en_US.utf8` and lets initdb
 * inherit it, so the service CI runs against reports the lower-case,
 * no-dash spelling. A contract that string-matched `en_US.UTF-8` would
 * therefore reject the very environment it exists to describe. So this
 * module gates on the PROPERTY and RECORDS the spelling.
 */

/** Everything an authoritative plan-evidence run must record. */
export interface PlanEvidenceEnvironment {
  readonly serverVersion: string;
  readonly serverVersionNum: number;
  readonly serverMajor: number;
  readonly datname: string;
  readonly datcollate: string;
  readonly datctype: string;
  /** `c` (libc), `i` (ICU), `b` (builtin, PG17+). Null before PG15. */
  readonly localeProvider: string | null;
  readonly icuLocale: string | null;
  readonly encoding: string;
  /** `C` / `POSIX`: the only two spellings PostgreSQL treats as byte order. */
  readonly collationIsByteOrder: boolean;
}

/**
 * The deployment-evidence contract, as the Tech Lead stated it.
 *
 * `major` is 16 because that is what `.github/workflows/ci.yml` runs
 * (`image: postgres:16`) and what the product deploys on.
 *
 * `collationIsByteOrder: false` is the deployment-equivalent collation
 * requirement, expressed as the property rather than the spelling, for the
 * reason set out above.
 */
export const TARGET_PLAN_EVIDENCE_CONTRACT = {
  major: 16,
  collationIsByteOrder: false,
  reference: 'postgres:16 service in .github/workflows/ci.yml, LANG=en_US.utf8',
} as const;

/** The two spellings — and the only two — that PostgreSQL treats as byte order. */
export const BYTE_ORDER_COLLATIONS: readonly string[] = ['C', 'POSIX'];

export const isByteOrderCollation = (datcollate: string): boolean => BYTE_ORDER_COLLATIONS.includes(datcollate);

type Query = <R>(sql: string) => Promise<{ rows: R[] }>;

/**
 * Measure the environment. Nothing here is remembered or assumed: every
 * field is read out of the server that is about to be EXPLAINed.
 *
 * `daticulocale` only exists from PostgreSQL 15, and was renamed in 17, so it
 * is read defensively — a missing column must degrade to `null`, never fail
 * the measurement.
 */
export async function readPlanEvidenceEnvironment(q: Query): Promise<PlanEvidenceEnvironment> {
  const base = await q<{
    sv: string;
    svn: string;
    datname: string;
    datcollate: string;
    datctype: string;
    provider: string | null;
    encoding: string;
  }>(
    `SELECT current_setting('server_version')      AS sv,
            current_setting('server_version_num')  AS svn,
            d.datname,
            d.datcollate,
            d.datctype,
            CASE WHEN current_setting('server_version_num')::int >= 150000
                 THEN d.datlocprovider::text ELSE NULL END AS provider,
            pg_encoding_to_char(d.encoding)        AS encoding
       FROM pg_database d
      WHERE d.datname = current_database()`,
  );
  const r = base.rows[0];
  if (r === undefined) throw new Error('plan-evidence: current_database() has no pg_database row');

  let icuLocale: string | null = null;
  for (const col of ['datlocale', 'daticulocale']) {
    try {
      const got = await q<{ v: string | null }>(`SELECT ${col} AS v FROM pg_database WHERE datname = current_database()`);
      icuLocale = got.rows[0]?.v ?? null;
      break;
    } catch {
      // The column does not exist on this major. Try the other spelling.
    }
  }

  const serverVersionNum = Number.parseInt(r.svn, 10);
  return {
    serverVersion: r.sv,
    serverVersionNum,
    serverMajor: Math.floor(serverVersionNum / 10000),
    datname: r.datname,
    datcollate: r.datcollate,
    datctype: r.datctype,
    localeProvider: r.provider,
    icuLocale,
    encoding: r.encoding,
    collationIsByteOrder: isByteOrderCollation(r.datcollate),
  };
}

export interface PlanEvidenceVerdict {
  readonly authoritative: boolean;
  /** Why not, when not. Empty when the run IS target evidence. */
  readonly reasons: readonly string[];
}

/**
 * Is this run authoritative DEPLOYMENT plan evidence, or merely functional
 * local evidence?
 *
 * This function never throws and never skips. A non-target environment is a
 * perfectly good place to check correctness, SQL validity, RLS answer
 * equivalence and concurrency — it is only the word "authoritative" it may
 * not have. Making the distinction explicit is the whole point; deleting,
 * lowering or skipping the claim is not an option this module offers.
 */
export function classifyPlanEvidence(env: PlanEvidenceEnvironment): PlanEvidenceVerdict {
  const reasons: string[] = [];
  if (env.serverMajor !== TARGET_PLAN_EVIDENCE_CONTRACT.major) {
    reasons.push(
      `server major ${env.serverMajor} is not the deployment target ${TARGET_PLAN_EVIDENCE_CONTRACT.major} (server_version_num=${env.serverVersionNum})`,
    );
  }
  if (env.collationIsByteOrder !== TARGET_PLAN_EVIDENCE_CONTRACT.collationIsByteOrder) {
    reasons.push(`datcollate=${env.datcollate} is byte order; the deployment target is not, and a prefix range derived here is not derivable there`);
  }
  return { authoritative: reasons.length === 0, reasons };
}

/** One authoritative plan-evidence record, as the contract requires it. */
export interface PlanEvidenceRecord {
  readonly environment: PlanEvidenceEnvironment;
  readonly verdict: PlanEvidenceVerdict;
  /** The exact statement EXPLAINed, verbatim. */
  readonly query: string;
  /** Which dataset the measurement was taken on (e.g. 'tier-1', 'acceptance'). */
  readonly datasetTier: string;
  /** Whether the relations were ANALYZEd, and when. A plan over missing
   *  statistics is a plan about the missing statistics. */
  readonly analyzeState: string;
  readonly plan?: unknown;
  readonly measuredAt: string;
}

export function planEvidenceRecord(input: Omit<PlanEvidenceRecord, 'verdict' | 'measuredAt'>): PlanEvidenceRecord {
  return {
    ...input,
    verdict: classifyPlanEvidence(input.environment),
    measuredAt: new Date().toISOString(),
  };
}

/** A one-line banner for a suite to print, so a log says what it proved. */
export function planEvidenceBanner(env: PlanEvidenceEnvironment): string {
  const v = classifyPlanEvidence(env);
  const label = v.authoritative ? 'AUTHORITATIVE TARGET PLAN EVIDENCE' : 'LOCAL FUNCTIONAL EVIDENCE ONLY (not deployment plan evidence)';
  return `[plan-evidence] ${label} | server_version_num=${env.serverVersionNum} datcollate=${env.datcollate} datctype=${env.datctype} provider=${env.localeProvider ?? 'n/a'} byteOrder=${env.collationIsByteOrder}${v.authoritative ? '' : ` | ${v.reasons.join('; ')}`}`;
}
