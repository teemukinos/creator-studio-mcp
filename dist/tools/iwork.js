import * as z from "zod/v4";
import { mkdirSync } from "node:fs";
import { extname } from "node:path";
import { RECORD_SEP, splitRecords } from "../osascript.js";
import { runApp } from "../hidden.js";
import { absPath, inputFile, outputFile, withExt } from "../paths.js";
import { IWORK_FORMATS, appForFile, buildExportScript, buildKeynoteCreateScript, buildKeynoteReadScript, buildKeynoteThemesScript, buildNumbersCreateScript, buildNumbersReadScript, buildNumbersWriteScript, buildPagesCreateScript, buildPagesReadScript, buildPagesTemplatesScript, } from "../scripts/iwork.js";
import { ok } from "./util.js";
/** The output path for an export: the format's extension, with a Keynote movie's .mov swapped for .m4v. */
export function exportPath(output, format) {
    if (format === "mov" && extname(output).toLowerCase() === ".mov")
        return output.slice(0, -4) + ".m4v";
    return withExt(output, EXPORT_EXT[format]);
}
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const EXPORT_EXT = {
    pdf: ".pdf",
    pptx: ".pptx",
    // Keynote writes movies only as MPEG-4 .m4v: a .mov path fails with error 6.
    mov: ".m4v",
    docx: ".docx",
    epub: ".epub",
    txt: ".txt",
    xlsx: ".xlsx",
    csv: ".csv",
};
export function registerIWork(server) {
    // ---------------------------------------------------------------- Keynote
    server.registerTool("keynote_list_themes", {
        title: "List Keynote themes",
        description: "Names of the Keynote themes available on this Mac, including Creator Studio premium themes when subscribed.",
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => {
        const { script, args } = buildKeynoteThemesScript();
        const out = await runApp("keynote", script, args);
        return ok({ themes: out.split(RECORD_SEP).filter(Boolean) });
    });
    server.registerTool("keynote_create_presentation", {
        title: "Create a Keynote presentation",
        description: "Create a new Keynote presentation from a theme and a list of slides (title, body, presenter notes, optional layout name), and save it as a .key file. Body text: separate bullet points with newlines. Layout names come from the theme (e.g. \"Title & Bullets\", \"Title Only\"); use keynote_read_presentation on a saved file to see them.",
        inputSchema: z.object({
            theme: z.string().default("Basic White").describe("Theme name from keynote_list_themes"),
            slides: z
                .array(z.object({
                layout: z.string().optional().describe("Master slide (layout) name in the theme"),
                title: z.string().optional(),
                body: z.string().optional(),
                notes: z.string().optional().describe("Presenter notes"),
            }))
                .min(1),
            output: z.string().describe("Where to save the .key file"),
            overwrite: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const output = outputFile(withExt(a.output, ".key"), { overwrite: a.overwrite });
        const { script, args } = buildKeynoteCreateScript(a.theme, a.slides, output);
        const warn = await runApp("keynote", script, args, { timeoutMs: 30 * 60 * 1000 });
        return ok({ output, slides: a.slides.length, warnings: warn.split(RECORD_SEP).filter(Boolean) });
    });
    server.registerTool("keynote_read_presentation", {
        title: "Read a Keynote presentation",
        description: "Read every slide's number, layout, skipped state, title, body text and presenter notes, plus the layouts the theme offers.",
        inputSchema: z.object({ input: z.string().describe("Path to a .key file") }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input, [".key"]);
        const { script, args } = buildKeynoteReadScript(input);
        const rows = splitRecords(await runApp("keynote", script, args));
        const layouts = (rows[0] ?? []).filter(Boolean);
        const slides = rows.slice(1).map(([n, layout, skipped, title, body, notes]) => ({
            slide: Number(n),
            layout,
            skipped: skipped === "true",
            title,
            body,
            notes,
        }));
        return ok({ input, layouts, slides });
    });
    // ---------------------------------------------------------------- Pages
    server.registerTool("pages_list_templates", {
        title: "List Pages templates",
        description: "Names of the Pages templates available on this Mac.",
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => {
        const { script, args } = buildPagesTemplatesScript();
        return ok({ templates: (await runApp("pages", script, args)).split(RECORD_SEP).filter(Boolean) });
    });
    server.registerTool("pages_create_document", {
        title: "Create a Pages document",
        description: "Create a Pages document from a template (or blank) with the given body text, and save it as a .pages file. Paragraphs are separated by newlines; the template's body style is used.",
        inputSchema: z.object({
            template: z.string().optional().describe("Template name from pages_list_templates; omit for the default blank document"),
            bodyText: z.string(),
            output: z.string().describe("Where to save the .pages file"),
            overwrite: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const output = outputFile(withExt(a.output, ".pages"), { overwrite: a.overwrite });
        const { script, args } = buildPagesCreateScript(a.template, a.bodyText, output);
        await runApp("pages", script, args);
        return ok({ output });
    });
    server.registerTool("pages_read_document", {
        title: "Read a Pages document",
        description: "Return the body text of a .pages document.",
        inputSchema: z.object({ input: z.string().describe("Path to a .pages file") }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input, [".pages"]);
        const { script, args } = buildPagesReadScript(input);
        return ok({ input, text: await runApp("pages", script, args) });
    });
    // ---------------------------------------------------------------- Numbers
    server.registerTool("numbers_read_table", {
        title: "Read a Numbers table",
        description: "List a spreadsheet's sheets and tables, and return one table's cells as rows of displayed (formatted) values. Defaults to the first table of the active sheet.",
        inputSchema: z.object({
            input: z.string().describe("Path to a .numbers file"),
            sheet: z.string().optional(),
            table: z.string().optional(),
            maxRows: z.number().int().min(1).max(10000).default(1000),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input, [".numbers"]);
        const { script, args } = buildNumbersReadScript(input, a.sheet, a.table, a.maxRows);
        const rows = splitRecords(await runApp("numbers", script, args));
        const metaIdx = rows.findIndex((r) => r[0].startsWith("@@"));
        if (metaIdx < 0)
            throw new Error("Numbers returned no table data.");
        const sheets = rows.slice(0, metaIdx).map(([name, ...tables]) => ({ name, tables }));
        const [sheetName, tableName, nRows, nCols, headerRows] = rows[metaIdx];
        return ok({
            input,
            sheets,
            sheet: sheetName.slice(2),
            table: tableName,
            rowCount: Number(nRows),
            columnCount: Number(nCols),
            headerRows: Number(headerRows),
            truncated: Number(nRows) > a.maxRows,
            rows: rows.slice(metaIdx + 1),
        });
    });
    server.registerTool("numbers_write_cells", {
        title: "Write cells in a Numbers spreadsheet",
        description: "Set cells in a Numbers table, by individual references (\"B2\") and/or a block of rows starting at a cell. Numbers and booleans are stored as values; strings are entered as if typed, so Numbers may treat a string starting with = as a formula. Null clears a cell. The table grows if needed. Saves to `output` if given, otherwise SAVES OVER THE INPUT FILE.",
        inputSchema: z.object({
            input: z.string().describe("Path to a .numbers file"),
            output: z.string().optional().describe("Save to this new path instead of in place"),
            sheet: z.string().optional(),
            table: z.string().optional(),
            cells: z.array(z.object({ cell: z.string().describe("A1-style reference"), value: cellValue })).default([]),
            rows: z
                .object({ start: z.string().describe("Top-left cell, e.g. \"A2\""), values: z.array(z.array(cellValue)) })
                .optional(),
            overwrite: z.boolean().default(false).describe("Allow replacing an existing file at `output`"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input, [".numbers"]);
        const output = a.output ? outputFile(withExt(a.output, ".numbers"), { overwrite: a.overwrite, inputs: [input] }) : undefined;
        if (a.cells.length === 0 && !a.rows)
            throw new Error("Nothing to write: pass cells and/or rows.");
        const { script, args } = buildNumbersWriteScript(input, output, a.sheet, a.table, a.cells, a.rows);
        await runApp("numbers", script, args, { timeoutMs: 30 * 60 * 1000 });
        const written = a.cells.length + (a.rows?.values.reduce((n, r) => n + r.length, 0) ?? 0);
        return ok({ savedTo: output ?? input, cellsWritten: written });
    });
    server.registerTool("numbers_create_spreadsheet", {
        title: "Create a Numbers spreadsheet",
        description: "Create a new .numbers spreadsheet with one table filled from rows of values.",
        inputSchema: z.object({
            rows: z.array(z.array(cellValue)).min(1),
            headerRows: z.number().int().min(0).max(5).default(1),
            sheetName: z.string().optional(),
            tableName: z.string().optional(),
            output: z.string(),
            overwrite: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const output = outputFile(withExt(a.output, ".numbers"), { overwrite: a.overwrite });
        const { script, args } = buildNumbersCreateScript(a.rows, output, a.headerRows, a.sheetName, a.tableName);
        await runApp("numbers", script, args, { timeoutMs: 30 * 60 * 1000 });
        return ok({ output, rows: a.rows.length });
    });
    // ---------------------------------------------------------------- Export
    server.registerTool("iwork_export", {
        title: "Export a Keynote, Pages or Numbers file",
        description: `Export an iWork document to another format. The app is chosen from the file extension. Keynote: ${Object.keys(IWORK_FORMATS.keynote).join(", ")} (images writes one file per slide into the output folder; mov writes an H.264 .m4v at 1080p height). Pages: ${Object.keys(IWORK_FORMATS.pages).join(", ")}. Numbers: ${Object.keys(IWORK_FORMATS.numbers).join(", ")} (csv of a multi-table file produces a folder with one CSV per table).`,
        inputSchema: z.object({
            input: z.string().describe("Path to a .key, .pages or .numbers file"),
            format: z.enum(["pdf", "pptx", "mov", "images", "docx", "epub", "txt", "xlsx", "csv"]),
            output: z.string().describe("Output file path (a folder for Keynote images)"),
            imageFormat: z.enum(["PNG", "JPEG", "TIFF"]).optional().describe("For Keynote images only"),
            overwrite: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (a) => {
        const input = inputFile(a.input, [".key", ".pages", ".numbers"]);
        const app = appForFile(input);
        let output;
        if (a.format === "images") {
            output = absPath(a.output);
            mkdirSync(output, { recursive: true });
        }
        else {
            output = outputFile(exportPath(a.output, a.format), { overwrite: a.overwrite, inputs: [input] });
        }
        const { script, args } = buildExportScript(app, input, output, a.format, a.imageFormat);
        await runApp(app, script, args, { timeoutMs: 60 * 60 * 1000 });
        return ok({ input, output, format: a.format });
    });
}
