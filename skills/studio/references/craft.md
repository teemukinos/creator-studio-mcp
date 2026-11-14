# Craft: headless media on a configured gateway

Craft is an optional route: PhotoCraft, VectorCraft, EffectCraft, DesignCraft and FilmCraft run on a separately provisioned Linux host. They are not installed by the `creator-studio` package and are not tools on its Mac server. Use Craft only when a gateway and credentials are already available or the user explicitly requests setup. A Compute-only job stays on that host; never fall back to a local container or Mac apps without authorization.

## Preflight in the actual assistant session

1. Select the host explicitly. Set `CRAFT_URL` to its gateway URL and `CRAFT_TOKEN_FILE` to its token file. `CRAFT_TOKEN`, if present, takes precedence; unset a stale value when using the file. Do not print credentials. These Python helpers require only the standard library and use the configured HTTP(S) proxy.
2. Run `python3 <skill folder>/scripts/craft_sync.py up` **before starting an assistant that connects to Craft**. Wait for PASS; an idle Compute host may take over a minute to wake. The gateway health route is `/health`, not the platform's `/healthz`.
3. If native MCP registration is needed, register only the apps in the plan at `<gateway>/mcp/<app>` and start a fresh assistant. `claude mcp add --transport http --scope local craft-<app> <endpoint> --header <authorization-header>` may echo headers and stores the token in plaintext. Capture/redact output and check the reported scope: inside a Git tree, local scope can resolve to the project root rather than the shell's subfolder. Preserve unrelated entries. For script-driven jobs, prefer the bundled client below; it avoids extra native sessions.
4. **Inside the fresh assistant's sandbox**, repeat `craft_sync.py up`, then `craft_sync.py mkdir <job>/assets <job>/native <job>/out` and `craft_sync.py push <local assets dir> <job>/assets` using actual inputs or a small job-owned preflight file. A parent's successful check and a connected native MCP server do not prove that shell transfers work. Require successful transfer before creating artwork.
5. On `403 user denied`, stop dependent work and obtain a session-only allowance for that exact gateway hostname through the host's permission mechanism. For Claude Code, an approved launcher can pass `--settings '{"sandbox":{"network":{"allowedDomains":["craft.example.invalid"]}}}'` with the actual hostname substituted. Keep the sandbox enabled. Do not attempt an unsandboxed retry, change proxy settings, or use another export route to bypass a denial. A tool-level `allowed_domains` hint did not establish access in the observed don't-ask session; verify with the in-session transfer check.

The helpers retain the local default `http://127.0.0.1:8080` and `~/.studio/craft/token` for existing local jobs. An explicit remote URL/token-file pair is mandatory for Compute-only work. This reference does not provision or publish a gateway.

## Files and recovery

- All remote paths stay under `/work/<job>/`. Push local inputs with `craft_sync.py push <local dir> <job>/<dir>`. Never give Craft a Mac path.
- Create every destination directory with `craft_sync.py mkdir` before saving/exporting. Do not use an editor export as a directory-creation workaround.
- Save native documents under the job: `.pcraft`, `.vectorcraft`, `.ecproj`, `.designcraft`, `.fcproj`. After **every completed stage**, pull its native document, required intermediates and review export to the local job. Do this even for Craft-to-Craft handoffs. Remote `/work` is scratch space; a successful export is not a durable backup.
- Before resuming, run `up` and `ls <job>`. If files are missing, recreate directories, push the latest recovered inputs/natives, and rerun only missing stages. Missing files establish data loss, not its infrastructure cause; label restart/suspension as an inference unless event logs confirm it.
- Use `craft_sync.py pull <job>/<dir> <local dir>`. It avoids overwrites by default. Use `--overwrite` only for deliberate replacement of generated outputs; preserve originals and earlier accepted revisions. GET listings and downloads use a unique query plus `Cache-Control: no-cache`; downloads also check byte size and retry short reads. Matching size alone is not a content check.

## Calls and sessions

Use `scripts/craft_mcp.py` from job scripts, with this skill's `scripts/` directory on `sys.path`:

```python
from craft_mcp import Session

with Session("vectorcraft", log_path="logs/craft-sessions.log") as app:
    schema = app.call("command_list", {"filter": "file.new"})
    # Use the returned schema, batch a known route, and save before leaving.
```

- The helper records full `Mcp-Session-Id` values in the job log and closes its own session on normal completion or exceptions. Keep that log private. It uses keep-alive HTTP, including through the sandbox proxy, to avoid truncated large responses.
- Only read-only `tools/list` calls and idempotent session DELETE requests are retried. Never automatically replay `initialize` or `tools/call`: the first request may already have created a session or changed a document. If initialization yields an id and then fails, the helper attempts cleanup. If no id was received, report the unknown session outcome and inspect `/status`.
- A DELETE returning 204 closes the session; 404 means it is already absent. Other failures remain failures, and the helper retains the id for explicit recovery. A failed batch is not success merely because the outer MCP response succeeded.
- Native assistant MCP connections also open sessions. CLI exit did not close five native connections in the observed run. This gateway's `/status` exposes only eight-character prefixes, while DELETE requires the full id. Short prefixes cannot be used as deletion credentials. Prefer script-owned sessions or a launcher that records full ids. Never create extra sessions to force eviction or close someone else's sessions.
- If a native session's full id cannot be recovered, report that limitation and verify its disappearance after the configured idle expiry (30 minutes on the tested host). Idle reaping is a fallback, not an explicit DELETE. Do not claim cleanup while sessions remain. A `/status` read does not refresh their activity on the tested gateway.
- Each session owns one open document. The tested gateway allows three sessions per app and may evict an idle session after two minutes when full. Save before pausing. Use `wait: true` for long exports so their sessions remain busy. Keep a baseline inventory and touch only sessions attributable to this job.

