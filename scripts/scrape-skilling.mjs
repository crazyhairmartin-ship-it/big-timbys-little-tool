#!/usr/bin/env node
/* Scrape skilling recipes from the OSRS wiki and emit dist/skilling-recipes.js.
 *
 * Currently covers: Smithing (smithable items + bar smelting + Blast Furnace),
 * Cooking (raw -> cooked from Calculator:Cooking/Fish). Each skill adds a
 * function `scrapeX()` that returns recipe objects; main() concatenates and
 * writes the result.
 *
 * Item IDs come from prices.runescape.wiki/api/v1/osrs/mapping.
 *
 * Run: node scripts/scrape-skilling.mjs
 */
import fs from "node:fs/promises";

const TIERS = [
  { tpl: "Smithing/Bronze bar",     barName: "Bronze",  barId: 2349, xpPerBar: 12.5 },
  { tpl: "Smithing/Iron bar",       barName: "Iron",    barId: 2351, xpPerBar: 25 },
  { tpl: "Smithing/Steel bar",      barName: "Steel",   barId: 2353, xpPerBar: 37.5 },
  { tpl: "Smithing/Mithril bar",    barName: "Mithril", barId: 2359, xpPerBar: 50 },
  { tpl: "Smithing/Adamantite bar", barName: "Adamant", barId: 2361, xpPerBar: 62.5 },
  { tpl: "Smithing/Runite bar",     barName: "Rune",    barId: 2363, xpPerBar: 75 },
  // Gold uses a different wiki format (only Helmet and Bowl, both quest-gated)
  // — hand-coded after the scraped tiers.
];

// Gold bar items aren't in the standard SmithingTableRow format on the wiki;
// they live in a plain wikitable. Both require quests and are obscure, but
// included for completeness.
const HARDCODED_GOLD = [
  { name: "Gold helmet", id: 6886, level: 50, xp: 30, bars: 3 },
  { name: "Gold bowl",   id: 6892, level: 50, xp: 30, bars: 2 },
];

// Ore item IDs (OSRS GE).
const ORE = {
  copper:    436,
  tin:       438,
  iron:      440,
  silver:    442,
  coal:      453,
  gold:      444,
  mithril:   447,
  adamantite:449,
  runite:    451,
};
const BAR = {
  bronze:  2349,
  iron:    2351,
  silver:  2355,
  steel:   2353,
  gold:    2357,
  mithril: 2359,
  adamant: 2361,
  rune:    2363,
};

// Smelting recipes. Regular furnace defaults to 5 ticks (3s per smelt loop).
// Blast Furnace uses half coal (steel and up) and is much faster — measured
// throughput from the wiki is used via actionsPerHourMax. Goldsmith gauntlets
// boost gold-bar XP from 22.5 to 56.2 (no speed change at a normal furnace,
// but ~8000 bars/hr at the Blast Furnace).
const HARDCODED_BARS = [
  // --- Regular furnace ---
  { name:"Bronze bar",                       id:BAR.bronze,  level:1,  xp:6.25,  ticks:5, comps:[{id:ORE.copper,qty:1},{id:ORE.tin,qty:1}],         tier:"Bronze"  },
  { name:"Iron bar",                         id:BAR.iron,    level:15, xp:12.5,  ticks:5, comps:[{id:ORE.iron,qty:1}],                              tier:"Iron"    },
  { name:"Silver bar",                       id:BAR.silver,  level:20, xp:13.67, ticks:5, comps:[{id:ORE.silver,qty:1}],                            tier:"Silver"  },
  { name:"Steel bar",                        id:BAR.steel,   level:30, xp:17.5,  ticks:5, comps:[{id:ORE.iron,qty:1},{id:ORE.coal,qty:2}],          tier:"Steel"   },
  { name:"Gold bar",                         id:BAR.gold,    level:40, xp:22.5,  ticks:5, comps:[{id:ORE.gold,qty:1}],                              tier:"Gold"    },
  { name:"Gold bar (Goldsmith gauntlets)",   id:BAR.gold,    level:40, xp:56.2,  ticks:5, comps:[{id:ORE.gold,qty:1}],                              tier:"Gold"    },
  { name:"Mithril bar",                      id:BAR.mithril, level:50, xp:30,    ticks:5, comps:[{id:ORE.mithril,qty:1},{id:ORE.coal,qty:4}],       tier:"Mithril" },
  { name:"Adamantite bar",                   id:BAR.adamant, level:70, xp:37.5,  ticks:5, comps:[{id:ORE.adamantite,qty:1},{id:ORE.coal,qty:6}],    tier:"Adamant" },
  { name:"Runite bar",                       id:BAR.rune,    level:85, xp:50,    ticks:5, comps:[{id:ORE.runite,qty:1},{id:ORE.coal,qty:8}],        tier:"Rune"    },
  // --- Blast Furnace (half coal; published throughput rates) ---
  { name:"Steel bar (Blast Furnace)",        id:BAR.steel,   level:30, xp:17.5,  comps:[{id:ORE.iron,qty:1},{id:ORE.coal,qty:1}],                   tier:"Steel",   actionsPerHourMax:7200 },
  { name:"Mithril bar (Blast Furnace)",      id:BAR.mithril, level:50, xp:30,    comps:[{id:ORE.mithril,qty:1},{id:ORE.coal,qty:2}],                tier:"Mithril", actionsPerHourMax:6500 },
  { name:"Adamantite bar (Blast Furnace)",   id:BAR.adamant, level:70, xp:37.5,  comps:[{id:ORE.adamantite,qty:1},{id:ORE.coal,qty:3}],             tier:"Adamant", actionsPerHourMax:6500 },
  { name:"Runite bar (Blast Furnace)",       id:BAR.rune,    level:85, xp:50,    comps:[{id:ORE.runite,qty:1},{id:ORE.coal,qty:4}],                 tier:"Rune",    actionsPerHourMax:5400 },
  { name:"Gold bar (Blast Furnace + Goldsmith gauntlets)", id:BAR.gold, level:40, xp:56.2, comps:[{id:ORE.gold,qty:1}],                              tier:"Gold",    actionsPerHourMax:8000 },
];

// Anvil smithing is 3 sec (5 ticks) by default. A few specific items take
// longer or shorter — the wiki documents these as exceptions. Match by item
// name (case-insensitive, partial).
function defaultTicksFor(itemName) {
  const n = itemName.toLowerCase();
  if (n.includes("cannonball")) return 10; // 6s per furnace action
  return 5;
}

