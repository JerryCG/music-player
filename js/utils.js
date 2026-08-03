/**
 * Shared utilities for 果子狸のMusic Player
 */

// Prefer direct raw.githubusercontent (CORS + range requests; often audio/mpeg).
// NEVER use github.com/.../blob/...?raw=true — HTML redirects trigger net::ERR_BLOCKED_BY_ORB.
const RAW_BASE = 'https://raw.githubusercontent.com/JerryCG/music-collection-db/main/music/';
// Alternate raw path (same backend, different CDN edge)
const RAW_BASE_REFS = 'https://raw.githubusercontent.com/JerryCG/music-collection-db/refs/heads/main/music/';
// jsDelivr may proxy or redirect; useful alternate edge when raw is slow
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/JerryCG/music-collection-db@main/music/';
const CDN_FASTLY = 'https://fastly.jsdelivr.net/gh/JerryCG/music-collection-db@main/music/';

/**
 * Resolve playable URLs for a track (primary + fallbacks).
 * Never use github.com/.../blob/...?raw=true (ORB / HTML redirect trap).
 */
function getAudioUrlCandidates(track) {
  const file = track.file || extractFileFromLegacySrc(track.src);
  if (!file) return [];
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  // Order: stable raw first, then CDN edges (failover on timeout in player)
  return [
    RAW_BASE + encoded,
    CDN_BASE + encoded,
    CDN_FASTLY + encoded,
    RAW_BASE_REFS + encoded,
  ];
}

/** Best-effort HTTP cache warm-up without blocking playback */
const _prefetchLinks = new Map();
function prefetchAudioUrl(url) {
  if (!url || typeof document === 'undefined') return;
  if (_prefetchLinks.has(url)) return;
  try {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'fetch';
    link.href = url;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    _prefetchLinks.set(url, link);
    // Cap memory: drop oldest when many accumulate
    if (_prefetchLinks.size > 6) {
      const first = _prefetchLinks.keys().next().value;
      const old = _prefetchLinks.get(first);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      _prefetchLinks.delete(first);
    }
  } catch (_) {}
}

/**
 * Fetch full file and wrap as audio/mpeg blob URL.
 * Heavier, but forces a correct MIME type when the browser blocks octet-stream media (ORB).
 */
async function fetchAsMpegObjectUrl(url, signal) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const blob = new Blob([buf], { type: 'audio/mpeg' });
  return URL.createObjectURL(blob);
}

function extractFileFromLegacySrc(src) {
  if (!src) return null;
  const m = String(src).match(/music\/([^?]+)/);
  return m ? m[1] : null;
}

function debounce(fn, wait = 150) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    // Treat em/en/hyphen dashes as spaces so "Name — Artist" matches name+artist
    .replace(/[\u2014\u2013\u2012\u2212\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Multi-token includes: every space-separated token must appear in haystack */
function matchesQuery(haystack, query) {
  const h = normalizeText(haystack);
  const q = normalizeText(query);
  if (!q) return false;
  // Ignore pure punctuation tokens left over after normalization
  const tokens = q.split(/\s+/).filter(function (tok) {
    return tok && !/^[\s\-–—.,/|]+$/.test(tok);
  });
  if (!tokens.length) return false;
  return tokens.every((tok) => h.includes(tok));
}

/** Exact track for search-bar labels like "Title — Artist" or "Title - Artist" */
function findExactTrackLabel(musics, query) {
  const q = normalizeText(query);
  if (!q || !musics || !musics.length) return null;
  for (let i = 0; i < musics.length; i++) {
    const m = musics[i];
    const label = normalizeText(m.name + ' ' + m.artist);
    if (label === q) return m;
  }
  return null;
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return m + ':' + String(s).padStart(2, '0');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMatch(text, query) {
  const raw = String(text);
  const q = String(query || '').trim();
  if (!q) return escapeHtml(raw);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return escapeHtml(raw);

  // Build case-insensitive regex of tokens (longest first)
  const sorted = tokens.slice().sort((a, b) => b.length - a.length);
  const pattern = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  try {
    const re = new RegExp('(' + pattern + ')', 'ig');
    return escapeHtml(raw).replace(re, '<mark>$1</mark>');
  } catch {
    return escapeHtml(raw);
  }
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = item[key] || 'unknown';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function $(id) {
  return document.getElementById(id);
}

function toast(message, duration = 2800) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === null || v === undefined) return fallback;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

// Export for non-module script tags
window.MPUtils = {
  CDN_BASE,
  RAW_BASE,
  getAudioUrlCandidates,
  prefetchAudioUrl,
  fetchAsMpegObjectUrl,
  extractFileFromLegacySrc,
  debounce,
  normalizeText,
  matchesQuery,
  findExactTrackLabel,
  formatTime,
  escapeHtml,
  highlightMatch,
  groupBy,
  $,
  toast,
  storageGet,
  storageSet,
};
