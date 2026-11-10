import { test } from "node:test";
import assert from "node:assert/strict";
import { ArgBag, asNumber, splitRecords } from "../src/osascript.ts";
import { buildFcpxml, framesToTime, secondsToFrames, injectImportOptions, fileUrl, libraryUrl } from "../src/fcpxml.ts";
import { parseA1, buildNumbersWriteScript, buildNumbersCreateScript, buildNumbersReadScript, buildExportScript, buildKeynoteCreateScript, buildKeynoteReadScript, buildKeynoteThemesScript, buildPagesCreateScript, buildPagesReadScript, buildPagesTemplatesScript } from "../src/scripts/iwork.ts";
import { buildProcessScript, buildInfoScript, buildReplaceTextScript, PXM_OPS } from "../src/scripts/pixelmator.ts";
import { buildListLibrariesScript, buildImportScript } from "../src/scripts/finalcut.ts";
import { compressorArgs, pickSetting } from "../src/compressor.ts";
import { parseMdls } from "../src/media.ts";
import { absPath, outputFile, withExt } from "../src/paths.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Check AppleScript block structure: every opener has its matching end. */
function assertBalanced(script: string, label: string) {
  const stack: string[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim().replace(/--.*$/, "").trim();
    if (!line) continue;
    const endM = line.match(/^end (tell|try|repeat|if|timeout|run)\b/);
    if (endM) {
      const top = stack.pop();
      assert.equal(top, endM[1], `${label}: "end ${endM[1]}" closes "${top}"`);
      continue;
    }
    if (/^on error\b/.test(line)) {
      assert.equal(stack[stack.length - 1], "try", `${label}: on error outside try`);
      continue;
    }
    if (/^else( if .* then)?$/.test(line)) continue;
    if (/^on run\b/.test(line)) stack.push("run");
    else if (/^tell\b/.test(line) && !/\bto\b/.test(line)) stack.push("tell");
    else if (/^try$/.test(line)) stack.push("try");
    else if (/^repeat\b/.test(line)) stack.push("repeat");
    else if (/^with timeout\b/.test(line)) stack.push("timeout");
    else if (/^if\b.*\bthen$/.test(line)) stack.push("if");
  }
  assert.deepEqual(stack, [], `${label}: unclosed blocks ${stack.join(",")}`);
}

const EVIL = `a" & (do shell script "rm -rf ~") & "\nend tell`;

test("ArgBag keeps user text out of script source", () => {
  const bag = new ArgBag();
  assert.equal(bag.ref("x"), "(item 1 of argv)");
  assert.equal(bag.ref(EVIL), "(item 2 of argv)");
  assert.deepEqual(bag.values, ["x", EVIL]);
});

test("asNumber rejects non-finite values", () => {
  assert.equal(asNumber(1.5), "1.5");
  assert.throws(() => asNumber(NaN));
  assert.throws(() => asNumber(Infinity));
});

test("splitRecords", () => {
  assert.deepEqual(splitRecords("a\x1fb\x1ec\x1e"), [["a", "b"], ["c"]]);
});

