/**
 * Sleep timer — session-only auto-stop (not persisted).
 * Modes: time | songs | end of queue
 * Fades volume before stop; restores user volume after pause.
 */
(function () {
  var TIME_FADE_MS = 45000;
  var LAST_SONG_FADE_MS = 20000;
  var TICK_MS = 500;

  /** @type {null | 'time' | 'songs' | 'queue'} */
  var activeMode = null;
  /** Draft mode in the panel (not necessarily running) */
  var draftMode = 'time';
  var draftMinutes = 45;
  /** Default matches 45m time preset at ~3 min/song */
  var draftSongs = 15;

  var deadlineMs = 0;
  var songsLeft = 0;
  var fading = false;
  var volumeBeforeFade = 0.9;
  var fadeStartedAt = 0;
  var fadeDurationMs = TIME_FADE_MS;
  var tickTimer = null;
  var panelOpen = false;
  var finishing = false;

  function $(id) {
    return document.getElementById(id);
  }

  function isActive() {
    return activeMode != null;
  }

  function getUserVolume() {
    var a = window.MPPlayer && MPPlayer.getAudio && MPPlayer.getAudio();
    if (a && typeof a.volume === 'number') return a.volume;
    var stored = MPUtils.storageGet('mp-volume', 0.9);
    return typeof stored === 'number' ? stored : 0.9;
  }

  /** Set playback volume without writing localStorage (used during fade). */
  function applyTransientVolume(v) {
    v = Math.max(0, Math.min(1, v));
    var a = window.MPPlayer && MPPlayer.getAudio && MPPlayer.getAudio();
    if (a) {
      a.volume = v;
      a.muted = false;
    }
    var slider = $('volume-slider');
    if (slider && Number(slider.value) !== v) slider.value = String(v);
  }

  function restoreUserVolume() {
    fading = false;
    if (window.MPPlayer && typeof MPPlayer.setVolume === 'function') {
      MPPlayer.setVolume(volumeBeforeFade);
    } else {
      applyTransientVolume(volumeBeforeFade);
    }
  }

  function clearTick() {
    if (tickTimer != null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function formatCountdown(ms) {
    if (ms < 0) ms = 0;
    var totalSec = Math.ceil(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + 'h ' + m + 'm';
    }
    if (m > 0) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
  }

  function remainingMs() {
    if (activeMode !== 'time') return 0;
    return Math.max(0, deadlineMs - Date.now());
  }

  function statusText() {
    if (!isActive()) return 'Off — session only';
    // Always show remaining time/songs (including during volume fade)
    if (activeMode === 'time') return formatCountdown(remainingMs()) + ' left';
    if (activeMode === 'songs') {
      return songsLeft === 1 ? '1 song left' : songsLeft + ' songs left';
    }
    if (activeMode === 'queue') {
      return songsLeft === 1 ? '1 song left (end of queue)' : songsLeft + ' songs left (end of queue)';
    }
    return 'On';
  }

  function badgeText() {
    if (!isActive()) return '';
    if (activeMode === 'time') {
      var ms = remainingMs();
      var totalSec = Math.ceil(ms / 1000);
      var m = Math.floor(totalSec / 60);
      if (m >= 60) return Math.floor(m / 60) + 'h';
      if (m > 0) return m + 'm';
      return totalSec + 's';
    }
    return String(songsLeft);
  }

  function updateUI() {
    var btn = $('sleep-timer-toggle');
    var badge = $('sleep-timer-badge');
    var status = $('sleep-timer-status');
    var startBtn = $('sleep-timer-start');
    var cancelBtn = $('sleep-timer-cancel');

    if (status) status.textContent = statusText();

    if (btn) {
      btn.classList.toggle('is-active', isActive());
      btn.setAttribute('aria-label', isActive() ? 'Sleep timer — ' + statusText() : 'Sleep timer');
      btn.title = isActive() ? 'Sleep timer — ' + statusText() : 'Sleep timer';
    }

    if (badge) {
      if (isActive()) {
        badge.hidden = false;
        badge.textContent = badgeText();
      } else {
        badge.hidden = true;
        badge.textContent = '';
      }
    }

    if (startBtn) {
      startBtn.hidden = isActive();
      startBtn.disabled = isActive();
    }
    if (cancelBtn) {
      cancelBtn.hidden = !isActive();
    }
  }

  function showPanel(open) {
    panelOpen = !!open;
    var panel = $('sleep-timer-panel');
    var btn = $('sleep-timer-toggle');
    if (panel) panel.hidden = !panelOpen;
    if (btn) btn.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
  }

  function setDraftMode(mode) {
    if (mode !== 'time' && mode !== 'songs' && mode !== 'queue') return;
    draftMode = mode;
    document.querySelectorAll('.sleep-mode-btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.sleep-timer-body').forEach(function (el) {
      el.hidden = el.getAttribute('data-panel') !== mode;
    });
  }

  function selectTimePreset(minutes) {
    draftMinutes = minutes;
    document.querySelectorAll('#sleep-time-presets .sleep-chip').forEach(function (b) {
      b.classList.toggle('is-selected', Number(b.getAttribute('data-minutes')) === minutes);
    });
    var custom = $('sleep-custom-minutes');
    if (custom) custom.value = '';
  }

  function selectSongPreset(n) {
    draftSongs = n;
    document.querySelectorAll('#sleep-song-presets .sleep-chip').forEach(function (b) {
      b.classList.toggle('is-selected', Number(b.getAttribute('data-songs')) === n);
    });
    var custom = $('sleep-custom-songs');
    if (custom) custom.value = '';
  }

  function resolveMinutes() {
    var custom = $('sleep-custom-minutes');
    if (custom && custom.value !== '' && custom.value != null) {
      var n = parseInt(custom.value, 10);
      if (Number.isFinite(n) && n >= 1) return Math.min(180, n);
    }
    return draftMinutes;
  }

  function resolveSongs() {
    var custom = $('sleep-custom-songs');
    if (custom && custom.value !== '' && custom.value != null) {
      var n = parseInt(custom.value, 10);
      if (Number.isFinite(n) && n >= 1) return Math.min(100, n);
    }
    return draftSongs;
  }

  function startFade(durationMs) {
    if (fading) return;
    fading = true;
    fadeDurationMs = Math.max(5000, durationMs || TIME_FADE_MS);
    fadeStartedAt = Date.now();
    volumeBeforeFade = getUserVolume();
    if (volumeBeforeFade < 0.05) volumeBeforeFade = 0.9;
    updateUI();
  }

  function tickFade() {
    if (!fading) return;
    var elapsed = Date.now() - fadeStartedAt;
    var t = Math.min(1, elapsed / fadeDurationMs);
    // Ease-out cubic for a gentle landing
    var gain = 1 - t * t * (3 - 2 * t);
    applyTransientVolume(volumeBeforeFade * Math.max(0, gain));
    if (t >= 1) {
      completeStop();
    }
  }

  function completeStop() {
    if (finishing) return;
    finishing = true;
    clearTick();
    activeMode = null;
    deadlineMs = 0;
    songsLeft = 0;

    if (window.MPPlayer && typeof MPPlayer.pause === 'function') {
      MPPlayer.pause();
    }

    restoreUserVolume();
    fading = false;
    finishing = false;
    updateUI();
    MPUtils.toast('Sleep timer ended');
  }

  /**
   * Begin fade then stop. If already silent / almost done, stop immediately.
   */
  function beginStopWithFade(durationMs) {
    if (!isActive() && !fading) return;
    if (fading) return;
    var vol = getUserVolume();
    if (vol < 0.02) {
      completeStop();
      return;
    }
    startFade(durationMs != null ? durationMs : 15000);
    // Ensure tick is running for fade
    if (!tickTimer) {
      tickTimer = setInterval(onTick, TICK_MS);
    }
    onTick();
  }

  function onTick() {
    if (!isActive() && !fading) {
      clearTick();
      return;
    }

    if (fading) {
      tickFade();
      updateUI();
      return;
    }

    if (activeMode === 'time') {
      var left = remainingMs();
      if (left <= 0) {
        beginStopWithFade(Math.min(TIME_FADE_MS, 8000));
        return;
      }
      if (left <= TIME_FADE_MS) {
        startFade(left);
      }
    } else if (activeMode === 'songs' || activeMode === 'queue') {
      // Fade near the end of the last allowed song
      if (songsLeft === 1 && window.MPPlayer) {
        var p = MPPlayer.getProgress && MPPlayer.getProgress();
        if (p && p.duration > 0 && Number.isFinite(p.current)) {
          var rem = (p.duration - p.current) * 1000;
          if (rem > 0 && rem <= LAST_SONG_FADE_MS) {
            startFade(rem);
          }
        }
      }
    }

    updateUI();
  }

  function startTimer() {
    if (isActive()) return;

    var mode = draftMode;
    if (mode === 'time') {
      var mins = resolveMinutes();
      draftMinutes = mins;
      activeMode = 'time';
      deadlineMs = Date.now() + mins * 60 * 1000;
      songsLeft = 0;
      MPUtils.toast('Sleep timer: ' + mins + ' min');
    } else if (mode === 'songs') {
      var n = resolveSongs();
      draftSongs = n;
      activeMode = 'songs';
      songsLeft = n;
      deadlineMs = 0;
      MPUtils.toast('Sleep timer: ' + n + (n === 1 ? ' song' : ' songs'));
    } else {
      var q = (window.MPPlayer && MPPlayer.getQueue && MPPlayer.getQueue()) || [];
      var len = q.length || 0;
      if (!len) {
        MPUtils.toast('Queue is empty');
        return;
      }
      activeMode = 'queue';
      songsLeft = len;
      deadlineMs = 0;
      MPUtils.toast('Sleep timer: end of queue (' + len + ')');
    }

    fading = false;
    finishing = false;
    clearTick();
    tickTimer = setInterval(onTick, TICK_MS);
    updateUI();
    showPanel(false);
  }

  function cancelTimer(opts) {
    opts = opts || {};
    var wasActive = isActive() || fading;
    clearTick();
    activeMode = null;
    deadlineMs = 0;
    songsLeft = 0;
    if (fading) {
      restoreUserVolume();
    }
    fading = false;
    finishing = false;
    updateUI();
    if (wasActive && opts.silent !== true) {
      MPUtils.toast(opts.message || 'Sleep timer cancelled');
    }
  }

  /**
   * Called from player before advancing to the next track.
   * @param {boolean} fromEnded
   * @returns {boolean} true if next() should be blocked
   */
  function shouldBlockNext(fromEnded) {
    if (!isActive() || fading || finishing) {
      if (fading || finishing) return true;
      return false;
    }
    if (activeMode === 'time') return false;

    // songs | queue: one completion / skip consumes a slot
    songsLeft -= 1;
    if (songsLeft <= 0) {
      songsLeft = 0;
      updateUI();
      if (fromEnded) {
        // Track already finished naturally — stop without a pointless fade on silence
        completeStop();
      } else {
        // User hit Next on the last slot — gentle fade, then stop (no next track)
        beginStopWithFade(12000);
      }
      return true;
    }
    updateUI();
    return false;
  }

  function onQueueChange() {
    if (!isActive() && !fading) return;
    cancelTimer({ message: 'Sleep timer cancelled (queue changed)' });
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && (isActive() || fading)) {
      onTick();
    }
  }

  function bind() {
    var toggle = $('sleep-timer-toggle');
    var panel = $('sleep-timer-panel');
    var wrap = $('sleep-timer-wrap');
    var startBtn = $('sleep-timer-start');
    var cancelBtn = $('sleep-timer-cancel');

    if (toggle) {
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        showPanel(!panelOpen);
      });
    }

    document.querySelectorAll('.sleep-mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        setDraftMode(b.getAttribute('data-mode'));
      });
    });

    document.querySelectorAll('#sleep-time-presets .sleep-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        selectTimePreset(Number(b.getAttribute('data-minutes')));
      });
    });

    document.querySelectorAll('#sleep-song-presets .sleep-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        selectSongPreset(Number(b.getAttribute('data-songs')));
      });
    });

    var customMin = $('sleep-custom-minutes');
    if (customMin) {
      customMin.addEventListener('input', function () {
        document.querySelectorAll('#sleep-time-presets .sleep-chip').forEach(function (c) {
          c.classList.remove('is-selected');
        });
      });
    }
    var customSongs = $('sleep-custom-songs');
    if (customSongs) {
      customSongs.addEventListener('input', function () {
        document.querySelectorAll('#sleep-song-presets .sleep-chip').forEach(function (c) {
          c.classList.remove('is-selected');
        });
      });
    }

    if (startBtn) {
      startBtn.addEventListener('click', function () {
        startTimer();
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        cancelTimer();
        showPanel(false);
      });
    }

    // Outside click closes panel
    document.addEventListener('mousedown', function (e) {
      if (!panelOpen || !wrap) return;
      if (wrap.contains(e.target)) return;
      showPanel(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelOpen) {
        showPanel(false);
        return;
      }
      var tag = (e.target && e.target.tagName) || '';
      var typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
      if (typing) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        showPanel(!panelOpen);
      }
    });

    // User adjusts volume mid-fade → adopt as new baseline / cancel fade curve
    var vol = $('volume-slider');
    if (vol) {
      vol.addEventListener('input', function () {
        if (!fading) return;
        volumeBeforeFade = Number(vol.value);
        // Abort fade — user took control; keep timer active for time mode until deadline
        fading = false;
        if (window.MPPlayer && typeof MPPlayer.setVolume === 'function') {
          MPPlayer.setVolume(volumeBeforeFade);
        }
        updateUI();
      });
    }

    document.addEventListener('visibilitychange', onVisibility);

    setDraftMode('time');
    selectTimePreset(45);
    selectSongPreset(15);
    updateUI();
  }

  function init() {
    bind();
  }

  window.MPSleepTimer = {
    init: init,
    isActive: isActive,
    shouldBlockNext: shouldBlockNext,
    onQueueChange: onQueueChange,
    cancel: cancelTimer,
    start: startTimer,
  };
})();
