/**
 * P4-AL-41's STATIC ACQUISITION-ORDER CHECK, AND ITS RED PROOFS.
 * (`docs/PHASE_4_ARCHITECTURE_LOCK.md` `P4-AL-41`;
 *  `docs/patch-requests/PATCH-REQ-S4X-001.md`,
 *  `docs/patch-requests/PATCH-REQ-S4X-003.md`;
 *  `scripts/guards/phase4-lock-order.ts`.)
 *
 * `P4-AL-41` says "A static check reads each routine's acquisition sequence and
 * compares it against this list." That check did not exist — the module header
 * of `scripts/guards/phase4-lock-order.ts` records what was there instead and
 * why none of it could see an inversion. This suite is the check's own law.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY BOTH DIRECTIONS ───────────────────────
 *
 * A checker that has only ever agreed with itself is not a checker. So every
 * claim here comes in two halves:
 *
 *   — the SILENT half: over the order the live routines actually take, the
 *     checker reports nothing;
 *   — the RED half: over an order that differs, it reports exactly the
 *     inversion, naming both resources, both ranks and both modes.
 *
 * The red half is not synthetic in the one case that matters most. The order
 * `docs/PHASE_4_ARCHITECTURE_LOCK.md:869-885` currently declares is a REAL
 * subject — it is the live text of the lock — and the checker refuses the live
 * settlement routines against it. That refusal IS the machine evidence for
 * `PATCH-REQ-S4X-001`. When the coordinator applies that patch, this block goes
 * on asserting the same thing about the superseded order, which is still a real
 * order the estate once declared.
 *
 * ── THE ADVISORY HALF, AND ITS BOUNDARY ───────────────────────────────────
 *
 * `P4-AL-41`'s seven ranks name no advisory key, and Phase 4 takes several. The
 * checker reads advisory acquisitions as first-class and reports an unranked
 * one rather than ignoring it, because a resource no rank governs is a resource
 * a routine may take in either order and still pass.
 *
 * `S4_ADVISORY_BLOCK` ranks ONLY the two classes THIS SLICE takes. It ranks
 * nothing a later slice will take: a rank for a key no migration acquires is a
 * permanent module bounding the future, which `P4-AL-60` and
 * `[[daftar-a-closure-rule-is-not-an-invariant]]` forbid. The rule by which a
 * later slice extends the block is stated on the constant, and
 * `PHASE4_ADVISORY_CLASSES_TODAY` below is DISCOVERED from the migration text
 * rather than written down, so a slice that adds a class without ranking it is
 * reported by this suite rather than by a reviewer.
 *
 * ── THE PLANTED SUBJECTS ARE REAL ROUTINES, AND BROKEN ONE WAY EACH ───────
 *
 * Each plant is a REAL routine body — the live `customer_apply_credit` text —
 * with exactly ONE acquisition moved. A subject broken in two ways proves
 * nothing about either, and a fictional routine asserted to produce "no
 * finding" asserts the opposite of its intent. The PASSING case is asserted
 * FIRST in every block, so a refusal that was already there cannot be read as
 * caused by the plant.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advisoryInterleaves,
  bodyAcquisitions,
  definitionCount,
  joinMigrations,
  lastRoutineBody,
  lockOrderProblems,
  routineAcquisitions,
  type Acquisition,
} from '../../scripts/guards/phase4-lock-order';

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'infrastructure', 'database', 'migrations');

/** Phase 4's migrations: the `phase4`-named files, `0074`–`0086`. Discovered, never listed. */
function phase4Migrations(): readonly string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^00(?:7[4-9]|8[0-6])_.*phase4.*\.sql$/.test(f))
    .sort();
}

const SURFACE = joinMigrations(MIGRATIONS, phase4Migrations());

/**
 * THE ADVISORY CLASSES THIS SLICE TAKES, RANKED — and only these two.
 *
 * S4's two commands each take exactly ONE of them, so their relative rank is
 * not constrained by any routine in this slice; they are ranked anyway, because
 * the alternative is an unranked resource and `lockOrderProblems` reports that
 * as the gap it is.
 *
 * THE RULE FOR A LATER SLICE: a slice that ships a routine taking an advisory
 * key adds that class to this block IN THE SAME CHANGE as the migration that
 * takes it, at the position its own routine takes it. No slice ranks a class no
 * migration acquires. `discoveredAdvisoryClasses` is what makes the rule
 * enforceable rather than advisory: it reads the classes out of the migration
 * text, so an unranked new class is a RED here.
 */