// Group smithable items into a handful of sub-categories so the sidebar can
// offer "Armor / Weapons / Ammo / Utility" filtering within Smithing. The
// match order matters — earlier patterns win — because plate(skirt|legs|body)
// must beat a generic "skirt" match etc.
function subCatFor(itemName) {
  const n = itemName.toLowerCase();
  if (/(platebody|plateskirt|platelegs|chainbody|chain skirt|chainskirt|chaps|kiteshield|kite shield|sq shield|sq.shield|med helm|full helm|helm$|helmet)/.test(n)) return "Armor";
  if (/(dagger|sword|longsword|2h|two-handed|scimitar|mace|claws|battleaxe|warhammer|spear|hasta|halberd|pickaxe|axe$|knife|knives|hatchet)/.test(n)) return "Weapons";
  if (/(dart tip|arrowtip|arrow tip|javelin tip|bolts? \(unf\)|bolt tips|cannonball|nails|throwing|limbs)/.test(n)) return "Ammo";
  return "Utility";
}

async function fetchWikitext(page) {
  const url = `https://oldschool.runescape.wiki/api.php?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext`;
  const res = await fetch(url, { headers: { "user-agent": "big-timbys-little-tool/skilling-scrape" }});
  const json = await res.json();
  return json?.parse?.wikitext?.["*"] || "";
}

async function fetchMapping() {
  const url = "https://prices.runescape.wiki/api/v1/osrs/mapping";
  const res = await fetch(url, { headers: { "user-agent": "big-timbys-little-tool/skilling-scrape" }});
  return res.json();
}

// Parse a SmithingTableRow template invocation into { item, level, bars, qty, xp, ... }.
// Hand-rolled split-on-pipe-respecting-brace-depth — good enough for these rows.
function parseRow(rowText) {
  const inner = rowText.replace(/^\{\{SmithingTableRow\|/, "").replace(/\}\}$/, "");
  const parts = [];
  let depth = 0, buf = "";
  for (const c of inner) {
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    if (c === "|" && depth === 0) { parts.push(buf); buf = ""; }
    else buf += c;
  }
  parts.push(buf);
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq >= 0) params[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return params;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function scrapeSmithing(nameToId, skipped) {
  const recipes = [];
  for (const tier of TIERS) {
    const text = await fetchWikitext(`Template:${tier.tpl}`);
    const rows = text.match(/\{\{SmithingTableRow\|[^}]+(?:\}[^}]+)*\}\}/g) || [];
    for (const row of rows) {
      const params = parseRow(row);
      const item = params.item;
      if (!item) continue;
      const level = +params.level;
      const bars = +params.bars || 1;
      const qty = +params.qty || 1;
      const xp = params.xp != null ? +params.xp : tier.xpPerBar * bars;
      const itemId = nameToId.get(item.toLowerCase());
      if (!itemId) { skipped.push(`Smithing: ${item} (no mapping id)`); continue; }
      const ticks = defaultTicksFor(item);
      recipes.push({
        key: `smith-${slugify(item)}`,
        id: itemId,
        name: item,
        cat: "Smithing",
        skill: "Smithing",
        subCat: subCatFor(item),
        tier: tier.barName,
        level, xp, ticks,
        components: [{ id: tier.barId, qty: bars }],
        ...(qty !== 1 ? { resultQty: qty } : {}),
      });
    }
  }
  // Gold-bar items (different wiki format -- hand-coded).
  for (const g of HARDCODED_GOLD) {
    recipes.push({
      key: `smith-${slugify(g.name)}`,
      id: g.id, name: g.name,
      cat: "Smithing", skill: "Smithing", subCat: subCatFor(g.name), tier: "Gold",
      level: g.level, xp: g.xp, ticks: 5,
      components: [{ id: 2357, qty: g.bars }],
    });
  }
  // Bar smelting (regular + Blast Furnace + Goldsmith gauntlets).
  for (const b of HARDCODED_BARS) {
    recipes.push({
      key: `smelt-${slugify(b.name)}`,
      id: b.id, name: b.name,
      cat: "Smithing", skill: "Smithing", subCat: "Bars", tier: b.tier,
      level: b.level, xp: b.xp,
      ...(b.ticks != null ? { ticks: b.ticks } : {}),
      ...(b.actionsPerHourMax != null ? { actionsPerHourMax: b.actionsPerHourMax } : {}),
      components: b.comps,
    });
  }
  return recipes;
}

/* ---------------- Cooking ----------------
 * Source: Calculator:Cooking/Fish. Each row is 10 wikitable cells:
 *   level | {{plink|Raw X}} | GE price | {{plink|Cooked X}} | GE price |
 *   profit | profit-after-tax | xp | gp/xp | members
 * The wiki publishes XP/hr assuming 3000 actions/hour; we use the same as
 * `actionsPerHourMax` so the displayed GP/hr matches the wiki's tables.
---------------------------------------------------------- */
const COOKING_PAGES = [
  { page: "Calculator:Cooking/Fish",         subCat: "Fish" },
  { page: "Calculator:Cooking/Hunter meats", subCat: "Hunter meats" },
];

// Pie/Pizza Cooking XP isn't in the Calculator wikitable — hard-code by the
// cooked-pie name. Source: OSRS wiki individual pie/pizza pages.
const PIE_XP = {
  "Redberry pie":   78,
  "Meat pie":       110,
  "Mud pie":        128,
  "Apple pie":      130,
  "Garden pie":     138,
  "Fish pie":       164,
  "Botanical pie":  180,
  "Mushroom pie":   200,
  "Admiral pie":    210,
  "Wild pie":       240,
  "Summer pie":     260,
  "Dragonfruit pie":220,
};
const PIZZA_XP = {
  "Plain pizza":     143,
  "Meat pizza":      169,
  "Anchovy pizza":   182,
  "Pineapple pizza": 188,
};

// Gauntlets-affected fish hardcoded with their reduced burn-stop level on a
// regular range. (Wiki "Affected by cooking gauntlets" table; gauntlets
// "default" column.) Other fish either always burn at the gauntlets level or
// don't gain from gauntlets.
const GAUNTLETS_BURN_STOP = {
  "lobster":    64,
  "swordfish":  80,
  "monkfish":   86,
  "shark":      94, // shark always burns on fire/range without Hosidius+gauntlets
  "anglerfish": 97,
  "dark crab":  90,
  "karambwan":  null, // karambwan stops burning at 99 even with gauntlets? omit
};

