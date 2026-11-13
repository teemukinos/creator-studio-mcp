#!/usr/bin/env python3
"""Check a Craft gateway endpoint over MCP Streamable HTTP: initialize, tools/list, one tools/call.

Usage:
  mcp_http_check.py URL [--call TOOL JSON]... [--token-file F]
URL example: http://127.0.0.1:8080/mcp/filmcraft?demo=1
Prints PASS or FAIL lines and a JSON summary; exit 0 only when every step passed.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def post(url, token, msg, sid=None, timeout=1800):
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream",
               "Authorization": f"Bearer {token}"}
    if sid:
        headers["Mcp-Session-Id"] = sid
    req = urllib.request.Request(url, json.dumps(msg).encode(), headers, method="POST")
    resp = urllib.request.urlopen(req, timeout=timeout)
    sid = resp.headers.get("Mcp-Session-Id", sid)
    if resp.status == 202:
        return None, sid, []
    notes, final = [], None
    if resp.headers.get("Content-Type", "").startswith("text/event-stream"):
        data = []
        for raw in resp:
            line = raw.decode().rstrip("\r\n")
            if line.startswith("data:"):
                data.append(line[5:].strip())
            elif line == "" and data:
                m = json.loads("\n".join(data))
                data = []
                if m.get("id") == msg.get("id") and ("result" in m or "error" in m):
                    final = m
                else:
                    notes.append(m)
    else:
        final = json.loads(resp.read())
    return final, sid, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--call", nargs=2, action="append", metavar=("TOOL", "JSON"), default=[],
                    help="a tools/call to run, in order; repeatable")
    ap.add_argument("--token-file", default=".craft-token")
    a = ap.parse_args()
    token = open(a.token_file).read().strip()
    ok = True

    # Wrong token must be refused.
    try:
        post(a.url, "wrong", {"jsonrpc": "2.0", "id": 0, "method": "ping"})
        print("FAIL auth: wrong token accepted"); ok = False
    except urllib.error.HTTPError as e:
        print("PASS" if e.code == 401 else "FAIL", "auth: wrong token ->", e.code)
        ok &= e.code == 401

    t0 = time.time()
    init, sid, _ = post(a.url, token, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "studio-craft-http-check", "version": "0.1"}}})
    good = bool(init and "result" in init and sid)
    ok &= good
    print("PASS" if good else "FAIL", "initialize", json.dumps(init["result"].get("serverInfo")) if good else init,
          "session", (sid or "")[:8])
    post(a.url, token, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)

    tl, _, _ = post(a.url, token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid)
    names = [t["name"] for t in (tl or {}).get("result", {}).get("tools", [])]
    ok &= bool(names)
    print("PASS" if names else "FAIL", "tools/list", len(names), "tools:", ", ".join(names))

    secs, prog_total, rid = 0.0, 0, 3
    for tool, args in a.call:
        t1 = time.time()
        res, _, notes = post(a.url, token, {"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {
            "name": tool, "arguments": json.loads(args), "_meta": {"progressToken": f"http-chk-{rid}"}}}, sid)
        rid += 1
        took = time.time() - t1
        secs += took
        r = (res or {}).get("result", {})
        good = bool(res and "result" in res and not r.get("isError"))
        ok &= good
        text = " ".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
        prog = [n for n in notes if n.get("method") == "notifications/progress"]
        prog_total += len(prog)
        print("PASS" if good else "FAIL", "tools/call", tool, f"{took:.1f}s", f"progress events {len(prog)}")
        print("   ", (text[:800] if text else json.dumps(res)[:800]).replace("\n", " "))

    req = urllib.request.Request(a.url, method="DELETE", headers={
        "Authorization": f"Bearer {token}", "Mcp-Session-Id": sid})
    code = urllib.request.urlopen(req).status
    print("PASS" if code == 204 else "FAIL", "session delete ->", code)
    ok &= code == 204
    print(json.dumps({"ok": ok, "tools": len(names), "call_seconds": round(secs, 1),
                      "total_seconds": round(time.time() - t0, 1), "progress_events": prog_total}))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
