# Overnight Flipping — Design

**Date:** 2026-05-20
**Status:** Approved design, ready for implementation planning

## Goal

Add an "overnight flipping" feature to Big Timby's Little Tool. For each
tracked item it forecasts two prices from the item's own price history:

- a **predicted overnight buy price** — where the item is expected to dip
  during the global low-activity window, and
- a **predicted daytime sell price** — where it is expected to recover.

The feature surfaces items worth buying overnight and selling during the day,
ranked by expected profit and how reliably the pattern repeats.

Overnight flipping is single-item time arbitrage — a different strategy from
the app's existing recipe-margin tracking. It reuses the app's item universe
but is presented as a separate mode.

## Scope decisions

These were settled during brainstorming:

1. **Item scope** — analysis covers the items already tracked by the app: the
   ~97 combination products plus their components (a few hundred unique item
   IDs). Not all GE items — scanning 4,500+ items would need a precomputed
   backend data file; that is out of scope.
2. **Presentation** — a dedicated mode, not woven into the recipe cards.
3. **"Overnight" window definition** — data-derived, not a fixed clock window
   and not the user's local night. The window is found by aggregating every
   item's hourly history (see Step A below).
4. **Buy signal** — comes *only* from the recurring overnight dip. One-off
   daytime price dumps must never be treated as buy opportunities; the
   data-derived aggregate handles this for free (a non-recurring dump does not
   move an average taken across every item and every day).

## The prediction model

### Step A — Calibrate the global windows (once per data refresh)

Each tracked item gets ~15 days of hourly history (`/timeseries`,
`timestep=1h`). For each item, normalise every hourly price by that item's own
mean, producing a relative curve so items of any price magnitude are
comparable. Average all the normalised curves into one **global 24-hour
curve**.

The buy and sell windows are each a **fixed-width contiguous block of hours**,
found by a sliding-window scan over the 24-hour curve. The block width is a
tunable named constant — default **6 hours**.

- The 6-hour contiguous block with the lowest mean = the **overnight
  (buy) window**.
- The 6-hour contiguous block with the highest mean = the **daytime
  (sell) window**.

Because the curve is averaged across every item and every day, only *recurring*
dips survive; a one-off afternoon dump in a single item is averaged away.

The windows are **global** — the same buy/sell hours apply to every item — so
they are displayed once in a header rather than per item.

### Step B — Per-item prediction (trend-robust)

Predicting a raw gp price goes stale if an item is drifting up or down, so we
predict *ratios* instead:

- `overnightRatio = median(item's prices during overnight window) / median(item's prices, all hours)`
- `daytimeRatio   = median(item's prices during daytime window)   / median(item's prices, all hours)`

Anchor to a fresh baseline — the item's median price over the **last 3 days**:

- **Predicted overnight buy** = `baseline x overnightRatio`
- **Predicted daytime sell**  = `baseline x daytimeRatio`
- **Predicted profit/unit**   = `sell x (1 - GE tax) - buy`, where GE tax is
  the standard 2% (capped 5M, exempt <100 gp)

Ratios keep the prediction correct in relative terms even for an item whose
absolute price is trending.

### Step C — Confidence

Across the ~15 days of history, count the days on which the overnight-window
price was actually below that day's daytime-window price:

`confidence = goodDays / totalDays`

A 95% item is a dependable cycle; a 60% item is close to a coin flip.
Confidence drives ranking (below) so a large but flaky spread loses to a
smaller dependable one.

## UI — Mode x Format

The current single Cards/Table toggle becomes **two independent toggles**:

