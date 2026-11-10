import { basename, extname } from "node:path";

/** Frame rates FCP supports for new projects, with exact frame durations. */
export const FRAME_RATES = {
  "23.976": { num: 1001, den: 24000, tag: "2398" },
  "24": { num: 100, den: 2400, tag: "24" },
  "25": { num: 100, den: 2500, tag: "25" },
  "29.97": { num: 1001, den: 30000, tag: "2997" },
  "30": { num: 100, den: 3000, tag: "30" },
  "50": { num: 100, den: 5000, tag: "50" },
  "59.94": { num: 1001, den: 60000, tag: "5994" },
  "60": { num: 100, den: 6000, tag: "60" },
} as const;
export type FrameRate = keyof typeof FRAME_RATES;

export const RESOLUTIONS = {
  "720p": { w: 1280, h: 720, name: "720p" },
  "1080p": { w: 1920, h: 1080, name: "1080p" },
  "4k": { w: 3840, h: 2160, name: "3840x2160p" },
} as const;
export type Resolution = keyof typeof RESOLUTIONS;

export interface MediaInfo {
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface MarkerSpec {
  /** Seconds from the start of the clip as it appears in the timeline. */
  at: number;
  name: string;
  kind?: "standard" | "todo" | "chapter";
}

export interface ClipSpec {
  path: string;
  name?: string;
  /** Seconds into the source to start from. */
  in?: number;
  /** Seconds into the source to end at. */
  out?: number;
  markers?: MarkerSpec[];
}

export interface TimelineSpec {
  eventName: string;
  projectName: string;
  frameRate: FrameRate;
  resolution: Resolution;
  clips: Array<ClipSpec & { media: MediaInfo }>;
  libraryLocation?: string;
  copyAssets?: boolean;
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** file:// URL with each path segment percent-encoded. */
export function fileUrl(path: string, trailingSlash = false): string {
  const enc = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${enc}${trailingSlash && !enc.endsWith("/") ? "/" : ""}`;
}

/** Rational time string for a whole number of frames, e.g. "3003/30000s". */
export function framesToTime(frames: number, rate: FrameRate): string {
  const { num, den } = FRAME_RATES[rate];
  if (frames === 0) return "0s";
  return `${frames * num}/${den}s`;
}

export function secondsToFrames(seconds: number, rate: FrameRate): number {
  const { num, den } = FRAME_RATES[rate];
  // Small epsilon so 2.0 s at 25 fps is exactly 50 frames, not 49.
  return Math.floor((seconds * den) / num + 1e-6);
}

export function formatName(rate: FrameRate, res: Resolution): string {
  return `FFVideoFormat${RESOLUTIONS[res].name}${FRAME_RATES[rate].tag}`;
}

/** Normalise a library path to a .fcpbundle file URL (FCP only auto-creates .fcpbundle). */
export function libraryUrl(location: string): string {
  const withExt = extname(location).toLowerCase() === ".fcpbundle" ? location : `${location.replace(/\/$/, "")}.fcpbundle`;
  return fileUrl(withExt);
}

export function importOptionsXml(libraryLocation: string | undefined, copyAssets: boolean | undefined): string {
  const opts: string[] = [];
  if (libraryLocation) opts.push(`<option key="library location" value="${xmlEscape(libraryUrl(libraryLocation))}"/>`);
  opts.push(`<option key="suppress warnings" value="1"/>`);
  if (copyAssets !== undefined) opts.push(`<option key="copy assets" value="${copyAssets ? 1 : 0}"/>`);
  return `<import-options>\n    ${opts.join("\n    ")}\n  </import-options>`;
}

export interface BuiltTimeline {
  xml: string;
  totalFrames: number;
  clips: Array<{ name: string; startFrame: number; frames: number }>;
  warnings: string[];
}

export function buildFcpxml(spec: TimelineSpec): BuiltTimeline {
  const rate = spec.frameRate;
  const { num, den } = FRAME_RATES[rate];
  const res = RESOLUTIONS[spec.resolution];
  const warnings: string[] = [];
  const resources: string[] = [
    `<format id="r1" name="${formatName(rate, spec.resolution)}" frameDuration="${num}/${den}s" width="${res.w}" height="${res.h}"/>`,
  ];
  const spine: string[] = [];
  const placed: BuiltTimeline["clips"] = [];

  let offset = 0;
  spec.clips.forEach((clip, i) => {
    const id = `r${i + 2}`;
    const name = clip.name ?? basename(clip.path, extname(clip.path));
    const assetFrames = secondsToFrames(clip.media.durationSeconds, rate);
    if (assetFrames <= 0) {
      warnings.push(`${name}: zero length, skipped`);
      return;
    }
    let inF = clip.in !== undefined ? secondsToFrames(clip.in, rate) : 0;
    let outF = clip.out !== undefined ? secondsToFrames(clip.out, rate) : assetFrames;
    if (outF > assetFrames) {
      warnings.push(`${name}: out point ${clip.out}s is past the end of the media; trimmed to the end`);
      outF = assetFrames;
    }
    if (inF >= outF) {
      warnings.push(`${name}: in point is at or after the out point, skipped`);
      return;
    }
    if (inF < 0) inF = 0;
    const len = outF - inF;

    resources.push(
      `<asset id="${id}" name="${xmlEscape(name)}" start="0s" duration="${framesToTime(assetFrames, rate)}" hasVideo="${clip.media.hasVideo ? 1 : 0}" hasAudio="${clip.media.hasAudio ? 1 : 0}"${clip.media.hasAudio ? ' audioSources="1" audioChannels="2" audioRate="48000"' : ""}>
      <media-rep kind="original-media" src="${xmlEscape(fileUrl(clip.path))}"/>
    </asset>`,
    );

    const markers = (clip.markers ?? [])
      .map((m) => {
        const atF = inF + secondsToFrames(m.at, rate);
        if (atF < inF || atF >= outF) {
          warnings.push(`${name}: marker "${m.name}" at ${m.at}s is outside the clip, skipped`);
          return "";
        }
        const start = framesToTime(atF, rate);
        const oneFrame = `${num}/${den}s`;
        if (m.kind === "chapter") {
          return `\n        <chapter-marker start="${start}" duration="${oneFrame}" value="${xmlEscape(m.name)}" posterOffset="0s"/>`;
        }
        const todo = m.kind === "todo" ? ' completed="0"' : "";
        return `\n        <marker start="${start}" duration="${oneFrame}" value="${xmlEscape(m.name)}"${todo}/>`;
      })
      .join("");

    spine.push(
      `<asset-clip ref="${id}" name="${xmlEscape(name)}" offset="${framesToTime(offset, rate)}" start="${framesToTime(inF, rate)}" duration="${framesToTime(len, rate)}">${markers}${markers ? "\n      " : ""}</asset-clip>`,
    );
    placed.push({ name, startFrame: offset, frames: len });
    offset += len;
  });

  if (placed.length === 0) throw new Error("No usable clips: every clip was empty or had invalid in/out points.");

  const importOpts =
    spec.libraryLocation || spec.copyAssets !== undefined
      ? `  ${importOptionsXml(spec.libraryLocation, spec.copyAssets)}\n`
      : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
${importOpts}  <resources>
    ${resources.join("\n    ")}
  </resources>
  <event name="${xmlEscape(spec.eventName)}">
    <project name="${xmlEscape(spec.projectName)}">
      <sequence format="r1" duration="${framesToTime(offset, rate)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
        <spine>
      ${spine.join("\n      ")}
        </spine>
      </sequence>
    </project>
  </event>
</fcpxml>
`;
  return { xml, totalFrames: offset, clips: placed, warnings };
}

/**
 * Put an <import-options> element first inside <fcpxml> (where the DTD
 * requires it), replacing any that is already there.
 */
export function injectImportOptions(xml: string, libraryLocation: string, copyAssets?: boolean): string {
  const stripped = xml.replace(/<import-options>[\s\S]*?<\/import-options>\s*/g, "");
  const open = stripped.match(/<fcpxml\b[^>]*>/);
  if (!open || open.index === undefined) throw new Error("Not an FCPXML document: no <fcpxml> element found.");
  const at = open.index + open[0].length;
  return `${stripped.slice(0, at)}\n  ${importOptionsXml(libraryLocation, copyAssets)}${stripped.slice(at)}`;
}
