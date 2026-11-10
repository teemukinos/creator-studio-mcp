# Creator Studio MCP server

An MCP server that lets Claude (or any MCP client) drive the Apple Creator Studio apps on your Mac: **Pixelmator Pro**, **Keynote**, **Pages**, **Numbers**, **Compressor** and **Final Cut Pro**.

Everything runs locally. The server talks to the apps through AppleScript (`osascript`), Compressor's command-line tool, and FCPXML files. Nothing is sent over the network.

## Tools

| App | Tool | What it does |
|---|---|---|
| All | `creator_studio_status` | Installed copies of each app, which one is targeted, whether it's running |
| Pixelmator Pro | `pixelmator_process_image` | ML ops (remove background, super resolution, enhance, denoise, deband), auto adjustments, color adjustments, crop, resize, export to png/jpeg/heic/webp/avif/tiff/psd/pdf/gif/pxd |
| | `pixelmator_batch_process` | Same pipeline over a folder or list of files; one failure doesn't stop the batch |
| | `pixelmator_image_info` | Size, resolution, bit depth, color profile, layers and text-layer contents |
| | `pixelmator_replace_text` | Fill a layered template: replace text across all text layers, export |
| Keynote | `keynote_list_themes` | Available themes |
| | `keynote_create_presentation` | New deck from a theme + slides (title, body, notes, layout) |
| | `keynote_read_presentation` | Every slide's layout, title, body, notes, skipped state |
| Pages | `pages_list_templates`, `pages_create_document`, `pages_read_document` | Templates, new document with body text, read body text |
| Numbers | `numbers_read_table` | Sheets/tables list and one table's displayed values |
| | `numbers_write_cells` | Write cells by A1 reference or a block of rows |
| | `numbers_create_spreadsheet` | New spreadsheet from rows |
| iWork | `iwork_export` | Keynote → pdf/pptx/mov/images · Pages → pdf/docx/epub/txt · Numbers → pdf/xlsx/csv |
| Compressor | `compressor_list_settings` | Your custom and built-in transcode settings |
| | `compressor_transcode` | Submit a job; optionally wait for the output to finish |
| Final Cut Pro | `finalcut_list_libraries` | Open libraries → events → projects |
| | `finalcut_build_timeline` | Rough cut from media files (in/out points, markers, chapter markers) as FCPXML, validated against FCP's own DTD, optionally pushed into a library |
| | `finalcut_import_fcpxml` | Import an existing FCPXML into a library |

### No editors on screen

Nothing this server drives is meant to be seen. Creator Studio apps launch hidden (`open -g -j`) and are hidden again after every tool call. Blender runs in background mode, Rive runs as a command-line build and Godot runs with `--headless`, so none of them opens a window.

| Tool | What it does |
|---|---|
| `blender_run_python` | Runs Blender headless (`-b`) with your Python (bpy): model, animate, render stills or sequences, export `.glb`. Each call is a fresh process; save `.blend` files to keep work. |
| `rive_cli` | Runs the Rive CLI on text projects (Rive Markup Language): `create`, `--verify`, `--once` builds a `.riv`. Refuses the bare `rive <project>` form, which opens a preview window. |
| `godot_cli` | Runs Godot 4 with `--headless` on a text project: `--import`, smoke tests (`--quit-after N`), `--export-release`, and GDScript via `code` or `scriptPath`. Collects `ERROR:`/`SCRIPT ERROR:` lines and fails on them. Refuses the project manager and window-only flags; `allowWindow: true` is only for Movie Maker captures. Finds Godot.app in Applications, or `GODOT_APP` / `GODOT_BIN`, or `godot` on PATH. |

Every UI tool checks first whether the screen is locked. While it is, hidden apps show no windows, so the tool stops with a clear error instead of returning an empty result.

### Reaching every expert feature

Apple's scripting dictionaries only cover part of each app, and Final Cut Pro, Motion, Logic Pro, Compressor and MainStage have little or none. These tools reach everything else (AI features, effects, exports, inspectors) the way you do: through the app's menus, buttons and dialogs, using macOS Accessibility.

| Tool | What it does |
|---|---|
| `app_open` | Launch an app, optionally opening a file or project in it |
| `ui_list_menus` | Every menu command as a path, with disabled ones marked: the map of what an app can do. With `outFile`, writes the map to a file and returns only the count |
| `ui_click_menu` | Run a command, e.g. `["Slide", "Generate Presenter Notes"]` or `["Object", "Add Magnetic Mask"]` |
| `ui_snapshot` / `ui_find` | Read windows, panels, inspectors and dialogs, with element ids. Snapshots default to depth 6 and 120 elements, with a hint when cut off |
| `ui_click` / `ui_set_value` / `ui_type_text` / `ui_press_key` | Press buttons, fill fields, type, use keyboard shortcuts |
| `ui_wait_for` | Wait for a long job (generation, analysis, export) to start or finish |
| `ui_batch` | Run a known sequence of steps with one call, from a list or a recipe file. Pop-ups stay open between steps, and it writes progress to a status file so long jobs outlast the 60 s bridge limit. `requireAbsent` stops a run when an earlier run left a file behind; the status lists optional steps that were skipped |
| `ui_screenshot` | See the app window, e.g. a canvas or timeline |
| `app_shortcut_actions`, `shortcuts_list`, `shortcuts_run` | Use apps' Shortcuts actions and run your shortcuts |

