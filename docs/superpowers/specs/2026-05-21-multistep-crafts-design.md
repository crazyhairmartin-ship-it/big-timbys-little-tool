# Multistep Crafts (Supply-Aware Recipes) — Design

**Status:** Approved design — ready for implementation planning.
**Date:** 2026-05-21

## Goal

Let the tracker carry recipes that represent a multi-step real-world craft —
e.g. a Ring of suffering built end-to-end from raw onyx + zenyte shard, through
uncut zenyte, cut zenyte, zenyte ring, and a final enchant. These appear as
ordinary recipe cards; the multi-step nature is captured in the data, not in a
new UI mode.

## Decisions made during brainstorming

- **Display: flat.** A multistep craft renders as a normal card — raw inputs in
  one block, no per-step breakdown.
- **Cost model: always craft from raw.** Cost is the sum of every raw input
  across all steps. Intermediate items are never assumed to be bought.
- **Representation: flat recipes (Approach A).** Each craft is a hand-authored
  flat `RECIPES` entry. No chain-compiler, no `steps` field. Skill-only steps
  (e.g. "cut the uncut zenyte") contribute nothing but a skill requirement.
- **Supplies are a distinct input class.** Cheap, high-volume, price-stable
  consumables (runes, bars, ball of wool) are grouped into one card line, do
  not count as a Grand Exchange slot, and are always priced live.
- **Both recipes are kept.** The existing enchant-only recipe (buy a finished
  ring, enchant it) stays alongside the new full-craft recipe, like the Masori
  "via X" alternatives. More information is fine.

## Non-goals

- No chain compiler / `steps` data structure.
- No "stepped" card layout showing each step.
- No cheapest-path optimisation (buy-vs-craft per intermediate).
- Supplies are not predicted on the Experimental tab — they use live prices.
- Intermediate transforms (cutting a gem) are not modelled as recipes.

## 1. Data model

Recipe objects in `RECIPES` (`dist/app.js`) gain one optional field:

```js
{ key:"ring-of-suffering-craft", id:19550, name:"Ring of suffering (full craft)",
  cat:"Zenyte",
  components: [ {id:6573,qty:1}, {id:19529,qty:1} ],   // cut onyx, zenyte shard
  supplies:   [ {id:2357,qty:1}, {id:564,qty:1},        // gold bar, cosmic rune
                {id:566,qty:20}, {id:565,qty:20} ] }    // soul rune, blood rune
```

- `components` — unchanged meaning: the defining, expensive, buy-limit-constrained
  items. One card line each. Each **is** a GE slot.
- `supplies` — optional `[{id, qty}]`. Cheap bulk consumables. Collapsed into one
  card line. **Not** a GE slot. Absent on the vast majority of recipes; when
  absent the recipe behaves exactly as today.

**Classification rule.** An input belongs in `supplies` only if it is cheap and
price-stable (runes, bars, ball of wool). A volatile or expensive input must be
a `component` so that it is buy-limit-checked and predicted on the Experimental
tab. When in doubt, use `components`.

## 2. Cost calculation — `calcMargin` (`dist/app.js`)

Add a supplies cost leg:

- `suppliesCost` = Σ (live buy-side price × qty) over `recipe.supplies`, using
  the same `supplyPrice(state.prices[id])` path the component leg uses in
  real-time mode. **Supplies use live prices in both modes** — the `predMap`
  passed in Experimental mode is *not* consulted for supplies.
- `totalCost = componentCost + suppliesCost + repairCost`.
- `allPresent` additionally requires every supply to have a live price. Runes
  and bars effectively always do; a missing one skips the recipe, same as a
  missing component.
- Supplies are **excluded** from the volume and GE-buy-limit bottlenecks
  (`maxFlips`). They never constrain craft rate and are not a managed slot.
- The returned calc object gains `suppliesCost`. `componentCost` keeps its
  current meaning (components only).
- Recipes with no `supplies` field: `suppliesCost = 0`, `totalCost` unchanged —
  fully backward compatible.

`historicalMargin` (the 24h-average margin feeding the Recommended sort) gains a
matching supplies leg over `state.avg24h`, so the sort is not blind to supply
cost.

## 3. Display

**Card** (`dist/app.js` card renderer): when `recipe.supplies` is non-empty,
render one extra row after the component rows:

- Label: `Supplies`. Value: `suppliesCost` formatted in gp.
- A `title` tooltip itemises it, e.g.
  `1× Gold bar · 20× Soul rune · 20× Blood rune · 1× Cosmic rune`.
  Built from `recipe.supplies` + `state.mapping` names. Desktop shows the
  tooltip on hover; mobile sees the summary line.
- Recipes without `supplies` render exactly as today (no empty row).

**Modal detail table**: add a matching `Supplies` row (total + itemised
`title` tooltip), alongside the existing `Skill to craft` row.

**Modal price-history chart**: supplies do **not** get their own chart tabs —
that would add four rune tabs of noise. Tabs stay = product + components, as
today.

