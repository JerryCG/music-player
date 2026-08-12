/* App-shell service worker — does not cache large MP3s */
const CACHE = 'mp-shell-v147';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/utils.js',
  './js/theme.js',
  './js/sleep-timer.js',
  './js/library.js',
  './js/search.js',
  './js/player.js',
  './js/lyrics.js',
  './js/media-session.js',
  './js/audio-enhance.js',
  './js/disc-art.js',
  './js/app.js',
  './js/data/musics.js',
  './js/data/lyrics-map.js',
  './logo-web-removebg.png',
  './logo-web.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache audio, lyrics APIs, or cover lookups via SW
  if (
    url.hostname.includes('jsdelivr') ||
    url.hostname.includes('githubusercontent') ||
    url.hostname.includes('lrclib') ||
    url.hostname.includes('lyrics.ovh') ||
    url.hostname.includes('itunes.apple.com') ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('.lrc')
  ) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
