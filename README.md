# LocalFileReader

A small, **read-only** web app for browsing and reading text files on this machine
from any browser on your LAN or tailnet.

- Pick any directory; the left panel shows its file tree (lazy-loaded, with optional hidden files).
- The right panel renders Markdown and HTML, shows images/PDFs, renders CSV/TSV as tables,
  and shows everything else as syntax-highlighted code (~230 languages via highlight.js).
- Every file and folder name under the open directory is indexed, so you can search the whole tree
  (press `/` or Ctrl+K). Searches match names and paths, with fuzzy matching on names.
- The panels are resizable (drag the divider; double-click resets). On phones the tree becomes a drawer.
- It cannot modify files: the server has no write paths, and every non-GET request except the login form is rejected.

## Running

Requires only Python 3.8+ (standard library, no installs). The frontend libraries are vendored
in `static/vendor/`, so no internet connection is needed.

```sh
./server.py                          # all interfaces, port 8765
./server.py --password 'something'   # require a password (recommended off localhost)
./server.py --root ~/notes           # never allow browsing outside ~/notes
./server.py --host 100.93.35.28      # bind only to the Tailscale interface
```

| Flag | Env var | Default | |
|---|---|---|---|
| `--host` | `LFR_HOST` | `0.0.0.0` | Address to bind |
| `--port` | `LFR_PORT` | `8765` | |
| `--root` | `LFR_ROOT` | `/` | Restrict browsing to this directory (symlinks can't escape it) |
| `--password` | `LFR_PASSWORD` | none | Require a password; the session lasts 30 days |
| `--max-mb` | `LFR_MAX_MB` | `10` | Larger text files are truncated for display |

The app runs as your user, so it can read whatever you can read. **Without `--password`, anyone
who can reach the port can read your files.** Tailscale limits that to your tailnet, but on a
shared LAN, set a password or bind to the Tailscale IP only.

### Run on boot (systemd user service)

```ini
# ~/.config/systemd/user/localfilereader.service
[Unit]
Description=LocalFileReader

[Service]
ExecStart=/usr/bin/python3 %h/Code/Web/LocalFileReader/server.py
Environment=LFR_PASSWORD=change-me
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now localfilereader
loginctl enable-linger $USER   # keep it running when you're logged out
```

## Notes

- The URL tracks the current directory and file (`?root=…&file=…`), so you can bookmark or share
  views, and back/forward works.
- Markdown is sanitised with DOMPurify. Relative links to other files open in the viewer, and relative images load.
- HTML files render in a sandboxed iframe that has no access to the app. Scripts are off by default;
  turn them on in Settings.
- Settings (hidden files, wrap, line numbers, theme, font size, auto-refresh) are saved per browser.
