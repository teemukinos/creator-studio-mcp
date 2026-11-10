import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveAppPath } from "./apps.js";
import { run } from "./osascript.js";

const SETTING_EXTS = [".compressorsetting", ".cmprstng", ".setting"];

export interface CompressorSetting {
  name: string;
  path: string;
  source: "user" | "built-in";
  /** Extension of the files this setting writes, e.g. "mov", "mp4", "m4a". */
  outputExtension?: string;
  description?: string;
}

function decode(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

/** Read the display name, description and output extension from a setting file's XML header. */
export function parseSettingXml(xml: string): { name?: string; description?: string; outputExtension?: string } {
  const name = xml.match(/<setting\b[^>]*\bname="([^"]*)"/)?.[1];
  const description = xml.match(/<description>([^<]*)<\/description>/)?.[1];
  const ext = xml.match(/<file-extension>([^<]*)<\/file-extension>/)?.[1];
  return {
    name: name ? decode(name) : undefined,
    description: description ? decode(description) : undefined,
    outputExtension: ext || undefined,
  };
}

function readHead(path: string, bytes = 16384): string {
  try {
    if (statSync(path).isDirectory()) return "";
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || !existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
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
      if (statSync(p).isDirectory()) walk(p, depth - 1, out);
    } catch {
      /* unreadable */
    }
  }
}

export async function listSettings(): Promise<CompressorSetting[]> {
  const userDir = join(homedir(), "Library/Application Support/Compressor/Settings");
  const user: string[] = [];
  walk(userDir, 3, user);
  const builtIn: string[] = [];
  try {
    const app = await resolveAppPath("compressor");
    walk(join(app, "Contents/Resources"), 6, builtIn);
    walk(join(app, "Contents/PlugIns"), 14, builtIn);
  } catch {
    /* app missing: user settings still useful */
  }
  const toSetting = (source: CompressorSetting["source"]) => (p: string): CompressorSetting => {
    const meta = parseSettingXml(readHead(p));
    const name = meta.name && !/^\S+(Key|Name|Desc)$/.test(meta.name) ? meta.name : basename(p, extname(p));
    return { name, path: p, source, outputExtension: meta.outputExtension, description: meta.description };
  };
  // Framework bundles link Versions/A, Versions/Current and the top level to the same files.
  const seen = new Set<string>();
  const unique = (paths: string[]) =>
    paths.filter((p) => {
      let real = p;
      try {
        real = realpathSync(p);
      } catch {
        /* keep as is */
      }
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    });
  return [...unique(user).map(toSetting("user")), ...unique(builtIn).map(toSetting("built-in"))];
}

/** Match a setting by exact path, exact name, or a unique case-insensitive name fragment. */
export function pickSetting(settings: CompressorSetting[], query: string): CompressorSetting {
  if (existsSync(query)) return { name: basename(query, extname(query)), path: query, source: "user" };
  const q = query.toLowerCase();
  const exact = settings.filter((s) => s.name.toLowerCase() === q || basename(s.path, extname(s.path)).toLowerCase() === q);
  if (exact.length >= 1) return exact[0];
  const partial = settings.filter((s) => s.name.toLowerCase().includes(q) || basename(s.path, extname(s.path)).toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `"${query}" matches ${partial.length} settings: ${partial
        .slice(0, 10)
        .map((s) => `${s.name} (${basename(s.path)})`)
        .join(", ")}${partial.length > 10 ? ", …" : ""}. Use a more specific name or the full path.`,
    );
  }
  throw new Error(`No Compressor setting matches "${query}". Use compressor_list_settings to see what's available.`);
}

export interface JobSpec {
  input: string;
  settingPath: string;
  output: string;
  batchName?: string;
  priority?: "low" | "medium" | "high";
}

export function compressorArgs(job: JobSpec): string[] {
  const args: string[] = [];
  if (job.batchName) args.push("-batchname", job.batchName);
  if (job.priority) args.push("-priority", job.priority);
  args.push("-jobpath", job.input, "-settingpath", job.settingPath, "-locationpath", job.output);
  return args;
}

export async function submitJob(job: JobSpec): Promise<string> {
  const app = await resolveAppPath("compressor");
  const cli = join(app, "Contents/MacOS/Compressor");
  if (!existsSync(cli)) throw new Error(`Compressor's command-line tool was not found at ${cli}`);
  const { stdout, stderr } = await run(cli, compressorArgs(job), 120_000);
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

/** Wait until a file exists and its size stops changing. */
export async function waitForStableFile(path: string, timeoutMs: number, settleMs = 5000): Promise<{ done: boolean; bytes: number }> {
  const start = Date.now();
  let last = -1;
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === last) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= settleMs) return { done: true, bytes: size };
      } else {
        stableSince = 0;
      }
      last = size;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { done: false, bytes: existsSync(path) ? statSync(path).size : 0 };
}
