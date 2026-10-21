const test = require('node:test');
const assert = require('node:assert');
const av = require('../tracker/atlas-vendors');
const store = require('../tracker/vendor-reports');

const maps = [{ id: 'underdocks', title: 'Underdocks' }, { id: 'night-harbor', title: 'Night Harbor' }];
const markers = {
  underdocks: [
    { id: 'community-555', name: "Telar Nur'gta", category: 'Vendor', note: 'Dark Elf merchant, 2nd floor', level: 'lower', wiki: 'https://monstersandmemories.wiki/npcs/telar-nurgta', wikiId: 'npc-telar-nur-gta' },
    { id: 'x1', name: 'Anvil', category: 'Forge' },
    { id: 'n1', name: 'Abbot Harrow', category: 'Notable NPC' },
    { id: 'q1', name: 'Marshal Harding', category: 'Quest NPC' },
    { id: 'm1', name: 'A giant rat', category: 'Named mob' },
    { id: 'wiki-bag-merchant', name: 'Bag merchant', category: 'Vendor', note: '' },
  ],
  'night-harbor': [{ id: 'c1', name: 'Chef Belle', category: 'Vendor', note: 'Market' }],
};
const wikiVendors = [
  { name: 'Chef Belle', zone: 'Night Harbor', location: 'Market stall', buys: ['Fish'] },
  { name: 'A bag merchant (Night Harbor)', zone: 'Night Market', location: '', buys: [] },
].map((v) => Object.assign({ id: store.vendorId(v) }, v));

test('only Vendor pins are taken, with zone from the map title and the Atlas wiki link', () => {
  const list = av.parseAtlasVendors(maps, markers);
  assert.deepStrictEqual(list.map((v) => v.name), ["Telar Nur'gta", 'Abbot Harrow', 'Marshal Harding', 'Bag merchant', 'Chef Belle']);
  assert.deepStrictEqual(list.map((v) => v.npc), [false, true, true, false, false]);   // NPCs are pickable but are not vendors
  const t = list[0];
  assert.deepStrictEqual([t.zone, t.location, t.atlasWiki, t.atlas.wikiId, t.atlas.map], ['Underdocks', 'Dark Elf merchant, 2nd floor', 'https://monstersandmemories.wiki/npcs/telar-nurgta', 'npc-telar-nur-gta', 'underdocks']);
});

test('an Atlas vendor the wiki lists is merged (same id), keeping the wiki buy list', () => {
  const merged = av.mergeAtlas(wikiVendors, av.parseAtlasVendors(maps, markers));
  const belle = merged.find((v) => v.name === 'Chef Belle');
  assert.strictEqual(belle.id, wikiVendors[0].id);
  assert.deepStrictEqual(belle.buys, ['Fish']);
  assert.strictEqual(belle.location, 'Market stall');       // the wiki's text wins
  assert.strictEqual(belle.atlas.place, 'c1');
  assert.strictEqual(merged.filter((v) => v.name === 'Chef Belle').length, 1);
});

test('an Atlas-only vendor is added with an atlas: id and no buy list', () => {
  const merged = av.mergeAtlas(wikiVendors, av.parseAtlasVendors(maps, markers));
  const t = merged.find((v) => v.name === "Telar Nur'gta");
  assert.match(t.id, /^atlas:underdocks:telar nur gta$/);
  assert.deepStrictEqual([t.source, t.buys, t.zone], ['atlas', [], 'Underdocks']);
});

test('a unique name matches across differently named zones; ids stay stable', () => {
  const merged = av.mergeAtlas(wikiVendors, av.parseAtlasVendors(maps, markers));
  const bag = merged.filter((v) => /bag merchant/i.test(v.name));
  assert.strictEqual(bag.length, 1);                         // wiki "A bag merchant" absorbed the Atlas pin
  assert.strictEqual(bag[0].id, wikiVendors[1].id);
  assert.strictEqual(bag[0].atlas.map, 'underdocks');
  assert.strictEqual(merged.length, wikiVendors.length + 3);   // Telar, Abbot Harrow, Marshal Harding
});

test('the Atlas link is used for merged and Atlas vendors; saved link still wins', () => {
  const merged = av.mergeAtlas(wikiVendors, av.parseAtlasVendors(maps, markers));
  const t = merged.find((v) => v.name === "Telar Nur'gta");
  assert.deepStrictEqual(store.wikiLink(t), { url: 'https://monstersandmemories.wiki/npcs/telar-nurgta', kind: 'page' });
  assert.strictEqual(store.wikiLink(Object.assign({}, t, { wikiUrl: 'https://example.org/x' })).kind, 'saved');
  const noLink = merged.find((v) => v.source === 'atlas' && v.name === 'Bag merchant') || { name: 'Bag merchant', source: 'atlas' };
  assert.strictEqual(store.wikiLink(noLink).kind, 'search');   // generic Atlas names have no reliable page
});
