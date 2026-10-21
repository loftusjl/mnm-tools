// ---------------------------------------------------------------
// Vendor menu entries that need the map: "Highlight on map" when the vendor already has
// a marker, "Place on map" (a pin to drag onto the map) when it does not. Talks to the
// map only through window.mapHooks (app.js) and adds its entries through window.lootMenu
// (loot.js), so neither file knows about the other.
// ---------------------------------------------------------------
(() => {
  if (!window.lootMenu || !window.mapHooks) return;
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hooks = window.mapHooks;

  // The panel is hidden while you look at the map; this pill brings it back (your
  // selection is kept) and ends whatever the map was doing.
  let pill = null, onBack = null;
  function showPill(back) {
    hidePill();
    onBack = back;
    pill = document.createElement('button');
    pill.id = 'loot-back';
    pill.textContent = '← Back to Loot & Vendors';
    pill.addEventListener('click', () => { const b = onBack; hidePill(); if (b) b(); reopen(); });
    document.body.appendChild(pill);
  }
  function hidePill() { if (pill) pill.remove(); pill = null; onBack = null; }
  const reopen = () => { hidePill(); el('btn-loot').click(); };
  el('btn-loot').addEventListener('click', hidePill);

  const closePanel = () => el('loot-close').click();

  async function highlight(v, found) {
    closePanel();
    showPill(() => hooks.stopHighlight());
    await hooks.showMarkers(v.zone, found.markers);
  }

  async function place(v) {
    closePanel();
    // Saved or cancelled, the panel comes back on the same vendor.
    const r = await hooks.startPlacement({
      name: v.name.replace(/\s*\(.*\)\s*$/, ''), zoneName: v.zone,
      notes: [v.location, v.wiki && v.wiki.kind !== 'search' ? v.wiki.url : ''].filter(Boolean).join('\n'),
      onDone: reopen,
    });
    if (r && r.error) { reopen(); return; }
    showPill(() => hooks.cancelPlacement(true));
  }

  window.lootMenu.add(async (v) => {
    if (!v.zone) return { disabled: true, html: '<span>No zone known for this vendor</span>' };
    const found = await hooks.findVendorMarkers(v.name, v.zone);
    if (!found.zone) return { disabled: true, html: '<span title="Add or import a map for this zone first">No map for ' + esc(v.zone) + ' yet</span>' };
    return found.markers.length
      ? { html: 'Highlight on map', run: () => highlight(v, found) }
      : { html: 'Place on map', run: () => place(v) };
  });
})();
