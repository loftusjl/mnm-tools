const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../tracker/vendor-reports');
const vm = require('../tracker/vendor-match');

const vendors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'vendors.json'), 'utf8')).vendors;
const wikiVendors = vendors.map((v) => Object.assign({ id: store.vendorId(v) }, v));
const wikiIds = new Set(wikiVendors.map((v) => v.id));
const cook = wikiVendors.find((v) => v.name === 'A cook');

const manual = (state, over = {}) => store.addReport(state, Object.assign(
  { vendorId: cook.id, vendorName: cook.name, zone: cook.zone, itemId: '', itemName: 'Spider Fang', unitPrice: 12 }, over), 1000);

// ---- manual reports ----

test('a manual report is stored in the sync-ready shape', () => {
  const state = store.newState();
  const r = manual(state);
  assert.strictEqual(r.src, 'manual');
  assert.strictEqual(r.rev, 1);
  assert.strictEqual(r.author, state.installId);
  assert.deepStrictEqual(r.votes, { up: 0, down: 0 });
  assert.strictEqual(store.reportsForItem(state, 'Spider Fang')[0].unitPrice, 12);
});

test('manual reports need a vendor, an item and a price of at least 1 copper', () => {
  const state = store.newState();
  assert.throws(() => manual(state, { vendorId: '' }), /vendor/i);
  assert.throws(() => manual(state, { itemName: '  ' }), /item/i);
  assert.throws(() => manual(state, { unitPrice: 0 }), /copper/);
  assert.throws(() => manual(state, { unitPrice: 'abc' }), /copper/);
  assert.strictEqual(state.reports.length, 0);
});

test('editing a report adds a revision and the new price wins', () => {
  const state = store.newState();
  const r = manual(state);
  store.reviseReport(state, r.id, 15, 2000);
  assert.strictEqual(state.reports.length, 2);       // the old revision is kept
  const [g] = store.reportsForItem(state, 'Spider Fang');
  assert.strictEqual(g.unitPrice, 15);
  assert.strictEqual(g.count, 1);                    // two revisions are still one report
});

test('deleting a report is a tombstone: it disappears but is never erased', () => {
  const state = store.newState();
  const r = manual(state);
  store.deleteReport(state, r.id, 2000);
  assert.deepStrictEqual(store.reportsForItem(state, 'Spider Fang'), []);
  assert.strictEqual(state.reports.length, 2);
  assert.throws(() => store.reviseReport(state, r.id, 20, 3000), /no longer exists/);
});

test('someone else\'s report cannot be edited or deleted', () => {
  const state = store.newState();
  const r = manual(state);
  state.reports[0].author = 'another-install';
  assert.throws(() => store.reviseReport(state, r.id, 20, 2000), /your own/);
  assert.throws(() => store.deleteReport(state, r.id, 2000), /your own/);
});

test('a deleted ledger sale is not re-created when the ledger is rescanned', () => {
  const state = store.newState();
  const sales = [{ t: 5000, character: 'Anm', evKey: 'k1', name: 'Rat Tooth', id: 'aaa', qty: 1, unit: 6 }];
  store.startSession(state, cook, 1000);
  assert.strictEqual(store.attributeSales(state, sales), 1);
  store.deleteReport(state, state.reports[0].id, 6000);
  assert.strictEqual(store.attributeSales(state, sales), 0);
  assert.deepStrictEqual(store.currentReports(state), []);
});

// ---- vendors ----

test('a vendor the wiki does not know becomes a local vendor with a stable id', () => {
  const state = store.newState();
  const { vendor, overlay } = store.addVendor(state, { name: 'Alric Mercantile', zone: 'Night Harbor', location: 'Market stall', wikiUrl: 'https://example.org/wiki/Alric' }, wikiIds, 1);
  assert.strictEqual(overlay, false);
  assert.match(vendor.id, /^local:nightharbor:alric mercantile$/);
  const merged = store.mergeVendors(wikiVendors, state);
  const mine = merged.find((v) => v.id === vendor.id);
  assert.deepStrictEqual([mine.source, mine.wikiUrl, mine.location], ['local', 'https://example.org/wiki/Alric', 'Market stall']);
  assert.strictEqual(merged.length, wikiVendors.length + 1);
});

test('adding a vendor the wiki already lists overlays it instead of duplicating', () => {
  const state = store.newState();
  const { vendor, overlay } = store.addVendor(state, { name: 'A cook', zone: 'Night Harbor', wikiUrl: 'https://example.org/wiki/Cook' }, wikiIds, 1);
  assert.strictEqual(overlay, true);
  assert.strictEqual(vendor.id, cook.id);            // same id, so reports line up
  const merged = store.mergeVendors(wikiVendors, state);
  assert.strictEqual(merged.length, wikiVendors.length);
  const c = merged.find((v) => v.id === cook.id);
  assert.strictEqual(c.wikiUrl, 'https://example.org/wiki/Cook');
  assert.deepStrictEqual(c.buys, cook.buys);         // the wiki's buy list is untouched
  assert.strictEqual(c.location, cook.location);     // no location given: the wiki's stays
});

