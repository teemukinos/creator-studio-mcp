#!/usr/bin/env python3
"""Whole-host check of a Craft gateway: run it after every deploy and every Craft app update.

Usage:
  host_check.py BASE_URL --token-file F
  BASE_URL: http://127.0.0.1:8080, or the remote host's service URL

Checks, each PASS or FAIL:
  1. /health answers from the gateway itself (not the platform), without a token.
  2. tests/auth_check.sh: a wrong token gets 401 on every route.
  3. /status: all five CLIs answer; the apps' and the gateway's environments hold only
     allowlisted variable names (no secrets a host injects); a process running as an
     app (same user and environment) finds no secret names in any readable /proc/<pid>/environ.
  4. Real work with a large input (a 6000x4000 JPEG made here with ffmpeg): PhotoCraft opens and
     exports it, VectorCraft places it into a PDF, EffectCraft renders it into a 1 s H.264;
     DesignCraft exports its sample PDF; FilmCraft exports 2 s of its demo. Every output must
     exist on the host with a non-zero size. This is what caught PhotoCraft's "0.0 GB is free"
     on a host with no cgroup filesystem; the per-app cgroup view (image/cgroup-view) must keep it passing.
Uses /work/host-check/ on the host and deletes it at the end.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mcp_http_check import post  # noqa: E402

ALLOWED_ENV = {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR",
               "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "FONTCONFIG_PATH", "PHOTOCRAFT_RAM_MB",
               "PHOTOCRAFT_TILE_BUDGET_MB", "PHOTOCRAFT_PHOTOMERGE_BUDGET_MB"}
JOB = "host-check"
RESULTS = []


def report(ok, what, detail=""):
    RESULTS.append(bool(ok))
    print("PASS" if ok else "FAIL", what, detail, flush=True)


def http(base, token, method, path, data=None, timeout=120):
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        body = resp.read()
        return resp.status, (json.loads(body) if body[:1] in (b"{", b"[") else body)


def mcp(base, token, app, calls, demo=False):
    """One session: initialize, the calls in order, delete. Returns (ok, last text, seconds)."""
    url = f"{base}/mcp/{app}" + ("?demo=1" if demo else "")
    t0 = time.time()
    init, sid, _ = post(url, token, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "studio-craft-host-check", "version": "0.1"}}})
    if not (init and "result" in init and sid):
        return False, f"initialize failed: {init}", time.time() - t0
    post(url, token, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    ok, text = True, ""
    try:
        for i, (tool, args) in enumerate(calls, start=2):
            res, _, _ = post(url, token, {"jsonrpc": "2.0", "id": i, "method": "tools/call",
                                          "params": {"name": tool, "arguments": args}}, sid)
            r = (res or {}).get("result", {})
            text = " ".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
            failed_steps = '"failed": 0' not in text and '"failed":0' not in text and '"failed"' in text
            if not res or "result" not in res or r.get("isError") or failed_steps:
                return False, f"{tool}: {(text or json.dumps(res))[:300]}", time.time() - t0
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(url, method="DELETE", headers={
                "Authorization": f"Bearer {token}", "Mcp-Session-Id": sid}), timeout=60)
        except Exception:  # noqa: BLE001
            pass
    return ok, text, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--token-file", required=True)
    a = ap.parse_args()
    base = a.base.rstrip("/")
    token = open(os.path.expanduser(a.token_file)).read().strip()

    # 1. /health from the gateway. A suspended public service wakes on the first request and
    # answers 503 "is starting" meanwhile; the same happens just after a rollout. Wait up to 2 min.
    t0, body, last = time.time(), None, None
    while time.time() - t0 < 120:
        try:
            code, body = http(base, None, "GET", "/health", timeout=30)
            if code == 200:
                break
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(5)
    report(isinstance(body, dict) and body.get("service") == "craft-mcp-gateway",
           "/health from the gateway", f"{body or last} after {time.time() - t0:.0f}s")

    # 2. auth on every route
    out = subprocess.run(["bash", os.path.join(HERE, "auth_check.sh"), base], capture_output=True, text=True)
    fails = [line for line in out.stdout.splitlines() if line.startswith("FAIL")]
    report(out.returncode == 0, "auth_check.sh", f"{out.stdout.count('PASS')} checks" + (f"; {fails}" if fails else ""))

    # 3. status: versions, environments, start-up facts
    _, st = http(base, token, "GET", "/status")
    vers = st.get("versions", {})
    report(len(vers) == 5 and all("error" not in v and v for v in vers.values()), "five CLIs answer", vers)
    env = st.get("env", {})
    for who in ("gateway", "photocraft", "otherApps"):
        names = set(env.get(who, ["(missing)"]))
        extra = sorted(names - ALLOWED_ENV)
        report(not extra and names, f"environment of {who} holds only allowlisted names", extra or sorted(names))
    startup = st.get("startup", {})
    report(startup.get("uid") == 10001, "gateway runs as the craft user (uid 10001)", startup.get("uid"))
    cg = str(startup.get("cgroup"))
    report(cg == "present" or cg.startswith("own read-only view per app"), "memory cgroup readable by the apps", cg)
    leaks = st.get("secretsReadableByApps", ["(not reported)"])
    report(leaks == [], "no /proc/<pid>/environ readable by an app holds a secret name", leaks)
    print("     startup", json.dumps(st.get("startup")), "cgroupView", st.get("cgroupView"),
          "memory", json.dumps({k: v for k, v in st.get("memory", {}).items() if k.endswith("MB")}))

    # 4. real work with a large input
    with tempfile.TemporaryDirectory() as tmp:
        big = os.path.join(tmp, "big.jpg")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "mandelbrot=s=6000x4000",
                        "-frames:v", "1", "-q:v", "3", big], check=True)
        http(base, token, "PUT", f"/files/{JOB}/out/")
        http(base, token, "PUT", f"/files/{JOB}/big.jpg", open(big, "rb").read(), timeout=600)
    src, out_dir = f"/work/{JOB}/big.jpg", f"/work/{JOB}/out"
    jobs = [
        ("photocraft", "PhotoCraft opens and exports a 6000x4000 JPEG", False, [
            ("doc_open", {"path": src}),
            ("doc_export", {"path": f"{out_dir}/photo.jpg", "quality": 85}),
            ("doc_close", {})], "photo.jpg"),
        ("vectorcraft", "VectorCraft places it into a PDF", False, [
            ("command_batch", {"steps": [
                {"id": "file.new", "params": {"width": 842, "height": 595, "units": "Points", "colorMode": "rgb"}},
                {"id": "file.place", "params": {"path": src, "rect": [0, 0, 842, 595], "link": False}},
                {"id": "document.export", "params": {"path": f"{out_dir}/vector.pdf"}}]})], "vector.pdf"),
        ("effectcraft", "EffectCraft renders it into 1 s of H.264", False, [
            ("command_batch", {"steps": [
                {"id": "file.import", "params": {"paths": [src]}},
                {"id": "comp.new", "params": {"name": "hc", "width": 1920, "height": 1080, "frameRate": 30,
                                              "duration": 1, "open": True}},
                {"id": "layer.addItem", "params": {"item": "big.jpg"}},
                {"id": "renderQueue.add", "params": {"comp": "hc", "format": "h264", "output": f"{out_dir}/effect.mp4"}},
                {"id": "renderQueue.render", "params": {"wait": True}}]})], "effect.mp4"),
        ("designcraft", "DesignCraft exports its sample as PDF", True, [
            ("execute", {"command": "file.exportPdf", "params": {"path": f"{out_dir}/design.pdf"}})], "design.pdf"),
        ("filmcraft", "FilmCraft exports 2 s of its demo", True, [
            ("command_run", {"id": "file.exportMedia", "params": {
                "path": f"{out_dir}/film.mp4", "range": "custom", "startSeconds": 0, "endSeconds": 2,
                "wait": True}})], "film.mp4"),
    ]
    for app, what, demo, calls, _ in jobs:
        try:
            ok, text, secs = mcp(base, token, app, calls, demo)
            report(ok, what, f"{secs:.1f}s" + ("" if ok else f": {text}"))
        except Exception as e:  # noqa: BLE001
            report(False, what, e)
    _, listing = http(base, token, "GET", f"/files/{JOB}/out")
    sizes = {os.path.basename(f["path"]): f["bytes"] for f in listing.get("files", [])}
    missing = [name for *_, name in jobs if not sizes.get(name)]
    report(not missing, "every output exists with a non-zero size", missing or sizes)
    http(base, token, "DELETE", f"/files/{JOB}")

    print(json.dumps({"ok": all(RESULTS), "passed": sum(RESULTS), "failed": len(RESULTS) - sum(RESULTS)}))
    sys.exit(0 if all(RESULTS) else 1)


if __name__ == "__main__":
    main()
