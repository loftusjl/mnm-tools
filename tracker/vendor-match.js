// ---------------------------------------------------------------
// Vendor matcher — "who will buy this item?"
//
// The wiki's Merchant pages list what each vendor buys as free text: sometimes
// a category ("Hides", "Gems"), sometimes an exact item ("Bat Wing"), sometimes
// "about anything at a reduced cost", sometimes junk ("unknown"). This module
// turns both sides into tags so they can be compared:
//
//   exact     the vendor's list names this very item
//   category  the item and one of the vendor's entries share a tag
//   any       the vendor buys "about anything" (at a reduced price)
//
// Pure (no Electron, no file access) so it can be unit-tested standalone.
// ---------------------------------------------------------------

// Tag table: the same patterns tag item names and vendor phrases, so
// "Chipped Ruby" and a vendor entry "Gems" both come out as `gems`.
const TAGS = {
  gems: { label: 'Gems', re: /\bgems?\b|\b(chipped|flawed|imperfect)\b|\b(ruby|emerald|topaz|onyx|jacinth|agate|lapis|opal|sapphire|diamond|pearl|malachite|jade|hematite|amber|quartz|bloodstone)\b/ },
  ores: { label: 'Ores', re: /\bores?\b|\bcoal\b/ },
  stones: { label: 'Stones', re: /\b(lime)?stones?\b|\brocks?\b/ },
  'metal-scraps': { label: 'Metal scraps', re: /\b(bronze|iron|copper|steel|metal)\b.*\bscraps?\b|\bmetal scraps?\b/ },
  hides: { label: 'Hides', re: /\bhides?\b|\bpelts?\b|\bfurs?\b|\bskins?\b|\brawhide\b|\bleather\b/ },
  cloth: { label: 'Cloth & thread', re: /\bcloth\b|\bthreads?\b|\bsilk\b|\btailoring\b/ },
  fish: { label: 'Fish', re: /\bfish\b|\b(trout|bass|salmon|eel|perch|carp|catfish|pike|minnow|herring|cod)\b/ },
  bait: { label: 'Bait', re: /\bbait\b|\bgrubs?\b|\bworms?\b/ },
  meat: { label: 'Meat', re: /\bmeats?\b|\bfillets?\b/ },
  'animal-parts': { label: 'Animal parts', re: /\b(animal|creature|monster)\b|\b(tooth|teeth|fangs?|claws?|ears?|eyes?|legs?|foot|feet|wings?|eggs?|tails?|horns?|beaks?|glands?|silk|fur)\b/ },
  carapaces: { label: 'Carapaces', re: /\bcarapaces?\b|\bchitin\b/ },
  'undead-parts': { label: 'Undead parts', re: /\bundead\b|\bskeleton(al)?\b|\bbones?\b|\bskulls?\b|\bjawbones?\b|\bfemur\b|\bghoul\b|\bzombie\b|\bremains\b/ },
  resin: { label: 'Resin', re: /\bresins?\b|\bsap\b/ },
  wood: { label: 'Wood', re: /\bwood\b|\blogs?\b|\btimber\b|\blumber\b|\bplanks?\b/ },
  sealants: { label: 'Sealants', re: /\bsealants?\b|\bfinish\b|\bvarnish\b/ },
  produce: { label: 'Vegetables', re: /\bvegetables?\b|\bcarrots?\b|\bpotato(es)?\b|\bcabbage\b|\bgarlic\b|\blemons?\b|\bpepper\b|\bmushrooms?\b|\bproduce\b/ },
  herbs: { label: 'Herbs & roots', re: /\bherbs?\b|\broots?\b|\bthyme\b|\bfronds?\b|\bleaf\b/ },
  food: { label: 'Food', re: /\bfood\b|\bcooked\b|\bcheese\b|\bbread\b|\bcooking supplies\b/ },
  lighting: { label: 'Torches & lighting', re: /\btorch(es)?\b|\blighting\b|\blight stones?\b|\blantern\b/ },
  bags: { label: 'Bags', re: /\bbags?\b|\bpacks?\b|\bpouch(es)?\b|\bsatchel\b|\bbackpack\b/ },
  bandages: { label: 'Bandages', re: /\bbandages?\b/ },
  scrolls: { label: 'Scrolls', re: /\bscrolls?\b/ },
  // Equipment is tagged from the wiki's slot data first (see equipmentTags).
  weapons: { label: 'Weapons', re: /\bweapons?\b|\bblacksmithed\b/ },
  armor: { label: 'Armor', re: /\barmou?r\b/ },
  jewelry: { label: 'Jewelry', re: /\bjewelry\b|\bjewellery\b/ },
  boots: { label: 'Boots', re: /\bboots\b/ },
};
// Armor sub-types, only meaningful once something is known to be armor.
const ARMOR_KINDS = {
  'chain-armor': /\bchain\b/,
  'plate-armor': /\bplate\b/,
  'cloth-armor': /\bcloth\b|\btattered\b|\bwoven\b|\brobes?\b/,
  'leather-armor': /\bleather\b|\brawhide\b|\bhide\b|\bstuds?\b/,
};
const ARMOR_KIND_LABELS = {
  'chain-armor': 'Chain armor', 'plate-armor': 'Plate armor',
  'cloth-armor': 'Cloth armor', 'leather-armor': 'Leather armor',
};
const LABELS = Object.assign(
  Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [k, v.label])),
  ARMOR_KIND_LABELS
);