## Commands and validation

PhotoCraft, VectorCraft, EffectCraft and FilmCraft use `command_list`, `command_run`, `command_batch`. DesignCraft uses `list_commands`, `execute`, `batch`. Query schemas before first use, then batch known operations. `ui_*` and pointer/screenshot tools require a desktop bridge that the headless host does not have; use renders and exports instead.

Pull and inspect actual files. Use `file`, image dimensions (`sips` on macOS), SVG parsing, and `ffprobe` for codec, size, frame rate, counted frames, duration and audio streams. Inspect image/video samples. Native container recognition does not prove a project reopens correctly. Use H.264 for delivery on a GPU-less host; do not assume H.265 support. A render receipt's execution time is not clip duration.

List fonts per app at direction time. If no matching font is available, export type/mark PNG layers from the source app and animate/place those. This preserves appearance but makes that text raster in the downstream output; keep the editable source native document and SVG separately.

## Finish

Pull all required final files, natives, source inputs and recipes first, then check them locally. Only then run `craft_sync.py end <job>` under the job's cleanup authorization. It removes remote files **only**, not MCP sessions. Close each script session, account for native sessions as above, and verify the job is absent and all run-owned sessions are gone. A 404 when listing a deliberately removed job is expected. Do not stop a shared host or change provider settings.

When reporting a run, preserve every failure/retry and distinguish app errors from transport, permission and inference-API errors. Capture CLI structured result status as well as process exit status: exit 0 can accompany `is_error: true`. For multiple invocations, report the sum of `num_turns` explicitly as CLI turns. Report timestamp-based elapsed time separately from CLI-reported duration and render time; include approval/interruption gaps in end-to-end time. macOS does not ship GNU `timeout`; use the tool's timeout or Python `subprocess` timeouts.

## Recipes

- **2026-11-14, VectorCraft 0.24.1:** `object.setBounds` defaults to a centre reference. Use `reference: 0` when x/y mean the top-left corner. `document.export`'s SVG `objectIds` option is not boolean (the error expects a string or map); omit it unless the current schema requires a particular mode. Source Serif 4 Regular was available in the tested image; Semibold was not. Query fonts rather than assuming this is permanent.
- **2026-11-14, PhotoCraft 0.23.1:** grade an original PNG with `image.adjustments.photoFilter` (`filter: "warming85"`, `density: 22`, `preserveLuminosity: true`), then optional vignette/grain, save `.pcraft` and `doc_export` JPEG. A 1600×900 output was verified locally. Look up each filter's schema; this is a recipe, not a promise about future versions.
- **2026-11-14, DesignCraft 0.20.1:** create named swatches first: `swatch.create {"name":"Ink","color":"#2F4A2F"}`. Use `object.fill {"swatch":"Ink","ids":[<frame id>]}` and `type.char {"attrs":{"fill":"Ink"}}`, not hex in the swatch fields. After creating a text frame, select its story text with `text.select` before applying character styles. Inspect overset text and rendered frame edges; a default frame outline can remain visible. A 1080×1080 PNG layout passed file and visual checks.
- **2026-11-14, EffectCraft 0.24.1:** one 1920×1080 comp, 30 fps, duration 4 seconds, cream solid plus PNG mark/type layers; animate opacity, save `.ecproj`, then `renderQueue.add` with `format: "h264"`, `timeSpan: "comp"`, `frameRate: 30`, `audio: "off"`, followed by `renderQueue.render {"wait":true}`. Verified 120 counted frames, 4.000 seconds, no audio; render took 7.8 seconds on the tested Compute host. EffectCraft lacked Source Serif 4, so PNG type exports preserved the source typography.

## Dead ends

- **2026-11-14, Craft HTTP transport / PhotoCraft 0.23.1:** `tools/list` failed with `IncompleteRead(26339 bytes read)` through a sandbox proxy. Keep-alive `http.client` succeeded. This also affects large MCP responses, not only file pulls. Use the bundled helper; never replay a mutating call after an ambiguous response.
- **2026-11-14, Craft session cleanup / DesignCraft 0.20.1:** a command query timed out, then session DELETE failed with `ssl.SSLEOFError`. Bounded DELETE retry succeeded. Retain failed cleanup ids and verify outcomes; do not silently discard them.
- **2026-11-14, native Claude connections:** five connections remained after the process exited; `/status` supplied only short ids. The configured idle reaper eventually removed them. Future runs should avoid unmanaged native connections or capture their full ids at the launcher.
