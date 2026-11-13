"""Non-Node smoke application for HTTP forwarding, SSE and WebSocket upgrade."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import time

if os.getuid() == 0:
    raise RuntimeError('Application must not run as root')
state = Path(os.environ['APP_DATA_DIR']) / 'starts'
state.write_text(str(int(state.read_text()) + 1 if state.exists() else 1))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):
        if self.path == '/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(b'data: first\n\n')
            self.wfile.flush()
            # Long enough to detect a gateway that buffers until response EOF.
            time.sleep(1.5)
            self.wfile.write(b'data: second\n\n')
            self.wfile.flush()
            self.close_connection = True
            return
        if self.path == '/ws':
            key = self.headers['Sec-WebSocket-Key']
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            self.wfile.write(b'\x81\x02ok')
            self.wfile.flush()
            self.close_connection = True
            return
        body = json.dumps(dict(self.headers)).encode() if self.path == '/headers' else b'Hello from Python\n'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if self.path == '/headers' else 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer((os.environ['HOST'], int(os.environ['PORT'])), Handler).serve_forever()
