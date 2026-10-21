// ---------------------------------------------------------------
// Loot index — every distinct item you have looted, across all characters.
//
// Built fresh from the Ledger files each call (nothing is stored). Items are
// keyed by the game's item id (`d05`), falling back to the name for rows that
// lack one; vendor sales carry no id, so they join their item by name.
//
// Pure Node (no Electron), so it can be unit-tested with fixture ledgers.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const lp = require('./ledger-parser');

const charOf = (f) => { const m = path.basename(f).match(/^(.+?)_(?:Character|Social)_/); return m ? m[1] : 'Unknown'; };
const zoneOf = (ev) => {
  const raw = lp.decodeName((ev.f05 || '').replace(/^zone_/, ''));
  return raw ? lp.zoneName(raw) : '';
};

// Read one ledger into { loots, sales } (chronology is sorted by the caller).
function readEvents(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { loots: [], sales: [] }; }
  const character = charOf(file);
  const loots = [], sales = [];
  for (const ev of data.c01 || []) {
    const t = Date.parse(ev.f04);
    if (!t) continue;
    let p = {};
    try { p = JSON.parse(ev.f03 || '{}'); } catch {}
    if (ev.f01 === 'act_13') {
      const name = lp.cleanItemName(p.d04);
      if (!lp.isClean(name) || !name) continue;
      loots.push({ t, character, name, id: p.d05 || '', qty: p.d01 || 1, source: lp.decodeName(p.d02), zone: zoneOf(ev) });
    } else if (ev.f01 === 'act_24') {
      const name = lp.cleanItemName(p.d04 || ev.f02);
      if (!lp.isClean(name) || !name) continue;
      const qty = p.d01 || 1;
      const total = lp.priceToCopper(lp.b64(p.d03));
      sales.push({ t, character, name, qty, unit: Math.max(1, Math.round(total / qty)), zone: zoneOf(ev), evKey: ev.f04 + '|' + name + '|' + total });
    }
  }
  return { loots, sales };
}

// opts.files   ledger files to read (default: every Character ledger found)
// opts.recent  how many of the newest loot events to return for the feed
function buildLootIndex(files, opts = {}) {
  const recentMax = opts.recent == null ? 100 : opts.recent;
  const loots = [], sales = [];
  const characters = new Set();
  for (const f of files) {
    if (!/_Character_/i.test(f)) continue; // the Social ledger is other players' activity
    const r = readEvents(f);
    characters.add(charOf(f));
    loots.push(...r.loots);
    sales.push(...r.sales);
  }
  loots.sort((a, b) => a.t - b.t);
  sales.sort((a, b) => a.t - b.t);

  const items = new Map();   // key -> entry
  const idByName = new Map(); // so id-less rows (sales, old loot) land on the right entry
  for (const l of loots) if (l.id) idByName.set(l.name, l.id);
  const keyOf = (name, id) => id || idByName.get(name) || 'name:' + name;
  const entry = (name, id) => {
    const key = keyOf(name, id);
    let e = items.get(key);
    if (!e) {
      e = { key, id: id || idByName.get(name) || '', name, total: 0, byCharacter: {}, sources: {}, zones: {}, firstSeen: 0, lastSeen: 0, sales: { count: 0, lastUnit: 0, lastAt: 0, units: {} } };
      items.set(key, e);
    }
    return e;
  };
  const bump = (o, k, n) => { if (k) o[k] = (o[k] || 0) + n; };

  for (const l of loots) {
    const e = entry(l.name, l.id);
    e.total += l.qty;
    bump(e.byCharacter, l.character, l.qty);
    bump(e.sources, l.source, l.qty);
    bump(e.zones, l.zone, l.qty);
    e.firstSeen = e.firstSeen || l.t;
    e.lastSeen = Math.max(e.lastSeen, l.t);
  }
  // Sales only enrich an item you have looted; selling something bought or crafted
  // doesn't add to the "loot" list.
  for (const s of sales) {
    const e = items.get(keyOf(s.name, ''));
    if (!e) continue;
    e.sales.count += s.qty;
    bump(e.sales.units, s.unit, s.qty);
    if (s.t >= e.sales.lastAt) { e.sales.lastAt = s.t; e.sales.lastUnit = s.unit; }
  }

  for (const s of sales) s.id = idByName.get(s.name) || ''; // so reports can name the item id
  const list = [...items.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  const recent = loots.slice(-recentMax).reverse().map((l) => ({
    t: l.t, character: l.character, name: l.name, key: keyOf(l.name, l.id), qty: l.qty, source: l.source, zone: l.zone,
  }));
  return { items: list, recent, characters: [...characters].sort(), sales };
}

module.exports = { buildLootIndex, readEvents };
