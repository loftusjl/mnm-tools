// ---------------------------------------------------------------
// Vendor <-> map marker name matching. Pure (no DOM), so it also runs under
// `node --test`; in the app it is a plain script that sets window.VendorMarkers.
//
// A vendor's wiki name is "A cook" or "A fisherman (Faelindral)"; a marker's label is
// whatever its author typed ("Cook", "fisherman"). Both are reduced to the same key:
// case, punctuation, a trailing "(zone)" and a leading a/an/the all ignored. Nothing
// fuzzier than that, so a match is always the same NPC and never a lookalike.
// ---------------------------------------------------------------
(() => {
  const vendorKey = (name) => String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(a|an|the) /, '')
    .trim();

  // markers: [{ label, ... }]. Returns the ones whose label is the vendor's name.
  function matchMarkers(vendorName, markers) {
    const key = vendorKey(vendorName);
    return key ? markers.filter((m) => vendorKey(m.label) === key) : [];
  }

  const api = { vendorKey, matchMarkers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.VendorMarkers = api;
})();
