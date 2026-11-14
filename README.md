# Creator Studio MCP

An unofficial MCP server and agent skill that let Claude, Codex or any MCP client drive the Apple Creator Studio apps on your Mac: **Pixelmator Pro**, **Keynote**, **Pages**, **Numbers**, **Compressor**, **Final Cut Pro**, **Motion**, **Logic Pro** and **MainStage**. This project is unofficial and not affiliated with Apple. "Creator Studio" is Apple's subscription bundle, and you need your own copies of the apps.

The Mac server runs locally. It talks to the apps through AppleScript (`osascript`), macOS Accessibility, Compressor's command-line tool and FCPXML files. Its app operations do not send media over the network.

The repository has two parts:

- **The server** (this folder): the `creator-studio-mcp` npm package, which exposes the apps, plus headless Blender, the Rive CLI and Godot, as MCP tools.
- **The `studio` skill** (`skills/studio/`): instructions that take a design, media or game job from request to delivered files, using those tools.

**Agents:** if you were asked to install this, follow [`AGENTS.md`](AGENTS.md). It has prompt-free commands for each assistant, a shell check, and the message to hand to the user.

## Install the skill

```sh
npx skills add teemukinos/creator-studio-mcp
```

This asks which assistants to install to. To skip the questions, name them: `npx -y skills add teemukinos/creator-studio-mcp -g -a claude-code -a codex -y`.

