#!/usr/bin/env python3
"""LocalFileReader: a read-only web viewer for local text files.

Standard library only. The server exposes GET endpoints for listing directories
and reading files; there is deliberately no code path that writes, renames or
deletes anything on disk.
"""

import argparse
import gzip
import hashlib
import hmac
import html
import json
import mimetypes
import os
import socket
import stat
import sys
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg"}
PDF_EXTS = {".pdf"}
SNIFF_BYTES = 8192

# Filename indexing (for search) stops after this many entries or seconds.
INDEX_MAX_ENTRIES = 300_000
INDEX_MAX_SECONDS = 30
# Virtual filesystems that are huge or never useful to index when the root is "/".
INDEX_SKIP = {"/proc", "/sys", "/dev", "/run"}

# Types that can run script when opened directly; served with a CSP sandbox so
# they never execute with this app's origin.
ACTIVE_TYPES = {"text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"}

mimetypes.add_type("text/markdown", ".md")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")


class Config:
    root = "/"
    max_bytes = 10 * 1024 * 1024
    password = None
    session_token = None
    raw_key = "_"


def derive(secret, purpose):
    return hmac.new(secret.encode(), purpose.encode(), hashlib.sha256).hexdigest()


def resolve(path):
    """Normalise a client-supplied path and enforce the configured root.

    Returns the absolute (non-symlink-resolved) path for display, or raises
    PermissionError if it escapes the root.
    """
    if not path:
        path = Config.root
    path = os.path.abspath(os.path.expanduser(path))
    if Config.root != "/":
        real = os.path.realpath(path)
        if real != Config.root and not real.startswith(Config.root + os.sep):
            raise PermissionError("outside of the allowed root")
    return path


def entry_info(entry):
    name = entry.name
    info = {"name": name, "hidden": name.startswith("."), "link": entry.is_symlink()}
    try:
        st = entry.stat()  # follows symlinks
        info["type"] = "dir" if stat.S_ISDIR(st.st_mode) else "file"
        info["size"] = st.st_size
        info["mtime"] = st.st_mtime
    except OSError:
        info["type"] = "broken"
    return info


def sort_key(e):
    return (e["type"] != "dir", e["name"].lower(), e["name"])


def decode_text(data, truncated):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace"), "utf-16"
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    for trim in range(4 if truncated else 1):
        try:
            return data[: len(data) - trim].decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            continue
    try:
        return data.decode("cp1252"), "cp1252"
    except UnicodeDecodeError:
        return data.decode("latin-1"), "latin-1"


def looks_binary(chunk):
    if chunk.startswith((b"\xff\xfe", b"\xfe\xff")):
        return False
    return b"\x00" in chunk


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalFileReader/1.0"
    protocol_version = "HTTP/1.1"

    # ----- plumbing -----------------------------------------------------

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_common_headers(self):
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")

    def send_bytes(self, body, ctype, status=HTTPStatus.OK, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_common_headers()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, separators=(",", ":")).encode()
        headers = None
        if len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, compresslevel=5)
            headers = {"Content-Encoding": "gzip", "Vary": "Accept-Encoding"}
        self.send_bytes(body, "application/json; charset=utf-8", status, headers)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def is_authed(self):
        if not Config.password:
            return True
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("lfr_session")
        return bool(morsel) and hmac.compare_digest(morsel.value, Config.session_token)

    # ----- routing ------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/raw/"):
                return self.handle_raw(path)
            if path == "/login":
                return self.send_login_page()
            if not self.is_authed():
                if path.startswith("/api/"):
                    return self.send_error_json(HTTPStatus.UNAUTHORIZED, "login required")
                return self.redirect("/login")
            if path == "/api/config":
                return self.handle_config()
            if path == "/api/list":
                return self.handle_list(query)
            if path == "/api/file":
                return self.handle_file(query)
            if path == "/api/index":
                return self.handle_index(query)
            if path == "/api/stat":
                return self.handle_stat(query)
            if path.startswith("/static/"):
                return self.handle_static(path[len("/static/"):])
            if path == "/":
                return self.handle_static("index.html")
            self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        except PermissionError as e:
            self.send_error_json(HTTPStatus.FORBIDDEN, str(e) or "permission denied")
        except FileNotFoundError:
            self.send_error_json(HTTPStatus.NOT_FOUND, "no such file or directory")
        except NotADirectoryError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "not a directory")
        except IsADirectoryError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "is a directory")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as e:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, e.strerror or str(e))

    def do_POST(self):
        # The only POST is the login form; nothing on disk is ever modified.
        if urlsplit(self.path).path != "/login" or not Config.password:
            return self.send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, "read-only")
        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        form = parse_qs(self.rfile.read(length).decode(errors="replace"))
        supplied = (form.get("password") or [""])[0]
        if hmac.compare_digest(supplied.encode(), Config.password.encode()):
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                f"lfr_session={Config.session_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
            )
            self.send_header("Content-Length", "0")
            self.send_common_headers()
            self.end_headers()
        else:
            time.sleep(1)
            self.send_login_page(error="Incorrect password")

    def redirect(self, location):
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----- handlers -----------------------------------------------------

    def send_login_page(self, error=None):
        if not Config.password or self.is_authed():
            return self.redirect("/")
        msg = f'<p class="err">{html.escape(error)}</p>' if error else ""
        page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>File Reader · Login</title>