// Scrape the OSRS wiki's master burn-level table at Cooking/Burn level.
// The page has multiple wikitables (Gauntlets-affected, Range-affected,
// Meats, Baked goods, etc.). Column counts vary, so we extract the first
// two numeric cells after each food's plinkt as { fire, range }. Gauntlets
// stop-burning level for the specific gauntlets-affected fish comes from
// the hardcoded map above.
async function scrapeBurnLevels() {
  const text = await fetchWikitext("Cooking/Burn level");
  const out = new Map();
  if (!text) return out;
  const tables = [...text.matchAll(/\{\|[^\n]*class="wikitable[^\n]*\n([\s\S]+?)\n\|\}/g)];
  for (const tbl of tables) {
    const rows = tbl[1].split("|-");
    for (const row of rows) {
      const cells = row.split(/\n\|/).map((s) => s.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      let itemName = null, itemIdx = -1;
      for (let i = 0; i < cells.length; i++) {
        const mm = cells[i].match(/\{\{plinkt\|([^|}]+?)(?:\|[^}]*)?\}\}/);
        if (mm) { itemName = mm[1]; itemIdx = i; break; }
      }
      if (!itemName) continue;
      const parseCell = (s) => {
        if (!s) return undefined; // marker: no data
        const t = s.trim();
        if (t === "-" || /^\s*-\s*$/.test(t)) return -1; // sentinel: always burns
        if (t.includes("{{NA}}")) return undefined;
        const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const nums = cells.slice(itemIdx + 1).map(parseCell);
      // The first two cells after Food are Fire and (Normal) Range. They may
      // be "-" (always burns -> -1), a number (stop level), or NA (undefined).
      const fire  = nums[0];
      const range = nums[1];
      const key = itemName.toLowerCase();
      if (!out.has(key)) {
        const rec = {};
        if (fire  !== undefined) rec.burnStopFire  = fire;
        if (range !== undefined) rec.burnStopRange = range;
        if (GAUNTLETS_BURN_STOP[key] !== undefined) rec.burnStopRangeGauntlets = GAUNTLETS_BURN_STOP[key];
        out.set(key, rec);
      }
    }
  }
  return out;
}

async function scrapeCookingPiesAndPizzas(nameToId, skipped) {
  const recipes = [];
  const pages = [
    { page: "Calculator:Cooking/Pies",  subCat: "Pies",   rawCellIdx: 6, xpMap: PIE_XP },
    { page: "Calculator:Cooking/Pizza", subCat: "Pizzas", rawCellIdx: 6, xpMap: PIZZA_XP },
  ];
  for (const { page, subCat, rawCellIdx, xpMap } of pages) {
    const text = await fetchWikitext(page);
    if (!text) continue;
    const m = text.match(/\{\|[^\n]*class="wikitable.*?\n((?:.+\n)+?)\|\}/s);
    if (!m) continue;
    const rows = m[1].split("|-").slice(1);
    for (const row of rows) {
      const cells = row.split(/\n\|/).map((s) => s.trim()).filter(Boolean);
      if (cells.length < rawCellIdx + 1) continue;
      const cookedMatch = cells[0].match(/\{\{plinkt?\|([^|}]+?)(?:\|[^}]*)?\}\}/);
      const rawMatch    = cells[rawCellIdx].match(/\{\{plinkp\|([^|}]+?)(?:\|[^}]*)?\}\}/);
      const level = parseInt(cells[1], 10);
      if (!cookedMatch || !rawMatch || !Number.isFinite(level)) continue;
      const cookedName = cookedMatch[1];
      const rawName    = rawMatch[1];
      const xp = xpMap[cookedName];
      if (xp == null) { skipped.push(`Cooking: no XP for ${cookedName}`); continue; }
      const cookedId = nameToId.get(cookedName.toLowerCase());
      const rawId    = nameToId.get(rawName.toLowerCase());
      if (!cookedId || !rawId) { skipped.push(`Cooking: ${cookedName} <- ${rawName} (no mapping id)`); continue; }
      recipes.push({
        key: `cook-${slugify(cookedName)}`,
        id: cookedId, name: cookedName,
        cat: "Cooking", skill: "Cooking", subCat,
        level, xp,
        actionsPerHourMax: 3000,
        components: [{ id: rawId, qty: 1 }],
      });
    }
  }
  return recipes;
}
async function scrapeCooking(nameToId, skipped) {
  const burnLevels = await scrapeBurnLevels();
  const recipes = [
    ...await scrapeCookingPiesAndPizzas(nameToId, skipped),
  ];
  for (const { page, subCat } of COOKING_PAGES) {
    const text = await fetchWikitext(page);
    const m = text.match(/\{\|[^\n]*class="wikitable.*?\n((?:.+\n)+?)\|\}/s);
    if (!m) continue;
    const body = m[1];
    const rows = body.split("|-").slice(1); // skip the header
    for (const row of rows) {
      const cells = row.split(/\n\|/).map((s) => s.trim()).filter(Boolean);
      if (cells.length < 6) continue;
      const level = parseInt(cells[0], 10);
      const inputMatch = cells[1]?.match(/\{\{plink\|([^|}]+?)(?:\|[^}]*)?\}\}/);
      const outputMatch = cells[3]?.match(/\{\{plink\|([^|}]+?)(?:\|[^}]*)?\}\}/);
      // XP column index varies by page (Fish has a profit-after-tax column,
      // Hunter meats doesn't). Find the first cell after the cooked item that
      // is a bare number.
      let xp = NaN;
      for (let i = 4; i < cells.length; i++) {
        const n = parseFloat(cells[i]);
        if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(cells[i].trim())) { xp = n; break; }
      }
      if (isNaN(level) || !inputMatch || !outputMatch || isNaN(xp)) continue;
      const inputName = inputMatch[1];
      const outputName = outputMatch[1];
      const inputId = nameToId.get(inputName.toLowerCase());
      const outputId = nameToId.get(outputName.toLowerCase());
      if (!inputId || !outputId) {
        skipped.push(`Cooking: ${inputName} -> ${outputName} (no mapping id)`);
        continue;
      }
      const burn = burnLevels.get(outputName.toLowerCase()) || {};
      recipes.push({
        key: `cook-${slugify(outputName)}`,
        id: outputId, name: outputName,
        cat: "Cooking", skill: "Cooking",
        subCat,
        level, xp,
        actionsPerHourMax: 3000,
        components: [{ id: inputId, qty: 1 }],
        ...("burnStopFire"           in burn ? { burnStopFire:           burn.burnStopFire } : {}),
        ...("burnStopRange"          in burn ? { burnStopRange:          burn.burnStopRange } : {}),
        ...("burnStopRangeGauntlets" in burn ? { burnStopRangeGauntlets: burn.burnStopRangeGauntlets } : {}),
      });
    }
  }
  return recipes;
}

