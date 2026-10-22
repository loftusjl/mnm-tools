// ---------------------------------------------------------------
// Vendor menu entries that need the map: "Highlight on map" when the vendor already has
// a marker, "Place on map" (a pin to drag onto the map) when it does not. Talks to the
// map only through window.mapHooks (app.js) and adds its entries through window.lootMenu
// (loot.js), so neither file knows about the other.
// ---------------------------------------------------------------
(() => {
  if (!window.lootMenu || !window.mapHooks) return;
  const el = (id) => document.getElementById(id);
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

  // The Atlas is its own map: show the vendor there (the Atlas finds it by wiki id or name).
  async function showOnAtlas(v) {
    closePanel();
    showPill(() => {});
    const r = await hooks.showOnAtlas({ zoneName: v.zone, mapId: v.atlas.map, wikiId: v.atlas.wikiId, name: v.name });
    if (r && r.error) { hidePill(); reopen(); }
  }

  window.lootMenu.add((v) => {
    if (!v.atlas) return null;
    return hooks.hasZone(v.zone)
      ? { label: 'Show on Atlas map', icon: 'compass', run: () => showOnAtlas(v) }
      : { label: 'Atlas map', icon: 'compass', disabled: true, title: 'Add or import a map for ' + v.zone + ' first' };
  });

  window.lootMenu.add(async (v) => {
    if (!v.zone) return { label: 'My map', icon: 'pin', disabled: true, title: 'No zone known for this vendor' };
    const found = await hooks.findVendorMarkers(v.name, v.zone);
    if (!found.zone) return { label: 'My map', icon: 'pin', disabled: true, title: 'No map for ' + v.zone + ' yet: add or import one first' };
    return found.markers.length
      ? { label: 'Highlight on my map', icon: 'pin', run: () => highlight(v, found) }
      : { label: 'Place on my map', icon: 'pin', run: () => place(v) };
  });
})();
