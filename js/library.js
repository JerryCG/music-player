/**
 * Library: cascading genre/artist filters (never empty combos) + table
 * Genre = custom select (same list styles as artist)
 * Artist = multi-chip combobox (Enter = involves, click credit = exact; OR match)
 */
(function () {
  const LIST_OPEN_KEY = 'mp-library-list-open';
  const SORT_KEY = 'mp-library-sort';
  /** @type {Record<string, string>} */
  const SORT_LABELS = {
    'id-asc': 'Oldest first',
    'id-desc': 'Newest first',
    'title-asc': 'Title A–Z',
    'artist-asc': 'Artist A–Z',
  };
  const SORT_ORDER = ['id-asc', 'id-desc', 'title-asc', 'artist-asc'];

  let allMusics = [];
  let byId = new Map();
  let selectedIds = [];
  let onPlayTrack = null;
  /** 'genre' | 'artist' | null */
  let lastChanged = null;
  /** Track table collapsed by default; preference in localStorage */
  let listOpen = false;
  /**
   * Library list / Play selection order.
   * Default id-asc = catalog order (earliest added first).
   * @type {'id-asc'|'id-desc'|'title-asc'|'artist-asc'}
   */
  let sortMode = 'id-asc';

  /** Options valid under the active cascade */
  let genreOptions = [];
  let artistOptions = [];

  /** Which dropdown is open: null | 'genre' | 'artist' | 'sort' */
  let openWhich = null;
  let highlightIndex = -1;
  /** Ignore blur when clicking an option / toggle */
  let ignoreBlur = false;
  /**
   * After adding a chip we re-focus the input for the next name, but must not
   * re-open the list (mobile Chrome: Enter blurs then focus() fires open again).
   */
  let suppressArtistListOpen = false;
  /** Ignore blur→commit while we stabilize focus after Enter/pick */
  let suppressArtistBlurCommit = false;

  /**
   * Selected artist rules (OR). Empty = All artists.
   * mode: exact = whole credit string; involves = singer in credit (collabs)
   * @type {{ value: string, mode: 'exact'|'involves' }[]}
   */
  let artistRules = [];

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

  function readSortPref() {
    try {
      var raw = localStorage.getItem(SORT_KEY);
      if (raw && SORT_LABELS[raw]) return raw;
    } catch (_) {}
    return 'id-asc';
  }

  function writeSortPref(mode) {
    try {
      localStorage.setItem(SORT_KEY, mode);
    } catch (_) {}
  }

  function applySortUI() {
    var btnText = document.getElementById('library-sort-btn-text');
    var btn = document.getElementById('library-sort-btn');
    var label = SORT_LABELS[sortMode] || SORT_LABELS['id-asc'];
    if (btnText) btnText.textContent = label;
    if (btn) btn.setAttribute('aria-label', 'Sort selected songs: ' + label);
  }

  /**
   * Stable locale-aware compare for multi-script titles/artists.
   * @param {string} a
   * @param {string} b
   */
  function cmpText(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  }

  /**
   * @param {object[]} list
   * @returns {object[]}
   */
  function sortTracks(list) {
    var mode = sortMode;
    var copy = list.slice();
    copy.sort(function (a, b) {
      if (mode === 'id-desc') {
        return (b.id || 0) - (a.id || 0);
      }
      if (mode === 'title-asc') {
        var tn = cmpText(a.name, b.name);
        if (tn) return tn;
        var ta = cmpText(a.artist, b.artist);
        if (ta) return ta;
        return (a.id || 0) - (b.id || 0);
      }
      if (mode === 'artist-asc') {
        var aa = cmpText(a.artist, b.artist);
        if (aa) return aa;
        var an = cmpText(a.name, b.name);
        if (an) return an;
        return (a.id || 0) - (b.id || 0);
      }
      // id-asc (default): earliest added first
      return (a.id || 0) - (b.id || 0);
    });
    return copy;
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
    sortMode = readSortPref();
    genreOptions = [];
    artistOptions = [];
    openWhich = null;
    highlightIndex = -1;
    artistRules = [];
    refreshSelects({ preserve: false });
    bind();
    applyListOpenUI();
    applySortUI();
    renderTable();
  }

  function getGenre() {
    var el = document.getElementById('dropGenre');
    return (el && el.value) || 'All';
  }

  /** @returns {{ value: string, mode: string }[]} */
  function getArtistRules() {
    return artistRules.slice();
  }

  /** Legacy single value: All | one name | joined summary for simple callers */
  function getArtist() {
    if (!artistRules.length) return 'All';
    if (artistRules.length === 1) return artistRules[0].value;
    return formatArtistRulesShort(artistRules);
  }

  /** Legacy: exact if empty/single-exact, involves if single involves, else mixed */
  function getArtistMatchMode() {
    if (!artistRules.length) return 'exact';
    if (artistRules.length === 1) {
      return artistRules[0].mode === 'involves' ? 'involves' : 'exact';
    }
    return 'multi';
  }

  function displayValue(value) {
    return value && value !== 'All' ? value : 'All';
  }

  function ruleKey(value, mode) {
    return (mode === 'involves' ? 'i:' : 'e:') + String(value || '');
  }

  function formatRuleLabel(rule) {
    if (!rule || !rule.value) return '';
    return rule.mode === 'involves' ? rule.value + '+' : rule.value;
  }

  /** Always list every selected name; separators stay readable when long */
  function formatArtistRulesLabel(rules) {
    rules = rules || artistRules;
    if (!rules.length) return 'All';
    return rules
      .map(function (r) {
        return formatRuleLabel(r);
      })
      .join(' · ');
  }

  function formatArtistRulesShort(rules) {
    return formatArtistRulesLabel(rules);
  }

  function setCommittedGenre(genre) {
    var val = genre || 'All';
    var hidden = document.getElementById('dropGenre');
    var input = document.getElementById('genre-input');
    if (hidden) hidden.value = val;
    if (input) input.value = displayValue(val);
  }

  /** Sync hidden fields + chips from artistRules (input stays free for next add) */
  function syncArtistFilterUI(opts) {
    opts = opts || {};
    var hidden = document.getElementById('dropArtist');
    var modeEl = document.getElementById('dropArtistMode');
    var input = document.getElementById('artist-input');
    if (hidden) {
      hidden.value = !artistRules.length
        ? 'All'
        : artistRules.length === 1
          ? artistRules[0].value
          : formatArtistRulesLabel(artistRules);
    }
    if (modeEl) modeEl.value = getArtistMatchMode();
    renderArtistChips();
    if (opts.clearInput && input) {
      input.value = '';
      input.placeholder = artistRules.length ? 'Add another artist…' : 'Add artist…';
    } else if (input && !artistRules.length && !input.value) {
      input.placeholder = 'Add artist…';
    }
  }

  function renderArtistChips() {
    var host = document.getElementById('artist-chips');
    if (!host) return;
    host.innerHTML = '';
    if (!artistRules.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < artistRules.length; i++) {
      (function (rule, index) {
        var chip = document.createElement('span');
        chip.className =
          'artist-chip' + (rule.mode === 'involves' ? ' is-involves' : ' is-exact');
        chip.setAttribute('role', 'listitem');
        chip.title =
          rule.mode === 'involves'
            ? 'Involves “' + rule.value + '” (solo + collabs) — click × to remove'
            : 'Exact credit “' + rule.value + '” — click × to remove';

        var label = document.createElement('span');
        label.className = 'artist-chip-label';
        label.textContent = formatRuleLabel(rule);
        chip.appendChild(label);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'artist-chip-remove';
        btn.setAttribute('aria-label', 'Remove ' + formatRuleLabel(rule));
        btn.textContent = '×';
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          removeArtistRuleAt(index);
        });
        chip.appendChild(btn);
        frag.appendChild(chip);
      })(artistRules[i], i);
    }
    host.appendChild(frag);
  }

  function clearArtistRules() {
    artistRules = [];
    syncArtistFilterUI({ clearInput: true });
  }

  function removeArtistRuleAt(index) {
    if (index < 0 || index >= artistRules.length) return;
    lastChanged = 'artist';
    artistRules.splice(index, 1);
    syncArtistFilterUI({ clearInput: false });
    refreshSelects({ genre: getGenre() });
    renderTable();
  }

  /**
   * Add or replace a rule. All / empty clears.
   * @returns {boolean} true if rules changed
   */
  function addArtistRule(value, mode) {
    if (!value || value === 'All') {
      var had = artistRules.length > 0;
      clearArtistRules();
      return had;
    }
    var m = mode === 'involves' ? 'involves' : 'exact';
    var key = ruleKey(value, m);
    for (var i = 0; i < artistRules.length; i++) {
      if (ruleKey(artistRules[i].value, artistRules[i].mode) === key) {
        return false; // already present
      }
      // Same name, upgrade exact → involves or replace mode
      if (artistRules[i].value === value) {
        if (artistRules[i].mode === m) return false;
        artistRules[i].mode = m;
        return true;
      }
    }
    artistRules.push({ value: value, mode: m });
    return true;
  }

  function tracksForGenre(genre) {
    if (!genre || genre === 'All') return allMusics.slice();
    return allMusics.filter(function (m) {
      return m.genre === genre;
    });
  }

  function trackMatchesRule(m, rule) {
    if (!rule || !rule.value || rule.value === 'All') return true;
    if (rule.mode === 'involves') return MPUtils.matchesQuery(m.artist, rule.value);
    return m.artist === rule.value;
  }

  /** OR across rules; empty rules = match all */
  function trackMatchesArtistRules(m, rules) {
    rules = rules || artistRules;
    if (!rules.length) return true;
    for (var i = 0; i < rules.length; i++) {
      if (trackMatchesRule(m, rules[i])) return true;
    }
    return false;
  }

  function tracksForArtistRules(rules) {
    rules = rules || artistRules;
    if (!rules.length) return allMusics.slice();
    return allMusics.filter(function (m) {
      return trackMatchesArtistRules(m, rules);
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

  function ruleStillValidInPool(rule, pool) {
    if (!rule || !rule.value || rule.value === 'All') return false;
    for (var i = 0; i < pool.length; i++) {
      if (trackMatchesRule(pool[i], rule)) return true;
    }
    return false;
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

    // Optional replace of whole rule set (setFilters / init)
    if (opts.artistRules) {
      artistRules = opts.artistRules
        .map(function (r) {
          if (!r || !r.value || r.value === 'All') return null;
          return {
            value: r.value,
            mode: r.mode === 'involves' ? 'involves' : 'exact',
          };
        })
        .filter(Boolean);
    } else if (opts.artist != null) {
      // Legacy single artist from setFilters(genre, artist, mode)
      if (!opts.artist || opts.artist === 'All') {
        artistRules = [];
      } else {
        artistRules = [
          {
            value: opts.artist,
            mode: opts.artistMode === 'involves' || opts.mode === 'involves' ? 'involves' : 'exact',
          },
        ];
      }
    }

    var artistPool = tracksForGenre(curGenre);
    var artists = uniqueSorted(
      artistPool.map(function (m) {
        return m.artist;
      })
    );

    // Drop rules that have zero tracks under the current genre
    if (artistRules.length) {
      artistRules = artistRules.filter(function (r) {
        return ruleStillValidInPool(r, artistPool);
      });
    }

    var genrePool = tracksForArtistRules(artistRules);
    var genres = uniqueSorted(
      genrePool.map(function (m) {
        return m.genre;
      })
    );

    if (curGenre !== 'All' && genres.indexOf(curGenre) === -1) {
      curGenre = 'All';
      artistPool = tracksForGenre(curGenre);
      artists = uniqueSorted(
        artistPool.map(function (m) {
          return m.artist;
        })
      );
      // Re-validate rules against All genres
      if (artistRules.length) {
        artistRules = artistRules.filter(function (r) {
          return ruleStillValidInPool(r, artistPool);
        });
      }
      genrePool = tracksForArtistRules(artistRules);
      genres = uniqueSorted(
        genrePool.map(function (m) {
          return m.genre;
        })
      );
    }

    genreOptions = genres;
    artistOptions = artists;

    setCommittedGenre(curGenre);
    syncArtistFilterUI({ clearInput: !!opts.clearArtistInput });

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

  /**
   * Whether a list row should show selected/ticked.
   * - Exact rule: only that credit string.
   * - Involves rule (xx+): the "All involving" row for xx, plus every exact
   *   credit that matches xx (solo + collabs) — same set as the filter.
   */
  function isRuleSelected(value, mode) {
    if (value === 'All') return !artistRules.length;
    mode = mode || 'exact';
    var key = ruleKey(value, mode);

    for (var i = 0; i < artistRules.length; i++) {
      var r = artistRules[i];
      // Direct match (same value + mode)
      if (ruleKey(r.value, r.mode) === key) return true;

      // Involves chip → highlight all list credits covered by that involves key
      if (r.mode === 'involves' && mode === 'exact' && value && value !== 'All') {
        if (MPUtils.matchesQuery(value, r.value)) return true;
      }
    }
    return false;
  }

  function renderOptionList(listId, idPrefix, entries, onPick, isSelectedFn) {
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
        var mode = entry.mode || 'exact';
        var li = document.createElement('li');
        li.className = 'combobox-option';
        if (entry.involves) li.classList.add('is-involves');
        li.setAttribute('role', 'option');
        li.id = idPrefix + index;
        li.dataset.value = entry.value;
        li.dataset.mode = mode;
        var selected =
          typeof isSelectedFn === 'function'
            ? isSelectedFn(entry)
            : entry.value === 'All'
              ? !artistRules.length
              : false;
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
      sort: {
        listId: 'library-sort-listbox',
        inputId: 'library-sort-btn',
        rootId: 'library-sort-root',
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
    if (openWhich === 'sort') setOpenState('sort', false);
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

  function closeSortList() {
    if (openWhich === 'sort') {
      setOpenState('sort', false);
      openWhich = null;
      highlightIndex = -1;
    }
  }

  // ── Library sort custom select (Genre-style list + Show-list button chrome) ──

  function renderSortList() {
    var list = document.getElementById('library-sort-listbox');
    if (!list) return;
    list.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < SORT_ORDER.length; i++) {
      (function (value, index) {
        var li = document.createElement('li');
        li.id = 'sort-opt-' + index;
        li.className = 'combobox-option';
        li.setAttribute('role', 'option');
        li.dataset.value = value;
        var selected = value === sortMode;
        li.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (index === highlightIndex) li.classList.add('is-active');
        if (selected) li.classList.add('is-selected');
        li.textContent = SORT_LABELS[value];
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          ignoreBlur = true;
        });
        li.addEventListener('click', function () {
          pickSort(value);
          ignoreBlur = false;
        });
        frag.appendChild(li);
      })(SORT_ORDER[i], i);
    }
    list.appendChild(frag);
    var active = list.querySelector('.combobox-option.is-active');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function openSortList() {
    if (openWhich === 'genre') closeGenreList();
    if (openWhich === 'artist') {
      restoreArtistInput();
      closeArtistList();
    }
    openWhich = 'sort';
    highlightIndex = Math.max(0, SORT_ORDER.indexOf(sortMode));
    setOpenState('sort', true);
    renderSortList();
  }

  function pickSort(value) {
    if (!SORT_LABELS[value]) value = 'id-asc';
    sortMode = value;
    writeSortPref(sortMode);
    applySortUI();
    closeAllDropdowns();
    renderTable();
  }

  function bindSortSelect() {
    var btn = document.getElementById('library-sort-btn');
    var root = document.getElementById('library-sort-root');
    if (!btn || !root) return;

    function openFromField() {
      if (openWhich === 'sort') closeSortList();
      else openSortList();
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      openFromField();
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (openWhich !== 'sort') openSortList();
        else moveHighlight('library-sort-listbox', 'library-sort-btn', 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (openWhich !== 'sort') openSortList();
        else moveHighlight('library-sort-listbox', 'library-sort-btn', -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (openWhich === 'sort') {
          if (highlightIndex >= 0 && SORT_ORDER[highlightIndex]) {
            pickSort(SORT_ORDER[highlightIndex]);
          } else {
            closeSortList();
          }
        } else {
          openSortList();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSortList();
        btn.blur();
      } else if (e.key === 'Tab') {
        closeSortList();
      }
    });

    document.addEventListener('mousedown', function (e) {
      if (openWhich !== 'sort' || !root) return;
      if (root.contains(e.target)) return;
      closeSortList();
    });
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

  function pickHighlighted(listId, onPick, pickOpts) {
    if (highlightIndex < 0) return false;
    var list = document.getElementById(listId);
    var opt = list && list.querySelectorAll('.combobox-option')[highlightIndex];
    if (!opt) return false;
    onPick(opt.dataset.value, opt.dataset.mode || 'exact', pickOpts);
    return true;
  }

  // ── Genre custom select (no type-ahead) ──────────────────────────

  function renderGenreList() {
    var cur = getGenre();
    renderOptionList(
      'genre-listbox',
      'genre-opt-',
      entriesFromNames(genreOptions),
      function (value) {
        pickGenre(value);
      },
      function (entry) {
        return entry.value === cur;
      }
    );
  }

  function openGenreList() {
    if (openWhich === 'artist') {
      restoreArtistInput();
      closeArtistList();
    }
    if (openWhich === 'sort') closeSortList();
    openWhich = 'genre';
    highlightIndex = -1;
    setOpenState('genre', true);
    renderGenreList();
  }

  function pickGenre(value) {
    lastChanged = 'genre';
    setCommittedGenre(value);
    closeAllDropdowns();
    refreshSelects({ genre: value || 'All' });
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

  // ── Artist combobox (multi-chip + involves) ──────────────────────

  function stripArtistDisplaySuffix(raw) {
    var s = String(raw || '').trim();
    if (s.length > 2 && s.slice(-2) === ' +') s = s.slice(0, -2).trim();
    return s;
  }

  /** Collab-style credits (prefer solo names as involves canonical form) */
  function looksLikeCollabCredit(name) {
    var s = String(name || '');
    if (/[&/、]|feat\.?|ft\.?| featuring /i.test(s)) return true;
    return false;
  }

  /**
   * Map free-typed query → closest artist-list string for involves chips/labels.
   * Prefer exact normalize match, then solo credits, then shorter names.
   * @returns {string|null} canonical name, or null if no list match
   */
  function resolveInvolvesCanonical(query) {
    var q = stripArtistDisplaySuffix(query);
    if (!q || q.toLowerCase() === 'all') return null;
    var qn = MPUtils.normalizeText(q);
    if (!qn) return null;

    var seen = {};
    var candidates = [];

    function addCandidate(name) {
      if (!name || seen[name]) return;
      var nn = MPUtils.normalizeText(name);
      if (!nn) return;
      // Query tokens must appear in the credit (same spirit as involves)
      if (nn !== qn && !MPUtils.matchesQuery(name, q)) return;
      seen[name] = true;
      candidates.push(name);
    }

    for (var i = 0; i < artistOptions.length; i++) addCandidate(artistOptions[i]);

    // Credits on tracks in current genre (in case a collab-only spelling is useful)
    var pool = tracksForGenre(getGenre());
    for (var j = 0; j < pool.length; j++) addCandidate(pool[j].artist);

    if (!candidates.length) return null;

    var best = null;
    var bestScore = -1e9;
    for (var k = 0; k < candidates.length; k++) {
      var c = candidates[k];
      var cn = MPUtils.normalizeText(c);
      var score = 0;
      if (cn === qn) score += 10000;
      // Prefer solo-looking labels as the involves key (黄霄云 over 丁当 黄霄云)
      if (!looksLikeCollabCredit(c)) score += 500;
      // Prefix / containment of the typed form
      if (cn.indexOf(qn) === 0) score += 200;
      else if (cn.indexOf(qn) !== -1) score += 80;
      // Shorter credit ≈ cleaner canonical singer name
      score -= cn.length;
      // Stable tie-break
      score -= k * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    // If we only found collab credits, still prefer a solo-shaped key when the
    // typed query is shorter and itself matches tracks as involves.
    if (best && looksLikeCollabCredit(best) && qn.length < MPUtils.normalizeText(best).length) {
      if (countTracksInvolving(q, getGenre()) > 0) {
        // Keep typed query only if no non-collab candidate existed
        var hasSolo = candidates.some(function (c) {
          return !looksLikeCollabCredit(c);
        });
        if (!hasSolo) {
          // Use query trimmed; casing stays as typed (no solo catalog form)
          return q;
        }
      }
    }

    return best;
  }

  /**
   * Involves key for UI + Enter: closest list match when possible, else raw query.
   */
  function involvesKeyForQuery(query) {
    var q = stripArtistDisplaySuffix(query);
    if (!q) return '';
    var canon = resolveInvolvesCanonical(q);
    return canon || q;
  }

  function filteredArtistEntries(query) {
    var q = stripArtistDisplaySuffix(query);
    var names = artistOptions;
    var out = [];

    if (!q || q.toLowerCase() === 'all') {
      out.push({ value: 'All', label: artistRules.length ? 'Clear all artists' : 'All', mode: 'exact' });
      for (var i = 0; i < names.length; i++) {
        out.push({ value: names[i], label: names[i], mode: 'exact' });
      }
      return out;
    }

    // Canonicalize free text to closest catalog artist for a stable involves key
    var involveKey = involvesKeyForQuery(q);
    var involveCount = countTracksInvolving(involveKey, getGenre());
    if (involveCount > 0) {
      out.push({
        value: involveKey,
        label:
          'All involving “' +
          involveKey +
          '” (' +
          involveCount +
          (involveCount === 1 ? ' song)' : ' songs)'),
        mode: 'involves',
        involves: true,
      });
    }

    if ('all'.indexOf(q.toLowerCase()) === 0) {
      out.push({
        value: 'All',
        label: artistRules.length ? 'Clear all artists' : 'All',
        mode: 'exact',
      });
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
      pickArtist,
      function (entry) {
        return isRuleSelected(entry.value, entry.mode || 'exact');
      }
    );
  }

  function openArtistList(opts) {
    opts = opts || {};
    // Programmatic re-focus after pick must not pop the list open again
    if (suppressArtistListOpen && !opts.force) return;

    if (openWhich === 'genre') closeGenreList();
    if (openWhich === 'sort') closeSortList();

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
   * Hold window scroll while mobile focus thrash settles (Enter → next field = Search).
   */
  function holdWindowScroll(ms) {
    ms = ms == null ? 280 : ms;
    var x = window.scrollX || window.pageXOffset || 0;
    var y = window.scrollY || window.pageYOffset || 0;
    var done = false;
    function pin() {
      if (done) return;
      window.scrollTo(x, y);
    }
    pin();
    var id = window.setInterval(pin, 16);
    window.setTimeout(function () {
      done = true;
      window.clearInterval(id);
      pin();
    }, ms);
  }

  /**
   * Focus artist input for the next add without reopening the list or scrolling
   * the page (esp. mobile Enter advancing focus to #search-input).
   */
  function focusArtistInputQuietly() {
    var input = document.getElementById('artist-input');
    if (!input) return;
    suppressArtistListOpen = true;
    suppressArtistBlurCommit = true;
    holdWindowScroll(360);

    function refocus() {
      if (document.activeElement === input) return;
      try {
        input.focus({ preventScroll: true });
      } catch (_) {
        try {
          input.focus();
        } catch (_) {}
      }
    }

    // If mobile jumps focus to Search (next text field after collapsed library), pull it back.
    function onFocusIn(e) {
      if (!suppressArtistBlurCommit) return;
      var t = e.target;
      if (!t || t === input) return;
      if (t.id === 'search-input' || (t.tagName === 'INPUT' && t !== input)) {
        e.stopPropagation();
        refocus();
        holdWindowScroll(100);
      }
    }
    document.addEventListener('focusin', onFocusIn, true);

    refocus();
    requestAnimationFrame(function () {
      refocus();
      requestAnimationFrame(refocus);
    });
    window.setTimeout(refocus, 0);
    window.setTimeout(refocus, 50);
    window.setTimeout(refocus, 120);
    window.setTimeout(refocus, 220);
    window.setTimeout(function () {
      document.removeEventListener('focusin', onFocusIn, true);
      suppressArtistListOpen = false;
      suppressArtistBlurCommit = false;
      // Final pin in case a late scroll happened
      holdWindowScroll(50);
      refocus();
    }, 360);
  }

  /**
   * Add artist rule (or clear if All). Does not replace existing chips.
   * @param {string} value
   * @param {string} [mode] 'exact' | 'involves'
   * @param {{ fromEnter?: boolean }} [opts]
   */
  function pickArtist(value, mode, opts) {
    opts = opts || {};
    lastChanged = 'artist';
    // Snapshot scroll before chips/table reflow (collapsed list → big layout jump)
    if (opts.fromEnter) holdWindowScroll(360);

    if (!value || value === 'All') {
      clearArtistRules();
      closeAllDropdowns();
      refreshSelects({ genre: getGenre() });
      renderTable();
      focusArtistInputQuietly();
      return;
    }
    var m = mode === 'involves' ? 'involves' : 'exact';
    addArtistRule(value, m);
    syncArtistFilterUI({ clearInput: true });
    closeAllDropdowns();
    refreshSelects({ genre: getGenre(), clearArtistInput: true });
    renderTable();
    // Ready for next singer — keep keyboard if open, but do not reopen the list
    // or let mobile Enter scroll to Search.
    focusArtistInputQuietly();
  }

  function restoreArtistInput() {
    var input = document.getElementById('artist-input');
    if (!input) return;
    // Multi-chip: input is only for the next add — clear rather than restore a single value
    input.value = '';
    input.placeholder = artistRules.length ? 'Add another artist…' : 'Add artist…';
  }

  /**
   * Free-text commit: Enter/blur → involves when possible (add chip).
   * Involves key is canonicalized to the closest artist-list match.
   * @param {{ fromEnter?: boolean }} [opts]
   */
  function tryCommitTyped(opts) {
    opts = opts || {};
    var input = document.getElementById('artist-input');
    if (!input) return false;
    var raw = stripArtistDisplaySuffix(input.value);
    if (!raw) {
      restoreArtistInput();
      closeArtistList();
      return true;
    }
    if (raw.toLowerCase() === 'all') {
      pickArtist('All', 'exact', opts);
      return true;
    }

    var involveKey = involvesKeyForQuery(raw);
    var involveCount = countTracksInvolving(involveKey, getGenre());
    if (involveCount > 0) {
      pickArtist(involveKey, 'involves', opts);
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
    // Closest list credit as exact fallback (same resolver, collab allowed)
    if (!exact) {
      var near = resolveInvolvesCanonical(raw);
      if (near && artistOptions.indexOf(near) !== -1) exact = near;
    }
    if (exact) {
      pickArtist(exact, 'exact', opts);
      return true;
    }

    restoreArtistInput();
    closeArtistList();
    return false;
  }

  function bindArtistCombobox() {
    var input = document.getElementById('artist-input');
    var toggle = document.getElementById('artist-toggle');
    var root = document.getElementById('artist-filter') || document.getElementById('artist-combobox');
    if (!input) return;

    input.value = '';
    input.placeholder = 'Add artist…';
    renderArtistChips();

    input.addEventListener('focus', function () {
      if (suppressArtistListOpen) return;
      openArtistList({
        fullList: !String(input.value || '').trim(),
        query: String(input.value || '').trim() ? input.value : '',
      });
    });

    input.addEventListener('input', function () {
      // User typing: always allow list (clears post-pick suppress from focus-only path)
      suppressArtistListOpen = false;
      highlightIndex = -1;
      openArtistList({ query: input.value, resetHighlight: true, fullList: false, force: true });
    });

    function onArtistEnter(e) {
      // Mobile Chrome: Enter/"Go" advances to the next text field (Search),
      // skipping buttons — only obvious when the track table is collapsed.
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      holdWindowScroll(320);
      suppressArtistListOpen = true;
      suppressArtistBlurCommit = true;
      if (openWhich === 'artist' && highlightIndex >= 0) {
        if (pickHighlighted('artist-listbox', pickArtist, { fromEnter: true })) return;
      }
      tryCommitTyped({ fromEnter: true });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        suppressArtistListOpen = false;
        if (openWhich !== 'artist') openArtistList({ fullList: !input.value.trim(), query: input.value });
        moveHighlight('artist-listbox', 'artist-input', 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        suppressArtistListOpen = false;
        if (openWhich !== 'artist') openArtistList({ fullList: !input.value.trim(), query: input.value });
        moveHighlight('artist-listbox', 'artist-input', -1);
      } else if (e.key === 'Enter') {
        onArtistEnter(e);
      } else if (e.key === 'Backspace' && !String(input.value || '') && artistRules.length) {
        // Empty field + Backspace removes last chip (list stays closed)
        e.preventDefault();
        removeArtistRuleAt(artistRules.length - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        restoreArtistInput();
        closeArtistList();
        input.blur();
      } else if (e.key === 'Tab') {
        if (openWhich === 'artist' && String(input.value || '').trim()) {
          tryCommitTyped();
        } else {
          closeArtistList();
        }
      }
    });
    // Some mobile WebViews still advance focus on keypress/keyup Enter
    input.addEventListener('keypress', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    input.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    input.addEventListener('blur', function () {
      if (ignoreBlur || suppressArtistBlurCommit) {
        ignoreBlur = false;
        return;
      }
      setTimeout(function () {
        if (ignoreBlur || suppressArtistBlurCommit) {
          ignoreBlur = false;
          return;
        }
        if (document.activeElement === input) return;
        // If focus fled to Search (or elsewhere) right after Enter, reclaim quietly
        var ae = document.activeElement;
        if (
          ae &&
          ae !== input &&
          (ae.id === 'search-input' || (ae.tagName === 'INPUT' && ae !== input))
        ) {
          // only reclaim when we just committed / suppressed
          return;
        }
        if (openWhich === 'artist') {
          if (String(input.value || '').trim()) tryCommitTyped();
          else {
            restoreArtistInput();
            closeArtistList();
          }
        } else restoreArtistInput();
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
      if (String(input.value || '').trim()) tryCommitTyped();
      else {
        restoreArtistInput();
        closeArtistList();
      }
    });
  }

  function bind() {
    bindGenreSelect();
    bindArtistCombobox();
    bindSortSelect();
    var listToggle = document.getElementById('library-list-toggle');
    if (listToggle) {
      listToggle.addEventListener('click', function () {
        setListOpen(!listOpen);
      });
    }
  }

  function getFiltered() {
    var genre = getGenre();
    var list = allMusics.filter(function (m) {
      var gOk = genre === 'All' || m.genre === genre;
      var aOk = trackMatchesArtistRules(m, artistRules);
      return gOk && aOk;
    });
    return sortTracks(list);
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
      // Keep count simple — artist chips + mode pill already list who is selected
      var filtered = getGenre() !== 'All' || artistRules.length > 0;
      countEl.textContent = n + unit + (filtered ? ' selected' : '');
      countEl.removeAttribute('title');
      countEl.classList.remove('is-multi-filter');
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
    // Prefer live sorted filter (same order as table / Play selection)
    return getFiltered();
  }

  function getModePreference() {
    if (window.MPPlayer && typeof MPPlayer.getMode === 'function') {
      return MPPlayer.getMode() === 'Loop' ? 'Loop' : 'Random';
    }
    return 'Random';
  }

  /**
   * @param {string} genre
   * @param {string|Array} artist - 'All' | name | array of {value,mode}
   * @param {string} [artistMode] 'exact' | 'involves' (used when artist is a single name string)
   */
  function setFilters(genre, artist, artistMode) {
    lastChanged = null;
    closeAllDropdowns();
    var rules = null;
    if (Array.isArray(artist)) {
      rules = artist
        .map(function (r) {
          if (!r) return null;
          if (typeof r === 'string') {
            var s = String(r).trim();
            if (!s || s === 'All') return null;
            var inv = s.charAt(s.length - 1) === '+';
            return {
              value: inv ? s.slice(0, -1).trim() : s,
              mode: inv ? 'involves' : 'exact',
            };
          }
          var value = String(r.value || '').trim();
          if (value.charAt(value.length - 1) === '+') {
            value = value.slice(0, -1).trim();
          }
          if (!value || value === 'All') return null;
          return {
            value: value,
            mode: r.mode === 'involves' ? 'involves' : 'exact',
          };
        })
        .filter(Boolean);
    } else if (!artist || artist === 'All') {
      rules = [];
    } else {
      var name = String(artist).trim();
      var involves = artistMode === 'involves';
      if (name.charAt(name.length - 1) === '+') {
        name = name.slice(0, -1).trim();
        involves = true;
      }
      rules = name
        ? [
            {
              value: name,
              mode: involves ? 'involves' : 'exact',
            },
          ]
        : [];
    }
    refreshSelects({
      genre: genre || 'All',
      artistRules: rules,
      clearArtistInput: true,
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
    getArtistRules: getArtistRules,
    getArtistMatchMode: getArtistMatchMode,
    formatArtistRulesLabel: formatArtistRulesLabel,
    getGenre: getGenre,
    renderTable: renderTable,
    get byId() {
      return byId;
    },
  };
})();
