# Lyrics (pre-downloaded LRC)

One `.lrc` file per catalog track, named like the mp3:

`qianxun_alin.mp3` → `qianxun_alin.lrc`

## How files got here

```bash
python scripts/download_lyrics.py              # full or partial; merges into report
python scripts/download_lyrics.py --ids 35,75  # only some tracks — still keeps full report
python scripts/download_lyrics.py --report-only  # rebuild report/misses from catalog + disk
python scripts/build_lyrics_map.py             # pack into js/data/lyrics-map.js for the player
```

Sources tried in order: **NetEase → QQ Music → Kugou → LRCLIB**.

## Tracking files (kept across runs)

| File | Purpose |
|------|---------|
| `_report.json` | **Full catalog** status for every track (ok / existing / miss, source, meta). Partial runs **merge** into this file — they do not wipe history. |
| `_misses.txt` | All current misses (tab-separated: `id`, name, artist, meta). Shrinks when a miss is filled. |

When you fill a missing lyric or add a new song, re-run the downloader (or `--report-only` after dropping a manual `.lrc`); the report and misses list update in place.

## Manual fix

Edit or replace any `.lrc`, then:

```bash
python scripts/build_lyrics_map.py
python scripts/download_lyrics.py --report-only
```

### Shift timing (alignment)

If lyrics lead/lag the audio by a constant amount:

```bash
# Move every timed line so a known lyric lands at 0:09
python scripts/shift_lrc.py lyrics/reqingguangpu_shengwuguzhang.lrc \
  --anchor-text "鳴りやまぬ愛をさけぶよ" --anchor-time 9.0 --rebuild-map

# Or apply a fixed delta in seconds (+ later, − earlier)
python scripts/shift_lrc.py lyrics/foo.lrc --delta 1.5 --rebuild-map
python scripts/shift_lrc.py lyrics/foo.lrc --delta -0.8 --rebuild-map
```

The player uses the embedded map (`js/data/lyrics-map.js`), not live NetEase/QQ calls.
