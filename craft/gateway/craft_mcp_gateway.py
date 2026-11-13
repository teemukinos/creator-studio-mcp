#!/usr/bin/env python3
"""Craft MCP gateway: expose each Craft app's stdio MCP server as a Streamable HTTP endpoint.

Endpoints (all but /health need "Authorization: Bearer <CRAFT_MCP_TOKEN>"):

  POST   /mcp/<app>        MCP Streamable HTTP. An `initialize` request without a session
                           starts a new `<app>-cli mcp` process and returns Mcp-Session-Id.
  DELETE /mcp/<app>        End the session named by Mcp-Session-Id (stops its process).
  GET    /health           {"ok": true, ...}; no auth, no details. /healthz is the same (local
                           Docker); some platforms answer /healthz themselves and never forward it.
  GET    /status           CLI versions, open sessions, start-up facts, memory, and the names
                           (never values) of the environment variables the apps get.
  GET    /files/<path>     Download a file under the work root, or list a folder (JSON).
  PUT    /files/<path>     Upload a file under the work root (parents are created).
  PUT    /files/<dir>/     Create a folder (empty body). The apps do not create missing folders.
  DELETE /files/<path>     Delete a file or folder under the work root.

Each MCP session gets its own app process, so sessions never share a document. File access
of the apps is confined to the work root with their --automation-*-root flags where the app has
them (FilmCraft has none; there the container user's permissions are the only limit).

Standard library only. Environment:
  CRAFT_MCP_TOKEN          required bearer token (at least 32 characters), or
  CRAFT_MCP_TOKEN_FILE     a file that holds it

Run it as the container's PID 1 (no init wrapper): it then holds the only copy of the token
in its environment, and it marks itself non-dumpable so the app processes, which run as the
same user, cannot read /proc/1/environ. It also reaps orphaned processes, as an init would.
  PORT or CRAFT_MCP_PORT   listen port (PORT wins), default 8080
  CRAFT_MCP_HOST           listen address, default 0.0.0.0
  CRAFT_WORK_ROOT          work root, default /work
  CRAFT_MAX_SESSIONS       open MCP sessions per app, default 3
  CRAFT_IDLE_SECONDS       end a session after this long without traffic, default 1800
  CRAFT_EVICT_IDLE_SECONDS when an app is at CRAFT_MAX_SESSIONS, a new session replaces the oldest
                           session that has had no traffic for this long and runs nothing, default 120
  CRAFT_MAX_UPLOAD_BYTES   largest upload, default 4 GiB
  CRAFT_ALLOWED_ORIGINS    comma-separated browser origins to accept (default: none)
"""
import ctypes
import hmac
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit, parse_qs

STARTED = time.time()
WORK = os.path.realpath(os.environ.get("CRAFT_WORK_ROOT", "/work"))
TOKEN = os.environ.get("CRAFT_MCP_TOKEN", "")
if not TOKEN and os.environ.get("CRAFT_MCP_TOKEN_FILE"):
    with open(os.environ["CRAFT_MCP_TOKEN_FILE"]) as _f:
        TOKEN = _f.read().strip()
MAX_SESSIONS = int(os.environ.get("CRAFT_MAX_SESSIONS", "3"))
IDLE_SECONDS = int(os.environ.get("CRAFT_IDLE_SECONDS", "1800"))
EVICT_IDLE_SECONDS = int(os.environ.get("CRAFT_EVICT_IDLE_SECONDS", "120"))
MAX_UPLOAD = int(os.environ.get("CRAFT_MAX_UPLOAD_BYTES", str(4 << 30)))
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get("CRAFT_ALLOWED_ORIGINS", "").split(",") if o.strip()}
HOST = os.environ.get("CRAFT_MCP_HOST", "0.0.0.0")
# A platform's PORT wins over our own default.
PORT = int(os.environ.get("PORT") or os.environ.get("CRAFT_MCP_PORT") or "8080")
STARTUP = {"portFromEnv": os.environ.get("PORT"), "port": PORT, "tokenSet": len(TOKEN) >= 32}
KEEPALIVE_SECONDS = 15
PREFIX_RE = re.compile(r"^/compute/v1/[A-Za-z0-9_-]+(?=/|\?|$)")

