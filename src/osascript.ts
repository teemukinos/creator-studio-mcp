import { execFile } from "node:child_process";

/** ASCII unit / record separators: cannot appear in names users type. */
export const FIELD_SEP = "\x1f";
export const RECORD_SEP = "\x1e";

/**
 * Collects string values that a script needs and hands back the AppleScript
 * expression that reads each one from argv. User-supplied text is therefore
 * never spliced into script source, so quotes or newlines in a title, a path
 * or a cell value cannot change what the script does.
 */
export class ArgBag {
  readonly values: string[] = [];

  /** Returns an AppleScript expression such as `(item 3 of argv)`. */
  ref(value: string): string {
    this.values.push(value);
    return `(item ${this.values.length} of argv)`;
  }
}

/** Embed a JS number as an AppleScript literal (locale-independent). */
export function asNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  return String(n);
}

/** Escape text for a double-quoted AppleScript literal (config values only). */
export function asLiteral(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface OsaOptions {
  /** Kill osascript after this long. Default 10 minutes. */
  timeoutMs?: number;
  language?: "AppleScript" | "JavaScript";
}

export class OsaError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const HINTS: Record<number, string> = {
  [-1743]:
    "macOS blocked the Apple Event. Allow your MCP host (e.g. Claude) to control this app in System Settings › Privacy & Security › Automation, then retry.",
  [-1712]:
    "The app did not answer in time. It may be showing a dialog or alert that needs to be dismissed by hand.",
  [-600]: "The app is not running and could not be launched.",
  [-1728]: "The item referenced (document, sheet, table, slide or layer) does not exist.",
  [-10000]: "The app rejected the command. Check the file type and that the document opened correctly.",
};

function parseError(stderr: string): OsaError {
  const m = stderr.match(/\((-?\d+)\)\s*$/m);
  const code = m ? Number(m[1]) : null;
  const clean = stderr.replace(/^\d+:\d+:\s*execution error:\s*/m, "").trim();
  const hint = code !== null ? HINTS[code] : undefined;
  return new OsaError(hint ? `${clean}\n${hint}` : clean, code);
}

/**
 * Run a script through osascript. The script text arrives on stdin and must
 * start with `on run argv`; `args` become argv.
 */
export function runOsa(script: string, args: string[] = [], opts: OsaOptions = {}): Promise<string> {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("This server drives macOS apps and only runs on a Mac."));
  }
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const lang = opts.language ?? "AppleScript";
  return new Promise((resolve, reject) => {
    const child = execFile(
      "osascript",
      ["-l", lang, "-", ...args],
      { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(
              new OsaError(
                `Timed out after ${Math.round(timeout / 1000)} s. ${HINTS[-1712]}`,
                -1712,
              ),
            );
            return;
          }
          reject(parseError(stderr || err.message));
          return;
        }
        resolve(stdout.replace(/\n$/, ""));
      },
    );
    child.stdin?.end(script);
  });
}

/** Run any command without a shell. */
export function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).trim()}`));
      else resolve({ stdout, stderr });
    });
  });
}

/** Split `a<US>b<US>c<RS>d<US>e<RS>` into rows of fields. */
export function splitRecords(out: string): string[][] {
  return out
    .split(RECORD_SEP)
    .filter((r) => r.length > 0)
    .map((r) => r.split(FIELD_SEP));
}

/** Shared AppleScript prelude: separators as variables. */
export const SEP_PRELUDE = `set US to character id 31
set RS to character id 30`;
