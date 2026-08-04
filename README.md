# 果子狸のMusic Player

Personal music collection player for [JerryCG](https://github.com/JerryCG). Audio files live in the separate repo [`music-collection-db`](https://github.com/JerryCG/music-collection-db).

**Live site:** https://jerrycg.github.io/music-player/

## Features

- Filter by genre / artist (derived automatically from the catalog)
- Random and loop play modes
- Text search (multi-token, keyboard navigation)
- Dark (black & gold) / light themes (first visit follows system, then toggles)
- Lyrics from pre-downloaded local LRC files (batch: NetEase / QQ / Kugou / LRCLIB)
- Media Session API — lock screen / notification / headset / car media keys
- Progress bar, volume, beat visualizer, dynamic disc art
- PWA installable shell (service worker caches app assets only, not MP3s)
- Deep links: `?id=12`
- Keyboard shortcuts: Space, ←/→, N/P, `/`, L, T

## Audio delivery (ORB fix)

Tracks are streamed from `raw.githubusercontent.com` (CORS + range requests), **not** from `github.com/.../blob/...?raw=true`, which goes through HTML redirects and often fails in Chrome with `net::ERR_BLOCKED_BY_ORB`.

If a stream still fails, the player falls back to fetching the file and playing it as an `audio/mpeg` blob URL.

## Lyrics & covers

This is a **static** GitHub Pages app. Lyrics are **downloaded offline** into this repo so playback does not hammer third-party APIs.

| Source | Role |
|--------|------|
| **`lyrics/<same-as-mp3>.lrc`** in this repo | Primary — one file per catalog track |
| Batch script `scripts/download_lyrics.py` | NetEase → QQ Music → Kugou → [LRCLIB](https://lrclib.net/) |
| LRCLIB (browser, thin) | Only if a local file is missing (new tracks) |
| iTunes Search | Optional disc cover art |

**Every catalog track is attempted** (including Light Music). Instrumentals may still end up with no file or weak matches — check `lyrics/_misses.txt` after a run.

### Refresh / fill lyrics (local machine)

You do **not** need the download script at play time. The player reads an **embedded map** (`js/data/lyrics-map.js`) built from the LRC files.

```bash
# Requires Python 3.10+
python scripts/download_lyrics.py              # fill lyrics/*.lrc; merge into full report
python scripts/download_lyrics.py --ids 12,35  # subset only — still keeps full _report / _misses
python scripts/download_lyrics.py --report-only  # refresh report from disk without network
python scripts/build_lyrics_map.py             # pack lyrics/*.lrc → js/data/lyrics-map.js
```

Outputs: `lyrics/*.lrc`, `js/data/lyrics-map.js`, plus tracking files:

- `lyrics/_report.json` — full-catalog history (merged on every run, not replaced by subsets)
- `lyrics/_misses.txt` — current misses only (updated when you fill or add tracks)

Hard-refresh the page (or wait for SW cache bump) after updating the map.

## Project layout

```
index.html                 # page shell
css/styles.css             # themes + layout
js/
  data/musics.js           # single catalog (854 tracks)
  app.js                   # bootstrap
  player.js                # playback + preload
  library.js               # cascading genre/artist filters
  search.js
  lyrics.js
  disc-art.js              # procedural + cover art on the disc
  media-session.js
  audio-enhance.js         # visualizer
  theme.js
  utils.js
manifest.webmanifest
sw.js                      # app-shell cache only
logo-web.png
logo-web-removebg.png
archive/                   # historical files only (not loaded by the site)
```

Adding a song: append one object to `js/data/musics.js` with `id`, `name`, `artist`, `genre`, and `file` (filename under `music/` in the collection repo). Genres and artists update automatically.

## Local preview

Serve the folder over HTTP (required for modules, SW, and CORS-related features), e.g. any static file server on `127.0.0.1`.

## License / rights

Personal non-commercial listening collection. Rights remain with original artists and rights holders. Contact: chengguojerry@gmail.com
