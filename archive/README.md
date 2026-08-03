# Archive (not used by the live site)

Historical / unused files kept for reference only. **Nothing under `archive/` is loaded by `index.html` or the service worker.**

## `pre-cleanup/`

Files removed in the cleanup commit so the repo root stays focused on the current app:

| Path | Notes |
|------|--------|
| `js/musics.js` | Tiny deprecation stub (post-migration) |
| `js/artists.js` | Deprecation stub |
| `js/genres.js` | Deprecation stub |
| `logo.png` | Unused logo variant (site uses `logo-web*.png`) |
| `plan.txt` | Old session notes |
| `static-vs-dynamic.png` | Unreferenced diagram |

## `legacy-catalog/`

Full pre-migration data files from git `01ce83a` (original page structure):

| Path | Notes |
|------|--------|
| `musics.js` | Full `getMusics()` list with GitHub blob URLs |
| `artists.js` | Hand-maintained artist index |
| `genres.js` | Hand-maintained genre index |

**Live catalog:** `js/data/musics.js` (derived from this; IDs 1–849).  
Prefer that file for any production edits. Use `legacy-catalog/` only if you need to compare or recover old fields.
