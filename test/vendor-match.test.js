const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('../tracker/vendor-match');

// Real published data, so the tests exercise the shapes the wiki scrape produces.
const mnmdb = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', f), 'utf8'));
const vendors = mnmdb('vendors.json').vendors;
const wiki = mnmdb('wiki.json').items;
const prepared = vendors.map(vm.prepareVendor);

const buyers = (item) => vm.vendorsFor(item, wiki[item] || null, prepared);
const names = (list) => list.map((m) => m.vendor.name);
const how = (item, vendorName) => (buyers(item).find((m) => m.vendor.name === vendorName) || {}).how;

test('nameKey ignores case, punctuation, price hints and plurals', () => {
  assert.strictEqual(vm.nameKey('Multhele Roots (1c)'), vm.nameKey('multhele root'));
  assert.strictEqual(vm.nameKey('Giant Beetle Eyes'), vm.nameKey('Giant Beetle Eye'));
  assert.strictEqual(vm.nameKey('Resins'), 'resin');
});

test('a vendor that lists the exact item matches as exact', () => {
  assert.strictEqual(how('Bat Wing', 'A poison maker (Night Harbor)'), 'exact');
  assert.strictEqual(how('Multhele Root', 'A ranger instructor'), 'exact');
});

test('exact matches sort before category matches, then "anything" vendors', () => {
  const order = buyers('Bone Chips').map((m) => m.how);
  const rank = { exact: 0, category: 1, any: 2 };
  assert.deepStrictEqual(order, [...order].sort((a, b) => rank[a] - rank[b]));
  assert.ok(order.includes('exact') && order.includes('category') && order.includes('any'));
});

test('gems: both gem-named and chipped gems reach gem buyers', () => {
  assert.strictEqual(how('Chipped Ruby', 'A jewelcrafter'), 'category');
  assert.strictEqual(how('Flawed Topaz', 'A miner'), 'category');
  assert.ok(names(buyers('Onyx')).includes('A blacksmith'));
});

test('ores, hides and animal parts follow their categories', () => {
  assert.strictEqual(how('Copper Ore', 'A miner'), 'category');
  assert.strictEqual(how('Low-Quality Wolf Pelt', 'A tanner'), 'category');
  assert.strictEqual(how('Rat Tooth', 'A cook'), 'category');
  assert.strictEqual(how('Bone Chips', 'A cook'), 'category'); // "Skeleton parts (chips, jawbone ...)"
});

test('equipment is recognised from wiki slot data, not name keywords', () => {
  // "Wood Staff" is a weapon: it must not be offered to wood buyers.
  const staff = names(buyers('Cracked Fine Wood Staff'));
  assert.ok(staff.includes('Quartermaster Obaid') && staff.includes('Weaponsmith Sielah Zefir'));
  assert.ok(!staff.includes('A lumberjack') && !staff.includes('A fisherman (Faelindral)'));
});

test('armor sub-types pick the right armorer', () => {
  assert.strictEqual(how('Rusty Iron Chain Gorget', 'A chain armorer'), 'category');
  assert.strictEqual(how('Corroded Bronze Plate Helm', 'A plate armorer'), 'category');
  assert.ok(!names(buyers('Corroded Bronze Plate Helm')).includes('A chain armorer'));
  assert.strictEqual(how('Rawhide Belt', 'A leatherworker'), 'category');
});

test('"buys about anything" vendors are offered last for any item', () => {
  const list = buyers('Spider Fang');
  const last = list[list.length - 1];
  assert.strictEqual(last.how, 'any');
  assert.ok(names(list).includes('A shady trader'));
});

test('junk entries ("unknown", "None") never match anything', () => {
  assert.ok(!names(buyers('Bone Chips')).includes('Toilmaster Verith'));
  assert.ok(!names(buyers('Bone Chips')).includes('Cook Vashuk'));
  assert.strictEqual(vm.parseBuyEntry('unknown'), null);
  assert.strictEqual(vm.parseBuyEntry('None'), null);
});

test('an item nothing in a category claims still gets the "anything" vendors', () => {
  const list = buyers('Head of the Overseer');
  assert.ok(list.length > 0 && list.every((m) => m.how === 'any'));
});

test('zone filter follows the game code, display names and zone aliases', () => {
  const v = (zone) => ({ name: 'x', zone });
  assert.ok(vm.vendorInZone(v("Ail'Vorith"), 'ailvorith'));
  assert.ok(vm.vendorInZone(v('Night Harbor'), 'nightharbor'));
  assert.ok(!vm.vendorInZone(v('Night Harbor'), 'ailvorith'));
  assert.ok(vm.vendorInZone(v('Night Harbor'), ''));      // no zone known = show all
  const aliases = { evergrove: { maps: [{ name: 'Evershade Weald' }, { name: 'Faelindral' }] } };
  assert.ok(vm.vendorInZone(v('Faelindral'), 'evergrove', aliases));
  assert.ok(!vm.vendorInZone(v('Faelindral'), 'evergrove'));
});

test('every loot item seen so far gets at least one buyer', () => {
  const loot = mnmdb('data.json').items;
  const orphans = loot.filter((i) => buyers(i.name).length === 0).map((i) => i.name);
  assert.deepStrictEqual(orphans, []);
});
