#!/usr/bin/env node
/* Scrape smithable items from the OSRS wiki and emit dist/skilling-recipes.js.
 *
 * Data source: Template:Smithing/<Tier> bar pages (one per metal tier), each
 * full of {{SmithingTableRow|item=...|level=...|bars=N|qty=M|xp=Q|...}} rows.
 * Per-row XP defaults to (tier_xp_per_bar × bars) when xp= isn't explicit.
 *
 * Item IDs come from prices.runescape.wiki/api/v1/osrs/mapping; bar IDs are
 * hard-coded (small fixed set). Rows whose product name doesn't resolve to a
 * mapping ID get skipped with a warning.
 *
 * Run: node scripts/scrape-smithing.mjs
 */
import fs from "node:fs/promises";

const TIERS = [
  { tpl: "Smithing/Bronze bar",  barName: "Bronze",  barId: 2349, xpPerBar: 12.5 },
  { tpl: "Smithing/Iron bar",    barName: "Iron",    barId: 2351, xpPerBar: 25 },
  { tpl: "Smithing/Steel bar",   barName: "Steel",   barId: 2353, xpPerBar: 37.5 },
  { tpl: "Smithing/Mithril bar", barName: "Mithril", barId: 2359, xpPerBar: 50 },
  { tpl: "Smithing/Adamant bar", barName: "Adamant", barId: 2361, xpPerBar: 62.5 },
  { tpl: "Smithing/Runite bar",  barName: "Rune",    barId: 2363, xpPerBar: 75 },
  { tpl: "Smithing/Gold bar",    barName: "Gold",    barId: 2357, xpPerBar: 22.5 },
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

async function main() {
  const mapping = await fetchMapping();
  const nameToId = new Map();
  for (const item of mapping) nameToId.set(item.name.toLowerCase(), item.id);

  const recipes = [];
  const skipped = [];

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
      if (!itemId) { skipped.push(`${item} (no mapping id)`); continue; }
      const ticks = defaultTicksFor(item);
      recipes.push({
        key: `smith-${slugify(item)}`,
        id: itemId,
        name: item,
        cat: "Smithing",
        skill: "Smithing",
        subCat: subCatFor(item),
        level,
        xp,
        ticks,
        components: [{ id: tier.barId, qty: bars }],
        ...(qty !== 1 ? { resultQty: qty } : {}),
      });
    }
  }

  // Stable order: by skill level then name.
  recipes.sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));

  const banner =
    "// AUTO-GENERATED by scripts/scrape-smithing.mjs — do not hand-edit.\n" +
    `// Source: OSRS wiki Template:Smithing/<tier> bar pages. Generated ${new Date().toISOString()}.\n`;
  const body = "const SKILLING_RECIPES = " + JSON.stringify(recipes, null, 2) + ";\n";
  await fs.writeFile("dist/skilling-recipes.js", banner + body);

  console.log(`Wrote ${recipes.length} skilling recipes to dist/skilling-recipes.js`);
  if (skipped.length) console.warn(`Skipped ${skipped.length}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