Tested on Creator Studio: Keynote's **Generate Presenter Notes** (generated notes read back), Final Cut Pro's **Enhance Light and Color** on a timeline built and imported by the server, and Motion's full menu and project browser. Final Cut's Generate Captions, Beat Detection, Smart Conform, Magnetic Mask, Auto Mask, Enhance Audio and Export XML are all reachable the same way.

Apps are driven **in the background**: menu commands and buttons are pressed through Accessibility, shortcuts are sent straight to the app's process, files open with `open -g`, and screenshots capture the app's window even when it's covered. Your screen isn't taken over. Pass `front: true` to bring an app forward.

Extra permissions for these tools: **Accessibility** (System Settings › Privacy & Security › Accessibility) for the app that runs the server (Claude, your terminal, Codex or your editor), and **Screen Recording** for `ui_screenshot`.

Open each app once by hand after installing it: first-run welcome and subscription screens block automation until they're dismissed.

Safety defaults: paths must be absolute (or start with `~/`); no tool overwrites an existing file unless you pass `overwrite: true`, and none writes over its own input. The one exception is `numbers_write_cells` without an `output`, which saves the spreadsheet in place (its description says so, and it's marked destructive so clients can ask first). Documents opened by the server are always closed without saving changes to the source.

## Requirements

- macOS with the apps you want to use installed (any subset works)
- Node.js 20 or later (`node --version`)

## Install

```sh
cd creator-studio-mcp
npm install
npm run build
```

`dist/` is included prebuilt, so `npm install --omit=dev` alone is enough if you don't want to rebuild.

## Add it to Claude Desktop

1. In the Claude menu bar menu, open **Settings… › Developer › Edit Config**. This opens `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. Add the server. Use full paths: the app doesn't see your shell's `PATH`, so get Node's path with `which node`.

```json
{
  "mcpServers": {
    "creator-studio": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOU/creator-studio-mcp/dist/index.js"]
    }
  }
}
```

3. Quit Claude completely and reopen it. The tools appear under the connectors menu in the message box.

For Claude Code: `claude mcp add creator-studio -- node /Users/YOU/creator-studio-mcp/dist/index.js`

## First run: permissions

The first time a tool talks to each app, macOS asks whether Claude may control it. Click **Allow**. If you clicked Don't Allow, re-enable it in **System Settings › Privacy & Security › Automation** (or run `tccutil reset AppleEvents`). A denied permission shows up as error `-1743`.

## Creator Studio vs one-time-purchase editions

Creator Studio editions install as separate apps, e.g. `Keynote Creator Studio.app` with bundle ID `com.apple.Keynote`, next to any older edition. The server finds every copy in `/Applications` and `~/Applications`, prefers the Creator Studio edition, and targets it by path when copies would be ambiguous. Ask your assistant to run `creator_studio_status` to see what it found. To pin a specific copy, add an `env` block to the config:

```json
"env": {
  "FINALCUT_APP": "/Applications/Final Cut Pro.app",
  "PIXELMATOR_APP": "/Applications/Pixelmator Pro.app"
}
```

Variables: `PIXELMATOR_APP`, `KEYNOTE_APP`, `PAGES_APP`, `NUMBERS_APP`, `FINALCUT_APP`, `COMPRESSOR_APP`.

## Things to know

- **Dialogs block automation.** If Pixelmator Pro (or any app) shows an alert, every script to it waits until someone dismisses it. A tool that times out usually means a dialog is open.
- **Pixelmator Pro is sandboxed.** The scripts coerce file paths in the way that gives the app a sandbox grant, so files outside `~/Pictures` open reliably. `super_resolution` is always ×3; combine it with `resize` to hit a target size. `remove_background` needs a format with transparency (png, webp, heic, tiff) to keep the cut-out.
- **Final Cut Pro's scripting dictionary is read-only.** Import works through FCPXML; everything else, including **File › Export XML**, Share/export and the AI features, goes through the `ui_*` tools.
- **Final Cut imports need a library.** On current versions an FCPXML import without a target library silently does nothing, so the import tools require `libraryLocation`. An existing `.fcpbundle` is used; a new path creates a library. Importing a project whose media is already in the target library can fail with a duplicate-media error; a fresh library avoids it.
- **Timelines are frame-accurate.** Clip lengths are rounded down to whole frames of the project frame rate. Media lengths come from Spotlight, falling back to AVFoundation for unindexed files; pass `durationSeconds` per clip to override.
- **Numbers CSV export** of a file with several tables produces a folder with one CSV per table.
- **Compressor output paths** should include the extension the chosen setting produces (`.mp4`, `.mov`, `.m4a`, …).

## Develop

```sh
npm test          # unit tests for script generation, FCPXML, paths
npm run inspect   # open the MCP Inspector against the built server
```

Layout: `src/scripts/*` build AppleScript (user values are always passed as `argv`, never pasted into script text), `src/fcpxml.ts` generates timelines, `src/tools/*` define the MCP tools, `src/index.ts` serves them over stdio with `@modelcontextprotocol/server` 2.x.
