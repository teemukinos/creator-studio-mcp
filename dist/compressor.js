import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveAppPath } from "./apps.js";
import { run } from "./osascript.js";
const SETTING_EXTS = [".compressorsetting", ".cmprstng", ".setting"];
function decode(s) {
    let out = s;
    for (let i = 0; i < 3; i++) {
        try {
            const next = decodeURIComponent(out);
            if (next === out)
                break;
            out = next;
        }
        catch {
            break;
        }
    }
    return out;
}
/** Read the display name, description and output extension from a setting file's XML header. */
export function parseSettingXml(xml) {
    const name = xml.match(/<setting\b[^>]*\bname="([^"]*)"/)?.[1];
    const description = xml.match(/<description>([^<]*)<\/description>/)?.[1];
    const ext = xml.match(/<file-extension>([^<]*)<\/file-extension>/)?.[1];
    return {
        name: name ? decode(name) : undefined,
        description: description ? decode(description) : undefined,
        outputExtension: ext || undefined,
    };
}
function readHead(path, bytes = 16384) {
    try {
        if (statSync(path).isDirectory())
            return "";
        const fd = openSync(path, "r");
        try {
            const buf = Buffer.alloc(bytes);
            const n = readSync(fd, buf, 0, bytes, 0);
            return buf.subarray(0, n).toString("utf8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return "";
    }
}
function walk(dir, depth, out) {
    if (depth < 0 || !existsSync(dir))
        return;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const e of entries) {
        const p = join(dir, e);
        const ext = extname(e).toLowerCase();
        if (SETTING_EXTS.includes(ext)) {
            out.push(p);
            continue; // settings can be bundles; don't descend into them
        }
        try {
            if (statSync(p).isDirectory())
                walk(p, depth - 1, out);
        }
        catch {
            /* unreadable */
        }
    }
}
/** Built-in settings name themselves by string keys such as "proRes422Name" or "4KWebShareDesc". */
const STRING_KEY = /^[A-Za-z0-9_]+(Key|Name|Desc|Description)$/;
/**
 * Turn a setting's raw name and description into readable text. Keys are looked up in Compressor's
 * own strings; an unknown key falls back to the file name for the name, and is dropped for the description.
 */
export function localizeSetting(meta, fileBase, strings) {
    const look = (s) => (s && STRING_KEY.test(s) ? strings.get(s) : s);
    const name = look(meta.name) ?? look(fileBase) ?? fileBase;
    const description = look(meta.description);
    return { name, description: description || undefined };
}
let stringsCache;
/** Read every English .strings table in the Compressor bundle (binary plists, converted with plutil). */
async function loadStrings(app) {
    if (!app)
        return new Map();
    if (stringsCache?.app === app)
        return stringsCache.table;
    const files = [];
    const find = (dir, depth) => {
        if (depth < 0)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const e of entries) {
            const p = join(dir, e);
            if (e.endsWith(".lproj")) {
                if (e === "en.lproj" || e === "English.lproj" || e === "Base.lproj") {
                    for (const f of readdirSync(p))
                        if (f.endsWith(".strings"))
                            files.push(join(p, f));
                }
                continue;
            }
            if (e === "_CodeSignature" || e === "Versions")
                continue; // Versions duplicates the top-level links
            try {
                if (statSync(p).isDirectory())
                    find(p, depth - 1);
            }
            catch {
                /* unreadable */
            }
        }
    };
    find(join(app, "Contents"), 16);
    const table = new Map();
    for (const f of files) {
        try {
            const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", f], 30_000);
            for (const [k, v] of Object.entries(JSON.parse(stdout))) {
                if (typeof v === "string" && !table.has(k))
                    table.set(k, v);
            }
        }
        catch {
            /* not a plain strings table */
        }
    }
    stringsCache = { app, table };
    return table;
}
export async function listSettings() {
    const userDir = join(homedir(), "Library/Application Support/Compressor/Settings");
    const user = [];
    walk(userDir, 3, user);
    const builtIn = [];
    try {
        const app = await resolveAppPath("compressor");
        walk(join(app, "Contents/Resources"), 6, builtIn);
        walk(join(app, "Contents/PlugIns"), 14, builtIn);
    }
    catch {
        /* app missing: user settings still useful */
    }
    const strings = builtIn.length ? await loadStrings(await resolveAppPath("compressor").catch(() => "")) : new Map();
    const toSetting = (source) => (p) => {
        const meta = parseSettingXml(readHead(p));
        const { name, description } = localizeSetting(meta, basename(p, extname(p)), strings);
        return { name, path: p, source, outputExtension: meta.outputExtension, description };
    };
    // Framework bundles link Versions/A, Versions/Current and the top level to the same files.
    const seen = new Set();
    const unique = (paths) => paths.filter((p) => {
        let real = p;
        try {
            real = realpathSync(p);
        }
        catch {
            /* keep as is */
        }
        if (seen.has(real))
            return false;
        seen.add(real);
        return true;
    });
    return [...unique(user).map(toSetting("user")), ...unique(builtIn).map(toSetting("built-in"))];
}
/** Match a setting by exact path, exact name, or a unique case-insensitive name fragment. */
export function pickSetting(settings, query) {
    if (existsSync(query))
        return { name: basename(query, extname(query)), path: query, source: "user" };
    const q = query.toLowerCase();
    const exact = settings.filter((s) => s.name.toLowerCase() === q || basename(s.path, extname(s.path)).toLowerCase() === q);
    if (exact.length >= 1)
        return exact[0];
    const partial = settings.filter((s) => s.name.toLowerCase().includes(q) || basename(s.path, extname(s.path)).toLowerCase().includes(q));
    if (partial.length === 1)
        return partial[0];
    if (partial.length > 1) {
        throw new Error(`"${query}" matches ${partial.length} settings: ${partial
            .slice(0, 10)
            .map((s) => `${s.name} (${basename(s.path)})`)
            .join(", ")}${partial.length > 10 ? ", …" : ""}. Use a more specific name or the full path.`);
    }
    throw new Error(`No Compressor setting matches "${query}". Use compressor_list_settings to see what's available.`);
}
export function compressorArgs(job) {
    const args = [];
    if (job.batchName)
        args.push("-batchname", job.batchName);
    if (job.priority)
        args.push("-priority", job.priority);
    args.push("-jobpath", job.input, "-settingpath", job.settingPath, "-locationpath", job.output);
    return args;
}
export async function submitJob(job) {
    const app = await resolveAppPath("compressor");
    const cli = join(app, "Contents/MacOS/Compressor");
    if (!existsSync(cli))
        throw new Error(`Compressor's command-line tool was not found at ${cli}`);
    const { stdout, stderr } = await run(cli, compressorArgs(job), 120_000);
    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}
/** Wait until a file exists and its size stops changing. */
export async function waitForStableFile(path, timeoutMs, settleMs = 5000) {
    const start = Date.now();
    let last = -1;
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
        if (existsSync(path)) {
            const size = statSync(path).size;
            if (size > 0 && size === last) {
                if (!stableSince)
                    stableSince = Date.now();
                if (Date.now() - stableSince >= settleMs)
                    return { done: true, bytes: size };
            }
            else {
                stableSince = 0;
            }
            last = size;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return { done: false, bytes: existsSync(path) ? statSync(path).size : 0 };
}
