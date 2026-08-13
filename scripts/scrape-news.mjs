#!/usr/bin/env node
/* Scrape OSRS news posts and emit dist/news.json.
 *
 * Two data sources merged, deduped by canonical Jagex URL:
 *   1. Official RuneScape RSS (secure.runescape.com) — the ~20 latest posts
 *      including all categories (Community, Website, etc.). Best for
 *      recent + non-update posts.
 *   2. OSRS Wiki (oldschool.runescape.wiki) — MediaWiki API, generator=
 *      categorymembers over Category:YYYY_updates. Backfills the last
 *      365 days of updates (the ceiling of our price-timeseries data).
 *      Wiki has clean structured dates via the {{Update}} template.
 *
 * Rerun weekly (Wednesday evening / Thursday morning catches the freshest
 * Game Update — see memory: project-osrs-update-cadence).
 *
 * Zero deps (Node >= 18 native fetch, regex parsers).
 *
 * Run: node scripts/scrape-news.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const RSS_URL = "https://secure.runescape.com/m=news/latest_news.rss?oldschool=1";
const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const UA = "big-timbys-little-tool/0.1 (news marker scraper; crazyhairmartin@gmail.com)";
const BACKFILL_DAYS = 370;   // price data caps at 365d; small buffer for edge dates
const MS_PER_DAY = 86_400_000;

/* URL validation for scraped post links.
 *
 * The OSRS wiki is user-editable, so the {{Update|url=...}} template value
 * is untrusted input. Without this check a hostile wiki edit could inject a
 * javascript: URL that would fire when a user clicks the corresponding
 * news marker in the browser (window.open executes javascript: URIs in the
 * opener's context — noopener/noreferrer do NOT block that). The scraper
 * skips any post whose URL fails validation; the click handler in app.js
 * enforces the same allowlist as defense-in-depth.
 *
 * Allowlist: the two Jagex-controlled news domains + the wiki fallback.
 * If a legitimate future news domain shows up (unlikely), extend here.
 */
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

/* -------------- RSS parsing (existing behaviour) -------------- */
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
      return mm[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
    };
    const title = pick("title");
    const link  = pick("link");
    const date  = pick("pubDate");
    const cat   = pick("category");
    if (!title || !link || !date) continue;
    const ts = Date.parse(date);
    if (!isFinite(ts)) continue;
    if (!isSafeNewsUrl(link)) {
      console.warn(`[rss]  skip unsafe url: ${link}`);
      continue;
    }
    items.push({ ts, title, url: link, category: cat || "News", source: "rss" });
  }
  return items;
}

async function fetchRss() {
  console.log(`[rss]  ${RSS_URL}`);
  const res = await fetch(RSS_URL, {
    headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml" },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  const posts = parseRss(xml);
  console.log(`[rss]  ${posts.length} posts`);
  return posts;
}

/* -------------- Wiki backfill --------------
 * generator=categorymembers over Category:YYYY_updates fetches ~50 pages
 * per request with their wikitext. Regex the {{Update|date=..|url=..|
 * category=..}} template on each. Cargo isn't installed on this wiki so
 * one-shot Cargo query isn't an option (verified by the research agent).
 */
const WIKI_UPDATE_RE = /\{\{Update\s*\|([^}]*)\}\}/i;
const WIKI_DATE_RE   = /(?:^|\|)\s*date\s*=\s*([^|\n}]+)/i;
const WIKI_URL_RE    = /(?:^|\|)\s*url\s*=\s*([^|\n}]+)/i;
const WIKI_CAT_RE    = /(?:^|\|)\s*category\s*=\s*([a-zA-Z0-9_-]+)/i;

// "08 January 2025" (may be single-digit day). Manual parse — Date.parse is
// unreliable across Node versions for this format.
const MONTHS = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
function parseWikiDate(s) {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (mon == null) return null;
  return Date.UTC(year, mon, day);
}

