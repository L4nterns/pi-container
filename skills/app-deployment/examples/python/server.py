"""Small foreground HTTP example; production apps supply their own entrypoint."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
from pathlib import Path

if os.getuid() == 0:
    raise RuntimeError('Application must not run as root')
state = Path(os.environ['APP_DATA_DIR']) / 'starts'
state.write_text(str(int(state.read_text()) + 1 if state.exists() else 1))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'Hello from Python\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer((os.environ['HOST'], int(os.environ['PORT'])), Handler).serve_forever()
