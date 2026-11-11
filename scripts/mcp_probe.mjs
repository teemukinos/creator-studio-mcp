#!/usr/bin/env node
// A minimal MCP stdio client for the release checks.
//
//   node scripts/mcp_probe.mjs <calls.json | -> -- <server command> [args...]
//
// Speaks newline-delimited JSON-RPC: initialize, tools/list, then each call in calls.json
// ([{"name": "...", "args": {...}, "timeout": ms}]). Prints one JSON object to stdout:
// { ok, server, tools: [names], calls: [{ name, status: OK|TOOL-ERROR|RPC-ERROR, text, images? }], error, stderr }.
// images lists image results as { mimeType, data } with base64 data.
// The server inherits this process's environment. Exits 0 when the handshake worked, whatever the calls returned.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sep = process.argv.indexOf('--');
if (sep < 0 || sep === process.argv.length - 1) {
  console.error('usage: node scripts/mcp_probe.mjs <calls.json|-> -- <server command> [args...]');
  process.exit(2);
}
const callsArg = process.argv[2];
const calls = callsArg === '-' || callsArg === '--' ? [] : JSON.parse(readFileSync(callsArg, 'utf8'));
const [cmd, ...args] = process.argv.slice(sep + 1);
const report = { ok: false, server: null, tools: [], calls: [], error: null, stderr: '' };

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let nextId = 0;
const pending = new Map();
let finished = false;
const done = (code) => {
  if (finished) return;
  finished = true;
  report.stderr = report.stderr.slice(-2000);
  child.kill();
  // Exit only after stdout drains: a pipe write is asynchronous and exit would cut it short.
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(code));
};
child.on('error', (e) => { report.error = `spawn failed: ${e.message}`; done(1); });
child.stderr.on('data', (d) => { report.stderr += d; });
child.on('exit', (code) => {
  if (!pending.size) return;
  report.error = `server exited early with code ${code}`;
  done(1);
});
child.stdout.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { report.error = `non-JSON on stdout: ${line.slice(0, 200)}`; continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function send(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }
    }, timeoutMs).unref();
  });
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-probe', version: '1.0.0' },
  }, Number(process.env.PROBE_INIT_TIMEOUT_MS || 120000));
  report.server = init.result?.serverInfo ?? null;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await send('tools/list', {}, 30000);
  report.tools = (list.result?.tools ?? []).map((t) => t.name);
  report.ok = true;
  for (const c of calls) {
    const r = await send('tools/call', { name: c.name, arguments: c.args ?? {} }, c.timeout ?? 180000);
    const text = (r.result?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    const status = r.error ? 'RPC-ERROR' : r.result?.isError ? 'TOOL-ERROR' : 'OK';
    const images = (r.result?.content ?? []).filter((x) => x.type === 'image').map((x) => ({ mimeType: x.mimeType, data: x.data }));
    report.calls.push({ name: c.name, status, text: r.error?.message ?? text, ...(images.length ? { images } : {}) });
  }
  done(0);
} catch (e) {
  report.error = e.message;
  done(report.ok ? 0 : 1);
}
