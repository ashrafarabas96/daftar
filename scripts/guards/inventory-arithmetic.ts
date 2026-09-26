/**
 * Rule 21 — inventory arithmetic (P3-S2, contract §7.2; P3-AL-06, P3-AL-08,
 * P3-AL-49 §B–§C).
 *
 * The exactness law has a handful of shapes that are wrong wherever they
 * appear, and each one is a single token a reviewer can miss:
 *
 * - `on_hand × avg` reconstructs valuation from the rounded average. P3-AL-49
 *   §B forbids it absolutely: valuation is Σ stored integers, never a product
 *   with a rounded quotient (CTRL-FLUSH is the counterexample: 0 ≠ 1).
 * - `round(` in SQL is PostgreSQL's HALF_UP; the one rounding is HALF_EVEN
 *   through `inventory_half_even` (P3-AL-08). `scale(` tests the declared
 *   scale, not the value — the withdrawn precision rule (P3-AL-05).
 * - `ORDER BY … created_at` over movements or deficits: the ledger is ordered
 *   by `stock_seq` / `deficit_seq` only; two rows in one transaction share a
 *   timestamp (P3-AL-06, L:1231).
 * - `40P01` / `deadlock_detected` handling: the lock order is fixed
 *   (P3-AL-07), so a deadlock is a defect to fix, not a retry to hide.
 * - `Math.round`, `toFixed`, `parseFloat`, `Number(` in the arithmetic
 *   package: binary floating point never touches a quantity, cost or value.
 *
 * Scope: `packages/inventory/src`, every migration whose file name contains
 * `inventory`, and (for the deadlock rule) `apps/api/src/modules/inventory`.
 * Comments are stripped first, so a comment may name the anti-pattern it
 * documents; string literals are not, so a routine cannot smuggle one in a
 * string either.
 */
import { stripComments } from './sql-schema';

export interface InventoryArithmeticSources {
  /** Migration file path → contents (every file; only `*inventory*` names are read). */
  readonly migrations: Readonly<Record<string, string>>;
  /** `packages/inventory/src` file path → contents. */
  readonly packageFiles: Readonly<Record<string, string>>;
  /** `apps/api/src/modules/inventory` file path → contents. */
  readonly apiInventoryFiles: Readonly<Record<string, string>>;
}

export interface InventoryArithmeticFinding {
  readonly file: string;
  readonly rule: string;
  readonly evidence: string;
}

/**
 * The contract's pattern (`\bon_?hand\w*\s*\*\s*\w*avg|\bavg\w*\s*\*\s*\w*on_?hand|onHand\s*\*\s*\w*avg|avg\w*\s*\*\s*onHand`,
 * case-insensitive), widened so that a prefixed or qualified operand —
 * `v_avg * v_on_hand`, `s.onHand * state.avg` — cannot slip past a word
 * boundary. Every string the contract's pattern matches, this one matches.
 */
