# Multistep (Supply-Aware) Crafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recipes that represent an end-to-end multi-step craft (e.g. Ring of suffering built from raw onyx), with cheap bulk consumables grouped into a single live-priced "Supplies" line that does not count as a Grand Exchange slot.

**Architecture:** Recipes gain one optional field, `supplies: [{id, qty}]`. `calcMargin`/`historicalMargin` add a supplies cost leg priced from live data in both modes. The card and modal render one collapsed "Supplies" row with an itemised hover tooltip. No new files, no new concepts — multistep crafts are ordinary flat `RECIPES` entries that happen to use `supplies`. Approved spec: `docs/superpowers/specs/2026-05-21-multistep-crafts-design.md`.

**Tech Stack:** Vanilla JS, zero-build static app (`dist/app.js`, `dist/index.css`, `dist/index.html`). No bundler. No unit-test harness for `app.js` (only `dist/overnight-core.js` has `node --test` coverage, and this feature does not touch it) — verification is done in a browser.

---

## Verification environment

There is no unit-test framework for `app.js`. Every task is verified in a browser against a local server. The browser **caches `app.js`** aggressively, so **always serve on a fresh port** after editing:

```bash
cd "/Volumes/Public/runescape app/dist" && python3 -m http.server 8801
```

Bump the port number (8802, 8803, …) on each re-verification. Open `http://localhost:<port>/index.html`. The live wiki API populates prices a few seconds after load.

## File Structure

- `dist/app.js` — the **only** file changed. Sections touched:
  - `calcMargin` (currently lines ~911–991) — add `suppliesCost`.
  - `historicalMargin` (~998–1011) — add supplies leg.
  - `renderCard` component-rows block (~1233–1278) — add the `Supplies` row.
  - `renderRecipeStats` (~1770–1791) — add the `Supplies` detail row.
  - `SKILL_REQS` map (~359–422) — add 7 entries.
  - `RECIPES` array — migrate 7 existing entries, add 7 new entries.
- `scripts/backfill-prices.mjs` / `.github/workflows/backfill-prices.yml` — **not changed**; Task 5 only verifies they still cover supply ids.

Line numbers shift as edits land — always anchor edits to the quoted surrounding code, not the line number.

---

## Task 1: Supplies cost in `calcMargin` and `historicalMargin`

**Files:**
- Modify: `dist/app.js` — `calcMargin` and `historicalMargin`

- [ ] **Step 1: Add the supplies cost leg to `calcMargin`**

Find this block inside `calcMargin` (just after the `for (const c of recipe.components)` loop):

```js
  if (recipe.extraCost) componentCost += recipe.extraCost;
  const rc = repairCost(recipe.repairBase, state.smithing);
  const totalCost = componentCost + rc;
```

Replace it with:

```js
  if (recipe.extraCost) componentCost += recipe.extraCost;
  // Supplies (runes/bars/wool): always priced live, even when predMap is set —
  // they are cheap and price-stable, so predicting them only adds noise.
  let suppliesCost = 0;
  for (const s of recipe.supplies || []) {
    const sp = supplyPrice(state.prices[s.id]);
    if (!sp) { allPresent = false; break; }
    suppliesCost += sp * s.qty;
  }
  const rc = repairCost(recipe.repairBase, state.smithing);
  const totalCost = componentCost + suppliesCost + rc;
```

- [ ] **Step 2: Expose `suppliesCost` on the returned calc object**

In the `return { ... }` at the end of `calcMargin`, find the line:

```js
    componentCost, repairCost: rc, totalCost,
```

Replace it with:

```js
    componentCost, suppliesCost, repairCost: rc, totalCost,
```

- [ ] **Step 3: Add the supplies leg to `historicalMargin`**

Find this block in `historicalMargin`:

```js
  for (const c of recipe.components) {
    const sp = supplyPrice(src[c.id]);
    if (sp === null) return null;
    cost += sp * c.qty;
  }
  cost += repairCost(recipe.repairBase, state.smithing);
```

