/**
 * Lyrics for 果子狸のMusic Player
 *
 * Reality check (static GitHub Pages, no backend):
 *  - We cannot safely call QQ / NetEase / Kugou / Bilibili / YouTube lyrics APIs
 *    from the browser (CORS + ToS + unstable unofficial endpoints).
 *  - Audio fingerprinting (Shazam-like) needs a paid/server API key.
 *
 * What we do instead (best effort, high precision):
 *  1) Skip instrumentals / Light Music / BGM-style titles (no fake lyrics).
 *  2) Prefer local LRC files in music-collection-db when you add them.
 *  3) LRCLIB multi-query with strict name+artist scoring (synced preferred).
 *  4) Optional plain lyrics from lyrics.ovh as last resort (clearly labeled).
 *  5) Cache hits and confident misses (versioned) to avoid repeat wrong lookups.
 *
 * For rare Chinese tracks: add `lyrics/<same-as-mp3>.lrc` to the collection repo.
 */
(function () {
  // v4: stricter cover-artist + duration matching (invalidates old loose hits)
  const CACHE_PREFIX = 'mp-lyrics-v4-';
  const INSTRUMENTAL_GENRES = {
    'Light Music': true,
    Epic: false, // epic can be vocal; don't blanket-skip
  };

  let panel = null;
  let linesEl = null;
  let statusEl = null;
  let syncedLines = [];
  let plainText = '';
  let activeIndex = -1;
  let abortCtrl = null;
  let currentId = null;
  let visible = true;
  /** After a lyric-line click, ignore auto-index until seek settles */
  let seekLockUntil = 0;
  let seekLockIndex = -1;

  /** Don't auto-center until this time (ms since performance.now origin) */
  const USER_SCROLL_IDLE_MS = 5000;
  let userScrollResumeAt = 0;
  let ignoreScrollEvents = false;
  let scrollAnimId = null;

  function init() {
    panel = document.getElementById('lyrics-panel');
    linesEl = document.getElementById('lyrics-lines');
    statusEl = document.getElementById('lyrics-status');
    const toggle = document.getElementById('lyrics-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        visible = !visible;
        if (panel) panel.hidden = !visible;
        toggle.setAttribute('aria-pressed', String(visible));
        toggle.textContent = visible ? 'Lyrics' : 'Lyrics ▸';
      });
    }
    bindUserScrollGuards();
  }

  function bindUserScrollGuards() {
    if (!linesEl || linesEl._mpScrollGuards) return;
    linesEl._mpScrollGuards = true;

    var markUserScroll = function () {
      if (ignoreScrollEvents) return;
      userScrollResumeAt = performance.now() + USER_SCROLL_IDLE_MS;
      // Stop any in-progress auto smooth-scroll so it doesn't fight the user
      if (scrollAnimId) {
        cancelAnimationFrame(scrollAnimId);
        scrollAnimId = null;
      }
    };

    linesEl.addEventListener('wheel', markUserScroll, { passive: true });
    linesEl.addEventListener('touchstart', markUserScroll, { passive: true });
    linesEl.addEventListener('pointerdown', function (e) {
      // Only treat drag on the panel chrome / empty area as scroll intent;
      // line clicks are handled separately and clear the pause.
      if (e.target && e.target.closest && e.target.closest('.lyric-line')) return;
      markUserScroll();
    });
    linesEl.addEventListener('scroll', markUserScroll, { passive: true });
  }

  function userIsBrowsingLyrics() {
    return performance.now() < userScrollResumeAt;
  }

  function clearUserScrollPause() {
    userScrollResumeAt = 0;
  }

  function withPageScrollLocked(fn) {
    const x = window.scrollX;
    const y = window.scrollY;
    try {
      fn();
    } finally {
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
      requestAnimationFrame(function () {
        if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
      });
    }
  }

  function clear() {
    syncedLines = [];
    plainText = '';
    activeIndex = -1;
    currentId = null;
    seekLockUntil = 0;
    seekLockIndex = -1;
    clearUserScrollPause();
    if (scrollAnimId) {
      cancelAnimationFrame(scrollAnimId);
      scrollAnimId = null;
    }
    withPageScrollLocked(function () {
      if (linesEl) {
        linesEl.classList.remove('is-synced');
        linesEl.innerHTML = '';
        linesEl.scrollTop = 0;
      }
      if (statusEl) statusEl.textContent = '';
    });
  }

  /** Heuristic: track is instrumental / no vocals expected */
  function isLikelyInstrumental(track) {
    if (!track) return true;
    const genre = track.genre || '';
    if (genre === 'Light Music') return true;

    const blob = ((track.name || '') + ' ' + (track.artist || '') + ' ' + (track.file || '')).toLowerCase();
    const name = track.name || '';

    // Common instrumental markers (CN / EN / JP)
    const markers = [
      /\bbgm\b/i,
      /\binstrumental\b/i,
      /\boff\s*vocal\b/i,
      /纯音乐/,
      /钢琴/,
      /轻音乐/,
      /配乐/,
      /插曲\s*$/,
      /\bost\b/i,
      /\bscore\b/i,
      /karaoke/i,
      /伴奏/,
      /無歌詞/,
      /无歌词/,
      /music\s*box/i,
    ];
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].test(name) || markers[i].test(blob)) return true;
    }

    // Artist often "unknown" on ambient beds
    if (/^unknown$/i.test(String(track.artist || '').trim()) && genre === 'Light Music') {
      return true;
    }
    return false;
  }

  function cleanTitle(name) {
    return String(name || '')
      .replace(/\s*[-–—]\s*(Azure Lane|Theme Song|Movie Theme|TV Size).*$/i, '')
      .replace(/\s*[\(（][^）)]*[\)）]\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function primaryArtist(artist) {
    return String(artist || '')
      .split(/\s*[&,，/、]\s*|\s+feat\.?\s+|\s+ft\.?\s+/i)[0]
      .trim();
  }

  function allArtistParts(artist) {
    return String(artist || '')
      .split(/\s*[&,，/、]\s*|\s+feat\.?\s+|\s+ft\.?\s+/i)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function parseLrc(lrc) {
    const result = [];
    const lines = String(lrc).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
      const times = [];
      let m;
      while ((m = timeRe.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
        times.push(min * 60 + sec + ms / 1000);
      }
      const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
      if (!text || !times.length) continue;
      // Skip meta tags masquerading as lyrics
      if (/^(ti|ar|al|by|offset):/i.test(text)) continue;
      for (let t = 0; t < times.length; t++) result.push({ time: times[t], text: text });
    }
    result.sort(function (a, b) {
      return a.time - b.time;
    });
    return result;
  }

  function getPlayDuration() {
    try {
      var audio = window.MPPlayer && MPPlayer.getAudio && MPPlayer.getAudio();
      if (audio && Number.isFinite(audio.duration) && audio.duration > 5) return audio.duration;
    } catch (_) {}
    return null;
  }

  /** Wait briefly for metadata so cover rearrangements can match by length */
  function waitForPlayDuration(maxMs) {
    maxMs = maxMs || 1200;
    return new Promise(function (resolve) {
      var dur = getPlayDuration();
      if (dur) return resolve(dur);
      var audio = window.MPPlayer && MPPlayer.getAudio && MPPlayer.getAudio();
      if (!audio) return resolve(null);
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.removeEventListener('durationchange', onMeta);
        resolve(getPlayDuration());
      }, maxMs);
      function onMeta() {
        var d = getPlayDuration();
        if (!d) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.removeEventListener('durationchange', onMeta);
        resolve(d);
      }
      audio.addEventListener('loadedmetadata', onMeta);
      audio.addEventListener('durationchange', onMeta);
    });
  }

  function artistMatchLevel(hitArtist, track) {
    var an = MPUtils.normalizeText(hitArtist || '');
    if (!an) return 0;
    var full = MPUtils.normalizeText(track.artist || '');
    var parts = allArtistParts(track.artist || '');
    if (full && an === full) return 3; // exact full credit string
    if (full && (an.indexOf(full) >= 0 || full.indexOf(an) >= 0)) return 2;
    for (var p = 0; p < parts.length; p++) {
      var pn = MPUtils.normalizeText(parts[p]);
      if (!pn || pn === 'unknown') continue;
      if (an === pn) return 3;
      if (an.indexOf(pn) >= 0 || pn.indexOf(an) >= 0) return 2;
    }
    return 0;
  }

  function titleMatchLevel(hitTitle, trackName) {
    var tn = MPUtils.normalizeText(hitTitle || '');
    var n = MPUtils.normalizeText(trackName || '');
    if (!tn || !n) return 0;
    if (tn === n) return 3;
    if (tn.indexOf(n) >= 0 || n.indexOf(tn) >= 0) return 2;
    // CJK: character overlap ratio
    if (/[\u3400-\u9fff]/.test(n)) {
      var hit = 0;
      var seen = {};
      for (var i = 0; i < n.length; i++) {
        var ch = n.charAt(i);
        if (ch === ' ' || seen[ch]) continue;
        seen[ch] = true;
        if (tn.indexOf(ch) >= 0) hit++;
      }
      var uniq = Object.keys(seen).length || 1;
      if (hit / uniq >= 0.7) return 2;
      if (hit / uniq >= 0.45) return 1;
      return 0;
    }
    var nt = n.split(/\s+/);
    var ok = 0;
    for (var j = 0; j < nt.length; j++) {
      if (nt[j].length > 1 && tn.indexOf(nt[j]) >= 0) ok++;
    }
    if (ok === 0) return 0;
    if (ok >= nt.length) return 2;
    return 1;
  }

  /**
   * Score a lyrics candidate for THIS catalog entry (cover-aware).
   * Prefer same singer + similar duration so rearranged covers don't get the original's LRC.
   */
  function scoreHit(item, trackName, artistName, track, playDur) {
    if (!item) return -1;
    if (item.instrumental === true) return -100;

    var tn = item.trackName || item.name || '';
    var an = item.artistName || '';
    var titleLvl = titleMatchLevel(tn, trackName);
    if (titleLvl === 0) return -1;

    var artLvl = artistMatchLevel(an, track);
    var hasRealArtist =
      track.artist && !/^unknown$/i.test(String(track.artist).trim());

    // Covers: do not accept a different singer's sheet as "good enough"
    if (hasRealArtist && artLvl === 0) {
      return -1;
    }

    var s = 0;
    if (titleLvl === 3) s += 10;
    else if (titleLvl === 2) s += 6;
    else s += 2;

    if (artLvl === 3) s += 12;
    else if (artLvl === 2) s += 8;

    if (item.syncedLyrics) s += 3;
    else if (item.plainLyrics) s += 1;

    // Duration is critical for rearranged covers (谭维维 etc.)
    var dur = playDur != null ? playDur : getPlayDuration();
    var itemDur = item.duration;
    if (Number.isFinite(dur) && Number.isFinite(itemDur) && itemDur > 0) {
      var diff = Math.abs(dur - itemDur);
      if (diff <= 4) s += 10;
      else if (diff <= 10) s += 6;
      else if (diff <= 18) s += 2;
      else if (diff <= 30) s -= 4;
      else if (diff <= 50) s -= 10;
      else s -= 18; // almost certainly a different arrangement/version
    }

    return s;
  }

  function pickBestAmong(candidates, trackName, artistName, track, playDur) {
    if (!candidates || !candidates.length) return null;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var sc = scoreHit(candidates[i], trackName, artistName, track, playDur);
      if (sc > bestScore) {
        bestScore = sc;
        best = candidates[i];
      }
    }
    // Require artist match + solid title (min ~ title2 + artist2 = 14, or title3+artist2=18)
    // With duration bonus can clear lower; bare floor:
    if (bestScore < 14) return null;
    return best;
  }

  function extractFromHit(data) {
    if (!data || data.instrumental === true) {
      return { synced: [], plain: '', instrumental: true };
    }
    const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
    const plain = (data.plainLyrics || '').trim();
    return { synced: synced, plain: plain, instrumental: false };
  }

  async function fetchLrclib(track, signal) {
    const cleanName = cleanTitle(track.name);
    const artists = allArtistParts(track.artist);
    const primary = artists[0] || primaryArtist(track.artist);
    const fullArtist = String(track.artist || primary).trim();

    // Duration helps pick 谭维维's rearranged cut vs the original
    const playDur = await waitForPlayDuration(1400);

    const pool = [];

    function consider(data, fallbackTitle, fallbackArtist) {
      if (!data) return;
      pool.push({
        trackName: data.trackName || fallbackTitle || cleanName,
        artistName: data.artistName || fallbackArtist || primary,
        syncedLyrics: data.syncedLyrics,
        plainLyrics: data.plainLyrics,
        instrumental: data.instrumental,
        duration: data.duration,
        // keep raw for return
        _raw: data,
      });
    }

    // 1) Strict get: always pair THIS singer with the title (cover-first)
    const getPairs = [];
    getPairs.push([cleanName, primary]);
    getPairs.push([cleanName, fullArtist]);
    if (cleanName !== track.name) {
      getPairs.push([track.name, primary]);
      getPairs.push([track.name, fullArtist]);
    }
    for (let i = 0; i < artists.length && i < 3; i++) {
      getPairs.push([cleanName, artists[i]]);
    }

    const seenGet = {};
    for (let g = 0; g < getPairs.length; g++) {
      const key = getPairs[g][0] + '\0' + getPairs[g][1];
      if (seenGet[key] || !getPairs[g][1]) continue;
      seenGet[key] = true;
      const params = new URLSearchParams({
        track_name: getPairs[g][0],
        artist_name: getPairs[g][1],
      });
      try {
        const res = await fetch('https://lrclib.net/api/get?' + params.toString(), {
          signal: signal,
        });
        if (!res.ok) continue;
        const data = await res.json();
        consider(data, getPairs[g][0], getPairs[g][1]);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    // 2) Search — always include artist (never bare title alone → original singer noise)
    const queries = [];
    queries.push(primary + ' ' + cleanName);
    queries.push(cleanName + ' ' + primary);
    queries.push('"' + cleanName + '" ' + primary);
    if (fullArtist !== primary) {
      queries.push(fullArtist + ' ' + cleanName);
      queries.push(cleanName + ' ' + fullArtist);
    }
    if (track.name !== cleanName) {
      queries.push(primary + ' ' + track.name);
    }
    for (let i = 0; i < artists.length && i < 2; i++) {
      queries.push(artists[i] + ' ' + cleanName);
    }

    const seenQ = {};
    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      if (!q || seenQ[q]) continue;
      seenQ[q] = true;
      try {
        const sres = await fetch(
          'https://lrclib.net/api/search?' + new URLSearchParams({ q: q }).toString(),
          { signal: signal }
        );
        if (!sres.ok) continue;
        const arr = await sres.json();
        if (!Array.isArray(arr)) continue;
        for (let j = 0; j < arr.length; j++) {
          consider(arr[j], cleanName, primary);
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    // Prefer candidates that match this singer; score with duration
    var best = pickBestAmong(pool, cleanName, primary, track, playDur);
    if (!best) return null;

    // Return shape expected by extractFromHit
    return best._raw
      ? best._raw
      : {
          trackName: best.trackName,
          artistName: best.artistName,
          syncedLyrics: best.syncedLyrics,
          plainLyrics: best.plainLyrics,
          instrumental: best.instrumental,
          duration: best.duration,
        };
  }

  async function fetchLyricsOvh(track, signal) {
    // Plain lyrics only; still scoped to THIS artist (cover), not a random original
    const artistName = primaryArtist(track.artist);
    if (!artistName || /^unknown$/i.test(artistName)) return null;
    const artist = encodeURIComponent(artistName);
    const title = encodeURIComponent(cleanTitle(track.name));
    if (!artist || !title) return null;
    try {
      const res = await fetch('https://api.lyrics.ovh/v1/' + artist + '/' + title, {
        signal: signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const lyrics = (data && data.lyrics && String(data.lyrics).trim()) || '';
      if (lyrics.length < 20) return null;
      if (/not found|instrumental/i.test(lyrics) && lyrics.length < 80) return null;
      return lyrics;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;
    }
  }

  async function fetchLocalLrc(track, signal) {
    const base = (track.file || '').replace(/\.mp3$/i, '.lrc');
    if (!base) return null;
    const encoded = base.split('/').map(encodeURIComponent).join('/');
    const urls = [
      'https://cdn.jsdelivr.net/gh/JerryCG/music-collection-db@main/lyrics/' + encoded,
      'https://raw.githubusercontent.com/JerryCG/music-collection-db/main/lyrics/' + encoded,
    ];
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await fetch(urls[i], { signal: signal });
        if (!res.ok) continue;
        const text = await res.text();
        if (text && text.length > 10) {
          const parsed = parseLrc(text);
          if (parsed.length) return parsed;
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return null;
  }

  async function loadForTrack(track) {
    if (!track) {
      clear();
      return;
    }
    if (currentId === track.id && (syncedLines.length || plainText)) return;

    clear();
    currentId = track.id;

    // Instrumentals: never invent / attach wrong lyrics
    if (isLikelyInstrumental(track)) {
      showEmpty('No lyrics (instrumental)');
      MPUtils.storageSet(CACHE_PREFIX + track.id, { none: true, reason: 'instrumental' });
      return;
    }

    withPageScrollLocked(function () {
      if (statusEl) statusEl.textContent = 'Looking up lyrics…';
      if (linesEl) {
        linesEl.innerHTML = '<p class="lyrics-empty muted">Looking up lyrics…</p>';
        linesEl.scrollTop = 0;
      }
    });

    const cached = MPUtils.storageGet(CACHE_PREFIX + track.id, null);
    if (cached) {
      if (cached.none) {
        showEmpty(cached.reason === 'instrumental' ? 'No lyrics (instrumental)' : 'No lyrics found');
        return;
      }
      if (cached.synced || cached.plain) {
        applyLyrics(cached.synced, cached.plain);
        return;
      }
    }

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    try {
      // 1) Local LRC in collection repo (best for rare CN tracks you care about)
      const local = await fetchLocalLrc(track, signal);
      if (local && local.length) {
        applyLyrics(local, null);
        MPUtils.storageSet(CACHE_PREFIX + track.id, { synced: local, plain: null });
        return;
      }

      // 2) LRCLIB multi-strategy (synced preferred, strict match)
      const hit = await fetchLrclib(track, signal);
      if (hit) {
        if (hit.instrumental === true) {
          showEmpty('No lyrics (instrumental)');
          MPUtils.storageSet(CACHE_PREFIX + track.id, { none: true, reason: 'instrumental' });
          return;
        }
        const extracted = extractFromHit(hit);
        if (extracted.synced.length || extracted.plain) {
          applyLyrics(extracted.synced, extracted.plain);
          MPUtils.storageSet(CACHE_PREFIX + track.id, {
            synced: extracted.synced.length ? extracted.synced : null,
            plain: extracted.plain || null,
          });
          return;
        }
      }

      // 3) Plain lyrics fallback
      const plain = await fetchLyricsOvh(track, signal);
      if (plain) {
        applyLyrics(null, plain);
        MPUtils.storageSet(CACHE_PREFIX + track.id, { synced: null, plain: plain });
        return;
      }

      showEmpty('No lyrics found');
      MPUtils.storageSet(CACHE_PREFIX + track.id, { none: true });
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('Lyrics fetch failed', e);
      showEmpty('Lyrics unavailable');
    }
  }

  function applyLyrics(synced, plain) {
    syncedLines = synced && synced.length ? synced : [];
    plainText = plain || '';
    activeIndex = -1;
    if (!linesEl) return;

    withPageScrollLocked(function () {
      if (syncedLines.length) {
        if (statusEl) statusEl.textContent = 'Synced lyrics';
        linesEl.classList.add('is-synced');
        linesEl.innerHTML = syncedLines
          .map(function (l, i) {
            return (
              '<p class="lyric-line" data-i="' +
              i +
              '">' +
              MPUtils.escapeHtml(l.text) +
              '</p>'
            );
          })
          .join('');
        clearUserScrollPause();
        ignoreScrollEvents = true;
        linesEl.scrollTop = 0;
        ignoreScrollEvents = false;
        bindSyncedLineClicks();
        // Center first line after layout (smooth)
        requestAnimationFrame(function () {
          var nodes = linesEl.querySelectorAll('.lyric-line');
          if (nodes[0]) centerChildInContainer(linesEl, nodes[0], { smooth: true, duration: 400 });
        });
        return;
      }

      if (plainText) {
        linesEl.classList.remove('is-synced');
        if (statusEl) statusEl.textContent = 'Unsynced lyrics';
        linesEl.innerHTML =
          '<p class="lyrics-note muted">Timing not available — static lyrics</p>' +
          '<pre class="lyric-plain">' +
          MPUtils.escapeHtml(plainText) +
          '</pre>';
        linesEl.scrollTop = 0;
        return;
      }

      showEmptyUnlocked();
    });
  }

  function bindSyncedLineClicks() {
    if (!linesEl) return;
    linesEl.querySelectorAll('.lyric-line').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var i = parseInt(el.getAttribute('data-i'), 10);
        if (!Number.isFinite(i) || !syncedLines[i] || !window.MPPlayer) return;

        var lineTime = syncedLines[i].time;
        // Nudge slightly past the timestamp so indexForTime() stably selects this line
        var seekTo = lineTime + 0.02;
        if (i + 1 < syncedLines.length) {
          var nextT = syncedLines[i + 1].time;
          if (nextT > lineTime) {
            seekTo = Math.min(seekTo, lineTime + (nextT - lineTime) * 0.25);
          }
        }

        // User chose a line — resume follow mode and center immediately
        clearUserScrollPause();
        seekLockIndex = i;
        seekLockUntil = performance.now() + 500;
        setActiveLine(i, true, { smooth: true, duration: 320, force: true });

        try {
          MPPlayer.seek(seekTo, false);
        } catch (e) {
          console.warn('Lyric seek failed', e);
        }
      });
    });
  }

  /** Find last lyric index with time <= t (stable for click + playback). */
  function indexForTime(t) {
    if (!syncedLines.length) return -1;
    var lo = 0;
    var hi = syncedLines.length - 1;
    var ans = 0;
    var eps = 0.02;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (syncedLines[mid].time <= t + eps) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /**
   * @param {number} idx
   * @param {boolean} doCenter
   * @param {{smooth?: boolean, duration?: number, force?: boolean}} [opts]
   */
  function setActiveLine(idx, doCenter, opts) {
    opts = opts || {};
    if (!linesEl || idx < 0) return;
    var nodes = linesEl.querySelectorAll('.lyric-line');
    if (!nodes.length || idx >= nodes.length) return;
    activeIndex = idx;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('active', i === idx);
    }
    if (doCenter) {
      var centerOpts = {
        smooth: opts.smooth !== false,
        duration: opts.duration != null ? opts.duration : 520,
        force: !!opts.force,
      };
      // Wait a frame so .active styles apply, then center
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          centerChildInContainer(linesEl, nodes[idx], centerOpts);
        });
      });
    }
    if (window.MPMediaSession && syncedLines[idx]) {
      MPMediaSession.setLyricLine(syncedLines[idx].text);
    }
  }

  function showEmpty(msg) {
    withPageScrollLocked(function () {
      showEmptyUnlocked(msg);
    });
  }

  function showEmptyUnlocked(msg) {
    syncedLines = [];
    plainText = '';
    if (statusEl) statusEl.textContent = msg || 'No lyrics';
    if (linesEl) {
      linesEl.classList.remove('is-synced');
      linesEl.innerHTML =
        '<p class="lyrics-empty">' +
        MPUtils.escapeHtml(msg || 'No lyrics for this track') +
        '.<br><span class="muted">We only show lyrics that match this singer (covers) and similar length. Rare/rearranged versions: add lyrics/&lt;same-as-mp3&gt;.lrc to the collection repo.</span></p>';
      linesEl.scrollTop = 0;
    }
  }

  function sync(currentTime) {
    if (!syncedLines.length || !linesEl) return;

    var browsing = userIsBrowsingLyrics();

    // While handling a click-seek, keep the chosen line until audio catches up
    if (performance.now() < seekLockUntil && seekLockIndex >= 0) {
      if (activeIndex !== seekLockIndex) {
        setActiveLine(seekLockIndex, true, { smooth: true, duration: 320, force: true });
      }
      var lockedTime = syncedLines[seekLockIndex] && syncedLines[seekLockIndex].time;
      if (lockedTime != null && Math.abs(currentTime - lockedTime) < 0.35) {
        seekLockUntil = 0;
      }
      return;
    }

    var idx = indexForTime(currentTime);
    if (idx < 0) return;

    // Always update highlight so the "current" line is visible when user scrolls back
    if (idx !== activeIndex) {
      // When user is browsing, update active class without forcing scroll
      setActiveLine(idx, !browsing, {
        smooth: true,
        duration: 560,
        force: false,
      });
      return;
    }

    // Same line: only gently re-center if user is not browsing
    if (!browsing) {
      var node = linesEl.querySelector('.lyric-line.active');
      if (node) {
        centerChildInContainer(linesEl, node, { smooth: true, duration: 560, force: false });
      }
    }
  }

  /**
   * Vertically center `child` inside scrollable `container`.
   * @param {HTMLElement} container
   * @param {HTMLElement} child
   * @param {{smooth?: boolean, duration?: number, force?: boolean}} [opts]
   *   force: center even during user-browse pause (used for click)
   */
  function centerChildInContainer(container, child, opts) {
    opts = opts || {};
    if (!container || !child) return;
    if (!opts.force && userIsBrowsingLyrics()) return;

    var cRect = container.getBoundingClientRect();
    var childRect = child.getBoundingClientRect();
    var childTopInContent = childRect.top - cRect.top + container.scrollTop;
    var target =
      childTopInContent - container.clientHeight / 2 + childRect.height / 2;

    var maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (target < 0) target = 0;
    if (target > maxScroll) target = maxScroll;

    var delta = target - container.scrollTop;
    if (Math.abs(delta) < 1.5) return;

    if (opts.smooth === false) {
      ignoreScrollEvents = true;
      container.scrollTop = target;
      requestAnimationFrame(function () {
        ignoreScrollEvents = false;
      });
      return;
    }

    // Smooth, slightly slow ease-out (auto-follow & click)
    var duration = opts.duration != null ? opts.duration : 520;
    var start = container.scrollTop;
    var startTime = performance.now();
    if (scrollAnimId) cancelAnimationFrame(scrollAnimId);

    ignoreScrollEvents = true;
    function step(now) {
      var t = Math.min(1, (now - startTime) / duration);
      // ease-out cubic — gentle settle
      var eased = 1 - Math.pow(1 - t, 3);
      container.scrollTop = start + (target - start) * eased;
      if (t < 1) {
        scrollAnimId = requestAnimationFrame(step);
      } else {
        scrollAnimId = null;
        // Keep ignoring residual scroll events briefly
        setTimeout(function () {
          ignoreScrollEvents = false;
        }, 80);
      }
    }
    scrollAnimId = requestAnimationFrame(step);
  }

  function getCurrentLine() {
    if (activeIndex >= 0 && syncedLines[activeIndex]) return syncedLines[activeIndex].text;
    return '';
  }

  function toggle() {
    visible = !visible;
    if (panel) panel.hidden = !visible;
  }

  window.MPLyrics = {
    init: init,
    loadForTrack: loadForTrack,
    sync: sync,
    clear: clear,
    getCurrentLine: getCurrentLine,
    toggle: toggle,
    isLikelyInstrumental: isLikelyInstrumental,
  };
})();
