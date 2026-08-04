#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shift all timed lines in an LRC by a fixed number of seconds (or align via anchor).

Examples:
  # Shift by +7.76 seconds
  python scripts/shift_lrc.py lyrics/foo.lrc --delta 7.76

  # Align a line containing text so it lands at 0:09
  python scripts/shift_lrc.py lyrics/foo.lrc --anchor-text "鳴りやまぬ" --anchor-time 9.0

  # Then rebuild the player map:
  python scripts/build_lyrics_map.py
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TIME_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]")


def parse_time_tag(m: re.Match) -> float:
    mm = int(m.group(1))
    ss = int(m.group(2))
    frac = m.group(3) or "0"
    # pad/truncate to ms
    frac = (frac + "000")[:3]
    return mm * 60 + ss + int(frac) / 1000.0


def format_time(t: float) -> str:
    if t < 0:
        t = 0.0
    total_ms = int(round(t * 1000))
    mins = total_ms // 60000
    rem = total_ms % 60000
    secs = rem // 1000
    ms = rem % 1000
    return f"[{mins:02d}:{secs:02d}.{ms:03d}]"


def parse_time_arg(s: str) -> float:
    s = s.strip()
    if ":" in s:
        parts = s.split(":")
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return float(s)


def shift_line(line: str, delta: float) -> str:
    def repl(m: re.Match) -> str:
        return format_time(parse_time_tag(m) + delta)

    return TIME_RE.sub(repl, line)


def find_anchor_time(lines: list[str], needle: str) -> float | None:
    needle_n = needle.strip()
    for line in lines:
        if needle_n not in line:
            continue
        times = [parse_time_tag(m) for m in TIME_RE.finditer(line)]
        if times:
            return min(times)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Shift LRC timestamps for better audio alignment")
    ap.add_argument("lrc", type=Path, help="Path to .lrc file")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--delta", type=float, help="Seconds to add (negative to move earlier)")
    g.add_argument(
        "--anchor-text",
        type=str,
        help="Lyric text substring used as anchor (first matching timed line)",
    )
    ap.add_argument(
        "--anchor-time",
        type=str,
        default=None,
        help="Target time for anchor, e.g. 9.0 or 0:09 or 00:09.000 (required with --anchor-text)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print first few shifted lines without writing",
    )
    ap.add_argument(
        "--rebuild-map",
        action="store_true",
        help="Run scripts/build_lyrics_map.py after writing",
    )
    args = ap.parse_args()

    path: Path = args.lrc
    if not path.exists():
        print(f"Not found: {path}", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    if args.anchor_text is not None:
        if args.anchor_time is None:
            print("--anchor-time is required with --anchor-text", file=sys.stderr)
            return 1
        cur = find_anchor_time(lines, args.anchor_text)
        if cur is None:
            print(f"Anchor text not found in timed lines: {args.anchor_text!r}", file=sys.stderr)
            return 1
        target = parse_time_arg(args.anchor_time)
        delta = target - cur
        print(f"Anchor found at {cur:.3f}s → target {target:.3f}s → delta {delta:+.3f}s")
    else:
        delta = float(args.delta)
        print(f"Delta {delta:+.3f}s")

    out_lines = []
    for line in lines:
        # Keep pure meta offset tag updated if present
        if re.match(r"^\[offset:", line, re.I):
            # physical timestamps are shifted; keep tag at 0 to avoid double-shift in other players
            out_lines.append("[offset:0]")
            continue
        if TIME_RE.search(line):
            out_lines.append(shift_line(line, delta))
        else:
            out_lines.append(line)

    if args.dry_run:
        print("--- preview (first 12 lines) ---")
        for ln in out_lines[:12]:
            print(ln)
        return 0

    path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(f"Wrote {path}")

    if args.rebuild_map:
        import subprocess

        build = Path(__file__).resolve().parents[1] / "scripts" / "build_lyrics_map.py"
        subprocess.check_call([sys.executable, str(build)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