/* ---------------- Fletching ----------------
 * Source: Template:Table/Fletching/<X> pages. Each row has columns:
 *   level | {{plinkt|Item|txt=...}} | {{plinkp|Mat1}}{{plinkp|Mat2}} |
 *   xp/item | xp/h | gp/material | profit/item | gp/xp
 *
 * The wiki publishes xp/h directly per row; actions/hr = xp/h ÷ xp/item.
 * Each "action" in our model produces ONE item (cleaner than batch-of-N math
 * for the user; the underlying 15-arrows-per-click cancels out cleanly).
---------------------------------------------------------- */
const FLETCHING_PAGES = [
  { tpl: "Table/Fletching/Arrows",            subCat: "Arrows" },
  { tpl: "Table/Fletching/Bolts",             subCat: "Bolts" },
  { tpl: "Table/Fletching/Bolt tips",         subCat: "Bolt tips" },
  { tpl: "Table/Fletching/Tipped bolts",      subCat: "Tipped bolts" },
  { tpl: "Table/Fletching/Tipped dragon bolts", subCat: "Tipped bolts" },
  { tpl: "Table/Fletching/Darts",             subCat: "Darts" },
  { tpl: "Table/Fletching/Javelins",          subCat: "Javelins" },
  { tpl: "Table/Fletching/Shields",           subCat: "Shields" },
  { tpl: "Table/Fletching/Crossbows",         subCat: "Crossbows" },
  { tpl: "Table/Fletching/Blowpipes",         subCat: "Blowpipes" },
  { tpl: "Table/Fletching/Ogre arrows",       subCat: "Arrows" },
  { tpl: "Table/Fletching/Mith grapple",      subCat: "Other" },
];

function findFirstNumeric(cells, startIdx) {
  for (let i = startIdx; i < cells.length; i++) {
    const t = cells[i].replace(/,/g, "").trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  }
  return NaN;
}

// Bows aren't in the Table/Fletching/* templates — they live on
// Calculator:Fletching/Weapons as `{{/Template1|Name|Level|XP|Log}}` (unstrung)
// and `{{/Template2|Name|Level|XP|Log}}` (stringing). Parse both as separate
// recipes; combined-craft (/Template3) is just T1+T2 and we'd double-count.
async function scrapeFletchingBows(nameToId, skipped) {
  const recipes = [];
  const text = await fetchWikitext("Calculator:Fletching/Weapons");
  if (!text) return recipes;
  const bowStringId = nameToId.get("bow string");
  for (const m of text.matchAll(/\{\{\/Template(1|2)\|([^}]+)\}\}/g)) {
    const which = m[1];
    const parts = m[2].split("|").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [bowBase, levelStr, xpStr, logName] = parts;
    const level = parseInt(levelStr, 10);
    const xp = parseFloat(xpStr);
    if (!Number.isFinite(level) || !Number.isFinite(xp)) continue;
    if (which === "1") {
      const outputName = `${bowBase} (u)`;
      const outputId = nameToId.get(outputName.toLowerCase());
      const logId = nameToId.get(logName.toLowerCase());
      if (!outputId || !logId) { skipped.push(`Fletching: ${outputName} (no mapping id)`); continue; }
      recipes.push({
        key: `fletch-${slugify(outputName)}`,
        id: outputId, name: outputName,
        cat: "Fletching", skill: "Fletching", subCat: "Bows (u)",
        level, xp, actionsPerHourMax: 1500,
        components: [{ id: logId, qty: 1 }],
      });
    } else if (which === "2") {
      const outputName = bowBase;
      const inputName = `${bowBase} (u)`;
      const outputId = nameToId.get(outputName.toLowerCase());
      const inputId = nameToId.get(inputName.toLowerCase());
      if (!outputId || !inputId || !bowStringId) { skipped.push(`Fletching: string ${outputName} (no mapping id)`); continue; }
      recipes.push({
        key: `fletch-string-${slugify(outputName)}`,
        id: outputId, name: `${outputName} (strung)`,
        cat: "Fletching", skill: "Fletching", subCat: "Bows (strung)",
        level, xp, actionsPerHourMax: 1500,
        components: [{ id: inputId, qty: 1 }, { id: bowStringId, qty: 1 }],
      });
    }
  }
  return recipes;
}

async function scrapeFletching(nameToId, skipped) {
  const recipes = [
    ...await scrapeFletchingBows(nameToId, skipped),
  ];
  for (const { tpl, subCat } of FLETCHING_PAGES) {
    const text = await fetchWikitext(`Template:${tpl}`);
    if (!text) continue;
    // Strip the table wrapper to leave just the rows
    const m = text.match(/\{\|[^\n]*?\n((?:.+\n)+?)\|\}/s);
    if (!m) continue;
    const rows = m[1].split("|-").slice(1);
    for (const row of rows) {
      const cells = row.split(/\n\|/).map((s) => s.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      // Strip <ref>...</ref> footnotes inline
      const clean = cells.map((c) => c.replace(/<ref[^>]*>.*?<\/ref>/gs, "").replace(/<ref[^>]*\/>/g, "").trim());
      const level = parseInt(clean[0], 10);
      if (!Number.isFinite(level)) continue;
      // The item cell sometimes appears in clean[1] but the plinkt may live
      // alongside other markup -- look in the first 3 cells for the first plinkt.
      let itemName = null;
      let itemCellIdx = -1;
      for (let i = 1; i < Math.min(clean.length, 4); i++) {
        const mm = clean[i].match(/\{\{plinkt\|([^|}]+?)(?:\|[^}]*)?\}\}/);
        if (mm) { itemName = mm[1]; itemCellIdx = i; break; }
      }
      if (!itemName) continue;
      // Materials: next cell after item is usually the plinkp list.
      const matCellIdx = itemCellIdx + 1;
      const matsRaw = clean[matCellIdx] || "";
      const matNames = [...matsRaw.matchAll(/\{\{plinkp\|([^|}]+?)(?:\|[^}]*)?\}\}/g)].map((mm) => mm[1]);
      if (matNames.length === 0) continue;
      // Find xp/item (first numeric after materials) and xp/h (next numeric).
      const xpIdx = matCellIdx + 1;
      let xp = NaN, xpHr = NaN;
      for (let i = xpIdx; i < clean.length; i++) {
        const t = clean[i].replace(/,/g, "").trim();
        if (/^\d+(\.\d+)?$/.test(t)) {
          if (isNaN(xp)) xp = parseFloat(t);
          else { xpHr = parseFloat(t); break; }
        }
      }
      if (!Number.isFinite(xp) || !Number.isFinite(xpHr) || xp <= 0) continue;

      const itemId = nameToId.get(itemName.toLowerCase());
      if (!itemId) { skipped.push(`Fletching: ${itemName} (no mapping id)`); continue; }
      const components = [];
      let materialOK = true;
      for (const m of matNames) {
        const id = nameToId.get(m.toLowerCase());
        if (!id) { materialOK = false; break; }
        components.push({ id, qty: 1 });
      }
      if (!materialOK) { skipped.push(`Fletching: ${itemName} (material id missing)`); continue; }

      recipes.push({
        key: `fletch-${slugify(itemName)}`,
        id: itemId, name: itemName,
        cat: "Fletching", skill: "Fletching", subCat,
        level, xp,
        actionsPerHourMax: Math.round(xpHr / xp),
        components,
      });
    }
  }
  return recipes;
}