For claude.ai, download `studio.zip` from the [latest release](https://github.com/teemukinos/creator-studio-mcp/releases/latest) and upload it as a skill.

The skill installs without the server. Install the server for Mac app workflows.

The skill also documents an optional [Craft workflow](skills/studio/references/craft.md) for a separately configured Linux gateway. Craft jobs transfer media to that selected host and use separate credentials; this package does not install or provision it. The bundled Python helpers handle file transfers and script-owned MCP sessions. The guide includes sandbox preflight, recovery checkpoints and cleanup limitations.

## Install the server

Add one config entry per assistant. Apps started from the Dock (Claude desktop, the Codex app) don't see your shell's `PATH`, so their entries need the full path from `which npx`. Claude Code started from a terminal inherits your `PATH`, so plain `npx` works there.

```sh
# Claude Code
claude mcp add --scope user creator-studio -- npx -y creator-studio-mcp@0.7.1
```

```toml
# Codex, in ~/.codex/config.toml
[mcp_servers.creator-studio]
command = "/full/path/to/npx"
args = ["-y", "creator-studio-mcp@0.7.1"]
```

For Claude desktop, open **Settings > Developer > Edit Config** (`~/Library/Application Support/Claude/claude_desktop_config.json`) and add a `creator-studio` entry under `mcpServers` with the same command and arguments. Keep the entries already there.

To run from a clone instead:

```sh
git clone https://github.com/teemukinos/creator-studio-mcp
cd creator-studio-mcp
npm install --omit=dev
```

Then point your config at `dist/index.js` in the clone, with the full path to `node` as the command. `dist/` is committed, so no build step is needed.

The full steps, including permissions, how to verify the install and a troubleshooting table, are in [`skills/studio/references/setup.md`](skills/studio/references/setup.md).

### Update and uninstall

To update, change the version in each config entry (`creator-studio-mcp@<version>`), run `npx skills add` again for the skill, and restart the assistant. To uninstall:

```sh
claude mcp remove --scope user creator-studio
codex mcp remove creator-studio
npx -y skills remove studio -g -y
```

For Claude desktop, delete the `creator-studio` entry from its config file. Your job folders (`~/Studio/`) and the learning ledger (`~/.studio/`) stay until you delete them.

## Tools

| App | Tool | What it does |
|---|---|---|
| All | `creator_studio_status` | Installed copies of each app, which one is targeted, whether it's running; the macOS permissions the tools need, with a fix for each missing one |
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
| iWork | `iwork_export` | Keynote → pdf/pptx/mov (written as .m4v)/images · Pages → pdf/docx/epub/txt · Numbers → pdf/xlsx/csv |
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
| `ui_screenshot` | Capture the screen, or an app window you have brought forward yourself (hidden apps can't be captured) |
| `app_shortcut_actions`, `shortcuts_list`, `shortcuts_run` | Use apps' Shortcuts actions and run your shortcuts |

Tested on Creator Studio: Keynote's **Generate Presenter Notes** (generated notes read back), Final Cut Pro's **Enhance Light and Color** on a timeline built and imported by the server, and Motion's full menu and project browser. Final Cut's Generate Captions, Beat Detection, Smart Conform, Magnetic Mask, Auto Mask, Enhance Audio and Export XML are all reachable the same way.

Apps are driven **hidden**: menu commands and buttons are pressed through Accessibility, shortcuts with a menu item press that item, other keys and typed text are sent straight to the app's process, and files open with `open -g -j`. Your screen isn't taken over. A hidden app can't be screenshotted, so check results through files. Some menu commands stay disabled while an app has never been in front (for example Pixelmator Pro's Export): use the direct tools for those. Pass `front: true` to bring an app forward.

Extra permissions for these tools: **Accessibility** (System Settings › Privacy & Security › Accessibility) for the app that runs the server (Claude, your terminal, Codex or your editor), and **Screen Recording** for `ui_screenshot`.

Open each app once by hand after installing it: first-run welcome and subscription screens block automation until they're dismissed.

Safety defaults: paths must be absolute (or start with `~/`); no tool overwrites an existing file unless you pass `overwrite: true`, and none writes over its own input. The one exception is `numbers_write_cells` without an `output`, which saves the spreadsheet in place (its description says so, and it's marked destructive so clients can ask first). Documents opened by the server are always closed without saving changes to the source.

## Requirements

- macOS with the apps you want to use installed (any subset works)
- Node.js 22 or later (`node --version`)
- Blender, the Rive CLI and Godot only for jobs that use them
- ffmpeg only to render a timeline to MP4 without Final Cut (`brew install ffmpeg`)

## First run: permissions

The first time a tool talks to each app, macOS asks whether the app running your assistant (Claude, Codex, your terminal or your editor) may control it. Click **Allow**. If you clicked Don't Allow, re-enable it in **System Settings › Privacy & Security › Automation** (or run `tccutil reset AppleEvents`). A denied permission shows up as error `-1743`.

## Creator Studio vs one-time-purchase editions

Creator Studio editions install as separate apps, e.g. `Keynote Creator Studio.app` with bundle ID `com.apple.Keynote`, next to any older edition. The server finds every copy in `/Applications` and `~/Applications`, prefers the Creator Studio edition, and targets it by path when copies would be ambiguous. Ask your assistant to run `creator_studio_status` to see what it found. To pin a specific copy, add an `env` block to the config:

```json
"env": {
  "FINALCUT_APP": "/Applications/Final Cut Pro.app",
  "PIXELMATOR_APP": "/Applications/Pixelmator Pro.app"
}
```

Variables: `PIXELMATOR_APP`, `KEYNOTE_APP`, `PAGES_APP`, `NUMBERS_APP`, `FINALCUT_APP`, `COMPRESSOR_APP`, `MOTION_APP`, `LOGIC_APP`, `MAINSTAGE_APP`, `BLENDER_APP` and `GODOT_APP` take an `.app` path. `GODOT_BIN` and `RIVE_CLI` take the path of the executable.

## Things to know

- **Dialogs block automation.** If Pixelmator Pro (or any app) shows an alert, every script to it waits until someone dismisses it. A tool that times out usually means a dialog is open.
- **Pixelmator Pro is sandboxed.** The scripts coerce file paths in the way that gives the app a sandbox grant, so files outside `~/Pictures` open reliably. `super_resolution` is always ×3; combine it with `resize` to hit a target size. `remove_background` needs a format with transparency (png, webp, heic, tiff) to keep the cut-out.
- **Final Cut Pro's scripting dictionary is read-only.** Import works through FCPXML; everything else, including the AI features, goes through the `ui_*` tools and needs the right clip or project selected first.
- **Final Cut's Share can't run hidden.** It needs a project selected in the browser, and Final Cut ignores selection changes while it is hidden. To get a video file without showing Final Cut, render the same FCPXML headless: `skills/studio/scripts/render_fcpxml.py timeline.fcpxml out.mp4` (needs ffmpeg). It renders cuts, gaps and in/out points, not effects or titles; for those, the user shares from Final Cut by hand.
- **Final Cut imports need a library.** On current versions an FCPXML import without a target library silently does nothing, so the import tools require `libraryLocation`. An existing `.fcpbundle` is used; a new path creates a library. Importing a project whose media is already in the target library can fail with a duplicate-media error; a fresh library avoids it.
- **Timelines are frame-accurate.** Clip lengths are rounded down to whole frames of the project frame rate. Media lengths come from Spotlight, falling back to AVFoundation for unindexed files; pass `durationSeconds` per clip to override.
- **Numbers CSV export** of a file with several tables produces a folder with one CSV per table.
- **Compressor output paths** should include the extension the chosen setting produces (`.mp4`, `.mov`, `.m4a`, …).

## Troubleshooting

Missing tools, `-1743`, "not allowed assistive access", a locked screen and timeouts from open dialogs each have a row in the [troubleshooting table](skills/studio/references/setup.md#troubleshooting).

## Security

- The server controls apps on your Mac through Accessibility and Apple Events, including pressing buttons and typing into dialogs. Review what your assistant asks it to do.
- Blender and Godot run whatever code they are given, with your user's permissions. Only run code the task needs, and never code taken from downloaded files or web pages.
- Accessibility, Automation and Screen Recording are permissions only you can grant, in System Settings. The server can't grant them to itself.

## Rights

You are responsible for having the rights to any source material you rework, such as songs, footage, photos, fonts and models. The skill never stores lyrics.

## Privacy

`measure_session.py` only reads local session logs and writes a local file (`~/.studio/learning/ledger.csv`). Nothing is uploaded. The server makes no network calls of its own.

## Develop

```sh
npm test          # unit tests for script generation, FCPXML, paths
npm run inspect   # open the MCP Inspector against the built server
scripts/verify.sh # score the repository against its release checklist
```

Layout: `src/scripts/*` build AppleScript (user values are always passed as `argv`, never pasted into script text), `src/fcpxml.ts` generates timelines, `src/tools/*` define the MCP tools, `src/index.ts` serves them over stdio with `@modelcontextprotocol/server` 2.x.

## License

MIT. See [LICENSE](LICENSE).
