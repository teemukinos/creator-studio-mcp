import { appRef } from "../apps.js";
import { ArgBag, SEP_PRELUDE, asNumber } from "../osascript.js";

export const PXM_OPS = [
  "remove_background",
  "super_resolution",
  "enhance",
  "denoise",
  "deband",
  "auto_white_balance",
  "auto_light",
  "auto_color_balance",
  "auto_hue_saturation",
  "trim_canvas",
  "rotate_left",
  "rotate_right",
  "rotate_180",
  "flip_horizontally",
  "flip_vertically",
] as const;
export type PxmOp = (typeof PXM_OPS)[number];

/** AppleScript statement for each op, acting on document variable `vDoc`. */
const OP_SOURCE: Record<PxmOp, string> = {
  remove_background: "remove background vDoc",
  super_resolution: "super resolution vDoc",
  enhance: "enhance vDoc",
  denoise: "denoise vDoc",
  deband: "deband vDoc",
  auto_white_balance: "auto white balance vDoc",
  auto_light: "auto light vDoc",
  auto_color_balance: "auto color balance vDoc",
  auto_hue_saturation: "auto hue and saturation vDoc",
  trim_canvas: "trim canvas vDoc",
  rotate_left: "rotate left vDoc",
  rotate_right: "rotate right vDoc",
  rotate_180: "rotate 180 vDoc",
  flip_horizontally: "flip horizontally vDoc",
  flip_vertically: "flip vertically vDoc",
};

export const PXM_FORMATS = ["png", "jpeg", "heic", "webp", "avif", "tiff", "psd", "pdf", "gif", "pxd"] as const;
export type PxmFormat = (typeof PXM_FORMATS)[number];

export const PXM_EXT: Record<PxmFormat, string> = {
  png: ".png",
  jpeg: ".jpg",
  heic: ".heic",
  webp: ".webp",
  avif: ".avif",
  tiff: ".tiff",
  psd: ".psd",
  pdf: ".pdf",
  gif: ".gif",
  pxd: ".pxd",
};

const LOSSY: PxmFormat[] = ["jpeg", "heic", "webp", "avif"];
const AS_FORMAT: Record<Exclude<PxmFormat, "pxd">, string> = {
  png: "PNG",
  jpeg: "JPEG",
  heic: "HEIC",
  webp: "WebP",
  avif: "AVIF",
  tiff: "TIFF",
  psd: "PSD",
  pdf: "PDF",
  gif: "GIF",
};

export interface ResizeSpec {
  width?: number;
  height?: number;
  /** Scale so the long edge is this many pixels. */
  longEdge?: number;
}

export interface CropSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessSpec {
  input: string;
  output: string;
  format: PxmFormat;
  quality?: number;
  ops: PxmOp[];
  crop?: CropSpec;
  resize?: ResizeSpec;
  colorAdjustments?: Partial<Record<ColorAdjustment, number>>;
}

export const COLOR_ADJUSTMENTS = [
  "temperature",
  "tint",
  "hue",
  "saturation",
  "vibrance",
  "exposure",
  "highlights",
  "shadows",
  "brightness",
  "contrast",
  "black point",
  "clarity",
  "fade",
  "sharpen",
  "grain",
] as const;
export type ColorAdjustment = (typeof COLOR_ADJUSTMENTS)[number];

function exportStatement(format: PxmFormat, quality: number | undefined, outRef: string): string {
  if (format === "pxd") return `save vDoc in ${outRef}`;
  const fmt = AS_FORMAT[format];
  if (LOSSY.includes(format) && quality !== undefined) {
    return `export vDoc to ${outRef} as ${fmt} with properties {compression factor:${asNumber(Math.round(quality))}}`;
  }
  return `export vDoc to ${outRef} as ${fmt}`;
}

function resizeStatements(r: ResizeSpec | undefined): string {
  if (!r) return "";
  if (r.longEdge !== undefined) {
    const n = asNumber(Math.round(r.longEdge));
    return `set w0 to (width of vDoc) as integer
set h0 to (height of vDoc) as integer
if w0 ≥ h0 then
  resize image vDoc width ${n} algorithm lanczos
else
  resize image vDoc height ${n} algorithm lanczos
end if`;
  }
  const parts: string[] = [];
  if (r.width !== undefined) parts.push(`width ${asNumber(Math.round(r.width))}`);
  if (r.height !== undefined) parts.push(`height ${asNumber(Math.round(r.height))}`);
  if (parts.length === 0) return "";
  // Giving only one dimension keeps the aspect ratio.
  return `resize image vDoc ${parts.join(" ")} algorithm lanczos`;
}

