#!/usr/bin/env python3
import json
import mimetypes
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, unquote, urlparse


STORE_LOCK = Lock()


def _pick_public_root() -> Path:
    candidates = [
        Path(os.environ.get("AFUA_PUBLIC_DIR", "/public")),
        Path(__file__).resolve().parent.parent / "public",
    ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate
    return candidates[-1]


def _pick_data_root() -> Path:
    candidates = [
        Path(os.environ.get("AFUA_DATA_DIR", "/data")),
        Path(__file__).resolve().parent.parent / "data",
    ]
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            test_file = candidate / ".write-test"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink(missing_ok=True)
            return candidate
        except OSError:
            continue
    return candidates[-1]


PUBLIC_ROOT = _pick_public_root()
DATA_ROOT = _pick_data_root()
STORE_PATH = DATA_ROOT / "admin-content.json"


def _safe_page_key(raw_path: str) -> str:
    page = (raw_path or "/").strip()
    if not page.startswith("/"):
        page = "/" + page

    # Normalize equivalent homepage paths to one persistent key.
    if page in ("/", "/index", "/index.html"):
        return "/index.html"

    # Trim trailing slash for consistency (except root handled above).
    if len(page) > 1 and page.endswith("/"):
        page = page[:-1]

    return page


def _load_store() -> dict:
    if not STORE_PATH.exists():
        return {}

    try:
        with STORE_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}

    return data if isinstance(data, dict) else {}


def _save_store(data: dict) -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=True)
    tmp.replace(STORE_PATH)


def _inject_saved_snapshot(original_html: str, snapshot_html: str) -> str:
    body_open = re.search(r"<body[^>]*>", original_html, flags=re.IGNORECASE)
    if not body_open:
        return original_html

    start = body_open.end()
    lower = original_html.lower()
    first_script = lower.find("<script", start)
    body_close = lower.find("</body>", start)

    if first_script != -1:
        suffix_start = first_script
    elif body_close != -1:
        suffix_start = body_close
    else:
        return original_html

    prefix = original_html[:start]
    suffix = original_html[suffix_start:]
    return prefix + "\n" + snapshot_html + "\n" + suffix


def _sanitize_snapshot_html(snapshot_html: str) -> str:
    if not isinstance(snapshot_html, str) or not snapshot_html:
        return snapshot_html

    sanitized = snapshot_html
    # Never persist admin edit-mode attributes in stored/rendered content.
    sanitized = re.sub(r'\scontenteditable\s*=\s*"(?:true|false)"', "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r"\scontenteditable\s*=\s*'(?:true|false)'", "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r"\scontenteditable\b", "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r'\sdata-afua-editable\s*=\s*"(?:true|false)"', "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r"\sdata-afua-editable\s*=\s*'(?:true|false)'", "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r"\sdata-afua-editable\b", "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r'\sspellcheck\s*=\s*"(?:true|false)"', "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r"\sspellcheck\s*=\s*'(?:true|false)'", "", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r"\sspellcheck\b", "", sanitized, flags=re.IGNORECASE)
    return sanitized


class AppHandler(BaseHTTPRequestHandler):
    server_version = "AfuaAdminHTTP/1.0"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._json_response(200, {"ok": True})
            return
        if parsed.path == "/api/content":
            self._handle_get_content(parsed)
            return

        self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/content":
            self._handle_post_content()
            return

        self._json_response(404, {"error": "Not Found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/content":
            self._handle_delete_content(parsed)
            return

        self._json_response(404, {"error": "Not Found"})

    def _handle_get_content(self, parsed):
        query = parse_qs(parsed.query or "")
        key = _safe_page_key(query.get("path", ["/"])[0])

        with STORE_LOCK:
            content = _load_store().get(key)

        self._json_response(200, {"path": key, "content": content})

    def _handle_post_content(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length) if length > 0 else b"{}"

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json_response(400, {"error": "Invalid JSON"})
            return

        key = _safe_page_key(str(payload.get("path", "/")))
        content = payload.get("content")
        if not isinstance(content, str):
            self._json_response(400, {"error": "`content` must be a string"})
            return
        content = _sanitize_snapshot_html(content)

        with STORE_LOCK:
            data = _load_store()
            data[key] = content
            _save_store(data)

        self._json_response(200, {"ok": True, "path": key})

    def _handle_delete_content(self, parsed):
        query = parse_qs(parsed.query or "")
        key = _safe_page_key(query.get("path", ["/"])[0])

        with STORE_LOCK:
            data = _load_store()
            existed = key in data
            if existed:
                del data[key]
                _save_store(data)

        self._json_response(200, {"ok": True, "path": key, "deleted": existed})

    def _serve_static(self, raw_path):
        requested = unquote(raw_path or "/")
        if requested in ("", "/"):
            requested = "/index.html"

        clean = requested.split("?", 1)[0].split("#", 1)[0]
        rel = clean.lstrip("/")
        target = (PUBLIC_ROOT / rel).resolve()

        try:
            target.relative_to(PUBLIC_ROOT.resolve())
        except ValueError:
            self._send_text(403, "Forbidden")
            return

        if target.is_dir():
            target = target / "index.html"

        if not target.exists() or not target.is_file():
            self._send_text(404, "Not Found")
            return

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        try:
            if ctype.startswith("text/html"):
                original_html = target.read_text(encoding="utf-8")
                page_key = _safe_page_key(clean)
                with STORE_LOCK:
                    saved_snapshot = _load_store().get(page_key)
                if isinstance(saved_snapshot, str) and saved_snapshot.strip():
                    saved_snapshot = _sanitize_snapshot_html(saved_snapshot)
                    original_html = _inject_saved_snapshot(original_html, saved_snapshot)
                body = original_html.encode("utf-8")
                ctype = "text/html; charset=utf-8"
            else:
                body = target.read_bytes()
        except OSError:
            self._send_text(500, "Internal Server Error")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_response(self, status_code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status_code: int, message: str):
        body = message.encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    httpd = ThreadingHTTPServer((host, port), AppHandler)
    print(f"Serving on {host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
