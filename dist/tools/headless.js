import * as z from "zod/v4";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveAppPath, resolveTarget } from "../apps.js";
import { absPath, inputDir, inputFile } from "../paths.js";
import { ok } from "./util.js";
function exec(cmd, args, opts) {
    return new Promise((resolve) => {
        const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env: { ...process.env } }, (err, stdout, stderr) => {
            const e = err;
            resolve({
                code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
                stdout: stdout ?? "",
                stderr: stderr ?? (e ? e.message : ""),
                timedOut: !!e?.killed,
            });
        });
        // Nothing is ever piped in: a script that reads stdin gets end of file instead of hanging until the timeout.
        child.stdin?.end();
    });
}
/** Keep tool results readable: the end of long logs is what matters. */
function tail(s, max = 12000) {
    return s.length > max ? `…(${s.length - max} earlier characters omitted)\n${s.slice(-max)}` : s;
}
// ------------------------------------------------------------------ Blender
async function blenderBinary() {
    const app = await resolveAppPath("blender");
    const bin = join(app, "Contents/MacOS/Blender");
    if (!existsSync(bin))
        throw new Error(`Blender's executable was not found at ${bin}`);
    return bin;
}
// ------------------------------------------------------------------ Rive
let riveBin;
async function riveBinary() {
    if (riveBin && existsSync(riveBin))
        return riveBin;
    const home = homedir();
    const candidates = [
        process.env.RIVE_CLI,
        join(home, ".rive/bin/rive"),
        join(home, ".local/bin/rive"),
        join(home, ".homebrew/bin/rive"),
        "/opt/homebrew/bin/rive",
        "/usr/local/bin/rive",
    ].filter(Boolean);
    for (const c of candidates)
        if (existsSync(c))
            return (riveBin = c);
    // Fall back to the login shell's PATH, which apps launched from the Dock don't inherit.
    const r = await exec("/bin/zsh", ["-lc", "command -v rive"], { timeoutMs: 15_000 });
    const found = r.stdout.trim().split("\n").pop();
    if (r.code === 0 && found && existsSync(found))
        return (riveBin = found);
    throw new Error("The Rive CLI was not found. Install it with `brew install --cask rive-app/tap/rive-cli` or `curl -fsSL https://releases.rive.app/cli/install.sh | sh`, or set RIVE_CLI to its path.");
}
/** Subcommands that never open a window. `open` (launches the editor) is deliberately absent. */
const RIVE_SUBCOMMANDS = new Set([
    "create", "schema", "docs", "samples", "inspect", "login", "logout", "whoami", "ls", "workspace",
    "push", "pull", "update", "switch", "uninstall", "doctor", "help", "version",
]);
/** Project-run flags that make the CLI exit without a window. */
const RIVE_HEADLESS_FLAGS = [
    "--once", "--verify", "--publish", "--test", "--screenshot", "--semantics", "--data-dump",
    "--headless-serve", "--bench", "--gpu-manifest", "--rev", "--render-audio", "--help", "-h", "--version",
];
/**
 * True when the arguments would open a window: the editor (`rive open`) or
 * the live previewer (a project run without a headless flag, including
 * --serve/--device/--debug on their own). Apps must never appear on screen.
 */