/* ---------------- Herblore ----------------
 * Source: Calculator:Herblore/Potions. Rows use the template invocation
 *   {{/Template:Unfinished|PotionName|Level|XP|herb|secondary}}
 * where `herb` is the herb stem ("guam", "ranarr", etc.) -- the actual input
 * is "<Herb> potion (unf)". Output is "<PotionName>(3)" (3-dose tradeable).
 *
 * Wiki notes 2,400 potions/hr at optimal banking; we use that as
 * actionsPerHourMax.
---------------------------------------------------------- */
const HERB_TO_UNF = {
  guam:          "Guam potion (unf)",
  marrentill:    "Marrentill potion (unf)",
  tarromin:      "Tarromin potion (unf)",
  harralander:   "Harralander potion (unf)",
  ranarr:        "Ranarr potion (unf)",
  toadflax:      "Toadflax potion (unf)",
  irit:          "Irit potion (unf)",
  avantoe:       "Avantoe potion (unf)",
  kwuarm:        "Kwuarm potion (unf)",
  snapdragon:    "Snapdragon potion (unf)",
  cadantine:     "Cadantine potion (unf)",
  lantadyme:     "Lantadyme potion (unf)",
  dwarf:         "Dwarf weed potion (unf)",
  "dwarf weed":  "Dwarf weed potion (unf)",
  torstol:       "Torstol potion (unf)",
  huasca:        "Huasca potion (unf)",
};
function capWords(s) {
  return s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
async function scrapeHerblore(nameToId, skipped) {
  const recipes = [];
  const text = await fetchWikitext("Calculator:Herblore/Potions");
  if (!text) return recipes;
  // Pull all /Template:Unfinished invocations across the page.
  const rows = [...text.matchAll(/\{\{\/Template:Unfinished\|([^}]+)\}\}/g)];
  for (const m of rows) {
    const parts = m[1].split("|").map((s) => s.trim());
    if (parts.length < 5) continue;
    const [potionRaw, levelStr, xpStr, herbRaw, secondaryRaw] = parts;
    const level = parseInt(levelStr, 10);
    const xp = parseFloat(xpStr);
    if (!Number.isFinite(level) || !Number.isFinite(xp)) continue;
    const herb = herbRaw.toLowerCase().trim();
    const unfName = HERB_TO_UNF[herb] || (capWords(herb) + " potion (unf)");
    const secondaryName = capWords(secondaryRaw);
    // GE name for finished potions is "<Name>(3)".
    const potionName = potionRaw.trim();
    const finishedName = potionName + "(3)";
    const finishedId = nameToId.get(finishedName.toLowerCase()) ?? nameToId.get(potionName.toLowerCase());
    const unfId = nameToId.get(unfName.toLowerCase());
    const secondaryId = nameToId.get(secondaryName.toLowerCase());
    if (!finishedId) { skipped.push(`Herblore: ${finishedName} (no mapping id)`); continue; }
    if (!unfId)      { skipped.push(`Herblore: unf ${unfName} (no mapping id)`); continue; }
    if (!secondaryId){ skipped.push(`Herblore: secondary ${secondaryName} (no mapping id)`); continue; }
    recipes.push({
      key: `herb-${slugify(potionName)}`,
      id: finishedId,
      name: finishedName,
      cat: "Herblore", skill: "Herblore", subCat: "Potions",
      level, xp,
      actionsPerHourMax: 2400, // wiki: optimal banking ~2,400/hr
      components: [{ id: unfId, qty: 1 }, { id: secondaryId, qty: 1 }],
    });
  }
  return recipes;
}

/* ---------------- Crafting ----------------
 * Coverage:
 *   - Gem cutting (Calculator:Crafting/Gem cutting)
 *   - Jewellery (Calculator:Crafting/Jewellery): section-aware -- each
 *     ==Section== sets which bar + gem is the implicit input for the rows.
 *   - Glass blowing (Calculator:Crafting/Glass): molten glass -> glass items.
---------------------------------------------------------- */
const GEM_CUT_XP_TICKS = 3; // Cutting one gem is a 3-tick (1.8s) action.

// Section name -> bar + optional gem inputs for jewellery rows.
const JEWELLERY_SECTIONS = {
  "Gold jewellery":           { bar: "Gold bar",    gem: null },
  "Opal jewellery":           { bar: "Silver bar",  gem: "Opal" },
  "Jade jewellery":           { bar: "Silver bar",  gem: "Jade" },
  "Topaz jewellery":          { bar: "Silver bar",  gem: "Red topaz" },
  "Other silver jewellery":   { bar: "Silver bar",  gem: null },
  "Sapphire jewellery":       { bar: "Gold bar",    gem: "Sapphire" },
  "Emerald jewellery":        { bar: "Gold bar",    gem: "Emerald" },
  "Ruby jewellery":           { bar: "Gold bar",    gem: "Ruby" },
  "Diamond jewellery":        { bar: "Gold bar",    gem: "Diamond" },
  "Dragonstone jewellery":    { bar: "Gold bar",    gem: "Dragonstone" },
  "Onyx jewellery":           { bar: "Gold bar",    gem: "Onyx" },
  "Zenyte jewellery":         { bar: "Gold bar",    gem: "Zenyte" },
};
const JEWELLERY_TIER = {
  "Gold bar": "Gold", "Silver bar": "Silver",
  Sapphire: "Sapphire", Emerald: "Emerald", Ruby: "Ruby",
  Diamond: "Diamond", Dragonstone: "Dragonstone", Onyx: "Onyx", Zenyte: "Zenyte",
  Opal: "Opal", Jade: "Jade", "Red topaz": "Topaz",
};
// Extract item name, level, and XP from a Crafting-style wikitable row.
// Item name is the first {{plink|...}} or {{plinkt|...}}; level and XP are
// the first and last bare-numeric cells. Returns null if any are missing.
function parseCraftingRow(row) {
  const cells = row.split(/\n\|/).map((s) => s.trim()).filter(Boolean);
  if (cells.length < 4) return null;
  let itemName = null;
  for (const c of cells) {
    const mm = c.match(/\{\{plinkt?\|([^|}]+?)(?:\|[^}]*)?\}\}/);
    if (mm) { itemName = mm[1]; break; }
  }
  if (!itemName) return null;
  let level = NaN, xp = NaN;
  let bareNumerics = [];
  for (const c of cells) {
    const t = c.replace(/,/g, "").trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) bareNumerics.push(parseFloat(t));
  }
  if (bareNumerics.length < 2) return null;
  level = bareNumerics[0];
  xp = bareNumerics[bareNumerics.length - 1];
  if (!Number.isFinite(level) || !Number.isFinite(xp)) return null;
  return { itemName, level, xp };
}

