/**
 * Core audio player — native <audio> with aggressive preload for smoother transitions.
 *
 * Strategy:
 *  - Stream via range-request URLs (never full-file blob unless last-resort).
 *  - Shadow <audio> preloads the *planned* next track while current plays.
 *  - Random mode uses a shuffled play order (prev/next walk that list; reshuffle
 *    when the list is exhausted) so back/forward stay predictable.
 *  - Slow primary source → timed failover to alternate CDN.
 *  - Mid-play stall recovery (wait, then gentle re-seek / alternate URL).
 *  - Background / lock-screen continuity (Android PWA): keep playbackIntent,
 *    avoid pause-before-src on auto-advance, multi-shot play() retries, and
 *    resume on visibility / page lifecycle / media canplay.
 */
(function () {
  const STORAGE_KEY = 'mp-player-state';
  const LOAD_TIMEOUT_MS = 4500;
  const STALL_TIMEOUT_MS = 7000;
  const PRELOAD_MIN_READY = 2; // HAVE_CURRENT_DATA
  /** Retries after play() fails in background (ms) — Chrome Android often needs several */
  const PLAY_RETRY_DELAYS_MS = [0, 40, 120, 300, 700, 1500, 3000, 6000, 12000];

  /** @type {HTMLAudioElement|null} */
  let audio = null;
  /** @type {HTMLAudioElement|null} hidden warm-up element */
  let preloader = null;

  let queue = [];
  let queueIndex = -1;
  let mode = 'Random';
  /**
   * Random-mode play order: permutation of queue indices.
   * prev/next move shufflePos; when the order is finished, a new permutation is built.
   * @type {number[]}
   */
  let shuffleOrder = [];
  /** Position within shuffleOrder (−1 if unset). */
  let shufflePos = -1;
  /**
   * Precomputed next-cycle order once we are on the last shuffle track (for preload).
   * @type {number[]|null}
   */
  let nextShuffleOrder = null;
  /**
   * Scope of the *active* play session (applied via Play selection / search / restore).
   * Not the pending Library dropdowns — those may differ until the user applies them.
   */
  let sessionScope = { genre: 'All', artist: 'All', artistMode: 'exact', artistRules: [] };
  let playCounts = new Map();
  let urlAttempt = 0;
  let currentTrack = null;
  let suppressEnded = false;
  let listeners = {};
  let objectUrl = null;
  let blobMode = false;
  let blobAbort = null;

  /** Next track we intend to play (preloaded when possible) */
  let upcomingTrack = null;
  let loadTimer = null;
  let stallTimer = null;
  let loadGeneration = 0;
  /** @type {number[]} */
  let playRetryTimers = [];
  let lifecycleBound = false;

  /**
   * User/session wants audio to play (next/prev/search/play/auto-advance).
   * When true we retry play() as media becomes ready (gesture may expire
   * before a slow CDN responds) and when the app returns from background.
   */
  let playbackIntent = false;
  /** At least one play() has succeeded in this page session */
  let audioUnlocked = false;
  let pendingPlayRetry = false;
  /** True while auto-advancing / loading next with intent (suppress false "paused") */
  let advancing = false;

  function emit(event, payload) {
    const fns = listeners[event];
    if (fns) {
      fns.forEach((fn) => {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      });
    }
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function primaryUrl(track) {
    const urls = MPUtils.getAudioUrlCandidates(track);
    return urls[0] || null;
  }

  function wireAudioElement(el) {
    el.preload = 'auto';
    el.controls = false;
    el.muted = false;
    if (typeof el.volume !== 'number' || el.volume === 0) el.volume = 0.9;
    el.crossOrigin = 'anonymous';
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.setAttribute('controlslist', 'nodownload noplaybackrate');

    el.addEventListener('ended', () => {
      if (suppressEnded) return;
      // Sleep timer may consume this completion and stop instead of advancing
      if (
        window.MPSleepTimer &&
        typeof MPSleepTimer.shouldBlockNext === 'function' &&
        MPSleepTimer.shouldBlockNext(true)
      ) {
        return;
      }
      // Keep continuous session for lock-screen / background auto-advance
      playbackIntent = true;
      pendingPlayRetry = true;
      advancing = true;
      keepMediaSessionPlaying();
      next(true);
    });
    el.addEventListener('error', onAudioError);
    el.addEventListener('timeupdate', () => {
      emit('timeupdate', getProgress());
      // Warm next track once we're into the song
      if (el.currentTime > 8 && el.duration && el.currentTime / el.duration > 0.12) {
        ensureUpcomingAndPreload();
      }
    });
    el.addEventListener('loadedmetadata', () => {
      emit('timeupdate', getProgress());
      maybeResumePlayback();
    });
    el.addEventListener('canplay', () => {
      clearLoadTimer();
      maybeResumePlayback();
      if (!el.paused) setStatus('playing');
      ensureUpcomingAndPreload();
    });
    el.addEventListener('canplaythrough', () => {
      clearLoadTimer();
      maybeResumePlayback();
      ensureUpcomingAndPreload();
    });
    el.addEventListener('play', () => {
      audioUnlocked = true;
      playbackIntent = true;
      pendingPlayRetry = false;
      advancing = false;
      clearPlayRetries();
      if (window.MPAudioEnhance) {
        if (MPAudioEnhance.ensureGraph) MPAudioEnhance.ensureGraph();
        if (MPAudioEnhance.resume) MPAudioEnhance.resume();
      }
      setStatus('playing');
      keepMediaSessionPlaying();
      emit('play', currentTrack);
      persist();
      document.body.classList.add('is-playing');
      ensureUpcomingAndPreload();
    });
    el.addEventListener('pause', () => {
      clearStallTimer();
      // Track handoff / loading next: do NOT treat as user pause (Android fires
      // pause when src changes; clearing intent here breaks background autoplay).
      if (suppressEnded || advancing || playbackIntent || pendingPlayRetry) {
        if (playbackIntent || advancing || pendingPlayRetry) {
          keepMediaSessionPlaying();
          if (playbackIntent && el.paused) schedulePlayRetries();
        }
        return;
      }
      document.body.classList.remove('is-playing');
      setStatus('paused');
      emit('pause', currentTrack);
      persist();
      if (window.MPMediaSession) MPMediaSession.updatePlaybackState(false);
    });
    el.addEventListener('waiting', () => {
      if (playbackIntent) setStatus('loading');
      armStallTimer();
    });
    el.addEventListener('stalled', () => {
      armStallTimer();
    });
    el.addEventListener('playing', () => {
      clearStallTimer();
      clearLoadTimer();
      clearPlayRetries();
      advancing = false;
      pendingPlayRetry = false;
      if (window.MPAudioEnhance && MPAudioEnhance.resume) MPAudioEnhance.resume();
      setStatus('playing');
      keepMediaSessionPlaying();
      document.body.classList.add('is-playing');
    });
    el.addEventListener('progress', () => {
      // Buffering progress — clear slow-load timer once we have data
      if (el.readyState >= PRELOAD_MIN_READY) clearLoadTimer();
    });
  }

  function keepMediaSessionPlaying() {
    if (window.MPMediaSession && MPMediaSession.updatePlaybackState) {
      try {
        MPMediaSession.updatePlaybackState(true);
      } catch (_) {}
    }
  }

  function clearPlayRetries() {
    for (var i = 0; i < playRetryTimers.length; i++) {
      clearTimeout(playRetryTimers[i]);
    }
    playRetryTimers = [];
  }

  /**
   * Multi-shot play() retries — critical when Chrome Android freezes the page
   * between tracks or rejects the first play() after a background src change.
   */
  function schedulePlayRetries() {
    clearPlayRetries();
    if (!playbackIntent) return;
    for (var i = 0; i < PLAY_RETRY_DELAYS_MS.length; i++) {
      (function (delay) {
        var id = setTimeout(function () {
          if (!playbackIntent || !audio || !currentTrack) return;
          if (!audio.paused && !audio.ended) {
            clearPlayRetries();
            return;
          }
          if (window.MPAudioEnhance && MPAudioEnhance.resume) MPAudioEnhance.resume();
          tryPlay(currentTrack, true);
        }, delay);
        playRetryTimers.push(id);
      })(PLAY_RETRY_DELAYS_MS[i]);
    }
  }

  function resumeIfIntended() {
    if (!playbackIntent || !audio || !currentTrack) return;
    if (window.MPAudioEnhance && MPAudioEnhance.resume) MPAudioEnhance.resume();
    if (!audio.paused && !audio.ended) return;
    pendingPlayRetry = true;
    keepMediaSessionPlaying();
    tryPlay(currentTrack, true);
    schedulePlayRetries();
  }

  function bindLifecycleResume() {
    if (lifecycleBound) return;
    lifecycleBound = true;

    var onFg = function () {
      // Page Lifecycle / tab focus / returning from another app
      resumeIfIntended();
    };

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) onFg();
    });
    window.addEventListener('pageshow', onFg);
    window.addEventListener('focus', onFg);
    // Page Lifecycle API (Chrome)
    document.addEventListener('resume', onFg);
    document.addEventListener('freeze', function () {
      // Persist intent; play will be retried on resume
      if (playbackIntent) persist();
    });
  }

  function init(audioEl) {
    audio = audioEl || document.createElement('audio');
    wireAudioElement(audio);

    // Shadow preloader (never attached to Web Audio — avoids MediaElementSource limits)
    preloader = document.createElement('audio');
    preloader.preload = 'auto';
    preloader.controls = false;
    preloader.muted = true;
    preloader.crossOrigin = 'anonymous';
    preloader.setAttribute('playsinline', '');
    preloader.setAttribute('aria-hidden', 'true');
    preloader.style.cssText = 'display:none!important';
    // Park in DOM — some browsers buffer more reliably when in document
    if (audio.parentNode) {
      audio.parentNode.appendChild(preloader);
    } else {
      document.body.appendChild(preloader);
    }

    bindLifecycleResume();
    return audio;
  }

  function setStatus(status) {
    emit('status', status);
    const el = document.getElementById('player-status');
    if (el) {
      el.dataset.status = status;
      el.textContent =
        status === 'loading'
          ? 'Loading…'
          : status === 'error'
            ? 'Error'
            : status === 'playing'
              ? 'Playing'
              : status === 'paused'
                ? 'Paused'
                : '';
    }
    document.body.dataset.playerStatus = status;
  }

  function clearLoadTimer() {
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
  }

  function clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function armLoadTimer(track, generation, autoplay) {
    clearLoadTimer();
    loadTimer = setTimeout(function () {
      if (generation !== loadGeneration) return;
      if (!audio || currentTrack !== track) return;
      // Still no usable media → try next CDN / path
      if (audio.readyState < PRELOAD_MIN_READY) {
        console.warn('Load timeout, trying alternate source for', track.name);
        urlAttempt += 1;
        applyUrl(track, autoplay, generation);
      }
    }, LOAD_TIMEOUT_MS);
  }

  function armStallTimer() {
    clearStallTimer();
    stallTimer = setTimeout(function () {
      if (!audio || !currentTrack) return;
      if (audio.paused || audio.ended) return;
      // Mid-play stall recovery
      const t = audio.currentTime;
      const track = currentTrack;
      console.warn('Playback stall recovery at', t, track && track.name);
      // 1) soft nudge
      try {
        if (Number.isFinite(t) && t > 0.25) {
          audio.currentTime = Math.max(0, t - 0.05);
        }
        const p = audio.play();
        if (p && p.catch) p.catch(function () {});
      } catch (_) {}

      // 2) if still starved shortly after, flip CDN while preserving position
      setTimeout(function () {
        if (!audio || currentTrack !== track) return;
        if (audio.readyState >= 3 && !audio.paused) return;
        recoverWithAlternateUrl(track, t);
      }, 2500);
    }, STALL_TIMEOUT_MS);
  }

  function recoverWithAlternateUrl(track, resumeAt) {
    const urls = MPUtils.getAudioUrlCandidates(track);
    if (!urls.length) return;
    urlAttempt = Math.min(urlAttempt + 1, urls.length - 1);
    const url = urls[urlAttempt] || urls[0];
    const gen = ++loadGeneration;
    suppressEnded = true;
    setStatus('loading');
    audio.crossOrigin = 'anonymous';
    audio.src = url;
    audio.load();
    const onMeta = function () {
      audio.removeEventListener('loadedmetadata', onMeta);
      if (gen !== loadGeneration) return;
      try {
        if (Number.isFinite(resumeAt) && resumeAt > 0 && Number.isFinite(audio.duration)) {
          audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration - 0.5));
        }
      } catch (_) {}
      suppressEnded = false;
      tryPlay(track);
    };
    audio.addEventListener('loadedmetadata', onMeta);
    armLoadTimer(track, gen, true);
  }

  function captureSessionScopeFromUI() {
    var genre = 'All';
    var artist = 'All';
    var artistMode = 'exact';
    var artistRules = [];
    if (window.MPLibrary && typeof MPLibrary.getGenre === 'function') {
      genre = MPLibrary.getGenre() || 'All';
    } else {
      genre = (document.getElementById('dropGenre') || {}).value || 'All';
    }
    if (window.MPLibrary && typeof MPLibrary.getArtistRules === 'function') {
      artistRules = MPLibrary.getArtistRules() || [];
    }
    if (window.MPLibrary && typeof MPLibrary.getArtist === 'function') {
      artist = MPLibrary.getArtist() || 'All';
    } else {
      artist = (document.getElementById('dropArtist') || {}).value || 'All';
    }
    if (window.MPLibrary && typeof MPLibrary.getArtistMatchMode === 'function') {
      artistMode = MPLibrary.getArtistMatchMode() || 'exact';
    }
    if (!artistRules.length) {
      artist = 'All';
      artistMode = 'exact';
    } else if (artistRules.length === 1) {
      artist = artistRules[0].value;
      artistMode = artistRules[0].mode === 'involves' ? 'involves' : 'exact';
    } else {
      artistMode = 'multi';
      if (window.MPLibrary && typeof MPLibrary.formatArtistRulesLabel === 'function') {
        artist = MPLibrary.formatArtistRulesLabel(artistRules);
      }
    }
    sessionScope = {
      genre: genre,
      artist: artist,
      artistMode: artistMode,
      artistRules: artistRules,
    };
  }

  function formatSessionScopeLabel(genre, artist, artistMode, artistRules) {
    genre = genre || 'All';
    artist = artist || 'All';
    artistMode = artistMode || 'exact';
    artistRules = artistRules || [];

    var artistLabel = '';
    if (artistRules.length) {
      if (window.MPLibrary && typeof MPLibrary.formatArtistRulesLabel === 'function') {
        artistLabel = MPLibrary.formatArtistRulesLabel(artistRules);
      } else {
        artistLabel = artistRules
          .map(function (r) {
            return r.mode === 'involves' ? r.value + '+' : r.value;
          })
          .join(' · ');
      }
    } else if (artist !== 'All') {
      artistLabel = artistMode === 'involves' ? artist + '+' : artist;
    }

    if (genre === 'All' && !artistLabel) return 'All Songs';
    if (genre === 'All') {
      // Multi: "A+ · B · C" already lists everyone; single: "A's Songs"
      if (artistRules.length > 1) return artistLabel;
      return artistLabel + "'s Songs";
    }
    if (!artistLabel) return genre + ' Songs';
    if (artistRules.length > 1) return artistLabel + ' · ' + genre;
    return artistLabel + "'s " + genre + ' Songs';
  }

  function setQueue(tracks, startId, preferredMode) {
    queue = (tracks || []).slice();
    if (preferredMode) mode = preferredMode;
    // New queue = new active session; scope follows filters *at apply time*
    captureSessionScopeFromUI();
    resetPlayCounts();
    clearShuffleState();
    upcomingTrack = null;
    clearPreloader();
    if (mode === 'Random' && queue.length) {
      // Build a full shuffle; optional start track is first so prev/next stay coherent
      rebuildShuffleOrder(startId != null ? startId : null, null);
      shufflePos = 0;
      queueIndex = shuffleOrder[0];
    } else if (startId != null) {
      const idx = queue.findIndex((t) => t.id === startId);
      queueIndex = idx >= 0 ? idx : 0;
    } else {
      queueIndex = queue.length ? 0 : -1;
    }
    updateModeUI();
    // Sleep timer is bound to the previous session queue — cancel on replace
    if (window.MPSleepTimer && typeof MPSleepTimer.onQueueChange === 'function') {
      MPSleepTimer.onQueueChange();
    }
    if (queueIndex >= 0) loadTrack(queue[queueIndex], true);
  }

  function setMode(newMode) {
    mode = newMode === 'Loop' ? 'Loop' : 'Random';
    resetPlayCounts();
    upcomingTrack = null;
    clearPreloader();
    if (mode === 'Random') {
      // Keep the song that is playing as the current shuffle position (first)
      const curId = currentTrack && currentTrack.id;
      rebuildShuffleOrder(curId != null ? curId : null, null);
      shufflePos = 0;
      if (shuffleOrder.length) queueIndex = shuffleOrder[0];
    } else {
      clearShuffleState();
      // Loop uses natural catalog order; snap queueIndex to current track
      if (currentTrack) {
        const idx = queue.findIndex(function (t) {
          return t.id === currentTrack.id;
        });
        if (idx >= 0) queueIndex = idx;
      }
    }
    updateModeUI();
    emit('mode', mode);
    persist();
    ensureUpcomingAndPreload();
  }

  function toggleMode() {
    setMode(mode === 'Random' ? 'Loop' : 'Random');
    MPUtils.toast(mode + ' mode');
  }

  /**
   * Mode control + session pill.
   * Pill always reflects the *playing* session (last applied queue scope + mode),
   * never the pending Library filter dropdowns.
   */
  /**
   * Mode icons — monochrome SVG (currentColor = gold).
   * Random: two thick S-ribbons crossing (Dreamstime shuffle style); both heads → right.
   * Loop: dual U-turns (Magnific media-loop style) — not a single ↻ like Replay.
   */
  const MODE_ICON_RANDOM =
    '<svg class="ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    // TL → BR: start/end same vertical span (y≈8.2↔16) so left isn’t taller than right
    '<path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="butt" stroke-linejoin="round" d="M2 8.2h2.6c2.5 0 4 1.6 5.6 3.9 1.5 2.3 3 3.9 5.4 3.9H18.6"/>' +
    '<path fill="currentColor" stroke="none" d="M16.8 13 22 16l-5.2 3z"/>' +
    // BL → TR: mirror — ends at y≈8.2
    '<path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="butt" stroke-linejoin="round" d="M2 15.8h2.6c2.5 0 4-1.6 5.6-3.9 1.5-2.3 3-3.9 5.4-3.9H18.6"/>' +
    '<path fill="currentColor" stroke="none" d="M16.8 11 22 8l-5.2-3z"/>' +
    '</svg>';
  const MODE_ICON_LOOP =
    '<svg class="ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    // Top: open U on left + clean triangle → right
    '<path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M6 12.2C6 7.8 9 5.4 13.6 5.4H16.5"/>' +
    '<path fill="currentColor" stroke="none" d="M15.6 2.8 21.2 5.4l-5.6 2.6z"/>' +
    // Bottom: open U on right + clean triangle → left
    '<path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M18 11.8c0 4.4-3 6.8-7.6 6.8H7.5"/>' +
    '<path fill="currentColor" stroke="none" d="M8.4 21.2 2.8 18.6l5.6-2.6z"/>' +
    '</svg>';

  function updateModeUI() {
    const btn = document.getElementById('mode-button');
    if (btn) {
      const isLoop = mode === 'Loop';
      btn.innerHTML = isLoop ? MODE_ICON_LOOP : MODE_ICON_RANDOM;
      btn.setAttribute('aria-label', 'Play mode: ' + mode);
      btn.title = isLoop
        ? 'Loop mode — click for Random'
        : 'Random mode — click for Loop';
    }
    const label = document.getElementById('current-play-mode');
    if (label) {
      const rules = sessionScope.artistRules || [];
      const scope = formatSessionScopeLabel(
        sessionScope.genre,
        sessionScope.artist,
        sessionScope.artistMode,
        rules
      );
      label.textContent = scope + ' · ' + mode;
      label.title = scope + ' · ' + mode;
      label.classList.toggle('is-long-scope', rules.length > 2 || String(scope).length > 42);
    }
  }

  function resetPlayCounts() {
    playCounts = new Map();
    for (const t of queue) playCounts.set(t.id, 0);
  }

  function clearShuffleState() {
    shuffleOrder = [];
    shufflePos = -1;
    nextShuffleOrder = null;
  }

  /**
   * Fisher–Yates permutation of queue indices.
   * @param {number|string|null} preferFirstId - place this track first (new session / pick)
   * @param {number|string|null} avoidFirstId - after a full pass, avoid starting with last song
   * @returns {number[]}
   */
  function makeShuffleOrder(preferFirstId, avoidFirstId) {
    const n = queue.length;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    if (preferFirstId != null && n > 0) {
      const qi = queue.findIndex(function (t) {
        return t.id === preferFirstId;
      });
      if (qi >= 0) {
        const pos = order.indexOf(qi);
        if (pos > 0) {
          order.splice(pos, 1);
          order.unshift(qi);
        } else if (pos < 0) {
          order.unshift(qi);
        }
      }
    } else if (avoidFirstId != null && n > 1) {
      const qi = queue.findIndex(function (t) {
        return t.id === avoidFirstId;
      });
      if (qi >= 0 && order[0] === qi) {
        const j = 1 + Math.floor(Math.random() * (n - 1));
        const tmp = order[0];
        order[0] = order[j];
        order[j] = tmp;
      }
    }
    return order;
  }

  function rebuildShuffleOrder(preferFirstId, avoidFirstId) {
    shuffleOrder = makeShuffleOrder(preferFirstId, avoidFirstId);
    nextShuffleOrder = null;
  }

  /** Ensure Random has a valid order aligned with the current queue. */
  function ensureShuffleReady() {
    if (mode !== 'Random' || !queue.length) return false;
    if (
      !shuffleOrder.length ||
      shuffleOrder.length !== queue.length ||
      shuffleOrder.some(function (qi) {
        return qi < 0 || qi >= queue.length;
      })
    ) {
      const curId = currentTrack && currentTrack.id;
      rebuildShuffleOrder(curId != null ? curId : null, null);
      shufflePos = 0;
      if (curId != null) {
        const qi = queue.findIndex(function (t) {
          return t.id === curId;
        });
        const sp = shuffleOrder.indexOf(qi);
        if (sp >= 0) shufflePos = sp;
      }
    }
    if (shufflePos < 0 || shufflePos >= shuffleOrder.length) {
      // Snap pos to current track if possible
      if (currentTrack) {
        const qi = queue.findIndex(function (t) {
          return t.id === currentTrack.id;
        });
        const sp = shuffleOrder.indexOf(qi);
        shufflePos = sp >= 0 ? sp : 0;
      } else {
        shufflePos = 0;
      }
    }
    return shuffleOrder.length > 0;
  }

  function trackAtShufflePos(pos) {
    if (pos < 0 || pos >= shuffleOrder.length) return null;
    const qi = shuffleOrder[pos];
    return queue[qi] || null;
  }

  function revokeObjectUrl() {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (_) {}
      objectUrl = null;
    }
    if (blobAbort) {
      try {
        blobAbort.abort();
      } catch (_) {}
      blobAbort = null;
    }
  }

  function clearPreloader() {
    if (!preloader) return;
    try {
      preloader.removeAttribute('src');
      preloader.removeAttribute('data-track-id');
      preloader.load();
    } catch (_) {}
  }

  /**
   * Choose the track that will play after the current one (without advancing).
   */
  function computeUpcoming() {
    if (!queue.length || !currentTrack) return null;

    if (mode === 'Loop') {
      if (queueIndex < 0) return queue[0];
      return queue[(queueIndex + 1) % queue.length];
    }

    // Random: next slot in the fixed shuffle order (prepare a new order at the end)
    if (!ensureShuffleReady()) return null;
    if (shufflePos + 1 < shuffleOrder.length) {
      return trackAtShufflePos(shufflePos + 1);
    }
    // Last song in this pass — precompute the next cycle for preload
    if (!nextShuffleOrder || nextShuffleOrder.length !== queue.length) {
      nextShuffleOrder = makeShuffleOrder(null, currentTrack.id);
    }
    if (!nextShuffleOrder.length) return null;
    return queue[nextShuffleOrder[0]] || null;
  }

  function ensureUpcomingAndPreload() {
    if (!queue.length || !currentTrack) return;
    if (!upcomingTrack || !queue.some(function (t) {
      return t.id === upcomingTrack.id;
    })) {
      upcomingTrack = computeUpcoming();
    }
    // Avoid preloading the song already playing
    if (upcomingTrack && currentTrack && upcomingTrack.id === currentTrack.id) {
      upcomingTrack = computeUpcoming();
    }
    if (upcomingTrack) preloadTrack(upcomingTrack);
  }

  function preloadTrack(track) {
    if (!preloader || !track) return;
    const url = primaryUrl(track);
    if (!url) return;

    // Already warming this track
    if (preloader.getAttribute('data-track-id') === String(track.id)) {
      if (preloader.readyState >= PRELOAD_MIN_READY) return;
      // keep loading
      return;
    }

    try {
      preloader.setAttribute('data-track-id', String(track.id));
      preloader.crossOrigin = 'anonymous';
      // metadata only — avoid buffering a full second MP3 into memory
      preloader.preload = 'metadata';
      preloader.src = url;
      preloader.load();
    } catch (e) {
      console.warn('Preload failed', e);
    }
    // Intentionally no <link rel=preload> of full audio files (memory / bandwidth).
  }

  function isPreloaded(track) {
    if (!preloader || !track) return false;
    return (
      preloader.getAttribute('data-track-id') === String(track.id) &&
      preloader.readyState >= PRELOAD_MIN_READY &&
      preloader.error == null
    );
  }

  function loadTrack(track, autoplay) {
    if (!track || !audio) return;
    const gen = ++loadGeneration;
    currentTrack = track;
    urlAttempt = 0;
    blobMode = false;
    revokeObjectUrl();
    suppressEnded = true;
    clearLoadTimer();
    clearStallTimer();
    clearPlayRetries();

    if (autoplay) {
      playbackIntent = true;
      pendingPlayRetry = true;
      advancing = true;
      keepMediaSessionPlaying();
    } else {
      advancing = false;
    }

    // Invalidate upcoming if we're jumping elsewhere
    if (upcomingTrack && upcomingTrack.id === track.id) {
      upcomingTrack = null;
    }

    // IMPORTANT (Android Chrome / installed PWA):
    // Do NOT pause() before src change when auto-advancing. pause()+src+play()
    // in the background often loses continuous playback and requires a fresh
    // user gesture. Just assign the next URL and call play().
    if (!autoplay) {
      try {
        audio.pause();
      } catch (_) {}
    }

    // Fast path: promote warm preloader URL (HTTP cache already filled)
    const urls = MPUtils.getAudioUrlCandidates(track);
    let startUrl = urls[0];
    if (isPreloaded(track) && preloader.currentSrc) {
      startUrl = preloader.currentSrc || preloader.src || startUrl;
      // Use same host as preloaded for cache hit
      const preUrl = preloader.getAttribute('src') || preloader.src;
      if (preUrl) startUrl = preUrl;
    }

    setStatus(autoplay ? 'loading' : 'paused');
    applyUrl(track, autoplay, gen, startUrl);

    markPlayed(track.id);
    // After marking current, plan & warm the following track
    upcomingTrack = null;
    ensureUpcomingAndPreload();

    emit('trackchange', track);
    updateNowPlayingUI(track);
    persist();

    if (autoplay) {
      // Fire retries even if the first play() is deferred while backgrounded
      schedulePlayRetries();
    }
  }

  /**
   * Retry play when media becomes ready after next/prev/source failover.
   * Avoids "Tap to play" when the original click gesture has expired.
   */
  function maybeResumePlayback() {
    if (!audio || !currentTrack) return;
    if (!playbackIntent && !pendingPlayRetry) return;
    if (!audio.paused && !audio.ended) return;
    if (audio.readyState < PRELOAD_MIN_READY) return;
    tryPlay(currentTrack, true);
  }

  function applyUrl(track, autoplay, generation, forcedUrl) {
    if (generation != null && generation !== loadGeneration) return;

    const urls = MPUtils.getAudioUrlCandidates(track);
    if (!urls.length) {
      setStatus('error');
      MPUtils.toast('No audio URL for this track');
      return;
    }

    if (urlAttempt >= urls.length) {
      if (!blobMode) {
        blobMode = true;
        loadViaBlob(track, autoplay, generation);
        return;
      }
      setStatus('error');
      MPUtils.toast('Failed to load: ' + track.name);
      emit('loaderror', track);
      setTimeout(function () {
        next(true);
      }, 600);
      return;
    }

    setStatus('loading');
    const url = forcedUrl && urlAttempt === 0 ? forcedUrl : urls[urlAttempt];
    audio.crossOrigin = 'anonymous';
    // Prefer network stream (range requests); avoid long-lived full-file copies
    const prev = audio.getAttribute('src') || '';
    if (prev !== url) {
      // Drop previous blob: URL if any (frees memory)
      revokeObjectUrl();
      audio.src = url;
      audio.load();
    }
    suppressEnded = false;
    armLoadTimer(track, generation != null ? generation : loadGeneration, autoplay);
    if (autoplay) tryPlay(track);
  }

  /**
   * @param {object} track
   * @param {boolean} [isRetry] silent retry from canplay
   */
  function tryPlay(track, isRetry) {
    if (!audio || !track) return;
    if (window.MPAudioEnhance && MPAudioEnhance.resume) MPAudioEnhance.resume();

    // Keep OS media session alive during background transitions
    if (playbackIntent) keepMediaSessionPlaying();

    var p;
    try {
      p = audio.play();
    } catch (syncErr) {
      pendingPlayRetry = true;
      if (playbackIntent) {
        setStatus('loading');
        schedulePlayRetries();
      }
      return;
    }

    if (p && typeof p.then === 'function') {
      p.then(function () {
        audioUnlocked = true;
        playbackIntent = true;
        pendingPlayRetry = false;
        advancing = false;
        clearPlayRetries();
        if (window.MPAudioEnhance) {
          if (MPAudioEnhance.ensureGraph) MPAudioEnhance.ensureGraph();
          if (MPAudioEnhance.resume) MPAudioEnhance.resume();
        }
        setStatus('playing');
        keepMediaSessionPlaying();
        ensureUpcomingAndPreload();
      }).catch(function (err) {
        const name = (err && err.name) || '';
        // New load aborted this play() — another loadTrack is in flight
        if (name === 'AbortError') return;

        // Not ready yet / autoplay policy / background freeze:
        // keep intent and retry (canplay + scheduled retries + visibility).
        pendingPlayRetry = true;
        if (name === 'NotAllowedError' && !audioUnlocked && !playbackIntent) {
          setStatus('paused');
          console.info('Autoplay blocked until a control is used');
          return;
        }
        // After a successful play earlier in the session, keep trying —
        // Android often rejects the first play() after a background src change.
        setStatus(audioUnlocked || playbackIntent ? 'loading' : 'paused');
        if (playbackIntent) {
          keepMediaSessionPlaying();
          if (!isRetry) schedulePlayRetries();
        }
        if (!isRetry) {
          console.warn('play() deferred, will retry when ready:', name || err);
        }
      });
    }
  }

  function loadViaBlob(track, autoplay, generation) {
    // Last resort only — full download is slower; prefer streaming
    const urls = MPUtils.getAudioUrlCandidates(track);
    const url = urls[0];
    if (!url) {
      setStatus('error');
      return;
    }
    setStatus('loading');
    revokeObjectUrl();
    blobAbort = new AbortController();
    blobMode = true;

    MPUtils.fetchAsMpegObjectUrl(url, blobAbort.signal)
      .then(function (blobUrl) {
        if (generation != null && generation !== loadGeneration) return;
        objectUrl = blobUrl;
        suppressEnded = false;
        audio.crossOrigin = 'anonymous';
        audio.src = objectUrl;
        audio.load();
        if (autoplay) tryPlay(track);
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('Blob load failed', e);
        setStatus('error');
        MPUtils.toast('Could not play: ' + track.name);
        emit('loaderror', track);
        setTimeout(function () {
          next(true);
        }, 800);
      });
  }

  function onAudioError() {
    if (!currentTrack) return;
    if (blobMode) {
      setStatus('error');
      MPUtils.toast('Could not play: ' + currentTrack.name);
      emit('loaderror', currentTrack);
      setTimeout(function () {
        next(true);
      }, 800);
      return;
    }
    const urls = MPUtils.getAudioUrlCandidates(currentTrack);
    console.warn('Audio error on attempt', urlAttempt, urls[urlAttempt], audio && audio.error);
    urlAttempt += 1;
    const gen = loadGeneration;
    if (urlAttempt < urls.length) {
      applyUrl(currentTrack, true, gen);
    } else {
      applyUrl(currentTrack, true, gen); // blob branch
    }
  }

  function markPlayed(id) {
    playCounts.set(id, (playCounts.get(id) || 0) + 1);
  }

  function playById(id, newQueue) {
    playbackIntent = true;
    pendingPlayRetry = true;
    var queueReplaced = false;
    if (newQueue && newQueue.length) {
      queue = newQueue.slice();
      resetPlayCounts();
      clearShuffleState();
      queueReplaced = true;
    }
    if (!queue.length && window.MUSICS) {
      queue = window.MUSICS.slice();
      resetPlayCounts();
      clearShuffleState();
      queueReplaced = true;
    }
    upcomingTrack = null;
    clearPreloader();
    const idx = queue.findIndex((t) => t.id === id);
    if (idx >= 0) {
      queueIndex = idx;
      if (mode === 'Random') {
        // New shuffle of this selection with the chosen song first
        rebuildShuffleOrder(id, null);
        shufflePos = 0;
        queueIndex = shuffleOrder[0];
      }
      if (queueReplaced && window.MPSleepTimer && MPSleepTimer.onQueueChange) {
        MPSleepTimer.onQueueChange();
      }
      loadTrack(queue[queueIndex], true);
    } else {
      const track =
        (window.MPLibrary && MPLibrary.byId.get(id)) ||
        (window.MUSICS || []).find((m) => m.id === id);
      if (track) {
        queue = [track];
        queueIndex = 0;
        resetPlayCounts();
        if (mode === 'Random') {
          rebuildShuffleOrder(track.id, null);
          shufflePos = 0;
        } else {
          clearShuffleState();
        }
        if (window.MPSleepTimer && MPSleepTimer.onQueueChange) {
          MPSleepTimer.onQueueChange();
        }
        loadTrack(track, true);
      }
    }
  }

  function play() {
    if (!audio) return;
    playbackIntent = true;
    pendingPlayRetry = true;
    advancing = false;
    audio.muted = false;
    if (window.MPAudioEnhance) {
      if (MPAudioEnhance.ensureGraph) MPAudioEnhance.ensureGraph();
      if (MPAudioEnhance.resume) MPAudioEnhance.resume();
    }
    keepMediaSessionPlaying();
    tryPlay(currentTrack || { name: '' }, false);
    schedulePlayRetries();
  }

  function pause() {
    playbackIntent = false;
    pendingPlayRetry = false;
    advancing = false;
    clearPlayRetries();
    if (audio) audio.pause();
  }

  function togglePlay() {
    if (!audio) return;
    if (audio.paused) play();
    else pause();
  }

  function replay() {
    if (!audio) return;
    try {
      audio.currentTime = 0;
    } catch (_) {}
    play();
  }

  function advanceTo(track) {
    if (!track) return;
    const idx = queue.findIndex(function (t) {
      return t.id === track.id;
    });
    if (idx >= 0) queueIndex = idx;
    loadTrack(track, true);
  }

  function next(fromEnded) {
    if (!queue.length) return;

    // Manual next: sleep timer may stop instead of advancing
    // (ended path already consulted shouldBlockNext before calling next(true))
    if (
      !fromEnded &&
      window.MPSleepTimer &&
      typeof MPSleepTimer.shouldBlockNext === 'function' &&
      MPSleepTimer.shouldBlockNext(false)
    ) {
      return;
    }

    // User clicked next / natural end — keep continuous playback intent
    playbackIntent = true;
    pendingPlayRetry = true;
    advancing = true;
    keepMediaSessionPlaying();

    // Prefer pre-planned (and ideally preloaded) next track
    let pick = upcomingTrack;
    upcomingTrack = null;

    if (mode === 'Loop') {
      if (!pick) {
        queueIndex = queueIndex < 0 ? 0 : (queueIndex + 1) % queue.length;
        pick = queue[queueIndex];
      } else {
        const idx = queue.findIndex(function (t) {
          return t.id === pick.id;
        });
        queueIndex = idx >= 0 ? idx : (queueIndex + 1) % queue.length;
        pick = queue[queueIndex];
      }
      advanceTo(pick);
      return;
    }

    // Random: walk the shuffle list; reshuffle after the last song
    if (!ensureShuffleReady()) return;

    if (shufflePos + 1 < shuffleOrder.length) {
      shufflePos += 1;
    } else {
      // Full pass done — new random order of the same selection
      const avoidId = currentTrack && currentTrack.id;
      if (nextShuffleOrder && nextShuffleOrder.length === queue.length) {
        shuffleOrder = nextShuffleOrder;
        nextShuffleOrder = null;
      } else {
        rebuildShuffleOrder(null, avoidId);
      }
      shufflePos = 0;
      if (queue.length > 1) MPUtils.toast('All played — reshuffling');
    }

    pick = trackAtShufflePos(shufflePos);
    if (!pick) return;
    queueIndex = shuffleOrder[shufflePos];
    advanceTo(pick);
  }

  function previous() {
    if (!queue.length) return;
    playbackIntent = true;
    pendingPlayRetry = true;
    upcomingTrack = null;
    clearPreloader();

    if (mode === 'Loop') {
      queueIndex = (queueIndex - 1 + queue.length) % queue.length;
      loadTrack(queue[queueIndex], true);
      return;
    }

    // Random: step backward on the same shuffle list (wrap to end)
    if (!ensureShuffleReady()) return;
    if (shuffleOrder.length <= 1) {
      loadTrack(queue[shuffleOrder[0] != null ? shuffleOrder[0] : 0], true);
      return;
    }
    shufflePos = (shufflePos - 1 + shuffleOrder.length) % shuffleOrder.length;
    // Stepping back invalidates a prepared next-cycle order
    nextShuffleOrder = null;
    queueIndex = shuffleOrder[shufflePos];
    loadTrack(queue[queueIndex], true);
  }

  function seek(ratioOrTime, isRatio) {
    if (!audio || !Number.isFinite(audio.duration)) return;
    if (isRatio) {
      audio.currentTime = Math.max(0, Math.min(1, ratioOrTime)) * audio.duration;
    } else {
      audio.currentTime = Math.max(0, Math.min(audio.duration, ratioOrTime));
    }
    emit('timeupdate', getProgress());
  }

  function setVolume(v) {
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1, v));
    audio.muted = false;
    MPUtils.storageSet('mp-volume', audio.volume);
    const slider = document.getElementById('volume-slider');
    if (slider && Number(slider.value) !== audio.volume) slider.value = audio.volume;
  }

  function getProgress() {
    return {
      current: audio ? audio.currentTime : 0,
      duration: audio && Number.isFinite(audio.duration) ? audio.duration : 0,
      paused: audio ? audio.paused : true,
      track: currentTrack,
    };
  }

  function updateNowPlayingUI(track) {
    const nameEl = document.getElementById('musicplaying');
    const artistEl = document.getElementById('artistplaying');
    const genreEl = document.getElementById('genreplaying');
    if (nameEl) {
      nameEl.textContent = track.name;
      nameEl.dataset.id = String(track.id);
    }
    if (artistEl) artistEl.textContent = track.artist;
    if (genreEl) genreEl.textContent = track.genre || '';

    document.querySelectorAll('.track-table tr[data-id]').forEach((tr) => {
      tr.classList.toggle('playing', tr.dataset.id === String(track.id));
    });
  }

  function getCurrentTrack() {
    return currentTrack;
  }

  function getAudio() {
    return audio;
  }

  function getMode() {
    return mode;
  }

  function getQueue() {
    return queue.slice();
  }

  function isPlaying() {
    return audio && !audio.paused && !audio.ended;
  }

  function persist() {
    if (!currentTrack) return;
    // Normalize rules so involves mode always round-trips (never rely on artist string alone)
    var rules = (sessionScope.artistRules || [])
      .map(function (r) {
        if (!r || !r.value) return null;
        var value = String(r.value).trim();
        if (value.charAt(value.length - 1) === '+') value = value.slice(0, -1).trim();
        if (!value || value === 'All') return null;
        return {
          value: value,
          mode: r.mode === 'involves' ? 'involves' : 'exact',
        };
      })
      .filter(Boolean);
    var artist = sessionScope.artist || 'All';
    var artistMode = sessionScope.artistMode || 'exact';
    if (rules.length === 1) {
      artist = rules[0].value;
      artistMode = rules[0].mode;
    } else if (!rules.length) {
      artist = 'All';
      artistMode = 'exact';
    } else {
      artistMode = 'multi';
    }
    MPUtils.storageSet(STORAGE_KEY, {
      id: currentTrack.id,
      mode,
      position: audio ? audio.currentTime : 0,
      // Persist *session* scope (what is playing), not pending dropdown filters
      genre: sessionScope.genre || 'All',
      artist: artist,
      artistMode: artistMode,
      artistRules: rules,
    });
  }

  function restore(allMusics) {
    const state = MPUtils.storageGet(STORAGE_KEY, null);
    const vol = MPUtils.storageGet('mp-volume', 0.9);
    if (audio && typeof vol === 'number') setVolume(vol);

    if (!state || !state.id) return null;
    if (state.mode) mode = state.mode === 'Loop' ? 'Loop' : 'Random';
    if (state.genre || state.artist || (state.artistRules && state.artistRules.length)) {
      var rules = Array.isArray(state.artistRules)
        ? state.artistRules
            .map(function (r) {
              if (!r || !r.value) return null;
              var value = String(r.value).trim();
              if (value.charAt(value.length - 1) === '+') value = value.slice(0, -1).trim();
              if (!value || value === 'All') return null;
              return {
                value: value,
                mode: r.mode === 'involves' ? 'involves' : 'exact',
              };
            })
            .filter(Boolean)
        : [];
      // Legacy: single artist + involves mode without rules array
      if (
        !rules.length &&
        state.artist &&
        state.artist !== 'All' &&
        state.artistMode === 'involves'
      ) {
        var solo = String(state.artist).trim();
        if (solo.charAt(solo.length - 1) === '+') solo = solo.slice(0, -1).trim();
        if (solo) rules = [{ value: solo, mode: 'involves' }];
      }
      sessionScope = {
        genre: state.genre || 'All',
        artist: state.artist || 'All',
        artistMode: state.artistMode || 'exact',
        artistRules: rules,
      };
      if (rules.length === 1) {
        sessionScope.artist = rules[0].value;
        sessionScope.artistMode = rules[0].mode;
      } else if (!rules.length) {
        sessionScope.artist = 'All';
        sessionScope.artistMode = 'exact';
      }
    }
    updateModeUI();
    return state;
  }

  window.MPPlayer = {
    init,
    on,
    setQueue,
    setMode,
    toggleMode,
    playById,
    play,
    pause,
    togglePlay,
    replay,
    next,
    previous,
    seek,
    setVolume,
    getProgress,
    getCurrentTrack,
    getAudio,
    getMode,
    getQueue,
    isPlaying,
    updateModeUI,
    restore,
    persist,
  };
})();