async function fetchWikiCategory(categoryTitle) {
  const posts = [];
  let gcmcontinue = null;
  let calls = 0;
  do {
    const params = new URLSearchParams({
      action: "query",
      generator: "categorymembers",
      gcmtitle: categoryTitle,
      gcmlimit: "50",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      format: "json",
      formatversion: "2",
    });
    if (gcmcontinue) params.set("gcmcontinue", gcmcontinue);
    const url = `${WIKI_API}?${params.toString()}`;
    calls++;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Wiki fetch failed: HTTP ${res.status} for ${categoryTitle}`);
    const data = await res.json();
    const pages = data?.query?.pages || [];
    for (const p of pages) {
      const wt = p?.revisions?.[0]?.slots?.main?.content;
      if (!wt) continue;
      const upd = wt.match(WIKI_UPDATE_RE);
      if (!upd) continue;
      const body = upd[1];
      const dateM = body.match(WIKI_DATE_RE);
      if (!dateM) continue;
      const ts = parseWikiDate(dateM[1]);
      if (ts == null) continue;
      const urlM = body.match(WIKI_URL_RE);
      const catM = body.match(WIKI_CAT_RE);
      const title = String(p.title).replace(/^Update:/, "").trim();
      // Fallback is a wiki-hosted URL built from the (Jagex-side-untrusted
      // but wiki-namespaced) page title — the URL constructor path traversal
      // caveats don't apply because we encode the whole segment and then
      // validate via isSafeNewsUrl below.
      const wikiFallback = `https://oldschool.runescape.wiki/w/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`;
      const templateUrl = urlM ? urlM[1].trim() : null;
      // Prefer the template URL only if it passes validation; otherwise fall
      // back to the wiki page URL (which is always safe by construction).
      // See isSafeNewsUrl comment for why raw template values are untrusted.
      const canonicalUrl = (templateUrl && isSafeNewsUrl(templateUrl))
        ? templateUrl
        : wikiFallback;
      if (templateUrl && !isSafeNewsUrl(templateUrl)) {
        console.warn(`[wiki] ${p.title}: template url rejected (${templateUrl}) — using wiki fallback`);
      }
      posts.push({
        ts, title,
        url: canonicalUrl,
        category: mapWikiCategory(catM ? catM[1] : "game"),
        source: "wiki",
      });
    }
    gcmcontinue = data?.continue?.gcmcontinue || null;
  } while (gcmcontinue);
  console.log(`[wiki] ${categoryTitle}: ${posts.length} posts (${calls} API call${calls === 1 ? "" : "s"})`);
  return posts;
}

// Wiki template categories → the same category vocabulary RSS uses. Keeps
// downstream (news markers on charts) colour-coding consistent.
function mapWikiCategory(wikiCat) {
  const c = String(wikiCat).toLowerCase();
  if (c === "game")           return "Game Updates";
  if (c === "technical")      return "Website";
  if (c === "future" || c === "bts" || c === "devblog") return "Behind the Scenes";
  if (c === "competitions" || c === "events" || c === "community") return "Community";
  return "News";
}

async function fetchWikiBackfill() {
  // Cover the last BACKFILL_DAYS. Fetch each year's category that overlaps
  // the window — typically today's year + previous year.
  const nowY = new Date().getUTCFullYear();
  const oldestTs = Date.now() - BACKFILL_DAYS * MS_PER_DAY;
  const oldestY = new Date(oldestTs).getUTCFullYear();
  const years = [];
  for (let y = oldestY; y <= nowY; y++) years.push(y);
  const all = [];
  for (const y of years) {
    const cat = `Category:${y}_updates`;
    try {
      const posts = await fetchWikiCategory(cat);
      all.push(...posts);
    } catch (e) {
      console.warn(`[wiki] ${cat} failed: ${e.message}`);
    }
  }
  // Trim to the 365d+buffer window
  const filtered = all.filter(p => p.ts >= oldestTs);
  console.log(`[wiki] total after ${BACKFILL_DAYS}d filter: ${filtered.length} posts`);
  return filtered;
}

/* -------------- Merge + dedup -------------- */
function dedupPosts(posts) {
  // Same underlying post can appear in both RSS and wiki. The Jagex
  // secure.runescape.com URL is the strongest identity key — both sources
  // include it (RSS as <link>, wiki via the {{Update|url=...}} field).
  // Fall back to title-lowercased when URL is wiki-only.
  const seen = new Map();
  for (const p of posts) {
    const key = p.url.startsWith("https://secure.runescape.com/")
      ? p.url.split("?")[0]              // strip trailing ?oldschool=1 for consistency
      : `title:${p.title.toLowerCase()}`;
    const prior = seen.get(key);
    if (!prior) { seen.set(key, p); continue; }
    // Keep the entry with the better URL (Jagex over wiki), otherwise keep RSS
    // over wiki (RSS titles preserve casing / dashes exactly as Jagex writes).
    const jagex = (x) => x.url.startsWith("https://secure.runescape.com/");
    if (jagex(p) && !jagex(prior)) seen.set(key, p);
    else if (p.source === "rss" && prior.source === "wiki") seen.set(key, p);
  }
  return Array.from(seen.values());
}

/* -------------- Main -------------- */
async function main() {
  const [rss, wiki] = await Promise.all([
    fetchRss().catch(e => { console.warn(`[rss]  ${e.message}`); return []; }),
    fetchWikiBackfill().catch(e => { console.warn(`[wiki] ${e.message}`); return []; }),
  ]);
  const merged = dedupPosts([...rss, ...wiki]);
  merged.sort((a, b) => b.ts - a.ts);
  if (!merged.length) {
    console.error("Zero posts scraped — both sources failed or returned nothing.");
    process.exit(1);
  }

  const outPath = path.resolve("dist/news.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    sources: [RSS_URL, WIKI_API],
    backfillDays: BACKFILL_DAYS,
    count: merged.length,
    posts: merged.map(({ source, ...rest }) => rest),   // drop the internal source tag
  };
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${merged.length} posts → ${outPath}`);
  console.log(`Oldest: ${new Date(merged[merged.length - 1].ts).toISOString()}`);
  console.log(`Newest: ${new Date(merged[0].ts).toISOString()}`);
  // Category histogram — useful for confirming coverage after a big backfill
  const byCat = {};
  for (const p of merged) byCat[p.category] = (byCat[p.category] || 0) + 1;
  console.log("By category:", Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
