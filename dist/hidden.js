import { runOsa } from "./osascript.js";
import { ui } from "./tools/ui.js";
/** Hide an app's windows (never throws). Apps are driven off screen. */
export async function hideApp(app) {
    try {
        await ui(app, "hide", {}, 20_000);
    }
    catch {
        /* app may have quit; nothing to hide */
    }
}
/** Run an AppleScript against an app, then make sure it's hidden again. */
export async function runApp(app, script, args = [], opts = {}) {
    try {
        return await runOsa(script, args, opts);
    }
    finally {
        await hideApp(app);
    }
}
