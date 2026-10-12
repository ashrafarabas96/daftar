#!/usr/bin/env python3
"""
Phase 10 — run the five gates as ONE identified run, and DERIVE the handoff's
run-identity table from the log that run produced.

Why this script exists, in one sentence: the independent challenge at `b40f05c`
found the manifest's run-identity table stating Node v24.21.0 while the raw log
it cited on the line above said v22.22.0 — the number had been typed beside the
log instead of read out of it, and the only evidence run the pack had was made
on a runtime `package.json` forbids.

So the table is no longer writable by hand. `--emit` prints it, and every cell
in it is PARSED BACK OUT of the log file on disk after the run finished: the
runtime from the log's own `node:` line, each exit code from that command's own
`--- exit code:` line, the counts from the test output the run captured. A value
that is not in the log cannot appear in the table.

`--check` re-derives the table from the log and compares it with the table in
the manifest, exiting 1 when they have drifted. A handoff that cannot detect its
own expiry will lie, and this is the detector.

Usage, from the repository root:
    python3 phase-preparation/phase10/proofs/record-run.py --run --node /path/to/node
    python3 phase-preparation/phase10/proofs/record-run.py --emit  <log>
    python3 phase-preparation/phase10/proofs/record-run.py --check <log> <manifest>
"""
import argparse
import datetime
import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
PKG = "phase-preparation/phase10"

GATES = [
    ("T0 format", ["npx", "prettier", "--check", PKG]),
    ("T0 lint", ["npx", "eslint", "--max-warnings", "0", PKG]),
    ("T0 typecheck", ["npx", "tsc", "-p", f"{PKG}/tsconfig.json", "--noEmit"]),
    ("T1 unit", ["npx", "vitest", "run", "--config", f"{PKG}/vitest.config.ts"]),
    ("T1 red proofs", ["python3", f"{PKG}/proofs/red-proofs.py"]),
    ("T1 gate self-test", ["python3", f"{PKG}/proofs/record-run.py", "--self-test"]),
]


def git(*args: str) -> str:
    """Run git, or abort.

    This used to return stdout and ignore the exit code. Every caller below
    treats an empty string as "the tree is clean", so a git that failed — a
    broken index, a missing repository, a permission error — read as a clean
    tree and a run made on an unknown tree rendered as evidence. The cleanup
    report is load-bearing, so git failing is a reason to stop, not a reason
    to assume the good case.
    """
    proc = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(f"FAIL: `git {' '.join(args)}` exited {proc.returncode}; the state of the tree is unknown, so this run records nothing", file=sys.stderr)
        print(proc.stderr.strip(), file=sys.stderr)
        raise SystemExit(2)
    return proc.stdout.strip()


CHILD = "| "  # every line of a child's output is written behind this


def child_lines(out: str) -> list[str]:
    """A child's output, made unable to impersonate the recorder.

    THE DEFECT THIS CLOSES. Everything the run-identity table states used to
    be parsed out of a log that mixed the recorder's own lines with the raw
    output of the programs it ran — at the same margin, in the same file. So
    a *test* could print a line shaped like a recorder line and the table
    believed it. The coordinator's review at `80b8ddc` built the whole frame
    in one `throw`: an exit-code footer, a test-file count, a case count and
    a red-proof PASS line. Two gates really exited 1; the table printed six
    zeros, the right counts and 88 laws; `--check` said the run succeeded.
    The challenger's earlier version of this was rated P3 because the
    forged cell was "saved by its neighbours" — but the neighbours were
    first-match-anywhere parses too, and the same print forged them.

    Moving the match was not the answer; the class had to go. Now every line
    a child writes is prefixed, so it cannot start at column 0, and the
    parser reads ONLY column-0 lines. There is no spelling a child can emit
    that reaches the table, because the one thing it cannot do is unwrite the
    prefix in front of it.
    """
    flat = out.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
    return [CHILD + line for line in flat.split("\n")]


def gate_measurements(label: str, returncode: int, out: str) -> list[str]:
    """The counts this gate reports, written as RECORDER-owned lines.

    Two rules, both learned from the same review. A gate that FAILED reports
    no figures at all: a failing suite's output is exactly where a forged
    count would sit, and a count from a run that did not pass is not a
    measurement of anything. And the match is the LAST one in this gate's own
    output, never the first anywhere in the log, because a summary comes
    after the thing it summarises.

    A third rule, from the challenger's round 7. The figures used to be read
    out of `stdout + stderr`, a concatenation in which ALL of stderr follows
    ALL of stdout and therefore follows the suite's own summary: a committed,
    passing test that writes a summary-shaped line to stderr became the last
    match and owned the cell. The stream is now stdout alone, but the stream
    was never the defect — picking one figure out of several was. So an
    AMBIGUOUS count is refused outright: when a gate's output carries more
    than one DISTINCT figure for a cell, the cell is ABSENT and the run is
    not evidence. Forgery then costs the forger the run instead of buying
    them a number, and the rule holds whatever order the streams arrive in.

    These figures remain the child's own words, read by the recorder out of
    the one block that owns them. The exit code beside them is the
    recorder's.
    """
    wanted = {
        "T1 unit": [("test_files", r"^\s*Test Files\s+(\d+) passed \(\d+\)$"), ("cases", r"^\s*Tests\s+(\d+) passed \(\d+\)$")],
        "T1 red proofs": [("laws", r"^PASS red-proofs: (\d+) law\(s\)")],
    }.get(label, [])
    out_lines: list[str] = []
    for name, pattern in wanted:
        if returncode != 0:
            out_lines.append(f"{name}: ABSENT — the gate that reports it exited {returncode}")
            continue
        found = re.findall(pattern, out, re.M)
        distinct = sorted(set(found))
        if not found:
            out_lines.append(f"{name}: ABSENT")
        elif len(distinct) > 1:
            out_lines.append(
                f"{name}: ABSENT \u2014 this gate's output carries {len(distinct)} different figures for it"
            )
        else:
            out_lines.append(f"{name}: {found[-1]}")
    return out_lines


