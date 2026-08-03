#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pack lyrics/*.lrc into js/data/lyrics-map.js for reliable offline loading."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LYRICS_DIR = ROOT / "lyrics"
OUT = ROOT / "js" / "data" / "lyrics-map.js"


def main() -> int:
    mp: dict[str, str] = {}
    for p in sorted(LYRICS_DIR.glob("*.lrc")):
        text = p.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
        if len(text.strip()) < 8:
            continue
        mp[p.name] = text

    OUT.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "/**\n"
        " * Auto-generated embedded lyrics map for offline / same-origin playback.\n"
        " * Do not edit by hand. Regenerate after download_lyrics.py:\n"
        " *   python scripts/build_lyrics_map.py\n"
        " * Source LRC files live in /lyrics/\n"
        " */\n"
        "window.MP_LYRICS_MAP = "
    )
    body = json.dumps(mp, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(header + body + ";\n", encoding="utf-8")
    print(f"Wrote {OUT} ({len(mp)} tracks, {OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