Replace it with:

```js
  for (const c of recipe.components) {
    const sp = supplyPrice(src[c.id]);
    if (sp === null) return null;
    cost += sp * c.qty;
  }
  for (const s of recipe.supplies || []) {
    const sp = supplyPrice(src[s.id]);
    if (sp === null) return null;
    cost += sp * s.qty;
  }
  cost += repairCost(recipe.repairBase, state.smithing);
```

- [ ] **Step 4: Syntax-check**

Run: `cd "/Volumes/Public/runescape app" && node -c dist/app.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify — regression + new path**

Serve on a fresh port and open the app. In the browser console:

```js
// Regression: a recipe with no `supplies` is unchanged.
const r = RECIPES.find(x => x.key === "armadyl-godsword");
const c = calcMargin(r);
console.log("suppliesCost (should be 0):", c.suppliesCost,
            "totalCost === componentCost+repairCost:",
            c.totalCost === c.componentCost + c.repairCost);

// New path: synthesise a recipe with a supplies array (gold bar id 2357).
const goldBar = supplyPrice(state.prices[2357]);
const synth = { ...r, supplies: [{ id: 2357, qty: 3 }] };
const cs = calcMargin(synth);
console.log("synth suppliesCost (should be ~3× gold bar):", cs.suppliesCost,
            "expected:", goldBar * 3);
```

Expected: first line — `suppliesCost (should be 0): 0 ... true`. Second — `synth suppliesCost` equals `3 × gold-bar price`.

- [ ] **Step 6: Commit**

```bash
cd "/Volumes/Public/runescape app" && git add dist/app.js && git commit -m "Add supplies cost leg to calcMargin and historicalMargin"
```

---

## Task 2: Render the "Supplies" row on the card and modal

**Files:**
- Modify: `dist/app.js` — `renderCard` component-rows block, and `renderRecipeStats`

- [ ] **Step 1: Add the Supplies row to the card**

In `renderCard`, find the line immediately after the `for (const c of recipe.components) { … }` loop ends:

```js
  if (recipe.extraCost) row(comp, { label: "Runes/extras", value: fmtGp(recipe.extraCost) });
```

Insert this **before** that line:

```js
  if (recipe.supplies && recipe.supplies.length) {
    const supplyRow = row(comp, { label: "Supplies", value: fmtGp(calc.suppliesCost) });
    supplyRow.title = recipe.supplies
      .map(s => `${s.qty}× ${state.mapping[s.id]?.name || "#" + s.id}`)
      .join(" · ");
  }
```

- [ ] **Step 2: Add the Supplies row to the modal detail panel**

In `renderRecipeStats`, find this line inside the `modalDetail.replaceChildren( … )` call:

```js
    detailRow(supplyLbl, fmtGp(calc.componentCost), { cls: "v-supply" }),
```

Insert this line immediately **after** it:

```js
    ...(calc.suppliesCost ? [detailRow("Supplies", fmtGp(calc.suppliesCost), { cls: "v-supply" })] : []),
```

- [ ] **Step 3: Syntax-check**

Run: `cd "/Volumes/Public/runescape app" && node -c dist/app.js`
Expected: no output (exit 0).

- [ ] **Step 4: Verify**

Serve on a fresh port, open the app. No recipe has a `supplies` array yet, so this is a regression check plus a synthetic render:

```js
// Regression: an existing card has no "Supplies" row.
console.log("Supplies rows present (should be 0):",
  [...document.querySelectorAll('#grid .components .row')]
    .filter(r => r.textContent.startsWith('Supplies')).length);

// Synthetic: give one recipe a supplies array, re-render, inspect.
RECIPES[0].supplies = [{ id: 2357, qty: 1 }, { id: 554, qty: 20 }];
renderGrid();
const r0 = document.querySelector('#grid .card .components');
const sup = [...r0.querySelectorAll('.row')].find(x => x.textContent.startsWith('Supplies'));
console.log("synthetic Supplies row text:", sup && sup.textContent,
            "| tooltip:", sup && sup.title);