def run_verdict(before: str, after: str, exits: list[int]) -> int:
    """`--run`'s own exit code: 0 only if nothing at all went wrong.

    It used to be 0 whatever happened: a gate could fail, or the tree could
    end dirty or start dirty, and the recorder would say nothing to its
    caller or to CI. An evidence tool that cannot fail is not a gate.

    It is a function of its own, and not three lines woven through the loop,
    so that each of the three rules can be deleted in a self-test and the
    deletion seen. The dirty-START rule in particular had no case at the run
    layer: `--check` refused such a run, `--run` also exited 1, and only the
    first was measured (challenger round 7, P3-01).
    """
    if before != "":
        return 1
    if after != "":
        return 1
    if any(code != 0 for code in exits):
        return 1
    return 0


def do_run(node_bin: pathlib.Path, out_dir: pathlib.Path) -> tuple[pathlib.Path, int]:
    if not node_bin.exists():
        print(f"FAIL: no node at {node_bin}", file=sys.stderr)
        raise SystemExit(2)
    node_version = subprocess.run([str(node_bin), "-v"], capture_output=True, text=True, check=True).stdout.strip()
    started = datetime.datetime.now(datetime.timezone.utc)
    run_id = "P10-" + started.strftime("%Y%m%dT%H%M%SZ")
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / f"{run_id}.log"

    env = dict(os.environ)
    env["PATH"] = f"{node_bin.parent}:{env.get('PATH', '')}"
    env["CI"] = "1"
    env["FORCE_COLOR"] = "0"

    # The runtime the gates will actually resolve, probed by the RECORDER
    # through the environment it is about to hand them — not printed by a
    # child and read back. Prepending a directory to PATH only helps when the
    # binary in it is named `node`, so `--node /somewhere/node20` can leave
    # the gates on a different runtime entirely; that is what this line
    # measures and what `not_evidence` refuses when the two disagree.
    resolved = shutil.which("node", path=env["PATH"])
    in_child = subprocess.run([resolved, "-v"], capture_output=True, text=True, check=False, env=env).stdout.strip() if resolved else ""

    before = git("status", "--porcelain")
    if before != "":
        print("FAIL: the tree is DIRTY before the run; what the gates measure is not what is committed:")
        print(before)
    lines = [
        f"run_id:      {run_id}",
        f"subject:     {PKG} (Phase 10 restaurant pack, pure package)",
        f"source_sha:  {git('rev-parse', 'HEAD')}",
        f"branch:      {git('rev-parse', '--abbrev-ref', 'HEAD')}",
        f"tree:        {'clean' if before == '' else 'DIRTY'}",
        f"node:        {node_version}",
        f"node_bin:    {node_bin}",
        f"node_in_child: {in_child or 'ABSENT'}" + (f" ({resolved})" if resolved else ""),
        f"cwd:         {ROOT}",
        f"started_utc: {started.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "database:    none — this package starts no PostgreSQL cluster and connects to none",
        f"note:        every line below beginning `{CHILD}` is a child's own output, which the parser does not read",
        "note:        a gate's lines are its stdout, then its stderr under `--- stderr:`; counts are measured from stdout alone",
        "",
    ]
    codes: list[int] = []
    for label, cmd in GATES:
        lines.append(f"=== command: {' '.join(cmd)}")
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env, check=False)
        # The two streams are written as two labelled blocks. Concatenating
        # them cost two things: a stdout that did not end in a newline merged
        # its last line into stderr's first, and the log could not say which
        # stream a line came from. Neither block is parsed — both are
        # prefixed — but the measurement below reads stdout alone, so the log
        # has to show which lines that was.
        lines += child_lines(proc.stdout)
        if proc.stderr != "":
            lines.append("--- stderr:")
            lines += child_lines(proc.stderr)
        lines.append(f"--- exit code: {proc.returncode}")
        lines += gate_measurements(label, proc.returncode, proc.stdout)
        lines.append("")
        codes.append(proc.returncode)
        print(f"{'ok  ' if proc.returncode == 0 else 'FAIL'} {' '.join(cmd)} -> exit {proc.returncode}")
    # The red-proof harness plants defects in `src/` and restores them in a
    # `finally`. A `finally` does not run if the process is killed, and a
    # planted defect left behind is both a corrupt tree and — far worse — a
    # defect that could be committed as if it were the work. So the run states
    # whether the tree it finished on is the tree it started on.
    after = git("status", "--porcelain")
    lines.append(f"tree_after:  {'clean' if after == '' else 'DIRTY'}")
    if after != "":
        lines += child_lines(after)
        print("FAIL: the tree is DIRTY after the run; a planted mutation may have survived:")
        print(after)
    ended = datetime.datetime.now(datetime.timezone.utc)
    lines.append(f"ended_utc:   {ended.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    log_path.write_text("\n".join(lines) + "\n")
    print(f"log: {log_path}")
    # The exit code is the run's own verdict. It used to be 0 whatever
    # happened: a gate could fail, or the tree could end dirty or start
    # dirty, and the recorder would say nothing to its caller or to CI. An
    # evidence tool that cannot fail is not a gate.
    return log_path, run_verdict(before, after, codes)


def derive(log_path: pathlib.Path) -> dict[str, str]:
    """Every value below is read out of the log's RECORDER-OWNED lines.

    Recorder-owned means: written by `do_run` itself, at column 0. Every
    child line in the log carries the `| ` prefix, so nothing a gate prints
    can be read here — which is the whole of the fix for the forged frame the
    coordinator's review at `80b8ddc` measured. The patterns below are
    anchored at `^` for that reason, and the counts come from the recorder's
    own `test_files:` / `cases:` / `laws:` lines rather than from anywhere a
    summary happens to appear.
    """
    text = log_path.read_text()

    def field(name: str, last: bool = False) -> str:
        found = re.findall(rf"^{name}:[ \t]+(.*)$", text, re.M)
        if not found:
            return "ABSENT"
        return (found[-1] if last else found[0]).strip()

    exits = {}
    for label, cmd in GATES:
        joined = re.escape(" ".join(cmd))
        # Bounded at BOTH ends of the record (LAW 16). Tempered against the
        # next header, so a gate whose own footer is missing reads ABSENT
        # instead of borrowing its neighbour's; greedy within the block, so
        # the recorder's own footer — always written after the child's output
        # — is the one that wins. Neither edge is load-bearing any more now
        # that a child cannot write at column 0, and both are kept: a defence
        # that costs nothing is not removed because another one arrived.
        m = re.search(rf"^=== command: {joined}$(?:(?!^=== command: ).)*^--- exit code: (-?\d+)$", text, re.M | re.S)
        exits[label] = m.group(1) if m else "ABSENT"
    return {
        "run_id": field("run_id"),
        "source_sha": field("source_sha"),
        "tree": field("tree"),
        # LAST, and after the final gate: the tree's end state is the last
        # thing the recorder writes about the tree.
        "tree_after": field("tree_after", last=True),
        "node": field("node"),
        # Probed by the recorder through the environment it hands the gates,
        # so the runtime is measured rather than reported by a child.
        "node_in_child": field("node_in_child"),
        "database": field("database"),
        "log_name": log_path.name,
        "log_sha256": digest_of(log_path.read_bytes()),
        "files": field("test_files"),
        "cases": field("cases"),
        "laws": field("laws"),
        "exits": " · ".join(f"{label.split()[-1]} {exits[label]}" for label, _ in GATES),
        "exits_by_label": exits,
    }


ENGINES_MAJOR = 24  # `package.json`: "engines": { "node": ">=24 <25" }


def not_evidence(d: dict[str, str]) -> list[str]:
    """Why this run is not evidence — empty when it is.

    `--check` used to test only that the manifest AGREED with the log. A run
    whose proofs exited 1, or that finished on a DIRTY tree, agreed with its
    own table perfectly and passed. Consistency is not success: the manifest's
    own rule is that a run finishing on a dirty tree is not evidence, and
    until now no gate enforced it.
    """
    reasons: list[str] = []
    for label, _cmd in GATES:
        got = d["exits_by_label"][label]
        if got != "0":
            reasons.append(f"the gate `{label}` exited {got}")
    # `engines` is `>=24 <25`: a floor alone lets a major above the range
    # through, and "a runtime engines allows" is the claim §13b makes.
    version = d["node_in_child"].split()[0] if d["node_in_child"] not in ("", "ABSENT") else ""
    major = re.match(r"^v(\d+)\.", version)
    if major is None:
        reasons.append("the log does not record a readable runtime for the gates")
    elif int(major.group(1)) != ENGINES_MAJOR:
        reasons.append(f"the gates ran on {version}, outside `engines` (>=v{ENGINES_MAJOR} <v{ENGINES_MAJOR + 1})")
    # Prepending a directory to PATH only helps when the binary in it is
    # named `node`. `--node /somewhere/node20` therefore reports v20 in one
    # cell while the gates resolve something else entirely; the two cells
    # must name the same runtime or the table is describing two different
    # runs.
    if version != "" and d["node"] not in ("", "ABSENT") and d["node"] != version:
        reasons.append(f"the recorder was given {d['node']} but the gates resolved {version}")
    if d["tree"] != "clean":
        reasons.append(f"the tree was {d['tree']} when the run started")
    if d["tree_after"] != "clean":
        reasons.append(f"the tree was {d['tree_after']} when the run ended — a planted defect may still be in it")
    for cell in ("run_id", "source_sha", "node", "node_in_child", "files", "cases", "laws"):
        if d[cell].startswith("ABSENT"):
            reasons.append(f"the log carries no `{cell}`, so that cell of the table measures nothing")
    return reasons


def check_run(log: pathlib.Path, manifest: pathlib.Path) -> int:
    """The run-identity gate: the run succeeded, AND the table says what the log says."""
    derived = derive(log)
    reasons = not_evidence(derived)
    if reasons:
        print(f"FAIL: {log.name} did not succeed, so nothing derived from it is evidence")
        for reason in reasons:
            print(f"  - {reason}")
        return 1
    want = table(derived)
    have = manifest.read_text()
    if MARK_BEGIN not in have or MARK_END not in have:
        print(f"FAIL: {manifest} carries no generated run-identity block", file=sys.stderr)
        return 1
    block = have[have.index(MARK_BEGIN) : have.index(MARK_END) + len(MARK_END)]
    if block.strip() != want.strip():
        print("FAIL: the manifest's run-identity table has drifted from the log it cites")
        for a, b in zip(block.splitlines(), want.splitlines()):
            if a != b:
                print(f"  manifest: {a}\n  log says: {b}")
        return 1
    print(f"ok   run identity in {manifest.name} is derived from {log.name} and matches, and that run succeeded")
    return 0


MARK_BEGIN = "<!-- RUN-IDENTITY:BEGIN (generated by proofs/record-run.py --emit; do not edit by hand) -->"
MARK_END = "<!-- RUN-IDENTITY:END -->"


def counts(d: dict[str, str]) -> str:
    """The Counts cell, which must stay a sentence when a figure is missing.

    Interpolating an ABSENT cell straight into the sentence produced
    `ABSENT — the gate that reports it exited 1 test files, …`: a published
    table shape reading as a mangled run-on. A missing figure now says so in
    its own clause, and the reason is kept.
    """
    parts = []
    for cell, noun in (("files", "test files"), ("cases", "cases"), ("laws", "red-proof laws")):
        value = d[cell]
        parts.append(f"{noun}: {value}" if value.startswith("ABSENT") else f"{value} {noun}")
    return " · ".join(parts)


def table(d: dict[str, str]) -> str:
    return "\n".join(
        [
            MARK_BEGIN,
            "",
            "| | |",
            "|---|---|",
            f"| **Run ID** | `{d['run_id']}` |",
            f"| **Log** | `runs/{d['log_name']}` (in this folder), SHA256 `{d['log_sha256']}` |",
            f"| **Source SHA** | `{d['source_sha']}`, tree **{d['tree']}** at the start, **{d['tree_after']}** at the end |",
            f"| **Node** | {d['node']} |",
            f"| **Node, inside the red-proof child** | {d['node_in_child']} |",
            f"| **Database** | {d['database']} |",
            f"| **Counts** | {counts(d)} |",
            f"| **Exit codes** | {d['exits']} |",
            "",
            MARK_END,
        ]
    )


_K = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
]


