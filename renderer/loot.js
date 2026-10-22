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
  let sources = null;           // where the vendor list comes from (wiki + Atlas)
  let startAfterAdd = false;    // the add-vendor form was opened from the selling bar: start selling once it is saved
  let sellPick = '';            // vendor to preselect in the selling picker (e.g. one just added)
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
    sources = await window.mapAPI.vendorSources();
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

  // The vendor's name opens a small action menu (see openMenu).
  const vendorName = (b) => '<button class="linklike loot-vname" data-act="vmenu" data-vid="' + esc(b.vendorId) + '" title="Actions for this vendor"><b>' + esc(b.name) + '</b></button>';

  function buyerRow(b) {
    const [label, cls] = HOW[b.how] || ['', ''];
    let note = '';
    if (b.how === 'confirmed') {
      note = '<b>' + esc(coin(b.price)) + '</b> each · ' + b.reports + ' report' + (b.reports > 1 ? 's' : '') +
        (b.min !== b.max ? ' (' + esc(coin(b.min)) + '–' + esc(coin(b.max)) + ')' : '') + ' · ' + esc(when(b.ts));
    } else if (b.how === 'category') note = 'buys ' + esc(b.tag || b.via);
    else if (b.how === 'exact') note = 'lists it by name';
    const wiki = ' <a class="loot-wiki" href="' + esc(b.wiki.url) + '" target="_blank" rel="noopener" title="' + (b.wiki.kind === 'search' ? 'Search the wiki for this vendor' : 'Open the wiki page') + '">' + (b.wiki.kind === 'search' ? 'search wiki' : 'wiki') + ' ↗</a>';
    // Only guesses can be wrong about a vendor; a confirmed price is the player's own evidence.
    const no = b.how === 'confirmed' ? '' : ' <button class="linklike loot-no" data-act="refuse" data-vid="' + esc(b.vendorId) + '" title="Hide this guess: this vendor does not buy it">✕ doesn\'t buy</button>';
    return '<div class="loot-buyer"><div><span class="loot-badge ' + cls + '">' + esc(label) + '</span> ' + vendorName(b) +
      (b.local ? ' <span class="loot-badge" title="A vendor you added">yours</span>' : '') +
      (b.fromAtlas ? ' <span class="loot-badge" title="Listed on the MnM Atlas; the wiki has no buy list for them, so prices come from your reports">Atlas</span>' : '') + wiki + no + '</div>' +
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
      const no = (detail.refused || []).filter((b) => !here || b.inZone);
      if (no.length) {
        html += '<details class="loot-refused"><summary>Doesn\'t buy (reported) — ' + no.length + '</summary>' + no.map((b) =>
          '<div class="loot-buyer"><div>' + vendorName(b) + ' <span class="loot-meta">' + esc(b.zone) + '</span></div><div class="loot-meta">Reported ' + esc(when(b.ts)) +
          (b.was ? ' · you had a price of ' + esc(coin(b.was)) : '') + (b.mine ? ' · <button class="linklike" data-act="undo-refuse" data-id="' + esc(b.reportId) + '">Undo</button>' : '') + '</div></div>').join('') + '</details>';
      }
      if (detail.mine && detail.mine.length) html += '<div class="replay-col-title">Your reports</div>' + detail.mine.map(myReportHtml).join('');
      html += '<div class="loot-meta loot-foot">“Likely” means the wiki says this vendor buys that kind of item. Vendors come from the wiki\'s Merchant pages' +
        (sources && sources.atlasCount ? ' and ' + sources.atlasCount + ' pins on the MnM Atlas (updated ' + esc(new Date(sources.atlasAt).toLocaleDateString()) + ')' : '') + '.</div>';
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
    if (r.kind === 'refuses') {
      return '<div class="loot-buyer"><div><b>' + esc(r.vendorName) + '</b> <span class="loot-meta">' + esc(r.zone) + '</span></div><div class="loot-meta">Doesn\'t buy this · ' +
        esc(when(r.ts)) + '<br><button class="linklike" data-act="undo-refuse" data-id="' + esc(r.id) + '">Undo</button></div></div>';
    }
    if (editingReport === r.id) {
      return '<div class="loot-buyer"><div><b>' + esc(r.vendorName) + '</b></div><div><input class="loot-price" id="loot-rep-price" value="' + esc(coin(r.unitPrice)) + '" size="12"> ' +
        '<button class="secondary" data-act="rep-save" data-id="' + esc(r.id) + '">Save</button> <button class="linklike" data-act="rep-cancel">Cancel</button><span id="loot-rep-err" class="loot-error"></span></div></div>';
    }
    return '<div class="loot-buyer"><div><b>' + esc(r.vendorName) + '</b> <span class="loot-meta">' + esc(r.zone) + '</span></div><div class="loot-meta"><b>' + esc(coin(r.unitPrice)) + '</b> each · ' +
      esc(when(r.ts)) + (r.src === 'manual' ? ' · typed in' : '') + '<br><button class="linklike" data-act="rep-edit" data-id="' + esc(r.id) + '">Edit price</button> · <button class="linklike" data-act="rep-del" data-id="' + esc(r.id) + '">Delete</button></div></div>';
  }

  // ---- vendor action menu ----
  // One floating menu shared by every vendor name. Other features add their own
  // entries through addMenuAction, so this file stays free of their code.
  const menuActions = [];
  const menu = document.createElement('div');
  menu.className = 'loot-menu hidden';
  document.body.appendChild(menu);
  const closeMenu = () => menu.classList.add('hidden');

  function vendorOf(id) {
    const rows = [...(detail ? detail.buyers.concat(detail.refused || []) : []), ...vendors];
    return rows.find((b) => (b.vendorId || b.id) === id) || null;
  }

  // The vendor card reuses the Atlas marker popup's markup and class names (see the
  // "Vendor card" block in styles.css): tag, h3, marker-who, npc-card, popup-actions.
  // An action is { label, icon, run?, disabled?, danger?, title? }; it may also be a promise
  // of one (the map lookup is async), shown as "…" until it settles.
  const ICONS = {
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
    x: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  };
  const icon = (n) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';

  let menuToken = 0, menuRuns = [];
  function actionHtml(e) {
    if (!e) return '';
    const inner = icon(e.icon) + '<span>' + esc(e.label) + '</span>';
    if (e.disabled) return '<button disabled title="' + esc(e.title || '') + '">' + inner + '</button>';
    return '<button' + (e.danger ? ' class="popup-delete"' : '') + ' data-run="' + (menuRuns.push(e.run) - 1) + '">' + inner + '</button>';
  }

  // What we know about the vendor, as the Atlas's NPC card lays it out (small-caps line, then label/value rows).
  const list = (a, n) => (a.length > n ? a.slice(0, n).join(', ') + ' … +' + (a.length - n) + ' more' : a.join(', '));
  function cardHead(v, withActions) {
    const kicker = v.npc ? 'NPC' : v.local ? 'Your vendor' : 'Vendor';
    const who = sameRole(v) ? v.role : '';
    const rows = [['Zone', v.zone], ['Location', v.location], ['Race', v.race], ['Buys', list(v.buys || [], 6)], ['Sells', list(v.sells || [], 6)]].filter((r) => r[1]);
    const source = v.local ? 'Added by you' : v.fromAtlas ? 'From the MnM Atlas · community contribution' : v.atlas ? 'From the wiki, also on the MnM Atlas' : 'From the wiki';
    return '<div class="tag">' + esc(kicker) + '</div><h3>' + esc(v.name) + '</h3>' + (who ? '<div class="marker-who">' + esc(who) + '</div>' : '') +
      '<div class="popup-body">' + (v.listedAs ? '<div class="moved-note">Listed as “' + esc(v.listedAs) + '”</div>' : '') +
      '<a class="wiki-link" href="' + esc(v.wiki.url) + '" target="_blank" rel="noopener">' + (v.wiki.kind === 'search' ? 'Search the wiki' : 'Wiki page') + ' ↗</a>' +
      '<div class="community-note">' + esc(source) + '</div></div>' +
      (rows.length ? '<div class="npc-card"><dl>' + rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl></div>' : '');
  }

  function placeMenu(anchor) {
    menu.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }

  function openMenu(anchor) {
    const v = vendorOf(anchor.dataset.vid);
    if (!v) return;
    const token = ++menuToken;
    menuRuns = [];
    const refusal = detail && (detail.refused || []).find((b) => b.vendorId === v.vendorId && b.mine);
    const actions = [];
    for (const a of menuActions) { try { actions.push(a(v)); } catch {} }
    if (selected && v.how !== 'confirmed') {
      actions.push(refusal
        ? { label: 'Undo “doesn\'t buy”', icon: 'undo', run: async () => { await window.mapAPI.reportDelete({ id: refusal.reportId }); await refresh(); } }
        : v.how ? { label: 'Doesn\'t buy ' + selected.name, icon: 'x', danger: true, run: () => refuse(v.vendorId) } : null);
    }
    if (!v.local) actions.push({ label: 'Not who this is? Rename…', icon: 'edit', run: () => renameEditor(v, anchor) });
    const slots = actions.filter((e) => e !== null && e !== undefined);
    menu.innerHTML = cardHead(v) + '<div class="popup-actions">' + slots.map((e, i) =>
      '<span class="slot" data-slot="' + i + '">' + (typeof e.then === 'function' ? '<button disabled><span>…</span></button>' : actionHtml(e)) + '</span>').join('') + '</div>';
    slots.forEach((e, i) => {
      if (typeof e.then !== 'function') return;
      const fill = (html) => {
        if (token !== menuToken || menu.classList.contains('hidden')) return;
        const slot = menu.querySelector('[data-slot="' + i + '"]');
        if (slot) slot.innerHTML = html;
        placeMenu(anchor);
      };
      e.then((entry) => fill(actionHtml(entry)), () => fill(''));
    });
    placeMenu(anchor);
  }

  // The vendor list can be wrong ("the Atlas says Traven Keldress, it is Quartermaster Llarne").
  // A rename is local: same vendor, same place, your name for them.
  function renameEditor(v, anchor) {
    menuToken++;
    menu.innerHTML = cardHead(v) + '<div class="popup-body rename-form"><label for="loot-rename">Who is this really?</label>' +
      '<input id="loot-rename" value="' + esc(v.name) + '"><div class="moved-note">Only changes it on this computer.</div><span id="loot-rename-err" class="loot-error"></span></div>' +
      '<div class="popup-actions"><button id="loot-rename-go">' + icon('edit') + '<span>Save</span></button></div>';
    placeMenu(anchor);
    const input = el('loot-rename');
    input.focus(); input.select();
    const go = async () => {
      const r = await window.mapAPI.vendorRename({ vendorId: v.vendorId || v.id, name: input.value });
      if (r.error) { el('loot-rename-err').textContent = r.error; return; }
      closeMenu();
      await loadVendors();
      await refresh();
    };
    el('loot-rename-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  // Lets another script add a menu entry: fn(vendor) -> an entry, a promise of one, or null.
  window.lootMenu = { add: (fn) => menuActions.push(fn) };

  async function refuse(vendorId) {
    if (!selected) return;
    const r = await window.mapAPI.reportRefuse({ vendorId, itemName: selected.name, itemId: selected.id });
    if (r && r.error) return;
    return loadDetail();
  }

  menu.addEventListener('click', (e) => {
    const run = e.target.closest('[data-run]');
    if (run) { closeMenu(); return menuRuns[+run.dataset.run](); }
    if (e.target.closest('a')) closeMenu();
  });
  document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target) && !e.target.closest('[data-act="vmenu"]')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  el('loot-detail').addEventListener('scroll', closeMenu);

  async function onDetailClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !selected) return;
    const act = btn.dataset.act;
    if (act === 'vmenu') return openMenu(btn);
    if (act === 'refuse') return refuse(btn.dataset.vid);
    if (act === 'undo-refuse') {
      await window.mapAPI.reportDelete({ id: btn.dataset.id });
      return refresh();
    }
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
    // A combo box: type to filter every known vendor and NPC (wiki, Atlas, yours), pick one,
    // or type a name nobody has listed and add it on the spot. Nearby ones come first.
    const here = vendors.filter((v) => v.inZone), elsewhere = vendors.filter((v) => !v.inZone);
    box.innerHTML = '<label for="loot-sell-pick">Selling to</label>' +
      '<input id="loot-sell-pick" list="loot-sell-list" placeholder="Type a name, or pick one…" autocomplete="off">' +
      '<datalist id="loot-sell-list">' + [...here, ...elsewhere].map((v) => '<option value="' + esc(vendorLabel(v)) + '">' + (v.npc ? 'NPC' : '') + '</option>').join('') + '</datalist>' +
      '<button id="loot-sell-go" class="secondary" disabled>Start</button>' +
      '<button id="loot-sell-rename" class="linklike hidden" title="The list has the wrong name for this vendor">Not who this is? Rename…</button>' +
      '<span class="loot-meta">Type the name of who you\'re standing at, then sell. Your sales are saved as confirmed prices for them. Not listed? Type the name and add it.</span>';
    const pick = el('loot-sell-pick'), go = el('loot-sell-go');
    const sync = () => {
      const text = pick.value.trim();
      go.disabled = !text;
      const hit = resolveVendor(text);
      go.textContent = !text || hit ? 'Start' : 'Add “' + (text.length > 28 ? text.slice(0, 27) + '…' : text) + '” and start';
      el('loot-sell-rename').classList.toggle('hidden', !hit || hit.local);
    };
    if (sellPick) { const v = vendors.find((x) => x.id === sellPick); if (v) pick.value = vendorLabel(v); }
    sellPick = '';
    sync();
    pick.addEventListener('input', sync);
    el('loot-sell-rename').addEventListener('click', () => { const v = resolveVendor(pick.value); if (v) renameEditor(v, el('loot-sell-rename')); });
    pick.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
    go.addEventListener('click', async () => {
      const text = pick.value.trim();
      const v = resolveVendor(text);
      if (!v) { startAfterAdd = true; return openForm(null, true, text.replace(/\s+—\s+.*$/, '')); }   // not listed: add it first
      const r = await window.mapAPI.vendorSession({ action: 'start', vendorId: v.id });
      if (r && !r.error) { session = r; renderSell(); }
    });
  }

  // "Name — Zone" is what the combo shows and inserts, so same-named vendors in different
  // zones ("A cook") can be told apart. A bare name also works when it is unambiguous.
  // The Atlas titles a pin by its role ("Quartermaster") with the NPC's name beneath, so the
  // combo shows both and either one finds it.
  const sameRole = (v) => v.role && !v.name.toLowerCase().includes(v.role.toLowerCase());   // "Quartermaster Llarne" already says it
  const vendorLabel = (v) => (sameRole(v) ? v.role + ' (' + v.name + ')' : v.name) + ' — ' + v.zone;
  function resolveVendor(text) {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const exact = vendors.find((v) => vendorLabel(v).toLowerCase() === t);
    if (exact) return exact;
    const named = vendors.filter((v) => v.name.toLowerCase() === t || (v.role && v.role.toLowerCase() === t));
    return named.find((v) => v.inZone) || (named.length === 1 ? named[0] : null);
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

  async function openForm(item, newVendor, vendorName) {
    showErr('');
    await fillItemNames();
    el('lf-item').value = item ? item.name : '';
    fillVendorPick('lf-vendor');
    el('lf-zones').innerHTML = [...new Set(vendors.map((v) => v.zone).filter(Boolean))].sort().map((z) => '<option value="' + esc(z) + '">').join('');
    ['lf-price', 'lf-vname', 'lf-vloc', 'lf-vwiki'].forEach((id) => { el(id).value = ''; });
    el('lf-vzone').value = zoneLabel || '';
    el('lf-newvendor').classList.add('hidden');
    if (newVendor) { el('lf-vendor').value = NEW_VENDOR; el('lf-newvendor').classList.remove('hidden'); el('lf-vname').value = vendorName || ''; }
    el('loot-form-modal').classList.remove('hidden');
    showItemInfo();
    (newVendor ? el('lf-vname') : item ? el('lf-vendor') : el('lf-item')).focus();
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
      sellPick = vendorId;   // a vendor added from the selling bar is preselected there
      if (startAfterAdd && wantsVendorOnly) await window.mapAPI.vendorSession({ action: 'start', vendorId });
    }
    startAfterAdd = false;
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
  el('lf-cancel').addEventListener('click', () => { startAfterAdd = false; el('loot-form-modal').classList.add('hidden'); });
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
