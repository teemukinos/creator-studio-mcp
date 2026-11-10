# Godot (headless)

Godot 4 projects are text (`project.godot`, `.tscn`, `.tres`, `.gd`), so assistants write them directly and drive the engine from the command line.

**Use `godot_cli`** with `projectPath` set to the job's `game/` folder. It always adds `--headless`, finds Godot (Godot.app in Applications, `GODOT_APP`/`GODOT_BIN`, or `godot` on PATH), collects `ERROR:`/`SCRIPT ERROR:` lines and fails the call on them, because Godot often exits 0 after a script error. Inline `code` without an `extends` line runs as a SceneTree script that quits when done. In a Mac shell, use the commands below directly. Record the version (`args ["--version"]`) in `plan.md`; export templates must match it exactly.

**Core commands** (shell form; with `godot_cli`, pass only what follows `--path game`):

| Job | Command |
|---|---|
| Import assets, generate `.import`/`.uid` files | `<godot> --headless --path game --import` (older 4.x: `--headless --editor --quit`) |
| Run a tool script (build scenes, batch-set import options) | `<godot> --headless --path game --script res://tools/<name>.gd` (script `extends SceneTree`, ends with `quit()`) |
| Parse-check a script | `<godot> --headless --path game --check-only --script res://<file>.gd` |
| Smoke-test the game | `<godot> --headless --path game --quit-after 120 2>&1 \| grep -E "ERROR\|SCRIPT ERROR"`: no output means no errors in the first 120 frames |
| Export | `<godot> --headless --path game --export-release "<preset>" ../out/<file>` (`--export-debug` for test builds) |

**Workflow:**

1. Scaffold `game/` with `project.godot`, a main scene and `export_presets.cfg` containing the presets the brief needs (Web, macOS, iOS).
2. Drop assets from Blender (`.glb`), Pixelmator (PNG) and Logic (OGG/WAV) into `game/assets/`, then run `--import`. Set import options through `.import` files or a tool script, not by hand in an editor.
3. Build scenes either as text `.tscn` (fine for small scenes) or with a tool script that instantiates nodes and saves with `ResourceSaver.save(PackedScene)` (safer for large ones). Re-run `--import` after adding resources so UIDs resolve.
4. Check every stage with the smoke test. Game logic gets headless tests (a test scene or GUT) that print pass/fail.
5. Export with `--export-release`. Export templates must be installed for the exact version under `~/Library/Application Support/Godot/export_templates/<version>/`; if missing, tell the user (installing them is a large download).

**Visual checks without a window.** `--headless` uses a dummy renderer, so it can't produce frames. To get look frames and trailer footage, in order of preference:

1. Export to Web and capture in headless Chromium (Playwright), which renders WebGL with no visible window. Use this for look frames and screenshots of game states.
2. Movie Maker mode (`--write-movie out.png --fixed-fps 30 --quit-after <frames>`) needs a real renderer and opens a game window while it runs. It's the only exception to the no-window rule: use it only with the user's OK and only for trailer footage (`godot_cli` refuses it unless `allowWindow: true`).

## Recipes

None yet. For multi-level games, a level-build tool script that takes a level spec JSON, one level per session.

## Dead ends

- Frames from `--headless`: it uses a dummy renderer. Use the Web export capture above.