const WEAPON_SLOTS = /\b(PRIMARY|SECONDARY|RANGE|AMMO)\b/i;
const JEWELRY_SLOTS = /\b(NECK|FINGER|EAR)\b/i;
const BAG_SLOTS = /\b(BAG|BACKPACK)\b/i;

const ANYTHING_RE = /\babout anything\b|\banything\b.*\breduced\b/i;
const JUNK_RE = /^(unknown|none|nothing!?|various)$/i;

// Lowercase, strip punctuation, collapse spaces; singularise each word so
// "Resins" == "Resin" and "Giant Beetle Eyes" == "Giant Beetle Eye".
function nameKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && /ies$/.test(w) ? w.slice(0, -3) + 'y' : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join(' ');
}

function tagsOfText(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const [tag, def] of Object.entries(TAGS)) if (def.re.test(t)) out.add(tag);
  return out;
}

// Equipment is recognised from the wiki's slot/damage data; the wiki covers
// nearly every wearable. `wiki` is the item's entry in mnmdb/wiki.json (or null).
function equipmentTags(name, wiki) {
  const out = new Set();
  const slot = wiki && wiki.slot ? String(wiki.slot) : '';
  const isWeapon = (wiki && wiki.dmg != null) || WEAPON_SLOTS.test(slot);
  if (isWeapon) out.add('weapons');
  if (BAG_SLOTS.test(slot)) out.add('bags');
  const lower = String(name).toLowerCase();
  const kinds = Object.entries(ARMOR_KINDS).filter(([, re]) => re.test(lower)).map(([k]) => k);
  // Neck/ear/finger slots hold jewelry, but also armor pieces (a "Chain Gorget" sits
  // in NECK): an armor material in the name, or an armor-less ring, decides which.
  const jewelrySlot = JEWELRY_SLOTS.test(slot);
  const armorInJewelrySlot = jewelrySlot && kinds.length > 0 && wiki && wiki.ac > 0;
  if (jewelrySlot && !armorInJewelrySlot) out.add('jewelry');
  const wearable = slot && !isWeapon && !BAG_SLOTS.test(slot) && (!jewelrySlot || armorInJewelrySlot);
  if (wearable) {
    out.add('armor');
    if (/\bFEET\b/i.test(slot) || /\b(boots|sandals|shoes|greaves)\b/i.test(name)) out.add('boots');
    kinds.forEach((k) => out.add(k));
  }
  return out;
}

