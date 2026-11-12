#!/usr/bin/env node
// Real-app smoke run for check 21, and the tool coverage map for check 24.
//
//   node scripts/smoke.mjs <empty temp folder> -- <server command> [args...]
//
// Drives the server over stdio (through scripts/mcp_probe.mjs) and checks each result from files
// it writes inside the temp folder. Apps stay hidden: no call passes front: true, and no call
// touches a document outside the temp folder. The last line of output is a one-line summary.
//
// CSMCP_SMOKE_FULL=1 also runs every other tool against real apps (see FULL_TOOLS). It needs Blender,
// the Rive CLI, Godot, Final Cut Pro and Compressor, Accessibility and Screen Recording for the app that
// runs it, and an unlocked screen. It launches Final Cut Pro, which reopens the user's last libraries,
// imports into two new libraries in the temp folder and closes them again (Final Cut Pro comes to the front
// for that moment: it has no scripted close). It also renders the timeline headless with the skill's
// scripts/render_fcpxml.py, which needs ffmpeg. It keeps one shortcut,
// named CSMCP_SMOKE_SHORTCUT (default "creator-studio-mcp smoke test"), which it imports the first time.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

// How each tool is verified. "check 21" means this script calls it; "check 21 full" means it calls it with
// CSMCP_SMOKE_FULL=1; "unit test" names a test in test/.
export const COVERAGE = [
  { tool: 'creator_studio_status', how: 'check 21' },
  { tool: 'pixelmator_process_image', how: 'check 21' },
  { tool: 'pixelmator_batch_process', how: 'check 21' },
  { tool: 'pixelmator_image_info', how: 'check 21' },
  { tool: 'pixelmator_replace_text', how: 'check 21 full' },
  { tool: 'keynote_list_themes', how: 'check 21' },
  { tool: 'keynote_create_presentation', how: 'check 21' },
  { tool: 'keynote_read_presentation', how: 'check 21' },
  { tool: 'pages_list_templates', how: 'check 21' },
  { tool: 'pages_create_document', how: 'check 21' },
  { tool: 'pages_read_document', how: 'check 21' },
  { tool: 'numbers_read_table', how: 'check 21' },
  { tool: 'numbers_write_cells', how: 'check 21' },
  { tool: 'numbers_create_spreadsheet', how: 'check 21' },
  { tool: 'iwork_export', how: 'check 21' },
  { tool: 'compressor_list_settings', how: 'check 21' },
  { tool: 'compressor_transcode', how: 'check 21 full' },
  { tool: 'finalcut_list_libraries', how: 'check 21 full' },
  { tool: 'finalcut_build_timeline', how: 'check 21 full' },
  { tool: 'finalcut_import_fcpxml', how: 'check 21 full' },
  { tool: 'app_open', how: 'check 21 full' },
  { tool: 'ui_list_menus', how: 'check 21 full' },
  { tool: 'ui_click_menu', how: 'check 21 full' },
  { tool: 'ui_snapshot', how: 'check 21 full' },
  { tool: 'ui_find', how: 'check 21 full' },
  { tool: 'ui_click', how: 'check 21 full' },
  { tool: 'ui_set_value', how: 'check 21 full' },
  { tool: 'ui_press_key', how: 'check 21 full' },
  { tool: 'ui_type_text', how: 'check 21 full' },
  { tool: 'ui_wait_for', how: 'check 21 full' },
  { tool: 'ui_batch', how: 'check 21 full' },
  { tool: 'ui_screenshot', how: 'check 21 full' },
  { tool: 'app_shortcut_actions', how: 'check 21' },
  { tool: 'shortcuts_list', how: 'check 21' },
  { tool: 'shortcuts_run', how: 'check 21 full' },
  { tool: 'blender_run_python', how: 'check 21 full' },
  { tool: 'rive_cli', how: 'check 21 full' },
  { tool: 'godot_cli', how: 'check 21 full' },
];

const ROWS = [['Name', 'Count'], ['alpha', 1], ['beta', 2]];