delete RECIPES[0].supplies; renderGrid();
```

Expected: first log `0`; second log shows a `Supplies` row with a gp value and a tooltip like `1× Gold bar · 20× Fire rune`.

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Public/runescape app" && git add dist/app.js && git commit -m "Render a collapsed Supplies row on the card and modal"
```

---

## Task 3: Migrate the 7 existing enchant recipes to use `supplies`

These recipes currently list enchant runes inside `components`. Move the runes into a new `supplies` array; keep the base jewellery item as the sole `component`. Rune ids: cosmic `564`, soul `566`, blood `565`, fire `554`, earth `557`.

**Files:**
- Modify: `dist/app.js` — `RECIPES` array (7 entries)

- [ ] **Step 1: Migrate the 4 Zenyte enchant recipes**

Replace each line as shown (match by `key`).

`amulet-of-torture`:
```js
  { key:"amulet-of-torture", id:19553, name:"Amulet of torture", cat:"Zenyte", components:[{id:19541,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
```

`necklace-of-anguish`:
```js
  { key:"necklace-of-anguish", id:19547, name:"Necklace of anguish", cat:"Zenyte", components:[{id:19535,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
```

`ring-of-suffering`:
```js
  { key:"ring-of-suffering", id:19550, name:"Ring of suffering", cat:"Zenyte", components:[{id:19538,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
```

`tormented-bracelet`:
```js
  { key:"tormented-bracelet", id:19544, name:"Tormented bracelet", cat:"Zenyte", components:[{id:19532,qty:1}], supplies:[{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
```

- [ ] **Step 2: Migrate the 3 Onyx enchant recipes**

`amulet-of-fury` (note: `cat:"Misc"`):
```js
  { key:"amulet-of-fury", id:6585, name:"Amulet of fury", cat:"Misc", components:[{id:6581,qty:1}], supplies:[{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
```

`berserker-necklace`:
```js
  { key:"berserker-necklace", id:11128, name:"Berserker necklace", cat:"Onyx", components:[{id:6577,qty:1}], supplies:[{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
```

`ring-of-stone`:
```js
  { key:"ring-of-stone", id:6583, name:"Ring of stone", cat:"Onyx", components:[{id:6575,qty:1}], supplies:[{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
```

- [ ] **Step 3: Syntax-check**

Run: `cd "/Volumes/Public/runescape app" && node -c dist/app.js`
Expected: no output (exit 0).

- [ ] **Step 4: Verify**

Serve on a fresh port, open the app, wait for prices to load. In the console:

```js
for (const key of ["ring-of-suffering","amulet-of-fury","berserker-necklace"]) {
  const r = RECIPES.find(x => x.key === key);
  const c = calcMargin(r);
  console.log(key,
    "| GE slots (components.length):", r.components.length,   // expect 1
    "| suppliesCost > 0:", c.suppliesCost > 0,
    "| margin:", Math.round(c.margin));
}
```

