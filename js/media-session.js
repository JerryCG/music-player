/**
 * Media Session API — lock screen / notification / headset / car media keys
 */
(function () {
  let currentLyric = '';
  let artwork = [];

  function init() {
    if (!('mediaSession' in navigator)) {
      console.info('Media Session API not supported');
      return;
    }

    // Prefer high-res logo for lock screen artwork (works on GitHub Pages subpaths)
    let path = window.location.pathname;
    if (!path.endsWith('/')) path = path.replace(/\/[^/]*$/, '/');
    const base = window.location.origin + path;
    const logo = new URL('logo-web.png', base).href;
    const logoSm = new URL('logo-web-removebg.png', base).href;
    artwork = [
      { src: logoSm, sizes: '192x192', type: 'image/png' },
      { src: logo, sizes: '512x512', type: 'image/png' },
    ];

    const handlers = {
      play: () => MPPlayer.play(),
      pause: () => MPPlayer.pause(),
      previoustrack: () => MPPlayer.previous(),
      nexttrack: () => MPPlayer.next(false),
      seekbackward: (details) => {
        const p = MPPlayer.getProgress();
        MPPlayer.seek(Math.max(0, p.current - (details.seekOffset || 10)), false);
      },
      seekforward: (details) => {
        const p = MPPlayer.getProgress();
        MPPlayer.seek(p.current + (details.seekOffset || 10), false);
      },
      seekto: (details) => {
        if (details.seekTime != null) MPPlayer.seek(details.seekTime, false);
      },
      stop: () => {
        MPPlayer.pause();
        const a = MPPlayer.getAudio();
        if (a) a.currentTime = 0;
      },
    };

    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {
        // Some actions unsupported on this platform
      }
    }
  }

  function updateMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      const albumParts = [track.genre || '果子狸のMusic Player'];
      if (currentLyric) albumParts.push(currentLyric);

      // Prefer disc cover in cache when available (same key as disc-art)
      var art = artwork;
      try {
        var map = MPUtils.storageGet('mp-disc-covers-v1', {}) || {};
        var cover = map[String(track.id)];
        if (cover) {
          art = [
            { src: cover, sizes: '300x300', type: 'image/jpeg' },
            { src: cover, sizes: '512x512', type: 'image/jpeg' },
          ].concat(artwork);
        }
      } catch (_) {}

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist,
        album: albumParts.join(' · '),
        artwork: art,
      });
    } catch (e) {
      console.warn('MediaMetadata failed', e);
    }
  }

  function updatePlaybackState(playing) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch (_) {}
  }

  function updatePosition(progress) {
    if (!('mediaSession' in navigator)) return;
    if (!progress || !progress.duration || !Number.isFinite(progress.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: progress.duration,
        playbackRate: 1,
        position: Math.min(progress.current, progress.duration),
      });
    } catch (_) {
      /* setPositionState not supported */
    }
  }

  function setLyricLine(text) {
    currentLyric = text || '';
    const track = MPPlayer.getCurrentTrack();
    if (track) updateMetadata(track);
  }

  window.MPMediaSession = {
    init,
    updateMetadata,
    updatePlaybackState,
    updatePosition,
    setLyricLine,
  };
})();
