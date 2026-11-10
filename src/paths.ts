import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/** Expand ~ and require an absolute path (relative paths are ambiguous for a server). */
export function absPath(p: string): string {
  let out = p.trim();
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = resolve(homedir(), out.slice(2));
  if (!isAbsolute(out)) {
    throw new Error(`Use an absolute path (or one starting with ~/): ${p}`);
  }
  return resolve(out);
}

export function inputFile(p: string, allowedExt?: string[]): string {
  const path = absPath(p);
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  if (allowedExt) {
    const ext = extname(path).toLowerCase();
    if (!allowedExt.includes(ext)) {
      throw new Error(`Expected a ${allowedExt.join(" / ")} file, got ${path}`);
    }
  }
  return path;
}

export function inputDir(p: string): string {
  const path = absPath(p);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Folder not found: ${path}`);
  return path;
}

/**
 * Validate an output path: refuse to clobber an existing file unless asked,
 * refuse to write over an input, and create the parent folder.
 */
export function outputFile(p: string, opts: { overwrite?: boolean; inputs?: string[] } = {}): string {
  const path = absPath(p);
  if (opts.inputs?.some((i) => resolve(i) === path)) {
    throw new Error(`Output would overwrite the input file: ${path}. Choose a different output path.`);
  }
  if (existsSync(path) && !opts.overwrite) {
    throw new Error(`${path} already exists. Pass overwrite: true to replace it, or choose another path.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Other common spellings of an extension the tools add, so out.jpeg stays out.jpeg. */
const EXT_ALIASES: Record<string, readonly string[]> = {
  ".jpg": [".jpeg"],
  ".tiff": [".tif"],
};

/** Make sure a path has the given extension (adds it if missing). */
export function withExt(path: string, ext: string): string {
  const want = ext.toLowerCase();
  const have = extname(path).toLowerCase();
  return have === want || EXT_ALIASES[want]?.includes(have) ? path : `${path}${ext}`;
}