test("every generated AppleScript is balanced and never contains user text", () => {
  const scripts: Array<[string, { script: string; args: string[] }]> = [
    ["pxm process", buildProcessScript({ input: EVIL, output: EVIL, format: "jpeg", quality: 80, ops: [...PXM_OPS], crop: { x: 0, y: 0, width: 10, height: 10 }, resize: { longEdge: 2000 }, colorAdjustments: { exposure: 10, "black point": -5 } })],
    ["pxm process minimal", buildProcessScript({ input: "/a.png", output: "/b.png", format: "pxd", ops: [] })],
    ["pxm info", buildInfoScript(EVIL)],
    ["pxm replace", buildReplaceTextScript(EVIL, EVIL, "png", undefined, [{ find: EVIL, replace: EVIL }], true, false)],
    ["kn themes", buildKeynoteThemesScript()],
    ["kn create", buildKeynoteCreateScript(EVIL, [{ layout: EVIL, title: EVIL, body: EVIL, notes: EVIL }, { title: "t" }, { layout: "L" }], EVIL)],
    ["kn read", buildKeynoteReadScript(EVIL)],
    ["pg templates", buildPagesTemplatesScript()],
    ["pg create", buildPagesCreateScript(EVIL, EVIL, EVIL)],
    ["pg create blank", buildPagesCreateScript(undefined, "x", "/o.pages")],
    ["pg read", buildPagesReadScript(EVIL)],
    ["nb read", buildNumbersReadScript(EVIL, EVIL, EVIL)],
    ["nb write", buildNumbersWriteScript(EVIL, EVIL, EVIL, EVIL, [{ cell: "B2", value: EVIL }, { cell: "C3", value: null }], { start: "A5", values: [[1, true, EVIL]] })],
    ["nb write in place", buildNumbersWriteScript("/a.numbers", undefined, undefined, undefined, [{ cell: "A1", value: 2 }], undefined)],
    ["nb create", buildNumbersCreateScript([[EVIL, 1], [2.5, false]], EVIL, 1, EVIL, EVIL)],
    ["export key", buildExportScript("keynote", EVIL, EVIL, "images", "JPEG")],
    ["export numbers", buildExportScript("numbers", EVIL, EVIL, "xlsx")],
    ["fcp libs", buildListLibrariesScript()],
    ["fcp import", buildImportScript(EVIL)],
  ];
  for (const [label, { script, args }] of scripts) {
    assertBalanced(script, label);
    assert.ok(!script.includes("rm -rf"), `${label}: user text leaked into source`);
    assert.ok(script.startsWith("on run argv"), `${label}: must start with on run argv`);
    for (const m of script.matchAll(/item (\d+) of argv/g)) {
      assert.ok(Number(m[1]) <= args.length, `${label}: argv item ${m[1]} out of range`);
    }
  }
});

test("Pixelmator: input path coerced outside the tell block", () => {
  const { script } = buildProcessScript({ input: "/i.jpg", output: "/o.png", format: "png", ops: ["remove_background"] });
  const coerce = script.indexOf("as POSIX file");
  const tell = script.indexOf("tell application");
  assert.ok(coerce > 0 && coerce < tell);
  assert.match(script, /remove background vDoc/);
  assert.match(script, /export vDoc to outFile as PNG$/m);
});

test("Pixelmator: quality only for lossy formats; resize forms", () => {
  assert.match(buildProcessScript({ input: "/i", output: "/o", format: "jpeg", quality: 85, ops: [] }).script, /as JPEG with properties \{compression factor:85\}/);
  assert.doesNotMatch(buildProcessScript({ input: "/i", output: "/o", format: "png", quality: 85, ops: [] }).script, /compression factor/);
  assert.match(buildProcessScript({ input: "/i", output: "/o", format: "png", ops: [], resize: { width: 800 } }).script, /resize image vDoc width 800 algorithm lanczos/);
  assert.match(buildProcessScript({ input: "/i", output: "/o", format: "pxd", ops: [] }).script, /save vDoc in outFile/);
});

test("Numbers: A1 parsing and literal embedding", () => {
  assert.deepEqual(parseA1("A1"), { row: 1, col: 1 });
  assert.deepEqual(parseA1("aa10"), { row: 10, col: 27 });
  assert.throws(() => parseA1("1A"));
  const { script, args } = buildNumbersWriteScript("/a.numbers", undefined, undefined, undefined, [{ cell: "C2", value: 3.25 }, { cell: "D2", value: "hi" }], undefined);
  assert.match(script, /set value of cell 3 of row 2 of vTable to 3\.25/);
  assert.match(script, /set value of cell 4 of row 2 of vTable to \(item 2 of argv\)/);
  assert.ok(args.includes("hi"));
  assert.match(script, /save vDoc$/m);
});