// All tags for an item. Equipment gets only equipment tags: a "Cracked Fine Wood
// Staff" is a weapon, not wood; raw-material rules apply to everything else.
function itemTags(name, wiki) {
  const equip = equipmentTags(name, wiki);
  if (equip.size) return equip;
  return tagsOfText(name);
}

// Split one wiki `buys` entry into what it says. Returns null for junk.
function parseBuyEntry(raw) {
  const text = String(raw || '').trim();
  if (!text || JUNK_RE.test(text)) return null;
  if (ANYTHING_RE.test(text)) return { raw: text, any: true, tags: new Set(), key: '' };
  const tags = tagsOfText(text);
  if (/\b(armou?r|armorer)\b/i.test(text)) {
    for (const [kind, re] of Object.entries(ARMOR_KINDS)) if (re.test(text.toLowerCase())) tags.add(kind);
    // "Chain Armor" buys chain only: drop the generic tag so it doesn't match plate.
    if ([...tags].some((t) => ARMOR_KIND_LABELS[t])) tags.delete('armor');
  }
  return { raw: text, any: false, tags, key: nameKey(text) };
}

// Build the matcher's view of a vendor once, so matching many items is cheap.
function prepareVendor(v) {
  const entries = (v.buys || []).map(parseBuyEntry).filter(Boolean);
  return { vendor: v, entries, buysAnything: entries.some((e) => e.any) };
}

// Does `entry` (a vendor line) sell-to-vendor this item?
//   exact    the line IS the item's name
//   category the line is a category the item belongs to
function matchEntry(entry, itemKey, itemTagSet) {
  if (entry.any) return null;
  if (entry.key && entry.key === itemKey) return { how: 'exact', via: entry.raw };
  // A broad tag in the entry ("Armor") must not swallow a narrow item tag only
  // by accident, so require the entry to be category-like: it shares a tag.
  for (const tag of entry.tags) if (itemTagSet.has(tag)) return { how: 'category', via: entry.raw, tag };
  return null;
}

// vendors: prepared vendors. Returns [{ vendor, how, via, tag? }] sorted
// exact -> category -> any, each group by name.
function vendorsFor(itemName, wiki, prepared) {
  const key = nameKey(itemName);
  const tags = itemTags(itemName, wiki);
  const exact = [], category = [], any = [];
  for (const p of prepared) {
    let best = null;
    for (const e of p.entries) {
      const m = matchEntry(e, key, tags);
      if (m && (!best || (m.how === 'exact' && best.how !== 'exact'))) best = m;
    }
    if (best) (best.how === 'exact' ? exact : category).push({ vendor: p.vendor, how: best.how, via: best.via, tag: best.tag });
    else if (p.buysAnything) any.push({ vendor: p.vendor, how: 'any', via: 'about anything (reduced price)' });
  }
  const byName = (a, b) => a.vendor.name.localeCompare(b.vendor.name);
  return [...exact.sort(byName), ...category.sort(byName), ...any.sort(byName)];
}

// Lowercase-alphanumerics zone comparison: "Ail'Vorith" == "ailvorith" (the
// game's internal code), so the vendor list can follow the player's zone.
const zoneKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Does this vendor stand in the given zone? `zone` may be the game's internal code
// or a display name; `aliases` is zone-aliases.json's `zones` table, so a code that
// covers several maps (evergrove = Evershade Weald + Faelindral) matches them all.
function vendorInZone(vendor, zone, aliases) {
  const z = zoneKey(zone);
  if (!z) return true;
  const vz = zoneKey(vendor.zone);
  if (vz === z) return true;
  const a = aliases && aliases[String(zone).toLowerCase()];
  return !!(a && (a.maps || []).some((m) => zoneKey(m.name) === vz));
}

module.exports = {
  TAGS, LABELS, nameKey, tagsOfText, itemTags, parseBuyEntry, prepareVendor,
  vendorsFor, vendorInZone, zoneKey,
};
