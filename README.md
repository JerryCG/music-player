# 果子狸のMusic Player

Personal music collection player for [JerryCG](https://github.com/JerryCG). Audio files live in the separate repo [`music-collection-db`](https://github.com/JerryCG/music-collection-db).

**Live site:** https://jerrycg.github.io/music-player/

## Features

- Filter by genre / artist (derived automatically from the catalog)
- Random and loop play modes
- Text search (multi-token, keyboard navigation)
- Dark (black & gold) / light themes (first visit follows system, then toggles)
- Lyrics when available (LRCLIB + optional local LRC files)
- Media Session API — lock screen / notification / headset / car media keys
- Progress bar, volume, beat visualizer, dynamic disc art
- PWA installable shell (service worker caches app assets only, not MP3s)
- Deep links: `?id=12`
- Keyboard shortcuts: Space, ←/→, N/P, `/`, L, T

## Audio delivery (ORB fix)

Tracks are streamed from `raw.githubusercontent.com` (CORS + range requests), **not** from `github.com/.../blob/...?raw=true`, which goes through HTML redirects and often fails in Chrome with `net::ERR_BLOCKED_BY_ORB`.

If a stream still fails, the player falls back to fetching the file and playing it as an `audio/mpeg` blob URL.

## Lyrics & covers (realistic limits)

This is a **static** GitHub Pages app (no private API keys, no server).

| Source | Role |
|--------|------|
| Local `lyrics/<file>.lrc` in [music-collection-db](https://github.com/JerryCG/music-collection-db) | Best for rare Chinese tracks you care about |
| [LRCLIB](https://lrclib.net/) | Free synced/plain lyrics; multi-query; **cover artist + duration** preferred |
| lyrics.ovh | Plain lyrics fallback only |
| iTunes Search | Optional disc cover art |

**Not used in-browser:** QQ Music / NetEase / Kugou / Bilibili / YouTube scraping (CORS + ToS + brittle). Audio fingerprinting would need a backend (e.g. Cloudflare Worker + ACRCloud/AudD).

**Instrumentals:** Light Music / BGM-style titles skip lyrics so wrong synced text is not shown.

To add perfect synced lyrics for a rare song, put an LRC next to the audio naming scheme:

`music-collection-db/lyrics/<same-basename-as-mp3>.lrc`

## Project layout

```
index.html                 # page shell
css/styles.css             # themes + layout
js/
  data/musics.js           # single catalog (849 tracks)
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
