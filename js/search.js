/**
 * Search songs / artists with debounce, keyboard nav, multi-token match
 */
(function () {
  let allMusics = [];
  let onPlay = null;
  let activeIndex = -1;
  let currentResults = [];

  function init(musics, handlers = {}) {
    allMusics = musics;
    onPlay = handlers.onPlay || null;
    const input = document.getElementById('search-input');
    if (!input) return;

    const run = MPUtils.debounce(getResults, 140);
    input.addEventListener('input', run);
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('focus', () => {
      if (input.value.trim()) getResults();
    });

    document.addEventListener('click', (e) => {
      const box = document.querySelector('.search-container');
      if (box && !box.contains(e.target)) hideResults();
    });
  }

  function getResults() {
    const input = document.getElementById('search-input');
    const resultsEl = document.getElementById('search-results');
    if (!input || !resultsEl) return;

    const q = input.value.trim();
    clearResults();
    activeIndex = -1;
    currentResults = [];
    // Never keep a separate "picked" line under the box
    clearPicked();

    if (!q) {
      hideResults();
      return;
    }

    const hits = [];
    // Full bar text after a pick: "Title — Artist" → exact track first
    const exact = MPUtils.findExactTrackLabel(allMusics, q);
    if (exact) {
      hits.push(exact);
    } else {
      for (const m of allMusics) {
        if (MPUtils.matchesQuery(m.name + ' ' + m.artist, q)) {
          hits.push(m);
          if (hits.length >= 40) break;
        }
      }
    }
    currentResults = hits;

    if (!hits.length) {
      resultsEl.innerHTML = '<div class="search-item muted">No matches</div>';
      showResults();
      return;
    }

    const frag = document.createDocumentFragment();
    hits.forEach((m, i) => {
      const div = document.createElement('div');
      div.className = 'search-item';
      div.setAttribute('role', 'option');
      div.dataset.index = String(i);
      div.innerHTML =
        '<span class="search-name">' +
        MPUtils.highlightMatch(m.name, q) +
        '</span>' +
        '<span class="search-artist">' +
        MPUtils.highlightMatch(m.artist, q) +
        '</span>';
      div.addEventListener('click', () => selectTrack(m));
      frag.appendChild(div);
    });
    resultsEl.appendChild(frag);
    showResults();
  }

  function selectTrack(m) {
    const input = document.getElementById('search-input');
    // Put the full choice in the search field (autocomplete-style), not under it
    if (input) {
      input.value = m.name + ' - ' + m.artist;
    }
    clearPicked();
    hideResults();
    clearResults();
    activeIndex = -1;
    currentResults = [];
    if (onPlay) onPlay(m.id);
  }

  function clearPicked() {
    const dataEl = document.getElementById('search-data');
    if (dataEl) dataEl.innerHTML = '';
  }

  function onKeyDown(e) {
    const resultsEl = document.getElementById('search-results');
    if (!resultsEl) return;

    if (e.key === 'Escape') {
      hideResults();
      e.target.blur();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!currentResults.length) return;
      activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
      paintActive();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!currentResults.length) return;
      activeIndex = Math.max(activeIndex - 1, 0);
      paintActive();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && currentResults[activeIndex]) {
        selectTrack(currentResults[activeIndex]);
      } else if (currentResults[0]) {
        selectTrack(currentResults[0]);
      }
    }
  }

  function paintActive() {
    const resultsEl = document.getElementById('search-results');
    const items = document.querySelectorAll('#search-results .search-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      if (i === activeIndex && resultsEl) {
        // Scroll only the dropdown list, never the page
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        if (top < resultsEl.scrollTop) {
          resultsEl.scrollTop = top;
        } else if (bottom > resultsEl.scrollTop + resultsEl.clientHeight) {
          resultsEl.scrollTop = bottom - resultsEl.clientHeight;
        }
      }
    });
  }

  function clearResults() {
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) resultsEl.innerHTML = '';
  }

  function showResults() {
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) resultsEl.hidden = false;
  }

  function hideResults() {
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) resultsEl.hidden = true;
    activeIndex = -1;
  }

  function focus() {
    const input = document.getElementById('search-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  window.MPSearch = { init, focus, hideResults };
})();