test("iWork export rejects formats the app can't produce", () => {
  assert.throws(() => buildExportScript("pages", "/a", "/b", "xlsx"));
  assert.match(buildExportScript("keynote", "/a", "/b", "pptx").script, /as Microsoft PowerPoint/);
});

test("FCPXML frame math", () => {
  assert.equal(secondsToFrames(2, "25"), 50);
  assert.equal(secondsToFrames(1, "29.97"), 29);
  assert.equal(framesToTime(30, "29.97"), "30030/30000s");
  assert.equal(framesToTime(0, "25"), "0s");
});

test("FCPXML timeline: offsets, trims, markers, escaping", () => {
  const built = buildFcpxml({
    eventName: "Ev & <1>",
    projectName: 'Cut "A"',
    frameRate: "25",
    resolution: "1080p",
    libraryLocation: "/Volumes/Media/Movies/My Lib",
    clips: [
      { path: "/Media/A clip.mov", media: { durationSeconds: 10, hasVideo: true, hasAudio: true }, in: 2, out: 6, markers: [{ at: 1, name: "Beat", kind: "chapter" }, { at: 99, name: "late" }] },
      { path: "/Media/B#1.mov", name: "B", media: { durationSeconds: 3, hasVideo: true, hasAudio: false }, out: 50 },
    ],
  });
  assert.equal(built.totalFrames, 100 + 75);
  assert.deepEqual(built.clips.map((c) => c.startFrame), [0, 100]);
  assert.match(built.xml, /offset="10000\/2500s" start="0s" duration="7500\/2500s"/);
  assert.match(built.xml, /start="5000\/2500s" duration="10000\/2500s"/);
  assert.match(built.xml, /<chapter-marker start="7500\/2500s"/);
  assert.match(built.xml, /name="Ev &amp; &lt;1&gt;"/);
  assert.match(built.xml, /name="Cut &quot;A&quot;"/);
  assert.match(built.xml, /src="file:\/\/\/Media\/A%20clip\.mov"/);
  assert.match(built.xml, /src="file:\/\/\/Media\/B%231\.mov"/);
  assert.match(built.xml, /value="file:\/\/\/Volumes\/Media\/Movies\/My%20Lib\.fcpbundle"/);
  assert.match(built.xml, /<fcpxml version="1\.11">\n  <import-options>/);
  assert.equal(built.warnings.length, 2);
  assert.match(built.xml, /name="FFVideoFormat1080p25" frameDuration="100\/2500s"/);
});

test("FCPXML: injecting import options replaces old ones, first in <fcpxml>", () => {
  const src = `<?xml version="1.0"?>\n<fcpxml version="1.13">\n  <import-options><option key="x" value="y"/></import-options>\n  <resources/>\n</fcpxml>`;
  const out = injectImportOptions(src, "/L.fcpbundle", false);
  assert.equal((out.match(/<import-options>/g) ?? []).length, 1);
  assert.match(out, /<fcpxml version="1\.13">\n  <import-options>/);
  assert.match(out, /key="copy assets" value="0"/);
  assert.throws(() => injectImportOptions("<xml/>", "/L"));
  assert.equal(libraryUrl("/a/b.fcpbundle"), "file:///a/b.fcpbundle");
  assert.equal(fileUrl("/a b/c"), "file:///a%20b/c");
});

test("Compressor args and setting matching", () => {
  assert.deepEqual(compressorArgs({ input: "/i.mov", settingPath: "/s.compressorsetting", output: "/o.mp4", batchName: "B", priority: "high" }), [
    "-batchname", "B", "-priority", "high", "-jobpath", "/i.mov", "-settingpath", "/s.compressorsetting", "-locationpath", "/o.mp4",
  ]);
  const settings = [
    { name: "Apple Devices HD (Best Quality)", path: "/x/1", source: "built-in" as const },
    { name: "Apple Devices 4K", path: "/x/2", source: "built-in" as const },
    { name: "ProRes 422", path: "/x/3", source: "built-in" as const },
  ];
  assert.equal(pickSetting(settings, "prores").path, "/x/3");
  assert.throws(() => pickSetting(settings, "apple devices"), /matches 2/);
  assert.throws(() => pickSetting(settings, "nope"), /No Compressor setting/);
});

