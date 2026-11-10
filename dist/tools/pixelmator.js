import * as z from "zod/v4";
import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { FIELD_SEP, splitRecords } from "../osascript.js";
import { runApp } from "../hidden.js";
import { absPath, inputDir, inputFile, outputFile, withExt } from "../paths.js";
import { COLOR_ADJUSTMENTS, PXM_EXT, PXM_FORMATS, PXM_OPS, buildInfoScript, buildProcessScript, buildReplaceTextScript, } from "../scripts/pixelmator.js";
import { ok } from "./util.js";
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".webp", ".avif", ".psd", ".pxd", ".gif", ".bmp", ".raw", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf"];
const formatSchema = z.enum(PXM_FORMATS).describe("Output format. pxd keeps layers (Pixelmator's own format).");
const qualitySchema = z.number().int().min(1).max(100).optional().describe("1–100 for jpeg, heic, webp and avif. Omit for the app default.");
const opsSchema = z
    .array(z.enum(PXM_OPS))
    .default([])
    .describe("Operations run in order before crop and resize. ML ones: remove_background (use png/webp/heic/tiff to keep transparency), super_resolution (always ×3), enhance, denoise, deband. Auto adjustments: auto_white_balance, auto_light, auto_color_balance, auto_hue_saturation. Geometry: trim_canvas, rotate_*, flip_*.");
const resizeSchema = z
    .object({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    longEdge: z.number().int().positive().optional().describe("Scale so the longer side is this many pixels"),
})
    .optional()
    .describe("Resize with Lanczos after ops and crop. Give width only, height only (aspect kept), both (exact), or longEdge.");
const cropSchema = z
    .object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() })
    .optional()
    .describe("Crop rectangle in pixels from the top-left, applied after ops and before resize.");
const adjustSchema = z
    .partialRecord(z.enum(COLOR_ADJUSTMENTS), z.number().int().min(-100).max(100))
    .optional()
    .describe("Color adjustments on the current (top) layer, most range −100…100, e.g. {\"exposure\": 20, \"saturation\": -10}.");
async function processOne(spec) {
    const { script, args } = buildProcessScript(spec);
    const out = await runApp("pixelmator", script, args, { timeoutMs: 60 * 60 * 1000 });
    const [w1, h1, w2, h2] = out.split(FIELD_SEP).map(Number);
    return { input: spec.input, output: spec.output, inputSize: [w1, h1], outputSize: [w2, h2] };
}
export function registerPixelmator(server) {
    server.registerTool("pixelmator_process_image", {
        title: "Process an image in Pixelmator Pro",
        description: "Open an image in Pixelmator Pro, run ML and auto-adjust operations, apply color adjustments, crop and resize, then export to a new file. The input file is never modified. Returns input and output pixel sizes.",
        inputSchema: z.object({
            input: z.string().describe("Absolute path (or ~/…) of the source image"),
            output: z.string().describe("Path for the result. The format's extension is added if missing."),
            format: formatSchema.default("png"),
            quality: qualitySchema,
            ops: opsSchema,
            colorAdjustments: adjustSchema,
            crop: cropSchema,
            resize: resizeSchema,
            overwrite: z.boolean().default(false).describe("Replace the output file if it already exists"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input);
        const output = outputFile(withExt(a.output, PXM_EXT[a.format]), { overwrite: a.overwrite, inputs: [input] });
        return ok(await processOne({ input, output, format: a.format, quality: a.quality, ops: a.ops, crop: a.crop, resize: a.resize, colorAdjustments: a.colorAdjustments }));
    });
    server.registerTool("pixelmator_batch_process", {
        title: "Batch-process images in Pixelmator Pro",
        description: "Apply the same operations, resize and export to many images. Pass a folder or a list of files. Each file is processed separately, so one failure doesn't stop the rest. Outputs keep the source file name with the new extension and an optional suffix.",
        inputSchema: z.object({
            inputs: z.array(z.string()).optional().describe("Image file paths"),
            inputFolder: z.string().optional().describe("Process every image in this folder (not recursive)"),
            outputFolder: z.string().describe("Where results go (created if needed)"),
            suffix: z.string().default("").describe("Added to each output name, e.g. \"-web\""),
            format: formatSchema.default("jpeg"),
            quality: qualitySchema,
            ops: opsSchema,
            colorAdjustments: adjustSchema,
            resize: resizeSchema,
            overwrite: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        let files = (a.inputs ?? []).map((p) => inputFile(p));
        if (a.inputFolder) {
            const dir = inputDir(a.inputFolder);
            files = files.concat(readdirSync(dir)
                .filter((f) => !f.startsWith(".") && IMAGE_EXTS.includes(extname(f).toLowerCase()))
                .sort()
                .map((f) => join(dir, f)));
        }
        if (files.length === 0)
            throw new Error("No input images: pass inputs, or an inputFolder that contains images.");
        const results = [];
        for (const input of files) {
            try {
                const name = basename(input, extname(input)) + a.suffix + PXM_EXT[a.format];
                const output = outputFile(join(absPath(a.outputFolder), name), { overwrite: a.overwrite, inputs: files });
                results.push({ ok: true, ...(await processOne({ input, output, format: a.format, quality: a.quality, ops: a.ops, resize: a.resize, colorAdjustments: a.colorAdjustments })) });
            }
            catch (e) {
                results.push({ ok: false, input, error: e.message });
            }
        }
        const failed = results.filter((r) => !r.ok).length;
        return ok({ processed: results.length - failed, failed, results });
    });
    server.registerTool("pixelmator_image_info", {
        title: "Inspect an image in Pixelmator Pro",
        description: "Read an image's pixel size, resolution, bit depth, color profile and layer list (name, kind, visibility, opacity, and the text of text layers). Useful before filling a template with pixelmator_replace_text.",
        inputSchema: z.object({ input: z.string().describe("Absolute path of the image or .pxd") }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input);
        const { script, args } = buildInfoScript(input);
        const rows = splitRecords(await runApp("pixelmator", script, args));
        const [w, h, res, bits, profile] = rows[0] ?? [];
        const layers = rows.slice(1).map(([name, kind, visible, opacity, text]) => ({
            name,
            kind,
            visible: visible === "true",
            opacity: Number(opacity),
            ...(text ? { text } : {}),
        }));
        return ok({ input, width: Number(w), height: Number(h), resolution: Number(res), bitsPerChannel: Number(bits), colorProfile: profile || undefined, layers });
    });
    server.registerTool("pixelmator_replace_text", {
        title: "Fill a Pixelmator Pro template",
        description: "Open a layered design (usually .pxd), replace text across all text layers, and export the result to a new file. Text keeps its existing font and style. The template is not modified.",
        inputSchema: z.object({
            input: z.string().describe("Template path (.pxd or .psd with text layers)"),
            output: z.string(),
            replacements: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1),
            format: formatSchema.default("png"),
            quality: qualitySchema,
            matchWords: z.boolean().default(false).describe("Only replace whole words"),
            caseSensitive: z.boolean().default(true),
            overwrite: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input);
        const output = outputFile(withExt(a.output, PXM_EXT[a.format]), { overwrite: a.overwrite, inputs: [input] });
        const { script, args } = buildReplaceTextScript(input, output, a.format, a.quality, a.replacements, a.matchWords, a.caseSensitive);
        await runApp("pixelmator", script, args);
        return ok({ input, output, replacements: a.replacements.length });
    });
}
