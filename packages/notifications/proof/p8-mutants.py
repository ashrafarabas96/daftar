#!/usr/bin/env python3
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


def grant_quarantine(s):
    """Make the unattributed quarantine readable by a business-tier role."""
    old = "GRANT INSERT ON notification_provider_quarantine TO daftar_worker;"
    assert old in s, "the quarantine grant was not found"
    return s.replace(old, old + "\nGRANT SELECT ON notification_provider_quarantine TO daftar_app;")


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
    "9":  [grant_quarantine],
    "9b": [grant_quarantine, blind_sec7],
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
