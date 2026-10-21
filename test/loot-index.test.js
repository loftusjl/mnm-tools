const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildLootIndex } = require('../tracker/loot-index');
const reports = require('../tracker/vendor-reports');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const loot = (t, name, id, source, zone, qty = 1) => ({
  f01: 'act_13', f02: 'ref_1', f04: t, f05: 'zone_' + b64(zone),
  f03: JSON.stringify({ d01: qty, d02: b64(source), d03: '', d04: name, d05: id }),
});
const sale = (t, name, copper, zone, qty = 1) => ({
  f01: 'act_24', f02: name, f04: t, f05: 'zone_' + b64(zone),
  f03: JSON.stringify({ d01: qty, d02: '', d03: b64('0 platinum 0 gold 0 silver ' + copper + ' copper'), d04: name, d05: '' }),
});

// Two characters, one item looted by both, one old-format id-less row, one sale.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnm-loot-'));
  const write = (name, events) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({ c01: events }));
    return p;
  };
  const a = write('Anm_Character_2026-10-14.json', [
    loot('2026-10-14T18:00:00-04:00', 'Rat Tooth', 'aaa', 'a giant rat', 'nightharbor'),
    loot('2026-10-14T18:05:00-04:00', 'Rat Tooth', 'aaa', 'a giant rat', 'nightharbor'),
    loot('2026-10-14T18:06:00-04:00', '6642399|Spider Fang', 'bbb', 'a spider', 'evergrove', 2),
    sale('2026-10-14T18:10:00-04:00', 'Rat Tooth', 6, 'nightharbor'),
    sale('2026-10-14T18:11:00-04:00', 'Bought Thing', 50, 'nightharbor'), // never looted
  ]);
  const b = write('Skrach_Character_2026-10-15.json', [
    loot('2026-10-15T09:00:00-04:00', 'Rat Tooth', 'aaa', 'a giant rat', 'nightharbor'),
    loot('2026-10-15T09:01:00-04:00', 'Old Boots', '', 'a skeleton', 'nightharbor'),
  ]);
  const social = write('Anm_Social_2026-10-14.json', [loot('2026-10-14T18:00:00-04:00', 'Not Mine', 'zzz', 'x', 'y')]);
  return { dir, files: [a, b, social] };
}

test('loot is tabulated into unique items across characters', () => {
  const { files } = fixture();
  const idx = buildLootIndex(files);
  const tooth = idx.items.find((i) => i.name === 'Rat Tooth');
  assert.strictEqual(tooth.total, 3);
  assert.deepStrictEqual(tooth.byCharacter, { Anm: 2, Skrach: 1 });
  assert.deepStrictEqual(tooth.sources, { 'a giant rat': 3 });
  assert.strictEqual(idx.items.filter((i) => i.name === 'Rat Tooth').length, 1);
  assert.deepStrictEqual(idx.characters, ['Anm', 'Skrach']);
});

test('numeric id prefixes are stripped, quantities are summed, and the Social ledger is ignored', () => {
  const idx = buildLootIndex(fixture().files);
  const fang = idx.items.find((i) => i.name === 'Spider Fang');
  assert.strictEqual(fang.total, 2);
  assert.ok(!idx.items.some((i) => i.name === 'Not Mine'));
});

test('items with no game id fall back to a name key', () => {
  const idx = buildLootIndex(fixture().files);
  assert.strictEqual(idx.items.find((i) => i.name === 'Old Boots').key, 'name:Old Boots');
  assert.strictEqual(idx.items.find((i) => i.name === 'Rat Tooth').key, 'aaa');
});

test('sales join their looted item by name and record the per-unit price', () => {
  const idx = buildLootIndex(fixture().files);
  const tooth = idx.items.find((i) => i.name === 'Rat Tooth');
  assert.strictEqual(tooth.sales.lastUnit, 6);
  assert.strictEqual(tooth.sales.count, 1);
  assert.ok(!idx.items.some((i) => i.name === 'Bought Thing'));
});

test('the recent feed is newest-first and capped', () => {
  const idx = buildLootIndex(fixture().files, { recent: 2 });
  assert.strictEqual(idx.recent.length, 2);
  assert.strictEqual(idx.recent[0].name, 'Old Boots');
  assert.ok(idx.recent[0].t > idx.recent[1].t);
});

// ---- vendor reports ----------------------------------------------------

const vendor = { name: 'A cook', zone: 'Night Harbor' };
const T = (s) => Date.parse(s);

test('sales inside a vendor session become reports; others are ignored', () => {
  const idx = buildLootIndex(fixture().files);
  const state = reports.newState();
  reports.startSession(state, vendor, T('2026-10-14T18:09:00-04:00'));
  reports.endSession(state, T('2026-10-14T18:10:30-04:00'));
  const added = reports.attributeSales(state, idx.sales);
  assert.strictEqual(added, 1); // Rat Tooth at 18:10; the 18:11 sale is after the session
  const r = state.reports[0];
  assert.strictEqual(r.itemName, 'Rat Tooth');
  assert.strictEqual(r.itemId, 'aaa');
  assert.strictEqual(r.unitPrice, 6);
  assert.strictEqual(r.vendorName, 'A cook');
  assert.strictEqual(r.author, state.installId);
  assert.deepStrictEqual(r.votes, { up: 0, down: 0 });
});

test('attribution is idempotent: rescanning never duplicates a report', () => {
  const idx = buildLootIndex(fixture().files);
  const state = reports.newState();
  reports.startSession(state, vendor, T('2026-10-14T18:00:00-04:00'));
  assert.strictEqual(reports.attributeSales(state, idx.sales), 2);
  assert.strictEqual(reports.attributeSales(state, idx.sales), 0);
  assert.strictEqual(state.reports.length, 2);
});

test('starting a new session closes the previous one', () => {
  const state = reports.newState();
  const a = reports.startSession(state, vendor, 1000);
  reports.startSession(state, { name: 'A miner', zone: 'Night Harbor' }, 2000);
  assert.strictEqual(a.to, 2000);
  assert.strictEqual(reports.openSession(state).vendorName, 'A miner');
});

test('item roll-up shows the newest price and the range across reports', () => {
  const state = reports.newState();
  const mk = (price, ts) => ({ id: 'r' + ts, rev: 1, vendorId: 'v', vendorName: 'A cook', zone: 'Night Harbor', itemId: 'aaa', itemName: 'Rat Tooth', unitPrice: price, ts });
  state.reports.push(mk(10, 1), mk(12, 3), mk(11, 2));
  const [g] = reports.reportsForItem(state, 'Rat Tooth', 'aaa');
  assert.strictEqual(g.unitPrice, 12);
  assert.deepStrictEqual([g.min, g.max, g.count], [10, 12, 3]);
});

test('state round-trips through disk and survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnm-rep-'));
  const file = path.join(dir, 'vendor-reports.json');
  const state = reports.newState();
  reports.startSession(state, vendor, 5);
  reports.saveState(file, state);
  const again = reports.loadState(file);
  assert.strictEqual(again.installId, state.installId);
  assert.strictEqual(again.sessions.length, 1);
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(reports.loadState(file).reports, []);
});
