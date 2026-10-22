// ---------------------------------------------------------------
// Vendor reports — "vendor X bought item Y for Z".
//
// The ledger records every vendor sale (item + price) but not WHICH vendor. In
// "current vendor" mode the player tells the app who they are selling to; every
// sale the ledger logs while that session is open is then attributed to it.
//
// Reports are stored locally in a sync-ready shape (stable ids, revisions, an
// anonymous per-install author id, reserved vote/sync fields) so a shared service
// can be added later without rewriting the data. Nothing here talks to a network.
//
// Besides ledger-attributed sales, the player can add reports by hand, create
// vendors the wiki doesn't know (or add a wiki link to ones it does), and correct
// an item's category. Every one of those is an append-only revision: an edit adds
// a new revision of the same id, a delete adds a tombstone. Nothing is overwritten.
//
// State lives in one JSON file:
//   { installId, sessions, reports, vendors, itemOverrides }
// All functions take/return that plain object; only load/save touch the disk.
// ---------------------------------------------------------------

const fs = require('fs');
const crypto = require('crypto');
const { nameKey, zoneKey, LABELS } = require('./vendor-match');

const newState = () => ({ version: 2, installId: crypto.randomUUID(), sessions: [], reports: [], vendors: [], itemOverrides: [] });

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s.installId) s.installId = crypto.randomUUID();
    s.sessions = s.sessions || [];
    s.reports = s.reports || [];
    s.vendors = s.vendors || [];            // added in v2; v1 files simply lack them
    s.itemOverrides = s.itemOverrides || [];
    return s;
  } catch { return newState(); }
}

