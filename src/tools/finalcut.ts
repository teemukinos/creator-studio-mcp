import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isRunning, resolveAppPath } from "../apps.js";
import { FRAME_RATES, RESOLUTIONS, type FrameRate, type Resolution, buildFcpxml, injectImportOptions } from "../fcpxml.js";
import { probeMedia } from "../media.js";
import { run, runOsa, splitRecords } from "../osascript.js";
import { runApp } from "../hidden.js";
import { absPath, inputFile, outputFile, withExt } from "../paths.js";
import { buildImportScript, buildListLibrariesScript } from "../scripts/finalcut.js";
import { ok } from "./util.js";

const libraryHelp =
  "Path of the library to import into, e.g. ~/Movies/My Library.fcpbundle. An existing library is used; a new .fcpbundle path is created. Required: on current Final Cut Pro an import without a library silently does nothing.";

/**
 * Validate against the FCPXML DTD that ships inside Final Cut Pro, with the
 * xmllint built into macOS. Returns null when no DTD can be found.
 */
async function validateWithDtd(xmlPath: string, version: string): Promise<{ valid: boolean; errors: string } | null> {
  let app: string;
  try {
    app = await resolveAppPath("finalcut");
  } catch {
    return null;
  }
  const dtd = join(app, "Contents/Frameworks/Interchange.framework/Versions/A/Resources", `FCPXMLv${version.replace(".", "_")}.dtd`);
  if (!existsSync(dtd)) return null;
  // xmllint reads --dtdvalid as a URL, so a path with spaces ("Final Cut Pro Creator Studio.app") breaks it.
  const tmp = join(tmpdir(), `csmcp-FCPXMLv${version.replace(".", "_")}.dtd`);
  copyFileSync(dtd, tmp);
  try {
    await run("xmllint", ["--noout", "--dtdvalid", tmp, xmlPath], 30_000);
    return { valid: true, errors: "" };
  } catch (e) {
    const msg = (e as Error).message;
    if (/Could not parse DTD|failed to load|xmlSAX2ResolveEntity/i.test(msg)) return null;
    return { valid: false, errors: msg.slice(0, 2000) };
  }
}

async function pushToFinalCut(xmlPath: string): Promise<void> {
  const { script, args } = buildImportScript(xmlPath);
  await runApp("finalcut", script, args, { timeoutMs: 10 * 60 * 1000 });
}

