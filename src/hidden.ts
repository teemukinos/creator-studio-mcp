import type { AppKey } from "./apps.js";
import { type OsaOptions, runOsa } from "./osascript.js";
import { ui } from "./tools/ui.js";

/** Hide an app's windows (never throws). Apps are driven off screen. */
export async function hideApp(app: AppKey | string): Promise<void> {
  try {
    await ui(app, "hide", {}, 20_000);
  } catch {
    /* app may have quit; nothing to hide */
  }
}

/** Run an AppleScript against an app, then make sure it's hidden again. */
export async function runApp(app: AppKey, script: string, args: string[] = [], opts: OsaOptions = {}): Promise<string> {
  try {
    return await runOsa(script, args, opts);
  } finally {
    await hideApp(app);
  }
}
