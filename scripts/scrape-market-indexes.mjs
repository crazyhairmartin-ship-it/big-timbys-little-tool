#!/usr/bin/env node
/* Scrape market-index basket compositions from the OSRS wiki and emit
 * dist/market-indexes.js.
 *
 * The wiki tracks 7 general Market indices as DJIA-style weighted averages:
 *   index_value = sum(item_price × 1 for each basket item) / divisor
 * We store the basket item ids + divisor per index. Live/historical index
 * values are computed at render time in the browser from state.prices and
 * /timeseries respectively.
 *
 * Hand-curated baskets (Raids, Potion, Bot/Farm, Blood Moon Rises,
 * Combines) don't exist as wiki-maintained indexes so we assign a divisor
 * equal to the item count (which starts the index at ~average-item-price,
 * arbitrary but consistent).
 *
 * Run: node scripts/scrape-market-indexes.mjs
 */
import fs from "node:fs/promises";

const WIKI_INDEXES = [
  { key: "market", name: "Market Index",  page: "RuneScape:Grand_Exchange_Market_Watch/Common_Trade_Index" },
  { key: "food",   name: "Food Index",    page: "RuneScape:Grand_Exchange_Market_Watch/Food_Index"          },
  { key: "log",    name: "Log Index",     page: "RuneScape:Grand_Exchange_Market_Watch/Log_Index"           },
  { key: "metal",  name: "Metal Index",   page: "RuneScape:Grand_Exchange_Market_Watch/Metal_Index"         },
  { key: "rune",   name: "Rune Index",    page: "RuneScape:Grand_Exchange_Market_Watch/Rune_Index"          },
  { key: "herb",   name: "Herb Index",    page: "RuneScape:Grand_Exchange_Market_Watch/Herb_Index"          },
];

/* ---------- Hand-curated baskets ----------
 * Indexes without a wiki equivalent. Assigned divisor = item count so the
 * starting value is roughly the average item price — arbitrary but
 * consistent across the tool.
 */
const CUSTOM_INDEXES = [
  {
    key: "cox",
    name: "CoX Index",
    description: "Unique drops from Chambers of Xeric",
    items: [
      "Twisted bow", "Kodai insignia", "Dragon claws", "Elder maul",
      "Dinh's bulwark", "Dragon hunter crossbow", "Twisted buckler",
      "Ancestral hat", "Ancestral robe top", "Ancestral robe bottom",
      "Dexterous prayer scroll", "Arcane prayer scroll", "Torn prayer scroll",
    ],
  },
  {
    key: "tob",
    name: "ToB Index",
    description: "Unique drops from Theatre of Blood",
    items: [
      "Scythe of vitur (uncharged)", "Ghrazi rapier", "Sanguinesti staff (uncharged)",
      "Justiciar faceguard", "Justiciar chestguard", "Justiciar legguards",
      "Avernic defender hilt",
    ],
  },
  {
    key: "toa",
    name: "ToA Index",
    description: "Unique drops from Tombs of Amascut",
    items: [
      "Tumeken's shadow (uncharged)", "Elidinis' ward", "Osmumten's fang",
      "Masori mask", "Masori body", "Masori chaps", "Lightbearer",
    ],
  },
  {
    key: "potion",
    name: "Potion Index",
    description: "Common 4-dose finished potions",
    items: [
      "Super combat potion(4)", "Super attack(4)", "Super strength(4)", "Super defence(4)",
      "Prayer potion(4)", "Saradomin brew(4)", "Super restore(4)", "Stamina potion(4)",
      "Anti-venom+(4)", "Ranging potion(4)", "Magic potion(4)",
      "Divine super combat potion(4)", "Divine ranging potion(4)", "Divine magic potion(4)",
      "Sanfew serum(4)", "Antifire potion(4)", "Extended antifire(4)",
    ],
  },
  {
    key: "botfarm",
    name: "Bot/Farm Index",
    description: "Items whose price is depressed by bot/farm supply flooding",
    items: [
      // Smelting bots (finished bars)
      "Steel bar", "Mithril bar", "Adamantite bar", "Runite bar",
      // Mining bots (ores + coal)
      "Iron ore", "Coal", "Adamantite ore", "Runite ore",
      // Runecraft bots (essence + finished runes)
      "Pure essence", "Rune essence",
      "Nature rune", "Law rune", "Death rune", "Cosmic rune",
      // Glassblowing / crafting supply
      "Air orb",
      // Fletching supply
      "Bow string", "Flax",
      // Cannonball smithing bots
      "Steel cannonball",
      // Dragon hide/scale bots
      "Blue dragonhide", "Red dragonhide", "Black dragonhide",
      "Green dragonhide", "Green dragon leather", "Blue dragon scale",
      // Bone bots
      "Big bones", "Dragon bones",
      // Fishing bots
      "Raw lobster", "Raw swordfish", "Raw monkfish", "Raw shark",
      // Woodcutting bots
      "Yew logs", "Magic logs", "Redwood logs",
      // Hunter bots
      "Chinchompa", "Red chinchompa",
      // Herblore secondary bots
      "White berries",
      // Chaos temple bots
      "Wine of zamorak",
    ],
  },
  {
    key: "bloodmoon",
    name: "Blood Moon Rises Index",
    description: "Newly-released items from the Blood Moon Rises quest",
    items: [
      "Necklace of rupture", "Amulet of rancour",
      "Etched elder venator fang", "Etched araxyte fang", "Venator fang",
      "Seeking bronze arrow", "Seeking iron arrow", "Seeking steel arrow",
      "Seeking mithril arrow", "Seeking adamant arrow", "Seeking rune arrow",
      "Seeking amethyst arrow", "Seeking dragon arrow",
    ],
  },
];