async function scrapeGemCutting(nameToId, skipped) {
  const recipes = [];
  const text = await fetchWikitext("Calculator:Crafting/Gem cutting");
  if (!text) return recipes;
  const m = text.match(/\{\|[^\n]*class="wikitable.*?\n((?:.+\n)+?)\|\}/s);
  if (!m) return recipes;
  const rows = m[1].split("|-").slice(1);
  for (const row of rows) {
    const parsed = parseCraftingRow(row);
    if (!parsed) continue;
    const { itemName, level, xp } = parsed;
    const outputId = nameToId.get(itemName.toLowerCase());
    const inputId = nameToId.get(`uncut ${itemName.toLowerCase()}`);
    if (!outputId || !inputId) {
      skipped.push(`Crafting: cut ${itemName} (no mapping id)`);
      continue;
    }
    recipes.push({
      key: `craft-cut-${slugify(itemName)}`,
      id: outputId, name: itemName,
      cat: "Crafting", skill: "Crafting", subCat: "Gem cutting",
      level, xp, ticks: GEM_CUT_XP_TICKS,
      components: [{ id: inputId, qty: 1 }],
    });
  }
  return recipes;
}

async function scrapeJewellery(nameToId, skipped) {
  const recipes = [];
  const text = await fetchWikitext("Calculator:Crafting/Jewellery");
  if (!text) return recipes;
  // Split into sections at level-2 headings (==Section==).
  const sectionPattern = /^==\s*([^=]+?)\s*==\s*$/gm;
  const matches = [...text.matchAll(sectionPattern)];
  for (let i = 0; i < matches.length; i++) {
    const sectionName = matches[i][1];
    if (!(sectionName in JEWELLERY_SECTIONS)) continue; // skip Enchanted/etc.
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const sectionBody = text.slice(start, end);
    const tableMatch = sectionBody.match(/\{\|[^\n]*class="wikitable.*?\n((?:.+\n)+?)\|\}/s);
    if (!tableMatch) continue;
    const { bar, gem } = JEWELLERY_SECTIONS[sectionName];
    const barId = nameToId.get(bar.toLowerCase());
    const gemId = gem ? nameToId.get(gem.toLowerCase()) : null;
    if (!barId || (gem && !gemId)) {
      skipped.push(`Crafting: ${sectionName} (missing bar/gem id)`);
      continue;
    }
    const tier = gem ? JEWELLERY_TIER[gem] : JEWELLERY_TIER[bar];
    const rows = tableMatch[1].split("|-").slice(1);
    for (const row of rows) {
      const parsed = parseCraftingRow(row);
      if (!parsed) continue;
      const { itemName, level, xp } = parsed;
      const outputId = nameToId.get(itemName.toLowerCase());
      if (!outputId) { skipped.push(`Crafting: ${itemName} (no mapping id)`); continue; }
      const components = [{ id: barId, qty: 1 }];
      if (gemId) components.push({ id: gemId, qty: 1 });
      recipes.push({
        key: `craft-${slugify(itemName)}`,
        id: outputId, name: itemName,
        cat: "Crafting", skill: "Crafting", subCat: "Jewellery", tier,
        level, xp, ticks: 4, // ~2.4s per jewellery craft
        components,
      });
    }
  }
  return recipes;
}

async function scrapeGlass(nameToId, skipped) {
  const recipes = [];
  const text = await fetchWikitext("Calculator:Crafting/Glass");
  if (!text) return recipes;
  // Only the glass-blowing table (molten glass -> item). The page may also
  // describe sand+soda+lye for molten glass; ignore that for now.
  const m = text.match(/\{\|[^\n]*class="wikitable.*?\n((?:.+\n)+?)\|\}/s);
  if (!m) return recipes;
  const moltenGlassId = nameToId.get("molten glass");
  if (!moltenGlassId) return recipes;
  const rows = m[1].split("|-").slice(1);
  for (const row of rows) {
    const parsed = parseCraftingRow(row);
    if (!parsed) continue;
    const { itemName, level, xp } = parsed;
    const outputId = nameToId.get(itemName.toLowerCase());
    if (!outputId) { skipped.push(`Crafting: ${itemName} (no mapping id)`); continue; }
    recipes.push({
      key: `craft-${slugify(itemName)}`,
      id: outputId, name: itemName,
      cat: "Crafting", skill: "Crafting", subCat: "Glass",
      level, xp, ticks: 3,
      components: [{ id: moltenGlassId, qty: 1 }],
    });
  }
  return recipes;
}

// Hand-coded common methods that don't sit cleanly in a single wikitable.
// Battlestaves: attaching an elemental orb to a regular battlestaff. The
// Calculator:Crafting/Battlestaves page wraps the recipe rows in too much
// preamble for the generic parser; the recipes themselves are short.
const HARDCODED_BATTLESTAVES = [
  { name: "Water battlestaff", level: 54, xp: 100,   bs: "Battlestaff", orb: "Water orb" },
  { name: "Earth battlestaff", level: 58, xp: 112.5, bs: "Battlestaff", orb: "Earth orb" },
  { name: "Fire battlestaff",  level: 62, xp: 125,   bs: "Battlestaff", orb: "Fire orb" },
  { name: "Air battlestaff",   level: 66, xp: 137.5, bs: "Battlestaff", orb: "Air orb" },
];
// Dragonhide armor: assembled from tanned dragon leather at varying counts.
const HARDCODED_DHIDE = [
  { name: "Green d'hide vambraces", level: 57, xp: 62,    leather: "Green dragon leather",    qty: 1 },
  { name: "Green d'hide chaps",     level: 60, xp: 124,   leather: "Green dragon leather",    qty: 2 },
  { name: "Green d'hide body",      level: 63, xp: 186,   leather: "Green dragon leather",    qty: 3 },
  { name: "Blue d'hide vambraces",  level: 66, xp: 70,    leather: "Blue dragon leather",     qty: 1 },
  { name: "Blue d'hide chaps",      level: 68, xp: 140,   leather: "Blue dragon leather",     qty: 2 },
  { name: "Blue d'hide body",       level: 71, xp: 210,   leather: "Blue dragon leather",     qty: 3 },
  { name: "Red d'hide vambraces",   level: 73, xp: 78,    leather: "Red dragon leather",      qty: 1 },
  { name: "Red d'hide chaps",       level: 75, xp: 156,   leather: "Red dragon leather",      qty: 2 },
  { name: "Red d'hide body",        level: 77, xp: 234,   leather: "Red dragon leather",      qty: 3 },
  { name: "Black d'hide vambraces", level: 79, xp: 86,    leather: "Black dragon leather",    qty: 1 },
  { name: "Black d'hide chaps",     level: 82, xp: 172,   leather: "Black dragon leather",    qty: 2 },
  { name: "Black d'hide body",      level: 84, xp: 258,   leather: "Black dragon leather",    qty: 3 },
];

/* ---------------- Construction ----------------
 * Coverage: boat repair kits used by Sailing. Recipes are stable and small
 * (7 tiers), and the wiki keeps each one's Recipe template at <kit name>.
 * Hardcoded from those templates since one-off scraping per page would be
 * overkill.
---------------------------------------------------------- */
const REPAIR_KITS = [
  { name: "Repair kit",          tier: "Wooden",   level: 1,  xp: 43.5, plank: "Plank",          plankQty: 2, nails: "Bronze nails",     output: 2 },
  { name: "Oak repair kit",      tier: "Oak",      level: 19, xp: 90,   plank: "Oak plank",      plankQty: 2, nails: "Iron nails",       output: 2 },
  { name: "Teak repair kit",     tier: "Teak",     level: 30, xp: 135,  plank: "Teak plank",     plankQty: 2, nails: "Steel nails",      output: 2 },
  { name: "Mahogany repair kit", tier: "Mahogany", level: 47, xp: 210,  plank: "Mahogany plank", plankQty: 2, nails: "Mithril nails",    output: 2 },
  { name: "Camphor repair kit",  tier: "Camphor",  level: 66, xp: 255,  plank: "Camphor plank",  plankQty: 2, nails: "Adamantite nails", output: 2 },
  { name: "Ironwood repair kit", tier: "Ironwood", level: 80, xp: 300,  plank: "Ironwood plank", plankQty: 1, nails: "Rune nails",       output: 3 },
  { name: "Rosewood repair kit", tier: "Rosewood", level: 92, xp: 330,  plank: "Rosewood plank", plankQty: 1, nails: "Dragon nails",     output: 3 },
];
async function scrapeConstruction(nameToId, skipped) {
  const recipes = [];
  const pasteId = nameToId.get("swamp paste");
  for (const kit of REPAIR_KITS) {
    const productId = nameToId.get(kit.name.toLowerCase());
    const plankId = nameToId.get(kit.plank.toLowerCase());
    const nailsId = nameToId.get(kit.nails.toLowerCase());
    if (!productId || !plankId || !nailsId || !pasteId) {
      skipped.push(`Construction: ${kit.name} (missing item id)`);
      continue;
    }
    recipes.push({
      key: `cons-${slugify(kit.name)}`,
      id: productId, name: kit.name,
      cat: "Construction", skill: "Construction", subCat: "Repair kits",
      tier: kit.tier,
      level: kit.level, xp: kit.xp, ticks: 4,
      components: [
        { id: plankId, qty: kit.plankQty },
        { id: nailsId, qty: 10 },
        { id: pasteId, qty: 5 },
      ],
      resultQty: kit.output,
    });
  }
  return recipes;
}

/* ----------------------------------------------------------
 * Runecrafting.
 *
 * Each rune is one recipe. resultQty stays 1 — the live multiplier (1x–10x
 * based on level) is computed by applyRunecraftingModifiers in app.js using
 * `multiplierBreakpoints`. Daeyalt essence / Raiments of the Eye / binding
 * necklace are applied as runtime boosts in app.js, not baked here.
 *
 * Throughput (essences/hour) varies hugely by altar, pouch tier, transport
 * method, and player skill, so per-hour rates aren't modeled — the cards
 * show per-action margin and XP only. Hourly GP/XP would be misleading.
 *
 * Blood/Soul runes are crafted at the Arceuus altars from mined dense
 * essence — no GE input cost.
 *
 * Combination runes (Mist, Dust, Mud, Smoke, Steam, Lava) have a 50% base
 * success rate; a Binding necklace makes it 100%. The recipe lists the
 * inputs needed per *successful* craft; without a necklace, the modifier
 * doubles the pure-essence cost to account for the wasted essences. Aether
 * uses the same combo mechanic.
---------------------------------------------------------- */
const RUNES = [
  // Basic runes — pure essence in, 1+ rune out (scales with level).
  { name:"Air rune",    level:1,  xp:5,    mults:[1,11,22,33,44,55,66,77,88,99], ess:"pure", sub:"Elemental" },
  { name:"Mind rune",   level:2,  xp:5.5,  mults:[2,14,28,42,56,70,84,98],        ess:"pure", sub:"Catalytic" },
  { name:"Water rune",  level:5,  xp:6,    mults:[5,19,38,57,76,95],              ess:"pure", sub:"Elemental" },
  { name:"Earth rune",  level:9,  xp:6.5,  mults:[9,26,52,78],                    ess:"pure", sub:"Elemental" },
  { name:"Fire rune",   level:14, xp:7,    mults:[14,35,70],                      ess:"pure", sub:"Elemental" },
  { name:"Body rune",   level:20, xp:7.5,  mults:[20,46,92],                      ess:"pure", sub:"Catalytic" },
  { name:"Cosmic rune", level:27, xp:8,    mults:[27,59],                         ess:"pure", sub:"Catalytic" },
  { name:"Sunfire rune",level:33, xp:9,    mults:[33,49,98],                      ess:"pure", sub:"Elemental",
    supplies:[{name:"Fire rune",qty:1},{name:"Sunfire splinters",qty:1}] },
  { name:"Chaos rune",  level:35, xp:8.5,  mults:[35,74],                         ess:"pure", sub:"Catalytic" },
  { name:"Astral rune", level:40, xp:8.7,  mults:[40,82],                         ess:"pure", sub:"Catalytic" },
  { name:"Nature rune", level:44, xp:9,    mults:[44,91],                         ess:"pure", sub:"Catalytic" },
  { name:"Law rune",    level:54, xp:9.5,  mults:[54,95],                         ess:"pure", sub:"Catalytic" },
  { name:"Death rune",  level:65, xp:10,   mults:[65,99],                         ess:"pure", sub:"Catalytic" },
  { name:"Blood rune",  level:77, xp:23.8, mults:[77],                            ess:"dense", sub:"Dark"     },
  { name:"Soul rune",   level:90, xp:29.7, mults:[90],                            ess:"dense", sub:"Dark"     },
  { name:"Wrath rune",  level:95, xp:8,    mults:[95],                            ess:"pure", sub:"Catalytic" },
  // Combination runes — 50% success without binding necklace.
  { name:"Mist rune",   level:6,  xp:8,    mults:[6],  ess:"pure", sub:"Combination", combo:true, supplies:[{name:"Water rune",qty:1}] },
  { name:"Dust rune",   level:10, xp:8.3,  mults:[10], ess:"pure", sub:"Combination", combo:true, supplies:[{name:"Earth rune",qty:1}] },
  { name:"Mud rune",    level:13, xp:9.3,  mults:[13], ess:"pure", sub:"Combination", combo:true, supplies:[{name:"Earth rune",qty:1}] },
  { name:"Smoke rune",  level:15, xp:8.5,  mults:[15], ess:"pure", sub:"Combination", combo:true, supplies:[{name:"Fire rune",qty:1}]  },
  { name:"Steam rune",  level:19, xp:9.3,  mults:[19], ess:"pure", sub:"Combination", combo:true, supplies:[{name:"Fire rune",qty:1}]  },
  { name:"Lava rune",   level:23, xp:10,   mults:[23], ess:"pure", sub:"Combination", combo:true, supplies:[{name:"Fire rune",qty:1}]  },
  // Aether — combo-style (50% success, soul rune + catalyst as inputs).
  { name:"Aether rune", level:90, xp:20,   mults:[90], ess:"pure", sub:"Catalytic",  combo:true,
    supplies:[{name:"Soul rune",qty:1},{name:"Aether catalyst",qty:1}] },
];

async function scrapeRunecrafting(nameToId, skipped) {
  const pureId = nameToId.get("pure essence");
  if (!pureId) {
    skipped.push(`Runecrafting: pure essence id missing`);
    return [];
  }
  const recipes = [];
  for (const r of RUNES) {
    const runeId = nameToId.get(r.name.toLowerCase());
    if (!runeId) { skipped.push(`Runecrafting: ${r.name} (id missing)`); continue; }
    const isDense = r.ess === "dense";
    const displayName = isDense ? `${r.name} (Arceuus altar)` : r.name;

    // Look up extra supply ids; bail if any are missing rather than emit a
    // broken recipe that would silently miscalculate.
    let supplies;
    if (r.supplies) {
      supplies = [];
      let ok = true;
      for (const s of r.supplies) {
        const sid = nameToId.get(s.name.toLowerCase());
        if (!sid) { skipped.push(`Runecrafting: ${r.name} — supply '${s.name}' id missing`); ok = false; break; }
        supplies.push({ id: sid, qty: s.qty });
      }
      if (!ok) continue;
    }

    recipes.push({
      key: `rc-${slugify(r.name)}`,
      id: runeId, name: displayName,
      cat: "Runecrafting", skill: "Runecrafting", subCat: r.sub,
      level: r.level, xp: r.xp,
      // Dense-essence methods have no GE input — player mines their own.
      components: isDense ? [] : [{ id: pureId, qty: 1 }],
      supplies,
      resultQty: 1,
      multiplierBreakpoints: r.mults,
      essenceType: r.ess,
      combo: r.combo || undefined,
      // No actionsPerHourMax — Runecrafting throughput varies too much by
      // method/pouches/transport to model meaningfully.
    });
  }
  return recipes;
}

async function scrapeCrafting(nameToId, skipped) {
  const recipes = [
    ...await scrapeGemCutting(nameToId, skipped),
    ...await scrapeJewellery(nameToId, skipped),
    ...await scrapeGlass(nameToId, skipped),
  ];
  // Battlestaves
  for (const b of HARDCODED_BATTLESTAVES) {
    const outputId = nameToId.get(b.name.toLowerCase());
    const bsId = nameToId.get(b.bs.toLowerCase());
    const orbId = nameToId.get(b.orb.toLowerCase());
    if (!outputId || !bsId || !orbId) { skipped.push(`Crafting: ${b.name} (id missing)`); continue; }
    recipes.push({
      key: `craft-${slugify(b.name)}`,
      id: outputId, name: b.name,
      cat: "Crafting", skill: "Crafting", subCat: "Battlestaves",
      level: b.level, xp: b.xp, ticks: 3,
      components: [{ id: bsId, qty: 1 }, { id: orbId, qty: 1 }],
    });
  }
  // Dragonhide armor (assembled from tanned dragon leather)
  for (const d of HARDCODED_DHIDE) {
    const outputId = nameToId.get(d.name.toLowerCase());
    const leatherId = nameToId.get(d.leather.toLowerCase());
    if (!outputId || !leatherId) { skipped.push(`Crafting: ${d.name} (id missing)`); continue; }
    recipes.push({
      key: `craft-${slugify(d.name)}`,
      id: outputId, name: d.name,
      cat: "Crafting", skill: "Crafting", subCat: "Dragonhide", tier: d.leather.split(" ")[0],
      level: d.level, xp: d.xp, ticks: 3,
      components: [{ id: leatherId, qty: d.qty }],
    });
  }
  return recipes;
}

async function main() {
  const mapping = await fetchMapping();
  const nameToId = new Map();
  for (const item of mapping) nameToId.set(item.name.toLowerCase(), item.id);

  const skipped = [];
  const recipes = [
    ...await scrapeSmithing(nameToId, skipped),
    ...await scrapeCooking(nameToId, skipped),
    ...await scrapeFletching(nameToId, skipped),
    ...await scrapeHerblore(nameToId, skipped),
    ...await scrapeCrafting(nameToId, skipped),
    ...await scrapeConstruction(nameToId, skipped),
    ...await scrapeRunecrafting(nameToId, skipped),
  ];

  // Stable order: by skill, then level, then name.
  recipes.sort((a, b) =>
    a.skill.localeCompare(b.skill) ||
    (a.level - b.level) ||
    a.name.localeCompare(b.name)
  );

  const banner =
    "// AUTO-GENERATED by scripts/scrape-skilling.mjs — do not hand-edit.\n" +
    `// Sources: OSRS wiki Smithing tier templates, Calculator:Cooking/*. Generated ${new Date().toISOString()}.\n`;
  const body = "const SKILLING_RECIPES = " + JSON.stringify(recipes, null, 2) + ";\n";
  await fs.writeFile("dist/skilling-recipes.js", banner + body);

  const bySkill = recipes.reduce((acc, r) => { acc[r.skill] = (acc[r.skill] || 0) + 1; return acc; }, {});
  console.log(`Wrote ${recipes.length} skilling recipes (${Object.entries(bySkill).map(([k,v]) => `${k}: ${v}`).join(", ")})`);
  if (skipped.length) console.warn(`Skipped ${skipped.length}: ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? "…" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
