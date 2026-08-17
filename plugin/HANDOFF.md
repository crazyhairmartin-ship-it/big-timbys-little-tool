# Plugin work — handoff

Read this file first when picking up plugin work in a new Claude session.
Everything below is the current, load-bearing context.

## What Big Timby is

Web app at [big-timbys-little-tool.vercel.app](https://big-timbys-little-tool.vercel.app)
— OSRS Grand Exchange margin tracker with an allocator, predictive analysis,
and fill-probability calibration. Lives in `dist/`. Deployed to Vercel; push
to `main` = auto-deploy.

## What the plugin is

A RuneLite plugin that surfaces Big Timby's recommendations inside the OSRS
client — reads the item you're setting up an offer for on the Grand Exchange,
calls the backend at `/api/recommend?id=<itemId>`, renders a small overlay
next to the GE window with recommended buy/sell prices and per-side fill
probability.

**Scope commitment:** informational display only. NO input generation, NO
auto-fill of the price field, NO automation of any kind. Reads state the
game already exposes; renders text. This is Path C (personal / dev-mode
sideload), not for Plugin Hub distribution.

## Where you're picking up

- **Web app**: live and unrelated to plugin work — don't touch unless the
  user asks.
- **Plugin skeleton**: written, committed. Never run end-to-end.
- **Backend endpoint `/api/recommend`**: deployed, live. Test with
  `curl 'https://big-timbys-little-tool.vercel.app/api/recommend?id=12852'`
  (Zamorak hilt) — should return JSON with market/buy/sell/spread.
- **Blocker on macOS Mac Mini**: setup friction from Jagex Launcher +
  App Translocation + signed .app internals. Paused, not solved.
- **Current environment**: probably Windows now, which sidesteps all the
  macOS-specific issues (no App Translocation, RuneLite launcher save works).

## Files that matter (all under `plugin/`)

- `README.md` — build + run instructions (Path C for in-tree, sideload path
  for JAR-only). Read this to actually build the thing.
- `HANDOFF.md` — this file.
- `build.gradle.kts` — Gradle build (only needed for sideload path; in-tree
  uses runelite's own Gradle).
- `src/main/java/com/bigtimby/plugin/BigTimbyPlugin.java` — main class,
  `@Subscribe` handlers for `WidgetLoaded` + `VarClientIntChanged`.
- `src/main/java/com/bigtimby/plugin/BigTimbyOverlay.java` — draggable
  overlay renderer. Uses server values directly; no math here.
- `src/main/java/com/bigtimby/plugin/BigTimbyConfig.java` — one on/off
  toggle for the overlay.
- `src/main/java/com/bigtimby/plugin/PriceService.java` — OkHttp + 60s cache
  against the backend endpoint. Returns `Recommendation` struct with
  buy/sell prices + fill probabilities.

## Backend

`dist/api/recommend.js` — Vercel serverless function. Fetches OSRS wiki
`/latest` + `/1h`, scores spread + volume for per-side fill probability,
biases offer price toward mid proportionally. Formulas duplicated from
`dist/app.js` (comment flags this; factor out later if drift becomes real).

Response shape:
```json
{
  "itemId": 12852,
  "market": { "high": 15140678, "low": 14800000, "highTime": ..., "lowTime": ... },
  "spread": 340678,
  "spreadPct": 0.023,
  "buy":  { "price": 14970000, "fillProbability": 0.72, ... },
  "sell": { "price": 15070000, "fillProbability": 0.68, ... },
  "fetchedAt": "2026-08-17T..."
}
```

## Design decisions locked in (revisit only with user consent)

1. **Path C** — personal, sideload/in-tree only, not Plugin Hub. Zero review
   process, zero open-source obligations, full control over what's in it.
2. **Informational only** — no input generation, no `Robot`, no
   `Client#invokeMenuAction` for price-fill (that's Backlog Item 1). Reads
   only. Ban risk research (see chat history) said this is safe.
3. **Server owns the math** — plugin sends item id, server returns
   recommendation. Overlay is a dumb renderer. This keeps the plugin thin
   and lets us iterate on scoring logic without rebuilding the JAR.
4. **JDK 11 + Temurin** — RuneLite's requirement, not negotiable.
5. **Backend under `dist/api/`** (not root `api/`) because Vercel is
   configured with Root Directory = `dist/`. Don't add root-level `api/`
   or a `vercel.json` unless deliberately restructuring.

## Immediate next steps in priority order

1. **Get plugin running locally.** Follow `plugin/README.md` § "Run in Path C".
   Windows should be smoother than the macOS attempt. First success: launcher
   accepts `--developer-mode`, credentials.properties writes cleanly, IntelliJ
   run of `net.runelite.client.RuneLite` skips old login and lands in-game
   with plugin toggle in Configuration list.
2. **Verify overlay appears.** Enable plugin → open GE → click Buy on any
   item. Expect overlay top-left with item name, market prices, recommended
   buy + sell + fill probability. Compare against what the web app card
   would show for the same item.
3. **Buy-vs-sell disambiguation.** Current overlay shows BOTH buy and sell
   recommendations because we can't cleanly tell which side the user is
   setting up from `VARCINT_GE_OFFER_ITEM` alone. Detect widget child that
   indicates buy vs sell (grep RuneLite source for `GE_OFFER_TYPE` or
   similar) and pass `?side=buy` or `?side=sell` to the backend.
4. **Side panel.** Add a `PluginPanel` + `NavigationButton` mirroring the
   web app's Allocate tab in-client — user's current allocation picks,
   fill probability chips, etc. Bigger feature; do only after 1-3 are solid.

## Backlog (parked, not next)

- **Copilot-style hotkey auto-fill** of the GE price field. Requires
  `KeyManager` + `Client#runScript`. Ban-risk safe (Flipping Copilot on
  Hub does exactly this) but sits at the "input generation" edge — do
  cautiously and only after the passive overlay is proven.
- **Overnight predictions in `/api/recommend`.** Currently the backend only
  uses live data. Extend to include the predicted-buy-hour / target price
  when overnight analysis has data for the item.
- **Contested-input awareness.** When the user has an active allocator
  run on the site, expose per-item contested-share so the plugin's number
  matches what the web card shows.
- **User accounts / API key gate.** Not for personal use, but if plugin
  ever needs to distinguish which user is calling. See chat history for
  the Pattern-1 (token-paste) vs Pattern-2 (browser OAuth) discussion.

## Repo state on handoff

- **Branch**: `worktree-history-tab`
- **Latest commit before handoff**: `45f2c15` (plugin skeleton +
  backend endpoint)
- **`main`**: has the backend deployed via cherry-pick of `45f2c15`
- **Remote**: `https://github.com/crazyhairmartin-ship-it/big-timbys-little-tool.git`

## Ban-risk research (already done, don't redo)

Confirmed safe for a personal informational plugin:
- RuneLite is Jagex-approved (one of two permitted third-party clients).
- GE data / price recommendation / margin display is NOT on the prohibited
  list. Multiple Hub-approved plugins (GE-Tracker, Flipping Utilities,
  Flipping Copilot) do exactly this class of thing.
- Sideloading via `--developer-mode` is a documented developer workflow.
- No evidence of bans for informational-only plugins.

Patterns to avoid regardless:
- ANY input generation (`Robot`, injected keypresses).
- Anything not visible to the player (hidden widgets, packet intercepts
  beyond the public API).
- Auto-submitting GE offers or auto-filling quantities.
- Combat-assist features (the one category with explicit written bans).
- Hammering Jagex endpoints — use the wiki price API + cache.

## When picking up in a fresh Claude session

Say something like: "Read `plugin/HANDOFF.md` and let's continue the plugin
work — I'm ready to try running it locally now." The whole context is in
this file + `plugin/README.md`.