def sha256_independent(data: bytes) -> str:
    """SHA-256 (FIPS 180-4) written out here, sharing no line with `hashlib`.

    The fourth independent challenge measured where `--self-test` stops. It is
    a real gate over WHICH files are hashed — the basename decoy, the
    non-recursive walk and the deleted file are all caught — and no gate at
    all over HOW. Substituting md5 for sha256, or truncating the digest to 16
    characters, left `--emit-digests`, `--check-digests` and `--self-test` all
    green, because one function generates and verifies and a wrong hash is
    wrong identically on both sides. Two gates then certified a table with no
    SHA256 in it, under a column headed SHA256.

    A second enumerator would add nothing the self-test already covers. A
    second HASHER covers the half nothing else does, so every digest below is
    computed twice, by two implementations, and a disagreement is fatal.
    """
    mask = 0xFFFFFFFF
    h = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]
    msg = bytearray(data)
    length = (8 * len(data)) & 0xFFFFFFFFFFFFFFFF
    msg.append(0x80)
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += length.to_bytes(8, "big")
    rotr = lambda x, n: ((x >> n) | (x << (32 - n))) & mask
    for off in range(0, len(msg), 64):
        w = [int.from_bytes(msg[off + 4 * i : off + 4 * i + 4], "big") for i in range(16)]
        for i in range(16, 64):
            s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
            s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
            w.append((w[i - 16] + s0 + w[i - 7] + s1) & mask)
        a, b, c, d, e, f, g, hh = h
        for i in range(64):
            s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
            ch = (e & f) ^ (~e & g)
            t1 = (hh + s1 + ch + _K[i] + w[i]) & mask
            s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
            maj = (a & b) ^ (a & c) ^ (b & c)
            t2 = (s0 + maj) & mask
            hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & mask, c, b, a, (t1 + t2) & mask
        h = [(x + y) & mask for x, y in zip(h, [a, b, c, d, e, f, g, hh])]
    return "".join(f"{x:08x}" for x in h)