test('re-saving a vendor adds a revision', () => {
  const state = store.newState();
  store.addVendor(state, { name: 'Alric', zone: 'Night Harbor' }, wikiIds, 1);
  store.addVendor(state, { name: 'Alric', zone: 'Night Harbor', location: 'Corner' }, wikiIds, 2);
  assert.strictEqual(state.vendors.length, 2);
  const merged = store.mergeVendors(wikiVendors, state);
  assert.strictEqual(merged.filter((v) => v.source === 'local').length, 1);
  assert.strictEqual(merged.find((v) => v.source === 'local').location, 'Corner');
});

test('vendor name and zone are required, and the wiki link must be http(s)', () => {
  const state = store.newState();
  assert.throws(() => store.addVendor(state, { name: '', zone: 'Night Harbor' }, wikiIds, 1), /name/);
  assert.throws(() => store.addVendor(state, { name: 'X', zone: '' }, wikiIds, 1), /zone/);
  assert.throws(() => store.addVendor(state, { name: 'X', zone: 'Z', wikiUrl: 'javascript:alert(1)' }, wikiIds, 1), /https/);
  assert.throws(() => store.addVendor(state, { name: 'X', zone: 'Z', wikiUrl: 'not a url' }, wikiIds, 1), /valid/);
  assert.strictEqual(store.addVendor(state, { name: 'X', zone: 'Z', wikiUrl: '' }, wikiIds, 1).vendor.wikiUrl, '');
});

test('a confirmed report for a local vendor shows up even though it has no buy list', () => {
  const state = store.newState();
  const { vendor } = store.addVendor(state, { name: 'Alric Mercantile', zone: 'Night Harbor' }, wikiIds, 1);
  store.addReport(state, { vendorId: vendor.id, vendorName: vendor.name, zone: vendor.zone, itemName: 'Spider Fang', unitPrice: 9 }, 5);
  const [g] = store.reportsForItem(state, 'Spider Fang');
  assert.strictEqual(g.vendorId, vendor.id);
});

// ---- item category overrides ----

test('a category override replaces the automatic category in matching', () => {
  const prepared = vendors.map(vm.prepareVendor);
  const auto = vm.vendorsFor('Head of the Overseer', null, prepared).map((m) => m.how);
  assert.ok(auto.length && auto.every((h) => h === 'any'));   // nothing claims it automatically
  const tuned = vm.vendorsFor('Head of the Overseer', null, prepared, ['gems']);
  assert.ok(tuned.some((m) => m.how === 'category' && m.vendor.name === 'A jewelcrafter'));
});

test('overrides are revisions; null resets to automatic; unknown tags are dropped', () => {
  const state = store.newState();
  store.setItemOverride(state, 'aaa', ['gems', 'not-a-tag'], 1);
  assert.deepStrictEqual(store.overrideFor(state, 'aaa'), ['gems']);
  store.setItemOverride(state, 'aaa', ['hides'], 2);
  assert.deepStrictEqual(store.overrideFor(state, 'aaa'), ['hides']);
  store.setItemOverride(state, 'aaa', null, 3);
  assert.strictEqual(store.overrideFor(state, 'aaa'), null);
  assert.strictEqual(state.itemOverrides.length, 3);
  assert.strictEqual(store.overrideFor(state, 'zzz'), null);
  assert.throws(() => store.setItemOverride(state, 'aaa', [], 4), /at least one/);
  assert.throws(() => store.setItemOverride(state, 'aaa', ['nope'], 4), /at least one/);
});

// ---- persistence ----

test('a version-1 file (no vendors or overrides) loads and keeps its reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnm-v1-'));
  const file = path.join(dir, 'vendor-reports.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, installId: 'abc', sessions: [], reports: [{ id: 'r1', rev: 1, vendorId: 'v', vendorName: 'A cook', itemName: 'Rat Tooth', unitPrice: 6, ts: 1 }] }));
  const s = store.loadState(file);
  assert.strictEqual(s.installId, 'abc');
  assert.deepStrictEqual([s.vendors, s.itemOverrides], [[], []]);
  assert.strictEqual(store.reportsForItem(s, 'Rat Tooth').length, 1);
});

// ---- "doesn't buy" reports ----

const refuse = (state, over = {}, now = 2000) => store.addRefusal(state, Object.assign(
  { vendorId: cook.id, vendorName: cook.name, zone: cook.zone, itemName: 'Spider Fang' }, over), now);

