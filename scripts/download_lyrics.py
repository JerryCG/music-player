#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Batch-download LRC lyrics for every track in js/data/musics.js.

Sources (in order, first good match wins):
  1) NetEase Cloud Music  (music.163.com)
  2) QQ Music             (c.y.qq.com)
  3) Kugou Music          (songsearch + lyrics.kugou.com)
  4) LRCLIB               (lrclib.net) — good for Western / JP / KR

Writes:
  lyrics/<same-basename-as-mp3>.lrc
  lyrics/_report.json   (coverage stats)
  lyrics/_misses.txt    (ids still missing)

Resume-safe: skips existing non-empty .lrc files unless --force.

Personal offline use only. Platform APIs are unofficial and may change.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MUSICS_JS = ROOT / "js" / "data" / "musics.js"
LYRICS_DIR = ROOT / "lyrics"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
CLIENT_ID = "JerryCG-Music-Player-Batch/1.0 (https://github.com/JerryCG/music-player)"

# SSL: strict first, then permissive for flaky CN CDNs
_SSL_STRICT = ssl.create_default_context()
_SSL_LOOSE = ssl._create_unverified_context()

# Polite delay between HTTP calls (seconds)
DELAY = 0.35


def log(msg: str) -> None:
    print(msg, flush=True)


def sleep() -> None:
    time.sleep(DELAY)


def http_get(url: str, headers: dict | None = None, timeout: float = 22) -> bytes:
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    last_err: Exception | None = None
    for ctx in (_SSL_STRICT, _SSL_LOOSE):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read()
        except Exception as e:  # noqa: BLE001 — retry with loose SSL
            last_err = e
            continue
    raise last_err  # type: ignore[misc]


def http_get_text(url: str, headers: dict | None = None) -> str:
    data = http_get(url, headers=headers)
    # try utf-8 then gbk
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def http_get_json(url: str, headers: dict | None = None):
    text = http_get_text(url, headers=headers)
    text = text.strip()
    # JSONP unwrap
    if text.startswith("callback(") or text.startswith("jsonp"):
        m = re.search(r"\((\{.*\}|\[.*\])\)\s*;?\s*$", text, re.S)
        if m:
            text = m.group(1)
    return json.loads(text)


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

