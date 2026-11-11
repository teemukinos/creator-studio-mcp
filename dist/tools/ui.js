import * as z from "zod/v4";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_KEYS, identifyApp, isRunning } from "../apps.js";
import { groupSteps, loadRecipe, runBatch, substitute, validateSteps } from "../batch.js";
import { absPath } from "../paths.js";
import { LOCKED_MESSAGE, screenLocked } from "../lock.js";
import { run, runOsa } from "../osascript.js";
import { UI_JXA } from "../scripts/ui.js";
import { ok } from "./util.js";
const appParam = z
    .string()
    .describe("App to control: finalcut, motion, logic, mainstage, compressor, pixelmator, keynote, pages, numbers, or any other app name, bundle ID or .app path");
/** Longest one run of UI steps can take, such as waiting for a long bounce dialog. */
const BATCH_RUN_TIMEOUT_MS = 45 * 60_000;
const activeBatches = new Map();
const ACCESS_HINT = "UI control needs Accessibility permission for the app running this server (Claude, Claude Code's terminal, Codex, your editor). Turn it on in System Settings › Privacy & Security › Accessibility, then retry.";
export async function ui(app, cmd, params = {}, timeoutMs = 120_000) {
    const target = await identifyApp(app);
    // A locked screen hides every window, so calls would "succeed" with empty results.
    if (await screenLocked())
        throw new Error(LOCKED_MESSAGE);
    try {
        const out = await runOsa(UI_JXA, [JSON.stringify({ cmd, target, ...params })], { language: "JavaScript", timeoutMs });
        return JSON.parse(out);
    }
    catch (e) {
        const msg = e.message;
        if (/assistive access|-25211|not allowed assistive/i.test(msg))
            throw new Error(`${msg}\n${ACCESS_HINT}`);
        throw e;
    }
}
const frontParam = z
    .boolean()
    .default(false)
    .describe("Bring the app to the front first. Off by default: apps are driven in the background so the user's screen isn't taken over.");
