# UI tools (ui_* and ui_batch)

## Two modes

- **Known route**: a recipe exists in the app's reference file or the job's `scripts/`. Run it with `ui_batch`, one call per route. Use `dryRun: true` first when the recipe or the app version is new.
- **Unknown route**: read the app's Dead ends first. Then explore with single `ui_*` calls. When the route works, write it as a recipe JSON in the job's `scripts/` in the same session, with an `assert` for every value that matters (format, sample rate, size, name), and log it in `plan.md`. Asserts inside a batch cost no extra requests, so be generous with them.

The `ui_batch` tool description lists its ops. Don't copy them here. Start every recipe with `requireUnlocked`, `requireClosed` where the app needs a fresh launch, and `requireAbsent` for every file the run will wait for or move into place. When a run is done, read its `skipped` list before trusting it.

## Exploring with single calls

1. **Map**: `ui_list_menus` with `menu` set and depth 2. For a whole app, pass `outFile` (for example the job's `logs/<app>-menus.txt`) and grep the file: a full map can be 25k characters.
2. **Context**: `app_open`, focus the pane (`ui_click_menu ["Window","Go To","Timeline"]`), select (`["Edit","Select All"]`).
3. **Run**: `ui_click_menu` with the path. Matching ignores case and trailing "…". Prefer menu commands over keyboard shortcuts.
4. **Dialogs**: `ui_snapshot` defaults to depth 6 and 120 elements. When it says truncated, pass `within` for the part you need rather than raising the limits for the whole window. Then `ui_set_value` / `ui_click` by id; prefer ids over text when several match. Click a pop-up item in the same message as the click that opens it, or you get "Invalid index".
5. **Verify** through files or read-back, never assume: a direct tool, `ui_find` on the changed control, or the Edit menu's Undo item. `ui_screenshot` can't see a hidden app.

If a step fails: one `ui_snapshot`, one retry. A second failure on the same step: stop, add it to the inbox as a dead-end (SKILL.md A8), take the fallback.

## Waiting

Long jobs (export, bounce, render, generation, analysis) run in the background and write a status file: `ui_batch` does this by default. Wait with one shell call:

```
sh <skill folder>/scripts/wait_status.sh <statusFile> 270
```

`<skill folder>` is the folder that holds SKILL.md.

In Claude Code use a Bash timeout of 300000 ms. In Claude chat the device shell allows 180 s, so pass 170 and put the status file in a connected folder. The script prints one line. Repeat only while it says `state=running`. Up to 270 s keeps the prompt cache warm; it expires after 5 minutes, and the next request then pays to rewrite the whole context. Don't call `ui_wait_for` or `ui_batch` again just to see progress.

For a file that appears without a status file (a Final Cut share, a Compressor job), use `ui_batch` with a `waitFile` step, which also writes a status file.

## Before a UI session

- **Screen unlocked**: every `ui_*` call and every batch run refuses with "The screen is locked" while the Mac is locked (creator-studio 0.7.1). When you see it, stop and tell the user; don't retry until they say it's unlocked.
- **One project per launch** for apps that lose their windows on a second document while hidden (Logic does). Recipes start with `requireClosed`.
- **The bridge times out at 60 s**, but the work keeps running on the Mac. Check the output file or app state before re-running.
- **First-run screens block automation.** A "What's New" dialog with Continue is safe to dismiss. Welcome or subscription screens with unlabeled buttons are not: ask the user to click through.
- **Permissions**: Accessibility (UI tools) and Screen Recording (`ui_screenshot`) must be on for the app running the server. "Not allowed assistive access" means Accessibility is off.
- Pass apps as `finalcut`, `motion`, `logic`, `mainstage`, `compressor`, `pixelmator`, `keynote`, `pages`, `numbers`.
