# Big Timby RuneLite plugin

Personal, informational-only plugin that displays live Grand Exchange
recommendations from Big Timby's Little Tool. Reads the item you're setting
up an offer for, fetches live wiki prices, and shows a "buy at X / sell at Y"
overlay next to the GE screen.

**No input generation, no auto-fill, no automation.** Purely a HUD label
reading state the client already exposes.

## Run in Path C (in-tree, personal-only)

The simplest way to use this yourself — no Gradle needed.

1. Clone `runelite/runelite` locally
2. Copy `src/main/java/com/bigtimby/plugin/` into
   `runelite-client/src/main/java/net/runelite/client/plugins/bigtimby/`
   (rename the `package com.bigtimby.plugin;` line at the top of each `.java`
   file to `package net.runelite.client.plugins.bigtimby;`)
3. Open the RuneLite project in IntelliJ IDEA, JDK 11 (Eclipse Temurin)
4. On macOS with JDK 17+ add VM option
   `--add-opens=java.desktop/com.apple.eawt=ALL-UNNAMED`
5. Run the `net.runelite.client.RuneLite` main class
6. Log into OSRS, click the wrench (Configuration), find "Big Timby", toggle on
7. Open the Grand Exchange, click "Buy" or "Sell" on any item — the overlay
   appears top-left of the game canvas with the recommendation

## Run in sideload mode (once stable)

Build a shaded JAR and let the official RuneLite launcher load it — no
IntelliJ needed for daily use.

```
./gradlew shadowJar
cp build/libs/big-timby-plugin-0.1.0-all.jar ~/.runelite/sideloaded-plugins/
runelite --developer-mode
```

## Things to verify before your first run

- **RuneLite version**: `runeLiteVersion` in `build.gradle.kts` is a placeholder;
  bump to whatever's current when you build. Check
  https://repo.runelite.net/net/runelite/client/ for the latest.
- **VarClientInt indices** (`VARCINT_GE_OFFER_ITEM = 1151`,
  `VARCINT_GE_OFFER_PRICE = 1153`): these are the standard GE var indices but
  are worth verifying against `runelite-api` in your local runelite clone.
  Grep for `GE_OFFER` in `VarClientInt.java`.
- **GE widget group ID** (`465`): unchanged for years but verify against
  `WidgetInfo.java` if the overlay isn't appearing.

## Ban risk

Confirmed safe research-wise for a personal informational plugin: RuneLite is
Jagex-approved, GE data / margin display is not on the prohibited list,
sideloading is a documented developer workflow, no evidence of bans for
informational-only plugins. Don't add input generation and you're on the
same footing as existing Hub plugins that do this (GE-Tracker, Flipping
Utilities, Flipping Copilot).

## Backend

The plugin calls `https://big-timbys-little-tool.vercel.app/api/recommend?id=<itemId>`,
implemented by `dist/api/recommend.js` in this repo. That endpoint fetches live
wiki prices + hourly volume, scores spread and volume for fill probability,
and returns a recommended buy + sell price with fill probability per side.
Cached 30s at the edge, 60s in the plugin — total wiki hits bounded regardless
of how fast the user tabs through GE items.

## Backlog

- **Copilot-style hotkey auto-fill.** `KeyManager` listener + `Client#runScript`
  to set the GE price field on user hotkey. Same pattern as Flipping Copilot;
  proven safe on the Hub.
- **Side panel with active allocation.** `PluginPanel` + `NavigationButton`
  that mirrors the web app's Allocate tab in-client.
- **Overnight predictions in the response.** Extend `/api/recommend` to
  include the predicted-buy-hour / target price when overnight analysis has
  data for the item.
- **Contested-input awareness.** When the user has an active allocator run
  on the site, expose per-item contested-share so the plugin's recommendation
  matches what the web card would show.
