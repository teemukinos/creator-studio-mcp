import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { identifyApp } from "../apps.js";
import { inputFile, outputFile } from "../paths.js";
import { run } from "../osascript.js";
import { ok } from "./util.js";

function title(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "key" in v) return String((v as { key: unknown }).key);
  return "";
}

/** Read the App Intents (Shortcuts actions) an app declares in its bundle. */
export function readAppIntents(appPath: string) {
  const file = join(appPath, "Contents/Resources/Metadata.appintents/extract.actionsdata");
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8")) as { actions?: Record<string, any> };
  return Object.entries(data.actions ?? {}).map(([id, a]) => ({
    id,
    title: title(a.title),
    description: title(a.descriptionMetadata?.descriptionText) || undefined,
    parameters: (a.parameters ?? []).map((p: any) => ({ name: p.name, title: title(p.title) || undefined })),
  }));
}

export function registerShortcuts(server: McpServer): void {
  server.registerTool(
    "app_shortcut_actions",
    {
      title: "List an app's Shortcuts actions",
      description:
        "List the Shortcuts (App Intents) actions an app provides, read from the app bundle. These can be combined into a shortcut in the Shortcuts app and then run with shortcuts_run.",
      inputSchema: z.object({ app: z.string().describe("App key, name, bundle ID or .app path") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const t = await identifyApp(a.app);
      if (!t.path) throw new Error("Give the app's name or path so its bundle can be read.");
      const actions = readAppIntents(t.path);
      return ok({ app: t.name, path: t.path, count: actions.length, actions });
    },
  );

  server.registerTool(
    "shortcuts_list",
    {
      title: "List my Shortcuts",
      description: "List the shortcuts in the Shortcuts app, optionally only one folder.",
      inputSchema: z.object({ folder: z.string().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const args = ["list"];
      if (a.folder) args.push("--folder-name", a.folder);
      const { stdout } = await run("shortcuts", args, 60_000);
      return ok({ shortcuts: stdout.split("\n").map((s) => s.trim()).filter(Boolean) });
    },
  );

  server.registerTool(
    "shortcuts_run",
    {
      title: "Run a shortcut",
      description:
        "Run a shortcut by name, optionally passing a file as input and saving its output to a file. Shortcuts can chain actions from many apps, including Creator Studio apps' own actions.",
      inputSchema: z.object({
        name: z.string(),
        input: z.string().optional().describe("Input file path"),
        output: z.string().optional().describe("Where to save the shortcut's output"),
        overwrite: z.boolean().default(false),
        timeoutMinutes: z.number().min(1).max(60).default(10),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      const args = ["run", a.name];
      if (a.input) args.push("--input-path", inputFile(a.input));
      let out: string | undefined;
      if (a.output) {
        out = outputFile(a.output, { overwrite: a.overwrite });
        args.push("--output-path", out);
      }
      const { stdout } = await run("shortcuts", args, a.timeoutMinutes * 60_000);
      return ok({ ran: a.name, output: out, stdout: stdout.trim() || undefined });
    },
  );
}