export function riveOpensWindow(args) {
    if (args.length === 0)
        return false;
    if (args[0] === "open")
        return true;
    if (RIVE_SUBCOMMANDS.has(args[0]))
        return false;
    return !args.some((a) => RIVE_HEADLESS_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}
/** Added to each new project's AGENTS.md, which otherwise tells agents to start the previewer. */
export const RIVE_PROJECT_RULE = `
## This user: no windows

Never start the previewer (\`rive .\` or \`rive <project>\` without a headless flag), never use
\`--serve\`/\`--device\` without \`--headless-serve\`, and never run \`rive open\`. The user doesn't want any
editor or preview window on screen. To show the result, render it headlessly
(\`rive . --screenshot --advance=1\`, with \`--pointer\`/\`--data\` to show states) and share the PNG.
`;
// ------------------------------------------------------------------ Godot
let godotBin;
async function godotBinary() {
    if (godotBin && existsSync(godotBin))
        return godotBin;
    const pinned = process.env.GODOT_BIN?.trim();
    if (pinned && existsSync(pinned))
        return (godotBin = pinned);
    const app = await resolveTarget("godot");
    if (app) {
        const bin = join(app.path, "Contents/MacOS/Godot");
        if (existsSync(bin))
            return (godotBin = bin);
    }
    // Homebrew and manual installs put a `godot` binary on the login shell's PATH.
    const r = await exec("/bin/zsh", ["-lc", "command -v godot"], { timeoutMs: 15_000 });
    const found = r.stdout.trim().split("\n").pop();
    if (r.code === 0 && found && existsSync(found))
        return (godotBin = found);
    throw new Error("Godot was not found. Install it (`brew install --cask godot`, or Godot.app from godotengine.org into /Applications), or set GODOT_APP to the .app or GODOT_BIN to the executable.");
}
/** Flags that only make sense with a window, refused unless allowWindow is set. */
const GODOT_WINDOW_FLAGS = ["--write-movie", "--display-driver", "-f", "--fullscreen", "-m", "--maximized", "-t", "--always-on-top"];
/** Flags that open the project manager: always refused. */
const GODOT_REFUSED_FLAGS = ["-p", "--project-manager"];
function hasFlag(args, flags) {
    return args.find((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
}
/**
 * Build the Godot argument list. Always headless (dummy renderer, no window)
 * unless allowWindow is set, which only Movie Maker captures should need.
 */
export function buildGodotArgs(opts) {
    const args = [...opts.args];
    const refused = hasFlag(args, GODOT_REFUSED_FLAGS);
    if (refused)
        throw new Error(`\`${refused}\` opens the Godot project manager window. Write project.godot as text instead.`);
    if (!opts.allowWindow) {
        const windowed = hasFlag(args, GODOT_WINDOW_FLAGS);
        if (windowed) {
            throw new Error(`\`${windowed}\` needs a real window and renderer. Godot runs headless here (no frames are rendered). For screenshots, export to Web and capture in headless Chromium. Movie Maker footage needs allowWindow: true, and only with the user's OK.`);
        }
    }
    if (opts.projectPath && hasFlag(args, ["--path"]))
        throw new Error("Pass the project either as projectPath or as --path in args, not both.");
    if (opts.script && hasFlag(args, ["-s", "--script"]))
        throw new Error("Pass the script either as code/scriptPath or as --script in args, not both.");
    const out = [];
    if (!opts.allowWindow && !args.includes("--headless"))
        out.push("--headless");
    if (opts.projectPath)
        out.push("--path", opts.projectPath);
    out.push(...args);
    if (opts.script)
        out.push("--script", opts.script);
    if (opts.userArgs?.length)
        out.push("--", ...opts.userArgs);
    return out;
}
/** Inline GDScript without an `extends` line is wrapped as a SceneTree script that quits when done. */
export function wrapGdscript(code) {
    if (/^\s*extends\s/m.test(code))
        return code;
    const body = code.split("\n").map((l) => (l.trim() ? `\t${l}` : l)).join("\n");
    return `extends SceneTree\n\nfunc _initialize() -> void:\n${body}\n\tquit()\n`;
}
/** Godot colours its progress output even when not on a terminal. */
export function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
/** Error lines Godot prints (it often exits 0 even after script errors). */
export function godotErrorLines(text) {
    return stripAnsi(text).split("\n").filter((l) => /^\s*(USER )?(SCRIPT )?ERROR:|^\s*Parse Error:/.test(l)).map((l) => l.trim());
}
export function registerHeadless(server) {
    server.registerTool("blender_run_python", {
        title: "Run Blender headless with a Python script",
        description: "Run Blender in background mode (no window ever appears) and execute Python with the full bpy API: build or edit scenes, model, animate, set up materials, cameras and lights, render stills or frame sequences (bpy.ops.render.render(write_still=True) / animation=True), and export .glb/.fbx/.usd. Optionally open a .blend first; save with bpy.ops.wm.save_as_mainfile(filepath=...). Each call is a fresh Blender process: persist work in a .blend file. print() output is returned. Runs arbitrary Python as the user: only write files inside the job folder.",
        inputSchema: z.object({
            code: z.string().optional().describe("Python source to run (uses bpy). Give this or scriptPath."),
            scriptPath: z.string().optional().describe("Path to a .py file to run instead of code"),
            blendFile: z.string().optional().describe("A .blend file to open first"),
            args: z.array(z.string()).default([]).describe("Extra arguments, readable in Python via sys.argv after '--'"),
            cwd: z.string().optional().describe("Working directory for relative paths, usually the job folder"),
            factoryStartup: z.boolean().default(true).describe("Ignore the user's Blender preferences and add-ons for reproducible results"),
            engine: z.enum(["default", "BLENDER_EEVEE_NEXT", "CYCLES", "BLENDER_WORKBENCH"]).default("default").describe("Override the render engine for this run"),
            timeoutMinutes: z.number().min(1).max(240).default(30),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async (a) => {
        if (!a.code === !a.scriptPath)
            throw new Error("Pass exactly one of code or scriptPath.");
        const bin = await blenderBinary();
        let script = a.scriptPath ? inputFile(a.scriptPath, [".py"]) : "";
        let tmpDir;
        if (a.code) {
            tmpDir = join(tmpdir(), `csmcp-blender-${Date.now()}`);
            mkdirSync(tmpDir, { recursive: true });
            script = join(tmpDir, "script.py");
            writeFileSync(script, a.code, "utf8");
        }
        const args = ["-b"];
        if (a.factoryStartup)
            args.push("--factory-startup");
        if (a.blendFile)
            args.push(inputFile(a.blendFile, [".blend"]));
        if (a.engine !== "default")
            args.push("-E", a.engine);
        args.push("--python-exit-code", "1", "-P", script);
        if (a.args.length)
            args.push("--", ...a.args);
        const cwd = a.cwd ? inputDir(a.cwd) : undefined;
        const r = await exec(bin, args, { cwd, timeoutMs: a.timeoutMinutes * 60_000 });
        if (tmpDir)
            rmSync(tmpDir, { recursive: true, force: true });
        const result = {
            ok: r.code === 0 && !r.timedOut,
            exitCode: r.code,
            timedOut: r.timedOut || undefined,
            output: tail(r.stdout),
            errors: r.stderr.trim() ? tail(r.stderr, 6000) : undefined,
        };
        return { ...ok(result), isError: !result.ok };
    });
    server.registerTool("rive_cli", {
        title: "Run the Rive CLI (headless)",
        description: "Run the Rive command-line tool to make interactive Rive animations from text project files (Rive Markup Language, .rml), without the Rive editor. Common: [\"create\", \"<name>\"] scaffolds a project (it includes AGENTS.md/CLAUDE.md: read them first); [\"<project>\", \"--verify\"] checks it compiles; [\"<project>\", \"--once\"] builds build/<name>.riv; [\"--help\"] or [\"<subcommand>\", \"--help\"] for everything else (rendering frames, tests). Headless captures: [\".\", \"--screenshot\", \"--advance=1\"] renders build/<name>.png; add --pointer/--touch/--key/--data to simulate input, --data-dump/--semantics for state. Anything that opens a window (the previewer, --serve/--device without --headless-serve, `rive open`) is refused. push/pull/login touch the user's Rive account: only when asked.",
        inputSchema: z.object({
            args: z.array(z.string()).min(1).describe("Arguments after `rive`, e.g. [\"mascot\", \"--verify\"]"),
            cwd: z.string().describe("Folder to run in, usually the job's rive/ folder"),
            timeoutMinutes: z.number().min(1).max(60).default(10),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (a) => {
        if (riveOpensWindow(a.args)) {
            throw new Error(`\`rive ${a.args.join(" ")}\` would open the preview window. Use --once to build, --verify to check, or the CLI's headless render/test commands (see \`rive --help\`).`);
        }
        const cwd = absPath(a.cwd);
        mkdirSync(cwd, { recursive: true });
        const bin = await riveBinary();
        const r = await exec(bin, a.args, { cwd, timeoutMs: a.timeoutMinutes * 60_000 });
        // New projects tell agents to open the previewer; add this user's rule.
        if (r.code === 0 && a.args[0] === "create") {
            const dir = a.args.slice(1).find((x) => !x.startsWith("-"));
            const agents = join(dir ? (isAbsolute(dir) ? dir : join(cwd, dir)) : cwd, "AGENTS.md");
            if (existsSync(agents) && !readFileSync(agents, "utf8").includes("This user: no windows")) {
                appendFileSync(agents, RIVE_PROJECT_RULE);
            }
        }
        const result = {
            ok: r.code === 0 && !r.timedOut,
            command: `rive ${a.args.join(" ")}`,
            exitCode: r.code,
            timedOut: r.timedOut || undefined,
            output: tail(r.stdout),
            errors: r.stderr.trim() ? tail(r.stderr, 6000) : undefined,
        };
        return { ...ok(result), isError: !result.ok };
    });
    server.registerTool("godot_cli", {
        title: "Run Godot headless",
        description: "Run the Godot 4 engine from the command line with --headless (dummy renderer, no window ever appears) on a text project (project.godot, .tscn, .tres, .gd). Pass projectPath (the folder with project.godot). Common: args [\"--import\"] imports assets and generates .import/.uid files (Godot 4.3+; older: [\"--editor\", \"--quit\"]); args [\"--quit-after\", \"120\"] smoke-tests the main scene for 120 frames; args [\"--export-release\", \"Web\", \"/abs/out/index.html\"] exports a preset from export_presets.cfg (export templates for the exact version must be installed); args [\"--version\"]. Run GDScript with code or scriptPath: code without an `extends` line is wrapped as a SceneTree script that quits when done; a full script must extend SceneTree or MainLoop and call quit(). Script and engine errors (ERROR:, SCRIPT ERROR:) are collected and fail the call, since Godot often exits 0 after them. Headless renders no frames: for screenshots export to Web and capture in headless Chromium. Refuses the project manager and window-only flags; allowWindow: true lifts that for Movie Maker (--write-movie) captures, only when the user has agreed to a window.",
        inputSchema: z.object({
            projectPath: z.string().optional().describe("Folder containing project.godot, usually the job's game/ folder"),
            args: z.array(z.string()).default([]).describe("Godot arguments, e.g. [\"--import\"] or [\"--export-release\", \"Web\", \"/abs/path/index.html\"]"),
            code: z.string().optional().describe("GDScript to run (with --script). Without `extends`, it is wrapped in a SceneTree script that quits when done"),
            scriptPath: z.string().optional().describe("A .gd file to run instead of code: absolute path or res:// path"),
            userArgs: z.array(z.string()).default([]).describe("Arguments for the script, read with OS.get_cmdline_user_args()"),
            failOnErrors: z.boolean().default(true).describe("Treat ERROR / SCRIPT ERROR lines in the output as failure"),
            allowWindow: z.boolean().default(false).describe("Run without --headless. Only for Movie Maker captures the user explicitly agreed to"),
            timeoutMinutes: z.number().min(1).max(120).default(10),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async (a) => {
        if (a.code && a.scriptPath)
            throw new Error("Pass at most one of code or scriptPath.");
        let project;
        if (a.projectPath) {
            project = inputDir(a.projectPath);
            if (!existsSync(join(project, "project.godot"))) {
                throw new Error(`${project} has no project.godot. Create it first (a text file starting with \`config_version=5\`).`);
            }
        }
        let script;
        let tmpDir;
        if (a.code) {
            tmpDir = join(tmpdir(), `csmcp-godot-${Date.now()}`);
            mkdirSync(tmpDir, { recursive: true });
            script = join(tmpDir, "run.gd");
            writeFileSync(script, wrapGdscript(a.code), "utf8");
        }
        else if (a.scriptPath) {
            script = a.scriptPath.startsWith("res://") ? a.scriptPath : inputFile(a.scriptPath, [".gd"]);
        }
        const args = buildGodotArgs({ args: a.args, projectPath: project, script, userArgs: a.userArgs, allowWindow: a.allowWindow });
        const bin = await godotBinary();
        const r = await exec(bin, args, { cwd: project, timeoutMs: a.timeoutMinutes * 60_000 });
        if (tmpDir)
            rmSync(tmpDir, { recursive: true, force: true });
        const stdout = stripAnsi(r.stdout);
        const stderr = stripAnsi(r.stderr);
        const errorLines = godotErrorLines(`${stdout}\n${stderr}`);
        const result = {
            ok: r.code === 0 && !r.timedOut && !(a.failOnErrors && errorLines.length > 0),
            command: `godot ${args.join(" ")}`,
            exitCode: r.code,
            timedOut: r.timedOut || undefined,
            errorCount: errorLines.length || undefined,
            errorLines: errorLines.length ? errorLines.slice(0, 50) : undefined,
            output: tail(stdout),
            stderr: stderr.trim() ? tail(stderr, 6000) : undefined,
        };
        return { ...ok(result), isError: !result.ok };
    });
}