**GE-slots filter**: unchanged. It counts `recipe.components.length`; supplies
live in a separate array, so they are excluded by construction. This is exactly
the "supplies don't count as a GE slot" behaviour.

## 4. Experimental tab & price-history integration

- `overnightItemIds()` — **no change.** Supplies are never predicted, so they
  never need to enter `predMap`. Only `r.id` and `r.components` are collected,
  as today.
- `calcMargin` predicted path — the supplies leg reads `state.prices` even when
  `predMap` is supplied. An Experimental margin is therefore:
  `predicted(product sell) − predicted(component buys) − live(supplies) − tax`.
- `record-prices.mjs` — **no change.** It records every item that traded that
  hour and is not RECIPES-scoped; runes, bars and gems are already captured.
- `backfill-prices.yml` — **no change.** It extracts ids with
  `matchAll(/\bid:(\d+)/g)` over the whole `RECIPES` literal; that regex matches
  `id:` inside `supplies:[…]` exactly as inside `components:[…]`. The
  implementation plan includes a step to verify this against the built file.

## 5. v1 recipe data

All item ids, rune sets and quantities below are taken from the existing
recipes in `dist/app.js`. Exact crafting/enchant skill levels are sourced from
the OSRS Wiki recipe data (as the existing `SKILL_REQS` map already is) and
confirmed during implementation.

### 5a. New full-craft recipes (7)

Each is an additional `RECIPES` entry with a distinct `key` and a `name`
suffixed `(full craft)`. Components = the cut gem (+ shard for zenyte);
supplies = gold bar, ball of wool where the item is an amulet, and the enchant
runes.

**Zenyte family** (cat `Zenyte`) — components `[onyx 6573 ×1, zenyte shard 19529 ×1]`,
enchant runes `cosmic 564 ×1, soul 566 ×20, blood 565 ×20`:

| Product | id | Supplies |
|---|---|---|
| Ring of suffering (full craft) | 19550 | gold bar ×1, enchant runes |
| Necklace of anguish (full craft) | 19547 | gold bar ×1, enchant runes |
| Tormented bracelet (full craft) | 19544 | gold bar ×1, enchant runes |
| Amulet of torture (full craft) | 19553 | gold bar ×1, ball of wool 1759 ×1, enchant runes |

**Onyx family** — components `[onyx 6573 ×1]`, enchant runes
`cosmic 564 ×1, fire 554 ×20, earth 557 ×20`:

| Product | id | cat | Supplies |
|---|---|---|---|
| Amulet of fury (full craft) | 6585 | Misc | gold bar ×1, ball of wool 1759 ×1, enchant runes |
| Ring of stone (full craft) | 6583 | Onyx | gold bar ×1, enchant runes |
| Berserker necklace (full craft) | 11128 | Onyx | gold bar ×1, enchant runes |

Each gets a `SKILL_REQS` entry combining the chain's skills — the highest
Crafting level across its craft/cut steps plus the enchant's Magic level, e.g.
`"89 Crafting + 93 Magic"` (zenyte) / `"90 Crafting + 87 Magic"` (onyx amulet).

### 5b. Migrate existing enchant recipes (7)

These already list enchant runes inside `components`. Move the runes into a new
`supplies` array so the supplies line is consistent across both categories. The
base jewellery item stays in `components`.

`amulet-of-torture`, `necklace-of-anguish`, `ring-of-suffering`,
`tormented-bracelet` (cat `Zenyte`); `berserker-necklace`, `ring-of-stone`
(cat `Onyx`); `amulet-of-fury` (cat `Misc`).

Side effect: these correctly become 1-GE-slot recipes (you buy one real item —
the base jewellery — and bulk runes), which the GE-slots filter now reflects.

## 6. Affected files

- `dist/app.js` — `RECIPES` (add 7, migrate 7), `SKILL_REQS` (add 7),
  `calcMargin` (`suppliesCost`), `historicalMargin` (supplies leg), card
  renderer (`Supplies` row), modal detail renderer (`Supplies` row).
- No changes to `dist/overnight.js`, `dist/overnight-core.js`, the recorder, or
  the backfill workflow. The plan verifies the backfill id-extraction still
  covers `supplies`.

## 7. Testing

- The pure cost logic is exercised via the running app (no unit-test harness
  covers `calcMargin`). Verify in-browser, both modes:
  - A migrated recipe (e.g. `ring-of-suffering`) shows one `Supplies` row whose
    total equals the former rune rows, and is now a 1-slot recipe.
  - A new full-craft recipe shows correct margin = product − components −
    supplies − tax, in real-time and Experimental.
  - GE-slots filter: full-craft zenyte recipes appear under "2 slots or fewer";
    onyx ones under "1 slot or fewer".
  - Experimental tab: the new and migrated recipes are analysed (not skipped),
    confirming supplies-on-live-prices does not break `allPresent`.
