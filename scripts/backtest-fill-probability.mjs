#!/usr/bin/env node
/*
 * Backtest the allocator's fill-probability score against historical fills.
 *
 * For each item, we walk /timeseries at 1h step. At each historical hour T
 * (with 24h of lookback + horizon hours of lookahead), we replay the exact
 * scoreSpread / scoreCoherence / scoreVolumeShare formulas from app.js
 * using ONLY the data available at that time. Then we compute the actual
 * next-H-hours outcome: how much side-volume traded in the window vs how
 * much a hypothetical order would have needed to fill.
 *
 * Result: buckets predicted probability into ranges [0-0.4, 0.4-0.6,
 * 0.6-0.8, 0.8-1.0] and reports the mean actual fill rate per bucket.
 * If the score predicts reality, the mean fill rate should climb
 * monotonically across the buckets. If it's flat, the score is noise.
 *
 * Bonus: Spearman-style rank correlation between score and outcome, per
 * item and overall.
 *
 * Usage:
 *   node scripts/backtest-fill-probability.mjs [--horizon=4] [--share=0.30]
 */

const WIKI_API = "https://prices.runescape.wiki/api/v1/osrs";
const UA = "big-timbys-little-tool/0.1 (fill-probability backtest)";

// Representative sample — a mix of high-liquidity flips and thinner
// combine components that typically show up in Allocate recommendations.
// Fifteen items × ~300 hourly points ≈ 4,500 data points, enough for
// stable bucket means.
const BACKTEST_ITEMS = [
  // Top-tier products
  { name: "Amulet of rancour",          id: 30693 },
  { name: "Dragon hunter lance",         id: 22978 },
  { name: "Amulet of torture",           id: 19553 },
  { name: "Kodai wand",                  id: 21006 },
  { name: "Ancestral robe top",          id: 21018 },
  // Common recipe components
  { name: "Godsword blade",              id: 11798 },
  { name: "Godsword shard 1",            id: 11818 },
  { name: "Godsword shard 2",            id: 11820 },
  { name: "Godsword shard 3",            id: 11822 },
  { name: "Zamorakian hasta",            id: 11889 },
  { name: "Zamorakian spear",            id: 11824 },
  { name: "Blessed spirit shield",       id: 12831 },
  { name: "Arcane sigil",                id: 12825 },
  // Bulk / raw
  { name: "Adamantite bar",              id: 2361  },
  { name: "Nature rune",                 id: 561   },
];

// Thresholds — mirror app.js FILL_* constants exactly. Any adjustment
// suggestion at the end compares against these.
const T = {
  SPREAD_NARROW: 0.05,
  SPREAD_WIDE: 0.15,
  COHERENCE_TIGHT: 1.5,
  COHERENCE_LOOSE: 5.0,
  MIN_FLOOR: 0.4,
};

/* -------- CLI args -------- */
const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v === undefined ? "true" : v])
);
const HORIZON = parseInt(args.horizon || "4", 10);
const MARKET_SHARE = parseFloat(args.share || "0.30");
const REQUIRED_FRACTION = parseFloat(args.required || "0.25");  // required count = this × 24h side vol

