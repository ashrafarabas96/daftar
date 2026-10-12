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
]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False).stdout.strip()


def do_run(node_bin: pathlib.Path, out_dir: pathlib.Path) -> pathlib.Path:
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

    lines = [
        f"run_id:      {run_id}",
        f"subject:     {PKG} (Phase 10 restaurant pack, pure package)",
        f"source_sha:  {git('rev-parse', 'HEAD')}",
        f"branch:      {git('rev-parse', '--abbrev-ref', 'HEAD')}",
        f"tree:        {'clean' if git('status', '--porcelain') == '' else 'DIRTY'}",
        f"node:        {node_version}",
        f"node_bin:    {node_bin}",
        f"cwd:         {ROOT}",
        f"started_utc: {started.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "database:    none — this package starts no PostgreSQL cluster and connects to none",
        "",
    ]
    for _, cmd in GATES:
        lines.append(f"=== command: {' '.join(cmd)}")
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env, check=False)
        lines.append((proc.stdout + proc.stderr).rstrip("\n"))
        lines.append(f"--- exit code: {proc.returncode}")
        lines.append("")
        print(f"{'ok  ' if proc.returncode == 0 else 'FAIL'} {' '.join(cmd)} -> exit {proc.returncode}")
    # The red-proof harness plants defects in `src/` and restores them in a
    # `finally`. A `finally` does not run if the process is killed, and a
    # planted defect left behind is both a corrupt tree and — far worse — a
    # defect that could be committed as if it were the work. So the run states
    # whether the tree it finished on is the tree it started on.
    after = git("status", "--porcelain")
    lines.append(f"tree_after:  {'clean' if after == '' else 'DIRTY'}")
    if after != "":
        lines.append(after)
        print("FAIL: the tree is DIRTY after the run; a planted mutation may have survived:")
        print(after)
    ended = datetime.datetime.now(datetime.timezone.utc)
    lines.append(f"ended_utc:   {ended.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    log_path.write_text("\n".join(lines) + "\n")
    print(f"log: {log_path}")
    return log_path


def derive(log_path: pathlib.Path) -> dict[str, str]:
    """Every value below is read OUT of the log; none is passed in."""
    text = log_path.read_text()
    field = lambda name: (re.search(rf"^{name}:\s+(.*)$", text, re.M) or [None, "ABSENT"])[1].strip()
    exits = {cmd[0]: None for cmd in GATES}
    for label, cmd in GATES:
        joined = re.escape(" ".join(cmd))
        m = re.search(rf"^=== command: {joined}$.*?^--- exit code: (-?\d+)$", text, re.M | re.S)
        exits[label] = m.group(1) if m else "ABSENT"
    files = re.search(r"^\s*Test Files\s+(\d+) passed \(\d+\)", text, re.M)
    cases = re.search(r"^\s*Tests\s+(\d+) passed \(\d+\)", text, re.M)
    laws = re.search(r"^PASS red-proofs: (\d+) law\(s\)", text, re.M)
    return {
        "run_id": field("run_id"),
        "source_sha": field("source_sha"),
        "tree": field("tree"),
        "node": field("node"),
        "database": field("database"),
        "log_name": log_path.name,
        "log_sha256": hashlib.sha256(log_path.read_bytes()).hexdigest(),
        "files": files.group(1) if files else "ABSENT",
        "cases": cases.group(1) if cases else "ABSENT",
        "laws": laws.group(1) if laws else "ABSENT",
        "exits": " · ".join(f"{label.split()[-1]} {exits[label]}" for label, _ in GATES),
    }


MARK_BEGIN = "<!-- RUN-IDENTITY:BEGIN (generated by proofs/record-run.py --emit; do not edit by hand) -->"
MARK_END = "<!-- RUN-IDENTITY:END -->"


def table(d: dict[str, str]) -> str:
    return "\n".join(
        [
            MARK_BEGIN,
            "",
            "| | |",
            "|---|---|",
            f"| **Run ID** | `{d['run_id']}` |",
            f"| **Log** | `runs/{d['log_name']}` (in this folder), SHA256 `{d['log_sha256']}` |",
            f"| **Source SHA** | `{d['source_sha']}`, tree **{d['tree']}** |",
            f"| **Node** | {d['node']} |",
            f"| **Database** | {d['database']} |",
            f"| **Counts** | {d['files']} test files, {d['cases']} cases, {d['laws']} red-proof laws |",
            f"| **Exit codes** | {d['exits']} |",
            "",
            MARK_END,
        ]
    )


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
    files = sorted(f for f in folder.rglob("*") if f.is_file() and f.name != manifest_name)
    rows = [DIGESTS_BEGIN, "", "| Document | SHA256 |", "|---|---|"]
    for f in files:
        rel = f.relative_to(folder).as_posix()
        rows.append(f"| `{rel}` | `{hashlib.sha256(f.read_bytes()).hexdigest()}` |")
    rows += ["", DIGESTS_END]
    return "\n".join(rows)


def check_digests(manifest: pathlib.Path) -> int:
    folder = manifest.parent
    want = digest_rows(folder, manifest.name)
    have = manifest.read_text()
    if DIGESTS_BEGIN not in have or DIGESTS_END not in have:
        print(f"FAIL: {manifest} carries no generated digest block", file=sys.stderr)
        return 1
    block = have[have.index(DIGESTS_BEGIN) : have.index(DIGESTS_END) + len(DIGESTS_END)]
    if block.strip() == want.strip():
        print(f"ok   every digest in {manifest.name} matches the file it names, and no file is unlisted")
        return 0
    print(f"FAIL: the digest table in {manifest.name} no longer describes this folder")
    listed = dict(l.split("` | `") for l in block.splitlines() if l.startswith("| `") and "` | `" in l)
    current = dict(l.split("` | `") for l in want.splitlines() if l.startswith("| `") and "` | `" in l)
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--node", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("/mnt/project-files/phase10/runs"))
    ap.add_argument("--emit", type=pathlib.Path)
    ap.add_argument("--check", nargs=2, type=pathlib.Path, metavar=("LOG", "MANIFEST"))
    ap.add_argument("--emit-digests", type=pathlib.Path, metavar="MANIFEST")
    ap.add_argument("--check-digests", type=pathlib.Path, metavar="MANIFEST")
    args = ap.parse_args()

    if args.emit_digests is not None:
        print(digest_rows(args.emit_digests.parent, args.emit_digests.name))
        return 0
    if args.check_digests is not None:
        return check_digests(args.check_digests)

    if args.run:
        if args.node is None:
            print("FAIL: --run needs --node", file=sys.stderr)
            return 2
        log = do_run(args.node, args.out)
        print()
        print(table(derive(log)))
        return 0
    if args.emit is not None:
        print(table(derive(args.emit)))
        return 0
    if args.check is not None:
        log, manifest = args.check
        want = table(derive(log))
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
        print(f"ok   run identity in {manifest.name} is derived from {log.name} and matches")
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