Expected: each shows `GE slots … 1`, `suppliesCost > 0: true`, and a finite margin. Then visually: open one of these cards — it shows a single `Supplies` row (not three rune rows) with an itemising tooltip on hover. Set the sidebar "Max GE slots" filter to "1 slot or fewer" and confirm these recipes appear.

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Public/runescape app" && git add dist/app.js && git commit -m "Migrate enchant recipes to the supplies model"
```

---

## Task 4: Add the 7 new full-craft recipes

Each new recipe is an ordinary flat `RECIPES` entry plus a combined `SKILL_REQS` string. Item ids: onyx `6573`, zenyte shard `19529`, gold bar `2357`, ball of wool `1759`; runes as in Task 3.

**Files:**
- Modify: `dist/app.js` — `RECIPES` array (add 7), `SKILL_REQS` map (add 7)

- [ ] **Step 1: Add the 4 Zenyte full-craft recipes**

Insert these 4 lines into `RECIPES` immediately after the existing `zenyte-ring` recipe line (the last `cat:"Zenyte"` entry):

```js
  { key:"ring-of-suffering-craft", id:19550, name:"Ring of suffering (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"necklace-of-anguish-craft", id:19547, name:"Necklace of anguish (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"tormented-bracelet-craft", id:19544, name:"Tormented bracelet (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
  { key:"amulet-of-torture-craft", id:19553, name:"Amulet of torture (full craft)", cat:"Zenyte", components:[{id:6573,qty:1},{id:19529,qty:1}], supplies:[{id:2357,qty:1},{id:1759,qty:1},{id:564,qty:1},{id:566,qty:20},{id:565,qty:20}] },
```

(The amulet has an extra `{id:1759,qty:1}` — a ball of wool — because amulets must be strung; rings, necklaces and bracelets are not.)

- [ ] **Step 2: Add the 3 Onyx full-craft recipes**

Insert `amulet-of-fury-craft` immediately after the existing `amulet-of-fury` line (in the `cat:"Misc"` block):

```js
  { key:"amulet-of-fury-craft", id:6585, name:"Amulet of fury (full craft)", cat:"Misc", components:[{id:6573,qty:1}], supplies:[{id:2357,qty:1},{id:1759,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
```

Insert these 2 lines immediately after the existing `ring-of-stone` recipe line (the last `cat:"Onyx"` entry):

```js
  { key:"ring-of-stone-craft", id:6583, name:"Ring of stone (full craft)", cat:"Onyx", components:[{id:6573,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
  { key:"berserker-necklace-craft", id:11128, name:"Berserker necklace (full craft)", cat:"Onyx", components:[{id:6573,qty:1}], supplies:[{id:2357,qty:1},{id:564,qty:1},{id:554,qty:20},{id:557,qty:20}] },
```

- [ ] **Step 3: Add the 7 combined `SKILL_REQS` entries**

In the `SKILL_REQS` object, insert these lines immediately before the closing `};` (after the `"zenyte-ring": "89 Crafting",` line):

```js
  "ring-of-suffering-craft":     "89 Crafting + 93 Magic",
  "necklace-of-anguish-craft":   "92 Crafting + 93 Magic",
  "tormented-bracelet-craft":    "95 Crafting + 93 Magic",
  "amulet-of-torture-craft":     "98 Crafting + 93 Magic",
  "amulet-of-fury-craft":        "90 Crafting + 87 Magic",
  "ring-of-stone-craft":         "67 Crafting + 87 Magic",
  "berserker-necklace-craft":    "82 Crafting + 87 Magic",
```

(Crafting levels are the highest step in each chain — sourced from the existing `SKILL_REQS` entries for `cut`/jewellery steps; Magic is the enchant level. Cutting an uncut zenyte is 89 Crafting, above `uncut-zenyte`'s 70.)

- [ ] **Step 4: Syntax-check**

Run: `cd "/Volumes/Public/runescape app" && node -c dist/app.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify — real-time mode**

Serve on a fresh port, open the app, wait for prices. In the console:

```js
for (const key of ["ring-of-suffering-craft","amulet-of-fury-craft","amulet-of-torture-craft"]) {
  const r = RECIPES.find(x => x.key === key);
  const c = calcMargin(r);
  console.log(key,
    "| GE slots:", r.components.length,            // zenyte=2, onyx=1
    "| componentCost:", Math.round(c.componentCost),
    "| suppliesCost:", Math.round(c.suppliesCost),
    "| margin:", Math.round(c.margin),
    "| skill:", SKILL_REQS[key]);
}
```

Expected: zenyte crafts show `GE slots: 2`, onyx `GE slots: 1`; all show non-zero `componentCost` and `suppliesCost`, a finite `margin`, and the combined skill string. Then visually: search "full craft", confirm 7 new cards render with a `Supplies` row, an itemising tooltip, and a `⚒` skill chip.

- [ ] **Step 6: Verify — Experimental mode**

Switch to the Experimental tab; let the analysis run. In the console:

```js
const d = window.Overnight.data;
for (const key of ["ring-of-suffering-craft","amulet-of-fury-craft"]) {
  const r = RECIPES.find(x => x.key === key);
  const c = calcMargin(r, d.predMap);
  console.log(key, "| allPresent:", c.allPresent,
    "| predicted margin:", c.margin == null ? null : Math.round(c.margin));
}
```

Expected: `allPresent: true` for both (the product + onyx + shard are predicted; supplies fall back to live prices), and a finite predicted margin — confirming supplies-on-live-prices does not break the predicted path.

- [ ] **Step 7: Commit**

```bash
cd "/Volumes/Public/runescape app" && git add dist/app.js && git commit -m "Add zenyte and onyx full-craft recipes"
```

---

## Task 5: Verify the price-history backfill still covers supply ids

No code change — this task confirms the spec's claim that `.github/workflows/backfill-prices.yml` extracts ids from inside `supplies:[…]` as well as `components:[…]`, because it greps the whole `RECIPES` literal with `/\bid:(\d+)/g`.

**Files:**
- Verify only: `.github/workflows/backfill-prices.yml`, `dist/app.js`

- [ ] **Step 1: Run the workflow's id-extraction against the current file**

Run:

```bash
cd "/Volumes/Public/runescape app" && node -e '
  const fs = require("fs");
  const src = fs.readFileSync("dist/app.js", "utf8");
  const rec = src.match(/const RECIPES = \[[\s\S]*?\n\];/)[0];
  const ids = new Set([...rec.matchAll(/\bid:(\d+)/g)].map(m => m[1]));
  // Supply ids that only appear inside supplies:[…] arrays after this feature:
  for (const id of ["1759","554","557","564","565","566","2357"])
    console.log("supply id", id, "extracted:", ids.has(id));
  console.log("total ids extracted:", ids.size);
'
```

Expected: every `supply id … extracted: true`. This confirms the hourly recorder's companion backfill will seed price history for runes, bars and wool with no workflow change.

- [ ] **Step 2: No commit**

This task changes no files. If Step 1 shows any `false`, stop and escalate — the backfill workflow would need a fix not covered by this plan.

---

## Self-Review

**Spec coverage:**
- Spec §1 (data model — optional `supplies`) → Tasks 3 & 4 add `supplies` arrays; no schema declaration is needed in this untyped codebase.
- Spec §2 (cost — `suppliesCost`, `totalCost`, `allPresent`, excluded from `maxFlips`) → Task 1. Supplies are excluded from the volume/limit bottleneck because those loops iterate `recipe.components` only and are left untouched.
- Spec §3 (display — card row, modal row, tooltip; GE-slots filter unchanged) → Task 2. The GE-slots filter counts `components.length` and needs no change.
- Spec §4 (Experimental — supplies live-priced, `overnightItemIds` unchanged, recorder/backfill unchanged) → Task 1 prices supplies from `state.prices` always; Task 4 Step 6 verifies the predicted path; Task 5 verifies the backfill.
- Spec §5 (v1 data — 7 new, 7 migrated, combined skills) → Tasks 3 & 4.
- Spec §6 (only `dist/app.js` changes) → matches; Task 5 confirms no workflow change.
- Spec §7 (testing) → the verify steps in Tasks 1–4 cover every listed check.

**Placeholder scan:** none — every step has exact code, exact ids, exact commands.

**Type/name consistency:** `suppliesCost` is the field name in `calcMargin`'s return (Task 1 Step 2) and is read in Task 2 (`calc.suppliesCost`) and Task 4 verification. Recipe field is `supplies` everywhere. New recipe keys end in `-craft` and match between `RECIPES` (Task 4 Steps 1–2) and `SKILL_REQS` (Task 4 Step 3).
