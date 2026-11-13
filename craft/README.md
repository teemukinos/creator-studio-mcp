# Craft engines for Studio

A container image that runs the storytold Craft editors (PhotoCraft, VectorCraft, EffectCraft, DesignCraft, FilmCraft) headless and exposes each app's MCP server as an authenticated HTTP endpoint. The Studio skill uses it as its Craft toolset (`skills/studio/references/craft.md`), so Studio can run image, vector, motion, layout and video stages without a Mac.

The Craft apps are third-party software by storytold, downloaded from their GitHub releases at build time and checked against the SHA-256 sums in `image/craft.lock`. This folder doesn't include them.

## Files

| Path | What it is |
| --- | --- |
| `Dockerfile` | Debian bookworm-slim, the five Craft CLIs (pinned version and SHA-256 per architecture), ffmpeg, python3, the gateway. Runs as user `craft` (uid 10001) with `/work` as the job folder. |
| `image/craft.lock` | App, version, architecture and SHA-256 of each Linux tarball. Change versions here. |
| `image/fetch-craft.sh` | Build step: download, check SHA-256, unpack, drop the desktop binary. |
| `image/craft-health` | Health check: every `<app>-cli --version` and the gateway's `/health`. |
| `image/cgroup-view` | Gives each app its own read-only view of its memory cgroup on hosts that mount no cgroup filesystem. The gateway uses it only there. |
| `gateway/craft_mcp_gateway.py` | The HTTP MCP gateway (Python standard library only). |
| `tests/` | `host_check.py` (the whole host in one run: health, auth, environments, a large input through every app; run it after every deploy and every app update), `mcp_http_check.py` (HTTP MCP), `mcp_stdio_check.py` (stdio MCP), `auth_check.sh` (auth on every route). |

## Build and run locally

```sh
cd craft
docker build --platform linux/arm64 -t studio-craft .     # about 6 minutes cold; linux/amd64 for x86 hosts
mkdir -p ~/.studio/craft && (umask 077; openssl rand -hex 32 > ~/.studio/craft/token)
docker run -d --name studio-craft --cpus 2 --memory 4g \
  -p 127.0.0.1:8080:8080 -e CRAFT_MCP_TOKEN="$(cat ~/.studio/craft/token)" studio-craft
python3 tests/host_check.py http://127.0.0.1:8080 --token-file ~/.studio/craft/token
```

Studio finds the container through `~/.studio/craft/url` (default `http://127.0.0.1:8080`) and `~/.studio/craft/token` (mode 600). `CRAFT_URL` and `CRAFT_TOKEN_FILE` override both for one run.

## A remote host

The same image runs on any container host that gives it 2 vCPU and 4 GB. Pass the token as the `CRAFT_MCP_TOKEN` variable (or a file named by `CRAFT_MCP_TOKEN_FILE`), serve the gateway over the platform's TLS, and run `tests/host_check.py` against the service URL after every deploy. Things that differ between hosts, all handled by the gateway:

- A platform's `PORT` wins over the gateway's default 8080.
- Some platforms answer `/healthz` themselves, so the open route to check is `/health`.
- A platform that forwards a `/compute/v1/<service>` path prefix gets it stripped.
- Some platforms pass every project secret to each service. The gateway drops them before any app starts, and `/status` `secretsReadableByApps` must be `[]`. Better still, don't run it next to secrets it doesn't need.
- On a host that mounts no cgroup filesystem, each app runs through `image/cgroup-view`, which needs unprivileged user namespaces.
- A host that suspends idle services and has no persistent disk loses `/work`: pull results before a checkpoint, push inputs again on resume.

Use it for one Studio run:

```sh
export CRAFT_URL=<service URL>
export CRAFT_TOKEN_FILE=~/.studio/craft/remote-token
python3 ../skills/studio/scripts/craft_sync.py up
```

## Connect an assistant

Register the endpoints in Claude Code, once per app you use:

