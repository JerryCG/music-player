/**
 * Lyrics for 果子狸のMusic Player
 *
 * Primary source (reliable): window.MP_LYRICS_MAP from js/data/lyrics-map.js
 *   — embedded LRC text, no network fetch, works offline / file:// / GH Pages.
 * Built by: scripts/download_lyrics.py then scripts/build_lyrics_map.py
 *
 * Fallbacks:
 *  1) fetch lyrics/<same-as-mp3>.lrc (same-origin)
 *  2) thin LRCLIB lookup if still missing
 */
(function () {
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
    purgeLegacyLyricsCaches();
  }

  /** Remove old localStorage lyrics entries (we no longer persist API results). */
  function purgeLegacyLyricsCaches() {
    try {
      var doomed = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('mp-lyrics') === 0) doomed.push(k);
      }
      for (var j = 0; j < doomed.length; j++) localStorage.removeItem(doomed[j]);
    } catch (_) {}
  }

  function bindUserScrollGuards() {
    if (!linesEl || linesEl._mpScrollGuards) return;
    linesEl._mpScrollGuards = true;

    var markUserScroll = function () {
      if (ignoreScrollEvents) return;
      userScrollResumeAt = performance.now() + USER_SCROLL_IDLE_MS;
      if (scrollAnimId) {
        cancelAnimationFrame(scrollAnimId);
        scrollAnimId = null;
      }
    };

    linesEl.addEventListener('wheel', markUserScroll, { passive: true });
    linesEl.addEventListener('touchstart', markUserScroll, { passive: true });
    linesEl.addEventListener('pointerdown', function (e) {
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

  function parseLrc(lrc) {
    const result = [];
    const lines = String(lrc).split(/\r?\n/);
    // Optional global shift in ms: [offset:500] / [offset:-200] (LRC convention)
    var offsetSec = 0;
    for (var oi = 0; oi < lines.length; oi++) {
      var om = lines[oi].match(/^\[offset\s*:\s*([+-]?\d+(?:\.\d+)?)\s*\]/i);
      if (om) {
        offsetSec = parseFloat(om[1]) / 1000;
        break;
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
      const times = [];
      let m;
      while ((m = timeRe.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
        times.push(min * 60 + sec + ms / 1000 + offsetSec);
      }
      const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
      if (!text || !times.length) continue;
      if (/^(ti|ar|al|by|offset):/i.test(text)) continue;
      for (let t = 0; t < times.length; t++) {
        var tt = times[t];
        if (tt < 0) tt = 0;
        result.push({ time: tt, text: text });
      }
    }
    result.sort(function (a, b) {
      return a.time - b.time;
    });
    return result;
  }

  function lrcFileName(track) {
    return (track && track.file ? String(track.file) : '').replace(/\.mp3$/i, '.lrc');
  }

  /** Parse raw LRC / plain text into {synced, plain}. */
  function parseLyricText(text) {
    if (!text || String(text).trim().length < 8) return null;
    text = String(text).replace(/^\uFEFF/, '');
    var head = text.trim().charAt(0);
    // Skip JSON junk
    if (head === '{') return null;
    if (head === '[' && /^\s*\[\s*\{/.test(text)) return null;

    var parsed = parseLrc(text);
    if (parsed.length) return { synced: parsed, plain: null };

    var plain = text
      .split(/\r?\n/)
      .filter(function (ln) {
        var t = ln.trim();
        if (!t) return false;
        if (/^\[(ti|ar|al|by|offset):/i.test(t)) return false;
        return true;
      })
      .join('\n')
      .trim();
    if (plain.length >= 12) return { synced: [], plain: plain };
    return null;
  }

  /**
   * Instant path: embedded map (no fetch). Always preferred.
   * @returns {{synced: Array, plain: string|null}|null}
   */
  function loadFromEmbeddedMap(track) {
    var base = lrcFileName(track);
    if (!base) return null;
    var map = window.MP_LYRICS_MAP;
    if (!map || typeof map !== 'object') return null;
    var text = map[base];
    if (text == null) {
      // try case-insensitive key (some FS differences)
      var lower = base.toLowerCase();
      var keys = Object.keys(map);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === lower) {
          text = map[keys[i]];
          break;
        }
      }
    }
    if (text == null) return null;
    return parseLyricText(text);
  }

  /**
   * Network/file fallback: fetch lyrics/<file>.lrc with robust base URL.
   * @returns {{synced: Array, plain: string|null}|null}
   */
  async function fetchLocalLrc(track, signal) {
    var base = lrcFileName(track);
    if (!base) return null;
    var encoded = base.split('/').map(encodeURIComponent).join('/');

    // Resolve relative to the page (works with /music-player/ subpath on GH Pages)
    var pageBase = '';
    try {
      pageBase = new URL('.', window.location.href).href;
    } catch (_) {
      pageBase = '';
    }

    var urls = [
      pageBase ? pageBase + 'lyrics/' + encoded : 'lyrics/' + encoded,
      './lyrics/' + encoded,
      'lyrics/' + encoded,
      'https://cdn.jsdelivr.net/gh/JerryCG/music-player@main/lyrics/' + encoded,
      'https://raw.githubusercontent.com/JerryCG/music-player/main/lyrics/' + encoded,
    ];

    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i], { signal: signal, cache: 'no-cache' });
        if (!res.ok) continue;
        var text = await res.text();
        var parsed = parseLyricText(text);
        if (parsed) return parsed;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return null;
  }

  /** Lightweight online fallback for tracks not yet in lyrics/ */
  async function fetchLrclibSimple(track, signal) {
    const name = String(track.name || '').trim();
    const artist = String(track.artist || '')
      .split(/\s*[&,，/、]\s*|\s+feat\.?\s+|\s+ft\.?\s+/i)[0]
      .trim();
    if (!name) return null;

    const headers = {
      'Lrclib-Client': 'JerryCG-Music-Player/1.1 (https://github.com/JerryCG/music-player)',
    };

    // 1) direct get
    if (artist && !/^unknown$/i.test(artist)) {
      try {
        const params = new URLSearchParams({ track_name: name, artist_name: artist });
        const res = await fetch('https://lrclib.net/api/get?' + params.toString(), {
          signal: signal,
          headers: headers,
        });
        if (res.ok) {
          const data = await res.json();
          if (data && !data.instrumental) {
            const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
            const plain = (data.plainLyrics || '').trim();
            if (synced.length || plain.length >= 20) {
              return { synced: synced, plain: synced.length ? null : plain };
            }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    // 2) single search
    try {
      const q = artist && !/^unknown$/i.test(artist) ? artist + ' ' + name : name;
      const res = await fetch(
        'https://lrclib.net/api/search?' + new URLSearchParams({ q: q }).toString(),
        { signal: signal, headers: headers }
      );
      if (!res.ok) return null;
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) return null;
      // Prefer same-artist-ish first hit with lyrics
      for (let i = 0; i < Math.min(8, arr.length); i++) {
        const item = arr[i];
        if (!item || item.instrumental) continue;
        const synced = item.syncedLyrics ? parseLrc(item.syncedLyrics) : [];
        const plain = (item.plainLyrics || '').trim();
        if (synced.length || plain.length >= 20) {
          return { synced: synced, plain: synced.length ? null : plain };
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
    return null;
  }

  async function loadForTrack(track) {
    if (!track) {
      clear();
      return;
    }

    if (abortCtrl) abortCtrl.abort();
    clear();
    currentId = track.id;

    withPageScrollLocked(function () {
      if (statusEl) statusEl.textContent = 'Looking up…';
      if (linesEl) {
        linesEl.innerHTML = '<p class="lyrics-empty muted">Looking up…</p>';
        linesEl.scrollTop = 0;
      }
    });

    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    try {
      // 1) Embedded map — no network, works offline and with file://
      var embedded = loadFromEmbeddedMap(track);
      if (embedded && (embedded.synced.length || embedded.plain)) {
        applyLyrics(embedded.synced, embedded.plain);
        return;
      }

      // 2) Fetch lyrics/*.lrc from the site (if map missing this track)
      const local = await fetchLocalLrc(track, signal);
      if (local && (local.synced.length || local.plain)) {
        applyLyrics(local.synced, local.plain);
        return;
      }

      // 3) Thin online fallback
      const online = await fetchLrclibSimple(track, signal);
      if (online && (online.synced.length || online.plain)) {
        applyLyrics(online.synced, online.plain);
        return;
      }

      showEmpty('No lyrics found');
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('Lyrics load failed', e);
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
        if (statusEl) statusEl.textContent = 'Synced';
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
        requestAnimationFrame(function () {
          var nodes = linesEl.querySelectorAll('.lyric-line');
          if (nodes[0]) centerChildInContainer(linesEl, nodes[0], { smooth: true, duration: 400 });
        });
        return;
      }

      if (plainText) {
        linesEl.classList.remove('is-synced');
        if (statusEl) statusEl.textContent = 'Static';
        linesEl.innerHTML =
          '<p class="lyrics-note muted">Timing not available — static text</p>' +
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
        var seekTo = lineTime + 0.02;
        if (i + 1 < syncedLines.length) {
          var nextT = syncedLines[i + 1].time;
          if (nextT > lineTime) {
            seekTo = Math.min(seekTo, lineTime + (nextT - lineTime) * 0.25);
          }
        }

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
    if (statusEl) statusEl.textContent = msg || 'None';
    if (linesEl) {
      linesEl.classList.remove('is-synced');
      linesEl.innerHTML =
        '<p class="lyrics-empty">' +
        MPUtils.escapeHtml(msg || 'No lyrics for this track') +
        '.<br><span class="muted">No entry in the embedded lyrics map for this track. Most songs are covered; rare BGM/OST may have none.</span></p>';
      linesEl.scrollTop = 0;
    }
  }

  function sync(currentTime) {
    if (!syncedLines.length || !linesEl) return;

    var browsing = userIsBrowsingLyrics();

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

    if (idx !== activeIndex) {
      setActiveLine(idx, !browsing, {
        smooth: true,
        duration: 560,
        force: false,
      });
      return;
    }

    if (!browsing) {
      var node = linesEl.querySelector('.lyric-line.active');
      if (node) {
        centerChildInContainer(linesEl, node, { smooth: true, duration: 560, force: false });
      }
    }
  }

  function centerChildInContainer(container, child, opts) {
    opts = opts || {};
    if (!container || !child) return;
    if (!opts.force && userIsBrowsingLyrics()) return;

    var cRect = container.getBoundingClientRect();
    var childRect = child.getBoundingClientRect();
    var childTopInContent = childRect.top - cRect.top + container.scrollTop;
    var target = childTopInContent - container.clientHeight / 2 + childRect.height / 2;

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

    var duration = opts.duration != null ? opts.duration : 520;
    var start = container.scrollTop;
    var startTime = performance.now();
    if (scrollAnimId) cancelAnimationFrame(scrollAnimId);

    ignoreScrollEvents = true;
    function step(now) {
      var t = Math.min(1, (now - startTime) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      container.scrollTop = start + (target - start) * eased;
      if (t < 1) {
        scrollAnimId = requestAnimationFrame(step);
      } else {
        scrollAnimId = null;
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
  };
})();