/* -------- Fetch layer -------- */
async function fetchTimeseries(id, step = "1h") {
  const url = `${WIKI_API}/timeseries?id=${id}&timestep=${step}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  return data.data || [];
}

/* -------- Fill-probability math (mirrored from app.js) -------- */
function scoreSpread(hi, lo) {
  if (hi == null || lo == null || hi <= 0) return 1;
  const mid = (hi + lo) / 2;
  const spread = (hi - lo) / (mid || 1);
  if (spread <= T.SPREAD_NARROW) return 1;
  if (spread >= T.SPREAD_WIDE) return T.MIN_FLOOR;
  const t = (spread - T.SPREAD_NARROW) / (T.SPREAD_WIDE - T.SPREAD_NARROW);
  return 1 - t * (1 - T.MIN_FLOOR);
}
function scoreCoherence(v1h, v24h) {
  // Backtest only has 1h buckets from the timeseries; no 5m data
  // available. We derive v24h as the sum of the last 24 1h buckets and
  // v1h as the current bucket, then compare their DAILY projections.
  const candidates = [];
  if (v1h != null && v1h > 0) candidates.push(v1h * 24);
  if (v24h != null && v24h > 0) candidates.push(v24h);
  if (candidates.length < 2) return 1;
  const ratio = Math.max(...candidates) / Math.min(...candidates);
  if (ratio <= T.COHERENCE_TIGHT) return 1;
  if (ratio >= T.COHERENCE_LOOSE) return T.MIN_FLOOR;
  const t = (ratio - T.COHERENCE_TIGHT) / (T.COHERENCE_LOOSE - T.COHERENCE_TIGHT);
  return 1 - t * (1 - T.MIN_FLOOR);
}
function scoreVolumeShare(available, required, share) {
  if (available == null || available <= 0) return T.MIN_FLOOR;
  const capturable = available * share;
  if (required <= capturable) return 1;
  return Math.max(T.MIN_FLOOR, capturable / required);
}
function computeFillProbability(spread, v1h, v24h, availableCap, required, share) {
  const spr = scoreSpread(spread.hi, spread.lo);
  const coh = scoreCoherence(v1h, v24h);
  const vol = scoreVolumeShare(availableCap, required, share);
  return spr * coh * vol;
}

/* -------- Backtest driver -------- */
function replayItem(name, series, horizon, marketShare, requiredFrac) {
  const points = [];
  const N = series.length;
  const LOOKBACK = 24;
  const LOOKAHEAD = horizon;
  if (N < LOOKBACK + LOOKAHEAD + 5) return points;   // too short to be useful

  for (let i = LOOKBACK; i < N - LOOKAHEAD; i++) {
    const p = series[i];
    if (p.avgHighPrice == null || p.avgLowPrice == null) continue;
    // Reconstruct the "known-at-time-T" state we'd have seen live.
    // v1h = this hour's low-side volume (backing "slow-buy" = we accept
    // the low side to buy). Product-side would use highPriceVolume; for
    // simplicity we test both perspectives together, low-side dominant.
    const v1hLow = p.lowPriceVolume ?? 0;
    // v24h = sum of the last 24 hours' low-side volume, as a fresh
    // aggregate at time T (mirrors state.avg24h.lowVol semantics).
    let v24hLow = 0;
    for (let j = i - LOOKBACK; j < i; j++) v24hLow += series[j].lowPriceVolume ?? 0;

    // Required count: proportional to daily side volume so items with
    // different liquidity get comparable difficulty.
    const required = Math.max(1, Math.round(v24hLow * requiredFrac));

    // For the volume-share score we use the horizon-scaled ceiling —
    // sideVolumeAtHorizon for horizon ≤ 4h picks the 1h-projected value.
    // Here we use the same: max(v1h × horizon, v24h × horizon/24), no
    // Wilson shrink (backtest wants raw signal correlation).
    const availableAtHorizon = Math.max(
      v1hLow * horizon,
      v24hLow * horizon / 24,
    );

    const spread = { hi: p.avgHighPrice, lo: p.avgLowPrice };
    const fp = computeFillProbability(spread, v1hLow, v24hLow, availableAtHorizon, required, marketShare);

    // ACTUAL outcome: how much low-side volume traded in the next H hours?
    let actualVol = 0;
    for (let j = i + 1; j <= i + LOOKAHEAD; j++) {
      actualVol += series[j].lowPriceVolume ?? 0;
    }
    // Fill rate = min(1, capturable / required) where capturable = actualVol × share
    const capturable = actualVol * marketShare;
    const fillRate = required > 0 ? Math.min(1, capturable / required) : 1;

    points.push({ hour: i, fillProbability: fp, actualFillRate: fillRate, required, actualVol });
  }
  return points;
}

/* -------- Reporting -------- */
function bucketize(points, bounds) {
  const buckets = bounds.map((_, i) => ({
    label: i === 0 ? `<${bounds[i]}` : i === bounds.length ? `≥${bounds[bounds.length - 1]}` : `${bounds[i - 1]}..${bounds[i]}`,
    lo: i === 0 ? 0 : bounds[i - 1],
    hi: i === bounds.length ? 1.01 : bounds[i],
    points: [],
  }));
  buckets.push({ label: `≥${bounds[bounds.length - 1]}`, lo: bounds[bounds.length - 1], hi: 1.01, points: [] });
  for (const p of points) {
    for (const b of buckets) {
      if (p.fillProbability >= b.lo && p.fillProbability < b.hi) { b.points.push(p); break; }
    }
  }
  return buckets.map(b => ({
    bucket: b.label,
    n: b.points.length,
    meanPredicted: b.points.length ? mean(b.points.map(p => p.fillProbability)) : null,
    meanActualFill: b.points.length ? mean(b.points.map(p => p.actualFillRate)) : null,
  }));
}
function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function spearman(points) {
  // Rank both series, correlate ranks
  if (points.length < 2) return null;
  const rank = arr => {
    const indexed = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(arr.length);
    for (let i = 0; i < indexed.length; i++) ranks[indexed[i][1]] = i + 1;
    return ranks;
  };
  const xs = points.map(p => p.fillProbability);
  const ys = points.map(p => p.actualFillRate);
  const rx = rank(xs), ry = rank(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/* -------- Main -------- */
async function main() {
  console.log(`Backtest config: horizon=${HORIZON}h, marketShare=${MARKET_SHARE}, requiredFrac=${REQUIRED_FRACTION}`);
  console.log(`Fetching ${BACKTEST_ITEMS.length} items...\n`);
  const perItem = [];
  const allPoints = [];
  for (const item of BACKTEST_ITEMS) {
    try {
      const series = await fetchTimeseries(item.id, "1h");
      if (!series.length) { console.log(`  ${item.name}: no data`); continue; }
      const points = replayItem(item.name, series, HORIZON, MARKET_SHARE, REQUIRED_FRACTION);
      if (!points.length) { console.log(`  ${item.name}: series too short`); continue; }
      const rho = spearman(points);
      perItem.push({ name: item.name, n: points.length, spearman: rho });
      allPoints.push(...points);
      console.log(`  ${item.name.padEnd(30)}  n=${String(points.length).padStart(4)}  ρ=${(rho ?? 0).toFixed(3)}`);
    } catch (e) {
      console.log(`  ${item.name}: FETCH FAILED (${e.message})`);
    }
  }

  console.log(`\n=== Overall (n=${allPoints.length}) ===`);
  const overallRho = spearman(allPoints);
  console.log(`Spearman rank correlation (score vs actual fill rate): ρ = ${(overallRho ?? 0).toFixed(4)}`);
  console.log(`  (0 = no relationship, 1 = perfect positive, -1 = perfect negative)`);
  console.log();

  console.log("Bucket table — mean actual fill rate vs predicted probability:");
  const table = bucketize(allPoints, [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  console.log(
    "Bucket".padEnd(12) +
    "Sample".padStart(10) +
    "Mean pred".padStart(14) +
    "Mean actual".padStart(15) +
    "  Delta"
  );
  for (const b of table) {
    if (!b.n) continue;
    const delta = (b.meanActualFill ?? 0) - (b.meanPredicted ?? 0);
    console.log(
      b.bucket.padEnd(12) +
      String(b.n).padStart(10) +
      (b.meanPredicted ?? 0).toFixed(3).padStart(14) +
      (b.meanActualFill ?? 0).toFixed(3).padStart(15) +
      "  " + (delta >= 0 ? "+" : "") + delta.toFixed(3)
    );
  }

  console.log("\n=== Interpretation ===");
  if (overallRho == null) {
    console.log("Not enough data for meaningful correlation.");
    return;
  }
  if (overallRho > 0.3) console.log(`STRONG signal (ρ=${overallRho.toFixed(3)}): the score meaningfully predicts fill rate.`);
  else if (overallRho > 0.1) console.log(`MODEST signal (ρ=${overallRho.toFixed(3)}): score helps, but there's noise.`);
  else if (overallRho > -0.1) console.log(`WEAK/NO signal (ρ=${overallRho.toFixed(3)}): the score is barely better than random.`);
  else console.log(`INVERTED signal (ρ=${overallRho.toFixed(3)}): the score is systematically wrong — thresholds need to invert somewhere.`);

  // Check bucket monotonicity — the acid test
  const nonEmpty = table.filter(b => b.n >= 20 && b.meanActualFill != null);
  let monotonic = true;
  for (let i = 1; i < nonEmpty.length; i++) {
    if (nonEmpty[i].meanActualFill < nonEmpty[i - 1].meanActualFill - 0.05) monotonic = false;
  }
  console.log(monotonic
    ? "\n✓ Buckets are (near-)monotonic: higher predicted probability → higher actual fill rate."
    : "\n✗ Buckets are NOT monotonic — score's ordinal ranking has kinks. Some threshold is miscalibrated.");
}

main().catch(e => { console.error(e); process.exit(1); });
