# Handoff — pick up work in a new Claude session

Read this first when returning to the project after a break, from a
different machine, or in a fresh Claude session. Everything below is the
current, load-bearing context.

## What this project is

**Big Timby's Little Tool** — OSRS Grand Exchange margin tracker.

- **Web app** at [big-timbys-little-tool.vercel.app](https://big-timbys-little-tool.vercel.app)
  — allocator, predictive analysis, fill-probability calibration.
  Lives in `dist/`. Deployed to Vercel; push to `main` = auto-deploy.
- **RuneLite plugin** under `plugin/` — surfaces the web app's
  recommendations inside the OSRS client as an overlay on the GE screen.
  Personal / dev-mode only. See `plugin/HANDOFF.md` for the deep dive.
- **Backend endpoint** at `dist/api/recommend.js` — Vercel serverless
  function powering the plugin (returns per-item recommendation JSON).

## Current state (as of this doc)

- **Web app**: live, actively maintained. Latest deploy version tag lives
  in `dist/index.html` (`v=NN` on the script tags).
- **Backend `/api/recommend`**: deployed to production. Test with
  `curl 'https://big-timbys-little-tool.vercel.app/api/recommend?id=12852'`.
- **Plugin**: skeleton written, committed. **Never run end-to-end** —
  was blocked on macOS-specific setup friction (Jagex Launcher +
  App Translocation + signed .app internals). Should work cleanly on
  Windows.

## Branch layout

- **`main`** — the deployed state. Every commit here auto-deploys the
  web app to Vercel. Latest work is cherry-picked over from
  `worktree-history-tab`.
- **`worktree-history-tab`** — the working branch. All new features
  land here first, then get cherry-picked to `main` when ready to ship.
  **When you clone, `git checkout worktree-history-tab` immediately** —
  the plugin work and some site iterations live here first.

## Repo pointers

- Remote: `https://github.com/crazyhairmartin-ship-it/big-timbys-little-tool.git`
- Live site: `https://big-timbys-little-tool.vercel.app`
- Wiki API this project consumes: `prices.runescape.wiki/api/v1/osrs/*`

## Picking up plugin work (the currently-parked stream)

You're most likely here because you want to continue the plugin work.

1. `git clone https://github.com/crazyhairmartin-ship-it/big-timbys-little-tool.git`
2. `cd big-timbys-little-tool && git checkout worktree-history-tab`
3. Read `plugin/HANDOFF.md` — full plugin-specific context (design
   decisions locked in, next steps in priority order, backlog, ban-risk
   research so you don't redo it).
4. Follow `plugin/README.md` § "Run in Path C" to actually build/run it.

If you're in a fresh Claude session, tell it:

> Read `plugin/HANDOFF.md` and let's continue the plugin work.

Claude will absorb the context and pick up from step 1 of the plugin
handoff (getting the plugin running locally on the current machine).

## Picking up web app work

- Read this file, `README.md`, and skim `dist/app.js` for the section
  you're touching (search for the feature name — most sections have a
  block comment explaining the intent).
- Standard flow: edit `dist/app.js` / `dist/index.html` / `dist/index.css`
  → bump the `v=NN` cache-buster in `dist/index.html` → commit to
  `worktree-history-tab` → cherry-pick to `main` → auto-deploys.
- **Confirm with the user before any push.** `main` = production deploy.
- **Wait for Vercel Production build before syncing feature branches** —
  Preview builds hog the queue and Prod needs manual promotion. See
  `~/.claude/projects/…/memory/feedback_vercel_deploy_pacing.md` (if
  Claude memory is available on the current machine).

## Auto-memory (Claude-side, per-machine)

Claude Code stores per-machine memory at
`~/.claude/projects/<project-slug>/memory/`. That memory is NOT synced
across machines — a fresh Claude on a new machine has none of it.
Everything the memory would carry (user preferences, past decisions,
project state) lives redundantly in this file + `plugin/HANDOFF.md`,
so you're covered even without the memory.
