#!/usr/bin/env node
/* Scrape OSRS news posts from the official RuneScape RSS feed and emit
 * dist/news.json.
 *
 * The RSS feed returns the ~20 latest posts. That covers the last ~1–2
 * months of updates comfortably — enough for the Day/Week/Month chart
 * views to show all relevant news markers. For longer views (Year/All),
 * older markers will not appear until this script is run again with more
 * pages (pagination against the archive isn't wired up yet — see NOTE
 * below).
 *
 * Ideally rerun weekly. Zero deps (Node ≥ 18 native fetch; regex parser
 * for the well-structured RSS payload — no XML lib needed).
 *
 * Run: node scripts/scrape-news.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const RSS_URL = "https://secure.runescape.com/m=news/latest_news.rss?oldschool=1";

/* Regex-parse the RSS. RuneScape's feed has a very stable shape and no
 * escaped CDATA quirks — a full XML parser would be overkill here. Fields
 * we take: title, link, pubDate, category. Description is intentionally
 * dropped (long, HTML, and not needed for a marker tooltip). */
function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(re);
      if (!mm) return null;
      // Strip CDATA wrapper and trim
      return mm[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
    };
    const title = pick("title");
    const link  = pick("link");
    const date  = pick("pubDate");
    const cat   = pick("category");
    if (!title || !link || !date) continue;
    const ts = Date.parse(date);
    if (!isFinite(ts)) continue;
    items.push({
      ts,
      title,
      url: link,
      category: cat || "News",
    });
  }
  return items;
}

async function main() {
  console.log(`Fetching ${RSS_URL}`);
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent": "big-timbys-little-tool/0.1 (news marker scraper)",
      "Accept": "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseRss(xml);
  if (!items.length) {
    console.error("Parsed 0 items — RSS structure may have changed.");
    process.exit(1);
  }
  // Newest-first, dedup by URL (RSS shouldn't have dupes but defensive)
  items.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const deduped = items.filter(it => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  const outPath = path.resolve("dist/news.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    source: RSS_URL,
    count: deduped.length,
    posts: deduped,
  };
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${deduped.length} news posts → ${outPath}`);
  console.log(`Oldest: ${new Date(deduped[deduped.length - 1].ts).toISOString()}`);
  console.log(`Newest: ${new Date(deduped[0].ts).toISOString()}`);
  // NOTE: to add historical coverage past what the RSS holds, hit
  // https://secure.runescape.com/m=news/archive?oldschool=1&year=YYYY&month=MM
  // pages and parse the archive listing. Deferred until users ask for
  // markers on Year/All chart views.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
