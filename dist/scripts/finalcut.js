import { appRef } from "../apps.js";
import { ArgBag, SEP_PRELUDE } from "../osascript.js";
/**
 * FCP's dictionary is read-only library inspection. `out` style variables are
 * declared outside the tell block (inside it FCP resolves names against its
 * own terms), and `file of lib` is coerced to text before POSIX path.
 */
export function buildListLibrariesScript() {
    return {
        script: `on run argv
${SEP_PRELUDE}
set vOut to ""
tell ${appRef("finalcut")}
  repeat with vLib in libraries
    set vLibName to name of vLib
    set vLibPath to ""
    try
      set vLibPath to POSIX path of ((file of vLib) as text)
    end try
    set vEvents to events of vLib
    if (count of vEvents) is 0 then
      set vOut to vOut & vLibName & US & vLibPath & US & RS
    end if
    repeat with vEvt in vEvents
      set vProjects to ""
      repeat with vProj in (projects of vEvt)
        set vProjects to vProjects & (name of vProj) & US
      end repeat
      set vOut to vOut & vLibName & US & vLibPath & US & (name of vEvt) & US & vProjects & RS
    end repeat
  end repeat
end tell
return vOut
end run`,
        args: [],
    };
}
/** Send an FCPXML file to Final Cut Pro with the Open Document Apple event. */
export function buildImportScript(fcpxmlPath) {
    const bag = new ArgBag();
    const ref = bag.ref(fcpxmlPath);
    return {
        script: `on run argv
set vFile to ${ref} as POSIX file
with timeout of 600 seconds
tell ${appRef("finalcut")}
  open vFile
end tell
end timeout
return "ok"
end run`,
        args: bag.values,
    };
}
/**
 * Fallback media probe through AVFoundation (JXA) for files Spotlight has
 * not indexed. Prints one JSON line per argument.
 */
export const AV_PROBE_JXA = `ObjC.import('AVFoundation');
function run(argv) {
  const out = [];
  for (const p of argv) {
    try {
      const asset = $.AVURLAsset.URLAssetWithURLOptions($.NSURL.fileURLWithPath(p), $());
      const d = asset.duration;
      const secs = d.timescale ? d.value / d.timescale : 0;
      const v = asset.tracksWithMediaType($.AVMediaTypeVideo).count;
      const a = asset.tracksWithMediaType($.AVMediaTypeAudio).count;
      out.push(JSON.stringify({ path: p, durationSeconds: secs, hasVideo: v > 0, hasAudio: a > 0 }));
    } catch (e) {
      out.push(JSON.stringify({ path: p, error: String(e) }));
    }
  }
  return out.join('\\n');
}`;
