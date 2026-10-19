#!/usr/bin/env -S python3 -I
"""Phase 8 — the mutants, as a program rather than as shell-quoted fragments.

WHY THIS IS A FILE. The first version of the runner carried each mutant as a
python fragment inside an unquoted shell heredoc. Two harness bugs came out of
that in one afternoon: a literal ``$$`` was replaced by the shell's process id,
and the definitions themselves ended up being read by bash, which reported
``blind_sec7: command not found`` while the run still printed red proofs for
other mutants. A mutation harness that can silently mutate nothing is worse
than no mutation harness, because it reports success. So the mutants live here,
each one a named function that MUST change the text and says so.

Usage:  p8-mutants.py <mutant-id> <overlay-copy-path>
Exit 0 only when the mutation changed the file.
"""
import sys

# =====================================================================
# ROUND 23, N-17 (P1, FAIL-OPEN) — THIS BLOCK SITS ABOVE EVERY IMPORT
# =====================================================================
# Python prepends the script's own directory to `sys.path`, and this script
# lives INSIDE the tree it judges. So every module it imports is resolved,
# first, from the subject: `hashlib`, which computes every digest, and
# `subprocess`, which carries every answer git gives about the anchor. The
# fourteenth challenge measured the consequence — a commit that modifies a
# frozen migration AND adds `proof/hashlib.py` exited 0, printed
# `ANCHOR LEG EXERCISED` with the right pin, and reproduced the pinned
# covered-set digest exactly, because that digest is a hash OVER per-file
# digests and every one of them came from the plant. Reproduced here before it
# was fixed.
#
# This is the phase's own defect family one level below its four earlier
# depths: not the quantity read from the subject, but the INSTRUMENT that
# computes it. It is also a standing project lesson from another phase
# (P5 B-9/F-50) which this pack failed to apply.
#
# WHY THE ORDER IS WHAT IT IS. `sys` is a BUILT-IN module, never loaded from a
# file, so it cannot be shadowed by a planted one. That is why it is the only
# name imported above this test, and everything else comes after.
#
# WHY TWO TESTS AND NOT ONE. `sys.flags.isolated` says what was ASKED for;
# whether the script's directory is actually off `sys.path` depends on the
# interpreter's version. The flag alone would pass on an interpreter where `-I`
# does not drop it, leaving the hole open with the guard green — the exact shape
# this phase keeps finding. So the second test MEASURES the path rather than
# trusting the flag.
if not sys.flags.isolated:
    sys.stderr.write(
        "MUTANT FAIL: NOT ISOLATED — started without `-I`, so Python put this "
        "program's own directory, which is inside the tree under test, first on "
        "sys.path; every module it needs would then be resolved from the subject "
        "it is judging. Re-run as `python3 -I`. Refusing rather than measuring "
        "with an instrument the subject can supply\n")
    raise SystemExit(1)
import os as _p8os  # noqa: E402  — deliberate: nothing is imported above the test
# ROUND 24, O-1 (round 15's challenge). The first version of this test compared
# path SPELLING. `abspath` normalises `.`, `..` and repeated slashes but never
# resolves a symlink, so a `sys.path` entry that is a SYMLINK to this very
# directory compared unequal, the test passed, and the challenger measured
# round 14's whole fail-open returning through it — with the refusal's own
# sentence, "a module planted beside this file would be imported in preference
# to the standard library", true of the case it let through. Identity is what
# the test is about, so both sides are resolved with `realpath`. `abspath` stays
# because `realpath` of a relative entry still has to be taken against the
# working directory, and the refusal now names BOTH spellings: the entry as
# written and what it resolves to.
_P8_OWN_DIR = _p8os.path.dirname(_p8os.path.abspath(__file__))
_P8_OWN_REAL = _p8os.path.realpath(_P8_OWN_DIR)