- **Mode** (new) — *Real-time* (today's recipe-margin tracker) or *Overnight*
  (this feature). Top-level switch.
- **Format** (existing) — *Cards* or *Table*, applied within whichever mode.
- **Defaults: Real-time + Cards.** Both toggles persist to `localStorage`.

### The Overnight card

Mirrors the existing recipe card's anatomy so it feels native:

- **Head** — item icon + name, plus a confidence chip (styled like the
  existing trend/stale chips).
- **Hero number** — the flip's **Profit %**, green/red, with profit per unit
  (gp) on the sub-line.
- **Stat rows** — Predicted buy, Predicted sell, Confidence.
- **24-hour sparkline** — the item's hour-of-day price shape with the buy and
  sell windows shaded.
- **Click** — opens a modal showing the full-size 24-hour profile curve (the
  prediction basis). Reuses the existing modal shell.

### Overnight mode header

A strip above the grid shows the global buy/sell windows (UTC), a freshness
stamp ("Analysed N ago"), the analysed-item count, and a manual refresh
control. During the first-ever analysis it is a progress bar
("Analysing 247 / 412 items...").

### Filters

The sidebar **search** and **cost-range** filters still apply in Overnight
mode (filter by item name, by predicted buy price). The recipe-specific
toggles (stale products/components, favorites, low-volume, profitable-only)
are hidden in Overnight mode — they do not map to single-item flips.

### Table format

Cards is the default for both modes. Table format is also available in
Overnight mode; its columns are item, predicted buy, predicted sell,
profit/unit, profit %, confidence — all click-sortable.

## Data, caching, ranking

### Fetching

On the first switch to Overnight mode, fetch `/timeseries?timestep=1h` for
each unique tracked item. Two cost reducers:

- **Volume pre-filter** — skip items below a minimum 24h trade volume (using
  the `/volumes` data already in memory); illiquid items cannot be
  overnight-flipped. Cuts the ~600-item universe to ~300-450.
- **Throttle** — ~5 concurrent requests, to stay polite to the wiki API.
  Expected runtime ~15-20s, surfaced as the header progress bar.

### Caching

Cache the **computed results** — per item: predicted buy/sell, profit,
confidence, and the 24-point curve — never raw timeseries. Stored under one
`localStorage` key with a timestamp (~400 small objects, well within the
storage limit).

- Re-analyse automatically only when the cache is **older than 24h** — the
  hour-of-day rhythm is stable day to day.
- The 60s real-time price loop does **not** touch overnight data.
- Manual refresh forces a fresh analysis.

### Ranking

Each item has Profit % (net of tax) and Confidence. Default order:

`score = profit% x confidence^2`

Squaring confidence means a dependable 12% flip outranks a flaky 30% one,
while a *reliable* large spread still dominates. Two hard exclusions:

- predicted profit <= 0 (no real overnight discount), and
- confidence below ~55% (no genuine recurring pattern).

The exponent and threshold are single named constants, easy to tune later —
the same pattern as the Recommended-sort weights.

## Edge cases

- **Thin history** — an item with fewer than ~10 days of usable hourly data is
  flagged low-confidence and likely excluded.
- **Fetch failures** — if some `/timeseries` calls fail, skip those items and
  show "N items couldn't be analysed" in the header.
- **GE buy limit** — overnight-flip throughput is capped by the 4h GE buy
  limit. Shown as a secondary line on the card / in the modal; per-unit
  Profit % stays the headline.
- **GE tax** — the standard 2% (capped 5M, exempt <100 gp) is netted into the
  predicted profit.

## Code structure

The feature is a cohesive unit (~300-400 lines): global-window calibration,
per-item prediction, caching, and the Overnight render path. It lives in a
**new `dist/overnight.js`** file loaded after `app.js`, rather than growing
`app.js` (already ~2,300 lines). It reuses the existing global helpers —
`api`, `geTax`, `fmtGp`, `el`, `state`, `RECIPES`.

## Out of scope

- **Fixing the existing Table view.** The Table view has known rendering
  problems. Because Cards is the default for both modes, the Overnight feature
  does not depend on the Table view. Fixing it is a separate task, tracked
  independently of this spec.
- **Analysing all GE items.** Requires a precomputed backend data file; not
  part of this client-only feature.
- **Intra-day (sub-hour) timing.** `/timeseries` at `1h` step pinpoints to the
  hour, not the minute. Acceptable for overnight planning.
