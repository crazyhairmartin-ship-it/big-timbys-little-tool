/* ============================================================
   OSRS Combination-Item Margin Tracker
   - Live prices: OSRS Wiki real-time API
   - GE tax: 2% capped at 5M, items <100gp exempt
   - 60s auto refresh, manual refresh
   - 5-minute rolling local history (24h window) for sparkline
   - On-demand /timeseries fetch for full modal chart
   ============================================================ */

const API_BASE = "https://prices.runescape.wiki/api/v1/osrs";
// Use Special:FilePath rather than the flat /images path — the wiki stores
// stackable items under name-suffixed files (e.g. "Rune arrow 5.png" for the
// arrow stack image), and the mapping API's `icon` field sometimes lags
// behind the actual filename for newly-released items. Special:FilePath is
// the canonical resolver: it 302-redirects to whatever the real filename is.
const ICON_BASE = "https://oldschool.runescape.wiki/w/Special:FilePath";

const REFRESH_MS = 60_000;
const HISTORY_SAMPLE_MS = 5 * 60_000;
const HISTORY_WINDOW_MS = 24 * 60 * 60_000;
const STORAGE_KEY = "osrs-combo-history-v1";
const STALE_MS = 6 * 60 * 60_000;

const GE_TAX_RATE = 0.02;
const GE_TAX_CAP = 5_000_000;
const GE_TAX_EXEMPT_BELOW = 100;
const HIGH_ROI_THRESHOLD = 5;