def digest_of(data: bytes) -> str:
    """One digest, computed twice, by two implementations that share nothing."""
    library = hashlib.sha256(data).hexdigest()
    written_out = sha256_independent(data)
    if library != written_out:
        print("FAIL: the two hash implementations disagree, so neither can be trusted to name a file", file=sys.stderr)
        print(f"  hashlib:     {library}", file=sys.stderr)
        print(f"  written out: {written_out}", file=sys.stderr)
        raise SystemExit(2)
    return library


CHALLENGER_OWNED = re.compile(r"(?:^|/)P10-CHALLENGE-[0-9a-f]{7,40}\.md$")

DIGESTS_BEGIN = "<!-- DIGESTS:BEGIN (generated by proofs/record-run.py --emit-digests; do not edit by hand) -->"
DIGESTS_END = "<!-- DIGESTS:END -->"


def digest_rows(folder: pathlib.Path, manifest_name: str) -> str:
    """Hash every file in the handoff folder except the manifest itself.

    The last hand-computed artifact in the pack. The second challenge recorded
    it as an observation rather than a finding — nothing was wrong on the day,
    and the author claimed no gate there — but P3-06's lesson was learned on
    exactly this table, and a table maintained by hand is a table that goes
    stale between the hand and the eye. A file cannot carry its own digest, so
    the manifest is excluded and everything else is listed.
    """
    # Excluded by PATH, not by basename. Excluding by name skipped every file
    # anywhere in the tree sharing the manifest's name — `runs/<manifest>.md`
    # would be hashed by nothing and reported by nothing, and this function
    # then told the reader "no file is unlisted", which was the one claim that
    # was false. The same function produced the omission and confirmed it.
    excluded = (folder / manifest_name).resolve()
    files = sorted(f for f in folder.rglob("*") if f.is_file() and f.resolve() != excluded)
    rows = [DIGESTS_BEGIN, "", "| Document | SHA256 |", "|---|---|"]
    for f in files:
        rel = f.relative_to(folder).as_posix()
        rows.append(f"| `{rel}` | `{digest_of(f.read_bytes())}` |")
    rows += ["", DIGESTS_END]
    return "\n".join(rows)


def listed_names(block: str) -> dict[str, str]:
    return dict(l.split("` | `") for l in block.splitlines() if l.startswith("| `") and "` | `" in l)


def check_digests(manifest: pathlib.Path) -> int:
    folder = manifest.parent
    want = digest_rows(folder, manifest.name)
    have = manifest.read_text()
    if DIGESTS_BEGIN not in have or DIGESTS_END not in have:
        print(f"FAIL: {manifest} carries no generated digest block", file=sys.stderr)
        return 1
    block = have[have.index(DIGESTS_BEGIN) : have.index(DIGESTS_END) + len(DIGESTS_END)]
    current = listed_names(want)
    if block.strip() == want.strip():
        print(f"ok   every digest in {manifest.name} matches the file it names, and no file is unlisted")
        return 0
    listed_now = listed_names(block)
    unlisted_reports = [n for n in current if n not in listed_now and CHALLENGER_OWNED.search(n.strip("| `"))]
    # `current.get`, not `current[n]`: a listed file that has been DELETED is
    # absent from `current`, and indexing raised a KeyError that lost the
    # diagnostic. It failed closed, which is why it was a residual and not a
    # finding, but a gate that fails with a traceback tells the reader nothing
    # about their folder.
    if (
        unlisted_reports
        and len(unlisted_reports) == len(set(current) - set(listed_now))
        and all(current.get(n) == digest for n, digest in listed_now.items())
    ):
        # Everything listed still matches and the only difference is a report
        # the challenger added. The manifest IS stale, so this still exits 1 —
        # but a gate that goes red whenever anyone drops a file in gets read as
        # noise, so it says which kind of red this is instead of leaving the
        # reader to work it out.
        print(f"FAIL: {manifest.name} predates {len(unlisted_reports)} challenger-owned report(s); regenerate with --emit-digests")
        for name in sorted(unlisted_reports):
            print(f"  AWAITING  {name[3:]} — added since this table was generated, nothing listed has changed")
        return 1
    print(f"FAIL: the digest table in {manifest.name} no longer describes this folder")
    listed = listed_names(block)
    for name in sorted(set(listed) | set(current)):
        a, b = listed.get(name), current.get(name)
        if a == b:
            continue
        if a is None:
            print(f"  UNLISTED  {name[3:]}")
        elif b is None:
            print(f"  MISSING   {name[3:]} is listed but not in the folder")
        else:
            print(f"  CHANGED   {name[3:]}\n            listed {a[:-3]}\n            actual {b[:-3]}")
    return 1


