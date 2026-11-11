# Set up the creator-studio server

This skill drives the apps through the `creator-studio` MCP server, version 0.7.1 or later. Set it up once per Mac, then once per assistant.

In Claude chat the shell isn't on the Mac, so you can't run these steps yourself: give the user the commands and ask them to report the result. An agent with a shell can follow the step-by-step version with prompt-free commands and a hand-off message: `AGENTS.md` in the repository (https://github.com/teemukinos/creator-studio-mcp/blob/main/AGENTS.md).

## Install the server

The server needs macOS and Node.js 22 or later. Check with `node --version`; if it's missing or older, install the current LTS from nodejs.org or with Homebrew (`brew install node`).

Add one config entry per assistant. Apps started from the Dock (Claude desktop, the Codex app) don't see the shell's `PATH`, so their entries need full paths: get the path of `npx` with `which npx` and put it where `<npx path>` appears below. Claude Code started from a terminal inherits the shell's `PATH`, so plain `npx` works there.

**Claude Code**

```sh
claude mcp add --scope user creator-studio -- npx -y creator-studio-mcp@0.7.1
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.creator-studio]
command = "<npx path>"
args = ["-y", "creator-studio-mcp@0.7.1"]
```

**Claude desktop**: open Settings > Developer > Edit Config (the file is `~/Library/Application Support/Claude/claude_desktop_config.json`) and merge this entry into the file without removing other entries, then quit and reopen the app.

```json
{
  "mcpServers": {
    "creator-studio": {
      "command": "<npx path>",
      "args": ["-y", "creator-studio-mcp@0.7.1"]
    }
  }
}
```

If an app reports `env: node: No such file or directory`, `npx` can't find Node. Add the folder that holds `node` to the entry's environment: `"env": { "PATH": "<node folder>:/usr/bin:/bin" }` in JSON, or `env = { PATH = "<node folder>:/usr/bin:/bin" }` in TOML.

## Install from a clone

Use this when `npx` can't fetch the package (for example on a Mac without access to the npm registry), or to run an unreleased version. Clone into a folder that stays, such as `~/.local/share/creator-studio-mcp`.

```sh
git clone https://github.com/teemukinos/creator-studio-mcp
cd creator-studio-mcp
npm install --omit=dev
```

Then point the same config entries at the built server. Use the full path from `which node` as the command, and the full path to `dist/index.js` in the clone as the only argument. For Claude Code, from inside the clone:

```sh
claude mcp add --scope user creator-studio -- "$(which node)" "$PWD/dist/index.js"
```

## Permissions

Only the user can grant these, in System Settings > Privacy & Security:

- **Accessibility** for the app that runs the server (Claude, the terminal, Codex or the editor). The UI tools need it.
- **Automation**: click **Allow** the first time macOS asks whether the app may control each Creator Studio app. A denied permission shows up as error `-1743`.
- **Screen Recording**, only for `ui_screenshot`.

## First launch

Open each app by hand once. First-run welcome and subscription screens block automation until they are dismissed.

## Verify

From a shell, `claude mcp list` should show `creator-studio: ... ✔ Connected` and `codex mcp list` should show it `enabled`. Then restart the assistant and call `creator_studio_status`. It lists each app it found. Blender, the Rive CLI and Godot are needed only for jobs that use them, and ffmpeg only for `scripts/render_fcpxml.py`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The `creator-studio` tools don't appear | The assistant hasn't restarted, or the entry is wrong | Restart the assistant. Run `claude mcp list` or `codex mcp list` and fix the entry it reports as failed |
| `env: node: No such file or directory` | A Dock app can't find Node | Add the `env` `PATH` fix from "Install the server" |
| `npm error 404` for `creator-studio-mcp` | The version isn't on the npm registry | Check the version in the entry, or install from a clone |
| `creator_studio_status` shows an app as not installed | It isn't in `/Applications` or `~/Applications` | Pin it with an `env` entry such as `"FINALCUT_APP": "/path/to/Final Cut Pro.app"` (variables: `PIXELMATOR_APP`, `KEYNOTE_APP`, `PAGES_APP`, `NUMBERS_APP`, `FINALCUT_APP`, `COMPRESSOR_APP`, `MOTION_APP`, `LOGIC_APP`, `MAINSTAGE_APP`, `BLENDER_APP`, `GODOT_APP`, plus `GODOT_BIN` and `RIVE_CLI` for executables) |
| Error `-1743` | Automation was denied for that app | System Settings > Privacy & Security > Automation: turn the app on for the host app. Or run `tccutil reset AppleEvents` and click Allow at the next prompt |
| "not allowed assistive access" | Accessibility is off for the host app | System Settings > Privacy & Security > Accessibility: turn on the app that runs the assistant |
| "The screen is locked" | Hidden apps show no windows while the Mac is locked | Unlock the Mac, then run the call again |
| A tool times out, or an app stops responding | A dialog or a first-run screen is open in that app | `ui_snapshot` the app to read the dialog. Dismiss a "What's New" dialog; ask the user to click through welcome or subscription screens |
| A menu item stays disabled | Nothing is selected, no document is open, or the app has never been in front | Select or open something first. Some commands (Pixelmator Pro's Export, Final Cut's Share) need the app in front: use a direct tool or a headless route instead |
| `ui_screenshot` returns nothing useful | Screen Recording is off, or the app is hidden | Turn on Screen Recording for the host app. Check results from files instead |
