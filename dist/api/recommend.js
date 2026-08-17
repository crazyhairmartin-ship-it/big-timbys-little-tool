// GET /api/recommend?id=<itemId>
//
// Returns Big Timby's per-item recommendation blob for the RuneLite plugin
// (and any other consumer). Fetches live wiki prices + 1h volume, computes
// spread- and volume-scored fill probability per side, then derives the
// recommended offer price using the same "bias-toward-mid by fill probability"
// formula the web app uses in the allocator's card render.
//
// This is a first-pass surface. Later extensions:
//   - Include overnight predictive target price when available
//   - Include contested-input adjustment when the item shows up in the
//     user's active allocator run
//   - Cache responses at the CDN edge (Vercel supports Cache-Control)
//
// Response shape kept flat + stable so the plugin's JSON decode is trivial.

const WIKI_BASE = "https://prices.runescape.wiki/api/v1/osrs";
const USER_AGENT = "big-timby-tool/0.1 (backend; https://big-timbys-little-tool.vercel.app)";

// Thresholds ported from dist/app.js — keep in sync when the web app retunes.
const FILL_SPREAD_NARROW = 0.05;
const FILL_SPREAD_WIDE = 0.15;
const FILL_MIN_FLOOR = 0.4;
const FILL_MARKET_SHARE_DEFAULT = 0.20;

export default async function handler(req, res) {
  // Permissive CORS — the plugin doesn't need it (Java HTTP client isn't
  // browser-gated), but useful for any browser-based caller (dashboards,
  // side tools) and cheap to include.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=120");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "method_not_allowed" }); return; }

  const idRaw = req.query?.id;
  const itemId = parseInt(Array.isArray(idRaw) ? idRaw[0] : idRaw, 10);
  if (!Number.isFinite(itemId) || itemId <= 0) {
    res.status(400).json({ error: "invalid_item_id" });
    return;
  }

  try {
    const [latest, hourly] = await Promise.all([
      wikiFetch(`/latest?id=${itemId}`),
      wikiFetch(`/1h?id=${itemId}`),
    ]);
    const market = latest?.data?.[itemId] ?? null;
    const volume = hourly?.data?.[itemId] ?? null;
    if (!market) { res.status(404).json({ error: "item_not_found", itemId }); return; }

    const body = buildRecommendation(itemId, market, volume);
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: "wiki_fetch_failed", message: String(e?.message || e) });
  }
}

function buildRecommendation(itemId, market, volume) {
  const high = intOrNull(market.high);
  const low  = intOrNull(market.low);
  const highTime = intOrNull(market.highTime);
  const lowTime  = intOrNull(market.lowTime);

  const buy  = high != null && low != null ? sideRecommendation(low, high, "low", volume)  : null;
  const sell = high != null && low != null ? sideRecommendation(low, high, "high", volume) : null;

  const spread = (high != null && low != null) ? Math.max(0, high - low) : null;
  const mid = (high != null && low != null) ? (high + low) / 2 : null;
  const spreadPct = (spread != null && mid > 0) ? spread / mid : null;

  return {
    itemId,
    market: { high, low, highTime, lowTime },
    spread,
    spreadPct: spreadPct != null ? +spreadPct.toFixed(4) : null,
    buy, sell,
    fetchedAt: new Date().toISOString(),
  };
}

function sideRecommendation(low, high, side, volume) {
  const spreadScore = scoreSpread(low, high);
  const volumeScore = scoreVolume(volume, side);
  const fillProbability = spreadScore * volumeScore;
  const mid = (low + high) / 2;
  const fp = clamp01(fillProbability);
  const price = side === "low"
    ? Math.round(low + (mid - low) * (1 - fp))
    : Math.round(high - (high - mid) * (1 - fp));
  return {
    price,
    fillProbability: +fp.toFixed(3),
    spreadScore: +spreadScore.toFixed(3),
    volumeScore: +volumeScore.toFixed(3),
  };
}

// Same shape as dist/app.js scoreSpread. Tight spread (≤5%) → 1.0. Wide
// (≥15%) → 0.4. Interpolated in between.
function scoreSpread(low, high) {
  if (low <= 0 || high <= 0) return FILL_MIN_FLOOR;
  const mid = (low + high) / 2;
  const pct = (high - low) / mid;
  if (pct <= FILL_SPREAD_NARROW) return 1.0;
  if (pct >= FILL_SPREAD_WIDE)   return FILL_MIN_FLOOR;
  const t = (pct - FILL_SPREAD_NARROW) / (FILL_SPREAD_WIDE - FILL_SPREAD_NARROW);
  return 1.0 - t * (1.0 - FILL_MIN_FLOOR);
}

// Volume score approximates "can the market absorb an order our size?"
// Server-side we don't know the user's target order count, so we score based
// on raw hourly side-volume: high volume → close to 1, thin volume → floors.
// The client-side allocator does a full scoreVolumeShare(availableCap, required,
// marketShare); this is the degraded version until we get the plugin passing
// desired quantity in the request.
function scoreVolume(volume, side) {
  if (!volume) return FILL_MIN_FLOOR;
  const sideVol = side === "low"
    ? intOrNull(volume.lowPriceVolume)
    : intOrNull(volume.highPriceVolume);
  if (sideVol == null) return FILL_MIN_FLOOR;
  const capturable = sideVol * FILL_MARKET_SHARE_DEFAULT;
  // Log-ish curve: below 1 order/hr worth of capturable → floor;
  // above ~20 → near 1.
  if (capturable <= 1) return FILL_MIN_FLOOR;
  if (capturable >= 20) return 1.0;
  return FILL_MIN_FLOOR + (1.0 - FILL_MIN_FLOOR) * ((capturable - 1) / 19);
}

async function wikiFetch(path) {
  const res = await fetch(`${WIKI_BASE}${path}`, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`wiki ${path} returned ${res.status}`);
  return await res.json();
}

function intOrNull(v) { return Number.isFinite(v) ? v : null; }
function clamp01(v)   { return Math.max(0, Math.min(1, v)); }