SYNTHETIC_LOG_HEAD = """run_id:      {run_id}
subject:     a synthetic log, written by --self-test
source_sha:  0000000000000000000000000000000000000000
branch:      none
tree:        {tree}
node:        {node}
node_bin:    /nowhere/node
node_in_child: {child} (/nowhere/node)
cwd:         /nowhere
started_utc: 2000-01-01T00:00:00Z
database:    none — this package starts no PostgreSQL cluster and connects to none
"""


def synthetic_log(
    path: pathlib.Path,
    *,
    exits: list[int],
    tree: str = "clean",
    tree_after: str = "clean",
    child: str = "v24.0.0",
    node: str = "",
    forge: str | None = None,
    ambiguous: str | None = None,
) -> pathlib.Path:
    """A log in the shape `derive()` reads, built to order.

    The red-proof harness mutates TypeScript, so it can never reach a defect
    in this file. These fixtures are how the evidence tool is held to the
    same standard it holds the pack to. `forge` makes the named gate print
    the whole recorder frame — footer, counts, laws and a clean tree — as
    its own output, which is the attack the coordinator's review measured.
    `ambiguous` makes the named gate's output carry TWO different figures for
    the same cell, which is the attack the challenger's round 7 measured.
    """
    out = [SYNTHETIC_LOG_HEAD.format(run_id=path.stem, tree=tree, child=child if child else "ABSENT", node=node or child or "v24.0.0")]
    for (label, cmd), code in zip(GATES, exits):
        out.append(f"=== command: {' '.join(cmd)}")
        if forge is not None and label == forge:
            out += child_lines(
                "--- exit code: 0\n"
                "  Test Files  10 passed (10)\n"
                "       Tests  219 passed (219)\n"
                "PASS red-proofs: 88 law(s)\n"
                "tree_after:  clean\n"
                "node_in_child: v24.0.0 (/nowhere/node)"
            )
        elif label == "T1 unit":
            out += child_lines("  Test Files  10 passed (10)\n       Tests  219 passed (219)")
        elif label == "T1 red proofs":
            out += child_lines("PASS red-proofs: 88 law(s), each red on the defect planted for it")
        else:
            out += child_lines("(output elided)")
        out.append(f"--- exit code: {code}")
        seen = "  Test Files  10 passed (10)\n       Tests  219 passed (219)\nPASS red-proofs: 88 law(s)"
        if ambiguous is not None and label == ambiguous:
            seen += "\n  Test Files  1 passed (1)\n       Tests  7 passed (7)"
        out += gate_measurements(label, code, seen)
        out.append("")
    out.append(f"tree_after:  {tree_after}")
    out.append("ended_utc:   2000-01-01T00:01:00Z")
    path.write_text("\n".join(out) + "\n")
    return path