const S4_ADVISORY_BLOCK: readonly string[] = ['daftar.payment_id', 'daftar.customer_credit_application_id'];

/**
 * THE DOMAIN ORDER THE LIVE ROUTINES ACTUALLY TAKE — the order
 * `PATCH-REQ-S4X-001` asks `P4-AL-41` to become.
 *
 * It differs from `docs/PHASE_4_ARCHITECTURE_LOCK.md:869-885` in exactly the
 * ways that patch request justifies: `invoices` precedes `customers`, the
 * consumed source precedes `customers`, and `payment_methods` — which
 * `customer_collect_payment` takes `FOR SHARE` at `0085:618` and which the
 * declared list ranks NOWHERE — has a rank.
 */
const S4_SETTLEMENT_ORDER: readonly string[] = [
  ...S4_ADVISORY_BLOCK,
  'businesses',
  'invoices',
  'payments',
  'credit_notes',
  'customer_credits',
  'customers',
  'payment_methods',
  'stock_levels',
  'installment_plans',
  'invoice_sequences',
];

/** The order `P4-AL-41` declares TODAY, transcribed from `docs/PHASE_4_ARCHITECTURE_LOCK.md:869-885`. A real subject: the lock's live text. */
const DECLARED_TODAY: readonly string[] = [
  'businesses',
  'customers',
  'invoices',
  'payments',
  'credit_notes',
  'customer_credits',
  'stock_levels',
  'installment_plans',
  'invoice_sequences',
];

/** The two S4 settlement commands, by name. */
const SETTLEMENT = ['customer_collect_payment', 'customer_apply_credit'] as const;