function plan(t) {
  return [
    { name: 'creator_studio_status', args: {} },
    { name: 'keynote_list_themes', args: {} },
    { name: 'pages_list_templates', args: {} },
    { name: 'numbers_create_spreadsheet', args: { rows: ROWS, output: join(t, 'table.numbers') } },
    { name: 'numbers_read_table', args: { input: join(t, 'table.numbers') } },
    { name: 'iwork_export', args: { input: join(t, 'table.numbers'), format: 'csv', output: join(t, 'table.csv') } },
    { name: 'numbers_write_cells', args: { input: join(t, 'table.numbers'), output: join(t, 'table2.numbers'), cells: [{ cell: 'B3', value: 7 }] } },
    { name: 'numbers_read_table', args: { input: join(t, 'table2.numbers') } },
    { name: 'keynote_create_presentation', args: { slides: [{ title: 'Smoke title', body: 'Smoke body', notes: 'Smoke notes' }], output: join(t, 'deck.key') } },
    { name: 'keynote_read_presentation', args: { input: join(t, 'deck.key') } },
    { name: 'pages_create_document', args: { bodyText: 'Smoke body text', output: join(t, 'doc.pages') } },
    { name: 'pages_read_document', args: { input: join(t, 'doc.pages') } },
    { name: 'pixelmator_image_info', args: { input: join(t, 'in.png') } },
    { name: 'pixelmator_process_image', args: { input: join(t, 'in.png'), output: join(t, 'out', 'x.jpeg'), format: 'jpeg', resize: { width: 32, height: 24 } } },
    { name: 'pixelmator_batch_process', args: { inputs: [join(t, 'in.png')], outputFolder: join(t, 'batch'), format: 'png', resize: { width: 16, height: 12 } } },
    { name: 'compressor_list_settings', args: {} },
    { name: 'app_shortcut_actions', args: { app: 'keynote' } },
    { name: 'shortcuts_list', args: {} },
  ];
}
export const SMOKE_TOOLS = [...new Set(plan('/x').map((c) => c.name))];

// ---- Full mode: every other tool, against real apps. Each call carries the check of its own result.
export const SHORTCUT = process.env.CSMCP_SMOKE_SHORTCUT || 'creator-studio-mcp smoke test';
const SHORTCUT_TEXT = 'csmcp smoke ok';
const TYPED = ' typed ✓ \u{1F600}';
const isMp4 = (buf) => buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp';
const fileText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const libs = (j) => (j?.libraries ?? []).map((l) => l.name);

