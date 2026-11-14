#!/usr/bin/env python3
"""Studio <-> Craft engine container: health check and file sync, one call each.

  craft_sync.py up                         health + CLI versions + open sessions
  craft_sync.py push <local dir> <job>/<sub>   upload every file under <local dir> to /work/<job>/<sub>/
  craft_sync.py pull <job>/<sub> <local dir>   download /work/<job>/<sub>/ into <local dir> (no overwrite
                                           unless --overwrite)
  craft_sync.py mkdir <job>/<sub>...       create folders on the container (the apps don't create them)
  craft_sync.py ls <job>[/<sub>]           list remote files
  craft_sync.py end <job>                  delete /work/<job> on the container (after pull)

Where the container is: CRAFT_URL, else ~/.studio/craft/url, else http://127.0.0.1:8080.
Token: CRAFT_TOKEN, else the file CRAFT_TOKEN_FILE, else ~/.studio/craft/token.
Prints at most 20 lines: PASS/FAIL, counts, bytes.
"""
import base64
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

HOME_CFG = os.path.expanduser("~/.studio/craft")


def cfg():
    url = os.environ.get("CRAFT_URL")
    if not url and os.path.exists(f"{HOME_CFG}/url"):
        url = open(f"{HOME_CFG}/url").read().strip()
    tok = os.environ.get("CRAFT_TOKEN")
    if not tok:
        path = os.environ.get("CRAFT_TOKEN_FILE", f"{HOME_CFG}/token")
        tok = open(path).read().strip() if os.path.exists(path) else ""
    return (url or "http://127.0.0.1:8080").rstrip("/"), tok


URL, TOKEN = cfg()


def req(method, path, data=None, raw=False, timeout=600):
    if method == "GET":
        path = fresh_path(path)
    r = urllib.request.Request(URL + path, data=data, method=method,
                               headers={"Authorization": f"Bearer {TOKEN}",
                                        "Cache-Control": "no-cache"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        body = resp.read()
    return body if raw else (json.loads(body) if body else None)


def fresh_path(path):
    """Avoid a cached listing or artifact, including after a same-size overwrite."""
    u = urllib.parse.urlsplit(path)
    query = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
    query.append(("_studio_download", uuid.uuid4().hex))
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path,
                                    urllib.parse.urlencode(query), ""))


def _connect(u, timeout=600):
    """An http.client connection to the URL's host, through the environment's proxy if any."""
    proxy = None if urllib.request.proxy_bypass(u.hostname) else urllib.request.getproxies().get(u.scheme)
    https = u.scheme == "https"
    target = urllib.parse.urlunsplit(("", "", u.path or "/", u.query, ""))
    if not proxy:
        cls = http.client.HTTPSConnection if https else http.client.HTTPConnection
        return cls(u.hostname, u.port, timeout=timeout), target, {}
    p = urllib.parse.urlsplit(proxy)
    auth = {}
    if p.username:
        cred = f"{urllib.parse.unquote(p.username)}:{urllib.parse.unquote(p.password or '')}"
        auth["Proxy-Authorization"] = "Basic " + base64.b64encode(cred.encode()).decode()
    if https:  # CONNECT tunnel through a plain-HTTP proxy, then TLS to the host
        conn = http.client.HTTPSConnection(p.hostname, p.port, timeout=timeout)
        conn.set_tunnel(u.hostname, u.port or 443, headers=auth)
        return conn, target, {}
    return http.client.HTTPConnection(p.hostname, p.port, timeout=timeout), urllib.parse.urlunsplit(u), auth


def download(path, expected, tries=3):
    """GET one file on a keep-alive connection, check its size, retry a short read.

    urllib always sends "Connection: close". Behind some HTTPS proxies (Claude Code's sandbox
    is one) that loses the end of a large response, so downloads use http.client directly.
    """
    last = "no attempt"
    for _ in range(tries):
        u = urllib.parse.urlsplit(URL + fresh_path(path))
        conn, target, extra = _connect(u)
        try:
            conn.request("GET", target, headers={"Authorization": f"Bearer {TOKEN}",
                                                 "Connection": "keep-alive",
                                                 "Cache-Control": "no-cache", **extra})
            resp = conn.getresponse()
            if resp.status != 200:
                raise urllib.error.HTTPError(URL + path, resp.status, resp.reason, resp.headers, None)
            chunks = []
            while True:
                b = resp.read(1 << 20)
                if not b:
                    break
                chunks.append(b)
            data = b"".join(chunks)
            if len(data) == expected:
                return data
            last = f"short read, {len(data)} of {expected} bytes"
        except (http.client.HTTPException, ConnectionError, TimeoutError) as e:
            last = f"{type(e).__name__}: {e}"
        finally:
            conn.close()
    raise urllib.error.URLError(f"download {path} failed {tries} times: {last}")


