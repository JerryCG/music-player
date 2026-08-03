# Lyrics (pre-downloaded LRC)

One `.lrc` file per catalog track, named like the mp3:

`qianxun_alin.mp3` → `qianxun_alin.lrc`

## How files got here

```bash
python scripts/download_lyrics.py
```

Sources tried in order: **NetEase → QQ Music → Kugou → LRCLIB**.

- `_report.json` — coverage stats
- `_misses.txt` — tracks with no acceptable match (re-run later or add manually)

## Manual fix

Edit or replace any `.lrc` with a better file. The player loads `lyrics/<basename>.lrc` at runtime (no live NetEase/QQ scraping in the browser).
