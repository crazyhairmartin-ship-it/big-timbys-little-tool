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
async function scrapeCooking(nameToId, skipped) {
  const recipes = [];
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
      recipes.push({
        key: `cook-${slugify(outputName)}`,
        id: outputId, name: outputName,
        cat: "Cooking", skill: "Cooking",
        subCat,
        level, xp,
        actionsPerHourMax: 3000, // wiki standard for fish/meat cooking
        components: [{ id: inputId, qty: 1 }],
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

async function scrapeFletching(nameToId, skipped) {
  const recipes = [];
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
 * Coverage so far:
 *   - Gem cutting (Calculator:Crafting/Gem cutting): uncut gem -> cut gem.
 *
 * Full jewellery/leather/glass/battlestaves coverage is deferred -- those
 * pages use section-headers to switch implicit inputs (e.g. "Sapphire
 * jewellery" section binds Sapphire as a second input for every row), which
 * needs a different parser shape.
---------------------------------------------------------- */
const GEM_CUT_XP_TICKS = 3; // Cutting one gem is a 3-tick (1.8s) action.
async function scrapeCrafting(nameToId, skipped) {
  const recipes = [];
  const text = await fetchWikitext("Calculator:Crafting/Gem cutting");
  if (!text) return recipes;
  const m = text.match(/\{\|[^\n]*class="wikitable.*?\n((?:.+\n)+?)\|\}/s);
  if (!m) return recipes;
  const rows = m[1].split("|-").slice(1);
  for (const row of rows) {
    const cells = row.split(/\n\|/).map((s) => s.trim()).filter(Boolean);
    if (cells.length < 5) continue;
    const itemMatch = cells[0].match(/\{\{plink\|([^|}]+?)(?:\|[^}]*)?\}\}/);
    if (!itemMatch) continue;
    const itemName = itemMatch[1];
    const level = parseInt(cells[1], 10);
    if (!Number.isFinite(level)) continue;
    // Take the LAST numeric in the row -- XP (Cut) sits near the end and
    // higher-tier gems have N/A in the smashed-XP column, so "second numeric"
    // doesn't work universally.
    let xp = NaN;
    for (let i = 2; i < cells.length; i++) {
      const t = cells[i].replace(/,/g, "").trim();
      if (/^-?\d+(\.\d+)?$/.test(t)) xp = parseFloat(t);
    }
    if (!Number.isFinite(xp)) continue;
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