async function fetchWikitext(page) {
  const url = `https://oldschool.runescape.wiki/api.php?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext`;
  const res = await fetch(url, { headers: { "user-agent": "big-timbys-little-tool/market-index-scrape" } });
  const json = await res.json();
  return json?.parse?.wikitext?.["*"] || "";
}

async function fetchMapping() {
  const url = "https://prices.runescape.wiki/api/v1/osrs/mapping";
  const res = await fetch(url, { headers: { "user-agent": "big-timbys-little-tool/market-index-scrape" } });
  return res.json();
}

function parseWikiIndex(wikitext) {
  const items = [...wikitext.matchAll(/\{\{GEItem\|([^\|\}]+)/g)].map(m => m[1].trim());
  const divisorMatch = wikitext.match(/Index divisor[^:]*:\**\'*\s*([\d.]+)/);
  const divisor = divisorMatch ? parseFloat(divisorMatch[1]) : null;
  return { items, divisor };
}

function resolveItems(names, nameToId, indexKey, skipped) {
  const out = [];
  for (const name of names) {
    const id = nameToId.get(name.toLowerCase());
    if (id == null) { skipped.push(`${indexKey}: "${name}" (no mapping id)`); continue; }
    out.push({ id, name });
  }
  return out;
}

async function main() {
  const mapping = await fetchMapping();
  const nameToId = new Map();
  for (const item of mapping) nameToId.set(item.name.toLowerCase(), item.id);

  const skipped = [];
  const indexes = [];

  // Wiki indexes
  for (const idx of WIKI_INDEXES) {
    process.stderr.write(`Fetching ${idx.name}...\n`);
    const wt = await fetchWikitext(idx.page);
    const { items, divisor } = parseWikiIndex(wt);
    if (!items.length) { skipped.push(`${idx.key}: no items parsed`); continue; }
    if (!divisor) { skipped.push(`${idx.key}: no divisor parsed`); continue; }
    const resolved = resolveItems(items, nameToId, idx.key, skipped);
    indexes.push({
      key: idx.key,
      name: idx.name,
      source: "wiki",
      wikiPage: idx.page,
      divisor,
      items: resolved,
    });
  }

  // Custom indexes — divisor = item count (starting index ≈ average item price)
  for (const idx of CUSTOM_INDEXES) {
    const resolved = resolveItems(idx.items, nameToId, idx.key, skipped);
    if (!resolved.length) { skipped.push(`${idx.key}: no items resolved`); continue; }
    indexes.push({
      key: idx.key,
      name: idx.name,
      description: idx.description,
      source: "custom",
      divisor: resolved.length,
      items: resolved,
    });
  }

  const banner =
    "// AUTO-GENERATED by scripts/scrape-market-indexes.mjs — do not hand-edit.\n" +
    `// Sources: OSRS wiki Market Watch subpages + hand-curated custom baskets.\n` +
    `// Generated ${new Date().toISOString()}.\n`;
  const body = "const MARKET_INDEXES = " + JSON.stringify(indexes, null, 2) + ";\n";
  await fs.writeFile("dist/market-indexes.js", banner + body);

  const total = indexes.reduce((n, i) => n + i.items.length, 0);
  console.log(`Wrote ${indexes.length} market indexes (${total} basket items total)`);
  for (const idx of indexes) {
    console.log(`  ${idx.key.padEnd(11)} ${String(idx.items.length).padStart(3)} items · divisor ${idx.divisor}  ${idx.name}`);
  }
  if (skipped.length) {
    console.warn(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.warn(`  ${s}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
