/**
 * Real beat/volume visualizer via Web Audio AnalyserNode.
 *
 * Graph (lazy, on first play — needs user gesture for AudioContext):
 *   <audio> → MediaElementSource → Analyser → Gain(1) → destination
 *
 * Sound still plays through this path (unity gain). If setup fails,
 * falls back to a quiet idle animation so playback is never broken.
 */
(function () {
  let ctx = null;
  let source = null;
  let analyser = null;
  let gainNode = null;
  let graphReady = false;
  let graphFailed = false;
  let connecting = false;
  let raf = null;
  let canvas = null;
  let c2d = null;
  let audioEl = null;
  let freqData = null;
  let timeData = null;
  // Smoothed bar heights for less flicker, still reactive
  let barSmooth = null;
  // Rolling peak for adaptive loudness (keeps loud tracks from pinning every bar)
  let peakEnv = 0.2;
  let rmsEnv = 0;

  function initUI(el) {
    audioEl = el;
    canvas = document.getElementById('visualizer');
    if (canvas) c2d = canvas.getContext('2d');

    if (audioEl) {
      // CORS so analyser can read cross-origin GitHub/CDN streams
      try {
        audioEl.crossOrigin = 'anonymous';
      } catch (_) {}

      audioEl.addEventListener('play', onPlay);
      audioEl.addEventListener('playing', function () {
        resume();
      });
    }
    startVisualizer();
  }

  function attachToAudio(el) {
    audioEl = el;
    if (!audioEl) return;
    try {
      audioEl.crossOrigin = 'anonymous';
    } catch (_) {}
    audioEl.addEventListener('play', onPlay);
    audioEl.addEventListener('playing', function () {
      resume();
    });
  }

  function onPlay() {
    ensureGraph();
    resume();
    startVisualizer();
  }

  async function ensureGraph() {
    if (graphReady || graphFailed || connecting || !audioEl) return graphReady;
    connecting = true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        graphFailed = true;
        return false;
      }

      // Must set before MediaElementSource; keep for subsequent tracks
      if (!audioEl.crossOrigin) {
        audioEl.crossOrigin = 'anonymous';
      }

      ctx = new AC();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // Once created, all audio is routed through this graph
      source = ctx.createMediaElementSource(audioEl);

      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -22;

      gainNode = ctx.createGain();
      gainNode.gain.value = 1;

      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(ctx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);

      graphReady = true;
      await resume();
      return true;
    } catch (e) {
      console.warn('Live visualizer unavailable, using fallback animation:', e);
      graphFailed = true;
      // If source was created but connect failed, try hard to keep sound
      try {
        if (source && ctx) {
          source.disconnect();
          source.connect(ctx.destination);
          graphReady = true;
          analyser = null;
        }
      } catch (_) {}
      return graphReady;
    } finally {
      connecting = false;
    }
  }

  async function resume() {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (_) {}
  }

  function startVisualizer() {
    if (!canvas || !c2d) return;
    if (raf) cancelAnimationFrame(raf);

    function draw() {
      raf = requestAnimationFrame(draw);

      var dpr = window.devicePixelRatio || 1;
      var cssW = canvas.clientWidth || 800;
      var cssH = canvas.clientHeight || 56;
      if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      var w = cssW;
      var h = cssH;
      var theme = document.documentElement.getAttribute('data-theme') || 'dark';
      c2d.clearRect(0, 0, w, h);

      // Even count for clean center mirror
      var barCount = 72;
      var gap = 1.75;
      var barW = Math.max(1.5, w / barCount - gap);
      var gold = theme === 'dark' ? '#e8c547' : '#b8860b';
      var goldHot = theme === 'dark' ? '#fff3bc' : '#d4a017';
      var goldMid = theme === 'dark' ? '#d4af37' : '#c9a227';
      var goldSoft = theme === 'dark' ? 'rgba(232,197,71,0.22)' : 'rgba(184,134,11,0.2)';
      var playing = audioEl && !audioEl.paused && !audioEl.ended;
      var half = barCount >> 1;
      var now = performance.now() / 1000;

      if (!barSmooth || barSmooth.length !== barCount) {
        barSmooth = new Float32Array(barCount);
      }

      var levels = new Float32Array(barCount);
      var hasLive = false;

      if (graphReady && analyser && freqData && playing && ctx && ctx.state === 'running') {
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData);

        // Waveform energy (beats / overall loudness)
        var sum = 0;
        for (var t = 0; t < timeData.length; t++) {
          var tn = (timeData[t] - 128) / 128;
          sum += tn * tn;
        }
        var rms = Math.sqrt(sum / timeData.length);
        rmsEnv = rmsEnv * 0.82 + rms * 0.18;

        // Half-spectrum samples: index 0 = bass (center), last = treble (edges)
        var binCount = freqData.length;
        var usable = Math.floor(binCount * 0.62);
        var halfSpec = new Float32Array(half);
        var framePeak = 0.04;

        for (var i = 0; i < half; i++) {
          var u0 = i / half;
          var u1 = (i + 1) / half;
          var start = Math.floor(Math.pow(u0, 1.55) * usable);
          var end = Math.floor(Math.pow(u1, 1.55) * usable);
          if (end <= start) end = start + 1;
          if (end > usable) end = usable;

          var acc = 0;
          var peakBin = 0;
          for (var b = start; b < end; b++) {
            var fb = freqData[b];
            acc += fb;
            if (fb > peakBin) peakBin = fb;
          }
          var avg = acc / (end - start) / 255;
          var pk = peakBin / 255;
          var sample = avg * 0.55 + pk * 0.45;
          halfSpec[i] = sample;
          if (sample > framePeak) framePeak = sample;
        }

        // Adaptive AGC (same responsive feel as before)
        peakEnv = Math.max(framePeak, peakEnv * 0.965 + framePeak * 0.035);
        var norm = 1 / Math.max(0.14, peakEnv * 0.92);

        var bassBand = 0;
        var midBand = 0;
        var highBand = 0;
        var bN = Math.max(1, Math.floor(usable * 0.12));
        var m0 = Math.floor(usable * 0.12);
        var m1 = Math.floor(usable * 0.4);
        var h0 = Math.floor(usable * 0.4);
        for (var bb = 0; bb < bN; bb++) bassBand += freqData[bb];
        for (var mb = m0; mb < m1; mb++) midBand += freqData[mb];
        for (var hb = h0; hb < usable; hb++) highBand += freqData[hb];
        bassBand = bassBand / bN / 255;
        midBand = midBand / Math.max(1, m1 - m0) / 255;
        highBand = highBand / Math.max(1, usable - h0) / 255;

        var beat = Math.min(1.25, Math.pow(bassBand, 0.7) * (0.5 + rmsEnv * 2.4));
        var air = Math.pow(highBand, 0.75);
        var body = Math.pow(midBand, 0.7);

        // Slight overall scale only — keep motion/feel, trim height a bit
        var HEIGHT = 0.86;

        for (var s = 0; s < half; s++) {
          var edge = s / (half - 1 || 1);
          var centerGate = Math.pow(1 - edge, 1.15);
          var edgeGate = Math.pow(edge, 1.05);

          var raw = halfSpec[s] * norm;
          var compressed = raw / (1 + raw * 0.85);
          compressed = Math.pow(Math.min(1.2, compressed), 0.9);

          var v =
            compressed * (0.55 + centerGate * 0.7) +
            beat * centerGate * 0.42 +
            body * (0.2 + centerGate * 0.25) +
            air * edgeGate * 0.55;

          var flutter =
            1 +
            0.1 * Math.sin(now * 6.5 + s * 0.9) * air +
            0.08 * Math.sin(now * 3.1 + s * 1.7) * body;
          v *= flutter * HEIGHT;

          var leftJitter = 1 + 0.06 * Math.sin(now * 4.2 + s * 1.3 + beat * 2);
          var rightJitter = 1 + 0.06 * Math.cos(now * 4.7 + s * 1.1 + air * 3);

          var leftVal = Math.min(1, v * leftJitter);
          var rightVal = Math.min(1, v * rightJitter);

          var leftIndex = half - 1 - s;
          var rightIndex = half + s;
          levels[leftIndex] = leftVal;
          levels[rightIndex] = rightVal;
          if (leftVal > 0.03 || rightVal > 0.03) hasLive = true;
        }

        if (beat > 0.35) {
          var bloom = (beat - 0.35) * 0.35 * HEIGHT;
          for (var c = 0; c < 5; c++) {
            var li = half - 1 - c;
            var ri = half + c;
            if (li >= 0) levels[li] = Math.min(1, levels[li] + bloom * (1 - c / 5));
            if (ri < barCount) levels[ri] = Math.min(1, levels[ri] + bloom * (1 - c / 5));
          }
        }
      }

      // Fallback idle (centered breathing, not left-fill)
      if (!hasLive) {
        for (var j = 0; j < barCount; j++) {
          var dist = Math.abs(j - (barCount - 1) / 2) / half;
          var envelope = Math.pow(1 - Math.min(1, dist), 1.4);
          if (playing && !graphReady) {
            levels[j] =
              envelope *
              (0.14 +
                0.12 * Math.abs(Math.sin(now * 2.4 + j * 0.25)) +
                0.08 * Math.abs(Math.sin(now * 4.1 + j * 0.5)));
          } else {
            levels[j] = envelope * (0.05 + 0.03 * Math.abs(Math.sin(now * 0.9 + j * 0.15)));
          }
        }
      }

      // Smooth attack/release — snappier in the center
      for (var k = 0; k < barCount; k++) {
        var target = levels[k];
        var prev = barSmooth[k];
        var distK = Math.abs(k - (barCount - 1) / 2) / half;
        var attack = 0.52 - distK * 0.12;
        var release = 0.16 + distK * 0.06;
        var coeff = target > prev ? attack : release;
        barSmooth[k] = prev + (target - prev) * coeff;
      }

      for (var i2 = 0; i2 < barCount; i2++) {
        var v2 = barSmooth[i2];
        var barH = Math.max(2.5, v2 * h * 0.96);
        var x = i2 * (barW + gap);
        var dist2 = Math.abs(i2 - (barCount - 1) / 2) / half;
        var grd = c2d.createLinearGradient(0, h - barH, 0, h);
        if (v2 > 0.62) {
          grd.addColorStop(0, goldHot);
          grd.addColorStop(0.35, gold);
          grd.addColorStop(1, goldSoft);
        } else if (v2 > 0.3) {
          grd.addColorStop(0, goldMid);
          grd.addColorStop(1, goldSoft);
        } else {
          grd.addColorStop(0, gold);
          grd.addColorStop(1, goldSoft);
        }
        c2d.fillStyle = playing ? grd : goldSoft;
        // Soft center bloom behind tall center bars
        if (playing && v2 > 0.45 && dist2 < 0.35) {
          c2d.save();
          c2d.globalAlpha = 0.12 * v2 * (1 - dist2);
          c2d.fillStyle = goldHot;
          c2d.fillRect(x - 1, h - barH - 4, barW + 2, barH + 4);
          c2d.restore();
        }
        c2d.beginPath();
        roundRect(c2d, x, h - barH, barW, barH, Math.min(2.5, barW / 2));
        c2d.fill();
      }
    }

    draw();
  }

  function roundRect(ctx2, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    ctx2.moveTo(x + r, y);
    ctx2.arcTo(x + w, y, x + w, y + h, r);
    ctx2.arcTo(x + w, y + h, x, y + h, r);
    ctx2.arcTo(x, y + h, x, y, r);
    ctx2.arcTo(x, y, x + w, y, r);
    ctx2.closePath();
  }

  window.MPAudioEnhance = {
    initUI: initUI,
    attachToAudio: attachToAudio,
    resume: resume,
    ensureGraph: ensureGraph,
    isGraphActive: function () {
      return graphReady;
    },
  };
})();