/* ---------------- Recipe Database ----------------
   id        — GE item id of the *result*
   key       — stable identifier (for history)
   name      — display name
   cat       — category
   components: [{ id, qty }]
   extraCost — optional fixed GP cost (enchant runes etc., usually negligible)
   repairBase — optional NPC repair cost; if set, components are interpreted
                as buying the *broken* version and repairCost is added.
---------------------------------------------------- */
const RECIPES = [
  // ====================================================================
  // Combination items — auto-generated from GE-Tracker's published list
  // and cross-checked against the OSRS Wiki /mapping endpoint.
  // ====================================================================
  { key:"dragon-crossbow", id:21902, name:"Dragon crossbow", cat:"Dragon", components:[{id:21921,qty:1},{id:9438,qty:1}] },
  { key:"dragon-crossbow-craft", id:21902, name:"Dragon crossbow (full craft)", cat:"Dragon", components:[{id:21918,qty:1}], supplies:[{id:1513,qty:1},{id:9438,qty:1}] },
  { key:"dragon-crossbow-u", id:21921, name:"Dragon crossbow (u)", cat:"Dragon", components:[{id:21952,qty:1},{id:21918,qty:1}] },
  { key:"dragon-hunter-lance", id:22978, name:"Dragon hunter lance", cat:"Dragon", components:[{id:22966,qty:1},{id:11889,qty:1}] },
  { key:"dragon-kiteshield", id:21895, name:"Dragon kiteshield", cat:"Dragon", components:[{id:1187,qty:1},{id:22097,qty:1},{id:22100,qty:1}] },
  { key:"dragon-platebody", id:21892, name:"Dragon platebody", cat:"Dragon", components:[{id:3140,qty:1},{id:22103,qty:1},{id:22097,qty:1}] },
  { key:"dragon-sq-shield", id:1187, name:"Dragon sq shield", cat:"Dragon", components:[{id:2366,qty:1},{id:2368,qty:1}] },

  { key:"ancient-godsword", id:26233, name:"Ancient godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:26370,qty:1}] },
  { key:"armadyl-godsword", id:11802, name:"Armadyl godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:11810,qty:1}] },
  { key:"bandos-godsword", id:11804, name:"Bandos godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:11812,qty:1}] },
  { key:"godsword-blade", id:11798, name:"Godsword blade", cat:"Godswords", freeSlotFiller:true, components:[{id:11820,qty:1},{id:11818,qty:1},{id:11822,qty:1}] },
  { key:"saradomin-godsword", id:11806, name:"Saradomin godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:11814,qty:1}] },
  { key:"zamorak-godsword", id:11808, name:"Zamorak godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:11816,qty:1}] },

  // Masori (f) — multiple sacrifice paths to the required Armadylean plates.
  //   Mask (f) needs 1 plate, Body (f) needs 4, Chaps (f) needs 3.
  //   Armadyl helmet → 1 plate, chestplate → 4 plates, chainskirt → 3 plates.
  // Variants kept only where waste is ≤ 1 plate or matches a common dump.
  { key:"masori-mask-f-helmet",    id:27235, name:"Masori mask (f) — via Armadyl helmet",    cat:"Masori", components:[{id:27226,qty:1},{id:11826,qty:1}] },
  { key:"masori-mask-f-plate",     id:27235, name:"Masori mask (f) — via plate",             cat:"Masori", components:[{id:27226,qty:1},{id:27269,qty:1}] },
  { key:"masori-body-f-chestplate",id:27238, name:"Masori body (f) — via Armadyl chestplate",cat:"Masori", components:[{id:27229,qty:1},{id:11828,qty:1}] },
  { key:"masori-body-f-helmet",    id:27238, name:"Masori body (f) — via Armadyl helmets",   cat:"Masori", components:[{id:27229,qty:1},{id:11826,qty:4}] },
  { key:"masori-body-f-plate",     id:27238, name:"Masori body (f) — via plate",             cat:"Masori", components:[{id:27229,qty:1},{id:27269,qty:4}] },
  { key:"masori-chaps-f-chainskirt",id:27241,name:"Masori chaps (f) — via Armadyl chainskirt",cat:"Masori",components:[{id:27232,qty:1},{id:11830,qty:1}] },
  { key:"masori-chaps-f-helmet",   id:27241, name:"Masori chaps (f) — via Armadyl helmets",  cat:"Masori", components:[{id:27232,qty:1},{id:11826,qty:3}] },
  { key:"masori-chaps-f-plate",    id:27241, name:"Masori chaps (f) — via plate",            cat:"Masori", components:[{id:27232,qty:1},{id:27269,qty:3}] },
  // Armadylean plate sacrifices — each Armadyl piece yields plates as the result for resale
  { key:"armadylean-plate-helmet",     id:27269, name:"Armadylean plate (via helmet)",     cat:"Masori", components:[{id:11826,qty:1}], resultQty:1 },
  { key:"armadylean-plate-chestplate", id:27269, name:"Armadylean plate (via chestplate)", cat:"Masori", components:[{id:11828,qty:1}], resultQty:4 },
  { key:"armadylean-plate-chainskirt", id:27269, name:"Armadylean plate (via chainskirt)", cat:"Masori", components:[{id:11830,qty:1}], resultQty:3 },

  { key:"ancient-wyvern-shield", id:21634, name:"Ancient wyvern shield", cat:"Misc", components:[{id:2890,qty:1},{id:21637,qty:1}] },
  { key:"amulet-of-fury", id:6585, name:"Amulet of fury", cat:"Misc", components:[{id:6581,qty:1}], supplies:[{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"amulet-of-fury-craft", id:6585, name:"Amulet of fury (full craft)", cat:"Misc", components:[{id:6573,qty:1}], supplies:[{id:2357,qty:1},{id:1759,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"bryophytas-staff-uncharged", id:22368, name:"Bryophyta's staff (uncharged)", cat:"Misc", components:[{id:1391,qty:1},{id:22372,qty:1}] },
  { key:"crystal-key", id:989, name:"Crystal key", cat:"Misc", components:[{id:987,qty:1},{id:985,qty:1}] },
  { key:"dragonfire-shield", id:11284, name:"Dragonfire shield", cat:"Misc", components:[{id:1540,qty:1},{id:11286,qty:1}] },
  { key:"dragonfire-ward", id:22003, name:"Dragonfire ward", cat:"Misc", components:[{id:22006,qty:1},{id:1540,qty:1}] },
  { key:"malediction-ward", id:11924, name:"Malediction ward", cat:"Misc", components:[{id:11931,qty:1},{id:11932,qty:1},{id:11933,qty:1}] },
  { key:"odium-ward", id:11926, name:"Odium ward", cat:"Misc", components:[{id:11928,qty:1},{id:11929,qty:1},{id:11930,qty:1}] },
  { key:"wrath-tiara", id:22121, name:"Wrath tiara", cat:"Misc", components:[{id:5525,qty:1},{id:22118,qty:1}] },

  { key:"berserker-necklace", id:11128, name:"Berserker necklace", cat:"Onyx", components:[{id:6577,qty:1}], supplies:[{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"onyx-amulet", id:6581, name:"Onyx amulet", cat:"Onyx", components:[{id:6579,qty:1},{id:1759,qty:1}] },
  { key:"onyx-amulet-u", id:6579, name:"Onyx amulet (u)", cat:"Onyx", components:[{id:2357,qty:1},{id:6573,qty:1}] },
  { key:"onyx-bracelet", id:11130, name:"Onyx bracelet", cat:"Onyx", components:[{id:6573,qty:1},{id:2357,qty:1}] },
  { key:"onyx-necklace", id:6577, name:"Onyx necklace", cat:"Onyx", components:[{id:2357,qty:1},{id:6573,qty:1}] },
  { key:"onyx-ring", id:6575, name:"Onyx ring", cat:"Onyx", components:[{id:6573,qty:1},{id:2357,qty:1}] },
  { key:"ring-of-stone", id:6583, name:"Ring of stone", cat:"Onyx", components:[{id:6575,qty:1}], supplies:[{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"ring-of-stone-craft", id:6583, name:"Ring of stone (full craft)", cat:"Onyx", components:[{id:6573,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"berserker-necklace-craft", id:11128, name:"Berserker necklace (full craft)", cat:"Onyx", components:[{id:6573,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },

  { key:"heavy-ballista", id:19481, name:"Heavy ballista", cat:"Ranged", components:[{id:19607,qty:1},{id:19610,qty:1}] },
  { key:"incomplete-heavy-ballista", id:19598, name:"Incomplete heavy ballista", cat:"Ranged", components:[{id:19589,qty:1},{id:19592,qty:1}] },
  { key:"incomplete-light-ballista", id:19595, name:"Incomplete light ballista", cat:"Ranged", components:[{id:19586,qty:1},{id:19592,qty:1}] },
  { key:"light-ballista", id:19478, name:"Light ballista", cat:"Ranged", components:[{id:19604,qty:1},{id:19610,qty:1}] },
  { key:"unstrung-heavy-ballista", id:19607, name:"Unstrung heavy ballista", cat:"Ranged", components:[{id:19598,qty:1},{id:19601,qty:1}] },
  { key:"unstrung-light-ballista", id:19604, name:"Unstrung light ballista", cat:"Ranged", components:[{id:19595,qty:1},{id:19601,qty:1}] },
  { key:"zaryte-crossbow", id:26374, name:"Zaryte crossbow", cat:"Ranged", components:[{id:11785,qty:1},{id:26372,qty:1},{id:26231,qty:250}] },
  { key:"venator-bow-uncharged", id:27612, name:"Venator bow (uncharged)", cat:"Ranged", components:[{id:27614,qty:5}] },

  // --- Hueycoatl hide armour (crafted from hides; 76-78 Crafting) ---
  { key:"huey-coif",       id:30073, name:"Hueycoatl hide coif",       cat:"Ranged", components:[{id:30085,qty:2}] },
  { key:"huey-body",       id:30076, name:"Hueycoatl hide body",       cat:"Ranged", components:[{id:30085,qty:3}] },
  { key:"huey-chaps",      id:30079, name:"Hueycoatl hide chaps",      cat:"Ranged", components:[{id:30085,qty:2}] },
  { key:"huey-vambraces",  id:30082, name:"Hueycoatl hide vambraces",  cat:"Ranged", components:[{id:30085,qty:1}] },

  // ----- Decombinations (destroy assembled, recover the more valuable part) -----
  // Profitable when the part trades higher than the assembled minus tax.
  { key:"decomb-arcane",   id:12827, name:"Arcane sigil ← Arcane shield",   cat:"Decombines", components:[{id:12825,qty:1}] },
  { key:"decomb-spectral", id:12823, name:"Spectral sigil ← Spectral shield", cat:"Decombines", components:[{id:12821,qty:1}] },
  { key:"decomb-elysian",  id:12819, name:"Elysian sigil ← Elysian shield", cat:"Decombines", components:[{id:12817,qty:1}] },
  { key:"decomb-magicfang-staff", id:12932, name:"Magic fang ← Toxic staff (chisel)", cat:"Decombines", components:[{id:12902,qty:1}] },
  { key:"decomb-scales-staff",  id:12934, name:"Zulrah's scales ← Toxic staff (crack)",  cat:"Decombines", components:[{id:12902,qty:1}], resultQty:20000 },
  { key:"decomb-scales-pipe",   id:12934, name:"Zulrah's scales ← Toxic blowpipe (crack)", cat:"Decombines", components:[{id:12924,qty:1}], resultQty:20000 },
  { key:"decomb-scales-helm",   id:12934, name:"Zulrah's scales ← Serpentine helm (crack)", cat:"Decombines", components:[{id:12929,qty:1}], resultQty:20000 },

  { key:"arcane-spirit-shield", id:12825, name:"Arcane spirit shield", cat:"Spirit Shields", components:[{id:12831,qty:1},{id:12827,qty:1}] },
  { key:"blessed-spirit-shield", id:12831, name:"Blessed spirit shield", cat:"Spirit Shields", freeSlotFiller:true, components:[{id:12829,qty:1},{id:12833,qty:1}] },
  { key:"elysian-spirit-shield", id:12817, name:"Elysian spirit shield", cat:"Spirit Shields", components:[{id:12831,qty:1},{id:12819,qty:1}] },
  { key:"spectral-spirit-shield", id:12821, name:"Spectral spirit shield", cat:"Spirit Shields", components:[{id:12831,qty:1},{id:12823,qty:1}] },

  { key:"kodai-wand", id:21006, name:"Kodai wand", cat:"Top-tier", components:[{id:6914,qty:1},{id:21043,qty:1}] },
  { key:"saturated-heart", id:27641, name:"Saturated heart", cat:"Top-tier", components:[{id:20724,qty:1},{id:27616,qty:150000}] },

  // Torva repair — helm needs 1 component, body/legs need 2 each.
  //   Bandos chestplate → 3 components, Bandos tassets → 2 components.
  { key:"bandosian-components-chestplate", id:26394, name:"Bandosian components (via chestplate)", cat:"Torva", components:[{id:11832,qty:1}], resultQty:3 },
  { key:"bandosian-components-tassets",    id:26394, name:"Bandosian components (via tassets)",    cat:"Torva", components:[{id:11834,qty:1}], resultQty:2 },
  { key:"torva-helm-components",    id:26382, name:"Torva full helm — via components",  cat:"Torva", components:[{id:26376,qty:1},{id:26394,qty:1}] },
  { key:"torva-helm-tassets",       id:26382, name:"Torva full helm — via tassets",     cat:"Torva", components:[{id:26376,qty:1},{id:11834,qty:1}] },
  { key:"torva-helm-chestplate",    id:26382, name:"Torva full helm — via chestplate",  cat:"Torva", components:[{id:26376,qty:1},{id:11832,qty:1}] },
  { key:"torva-body-components",    id:26384, name:"Torva platebody — via components",  cat:"Torva", components:[{id:26378,qty:1},{id:26394,qty:2}] },
  { key:"torva-body-tassets",       id:26384, name:"Torva platebody — via tassets",     cat:"Torva", components:[{id:26378,qty:1},{id:11834,qty:1}] },
  { key:"torva-body-chestplate",    id:26384, name:"Torva platebody — via chestplate",  cat:"Torva", components:[{id:26378,qty:1},{id:11832,qty:1}] },
  { key:"torva-legs-components",    id:26386, name:"Torva platelegs — via components",  cat:"Torva", components:[{id:26380,qty:1},{id:26394,qty:2}] },
  { key:"torva-legs-tassets",       id:26386, name:"Torva platelegs — via tassets",     cat:"Torva", components:[{id:26380,qty:1},{id:11834,qty:1}] },
  { key:"torva-legs-chestplate",    id:26386, name:"Torva platelegs — via chestplate",  cat:"Torva", components:[{id:26380,qty:1},{id:11832,qty:1}] },

  { key:"serpentine-helm-uncharged", id:12929, name:"Serpentine helm (uncharged)", cat:"Toxic", components:[{id:12927,qty:1}] },
  { key:"toxic-blowpipe-empty", id:12924, name:"Toxic blowpipe (empty)", cat:"Toxic", components:[{id:12922,qty:1}] },
  { key:"toxic-staff-uncharged", id:12902, name:"Toxic staff (uncharged)", cat:"Toxic", components:[{id:11791,qty:1},{id:12932,qty:1}] },
  { key:"uncharged-toxic-trident", id:12900, name:"Uncharged toxic trident", cat:"Toxic", components:[{id:12932,qty:1},{id:11908,qty:1}] },
  { key:"uncharged-toxic-trident-e", id:22294, name:"Uncharged toxic trident (e)", cat:"Toxic", components:[{id:22290,qty:1},{id:12932,qty:1}] },
  { key:"uncharged-trident-e", id:22290, name:"Uncharged trident (e)", cat:"Toxic", components:[{id:11908,qty:1},{id:12004,qty:10}] },

  { key:"boots-of-brimstone", id:22951, name:"Boots of brimstone", cat:"Upgrade boots", components:[{id:23037,qty:1},{id:22957,qty:1}] },
  { key:"devout-boots", id:22954, name:"Devout boots", cat:"Upgrade boots", components:[{id:12598,qty:1},{id:22960,qty:1}] },
  { key:"eternal-boots", id:13235, name:"Eternal boots", cat:"Upgrade boots", components:[{id:6920,qty:1},{id:13227,qty:1}] },
  { key:"guardian-boots", id:21733, name:"Guardian boots", cat:"Upgrade boots", components:[{id:11836,qty:1},{id:21730,qty:1}] },
  { key:"pegasian-boots", id:13237, name:"Pegasian boots", cat:"Upgrade boots", components:[{id:2577,qty:1},{id:13229,qty:1}] },
  { key:"primordial-boots", id:13239, name:"Primordial boots", cat:"Upgrade boots", components:[{id:11840,qty:1},{id:13231,qty:1}] },

  { key:"accursed-sceptre-u", id:27662, name:"Accursed sceptre (u)", cat:"Wilderness", components:[{id:22552,qty:1},{id:27673,qty:1}] },
  { key:"accursed-sceptre-au", id:27676, name:"Accursed sceptre (au)", cat:"Wilderness", components:[{id:27662,qty:1}] }, // intermediate→charged
  { key:"staff-of-light", id:22296, name:"Staff of light", cat:"Wilderness", components:[{id:11791,qty:1},{id:13256,qty:1}] },
  { key:"ursine-chainmace-u", id:27657, name:"Ursine chainmace (u)", cat:"Wilderness", components:[{id:22542,qty:1},{id:27667,qty:1}] },
  { key:"voidwaker", id:27690, name:"Voidwaker", cat:"Wilderness", components:[{id:27684,qty:1},{id:27681,qty:1},{id:27687,qty:1}], extraCost:500000 },
  { key:"webweaver-bow-u", id:27652, name:"Webweaver bow (u)", cat:"Wilderness", components:[{id:22547,qty:1},{id:27670,qty:1}] },
  { key:"zamorakian-hasta", id:11889, name:"Zamorakian hasta", cat:"Misc", freeSlotFiller:true, components:[{id:11824,qty:1}], extraCost:150000 },

  // No enchant runes — same pattern as Necklace of rupture: the etched fang is the whole recipe.
  { key:"amulet-of-rancour", id:29801, name:"Amulet of rancour", cat:"Zenyte", components:[{id:19553,qty:1},{id:33534,qty:1}] },
  { key:"amulet-of-torture", id:19553, name:"Amulet of torture", cat:"Zenyte", components:[{id:19541,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"necklace-of-anguish", id:19547, name:"Necklace of anguish", cat:"Zenyte", components:[{id:19535,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  // No enchant runes — unlike every other Zenyte upgrade, the fang is the whole recipe.
  { key:"necklace-of-rupture", id:33639, name:"Necklace of rupture", cat:"Zenyte", components:[{id:19547,qty:1},{id:33636,qty:1}] },
  { key:"ring-of-suffering", id:19550, name:"Ring of suffering", cat:"Zenyte", components:[{id:19538,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"tormented-bracelet", id:19544, name:"Tormented bracelet", cat:"Zenyte", components:[{id:19532,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"uncut-zenyte", id:19496, name:"Uncut zenyte", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}] },
  { key:"zenyte-amulet", id:19541, name:"Zenyte amulet", cat:"Zenyte", components:[{id:19501,qty:1},{id:1759,qty:1}] },
  { key:"zenyte-amulet-u", id:19501, name:"Zenyte amulet (u)", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"zenyte-bracelet", id:19532, name:"Zenyte bracelet", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"zenyte-necklace", id:19535, name:"Zenyte necklace", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"zenyte-ring", id:19538, name:"Zenyte ring", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"ring-of-suffering-craft", id:19550, name:"Ring of suffering (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"necklace-of-anguish-craft", id:19547, name:"Necklace of anguish (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"tormented-bracelet-craft", id:19544, name:"Tormented bracelet (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"amulet-of-torture-craft", id:19553, name:"Amulet of torture (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:1759,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },

  // --- GE Item Sets (bundle ↔ pieces, exchangeable at the Grand Exchange clerk) ---
  // Each bundle is a single tradeable item; flipping is buy bundle + sell pieces
  // (or vice versa) when the GE spread favors one side.
  { key:"set-ahrim",      id:12881, name:"Ahrim's armour set",      cat:"Sets", components:[{id:4708,qty:1},{id:4712,qty:1},{id:4714,qty:1},{id:4710,qty:1}] },
  { key:"set-dharok",     id:12877, name:"Dharok's armour set",     cat:"Sets", components:[{id:4716,qty:1},{id:4720,qty:1},{id:4722,qty:1},{id:4718,qty:1}] },
  { key:"set-guthan",     id:12873, name:"Guthan's armour set",     cat:"Sets", components:[{id:4724,qty:1},{id:4728,qty:1},{id:4730,qty:1},{id:4726,qty:1}] },
  { key:"set-karil",      id:12883, name:"Karil's armour set",      cat:"Sets", components:[{id:4732,qty:1},{id:4736,qty:1},{id:4738,qty:1},{id:4734,qty:1}] },
  { key:"set-torag",      id:12879, name:"Torag's armour set",      cat:"Sets", components:[{id:4745,qty:1},{id:4749,qty:1},{id:4751,qty:1},{id:4747,qty:1}] },
  { key:"set-verac",      id:12875, name:"Verac's armour set",      cat:"Sets", components:[{id:4753,qty:1},{id:4757,qty:1},{id:4759,qty:1},{id:4755,qty:1}] },
  { key:"set-blood-moon",   id:31136, name:"Blood moon armour set",   cat:"Sets", components:[{id:29028,qty:1},{id:29022,qty:1},{id:29025,qty:1},{id:28997,qty:1}] },
  { key:"set-blue-moon",    id:31139, name:"Blue moon armour set",    cat:"Sets", components:[{id:29019,qty:1},{id:29013,qty:1},{id:29016,qty:1},{id:28988,qty:1}] },
  { key:"set-eclipse-moon", id:31142, name:"Eclipse moon armour set", cat:"Sets", components:[{id:29010,qty:1},{id:29004,qty:1},{id:29007,qty:1},{id:29000,qty:1}] },
  { key:"set-torva",        id:31145, name:"Torva armour set",        cat:"Sets", components:[{id:26382,qty:1},{id:26384,qty:1},{id:26386,qty:1}] },
  { key:"set-virtus",       id:31148, name:"Virtus armour set",       cat:"Sets", components:[{id:26241,qty:1},{id:26243,qty:1},{id:26245,qty:1}] },
  { key:"set-masori-f",     id:27355, name:"Masori armour set (f)",   cat:"Sets", components:[{id:27235,qty:1},{id:27238,qty:1},{id:27241,qty:1}] },
  { key:"set-justiciar",    id:22438, name:"Justiciar armour set",    cat:"Sets", components:[{id:22326,qty:1},{id:22327,qty:1},{id:22328,qty:1}] },
  { key:"set-inquisitor",   id:24488, name:"Inquisitor's armour set", cat:"Sets", components:[{id:24419,qty:1},{id:24420,qty:1},{id:24421,qty:1}] },

  // === Item sets pulled from wiki Item_set page (100 entries) ===
  // --- Standard metal (lg/sk) ---
  { key:"set-adamant-lg",   id:13012, name:"Adamant set (lg)",          cat:"Sets", components:[{id:1161,qty:1},{id:1123,qty:1},{id:1073,qty:1},{id:1199,qty:1}] },
  { key:"set-adamant-sk",   id:13014, name:"Adamant set (sk)",          cat:"Sets", components:[{id:1161,qty:1},{id:1123,qty:1},{id:1091,qty:1},{id:1199,qty:1}] },
  { key:"set-black-lg",     id:12988, name:"Black set (lg)",            cat:"Sets", components:[{id:1165,qty:1},{id:1125,qty:1},{id:1077,qty:1},{id:1195,qty:1}] },
  { key:"set-black-sk",     id:12990, name:"Black set (sk)",            cat:"Sets", components:[{id:1165,qty:1},{id:1125,qty:1},{id:1089,qty:1},{id:1195,qty:1}] },
  { key:"set-bronze-lg",    id:12960, name:"Bronze set (lg)",           cat:"Sets", components:[{id:1155,qty:1},{id:1117,qty:1},{id:1075,qty:1},{id:1189,qty:1}] },
  { key:"set-bronze-sk",    id:12962, name:"Bronze set (sk)",           cat:"Sets", components:[{id:1155,qty:1},{id:1117,qty:1},{id:1087,qty:1},{id:1189,qty:1}] },
  { key:"set-dragon-lg",    id:21882, name:"Dragon armour set (lg)",    cat:"Sets", components:[{id:11335,qty:1},{id:21892,qty:1},{id:4087,qty:1},{id:21895,qty:1}] },
  { key:"set-dragon-sk",    id:21885, name:"Dragon armour set (sk)",    cat:"Sets", components:[{id:11335,qty:1},{id:21892,qty:1},{id:4585,qty:1},{id:21895,qty:1}] },
  { key:"set-gilded-lg",    id:13036, name:"Gilded armour set (lg)",    cat:"Sets", components:[{id:3486,qty:1},{id:3481,qty:1},{id:3483,qty:1},{id:3488,qty:1}] },
  { key:"set-gilded-sk",    id:13038, name:"Gilded armour set (sk)",    cat:"Sets", components:[{id:3486,qty:1},{id:3481,qty:1},{id:3485,qty:1},{id:3488,qty:1}] },
  { key:"set-guthix-lg",    id:13048, name:"Guthix armour set (lg)",    cat:"Sets", components:[{id:2673,qty:1},{id:2669,qty:1},{id:2671,qty:1},{id:2675,qty:1}] },
  { key:"set-guthix-sk",    id:13050, name:"Guthix armour set (sk)",    cat:"Sets", components:[{id:2673,qty:1},{id:2669,qty:1},{id:3480,qty:1},{id:2675,qty:1}] },
  { key:"set-iron-lg",      id:12972, name:"Iron set (lg)",             cat:"Sets", components:[{id:1153,qty:1},{id:1115,qty:1},{id:1067,qty:1},{id:1191,qty:1}] },
  { key:"set-iron-sk",      id:12974, name:"Iron set (sk)",             cat:"Sets", components:[{id:1153,qty:1},{id:1115,qty:1},{id:1081,qty:1},{id:1191,qty:1}] },
  { key:"set-mithril-lg",   id:13000, name:"Mithril set (lg)",          cat:"Sets", components:[{id:1159,qty:1},{id:1121,qty:1},{id:1071,qty:1},{id:1197,qty:1}] },
  { key:"set-mithril-sk",   id:13002, name:"Mithril set (sk)",          cat:"Sets", components:[{id:1159,qty:1},{id:1121,qty:1},{id:1085,qty:1},{id:1197,qty:1}] },
  { key:"set-rune-lg",      id:13024, name:"Rune armour set (lg)",      cat:"Sets", components:[{id:1163,qty:1},{id:1127,qty:1},{id:1079,qty:1},{id:1201,qty:1}] },
  { key:"set-rune-sk",      id:13026, name:"Rune armour set (sk)",      cat:"Sets", components:[{id:1163,qty:1},{id:1127,qty:1},{id:1093,qty:1},{id:1201,qty:1}] },
  { key:"set-saradomin-lg", id:13040, name:"Saradomin armour set (lg)", cat:"Sets", components:[{id:2665,qty:1},{id:2661,qty:1},{id:2663,qty:1},{id:2667,qty:1}] },
  { key:"set-saradomin-sk", id:13042, name:"Saradomin armour set (sk)", cat:"Sets", components:[{id:2665,qty:1},{id:2661,qty:1},{id:3479,qty:1},{id:2667,qty:1}] },
  { key:"set-steel-lg",     id:12984, name:"Steel set (lg)",            cat:"Sets", components:[{id:1157,qty:1},{id:1119,qty:1},{id:1069,qty:1},{id:1193,qty:1}] },
  { key:"set-steel-sk",     id:12986, name:"Steel set (sk)",            cat:"Sets", components:[{id:1157,qty:1},{id:1119,qty:1},{id:1083,qty:1},{id:1193,qty:1}] },
  { key:"set-zamorak-lg",   id:13044, name:"Zamorak armour set (lg)",   cat:"Sets", components:[{id:2657,qty:1},{id:2653,qty:1},{id:2655,qty:1},{id:2659,qty:1}] },
  { key:"set-zamorak-sk",   id:13046, name:"Zamorak armour set (sk)",   cat:"Sets", components:[{id:2657,qty:1},{id:2653,qty:1},{id:3478,qty:1},{id:2659,qty:1}] },

  // --- Trimmed metal ---
  { key:"set-adamant-trimmed-lg", id:13016, name:"Adamant trimmed set (lg)", cat:"Sets", components:[{id:2605,qty:1},{id:2599,qty:1},{id:2601,qty:1},{id:2603,qty:1}] },
  { key:"set-adamant-trimmed-sk", id:13018, name:"Adamant trimmed set (sk)", cat:"Sets", components:[{id:2605,qty:1},{id:2599,qty:1},{id:3474,qty:1},{id:2603,qty:1}] },
  { key:"set-black-trimmed-lg",   id:12992, name:"Black trimmed set (lg)",   cat:"Sets", components:[{id:2587,qty:1},{id:2583,qty:1},{id:2585,qty:1},{id:2589,qty:1}] },
  { key:"set-black-trimmed-sk",   id:12994, name:"Black trimmed set (sk)",   cat:"Sets", components:[{id:2587,qty:1},{id:2583,qty:1},{id:3472,qty:1},{id:2589,qty:1}] },
  { key:"set-bronze-trimmed-lg",  id:12964, name:"Bronze trimmed set (lg)",  cat:"Sets", components:[{id:12221,qty:1},{id:12215,qty:1},{id:12217,qty:1},{id:12223,qty:1}] },
  { key:"set-bronze-trimmed-sk",  id:12966, name:"Bronze trimmed set (sk)",  cat:"Sets", components:[{id:12221,qty:1},{id:12215,qty:1},{id:12219,qty:1},{id:12223,qty:1}] },
  { key:"set-iron-trimmed-lg",    id:12976, name:"Iron trimmed set (lg)",    cat:"Sets", components:[{id:12231,qty:1},{id:12225,qty:1},{id:12227,qty:1},{id:12233,qty:1}] },
  { key:"set-iron-trimmed-sk",    id:12978, name:"Iron trimmed set (sk)",    cat:"Sets", components:[{id:12231,qty:1},{id:12225,qty:1},{id:12229,qty:1},{id:12233,qty:1}] },
  { key:"set-mithril-trimmed-lg", id:13004, name:"Mithril trimmed set (lg)", cat:"Sets", components:[{id:12293,qty:1},{id:12287,qty:1},{id:12289,qty:1},{id:12291,qty:1}] },
  { key:"set-mithril-trimmed-sk", id:13006, name:"Mithril trimmed set (sk)", cat:"Sets", components:[{id:12293,qty:1},{id:12287,qty:1},{id:12295,qty:1},{id:12291,qty:1}] },
  { key:"set-rune-trimmed-lg",    id:13028, name:"Rune trimmed set (lg)",    cat:"Sets", components:[{id:2627,qty:1},{id:2623,qty:1},{id:2625,qty:1},{id:2629,qty:1}] },
  { key:"set-rune-trimmed-sk",    id:13030, name:"Rune trimmed set (sk)",    cat:"Sets", components:[{id:2627,qty:1},{id:2623,qty:1},{id:3477,qty:1},{id:2629,qty:1}] },
  { key:"set-steel-trimmed-lg",   id:20376, name:"Steel trimmed set (lg)",   cat:"Sets", components:[{id:20193,qty:1},{id:20184,qty:1},{id:20187,qty:1},{id:20196,qty:1}] },
  { key:"set-steel-trimmed-sk",   id:20379, name:"Steel trimmed set (sk)",   cat:"Sets", components:[{id:20193,qty:1},{id:20184,qty:1},{id:20190,qty:1},{id:20196,qty:1}] },

  // --- Gold-trimmed metal ---
  { key:"set-adamant-gold-trimmed-lg", id:13020, name:"Adamant gold-trimmed set (lg)", cat:"Sets", components:[{id:2613,qty:1},{id:2607,qty:1},{id:2609,qty:1},{id:2611,qty:1}] },
  { key:"set-adamant-gold-trimmed-sk", id:13022, name:"Adamant gold-trimmed set (sk)", cat:"Sets", components:[{id:2613,qty:1},{id:2607,qty:1},{id:3475,qty:1},{id:2611,qty:1}] },
  { key:"set-black-gold-trimmed-lg",   id:12996, name:"Black gold-trimmed set (lg)",   cat:"Sets", components:[{id:2595,qty:1},{id:2591,qty:1},{id:2593,qty:1},{id:2597,qty:1}] },
  { key:"set-black-gold-trimmed-sk",   id:12998, name:"Black gold-trimmed set (sk)",   cat:"Sets", components:[{id:2595,qty:1},{id:2591,qty:1},{id:3473,qty:1},{id:2597,qty:1}] },
  { key:"set-bronze-gold-trimmed-lg",  id:12968, name:"Bronze gold-trimmed set (lg)",  cat:"Sets", components:[{id:12211,qty:1},{id:12205,qty:1},{id:12207,qty:1},{id:12213,qty:1}] },
  { key:"set-bronze-gold-trimmed-sk",  id:12970, name:"Bronze gold-trimmed set (sk)",  cat:"Sets", components:[{id:12211,qty:1},{id:12205,qty:1},{id:12209,qty:1},{id:12213,qty:1}] },
  { key:"set-iron-gold-trimmed-lg",    id:12980, name:"Iron gold-trimmed set (lg)",    cat:"Sets", components:[{id:12241,qty:1},{id:12235,qty:1},{id:12237,qty:1},{id:12243,qty:1}] },
  { key:"set-iron-gold-trimmed-sk",    id:12982, name:"Iron gold-trimmed set (sk)",    cat:"Sets", components:[{id:12241,qty:1},{id:12235,qty:1},{id:12239,qty:1},{id:12243,qty:1}] },
  { key:"set-mithril-gold-trimmed-lg", id:13008, name:"Mithril gold-trimmed set (lg)", cat:"Sets", components:[{id:12283,qty:1},{id:12277,qty:1},{id:12279,qty:1},{id:12281,qty:1}] },
  { key:"set-mithril-gold-trimmed-sk", id:13010, name:"Mithril gold-trimmed set (sk)", cat:"Sets", components:[{id:12283,qty:1},{id:12277,qty:1},{id:12285,qty:1},{id:12281,qty:1}] },
  { key:"set-rune-gold-trimmed-lg",    id:13032, name:"Rune gold-trimmed set (lg)",    cat:"Sets", components:[{id:2619,qty:1},{id:2615,qty:1},{id:2617,qty:1},{id:2621,qty:1}] },
  { key:"set-rune-gold-trimmed-sk",    id:13034, name:"Rune gold-trimmed set (sk)",    cat:"Sets", components:[{id:2619,qty:1},{id:2615,qty:1},{id:3476,qty:1},{id:2621,qty:1}] },
  { key:"set-steel-gold-trimmed-lg",   id:20382, name:"Steel gold-trimmed set (lg)",   cat:"Sets", components:[{id:20178,qty:1},{id:20169,qty:1},{id:20172,qty:1},{id:20181,qty:1}] },
  { key:"set-steel-gold-trimmed-sk",   id:20385, name:"Steel gold-trimmed set (sk)",   cat:"Sets", components:[{id:20178,qty:1},{id:20169,qty:1},{id:20175,qty:1},{id:20181,qty:1}] },

  // --- God rune armour ---
  { key:"set-ancient-rune-lg", id:13060, name:"Ancient rune armour set (lg)", cat:"Sets", components:[{id:12466,qty:1},{id:12460,qty:1},{id:12462,qty:1},{id:12468,qty:1}] },
  { key:"set-ancient-rune-sk", id:13062, name:"Ancient rune armour set (sk)", cat:"Sets", components:[{id:12466,qty:1},{id:12460,qty:1},{id:12464,qty:1},{id:12468,qty:1}] },
  { key:"set-armadyl-rune-lg", id:13052, name:"Armadyl rune armour set (lg)", cat:"Sets", components:[{id:12476,qty:1},{id:12470,qty:1},{id:12472,qty:1},{id:12478,qty:1}] },
  { key:"set-armadyl-rune-sk", id:13054, name:"Armadyl rune armour set (sk)", cat:"Sets", components:[{id:12476,qty:1},{id:12470,qty:1},{id:12474,qty:1},{id:12478,qty:1}] },
  { key:"set-bandos-rune-lg",  id:13056, name:"Bandos rune armour set (lg)",  cat:"Sets", components:[{id:12486,qty:1},{id:12480,qty:1},{id:12482,qty:1},{id:12488,qty:1}] },
  { key:"set-bandos-rune-sk",  id:13058, name:"Bandos rune armour set (sk)",  cat:"Sets", components:[{id:12486,qty:1},{id:12480,qty:1},{id:12484,qty:1},{id:12488,qty:1}] },

  // --- Dragonhide ---
  { key:"set-ancient-dragonhide",   id:13171, name:"Ancient dragonhide set",   cat:"Sets", components:[{id:12496,qty:1},{id:12492,qty:1},{id:12494,qty:1},{id:12490,qty:1}] },
  { key:"set-armadyl-dragonhide",   id:13169, name:"Armadyl dragonhide set",   cat:"Sets", components:[{id:12512,qty:1},{id:12508,qty:1},{id:12510,qty:1},{id:12506,qty:1}] },
  { key:"set-bandos-dragonhide",    id:13167, name:"Bandos dragonhide set",    cat:"Sets", components:[{id:12504,qty:1},{id:12500,qty:1},{id:12502,qty:1},{id:12498,qty:1}] },
  { key:"set-black-dragonhide",     id:12871, name:"Black dragonhide set",     cat:"Sets", components:[{id:2503,qty:1},{id:2497,qty:1},{id:2491,qty:1}] },
  { key:"set-blue-dragonhide",      id:12867, name:"Blue dragonhide set",      cat:"Sets", components:[{id:2499,qty:1},{id:2493,qty:1},{id:2487,qty:1}] },
  { key:"set-gilded-dragonhide",    id:23124, name:"Gilded dragonhide set",    cat:"Sets", components:[{id:23264,qty:1},{id:23267,qty:1},{id:23261,qty:1}] },
  { key:"set-green-dragonhide",     id:12865, name:"Green dragonhide set",     cat:"Sets", components:[{id:1135,qty:1},{id:1099,qty:1},{id:1065,qty:1}] },
  { key:"set-guthix-dragonhide",    id:13165, name:"Guthix dragonhide set",    cat:"Sets", components:[{id:10382,qty:1},{id:10378,qty:1},{id:10380,qty:1},{id:10376,qty:1}] },
  { key:"set-red-dragonhide",       id:12869, name:"Red dragonhide set",       cat:"Sets", components:[{id:2501,qty:1},{id:2495,qty:1},{id:2489,qty:1}] },
  { key:"set-saradomin-dragonhide", id:13163, name:"Saradomin dragonhide set", cat:"Sets", components:[{id:10390,qty:1},{id:10386,qty:1},{id:10388,qty:1},{id:10384,qty:1}] },
  { key:"set-zamorak-dragonhide",   id:13161, name:"Zamorak dragonhide set",   cat:"Sets", components:[{id:10374,qty:1},{id:10370,qty:1},{id:10372,qty:1},{id:10368,qty:1}] },

  // --- Mystic ---
  { key:"set-mystic-blue",  id:23113, name:"Mystic set (blue)",  cat:"Sets", components:[{id:4089,qty:1},{id:4091,qty:1},{id:4093,qty:1},{id:4095,qty:1},{id:4097,qty:1}] },
  { key:"set-mystic-dark",  id:23116, name:"Mystic set (dark)",  cat:"Sets", components:[{id:4099,qty:1},{id:4101,qty:1},{id:4103,qty:1},{id:4105,qty:1},{id:4107,qty:1}] },
  { key:"set-mystic-dusk",  id:23119, name:"Mystic set (dusk)",  cat:"Sets", components:[{id:23047,qty:1},{id:23050,qty:1},{id:23053,qty:1},{id:23056,qty:1},{id:23059,qty:1}] },
  { key:"set-mystic-light", id:23110, name:"Mystic set (light)", cat:"Sets", components:[{id:4109,qty:1},{id:4111,qty:1},{id:4113,qty:1},{id:4115,qty:1},{id:4117,qty:1}] },

  // --- Bark (magic) ---
  { key:"set-bloodbark", id:31163, name:"Bloodbark armour set", cat:"Sets", components:[{id:25413,qty:1},{id:25404,qty:1},{id:25416,qty:1},{id:25407,qty:1},{id:25410,qty:1}] },
  { key:"set-swampbark", id:31160, name:"Swampbark armour set", cat:"Sets", components:[{id:25398,qty:1},{id:25389,qty:1},{id:25401,qty:1},{id:25392,qty:1},{id:25395,qty:1}] },

  // --- Fremennik (Rellekka) ---
  { key:"set-mixed-hide", id:31166, name:"Mixed hide armour set", cat:"Sets", components:[{id:29280,qty:1},{id:29283,qty:1},{id:29286,qty:1},{id:29289,qty:1}] },
  { key:"set-rock-shell", id:31151, name:"Rock-shell armour set", cat:"Sets", components:[{id:6128,qty:1},{id:6129,qty:1},{id:6130,qty:1},{id:6149,qty:1},{id:6143,qty:1}] },
  { key:"set-skeletal",   id:31154, name:"Skeletal armour set",   cat:"Sets", components:[{id:6137,qty:1},{id:6139,qty:1},{id:6141,qty:1},{id:6153,qty:1},{id:6147,qty:1}] },
  { key:"set-spined",     id:31157, name:"Spined armour set",     cat:"Sets", components:[{id:6131,qty:1},{id:6133,qty:1},{id:6135,qty:1},{id:6149,qty:1},{id:6143,qty:1}] },

  // --- Book pages ---
  { key:"set-book-of-balance-page",  id:13153, name:"Book of balance page set",  cat:"Sets", components:[{id:3835,qty:1},{id:3836,qty:1},{id:3837,qty:1},{id:3838,qty:1}] },
  { key:"set-book-of-darkness-page", id:13159, name:"Book of darkness page set", cat:"Sets", components:[{id:12621,qty:1},{id:12622,qty:1},{id:12623,qty:1},{id:12624,qty:1}] },
  { key:"set-book-of-law-page",      id:13157, name:"Book of law page set",      cat:"Sets", components:[{id:12617,qty:1},{id:12618,qty:1},{id:12619,qty:1},{id:12620,qty:1}] },
  { key:"set-book-of-war-page",      id:13155, name:"Book of war page set",      cat:"Sets", components:[{id:12613,qty:1},{id:12614,qty:1},{id:12615,qty:1},{id:12616,qty:1}] },
  { key:"set-holy-book-page",        id:13149, name:"Holy book page set",        cat:"Sets", components:[{id:3827,qty:1},{id:3828,qty:1},{id:3829,qty:1},{id:3830,qty:1}] },
  { key:"set-unholy-book-page",      id:13151, name:"Unholy book page set",      cat:"Sets", components:[{id:3831,qty:1},{id:3832,qty:1},{id:3833,qty:1},{id:3834,qty:1}] },

  // --- Holiday (rares) ---
  { key:"set-halloween-mask", id:13175, name:"Halloween mask set", cat:"Sets", components:[{id:1057,qty:1},{id:1053,qty:1},{id:1055,qty:1}] },
  { key:"set-partyhat",       id:13173, name:"Partyhat set",       cat:"Sets", components:[{id:1038,qty:1},{id:1040,qty:1},{id:1042,qty:1},{id:1046,qty:1},{id:1044,qty:1},{id:1048,qty:1}] },

  // --- Temple Knight (Initiate / Proselyte) ---
  { key:"set-initiate-harness-m",  id: 9668, name:"Initiate harness m",  cat:"Sets", components:[{id:5574,qty:1},{id:5575,qty:1},{id:5576,qty:1}] },
  { key:"set-proselyte-harness-f", id: 9670, name:"Proselyte harness f", cat:"Sets", components:[{id:9672,qty:1},{id:9674,qty:1},{id:9678,qty:1}] },
  { key:"set-proselyte-harness-m", id: 9666, name:"Proselyte harness m", cat:"Sets", components:[{id:9672,qty:1},{id:9674,qty:1},{id:9676,qty:1}] },

  // --- Potion sets ---
  { key:"set-combat-potion", id:13064, name:"Combat potion set", cat:"Sets", components:[{id:2428,qty:1},{id:113,qty:1},{id:2432,qty:1}] },
  { key:"set-super-potion",  id:13066, name:"Super potion set",  cat:"Sets", components:[{id:2436,qty:1},{id:2440,qty:1},{id:2442,qty:1}] },

  // --- Cannon ---
  { key:"set-dwarf-cannon", id:12863, name:"Dwarf cannon set", cat:"Sets", components:[{id:6,qty:1},{id:8,qty:1},{id:10,qty:1},{id:12,qty:1}] },

  // --- High-tier / misc ---
  { key:"set-ancestral-robes", id:21049, name:"Ancestral robes set",        cat:"Sets", components:[{id:21018,qty:1},{id:21021,qty:1},{id:21024,qty:1}] },
  { key:"set-dagonhai-robes",  id:24333, name:"Dagon'hai robes set",        cat:"Sets", components:[{id:24288,qty:1},{id:24291,qty:1},{id:24294,qty:1}] },
  { key:"set-dragonstone",     id:23667, name:"Dragonstone armour set",     cat:"Sets", components:[{id:24034,qty:1},{id:24037,qty:1},{id:24040,qty:1},{id:24046,qty:1},{id:24043,qty:1}] },
  { key:"set-hueycoatl-hide",  id:31169, name:"Hueycoatl hide armour set",  cat:"Sets", components:[{id:30073,qty:1},{id:30076,qty:1},{id:30079,qty:1},{id:30082,qty:1}] },
  { key:"set-oathplate",       id:30744, name:"Oathplate armour set",       cat:"Sets", components:[{id:30750,qty:1},{id:30753,qty:1},{id:30756,qty:1}] },
  { key:"set-obsidian",        id:21279, name:"Obsidian armour set",        cat:"Sets", components:[{id:21298,qty:1},{id:21301,qty:1},{id:21304,qty:1}] },
  { key:"set-sunfire-fanatic", id:29424, name:"Sunfire fanatic armour set", cat:"Sets", components:[{id:28933,qty:1},{id:28936,qty:1},{id:28939,qty:1}] },

  // --- Barrows Repairs (broken → repaired) ---
  { key:"ahrh", id:4708, name:"Ahrim's hood",       cat:"Barrows", components:[{id:4860,qty:1}], repairBase:60_000 },
  { key:"ahrt", id:4712, name:"Ahrim's robetop",    cat:"Barrows", components:[{id:4872,qty:1}], repairBase:90_000 },
  { key:"ahrs", id:4714, name:"Ahrim's robeskirt",  cat:"Barrows", components:[{id:4878,qty:1}], repairBase:80_000 },
  { key:"ahrst",id:4710, name:"Ahrim's staff",      cat:"Barrows", components:[{id:4866,qty:1}], repairBase:100_000 },
  { key:"dhh",  id:4716, name:"Dharok's helm",      cat:"Barrows", components:[{id:4884,qty:1}], repairBase:60_000 },
  { key:"dhpb", id:4720, name:"Dharok's platebody", cat:"Barrows", components:[{id:4896,qty:1}], repairBase:90_000 },
  { key:"dhpl", id:4722, name:"Dharok's platelegs", cat:"Barrows", components:[{id:4902,qty:1}], repairBase:80_000 },
  { key:"dhga", id:4718, name:"Dharok's greataxe",  cat:"Barrows", components:[{id:4890,qty:1}], repairBase:100_000 },
  { key:"guh",  id:4724, name:"Guthan's helm",      cat:"Barrows", components:[{id:4908,qty:1}], repairBase:60_000 },
  { key:"gupb", id:4728, name:"Guthan's platebody", cat:"Barrows", components:[{id:4920,qty:1}], repairBase:90_000 },
  { key:"gucs", id:4730, name:"Guthan's chainskirt",cat:"Barrows", components:[{id:4926,qty:1}], repairBase:80_000 },
  { key:"guws", id:4726, name:"Guthan's warspear",  cat:"Barrows", components:[{id:4914,qty:1}], repairBase:100_000 },
  { key:"kah",  id:4732, name:"Karil's coif",       cat:"Barrows", components:[{id:4932,qty:1}], repairBase:60_000 },
  { key:"katop",id:4736, name:"Karil's leathertop", cat:"Barrows", components:[{id:4944,qty:1}], repairBase:90_000 },
  { key:"kask", id:4738, name:"Karil's leatherskirt",cat:"Barrows", components:[{id:4950,qty:1}], repairBase:80_000 },
  { key:"kacb", id:4734, name:"Karil's crossbow",   cat:"Barrows", components:[{id:4938,qty:1}], repairBase:100_000 },
  { key:"toh",  id:4745, name:"Torag's helm",       cat:"Barrows", components:[{id:4956,qty:1}], repairBase:60_000 },
  { key:"topb", id:4749, name:"Torag's platebody",  cat:"Barrows", components:[{id:4968,qty:1}], repairBase:90_000 },
  { key:"topl", id:4751, name:"Torag's platelegs",  cat:"Barrows", components:[{id:4974,qty:1}], repairBase:80_000 },
  { key:"toh2", id:4747, name:"Torag's hammers",    cat:"Barrows", components:[{id:4962,qty:1}], repairBase:100_000 },
  { key:"veh",  id:4753, name:"Verac's helm",       cat:"Barrows", components:[{id:4980,qty:1}], repairBase:60_000 },
  { key:"vebr", id:4757, name:"Verac's brassard",   cat:"Barrows", components:[{id:4992,qty:1}], repairBase:90_000 },
  { key:"vesk", id:4759, name:"Verac's plateskirt", cat:"Barrows", components:[{id:4998,qty:1}], repairBase:80_000 },
  { key:"vefl", id:4755, name:"Verac's flail",      cat:"Barrows", components:[{id:4986,qty:1}], repairBase:100_000 },

  // --- Moon Armor Repairs ---
  { key:"bmh",  id:29028, name:"Blood moon helm",         cat:"Moons", components:[{id:29073,qty:1}], repairBase:1_500_000 },
  { key:"bmc",  id:29022, name:"Blood moon chestplate",   cat:"Moons", components:[{id:29067,qty:1}], repairBase:1_500_000 },
  { key:"bmt",  id:29025, name:"Blood moon tassets",      cat:"Moons", components:[{id:29070,qty:1}], repairBase:1_500_000 },
  { key:"blh",  id:29019, name:"Blue moon helm",          cat:"Moons", components:[{id:29064,qty:1}], repairBase:1_500_000 },
  { key:"blc",  id:29013, name:"Blue moon chestplate",    cat:"Moons", components:[{id:29058,qty:1}], repairBase:1_500_000 },
  { key:"blt",  id:29016, name:"Blue moon tassets",       cat:"Moons", components:[{id:29061,qty:1}], repairBase:1_500_000 },
  { key:"emh",  id:29010, name:"Eclipse moon helm",       cat:"Moons", components:[{id:29055,qty:1}], repairBase:1_500_000 },
  { key:"emc",  id:29004, name:"Eclipse moon chestplate", cat:"Moons", components:[{id:29049,qty:1}], repairBase:1_500_000 },
  { key:"emt",  id:29007, name:"Eclipse moon tassets",    cat:"Moons", components:[{id:29052,qty:1}], repairBase:1_500_000 },

  // --- Sailing: ship parts & cosmetics ---
  { key:"aquanite-hopper", id:32879, name:"Aquanite hopper", cat:"Sailing", components:[{id:32876,qty:1},{id:2359,qty:1}] },
  { key:"dragon-keel-parts", id:32017, name:"Dragon keel parts", cat:"Sailing", components:[{id:31996,qty:2}] },
  { key:"large-dragon-keel-parts", id:32038, name:"Large dragon keel parts — via keel parts", cat:"Sailing", components:[{id:32017,qty:2}] },
  { key:"large-dragon-keel-parts-sheets", id:32038, name:"Large dragon keel parts — via metal sheets", cat:"Sailing", components:[{id:31996,qty:4}] },
  { key:"merchants-paint", id:32110, name:"Merchant's paint", cat:"Sailing", components:[{id:32090,qty:1},{id:32093,qty:1},{id:32087,qty:1},{id:32099,qty:1},{id:32096,qty:1}] },

  // --- Oathplate armour: smithed from crushed infernal shale + oathplate shards ---
  // `takesTime: true` = active crafting required (~ a few minutes per piece),
  // not a click-and-go GE-clerk combine. The allocator's "hide non-instant
  // combines" filter drops these when the user only wants zero-time flips.
  // Both inputs are components (both are bought at the GE to combine into
  // the output). Crushed infernal shale is in FREE_SLOT_ITEM_IDS so when
  // the "Filler intermediates don't consume slots" toggle is on, the shale
  // buy skips the slot count — small margin, trades fast enough that its
  // slot use is effectively zero.
  { key:"oathplate-helm", id:30750, name:"Oathplate helm", cat:"Oathplate", takesTime:true, components:[{id:30848,qty:2520},{id:30765,qty:450}] },
  { key:"oathplate-chest", id:30753, name:"Oathplate chest", cat:"Oathplate", takesTime:true, components:[{id:30848,qty:2520},{id:30765,qty:450}] },
  { key:"oathplate-legs", id:30756, name:"Oathplate legs", cat:"Oathplate", takesTime:true, components:[{id:30848,qty:2520},{id:30765,qty:450}] },

  // ====================================================================
  // Skilling recipes — optional schema fields:
  //   skill, level, xp, ticks (and optional xpPerHourMax for methods where
  //   the wiki publishes a measured rate that exceeds tick-perfect estimates).
  // Smithing recipes are scraped from the OSRS wiki by
  // scripts/scrape-smithing.mjs and live in dist/skilling-recipes.js. The
  // generated array is concatenated below at module load time.
  // ====================================================================
];
if (typeof SKILLING_RECIPES !== "undefined" && Array.isArray(SKILLING_RECIPES)) {
  RECIPES.push(...SKILLING_RECIPES);
}

// Free-slot filler classification. NARROW hand-curated set of small-margin
// intermediates that fit the "small fraction of parent craft cost, buys
// quickly, consistent price" description. Godsword blade (~20% of a
// godsword), Blessed spirit shield (~2-5% of Arcane/Elysian), Zamorakian
// hasta (simple 1-buy conversion). EMPHATICALLY NOT armour sets, Zenyte
// jewellery, Barrows pieces, spirit shields, uncharged weapons — those
// are substantial crafts in their own right.
//
// Recipes opt in via `freeSlotFiller: true` in the recipe definition. The
// allocator's "Filler intermediates don't consume slots" toggle uses THIS
// set (not the broader "output is a component elsewhere" heuristic).
function isFreeSlotFiller(recipe) {
  return recipe.freeSlotFiller === true;
}
function freeSlotFillerRecipes() {
  return RECIPES
    .filter(r => r.freeSlotFiller === true)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ITEM-LEVEL free-slot set. Some raw materials are bulk-liquid enough that
// their purchase doesn't meaningfully tie up a GE slot — you place the buy,
// it fills instantly. When the "Filler intermediates" toggle is on, any
// recipe's slotsPerUnit is reduced by the number of components/supplies
// whose ID is in this set. Distinct concept from freeSlotFiller (recipe
// vs item level) but shares the same "fast-fill, doesn't hold a slot"
// intuition.
//
// Hand-curated. Add sparingly — misclassifying a slow-fill item here
// over-counts feasibility.
const FREE_SLOT_ITEM_IDS = new Set([
  30848,   // Crushed infernal shale — bulk raw material for Oathplate crafting
]);

// Auto-derived: a filler RECIPE's output item ID also gets the fast-fill
// treatment. Example: godsword-blade recipe is flagged freeSlotFiller, so
// item id 11798 (godsword blade) is a fast-fill component of Armadyl
// godsword / Bandos godsword / etc. Keeps the popover-visible filler
// classification in sync with the item-level exemption applied inside
// parent crafts — otherwise you'd have to hand-mirror every filler recipe
// with its output id in FREE_SLOT_ITEM_IDS.
const _fillerRecipeByOutputId = new Map();
for (const r of RECIPES) {
  if (r.freeSlotFiller === true) _fillerRecipeByOutputId.set(r.id, r);
}
// Effective test: "is this item's purchase a fast-fill (skip slot) event?"
// Combines explicit FREE_SLOT_ITEM_IDS + filler recipe outputs, respecting
// user overrides. Called in the allocator when computing slotsPerUnit and
// in the popover when rendering the item row's checkbox state.
function isFastFillComponent(id) {
  // User manually removed from fast-fill pool
  if (state.excludedFreeSlotItems.has(String(id))) return false;
  // Explicit item-level membership
  if (FREE_SLOT_ITEM_IDS.has(id)) return true;
  // Auto-membership via a filler recipe whose output is this item id — but
  // only if the recipe itself hasn't been excluded (unchecking the recipe
  // in the popover cascades to remove its item's fast-fill treatment too).
  const filler = _fillerRecipeByOutputId.get(id);
  if (filler && !state.excludedRecipes.has(filler.key)) return true;
  return false;
}

// LEGACY wider classifier — kept for reference and any future use case that
// wants "any intermediate feeding a non-skilling combine". No longer drives
// the free-slot toggle (too broad — see freeSlotFillerRecipes above).
const _componentItemIds = new Set();
for (const r of RECIPES) {
  if (r.skill) continue;
  for (const c of r.components || []) _componentItemIds.add(c.id);
}
function isComponentProducingRecipe(recipe) {
  return _componentItemIds.has(recipe.id);
}
function componentCombineRecipes() {
  return RECIPES
    .filter(r => _componentItemIds.has(r.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- Skill requirements ----------------
   Skill level needed to perform the combination, sourced from the OSRS
   Wiki {{Recipe}} templates. Keyed by recipe key. Trivial level-1 gates
   (e.g. stringing an amulet) are omitted — only meaningful gates listed.
   GE-clerk set exchanges, repairs, and decombines need no skill so are absent.
---------------------------------------------------- */
const SKILL_REQS = {
  "dragon-crossbow":             "78 Fletching",
  "dragon-crossbow-craft":       "78 Fletching",
  "dragon-crossbow-u":           "78 Fletching",
  "dragon-kiteshield":           "75 Smithing",
  "dragon-platebody":            "90 Smithing",
  "dragon-sq-shield":            "60 Smithing",
  "godsword-blade":              "80 Smithing",
  "masori-mask-f-helmet":        "90 Crafting",
  "masori-mask-f-plate":         "90 Crafting",
  "masori-body-f-chestplate":    "90 Crafting",
  "masori-body-f-helmet":        "90 Crafting",
  "masori-body-f-plate":         "90 Crafting",
  "masori-chaps-f-chainskirt":   "90 Crafting",
  "masori-chaps-f-helmet":       "90 Crafting",
  "masori-chaps-f-plate":        "90 Crafting",
  "armadylean-plate-helmet":     "90 Crafting",
  "armadylean-plate-chestplate": "90 Crafting",
  "armadylean-plate-chainskirt": "90 Crafting",
  "ancient-wyvern-shield":       "66 Smithing + 66 Magic",
  "amulet-of-fury":              "87 Magic",
  "dragonfire-shield":           "90 Smithing",
  "dragonfire-ward":             "90 Smithing",
  "berserker-necklace":          "87 Magic",
  "onyx-amulet-u":               "90 Crafting",
  "onyx-bracelet":               "84 Crafting",
  "onyx-necklace":               "82 Crafting",
  "onyx-ring":                   "67 Crafting",
  "ring-of-stone":               "87 Magic",
  "heavy-ballista":              "72 Fletching",
  "incomplete-heavy-ballista":   "72 Fletching",
  "incomplete-light-ballista":   "47 Fletching",
  "light-ballista":              "47 Fletching",
  "unstrung-heavy-ballista":     "72 Fletching",
  "unstrung-light-ballista":     "47 Fletching",
  "huey-coif":                   "76 Crafting",
  "huey-body":                   "78 Crafting",
  "huey-chaps":                  "77 Crafting",
  "huey-vambraces":              "76 Crafting",
  "arcane-spirit-shield":        "90 Prayer + 85 Smithing",
  "blessed-spirit-shield":       "85 Prayer",
  "elysian-spirit-shield":       "90 Prayer + 85 Smithing",
  "spectral-spirit-shield":      "90 Prayer + 85 Smithing",
  "torva-helm-components":       "90 Smithing",
  "torva-helm-tassets":          "90 Smithing",
  "torva-helm-chestplate":       "90 Smithing",
  "torva-body-components":       "90 Smithing",
  "torva-body-tassets":          "90 Smithing",
  "torva-body-chestplate":       "90 Smithing",
  "torva-legs-components":       "90 Smithing",
  "torva-legs-tassets":          "90 Smithing",
  "torva-legs-chestplate":       "90 Smithing",
  "eternal-boots":               "60 Magic + 60 Runecraft",
  "pegasian-boots":              "60 Magic + 60 Runecraft",
  "primordial-boots":            "60 Magic + 60 Runecraft",
  "amulet-of-torture":           "93 Magic",
  "necklace-of-anguish":         "93 Magic",
  "ring-of-suffering":           "93 Magic",
  "tormented-bracelet":          "93 Magic",
  "uncut-zenyte":                "70 Crafting",
  "zenyte-amulet-u":             "98 Crafting",
  "zenyte-bracelet":             "95 Crafting",
  "zenyte-necklace":             "92 Crafting",
  "zenyte-ring":                 "89 Crafting",
  "ring-of-suffering-craft":     "89 Crafting + 93 Magic",
  "necklace-of-anguish-craft":   "92 Crafting + 93 Magic",
  "tormented-bracelet-craft":    "95 Crafting + 93 Magic",
  "amulet-of-torture-craft":     "98 Crafting + 93 Magic",
  "amulet-of-fury-craft":        "90 Crafting + 87 Magic",
  "ring-of-stone-craft":         "67 Crafting + 87 Magic",
  "berserker-necklace-craft":    "82 Crafting + 87 Magic",
  "aquanite-hopper":             "60 Smithing",
  "dragon-keel-parts":           "94 Smithing",
  "large-dragon-keel-parts":     "94 Smithing",
  "large-dragon-keel-parts-sheets": "94 Smithing",
  "oathplate-helm":              "83 Smithing",
  "oathplate-chest":             "83 Smithing",
  "oathplate-legs":              "83 Smithing",
};

/* ---------------- Tag taxonomy ----------------
   Each recipe can have multiple tags. Filters use OR logic — show if the
   recipe has ANY of the user-selected tags. The tag list below is the union
   across all recipes; the per-recipe assignment lives in `tagsFor()`.
------------------------------------------------ */
function tagsFor(r) {
  const tags = new Set();
  const n = r.name.toLowerCase();
  const cat = r.cat;

  // GE armour sets carry only the "Item Set" tag — they bundle pieces from
  // many themes, so inheriting each piece's theme tag would scatter them
  // across unrelated filters.
  if (cat === "Sets") return ["Item Set"];

  // Base category tags
  const baseByCategory = {
    "Godswords":      ["Weapon", "Melee"],
    "Spirit Shields": ["Shield"],
    "Masori":         ["Armor", "Ranged"],
    "Torva":          ["Armor", "Melee", "Repair"],
    "Onyx":           ["Jewelry"],
    "Zenyte":         ["Jewelry"],
    "Decombines":     ["Decombine"],
    "Wilderness":     ["Wilderness", "Weapon"],
    "Upgrade boots":  ["Boots"],
    "Ranged":         ["Weapon", "Ranged"],
    "Toxic":          ["Weapon"],
    "Barrows":        ["Repair"],
    "Moons":          ["Repair", "Armor"],
    "Dragon": [], "Misc": [], "Top-tier": [],
  };
  (baseByCategory[cat] || []).forEach(t => tags.add(t));

  // Per-item refinements
  if (cat === "Dragon") {
    if (/kiteshield|sq shield/.test(n)) tags.add("Shield");
    else if (/crossbow/.test(n)) { tags.add("Weapon"); tags.add("Ranged"); if (/\(u\)/.test(n)) tags.add("Component"); }
    else if (/lance/.test(n))    { tags.add("Weapon"); tags.add("Melee"); }
    else if (/platebody/.test(n)){ tags.add("Armor"); tags.add("Melee"); }
  }
  if (cat === "Toxic") {
    if (/blowpipe/.test(n))      tags.add("Ranged");
    else if (/staff|trident/.test(n)) tags.add("Magic");
    if (/serpentine helm/.test(n)) { tags.delete("Weapon"); tags.add("Armor"); tags.add("Melee"); }
    if (r.key === "uncharged-trident-e") tags.add("Component");
  }
  if (cat === "Misc") {
    if (/shield|ward$/.test(n)) tags.add("Shield");
    if (/fury/.test(n))         tags.add("Jewelry");
    if (/wrath tiara/.test(n))  { tags.add("Jewelry"); tags.add("Magic"); }
    if (/bryophyta/.test(n))    { tags.add("Weapon"); tags.add("Magic"); }
    if (/malediction|odium/.test(n)) tags.add("Wilderness");  // wards built from Wilderness (revenant) shards
  }
  if (cat === "Top-tier") {
    if (/kodai/.test(n))         { tags.add("Weapon"); tags.add("Magic"); }
    if (/saturated heart/.test(n)) tags.add("Magic");
  }
  if (cat === "Wilderness") {
    if (/sceptre|staff of light/.test(n)) tags.add("Magic");
    else if (/chainmace|voidwaker|hasta/.test(n)) tags.add("Melee");
    else if (/webweaver|bow/.test(n)) tags.add("Ranged");
  }
  if (cat === "Barrows") {
    if (/^ahrim/.test(n))     tags.add("Magic");
    else if (/^karil/.test(n)) tags.add("Ranged");
    else                       tags.add("Melee");
    if (/staff|hammers|warspear|crossbow|greataxe|flail/.test(n)) tags.add("Weapon");
    else                                                          tags.add("Armor");
  }
  if (cat === "Moons") {
    if (/^blood/.test(n))      tags.add("Melee");
    else if (/^blue/.test(n))  tags.add("Magic");
    else if (/^eclipse/.test(n)) tags.add("Ranged");
  }
  if (cat === "Torva" && /bandosian/.test(n)) {
    tags.delete("Repair"); tags.add("Component");
  }
  if (cat === "Masori" && /armadylean plate \(via/.test(n)) {
    tags.delete("Armor"); tags.add("Component");
  }
  if (cat === "Ranged" && /(incomplete|unstrung)/.test(n)) {
    tags.delete("Weapon"); tags.add("Component");
  }
  if (cat === "Spirit Shields") {
    if (/^blessed/.test(n))             tags.add("Component");
    else if (/arcane|spectral/.test(n)) tags.add("Magic");
    else if (/elysian/.test(n))         tags.add("Melee");
  }
  if (cat === "Decombines") {
    if (/sigil/.test(n))             { tags.add("Magic"); tags.add("Component"); }
    if (/zulrah.s scales/.test(n))   tags.add("Component");
    if (/magic fang/.test(n))        { tags.add("Magic"); tags.add("Component"); }
  }
  if (cat === "Godswords" && /^godsword blade$/.test(n)) tags.add("Component");

  // --- Theme / source tags (kept alongside the broad slot/class tags) ---
  if (cat === "Godswords")     tags.add("Godswords");
  if (cat === "Masori")         tags.add("Masori");
  if (cat === "Torva")          tags.add("Nex");
  if (cat === "Barrows")        tags.add("Barrows");
  if (cat === "Moons")          tags.add("Moons of Peril");
  if (cat === "Zenyte")         tags.add("Zenyte");
  if (cat === "Onyx")           tags.add("Onyx");
  if (cat === "Dragon")         tags.add("Dragon");
  if (cat === "Toxic")          tags.add("Zulrah");
  if (cat === "Sailing")        tags.add("Sailing");
  if (cat === "Oathplate")      tags.add("Oathplate");
  // Dragon keel parts are dragon-metal items — tag them Dragon as well as Sailing.
  if (cat === "Sailing" && /dragon keel/.test(n)) tags.add("Dragon");
  // Zulrah-related items (formerly "Toxic")
  if (/zulrah/.test(n) || /toxic|serpentine/.test(n)) tags.add("Zulrah");

  // Intermediate-form items
  if (/\(u\)$|^uncut |uncut /.test(n)) tags.add("Component");

  // Combat tags on enchanted Zenyte jewelry
  if (/amulet of torture/.test(n))   tags.add("Melee");
  if (/necklace of anguish/.test(n)) tags.add("Ranged");
  if (/tormented bracelet/.test(n))  tags.add("Magic");
  if (/^berserker necklace$/.test(n)) tags.add("Melee");

  if (tags.size === 0) tags.add("Other");

  // ----- Curate: cull broad slot/class tags, rename, add theme tags. -----
  // The filter UI shows only this curated subset.
  const TAG_RENAME = { "Godswords": "God Wars", "Decombine": "Breakdown" };
  const TAG_ALLOWED = new Set([
    "God Wars", "Nex", "Slayer", "Barrows", "Moons of Peril", "Masori",
    "Dragon", "Zulrah", "Wilderness", "Sailing", "Oathplate", "Shield", "Jewelry",
    "Repair", "Breakdown", "Item Set", "Other",
  ]);
  const out = new Set();
  for (let t of tags) { t = TAG_RENAME[t] || t; if (TAG_ALLOWED.has(t)) out.add(t); }
  if (r.key === "zaryte-crossbow") out.add("Nex");            // Zaryte crossbow is a Nex drop
  // God Wars Dungeon items: godswords, Nex (Torva), Armadyl plate (Masori),
  // the hasta, the hydra-claw lance, and any staff-of-the-dead (id 11791) build.
  let godwars = out.has("Nex") || cat === "Godswords" || cat === "Torva" || cat === "Masori";
  if (r.key === "zamorakian-hasta" || r.key === "dragon-hunter-lance") godwars = true;
  if (r.components.some(c => c.id === 11791)) godwars = true;
  if (godwars) out.add("God Wars");
  // Slayer: boot upgrades from slayer bosses, plus the hydra-claw lance.
  if (cat === "Upgrade boots" || r.key === "dragon-hunter-lance" || r.key === "aquanite-hopper") out.add("Slayer");
  // The Dragon hunter lance is a God Wars / Slayer weapon, not a Dragon-themed item.
  if (r.key === "dragon-hunter-lance") out.delete("Dragon");
  out.delete("Other");
  if (out.size === 0) out.add("Other");
  return [...out];
}
// Pre-compute and cache tags on each recipe
for (const r of RECIPES) r._tags = tagsFor(r);

// Stable order for the chip bar — combat / slot / theme / mechanic
const TAG_ORDER = [
  "God Wars", "Nex", "Slayer",
  "Barrows", "Moons of Peril", "Masori",
  "Dragon", "Zulrah", "Wilderness",
  "Sailing", "Oathplate", "Shield", "Jewelry",
  "Repair", "Breakdown", "Item Set", "Other",
];
const TAGS = TAG_ORDER.filter(t => RECIPES.some(r => r._tags.includes(t)));
const CATEGORIES = TAGS; // alias kept for filter state compat

/* ---------------- State ---------------- */
const state = {
  mapping: {},
  prices: {},
  volumes: {},          // id → 24h trade count
  avg5m: {},            // id → {avgHighPrice, avgLowPrice, ...}   (last 5 min)
  avg1h: {},            // id → {avgHighPrice, avgLowPrice, ...}   (last 1 hour)
  avg24h: {},           // id → {high, low}  (24h avg, normalised for calcMargin)
  lastFetched: 0,
  history: loadHistory(),
  filters: {
    search: "",
    sort: "recommended",
    minCost: null,        // gp; null = no lower bound
    maxCost: null,        // gp; null = no upper bound
    profitableOnly: false,
    hideStaleProducts: false,
    hideStaleComponents: false,
    hideLowVolume: false,
    favoritesOnly: false,
    activeCats: new Set(TAGS),  // every tag on by default — deselect a chip to hide that type
    buyHourStart: 0, buyHourEnd: 23,
    sellHourStart: 0, sellHourEnd: 23,
    maxSlots: null,       // max distinct components per craft; null = no limit
    historySort: localStorage.getItem("osrs-combo-history-sort") || "profit-desc",
    skillingSort: localStorage.getItem("osrs-combo-skilling-sort") || "gphr-desc",
    skillingSkill: localStorage.getItem("osrs-combo-skilling-skill") || "all",
    skillingSubCats: new Set(JSON.parse(localStorage.getItem("osrs-combo-skilling-subcats") || "[]")),
    skillingTiers: new Set(JSON.parse(localStorage.getItem("osrs-combo-skilling-tiers") || "[]")),
    herbloreAmulet:  localStorage.getItem("osrs-combo-herblore-amulet")  || "none", // none | chemistry | alchemist
    herbloreGoggles: localStorage.getItem("osrs-combo-herblore-goggles") === "1",
    smithingOutfitPieces:   parseInt(localStorage.getItem("osrs-combo-smithing-outfit-pieces") || "0", 10),
    smithingDoubleMould:    localStorage.getItem("osrs-combo-smithing-double-mould") === "1",
    smithingAncientFurnace: localStorage.getItem("osrs-combo-smithing-ancient-furnace") === "1",
    fletchingKnife:         localStorage.getItem("osrs-combo-fletching-knife") === "1",
    cookingLevel:           parseInt(localStorage.getItem("osrs-combo-cooking-level") || "99", 10),
    cookingMethod:          localStorage.getItem("osrs-combo-cooking-method") || "range",
    cookingGauntlets:       localStorage.getItem("osrs-combo-cooking-gauntlets") === "1",
    cookingCape:            localStorage.getItem("osrs-combo-cooking-cape") === "1",
    runecraftingLevel:           parseInt(localStorage.getItem("osrs-combo-runecrafting-level") || "99", 10),
    runecraftingEssence:         localStorage.getItem("osrs-combo-runecrafting-essence") || "pure",
    runecraftingRaiments:        parseInt(localStorage.getItem("osrs-combo-runecrafting-raiments") || "0", 10),
    runecraftingBindingNecklace: localStorage.getItem("osrs-combo-runecrafting-binding") === "1",
    runecraftingMagicImbue:      localStorage.getItem("osrs-combo-runecrafting-imbue") === "1",
  },
  // Per-recipe favorites (Set of recipe.key strings)
  favorites: new Set(JSON.parse(localStorage.getItem("osrs-combo-favorites") || "[]")),
  // Browser notification alerts — auto-fire when a favorited item hits its
  // predicted buy or sell local hour. See checkPredictedHourAlerts().
  notificationsEnabled: localStorage.getItem("osrs-combo-notifications-enabled") === "1",
  alertsFired: new Set(),  // in-memory dedup keys, garbage-collected per hour
  // Bulk allocator result — populated by the "Calculate allocation" button
  // and consumed by renderAllocate(). Persists across mode switches so the
  // user can leave/return without re-running.
  allocation: null,
  // Per-item "hit buy limit" marks. Keyed by item id → epoch-ms when the 4h
  // GE buy-limit window expires. Any recipe touching an unexpired item is
  // filtered out of the allocator. Persisted to localStorage; pruned on read.
  hitLimits: loadHitLimits(),
  // OSRS news posts (from dist/news.json, scraped by scripts/scrape-news.mjs).
  // Fetched on first modal open, cached in memory for the session. Chart
  // markers filter to the visible date range at draw time. null = not loaded,
  // [] = load failed (don't retry).
  news: null,
  // Recipe-key exclusion set for the allocator. Any recipe whose key is in
  // here gets skipped during allocation. Populated from the "component
  // combines" list popover (though the mechanism is general — could later
  // apply to any recipe). Persisted to localStorage so a user's curation
  // survives reloads.
  excludedRecipes: new Set(JSON.parse(localStorage.getItem("osrs-combo-excluded-recipes") || "[]")),
  // Item-id set for user-unchecked entries in the FREE_SLOT_ITEM_IDS pool.
  // The pool is a hand-curated seed; this override set lets the user
  // remove specific items from the fast-fill treatment. Stored as strings
  // (JSON.parse rehydrates numeric ids as strings; treat both consistently).
  excludedFreeSlotItems: new Set(JSON.parse(localStorage.getItem("osrs-combo-excluded-freeslot-items") || "[]").map(String)),
  // Snapshot of previous margins so we can show a trend arrow on cards.
  // Keyed by recipe.key; cleared on full refresh after capture.
  lastMargin: {},
  // Active view mode: "cards" or "table"
  view: localStorage.getItem("osrs-combo-view") || "cards",
  mode: localStorage.getItem("osrs-combo-mode") || "realtime",
  // History tab state (uploaded CSV-derived flip analysis).
  flipsHistory: {
    activeAccount: localStorage.getItem("osrs-combo-history-account") || null,
    accounts: [],
    range: localStorage.getItem("osrs-combo-history-range") || "all",
    customRange: { start: null, end: null },
    modalTab: localStorage.getItem("osrs-combo-history-modal-tab") || "conversions",
    showFlips: localStorage.getItem("osrs-combo-history-show-flips") === "1",
    profitFilter: localStorage.getItem("osrs-combo-history-profit-filter") || "all", // "all" | "profits" | "losses"
    // "all" | "combos" | "<SkillName>" (e.g. "Smithing"). Keeps the History
    // leaderboard split-able the same way the realtime Skilling tab is, since
    // skilling recipes get matched in matchEvents whenever the CSV contains
    // matching component→product trades (e.g. ore→bar smelting).
    skillFilter: localStorage.getItem("osrs-combo-history-skill-filter") || "all",
    hiddenConvIds: new Set(JSON.parse(localStorage.getItem("osrs-combo-history-hidden-conv-ids") || "[]")),
    analysisCache: null,
  },
  smithing: parseInt(localStorage.getItem("osrs-combo-smithing") || "99", 10),
  // Independent strategies — each picks one side of the spread:
  //   supplies: "insta-buy" (pay high to acquire now) | "slow-buy" (offer at low, wait)
  //   products: "insta-buy" (list at high, wait for insta-buyer) | "insta-sell" (accept low to sell now)
  supplyStrategy:  localStorage.getItem("osrs-combo-supply-strategy")  || "insta-buy",
  productStrategy: localStorage.getItem("osrs-combo-product-strategy") || "insta-buy",
  countdown: REFRESH_MS / 1000,
  countdownTimer: null,
};

/* ---------------- Utility ---------------- */
function fmtGp(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  // Comma-separated full value — no rounding/abbreviation
  return Math.round(n).toLocaleString("en-US");
}
// Short abbreviated form, kept for tight spaces where width matters (histogram tooltips, etc.)
function fmtGpShort(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs/1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `${sign}${(abs/1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `${sign}${(abs/1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}
function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return "—";
  // 3 decimals when |n| < 10 (tight margins matter), otherwise 2
  return `${n.toFixed(Math.abs(n) < 10 ? 3 : 2)}%`;
}
// Volume is fetched as a 24h total but displayed as average per hour
function perHour(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return n / 24;
}
function fmtVol(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)}m`;
  if (n >= 1_000) return `${(n/1_000).toFixed(2)}k`;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function geTax(sellPrice) {
  if (!sellPrice || sellPrice < GE_TAX_EXEMPT_BELOW) return 0;
  return Math.min(Math.floor(sellPrice * GE_TAX_RATE), GE_TAX_CAP);
}
function repairCost(base, level) {
  if (!base) return 0;
  return Math.round(base * (1 - level / 200));
}

/* ---------------- Trend classifier ----------------
   Given an item id, compares the 5-minute rolling average to the 1-hour
   rolling average. Returns one of:
     "spike"        — 5m avg ≥ +5% above 1h avg (sudden upward move)
     "crash"        — 5m avg ≤ -5% below 1h avg (sudden downward move)
     "trending-up"  — 5m avg +1% to +5% above 1h avg
     "trending-down"— 5m avg -1% to -5% below 1h avg
     null           — within ±1% (stable / noise)
   Uses avgHighPrice (insta-buy side) as the reference price.
---------------------------------------------------- */
const SPIKE_PCT = 5;
const TREND_PCT = 1;
function trendOf(itemId) {
  const a5 = state.avg5m[itemId];
  const a1 = state.avg1h[itemId];
  if (!a5 || !a1) return null;
  const recent = a5.avgHighPrice ?? a5.avgLowPrice;
  const base   = a1.avgHighPrice ?? a1.avgLowPrice;
  if (!recent || !base) return null;
  const deltaPct = ((recent - base) / base) * 100;
  if (deltaPct >=  SPIKE_PCT) return { kind: "spike",         pct: deltaPct };
  if (deltaPct <= -SPIKE_PCT) return { kind: "crash",         pct: deltaPct };
  if (deltaPct >=  TREND_PCT) return { kind: "trending-up",   pct: deltaPct };
  if (deltaPct <= -TREND_PCT) return { kind: "trending-down", pct: deltaPct };
  return null;
}

// Most recent traded timestamp (seconds) across both sides of the spread.
// Returns null if neither side has a timestamp.
function lastTradedSec(itemId) {
  const p = state.prices[itemId];
  if (!p) return null;
  const hi = p.highTime ?? 0;
  const lo = p.lowTime  ?? 0;
  const t = Math.max(hi, lo);
  return t > 0 ? t : null;
}
// Human-readable age string for a last-traded timestamp.
function ageString(tsSec) {
  if (!tsSec) return null;
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
  if (ageSec < 60)       return `${ageSec}s ago`;
  if (ageSec < 3600)     return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400)    return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}
// True if the item's most recent trade is older than the stale cutoff.
function isItemStale(itemId) {
  const t = lastTradedSec(itemId);
  if (!t) return false;
  return (Date.now() / 1000 - t) * 1000 > STALE_MS;
}

// Small inline stale chip — sits in the same row as the trend chip when an
// item hasn't traded in 6h+. Shows the age directly so you don't have to hover.
function staleChip(lastTs) {
  const age = lastTs ? ageString(lastTs) : "no data";
  const chip = el("span", { class: "stale-chip", text: `⏱ ${age}` });
  chip.title = `Last traded ${age}`;
  return chip;
}

// Render a small inline trend chip. Used both in the card head (recipe-level)
// and inline in component breakdown rows (component-level).
// buyerView inverts the chip colour: on a component row a falling price is
// good (green) and a rising price is bad (red) — the opposite of the product.
function trendChip(trend, buyerView = false) {
  const arrow = ({
    "spike":         "▲▲",
    "crash":         "▼▼",
    "trending-up":   "↗",
    "trending-down": "↘",
  })[trend.kind];
  const sign = trend.pct >= 0 ? "+" : "";
  const chip = el("span", {
    class: "trend-chip trend-" + trend.kind + (buyerView ? " trend-buy" : ""),
    text: `${arrow} ${sign}${trend.pct.toFixed(1)}%`,
  });
  chip.title = `5m avg ${sign}${trend.pct.toFixed(2)}% vs 1h avg`;
  return chip;
}

// Skill requirement chip — the level(s) needed to perform the combination.
// Sourced from SKILL_REQS (OSRS Wiki {{Recipe}} data).
function skillChip(req) {
  const chip = el("span", { class: "skill-chip", text: `⚒ ${req}` });
  chip.title = `Requires ${req} to craft`;
  return chip;
}

// Safe DOM helpers (avoid innerHTML with interpolated data)
function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}
function row(parent, opts) {
  const r = el("div", { class: "row" + (opts.cls ? " " + opts.cls : "") });
  const nameSpan = el("span", { class: "name", text: opts.label });
  // opts.nameExtras: inline elements appended next to the name (e.g. trend chip)
  if (Array.isArray(opts.nameExtras)) {
    for (const ext of opts.nameExtras) if (ext) nameSpan.appendChild(ext);
  }
  r.appendChild(nameSpan);
  const valSpan = el("span", { class: "val", text: opts.value });
  if (opts.hint != null) {
    valSpan.appendChild(el("span", { class: "hint", text: ` ${opts.hint}` }));
  }
  // opts.extras: inline elements appended after the value (legacy support)
  if (Array.isArray(opts.extras)) {
    for (const ext of opts.extras) if (ext) valSpan.appendChild(ext);
  }
  r.appendChild(valSpan);
  parent.appendChild(r);
  return r;
}

/* ---------------- History ---------------- */
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("History load failed, resetting:", e);
    return {};
  }
}
function saveHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history));
  } catch (e) {
    console.warn("History quota hit, trimming:", e);
    for (const k of Object.keys(state.history)) {
      const arr = state.history[k];
      if (arr.length > 50) state.history[k] = arr.slice(Math.floor(arr.length / 2));
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history)); } catch (_) {}
  }
}
/* ---------------- Hit-buy-limit tracking ----------------
 * OSRS GE buy limits reset every 4h. When the user has personally hit an
 * item's buy limit, no allocator recommendation involving that item can be
 * acted on until the window rolls over. We store a map of {itemId: expiresAt
 * epoch-ms}, prune expired entries on read, and let allocateRecipes() filter
 * candidates that touch a still-blocked item. Marks are per-item (not per-
 * recipe) so a marked component blocks every recipe using it.
 */
const HIT_LIMIT_KEY = "osrs-combo-hitlimits";
const HIT_LIMIT_MS = 4 * 60 * 60 * 1000;
function loadHitLimits() {
  try {
    const raw = localStorage.getItem(HIT_LIMIT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const clean = {};
    for (const [id, exp] of Object.entries(parsed)) {
      if (typeof exp === "number" && exp > now) clean[id] = exp;
    }
    return clean;
  } catch { return {}; }
}
function saveHitLimits() {
  try { localStorage.setItem(HIT_LIMIT_KEY, JSON.stringify(state.hitLimits)); } catch {}
}
function pruneHitLimits() {
  const now = Date.now();
  let changed = false;
  for (const [id, exp] of Object.entries(state.hitLimits)) {
    if (exp <= now) { delete state.hitLimits[id]; changed = true; }
  }
  if (changed) saveHitLimits();
}
function isHitLimited(id) {
  const exp = state.hitLimits[id];
  return typeof exp === "number" && exp > Date.now();
}
function markHitLimit(id) {
  state.hitLimits[id] = Date.now() + HIT_LIMIT_MS;
  saveHitLimits();
}
function unmarkHitLimit(id) {
  delete state.hitLimits[id];
  saveHitLimits();
}
function toggleHitLimit(id) {
  if (isHitLimited(id)) unmarkHitLimit(id);
  else markHitLimit(id);
}
function fmtHitLimitRemaining(id) {
  const exp = state.hitLimits[id];
  if (!exp) return "";
  const ms = exp - Date.now();
  if (ms <= 0) return "expired";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ---------------- Excluded-recipes curation ---------------- */
const EXCLUDED_RECIPES_KEY = "osrs-combo-excluded-recipes";
function saveExcludedRecipes() {
  try { localStorage.setItem(EXCLUDED_RECIPES_KEY, JSON.stringify(Array.from(state.excludedRecipes))); } catch {}
}
function setRecipeExcluded(key, excluded) {
  if (excluded) state.excludedRecipes.add(key);
  else state.excludedRecipes.delete(key);
  saveExcludedRecipes();
}

/* ---------------- Free-slot item overrides ---------------- */
const EXCLUDED_FREESLOT_ITEMS_KEY = "osrs-combo-excluded-freeslot-items";
function saveExcludedFreeSlotItems() {
  try { localStorage.setItem(EXCLUDED_FREESLOT_ITEMS_KEY,
    JSON.stringify(Array.from(state.excludedFreeSlotItems))); } catch {}
}
function setFreeSlotItemExcluded(id, excluded) {
  const key = String(id);
  if (excluded) state.excludedFreeSlotItems.add(key);
  else state.excludedFreeSlotItems.delete(key);
  saveExcludedFreeSlotItems();
}
// (Legacy helper isFreeSlotItemActive removed — the allocator now uses
// isFastFillComponent, which unifies explicit FREE_SLOT_ITEM_IDS + filler
// recipe outputs and handles user overrides via excludedFreeSlotItems.)

/* ---------------- News markers ----------------
 * OSRS news posts drawn as circles on chart modals (both the recipe/item
 * chart and the market-index chart). Loaded on first modal open, cached
 * for the session. Filtered per chart to the visible date range.
 *
 * Data source: dist/news.json, generated by scripts/scrape-news.mjs from
 * the official OSRS news RSS feed.
 */
async function loadNews() {
  if (state.news != null) return state.news;
  try {
    const res = await fetch("news.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`news.json HTTP ${res.status}`);
    const payload = await res.json();
    state.news = (payload.posts || []).map(p => ({
      ts: p.ts,
      // Decode common HTML entities left in scraped titles (&amp; → & etc.)
      // so tooltips read cleanly. Only the safe subset — no need for a
      // full HTML parser here.
      title: (p.title || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'"),
      url: p.url,
      category: p.category || "News",
    }));
  } catch (e) {
    console.warn("news load failed:", e);
    state.news = [];   // sentinel so we don't refetch every modal open
  }
  return state.news;
}

// Category → circle colour. "Game Updates" is the most price-relevant
// (nerfs/buffs/boss changes drive the price swings visible on the chart)
// so it gets the loudest accent; other categories are muted.
function newsMarkerColor(category) {
  if (category === "Game Updates") return "#a78bfa";  // purple
  if (category === "Website")      return "#94a3b8";  // slate (rare, low-signal)
  return "#60a5fa";                                    // blue for community / events / etc.
}

/* Draw news-post markers in a horizontal strip and return an array of
 * {x, y, radius, post} that hover/click handlers can hit-test. Called by
 * both drawChart and drawIndexChart with their respective geometry.
 *
 *   ctx       — 2D canvas context (already transformed for DPR)
 *   tsMin/Max — chart's time-domain bounds
 *   xs(ts)    — chart's x-scale function
 *   stripTop  — y-pixel of the top of the marker strip
 *   stripH    — height of the marker strip
 *   padL/padR — chart padding (so we can clip out-of-plot posts)
 *   w         — total css-pixel width (for clipping)
 */
function drawNewsMarkers(ctx, opts) {
  const { tsMin, tsMax, xs, stripTop, stripH, padL, padR, w } = opts;
  const news = state.news;
  if (!news || !news.length) return [];
  const cy = stripTop + stripH / 2;
  const radius = Math.min(6, Math.max(4, Math.floor(stripH / 3.5)));
  const hits = [];
  for (const post of news) {
    if (post.ts < tsMin || post.ts > tsMax) continue;
    const x = xs(post.ts);
    if (x < padL - radius || x > w - padR + radius) continue;
    ctx.fillStyle = newsMarkerColor(post.category);
    ctx.beginPath();
    ctx.arc(x, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    // Subtle outline for contrast against the chart background
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
    hits.push({ x, y: cy, radius, post });
  }
  return hits;
}
// Hit-test the news-marker strip. Returns the marker underneath (x, y)
// or null. Uses a generous 10px hit-radius so users don't need pixel-
// perfect aim on overlapping circles.
function newsMarkerAt(x, y, geom) {
  if (!geom?.newsMarkers?.length) return null;
  const hitR = 10;
  let best = null, bestD = Infinity;
  for (const m of geom.newsMarkers) {
    const dx = m.x - x, dy = m.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= hitR * hitR && d2 < bestD) { best = m; bestD = d2; }
  }
  return best;
}

function recordSample(recipe, calc) {
  const key = recipe.key;
  if (!state.history[key]) state.history[key] = [];
  const series = state.history[key];
  const now = Date.now();
  const last = series[series.length - 1];
  if (last && now - last[0] < HISTORY_SAMPLE_MS) return;
  series.push([now, calc.margin, calc.sellPrice, calc.componentCost + calc.repairCost]);
  const cutoff = now - HISTORY_WINDOW_MS;
  while (series.length && series[0][0] < cutoff) series.shift();
}

/* ---------------- API ----------------
   The OSRS Wiki real-time API tolerates browser clients without a custom
   User-Agent. Browsers forbid setting User-Agent via fetch(), and the wiki
   rejects unknown query params, so we just send the request as-is. The wiki
   sends CORS *, so this works from any origin.
---------------------------------------- */
async function api(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}
async function fetchMapping() {
  const data = await api("/mapping");
  const map = {};
  for (const it of data) map[it.id] = it;
  return map;
}
async function fetchLatest() {
  const data = await api("/latest");
  return data.data;
}
async function fetchVolumes() {
  const data = await api("/volumes");
  return data.data;
}
async function fetchAvg5m() {
  // Rolling average over the last 5 minutes; covers all items in one call.
  const data = await api("/5m");
  return data.data;
}
async function fetchAvg1h() {
  // Rolling average over the last 1 hour. Used as the "baseline" we compare
  // the 5m average against to classify trend / spike.
  const data = await api("/1h");
  return data.data;
}
async function fetchAvg24h() {
  // Rolling 24-hour average — the "recent history" baseline for the
  // Recommended sort. Normalised to {high, low} so the margin calculator
  // (supplyPrice / productSell) can price a recipe straight off it, exactly
  // like the live /latest snapshot. Also preserves side-split volumes so
  // the allocator's precise-volume path (see sideVolume/maxFlipsAdjusted)
  // can distinguish buy-side vs sell-side liquidity — the aggregate
  // /volumes endpoint collapses both.
  const data = await api("/24h");
  const out = {};
  for (const [id, p] of Object.entries(data.data)) {
    out[id] = {
      high: p.avgHighPrice ?? null, low: p.avgLowPrice ?? null,
      highVol: p.highPriceVolume ?? 0, lowVol: p.lowPriceVolume ?? 0,
    };
  }
  return out;
}
async function fetchTimeseries(id, step) {
  const data = await api(`/timeseries?id=${id}&timestep=${step}`);
  return data.data;
}

/* ---------------- Margin calculator ----------------
   Per-craft margin honoring two independent strategy toggles:
     supplyStrategy:  "insta-buy" → components priced at .high (you pay this)
                       "slow-buy"  → components priced at .low  (you offer this)
     productStrategy: "insta-buy" → product priced at .high (list-and-wait, you receive this)
                       "insta-sell"→ product priced at .low  (sell now, you receive this)

   Tax applies per item sold (2% capped at 5M, exempt <100gp).

   maxFlipsPerDay (in CRAFTS, not units): min over volume_result/qty
   and volume_componentᵢ/qtyᵢ. Volume isn't strategy-dependent.
---------------------------------------------------- */
function supplyPrice(p) {
  if (!p) return null;
  return state.supplyStrategy === "slow-buy" ? (p.low ?? null) : (p.high ?? null);
}
// Same as supplyPrice() but honours an explicit strategy override instead of
// state.supplyStrategy. Used by the allocator (and the allocator's card render)
// to price a specific recipe under whichever strategy actually wins for it —
// so a global "slow-buy" preference can still surface an insta-buy pick when
// insta-buy is more profitable (e.g. stale .low in a downtrending market, or
// a null .low that would otherwise drop the recipe entirely).
function supplyPriceAt(p, strategy) {
  if (!p) return null;
  return strategy === "slow-buy" ? (p.low ?? null) : (p.high ?? null);
}
// Compute calcMargin under an arbitrary supply strategy. Restores the global
// state after — the mutation is scoped to this function call. Cheaper than
// threading a strategy param through calcMargin's callers (many of them read
// state.supplyStrategy indirectly).
function calcMarginAt(recipe, strategy) {
  const prev = state.supplyStrategy;
  state.supplyStrategy = strategy;
  try { return calcMargin(recipe); } finally { state.supplyStrategy = prev; }
}
function supplyTime(p) {
  if (!p) return null;
  return state.supplyStrategy === "slow-buy" ? (p.lowTime ?? null) : (p.highTime ?? null);
}
function productSell(p) {
  if (!p) return null;
  return state.productStrategy === "insta-sell" ? (p.low ?? null) : (p.high ?? null);
}
function productSellTime(p) {
  if (!p) return null;
  return state.productStrategy === "insta-sell" ? (p.lowTime ?? null) : (p.highTime ?? null);
}

/* ---------------- Volume helpers (allocator precision layer) ----------------
 * The default calc.maxFlips uses the aggregate /volumes endpoint (both
 * sides collapsed, 24h total). The allocator's maxFlipsAdjusted path
 * refines it three ways:
 *   1. Side-split — when buying, only sell-side liquidity matters (the
 *      volume that fills BUY orders is what sellers post). Same the other
 *      direction. Reduces false confidence on items where one side is
 *      thin (e.g. an item with 500 total volume where 495 was insta-buys
 *      and only 5 was insta-sells → thin for slow-buy).
 *   2. Recent-1h velocity blend — max(24h daily, 1h × 24). If the market
 *      is heating up, the 1h velocity is a better forward estimate than
 *      the 24h aggregate that includes stale data. If cooling down, we
 *      still fall back to the 24h estimate (safest against over-shrink).
 *   3. Wilson lower bound (Poisson approx) — a k=5 trade count doesn't
 *      confidently support k=5 units of allocation. Shrinks small counts
 *      hard, large counts barely.
 */
function poissonLower95(k) {
  // Poisson 95% one-sided lower bound approximation. Exact form uses
  // chi-squared quantiles; k - z*sqrt(k) is accurate to a few percent
  // for k > ~10 and errs on the safe (smaller) side for k < 10 — exactly
  // the direction we want when shrinking noisy volume estimates.
  if (!isFinite(k) || k <= 0) return 0;
  return Math.max(0, k - 1.96 * Math.sqrt(k));
}
// Raw side-split volumes for one item across the three time slices the
// wiki API gives us (5m, 1h, 24h). Returns the observed counts as-is
// (no scaling, no shrinkage). Used both by sideVolume() below to build
// the blended estimate AND by the card renderer to show the user which
// slice is actually driving the number.
function sideVolumeSlices(id, side) {
  const key = side === "high" ? "highPriceVolume" : "lowPriceVolume";
  const key24 = side === "high" ? "highVol" : "lowVol";
  const p5  = state.avg5m?.[id];
  const p1  = state.avg1h?.[id];
  const p24 = state.avg24h?.[id];
  return {
    v5m:  p5  ? (p5[key]   ?? 0) : null,
    v1h:  p1  ? (p1[key]   ?? 0) : null,
    v24h: p24 ? (p24[key24] ?? 0) : null,
  };
}
// Effective daily-scale volume for one item on one side of the spread.
// side: "high" (insta-buy fills / list-and-wait sells) or "low"
// (insta-sell fills / slow-buy fills). Blends three slices — the 24h
// aggregate as the historical base, the last hour × 24 as recent
// velocity, and the last 5 minutes × 288 as the "current pulse" — then
// takes the max so heating markets get the fresh signal without ever
// falling below the historic base. Wilson-shrunk on the way out so
// low-count tails don't project confident capacity.
function sideVolume(id, side) {
  const s = sideVolumeSlices(id, side);
  if (s.v5m == null && s.v1h == null && s.v24h == null) return null;
  const recent5m = s.v5m != null ? s.v5m * 288 : null;
  const recent1h = s.v1h != null ? s.v1h * 24  : null;
  const base24h  = s.v24h ?? 0;
  const candidates = [base24h, recent1h, recent5m].filter(v => v != null);
  const blended = Math.max(...candidates);
  return poissonLower95(blended);
}

function calcMargin(recipe, predMap) {
  const qty = recipe.resultQty || 1;
  const result = predMap ? null : state.prices[recipe.id];
  const sellPricePerUnit = predMap
    ? (predMap[recipe.id]?.daytime ?? null)
    : productSell(result);
  const sellTime = predMap ? null : productSellTime(result);

  // Track oldest "trusted" timestamp across all prices used so we can flag
  // recipes where any leg of the calc is stale (not just the product side).
  let oldestTime = sellTime ?? null;

  let componentCost = 0;
  let allPresent = sellPricePerUnit !== null;
  for (const c of recipe.components) {
    let sp;
    if (predMap) {
      sp = predMap[c.id]?.overnight ?? null;
    } else {
      const p = state.prices[c.id];
      sp = supplyPrice(p);
      const t = supplyTime(p);
      if (t != null && (oldestTime == null || t < oldestTime)) oldestTime = t;
    }
    if (!sp) { allPresent = false; break; }
    componentCost += sp * c.qty;
  }
  if (recipe.extraCost) componentCost += recipe.extraCost;
  // Supplies (runes/bars/wool): always priced live, even when predMap is set —
  // they are cheap and price-stable, so predicting them only adds noise.
  let suppliesCost = 0;
  for (const s of recipe.supplies || []) {
    const sp = supplyPrice(state.prices[s.id]);
    if (!sp) { allPresent = false; suppliesCost = 0; break; }
    suppliesCost += sp * s.qty;
  }
  const rc = repairCost(recipe.repairBase, state.smithing);
  const totalCost = componentCost + suppliesCost + rc;

  const revenue = sellPricePerUnit !== null ? sellPricePerUnit * qty : 0;
  const taxPerUnit = sellPricePerUnit !== null ? geTax(sellPricePerUnit) : 0;
  const totalTax = taxPerUnit * qty;
  const margin = allPresent ? (revenue - totalTax - totalCost) : null;
  const roi = (allPresent && totalCost > 0) ? (margin / totalCost) * 100 : null;

  // Volume → realistic crafts per day
  const resultVol = state.volumes[recipe.id] ?? null;
  let maxFlips = resultVol !== null ? Math.floor(resultVol / qty) : null;
  const compVols = {};
  let anyVol = resultVol !== null;
  for (const c of recipe.components) {
    const v = state.volumes[c.id];
    compVols[c.id] = v ?? null;
    if (v == null) continue;
    anyVol = true;
    const cap = Math.floor(v / c.qty);
    maxFlips = (maxFlips == null) ? cap : Math.min(maxFlips, cap);
  }
  if (!anyVol) maxFlips = null;

  // GE buy-limit cap: every item has a per-4h purchase limit. Realistic
  // crafts per 4h = floor(min(component.limit / component.qty)).
  // Daily cap (6 buy windows in 24h) = limit-bottleneck × 6.
  const compLimits = {};
  let limitFlipsPer4h = null;
  for (const c of recipe.components) {
    const lim = state.mapping[c.id]?.limit ?? null;
    compLimits[c.id] = lim;
    if (lim == null) continue;
    const cap = Math.floor(lim / c.qty);
    limitFlipsPer4h = (limitFlipsPer4h == null) ? cap : Math.min(limitFlipsPer4h, cap);
  }
  const limitFlipsPerDay = limitFlipsPer4h != null ? limitFlipsPer4h * 6 : null;

  // Bind maxFlips by BOTH market depth (volume) and procurement (GE limits).
  // Whichever is tighter wins — that's the realistic per-day cap.
  if (limitFlipsPerDay != null) {
    maxFlips = (maxFlips == null) ? limitFlipsPerDay : Math.min(maxFlips, limitFlipsPerDay);
  }

  /* ---- maxFlipsAdjusted: side-split + velocity + Wilson ---- */
  // The allocator uses this instead of the aggregate maxFlips above. It's a
  // Wilson-shrunk daily count that considers ONLY the side of the spread
  // relevant to the user's strategy for that leg (buying vs selling).
  // - Buying components: we consume the side offering the price we accept.
  //   supplyStrategy=insta-buy → we pay `high` → we consume seller-side
  //   liquidity, which shows up as highPriceVolume (fills that hit an
  //   existing sell order at the high price).
  //   supplyStrategy=slow-buy → we list at `low` → sellers hit our order
  //   at the low price → consumes lowPriceVolume.
  // - Selling output: opposite mapping via productStrategy.
  // Falls back to the aggregate `maxFlips` above if we have no side-split
  // data at all (some rarely-traded items).
  const buySide  = state.supplyStrategy === "slow-buy" ? "low"  : "high";
  const sellSide = state.productStrategy === "insta-sell" ? "low" : "high";
  // Track which leg sets the ceiling so the card can name it. That's the
  // most useful diagnostic — "you're capped by adamantite bar volume"
  // tells the user WHICH price/volume to sanity-check, not just the
  // final number.
  let bottleneckId = null;
  let bottleneckSide = null;
  const outputSideVol = sideVolume(recipe.id, sellSide);
  const compSideVols = {};
  let maxFlipsAdjusted = null;
  let anySideVol = false;
  if (outputSideVol != null) {
    maxFlipsAdjusted = Math.floor(outputSideVol / qty);
    bottleneckId = recipe.id;
    bottleneckSide = sellSide;
    anySideVol = true;
  }
  for (const c of recipe.components) {
    const v = sideVolume(c.id, buySide);
    compSideVols[c.id] = v;
    if (v == null) continue;
    anySideVol = true;
    const cap = Math.floor(v / c.qty);
    if (maxFlipsAdjusted == null || cap < maxFlipsAdjusted) {
      maxFlipsAdjusted = cap;
      bottleneckId = c.id;
      bottleneckSide = buySide;
    }
  }
  if (!anySideVol) maxFlipsAdjusted = maxFlips;   // fall back to aggregate
  // Same GE-limit binding as before — buy limits don't care about side.
  if (limitFlipsPerDay != null && maxFlipsAdjusted != null) {
    if (maxFlipsAdjusted > limitFlipsPerDay) {
      maxFlipsAdjusted = limitFlipsPerDay;
      bottleneckId = null;     // "GE buy limit" — not any specific item's volume
      bottleneckSide = null;
    }
  }
  // 3-slice breakdown of the item that set the ceiling. Card renders this
  // so the user can see "5m: 3 · 1h: 48 · 24h: 1,240 → 950 adj" and judge
  // whether the estimate feels right for the recipe.
  const volumeBreakdown = bottleneckId != null
    ? { id: bottleneckId, side: bottleneckSide, ...sideVolumeSlices(bottleneckId, bottleneckSide) }
    : null;

  return {
    sellPrice: sellPricePerUnit, sellTime, oldestTime,
    revenue, geTax: totalTax, geTaxPerUnit: taxPerUnit,
    componentCost, suppliesCost, repairCost: rc, totalCost,
    margin, roi, allPresent,
    maxFlips, maxFlipsAdjusted,
    resultVol, compVols, compSideVols, resultQty: qty,
    compLimits, limitFlipsPer4h, limitFlipsPerDay,
    bottleneckId, volumeBreakdown,
  };
}

// Per-craft margin computed from 24h-average prices — the "has this been
// profitable lately" signal, so the Recommended sort isn't fooled by a
// momentary snapshot spike. Mirrors the core of calcMargin (strategy-aware,
// GE tax, repair) but skips the volume/limit machinery. Returns null if any
// leg lacks 24h data.
function historicalMargin(recipe) {
  const src = state.avg24h;
  const qty = recipe.resultQty || 1;
  const sell = productSell(src[recipe.id]);
  if (sell === null) return null;
  let cost = recipe.extraCost || 0;
  for (const c of recipe.components) {
    const sp = supplyPrice(src[c.id]);
    if (sp === null) return null;
    cost += sp * c.qty;
  }
  for (const s of recipe.supplies || []) {
    const sp = supplyPrice(src[s.id]);
    if (sp === null) return null;
    cost += sp * s.qty;
  }
  cost += repairCost(recipe.repairBase, state.smithing);
  return sell * qty - geTax(sell) * qty - cost;
}

/* ---------------- Rendering ---------------- */
function iconUrl(id) {
  const m = state.mapping[id];
  if (!m?.icon) return "";
  return `${ICON_BASE}/${encodeURIComponent(m.icon.replace(/ /g, "_"))}`;
}
function recipeIcon(recipe) {
  return iconUrl(recipe.id) || iconUrl(recipe.components[0]?.id);
}

function renderCategories() {
  const container = document.getElementById("categories");
  container.title = "";
  container.replaceChildren();
  const active = state.filters.activeCats;

  const grid = el("div", { class: "cat-grid" });
  const selectAllBtn = el("button", { class: "cat-btn", text: "Select all" });
  const clearBtn = el("button", { class: "cat-btn", text: "Clear" });

  const refresh = () => {
    for (const chip of grid.children) {
      chip.classList.toggle("active", active.has(chip.dataset.tag));
    }
    selectAllBtn.hidden = active.size === CATEGORIES.length;
    clearBtn.hidden = active.size === 0;
  };

  for (const cat of CATEGORIES) {
    const chip = el("button", {
      class: "cat-chip" + (active.has(cat) ? " active" : ""),
      text: cat,
      attrs: { "data-tag": cat },
    });
    chip.title = `Click: show only ${cat}  ·  Double-click: hide ${cat}`;
    grid.appendChild(chip);
  }

  // Single click isolates a tag; double-click hides it — or, when that tag is
  // the only one shown, reveals all tags again. Detection is manual rather
  // than via the native dblclick event: isolating a tag re-renders the grid
  // and the chip can shift a few pixels, so the two clicks of a double need
  // not land on the same element. The chip is identified from the FIRST click.
  let lastTag = null, lastTime = 0, snapshot = null, resetTimer = null;
  const GESTURE_MS = 400;

  const isolate = (cat) => {
    active.clear();
    active.add(cat);
    refresh();
    renderGrid();
  };
  const hideOrReveal = (cat, base) => {
    active.clear();
    if (base.size === 1 && base.has(cat)) {
      for (const c of CATEGORIES) active.add(c);   // only that tag was shown → reveal all
    } else {
      for (const t of base) active.add(t);
      active.delete(cat);
    }
    refresh();
    renderGrid();
  };

  grid.addEventListener("click", (e) => {
    const chip = e.target.closest(".cat-chip");
    const tag = chip ? chip.dataset.tag : null;
    const now = Date.now();
    // A second click within the window — on the same chip, or one that missed
    // the shifted chip and landed on grid padding — completes a double-click.
    if (lastTag !== null && now - lastTime < GESTURE_MS && (tag === lastTag || tag === null)) {
      clearTimeout(resetTimer);
      hideOrReveal(lastTag, snapshot || new Set(active));
      lastTag = null;
      snapshot = null;
      return;
    }
    if (tag === null) return;   // a click on empty grid space — ignore
    lastTag = tag;
    lastTime = now;
    snapshot = new Set(active);
    isolate(tag);               // apply immediately — a following double-click rolls it back
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { lastTag = null; snapshot = null; }, GESTURE_MS);
  });

  selectAllBtn.onclick = () => { for (const c of CATEGORIES) active.add(c); refresh(); renderGrid(); };
  clearBtn.onclick = () => { active.clear(); refresh(); renderGrid(); };

  container.append(grid, el("div", { class: "cat-actions" }, selectAllBtn, clearBtn));
  refresh();
}

function sparkline(series) {
  if (!series || series.length < 2) return null;
  const margins = series.map(s => s[1]).filter(v => v !== null && Number.isFinite(v));
  if (margins.length < 2) return null;
  const min = Math.min(...margins);
  const max = Math.max(...margins);
  const range = max - min || 1;
  const w = 280, h = 32, pad = 2;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.className = "sparkline";
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = margins[margins.length - 1] >= 0 ? "#4ade80" : "#f87171";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  margins.forEach((m, i) => {
    const x = pad + (i / (margins.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((m - min) / range) * (h - 2 * pad);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (min < 0 && max > 0) {
    const zy = h - pad - ((0 - min) / range) * (h - 2 * pad);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, zy);
    ctx.lineTo(w, zy);
    ctx.stroke();
  }
  return canvas;
}

function renderCard(recipe, calc) {
  const card = el("article", { class: "card" });
  if (calc.allPresent) {
    card.classList.add(calc.margin > 0 ? "profit" : "loss");
  }
  card.onclick = () => openModal(recipe);

  const isHighRoi = calc.allPresent && calc.roi !== null && calc.roi >= HIGH_ROI_THRESHOLD;
  if (isHighRoi) {
    const badges = el("div", { class: "card-badges" });
    badges.appendChild(el("span", { class: "card-badge high-roi", text: "HIGH ROI" }));
    card.appendChild(badges);
  }

  // Head
  const iconBox = el("div", { class: "card-icon" });
  const img = el("img", { attrs: { alt: "", loading: "lazy", src: recipeIcon(recipe) } });
  img.onerror = () => { img.style.display = "none"; };
  iconBox.appendChild(img);
  // Recipe-level trend chip lives next to the category subtitle so it's
  // visible without crowding the top-right badge corner.
  const recipeTrend = trendOf(recipe.id);
  const productStale = isItemStale(recipe.id);
  const productLastTs = lastTradedSec(recipe.id);
  const catRow = el("div", { class: "card-cat-row" },
    el("span", { class: "card-cat", text: recipe.cat }),
  );
  if (recipeTrend)  catRow.appendChild(trendChip(recipeTrend));
  if (productStale) catRow.appendChild(staleChip(productLastTs));
  const skillReq = SKILL_REQS[recipe.key];
  if (skillReq) catRow.appendChild(skillChip(skillReq));

  // Name turns red on stale too (low-effort secondary signal).
  const nameDiv = el("div", {
    class: "card-name" + (productStale ? " stale" : ""),
    text: recipe.name,
  });
  if (productLastTs) {
    nameDiv.title = `${recipe.name} — last traded ${ageString(productLastTs)}` +
                    (productStale ? " (stale)" : "");
  }
  const titleBox = el("div", { class: "card-title" }, nameDiv, catRow);
  // Favorite star — inline in card-head before the icon; can't collide with
  // top-right badges and visually anchors the row on its leading edge.
  const isFav = state.favorites.has(recipe.key);
  const star = el("button", {
    class: "card-star" + (isFav ? " active" : ""),
    attrs: { title: isFav ? "Remove favorite" : "Add favorite", "aria-label": "Toggle favorite" },
    text: isFav ? "★" : "☆",
  });
  star.onclick = (e) => {
    e.stopPropagation();
    if (state.favorites.has(recipe.key)) state.favorites.delete(recipe.key);
    else state.favorites.add(recipe.key);
    localStorage.setItem("osrs-combo-favorites", JSON.stringify([...state.favorites]));
    renderGrid();
  };
  const head = el("div", { class: "card-head" }, star, iconBox, titleBox);

  // Stats
  const mVal = el("span", { class: "stat-value" });
  if (calc.margin === null) mVal.textContent = "—";
  else {
    mVal.textContent = fmtGp(calc.margin);
    mVal.classList.add(calc.margin >= 0 ? "pos" : "neg");
  }
  const rVal = el("span", { class: "stat-value" });
  if (calc.roi === null) rVal.textContent = "—";
  else {
    rVal.textContent = fmtPct(calc.roi);
    rVal.classList.add(calc.roi >= 0 ? "pos" : "neg");
  }
  // Per-hour flips (daily / 24)
  const flipsPerHour = perHour(calc.maxFlips);
  const fVal = el("span", { class: "stat-value" });
  if (flipsPerHour === null) fVal.textContent = "—";
  else {
    fVal.textContent = fmtVol(flipsPerHour);
    if (flipsPerHour < 0.5)  fVal.classList.add("neg");
    else if (flipsPerHour < 4) fVal.classList.add("warn");
    else fVal.classList.add("pos");
  }
  const cVal = el("span", { class: "stat-value" });
  cVal.textContent = fmtGp(calc.totalCost);

  // Hero margin block — primary stat
  const heroMargin = el("div", { class: "card-hero" });
  const heroLbl = el("div", { class: "card-hero-label", text: "Margin" });
  const heroVal = el("div", { class: "card-hero-value" });
  if (calc.margin === null) heroVal.textContent = "—";
  else {
    heroVal.textContent = fmtGp(calc.margin);
    heroVal.classList.add(calc.margin >= 0 ? "pos" : "neg");
  }
  const heroSub = el("div", { class: "card-hero-sub" });
  if (calc.roi !== null) {
    const roiSpan = el("span", { class: "card-hero-roi" });
    roiSpan.textContent = `${fmtPct(calc.roi)} ROI`;
    roiSpan.classList.add(calc.roi >= 0 ? "pos" : "neg");
    heroSub.appendChild(roiSpan);
  }
  // Margin trend vs previous refresh
  const prevMargin = state.lastMargin[recipe.key];
  if (prevMargin != null && calc.margin != null && prevMargin !== calc.margin) {
    const delta = calc.margin - prevMargin;
    const arrow = delta >= 0 ? "↑" : "↓";
    const trendSpan = el("span", { class: "card-hero-trend " + (delta >= 0 ? "pos" : "neg") });
    trendSpan.textContent = `${arrow} ${fmtGp(Math.abs(delta))}`;
    trendSpan.title = `Margin moved ${delta >= 0 ? "+" : "-"}${fmtGp(Math.abs(delta))} since last refresh`;
    heroSub.appendChild(trendSpan);
  }
  heroMargin.append(heroLbl, heroVal, heroSub);

  // Supporting 3-col mini stats
  const stats = el("div", { class: "card-stats card-stats-3 card-stats-mini" },
    el("div", { class: "stat cost" },
      el("span", { class: "stat-label", text: "Total cost" }),
      cVal),
    el("div", { class: "stat flips" },
      el("span", { class: "stat-label", text: "Trades/hr" }),
      fVal),
  );
  // Add a "Daily margin" mini-stat if we have flips
  const dailyVal = el("span", { class: "stat-value" });
  if (calc.maxFlips != null && calc.margin != null) {
    const daily = calc.maxFlips * calc.margin;
    dailyVal.textContent = fmtGp(daily);
    dailyVal.classList.add(daily >= 0 ? "pos" : "neg");
  } else {
    dailyVal.textContent = "—";
  }
  stats.appendChild(el("div", { class: "stat daily" },
    el("span", { class: "stat-label", text: "Daily potential" }),
    dailyVal));
  // We still keep the unused mVal/rVal references quiet — they're not used in hero layout but built above to preserve neg/pos classes when re-used elsewhere.
  void mVal; void rVal;

  // Component breakdown
  const comp = el("div", { class: "components" });
  for (const c of recipe.components) {
    const m = state.mapping[c.id];
    const cName = m?.name || `#${c.id}`;
    const p = state.prices[c.id];
    const bp = supplyPrice(p);
    const value = bp
      ? (c.qty > 1 ? `${c.qty}× ${fmtGp(bp)}` : fmtGp(bp))
      : "—";
    const vol = calc.compVols[c.id];
    const lim = calc.compLimits[c.id];
    // Inline hint: just trade volume. GE buy limit moves to the row tooltip.
    const hint = vol != null ? `· ${fmtVol(perHour(vol))}/hr` : null;
    const compTrend = trendOf(c.id);
    const compStale = isItemStale(c.id);
    const lastTs    = lastTradedSec(c.id);
    const nameChips = [];
    if (compTrend) nameChips.push(trendChip(compTrend, true));
    if (compStale) nameChips.push(staleChip(lastTs));
    const r = row(comp, {
      cls: compStale ? "comp-stale" : "",
      label: cName,
      value,
      hint,
      nameExtras: nameChips.length ? nameChips : null,
    });
    // Combined tooltip: last traded + GE buy limit (+ stale flag)
    const ttBits = [];
    if (lastTs) ttBits.push(`Last traded ${ageString(lastTs)}` + (compStale ? " (stale)" : ""));
    if (lim != null) ttBits.push(`GE buy limit: ${lim.toLocaleString()} per 4h`);
    if (ttBits.length) r.title = `${m?.name || `#${c.id}`}\n${ttBits.join("\n")}`;
  }
  if (recipe.supplies && recipe.supplies.length) {
    const supplyRow = row(comp, { label: "Supplies", value: fmtGp(calc.suppliesCost) });
    supplyRow.title = recipe.supplies
      .map(s => `${s.qty}× ${state.mapping[s.id]?.name || "#" + s.id}`)
      .join(" · ");
  }
  if (recipe.extraCost) row(comp, { label: "Runes/extras", value: fmtGp(recipe.extraCost) });
  if (recipe.repairBase) row(comp, { cls: "repair", label: `Repair @ ${state.smithing}`, value: fmtGp(calc.repairCost) });
  row(comp, { cls: "tax", label: "GE tax", value: `-${fmtGp(calc.geTax)}` });
  const qty = calc.resultQty;
  const sellLabel = qty > 1 ? `Sell price ×${qty}` : "Sell price";
  const sellValue = qty > 1
    ? `${fmtGp(calc.revenue)} (${fmtGp(calc.sellPrice)}/ea)`
    : fmtGp(calc.sellPrice);
  row(comp, {
    cls: "sell", label: sellLabel, value: sellValue,
    hint: calc.resultVol != null ? `· ${fmtVol(perHour(calc.resultVol))}/hr` : null,
  });

  card.append(head, heroMargin, stats, comp);
  return card;
}

// "Recommended" sort — a balanced composite that rewards items which are
// profitable AND liquid AND capital-deployable AND (on Experimental) trustworthy,
// not just one of those.
// Each metric is rank-normalised to a 0–1 percentile across the visible set
// (robust to whale outliers that would dominate a raw min-max scale), then
// weight-blended:
//   roi   — capital efficiency right now
//   daily — current absolute profit (margin × realistic trades/day); this is
//           the metric that actually rewards "use my GP" because maxFlips is
//           capped by GE buy limit and 24h volume
//   hist  — 24h-average margin, so a momentary snapshot spike doesn't win
//   vol   — liquidity / fill speed; light tiebreaker, since `daily` already
//           encodes volume through its maxFlips bottleneck
//   conf  — Experimental-only: prediction reliability (fraction of days the
//           buy/sell hour spread held historically). Items without a confidence
//           score (the realtime grid) skip this metric — the other weights are
//           renormalised to keep totals consistent.
// Stale items are demoted, losing/no-data flips sink below everything, and
// any flip clearing REC_MARGIN_PRIORITY is floated into a top tier.
const REC_SENTINEL = -1e15;          // stand-in for "no data" — keeps subtraction finite
const REC_MARGIN_PRIORITY = 50_000;  // flips with margin ≥ this are floated to the top
function scoreRecommended(items) {
  const n = items.length;
  if (!n) return;
  // Only score confidence when at least one item carries a prediction; on the
  // realtime grid no item has `_confidence`, so including it would just be
  // noise from a 271-way tie.
  const hasConfidence = items.some(it => it._confidence != null);
  const metrics = {
    roi:   it => (it.calc.allPresent && it.calc.roi != null) ? it.calc.roi : REC_SENTINEL,
    daily: it => (it.calc.allPresent && it.calc.margin != null && it.calc.maxFlips != null)
                   ? it.calc.margin * it.calc.maxFlips : REC_SENTINEL,
    hist:  it => historicalMargin(it.recipe) ?? REC_SENTINEL,
    vol:   it => it.calc.resultVol ?? 0,
  };
  if (hasConfidence) {
    metrics.conf = it => it._confidence != null ? it._confidence : REC_SENTINEL;
  }
  const pct = {};
  for (const key of Object.keys(metrics)) {
    const ranked = [...items].sort((a, b) => metrics[key](a) - metrics[key](b));
    const m = new Map();
    ranked.forEach((it, i) => m.set(it, n > 1 ? i / (n - 1) : 1));
    pct[key] = m;
  }
  // Weights sum to 1.0 in each branch. ROI is deliberately small — high-ROI
  // micro-flips don't help if you can't deploy 100M in them.
  const w = hasConfidence
    ? { roi: 0.10, daily: 0.30, hist: 0.25, vol: 0.05, conf: 0.30 }
    : { roi: 0.10, daily: 0.40, hist: 0.40, vol: 0.10 };
  for (const it of items) {
    let s = w.roi * pct.roi.get(it)  + w.daily * pct.daily.get(it)
          + w.hist * pct.hist.get(it) + w.vol * pct.vol.get(it);
    if (hasConfidence) s += w.conf * pct.conf.get(it);
    const stale = isItemStale(it.recipe.id) ||
                  it.recipe.components.some(c => isItemStale(c.id));
    if (stale) s *= 0.2;
    // A losing flip or one with missing prices can never be "recommended".
    if (!it.calc.allPresent || !(it.calc.margin > 0)) {
      s = -1;
    } else {
      // The blended score is 0–1, so a +1 bump floats every ≥50k-margin flip
      // above every sub-50k one while the score still orders within each tier.
      if (it.calc.margin >= REC_MARGIN_PRIORITY) s += 1;
      // Component-dip bonus: a flagged buying opportunity is nudged up,
      // proportional to dip strength and capped at +0.5. _dipAgg is set only
      // on Experimental grid items (see overnightVisible), so the real-time
      // Recommended ranking is unchanged.
      if (it._dipAgg && it._dipAgg.flagged) {
        s += Math.min(-it._dipAgg.aggZ, 2) * 0.25;
      }
    }
    it._recScore = s;
  }
}

// Shared sidebar-filter predicate — true if a { recipe, calc } pair passes
// every include/exclude sidebar filter. Used by both the real-time grid and
// the Experimental grid so the two views filter identically.
function passesSidebarFilters(recipe, calc) {
  const f = state.filters;
  const q = f.search.toLowerCase().trim();
  // Tags are all selected by default; a recipe shows while ANY of its tags
  // is still selected. Deselecting every tag hides everything.
  if (!recipe._tags.some(t => f.activeCats.has(t))) return false;
  if (f.maxSlots !== null && recipe.components.length > f.maxSlots) return false;
  if (q && !recipe.name.toLowerCase().includes(q)) return false;
  if (f.profitableOnly && !(calc.margin > 0)) return false;
  if (f.minCost !== null && calc.totalCost < f.minCost) return false;
  if (f.maxCost !== null && calc.totalCost > f.maxCost) return false;
  if (f.hideStaleProducts && isItemStale(recipe.id)) return false;
  if (f.hideStaleComponents && recipe.components.some(c => isItemStale(c.id))) return false;
  if (f.hideLowVolume) {
    const productVolPerHr = perHour(calc.resultVol);
    if (productVolPerHr == null || productVolPerHr < 1) return false;
  }
  if (f.favoritesOnly && !state.favorites.has(recipe.key)) return false;
  return true;
}

// Sort a { recipe, calc } list in place by the active Sort-by option. Shared
// by the real-time and Experimental grids.
function sortRecipeList(items) {
  const f = state.filters;
  if (f.sort === "recommended") scoreRecommended(items);
  const sortFns = {
    "recommended": (a, b) => (b._recScore ?? -Infinity) - (a._recScore ?? -Infinity),
    "margin-desc": (a, b) => (b.calc.margin ?? -Infinity) - (a.calc.margin ?? -Infinity),
    "roi-desc":    (a, b) => (b.calc.roi    ?? -Infinity) - (a.calc.roi    ?? -Infinity),
    "cost-asc":    (a, b) => (a.calc.totalCost ?? Infinity) - (b.calc.totalCost ?? Infinity),
    "cost-desc":   (a, b) => (b.calc.totalCost ?? -Infinity) - (a.calc.totalCost ?? -Infinity),
    "flips-desc":  (a, b) => (b.calc.maxFlips ?? -Infinity) - (a.calc.maxFlips ?? -Infinity),
    "daily-desc":  (a, b) => ((b.calc.margin ?? 0) * (b.calc.maxFlips ?? 0)) - ((a.calc.margin ?? 0) * (a.calc.maxFlips ?? 0)),
    "name":        (a, b) => a.recipe.name.localeCompare(b.recipe.name),
  };
  items.sort(sortFns[f.sort] || sortFns["recommended"]);
  return items;
}

function applyFilters(items) {
  return sortRecipeList(items.filter(({ recipe, calc }) => passesSidebarFilters(recipe, calc)));
}

/* ---------------- Skilling mode ----------------
   Recipes flagged with a `skill` field show up here. We compute per-action
   profit using the same calcMargin pipeline as the Real-time grid, then add
   XP/hr and GP/hr derived from `ticks` (1 tick = 0.6s) or an optional
   `xpPerHourMax` override for methods where the wiki publishes a real
   measured rate (Blast Furnace etc).
---------------------------------------------------- */
const TICK_MS = 600;
function skillingStats(recipe, calc) {
  // Methods like Blast Furnace publish a measured throughput that beats any
  // tick-perfect estimate because of multi-stage parallelism. When a recipe
  // sets `actionsPerHourMax`, use it directly; otherwise derive from ticks.
  let actionsPerHour;
  if (recipe.actionsPerHourMax != null) actionsPerHour = recipe.actionsPerHourMax;
  else if (recipe.ticks) actionsPerHour = 3600_000 / (recipe.ticks * TICK_MS);
  else actionsPerHour = null;
  const gpPerHour = (actionsPerHour != null && calc.margin != null) ? calc.margin * actionsPerHour : null;
  let xpPerHour = null;
  if (recipe.xpPerHourMax != null) xpPerHour = recipe.xpPerHourMax;
  else if (recipe.xp != null && actionsPerHour != null) xpPerHour = recipe.xp * actionsPerHour;
  const gpPerXp = (calc.margin != null && recipe.xp) ? calc.margin / recipe.xp : null;
  return { actionsPerHour, gpPerHour, xpPerHour, gpPerXp };
}

function sortSkillingItems(items) {
  const key = state.filters.skillingSort || "gphr-desc";
  const cmp = {
    "gphr-desc":   (a, b) => (b.s.gpPerHour ?? -Infinity) - (a.s.gpPerHour ?? -Infinity),
    "xphr-desc":   (a, b) => (b.s.xpPerHour ?? -Infinity) - (a.s.xpPerHour ?? -Infinity),
    "gpxp-desc":   (a, b) => (b.s.gpPerXp   ?? -Infinity) - (a.s.gpPerXp   ?? -Infinity),
    "gpxp-asc":    (a, b) => (a.s.gpPerXp   ??  Infinity) - (b.s.gpPerXp   ??  Infinity),
    "margin-desc": (a, b) => (b.calc.margin ?? -Infinity) - (a.calc.margin ?? -Infinity),
    "level-asc":   (a, b) => (a.recipe.level ?? Infinity) - (b.recipe.level ?? Infinity),
    "name-asc":    (a, b) => a.recipe.name.localeCompare(b.recipe.name),
  }[key];
  items.sort(cmp || cmp["gphr-desc"]);
}

function fmtXp(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return Math.round(n).toLocaleString();
}

function renderSkillingCard(recipe, calc, s) {
  const card = el("article", { class: "card skilling-card" });
  if (calc.margin != null) card.classList.add(calc.margin > 0 ? "profit" : "loss");
  card.onclick = () => openModal(recipe);

  const iconBox = el("div", { class: "card-icon" });
  const img = el("img", { attrs: { alt: "", loading: "lazy", src: recipeIcon(recipe) } });
  img.onerror = () => { img.style.display = "none"; };
  iconBox.appendChild(img);

  const catRow = el("div", { class: "card-cat-row" },
    el("span", { class: "card-cat", text: recipe.skill || recipe.cat }),
  );
  if (recipe.level != null) catRow.appendChild(el("span", { class: "skill-chip", text: `Lvl ${recipe.level}` }));

  const nameDiv = el("div", { class: "card-name", text: recipe.name });
  const titleBox = el("div", { class: "card-title" }, nameDiv, catRow);
  const isFav = state.favorites.has(recipe.key);
  const star = el("button", {
    class: "card-star" + (isFav ? " active" : ""),
    attrs: { title: isFav ? "Remove favorite" : "Add favorite", "aria-label": "Toggle favorite" },
    text: isFav ? "★" : "☆",
  });
  star.onclick = (e) => {
    e.stopPropagation();
    if (state.favorites.has(recipe.key)) state.favorites.delete(recipe.key);
    else state.favorites.add(recipe.key);
    localStorage.setItem("osrs-combo-favorites", JSON.stringify([...state.favorites]));
    renderGrid();
  };
  const head = el("div", { class: "card-head" }, star, iconBox, titleBox);
  card.appendChild(head);

  const stats = el("div", { class: "card-stats skilling-stats" });
  const row = (label, value, cls) => {
    const r = el("div", { class: "stat-row " + (cls || "") });
    r.appendChild(el("span", { class: "stat-label", text: label }));
    r.appendChild(el("span", { class: "stat-value", text: value }));
    return r;
  };
  stats.appendChild(row("Margin / action", calc.margin != null ? fmtGp(calc.margin) : "—",
    calc.margin != null ? (calc.margin > 0 ? "v-good" : "v-bad") : ""));
  stats.appendChild(row("GP / hr",  s.gpPerHour != null ? fmtGp(Math.round(s.gpPerHour)) : "—",
    s.gpPerHour != null ? (s.gpPerHour > 0 ? "v-good" : "v-bad") : ""));
  stats.appendChild(row("XP / action", recipe.xp != null ? recipe.xp.toLocaleString() : "—"));
  stats.appendChild(row("XP / hr",  s.xpPerHour != null ? fmtXp(s.xpPerHour) : "—"));
  if (s.gpPerXp != null) {
    stats.appendChild(row("GP / XP",
      fmtGp(Math.round(s.gpPerXp * 10) / 10),
      s.gpPerXp > 0 ? "v-good" : s.gpPerXp < 0 ? "v-bad" : ""));
  }
  // Trade volume: 24h volume of the output, plus a hint about whether the
  // most-constrained component might bottleneck supply.
  if (calc.resultVol != null) {
    stats.appendChild(row("Vol (24h)", fmtVol(calc.resultVol)));
  }
  const minCompVol = calc.compVols ? Math.min(...Object.values(calc.compVols).filter((v) => v != null)) : null;
  if (Number.isFinite(minCompVol)) {
    stats.appendChild(row("Min input vol", fmtVol(minCompVol)));
  }
  card.appendChild(stats);
  return card;
}

// Stable tier ordering across skills — alphabetical would put Adamant first.
// Extended with Amethyst and Dragon so Seeking arrows' tier chips sort
// alongside Smithing/Fletching progression, not appended alphabetically.
const TIER_ORDER = ["Bronze", "Iron", "Silver", "Steel", "Gold", "Mithril", "Adamant", "Rune", "Amethyst", "Dragon"];

function renderSkillingChipGroup(hostId, field, activeSet, storageKey, customOrder) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.replaceChildren();
  const skill = state.filters.skillingSkill;
  const values = new Set();
  for (const r of RECIPES) {
    if (!r.skill) continue;
    if (skill !== "all" && r.skill !== skill) continue;
    if (r[field]) values.add(r[field]);
  }
  let ordered;
  if (customOrder) {
    ordered = customOrder.filter((v) => values.has(v));
    for (const v of [...values].sort()) if (!ordered.includes(v)) ordered.push(v);
  } else {
    ordered = [...values].sort();
  }
  for (const v of ordered) {
    const chip = el("button", {
      class: "cat-chip" + (activeSet.has(v) ? " active" : ""),
      attrs: { type: "button" },
      text: v,
    });
    chip.addEventListener("click", () => {
      if (activeSet.has(v)) activeSet.delete(v); else activeSet.add(v);
      localStorage.setItem(storageKey, JSON.stringify([...activeSet]));
      renderSkillingSubCatChips();
      renderSkillingTierChips();
      renderGrid();
    });
    host.appendChild(chip);
  }
}

function renderSkillingSubCatChips() {
  renderSkillingChipGroup(
    "skilling-subcats", "subCat",
    state.filters.skillingSubCats,
    "osrs-combo-skilling-subcats"
  );
}

function renderSkillingTierChips() {
  renderSkillingChipGroup(
    "skilling-tiers", "tier",
    state.filters.skillingTiers,
    "osrs-combo-skilling-tiers",
    TIER_ORDER
  );
}

// Herblore boost modifiers: amulet gives a small chance of +1 dose (4-dose
// instead of 3-dose) which we model as ~+5%/3 ≈ 1.67% revenue boost (approx,
// assumes 4-dose price ≈ 4/3 × 3-dose). Goggles save 10% of secondary cost.
function applyHerbloreModifiers(recipe, calc) {
  if (recipe.skill !== "Herblore") return calc;
  let revenueMultiplier = 1.0;
  if (state.filters.herbloreAmulet === "chemistry") revenueMultiplier = 1 + 0.05 / 3;
  else if (state.filters.herbloreAmulet === "alchemist") revenueMultiplier = 1 + 0.075 / 3;
  const secondarySave = state.filters.herbloreGoggles ? 0.10 : 0;
  if (revenueMultiplier === 1 && secondarySave === 0) return calc;

  // Secondary is component index 1 by Herblore-scraper convention (the unf
  // is index 0). Discount its contribution to the total cost.
  let secondaryCost = 0;
  if (recipe.components.length >= 2) {
    const secId = recipe.components[1].id;
    const sp = supplyPrice(state.prices[secId]);
    if (sp != null) secondaryCost = sp * recipe.components[1].qty;
  }
  const secondaryDiscount = secondaryCost * secondarySave;
  const newRevenue = (calc.revenue || 0) * revenueMultiplier;
  const newTax = newRevenue * 0.02; // approximation; potions never hit the 5M cap
  const newCost = (calc.totalCost || 0) - secondaryDiscount;
  const newMargin = newRevenue - newTax - newCost;
  return { ...calc, revenue: newRevenue, tax: newTax, totalCost: newCost, margin: newMargin };
}

// Cooking burn rate (per recipe, with the user's current setup applied).
//   recipe.burnStopFire   - level you stop burning on a fire (-1 = always burns)
//   recipe.burnStopRange  - level you stop burning on a regular range
//   recipe.burnStopRangeGauntlets - level you stop burning on a range with
//     Cooking gauntlets (only set for gauntlets-affected fish)
// Linear interpolation between recipe.level (max burn) and stop level (no
// burn). When stop is -1 (always burns), use a fixed 40% burn rate as a
// stand-in for "high, never improves". When stop is undefined, no data ->
// assume no burn (fine for foods that just don't burn meaningfully).
const ALWAYS_BURNS_RATE = 0.40;
function cookingBurnRate(recipe) {
  if (state.filters.cookingCape) return 0;
  const level = state.filters.cookingLevel || 99;
  if (level < (recipe.level || 1)) return 0; // can't even cook this yet
  const method = state.filters.cookingMethod;
  let stop;
  if (method === "fire") {
    stop = recipe.burnStopFire;
  } else {
    stop = (state.filters.cookingGauntlets && recipe.burnStopRangeGauntlets != null)
      ? recipe.burnStopRangeGauntlets
      : recipe.burnStopRange;
  }
  if (stop === -1) return ALWAYS_BURNS_RATE;
  if (stop == null) return 0;
  if (level >= stop) return 0;
  const minLvl = recipe.level || 1;
  if (stop <= minLvl) return 0;
  return Math.max(0, Math.min(1, (stop - level) / (stop - minLvl)));
}
function applyCookingModifiers(recipe, calc) {
  if (recipe.skill !== "Cooking") return calc;
  const burn = cookingBurnRate(recipe);
  if (burn === 0) return calc;
  const yieldRate = 1 - burn;
  const newRevenue = (calc.revenue || 0) * yieldRate;
  const newTax = (calc.tax || 0) * yieldRate;
  const newMargin = newRevenue - newTax - (calc.totalCost || 0);
  return { ...calc, revenue: newRevenue, tax: newTax, margin: newMargin };
}

// Fletching knife (Vale Totems reward, July 2025): -1 tick per fletching
// action (after the first item in a batch). For batch-style actions
// (arrows/bolts/darts at ~3 ticks/click), this is roughly a 1.5x speed
// boost; for bows at ~3 ticks/cut, similar. We just multiply
// actionsPerHourMax by 1.5 as the approximation.
function applyFletchingModifiers(recipe, calc) {
  if (recipe.skill !== "Fletching") return { recipe, calc };
  if (!state.filters.fletchingKnife) return { recipe, calc };
  const factor = 1.5;
  const adjustedRecipe = {
    ...recipe,
    actionsPerHourMax: (recipe.actionsPerHourMax || 0) * factor,
    ticks: recipe.ticks ? Math.max(1, Math.round(recipe.ticks / factor)) : recipe.ticks,
  };
  // Per-action revenue/cost/margin don't change — only the rate. Card numbers
  // (GP/hr, XP/hr) derive in skillingStats from the recipe's actions/hr, so
  // no calc adjustment is needed here.
  return { recipe: adjustedRecipe, calc };
}

// Smithing boosts:
//   Smith's uniform pieces (0-4): each piece is 20% chance to perform an
//     anvil-smithing action 1 tick faster. Expected ticks = T - 0.2 × pieces.
//     Full set always saves a tick. Applies to anvil smithing only --
//     skipped for "Bars" (smelted at a furnace) and cannonballs (furnace too).
//   Double ammo mould: 2 bars -> 8 cannonballs per action (cannonballs only).
//   Ancient Furnace: 5 ticks per action instead of 10 (cannonballs only).
function applySmithingModifiers(recipe, calc) {
  if (recipe.skill !== "Smithing") return { recipe, calc };

  const isCannonball = recipe.name.toLowerCase().includes("cannonball");
  const isBar = recipe.subCat === "Bars";

  let adjustedRecipe = recipe;
  let adjustedCalc = calc;

  // Smith's uniform: anvil-smithed items only (not bars, not cannonballs).
  const pieces = Math.max(0, Math.min(4, state.filters.smithingOutfitPieces || 0));
  if (pieces > 0 && !isCannonball && !isBar && recipe.ticks != null) {
    const expectedTicks = Math.max(1, recipe.ticks - 0.2 * pieces);
    adjustedRecipe = { ...adjustedRecipe, ticks: expectedTicks };
  }

  // Cannonball-only stack (double mould + Ancient Furnace).
  if (isCannonball) {
    const dm = state.filters.smithingDoubleMould;
    const af = state.filters.smithingAncientFurnace;
    if (dm || af) {
      const outMul = dm ? 2 : 1;
      const ticks = adjustedRecipe.ticks != null
        ? (af ? Math.max(1, Math.round(adjustedRecipe.ticks / 2)) : adjustedRecipe.ticks)
        : adjustedRecipe.ticks;
      adjustedRecipe = { ...adjustedRecipe, xp: adjustedRecipe.xp * outMul, ticks };
      adjustedCalc = {
        ...adjustedCalc,
        revenue:   (adjustedCalc.revenue   || 0) * outMul,
        totalCost: (adjustedCalc.totalCost || 0) * outMul,
        tax:       (adjustedCalc.tax       || 0) * outMul,
        margin: adjustedCalc.margin != null ? adjustedCalc.margin * outMul : null,
      };
    }
  }

  return { recipe: adjustedRecipe, calc: adjustedCalc };
}

// Runecrafting boosts:
//   Level — picks the rune multiplier (1x-10x) from recipe.multiplierBreakpoints.
//     The breakpoints array is the player level needed for 1x, 2x, 3x...  We
//     count how many entries are <= current level. Below the first entry, the
//     recipe is unreachable but we still display a 1x estimate so the card
//     doesn't disappear.
//   Raiments of the Eye — +10% bonus runes per piece, +20% set bonus on top
//     of the 40% from 4 pieces (total +60% with full set). Output only — XP
//     unaffected.
//   Daeyalt essence — +50% XP, swaps pure-essence cost for daeyalt-essence
//     cost. Doesn't affect dense-essence (Blood/Soul) recipes.
const DAEYALT_ESSENCE_ID = 24704;
function runecraftMultiplier(recipe, level) {
  const bps = recipe.multiplierBreakpoints;
  if (!bps || !bps.length) return 1;
  let m = 0;
  for (const lvl of bps) { if (level >= lvl) m++; else break; }
  return Math.max(1, m);
}
function raimentsBonus(pieces) {
  if (pieces <= 0) return 0;
  if (pieces >= 4) return 0.60; // 40% from 4 pieces + 20% set bonus
  return pieces * 0.10;
}
function applyRunecraftingModifiers(recipe, calc) {
  if (recipe.skill !== "Runecrafting") return { recipe, calc };
  const level = state.filters.runecraftingLevel || 99;
  const mult = runecraftMultiplier(recipe, level);
  const raiments = raimentsBonus(state.filters.runecraftingRaiments || 0);
  const useDaeyalt = state.filters.runecraftingEssence === "daeyalt"
    && recipe.essenceType === "pure";
  const noNecklace = recipe.combo && !state.filters.runecraftingBindingNecklace;

  const outputScale = mult * (1 + raiments);
  const xpScale = useDaeyalt ? 1.5 : 1;
  let adjustedRecipe = { ...recipe, xp: recipe.xp * xpScale };
  let adjustedCalc = calc;

  // Scale revenue / tax / margin by extra runes produced. NB: calcMargin
  // returns the tax field as `geTax`, not `tax`.
  if (outputScale !== 1) {
    const newRevenue = (calc.revenue || 0) * outputScale;
    const newGeTax = (calc.geTax || 0) * outputScale;
    const newMargin = newRevenue - newGeTax - (calc.totalCost || 0);
    adjustedCalc = { ...adjustedCalc, revenue: newRevenue, geTax: newGeTax, margin: newMargin };
  }

  // Effective per-essence cost depends on which essence type is selected.
  // We compute this once so both the daeyalt swap and the combo-failure
  // surcharge add the right thing.
  const essComp = recipe.components[0];
  const essPrice = essComp
    ? (useDaeyalt
        ? supplyPrice(state.prices[DAEYALT_ESSENCE_ID])
        : supplyPrice(state.prices[essComp.id]))
    : null;

  // Daeyalt essence costs more than pure — swap the supply cost.
  if (useDaeyalt && essComp) {
    const purePrice = supplyPrice(state.prices[essComp.id]);
    if (essPrice != null) {
      const delta = (essPrice - (purePrice || 0)) * essComp.qty;
      const newCost = (adjustedCalc.totalCost || 0) + delta;
      const newMargin = (adjustedCalc.revenue || 0) - (adjustedCalc.geTax || 0) - newCost;
      adjustedCalc = { ...adjustedCalc, totalCost: newCost, margin: newMargin };
    }
  }

  // Combo runes without a binding necklace: 50% of essences are wasted on
  // failed crafts (the base rune isn't consumed on failure, only the
  // essence). Per successful craft, that averages out to 2 essences spent,
  // so we add one extra essence's worth to the cost.
  if (noNecklace && essComp && essPrice != null) {
    const extraCost = essPrice * essComp.qty;
    const newCost = (adjustedCalc.totalCost || 0) + extraCost;
    const newMargin = (adjustedCalc.revenue || 0) - (adjustedCalc.geTax || 0) - newCost;
    adjustedCalc = { ...adjustedCalc, totalCost: newCost, margin: newMargin };
  }
  return { recipe: adjustedRecipe, calc: adjustedCalc };
}

function renderSkilling() {
  const grid = document.getElementById("grid");
  const tableWrap = document.getElementById("table-wrap");
  tableWrap.hidden = true;
  grid.hidden = false;
  grid.replaceChildren();

  const search = (state.filters.search || "").toLowerCase().trim();
  const skill = state.filters.skillingSkill;
  const subCats = state.filters.skillingSubCats;
  const tiers = state.filters.skillingTiers;
  const items = RECIPES
    .filter((r) => r.skill)
    .filter((r) => skill === "all" || r.skill === skill)
    .filter((r) => subCats.size === 0 || (r.subCat && subCats.has(r.subCat)))
    .filter((r) => tiers.size === 0 || (r.tier && tiers.has(r.tier)))
    .map((r) => {
      let calc = applyHerbloreModifiers(r, calcMargin(r));
      calc = applyCookingModifiers(r, calc);
      const sm = applySmithingModifiers(r, calc);
      const fl = applyFletchingModifiers(sm.recipe, sm.calc);
      const rc = applyRunecraftingModifiers(fl.recipe, fl.calc);
      return { recipe: rc.recipe, calc: rc.calc, s: skillingStats(rc.recipe, rc.calc) };
    })
    .filter(({ recipe }) => !search || recipe.name.toLowerCase().includes(search));

  if (!items.length) {
    grid.appendChild(el("div", { class: "empty", text: "No skilling methods match the current filters." }));
    return;
  }

  sortSkillingItems(items);
  const frag = document.createDocumentFragment();
  for (const { recipe, calc, s } of items) frag.appendChild(renderSkillingCard(recipe, calc, s));
  grid.appendChild(frag);
}

/* ---------------- Market Indexes ----------------
   Aggregate DJIA-style indexes: sum(basket item prices) / divisor. Live
   values come from state.prices; historical values are computed on modal
   open by fetching each basket item's /timeseries and summing per timestamp
   with forward-fill on sparse items. Basket + divisor definitions come from
   dist/market-indexes.js (scraped from the wiki + hand-curated customs).
---------------------------------------------------- */
function computeIndexValue(idx) {
  let sum = 0, contributing = 0;
  for (const item of idx.items) {
    const p = state.prices[item.id];
    if (!p || (p.high == null && p.low == null)) continue;
    // Mid-price matches the wiki's "guide price" convention. Missing sides
    // fall back to the other side of the spread rather than dropping.
    const mid = ((p.high ?? p.low) + (p.low ?? p.high)) / 2;
    sum += mid;
    contributing++;
  }
  return {
    value: sum / idx.divisor,
    contributing,
    total: idx.items.length,
  };
}

// 24h change: uses the wiki's /24h rolling average as the "24h-ago" reference.
// Not exactly "value at t-24h" — it's the mean over the past window — but the
// approximation is close enough for a directional chip. Returns null when the
// current or 24h-avg basket coverage is too thin to trust the comparison.
function computeIndex24hChange(idx) {
  const nowValue = computeIndexValue(idx).value;
  if (!isFinite(nowValue) || nowValue === 0) return null;
  const avg = state.avg24h;
  if (!avg) return null;
  let sum24 = 0, contributing = 0;
  for (const item of idx.items) {
    const p = avg[item.id];
    if (!p || (p.high == null && p.low == null)) continue;
    const mid = ((p.high ?? p.low) + (p.low ?? p.high)) / 2;
    sum24 += mid;
    contributing++;
  }
  // Skip the chip if <70% of the basket has a 24h avg — otherwise a couple of
  // items dropping in/out over the day would swing the calc absurdly.
  if (contributing < idx.items.length * 0.7) return null;
  const past = sum24 / idx.divisor;
  if (past === 0) return null;
  return (nowValue - past) / past;  // signed fraction: +0.05 = up 5%
}

function renderMarket() {
  const grid = document.getElementById("grid");
  const tableWrap = document.getElementById("table-wrap");
  tableWrap.hidden = true;
  grid.hidden = false;
  grid.replaceChildren();

  if (typeof MARKET_INDEXES === "undefined" || !Array.isArray(MARKET_INDEXES)) {
    grid.appendChild(el("div", { class: "empty", text: "Market indexes data not loaded." }));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const idx of MARKET_INDEXES) frag.appendChild(renderIndexCard(idx));
  grid.appendChild(frag);
}

function renderIndexCard(idx) {
  const card = el("article", { class: "card market-card" });
  card.onclick = () => openIndexModal(idx);
  const { value, contributing, total } = computeIndexValue(idx);

  const titleBox = el("div", { class: "card-title" });
  titleBox.appendChild(el("div", { class: "card-name", text: idx.name }));
  const catRow = el("div", { class: "card-cat-row" },
    el("span", { class: "card-cat", text: idx.source === "wiki" ? "Wiki" : "Custom" }),
    el("span", { class: "skill-chip", text: `${total} items` })
  );
  titleBox.appendChild(catRow);
  card.appendChild(el("div", { class: "card-head market-head" }, titleBox));

  const stats = el("div", { class: "card-stats market-stats" });
  const row = (label, val) => {
    const r = el("div", { class: "stat-row" });
    r.appendChild(el("span", { class: "stat-label", text: label }));
    r.appendChild(el("span", { class: "stat-value", text: val }));
    return r;
  };
  stats.appendChild(row("Current value", contributing > 0 ? fmtGp(Math.round(value)) : "—"));

  // 24h change chip — green for gains, red for losses, muted for flat/no-data
  const change = computeIndex24hChange(idx);
  const chipRow = el("div", { class: "stat-row" });
  chipRow.appendChild(el("span", { class: "stat-label", text: "24h change" }));
  if (change == null) {
    chipRow.appendChild(el("span", { class: "stat-value", text: "—" }));
  } else {
    const pct = change * 100;
    const cls = pct >= 0.5 ? "market-chip-up"
             : pct <= -0.5 ? "market-chip-down"
             : "market-chip-flat";
    const arrow = pct >= 0.5 ? "▲" : pct <= -0.5 ? "▼" : "→";
    const chip = el("span", { class: `market-chip ${cls}`,
      text: `${arrow} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` });
    const wrap = el("span", { class: "stat-value" });
    wrap.appendChild(chip);
    chipRow.appendChild(wrap);
  }
  stats.appendChild(chipRow);

  stats.appendChild(row("Divisor", String(idx.divisor)));
  if (contributing < total) {
    stats.appendChild(row("Priced items", `${contributing} / ${total}`));
  }
  if (idx.description) {
    const d = el("div", { class: "market-desc", text: idx.description });
    stats.appendChild(d);
  }
  card.appendChild(stats);
  return card;
}

/* ---------------- Bulk Allocator ----------------
   Given a budget, a time horizon, and a slot cap, propose an allocation
   of profitable recipes that maximises expected profit while respecting:
   - Budget: total cost of buys ≤ budget
   - GE slots: at most `slots` recipes assigned (each recipe conservatively
     takes ~2 slots — buy phase + sell phase; we model 1 slot per recipe
     since the buy phase serialises easily but a distinct recipe can't
     share its sell slot)
   - GE buy limits: per-recipe unit count ≤ limitFlipsPer4h (or × 6 for
     the "one day" horizon)
   - Filters: profitableOnly always applied; optional confidence and
     skip-skilling toggles

   Uses a greedy sort-by-profit-density algorithm. Bounded knapsack is
   NP-hard in general but the small item count (~275 combos + 500 skilling)
   and the tight budget-per-recipe ceiling mean greedy is within a
   percent or two of the optimal LP-relaxation solution — good enough,
   sub-millisecond compute, trivial to explain.
---------------------------------------------------- */
// Horizon vocabulary — string codes map to hours. Extending the set (1h /
// 2h / 8h / 12h) required an internal representation that isn't hard-coded
// to two branches. hoursForHorizon() is the single source of truth; every
// consumer downstream works in hours.
const HORIZON_HOURS = { "1h": 1, "2h": 2, "4h": 4, "8h": 8, "12h": 12, "1d": 24 };
function hoursForHorizon(h) { return HORIZON_HOURS[h] ?? 24; }
// A single GE buy-limit window is 4h wide. This tells us how many windows
// fit in the horizon — for the slot-budget calc below.
function buyWindowsForHorizon(h) { return Math.max(1, Math.ceil(hoursForHorizon(h) / 4)); }

function allocateRecipes(opts) {
  const {
    budget, horizon, slots, maxPerRecipePct, minContribPct,
    requireConf, skipSkilling, hideStale, onlyZeroTime,
    freeSkillingSupplies, freeComponentCombines,
  } = opts;
  if (!budget || budget <= 0) return { allocations: [], totalCost: 0, totalProfit: 0, note: "Enter a budget" };
  const perRecipeCap = maxPerRecipePct > 0 && maxPerRecipePct < 100
    ? budget * (maxPerRecipePct / 100)
    : Infinity;
  // Ensure any expired hit-limits are cleared before we filter candidates —
  // otherwise a 3h59m-old entry would still block, then vanish on next tick.
  pruneHitLimits();
  const horizonH = hoursForHorizon(horizon);
  const windows = buyWindowsForHorizon(horizon);
  // NEW slot model: total buy orders that can be placed in this horizon =
  // slots × number-of-buy-windows. For a 4h horizon that's `slots` orders
  // total; for 1d that's `slots × 6`. Under 4h we still assume one full
  // window of concurrent slots (the buy-limit reset schedule doesn't cap
  // slots themselves, only per-item volume). This replaces the old "each
  // recipe = 1 slot" model which massively over-counted feasibility.
  const slotBudget = slots * windows;
  // Minimum absolute profit a single recipe must contribute to be worth
  // recommending. Framed as a % of the total budget so it scales with the
  // portfolio: a 0.05% floor on 300M = 150k minimum, on 1M = 500 gp minimum.
  // "5% ROI on 100 gp" = 5 gp profit, which is 0.0000017% of 300M — that's
  // the noise this filter kills.
  const minProfitAbsolute = budget * ((minContribPct || 0) / 100);

  // Pull the currently-viable candidates. Each carries flags for the slot-
  // accounting logic below: `freeSlot` recipes still get allocated capital
  // but don't count against the GE-slot budget.
  const candidates = [];
  const pm = window.overnightData?.predMap || {};
  for (const r of RECIPES) {
    if (skipSkilling && r.skill) continue;
    // Zero-time filter — skip any recipe that requires active crafting time
    // (currently only Oathplate armour). Skilling recipes are inherently
    // time-consuming; they're handled by `skipSkilling` above, so the
    // zero-time filter here targets the small set of non-skilling combines
    // that actually need bench time. Combines that finish instantly at the
    // GE clerk (godsword blade + hilt → godsword) pass through by default.
    if (onlyZeroTime && r.takesTime) continue;
    // User-curated exclusion — set via the "component combines" list popover.
    // Persists in localStorage. Filters at the top so nothing downstream has
    // to know about it.
    if (state.excludedRecipes.has(r.key)) continue;
    // Filler recipes are ONLY meaningful as component-slot exemptions inside
    // parent crafts (e.g. godsword blade → Armadyl godsword). They should
    // NOT appear as their own allocation cards — that would double-count
    // capital that's meant to help other crafts. Their output ID is still
    // treated as a fast-fill component via isFastFillComponent() so the
    // parent-craft slot reduction still works.
    if (freeComponentCombines && isFreeSlotFiller(r)) continue;
    // Stale filter — if any leg (product or component) has a price older than
    // the STALE_MS threshold, the calc.margin is a fossil. Skip.
    if (hideStale) {
      if (isItemStale(r.id)) continue;
      if (r.components.some(c => isItemStale(c.id))) continue;
    }
    // Hit-limit gate: skip any recipe whose product, any component, or any
    // supply is currently marked as buy-limit-hit (window not yet reset).
    if (isHitLimited(r.id)) continue;
    if (r.components.some(c => isHitLimited(c.id))) continue;
    if ((r.supplies || []).some(s => isHitLimited(s.id))) continue;
    // Per-recipe supply-strategy pick: score this recipe under BOTH slow-buy
    // and insta-buy, then choose whichever yields higher profit-per-slot for
    // this specific recipe. Honours user preference on ties. Reasons an
    // insta-buy pick can win under a "slow-buy" default:
    //   1. Missing .low — the recipe would otherwise drop entirely.
    //   2. Stale .low in a downtrending market — .high is fresher and lower.
    //   3. Rare bid-ask crossover where .high < .low outright.
    // The card gets a badge when the chosen strategy differs from user's global
    // preference so the user knows they need to insta-buy for THAT recipe.
    const calcSlow = calcMarginAt(r, "slow-buy");
    const calcInsta = calcMarginAt(r, "insta-buy");
    const slowViable = calcSlow.allPresent && calcSlow.margin > 0 && calcSlow.totalCost > 0;
    const instaViable = calcInsta.allPresent && calcInsta.margin > 0 && calcInsta.totalCost > 0;
    if (!slowViable && !instaViable) continue;
    let calc, supplyStrategyUsed;
    if (slowViable && instaViable) {
      // Both viable — pick the one with higher margin per craft (equivalent
      // to higher profit-per-slot since slotsPerUnit is strategy-independent).
      // On exact tie, honour the user's global preference so nothing changes
      // for the normal case.
      const preferSlow = state.supplyStrategy === "slow-buy";
      const slowBetter = calcSlow.margin > calcInsta.margin;
      const instaBetter = calcInsta.margin > calcSlow.margin;
      if (slowBetter) { calc = calcSlow; supplyStrategyUsed = "slow-buy"; }
      else if (instaBetter) { calc = calcInsta; supplyStrategyUsed = "insta-buy"; }
      else { calc = preferSlow ? calcSlow : calcInsta; supplyStrategyUsed = preferSlow ? "slow-buy" : "insta-buy"; }
    } else if (slowViable) {
      calc = calcSlow; supplyStrategyUsed = "slow-buy";
    } else {
      calc = calcInsta; supplyStrategyUsed = "insta-buy";
    }
    // maxUnits = the realistic flip count bounded by:
    //   1. Output side-split trade volume (product's sell-side)  }
    //   2. Every component's side-split volume (buy-side)          } via
    //   3. Recent 1h velocity blend + Wilson lower-bound shrink    } calc.maxFlipsAdjusted
    //   4. Daily GE buy limits                                     }
    // Scaled by (horizonH / 24). Prefer the adjusted count; fall back to
    // the aggregate maxFlips for items with no side-split data at all;
    // then to raw buy-limit if no volume data at all.
    const dailyCap = calc.maxFlipsAdjusted
      ?? calc.maxFlips
      ?? (calc.limitFlipsPer4h != null ? calc.limitFlipsPer4h * 6 : null);
    if (dailyCap == null || dailyCap <= 0) continue;
    const maxUnits = Math.floor(dailyCap * horizonH / 24);
    if (maxUnits <= 0) continue;
    // Cheap early-out: if this recipe can't POSSIBLY contribute enough
    // profit to matter (even at full capacity), skip it before the
    // confidence lookup. Saves per-item work on the long tail.
    if (calc.margin * maxUnits < minProfitAbsolute) continue;
    const roi = calc.margin / calc.totalCost;
    // Confidence gate — only when the recipe has predictions AND the user asked
    // for it. Recipes with no prediction (most combos when overnight hasn't
    // been analysed yet) pass through by default.
    // Confidence signal: use the PRODUCT's overnight prediction only. Legacy
    // logic AND-gated across every component, but the overnight pass rarely
    // scores raw materials — so any recipe with an unscored rune/bar/log was
    // dropped even at 80% product confidence. That made the "require 60%"
    // toggle appear to filter everything. Components without a prediction now
    // silently pass; they still affect sort weight only through the product.
    const productPred = pm[r.id];
    const conf = productPred?.confidence ?? null;
    if (requireConf && (conf == null || conf < 0.6)) continue;
    // Free-slot flags: user-configurable exclusions from the slot-budget
    // count. Same UI toggles; semantics changed to match the new model —
    // free-slot recipes STILL get budget but their buy orders don't count
    // against slotBudget. Useful for AFK skilling supplies that fill instantly.
    const isSkillingSupply = !!r.skill && freeSkillingSupplies;
    // Free-slot for combines uses the NARROW hand-curated filler set — not
    // the wider isComponentProducingRecipe heuristic. Otherwise armour sets,
    // Zenyte jewellery, Barrows pieces, etc. would all skip the slot count,
    // which was never the intent of the toggle.
    const isComponentCombine = isFreeSlotFiller(r) && freeComponentCombines;
    const freeSlot = isSkillingSupply || isComponentCombine;
    // slotsPerUnit = distinct GE buy orders per single craft = components +
    // supplies. When freeComponentCombines is on, subtract any component or
    // supply that's a fast-fill item — either explicitly listed in
    // FREE_SLOT_ITEM_IDS (e.g. crushed infernal shale) or auto-derived from
    // a filler recipe's output id (e.g. godsword blade item, because the
    // godsword-blade recipe is flagged freeSlotFiller). Recipes with 0
    // effective buys fall back to 1 so they don't sort as infinite
    // profit-per-slot.
    const compFree = freeComponentCombines
      ? (r.components || []).filter(c => isFastFillComponent(c.id)).length
      : 0;
    const suppFree = freeComponentCombines
      ? (r.supplies || []).filter(s => isFastFillComponent(s.id)).length
      : 0;
    const slotsPerUnit = Math.max(1,
      (r.components?.length || 0) + (r.supplies?.length || 0) - compFree - suppFree);
    const expectedProfit = calc.margin * maxUnits;
    candidates.push({ recipe: r, calc, maxUnits, expectedProfit, conf, roi, freeSlot, slotsPerUnit, supplyStrategyUsed });
  }
  // Sort by profit-per-slot-use × conf². With slots as the binding constraint,
  // greedy "most profit per scarce buy-slot" produces the highest total profit
  // deployment. Sorting by absolute expected profit (the old key) would let
  // one fat 5-component recipe eat the entire slot budget; profit-density
  // keeps the mix balanced. Free-slot recipes still sort by density but don't
  // decrement the budget when picked.
  candidates.sort((a, b) => {
    const aw = (a.expectedProfit / a.slotsPerUnit) * ((a.conf ?? 0.5) ** 2);
    const bw = (b.expectedProfit / b.slotsPerUnit) * ((b.conf ?? 0.5) ** 2);
    return bw - aw;
  });

  // Greedy fill: walk candidates by profit-per-slot. Each recipe's slot cost
  // = count × slotsPerUnit. Stop when the slot budget is exhausted (excluding
  // free-slot recipes) or budget is spent.
  let remainingBudget = budget;
  let slotsUsedTotal = 0;   // in slot-uses (buy orders), NOT recipes
  const allocations = [];
  let hitSlotCap = false;
  for (const cand of candidates) {
    if (remainingBudget <= 0) break;
    const slotsRemaining = slotBudget - slotsUsedTotal;
    if (!cand.freeSlot && slotsRemaining <= 0) { hitSlotCap = true; continue; }
    // How much of THIS recipe can we buy?
    //   - Budget-limited by remaining budget
    //   - Diversification-limited by per-recipe cap (percentage of total budget)
    //   - Volume-limited by maxUnits (calc.maxFlips × horizonH/24)
    //   - Slot-limited by remaining slot budget ÷ slotsPerUnit (free recipes exempt)
    const budgetLimited = Math.floor(remainingBudget / cand.calc.totalCost);
    const perRecipeLimited = Math.floor(perRecipeCap / cand.calc.totalCost);
    const slotLimited = cand.freeSlot ? Infinity
      : Math.floor(slotsRemaining / cand.slotsPerUnit);
    const count = Math.min(cand.maxUnits, budgetLimited, perRecipeLimited, slotLimited);
    if (count <= 0) continue;
    const cost = count * cand.calc.totalCost;
    const profit = count * cand.calc.margin;
    // Second-pass contribution check — the recipe COULD contribute enough
    // (early-out passed above at max-units), but after budget/per-recipe
    // caps it may only get a slice that IS below threshold. Skip those so
    // we don't waste slots on a token allocation.
    if (profit < minProfitAbsolute) continue;
    // Buy-order count: how many discrete GE buys the user has to place for
    // this recipe. Under the new model this IS the slot-use count, so it
    // also drives the slot budget bookkeeping below.
    let buyOrderCount = 0;
    for (const c of cand.recipe.components) buyOrderCount += c.qty * count;
    for (const s of (cand.recipe.supplies || [])) buyOrderCount += s.qty * count;
    // slotsPerUnit counts DISTINCT components/supplies (not qty), so
    // slotUseCount here (for slot-budget bookkeeping) is count × slotsPerUnit,
    // not buyOrderCount — a 6× Adamant set = 6 crafts × 4 distinct-item buys
    // = 24 slot-uses of 6-unit orders (each order stacks the qty for that item).
    const slotUseCount = count * cand.slotsPerUnit;

    allocations.push({
      recipe: cand.recipe,
      calc: cand.calc,
      count,
      cost,
      profit,
      confidence: cand.conf,
      freeSlot: cand.freeSlot,
      roi: cand.roi,
      buyOrderCount,
      slotUseCount,
      supplyStrategyUsed: cand.supplyStrategyUsed,
    });
    remainingBudget -= cost;
    if (!cand.freeSlot) slotsUsedTotal += slotUseCount;
  }
  const totalCost = allocations.reduce((s, a) => s + a.cost, 0);
  const totalProfit = allocations.reduce((s, a) => s + a.profit, 0);
  const deployedPct = (totalCost / budget) * 100;
  return {
    allocations,
    totalCost,
    totalProfit,
    remainingBudget,
    slotsUsed: slotsUsedTotal,   // slot-uses (buy orders), not recipe count
    slots,                       // concurrent slot cap (per window)
    slotBudget,                  // total buy orders allowed = slots × windows
    windows,                     // buy-limit windows the horizon covers
    horizon,                     // horizon code, e.g. "4h" / "1d"
    horizonH,                    // horizon in hours (for display)
    candidatesConsidered: candidates.length,
    deployedPct,
    // If we ran out of viable recipes before deploying the budget, tell the
    // user why so they can adjust inputs (relax min ROI, enable free slots,
    // extend horizon, etc.) rather than wondering why it stopped.
    exhaustedReason:
      remainingBudget <= 0 ? "budget fully deployed"
      : hitSlotCap ? `slot budget (${slotBudget} = ${slots} slots × ${windows} × 4h windows) exhausted before budget — extend the horizon, raise the slot count, or enable free-slot toggles for supplies/component combines.`
      : `no more candidates can contribute > ${minContribPct}% of budget (${fmtGp(Math.round(minProfitAbsolute))}) in profit — lower the min-contribution or relax the other filters`,
  };
}

// Banner listing every recipe the user has permanently hidden via the card
// "🚫 hide this craft" button (state.excludedRecipes). Each chip has a ×
// to unhide directly, so the user doesn't have to hunt through the curator
// popovers to bring a recipe back. Renders unconditionally so it stays
// visible even when the allocation grid is empty.
function renderHiddenRecipesBanner(grid) {
  if (!state.excludedRecipes.size) return;
  // Resolve keys → recipe objects. Filter out any stale keys that no
  // longer match a live recipe (e.g. after a rename in the data).
  const keyToRecipe = new Map(RECIPES.map(r => [r.key, r]));
  const hiddenRecipes = Array.from(state.excludedRecipes)
    .map(k => keyToRecipe.get(k))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!hiddenRecipes.length) return;
  const banner = el("div", { class: "hidden-recipes-banner" });
  banner.appendChild(el("div", { class: "hidden-recipes-banner-title",
    text: `${hiddenRecipes.length} craft${hiddenRecipes.length === 1 ? "" : "s"} hidden from allocation` }));
  const chips = el("div", { class: "hidden-recipes-chip-row" });
  for (const r of hiddenRecipes) {
    const chip = el("button", { class: "hidden-recipes-chip",
      attrs: { title: `Click to unhide "${r.name}" and include it in allocation again.` } });
    chip.appendChild(el("span", { class: "hidden-recipes-chip-name", text: r.name }));
    chip.appendChild(el("span", { class: "hidden-recipes-chip-x", text: "×" }));
    chip.onclick = (e) => {
      e.stopPropagation();
      setRecipeExcluded(r.key, false);
      document.getElementById("allocate-btn").click();
    };
    chips.appendChild(chip);
  }
  banner.appendChild(chips);
  grid.appendChild(banner);
}

function renderAllocate() {
  const grid = document.getElementById("grid");
  const tableWrap = document.getElementById("table-wrap");
  tableWrap.hidden = true;
  grid.hidden = false;
  grid.replaceChildren();

  // Render the "hidden recipes" banner FIRST — before any early-return
  // paths — so the user can always unhide crafts even when the current
  // allocation is empty or the calculator hasn't been run yet. Otherwise
  // hiding your last viable craft would leave you with an empty grid and
  // no way to bring it back without opening a curator popover.
  renderHiddenRecipesBanner(grid);

  const alloc = state.allocation;
  if (!alloc) {
    grid.appendChild(el("div", { class: "empty",
      text: "Enter a budget in the sidebar and click Calculate allocation." }));
    return;
  }
  if (alloc.note) {
    grid.appendChild(el("div", { class: "empty", text: alloc.note }));
    return;
  }
  if (!alloc.allocations.length) {
    grid.appendChild(el("div", { class: "empty",
      text: "No profitable recipes match the current filters + budget." }));
    return;
  }

  // Header summary
  const summary = el("div", { class: "allocate-summary" });
  const row = (label, val) => {
    summary.appendChild(el("div", { class: "allocate-summary-cell" },
      el("div", { class: "allocate-summary-label", text: label }),
      el("div", { class: "allocate-summary-value", text: val })));
  };
  // Slot-budget line: total buy orders placed vs the slot budget. Under the
  // new model this IS the binding constraint (not "recipes allocated"), so
  // it's the second thing the user should see. The tooltip explains WHY the
  // total isn't just `slots` — it scales with horizon in 4h windows.
  const slotTooltip = `Total distinct GE buy orders you'll place across all allocations. `
    + `Slot budget = ${alloc.slots} slots × ${alloc.windows} × 4h windows (buy-limit resets) = ${alloc.slotBudget}. `
    + `Free-slot recipes (via the toggles) don't count against this total.`;
  // Total buy-order COUNT — the number of actual buy fills, which can be
  // higher than slot-uses when a recipe buys 6× of one component in a single
  // slot. Same tooltip caveats about liquidity — bulk items fill fast, rare
  // items sit for hours.
  const totalBuys = alloc.allocations.reduce((s, a) => s + (a.buyOrderCount || 0), 0);

  row("Recipes allocated", String(alloc.allocations.length));
  {
    const cell = el("div", { class: "allocate-summary-cell", attrs: { title: slotTooltip } });
    cell.appendChild(el("div", { class: "allocate-summary-label", text: "Slot budget used" }));
    cell.appendChild(el("div", { class: "allocate-summary-value", text: `${alloc.slotsUsed} / ${alloc.slotBudget}` }));
    summary.appendChild(cell);
  }
  row("Total buy fills", totalBuys.toLocaleString());
  row("Capital deployed", `${fmtGp(alloc.totalCost)} (${alloc.deployedPct.toFixed(1)}%)`);
  row("Budget remaining", fmtGp(alloc.remainingBudget));
  row("Expected profit", fmtGp(Math.round(alloc.totalProfit)));
  row("Expected ROI", ((alloc.totalProfit / alloc.totalCost) * 100).toFixed(2) + "%");
  row("Stopped because", alloc.exhaustedReason);
  grid.appendChild(summary);

  // Hit-limit banner — items the user has marked as "buy limit hit". These
  // are EXCLUDED from the allocation above, so the user needs a visible
  // reminder + a per-item unmark button so they can free items back up as
  // buy-limit windows expire (or if they marked one by mistake). Times shown
  // are the remaining wait before the mark auto-expires.
  const marked = Object.keys(state.hitLimits);
  if (marked.length) {
    const banner = el("div", { class: "hit-limit-banner" });
    banner.appendChild(el("div", { class: "hit-limit-banner-title",
      text: `${marked.length} item${marked.length === 1 ? "" : "s"} excluded (buy limit hit)` }));
    const chips = el("div", { class: "hit-limit-chip-row" });
    for (const id of marked) {
      const name = state.mapping?.[id]?.name || `#${id}`;
      const chip = el("button", { class: "hit-limit-chip",
        attrs: { title: `Click to unmark. Auto-expires in ${fmtHitLimitRemaining(id)}.` } });
      chip.appendChild(el("span", { class: "hit-limit-chip-name", text: name }));
      chip.appendChild(el("span", { class: "hit-limit-chip-timer", text: fmtHitLimitRemaining(id) }));
      chip.appendChild(el("span", { class: "hit-limit-chip-x", text: "×" }));
      chip.onclick = (e) => {
        e.stopPropagation();
        unmarkHitLimit(id);
        // Re-run allocator so the just-freed item can enter the mix again.
        document.getElementById("allocate-btn").click();
      };
      chips.appendChild(chip);
    }
    banner.appendChild(chips);
    grid.appendChild(banner);
  }

  const frag = document.createDocumentFragment();
  for (const a of alloc.allocations) frag.appendChild(renderAllocationCard(a));
  grid.appendChild(frag);
}

// True when the allocator's insta-buy strategy pick on this allocation is
// likely a data-freshness artifact rather than a real "insta-buy is cheaper"
// signal. Fires when ANY component has a fresh .low that is HIGHER than the
// .high we're using — i.e. the last insta-SELL was more recent than the
// last insta-BUY and at a higher price, so the market has moved up past
// what the stale .high implies. In that case we still use the cheaper .high
// as the recommended buy price (the last insta-buy did fill there), but the
// "insta-buy supplies" chip is misleading — it's not a strategy call, it's
// stale-data optimism. See card render for suppression call site.
function isInstaBuyOverrideSpurious(a) {
  if (a.supplyStrategyUsed !== "insta-buy") return false;
  for (const c of a.recipe.components || []) {
    const p = state.prices[c.id];
    if (!p) continue;
    const hi = p.high, lo = p.low;
    const hiT = p.highTime ?? 0, loT = p.lowTime ?? 0;
    // Inverted market (lo > hi) AND the fresh side is the low → the .low
    // is the fresh number saying "market is here now", and .high is a
    // stale-cheap trade that happened to fill before the move up.
    if (hi != null && lo != null && lo > hi && loT > hiT) return true;
  }
  return false;
}

function renderAllocationCard(a) {
  const card = el("article", { class: "card allocate-card profit" });
  card.onclick = () => openModal(a.recipe);

  const iconBox = el("div", { class: "card-icon" });
  const img = el("img", { attrs: { alt: "", loading: "lazy", src: recipeIcon(a.recipe) } });
  img.onerror = () => { img.style.display = "none"; };
  iconBox.appendChild(img);

  const catRow = el("div", { class: "card-cat-row" },
    el("span", { class: "card-cat", text: a.recipe.cat }),
  );
  // Product price trend — the same 5m-vs-1h delta shown on Realtime cards.
  // On an allocation card this tells the user whether the item's price is
  // trending in a direction that would widen (or shrink) their margin
  // between now and when the buy orders fill. Only shown when the trend
  // is significant enough to matter (trendOf returns null under threshold).
  const productTrend = trendOf(a.recipe.id);
  if (productTrend) {
    // buyerView=false for the product: rising product price is good (green).
    catRow.appendChild(trendChip(productTrend, false));
  }
  if (a.confidence != null) {
    catRow.appendChild(el("span", { class: "skill-chip", text: Math.round(a.confidence * 100) + "% reliable" }));
  }
  if (a.freeSlot) {
    catRow.appendChild(el("span", { class: "skill-chip", text: "free slot",
      attrs: { title: "This recipe is a skilling supply or component combine — excluded from the GE-slot count per your toggles." }}));
  }
  // Supply-strategy override chip — the allocator scored this recipe under
  // BOTH insta-buy and slow-buy, and picked whichever gave higher margin.
  // Only shown when the winning strategy differs from the user's global
  // preference (i.e. this recipe needs you to switch behaviour for it).
  //
  // Suppression rule for insta-buy overrides: if the "insta-buy wins"
  // decision was driven by a stale .high being lower than a fresh .low
  // (bid-ask crossover where the fresh price says the market has moved
  // up beyond the old insta-buy), the override is a data-freshness
  // artifact, not a real market signal. We still USE the cheaper .high
  // as the buy price (the last insta-buy did fill at that price), but
  // we drop the chip so the user isn't told to switch strategies for
  // what's really a price-timing quirk.
  if (a.supplyStrategyUsed && a.supplyStrategyUsed !== state.supplyStrategy
      && !isInstaBuyOverrideSpurious(a)) {
    const label = a.supplyStrategyUsed === "insta-buy" ? "insta-buy supplies" : "slow-buy supplies";
    const tip = a.supplyStrategyUsed === "insta-buy"
      ? "Slow-buy was less profitable (or unavailable) for this recipe — pay the current insta-buy price on supplies to unlock this margin."
      : "Slow-buying supplies is more profitable here — place buy orders at the low price instead of insta-buying.";
    catRow.appendChild(el("span", { class: "strategy-chip strategy-chip-" + a.supplyStrategyUsed,
      text: label, attrs: { title: tip } }));
  }
  // Stale badge — a recommendation using stale prices is a bad recommendation
  // even if the calc says it's profitable. Only appears when the user has NOT
  // hidden stale items (i.e. they've opted in to seeing them).
  const stale = isItemStale(a.recipe.id) || a.recipe.components.some(c => isItemStale(c.id));
  if (stale) {
    catRow.appendChild(el("span", { class: "stale-chip", text: "stale prices",
      attrs: { title: "One or more items in this recipe haven't traded recently — profit numbers may be fossils." }}));
  }
  const nameDiv = el("div", { class: "card-name", text: a.recipe.name });
  const titleBox = el("div", { class: "card-title" }, nameDiv, catRow);
  card.appendChild(el("div", { class: "card-head" }, iconBox, titleBox));

  const stats = el("div", { class: "card-stats" });
  const row = (label, val, cls) => {
    const r = el("div", { class: "stat-row " + (cls || "") });
    r.appendChild(el("span", { class: "stat-label", text: label }));
    r.appendChild(el("span", { class: "stat-value", text: val }));
    return r;
  };
  stats.appendChild(row("Buy", `${a.count.toLocaleString()}× @ ${fmtGp(a.calc.totalCost)}`));
  stats.appendChild(row("Capital", fmtGp(a.cost)));
  stats.appendChild(row("Expected profit", fmtGp(Math.round(a.profit)), "v-good"));
  stats.appendChild(row("Margin / craft", fmtGp(Math.round(a.calc.margin))));
  stats.appendChild(row("ROI", ((a.calc.margin / a.calc.totalCost) * 100).toFixed(2) + "%"));
  // Volume cap breakdown — shows how the maxUnits ceiling was derived so
  // the user can sanity-check. "adj" = the number that actually gates
  // allocation (side-split + 5m/1h/24h velocity blend + Wilson shrink);
  // "agg" = the naive 24h total for comparison.
  if (a.calc.maxFlipsAdjusted != null || a.calc.maxFlips != null) {
    const agg = a.calc.maxFlips;
    const adj = a.calc.maxFlipsAdjusted;
    const disp = adj != null ? adj.toLocaleString() : "—";
    const aggText = agg != null ? `${agg.toLocaleString()} agg` : "no vol";
    const cell = row("Volume cap (adj/day)", `${disp}  ·  ${aggText}`);
    cell.title = "Adjusted: side-split volume (buying components caps by sell-side liquidity; "
      + "selling product caps by buy-side), blended across 5m / 1h / 24h slices (max is used, "
      + "so heating markets get the fresh signal without ever dropping below the historic base), "
      + "then shrunk via a Poisson 95% lower bound to guard against small-sample noise. "
      + "Aggregate: the naive 24h total (both sides, no shrink) — shown for comparison.";
    stats.appendChild(cell);
    // Bottleneck line — shows which specific item's volume set the ceiling
    // plus the raw 5m/1h/24h slices we pulled from the wiki. Lets you see
    // whether the estimate is grounded in a real trend or a single stale
    // number.
    const bd = a.calc.volumeBreakdown;
    if (bd) {
      const itemName = state.mapping?.[bd.id]?.name || `#${bd.id}`;
      const sideLbl = bd.side === "high" ? "high-side" : "low-side";
      const parts = [];
      if (bd.v5m  != null) parts.push(`5m ${bd.v5m.toLocaleString()}`);
      if (bd.v1h  != null) parts.push(`1h ${bd.v1h.toLocaleString()}`);
      if (bd.v24h != null) parts.push(`24h ${bd.v24h.toLocaleString()}`);
      const cell = row("Bottleneck", `${itemName} · ${parts.join(" · ")}`);
      cell.title = `${itemName} (${sideLbl} volume) sets this recipe's ceiling. `
        + `Slice sizes: 5m = last 5 min, 1h = last hour, 24h = last day. `
        + `The blend takes max(24h, 1h × 24, 5m × 288), then applies the Poisson shrink.`;
      stats.appendChild(cell);
    } else if (adj != null && a.calc.limitFlipsPerDay != null && adj === a.calc.limitFlipsPerDay) {
      // GE buy limit is the ceiling — flag it explicitly instead of leaving
      // the user wondering why the "adj" number is exactly limit × 6.
      const cell = row("Bottleneck", `GE buy limit · ${a.calc.limitFlipsPer4h.toLocaleString()} / 4h`);
      cell.title = "The GE 4h buy limit is tighter than any component's volume — you'd hit "
        + "the daily cap before market depth becomes an issue.";
      stats.appendChild(cell);
    }
  }
  card.appendChild(stats);

  // Card-level "hide from allocation" button. Adds recipe.key to
  // state.excludedRecipes and re-runs the allocator so the card immediately
  // disappears and a fallback pick takes its slot. The curator popover
  // shows the hidden set (including recipes hidden this way, not just
  // component combines) so the user can unhide later.
  const hideBtn = el("button", {
    class: "allocate-hide-btn",
    text: "🚫 hide this craft",
    attrs: { title: "Permanently exclude this recipe from allocation (persists across reloads). Manage via the sidebar 'View / curate list' popover." },
  });
  hideBtn.onclick = (e) => {
    e.stopPropagation();
    setRecipeExcluded(a.recipe.key, true);
    document.getElementById("allocate-btn").click();
  };
  card.appendChild(hideBtn);

  // Component-buy breakdown: what actually goes into the GE for each craft.
  // "Buy 6× Adamant set" is really "buy 6 helms + 6 chests + 6 legs + 6 kites",
  // and users need to see that to judge feasibility inside a 4h/1d window.
  const buys = el("div", { class: "allocate-buys" });
  buys.appendChild(el("div", { class: "allocate-buys-title", text: "Buys needed" }));
  // Small factory for the per-item hit-limit toggle button. Marking an item
  // hides every recipe using it from the allocator for 4h (the GE buy-limit
  // reset window). Clicking triggers a re-run of the allocator so the user
  // immediately sees the fallback picks.
  const makeHitBtn = (id) => {
    const hit = isHitLimited(id);
    const btn = el("button", {
      class: "hit-limit-btn" + (hit ? " hit" : ""),
      text: hit ? `🚫 hit · ${fmtHitLimitRemaining(id)}` : "🚫 hit limit",
      attrs: { title: hit
        ? `Marked as buy-limit hit. Excluded from allocation until ${fmtHitLimitRemaining(id)} from now. Click to unmark.`
        : `Mark this item as buy-limit hit to exclude every recipe using it from allocation for the next 4h.`,
      },
    });
    btn.onclick = (e) => {
      e.stopPropagation();  // don't open the recipe modal
      toggleHitLimit(id);
      document.getElementById("allocate-btn").click();
    };
    return btn;
  };
  // Prices in this list must match the strategy the allocator actually used
  // for THIS recipe, not the global state. Otherwise a "insta-buy supplies"
  // recipe shows slow-buy prices in its breakdown and the numbers don't add
  // up to the summary cost.
  const strat = a.supplyStrategyUsed || state.supplyStrategy;
  for (const c of a.recipe.components) {
    const name = state.mapping?.[c.id]?.name || `#${c.id}`;
    const unitCount = c.qty * a.count;
    const unitPrice = supplyPriceAt(state.prices[c.id], strat);
    const priceText = unitPrice != null ? ` @ ${fmtGp(unitPrice)}` : "";
    const row = el("div", { class: "allocate-buy-row" });
    row.appendChild(el("span", { class: "allocate-buy-name", text: name }));
    row.appendChild(el("span", { class: "allocate-buy-qty", text: `${unitCount.toLocaleString()}×${priceText}` }));
    row.appendChild(makeHitBtn(c.id));
    buys.appendChild(row);
  }
  // Supplies (runes, gems etc.) — always priced live, shown here too so the
  // user knows they need those on hand.
  for (const s of a.recipe.supplies || []) {
    const name = state.mapping?.[s.id]?.name || `#${s.id}`;
    const unitCount = s.qty * a.count;
    const unitPrice = supplyPriceAt(state.prices[s.id], strat);
    const priceText = unitPrice != null ? ` @ ${fmtGp(unitPrice)}` : "";
    const row = el("div", { class: "allocate-buy-row" });
    row.appendChild(el("span", { class: "allocate-buy-name", text: name + " (supply)" }));
    row.appendChild(el("span", { class: "allocate-buy-qty", text: `${unitCount.toLocaleString()}×${priceText}` }));
    row.appendChild(makeHitBtn(s.id));
    buys.appendChild(row);
  }
  // Product line — different label style so it doesn't blend with buys.
  const productName = state.mapping?.[a.recipe.id]?.name || a.recipe.name;
  const productQty = (a.recipe.resultQty || 1) * a.count;
  const productPrice = productSell(state.prices[a.recipe.id]);
  const productPriceText = productPrice != null ? ` @ ${fmtGp(productPrice)}` : "";
  const sellRow = el("div", { class: "allocate-buy-row allocate-sell-row" });
  sellRow.appendChild(el("span", { class: "allocate-buy-name", text: "Sell " + productName }));
  sellRow.appendChild(el("span", { class: "allocate-buy-qty", text: `${productQty.toLocaleString()}×${productPriceText}` }));
  buys.appendChild(sellRow);

  card.appendChild(buys);
  return card;
}

// Active index (parallel to activeModalRecipe). When set, loadModalChart/
// drawActiveTab is bypassed in favour of the index-specific pipeline.
let activeModalIndex = null;

// Per-index chart cache. Populated once per (index × timeframe) so tab
// switches between Combined / individual items are instant — the /timeseries
// data doesn't need to be re-fetched. Invalidated on timeframe change.
let indexChartCache = { indexKey: null, timeframe: null, byId: null, indexPoints: null };

async function openIndexModal(idx) {
  activeModalRecipe = null;
  activeModalIndex = idx;
  activeChartTab = "combined";
  modalTitle.textContent = idx.name;
  // Wipe chart-tabs container — loadIndexChart repopulates once data arrives.
  document.getElementById("chart-tabs").replaceChildren();
  // Clear the stats panel — index modal has no per-item detail rows yet.
  const details = document.getElementById("modal-details");
  if (details) details.replaceChildren();
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
  // Kick off news load in parallel — same reasoning as openModal.
  loadNews().then(() => {
    if (activeModalIndex === idx) loadIndexChart(idx);
  });
  await loadIndexChart(idx);
}

const INDEX_FETCH_CONCURRENCY = 5;

async function loadIndexChart(idx) {
  const preset = TIMEFRAME_PRESETS[activeTimeframe] || TIMEFRAME_PRESETS.week;

  // Cache hit: skip the fetch, just re-render tabs + active tab. Happens on
  // tab switches inside the same modal open.
  const cacheHit = indexChartCache.indexKey === idx.key
                && indexChartCache.timeframe === activeTimeframe
                && indexChartCache.byId
                && indexChartCache.indexPoints;
  if (cacheHit) {
    renderIndexChartTabs(idx);
    drawActiveIndexTab(idx);
    return;
  }

  modalStatus.textContent = `Loading ${idx.name}: ${idx.items.length} items @ ${preset.step} step…`;
  drawChartMessage("Loading…");
  document.getElementById("chart-tabs").replaceChildren();

  try {
    const cutoff = Date.now() - preset.windowMs;
    const seriesById = new Map();
    let cursor = 0;
    async function worker() {
      while (cursor < idx.items.length) {
        const item = idx.items[cursor++];
        const raw = await fetchTimeseries(item.id, preset.step).catch(() => []);
        const points = (raw || [])
          .filter(p => p.timestamp && (p.avgHighPrice != null || p.avgLowPrice != null))
          .filter(p => p.timestamp * 1000 >= cutoff)
          .map(p => ({
            ts: p.timestamp * 1000,
            mid: ((p.avgHighPrice ?? p.avgLowPrice) + (p.avgLowPrice ?? p.avgHighPrice)) / 2,
          }))
          .sort((a, b) => a.ts - b.ts);
        seriesById.set(item.id, points);
      }
    }
    await Promise.all(Array.from({length: INDEX_FETCH_CONCURRENCY}, worker));

    // Build the index series by walking the union of timestamps and summing
    // each item's most-recent mid price (forward-fill for sparse items).
    const cursors = new Map();
    const allTs = new Set();
    for (const [id, points] of seriesById) {
      cursors.set(id, { points, cursor: -1 });
      for (const p of points) allTs.add(p.ts);
    }
    const sortedTs = [...allTs].sort((a, b) => a - b);

    const indexPoints = [];
    for (const ts of sortedTs) {
      let sum = 0, contributing = 0;
      for (const s of cursors.values()) {
        while (s.cursor + 1 < s.points.length && s.points[s.cursor + 1].ts <= ts) s.cursor++;
        const cp = s.cursor >= 0 ? s.points[s.cursor] : null;
        if (cp && cp.mid != null) { sum += cp.mid; contributing++; }
      }
      // Require at least half the basket priced to emit a point — otherwise
      // early-window points where most items haven't traded yet distort the
      // series with artificially low values.
      if (contributing >= idx.items.length / 2) {
        indexPoints.push({ ts, value: sum / idx.divisor });
      }
    }

    if (!indexPoints.length) {
      drawChartMessage("No data");
      modalStatus.textContent = "No data";
      return;
    }

    // Persist byId as a plain object for the tab-switch code below.
    const byIdObj = {};
    for (const [id, points] of seriesById) byIdObj[id] = points;
    indexChartCache = {
      indexKey: idx.key,
      timeframe: activeTimeframe,
      byId: byIdObj,
      indexPoints,
    };

    renderIndexChartTabs(idx);
    drawActiveIndexTab(idx);
  } catch (e) {
    modalStatus.textContent = `Error: ${e.message}`;
    drawChartMessage("Error loading data");
  }
}

// Render Combined + one tab per basket item. Same interaction as the combo-
// item chart tabs. Tab clicks are instant (data lives in indexChartCache).
function renderIndexChartTabs(idx) {
  const container = document.getElementById("chart-tabs");
  container.replaceChildren();
  const mkButton = (key, label, isCombined = false) => {
    const btn = el("button", { attrs: { "data-tab": String(key) } });
    btn.appendChild(document.createTextNode(label));
    if (isCombined) btn.classList.add("combined");
    if (String(activeChartTab) === String(key)) btn.classList.add("active");
    btn.onclick = () => {
      activeChartTab = key;
      renderIndexChartTabs(idx);
      drawActiveIndexTab(idx);
    };
    return btn;
  };
  container.appendChild(mkButton("combined", "Combined", true));
  for (const item of idx.items) {
    container.appendChild(mkButton(item.id, item.name));
  }
}

// Format a signed change fraction as "▲ +2.34%" / "▼ -1.02%" / "→ +0.05%"
function fmtChangeChip(frac) {
  if (frac == null || !isFinite(frac)) return "";
  const pct = frac * 100;
  const arrow = pct >= 0.05 ? "▲" : pct <= -0.05 ? "▼" : "→";
  return `${arrow} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function drawActiveIndexTab(idx) {
  const preset = TIMEFRAME_PRESETS[activeTimeframe] || TIMEFRAME_PRESETS.week;
  // Change over the displayed range = last vs first point.
  const rangeChange = (points) => {
    const valuesKey = points[0]?.value != null ? "value" : "mid";
    const first = points[0]?.[valuesKey], last = points[points.length - 1]?.[valuesKey];
    if (first == null || last == null || first === 0) return null;
    return (last - first) / first;
  };
  if (activeChartTab === "combined") {
    const points = indexChartCache.indexPoints;
    const change = rangeChange(points);
    const changeStr = change != null ? ` · ${fmtChangeChip(change)} over range` : "";
    modalStatus.textContent = `${points.length} points · ${preset.step} step · ${idx.items.length} basket items${changeStr}`;
    drawIndexChart(points);
    return;
  }
  const itemId = +activeChartTab;
  const item = idx.items.find(i => i.id === itemId);
  const raw = indexChartCache.byId[itemId] || [];
  if (!raw.length) {
    drawChartMessage("No data");
    modalStatus.textContent = `${item?.name || `#${itemId}`}: no data`;
    return;
  }
  // Item-level view uses the same drawIndexChart — just plot the mid price.
  const shaped = raw.map(p => ({ ts: p.ts, value: p.mid }));
  const change = rangeChange(shaped);
  const changeStr = change != null ? ` · ${fmtChangeChip(change)} over range` : "";
  modalStatus.textContent = `${item?.name || `#${itemId}`}: ${shaped.length} points · ${preset.step} step${changeStr}`;
  drawIndexChart(shaped);
}

function drawIndexChart(points) {
  const ctx = modalChart.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = modalChart.clientWidth;
  const cssH = modalChart.clientHeight;
  modalChart.width  = cssW * dpr;
  modalChart.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW, h = cssH;
  ctx.clearRect(0, 0, w, h);
  // Reserve a marker strip at the bottom of the chart area (index charts
  // have no volume panel, so we put markers below the price line and
  // above the x-axis labels). Same UX as the recipe chart.
  const padL = 70, padR = 16, padT = 14, padGap = 6, padB = 28;
  const markerH = 18;
  const chartH = h - padT - padB - markerH - padGap;
  const markerTop = padT + chartH + padGap;

  const tsMin = points[0].ts, tsMax = points[points.length - 1].ts;
  const xs = ts => padL + ((ts - tsMin) / (tsMax - tsMin || 1)) * (w - padL - padR);

  const vs = points.map(p => p.value);
  const vMin = Math.min(...vs), vMax = Math.max(...vs);
  const vRange = (vMax - vMin) || 1;
  const yMin = vMin - vRange * 0.05;
  const yMax = vMax + vRange * 0.05;
  const yRange = yMax - yMin;
  const ys = v => padT + (1 - (v - yMin) / yRange) * chartH;

  // Y grid + labels
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.fillStyle = "#7d86b0";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yRange * i) / yTicks;
    const y = ys(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(fmtGpShort(v), padL - 6, y);
  }

  // X-axis labels
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xTicks = 5;
  const spanDays = (tsMax - tsMin) / 86_400_000;
  for (let i = 0; i <= xTicks; i++) {
    const t = tsMin + ((tsMax - tsMin) * i) / xTicks;
    const x = xs(t);
    const d = new Date(t);
    const label = spanDays > 60
      ? d.toLocaleDateString([], { month: "short", year: "2-digit" })
      : spanDays > 2
        ? d.toLocaleDateString([], { month: "short", day: "numeric" })
        : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // X-axis labels now sit BELOW the marker strip — shift down by
    // (markerH + padGap) so they read below the news markers, not above.
    ctx.fillText(label, x, markerTop + markerH + 6);
  }

  // Index line
  ctx.strokeStyle = "#f5c518";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xs(p.ts), y = ys(p.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // News-post markers on the strip below the price line. Same shared
  // renderer as drawChart uses.
  const newsMarkers = drawNewsMarkers(ctx, {
    tsMin, tsMax, xs, stripTop: markerTop, stripH: markerH, padL, padR, w,
  });
  // Stash on chartGeom so index-modal hover/click handlers can hit-test.
  // Index charts don't populate the full chartGeom (no volume panel, no
  // per-point tooltip logic) — we only need the markers for the hover.
  chartGeom = {
    points: [],           // empty — index-modal mousemove short-circuits without price hover
    xs, padL, padR, w, h, markerTop, markerH, newsMarkers,
    isIndexChart: true,   // flag lets the mousemove handler skip price-hover logic
  };
}

function renderGrid() {
  if (state.mode === "overnight" && window.Overnight) { window.Overnight.renderOvernight(); return; }
  if (state.mode === "skilling-overnight" && window.Overnight) { window.Overnight.renderOvernight(); return; }
  if (state.mode === "history" && window.Flips) { window.Flips.renderHistory(); return; }
  if (state.mode === "skilling") { renderSkilling(); return; }
  if (state.mode === "market") { renderMarket(); return; }
  if (state.mode === "allocate") { renderAllocate(); return; }
  const grid = document.getElementById("grid");
  const tableWrap = document.getElementById("table-wrap");
  // Skilling recipes live in their own mode — exclude them from the
  // real-time combo grid so we don't show pure-essence-and-a-rune as a
  // "combination item".
  const items = RECIPES
    .filter(r => !r.skill)
    .map(r => ({ recipe: r, calc: calcMargin(r) }));
  const visible = applyFilters(items);
  if (state.refreshHistogram) state.refreshHistogram();

  // Toggle which container is visible based on view mode
  if (state.view === "table") {
    grid.hidden = true;
    tableWrap.hidden = false;
    renderTable(tableWrap, visible);
  } else {
    grid.hidden = false;
    tableWrap.hidden = true;
    grid.replaceChildren();
    if (!visible.length) {
      grid.appendChild(el("div", { class: "empty", text: "No items match the current filters." }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const { recipe, calc } of visible) frag.appendChild(renderCard(recipe, calc));
    grid.appendChild(frag);
  }
}

const TABLE_COLUMNS = [
  { key: "star",     label: "★",         get: () => null,                    sortable: false },
  { key: "trend",    label: "Trend",      get: x => trendOf(x.recipe.id)?.pct ?? null, sortable: true, num: true,
                     fmt: v => v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
  { key: "name",     label: "Recipe",     get: x => x.recipe.name,            sortable: true },
  { key: "sell",     label: "Sell",       get: x => x.calc.sellPrice,         sortable: true, num: true, fmt: v => fmtGp(v) },
  { key: "cost",     label: "Cost",       get: x => x.calc.totalCost,         sortable: true, num: true, fmt: v => fmtGp(v) },
  { key: "margin",   label: "Margin",     get: x => x.calc.margin,            sortable: true, num: true, fmt: v => fmtGp(v) },
  { key: "roi",      label: "ROI",        get: x => x.calc.roi,               sortable: true, num: true, fmt: v => fmtPct(v) },
  { key: "flipsHr",  label: "Trades/hr",  get: x => perHour(x.calc.maxFlips), sortable: true, num: true, fmt: v => v == null ? "—" : fmtVol(v) },
  { key: "vol24",    label: "Vol (24h)",  get: x => x.calc.resultVol,         sortable: true, num: true, fmt: v => v == null ? "—" : v.toLocaleString() },
  { key: "limit4h",  label: "Lim/4h",     get: x => x.calc.limitFlipsPer4h,   sortable: true, num: true, fmt: v => v == null ? "—" : v.toLocaleString() },
];

let tableSort = { key: "margin", asc: false };

function renderTable(container, items) {
  container.replaceChildren();
  const table = el("table", { class: "recipe-table" });
  const thead = el("thead");
  const headerRow = el("tr");
  for (const col of TABLE_COLUMNS) {
    const th = el("th", { text: col.label });
    if (col.sortable) {
      th.onclick = () => {
        if (tableSort.key === col.key) tableSort.asc = !tableSort.asc;
        else { tableSort.key = col.key; tableSort.asc = !col.num; }   // numeric defaults to desc
        renderGrid();
      };
      if (tableSort.key === col.key) {
        th.classList.add("sorted");
        if (tableSort.asc) th.classList.add("asc");
      }
    }
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Sort
  const sortCol = TABLE_COLUMNS.find(c => c.key === tableSort.key);
  if (sortCol) {
    items = items.slice().sort((a, b) => {
      const av = sortCol.get(a), bv = sortCol.get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
      return tableSort.asc ? cmp : -cmp;
    });
  }

  const tbody = el("tbody");
  for (const x of items) {
    const tr = el("tr", { class: "recipe-row" });
    tr.onclick = () => openModal(x.recipe);
    for (const col of TABLE_COLUMNS) {
      const td = el("td");
      if (col.key === "star") {
        const isFav = state.favorites.has(x.recipe.key);
        td.classList.add("t-star");
        if (isFav) td.classList.add("active");
        td.textContent = isFav ? "★" : "☆";
        td.onclick = (e) => {
          e.stopPropagation();
          if (isFav) state.favorites.delete(x.recipe.key);
          else state.favorites.add(x.recipe.key);
          localStorage.setItem("osrs-combo-favorites", JSON.stringify([...state.favorites]));
          renderGrid();
        };
      } else {
        const v = col.get(x);
        td.textContent = col.fmt ? col.fmt(v) : (v ?? "—");
        if (col.key === "margin")  td.classList.add("t-margin", (x.calc.margin ?? 0) >= 0 ? "pos" : "neg");
        if (col.key === "roi")     td.classList.add("t-roi",    (x.calc.roi    ?? 0) >= 0 ? "pos" : "neg");
        if (col.key === "trend") {
          const t = trendOf(x.recipe.id);
          if (t) {
            td.classList.add("t-trend", "t-trend-" + t.kind);
            const arrow = ({ "spike":"▲▲","crash":"▼▼","trending-up":"↗","trending-down":"↘" })[t.kind];
            td.textContent = `${arrow} ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}%`;
          }
        }
        if (col.key === "flipsHr") {
          td.classList.add("t-flips");
          const hr = perHour(x.calc.maxFlips);
          if (hr == null) td.classList.add("red");
          else if (hr >= 4) td.classList.add("green");
          else if (hr >= 0.5) td.classList.add("warn");
          else td.classList.add("red");
        }
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

/* ---------------- Modal ---------------- */
const modal = document.getElementById("chart-modal");
const modalChart = document.getElementById("modal-chart");
const modalTitle = document.getElementById("modal-title");
const modalStatus = document.getElementById("modal-status");
const modalDetail = document.getElementById("modal-detail");
const modalTooltip = document.getElementById("chart-tooltip");
const timeframeButtons = document.getElementById("timeframe-buttons");
let activeModalRecipe = null;
let activeTimeframe = "week";
let chartGeom = null; // populated by drawChart; used by hover code

// Map timeframe → wiki timestep + a *time window* to keep (last N ms).
// Slicing by time instead of point count is critical for thinly-traded items:
// the wiki returns up to 365 *non-empty* data points, which can span 6+ months
// for a low-volume component if the empty intervals are filtered out.
const DAY_MS = 24 * 3600 * 1000;
const TIMEFRAME_PRESETS = {
  day:     { step: "5m",  windowMs:   1 * DAY_MS },
  week:    { step: "1h",  windowMs:   7 * DAY_MS },
  month:   { step: "6h",  windowMs:  30 * DAY_MS },
  quarter: { step: "6h",  windowMs:  91 * DAY_MS },
  year:    { step: "24h", windowMs: 365 * DAY_MS },
};

document.getElementById("modal-close").onclick = () => modal.close();
modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
timeframeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tf]");
  if (!btn) return;
  for (const b of timeframeButtons.children) b.classList.toggle("active", b === btn);
  activeTimeframe = btn.dataset.tf;
  if (activeModalIndex) loadIndexChart(activeModalIndex);
  else if (activeModalRecipe) loadModalChart(activeModalRecipe);
});

// Modal refresh button — invalidates the chart cache and re-fetches
document.getElementById("modal-refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.classList.add("spinning");
  if (activeModalIndex) {
    // Invalidate the per-index cache so the fetch actually re-runs.
    indexChartCache = { indexKey: null, timeframe: null, byId: null, indexPoints: null };
    await loadIndexChart(activeModalIndex);
  } else if (activeModalRecipe) {
    chartCache = { recipeKey: null, timeframe: null, byId: {} };
    await loadModalChart(activeModalRecipe);
  }
  if (btn) btn.classList.remove("spinning");
});

function detailRow(label, value, opts = {}) {
  const tr = el("tr");
  const td1 = el("td");
  const td2 = el("td");
  const strong = opts === true || opts.strong === true;
  const cls = (typeof opts === "object" && opts.cls) ? opts.cls : null;
  if (cls) td2.classList.add(cls);
  if (strong) {
    td1.appendChild(el("strong", { text: label }));
    td2.appendChild(el("strong", { text: value }));
  } else {
    td1.textContent = label;
    td2.textContent = value;
  }
  tr.append(td1, td2);
  return tr;
}

// External reference links for the modal — Wiki / live prices / GE-Tracker.
// Tracks whichever tab is active: the result item on Combined, or the
// highlighted component otherwise. The name is stripped of " — via X"
// disambiguators so the wiki link resolves to a real article title.
function renderModalLinks(id, name) {
  const box = document.getElementById("modal-links");
  const wikiName = (name || "")
    .replace(/\s*—\s*via.*$/, "")
    .replace(/\s*\(via[^)]*\)/, "")
    .trim();
  const mk = (href, label) => el("a", {
    class: "modal-link", text: label,
    attrs: { href, target: "_blank", rel: "noopener" },
  });
  box.replaceChildren(
    mk("https://oldschool.runescape.wiki/w/" + encodeURIComponent(wikiName.replace(/ /g, "_")), "Wiki ↗"),
    mk("https://prices.runescape.wiki/osrs/item/" + id, "Live prices ↗"),
    mk("https://www.ge-tracker.com/item/" + id, "GE-Tracker ↗"),
  );
}

function openModal(recipe) {
  activeModalRecipe = recipe;
  activeModalIndex = null;  // clear the index-mode flag so the modal's timeframe/refresh listeners route correctly
  activeChartTab = "combined";  // default each open to the combined overlay
  modalTitle.textContent = recipe.name;
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
  loadModalChart(recipe);  // chart + stats render together via drawActiveTab
  // News markers depend on state.news being populated. Kick off the load
  // in parallel with the price fetch — if it wins the race, the first
  // drawChart pass paints them; if it loses, a follow-up redraw pops them
  // in without blocking the price render.
  loadNews().then(() => {
    if (activeModalRecipe === recipe && chartGeom && chartGeom.points?.length) {
      drawChart(chartGeom.points, { showCost: chartGeom.showCost });
    }
  });
}

// Cache: { recipeKey, timeframe, byId: { id: [points] } } — invalidated on
// timeframe or recipe change. Tab switches are instant (no refetch).
let chartCache = { recipeKey: null, timeframe: null, byId: {} };
let activeChartTab = "combined";  // "combined" or component id (number)

async function loadModalChart(recipe) {
  const preset = TIMEFRAME_PRESETS[activeTimeframe] || TIMEFRAME_PRESETS.week;
  const cacheValid = chartCache.recipeKey === recipe.key && chartCache.timeframe === activeTimeframe;
  if (!cacheValid) {
    modalStatus.textContent = `Loading ${activeTimeframe} (${preset.step})…`;
    drawChartMessage("Loading…");
    try {
      const ids = [recipe.id, ...recipe.components.map(c => c.id)];
      const responses = await Promise.all(ids.map(id => fetchTimeseries(id, preset.step).catch(() => [])));
      const cutoff = Date.now() - preset.windowMs;
      const toPoints = (raw, itemId) => {
        const points = (raw || [])
          .filter(p => p.timestamp && (p.avgHighPrice != null || p.avgLowPrice != null))
          .filter(p => p.timestamp * 1000 >= cutoff)
          .map(p => ({
            ts: p.timestamp * 1000,
            high: p.avgHighPrice ?? null,
            low:  p.avgLowPrice  ?? null,
            highVol: p.highPriceVolume ?? 0,
            lowVol:  p.lowPriceVolume  ?? 0,
          }));
        // Stitch the live /latest snapshot onto the right edge so the cost line
        // and stats panel agree at "now". Rare items often have a stale
        // half-aggregate as their last timeseries point (e.g. only insta-sell
        // filled), while /latest has the freshest tick on both sides.
        const live = state.prices[itemId];
        if (live && (live.high != null || live.low != null)) {
          const liveTs = Math.max(live.highTime ?? 0, live.lowTime ?? 0) * 1000 || Date.now();
          if (!points.length || liveTs > points[points.length - 1].ts) {
            points.push({
              ts: liveTs,
              high: live.high ?? null,
              low:  live.low  ?? null,
              highVol: 0,
              lowVol:  0,
            });
          }
        }
        return points;
      };
      chartCache = {
        recipeKey: recipe.key,
        timeframe: activeTimeframe,
        byId: Object.fromEntries(ids.map((id, i) => [id, toPoints(responses[i], id)])),
      };
    } catch (e) {
      modalStatus.textContent = `Error: ${e.message}`;
      drawChartMessage("Error loading data");
      return;
    }
  }
  renderChartTabs(recipe);
  drawActiveTab(recipe);
}

function renderChartTabs(recipe) {
  const container = document.getElementById("chart-tabs");
  container.replaceChildren();
  const mkButton = (key, label, qtyText, isCombined = false) => {
    const btn = el("button", { attrs: { "data-tab": String(key) } });
    btn.appendChild(document.createTextNode(label));
    if (qtyText) btn.appendChild(el("span", { class: "qty-suffix", text: qtyText }));
    if (isCombined) btn.classList.add("combined");
    if (String(activeChartTab) === String(key)) btn.classList.add("active");
    btn.onclick = () => {
      activeChartTab = key;
      renderChartTabs(recipe);
      drawActiveTab(recipe);
    };
    return btn;
  };
  // Combined first
  container.appendChild(mkButton("combined", "Combined", null, true));
  // Then result item ("Product")
  const resultName = state.mapping[recipe.id]?.name || recipe.name;
  container.appendChild(mkButton(recipe.id, resultName));
  // Then components
  for (const c of recipe.components) {
    const m = state.mapping[c.id];
    container.appendChild(mkButton(c.id, m?.name || `#${c.id}`, c.qty > 1 ? `×${c.qty}` : null));
  }
}

function drawActiveTab(recipe) {
  const preset = TIMEFRAME_PRESETS[activeTimeframe] || TIMEFRAME_PRESETS.week;
  // External links follow the active tab's item.
  if (activeChartTab === "combined") {
    renderModalLinks(recipe.id, state.mapping[recipe.id]?.name || recipe.name);
  } else {
    const tabId = +activeChartTab;
    renderModalLinks(tabId, state.mapping[tabId]?.name || `#${tabId}`);
  }
  if (activeChartTab === "combined") {
    const points = buildCombinedPoints(recipe);
    if (!points.length) { drawChartMessage("No data"); modalStatus.textContent = "No data"; return; }
    modalStatus.textContent = `${points.length} points · ${preset.step} step · result + ${recipe.components.length} component${recipe.components.length === 1 ? "" : "s"}`;
    drawChart(points, { showCost: true });
  } else {
    const data = chartCache.byId[activeChartTab] || [];
    if (!data.length) { drawChartMessage("No data"); modalStatus.textContent = "No data"; return; }
    modalStatus.textContent = `${data.length} points · ${preset.step} step`;
    drawChart(data, { showCost: false });
  }
  // Re-render the bottom stats panel for the active tab
  renderTabStats(recipe);
}

function renderTabStats(recipe) {
  if (activeChartTab === "combined") {
    renderRecipeStats(recipe);
    return;
  }
  // Per-item view (could be the result item OR a component)
  const itemId = +activeChartTab;
  const isResult = itemId === recipe.id;
  // For the result item, find its qty (always 1 in our model — display uses resultQty for revenue, but here we want per-unit)
  // For a component, find the component spec
  let qty = 1;
  if (!isResult) {
    const c = recipe.components.find(c => c.id === itemId);
    qty = c?.qty || 1;
  }
  const m = state.mapping[itemId];
  const name = m?.name || `#${itemId}`;
  const live = state.prices[itemId];
  const high = live?.high ?? null;
  const low  = live?.low  ?? null;
  const spread = (high != null && low != null) ? high - low : null;
  const spreadPct = (spread != null && low > 0) ? (spread / low) * 100 : null;
  const vol = state.volumes[itemId] ?? null;
  const limit = m?.limit ?? null;

  // Trend over the displayed window (first vs last valid high)
  const points = chartCache.byId[itemId] || [];
  const valid = points.filter(p => p.high != null);
  let trend = null, trendClass = "";
  if (valid.length >= 2) {
    const first = valid[0].high, last = valid[valid.length - 1].high;
    trend = ((last - first) / first) * 100;
    trendClass = trend >= 0 ? "v-pos" : "v-neg";
  }

  const highTime = live?.highTime ?? null;
  const lowTime  = live?.lowTime  ?? null;
  const recentestSec = Math.max(highTime ?? 0, lowTime ?? 0) || null;
  const isStale = recentestSec && (Date.now() / 1000 - recentestSec) * 1000 > STALE_MS;
  const rows = [
    detailRow("Item", name + (qty > 1 ? ` (×${qty} in recipe)` : "")),
    detailRow("Insta-buy (high)",  high != null ? fmtGp(high) : "—", { cls: "v-high" }),
    detailRow("Insta-sell (low)",  low  != null ? fmtGp(low)  : "—", { cls: "v-low"  }),
    detailRow("Last insta-buy",    highTime ? ageString(highTime) : "—"),
    detailRow("Last insta-sell",   lowTime  ? ageString(lowTime)  : "—"),
    detailRow("Most recent trade", recentestSec ? ageString(recentestSec) : "—",
              { cls: isStale ? "v-neg" : "" }),
    detailRow("Spread",            spread != null ? fmtGp(spread) : "—"),
    detailRow("Spread %",          spreadPct != null ? `${spreadPct.toFixed(2)}%` : "—"),
    detailRow(`Trend over ${activeTimeframe}`, trend != null ? `${trend >= 0 ? "+" : ""}${trend.toFixed(2)}%` : "—", { cls: trendClass }),
    detailRow("Volume (24h)",      vol != null ? `${vol.toLocaleString()} traded` : "—"),
    detailRow("GE buy limit (4h)", limit != null ? limit.toLocaleString() : "—"),
  ];
  // Cost contribution (component only) — strategy-aware
  if (!isResult) {
    const supply = supplyPrice(live);
    const label = state.supplyStrategy === "slow-buy"
      ? "Contributes to total cost (slow-buy)"
      : "Contributes to total cost (insta-buy)";
    if (supply != null) rows.push(detailRow(label, fmtGp(supply * qty), { cls: "v-supply" }));
  }
  modalDetail.replaceChildren(...rows);
}

function renderRecipeStats(recipe) {
  const calc = calcMargin(recipe);
  const q = calc.resultQty;
  const sellLbl = q > 1 ? `Sell price ${q} × ${fmtGp(calc.sellPrice)}` : "Sell price";
  const supplyLbl = state.supplyStrategy === "slow-buy" ? "Supply cost (slow-buy, low)" : "Supply cost (insta-buy, high)";
  const sellSideClass = state.productStrategy === "insta-sell" ? "v-low" : "v-high";
  const marginClass = (calc.margin ?? 0) >= 0 ? "v-pos" : "v-neg";
  const roiClass    = (calc.roi    ?? 0) >= 0 ? "v-pos" : "v-neg";
  modalDetail.replaceChildren(
    ...(SKILL_REQS[recipe.key] ? [detailRow("Skill to craft", SKILL_REQS[recipe.key], { cls: "v-skill" })] : []),
    detailRow(sellLbl, fmtGp(calc.revenue), { cls: sellSideClass }),
    detailRow(supplyLbl, fmtGp(calc.componentCost), { cls: "v-supply" }),
    ...(recipe.supplies?.length ? [detailRow("Supplies", fmtGp(calc.suppliesCost), { cls: "v-supply" })] : []),
    ...(calc.repairCost ? [detailRow(`Repair @ ${state.smithing} smithing`, fmtGp(calc.repairCost), { cls: "v-gold" })] : []),
    detailRow("Total cost", fmtGp(calc.totalCost), { strong: true, cls: "v-cost" }),
    detailRow("GE tax (2% capped 5M)", `-${fmtGp(calc.geTax)}`, { cls: "v-tax" }),
    detailRow("Margin (per craft)", fmtGp(calc.margin), { strong: true, cls: marginClass }),
    detailRow("ROI", fmtPct(calc.roi), { strong: true, cls: roiClass }),
    detailRow("Result volume (24h)", calc.resultVol != null ? `${calc.resultVol.toLocaleString()} traded` : "—"),
    detailRow("Max crafts / 4h (GE limit)", calc.limitFlipsPer4h != null ? calc.limitFlipsPer4h.toLocaleString() : "—"),
    detailRow("Max crafts / day (volume × limit)", calc.maxFlips != null ? calc.maxFlips.toLocaleString() : "—", { strong: true }),
  );
}

// Build the combined-tab series. To make the visual margin readable for
// resultQty > 1 recipes (e.g. Zulrah's scales × 20,000 per craft, Bandosian
// components × 3 per chestplate), we scale the result-side prices by qty so
// both the revenue lines and the cost line live on the same per-craft scale.
//
// For per-craft display:
//   high  = result.high × resultQty   (revenue at list-patient strategy)
//   low   = result.low  × resultQty   (revenue at insta-sell strategy)
//   cost  = Σ (component.qty × component.buyPrice) + extraCost
//   margin = (sell side) - tax×qty - cost
//
// We also stash perUnitHigh/perUnitLow so the tooltip can show both views.
function buildCombinedPoints(recipe) {
  const resultSeries = chartCache.byId[recipe.id] || [];
  const qty = recipe.resultQty || 1;
  // For each component, keep its time-sorted points and a running cursor.
  // At each result timestamp we advance the cursor to the latest component
  // point with ts <= result.ts (forward-fill). This makes the cost line
  // continuous even for rare components that trade only occasionally —
  // the user's "available price right now" is always the last traded price.
  const compIndex = recipe.components.map(c => ({
    c,
    points: (chartCache.byId[c.id] || []).slice().sort((a, b) => a.ts - b.ts),
    cursor: -1,
  }));
  const extra = recipe.extraCost || 0;
  const out = [];
  for (const rp of resultSeries) {
    let cost = extra;
    let allComp = true;
    for (const ci of compIndex) {
      // Advance cursor while next point is still <= result ts
      while (ci.cursor + 1 < ci.points.length && ci.points[ci.cursor + 1].ts <= rp.ts) {
        ci.cursor++;
      }
      const cp = ci.cursor >= 0 ? ci.points[ci.cursor] : null;
      // Prefer the configured side; fall back to the other side of the spread.
      // If both are null (shouldn't happen — we filter on fetch) skip the point.
      const buy = cp
        ? (state.supplyStrategy === "slow-buy"
            ? (cp.low ?? cp.high ?? null)
            : (cp.high ?? cp.low ?? null))
        : null;
      if (buy == null) { allComp = false; break; }
      cost += buy * ci.c.qty;
    }
    out.push({
      ts: rp.ts,
      high: rp.high != null ? rp.high * qty : null,
      low:  rp.low  != null ? rp.low  * qty : null,
      perUnitHigh: rp.high,
      perUnitLow:  rp.low,
      qty,
      cost: allComp ? cost : null,
      highVol: rp.highVol,
      lowVol:  rp.lowVol,
    });
  }
  return out;
}

// Crosshair + tooltip on mousemove over the canvas
modalChart.addEventListener("mousemove", (e) => {
  if (!chartGeom) return;
  const rect = modalChart.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  // Marker hover has priority — check before the price-crosshair path.
  // The strip zone lives between the price and volume panels; when the
  // cursor is on a marker, show the news tooltip instead of the price one.
  const hover = newsMarkerAt(x, y, chartGeom);
  if (hover) {
    modalChart.style.cursor = "pointer";
    showNewsTooltip(hover.post, hover.x, hover.y);
    return;
  } else {
    modalChart.style.cursor = "";
  }
  if (!chartGeom.points || !chartGeom.points.length) { hideChartTooltip(); return; }
  const { points, xs, ys, padL, padR, priceTop, priceH, volTop, volH, w } = chartGeom;
  if (x < padL || x > w - padR) { hideChartTooltip(); return; }
  // Find nearest point by x
  let nearestIdx = 0, nearestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(xs(points[i].ts) - x);
    if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
  }
  const p = points[nearestIdx];
  // Redraw the chart, then overlay crosshair + dots
  drawChart(points, { showCost: chartGeom.showCost });
  const ctx = modalChart.getContext("2d");
  const cx = xs(p.ts);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, priceTop);
  ctx.lineTo(cx, volTop + volH);
  ctx.stroke();
  ctx.setLineDash([]);
  // Dots on the active point
  if (p.high != null) {
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath(); ctx.arc(cx, ys(p.high), 3.5, 0, Math.PI * 2); ctx.fill();
  }
  if (p.low != null) {
    ctx.fillStyle = "#60a5fa";
    ctx.beginPath(); ctx.arc(cx, ys(p.low), 3.5, 0, Math.PI * 2); ctx.fill();
  }
  if (chartGeom.showCost && p.cost != null) {
    ctx.fillStyle = "#4ade80";
    ctx.beginPath(); ctx.arc(cx, ys(p.cost), 3.5, 0, Math.PI * 2); ctx.fill();
  }
  showChartTooltip(p, cx, y, chartGeom.showCost);
});
modalChart.addEventListener("mouseleave", () => {
  hideChartTooltip();
  modalChart.style.cursor = "";
  if (chartGeom && chartGeom.points && chartGeom.points.length) drawChart(chartGeom.points, { showCost: chartGeom.showCost });
});
// Allowlist of hosts that news-post URLs may point to. news.json is scraped
// from the OSRS wiki (user-editable) so a hostile edit could theoretically
// inject a javascript: URL — window.open() executes those in the opener's
// origin regardless of noopener/noreferrer. The scraper enforces the same
// allowlist server-side; this is defense-in-depth for the case where a
// stale, pre-fix news.json is still cached in a client.
const NEWS_URL_ALLOWED_HOSTS = new Set([
  "secure.runescape.com",
  "www.runescape.com",
  "oldschool.runescape.wiki",
]);
function isSafeNewsUrl(raw) {
  if (typeof raw !== "string" || !raw) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return NEWS_URL_ALLOWED_HOSTS.has(u.hostname.toLowerCase());
}
// Click a news marker → open the underlying post in a new tab. Skips any
// other click behaviour (there's no other click on the chart canvas today).
modalChart.addEventListener("click", (e) => {
  if (!chartGeom) return;
  const rect = modalChart.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hit = newsMarkerAt(x, y, chartGeom);
  if (!hit) return;
  if (!isSafeNewsUrl(hit.post.url)) {
    console.warn("Refused to open unsafe news url:", hit.post.url);
    return;
  }
  window.open(hit.post.url, "_blank", "noopener,noreferrer");
});

// News-post tooltip. Reuses the modalTooltip element; different content
// shape from the price tooltip so we blank it and repopulate with the
// post's title, category, date, and a click hint.
function showNewsTooltip(post, cx, cy) {
  modalTooltip.replaceChildren();
  const d = new Date(post.ts);
  const dateStr = d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  modalTooltip.appendChild(el("div", { class: "tt-time", text: dateStr }));
  modalTooltip.appendChild(el("div", { class: "tt-news-title", text: post.title }));
  modalTooltip.appendChild(el("div", { class: "tt-news-meta",
    text: `${post.category} · click to open` }));
  modalTooltip.hidden = false;
  // Position: prefer above the marker so it doesn't cover it
  const wrap = modalChart.parentElement.getBoundingClientRect();
  const tt   = modalTooltip.getBoundingClientRect();
  let left = cx - tt.width / 2;
  left = Math.max(4, Math.min(left, wrap.width - tt.width - 4));
  let top = cy - tt.height - 12;
  if (top < 4) top = cy + 14;
  modalTooltip.style.left = `${left}px`;
  modalTooltip.style.top  = `${top}px`;
}

function ttRow(label, value, valueClass) {
  const r = el("div", { class: "tt-row" });
  r.appendChild(el("span", { class: "lbl", text: label }));
  r.appendChild(el("span", { class: "val" + (valueClass ? " " + valueClass : ""), text: value }));
  return r;
}

function showChartTooltip(p, cx, cy, showCost) {
  const d = new Date(p.ts);
  const dateStr = d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const spread = (p.high != null && p.low != null) ? p.high - p.low : null;

  modalTooltip.replaceChildren();
  modalTooltip.appendChild(el("div", { class: "tt-time", text: dateStr }));
  const qty = p.qty || 1;
  if (showCost && qty > 1) {
    // Make per-craft scaling explicit in the tooltip
    modalTooltip.appendChild(ttRow(`Revenue (${qty} × insta-buy)`, fmtGp(p.high), "high"));
    modalTooltip.appendChild(ttRow(`Revenue (${qty} × insta-sell)`, fmtGp(p.low), "low"));
    modalTooltip.appendChild(ttRow("Per unit (high / low)", `${fmtGp(p.perUnitHigh)} / ${fmtGp(p.perUnitLow)}`));
  } else {
    if (p.high != null) modalTooltip.appendChild(ttRow("Insta-buy",  fmtGp(p.high), "high"));
    if (p.low  != null) modalTooltip.appendChild(ttRow("Insta-sell", fmtGp(p.low),  "low"));
    if (spread != null) modalTooltip.appendChild(ttRow("Spread", fmtGp(spread)));
  }
  if (showCost && p.cost != null) {
    modalTooltip.appendChild(ttRow("Component cost", fmtGp(p.cost), "pos"));
    // Historic margin uses the scaled revenue minus per-unit tax × qty
    if (activeModalRecipe && p.high != null && p.low != null) {
      const recipe = activeModalRecipe;
      const repair = repairCost(recipe.repairBase, state.smithing);
      const perUnitSell = state.productStrategy === "insta-sell" ? p.perUnitLow : p.perUnitHigh;
      const totalRev = state.productStrategy === "insta-sell" ? p.low : p.high;
      const tax = geTax(perUnitSell) * qty;
      const totalCost = p.cost + repair;
      const margin = totalRev - tax - totalCost;
      modalTooltip.appendChild(ttRow("Margin (historic, per craft)", fmtGp(margin), margin >= 0 ? "pos" : "neg"));
    }
  }
  modalTooltip.appendChild(ttRow("Buy vol",  (p.highVol || 0).toLocaleString(), "high"));
  modalTooltip.appendChild(ttRow("Sell vol", (p.lowVol  || 0).toLocaleString(), "low"));

  modalTooltip.hidden = false;
  // Position: prefer right of cursor, flip if it overflows
  const wrap = modalChart.parentElement.getBoundingClientRect();
  const tt   = modalTooltip.getBoundingClientRect();
  let left = cx + 14;
  if (left + tt.width > wrap.width - 8) left = cx - tt.width - 14;
  let top = cy - tt.height / 2;
  top = Math.max(4, Math.min(top, wrap.height - tt.height - 4));
  modalTooltip.style.left = `${left}px`;
  modalTooltip.style.top  = `${top}px`;
}
function hideChartTooltip() { modalTooltip.hidden = true; }

// Legacy multi-component margin builder, kept in case we want to overlay
// margin later. Currently unused by the simplified chart.
function buildMarginSeries(recipe, seriesById) {
  const resultId = recipe.id;
  const buckets = new Map();
  for (const p of seriesById[resultId] || []) {
    if (!p.timestamp) continue;
    const slot = buckets.get(p.timestamp) || {};
    slot.sell = p.avgLowPrice ?? p.avgHighPrice ?? null;
    buckets.set(p.timestamp, slot);
  }
  for (const comp of recipe.components) {
    for (const p of seriesById[comp.id] || []) {
      if (!p.timestamp) continue;
      const slot = buckets.get(p.timestamp);
      if (!slot) continue;
      slot[`c${comp.id}`] = p.avgHighPrice ?? p.avgLowPrice ?? null;
    }
  }
  const rc = repairCost(recipe.repairBase, state.smithing);
  const out = [];
  for (const [ts, slot] of buckets) {
    if (slot.sell === null || slot.sell === undefined) continue;
    let totalCost = recipe.extraCost || 0;
    let allPresent = true;
    for (const c of recipe.components) {
      const v = slot[`c${c.id}`];
      if (v === null || v === undefined) { allPresent = false; break; }
      totalCost += v * c.qty;
    }
    if (!allPresent) continue;
    totalCost += rc;
    const tax = geTax(slot.sell);
    const margin = slot.sell - tax - totalCost;
    out.push({ ts: ts * 1000, sell: slot.sell, cost: totalCost, margin });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function drawChartMessage(msg) {
  const ctx = modalChart.getContext("2d");
  const w = modalChart.width = modalChart.clientWidth;
  const h = modalChart.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#7d86b0";
  ctx.font = "14px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, w / 2, h / 2);
}

function drawChart(points, opts = {}) {
  const showCost = !!opts.showCost;
  const ctx = modalChart.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = modalChart.clientWidth;
  const cssH = modalChart.clientHeight;
  modalChart.width  = cssW * dpr;
  modalChart.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW, h = cssH;
  ctx.clearRect(0, 0, w, h);
  // Layout: price panel on top, dedicated news-marker strip below it (the
  // GE Tracker treatment — hoverable circles per news post), then the
  // volume panel. Marker strip has fixed 18px height so it doesn't shrink
  // when the modal resizes. Split what's left 80/20 between price/vol as
  // before.
  const padL = 70, padR = 16, padT = 14, padGap = 6, padB = 28;
  const markerH = 18;
  const availH = h - padT - padB - markerH - padGap * 2;
  const priceH = Math.round(availH * 0.80);
  const volH   = availH - priceH;
  const priceTop  = padT;
  const markerTop = priceTop + priceH + padGap;
  const volTop    = markerTop + markerH + padGap;

  const tsMin = points[0].ts, tsMax = points[points.length - 1].ts;
  const xs = ts => padL + ((ts - tsMin) / (tsMax - tsMin || 1)) * (w - padL - padR);

  // Price extents (combine high + low + cost, ignoring nulls)
  const prices = [];
  points.forEach(p => {
    if (p.high != null) prices.push(p.high);
    if (p.low  != null) prices.push(p.low);
    if (showCost && p.cost != null) prices.push(p.cost);
  });
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const pRange = (pMax - pMin) || 1;
  // Add 5% headroom both sides for visual breathing room
  const yMin = pMin - pRange * 0.05;
  const yMax = pMax + pRange * 0.05;
  const yRange = yMax - yMin;
  const ys = v => priceTop + (1 - (v - yMin) / yRange) * priceH;

  // Volume extents
  const vols = points.map(p => (p.highVol || 0) + (p.lowVol || 0));
  const vMax = Math.max(1, ...vols);
  const vy = v => volTop + volH - (v / vMax) * (volH - 4);

  // -- Price grid + Y labels --
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.fillStyle = "#7d86b0";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yRange * i) / yTicks;
    const y = ys(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(fmtGpShort(v), padL - 6, y);
  }

  // -- Volume separator + max label --
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(padL, volTop);
  ctx.lineTo(w - padR, volTop);
  ctx.stroke();
  ctx.fillStyle = "#7d86b0";
  ctx.textAlign = "right";
  ctx.fillText(fmtGpShort(vMax), padL - 6, volTop + 6);

  // -- X-axis labels --
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xTicks = 5;
  const spanDays = (tsMax - tsMin) / 86_400_000;
  for (let i = 0; i <= xTicks; i++) {
    const t = tsMin + ((tsMax - tsMin) * i) / xTicks;
    const x = xs(t);
    const d = new Date(t);
    const label = spanDays > 60
      ? d.toLocaleDateString([], { month: "short", year: "2-digit" })
      : spanDays > 2
        ? d.toLocaleDateString([], { month: "short", day: "numeric" })
        : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    ctx.fillText(label, x, h - padB + 6);
  }

  // -- Volume bars (stacked: insta-sell vol on top of insta-buy vol) --
  // Use integer coordinates so adjacent thin bars (Day view: 288 bars in ~700px)
  // don't smear into each other through canvas anti-aliasing.
  const plotWidth = w - padL - padR;
  const spacing = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;
  const barW = Math.max(1, Math.floor(spacing - 1));      // 1px guaranteed gap
  const baseY = Math.round(volTop + volH);
  const maxBarH = Math.floor(volH - 4);
  points.forEach((p) => {
    const totalV = (p.highVol || 0) + (p.lowVol || 0);
    if (totalV <= 0) return;
    const cx = xs(p.ts);
    const x  = Math.round(cx - barW / 2);
    const totalH = Math.round(totalV / vMax * maxBarH);
    const highH  = Math.round((p.highVol || 0) / vMax * maxBarH);
    if (highH > 0) {
      ctx.fillStyle = "rgba(245, 158, 11, 0.7)";
      ctx.fillRect(x, baseY - highH, barW, highH);
    }
    const lowH = totalH - highH;
    if (lowH > 0) {
      ctx.fillStyle = "rgba(96, 165, 250, 0.7)";
      ctx.fillRect(x, baseY - totalH, barW, lowH);
    }
  });

  // -- Price lines: orange = insta-buy (high), blue = insta-sell (low) --
  // Connect through gaps — points with null prices are *skipped*, not broken.
  // For long timeframes (year/all), most timesteps have no trades, so this
  // gives a continuous trend line instead of a fragmented mess.
  function line(key, color, width = 2.25) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      if (p[key] == null) continue;
      const x = xs(p.ts);
      const y = ys(p[key]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  line("high", "#f59e0b");
  line("low",  "#60a5fa");
  if (showCost) line("cost", "#4ade80", 2);   // green cost line on combined view

  // Mark valid data points with small dots so gaps are still visible
  // (a sparse 365-pt year view becomes obvious — you see where the trades
  // actually happened along the connected line).
  if (points.length <= 400) {
    for (const p of points) {
      const x = xs(p.ts);
      if (p.high != null) {
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath(); ctx.arc(x, ys(p.high), 1.5, 0, Math.PI * 2); ctx.fill();
      }
      if (p.low != null) {
        ctx.fillStyle = "#60a5fa";
        ctx.beginPath(); ctx.arc(x, ys(p.low), 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // News-post markers on the strip between price and volume. Hit-testable
  // via chartGeom.newsMarkers; hover shows a title tooltip; click opens
  // the post. Filtered to the visible time domain so long chart ranges
  // don't over-draw with markers that are outside the plot area.
  const newsMarkers = drawNewsMarkers(ctx, {
    tsMin, tsMax, xs, stripTop: markerTop, stripH: markerH, padL, padR, w,
  });

  // Stash geometry for hover code
  chartGeom = { points, xs, ys, vy, padL, padR, priceTop, priceH, volTop, volH, markerTop, markerH, w, h, barW, showCost, newsMarkers };
}

/* ---------------- Alerts (browser notifications) ----------------
   Fires a Notification when a favorited recipe's predicted buy or sell
   hour becomes the current local hour. Uses the browser's Notification API
   directly — no push server, no background workers. Piggybacks on the
   existing refresh polling (~60s) so alerts land within a minute of the
   hour boundary.

   Dedup: state.alertsFired stores <recipeKey>|<kind>|<hourStamp> keys so
   we don't fire twice in the same hour. Hour stamp = "YYYY-MM-DD-HH" in
   local time.
---------------------------------------------------- */
function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function updateNotifyButton() {
  const btn = document.getElementById("notify-btn");
  const icon = document.getElementById("notify-icon");
  if (!btn || !icon) return;
  if (!notificationsSupported()) {
    icon.textContent = "🔕";
    btn.title = "Notifications not supported by this browser";
    btn.disabled = true;
    return;
  }
  const enabled = state.notificationsEnabled && Notification.permission === "granted";
  icon.textContent = enabled ? "🔔" : "🔕";
  btn.title = enabled
    ? "Alerts ON — will notify when a favorited item hits its predicted buy/sell hour. Click to disable."
    : Notification.permission === "denied"
      ? "Browser blocked notifications for this site. Enable in browser settings to re-activate."
      : "Alerts OFF — click to enable browser notifications for predicted-hour hits on favorited items.";
}

async function toggleNotifications() {
  if (!notificationsSupported()) return;
  if (state.notificationsEnabled) {
    state.notificationsEnabled = false;
    localStorage.setItem("osrs-combo-notifications-enabled", "0");
  } else {
    if (Notification.permission === "default") {
      const p = await Notification.requestPermission();
      if (p !== "granted") { updateNotifyButton(); return; }
    }
    if (Notification.permission !== "granted") { updateNotifyButton(); return; }
    state.notificationsEnabled = true;
    localStorage.setItem("osrs-combo-notifications-enabled", "1");
    // Confirmation ping so the user sees it actually works
    try {
      new Notification("Big Timby alerts on", {
        body: "You'll get notified when a favorited item hits its predicted buy or sell hour.",
        tag: "big-timby-enable-confirm",
      });
    } catch (_) { /* some browsers deny constructor without user gesture — ignore */ }
  }
  updateNotifyButton();
}

function hourStamp(d = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

// Called at the end of refresh() — walks favorited recipes, checks whether
// the current local hour equals a predicted buy or sell hour, fires
// notifications for anything not already fired this hour.
function checkPredictedHourAlerts() {
  if (!state.notificationsEnabled) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const pm = window.overnightData?.predMap;
  if (!pm) return; // predictions haven't been computed yet
  const nowLocalHour = new Date().getHours();
  const stamp = hourStamp();

  // Helper: convert a UTC hour (what predMap stores) to a local hour
  const utcToLocalHour = (utcH) => {
    if (utcH == null) return null;
    const d = new Date(); d.setUTCHours(utcH, 0, 0, 0);
    return d.getHours();
  };

  for (const key of state.favorites) {
    const recipe = RECIPES.find(r => r.key === key);
    if (!recipe) continue;
    // For a combo recipe, "predicted buy hour" = when to buy the components.
    // Fire for each unique component buy hour that matches.
    const alerts = [];
    for (const c of recipe.components) {
      const p = pm[c.id];
      if (!p) continue;
      const localBuy = utcToLocalHour(p.buyHour);
      if (localBuy === nowLocalHour) alerts.push({ kind: "buy", itemId: c.id, itemName: state.mapping?.[c.id]?.name || `#${c.id}` });
    }
    // Product sell hour
    const prod = pm[recipe.id];
    if (prod) {
      const localSell = utcToLocalHour(prod.sellHour);
      if (localSell === nowLocalHour) alerts.push({ kind: "sell", itemId: recipe.id, itemName: recipe.name });
    }

    for (const a of alerts) {
      const dedup = `${key}|${a.kind}|${a.itemId}|${stamp}`;
      if (state.alertsFired.has(dedup)) continue;
      state.alertsFired.add(dedup);
      try {
        new Notification(
          a.kind === "buy" ? `Buy window: ${a.itemName}` : `Sell window: ${a.itemName}`,
          {
            body: `Predicted ${a.kind} hour for ${recipe.name} — favorited item`,
            tag: dedup,
          }
        );
      } catch (_) { /* browser may block if page isn't focused — dedup already recorded so we won't retry this hour */ }
    }
  }
  // Garbage-collect old dedup entries so state.alertsFired doesn't grow
  // unbounded. Keep only entries stamped for the current hour.
  for (const k of state.alertsFired) {
    if (!k.endsWith(stamp)) state.alertsFired.delete(k);
  }
}

/* ---------------- Refresh loop ---------------- */
async function refresh() {
  const btn = document.getElementById("refresh-btn");
  const icon = document.getElementById("refresh-icon");
  btn.disabled = true;
  icon.classList.add("spinning");
  try {
    // Snapshot the current margins BEFORE swapping in new prices so the
    // card render can compare new vs. previous and show a trend arrow.
    const snapshot = {};
    for (const r of RECIPES) {
      const c = calcMargin(r);
      if (c.margin != null) snapshot[r.key] = c.margin;
    }
    state.lastMargin = snapshot;

    const [prices, volumes, avg5m, avg1h, avg24h] = await Promise.all([
      fetchLatest(),
      fetchVolumes().catch(e => { console.warn("Volumes failed:", e); return state.volumes; }),
      fetchAvg5m().catch(e => { console.warn("5m avg failed:", e); return state.avg5m; }),
      fetchAvg1h().catch(e => { console.warn("1h avg failed:", e); return state.avg1h; }),
      fetchAvg24h().catch(e => { console.warn("24h avg failed:", e); return state.avg24h; }),
    ]);
    state.prices = prices;
    state.volumes = volumes;
    state.avg5m = avg5m;
    state.avg1h = avg1h;
    state.avg24h = avg24h;
    state.lastFetched = Date.now();
    renderGrid();
    // Fire any predicted-hour alerts for favorited items. Cheap — a couple
    // of hash-set lookups per favorite — and runs post-render so it doesn't
    // block the UI.
    try { checkPredictedHourAlerts(); } catch (e) { console.warn("Alert check failed:", e); }
  } catch (e) {
    console.error("Refresh failed:", e);
  } finally {
    btn.disabled = false;
    icon.classList.remove("spinning");
    state.countdown = REFRESH_MS / 1000;
  }
}

function tickCountdown() {
  state.countdown -= 1;
  if (state.countdown <= 0) {
    refresh();
  } else {
    document.getElementById("refresh-countdown").textContent = `${state.countdown}s`;
  }
}

/* ---------------- Init ---------------- */
async function init() {
  document.getElementById("smithing-level").value = state.smithing;
  document.getElementById("smithing-level").addEventListener("input", (e) => {
    const v = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 99));
    state.smithing = v;
    localStorage.setItem("osrs-combo-smithing", String(v));
    renderGrid();
  });
  const supSel = document.getElementById("supply-strategy");
  supSel.value = state.supplyStrategy;
  supSel.addEventListener("change", (e) => {
    state.supplyStrategy = e.target.value;
    localStorage.setItem("osrs-combo-supply-strategy", state.supplyStrategy);
    renderGrid();
    // Repaint open modal chart so the green cost line tracks the new strategy
    if (activeModalRecipe && modal.open) drawActiveTab(activeModalRecipe);
  });
  const prodSel = document.getElementById("product-strategy");
  prodSel.value = state.productStrategy;
  prodSel.addEventListener("change", (e) => {
    state.productStrategy = e.target.value;
    localStorage.setItem("osrs-combo-product-strategy", state.productStrategy);
    renderGrid();
    if (activeModalRecipe && modal.open) drawActiveTab(activeModalRecipe);
  });
  document.getElementById("hide-stale-products").addEventListener("change", (e) => {
    state.filters.hideStaleProducts = e.target.checked;
    renderGrid();
  });
  document.getElementById("hide-stale-components").addEventListener("change", (e) => {
    state.filters.hideStaleComponents = e.target.checked;
    renderGrid();
  });
  document.getElementById("hide-low-volume").addEventListener("change", (e) => {
    state.filters.hideLowVolume = e.target.checked;
    renderGrid();
  });
  document.getElementById("favorites-only").addEventListener("change", (e) => {
    state.filters.favoritesOnly = e.target.checked;
    renderGrid();
  });

  // Experimental-mode time filter: populate the hour selects + wire them.
  const hourLabel = (h) => {
    const ap = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${ap}`;
  };
  const timeSelects = [
    ["buy-hour-start", "buyHourStart"], ["buy-hour-end", "buyHourEnd"],
    ["sell-hour-start", "sellHourStart"], ["sell-hour-end", "sellHourEnd"],
  ];
  for (const [elId, filterKey] of timeSelects) {
    const sel = document.getElementById(elId);
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = String(h);
      opt.textContent = hourLabel(h);
      sel.appendChild(opt);
    }
    sel.value = String(state.filters[filterKey]);
    sel.addEventListener("change", (e) => {
      state.filters[filterKey] = parseInt(e.target.value, 10);
      renderGrid();
    });
  }

  // GE-slots filter: one GE slot per distinct component a craft needs.
  // Options are the component counts actually present, plus an "Any" default.
  const slotSelect = document.getElementById("ge-slots");
  const anyOpt = document.createElement("option");
  anyOpt.value = ""; anyOpt.textContent = "Any";
  slotSelect.appendChild(anyOpt);
  for (const n of [...new Set(RECIPES.map(r => r.components.length))].sort((a, b) => a - b)) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n} slot${n === 1 ? "" : "s"} or fewer`;
    slotSelect.appendChild(opt);
  }
  slotSelect.value = state.filters.maxSlots == null ? "" : String(state.filters.maxSlots);
  slotSelect.addEventListener("change", (e) => {
    state.filters.maxSlots = e.target.value === "" ? null : parseInt(e.target.value, 10);
    renderGrid();
  });

  // View toggle (cards / table)
  const setView = (v) => {
    state.view = v;
    localStorage.setItem("osrs-combo-view", v);
    document.getElementById("view-cards").classList.toggle("active", v === "cards");
    document.getElementById("view-table").classList.toggle("active", v === "table");
    renderGrid();
  };
  document.getElementById("view-cards").addEventListener("click", () => setView("cards"));
  document.getElementById("view-table").addEventListener("click", () => setView("table"));
  // Apply persisted view on init
  setView(state.view);
  const setMode = (m) => {
    const prev = state.mode;
    state.mode = m;
    localStorage.setItem("osrs-combo-mode", m);
    document.getElementById("mode-realtime").classList.toggle("active", m === "realtime");
    document.getElementById("mode-overnight").classList.toggle("active", m === "overnight");
    document.getElementById("mode-history").classList.toggle("active", m === "history");
    document.getElementById("mode-skilling").classList.toggle("active", m === "skilling");
    document.getElementById("mode-skilling-overnight").classList.toggle("active", m === "skilling-overnight");
    document.getElementById("mode-market").classList.toggle("active", m === "market");
    document.getElementById("mode-allocate").classList.toggle("active", m === "allocate");
    document.getElementById("layout").classList.toggle("mode-overnight", m === "overnight");
    document.getElementById("layout").classList.toggle("mode-history", m === "history");
    document.getElementById("layout").classList.toggle("mode-skilling", m === "skilling");
    document.getElementById("layout").classList.toggle("mode-skilling-overnight", m === "skilling-overnight");
    document.getElementById("layout").classList.toggle("mode-market", m === "market");
    document.getElementById("layout").classList.toggle("mode-allocate", m === "allocate");
    if (prev === "history" && m !== "history" && window.Flips?.onModeExit) {
      window.Flips.onModeExit();
    }
    if (m === "history" && window.Flips?.onModeEnter) {
      window.Flips.onModeEnter();
    }
    rebuildSortOptions(m);
    renderGrid();
  };
  function rebuildSortOptions(mode) {
    const sel = document.getElementById("sort");
    sel.replaceChildren();
    let opts;
    if (mode === "history") {
      opts = [
        ["profit-desc",      "Realized profit (high → low)"],
        ["roi-desc",         "ROI % (high → low)"],
        ["conversions-desc", "Conversions (high → low)"],
        ["avgprofit-desc",   "Avg profit / conversion"],
        ["timetoflip-asc",   "Avg time-to-flip (fastest)"],
        ["winrate-desc",     "Win rate (high → low)"],
        ["name-asc",         "Name (A→Z)"],
      ];
    } else if (mode === "skilling") {
      // Prune rate-based sorts when the current skill scope has no throughput
      // or XP to sort by — otherwise the dropdown offers "GP / hr" for Seeking
      // arrows where every value is null and sorting does nothing.
      const skill = state.filters.skillingSkill;
      const scoped = RECIPES.filter(r =>
        r.skill && (skill === "all" || r.skill === skill));
      const hasThroughput = scoped.some(r =>
        r.actionsPerHourMax != null || r.ticks != null);
      const hasXp = scoped.some(r => (r.xp || 0) > 0);
      opts = [
        ...(hasThroughput ? [
          ["gphr-desc",  "GP / hr (high → low)"],
          ["xphr-desc",  "XP / hr (high → low)"],
        ] : []),
        ...(hasXp ? [
          ["gpxp-desc",  "GP / XP (most profitable XP)"],
          ["gpxp-asc",   "GP / XP (cheapest XP)"],
        ] : []),
        ["margin-desc","Margin / action (high → low)"],
        ["level-asc",  "Level requirement (low → high)"],
        ["name-asc",   "Name (A→Z)"],
      ];
    } else {
      opts = [
        ["recommended",  "Recommended"],
        ["margin-desc",  "Margin (high → low)"],
        ["roi-desc",     "ROI % (high → low)"],
        ["daily-desc",   "Daily potential (high → low)"],
        ["flips-desc",   "Trades/day (high → low)"],
        ["cost-asc",     "Cost (low → high)"],
        ["cost-desc",    "Cost (high → low)"],
        ["name",         "Name (A→Z)"],
      ];
    }
    for (const [v, label] of opts) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    }
    if (mode === "history")        sel.value = state.filters.historySort;
    else if (mode === "skilling") {
      // If the persisted sort was dropped by the throughput/XP prune above,
      // fall back to the first available (margin-desc after the prune) and
      // persist the corrected value so it sticks across reloads.
      const valid = new Set(opts.map(([v]) => v));
      const persisted = state.filters.skillingSort || "gphr-desc";
      if (!valid.has(persisted)) {
        state.filters.skillingSort = opts[0][0];
        localStorage.setItem("osrs-combo-skilling-sort", state.filters.skillingSort);
      }
      sel.value = state.filters.skillingSort;
    }
    else                            sel.value = state.filters.sort;
  }
  document.getElementById("mode-realtime").addEventListener("click", () => setMode("realtime"));
  document.getElementById("mode-overnight").addEventListener("click", () => setMode("overnight"));
  document.getElementById("mode-history").addEventListener("click", () => setMode("history"));
  document.getElementById("mode-skilling").addEventListener("click", () => setMode("skilling"));
  document.getElementById("mode-skilling-overnight").addEventListener("click", () => setMode("skilling-overnight"));
  document.getElementById("mode-market").addEventListener("click", () => setMode("market"));
  document.getElementById("mode-allocate").addEventListener("click", () => setMode("allocate"));

  // Skilling sidebar wiring.
  const skillSel = document.getElementById("skilling-skill");
  const setLayoutSkillAttr = () => {
    document.getElementById("layout").dataset.skillingSkill = state.filters.skillingSkill;
  };
  setLayoutSkillAttr();
  if (skillSel) {
    skillSel.value = state.filters.skillingSkill;
    skillSel.addEventListener("change", (ev) => {
      state.filters.skillingSkill = ev.target.value;
      localStorage.setItem("osrs-combo-skilling-skill", state.filters.skillingSkill);
      setLayoutSkillAttr();
      // Switching skills invalidates both sub-filters — labels won't carry across.
      state.filters.skillingSubCats.clear();
      state.filters.skillingTiers.clear();
      localStorage.setItem("osrs-combo-skilling-subcats", "[]");
      localStorage.setItem("osrs-combo-skilling-tiers", "[]");
      renderSkillingSubCatChips();
      renderSkillingTierChips();
      // Sort options depend on which skill is scoped (e.g. Runecrafting has
      // no GP/hr to sort by), so rebuild the dropdown on skill change.
      rebuildSortOptions("skilling");
      renderGrid();
    });
  }
  renderSkillingSubCatChips();
  renderSkillingTierChips();

  // Herblore boost controls.
  for (const radio of document.querySelectorAll('input[name="herblore-amulet"]')) {
    radio.checked = radio.value === state.filters.herbloreAmulet;
    radio.addEventListener("change", (ev) => {
      if (!ev.target.checked) return;
      state.filters.herbloreAmulet = ev.target.value;
      localStorage.setItem("osrs-combo-herblore-amulet", ev.target.value);
      renderGrid();
    });
  }
  const goggles = document.getElementById("herblore-goggles");
  if (goggles) {
    goggles.checked = state.filters.herbloreGoggles;
    goggles.addEventListener("change", (ev) => {
      state.filters.herbloreGoggles = ev.target.checked;
      localStorage.setItem("osrs-combo-herblore-goggles", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }

  // Smithing boost controls.
  const outfitSel = document.getElementById("smithing-outfit-pieces");
  if (outfitSel) {
    outfitSel.value = String(state.filters.smithingOutfitPieces || 0);
    outfitSel.addEventListener("change", (ev) => {
      state.filters.smithingOutfitPieces = parseInt(ev.target.value, 10) || 0;
      localStorage.setItem("osrs-combo-smithing-outfit-pieces", String(state.filters.smithingOutfitPieces));
      renderGrid();
    });
  }
  const dmould = document.getElementById("smithing-double-mould");
  if (dmould) {
    dmould.checked = state.filters.smithingDoubleMould;
    dmould.addEventListener("change", (ev) => {
      state.filters.smithingDoubleMould = ev.target.checked;
      localStorage.setItem("osrs-combo-smithing-double-mould", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }
  const af = document.getElementById("smithing-ancient-furnace");
  if (af) {
    af.checked = state.filters.smithingAncientFurnace;
    af.addEventListener("change", (ev) => {
      state.filters.smithingAncientFurnace = ev.target.checked;
      localStorage.setItem("osrs-combo-smithing-ancient-furnace", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }
  // Cooking setup controls.
  const cookLevel = document.getElementById("cooking-level");
  if (cookLevel) {
    cookLevel.value = state.filters.cookingLevel;
    cookLevel.addEventListener("input", (ev) => {
      const v = Math.max(1, Math.min(99, parseInt(ev.target.value, 10) || 99));
      state.filters.cookingLevel = v;
      localStorage.setItem("osrs-combo-cooking-level", String(v));
      renderGrid();
    });
  }
  const cookMethod = document.getElementById("cooking-method");
  if (cookMethod) {
    cookMethod.value = state.filters.cookingMethod;
    cookMethod.addEventListener("change", (ev) => {
      state.filters.cookingMethod = ev.target.value;
      localStorage.setItem("osrs-combo-cooking-method", ev.target.value);
      renderGrid();
    });
  }
  const cookGaunt = document.getElementById("cooking-gauntlets");
  if (cookGaunt) {
    cookGaunt.checked = state.filters.cookingGauntlets;
    cookGaunt.addEventListener("change", (ev) => {
      state.filters.cookingGauntlets = ev.target.checked;
      localStorage.setItem("osrs-combo-cooking-gauntlets", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }
  const cookCape = document.getElementById("cooking-cape");
  if (cookCape) {
    cookCape.checked = state.filters.cookingCape;
    cookCape.addEventListener("change", (ev) => {
      state.filters.cookingCape = ev.target.checked;
      localStorage.setItem("osrs-combo-cooking-cape", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }

  const fknife = document.getElementById("fletching-knife");
  if (fknife) {
    fknife.checked = state.filters.fletchingKnife;
    fknife.addEventListener("change", (ev) => {
      state.filters.fletchingKnife = ev.target.checked;
      localStorage.setItem("osrs-combo-fletching-knife", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }

  // Runecrafting setup controls.
  const rcLevel = document.getElementById("runecrafting-level");
  if (rcLevel) {
    rcLevel.value = state.filters.runecraftingLevel;
    rcLevel.addEventListener("input", (ev) => {
      const v = Math.max(1, Math.min(99, parseInt(ev.target.value, 10) || 99));
      state.filters.runecraftingLevel = v;
      localStorage.setItem("osrs-combo-runecrafting-level", String(v));
      renderGrid();
    });
  }
  const rcEssence = document.getElementById("runecrafting-essence");
  if (rcEssence) {
    rcEssence.value = state.filters.runecraftingEssence;
    rcEssence.addEventListener("change", (ev) => {
      state.filters.runecraftingEssence = ev.target.value;
      localStorage.setItem("osrs-combo-runecrafting-essence", ev.target.value);
      renderGrid();
    });
  }
  const rcRaiments = document.getElementById("runecrafting-raiments");
  if (rcRaiments) {
    rcRaiments.value = String(state.filters.runecraftingRaiments);
    rcRaiments.addEventListener("change", (ev) => {
      const v = parseInt(ev.target.value, 10) || 0;
      state.filters.runecraftingRaiments = v;
      localStorage.setItem("osrs-combo-runecrafting-raiments", String(v));
      renderGrid();
    });
  }
  const rcBinding = document.getElementById("runecrafting-binding-necklace");
  if (rcBinding) {
    rcBinding.checked = state.filters.runecraftingBindingNecklace;
    rcBinding.addEventListener("change", (ev) => {
      state.filters.runecraftingBindingNecklace = ev.target.checked;
      localStorage.setItem("osrs-combo-runecrafting-binding", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }
  const rcImbue = document.getElementById("runecrafting-magic-imbue");
  if (rcImbue) {
    rcImbue.checked = state.filters.runecraftingMagicImbue;
    rcImbue.addEventListener("change", (ev) => {
      state.filters.runecraftingMagicImbue = ev.target.checked;
      localStorage.setItem("osrs-combo-runecrafting-imbue", ev.target.checked ? "1" : "0");
      renderGrid();
    });
  }

  setMode(state.mode);
  document.getElementById("search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderGrid();
  });
  document.getElementById("sort").addEventListener("change", (e) => {
    if (state.mode === "history") {
      state.filters.historySort = e.target.value;
      localStorage.setItem("osrs-combo-history-sort", state.filters.historySort);
      renderGrid();
      return;
    }
    if (state.mode === "skilling") {
      state.filters.skillingSort = e.target.value;
      localStorage.setItem("osrs-combo-skilling-sort", state.filters.skillingSort);
      renderGrid();
      return;
    }
    state.filters.sort = e.target.value;
    renderGrid();
  });
  // Cost slider — dual handle, log scale 0 → COST_SLIDER_MAX gp
  const COST_SLIDER_MAX = 1_000_000_000; // 1B, well above any real recipe cost
  const COST_BINS = 32;
  const posToGp = (pos) => {
    if (pos <= 0) return 0;
    if (pos >= 100) return COST_SLIDER_MAX;
    const log = (pos / 100) * Math.log10(COST_SLIDER_MAX);
    return Math.round(Math.pow(10, log));
  };
  const gpToPos = (gp) => {
    if (!gp || gp <= 1) return 0;
    return Math.min(100, (Math.log10(gp) / Math.log10(COST_SLIDER_MAX)) * 100);
  };
  const minSlider = document.getElementById("cost-min-slider");
  const maxSlider = document.getElementById("cost-max-slider");
  const trackFill = document.getElementById("cost-track-fill");
  const readout   = document.getElementById("cost-range-readout");
  const countEl   = document.getElementById("cost-range-count");
  const histEl    = document.getElementById("cost-histogram");

  // Build histogram bars once; their heights/classes update each render
  for (let i = 0; i < COST_BINS; i++) {
    const bar = el("div", { class: "hbar" });
    bar.style.height = "2px";
    bar.title = "";
    histEl.appendChild(bar);
  }
  const histBars = [...histEl.children];

  // Click on a bar = drop the nearest handle there (intuitive jump-to-bucket)
  histEl.addEventListener("click", (e) => {
    const rect = histEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const lo = parseInt(minSlider.value, 10);
    const hi = parseInt(maxSlider.value, 10);
    if (Math.abs(pct - lo) <= Math.abs(pct - hi)) minSlider.value = Math.round(pct);
    else maxSlider.value = Math.round(pct);
    updateCostFilter();
  });

  // Recompute & redraw histogram. Honors EVERY active filter except cost itself —
  // the cost slider's job is to pick a slice of this histogram, so we don't want
  // it to be self-referential. Sliding the cost handles only repaints in/out
  // shading; changing any other filter (category, search, profitable, hide stale)
  // reshapes the bar heights.
  function refreshHistogram() {
    const f = state.filters;
    const q = f.search.toLowerCase().trim();
    const nowSec = Date.now() / 1000;
    const staleSec = STALE_MS / 1000;
    const items = [];
    for (const r of RECIPES) {
      // Match the realtime grid: skilling recipes live in their own mode and
      // are excluded from the realtime view (see renderGrid). The histogram
      // is only visible on Realtime, so excluding here keeps its counts and
      // bar heights in sync with what the grid actually shows.
      if (r.skill) continue;
      const c = calcMargin(r);
      if (!c.allPresent) continue;
      if (!r._tags.some(t => f.activeCats.has(t))) continue;
      if (f.maxSlots !== null && r.components.length > f.maxSlots) continue;
      if (q && !r.name.toLowerCase().includes(q)) continue;
      if (f.profitableOnly && !(c.margin > 0)) continue;
      if (f.hideStaleProducts && isItemStale(r.id)) continue;
      if (f.hideStaleComponents && r.components.some(comp => isItemStale(comp.id))) continue;
      if (f.hideLowVolume) {
        const productVolPerHr = perHour(c.resultVol);
        if (productVolPerHr == null || productVolPerHr < 1) continue;
      }
      items.push(c);
    }
    const counts = new Array(COST_BINS).fill(0);
    for (const c of items) {
      const pos = gpToPos(c.totalCost);
      const bin = Math.min(COST_BINS - 1, Math.floor((pos / 100) * COST_BINS));
      counts[bin]++;
    }
    const maxCount = Math.max(1, ...counts);
    const lo = parseInt(minSlider.value, 10);
    const hi = parseInt(maxSlider.value, 10);
    for (let i = 0; i < COST_BINS; i++) {
      const bar = histBars[i];
      const heightPx = 4 + Math.round((counts[i] / maxCount) * 26);
      bar.style.height = `${heightPx}px`;
      const binCenter = ((i + 0.5) / COST_BINS) * 100;
      bar.classList.toggle("in",  binCenter >= lo && binCenter <= hi);
      bar.classList.toggle("out", binCenter <  lo || binCenter >  hi);
      bar.title = `${counts[i]} item${counts[i] === 1 ? "" : "s"} between ${fmtGp(posToGp(i*100/COST_BINS))} and ${fmtGp(posToGp((i+1)*100/COST_BINS))}`;
    }
    // Count items currently in range (with cost filter applied)
    let inRange = 0;
    for (const c of items) {
      if (c.totalCost < (state.filters.minCost ?? 0)) continue;
      if (state.filters.maxCost !== null && c.totalCost > state.filters.maxCost) continue;
      inRange++;
    }
    countEl.textContent = `(${inRange} of ${items.length} items)`;
  }

  const updateCostFilter = () => {
    let lo = parseInt(minSlider.value, 10);
    let hi = parseInt(maxSlider.value, 10);
    if (lo >= hi) {
      if (document.activeElement === minSlider) { lo = Math.max(0, hi - 1); minSlider.value = lo; }
      else { hi = Math.min(100, lo + 1); maxSlider.value = hi; }
    }
    const gpMin = posToGp(lo);
    const gpMax = posToGp(hi);
    state.filters.minCost = lo === 0   ? null : gpMin;
    state.filters.maxCost = hi === 100 ? null : gpMax;
    trackFill.style.left  = `${lo}%`;
    trackFill.style.width = `${hi - lo}%`;
    readout.textContent = `${fmtGp(gpMin)} – ${hi === 100 ? "∞" : fmtGp(gpMax)}`;
    refreshHistogram();
    renderGrid();
  };
  minSlider.addEventListener("input", updateCostFilter);
  maxSlider.addEventListener("input", updateCostFilter);
  // Expose so refresh() can repaint histogram after prices arrive
  state.refreshHistogram = refreshHistogram;
  updateCostFilter();   // initial paint
  document.getElementById("profitable-only").addEventListener("change", (e) => {
    state.filters.profitableOnly = e.target.checked;
    renderGrid();
  });
  document.getElementById("refresh-btn").addEventListener("click", refresh);
  // Notifications button — click toggles alerts on/off. On first enable we
  // request Notification permission (needs a user gesture in most browsers).
  const notifyBtn = document.getElementById("notify-btn");
  if (notifyBtn) {
    notifyBtn.addEventListener("click", toggleNotifications);
    // If user had alerts enabled last session but permission has since been
    // revoked, silently disable so the button icon matches reality.
    if (state.notificationsEnabled && notificationsSupported()
        && Notification.permission !== "granted") {
      state.notificationsEnabled = false;
      localStorage.setItem("osrs-combo-notifications-enabled", "0");
    }
    updateNotifyButton();
  }

  // Bulk allocator: Calculate button reads sidebar inputs, runs the greedy
  // allocation, and re-renders the Allocate tab with the result.
  const allocateBtn = document.getElementById("allocate-btn");
  if (allocateBtn) {
    // Parse "200000000" or "200,000,000" or "200m" style input.
    const parseGp = (s) => {
      if (!s) return null;
      s = String(s).trim().toLowerCase().replace(/,/g, "").replace(/\s/g, "");
      const suffix = s.match(/([kmb])$/);
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[suffix?.[1]] || 1;
      const num = parseFloat(suffix ? s.slice(0, -1) : s);
      return isFinite(num) ? num * mult : null;
    };
    allocateBtn.addEventListener("click", () => {
      const budget = parseGp(document.getElementById("allocate-budget").value);
      const horizon = document.getElementById("allocate-horizon").value;
      const slots = Math.max(1, Math.min(8, parseInt(document.getElementById("allocate-slots").value, 10) || 8));
      const minContribPct = Math.max(0, parseFloat(document.getElementById("allocate-min-contrib").value) || 0);
      const maxPerRecipePct = Math.max(1, Math.min(100, parseFloat(document.getElementById("allocate-max-pct").value) || 100));
      const requireConf = document.getElementById("allocate-require-conf").checked;
      const skipSkilling = document.getElementById("allocate-skip-skilling").checked;
      const hideStale = document.getElementById("allocate-hide-stale").checked;
      const onlyZeroTime = document.getElementById("allocate-only-zero-time").checked;
      const freeSkillingSupplies = document.getElementById("allocate-free-supplies").checked;
      const freeComponentCombines = document.getElementById("allocate-free-components").checked;
      state.allocation = allocateRecipes({
        budget, horizon, slots, minContribPct, maxPerRecipePct,
        requireConf, skipSkilling, hideStale, onlyZeroTime,
        freeSkillingSupplies, freeComponentCombines,
      });
      // Persist inputs so they survive reload.
      localStorage.setItem("osrs-combo-allocate-budget", document.getElementById("allocate-budget").value);
      localStorage.setItem("osrs-combo-allocate-horizon", horizon);
      localStorage.setItem("osrs-combo-allocate-slots", String(slots));
      localStorage.setItem("osrs-combo-allocate-min-contrib", String(minContribPct));
      localStorage.setItem("osrs-combo-allocate-max-pct", String(maxPerRecipePct));
      localStorage.setItem("osrs-combo-allocate-hide-stale", hideStale ? "1" : "0");
      localStorage.setItem("osrs-combo-allocate-only-zero-time", onlyZeroTime ? "1" : "0");
      localStorage.setItem("osrs-combo-allocate-free-supplies", freeSkillingSupplies ? "1" : "0");
      localStorage.setItem("osrs-combo-allocate-free-components", freeComponentCombines ? "1" : "0");
      renderGrid();
    });
    // Restore persisted inputs on load
    const restore = (id, key, isCheckbox) => {
      const v = localStorage.getItem(key);
      if (v == null) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (isCheckbox) el.checked = v === "1";
      else el.value = v;
    };
    restore("allocate-budget", "osrs-combo-allocate-budget");
    restore("allocate-horizon", "osrs-combo-allocate-horizon");
    restore("allocate-slots", "osrs-combo-allocate-slots");
    restore("allocate-min-contrib", "osrs-combo-allocate-min-contrib");
    restore("allocate-max-pct", "osrs-combo-allocate-max-pct");
    restore("allocate-hide-stale", "osrs-combo-allocate-hide-stale", true);
    restore("allocate-only-zero-time", "osrs-combo-allocate-only-zero-time", true);
    restore("allocate-free-supplies", "osrs-combo-allocate-free-supplies", true);
    restore("allocate-free-components", "osrs-combo-allocate-free-components", true);
  }

  /* ---------------- Curator popover factory ----------------
   * Two popovers with identical structure: one for component combines,
   * one for skilling recipes (aka "supplies"). Each lists the recipes in
   * its classification with a checkbox per row — unchecked = excluded
   * from allocation entirely (persists via state.excludedRecipes). Search
   * box + Include-all / Exclude-all bulk controls. Backed by a shared
   * factory so the two popovers stay consistent as they evolve.
   *
   * Both share state.excludedRecipes — an unhide from either popover
   * flips the same underlying Set. The combines popover additionally
   * surfaces "Other hidden recipes" (anything excluded but not in the
   * combines classification) so card-hidden recipes stay unhideable.
   */
  function wireCuratorPopover(cfg) {
    const modal   = document.getElementById(cfg.modalId);
    const btn     = document.getElementById(cfg.btnId);
    const badge   = document.getElementById(cfg.badgeId);
    if (!modal || !btn) return { update: () => {} };
    const listEl   = document.getElementById(cfg.listId);
    const searchEl = document.getElementById(cfg.searchId);
    const countEl  = document.getElementById(cfg.countId);
    const closeBtn = document.getElementById(cfg.closeId);
    const includeAllBtn = document.getElementById(cfg.includeAllId);
    const excludeAllBtn = document.getElementById(cfg.excludeAllId);

    // Rows come from two kinds of source: recipes (unchecking excludes from
    // allocation via state.excludedRecipes) and items (unchecking removes
    // from the fast-fill pool via state.excludedFreeSlotItems). Both render
    // identically; the checkbox handler branches on `entry.kind`.
    function isEntryExcluded(entry) {
      if (entry.kind === "item") return state.excludedFreeSlotItems.has(String(entry.id));
      return state.excludedRecipes.has(entry.recipe.key);
    }
    function setEntryExcluded(entry, excluded) {
      if (entry.kind === "item") setFreeSlotItemExcluded(entry.id, excluded);
      else setRecipeExcluded(entry.recipe.key, excluded);
    }
    function entryMatches(entry, q) {
      if (!q) return true;
      const name = entry.kind === "item" ? entry.name : entry.recipe.name;
      const cat  = entry.kind === "item" ? "" : (entry.recipe.cat || "");
      return name.toLowerCase().includes(q) || cat.toLowerCase().includes(q);
    }
    function collectPrimary() {
      const out = [];
      for (const r of cfg.getScope()) out.push({ kind: "recipe", recipe: r });
      if (cfg.getItems) for (const it of cfg.getItems()) out.push({ kind: "item", ...it });
      return out;
    }
    function updateBadge() {
      let n = 0;
      for (const entry of collectPrimary()) if (isEntryExcluded(entry)) n++;
      badge.textContent = n > 0 ? `${n} excluded` : "";
      badge.style.display = n > 0 ? "" : "none";
    }
    function render() {
      const q = (searchEl.value || "").trim().toLowerCase();
      const primary = collectPrimary().filter(e => entryMatches(e, q));
      // Optional secondary section (used by combines popover for "Other hidden")
      const secondary = cfg.getSecondary
        ? cfg.getSecondary().map(r => ({ kind: "recipe", recipe: r })).filter(e => entryMatches(e, q))
        : [];

      listEl.replaceChildren();
      const makeRow = (entry) => {
        const excluded = isEntryExcluded(entry);
        const row = el("label", { class: "combines-row" + (excluded ? " excluded" : "") });
        const cb = el("input", { attrs: { type: "checkbox" } });
        cb.checked = !excluded;
        cb.addEventListener("change", () => {
          setEntryExcluded(entry, !cb.checked);
          row.classList.toggle("excluded", !cb.checked);
          updateBadge();
          updateCount();
          syncAllCuratorBadges();
        });
        const displayName = entry.kind === "item" ? entry.name : entry.recipe.name;
        const displayCat  = entry.kind === "item" ? "component" : entry.recipe.cat;
        row.appendChild(cb);
        row.appendChild(el("span", { class: "combines-row-name", text: displayName }));
        if (displayCat) row.appendChild(el("span", { class: "combines-row-cat", text: displayCat }));
        return row;
      };
      if (primary.length) {
        if (cfg.primaryHeader) {
          listEl.appendChild(el("div", { class: "combines-section-header",
            text: `${cfg.primaryHeader} · ${primary.length}` }));
        }
        for (const e of primary) listEl.appendChild(makeRow(e));
      }
      if (secondary.length) {
        listEl.appendChild(el("div", { class: "combines-section-header",
          text: `${cfg.secondaryHeader} · ${secondary.length}` }));
        for (const e of secondary) listEl.appendChild(makeRow(e));
      }
      if (!primary.length && !secondary.length) {
        listEl.appendChild(el("div", { class: "combines-empty",
          text: q ? "No matches." : cfg.emptyText }));
      }
    }
    function updateCount() {
      const primary = collectPrimary();
      let excluded = 0;
      for (const e of primary) if (isEntryExcluded(e)) excluded++;
      const parts = [
        `${primary.length - excluded} included · ${excluded} excluded · ${primary.length} ${cfg.noun}`,
      ];
      if (cfg.getSecondary) {
        const otherHidden = cfg.getSecondary().length;
        if (otherHidden > 0) parts.push(`+ ${otherHidden} other hidden`);
      }
      countEl.textContent = parts.join(" · ");
    }
    btn.addEventListener("click", () => {
      searchEl.value = "";
      render();
      updateCount();
      if (typeof modal.showModal === "function") modal.showModal();
      else modal.setAttribute("open", "");
    });
    closeBtn.addEventListener("click", () => modal.close());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
    searchEl.addEventListener("input", render);
    includeAllBtn.addEventListener("click", () => {
      for (const entry of collectPrimary()) setEntryExcluded(entry, false);
      updateBadge();
      render();
      updateCount();
      syncAllCuratorBadges();
    });
    excludeAllBtn.addEventListener("click", () => {
      for (const entry of collectPrimary()) setEntryExcluded(entry, true);
      updateBadge();
      render();
      updateCount();
      syncAllCuratorBadges();
    });
    // Prime the badge on load so the sidebar reflects any persisted exclusions.
    updateBadge();
    return { update: updateBadge };
  }
  // Cross-popover badge sync: unhide from card OR either popover updates
  // both sidebar badges. Populated below after both curators are wired.
  const _curators = [];
  function syncAllCuratorBadges() { for (const c of _curators) c.update(); }

  // Fillers popover: primary = freeSlotFillerRecipes() (recipes) +
  // FREE_SLOT_ITEM_IDS entries (items). Both participate in the same toggle
  // ("Filler intermediates + fast-fill components don't consume slots") so
  // both belong in the same checklist. Unchecking a recipe excludes it from
  // allocation entirely; unchecking an item removes it from the fast-fill
  // pool. Secondary = card-hidden recipes not otherwise scoped.
  _curators.push(wireCuratorPopover({
    modalId: "combines-modal",
    btnId: "allocate-combines-list-btn",
    badgeId: "allocate-combines-count",
    listId: "combines-modal-list",
    searchId: "combines-modal-search",
    countId: "combines-modal-count",
    closeId: "combines-modal-close",
    includeAllId: "combines-include-all",
    excludeAllId: "combines-exclude-all",
    noun: "entries",
    primaryHeader: "Fillers + fast-fill components",
    secondaryHeader: "Other hidden recipes",
    emptyText: "No filler entries — add freeSlotFiller:true to recipes or ids to FREE_SLOT_ITEM_IDS.",
    getScope: () => freeSlotFillerRecipes(),
    getItems: () => Array.from(FREE_SLOT_ITEM_IDS)
      .map(id => ({ id, name: state.mapping?.[id]?.name || `#${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    getSecondary: () => {
      const fillerKeys = new Set(freeSlotFillerRecipes().map(r => r.key));
      const skillKeys = new Set(RECIPES.filter(r => r.skill).map(r => r.key));
      // "Other hidden" excludes recipes that live in the supplies popover
      // (skilling), so unhiding is scoped: skilling stays in supplies view,
      // non-skilling non-filler hides show here.
      return RECIPES.filter(r =>
        state.excludedRecipes.has(r.key) && !fillerKeys.has(r.key) && !skillKeys.has(r.key)
      ).sort((a, b) => a.name.localeCompare(b.name));
    },
  }));
  // Supplies popover: primary = every skilling recipe. Grouped by category
  // (Construction / Cooking / Fletching / etc.) so the user can scan by skill.
  _curators.push(wireCuratorPopover({
    modalId: "supplies-modal",
    btnId: "allocate-supplies-list-btn",
    badgeId: "allocate-supplies-count",
    listId: "supplies-modal-list",
    searchId: "supplies-modal-search",
    countId: "supplies-modal-count",
    closeId: "supplies-modal-close",
    includeAllId: "supplies-include-all",
    excludeAllId: "supplies-exclude-all",
    noun: "skilling recipes",
    primaryHeader: "Skilling recipes",
    emptyText: "No skilling recipes loaded.",
    getScope: () => RECIPES.filter(r => r.skill).slice().sort((a, b) =>
      (a.cat || "").localeCompare(b.cat || "") || a.name.localeCompare(b.name)),
  }));

  // Sidebar collapse toggle
  const layoutEl = document.getElementById("layout");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  if (localStorage.getItem("osrs-combo-sidebar") === "collapsed") {
    layoutEl.classList.add("sidebar-collapsed");
    sidebarToggle.title = "Expand filters";
  }
  sidebarToggle.addEventListener("click", () => {
    const collapsed = layoutEl.classList.toggle("sidebar-collapsed");
    localStorage.setItem("osrs-combo-sidebar", collapsed ? "collapsed" : "expanded");
    sidebarToggle.title = collapsed ? "Expand filters" : "Collapse filters";
  });

  // Mobile menu toggle — collapses the header controls + sidebar into a
  // dropdown so the card grid is the first thing visible on a phone.
  const menuToggle = document.getElementById("menu-toggle");
  const menuToggleIcon = menuToggle.querySelector(".menu-toggle-icon");
  menuToggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("filters-open");
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    menuToggleIcon.textContent = open ? "✕" : "☰";
  });

  // Browsers restore <input>/<select>/checkbox values on reload, but the
  // input/change events don't fire for that restoration — so a restored
  // filter would look active yet not actually filter. Seed state.filters
  // from whatever the controls currently show so the two stay in sync.
  state.filters.search              = document.getElementById("search").value;
  state.filters.sort                = document.getElementById("sort").value;
  state.filters.profitableOnly      = document.getElementById("profitable-only").checked;
  state.filters.hideStaleProducts   = document.getElementById("hide-stale-products").checked;
  state.filters.hideStaleComponents = document.getElementById("hide-stale-components").checked;
  state.filters.hideLowVolume       = document.getElementById("hide-low-volume").checked;
  state.filters.favoritesOnly       = document.getElementById("favorites-only").checked;

  renderCategories();

  try { state.mapping = await fetchMapping(); }
  catch (e) { console.error("Mapping fetch failed:", e); }
  await refresh();

  state.countdownTimer = setInterval(tickCountdown, 1000);
}

init();

// Register the service worker — required for the browser to surface a
// PWA install prompt. Wrapped in try/catch because file:// origins and
// older browsers will fail; we don't want that to break the app.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