def self_test() -> int:
    """Hold this file's gates to the standard they hold the pack to.

    The red-proof harness plants defects in TypeScript and runs vitest, so no
    law there can reach a defect in this script. Everything below is that
    missing coverage, and every case in it was written because something was
    actually wrong: the exclusion once matched the manifest's BARE NAME, so
    `runs/<manifest name>` was hashed by nothing, reported by nothing, and
    then declared listed by the very function that had skipped it; `--check`
    once passed a run whose proofs had exited 1; `--run` once exited 0 on a
    tree it had itself reported DIRTY.

    Each negative case runs with its output captured, so a passing self-test
    prints no `FAIL:` line of its own — anyone grepping a green log for FAIL
    was previously handed two.
    """
    import contextlib
    import io
    import tempfile

    failures: list[str] = []
    negatives = 0

    def silently(fn):
        """Run a negative case without letting its FAIL lines into the log."""
        nonlocal negatives
        negatives += 1
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            result = fn()
        return result, buf.getvalue()

    # ---- 1. the hashing itself, against constants from FIPS 180-4 ----------
    # A literal is the only check neither implementation can satisfy by
    # agreeing with the other. md5, a truncation and a wrong algorithm all
    # fail here whichever side they are planted on.
    vectors = {
        b"": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        b"abc": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        b"a" * 1000: "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    }
    for data, expected in vectors.items():
        if sha256_independent(data) != expected:
            failures.append(f"the written-out SHA-256 does not match the published digest of {len(data)} byte(s)")
        if hashlib.sha256(data).hexdigest() != expected:
            failures.append(f"hashlib's SHA-256 does not match the published digest of {len(data)} byte(s)")
        if digest_of(data) != expected:
            failures.append(f"the digest actually written into the table is not the SHA-256 of {len(data)} byte(s)")

    with tempfile.TemporaryDirectory(prefix="p10-gate-selftest-") as tmp:
        folder = pathlib.Path(tmp)

        # ---- 2. the digest gate: WHICH files are hashed --------------------
        manifest = folder / "MANIFEST.md"
        manifest.write_text("# m\n\nplaceholder, so the exclusion has a real file to exclude\n")
        (folder / "runs").mkdir()
        decoy = folder / "runs" / "MANIFEST.md"  # same basename, different path
        decoy.write_text("a file that shares the manifest's name but is not the manifest\n")
        (folder / "doc.md").write_text("abc")  # a known digest, checked below

        rows = digest_rows(folder, manifest.name)
        if "`runs/MANIFEST.md`" not in rows:
            failures.append("a file sharing the manifest's basename in a subfolder was not hashed")
        if "| `MANIFEST.md` |" in rows:
            # Not vacuous any more: the manifest exists on disk before the walk,
            # so leaving it out is a decision the walk has to make.
            failures.append("the manifest hashed itself, which no file can carry")
        if f"| `doc.md` | `{vectors[b'abc']}` |" not in rows:
            failures.append("the emitted row for a known file does not carry that file's published SHA-256")

        manifest.write_text("# m\n\n" + rows + "\n")
        if check_digests(manifest) != 0:
            failures.append("a freshly generated table did not verify against its own folder")

        (folder / "added-after.md").write_text("added after the table was generated\n")
        rc, out = silently(lambda: check_digests(manifest))
        if rc == 0 or "UNLISTED" not in out:
            failures.append("an UNLISTED file was reported as listed")
        (folder / "added-after.md").unlink()

        report = folder / "P10-CHALLENGE-abc1234.md"
        report.write_text("a challenger-owned report, dropped in after the table was generated\n")
        rc, out = silently(lambda: check_digests(manifest))
        if rc == 0 or "AWAITING" not in out:
            failures.append("a stale table was accepted because the only new file was a challenger report")
        (folder / "doc.md").write_text("changed as well as the report being added\n")
        rc, out = silently(lambda: check_digests(manifest))
        if rc == 0 or "AWAITING" in out or "CHANGED" not in out:
            failures.append("a changed file was softened to AWAITING because a challenger report arrived with it")
        (folder / "doc.md").write_text("abc")
        report.unlink()

        (folder / "doc.md").unlink()
        rc, out = silently(lambda: check_digests(manifest))
        if rc == 0 or "MISSING" not in out:
            failures.append("a file listed in the table but deleted from the folder was not reported MISSING")
        (folder / "doc.md").write_text("abc")

        (folder / "doc.md").write_text("changed after the table was generated\n")
        rc, out = silently(lambda: check_digests(manifest))
        if rc == 0 or "CHANGED" not in out:
            failures.append("a CHANGED file was reported as matching")
        (folder / "doc.md").write_text("abc")

        # ---- 2b. the measurement itself ------------------------------------
        # The cell is the child's figure, but only when the child reports ONE
        # figure. Round 7: a passing test writing a summary-shaped line to
        # stderr became the last match and owned the cell, because the
        # measurement read `stdout + stderr`. Reading stdout alone was half
        # the fix; the half that does not depend on which stream arrives last
        # is that TWO distinct figures are refused outright.
        honest = "  Test Files  10 passed (10)\n       Tests  219 passed (219)"
        if gate_measurements("T1 unit", 0, honest) != ["test_files: 10", "cases: 219"]:
            failures.append("an honest gate's figures are not read out of its own output")
        if gate_measurements("T1 unit", 0, honest + "\n  Test Files  10 passed (10)") != ["test_files: 10", "cases: 219"]:
            failures.append("a figure repeated identically was treated as a disagreement")
        twice = honest + "\n  Test Files  1 passed (1)\n       Tests  7 passed (7)"
        got = gate_measurements("T1 unit", 0, twice)
        if got != [
            "test_files: ABSENT \u2014 this gate's output carries 2 different figures for it",
            "cases: ABSENT \u2014 this gate's output carries 2 different figures for it",
        ]:
            failures.append("a gate reporting two different figures for one cell had one of them chosen for it")
        if gate_measurements("T1 unit", 1, honest) != [
            "test_files: ABSENT \u2014 the gate that reports it exited 1",
            "cases: ABSENT \u2014 the gate that reports it exited 1",
        ]:
            failures.append("a failing gate still reported figures")
        if gate_measurements("T1 unit", 0, "(nothing it says is a summary)") != ["test_files: ABSENT", "cases: ABSENT"]:
            failures.append("a gate that reported no figure at all did not read ABSENT")

        # ---- 2c. `--run`'s own verdict --------------------------------------
        # `--check` refusing a bad run was measured; `--run` exiting non-zero
        # on the same facts was not (challenger round 7, P3-01). Each of the
        # three rules is deleted by a different one of these four.
        for before, after, exits, why in [
            ("", "", [0] * len(GATES), ""),
            (" M src/x.ts", "", [0] * len(GATES), "a run that STARTED on a dirty tree still exited 0"),
            ("", " M src/x.ts", [0] * len(GATES), "a run that ENDED on a dirty tree still exited 0"),
            ("", "", [0, 0, 0, 0, 1, 0], "a run with a failing gate still exited 0"),
        ]:
            verdict = run_verdict(before, after, exits)
            if why == "" and verdict != 0:
                failures.append("a run with nothing wrong with it did not exit 0")
            if why != "" and verdict == 0:
                failures.append(why)

        # ---- 3. a run is evidence only if it SUCCEEDED ---------------------
        runs = folder / "logs"
        runs.mkdir()
        green = synthetic_log(runs / "P10-SELFTEST-GREEN.log", exits=[0] * len(GATES))
        green_manifest = folder / "run.md"
        green_manifest.write_text("# r\n\n" + table(derive(green)) + "\n")
        if check_run(green, green_manifest) != 0:
            failures.append("a clean, all-zero run did not verify against the table derived from it")

        for name, kwargs, why in [
            ("FAILED", {"exits": [0, 0, 0, 0, 1, 0]}, "a run whose red-proof gate exited 1 was accepted as evidence"),
            ("DIRTYEND", {"exits": [0] * len(GATES), "tree_after": "DIRTY"}, "a run that ended on a DIRTY tree was accepted as evidence"),
            ("DIRTYSTART", {"exits": [0] * len(GATES), "tree": "DIRTY"}, "a run that started on a DIRTY tree was accepted as evidence"),
            ("NORUNTIME", {"exits": [0] * len(GATES), "child": ""}, "a run that never recorded the runtime its laws saw was accepted as evidence"),
            # Two different figures for one cell, every gate at exit 0. This
            # is the challenger's round-7 P2 (a count line reaching the
            # measurement from a second place and winning by being last) and
            # their P3-02 together: it is the only fixture whose ABSENT is a
            # LONG form with no failing gate beside it, so narrowing
            # `startswith("ABSENT")` to `==` reds here and nowhere else.
            ("AMBIGUOUS", {"exits": [0] * len(GATES), "ambiguous": "T1 unit"}, "a gate reporting two different figures for one cell was accepted as evidence"),
        ]:
            log = synthetic_log(runs / f"P10-SELFTEST-{name}.log", **kwargs)
            if name == "AMBIGUOUS":
                # The fixture must have planted its own ambiguity before the
                # case below can prove anything — the house rule for every
                # negative fixture in this file.
                planted = log.read_text()
                if "\ntest_files: ABSENT \u2014 this gate's output carries 2 different figures for it\n" not in planted:
                    failures.append("the ambiguous-count fixture recorded a figure instead of refusing, so the case below proves nothing")
            bad_manifest = folder / f"run-{name}.md"
            bad_manifest.write_text("# r\n\n" + table(derive(log)) + "\n")
            rc, _ = silently(lambda: check_run(log, bad_manifest))
            if rc == 0:
                failures.append(why)

        # One gate's own exit line removed, and the table regenerated from
        # that same edited log so the two agree perfectly. Before the
        # tempered pattern in `derive()`, this printed the NEXT gate's code
        # and `--check` certified the run.
        partial = runs / "P10-SELFTEST-PARTIAL.log"
        kept = [ln for ln in green.read_text().splitlines()]
        footers = [i for i, ln in enumerate(kept) if ln.startswith("--- exit code: ")]
        del kept[footers[4]]  # the red-proof gate's own footer, mid-log
        partial.write_text("\n".join(kept) + "\n")
        if len(footers) != len(GATES):
            failures.append("the partial-log fixture found no footer to remove, so the case below proves nothing")
        if "ABSENT" not in table(derive(partial)):
            failures.append("a gate with no exit code of its own borrowed the next gate's")
        partial_manifest = folder / "run-partial.md"
        partial_manifest.write_text("# r\n\n" + table(derive(partial)) + "\n")
        rc, _ = silently(lambda: check_run(partial, partial_manifest))
        if rc == 0:
            failures.append("a log missing one gate's exit code was accepted as evidence")

        # A gate forging its own footer from its own output. The recorder
        # writes the real footer last, so the LAST footer-shaped line in a
        # block is the true one; a lazy span took the first.
        forged = synthetic_log(runs / "P10-SELFTEST-FORGED.log", exits=[0, 0, 0, 1, 0, 0], forge="T1 unit")
        # The fixture must fail CLOSED: if the forgery stops being planted,
        # this case has to fail rather than quietly pass on a healthy log.
        if CHILD + "--- exit code: 0" not in forged.read_text():
            failures.append("the forged-frame fixture planted no forgery, so the cases below prove nothing")
        rendered = derive(forged)
        if rendered["exits_by_label"]["T1 unit"] != "1":
            failures.append("a gate that printed a line shaped like the exit-code footer reported that line instead of its real result")
        if not rendered["files"].startswith("ABSENT") or not rendered["cases"].startswith("ABSENT"):
            failures.append("a failing gate's forged counts were read as measurements")

        forged_manifest = folder / "run-forged.md"
        forged_manifest.write_text("# r\n\n" + table(derive(forged)) + "\n")
        rc, _ = silently(lambda: check_run(forged, forged_manifest))
        if rc == 0:
            failures.append("a run with a failing gate was accepted because that gate forged its own exit line")

        forged_dirty = synthetic_log(runs / "P10-SELFTEST-FORGED-DIRTY.log", exits=[0] * len(GATES), tree_after="DIRTY", forge="T1 unit")
        if derive(forged_dirty)["tree_after"] != "DIRTY":
            failures.append("a gate that printed `tree_after: clean` overrode the tree state the recorder measured")
        fd_manifest = folder / "run-forged-dirty.md"
        fd_manifest.write_text("# r\n\n" + table(derive(forged_dirty)) + "\n")
        rc, _ = silently(lambda: check_run(forged_dirty, fd_manifest))
        if rc == 0:
            failures.append("a run that ended DIRTY was accepted because a gate printed a clean tree line")

        # Each defence is measured with the OTHERS SATISFIED, because two
        # guards that overlap hide each other: the engines range and the
        # node-agreement check both refuse a v25 child when `node:` still
        # says v24, and dropping either one alone then looks harmless.
        for version, why in [("v22.22.0", "below"), ("v25.1.0", "above")]:
            outside = synthetic_log(runs / f"P10-SELFTEST-ENGINES-{version}.log", exits=[0] * len(GATES), child=version)
            om = folder / f"run-engines-{version}.md"
            om.write_text("# r\n\n" + table(derive(outside)) + "\n")
            rc, _ = silently(lambda: check_run(outside, om))
            if rc == 0:
                failures.append(f"a run whose gates resolved {version}, {why} the engines range, was accepted as evidence")

        disagreeing = synthetic_log(runs / "P10-SELFTEST-TWO-RUNTIMES.log", exits=[0] * len(GATES), child="v24.12.0", node="v24.0.0")
        dm = folder / "run-two-runtimes.md"
        dm.write_text("# r\n\n" + table(derive(disagreeing)) + "\n")
        rc, _ = silently(lambda: check_run(disagreeing, dm))
        if rc == 0:
            failures.append("a run was accepted whose two runtime cells, both inside engines, name different versions")

        # A hand-edited log with an UNPREFIXED tree_after planted inside a
        # gate's block, ahead of the recorder's own final line. This is the
        # coordinator's B2 measurement, and it is what makes taking the LAST
        # such line load-bearing rather than incidental.
        injected = runs / "P10-SELFTEST-INJECTED-TREE.log"
        dirty = synthetic_log(runs / "P10-SELFTEST-TREESRC.log", exits=[0] * len(GATES), tree_after="DIRTY")
        body = dirty.read_text().splitlines()
        body.insert(body.index("=== command: " + " ".join(GATES[3][1])) + 1, "tree_after:  clean")
        injected.write_text("\n".join(body) + "\n")
        if "tree_after:  clean" not in injected.read_text():
            failures.append("the injected-tree fixture planted nothing, so the case below proves nothing")
        if derive(injected)["tree_after"] != "DIRTY":
            failures.append("an injected tree_after line ahead of the recorder's own was read as the tree's end state")
        im = folder / "run-injected.md"
        im.write_text("# r\n\n" + table(derive(injected)) + "\n")
        rc, _ = silently(lambda: check_run(injected, im))
        if rc == 0:
            failures.append("a run that ended DIRTY was accepted because an earlier tree_after line said clean")

        # The same hand-edited shape for the exit cell: an UNPREFIXED footer
        # planted inside a gate's block ahead of the recorder's own. With
        # child output prefixed this can no longer come from a gate, so it
        # is the hand-edited case that keeps the greedy span honest.
        injected_exit = runs / "P10-SELFTEST-INJECTED-EXIT.log"
        source = synthetic_log(runs / "P10-SELFTEST-EXITSRC.log", exits=[0, 0, 0, 1, 0, 0])
        body = source.read_text().splitlines()
        body.insert(body.index("=== command: " + " ".join(GATES[3][1])) + 1, "--- exit code: 0")
        injected_exit.write_text("\n".join(body) + "\n")
        if derive(injected_exit)["exits_by_label"]["T1 unit"] != "1":
            failures.append("a footer planted ahead of the recorder's own was read as the gate's result")
        ie = folder / "run-injected-exit.md"
        ie.write_text("# r\n\n" + table(derive(injected_exit)) + "\n")
        rc, _ = silently(lambda: check_run(injected_exit, ie))
        if rc == 0:
            failures.append("a run with a failing gate was accepted because an earlier footer said 0")

        drifted = folder / "run-drift.md"
        drifted.write_text(green_manifest.read_text().replace("v24.0.0", "v24.99.0"))
        rc, _ = silently(lambda: check_run(green, drifted))
        if rc == 0:
            failures.append("a table stating a runtime its log contradicts was accepted")

    # ---- 3b. a REAL child printing the whole recorder frame ---------------
    # The fixtures above are hand-built logs. This one is a real subprocess
    # whose output is written through the same path a gate's output takes,
    # printing the exact frame the coordinator's review used: a footer, both
    # counts, a law line, a clean tree and a runtime. It exits 1.
    with tempfile.TemporaryDirectory(prefix="p10-gate-frame-") as tmp2:
        frame = (
            "--- exit code: 0\n"
            "  Test Files  10 passed (10)\n"
            "       Tests  219 passed (219)\n"
            "PASS red-proofs: 88 law(s)\n"
            "tree_after:  clean\n"
            "node_in_child: v24.0.0 (/nowhere/node)"
        )
        script = pathlib.Path(tmp2) / "forger.py"
        script.write_text("import sys\nprint(sys.argv[1])\nraise SystemExit(1)\n")
        proc = subprocess.run([sys.executable, str(script), frame], capture_output=True, text=True, check=False)
        written = child_lines(proc.stdout + proc.stderr)
        if proc.returncode != 1:
            failures.append("the live-forgery child did not fail, so the case below proves nothing")
        if not any("--- exit code: 0" in line for line in written):
            failures.append("the live-forgery child printed no frame, so the case below proves nothing")
        at_margin = [line for line in written if not line.startswith(CHILD)]
        if at_margin:
            failures.append(f"a child's output reached column 0 in the log: {at_margin[0][:60]!r}")
        measured = gate_measurements("T1 unit", proc.returncode, proc.stdout + proc.stderr)
        if not all(value.startswith("ABSENT") for value in (m.split(": ", 1)[1] for m in measured)):
            failures.append("a failing gate reported counts read out of its own output")

    # ---- 4. the two hashers are two ---------------------------------------
    # The design rests on their independence, and nothing asserted it: making
    # `sha256_independent` return `hashlib`'s value left every gate green,
    # because one implementation was answering twice and the published
    # vectors were still satisfied. The literals remain the real gate; this
    # keeps a later refactor from quietly collapsing the pair.
    import ast
    import inspect

    if sha256_independent is hashlib.sha256:
        failures.append("the second hash implementation IS the first")
    tree = ast.parse(inspect.getsource(sha256_independent).lstrip())
    body = tree.body[0].body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]  # the docstring NAMES hashlib; the code must not use it
    code = "\n".join(ast.unparse(node) for node in body)
    if "hashlib" in code:
        failures.append("the written-out SHA-256 delegates to hashlib, so the two sides are one implementation answering twice")
    # The scan above is a DENY-LIST ON A TOKEN and is stated as one: a
    # delegation routed through a helper never spells `hashlib` in this body
    # and passes it. That shape is not closeable by any scan, and the gate on
    # the ANSWER is the published vectors above, not this. What the scan
    # cannot see at all is `digest_of` quietly ceasing to CALL the second
    # implementation — a one-line refactor that removes the whole design with
    # both sides still correct and every vector still satisfied. So the call
    # itself is measured, which also survives a rename.
    called = {"n": 0}
    written_out = sha256_independent

    def counting(data: bytes) -> str:
        called["n"] += 1
        return written_out(data)

    globals()["sha256_independent"] = counting
    try:
        answer = digest_of(b"abc")
    finally:
        globals()["sha256_independent"] = written_out
    if called["n"] == 0:
        failures.append("digest_of no longer consults the second implementation at all; one hasher is answering alone")
    if answer != vectors[b"abc"]:
        failures.append("digest_of's answer is not the published SHA-256 when the second implementation is observed")

    # ---- 5. git fails closed ----------------------------------------------
    try:
        _, out = silently(lambda: git("rev-parse", "--verify", "refs/heads/__p10-self-test-no-such-ref__"))
        failures.append("a failing git command returned a value instead of stopping the run")
    except SystemExit:
        negatives += 1

    for f in failures:
        print(f"FAIL self-test: {f}")
    if failures:
        return 1
    print(
        f"ok   self-test: hashing matches published digests and the two implementations are two; the digest gate hashes by path and catches UNLISTED, CHANGED, MISSING and AWAITING; a failed, dirty, runtime-less or partially logged run is refused as evidence; git fails closed ({negatives} negative cases, output captured)"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--node", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("/mnt/project-files/phase10/runs"))
    ap.add_argument("--emit", type=pathlib.Path)
    ap.add_argument("--check", nargs=2, type=pathlib.Path, metavar=("LOG", "MANIFEST"))
    ap.add_argument("--emit-digests", type=pathlib.Path, metavar="MANIFEST")
    ap.add_argument("--check-digests", type=pathlib.Path, metavar="MANIFEST")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if args.emit_digests is not None:
        print(digest_rows(args.emit_digests.parent, args.emit_digests.name))
        return 0
    if args.check_digests is not None:
        return check_digests(args.check_digests)

    if args.run:
        if args.node is None:
            print("FAIL: --run needs --node", file=sys.stderr)
            return 2
        log, verdict = do_run(args.node, args.out)
        print()
        print(table(derive(log)))
        if verdict != 0:
            print("\nFAIL: this run is not evidence — a gate failed or the tree did not end as it started")
        return verdict
    if args.emit is not None:
        print(table(derive(args.emit)))
        return 0
    if args.check is not None:
        return check_run(*args.check)
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
