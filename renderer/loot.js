// ---------------------------------------------------------------
// Loot & Vendors panel — every distinct item looted across all characters, and
// for the one you click, the vendors who will buy it (filterable to the zone
// you're standing in). "Selling to…" attributes your next sales to a vendor.
// Self-contained: talks to the main process only through window.mapAPI.
// ---------------------------------------------------------------
(() => {
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Coin is base-100: 100c = 1s, 100s = 1g, 100g = 1p.
  function coin(c) {
    c = Math.round(c);
    const p = Math.floor(c / 1000000); c %= 1000000;
    const g = Math.floor(c / 10000); c %= 10000;
    const s = Math.floor(c / 100);
    return [p && p + 'p', g && g + 'g', s && s + 's', c % 100 && (c % 100) + 'c'].filter(Boolean).join(' ') || '0c';
  }
  const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  let items = [], recent = [], characters = [];
  let tab = 'items';            // 'items' | 'recent'
  let selected = null;          // the item entry being shown
  let zoneMode = 'here';        // 'here' | 'all'
  let currentZone = '';         // the game's internal zone code
  let zoneLabel = '';           // display name for the current zone
  let vendors = [];             // for the "selling to" picker
  let session = { active: null, recorded: 0 };
  let detail = null;            // last loot-vendors result for `selected`
  const isOpen = () => !el('loot-modal').classList.contains('hidden');

  // ---- data ----
  async function refresh() {
    const r = await window.mapAPI.lootList({ includeBeta: el('loot-beta').checked });
    if (r && !r.error) {
      items = r.items; recent = r.recent; characters = r.characters;
      if (selected) selected = items.find((i) => i.key === selected.key) || null;
    }
    renderList();
    if (selected) await loadDetail(); else renderDetail();
  }

  async function loadVendors() {
    vendors = (await window.mapAPI.vendorList(currentZone)) || [];
    const here = vendors.find((v) => v.inZone);
    zoneLabel = currentZone ? (here ? here.zone : currentZone) : '';
    session = (await window.mapAPI.vendorSession({ action: 'status' })) || session;
    renderSell();
  }

  async function loadDetail() {
    if (!selected) return;
    detail = await window.mapAPI.lootVendors({ name: selected.name, id: selected.id, zone: currentZone });
    renderDetail();
  }

  // ---- left column ----
  function renderList() {
    const q = el('loot-search').value.trim().toLowerCase();
    const box = el('loot-list');
    if (tab === 'recent') {
      const rows = recent.filter((r) => !q || r.name.toLowerCase().includes(q));
      box.innerHTML = rows.length ? rows.map((r) =>
        '<div class="loot-row" data-key="' + esc(r.key) + '"><span class="loot-name">' + esc(r.name) + (r.qty > 1 ? ' ×' + r.qty : '') + '</span>' +
        '<span class="loot-meta">' + esc(r.source || '—') + ' · ' + esc(r.zone || '—') + '<br>' + esc(r.character) + ' · ' + esc(when(r.t)) + '</span></div>').join('')
        : '<p class="replay-empty">Nothing looted yet.</p>';
      return;
    }
    const rows = items.filter((i) => !q || i.name.toLowerCase().includes(q));
    box.innerHTML = rows.length ? rows.map((i) =>
      '<div class="loot-row' + (selected && selected.key === i.key ? ' sel' : '') + '" data-key="' + esc(i.key) + '">' +
      '<span class="loot-name">' + esc(i.name) + '</span>' +
      '<span class="loot-meta">' + (i.reported ? '<b class="loot-ok" title="You have a confirmed vendor price for this">✔</b> ' : '') + '×' + i.total +
      (characters.length > 1 ? ' · ' + Object.keys(i.byCharacter).length + ' char' : '') + '</span></div>').join('')
      : '<p class="replay-empty">' + (items.length ? 'No match.' : 'No loot found yet. Play a little with the game running and it will appear here.') + '</p>';
  }

  // ---- right column ----
  const HOW = {
    confirmed: ['Confirmed', 'loot-b-confirmed'],
    exact: ['Buys this item', 'loot-b-exact'],
    category: ['Likely', 'loot-b-cat'],
    any: ['Buys anything (reduced)', 'loot-b-any'],
  };

  function buyerRow(b) {
    const [label, cls] = HOW[b.how] || ['', ''];
    let note = '';
    if (b.how === 'confirmed') {
      note = '<b>' + esc(coin(b.price)) + '</b> each · ' + b.reports + ' report' + (b.reports > 1 ? 's' : '') +
        (b.min !== b.max ? ' (' + esc(coin(b.min)) + '–' + esc(coin(b.max)) + ')' : '') + ' · ' + esc(when(b.ts));
    } else if (b.how === 'category') note = 'buys ' + esc(b.tag || b.via);
    else if (b.how === 'exact') note = 'lists it by name';
    return '<div class="loot-buyer"><div><span class="loot-badge ' + cls + '">' + esc(label) + '</span> <b>' + esc(b.name) + '</b></div>' +
      '<div class="loot-meta">' + (note ? note + '<br>' : '') + esc(b.location || b.zone) + '</div></div>';
  }

  function renderDetail() {
    const box = el('loot-detail');
    if (!selected) { box.innerHTML = '<p class="replay-empty">Pick an item to see who will buy it.</p>'; return; }
    const i = selected;
    const chars = Object.entries(i.byCharacter).sort((a, b) => b[1] - a[1]).map(([c, n]) => esc(c) + ' ×' + n).join(', ');
    const mobs = Object.entries(i.sources).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => esc(m) + ' ×' + n).join(', ');
    let html = '<h3>' + esc(i.name) + '</h3><div class="loot-meta">Looted ×' + i.total + (chars ? ' — ' + chars : '') + '</div>' +
      (mobs ? '<div class="loot-meta">From: ' + mobs + '</div>' : '') +
      (i.sales.lastAt ? '<div class="loot-meta">You last sold one for <b>' + esc(coin(i.sales.lastUnit)) + '</b> (' + esc(when(i.sales.lastAt)) + ')</div>' : '');

    html += '<div class="loot-filter"><div class="replay-toggle">' +
      '<button id="loot-z-here" class="rv-btn' + (zoneMode === 'here' ? ' active' : '') + '"' + (currentZone ? '' : ' disabled title="Zone unknown — start the game first"') + '>Here' + (zoneLabel ? ' (' + esc(zoneLabel) + ')' : '') + '</button>' +
      '<button id="loot-z-all" class="rv-btn' + (zoneMode === 'all' || !currentZone ? ' active' : '') + '">All locations</button></div></div>';

    if (!detail || detail.error) {
      html += '<p class="replay-empty">' + esc(detail && detail.error ? detail.error : 'Loading…') + '</p>';
    } else {
      const here = zoneMode === 'here' && currentZone;
      const buyers = detail.buyers.filter((b) => !here || b.inZone);
      if (!buyers.length) {
        const elsewhere = detail.buyers.length;
        html += '<p class="replay-empty">No known buyers ' + (here ? 'in ' + esc(zoneLabel) + (elsewhere ? ' — ' + elsewhere + ' elsewhere. Try “All locations”.' : '.') : 'yet.') + '</p>';
      } else if (here) {
        html += buyers.map(buyerRow).join('');
      } else {
        const byZone = new Map();
        buyers.forEach((b) => { const z = b.zone || 'Unknown'; (byZone.get(z) || byZone.set(z, []).get(z)).push(b); });
        const zones = [...byZone.keys()].sort((a, b) => (byZone.get(b).some((x) => x.inZone) - byZone.get(a).some((x) => x.inZone)) || a.localeCompare(b));
        html += zones.map((z) => '<div class="replay-col-title">' + esc(z) + '</div>' + byZone.get(z).map(buyerRow).join('')).join('');
      }
      if (detail.tags && detail.tags.length) html += '<div class="loot-meta loot-foot">Matched as: ' + detail.tags.map(esc).join(', ') + '. “Likely” means the wiki says this vendor buys that kind of item.</div>';
    }
    box.innerHTML = html;
    const here = el('loot-z-here'), all = el('loot-z-all');
    if (here) here.addEventListener('click', () => { zoneMode = 'here'; renderDetail(); });
    if (all) all.addEventListener('click', () => { zoneMode = 'all'; renderDetail(); });
  }

  // ---- "selling to" bar ----
  function renderSell() {
    const box = el('loot-sell');
    if (session.active) {
      box.innerHTML = '<span>Selling to <b>' + esc(session.active.vendorName) + '</b> (' + esc(session.active.zone) + ') — ' +
        session.recorded + ' sale' + (session.recorded === 1 ? '' : 's') + ' recorded</span><button id="loot-sell-stop" class="secondary">Stop</button>';
      el('loot-sell-stop').addEventListener('click', async () => { session = await window.mapAPI.vendorSession({ action: 'end' }); renderSell(); refresh(); });
      return;
    }
    const opt = (v) => '<option value="' + esc(v.id) + '">' + esc(v.name) + (v.inZone ? '' : ' — ' + esc(v.zone)) + '</option>';
    const here = vendors.filter((v) => v.inZone), elsewhere = vendors.filter((v) => !v.inZone);
    box.innerHTML = '<label for="loot-sell-pick">Selling to</label><select id="loot-sell-pick"><option value="">Pick a vendor…</option>' +
      (here.length ? '<optgroup label="Here' + (zoneLabel ? ' — ' + esc(zoneLabel) : '') + '">' + here.map(opt).join('') + '</optgroup>' : '') +
      '<optgroup label="Elsewhere">' + elsewhere.map(opt).join('') + '</optgroup></select>' +
      '<button id="loot-sell-go" class="secondary" disabled>Start</button>' +
      '<span class="loot-meta">Pick the vendor you\'re standing at, then sell. Your sales are saved as confirmed prices for them.</span>';
    const pick = el('loot-sell-pick'), go = el('loot-sell-go');
    pick.addEventListener('change', () => { go.disabled = !pick.value; });
    go.addEventListener('click', async () => {
      const r = await window.mapAPI.vendorSession({ action: 'start', vendorId: pick.value });
      if (r && !r.error) { session = r; renderSell(); }
    });
  }

  // ---- wiring ----
  async function open() {
    el('loot-modal').classList.remove('hidden');
    try { currentZone = (await window.mapAPI.currentGameZone()) || ''; } catch { currentZone = ''; }
    if (!currentZone) zoneMode = 'all';
    el('loot-list').innerHTML = '<p class="replay-empty">Reading your Ledger…</p>';
    await loadVendors();
    await refresh();
  }
  const close = () => el('loot-modal').classList.add('hidden');

  el('btn-loot').addEventListener('click', open);
  el('loot-close').addEventListener('click', close);
  el('loot-x').addEventListener('click', close);
  el('loot-beta').addEventListener('change', refresh);
  el('loot-search').addEventListener('input', renderList);
  const setTab = (t) => {
    tab = t;
    el('loot-tab-items').classList.toggle('active', t === 'items');
    el('loot-tab-recent').classList.toggle('active', t === 'recent');
    renderList();
  };
  el('loot-tab-items').addEventListener('click', () => setTab('items'));
  el('loot-tab-recent').addEventListener('click', () => setTab('recent'));
  el('loot-list').addEventListener('click', (e) => {
    const row = e.target.closest('.loot-row');
    if (!row) return;
    selected = items.find((i) => i.key === row.dataset.key) || null;
    renderList();
    detail = null;
    renderDetail();
    loadDetail();
  });

  // Keep following the player: a zone change refreshes the "here" filter and, because
  // the main process ends the vendor session on zoning, the selling bar.
  window.mapAPI.onGameZone(async (zone) => {
    currentZone = zone || '';
    if (!isOpen()) return;
    await loadVendors();
    if (selected) loadDetail();
  });
  window.mapAPI.onLootUpdated(() => { if (isOpen()) refresh().then(loadVendors); });
})();