export const ON_HAND_TIMES_AVG = /on_?hand\w*\s*\*\s*[\w.]*avg|avg\w*\s*\*\s*[\w.]*on_?hand/i;
export const SQL_ROUND = /\bround\s*\(/i;
export const SQL_SCALE = /\bscale\s*\(/i;
export const CREATED_AT_ORDER = /ORDER\s+BY[^;]*\bcreated_at\b/i;
export const LEDGER_TABLES = /\b(stock_movements|negative_inventory_deficits)\b/i;
export const DEADLOCK_HANDLING = /40P01|deadlock_detected/i;
export const FLOAT_ARITHMETIC = /Math\.round|toFixed|parseFloat|Number\(/;

/**
 * ── Hardened after the independent security review (L-2) ─────────────────
 *
 * The patterns above stay exactly as the contract wrote them; these catch
 * the same forbidden use behind a cast, a quote or a parenthesis, and report
 * under the same rule names (plus `no-sql-float`, which had no SQL half).
 *
 * - `"round"(x)`, `(round)(x)`: the same HALF_UP function, spelled so that
 *   `round(` never appears. Likewise `scale`.
 * - `x::numeric(18,4)`, `CAST(x AS numeric(28,10))`: a cast to a NUMERIC
 *   type modifier rounds HALF_UP exactly as `round()` does.
 * - `::float8`, `::real`, `CAST(… AS double precision)`, `float8(x)`, a
 *   float-typed variable, argument, result or literal: binary floating point
 *   in inventory SQL. `float4`, `float8` and `double precision` are refused
 *   wherever they appear; `real` and `float`, which are also English words,
 *   wherever they are used as a type.
 * - In the package: `Math['round']`, `Math?.round`, `Math . round`, a bare
 *   `Math` (an alias or a destructuring), `Number (x)`, `(Number)(x)`, any
 *   `Number` other than its `is…` predicates, and `toFixed` / `parseFloat`
 *   however they are reached.
 */
const SQL_FLOAT_TYPE = String.raw`(?:"?pg_catalog"?\s*\.\s*)?"?(?:float4|float8|float|real|double\s+precision)"?\b`;
const SQL_NUMERIC_TYPMOD = String.raw`(?:"?pg_catalog"?\s*\.\s*)?"?(?:numeric|decimal)"?\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)`;
export const SQL_ROUND_EVASIVE = new RegExp(
  String.raw`"round"\s*\(|\(\s*(?:"?pg_catalog"?\s*\.\s*)?"?round"?\s*\)\s*\(|(?:::|\bAS)\s*${SQL_NUMERIC_TYPMOD}`,
  'i',
);
export const SQL_SCALE_EVASIVE = /"scale"\s*\(|\(\s*(?:"?pg_catalog"?\s*\.\s*)?"?scale"?\s*\)\s*\(/i;
export const SQL_FLOAT = new RegExp(
  [
    String.raw`\b(?:float4|float8|double\s+precision)\b`,
    String.raw`::\s*${SQL_FLOAT_TYPE}`,
    String.raw`\bAS\s+${SQL_FLOAT_TYPE}`,
    String.raw`\bRETURNS\s+(?:SETOF\s+)?${SQL_FLOAT_TYPE}`,
    String.raw`\b(?:real|float)\s+'`,
    String.raw`\b[A-Za-z_][\w$]*\s+(?:CONSTANT\s+)?"?(?:real|float)"?\s*(?:\(\s*\d+\s*\)\s*)?(?:;|:=|=|,|\)|\[|\bDEFAULT\b|\bNOT\b)`,
  ].join('|'),
  'i',
);
export const FLOAT_ARITHMETIC_EVASIVE =
  /\bMath\b\s*(?:\?\.|\.)\s*round\b|\bMath\b\s*\[|\bMath\b(?!\s*(?:\?\.|\.|\[))|\bNumber\b(?!\s*\??\.\s*is(?:Integer|SafeInteger|NaN|Finite)\b)|\btoFixed\b|\bparseFloat\b/;

export function isInventoryMigration(path: string): boolean {
  return /inventory/i.test(path.split('/').pop() ?? path);
}

/**
 * TypeScript without its comments: block comments, and `//` comments that
 * start a line or follow whitespace or punctuation (so `https://…` in a
 * string survives). Deliberately simple: when in doubt it keeps text, which
 * can only make the rule stricter.
 */
export function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[\s;,(){}])\/\/.*$/, '$1'))
    .join('\n');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Every match of every pattern, reported once per position: a spelling both
 * the contract pattern and its hardened twin match is one finding, not two.
 */
function scan(file: string, text: string, rule: string, re: RegExp | readonly RegExp[], out: InventoryArithmeticFinding[]): void {
  const seen = new Set<number>();
  for (const one of Array.isArray(re) ? re : [re]) {
    const global = new RegExp(one.source, one.flags.includes('g') ? one.flags : `${one.flags}g`);
    for (const m of text.matchAll(global)) {
      const at = m.index ?? 0;
      if (seen.has(at)) continue;
      seen.add(at);
      out.push({ file, rule, evidence: `line ${lineOf(text, at)}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}` });
    }
  }
}

export function findInventoryArithmeticViolations(src: InventoryArithmeticSources): InventoryArithmeticFinding[] {
  const out: InventoryArithmeticFinding[] = [];

  for (const [path, raw] of Object.entries(src.migrations).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isInventoryMigration(path)) continue;
    const sql = stripComments(raw);
    scan(path, sql, 'no-on-hand-times-avg', ON_HAND_TIMES_AVG, out);
    scan(path, sql, 'no-sql-round', [SQL_ROUND, SQL_ROUND_EVASIVE], out);
    scan(path, sql, 'no-sql-scale', [SQL_SCALE, SQL_SCALE_EVASIVE], out);
    scan(path, sql, 'no-sql-float', SQL_FLOAT, out);
    scan(path, sql, 'no-deadlock-handling', DEADLOCK_HANDLING, out);
    // One statement at a time: a created_at ordering is wrong only where the
    // statement reads the ledger or the deficits.
    let offset = 0;
    for (const statement of sql.split(';')) {
      if (LEDGER_TABLES.test(statement)) {
        const m = CREATED_AT_ORDER.exec(statement);
        if (m) {
          out.push({
            file: path,
            rule: 'no-created-at-ordering',
            evidence: `line ${lineOf(sql, offset + m.index)}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`,
          });
        }
      }
      offset += statement.length + 1;
    }
  }

  for (const [path, raw] of Object.entries(src.packageFiles).sort(([a], [b]) => a.localeCompare(b))) {
    const ts = stripTsComments(raw);
    scan(path, ts, 'no-on-hand-times-avg', ON_HAND_TIMES_AVG, out);
    scan(path, ts, 'no-float-arithmetic', [FLOAT_ARITHMETIC, FLOAT_ARITHMETIC_EVASIVE], out);
  }

  for (const [path, raw] of Object.entries(src.apiInventoryFiles).sort(([a], [b]) => a.localeCompare(b))) {
    scan(path, stripTsComments(raw), 'no-deadlock-handling', DEADLOCK_HANDLING, out);
  }

  return out;
}

/** Why each rule exists, for the failure message. */
export const INVENTORY_ARITHMETIC_WHY: Readonly<Record<string, string>> = {
  'no-on-hand-times-avg': 'valuation is Σ stored integers, never on_hand × a rounded average (P3-AL-49 §B)',
  'no-sql-round': "PostgreSQL's round() is HALF_UP — the one rounding is inventory_half_even (P3-AL-08)",
  'no-sql-scale': 'scale() tests the declared scale, not the value — the withdrawn precision rule (P3-AL-05)',
  'no-created-at-ordering': 'the ledger is ordered by stock_seq / deficit_seq, never created_at (P3-AL-06)',
  'no-deadlock-handling': 'the lock order is fixed, so a deadlock is a defect, not a retry (P3-AL-07)',
  'no-float-arithmetic': 'binary floating point never touches a quantity, cost or value (P3-AL-08)',
  'no-sql-float': 'binary floating point never touches a quantity, cost or value — in inventory SQL either, cast or declared (P3-AL-08)',
};
