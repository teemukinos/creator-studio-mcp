# For agents

Two jobs bring an agent here. Pick yours:

- **The user asked you to install Creator Studio MCP** (or "set this up"): follow [Install](#install) below. Work from any folder; you don't need a clone.
- **You are changing this repository**: read [CONTRIBUTING.md](CONTRIBUTING.md). Run `scripts/verify.sh` before you commit.

## Install

### Done when

1. `claude mcp list` or `codex mcp list` shows `creator-studio` as connected or enabled, for each assistant you set up. For Claude desktop, the config file has the entry and parses as JSON.
2. The `studio` skill is installed for the same assistants.
3. You gave the user the hand-off message in step 6.
4. After the user restarts the assistant, `creator_studio_status` lists the installed apps. You can't check this in the session that did the install: the user checks it, or the next session does.

Don't stop before 1 to 3 are true. Don't claim 4 until someone has seen the result.

### Rules

- Every command below runs without prompts. Never run the plain `npx skills add <repo>` without flags: it waits for input.
- Don't overwrite config you didn't write. The commands below add one entry and leave the rest alone.
- Ask the user before you install Node.js, Homebrew or ffmpeg.
- The version is `0.7.1`, the version in `package.json`. Use the same version in every command.

### 1. Check the Mac

```sh
uname -s          # must print Darwin
node --version    # must be v22 or later
command -v npx    # note this full path; GUI apps need it
```

If Node is missing or older than 22, ask the user, then install the current LTS (`brew install node`, or the installer from nodejs.org).

### 2. Find the assistants to set up

```sh
command -v claude                                   # Claude Code
command -v codex                                    # Codex CLI (the Codex app reads the same config)
ls -d /Applications/Claude.app 2>/dev/null          # Claude desktop
```

Set up the assistant you are running in, plus any other the user names. If the user didn't say and several exist, set up all that exist and list them in the hand-off.

### 3. Add the server

Use the full `npx` path in every entry: apps started from the Dock don't see the shell's `PATH`.

**Claude Code**: first `claude mcp get creator-studio`. If it exits 0, an entry exists: leave it, or replace it with `claude mcp remove --scope user creator-studio` if it points at an older version. Then:

```sh
claude mcp add --scope user creator-studio -- "$(command -v npx)" -y creator-studio-mcp@0.7.1
```

**Codex**: this adds the entry to `~/.codex/config.toml`, or replaces an existing `creator-studio` entry:

```sh
codex mcp add creator-studio -- "$(command -v npx)" -y creator-studio-mcp@0.7.1
```

**Claude desktop**: the config is `~/Library/Application Support/Claude/claude_desktop_config.json`. This merges one entry, keeps everything else, and saves the old file as `.bak`:

```sh
node -e '
const fs = require("fs"), path = require("path"), [f, npx] = process.argv.slice(1);
let j = {};
if (fs.existsSync(f)) { j = JSON.parse(fs.readFileSync(f, "utf8")); fs.copyFileSync(f, f + ".bak"); }
j.mcpServers = { ...j.mcpServers, "creator-studio": { command: npx, args: ["-y", "creator-studio-mcp@0.7.1"] } };
fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
console.log("updated " + f);
' "$HOME/Library/Application Support/Claude/claude_desktop_config.json" "$(command -v npx)"
```

If the file isn't valid JSON, the command stops and changes nothing. Show the user the error instead of rewriting the file.

If `npx` can't find the package (npm returns 404), install from a clone instead: see "Install from a clone" in [`skills/studio/references/setup.md`](skills/studio/references/setup.md). Clone into `~/.local/share/creator-studio-mcp` unless the user names a place.

### 4. Install the skill

Pick the `-a` values for the assistants you set up (`claude-code`, `codex`):

```sh
npx -y skills add teemukinos/creator-studio-mcp -g -a claude-code -a codex -y
```

Claude desktop and claude.ai can't install skills from the shell. Tell the user to download `studio.zip` from the [latest release](https://github.com/teemukinos/creator-studio-mcp/releases/latest) and upload it as a skill in Claude's settings.

### 5. Check from the shell

```sh
claude mcp list    # expect: creator-studio: ... ✔ Connected
codex mcp list     # expect: creator-studio ... enabled
```

The first run downloads the package, so it can take a minute. If the entry shows as failed, read [Troubleshooting](skills/studio/references/setup.md#troubleshooting).

The video route also uses ffmpeg (`command -v ffmpeg`). If it is missing, say so in the hand-off; don't install it without asking.

### 6. Hand off to the user

Only the user can do these steps. Send them this, with the app names filled in (the "host app" is the app that runs the assistant: Claude, Codex, Terminal, iTerm2 or the editor):

> Creator Studio MCP is installed for <assistants>. Three things only you can do:
>
> 1. **Restart** <assistants> so they load the new server.
> 2. **Accessibility**: in System Settings > Privacy & Security > Accessibility, turn on <host app>. The menu and dialog tools need it.
> 3. **Open each Creator Studio app once by hand** and click through any welcome or subscription screen. Those screens block automation.
>
> The first time a tool uses an app, macOS asks whether <host app> may control it: click **Allow**. Screen Recording is needed only for screenshots.
>
> Then ask me to run `creator_studio_status` to confirm.

## Update

Change the version in each entry, then restart the assistant:

```sh
claude mcp remove --scope user creator-studio
claude mcp add --scope user creator-studio -- "$(command -v npx)" -y creator-studio-mcp@<new version>
codex mcp add creator-studio -- "$(command -v npx)" -y creator-studio-mcp@<new version>
```

For Claude desktop, run the merge command from step 3 with the new version. To update the skill, run the `skills add` command from step 4 again: it replaces the installed copy.

## Uninstall

```sh
claude mcp remove --scope user creator-studio
codex mcp remove creator-studio
npx -y skills remove studio -g -y
```

For Claude desktop, delete the `creator-studio` entry under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app.

Two things stay behind, and both are the user's to delete: the learning ledger in `~/.studio/` and the job folders in `~/Studio/`. Ask before removing either. Permissions granted in System Settings stay too; the user can turn them off there.