def q(p):
    return urllib.parse.quote(p.strip("/"))


def up():
    # /health (open) proves the gateway itself answers; on Supabase Compute the platform takes
    # /healthz, so never use that one. A suspended public service can take a minute to wake.
    try:
        health = json.loads(urllib.request.urlopen(URL + "/health", timeout=120).read())
        if health.get("service") != "craft-mcp-gateway":
            raise ValueError(f"not the Craft gateway: {health}")
        st = req("GET", "/status", timeout=60)
    except urllib.error.HTTPError as e:
        print(f"FAIL {URL}: HTTP {e.code}" + (" (token?)" if e.code == 401 else ""))
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"FAIL {URL}: {e}")
        return 1
    print(f"PASS {URL} sessions={len(st['sessions'])}")
    for app, v in st["versions"].items():
        print(f"  {app}: {v}")
    return 0


def push(local, remote):
    n = total = 0
    for root, dirs, files in os.walk(local):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.startswith("."):
                continue
            src = os.path.join(root, f)
            rel = os.path.relpath(src, local)
            data = open(src, "rb").read()
            req("PUT", f"/files/{q(remote)}/{q(rel)}", data)
            n += 1
            total += len(data)
    print(f"PASS push {n} files, {total} bytes: {local} -> /work/{remote.strip('/')}/")
    return 0


def pull(remote, local, overwrite=False):
    listing = req("GET", f"/files/{q(remote)}/")["files"]
    prefix = remote.strip("/") + "/"
    n = total = skipped = 0
    for item in listing:
        rel = item["path"][len(prefix):] if item["path"].startswith(prefix) else item["path"]
        dst = os.path.join(local, rel)
        if os.path.exists(dst) and not overwrite:
            skipped += 1
            continue
        os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
        data = download(f"/files/{q(item['path'])}", item["bytes"])
        with open(dst + ".part", "wb") as fh:
            fh.write(data)
        os.replace(dst + ".part", dst)
        n += 1
        total += len(data)
    status = "PASS" if n or not listing else "FAIL"
    print(f"{status} pull {n} files, {total} bytes, {skipped} skipped (exist): /work/{prefix} -> {local}")
    return 0 if status == "PASS" else 1


def mkdir(dirs):
    for d in dirs:
        req("PUT", f"/files/{q(d)}/", b"")
    print(f"PASS mkdir {len(dirs)}: " + ", ".join(f"/work/{d.strip('/')}/" for d in dirs))
    return 0


def ls(remote):
    files = req("GET", f"/files/{q(remote)}/")["files"]
    for item in files[:18]:
        print(f"  {item['bytes']:>12}  {item['path']}")
    print(f"PASS {len(files)} files" + (" (first 18 shown)" if len(files) > 18 else ""))
    return 0


def end(job):
    if "/" in job.strip("/") or not job.strip("/"):
        print("FAIL end takes a job name, not a path")
        return 1
    req("DELETE", f"/files/{q(job)}")
    print(f"PASS removed /work/{job.strip('/')} on the container; MCP sessions are separate")
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    try:
        if cmd == "up":
            return up()
        if cmd == "push" and len(args) == 2:
            return push(*args)
        if cmd == "pull" and len(args) in (2, 3):
            return pull(args[0], args[1], "--overwrite" in args)
        if cmd == "mkdir" and args:
            return mkdir(args)
        if cmd == "ls" and len(args) == 1:
            return ls(args[0])
        if cmd == "end" and len(args) == 1:
            return end(args[0])
    except urllib.error.HTTPError as e:
        print(f"FAIL {cmd}: HTTP {e.code}")
        return 1
    except urllib.error.URLError as e:
        print(f"FAIL {cmd}: {e.reason} ({URL})")
        return 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
