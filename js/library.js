/**
 * Library: cascading genre/artist filters (never empty combos) + table
 * Genre = custom select (same list styles as artist)
 * Artist = searchable combobox
 */
(function () {
  const LIST_OPEN_KEY = 'mp-library-list-open';

  let allMusics = [];
  let byId = new Map();
  let selectedIds = [];
  let onPlayTrack = null;
  /** 'genre' | 'artist' | null */
  let lastChanged = null;
  /** Track table collapsed by default; preference in localStorage */
  let listOpen = false;

  /** Options valid under the active cascade */
  let genreOptions = [];
  let artistOptions = [];

  /** Which dropdown is open: null | 'genre' | 'artist' */
  let openWhich = null;
  let highlightIndex = -1;
  /** Ignore blur when clicking an option / toggle */
  let ignoreBlur = false;

  function readListOpenPref() {
    try {
      var raw = localStorage.getItem(LIST_OPEN_KEY);
      if (raw === null || raw === undefined) return false;
      return raw === 'true' || raw === '1';
    } catch (_) {
      return false;
    }
  }

  function writeListOpenPref(open) {
    try {
      localStorage.setItem(LIST_OPEN_KEY, open ? 'true' : 'false');
    } catch (_) {}
  }

  function applyListOpenUI() {
    var container = document.getElementById('selected');
    var btn = document.getElementById('library-list-toggle');
    if (container) {
      container.hidden = !listOpen;
      container.classList.toggle('is-collapsed', !listOpen);
      container.setAttribute('aria-hidden', listOpen ? 'false' : 'true');
    }
    if (btn) {
      btn.setAttribute('aria-expanded', listOpen ? 'true' : 'false');
      btn.textContent = listOpen ? 'Hide list' : 'Show list';
    }
  }

  function setListOpen(open) {
    listOpen = !!open;
    writeListOpenPref(listOpen);
    applyListOpenUI();
  }

  function init(musics, handlers) {
    handlers = handlers || {};
    allMusics = musics;
    byId = new Map(musics.map(function (m) {
      return [m.id, m];
    }));
    onPlayTrack = handlers.onPlayTrack || null;
    lastChanged = null;
    listOpen = readListOpenPref();
    genreOptions = [];
    artistOptions = [];
    openWhich = null;
    highlightIndex = -1;
    refreshSelects({ preserve: false });
    bind();
    applyListOpenUI();
    renderTable();
  }

  function getGenre() {
    var el = document.getElementById('dropGenre');
    return (el && el.value) || 'All';
  }

  function getArtist() {
    var el = document.getElementById('dropArtist');
    return (el && el.value) || 'All';
  }

  function displayValue(value) {
    return value && value !== 'All' ? value : 'All';
  }

  function setCommittedGenre(genre) {
    var val = genre || 'All';
    var hidden = document.getElementById('dropGenre');
    var input = document.getElementById('genre-input');
    if (hidden) hidden.value = val;
    if (input) input.value = displayValue(val);
  }

  /**
   * Set committed artist (hidden field). Optionally sync the visible input.
   * @param {string} artist
   * @param {{ syncInput?: boolean, forceSync?: boolean }} opts
   */
  function setCommittedArtist(artist, opts) {
    opts = opts || {};
    var val = artist || 'All';
    var hidden = document.getElementById('dropArtist');
    var input = document.getElementById('artist-input');
    if (hidden) hidden.value = val;
    if (opts.syncInput === false || !input) return;
    if (opts.forceSync || !(openWhich === 'artist' && document.activeElement === input)) {
      input.value = displayValue(val);
    }
  }

  function tracksForGenre(genre) {
    if (!genre || genre === 'All') return allMusics.slice();
    return allMusics.filter(function (m) {
      return m.genre === genre;
    });
  }

  function tracksForArtist(artist) {
    if (!artist || artist === 'All') return allMusics.slice();
    return allMusics.filter(function (m) {
      return m.artist === artist;
    });
  }

  function uniqueSorted(values) {
    var set = {};
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (!v || set[v]) continue;
      set[v] = true;
      out.push(v);
    }
    out.sort(function (a, b) {
      return a.localeCompare(b, 'zh');
    });
    return out;
  }

  /**
   * Rebuild genre/artist options so they always form a non-empty intersection.
   */
  function refreshSelects(opts) {
    opts = opts || {};

    var curGenre = opts.genre != null ? opts.genre : getGenre();
    var curArtist = opts.artist != null ? opts.artist : getArtist();

    var artistPool = tracksForGenre(curGenre);
    var artists = uniqueSorted(
      artistPool.map(function (m) {
        return m.artist;
      })
    );

    var genrePool = tracksForArtist(curArtist);
    var genres = uniqueSorted(
      genrePool.map(function (m) {
        return m.genre;
      })
    );

    if (curArtist !== 'All' && artists.indexOf(curArtist) === -1) {
      curArtist = 'All';
      genrePool = allMusics;
      genres = uniqueSorted(
        genrePool.map(function (m) {
          return m.genre;
        })
      );
    }

    if (curGenre !== 'All' && genres.indexOf(curGenre) === -1) {
      curGenre = 'All';
      artistPool = tracksForGenre(curGenre);
      artists = uniqueSorted(
        artistPool.map(function (m) {
          return m.artist;
        })
      );
    }

    genreOptions = genres;
    artistOptions = artists;

    setCommittedGenre(curGenre);
    setCommittedArtist(curArtist, { forceSync: true, syncInput: true });

    if (openWhich === 'genre') renderGenreList();
    if (openWhich === 'artist') {
      var input = document.getElementById('artist-input');
      renderArtistList(input ? input.value : '');
    }
  }

  // ── Shared list helpers ──────────────────────────────────────────

  function entriesFromNames(names) {
    var out = [{ value: 'All', label: 'All' }];
    for (var i = 0; i < names.length; i++) {
      out.push({ value: names[i], label: names[i] });
    }
    return out;
  }

  function renderOptionList(listId, idPrefix, entries, committed, onPick) {
    var list = document.getElementById(listId);
    if (!list) return;

    list.innerHTML = '';

    if (!entries.length) {
      var empty = document.createElement('li');
      empty.className = 'combobox-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No options';
      list.appendChild(empty);
      highlightIndex = -1;
      return;
    }

    if (highlightIndex >= entries.length) highlightIndex = entries.length - 1;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i++) {
      (function (entry, index) {
        var li = document.createElement('li');
        li.className = 'combobox-option';
        li.setAttribute('role', 'option');
        li.id = idPrefix + index;
        li.dataset.value = entry.value;
        li.setAttribute('aria-selected', entry.value === committed ? 'true' : 'false');
        if (index === highlightIndex) li.classList.add('is-active');
        if (entry.value === committed) li.classList.add('is-selected');
        li.textContent = entry.label;
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          ignoreBlur = true;
        });
        li.addEventListener('click', function () {
          onPick(entry.value);
          ignoreBlur = false;
        });
        frag.appendChild(li);
      })(entries[i], i);
    }
    list.appendChild(frag);

    var active = list.querySelector('.combobox-option.is-active');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function setOpenState(which, open) {
    var configs = {
      genre: {
        listId: 'genre-listbox',
        inputId: 'genre-input',
        rootId: 'genre-combobox',
      },
      artist: {
        listId: 'artist-listbox',
        inputId: 'artist-input',
        rootId: 'artist-combobox',
      },
    };
    var cfg = configs[which];
    if (!cfg) return;
    var list = document.getElementById(cfg.listId);
    var input = document.getElementById(cfg.inputId);
    var root = document.getElementById(cfg.rootId);
    if (open) {
      if (list) list.hidden = false;
      if (input) input.setAttribute('aria-expanded', 'true');
      if (root) root.classList.add('is-open');
    } else {
      if (list) {
        list.hidden = true;
        list.innerHTML = '';
      }
      if (input) {
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
      }
      if (root) root.classList.remove('is-open');
    }
  }

  function closeAllDropdowns() {
    if (openWhich === 'genre') setOpenState('genre', false);
    if (openWhich === 'artist') setOpenState('artist', false);
    openWhich = null;
    highlightIndex = -1;
  }

  function closeGenreList() {
    if (openWhich === 'genre') {
      setOpenState('genre', false);
      openWhich = null;
      highlightIndex = -1;
    }
  }

  function closeArtistList() {
    if (openWhich === 'artist') {
      setOpenState('artist', false);
      openWhich = null;
      highlightIndex = -1;
    }
  }

  function moveHighlight(listId, inputId, delta) {
    var list = document.getElementById(listId);
    var input = document.getElementById(inputId);
    var options = list ? list.querySelectorAll('.combobox-option') : [];
    if (!options.length) return;

    if (highlightIndex < 0) {
      highlightIndex = delta > 0 ? 0 : options.length - 1;
    } else {
      highlightIndex = (highlightIndex + delta + options.length) % options.length;
    }

    for (var i = 0; i < options.length; i++) {
      options[i].classList.toggle('is-active', i === highlightIndex);
    }
    if (input) {
      var active = options[highlightIndex];
      if (active) {
        input.setAttribute('aria-activedescendant', active.id);
        if (typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }

  function pickHighlighted(listId, onPick) {
    if (highlightIndex < 0) return false;
    var list = document.getElementById(listId);
    var opt = list && list.querySelectorAll('.combobox-option')[highlightIndex];
    if (!opt) return false;
    onPick(opt.dataset.value);
    return true;
  }

  // ── Genre custom select (no type-ahead) ──────────────────────────

  function renderGenreList() {
    renderOptionList(
      'genre-listbox',
      'genre-opt-',
      entriesFromNames(genreOptions),
      getGenre(),
      pickGenre
    );
  }

  function openGenreList() {
    if (openWhich === 'artist') {
      restoreArtistInput();
      closeArtistList();
    }
    openWhich = 'genre';
    highlightIndex = -1;
    setOpenState('genre', true);
    renderGenreList();
  }

  function pickGenre(value) {
    lastChanged = 'genre';
    setCommittedGenre(value);
    closeAllDropdowns();
    refreshSelects({ genre: value || 'All', artist: getArtist() });
    renderTable();
  }

  function bindGenreSelect() {
    var input = document.getElementById('genre-input');
    var toggle = document.getElementById('genre-toggle');
    var root = document.getElementById('genre-combobox');
    if (!input) return;

    if (!input.value) input.value = 'All';

    function openFromField() {
      if (openWhich === 'genre') {
        closeGenreList();
      } else {
        openGenreList();
      }
    }

    input.addEventListener('mousedown', function (e) {
      // Toggle on mousedown so we control open/close before focus quirks
      e.preventDefault();
      input.focus();
      openFromField();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (openWhich !== 'genre') openGenreList();
        else moveHighlight('genre-listbox', 'genre-input', 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (openWhich !== 'genre') openGenreList();
        else moveHighlight('genre-listbox', 'genre-input', -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (openWhich === 'genre') {
          if (!pickHighlighted('genre-listbox', pickGenre)) {
            closeGenreList();
          }
        } else {
          openGenreList();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeGenreList();
        input.blur();
      } else if (e.key === 'Tab') {
        closeGenreList();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Type-to-jump: first matching genre by initial character
        e.preventDefault();
        var ch = e.key.toLowerCase();
        var names = ['All'].concat(genreOptions);
        var start = 0;
        if (openWhich === 'genre' && highlightIndex >= 0) start = highlightIndex + 1;
        var found = -1;
        for (var pass = 0; pass < 2 && found < 0; pass++) {
          var from = pass === 0 ? start : 0;
          var to = pass === 0 ? names.length : start;
          for (var i = from; i < to; i++) {
            if (String(names[i]).toLowerCase().charAt(0) === ch) {
              found = i;
              break;
            }
          }
        }
        if (found >= 0) {
          if (openWhich !== 'genre') openGenreList();
          highlightIndex = found;
          renderGenreList();
          var list = document.getElementById('genre-listbox');
          var opts = list ? list.querySelectorAll('.combobox-option') : [];
          if (opts[found] && input) {
            input.setAttribute('aria-activedescendant', opts[found].id);
          }
        }
      }
    });

    input.addEventListener('blur', function () {
      if (ignoreBlur) {
        ignoreBlur = false;
        return;
      }
      setTimeout(function () {
        if (ignoreBlur) {
          ignoreBlur = false;
          return;
        }
        if (document.activeElement === input) return;
        closeGenreList();
      }, 120);
    });

    if (toggle) {
      toggle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        ignoreBlur = true;
      });
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        input.focus();
        openFromField();
        ignoreBlur = false;
      });
    }

    document.addEventListener('mousedown', function (e) {
      if (openWhich !== 'genre' || !root) return;
      if (root.contains(e.target)) return;
      closeGenreList();
    });
  }

  // ── Artist combobox (type-ahead) ─────────────────────────────────

  function filteredArtistEntries(query) {
    var q = String(query || '').trim();
    var names = artistOptions;
    var out = [];

    if (!q || q.toLowerCase() === 'all') {
      return entriesFromNames(names);
    }

    if ('all'.indexOf(q.toLowerCase()) === 0) {
      out.push({ value: 'All', label: 'All' });
    }
    for (var j = 0; j < names.length; j++) {
      if (MPUtils.matchesQuery(names[j], q)) {
        out.push({ value: names[j], label: names[j] });
      }
    }
    return out;
  }

  function renderArtistList(query) {
    var entries = filteredArtistEntries(query);
    var list = document.getElementById('artist-listbox');
    if (!list) return;

    if (!entries.length) {
      list.innerHTML = '';
      var empty = document.createElement('li');
      empty.className = 'combobox-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No matching artists';
      list.appendChild(empty);
      highlightIndex = -1;
      return;
    }

    renderOptionList('artist-listbox', 'artist-opt-', entries, getArtist(), pickArtist);
  }

  function openArtistList(opts) {
    opts = opts || {};
    if (openWhich === 'genre') closeGenreList();

    var list = document.getElementById('artist-listbox');
    var input = document.getElementById('artist-input');
    if (!list || !input) return;

    openWhich = 'artist';
    if (opts.resetHighlight !== false) highlightIndex = -1;
    setOpenState('artist', true);

    var q = opts.query != null ? opts.query : input.value;
    if (opts.fullList) q = '';
    renderArtistList(q);
  }

  function pickArtist(value) {
    lastChanged = 'artist';
    setCommittedArtist(value, { forceSync: true, syncInput: true });
    closeAllDropdowns();
    refreshSelects({ genre: getGenre(), artist: value || 'All' });
    renderTable();
  }

  function restoreArtistInput() {
    var input = document.getElementById('artist-input');
    if (input) input.value = displayValue(getArtist());
  }

  function tryCommitTyped() {
    var input = document.getElementById('artist-input');
    if (!input) return false;
    var raw = String(input.value || '').trim();
    if (!raw || raw.toLowerCase() === 'all') {
      if (getArtist() !== 'All') {
        pickArtist('All');
      } else {
        restoreArtistInput();
        closeArtistList();
      }
      return true;
    }
    var exact = null;
    for (var i = 0; i < artistOptions.length; i++) {
      if (artistOptions[i] === raw) {
        exact = artistOptions[i];
        break;
      }
    }
    if (!exact) {
      var norm = MPUtils.normalizeText(raw);
      for (var j = 0; j < artistOptions.length; j++) {
        if (MPUtils.normalizeText(artistOptions[j]) === norm) {
          exact = artistOptions[j];
          break;
        }
      }
    }
    if (exact) {
      if (getArtist() !== exact) pickArtist(exact);
      else {
        restoreArtistInput();
        closeArtistList();
      }
      return true;
    }
    var entries = filteredArtistEntries(raw).filter(function (e) {
      return e.value !== 'All';
    });
    if (entries.length === 1) {
      pickArtist(entries[0].value);
      return true;
    }
    restoreArtistInput();
    closeArtistList();
    return false;
  }

  function bindArtistCombobox() {
    var input = document.getElementById('artist-input');
    var toggle = document.getElementById('artist-toggle');
    var root = document.getElementById('artist-combobox');
    if (!input) return;

    if (!input.value) input.value = 'All';

    input.addEventListener('focus', function () {
      try {
        input.select();
      } catch (_) {}
      openArtistList({ fullList: true, query: '' });
    });

    input.addEventListener('input', function () {
      highlightIndex = -1;
      openArtistList({ query: input.value, resetHighlight: true, fullList: false });
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (openWhich !== 'artist') openArtistList({ fullList: true, query: '' });
        moveHighlight('artist-listbox', 'artist-input', 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (openWhich !== 'artist') openArtistList({ fullList: true, query: '' });
        moveHighlight('artist-listbox', 'artist-input', -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (openWhich === 'artist' && highlightIndex >= 0) {
          if (pickHighlighted('artist-listbox', pickArtist)) return;
        }
        tryCommitTyped();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        restoreArtistInput();
        closeArtistList();
        input.blur();
      } else if (e.key === 'Tab') {
        if (openWhich === 'artist') tryCommitTyped();
      }
    });

    input.addEventListener('blur', function () {
      if (ignoreBlur) {
        ignoreBlur = false;
        return;
      }
      setTimeout(function () {
        if (ignoreBlur) {
          ignoreBlur = false;
          return;
        }
        if (document.activeElement === input) return;
        if (openWhich === 'artist') tryCommitTyped();
        else restoreArtistInput();
      }, 120);
    });

    if (toggle) {
      toggle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        ignoreBlur = true;
      });
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        if (openWhich === 'artist') {
          restoreArtistInput();
          closeArtistList();
          ignoreBlur = false;
        } else {
          input.focus();
          openArtistList({ fullList: true, query: '' });
          ignoreBlur = false;
        }
      });
    }

    document.addEventListener('mousedown', function (e) {
      if (openWhich !== 'artist' || !root) return;
      if (root.contains(e.target)) return;
      tryCommitTyped();
    });
  }

  function bind() {
    bindGenreSelect();
    bindArtistCombobox();
    var listToggle = document.getElementById('library-list-toggle');
    if (listToggle) {
      listToggle.addEventListener('click', function () {
        setListOpen(!listOpen);
      });
    }
  }

  function getFiltered() {
    var genre = getGenre();
    var artist = getArtist();
    return allMusics.filter(function (m) {
      var gOk = genre === 'All' || m.genre === genre;
      var aOk = artist === 'All' || m.artist === artist;
      return gOk && aOk;
    });
  }

  function renderTable() {
    var container = document.getElementById('selected');
    if (!container) return;
    var list = getFiltered();
    selectedIds = list.map(function (m) {
      return m.id;
    });

    var countEl = document.getElementById('selection-count');
    if (countEl) {
      var n = list.length;
      var unit = n === 1 ? ' song' : ' songs';
      var filtered = getGenre() !== 'All' || getArtist() !== 'All';
      countEl.textContent = n + unit + (filtered ? ' selected' : '');
    }

    if (!list.length) {
      container.innerHTML =
        '<p class="empty-hint">No songs match this filter. Try All for genre or artist.</p>';
      applyListOpenUI();
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'track-table-wrap';

    var table = document.createElement('table');
    table.className = 'track-table';
    table.setAttribute('aria-label', 'Selected tracks');

    var colgroup = document.createElement('colgroup');
    colgroup.innerHTML = '<col class="col-name" /><col class="col-artist" />';
    table.appendChild(colgroup);

    var thead = document.createElement('thead');
    thead.innerHTML =
      '<tr><th scope="col" class="col-name">Music Name</th><th scope="col" class="col-artist">Artist</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      (function (m) {
        var tr = document.createElement('tr');
        tr.tabIndex = 0;
        tr.dataset.id = String(m.id);
        tr.innerHTML =
          '<td class="col-name">' +
          MPUtils.escapeHtml(m.name) +
          '</td><td class="col-artist">' +
          MPUtils.escapeHtml(m.artist) +
          '</td>';
        var play = function () {
          if (onPlayTrack) onPlayTrack(m.id, list);
        };
        tr.addEventListener('click', play);
        tr.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            play();
          }
        });
        frag.appendChild(tr);
      })(list[i]);
    }
    tbody.appendChild(frag);
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.innerHTML = '';
    container.appendChild(wrap);
    applyListOpenUI();
  }

  function getSelectedTracks() {
    return selectedIds.map(function (id) {
      return byId.get(id);
    }).filter(Boolean);
  }

  function getModePreference() {
    if (window.MPPlayer && typeof MPPlayer.getMode === 'function') {
      return MPPlayer.getMode() === 'Loop' ? 'Loop' : 'Random';
    }
    return 'Random';
  }

  function setFilters(genre, artist) {
    lastChanged = null;
    closeAllDropdowns();
    refreshSelects({
      genre: genre || 'All',
      artist: artist || 'All',
    });
    renderTable();
  }

  window.MPLibrary = {
    init: init,
    getFiltered: getFiltered,
    getSelectedTracks: getSelectedTracks,
    getModePreference: getModePreference,
    setFilters: setFilters,
    getArtist: getArtist,
    getGenre: getGenre,
    renderTable: renderTable,
    get byId() {
      return byId;
    },
  };
})();