/** Every advisory class any Phase 4 migration takes, DISCOVERED from the text. */
function discoveredAdvisoryClasses(): readonly string[] {
  const out = new Set<string>();
  for (const file of phase4Migrations()) {
    const text = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of text.matchAll(/pg_(?:catalog\.)?advisory_xact_lock(?:_shared)?\s*\(\s*(?:pg_catalog\.)?hashtext\s*\(\s*'([^']+)'/g))
      out.add(m[1] as string);
  }
  return [...out].sort();
}

const PHASE4_ADVISORY_CLASSES_TODAY = discoveredAdvisoryClasses();

/** The live `customer_apply_credit` body — the real subject every plant below is made from. */
const APPLY_CREDIT_BODY = lastRoutineBody(SURFACE, 'customer_apply_credit');

describe('P4-AL-41 the static acquisition-order check: it reads the LIVE definition', () => {
  it('the subject exists: both settlement routines have a readable body in the Phase 4 surface', () => {
    expect(phase4Migrations().length, 'NO SUBJECT — no Phase 4 migration was discovered, so every claim below judged an empty text').toBeGreaterThan(0);
    for (const fn of SETTLEMENT) expect(routineAcquisitions(SURFACE, fn), `${fn} has no readable body in the Phase 4 surface`).not.toBeNull();
    expect(APPLY_CREDIT_BODY, 'the plants below are made from the live customer_apply_credit body, and it must be readable').not.toBeNull();
  });

  it('customer_collect_payment is defined TWICE and the checker reads 0085’s body, not 0081’s superseded one', () => {
    // THE `0085` LESSON, as a law. `scripts/phase4-s4-gate.ts`'s `routineBody`
    // takes the FIRST match and is handed the JOINED surface, so it judges
    // `0081`'s body — a routine that no longer exists. Measured and recorded in
    // `PATCH-REQ-S4X-004`.
    expect(
      definitionCount(SURFACE, 'customer_collect_payment'),
      'NO SUBJECT for this law — customer_collect_payment is defined once in the surface, so "the last definition" and "the first" coincide and reading the wrong one is unobservable',
    ).toBeGreaterThan(1);
    // Each file read on its own, so "the first definition" and "the last" are
    // two measured texts rather than an assumption about which file wins.
    const bodyIn = (file: string): string => lastRoutineBody(readFileSync(join(MIGRATIONS, file), 'utf8'), 'customer_collect_payment') ?? '';
    const in0081 = bodyIn('0081_phase4_customer_payments_credits.sql');
    const in0085 = bodyIn('0085_phase4_allocation_recompute_set_based.sql');
    // The two bodies really are different texts, or which one a reader picks
    // could not matter and this law would be about nothing.
    expect(in0081.length, 'NO SUBJECT — 0081 and 0085 declare byte-identical bodies').not.toBe(in0085.length);

    const shape = (a: readonly Acquisition[]): string => a.map((x) => `${x.name}:${x.mode}`).join(' -> ');
    const live = routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [];
    expect(
      shape(live),
      `handed the JOINED surface, the checker must report 0085's body — the LAST definition and the live routine. 0081: ` +
        `${shape(bodyAcquisitions(in0081))}; 0085: ${shape(bodyAcquisitions(in0085))}`,
    ).toBe(shape(bodyAcquisitions(in0085)));
  });

  it('every acquisition it reports is a real one: no COMMENT and no self-capture LITERAL is read as a lock', () => {
    // `0085:987` asserts its own end state with the whole locking clause inside
    // a string literal, and `0081:626-642` describes five acquisitions in
    // prose. A reader that saw either would report an order the routine never
    // takes. Measured: the live body's reported count is small and exact.
    const live = routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [];
    expect(
      live.map((a) => `${a.kind === 'advisory' ? '@' : ''}${a.name}:${a.mode}`),
      'the live customer_collect_payment takes exactly these four acquisitions, in this order (0085:487, 581, 608, 618)',
    ).toEqual(['@daftar.payment_id:exclusive', 'invoices:UPDATE', 'customers:SHARE', 'payment_methods:SHARE']);
    expect(
      routineAcquisitions(SURFACE, 'customer_apply_credit')?.map((a) => `${a.kind === 'advisory' ? '@' : ''}${a.name}:${a.mode}`),
      'and customer_apply_credit exactly these four (0081:2269, 2299, 2321, 2345)',
    ).toEqual(['@daftar.customer_credit_application_id:exclusive', 'invoices:UPDATE', 'customer_credits:UPDATE', 'customers:SHARE']);
  });
});

describe('P4-AL-41 the declared order: the routines agree with each other, and the LOCK’s text is the side that is wrong', () => {
  it('against the order the routines take, the checker is SILENT for both settlement commands', () => {
    // THE PASSING CASE, ASSERTED FIRST. Every refusal below has to be shown to
    // be caused by the thing it names, and a checker that refused everything
    // would satisfy the red halves while proving nothing.
    for (const fn of SETTLEMENT)
      expect(lockOrderProblems(routineAcquisitions(SURFACE, fn) ?? [], S4_SETTLEMENT_ORDER, fn), `${fn} obeys the order it and its sibling take`).toEqual([]);
  });

  it('planted red: against the order P4-AL-41 declares TODAY, both routines are refused for taking customers after invoices', () => {
    // A REAL SUBJECT: `DECLARED_TODAY` is the live text of
    // `docs/PHASE_4_ARCHITECTURE_LOCK.md:869-885`, and these are the live
    // routines. This refusal is the machine evidence for PATCH-REQ-S4X-001.
    const collect = lockOrderProblems(routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [], DECLARED_TODAY, 'customer_collect_payment');
    expect(collect.join('\n'), 'the declared order ranks customers 2 and invoices 3, and the live routine takes invoices first').toMatch(
      /`customers` \(declared rank 2, acquired SHARE at body line \d+\) is taken AFTER `invoices` \(declared rank 3/,
    );
    const apply = lockOrderProblems(routineAcquisitions(SURFACE, 'customer_apply_credit') ?? [], DECLARED_TODAY, 'customer_apply_credit');
    expect(apply.join('\n'), 'and customer_apply_credit takes the consumed source before the customer too').toMatch(
      /`customers` \(declared rank 2, acquired SHARE at body line \d+\) is taken AFTER `customer_credits` \(declared rank 6/,
    );
    expect(collect, 'the refusal is non-empty').not.toEqual([]);
    expect(apply, 'and so is the second').not.toEqual([]);
  });

  it('planted red: a FOR SHARE acquisition inverts the order exactly as FOR UPDATE does, and is not dismissed', () => {
    // THE PASSING CASE FIRST: in the corrected order these same SHARE
    // acquisitions are silent, so what the red below reports is the ORDER and
    // not the mode.
    expect(
      lockOrderProblems(routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [], S4_SETTLEMENT_ORDER, 'control'),
      'the SHARE legs are lawful here',
    ).toEqual([]);
    // Both of the inversions above are a SHARE acquisition taken after an
    // exclusive one on a higher-ranked resource — the shape a reader that
    // skipped shared modes would be blind to. Asserted as a property of the
    // reported text so it cannot be satisfied by an unrelated finding.
    const reported = lockOrderProblems(routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [], DECLARED_TODAY, 'customer_collect_payment');
    expect(reported.filter((p) => /acquired SHARE/.test(p)).length, 'the inversion the checker reports is a FOR SHARE one').toBeGreaterThan(0);
  });

  it('planted red: payment_methods is acquired FOR SHARE and P4-AL-41 ranks it NOWHERE', () => {
    // Not in the coordinator's brief and found by the sweep: the declared order
    // has no rank for `payment_methods`, which `customer_collect_payment` locks
    // `FOR SHARE` at `0085:618`. An unranked resource may be taken in either
    // order and still pass, which is the same class of gap as the advisory keys.
    const reported = lockOrderProblems(routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [], DECLARED_TODAY, 'customer_collect_payment');
    expect(reported.join('\n'), 'the checker names the unranked relation rather than ignoring it').toContain('`payment_methods` is acquired at body line');
    // And the control: once ranked, it is silent — so the finding is about the
    // RANKING and not about the acquisition.
    expect(
      lockOrderProblems(routineAcquisitions(SURFACE, 'customer_collect_payment') ?? [], S4_SETTLEMENT_ORDER, 'control').join('\n'),
      'with payment_methods ranked, nothing is reported about it',
    ).not.toContain('payment_methods');
  });
});

describe('P4-AL-41 the advisory keys: ranked for this slice, discovered for the whole phase', () => {
  it('both S4 commands take their advisory key BEFORE every domain lock, so a head block describes them exactly', () => {
    for (const fn of SETTLEMENT) {
      const acq = routineAcquisitions(SURFACE, fn) ?? [];
      expect(acq.length, `NO SUBJECT — ${fn} reports no acquisitions`).toBeGreaterThan(0);
      expect(acq[0]?.kind, `${fn}'s first acquisition is its per-document advisory key`).toBe('advisory');
      expect(advisoryInterleaves(acq), `${fn} takes no advisory key after a domain lock, so the two kinds do not interleave`).toBe(false);
    }
  });

  it('but sale_commit INTERLEAVES the two kinds, so a head block cannot describe Phase 4 as a whole', () => {
    // MEASURED, and it is the reason this suite ranks advisory keys inside ONE
    // list rather than in a block bolted on the front. `sale_commit` takes
    // `daftar.sale_id` (0078:554), then `sales FOR UPDATE` (0078:586), then
    // `daftar.customer_id` SHARED (0078:674) — an advisory key AFTER a domain
    // row lock. A block at the head would declare `daftar.customer_id` to be
    // acquired before `sales`, which is false of the routine.
    const acq = routineAcquisitions(SURFACE, 'sale_commit') ?? [];
    expect(acq.length, 'NO SUBJECT — sale_commit reports no acquisitions').toBeGreaterThan(0);
    expect(advisoryInterleaves(acq), `sale_commit's acquisition sequence: ${acq.map((a) => `${a.kind}:${a.name}`).join(' -> ')}`).toBe(true);
  });

  it('planted red: a routine taking the two S4 advisory keys in the WRONG order is refused', () => {
    // THE COORDINATOR'S EXPLICIT ASK. The subject is the REAL
    // `customer_apply_credit` body with ONE change: a second advisory
    // acquisition added, so the two ranked classes are taken in descending
    // rank. Everything else about the routine is untouched.
    const real = APPLY_CREDIT_BODY as string;
    // CONTROL FIRST: the real body, unplanted, against the same order — silent.
    expect(lockOrderProblems(bodyAcquisitions(real), S4_SETTLEMENT_ORDER, 'control: the unplanted routine'), 'the real routine is lawful').toEqual([]);

    // THE PLANT: take `daftar.customer_credit_application_id` (rank 2) first
    // and `daftar.payment_id` (rank 1) second — the inversion.
    const planted = real.replace(
      "PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_credit_application_id'), hashtext(p_application_id::text));",
      "PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_credit_application_id'), hashtext(p_application_id::text));\n  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_id'), hashtext(p_application_id::text));",
    );
    expect(planted, 'NO SUBJECT — the plant did not apply, so what follows would judge the unmodified body').not.toBe(real);
    const problems = lockOrderProblems(bodyAcquisitions(planted), S4_SETTLEMENT_ORDER, 'the planted routine');
    expect(problems, 'the checker refuses the planted advisory inversion').not.toEqual([]);
    expect(problems.join('\n'), 'and names both advisory classes, both ranks and the inversion').toMatch(
      /`daftar\.payment_id` \(declared rank 1[^)]*\) is taken AFTER `daftar\.customer_credit_application_id` \(declared rank 2/,
    );
  });

  it('planted red: an advisory key no rank governs is reported, not ignored', () => {
    const real = APPLY_CREDIT_BODY as string;
    // CONTROL FIRST.
    expect(lockOrderProblems(bodyAcquisitions(real), S4_SETTLEMENT_ORDER, 'control: the unplanted routine'), 'the real routine is lawful').toEqual([]);
    // THE PLANT: one advisory acquisition of a class the block does not rank.
    const planted = real.replace(
      "PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_credit_application_id'), hashtext(p_application_id::text));",
      "PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_credit_application_id'), hashtext(p_application_id::text));\n  PERFORM pg_advisory_xact_lock(hashtext('daftar.unranked_future_key'), hashtext(p_application_id::text));",
    );
    expect(planted, 'NO SUBJECT — the plant did not apply').not.toBe(real);
    expect(lockOrderProblems(bodyAcquisitions(planted), S4_SETTLEMENT_ORDER, 'the planted routine').join('\n'), 'the unranked class is named').toContain(
      'the advisory key `daftar.unranked_future_key` is acquired at body line',
    );
  });

  it('the advisory block ranks the two classes S4 takes, and the phase’s other classes are DISCOVERED and attributed', () => {
    // THE BOUNDARY, ASSERTED. This block ranks two classes. Phase 4 as a whole
    // takes more, and they belong to the slices that take them — S2's three in
    // `0078` and S3's three in `0079`. They are DISCOVERED here rather than
    // listed, so a slice that adds a class is visible, and they are NOT ranked
    // here, because a rank for a key this slice does not take is a permanent
    // module bounding the future (P4-AL-60).
    expect(PHASE4_ADVISORY_CLASSES_TODAY, 'NO SUBJECT — no advisory class was discovered in the Phase 4 surface').not.toEqual([]);
    for (const cls of S4_ADVISORY_BLOCK)
      expect(PHASE4_ADVISORY_CLASSES_TODAY, `the block ranks ${cls}, so some Phase 4 migration must actually take it`).toContain(cls);
    // Every class this slice's OWN two commands take is ranked. A class taken
    // by S4 and unranked would be the gap this block exists to close.
    const takenByS4 = new Set<string>();
    for (const fn of SETTLEMENT) for (const a of routineAcquisitions(SURFACE, fn) ?? []) if (a.kind === 'advisory') takenByS4.add(a.name);
    expect([...takenByS4].sort(), 'S4 takes exactly the two classes the block ranks').toEqual([...S4_ADVISORY_BLOCK].sort());
  });

  it('planted red: a Phase 4 routine already takes THREE advisory keys in one transaction, so an ordered set exists today', () => {
    // CORRECTS A PREMISE, measured. "No accepted routine takes more than one,
    // so there is no pair to order" is false of this tree:
    // `pos_till_session_open` (`0079:919-923`, S3's ACCEPTED migration) takes
    // three consecutively — `daftar.pos_till_session_actor`,
    // `daftar.pos_till_terminal`, `daftar.pos_till_session_id`. The ordered set
    // the advisory gap is about is already shipped; it is not waiting on S6.
    //
    // The red: against this slice's block — which ranks none of the three, as
    // it must not — the checker refuses all three as unranked. That is the
    // correct verdict and the reason S3's classes need S3's ranks, in whatever
    // change takes them.
    const acq = routineAcquisitions(SURFACE, 'pos_till_session_open') ?? [];
    const advisory = acq.filter((a) => a.kind === 'advisory');
    expect(advisory.length, `pos_till_session_open's advisory keys: ${advisory.map((a) => a.name).join(', ')}`).toBeGreaterThan(2);
    const problems = lockOrderProblems(acq, S4_SETTLEMENT_ORDER, 'pos_till_session_open');
    expect(problems, 'and this slice’s block, correctly, ranks none of them').not.toEqual([]);
    expect(problems.filter((p) => /the advisory key `daftar\.pos_till_/.test(p)).length, 'all three are named as unranked').toBe(advisory.length);
  });
});
