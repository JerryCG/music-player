/**
 * Dynamic disc-center art for 果子狸のMusic Player
 *
 * Best-effort strategy:
 *  1) Instant procedural art from name / artist / genre / id (always works).
 *  2) Optional cover lookup (iTunes Search API, no key) → cache → fade in.
 *  3) Logo stays as a tiny corner watermark only (not the whole label).
 */
(function () {
  const CACHE_KEY = 'mp-disc-covers-v1';
  const CACHE_MAX = 80;

  let canvas = null;
  let coverImg = null;
  let watermark = null;
  let labelEl = null;
  let loadToken = 0;

  const GENRE_THEMES = {
    'Chinese Ancientry': {
      hues: [38, 28, 15],
      motif: 'seal',
      sat: 55,
    },
    'Chinese Pop': {
      hues: [350, 12, 320],
      motif: 'bloom',
      sat: 62,
    },
    'Japanese Pop': {
      hues: [330, 280, 200],
      motif: 'fan',
      sat: 58,
    },
    'Korean Pop': {
      hues: [300, 260, 200],
      motif: 'spark',
      sat: 65,
    },
    'Western Pop': {
      hues: [200, 260, 40],
      motif: 'wave',
      sat: 60,
    },
    'Light Music': {
      hues: [160, 190, 45],
      motif: 'mist',
      sat: 40,
    },
    Epic: {
      hues: [25, 0, 45],
      motif: 'ray',
      sat: 70,
    },
    Electronic: {
      hues: [190, 280, 160],
      motif: 'grid',
      sat: 68,
    },
  };

  function init() {
    labelEl = document.querySelector('.disc-label');
    canvas = document.getElementById('disc-art');
    coverImg = document.getElementById('disc-cover');
    watermark = document.getElementById('disc-watermark');
    if (!canvas && labelEl) {
      // Graceful if markup missing
      return;
    }
    if (coverImg) {
      coverImg.hidden = true;
      coverImg.alt = '';
    }
  }

  function hashStr(s) {
    var h = 2166136261;
    var str = String(s || '');
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      var t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hsl(h, s, l, a) {
    if (a == null || a >= 1) return 'hsl(' + h + ',' + s + '%,' + l + '%)';
    return 'hsla(' + h + ',' + s + '%,' + l + '%,' + a + ')';
  }

  function monogram(track) {
    var name = (track && track.name) || '';
    // Prefer first CJK / letter / number
    var m = name.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/);
    if (m) return m[0].toUpperCase();
    return '♪';
  }

  function themeFor(track) {
    var g = (track && track.genre) || '';
    var base = GENRE_THEMES[g] || { hues: [42, 20, 200], motif: 'ring', sat: 50 };
    var name = (track && track.name) || '';
    var h0 = hashStr((track && track.id) + '|' + (track && track.artist) + '|' + name);
    var rnd = mulberry32(h0);
    return {
      h1: (base.hues[0] + rnd() * 24 - 12 + 360) % 360,
      h2: (base.hues[1] + rnd() * 30 - 15 + 360) % 360,
      h3: (base.hues[2] + rnd() * 20 - 10 + 360) % 360,
      sat: base.sat + rnd() * 10 - 5,
      motif: base.motif,
      rnd: rnd,
      seed: h0,
    };
  }

  function drawProcedural(track) {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var size = 160;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var t = themeFor(track);
    var rnd = t.rnd;
    var cx = size / 2;
    var cy = size / 2;
    var r = size / 2;

    // Background wash
    var g0 = ctx.createRadialGradient(cx * 0.7, cy * 0.65, r * 0.05, cx, cy, r);
    g0.addColorStop(0, hsl(t.h1, t.sat, 58));
    g0.addColorStop(0.45, hsl(t.h2, t.sat * 0.9, 38));
    g0.addColorStop(1, hsl(t.h3, t.sat * 0.7, 16));
    ctx.fillStyle = g0;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Motif layer
    ctx.save();
    ctx.translate(cx, cy);
    drawMotif(ctx, t.motif, r, t, rnd);
    ctx.restore();

    // Soft vignette
    var vig = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vig;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Gold rim hint
    ctx.strokeStyle = 'rgba(232,197,71,0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
    ctx.stroke();

    // Monogram
    var mono = monogram(track);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,248,230,0.94)';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 8;
    var fontSize = mono.length > 1 ? 42 : /[\u3400-\u9fff]/.test(mono) ? 52 : 56;
    ctx.font = '600 ' + fontSize + 'px "Cormorant Garamond", "Noto Serif SC", Georgia, serif';
    ctx.fillText(mono, cx, cy + 1);
    ctx.shadowBlur = 0;

    // Tiny secondary initial (artist) under monogram for depth
    var artist = (track && track.artist) || '';
    var a0 = artist.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z]/);
    if (a0) {
      ctx.font = '500 11px Outfit, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,240,200,0.55)';
      ctx.fillText(a0[0].toUpperCase(), cx, cy + r * 0.42);
    }

    if (canvas) {
      canvas.hidden = false;
      canvas.classList.remove('is-covered');
    }
  }

  function drawMotif(ctx, motif, r, t, rnd) {
    ctx.globalAlpha = 0.55;
    if (motif === 'seal') {
      for (var i = 0; i < 5; i++) {
        ctx.strokeStyle = hsl(t.h1, 40, 70, 0.35 - i * 0.05);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.35 + i * 0.1), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.rotate(-0.4);
      ctx.strokeStyle = hsl(t.h1, 50, 75, 0.4);
      ctx.strokeRect(-r * 0.28, -r * 0.28, r * 0.56, r * 0.56);
    } else if (motif === 'fan') {
      for (var f = 0; f < 9; f++) {
        var a0 = -Math.PI * 0.7 + f * 0.16;
        ctx.strokeStyle = hsl(t.h2 + f * 4, t.sat, 70, 0.35);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a0) * r * 0.85, Math.sin(a0) * r * 0.85);
        ctx.stroke();
      }
    } else if (motif === 'bloom') {
      for (var p = 0; p < 8; p++) {
        var ang = (p / 8) * Math.PI * 2;
        ctx.fillStyle = hsl(t.h1 + p * 8, t.sat, 65, 0.22);
        ctx.beginPath();
        ctx.ellipse(
          Math.cos(ang) * r * 0.28,
          Math.sin(ang) * r * 0.28,
          r * 0.22,
          r * 0.12,
          ang,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    } else if (motif === 'spark') {
      for (var s = 0; s < 18; s++) {
        var rr = r * (0.2 + rnd() * 0.65);
        var aa = rnd() * Math.PI * 2;
        ctx.fillStyle = hsl(t.h1, 70, 80, 0.5);
        ctx.beginPath();
        ctx.arc(Math.cos(aa) * rr, Math.sin(aa) * rr, 1.2 + rnd() * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (motif === 'wave') {
      ctx.strokeStyle = hsl(t.h1, 50, 75, 0.4);
      ctx.lineWidth = 1.5;
      for (var w = 0; w < 4; w++) {
        ctx.beginPath();
        for (var x = -r; x <= r; x += 4) {
          var y = Math.sin(x * 0.08 + w) * (8 + w * 4) + w * 10 - 15;
          if (x === -r) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else if (motif === 'mist') {
      for (var m = 0; m < 6; m++) {
        ctx.fillStyle = hsl(t.h1, 30, 80, 0.12);
        ctx.beginPath();
        ctx.arc((rnd() - 0.5) * r, (rnd() - 0.5) * r, r * (0.15 + rnd() * 0.25), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (motif === 'ray') {
      for (var k = 0; k < 16; k++) {
        var a = (k / 16) * Math.PI * 2;
        ctx.strokeStyle = hsl(t.h1, 60, 70, 0.28);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2);
        ctx.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
        ctx.stroke();
      }
    } else if (motif === 'grid') {
      ctx.strokeStyle = hsl(t.h1, 50, 70, 0.25);
      ctx.lineWidth = 1;
      for (var g = -4; g <= 4; g++) {
        ctx.beginPath();
        ctx.moveTo(g * r * 0.15, -r);
        ctx.lineTo(g * r * 0.15, r);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-r, g * r * 0.15);
        ctx.lineTo(r, g * r * 0.15);
        ctx.stroke();
      }
    } else {
      for (var n = 1; n <= 4; n++) {
        ctx.strokeStyle = hsl(t.h1, 40, 70, 0.3);
        ctx.beginPath();
        ctx.arc(0, 0, r * n * 0.18, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function readCache() {
    try {
      return MPUtils.storageGet(CACHE_KEY, {}) || {};
    } catch (_) {
      return {};
    }
  }

  function writeCache(map) {
    var keys = Object.keys(map);
    if (keys.length > CACHE_MAX) {
      // Drop oldest-ish arbitrary keys
      keys.slice(0, keys.length - CACHE_MAX).forEach(function (k) {
        delete map[k];
      });
    }
    MPUtils.storageSet(CACHE_KEY, map);
  }

  function showCover(url) {
    if (!coverImg || !url) return;
    coverImg.onload = function () {
      coverImg.hidden = false;
      if (canvas) canvas.classList.add('is-covered');
      if (labelEl) labelEl.classList.add('has-cover');
    };
    coverImg.onerror = function () {
      hideCover();
    };
    coverImg.src = url;
  }

  function hideCover() {
    if (coverImg) {
      coverImg.hidden = true;
      coverImg.removeAttribute('src');
    }
    if (canvas) canvas.classList.remove('is-covered');
    if (labelEl) labelEl.classList.remove('has-cover');
  }

  function cleanQueryPart(s) {
    return String(s || '')
      .replace(/\s*[\(（].*?[\)）]\s*/g, ' ')
      .replace(/\s*[-–—]\s*(Azure Lane|Theme Song|BGM).*$/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function fetchCoverUrl(track, signal) {
    var cache = readCache();
    var key = String(track.id);
    if (cache[key] === null) return null; // remembered miss
    if (cache[key]) return cache[key];

    var term = cleanQueryPart(track.artist) + ' ' + cleanQueryPart(track.name);
    if (term.length < 2) return null;

    // iTunes Search — no API key, CORS-enabled
    var url =
      'https://itunes.apple.com/search?term=' +
      encodeURIComponent(term) +
      '&media=music&entity=song&limit=8';

    var res = await fetch(url, { signal: signal, credentials: 'omit' });
    if (!res.ok) throw new Error('cover http ' + res.status);
    var data = await res.json();
    var results = (data && data.results) || [];
    if (!results.length) {
      // Try title only
      var url2 =
        'https://itunes.apple.com/search?term=' +
        encodeURIComponent(cleanQueryPart(track.name)) +
        '&media=music&entity=song&limit=8';
      res = await fetch(url2, { signal: signal, credentials: 'omit' });
      if (res.ok) {
        data = await res.json();
        results = (data && data.results) || [];
      }
    }

    var best = pickBestCover(results, track);
    var art = best && (best.artworkUrl100 || best.artworkUrl60);
    if (art) {
      art = art.replace(/100x100bb/, '300x300bb').replace(/60x60bb/, '300x300bb');
      cache[key] = art;
      writeCache(cache);
      return art;
    }
    cache[key] = null;
    writeCache(cache);
    return null;
  }

  function pickBestCover(results, track) {
    if (!results || !results.length) return null;
    var n = MPUtils.normalizeText(cleanQueryPart(track.name));
    var a = MPUtils.normalizeText(cleanQueryPart(track.artist));
    var best = null;
    var score = -1;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r.artworkUrl100 && !r.artworkUrl60) continue;
      var tn = MPUtils.normalizeText(r.trackName || '');
      var an = MPUtils.normalizeText(r.artistName || '');
      var s = 0;
      if (tn === n) s += 6;
      else if (tn.indexOf(n) >= 0 || n.indexOf(tn) >= 0) s += 3;
      if (an.indexOf(a) >= 0 || a.indexOf(an) >= 0) s += 4;
      if (s > score) {
        score = s;
        best = r;
      }
    }
    // Require at least a weak name match to avoid wrong covers
    if (score < 3) return results[0].artworkUrl100 ? results[0] : null;
    return best;
  }

  function update(track) {
    if (!track) {
      drawProcedural({ name: '果', artist: '', genre: 'Light Music', id: 0 });
      hideCover();
      return;
    }

    var token = ++loadToken;
    hideCover();
    drawProcedural(track);

    if (watermark) watermark.hidden = false;

    // Progressive enhancement: real cover when available
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var signal = ctrl ? ctrl.signal : undefined;

    fetchCoverUrl(track, signal)
      .then(function (art) {
        if (token !== loadToken) return;
        if (art) showCover(art);
      })
      .catch(function () {
        /* keep procedural */
      });
  }

  window.MPDiscArt = {
    init: init,
    update: update,
  };
})();