function fullPlan(t, o) {
  const T = (...p) => join(t, ...p);
  const calls = [
    // Media: a Keynote movie feeds Compressor and Final Cut.
    { name: 'iwork_export', args: { input: T('deck.key'), format: 'mov', output: T('clip.mov') }, timeout: 600000,
      check: (c, j) => (j?.output === T('clip.m4v') && existsSync(T('clip.m4v')) && isMp4(readFileSync(T('clip.m4v'))) ? null : `no MPEG-4 at clip.m4v: ${c.text.slice(0, 80)}`) },
    { name: 'compressor_transcode', args: { input: T('clip.m4v'), setting: 'HEVC Broadband HD', output: T('hevc.mov'), wait: true, waitMinutes: 10 }, timeout: 700000,
      check: (c, j) => (j?.finished && existsSync(T('hevc.mov')) && isMp4(readFileSync(T('hevc.mov'))) ? null : `no finished hevc.mov: ${c.text.slice(0, 80)}`) },
    { name: 'finalcut_build_timeline', timeout: 900000,
      args: { clips: [{ path: T('clip.m4v'), name: 'Smoke clip', out: 3, markers: [{ at: 1, name: 'Smoke marker' }] }], projectName: 'Smoke Project', eventName: 'Smoke Event', output: T('smoke.fcpxml'), pushToFinalCut: true, libraryLocation: T('SmokeA.fcpbundle') },
      check: (c, j) => (j?.dtdValidation === 'valid' && j?.pushed && j?.durationSeconds === 3 && /Smoke marker/.test(fileText(T('smoke.fcpxml')) ?? '') ? null : `timeline not valid and pushed: ${c.text.slice(0, 80)}`) },
    { name: 'finalcut_import_fcpxml', args: { input: T('smoke.fcpxml'), libraryLocation: T('SmokeB.fcpbundle') }, timeout: 900000, check: () => null },
    { name: 'finalcut_list_libraries', args: {},
      check: (c, j) => {
        const mine = (j?.libraries ?? []).filter((l) => l.name === 'SmokeA' || l.name === 'SmokeB');
        const ok = mine.length === 2 && mine.every((l) => l.events.some((e) => e.name === 'Smoke Event' && e.projects.includes('Smoke Project')));
        return ok ? null : `SmokeA and SmokeB with the project not both open: ${JSON.stringify(mine).slice(0, 80)}`;
      } },
    // Headless engines.
    { name: 'blender_run_python', timeout: 600000, args: { cwd: t, code: [
        'import bpy', 's = bpy.context.scene', "s.render.engine = 'BLENDER_WORKBENCH'",
        's.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage = 40, 30, 100',
        `s.render.filepath = ${JSON.stringify(T('render.png'))}`, 'bpy.ops.render.render(write_still=True)',
        `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(T('scene.blend'))})`, "print('SMOKE', len(bpy.data.objects))"].join('\n') },
      check: (c) => {
        const s = existsSync(T('render.png')) ? pngSize(readFileSync(T('render.png'))) : null;
        if (!s || s.width !== 40 || s.height !== 30) return 'render.png is not 40x30';
        // Blender 5 saves .blend files zstd-compressed by default; older versions write a plain BLENDER header.
        const blend = existsSync(T('scene.blend')) ? readFileSync(T('scene.blend')).subarray(0, 7) : Buffer.alloc(0);
        if (blend.toString('latin1') !== 'BLENDER' && (blend.length < 4 || blend.readUInt32BE(0) !== 0x28b52ffd)) return 'no scene.blend';
        return /SMOKE \d+/.test(c.text) ? null : 'print output missing';
      } },
    { name: 'rive_cli', args: { args: ['create', 'smoke'], cwd: T('rive') }, timeout: 300000,
      check: () => (/This user: no windows/.test(fileText(T('rive', 'smoke', 'AGENTS.md')) ?? '') ? null : 'AGENTS.md lacks the no-windows rule') },
    { name: 'rive_cli', args: { args: ['smoke', '--verify'], cwd: T('rive') }, timeout: 300000, check: (c, j) => (j?.ok ? null : 'verify failed') },
    { name: 'rive_cli', args: { args: ['smoke', '--once'], cwd: T('rive') }, timeout: 300000,
      check: () => (fileText(T('rive', 'smoke', 'build', 'smoke.riv'))?.startsWith('RIVE') ? null : 'no build/smoke.riv') },
    { name: 'rive_cli', args: { args: ['smoke'], cwd: T('rive') }, expectError: /would open the preview window/ },
    { name: 'godot_cli', args: { args: ['--version'] }, timeout: 300000, check: (c, j) => (/^4\./.test(j?.output ?? '') ? null : `no Godot 4 version: ${c.text.slice(0, 60)}`) },
    { name: 'godot_cli', args: { projectPath: T('game'), code: "print('SMOKE ', 6 * 7)" }, timeout: 300000, check: (c, j) => (/SMOKE 42/.test(j?.output ?? '') ? null : 'no SMOKE 42') },
    { name: 'godot_cli', args: { projectPath: T('game'), code: "push_error('smoke boom')" }, timeout: 300000, expectError: /smoke boom/ },
    // Pixelmator: fill a template's text layer, read it back from the layered output.
    { name: 'pixelmator_replace_text', args: { input: T('tpl.pxd'), output: T('filled.pxd'), format: 'pxd', replacements: [{ find: 'Smoke', replace: 'World' }] },
      check: () => (existsSync(T('filled.pxd')) ? null : 'no filled.pxd') },
    { name: 'pixelmator_image_info', args: { input: T('filled.pxd') },
      check: (c, j) => ((j?.layers ?? []).some((l) => l.text === 'Hello World') ? null : `no "Hello World" text layer: ${c.text.slice(0, 80)}`) },
    // UI tools on a hidden TextEdit document in the temp folder.
    { name: 'app_open', args: { app: 'TextEdit', file: T('note.txt') }, check: (c, j) => (j?.visible === false ? null : 'not hidden') },
    { name: 'ui_list_menus', args: { app: 'TextEdit', menu: 'File', depth: 1, outFile: T('menus.txt') },
      check: (c, j) => (j?.count > 0 && /^File > New$/m.test(fileText(T('menus.txt')) ?? '') ? null : 'menus.txt lacks File > New') },
    { name: 'ui_snapshot', args: { app: 'TextEdit', depth: 4, maxNodes: 60 },
      check: (c, j) => ((j?.windows ?? []).includes('note.txt') && (j?.elements ?? []).some((e) => /TextArea .*= start/.test(e)) ? null : 'note.txt window or text missing') },
    { name: 'ui_set_value', args: { app: 'TextEdit', role: 'TextArea', value: 'set by smoke' }, check: () => null },
    { name: 'ui_type_text', args: { app: 'TextEdit', text: TYPED }, check: () => null },
    { name: 'ui_press_key', args: { app: 'TextEdit', key: 'x' }, check: () => null },
    { name: 'ui_find', args: { app: 'TextEdit', role: 'TextArea' },
      check: (c, j) => ((j?.matches?.[0]?.value ?? '').startsWith(`set by smoke${TYPED}x`) ? null : `text is ${JSON.stringify(j?.matches?.[0]?.value).slice(0, 60)}`) },
    { name: 'ui_press_key', args: { app: 'TextEdit', key: 's', modifiers: ['command'] }, expectError: /File > Save.*disabled/ },
    { name: 'ui_press_key', args: { app: 'TextEdit', key: 'n', modifiers: ['command'] }, check: (c, j) => (j?.menu === 'File > New' ? null : 'not pressed through File > New') },
    { name: 'ui_wait_for', args: { app: 'TextEdit', text: 'Untitled', role: 'Window', timeoutSeconds: 30 }, check: (c, j) => (j?.done ? null : 'no Untitled window') },
    { name: 'ui_click', args: { app: 'TextEdit', text: 'close button', role: 'Button', within: '0' }, check: () => null },
    { name: 'ui_wait_for', args: { app: 'TextEdit', text: 'Untitled', role: 'Window', gone: true, timeoutSeconds: 30 }, check: (c, j) => (j?.done ? null : 'Untitled window still open') },
    { name: 'ui_click_menu', args: { app: 'TextEdit', path: ['File', 'New'] }, check: () => null },
    { name: 'ui_wait_for', args: { app: 'TextEdit', text: 'Untitled', role: 'Window', timeoutSeconds: 30 }, check: (c, j) => (j?.done ? null : 'File > New opened no window') },
    { name: 'ui_click', args: { app: 'TextEdit', text: 'close button', role: 'Button', within: '0' }, check: () => null },
    { name: 'ui_batch', timeout: 120000,
      args: { app: 'TextEdit', background: false, statusFile: T('batch.json'), steps: [
        { op: 'clickMenu', path: ['File', 'New'] },
        { op: 'waitFor', text: 'Untitled', role: 'Window', timeoutSeconds: 30 },
        { op: 'click', text: 'close button', role: 'Button', within: '0' },
        { op: 'waitFor', text: 'Untitled', role: 'Window', gone: true, timeoutSeconds: 30 },
      ] },
      check: (c, j) => (j?.state === 'done' && !j?.skipped?.length ? null : `batch not done: ${c.text.replace(/\s+/g, ' ').slice(0, 80)}`) },
    { name: 'ui_screenshot', args: { app: 'TextEdit', maxSize: 400 }, expectError: /is hidden/ },
    { name: 'ui_screenshot', args: { maxSize: 400 },
      check: (c) => {
        const img = c.images?.[0];
        const s = img ? jpegSize(Buffer.from(img.data, 'base64')) : null;
        return s && Math.max(s.width, s.height) <= 400 ? null : 'no JPEG of at most 400 px';
      } },
    { name: 'ui_click', args: { app: 'TextEdit', text: 'close button', role: 'Button', within: '0' }, check: () => null },
    { name: 'ui_wait_for', args: { app: 'TextEdit', text: 'note.txt', role: 'Window', gone: true, timeoutSeconds: 30 },
      check: (c, j) => (j?.done && (fileText(T('note.txt')) ?? '').startsWith(`set by smoke${TYPED}x`) ? null : `note.txt not saved on close: ${JSON.stringify(fileText(T('note.txt'))).slice(0, 60)}`) },
  ];
  // Shortcuts: import the test shortcut once, through its hidden import window, then run it.
  if (o.importShortcut) {
    calls.push(
      { name: 'app_open', args: { app: 'Shortcuts', file: T('shortcut', `${SHORTCUT}.shortcut`) }, check: () => null },
      { name: 'ui_wait_for', args: { app: 'Shortcuts', text: 'Shared', role: 'StaticText', timeoutSeconds: 60 }, check: (c, j) => (j?.done ? null : 'no import window') },
      // The import window's buttons have no labels: the second is Add Shortcut.
      { name: 'ui_click', args: { app: 'Shortcuts', id: '0.0.0.2' }, check: () => null },
    );
  }
  calls.push(
    { name: 'shortcuts_run', args: { name: SHORTCUT, output: T('shortcut.txt') }, timeout: 300000,
      check: () => ((fileText(T('shortcut.txt')) ?? '').trim() === SHORTCUT_TEXT ? null : 'wrong shortcut output') },
    { name: 'shortcuts_run', args: { name: 'creator-studio-mcp no such shortcut' }, timeout: 60000, expectError: /find shortcut/i },
  );
  return calls;
}
export const FULL_TOOLS = [...new Set(fullPlan('/x', { importShortcut: true }).map((c) => c.name))].filter((n) => !SMOKE_TOOLS.includes(n));