const findParams = {
    text: z.string().optional().describe("Text in the element's title, description or value (case-insensitive)"),
    role: z.string().optional().describe("Accessibility role without the AX prefix, e.g. Button, TextField, CheckBox, PopUpButton, MenuButton, Slider, Row, StaticText"),
    exact: z.boolean().default(false).describe("Require the whole text to match"),
    index: z.number().int().min(0).default(0).describe("Which match to use when several match (0 = first)"),
    within: z.string().optional().describe("Only search inside this element id from ui_snapshot"),
};
export function registerUi(server) {
    server.registerTool("app_open", {
        title: "Open an app or a file in an app",
        description: "Launch an app hidden (off screen), optionally opening a file or project in it. Apps stay hidden while the UI tools drive them. Pass front: true only if the user asks to see the app.",
        inputSchema: z.object({ app: appParam, file: z.string().optional().describe("File to open in the app"), front: frontParam }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const t = await identifyApp(a.app);
        // -g: don't bring forward; -j: launch hidden. Apps are driven off screen.
        const args = a.front ? [] : ["-g", "-j"];
        args.push(...(t.path ? ["-a", t.path] : ["-b", t.bundleId]));
        if (a.file)
            args.push(absPath(a.file));
        await run("open", args, 60_000);
        if (!a.front) {
            // A document window can still appear as the file loads; hide again once it has.
            await new Promise((r) => setTimeout(r, 1500));
            try {
                await ui(a.app, "hide", {}, 20_000);
            }
            catch {
                /* ignore */
            }
        }
        return ok({ opened: t.name, file: a.file ? absPath(a.file) : undefined, visible: !!a.front });
    });
    server.registerTool("ui_list_menus", {
        title: "List an app's menu commands",
        description: "List every command in an app's menu bar as paths like \"File > Export To > PDF…\", marking disabled ones. This is how to discover expert features that have no scripting interface (e.g. Final Cut's Transcribe to Captions or Beat Detection, Logic's Chord ID, Keynote's Generate Slides from Text). Paths ending in \">\" have submenus; raise depth or pass menu to see deeper. Some items only enable with a selection or an open document.",
        inputSchema: z.object({
            app: appParam,
            menu: z.string().optional().describe("Only this top-level menu, e.g. \"Modify\""),
            depth: z.number().int().min(0).max(5).default(2).describe("Submenu levels to expand"),
            outFile: z.string().optional().describe("Write the map here, one path per line, and return only the count. Then grep the file instead of reading the whole map into the conversation."),
        }),
        annotations: { readOnlyHint: false, openWorldHint: false },
    }, async (a) => {
        const r = await ui(a.app, "menus", { menu: a.menu, depth: a.depth, front: false }, 180_000);
        if (!a.outFile)
            return ok(r);
        const file = absPath(a.outFile);
        const menus = Array.isArray(r?.menus) ? r.menus : [];
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, menus.join("\n") + "\n", "utf8");
        return ok({ outFile: file, count: menus.length, disabled: menus.filter((m) => m.startsWith("(disabled)")).length, truncated: r?.truncated });
    });
    server.registerTool("ui_click_menu", {
        title: "Run a menu command",
        description: "Click a menu command by its path, e.g. [\"File\", \"Export To\", \"PDF\"]. Matching ignores case and trailing \"…\", and accepts a unique prefix. Works with the app in the background. Afterwards, a dialog may open: inspect it with ui_snapshot.",
        inputSchema: z.object({ app: appParam, path: z.array(z.string()).min(2), front: frontParam }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => ok(await ui(a.app, "clickMenu", { path: a.path, front: a.front })));
    server.registerTool("ui_snapshot", {
        title: "Read what's in an app's windows",
        description: "Read the accessibility tree of an app's windows, sheets and dialogs: each element's id, role, label and value. Use it to see panels, inspectors, dialogs and progress, and to get element ids for ui_click and ui_set_value. Pass within to zoom into one element. Defaults are small to keep results short (depth 6, 120 elements); when truncated is true, zoom in with within, or raise depth and maxNodes for that one call.",
        inputSchema: z.object({
            app: appParam,
            within: z.string().optional().describe("Element id to start from"),
            depth: z.number().int().min(1).max(20).default(6),
            maxNodes: z.number().int().min(10).max(3000).default(120),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const r = await ui(a.app, "snapshot", { within: a.within, depth: a.depth, maxNodes: a.maxNodes, front: false, searchSeconds: 150 }, 180_000);
        if (r?.truncated)
            r.hint = "Cut off at the limits. Pass within with the id of the part you need, or raise depth or maxNodes for this call.";
        return ok(r);
    });
    server.registerTool("ui_find", {
        title: "Find UI elements",
        description: "Search an app's windows for elements by text and/or role, returning their ids, roles, labels and values.",
        inputSchema: z.object({ app: appParam, ...findParams, max: z.number().int().min(1).max(100).default(20) }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => ok(await ui(a.app, "find", { ...a, front: false, searchSeconds: 150 }, 180_000)));
    server.registerTool("ui_click", {
        title: "Click a button or control",
        description: "Press a UI element: by id from ui_snapshot/ui_find, or by text and role (e.g. text \"Generate\", role \"Button\"). Use for buttons, checkboxes, tabs, list rows and pop-up buttons in dialogs and panels. A list row is selected through Accessibility; some apps ignore that, so if nothing changes, call again with front: true for a real click.",
        inputSchema: z.object({ app: appParam, id: z.string().optional(), ...findParams, front: frontParam }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        if (!a.id && !a.text && !a.role)
            throw new Error("Pass an id, or text and/or role.");
        return ok(await ui(a.app, "click", a));
    });
    server.registerTool("ui_set_value", {
        title: "Fill in a field",
        description: "Set the text of a text field, search field or text area (by id, or by text/role), falling back to selecting all and typing.",
        inputSchema: z.object({ app: appParam, id: z.string().optional(), value: z.string(), ...findParams, front: frontParam }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        if (!a.id && !a.text && !a.role)
            throw new Error("Pass an id, or text and/or role.");
        return ok(await ui(a.app, "setValue", a));
    });
    server.registerTool("ui_press_key", {
        title: "Press a key or shortcut",
        description: "Send a keyboard shortcut to an app in the background: a shortcut with command, control or option that belongs to a menu item presses that item (a hidden app ignores posted shortcuts); other keys are posted to the app's process. Pass front: true if an app ignores it. E.g. key \"e\" with [\"command\"], key \"b\" for the Blade tool, or named keys: return, enter, tab, space, delete, escape, left, right, up, down, home, end, pageup, pagedown, f1–f12.",
        inputSchema: z.object({
            app: appParam,
            key: z.string().min(1),
            modifiers: z.array(z.enum(["command", "option", "control", "shift"])).default([]),
            front: frontParam,
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => ok(await ui(a.app, "keys", { key: a.key, modifiers: a.modifiers, front: a.front })));
    server.registerTool("ui_type_text", {
        title: "Type text",
        description: "Type text into whatever has keyboard focus in the app (after clicking a field, or into a title being edited).",
        inputSchema: z.object({ app: appParam, text: z.string().min(1), front: frontParam }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => ok(await ui(a.app, "type", { text: a.text, front: a.front })));
    server.registerTool("ui_wait_for", {
        title: "Wait for something to appear or disappear",
        description: "Poll an app's windows until an element with the given text/role appears (or disappears, with gone: true). Use after starting long jobs like analysis, generation, transcription or export.",
        inputSchema: z.object({
            app: appParam,
            ...findParams,
            gone: z.boolean().default(false),
            timeoutSeconds: z.number().min(1).max(1800).default(120),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const start = Date.now();
        while (Date.now() - start < a.timeoutSeconds * 1000) {
            const { matches } = await ui(a.app, "find", { ...a, max: 1, front: false }, 120_000);
            const present = matches.length > 0;
            if (present !== a.gone)
                return ok({ done: true, seconds: Math.round((Date.now() - start) / 1000), element: matches[0] ?? null });
            await new Promise((r) => setTimeout(r, 2000));
        }
        return ok({ done: false, seconds: a.timeoutSeconds, note: "Timed out. Take a ui_snapshot or ui_screenshot to see the current state." });
    });
    server.registerTool("ui_batch", {
        title: "Run a known sequence of UI steps",
        description: "Run many UI steps with one call, from a steps list or a recipe file, instead of one tool call per click. Use it when the sequence is already known; use the single ui_* tools to explore. Unbroken runs of UI steps share one process, so pop-ups stay open between steps and the app is hidden once at the end of the run. Stops at the first failure and reports that step's error with a short snapshot. Optional steps that failed are listed in the status's skipped field: check it before trusting a done run. It runs in the background by default and writes statusFile as JSON with state running, done or failed, so long jobs outlast the 60 s bridge limit: wait for that file's state to change rather than polling with this tool. " +
            "UI ops: clickMenu {path}; click {id|text|role, exact, within, depth, maxNodes, waitSeconds, requireEnabled}; setValue {id|text|role, value}, which never falls back to typing; stepValue {id|text|role, to, delta}; waitFor {id|text|role, gone, enabled, timeoutSeconds}; assert {id|text|role, value}; keys {key, modifiers}; snapshot; sleep {seconds}; hide; retry {steps, onFail, times}. " +
            "Other ops: open {file}, which launches hidden; waitFile {path, stableSeconds, timeoutSeconds}; moveFile {from, to}, which never overwrites; requireUnlocked; requireClosed {waitSeconds}; requireAbsent {path}, which stops if a file is already there (put it before a waitFile or moveFile whose file an earlier run may have left). Any step can have a label, and optional: true to carry on if it fails. Write ${name} in strings and pass values in vars. In a large window, give text searches a within, or they can run past the bridge limit. It can't bring an app to the front.",
        inputSchema: z.object({
            app: appParam.optional().describe("App to control. Optional when the recipe names it."),
            steps: z.array(z.looseObject({ op: z.string() })).optional().describe("The steps to run, instead of a recipe"),
            recipe: z.string().optional().describe("Path to a recipe: JSON with name, app, vars (defaults) and steps"),
            vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}).describe("Values for ${name} in the steps"),
            statusFile: z.string().optional().describe("Where to write the status JSON. Default: a new file in the temp folder."),
            background: z.boolean().default(true).describe("Return at once and keep running. False waits for the result, so use it only for jobs under 60 s."),
            dryRun: z.boolean().default(false).describe("Check the steps and fill in vars without touching the app"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const recipe = a.recipe ? loadRecipe(absPath(a.recipe)) : undefined;
        const app = a.app ?? recipe?.app;
        if (!app)
            throw new Error("Name the app, in app or in the recipe.");
        const raw = (recipe ? recipe.steps : a.steps);
        if (!raw?.length)
            throw new Error("Pass steps or a recipe.");
        const steps = substitute(raw, { ...recipe?.vars, ...a.vars });
        validateSteps(steps);
        const name = recipe?.name ?? "ui-batch";
        if (a.dryRun)
            return ok({ name, app, total: steps.length, runs: groupSteps(steps).length, steps });
        const active = activeBatches.get(app);
        if (active)
            throw new Error(`A batch is already running on ${app}. Its status is in ${active}`);
        const statusFile = absPath(a.statusFile ?? join(tmpdir(), `csmcp-batch-${Date.now()}.json`));
        activeBatches.set(app, statusFile);
        const job = runBatch({ name, steps, statusFile }, {
            runUi: (group) => ui(app, "batch", { steps: group }, BATCH_RUN_TIMEOUT_MS),
            open: async (file) => {
                const t = await identifyApp(app);
                await run("open", ["-g", "-j", ...(t.path ? ["-a", t.path] : ["-b", t.bundleId]), ...(file ? [file] : [])], 60_000);
                await new Promise((r) => setTimeout(r, 1500));
                await ui(app, "hide", {}, 20_000).catch(() => undefined);
            },
            isRunning: async () => {
                if (!APP_KEYS.includes(app))
                    throw new Error("requireClosed works with the Creator Studio app names only.");
                return isRunning(app);
            },
            isLocked: screenLocked,
        }).finally(() => activeBatches.delete(app));
        if (!a.background)
            return ok({ ...(await job), statusFile });
        job.catch(() => undefined);
        return ok({ started: true, name, total: steps.length, statusFile });
    });
    server.registerTool("ui_screenshot", {
        title: "Screenshot an app window",
        description: "Capture an app's main window (or, without app, the whole screen) as an image. Works while the app is behind other windows, but not while it's hidden, and the apps these tools drive stay hidden: for them, check results through output files or read-back tools instead. Needs Screen Recording permission for the app running this server.",
        inputSchema: z.object({
            app: appParam.optional(),
            maxSize: z.number().int().min(400).max(2560).default(1600).describe("Longest side in pixels"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const file = join(tmpdir(), `csmcp-shot-${Date.now()}.jpg`);
        const args = ["-x", "-t", "jpg"];
        // Without an app, the whole screen is captured: refuse while it's locked, like every other UI call.
        if (!a.app && (await screenLocked()))
            throw new Error(LOCKED_MESSAGE);
        if (a.app) {
            // Capture the app's own window by id, even when it's behind other windows.
            const { windowId } = await ui(a.app, "windowId", {});
            args.push("-o", "-l", String(windowId));
        }
        args.push(file);
        await run("screencapture", args, 30_000);
        await run("sips", ["-Z", String(a.maxSize), file], 30_000);
        const data = readFileSync(file).toString("base64");
        rmSync(file, { force: true });
        return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
    });
}
