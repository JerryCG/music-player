/**
 * Theme: dark | light only.
 * First visit: detect system preference (fallback dark). Toggle switches between dark/light.
 * No separate "follow system" UI state.
 */
(function () {
  const KEY = 'mp-theme'; // stored as 'dark' | 'light' only

  function systemPrefersDark() {
    try {
      if (window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
    } catch (_) {}
    return true; // undetermined → dark
  }

  function detectInitial() {
    try {
      if (window.matchMedia) {
        // light only if explicitly light; otherwise dark
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      }
    } catch (_) {}
    return 'dark';
  }

  function getPreference() {
    var stored = MPUtils.storageGet(KEY, null);
    // Migrate legacy 'system' → resolve once to a concrete mode
    if (stored === 'system' || stored == null || (stored !== 'dark' && stored !== 'light')) {
      var initial = detectInitial();
      MPUtils.storageSet(KEY, initial);
      return initial;
    }
    return stored;
  }

  function apply() {
    var theme = getPreference();
    if (theme !== 'dark' && theme !== 'light') theme = 'dark';

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.removeAttribute('data-theme-pref');

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#050505' : '#f4eee0';

    var btn = document.getElementById('theme-toggle');
    if (btn) {
      if (theme === 'light') {
        btn.textContent = '☀';
        btn.setAttribute('aria-label', 'Switch to dark mode');
        btn.title = 'Light mode — click for dark';
      } else {
        btn.textContent = '☾';
        btn.setAttribute('aria-label', 'Switch to light mode');
        btn.title = 'Dark mode — click for light';
      }
    }
  }

  function cycle() {
    var cur = getPreference();
    var next = cur === 'dark' ? 'light' : 'dark';
    MPUtils.storageSet(KEY, next);
    apply();
    MPUtils.toast(next === 'dark' ? 'Dark mode' : 'Light mode');
  }

  function init() {
    apply();
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', cycle);
  }

  window.MPTheme = {
    init: init,
    apply: apply,
    cycle: cycle,
    getPreference: getPreference,
    systemPrefersDark: systemPrefersDark,
  };
})();