test("mdls parsing", () => {
  assert.deepEqual(parseMdls("12.48\0(\n    Sound,\n    Video\n)"), { duration: 12.48, types: ["Sound", "Video"] });
  assert.deepEqual(parseMdls("(null)\0(null)"), { duration: null, types: [] });
});

test("paths: absolute only, no clobbering, never over the input", () => {
  assert.throws(() => absPath("relative/file.png"), /absolute/);
  assert.ok(absPath("~/x").endsWith("/x"));
  const dir = mkdtempSync(join(tmpdir(), "csmcp-"));
  const f = join(dir, "a.png");
  writeFileSync(f, "x");
  assert.throws(() => outputFile(f), /already exists/);
  assert.equal(outputFile(f, { overwrite: true }), f);
  assert.throws(() => outputFile(f, { overwrite: true, inputs: [f] }), /overwrite the input/);
  assert.equal(outputFile(join(dir, "new/sub/b.png")), join(dir, "new/sub/b.png"));
});

test("paths: withExt keeps a matching extension, including .jpeg and .tif", () => {
  assert.equal(withExt("/tmp/a.jpg", ".jpg"), "/tmp/a.jpg");
  assert.equal(withExt("/tmp/a.jpeg", ".jpg"), "/tmp/a.jpeg");
  assert.equal(withExt("/tmp/a.JPEG", ".jpg"), "/tmp/a.JPEG");
  assert.equal(withExt("/tmp/a.tif", ".tiff"), "/tmp/a.tif");
  assert.equal(withExt("/tmp/a", ".jpg"), "/tmp/a.jpg");
  assert.equal(withExt("/tmp/a.png", ".jpg"), "/tmp/a.png.jpg");
  assert.equal(withExt("/tmp/a.jpeg", ".png"), "/tmp/a.jpeg.png");
});

import { parseSettingXml } from "../src/compressor.ts";
test("Compressor setting XML: names decoded, extension read", () => {
  const xml = `<?xml version="1.0"?><setting name="HD%25201080p"><version>1</version><description>Export%20a%20movie</description><encoder><file-extension>m4v</file-extension></encoder></setting>`;
  assert.deepEqual(parseSettingXml(xml), { name: "HD 1080p", description: "Export a movie", outputExtension: "m4v" });
});

import { localizeSetting } from "../src/compressor.ts";
test("Compressor setting names: string keys are localized, unknown keys fall back", () => {
  const strings = new Map([["proRes422Name", "Apple ProRes 422"], ["proRes422Description", "QuickTime movie with Apple ProRes 422 video."], ["4KWebShareName", "4K"]]);
  assert.deepEqual(localizeSetting({ name: "proRes422Name", description: "proRes422Description" }, "proRes422Name", strings), { name: "Apple ProRes 422", description: "QuickTime movie with Apple ProRes 422 video." });
  assert.deepEqual(localizeSetting({}, "4KWebShareName", strings), { name: "4K", description: undefined });
  assert.deepEqual(localizeSetting({ name: "HD 1080p", description: "Export a movie" }, "x", strings), { name: "HD 1080p", description: "Export a movie" });
  assert.deepEqual(localizeSetting({ name: "unknownName", description: "unknownDesc" }, "My Setting", strings), { name: "My Setting", description: undefined });
});

