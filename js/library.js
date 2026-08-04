/**
 * Library: cascading genre/artist filters (never empty combos) + table
 */
(function () {
  const LIST_OPEN_KEY = 'mp-library-list-open';

  let allMusics = [];
  let byId = new Map();
  let selectedIds = [];
  let onPlayTrack = null;
  /** 'genre' | 'artist' | null — which filter the user last changed, for cascade priority */
  let lastChanged = null;
  /** Track table collapsed by default; preference remembered in localStorage */
  let listOpen = false;

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
   * - Genre "All" → all artists
   * - Genre X → only artists who have tracks in X
   * - Artist "All" → all genres
   * - Artist Y → only genres Y appears in
   * When both are specific, options still include the current pair + valid peers.
   */
  function refreshSelects(opts) {
    opts = opts || {};
    var genreSel = document.getElementById('dropGenre');
    var artistSel = document.getElementById('dropArtist');
    if (!genreSel || !artistSel) return;

    var curGenre = opts.genre != null ? opts.genre : getGenre();
    var curArtist = opts.artist != null ? opts.artist : getArtist();

    // Pool for artist list: constrained by genre if set
    var artistPool = tracksForGenre(curGenre);
    var artists = uniqueSorted(
      artistPool.map(function (m) {
        return m.artist;
      })
    );

    // Pool for genre list: constrained by artist if set
    var genrePool = tracksForArtist(curArtist);
    var genres = uniqueSorted(
      genrePool.map(function (m) {
        return m.genre;
      })
    );

    // If current artist is no longer valid under the new genre, reset artist to All
    if (curArtist !== 'All' && artists.indexOf(curArtist) === -1) {
      curArtist = 'All';
      // Recompute genres for All artists
      genrePool = allMusics;
      genres = uniqueSorted(
        genrePool.map(function (m) {
          return m.genre;
        })
      );
    }

    // If current genre is no longer valid under the new artist, reset genre to All
    if (curGenre !== 'All' && genres.indexOf(curGenre) === -1) {
      curGenre = 'All';
      artistPool = tracksForGenre(curGenre);
      artists = uniqueSorted(
        artistPool.map(function (m) {
          return m.artist;
        })
      );
    }

    fillSelect(genreSel, genres, curGenre);
    fillSelect(artistSel, artists, curArtist);

    // Ensure values stuck (in case option missing)
    if (genreSel.value !== curGenre && curGenre === 'All') genreSel.value = 'All';
    if (artistSel.value !== curArtist && curArtist === 'All') artistSel.value = 'All';
  }

  function fillSelect(sel, names, selected) {
    var prev = selected;
    sel.innerHTML = '';

    var allOpt = document.createElement('option');
    allOpt.value = 'All';
    allOpt.textContent = 'All';
    sel.appendChild(allOpt);

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }

    // Restore selection if still present
    var has = prev === 'All';
    if (!has) {
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === prev) {
          has = true;
          break;
        }
      }
    }
    sel.value = has ? prev : 'All';
  }

  function bind() {
    var genreSel = document.getElementById('dropGenre');
    var artistSel = document.getElementById('dropArtist');
    var listToggle = document.getElementById('library-list-toggle');
    if (genreSel) {
      genreSel.addEventListener('change', function () {
        lastChanged = 'genre';
        // Rebuild artist list for this genre; keep artist if still valid
        refreshSelects({ genre: genreSel.value, artist: getArtist() });
        renderTable();
        if (window.MPPlayer && MPPlayer.updateModeUI) MPPlayer.updateModeUI();
      });
    }
    if (artistSel) {
      artistSel.addEventListener('change', function () {
        lastChanged = 'artist';
        refreshSelects({ genre: getGenre(), artist: artistSel.value });
        renderTable();
        if (window.MPPlayer && MPPlayer.updateModeUI) MPPlayer.updateModeUI();
      });
    }
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
      // All/All = whole library; only say "selected" when a filter is active
      var filtered = getGenre() !== 'All' || getArtist() !== 'All';
      countEl.textContent = n + unit + (filtered ? ' selected' : '');
    }

    // Cascading filters should make this rare; keep as safety net
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
    // Preserve collapsed/expanded state after re-render
    applyListOpenUI();
  }

  function getSelectedTracks() {
    return selectedIds.map(function (id) {
      return byId.get(id);
    }).filter(Boolean);
  }

  /** Play mode lives on the player control (Random / Loop), not in Library filters. */
  function getModePreference() {
    if (window.MPPlayer && typeof MPPlayer.getMode === 'function') {
      return MPPlayer.getMode() === 'Loop' ? 'Loop' : 'Random';
    }
    return 'Random';
  }

  function setFilters(genre, artist) {
    lastChanged = null;
    refreshSelects({
      genre: genre || 'All',
      artist: artist || 'All',
    });
    renderTable();
    if (window.MPPlayer && MPPlayer.updateModeUI) MPPlayer.updateModeUI();
  }

  window.MPLibrary = {
    init: init,
    getFiltered: getFiltered,
    getSelectedTracks: getSelectedTracks,
    getModePreference: getModePreference,
    setFilters: setFilters,
    renderTable: renderTable,
    get byId() {
      return byId;
    },
  };
})();
