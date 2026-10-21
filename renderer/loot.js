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
  // "1g 20s 5c", "12c" or a bare number (copper) -> copper; NaN if it isn't a price.
  function parseCoin(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return 0;
    if (/^\d+$/.test(t)) return +t;
    const mult = { p: 1000000, g: 10000, s: 100, c: 1 };
    const parts = [...t.matchAll(/(\d+)\s*([pgsc])/g)];
    if (!parts.length || t.replace(/(\d+)\s*([pgsc])/g, '').replace(/[\s,]/g, '')) return NaN;
    return parts.reduce((sum, m) => sum + +m[1] * mult[m[2]], 0);
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
  let editingTags = false;      // the category editor is open
  let editingReport = null;     // id of the report whose price is being edited
  let itemNames = null;         // wiki item names for the form's combobox (fetched once)
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
      '<span class="loot-meta">' + (i.reported ? '<b class="loot-ok" title="You have a confirmed vendor price for this">✔</b> ' : '') + (i.total ? '×' + i.total : 'not looted') +
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
    const wiki = b.wikiUrl ? ' <a class="loot-wiki" href="' + esc(b.wikiUrl) + '" target="_blank" rel="noopener" title="Open the wiki page">wiki ↗</a>' : '';
    return '<div class="loot-buyer"><div><span class="loot-badge ' + cls + '">' + esc(label) + '</span> <b>' + esc(b.name) + '</b>' +
      (b.local ? ' <span class="loot-badge" title="A vendor you added">yours</span>' : '') + wiki + '</div>' +
      '<div class="loot-meta">' + (note ? note + '<br>' : '') + esc(b.location || b.zone) + '</div></div>';
  }

  function renderDetail() {
    const box = el('loot-detail');
    if (!selected) { box.innerHTML = '<p class="replay-empty">Pick an item to see who will buy it.</p>'; return; }
    const i = selected;
    const chars = Object.entries(i.byCharacter).sort((a, b) => b[1] - a[1]).map(([c, n]) => esc(c) + ' ×' + n).join(', ');
    const mobs = Object.entries(i.sources).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => esc(m) + ' ×' + n).join(', ');
    let html = '<h3>' + esc(i.name) + '</h3><div class="loot-meta">' + (i.total ? 'Looted ×' + i.total + (chars ? ' — ' + chars : '') : 'Not looted yet — listed because you added a price') + '</div>' +
      (mobs ? '<div class="loot-meta">From: ' + mobs + '</div>' : '') +
      (i.sales.lastAt ? '<div class="loot-meta">You last sold one for <b>' + esc(coin(i.sales.lastUnit)) + '</b> (' + esc(when(i.sales.lastAt)) + ')</div>' : '');

    if (detail && !detail.error) html += categoryHtml();
    html += '<div class="loot-filter"><div class="replay-toggle">' +
      '<button data-act="z-here" class="rv-btn' + (zoneMode === 'here' ? ' active' : '') + '"' + (currentZone ? '' : ' disabled title="Zone unknown — start the game first"') + '>Here' + (zoneLabel ? ' (' + esc(zoneLabel) + ')' : '') + '</button>' +
      '<button data-act="z-all" class="rv-btn' + (zoneMode === 'all' || !currentZone ? ' active' : '') + '">All locations</button></div> <button class="secondary" data-act="add-for" title="Tell the app what a vendor pays for this item">+ Add a vendor price</button></div>';

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
        // Confirmed prices lead, whatever zone they are in; the rest are grouped by zone.
        const sure = buyers.filter((b) => b.how === 'confirmed');
        if (sure.length) html += '<div class="replay-col-title">Confirmed prices</div>' + sure.map(buyerRow).join('');
        const byZone = new Map();
        buyers.filter((b) => b.how !== 'confirmed').forEach((b) => { const z = b.zone || 'Unknown'; (byZone.get(z) || byZone.set(z, []).get(z)).push(b); });
        const zones = [...byZone.keys()].sort((a, b) => (byZone.get(b).some((x) => x.inZone) - byZone.get(a).some((x) => x.inZone)) || a.localeCompare(b));
        html += zones.map((z) => '<div class="replay-col-title">' + esc(z) + '</div>' + byZone.get(z).map(buyerRow).join('')).join('');
      }
      if (detail.mine && detail.mine.length) html += '<div class="replay-col-title">Your reports</div>' + detail.mine.map(myReportHtml).join('');
      html += '<div class="loot-meta loot-foot">“Likely” means the wiki says this vendor buys that kind of item.</div>';
    }
    box.innerHTML = html;
  }

  // The item's category: what the vendor matching uses. Automatic unless the player set it.
  function categoryHtml() {
    if (!editingTags) {
      return '<div class="loot-cat">Category: <b>' + (detail.tags.length ? detail.tags.map(esc).join(', ') : 'none recognised') + '</b> ' +
        '<span class="loot-meta">(' + (detail.tagsAuto ? 'automatic' : 'set by you') + ')</span> ' +
        '<button class="linklike" data-act="cat-edit">Edit</button>' + (detail.tagsAuto ? '' : ' <button class="linklike" data-act="cat-reset">Reset</button>') + '</div>';
    }
    const on = new Set(detail.tagIds);
    return '<div class="loot-cat"><div class="loot-meta">What kind of item is this? Vendors that buy these categories will be offered.</div><div class="loot-tags">' +
      detail.allTags.map((t) => '<label><input type="checkbox" value="' + esc(t.id) + '"' + (on.has(t.id) ? ' checked' : '') + '> ' + esc(t.label) + '</label>').join('') +
      '</div><button class="secondary" data-act="cat-save">Save</button> <button class="linklike" data-act="cat-cancel">Cancel</button><span id="loot-cat-err" class="loot-error"></span></div>';
  }

  function myReportHtml(r) {
    if (editingReport === r.id) {
      return '<div class="loot-buyer"><div><b>' + esc(r.vendorName) + '</b></div><div><input class="loot-price" id="loot-rep-price" value="' + esc(coin(r.unitPrice)) + '" size="12"> ' +
        '<button class="secondary" data-act="rep-save" data-id="' + esc(r.id) + '">Save</button> <button class="linklike" data-act="rep-cancel">Cancel</button><span id="loot-rep-err" class="loot-error"></span></div></div>';
    }
    return '<div class="loot-buyer"><div><b>' + esc(r.vendorName) + '</b> <span class="loot-meta">' + esc(r.zone) + '</span></div><div class="loot-meta"><b>' + esc(coin(r.unitPrice)) + '</b> each · ' +
      esc(when(r.ts)) + (r.src === 'manual' ? ' · typed in' : '') + '<br><button class="linklike" data-act="rep-edit" data-id="' + esc(r.id) + '">Edit price</button> · <button class="linklike" data-act="rep-del" data-id="' + esc(r.id) + '">Delete</button></div></div>';
  }

  async function onDetailClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !selected) return;
    const act = btn.dataset.act;
    if (act === 'z-here') { zoneMode = 'here'; return renderDetail(); }
    if (act === 'z-all') { zoneMode = 'all'; return renderDetail(); }
    if (act === 'add-for') return openForm(selected);
    if (act === 'cat-edit') { editingTags = true; return renderDetail(); }
    if (act === 'cat-cancel') { editingTags = false; return renderDetail(); }
    if (act === 'cat-save' || act === 'cat-reset') {
      const tags = act === 'cat-reset' ? null : [...el('loot-detail').querySelectorAll('.loot-tags input:checked')].map((c) => c.value);
      const r = await window.mapAPI.itemOverride({ key: detail.key, tags });
      if (r.error) { const err = el('loot-cat-err'); if (err) err.textContent = ' ' + r.error; return; }
      editingTags = false;
      return loadDetail();
    }
    if (act === 'rep-edit') { editingReport = btn.dataset.id; return renderDetail(); }
    if (act === 'rep-cancel') { editingReport = null; return renderDetail(); }
    if (act === 'rep-save') {
      const price = parseCoin(el('loot-rep-price').value);
      const r = price >= 1 ? await window.mapAPI.reportEdit({ id: btn.dataset.id, unitPrice: price }) : { error: 'Enter a price like 12c or 1s 5c.' };
      if (r.error) { el('loot-rep-err').textContent = ' ' + r.error; return; }
      editingReport = null;
      return refresh();
    }
    if (act === 'rep-del') {
      if (!confirm('Delete this report? The vendor price you entered will be removed.')) return;
      await window.mapAPI.reportDelete({ id: btn.dataset.id });
      return refresh();
    }
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

  // ---- add a vendor price (item + vendor + price; vendor may be new) ----
  const NEW_VENDOR = '__new__';
  const fv = (id) => el(id).value.trim();
  const showErr = (m) => { el('lf-error').textContent = m || ''; };

  // The item combobox: names you've looted plus every item the wiki knows.
  async function fillItemNames() {
    if (!itemNames) itemNames = (await window.mapAPI.itemNames()) || [];
    const names = new Set([...items.map((i) => i.name), ...itemNames]);
    el('lf-items').innerHTML = [...names].sort().map((n) => '<option value="' + esc(n) + '">').join('');
  }

  // What the app already knows about the chosen item, so the player can check it
  // before adding to or correcting it.
  async function showItemInfo() {
    const name = fv('lf-item');
    const box = el('lf-info');
    if (!name) { box.innerHTML = ''; return; }
    const known = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    const r = await window.mapAPI.lootVendors({ name: known ? known.name : name, id: known ? known.id : '', zone: currentZone });
    if (!r || r.error) { box.textContent = ''; return; }
    const conf = r.buyers.filter((b) => b.how === 'confirmed');
    box.innerHTML = (known ? 'Looted ×' + known.total + '. ' : 'Not looted yet. ') + 'Category: <b>' + (r.tags.length ? r.tags.map(esc).join(', ') : 'none recognised') + '</b>. ' +
      (conf.length ? 'Confirmed: ' + conf.map((b) => esc(b.name) + ' ' + esc(coin(b.price))).join(', ') + '.' : 'No confirmed prices yet.');
  }

  function fillVendorPick(selectId) {
    const opt = (v) => '<option value="' + esc(v.id) + '">' + esc(v.name) + (v.inZone ? '' : ' — ' + esc(v.zone)) + '</option>';
    const here = vendors.filter((v) => v.inZone), elsewhere = vendors.filter((v) => !v.inZone);
    el(selectId).innerHTML = '<option value="">Pick a vendor…</option><option value="' + NEW_VENDOR + '">＋ A vendor that isn\'t listed…</option>' +
      (here.length ? '<optgroup label="Here' + (zoneLabel ? ' — ' + esc(zoneLabel) : '') + '">' + here.map(opt).join('') + '</optgroup>' : '') +
      '<optgroup label="Elsewhere">' + elsewhere.map(opt).join('') + '</optgroup>';
  }

  async function openForm(item) {
    showErr('');
    await fillItemNames();
    el('lf-item').value = item ? item.name : '';
    fillVendorPick('lf-vendor');
    el('lf-zones').innerHTML = [...new Set(vendors.map((v) => v.zone).filter(Boolean))].sort().map((z) => '<option value="' + esc(z) + '">').join('');
    ['lf-price', 'lf-vname', 'lf-vloc', 'lf-vwiki'].forEach((id) => { el(id).value = ''; });
    el('lf-vzone').value = zoneLabel || '';
    el('lf-newvendor').classList.add('hidden');
    el('loot-form-modal').classList.remove('hidden');
    showItemInfo();
    (item ? el('lf-vendor') : el('lf-item')).focus();
  }

  async function saveForm() {
    showErr('');
    let vendorId = el('lf-vendor').value;
    const itemName = fv('lf-item'), priceText = fv('lf-price');
    const price = parseCoin(priceText);
    const wantsVendorOnly = vendorId === NEW_VENDOR && !itemName && !priceText;
    if (!wantsVendorOnly) {
      if (!itemName) return showErr('Pick an item.');
      if (!vendorId) return showErr('Pick a vendor.');
      if (!(price >= 1)) return showErr('Enter what the vendor pays for one, like 12c or 1s 5c.');
    }
    if (vendorId === NEW_VENDOR) {
      const v = await window.mapAPI.vendorAdd({ name: fv('lf-vname'), zone: fv('lf-vzone'), location: fv('lf-vloc'), wikiUrl: fv('lf-vwiki') });
      if (v.error) return showErr(v.error);
      vendorId = v.vendor.id;
    }
    if (!wantsVendorOnly) {
      const known = items.find((i) => i.name.toLowerCase() === itemName.toLowerCase());
      const r = await window.mapAPI.reportAdd({ vendorId, itemName: known ? known.name : itemName, itemId: known ? known.id : '', unitPrice: price });
      if (r.error) return showErr(r.error);
    }
    el('loot-form-modal').classList.add('hidden');
    await loadVendors();
    await refresh();
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
  el('loot-detail').addEventListener('click', onDetailClick);
  el('loot-add').addEventListener('click', () => openForm(selected));
  el('lf-cancel').addEventListener('click', () => el('loot-form-modal').classList.add('hidden'));
  el('lf-save').addEventListener('click', saveForm);
  el('lf-item').addEventListener('change', showItemInfo);
  el('lf-vendor').addEventListener('change', () => el('lf-newvendor').classList.toggle('hidden', el('lf-vendor').value !== NEW_VENDOR));
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
    editingTags = false; editingReport = null;
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