// Final Cut Pro can't close a library by script, and ignores a row selected through
// Accessibility, so the temp libraries are closed with a real click: the app comes to the front,
// the library's sidebar row is clicked, and File > Close Library is chosen only when the item
// names that library. The Browser and the app are hidden again afterwards.
function closeTempLibraries(names) {
  const jxa = `
var names = ${JSON.stringify(names)};
var se = Application('System Events');
var fcp = Application('com.apple.FinalCutApp');
ObjC.import('CoreGraphics');
// The app that owns the frontmost normal window at a screen point.
function topWindowOwner(x, y) {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  for (var i = 0; i < list.length; i++) {
    var b = list[i].kCGWindowBounds;
    if (list[i].kCGWindowLayer === 0 && b.X <= x && x < b.X + b.Width && b.Y <= y && y < b.Y + b.Height) return list[i].kCGWindowOwnerName;
  }
  return 'nothing';
}
if (!fcp.running()) 'none';
else {
  var p = se.applicationProcesses.whose({ bundleIdentifier: 'com.apple.FinalCutApp' })()[0];
  var open = fcp.libraries.name().filter(function (n) { return names.indexOf(n) >= 0; });
  var out = [];
  if (open.length) {
    fcp.activate(); delay(1.5);
    var w = p.windows.byName('Final Cut Pro');
    var shown = null;
    // Paths found with ui_find in Final Cut Pro 12; searching the whole window takes minutes.
    var at = function (path) { try { var e = w; path.forEach(function (i) { e = e.uiElements[i]; }); e.role(); return e; } catch (x) { return null; } };
    var toggle = at([1, 5]);
    if (toggle && toggle.description() === 'Show or hide the Browser' && toggle.value() === 0) { toggle.actions.byName('AXPress').perform(); shown = toggle; delay(1); }
    var outline = at([0, 0, 0, 1, 0, 2, 3, 0, 0]);
    var outlines = outline && outline.role() === 'AXOutline' ? [outline] : [];
    // Close the library Final Cut Pro already has selected first: right after an import, a click on another
    // library's row may not change the selection.
    var fileMenu = p.menuBars[0].menuBarItems.byName('File').menus[0];
    var selected = open.filter(function (n) { var it = fileMenu.menuItems.byName('Close Library \\u201C' + n + '\\u201D'); return it.exists() && it.enabled(); });
    open = selected.concat(open.filter(function (n) { return selected.indexOf(n) < 0; }));
    open.forEach(function (name) {
      var why = '';
      for (var attempt = 0; attempt < 4; attempt++) {
        // Closing a library can leave no app in front, and activate() alone may not bring Final Cut Pro back.
        // A click while another app is in front would land in that app, so wait until it is in front.
        for (var w8 = 0; w8 < 10 && !p.frontmost(); w8++) { fcp.activate(); try { p.frontmost = true; } catch (x) {} delay(0.5); }
        if (!p.frontmost()) { why = 'Final Cut Pro would not come to the front'; delay(1); continue; }
        var item = p.menuBars[0].menuBarItems.byName('File').menus[0].menuItems.byName('Close Library \\u201C' + name + '\\u201D');
        var offered = function () { return item.exists() && item.enabled(); };
        // After one library closes, Final Cut Pro may already have selected the next one. Clicking a selected
        // row's name starts renaming it, which disables Close Library, so click only when needed.
        if (!offered()) {
          if (attempt) { se.keyCode(53); delay(0.5); }
          var field = null;
          outlines.forEach(function (o) { o.uiElements().forEach(function (r) { try { var f = r.uiElements[0].uiElements[0].uiElements[0]; if (!field && f.value() === name) field = f; } catch (x) {} }); });
          if (!field) { why = 'no sidebar row'; continue; }
          // Another app's window may overlap the sidebar, and a click goes to whatever is on top at that point.
          try { w.actions.byName('AXRaise').perform(); delay(0.5); } catch (x) {}
          var pos = field.position(), size = field.size();
          var owner = topWindowOwner(pos[0] + size[0] / 2, pos[1] + size[1] / 2);
          if (owner !== p.name()) { why = 'the row is covered by ' + owner; delay(1); continue; }
          field.click();
          // The File menu renames its Close Library item only once the selection has settled.
          for (var waited = 0; waited < 20 && !offered(); waited++) delay(0.5);
        }
        if (!item.exists() || !item.enabled()) { why = 'Close Library not offered'; continue; }
        item.click();
        // A library imported moments ago can take a minute to close; the sidebar stays as it was until then.
        var isOpen = function () { return fcp.libraries.name().indexOf(name) >= 0; };
        for (var closing = 0; closing < 240 && isOpen(); closing++) delay(0.5);
        why = isOpen() ? 'still closing after 2 minutes' : '';
        break;
      }
      if (why) out.push(name + ': ' + why);
    });
    if (shown) { try { shown.actions.byName('AXPress').perform(); } catch (x) {} }
    p.visible = false;
  }
  var still = fcp.libraries.name().filter(function (n) { return names.indexOf(n) >= 0; });
  still.length ? 'still open: ' + still.join(', ') + (out.length ? ' (' + out.join('; ') + ')' : '') : 'closed';
}`;
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', jxa], { encoding: 'utf8', input: '', timeout: 300000 });
  const said = (r.stdout || r.stderr || '').trim();
  return /^(closed|none)$/.test(said) ? null : `temp Final Cut libraries: ${said || 'osascript timed out'}; close ${names.join(' and ')} by hand`;
}

