import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asLiteral, run, runOsa } from "./osascript.js";

export type AppKey =
  | "pixelmator"
  | "keynote"
  | "pages"
  | "numbers"
  | "finalcut"
  | "compressor"
  | "motion"
  | "logic"
  | "mainstage"
  | "blender"
  | "godot";

export interface AppInfo {
  key: AppKey;
  displayName: string;
  /** Known bundle IDs, most likely first. Copies are also found by name. */
  bundleIds: string[];
  /** Environment variable that pins a specific .app path. */
  envVar: string;
  /** The .app file name must start with this (e.g. "Keynote Creator Studio.app"). */
  namePrefix: string;
}

export const APPS: Record<AppKey, AppInfo> = {
  pixelmator: { key: "pixelmator", displayName: "Pixelmator Pro", bundleIds: ["com.pixelmatorteam.pixelmator.x"], envVar: "PIXELMATOR_APP", namePrefix: "Pixelmator Pro" },
  keynote: { key: "keynote", displayName: "Keynote", bundleIds: ["com.apple.Keynote", "com.apple.iWork.Keynote"], envVar: "KEYNOTE_APP", namePrefix: "Keynote" },
  pages: { key: "pages", displayName: "Pages", bundleIds: ["com.apple.Pages", "com.apple.iWork.Pages"], envVar: "PAGES_APP", namePrefix: "Pages" },
  numbers: { key: "numbers", displayName: "Numbers", bundleIds: ["com.apple.Numbers", "com.apple.iWork.Numbers"], envVar: "NUMBERS_APP", namePrefix: "Numbers" },
  finalcut: { key: "finalcut", displayName: "Final Cut Pro", bundleIds: ["com.apple.FinalCut"], envVar: "FINALCUT_APP", namePrefix: "Final Cut Pro" },
  compressor: { key: "compressor", displayName: "Compressor", bundleIds: ["com.apple.Compressor"], envVar: "COMPRESSOR_APP", namePrefix: "Compressor" },
  motion: { key: "motion", displayName: "Motion", bundleIds: ["com.apple.motionapp"], envVar: "MOTION_APP", namePrefix: "Motion" },
  logic: { key: "logic", displayName: "Logic Pro", bundleIds: ["com.apple.logic10"], envVar: "LOGIC_APP", namePrefix: "Logic Pro" },
  mainstage: { key: "mainstage", displayName: "MainStage", bundleIds: ["com.apple.mainstage3"], envVar: "MAINSTAGE_APP", namePrefix: "MainStage" },
  blender: { key: "blender", displayName: "Blender", bundleIds: ["org.blenderfoundation.blender"], envVar: "BLENDER_APP", namePrefix: "Blender" },
  godot: { key: "godot", displayName: "Godot", bundleIds: ["org.godotengine.godot"], envVar: "GODOT_APP", namePrefix: "Godot" },
};

export const APP_KEYS = Object.keys(APPS) as AppKey[];

export function pinnedPath(key: AppKey): string | undefined {
  const p = process.env[APPS[key].envVar]?.trim();
  return p ? p : undefined;
}

export interface InstalledCopy {
  path: string;
  bundleId: string;
  version: string;
}

async function plistValue(appPath: string, keyName: string): Promise<string> {
  try {
    const { stdout } = await run("plutil", ["-extract", keyName, "raw", "-o", "-", join(appPath, "Contents/Info.plist")]);
    return stdout.trim();
  } catch {
    return "";
  }
}

const APP_DIRS = ["/Applications", join(homedir(), "Applications")];

/** Every installed copy of an app, found by file name in the Applications folders and by bundle ID through Spotlight. */
export async function findInstalled(key: AppKey): Promise<InstalledCopy[]> {
  const info = APPS[key];
  const paths = new Set<string>();
  for (const dir of APP_DIRS) {
    try {
      for (const e of readdirSync(dir)) {
        if (e.endsWith(".app") && e.startsWith(info.namePrefix)) paths.add(join(dir, e));
      }
    } catch {
      /* folder missing */
    }
  }
  for (const id of info.bundleIds) {
    try {
      const { stdout } = await run("mdfind", [`kMDItemCFBundleIdentifier == "${id}"`]);
      stdout.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".app") && !s.includes(".app/")).forEach((s) => paths.add(s));
    } catch {
      /* Spotlight off */
    }
  }
  const pinned = pinnedPath(key);
  if (pinned && existsSync(pinned)) paths.add(pinned);
  const copies: InstalledCopy[] = [];
  for (const path of paths) {
    copies.push({ path, bundleId: await plistValue(path, "CFBundleIdentifier"), version: await plistValue(path, "CFBundleShortVersionString") });
  }
  return copies;
}

