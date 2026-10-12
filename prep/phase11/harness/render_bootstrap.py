"""Render infrastructure/database/bootstrap.sql's password placeholders.

Why this is a FILE and not four lines inside rebuild_and_prove.sh any more:
finding P3-N03.1 of the second independent challenge. The in-script version
ended with

    assert "__" not in re.sub(r"--[^\n]*","",s).replace("__","") or True

which is inert twice over: `X or True` is always true, and `.replace("__","")`
deletes the very substring the test looks for. The challenger measured it on
a bootstrap carrying a placeholder outside the `_DB_PASSWORD__` shape: the
renderer printed "1 placeholders substituted", exited 0, and wrote
`__NEWROLE_PASSWORD__` through unrendered. Harmless at this head, because all
eight of bootstrap.sql's placeholders match the pattern — and it would fail
confusingly the day one does not.

It is the THIRD inert mechanism in this pack's history, after the
canonicalizer's `ORDER BY k` and race B2's unregistered axis value, so the
lesson is taken as a rule rather than as a typo: **anything shaped like a
check needs a case that fails it.** Hence `--selftest` below, which the
harness runs BEFORE it renders anything: it feeds the renderer a synthetic
bootstrap carrying an unmatched placeholder and requires exit 1, and a clean
one and requires exit 0. If the check ever goes inert again, the selftest
goes red and the run stops before a cluster exists.

The substituted values are scratch-only and the cluster takes no TCP
connection; rendering lives in the repository because a proof whose setup is
not in its own repository is reproducible by its author only (P2-09).
"""
import re, subprocess, sys, tempfile, os

PLACEHOLDER = re.compile(r"__([A-Z_]+)_DB_PASSWORD__")
ANY_PLACEHOLDER = re.compile(r"__[A-Z][A-Z0-9_]*__")


def render(src, dst):
    s = open(src).read()
    s, n = PLACEHOLDER.subn(lambda m: "p11_scratch_" + m.group(1).lower() + "_pw", s)
    # The real check: no placeholder-shaped token survives, read on the SQL
    # with its line comments stripped so a comment that talks about one is
    # not a failure. No `or True`, and nothing deleted from the text first.
    left = sorted(set(ANY_PLACEHOLDER.findall(re.sub(r"--[^\n]*", "", s))))
    if left:
        print("UNRENDERED PLACEHOLDERS, refusing to write %s: %s" % (dst, ", ".join(left)))
        return 1
    open(dst, "w").write(s)
    print("bootstrap rendered: %d placeholders substituted, 0 left" % n)
    return 0


def selftest():
    """The case that fails. Two synthetic bootstraps, one of each kind."""
    ok = True
    with tempfile.TemporaryDirectory() as d:
        bad = os.path.join(d, "bad.sql")
        open(bad, "w").write(
            "-- a comment mentioning __SOME_DB_PASSWORD__ is not a failure\n"
            "ALTER ROLE daftar_app PASSWORD '__APP_DB_PASSWORD__';\n"
            "ALTER ROLE newrole   PASSWORD '__NEWROLE_PASSWORD__';\n")
        rc = render(bad, os.path.join(d, "bad.out"))
        wrote = os.path.exists(os.path.join(d, "bad.out"))
        print("  selftest RED case  : rc=%d, output written=%s -> %s"
              % (rc, wrote, "RED as required" if rc == 1 and not wrote else "**SELFTEST FAILED: the check is inert**"))
        ok = ok and rc == 1 and not wrote

        good = os.path.join(d, "good.sql")
        open(good, "w").write("ALTER ROLE daftar_app PASSWORD '__APP_DB_PASSWORD__';\n")
        rc = render(good, os.path.join(d, "good.out"))
        body = open(os.path.join(d, "good.out")).read() if os.path.exists(os.path.join(d, "good.out")) else ""
        green = rc == 0 and "p11_scratch_app_pw" in body and "__" not in body
        print("  selftest GREEN case: rc=%d -> %s" % (rc, "renders and passes" if green else "**SELFTEST FAILED: a clean bootstrap was refused**"))
        ok = ok and green
    return 0 if ok else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        sys.exit(selftest())
    sys.exit(render(sys.argv[1], sys.argv[2]))
