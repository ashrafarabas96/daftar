/**
 * THE ROUTINES AND THE ROUTINE-LEVEL COMPLEMENT OF THE ACCEPTED INHERITED
 * PREFIX (P4-AL-88, `[[daftar-a-closure-rule-is-not-an-invariant]]`).
 *
 * The estate already owns the RELATION half of this question —
 * `phase4InheritedPrefixRelations()` in
 * `scripts/guards/no-authoritative-balance.ts`, which reads every stored
 * relation the accepted inherited prefix (`0000`–`0073`) creates from its
 * digest-verified files — and the Phase 3 half of the routine question,
 * `phase3PrefixRoutines()` in `tests/helpers/phase3-surface.ts`, which covers
 * `0053`–`0073` only. What was missing is the WHOLE inherited prefix's
 * routines, and that is what this module adds.
 *
 * It exists because "a routine of the phase that follows" was being computed
 * as "a routine a migration past the inherited head MENTIONS in a `CREATE [OR
 * REPLACE] FUNCTION`", which is not the same thing. A later migration may
 * legitimately `CREATE OR REPLACE` an INHERITED routine — `0077` replaces
 * `accounting_reversals_20_domain_source_guard` (P4-AL-47, seam S-P4-02) and
 * `inventory_stock_source_guard_gaps` (its `sale` arm) — and a split that
 * calls those two "Phase 4 routines" removes them from the inherited half of
 * an accepted equality, which then fails for two routines that have not
 * changed owner, definer or search path at all.
 *
 * The scope is DISCOVERED from the frozen prefix, never from a list of the new
 * phase's names: a routine belongs to the inherited half if and only if a file
 * of the accepted inherited prefix declares it, whoever replaces it later.
 *
 * FAIL EMPTY, the same discipline `phase3PrefixRoutines()` keeps: a prefix file
 * that is missing or differs from its accepted digest empties the set, and an
 * empty scope makes every scoped claim RED rather than laundered — so a
 * tampered prefix is loud. Callers assert the set is non-empty before they
 * rely on it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';
import { PHASE4_INHERITED_PREFIX, PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';

const ROUTINE_HEADER = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;

const routineNamesIn = (text: string): string[] => [...text.matchAll(ROUTINE_HEADER)].map((m) => (m[1] ?? '').toLowerCase());

/**
 * The ROUTINE NAMES the accepted inherited prefix (`0000`–`0073`) declares,
 * read from the files' digest-verified text. Names, not signatures: a later
 * migration may add an overload of an inherited routine and the scope question
 * is "whose routine is this".
 */
export function phase4InheritedPrefixRoutines(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, sha] of PHASE4_INHERITED_PREFIX) {
    let text: string;
    try {
      text = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    } catch {
      return new Set();
    }
    if (createHash('sha256').update(text).digest('hex') !== sha) return new Set();
    for (const routine of routineNamesIn(text)) out.add(routine);
  }
  return out;
}

/**
 * The routines the migrations BEYOND the accepted inherited prefix bring into
 * existence: declared by a file past the inherited head and declared by no
 * file of the prefix. Sorted.
 *
 * This is the complement of `phase4InheritedPrefixRoutines()` over the files
 * on disk, so it grows by itself as later slices land and it never claims a
 * routine the inherited prefix already owned. It returns `[]` when the prefix
 * reader fails empty, which is why callers assert both halves are non-empty.
 */
export function beyondInheritedPrefixRoutines(): string[] {
  const inherited = phase4InheritedPrefixRoutines();
  if (inherited.size === 0) return [];
  const out = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith('.sql') || file <= PHASE4_INHERITED_PREFIX_END) continue;
    for (const routine of routineNamesIn(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))) {
      if (!inherited.has(routine)) out.add(routine);
    }
  }
  return [...out].sort();
}
