#!/usr/bin/env python3
"""Craft MCP client for job scripts; uses craft_sync.py's host, token and proxy settings.

Usage from a job script (put this skill's scripts/ directory on sys.path):
    with Session("vectorcraft", log_path="logs/craft-sessions.log") as app:
        commands = app.call("command_list", {"filter": "file.new"})

The log records full session ids, never the bearer token. Keep it with the job.
Only tools/list and session DELETE are retried. Initialize and tools/call are
never replayed automatically: their first attempt may already have changed state.
Running this file directly prints help; it makes no network requests.
"""
import http.client
import json
import os
import ssl
import sys
import time
import urllib.parse

import craft_sync

APPS = {"photocraft", "vectorcraft", "effectcraft", "designcraft", "filmcraft"}
TRANSPORT_ERRORS = (http.client.HTTPException, ConnectionError, TimeoutError, ssl.SSLError)


def _log(path, message):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        stream.write(time.strftime("%Y-%m-%d %H:%M:%S %z ") + message + "\n")


class Session:
    """One app process. Use a context manager to save and close it reliably."""

    def __init__(self, app, *, log_path, timeout=900):
        if app not in APPS:
            raise ValueError("Unknown Craft app")
        if not craft_sync.TOKEN:
            raise ValueError("Set CRAFT_TOKEN_FILE or CRAFT_TOKEN before connecting")
        self.app, self.log_path, self.timeout = app, os.fspath(log_path), timeout
        self.sid, self.counter = None, 0
        self.url = craft_sync.URL + "/mcp/" + app
        # Ensure session ids can be recorded before starting a remote process.
        _log(self.log_path, "CONNECT " + app)
        try:
            result = self._rpc("initialize", {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "studio-job-script", "version": "1"},
            })
            self.server = result.get("serverInfo")
            if not self.sid:
                raise RuntimeError("Craft gateway omitted Mcp-Session-Id")
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except BaseException:
            if self.sid:
                try:
                    self.close()
                except Exception:
                    print("FAIL Craft initialization cleanup; see session log", file=sys.stderr)
            else:
                _log(self.log_path, "UNKNOWN " + app + " initialize failed before a session id was received; inspect status")
            raise

    def _headers(self):
        headers = {
            "Authorization": "Bearer " + craft_sync.TOKEN,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
            "Connection": "keep-alive",
        }
        if self.sid:
            headers["Mcp-Session-Id"] = self.sid
        return headers

    def _post(self, message):
        method = message["method"]
        attempts = 3 if method == "tools/list" else 1
        for attempt in range(attempts):
            conn, target, extra = craft_sync._connect(urllib.parse.urlsplit(self.url), self.timeout)
            try:
                conn.request("POST", target, body=json.dumps(message).encode(),
                             headers={**self._headers(), **extra})
                response = conn.getresponse()
                sid = response.getheader("Mcp-Session-Id")
                if sid and self.sid is None:
                    # Capture before reading the body: a short initialize response
                    # must still leave enough information to close its process.
                    self.sid = sid
                    _log(self.log_path, "OPEN " + self.app + " " + sid)
                if response.status >= 400:
                    raise RuntimeError("Craft HTTP " + str(response.status))
                content_type = response.getheader("Content-Type", "")
                body = response.read().decode("utf-8")
            except TRANSPORT_ERRORS as error:
                _log(self.log_path, "ERROR " + self.app + " " + method + " " + type(error).__name__)
                if attempt + 1 == attempts:
                    raise
                time.sleep(attempt + 1)
                continue
            finally:
                conn.close()
            if not body.strip():
                return None
            if "text/event-stream" in content_type:
                for block in body.replace("\r\n", "\n").split("\n\n"):
                    data = "\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:"))
                    if data:
                        event = json.loads(data)
                        if "id" in event and event["id"] == message.get("id"):
                            return event
                raise RuntimeError("Craft stream ended without the requested response")
            return json.loads(body)

    def _rpc(self, method, params):
        self.counter += 1
        response = self._post({"jsonrpc": "2.0", "id": self.counter,
                               "method": method, "params": params})
        if response is None or "error" in response or "result" not in response:
            raise RuntimeError("Craft RPC failed: " + method)
        return response["result"]

    def tools(self):
        return self._rpc("tools/list", {})["tools"]

    def call(self, name, args=None, check=True):
        result = self._rpc("tools/call", {"name": name, "arguments": args or {}})
        text = "\n".join(item.get("text", "") for item in result.get("content", []) if item.get("type") == "text")
        try:
            value = json.loads(text) if text else None
        except ValueError:
            value = text
        failed = result.get("isError") or (isinstance(value, dict) and value.get("failed"))
        if check and failed:
            detail = text.replace(craft_sync.TOKEN, "[REDACTED]")
            raise RuntimeError(name + " failed: " + detail[:1500])
        images = [item for item in result.get("content", []) if item.get("type") == "image"]
        if images or failed:
            return {"value": value, "images": images, "isError": bool(failed)}
        return value

    def close(self):
        if self.sid is None:
            return
        # DELETE is idempotent. A lost 204 followed by 404 means already closed.
        for attempt in range(3):
            conn, target, extra = craft_sync._connect(urllib.parse.urlsplit(self.url), 60)
            try:
                conn.request("DELETE", target, headers={**self._headers(), **extra})
                response = conn.getresponse()
                code = response.status
                response.read()
                _log(self.log_path, "DELETE " + self.app + " " + self.sid + " -> " + str(code))
                if code not in (204, 404):
                    raise RuntimeError("Craft session close returned HTTP " + str(code))
                self.sid = None
                return
            except TRANSPORT_ERRORS as error:
                _log(self.log_path, "DELETE-ERROR " + self.app + " " + self.sid + " " + type(error).__name__)
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
            finally:
                conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()


if __name__ == "__main__":
    print(__doc__)
