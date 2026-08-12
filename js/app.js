/**
 * App bootstrap — wires modules together
 */
(function () {
  /** True while the user is dragging the seek thumb (not mere focus). */
  let userSeekingProgress = false;

  function boot() {
    const musics = typeof getMusics === 'function' ? getMusics() : window.MUSICS || [];
    window.MUSICS = musics;

    if (!musics.length) {
      console.error('Music catalog empty');
      return;
    }

    // Theme first (no FOUC if inline script also ran)
    MPTheme.init();
    if (window.MPSleepTimer) MPSleepTimer.init();

    // Audio element
    const mount = document.getElementById('musicPlayerPosition');
    const audio = document.createElement('audio');
    audio.id = 'audio-el';
    if (mount) mount.appendChild(audio);
    MPPlayer.init(audio);

    // Modules
    MPLibrary.init(musics, {
      onPlayTrack: (id, list) => {
        MPPlayer.setMode(MPLibrary.getModePreference());
        MPPlayer.setQueue(list, id, MPLibrary.getModePreference());
      },
    });

    MPSearch.init(musics, {
      onPlay: (id) => {
        // Search spans the whole catalog. Reset session UI to All Songs · Random
        // so the mode pill matches the queue (avoids "Japanese Pop" while a
        // Chinese Pop track from search is playing).
        MPLibrary.setFilters('All', 'All');
        MPPlayer.setMode('Random');
        MPPlayer.setQueue(musics.slice(), id, 'Random');
      },
    });

    MPLyrics.init();
    MPMediaSession.init();
    MPAudioEnhance.initUI(audio);
    if (window.MPDiscArt) MPDiscArt.init();

    bindControls();
    bindKeyboard();
    bindPlayerEvents();

    // Placeholder disc art until first track loads
    if (window.MPDiscArt) {
      MPDiscArt.update({ id: 0, name: '果', artist: '果子狸', genre: 'Light Music' });
    }

    // Initial queue / restore
    const saved = MPPlayer.restore(musics);
    const params = new URLSearchParams(window.location.search);
    const deepId = params.get('id') ? Number(params.get('id')) : null;

    // Restore library filters including involves (Alan Walker+) and multi-chips.
    // Must pass artistRules / artistMode — artist string alone loses the "+" mode.
    restoreLibraryFilters(saved);

    let startList = MPLibrary.getSelectedTracks();
    if (!startList.length) startList = musics.slice();

    if (deepId && musics.some((m) => m.id === deepId)) {
      // Deep link ?id= — load silently; title/artist UI already show what is playing
      MPPlayer.setQueue(startList, deepId, (saved && saved.mode) || 'Random');
    } else if (saved && saved.id && musics.some((m) => m.id === saved.id)) {
      MPPlayer.setQueue(startList, saved.id, saved.mode || 'Random');
      // Restore position after metadata
      const a = MPPlayer.getAudio();
      const pos = saved.position || 0;
      const onMeta = () => {
        if (pos > 0 && Number.isFinite(a.duration) && pos < a.duration) {
          a.currentTime = pos;
        }
        a.removeEventListener('loadedmetadata', onMeta);
      };
      a.addEventListener('loadedmetadata', onMeta);
    } else {
      const mode = MPLibrary.getModePreference();
      MPPlayer.setQueue(startList, null, mode);
    }

    MPPlayer.updateModeUI();

    // Service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  /**
   * Rebuild library Genre/Artist UI from persisted player session.
   * Prefer full artistRules (with exact|involves). Fall back to artist + artistMode,
   * and parse trailing "+" / " · " labels from older saves when needed.
   */
  function restoreLibraryFilters(saved) {
    if (!saved || !window.MPLibrary || typeof MPLibrary.setFilters !== 'function') return;

    var genre = saved.genre || 'All';
    var rules = normalizeArtistRules(saved.artistRules);
    if (rules && rules.length) {
      MPLibrary.setFilters(genre, rules);
      return;
    }

    var artist = saved.artist || 'All';
    var mode = saved.artistMode === 'involves' ? 'involves' : 'exact';

    // Multi label without rules (legacy): "A+ · B · C+"
    if (artist !== 'All' && String(artist).indexOf(' · ') >= 0) {
      var parsed = parseArtistLabelToRules(artist);
      if (parsed.length) {
        MPLibrary.setFilters(genre, parsed);
        return;
      }
    }

    // Single name that accidentally includes "+" in the stored artist field
    if (artist !== 'All' && typeof artist === 'string') {
      var stripped = stripInvolvesSuffix(artist);
      if (stripped !== artist) {
        artist = stripped;
        mode = 'involves';
      }
    }

    // artistMode alone (single involves) when artistRules missing
    if (artist !== 'All' && mode === 'involves') {
      MPLibrary.setFilters(genre, artist, 'involves');
      return;
    }

    if (genre !== 'All' || artist !== 'All') {
      MPLibrary.setFilters(genre, artist, mode);
    }
  }

  function normalizeArtistRules(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      if (!r) continue;
      var value = stripInvolvesSuffix(r.value || r.name || '');
      if (!value || value === 'All') continue;
      out.push({
        value: value,
        mode: r.mode === 'involves' ? 'involves' : 'exact',
      });
    }
    return out;
  }

  function stripInvolvesSuffix(s) {
    s = String(s || '').trim();
    if (s.length > 1 && s.charAt(s.length - 1) === '+') {
      return s.slice(0, -1).trim();
    }
    return s;
  }

  /** Parse "Alan Walker+ · 邓紫棋" → [{value, mode}, ...] */
  function parseArtistLabelToRules(label) {
    return String(label || '')
      .split(' · ')
      .map(function (part) {
        part = String(part || '').trim();
        if (!part) return null;
        var involves = part.charAt(part.length - 1) === '+';
        var value = involves ? part.slice(0, -1).trim() : part;
        if (!value || value === 'All') return null;
        return { value: value, mode: involves ? 'involves' : 'exact' };
      })
      .filter(Boolean);
  }

  function bindControls() {
    const playBtn = document.getElementById('click-to-play-button');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        const list = MPLibrary.getSelectedTracks();
        if (!list.length) {
          MPUtils.toast('Current selection contains no music. Please reselect.');
          return;
        }
        const mode = MPLibrary.getModePreference();
        MPPlayer.setQueue(list, null, mode);
      });
    }

    var replay = $('replay-button');
    if (replay) replay.addEventListener('click', function () { MPPlayer.replay(); });
    var prev = $('previous-song-button');
    if (prev) prev.addEventListener('click', function () { MPPlayer.previous(); });
    var next = $('next-song-button');
    if (next) next.addEventListener('click', function () { MPPlayer.next(false); });
    var mode = $('mode-button');
    if (mode) mode.addEventListener('click', function () { MPPlayer.toggleMode(); });
    var pp = $('play-pause-button');
    if (pp) {
      pp.addEventListener('click', function () {
        if (window.MPAudioEnhance && MPAudioEnhance.resume) MPAudioEnhance.resume();
        MPPlayer.togglePlay();
      });
    }

    ['replay-button', 'previous-song-button', 'next-song-button', 'play-pause-button'].forEach(
      function (id) {
        var el = $(id);
        if (!el) return;
        el.addEventListener('click', function () {
          var a = MPPlayer.getAudio();
          if (a) a.muted = false;
          if (window.MPAudioEnhance && MPAudioEnhance.resume) MPAudioEnhance.resume();
        });
      }
    );

    const progress = document.getElementById('progress-bar');
    if (progress) {
      const beginSeek = function () {
        userSeekingProgress = true;
      };
      const endSeek = function () {
        if (!userSeekingProgress && document.activeElement !== progress) return;
        userSeekingProgress = false;
        // Drop focus so: (1) gold outline goes away, (2) timeupdate can move the thumb again
        try {
          progress.blur();
        } catch (_) {}
        // Snap UI to the real playhead after release
        var p = MPPlayer.getProgress();
        if (p.duration > 0) {
          progress.value = String(p.current / p.duration);
        }
      };

      progress.addEventListener('pointerdown', beginSeek);
      progress.addEventListener('mousedown', beginSeek);
      progress.addEventListener('touchstart', beginSeek, { passive: true });

      progress.addEventListener('input', function () {
        userSeekingProgress = true;
        MPPlayer.seek(Number(progress.value), true);
        var cur = document.getElementById('time-current');
        var p = MPPlayer.getProgress();
        if (cur && p.duration) {
          cur.textContent = MPUtils.formatTime(Number(progress.value) * p.duration);
        }
      });

      // `change` fires on mouse release; pointerup covers drag-release reliably
      progress.addEventListener('change', endSeek);
      progress.addEventListener('pointerup', endSeek);
      progress.addEventListener('mouseup', endSeek);
      progress.addEventListener('touchend', endSeek);
      progress.addEventListener('pointercancel', endSeek);
      // If focus leaves another way, still resume live updates
      progress.addEventListener('blur', function () {
        userSeekingProgress = false;
      });
    }

    const volume = document.getElementById('volume-slider');
    if (volume) {
      volume.addEventListener('input', () => {
        MPPlayer.setVolume(Number(volume.value));
      });
      // Same focus trap annoyance on volume — release outline after adjust
      var endVol = function () {
        try {
          volume.blur();
        } catch (_) {}
      };
      volume.addEventListener('change', endVol);
      volume.addEventListener('pointerup', endVol);
    }

  }

  function bindPlayerEvents() {
    let lastPosEmit = 0;

    MPPlayer.on('trackchange', (track) => {
      MPLyrics.loadForTrack(track);
      MPMediaSession.updateMetadata(track);
      MPMediaSession.setLyricLine('');
      if (window.MPDiscArt) MPDiscArt.update(track);
      updatePlayPauseUI(false);
      // Update URL without reload
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('id', String(track.id));
        history.replaceState(null, '', url);
      } catch (_) {}
    });

    MPPlayer.on('play', () => {
      updatePlayPauseUI(true);
      MPMediaSession.updatePlaybackState(true);
    });
    MPPlayer.on('pause', () => {
      updatePlayPauseUI(false);
      MPMediaSession.updatePlaybackState(false);
    });
    MPPlayer.on('timeupdate', (p) => {
      const cur = document.getElementById('time-current');
      const dur = document.getElementById('time-duration');
      const bar = document.getElementById('progress-bar');
      if (cur) cur.textContent = MPUtils.formatTime(p.current);
      if (dur) dur.textContent = MPUtils.formatTime(p.duration);
      // Only freeze the thumb while actively dragging — not merely because it has focus
      if (bar && p.duration && !userSeekingProgress) {
        bar.value = String(p.current / p.duration);
      }
      MPLyrics.sync(p.current);
      const now = performance.now();
      if (now - lastPosEmit > 1000) {
        MPMediaSession.updatePosition(p);
        lastPosEmit = now;
      }
    });
    MPPlayer.on('status', () => {
      updatePlayPauseUI(MPPlayer.isPlaying());
    });
  }

  function updatePlayPauseUI(playing) {
    const btn = document.getElementById('play-pause-button');
    if (btn) {
      btn.textContent = playing ? '❚❚' : '▶';
      btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      btn.classList.toggle('is-playing', !!playing);
    }
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;

      if (typing) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          MPPlayer.togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          {
            const p = MPPlayer.getProgress();
            MPPlayer.seek(p.current + 5, false);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          {
            const p = MPPlayer.getProgress();
            MPPlayer.seek(Math.max(0, p.current - 5), false);
          }
          break;
        case 'n':
        case 'N':
          MPPlayer.next(false);
          break;
        case 'p':
        case 'P':
          MPPlayer.previous();
          break;
        case 'm':
        case 'M':
          // Random ↔ Loop (same as mode button; toast already in toggleMode)
          e.preventDefault();
          MPPlayer.toggleMode();
          break;
        case 'l':
        case 'L':
          MPLyrics.toggle();
          break;
        case 't':
        case 'T':
          MPTheme.cycle();
          break;
        default:
          break;
      }
    });
  }

  function $(id) {
    return document.getElementById(id);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
