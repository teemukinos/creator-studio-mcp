#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerCompressor } from "./tools/compressor.js";
import { registerFinalCut } from "./tools/finalcut.js";
import { registerGeneral } from "./tools/general.js";
import { registerIWork } from "./tools/iwork.js";
import { registerPixelmator } from "./tools/pixelmator.js";
import { registerShortcuts } from "./tools/shortcuts.js";
import { registerHeadless } from "./tools/headless.js";
import { registerUi } from "./tools/ui.js";
import { resolveAllTargets } from "./apps.js";
const INSTRUCTIONS = `Runs creative tools on this Mac without ever showing them: Apple Creator Studio (Final Cut Pro, Motion, Logic Pro, Pixelmator Pro, Compressor, Keynote, Pages, Numbers, MainStage), Blender (headless), the Rive CLI and Godot (headless).
- The user never wants editor windows on screen. Apps launch hidden and are re-hidden after every action. Never pass front: true unless the user explicitly asks to see an app.
- Blender: use blender_run_python (background mode, no window). Rive: use rive_cli (text projects; building and verifying are headless). Godot: use godot_cli (always --headless; headless renders no frames, so capture screenshots from a Web export in headless Chromium). Don't use editor-based Rive or Blender integrations.
- Creator Studio: prefer the direct tools; for everything else (AI features, exports, effects) use ui_list_menus, then ui_click_menu / ui_snapshot / ui_click. To repeat a known sequence, use ui_batch: one call instead of one per click.
- Verify results from files (exports, renders, ffprobe, read-back tools), not by looking at the app.
- Paths must be absolute or start with ~/. Tools never overwrite an existing file unless overwrite is true, and never write over their input (except numbers_write_cells without an output path, which saves in place).
- If an app doesn't respond, it may be showing a dialog: read it with ui_snapshot. Menu items are often disabled until something is selected or a document is open (e.g. Edit > Select All first).
- Final Cut Pro imports need a libraryLocation.`;
// Find each app's installed copy (and its real bundle ID) before serving.
await resolveAllTargets().catch((e) => console.error("app discovery failed:", e));
const handle = serveStdio(() => {
    const server = new McpServer({ name: "creator-studio", version: "0.7.1" }, { instructions: INSTRUCTIONS });
    registerGeneral(server);
    registerPixelmator(server);
    registerIWork(server);
    registerCompressor(server);
    registerFinalCut(server);
    registerUi(server);
    registerShortcuts(server);
    registerHeadless(server);
    return server;
});
console.error("creator-studio MCP server running on stdio");
process.on("SIGINT", () => {
    void handle.close();
});