test('a refusal hides a vendor from the buyers and is listed with the price it replaced', () => {
  const state = store.newState();
  manual(state);                                   // 12c at t=1000
  refuse(state, {}, 2000);
  const v = store.verdictsForItem(state, 'Spider Fang');
  assert.deepStrictEqual(v.buyers, []);
  assert.strictEqual(v.refused.length, 1);
  assert.deepStrictEqual([v.refused[0].vendorId, v.refused[0].was, v.refused[0].mine], [cook.id, 12, true]);
  assert.deepStrictEqual(store.reportsForItem(state, 'Spider Fang'), []);
});

test('the newest report wins: a later price turns a refusal back into a buyer', () => {
  const state = store.newState();
  refuse(state, {}, 1000);
  store.addReport(state, { vendorId: cook.id, vendorName: cook.name, zone: cook.zone, itemName: 'Spider Fang', unitPrice: 9 }, 3000);
  const v = store.verdictsForItem(state, 'Spider Fang');
  assert.strictEqual(v.refused.length, 0);
  assert.strictEqual(v.buyers[0].unitPrice, 9);
});

test('refusing twice is one refusal; undo (delete) brings the earlier price back', () => {
  const state = store.newState();
  manual(state);
  const a = refuse(state, {}, 2000), b = refuse(state, {}, 2500);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(state.reports.filter((r) => r.kind === 'refuses').length, 1);
  store.deleteReport(state, a.id, 3000);
  const v = store.verdictsForItem(state, 'Spider Fang');
  assert.deepStrictEqual([v.refused.length, v.buyers[0].unitPrice], [0, 12]);
});

test('a refusal needs a vendor and an item, has no price to edit, and only its author can undo it', () => {
  const state = store.newState();
  assert.throws(() => refuse(state, { vendorId: '' }), /vendor/i);
  assert.throws(() => refuse(state, { itemName: ' ' }), /item/i);
  const r = refuse(state);
  assert.throws(() => store.reviseReport(state, r.id, 5, 3000), /no price/);
  state.reports[0].author = 'another-install';
  assert.throws(() => store.deleteReport(state, r.id, 3000), /your own/);
  assert.strictEqual(store.verdictsForItem(state, 'Spider Fang').refused[0].mine, false);
});

test('a sale logged after a refusal makes the vendor a buyer again', () => {
  const state = store.newState();
  refuse(state, {}, 1000);
  store.startSession(state, cook, 1500);
  store.attributeSales(state, [{ t: 5000, character: 'Anm', evKey: 'k9', name: 'Spider Fang', id: '', qty: 1, unit: 4 }]);
  const v = store.verdictsForItem(state, 'Spider Fang');
  assert.deepStrictEqual([v.refused.length, v.buyers[0].unitPrice], [0, 4]);
});

// ---- wiki links ----

test('wiki vendors link to a page named after them, keeping parentheses', () => {
  assert.strictEqual(store.wikiLink({ name: 'A cook' }).url, 'https://monstersandmemories.miraheze.org/wiki/A_cook');
  assert.strictEqual(store.wikiLink({ name: 'A fisherman (Faelindral)' }).url, 'https://monstersandmemories.miraheze.org/wiki/A_fisherman_(Faelindral)');
  assert.strictEqual(store.wikiLink({ name: 'chef Belle' }).url, 'https://monstersandmemories.miraheze.org/wiki/Chef_Belle');
  assert.match(store.wikiLink({ name: "Bob's #1 stall" }).url, /Bob's_%231_stall$/);
});

test('your saved link wins; local vendors without one get a wiki search', () => {
  assert.deepStrictEqual(store.wikiLink({ name: 'A cook', wikiUrl: 'https://example.org/x' }), { url: 'https://example.org/x', kind: 'saved' });
  const l = store.wikiLink({ name: 'Alric Mercantile', source: 'local' });
  assert.strictEqual(l.kind, 'search');
  assert.match(l.url, /Special:Search.*search=Alric%20Mercantile/);
});

test('every wiki vendor gets a page link', () => {
  for (const v of wikiVendors) assert.match(store.wikiLink(v).url, /\/wiki\/[A-Z]/);
});

test('selling to a local or Atlas vendor records reports under that vendor\'s own id', () => {
  const state = store.newState();
  const { vendor } = store.addVendor(state, { name: 'Alric', zone: 'Night Harbor' }, wikiIds, 1);
  store.startSession(state, Object.assign({}, vendor), 10);
  store.attributeSales(state, [{ t: 20, character: 'Anm', evKey: 'k1', name: 'Rat Tooth', id: '', qty: 1, unit: 6 }]);
  assert.strictEqual(state.reports[0].vendorId, vendor.id);
  assert.match(vendor.id, /^local:/);
  const atlas = { id: 'atlas:underdocks:telar nur gta', name: "Telar Nur'gta", zone: 'Underdocks' };
  assert.strictEqual(store.startSession(state, atlas, 30).vendorId, atlas.id);
});