ROOTS = ["--automation-read-root", WORK, "--automation-write-root", WORK]
# app -> (stdio MCP command, extra args for ?demo=1)
APPS = {
    "photocraft": (["photocraft-cli", "mcp", "--no-gpu", *ROOTS], None),
    "vectorcraft": (["vectorcraft-cli", "mcp", *ROOTS], None),
    "effectcraft": (["effectcraft-cli", "mcp", *ROOTS], ["--demo"]),
    "designcraft": (["designcraft-cli", "mcp", *ROOTS], ["--sample"]),
    "filmcraft": (["filmcraft-cli", "mcp"], ["--demo"]),
}


def log(*parts):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *parts, file=sys.stderr, flush=True)


CHILD_ENV_KEYS = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR",
                  "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "FONTCONFIG_PATH",
                  "PHOTOCRAFT_RAM_MB", "PHOTOCRAFT_TILE_BUDGET_MB", "PHOTOCRAFT_PHOTOMERGE_BUDGET_MB")


def child_env():
    # Allowlist, not blocklist: a hosting platform may inject its project secrets
    # (keys, database URLs) into this process, and the apps must see none of them.
    # This also keeps CRAFT_* and any desktop-app *_CONTROL_PORT/_TOKEN bridge variables out.
    return {k: os.environ[k] for k in CHILD_ENV_KEYS if k in os.environ}


def scrub_own_environment():
    """Drop everything but the allowlist from this process's environment once the settings are
    read, so no later subprocess call can inherit a host secret by mistake. The kernel's copy
    (/proc/1/environ) stays, which is why the process is also non-dumpable."""
    dropped = [k for k in os.environ if k not in CHILD_ENV_KEYS]
    for k in dropped:
        del os.environ[k]
    return len(dropped)


LEAK_PROBE = r"""
import os
found = []
for pid in os.listdir("/proc"):
    if not pid.isdigit() or int(pid) == os.getpid():
        continue
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            names = [kv.split(b"=", 1)[0].decode("latin-1") for kv in f.read().split(b"\0") if kv]
    except OSError:
        continue
    hit = [n for n in names if n.startswith(("SUPABASE_", "CRAFT_MCP_TOKEN", "AI_GATEWAY"))
           or "SECRET" in n or n.endswith("_KEY")]
    if hit:
        found.append(f"{pid}: {', '.join(sorted(hit))}")
print("\n".join(found))
"""


def secrets_readable_by_apps():
    """Run, as an app would (same user, same environment), a scan of every /proc/<pid>/environ
    for secret variable names. [] means no app process can read a host secret this way."""
    try:
        out = subprocess.run(app_command([sys.executable, "-I", "-c", LEAK_PROBE]), capture_output=True,
                             text=True, timeout=20, env=child_env(), cwd=WORK)
        return [line for line in out.stdout.splitlines() if line] or []
    except Exception as e:  # noqa: BLE001
        return [f"probe error: {e}"]


def env_names(env):
    """Names (never values) of the environment a process really gets, read back from `env -0`."""
    try:
        out = subprocess.run(app_command(["env", "-0"]), capture_output=True, timeout=10, env=env, cwd=WORK).stdout
        return sorted(kv.split(b"=", 1)[0].decode() for kv in out.split(b"\0") if kv)
    except Exception as e:  # noqa: BLE001
        return [f"error: {e}"]


CGROUP_VIEW = "/opt/gateway/cgroup-view"
USE_CGROUP_VIEW = False  # set in main(): True on hosts that mount no cgroup filesystem


def cgroup_fs_mounted():
    try:
        with open("/proc/self/mountinfo") as f:
            return any(" - cgroup" in line for line in f)
    except OSError:
        return True  # unknown: leave the app's own limit detection alone


def app_env(app):
    return child_env()


def app_command(cmd):
    """The command line that starts an app process. On a host without a cgroup filesystem
    the app runs through image/cgroup-view, in its own user, mount and cgroup
    namespaces with a read-only cgroup2 mount, so it can read its real memory limit."""
    if not USE_CGROUP_VIEW:
        return list(cmd)
    return ["unshare", "--user", f"--map-user={os.getuid()}", f"--map-group={os.getgid()}",
            "--mount", "--cgroup", "--keep-caps", "--", "/bin/sh", CGROUP_VIEW, *cmd]
    # Through /bin/sh rather than executing the script: some hosts refuse to execute a
    # script under /opt inside the new user namespace ("Permission denied"), but runs /bin/sh.