function adjustmentStatements(adj: ProcessSpec["colorAdjustments"]): string {
  if (!adj) return "";
  const lines = Object.entries(adj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `set ${k} of color adjustments of vLayer to ${asNumber(Math.round(v as number))}`);
  if (lines.length === 0) return "";
  return `set vLayer to current layer of vDoc\n${lines.join("\n")}`;
}

export function buildProcessScript(spec: ProcessSpec): { script: string; args: string[] } {
  const bag = new ArgBag();
  const inRef = bag.ref(spec.input);
  const outRef = bag.ref(spec.output);
  const crop = spec.crop
    ? `crop vDoc bounds {${[spec.crop.x, spec.crop.y, spec.crop.width, spec.crop.height].map((n) => asNumber(Math.round(n))).join(", ")}}`
    : "";
  const ops = spec.ops.map((op) => OP_SOURCE[op]).join("\n");
  const script = `on run argv
${SEP_PRELUDE}
-- Coerce paths outside the tell block so the sandboxed app gets a file grant.
set inFile to ${inRef} as POSIX file
set outFile to ${outRef} as POSIX file
with timeout of 3600 seconds
tell ${appRef("pixelmator")}
  set vCount0 to count of documents
  set vDoc to open inFile
  if (count of documents) is vCount0 then error "This image is already open in Pixelmator Pro. Close it there first (the tool edits a copy and must not change your open work)." number 1001
  try
    set w1 to (width of vDoc) as integer
    set h1 to (height of vDoc) as integer
${ops}
${adjustmentStatements(spec.colorAdjustments)}
${crop}
${resizeStatements(spec.resize)}
    set w2 to (width of vDoc) as integer
    set h2 to (height of vDoc) as integer
    ${exportStatement(spec.format, spec.quality, "outFile")}
    close vDoc saving no
  on error errMsg number errNum
    try
      close vDoc saving no
    end try
    error errMsg number errNum
  end try
end tell
end timeout
return (w1 as text) & US & (h1 as text) & US & (w2 as text) & US & (h2 as text)
end run`;
  return { script, args: bag.values };
}

export function buildInfoScript(input: string): { script: string; args: string[] } {
  const bag = new ArgBag();
  const inRef = bag.ref(input);
  const script = `on run argv
${SEP_PRELUDE}
set inFile to ${inRef} as POSIX file
with timeout of 600 seconds
tell ${appRef("pixelmator")}
  set vCount0 to count of documents
  set vDoc to open inFile
  set vOpened to ((count of documents) > vCount0)
  try
    set vOut to ((width of vDoc) as integer as text) & US & ((height of vDoc) as integer as text) & US & ((resolution of vDoc) as integer as text) & US & ((bits per channel of vDoc) as text) & US
    try
      set vOut to vOut & (color profile of vDoc as text)
    end try
    set vOut to vOut & RS
    repeat with vLayer in layers of vDoc
      set vKind to (class of vLayer) as text
      set vText to ""
      if vKind is "text layer" then
        try
          set vText to (text content of vLayer) as text
        end try
      end if
      set vOut to vOut & (name of vLayer) & US & vKind & US & ((visible of vLayer) as text) & US & ((opacity of vLayer) as text) & US & vText & RS
    end repeat
    if vOpened then close vDoc saving no
  on error errMsg number errNum
    try
      if vOpened then close vDoc saving no
    end try
    error errMsg number errNum
  end try
end tell
end timeout
return vOut
end run`;
  return { script, args: bag.values };
}

export interface Replacement {
  find: string;
  replace: string;
}

export function buildReplaceTextScript(
  input: string,
  output: string,
  format: PxmFormat,
  quality: number | undefined,
  replacements: Replacement[],
  matchWords: boolean,
  caseSensitive: boolean,
): { script: string; args: string[] } {
  const bag = new ArgBag();
  const inRef = bag.ref(input);
  const outRef = bag.ref(output);
  const props = `{match words:${matchWords}, case sensitive:${caseSensitive}}`;
  const lines = replacements
    .map((r) => `replace vDoc text ${bag.ref(r.find)} with ${bag.ref(r.replace)} with properties ${props}`)
    .join("\n    ");
  const script = `on run argv
set inFile to ${inRef} as POSIX file
set outFile to ${outRef} as POSIX file
with timeout of 600 seconds
tell ${appRef("pixelmator")}
  set vCount0 to count of documents
  set vDoc to open inFile
  if (count of documents) is vCount0 then error "This image is already open in Pixelmator Pro. Close it there first (the tool edits a copy and must not change your open work)." number 1001
  try
    ${lines}
    ${exportStatement(format, quality, "outFile")}
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
end run`;
  return { script, args: bag.values };
}
