import { run, runOsa } from "./osascript.js";
import { screenLocked } from "./lock.js";

/**
 * Reads the macOS privacy permissions the tools depend on, without ever asking for them:
 * AXIsProcessTrusted, CGPreflightScreenCaptureAccess and AEDeterminePermissionToAutomateTarget
 * with askUserIfNeeded false. macOS answers for the app that started this server (the host),
 * which is the app the permissions have to be granted to.
 * Argument: a JSON array of bundle IDs. Prints {accessibility, screenRecording, automation: {id: OSStatus}}.
 */
export const PERMISSIONS_JXA = String.raw`
ObjC.import('ApplicationServices');
ObjC.import('Foundation');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
function run(argv) {
  var ids = JSON.parse(argv[0]), automation = {};
  ids.forEach(function (id) {
    var d = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(id);
    // typeWildCard ('****') for event class and ID; false: never show the consent prompt.
    automation[id] = $.AEDeterminePermissionToAutomateTarget(d.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false);
  });
  return JSON.stringify({ accessibility: $.AXIsProcessTrusted(), screenRecording: $.CGPreflightScreenCaptureAccess(), automation: automation });
}`;

export type AutomationState = "allowed" | "denied" | "not asked yet" | "unknown: app not running" | `unknown: error ${number}`;

/** Map an AEDeterminePermissionToAutomateTarget result to a state. */
export function automationState(code: number): AutomationState {
  if (code === 0) return "allowed";
  if (code === -1743) return "denied"; // errAEEventNotPermitted
  if (code === -1744) return "not asked yet"; // errAEEventWouldRequireUserConsent
  if (code === -600) return "unknown: app not running"; // procNotFound: macOS only answers for a running app
  return `unknown: error ${code}`;
}

/** The app name in a process path such as /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/... */
export function appFromCommand(command: string): string | undefined {
  return command.match(/\/([^/]+)\.app\//)?.[1];
}

export interface PermissionTarget {
  name: string;
  bundleId: string;
}

export interface PermissionReport {
  host?: string;
  accessibility: boolean;
  screenRecording: boolean;
  screenLocked: boolean;
  automation: Record<string, AutomationState>;
  problems: string[];
}

/** One line per permission that will stop a tool, saying where to fix it. */
export function permissionProblems(r: Omit<PermissionReport, "problems">): string[] {
  const host = r.host ?? "the app running your assistant";
  const out: string[] = [];
  if (r.screenLocked) out.push("The screen is locked: every ui_* tool and ui_batch refuses until the Mac is unlocked.");
  if (!r.accessibility)
    out.push(
      `Accessibility is off for ${host}: the ui_* tools, ui_batch and app_open's re-hide won't work. Turn it on in System Settings › Privacy & Security › Accessibility, then restart ${host}.`,
    );
  if (!r.screenRecording)
    out.push(`Screen Recording is off for ${host}: only ui_screenshot needs it. Turn it on in System Settings › Privacy & Security › Screen & System Audio Recording, then restart ${host}.`);
  for (const [name, state] of Object.entries(r.automation)) {
    if (state === "denied")
      out.push(`Automation of ${name} is denied for ${host}: tools that use ${name} fail with -1743. Turn ${name} on under ${host} in System Settings › Privacy & Security › Automation.`);
  }
  return out;
}

/** The first app bundle among this process's ancestors, or undefined when there is none (launchd, tmux). */
async function hostApp(): Promise<string | undefined> {
  let pid = process.ppid;
  for (let i = 0; i < 30 && pid > 1; i++) {
    const out = (await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)], 5_000)).stdout.trim();
    const m = out.match(/^(\d+)\s+(.+)$/);
    if (!m) return undefined;
    const app = appFromCommand(m[2]);
    if (app) return app;
    pid = Number(m[1]);
  }
  return undefined;
}

/** Read every permission. Automation is read for the given apps plus System Events, which the ui_* tools use. */
export async function checkPermissions(targets: PermissionTarget[]): Promise<PermissionReport> {
  const all = [...targets, { name: "System Events", bundleId: "com.apple.systemevents" }];
  const [raw, host, locked] = await Promise.all([
    runOsa(PERMISSIONS_JXA, [JSON.stringify(all.map((t) => t.bundleId))], { language: "JavaScript", timeoutMs: 20_000 }),
    hostApp().catch(() => undefined),
    screenLocked(),
  ]);
  const j = JSON.parse(raw) as { accessibility: boolean; screenRecording: boolean; automation: Record<string, number> };
  const automation: Record<string, AutomationState> = {};
  for (const t of all) automation[t.name] = automationState(j.automation[t.bundleId]);
  const report = { host, accessibility: !!j.accessibility, screenRecording: !!j.screenRecording, screenLocked: locked, automation };
  return { ...report, problems: permissionProblems(report) };
}
