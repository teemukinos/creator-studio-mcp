import { run, runOsa } from "./osascript.js";
import { AV_PROBE_JXA } from "./scripts/finalcut.js";
/** Parse `mdls -raw` output for several attributes separated by NUL. */
export function parseMdls(raw) {
    const [dur, types] = raw.split("\0");
    const d = dur && dur !== "(null)" ? Number(dur) : NaN;
    const list = types && types !== "(null)" ? types.replace(/[()\s"]/g, "").split(",").filter(Boolean) : [];
    return { duration: Number.isFinite(d) ? d : null, types: list };
}
async function probeSpotlight(path) {
    try {
        const { stdout } = await run("mdls", ["-raw", "-name", "kMDItemDurationSeconds", "-name", "kMDItemMediaTypes", path]);
        const { duration, types } = parseMdls(stdout);
        if (duration === null || duration <= 0)
            return null;
        const lower = types.map((t) => t.toLowerCase());
        const hasVideo = lower.includes("video");
        const hasAudio = lower.includes("sound") || lower.includes("audio");
        return { durationSeconds: duration, hasVideo: hasVideo || !hasAudio, hasAudio };
    }
    catch {
        return null;
    }
}
async function probeAvFoundation(paths) {
    const result = new Map();
    if (paths.length === 0)
        return result;
    const out = await runOsa(AV_PROBE_JXA, paths, { language: "JavaScript", timeoutMs: 120_000 });
    for (const line of out.split("\n")) {
        if (!line.trim())
            continue;
        const r = JSON.parse(line);
        if (r.error || !r.durationSeconds)
            continue;
        result.set(r.path, { durationSeconds: r.durationSeconds, hasVideo: !!r.hasVideo, hasAudio: !!r.hasAudio });
    }
    return result;
}
/** Duration and track types for each file: Spotlight first, AVFoundation as fallback. */
export async function probeMedia(paths) {
    const found = new Map();
    const missing = [];
    for (const p of paths) {
        const info = await probeSpotlight(p);
        if (info)
            found.set(p, info);
        else
            missing.push(p);
    }
    if (missing.length) {
        try {
            for (const [p, info] of await probeAvFoundation(missing))
                found.set(p, info);
        }
        catch {
            /* reported per file by the caller */
        }
    }
    return found;
}
