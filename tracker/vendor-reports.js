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
// State lives in one JSON file: { installId, sessions: [...], reports: [...] }.
// All functions take/return that plain object; only load/save touch the disk.
// ---------------------------------------------------------------

const fs = require('fs');
const crypto = require('crypto');
const { nameKey, zoneKey } = require('./vendor-match');

const newState = () => ({ version: 1, installId: crypto.randomUUID(), sessions: [], reports: [] });

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s.installId) s.installId = crypto.randomUUID();
    s.sessions = s.sessions || [];
    s.reports = s.reports || [];
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
  const s = { id: crypto.randomUUID(), vendorId: vendorId(vendor), vendorName: vendor.name, zone: vendor.zone || '', from: now, to: null };
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

// Per-vendor roll-up of what has been reported for one item: newest price wins,
// with the range across reports so disagreement stays visible.
function reportsForItem(state, itemName, itemId) {
  const key = nameKey(itemName);
  const byVendor = new Map();
  for (const r of state.reports) {
    if (!(itemId && r.itemId === itemId) && nameKey(r.itemName) !== key) continue;
    let g = byVendor.get(r.vendorId);
    if (!g) { g = { vendorId: r.vendorId, vendorName: r.vendorName, zone: r.zone, latest: r, min: r.unitPrice, max: r.unitPrice, count: 0 }; byVendor.set(r.vendorId, g); }
    g.count++;
    g.min = Math.min(g.min, r.unitPrice);
    g.max = Math.max(g.max, r.unitPrice);
    if (r.ts >= g.latest.ts) g.latest = r;
  }
  return [...byVendor.values()].map((g) => ({
    vendorId: g.vendorId, vendorName: g.vendorName, zone: g.zone,
    unitPrice: g.latest.unitPrice, ts: g.latest.ts, count: g.count, min: g.min, max: g.max,
  }));
}

module.exports = { newState, loadState, saveState, vendorId, openSession, startSession, endSession, attributeSales, reportsForItem };