def cgroup_view_check():
    """Run a throwaway process through the wrapper: does it see a cgroup2 mount and a readable
    memory.max, as the same user, with no capabilities left? Returns (ok, detail)."""
    probe = ("import os; m=open('/proc/self/mountinfo').read(); "
             "caps=[l.split()[1] for l in open('/proc/self/status') if l.startswith('CapEff')][0]; "
             "print(' - cgroup2 ' in m, open('/sys/fs/cgroup/memory.max').read().strip(), os.getuid(), caps)")
    try:
        out = subprocess.run(app_command([sys.executable, "-I", "-c", probe]), capture_output=True,
                             text=True, timeout=15, env=child_env(), cwd=WORK)
        fields = out.stdout.split()
        ok = (len(fields) == 4 and fields[0] == "True" and fields[2] == str(os.getuid())
              and int(fields[3], 16) == 0)
        return ok, (out.stdout.strip() or out.stderr.strip() or f"exit {out.returncode}")[:200]
    except Exception as e:  # noqa: BLE001
        return False, f"error: {e}"


class Session:
    def __init__(self, app, extra):
        self.app = app
        self.id = uuid.uuid4().hex
        base = APPS[app][0]
        cmd = app_command([base[0], "mcp", *(extra or []), *base[2:]])
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=WORK, env=app_env(app))
        self.lock = threading.Lock()
        self.pending = {}   # request id (json) -> queue
        self.tokens = {}    # progress token (json) -> request id (json)
        self.streams = set()  # queues of open SSE responses, for unrouted messages
        self.last = time.time()
        self.alive = True
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        log(f"session {self.id[:8]} {app} started pid {self.proc.pid}: {' '.join(cmd)}")

    def _read_stderr(self):
        for line in self.proc.stderr:
            log(f"[{self.app} {self.id[:8]}]", line.decode(errors="replace").rstrip())

    def _route(self, msg):
        key = None
        if "id" in msg and ("result" in msg or "error" in msg):
            key = json.dumps(msg["id"])
        elif msg.get("method") == "notifications/progress":
            tok = json.dumps((msg.get("params") or {}).get("progressToken"))
            key = self.tokens.get(tok)
        with self.lock:
            q = self.pending.get(key) if key else None
            targets = [q] if q else list(self.streams)
        for t in targets:
            t.put(msg)

    def _read_stdout(self):
        for raw in self.proc.stdout:
            self.last = time.time()
            try:
                msg = json.loads(raw)
            except ValueError:
                log(f"[{self.app} {self.id[:8]}] non-JSON stdout:", raw[:200])
                continue
            self._route(msg)
        self.alive = False
        with self.lock:
            waiting = list(self.pending.items())
        for key, q in waiting:
            q.put({"jsonrpc": "2.0", "id": json.loads(key),
                   "error": {"code": -32000, "message": f"{self.app} MCP process exited"}})
        log(f"session {self.id[:8]} {self.app} process exited ({self.proc.wait()})")

    def send(self, msg):
        data = (json.dumps(msg) + "\n").encode()
        with self.lock:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
        self.last = time.time()

    def register(self, msg):
        q = queue.Queue()
        key = json.dumps(msg["id"])
        tok = ((msg.get("params") or {}).get("_meta") or {}).get("progressToken")
        with self.lock:
            self.pending[key] = q
            if tok is not None:
                self.tokens[json.dumps(tok)] = key
        return key, q

    def unregister(self, key):
        with self.lock:
            self.pending.pop(key, None)
            for t, k in list(self.tokens.items()):
                if k == key:
                    del self.tokens[t]

    def busy(self):
        with self.lock:
            return bool(self.pending)

    def close(self):
        self.alive = False
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        log(f"session {self.id[:8]} {self.app} closed")


SESSIONS = {}  # session id -> Session
SESSIONS_LOCK = threading.Lock()


def reaper():
    while True:
        time.sleep(30)
        now = time.time()
        with SESSIONS_LOCK:
            stale = [s for s in SESSIONS.values()
                     if not s.alive or (now - s.last > IDLE_SECONDS and not s.busy())]
            for s in stale:
                SESSIONS.pop(s.id, None)
        for s in stale:
            log(f"session {s.id[:8]} {s.app} ended (idle or exited)")
            s.close()
        reap_orphans()


def reap_orphans():
    """As PID 1, collect exited processes that are not ours to wait for (orphaned grandchildren)."""
    with SESSIONS_LOCK:
        ours = {s.proc.pid for s in SESSIONS.values()}
    while True:
        try:
            info = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return
        if info is None or info.si_pid in ours:
            return  # nothing exited, or a session process that its Popen will wait for
        os.waitpid(info.si_pid, os.WNOHANG)