def _p8_is_own_dir(entry):
    """Is this sys.path entry THIS directory, however it is spelled?

    Two independent readings, because each catches what the other cannot.
    `realpath` resolves symlinks and so answers for a symlinked spelling even
    when the directory has been removed from under us. `samefile` compares the
    device and inode, which answers for a BIND MOUNT of the same directory —
    whose `realpath` is genuinely different while the directory is the same one.
    An entry that does not exist is not this directory, and `samefile` raises on
    it, so that is the only error swallowed here.

    **The `samefile` reading is UNEXERCISED at runtime, and is named as such
    rather than reported as proved.** Measured in this container: a bind mount
    of this directory IS caught, but by the `realpath` reading — on this kernel
    the bind path resolves through to the source — so no arm distinguishes the
    second reading. It is kept because a platform whose bind path does not
    resolve through would otherwise be a hole, and the alternative is code with
    a silent gap rather than a named one. Arms y16 and y17 exercise the
    `realpath` reading on the plain and symlinked spellings; y18 deletes this
    whole test alone and shows the fail-open return.
    """
    absolute = _p8os.path.abspath(entry or ".")
    if _p8os.path.realpath(absolute) == _P8_OWN_REAL:
        return True
    try:
        return _p8os.path.samefile(absolute, _P8_OWN_DIR)
    except OSError:
        return False


_p8_hit = next((p for p in sys.path if _p8_is_own_dir(p)), None)
if _p8_hit is not None:
    sys.stderr.write(
        "MUTANT FAIL: NOT ISOLATED — isolated mode was requested and this "
        "interpreter still has " + repr(_p8_hit) + ", which resolves to " +
        _P8_OWN_REAL + ", on sys.path, so a module planted beside this file "
        "would be imported in preference to the standard library. Refusing\n")
    raise SystemExit(1)


DOL = chr(36)
DD = DOL * 2
FQ = DOL + "f" + DOL


def blind_sec7(s):
    """Remove the overlay's own section 7 assertions.

    Section 7 refuses the overlay at APPLY time when the shape it claims is not
    the shape it produced. That makes it a STRONGER guard than several of the
    cases, and a mutant it catches never reaches the cases at all — so it is
    evidence about section 7 and about nothing else. This is the masking shape
    this project has now met in five phases, and the remedy is the same: drop
    both guards and assert each by its own name. Used only in the second half
    of a pair, never alone.
    """
    i = s.index("-- " + chr(167) + "7  The overlay asserts its own shape")
    j = s.index("DO " + DD, i)
    k = s.index("END " + DD + ";", j)
    assert "P8-OVERLAY-E(1)" in s[j:k], "the block being blinded is not section 7"
    stub = ("DO " + DD + " BEGIN RAISE NOTICE "
            "'section 7 blinded by a paired mutant'; END " + DD + ";")
    return s[:j] + stub + s[k + len("END " + DD + ";"):]


def drop_restrictive(s):
    """Leave every other relation isolated; unprotect `notifications` alone.

    Scoping the mutation to one relation is deliberate: the case that must
    notice is the one separating two businesses of the SAME tenant, and a
    mutant that unprotected everything would also red cases that are about
    something else.
    """
    old = ("    EXECUTE format(" + FQ +
           "CREATE POLICY business_isolation ON %I AS RESTRICTIVE FOR ALL")
    assert old in s, "the restrictive policy was not found"
    s = s.replace(old, "    IF t <> 'notifications' THEN EXECUTE format(" + FQ +
                  "CREATE POLICY business_isolation ON %I AS RESTRICTIVE FOR ALL", 1)
    old2 = ("business_id = (nullif(app_business(), ''))::uuid)" + FQ +
            ", t);\n  END LOOP;")
    assert old2 in s, "the end of the isolation loop was not found"
    return s.replace(old2, "business_id = (nullif(app_business(), ''))::uuid)" + FQ +
                     ", t); END IF;\n  END LOOP;", 1)


def guc_bypass(s):
    """Round 10's own defect, planted: a bypass that is a session setting.

    The live `app_bypass()` is `CURRENT_USER = 'daftar_platform'`. Round 10's
    prototype read a GUC instead, and its isolation result rested on that. This
    mutant restores the defect so the inverse case can be shown to catch it.
    """
    a = "app_bypass() OR business_id"
    b = "app_bypass() OR tenant_id"
    assert a in s and b in s, "the policy quals were not found"
    guc = "coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'"
    return s.replace(a, guc + " OR business_id").replace(b, guc + " OR tenant_id")


def deny_list_membership(s):
    """Turn the membership allow-list into a deny-list.

    The shape Phase 10 was rejected for: `status <> 'removed'` admits every
    token nobody has thought of yet, `suspended` among them.
    """
    old = "AND m.status = 'active'"
    assert old in s, "the membership conjunct was not found"
    return s.replace(old, "AND m.status <> 'removed'")


def drop_tenant_key(s):
    """Replace the composite tenant key with a business-only key."""
    old = ("  CONSTRAINT notifications_tenant_fk\n"
           "    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)")
    assert old in s, "the composite tenant key was not found"
    return s.replace(old, "  CONSTRAINT notifications_business_only_fk\n"
                          "    FOREIGN KEY (business_id) REFERENCES businesses (id)")


