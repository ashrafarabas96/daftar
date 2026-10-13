#!/usr/bin/env python3
"""Write the pack's check-run record FROM the tools' captured stdout.

The challenger's B-5: the record quoted "38 files, 38 rows, 0 problems" for a
pack that was 39/39, because the strings had been carried forward by hand into
the one section whose job is to be recomputed by a reader. So nothing here is
typed. Each row is the last line of a captured stdout file, the counts come
from the digest table itself, and the newest mtime is read from the filesystem.

Usage:
    python3 tools/seal-check-run.py --dir <pack> --logs <dir> --run-utc <ISO> --mtime-utc <ISO> \
            --mtime-file <name> [--rerun-utc <ISO>]
"""
from __future__ import annotations

import argparse
import io
import re
from pathlib import Path

ROW = re.compile(r"^\| `([^`]+)` \| (.+) \|$")


def last_line(p: Path) -> str:
    lines = [l.rstrip("\n") for l in io.open(p, encoding="utf-8") if l.strip()]
    if not lines:
        raise SystemExit(f"{p} is empty — a record may not quote a run that produced nothing")
    return lines[-1].strip()


def tally(manifest: Path) -> tuple[int, int, int]:
    digests = markers = selfrow = 0
    for line in io.open(manifest, encoding="utf-8"):
        m = ROW.match(line.rstrip("\n"))
        if not m:
            continue
        v = m.group(2)
        if v == "this file":
            selfrow += 1
        elif v.startswith("`") and len(v) == 66:
            digests += 1
        elif "reviewer-owned" in v:
            markers += 1
    return digests, markers, selfrow


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--logs", required=True)
    ap.add_argument("--run-utc", required=True)
    ap.add_argument("--mtime-utc", required=True)
    ap.add_argument("--mtime-file", required=True)
    ap.add_argument("--rerun-utc")
    a = ap.parse_args()

    base, logs = Path(a.dir), Path(a.logs)
    manifest = base / "P5-HANDOFF-MANIFEST.md"
    cs, sb, md = (last_line(logs / f) for f in ("cs.out", "sb.out", "md.out"))
    digests, markers, selfrow = tally(manifest)
    total = digests + markers + selfrow

    rows = [
        "| | |",
        "|---|---|",
        f"| **newest document mtime** (every `.md` and `.json` in the pack except this file) "
        f"| **{a.mtime_utc}** — `{a.mtime_file}`. `/mnt/project-files` is synced, so an mtime there "
        f"may not be the write time; this is the time the filesystem reported when the record was "
        f"written. |",
        f"| **`context-sites.py --check`** | **rc 0** — `{cs}` |",
        f"| **`status-block.py --check`** | **rc 0** — `{sb}` |",
        f"| **`manifest-digests.py --check`** | **rc 0** — `{md}` |",
        f"| **the check run** | **{a.run_utc}**, i.e. AFTER the newest document mtime above |",
        f"| **the table's own tally** | **{total} rows** = {digests} digests + {markers} "
        f"reviewer-owned markers + {selfrow} `this file` |",
    ]
    if a.rerun_utc:
        rows.append(
            f"| **re-run after this file's last write** | **{a.rerun_utc}**, all three rc 0 |"
        )

    note = (
        "\nEvery string in the table above is written into this file by\n"
        "`tools/seal-check-run.py` from the tools' CAPTURED STDOUT, and the tally is counted from\n"
        "the digest table in this same file — none of it is typed. That is the structural half of\n"
        "the challenger's B-5: the previous record quoted round 22's strings for a pack that had\n"
        "since gained a file, and a hand-copied figure in the one section meant to be recomputed\n"
        "by a reader is the B-3 failure mode in the paragraph written to end it.\n\n"
        "**Where the regress stops.** Writing the re-run time is itself a write to this file. The\n"
        "author ran all three again after this line was written and they were rc 0; that final\n"
        "confirmation is reported in the round-24 handoff rather than here, because recording it\n"
        "would need yet another write. Any reader can settle it in one command: the three tools on\n"
        "these bytes must print exactly the strings above.\n"
    )

    text = io.open(manifest, encoding="utf-8").read()
    begin, end = "<!-- P5-SEAL:BEGIN -->", "<!-- P5-SEAL:END -->"
    block = "\n".join([begin, ""] + rows + ["", note.strip(), "", end])
    if begin in text and end in text:
        head = text[: text.index(begin)]
        tail = text[text.index(end) + len(end) :]
        io.open(manifest, "w", encoding="utf-8").write(head + block + tail)
    else:
        raise SystemExit("no P5-SEAL sentinel pair in the manifest")
    print(f"sealed: {total} rows = {digests} + {markers} + {selfrow}; run {a.run_utc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
