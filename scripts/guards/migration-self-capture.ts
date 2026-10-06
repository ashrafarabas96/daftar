/**
 * GUARD G-7 — a migration that verifies itself across its own DDL must not be
 * able to forge the comparison.
 *
 * A migration can state "I changed exactly what I named" by capturing the
 * state before its first statement and comparing it whole afterwards. Inside
 * one migration the only carrier available is a transaction-local GUC: the
 * runner applies each file in its own transaction
 * (`apps/api/src/infra/migrate.ts:104-113`) and G-5 forbids a migration
 * creating a relation to hold it.
 *
 * **A GUC the same file can write is a comparison the same file can forge.**
 * Measured, 6 runs of 6, on a scratch database built to the predecessor: a
 * widening `ALTER POLICY … USING (true)` planted into the file applies GREEN
 * as soon as ONE extra `set_config` of the capture GUC is placed beside it,
 * because the final block only asked whether the GUC was non-empty. The same
 * widening without that one statement is refused outright. So the runtime law
 * cannot protect itself, and the protection has to be a property of the FILE,
 * checked before any server exists: the capture is taken ONCE, before the
 * first statement it is a capture of, and read only after the last one.
 *
 * This is the text half. The runtime half is the migration's own comparison.
 */

/** The GUC names this rule governs: a capture a migration takes of its own pre-state. */
const CAPTURE_GUC = /'(app\.[a-z0-9_]*(?:snapshot|capture)[a-z0-9_]*)'/g;

/** The statements a capture of a policy set is a capture OF. */
const VERIFIED_DDL = /\b(?:ALTER|CREATE|DROP)\s+POLICY\b/gi;

export interface SelfCaptureInput {
  /** Every migration file, keyed by repository-relative path. */
  readonly migrations: Readonly<Record<string, string>>;
}

/**
 * The file with every comment blanked out, OFFSETS PRESERVED. A rule about
 * where a statement sits relative to another must read code and not prose:
 * this file's own comments say `ALTER POLICY` while explaining what the rule
 * is for, and reading them as statements put the first `ALTER` hundreds of
 * bytes before the capture that precedes every real one. Comment characters
 * are replaced by spaces rather than removed so every offset still names the
 * same byte of the original.
 */
export const codeOnly = (text: string): string => {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank);
};

const offsets = (text: string, re: RegExp): number[] => {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) out.push(m.index ?? 0);
  return out;
};

/**
 * Every violation of G-7, as a sentence naming the file, the GUC and what is
 * wrong. An empty result is only meaningful together with
 * `selfCaptureSurface`, which says whether anything carries the shape at all.
 */
export function findSelfCaptureViolations(input: SelfCaptureInput): string[] {
  const out: string[] = [];
  for (const [file, raw] of Object.entries(input.migrations).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const text = codeOnly(raw);
    const gucs = new Set<string>();
    for (const m of text.matchAll(CAPTURE_GUC)) if (m[1] !== undefined) gucs.add(m[1]);
    if (gucs.size === 0) continue;
    const ddl = offsets(text, VERIFIED_DDL);
    for (const guc of [...gucs].sort()) {
      const quoted = guc.replace(/\./g, '\\.');
      const writes = offsets(text, new RegExp(`set_config\\s*\\(\\s*'${quoted}'`, 'gi'));
      const reads = offsets(text, new RegExp(`current_setting\\s*\\(\\s*'${quoted}'`, 'gi'));
      if (writes.length === 0) {
        out.push(`${file}: reads the capture ${guc} and never sets it, so the comparison it feeds has nothing to compare against`);
        continue;
      }
      if (writes.length > 1) {
        out.push(
          `${file}: sets the capture ${guc} ${writes.length} times. A capture taken twice is a capture the file can replace after changing what it captured, which is exactly how a planted widening was made to apply green — it must be set exactly ONCE (G-7)`,
        );
      }
      if (reads.length === 0) {
        out.push(`${file}: sets the capture ${guc} and never reads it, so nothing is compared and the capture is decoration (G-7)`);
        continue;
      }
      const first = ddl[0];
      const last = ddl[ddl.length - 1];
      if (first === undefined || last === undefined) continue;
      for (const w of writes) {
        if (w > first)
          out.push(
            `${file}: sets the capture ${guc} AFTER a policy statement at offset ${first}. A capture of the state must precede every statement it is a capture of, or it records the state the file has already changed (G-7)`,
          );
      }
      for (const r of reads) {
        if (r < last)
          out.push(
            `${file}: reads the capture ${guc} BEFORE the last policy statement at offset ${last}, so the comparison judges a state the file goes on to change (G-7)`,
          );
      }
    }
  }
  return out;
}

/** The files carrying the self-capture shape, so a rule watching nothing can say so. */
export function selfCaptureSurface(input: SelfCaptureInput): string[] {
  return Object.entries(input.migrations)
    .filter(([, text]) => new RegExp(CAPTURE_GUC.source).test(codeOnly(text)))
    .map(([file]) => file)
    .sort();
}