import { riveOpensWindow } from "../src/tools/headless.ts";
test("Rive: only the bare project form opens a window", () => {
  assert.equal(riveOpensWindow(["mascot"]), true);
  assert.equal(riveOpensWindow(["mascot", "--once"]), false);
  assert.equal(riveOpensWindow(["mascot", "--verify"]), false);
  assert.equal(riveOpensWindow(["create", "mascot"]), false);
  assert.equal(riveOpensWindow(["--help"]), false);
  assert.equal(riveOpensWindow([".", "--screenshot", "--advance=1"]), false);
  assert.equal(riveOpensWindow([".", "--format=json", "--verify"]), false);
  assert.equal(riveOpensWindow(["open", "abc"]), true);
  assert.equal(riveOpensWindow([".", "--serve"]), true);
  assert.equal(riveOpensWindow([".", "--serve", "--headless-serve"]), false);
  assert.equal(riveOpensWindow([".", "--debug"]), true);
  assert.equal(riveOpensWindow(["schema", "Artboard"]), false);
});

import { buildGodotArgs, wrapGdscript, godotErrorLines } from "../src/tools/headless.ts";
test("Godot: always headless, project and script placed, window flags refused", () => {
  assert.deepEqual(buildGodotArgs({ args: ["--import"], projectPath: "/j/game" }), ["--headless", "--path", "/j/game", "--import"]);
  assert.deepEqual(buildGodotArgs({ args: ["--headless", "--version"] }), ["--headless", "--version"]);
  assert.deepEqual(
    buildGodotArgs({ args: [], projectPath: "/j/game", script: "/tmp/run.gd", userArgs: ["a"] }),
    ["--headless", "--path", "/j/game", "--script", "/tmp/run.gd", "--", "a"],
  );
  assert.throws(() => buildGodotArgs({ args: ["--project-manager"] }), /project manager/);
  assert.throws(() => buildGodotArgs({ args: ["-p"], allowWindow: true }), /project manager/);
  assert.throws(() => buildGodotArgs({ args: ["--write-movie", "out.png"] }), /allowWindow/);
  assert.throws(() => buildGodotArgs({ args: ["--display-driver=macos"] }), /allowWindow/);
  assert.deepEqual(buildGodotArgs({ args: ["--write-movie", "o.png"], allowWindow: true }), ["--write-movie", "o.png"]);
  assert.throws(() => buildGodotArgs({ args: ["--path", "x"], projectPath: "/j" }), /not both/);
  assert.throws(() => buildGodotArgs({ args: ["-s", "x.gd"], script: "/y.gd" }), /not both/);
});

test("Godot: snippets wrapped as a quitting SceneTree script; full scripts untouched", () => {
  const w = wrapGdscript('print("hi")\nvar x = 1');
  assert.match(w, /^extends SceneTree/);
  assert.match(w, /func _initialize\(\) -> void:\n\tprint\("hi"\)\n\tvar x = 1\n\tquit\(\)/);
  const full = "extends SceneTree\nfunc _init():\n\tquit()\n";
  assert.equal(wrapGdscript(full), full);
});

test("Godot: error lines collected", () => {
  assert.deepEqual(godotErrorLines("\x1b[91mERROR: red\x1b[0m"), ["ERROR: red"]);
  const out = "Godot Engine v4.5\nSCRIPT ERROR: Parse Error: x\n   at: foo\nERROR: Failed to load\nUSER ERROR: boom\nall good";
  assert.deepEqual(godotErrorLines(out), ["SCRIPT ERROR: Parse Error: x", "ERROR: Failed to load", "USER ERROR: boom"]);
});

import { isConsoleLocked, LOCKED_MESSAGE } from "../src/lock.ts";
test("lock check reads ioreg's IOConsoleLocked", () => {
  assert.equal(isConsoleLocked('    | "IOConsoleLocked" = Yes\n'), true);
  assert.equal(isConsoleLocked('    | "IOConsoleLocked" = No\n'), false);
  assert.equal(isConsoleLocked(""), false);
  assert.match(LOCKED_MESSAGE, /Nothing was done/);
});