// The skill's headless route from a timeline to a video file (apple-apps.md, Recipes), run on the
// timeline the full run built. Returns a problem, or null.
function renderTimeline(t) {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'studio', 'scripts', 'render_fcpxml.py');
  const out = join(t, 'smoke-render.mp4');
  const r = spawnSync('python3', [script, join(t, 'smoke.fcpxml'), out], { encoding: 'utf8', input: '', timeout: 300000 });
  const said = (r.stdout || r.stderr || 'timed out').trim().split('\n');
  if (r.status !== 0 || !said[0].startsWith('PASS')) return `render_fcpxml.py: ${said.join(' ').slice(0, 100)}`;
  return existsSync(out) && isMp4(readFileSync(out)) ? null : 'render_fcpxml.py said PASS but wrote no MPEG-4';
}

// Files the full run starts from, made outside the server.
function prepareFull(t) {
  writeFileSync(join(t, 'note.txt'), 'start\n');
  mkdirSync(join(t, 'game'));
  writeFileSync(join(t, 'game', 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="smoke"\n');
  const osa = spawnSync('osascript', ['-e', `tell application "Pixelmator Pro"
  set d to make new document with properties {width:300, height:100}
  tell d to make new text layer with properties {text content:"Hello Smoke"}
  save d in POSIX file ${JSON.stringify(join(t, 'tpl.pxd'))}
  close d saving no
end tell`], { encoding: 'utf8' });
  if (osa.status !== 0) return `Pixelmator template: ${osa.stderr.trim()}`;
  const have = spawnSync('shortcuts', ['list'], { encoding: 'utf8', input: '' });
  const importShortcut = !have.stdout.split('\n').includes(SHORTCUT);
  if (importShortcut) {
    const d = join(t, 'shortcut');
    mkdirSync(d);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WFWorkflowActions</key><array><dict>
<key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key><dict><key>WFTextActionText</key><string>${SHORTCUT_TEXT}</string></dict>
</dict></array>
<key>WFWorkflowClientVersion</key><string>2607.0.2</string>
<key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
<key>WFWorkflowIcon</key><dict><key>WFWorkflowIconStartColor</key><integer>4282601983</integer><key>WFWorkflowIconGlyphNumber</key><integer>59511</integer></dict>
<key>WFWorkflowImportQuestions</key><array/><key>WFWorkflowTypes</key><array/>
<key>WFWorkflowInputContentItemClasses</key><array><string>WFStringContentItem</string></array>
<key>WFWorkflowOutputContentItemClasses</key><array><string>WFStringContentItem</string></array>
</dict></plist>
`;
    writeFileSync(join(d, 'unsigned.shortcut'), plist);
    const sign = spawnSync('shortcuts', ['sign', '--mode', 'anyone', '--input', join(d, 'unsigned.shortcut'), '--output', join(d, `${SHORTCUT}.shortcut`)], { encoding: 'utf8', input: '' });
    if (sign.status !== 0 || !existsSync(join(d, `${SHORTCUT}.shortcut`))) return `signing the test shortcut: ${(sign.stderr || sign.stdout).trim()}`;
  }
  return { importShortcut };
}

function verifyFull(t, calls, specs) {
  return specs.map((spec, i) => {
    const c = calls[i] ?? { status: 'MISSING', text: '' };
    const label = `${spec.name} #${i + 1}`;
    if (spec.expectError) {
      if (c.status !== 'TOOL-ERROR') return `${label}: ${c.status}, expected a refusal`;
      return spec.expectError.test(c.text) ? null : `${label}: refused with ${c.text.replace(/\s+/g, ' ').slice(0, 80)}`;
    }
    if (c.status !== 'OK') return `${label}: ${c.status} ${c.text.replace(/\s+/g, ' ').slice(0, 80)}`;
    const why = spec.check(c, json(c));
    return why ? `${label}: ${why}` : null;
  }).filter(Boolean);
}

// A solid-colour RGB PNG of the given size.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Width and height from a JPEG's first SOF marker.
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}
const pngSize = (buf) => (buf.readUInt32BE(0) === 0x89504e47 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

const json = (c) => { try { return JSON.parse(c.text); } catch { return null; } };
// Cell values compared as displayed text: numbers come back as strings.
const cells = (v) => JSON.stringify(v).replace(/["\s]/g, '').toLowerCase();
const has = (text, words) => words.every((w) => text.toLowerCase().includes(String(w).toLowerCase()));
const UNTRANSLATED = /^[A-Za-z0-9_]+(Name|Key|Desc|Description)$/;

function verify(t, calls) {
  const at = (i) => calls[i] ?? { status: 'MISSING', text: '' };
  const want = (i, label, test) => {
    const c = at(i);
    if (c.status !== 'OK') return `${label}: ${c.status} ${c.text.replace(/\s+/g, ' ').slice(0, 80)}`;
    const why = test(c, json(c));
    return why ? `${label}: ${why}` : null;
  };
  const listLength = (j) => {
    if (Array.isArray(j)) return j.length;
    if (j && typeof j === 'object') for (const v of Object.values(j)) if (Array.isArray(v)) return v.length;
    return 0;
  };
  const csvText = () => {
    const p = join(t, 'table.csv');
    if (!existsSync(p)) return null;
    if (statSync(p).isDirectory()) return readdirSync(p).map((f) => readFileSync(join(p, f), 'utf8')).join('\n');
    return readFileSync(p, 'utf8');
  };
  const checks = [
    want(0, 'creator_studio_status', (c, j) => {
      const p = j?.permissions;
      if (!p || p.error) return `no permissions: ${p?.error ?? 'missing'}`;
      if (typeof p.accessibility !== 'boolean' || typeof p.screenRecording !== 'boolean' || !Array.isArray(p.problems)) return 'permissions incomplete';
      return Object.keys(p.automation ?? {}).includes('System Events') ? null : 'no System Events automation entry';
    }),
    want(1, 'keynote_list_themes', (c, j) => (listLength(j) > 0 ? null : 'empty')),
    want(2, 'pages_list_templates', (c, j) => (listLength(j) > 0 ? null : 'empty')),
    want(3, 'numbers_create_spreadsheet', () => (existsSync(join(t, 'table.numbers')) ? null : 'no table.numbers')),
    want(4, 'numbers_read_table', (c, j) => (cells(j?.rows) === cells(ROWS) ? null : `rows differ: ${JSON.stringify(j?.rows).slice(0, 80)}`)),
    want(5, 'iwork_export csv', () => {
      const s = csvText();
      if (s == null) return 'no table.csv';
      return /alpha,1/.test(s) && /beta,2/.test(s) ? null : `csv lacks rows: ${s.slice(0, 60)}`;
    }),
    want(6, 'numbers_write_cells', () => (existsSync(join(t, 'table2.numbers')) ? null : 'no table2.numbers')),
    want(7, 'numbers_write_cells read-back', (c, j) => (cells(j?.rows) === cells([...ROWS.slice(0, 2), ['beta', 7]]) ? null : `B3 is not 7: ${JSON.stringify(j?.rows).slice(0, 80)}`)),
    want(8, 'keynote_create_presentation', () => (existsSync(join(t, 'deck.key')) ? null : 'no deck.key')),
    want(9, 'keynote_read_presentation', (c) => (has(c.text, ['Smoke title', 'Smoke body', 'Smoke notes']) ? null : `slide text missing: ${c.text.slice(0, 80)}`)),
    want(10, 'pages_create_document', () => (existsSync(join(t, 'doc.pages')) ? null : 'no doc.pages')),
    want(11, 'pages_read_document', (c) => (has(c.text, ['Smoke body text']) ? null : `body missing: ${c.text.slice(0, 80)}`)),
    want(12, 'pixelmator_image_info', (c) => (/\b64\b/.test(c.text) && /\b48\b/.test(c.text) ? null : `size not 64x48: ${c.text.slice(0, 80)}`)),
    want(13, 'pixelmator_process_image', () => {
      const d = join(t, 'out');
      const files = existsSync(d) ? readdirSync(d) : [];
      if (files.join() !== 'x.jpeg') return `wrote [${files.join(', ')}], want [x.jpeg]`;
      const s = jpegSize(readFileSync(join(d, 'x.jpeg')));
      if (!s) return 'x.jpeg is not a JPEG';
      return s.width === 32 && s.height === 24 ? null : `x.jpeg is ${s.width}x${s.height}, want 32x24`;
    }),
    want(14, 'pixelmator_batch_process', () => {
      const d = join(t, 'batch');
      const files = existsSync(d) ? readdirSync(d) : [];
      if (files.length !== 1) return `wrote [${files.join(', ')}], want one file`;
      const s = pngSize(readFileSync(join(d, files[0])));
      return s && s.width === 16 && s.height === 12 ? null : `${files[0]} is not a 16x12 PNG`;
    }),
    want(15, 'compressor_list_settings', (c, j) => {
      const list = j?.settings ?? [];
      if (!list.length) return 'empty';
      const bad = list.filter((s) => UNTRANSLATED.test(String(s.name ?? '')) || UNTRANSLATED.test(String(s.description ?? '')));
      return bad.length ? `${bad.length} of ${list.length} untranslated, e.g. ${bad[0].name}` : null;
    }),
    want(16, 'app_shortcut_actions', (c, j) => (j && typeof j.count === 'number' ? null : 'no count')),
    want(17, 'shortcuts_list', (c, j) => (j && Array.isArray(j.shortcuts) ? null : 'no shortcuts list')),
  ];
  return checks.filter(Boolean);
}

async function main() {
  const sep = process.argv.indexOf('--');
  const t = process.argv[2];
  if (!t || sep !== 3 || sep === process.argv.length - 1) {
    console.log('usage: node scripts/smoke.mjs <empty temp folder> -- <server command> [args...]');
    process.exit(2);
  }
  if (readdirSync(t).some((f) => !['cache', 'home'].includes(f))) {
    console.log(`${t} is not empty`);
    process.exit(2);
  }
  writeFileSync(join(t, 'in.png'), png(64, 48));
  const full = process.env.CSMCP_SMOKE_FULL === '1';
  let specs = [];
  if (full) {
    const prep = prepareFull(t);
    if (typeof prep === 'string') { console.log(`full run not started: ${prep}`.slice(0, 110)); process.exit(1); }
    specs = fullPlan(t, prep);
  }
  const base = plan(t);
  const calls = [...base, ...specs];
  writeFileSync(join(t, 'calls.json'), JSON.stringify(calls.map(({ name, args, timeout }) => ({ name, args, timeout }))));
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'mcp_probe.mjs');
  const r = spawnSync(process.execPath, [probe, join(t, 'calls.json'), '--', ...process.argv.slice(sep + 1)], { encoding: 'utf8', cwd: t, maxBuffer: 64 << 20 });
  let report;
  try { report = JSON.parse(r.stdout); } catch { console.log(`probe output unreadable: ${(r.stdout + r.stderr).slice(0, 100)}`); process.exit(1); }
  for (const c of report.calls) console.log(`${c.status} ${c.name}: ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (!report.ok) { console.log(`no handshake: ${report.error}`); process.exit(1); }
  if (report.error) console.log(`probe: ${report.error}`);
  const problems = [...verify(t, report.calls.slice(0, base.length)), ...verifyFull(t, report.calls.slice(base.length), specs)];
  if (full) {
    const left = closeTempLibraries(['SmokeA', 'SmokeB']);
    if (left) problems.push(left);
    const render = renderTimeline(t);
    if (render) problems.push(render);
  }
  for (const p of problems) console.log(`BAD ${p}`);
  if (problems.length) { console.log(`${problems.length} problem(s): ${problems[0]}`.slice(0, 110)); process.exit(1); }
  const tools = new Set(calls.map((c) => c.name)).size;
  console.log(full
    ? `${calls.length} calls to ${tools} tools (full) and a headless render, results checked from files`
    : `${calls.length} calls to ${tools} tools, results checked from files; CSMCP_SMOKE_FULL=1 adds ${FULL_TOOLS.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
