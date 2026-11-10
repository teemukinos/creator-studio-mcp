import { appRef } from "../apps.js";
import { ArgBag, SEP_PRELUDE, asNumber } from "../osascript.js";
/** Wrap work on an opened document so it is always closed. */
function withDoc(app, inRef, body, save = "no") {
    return `set inFile to ${inRef} as POSIX file
with timeout of 1800 seconds
tell ${appRef(app)}
  set vCount0 to count of documents
  set vDoc to open inFile
  set vOpened to ((count of documents) > vCount0)
  try
${body}
    if vOpened then close vDoc saving ${save}
  on error errMsg number errNum
    if vOpened then
      try
        close vDoc saving no
      end try
    end if
    error errMsg number errNum
  end try
end tell
end timeout`;
}
// ---------------------------------------------------------------- Keynote
export function buildKeynoteThemesScript() {
    return {
        script: `on run argv
${SEP_PRELUDE}
tell ${appRef("keynote")}
  set vNames to name of every theme
end tell
set AppleScript's text item delimiters to RS
set vOut to vNames as text
set AppleScript's text item delimiters to ""
return vOut
end run`,
        args: [],
    };
}
export function buildKeynoteCreateScript(theme, slides, output) {
    const bag = new ArgBag();
    const themeRef = bag.ref(theme);
    const outRef = bag.ref(output);
    const slideSrc = slides
        .map((s, i) => {
        const lines = [];
        if (i === 0) {
            lines.push(`set vSlide to slide 1 of vDoc`);
            if (s.layout)
                lines.push(`set base slide of vSlide to master slide ${bag.ref(s.layout)} of vDoc`);
        }
        else if (s.layout) {
            lines.push(`set vSlide to make new slide at end of slides of vDoc with properties {base slide:master slide ${bag.ref(s.layout)} of vDoc}`);
        }
        else {
            lines.push(`set vSlide to make new slide at end of slides of vDoc`);
        }
        if (s.title !== undefined) {
            lines.push(`try
  set object text of default title item of vSlide to ${bag.ref(s.title)}
on error
  set vWarn to vWarn & "slide ${i + 1}: layout has no title placeholder" & RS
end try`);
        }
        if (s.body !== undefined) {
            lines.push(`try
  set object text of default body item of vSlide to ${bag.ref(s.body)}
on error
  set vWarn to vWarn & "slide ${i + 1}: layout has no body placeholder" & RS
end try`);
        }
        if (s.notes !== undefined)
            lines.push(`set presenter notes of vSlide to ${bag.ref(s.notes)}`);
        return lines.join("\n");
    })
        .join("\n");
    const script = `on run argv
${SEP_PRELUDE}
set vWarn to ""
set outFile to ${outRef} as POSIX file
with timeout of 1800 seconds
tell ${appRef("keynote")}
  set vDoc to make new document with properties {document theme:theme ${themeRef}}
  try
${slideSrc}
    save vDoc in outFile
    close vDoc saving no
  on error errMsg number errNum
    try
      close vDoc saving no
    end try
    error errMsg number errNum
  end try
end tell
end timeout
return vWarn
end run`;
    return { script, args: bag.values };
}
export function buildKeynoteReadScript(input) {
    const bag = new ArgBag();
    const inRef = bag.ref(input);
    const body = `    set vOut to ""
    set vLayouts to ""
    repeat with vMaster in master slides of vDoc
      set vLayouts to vLayouts & (name of vMaster) & US
    end repeat
    set vOut to vLayouts & RS
    repeat with vSlide in slides of vDoc
      set vTitle to ""
      set vBody to ""
      try
        set vTitle to object text of default title item of vSlide
      end try
      try
        set vBody to object text of default body item of vSlide
      end try
      set vLayout to ""
      try
        set vLayout to name of base slide of vSlide
      end try
      set vOut to vOut & ((slide number of vSlide) as text) & US & vLayout & US & ((skipped of vSlide) as text) & US & vTitle & US & vBody & US & (presenter notes of vSlide) & RS
    end repeat`;
    return {
        script: `on run argv
${SEP_PRELUDE}
${withDoc("keynote", inRef, body)}
return vOut
end run`,
        args: bag.values,
    };
}
// ---------------------------------------------------------------- Pages
export function buildPagesTemplatesScript() {
    return {
        script: `on run argv
${SEP_PRELUDE}
tell ${appRef("pages")}
  set vNames to name of every template
end tell
set AppleScript's text item delimiters to RS
set vOut to vNames as text
set AppleScript's text item delimiters to ""
return vOut
end run`,
        args: [],
    };
}
export function buildPagesCreateScript(template, bodyText, output) {
    const bag = new ArgBag();
    const outRef = bag.ref(output);
    const make = template
        ? `make new document with properties {document template:template ${bag.ref(template)}}`
        : `make new document`;
    const bodyRef = bag.ref(bodyText);
    return {
        script: `on run argv
set outFile to ${outRef} as POSIX file
with timeout of 1800 seconds
tell ${appRef("pages")}
  set vDoc to ${make}
  try
    set body text of vDoc to ${bodyRef}
    save vDoc in outFile
    close vDoc saving no
  on error errMsg number errNum
    try
      close vDoc saving no
    end try
    error errMsg number errNum
  end try
end tell
end timeout
return "ok"
end run`,
        args: bag.values,
    };
}
export function buildPagesReadScript(input) {
    const bag = new ArgBag();
    const inRef = bag.ref(input);
    return {
        script: `on run argv
${withDoc("pages", inRef, "    set vOut to body text of vDoc")}
return vOut
end run`,
        args: bag.values,
    };
}
// ---------------------------------------------------------------- Numbers
export function buildNumbersReadScript(input, sheet, table, maxRows = 1000) {
    const bag = new ArgBag();
    const inRef = bag.ref(input);
    const sheetExpr = sheet ? `sheet ${bag.ref(sheet)} of vDoc` : `active sheet of vDoc`;
    const tableExpr = table ? `table ${bag.ref(table)} of vSheet` : `table 1 of vSheet`;
    const body = `    set vOut to ""
    repeat with vS in sheets of vDoc
      set vOut to vOut & (name of vS)
      repeat with vT in tables of vS
        set vOut to vOut & US & (name of vT)
      end repeat
      set vOut to vOut & RS
    end repeat
    set vSheet to ${sheetExpr}
    set vTable to ${tableExpr}
    set vRows to row count of vTable
    set vCols to column count of vTable
    set vOut to vOut & "@@" & (name of vSheet) & US & (name of vTable) & US & (vRows as text) & US & (vCols as text) & US & ((header row count of vTable) as text) & RS
    set vLimit to vRows
    if vLimit > ${asNumber(maxRows)} then set vLimit to ${asNumber(maxRows)}
    repeat with r from 1 to vLimit
      set vLine to ""
      repeat with c from 1 to vCols
        set vCell to cell c of row r of vTable
        set vVal to ""
        try
          set vVal to formatted value of vCell
          if vVal is missing value then set vVal to ""
        end try
        if c > 1 then set vLine to vLine & US
        set vLine to vLine & vVal
      end repeat
      set vOut to vOut & vLine & RS
    end repeat`;
    return {
        script: `on run argv
${SEP_PRELUDE}
${withDoc("numbers", inRef, body)}
return vOut
end run`,
        args: bag.values,
    };
}
/** Convert "B12" to {row: 12, col: 2}. */
export function parseA1(ref) {
    const m = ref.trim().toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})$/);
    if (!m)
        throw new Error(`Not a cell reference like "B2": ${ref}`);
    let col = 0;
    for (const ch of m[1])
        col = col * 26 + (ch.charCodeAt(0) - 64);
    const row = Number(m[2]);
    if (row < 1)
        throw new Error(`Row must be 1 or more: ${ref}`);
    return { row, col };
}
function valueExpr(bag, v) {
    if (typeof v === "number")
        return asNumber(v);
    if (typeof v === "boolean")
        return v ? "true" : "false";
    return bag.ref(v);
}
/** Statements that write a grid starting at (row0, col0) into table variable vTable. */
function gridStatements(bag, rows, row0, col0) {
    const maxCols = Math.max(0, ...rows.map((r) => r.length));
    const needRows = row0 + rows.length - 1;
    const needCols = col0 + maxCols - 1;
    const lines = [
        `if (row count of vTable) < ${asNumber(needRows)} then set row count of vTable to ${asNumber(needRows)}`,
        `if (column count of vTable) < ${asNumber(needCols)} then set column count of vTable to ${asNumber(needCols)}`,
    ];
    rows.forEach((row, ri) => {
        row.forEach((v, ci) => {
            const target = `cell ${asNumber(col0 + ci)} of row ${asNumber(row0 + ri)} of vTable`;
            if (v === null)
                lines.push(`clear ${target}`);
            else
                lines.push(`set value of ${target} to ${valueExpr(bag, v)}`);
        });
    });
    return lines.map((l) => `    ${l}`).join("\n");
}
export function buildNumbersWriteScript(input, output, sheet, table, cells, rows) {
    const bag = new ArgBag();
    const inRef = bag.ref(input);
    const outRef = output ? bag.ref(output) : undefined;
    const sheetExpr = sheet ? `sheet ${bag.ref(sheet)} of vDoc` : `active sheet of vDoc`;
    const tableExpr = table ? `table ${bag.ref(table)} of vSheet` : `table 1 of vSheet`;
    const parts = [`    set vSheet to ${sheetExpr}`, `    set vTable to ${tableExpr}`];
    for (const c of cells) {
        const { row, col } = parseA1(c.cell);
        parts.push(gridStatements(bag, [[c.value]], row, col));
    }
    if (rows) {
        const { row, col } = parseA1(rows.start);
        parts.push(gridStatements(bag, rows.values, row, col));
    }
    const saveLine = outRef ? `    save vDoc in outFile` : `    save vDoc`;
    parts.push(saveLine);
    return {
        script: `on run argv
${outRef ? `set outFile to ${outRef} as POSIX file` : ""}
${withDoc("numbers", inRef, parts.join("\n"))}
return "ok"
end run`,
        args: bag.values,
    };
}
export function buildNumbersCreateScript(rows, output, headerRows, sheetName, tableName) {
    const bag = new ArgBag();
    const outRef = bag.ref(output);
    const renames = [];
    if (sheetName)
        renames.push(`    set name of vSheet to ${bag.ref(sheetName)}`);
    if (tableName)
        renames.push(`    set name of vTable to ${bag.ref(tableName)}`);
    const nRows = Math.max(rows.length, 1);
    const nCols = Math.max(1, ...rows.map((r) => r.length));
    return {
        script: `on run argv
set outFile to ${outRef} as POSIX file
with timeout of 1800 seconds
tell ${appRef("numbers")}
  set vDoc to make new document
  try
    set vSheet to sheet 1 of vDoc
    set vTable to table 1 of vSheet
${renames.join("\n")}
    set header column count of vTable to 0
    set header row count of vTable to ${asNumber(headerRows)}
    set row count of vTable to ${asNumber(nRows)}
    set column count of vTable to ${asNumber(nCols)}
${gridStatements(bag, rows, 1, 1)}
    save vDoc in outFile
    close vDoc saving no
  on error errMsg number errNum
    try
      close vDoc saving no
    end try
    error errMsg number errNum
  end try
end tell
end timeout
return "ok"
end run`,
        args: bag.values,
    };
}
export const IWORK_FORMATS = {
    keynote: { pdf: "PDF", pptx: "Microsoft PowerPoint", mov: "QuickTime movie", images: "slide images" },
    pages: { pdf: "PDF", docx: "Microsoft Word", epub: "EPUB", txt: "unformatted text" },
    numbers: { pdf: "PDF", xlsx: "Microsoft Excel", csv: "CSV" },
};
export function appForFile(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".key"))
        return "keynote";
    if (lower.endsWith(".pages"))
        return "pages";
    if (lower.endsWith(".numbers"))
        return "numbers";
    throw new Error(`Expected a .key, .pages or .numbers file: ${path}`);
}
export function buildExportScript(app, input, output, format, imageFormat) {
    const formats = IWORK_FORMATS[app];
    const asFmt = formats[format];
    if (!asFmt) {
        throw new Error(`${app} can export to ${Object.keys(formats).join(", ")}, not ${format}`);
    }
    const bag = new ArgBag();
    const inRef = bag.ref(input);
    const outRef = bag.ref(output);
    const withProps = asFmt === "slide images"
        ? ` with properties {image format:${imageFormat ?? "PNG"}}`
        : asFmt === "QuickTime movie"
            ? ` with properties {movie format:format1080p}`
            : "";
    const body = `    export vDoc to outFile as ${asFmt}${withProps}`;
    return {
        script: `on run argv
set outFile to ${outRef} as POSIX file
${withDoc(app, inRef, body)}
return "ok"
end run`,
        args: bag.values,
    };
}
