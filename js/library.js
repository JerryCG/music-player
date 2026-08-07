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

  /**
   * How the committed artist filter matches tracks:
   * - exact: m.artist === value (one credit string)
   * - involves: singer appears in credit (collabs included)
   */
  let artistMatchMode = 'exact';

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
    artistMatchMode = 'exact';
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

  function getArtistMatchMode() {
    return artistMatchMode === 'involves' ? 'involves' : 'exact';
  }

  function displayValue(value) {
    return value && value !== 'All' ? value : 'All';
  }

  /** Visible combobox text; "+" suffix marks involves (collabs) mode */
  function displayArtistValue(value, mode) {
    if (!value || value === 'All') return 'All';
    if (mode === 'involves') return value + ' +';
    return value;
  }

  function setCommittedGenre(genre) {
    var val = genre || 'All';
    var hidden = document.getElementById('dropGenre');
    var input = document.getElementById('genre-input');
    if (hidden) hidden.value = val;
    if (input) input.value = displayValue(val);
  }

  /**
   * Set committed artist (hidden field + match mode). Optionally sync the visible input.
   * @param {string} artist
   * @param {{ syncInput?: boolean, forceSync?: boolean, mode?: string }} opts
   */
  function setCommittedArtist(artist, opts) {
    opts = opts || {};
    var val = artist || 'All';
    if (opts.mode === 'involves' || opts.mode === 'exact') {
      artistMatchMode = val === 'All' ? 'exact' : opts.mode;
    } else if (val === 'All') {
      artistMatchMode = 'exact';
    }
    var mode = getArtistMatchMode();
    var hidden = document.getElementById('dropArtist');
    var modeEl = document.getElementById('dropArtistMode');
    var input = document.getElementById('artist-input');
    if (hidden) hidden.value = val;
    if (modeEl) modeEl.value = mode;
    if (opts.syncInput === false || !input) return;
    if (opts.forceSync || !(openWhich === 'artist' && document.activeElement === input)) {
      input.value = displayArtistValue(val, mode);
    }
  }

  function tracksForGenre(genre) {
    if (!genre || genre === 'All') return allMusics.slice();
    return allMusics.filter(function (m) {
      return m.genre === genre;
    });
  }

  /** True if track matches the artist filter (exact credit or involves singer). */
  function trackMatchesArtist(m, artist, mode) {
    if (!artist || artist === 'All') return true;
    mode = mode || getArtistMatchMode();
    if (mode === 'involves') {
      return MPUtils.matchesQuery(m.artist, artist);
    }
    return m.artist === artist;
  }

  function tracksForArtist(artist, mode) {
    if (!artist || artist === 'All') return allMusics.slice();
    mode = mode != null ? mode : getArtistMatchMode();
    return allMusics.filter(function (m) {
      return trackMatchesArtist(m, artist, mode);
    });
  }

  function countTracksInvolving(query, genre) {
    var q = String(query || '').trim();
    if (!q) return 0;
    var pool = tracksForGenre(genre != null ? genre : getGenre());
    var n = 0;
    for (var i = 0; i < pool.length; i++) {
      if (MPUtils.matchesQuery(pool[i].artist, q)) n++;
    }
    return n;
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
    var curMode =
      opts.artistMode != null
        ? opts.artistMode
        : opts.mode != null
          ? opts.mode
          : getArtistMatchMode();
    if (curArtist === 'All') curMode = 'exact';

    var artistPool = tracksForGenre(curGenre);
    var artists = uniqueSorted(
      artistPool.map(function (m) {
        return m.artist;
      })
    );

    var genrePool = tracksForArtist(curArtist, curMode);
    var genres = uniqueSorted(
      genrePool.map(function (m) {
        return m.genre;
      })
    );

    // Exact: committed credit must still appear under this genre.
    // Involves: at least one track under this genre must still match the singer.
    var artistStillValid = true;
    if (curArtist !== 'All') {
      if (curMode === 'involves') {
        artistStillValid = artistPool.some(function (m) {
          return trackMatchesArtist(m, curArtist, 'involves');
        });
      } else {
        artistStillValid = artists.indexOf(curArtist) !== -1;
      }
    }
    if (!artistStillValid) {
      curArtist = 'All';
      curMode = 'exact';
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
    setCommittedArtist(curArtist, { forceSync: true, syncInput: true, mode: curMode });

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

  function renderOptionList(listId, idPrefix, entries, committed, onPick, committedMode) {
    var list = document.getElementById(listId);
    if (!list) return;
    committedMode = committedMode || 'exact';

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
        var mode = entry.mode || 'exact';
        var li = document.createElement('li');
        li.className = 'combobox-option';
        if (entry.involves) li.classList.add('is-involves');
        li.setAttribute('role', 'option');
        li.id = idPrefix + index;
        li.dataset.value = entry.value;
        li.dataset.mode = mode;
        var selected =
          entry.value === committed &&
          (committed === 'All' || mode === committedMode || (entry.involves && committedMode === 'involves'));
        li.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (index === highlightIndex) li.classList.add('is-active');
        if (selected) li.classList.add('is-selected');
        li.textContent = entry.label;
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          ignoreBlur = true;
        });
        li.addEventListener('click', function () {
          onPick(entry.value, mode);
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
    onPick(opt.dataset.value, opt.dataset.mode || 'exact');
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
    refreshSelects({
      genre: value || 'All',
      artist: getArtist(),
      artistMode: getArtistMatchMode(),
    });
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

  // ── Artist combobox (type-ahead + involves) ──────────────────────

  /** Strip involves display suffix " +" if user left it in the field */
  function stripArtistDisplaySuffix(raw) {
    var s = String(raw || '').trim();
    if (s.length > 2 && s.slice(-2) === ' +') s = s.slice(0, -2).trim();
    return s;
  }

  function filteredArtistEntries(query) {
    var q = stripArtistDisplaySuffix(query);
    var names = artistOptions;
    var out = [];

    if (!q || q.toLowerCase() === 'all') {
      return entriesFromNames(names);
    }

    // Prefer collabs: first row applies involves match for the typed query
    var involveCount = countTracksInvolving(q, getGenre());
    if (involveCount > 0) {
      out.push({
        value: q,
        label:
          'All involving “' +
          q +
          '” (' +
          involveCount +
          (involveCount === 1 ? ' song)' : ' songs)'),
        mode: 'involves',
        involves: true,
      });
    }

    if ('all'.indexOf(q.toLowerCase()) === 0) {
      out.push({ value: 'All', label: 'All', mode: 'exact' });
    }
    for (var j = 0; j < names.length; j++) {
      if (MPUtils.matchesQuery(names[j], q)) {
        out.push({ value: names[j], label: names[j], mode: 'exact' });
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

    renderOptionList(
      'artist-listbox',
      'artist-opt-',
      entries,
      getArtist(),
      pickArtist,
      getArtistMatchMode()
    );
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

  /**
   * @param {string} value
   * @param {string} [mode] 'exact' | 'involves'
   */
  function pickArtist(value, mode) {
    lastChanged = 'artist';
    var m = mode === 'involves' ? 'involves' : 'exact';
    if (!value || value === 'All') {
      value = 'All';
      m = 'exact';
    }
    setCommittedArtist(value, { forceSync: true, syncInput: true, mode: m });
    closeAllDropdowns();
    refreshSelects({ genre: getGenre(), artist: value || 'All', artistMode: m });
    renderTable();
  }

  function restoreArtistInput() {
    var input = document.getElementById('artist-input');
    if (input) input.value = displayArtistValue(getArtist(), getArtistMatchMode());
  }

  /**
   * Commit free text: prefers involves (all collabs) when Enter/blur with a typed query.
   * Highlighted list row is handled separately before this is called.
   */
  function tryCommitTyped() {
    var input = document.getElementById('artist-input');
    if (!input) return false;
    var raw = stripArtistDisplaySuffix(input.value);
    if (!raw || raw.toLowerCase() === 'all') {
      if (getArtist() !== 'All' || getArtistMatchMode() !== 'exact') {
        pickArtist('All', 'exact');
      } else {
        restoreArtistInput();
        closeArtistList();
      }
      return true;
    }

    var involveCount = countTracksInvolving(raw, getGenre());
    if (involveCount > 0) {
      // Typed Enter / blur → involves (solo + collabs)
      if (getArtist() === raw && getArtistMatchMode() === 'involves') {
        restoreArtistInput();
        closeArtistList();
      } else {
        pickArtist(raw, 'involves');
      }
      return true;
    }

    // No involves hit under current genre — try exact credit only
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
      pickArtist(exact, 'exact');
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
    var mode = getArtistMatchMode();
    return allMusics.filter(function (m) {
      var gOk = genre === 'All' || m.genre === genre;
      var aOk = trackMatchesArtist(m, artist, mode);
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

  function setFilters(genre, artist, artistMode) {
    lastChanged = null;
    closeAllDropdowns();
    var mode = artistMode === 'involves' ? 'involves' : 'exact';
    if (!artist || artist === 'All') mode = 'exact';
    refreshSelects({
      genre: genre || 'All',
      artist: artist || 'All',
      artistMode: mode,
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
    getArtistMatchMode: getArtistMatchMode,
    getGenre: getGenre,
    renderTable: renderTable,
    get byId() {
      return byId;
    },
  };
})();
