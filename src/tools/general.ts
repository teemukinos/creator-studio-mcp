import type { McpServer } from "@modelcontextprotocol/server";
import { APPS, APP_KEYS, type AppKey, findInstalled, isRunning, pinnedPath, resolveTarget } from "../apps.js";
import { checkPermissions, type PermissionTarget } from "../permissions.js";
import { readAppIntents } from "./shortcuts.js";
import { ok } from "./util.js";

/** Apps the direct tools send Apple Events to. The ui_* tools reach every app through System Events instead. */
const SCRIPTED: AppKey[] = ["pixelmator", "keynote", "pages", "numbers", "finalcut"];

export function registerGeneral(server: McpServer): void {
  server.registerTool(
    "creator_studio_status",
    {
      title: "Creator Studio app status",
      description:
        "List which Creator Studio apps are installed (every copy, with path, bundle ID and version), which copy this server drives, whether each is running, and how much of it is scriptable. Also reports the macOS permissions the tools need (Accessibility, Screen Recording, Automation of each scripted app and System Events) and whether the screen is locked, with a fix for each missing one under permissions.problems. It never asks for a permission. Run this first, and again after installing apps or changing permissions.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const apps = [];
      const scripted: PermissionTarget[] = [];
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
        if (target && SCRIPTED.includes(key)) scripted.push({ name: info.displayName, bundleId: target.bundleId });
      }
      const permissions = await checkPermissions(scripted).catch((e) => ({ error: `Couldn't read permissions: ${(e as Error).message}` }));
      return ok({
        apps,
        permissions,
        note: "Every installed app can be driven through its menus and windows with the ui_* tools, including features with no scripting support. Automation \"not asked yet\" means macOS asks the first time a tool uses that app: the user clicks Allow. macOS only answers for running apps, so others show \"unknown: app not running\".",
      });
    },
  );
}