```sh
claude mcp add --transport http craft-filmcraft http://127.0.0.1:8080/mcp/filmcraft \
  --header "Authorization: Bearer $(cat ~/.studio/craft/token)"
```

Or pass them for one run with `--mcp-config` and `"type": "http"` entries that carry the same header.

## Gateway

| Route | Auth | What it does |
| --- | --- | --- |
| `POST /mcp/<app>` | bearer | MCP Streamable HTTP. `initialize` without a session starts a new `<app>-cli mcp` process and returns `Mcp-Session-Id`. Replies are SSE when the client accepts it, so progress notifications (FilmCraft exports) stream through. `?demo=1` opens the app's demo or sample document. |
| `DELETE /mcp/<app>` | bearer | Ends the session and its process. |
| `GET /files/<path>` | bearer | Downloads a file under `/work`, or lists a folder as JSON. |
| `PUT /files/<path>` | bearer | Uploads a file (parent folders are created). `PUT /files/<dir>/` with no body creates a folder. |
| `DELETE /files/<path>` | bearer | Deletes a file or folder under `/work`. |
| `GET /status` | bearer | CLI versions, open sessions, start-up facts, the memory the host reports, how the apps see their memory cgroup (`startup.cgroup`, `cgroupView`), the names (never values) of the variables the gateway and the apps hold, and `secretsReadableByApps` (must be `[]`). |
| `GET /health` | none | `{"ok": true, "service": "craft-mcp-gateway"}` only. `/healthz` answers the same on plain Docker. |

Settings (environment): `CRAFT_MCP_TOKEN` or `CRAFT_MCP_TOKEN_FILE` (required, 32+ characters; without it every route but `/health` and `/healthz` answers 503), `PORT` or `CRAFT_MCP_PORT` (8080; a platform's `PORT` wins), `CRAFT_WORK_ROOT` (`/work`), `CRAFT_MAX_SESSIONS` per app (3), `CRAFT_IDLE_SECONDS` (1800), `CRAFT_EVICT_IDLE_SECONDS` (120: when an app is at its session limit, a new session replaces the oldest one that has been quiet this long and has no request in flight), `CRAFT_MAX_UPLOAD_BYTES` (4 GiB), `CRAFT_ALLOWED_ORIGINS` (browser origins; none by default).

Security notes:

- One session is one app process. PhotoCraft, VectorCraft, EffectCraft and DesignCraft run with `--automation-read-root /work --automation-write-root /work`. FilmCraft has no such flags; it can read whatever the `craft` user can read, and write only to `/work`, `/tmp` and its home.
- The gateway is PID 1 on purpose and marks itself non-dumpable, so the app processes (same user) can't read the token from `/proc/1/environ`. App processes get an allowlisted environment only (PATH, HOME, locale, TZ, XDG folders). Don't add an init wrapper such as tini: it would hold the token in a readable environment.
- On start the gateway also drops every non-allowlisted variable from its own environment (secrets a host injects included). `/status` `secretsReadableByApps` proves on the running host that no app can read them.
- `/files` paths are resolved and must stay inside `/work`; `..` and encoded traversal return 400.
- The gateway speaks plain HTTP. On a public host, put it behind the platform's TLS.
- On hosts with no cgroup filesystem, each app runs through `image/cgroup-view`: `unshare` gives the app its own user, mount and cgroup namespaces, the script mounts cgroup2 read-only at `/sys/fs/cgroup`, drops every capability and runs the app as the same `craft` user, so the app reads its real memory limit. Nothing in the app is patched. A host that allows neither a cgroup filesystem nor unprivileged user namespaces shows `VIEW FAILED` in `/status` and fails `host_check.py`.

## Updating an app

1. Read the new release's `SHA256SUMS.txt` and put both architectures' lines in `image/craft.lock`.
2. Rebuild, then run `tests/host_check.py` against each host you use.
3. Add any changed route to `skills/studio/references/craft.md` as a dated recipe or dead end.