def versions():
    out = {}
    for app, (cmd, _) in APPS.items():
        try:
            out[app] = subprocess.run([cmd[0], "--version"], capture_output=True, text=True,
                                      timeout=20, env=child_env()).stdout.strip()
        except Exception as e:  # noqa: BLE001
            out[app] = f"error: {e}"
    return out


def memory():
    """What the host reports: /proc/meminfo and the cgroup limit (PhotoCraft sizes its opens from these)."""
    out = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                if k in ("MemTotal", "MemFree", "MemAvailable", "SwapFree"):
                    out[k + "MB"] = int(v.split()[0]) // 1024
    except OSError as e:
        out["meminfo"] = str(e)
    def read(p, n=600):
        try:
            with open(p) as f:
                return f.read(n).strip()
        except OSError as e:
            return f"({e.strerror})"
    out["/proc/self/cgroup"] = read("/proc/self/cgroup")
    mounts = [line.split() for line in read("/proc/self/mountinfo", 1 << 16).splitlines()]
    out["cgroup mounts"] = [f"{m[3]} on {m[4]} ({m[m.index('-') + 1]})" for m in mounts
                            if "-" in m and m[m.index("-") + 1].startswith("cgroup")]
    for d in sorted({m[4] for m in mounts if "-" in m and m[m.index("-") + 1].startswith("cgroup")}):
        for name in ("memory.max", "memory.current", "memory.limit_in_bytes", "memory.usage_in_bytes"):
            if os.path.exists(os.path.join(d, name)):
                out[os.path.join(d, name)] = read(os.path.join(d, name))
    return out


