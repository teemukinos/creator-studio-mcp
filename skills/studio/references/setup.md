# Set up the creator-studio server

This skill drives the apps through the `creator-studio` MCP server, version 0.7.1 or later. Set it up once per Mac, then once per assistant.

In Claude chat the shell isn't on the Mac, so you can't run these steps yourself: give the user the commands and ask them to report the result.

## Install the server

Add one config entry per assistant. Use full paths: GUI apps don't see the shell's `PATH`. Get the path of `npx` with `which npx` and put it where `<npx path>` appears below.

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

**Claude desktop**: open Settings > Developer > Edit Config and merge this entry into the file, then quit and reopen the app.

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

## Fallback: install from a clone

Use this while the npm package isn't available yet.

```sh
git clone https://github.com/teemukinos/creator-studio-mcp
cd creator-studio-mcp
npm install --omit=dev
```

Then point the same config entries at the built server. Use the full path from `which node` as the command, and the full path to `dist/index.js` in the clone as the only argument:

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

Restart the assistant and call `creator_studio_status`. It lists each app it found. Blender, the Rive CLI and Godot are needed only for jobs that use them.