<style>
body{{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1f2328}}
@media (prefers-color-scheme:dark){{body{{background:#0d1117;color:#e6edf3}}input{{background:#161b22;color:inherit;border-color:#30363d}}}}
form{{display:flex;flex-direction:column;gap:10px;width:min(300px,90vw)}}
input,button{{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #d0d7de}}
button{{background:#2563eb;color:#fff;border:0;cursor:pointer}}.err{{color:#d1242f;margin:0}}
</style></head><body><form method="post" action="/login">
<h2 style="margin:0 0 4px">File Reader</h2>{msg}
<input type="password" name="password" placeholder="Password" autofocus required>
<button type="submit">Sign in</button></form></body></html>"""
        status = HTTPStatus.UNAUTHORIZED if error else HTTPStatus.OK
        self.send_bytes(page.encode(), "text/html; charset=utf-8", status)

    def handle_config(self):
        self.send_json({
            "home": os.path.expanduser("~"),
            "root": Config.root,
            "hostname": socket.gethostname(),
            "rawKey": Config.raw_key,
            "maxBytes": Config.max_bytes,
            "sep": os.sep,
        })

    def handle_list(self, query):
        path = resolve(query.get("path"))
        show_hidden = query.get("hidden") == "1"
        entries = []
        with os.scandir(path) as it:
            for entry in it:
                if not show_hidden and entry.name.startswith("."):
                    continue
                entries.append(entry_info(entry))
        entries.sort(key=sort_key)
        parent = os.path.dirname(path)
        if parent == path:
            parent = None
        else:
            try:
                resolve(parent)
            except PermissionError:
                parent = None
        self.send_json({"path": path, "parent": parent, "entries": entries})

    def handle_index(self, query):
        """Recursively list every file and directory name under a directory.

        Paths are returned relative to the directory. Symlinked directories are
        listed but not descended into, which also rules out cycles.
        """
        root = resolve(query.get("path"))
        if not os.path.isdir(root):
            raise NotADirectoryError(root)
        show_hidden = query.get("hidden") == "1"
        files, dirs = [], []
        truncated = False
        started = time.monotonic()
        stack = [""]
        while stack and not truncated:
            rel = stack.pop()
            full = os.path.join(root, rel) if rel else root
            if full in INDEX_SKIP:
                continue
            try:
                it = os.scandir(full)
            except OSError:
                continue
            with it:
                for entry in it:
                    if not show_hidden and entry.name.startswith("."):
                        continue
                    child = f"{rel}/{entry.name}" if rel else entry.name
                    try:
                        is_dir = entry.is_dir()
                        descend = is_dir and not entry.is_symlink()
                    except OSError:
                        is_dir = descend = False
                    if is_dir:
                        dirs.append(child)
                        if descend:
                            stack.append(child)
                    else:
                        files.append(child)
                if (len(files) + len(dirs) >= INDEX_MAX_ENTRIES
                        or time.monotonic() - started > INDEX_MAX_SECONDS):
                    truncated = True
        self.send_json({
            "path": root,
            "files": files,
            "dirs": dirs,
            "truncated": truncated,
            "elapsed": round(time.monotonic() - started, 3),
        })

    def handle_stat(self, query):
        path = resolve(query.get("path"))
        st = os.stat(path)
        self.send_json({"path": path, "size": st.st_size, "mtime": st.st_mtime})

    def handle_file(self, query):
        path = resolve(query.get("path"))
        st = os.stat(path)
        if stat.S_ISDIR(st.st_mode):
            raise IsADirectoryError(path)
        ext = os.path.splitext(path)[1].lower()
        result = {
            "path": path,
            "name": os.path.basename(path),
            "size": st.st_size,
            "mtime": st.st_mtime,
        }
        if ext in PDF_EXTS:
            result["kind"] = "pdf"
            return self.send_json(result)
        if ext in IMAGE_EXTS and ext != ".svg":
            result["kind"] = "image"
            return self.send_json(result)
        if not stat.S_ISREG(st.st_mode):
            result["kind"] = "special"
            return self.send_json(result)

        with open(path, "rb") as f:
            data = f.read(Config.max_bytes + 1)
        truncated = len(data) > Config.max_bytes
        data = data[: Config.max_bytes]
        if looks_binary(data[:SNIFF_BYTES]):
            result["kind"] = "binary"
            result["mime"] = mimetypes.guess_type(path)[0]
            return self.send_json(result)
        text, encoding = decode_text(data, truncated)
        result.update(kind="image" if ext == ".svg" else "text", content=text,
                      encoding=encoding, truncated=truncated)
        self.send_json(result)

    def handle_raw(self, path):
        # /raw/<key>/<absolute path>. The key travels in the path so that
        # sandboxed (opaque-origin) iframes can load relative subresources
        # without needing cookies.
        rest = path[len("/raw/"):]
        key, _, fpath = rest.partition("/")
        if Config.password and not hmac.compare_digest(key, Config.raw_key):
            return self.send_error_json(HTTPStatus.UNAUTHORIZED, "bad key")
        fpath = resolve("/" + unquote(fpath))
        st = os.stat(fpath)
        if stat.S_ISDIR(st.st_mode):
            index = os.path.join(fpath, "index.html")
            if os.path.isfile(index):
                return self.redirect(f"/raw/{key}{quote(index)}")
            raise IsADirectoryError(fpath)
        if not stat.S_ISREG(st.st_mode):
            raise PermissionError("not a regular file")
        ctype = mimetypes.guess_type(fpath)[0] or "application/octet-stream"
        headers = {}
        if ctype in ACTIVE_TYPES:
            headers["Content-Security-Policy"] = (
                "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox"
            )
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_file(fpath, st.st_size, ctype, headers)

    def handle_static(self, rel):
        full = os.path.realpath(os.path.join(STATIC_DIR, unquote(rel)))
        if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        self.send_file(full, os.path.getsize(full), ctype)

    def send_file(self, fpath, size, ctype, headers=None):
        with open(fpath, "rb") as f:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-cache")
            self.send_common_headers()
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command == "HEAD":
                return
            while chunk := f.read(256 * 1024):
                self.wfile.write(chunk)


def local_addresses(port):
    addrs = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.append(info[4][0])
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            addrs.append(s.getsockname()[0])
    except OSError:
        pass
    seen = []
    for a in addrs:
        if a not in seen and not a.startswith("127."):
            seen.append(a)
    return [f"http://{a}:{port}/" for a in seen]


def main():
    p = argparse.ArgumentParser(description="Read-only web viewer for local text files.")
    p.add_argument("--host", default=os.environ.get("LFR_HOST", "0.0.0.0"),
                   help="address to bind (default 0.0.0.0, all interfaces)")
    p.add_argument("--port", type=int, default=int(os.environ.get("LFR_PORT", 8765)))
    p.add_argument("--root", default=os.environ.get("LFR_ROOT", "/"),
                   help="only allow browsing inside this directory (default: /)")
    p.add_argument("--max-mb", type=float, default=float(os.environ.get("LFR_MAX_MB", 10)),
                   help="maximum bytes of a text file to send, in MB (default 10)")
    p.add_argument("--password", default=os.environ.get("LFR_PASSWORD"),
                   help="require this password (or set LFR_PASSWORD)")
    args = p.parse_args()

    Config.root = os.path.realpath(os.path.expanduser(args.root))
    Config.max_bytes = int(args.max_mb * 1024 * 1024)
    if args.password:
        Config.password = args.password
        Config.session_token = derive(args.password, "lfr-session")
        Config.raw_key = derive(args.password, "lfr-raw")[:32]

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"LocalFileReader serving (read-only) on http://{args.host}:{args.port}/")
    if args.host in ("0.0.0.0", "::"):
        for url in local_addresses(args.port):
            print(f"  {url}")
    if Config.root != "/":
        print(f"  restricted to {Config.root}")
    if not Config.password and args.host not in ("127.0.0.1", "localhost", "::1"):
        print("  WARNING: no password set; anyone who can reach this port can read your files.\n"
              "           Use --password or LFR_PASSWORD, or bind to a specific interface with --host.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