def safe_path(rel):
    p = os.path.realpath(os.path.join(WORK, unquote(rel).lstrip("/")))
    if p != WORK and not p.startswith(WORK + os.sep):
        return None
    return p


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "craft-mcp-gateway/0.1"

    def log_message(self, fmt, *args):
        log(self.address_string(), fmt % args)

    def parse_request(self):
        self._consumed = False
        ok = super().parse_request()
        if ok:  # a platform may forward its /compute/v1/<service> prefix: drop it
            self.path = PREFIX_RE.sub("", self.path, count=1) or "/"
            if not self.path.startswith("/"):
                self.path = "/" + self.path
        return ok

    # ---- helpers
    def _end_headers(self, headers):
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        # A reply sent before the request body was read (refused, too large…) must close the
        # connection, or the unread body would be parsed as the next request.
        if not self._consumed and (int(self.headers.get("Content-Length") or 0) > 0
                                   or self.headers.get("Transfer-Encoding")):
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()

    def _json(self, code, obj, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._end_headers(headers)
        self.wfile.write(body)

    def _empty(self, code, headers=None):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self._end_headers(headers)

    def _authed(self):
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self._json(403, {"error": "origin not allowed"})
            return False
        if len(TOKEN) < 32:  # fail closed, but stay up so the host's logs and probes show why
            self._json(503, {"error": "gateway token not configured (CRAFT_MCP_TOKEN, 32+ characters)"})
            return False
        got = self.headers.get("Authorization", "")
        if not hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode()):
            self._json(401, {"error": "missing or wrong bearer token"},
                       {"WWW-Authenticate": 'Bearer realm="craft"'})
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n) if n else b""
        self._consumed = True
        return data

    def _chunk(self, data):
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    # ---- routing
    def do_GET(self):
        path = urlsplit(self.path).path
        # /health is the open route to use. /healthz stays for local Docker, but some
        # platforms answer /healthz themselves (404) and never pass it to the container.
        if path in ("/health", "/healthz"):
            return self._json(200, {"ok": True, "service": "craft-mcp-gateway"})
        if not self._authed():
            return
        if path == "/status":
            with SESSIONS_LOCK:
                open_ = [{"app": s.app, "session": s.id[:8], "idle": round(time.time() - s.last)}
                         for s in SESSIONS.values()]
            return self._json(200, {
                "versions": VERSIONS, "workRoot": WORK, "sessions": open_,
                "startup": STARTUP, "memory": memory(), "cgroupView": USE_CGROUP_VIEW, "pid": os.getpid(),
                "secretsReadableByApps": secrets_readable_by_apps(),
                # Variable names only: proof of what the apps and the gateway really hold.
                "env": {"gateway": sorted(os.environ), "photocraft": env_names(app_env("photocraft")),
                        "otherApps": env_names(app_env("filmcraft"))}})
        if path.startswith("/files/") or path == "/files":
            return self._files_get(path[len("/files"):])
        if path.startswith("/mcp/"):
            return self._empty(405, {"Allow": "POST, DELETE"})
        self._json(404, {"error": "not found"})

    def do_PUT(self):
        path = urlsplit(self.path).path
        if not self._authed():
            return
        if not path.startswith("/files/"):
            return self._json(404, {"error": "not found"})
        p = safe_path(path[len("/files/"):])
        n = int(self.headers.get("Content-Length") or -1)
        if not p or p == WORK:
            return self._json(400, {"error": "path outside the work root"})
        if path.endswith("/"):  # PUT /files/<dir>/ with an empty body creates the folder
            if n > 0:
                return self._json(400, {"error": "a folder PUT takes no body"})
            os.makedirs(p, exist_ok=True)
            return self._json(201, {"path": os.path.relpath(p, WORK) + "/"})
        if n < 0 or n > MAX_UPLOAD:
            return self._json(411 if n < 0 else 413, {"error": "Content-Length missing or too large"})
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".part"
        with open(tmp, "wb") as f:
            left = n
            while left:
                buf = self.rfile.read(min(left, 1 << 20))
                if not buf:
                    break
                f.write(buf)
                left -= len(buf)
        self._consumed = not left
        if left:
            os.unlink(tmp)
            return self._json(400, {"error": "upload ended early"})
        os.replace(tmp, p)
        self._json(201, {"path": os.path.relpath(p, WORK), "bytes": n})

    def do_DELETE(self):
        path = urlsplit(self.path).path
        if not self._authed():
            return
        if path.startswith("/files/"):
            p = safe_path(path[len("/files/"):])
            if not p or p == WORK:
                return self._json(400, {"error": "path outside the work root"})
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            elif os.path.lexists(p):
                os.unlink(p)
            else:
                return self._json(404, {"error": "no such file"})
            return self._empty(204)
        if path.startswith("/mcp/"):
            sid = self.headers.get("Mcp-Session-Id", "")
            with SESSIONS_LOCK:
                s = SESSIONS.pop(sid, None)
            if not s:
                return self._json(404, {"error": "unknown session"})
            s.close()
            return self._empty(204)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlsplit(self.path)
        if not url.path.startswith("/mcp/"):
            return self._json(404, {"error": "not found"}) if self._authed() else None
        if not self._authed():
            return
        app = url.path[len("/mcp/"):].strip("/")
        if app not in APPS:
            return self._json(404, {"error": f"unknown app {app!r}", "apps": sorted(APPS)})
        try:
            msg = json.loads(self._body() or b"null")
        except ValueError:
            return self._json(400, {"jsonrpc": "2.0", "id": None,
                                    "error": {"code": -32700, "message": "parse error"}})
        if not isinstance(msg, dict):
            return self._json(400, {"jsonrpc": "2.0", "id": None,
                                    "error": {"code": -32600, "message": "send one JSON-RPC message per request"}})

        sid = self.headers.get("Mcp-Session-Id")
        if msg.get("method") == "initialize" and not sid:
            evicted = None
            with SESSIONS_LOCK:
                mine = [x for x in SESSIONS.values() if x.app == app]
                if len(mine) >= MAX_SESSIONS:
                    # A forgotten session must not block the app: replace the oldest one that has
                    # been quiet for EVICT_IDLE_SECONDS and runs nothing. Busy sessions are never cut.
                    now = time.time()
                    idle = [x for x in mine if now - x.last >= EVICT_IDLE_SECONDS and not x.busy()]
                    if not idle:
                        return self._json(503, {"jsonrpc": "2.0", "id": msg.get("id"), "error": {
                            "code": -32000, "message": f"{app}: {len(mine)} sessions open and in use, "
                            f"the limit is {MAX_SESSIONS}; retry when one finishes"}})
                    evicted = min(idle, key=lambda x: x.last)
                    SESSIONS.pop(evicted.id, None)
                demo = parse_qs(url.query).get("demo", ["0"])[0] in ("1", "true")
                s = Session(app, APPS[app][1] if demo else None)
                SESSIONS[s.id] = s
            if evicted:
                log(f"session {evicted.id[:8]} {app} replaced by {s.id[:8]} "
                    f"(idle {time.time() - evicted.last:.0f}s, limit {MAX_SESSIONS})")
                evicted.close()
        else:
            with SESSIONS_LOCK:
                s = SESSIONS.get(sid or "")
            if not s or s.app != app:
                return self._json(404, {"jsonrpc": "2.0", "id": msg.get("id"),
                                        "error": {"code": -32001, "message": "unknown or ended session"}})
        if not s.alive:
            return self._json(404, {"error": "session process has exited"})

        is_request = "method" in msg and "id" in msg
        if not is_request:  # notification or a response to a server request
            s.send(msg)
            return self._empty(202)

        key, q = s.register(msg)
        try:
            s.send(msg)
            headers = {"Mcp-Session-Id": s.id}
            if "text/event-stream" in self.headers.get("Accept", ""):
                self._stream(s, key, q, headers)
            else:
                self._json(200, q.get(), headers)
        except (BrokenPipeError, ConnectionResetError):
            log(f"client left before the reply to {key} ({s.app} {s.id[:8]})")
        finally:
            s.unregister(key)

    def _stream(self, s, key, q, headers):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        with s.lock:
            s.streams.add(q)
        try:
            while True:
                try:
                    m = q.get(timeout=KEEPALIVE_SECONDS)
                except queue.Empty:
                    self._chunk(b": keepalive\n\n")
                    continue
                self._chunk(b"event: message\ndata: " + json.dumps(m).encode() + b"\n\n")
                if json.dumps(m.get("id")) == key and ("result" in m or "error" in m):
                    break
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        finally:
            with s.lock:
                s.streams.discard(q)

    def _files_get(self, rel):
        p = safe_path(rel)
        if not p:
            return self._json(400, {"error": "path outside the work root"})
        if os.path.isdir(p):
            items = []
            for root, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for f in files:
                    fp = os.path.join(root, f)
                    items.append({"path": os.path.relpath(fp, WORK), "bytes": os.path.getsize(fp)})
            return self._json(200, {"files": sorted(items, key=lambda i: i["path"])})
        if not os.path.isfile(p):
            return self._json(404, {"error": "no such file"})
        size = os.path.getsize(p)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(p, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)