def status_domain_drift(s):
    """One token added to the status CHECK and nowhere else.

    This is the exact mutation the fourth challenge used. Round 10 stayed green
    under it, because a CASE with no ELSE returns NULL and `NULL <= anything`
    is not true, so the monotonic trigger never fired.
    """
    old = "CHECK (status IN ('queued','sent','delivered','read','failed'))"
    assert old in s, "the status CHECK was not found"
    return s.replace(old, "CHECK (status IN ('queued','sent','delivered','read','failed','archived'))", 1)


def arrival_domain_drift(s):
    """The arrival CHECK forgets `delivered`, while the ladder still arrives."""
    old = ("CHECK (final_status IS NULL OR final_status NOT IN ('delivered','read') "
           "OR arrival_ever_recorded)")
    assert old in s, "the arrival CHECK was not found"
    return s.replace(old, "CHECK (final_status IS NULL OR final_status NOT IN ('read') "
                          "OR arrival_ever_recorded)")


def drop_truncate_guard(s):
    """Remove the TRUNCATE guard and leave the DELETE guard in place.

    The shape where a history looks append-only and can be emptied in one
    statement, because TRUNCATE fires no row trigger.
    """
    import re
    m = re.search(r"CREATE TRIGGER attempts_no_truncate[^;]*;", s)
    assert m, "the truncate trigger was not found"
    return s[:m.start()] + s[m.end():]


def unisolate_settings(s):
    """Drop one relation from the isolation LOOP ONLY.

    The first version of this mutant replaced the relation's name everywhere,
    which removed it from section 7's own list as well: the file stayed
    self-consistent, applied cleanly and proved nothing. Section 7 has to fail
    on ABSENCE, not only on drift, so exactly one of the two lists is touched.
    """
    loop = "'notification_provider_statuses',\n                           'notification_settings'] LOOP"
    assert loop in s, "the isolation loop was not found"
    return s.replace(loop, "'notification_provider_statuses'] LOOP", 1)


def isolate_quarantine(s):
    """Put row level security on the quarantine, which cannot be scoped.

    Section 7's E(4) refuses this at apply time, and round 11 gave that
    assertion no mutant in either direction, so it was unmeasured. The relation
    has no `tenant_id` and no `business_id` — an unverifiable event carries no
    attribution we may believe — so a policy here is a claim of protection that
    protects nothing, which is worse than the honest absence.
    """
    old = "  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = 'notification_provider_quarantine'::regclass"
    assert old in s, "the quarantine assertion was not found"
    add = ("ALTER TABLE notification_provider_quarantine ENABLE ROW LEVEL SECURITY;\n"
           "CREATE POLICY tenant_membership ON notification_provider_quarantine "
           "AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);\n")
    marker = "-- " + chr(167) + "7  The overlay asserts its own shape"
    i = s.index(marker)
    # before section 7, so section 7 sees it and E(4) can fire
    j = s.rindex("-- ---------------------------------------------------------------------\n", 0, i)
    return s[:j] + add + s[j:]


def drop_preferences_tenant_key(s):
    """Drop the ONE tenant key the old hardcoded enumeration left out.

    Round 12, R-3: the challenger's own plant. With the old T2 this was green at
    `PASS 5 = 5` while a preference carrying another tenant was accepted behind
    the policy, and mutant 4 did not reach it because it targets the
    notification's key alone. A mutant per relation would go stale the same way
    the list did, so T2 now derives the set from the catalogue — and this mutant
    is the proof that the derivation reaches a relation no case names.
    """
    old = ("  CONSTRAINT prefs_tenant_fk\n"
           "    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)")
    if old not in s:
        # The constraint may be written on one line; try that spelling too and
        # fail loudly rather than returning the text unchanged, which would look
        # like a mutant that reds nothing.
        one = "CONSTRAINT prefs_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)"
        assert one in s, "prefs_tenant_fk was not found in either spelling"
        return s.replace(one, "CONSTRAINT prefs_business_only_fk FOREIGN KEY (business_id) REFERENCES businesses (id)")
    return s.replace(old, "  CONSTRAINT prefs_business_only_fk\n"
                          "    FOREIGN KEY (business_id) REFERENCES businesses (id)")


