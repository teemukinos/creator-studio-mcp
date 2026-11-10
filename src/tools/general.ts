import type { McpServer } from "@modelcontextprotocol/server";
import { APPS, APP_KEYS, findInstalled, isRunning, pinnedPath, resolveTarget } from "../apps.js";
import { readAppIntents } from "./shortcuts.js";
import { ok } from "./util.js";

export function registerGeneral(server: McpServer): void {
  server.registerTool(
    "creator_studio_status",
    {
      title: "Creator Studio app status",
      description:
        "List which Creator Studio apps are installed (every copy, with path, bundle ID and version), which copy this server drives, whether each is running, and how much of it is scriptable. Run this first, and again after installing apps.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const apps = [];
      for (const key of APP_KEYS) {
        const info = APPS[key];
        const copies = await findInstalled(key);
        const target = await resolveTarget(key, true);
        apps.push({
          key,
          app: info.displayName,
          installed: copies.length > 0,
          copies: copies.length > 1 ? copies : undefined,
          drives: target ? `${target.path} (${target.bundleId} ${target.version})${pinnedPath(key) ? ` pinned by ${info.envVar}` : ""}` : undefined,
          running: target ? await isRunning(key) : false,
          shortcutsActions: target ? readAppIntents(target.path).length : undefined,
        });
      }
      return ok({
        apps,
        note: "Every installed app can be driven through its menus and windows with the ui_* tools, including features with no scripting support.",
      });
    },
  );
}