function saveState(file, state) {
  // Write-then-rename so a crash mid-write can't leave a half-written reports file.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// Stable vendor id. Wiki vendors are identified by name + zone; names repeat across
// zones ("A cook"), so the zone is part of the id.
const vendorId = (v) => 'wiki:' + zoneKey(v.zone) + ':' + nameKey(v.name);

const openSession = (state) => state.sessions.find((s) => s.to == null) || null;

function endSession(state, now) {
  const open = openSession(state);
  if (open) open.to = now;
  return open;
}

// Begin selling to `vendor`. Any session already open is closed first.
function startSession(state, vendor, now) {
  endSession(state, now);
  const s = { id: crypto.randomUUID(), vendorId: vendor.id || vendorId(vendor), vendorName: vendor.name, zone: vendor.zone || '', from: now, to: null };
  state.sessions.push(s);
  return s;
}

// Turn ledger sales into reports for whichever session was open at the sale's
// own timestamp (the ledger flushes late, so "when it was logged" is not "when it
// happened"). Already-recorded sales are skipped. Returns how many were added.
function attributeSales(state, sales) {
  if (!state.sessions.length) return 0;
  const seen = new Set(state.reports.map((r) => r.evKey).filter(Boolean));
  let added = 0;
  for (const s of sales) {
    const evKey = s.character + '|' + s.evKey;
    if (seen.has(evKey)) continue;
    const session = state.sessions.find((x) => s.t >= x.from && (x.to == null || s.t <= x.to));
    if (!session) continue;
    seen.add(evKey);
    state.reports.push({
      id: crypto.randomUUID(),
      rev: 1,
      vendorId: session.vendorId,
      vendorName: session.vendorName,
      zone: session.zone,
      itemId: s.id || '',
      itemName: s.name,
      unitPrice: s.unit,        // copper per single item
      qty: s.qty,
      ts: s.t,
      author: state.installId,  // random per install: never the character name
      src: 'ledger-sale',
      evKey,
      votes: { up: 0, down: 0 },
      sync: { state: 'local' },
    });
    added++;
  }
  return added;
}

// Every live report about one item (matched by game id, else by name).
function reportsOfItem(state, itemName, itemId) {
  const key = nameKey(itemName);
  return currentReports(state).filter((r) => (itemId && r.itemId === itemId) || nameKey(r.itemName) === key);
}

// Per-vendor verdicts on one item, newest report wins: a later price turns a refusal
// back into a buyer, a later "doesn't buy" hides earlier prices. Buyers carry the
// price roll-up (newest price, range across their price reports); refusals carry the
// price they replaced, so the disagreement stays visible.
function verdictsForItem(state, itemName, itemId) {
  const byVendor = new Map();
  for (const r of reportsOfItem(state, itemName, itemId)) {
    let g = byVendor.get(r.vendorId);
    if (!g) { g = { vendorId: r.vendorId, vendorName: r.vendorName, zone: r.zone, latest: r, prices: [] }; byVendor.set(r.vendorId, g); }
    if (r.kind !== 'refuses') g.prices.push(r);
    if (r.ts >= g.latest.ts) g.latest = r;
  }
  const buyers = [], refused = [];
  for (const g of byVendor.values()) {
    const last = g.prices.reduce((m, r) => (!m || r.ts >= m.ts ? r : m), null);
    const lo = g.prices.reduce((m, r) => Math.min(m, r.unitPrice), Infinity);
    const hi = g.prices.reduce((m, r) => Math.max(m, r.unitPrice), 0);
    if (g.latest.kind === 'refuses') {
      refused.push({ id: g.latest.id, vendorId: g.vendorId, vendorName: g.vendorName, zone: g.zone, ts: g.latest.ts, mine: g.latest.author === state.installId, was: last ? last.unitPrice : 0 });
    } else {
      buyers.push({ vendorId: g.vendorId, vendorName: g.vendorName, zone: g.zone, unitPrice: last.unitPrice, ts: last.ts, count: g.prices.length, min: lo, max: hi });
    }
  }
  return { buyers, refused };
}
const reportsForItem = (state, itemName, itemId) => verdictsForItem(state, itemName, itemId).buyers;

// ---- revisions ----------------------------------------------------------

// The live version of every revisioned record: highest rev per id, tombstones dropped.
function latestRevisions(list) {
  const best = new Map();
  for (const r of list) {
    const cur = best.get(r.id);
    if (!cur || r.rev > cur.rev) best.set(r.id, r);
  }
  return [...best.values()];
}
const currentReports = (state) => latestRevisions(state.reports).filter((r) => !r.deleted);

// ---- manual reports -----------------------------------------------------

// A player-entered report: "this vendor buys this item for this much (copper each)".
function addReport(state, { vendorId: vid, vendorName, zone, itemId, itemName, unitPrice }, now) {
  const price = Math.round(Number(unitPrice));
  if (!vid || !vendorName) throw new Error('Pick a vendor.');
  if (!itemName || !String(itemName).trim()) throw new Error('Pick an item.');
  if (!(price >= 1)) throw new Error('Enter what the vendor pays (at least 1 copper).');
  const r = {
    id: crypto.randomUUID(), rev: 1, vendorId: vid, vendorName, zone: zone || '',
    itemId: itemId || '', itemName: String(itemName).trim(), unitPrice: price, qty: 1, ts: now,
    author: state.installId, src: 'manual', evKey: '', votes: { up: 0, down: 0 }, sync: { state: 'local' },
  };
  state.reports.push(r);
  return r;
}

// "This vendor does not buy this item": no price, one live refusal per vendor+item
// (asking again returns the existing one). Undo = deleteReport on it.
function addRefusal(state, { vendorId: vid, vendorName, zone, itemId, itemName }, now) {
  if (!vid || !vendorName) throw new Error('Pick a vendor.');
  if (!itemName || !String(itemName).trim()) throw new Error('Pick an item.');
  const mine = reportsOfItem(state, itemName, itemId).filter((r) => r.vendorId === vid && r.author === state.installId);
  const newest = mine.reduce((m, r) => (!m || r.ts >= m.ts ? r : m), null);
  if (newest && newest.kind === 'refuses') return newest;
  const r = {
    id: crypto.randomUUID(), rev: 1, kind: 'refuses', vendorId: vid, vendorName, zone: zone || '',
    itemId: itemId || '', itemName: String(itemName).trim(), unitPrice: 0, qty: 0, ts: now,
    author: state.installId, src: 'manual', evKey: '', votes: { up: 0, down: 0 }, sync: { state: 'local' },
  };
  state.reports.push(r);
  return r;
}

// Only your own reports can be edited or deleted (a shared service would enforce the
// same rule); both add a new revision and leave the earlier ones in place.
function ownReport(state, id) {
  const cur = latestRevisions(state.reports).find((r) => r.id === id);
  if (!cur || cur.deleted) throw new Error('That report no longer exists.');
  if (cur.author !== state.installId) throw new Error('You can only change your own reports.');
  return cur;
}
function reviseReport(state, id, unitPrice, now) {
  const cur = ownReport(state, id);
  if (cur.kind === 'refuses') throw new Error('A "doesn\'t buy" report has no price to edit.');
  const price = Math.round(Number(unitPrice));
  if (!(price >= 1)) throw new Error('Enter what the vendor pays (at least 1 copper).');
  const r = Object.assign({}, cur, { rev: cur.rev + 1, unitPrice: price, ts: now, votes: { up: 0, down: 0 } });
  state.reports.push(r);
  return r;
}
function deleteReport(state, id, now) {
  const cur = ownReport(state, id);
  const r = Object.assign({}, cur, { rev: cur.rev + 1, deleted: true, ts: now });
  state.reports.push(r);
  return r;
}

// ---- vendors ------------------------------------------------------------

// A link to the vendor's wiki page. Only http(s) is accepted: it is shown as a link.
function cleanWikiUrl(url) {
  const t = String(url || '').trim();
  if (!t) return '';
  let u;
  try { u = new URL(t); } catch { throw new Error('That wiki link is not a valid address.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The wiki link must start with https://');
  return u.href;
}

// Where to read about a vendor. A link the player saved wins, then the Atlas's own link;
// a wiki vendor's page is
// named after the vendor (the vendor list already carries disambiguators such as
// "A fisherman (Faelindral)"); a vendor only the player knows falls back to a wiki
// search. Returns { url, kind: 'saved' | 'page' | 'search' }.
const WIKI_BASE = 'https://monstersandmemories.miraheze.org/';
function wikiLink(vendor) {
  if (vendor.wikiUrl) return { url: vendor.wikiUrl, kind: 'saved' };
  if (vendor.atlasWiki) return { url: vendor.atlasWiki, kind: 'page' };
  const name = String(vendor.name || '').trim();
  if (vendor.source === 'local' || vendor.source === 'atlas' || !name) {
    return { url: WIKI_BASE + 'w/index.php?title=Special:Search&go=Go&search=' + encodeURIComponent(name), kind: 'search' };
  }
  const title = (name[0].toUpperCase() + name.slice(1)).replace(/ /g, '_');
  const path = encodeURIComponent(title).replace(/%28/g, '(').replace(/%29/g, ')').replace(/%27/g, "'");
  return { url: WIKI_BASE + 'wiki/' + path, kind: 'page' };
}

// Create a vendor, or - when the wiki already lists one with the same name and zone -
// save the player's link/location as an overlay on it (same id, so reports line up).
// `wikiIds` is the set of wiki vendor ids. Returns { vendor, overlay }.
function addVendor(state, { name, zone, location, wikiUrl }, wikiIds, now) {
  const nm = String(name || '').trim(), zn = String(zone || '').trim();
  if (!nm) throw new Error('Give the vendor a name.');
  if (!zn) throw new Error('Say which zone the vendor is in.');
  const overlay = wikiIds.has(vendorId({ name: nm, zone: zn }));
  const id = overlay ? vendorId({ name: nm, zone: zn }) : 'local:' + zoneKey(zn) + ':' + nameKey(nm);
  const prev = latestRevisions(state.vendors).find((v) => v.id === id);
  const v = {
    id, rev: prev ? prev.rev + 1 : 1, name: nm, zone: zn, location: String(location || '').trim(),
    wikiUrl: cleanWikiUrl(wikiUrl), ts: now, author: state.installId, sync: { state: 'local' },
  };
  state.vendors.push(v);
  return { vendor: v, overlay };
}

// Correct who a listed vendor really is ("the Atlas says Traven Keldress, it is Quartermaster
// Llarne"). Only a local overlay: the id, zone, location and Atlas link are unchanged, and
// the source data is never touched. `base` is the vendor as currently listed (wiki/Atlas).
function renameVendor(state, base, name, now) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Give the vendor a name.');
  const prev = latestRevisions(state.vendors).find((v) => v.id === base.id);
  const v = {
    id: base.id, rev: prev ? prev.rev + 1 : 1, name: nm, zone: (prev && prev.zone) || base.zone || '',
    location: prev ? prev.location : '', wikiUrl: prev ? prev.wikiUrl : '', ts: now, author: state.installId, sync: { state: 'local' },
  };
  state.vendors.push(v);
  return v;
}

// The wiki's vendors with the player's overlays applied, plus the vendors only the
// player knows. Local-only vendors have no "buys" list: they appear through reports.
function mergeVendors(wikiVendors, state) {
  const local = new Map(latestRevisions(state.vendors).map((v) => [v.id, v]));
  const out = wikiVendors.map((w) => {
    const o = local.get(w.id);
    if (!o) return w;
    local.delete(w.id);
    // A rename keeps the vendor's id (so reports line up) and remembers who the source called them.
    const renamed = o.name && nameKey(o.name) !== nameKey(w.name);   // a link saved under "a cook" is not a rename of "A cook"
    return Object.assign({}, w, { name: renamed ? o.name : w.name, wikiUrl: o.wikiUrl || w.wikiUrl || '', location: o.location || w.location, edited: true }, renamed ? { listedAs: w.name } : {});
  });
  for (const v of local.values()) out.push({ id: v.id, name: v.name, zone: v.zone, location: v.location, wikiUrl: v.wikiUrl, buys: [], source: 'local' });
  return out;
}

// ---- item category overrides --------------------------------------------

// Replace the automatic category of one item (key = the loot index's item key).
// tags: array of tag ids, or null to go back to the automatic category.
function setItemOverride(state, key, tags, now) {
  if (!key) throw new Error('Unknown item.');
  const clean = tags == null ? null : [...new Set(tags)].filter((t) => LABELS[t]);
  if (clean && !clean.length) throw new Error('Pick at least one category, or reset to automatic.');
  const prev = state.itemOverrides.filter((o) => o.key === key).reduce((m, o) => Math.max(m, o.rev), 0);
  const o = { id: key, key, rev: prev + 1, tags: clean, ts: now, author: state.installId, sync: { state: 'local' } };
  state.itemOverrides.push(o);
  return o;
}
// The tags the player set for an item, or null when it is automatic.
function overrideFor(state, key) {
  const cur = latestRevisions(state.itemOverrides).find((o) => o.key === key);
  return cur && cur.tags ? cur.tags : null;
}

module.exports = {
  currentReports, reportsOfItem, addReport, addRefusal, renameVendor, verdictsForItem, wikiLink, reviseReport, deleteReport, cleanWikiUrl, addVendor, mergeVendors, setItemOverride, overrideFor, newState, loadState, saveState, vendorId, openSession, startSession, endSession, attributeSales, reportsForItem };