export interface Target {
  path: string;
  bundleId: string;
  version: string;
  /** Another installed copy shares this bundle ID, so target by path. */
  ambiguous: boolean;
}

const targets = new Map<AppKey, Target | null>();

/** Choose the copy to drive: pinned path, then a Creator Studio edition, then known bundle ID order. */
export async function resolveTarget(key: AppKey, refresh = false): Promise<Target | null> {
  if (!refresh && targets.has(key)) return targets.get(key)!;
  const copies = await findInstalled(key);
  const pinned = pinnedPath(key);
  const rank = (c: InstalledCopy) => {
    if (pinned && c.path === pinned) return -1000;
    let r = 0;
    if (/creator studio/i.test(c.path)) r -= 100;
    const i = APPS[key].bundleIds.indexOf(c.bundleId);
    r += i >= 0 ? i : 50;
    if (c.path.startsWith("/Applications/")) r -= 1;
    return r;
  };
  const best = [...copies].sort((a, b) => rank(a) - rank(b))[0];
  const target = best
    ? { ...best, ambiguous: copies.filter((c) => c.bundleId === best.bundleId).length > 1 }
    : null;
  targets.set(key, target);
  return target;
}

/** Resolve every app once at startup so script builders can stay synchronous. */
export async function resolveAllTargets(): Promise<void> {
  await Promise.all(APP_KEYS.map((k) => resolveTarget(k, true)));
}

/** AppleScript application specifier for `tell`. */
export function appRef(key: AppKey): string {
  const t = targets.get(key);
  if (t) {
    if (t.ambiguous || pinnedPath(key)) return `application ${asLiteral(t.path)}`;
    if (t.bundleId) return `application id ${asLiteral(t.bundleId)}`;
    return `application ${asLiteral(t.path)}`;
  }
  return `application id ${asLiteral(APPS[key].bundleIds[0])}`;
}

/** Path of the copy this server drives (for apps run by file path). */
export async function resolveAppPath(key: AppKey): Promise<string> {
  const t = await resolveTarget(key);
  if (!t) {
    throw new Error(
      `${APPS[key].displayName} is not installed. Install it from the App Store (it's included with Apple Creator Studio) or set ${APPS[key].envVar} to its .app path.`,
    );
  }
  return t.path;
}

export async function requireInstalled(key: AppKey): Promise<Target> {
  await resolveAppPath(key);
  return (await resolveTarget(key))!;
}

/** Whether the app is running, without launching it. */
export async function isRunning(key: AppKey): Promise<boolean> {
  const t = await resolveTarget(key);
  if (!t) return false;
  const script = `on run argv
return (${appRef(key)} is running) as text
end run`;
  try {
    return (await runOsa(script, [], { timeoutMs: 15_000 })) === "true";
  } catch {
    return false;
  }
}

/** Accept an app key, display name, .app path or bundle ID; return what UI tools need. */
export async function identifyApp(app: string): Promise<{ name: string; path?: string; bundleId?: string }> {
  const a = app.trim();
  const lower = a.toLowerCase().replace(/\s+/g, "");
  for (const key of APP_KEYS) {
    const info = APPS[key];
    if (lower === key || lower === info.displayName.toLowerCase().replace(/\s+/g, "")) {
      const t = await requireInstalled(key);
      return { name: info.displayName, path: t.path, bundleId: t.bundleId };
    }
  }
  if (a.endsWith(".app")) {
    if (!existsSync(a)) throw new Error(`No app at ${a}`);
    return { name: a, path: a, bundleId: await plistValue(a, "CFBundleIdentifier") };
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(a)) return { name: a, bundleId: a };
  for (const dir of [...APP_DIRS, "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices"]) {
    const p = join(dir, `${a}.app`);
    if (existsSync(p)) return { name: a, path: p, bundleId: await plistValue(p, "CFBundleIdentifier") };
  }
  throw new Error(`Unknown app "${app}". Use one of ${APP_KEYS.join(", ")}, an app name from /Applications, a bundle ID, or an .app path.`);
}