export function registerFinalCut(server: McpServer): void {
  server.registerTool(
    "finalcut_list_libraries",
    {
      title: "List Final Cut Pro libraries",
      description:
        "List the libraries open in Final Cut Pro with their file paths, events and projects. Final Cut must already be running (this won't launch it). Apple offers no scripted export, so a timeline's contents can only be read after File › Export XML in the app.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      if (!(await isRunning("finalcut"))) {
        throw new Error("Final Cut Pro is not running. Open it (and the libraries you want) first.");
      }
      const { script, args } = buildListLibrariesScript();
      const rows = splitRecords(await runOsa(script, args, { timeoutMs: 120_000 }));
      const libs = new Map<string, { name: string; path: string; events: Array<{ name: string; projects: string[] }> }>();
      for (const [lib, path, evt, ...projects] of rows) {
        const key = `${lib}\0${path}`;
        if (!libs.has(key)) libs.set(key, { name: lib, path, events: [] });
        if (evt) libs.get(key)!.events.push({ name: evt, projects: projects.filter(Boolean) });
      }
      return ok({ libraries: [...libs.values()] });
    },
  );

  server.registerTool(
    "finalcut_build_timeline",
    {
      title: "Build a Final Cut Pro timeline",
      description:
        "Build a rough-cut project from media files placed end to end, with optional in/out points and markers per clip, and write it as FCPXML. Durations are read from the files (Spotlight, then AVFoundation). Set pushToFinalCut with libraryLocation to import it straight into Final Cut Pro.",
      inputSchema: z.object({
        clips: z
          .array(
            z.object({
              path: z.string().describe("Video or audio file"),
              name: z.string().optional(),
              in: z.number().min(0).optional().describe("Seconds into the source to start"),
              out: z.number().positive().optional().describe("Seconds into the source to end"),
              durationSeconds: z.number().positive().optional().describe("Override the detected media length"),
              markers: z
                .array(
                  z.object({
                    at: z.number().min(0).describe("Seconds from the start of this clip in the timeline"),
                    name: z.string(),
                    kind: z.enum(["standard", "todo", "chapter"]).default("standard"),
                  }),
                )
                .optional(),
            }),
          )
          .min(1),
        projectName: z.string(),
        eventName: z.string().default("Claude Imports"),
        frameRate: z.enum(Object.keys(FRAME_RATES) as [FrameRate, ...FrameRate[]]).default("25"),
        resolution: z.enum(Object.keys(RESOLUTIONS) as [Resolution, ...Resolution[]]).default("1080p"),
        output: z.string().describe("Where to write the .fcpxml file"),
        pushToFinalCut: z.boolean().default(false),
        libraryLocation: z.string().optional().describe(libraryHelp),
        copyAssets: z.boolean().optional().describe("true copies media into the library, false links in place; omit for Final Cut's default"),
        overwrite: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      if (a.pushToFinalCut && !a.libraryLocation) throw new Error(`libraryLocation is required to push to Final Cut Pro. ${libraryHelp}`);
      const paths = a.clips.map((c) => inputFile(c.path));
      const output = outputFile(withExt(a.output, ".fcpxml"), { overwrite: a.overwrite });
      const probed = await probeMedia(paths.filter((_, i) => a.clips[i].durationSeconds === undefined));
      const clips = a.clips.map((c, i) => {
        const path = paths[i];
        const media = c.durationSeconds !== undefined ? { durationSeconds: c.durationSeconds, hasVideo: true, hasAudio: true } : probed.get(path);
        if (!media) {
          throw new Error(`Couldn't read the length of ${path}. Pass durationSeconds for this clip, or check it's a media file macOS can play.`);
        }
        return { ...c, path, media };
      });
      const built = buildFcpxml({
        eventName: a.eventName,
        projectName: a.projectName,
        frameRate: a.frameRate,
        resolution: a.resolution,
        clips,
        libraryLocation: a.libraryLocation ? absPath(a.libraryLocation) : undefined,
        copyAssets: a.copyAssets,
      });
      writeFileSync(output, built.xml, "utf8");
      const fps = FRAME_RATES[a.frameRate].den / FRAME_RATES[a.frameRate].num;
      const result: Record<string, unknown> = {
        output,
        project: a.projectName,
        event: a.eventName,
        durationSeconds: Math.round((built.totalFrames / fps) * 100) / 100,
        clips: built.clips.map((c) => ({ name: c.name, startSeconds: Math.round((c.startFrame / fps) * 100) / 100, seconds: Math.round((c.frames / fps) * 100) / 100 })),
        warnings: built.warnings,
      };
      const check = await validateWithDtd(output, "1.11");
      result.dtdValidation = check === null ? "skipped (Final Cut Pro's DTD not found)" : check.valid ? "valid" : check.errors;
      if (a.pushToFinalCut && check && !check.valid) {
        throw new Error(`The generated FCPXML failed Final Cut Pro's DTD check, so it was not imported. It is saved at ${output}.\n${check.errors}`);
      }
      if (a.pushToFinalCut) {
        await pushToFinalCut(output);
        result.pushed = true;
        result.note = "Sent to Final Cut Pro. If nothing appears, check Final Cut for an import warning dialog.";
      }
      return ok(result);
    },
  );

  server.registerTool(
    "finalcut_import_fcpxml",
    {
      title: "Import FCPXML into Final Cut Pro",
      description:
        "Send an existing .fcpxml file (e.g. one exported from Final Cut and edited) into Final Cut Pro, targeting a library. The source file is left as is; a copy with import options is sent. Importing a project whose media already exists in the target library can fail with a duplicate-media error; a fresh library avoids that.",
      inputSchema: z.object({
        input: z.string().describe("Path to a .fcpxml file"),
        libraryLocation: z.string().describe(libraryHelp),
        copyAssets: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      const input = inputFile(a.input, [".fcpxml"]);
      const xml = injectImportOptions(readFileSync(input, "utf8"), absPath(a.libraryLocation), a.copyAssets);
      const tmp = join(tmpdir(), `${basename(input, ".fcpxml")}-${Date.now()}.fcpxml`);
      writeFileSync(tmp, xml, "utf8");
      await pushToFinalCut(tmp);
      return ok({ input, sent: tmp, library: absPath(a.libraryLocation), note: "If nothing appears, check Final Cut for an import warning dialog." });
    },
  );
}