def drop_obligation_once(s):
    """Remove the unique the race contends for.

    Round 12: the restored I-1 race is only evidence if the key it races for is
    what refuses the loser. With this dropped both connections commit, two rows
    carry one obligation, and the race must report FAIL rather than pass with a
    different survivor count.
    """
    old = "  CONSTRAINT notifications_obligation_once UNIQUE (business_id, obligation_key),"
    assert old in s, "the obligation unique was not found"
    return s.replace(old, "  -- mutant: the obligation unique is gone", 1)


def grant_quarantine(s):
    """Make the unattributed quarantine readable by a business-tier role."""
    old = "GRANT INSERT ON notification_provider_quarantine TO daftar_worker;"
    assert old in s, "the quarantine grant was not found"
    return s.replace(old, old + "\nGRANT SELECT ON notification_provider_quarantine TO daftar_app;")



def drop_arrival_release_term(s):
    """Remove the arrival conjunct from I-8f's partial index.

    ROUND 22, OD-P8-14. This is the N-6 subject, and until this round NOTHING
    in gate 6 removed it: `arrival_domain_drift` above mutates the arrival CHECK
    on the relation, which is a different sentence. With this term gone, a
    delivery that the customer HAD received and that later failed verification
    leaves the partial index, the obligation is released, and a second channel
    opens — the customer is told twice. Case N6-e is the one that must red.
    """
    old = ("AND NOT (delivery_state = 'closed' AND final_status = 'failed'\n"
           "             AND final_status_verified AND NOT arrival_ever_recorded)")
    assert old in s, "the I-8f release conjunct was not found in the shape this mutant edits"
    return s.replace(old, ("AND NOT (delivery_state = 'closed' AND final_status = 'failed'\n"
                           "             AND final_status_verified)"), 1)


def drop_status_monotonic(s):
    """Remove the monotonic-status trigger and leave its functions in place.

    ROUND 24, O-4. The ladder was a DATABASE rule with no database case: six
    vitest files exercise it in TypeScript, where no `UPDATE` ever reaches a
    trigger, so dropping this trigger reddened nothing. `I3-d` (read -> sent) is
    the case that must red, and it reds by its own label: without the trigger a
    regression is simply accepted, because the CHECK constraint admits every
    token on the ladder in any order.
    """
    import re
    m = re.search(r"CREATE TRIGGER notifications_status_monotonic[^;]*;", s)
    assert m, "the monotonic status trigger was not found"
    return s[:m.start()] + s[m.end():]


def widen_worker_update_grant(s):
    """Give the worker UPDATE on the whole relation instead of three columns.

    ROUND 24, O-4. `W-2` asserts that the worker cannot rewrite an obligation
    key, and the only thing that refuses it is the column list in this GRANT —
    no trigger and no policy says anything about that column. Until this mutant
    existed, deleting the column list reddened nothing.
    """
    old = "GRANT UPDATE (status, last_error_code, updated_at) ON notifications TO daftar_worker;"
    assert old in s, "the worker's column-scoped UPDATE grant was not found in the shape this mutant edits"
    return s.replace(old, "GRANT UPDATE ON notifications TO daftar_worker;", 1)


MUTANTS = {
    "1":  [drop_restrictive],
    "1b": [drop_restrictive, blind_sec7],
    "2":  [guc_bypass],
    "2b": [guc_bypass, blind_sec7],
    "3":  [deny_list_membership],
    "4":  [drop_tenant_key],
    "5":  [status_domain_drift],
    "6":  [arrival_domain_drift],
    "7":  [drop_truncate_guard],
    "8":  [unisolate_settings],
    "8b": [unisolate_settings, blind_sec7],
    "9":  [grant_quarantine],
    "9b": [grant_quarantine, blind_sec7],
    "10":  [isolate_quarantine],
    "10b": [isolate_quarantine, blind_sec7],
    "11":  [drop_preferences_tenant_key],
    "12":  [drop_obligation_once],
    "13":  [drop_arrival_release_term],
    "14":  [drop_status_monotonic],
    "15":  [widen_worker_update_grant],
}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in MUTANTS:
        sys.stderr.write("usage: p8-mutants.py <%s> <path>\n" % "|".join(sorted(MUTANTS)))
        return 2
    mid, path = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as fh:
        before = fh.read()
    after = before
    for fn in MUTANTS[mid]:
        after = fn(after)
    if after == before:
        sys.stderr.write("mutant %s changed nothing\n" % mid)
        return 1
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(after)
    return 0


if __name__ == "__main__":
    sys.exit(main())