def parse_musics(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    # Extract array from getMusics() / return [ ... ];
    m = re.search(r"return\s*(\[[\s\S]*?\])\s*;\s*\}", text)
    if not m:
        raise RuntimeError(f"Could not parse musics array from {path}")
    arr_src = m.group(1)
    # JS object literals → JSON-ish: quote keys
    # Our file uses unquoted keys: {id:1,name:"...",artist:"...",genre:"...",file:"..."}
    fixed = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', arr_src)
    # trailing commas
    fixed = re.sub(r",\s*]", "]", fixed)
    fixed = re.sub(r",\s*}", "}", fixed)
    return json.loads(fixed)


# ---------------------------------------------------------------------------
# Text helpers / scoring
# ---------------------------------------------------------------------------

def clean_title(name: str) -> str:
    s = str(name or "")
    s = re.sub(r"[（(][^）)]*[）)]", " ", s)
    s = re.sub(r"《[^》]*》", " ", s)
    s = re.sub(r"【[^】]*】", " ", s)
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = re.sub(
        r"\s*[-–—·|｜]?\s*(OST|主题曲|片头曲|片尾曲|插曲|推广曲|电视剧|电影|网剧|原声).*$",
        " ",
        s,
        flags=re.I,
    )
    s = re.sub(r"\s*[-–—]\s*(Azure Lane|Theme Song|Movie Theme|TV Size).*$", " ", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s or str(name or "").strip()


def primary_artist(artist: str) -> str:
    parts = re.split(r"\s*[&,，/、]\s*|\s+feat\.?\s+|\s+ft\.?\s+", str(artist or ""), flags=re.I)
    return (parts[0] or "").strip()


def artist_variants(artist: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def add(a: str) -> None:
        a = (a or "").strip()
        if not a or a in seen:
            return
        seen.add(a)
        out.append(a)
        if "昕" in a:
            add(a.replace("昕", "欣"))
        if "欣" in a:
            add(a.replace("欣", "昕"))

    add(artist)
    for p in re.split(r"\s*[&,，/、]\s*|\s+feat\.?\s+|\s+ft\.?\s+", str(artist or ""), flags=re.I):
        add(p)
    return out


def norm(s: str) -> str:
    s = str(s or "").lower()
    s = re.sub(r"[\s·・\-–—_'\"“”‘’\.\,\!\?\:\;\(\)\[\]\{\}/\\|]+", "", s)
    return s


def similarity(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return 0.85
    return SequenceMatcher(None, na, nb).ratio()


def score_candidate(track_name: str, track_artist: str, hit_title: str, hit_artist: str) -> float:
    """0–100 score. Reject weak artist matches when artist is known."""
    clean = clean_title(track_name)
    title_s = max(similarity(clean, hit_title), similarity(track_name, hit_title))
    arts = artist_variants(track_artist)
    art_s = 0.0
    for a in arts:
        if not a or a.lower() == "unknown":
            continue
        art_s = max(art_s, similarity(a, hit_artist))
        # multi-artist hit string
        art_s = max(art_s, similarity(a, primary_artist(hit_artist)))

    has_real = bool(track_artist and track_artist.strip().lower() != "unknown")
    if has_real and art_s < 0.35 and title_s < 0.95:
        return -1.0
    if has_real and art_s < 0.25:
        return -1.0

    if has_real:
        score = title_s * 55 + art_s * 45
    else:
        # Artist unknown in catalog — title match only
        score = title_s * 90
    if title_s >= 0.95:
        score += 8
    if art_s >= 0.9:
        score += 8
    return score


def is_valid_lrc(text: str) -> bool:
    if not text or len(text.strip()) < 12:
        return False
    # need at least one timestamp line with some text
    lines = 0
    for line in text.splitlines():
        if re.search(r"\[\d{1,2}:\d{2}", line) and re.sub(r"\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]", "", line).strip():
            lines += 1
    if lines >= 2:
        return True
    # plain lyrics (no times) — still useful, convert to pseudo-unsynced by wrapping
    plain = text.strip()
    if len(plain) >= 40 and not plain.lower().startswith("error"):
        return True
    return False


def normalize_lrc(text: str) -> str:
    text = html.unescape(text or "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # strip BOM
    if text.startswith("\ufeff"):
        text = text[1:]
    # drop pure instrumental markers only
    if re.search(r"纯音乐|请欣赏|此歌曲为没有填词", text) and len(text) < 80:
        return ""
    return text.strip() + "\n"


def merge_trans(org: str, trans: str) -> str:
    """Interleave translated lines under originals when timestamps match (QQ/NetEase)."""
    if not trans or not org:
        return org

    def parse_lines(lrc: str):
        rows = []
        for line in lrc.splitlines():
            m = re.match(r"^(\[\d{1,2}:\d{2}(?:\.\d{1,3})?\])(.*)$", line)
            if m:
                rows.append((m.group(1), m.group(2)))
            else:
                rows.append(("", line))
        return rows

    org_rows = parse_lines(org)
    tr_rows = parse_lines(trans)
    tr_map = {t: v for t, v in tr_rows if t and v.strip() and v.strip() != "//"}
    out = []
    for tag, val in org_rows:
        out.append(f"{tag}{val}" if tag else val)
        if tag and tag in tr_map:
            tv = tr_map[tag].strip()
            if tv and tv != val.strip():
                out.append(f"{tag}{tv}")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

def fetch_netease(title: str, artist: str) -> tuple[str | None, str]:
    queries = []
    ct = clean_title(title)
    for a in artist_variants(artist)[:3]:
        if a.lower() != "unknown":
            queries.append(f"{ct} {a}")
            queries.append(f"{a} {ct}")
    queries.append(ct)
    queries.append(title)
    # dedupe
    seen = set()
    qs = []
    for q in queries:
        q = q.strip()
        if q and q not in seen:
            seen.add(q)
            qs.append(q)

    best = None
    best_score = 40.0  # minimum

    for q in qs[:5]:
        try:
            url = "https://music.163.com/api/search/get/web?" + urllib.parse.urlencode(
                {"s": q, "type": 1, "offset": 0, "limit": 12, "total": "true"}
            )
            sleep()
            data = http_get_json(url, {"Referer": "https://music.163.com/"})
            songs = (data.get("result") or {}).get("songs") or []
        except Exception as e:
            log(f"    netease search err: {e}")
            continue

        for s in songs:
            hit_title = s.get("name") or ""
            arts = s.get("artists") or []
            hit_artist = " ".join(a.get("name") or "" for a in arts)
            sc = score_candidate(title, artist, hit_title, hit_artist)
            if sc > best_score:
                best_score = sc
                best = s

        if best_score >= 85:
            break

    if not best:
        return None, "netease:no-match"

    sid = best.get("id")
    try:
        sleep()
        lyric = http_get_json(
            f"https://music.163.com/api/song/lyric?id={sid}&lv=1&kv=1&tv=-1",
            {"Referer": "https://music.163.com/"},
        )
    except Exception as e:
        return None, f"netease:lyric-err:{e}"

    org = normalize_lrc((lyric.get("lrc") or {}).get("lyric") or "")
    trans = normalize_lrc((lyric.get("tlyric") or {}).get("lyric") or "")
    if not is_valid_lrc(org):
        # pure music / empty
        if lyric.get("nolyric") or lyric.get("uncollected"):
            return None, "netease:nolyric"
        return None, "netease:empty"
    if trans and is_valid_lrc(trans):
        org = merge_trans(org, trans)
    return org, f"netease:{sid}:score={best_score:.0f}"


def fetch_qq(title: str, artist: str) -> tuple[str | None, str]:
    queries = []
    ct = clean_title(title)
    for a in artist_variants(artist)[:3]:
        if a.lower() != "unknown":
            queries.append(f"{ct} {a}")
    queries.extend([ct, title])
    seen = set()
    qs = []
    for q in queries:
        q = q.strip()
        if q and q not in seen:
            seen.add(q)
            qs.append(q)

    best = None
    best_score = 40.0

    for q in qs[:4]:
        try:
            url = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?" + urllib.parse.urlencode(
                {"key": q, "format": "json"}
            )
            sleep()
            data = http_get_json(url, {"Referer": "https://y.qq.com/"})
            items = (((data.get("data") or {}).get("song") or {}).get("itemlist") or [])
        except Exception as e:
            log(f"    qq search err: {e}")
            continue

        for it in items:
            hit_title = it.get("name") or ""
            singer = it.get("singer")
            if isinstance(singer, list):
                hit_artist = " ".join(
                    (x.get("name") if isinstance(x, dict) else str(x)) or "" for x in singer
                )
            else:
                hit_artist = str(singer or "")
            sc = score_candidate(title, artist, hit_title, hit_artist)
            if sc > best_score:
                best_score = sc
                best = it
        if best_score >= 85:
            break

    if not best:
        return None, "qq:no-match"

    music_id = best.get("id") or best.get("mid")
    if not music_id:
        return None, "qq:no-id"

    try:
        sleep()
        url = (
            "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?"
            + urllib.parse.urlencode(
                {"nobase64": 1, "g_tk": 5381, "musicid": music_id, "format": "json"}
            )
        )
        data = http_get_json(url, {"Referer": "https://y.qq.com/"})
    except Exception as e:
        return None, f"qq:lyric-err:{e}"

    org = normalize_lrc(data.get("lyric") or "")
    trans = normalize_lrc(data.get("trans") or "")
    if not is_valid_lrc(org):
        return None, "qq:empty"
    if trans and is_valid_lrc(trans):
        org = merge_trans(org, trans)
    return org, f"qq:{music_id}:score={best_score:.0f}"


def fetch_kugou(title: str, artist: str) -> tuple[str | None, str]:
    ct = clean_title(title)
    pa = primary_artist(artist)
    keyword = f"{ct} {pa}".strip() if pa.lower() != "unknown" else ct

    lists = []
    # Web search (worked in probes)
    try:
        url = "https://songsearch.kugou.com/song_search_v2?" + urllib.parse.urlencode(
            {
                "keyword": keyword,
                "page": 1,
                "pagesize": 10,
                "userid": -1,
                "clientver": "",
                "platform": "WebFilter",
                "filter": 2,
                "iscorrection": 1,
                "privilege_filter": 0,
            }
        )
        sleep()
        data = http_get_json(url)
        lists = (data.get("data") or {}).get("lists") or []
    except Exception as e:
        log(f"    kugou search err: {e}")

    best = None
    best_score = 40.0
    for it in lists:
        hit_title = it.get("SongName") or it.get("OriSongName") or ""
        hit_artist = it.get("SingerName") or ""
        sc = score_candidate(title, artist, hit_title, hit_artist)
        if sc > best_score:
            best_score = sc
            best = it

    if not best:
        return None, "kugou:no-match"

    file_hash = (best.get("FileHash") or best.get("HQFileHash") or "").lower()
    duration_ms = best.get("Duration") or 0
    if duration_ms and duration_ms < 10000:
        # sometimes seconds
        duration_ms = int(duration_ms * 1000)

    # lyric candidate search
    cand = None
    for base in (
        "https://lyrics.kugou.com/search",
        "http://lyrics.kugou.com/search",
        "https://krcs.kugou.com/search",
    ):
        try:
            url = base + "?" + urllib.parse.urlencode(
                {
                    "ver": 1,
                    "man": "yes",
                    "client": "pc",
                    "keyword": f"{best.get('SingerName','')} - {best.get('SongName', ct)}".strip(" -"),
                    "duration": duration_ms or "",
                    "hash": file_hash,
                }
            )
            sleep()
            data = http_get_json(url)
            cands = data.get("candidates") or []
            if cands:
                cand = cands[0]
                break
        except Exception as e:
            log(f"    kugou lyric-search err ({base}): {e}")
            continue

    if not cand:
        return None, "kugou:no-candidate"

    content = None
    for base in (
        "https://lyrics.kugou.com/download",
        "http://lyrics.kugou.com/download",
        "https://krcs.kugou.com/download",
    ):
        try:
            url = base + "?" + urllib.parse.urlencode(
                {
                    "ver": 1,
                    "client": "pc",
                    "id": cand.get("id"),
                    "accesskey": cand.get("accesskey"),
                    "fmt": "lrc",
                    "charset": "utf8",
                }
            )
            sleep()
            data = http_get_json(url)
            content = data.get("content") or ""
            if content:
                break
        except Exception as e:
            log(f"    kugou download err: {e}")
            continue

    if not content:
        return None, "kugou:empty"

    try:
        text = base64.b64decode(content).decode("utf-8")
    except Exception:
        try:
            text = base64.b64decode(content).decode("gbk", errors="replace")
        except Exception:
            text = str(content)

    text = normalize_lrc(text)
    if not is_valid_lrc(text):
        return None, "kugou:invalid"
    return text, f"kugou:{file_hash[:8]}:score={best_score:.0f}"


def fetch_lrclib(title: str, artist: str) -> tuple[str | None, str]:
    ct = clean_title(title)
    pa = primary_artist(artist)
    headers = {
        "Lrclib-Client": CLIENT_ID,
        "User-Agent": CLIENT_ID,
    }

    # Prefer structured get
    gets = []
    for a in artist_variants(artist)[:3]:
        if a.lower() != "unknown":
            gets.append((ct, a))
    if pa.lower() != "unknown":
        gets.append((title, pa))

    best_text = None
    best_meta = "lrclib:none"
    best_score = 40.0

    for t, a in gets[:4]:
        try:
            url = "https://lrclib.net/api/get?" + urllib.parse.urlencode(
                {"track_name": t, "artist_name": a}
            )
            sleep()
            data = http_get_json(url, headers)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            log(f"    lrclib get err: {e}")
            continue
        except Exception as e:
            log(f"    lrclib get err: {e}")
            continue

        if data.get("instrumental"):
            continue
        sc = score_candidate(
            title, artist, data.get("trackName") or t, data.get("artistName") or a
        )
        text = normalize_lrc(data.get("syncedLyrics") or data.get("plainLyrics") or "")
        if is_valid_lrc(text) and sc > best_score:
            best_score = sc
            best_text = text
            best_meta = f"lrclib:get:{data.get('id')}:score={sc:.0f}"
            if sc >= 85:
                return best_text, best_meta

    # Search
    queries = []
    for a in artist_variants(artist)[:2]:
        if a.lower() != "unknown":
            queries.append(f"{a} {ct}")
            queries.append(f"{ct} {a}")
    queries.append(ct)

    for q in queries[:4]:
        try:
            url = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": q})
            sleep()
            arr = http_get_json(url, headers)
            if not isinstance(arr, list):
                continue
        except Exception as e:
            log(f"    lrclib search err: {e}")
            continue

        for item in arr[:15]:
            if item.get("instrumental"):
                continue
            sc = score_candidate(
                title,
                artist,
                item.get("trackName") or "",
                item.get("artistName") or "",
            )
            text = normalize_lrc(item.get("syncedLyrics") or item.get("plainLyrics") or "")
            if is_valid_lrc(text) and sc > best_score:
                best_score = sc
                best_text = text
                best_meta = f"lrclib:search:{item.get('id')}:score={sc:.0f}"
        if best_score >= 85:
            break

    if best_text:
        return best_text, best_meta
    return None, "lrclib:no-match"


PROVIDERS = [
    ("netease", fetch_netease),
    ("qq", fetch_qq),
    ("kugou", fetch_kugou),
    ("lrclib", fetch_lrclib),
]


def lrc_path_for(track: dict) -> Path:
    base = (track.get("file") or f"{track.get('id')}.mp3").replace(".mp3", ".lrc")
    # flat lyrics/ matching player convention
    return LYRICS_DIR / Path(base).name


def fetch_for_track(track: dict) -> tuple[str | None, str, str]:
    """Returns (lrc_text|None, source_name|'', notes)."""
    title = track.get("name") or ""
    artist = track.get("artist") or ""
    notes = []
    for name, fn in PROVIDERS:
        try:
            text, meta = fn(title, artist)
        except Exception as e:
            notes.append(f"{name}:exc:{e}")
            continue
        notes.append(meta)
        if text and is_valid_lrc(text):
            return text, name, " | ".join(notes)
    return None, "", " | ".join(notes) if notes else "no-providers"


def main() -> int:
    ap = argparse.ArgumentParser(description="Batch download LRC for all catalog tracks")
    ap.add_argument("--force", action="store_true", help="Re-download even if .lrc exists")
    ap.add_argument("--limit", type=int, default=0, help="Only first N tracks (0=all)")
    ap.add_argument("--start", type=int, default=0, help="Skip first N tracks")
    ap.add_argument("--ids", type=str, default="", help="Comma-separated track ids only")
    ap.add_argument("--delay", type=float, default=0.35, help="Delay between HTTP calls")
    args = ap.parse_args()

    global DELAY
    DELAY = max(0.1, float(args.delay))

    LYRICS_DIR.mkdir(parents=True, exist_ok=True)
    tracks = parse_musics(MUSICS_JS)
    log(f"Catalog: {len(tracks)} tracks from {MUSICS_JS}")

    if args.ids:
        idset = {int(x.strip()) for x in args.ids.split(",") if x.strip()}
        tracks = [t for t in tracks if int(t["id"]) in idset]
    if args.start:
        tracks = tracks[args.start :]
    if args.limit:
        tracks = tracks[: args.limit]

    report = {
        "total": len(tracks),
        "ok": 0,
        "skip_existing": 0,
        "miss": 0,
        "by_source": {},
        "items": [],
    }
    misses: list[str] = []

    for i, track in enumerate(tracks, 1):
        tid = track.get("id")
        name = track.get("name")
        artist = track.get("artist")
        out = lrc_path_for(track)
        prefix = f"[{i}/{len(tracks)}] id={tid} {name} — {artist}"

        if out.exists() and out.stat().st_size > 20 and not args.force:
            report["skip_existing"] += 1
            report["ok"] += 1
            log(f"{prefix}  SKIP (exists {out.name})")
            report["items"].append(
                {"id": tid, "file": out.name, "status": "existing", "source": None}
            )
            continue

        log(f"{prefix}  searching…")
        text, src, meta = fetch_for_track(track)
        if text:
            out.write_text(text, encoding="utf-8")
            report["ok"] += 1
            report["by_source"][src] = report["by_source"].get(src, 0) + 1
            log(f"    OK [{src}] → {out.name}  ({meta})")
            report["items"].append(
                {
                    "id": tid,
                    "file": out.name,
                    "status": "ok",
                    "source": src,
                    "meta": meta,
                }
            )
        else:
            report["miss"] += 1
            log(f"    MISS  ({meta})")
            misses.append(f"{tid}\t{name}\t{artist}\t{meta}")
            report["items"].append(
                {"id": tid, "file": out.name, "status": "miss", "meta": meta}
            )

    report_path = LYRICS_DIR / "_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    misses_path = LYRICS_DIR / "_misses.txt"
    misses_path.write_text("\n".join(misses) + ("\n" if misses else ""), encoding="utf-8")

    log("")
    log("======== SUMMARY ========")
    log(f"  processed : {report['total']}")
    log(f"  ok        : {report['ok']}  (existing skipped: {report['skip_existing']})")
    log(f"  miss      : {report['miss']}")
    log(f"  by source : {report['by_source']}")
    log(f"  report    : {report_path}")
    log(f"  misses    : {misses_path}")

    # Rebuild embedded map so the player can load lyrics without fetch
    try:
        import subprocess

        build = ROOT / "scripts" / "build_lyrics_map.py"
        if build.exists():
            log("Rebuilding js/data/lyrics-map.js …")
            subprocess.check_call([sys.executable, str(build)], cwd=str(ROOT))
    except Exception as e:
        log(f"  (map rebuild skipped: {e})")

    return 0 if report["miss"] < report["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
