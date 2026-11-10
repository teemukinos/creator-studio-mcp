import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listSettings, pickSetting, submitJob, waitForStableFile } from "../compressor.js";
import { absPath, inputFile, outputFile } from "../paths.js";
import { ok } from "./util.js";

export function registerCompressor(server: McpServer): void {
  server.registerTool(
    "compressor_list_settings",
    {
      title: "List Compressor settings",
      description:
        "List Compressor's transcode settings (presets): your custom ones and the built-in ones in the app. Use a name or path with compressor_transcode.",
      inputSchema: z.object({
        filter: z.string().optional().describe("Only settings whose name contains this text (case-insensitive)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      let settings = await listSettings();
      if (a.filter) settings = settings.filter((s) => s.name.toLowerCase().includes(a.filter!.toLowerCase()));
      return ok({ count: settings.length, settings });
    },
  );

  server.registerTool(
    "compressor_transcode",
    {
      title: "Transcode a file with Compressor",
      description:
        "Submit a transcode job to Compressor using one of its settings, through Compressor's command-line interface. Compressor processes it in the background; set wait to true to block until the output file is complete (up to waitMinutes).",
      inputSchema: z.object({
        input: z.string().describe("Source media file"),
        setting: z.string().describe("Setting name (or unique part of one) from compressor_list_settings, or a full path to a .compressorsetting"),
        output: z.string().describe("Output file path, including the extension the setting produces (e.g. .mp4, .mov, .m4a)"),
        batchName: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        wait: z.boolean().default(false),
        waitMinutes: z.number().min(1).max(120).default(30),
        overwrite: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      const input = inputFile(a.input);
      const output = outputFile(a.output, { overwrite: a.overwrite, inputs: [input] });
      const setting = pickSetting(await listSettings(), a.setting.startsWith("~") || a.setting.startsWith("/") ? absPath(a.setting) : a.setting);
      const log = await submitJob({ input, settingPath: setting.path, output, batchName: a.batchName, priority: a.priority });
      const result: Record<string, unknown> = { submitted: true, input, output, setting: setting.name, compressorOutput: log || undefined };
      if (a.wait) {
        const w = await waitForStableFile(output, a.waitMinutes * 60_000);
        result.finished = w.done;
        result.bytes = w.bytes;
        if (!w.done) result.note = "Still running (or failed) when the wait ended. Check Compressor's Active and Completed lists.";
      }
      return ok(result);
    },
  );
}
