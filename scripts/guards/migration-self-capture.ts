/**
 * GUARD G-8 — a migration that verifies itself across its own DDL must not be
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
 * ── WHY THE RULE IS ABOUT SPELLING AS WELL AS PLACE ──────────────────────
 *
 * The first version of this rule asked only "how many times does the text
 * contain `set_config('<the capture>'`". An independent challenge round drove
 * four evasions end to end on a database built from zero, and three applied a
 * widening GREEN with the rule silent:
 *
 *   `EXECUTE format('SELECT set_config(%L,…)', 'app.…_snapshot', …)`
 *   `set_config('app.p4s4_0086' || '_policy_snapshot', …)`
 *   a second `set_config` on a line whose earlier literal contained `--`
 *
 * and renaming the capture from `…_policy_snapshot` to `…_policy_before`
 * dropped the file off the rule's surface altogether. So three properties are
 * required of the TEXT, not one:
 *
 *   (i)   the capture is written exactly once, before the first statement it
 *         captures, and read only after the last — the original rule;
 *   (ii)  every `set_config` in such a file names its GUC with ONE plain
 *         literal, so a name assembled at runtime cannot hide a second write;
 *   (iii) no string literal in such a file contains `set_config` or the name
 *         of a capture, so a write cannot be smuggled through `EXECUTE` or
 *         `format`.
 *
 * And the surface is derived from a property of the FILE rather than from the
 * capture's spelling: a GUC whose name carries the migration's OWN NUMBER is
 * the file's own, and one the file both writes and reads is a capture, which
 * must then be named so (`snapshot` or `capture`). Renaming it is a violation
 * instead of an escape.
 *
 * This is the text half. The runtime half is the migration's own comparison.
 */

/** The GUC names this rule governs by NAME: a capture a migration takes of its own pre-state. */
const CAPTURE_GUC = /'(app\.[a-z0-9_]*(?:snapshot|capture)[a-z0-9_]*)'/g;

/** Any GUC literal at all, so a file's OWN GUCs can be derived from its number. */
const ANY_GUC = /'(app\.[a-z0-9_]+)'/g;

/** The statements a capture of a policy set is a capture OF. */
const VERIFIED_DDL = /\b(?:ALTER|CREATE|DROP)\s+POLICY\b/gi;

export interface SelfCaptureInput {
  /** Every migration file, keyed by repository-relative path. */
  readonly migrations: Readonly<Record<string, string>>;
}

/** The two masks of one file, produced by a single pass. */
export interface Masks {
  /** Comments blanked. String literals KEPT, because the GUC names live in them. */
  readonly code: string;
  /** Comments AND string literals blanked: the view a question about STATEMENTS must read. */
  readonly statements: string;
  /** Every string literal's span, as `[start, end)` over the original text. */
  readonly literals: readonly (readonly [number, number])[];
}

/**
 * ONE lexer, OFFSETS PRESERVED, because every question below is about where
 * one thing sits relative to another.
 *
 * It understands what PostgreSQL understands: `--` to end of line, `/* *\/`
 * with NESTING (PostgreSQL nests block comments; a non-nesting reader ends the
 * comment early and reads the rest of a comment as code), single-quoted
 * strings with `''` escapes, `E'…'` with backslash escapes, double-quoted
 * identifiers, and dollar-quoted blocks. A dollar-quoted block is NOT blanked:
 * its body is the migration's actual code, and the strings inside it are real
 * strings, which is why a `--` inside one of them must not blank the rest of
 * its line.
 *
 * Blanked characters become spaces rather than being removed, and newlines are
 * kept, so every offset still names the same byte and every line the same line.
 */