def no_proc_snooping():
    """Make /proc/<pid>/environ of this process unreadable for the app processes (same uid)."""
    try:
        ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 4
    except Exception as e:  # noqa: BLE001
        log("warning: could not clear the dumpable flag:", e)


def shutdown(signum, _frame):
    log(f"signal {signum}: ending {len(SESSIONS)} sessions")
    with SESSIONS_LOCK:
        open_ = list(SESSIONS.values())
        SESSIONS.clear()
    for s in open_:
        s.close()
    os._exit(0)


def main():
    global USE_CGROUP_VIEW
    STARTUP["uid"] = os.getuid()
    no_proc_snooping()
    STARTUP["droppedEnvVars"] = scrub_own_environment()
    if len(TOKEN) < 32:
        log("error: CRAFT_MCP_TOKEN (or CRAFT_MCP_TOKEN_FILE) must hold at least 32 characters;"
            " every route except /health answers 503 until it is set")
    os.makedirs(WORK, exist_ok=True)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    threading.Thread(target=reaper, daemon=True).start()
    if cgroup_fs_mounted():
        STARTUP["cgroup"] = "present"
    else:
        USE_CGROUP_VIEW = True
        ok, detail = cgroup_view_check()
        STARTUP["cgroup"] = ("own read-only view per app: " if ok else "VIEW FAILED, apps may misread memory: ") + detail
        if not ok:
            USE_CGROUP_VIEW = False
            log("warning: no cgroup filesystem and the per-app cgroup view failed:", detail)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    STARTUP["listeningAfterSeconds"] = round(time.time() - STARTED, 2)
    log(f"listening on {HOST}:{PORT}, work root {WORK}, apps {', '.join(APPS)}")

    def load_versions():  # after the bind, so a slow cold disk doesn't delay the host's probe
        global VERSIONS
        t0 = time.time()
        VERSIONS = versions()
        STARTUP["versionProbeSeconds"] = round(time.time() - t0, 2)
        log("versions", json.dumps(VERSIONS))
    threading.Thread(target=load_versions, daemon=True).start()
    srv.serve_forever()


VERSIONS = {}

if __name__ == "__main__":
    main()
