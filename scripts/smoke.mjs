#!/usr/bin/env node
// Real-app smoke run for check 21, and the tool coverage map for check 24.
//
//   node scripts/smoke.mjs <empty temp folder> -- <server command> [args...]
//
// Drives the server over stdio (through scripts/mcp_probe.mjs) and checks each result from files
// it writes inside the temp folder. Apps stay hidden: no call passes front: true, and no call
// touches a document outside the temp folder. The last line of output is a one-line summary.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

// How each tool is verified. "check 21" means this script calls it; "unit test" names a test in test/.
export const COVERAGE = [
  { tool: 'creator_studio_status', how: 'check 21' },
  { tool: 'pixelmator_process_image', how: 'check 21' },
  { tool: 'pixelmator_batch_process', how: 'check 21' },
  { tool: 'pixelmator_image_info', how: 'check 21' },
  { tool: 'pixelmator_replace_text', how: 'unit test', detail: 'every generated AppleScript is balanced and never contains user text' },
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
  { tool: 'compressor_transcode', how: 'unit test', detail: 'Compressor args and setting matching' },
  { tool: 'finalcut_list_libraries', how: 'not exercised', detail: "launching Final Cut Pro reopens the user's own libraries" },
  { tool: 'finalcut_build_timeline', how: 'unit test', detail: 'FCPXML timeline: offsets, trims, markers, escaping' },
  { tool: 'finalcut_import_fcpxml', how: 'unit test', detail: 'FCPXML: injecting import options replaces old ones, first in <fcpxml>' },
  { tool: 'app_open', how: 'not exercised', detail: 'opens a file in an app; the app tools above launch apps through the same code' },
  { tool: 'ui_list_menus', how: 'not exercised', detail: 'needs Accessibility for the app that runs the server' },
  { tool: 'ui_click_menu', how: 'not exercised', detail: "needs Accessibility and acts on the app's UI" },
  { tool: 'ui_snapshot', how: 'not exercised', detail: 'needs Accessibility for the app that runs the server' },
  { tool: 'ui_find', how: 'not exercised', detail: 'needs Accessibility for the app that runs the server' },
  { tool: 'ui_click', how: 'not exercised', detail: 'needs Accessibility and can act on the frontmost app' },
  { tool: 'ui_set_value', how: 'not exercised', detail: 'needs Accessibility and can act on the frontmost app' },
  { tool: 'ui_press_key', how: 'not exercised', detail: 'needs Accessibility and can act on the frontmost app' },
  { tool: 'ui_type_text', how: 'not exercised', detail: 'needs Accessibility and can act on the frontmost app' },
  { tool: 'ui_wait_for', how: 'not exercised', detail: 'needs Accessibility and a long-running job to wait for' },
  { tool: 'ui_batch', how: 'unit test', detail: 'runBatch runs in order and leaves a finished status file' },
  { tool: 'ui_screenshot', how: 'not exercised', detail: 'needs Screen Recording for the app that runs the server' },
  { tool: 'app_shortcut_actions', how: 'check 21' },
  { tool: 'shortcuts_list', how: 'check 21' },
  { tool: 'shortcuts_run', how: 'not exercised', detail: "runs one of the user's shortcuts, which can do anything" },
  { tool: 'blender_run_python', how: 'not exercised', detail: 'needs Blender, an optional dependency, and runs arbitrary Python' },
  { tool: 'rive_cli', how: 'unit test', detail: 'Rive: only the bare project form opens a window' },
  { tool: 'godot_cli', how: 'unit test', detail: 'Godot: always headless, project and script placed, window flags refused' },
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
    want(0, 'creator_studio_status', () => null),
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
  const calls = plan(t);
  writeFileSync(join(t, 'calls.json'), JSON.stringify(calls));
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'mcp_probe.mjs');
  const r = spawnSync(process.execPath, [probe, join(t, 'calls.json'), '--', ...process.argv.slice(sep + 1)], { encoding: 'utf8', cwd: t, maxBuffer: 64 << 20 });
  let report;
  try { report = JSON.parse(r.stdout); } catch { console.log(`probe output unreadable: ${(r.stdout + r.stderr).slice(0, 100)}`); process.exit(1); }
  for (const c of report.calls) console.log(`${c.status} ${c.name}: ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (!report.ok) { console.log(`no handshake: ${report.error}`); process.exit(1); }
  if (report.error) console.log(`probe: ${report.error}`);
  const problems = verify(t, report.calls);
  for (const p of problems) console.log(`BAD ${p}`);
  if (problems.length) { console.log(`${problems.length} problem(s): ${problems[0]}`.slice(0, 110)); process.exit(1); }
  console.log(`${calls.length} calls to ${SMOKE_TOOLS.length} tools, results checked from files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