export function masks(text: string): Masks {
  const code = text.split('');
  const statements = text.split('');
  const literals: [number, number][] = [];
  const n = text.length;
  const blank = (a: number, b: number, which: string[]): void => {
    for (let k = a; k < b && k < n; k += 1) if (which[k] !== '\n') which[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      blank(i, end, code);
      blank(i, end, statements);
      i = end;
      continue;
    }
    if (two === '/*') {
      // Nesting, as PostgreSQL does it.
      let depth = 0;
      let j = i;
      while (j < n) {
        if (text.slice(j, j + 2) === '/*') {
          depth += 1;
          j += 2;
          continue;
        }
        if (text.slice(j, j + 2) === '*/') {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j += 1;
      }
      blank(i, j, code);
      blank(i, j, statements);
      i = j;
      continue;
    }
    const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
    if (dollar !== null) {
      // Transparent: the tag itself is not code to read, the body is.
      i += dollar[0].length;
      continue;
    }
    const estring = /^[eE]'/.exec(text.slice(i));
    if (estring !== null || text[i] === "'") {
      const start = i;
      let j = i + (estring !== null ? 2 : 1);
      while (j < n) {
        if (estring !== null && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      literals.push([start, j]);
      blank(start, j, statements);
      i = j;
      continue;
    }
    if (text[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j, statements);
      i = j;
      continue;
    }
    i += 1;
  }
  return { code: code.join(''), statements: statements.join(''), literals };
}

/**
 * The file with every comment blanked out, OFFSETS PRESERVED — kept as the
 * module's named view because a rule about where a statement sits relative to
 * another must read code and not prose. It is now the lexer's `code` mask.
 */
export const codeOnly = (text: string): string => masks(text).code;

const offsets = (text: string, re: RegExp): number[] => {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) out.push(m.index ?? 0);
  return out;
};

/** The migration's own number, from its file name: `0086_…sql` → `0086`. */
const ownNumber = (file: string): string | null => /(?:^|\/)(\d{4})_/.exec(file)?.[1] ?? null;

/** The GUC names a file carries, split into the ones it NAMES as a capture and the ones that are its OWN. */
export function fileGucs(file: string, code: string): { readonly captures: string[]; readonly own: string[] } {
  const named = new Set<string>();
  for (const m of code.matchAll(new RegExp(CAPTURE_GUC.source, 'g'))) if (m[1] !== undefined) named.add(m[1]);
  const num = ownNumber(file);
  const own = new Set<string>();
  if (num !== null) for (const m of code.matchAll(new RegExp(ANY_GUC.source, 'g'))) if (m[1] !== undefined && m[1].includes(num)) own.add(m[1]);
  return { captures: [...named].sort(), own: [...own].sort() };
}

/**
 * Every violation of G-8, as a sentence naming the file, the GUC and what is
 * wrong. An empty result is only meaningful together with
 * `selfCaptureSurface`, which says whether anything carries the shape at all.
 */
export function findSelfCaptureViolations(input: SelfCaptureInput): string[] {
  const out: string[] = [];
  for (const [file, raw] of Object.entries(input.migrations).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const { code, statements, literals } = masks(raw);
    const { captures, own } = fileGucs(file, code);
    const governed = [...new Set([...captures, ...own])].sort();
    if (governed.length === 0) continue;

    // ── (iii) the file's OWN GUCs that it both writes and reads are captures,
    // and a capture must be NAMED as one. Renaming it is a violation, not an
    // escape from the rule's surface.
    for (const guc of own) {
      const quoted = guc.replace(/\./g, '\\.');
      const written = offsets(code, new RegExp(`set_config\\s*\\(\\s*'${quoted}'`, 'gi')).length > 0;
      const readBack = offsets(code, new RegExp(`current_setting\\s*\\(\\s*'${quoted}'`, 'gi')).length > 0;
      if (written && readBack && !captures.includes(guc))
        out.push(
          `${file}: ${guc} carries this migration's own number and is both written and read by it, so it IS a capture of its own state — it must say so in its name (snapshot or capture), or this rule cannot tell a capture from a scope variable (G-8)`,
        );
    }

    // ── (ii) a write of the capture must be a STATEMENT this rule can
    // count, which forbids exactly two spellings. The file legitimately sets
    // SCOPE GUCs through a loop variable (`set_config(v_guc, …)`), so the rule
    // is not "always a literal": it is that a name may not be ASSEMBLED, and
    // that the capture's own name may appear nowhere but as the first argument
    // of `set_config` or `current_setting`. A variable can then never be
    // carrying it.
    for (const m of code.matchAll(/set_config\s*\(\s*/gi)) {
      const at = (m.index ?? 0) + m[0].length;
      const head = code.slice(at, at + 400);
      const upToComma = head.slice(0, head.indexOf(',') < 0 ? head.length : head.indexOf(','));
      if (/\|\||\bformat\s*\(|\bconcat\s*\(/i.test(upToComma))
        out.push(
          `${file}: the set_config at offset ${m.index ?? 0} ASSEMBLES its GUC name (${upToComma.trim()}). A name built at runtime is a write this rule cannot count, which is exactly how a second write of the capture was hidden (G-8)`,
        );
    }
    for (const guc of governed) {
      const quoted = guc.replace(/[.]/g, '\\.');
      for (const m of code.matchAll(new RegExp(`'${quoted}'`, 'g'))) {
        const at = m.index ?? 0;
        const before = code.slice(Math.max(0, at - 60), at);
        if (/(?:set_config|current_setting)\s*\(\s*$/i.test(before)) continue;
        out.push(
          `${file}: the name ${guc} appears at offset ${at} somewhere other than as the first argument of set_config or current_setting. A capture's name may appear ONLY in those two positions — otherwise it can be handed to format, or assigned to a variable, and written by text this rule cannot count (G-8)`,
        );
      }
    }

    // ── (iii) no literal may carry a write, so EXECUTE and format cannot
    // smuggle one past the count.
    for (const [a, b] of literals)
      if (/set_config/i.test(raw.slice(a, b)))
        out.push(
          `${file}: a string literal at offset ${a} contains set_config. In a file that captures its own state, an executed literal is a write this rule cannot see — the capture must be set by a statement in the file's own text (G-8)`,
        );

    // ── (i) once, before the first statement, read after the last. Statement
    // offsets come from the LITERAL-BLANKED mask: an `ALTER POLICY` inside a
    // string is not a statement.
    const ddl = offsets(statements, VERIFIED_DDL);
    for (const guc of captures) {
      const quoted = guc.replace(/\./g, '\\.');
      const writes = offsets(code, new RegExp(`set_config\\s*\\(\\s*'${quoted}'`, 'gi'));
      const reads = offsets(code, new RegExp(`current_setting\\s*\\(\\s*'${quoted}'`, 'gi'));
      if (writes.length === 0) {
        out.push(`${file}: reads the capture ${guc} and never sets it, so the comparison it feeds has nothing to compare against`);
        continue;
      }
      if (writes.length > 1) {
        out.push(
          `${file}: sets the capture ${guc} ${writes.length} times. A capture taken twice is a capture the file can replace after changing what it captured, which is exactly how a planted widening was made to apply green — it must be set exactly ONCE (G-8)`,
        );
      }
      if (reads.length === 0) {
        out.push(`${file}: sets the capture ${guc} and never reads it, so nothing is compared and the capture is decoration (G-8)`);
        continue;
      }
      const first = ddl[0];
      const last = ddl[ddl.length - 1];
      if (first === undefined || last === undefined) continue;
      for (const w of writes) {
        if (w > first)
          out.push(
            `${file}: sets the capture ${guc} AFTER a policy statement at offset ${first}. A capture of the state must precede every statement it is a capture of, or it records the state the file has already changed (G-8)`,
          );
      }
      for (const r of reads) {
        if (r < last)
          out.push(
            `${file}: reads the capture ${guc} BEFORE the last policy statement at offset ${last}, so the comparison judges a state the file goes on to change (G-8)`,
          );
      }
    }
  }
  return out;
}

/**
 * The files carrying the self-capture shape, so a rule watching nothing can
 * say so. A file is on the surface if it NAMES a capture or if it carries a GUC
 * of its own number that it both writes and reads — so renaming the capture
 * cannot take the file off the surface.
 */
export function selfCaptureSurface(input: SelfCaptureInput): string[] {
  return Object.entries(input.migrations)
    .filter(([file, raw]) => {
      const code = codeOnly(raw);
      const { captures, own } = fileGucs(file, code);
      if (captures.length > 0) return true;
      return own.some((guc) => {
        const quoted = guc.replace(/\./g, '\\.');
        return new RegExp(`set_config\\s*\\(\\s*'${quoted}'`, 'i').test(code) && new RegExp(`current_setting\\s*\\(\\s*'${quoted}'`, 'i').test(code);
      });
    })
    .map(([file]) => file)
    .sort();
}
