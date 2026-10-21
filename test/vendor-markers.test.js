const test = require('node:test');
const assert = require('node:assert');
const { vendorKey, matchMarkers } = require('../renderer/vendor-markers');

test('case, punctuation, a leading a/an/the and a (zone) suffix are ignored', () => {
  assert.strictEqual(vendorKey('A cook'), 'cook');
  assert.strictEqual(vendorKey('  THE Cook!'), 'cook');
  assert.strictEqual(vendorKey('An armorer'), 'armorer');
  assert.strictEqual(vendorKey('A fisherman (Faelindral)'), 'fisherman');
  assert.strictEqual(vendorKey("Chef Belle"), 'chef belle');
  assert.strictEqual(vendorKey(''), '');
});

test('only the same name matches, never a longer or similar one', () => {
  const markers = [{ label: 'Cook' }, { label: 'cook' }, { label: 'Cooking Station' }, { label: 'Chef Belle' }, { label: 'Anvil' }, { label: '' }];
  assert.deepStrictEqual(matchMarkers('A cook', markers).map((m) => m.label), ['Cook', 'cook']);
  assert.deepStrictEqual(matchMarkers('Chef Belle', markers).length, 1);
  assert.deepStrictEqual(matchMarkers('', markers), []);
  assert.deepStrictEqual(matchMarkers('A used weapons dealer-Faelindral', markers), []);
});
