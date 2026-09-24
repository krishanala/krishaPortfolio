#!/usr/bin/env python3
"""Local preview server for the portfolio site.

Usage:
    python3 serve.py          # serves on http://localhost:8000
    python3 serve.py 3000     # or pick another port

Caching is disabled, so a normal browser refresh always shows your latest edits.
Press Ctrl+C to stop.
"""
import http.server
import os
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8000)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler)
    except OSError:
        sys.exit(f"Port {PORT} is already in use. Try: python3 serve.py {PORT + 1}")

    url = f"http://localhost:{PORT}"
    print(f"Serving {ROOT}\nPreview at {url}  (Ctrl+C to stop)")
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
