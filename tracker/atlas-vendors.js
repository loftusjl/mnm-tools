// ---------------------------------------------------------------
// Vendors from the MnM Atlas (mnmatlas.com) — a community map whose pins include
// ~200 vendors, many the wiki's Merchant pages don't cover yet. The Atlas publishes
// plain JSON (data/maps.json and one markers file per map); this module turns those
// (vendors, plus its notable and quest NPCs, so any NPC can be picked as "who I'm
// selling to") into vendor entries and merges them into the wiki's list. Pure: fetching and caching
// live in main.js.
//
// Atlas pins say who and where, not what they buy: merged vendors keep the wiki's buy
// list; Atlas-only vendors start with none and gain prices through the player's reports.
// ---------------------------------------------------------------

const { vendorKey } = require('../renderer/vendor-markers');
const { zoneKey } = require('./vendor-match');

const ATLAS_URL = 'https://www.mnmatlas.com/';
const NPC_KINDS = ['Vendor', 'Notable NPC', 'Quest NPC'];

// maps: the Atlas's maps.json `maps` array; markersByMap: { <map id>: [marker, ...] }.
function parseAtlasVendors(maps, markersByMap) {
  const out = [];
  for (const map of maps || []) {
    for (const m of (markersByMap && markersByMap[map.id]) || []) {
      if (!m || !NPC_KINDS.includes(m.category) || !m.name) continue;
      out.push({
        npc: m.category !== 'Vendor',
        name: String(m.name).trim(), zone: map.title || map.id, location: String(m.note || '').trim(),
        atlasWiki: /^https?:\/\//.test(m.wiki || '') ? m.wiki : '',
        atlas: { map: map.id, place: m.id, wikiId: m.wikiId || '', level: m.level || '' },
      });
    }
  }
  return out;
}

const atlasId = (a) => 'atlas:' + zoneKey(a.zone) + ':' + vendorKey(a.name);

// wikiVendors: the wiki list (each with an id). Returns the same list with Atlas info
// attached where the Atlas knows the vendor, plus the Atlas-only vendors. A vendor
// matches by name + zone; failing that, by name alone when that name is unique on both
// sides (zone names differ a little between the sources).
function mergeAtlas(wikiVendors, atlasList) {
  const key = (v) => zoneKey(v.zone) + '|' + vendorKey(v.name);
  const count = (list) => list.reduce((m, v) => m.set(vendorKey(v.name), (m.get(vendorKey(v.name)) || 0) + 1), new Map());
  const wikiNames = count(wikiVendors), atlasNames = count(atlasList);
  const byKey = new Map(wikiVendors.map((v) => [key(v), v]));
  const byName = new Map(wikiVendors.map((v) => [vendorKey(v.name), v]));
  const hit = new Map();   // wiki vendor id -> Atlas entry
  const only = [];
  for (const a of atlasList) {
    const k = vendorKey(a.name);
    const w = byKey.get(key(a)) || (wikiNames.get(k) === 1 && atlasNames.get(k) === 1 ? byName.get(k) : null);
    if (w && !hit.has(w.id)) hit.set(w.id, a);
    else if (!w) only.push(a);
  }
  const merged = wikiVendors.map((v) => {
    const a = hit.get(v.id);
    return a ? Object.assign({}, v, { atlas: a.atlas, atlasWiki: a.atlasWiki, location: v.location || a.location }) : v;
  });
  const seen = new Set();
  for (const a of only) {
    const id = atlasId(a);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({ id, name: a.name, zone: a.zone, location: a.location, atlas: a.atlas, atlasWiki: a.atlasWiki, npc: !!a.npc, buys: [], source: 'atlas' });
  }
  return merged;
}

module.exports = { ATLAS_URL, parseAtlasVendors, mergeAtlas, atlasId };
