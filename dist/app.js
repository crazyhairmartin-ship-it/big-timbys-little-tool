/* ============================================================
   OSRS Combination-Item Margin Tracker
   - Live prices: OSRS Wiki real-time API
   - GE tax: 2% capped at 5M, items <100gp exempt
   - 60s auto refresh, manual refresh
   - 5-minute rolling local history (24h window) for sparkline
   - On-demand /timeseries fetch for full modal chart
   ============================================================ */

const API_BASE = "https://prices.runescape.wiki/api/v1/osrs";
const ICON_BASE = "https://oldschool.runescape.wiki/images";

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
  { key:"dragon-crossbow-u", id:21921, name:"Dragon crossbow (u)", cat:"Dragon", components:[{id:21952,qty:1},{id:21918,qty:1}] },
  { key:"dragon-hunter-lance", id:22978, name:"Dragon hunter lance", cat:"Dragon", components:[{id:22966,qty:1},{id:11889,qty:1}] },
  { key:"dragon-kiteshield", id:21895, name:"Dragon kiteshield", cat:"Dragon", components:[{id:1187,qty:1},{id:22097,qty:1},{id:22100,qty:1}] },
  { key:"dragon-platebody", id:21892, name:"Dragon platebody", cat:"Dragon", components:[{id:3140,qty:1},{id:22103,qty:1},{id:22097,qty:1}] },
  { key:"dragon-sq-shield", id:1187, name:"Dragon sq shield", cat:"Dragon", components:[{id:2366,qty:1},{id:2368,qty:1}] },

  { key:"ancient-godsword", id:26233, name:"Ancient godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:26370,qty:1}] },
  { key:"armadyl-godsword", id:11802, name:"Armadyl godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:11810,qty:1}] },
  { key:"bandos-godsword", id:11804, name:"Bandos godsword", cat:"Godswords", components:[{id:11798,qty:1},{id:11812,qty:1}] },
  { key:"godsword-blade", id:11798, name:"Godsword blade", cat:"Godswords", components:[{id:11820,qty:1},{id:11818,qty:1},{id:11822,qty:1}] },
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
  { key:"amulet-of-fury", id:6585, name:"Amulet of fury", cat:"Misc", components:[{id:6581,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"bryophytas-staff-uncharged", id:22368, name:"Bryophyta's staff (uncharged)", cat:"Misc", components:[{id:1391,qty:1},{id:22372,qty:1}] },
  { key:"crystal-key", id:989, name:"Crystal key", cat:"Misc", components:[{id:987,qty:1},{id:985,qty:1}] },
  { key:"dragonfire-shield", id:11284, name:"Dragonfire shield", cat:"Misc", components:[{id:1540,qty:1},{id:11286,qty:1}] },
  { key:"dragonfire-ward", id:22003, name:"Dragonfire ward", cat:"Misc", components:[{id:22006,qty:1},{id:1540,qty:1}] },
  { key:"malediction-ward", id:11924, name:"Malediction ward", cat:"Misc", components:[{id:11931,qty:1},{id:11932,qty:1},{id:11933,qty:1}] },
  { key:"odium-ward", id:11926, name:"Odium ward", cat:"Misc", components:[{id:11928,qty:1},{id:11929,qty:1},{id:11930,qty:1}] },
  { key:"wrath-tiara", id:22121, name:"Wrath tiara", cat:"Misc", components:[{id:5525,qty:1},{id:22118,qty:1}] },

  { key:"berserker-necklace", id:11128, name:"Berserker necklace", cat:"Onyx", components:[{id:6577,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"onyx-amulet", id:6581, name:"Onyx amulet", cat:"Onyx", components:[{id:6579,qty:1},{id:1759,qty:1}] },
  { key:"onyx-amulet-u", id:6579, name:"Onyx amulet (u)", cat:"Onyx", components:[{id:2357,qty:1},{id:6573,qty:1}] },
  { key:"onyx-bracelet", id:11130, name:"Onyx bracelet", cat:"Onyx", components:[{id:6573,qty:1},{id:2357,qty:1}] },
  { key:"onyx-necklace", id:6577, name:"Onyx necklace", cat:"Onyx", components:[{id:2357,qty:1},{id:6573,qty:1}] },
  { key:"onyx-ring", id:6575, name:"Onyx ring", cat:"Onyx", components:[{id:6573,qty:1},{id:2357,qty:1}] },
  { key:"ring-of-stone", id:6583, name:"Ring of stone", cat:"Onyx", components:[{id:6575,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },

  { key:"heavy-ballista", id:19481, name:"Heavy ballista", cat:"Ranged", components:[{id:19607,qty:1},{id:19610,qty:1}] },
  { key:"incomplete-heavy-ballista", id:19598, name:"Incomplete heavy ballista", cat:"Ranged", components:[{id:19589,qty:1},{id:19592,qty:1}] },
  { key:"incomplete-light-ballista", id:19595, name:"Incomplete light ballista", cat:"Ranged", components:[{id:19586,qty:1},{id:19592,qty:1}] },
  { key:"light-ballista", id:19478, name:"Light ballista", cat:"Ranged", components:[{id:19604,qty:1},{id:19610,qty:1}] },
  { key:"unstrung-heavy-ballista", id:19607, name:"Unstrung heavy ballista", cat:"Ranged", components:[{id:19598,qty:1},{id:19601,qty:1}] },
  { key:"unstrung-light-ballista", id:19604, name:"Unstrung light ballista", cat:"Ranged", components:[{id:19595,qty:1},{id:19601,qty:1}] },
  { key:"zaryte-crossbow", id:26374, name:"Zaryte crossbow", cat:"Ranged", components:[{id:11785,qty:1},{id:26372,qty:1},{id:26231,qty:250}] },
  { key:"venator-bow-uncharged", id:27612, name:"Venator bow (uncharged)", cat:"Ranged", components:[{id:27614,qty:5}] },

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
  { key:"blessed-spirit-shield", id:12831, name:"Blessed spirit shield", cat:"Spirit Shields", components:[{id:12829,qty:1},{id:12833,qty:1}] },
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
  { key:"zamorakian-hasta", id:11889, name:"Zamorakian hasta", cat:"Wilderness", components:[{id:11824,qty:1}], extraCost:150000 },

  { key:"amulet-of-torture", id:19553, name:"Amulet of torture", cat:"Zenyte", components:[{id:19541,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"necklace-of-anguish", id:19547, name:"Necklace of anguish", cat:"Zenyte", components:[{id:19535,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"ring-of-suffering", id:19550, name:"Ring of suffering", cat:"Zenyte", components:[{id:19538,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"tormented-bracelet", id:19544, name:"Tormented bracelet", cat:"Zenyte", components:[{id:19532,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"uncut-zenyte", id:19496, name:"Uncut zenyte", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}] },
  { key:"zenyte-amulet", id:19541, name:"Zenyte amulet", cat:"Zenyte", components:[{id:19501,qty:1},{id:1759,qty:1}] },
  { key:"zenyte-amulet-u", id:19501, name:"Zenyte amulet (u)", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"zenyte-bracelet", id:19532, name:"Zenyte bracelet", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"zenyte-necklace", id:19535, name:"Zenyte necklace", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },
  { key:"zenyte-ring", id:19538, name:"Zenyte ring", cat:"Zenyte", components:[{id:2357,qty:1},{id:19493,qty:1}] },

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
];

/* ---------------- Tag taxonomy ----------------
   Each recipe can have multiple tags. Filters use OR logic — show if the
   recipe has ANY of the user-selected tags. The tag list below is the union
   across all recipes; the per-recipe assignment lives in `tagsFor()`.
------------------------------------------------ */
function tagsFor(r) {
  const tags = new Set();
  const n = r.name.toLowerCase();
  const cat = r.cat;

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
  if (cat === "Spirit Shields") tags.add("Spirit Shields");
  if (cat === "Masori")         tags.add("Masori");
  if (cat === "Torva")          tags.add("Nex");
  if (cat === "Barrows")        tags.add("Barrows");
  if (cat === "Moons")          tags.add("Moons of Peril");
  if (cat === "Zenyte")         tags.add("Zenyte");
  if (cat === "Onyx")           tags.add("Onyx");
  if (cat === "Dragon")         tags.add("Dragon");
  if (cat === "Toxic")          tags.add("Zulrah");
  // Spirit shield decombines logically belong to Spirit Shields too
  if (/sigil ←|spirit shield/.test(n)) tags.add("Spirit Shields");
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
  return [...tags];
}
// Pre-compute and cache tags on each recipe
for (const r of RECIPES) r._tags = tagsFor(r);

// Stable order for the chip bar — combat / slot / theme / mechanic
const TAG_ORDER = [
  // Combat class
  "Melee", "Magic", "Ranged",
  // Slot
  "Weapon", "Armor", "Shield", "Jewelry", "Boots",
  // Theme / source
  "Godswords", "Spirit Shields", "Nex", "Masori", "Barrows", "Moons of Peril",
  "Zenyte", "Onyx", "Dragon", "Zulrah", "Wilderness",
  // Mechanic
  "Repair", "Decombine", "Component", "Other"
];
const TAGS = TAG_ORDER.filter(t => RECIPES.some(r => r._tags.includes(t)));
const CATEGORIES = TAGS; // alias kept for filter state compat

/* ---------------- State ---------------- */
const state = {
  mapping: {},
  prices: {},
  volumes: {},          // id → 24h trade count
  lastFetched: 0,
  history: loadHistory(),
  filters: {
    search: "",
    sort: "margin-desc",
    minCost: null,        // gp; null = no lower bound
    maxCost: null,        // gp; null = no upper bound
    profitableOnly: false,
    hideStale: false,
    hideLowVolume: false,
    favoritesOnly: false,
    activeCats: new Set(CATEGORIES),
  },
  // Per-recipe favorites (Set of recipe.key strings)
  favorites: new Set(JSON.parse(localStorage.getItem("osrs-combo-favorites") || "[]")),
  // Snapshot of previous margins so we can show a trend arrow on cards.
  // Keyed by recipe.key; cleared on full refresh after capture.
  lastMargin: {},
  // Active view mode: "cards" or "table"
  view: localStorage.getItem("osrs-combo-view") || "cards",
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
  r.appendChild(el("span", { class: "name", text: opts.label }));
  const valSpan = el("span", { class: "val", text: opts.value });
  if (opts.hint != null) {
    valSpan.appendChild(el("span", { class: "hint", text: ` ${opts.hint}` }));
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

function calcMargin(recipe) {
  const qty = recipe.resultQty || 1;
  const result = state.prices[recipe.id];
  const sellPricePerUnit = productSell(result);
  const sellTime = productSellTime(result);

  // Track oldest "trusted" timestamp across all prices used so we can flag
  // recipes where any leg of the calc is stale (not just the product side).
  let oldestTime = sellTime ?? null;

  let componentCost = 0;
  let allPresent = sellPricePerUnit !== null;
  for (const c of recipe.components) {
    const p = state.prices[c.id];
    const sp = supplyPrice(p);
    if (!sp) { allPresent = false; break; }
    componentCost += sp * c.qty;
    const t = supplyTime(p);
    if (t != null && (oldestTime == null || t < oldestTime)) oldestTime = t;
  }
  if (recipe.extraCost) componentCost += recipe.extraCost;
  const rc = repairCost(recipe.repairBase, state.smithing);
  const totalCost = componentCost + rc;

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

  return {
    sellPrice: sellPricePerUnit, sellTime, oldestTime,
    revenue, geTax: totalTax, geTaxPerUnit: taxPerUnit,
    componentCost, repairCost: rc, totalCost,
    margin, roi, allPresent,
    maxFlips, resultVol, compVols, resultQty: qty,
    compLimits, limitFlipsPer4h, limitFlipsPerDay,
  };
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
  container.title = "Click to isolate · Shift+click (or ⌘/Ctrl+click) to add tags · Click the active one again to restore all";
  container.replaceChildren();
  const refresh = () => {
    for (const c of container.children) {
      const cat = c.textContent;
      c.classList.toggle("active", state.filters.activeCats.has(cat));
    }
  };
  for (const cat of CATEGORIES) {
    const chip = el("span", {
      class: "cat-chip" + (state.filters.activeCats.has(cat) ? " active" : ""),
      text: cat,
    });
    chip.onclick = (e) => {
      const active = state.filters.activeCats;
      const fullState = active.size === CATEGORIES.length;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // Modifier-click = toggle this tag in/out of the current selection (multi-select)
        if (fullState) { active.clear(); active.add(cat); }     // first modifier-click narrows
        else if (active.has(cat)) active.delete(cat);
        else active.add(cat);
      } else {
        // Plain click = isolate this tag. If it's the only one, restore all.
        const onlyThis = active.size === 1 && active.has(cat);
        active.clear();
        if (onlyThis) for (const c of CATEGORIES) active.add(c);
        else active.add(cat);
      }
      // Auto-recovery: empty set restores all (so user can't get stuck)
      if (active.size === 0) for (const c of CATEGORIES) active.add(c);
      refresh();
      renderGrid();
    };
    container.appendChild(chip);
  }
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

  const stale = calc.oldestTime && (Date.now() / 1000 - calc.oldestTime) * 1000 > STALE_MS;
  const isHighRoi = calc.allPresent && calc.roi !== null && calc.roi >= HIGH_ROI_THRESHOLD;
  if (stale || isHighRoi) {
    const badges = el("div", { class: "card-badges" });
    if (isHighRoi) badges.appendChild(el("span", { class: "card-badge high-roi", text: "HIGH ROI" }));
    if (stale)     badges.appendChild(el("span", { class: "card-stale", text: "stale" }));
    card.appendChild(badges);
  }

  // Head
  const iconBox = el("div", { class: "card-icon" });
  const img = el("img", { attrs: { alt: "", loading: "lazy", src: recipeIcon(recipe) } });
  img.onerror = () => { img.style.display = "none"; };
  iconBox.appendChild(img);
  const titleBox = el("div", { class: "card-title" },
    el("div", { class: "card-name", text: recipe.name }),
    el("div", { class: "card-cat", text: recipe.cat }),
  );
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
      el("span", { class: "stat-label", text: "Flips/hr" }),
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
    el("span", { class: "stat-label", text: "Margin/day" }),
    dailyVal));
  // We still keep the unused mVal/rVal references quiet — they're not used in hero layout but built above to preserve neg/pos classes when re-used elsewhere.
  void mVal; void rVal;

  // Component breakdown
  const comp = el("div", { class: "components" });
  for (const c of recipe.components) {
    const m = state.mapping[c.id];
    const cName = (m?.name || `#${c.id}`) + (c.qty > 1 ? ` ×${c.qty}` : "");
    const p = state.prices[c.id];
    const bp = p?.high ?? null;
    const value = bp ? fmtGp(bp * c.qty) : "—";
    const vol = calc.compVols[c.id];
    const lim = calc.compLimits[c.id];
    const parts = [];
    if (vol != null) parts.push(`${fmtVol(perHour(vol))}/hr`);
    if (lim != null) parts.push(`lim ${lim.toLocaleString()}/4h`);
    const hint = parts.length ? "· " + parts.join(" · ") : null;
    row(comp, { label: cName, value, hint });
  }
  if (recipe.extraCost) row(comp, { label: "Runes/extras", value: fmtGp(recipe.extraCost) });
  if (recipe.repairBase) row(comp, { cls: "repair", label: `Repair @ ${state.smithing}`, value: fmtGp(calc.repairCost) });
  row(comp, { cls: "tax", label: "GE tax", value: `-${fmtGp(calc.geTax)}` });
  const qty = calc.resultQty;
  const sellLabel = state.productStrategy === "insta-sell"
    ? (qty > 1 ? `Insta-sell ×${qty}` : "Insta-sell")
    : (qty > 1 ? `List @ high ×${qty}` : "List @ high");
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

function applyFilters(items) {
  const f = state.filters;
  const q = f.search.toLowerCase().trim();
  const nowSec = Date.now() / 1000;
  const staleSec = STALE_MS / 1000;
  let out = items.filter(({ recipe, calc }) => {
    // OR logic: include if recipe has ANY of the active tags
    if (!recipe._tags.some(t => f.activeCats.has(t))) return false;
    if (q && !recipe.name.toLowerCase().includes(q)) return false;
    if (f.profitableOnly && !(calc.margin > 0)) return false;
    if (f.minCost !== null && calc.totalCost < f.minCost) return false;
    if (f.maxCost !== null && calc.totalCost > f.maxCost) return false;
    if (f.hideStale) {
      const isStale = calc.oldestTime && (nowSec - calc.oldestTime) > staleSec;
      if (isStale) return false;
    }
    if (f.hideLowVolume) {
      const productVolPerHr = perHour(calc.resultVol);
      if (productVolPerHr == null || productVolPerHr < 1) return false;
    }
    if (f.favoritesOnly && !state.favorites.has(recipe.key)) return false;
    return true;
  });
  const sortFns = {
    "margin-desc": (a, b) => (b.calc.margin ?? -Infinity) - (a.calc.margin ?? -Infinity),
    "roi-desc":    (a, b) => (b.calc.roi    ?? -Infinity) - (a.calc.roi    ?? -Infinity),
    "cost-asc":    (a, b) => (a.calc.totalCost ?? Infinity) - (b.calc.totalCost ?? Infinity),
    "cost-desc":   (a, b) => (b.calc.totalCost ?? -Infinity) - (a.calc.totalCost ?? -Infinity),
    "flips-desc":  (a, b) => (b.calc.maxFlips ?? -Infinity) - (a.calc.maxFlips ?? -Infinity),
    "daily-desc":  (a, b) => ((b.calc.margin ?? 0) * (b.calc.maxFlips ?? 0)) - ((a.calc.margin ?? 0) * (a.calc.maxFlips ?? 0)),
    "name":        (a, b) => a.recipe.name.localeCompare(b.recipe.name),
  };
  out.sort(sortFns[f.sort] || sortFns["margin-desc"]);
  return out;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  const tableWrap = document.getElementById("table-wrap");
  const items = RECIPES.map(r => ({ recipe: r, calc: calcMargin(r) }));
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
  { key: "name",     label: "Recipe",     get: x => x.recipe.name,            sortable: true },
  { key: "sell",     label: "Sell",       get: x => x.calc.sellPrice,         sortable: true, num: true, fmt: v => fmtGp(v) },
  { key: "cost",     label: "Cost",       get: x => x.calc.totalCost,         sortable: true, num: true, fmt: v => fmtGp(v) },
  { key: "margin",   label: "Margin",     get: x => x.calc.margin,            sortable: true, num: true, fmt: v => fmtGp(v) },
  { key: "roi",      label: "ROI",        get: x => x.calc.roi,               sortable: true, num: true, fmt: v => fmtPct(v) },
  { key: "flipsHr",  label: "Flips/hr",   get: x => perHour(x.calc.maxFlips), sortable: true, num: true, fmt: v => v == null ? "—" : fmtVol(v) },
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
  if (activeModalRecipe) loadModalChart(activeModalRecipe);
});

// Modal refresh button — invalidates the chart cache and re-fetches
document.getElementById("modal-refresh").addEventListener("click", async (e) => {
  if (!activeModalRecipe) return;
  e.currentTarget.classList.add("spinning");
  chartCache = { recipeKey: null, timeframe: null, byId: {} };
  await loadModalChart(activeModalRecipe);
  e.currentTarget.classList.remove("spinning");
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

function openModal(recipe) {
  activeModalRecipe = recipe;
  activeChartTab = "combined";  // default each open to the combined overlay
  modalTitle.textContent = recipe.name;
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
  loadModalChart(recipe);  // chart + stats render together via drawActiveTab
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

  const rows = [
    detailRow("Item", name + (qty > 1 ? ` (×${qty} in recipe)` : "")),
    detailRow("Insta-buy (high)",  high != null ? fmtGp(high) : "—", { cls: "v-high" }),
    detailRow("Insta-sell (low)",  low  != null ? fmtGp(low)  : "—", { cls: "v-low"  }),
    detailRow("Spread",            spread != null ? fmtGp(spread) : "—"),
    detailRow("Spread %",          spreadPct != null ? `${spreadPct.toFixed(2)}%` : "—"),
    detailRow(`Trend over ${activeTimeframe}`, trend != null ? `${trend >= 0 ? "+" : ""}${trend.toFixed(2)}%` : "—", { cls: trendClass }),
    detailRow("Volume (24h)",      vol != null ? `${vol.toLocaleString()} traded` : "—"),
    detailRow("GE buy limit (4h)", limit != null ? limit.toLocaleString() : "—"),
  ];
  // Cost contribution (component only)
  if (!isResult && high != null) {
    rows.push(detailRow("Contributes to total cost", fmtGp(high * qty), { cls: "v-supply" }));
  }
  modalDetail.replaceChildren(...rows);
}

function renderRecipeStats(recipe) {
  const calc = calcMargin(recipe);
  const q = calc.resultQty;
  const sellLbl = state.productStrategy === "insta-sell"
    ? (q > 1 ? `Insta-sell ${q} × ${fmtGp(calc.sellPrice)}` : "Insta-sell (low price)")
    : (q > 1 ? `List @ high ${q} × ${fmtGp(calc.sellPrice)}` : "List @ high (insta-buy price)");
  const supplyLbl = state.supplyStrategy === "slow-buy" ? "Supply cost (slow-buy, low)" : "Supply cost (insta-buy, high)";
  const sellSideClass = state.productStrategy === "insta-sell" ? "v-low" : "v-high";
  const marginClass = (calc.margin ?? 0) >= 0 ? "v-pos" : "v-neg";
  const roiClass    = (calc.roi    ?? 0) >= 0 ? "v-pos" : "v-neg";
  modalDetail.replaceChildren(
    detailRow(sellLbl, fmtGp(calc.revenue), { cls: sellSideClass }),
    detailRow(supplyLbl, fmtGp(calc.componentCost), { cls: "v-supply" }),
    ...(calc.repairCost ? [detailRow(`Repair @ ${state.smithing} smithing`, fmtGp(calc.repairCost), { cls: "v-gold" })] : []),
    detailRow("Total cost", fmtGp(calc.totalCost), { strong: true, cls: "v-cost" }),
    detailRow("GE tax (2% capped 5M)", `-${fmtGp(calc.geTax)}`, { cls: "v-neg" }),
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
  if (!chartGeom || !chartGeom.points.length) return;
  const rect = modalChart.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
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
  if (chartGeom && chartGeom.points) drawChart(chartGeom.points, { showCost: chartGeom.showCost });
});

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
  const padL = 70, padR = 16, padT = 14, padBetween = 10, padB = 28;
  const priceH = Math.round((h - padT - padBetween - padB) * 0.80);
  const volH   = (h - padT - padBetween - padB) - priceH;
  const priceTop = padT;
  const volTop   = priceTop + priceH + padBetween;

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
  const barW = Math.max(1.5, (w - padL - padR) / points.length - 0.5);
  points.forEach((p) => {
    const totalV = (p.highVol || 0) + (p.lowVol || 0);
    if (totalV <= 0) return;
    const x = xs(p.ts) - barW / 2;
    const totalH = totalV / vMax * (volH - 4);
    const highH  = (p.highVol || 0) / vMax * (volH - 4);
    const baseY  = volTop + volH;
    if (p.highVol) {
      ctx.fillStyle = "rgba(245, 158, 11, 0.7)";
      ctx.fillRect(x, baseY - highH, barW, highH);
    }
    if (p.lowVol) {
      ctx.fillStyle = "rgba(96, 165, 250, 0.7)";
      ctx.fillRect(x, baseY - totalH, barW, totalH - highH);
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

  // Stash geometry for hover code
  chartGeom = { points, xs, ys, vy, padL, padR, priceTop, priceH, volTop, volH, w, h, barW, showCost };
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

    const [prices, volumes] = await Promise.all([
      fetchLatest(),
      fetchVolumes().catch(e => { console.warn("Volumes failed:", e); return state.volumes; }),
    ]);
    state.prices = prices;
    state.volumes = volumes;
    state.lastFetched = Date.now();
    renderGrid();
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
  document.getElementById("hide-stale").addEventListener("change", (e) => {
    state.filters.hideStale = e.target.checked;
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
  document.getElementById("search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderGrid();
  });
  document.getElementById("sort").addEventListener("change", (e) => {
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
      const c = calcMargin(r);
      if (!c.allPresent) continue;
      if (!r._tags.some(t => f.activeCats.has(t))) continue;
      if (q && !r.name.toLowerCase().includes(q)) continue;
      if (f.profitableOnly && !(c.margin > 0)) continue;
      if (f.hideStale && c.oldestTime && (nowSec - c.oldestTime) > staleSec) continue;
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
